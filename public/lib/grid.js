/* herdr-dash — grid.js · multi-pane grid of mini transcripts (owner: W3)
 *
 * CONTRACT-v2 §3 module + §4.9:
 *   2/3/4/6 panes as a responsive grid of independently streaming mini transcripts
 *   (1500 ms poll, appended lines only, `--- screen cleared ---` on reset), a per-cell
 *   header (pane id, agent, status dot, title), per-cell expand -> ctx.ui.selectPane +
 *   close, Esc closes, and cells that scroll out of view stop polling.
 *
 * This is the only module allowed to poll panes other than the selected one, so the
 * polling is deliberately conservative: one 1500 ms tick, at most one request in flight
 * per cell, nothing at all while the overlay is closed or a cell is off-screen, and the
 * merge is skipped when the pane's `revision` did not move.
 *
 * `advanceBuffer` below is the §0.1/§0.2 fallback copy (the browser cannot require
 * src/hdr.js, which §4.4 also notes for app.js). mount() prefers, in order:
 * ctx.util.advanceBuffer (app.js), window.HD.advanceBuffer (lib/advance-buffer.js itself),
 * and only then this copy — which `_scratch/w3/logic.mjs` holds to byte-identical output
 * against the shared one so it cannot drift (§0.2 R4).
 */
