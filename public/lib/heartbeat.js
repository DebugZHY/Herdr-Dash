/* herdr-dash — lib/heartbeat.js
 *
 * The ♥ heartbeat control for the selected pane: one session heartbeat per pane, managed with the
 * vocabulary hermes uses natively (`/heartbeat every <interval> <prompt>`, pause / resume / clear)
 * and the semantics the pi extension implements. The UI never distinguishes the agents beyond the
 * badge, because the server adapts both to the frozen HTTP contract:
 *
 *   GET  /api/heartbeat?pane_id=<pane>
 *        -> { ok, agent:"hermes"|"pi", session_id, supported, source, heartbeat|null, note? }
 *   POST /api/heartbeat
 *        body { pane_id, action:"set"|"pause"|"resume"|"clear", interval?, prompt? }
 *        -> { ok, action, applied_via, heartbeat|null, pending?, pane_excerpt?, error? }
 *
 * `set` requires both interval and prompt. pending:true means the server sent the slash command but
 * the stored state had not changed yet: the panel shows “applying…” and keeps pane_excerpt as the
 * tooltip of that line, while the 5 s poll re-reads the state. supported:false disables every
 * control and shows the server's note. Reads never mutate. Each action POSTs the contract body and
 * re-renders from the response body.
 *
 * The trigger sits in the composer's tools row next to the model/effort selects; the panel is a
 * fixed popover in the overlay container. The GET polls every 5 s only while the panel is open.
 * A pane change re-reads once, even with the panel closed, because the trigger's dot belongs to the
 * selected pane. The pure helpers (interval parse/humanise, the four request-body builders, the
 * state-line formatter) are exported through module.exports for _scratch/heartbeat/verify-u2.js;
 * in the browser the module registers through the standard §3 pattern and app.js mounts it with
 * the other lib modules.
 */
