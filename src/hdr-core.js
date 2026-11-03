'use strict';
/*
 * src/hdr-core.js — transport for herdr-core (`hc`), the successor to herdr.
 *
 * herdr-core speaks JSON-RPC 2.0 over a Windows named pipe whose name is NOT a
 * file path: `\\.\pipe\herdr-core-<username>-<profile>.sock`. Its API surface is
 * `terminal.*` (address `t7`), not herdr's `session.*` / `pane.*` / `agent.*`.
 *
 * This module is deliberately dumb: connect, one request, one reply, close.
 * src/hdr.js does the legacy → core translation on top of it.
 */

const net = require('node:net');

const PIPE_PREFIX = '\\\\.\\pipe\\';

/** Full pipe path. HERDR_CORE_PIPE may be a bare name or a full `\\.\pipe\...`. */
function corePipe(env) {
  const e = env || process.env;
  const explicit = e.HERDR_CORE_PIPE || e.HERDR_SOCKET_PATH;
  if (explicit) {
    if (explicit.startsWith('\\\\')) return explicit;
    if (explicit.startsWith('herdr-core-')) return PIPE_PREFIX + explicit;
    // A bare name that already looks like a pipe name; keep the old behaviour of
    // "pipe name = suffix", which is what HERDR_SOCKET_PATH meant for the dash.
    return PIPE_PREFIX + explicit.replace(/^[A-Za-z]:[\\/].*[\\/]/, '');
  }
  const user = String(e.USERNAME || e.USER || 'user').toLowerCase();
  const profile = e.HERDR_CORE_PROFILE || 'default';
  return `${PIPE_PREFIX}herdr-core-${user}-${profile}.sock`;
}

const pipe = corePipe();

let seq = 0;

/** One JSON-RPC request on a fresh connection. Resolves `result`, rejects Error{code}. */
function rpc(method, params, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 10000;
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let buf = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };

    const timer = setTimeout(() => {
      const e = new Error(`herdr-core request timed out after ${timeoutMs} ms: ${method}`);
      e.code = 'timeout';
      finish(reject, e);
    }, timeoutMs);

    const onLine = (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (e) { return; }
      if (msg.error) {
        const e = new Error(msg.error.message || 'herdr-core error');
        e.code = msg.error.code;
        e.data = msg.error.data;
        return finish(reject, e);
      }
      if (msg.result !== undefined) return finish(resolve, msg.result);
    };

    socket.setNoDelay(true);
    socket.on('connect', () => {
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params: params || {} }) + '\n');
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
      const e = new Error(`herdr-core pipe error on ${method}: ${err.message}`);
      e.code = 'pipe_error';
      e.errno = err.code;
      e.pipe = pipe;
      finish(reject, e);
    });
    socket.on('close', () => {
      if (settled) return;
      const rest = buf.trim();
      if (rest) onLine(rest);
      if (!settled) {
        const e = new Error(`herdr-core closed the connection before replying to ${method}`);
        e.code = 'pipe_closed';
        finish(reject, e);
      }
    });
  });
}

/** agent word for a terminal: the agent's own status app, else the foreground program. */
function agentOf(t) {
  return (t && t.status && t.status.app) || (t && t.foreground && t.foreground.name) || null;
}

/** herdr-core status word → the status vocabulary the dash already speaks. */
function statusOf(t) {
  if (!t) return null;
  if (t.status && t.status.state) return t.status.state;
  return t.state === 'finished' ? 'done' : null;
}

module.exports = { pipe, rpc, corePipe, agentOf, statusOf };
