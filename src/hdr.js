'use strict';
/*
 * src/hdr.js — herdr transport layer (owner: W1)
 *
 * Talks to the herdr server over its Windows named pipe. The pipe name IS the
 * socket file path (CONTRACT.md §2), so it is `\\.\pipe\` + HERDR_SOCKET_PATH.
 *
 * Exports:
 *   pipe                    the resolved pipe path (also shown by /api/health)
 *   HerdrError              Error subclass carrying herdr's own error `code`
 *   request(method, params, {timeoutMs}) -> Promise<result>
 *   subscribe(subs, onEvent, onStatus)   -> { close() }
 *   stripAnsi(text)
 *   mergeStream(prevLines, nextLines)      v1 rule, kept for test/acceptance.mjs
 *   advanceBuffer(prevLines, nextLines)    v2 rule, RE-EXPORTED from the shared
 *                                          browser copy per CONTRACT-v2 §0.2 R2
 *
 * Protocol facts (verified live, herdr 0.9.1 / protocol 22):
 *   - one JSON request line per connection, one JSON reply line, then the
 *     server closes the socket. A `close` AFTER a reply is normal.
 *   - replies are `{id,result}` or `{id:"",error:{code,message}}`.
 *   - a subscription keeps the socket open; the ack is
 *     `{id:"sub",result:{type:"subscription_started"}}`, then bare event lines
 *     `{event:"<dotted>",data:{...}}` follow (no `id`).
 */

const net = require('node:net');
const path = require('node:path');

// ── pipe path ───────────────────────────────────────────────────────────────
// HERDR_SOCKET_PATH wins; otherwise the default APPDATA location.
const pipe = '\\\\.\\pipe\\' + (process.env.HERDR_SOCKET_PATH
  || path.join(process.env.APPDATA || '', 'herdr', 'herdr.sock'));

// ── errors ──────────────────────────────────────────────────────────────────
// `code` is either herdr's own code (e.g. "pane_not_found", "invalid_request")
// or one of ours: "timeout", "pipe_error", "pipe_closed".
class HerdrError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HerdrError';
    this.code = code || 'herdr_error';
  }
}

let seq = 0;

// ── request / reply ─────────────────────────────────────────────────────────
/**
 * Send one request on a fresh connection and resolve with its `result`.
 * Rejects with a HerdrError on a herdr `error` reply, on timeout, or if the
 * pipe closes before any reply arrived.
 */
function request(method, params, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 10000;

  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let buf = '';
    let settled = false;

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy(); // the server closes anyway; don't linger on FDs
      fn(value);
    };
    const fail = (err) => done(reject, err);

    const timer = setTimeout(() => {
      fail(new HerdrError('timeout', `herdr request timed out after ${timeoutMs} ms: ${method}`));
    }, timeoutMs);

    // Parse one complete line. Junk lines are ignored rather than fatal.
    const onLine = (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (e) { return; }
      if (msg.error) return fail(new HerdrError(msg.error.code, msg.error.message || 'herdr error'));
      if (msg.result !== undefined) return done(resolve, msg.result);
    };

    socket.setNoDelay(true);
    socket.on('connect', () => {
      socket.write(JSON.stringify({ id: 'r' + (++seq), method, params: params || {} }) + '\n');
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    socket.on('error', (err) => {
      fail(new HerdrError('pipe_error', `herdr pipe error on ${method}: ${err.message}`));
    });
    socket.on('close', () => {
      if (settled) return;
      // Tolerate a reply with no trailing newline: the server closes right
      // after writing, so the tail may still be sitting in the buffer.
      const rest = buf.trim();
      buf = '';
      if (rest) onLine(rest);
      if (!settled) {
        fail(new HerdrError('pipe_closed', `herdr closed the connection before replying to ${method}`));
      }
    });
  });
}

// ── subscriptions ───────────────────────────────────────────────────────────
/**
 * Open ONE long-lived connection and subscribe to `subscriptions` (an array of
 * `{type, ...extra}` objects, dotted variant names — CONTRACT.md §2).
 *
 * onEvent(evt)  receives the parsed envelope `{event:"<dotted>", data:{...}}`
 *               for every line after the ack.
 * onStatus(st)  receives `{state:"connected"}` once the ack lands, then
 *               `{state:"closed"}` or `{state:"error", error:{code,message}}`
 *               when the connection dies. The caller owns reconnection.
 *
 * Partial lines are buffered on '\n' — JSON.parse is never fed a fragment.
 */
