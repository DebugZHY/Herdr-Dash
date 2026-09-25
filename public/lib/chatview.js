/* herdr-dash — lib/chatview.js (W2, CONTRACT-v2 §8.3 / §8.5, amendment A1)
 *
 * The structured conversation view: prompts and agent replies as a chat (bubbles + tool cards)
 * instead of raw terminal text. Both views stay available — `t` toggles chat ↔ raw — because the
 * structured logs do NOT contain the TUI's permission prompts and transient screen state.
 *
 * Data: GET /api/chat (CONTRACT-v2 §8.2) through ctx.api.chat(). We poll every 2 s ONLY while the
 * view is visible and a pane is selected; hidden → no timer at all (the §3 rule every module
 * follows). Per pane we keep the message list, the server cursor and the pending sends, and the
 * cursor goes back out as `since` — so a second call with nothing new returns messages: [] and
 * changes nothing (the endpoint is idempotent per §8.2).
 *
 * A1 — progressive, segmented rendering (§8.3 amendment). The log is appended one record per
 * content block, so a 2 s poll really does arrive mid-turn: each poll renders what has landed, and
 * nothing waits for the turn to end. A turn (a `user` text record → the last assistant text before
 * the next user record) is drawn as ONE group by ChatRender.renderTurn, its segments in log order,
 * the user's prompt as the head and the closing assistant text as the reply. While the pane's
 * agent_status is `working` the last turn is marked working and ends in renderWorkingTail()
 * ("working · 12s") instead of a reply, so a running turn can never read as finished. The source is
 * block level: there is NO per-token typing here, ever (A1 rule 5 — token-level live output is the
 * raw view's job, one `t` away).
 *
 * First load (§8.2 tail mode, W1): the first request for a pane asks for `tail=1&limit=200` — the
 * LAST page with the cursor at EOF — so a 2337-record session opens in one request instead of
 * walking forward page by page from 3.8 h ago. If the server does not implement tail mode the
 * response is indistinguishable from a head page, so we verify: one forward call with the returned
 * cursor. New records → we were at the head, and that same call is the first step of the old
 * bounded catch-up walk (nothing is wasted). Nothing new → the cursor really is at EOF.
 *
 * DEFECT-12 — one unanswered response must never freeze the view. The in-flight request is tracked
 * with its start time and an AbortController; after REQ_TIMEOUT_MS it is aborted, the latch is
 * released, the pane says so in words, and the next tick retries. Switching panes aborts a request
 * belonging to the pane being left, so a stalled response cannot hold the new pane hostage. (The
 * old latch had no timeout and no abort: the first response that never came froze every pane
 * selected afterwards while `polling:true` stayed true and nothing threw.)
 *
 * Honest states: every §8.1 error code gets its own readable sentence — never a blank panel and
 * never an invented reply. `unknown_records > 0` is surfaced ("this log format may have changed")
 * so a format change is visible instead of looking like lost history. `skipped` is shown too.
 *
 * Pending sends (§8.3): app.js reports a successful POST /api/pane/prompt for the visible pane
 * (notePending); the sent text appears immediately as a pending bubble. It is replaced by the real
 * record — with the record's own timestamp — as soon as a user message with the same text shows up
 * in the log. If nothing shows up within 20 s the bubble STAYS and carries the explicit note
 * "not found in this agent's log — sent to the terminal; press t for the raw view". Nothing here
 * ever invents an assistant reply.
 *
 * Renderer: ChatRender (public/lib/chat-render.js, W3) — the §8.5 frozen interface renderMessage /
 * renderList / summaryFor / autoScrollOpts, including its documented extras msg.pending and
 * msg.pending_note for exactly the pending bubbles above. When chat-render.js is missing the view
 * still works through a deliberately small built-in fallback and says so in the status strip, so a
 * missing optional file is never a blank screen (the same rule every other module file follows).
 *
 * DOM (chatview.css, W3, owns the look; every rule this module injects lives inside :where(), i.e.
 * zero specificity, so any stylesheet rule wins):
 *   #chatHost.chat-host            host element (declared in index.html, inside #transcriptWrap)
 *     #hdChatStatus.chat-status    strip: source, counts, [load older] [raw (t)]
 *     #hdChatScroll.hd-cv-scroll   the scroller
 *       #hdChatList.hd-cv-list     the message column
 *         #hdChatState.hd-cv-empty one honest-state block (error / empty / unavailable)
 *         #hdChatOlder.chat-older  "whole session loaded" note
 *         …rendered messages…     ChatRender's (or the fallback's) nodes
 *         …pending bubbles…       .chat-pending + .chat-pending-note
 *       #hdChatJump.hd-cv-jump     "N new ↓" while the view is unpinned (N = records that arrived
 *                                  since the user left the tail; "jump to latest ↓" when N is 0)
 *
 * Agent output is untrusted text: nothing here assigns message text with innerHTML (the only
 * innerHTML ever used is ''), everything is built as nodes and set with textContent.
 */
