#!/usr/bin/env node
'use strict';
/*
 * tools/claude-approval-hook.js - a Claude Code PreToolUse hook that asks Herdr-Dash.
 *
 * Claude Code runs this before a tool that needs permission. The hook forwards the tool call to the
 * local Herdr-Dash server, waits for a person to press Allow once or Deny in the composer banner, and
 * answers Claude with that decision. If anything at all goes wrong - no pane, no token, no server, a
 * timeout, a body that is not the answer we expect - it prints NOTHING and exits 0, which leaves
 * Claude's own permission flow in charge (an interactive prompt, or a refusal under `-p`). There is
 * deliberately no path that prints an allow without a human decision behind it.
 *
 * It only acts inside a herdr pane: the first two gates are HERDR_ENV=1 and a non-empty
 * HERDR_PANE_ID, both set by herdr for the processes it starts, so a Claude session started anywhere
 * else runs this hook, is not in a pane, and is left completely alone.
 *
 * Plain CommonJS, no dependencies, Node 18+.
 *
 * ENVIRONMENT
 *   HERDR_ENV, HERDR_PANE_ID            the gate: both must say "we are inside a herdr pane"
 *   HERDR_DASH_APPROVAL_URL             base URL of the dashboard (default http://127.0.0.1:7433)
 *   HERDR_DASH_APPROVAL_TOKEN_FILE      shared secret (default <HERDR_DASH_HOME>/approval-token)
 *   HERDR_DASH_HOME                     the app's state directory (default ~/.herdr-dash)
 *   HERDR_DASH_APPROVAL_LOG_FILE        where the one-line log goes (default <home>/approval-hook.log)
 *
 * The log records the event, the pane, the tool NAME, the decision and an error code. It never
 * records the tool input: a command or a file body is not something to leave on disk.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const HOLD_MS = 115000;                 // stop waiting well before Claude's own hook timeout
const INPUT_CAP_BYTES = 48 * 1024;      // how much of a tool input this bridge will forward
const STDIN_CAP_BYTES = 16 * 1024 * 1024;
const RESPONSE_CAP_BYTES = 64 * 1024;
const DEFAULT_PORT = 7433;
const APPROVAL_PATH = '/api/claude/approval';

function stateDir() {
  const override = String(process.env.HERDR_DASH_HOME || '').trim();
  return override !== '' ? override : path.join(os.homedir(), '.herdr-dash');
}
function tokenFile() {
  const override = String(process.env.HERDR_DASH_APPROVAL_TOKEN_FILE || '').trim();
  return override !== '' ? override : path.join(stateDir(), 'approval-token');
}
function logFile() {
  const override = String(process.env.HERDR_DASH_APPROVAL_LOG_FILE || '').trim();
  return override !== '' ? override : path.join(stateDir(), 'approval-hook.log');
}
function endpoint() {
  const raw = String(process.env.HERDR_DASH_APPROVAL_URL || '').trim();
  const base = (raw !== '' ? raw : 'http://127.0.0.1:' + DEFAULT_PORT).replace(/\/+$/, '');
  return base + APPROVAL_PATH;
}

/** The shared secret the dashboard wrote. Absent, empty or unreadable all mean "do nothing". */
function readToken() {
  try {
    const token = fs.readFileSync(tokenFile(), 'utf8').trim();
    return token === '' ? null : token;
  } catch (e) {
    return null;
  }
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}
function jsonOf(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : null;
  } catch (e) {
    return null;
  }
}

/** Cut a string to at most `maxBytes` of UTF-8 without splitting a character. */
function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length <= maxBytes) return String(text);
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8') + '…';
}

/**
 * Keep the forwarded tool input under the size cap.
 *
 * Under the cap the value is sent exactly as Claude gave it. Over it, every top-level entry keeps its
 * name and as much of its text as the remaining budget allows, so a banner can still say WHICH file a
 * Write is for while the body of that file is cut. The caller gets `truncated: true` either way, and
 * the UI is expected to say so rather than imply it is showing everything.
 */