function subscribe(subscriptions, onEvent, onStatus) {
  const socket = net.connect(pipe);
  let buf = '';
  let acked = false;
  let closed = false;

  const status = (st) => {
    try { if (onStatus) onStatus(st); } catch (e) { /* a bad callback must not kill the socket */ }
  };
  const event = (evt) => {
    try { if (onEvent) onEvent(evt); } catch (e) { /* same */ }
  };

  socket.setNoDelay(true);
  socket.on('connect', () => {
    socket.write(JSON.stringify({
      id: 'sub',
      method: 'events.subscribe',
      params: { subscriptions: subscriptions || [] },
    }) + '\n');
  });

  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;

      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }

      if (!acked) {
        if (msg.error) {
          closed = true;
          socket.destroy();
          status({ state: 'error', error: { code: msg.error.code, message: msg.error.message || 'subscribe failed' } });
          return;
        }
        if (msg.result) {
          acked = true;
          status({ state: 'connected' });
          continue;
        }
        // No ack shape at all — fall through and treat it as an event.
      }
      if (msg.event) event(msg);
    }
  });

  socket.on('error', (err) => {
    // A pre-ack error means the subscription never started.
    if (closed) return;
    closed = true;
    status({ state: 'error', error: { code: 'pipe_error', message: err.message } });
  });
  socket.on('close', () => {
    if (closed) return;
    closed = true;
    status({ state: 'closed' });
  });

  return {
    close() {
      closed = true;
      try { socket.destroy(); } catch (e) { /* already gone */ }
    },
  };
}

// ── text helpers (CONTRACT.md §7) ───────────────────────────────────────────
// Matches CSI / OSC / single-char escape sequences, incl. colour and cursor.
const ANSI_RE = new RegExp([
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
  '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
].join('|'), 'g');

/** Remove ANSI escape sequences from terminal text. */
function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI_RE, '') : text;
}

/**
 * Diff a fresh scrollback tail against what the client already shows.
 * Returns `{newLines, overlapped}`; `overlapped:false` means the screen was
 * cleared / scrolled past and the caller should render a separator.
 *
 * KEPT FOR BACK-COMPAT: `test/acceptance.mjs` (the v1 harness) imports this and
 * must keep passing. New callers should use advanceBuffer() — see DEFECT-1 below.
 */
function mergeStream(prevLines, nextLines) {
  const max = Math.min(prevLines.length, nextLines.length);
  for (let k = max; k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (prevLines[prevLines.length - k + i] !== nextLines[i]) { same = false; break; }
    }
    if (same) return { newLines: nextLines.slice(k), overlapped: true };
  }
  return { newLines: nextLines, overlapped: false };
}

/*
 * ── advanceBuffer (CONTRACT-v2 §0.1 + §0.2 R2) — the DEFECT-1 fix ───────────
 *
 * There is exactly ONE implementation of this rule in the repo:
 * public/lib/advance-buffer.js — the classic script the page loads (it publishes
 * `window.HD.advanceBuffer`) and the file Node can `require` through its
 * CommonJS shim. Per §0.2 R2 this module requires that file and re-exports it,
 * so the server and the page cannot drift apart again: `test/parity.mjs` now
 * sees one function object, not two hand-written copies of one algorithm.
 *
 * The rules themselves (4, 1, 1r, 1s, 2, 3), their order and the reasoning live
 * in that file. What is kept here is the record of WHICH failure the rule set
 * exists to stop — the reason `mergeStream` above must not be used for a
 * transcript:
 *
 *   mergeStream appends only when the previous buffer's tail equals the new
 *   window's head. Every other situation — a read that arrives out of order, a
 *   window served from a stale response, herdr's 1000-line read cap truncating
 *   the requested window, a TUI that repaints its pinned bottom rows in place —
 *   falls into its `overlapped:false` branch, which appends the WHOLE window.
 *   Poll every second and the same block is re-appended over and over: the
 *   4x-in-raw / 13x-in-GUI growth reported in §0.1, measured at 40,000 buffer
 *   lines for 40,000 lines of windows in §0.2.
 *
 * `test/parity.mjs` guards the arrangement: it asserts that this export IS the
 * shared copy, and keeps the frozen pre-fix copies (mergeStream above, plus the
 * round-2 browser copy embedded in the harness) reproducing that duplication, so
 * the teeth survive a future "small optimisation" of either file.
 *
 * Nothing here changes the `request`/`subscribe` surface of this module.
 */

// R2: the shared copy is the single implementation. This is a hard dependency —
// without public/lib/advance-buffer.js the module cannot load (deliberately: a
// silent fallback would be a second implementation again).
const { advanceBuffer } = require('../public/lib/advance-buffer.js');

module.exports = { pipe, HerdrError, request, subscribe, stripAnsi, mergeStream, advanceBuffer };
