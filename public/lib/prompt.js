/* herdr-dash — lib/prompt.js
 *
 * Surfaces a blocked agent's pending question and lets the reader answer it without leaving the
 * page for the terminal. One poll every 3 s over EVERY pane (not just the selected one, because a
 * blocked pane hidden in another tab is exactly the pane that needs an answer): for each pane whose
 * agent_status is 'blocked' it reads GET /api/prompt and keeps the detection in a map keyed by
 * pane id. A pane that stops being blocked, or whose detect returns prompt:null, drops out of the
 * map at the next tick. The reader answers with the existing endpoints:
 *
 *   claude AskUserQuestion  POST /api/prompt/answer {answer:"<n>"}  (send_text a digit)
 *                           free text is two steps: first the option number that opens the box,
 *                           then the typed text — both awaited, in that order
 *   hermes clarify          POST /api/prompt/answer {answer:"<n>", question}  for an option, or
 *                           {answer:"<text>", free_text:true, question} for custom text. The
 *                           panel is digit/arrow driven, so the SERVER owns the keystrokes: it
 *                           re-reads the panel, selects the Other row, waits for its text box,
 *                           types, verifies and sends Enter. `question` is the card's own
 *                           question, which lets the server refuse a card the panel moved past.
 *   generic y/n             POST /api/prompt/answer {answer:"y"|"n"}
 *   pi inline picker        POST /api/prompt/answer {keys:["down",…,"enter"]}  (k downs then enter,
 *                           the picker starts on item 1)
 *   any card's esc          POST /api/prompt/answer {cancel:true}
 *
 * A card whose pane is no longer in the snapshot is REMOVED: the pane holds no
 * question any more, so the server answers `pane_not_found` and nothing is sent.
 *
 * After a successful answer the pane leaves the detection map at once (optimistic: the next tick
 * re-reads it), and its card lingers for 1.5 s as a 'sent' ghost before it is removed; a failure
 * paints the server's error inside that card and nothing is thrown. When no card is left the stack
 * element itself is removed from the DOM, so an empty overlay never sits over the transcript.
 *
 * The module registers itself like every other lib/*.js (§3) and mounts into ctx.ui.container().
 * Its CSS is injected as a <style> in ensureCss(); no separate .css file exists. Nothing here
 * touches another module's files or the server.
 */
