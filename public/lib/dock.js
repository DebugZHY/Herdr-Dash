/* herdr-dash — lib/dock.js (W3, CONTRACT-v2 §12.2.1 / §12.2.3 / §12.2.4)
 *
 * The side dock: the SELECTED pane's own status output, interpreted. One request per tick — GET
 * /api/status?pane_id=<selected pane> (§12.3) — on the chat view's cadence (2 s). Never every pane:
 * the endpoint costs one `pane.read` per call and §12.3.5 forbids a fan-out.
 *
 * AND NOTHING AT ALL FOR A PANEL NOBODY CAN READ. Two signals pause the cadence and its label tick:
 * `document.hidden` (§3, the convention chatview.js set) and a COLLAPSED shell (§12.2's errata —
 * `<aside id="dock" class="collapsed">`, which is not `document.hidden` and was the round-8 defect:
 * one herdr read + one jsonl read every 2 s for a panel that was not on screen). Opening the panel
 * reads ONCE, at once, and an answer older than one cadence is never shown as current while that
 * read is in flight — it waits under the same "not current" label a failed read uses. An explicit
 * refresh() is the caller's own request and is not governed by the pause.
 *
 * AND EXACTLY ONE READ BEHIND THAT PAUSE, at the three moments the reader can newly see or newly aim
 * the panel (§12.2 errata, frozen): the mount, a selection change, and the return to a readable tab.
 * The header chip this module feeds (§12.2.2) is on screen whether or not the dock is open, so a chip
 * that fell to `—` the moment the user selected another pane would defeat the dock's own read. One
 * read it is: no timer is started by any of the three, and the cadence stays paused after it.
 *
 * THE HONESTY BAR (this module's whole reason to exist). The two families print DIFFERENT metrics
 * and must never be drawn in the same shape (§12.0, §12.2.4):
 *
 *   hermes  `☤ <model> │ <used>/<limit> │ [bar] <pct>% │ ◎ <x>% │ ◷ <s>` — the agent prints a
 *           limit, a percentage and a bar. Rendered as ONE row: model · used/limit · bar · pct ·
 *           elapsed. A `~` the agent wrote travels as `status.approx` and is shown as an `approx`
 *           badge — never dropped, never turned into a precise-looking number.
 *   claude  `⏵⏵ auto mode on … 8% until auto-compact` — no model, no limit, no bar; its context
 *           size is computed by the SERVER from the last assistant record's `usage` in claude's own
 *           jsonl, and its `until_auto_compact_pct` (claude's own footer figure, a DIFFERENT
 *           denominator from hermes' used_pct) is often absent. Rendered as stacked lines with the
 *           breakdown, and with the note that claude prints no used/limit figure. When
 *           `until_auto_compact_pct` is null the tokens are shown alone, with a sentence saying so.
 *           The two shapes share no node names (see the frozen names below and in dock.css): a later
 *           round cannot accidentally draw one as the other.
 *
 * Every number on screen comes FROM the response. Nothing is recomputed: the percentage text is
 * `used_pct` as the server read it, the bar's width is that same value clamped for drawing only,
 * the token counts are `used_tokens`/`limit_tokens` grouped with thousands separators (a reading
 * aid, not arithmetic), and the elapsed figure is `elapsed_s`. When the response says nothing about
 * a figure, the dock says so in that figure's own slot — it never fills a gap with a guess.
 *
 * Empty states are explicit sentences, never a blank box: `this agent prints no process list`,
 * `no status line in the last N lines` (N from the response's own read window when it reports one),
 * `the agent elided this with …`, `claude's footer printed no auto-compact figure …`. Elided text
 * keeps the agent's own `…` verbatim and is labelled beside it; nothing here completes, shortens or
 * "fixes" agent text.
 *
 * A failed read is a described state, never a stale number wearing a current face: the live body is
 * REPLACED by the failure sentence plus when the last read succeeded, and the last good answer — if
 * there is one — appears only inside `.hd-dock-stale-last[data-stale="1"]`, whose own label says
 * "not current". Switching panes drops the numbers for the same reason: the new pane gets
 * `reading <pane> …` until its own answer lands.
 *
 * Mount (§12.2.3): `#dockHost` is the shell element W2 adds to index.html. If it is not in the page
 * at mount time the module mounts NOTHING — no DOM, no timer, no request — keeps the whole API
 * alive, and says why (`state().reason`, `refresh()` resolving `{ok:false, error:{code:'no_host'}}`).
 * `adopt()` looks for the host again and mounts for real if it has since appeared. The `d` key that
 * collapses the dock belongs to W2's shell (§12.2.1) — this module claims no keyboard shortcut and
 * never emits `keys.register`.
 *
 * DOM (frozen names — the same list is frozen in dock.css; a later round must reuse them instead of
 * inventing a second shape). Everything is built as nodes and set with textContent; the only
 * innerHTML here is '' (agent output is untrusted text):
 *
 *   #dockHost                       shell element (W2, index.html); may be absent
 *     .hd-dock[data-family][data-state="reading|live|failed"]
 *       .hd-dock-head
 *         .hd-dock-pane             the pane id, from the response
 *         .hd-dock-family[data-family]  the agent family word (hermes|claude|other|none)
 *         .hd-dock-when             "updated 2s ago" / the failure age (1 s label tick, no request)
 *       .hd-dock-msg                the one sentence of a reading/failed panel
 *       .hd-dock-body               the live answer (absent while failed/reading)
 *         section.hd-dock-sec[data-sec="usage|processes|source"]
 *           .hd-dock-sec-head
 *           .hd-dock-usage[data-shape="hermes|claude"]
 *             .hd-dock-hermes / .hd-dock-claude     (never both, never nested)
 *               .hd-dock-model
 *               .hd-dock-fig[data-fig="used|pct|elapsed|model|context|until"][data-missing]
 *               .hd-dock-approx            the agent's own `~`
 *               .hd-dock-bar[data-pct] > .hd-dock-bar-fill[data-fill]
 *               .hd-dock-breakdown         claude only
 *             .hd-dock-note[data-note]     where the numbers came from / what is not printed
 *           .hd-dock-procs-head / .hd-dock-hint
 *           ul.hd-dock-proc-list > li.hd-dock-proc
 *             .hd-dock-proc-cmd[data-elided] / .hd-dock-proc-age / .hd-dock-proc-last[data-elided]
 *           button.hd-dock-src-head[aria-expanded][data-open]  "show source · N lines"
 *           .hd-dock-src[hidden] > .hd-dock-src-line[data-from][data-elided]   verbatim, `…` intact
 *           .hd-dock-elide[data-elide]   "the agent elided this with …"
 *           .hd-dock-empty[data-why]     the explicit sentence for an empty section
 *       .hd-dock-stale                          the failure state (replaces .hd-dock-body)
 *         .hd-dock-stale-msg
 *         .hd-dock-stale-note                   "last good answer · 12s ago · pane X — not current"
 *         .hd-dock-stale-last[data-stale="1"]   the last good answer, labelled not current
 *
 * Data path: `ctx.api.status(pane_id)` when app.js publishes one (W2 may add it), else a plain
 * `fetch('/api/status?pane_id=…')` with an AbortController and a REQ_TIMEOUT_MS deadline, so a
 * request the server never answers cannot freeze the dock (DEFECT-12's lesson). Both paths resolve
 * to the SAME shape: {ok, pane_id, body?, error?, at} — never a rejection.
 *
 * Handle: mount() returns {latest, refresh, unmount, mounted, state, dom, adopt} (§12.2.3's three
 * plus introspection). `latest()` is the last /api/status answer, null before the first one. An
 * answer for a pane other than the selected one is kept in latest() (it IS the last answer) but is
 * never painted as the selected pane's.
 */