function capToolInput(input) {
  if (input === null || input === undefined) return { value: {}, truncated: false };
  const whole = jsonOf(input);
  if (whole === null) return { value: {}, truncated: true };
  if (byteLength(whole) <= INPUT_CAP_BYTES) return { value: input, truncated: false };

  const out = {};
  let budget = INPUT_CAP_BYTES;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    Object.keys(input).forEach(function (key) {
      const value = input[key];
      const asText = typeof value === 'string' ? value : jsonOf(value);
      if (budget <= 0) {
        out[key] = typeof value === 'string' ? '' : '[omitted: the call is too large to show]';
        return;
      }
      if (asText !== null && byteLength(asText) <= budget) {
        out[key] = value;
        budget -= byteLength(asText);
        return;
      }
      const room = Math.min(budget, 8192);
      out[key] = truncateUtf8(asText === null ? '' : asText, room);
      budget -= byteLength(out[key]);
    });
  } else {
    out.data = truncateUtf8(whole, Math.min(budget, 8192));
  }

  const check = jsonOf(out);
  if (check === null || byteLength(check) > INPUT_CAP_BYTES) {
    return { value: { note: 'the tool call is too large to show here' }, truncated: true };
  }
  return { value: out, truncated: true };
}

/**
 * One request to the dashboard. `cb(error, statusCode, bodyText)` is called exactly once; every
 * failure shape (refused, reset, silent server, timeout) arrives as an error and is treated the same
 * way by the caller: fall back with empty stdout.
 */
function ask(textUrl, token, payload, cb) {
  let settled = false;
  let timer = null;
  let req = null;

  function once(err, status, body) {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    cb(err, status, body);
  }

  let target;
  try {
    target = new URL(textUrl);
  } catch (e) {
    once(new Error('bad url'));
    return null;
  }

  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const transport = target.protocol === 'https:' ? https : http;
  try {
    req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port !== '' ? target.port : (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      // A socket timeout is inherited from the shared agent when this is left out, and the shared
      // agent's is a few seconds: that would give up long before a person can press a button. This
      // request MUST be allowed to wait, so the hold is stated here and the agent is not reused.
      agent: false,
      timeout: HOLD_MS,
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        authorization: 'Bearer ' + token
      }
    }, function (res) {
      const chunks = [];
      let size = 0;
      res.on('data', function (chunk) {
        size += chunk.length;
        if (size <= RESPONSE_CAP_BYTES) chunks.push(chunk);
      });
      res.on('error', function (e) { once(e); });
      res.on('end', function () { once(null, res.statusCode, Buffer.concat(chunks).toString('utf8')); });
    });
  } catch (e) {
    once(e);
    return null;
  }

  timer = setTimeout(function () { if (req) req.destroy(new Error('timed out')); }, HOLD_MS);
  if (timer.unref) timer.unref();
  req.on('timeout', function () { if (req) req.destroy(new Error('timed out')); });
  req.on('error', function (e) { once(e); });
  req.end(body);
  return req;
}

/** The one line Claude is meant to act on. Nothing else is ever printed on stdout. */
function decisionOutput(decision, reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason
    }
  });
}

function reasonFrom(body, fallback) {
  const reason = body && typeof body.reason === 'string' ? body.reason.trim() : '';
  return reason !== '' ? reason : fallback;
}

/** Best effort, never throws, never records the tool input. */
function logLine(fields) {
  try {
    const parts = [new Date().toISOString()];
    Object.keys(fields).forEach(function (key) {
      const value = fields[key];
      if (value === undefined || value === null || value === '') return;
      parts.push(key + '=' + String(value).replace(/[\r\n]+/g, ' ').slice(0, 200));
    });
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, parts.join(' ') + '\n', 'utf8');
  } catch (e) {
    // a log that cannot be written is not a reason to fail a tool call
  }
}

/**
 * Finish the run. `text` is what Claude should see: the decision line, or nothing at all. It is
 * written synchronously to fd 1 so the process can exit immediately without truncating the pipe.
 */