(function () {
  'use strict';

  var HD = (window.HD = window.HD || {});
  var ID = 'prompt';
  var TITLE = 'Agent question';

  var POLL_MS = 3000;             // one fan-out every 3 s while the tab is visible
  var REQ_TIMEOUT_MS = 6000;      // a read/answer the server never answers is a described failure
  var SENT_MS = 1500;             // the 'sent' ghost's life on screen before it is removed
  var ROUTE = '/api/prompt';
  var ANSWER_ROUTE = '/api/prompt/answer';
  var CSS_ID = 'hd-prompt-css';

  var CSS = [
    '.hd-prompt-stack{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9500;',
    'display:flex;flex-direction:column;gap:8px;width:min(560px,92vw);max-height:70vh;overflow-y:auto;',
    'pointer-events:none;}',
    '.hd-prompt-card{pointer-events:auto;background:var(--bg-panel);border:1px solid var(--line);',
    'border-left:3px solid var(--accent);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.55);',
    'color:var(--fg);font-family:var(--mono);font-size:12px;line-height:1.45;padding:10px 12px;}',
    '.hd-prompt-card[data-state="error"]{border-left-color:var(--st-blocked);}',
    '.hd-prompt-card[data-state="sent"]{border-left-color:var(--st-done);opacity:.85;}',
    '.hd-prompt-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;}',
    '.hd-prompt-pane{font-weight:bold;color:var(--fg);}',
    '.hd-prompt-badge{font-size:10px;text-transform:uppercase;letter-spacing:.04em;border:1px solid var(--line);',
    'border-radius:999px;padding:1px 7px;color:var(--fg-dim);background:var(--bg-panel2);}',
    '.hd-prompt-badge[data-agent="claude"]{color:var(--accent);border-color:var(--accent);}',
    '.hd-prompt-badge[data-agent="pi"]{color:var(--st-unknown);border-color:var(--st-unknown);}',
    '.hd-prompt-badge[data-agent="hermes"]{color:var(--st-working);border-color:var(--st-working);}',
    '.hd-prompt-badge[data-agent="yn"]{color:var(--st-working);border-color:var(--st-working);}',
    '.hd-prompt-spacer{flex:1;}',
    '.hd-prompt-icon{background:var(--bg-panel2);border:1px solid var(--line);color:var(--fg-dim);',
    'border-radius:6px;font-family:inherit;font-size:11px;padding:2px 7px;cursor:pointer;}',
    '.hd-prompt-icon:hover{color:var(--fg);border-color:var(--accent);}',
    '.hd-prompt-q{color:var(--fg);margin:2px 0 8px;white-space:pre-wrap;overflow-wrap:anywhere;}',
    '.hd-prompt-ops{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;}',
    /* An option is as tall as its own text. Commands, paths and URLs carry runs with no space to
       break at, and an unwrapped run keeps the row one line high and spills out of the card, so
       the row wraps anywhere and grows downward instead of sideways. */
    '.hd-prompt-op{text-align:left;background:var(--bg-input);border:1px solid var(--line);color:var(--fg);',
    'border-radius:6px;font-family:inherit;font-size:12px;padding:5px 8px;cursor:pointer;',
    'white-space:normal;overflow-wrap:anywhere;min-width:0;}',
    '.hd-prompt-op:hover{border-color:var(--accent);background:var(--bg-panel2);}',
    '.hd-prompt-n{color:var(--fg-dim);margin-right:6px;}',
    '.hd-prompt-free{display:flex;gap:6px;align-items:center;margin-bottom:6px;}',
    '.hd-prompt-free input{flex:1;min-width:0;background:var(--bg-input);border:1px solid var(--line);',
    'color:var(--fg);border-radius:6px;font-family:inherit;font-size:12px;padding:5px 8px;}',
    '.hd-prompt-free input:focus{outline:none;border-color:var(--accent);}',
    '.hd-prompt-send{background:var(--accent);border:1px solid var(--accent);color:#06101c;font-weight:bold;',
    'border-radius:6px;font-family:inherit;font-size:12px;padding:5px 10px;cursor:pointer;}',
    '.hd-prompt-send:disabled{opacity:.5;cursor:default;}',
    '.hd-prompt-hint{color:var(--fg-dim);font-size:11px;margin-top:4px;overflow-wrap:anywhere;}',
    '.hd-prompt-status{font-size:11px;margin-top:6px;color:var(--fg-dim);overflow-wrap:anywhere;}',
    '.hd-prompt-status[data-kind="error"]{color:var(--st-blocked);}',
    '.hd-prompt-status[data-kind="sent"]{color:var(--st-done);}'
  ].join('');

  /* ── helpers ─────────────────────────────────────────────────────────────── */

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined && text !== null) d.textContent = String(text);
    return d;
  }
  function txt(v) { return (v === undefined || v === null) ? '' : String(v); }
  function has(v) { return v !== undefined && v !== null && v !== ''; }
  function typing(target) {
    if (!target) return false;
    var t = target.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || target.isContentEditable === true;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function errText(err) {
    if (!err) return 'the request failed';
    var code = has(err.code) ? txt(err.code) + ': ' : '';
    return code + (has(err.message) ? txt(err.message) : 'the request failed');
  }
  function kindLabel(kind) {
    if (kind === 'claude_ask') return 'ask';
    if (kind === 'claude_model') return 'model';
    if (kind === 'hermes_clarify') return 'clarify';
    if (kind === 'pi_picker') return 'picker';
    if (kind === 'yn') return 'yes/no';
    return 'question';
  }
  function agentOf(kind) {
    if (kind === 'claude_ask') return 'claude';
    if (kind === 'claude_model') return 'claude';
    if (kind === 'hermes_clarify') return 'hermes';
    if (kind === 'pi_picker') return 'pi';
    if (kind === 'yn') return 'yn';
    return null;
  }

  function ensureCss() {
    try {
      if (document.getElementById(CSS_ID)) return false;
      var head = document.head || (document.getElementsByTagName('head') || [])[0];
      if (!head || !head.appendChild) return false;
      var style = document.createElement('style');
      style.id = CSS_ID;
      style.type = 'text/css';
      style.textContent = CSS;
      head.appendChild(style);
      return true;
    } catch (e) { return false; }
  }

  /* ── the module ──────────────────────────────────────────────────────────── */

  function createPrompt(ctx) {
    var events = (ctx && ctx.events) || null;
    var api = (ctx && ctx.api) || null;
    var container = null;
    var root = null;
    var mounted = false;
    var unmounted = false;
    var pollTimer = null;
    var busy = false;
    var seq = 0;
    var detections = new Map();   // pane_id -> active detection (ready or read-error)
    var sent = new Map();         // pane_id -> the 1.5 s 'sent' ghost for an answered pane
    var sentTimers = {};
    var controllers = [];         // every in-flight AbortController, aborted on unmount
    var clock = function () { return Date.now(); };

    function safeContainer() {
      try {
        if (ctx && ctx.ui && typeof ctx.ui.container === 'function') {
          var c = ctx.ui.container();
          if (c && c.appendChild) return c;
        }
      } catch (e) { /* fall through */ }
      return (typeof document !== 'undefined' && document.body) ? document.body : null;
    }
    function safePanes() {
      try { return (ctx && ctx.state && typeof ctx.state.panes === 'function') ? (ctx.state.panes() || []) : []; }
      catch (e) { return []; }
    }

    /* ── one request, with an AbortController and a deadline (never a hung panel) ── */
    function request(method, url, payload) {
      var fetchFn = (typeof window.fetch === 'function') ? window.fetch : null;
      if (!fetchFn) return Promise.resolve({ ok: false, error: { code: 'no_fetch', message: 'this page has no fetch()' } });
      var ctrl = null;
      try { if (window.AbortController) ctrl = new AbortController(); } catch (e) { ctrl = null; }
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
          if (timer !== null) { try { clearTimeout(timer); } catch (e) { /* gone */ } timer = null; }
          if (ctrl) { var i = controllers.indexOf(ctrl); if (i >= 0) controllers.splice(i, 1); }
          resolve(r);
        }
        try {
          timer = window.setTimeout(function () {
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

    /* ── detections ──────────────────────────────────────────────────────────── */

    function makeDetection(paneId, prompt, prev) {
      var kind = txt(prompt.kind);
      var same = prev && !prev.error && prev.kind === kind && prev.question === txt(prompt.question);
      return {
        pane_id: paneId,
        at: same ? prev.at : clock(),
        seq: same ? prev.seq : (++seq),
        status: 'ready',
        /* A failed send stays on the card while the same panel is up: the reader must see why
           nothing was answered instead of a card that silently looks untouched. */
        _error: same ? (prev._error || null) : null,
        kind: kind,
        agent: agentOf(kind),
        question: txt(prompt.question),
        options: Array.isArray(prompt.options) ? prompt.options : [],
        free_text: !!prompt.free_text,
        free_text_n: (prompt.free_text_n === undefined || prompt.free_text_n === null) ? null : prompt.free_text_n,
        highlight_n: (prompt.highlight_n === undefined || prompt.highlight_n === null) ? null : prompt.highlight_n,
        answer_hint: txt(prompt.answer_hint)
      };
    }
    function errorDetection(paneId, err) {
      return { pane_id: paneId, at: clock(), seq: (++seq), status: 'ready', error: err || { code: 'unknown', message: 'the read failed' } };
    }

    /* read one pane and fold the answer into the map. An error keeps a card so the failure is
       visible; a pane whose server-echoed id is not the one asked for is refused the same way. */
    function detectPane(paneId) {
      return request('GET', ROUTE + '?pane_id=' + encodeURIComponent(paneId), null).then(function (res) {
        if (unmounted) return res;
        if (!res.ok) { detections.set(paneId, errorDetection(paneId, res.error)); return res; }
        var body = res.body;
        if (body && has(body.pane_id) && txt(body.pane_id) !== txt(paneId)) {
          detections.set(paneId, errorDetection(paneId, { code: 'pane_mismatch', message: 'the server answered for ' + txt(body.pane_id) + ' while ' + txt(paneId) + ' was asked' }));
          return res;
        }
        if (!body || !body.prompt) { detections.delete(paneId); return res; }
        detections.set(paneId, makeDetection(paneId, body.prompt, detections.get(paneId)));
        return res;
      });
    }

    /* panes the reader opened a selector on (e.g. claude /model) sit at agent_status 'done',
       not 'blocked', so the blocked-only poll never sees them. watch() adds such a pane to the
       poll set for a while; a pane whose selector is answered or dismissed drops out when its
       detection resolves to no-prompt. */
    var watched = {};                              // pane_id -> expiry (clock ms)
    var WATCH_MS = 120000;
    function watch(paneId) {
      if (!paneId) return false;
      watched[paneId] = clock() + WATCH_MS;
      poll();                                      // read it at once, not after a full cadence
      return true;
    }

    /* one poll over every blocked pane plus every watched pane; panes that stopped being
       blocked AND are not watched leave the map here */
    function poll() {
      if (unmounted || busy || document.hidden) return Promise.resolve();
      var panes = safePanes();
      var now = clock();
      var target = [];
      var targetIds = {};
      for (var i = 0; i < panes.length; i++) {
        var p = panes[i];
        if (!p || !p.pane_id) continue;
        var isBlocked = p.agent_status === 'blocked';
        var isWatched = watched[p.pane_id] !== undefined && watched[p.pane_id] > now;
        /* a pane that already shows a question stays in the poll set even when its status leaves
           'blocked': herdr's state rules for an agent can flip to working while a panel still
           waits (one clarify call can carry several questions), and the detector — not the
           status — decides when the question is gone */
        var isAsked = detections.has(p.pane_id);
        /* hermes draws its clarify panel and keeps waiting while herdr still reports 'working':
           for that family the row-level interrupt rule wins over the clarification rule, so the
           status cannot be used to decide whether a question is on screen. Poll hermes panes in
           'working' as well — the detector decides, and a pane whose read finds no prompt drops
           out on the next pass. pi/claude working panes stay out: they never hold a panel in that
           state, and reading them mid-run would only cost a pane.read. */
        var isHermesWorking = p.agent === 'hermes' && p.agent_status === 'working';
        if (isBlocked || isWatched || isAsked || isHermesWorking) { target.push(p.pane_id); targetIds[p.pane_id] = true; }
      }
      /* expire stale watches */
      for (var w in watched) { if (Object.prototype.hasOwnProperty.call(watched, w) && watched[w] <= now) delete watched[w]; }
      /* a detection whose pane is not in the snapshot has nothing left to answer: the
         pane died, so the card goes with it (runs before the reads, so a dead pane is
         never read and never painted as an error) */
      detections.forEach(function (d, id) { if (!targetIds[id]) detections.delete(id); });
      var jobs = [];
      for (var j = 0; j < target.length; j++) {
        var id = target[j];
        if (sent.has(id)) continue;               // a pane whose answer was just sent is not re-asked mid-fade
        jobs.push(detectPane(id));
      }
      if (!jobs.length) { render(); return Promise.resolve(); }
      busy = true;
      return Promise.all(jobs).then(function () { busy = false; render(); }, function () { busy = false; render(); });
    }

    /* ── answering ───────────────────────────────────────────────────────────── */

    function setCardError(paneId, err) {
      var d = detections.get(paneId);
      if (!d) { d = { pane_id: paneId, at: clock(), seq: (++seq), status: 'ready' }; detections.set(paneId, d); }
      d._sending = false;
      d._error = errText(err);
    }
    /* the pane is gone from herdr's snapshot: there is no question left to answer, so
       the card is removed instead of kept as an error the reader would keep clicking */
    function dropCard(paneId) {
      detections.delete(paneId);
      delete watched[paneId];
      if (unmounted) return;
      render();
    }
    function postRaw(paneId, payload) {
      var body = { pane_id: paneId };
      if (payload) for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k];
      return request('POST', ANSWER_ROUTE, body).then(function (res) {
        if (res && res.ok && res.body && has(res.body.pane_id) && txt(res.body.pane_id) !== txt(paneId)) {
          return { ok: false, error: { code: 'pane_mismatch', message: 'the server answered for ' + txt(res.body.pane_id) + ' while ' + txt(paneId) + ' was asked' } };
        }
        return res;
      });
    }
    /* optimistic: on success the pane leaves the detection map and its card becomes a 'sent' ghost */
    function markSent(paneId, action) {
      var d = detections.get(paneId);
      detections.delete(paneId);
      /* keep reading the pane for a while: a batch clarify shows its next question the moment one
         is answered, and the pane may not be reported blocked again for it */
      watch(paneId);
      sent.set(paneId, {
        pane_id: paneId, at: d ? d.at : clock(), sentAt: clock(), seq: d ? d.seq : (++seq),
        status: 'sent', action: action || 'answer', agent: d ? d.agent : null, kind: d ? d.kind : null
      });
      if (sentTimers[paneId]) { try { clearTimeout(sentTimers[paneId]); } catch (e) { /* gone */ } }
      sentTimers[paneId] = setTimeout(function () {
        delete sentTimers[paneId];
        sent.delete(paneId);
        if (!unmounted) render();
      }, SENT_MS);
    }
    function post(paneId, payload) {
      return postRaw(paneId, payload).then(function (res) {
        if (unmounted) return res;
        if (!res || !res.ok) {
          if (res && res.error && res.error.code === 'pane_not_found') { dropCard(paneId); return res; }
          setCardError(paneId, res && res.error); render(); return res;
        }
        markSent(paneId, payload && payload.cancel ? 'cancel' : 'answer');
        render();
        return res;
      });
    }

    function answerOption(d, opt) {
      if (!opt) return;
      if (d.kind === 'yn') { post(d.pane_id, { answer: /^(y|yes)/i.test(txt(opt.label)) ? 'y' : 'n' }); return; }
      /* claude AskUserQuestion maps a typed digit to the numbered item */
      if (d.kind === 'claude_ask') { post(d.pane_id, { answer: String(opt.n) }); return; }
      /* hermes' clarify panel is digit-driven and the SERVER owns the keystrokes: it
         re-reads the panel itself and picks the option there, so a card the panel has
         already moved past is refused instead of answering the next question by mistake.
         `question` is the card's own question — the staleness check, not the mechanism. */
      if (d.kind === 'hermes_clarify') { post(d.pane_id, { answer: String(opt.n), question: d.question }); return; }
      /* claude's /model picker ignores typed digits and opens with the highlight on the CURRENT
         model, so the answer is a relative arrow walk from that highlight to the target row,
         then enter (one enter both picks and confirms — verified live) */
      if (d.kind === 'claude_model') {
        var from = (d.highlight_n !== null && d.highlight_n !== undefined) ? d.highlight_n : 1;
        var delta = (opt.n || 1) - from;
        var keys = [];
        var step = delta >= 0 ? 'down' : 'up';
        for (var k = 0; k < Math.abs(delta); k++) keys.push(step);
        keys.push('enter');
        post(d.pane_id, { keys: keys });
        return;
      }
      /* the pi inline picker is the panel with no numbered hot-keys: an absolute option
         number becomes k downs + enter from its first row */
      answerByKeys(d.pane_id, (opt.n || 1) - 1);
    }
    function answerByKeys(paneId, downs) {
      var keys = [];
      for (var i = 0; i < downs; i++) keys.push('down');
      keys.push('enter');
      post(paneId, { keys: keys });
    }
    function answerPicker(paneId, index) {
      answerByKeys(paneId, index);
    }
    /* free text takes the path the agent actually supports, per family:
       - hermes clarify: ONE server call. The panel needs the Other row selected, its text
         box waited for, the text typed, verified and Enter pressed; doing that here split the
         sequence across requests and left a failure half-applied. The server does the whole
         sequence and answers with an error when a step does not verify.
       - claude AskUserQuestion: "Type something" commits the moment it is selected and never
         opens a box (verified live) — so: esc to release the pane, then a normal agent.prompt.
       A blocked pane refuses agent.prompt, hence the esc first for claude. */
    function answerFreeText(d, value) {
      var v = txt(value);
      if (!v.trim()) return;
      d._sending = true;
      d._error = null;
      render();
      var chain;
      if (d.kind === 'hermes_clarify') {
        chain = postRaw(d.pane_id, { answer: v, free_text: true, question: d.question });
      } else {
        /* claude (and the safest default): esc, wait for the pane to unblock, then prompt */
        chain = postRaw(d.pane_id, { cancel: true }).then(function (res) {
          if (!res || !res.ok) return res;
          return new Promise(function (resolve) { setTimeout(resolve, 800); }).then(function () {
            if (!api || typeof api.prompt !== 'function') return { ok: false, error: { code: 'no_prompt_api', message: 'ctx.api.prompt is not available' } };
            return api.prompt(d.pane_id, v);
          });
        });
      }
      chain.then(function (res) {
        if (unmounted) return;
        d._sending = false;
        if (!res || !res.ok) {
          if (res && res.error && res.error.code === 'pane_not_found') { dropCard(d.pane_id); return; }
          setCardError(d.pane_id, res && res.error); render(); return;
        }
        markSent(d.pane_id, 'answer');
        render();
      });
    }

    /* ── the tree ────────────────────────────────────────────────────────────── */

    function buildHead(d, sending, card) {
      var head = el('div', 'hd-prompt-head');
      head.appendChild(el('span', 'hd-prompt-pane', d.pane_id));
      var agent = d.agent || agentOf(d.kind);
      if (agent) { var b = el('span', 'hd-prompt-badge', agent); b.setAttribute('data-agent', agent); head.appendChild(b); }
      if (has(d.kind)) { var kb = el('span', 'hd-prompt-badge', kindLabel(d.kind)); kb.setAttribute('data-kind', d.kind); head.appendChild(kb); }
      head.appendChild(el('span', 'hd-prompt-spacer'));
      var focus = el('button', 'hd-prompt-icon', 'view pane');
      focus.type = 'button';
      focus.title = 'select this pane in the main view';
      focus.addEventListener('click', function () {
        try { if (ctx && ctx.ui && typeof ctx.ui.selectPane === 'function') ctx.ui.selectPane(d.pane_id); } catch (e) { /* nothing to do */ }
      });
      head.appendChild(focus);
      var esc = el('button', 'hd-prompt-icon', 'esc');
      esc.type = 'button';
      esc.title = 'cancel the question (sends esc)';
      esc.disabled = !!sending;
      esc.addEventListener('click', function () { if (!sending) post(d.pane_id, { cancel: true }); });
      head.appendChild(esc);
      card.appendChild(head);
    }

    function buildCard(d) {
      var sending = d.status === 'sent' || !!d._sending;
      var card = el('div', 'hd-prompt-card');
      card.setAttribute('data-pane', txt(d.pane_id));
      card.setAttribute('data-state', d.status || 'ready');
      buildHead(d, sending, card);

      if (d.error) {
        card.appendChild(el('div', 'hd-prompt-q', 'could not read this pane’s question: ' + errText(d.error)));
        return card;
      }

      if (has(d.question)) card.appendChild(el('div', 'hd-prompt-q', d.question));

      var options = Array.isArray(d.options) ? d.options : [];
      if (options.length) {
        var ops = el('div', 'hd-prompt-ops');
        for (var i = 0; i < options.length; i++) {
          (function (idx, opt) {
            opt = opt || {};
            var btn = el('button', 'hd-prompt-op');
            btn.type = 'button';
            btn.disabled = !!sending;
            if (d.kind !== 'pi_picker' && opt.n !== undefined && opt.n !== null) {
              btn.appendChild(el('span', 'hd-prompt-n', String(opt.n) + '.'));
            } else {
              btn.appendChild(el('span', 'hd-prompt-n', String(idx + 1) + '.'));
            }
            btn.appendChild(document.createTextNode(' ' + txt(opt.label)));
            btn.addEventListener('click', function () {
              if (sending) return;
              if (d.kind === 'pi_picker') answerPicker(d.pane_id, idx);
              else answerOption(d, opt);
            });
            ops.appendChild(btn);
          })(i, options[i]);
        }
        if (d.kind === 'pi_picker') {
          var cancel = el('button', 'hd-prompt-op');
          cancel.type = 'button';
          cancel.disabled = !!sending;
          cancel.appendChild(el('span', 'hd-prompt-n', '·'));
          cancel.appendChild(document.createTextNode(' cancel (esc)'));
          cancel.addEventListener('click', function () { if (!sending) post(d.pane_id, { cancel: true }); });
          ops.appendChild(cancel);
        }
        card.appendChild(ops);
      }

      if (d.free_text && d.status !== 'sent') {
        var free = el('div', 'hd-prompt-free');
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'hd-prompt-input';
        input.placeholder = 'type an answer…';
        input.disabled = !!sending;
        /* capture-phase, and stopImmediatePropagation on top: a keystroke typed into this answer
           box must never reach the global handlers (keys.js's capture listener, chatview's `t`
           toggle) — typing an answer is not a command to the dashboard behind the card */
        input.addEventListener('keydown', function (ev) {
          if (ev.stopPropagation) ev.stopPropagation();
          /* Enter does NOT send — an answer goes only through the send button. Enter here is
             just a keystroke that must not leak to the dashboard behind the card. */
          if (ev.key === 'Enter') { ev.preventDefault(); }
        }, true);
        input.addEventListener('keydown', function (ev) {
          if (ev.stopPropagation) ev.stopPropagation();
        });
        input.addEventListener('keyup', function (ev) { if (ev.stopPropagation) ev.stopPropagation(); }, true);
        input.addEventListener('keypress', function (ev) { if (ev.stopPropagation) ev.stopPropagation(); }, true);
        /* a render skipped while this input was focused is made good the moment it blurs —
           EXCEPT when the blur is the mousedown of this card's own Send button: rendering
           then tears the button out of the DOM before its click event fires, and the click
           is the only way an answer is sent (Enter is deliberately inert). That made Send
           look dead (live report, 2026-10-26). The next poll renders anyway, so skipping
           one render here costs nothing. */
        input.addEventListener('blur', function () {
          var next = document.activeElement;
          if (next && next.classList && next.classList.contains('hd-prompt-send')) return;
          render();
        });
        var send = el('button', 'hd-prompt-send', 'send');
        send.type = 'button';
        send.disabled = !!sending;
        send.addEventListener('click', function () { answerFreeText(d, input.value); });
        free.appendChild(input);
        free.appendChild(send);
        card.appendChild(free);
      }

      if (has(d.answer_hint) && d.status !== 'sent') card.appendChild(el('div', 'hd-prompt-hint', d.answer_hint));

      if (d.status === 'sent') {
        var st = el('div', 'hd-prompt-status', d.action === 'cancel' ? 'cancelled' : 'sent');
        st.setAttribute('data-kind', 'sent');
        card.appendChild(st);
      } else if (d._sending) {
        card.appendChild(el('div', 'hd-prompt-status', 'sending…'));
      } else if (d._error) {
        var es = el('div', 'hd-prompt-status', d._error);
        es.setAttribute('data-kind', 'error');
        card.appendChild(es);
      }
      return card;
    }

    function render() {
      if (unmounted || !container) return;
      var cards = [];
      detections.forEach(function (d) { cards.push(d); });
      sent.forEach(function (s) { cards.push(s); });
      // newest first: the most recently detected / answered pane on top
      cards.sort(function (a, b) { return (b.at || 0) - (a.at || 0) || (b.seq || 0) - (a.seq || 0); });
      if (!cards.length) {
        if (root && root.parentNode) root.parentNode.removeChild(root);
        return;
      }
      if (!root) {
        root = el('div', 'hd-prompt-stack');
        root.setAttribute('role', 'region');
        root.setAttribute('aria-label', 'pending agent questions');
      }
      /* IME safety: while the reader is typing into any answer input — above all mid-
         composition (a Chinese IME holds the text in a composition session that tearing the
         input out of the DOM would silently drop) — do NOT rebuild the stack. The next render
         after the input blurs catches the stack up. This replaces an earlier save/restore of
         the draft text, which kept the value but still killed the composition. */
      var active = document.activeElement;
      if (root && active && active.classList && active.classList.contains('hd-prompt-input')) {
        return;
      }
      clear(root);
      for (var i = 0; i < cards.length; i++) {
        var card = buildCard(cards[i]);
        if (i === 0) card.setAttribute('data-first', '1');
        root.appendChild(card);
      }
      if (!root.parentNode) container.appendChild(root);
    }

    /* ── keyboard ────────────────────────────────────────────────────────────── */

    function registerKeys() {
      try {
        if (events && typeof events.emit === 'function') {
          events.emit('keys.register', { id: ID, keys: ['mod+a'], help: 'focus the first pending agent question' });
        }
      } catch (e) { /* the help overlay is optional */ }
    }
    function firstControl() {
      if (!root || !root.parentNode || !root.querySelector) return null;
      var card = root.querySelector('.hd-prompt-card');
      if (!card) return null;
      var preferred = card.querySelectorAll('.hd-prompt-op, .hd-prompt-input, .hd-prompt-send');
      for (var i = 0; i < preferred.length; i++) if (!preferred[i].disabled) return preferred[i];
      var all = card.querySelectorAll('button, input, [tabindex]');
      for (var j = 0; j < all.length; j++) if (!all[j].disabled) return all[j];
      return null;
    }
    function onKey(e) {
      if (unmounted || e.defaultPrevented) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key !== 'a' && e.key !== 'A') return;
      if (typing(e.target)) return;                 // never steal a key while the reader is typing
      var c = firstControl();
      if (!c) return;
      if (e.preventDefault) e.preventDefault();
      try { c.focus(); } catch (err) { /* a detached node */ }
    }

    /* ── cadence ─────────────────────────────────────────────────────────────── */

    function start() {
      if (unmounted || pollTimer) return;
      try { pollTimer = window.setInterval(function () { poll(); }, POLL_MS); } catch (e) { pollTimer = null; }
    }
    function stop() {
      if (!pollTimer) return;
      try { window.clearInterval(pollTimer); } catch (e) { /* gone */ }
      pollTimer = null;
    }
    function onVisibility() {
      if (unmounted) return;
      if (document.hidden) { stop(); return; }
      poll();
      start();
    }

    function mount() {
      if (unmounted) return handle;
      if (mounted) return handle;
      mounted = true;
      container = safeContainer();
      ensureCss();
      registerKeys();
      if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onVisibility);
      if (typeof window.addEventListener === 'function') window.addEventListener('keydown', onKey);
      render();
      poll();
      start();
      return handle;
    }

    function unmount() {
      if (unmounted) return false;
      unmounted = true;
      stop();
      if (typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onVisibility);
      if (typeof window.removeEventListener === 'function') window.removeEventListener('keydown', onKey);
      for (var id in sentTimers) { if (Object.prototype.hasOwnProperty.call(sentTimers, id)) { try { clearTimeout(sentTimers[id]); } catch (e) { /* gone */ } } }
      sentTimers = {};
      for (var i = 0; i < controllers.length; i++) { try { if (controllers[i].abort) controllers[i].abort(); } catch (e) { /* gone */ } }
      controllers = [];
      detections.clear();
      sent.clear();
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null;
      return true;
    }

    /* test seams: one read+parse for a pane, and how many cards are on screen */
    function __detect(paneId) {
      if (!paneId) return Promise.resolve({ ok: false, error: { code: 'bad_request', message: 'a pane id is required' } });
      return request('GET', ROUTE + '?pane_id=' + encodeURIComponent(paneId), null).then(function (res) {
        if (unmounted) return res;
        if (!res.ok) { detections.set(paneId, errorDetection(paneId, res.error)); render(); return res; }
        var body = res.body;
        if (body && has(body.pane_id) && txt(body.pane_id) !== txt(paneId)) {
          detections.set(paneId, errorDetection(paneId, { code: 'pane_mismatch', message: 'the server answered for ' + txt(body.pane_id) + ' while ' + txt(paneId) + ' was asked' }));
          render();
          return res;
        }
        if (!body || !body.prompt) { detections.delete(paneId); render(); return { ok: true, body: body, prompt: null }; }
        detections.set(paneId, makeDetection(paneId, body.prompt, detections.get(paneId)));
        render();
        return { ok: true, body: body, prompt: body.prompt };
      });
    }

    var handle = {
      id: ID,
      mount: mount,
      unmount: unmount,
      mounted: function () { return mounted && !unmounted; },
      poll: function () { return poll(); },
      render: function () { render(); return true; },
      state: function () {
        return {
          mounted: mounted && !unmounted,
          poll_ms: POLL_MS,
          paused: !!document.hidden,
          detections: detections.size,
          sent: sent.size,
          panes: Array.from(detections.keys())
        };
      },
      watch: function (paneId) { return watch(paneId); },
      __detect: __detect,
      __count: function () { return detections.size + sent.size; },
      __setClock: function (fn) { if (typeof fn === 'function') clock = fn; return true; }
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
      if (!instance) instance = createPrompt(ctx || HD.ctx || {});
      return instance.mount();
    }
  };

  HD.modules = HD.modules || {};
  HD.modules[ID] = mod;
  HD.pending = HD.pending || [];
  if (HD.pending.indexOf(mod) < 0) HD.pending.push(mod);
  if (typeof HD.register === 'function') { try { HD.register(mod); } catch (e) { /* app.js reports it */ } }
  window.HD[ID] = mod;

  window.HD.promptTest = {
    mount: function (ctx) { return mod.mount(ctx); },
    instance: function () { return instance; },
    detect: function (paneId) { return instance ? instance.__detect(paneId) : Promise.resolve(null); },
    watch: function (paneId) { return instance ? instance.watch(paneId) : false; },
    count: function () { return instance ? instance.__count() : 0; },
    state: function () { return instance ? instance.state() : null; },
    unmount: function () { return instance ? instance.unmount() : false; },
    pollMs: function () { return POLL_MS; }
  };
})();