(function () {
  'use strict';

  var HD = (window.HD = window.HD || {});
  var ID = 'dock';
  var TITLE = 'Status dock';

  var POLL_MS = 2000;            // §12.2.3: the chat view's cadence (§8.3 uses 2000 too)
  var LABEL_TICK_MS = 1000;      // the "updated Ns ago" label only — this timer never fetches
  var REQ_TIMEOUT_MS = 6000;     // a read the server never answers is a described failure
  var DEDUP_MS = 500;            // the same pane inside this window is not asked twice
  var HOST_ID = 'dockHost';
  var ROUTE = '/api/status';
  var CSS_FILE = 'dock.css';
  var CSS_HREF = '/lib/' + CSS_FILE;
  /* §12.2.1: W2's <aside id="dock">, the element that carries the shell's own `collapsed` class. It is
     the one signal that says the panel is not on screen — and §12.2's errata makes that a reason to
     stop reading /api/status: a collapsed dock is not `document.hidden`, and polling for a panel
     nobody can read is one herdr read + one jsonl read every 2 s for nothing. */
  var SHELL_ID = 'dock';
  var SHELL_CLOSED = 'collapsed';
  /* an answer older than one cadence is not shown as current when the panel comes back (§12.2.4): the
     reopening reads at once, and until that read lands the previous numbers stay — labelled */
  var RESUMED_MAX_AGE_MS = POLL_MS;
  /* the reasons the cadence can be paused, by name: `state().paused` reports one of these, and the
     sentence in `state().paused_reason` is what a caller shows the reader */
  var PAUSED_HIDDEN = 'hidden';
  var PAUSED_COLLAPSED = 'collapsed';

  /* the frozen markup names — mirrored in dock.css, stated in the header above */
  var CLS = {
    dock: 'hd-dock', head: 'hd-dock-head', pane: 'hd-dock-pane', family: 'hd-dock-family',
    when: 'hd-dock-when', msg: 'hd-dock-msg', body: 'hd-dock-body',
    sec: 'hd-dock-sec', secHead: 'hd-dock-sec-head',
    usage: 'hd-dock-usage', hermes: 'hd-dock-hermes', claude: 'hd-dock-claude',
    model: 'hd-dock-model', fig: 'hd-dock-fig', approx: 'hd-dock-approx', bar: 'hd-dock-bar',
    barFill: 'hd-dock-bar-fill', breakdown: 'hd-dock-breakdown', note: 'hd-dock-note',
    empty: 'hd-dock-empty', procsHead: 'hd-dock-procs-head', hint: 'hd-dock-hint',
    procList: 'hd-dock-proc-list', proc: 'hd-dock-proc', procCmd: 'hd-dock-proc-cmd',
    procAge: 'hd-dock-proc-age', procLast: 'hd-dock-proc-last', elide: 'hd-dock-elide',
    srcHead: 'hd-dock-src-head', src: 'hd-dock-src', srcLine: 'hd-dock-src-line',
    stale: 'hd-dock-stale', staleMsg: 'hd-dock-stale-msg', staleNote: 'hd-dock-stale-note',
    staleLast: 'hd-dock-stale-last'
  };

  /* ── helpers ─────────────────────────────────────────────────────────── */

  function el(tag, cls, tx) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (tx !== undefined && tx !== null) d.textContent = String(tx);
    return d;
  }
  function txt(v) { return (v === undefined || v === null) ? '' : String(v); }
  function has(v) { return v !== undefined && v !== null && v !== ''; }
  function num(v) {
    if (v === undefined || v === null || v === '' || typeof v === 'boolean') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  /* thousands separators are a reading aid for a number that is already in the response — the module
     never adds, subtracts or converts a value the agent printed */
  function group(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function ago(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var s = Math.round(ms / 1000);
    if (s < 1) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's ago';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago';
  }
  function secs(v) { var n = num(v); return n === null ? null : (Math.round(n * 10) / 10) + 's'; }
  function pcts(v) { var n = num(v); return n === null ? null : (Math.round(n * 10) / 10) + '%'; }

  /* the server's own empty reason wins (§12.3.4: every absent field carries a plain-language reason);
     the sentence below is the fallback when it does not, and it is a sentence, not a blank box */
  function absentReason(body, field) {
    var a = body && body.absent;
    if (a && typeof a === 'object' && has(a[field])) return txt(a[field]);
    return '';
  }
  /* `no status line in the last N lines` — N is the response's own read window when it reports one,
     and the sentence drops N rather than inventing a number when it does not */
  function noStatusSentence(body) {
    var n = num(body && body.lines_read);
    return n === null ? 'no status line in this pane\'s recent output'
      : 'no status line in the last ' + n + ' lines';
  }

  function fig(parent, name, value, opts) {
    var f = el('span', CLS.fig, value);
    f.setAttribute('data-fig', name);
    if (opts && opts.missing) f.setAttribute('data-missing', '1');
    if (opts && opts.title) f.title = opts.title;
    parent.appendChild(f);
    return f;
  }
  function note(parent, key, sentence, why) {
    var n = el('div', CLS.note, sentence);
    n.setAttribute('data-note', key);
    if (why) n.title = why;
    parent.appendChild(n);
    return n;
  }
  function emptyInto(parent, why, sentence) {
    var d = el('div', CLS.empty, sentence);
    d.setAttribute('data-why', why);
    parent.appendChild(d);
    return d;
  }
  function section(kind, title) {
    var s = el('section', CLS.sec);
    s.setAttribute('data-sec', kind);
    s.appendChild(el('div', CLS.secHead, title));
    return s;
  }
  function elideNote(what) {
    /* the agent's own `…` stays in the text untouched; this is the label that says who put it there */
    var n = el('span', CLS.elide, 'the agent elided this with …');
    n.setAttribute('data-elide', what);
    n.title = 'the text above ends in … because the agent cut it short — nothing here was completed or shortened by the app';
    return n;
  }

  /* ── the module ──────────────────────────────────────────────────────── */

  function createDock(ctx) {
    var api = (ctx && ctx.api) || {};
    var events = (ctx && ctx.events) || null;

    var host = null;                 // #dockHost, or null when the shell has not added it
    var hostReason = '';             // why nothing is mounted, in words (state().reason)
    var mountedAt = 0;
    var unmounted = false;
    var pollTimer = null;
    var labelTimer = null;
    var req = null;                  // the ONE in-flight read: {pane, at, ctrl, timer, done}
    var lastAsk = null;              // {pane, at} — the dedup window, never a latch
    var lastAnswer = null;           // the last /api/status answer (latest())
    var lastGood = null;             // {pane_id, body, at} — the last ok:true answer
    var lastFail = null;             // {pane_id, error, at}
    var curPane = null;              // the pane the DOM currently describes
    var curBody = null;              // the body it describes (live state only)
    var curState = 'reading';        // reading | live | failed
    var srcOpen = {};                // paneId -> the source area's open/closed state (in memory only)
    var whenEl = null;               // the live ".hd-dock-when" node (the label tick rewrites it)
    var clock = function () { return Date.now(); };
    var waiters = [];                // refresh() callers waiting for the answer to the pane they asked for
    var shell = null;                // the <aside id="dock"> the host sits in, or null when there is none
    var shellWatch = null;           // the observer on that shell's class, when one can be made
    var pausedFor = null;            // PAUSED_HIDDEN | PAUSED_COLLAPSED while the cadence is paused

    /* ── the shell ── */

    function findHost() {
      try { return document.getElementById(HOST_ID); } catch (e) { return null; }
    }
    /* the shell is whatever ancestor carries id="dock". Found by walking up from the host, so a host
       mounted somewhere else in a future layout simply has no shell: then there is no collapse to
       pause for, and the dock keeps the cadence it has always had. */
    function findShell() {
      try {
        var n = host;
        while (n) { if (n.id === SHELL_ID) return n; n = n.parentNode || null; }
      } catch (e) { /* a node without a parent chain */ }
      return null;
    }
    function shellEl() { if (!shell) shell = findShell(); return shell; }
    /* the shell's own word for "the panel is not on screen" (§12.2.1: `collapsed`, as W2 writes it) */
    function isCollapsed() {
      var s = shellEl();
      if (!s) return false;
      try {
        if (s.classList && typeof s.classList.contains === 'function') return s.classList.contains(SHELL_CLOSED) === true;
      } catch (e) { /* no classList: read the attribute the long way */ }
      var c = s.className;
      return typeof c === 'string' && (' ' + c + ' ').indexOf(' ' + SHELL_CLOSED + ' ') >= 0;
    }
    /* why the cadence is paused, or null when it is running. `document.hidden` is §3's rule; the
       collapsed shell is §12.2's errata — the same conclusion from a different signal. */
    function pauseReason() {
      if (document.hidden) return PAUSED_HIDDEN;
      if (isCollapsed()) return PAUSED_COLLAPSED;
      return null;
    }
    function pausedSentence(why) {
      if (why === PAUSED_COLLAPSED) return 'the dock is collapsed — the poll is paused while the panel cannot be read';
      if (why === PAUSED_HIDDEN) return 'the tab is hidden — the poll is paused until it is shown again';
      return null;
    }
    /* the one question both timers ask before they do anything: is this panel readable at all? A tick
       that adopted a reason returns true and does nothing — neither the poll nor the label tick may
       run for a panel that is not on screen. */
    function checkPause() {
      var why = pauseReason();
      if (why) { if (pausedFor !== why) pause(why); return true; }
      return false;
    }
    /* W2's shell flips the class and emits no event, so the class itself is watched. A mutation
       observer is not required: without one, poll() re-checks on its own tick and stays paused — it
       just keeps a timer that asks for nothing. */
    function watchShell() {
      if (shellWatch || unmounted || !host) return false;
      if (!shellEl()) return false;
      var MO = null;
      try {
        MO = (typeof MutationObserver !== 'undefined') ? MutationObserver
           : (window.MutationObserver || null);
      } catch (e) { MO = null; }
      if (!MO) return false;
      try {
        shellWatch = new MO(function () { onShellChange(); });
        shellWatch.observe(shellEl(), { attributes: true, attributeFilter: ['class'] });
      } catch (e) { shellWatch = null; return false; }
      return true;
    }
    /* the shell changed: collapse stops the cadence, opening starts it AND reads at once (§12.2 errata) */
    function onShellChange() {
      if (unmounted || !host) return;
      var why = pauseReason();
      if (why) { if (pausedFor !== why) pause(why); return; }
      if (pausedFor) resume();
    }
    /* dock.css is W3's own file; index.html is W2's (§12.4) and may not list it yet. If the page has
       no link to it, the module adds one — same file, so a page that already links it gets no second
       link, and a page without it still gets the look instead of an unstyled column. */
    function ensureCss() {
      try {
        var links = document.getElementsByTagName ? document.getElementsByTagName('link') : null;
        if (links) {
          for (var i = 0; i < links.length; i++) {
            var h = links[i] && links[i].getAttribute ? links[i].getAttribute('href') : null;
            if (h && String(h).indexOf(CSS_FILE) >= 0) return false;
          }
        }
        var head = document.head || (document.getElementsByTagName('head') || [])[0];
        if (!head || !head.appendChild) return false;
        var l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = CSS_HREF;
        head.appendChild(l);
        return true;
      } catch (e) { return false; }
    }

    /* ── reading /api/status (§12.3) ── */

    function readBody(res) {
      if (res && typeof res.json === 'function') {
        try { return Promise.resolve(res.json()).then(function (b) { return b; },
          function () { return null; }); } catch (e) { return Promise.resolve(null); }
      }
      return Promise.resolve(null);
    }

    /* resolve ONE read into {ok, pane_id, body?, error?, at}. Never rejects, never throws. */
    function ask(paneId, cb) {
      var at = clock();
      var done = false;
      var rec = { pane: paneId, at: at, ctrl: null, timer: null, done: false };
      function finish(res) {
        if (done) return;
        done = true;
        rec.done = true;
        if (rec.timer !== null) { try { window.clearTimeout(rec.timer); } catch (e) { /* gone */ } rec.timer = null; }
        if (req === rec) req = null;
        cb(res);
      }
      /* dropping a read on purpose (the user selected another pane) is not an answer: it must not
         become latest(), and it must not paint a failure for a pane nobody is looking at */
      rec.abandon = function () {
        if (done) return false;
        done = true;
        rec.done = true;
        if (rec.timer !== null) { try { window.clearTimeout(rec.timer); } catch (e) { /* gone */ } rec.timer = null; }
        if (rec.ctrl && rec.ctrl.abort) { try { rec.ctrl.abort(); } catch (e) { /* gone */ } }
        if (req === rec) req = null;
        return true;
      };
      function fail(code, message) {
        finish({ ok: false, pane_id: paneId, error: { code: code, message: message }, at: at });
      }
      try { if (window.AbortController) rec.ctrl = new AbortController(); } catch (e) { rec.ctrl = null; }
      /* the deadline is armed for BOTH paths: a promise that never settles is the same freeze as a
         socket that never answers, and the dock must never sit on a pane saying nothing */
      try {
        rec.timer = window.setTimeout(function () {
          if (done) return;
          if (rec.ctrl && rec.ctrl.abort) { try { rec.ctrl.abort(); } catch (e) { /* gone */ } }
          fail('timeout', 'reading the status timed out after ' + Math.round(REQ_TIMEOUT_MS / 1000) + 's — the server did not answer');
        }, REQ_TIMEOUT_MS);
      } catch (e) { rec.timer = null; }
      req = rec;

      /* path 1: app.js's own helper, if this round's W2 published one (§12.2.3 does not require it) */
      if (typeof api.status === 'function') {
        var p;
        try { p = api.status(paneId); }
        catch (e) { fail('threw', 'the status call threw: ' + txt(e && e.message ? e.message : e)); return; }
        Promise.resolve(p).then(function (b) {
          if (b && typeof b === 'object' && b.ok === false) {
            var er = b.error || {};
            fail(txt(er.code) || 'bad_response', txt(er.message) || 'the status call reported no reason');
          } else if (b && typeof b === 'object') {
            /* the answer's pane id is the pane that was ASKED for, never the body's own field: the
               body's pane_id is DATA to be checked against it (checkPane), and adopting it here
               would make that check compare a value with itself and never fire */
            finish({ ok: true, pane_id: paneId, body: b, at: at });
          } else {
            fail('bad_response', 'the status call answered nothing — the dock shows no numbers it cannot source');
          }
        }, function (e) {
          fail('network', 'the status call failed: ' + txt(e && e.message ? e.message : e));
        });
        return;
      }

      /* path 2: our own request (§12.3's route, read-only, loopback) */
      var f = (typeof window.fetch === 'function') ? window.fetch : null;
      if (!f) { fail('no_fetch', 'this page has no fetch() — the dock cannot read ' + ROUTE); return; }
      var url = ROUTE + '?pane_id=' + encodeURIComponent(paneId);
      var opts = { headers: { accept: 'application/json' } };
      if (rec.ctrl) opts.signal = rec.ctrl.signal;
      var pr;
      try { pr = f(url, opts); }
      catch (e) { fail('network', 'the request failed: ' + txt(e && e.message ? e.message : e)); return; }
      Promise.resolve(pr).then(function (res) {
        if (done) return;
        return readBody(res).then(function (b) {
          if (done) return;
          if (!res || res.ok !== true) {
            var er = (b && b.error) || {};
            finish({
              ok: false, pane_id: paneId, at: at,
              error: { code: txt(er.code) || ('http_' + txt(res && res.status)), message: txt(er.message) || ('HTTP ' + txt(res && res.status) + ' from ' + ROUTE) }
            });
            return;
          }
          if (!b || typeof b !== 'object' || b.ok === false) {
            var er2 = (b && b.error) || {};
            finish({ ok: false, pane_id: paneId, at: at, error: { code: txt(er2.code) || 'bad_response', message: txt(er2.message) || 'the answer was not the §12.3 body' } });
            return;
          }
          finish({ ok: true, pane_id: paneId, body: b, at: at });
        });
      }, function (e) {
        if (done) return;
        var aborted = !!(rec.ctrl && rec.ctrl.signal && rec.ctrl.signal.aborted);
        finish({
          ok: false, pane_id: paneId, at: at,
          error: aborted
            ? { code: 'aborted', message: 'the request was dropped — the pane changed or the deadline passed' }
            : { code: 'network', message: 'the request failed: ' + txt(e && e.message ? e.message : e) }
        });
      });
    }

    /* ── the answer ── */

    function selectedPane() {
      try { return txt(ctx && ctx.state ? ctx.state.selectedPaneId : null) || null; } catch (e) { return null; }
    }

    /* a body the server answered for a pane other than the one that was asked for would put another
       pane's numbers on this pane's panel — refused, out loud, instead of drawn */
    function checkPane(ans) {
      if (!ans.ok) return ans;
      var asked = ans.pane_id;
      var got = txt(ans.body && ans.body.pane_id);
      if (got && asked && got !== asked) {
        return {
          ok: false, pane_id: asked, at: ans.at,
          error: {
            code: 'pane_mismatch',
            message: 'the server answered for ' + got + ' while ' + asked + ' is the selected pane — nothing is shown'
          }
        };
      }
      return ans;
    }

    function onAnswer(raw) {
      var ans = checkPane(raw);
      lastAnswer = ans;                          // latest() is the last answer, ok or not
      if (ans.ok && ans.body) lastGood = { pane_id: ans.pane_id, body: ans.body, at: ans.at };
      if (!ans.ok) lastFail = { pane_id: ans.pane_id, error: ans.error, at: ans.at };
      settleWaiters(ans);
      if (unmounted) return;
      /* an answer for a pane the user has left is NOT painted as the selected pane's */
      if (ans.pane_id !== selectedPane()) { emitDock(ans, curState); return; }
      if (ans.ok) {
        curPane = ans.pane_id;
        curBody = ans.body;
        curState = 'live';
      } else {
        curPane = ans.pane_id;
        curBody = null;
        curState = 'failed';
      }
      paint();
      emitDock(ans, curState);
    }
    /* a refresh() resolves with the answer it asked for — an answer for another pane settles nothing */
    function settleWaiters(ans) {
      if (!waiters.length) return;
      var keep = [];
      for (var i = 0; i < waiters.length; i++) {
        if (waiters[i].pane === ans.pane_id) { try { waiters[i].resolve(ans); } catch (e) { /* a dead waiter */ } }
        else keep.push(waiters[i]);
      }
      waiters = keep;
    }

    /* the one-line summary for the header chip W2 feeds from this module (§12.2.2). Structured
       fields, not a recomposition: a consumer picks what its own shape shows. */
    function summarize(ans) {
      var b = (ans && ans.body) || null;
      var out = {
        pane_id: (ans && ans.pane_id) || null, family: b ? txt(b.family) || 'other' : null,
        shape: null, model: null, approx: false, percent: null, tokens: null,
        used_tokens: null, limit_tokens: null, until_auto_compact_pct: null,
        processes: null, text: null, ok: !!(ans && ans.ok),
        error: (ans && ans.error) || null, at: (ans && ans.at) || 0,
        state: null, age_ms: ans ? Math.max(0, clock() - ans.at) : null
      };
      if (b && b.status && typeof b.status === 'object') {
        var st = b.status;
        out.shape = 'hermes';
        out.model = has(st.model) ? txt(st.model) : null;
        out.approx = st.approx === true;
        out.percent = num(st.used_pct);
        out.used_tokens = num(st.used_tokens);
        out.limit_tokens = num(st.limit_tokens);
        out.elapsed_s = num(st.elapsed_s);
        var ps = [];
        if (out.model) ps.push(out.model);
        if (out.used_tokens !== null && out.limit_tokens !== null) ps.push(group(out.used_tokens) + '/' + group(out.limit_tokens));
        if (out.percent !== null) ps.push((out.approx ? '~' : '') + pcts(out.percent));
        out.text = ps.join(' · ');
      } else if (b && b.context && typeof b.context === 'object') {
        var cx = b.context;
        out.shape = 'claude';
        out.model = has(cx.model) ? txt(cx.model) : null;
        out.tokens = num(cx.tokens);
        out.until_auto_compact_pct = num(cx.until_auto_compact_pct);
        var qs = [];
        if (out.model) qs.push(out.model);
        if (out.tokens !== null) qs.push('~' + group(out.tokens) + ' tokens');
        if (out.until_auto_compact_pct !== null) qs.push(pcts(out.until_auto_compact_pct) + ' until auto-compact');
        out.text = qs.join(' · ');
      }
      if (b && b.processes && typeof b.processes === 'object') out.processes = num(b.processes.running);
      out.state = curState;
      return out;
    }
    function emitDock(ans) {
      if (!events || typeof events.emit !== 'function') return;
      try { events.emit('dock', summarize(ans)); } catch (e) { /* a listener must never break the read */ }
    }

    /* ── the tree ── */

    function familyOf(body) {
      if (!body) return 'none';
      var f = txt(body.family);
      return (f === 'hermes' || f === 'claude') ? f : 'other';
    }
    function paneOf(ans) {
      return txt(ans && ans.pane_id) || curPane || selectedPane() || null;
    }

    function paintHead(root, paneId, family) {
      var head = el('div', CLS.head);
      head.appendChild(el('span', CLS.pane, paneId || 'no pane'));
      var f = el('span', CLS.family, family === 'none' ? 'no agent' : family);
      f.setAttribute('data-family', family);
      head.appendChild(f);
      whenEl = el('span', CLS.when, whenText());
      whenEl.setAttribute('data-state', curState);
      head.appendChild(whenEl);
      root.appendChild(head);
      return head;
    }
    function whenText() {
      if (curState === 'failed') {
        return lastGood
          ? 'last read ' + ago(clock() - lastGood.at) + ' · this read failed'
          : 'this read failed · nothing has been read yet';
      }
      if (curState === 'live' && lastGood && lastGood.pane_id === curPane) {
        return 'read ' + ago(clock() - lastGood.at) + ' from the pane\'s own output';
      }
      /* re-reading a pane whose last read we still hold (a dock coming back from collapsed): the
         numbers on screen are the previous read, and the head says so */
      if (curState === 'reading' && lastGood && lastGood.pane_id === curPane) {
        return 're-reading · last read ' + ago(clock() - lastGood.at) + ' · not current';
      }
      return 'reading the pane’s own output…';
    }
    /* a node whose whole text is an age. Ages are the one thing that changes with the clock and
       nothing else, so they are rewritten by the 1 s label tick — never by a request. A sentence that
       says "last successful read 12s ago" while the clock has moved a minute on would be a number
       presented as current that is not. */
    var ageNodes = [];
    function liveAge(parent, cls, make) {
      var n = el('div', cls, make());
      ageNodes.push({ el: n, make: make });
      parent.appendChild(n);
      return n;
    }
    /* the 1 s label tick: it rewrites text nodes and never touches the network */
    function tickLabels() {
      if (unmounted || !host) return;
      if (checkPause()) return;                     // no label tick for a panel nobody can read
      if (whenEl) {
        var t = whenText();
        if (whenEl.textContent !== t) whenEl.textContent = t;
      }
      for (var i = 0; i < ageNodes.length; i++) {
        try {
          var s = ageNodes[i].make();
          if (ageNodes[i].el.textContent !== s) ageNodes[i].el.textContent = s;
        } catch (e) { /* a dead node */ }
      }
    }

    function renderUsage(body) {
      var family = familyOf(body);
      var s = section('usage', 'usage');
      var st = (body && body.status && typeof body.status === 'object') ? body.status : null;
      var cx = (body && body.context && typeof body.context === 'object') ? body.context : null;
      var row;

      /* hermes: the ONLY family that prints used/limit, a percentage and a bar — one row, in the
         order the agent prints them, and only ever when the response carries a hermes status */
      if (family === 'hermes' && st) {
        row = el('div', CLS.usage);
        row.setAttribute('data-shape', 'hermes');
        var line = el('div', CLS.hermes);
        var modelOk = has(st.model);
        fig(line, 'model', modelOk ? txt(st.model) : 'model not printed',
          { missing: !modelOk, title: modelOk ? 'the model name the agent printed' : 'the response carried no model name' });
        var usedN = num(st.used_tokens), limN = num(st.limit_tokens);
        var pairOk = usedN !== null && limN !== null;
        fig(line, 'used',
          pairOk ? group(usedN) + ' / ' + group(limN) + ' tokens'
            : (usedN === null ? 'used unknown' : group(usedN)) + ' / ' + (limN === null ? 'limit unknown' : group(limN) + ' tokens') + (pairOk ? '' : ' (partial)'),
          { missing: !pairOk, title: 'the token counts as the response reports them — not recomputed from the percentage' });
        var pN = num(st.used_pct);
        var bar = el('div', CLS.bar);
        bar.setAttribute('aria-hidden', 'true');           // the percentage is text, right beside it
        if (pN === null) {
          bar.setAttribute('data-pct', 'none');
        } else {
          bar.setAttribute('data-pct', String(pN));
          var fill = el('div', CLS.barFill);
          /* the DRAWN width is the response's percentage clamped to the track; the number shown is
             the response's percentage untouched */
          var w = Math.max(0, Math.min(100, pN));
          if (fill.style) fill.style.width = w + '%';
          fill.setAttribute('data-fill', String(pN));
          bar.appendChild(fill);
        }
        line.appendChild(bar);
        fig(line, 'pct', pN === null ? 'no percentage printed' : (st.approx === true ? '~' : '') + pcts(pN),
          { missing: pN === null, title: pN === null ? 'the response carried no used_pct' : 'the percentage the agent printed' });
        if (st.approx === true) {
          var ap = el('span', CLS.approx, 'approx');
          ap.title = 'the agent wrote ~ before this figure — the number is the agent’s own approximation';
          line.appendChild(ap);
        }
        var elS = secs(st.elapsed_s);
        fig(line, 'elapsed', elS === null ? 'elapsed not printed' : elS,
          { missing: elS === null, title: elS === null ? 'the response carried no elapsed_s' : 'the agent’s own elapsed figure' });
        row.appendChild(line);
        note(row, 'hermes-source', 'hermes’ own status line: the model, the tokens it counted, the percentage and the bar it printed');
        if (pN === null) emptyInto(row, 'no-pct', 'the agent printed no percentage — no bar is drawn');
        s.appendChild(row);
        return s;
      }

      /* claude: no limit and no bar exist anywhere for it (§12.0) — so the shape is stacked lines
         with the context computed from claude's own jsonl, never hermes' row */
      if (family === 'claude' && cx) {
        row = el('div', CLS.usage);
        row.setAttribute('data-shape', 'claude');
        var line2 = el('div', CLS.claude);
        var mOk = has(cx.model);
        fig(line2, 'model', mOk ? txt(cx.model) : 'model not printed',
          { missing: !mOk, title: mOk ? 'the model name the server read from claude’s records' : 'the response carried no model name' });
        var tN = num(cx.tokens);
        fig(line2, 'context', tN === null ? 'context size unknown' : 'context ~' + group(tN) + ' tokens',
          { missing: tN === null, title: 'computed by the server from the last assistant record in claude’s jsonl — claude itself prints no context figure' });
        var bd = (cx.breakdown && typeof cx.breakdown === 'object') ? cx.breakdown : null;
        var parts = [];
        var names = [['input', 'input'], ['cache_read', 'cache read'], ['cache_create', 'cache create'], ['output', 'output']];
        for (var i = 0; i < names.length; i++) {
          var v = bd ? num(bd[names[i][0]]) : null;
          parts.push(names[i][1] + ' ' + (v === null ? 'unknown' : group(v)));
        }
        var bdEl = el('div', CLS.breakdown, parts.join(' · '));
        if (!bd) bdEl.setAttribute('data-missing', '1');
        line2.appendChild(bdEl);
        var up = num(cx.until_auto_compact_pct);
        if (up === null) {
          emptyInto(row, 'no-until', 'claude’s footer printed no auto-compact figure — the tokens above are all it shows');
        } else {
          fig(line2, 'until', pcts(up) + ' until auto-compact',
            { title: 'claude’s own footer figure — a different denominator from hermes’ used_pct, so the two are never one number' });
        }
        row.appendChild(line2);
        note(row, 'claude-no-limit', 'claude prints no used/limit figure and there is no limit table anywhere — these numbers are not comparable with hermes’');
        var ageS = num(cx.age_s);
        if (ageS !== null) note(row, 'claude-age', 'claude’s own record, ' + secs(ageS) + ' old');
        s.appendChild(row);
        return s;
      }

      /* hermes/claude pane whose own section the response reports as absent, or a third family */
      var why = absentReason(body, 'status') || absentReason(body, 'context');
      var sentence = why || (family === 'other' ? 'this agent prints no usage line' : noStatusSentence(body));
      emptyInto(s, family === 'other' ? 'other-family' : 'no-usage', sentence);
      return s;
    }

    function renderProcesses(body) {
      var s = section('processes', 'background processes');
      var p = (body && body.processes && typeof body.processes === 'object') ? body.processes : null;
      if (!p) {
        emptyInto(s, 'no-list', absentReason(body, 'processes') || 'this agent prints no process list');
        return s;
      }
      var run = num(p.running);
      var head = el('div', CLS.procsHead, run === null
        ? 'the agent reported no count'
        : run + (run === 1 ? ' process running' : ' processes running'));
      if (run === null) head.setAttribute('data-missing', '1');
      s.appendChild(head);
      if (has(p.hint)) {
        /* the agent's own hint, verbatim: it is terminal advice, not something the dock can act on */
        var h = el('div', CLS.hint, txt(p.hint));
        h.setAttribute('data-from', 'agent');
        s.appendChild(h);
      }
      var items = Array.isArray(p.items) ? p.items : [];
      if (!items.length) {
        emptyInto(s, 'no-procs', run === 0
          ? 'the agent lists no background processes (0 running)'
          : 'the agent printed no process lines');
        return s;
      }
      var ul = el('ul', CLS.procList);
      for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        var li = el('li', CLS.proc);
        li.setAttribute('data-idx', String(i));
        var cmdOk = has(it.cmd);
        var cmd = el('div', CLS.procCmd, cmdOk ? txt(it.cmd) : 'command not printed');
        if (!cmdOk) cmd.setAttribute('data-missing', '1');
        if (it.cmd_elided === true) { cmd.setAttribute('data-elided', '1'); cmd.appendChild(elideNote('cmd')); }
        li.appendChild(cmd);
        var ag = secs(it.age_s);
        var ageEl = el('div', CLS.procAge, ag === null ? 'age not printed' : ag);
        if (ag === null) ageEl.setAttribute('data-missing', '1');
        li.appendChild(ageEl);
        var lastOk = has(it.last);
        var lastEl = el('div', CLS.procLast, 'last: ' + (lastOk ? txt(it.last) : 'not printed'));
        if (!lastOk) lastEl.setAttribute('data-missing', '1');
        if (it.last_elided === true) { lastEl.setAttribute('data-elided', '1'); lastEl.appendChild(elideNote('last')); }
        li.appendChild(lastEl);
        ul.appendChild(li);
      }
      s.appendChild(ul);
      return s;
    }

    /* the verbatim lines the numbers above came from — the response's own `source_line`s, one node
       each, `…` as printed. Nothing is composed here: if the response carries no line, the section
       says so instead of reconstructing one. */
    function sourceLines(body) {
      var out = [];
      function add(from, v, elided) {
        if (has(v)) out.push({ from: from, text: txt(v), elided: elided === true });
      }
      if (body && body.status && typeof body.status === 'object') {
        add('status', body.status.source_line, body.status.elided);
      }
      if (body && body.context && typeof body.context === 'object') {
        add('context', body.context.source_line, body.context.elided);
      }
      if (body && body.processes && typeof body.processes === 'object') {
        add('processes', body.processes.source_line, body.processes.elided);
      }
      return out;
    }
    function renderSource(body, paneId) {
      var s = section('source', 'source');
      var lines = sourceLines(body);
      var open = srcOpen[paneId] === true;
      var btn = el('button', CLS.srcHead, srcLabel(open, lines.length));
      btn.type = 'button';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('data-open', open ? '1' : '0');
      btn.title = 'the agent’s own line(s), verbatim — every number above comes from them';
      btn.addEventListener('click', function () { toggleSource(paneId); });
      s.appendChild(btn);
      srcBtn = btn;
      srcPane = paneId;
      if (!lines.length) {
        emptyInto(s, 'no-source', 'the answer carries no verbatim line — the numbers above have no printed source to show');
        return s;
      }
      var box = el('div', CLS.src);
      box.setAttribute('data-lines', String(lines.length));
      for (var i = 0; i < lines.length; i++) {
        var d = el('div', CLS.srcLine, lines[i].text);
        d.setAttribute('data-from', lines[i].from);
        if (lines[i].elided) d.setAttribute('data-elided', '1');
        box.appendChild(d);
      }
      if (!open) { box.setAttribute('hidden', 'hidden'); box.hidden = true; }
      s.appendChild(box);
      srcBox = box;
      return s;
    }
    function srcLabel(open, n) {
      return (open ? 'hide source' : 'show source') + (n ? ' · ' + n + (n === 1 ? ' line' : ' lines') : '');
    }

    /* the sections of one answer, into any container: the live body, and the labelled stale block */
    function paintSections(container, body, paneId) {
      container.appendChild(renderUsage(body));
      container.appendChild(renderProcesses(body));
      container.appendChild(renderSource(body, paneId));
      return container;
    }

    function paintFailed(root, ans) {
      var box = el('div', CLS.stale);
      var err = (ans && ans.error) || null;
      var sentence;
      if (curPane === null && ans && ans.pane_id === null) sentence = 'no pane selected — the dock reads the status of the pane you select';
      else if (!err) sentence = 'reading the status failed';
      else if (err.code === 'no_fetch') sentence = 'this page has no fetch() — the dock cannot read ' + ROUTE;
      else if (err.code === 'timeout') sentence = txt(err.message);
      else if (err.code === 'pane_mismatch') sentence = txt(err.message);
      else sentence = 'reading the status failed — ' + (has(err.code) ? txt(err.code) + ': ' : '') + (has(err.message) ? txt(err.message) : 'no reason given');
      var msg = el('div', CLS.staleMsg, sentence);
      msg.setAttribute('data-code', (err && has(err.code)) ? txt(err.code) : 'unknown');
      box.appendChild(msg);
      /* the age of the LAST SUCCESS, in words, whether or not there is anything to show from it. It
         ages with the clock on the label tick — a frozen "12s ago" beside a live clock is a number
         shown as current that is not. */
      var good = lastGood;
      liveAge(box, CLS.staleNote, function () {
        return good
          ? 'last successful read ' + ago(clock() - good.at) + (good.pane_id ? ' (pane ' + good.pane_id + ')' : '')
          : 'no successful read since this page loaded';
      });
      if (lastGood && lastGood.pane_id === curPane) box.appendChild(staleLastBlock());
      root.appendChild(box);
      return box;
    }

    /* the numbers stay — but only inside a block whose own label says they are not current. Used by a
       failed read and by a re-read of a pane whose previous answer we are still showing. */
    function staleLastBlock() {
      var good = lastGood;
      var lastWrap = el('div', CLS.staleLast);
      lastWrap.setAttribute('data-stale', '1');
      lastWrap.setAttribute('data-pane', txt(good.pane_id));
      var lab = liveAge(lastWrap, CLS.staleNote, function () {
        return 'last good answer · ' + ago(clock() - good.at) + ' · pane ' + txt(good.pane_id) + ' — not current';
      });
      lab.setAttribute('data-stale-label', '1');
      paintSections(lastWrap, good.body, good.pane_id);
      return lastWrap;
    }

    function paint() {
      if (!host) return;
      clear(host);
      whenEl = null;
      ageNodes.length = 0;
      srcBtn = null;
      srcBox = null;
      srcPane = null;
      /* the family word is the answer's own when there is a live answer, and the last good answer's
         while a failure is on screen for that same pane — never a family guessed from the pane id */
      var family = 'none';
      if (curState === 'live') family = familyOf(curBody);
      else if (curState === 'failed' && lastGood && lastGood.pane_id === curPane) family = familyOf(lastGood.body);
      var root = el('div', CLS.dock);
      root.setAttribute('data-state', curState);
      root.setAttribute('data-family', family);
      paintHead(root, curPane, family);
      if (curState === 'failed') {
        paintFailed(root, lastFail && lastFail.pane_id === curPane ? lastFail : { pane_id: curPane, error: null });
      } else if (curState === 'live') {
        var body = el('div', CLS.body);
        paintSections(body, curBody, curPane);
        root.appendChild(body);
      } else {
        /* a re-read of a pane we already have an answer for (the dock just came back): the numbers
           stay on screen, but only under the "not current" label — never as if they were this read's */
        var held = (lastGood && lastGood.pane_id === curPane) ? lastGood : null;
        root.appendChild(el('div', CLS.msg, curPane
          ? (held
            ? 're-reading ' + curPane + ' — the numbers below are the previous read and are not current'
            : 'reading ' + curPane + ' … its status has not been read yet — no numbers are shown from another pane')
          : 'no pane selected — the dock reads the status of the pane you select'));
        if (held) root.appendChild(staleLastBlock());
      }
      host.appendChild(root);
    }

    function renderNothing(sentence) {
      /* the host is there but there is nothing to read: still a sentence, never an empty box */
      clear(host);
      whenEl = null;
      ageNodes.length = 0;
      srcBtn = null;
      srcBox = null;
      srcPane = null;
      var root = el('div', CLS.dock);
      root.setAttribute('data-state', 'reading');
      root.setAttribute('data-family', 'none');
      paintHead(root, selectedPane(), 'none');
      root.appendChild(el('div', CLS.msg, sentence));
      host.appendChild(root);
    }

    /* ── cadence ── */

    /* ONE read for whatever pane is selected now, and nothing else: no timer, no state of the pause
       touched. The body poll() runs once the panel is readable, shared with the two moments that read
       while it is not (§12.2 errata: the mount and a selection change). */
    function readSelected() {
      var id = selectedPane();
      if (!id) { if (curPane !== null || curState !== 'reading') { curPane = null; curBody = null; curState = 'reading'; renderNothing('no pane selected — the dock reads the status of the pane you select'); } return false; }
      if (id !== curPane) {
        /* the selection moved: another pane's numbers must never stand in for this one's */
        curPane = id;
        curBody = null;
        curState = 'reading';
        paint();
      }
      /* one read at a time (§12.3.5: one pane.read per call). A read left over from a pane the user
         has moved away from is dropped, not waited on — its answer could only be another pane's */
      if (req) {
        if (req.pane === id) return true;          // already reading this very pane: not a second read
        req.abandon();
      }
      var t = clock();
      if (lastAsk && lastAsk.pane === id && (t - lastAsk.at) < DEDUP_MS) return true;
      lastAsk = { pane: id, at: t };
      ask(id, onAnswer);
      return true;
    }

    /* §12.2 errata (frozen): the cadence stays PAUSED while the panel is collapsed — but a selection
       change and the mount each make EXACTLY ONE read for the newly selected pane, and then the panel
       is paused again. The chip W2 draws from summarize() is always on screen, so a chip that fell to
       '—' the instant the user selected another pane would defeat the point of the dock's own read.
       One read means one: nothing here starts a timer, and a tick that follows still asks nothing.
       A HIDDEN tab is the one case that reads nothing at all — §3's pause is about work nobody can
       see, the chip included — and the return to the tab is what reads (resume()). */
    function gatherOnce() {
      if (unmounted || !host) return false;
      if (document.hidden) return false;
      return readSelected();
    }

    function poll() {
      if (unmounted || !host) return;
      if (checkPause()) return;                    // the tab is hidden, or the panel is collapsed
      /* the pause lifted while nothing could wake us (no observer in this page): the same treatment
         the observer path gets — the cadence restarts and an answer older than one cadence waits
         under a "not current" label instead of wearing a current face. This tick is then the read. */
      if (pausedFor) resumeFrom(true);
      else pausedFor = null;
      readSelected();
    }

    function start() {
      if (pollTimer) return;
      pollTimer = window.setInterval(poll, POLL_MS);
      if (window.setInterval) labelTimer = window.setInterval(tickLabels, LABEL_TICK_MS);
    }
    function stop() {
      if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
      if (labelTimer) { window.clearInterval(labelTimer); labelTimer = null; }
    }

    /* §12.2 errata: a paused cadence issues no read and runs no label tick. The timers are stood down
       only when something can wake us again — the shell observer for a collapse, the
       `visibilitychange` listener for a hidden tab. With neither, the tick stays and poll() keeps
       returning early: a cadence that stopped and could not restart would be worse than a tick that
       asks nothing. */
    function pause(why) {
      pausedFor = why;
      var wakeable = (why === PAUSED_COLLAPSED)
        ? !!shellWatch
        : (typeof document.addEventListener === 'function');
      if (wakeable) stop();
    }
    /* the panel is readable again. §12.2 errata: read ONCE, at once — never wait for the next tick
       (that would show a number two ticks old for a panel the reader has just opened). */
    function resume() { resumeFrom(false); }
    function resumeFrom(inPoll) {
      /* no reason is re-checked here: the two callers that can arrive while the panel is unreadable —
         a `visibilitychange` and the shell's observer — already ask, and the tick itself asks in
         poll(). One place decides (checkPause), so a line here that could never be observed would
         just be a line nothing tests. */
      if (unmounted || !host) return;
      pausedFor = null;
      start();
      var id = selectedPane();
      if (!id) { if (!inPoll) poll(); return; }
      /* an answer older than one cadence must not wear a current face while the new read is in flight.
         The reading branch keeps the old numbers, but only under a label that says they are not
         current — the same block a failed read uses. */
      if (curState === 'live' &&
          (!lastGood || lastGood.pane_id !== id || (clock() - lastGood.at) > RESUMED_MAX_AGE_MS)) {
        curState = 'reading';
        paint();
      }
      lastAsk = null;                              // the dedup window must not swallow the reopening's read
      if (!inPoll) poll();
    }

    /* ── mount / handle ── */

    var offSelect = null;
    var offVis = null;
    /* the source control of the tree currently on screen: flipping these two in place is what keeps a
       toggle from throwing away the button under the user's finger */
    var srcBtn = null;
    var srcBox = null;
    var srcPane = null;

    function mountHost(h) {
      host = h;
      hostReason = '';
      mountedAt = clock();
      ensureCss();
      var id = selectedPane();
      curPane = id;
      curBody = null;
      curState = 'reading';
      /* the watch comes FIRST: a page that loads with the dock already collapsed (§12.2.1 — the
         default is closed) must not have its first poll fail to stand the timers down */
      watchShell();
      if (id) {
        /* the panel exists from the first instant, before any answer: a panel that is blank while it
           waits — and, if the first answer is refused, blank for good — would be the empty box §12.2.4
           forbids. poll() cannot be relied on to paint this: it only paints when the pane CHANGES. */
        paint();
        lastAsk = { pane: id, at: clock() - DEDUP_MS - 1 };
        /* §12.2 errata: the mount reads ONCE for the pane the page opened on, closed panel or not —
           the chip has to have an answer for it without anyone opening the dock first */
        if (checkPause()) gatherOnce(); else poll();
      } else renderNothing('no pane selected — the dock reads the status of the pane you select');
      /* a dock that mounts into an already-closed panel starts no timer at all (§12.2 errata) */
      if (!pausedFor) start();
    }

    function mount() {
      var h = findHost();
      if (!h) {
        /* W2 has not put the shell element in the page: mount NOTHING (no DOM, no timer, no
           request) and keep the API alive so the caller can ask why */
        host = null;
        hostReason = '#' + HOST_ID + ' is not in this page — the dock mounted nothing (CONTRACT-v2 §12.2.1: W2 adds the shell element)';
      } else if (!host) {
        mountHost(h);
      }
      if (offSelect === null && events && typeof events.on === 'function') {
        offSelect = events.on('select', function () {
          if (unmounted) return;
          /* §12.2 errata: a selection change reads ONCE even with the panel collapsed, because the chip
             it feeds stays on screen — and it leaves the cadence exactly as paused as it found it.
             With the panel readable this is the ordinary poll (which also paints the reading state). */
          if (pauseReason() === PAUSED_COLLAPSED) { gatherOnce(); return; }
          var id = selectedPane();
          if (id && id === curPane && curState !== 'reading') { poll(); return; }
          poll();                                  // poll() paints the reading state for the new pane
        });
      }
      if (offVis === null && typeof document.addEventListener === 'function') {
        /* the handler is kept BY NAME: addEventListener returns nothing, so the only way to take this
           listener off again in unmount() is to hold the function itself */
        offVis = function () {
          /* the cadence pauses while hidden; coming back reads once, at once, so the dock is not
             showing a number that is two ticks old. A panel that is ALSO collapsed stays paused through
             the return — but the return is still one of the moments that reads once for the chip
             (§12.2 errata), and resume() has already settled the pause by the time gatherOnce() looks. */
          if (document.hidden) return;
          resume();
          if (pausedFor === PAUSED_COLLAPSED) gatherOnce();
        };
        document.addEventListener('visibilitychange', offVis);
      }
      return handle;
    }

    function toggleSource(paneId) {
      var id = paneId || curPane;
      if (!id) return false;
      srcOpen[id] = srcOpen[id] !== true;
      var open = srcOpen[id] === true;
      /* the two nodes are FLIPPED in place, not repainted: a repaint would destroy the very button the
         user just pressed, which drops keyboard focus and makes a second Enter go nowhere. Nothing but
         these two nodes changes on a toggle, so nothing else needs rebuilding. */
      if (srcBtn && srcBox && srcPane === id) {
        var n = num(srcBox.getAttribute('data-lines')) || 0;
        srcBtn.textContent = srcLabel(open, n);
        srcBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        srcBtn.setAttribute('data-open', open ? '1' : '0');
        if (open) { srcBox.removeAttribute('hidden'); srcBox.hidden = false; }
        else { srcBox.setAttribute('hidden', 'hidden'); srcBox.hidden = true; }
        return true;
      }
      paint();                                     // no live control to flip (no lines, or a stale tree)
      return true;
    }

    function refresh() {
      if (unmounted) {
        return Promise.resolve({ ok: false, pane_id: null, error: { code: 'unmounted', message: 'the dock was unmounted' }, at: clock() });
      }
      if (!host) {
        return Promise.resolve({ ok: false, pane_id: selectedPane(), error: { code: 'no_host', message: hostReason || ('#' + HOST_ID + ' is not in this page') }, at: clock() });
      }
      var id = selectedPane();
      if (!id) {
        curPane = null; curBody = null; curState = 'reading';
        renderNothing('no pane selected — the dock reads the status of the pane you select');
        return Promise.resolve({ ok: false, pane_id: null, error: { code: 'no_pane', message: 'no pane selected — /api/status needs a pane_id' }, at: clock() });
      }
      if (id !== curPane) { curPane = id; curBody = null; curState = 'reading'; paint(); }
      /* an EXPLICIT refresh is the caller asking for a read, wherever the shell happens to be: the
         collapse pause governs the poll (§12.2 errata), not a caller's own request. The timers are
         brought back if the panel is readable, so a caller cannot be left with a dead cadence. */
      if (!pauseReason() && !pollTimer) start();
      lastAsk = { pane: id, at: clock() };
      return new Promise(function (resolve) {
        /* the waiter is keyed on the pane: an answer for some other pane settles nothing here */
        waiters.push({ pane: id, resolve: resolve });
        if (req) { if (req.pane === id) return; req.abandon(); }
        ask(id, onAnswer);
      });
    }

    function unmount() {
      if (unmounted) return false;
      unmounted = true;
      stop();
      if (offSelect) { try { offSelect(); } catch (e) { /* already gone */ } offSelect = null; }
      if (offVis && typeof document.removeEventListener === 'function') {
        try { document.removeEventListener('visibilitychange', offVis); } catch (e) { /* gone */ }
      }
      offVis = null;
      if (shellWatch) { try { shellWatch.disconnect(); } catch (e) { /* gone */ } }
      shellWatch = null;
      shell = null;
      pausedFor = null;
      if (req && req.ctrl && req.ctrl.abort) { try { req.ctrl.abort(); } catch (e) { /* gone */ } }
      req = null;
      if (host) clear(host);
      host = null;
      whenEl = null;
      ageNodes.length = 0;
      srcBtn = null;
      srcBox = null;
      srcPane = null;
      return true;
    }

    function state() {
      return {
        mounted: !!host && !unmounted,
        mounted_at: mountedAt,
        reason: host ? '' : (hostReason || (unmounted ? 'the dock was unmounted' : 'not mounted yet')),
        host_id: HOST_ID,
        pane: curPane,
        data_state: curState,
        family: (curState === 'live') ? familyOf(curBody) : null,
        poll_ms: POLL_MS,
        label_tick_ms: LABEL_TICK_MS,
        req_timeout_ms: REQ_TIMEOUT_MS,
        dedup_ms: DEDUP_MS,
        polling: !!pollTimer,
        label_timer: !!labelTimer,
        /* §12.2 errata, reported by name: what paused the cadence, if anything, and the sentence for
           a reader. `paused` is null while the poll is running. */
        paused: pausedFor,
        paused_reason: pausedSentence(pausedFor),
        shell_id: SHELL_ID,
        shell_present: !!shellEl(),
        collapsed: isCollapsed(),
        shell_watch: !!shellWatch,
        inflight: !!req,
        in_flight_pane: req ? req.pane : null,
        last_ok: lastGood ? { pane_id: lastGood.pane_id, at: lastGood.at } : null,
        last_ask: lastAsk,
        source_open: srcOpen,
        has_answer: !!lastAnswer,
        source: 'GET ' + ROUTE + '?pane_id=<selected pane>'
      };
    }

    function dom() {
      return host ? {
        host: host.id, root: !!host.querySelector ? !!host.querySelector('.' + CLS.dock) : true,
        state: curState
      } : null;
    }

    /* adopt(): look for the shell element again — the module mounted nothing because W2 had not put
       #dockHost in the page yet, and this is how the caller says "now it is there" */
    function adopt() {
      if (unmounted) return false;
      if (host) return true;
      var h = findHost();
      if (!h) { hostReason = '#' + HOST_ID + ' is still not in this page — the dock mounts nothing'; return false; }
      mountHost(h);
      return true;
    }

    var handle = {
      id: ID,
      mount: mount,
      latest: function () { return lastAnswer; },
      refresh: refresh,
      unmount: unmount,
      mounted: function () { return !!host && !unmounted; },
      state: state,
      dom: dom,
      adopt: adopt,
      toggleSource: toggleSource,
      /* test seams: the clock the ages are computed with, and the read itself (the shim suite
         drives one answer through the very same onAnswer the network path calls) */
      __setClock: function (fn) { if (typeof fn === 'function') clock = fn; return true; },
      __answer: function (ans) { onAnswer(ans); return true; },
      __poll: function () { poll(); return true; },
      __ask: function (paneId, cb) { ask(paneId, cb); return true; },
      __summarize: function (ans) { return summarize(ans); }
    };
    return handle;
  }

  /* ── registration (the §3 pattern every module file follows) ── */

  var instance = null;
  var mod = {
    id: ID,
    title: TITLE,
    mount: function (ctx) {
      /* idempotent: a second mount() on a live instance returns the very same handle — two instances
         would poll the same pane twice into the same host */
      if (instance && instance.mounted()) return instance;
      if (!instance) instance = createDock(ctx || (HD.ctx || {}));
      else instance.__ctx = ctx;
      return instance.mount();
    }
  };

  var HDx = (window.HD = window.HD || {});
  HDx.modules = HDx.modules || {};
  HDx.modules[ID] = mod;
  HDx.pending = HDx.pending || [];
  if (HDx.pending.indexOf(mod) < 0) HDx.pending.push(mod);
  if (typeof HDx.register === 'function') {
    try { HDx.register(mod); } catch (e) { /* the integrator reports it */ }
  } else {
    scheduleRegister(mod);
  }
  window.HD.dock = mod;

  /* the seams a test (or the console) uses: the handle the page mounted, without guessing at
     window.HD.dock's shape */
  window.HD.dockTest = {
    mount: function (ctx) { return mod.mount(ctx); },
    instance: function () { return instance; },
    latest: function () { return instance ? instance.latest() : null; },
    refresh: function () { return instance ? instance.refresh() : Promise.resolve(null); },
    unmount: function () { return instance ? instance.unmount() : false; },
    state: function () { return instance ? instance.state() : null; },
    dom: function () { return instance ? instance.dom() : null; },
    adopt: function () { return instance ? instance.adopt() : false; },
    toggleSource: function (id) { return instance ? instance.toggleSource(id) : false; },
    setClock: function (fn) { return instance ? instance.__setClock(fn) : false; },
    answer: function (ans) { return instance ? instance.__answer(ans) : false; },
    poll: function () { return instance ? instance.__poll() : false; },
    summarize: function (ans) { return instance ? instance.__summarize(ans) : null; },
    pollMs: function () { return POLL_MS; },
    labelTickMs: function () { return LABEL_TICK_MS; },
    reqTimeoutMs: function () { return REQ_TIMEOUT_MS; },
    dedupMs: function () { return DEDUP_MS; },
    hostId: function () { return HOST_ID; },
    route: function () { return ROUTE; },
    classes: function () { return CLS; }
  };

  function scheduleRegister(m) {
    if (typeof document === 'undefined' || !document) return;
    var done = false;
    var tryNow = function () {
      if (done) return;
      var H = window.HD;
      if (H && typeof H.register === 'function') {
        done = true;
        try { H.register(m); } catch (e) { /* integrator's problem */ }
      }
    };
    if (typeof document.addEventListener === 'function') document.addEventListener('DOMContentLoaded', tryNow, { once: true });
    if (typeof window.addEventListener === 'function') window.addEventListener('load', tryNow, { once: true });
    var tries = 0;
    var t = window.setInterval(function () {
      if (done || ++tries > 100) { window.clearInterval(t); return; }
      tryNow();
    }, 100);
  }
})();