function finish(text, note, inPane) {
  if (inPane && note) logLine(note);
  if (text) {
    try {
      fs.writeSync(1, text + '\n');
    } catch (e) {
      // stdout closed: there is no decision to deliver, and exiting 0 stays the safe answer
    }
  }
  process.exit(0);
}

function onPayload(raw, inPane) {
  let event;
  try {
    event = JSON.parse(raw);
  } catch (e) {
    return finish('', { event: 'parse-error', note: 'input was not json' }, inPane);
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return finish('', { event: 'parse-error', note: 'input was not an object' }, inPane);
  }

  const name = typeof event.hook_event_name === 'string' ? event.hook_event_name : '';
  if (name !== '' && name !== 'PreToolUse') return finish('', null, false);   // another event, not ours

  const tool = typeof event.tool_name === 'string' ? event.tool_name.trim() : '';
  if (!inPane) return finish('', null, false);                                // outside herdr: silent
  if (tool === '') return finish('', { event: name || 'PreToolUse', note: 'no tool name' }, true);

  const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
  const pane = String(process.env.HERDR_PANE_ID || '').trim();
  const token = readToken();
  if (!token) return finish('', { event: 'PreToolUse', pane: pane, tool: tool, note: 'no token file' }, true);

  const input = capToolInput(event.tool_input);
  const payload = {
    pane_id: pane,
    session_id: sessionId,
    cwd: typeof event.cwd === 'string' ? event.cwd : '',
    permission_mode: typeof event.permission_mode === 'string' ? event.permission_mode : '',
    tool_name: tool,
    tool_input: input.value,
    tool_input_truncated: input.truncated
  };

  const base = { event: 'PreToolUse', pane: pane, tool: tool };
  ask(endpoint(), token, payload, function (err, status, bodyText) {
    if (err) {
      return finish('', Object.assign({}, base, { note: 'bridge unreachable: ' + (err.code || err.message) }), true);
    }
    if (status !== 200) {
      return finish('', Object.assign({}, base, { note: 'bridge answered ' + status }), true);
    }
    let answer;
    try {
      answer = JSON.parse(bodyText);
    } catch (e) {
      return finish('', Object.assign({}, base, { note: 'bridge answered with a body that is not json' }), true);
    }
    if (!answer || typeof answer !== 'object' || answer.ok !== true) {
      return finish('', Object.assign({}, base, { note: 'bridge refused the request' }), true);
    }
    const id = typeof answer.id === 'string' ? answer.id.trim() : '';
    if (id === '') {
      return finish('', Object.assign({}, base, { note: 'bridge answered without a request id' }), true);
    }
    if (answer.decision === 'allow') {
      return finish(decisionOutput('allow', reasonFrom(answer, 'approved in Herdr-Dash')),
        Object.assign({}, base, { decision: 'allow', id: id }), true);
    }
    if (answer.decision === 'deny') {
      return finish(decisionOutput('deny', reasonFrom(answer, 'denied in Herdr-Dash')),
        Object.assign({}, base, { decision: 'deny', id: id }), true);
    }
    // no human decision (expired, or the browser was closed): Claude's own flow takes over
    return finish('', Object.assign({}, base, { note: 'no decision from the bridge' }), true);
  });
}

function main() {
  const inPane = process.env.HERDR_ENV === '1'
    && String(process.env.HERDR_PANE_ID || '').trim() !== '';
  // Outside a herdr pane this program has nothing to do and says nothing, before reading anything.
  if (!inPane) return finish('', null, false);

  if (process.stdin.isTTY) return finish('', { event: 'PreToolUse', note: 'no input on stdin' }, true);

  const chunks = [];
  let size = 0;
  let done = false;
  function deliver(text) {
    if (done) return;
    done = true;
    onPayload(text === null ? '' : text, true);
  }
  process.stdin.on('data', function (chunk) {
    if (done) return;
    size += chunk.length;
    if (size > STDIN_CAP_BYTES) return deliver(null);
    chunks.push(chunk);
  });
  process.stdin.on('end', function () { deliver(Buffer.concat(chunks).toString('utf8')); });
  process.stdin.on('error', function () { deliver(null); });
  process.stdin.resume();
}

main();