(function () {
  'use strict';

  var HD = (window.HD = window.HD || {});
  var ID = 'grid';
  var TITLE = 'Pane grid';
  var POLL_MS = 1500;
  var WINDOW_LINES = 1200;     // §0.1: poll window (was 400)
  var MAX_LINES = 2000;        // per-cell DOM cap (v1 §6.2)
  var MAX_CELLS = 6;
  var SEPARATOR = '--- screen cleared ---';
  var AB_RECENT = 4096;        // how far back the "have I shown this row?" scan looks
  var AB_NEAR = 64;            // how far back the repaint scan looks
  var AB_MIN_OVERLAP = 50;     // rule 1r only applies to overlaps at least this long
  var AB_ANCHOR = 8;           // §0.1: anchor = next.slice(0, min(8, next.length))
  var AB_MIN_BLOCK = 32;       // the "almost entirely already shown" guard only judges blocks this big
  var AB_MIN_NOVEL = 0.25;
  var STATUSES = ['blocked', 'done', 'working', 'idle', 'unknown'];

  // ── §0.1 advanceBuffer (frozen algorithm) ─────────────────────────────────

  function arraysEqualAt(a, b, startA, startB, len) {
    for (var i = 0; i < len; i++) {
      if (a[startA + i] !== b[startB + i]) return false;
    }
    return true;
  }

  /**
   * The rows of a pane read. pane text normally ends in a newline, and the empty element that
   * `split` puts after the last one is not a row of the pane: keeping it makes the buffer one
   * row longer than the pane really is, which shifts every overlap by one row and silently
   * costs a real line on each merge (measured before this fix: L1201 and L1601 gone from a
   * three-window scroll, with the merge reporting a clean 'append'). Blank rows *inside* the
   * text are real output and are kept.
   */
  function splitPaneText(text) {
    var rows = String(text).split(/\r?\n/);
    if (rows.length && rows[rows.length - 1] === '') rows.pop();
    return rows;
  }

  /**
   * The rows of `next` that `prev` does not already show, in order and with multiplicity —
   * §0.2 rule 1s. A row whose recent neighbour differs only in a repainted way (spinner
   * glyph, elapsed time, progress) is not new output either.
   */
  function novelRows(prev, next) {
    var tail = prev.slice(Math.max(0, prev.length - AB_RECENT));
    var counts = new Map();
    for (var i = 0; i < tail.length; i++) counts.set(tail[i], (counts.get(tail[i]) || 0) + 1);
    var near = prev.slice(Math.max(0, prev.length - AB_NEAR));
    var out = [];
    for (var j = 0; j < next.length; j++) {
      var line = next[j];
      var c = counts.get(line) || 0;
      if (c > 0) { counts.set(line, c - 1); continue; }
      var repaint = false;
      for (var n = 0; n < near.length; n++) {
        if (isRepaint(near[n], line)) { repaint = true; break; }
      }
      if (repaint) continue;
      out.push(line);
    }
    return out;
  }

  /** "same screen row, redrawn": equal length and at most two characters differ. */
  function isRepaint(a, b) {
    if (!a || !b || a.length !== b.length || a.length < 6) return false;
    var pre = 0;
    while (pre < a.length && a[pre] === b[pre]) pre++;
    if (pre < 2) return false;
    var suf = 0;
    while (suf < a.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    return pre + suf >= a.length - 2;
  }

  /** never re-append a prefix the buffer's tail already shows (exact, then repaint-tolerant) */
  function trimShown(prev, candidate) {
    var max = Math.min(prev.length, candidate.length);
    var j, i, bad, tol;
    for (j = max; j > 0; j--) {
      bad = false;
      for (i = 0; i < j; i++) {
        if (prev[prev.length - j + i] !== candidate[i]) { bad = true; break; }
      }
      if (!bad) return candidate.slice(j);
    }
    for (j = max; j >= AB_MIN_OVERLAP; j--) {
      tol = Math.max(1, Math.floor(j / 100));
      bad = 0;
      for (i = 0; i < j; i++) {
        if (prev[prev.length - j + i] !== candidate[i] && ++bad > tol) break;
      }
      if (bad <= tol) return candidate.slice(j);
    }
    return candidate;
  }

  /** the guards every branch goes through — §0.2 R1: never duplicate, never reset on a repaint */
  function applyGuards(prev, candidate, mode) {
    var out = trimShown(prev, candidate);
    if (out.length >= AB_MIN_BLOCK) {
      var have = {}, k;
      var tail = prev.slice(Math.max(0, prev.length - AB_RECENT));
      for (k = 0; k < tail.length; k++) have['$' + tail[k]] = true;
      var novel = 0;
      for (k = 0; k < out.length; k++) if (!have['$' + out[k]]) novel++;
      if (novel / out.length < AB_MIN_NOVEL) out = [];
    }
    return { newLines: out, mode: mode };
  }

  /**
   * prevLines: everything the client has shown for this pane.
   * nextLines: the fresh tail (window).
   * -> {newLines, mode} with mode ∈ 'append' | 'reset'.
   *
   * FALLBACK COPY. This is a transcription of lib/advance-buffer.js (§0.2 R2: the shared file
   * is the only implementation) and is only reachable if that file did not load — mount() below
   * prefers ctx.util.advanceBuffer and window.HD.advanceBuffer. It is a transcription and not a
   * simplification on purpose: `_scratch/w3/logic.mjs` asserts byte-identical output against the
   * shared copy (frozen rules, a 3,000-row walk, repainted chrome, a randomised corpus), so any
   * drift between the two copies fails the harness instead of hiding. Do not "improve" one
   * without the other.
   */
  function advanceBuffer(prevLines, nextLines) {
    var prev = prevLines || [];
    var next = nextLines || [];
    if (!prev.length) return { newLines: next.slice(), mode: 'append' };      // rule 4
    if (!next.length) return { newLines: [], mode: 'append' };                // noop
    var max = Math.min(prev.length, next.length);
    var k, i, bad, tol, candidate;

    for (k = max; k > 0; k--) {                                               // rule 1 (exact)
      if (arraysEqualAt(prev, next, prev.length - k, 0, k)) {
        return applyGuards(prev, next.slice(k), 'append');
      }
    }
    for (k = max; k >= AB_MIN_OVERLAP; k--) {                                 // rule 1r (repaints)
      tol = Math.max(1, Math.floor(k / 100));
      bad = 0;
      for (i = 0; i < k; i++) {
        if (prev[prev.length - k + i] !== next[i] && ++bad > tol) break;
      }
      if (bad <= tol) return applyGuards(prev, next.slice(k), 'append');
    }
    candidate = novelRows(prev, next);                                        // rule 1s
    if (candidate.length < next.length) return applyGuards(prev, candidate, 'append');

    // rule 2 (anchor): the last index p where prev matches next's first <=8 rows. §0.1 writes
    // the result as `next.slice(anchor.length)`, which re-appends the rows between the anchor
    // and the end of the buffer — the very duplication the rule exists to prevent (measured:
    // 806 duplicated lines in one cell). The buffer already covers `prev.length - p` rows from
    // the anchor's start, so that is what is appended.
    var anchorLen = Math.min(AB_ANCHOR, next.length);
    var anchor = next.slice(0, anchorLen);
    for (var p = prev.length - anchorLen; p >= 0; p--) {
      if (arraysEqualAt(prev, anchor, p, 0, anchorLen)) {
        var known = prev.length - p;
        candidate = known >= next.length ? [] : next.slice(known);
        return applyGuards(prev, candidate, 'append');
      }
    }
    return applyGuards(prev, next.slice(), 'reset');                          // rule 3 (reset)
  }

  /**
   * Walk a synthetic stream with a fixed sliding window: window i is
   * source.slice(i*step, i*step+windowSize), fed to advanceBuffer in order.
   * step = lines produced between two polls. Returns the accumulated buffer + mode tally.
   */
  function walkStream(source, windowSize, step) {
    step = Math.max(1, parseInt(step, 10) || 1);
    windowSize = Math.max(1, parseInt(windowSize, 10) || 1);
    var acc = [];
    var modes = { append: 0, reset: 0 };
    var polls = 0;
    // only full windows — a truncated final window is not a realistic pane.read result
    // and would (correctly) trip rule 3, hiding the behaviour we mean to measure
    for (var i = 0; i * step + windowSize <= source.length; i++) {
      var win = source.slice(i * step, i * step + windowSize);
      if (!win.length) break;
      var r = advanceBuffer(acc, win);
      acc = acc.concat(r.newLines);
      modes[r.mode] = (modes[r.mode] || 0) + 1;
      polls++;
    }
    return { lines: acc, modes: modes, polls: polls };
  }

  function sameLines(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function statusOf(rec) {
    var s = rec && (rec.agent_status || rec.status);
    s = s ? String(s).toLowerCase() : 'unknown';
    return STATUSES.indexOf(s) >= 0 ? s : 'unknown';
  }

  function clampCount(n) {
    n = parseInt(n, 10);
    if (!isFinite(n) || n < 1) return 1;
    return Math.min(MAX_CELLS, n);
  }
  /** Layout class for the count; 2/3/4/6 are the contract's presets. */
  function layoutFor(n) {
    n = clampCount(n);
    return (n === 2 || n === 3 || n === 4 || n === 6) ? 'hd-grid-n' + n : 'hd-grid-auto';
  }

  // ── message policy (§7.3 DEFECT-6) ─────────────────────────────────────────
  // The panel repaints on a 400 ms tick whose poll path ended in showErr(''), so a refusal
  // ("the grid holds at most 6 panes — remove one first") was wiped ~100 ms after it appeared:
  // the tick that maintains the cells also erased the only thing a human needed to read.
  // The policy below is the fix, and it is the ONLY writer of the message bar:
  //   · a message lives at least ERR_MIN_MS — no tick may wipe a fresh message;
  //   · a refusal is STICKY for ERR_STICKY_MS — a tick's clear may not wipe it at all; only the
  //     user's next action on this panel ends it (the valve only exists so a panel nobody ever
  //     touches cannot keep a stale refusal forever);
  //   · new content always beats old content (a read failure must not be swallowed by silence);
  //   · force:true — a user action — always wins outright, including clearing.
  var ERR_MIN_MS = 3000;      // §7.3's floor: "at least 3 s"
  var ERR_STICKY_MS = 15000;  // safety valve for a refusal nobody acts on

  /**
   * Decide what the message bar shows. Pure (no DOM, no clock of its own) so the harness can
   * assert the policy directly — `_scratch/w3/logic.mjs` does, and `--old-err` makes that
   * assertion fail against the pre-fix rule.
   * @param cur  {text,until,sticky,stickyUntil} what is on the bar now, or null when empty
   * @param next {text,force,sticky}             what someone is asking for
   * @param now  ms, from Date.now()
   * @returns {{text:string, keep:boolean}} keep=true means "leave the bar exactly as it is"
   */
  function errVerdict(cur, next, now) {
    var want = next && next.text != null ? String(next.text) : '';
    if (!cur || !cur.text) return { text: want, keep: false };           // empty bar: anything goes
    if (next && next.force) return { text: want, keep: false };          // user action: always wins
    if (want) return { text: want, keep: false };                        // news beats stale news
    if (cur.sticky && now < cur.stickyUntil) return { text: cur.text, keep: true };
    if (now < cur.until) return { text: cur.text, keep: true };           // the 3 s floor
    return { text: '', keep: false };                                    // expired: a tick may clear it
  }

  function testApi() {
    return { advanceBuffer: advanceBuffer, walkStream: walkStream, sameLines: sameLines,
             splitPaneText: splitPaneText,
             layoutFor: layoutFor, clampCount: clampCount, statusOf: statusOf,
             errVerdict: errVerdict, ERR_MIN_MS: ERR_MIN_MS, ERR_STICKY_MS: ERR_STICKY_MS,
             PLACEHOLDER_SEPARATOR: SEPARATOR };
  }

  // ── module ─────────────────────────────────────────────────────────────────

  function mount(ctx) {
    if (!ctx || !ctx.events) return null;
    var cleanupFns = [];
    var advance = advanceBuffer, advanceNote = '';
    // Prefer a shared §0.1 copy, in this order: app.js's ctx.util.advanceBuffer, then the one
    // lib/advance-buffer.js publishes on window.HD itself (that file can load while app.js's
    // publication fails). If the lib did not load at all, app.js still publishes a self-named
    // stub that re-appends the whole window on every poll — which would duplicate every line in
    // every cell — so a candidate is only used when it is the real thing, and when none is we
    // say so visibly instead of quietly degrading.
    try {
      var pubs = [ctx.util && ctx.util.advanceBuffer, HD.advanceBuffer];
      for (var pi = 0; pi < pubs.length && advance === advanceBuffer; pi++) {
        var pub = pubs[pi];
        if (typeof pub !== 'function') continue;
        var probe = pub([], ['probe']);
        if (probe && probe.rule === 'missing') {
          advanceNote = 'lib/advance-buffer.js did not load — this grid is using its own copy of the §0.1 rule';
        } else {
          advance = pub;
        }
      }
    } catch (e) { /* keep our own copy */ }

    var root = document.createElement('div');
    root.className = 'hd-grid';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', TITLE);

    var head = document.createElement('div');
    head.className = 'hd-grid-head';
    var h = document.createElement('span');
    h.className = 'hd-mod-title';
    h.textContent = TITLE;
    var count = document.createElement('span');
    count.className = 'small dim';
    var hint = document.createElement('span');
    hint.className = 'hd-grid-hint small dim';
    hint.textContent = 'pick up to 6 panes · each cell polls itself every 1.5 s · Esc closes' +
      (advanceNote ? ' · ' + advanceNote : '');
    var close = document.createElement('button');
    close.className = 'icon-btn';
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'close (Esc)';
    head.appendChild(h); head.appendChild(count); head.appendChild(hint); head.appendChild(close);

    var picker = document.createElement('div');
    picker.className = 'hd-grid-picker';

    var errBar = document.createElement('div');
    errBar.className = 'err hd-grid-err';
    errBar.hidden = true;

    var board = document.createElement('div');
    board.className = 'hd-grid-board';

    var empty = document.createElement('div');
    empty.className = 'hd-grid-empty dim';
    empty.textContent = 'no panes selected — click a pane above to add it';

    root.appendChild(head); root.appendChild(picker); root.appendChild(errBar);
    root.appendChild(board); root.appendChild(empty);

    var cells = {};        // paneId -> cell
    var order = [];        // paneId order
    var state = { open: false, err: '', errRec: null, timer: null, io: null };

    /**
     * The single writer of the message bar. `opts.force` marks a user action, `opts.sticky` a
     * refusal that must outlive the ticks — see errVerdict above for the policy itself.
     */
    function showErr(msg, opts) {
      var now = Date.now();
      var v = errVerdict(state.errRec, {
        text: msg == null ? '' : msg,
        force: !!(opts && opts.force),
        sticky: !!(opts && opts.sticky),
      }, now);
      if (v.keep) return;                       // §7.3: the tick keeps its hands off the bar
      var sticky = !!v.text && !!(opts && opts.sticky);
      state.errRec = v.text ? {
        text: v.text,
        until: now + ERR_MIN_MS,
        sticky: sticky,
        stickyUntil: sticky ? now + ERR_STICKY_MS : 0,
      } : null;
      state.err = v.text;
      errBar.textContent = v.text;
      errBar.hidden = !v.text;
    }

    function panesList() {
      try {
        if (ctx.state && typeof ctx.state.panes === 'function') {
          var a = ctx.state.panes();
          if (Array.isArray(a) && a.length) return a;
        }
      } catch (e) { /* fall through */ }
      var snap = ctx.state && ctx.state.snapshot;
      if (snap && snap.snapshot && Array.isArray(snap.snapshot.panes)) return snap.snapshot.panes;
      if (snap && Array.isArray(snap.panes)) return snap.panes;
      return [];
    }
    function paneRecord(paneId) {
      try {
        if (ctx.state && typeof ctx.state.pane === 'function') {
          var r = ctx.state.pane(paneId);
          if (r) return r;
        }
      } catch (e) { /* fall through */ }
      var all = panesList();
      for (var i = 0; i < all.length; i++) {
        if ((all[i].pane_id || all[i].paneId) === paneId) return all[i];
      }
      return null;
    }
    function titleOf(rec) {
      if (!rec) return '';
      return rec.label || rec.terminal_title_stripped || rec.terminal_title || rec.title || '';
    }

    // ── picker ───────────────────────────────────────────────────────────────
    function renderPicker() {
      picker.textContent = '';
      var panes = panesList();
      if (!panes.length) {
        var none = document.createElement('span');
        none.className = 'small dim';
        none.textContent = 'no snapshot yet';
        picker.appendChild(none);
        return;
      }
      for (var i = 0; i < panes.length; i++) {
        var p = panes[i] || {};
        var pid = p.pane_id || p.paneId;
        if (!pid) continue;
        pid = String(pid);
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'hd-pick' + (cells[pid] ? ' on' : '');
        var dot = document.createElement('span');
        dot.className = 'dot ' + statusOf(p);
        var lbl = document.createElement('span');
        lbl.className = 'mono';
        lbl.textContent = pid;
        var ag = document.createElement('span');
        ag.className = 'dim';
        ag.textContent = p.agent ? ' ' + p.agent : '';
        b.appendChild(dot); b.appendChild(lbl); b.appendChild(ag);
        b.title = (p.agent || '') + ' ' + titleOf(p);
        b.addEventListener('click', function (id) { return function () { togglePane(id); }; }(pid));
        picker.appendChild(b);
      }
    }

    function togglePane(paneId) {
      if (cells[paneId]) { removeCell(paneId); return false; }
      if (renderedCount() >= MAX_CELLS) {
        // a refusal, not a status line: it must survive the tick that repaints this panel
        showErr('the grid holds at most ' + MAX_CELLS + ' panes — remove one first', { sticky: true });
        return false;
      }
      showErr('', { force: true });   // the user's click succeeded — that is what ends a refusal
      addCell(paneId);
      return true;
    }

    // ── cells ────────────────────────────────────────────────────────────────
    function addCell(paneId) {
      if (cells[paneId]) return;
      var cell = {
        paneId: paneId,
        lines: [],
        revision: null,
        visible: true,
        inflight: false,
        lastAt: 0,
        timer: null,
        el: document.createElement('div'),
        pre: null,
      };
      cell.el.className = 'hd-cell st-' + statusOf(paneRecord(paneId));
      cell.el.setAttribute('data-pane-id', paneId);

      var ch = document.createElement('div');
      ch.className = 'hd-cell-head';
      var dot = document.createElement('span');
      dot.className = 'dot ' + statusOf(paneRecord(paneId));
      var pid = document.createElement('span');
      pid.className = 'mono hd-cell-pane';
      pid.textContent = paneId;
      var ag = document.createElement('span');
      ag.className = 'dim hd-cell-agent';
      ag.textContent = (paneRecord(paneId) && paneRecord(paneId).agent) || '';
      var ti = document.createElement('span');
      ti.className = 'dim hd-cell-title';
      ti.textContent = titleOf(paneRecord(paneId));
      var fresh = document.createElement('span');
      fresh.className = 'dim small hd-cell-age';
      var expand = document.createElement('button');
      expand.className = 'icon-btn';
      expand.type = 'button';
      expand.textContent = '⤢';
      expand.title = 'expand into the main view';
      expand.addEventListener('click', function (id) { return function (e) {
        e.stopPropagation();
        try {
          if (ctx.ui && typeof ctx.ui.selectPane === 'function') ctx.ui.selectPane(id);
        } catch (err) { showErr('selectPane failed: ' + (err && err.message ? err.message : err)); }
        hide();
      }; }(paneId));
      var rm = document.createElement('button');
      rm.className = 'icon-btn';
      rm.type = 'button';
      rm.textContent = '✕';
      rm.title = 'remove this cell';
      rm.addEventListener('click', function (id) { return function (e) {
        e.stopPropagation(); removeCell(id);
      }; }(paneId));
      ch.appendChild(dot); ch.appendChild(pid); ch.appendChild(ag); ch.appendChild(ti);
      ch.appendChild(fresh); ch.appendChild(expand); ch.appendChild(rm);

      var pre = document.createElement('pre');
      pre.className = 'hd-cell-pre';
      pre.textContent = 'loading…\n';
      cell.pre = pre;
      cell.head = { dot: dot, agent: ag, title: ti, age: fresh };

      cell.el.appendChild(ch); cell.el.appendChild(pre);
      // clicking the body of a cell selects that pane in the main view (does not close)
      cell.el.addEventListener('click', function (id) { return function () {
        try {
          if (ctx.ui && typeof ctx.ui.selectPane === 'function') ctx.ui.selectPane(id);
        } catch (err) { showErr('selectPane failed: ' + (err && err.message ? err.message : err)); }
      }; }(paneId));

      board.appendChild(cell.el);
      cells[paneId] = cell;
      order.push(paneId);
      applyLayout();
      observe(cell);
      renderPicker();
      updateCount();
      poll(cell, 0);   // first read immediately on add
    }

    function removeCell(paneId) {
      var cell = cells[paneId];
      if (!cell) return;
      if (cell.timer) { clearTimeout(cell.timer); cell.timer = null; }
      if (state.io) { try { state.io.unobserve(cell.el); } catch (e) { /* ignore */ } }
      if (cell.el.parentNode) cell.el.parentNode.removeChild(cell.el);
      delete cells[paneId];
      var i = order.indexOf(paneId);
      if (i >= 0) order.splice(i, 1);
      applyLayout();
      renderPicker();
      updateCount();
    }

    /**
     * Cells actually in the DOM. The header count is this number by construction, so a
     * display that disagrees with what is on screen is impossible — and the 6-pane cap is
     * enforced on the same number the user can see.
     */
    function renderedCount() {
      return board ? board.querySelectorAll('.hd-cell').length : 0;
    }
    function applyLayout() {
      var n = renderedCount();
      board.className = 'hd-grid-board ' + layoutFor(n || 1) + ' n' + n;
      empty.hidden = n > 0;
      board.hidden = n === 0;
    }
    function updateCount() {
      var target = renderedCount();
      var preset = (target === 2 || target === 3 || target === 4 || target === 6);
      count.textContent = target + '/' + MAX_CELLS + (preset ? '' : ' (2/3/4/6 are the presets)');
    }

    // ── visibility: stop polling cells that leave the viewport ───────────────
    function observe(cell) {
      if (typeof window.IntersectionObserver === 'function' && !state.io) {
        try {
          state.io = new window.IntersectionObserver(function (entries) {
            for (var i = 0; i < entries.length; i++) {
              var e = entries[i];
              var pid = e.target && e.target.getAttribute ? e.target.getAttribute('data-pane-id') : null;
              var c = pid ? cells[pid] : null;
              if (!c) continue;
              c.visible = !!(e.isIntersecting && e.intersectionRatio > 0);
            }
          }, { root: board, threshold: 0.05 });
        } catch (e) { state.io = null; }
      }
      if (state.io) { try { state.io.observe(cell.el); } catch (e) { /* ignore */ } }
      else cell.visible = true;   // no IO: fall back to "always poll while open"
    }

    // ── polling ──────────────────────────────────────────────────────────────
    function tick() {
      if (!state.open) return;
      var now = Date.now();
      var ids = order.slice();
      for (var i = 0; i < ids.length; i++) {
        var cell = cells[ids[i]];
        if (!cell || cell.inflight || !cell.visible) continue;
        if ((now - cell.lastAt) < POLL_MS) continue;
        poll(cell, i * 60);   // small stagger so 6 cells do not fire at once
      }
    }
    function poll(cell, delay) {
      if (cell.timer) { clearTimeout(cell.timer); cell.timer = null; }
      var fire = function () { cell.timer = null; doPoll(cell); };
      if (delay) cell.timer = setTimeout(fire, delay);
      else fire();
    }
    function doPoll(cell) {
      // §7.3: this path runs on the 400 ms tick, so its clears are deliberately non-forced —
      // they may only sweep a message that has outlived the floor/sticky window.
      if (!ctx.api || typeof ctx.api.pane !== 'function') {
        showErr('ctx.api.pane is unavailable — cannot stream');
        return;
      }
      cell.inflight = true;
      cell.lastAt = Date.now();
      Promise.resolve()
        .then(function () { return ctx.api.pane(cell.paneId, WINDOW_LINES); })
        .then(function (res) {
          if (!res || res.ok === false) {
            var m = res && res.error ? (res.error.message || res.error.code) : 'no result';
            showErr(cell.paneId + ': ' + m);
            return;
          }
          // §0.1: skip the merge entirely when the revision did not move
          if (typeof res.revision === 'number' && res.revision === cell.revision) {
            showErr('');
            ageCell(cell, true);
            return;
          }
          cell.revision = typeof res.revision === 'number' ? res.revision : cell.revision;
          var next = typeof res.text === 'string' ? splitPaneText(res.text) : [];
          mergeInto(cell, next);
          showErr('');
          ageCell(cell, true);
          refreshCellHead(cell);
        })
        .catch(function (e) {
          showErr(cell.paneId + ' read failed: ' + (e && e.message ? e.message : e));
        })
        .then(function () { cell.inflight = false; });
    }

    function mergeInto(cell, nextLines) {
      if (!cell.lines.length) {
        cell.lines = nextLines.slice();
        renderCell(cell);
        return;
      }
      var r;
      try { r = advance(cell.lines, nextLines); }
      catch (e) {
        showErr('merge failed for ' + cell.paneId + ': ' + (e && e.message ? e.message : e));
        r = { newLines: nextLines, mode: 'reset' };
      }
      if (r.mode === 'reset') {
        // screen cleared / pane recreated — say so instead of silently stacking text
        cell.lines = [SEPARATOR].concat(nextLines);
        renderCell(cell);
        return;
      }
      if (!r.newLines.length) return;
      cell.lines = cell.lines.concat(r.newLines);
      appendCell(cell, r.newLines);
    }

    function renderCell(cell) {
      cell.pre.textContent = cell.lines.length ? cell.lines.join('\n') + '\n' : '';
      trimCell(cell);
    }
    function appendCell(cell, newLines) {
      cell.pre.appendChild(document.createTextNode(newLines.join('\n') + '\n'));
      trimCell(cell);
    }
    /** Keep the DOM bounded; rebuild from the array only when we actually drop lines. */
    function trimCell(cell) {
      if (cell.lines.length <= MAX_LINES) return;
      cell.lines = cell.lines.slice(cell.lines.length - MAX_LINES);
      renderCell(cell);
    }
    function ageCell(cell, ok) {
      if (!cell.head || !cell.head.age) return;
      cell.head.age.textContent = ok ? 'now' : '';
    }
    function refreshCellHead(cell) {
      var rec = paneRecord(cell.paneId);
      var st = statusOf(rec);
      if (cell.head) {
        if (cell.head.dot.className !== 'dot ' + st) cell.head.dot.className = 'dot ' + st;
        var ag = (rec && rec.agent) || '';
        if (cell.head.agent.textContent !== ag) cell.head.agent.textContent = ag;
        var ti = titleOf(rec);
        if (cell.head.title.textContent !== ti) {
          cell.head.title.textContent = ti;
          cell.head.title.title = ti;
        }
      }
      var cls = 'hd-cell st-' + st;
      if (cell.el.className !== cls) cell.el.className = cls;
    }

    // ── visibility of the whole overlay ──────────────────────────────────────
    function show() {
      if (state.open) return;
      state.open = true;
      root.hidden = false;
      renderPicker();
      applyLayout();
      updateCount();
      showErr('', { force: true });   // opening the panel is a user action on it
      if (!state.timer) state.timer = setInterval(tick, 400);
      tick();
    }
    function hide() {
      if (!state.open) return;
      state.open = false;
      root.hidden = true;
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
    }
    function toggle() { state.open ? hide() : show(); }

    function setPanes(ids) {
      var wanted = Array.isArray(ids) ? ids.map(String) : [];
      // Never drop a requested pane without saying so: the cap is a refusal, not a filter.
      if (wanted.length > MAX_CELLS) {
        showErr('the grid holds at most ' + MAX_CELLS + ' panes — kept ' + MAX_CELLS + ' of the ' +
                wanted.length + ' requested (remove one, then add the rest)', { sticky: true });
      } else {
        showErr('', { force: true });   // an explicit set that fits — a user action
      }
      ids = wanted.slice(0, MAX_CELLS);
      var keep = {};
      for (var i = 0; i < ids.length; i++) keep[ids[i]] = true;
      for (var j = order.slice().length - 1; j >= 0; j--) {
        if (!keep[order[j]]) removeCell(order[j]);
      }
      for (var k = 0; k < ids.length; k++) if (!cells[ids[k]]) addCell(ids[k]);
    }
    /**
     * Add a pane. Unlike the picker chips (which toggle, because a chip is a switch) this
     * never removes: an "add" that silently removed an already-shown pane makes the header
     * count and the visible cells appear to disagree, so it is idempotent instead.
     */
    function addPane(id) {
      if (!id) return false;
      id = String(id);
      if (cells[id]) return true;
      return togglePane(id) !== false;
    }

    // ── wiring ───────────────────────────────────────────────────────────────
    var off = [];
    function on(type, fn) {
      try {
        var u = ctx.events.on(type, function (p) { try { fn(p); } catch (e) { showErr(type + ': ' + (e && e.message ? e.message : e)); } });
        if (typeof u === 'function') off.push(u);
      } catch (e) { showErr('subscribe ' + type + ' failed: ' + (e && e.message ? e.message : e)); }
    }
    on('snapshot', function () {
      if (state.open) { renderPicker(); }
      for (var i = 0; i < order.length; i++) if (cells[order[i]]) refreshCellHead(cells[order[i]]);
    });
    on('select', function () {
      if (state.open) renderPicker();
    });
    on('grid.toggle', toggle);
    on('grid.set', function (p) {
      var ids = Array.isArray(p) ? p : (p && Array.isArray(p.paneIds) ? p.paneIds : null);
      if (ids) { show(); setPanes(ids); }
    });
    on('grid.add', function (p) {
      var id = p && (p.paneId || p.pane_id) ? (p.paneId || p.pane_id) : p;
      if (id) { show(); addPane(id); }
    });
    on('module.toggle', function (p) { if (p === ID || (p && p.id === ID)) toggle(); });

    close.addEventListener('click', function () { hide(); });
    document.addEventListener('keydown', function (e) {
      if (!state.open) return;
      if (e.key !== 'Escape') return;
      var t = e.target;
      var tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      e.preventDefault(); e.stopImmediatePropagation();   // beat W2's "Esc sends esc to the pane"
      hide();
    }, true);

    // Shift-clicking a tree row adds that pane. The row markup belongs to W2, so we look
    // for the documented-ish attributes and fall back to our own picker (§3 does not fix
    // an attribute name — reported as an API gap).
    document.addEventListener('click', function (e) {
      if (!e.shiftKey) return;
      var el = e.target;
      var pid = null;
      while (el && el !== document.body) {
        if (el.getAttribute) {
          pid = el.getAttribute('data-pane-id') || el.getAttribute('data-pane') || el.getAttribute('data-id');
          if (pid) break;
          if (el.classList && el.classList.contains('pane-row')) break;
        }
        el = el.parentNode;
      }
      if (!pid) return;
      e.preventDefault(); e.stopPropagation();
      show();
      addPane(pid);
    }, true);

    // §3: every shortcut must reach W2's `?` help overlay.
    registerKeys(ctx, ID, [
      ['Esc', 'grid: close'],
      ['shift+click', 'grid: add the clicked pane to the grid'],
    ], 'close the multi-pane grid');

    document.body.appendChild(root);
    renderPicker();
    applyLayout();
    updateCount();

    cleanupFns.push(function () {
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      if (state.io) { try { state.io.disconnect(); } catch (e) { /* ignore */ } state.io = null; }
      for (var i = 0; i < order.length; i++) {
        var c = cells[order[i]];
        if (c && c.timer) clearTimeout(c.timer);
      }
      for (var j = 0; j < off.length; j++) { try { off[j](); } catch (e) { /* ignore */ } }
      off.length = 0;
      if (root.parentNode) root.parentNode.removeChild(root);
    });

    return {
      show: show, hide: hide, toggle: toggle,
      setPanes: setPanes, addPane: addPane,
      cellCount: function () { return renderedCount(); },   // the same number the header shows
      renderedCells: function () {
        var els = board ? board.querySelectorAll('.hd-cell') : [];
        var out = [];
        for (var i = 0; i < els.length; i++) out.push(els[i].getAttribute('data-pane-id'));
        return out;
      },
      errorText: function () { return state.err || ''; },
      unmount: function () {
        for (var i = 0; i < cleanupFns.length; i++) { try { cleanupFns[i](); } catch (e) { /* ignore */ } }
        cleanupFns.length = 0;
      },
    };
  }

  /** §3: advertise this module's shortcuts to W2's help overlay. Never fatal. */
  function registerKeys(ctx, id, pairs, help) {
    try {
      if (ctx && ctx.events && typeof ctx.events.emit === 'function') {
        var keys = [];
        for (var i = 0; i < pairs.length; i++) keys.push({ key: pairs[i][0], help: pairs[i][1] });
        ctx.events.emit('keys.register', { id: id, keys: keys, help: help });
      }
    } catch (e) { /* the help overlay is optional */ }
  }

  HD[ID + 'Test'] = testApi();
  register({ id: ID, title: TITLE, mount: mount, test: testApi() });

  // Registration handshake — see board.js for the full note.
  function register(mod) {
    var HDx = (window.HD = window.HD || {});
    HDx.modules = HDx.modules || {};
    HDx.modules[mod.id] = mod;
    HDx.pending = HDx.pending || [];
    if (HDx.pending.indexOf(mod) < 0) HDx.pending.push(mod);
    if (typeof HDx.register === 'function') {
      try { HDx.register(mod); } catch (e) { return false; }
      return true;
    }
    scheduleRegister(mod);
    return false;
  }
  function scheduleRegister(mod) {
    if (typeof document === 'undefined' || !document || typeof document.addEventListener !== 'function') return;
    var done = false;
    var tryNow = function () {
      if (done) return;
      var HDx = window.HD;
      if (HDx && typeof HDx.register === 'function') {
        done = true;
        try { HDx.register(mod); } catch (e) { /* integrator's problem */ }
      }
    };
    document.addEventListener('DOMContentLoaded', tryNow, { once: true });
    window.addEventListener('load', tryNow, { once: true });
    var tries = 0;
    var t = setInterval(function () {
      if (done || ++tries > 100) { clearInterval(t); return; }
      tryNow();
    }, 100);
  }
})();
