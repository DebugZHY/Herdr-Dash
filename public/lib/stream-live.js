/* herdr-dash — lib/stream-live.js (W2, stream-round §3 / §7)
 *
 * The ephemeral live turn: an EventSource on GET /api/agent-stream that renders the
 * in-flight assistant text, reasoning and tool cards AFTER the last /api/chat record.
 *
 * The record stays authoritative. This module never writes into the record view: it
 * owns one slot element at the end of the chat list, and chatview removes it (retire)
 * the moment a final record for the turn arrives. If the bridge is absent (no file,
 * no SSE, claude) nothing here renders and the chip says `records`.
 *
 * Everything is plain text: every string from the stream is model/tool data and goes
 * in through textContent (text-node data for appends). There is no innerHTML here at
 * all — not even to clear.
 *
 * Wire (contract §3/§6): the server sends named SSE events.
 *   `stream`         one JSON envelope per data line (the only source of content)
 *   `stream.ready`   {pane_id, file, agent} once a sink file is found
 *   `stream.reset`   a newer turn file appeared; drop the live turn
 *   `stream.waiting` {reason} no sink yet; chip says `records`
 * Envelope types handled: turn_start, message_start, text_delta, text_end,
 * reasoning_delta, reasoning_end, tool_call_start/delta/end, tool_start/update/end,
 * message_end, turn_end, settings, error.
 *
 * Dedupe: (session_id, turn_id, seq) — seq may restart with a new writer process, so
 * the turn id is part of the key. A duplicate is dropped; malformed lines are counted
 * and never throw.
 *
 * Flush: deltas are coalesced. At most one flush per FLUSH_MIN_MS (33 ms ≈ 30/s),
 * scheduled on requestAnimationFrame when available, otherwise setTimeout.
 */