(function () {
  'use strict';

  var HD = (window.HD = window.HD || {});
  var ID = 'chatview';
  var TITLE = 'Chat view';

  var POLL_MS = 2000;              // §8.3/A1: poll while visible (A1 asks for 1-2 s)
  var PENDING_TICK_MS = 1000;      // only while a send is unresolved, so the 20 s note is punctual
  var WORKING_TICK_MS = 1000;      // A1: the running turn's "working · Ns" label ticks every second
  var PAGE_LIMIT = 200;            // per-poll page size
  var TAIL_LIMIT = 200;            // §8.2 tail mode: the first load asks for the last 200 + EOF cursor
  var RENDER_MAX = 200;            // §8.3: render the last 200 messages
  var EXPAND_MAX = 800;            // after "load older": render this many (bounded, so the DOM is too)
  var OLDER_LIMIT = 800;           // "load older · 800"
  var MEM_MAX = 2000;              // hard cap on the in-memory list per pane
  var CATCHUP_MAX = 8;             // pages fetched back-to-back when tail mode is unavailable
  var TURN_RERENDER_MAX = 80;      // re-render the open turn while it is this small; append past it
  var REQ_TIMEOUT_MS = 12000;      // DEFECT-12/18: a request that never answers is abandoned + aborted
  var REQ_DEDUP_MS = 250;          // DEFECT-18(1): the same read asked twice in one tick is asked once
  var PENDING_TIMEOUT_MS = 20000;  // §8.3: 20 s until the pending bubble says "not found"
  var LS_VIEW = 'herdrDash.transcriptView';   // 'chat' | 'raw'

  /* §10 attachments (option A). The client never chooses a destination path: it uploads the bytes to
     the server's own store and injects the absolute path the server returns. */
  var ATTACH_MAX = 8;              // §10.3: at most 8 files per message (the server enforces it too)
  var ATTACH_BLOCK_HEAD = '[attached files — open them with your tools]';  // §10.4, verbatim

  var PENDING_WAIT = "sent · waiting for the agent's log";
  var PENDING_LOST = "not found in this agent's log — sent to the terminal; press t for the raw view";

  /* §8.3 "honest empty states": one sentence per §8.1 code, each distinct and readable. */
  var ERRORS = {
    unsupported_agent:
      "chat view is not available for this pane's agent — the structured reader supports claude and " +
      "hermes only. press t for the raw terminal view.",
    session_file_missing:
      "the agent's session log file is missing on disk — the session may not have written anything " +
      "yet, or the file was rotated away. press t for the raw terminal view.",
    session_db_missing:
      "the hermes state database was not found — set HERMES_STATE_DB or check " +
      "%LOCALAPPDATA%/hermes/state.db. press t for the raw terminal view.",
    session_cwd_mismatch:
      "the session log that matched this pane belongs to a different working directory — refusing " +
      "to show another project's conversation. press t for the raw terminal view.",
    pane_not_found:
      "this pane is not in herdr's current snapshot (it may have closed or been replaced).",
    bad_request:
      "the chat request was rejected by the server (bad_request) — a client/server mismatch, not a " +
      "missing session.",
    not_found:
      "the chat endpoint is not on this server yet (GET /api/chat → not_found) — the server half has " +
      "not been deployed. press t for the raw terminal view.",
    network:
      "cannot reach the server. press t for the raw terminal view."
  };
  var EMPTY_NOTE = 'no messages in this session yet.';
  /* DEFECT-12/18: a request the server never answered. Not an error (nothing says the session is
     gone) and not a blank panel either — it names what happened and what happens next. DEFECT-18(2):
     the timeout is now a real timer that releases the latch on its own, and the reader is offered a
     retry instead of being told to wait for a poll tick that may not be running. */
  var STALL_NOTE = 'the read timed out — the server did not answer within %ss and the request was aborted. nothing was lost: press "retry now", or wait for the next poll, to ask again from the same cursor.';
  /* the short form, for the state line where the panel would otherwise still say "reading …" */
  var STALL_STATE = 'the read timed out — the request was aborted, so this panel is not waiting on it. press "retry now" (in the strip above) to ask again from the same cursor.';

  /* ────────────────────────────────────────────────────────────── small helpers */

  function el(tag, cls, tx) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (tx !== undefined && tx !== null) d.textContent = String(tx);
    return d;
  }
  function text(v) { return (v === undefined || v === null) ? '' : String(v); }
  function norm(v) { return text(v).replace(/\s+/g, ' ').trim(); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function jsonish(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }
  function oneLine(v, n) {
    var s = (v && typeof v === 'object') ? jsonish(v) : text(v);
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clock(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) return '';
    var d = new Date(n);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function lsGet(k, d) {
    try { var v = window.localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; }
  }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  function errorText(err) {
    var code = (err && err.code) ? String(err.code) : 'unknown';
    if (ERRORS[code]) return ERRORS[code];
    if (code === 'no_messages_yet') return EMPTY_NOTE;
    return 'chat unavailable (' + code + '): ' +
      ((err && err.message) ? String(err.message) : 'no message') + '. press t for the raw terminal view.';
  }

  /* the §8.5 frozen renderer, or null */
  function renderer() {
    var R = window.ChatRender;
    return (R && typeof R.renderMessage === 'function') ? R : null;
  }
  function rendererName() { return renderer() ? 'ChatRender' : 'built-in fallback'; }

  function stickPx() {
    var R = renderer();
    if (R && typeof R.autoScrollOpts === 'function') {
      try {
        var o = R.autoScrollOpts();
        if (o && typeof o.stickPx === 'number' && isFinite(o.stickPx)) return o.stickPx;
      } catch (e) { /* fall through to the default */ }
    }
    return 48;
  }

  /* a rendered message node, from either renderer (.hd-cv-msg from ChatRender, .chat-msg from the
     built-in fallback); a pending bubble is NOT a message node for the trim/append bookkeeping */
  function isMessageNode(n) {
    if (!n || !n.classList) return false;
    if (n.classList.contains('chat-pending')) return false;
    var back = n.getAttribute ? n.getAttribute('data-pending') : null;
    if (back === '1') return false;
    return n.classList.contains('chat-msg') || n.classList.contains('hd-cv-msg');
  }

  /* ---- the built-in fallback renderer (only when chat-render.js is not loaded) ---- */

  function fbToolSummary(tool) {
    var t = tool || {};
    var parts = [];
    if (t.name) parts.push(text(t.name));
    var input = t.input;
    if (typeof input === 'string' && input) parts.push(oneLine(input, 84));
    else if (input && typeof input === 'object') {
      var keys = Object.keys(input);
      for (var i = 0; i < keys.length && i < 3; i++) parts.push(keys[i] + '=' + oneLine(input[keys[i]], 42));
    }
    if (t.pending) parts.push('pending');
    return parts.join(' · ');
  }
  function toolSummary(tool) {
    var R = renderer();
    if (R && typeof R.summaryFor === 'function') {
      try { var s = R.summaryFor(tool); if (s) return String(s); } catch (e) { /* fall back */ }
    }
    return fbToolSummary(tool);
  }

  function fbRenderMessage(msg) {
    var m = msg || {};
    var kind = m.kind || 'text';
    var wrap = el('div', 'chat-msg role-' + text(m.role || 'unknown') + ' kind-' + kind);
    var fk = keyOf(m);
    if (fk) wrap.setAttribute('data-key', fk);       // A2: the fold is keyed by msg.key, both renderers
    if (kind === 'tool_call' || kind === 'tool_result') {
      var tool = m.tool || {};
      var card = el('div', 'chat-tool' + (tool.is_error ? ' chat-err' : ''));
      card.appendChild(el('div', 'chat-tool-head', toolSummary(tool) || (kind === 'tool_result' ? 'tool result' : 'tool call')));
      var bits = [];
      if (tool.input !== undefined && tool.input !== null) {
        bits.push('input: ' + jsonish(tool.input) + (tool.input_truncated ? ' … (truncated by the server)' : ''));
      }
      if (tool.result !== undefined && tool.result !== null) {
        bits.push('result' + (tool.is_error ? ' (error)' : '') + ': ' + jsonish(tool.result) +
                  (tool.result_truncated ? ' … (truncated by the server)' : ''));
      }
      if (tool.pending) bits.push('… waiting for the result');
      if (!bits.length) bits.push(text(m.text));
      var pre = document.createElement('pre');
      pre.textContent = bits.join('\n');
      card.appendChild(pre);
      wrap.appendChild(card);
    } else if (kind === 'thinking') {
      var det = document.createElement('details');
      det.className = 'chat-thinking';
      det.appendChild(el('summary', null, 'thinking · ' + text(m.text).length + ' chars'));
      var tpre = document.createElement('pre');
      tpre.textContent = text(m.text);
      det.appendChild(tpre);
      wrap.appendChild(det);
    } else if (kind === 'system') {
      wrap.appendChild(el('div', 'chat-note small', text(m.text) || '(system record)'));
    } else {
      /* the text lives in its own box so a fold can hide exactly the body and nothing else: the
         disclosures (a server clamp note, a pending note) stay outside it (A2.6) */
      var fbBubble = el('div', 'chat-bubble');
      fbBubble.appendChild(el('div', 'hd-cv-body', text(m.text)));
      wrap.appendChild(fbBubble);
    }
    var meta = [];
    if (m.ts) meta.push(clock(m.ts));
    if (m.role) meta.push(text(m.role));
    if (m.sidechain) meta.push('sidechain');
    if (meta.length) wrap.appendChild(el('div', 'chat-ts', meta.join(' · ')));
    return wrap;
  }
  function fbRenderList(messages) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < (messages || []).length; i++) frag.appendChild(fbRenderMessage(messages[i]));
    return frag;
  }

  /** render a batch of real records: ChatRender when present, the fallback otherwise */
  function renderMessages(list, opts) {
    var R = renderer();
    if (R && typeof R.renderList === 'function') {
      try {
        var frag = R.renderList(list, opts);
        if (frag && frag.nodeType) return frag;
      } catch (e) { /* fall back, never break the view */ }
    }
    return fbRenderList(list, opts);
  }

  /** the sentence under a pending bubble: the wait (with its age) until 20 s, then the explicit
      "not found in this agent's log" note — which is never dropped once it has appeared (§8.3) */
  function pendingNoteText(p, now) {
    if (p.lost) return PENDING_LOST;
    return PENDING_WAIT + ' (' + Math.max(0, Math.round((now - p.sentAt) / 1000)) + 's)';
  }

  /** one pending send as a one-record TURN (A1 rule 6 + §8.3): ChatRender.renderTurn with
      turn.pending draws the sent text as the head bubble — the same node a real record would get —
      and msg.pending_note carries the wait / the "not found in this agent's log" sentence. The
      wrapper keeps this module's own class so the dashed, italic pending look is ours to adjust. */
  function renderPendingGroup(p, now, st) {
    var msg = { key: 'pending:' + p.id, ts: p.sentAt, role: 'user', kind: 'text', text: p.text,
                pending: true, pending_note: pendingNoteText(p, now), sidechain: false };
    var node = null;
    var R = renderer();
    if (R && typeof R.renderTurn === 'function') {
      try {
        node = R.renderTurn({ pending: true, user: msg, segments: [] },
                            { pending: true, now: now,
                              foldedKeys: (st && st.foldedKeys) ? st.foldedKeys : null,
                              openKeys: (st && st.openKeys) ? st.openKeys : null });
      } catch (e) { node = null; }
    }
    if (!node || node.nodeType !== 1) {
      var box = el('div', 'chat-turn');
      var b = el('div', 'hd-cv-bubble chat-bubble', p.text);
      box.appendChild(b);
      box.appendChild(el('div', 'chat-pending-note', pendingNoteText(p, now)));
      node = box;
    }
    var wrap = el('div', 'chat-pending');
    wrap.setAttribute('data-pending-id', p.id);
    wrap.setAttribute('data-pending', '1');
    wrap.appendChild(node);
    var note = node.querySelector ? (node.querySelector('.chat-pending-note') || node.querySelector('.hd-cv-note')) : null;
    if (note && note.classList) note.classList.add('chat-pending-note');
    return wrap;
  }

  function keyOf(m) {
    if (!m) return '';
    if (m.key !== undefined && m.key !== null) return String(m.key);
    var tool = m.tool || {};
    return [num(m.ts), text(m.role), text(m.kind), text(tool.call_key), norm(m.text).slice(0, 64)].join('|');
  }

  /* ---- A2 (§8.3 amendment 2): the folded form of ONE message ------------------------------- */

  /** what a fold hides: the message body (or bodies) and the `show all` control that belongs to
      them — everything else in the node (the head, a server clamp note, the pending sentence) stays
      outside, so a fold can never hide a disclosure (A2.6). */
  var FOLD_PARTS = '.hd-cv-body, .hd-cv-more';

  /** A2.3 + the A2 errata: the clip length of the folded preview. The renderer's own SUMMARY_MAX —
      read from wherever it publishes it, because `ChatRender` exports the behaviour while
      `HD.chatRenderTest` exports the pure parts (round 7.5: reading only the former fell back to
      160 for ever). Same number as the renderer clips its own preview with, so the two cannot
      drift apart. */
  function summaryMax() {
    var out = null;
    try {
      var T = window.HD && window.HD.chatRenderTest;
      if (T && typeof T.SUMMARY_MAX === 'number' && isFinite(T.SUMMARY_MAX) && T.SUMMARY_MAX > 0) out = T.SUMMARY_MAX;
    } catch (e) { /* fall through to the renderer object */ }
    if (out === null) {
      var R = renderer();
      try {
        if (R && typeof R.SUMMARY_MAX === 'number' && isFinite(R.SUMMARY_MAX) && R.SUMMARY_MAX > 0) out = R.SUMMARY_MAX;
      } catch (e) { /* fall through to the frozen number */ }
    }
    return out === null ? 160 : out;
  }
  /** A2.2: a text bubble folds on BOTH sides. A tool card keeps its own expand (unchanged), a
      thinking disclosure keeps its own head, a note never folds, and an empty record is not a
      message at all (DEFECT-10 hides it before this is ever asked). */
  function foldable(m) {
    if (!m || m.__empty) return false;
    if ((m.kind || 'text') !== 'text') return false;
    if (m.role !== 'user' && m.role !== 'assistant') return false;
    var t = m.text;
    if (t === undefined || t === null) return false;
    return String(t).length > 0;
  }
  /** A2.3 + the A2 errata rules 1-2: the first NON-EMPTY line of what THIS bubble shows, verbatim
      and clipped, plus `N chars · M lines hidden`. Nothing is summarised, nothing is invented.

      Round 7.5: the counts are taken from the text the reader would see if they unfolded this
      bubble — the very parts the fold is about to hide — and never from `raw.length` of the whole
      record. In the shim path those differ: the record includes the text a §8.3 length cap was
      already holding behind `show all`, so counting the record claimed the fold hid more than was
      on screen (the errata's measured 2430 against a real 1471). `foldParts` gives the boxes; the
      `show all` control is skipped because a control is not text. A bubble with no body in the DOM
      yet has only its record to count, and that is what it gets. */
  function foldPreview(parts, m) {
    var list = parts || [], shown = '';
    for (var i = 0; i < list.length; i++) {
      if (list[i].classList && list[i].classList.contains('hd-cv-more')) continue;
      shown += (shown ? '\n' : '') + String(list[i].textContent === undefined ? '' : list[i].textContent);
    }
    if (norm(shown) === '') {
      shown = (m && typeof m.text === 'string') ? m.text
        : String(m && m.text !== undefined && m.text !== null ? m.text : '');
    }
    var lines = shown.split('\n');
    var line = '';
    for (var j = 0; j < lines.length; j++) {
      if (norm(lines[j]) !== '') { line = lines[j]; break; }
    }
    var max = summaryMax();
    var chars = Array.from(line);
    var clipped = chars.length > max;
    var preview = clipped ? chars.slice(0, max - 1).join('') + '…' : line;   // the '…' is ours, not the text's
    var taken = clipped ? max - 1 : chars.length;
    var total = Array.from(shown).length;
    return {
      line: preview,
      note: Math.max(0, total - taken) + ' chars · ' + Math.max(0, lines.length - 1) + ' lines hidden',
      chars: total, lines: lines.length, clipped: clipped
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     §10 attachments (option A: upload to disk + path injection)

     The reader picks, drops or pastes a file; this engine accepts it, uploads the BYTES to
     POST /api/attach and keeps a chip that says what happened. Nothing here ever invents a path:
     `data-path` is the server's own absolute path, character for character, and §10.4's block is
     built from exactly those paths, one per line, with nothing added.
     ══════════════════════════════════════════════════════════════════════════ */

  /* "12.3 KB" — a size a person can read; the exact byte count travels in data-size for a test */
  function humanSize(n) {
    var b = num(n);
    if (b < 1024) return b + ' B';
    var kb = b / 1024;
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : String(Math.round(kb))) + ' KB';
    var mb = kb / 1024;
    return (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + ' MB';
  }
  /* §10.1: "the browser's original filename, UTF-8, percent-encoded if needed". A header value has
     to survive the wire as latin-1 on the way out, so an ASCII name travels verbatim (the server
     stores what the browser showed the user) and anything else is percent-encoded UTF-8 — a name
     that cannot be sent at all is never silently replaced by a different name. */
  function headerName(name) {
    var s = text(name);
    if (/^[\x20-\x7e]*$/.test(s)) return s;
    try { return encodeURIComponent(s); } catch (e) { return s; }
  }
  function attachErrText(body, status) {
    if (body && body.error) {
      var code = body.error.code ? String(body.error.code) + ': ' : '';
      return code + text(body.error.message || 'no message');
    }
    if (norm(body && body.reason)) return norm(body.reason);
    return num(status) > 0 ? ('the upload failed (HTTP ' + num(status) + ', no reason given)')
      : 'the upload failed (no reason given by the server)';
  }
  /* the reason the composer shows. It is written once, here, so the chip, the note line and the
     sentence a blocked send shows can never disagree. */
  function attachStateWord(it) {
    if (it.state === 'uploading') return 'uploading…';
    if (it.state === 'failed') return 'failed';
    return 'ready';
  }
  function attachMetaText(it) {
    var s = text(it.name) + ' · ' + humanSize(it.size);
    if (it.state !== 'ready') s += ' · ' + attachStateWord(it);
    return s;
  }

  /* The chip row and the reason line are created by this module: it is the owner of the §10.9
     markup, and the ids let the composer markup in index.html pre-place them without being the
     authority on their contents. */
  function attachHosts() {
    var list = document.getElementById('hdAttachList');
    var note = document.getElementById('hdAttachNote');
    var box = document.getElementById('promptBox');
    if (!list) {
      list = el('div', 'hd-cv-attach-list');
      list.id = 'hdAttachList';
      if (box) box.insertBefore(list, box.firstChild);
      else document.body.appendChild(list);
    }
    if (!note) {
      note = el('div', 'hd-cv-attach-note hidden');
      note.id = 'hdAttachNote';
      if (list.parentNode) list.parentNode.insertBefore(note, list.nextSibling);
      else document.body.appendChild(note);
    }
    return { list: list, note: note };
  }

  /* One engine per mount. `deps.getPaneId()` is the pane the composer is bound to RIGHT NOW (the
     composer and the chat view share app.js's selection) and `deps.emit()` lets the send button
     follow the chips without polling. */
  function createAttach(deps) {
    var hosts = attachHosts();
    var listEl = hosts.list;
    var noteEl = hosts.note;
    var items = [];
    var seq = 0;
    var noteText = '';                // the last refusal / block reason, kept until it stops applying

    function find(id) {
      for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
      return null;
    }
    function counts() {
      var up = 0, failed = 0, ready = 0;
      for (var i = 0; i < items.length; i++) {
        if (items[i].state === 'uploading') up++;
        else if (items[i].state === 'failed') failed++;
        else if (items[i].state === 'ready') ready++;
      }
      return { uploading: up, failed: failed, ready: ready };
    }
    /* §10.3/§10.5: THE block decision, in one place. A send is blocked while any chip is still
       uploading or has failed, and the sentence says which chip and (for a failure) the server's
       own words — never "something went wrong". */
    function blockReason() {
      var c = counts();
      if (c.uploading > 0) {
        var names = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].state === 'uploading') names.push(text(items[i].name));
        }
        return 'sending is blocked: ' + c.uploading + ' attachment' + (c.uploading === 1 ? ' is' : 's are') +
          ' still uploading (' + names.join(', ') + ') — wait for the upload to finish, or remove the chip' +
          (c.uploading === 1 ? '' : 's') + '.';
      }
      if (c.failed > 0) {
        var bad = null;
        for (var j = 0; j < items.length && !bad; j++) if (items[j].state === 'failed') bad = items[j];
        return 'sending is blocked: ' + c.failed + ' attachment' + (c.failed === 1 ? '' : 's') +
          ' failed to upload — ' + text(bad.why) + ' (' + text(bad.name) + '). remove the failed chip to send.';
      }
      return '';
    }
    function summary() {
      var c = counts();
      return {
        count: items.length, uploading: c.uploading, failed: c.failed, ready: c.ready,
        blocked: c.uploading > 0 || c.failed > 0, reason: blockReason(),
        paths: items.filter(function (it) { return it.state === 'ready'; }).map(function (it) { return text(it.path); }),
        items: items.map(function (it) {
          return { id: it.id, name: text(it.name), size: num(it.size), state: it.state,
                   path: it.state === 'ready' ? text(it.path) : null, why: text(it.why) };
        })
      };
    }
    function paintNote() {
      /* §10.3/§10.5: BOTH sentences can apply at once — a chip still uploading does not make a
         refused 9th file any less refused — so they are joined, never or'd. `blocked || noteText`
         hid the refusal exactly when a reader needed to see it (measured 2026-09-25: 8 chips
         uploading while the 9th was silently refused), which is the silent drop §10.5 forbids. */
      var blocked = blockReason();
      var shown = [blocked, noteText].filter(Boolean).join(' · ');
      noteEl.textContent = shown;
      noteEl.classList.toggle('hidden', !shown);
      noteEl.classList.toggle('chat-warn-on', !!blocked);
    }
    function announce() {
      paintNote();
      var s = summary();
      try { deps.emit(s); } catch (e) { /* the composer is optional */ }
      return s;
    }
    /* the chip: name+size in .hd-cv-attach-meta, the reason (when there is one) beside it, and the
       remove control the §10.9 names freeze. Every string goes in through textContent. */
    function renderChip(it) {
      var node = el('div', 'hd-cv-attach');
      node.setAttribute('data-state', it.state);
      node.setAttribute('data-name', text(it.name));
      node.setAttribute('data-size', String(num(it.size)));
      var meta = el('span', 'hd-cv-attach-meta', attachMetaText(it));
      meta.title = text(it.name);
      node.appendChild(meta);
      if (it.state === 'failed' && text(it.why)) {
        var why = el('span', 'hd-cv-attach-why', text(it.why));
        why.title = text(it.why);
        node.appendChild(why);
      }
      var rm = el('button', 'hd-cv-attach-remove', '×');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'remove attachment');
      rm.title = 'remove this attachment (the uploaded file stays on disk)';
      rm.addEventListener('click', function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        if (ev && ev.stopPropagation) ev.stopPropagation();
        remove(it.id);
      });
      node.appendChild(rm);
      if (it.state === 'ready' && it.path) {
        /* §10.5: the exact absolute path that will be sent — on the chip, and on the meta line's
           tooltip, so a reader can see where the file went before sending anything */
        node.setAttribute('data-path', text(it.path));
        meta.title = text(it.name) + '\n' + text(it.path);
      }
      return node;
    }
    function repaint(it) {
      var next = renderChip(it);
      if (it.node && it.node.parentNode) it.node.parentNode.replaceChild(next, it.node);
      else listEl.appendChild(next);
      it.node = next;
      listEl.classList.toggle('hidden', items.length === 0);
    }
    function remove(id) {
      var it = find(id);
      if (!it) return false;
      if (it.node && it.node.parentNode) it.node.parentNode.removeChild(it.node);
      items = items.filter(function (x) { return x !== it; });
      noteText = '';                       // the refusal no longer applies to this list
      listEl.classList.toggle('hidden', items.length === 0);
      announce();
      return true;
    }
    function clear() {
      for (var i = 0; i < items.length; i++) {
        if (items[i].node && items[i].node.parentNode) items[i].node.parentNode.removeChild(items[i].node);
      }
      items = [];
      noteText = '';
      listEl.classList.toggle('hidden', true);
      announce();
      return true;
    }
    /* the transport: app.js's ctx.api.attachFile when the integrator has it (one place for every
       request the app makes), else the same request made here — the module must work against an
       app.js that predates §10 as well as it does against this one. Never throws. */
    function transport(paneId, name, file) {
      var hname = headerName(name);
      /* prefer the integrator's helper: ctx.api normalizes every failure into
         {ok:false, error:{code,message}} and never rejects, so the chip can always show a reason */
      if (deps.api && typeof deps.api.attachFile === 'function') {
        var p;
        try { p = deps.api.attachFile(paneId, hname, file); } catch (e) { p = null; }
        var pr = (p && typeof p.then === 'function') ? p : Promise.resolve(p);
        return pr.then(function (body) {
          return { ok: !!(body && body.ok === true), status: 0, body: body };
        }, function (e) {
          return { ok: false, status: 0, body: { error: { code: 'network', message: 'request failed: ' + text(e && e.message ? e.message : e) } } };
        });
      }
      var opts = { method: 'POST', headers: { 'x-hd-name': hname, 'x-hd-pane': text(paneId) }, body: file };
      return window.fetch('/api/attach', opts).then(function (res) {
        return res.json().then(function (b) {
          if (b && typeof b === 'object') {
            if (typeof b.ok !== 'boolean') b.ok = res.ok;
            return { ok: b.ok === true, status: res.status, body: b };
          }
          return { ok: false, status: res.status, body: null };
        }, function () { return { ok: false, status: res.status, body: null }; });
      }, function (e) {
        return { ok: false, status: 0, body: { error: { code: 'network', message: 'request failed: ' + text(e && e.message ? e.message : e) } } };
      });
    }
    function settle(it, res) {
      var body = (res && res.body !== undefined) ? res.body : res;
      if (res && res.ok === true && body && text(body.path).length) {
        it.state = 'ready';
        it.path = text(body.path);                          // verbatim: the server's own path
        it.why = '';
        it.bytes = num(body.bytes);
        it.serverName = text(body.name);
      } else {
        it.state = 'failed';
        it.why = attachErrText(body, res ? res.status : 0);
      }
      repaint(it);
      announce();
      return it;
    }
    function uploadOne(it, paneId) {
      var res;
      try { res = transport(paneId, it.name, it.file); } catch (e) { res = Promise.reject(e); }
      var pr = (res && typeof res.then === 'function') ? res : Promise.resolve(res);
      return pr.then(function (r) { return settle(it, r); }, function (e) {
        it.state = 'failed';
        it.why = 'the upload failed: ' + text(e && e.message ? e.message : e);
        repaint(it);
        announce();
        return it;
      });
    }
    /* accept a FileList / array of File from any of the three input paths. Returns the count added
       and the refusals with their reason, so a caller (and a test) can see that nothing was
       silently dropped. */
    function accept(fileList, paneId, opts) {
      var files = [];
      try {
        if (fileList && typeof fileList.length === 'number') {
          for (var i = 0; i < fileList.length; i++) if (fileList[i]) files.push(fileList[i]);
        } else if (fileList) { files.push(fileList); }
      } catch (e) { files = []; }
      var src = text(opts && opts.source) || 'file';
      var pid = text(paneId) || text(deps.getPaneId && deps.getPaneId()) || '';
      var added = 0, refused = [];
      noteText = '';
      for (var j = 0; j < files.length; j++) {
        var f = files[j];
        var name = text(f.name || (f.file && f.file.name) || 'file');
        if (items.length >= ATTACH_MAX) {
          refused.push({ name: name, why: 'at most ' + ATTACH_MAX + ' attachments per message' });
          continue;
        }
        var it = {
          id: 'a' + (++seq), seq: seq, name: name, size: num(f.size), file: f,
          state: 'uploading', path: null, why: '', node: null, source: src
        };
        items.push(it);
        repaint(it);
        uploadOne(it, pid);
        added++;
      }
      if (refused.length) {
        noteText = refused.length + ' file' + (refused.length === 1 ? '' : 's') +
          ' refused — ' + refused.map(function (r) { return '"' + r.name + '" (' + r.why + ')'; }).join(', ') +
          '. nothing was attached and nothing was sent.';
      }
      announce();
      return { added: added, refused: refused, count: items.length };
    }
    /* §10.4: the sent text is the typed text plus this block and nothing else. The block is one
       absolute path per line, verbatim; with no typed text the block IS the message (no leading
       blank line). Returns {ok:false, why} while a chip is uploading or failed (§10.5). */
    function composeSend(paneId, typedText) {
      var why = blockReason();
      if (why) return { ok: false, why: why, text: null, paths: [] };
      var paths = [];
      for (var i = 0; i < items.length; i++) if (items[i].state === 'ready') paths.push(text(items[i].path));
      var typed = text(typedText);
      if (!paths.length) return { ok: true, text: typed, paths: [] };
      var block = ATTACH_BLOCK_HEAD + '\n' + paths.join('\n');
      return { ok: true, text: typed.length ? typed + '\n\n' + block : block, paths: paths, block: block };
    }
    listEl.classList.toggle('hidden', items.length === 0);

    return {
      accept: accept, remove: remove, clear: clear, summary: summary,
      composeSend: composeSend, blockReason: blockReason, items: function () { return items.slice(); },
      listEl: function () { return listEl; }, noteEl: function () { return noteEl; },
      max: ATTACH_MAX, blockHead: ATTACH_BLOCK_HEAD
    };
  }

  /* ────────────────────────────────────────────────────────────── the module */

  function mount(ctx) {
    /* idempotent: a second mount() call on a live instance returns the very same handle. Two
       instances would share the single #chatHost element and poll the same pane twice. */
    if (handle && handle.mounted() && liveHost && document.body.contains(liveHost)) return handle;

    var host = document.getElementById('chatHost');
    if (!host) {                                   // defensive: the host is declared in index.html
      host = el('div', 'chat-host');
      host.id = 'chatHost';
      (document.getElementById('transcriptWrap') || document.body).appendChild(host);
    }

    injectFallbackCss();
    liveHost = host;

    var statusEl = el('div', 'chat-status');
    statusEl.id = 'hdChatStatus';
    var stInfo = el('span', 'chat-status-info');
    var stWarn = el('span', 'chat-status-warn');
    var olderBtn = el('button', 'chat-btn', 'load older · ' + OLDER_LIMIT);
    olderBtn.type = 'button';
    /* DEFECT-18(2): the control the timeout note points at. Hidden unless a read has timed out. */
    var retryBtn = el('button', 'chat-btn hidden', 'retry now');
    retryBtn.id = 'hdChatRetry';
    retryBtn.type = 'button';
    retryBtn.title = 'ask again for the same pane from the same cursor';
    var rawBtn = el('button', 'chat-btn', 'raw (t)');
    rawBtn.type = 'button';
    statusEl.appendChild(stInfo);
    statusEl.appendChild(stWarn);
    statusEl.appendChild(el('span', 'grow'));
    statusEl.appendChild(retryBtn);
    statusEl.appendChild(olderBtn);
    statusEl.appendChild(rawBtn);

    var scrollEl = el('div', 'hd-cv-scroll chat-scroll');     // W3 styles .hd-cv-scroll
    scrollEl.id = 'hdChatScroll';
    var listEl = el('div', 'hd-cv-list chat-list');           // W3 styles .hd-cv-list
    listEl.id = 'hdChatList';
    var stateEl = el('div', 'hd-cv-empty chat-state hidden');
    stateEl.id = 'hdChatState';
    var olderEl = el('div', 'hd-cv-note chat-older hidden');
    olderEl.id = 'hdChatOlder';
    listEl.appendChild(stateEl);
    listEl.appendChild(olderEl);
    scrollEl.appendChild(listEl);

    var jumpBtn = el('button', 'hd-cv-jump chat-jump hidden', '0 new ↓');
    jumpBtn.id = 'hdChatJump';
    jumpBtn.type = 'button';
    scrollEl.appendChild(jumpBtn);                            // sticky inside the scroller (W3)

    host.appendChild(statusEl);
    host.appendChild(scrollEl);

    var chip = document.getElementById('hViewMode');

    /* default CHAT for a first visit (the user asked for the conversation view); only an explicit
       stored 'raw' keeps the raw transcript — a missing key must not fall through to raw */
    var mode = (lsGet(LS_VIEW, null) === 'raw') ? 'raw' : 'chat';
    var follow = true;
    var newCount = 0;
    var panes = {};                  // paneId -> pane state
    var pollTimer = null;
    var pendingTimer = null;
    var workingTimer = null;
    var inflight = null;             // DEFECT-12: an OBJECT ({id, startedAt, cursor, ctrl}), never a latch
    var reqTimer = null;             // DEFECT-18(2): the request's own timeout timer (a real one)
    var reqTimeoutMs = REQ_TIMEOUT_MS;   // test-only override (window.HD.chatviewTest)
    var lastAsk = null;              // DEFECT-18(1): {id, since, tail, at} of the last request issued
    var paneOverride = null;         // test-only pane (window.HD.chatviewTest)
    var statusOverride = null;       // test-only {id, status}: the working tail without a live pane
    var auto = true;                 // test-only: false stops ALL polling/timers
    var pendingSeq = 0;
    var offSelect = null;
    var offStatus = null;
    var unmounted = false;
    var mounted = false;

    /* §10: the composer's attachments. The engine owns the chips and is the only thing that knows
       what the next send will be; app.js owns the three input paths and asks it. */
    var attach = createAttach({
      api: ctx.api || null,
      getPaneId: currentPaneId,
      emit: function (info) {
        try { ctx.events.emit('attach', info); } catch (e) { /* the composer is optional */ }
      }
    });

    /* ---------------- per-pane state ---------------- */

    function paneState(id) {
      var st = panes[id];
      if (!st) {
        st = panes[id] = {
          id: id, messages: [], keys: {}, cursor: 0, gotCursor: false,
          agent: null, source: null, error: null, empty: false,
          unknown: 0, skipped: 0, truncated: false, catchUp: 0, empties: 0, emptiesServer: 0,
          /* A1 bookkeeping: `rendered` is exactly what the DOM holds — one entry per TURN group
             [{from, to, node}] over message indices (a group is redrawn as a whole) */
          rendered: [], renderedTo: 0, workingNode: null, workingSince: 0, openBig: null, reclose: null,
          expanded: false, loadingOlder: false, olderNote: '',
          /* A2: the reader's folds — `foldedKeys` is UI state (msg.key -> true) that lives only in
             this session and only in this pane; `msgByKey` is the record each key names */
          foldedKeys: {}, msgByKey: {},
          /* A3: the reader's opens — `openKeys` is UI state too (a block's stable id -> true when the
             reader opened a collapsed-by-default block, false when they closed one that would
             otherwise start open). A3.1: a FALSE entry is the reader speaking, so the map is read
             with hasOwnProperty and an entry is never deleted merely for being falsy. */
          openKeys: {},
          /* §8.2 tail mode: `tailChecked` = the first (tail) response was seen; `tailMode` = the
             server really answered from the tail; `verifyTail` = one forward call is pending */
          tailChecked: false, tailMode: null, verifyTail: false,
          /* DEFECT-12: the last request the server never answered (cleared by the next body) */
          stall: null, stalls: 0,
          pending: [], lastQuery: '', lastFetchAt: 0, fetches: 0, errors: 0
        };
      }
      return st;
    }
    function currentPaneId() {
      if (paneOverride) return paneOverride;
      try { return ctx.state.selectedPaneId || null; } catch (e) { return null; }
    }

    /* ---------------- data ---------------- */

    /* §8.2 request. `since` is the previous cursor (0 on the first call: claude byte 0 / hermes id
       > 0 both mean "from the beginning"); "load older" omits it and asks for the whole session. */
    function query(paneId, since, limit, extra) {
      var hasSince = !(since === undefined || since === null);
      var x = extra || {};
      var desc = paneId + '|since=' + (hasSince ? since : '-') + '|limit=' + limit + (x.tail ? '|tail' : '');
      if (ctx.api && typeof ctx.api.chat === 'function') {
        var opts = { pane_id: paneId, limit: limit };
        if (hasSince) opts.since = since;
        if (x.tail) opts.tail = true;                     // §8.2 tail mode (W1, round 7.1)
        if (x.signal) opts.signal = x.signal;             // DEFECT-12: abortable
        var p = ctx.api.chat(opts);
        var pr = (p && typeof p.then === 'function') ? p : Promise.resolve(p);
        return pr.then(function (body) {
          if (body && typeof body === 'object') body.__q = desc;
          return body;
        });
      }
      /* fallback if app.js is older than this module: same URL, same never-throwing contract */
      var url = '/api/chat?pane_id=' + encodeURIComponent(paneId);
      if (hasSince) url += '&since=' + encodeURIComponent(since);
      if (limit) url += '&limit=' + encodeURIComponent(limit);
      if (x.tail) url += '&tail=1';
      return fetch(url, x.signal ? { signal: x.signal } : undefined).then(function (res) {
        return res.json().then(function (b) {
          if (b && typeof b === 'object') { if (typeof b.ok !== 'boolean') b.ok = res.ok; b.__q = desc; return b; }
          return { ok: false, error: { code: 'bad_response', message: 'HTTP ' + res.status + ' (not JSON)' }, __q: desc };
        }, function () {
          return { ok: false, error: { code: 'bad_response', message: 'HTTP ' + res.status + ' (not JSON)' }, __q: desc };
        });
      }, function (e) {
        return { ok: false, error: { code: 'network', message: 'request failed: ' + (e && e.message ? e.message : String(e)) }, __q: desc };
      });
    }

    /* DEFECT-12: the in-flight request is an OBJECT with a start time and an AbortController, not a
       boolean. A boolean has no clock, so one response that never came held the flag forever while
       the poll timer kept firing into `if (inflight) return;` — every pane selected after that
       showed "reading the structured session of …" with zero fetches, no error and no way back. */
    function inflightAge() { return inflight ? (Date.now() - inflight.startedAt) : 0; }
    /* The exact decision that froze the panel, as one function: the old code was `if (inflight)
       return;` — no age, no owner, so `wait` was the only answer it could ever give.
       NOTE the clock: it reads `startedAt` (a wall-clock stamp), NOT `cursor`. Those two lived in
       the same object and the first version of this latch put the protocol cursor in the field the
       age was measured from, so every request whose cursor was smaller than now-12 s (which is every
       cursor) was declared dead the moment a second poll tick saw it: the request was aborted, a
       bogus "1 request stalled" appeared and the same page was fetched twice. */
    function latchDecision(req, id, nowMs) {
      if (!req) return 'go';
      if (req.id !== id) return 'abandon';                       // some other pane's request: useless here
      if ((nowMs - req.startedAt) >= reqTimeoutMs) return 'abandon'; // it has been away too long
      return 'wait';                                             // young, and for this pane: let it land
    }
    function clearReqTimer() {
      if (reqTimer) { window.clearTimeout(reqTimer); reqTimer = null; }
    }
    /* DEFECT-18(2): the timeout is a TIMER, not a lazy check. Before this, a request that never
       settled held the latch until some LATER poll tick happened to look at its age — and poll()
       returns early when the tab is hidden, the mode is raw or no pane is selected, so the latch
       could outlive every caller that could have released it. The timer belongs to the request it
       was armed for, so a response that lands first clears it and an abandoned request cannot fire
       a second release for its successor. */
    function armReqTimer(req) {
      clearReqTimer();
      reqTimer = window.setTimeout(function () {
        reqTimer = null;
        if (inflight === req) abandonInflight('timeout');
      }, reqTimeoutMs);
    }
    function abandonInflight(why) {
      clearReqTimer();
      if (!inflight) return false;
      var req = inflight;
      inflight = null;                             // released FIRST: the caller must not stay blocked
      try { if (req.ctrl && req.ctrl.abort) req.ctrl.abort(); } catch (e) { /* already gone */ }
      /* Only a TIMEOUT is a stall — the server really went quiet. Dropping the request of a pane the
         user has left is the design working, and counting it would put "1 request stalled" in the
         strip on every ordinary pane switch (a warning that cries wolf is worse than none). */
      var st = paneState(req.id);
      if ((why || 'timeout') === 'timeout') {
        st.stalls++;
        st.stall = { at: Date.now(), why: 'timeout', ms: Date.now() - req.startedAt, cursor: req.cursor };
        if (req.id === currentPaneId()) { renderState(st); renderStatus(st); }
      }
      return true;
    }
    function poll() {
      if (!auto || unmounted || mode !== 'chat') return;
      if (document.hidden) return;                 // the tab is not on screen; nothing to refresh
      var id = currentPaneId();
      if (!id) { renderAll(); return; }
      /* a request for ANOTHER pane is of no use to the pane the user is looking at now → drop it and
         go (the pane being left keeps its old cursor, so nothing is skipped); a request for THIS pane
         that has been away longer than reqTimeoutMs is dead and must not block the tick */
      var d = latchDecision(inflight, id, Date.now());
      if (d === 'abandon') abandonInflight(inflight.id === id ? 'timeout' : 'pane-switch');
      else if (d === 'wait') return;
      var st = paneState(id);
      var since = st.gotCursor ? st.cursor : 0;
      /* §8.2 tail mode: the FIRST request is a tail page, and a tail page carries NO `since` —
         `since` walks forward from a cursor while `tail=1` starts from the end, so the server
         rejects the combination as bad_request (W1 made it a hard rule, not a silent preference).
         The tail reply returns the cursor at EOF, and the forward polls carry on from there. */
      var tailFirst = !st.gotCursor;
      var askSince = tailFirst ? null : since;
      /* DEFECT-18(1): ONE poll per pane per tick. Measured (a stack-recording probe, 2026-09-25):
         the mount's own `applyMode → poll` is followed 15-18 ms later by a SECOND identical request
         from `setMode/show` (the selftest path) or from the select handler's trailing `poll()` — the
         exact same pane with the exact same cursor. The latch only stops the twin while the first
         request is still in flight, so on a warm server (the first answer measured at 20 ms, cold
         110-124 ms) the twin goes out on the wire and doubles the cold-scan cost. A read of the SAME
         pane at the SAME cursor that was asked within REQ_DEDUP_MS cannot return anything new — the
         first request is either still in flight or has just been ingested — so the twin is dropped.
         Keyed on (pane, since, tail), never on the pane alone: the catch-up walk asks again with the
         NEXT cursor and "load older" asks with none, so neither is ever suppressed by this. */
      var nowMs = Date.now();
      var sigSince = tailFirst ? null : String(since);
      if (lastAsk && lastAsk.id === id && lastAsk.since === sigSince && lastAsk.tail === tailFirst &&
          (nowMs - lastAsk.at) < REQ_DEDUP_MS) {
        return;
      }
      var req = { id: id, startedAt: nowMs, cursor: tailFirst ? null : since, ctrl: null };
      try { if (window.AbortController) req.ctrl = new AbortController(); } catch (e) { req.ctrl = null; }
      inflight = req;
      lastAsk = { id: id, since: sigSince, tail: tailFirst, at: nowMs };
      armReqTimer(req);                            // DEFECT-18(2): this request releases itself
      var extra = { tail: tailFirst };
      /* DEFECT-12, the second half: the AbortController is useless unless its signal travels with
         the request. Without this line `abort()` only flips a flag we ourselves read — the fetch
         keeps its socket, the dead request stays on the wire, and the retry lands behind it. */
      if (req.ctrl) extra.signal = req.ctrl.signal;
      req.tail = extra.tail;
      query(id, tailFirst ? null : since, extra.tail ? TAIL_LIMIT : PAGE_LIMIT, extra).then(function (body) {
        if (inflight === req) { inflight = null; clearReqTimer(); }
        if (req.ctrl && req.ctrl.signal && req.ctrl.signal.aborted) return;   // abandoned on purpose
        var b = body || {};
        b.__stall = null;
        /* meta.tail MUST travel with the body: it is how ingest knows this was a tail page and not a
           head page (the two are identical on the wire — that is the whole §8.2 verification) */
        ingest(id, b, { tail: !!req.tail });
      }, function (e) {
        if (inflight === req) { inflight = null; clearReqTimer(); }
        if (req.ctrl && req.ctrl.signal && req.ctrl.signal.aborted) return;   // the abort we asked for
        ingest(id, { ok: false, error: { code: 'network', message: String(e && e.message ? e.message : e) } });
      });
    }

    /** feed one §8.2 body through the same path a network response takes */
    function ingest(id, body, meta) {
      var st = paneState(id);
      st.fetches++;
      st.lastFetchAt = Date.now();
      st.stall = null;                               // a body arrived: nothing is stalled any more
      if (body && body.__q) st.lastQuery = body.__q;
      var code = (body && body.error && body.error.code) ? String(body.error.code) : '';

      if (!body || body.ok !== true || code === 'no_messages_yet') {
        if (code === 'no_messages_yet') {            // §8.1: empty is a SUCCESS, not an error
          st.error = null;
          st.empty = true;
        } else {
          st.error = (body && body.error) ? body.error : { code: 'bad_response', message: 'the server sent no JSON body' };
          st.errors++;
          if (id === currentPaneId()) { renderState(st); renderStatus(st); }
          return;
        }
      } else {
        st.error = null;
        if (body.agent) st.agent = body.agent;
        if (body.source) st.source = body.source;
        if (body.cursor !== undefined && body.cursor !== null) { st.cursor = body.cursor; st.gotCursor = true; }
        st.skipped = num(body.skipped);
        st.unknown = num(body.unknown_records);
        st.truncated = !!body.truncated;
        /* DEFECT-10: a server that filters empty records reports how many it dropped, and one that
           still sends them leaves the client to hide them. Showing the LARGER of the two counts
           says the truth in both worlds and can never double-count the same record twice. */
        st.emptiesServer = num(body.empty_records);

        var msgs = Array.isArray(body.messages) ? body.messages : [];
        var added = 0;
        for (var i = 0; i < msgs.length; i++) {
          var m = msgs[i];
          if (!m) continue;
          var k = keyOf(m);
          if (st.keys[k]) continue;
          st.keys[k] = 1;
          st.msgByKey[k] = m;                        // A2: the record a folded key names
          m.__empty = isEmptyRecord(m);              // DEFECT-10: never draw a blank row
          if (m.__empty) st.empties++;
          st.messages.push(m);
          added++;
        }
        if (st.messages.length > MEM_MAX) {
          var drop = st.messages.length - MEM_MAX;
          st.messages.splice(0, drop);
          st.renderedTo = Math.max(0, st.renderedTo - drop);
          var kept = [];
          for (var ci = 0; ci < st.rendered.length; ci++) {
            var ch = st.rendered[ci];
            if (ch.to <= drop) {                     // this group has left the memory list entirely
              if (ch.node && ch.node.parentNode) ch.node.parentNode.removeChild(ch.node);
              if (ch.node === st.workingNode) st.workingNode = null;
              continue;
            }
            ch.from = Math.max(0, ch.from - drop);
            ch.to = ch.to - drop;
            kept.push(ch);
          }
          st.rendered = kept;
          if (st.openBig !== null) st.openBig = Math.max(0, st.openBig - drop);
          if (st.reclose !== null) st.reclose = Math.max(0, st.reclose - drop);
          for (var pi = 0; pi < st.pending.length; pi++) st.pending[pi].since = Math.max(0, st.pending[pi].since - drop);
        }
        st.empty = (st.messages.length === 0);

        /* A2.5: a fold belongs to a RECORD, so the key map follows the memory list exactly — a key
           whose message has left the buffer is dropped rather than kept to fold a future message
           that happens to reuse it (and never leaks into another pane, which has its own map) */
        var live = {};
        for (var mi = 0; mi < st.messages.length; mi++) live[keyOf(st.messages[mi])] = st.messages[mi];
        st.msgByKey = live;
        for (var fk in st.foldedKeys) {
          if (Object.prototype.hasOwnProperty.call(st.foldedKeys, fk) && !live[fk]) delete st.foldedKeys[fk];
        }
        /* A3.5: the same rule for the opens, whose ids are NOT keys — a thinking block is
           `<key>#think<ordinal>`, a tool card `<key>#tool<call_key>`, long text `<key>#text`. An id is
           live while the record it is derived from is still in the buffer, and is dropped the moment
           that record leaves, so a stale id can never open a block of some later record that reuses
           the key. Compared with the prefix rule rather than by splitting on '#' so that a key
           containing a '#' cannot be mistaken for its own base. */
        var liveIds = Object.keys(live);
        for (var ok in st.openKeys) {
          if (!Object.prototype.hasOwnProperty.call(st.openKeys, ok)) continue;
          var kept = false;
          for (var li = 0; li < liveIds.length && !kept; li++) {
            kept = (ok === liveIds[li]) || (ok.indexOf(liveIds[li] + '#') === 0);
          }
          if (!kept) delete st.openKeys[ok];
        }

        /* §8.2 tail mode (W1). A tail response carries the cursor at EOF, so `truncated` there means
           "older records exist BEFORE this window" and must NOT start a forward walk. A server
           without tail mode answers a tail request with a HEAD page, which looks the same from here,
           so it is verified once: the next forward call either returns records (we were at the head —
           and that call is the first step of the old bounded walk) or returns none (really at EOF). */
        var reqTail = !!(meta && meta.tail);
        if (reqTail) {
          st.tailChecked = true;
          st.tailMode = (body.tail === true || body.tail === 1) ? true : (body.truncated !== true);
          st.verifyTail = !st.tailMode;
        } else if (st.verifyTail) {
          st.verifyTail = false;
          st.tailMode = (added > 0) ? false : true;
        }

        resolvePending(st);
        if (id === currentPaneId()) {
          renderNew(st, false);
          renderPendings(st);
          refreshWorking(st);
          if (follow) scrollToBottom();
          else if (added) { newCount += added; updateJump(); }
        }
        /* Fallback walk (only when tail mode is off or not yet proven): a session longer than one
           page would otherwise open on its OLDEST page (since=0 is the beginning per §8.2). Walk the
           cursor forward without waiting for the next tick, bounded so this can never spin. Reset
           whenever a page is not truncated (the tail has been reached). With tail mode this never
           runs: the cursor already IS the tail. */
        var mayWalk = (st.tailMode !== true);
        st.catchUp = (body.truncated && mayWalk) ? num(st.catchUp) + 1 : 0;
        if (body.truncated && mayWalk && st.catchUp <= CATCHUP_MAX && auto && !unmounted && mode === 'chat' &&
            id === currentPaneId()) {
          window.setTimeout(poll, 0);
        }
      }
      syncTimers();
      if (id === currentPaneId()) { renderState(st); renderStatus(st); }
    }

    /* ---------------- pending sends (§8.3) ---------------- */

    function notePending(paneId, tx) {
      try {
        var id = paneId || currentPaneId();
        var body = text(tx);
        if (!id || !body.length) return false;
        var st = paneState(id);
        var p = { id: 'p' + (++pendingSeq), text: body, sentAt: Date.now(), since: st.messages.length, lost: false, resolved: false };
        st.pending.push(p);
        if (id === currentPaneId()) { renderPendings(st); if (follow) scrollToBottom(); }
        syncTimers();
        return true;
      } catch (e) { return false; }
    }

    /* A prompt counts as "in the log" only if it appeared AFTER the send: everything already in the
       list at send time is an earlier turn (the same text may legitimately have been sent before).
       After a whole-session load every pending re-scans from index 0. */
    function resolvePending(st) {
      if (!st.pending.length) return false;
      var changed = false;
      for (var i = st.pending.length - 1; i >= 0; i--) {
        var p = st.pending[i];
        if (p.resolved) continue;
        var want = norm(p.text);
        if (!want.length) continue;
        var from = Math.max(0, Math.min(p.since, st.messages.length));
        var hit = -1;
        for (var j = st.messages.length - 1; j >= from; j--) {
          var m = st.messages[j];
          if (!m || m.role !== 'user') continue;
          if (m.kind && m.kind !== 'text') continue;
          if (norm(m.text) === want) { hit = j; break; }
        }
        if (hit >= 0) {                              // the real record replaces the bubble
          p.resolved = true;
          p.replacedBy = keyOf(st.messages[hit]);
          p.replacedByTs = st.messages[hit].ts;
          st.pending.splice(i, 1);
          changed = true;
        }
      }
      return changed;
    }

    function pendingTick(now) {
      var id = currentPaneId();
      if (!id) return false;
      var st = paneState(id);
      if (!st.pending.length) return false;
      var lost = false;
      for (var i = 0; i < st.pending.length; i++) {
        var p = st.pending[i];
        if (!p.lost && (now - p.sentAt) >= PENDING_TIMEOUT_MS) { p.lost = true; lost = true; }
      }
      if (lost) renderPendings(st);
      else refreshPendingNotes(st, now);
      return lost;
    }

    function hasUnresolvedPending() {
      var id = currentPaneId();
      if (!id) return false;
      var st = paneState(id);
      for (var i = 0; i < st.pending.length; i++) if (!st.pending[i].lost) return true;
      return false;
    }

    /* ---------------- rendering ---------------- */

    function messageNodes() {
      var out = listEl.querySelectorAll('.hd-cv-msg, .chat-msg');
      var keep = [];
      for (var i = 0; i < out.length; i++) if (isMessageNode(out[i])) keep.push(out[i]);
      return keep;
    }
    function groupNodes() {
      var out = listEl.querySelectorAll('.chat-turn, .hd-cv-turn');
      return out;
    }
    function firstPendingNode() {
      for (var i = 0; i < listEl.children.length; i++) {
        var c = listEl.children[i];
        if (c.classList && c.classList.contains('chat-pending')) return c;
      }
      return null;
    }
    function clearMessages(st) {
      /* remove every node this module owns, whatever renderer produced it: the turn groups we
         track, any stray group/message node, and the pending bubbles (rebuilt from state) */
      if (st && st.rendered) {
        for (var i = 0; i < st.rendered.length; i++) {
          var n = st.rendered[i].node;
          if (n && n.parentNode) n.parentNode.removeChild(n);
        }
        st.rendered = [];
        st.workingNode = null;
        st.renderedTo = 0;
      }
      var sel = '.hd-cv-turn, .chat-turn, .hd-cv-msg, .chat-msg, .chat-pending, .chat-looserec';
      var stray = listEl.querySelectorAll(sel);
      for (var j = stray.length - 1; j >= 0; j--) if (stray[j].parentNode) stray[j].parentNode.removeChild(stray[j]);
    }

    /* ── A1: turns, not messages, are the DOM unit ────────────────────────────────────────────
       The DOM holds turn groups: `rendered` is exactly what is on screen — [{from, to, node}] over
       message indices, in order. A group is redrawn as a whole because its look depends on the
       records that follow it (the last assistant text becomes the reply, the working tail goes
       away), and because ChatRender folds a tool_result into its tool_call's card, so one message
       is never one node. Nothing here counts nodes against messages (that is what blanked the panel
       in the first round). */

    /* A2.4 + A3.1: EVERY render path carries BOTH reader-state maps, so a fold AND an open survive
       an incremental append, a full re-render (loadWhole / pane switch / refresh) and a streamed
       redraw of the turn they sit in. `null` for a caller with no pane state — the renderer then
       folds nothing and opens nothing. */
    function renderOpts(st) {
      return { pending: false, now: Date.now(), renderer: rendererName(),
               foldedKeys: (st && st.foldedKeys) ? st.foldedKeys : null,
               openKeys: (st && st.openKeys) ? st.openKeys : null };
    }

    /** A1 rule 3: a turn starts at a `user` text record and runs to the record before the next one. */
    function isUserText(m) { return !!m && m.role === 'user' && (!m.kind || m.kind === 'text'); }
    /** DEFECT-10: a text/thinking record with no text is nothing to show — never a blank row. */
    function isEmptyRecord(m) {
      if (!m || typeof m !== 'object') return true;
      var kind = m.kind || 'text';
      if (kind === 'tool_call' || kind === 'tool_result') return false;   // a card is a fact
      return norm(m.text) === '';
    }
    function buildTurns(messages, from, to) {
      var out = [], cur = null;
      for (var i = from; i < to; i++) {
        var m = messages[i];
        if (!m) continue;
        if (m.__empty) { if (cur) cur.to = i + 1; continue; }     // hidden, but it still occupies a slot
        if (isUserText(m)) {
          cur = { user: m, segments: [], from: i, to: i + 1 };
          out.push(cur);
          continue;
        }
        if (!cur) { cur = { user: null, segments: [], from: i, to: i + 1 }; out.push(cur); }
        cur.segments.push(m);
        cur.to = i + 1;
      }
      return out;
    }
    /** the pane's live agent_status (A1 rule 4 drives the working tail from it) */
    function paneStatus(id) {
      if (statusOverride && statusOverride.id === id) return statusOverride.status;   // test-only seam
      try {
        var p = (ctx.state && typeof ctx.state.pane === 'function') ? ctx.state.pane(id) : null;
        var s = p && (p.agent_status || p.status);
        return s ? String(s).toLowerCase() : '';
      } catch (e) { return ''; }
    }
    function isWorking(id) {
      var s = paneStatus(id);
      return s === 'working' || s === 'busy' || s === 'running' || s === 'thinking';
    }
    function turnOf(st, g) {
      var last = (g.to >= st.messages.length);
      var working = last && isWorking(st.id);
      var firstTs = 0;
      if (g.user && g.user.ts) firstTs = g.user.ts;
      else if (g.segments.length && g.segments[0].ts) firstTs = g.segments[0].ts;
      return {
        from: g.from, to: g.to, user: g.user, segments: g.segments, working: working, firstTs: firstTs,
        elapsedMs: (working && firstTs) ? Math.max(0, Date.now() - firstTs) : null
      };
    }
    /** the fallback group (only when lib/chat-render.js is missing): same parts, own classes */
    function fbRenderTurn(turn) {
      var g = el('div', 'chat-turn chat-msg');
      if (turn.pending) g.classList.add('chat-pending-turn');
      if (turn.user) g.appendChild(fbRenderMessage(turn.user));
      else g.appendChild(el('div', 'chat-note small', 'the agent\'s own records follow (no prompt record)'));
      for (var i = 0; i < turn.segments.length; i++) {
        var m = turn.segments[i];
        if (isEmptyRecord(m)) continue;
        g.appendChild(fbRenderMessage(m));
      }
      if (turn.working) g.appendChild(el('div', 'chat-working', 'working · ' + Math.floor((turn.elapsedMs || 0) / 1000) + 's'));
      return g;
    }
    function turnNode(st, g) {
      var turn = turnOf(st, g);
      var node = null;
      var R = renderer();
      if (R && typeof R.renderTurn === 'function') {
        try { node = R.renderTurn(turn, renderOpts(st)); } catch (e) { node = null; }
      }
      if (!node || node.nodeType !== 1) node = fbRenderTurn(turn);
      node.setAttribute('data-turn', g.from + '-' + g.to);
      if (turn.working) node.setAttribute('data-working', '1');
      if (turn.working) { st.workingNode = node; st.workingSince = turn.firstTs || Date.now(); }
      return node;
    }
    function appendGroups(st, from, to) {
      var groups = buildTurns(st.messages, from, to);
      var before = firstPendingNode();
      var closedBig = false;
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        var node;
        if (!g.user && g.segments.length && i === 0 && from > 0) {
          /* the head of this turn is above the render window: draw its records as they are rather
             than claiming "this turn has no prompt record" — a window edge is not a log property */
          node = el('div', 'chat-looserec');
          var frag = renderMessages(g.segments, renderOpts(st));
          if (frag) node.appendChild(frag);
          st.workingNode = null;
        } else {
          node = turnNode(st, g);
        }
        listEl.insertBefore(node, before);
        syncReader(st, node);        // A2/A3: a folded or opened record comes back as it was left
        st.rendered.push({ from: g.from, to: g.to, node: node });
        if (st.openBig !== null && i > 0 && g.user) closedBig = true;
      }
      if (closedBig) { st.reclose = st.openBig; st.openBig = null; }   // redraw the big turn once, closed
    }
    function dropFrom(st, from) {
      while (st.rendered.length && st.rendered[st.rendered.length - 1].from >= from) {
        var g = st.rendered.pop();
        if (g.node === st.workingNode) st.workingNode = null;
        if (g.node && g.node.parentNode) g.node.parentNode.removeChild(g.node);
      }
    }
    function trimFront(st, floor) {
      while (st.rendered.length > 1 && st.rendered[0].to <= floor) {
        var g = st.rendered.shift();
        if (g.node === st.workingNode) st.workingNode = null;
        if (g.node && g.node.parentNode) g.node.parentNode.removeChild(g.node);
      }
    }
    /** how many messages the DOM may hold: RENDER_MAX normally, EXPAND_MAX after "load older" */
    function floorOf(st) {
      var max = st.expanded ? EXPAND_MAX : RENDER_MAX;
      return Math.max(0, st.messages.length - max);
    }
    /** §13.2.1: after every render, hand the freshly drawn messages to the link module — a render
     *  makes NEW text nodes, and a link drawn in the previous ones went away with them. The pass is a
     *  promise that resolves on its own, so nothing here waits for it; the module asks the server
     *  about each candidate once and never twice (§13.2.2), which is what makes this cheap enough to
     *  call on every render. Absent or broken, the text stays exactly as the agent wrote it. */
    function decoratePaths() {
      var pl = window.HD && window.HD.pathlink;
      if (!pl || typeof pl.decorate !== 'function') return;
      try {
        var p = pl.decorate(listEl);
        if (p && typeof p.then === 'function') p.then(function () { }, function () { });
      } catch (e) { /* a reader's view never fails because a link could not be drawn */ }
    }
    /** A1 rule 1: draw what has landed — never wait for the turn to end. */
    function renderNew(st, force) {
      var floor = floorOf(st);
      trimFront(st, floor);
      var len = st.messages.length;
      var last = st.rendered.length ? st.rendered[st.rendered.length - 1] : null;
      var from;
      if (!last) from = floor;
      else if (force || (len - last.from) <= TURN_RERENDER_MAX) from = last.from;   // redraw the open turn
      else { from = st.renderedTo; st.openBig = last.from; }                        // huge turn: append only
      if (from < floor) from = floor;
      dropFrom(st, from);
      st.renderedTo = from;
      if (len > from) appendGroups(st, from, len);
      st.renderedTo = len;
      if (st.reclose !== null) {                      // the open big turn just ended: close it properly
        var r = st.reclose;
        st.reclose = null;
        if (r >= floor) {
          dropFrom(st, r);
          st.renderedTo = r;
          if (len > r) appendGroups(st, r, len);
          st.renderedTo = len;
        }
      }
      decoratePaths();                                // §13.2.1: the text just drawn, as links
    }
    function renderPendings(st) {
      var id = currentPaneId();
      var nodes = listEl.querySelectorAll('.chat-pending');
      for (var i = nodes.length - 1; i >= 0; i--) if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
      if (!st || st.id !== id || !st.pending.length) return;
      var now = Date.now();
      for (var j = 0; j < st.pending.length; j++) listEl.appendChild(renderPendingGroup(st.pending[j], now, st));
    }
    function refreshPendingNotes(st, now) {
      var id = currentPaneId();
      if (!st || st.id !== id) return;
      var nodes = listEl.querySelectorAll('.chat-pending');
      for (var i = 0; i < nodes.length; i++) {
        var pid = nodes[i].getAttribute('data-pending-id');
        for (var j = 0; j < st.pending.length; j++) {
          var p = st.pending[j];
          if (p.id !== pid) continue;
          var note = nodes[i].querySelector('.chat-pending-note') || nodes[i].querySelector('.hd-cv-note');
          if (note) { note.textContent = pendingNoteText(p, now); if (note.classList) note.classList.add('chat-pending-note'); }
        }
      }
    }

    /* ── A2 (§8.3 amendment 2): the reader's fold ─────────────────────────────────────────────
       `st.foldedKeys` is the whole state: per pane, keyed by `msg.key`, in memory only, never
       persisted (A2.5 — a reload is a fresh read of the log, so a stale fold could not even be
       trusted to still name the same text). The renderer owns the folded MARKUP: when `[data-hd-fold]`
       is already in a message node, that renderer is trusted and this module only flips the key and
       redraws THAT one message. Any other renderer (the built-in fallback, or a ChatRender that
       predates A2) gets the same affordance applied here, so folding can never be impossible merely
       because the renderer is old. Nothing here re-renders the list, and nothing is ever sent. */

    /** the text body of a message node (and the "show all" control that belongs to it): exactly the
        parts a fold hides. A server clamp note, the pending sentence and the message head all live
        OUTSIDE this box, so a fold cannot hide a disclosure (A2.6). */
    function foldParts(node) {
      var out = [];
      var els = node.querySelectorAll(FOLD_PARTS);
      for (var i = 0; i < els.length; i++) out.push(els[i]);
      return out;
    }
    /** true when the node's own renderer drew the A2 control (this module's shim is marked) */
    function rendererOwnsFold(node) {
      return !!(node.querySelector && node.querySelector('[data-hd-fold]:not([data-hd-fold-shim])'));
    }
    function nodeForKey(key) {
      var out = [], all = listEl.querySelectorAll('.hd-cv-msg, .chat-msg');
      for (var i = 0; i < all.length; i++) {
        if (all[i].getAttribute && all[i].getAttribute('data-key') === key) out.push(all[i]);
      }
      return out;
    }

    /** apply the folded (or unfolded) look to ONE message node, in place */
    function paintFold(node, key, folded, m) {
      if (node.classList) node.classList.toggle('hd-cv-folded', folded);
      var parts = foldParts(node);
      var prev = node.querySelector('[data-hd-foldprev]');
      if (folded) {
        /* the body is DETACHED, not merely display:none: a folded row must not still carry the
           reader's text as DOM text. The elements are kept (and put back verbatim on unfold), so
           the §8.3 line cap is restored exactly as it was rather than re-decided (A2.7). */
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
        var stash = null;
        if (parts.length) {
          stash = { parts: parts, parent: parts[0].parentNode, anchor: parts[parts.length - 1].nextSibling };
          for (var i = 0; i < parts.length; i++) {
            if (parts[i].parentNode) parts[i].parentNode.removeChild(parts[i]);
          }
          node.__hdFoldStash = stash;
        } else if (node.__hdFoldStash) {
          stash = node.__hdFoldStash;
        }
        if (m) {
          /* the boxes just removed (or the ones already stashed by an earlier fold) ARE what the
             reader was looking at, so the counts come from them — the A2 errata's rule 1 */
          var hide = parts.length ? parts : (node.__hdFoldStash ? node.__hdFoldStash.parts : []);
          var pv = foldPreview(hide, m);
          var box = el('div', 'hd-cv-foldprev hd-cv-note');
          box.setAttribute('data-hd-foldprev', key);
          box.textContent = (pv.line ? pv.line + ' · ' : '') + pv.note;
          var host = stash ? stash.parent : node;
          if (stash && stash.anchor && stash.anchor.parentNode === host) host.insertBefore(box, stash.anchor);
          else host.appendChild(box);
        }
      } else {
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
        var back = node.__hdFoldStash;
        node.__hdFoldStash = null;
        if (back && back.parts) {
          for (var j = 0; j < back.parts.length; j++) {
            var anchor = (back.anchor && back.anchor.parentNode === back.parent) ? back.anchor : null;
            back.parent.insertBefore(back.parts[j], anchor);
          }
        }
        var back2 = foldParts(node);
        for (var k = 0; k < back2.length; k++) back2[k].hidden = false;
      }
      var btns = node.querySelectorAll('[data-hd-fold]');
      for (var b = 0; b < btns.length; b++) {
        btns[b].setAttribute('aria-expanded', folded ? 'false' : 'true');
        if (btns[b].getAttribute('data-hd-fold-shim')) btns[b].textContent = folded ? 'unfold' : 'fold';
      }
      return true;
    }

    /** Is this node drawn folded RIGHT NOW, by the mark the drawing renderer itself writes?
        The renderer's folded form carries `.hd-cv-foldstat` (A2.3's counts) on its own bubble;
        the fallback renderer carries the class plus this module's shim preview. Asking the DOM
        instead of the map is what makes the repair below a real check rather than an assumption. */
    function renderedFolded(node) {
      if (!node || !node.querySelector) return false;
      if (node.querySelector('.hd-cv-foldstat') || node.querySelector('[data-hd-foldprev]')) return true;
      return !!(node.classList && node.classList.contains('hd-cv-folded'));
    }

    /** make sure one message node carries the fold affordance AND the state the pane's map says */
    function ensureFold(st, node) {
      var key = node && node.getAttribute ? node.getAttribute('data-key') : '';
      if (!key || !st) return false;
      var m = st.msgByKey ? st.msgByKey[key] : null;
      if (!m || !foldable(m)) return false;
      var folded = !!st.foldedKeys[key];
      if (rendererOwnsFold(node)) {
        /* A2.4: the renderer owns what a folded bubble looks like, so the repair is to ask it to
           draw this one message again with the pane's map — never to edit its markup by hand
           (its fold carries a preview and counts of its own that we would strip). */
        if (renderedFolded(node) !== folded) {
          var fresh = rerenderOne(st, node, m);
          if (fresh && node.parentNode) node.parentNode.replaceChild(fresh, node);
          if (renderedFolded(fresh || node) !== folded) {
            /* …and a renderer that emits the control but ignores foldedKeys is painted by hand, so
               the pane's state is never silently ignored (the pre-A2 shim path, kept honest) */
            paintFold(fresh || node, key, folded, m);
          }
        }
        return true;
      }
      if (!foldParts(node).length) return false;      // nothing to hide: no control is invented
      var head = node.querySelector('.hd-cv-meta') || node.querySelector('.chat-ts');
      if (head) {
        /* A2.4: the message head (the `who · time` row) is the second half of the control */
        if (!node.querySelector('[data-hd-foldhead]')) head.setAttribute('data-hd-foldhead', key);
        if (!head.querySelector('[data-hd-fold]')) {
          var btn = el('button', 'hd-cv-foldbtn', 'fold');
          btn.type = 'button';
          btn.setAttribute('data-hd-fold', key);
          btn.setAttribute('data-hd-fold-shim', '1');
          btn.title = 'fold this message to its first line (click again to unfold)';
          head.appendChild(btn);
        }
      } else {
        return false;
      }
      paintFold(node, key, folded, m);
      return true;
    }

    /** every message node a freshly rendered group put on screen, in one pass: A2's folds and A3's
        opens are both re-applied here, so a record that is redrawn (append, refresh, loadWhole,
        pane switch) comes back exactly as the reader left it */
    function syncReader(st, root) {
      if (!st || !root || !root.querySelectorAll) return;
      var nodes = root.querySelectorAll('.hd-cv-msg, .chat-msg');
      for (var i = 0; i < nodes.length; i++) { ensureFold(st, nodes[i]); syncOpen(st, nodes[i]); }
    }

    /** re-draw ONE message through the active renderer (its own folded form), keeping the classes
        this module and A1 put on the node so the redraw cannot lose "reply" or "interim" */
    function rerenderOne(st, node, m) {
      var frag = renderMessages([m], renderOpts(st));
      var fresh = frag && frag.firstChild;
      if (!fresh || fresh.nodeType !== 1) return null;
      /* A single message rendered on its own cannot know the classes the TURN renderer added to it
         ("hd-cv-reply" marks the answer, "hd-cv-interim" marks what is not one) — so they are copied
         over, whatever they are, instead of being re-decided here. */
      var had = String(node.className || '').split(/\s+/), now = ' ' + String(fresh.className || '') + ' ';
      for (var i = 0; i < had.length; i++) {
        if (had[i] && now.indexOf(' ' + had[i] + ' ') < 0) fresh.className += ' ' + had[i];
      }
      var dp = node.getAttribute('data-pending');
      if (dp) fresh.setAttribute('data-pending', dp);
      return fresh;
    }

    /* A2.8/A3.6: a fold or an open changes the height of ONE row, so the reader must not be moved
       by it. Anchoring on the distance from the BOTTOM is this module's own idiom (loadOlder):
       everything below the changed row stays exactly where it was, and a reader pinned to the tail
       stays pinned — which is the reader who is watching an agent work. A reader at the very TOP is
       the one case the bottom anchor gets wrong: there is nothing above them to hold still, so it
       would scroll the row they just clicked out of sight — there the top edge is the anchor. */
    function withStableScroll(work) {
      var atTop = scrollEl.scrollTop <= 1;
      var keep = scrollEl.scrollHeight - scrollEl.scrollTop;
      var out = work();
      scrollEl.scrollTop = atTop ? 0 : Math.max(0, scrollEl.scrollHeight - keep);
      follow = (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) <= stickPx();
      updateJump();
      return out;
    }

    /** the reader's fold toggle: one key, one message's row, and the scroll exactly where it was */
    function toggleFold(key) {
      var id = currentPaneId();
      if (!id || !key) return false;
      var st = paneState(id);
      if (st.foldedKeys[key]) delete st.foldedKeys[key];
      else st.foldedKeys[key] = true;
      var folded = !!st.foldedKeys[key];
      var m = st.msgByKey ? st.msgByKey[key] : null;
      return withStableScroll(function () {
        var nodes = nodeForKey(key);
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          var fresh = (rendererOwnsFold(node) && m) ? rerenderOne(st, node, m) : null;
          if (fresh && node.parentNode) {
            node.parentNode.replaceChild(fresh, node);
            node = fresh;
          }
          ensureFold(st, node);
        }
        return folded;
      });
    }

    /* ── A3 (§8.3 amendment 3): the reader's opens (thinking, tool cards, show-all) ──────────────
       W3's renderer draws these blocks from `opts.openKeys` and attaches no listener: it writes the
       id on the control (`data-hd-open`), the state in `aria-expanded` and `hd-cv-open` on the body.
       This half is the state and the one delegated gesture. Nothing here re-renders the list, nothing
       is sent to a pane, and the state lives in the per-pane map, so the newest turn can be redrawn
       under the reader's finger without collapsing what they just opened (the round-7.5 defect). */

    /** A3.3: the block a control opens, found by the control's own kind — the renderer's vocabulary
        is the only thing that knows where a body lives. Null when this kind has none. */
    function bodyForControl(ctrl) {
      var cls = String((ctrl && ctrl.className) || '');
      if (!ctrl) return null;
      if (cls.indexOf('hd-cv-think-head') >= 0) {
        var t = ctrl.closest ? ctrl.closest('.hd-cv-think') : null;
        return t ? t.querySelector('.hd-cv-think-body') : null;
      }
      if (cls.indexOf('hd-cv-toggle') >= 0) {
        var c = ctrl.closest ? ctrl.closest('.hd-cv-card') : null;
        return c ? c.querySelector('.hd-cv-card-body') : null;
      }
      /* the `show all` control is appended by the renderer right after the box it belongs to */
      var sib = ctrl.previousElementSibling;
      if (sib && sib.classList
          && (sib.classList.contains('hd-cv-body') || sib.classList.contains('hd-cv-resbox'))) return sib;
      return ctrl.parentNode ? ctrl.parentNode.querySelector('.hd-cv-body, .hd-cv-resbox') : null;
    }

    /** the most this module can do by hand for a renderer that emits A3 controls but ignores
        `openKeys`: the marks go back on the control and the body it names. The CONTENT stays the
        renderer's to draw — a clamp's box holds the capped lines when it was drawn closed, and
        nothing here can recover text the renderer never rendered. That limit is exactly why the map,
        not this paint, is the state, and why syncOpen tries a redraw through the renderer first. */
    function paintOpen(node, id, open) {
      var ctrls = node.querySelectorAll('[data-hd-open]'), hit = null;
      for (var i = 0; i < ctrls.length; i++) {
        if (ctrls[i].getAttribute('data-hd-open') === id) { hit = ctrls[i]; break; }
      }
      if (!hit) return false;
      var cls = String(hit.className || '');
      hit.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (cls.indexOf('hd-cv-more') >= 0) hit.textContent = (open ? 'show less' : 'show all') + ' · ' + (hit.getAttribute('data-lines') || '?') + ' lines';
      else if (cls.indexOf('hd-cv-toggle') >= 0) hit.textContent = open ? 'collapse' : 'expand';
      var body = bodyForControl(hit);
      if (body) {
        body.hidden = !open;
        if (body.classList) body.classList.toggle('hd-cv-open', open);
      }
      return true;
    }

    /** A3.4: what a redrawn node shows must be the reader's state. The renderer writes it from the
        map, so the ordinary case costs one DOM read per control — but the DOM is ASKED rather than
        assumed (the same rule as `renderedFolded`), so a renderer that draws the controls and
        ignores `openKeys` gets one redraw through the renderer and, if it still disagrees, the
        hand-paint above, instead of silently swallowing the reader's click. */
    function syncOpen(st, root) {
      if (!st || !root || !root.querySelectorAll) return;
      var ctrls = root.querySelectorAll('[data-hd-open]');
      for (var i = 0; i < ctrls.length; i++) {
        var id = ctrls[i].getAttribute('data-hd-open');
        /* no entry = the reader has not spoken, so the renderer's own default stands and this has
           nothing to enforce (A3.1: only an entry, true or false, is the reader's decision) */
        if (!id || !Object.prototype.hasOwnProperty.call(st.openKeys, id)) continue;
        var want = !!st.openKeys[id];
        if ((ctrls[i].getAttribute('aria-expanded') === 'true') === want) continue;
        var node = ctrls[i].closest ? ctrls[i].closest('.hd-cv-msg, .chat-msg') : null;
        var m = (node && st.msgByKey) ? st.msgByKey[node.getAttribute('data-key')] : null;
        if (node && m) {
          var fresh = rerenderOne(st, node, m);
          if (fresh && node.parentNode) { node.parentNode.replaceChild(fresh, node); node = fresh; }
        }
        if (node) paintOpen(node, id, want);
      }
    }

    /** the reader's open toggle: one id, the one message node that carries it, and the scroll
        exactly where it was. The state the click flips is the state the reader can SEE (the
        control's own `aria-expanded`), not an assumption about the default — so a block that starts
        open for any reason closes on the first click, and the two-valued entry written here is
        A3.1's "the reader has spoken" either way. */
    function toggleOpen(id, control) {
      var paneId = currentPaneId();
      if (!paneId || !id) return false;
      var st = paneState(paneId);
      var wasOpen = !!(control && control.getAttribute && control.getAttribute('aria-expanded') === 'true');
      var open = !wasOpen;
      st.openKeys[id] = open;
      var node = (control && control.closest) ? control.closest('.hd-cv-msg, .chat-msg') : null;
      return withStableScroll(function () {
        var m = (node && st.msgByKey) ? st.msgByKey[node.getAttribute('data-key')] : null;
        if (node && m) {
          var fresh = rerenderOne(st, node, m);       // the renderer draws its own block from the map
          if (fresh && node.parentNode) { node.parentNode.replaceChild(fresh, node); node = fresh; }
        }
        if (node) {
          syncOpen(st, node);      // repair, for a renderer that does not read the map
          ensureFold(st, node);    // A2 hinges on this node as well: keep its folded look
        }
        return open;
      });
    }

    /* one delegated listener on the list — never one per message (A3.3). `data-hd-fold` and
       `data-hd-open` are handled in the same place; the innermost control wins, so a control inside
       a fold head still reaches its own toggle. */
    function onListClick(e) {
      try {
        if (unmounted) return;
        var t = e.target;
        if (!t || !t.closest) return;
        /* §13.1.4: the copy button is the LAST child of the fold head row (§13.1.1), so a click on it
           would otherwise fold the very block the reader asked to copy. lib/copy.js handles the click
           itself — its listener is on the mount host in the CAPTURE phase and stops the event — but a
           reader's click must not depend on another file having loaded, so the fold delegation
           refuses these clicks on its own too. */
        var copyCtl = t.closest('[data-hd-copy]');
        if (copyCtl && listEl.contains(copyCtl)) return;
        /* A2.8/A3.6: the toggle must not reach a pane, a global key handler or the raw view. It is a
           mouse gesture, so it also must not look like one the page owns: stop it here. */
        var openCtl = t.closest('[data-hd-open]');
        var holder = null;
        if (openCtl && listEl.contains(openCtl)) holder = openCtl;
        else {
          var foldCtl = t.closest('[data-hd-fold]') || t.closest('[data-hd-foldhead]');
          if (foldCtl && listEl.contains(foldCtl)) holder = foldCtl;
        }
        if (!holder) return;
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        if (holder === openCtl) {
          var oid = holder.getAttribute('data-hd-open');
          if (oid) toggleOpen(oid, holder);
          return;
        }
        var key = holder.getAttribute('data-hd-fold') || holder.getAttribute('data-hd-foldhead');
        if (key) toggleFold(key);
      } catch (err) { /* a reader action must never break the view */ }
    }
    /** A1 rule 4: the running turn's "working · Ns" label ticks once a second, in place (the group
        is NOT redrawn every second: that would fight the reader's scroll position and their open
        tool cards). Only the elapsed label is replaced, with ChatRender's own working-tail node. */
    function updateWorking(st) {
      if (!st || st.id !== currentPaneId()) return false;
      var id = st.id;
      var workingNow = (st.rendered.length > 0) && st.rendered[st.rendered.length - 1].to >= st.messages.length &&
        isWorking(id);
      if (!workingNow) {
        if (st.workingNode) { st.workingNode = null; st.workingSince = 0; renderNew(st, true); }
        return false;
      }
      if (!st.workingNode) { renderNew(st, true); return true; }
      /* the elapsed label measures the TURN, so it counts from the turn's own first record (the
         prompt the user sent) — never from "now", or every tick would restart it at 0s */
      var elapsed = st.workingSince ? Math.max(0, Date.now() - st.workingSince) : null;
      var fresh = null;
      var R = renderer();
      if (R && typeof R.renderWorkingTail === 'function') {
        try { fresh = R.renderWorkingTail(elapsed === null ? undefined : elapsed); } catch (e) { fresh = null; }
      }
      if (!fresh || fresh.nodeType !== 1) {
        fresh = el('div', 'hd-cv-working chat-working');
        fresh.appendChild(el('span', 'hd-cv-working-text chat-working-text',
          elapsed === null ? 'working' : 'working · ' + Math.floor(elapsed / 1000) + 's'));
      }
      var old = st.workingNode.querySelector ? st.workingNode.querySelector('.hd-cv-working, .chat-working') : null;
      if (!old || !old.parentNode) {                     // the renderer drew it elsewhere: redraw the turn
        st.workingNode = null;
        renderNew(st, true);
        return true;
      }
      old.parentNode.replaceChild(fresh, old);
      return true;
    }

    /** A1 rule 4 + DEFECT-12: keep the open turn's live-ness in step with the pane's agent_status.
        Called after every render and once a second by the working timer: when the pane stops
        working the group is redrawn ONCE (its last text becomes the reply, the tail goes away);
        while it works the elapsed label is ticked in place. Never throws outward. */
    function refreshWorking(st) {
      try {
        if (!st || st.id !== currentPaneId() || mode !== 'chat' || unmounted) return false;
        return updateWorking(st);
      } catch (e) { return false; }
    }

    function renderStatus(st) {
      var id = currentPaneId();
      var bits = ['chat'];
      if (id) bits.push(id);
      if (st && st.agent) bits.push(text(st.agent));
      if (st && st.source && st.source.kind) bits.push(text(st.source.kind));
      if (st) {
        bits.push(st.messages.length + ' message' + (st.messages.length === 1 ? '' : 's'));
        if (st.expanded && st.messages.length > RENDER_MAX) bits.push('showing the last ' + EXPAND_MAX);
        else if (st.messages.length > RENDER_MAX) bits.push('showing the last ' + RENDER_MAX);
        if (st.gotCursor) bits.push('cursor ' + text(st.cursor));
        if (st.truncated) bits.push('server byte cap hit (truncated)');
        /* §8.2 tail mode: say where the first paint came from, so a server that lacks it is visible */
        if (st.tailChecked) bits.push(st.tailMode === true ? 'tail mode (opened at the end of the log)'
          : 'tail mode not available — caught up from the start');
        if (st.stalls > 0) bits.push(st.stalls + ' request' + (st.stalls === 1 ? '' : 's') + ' stalled');
      }
      if (!auto) bits.push('test mode (no polling)');
      if (rendererName() !== 'ChatRender') bits.push('renderer: built-in fallback (lib/chat-render.js is not loaded)');
      stInfo.textContent = bits.join(' · ');
      var warn = [];
      if (st && st.unknown > 0) warn.push(st.unknown + ' records of an unknown type (this log format may have changed)');
      if (st && st.skipped > 0) warn.push(st.skipped + ' records skipped (attachments, mode changes, file-history …)');
      /* DEFECT-10: records that carry no text are hidden, but never silently — the count is stated */
      var hiddenEmpties = st ? Math.max(st.empties, st.emptiesServer || 0) : 0;
      if (hiddenEmpties > 0) warn.push(hiddenEmpties + ' empty record' + (hiddenEmpties === 1 ? '' : 's') + ' (no text) hidden');
      /* DEFECT-12: the honest sentence about the request that never came back */
      if (st && st.stall) {
        warn.push(STALL_NOTE.replace('%s', (Math.max(1, Math.round(st.stall.ms / 1000)) + 's')));
      }
      stWarn.textContent = warn.join(' · ');
      stWarn.classList.toggle('chat-warn-on', warn.length > 0);
      olderBtn.classList.toggle('hidden', !(id && st && st.messages.length > RENDER_MAX));
      /* DEFECT-18(2): while a read is known to have timed out, the reader gets a control that asks
         again — the panel is never left saying "there is nothing to press and nothing is coming" */
      retryBtn.classList.toggle('hidden', !(st && st.stall));
      olderEl.textContent = st && st.loadingOlder ? 'loading older records …' : (st ? text(st.olderNote) : '');
      olderEl.classList.toggle('hidden', !olderEl.textContent);
    }

    function renderState(st) {
      var id = currentPaneId();
      var msg = '';
      if (!id) msg = 'select a pane in the sidebar to read its conversation.';
      /* DEFECT-18(2): a timed-out read is not "reading …" any more and it is not an error either —
         say which timeout it was and point at the retry. This is the line the reader is looking at. */
      else if (st && st.stall) msg = STALL_STATE;
      else if (st && st.error) msg = errorText(st.error);
      else if (st && !st.lastFetchAt) msg = 'reading the structured session of ' + id + ' …';
      else if (st && (st.empty || !st.messages.length)) msg = EMPTY_NOTE;
      stateEl.textContent = msg;
      stateEl.classList.toggle('hidden', !msg);
      return msg;
    }

    function scrollToBottom() {
      follow = true;
      newCount = 0;
      scrollEl.scrollTop = scrollEl.scrollHeight;
      updateJump();
    }
    function updateJump() {
      /* The chip is the way BACK to the tail, so it lives for as long as the view is unpinned —
         the same deal as the raw transcript's always-present "jump to latest ↓". With nothing new
         to count it just says what it does; with new records queued it says how many. */
      jumpBtn.textContent = (newCount > 0) ? (newCount + ' new ↓') : 'jump to latest ↓';
      jumpBtn.classList.toggle('hidden', follow && newCount === 0);
    }
    function onScroll() {
      var dist = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
      follow = dist <= stickPx();
      if (follow) newCount = 0;
      updateJump();                     // pinned -> hidden; unpinned -> "N new ↓" / "jump to latest ↓"
    }

    function renderAll() {
      var id = currentPaneId();
      var st = id ? paneState(id) : null;
      clearMessages(st);
      if (st) {
        st.expanded = st.expanded || false;
        st.workingNode = null;
        st.openBig = null;
        st.reclose = null;
        st.renderedTo = floorOf(st);
        renderNew(st, true);                       // the last floorOf(st) messages as turn groups
      }
      renderPendings(st);
      renderState(st);
      renderStatus(st);
      if (follow) scrollToBottom(); else updateJump();
      decoratePaths();                             // §13.2.1: the whole list, after a full render
    }

    /* ---------------- the mode (chat ↔ raw) ---------------- */

    function applyMode() {
      var chat = (mode === 'chat');
      host.classList.toggle('hidden', !chat);
      var pre = document.getElementById('transcript');
      if (pre) pre.classList.toggle('hidden', chat);
      var jump = document.getElementById('jumpLatest');
      if (jump && chat) jump.classList.add('hidden');       // app.js's raw-transcript jump button
      if (chip) {
        chip.textContent = 'view: ' + mode;
        chip.classList.toggle('mode-chat', chat);
        chip.classList.toggle('mode-raw', !chat);
        chip.setAttribute('title', chat
          ? 'chat view (structured record from /api/chat) — click or press t for the raw terminal'
          : 'raw terminal transcript — click or press t for the chat view');
      }
      syncTimers();
      if (chat) { renderAll(); poll(); }
    }
    function setMode(m) {
      mode = (m === 'raw') ? 'raw' : 'chat';
      lsSet(LS_VIEW, mode);
      applyMode();
      return mode;
    }
    function toggle() { return setMode(mode === 'chat' ? 'raw' : 'chat'); }

    /* ---------------- "load older" ---------------- */

    /* "load older · 800" asks for the LAST 800 records (tail=1&limit=800 — the same §8.2 tail mode
       the first load uses) and renders EXPAND_MAX of them: one request, no walk, and the view stays
       anchored to the point the reader was looking at instead of jumping to the top of the log.
       Without tail mode the server answers the same request with a head page; that is detectable
       (the body has no tail flag) and the honest note says so rather than pretending. */
    function loadOlder() {
      var id = currentPaneId();
      if (!id) return false;
      var st = paneState(id);
      if (st.loadingOlder) return false;
      st.loadingOlder = true;
      st.olderNote = 'loading older records …';
      renderStatus(st);
      var keep = scrollEl.scrollHeight - scrollEl.scrollTop;
      query(id, null, OLDER_LIMIT, { tail: true }).then(function (body) {
        st.loadingOlder = false;
        if (body && body.ok === true) {
          st.messages = [];
          st.keys = {};
          st.rendered = [];
          st.renderedTo = 0;
          st.empties = 0;
          st.emptiesServer = 0;
          st.expanded = true;
          st.tailChecked = true;
          if (body.tail === true || body.tail === 1) st.tailMode = true;
          for (var i = 0; i < st.pending.length; i++) st.pending[i].since = 0;   // re-scan the whole list
        }
        ingest(id, body);
        if (body && body.ok === true) {
          st.olderNote = (st.tailMode === true)
            ? 'showing the last ' + EXPAND_MAX + ' of ' + st.messages.length + ' records in memory'
            : 'this server has no tail mode — the view holds what it could catch up to';
        } else {
          st.olderNote = '';
        }
        scrollEl.scrollTop = Math.max(0, scrollEl.scrollHeight - keep);
        follow = (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) <= stickPx();
        renderStatus(st);
      });
      return true;
    }

    /* ---------------- timers ---------------- */

    /* DEFECT-18(2): the retry the timeout note offers. Deliberately bypasses the DEFECT-18(1) dedup
       (that guard exists to drop a TWIN, and a human pressing a button is not a twin) and releases
       anything still latched with `pane-switch` so that a second press cannot count a second stall.
       The stall note itself is NOT cleared here: only a body arriving clears it, so a retry that
       stalls again keeps showing the truth instead of looking like a recovery. */
    function retryNow() {
      clearReqTimer();
      if (inflight) abandonInflight('pane-switch');
      lastAsk = null;
      poll();
      return true;
    }

    function syncTimers() {
      var want = auto && !unmounted && (mode === 'chat') && !!currentPaneId();
      if (want && !pollTimer) pollTimer = window.setInterval(poll, POLL_MS);
      if (!want && pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
      var wantPending = want && hasUnresolvedPending();
      if (wantPending && !pendingTimer) {
        pendingTimer = window.setInterval(function () { pendingTick(Date.now()); }, PENDING_TICK_MS);
      }
      if (!wantPending && pendingTimer) { window.clearInterval(pendingTimer); pendingTimer = null; }
      /* A1 rule 4: "working · Ns" has to move, so one timer exists exactly while the visible pane's
         agent_status says working — and not a moment longer */
      var wantWorking = want && !!currentPaneId() && isWorking(currentPaneId());
      if (wantWorking && !workingTimer) {
        workingTimer = window.setInterval(function () {
          var id = currentPaneId();
          if (id) refreshWorking(paneState(id));
        }, WORKING_TICK_MS);
      }
      if (!wantWorking && workingTimer) { window.clearInterval(workingTimer); workingTimer = null; }
    }

    var onKey = function (e) {
      try {
        if (unmounted) return;
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key !== 't' && e.key !== 'T') return;
        var t = e.target || {};
        var tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
        if (overlayOpen()) return;               // an overlay owns the keyboard while it is up
        e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        var m = toggle();
        if (ctx.ui && ctx.ui.setHint) {
          ctx.ui.setHint(m === 'chat' ? 'view: chat (t for the raw terminal)' : 'view: raw terminal (t for the chat view)');
        }
      } catch (err) { /* a shortcut must never break the page */ }
    };

    /* chat is a view, not an overlay — but `t` must not fire while a real overlay is up */
    function overlayOpen() {
      try {
        var k = ctx.modules && ctx.modules.api ? ctx.modules.api('keys') : null;
        if (k && typeof k.overlayOpen === 'function') return !!k.overlayOpen();
      } catch (e) { /* fall through to the local check */ }
      var sel = '#hdPalette, #hdHelp, #hdSearch, #hdFanout, .hd-board, .hd-inbox, .hd-grid, [data-hd-overlay]';
      var els = document.querySelectorAll(sel);
      for (var i = 0; i < els.length; i++) {
        var n = els[i];
        if (n.hidden) continue;
        if (n.classList && n.classList.contains('hidden')) continue;
        var cs = window.getComputedStyle ? window.getComputedStyle(n) : null;
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
        var r = n.getBoundingClientRect ? n.getBoundingClientRect() : null;
        if (r && (r.width <= 0 || r.height <= 0)) continue;
        return true;
      }
      return false;
    }

    function injectFallbackCss() {
      if (document.getElementById('hdChatFallbackCss')) return;
      var s = document.createElement('style');
      s.id = 'hdChatFallbackCss';
      /* every rule is inside :where() (zero specificity), so chatview.css — or any other sheet —
         overrides every one of them; this only keeps the view usable when no chat CSS is loaded */
      s.textContent = [
        ':where(#chatHost.chat-host){position:relative;display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden;}',
        ':where(#hdChatStatus.chat-status){display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 10px;border-bottom:1px solid #1e2632;color:#8b97a6;font-size:11.5px;}',
        ':where(#hdChatStatus .chat-warn-on){color:#e0a02a;}',
        ':where(.chat-btn){background:#1a2029;color:#d6dee8;border:1px solid #263040;border-radius:4px;padding:1px 8px;cursor:pointer;font-size:11px;}',
        ':where(#hdChatScroll.chat-scroll){flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:8px 12px;display:flex;flex-direction:column;}',
        ':where(#hdChatList.chat-list){display:flex;flex-direction:column;gap:8px;min-width:0;}',
        ':where(.chat-state){padding:8px 10px;border-radius:6px;background:#141a22;border:1px solid #263040;color:#d6dee8;}',
        ':where(.chat-older){font-size:11.5px;color:#8b97a6;}',
        ':where(.chat-msg){display:flex;flex-direction:column;gap:2px;align-items:flex-start;max-width:100%;}',
        ':where(.chat-msg.role-user){align-items:flex-end;}',
        ':where(.chat-msg .chat-bubble){padding:6px 10px;border-radius:8px;background:#16202c;border:1px solid #263040;white-space:pre-wrap;overflow-wrap:anywhere;max-width:78%;}',
        ':where(.chat-msg.role-user .chat-bubble){background:#12304d;border-color:#1d4b78;}',
        ':where(.chat-ts){font-size:10.5px;color:#8b97a6;}',
        ':where(.chat-note){color:#8b97a6;}',
        /* .chat-pending is THIS module's state class, so this one rule is deliberately not inside
           :where(): chatview.css sets `border: 1px solid ...` on .hd-cv-bubble, and a zero-
           specificity rule can never turn that into a dashed border. */
        '#hdChatList .chat-pending .hd-cv-bubble,#hdChatList .chat-pending .chat-bubble{border-style:dashed;font-style:italic;}',
        ':where(.chat-pending-note){font-size:11px;color:#e0a02a;}',
        ':where(.chat-tool){border:1px solid #263040;border-radius:6px;background:#111823;padding:6px 8px;font-family:var(--mono,monospace);font-size:11.5px;max-width:100%;}',
        ':where(.chat-tool pre){margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;}',
        ':where(.chat-err){color:#ffb4b4;border-color:#5c2326;}',
        ':where(.chat-thinking){color:#8b97a6;font-size:11.5px;max-width:100%;}',
        ':where(#hdChatJump.chat-jump){align-self:center;position:sticky;bottom:10px;background:#4aa3ff;color:#06101c;border:0;padding:3px 12px;border-radius:14px;cursor:pointer;font-size:11.5px;font-weight:600;}',
        ':where(#hViewMode.mode-chip){background:#1a2029;color:#d6dee8;border:1px solid #263040;border-radius:10px;padding:1px 8px;cursor:pointer;font-size:11px;font-family:var(--mono,monospace);}',
        ':where(#hViewMode.mode-chat){border-color:#4aa3ff;color:#cfe4ff;}'
      ].join('\n');
      (document.head || document.documentElement).appendChild(s);
    }

    /* ---------------- wiring ---------------- */

    scrollEl.addEventListener('scroll', onScroll);
    listEl.addEventListener('click', onListClick);
    jumpBtn.addEventListener('click', function () { scrollToBottom(); });
    olderBtn.addEventListener('click', function () { loadOlder(); });
    retryBtn.addEventListener('click', function () { retryNow(); });
    rawBtn.addEventListener('click', function () { setMode('raw'); });
    if (chip) chip.addEventListener('click', function () { toggle(); });
    document.addEventListener('keydown', onKey);

    try {
      offSelect = ctx.events.on('select', function () {
        follow = true;
        newCount = 0;
        applyMode();
        poll();
      });
    } catch (e) { offSelect = null; }

    /* A1 rule 4: the working tail follows the pane's agent_status, so a pane that stops working
       closes its turn at once instead of waiting for the next poll (and vice versa) */
    try {
      offStatus = ctx.events.on('status', function (p) {
        var id = currentPaneId();
        if (id && p && (p.pane_id === id || p.paneId === id)) refreshWorking(paneState(id));
        syncTimers();
      });
    } catch (e) { offStatus = null; }

    /* §3: every shortcut we add must appear in the `?` help overlay */
    try {
      ctx.events.emit('keys.register', {
        id: ID,
        help: 'structured conversation view (prompts + agent replies as a chat)',
        keys: [
          { key: 't', help: 'toggle the chat view ↔ the raw terminal transcript (both stay available)' }
        ]
      });
    } catch (e) { /* the overlay is optional */ }

    /* ── §13: the two behaviour modules of round 9 ──────────────────────────────────────────────
       §13.1.3: lib/copy.js owns the copy behaviour and is DELEGATED from here — this view draws the
       buttons (W3's renderer, §13.1.1) and the module turns their clicks into a clipboard write and a
       status in the composer's result line. It is mounted on the chat host, which is the subtree the
       buttons live in, so one capture-phase listener covers every button of every render.
       §13.2.1: lib/pathlink.js is mounted on its own declared host (#hdPathHost, index.html) and is
       handed the freshly drawn messages after every render (decoratePaths below). Both mounts are
       best-effort on purpose: a page without either file keeps its conversations and its text. */
    var copyApi = window.HD && window.HD.copy;
    if (copyApi && typeof copyApi.mount === 'function') {
      try { copyApi.mount(host); } catch (e) { /* §13.1.3: a broken copy module never breaks the view */ }
    }
    var pathApi = window.HD && window.HD.pathlink;
    if (pathApi && typeof pathApi.mount === 'function') {
      try { pathApi.mount(document.getElementById('hdPathHost') || host); }
      catch (e) { /* §13.2.8: no link module, every path stays the text the agent wrote */ }
    }

    mounted = true;
    applyMode();
    if (mode === 'raw') renderAll();

    return {
      show: function () { return setMode('chat'); },
      hide: function () { return setMode('raw'); },
      toggle: toggle,
      mounted: function () { return mounted && !unmounted; },
      viewMode: function () { return mode; },
      state: state,
      notePending: notePending,            // app.js integration hook (successful prompt send)
      /* §10: the composer's attachments. app.js owns the input paths (picker / drop / paste) and the
         send button; the chat view owns the chips, the uploads and the §10.4 block, so the outgoing
         text can only be built in one place. Every method is safe to call before any pane exists. */
      attachments: function () { return attach.summary(); },
      attachFiles: function (files, paneId, opts) {
        return attach.accept(files, paneId || currentPaneId(), opts);
      },
      composeSend: function (paneId, typedText) {
        return attach.composeSend(paneId || currentPaneId(), typedText);
      },
      clearAttachments: function () { return attach.clear(); },
      removeAttachment: function (id) { return attach.remove(id); },
      loadOlder: loadOlder,
      loadWhole: loadOlder,                // kept: the round-7 name, same request (§8.2 tail mode)
      refresh: function () { poll(); },
      unmount: function () {
        unmounted = true;
        if (liveHost === host) liveHost = null;
        /* §13: the two behaviour modules go with the view they were mounted into — the copy listener
           is removed from the host and the link module stops observing it */
        try { if (copyApi && copyApi.unmount) copyApi.unmount(); } catch (e) { /* gone */ }
        try { if (pathApi && pathApi.unmount) pathApi.unmount(); } catch (e) { /* gone */ }
        document.removeEventListener('keydown', onKey);
        scrollEl.removeEventListener('scroll', onScroll);
        listEl.removeEventListener('click', onListClick);
        clearReqTimer();                             // DEFECT-18(2): no timer outlives the mount
        if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
        if (pendingTimer) { window.clearInterval(pendingTimer); pendingTimer = null; }
        if (workingTimer) { window.clearInterval(workingTimer); workingTimer = null; }
        if (offSelect) { try { offSelect(); } catch (e) { /* ignore */ } }
        if (offStatus) { try { offStatus(); } catch (e) { /* ignore */ } }
        if (host.parentNode) host.parentNode.removeChild(host);
      },
      /* test seams — used by window.HD.chatviewTest and the ?selftest=1 chat cases only */
      __ingest: ingest,
      __ingestTail: function (id, body) { return ingest(id, body, { tail: true }); },
      /* A2: the pane's fold map as the module itself holds it (never the DOM's opinion of it) */
      __foldKeys: function (id) {
        var st = paneState(id || currentPaneId());
        var out = [];
        for (var k in st.foldedKeys) if (Object.prototype.hasOwnProperty.call(st.foldedKeys, k)) out.push(k);
        return out;
      },
      /* A3: the pane's open map, with the reader's own value — `false` is a decision, not an
         absence (A3.1), so this returns id -> true/false rather than a list of names */
      __openKeys: function (id) {
        var st = paneState(id || currentPaneId());
        var out = {};
        for (var k in st.openKeys) if (Object.prototype.hasOwnProperty.call(st.openKeys, k)) out[k] = !!st.openKeys[k];
        return out;
      },
      __messages: function (id) { return paneState(id || currentPaneId()).messages.slice(); },
      __tick: function (nowMs) { return pendingTick(typeof nowMs === 'number' ? nowMs : Date.now()); },
      /* DEFECT-12 seams: the latch is an object with a clock, so a test can age it and watch the
         timeout path run for real (no fetch is stubbed anywhere in this module) */
      __inflight: function () { return inflight ? { id: inflight.id, ageMs: Date.now() - inflight.startedAt } : null; },
      __ageInflight: function (ms) { if (inflight) inflight.startedAt = Date.now() - Math.max(0, Number(ms) || 0); return !!inflight; },
      __abandon: function (why) { return abandonInflight(why || 'test'); },
      __working: function (id) { return refreshWorking(paneState(id || currentPaneId())); },
      __panes: function () {
        var out = [];
        for (var k in panes) {
          if (!Object.prototype.hasOwnProperty.call(panes, k)) continue;
          var s = panes[k];
          out.push({ id: s.id, messages: s.messages.length, cursor: s.cursor, gotCursor: s.gotCursor,
                     fetches: s.fetches, errors: s.errors, stalls: s.stalls,
                     stall: s.stall ? { why: s.stall.why, ms: s.stall.ms } : null,
                     tailChecked: !!s.tailChecked, tailMode: s.tailMode, verifyTail: !!s.verifyTail,
                     turns: s.rendered.length, pending: s.pending.length, lastQuery: s.lastQuery });
        }
        return out;
      },
      __latch: latchDecision,
      /* LIVE, not snapshotted: __setReqTimeoutMs changes the module's own value, so a caller that
         reads this back must see what the timer will really use (a captured number read 12000 while
         the timer was armed for 400 — measured 2026-09-25). */
      __reqTimeoutMs: function () { return reqTimeoutMs; },
      /* DEFECT-18(2) seams: the timeout the module will actually use (a check can shorten it so the
         real timer fires inside a test), the reader's retry, and whether a timer is armed */
      __setReqTimeoutMs: function (ms) {
        var n = Number(ms);
        reqTimeoutMs = (isFinite(n) && n > 0) ? n : REQ_TIMEOUT_MS;
        return reqTimeoutMs;
      },
      __retry: function () { return retryNow(); },
      __reqTimerArmed: function () { return !!reqTimer; },
      /* DEFECT-18(1): the signature of the last read issued — a check asserts that the twin of a
         mount/select pair never reaches the wire by reading this beside the fetch log */
      __lastAsk: function () { return lastAsk ? { id: lastAsk.id, since: lastAsk.since, tail: lastAsk.tail } : null; },
      __dedupMs: REQ_DEDUP_MS,
      /* §10 seams: the same functions the composer calls, so a check drives the shipped path */
      __attach: function () { return attach.summary(); },
      __attachFiles: function (files, paneId, opts) { return attach.accept(files, paneId, opts); },
      __attachRemove: function (id) { return attach.remove(id); },
      __attachClear: function () { return attach.clear(); },
      __composeSend: function (paneId, typed) { return attach.composeSend(paneId, typed); },
      __attachMax: ATTACH_MAX,
      __attachBlockHead: ATTACH_BLOCK_HEAD,
      __setStatus: function (id, status) {
        statusOverride = (id && status) ? { id: id, status: String(status).toLowerCase() } : null;
        var cur = currentPaneId();
        if (cur) { refreshWorking(paneState(cur)); syncTimers(); renderStatus(paneState(cur)); }
        return statusOverride;
      },
      __turns: function (id) {
        var st = paneState(id || currentPaneId());
        return st.rendered.map(function (g) { return { from: g.from, to: g.to,
          turn: (g.node && g.node.getAttribute) ? g.node.getAttribute('data-turn') : null,
          working: !!(g.node && g.node.getAttribute && g.node.getAttribute('data-working')) }; });
      },
      __setPaneOverride: function (id) {
        paneOverride = id || null;
        renderAll();                       // no fetch: tests feed bodies through __ingest
        return true;
      },
      __setAuto: function (on) {
        auto = !!on;
        if (!auto && pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
        if (!auto && pendingTimer) { window.clearInterval(pendingTimer); pendingTimer = null; }
        if (!auto && workingTimer) { window.clearInterval(workingTimer); workingTimer = null; }
        syncTimers();
        renderStatus(currentPaneId() ? paneState(currentPaneId()) : null);
        return auto;
      },
      __dom: function () {
        return { host: host, status: statusEl, scroll: scrollEl, list: listEl, state: stateEl,
                 older: olderEl, jump: jumpBtn, chip: chip, olderBtn: olderBtn, rawBtn: rawBtn };
      }
    };

    /* what the DOM group list actually covers — the answer to "is the panel blank?" that does not
       count nodes (one group is many nodes, and one message may be folded into another's card) */
    function domFirstOf(st) { return st.rendered.length ? st.rendered[0].from : -1; }
    function domLastOf(st) { return st.rendered.length ? st.rendered[st.rendered.length - 1].to : -1; }

    function state() {
      var id = currentPaneId();
      var st = id ? paneState(id) : null;
      return {
        id: ID, mode: mode, visible: (mode === 'chat') && !unmounted, paneId: id, auto: auto,
        renderer: rendererName(), pollMs: POLL_MS, polling: !!pollTimer, pendingTimer: !!pendingTimer,
        workingTimer: !!workingTimer,
        agent: st ? st.agent : null, source: st ? st.source : null, cursor: st ? st.cursor : null,
        messages: st ? st.messages.length : 0,
        rendered: st ? domLastOf(st) - domFirstOf(st) : 0,
        turns: st ? st.rendered.length : 0,
        domFirst: st ? domFirstOf(st) : -1, domNext: st ? domLastOf(st) : -1,
        domTurns: st ? st.rendered.map(function (c) { return [c.from, c.to]; }) : [],
        domNodes: listEl ? messageNodes().length : 0, renderMax: RENDER_MAX, expanded: st ? !!st.expanded : false,
        unknown_records: st ? st.unknown : 0, skipped: st ? st.skipped : 0,
        truncated: st ? !!st.truncated : false,
        /* §8.2 tail mode + DEFECT-10/12 bookkeeping the probes assert on */
        tailChecked: st ? !!st.tailChecked : false, tailMode: st ? st.tailMode : null,
        empties: st ? Math.max(st.empties, st.emptiesServer || 0) : 0, stalls: st ? st.stalls : 0,
        stall: st ? (st.stall ? { why: st.stall.why, ms: st.stall.ms } : null) : null,
        working: !!(st && st.workingNode), workingSince: st ? (st.workingSince || 0) : 0,
        error: st ? st.error : null, empty: st ? !!st.empty : false,
        foldedKeys: st ? (function () {
          var ks = [];
          for (var k in st.foldedKeys) if (Object.prototype.hasOwnProperty.call(st.foldedKeys, k)) ks.push(k);
          return ks;
        })() : [],
        /* A3.1: the values matter (false = the reader closed it), so this is the map, not a list */
        openKeys: st ? (function () {
          var o = {};
          for (var k in st.openKeys) if (Object.prototype.hasOwnProperty.call(st.openKeys, k)) o[k] = !!st.openKeys[k];
          return o;
        })() : {},
        stateText: stateEl ? stateEl.textContent : '',
        follow: follow, newCount: newCount,
        pending: st ? st.pending.map(function (p) {
          return { id: p.id, text: p.text, lost: !!p.lost, resolved: !!p.resolved, since: p.since, ageMs: Date.now() - p.sentAt };
        }) : [],
        lastQuery: st ? st.lastQuery : '', fetches: st ? st.fetches : 0, errors: st ? st.errors : 0
      };
    }
  }

  /* ────────────────────────────────────────────────────────────── the module handle */

  var handle = null;
  var liveHost = null;          // the host of the instance currently mounted (idempotence guard)

  function testApi() {
    return {
      /* every seam feeds the SAME functions the network path uses (ingest / notePending / the
         pending clock), so the ?selftest=1 cases and the headless probes exercise shipped code. */
      setPane: function (id) { return !!(handle && handle.__setPaneOverride(id)); },
      setStatus: function (id, status) { return handle ? handle.__setStatus(id, status) : null; },
      setAuto: function (on) { return handle ? handle.__setAuto(on) : false; },
      ingest: function (id, body) { if (!handle) return false; handle.__ingest(id, body); return true; },
      /* the SAME ingest, but marked as the answer to a `tail=1` request — the first-load path */
      ingestTail: function (id, body) { if (!handle) return false; handle.__ingestTail(id, body); return true; },
      pending: function (id, tx) { return !!(handle && handle.notePending(id, tx)); },
      /* DEFECT-12: the latch decision itself, and the in-flight record, straight from the instance
         the network path uses — a test asserts the same function poll() calls */
      latch: function () { return handle ? handle.__latch.apply(null, arguments) : null; },
      reqTimeoutMs: function () { return handle ? handle.__reqTimeoutMs() : 0; },
      inflight: function () { return handle ? handle.__inflight() : null; },
      abandon: function (why) { return handle ? handle.__abandon(why) : false; },
      working: function (id) { return handle ? handle.__working(id) : false; },
      /* read-only introspection: every pane this view has state for (the stalls that a probe or a
         reader wants to see are per pane, not only for the one on screen) */
      panes: function () { return handle ? handle.__panes() : []; },
      tick: function (nowMs) { return handle ? handle.__tick(nowMs) : false; },
      messages: function (id) { return handle ? handle.__messages(id) : []; },
      foldKeys: function (id) { return handle ? handle.__foldKeys(id) : []; },
      openKeys: function (id) { return handle ? handle.__openKeys(id) : {}; },
      state: function () { return handle ? handle.state() : null; },
      dom: function () { return handle ? handle.__dom() : null; },
      renderer: rendererName,
      /* DEFECT-18(2) / §10 seams (see the handle for what each one feeds) */
      setReqTimeoutMs: function (ms) { return handle ? handle.__setReqTimeoutMs(ms) : 0; },
      reqTimerArmed: function () { return handle ? handle.__reqTimerArmed() : false; },
      retry: function () { return handle ? handle.__retry() : false; },
      lastAsk: function () { return handle ? handle.__lastAsk() : null; },
      dedupMs: function () { return handle ? handle.__dedupMs : 0; },
      attach: function () { return handle ? handle.__attach() : null; },
      attachFiles: function (files, paneId, opts) { return handle ? handle.__attachFiles(files, paneId, opts) : null; },
      attachRemove: function (id) { return handle ? handle.__attachRemove(id) : false; },
      attachClear: function () { return handle ? handle.__attachClear() : false; },
      composeSend: function (paneId, typed) { return handle ? handle.__composeSend(paneId, typed) : null; }
    };
  }

  var mod = { id: ID, title: TITLE, mount: function (ctx) { handle = mount(ctx); return handle; } };

  var HDx = (window.HD = window.HD || {});
  HDx.modules = HDx.modules || {};
  HDx.modules[ID] = mod;
  HDx.pending = HDx.pending || [];
  if (HDx.pending.indexOf(mod) < 0) HDx.pending.push(mod);
  window.HD.chatviewTest = testApi();
  if (typeof HDx.register === 'function') {
    try { HDx.register(mod); } catch (e) { /* the integrator reports it */ }
  } else {
    scheduleRegister(mod);
  }

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
    document.addEventListener('DOMContentLoaded', tryNow, { once: true });
    window.addEventListener('load', tryNow, { once: true });
    var tries = 0;
    var t = window.setInterval(function () {
      if (done || ++tries > 100) { window.clearInterval(t); return; }
      tryNow();
    }, 100);
  }
})();
