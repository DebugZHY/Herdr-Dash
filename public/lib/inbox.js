/* herdr-dash — inbox.js · attention queue of blocked + done panes (owner: W3)
 *
 * CONTRACT-v2 §3 module + §4.8:
 *   only `blocked` + `done`, newest state change first, `(N)` in document.title, favicon dot,
 *   j/k walks the queue, click selects the pane and marks it seen (localStorage
 *   `herdrDash.seen[<pane>] = <status>@<observed-change-ms>`), Web Notification on a
 *   transition into blocked/done (permission asked once, from a user gesture), sound OFF
 *   by default and toggled by `herdrDash.notifySound`.
 *
 * Honesty rule: a notification fires only for a transition we actually witnessed
 * (a status event whose new status differs from the previous one). Panes that were already
 * blocked/done when we mounted populate the queue but never raise a notification, and their
 * age is shown with a leading '~' because herdr gives us no history.
 */
(function () {
  'use strict';

  var HD = (window.HD = window.HD || {});
  var ID = 'inbox';
  var TITLE = 'Attention inbox';
  var KEY_SEEN = 'herdrDash.seen';
  var KEY_SOUND = 'herdrDash.notifySound';
  var WATCHED = { blocked: true, done: true };
  var STATUSES = ['blocked', 'done', 'working', 'idle', 'unknown'];

  // ── pure helpers (exported for the DOM-free test) ──────────────────────────

  function statusOf(rec) {
    var s = rec && (rec.agent_status || rec.status);
    s = s ? String(s).toLowerCase() : 'unknown';
    return STATUSES.indexOf(s) >= 0 ? s : 'unknown';
  }
  function wantsAttention(status) { return Object.prototype.hasOwnProperty.call(WATCHED, status); }

  /** Stable marker stored in herdrDash.seen for a pane's current attention state. */
  function seenMarker(status, ts) {
    return String(status) + '@' + (typeof ts === 'number' && isFinite(ts) ? ts : 0);
  }

  function isUnseen(entry, seen) {
    if (!entry) return false;
    var stored = seen ? seen[entry.paneId] : undefined;
    return stored !== entry.marker;
  }

  /**
   * Build the queue: blocked + done only, newest state change first.
   * panes      [{pane_id, agent_status, agent, label, workspace_id, tab_id}]
   * transitions {paneId: {ts, witnessed}}
   * seen        {paneId: marker}
   * rows: [{paneId, status, ts, witnessed, marker, seen, agent, label, workspaceId, tabId}]
   */
  function buildQueue(panes, transitions, seen) {
    transitions = transitions || {};
    seen = seen || {};
    var out = [];
    for (var i = 0; i < (panes || []).length; i++) {
      var p = panes[i] || {};
      var pid = p.pane_id || p.paneId;
      if (!pid) continue;
      pid = String(pid);
      var st = statusOf(p);
      if (!wantsAttention(st)) continue;
      var tr = transitions[pid] || {};
      var ts = typeof tr.ts === 'number' && isFinite(tr.ts) ? tr.ts : 0;
      var witnessed = !!tr.witnessed;
      var entry = {
        paneId: pid,
        status: st,
        ts: ts,
        witnessed: witnessed,
        marker: seenMarker(st, ts),
        agent: p.agent || '',
        label: p.label || p.title || '',
        workspaceId: p.workspace_id || '',
        tabId: p.tab_id || '',
      };
      entry.seen = seen[pid] === entry.marker;
      out.push(entry);
    }
    out.sort(function (a, b) {
      if (b.ts !== a.ts) return b.ts - a.ts;                    // newest change first
      if (a.witnessed !== b.witnessed) return a.witnessed ? -1 : 1;  // witnessed changes before mount-seeded ones
      return a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0;
    });
    return out;
  }

  function unseenCount(rows) {
    var n = 0;
    for (var i = 0; i < (rows || []).length; i++) if (!rows[i].seen) n++;
    return n;
  }

  /** '(3) herdr-dash' / 'herdr-dash' */
  function titleWithBadge(base, n) {
    var b = String(base == null ? '' : base).trim() || 'herdr-dash';
    return n > 0 ? '(' + n + ') ' + b : b;
  }

  /** Pure SVG favicon: a quiet tile, or a tile with a status dot when there is attention. */
  function faviconDataUrl(count) {
    var dot = count > 0 ? '#e5484d' : '#39414d';
    var r = count > 0 ? 9 : 5;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="7" fill="#0d1117"/>' +
      '<rect x="6" y="9" width="20" height="3" rx="1.5" fill="#4aa3ff"/>' +
      '<rect x="6" y="16" width="12" height="3" rx="1.5" fill="#39414d"/>' +
      '<circle cx="23" cy="24" r="' + r + '" fill="' + dot + '"/>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /** Compact age for the queue rows: 0 -> 'now', 90000 -> '1m 30s'. */
  function fmtAge(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) ms = 0;
    var t = Math.floor(ms / 1000);
    if (t < 3) return 'now';
    var s = t % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
    if (h > 0) return h + 'h ' + (m < 10 ? '0' + m : m) + 'm';
    if (Math.floor(t / 60) > 0) return Math.floor(t / 60) + 'm ' + (s < 10 ? '0' + s : s) + 's';
    return s + 's';
  }

  /** Notification body: pane id + its last non-empty output line (line omitted if unknown). */
  function notificationBody(paneId, lines) {
    var line = '';
    if (lines && lines.length) {
      for (var i = lines.length - 1; i >= 0; i--) {
        if (lines[i] != null && String(lines[i]).trim() !== '') { line = String(lines[i]).trim(); break; }
      }
    }
    if (line.length > 160) line = line.slice(0, 157) + '…';
    return line ? paneId + ' — ' + line : String(paneId);
  }

  /**
   * Normalise the §7.4 hook's arguments. Pure, so `_scratch/w3/logic.mjs` can assert the
   * validation without a DOM. Returns null when there is nothing to witness — the `status`
   * event path drops a statusless event for the same reason, and this hook may not invent one.
   * @returns {{paneId:string, from:string|null, to:string, atMs:number}|null}
   */
  function witnessArgs(paneId, from, to, atMs) {
    if (paneId == null || String(paneId).trim() === '') return null;
    if (to == null || String(to).trim() === '') return null;
    var blank = (from == null || String(from).trim() === '');
    var at = (typeof atMs === 'number' && isFinite(atMs) && atMs > 0) ? Math.floor(atMs) : Date.now();
    return {
      paneId: String(paneId),
      from: blank ? null : statusOf({ agent_status: from }),
      to: statusOf({ agent_status: to }),
      atMs: at,
    };
  }

  function testApi() {
    return { buildQueue: buildQueue, unseenCount: unseenCount, titleWithBadge: titleWithBadge,
             faviconDataUrl: faviconDataUrl, seenMarker: seenMarker, isUnseen: isUnseen,
             notificationBody: notificationBody, fmtAge: fmtAge, statusOf: statusOf,
             wantsAttention: wantsAttention, witnessArgs: witnessArgs };
  }

  // ── module ─────────────────────────────────────────────────────────────────

  function mount(ctx) {
    if (!ctx || !ctx.events) return null;
    var cleanupFns = [];
    var cursor = -1;

    var root = document.createElement('div');
    root.className = 'hd-inbox';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', TITLE);

    var head = document.createElement('div');
    head.className = 'hd-inbox-head';
    var h = document.createElement('span');
    h.className = 'hd-mod-title';
    h.textContent = TITLE;
    var badge = document.createElement('span');
    badge.className = 'hd-inbox-badge';
    var hint = document.createElement('span');
    hint.className = 'hd-inbox-hint small dim';
    hint.textContent = 'blocked + done · newest first · j/k walk · Enter or click = open + seen';
    var soundWrap = document.createElement('label');
    soundWrap.className = 'chk';
    var sound = document.createElement('input');
    sound.type = 'checkbox';
    sound.checked = readSound();
    var soundLabel = document.createElement('span');
    soundLabel.textContent = 'sound';
    soundWrap.appendChild(sound); soundWrap.appendChild(soundLabel);
    var enableBtn = document.createElement('button');
    enableBtn.className = 'btn small';
    enableBtn.type = 'button';
    enableBtn.textContent = 'enable desktop alerts';
    var markAll = document.createElement('button');
    markAll.className = 'btn small';
    markAll.type = 'button';
    markAll.textContent = 'mark all seen';
    var close = document.createElement('button');
    close.className = 'icon-btn';
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'close (Esc)';
    head.appendChild(h); head.appendChild(badge); head.appendChild(hint);
    head.appendChild(soundWrap); head.appendChild(enableBtn); head.appendChild(markAll); head.appendChild(close);

    var errBar = document.createElement('div');
    errBar.className = 'err hd-inbox-err';
    errBar.hidden = true;

    var list = document.createElement('div');
    list.className = 'hd-inbox-list';
    root.appendChild(head); root.appendChild(errBar); root.appendChild(list);

    var baseTitle = (typeof document.title === 'string' && document.title.trim()) ? document.title.trim() : 'herdr-dash';
    var seen = readSeen();
    var soundOn = readSound();
    var state = {
      open: false,
      transitions: {},   // paneId -> {ts, witnessed}
      lastStatus: {},    // paneId -> status we knew (seeds transition detection)
      rows: [],
      err: '',
    };

    function showErr(msg) {
      state.err = msg ? String(msg) : '';
      errBar.textContent = state.err;
      errBar.hidden = !state.err;
    }

    // ── storage (all access wrapped: private mode / disabled storage must not crash) ──
    function readSeen() {
      try {
        var raw = window.localStorage.getItem(KEY_SEEN);
        var v = raw ? JSON.parse(raw) : {};
        return (v && typeof v === 'object') ? v : {};
      } catch (e) { return {}; }
    }
    function writeSeen(map) {
      try { window.localStorage.setItem(KEY_SEEN, JSON.stringify(map)); return true; }
      catch (e) { showErr('could not persist seen state: ' + (e && e.message ? e.message : e)); return false; }
    }
    function readSound() {
      try { return window.localStorage.getItem(KEY_SOUND) === '1'; } catch (e) { return false; }
    }
    function writeSound(on) {
      try { window.localStorage.setItem(KEY_SOUND, on ? '1' : '0'); }
      catch (e) { showErr('could not persist the sound setting'); }
    }

    // ── data ─────────────────────────────────────────────────────────────────
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
      } catch (e) { /* fall through */ }
      var snap = snapshotObj();
      return (snap && Array.isArray(snap.panes)) ? snap.panes : [];
    }
    function labelMaps() {
      var snap = snapshotObj() || {};
      var ws = {}, tb = {}, i;
      var W = Array.isArray(snap.workspaces) ? snap.workspaces : [];
      var T = Array.isArray(snap.tabs) ? snap.tabs : [];
      for (i = 0; i < W.length; i++) { var w = W[i] || {}; ws[w.workspace_id] = w.label || ('#' + (w.number != null ? w.number : w.workspace_id)); }
      for (i = 0; i < T.length; i++) { var t = T[i] || {}; tb[t.tab_id] = t.label || ('tab ' + (t.number != null ? t.number : t.tab_id)); }
      return { ws: ws, tb: tb };
    }
    function bufferOf(paneId) {
      try {
        if (ctx.state && typeof ctx.state.buffer === 'function') return ctx.state.buffer(paneId);
      } catch (e) { /* none */ }
      return null;
    }

    /**
     * Reconcile the current pane list against what we last knew.
     * First sighting of a pane is queued but marked unwitnessed (we did not watch it
     * change, so its age is only a lower bound and it must not raise a notification).
     * Any later difference IS a state change we observed — recorded with `now` as the
     * change time, and notified only when `allowNotify` is set (the initial seed and the
     * first snapshot must stay quiet).
     */
    function syncTransitions(allowNotify) {
      var panes = panesList();
      var now = Date.now();
      var alive = {};
      for (var i = 0; i < panes.length; i++) {
        var p = panes[i] || {};
        var pid = p.pane_id || p.paneId;
        if (!pid) continue;
        pid = String(pid);
        alive[pid] = true;
        var st = statusOf(p);
        var known = state.lastStatus[pid];
        if (known === undefined) {
          if (!state.transitions[pid]) state.transitions[pid] = { ts: now, witnessed: false };
          state.lastStatus[pid] = st;
        } else if (known !== st) {
          state.transitions[pid] = { ts: now, witnessed: true };
          state.lastStatus[pid] = st;
          if (allowNotify && wantsAttention(st)) onAttention(pid, st, known);
        }
      }
      // prune state for panes that no longer exist (bounded memory)
      for (var k in state.transitions) {
        if (Object.prototype.hasOwnProperty.call(state.transitions, k) && !alive[k]) {
          delete state.transitions[k];
          delete state.lastStatus[k];
        }
      }
      for (var s in seen) {
        if (Object.prototype.hasOwnProperty.call(seen, s) && !alive[s]) delete seen[s];
      }
    }

    function onAttention(paneId, status, prevStatus) {
      markDirty();
      notify(paneId, status, prevStatus);
    }

    function markDirty() { if (state.open) render(); updateBadge(); }

    function build() {
      var maps = labelMaps();
      var raw = panesList();
      var enriched = [];
      for (var i = 0; i < raw.length; i++) {
        var p = raw[i] || {};
        var pid = p.pane_id || p.paneId;
        // The snapshot is a periodic full picture; a witnessed `status` event is fresher news
        // about one pane. Show the freshest status we know, so the queue agrees with the pane we
        // just alerted about instead of contradicting it until the next snapshot lands
        // (syncTransitions re-syncs lastStatus from every snapshot, so this cannot go stale).
        var snapStatus = statusOf(p);
        var known = pid == null ? undefined : state.lastStatus[String(pid)];
        enriched.push({
          pane_id: pid,
          agent_status: (known === undefined ? snapStatus : known),
          agent: p.agent || '',
          label: p.label || p.title || '',
          workspace_id: maps.ws[p.workspace_id] || p.workspace_id || '',
          tab_id: maps.tb[p.tab_id] || p.tab_id || '',
        });
      }
      state.rows = buildQueue(enriched, state.transitions, seen);
      return state.rows;
    }

    // ── badge / title / favicon ──────────────────────────────────────────────
    var faviLink = null, faviOriginal = null, faviTouched = false;
    function installFavicon() {
      try {
        var link = document.querySelector('link[rel~="icon"]');
        if (link) { faviOriginal = link.getAttribute('href'); faviLink = link; }
        else {
          faviLink = document.createElement('link');
          faviLink.setAttribute('rel', 'icon');
          document.head.appendChild(faviLink);
        }
      } catch (e) { showErr('favicon unavailable: ' + (e && e.message ? e.message : e)); }
    }
    function setFavicon(count) {
      if (!faviLink) return;
      try {
        if (count > 0) {
          // re-attach if a previous clear removed the link we added ourselves
          if (!faviLink.parentNode && document.head) document.head.appendChild(faviLink);
          faviLink.setAttribute('href', faviconDataUrl(count));
          faviTouched = true;
        } else if (faviTouched) {
          // index.html ships no favicon, so there is often nothing to restore *to*:
          // remove the link we added instead of leaving our dot behind.
          if (faviOriginal != null) faviLink.setAttribute('href', faviOriginal);
          else if (faviLink.parentNode) faviLink.parentNode.removeChild(faviLink);
          faviTouched = false;
        }
      } catch (e) { /* cosmetic only */ }
    }
    function updateBadge() {
      var n = unseenCount(state.rows);
      badge.textContent = n ? String(n) : '';
      badge.hidden = n === 0;
      badge.title = n ? n + ' pane(s) need attention' : '';
      try { document.title = titleWithBadge(baseTitle, n); } catch (e) { /* ignore */ }
      setFavicon(n);
    }

    // ── notifications ────────────────────────────────────────────────────────
    function canNotify() {
      return typeof window.Notification === 'function' && window.Notification.permission === 'granted';
    }
    function askPermission() {
      if (typeof window.Notification !== 'function') {
        showErr('this browser has no Notification support');
        return Promise.resolve('unsupported');
      }
      if (window.Notification.permission !== 'default') {
        if (window.Notification.permission !== 'granted') showErr('desktop alerts are blocked in the browser settings');
        return Promise.resolve(window.Notification.permission);
      }
      return window.Notification.requestPermission()
        .then(function (p) { showErr(p === 'granted' ? '' : 'desktop alerts were not granted (you can re-enable them in the browser)'); return p; })
        .catch(function (e) { showErr('notification permission failed: ' + (e && e.message ? e.message : e)); return 'error'; });
    }
    function notify(paneId, status, prevStatus) {
      var body = notificationBody(paneId, bufferOf(paneId));
      var title = 'herdr-dash · ' + paneId + ' is ' + status + (prevStatus ? ' (was ' + prevStatus + ')' : '');
      try {
        if (canNotify()) {
          var n = new window.Notification(title, { body: body, tag: 'hd-' + paneId + '-' + status });
          setTimeout(function () { try { n.close(); } catch (e) { /* ignore */ } }, 12000);
        }
      } catch (e) { showErr('desktop alert failed: ' + (e && e.message ? e.message : e)); }
      if (soundOn) beep(status);
      if (!state.open) showErr('');
    }
    var audioCtx = null;
    function beep(status) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audioCtx = audioCtx || new AC();
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = status === 'blocked' ? 330 : 660;
        g.gain.value = 0.06;
        o.connect(g); g.connect(audioCtx.destination);
        o.start();
        setTimeout(function () { try { o.stop(); } catch (e) { /* ignore */ } }, 180);
      } catch (e) { /* sound is optional */ }
    }

    // ── render ───────────────────────────────────────────────────────────────
    function render() {
      var rows = build();
      list.textContent = '';
      var now = Date.now();
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var row = document.createElement('div');
        row.className = 'hd-inbox-row' + (r.seen ? ' seen' : ' unread') + (i === cursor ? ' cursor' : '');
        row.setAttribute('data-pane-id', r.paneId);
        row.title = r.seen ? 'seen · click to open' : 'new · click to open and mark seen';

        var chip = document.createElement('span');
        chip.className = 'hd-chip ' + r.status;
        var dot = document.createElement('span');
        dot.className = 'dot ' + r.status;
        var cl = document.createElement('span');
        cl.textContent = r.status;
        chip.appendChild(dot); chip.appendChild(cl);
        row.appendChild(chip);

        var pid = document.createElement('span');
        pid.className = 'mono hd-inbox-pane';
        pid.textContent = r.paneId;
        row.appendChild(pid);

        var meta = document.createElement('span');
        meta.className = 'small dim hd-inbox-meta';
        var since = r.ts ? now - r.ts : 0;
        meta.textContent = [r.agent || '–', r.workspaceId, (r.witnessed ? '' : '~') + fmtAge(since)].join(' · ');
        row.appendChild(meta);

        var line = document.createElement('span');
        line.className = 'small dim hd-inbox-last mono';
        line.textContent = lastLineOf(bufferOf(r.paneId));
        line.title = line.textContent;
        row.appendChild(line);

        var seenBtn = document.createElement('button');
        seenBtn.className = 'icon-btn';
        seenBtn.type = 'button';
        seenBtn.textContent = r.seen ? '↺' : '✓';
        seenBtn.title = r.seen ? 'mark unseen' : 'mark seen';
        seenBtn.addEventListener('click', function (pid, isSeen) {
          return function (ev) {
            ev.stopPropagation();
            if (isSeen) { delete seen[pid]; }
            else { seen[pid] = markerFor(pid); }
            if (!writeSeen(seen)) return;
            render(); updateBadge();
          };
        }(r.paneId, r.seen));
        row.appendChild(seenBtn);

        row.addEventListener('click', function (pid) { return function () { openAndMark(pid); }; }(r.paneId));
        list.appendChild(row);
      }
      if (!rows.length) {
        var empty = document.createElement('div');
        empty.className = 'hd-empty dim';
        empty.textContent = 'nothing needs attention';
        list.appendChild(empty);
      }
      updateBadge();
      if (cursor >= rows.length) cursor = rows.length - 1;
    }
    function lastLineOf(lines) {
      if (!lines || !lines.length) return '';
      for (var i = lines.length - 1; i >= 0; i--) {
        if (lines[i] != null && String(lines[i]).trim() !== '') return String(lines[i]).trim();
      }
      return '';
    }
    function markerFor(paneId) {
      var tr = state.transitions[paneId];
      var row = null;
      for (var i = 0; i < state.rows.length; i++) if (state.rows[i].paneId === paneId) row = state.rows[i];
      if (row) return row.marker;
      return seenMarker(state.lastStatus[paneId] || 'unknown', tr ? tr.ts : 0);
    }
    function openAndMark(paneId) {
      try {
        if (ctx.ui && typeof ctx.ui.selectPane === 'function') ctx.ui.selectPane(paneId);
      } catch (e) { showErr('selectPane failed: ' + (e && e.message ? e.message : e)); }
      seen[paneId] = markerFor(paneId);
      writeSeen(seen);
      render(); updateBadge();
    }

    // ── visibility ───────────────────────────────────────────────────────────
    function show() {
      if (state.open) return;
      state.open = true;
      root.hidden = false;
      syncTransitions(false);
      render();
    }
    function hide() {
      if (!state.open) return;
      state.open = false;
      root.hidden = true;
    }
    function toggle() { state.open ? hide() : show(); }
    function walk(delta) {
      var rows = state.rows;
      if (!rows.length) return;
      cursor = Math.max(0, Math.min(rows.length - 1, cursor < 0 ? 0 : cursor + delta));
      render();
      // j/k navigates (so the transcript follows) but deliberately does NOT mark seen —
      // walking past an item must not silently empty the queue.
      try { if (ctx.ui && typeof ctx.ui.selectPane === 'function') ctx.ui.selectPane(rows[cursor].paneId); }
      catch (e) { showErr('selectPane failed: ' + (e && e.message ? e.message : e)); }
      var el = list.querySelectorAll('.hd-inbox-row')[cursor];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }

    // ── wiring ───────────────────────────────────────────────────────────────
    var off = [];
    function on(type, fn) {
      try {
        var u = ctx.events.on(type, function (p) { try { fn(p); } catch (e) { showErr(type + ': ' + (e && e.message ? e.message : e)); } });
        if (typeof u === 'function') off.push(u);
      } catch (e) { showErr('subscribe ' + type + ' failed: ' + (e && e.message ? e.message : e)); }
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

    /**
     * ONE pane status change, in the one place the `status` event stream and the §7.4 test hook
     * both go through. Returns true when this really was a transition (a pane we had a baseline
     * for, whose status actually differs) — the same condition that decides the badge, so the
     * hook cannot make the badge say anything the event path would not.
     */
    function applyStatus(paneId, status, atMs) {
      var known = state.lastStatus[paneId];
      if (known === undefined) { state.lastStatus[paneId] = status; return false; }  // no baseline yet
      if (known === status) return false;                                            // not a real transition
      state.lastStatus[paneId] = status;
      state.transitions[paneId] = { ts: atMs, witnessed: true };
      if (wantsAttention(status)) onAttention(paneId, status, known);
      else markDirty();
      return true;
    }

    on('status', function (payload) {
      var evs = normEvents(payload);
      var now = Date.now();                     // one event message = one instant
      for (var i = 0; i < evs.length; i++) applyStatus(evs[i].paneId, evs[i].status, now);
      markDirty();
    });
    on('snapshot', function () { syncTransitions(true); markDirty(); });   // a refresh may reveal a change the event stream missed
    on('select', function () { if (state.open) render(); });
    on('inbox.toggle', toggle);
    on('module.toggle', function (p) { if (p === ID || (p && p.id === ID)) toggle(); });

    sound.addEventListener('change', function () {
      soundOn = !!sound.checked;
      writeSound(soundOn);
      if (soundOn) askPermission();
    });
    enableBtn.addEventListener('click', function () { askPermission().then(function () { updateBadge(); }); });
    markAll.addEventListener('click', function () {
      for (var i = 0; i < state.rows.length; i++) seen[state.rows[i].paneId] = state.rows[i].marker;
      writeSeen(seen);
      render(); updateBadge();
    });
    close.addEventListener('click', function () { hide(); });

    // Permission is requested once, from a user gesture (§4.8) — never on load.
    var gestureDone = false;
    function onGesture() {
      if (gestureDone) return;
      gestureDone = true;
      if (typeof window.Notification === 'function' && window.Notification.permission === 'default') {
        askPermission();
      }
    }
    document.addEventListener('pointerdown', onGesture, { once: true, capture: true });

    // j/k + Esc win only while the inbox is open, and only in the capture phase, so W2's
    // global j/k (keys.js) cannot also move the pane selection.
    document.addEventListener('keydown', function (e) {
      if (!state.open) return;
      var t = e.target;
      var tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
      if (e.key === 'Escape' && !typing) {
        e.preventDefault(); e.stopImmediatePropagation(); hide(); return;
      }
      if (typing) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault(); e.stopImmediatePropagation(); walk(e.key === 'j' ? 1 : -1); return;
      }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (state.rows[cursor]) openAndMark(state.rows[cursor].paneId);
        else if (state.rows[0]) openAndMark(state.rows[0].paneId);
      }
    }, true);

    // ── §7.4 test hook ───────────────────────────────────────────────────────
    /**
     * `window.HD.inboxTest.witness(paneId, from, to, atMs)` — drive ONE status change through
     * exactly the path a `status` event drives: `from` is the baseline the module is told it
     * already had (omit it to use whatever the module knows, which for an unseen pane means the
     * change is not a transition and nothing is queued), `to` is the new status, `atMs` the
     * change time (default: Date.now()). Nothing auto-fires — no permission prompt, no timers,
     * no beep — and nothing is fabricated for display: the badge only rises if the §7.4 rules
     * would have raised it for a real event.
     */
    function witnessHook(paneId, from, to, atMs) {
      try {
        var a = witnessArgs(paneId, from, to, atMs);
        if (!a) return false;
        if (a.from) state.lastStatus[a.paneId] = a.from;
        return applyStatus(a.paneId, a.to, a.atMs);
      } catch (e) { showErr('inboxTest.witness failed: ' + (e && e.message ? e.message : e)); return false; }
    }
    /**
     * `window.HD.inboxTest.reset()` — drop everything a test needs to start clean: the seen
     * markers (in memory and persisted) and the transition baseline, then re-observe the world
     * exactly as mount does (syncTransitions: a pane seen for the first time is queued as
     * UNWITNESSED, with '~' on its age, because nobody watched it change). It forgets; it does
     * not invent a history.
     */
    function resetHook() {
      try {
        seen = {};
        try { window.localStorage.removeItem(KEY_SEEN); } catch (e) { /* storage is optional */ }
        state.transitions = {};
        state.lastStatus = {};
        cursor = -1;
        syncTransitions(false);   // the same quiet seed mount() does
        render(); updateBadge();
        return true;
      } catch (e) { showErr('inboxTest.reset failed: ' + (e && e.message ? e.message : e)); return false; }
    }
    try {
      // the same object lib/inbox.js published at load; the pure helpers stay on it
      var hook = (HD.inboxTest && typeof HD.inboxTest === 'object') ? HD.inboxTest : (HD.inboxTest = {});
      hook.witness = witnessHook;
      hook.reset = resetHook;
      hook.mounted = true;
    } catch (e) { /* the hook is test-only, never fatal */ }

    // §3: every shortcut must reach W2's `?` help overlay.
    registerKeys(ctx, ID, [
      ['j / k', 'inbox: next / previous item'],
      ['Enter', 'inbox: open the highlighted pane and mark it seen'],
      ['Esc', 'inbox: close'],
    ], 'walk the attention queue (works on blocked/done panes)');

    installFavicon();
    document.body.appendChild(root);
    syncTransitions(false);   // seed quietly: pre-existing blocked/done panes must not ping
    build();
    updateBadge();

    cleanupFns.push(function () {
      for (var i = 0; i < off.length; i++) { try { off[i](); } catch (e) { /* ignore */ } }
      off.length = 0;
      try { document.title = baseTitle; } catch (e) { /* ignore */ }
      setFavicon(0);
      if (root.parentNode) root.parentNode.removeChild(root);
    });

    return {
      show: show, hide: hide, toggle: toggle,
      unseen: function () { return unseenCount(state.rows); },
      witness: witnessHook, reset: resetHook,     // §7.4, also on window.HD.inboxTest
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

  // Registration handshake — see board.js for the full note. §3 loads lib/*.js before
  // app.js, so window.HD.register does not exist yet at load time.
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
