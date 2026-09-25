/* herdr-dash — timebar.js · status timeline strip (owner: W3)
 *
 * CONTRACT-v2 §3 module + §4.10: a thin strip under the header with one row per pane in
 * the current tab; segments coloured by status, built from the `status` events of THIS
 * session (transitions recorded with timestamps, cap 200 segments per pane); hover
 * tooltip `status · hh:mm:ss · duration`; labelled "this session only".
 *
 * herdr exposes no status history, so every pixel here is something we watched happen.
 * A pane whose status we only learned at mount starts with one segment marked
 * "observed from here" — its start time is a lower bound, not a real transition.
 */
(function () {
  'use strict';

  var HD = (window.HD = window.HD || {});
  var ID = 'timebar';
  var TITLE = 'Status timeline';
  var CAP = 200;                 // §4.10: max segments per pane
  var TICK_MS = 1000;
  var STATUSES = ['blocked', 'done', 'working', 'idle', 'unknown'];
  var LABEL = 'this session only';

  // ── pure helpers (exported for the DOM-free test) ──────────────────────────

  function statusOf(rec) {
    var s = rec && (rec.agent_status || rec.status);
    s = s ? String(s).toLowerCase() : 'unknown';
    return STATUSES.indexOf(s) >= 0 ? s : 'unknown';
  }

  /**
   * Append a status segment. A segment is only created for a REAL transition — the same
   * status twice in a row leaves the list untouched. Closes the open segment at `ts`.
   * `cap` trims from the front and returns {list, trimmed:boolean}.
   */
  function recordSegment(list, status, ts, cap) {
    cap = cap || CAP;
    list = Array.isArray(list) ? list.slice() : [];
    status = statusOf({ agent_status: status });
    var last = list.length ? list[list.length - 1] : null;
    var trimmed = false;
    if (last && last.status === status && last.to == null) return { list: list, trimmed: false };
    if (last && last.to == null) {
      // close the previous segment on a copy, so the caller's objects are never mutated
      list[list.length - 1] = { status: last.status, from: last.from, to: ts, witnessed: last.witnessed };
    }
    list.push({ status: status, from: ts, to: null, witnessed: true });
    if (list.length > cap) {
      list = list.slice(list.length - cap);
      trimmed = true;
    }
    return { list: list, trimmed: trimmed };
  }

  /** Seed a pane's first observed status: not a witnessed transition. */
  function seedSegment(status, ts) {
    return { status: statusOf({ agent_status: status }), from: ts, to: null, witnessed: false };
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** Local clock hh:mm:ss for a timestamp. */
  function hhmmss(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '--:--:--';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /** Compact duration: 0 -> '0s', 90000 -> '1m 30s', 7500000 -> '2h 05m'. */
  function fmtDur(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) ms = 0;
    var t = Math.floor(ms / 1000);
    var s = t % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
    if (h > 0) return h + 'h ' + pad2(m) + 'm';
    if (Math.floor(t / 60) > 0) return Math.floor(t / 60) + 'm ' + pad2(s) + 's';
    return s + 's';
  }

  /** `status · hh:mm:ss · duration` (§4.10 tooltip). */
  function tooltipText(seg, now) {
    if (!seg) return '';
    var end = typeof seg.to === 'number' ? seg.to : now;
    var dur = (typeof end === 'number' ? end : now) - seg.from;
    var head = seg.status + ' · ' + hhmmss(seg.from) + ' · ' + fmtDur(dur);
    return seg.witnessed === false ? head + ' (observed from here)' : head;
  }

  /**
   * Layout one row into percentages on a SHARED axis so rows line up vertically.
   * Returns [{status, left, width, seg}] with left/width as percentages of [t0,t1].
   */
  function layoutRow(segs, t0, t1) {
    var span = Math.max(1, t1 - t0);
    var out = [];
    for (var i = 0; i < (segs || []).length; i++) {
      var s = segs[i];
      var end = typeof s.to === 'number' ? s.to : t1;
      var a = Math.max(t0, s.from);
      var b = Math.min(t1, end);
      if (b <= a) continue;
      out.push({ status: s.status, left: ((a - t0) / span) * 100, width: ((b - a) / span) * 100, seg: s });
    }
    return out;
  }

  /** Shared time axis across all rows: earliest segment start -> now. */
  function axisBounds(rowsByPane, now) {
    var t0 = null;
    for (var pid in rowsByPane) {
      if (!Object.prototype.hasOwnProperty.call(rowsByPane, pid)) continue;
      var list = rowsByPane[pid] || [];
      for (var i = 0; i < list.length; i++) {
        if (t0 == null || list[i].from < t0) t0 = list[i].from;
      }
    }
    if (t0 == null) t0 = now;
    return { t0: t0, t1: Math.max(now, t0 + 1) };
  }

  function testApi() {
    return { recordSegment: recordSegment, seedSegment: seedSegment, tooltipText: tooltipText,
             hhmmss: hhmmss, fmtDur: fmtDur, layoutRow: layoutRow, axisBounds: axisBounds,
             statusOf: statusOf, CAP: CAP, LABEL: LABEL };
  }

  // ── module ─────────────────────────────────────────────────────────────────

  function mount(ctx) {
    if (!ctx || !ctx.events) return null;
    var cleanupFns = [];

    var root = document.createElement('div');
    root.className = 'hd-timebar';
    root.setAttribute('role', 'figure');
    root.setAttribute('aria-label', TITLE);

    var head = document.createElement('div');
    head.className = 'hd-tb-head';
    var h = document.createElement('span');
    h.className = 'hd-tb-title small dim';
    h.textContent = TITLE;
    var axisLbl = document.createElement('span');
    axisLbl.className = 'hd-tb-axis small dim';
    var only = document.createElement('span');
    only.className = 'hd-tb-only small dim';
    only.textContent = LABEL;
    only.title = 'herdr keeps no status history — this strip only shows what happened since the page loaded';
    var note = document.createElement('span');
    note.className = 'hd-tb-note small dim';
    head.appendChild(h); head.appendChild(axisLbl); head.appendChild(note); head.appendChild(only);

    var body = document.createElement('div');
    body.className = 'hd-tb-body';
    var empty = document.createElement('div');
    empty.className = 'hd-tb-empty small dim';
    empty.textContent = 'waiting for status events…';

    root.appendChild(head); root.appendChild(body); root.appendChild(empty);

    var segs = {};      // paneId -> segments[]
    var lastStatus = {}; // paneId -> status
    var trimmed = {};   // paneId -> true when the cap dropped old segments
    var state = { err: '', timer: null, mounted: true };

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
    function selectedPaneId() {
      try {
        if (ctx.state && ctx.state.selectedPaneId) return ctx.state.selectedPaneId;
      } catch (e) { /* ignore */ }
      return null;
    }

    /** Panes of the current tab = the tab of the selected pane (§4.10). */
    function currentTabPanes() {
      var all = panesList();
      var sel = selectedPaneId();
      if (sel) {
        var rec = null;
        for (var i = 0; i < all.length; i++) {
          if ((all[i].pane_id || all[i].paneId) === sel) { rec = all[i]; break; }
        }
        if (rec && rec.tab_id) {
          var inTab = [];
          for (var j = 0; j < all.length; j++) {
            if (all[j].tab_id === rec.tab_id) inTab.push(all[j]);
          }
          if (inTab.length) return inTab;
        }
      }
      return all;   // no selection (or no tab info): show everything rather than nothing
    }

    function ensureSeeded() {
      var panes = currentTabPanes();
      var now = Date.now();
      for (var i = 0; i < panes.length; i++) {
        var p = panes[i] || {};
        var pid = p.pane_id || p.paneId;
        if (!pid) continue;
        pid = String(pid);
        var st = statusOf(p);
        if (!segs[pid]) segs[pid] = [seedSegment(st, now)];
        lastStatus[pid] = st;
      }
      return panes;
    }

    function render() {
      var panes = ensureSeeded();
      body.textContent = '';
      var now = Date.now();
      var rows = [];
      for (var i = 0; i < panes.length; i++) {
        var p = panes[i] || {};
        var pid = p.pane_id || p.paneId;
        if (!pid) continue;
        pid = String(pid);
        rows.push({ paneId: pid, rec: p, list: segs[pid] || [] });
      }
      var bounds = axisBounds(segs, now);
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var el = document.createElement('div');
        el.className = 'hd-tb-row';
        el.setAttribute('data-pane-id', row.paneId);

        var lbl = document.createElement('span');
        lbl.className = 'hd-tb-pane mono';
        lbl.textContent = row.paneId;
        lbl.title = (row.rec.agent || '') + ' ' + (row.rec.label || '');
        el.appendChild(lbl);

        var strip = document.createElement('div');
        strip.className = 'hd-tb-strip';
        var laid = layoutRow(row.list, bounds.t0, bounds.t1);
        for (var k = 0; k < laid.length; k++) {
          var piece = document.createElement('span');
          piece.className = 'hd-tb-seg st-' + laid[k].status;
          piece.style.left = laid[k].left.toFixed(3) + '%';
          piece.style.width = laid[k].width.toFixed(3) + '%';
          piece.title = tooltipText(laid[k].seg, now);
          strip.appendChild(piece);
        }
        if (!laid.length) strip.className += ' empty';
        el.appendChild(strip);

        var dur = document.createElement('span');
        dur.className = 'hd-tb-dur small dim';
        var cur = row.list.length ? row.list[row.list.length - 1] : null;
        dur.textContent = cur ? fmtDur(now - cur.from) : '';
        el.appendChild(dur);

        if (trimmed[row.paneId]) {
          var t = document.createElement('span');
          t.className = 'hd-tb-trim small dim';
          t.textContent = '…';
          t.title = 'older segments were dropped (cap ' + CAP + ' per pane)';
          el.appendChild(t);
        }

        el.addEventListener('click', function (pid) {
          return function () {
            try {
              if (ctx.ui && typeof ctx.ui.selectPane === 'function') ctx.ui.selectPane(pid);
            } catch (e) { state.err = String(e && e.message ? e.message : e); }
          };
        }(row.paneId));

        body.appendChild(el);
      }
      empty.hidden = rows.length > 0;
      var span = bounds.t1 - bounds.t0;
      axisLbl.textContent = rows.length
        ? 'last ' + fmtDur(span) + ' · ' + rows.length + ' pane' + (rows.length === 1 ? '' : 's')
        : '';
      note.textContent = state.err || (Object.keys(trimmed).length ? 'some rows are truncated' : '');
      note.title = state.err || '';
    }

    /** Wall-clock tick: the open segment grows, tooltips stay honest. */
    function tick() {
      if (!state.mounted) return;
      var now = Date.now();
      var rowsEls = body.querySelectorAll('.hd-tb-row');
      for (var i = 0; i < rowsEls.length; i++) {
        var pid = rowsEls[i].getAttribute('data-pane-id');
        var list = segs[pid];
        if (!list || !list.length) continue;
        var cur = list[list.length - 1];
        var dur = rowsEls[i].querySelector('.hd-tb-dur');
        if (dur) dur.textContent = fmtDur(now - cur.from);
        var pieces = rowsEls[i].querySelectorAll('.hd-tb-seg');
        if (pieces.length) {
          var lastPiece = pieces[pieces.length - 1];
          lastPiece.title = tooltipText(cur, now);
        }
      }
      var bounds = axisBounds(segs, now);
      var laid = null;
      for (var j = 0; j < rowsEls.length; j++) {
        var id = rowsEls[j].getAttribute('data-pane-id');
        laid = layoutRow(segs[id] || [], bounds.t0, bounds.t1);
        var ps = rowsEls[j].querySelectorAll('.hd-tb-seg');
        for (var k = 0; k < ps.length && k < laid.length; k++) {
          ps[k].style.left = laid[k].left.toFixed(3) + '%';
          ps[k].style.width = laid[k].width.toFixed(3) + '%';
        }
      }
    }

    // ── wiring ───────────────────────────────────────────────────────────────
    var off = [];
    function on(type, fn) {
      try {
        var u = ctx.events.on(type, function (p) {
          try { fn(p); } catch (e) { state.err = type + ': ' + (e && e.message ? e.message : e); render(); }
        });
        if (typeof u === 'function') off.push(u);
      } catch (e) { state.err = 'subscribe ' + type + ' failed: ' + (e && e.message ? e.message : e); }
    }
    function normEvents(p) {
      if (!p) return [];
      var arr = Array.isArray(p) ? p : [p];
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var one = arr[i];
        if (!one || typeof one !== 'object') continue;
        var d = (one.data && typeof one.data === 'object') ? one.data : one;
        var pane = d.pane_id || d.paneId || one.pane_id || one.paneId;
        var st = d.agent_status || d.status || one.agent_status || one.status;
        if (!pane || !st) continue;
        out.push({ paneId: String(pane), status: statusOf({ agent_status: st }) });
      }
      return out;
    }

    on('status', function (payload) {
      var evs = normEvents(payload);
      var now = Date.now();
      for (var i = 0; i < evs.length; i++) {
        var e = evs[i];
        var known = lastStatus[e.paneId];
        if (known === undefined) {
          // first time we hear about this pane: seed, do not claim a transition time
          segs[e.paneId] = segs[e.paneId] || [seedSegment(e.status, now)];
          lastStatus[e.paneId] = e.status;
          continue;
        }
        if (known === e.status) continue;                 // not a transition
        var r = recordSegment(segs[e.paneId] || [], e.status, now, CAP);
        segs[e.paneId] = r.list;
        if (r.trimmed) trimmed[e.paneId] = true;
        lastStatus[e.paneId] = e.status;
      }
      render();
    });
    on('snapshot', function () {
      var panes = currentTabPanes();
      var now = Date.now();
      for (var i = 0; i < panes.length; i++) {
        var p = panes[i] || {};
        var pid = p.pane_id || p.paneId;
        if (!pid) continue;
        pid = String(pid);
        var st = statusOf(p);
        if (!segs[pid]) { segs[pid] = [seedSegment(st, now)]; lastStatus[pid] = st; }
        else if (lastStatus[pid] !== st) {
          var r = recordSegment(segs[pid], st, now, CAP);
          segs[pid] = r.list;
          if (r.trimmed) trimmed[pid] = true;
          lastStatus[pid] = st;
        }
      }
      render();
    });
    on('select', function () { render(); });   // the current tab may have changed

    var placed = false;
    try {
      var header = document.getElementById('header');
      if (header && header.parentNode) {
        header.parentNode.insertBefore(root, header.nextSibling);
        placed = true;
      }
      if (!placed && ctx.ui && typeof ctx.ui.container === 'function') {
        var c = ctx.ui.container();
        if (c && c.appendChild) { c.insertBefore(root, c.firstChild); placed = true; }
      }
    } catch (e) { state.err = 'could not place the strip: ' + (e && e.message ? e.message : e); }
    if (!placed) document.body.insertBefore(root, document.body.firstChild);

    render();
    state.timer = setInterval(tick, TICK_MS);

    cleanupFns.push(function () {
      state.mounted = false;
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      for (var i = 0; i < off.length; i++) { try { off[i](); } catch (e) { /* ignore */ } }
      off.length = 0;
      if (root.parentNode) root.parentNode.removeChild(root);
    });

    return {
      render: render,
      unmount: function () {
        for (var i = 0; i < cleanupFns.length; i++) { try { cleanupFns[i](); } catch (e) { /* ignore */ } }
        cleanupFns.length = 0;
      },
    };
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
