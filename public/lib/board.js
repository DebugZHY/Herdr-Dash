/* herdr-dash — board.js · fleet board overlay over every pane (owner: W3)
 *
 * CONTRACT-v2 §3 module: classic script, ends with window.HD.register({id,title,mount}).
 * CONTRACT-v2 §4.7: table of workspace/tab/pane/agent/status chip/cwd/time-in-status/
 * last non-empty output line; sorted by status rank then workspace; row click selects
 * the pane; `working` rows pulse; refreshes from snapshot+status events, no polling
 * faster than 2 s.
 *
 * Time-in-status is DERIVED, never invented: we only know a duration from the moment we
 * first observed that status in this session. Statuses first seen at mount are marked
 * with a leading '~' ("at least this long"), statuses we watched change are exact.
 */
(function () {
  'use strict';

  var HD = (window.HD = window.HD || {});
  var ID = 'board';
  var TITLE = 'Fleet board';
  var ENRICH_MS = 2500;   // §4.7: no polling faster than 2 s
  var TICK_MS = 1000;     // UI clock only (re-renders time cells, no network)
  var MAX_FETCH_INFLIGHT = 4;

  // Attention-first rank: what a PM watching several agents must see at the top.
  // block/red first (needs a decision), then done (needs review), then in-flight,
  // then idle, then unknown. ctx.util.statusRank overrides this when it is a function.
  var FALLBACK_RANK = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };
  var STATUSES = ['blocked', 'done', 'working', 'idle', 'unknown'];

  // ── pure helpers (exported for the DOM-free test) ──────────────────────────

  function statusOf(rec) {
    var s = rec && (rec.agent_status || rec.status);
    s = s ? String(s).toLowerCase() : 'unknown';
    return STATUSES.indexOf(s) >= 0 ? s : 'unknown';
  }

  function makeRankFn(rankFn) {
    if (typeof rankFn === 'function') {
      return function (s) {
        var r;
        try { r = rankFn(s); } catch (e) { r = undefined; }
        return typeof r === 'number' && isFinite(r) ? r : rank(s);
      };
    }
    return rank;
  }
  function rank(s) {
    var r = FALLBACK_RANK[String(s || '').toLowerCase()];
    return typeof r === 'number' ? r : 9;
  }

  /** 0 -> '0s', 90000 -> '1m 30s', 3930000 -> '1h 05m' */
  function fmtDur(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var s = total % 60, m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
    if (h > 0) return h + 'h ' + (m < 10 ? '0' + m : m) + 'm';
    if (Math.floor(total / 60) > 0) return Math.floor(total / 60) + 'm ' + (s < 10 ? '0' + s : s) + 's';
    return s + 's';
  }

  /** Last non-empty line of a transcript buffer. */
  function lastNonEmpty(lines) {
    if (!lines || !lines.length) return '';
    for (var i = lines.length - 1; i >= 0; i--) {
      var t = lines[i];
      if (t != null && String(t).trim() !== '') return String(t);
    }
    return '';
  }

  /** Normalise the many shapes a 'status' event payload may arrive in. */
  function normStatusEvent(p) {
    if (!p) return [];
    if (Array.isArray(p)) {
      var out = [];
      for (var i = 0; i < p.length; i++) {
        var one = normOne(p[i]);
        if (one) out.push(one);
      }
      return out;
    }
    var single = normOne(p);
    return single ? [single] : [];
  }
  function normOne(p) {
    if (!p || typeof p !== 'object') return null;
    var d = (p.data && typeof p.data === 'object') ? p.data : p;   // raw SSE envelope or flat
    var pane = d.pane_id || d.paneId || p.pane_id || p.paneId;
    var st = d.agent_status || d.status || p.agent_status || p.status;
    if (!pane || !st) return null;
    return { paneId: String(pane), status: statusOf({ agent_status: st }), agent: d.agent || p.agent || null };
  }

  /** Sort rows: rank first, then workspace label, then pane id (contract order). */
  function sortRows(rows, key, dir, rankFn) {
    var rk = makeRankFn(rankFn);
    var copy = rows.slice();
    copy.sort(function (a, b) {
      if (!key || key === 'rank') {
        // canonical contract order — direction is not user-toggled
        return rk(a.status) - rk(b.status) || cmp(a.workspaceLabel, b.workspaceLabel) || cmp(a.paneId, b.paneId);
      }
      if (key === 'time') {
        return ((b.statusSinceMs || 0) - (a.statusSinceMs || 0)) || cmp(a.paneId, b.paneId);  // longest first
      }
      return cmp(sortKeyOf(a, key), sortKeyOf(b, key)) || cmp(a.paneId, b.paneId);
    });
    if (dir === 'desc' && key && key !== 'rank') copy.reverse();
    return copy;
  }
  function sortKeyOf(r, key) {
    if (key === 'agent') return r.agent || '';
    if (key === 'cwd') return r.cwd || '';
    if (key === 'status') return r.status || '';
    if (key === 'workspace') return r.workspaceLabel || '';
    if (key === 'tab') return r.tabLabel || '';
    if (key === 'last') return r.lastLine || '';
    return '';
  }
  function cmp(a, b) {
    a = a == null ? '' : String(a); b = b == null ? '' : String(b);
    var al = a.toLowerCase(), bl = b.toLowerCase();
    return al < bl ? -1 : al > bl ? 1 : 0;
  }

  var BAR_MAX_PANE_MSG = 3;   // how many failed panes the bar names before it states the total

  /**
   * §7.5 DEFECT-7: what the message bar shows. A per-pane read failure belongs to its pane —
   * another pane's success must not sweep it — so the bar is composed from one global slot plus
   * one slot per failing pane (newest first), instead of a single string any writer could clear.
   * Pure so _scratch/w3/logic.mjs can hold it to the three rules; `order` is oldest -> newest.
   */
  function barText(global, order, paneErr) {
    var parts = [];
    var head = global == null ? '' : String(global);
    if (head) parts.push(head);              // the global slot is never hidden by a pane message
    var list = order || [];
    var ids = [];
    for (var i = 0; i < list.length; i++) {
      var id = list[i];
      if (paneErr && Object.prototype.hasOwnProperty.call(paneErr, id) && paneErr[id]) ids.push(id);
    }
    var shown = [];
    for (var j = ids.length - 1; j >= 0 && shown.length < BAR_MAX_PANE_MSG; j--) shown.push(String(paneErr[ids[j]]));
    if (shown.length) {
      var group = shown.join(' · ');
      // Past the cap the bar names the newest few and states the TRUE total, so "how many panes
      // are broken" is always answerable even when a name has to be left out. (Newest first is
      // the same instinct as "a newer message beats an older one".)
      if (ids.length > BAR_MAX_PANE_MSG) group = ids.length + ' panes failed: ' + group;
      parts.push(group);
    }
    return parts.join(' · ');
  }

  function testApi() {
    return { fmtDur: fmtDur, rank: rank, statusOf: statusOf, sortRows: sortRows,
             lastNonEmpty: lastNonEmpty, normStatusEvent: normStatusEvent,
             barText: barText, BAR_MAX_PANE_MSG: BAR_MAX_PANE_MSG };
  }

  // ── module ─────────────────────────────────────────────────────────────────

  function mount(ctx) {
    if (!ctx || !ctx.events) return null;
    var rankFn = ctx.util && ctx.util.statusRank;
    var cleanupFns = [];   // unmount hooks; declared before any wiring that pushes to it
    var cursor = -1;       // j/k highlight index inside the board

    var root = document.createElement('div');
    root.className = 'hd-board';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', TITLE);
    root.hidden = true;

    var head = document.createElement('div');
    head.className = 'hd-board-head';
    var h = document.createElement('span');
    h.className = 'hd-mod-title';
    h.textContent = TITLE;
    var count = document.createElement('span');
    count.className = 'hd-board-count small dim';
    var hint = document.createElement('span');
    hint.className = 'hd-board-hint small dim';
    hint.textContent = 'status rank order · click a row to open that pane · Esc closes';
    var refresh = document.createElement('button');
    refresh.className = 'btn small';
    refresh.type = 'button';
    refresh.textContent = 'refresh';
    var close = document.createElement('button');
    close.className = 'icon-btn';
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'close (Esc)';
    head.appendChild(h); head.appendChild(count); head.appendChild(hint);
    head.appendChild(refresh); head.appendChild(close);

    var errBar = document.createElement('div');
    errBar.className = 'err hd-board-err';
    errBar.hidden = true;

    var wrap = document.createElement('div');
    wrap.className = 'hd-board-wrap';
    var table = document.createElement('table');
    table.className = 'hd-board-table';
    var thead = document.createElement('thead');
    var tbody = document.createElement('tbody');
    table.appendChild(thead); table.appendChild(tbody);
    wrap.appendChild(table);

    var COLS = [
      { key: 'workspace', label: 'workspace' },
      { key: 'tab', label: 'tab' },
      { key: 'pane', label: 'pane' },
      { key: 'agent', label: 'agent' },
      { key: 'status', label: 'status' },
      { key: 'cwd', label: 'cwd' },
      { key: 'time', label: 'in status' },
      { key: 'last', label: 'last output' },
    ];
    var sortKey = 'rank', sortDir = 'asc';
    var headCells = [];
    var tr = document.createElement('tr');
    for (var c = 0; c < COLS.length; c++) {
      (function (col) {
        var th = document.createElement('th');
        th.textContent = col.label;
        th.title = 'sort by ' + col.label;
        th.addEventListener('click', function () {
          if (sortKey === col.key || (sortKey === 'rank' && col.key === 'status')) {
            sortDir = sortDir === 'asc' ? 'desc' : 'asc';
          } else { sortKey = col.key; sortDir = 'asc'; }
          render();
        });
        headCells.push({ th: th, col: col });
        tr.appendChild(th);
      })(COLS[c]);
    }
    thead.appendChild(tr);

    root.appendChild(head); root.appendChild(errBar); root.appendChild(wrap);

    var state = {
      open: false,
      since: {},        // paneId -> ms timestamp we first observed the current status
      observed: {},     // paneId -> true when the timestamp is only an upper bound (mount/refresh)
      observedAt: {},   // paneId -> status we recorded that timestamp for
      lastLine: {},     // paneId -> last non-empty output line we have seen
      status: {},       // paneId -> last status we knew
      lastFetch: {},    // paneId -> ms of the enrichment read
      fetchedStatus: {},// paneId -> status we fetched the text for
      inflight: 0,
      err: '',
      rowEls: {},       // paneId -> {time: td}
      busy: false,
    };

    // ── the message bar: one global slot + one slot per failing pane (§7.5 DEFECT-7) ─────────
    // Read failures used to share a single string, so a pane that read fine cleared a neighbour's
    // failure before anyone could read it, and the bar no longer said WHICH pane broke. Now a
    // per-pane message is only ever cleared by that pane's own later success.
    var globalErr = '';
    var paneErr = {};          // paneId -> message
    var paneErrOrder = [];     // pane ids in the order they failed (oldest first)

    function showErr(msg) {                     // the global slot (clicks, subscriptions, gestures)
      globalErr = msg || '';
      paintErr();
    }
    /** Set (msg) or clear ('') ONE pane's message; nothing else on the bar is touched. */
    function showPaneErr(paneId, msg) {
      var id = paneId == null ? '' : String(paneId);
      if (!id) return;
      var known = Object.prototype.hasOwnProperty.call(paneErr, id);
      if (msg) {
        if (!known) paneErrOrder.push(id);
        paneErr[id] = String(msg);
      } else {
        if (!known) return;                   // nothing of this pane's to clear: leave the rest alone
        delete paneErr[id];
        var at = paneErrOrder.indexOf(id);
        if (at >= 0) paneErrOrder.splice(at, 1);
      }
      paintErr();
    }
    /** A pane that left the workspace takes its message with it (called from enrich). */
    function prunePaneErr(rows) {
      if (!paneErrOrder.length) return;
      var live = {};
      for (var i = 0; i < rows.length; i++) live[rows[i].paneId] = true;
      var gone = paneErrOrder.filter(function (id) { return !live[id]; });
      for (var j = 0; j < gone.length; j++) {
        delete paneErr[gone[j]];
        var at = paneErrOrder.indexOf(gone[j]);
        if (at >= 0) paneErrOrder.splice(at, 1);
      }
      if (gone.length) paintErr();
    }
    function paintErr() {
      var shown = barText(globalErr, paneErrOrder, paneErr);
      state.err = shown;
      if (errBar.textContent !== shown) errBar.textContent = shown;
      var hidden = !shown;
      if (errBar.hidden !== hidden) errBar.hidden = hidden;
    }

    // ── data assembly ────────────────────────────────────────────────────────

    function snapshotObj() {
      var s = ctx.state && ctx.state.snapshot;
      if (!s) return null;
      if (s.snapshot && s.snapshot.panes) return s.snapshot;
      if (Array.isArray(s.panes)) return s;
      return null;
    }
    function panesList() {
      try {
        if (ctx.state && typeof ctx.state.panes === 'function') {
          var a = ctx.state.panes();
          if (Array.isArray(a) && a.length) return a;
        }
      } catch (e) { /* fall through to the raw snapshot */ }
      var snap = snapshotObj();
      return (snap && Array.isArray(snap.panes)) ? snap.panes : [];
    }
    function labelMaps() {
      var snap = snapshotObj() || {};
      var ws = {}, tb = {};
      var i;
      var W = Array.isArray(snap.workspaces) ? snap.workspaces : [];
      var T = Array.isArray(snap.tabs) ? snap.tabs : [];
      for (i = 0; i < W.length; i++) {
        var w = W[i] || {};
        ws[w.workspace_id] = w.label || ('#' + (w.number != null ? w.number : w.workspace_id));
      }
      for (i = 0; i < T.length; i++) {
        var t = T[i] || {};
        tb[t.tab_id] = t.label || ('tab ' + (t.number != null ? t.number : t.tab_id));
      }
      return { ws: ws, tb: tb };
    }
    function bufferOf(paneId) {
      try {
        if (ctx.state && typeof ctx.state.buffer === 'function') return ctx.state.buffer(paneId);
      } catch (e) { /* no buffer yet */ }
      return null;
    }

    function buildRows() {
      var maps = labelMaps();
      var panes = panesList();
      var now = Date.now();
      var rows = [];
      for (var i = 0; i < panes.length; i++) {
        var p = panes[i] || {};
        var pid = p.pane_id || p.paneId;
        if (!pid) continue;
        pid = String(pid);
        var st = statusOf(p);
        // Transition bookkeeping: a segment starts only on a REAL change.
        if (state.observedAt[pid] !== st || typeof state.since[pid] !== 'number') {
          var known = state.status[pid];
          state.since[pid] = now;
          state.observedAt[pid] = st;
          state.observed[pid] = (known === undefined);  // first sighting = lower bound only
        }
        state.status[pid] = st;

        var bufLine = lastNonEmpty(bufferOf(pid));
        if (bufLine) { state.lastLine[pid] = bufLine; state.fetchedStatus[pid] = st; }

        rows.push({
          paneId: pid,
          workspaceId: p.workspace_id || '',
          workspaceLabel: maps.ws[p.workspace_id] || p.workspace_id || '?',
          tabId: p.tab_id || '',
          tabLabel: maps.tb[p.tab_id] || p.tab_id || '?',
          agent: p.agent || '',
          status: st,
          cwd: p.cwd || '',
          statusSinceMs: now - (state.since[pid] || now),
          approximate: !!state.observed[pid],
          lastLine: state.lastLine[pid] || bufLine || '',
          focused: !!p.focused,
        });
      }
      return rows;
    }

    function render() {
      var rows = sortRows(buildRows(), sortKey, sortDir, rankFn);
      for (var i = 0; i < headCells.length; i++) {
        var hc = headCells[i];
        var active = (hc.col.key === sortKey) || (sortKey === 'rank' && hc.col.key === 'status');
        hc.th.className = active ? 'sorted ' + sortDir : '';
      }
      tbody.textContent = '';
      state.rowEls = {};
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var trr = document.createElement('tr');
        trr.className = 'hd-row st-' + row.status;
        if (row.focused) trr.className += ' focused';
        if (row.status === 'working') trr.className += ' pulse';
        trr.setAttribute('data-pane-id', row.paneId);
        trr.title = 'open ' + row.paneId;
        trr.addEventListener('click', function (pid) {
          return function () {
            try { ctx.ui.selectPane(pid); } catch (e) { showErr('selectPane failed: ' + e.message); }
            hide();
          };
        }(row.paneId));

        trr.appendChild(td(row.workspaceLabel, 'ws'));
        trr.appendChild(td(row.tabLabel, 'tab'));
        trr.appendChild(td(row.paneId, 'pane mono'));

        var ag = document.createElement('td');
        ag.className = 'agent';
        ag.textContent = row.agent || '–';
        trr.appendChild(ag);

        var sc = document.createElement('td');
        sc.className = 'status';
        var chip = document.createElement('span');
        chip.className = 'hd-chip ' + row.status;
        var dot = document.createElement('span');
        dot.className = 'dot ' + row.status;
        var lbl = document.createElement('span');
        lbl.textContent = row.status;
        chip.appendChild(dot); chip.appendChild(lbl);
        sc.appendChild(chip);
        trr.appendChild(sc);

        var cw = td(row.cwd, 'cwd mono');
        cw.title = row.cwd || '';
        trr.appendChild(cw);

        var tm = td('', 'time mono');
        trr.appendChild(tm);

        var lastTd = td(row.lastLine, 'last mono');
        lastTd.title = row.lastLine || '';
        trr.appendChild(lastTd);

        state.rowEls[row.paneId] = { time: tm, row: row };
        tbody.appendChild(trr);
      }
      if (!rows.length) {
        var empty = document.createElement('tr');
        var etd = document.createElement('td');
        etd.colSpan = COLS.length;
        etd.className = 'hd-empty dim';
        etd.textContent = panesList().length ? 'no panes' : 'no snapshot yet — waiting for the server';
        empty.appendChild(etd);
        tbody.appendChild(empty);
      }
      count.textContent = rows.length + ' pane' + (rows.length === 1 ? '' : 's') + (state.err ? ' · error' : '');
      tick();
    }

    function td(text, cls) {
      var el = document.createElement('td');
      if (cls) el.className = cls;
      el.textContent = text == null ? '' : String(text);
      return el;
    }

    /** Update only the time cells — called every second, no DOM rebuild. */
    function tick() {
      var now = Date.now();
      for (var pid in state.rowEls) {
        if (!Object.prototype.hasOwnProperty.call(state.rowEls, pid)) continue;
        var e = state.rowEls[pid];
        var row = e.row;
        var since = state.since[pid];
        if (typeof since !== 'number') since = now;
        var txt = (state.observed[pid] ? '~' : '') + fmtDur(now - since);
        if (e.time.textContent !== txt) e.time.textContent = txt;
        e.time.title = state.observed[pid]
          ? 'observed ' + txt + ' ago (first seen at mount; herdr gives no history)'
          : 'measured from the status change we received';
      }
    }

    // ── slow enrichment: the "last output line" column ───────────────────────
    // Panes we have never shown have no client buffer, so the column would be empty.
    // §4.7 allows refreshing from the snapshot, and forbids polling faster than 2 s —
    // this pass runs on that budget and only touches panes whose line is missing or
    // whose status changed since we last read them.
    function enrich() {
      if (!state.open || state.inflight >= MAX_FETCH_INFLIGHT) return;
      if (!ctx.api || typeof ctx.api.pane !== 'function') return;
      var now = Date.now();
      var rows = buildRows();
      prunePaneErr(rows);                  // a pane that left the tabs takes its message with it
      var need = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var stale = (state.fetchedStatus[r.paneId] !== r.status);
        var blank = !r.lastLine;
        if ((blank || stale) && (now - (state.lastFetch[r.paneId] || 0)) > ENRICH_MS) need.push(r.paneId);
      }
      need.sort();
      for (var j = 0; j < need.length && state.inflight < MAX_FETCH_INFLIGHT; j++) {
        fetchLine(need[j]);
      }
    }
    function fetchLine(paneId) {
      state.inflight++;
      state.lastFetch[paneId] = Date.now();
      var st = state.status[paneId];
      Promise.resolve()
        .then(function () { return ctx.api.pane(paneId, 40); })
        .then(function (res) {
          if (!res || res.ok === false) {
            if (res && res.error) showPaneErr(paneId, 'pane ' + paneId + ': ' + (res.error.message || res.error.code));
            return;
          }
          var text = typeof res.text === 'string' ? res.text : '';
          var line = lastNonEmpty(text.split(/\r?\n/));
          if (line) state.lastLine[paneId] = line;
          state.fetchedStatus[paneId] = st;
          showPaneErr(paneId, '');            // THIS pane reads fine now — only its own message goes
          if (state.open) render();
        })
        .catch(function (e) { showPaneErr(paneId, 'pane ' + paneId + ' read failed: ' + (e && e.message ? e.message : e)); })
        .then(function () { state.inflight--; });
    }

    // ── visibility ───────────────────────────────────────────────────────────

    function show() {
      if (state.open) return;
      state.open = true;
      root.hidden = false;
      showErr('');
      render();
      enrich();
      startTimers();
    }
    function hide() {
      if (!state.open) return;
      state.open = false;
      root.hidden = true;
      stopTimers();
    }
    function toggle() { state.open ? hide() : show(); }

    var tickTimer = null, enrichTimer = null;
    function startTimers() {
      stopTimers();
      tickTimer = setInterval(tick, TICK_MS);          // local clock, no network
      enrichTimer = setInterval(enrich, ENRICH_MS);    // network, >= 2 s per §4.7
    }
    function stopTimers() {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      if (enrichTimer) { clearInterval(enrichTimer); enrichTimer = null; }
    }

    // ── wiring ───────────────────────────────────────────────────────────────

    var off = [];
    function on(type, fn) {
      try {
        var u = ctx.events.on(type, function (p) { try { fn(p); } catch (e) { showErr(type + ': ' + (e && e.message ? e.message : e)); } });
        if (typeof u === 'function') off.push(u);
      } catch (e) { showErr('subscribe ' + type + ' failed: ' + (e && e.message ? e.message : e)); }
    }

    on('snapshot', function () { if (state.open) { render(); enrich(); } });
    on('status', function (payload) {
      var evs = normStatusEvent(payload);
      for (var i = 0; i < evs.length; i++) {
        var e = evs[i];
        if (state.status[e.paneId] !== e.status) {
          state.since[e.paneId] = Date.now();      // a real transition we witnessed
          state.observed[e.paneId] = false;
          state.observedAt[e.paneId] = e.status;
          state.status[e.paneId] = e.status;
          state.fetchedStatus[e.paneId] = null;    // re-read its last line
        }
      }
      if (state.open) { render(); enrich(); }
    });
    on('buffer', function (payload) {
      var pid = payload && (payload.paneId || payload.pane_id);
      var lines = payload && (payload.lines || payload.buffer);
      if (pid && Array.isArray(lines)) {
        var line = lastNonEmpty(lines);
        if (line) state.lastLine[String(pid)] = line;
      }
      if (state.open) render();
    });
    on('select', function () { if (state.open) render(); });

    // Toggle signals. §3 does not define how the palette invokes a module toggle, so we
    // accept the documented event names AND expose window.HD.board.toggle().
    on('board.toggle', toggle);
    on('module.toggle', function (p) { if (p === ID || (p && p.id === ID)) toggle(); });

    cleanupFns.push(function () {
      try { stopTimers(); } catch (e) { /* ignore */ }
      for (var i = 0; i < off.length; i++) { try { off[i](); } catch (e) { /* ignore */ } }
      off.length = 0;
      if (root.parentNode) root.parentNode.removeChild(root);
    });

    refresh.addEventListener('click', function (e) { e.stopPropagation(); render(); enrich(); showErr(''); });
    close.addEventListener('click', function () { hide(); });
    // Esc closes, but only while this overlay is open, and it must win over W2's keys.js
    // ("Esc sends esc to the pane") — capture phase + stopImmediatePropagation.
    document.addEventListener('keydown', function (e) {
      if (!state.open) return;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation();
        hide();
        return;
      }
      // Light navigation inside the board: j/k move a highlighted row, Enter opens it.
      var t = e.target;
      var tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      if (e.key === 'j' || e.key === 'k' || e.key === 'Enter') {
        e.preventDefault(); e.stopImmediatePropagation();
        moveCursor(e.key === 'j' ? 1 : e.key === 'k' ? -1 : 0);
      }
    }, true);

    function moveCursor(delta) {
      var trs = tbody.querySelectorAll('tr.hd-row');
      if (!trs.length) return;
      if (delta === 0) {
        if (cursor >= 0 && cursor < trs.length) trs[cursor].click();
        return;
      }
      cursor = Math.max(0, Math.min(trs.length - 1, cursor < 0 ? 0 : cursor + delta));
      for (var i = 0; i < trs.length; i++) trs[i].classList.toggle('cursor', i === cursor);
      trs[cursor].scrollIntoView({ block: 'nearest' });
    }

    // §3: every shortcut must reach W2's `?` help overlay.
    registerKeys(ctx, ID, [
      ['Esc', 'board: close'],
      ['j / k', 'board: move down / up the list'],
      ['Enter', 'board: open the highlighted pane'],
    ], 'close the fleet board / walk the rows');

    document.body.appendChild(root);

    return {
      show: show,
      hide: hide,
      toggle: toggle,
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

  // ── registration handshake ───────────────────────────────────────────────────
  // §3 loads lib/*.js BEFORE app.js, so window.HD.register usually does not exist yet.
  // We publish the module object on window.HD.modules (so an integrator can mount it from
  // either side) and retry the real register() once app.js publishes it.
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
        try { HDx.register(mod); } catch (e) { /* integrator's problem, not a crash */ }
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