(function (root) {
  'use strict';

  var MAX_TEXT_BYTES = 200 * 1024;   // per live turn (§7)
  var MAX_TOOLS = 200;               // per live turn
  var MAX_SEEN = 4096;               // dedupe keys retained per connection
  var FLUSH_MIN_MS = 33;             // <= 30 DOM flushes per second
  var MAX_ARGS_CHARS = 4096;
  var MAX_RESULT_CHARS = 8192;
  var MAX_PARTIAL_CHARS = 4096;
  var KNOWN_TYPES = {
    turn_start: 1, message_start: 1, text_delta: 1, text_end: 1,
    reasoning_delta: 1, reasoning_end: 1, tool_call_start: 1, tool_call_delta: 1,
    tool_call_end: 1, tool_start: 1, tool_update: 1, tool_end: 1,
    message_end: 1, turn_end: 1, settings: 1, error: 1
  };

  var encoder = (typeof TextEncoder === 'function') ? new TextEncoder() : null;

  function byteLen(s) {
    if (!s) return 0;
    if (encoder) return encoder.encode(s).length;
    return s.length;                        // conservative enough when UTF-8 counting is unavailable
  }

  function clip(s, max) {
    var v = (s === undefined || s === null) ? '' : String(s);
    return v.length > max ? v.slice(0, max) : v;
  }

  function sliceToBytes(s, maxBytes) {
    if (!s) return '';
    if (byteLen(s) <= maxBytes) return s;
    var lo = 0, hi = s.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (byteLen(s.slice(0, mid)) <= maxBytes) lo = mid; else hi = mid - 1;
    }
    return s.slice(0, lo);
  }

  function now() { return Date.now(); }

  /** A fresh live state. Pure data; no DOM, no timers. */
  function newState(opts) {
    var o = opts || {};
    return {
      paneId: o.paneId ? String(o.paneId) : '',
      sessionId: o.sessionId ? String(o.sessionId) : '',
      agent: o.agent ? String(o.agent) : '',
      status: 'records',          // records | live | reconnecting (§7 chip)
      waiting: '',
      connected: false,
      turn: null,
      seen: {}, seenOrder: [],
      events: 0, duplicates: 0, malformed: 0, unknown: 0, outOfSession: 0,
      droppedTools: 0,
      lastEventAt: 0, lastError: '',
      settings: null,
      model: ''
    };
  }

  function newTurn(ev) {
    return {
      id: ev.turn_id ? String(ev.turn_id) : ('turn@' + now()),
      index: (typeof ev.turn_index === 'number') ? ev.turn_index : null,
      startedAt: (typeof ev.ts === 'number') ? ev.ts : now(),
      messages: [],
      byId: {},
      tools: {},
      toolCount: 0,
      ended: false,
      endStatus: '',
      textBytes: 0,
      truncated: false
    };
  }

  function newMessage(id, role, model) {
    return {
      id: id, role: role || 'assistant', model: model || '',
      text: '', reasoning: '', tools: [],
      done: false,
      textTruncated: false, reasoningTruncated: false
    };
  }

  function keyOf(ev, sessionId) {
    return String(ev.session_id || sessionId || '') + '|' + String(ev.turn_id || '') +
      '|' + String(ev.seq);
  }

  function seenRecently(state, key) {
    return Object.prototype.hasOwnProperty.call(state.seen, key);
  }

  function remember(state, key) {
    state.seen[key] = 1;
    state.seenOrder.push(key);
    if (state.seenOrder.length > MAX_SEEN) {
      var drop = state.seenOrder.length - MAX_SEEN;
      for (var i = 0; i < drop; i += 1) delete state.seen[state.seenOrder[i]];
      state.seenOrder = state.seenOrder.slice(drop);
    }
  }

  function messageFor(turn, id, create, model) {
    var mid = id ? String(id) : 'm0';
    var m = turn.byId[mid];
    if (!m && create) {
      m = newMessage(mid, 'assistant', model);
      turn.byId[mid] = m;
      turn.messages.push(m);
    }
    return m || null;
  }

  function appendText(turn, msg, delta) {
    if (msg.textTruncated) return;
    var room = MAX_TEXT_BYTES - turn.textBytes;
    if (room <= 0) { msg.textTruncated = true; turn.truncated = true; return; }
    var d = (delta === undefined || delta === null) ? '' : String(delta);
    if (!d) return;
    var b = byteLen(d);
    if (b > room) {
      d = sliceToBytes(d, room);
      msg.textTruncated = true;
      turn.truncated = true;
    }
    if (!d) return;
    msg.text += d;
    turn.textBytes += byteLen(d);
  }

  function setTool(turn, id, patch) {
    var key = String(id || '');
    var tool = turn.tools[key];
    if (!tool) {
      if (turn.toolCount >= MAX_TOOLS) { turn.droppedTools = (turn.droppedTools || 0) + 1; return null; }
      tool = { id: key, tool: '', args: '', partial: '', result: '', status: 'running', durationMs: null, isError: false, order: turn.toolCount };
      turn.tools[key] = tool;
      turn.toolCount += 1;
      // one card per tool_call_id, rendered inside the message that is open (or the last one)
      var msg = turn.messages.length ? turn.messages[turn.messages.length - 1] : messageFor(turn, 'm0', true, '');
      if (msg && msg.tools.indexOf(tool) < 0) msg.tools.push(tool);
    }
    if (patch && typeof patch === 'object') {
      if (patch.tool !== undefined && patch.tool !== null) tool.tool = clip(patch.tool, 120);
      if (patch.args !== undefined) tool.args = clip(patch.args, MAX_ARGS_CHARS);
      if (patch.partial !== undefined) tool.partial = clip(patch.partial, MAX_PARTIAL_CHARS);
      if (patch.result !== undefined) tool.result = clip(patch.result, MAX_RESULT_CHARS);
      if (patch.status) tool.status = String(patch.status);
      if (patch.durationMs !== undefined && patch.durationMs !== null) tool.durationMs = Number(patch.durationMs);
      if (patch.isError !== undefined) tool.isError = !!patch.isError;
      if (patch.appendArgs) tool.args = clip(tool.args + String(patch.appendArgs), MAX_ARGS_CHARS);
    }
    return tool;
  }

  function argsText(args) {
    if (args === undefined || args === null) return '';
    if (typeof args === 'string') return clip(args, MAX_ARGS_CHARS);
    try { return clip(JSON.stringify(args), MAX_ARGS_CHARS); } catch (e) { return '[args]'; }
  }

  function resultText(result) {
    if (result === undefined || result === null) return '';
    if (typeof result === 'string') return clip(result, MAX_RESULT_CHARS);
    try { return clip(JSON.stringify(result), MAX_RESULT_CHARS); } catch (e) { return '[result]'; }
  }

  /**
   * The only place an envelope changes the model. Pure: no DOM, no network, no timers.
   * Mutates `state` (one object per connection) and reports what happened.
   *
   * @returns {{state: object, changed: boolean, reason: string}}
   */
  function reduce(state, ev) {
    var out = function (changed, reason) { return { state: state, changed: !!changed, reason: reason }; };
    if (!state) return { state: state, changed: false, reason: 'nostate' };
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) { state.malformed += 1; return out(false, 'malformed'); }
    if (ev.v !== 1 || typeof ev.seq !== 'number' || !isFinite(ev.seq) ||
        typeof ev.type !== 'string' || !ev.type) {
      state.malformed += 1;
      return out(false, 'malformed');
    }
    if (!(ev.type in KNOWN_TYPES)) { state.unknown += 1; return out(false, 'unknown'); }

    // Another session's lines must never paint this pane's conversation.
    if (state.sessionId && ev.session_id && String(ev.session_id) !== state.sessionId) {
      state.outOfSession += 1;
      return out(false, 'outOfSession');
    }

    var key = keyOf(ev, state.sessionId);
    if (seenRecently(state, key)) { state.duplicates += 1; return out(false, 'duplicate'); }
    remember(state, key);

    state.events += 1;
    state.lastEventAt = now();
    if (state.status !== 'live') state.status = 'live';

    // settings/error are turn-independent (a control line may arrive with turn_id="control")
    if (ev.type === 'settings') {
      state.settings = { model: ev.model || state.model || '', thinking_level: ev.thinking_level || '' };
      if (ev.model) state.model = String(ev.model);
      return out(true, 'settings');
    }
    if (ev.type === 'error') {
      state.lastError = clip(ev.message, 400);
      return out(true, 'error');
    }

    if (!state.turn || (ev.turn_id && String(ev.turn_id) !== state.turn.id)) {
      if (state.turn && !state.turn.ended) {        // a new turn superseded an unterminated one
        state.turn.ended = true;
        state.turn.endStatus = 'superseded';
      }
      state.turn = newTurn(ev);
    }
    var turn = state.turn;

    switch (ev.type) {
      case 'turn_start':
        if (turn.messages.length || turn.ended) { state.turn = newTurn(ev); turn = state.turn; }
        if (typeof ev.turn_index === 'number') turn.index = ev.turn_index;
        return out(true, 'turn_start');

      case 'message_start': {
        var m = messageFor(turn, ev.message_id, true, ev.model);
        if (m && ev.role) m.role = String(ev.role);
        if (m && ev.model) m.model = String(ev.model);
        return out(true, 'message_start');
      }

      case 'text_delta': {
        var tm = messageFor(turn, ev.message_id, true, '');
        if (!tm) return out(false, 'ignored');
        appendText(turn, tm, ev.delta);
        return out(true, 'text');
      }

      case 'text_end': {
        var te = messageFor(turn, ev.message_id, true, '');
        if (!te) return out(false, 'ignored');
        if (ev.text !== undefined && ev.text !== null) {
          var full = clip(ev.text, MAX_TEXT_BYTES);
          if (full !== te.text) {
            te.text = full;
            turn.textBytes = 0;
            for (var ti = 0; ti < turn.messages.length; ti += 1) turn.textBytes += byteLen(turn.messages[ti].text);
          }
        }
        return out(true, 'text_end');
      }

      case 'reasoning_delta': {
        var rm = messageFor(turn, ev.message_id, true, '');
        if (!rm || rm.reasoningTruncated) return out(false, 'ignored');
        var chunk = clip(ev.delta, MAX_TEXT_BYTES);
        rm.reasoning += chunk;
        if (byteLen(rm.reasoning) > MAX_TEXT_BYTES) {
          rm.reasoning = sliceToBytes(rm.reasoning, MAX_TEXT_BYTES);
          rm.reasoningTruncated = true;
        }
        return out(true, 'reasoning');
      }

      case 'reasoning_end': {
        var re = messageFor(turn, ev.message_id, true, '');
        if (!re) return out(false, 'ignored');
        if (ev.text !== undefined && ev.text !== null) {
          var rtxt = clip(ev.text, MAX_TEXT_BYTES);
          if (rtxt !== re.reasoning) re.reasoning = rtxt;
        }
        return out(true, 'reasoning_end');
      }

      case 'tool_call_start': {
        var ts = setTool(turn, ev.tool_call_id, { tool: ev.tool, status: 'preparing' });
        return out(!!ts, 'tool');
      }
      case 'tool_call_delta': {
        var td = setTool(turn, ev.tool_call_id, { appendArgs: ev.delta });
        return out(!!td, 'tool');
      }
      case 'tool_call_end': {
        var tce = setTool(turn, ev.tool_call_id, { tool: ev.tool, args: argsText(ev.args), status: 'ready' });
        return out(!!tce, 'tool');
      }
      case 'tool_start': {
        var tst = setTool(turn, ev.tool_call_id, { tool: ev.tool, args: argsText(ev.args), status: 'running' });
        return out(!!tst, 'tool');
      }
      case 'tool_update': {
        var tu = setTool(turn, ev.tool_call_id, { partial: resultText(ev.partial) });
        return out(!!tu, 'tool');
      }
      case 'tool_end': {
        var tend = setTool(turn, ev.tool_call_id, {
          result: resultText(ev.result), status: ev.is_error ? 'error' : 'ok',
          isError: !!ev.is_error,
          durationMs: (typeof ev.duration_ms === 'number') ? ev.duration_ms : null
        });
        return out(!!tend, 'tool');
      }

      case 'message_end': {
        var me = messageFor(turn, ev.message_id, true, '');
        if (!me) return out(false, 'ignored');
        me.done = true;
        if (ev.text !== undefined && ev.text !== null) {
          var authoritative = clip(ev.text, MAX_TEXT_BYTES);
          if (authoritative !== me.text) {
            me.text = authoritative;
            turn.textBytes = 0;
            for (var mi = 0; mi < turn.messages.length; mi += 1) turn.textBytes += byteLen(turn.messages[mi].text);
          }
        }
        return out(true, 'message_end');
      }

      case 'turn_end':
        turn.ended = true;
        turn.endStatus = ev.status ? String(ev.status) : 'complete';
        return out(true, 'turn_end');

      default:
        state.unknown += 1;
        return out(false, 'unknown');
    }
  }

  /** Drop the live turn but keep the connection (a record arrived; the record wins). */
  function retireTurn(state) {
    if (state) {
      state.turn = null;
      state.lastError = '';
    }
    return state;
  }

  /** Is the live turn complete and therefore waiting for the record to retire it? */
  function turnFinished(state) {
    return !!(state && state.turn && state.turn.ended);
  }

  // ─────────────────────────────────────────────────────────────── DOM side

  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function setText(node, value) {
    if (!node) return;
    var next = (value === undefined || value === null) ? '' : String(value);
    if (node.__lastText === next) return;
    node.textContent = next;
    node.__lastText = next;
  }

  function create(opts) {
    var o = opts || {};
    var slot = o.slot || null;          // chatview-owned element at the end of the chat list
    var onStatus = (typeof o.onStatus === 'function') ? o.onStatus : null;
    var EventSourceImpl = o.EventSource || root.EventSource || null;
    var clock = o.now || now;

    var state = null;
    var es = null;
    var gen = 0;
    var destroyed = false;
    var openKey = '';
    var dirty = false;
    var flushHandle = null;
    var lastFlush = 0;
    var view = null;                    // {turnId, root, head, foot, note, msgs:{}}

    function emitStatus() {
      if (!onStatus) return;
      var s = state;
      try {
        onStatus({
          state: s ? s.status : 'records',
          events: s ? s.events : 0,
          cards: s && s.turn ? s.turn.toolCount : 0,
          waiting: s ? s.waiting : '',
          error: s ? s.lastError : '',
          agent: s ? s.agent : '',
          malformed: s ? s.malformed : 0,
          duplicates: s ? s.duplicates : 0
        });
      } catch (e) { /* a status observer must never break the stream */ }
    }

    // ── rendering (coalesced) ──────────────────────────────────────────────
    function schedule() {
      dirty = true;
      if (flushHandle !== null) return;
      var wait = Math.max(0, FLUSH_MIN_MS - (clock() - lastFlush));
      if (typeof root.requestAnimationFrame === 'function' && wait === 0) {
        flushHandle = { raf: true, id: root.requestAnimationFrame(flush) };
      } else {
        flushHandle = { raf: false, id: setTimeout(flush, Math.max(wait, 16)) };
      }
    }

    function cancelFlush() {
      if (flushHandle === null) return;
      if (flushHandle.raf && typeof root.cancelAnimationFrame === 'function') root.cancelAnimationFrame(flushHandle.id);
      else clearTimeout(flushHandle.id);
      flushHandle = null;
    }

    function clearSlot() {
      if (!slot) return;
      slot.textContent = '';
      view = null;
    }

    function buildTurn(turn) {
      clearSlot();
      if (!slot) { view = null; return; }
      var rootEl = el('div', 'hd-live-turn');
      rootEl.setAttribute('data-live-turn', turn.id);
      var head = el('div', 'hd-live-head');
      var msgs = {};
      for (var i = 0; i < turn.messages.length; i += 1) {
        var m = turn.messages[i];
        var vn = buildMessage(m);
        msgs[m.id] = vn;
        rootEl.appendChild(vn.node);
      }
      var note = el('div', 'hd-live-note');
      var foot = el('div', 'hd-live-foot');
      rootEl.appendChild(note);
      rootEl.appendChild(foot);
      slot.appendChild(rootEl);
      view = { turnId: turn.id, root: rootEl, head: head, foot: foot, note: note, msgs: msgs };
      // the head sits above the first message but after the slot's top
      rootEl.insertBefore(head, rootEl.firstChild);
      setText(head, 'live \u00b7 ' + (state.agent || 'agent'));
    }

    function buildMessage(m) {
      var node = el('div', 'hd-live-msg');
      node.setAttribute('data-mid', m.id);
      var textEl = el('div', 'hd-live-text');
      var think = el('details', 'hd-live-think');
      var summary = el('summary', 'hd-live-think-sum');
      setText(summary, 'thinking \u00b7 0 chars');
      var thinkBody = el('div', 'hd-live-think-body');
      think.appendChild(summary);
      think.appendChild(thinkBody);
      var tools = el('div', 'hd-live-tools');
      node.appendChild(textEl);
      node.appendChild(think);
      node.appendChild(tools);
      return { node: node, textEl: textEl, think: think, summary: summary, thinkBody: thinkBody,
               toolsEl: tools, textShown: '', reasonShown: '', tools: {} };
    }

    function toolNode(vn, tool) {
      var t = vn.tools[tool.id];
      if (!t) {
        var node = el('div', 'hd-live-tool');
        node.setAttribute('data-tool-id', tool.id);
        var name = el('div', 'hd-live-tool-name');
        var args = el('div', 'hd-live-tool-args');
        var status = el('div', 'hd-live-tool-status');
        var result = el('div', 'hd-live-tool-result');
        node.appendChild(name); node.appendChild(args); node.appendChild(status); node.appendChild(result);
        vn.toolsEl.appendChild(node);
        t = vn.tools[tool.id] = { node: node, name: name, args: args, status: status, result: result };
      }
      setText(t.name, tool.tool || 'tool');
      var argText = tool.args || tool.partial || '';
      setText(t.args, argText);
      var word = tool.status === 'ok' ? 'ok' : tool.status === 'error' ? 'error' : tool.status;
      if (tool.durationMs !== null && tool.durationMs !== undefined) word += ' \u00b7 ' + Math.round(tool.durationMs) + ' ms';
      setText(t.status, word);
      t.node.classList.toggle('hd-live-tool-error', !!tool.isError);
      setText(t.result, tool.result || '');
      t.node.hidden = false;
      return t;
    }

    function flush() {
      flushHandle = null;
      if (destroyed) return;
      lastFlush = clock();
      dirty = false;
      if (!state) { clearSlot(); return; }
      var turn = state.turn;
      if (!turn) { clearSlot(); emitStatus(); return; }
      if (!view || view.turnId !== turn.id) buildTurn(turn);
      if (!view) { emitStatus(); return; }

      var i, j;
      // messages: create missing nodes in stream order (one bubble per message_id)
      for (i = 0; i < turn.messages.length; i += 1) {
        var m = turn.messages[i];
        var vn = view.msgs[m.id];
        if (!vn) {
          vn = buildMessage(m);
          view.msgs[m.id] = vn;
          view.root.insertBefore(vn.node, view.note);
        }
        // text: append the delta only (no rebuild) while it is a pure suffix
        if (m.text !== vn.textShown) {
          if (m.text.indexOf(vn.textShown) === 0) {
            vn.textEl.appendChild(document.createTextNode(m.text.slice(vn.textShown.length)));
          } else {
            vn.textEl.textContent = m.text;
          }
          vn.textShown = m.text;
        }
        vn.textEl.hidden = !m.text;
        // reasoning: collapsed <details>, summary carries the size
        if (m.reasoning !== vn.reasonShown) {
          if (m.reasoning.indexOf(vn.reasonShown) === 0) {
            vn.thinkBody.appendChild(document.createTextNode(m.reasoning.slice(vn.reasonShown.length)));
          } else {
            vn.thinkBody.textContent = m.reasoning;
          }
          vn.reasonShown = m.reasoning;
        }
        setText(vn.summary, 'thinking \u00b7 ' + m.reasoning.length + ' chars');
        vn.think.hidden = !m.reasoning;
        for (j = 0; j < m.tools.length; j += 1) toolNode(vn, m.tools[j]);
        vn.node.classList.toggle('hd-live-msg-done', !!m.done);
      }

      setText(view.head, 'live \u00b7 ' + (state.agent || 'agent') +
        (turn.index !== null ? ' \u00b7 turn ' + (turn.index + 1) : ''));
      var notes = [];
      if (turn.truncated) notes.push('live text capped at ' + Math.round(MAX_TEXT_BYTES / 1024) + ' KiB');
      if (turn.droppedTools) notes.push(turn.droppedTools + ' tool card(s) not shown (cap ' + MAX_TOOLS + ')');
      if (state.lastError) notes.push('stream error: ' + state.lastError);
      if (state.waiting) notes.push(state.waiting);
      setText(view.note, notes.join(' \u00b7 '));
      view.note.hidden = notes.length === 0;

      var foot = turn.ended
        ? 'turn ' + (turn.endStatus || 'complete') + ' \u00b7 waiting for the record'
        : 'streaming \u00b7 ' + state.events + ' event' + (state.events === 1 ? '' : 's');
      setText(view.foot, foot);
      emitStatus();
    }

    // ── EventSource ────────────────────────────────────────────────────────
    function onStream(ev) {
      if (destroyed || !state) return;
      var parsed = null;
      try { parsed = JSON.parse(ev && ev.data ? ev.data : ''); } catch (e) { parsed = null; }
      if (!parsed) { state.malformed += 1; emitStatus(); return; }
      var r = reduce(state, parsed);
      if (r.changed) schedule();
      else if (r.reason === 'duplicate' || r.reason === 'malformed' || r.reason === 'unknown') emitStatus();
    }

    function onReady(ev) {
      if (destroyed || !state) return;
      var info = null;
      try { info = ev && ev.data ? JSON.parse(ev.data) : null; } catch (e) { info = null; }
      if (info && info.agent && !state.agent) state.agent = String(info.agent);
      state.connected = true;
      emitStatus();
    }

    function onReset() {
      if (destroyed || !state) return;
      retireTurn(state);
      clearSlot();
      emitStatus();
    }

    function onWaiting(ev) {
      if (destroyed || !state) return;
      var info = null;
      try { info = ev && ev.data ? JSON.parse(ev.data) : null; } catch (e) { info = null; }
      state.waiting = (info && info.reason) ? String(info.reason) : 'no stream sink yet';
      if (state.status !== 'live') state.status = 'records';
      schedule();
    }

    function onOpen() {
      if (destroyed || !state) return;
      state.connected = true;
      // an open socket is not a source of text: the chip only says live once an event lands
      emitStatus();
    }

    function onError() {
      if (destroyed || !state) return;
      state.connected = false;
      state.status = 'reconnecting';
      emitStatus();
    }

    function connect(cfg) {
      if (!EventSourceImpl) return false;
      var url = '/api/agent-stream?pane_id=' + encodeURIComponent(cfg.paneId) +
        (cfg.sessionId ? '&session_id=' + encodeURIComponent(cfg.sessionId) : '');
      try {
        es = new EventSourceImpl(url);
      } catch (e) {
        es = null;
        return false;
      }
      if (typeof es.addEventListener === 'function') {
        es.addEventListener('stream', onStream);
        es.addEventListener('stream.ready', onReady);
        es.addEventListener('stream.reset', onReset);
        es.addEventListener('stream.waiting', onWaiting);
      } else {
        es.onmessage = onStream;                 // minimal shims (tests) may only have onmessage
      }
      es.onopen = onOpen;
      es.onerror = onError;
      return true;
    }

    function teardown() {
      gen += 1;
      cancelFlush();
      if (es) {
        try {
          if (typeof es.removeEventListener === 'function') {
            es.removeEventListener('stream', onStream);
            es.removeEventListener('stream.ready', onReady);
            es.removeEventListener('stream.reset', onReset);
            es.removeEventListener('stream.waiting', onWaiting);
          }
          es.close();
        } catch (e) { /* already closed */ }
      }
      es = null;
      state = null;
      openKey = '';
      clearSlot();
    }

    function open(cfg) {
      if (destroyed || !cfg || !cfg.paneId) return false;
      var agent = cfg.agent ? String(cfg.agent) : '';
      if (agent !== 'pi' && agent !== 'hermes') return false;   // never for claude (§7)
      var key = String(cfg.paneId) + '|' + String(cfg.sessionId || '') + '|' + agent;
      if (es && key === openKey) return true;                  // already streaming this pane/session
      teardown();
      openKey = key;
      state = newState({ paneId: cfg.paneId, sessionId: cfg.sessionId, agent: agent });
      var myGen = gen;
      if (!connect(cfg)) {
        state.status = 'records';
        state.waiting = 'live stream unavailable in this browser';
        emitStatus();
        return false;
      }
      emitStatus();
      // page unload must not leave a socket behind
      if (!open.__unloadBound) {
        open.__unloadBound = true;
        root.addEventListener('pagehide', onPageHide);
        root.addEventListener('beforeunload', onPageHide);
      }
      return myGen === gen;
    }

    function onPageHide() { close('unload'); }

    function close(reason) {
      teardown();
      if (onStatus) {
        try { onStatus({ state: 'records', events: 0, cards: 0, waiting: '', error: '', agent: '',
                         malformed: 0, duplicates: 0, reason: reason || '' }); } catch (e) { /* ignore */ }
      }
    }

    function retire() {
      if (!state) return false;
      retireTurn(state);
      clearSlot();
      // The live turn is gone because the authoritative record arrived. Say so:
      // leaving state.status='live' made the chip claim a stream that is no longer
      // on screen until the next turn's first event.
      state.status = 'records';
      state.waiting = '';
      emitStatus();
      return true;
    }

    function status() {
      if (!state) return { state: 'records', events: 0, cards: 0, ended: false };
      return { state: state.status, events: state.events, cards: state.turn ? state.turn.toolCount : 0,
               ended: !!(state.turn && state.turn.ended), truncated: !!(state.turn && state.turn.truncated),
               malformed: state.malformed, duplicates: state.duplicates, waiting: state.waiting };
    }

    /** The accumulated text of the newest live message (retirement compares it to the record). */
    function textSoFar() {
      if (!state || !state.turn || !state.turn.messages.length) return '';
      return state.turn.messages[state.turn.messages.length - 1].text || '';
    }

    function destroy() {
      if (destroyed) return;
      close('destroy');
      destroyed = true;
      cancelFlush();
      if (open.__unloadBound) {
        root.removeEventListener('pagehide', onPageHide);
        root.removeEventListener('beforeunload', onPageHide);
      }
    }

    /** Move the slot to the end of the list after a record render (chatview calls this). */
    function ensureLast(listEl) {
      if (!slot || !listEl) return;
      if (slot.parentNode !== listEl || listEl.lastChild !== slot) listEl.appendChild(slot);
    }

    return {
      open: open,
      close: close,
      retire: retire,
      status: status,
      text: textSoFar,
      destroy: destroy,
      ensureLast: ensureLast,
      setSlot: function (node) { slot = node || null; if (!slot) clearSlot(); },
      flushNow: flush,
      isDirty: function () { return dirty; },
      __state: function () { return state; }
    };
  }

  // ────────────────────────────────────────────────────────────────── exports

  var api = {
    version: 1,
    MAX_TEXT_BYTES: MAX_TEXT_BYTES,
    MAX_TOOLS: MAX_TOOLS,
    newState: newState,
    reduce: reduce,
    retireTurn: retireTurn,
    turnFinished: turnFinished,
    create: create
  };

  root.HD = root.HD || {};
  root.HD.streamLive = api;

  // The selftest seam: pure reducer access, no EventSource, no DOM.
  root.HD.streamLiveTest = {
    newState: newState,
    reduce: reduce,
    retireTurn: retireTurn,
    turnFinished: turnFinished,
    constants: { MAX_TEXT_BYTES: MAX_TEXT_BYTES, MAX_TOOLS: MAX_TOOLS, MAX_SEEN: MAX_SEEN, FLUSH_MIN_MS: FLUSH_MIN_MS }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