(function (global, factory) {
  'use strict';
  var pure = factory();
  if (typeof module !== 'undefined' && module && module.exports) module.exports = pure;   // Node (the scratch verifier)
  if (!global || !global.document) return;                                                // Node: the pure helpers are the export

  /* ── the module (browser) ────────────────────────────────────────────────── */

  var HD = (global.HD = global.HD || {});
  var document = global.document;
  var ID = 'heartbeat';
  var TITLE = 'Heartbeat';
  var ROUTE = '/api/heartbeat';
  var POLL_MS = pure.POLL_MS;
  var REQ_TIMEOUT_MS = pure.REQ_TIMEOUT_MS;
  var PENDING_RECHECK_MS = 3000;         // one quicker re-read after a pending write
  var ACTION_LABEL = { set: '设置/替换', pause: '暂停', resume: '恢复', clear: '清除' };

  /* ── small helpers ───────────────────────────────────────────────────────── */

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined && text !== null) d.textContent = String(text);
    return d;
  }
  function txt(v) { return (v === undefined || v === null) ? '' : String(v); }
  function has(v) { return v !== undefined && v !== null && v !== ''; }
  function errText(err) {
    if (!err) return 'the request failed';
    var code = has(err.code) ? txt(err.code) + ': ' : '';
    return code + (has(err.message) ? txt(err.message) : 'the request failed');
  }
  function shield(target) {
    /* typing an interval or a prompt is never a command to the dashboard behind the panel */
    ['keydown', 'keyup', 'keypress'].forEach(function (type) {
      target.addEventListener(type, function (ev) { if (ev.stopPropagation) ev.stopPropagation(); }, true);
      target.addEventListener(type, function (ev) { if (ev.stopPropagation) ev.stopPropagation(); });
    });
  }

  /* ── one instance per page ───────────────────────────────────────────────── */

  function createHeartbeat(ctx) {
    var events = (ctx && ctx.events) || null;
    var container = null;
    var overlayHost = null;
    var btn = null;
    var dot = null;
    var panel = null;
    var badgeEl = null;
    var paneEl = null;
    var noteEl = null;
    var stateEl = null;
    var intervalEl = null;
    var promptEl = null;
    var statusEl = null;
    var actions = {};                 // action -> button
    var mounted = false;
    var unmounted = false;
    var built = false;
    var open = false;
    var pane = null;
    var view = null;                  // last good GET body
    var err = null;
    var lastAction = null;
    var pend = null;                  // {excerpt} while the server reports pending
    var busy = false;                 // one request at a time (read or write)
    var again = false;                // a refresh arrived while one was in flight
    var seq = 0;                      // keeps a stale response from overwriting a newer pane
    var pollTimer = null;
    var recheckTimer = null;
    var controllers = [];
    var offSelect = null;
    var offVisibility = null;

    function safeContainer() {
      var host = document.getElementById('composerTools');
      if (host && host.appendChild) return host;
      try {
        if (ctx && ctx.ui && typeof ctx.ui.container === 'function') {
          var c = ctx.ui.container();
          if (c && c.appendChild) return c;
        }
      } catch (e) { /* fall through */ }
      return document.body;
    }
    function safeOverlay() {
      try {
        if (ctx && ctx.ui && typeof ctx.ui.container === 'function') {
          var c = ctx.ui.container();
          if (c && c.appendChild) return c;
        }
      } catch (e) { /* fall through */ }
      return document.body;
    }
    function selectedPaneId() {
      try { return (ctx && ctx.state && ctx.state.selectedPaneId) || null; }
      catch (e) { return null; }
    }
    function supported() { return !(view && view.supported === false); }

    /* ── one request, with an AbortController and a deadline (never a hung panel) ── */
    function request(method, url, payload) {
      var fetchFn = (typeof global.fetch === 'function') ? global.fetch : null;
      if (!fetchFn) return Promise.resolve({ ok: false, error: { code: 'no_fetch', message: 'this page has no fetch()' } });
      var ctrl = null;
      try { if (global.AbortController) ctrl = new global.AbortController(); } catch (e) { ctrl = null; }
      if (ctrl) controllers.push(ctrl);
      var opts = { headers: { accept: 'application/json' } };
      if (payload) {
        opts.method = 'POST';
        opts.headers['content-type'] = 'application/json';
        try { opts.body = JSON.stringify(payload); } catch (e) { opts.body = '{}'; }
      }
      if (ctrl) opts.signal = ctrl.signal;
      return new Promise(function (resolve) {
        var settled = false;
        var timedOut = false;
        var timer = null;
        function done(r) {
          if (settled) return;
          settled = true;
          if (timer !== null) { try { global.clearTimeout(timer); } catch (e) { /* gone */ } timer = null; }
          if (ctrl) { var i = controllers.indexOf(ctrl); if (i >= 0) controllers.splice(i, 1); }
          resolve(r);
        }
        try {
          timer = global.setTimeout(function () {
            timedOut = true;
            if (ctrl && ctrl.abort) { try { ctrl.abort(); } catch (e) { /* gone */ } }
            done({ ok: false, error: { code: 'timeout', message: 'the request timed out after ' + Math.round(REQ_TIMEOUT_MS / 1000) + 's' } });
          }, REQ_TIMEOUT_MS);
        } catch (e) { timer = null; }
        var p;
        try { p = fetchFn(url, opts); } catch (e) { done({ ok: false, error: { code: 'network', message: txt(e && e.message ? e.message : e) } }); return; }
        Promise.resolve(p).then(function (res) {
          var read = (res && typeof res.json === 'function')
            ? Promise.resolve(res.json()).then(function (b) { return b; }, function () { return null; })
            : Promise.resolve(null);
          return read.then(function (body) {
            if (res && res.ok === true && body && body.ok !== false) { done({ ok: true, body: body, status: res.status }); return; }
            var er = (body && body.error) || {};
            done({
              ok: false, body: body, status: res && res.status,
              error: {
                code: has(er.code) ? txt(er.code) : ('http_' + txt(res && res.status)),
                message: has(er.message) ? txt(er.message) : ('HTTP ' + txt(res && res.status) + ' from ' + url)
              }
            });
          });
        }, function (e) {
          if (timedOut) return;
          var aborted = !!(ctrl && ctrl.signal && ctrl.signal.aborted);
          done({ ok: false, error: { code: aborted ? 'aborted' : 'network', message: txt(e && e.message ? e.message : e) } });
        });
      });
    }

    /* ── reads ──────────────────────────────────────────────────────────────── */

    function refresh() {
      if (unmounted || !pane) return null;
      if (busy) { again = true; return null; }
      var id = pane;
      busy = true;
      var token = ++seq;
      render();
      return request('GET', ROUTE + '?pane_id=' + encodeURIComponent(id), null).then(function (res) {
        if (unmounted || token !== seq) return;
        busy = false;
        if (pane !== id) {
          again = true;                       // the selection moved while the read was in flight
        } else if (!res.ok) {
          err = errText(res.error);           // a described failure; the last view stays on screen
        } else {
          view = res.body || null;
          err = null;
        }
        render();
        if (again) { again = false; refresh(); }
      });
    }

    /* ── writes ─────────────────────────────────────────────────────────────── */

    function applyPost(body) {
      var base = view || { agent: null, supported: true, heartbeat: null };
      if (Object.prototype.hasOwnProperty.call(body || {}, 'heartbeat')) base.heartbeat = body.heartbeat;   // may be null
      view = base;
    }
    function scheduleRecheck() {
      if (recheckTimer) { try { global.clearTimeout(recheckTimer); } catch (e) { /* gone */ } }
      recheckTimer = global.setTimeout(function () {
        recheckTimer = null;
        if (!unmounted && open) refresh();
      }, PENDING_RECHECK_MS);
    }
    function act(action) {
      if (unmounted || !pane || busy || !supported()) return false;
      var body;
      if (action === 'set') {
        var v = pure.validateSet(intervalEl ? intervalEl.value : '', promptEl ? promptEl.value : '');
        if (!v.ok) { err = v.error; pend = null; lastAction = null; render(); return false; }
        body = pure.buildSetBody(pane, v.interval, v.prompt);
      } else {
        body = pure.buildActionBody(pane, action);
      }
      if (!body) return false;
      busy = true;
      err = null;
      pend = null;
      if (recheckTimer) { try { global.clearTimeout(recheckTimer); } catch (e) { /* gone */ } recheckTimer = null; }
      render();
      request('POST', ROUTE, body).then(function (res) {
        if (unmounted) return;
        busy = false;
        if (!res.ok) { err = errText(res.error); lastAction = null; render(); return; }
        var rb = res.body || {};
        applyPost(rb);
        lastAction = action + ' · ' + (has(rb.applied_via) ? txt(rb.applied_via) : 'ok');
        if (rb.pending === true) {
          pend = { excerpt: has(rb.pane_excerpt) ? txt(rb.pane_excerpt) : '' };
          scheduleRecheck();
        } else {
          pend = null;
        }
        render();
      });
      return true;
    }

    /* ── tree ───────────────────────────────────────────────────────────────── */

    function buildButton() {
      btn = el('button', 'hd-heartbeat-btn');
      btn.type = 'button';
      btn.appendChild(el('span', 'hd-heartbeat-heart', '♥'));
      btn.appendChild(el('span', 'hd-heartbeat-label', 'heartbeat'));
      dot = el('span', 'hd-heartbeat-dot');
      btn.appendChild(dot);
      btn.addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (open) close(); else openPanel();
      });
    }

    function addField(form, label, node) {
      var f = el('div', 'hd-heartbeat-field');
      f.appendChild(el('label', 'hd-heartbeat-field-label', label));
      f.appendChild(node);
      form.appendChild(f);
      return f;
    }
    function addAction(ops, action) {
      var b = el('button', 'hd-heartbeat-action' + (action === 'set' ? ' hd-heartbeat-primary' : ''), ACTION_LABEL[action]);
      b.type = 'button';
      b.setAttribute('data-action', action);
      b.addEventListener('click', function () { act(action); });
      actions[action] = b;
      ops.appendChild(b);
    }

    function ensurePanel() {
      if (built && panel) return panel;
      built = true;
      panel = el('div', 'hd-heartbeat-panel hidden');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'session heartbeat');

      var head = el('div', 'hd-heartbeat-head');
      head.appendChild(el('span', 'hd-heartbeat-heart', '♥'));
      head.appendChild(el('span', 'hd-heartbeat-title', 'heartbeat'));
      badgeEl = el('span', 'hd-heartbeat-badge');
      head.appendChild(badgeEl);
      head.appendChild(el('span', 'hd-heartbeat-spacer'));
      paneEl = el('span', 'hd-heartbeat-pane mono dim');
      head.appendChild(paneEl);
      var closeBtn = el('button', 'hd-heartbeat-icon', '×');
      closeBtn.type = 'button';
      closeBtn.title = 'close the heartbeat panel';
      closeBtn.setAttribute('aria-label', 'close the heartbeat panel');
      closeBtn.addEventListener('click', function () { close(); });
      head.appendChild(closeBtn);
      panel.appendChild(head);

      noteEl = el('div', 'hd-heartbeat-note hidden');
      panel.appendChild(noteEl);

      stateEl = el('div', 'hd-heartbeat-state');
      panel.appendChild(stateEl);

      intervalEl = document.createElement('input');
      intervalEl.type = 'text';
      intervalEl.className = 'hd-heartbeat-input';
      intervalEl.placeholder = '30m';
      intervalEl.spellcheck = false;
      intervalEl.setAttribute('aria-label', 'heartbeat interval (30m, 2h, 90s, 1d)');
      shield(intervalEl);
      addField(panel, 'interval', intervalEl);

      promptEl = document.createElement('textarea');
      promptEl.className = 'hd-heartbeat-prompt';
      promptEl.rows = 3;
      promptEl.placeholder = 'recurring instruction…';
      promptEl.spellcheck = false;
      promptEl.setAttribute('aria-label', 'heartbeat prompt');
      shield(promptEl);
      addField(panel, 'prompt', promptEl);

      var ops = el('div', 'hd-heartbeat-ops');
      addAction(ops, 'set');
      addAction(ops, 'pause');
      addAction(ops, 'resume');
      addAction(ops, 'clear');
      panel.appendChild(ops);

      statusEl = el('div', 'hd-heartbeat-status');
      statusEl.setAttribute('data-kind', 'info');
      statusEl.setAttribute('aria-live', 'polite');
      panel.appendChild(statusEl);

      return panel;
    }

    function renderTrigger() {
      if (!btn) return;
      btn.disabled = !pane;
      var state = 'none';
      if (pane) {
        if (busy && !view) state = 'loading';
        else if (view && view.supported === false) state = 'off';
        else if (view && view.heartbeat) state = (view.heartbeat.status === 'paused') ? 'paused' : 'on';
        else state = 'off';
        if (pend) state = 'pending';
      }
      btn.setAttribute('data-state', state);
      btn.setAttribute('data-open', open ? '1' : '0');
      var summary;
      if (!pane) summary = 'no pane selected';
      else if (err) summary = err;
      else if (view && view.heartbeat) summary = pure.formatStateLine(view.heartbeat);
      else if (view && view.supported === false) summary = 'this agent has no session heartbeat';
      else summary = 'no heartbeat set';
      btn.title = '♥ heartbeat — ' + summary;
    }

    function renderPanel() {
      if (!built || !panel) return;
      var sup = supported();
      var hb = (view && view.heartbeat) ? view.heartbeat : null;
      panel.setAttribute('data-supported', sup ? 'true' : 'false');
      panel.setAttribute('data-pending', pend ? '1' : '0');

      if (badgeEl) {
        var agent = (view && (view.agent === 'hermes' || view.agent === 'pi')) ? view.agent : '';
        badgeEl.textContent = agent;
        badgeEl.style.display = agent ? '' : 'none';
        if (agent) badgeEl.setAttribute('data-agent', agent);
      }
      if (paneEl) {
        paneEl.textContent = (pane || '') + ((view && has(view.session_id)) ? ' · ' + txt(view.session_id) : '');
      }
      if (noteEl) {
        var note = '';
        if (view && view.supported === false) note = has(view.note) ? txt(view.note) : 'this agent has no session heartbeat';
        else if (view && has(view.note)) note = txt(view.note);
        noteEl.textContent = note;
        noteEl.style.display = note ? '' : 'none';
        noteEl.setAttribute('data-kind', (view && view.supported === false) ? 'warn' : 'info');
      }
      if (stateEl) stateEl.textContent = hb ? pure.formatStateLine(hb) : 'no heartbeat set';
      if (intervalEl) {
        intervalEl.disabled = !pane || !sup;   // never on `busy`: a 5 s poll must not blur a focused input
        if (document.activeElement !== intervalEl) intervalEl.value = hb ? pure.formatInterval(hb.interval_seconds) : '';
      }
      if (promptEl) {
        promptEl.disabled = !pane || !sup;     // same rule — a poll in flight is not a reason to drop the caret
        if (document.activeElement !== promptEl) promptEl.value = (hb && has(hb.prompt)) ? txt(hb.prompt) : '';
      }
      var canWrite = !!pane && sup && !busy;
      if (actions.set) actions.set.disabled = !canWrite;
      if (actions.pause) actions.pause.disabled = !canWrite || !hb || hb.status === 'paused';
      if (actions.resume) actions.resume.disabled = !canWrite || !hb || hb.status !== 'paused';
      if (actions.clear) actions.clear.disabled = !canWrite || !hb;

      if (statusEl) {
        var text = '';
        var kind = 'info';
        var title = '';
        if (err) { text = err; kind = 'error'; }
        else if (pend) { text = 'applying…'; kind = 'pending'; title = pend.excerpt || 'the pane is still applying the change'; }
        else if (busy) { text = 'working…'; kind = 'pending'; }
        else if (lastAction) { text = lastAction; kind = 'ok'; }
        statusEl.textContent = text;
        statusEl.setAttribute('data-kind', kind);
        statusEl.title = title;
        statusEl.style.display = text ? '' : 'none';
      }
      panel.setAttribute('aria-busy', busy ? 'true' : 'false');
    }

    function render() {
      if (unmounted) return;
      renderTrigger();
      renderPanel();
    }

    /* ── open / close ───────────────────────────────────────────────────────── */

    function positionPanel() {
      if (!open || !panel || !btn) return;
      var r = btn.getBoundingClientRect();
      var vw = global.innerWidth || 1024;
      var pw = panel.offsetWidth || 420;
      var left = r.left;
      if (left + pw > vw - 8) left = vw - pw - 8;
      if (left < 8) left = 8;
      panel.style.left = Math.round(left) + 'px';
      panel.style.bottom = Math.round(((global.innerHeight || 768) - r.top) + 8) + 'px';
    }
    function onDocDown(ev) {
      var t = ev.target;
      if (panel && panel.contains(t)) return;
      if (btn && btn.contains(t)) return;
      close();
    }
    function onPanelKey(ev) {
      if (ev.key === 'Escape' || ev.key === 'Esc' || ev.keyCode === 27) {
        /* the panel owns Escape: consume it so keys.js's bubble phase cannot also send esc to the
           pane (its handler returns early on defaultPrevented) */
        if (ev.preventDefault) ev.preventDefault();
        if (ev.stopPropagation) ev.stopPropagation();
        close();
      }
    }
    function startPoll() {
      if (pollTimer) return;
      try { pollTimer = global.setInterval(function () { if (!document.hidden) refresh(); }, POLL_MS); }
      catch (e) { pollTimer = null; }
    }
    function stopPoll() {
      if (!pollTimer) return;
      try { global.clearInterval(pollTimer); } catch (e) { /* gone */ }
      pollTimer = null;
    }
    function openPanel() {
      if (unmounted || !pane || open) return false;
      open = true;
      ensurePanel();
      overlayHost = safeOverlay();
      if (panel.parentNode !== overlayHost) overlayHost.appendChild(panel);
      panel.classList.remove('hidden');
      positionPanel();
      document.addEventListener('mousedown', onDocDown, true);
      global.addEventListener('keydown', onPanelKey, true);
      global.addEventListener('resize', positionPanel);
      refresh();
      startPoll();
      render();
      return true;
    }
    function close() {
      if (!open) return false;
      open = false;
      stopPoll();
      if (panel) panel.classList.add('hidden');
      document.removeEventListener('mousedown', onDocDown, true);
      global.removeEventListener('keydown', onPanelKey, true);
      global.removeEventListener('resize', positionPanel);
      render();
      return true;
    }
    function toggle() { return open ? close() : openPanel(); }

    /* ── selection following ────────────────────────────────────────────────── */

    function setPane(next) {
      var id = next || null;
      if (id === pane) return false;
      pane = id;
      view = null;
      err = null;
      lastAction = null;
      pend = null;
      if (recheckTimer) { try { global.clearTimeout(recheckTimer); } catch (e) { /* gone */ } recheckTimer = null; }
      render();
      refresh();
      return true;
    }
    function followSelection() {
      if (unmounted) return false;
      return setPane(selectedPaneId());
    }
    function onVisibility() {
      if (unmounted) return;
      if (document.hidden) { stopPoll(); return; }
      if (open) { refresh(); startPoll(); }
    }

    /* ── mount / unmount ────────────────────────────────────────────────────── */

    function mount() {
      if (unmounted || mounted) return handle;
      mounted = true;
      container = safeContainer();
      overlayHost = safeOverlay();
      buildButton();
      var anchor = document.getElementById('agentEffortSel');
      if (anchor && anchor.parentNode === container) {
        if (anchor.nextSibling) container.insertBefore(btn, anchor.nextSibling);
        else container.appendChild(btn);
      } else {
        container.appendChild(btn);
      }
      try {
        if (events && typeof events.on === 'function') offSelect = events.on('select', function () { followSelection(); });
      } catch (e) { offSelect = null; }
      offVisibility = onVisibility;
      if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onVisibility);
      global.__hdHeartbeatFollowSelection = followSelection;
      pane = selectedPaneId();
      render();
      refresh();
      return handle;
    }

    function unmount() {
      if (unmounted) return false;
      unmounted = true;
      close();
      stopPoll();
      if (recheckTimer) { try { global.clearTimeout(recheckTimer); } catch (e) { /* gone */ } recheckTimer = null; }
      if (typeof offSelect === 'function') { try { offSelect(); } catch (e) { /* gone */ } }
      offSelect = null;
      if (typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onVisibility);
      for (var i = 0; i < controllers.length; i++) { try { if (controllers[i].abort) controllers[i].abort(); } catch (e) { /* gone */ } }
      controllers = [];
      if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      if (global.__hdHeartbeatFollowSelection === followSelection) {
        try { delete global.__hdHeartbeatFollowSelection; } catch (e) { global.__hdHeartbeatFollowSelection = null; }
      }
      btn = null;
      panel = null;
      built = false;
      return true;
    }

    var handle = {
      id: ID,
      mount: mount,
      unmount: unmount,
      mounted: function () { return mounted && !unmounted; },
      setPane: setPane,
      followSelection: followSelection,
      refresh: refresh,
      toggle: toggle,
      open: openPanel,
      close: close,
      state: function () {
        return {
          mounted: mounted && !unmounted,
          open: open,
          pane: pane,
          busy: busy,
          supported: supported(),
          pending: !!pend,
          poll_ms: POLL_MS,
          heartbeat: (view && view.heartbeat) ? view.heartbeat : null,
          error: err
        };
      }
    };
    return handle;
  }

  /* ── registration (the §3 pattern every module file follows) ── */

  var instance = null;
  var mod = {
    id: ID,
    title: TITLE,
    mount: function (ctx) {
      if (instance && instance.mounted()) return instance;
      if (!instance) instance = createHeartbeat(ctx || HD.ctx || {});
      return instance.mount();
    }
  };

  HD.modules = HD.modules || {};
  HD.modules[ID] = mod;
  HD.pending = HD.pending || [];
  if (HD.pending.indexOf(mod) < 0) HD.pending.push(mod);
  if (typeof HD.register === 'function') { try { HD.register(mod); } catch (e) { /* app.js reports it */ } }
  HD[ID] = mod;

  /* test seams (the scratch verifier uses module.exports; this is for a browser probe) */
  HD.heartbeatTest = {
    mount: function (ctx) { return mod.mount(ctx); },
    instance: function () { return instance; },
    state: function () { return instance ? instance.state() : null; },
    followSelection: function () { return instance ? instance.followSelection() : false; },
    refresh: function () { return instance ? instance.refresh() : null; },
    open: function () { return instance ? instance.open() : false; },
    close: function () { return instance ? instance.close() : false; },
    unmount: function () { return instance ? instance.unmount() : false; },
    pure: pure
  };
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* ── pure helpers — mirrored from hermes_cli/heartbeat.py ────────────────── */
  /* parse_interval/format_interval are the GROUND TRUTH of the contract, so the UI accepts and
     prints exactly the interval vocabulary hermes accepts: 90s, 10m, 2h, 1d, `every 2 hours`, … */

  var MIN_INTERVAL_SECONDS = 60;
  var POLL_MS = 5000;
  var REQ_TIMEOUT_MS = 8000;

  var INTERVAL_RE = /^\s*(?:every\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\s*$/i;
  var UNIT_SECONDS = {
    s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
    m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
    h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
    d: 86400, day: 86400, days: 86400
  };

  /* null = not an interval, -1 = below the 60 s floor, else seconds (same split as the python) */
  function parseInterval(text) {
    var m = (typeof text === 'string' && text) ? INTERVAL_RE.exec(text) : null;
    if (!m) return null;
    var seconds = Math.trunc(parseFloat(m[1]) * UNIT_SECONDS[m[2].toLowerCase()]);
    return seconds < MIN_INTERVAL_SECONDS ? -1 : seconds;
  }
  /* 600 -> "10m", 7200 -> "2h", 90 -> "90s", 5400 -> "90m" (format_interval's integer units) */
  function formatInterval(seconds) {
    var n = Math.trunc(Number(seconds));
    if (!isFinite(n)) n = 0;
    var units = [[86400, 'd'], [3600, 'h'], [60, 'm']];
    for (var i = 0; i < units.length; i++) {
      if (n % units[i][0] === 0) return (n / units[i][0]) + units[i][1];
    }
    return n + 's';
  }
  /* a live countdown: "45s", "2m 5s", "1h 12m", "1d 3h" */
  function humanizeCountdown(seconds) {
    var s = Math.round(Number(seconds));
    if (!isFinite(s)) return '—';
    if (s < 0) s = 0;
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return rs ? (m + 'm ' + rs + 's') : (m + 'm');
    var h = Math.floor(m / 60), rm = m % 60;
    if (h < 24) return rm ? (h + 'h ' + rm + 'm') : (h + 'h');
    var d = Math.floor(h / 24), rh = h % 24;
    return rh ? (d + 'd ' + rh + 'h') : (d + 'd');
  }
  /* the GET carries next_fire_in_seconds; when only the raw state is at hand, derive it the same
     way hermes is_due does: anchor = last_fired_at || created_at, fire when idle for the interval */
  function deriveNextFireIn(hb, nowSeconds) {
    if (!hb || hb.status !== 'active') return null;
    var iv = Number(hb.interval_seconds);
    if (!isFinite(iv) || iv <= 0) return null;
    var anchor = Number(hb.last_fired_at) || Number(hb.created_at) || 0;
    if (!anchor) return null;
    var now = (typeof nowSeconds === 'number' && isFinite(nowSeconds)) ? nowSeconds : (Date.now() / 1000);
    return Math.max(0, Math.round(anchor + iv - now));
  }
  /* one line for the panel and the trigger title:
     "active · every 10m · 18 fires · next fire in 2m 5s" */
  function formatStateLine(hb, nowSeconds) {
    if (!hb) return 'no heartbeat set';
    var parts = [];
    var paused = hb.status === 'paused';
    parts.push(paused ? 'paused' : 'active');
    var iv = Number(hb.interval_seconds);
    if (isFinite(iv) && iv > 0) parts.push('every ' + formatInterval(iv));
    var fc = Number(hb.fire_count);
    if (isFinite(fc)) parts.push(fc === 1 ? '1 fire' : fc + ' fires');
    if (paused) {
      parts.push('not firing while paused');
    } else {
      var next = (typeof hb.next_fire_in_seconds === 'number' && isFinite(hb.next_fire_in_seconds))
        ? hb.next_fire_in_seconds
        : deriveNextFireIn(hb, nowSeconds);
      parts.push(next === null ? 'next fire: —' : 'next fire in ' + humanizeCountdown(next));
    }
    return parts.join(' · ');
  }
  /* the client-side half of the contract's `set` rule: both fields, interval >= 60s */
  function validateSet(intervalText, promptText) {
    var raw = String(intervalText === undefined || intervalText === null ? '' : intervalText).trim();
    var prompt = String(promptText === undefined || promptText === null ? '' : promptText);
    if (!prompt.trim()) return { ok: false, code: 'prompt', error: 'a prompt is required' };
    var seconds = parseInterval(raw);
    if (seconds === null) return { ok: false, code: 'interval', error: 'interval looks like 30m, 2h, 90s or 1d' };
    if (seconds < 0) return { ok: false, code: 'interval', error: 'the interval must be at least 60s' };
    return { ok: true, interval: raw, seconds: seconds, prompt: prompt };
  }

  /* the four request bodies, exactly the contract's POST shape */
  function buildSetBody(paneId, interval, prompt) {
    return { pane_id: paneId, action: 'set', interval: interval, prompt: prompt };
  }
  function buildPauseBody(paneId) { return { pane_id: paneId, action: 'pause' }; }
  function buildResumeBody(paneId) { return { pane_id: paneId, action: 'resume' }; }
  function buildClearBody(paneId) { return { pane_id: paneId, action: 'clear' }; }
  function buildActionBody(paneId, action, extra) {
    var e = extra || {};
    if (action === 'set') return buildSetBody(paneId, e.interval, e.prompt);
    if (action === 'pause') return buildPauseBody(paneId);
    if (action === 'resume') return buildResumeBody(paneId);
    if (action === 'clear') return buildClearBody(paneId);
    return null;
  }

  return {
    MIN_INTERVAL_SECONDS: MIN_INTERVAL_SECONDS,
    POLL_MS: POLL_MS,
    REQ_TIMEOUT_MS: REQ_TIMEOUT_MS,
    parseInterval: parseInterval,
    formatInterval: formatInterval,
    humanizeCountdown: humanizeCountdown,
    deriveNextFireIn: deriveNextFireIn,
    formatStateLine: formatStateLine,
    validateSet: validateSet,
    buildSetBody: buildSetBody,
    buildPauseBody: buildPauseBody,
    buildResumeBody: buildResumeBody,
    buildClearBody: buildClearBody,
    buildActionBody: buildActionBody
  };
});