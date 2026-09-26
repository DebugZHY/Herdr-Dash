'use strict';
/*
 * src/server.js — herdr-dash HTTP server (owner: W1)
 *
 * Zero npm dependencies: node:http, node:child_process, node:fs, node:path and
 * the local ./hdr transport. Implements CONTRACT.md §4 (REST), §5 (SSE),
 * CONTRACT-v2 §7.1 (GET /api/git, the read-only git view) and §12.3
 * (GET /api/status, the pane's own output interpreted — src/status.js).
 *
 *   node src/server.js [--port 7433] [--host 127.0.0.1]
 *
 * Bind address is localhost only. Every JSON response is HTTP 200 and carries
 * {ok:true,...} or {ok:false,error:{code,message}}; only an unknown path is 404.
 *
 * Processes are spawned with argv arrays and shell:false — this file never builds
 * a command string. §7.1's git handling is read-only by construction: see the
 * marked whitelist table below.
 */

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const cp = require('node:child_process');
const hdr = require('./hdr');
const chatCommon = require('./chat/common');     // §8.2 message shape + caps
const chatClaude = require('./chat/claude');     // §8.1 claude jsonl resolution/parse
const chatHermes = require('./chat/hermes');     // §8.1 hermes sqlite resolution/parse
const chatSession = require('./chat/session');   // §9 pane→session binding (round 7.6)
const attach = require('./attach');              // §10 POST /api/attach (round 7.7)
const pathsApi = require('./paths');             // §13.2 POST /api/pathinfo, /api/open (round 9)
const statusView = require('./status');          // §12.3 GET /api/status (round 8)

// ── config ──────────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 1024 * 1024;      // §4 hardening: 1 MiB request body cap
const DEFAULT_TIMEOUT_MS = 10000;        // §4: per-request herdr timeout
const WAIT_TIMEOUT_MS = 30000;           // §4: agent.prompt with wait:true
const WAIT_DEFAULT_MS = 300000;          // §4 body default for timeout_ms
const CLI_TIMEOUT_MS = 15000;            // §4 body default for /api/cli
const CLI_MAX_OUTPUT = 8 * 1024 * 1024;  // safety valve on captured stdout/stderr
const HERDR_BIN = process.env.HERDR_BIN_PATH || 'herdr';
const STARTED_AT = Date.now();

// §7.1 (v2 round 5): the read-only git view. GIT_BIN is overridable so a test can
// point it at a missing binary (git_missing) or at a wrapper; the subcommands it
// is ever asked to run are the literal whitelist further down.
const GIT_BIN = process.env.GIT_BIN_PATH || 'git';
const GIT_TIMEOUT_MS = 15000;
const GIT_MAX_LINES_DEFAULT = 400;       // §7.1: max_lines default
const GIT_MAX_LINES_CAP = 2000;          // §7.1: max_lines hard cap

const READ_SOURCES = new Set(['visible', 'recent', 'recent_unwrapped', 'detection']);

// §9 (round 7.6): the pane→session binding is re-derived on every /api/chat poll.
// Two knobs, both env-overridable for the same reason HERDR_SOCKET_PATH is: the
// fixture server in the local test suite has to drive a 60 s watchdog inside a test.
//   CHAT_SESSION_CACHE_MS  how long one pane read / store lookup / candidate scan
//                          is reused (the page polls faster than this)
//   CHAT_STALE_MS          §9.4's "~60 s" window
const SESSION_CACHE_MS = Number.isFinite(Number(process.env.CHAT_SESSION_CACHE_MS))
  ? Math.max(0, Number(process.env.CHAT_SESSION_CACHE_MS)) : 2000;
const STALE_MS = Number.isFinite(Number(process.env.CHAT_STALE_MS))
  ? Math.max(0, Number(process.env.CHAT_STALE_MS)) : chatSession.LIMITS.STALE_MS_DEFAULT;
const bindingTracker = chatSession.createBindingTracker({ staleMs: STALE_MS });
// A pane whose session we already reported, so herdr is not asked to store the
// same value once per poll until its own cache catches up.
const healedPanes = new Map();

// §2 (v2): widened read window and the batch fan-out cap.
// NB: herdr itself caps pane.read at 1000 lines no matter what we ask for, so
// the 20000 clamp is honoured by the server but cannot be satisfied upstream.
const MAX_LINES = 20000;
const MAX_BATCH_PANES = 20;

// ── tiny helpers ────────────────────────────────────────────────────────────
const ok = (res, extra) => sendJson(res, Object.assign({ ok: true }, extra));
const err = (res, code, message, extra) =>
  sendJson(res, Object.assign({ ok: false, error: { code, message } }, extra || {}));
// Unknown paths are the one non-200 JSON response (§4): 404 + {code:"not_found"}.
const notFound = (res, message) => sendJson(res, { ok: false, error: { code: 'not_found', message } }, 404);

function sendJson(res, body, statusCode) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(statusCode || 200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Map a thrown hdr.HerdrError onto the contract's error vocabulary. */
function herdrError(errObj) {
  if (errObj instanceof hdr.HerdrError) {
    const raw = errObj.code || 'herdr_error';
    if (raw === 'timeout') return { code: 'herdr_timeout', message: errObj.message, herdr_code: raw };
    if (raw === 'not_found' || /_not_found$/.test(raw)) {
      return { code: 'not_found', message: errObj.message, herdr_code: raw };
    }
    return { code: 'herdr_error', message: errObj.message, herdr_code: raw };
  }
  return { code: 'herdr_error', message: String((errObj && errObj.message) || errObj) };
}

/** Read the request body, enforcing the 1 MiB cap. Rejects with a code. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk) => {
      if (oversized) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering but let the socket drain — destroying it here would
        // kill the connection before the 200 {ok:false} reply can be written.
        oversized = true;
        chunks.length = 0;
        reject({ code: 'bad_request', message: 'request body exceeds 1 MiB' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!oversized) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (e) => {
      if (!oversized) reject({ code: 'bad_request', message: 'could not read body: ' + e.message });
    });
  });
}

/** Parse a JSON body into an object; rejects with {code,message} on bad input. */
async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw { code: 'bad_request', message: 'malformed JSON body: ' + e.message };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw { code: 'bad_request', message: 'JSON body must be an object' };
  }
  return parsed;
}

/** Non-empty string or throw bad_request. */
function requireString(body, field) {
  const v = body[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw { code: 'bad_request', message: `"${field}" is required and must be a non-empty string` };
  }
  return v;
}

/** Optional string; absent/null is fine, anything else is bad_request. */
function optionalString(body, field) {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw { code: 'bad_request', message: `"${field}" must be a string` };
  }
  return v;
}

/** `lines` query param: default 200, clamped to 1..20000 (v2 widened the top). */
function clampLines(raw) {
  if (raw === null || raw === undefined || raw === '') return 200;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 200;
  return Math.min(MAX_LINES, Math.max(1, n));
}

/** Shared `keys` validation for single-pane and broadcast sends. */
function normalizeKeys(keys) {
  let list = keys;
  if (typeof list === 'string') list = list.split(/\s+/).filter(Boolean);
  if (!Array.isArray(list) || list.length === 0) {
    throw { code: 'bad_request', message: '"keys" is required and must be a non-empty array or a whitespace-separated string' };
  }
  if (!list.every((k) => typeof k === 'string' && k.length > 0)) {
    throw { code: 'bad_request', message: 'every entry of "keys" must be a non-empty string' };
  }
  return list;
}

/** §2: `pane_ids` validation shared by /api/fanout and /api/keys-broadcast. */
function requirePaneIds(body) {
  const ids = body.pane_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw { code: 'bad_request', message: '"pane_ids" is required and must be a non-empty array of pane ids' };
  }
  if (!ids.every((id) => typeof id === 'string' && id.length > 0)) {
    throw { code: 'bad_request', message: 'every entry of "pane_ids" must be a non-empty string' };
  }
  if (ids.length > MAX_BATCH_PANES) {
    throw { code: 'bad_request', message: `"pane_ids" holds ${ids.length} panes; the maximum is ${MAX_BATCH_PANES}` };
  }
  return ids;
}

/**
 * §2: issue one herdr call per pane CONCURRENTLY.
 *
 * Every hdr.request() call happens inside this synchronous .map — hdr.request()
 * opens its pipe socket the moment it is called — so all N connections are open
 * before the first await. Wall clock is ~one round trip, not N.
 *
 * A pane that fails (bad id, herdr error, timeout) is captured as
 * {pane_id, ok:false, error} and must never reject the batch.
 */
function fanOut(paneIds, buildParams, method, timeoutMs) {
  const pending = paneIds.map((paneId) => hdr
    .request(method, buildParams(paneId), { timeoutMs })
    .then((result) => ({ pane_id: paneId, ok: true, result }))
    .catch((e) => {
      const m = herdrError(e);
      return { pane_id: paneId, ok: false, error: { code: m.code, message: m.message } };
    }));
  return Promise.all(pending);
}

// ── static file serving ─────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Map a URL path to an absolute file inside public/.
 * `/` -> index.html; `/static/<f>` and `/<f>` both resolve to public/<f>.
 * Returns null for anything that escapes public/.
 */
function resolveStatic(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    return null;
  }
  rel = rel.replace(/^\/+/, '');
  if (rel.startsWith('static/')) rel = rel.slice('static/'.length);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  const full = path.resolve(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return null;
  return full;
}

async function serveStatic(req, res, pathname) {
  const file = resolveStatic(pathname);
  if (!file) return notFound(res, 'path escapes public/: ' + pathname);

  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (e) {
    const hint = file.endsWith('index.html')
      ? ' (public/index.html has not been written yet — it is owned by W2)'
      : '';
    return notFound(res, 'no such file: ' + pathname + hint);
  }
  if (!stat.isFile()) return notFound(res, 'not a file: ' + pathname);

  let data;
  try {
    data = await fsp.readFile(file);
  } catch (e) {
    return notFound(res, 'could not read ' + pathname + ': ' + e.message);
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': data.length,
    'cache-control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

// ── REST endpoints (§4) ─────────────────────────────────────────────────────

// GET /api/health — herdr version + protocol, pipe path, server uptime.
async function handleHealth(req, res) {
  try {
    const pong = await hdr.request('ping', {}, { timeoutMs: DEFAULT_TIMEOUT_MS });
    ok(res, {
      herdr: { version: pong.version, protocol: pong.protocol },
      pipe: hdr.pipe,
      uptime_ms: Date.now() - STARTED_AT,
    });
  } catch (e) {
    const m = herdrError(e);
    err(res, m.code, m.message, { pipe: hdr.pipe, uptime_ms: Date.now() - STARTED_AT });
  }
}

// GET /api/snapshot — verbatim session.snapshot result.
async function handleSnapshot(req, res) {
  try {
    const result = await hdr.request('session.snapshot', {}, { timeoutMs: DEFAULT_TIMEOUT_MS });
    ok(res, { snapshot: result.snapshot });
  } catch (e) {
    const m = herdrError(e);
    err(res, m.code, m.message);
  }
}

// GET /api/pane?pane_id=..&lines=..&source=.. — tail of a pane's scrollback.
async function handlePane(req, res, url) {
  const paneId = url.searchParams.get('pane_id');
  if (!paneId) throw { code: 'bad_request', message: '"pane_id" query parameter is required' };

  const source = url.searchParams.get('source') || 'recent_unwrapped';
  if (!READ_SOURCES.has(source)) {
    throw { code: 'bad_request', message: '"source" must be one of ' + [...READ_SOURCES].join(', ') };
  }
  const lines = clampLines(url.searchParams.get('lines'));

  const result = await hdr.request(
    'pane.read',
    { pane_id: paneId, source, lines, format: 'text' },
    { timeoutMs: DEFAULT_TIMEOUT_MS },
  );
  // Live herdr nests the payload under `read`; accept a flat shape too.
  const read = (result && result.read) ? result.read : (result || {});
  ok(res, {
    pane_id: read.pane_id || paneId,
    source: read.source || source,
    revision: read.revision === undefined ? null : read.revision,
    text: read.text || '',
  });
}

// POST /api/pane/prompt {pane_id, text, wait?, timeout_ms?}
async function handlePrompt(req, res, body) {
  const paneId = requireString(body, 'pane_id');
  if (typeof body.text !== 'string') {
    throw { code: 'bad_request', message: '"text" is required and must be a string' };
  }
  const useWait = body.wait === true;

  const params = { target: paneId, text: body.text };
  let socketTimeout = DEFAULT_TIMEOUT_MS;
  if (useWait) {
    const waitMs = Number.isFinite(Number(body.timeout_ms)) ? Number(body.timeout_ms) : WAIT_DEFAULT_MS;
    params.wait = { until: ['idle'], timeout_ms: waitMs };
    // At least the §4 hardening floor of 30 s, but never shorter than the
    // herdr-side wait the caller asked for.
    socketTimeout = Math.max(WAIT_TIMEOUT_MS, waitMs + 5000);
  }

  const result = await hdr.request('agent.prompt', params, { timeoutMs: socketTimeout });
  ok(res, { result });
}

// POST /api/pane/keys {pane_id, keys:["enter"] | "enter ctrl+c"}
async function handleKeys(req, res, body) {
  const paneId = requireString(body, 'pane_id');
  const keys = normalizeKeys(body.keys);

  const result = await hdr.request('pane.send_keys', { pane_id: paneId, keys }, { timeoutMs: DEFAULT_TIMEOUT_MS });
  ok(res, { result });
}

// ── v2 §2 endpoints ─────────────────────────────────────────────────────────

// POST /api/fanout {pane_ids:[...], text, wait?, timeout_ms?}
// One agent.prompt per pane, all issued concurrently, cap 20. One pane failing
// never aborts the batch — the failure is reported in its own results[] entry.
async function handleFanout(req, res, body) {
  const paneIds = requirePaneIds(body);
  if (typeof body.text !== 'string' || body.text.length === 0) {
    throw { code: 'bad_request', message: '"text" is required and must be a non-empty string' };
  }

  const common = { text: body.text };
  let socketTimeout = DEFAULT_TIMEOUT_MS;
  if (body.wait === true) {
    const waitMs = Number.isFinite(Number(body.timeout_ms)) ? Number(body.timeout_ms) : WAIT_DEFAULT_MS;
    common.wait = { until: ['idle'], timeout_ms: waitMs };
    socketTimeout = Math.max(WAIT_TIMEOUT_MS, waitMs + 5000);
  }

  const results = await fanOut(
    paneIds,
    (paneId) => Object.assign({ target: paneId }, common),
    'agent.prompt',
    socketTimeout,
  );
  ok(res, { results });
}

// POST /api/keys-broadcast {pane_ids:[...], keys:[...]}
// Same shape and concurrency rules as /api/fanout.
async function handleKeysBroadcast(req, res, body) {
  const paneIds = requirePaneIds(body);
  const keys = normalizeKeys(body.keys);

  const results = await fanOut(
    paneIds,
    (paneId) => ({ pane_id: paneId, keys }),
    'pane.send_keys',
    DEFAULT_TIMEOUT_MS,
  );
  ok(res, { results });
}

// POST /api/pane/text {pane_id, text}
async function handleText(req, res, body) {
  const paneId = requireString(body, 'pane_id');
  if (typeof body.text !== 'string') {
    throw { code: 'bad_request', message: '"text" is required and must be a string' };
  }
  const result = await hdr.request('pane.send_text', { pane_id: paneId, text: body.text }, { timeoutMs: DEFAULT_TIMEOUT_MS });
  ok(res, { result });
}

// POST /api/rpc {method, params} — raw passthrough for any herdr method.
async function handleRpc(req, res, body) {
  const method = requireString(body, 'method');
  const params = body.params === undefined || body.params === null ? {} : body.params;
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw { code: 'bad_request', message: '"params" must be an object' };
  }
  const explicit = Number(body.timeout_ms);
  const socketTimeout = Number.isFinite(explicit) && explicit > 0
    ? explicit
    : (params.wait ? Math.max(WAIT_TIMEOUT_MS, (Number(params.wait.timeout_ms) || 0) + 5000) : DEFAULT_TIMEOUT_MS);

  const result = await hdr.request(method, params, { timeoutMs: socketTimeout });
  ok(res, { result });
}

// POST /api/cli {argv:[...], timeout_ms?, cwd?} — spawn herdr with no shell.
/**
 * Run a binary with an argv array and capture its output.
 *
 * No shell is involved anywhere in this server: `shell:false` plus an argv array
 * means the OS receives the program and its arguments separately, so a value can
 * never be re-parsed as a command, a flag, or a second command. Nothing in this
 * file ever builds a command string or interpolates a caller value into one.
 *
 * Resolves (never rejects) with one of:
 *   {exit_code, stdout, stderr, truncated, duration_ms}  the process ran
 *   {timedOut:true, exit_code:null, stdout, stderr, ...} killed at timeoutMs
 *   {spawnError:Error}                                   it never started
 */
function runProc(bin, argv, timeoutMs, cwd, maxOutput) {
  const cap = maxOutput || CLI_MAX_OUTPUT;
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let done = false;
    let timer = null;

    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Object.assign({ duration_ms: Date.now() - started }, payload));
    };

    let child;
    try {
      // No shell, no interpolation: argv goes to the OS verbatim.
      child = cp.spawn(bin, argv, { shell: false, cwd, windowsHide: true });
    } catch (e) {
      return finish({ spawnError: e });
    }

    timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* already dead */ }
      finish({ timedOut: true, exit_code: null, stdout, stderr, truncated });
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (stdout.length < cap) stdout += d.toString('utf8');
      else truncated = true;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < cap) stderr += d.toString('utf8');
      else truncated = true;
    });
    child.on('error', (e) => finish({ spawnError: e }));
    child.on('close', (code) => finish({ exit_code: code, stdout, stderr, truncated }));
  });
}

function runCli(argv, timeoutMs, cwd) {
  return runProc(HERDR_BIN, argv, timeoutMs, cwd);
}

async function handleCli(req, res, body) {
  const argv = body.argv;
  if (!Array.isArray(argv)) {
    throw { code: 'bad_request', message: '"argv" is required and must be an array of strings' };
  }
  if (!argv.every((a) => typeof a === 'string')) {
    throw { code: 'bad_request', message: 'every entry of "argv" must be a string' };
  }
  const cwd = optionalString(body, 'cwd');
  const requested = Number(body.timeout_ms);
  const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : CLI_TIMEOUT_MS;

  const r = await runCli(argv, timeoutMs, cwd);

  if (r.spawnError) {
    return err(res, 'spawn_failed', 'could not run "' + HERDR_BIN + '": ' + r.spawnError.message);
  }
  if (r.timedOut) {
    return err(res, 'timeout', 'herdr ' + argv.join(' ') + ' exceeded ' + timeoutMs + ' ms', {
      stdout: r.stdout, stderr: r.stderr, duration_ms: r.duration_ms,
    });
  }
  // A non-zero exit code is still a successful run — the console displays it.
  ok(res, {
    exit_code: r.exit_code,
    stdout: r.stdout,
    stderr: r.stderr,
    duration_ms: r.duration_ms,
    ...(r.truncated ? { truncated: true } : {}),
  });
}

// ── §7.1 GET /api/git — read-only "what did the agents change" ──────────────
/*
 * ── READ-ONLY BY CONSTRUCTION ───────────────────────────────────────────────
 *
 * Every git invocation this server can ever make is one row of the literal table
 * below. The handler picks a row BY NAME (a fixed string in this file) and never
 * assembles a subcommand out of request data, so the set of subcommands that can
 * run is a finite list you can read off the screen — not a property to be argued
 * for. The only caller-influenced argument in the whole endpoint is one
 * repo-relative path, accepted by two rows that already end in `--`; it is
 * appended after that `--`, so git reads it as a pathspec even when it looks like
 * an option (verified: `file=--cached` yields an empty diff, not a cached one).
 *
 * There is no shell anywhere: argv arrays go to cp.spawn with shell:false, so a
 * caller value can never be re-parsed as a command or as a second flag.
 *
 * the local test suite parses the marked block and asserts BY ENUMERATION that (a)
 * the rows are exactly the seven §7.1 lists, (b) no row starts with or contains a
 * write subcommand, and (c) `mode=<anything not status|diff>` is refused, so the
 * table cannot be reached with a subcommand the table does not hold.
 *
 * §7.1 errata 2: `mode=diff` always reports `diff_available`, and a
 * `no_diff_reason` token when it is false — see step 4 of handleGit.
 */
/* BEGIN §7.1 SUBCOMMAND WHITELIST (parsed by the local test suite) */
const GIT_ARGV = {
  toplevel: ['rev-parse', '--show-toplevel'],
  branch: ['rev-parse', '--abbrev-ref', 'HEAD'],
  head: ['log', '-1', '--format=%h %s'],
  status: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
  numstat: ['diff', '--numstat', '-z'],
  numstatCached: ['diff', '--cached', '--numstat', '-z'],
  others: ['ls-files', '--others', '--exclude-standard', '-z'],
  diffFile: ['diff', '--no-color', '--unified=3', '--'],
  diffFileCached: ['diff', '--cached', '--no-color', '--unified=3', '--'],
};
/* END §7.1 SUBCOMMAND WHITELIST */

/** The only rows that accept a caller-supplied path — and only after their `--`. */
const GIT_FILE_ROWS = new Set(['diffFile', 'diffFileCached']);

const GIT_MAX_OUTPUT = 8 * 1024 * 1024;   // our own capture cap, honest `truncated`

/** Resolve a whitelist row to an argv array. Throws on a row that is not one. */
function gitArgv(key, file) {
  const row = GIT_ARGV[key];
  // Not a caller-reachable path: `key` is a literal in this file. A hit here is a
  // bug in the handler, so fail loudly rather than fall back to anything.
  if (!row) throw { code: 'internal', message: `git row "${key}" is not in the §7.1 whitelist` };
  if (file === undefined) return row;
  if (!GIT_FILE_ROWS.has(key)) throw { code: 'internal', message: `git row "${key}" cannot take an argument` };
  return row.concat([file]);
}

/** Run one whitelist row. Never rejects — see runProc. */
function readGit(key, cwd, file) {
  return runProc(GIT_BIN, gitArgv(key, file), GIT_TIMEOUT_MS, cwd, GIT_MAX_OUTPUT);
}

const trimErr = (s) => String(s || '').trim().slice(0, 500);
const oneLine = (s) => {
  const first = String(s || '').split('\n')[0].trim();
  return first || null;
};

/**
 * §7.1: the cwd comes from herdr's own pane record — the same snapshot
 * /api/snapshot serves — never from the client. An unknown pane is
 * pane_not_found; a pane herdr knows but has no cwd for cannot be answered, and
 * is a bad_request rather than a guess at a directory.
 */
async function paneCwd(paneId) {
  const result = await hdr.request('session.snapshot', {}, { timeoutMs: DEFAULT_TIMEOUT_MS });
  // herdr answers {snapshot:{…,panes:[…]}} — the very object /api/snapshot serves
  // (verified live: 12 panes, w4:p1 -> D:\Development\Example). The bare form is
  // accepted too, so this cannot break if herdr ever stops wrapping it.
  const snap = (result && (result.snapshot || result)) || {};
  const panes = Array.isArray(snap.panes) ? snap.panes : [];
  const pane = panes.find((p) => p && p.pane_id === paneId);
  if (!pane) throw { code: 'pane_not_found', message: `unknown pane_id "${paneId}"` };
  const cwd = typeof pane.cwd === 'string' ? pane.cwd.trim() : '';
  if (!cwd) throw { code: 'bad_request', message: `pane "${paneId}" has no cwd in the herdr snapshot` };
  return cwd;
}

/**
 * §7.1 `file`: repo-relative, and nothing else. Rejected here rather than
 * sanitised — a path we would have to rewrite is a caller bug, and `..` in
 * particular is exactly what would let the endpoint read outside the pane's repo.
 * Drawn path is returned with forward slashes (git accepts both on Windows).
 */
function validateRepoPath(raw) {
  if (typeof raw !== 'string' || raw === '') {
    throw { code: 'bad_request', message: '"file" must be a non-empty string' };
  }
  if (raw.includes('\0')) {
    throw { code: 'bad_request', message: '"file" must not contain a NUL byte' };
  }
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || p.startsWith('//') || /^[A-Za-z]:/.test(p)) {
    throw { code: 'bad_request', message: `"file" must be repo-relative, not absolute: ${raw}` };
  }
  if (p.split('/').includes('..')) {
    throw { code: 'bad_request', message: `"file" must stay inside the repository: ${raw}` };
  }
  return p;
}

/** §7.1 `max_lines`: default 400, clamped to 1..2000 (never rejected). */
function clampMaxLines(raw) {
  if (raw === null || raw === undefined || raw === '') return GIT_MAX_LINES_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return GIT_MAX_LINES_DEFAULT;
  return Math.min(GIT_MAX_LINES_CAP, Math.max(1, n));
}

/** Map a failed readProc onto §7.1's error vocabulary. */
async function gitFailure(r, what) {
  if (r.spawnError) {
    const missing = r.spawnError.code === 'ENOENT';
    if (missing) {
      // Node reports ENOENT both for "there is no such binary" and for a path that
      // exists but cannot be executed (a directory). Say which one it is.
      const st = await fsp.stat(GIT_BIN).catch(() => null);
      if (st && !st.isFile()) {
        return { code: 'git_failed', message: `"${GIT_BIN}" exists but is not an executable file` };
      }
    }
    return {
      code: missing ? 'git_missing' : 'git_failed',
      message: `${missing ? 'could not find' : 'could not run'} "${GIT_BIN}": ${r.spawnError.message}`,
    };
  }
  if (r.timedOut) {
    return { code: 'git_failed', message: `${GIT_BIN} ${what} exceeded ${GIT_TIMEOUT_MS} ms` };
  }
  return { code: 'git_failed', message: `${GIT_BIN} ${what} exited ${r.exit_code}: ${trimErr(r.stderr)}` };
}

// ── git -z parsers ──────────────────────────────────────────────────────────
// Formats verified against git itself while writing this (see _scratch/w1):
//   status --porcelain=v1 -z  " D del.txt\0" "M  keep.txt\0" "RM new\0old\0" "?? fresh\0"
//     -> XY, a space, the path; a rename delivers the ORIGINAL path as the next
//        record, with no XY prefix of its own.
//   diff --numstat -z          "0\t4\tdel.txt\0"   "2\t1\tkeep.txt\0"
//     -> added TAB deleted TAB path; a rename leaves the path field EMPTY and
//        follows with two more records: pre-image, then post-image.
//   '-' in either count means binary; the §7.1 schema has no binary flag, so it
//     counts as 0 (reported in NOTES, not silently guessed at).

function splitZ(stdout) {
  if (!stdout) return [];
  const recs = stdout.split('\0');
  if (recs.length && recs[recs.length - 1] === '') recs.pop();
  return recs;
}

function parsePorcelainZ(stdout) {
  const recs = splitZ(stdout);
  const entries = [];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    if (x === 'R' || x === 'C') i++; // the record that follows is the pre-image
    const p = rec.slice(3);
    if (!p) continue;
    const untracked = x === '?';
    entries.push({
      path: p,
      // One letter for the row: prefer the staged side, fall back to the worktree
      // side, and '?' for a file git is not tracking at all.
      status: untracked ? '?' : (x !== ' ' ? x : y),
      // An untracked file is neither staged nor unstaged — it is not in the index
      // at all, which is exactly what `untracked` says. §7.1 does not spell this
      // out; this is the reading that keeps staged/unstaged/untracked one badge
      // per row instead of counting a new file twice (the local test suite asserts
      // the invariant, so the choice is visible rather than incidental).
      staged: !untracked && x !== ' ',
      unstaged: !untracked && y !== ' ',
      untracked,
      added: 0,
      deleted: 0,
    });
  }
  return entries;
}

function parseNumstatZ(stdout) {
  const recs = splitZ(stdout);
  const map = new Map();
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    const f = rec.split('\t');
    if (f.length < 3) continue;
    const added = f[0] === '-' ? 0 : (Number.parseInt(f[0], 10) || 0);
    const deleted = f[1] === '-' ? 0 : (Number.parseInt(f[1], 10) || 0);
    let p = f.slice(2).join('\t');
    if (p === '') {           // rename: pre-image then post-image follow
      p = recs[i + 2] || '';
      i += 2;
    }
    if (!p) continue;
    const prev = map.get(p) || { added: 0, deleted: 0 };
    map.set(p, { added: prev.added + added, deleted: prev.deleted + deleted });
  }
  return map;
}

/**
 * Cut `text` to `max` lines, reporting honestly whether anything was dropped.
 * A cut diff is still a diff prefix (no partial last line) and its final newline
 * is preserved, so a caller can append "… truncated" safely.
 */
function sliceLines(text, max) {
  if (!text) return { text: '', truncated: false };
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= max) return { text: lines.join('\n') + '\n', truncated: false };
  return { text: lines.slice(0, max).join('\n') + '\n', truncated: true };
}

/** The empty-but-well-shaped body §7.1 wants for a cwd that is not a repo. */
function notARepoBody(paneId, cwd, message, extra) {
  return Object.assign(describedState(paneId, cwd, 'not_a_repo', message), extra || {});
}

/** The fields every "there is no repo view here" reply carries. */
function describedState(paneId, cwd, code, message) {
  return {
    pane_id: paneId,
    cwd: cwd === undefined ? null : cwd,
    is_repo: false,
    repo: null,
    files: [],
    totals: { changed: 0, staged: 0, unstaged: 0, untracked: 0, insertions: 0, deletions: 0 },
    truncated: false,
    error: { code, message },
  };
}

/**
 * §7.1 line 323: a git that cannot be run is a described state as well — it keeps
 * is_repo:false and the pane it was asked about, so a client can render §7.2's
 * banner ("never an empty list") from error.message alone, exactly as it does for
 * a cwd that is not a repo. The reply is still ok:false, like every other error
 * code in this API (pane_not_found, bad_request, herdr_error …).
 */
function gitFailureReply(res, paneId, cwd, f) {
  err(res, f.code, f.message, describedState(paneId, cwd, f.code, f.message));
}

async function handleGit(req, res, url) {
  const paneId = url.searchParams.get('pane_id');
  if (!paneId) {
    throw { code: 'bad_request', message: '"pane_id" query parameter is required, e.g. /api/git?pane_id=w4:p1' };
  }

  // Unknown modes are refused, not defaulted: 'commit', 'checkout', 'push' … all
  // land here, which is what keeps the subcommand whitelist a closed set.
  const mode = url.searchParams.get('mode');
  const effectiveMode = mode === null ? 'status' : mode;
  if (effectiveMode !== 'status' && effectiveMode !== 'diff') {
    throw {
      code: 'bad_request',
      message: `unknown "mode" ${JSON.stringify(mode)}; this endpoint supports "status" and "diff" only`,
    };
  }

  const fileParam = url.searchParams.get('file');
  if (fileParam !== null && effectiveMode !== 'diff') {
    throw { code: 'bad_request', message: '"file" is only meaningful with mode=diff' };
  }
  if (effectiveMode === 'diff' && (fileParam === null || fileParam === '')) {
    throw { code: 'bad_request', message: 'mode=diff requires a repo-relative "file"' };
  }
  const file = effectiveMode === 'diff' ? validateRepoPath(fileParam) : undefined;
  const maxLines = clampMaxLines(url.searchParams.get('max_lines'));

  // §7.1: the cwd is herdr's, never the client's.
  const cwd = await paneCwd(paneId);

  // A vanished cwd would make spawn fail with ENOENT — which must not be reported
  // as git_missing. Check it first so the message names the real problem.
  const cwdStat = await fsp.stat(cwd).catch(() => null);
  if (!cwdStat || !cwdStat.isDirectory()) {
    return gitFailureReply(res, paneId, cwd, {
      code: 'git_failed',
      message: `pane cwd is not a directory: ${cwd}`,
    });
  }

  // 1. Is it a repo at all? `rev-parse --show-toplevel` is git's own answer, and
  //    its stderr is the message §7.1 asks us to pass through.
  const top = await readGit('toplevel', cwd);
  if (top.spawnError || top.timedOut) {
    return gitFailureReply(res, paneId, cwd, await gitFailure(top, 'rev-parse --show-toplevel'));
  }
  if (top.exit_code !== 0) {
    return ok(res, notARepoBody(paneId, cwd, trimErr(top.stderr) || 'not a git repository'));
  }
  const toplevel = oneLine(top.stdout);
  if (!toplevel) {
    return gitFailureReply(res, paneId, cwd, {
      code: 'git_failed',
      message: `${GIT_BIN} rev-parse --show-toplevel printed no path`,
    });
  }

  // 2. Everything else runs with cwd = toplevel, so every path git prints is
  //    relative to the root the client is being shown. All seven reads go out
  //    concurrently: one round trip's wall clock, not seven.
  const [branchR, headR, statusR, numstatR, numstatCachedR, othersR] = await Promise.all([
    readGit('branch', toplevel),
    readGit('head', toplevel),
    readGit('status', toplevel),
    readGit('numstat', toplevel),
    readGit('numstatCached', toplevel),
    readGit('others', toplevel),
  ]);

  // status/numstat/ls-files cannot fail in a repo (an empty one exits 0 with no
  // output), so a failure here is real and is reported, not papered over.
  for (const [r, what] of [[statusR, 'status'], [numstatR, 'diff --numstat'], [numstatCachedR, 'diff --cached --numstat'], [othersR, 'ls-files --others']]) {
    if (r.spawnError || r.timedOut || r.exit_code !== 0) {
      return gitFailureReply(res, paneId, cwd, await gitFailure(r, what));
    }
  }
  // branch/head are allowed to be missing: a fresh `git init` has no HEAD yet
  // (exit 128, "does not have any commits yet"), which is a state, not an error.
  const repo = {
    toplevel,
    branch: branchR.exit_code === 0 ? oneLine(branchR.stdout) : null,
    head: headR.exit_code === 0 ? oneLine(headR.stdout) : null,
  };

  // 3. Merge status + ls-files into one row per path. -z is authoritative about
  //    untracked files; ls-files is used as the backstop so a file reported only
  //    there still appears (and so untracked paths are never double-counted).
  const files = parsePorcelainZ(statusR.stdout);
  const seen = new Map(files.map((e) => [e.path, e]));
  for (const p of splitZ(othersR.stdout)) {
    if (!p || seen.has(p)) continue;
    const entry = { path: p, status: '?', staged: false, unstaged: false, untracked: true, added: 0, deleted: 0 };
    seen.set(p, entry);
    files.push(entry);
  }

  // Line counts come from git's own numstat. A row that has worktree changes is
  // described by the unstaged pass, otherwise by the staged one — the same rule
  // the local test suite applies when it checks these numbers against git's output.
  const unstaged = parseNumstatZ(numstatR.stdout);
  const staged = parseNumstatZ(numstatCachedR.stdout);
  for (const e of files) {
    const counts = e.untracked ? null : (e.unstaged ? unstaged.get(e.path) : staged.get(e.path));
    // Untracked files have no diff in this whitelist (there is no `diff --no-index`
    // row): their counts are 0 until they are added to the index.
    e.added = counts ? counts.added : 0;
    e.deleted = counts ? counts.deleted : 0;
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const body = {
    pane_id: paneId,
    cwd,
    is_repo: true,
    repo,
    files,
    totals: {
      changed: files.length,
      staged: files.filter((f) => f.staged).length,
      unstaged: files.filter((f) => f.unstaged).length,
      untracked: files.filter((f) => f.untracked).length,
      insertions: files.reduce((n, f) => n + f.added, 0),
      deletions: files.reduce((n, f) => n + f.deleted, 0),
    },
    // In status mode this reports OUR capture cap (8 MiB of porcelain), never a
    // guess: the row set below this line is complete or this flag is true.
    truncated: !!statusR.truncated,
  };

  if (effectiveMode === 'status') return ok(res, body);

  // 4. mode=diff: one file, from the pass that actually holds its change — the
  //    index if the change is staged, the worktree if it is not. An empty diff is
  //    never returned bare: `diff_available:false` plus a `no_diff_reason` token
  //    says why (§7.1 errata 2), so the panel can explain the gap instead of
  //    showing nothing.
  const rowsForPath = files.filter((f) => f.path === file);
  const anyTracked = rowsForPath.some((f) => !f.untracked);
  const row = rowsForPath.length ? rowsForPath[rowsForPath.length - 1] : null;
  const useCached = !!row && row.staged && !row.unstaged;
  let r = await readGit(useCached ? 'diffFileCached' : 'diffFile', toplevel, file);
  if (r.spawnError || r.timedOut || r.exit_code !== 0) {
    return gitFailureReply(res, paneId, cwd, await gitFailure(r, `${useCached ? 'diff --cached' : 'diff'} -- ${file}`));
  }
  let sliced = sliceLines(r.stdout, maxLines);

  /*
   * An empty diff must mean "git has nothing to show for this path" — never "the
   * wrong pass was picked". A staged delete plus a same-named untracked file is
   * exactly that trap: git reports TWO rows for the path, the preferred pass is
   * the empty one (measured on Windows git 2.55: 0 bytes unstaged vs 138 staged),
   * and the panel would have shown nothing while git held a real deletion. Both
   * diff passes are whitelisted rows, so consulting the other one when the first
   * comes back empty costs a git call and adds no capability. It is only worth
   * asking when some row for the path is tracked — for an untracked file there is
   * nothing on the other side, and that case keeps its own token.
   */
  if (!sliced.text && anyTracked) {
    const other = await readGit(useCached ? 'diffFile' : 'diffFileCached', toplevel, file);
    if (!other.spawnError && !other.timedOut && other.exit_code === 0) {
      const alt = sliceLines(other.stdout, maxLines);
      if (alt.text) {
        r = other;
        sliced = alt;
      }
    }
  }

  // §7.1 line 320 + errata 2: diff mode adds `file`, `diff`, `truncated` and
  // `diff_available`, plus `no_diff_reason` when (and only when) it is false.
  const diffAvailable = sliced.text !== '';
  const out = Object.assign(body, {
    file,
    diff: sliced.text,
    truncated: sliced.truncated || r.truncated,
    diff_available: diffAvailable,
  });
  if (!diffAvailable) {
    // `untracked`: git cannot diff a file it is not tracking, and the whitelist
    //   has no `diff --no-index` row.
    // `no_change`: git produced no diff for this path in this cwd. Reproduced for
    //   an ignored path, a path that does not exist, a clean tracked file and a
    //   directory with no changes under it — the frozen whitelist cannot tell
    //   those apart (distinguishing them would need `check-ignore` or a plain
    //   `ls-files`, i.e. a new subcommand, or a stat outside git, i.e. a new read).
    out.no_diff_reason = (row && row.untracked && !anyTracked) ? 'untracked' : 'no_change';
  }
  ok(res, out);
}

// ── §8.2 GET /api/chat — the structured conversation view ───────────────────
/*
 * The pane's session is resolved HERE and never by the client: the address of a
 * conversation is a pane id, and everything else (which agent, which file or
 * database, which conversation inside it) comes from herdr's own records.
 *
 * Resolution order (§8.1):
 *   pane_id → agent.list → agent_session{agent, kind, source, value}
 *     claude → ~/.claude/projects/*\/<value>.jsonl, then the file's own `cwd`
 *              must equal the pane's cwd (a slug is not derivable from the cwd —
 *              measured `D--Development-Sample` vs `d--Development-Example` — so the
 *              file is FOUND by session id and PROVEN by cwd)
 *     hermes → messages WHERE session_id = value, read-only
 *     other  → unsupported_agent
 *
 * PARAMETERS (all optional except pane_id):
 *   since=<cursor>  walk forward from the cursor the previous reply returned
 *   limit=<n>       messages in this reply (default 400, max 2000)
 *   tail=1          the NEWEST `limit` messages instead, with the cursor at the
 *                   live end (round 7.1, DEFECT-9). Rejected together with
 *                   `since` — see the throw below for why.
 *   session_id=<id> round 7.6 (§9.5): bind THIS pane to a session the reader
 *                   chose from the candidates a previous reply listed. Refused
 *                   when the id is not one of them — a reader cannot invent one.
 *
 * ROUND 7.6 (§9, DEFECT-17): herdr's `agent_session.value` is now a HINT, not the
 * truth. A `/clear` in a hermes pane starts a new session and herdr keeps the old
 * value, so the view sat at the end of a session that could never grow again.
 * Every reply now says which session the pane's OWN TEXT (and, for claude, the
 * cwd's newest log) points at, where that came from (`session_detected_by`),
 * whether a change is being announced (`session_change`, exactly once), whether
 * it is worth trusting at all (`resolved` + `resolved_reason` + `candidates`),
 * whether the binding has gone stale (§9.4 `stale` + `stale_reason`) and whether
 * herdr's own record was corrected (`herdr_healed` + `heal_reason`).
 * The decision itself lives in src/chat/session.js; this file gathers the facts.
 */
const AGENT_LIST_TTL_MS = 5000;          // §8.1: a 5 s cache, never a call per poll

let agentListCache = { at: 0, agents: null };   // {at, agents} — last good answer
let agentListInflight = null;                   // single-flight: concurrent polls share one call

/**
 * `agent.list`, cached for AGENT_LIST_TTL_MS. The page polls this view; herdr
 * must not be asked on every poll. A failed call does not empty the cache — a
 * transient pipe error would otherwise turn a working view into "no session".
 */
async function agentList() {
  const now = Date.now();
  if (agentListCache.agents && now - agentListCache.at < AGENT_LIST_TTL_MS) {
    return { agents: agentListCache.agents, cached: true };
  }
  if (agentListInflight) return agentListInflight;
  agentListInflight = (async () => {
    try {
      const result = await hdr.request('agent.list', {}, { timeoutMs: DEFAULT_TIMEOUT_MS });
      const agents = Array.isArray(result && result.agents) ? result.agents : [];
      agentListCache = { at: Date.now(), agents };
      return { agents, cached: false };
    } catch (e) {
      if (agentListCache.agents) return { agents: agentListCache.agents, cached: true, stale: true };
      throw e;
    } finally {
      agentListInflight = null;
    }
  })();
  return agentListInflight;
}

/** Does herdr know this pane at all, and what cwd does it carry? Used to tell
 *  pane_not_found from a pane that exists but runs no agent (unsupported_agent),
 *  and to verify a claude session's project. The snapshot is cached for the same
 *  5 s as agent.list: this view polls, and herdr must not be asked per poll.
 *  §7.1's paneCwd() keeps its own fresh snapshot — nothing here changes it. */
let snapCache = { at: 0, panes: null };
let snapInflight = null;

async function paneInSnapshot(paneId) {
  const now = Date.now();
  if (!snapCache.panes || now - snapCache.at >= AGENT_LIST_TTL_MS) {
    if (!snapInflight) {
      snapInflight = (async () => {
        try {
          const result = await hdr.request('session.snapshot', {}, { timeoutMs: DEFAULT_TIMEOUT_MS });
          const snap = (result && (result.snapshot || result)) || {};
          const panes = Array.isArray(snap.panes) ? snap.panes : [];
          snapCache = { at: Date.now(), panes };
        } catch (e) {
          if (!snapCache.panes) throw e;
        } finally {
          snapInflight = null;
        }
      })();
    }
    await snapInflight;
  }
  const panes = (snapCache.panes || []);
  const pane = panes.find((p) => p && p.pane_id === paneId);
  if (!pane) return { exists: false };
  const cwd = typeof pane.cwd === 'string' ? pane.cwd.trim() : '';
  return { exists: true, cwd };
}

/**
 * `tail` is a flag, not a number: absent (or 0/false) means the forward read from
 * `since`; 1/true means the NEWEST messages (round 7.1, DEFECT-9). Anything else
 * is rejected, because a typo must never silently pick a direction.
 */
// ── §9 (round 7.6): gathering the facts the resolver decides on ─────────────
/*
 * Three reads feed src/chat/session.js, all of them cached for SESSION_CACHE_MS
 * because the page polls faster than a pane's text changes:
 *   paneTexts()      the pane's own text — on screen first, scrollback second
 *   storeSessions()  hermes: the `sessions` rows, filtered to the pane's cwd
 *   claudeLogs()     claude: the logs under the pane's cwd that PROVE that cwd
 * Everything is best-effort: a pane read that fails is `null` text, never an
 * exception, and never evidence that the pane moved (see session.js's tracker).
 *
 * Round 7.7 (§11.3, DEFECT-18) added the fourth: `liveSessionFor` itself is
 * single-flight and cached per pane+session for the same window, so the cold
 * resolution (the three reads above plus the candidate scan plus the heal) runs
 * once for a mount that asks twice — see the comment on it.
 */
const paneTextCache = new Map();        // pane_id -> {at, visible, recent, error}
const paneTextInflight = new Map();
const storeCache = new Map();           // db file -> {at, rows}
const claudeLogCache = new Map();       // cwd -> {at, candidates}
// §11.3 (round 7.7, DEFECT-18): the whole cold resolution for one pane+session is
// also computed once. Round 7.6 cached its three inputs; this caches the DECISION,
// which is what a mount that asks twice 16 ms apart was paying for twice.
const liveCache = new Map();            // key -> {at, value}
const liveInflight = new Map();         // key -> Promise (joined, never re-run)

// §13.12 item 1 (round 9.12): the two lanes a TAIL read can answer from without
// waiting for herdr, so that /api/chat has a bound a page-load burst cannot break.
//
// MEASURED, on this machine, for this route: the FILE side is not the problem. The
// tail scan reads at most 6.50 MB of source across all 132 sessions on the machine
// at limit=200, and its wall time is ≤ 26 ms (p50 8 ms) — including the 51.47 MB
// session (§13.12's scanprobe). Everything that can turn one request into seconds
// is herdr work inside §9's resolution: the pane read, the candidate scan, the
// store lookup and the repair WRITE, each queued behind whatever else herdr is
// doing — one /api/pane read costs 100–126 ms inside a page-load burst against
// 8–13 ms alone, and a page load fires six resolutions at once.
//
// So a tail read answers from the binding this process last READ and VERIFIED,
// re-checked HERE — the file must still be under the projects root and still carry
// the pane's cwd, two local reads and no herdr — while the resolver keeps running
// in the background (so herdr's record is still repaired and the next poll's
// memory is re-endorsed). That is lane 1, and it costs no herdr call at all.
//
// A pane this process has never read has no memory (and a restart has none for any
// pane), so a COLD read takes lane 2: the resolver gets SCAN_WAIT_MS to answer, and
// if it overruns, herdr's OWN record for the pane is verified locally (its file
// exists and carries the pane's cwd) and served with the overrun disclosed in
// `x-hd-session-scan: herdr-record` — the scan finishes behind it and re-endorses or
// corrects the binding for the next poll. Lane 2 is not a guess: it is the pane's
// own reported session, checked the same way §7.1 requires. A pane herdr records no
// session for, or whose record does not verify, keeps the resolving road (there is
// nothing to fall back to — the scan IS the answer there).
const SCAN_WAIT_MS = (() => {
  const raw = Number(process.env.CHAT_SCAN_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 900;
})();
const readMemory = new Map();           // pane_id -> {agent, session_id, file, cwd, working, live, fields, at}
/** §13.12 item 1's proof hook: makes §9's resolution take at least this long, so the
 *  bound lane 2 gives a tail read can be MEASURED against a scan as slow as the one
 *  seen on the PM's instance (5–9 s) without waiting for herdr to actually be slow.
 *  Unset (0) everywhere except a measurement run. */
const SCAN_DELAY_MS = (() => {
  const raw = Number(process.env.CHAT_SCAN_DELAY_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
})();
const READ_MEMORY_MAX = 256;

async function paneTexts(paneId) {
  const hit = paneTextCache.get(paneId);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) return hit;
  if (paneTextInflight.has(paneId)) return paneTextInflight.get(paneId);
  const job = (async () => {
    const out = { at: Date.now(), visible: null, recent: null, error: null };
    const want = [
      ['visible', chatSession.LIMITS.PANE_LINES_VISIBLE, 'visible'],
      ['recent_unwrapped', chatSession.LIMITS.PANE_LINES_RECENT, 'recent'],
    ];
    for (const [source, lines, key] of want) {
      try {
        const result = await hdr.request(
          'pane.read',
          { pane_id: paneId, source, lines, format: 'text', strip_ansi: true },
          { timeoutMs: DEFAULT_TIMEOUT_MS },
        );
        const read = (result && result.read) ? result.read : (result || {});
        out[key] = typeof read.text === 'string' ? read.text : '';
      } catch (e) {
        out[key] = null;
        out.error = out.error || (e && e.code) || 'read_failed';
      }
    }
    paneTextCache.set(paneId, out);
    return out;
  })();
  paneTextInflight.set(paneId, job);
  try {
    return await job;
  } finally {
    paneTextInflight.delete(paneId);
  }
}

/** hermes `sessions` rows, cached. Failure is an empty list: a store this server
 *  cannot read cannot be a signal, and it must not take /api/chat down. */
async function storeSessions() {
  const file = chatHermes.dbPath();
  const hit = storeCache.get(file);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) return hit.rows;
  let rows = [];
  try {
    rows = chatHermes.recentSessions(file, 40);
  } catch (e) {
    rows = [];
  }
  storeCache.set(file, { at: Date.now(), rows });
  return rows;
}

/** claude logs under a cwd, newest first, cached. */
async function claudeLogs(cwd) {
  const hit = claudeLogCache.get(cwd);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) return hit.candidates;
  let candidates = [];
  try {
    const found = await chatClaude.candidatesForCwd(cwd, {
      max: chatSession.LIMITS.CAND_MAX,
      windowMs: chatSession.LIMITS.CAND_WINDOW_MS,
    });
    candidates = found.candidates;
  } catch (e) {
    candidates = [];
  }
  claudeLogCache.set(cwd, { at: Date.now(), candidates });
  return candidates;
}

/** {session id -> the OTHER pane herdr binds it to}. §9.5: a session another pane
 *  owns must never be adopted by this one, and the fact is disclosed, not hidden. */
function claimedByOtherPanes(agents, paneId) {
  const claimed = {};
  for (const a of agents || []) {
    if (!a || a.pane_id === paneId) continue;
    const v = a.agent_session && a.agent_session.value;
    if (v != null && String(v)) claimed[String(v)] = a.pane_id;
  }
  return claimed;
}

/** §9's resolution, and the fields every reply carries about it. */
async function liveSessionFor(paneId, entry, agent, herdrSessionId, agents, readerPick, mark) {
  // §11.3: one cold resolution per pane+session, never one per request. The key
  // carries everything that decides the answer (the pane, the agent, herdr's own
  // record, the reader's pick), so a change in any of them — a healed record, an
  // agent restart, a different `?session_id=` — is a different resolution and
  // cannot be served from this cache. The TTL is SESSION_CACHE_MS (default 2000 ms,
  // the same knob round 7.6 already uses for the pane reads and the store lookup):
  // the resolution cannot be fresher than its own inputs, so caching it for the
  // same window adds no staleness that was not already there, while the scan (which
  // walks every project directory) stops running twice for one poll.
  const key = [paneId, agent || '', herdrSessionId || '', readerPick || ''].join('\u0000');
  const hit = liveCache.get(key);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) {
    return Object.assign({}, hit.value, { scan: 'cached' });
  }
  const running = liveInflight.get(key);
  if (running) {
    // A request that arrives while the scan is in flight JOINS it: both answer
    // from the same work, and the second one says so instead of hiding the wait.
    return Object.assign({}, await running, { scan: 'joined' });
  }
  const job = resolveLiveSession(paneId, entry, agent, herdrSessionId, agents, readerPick, mark);
  liveInflight.set(key, job);
  try {
    const value = await job;
    liveCache.set(key, { at: Date.now(), value });
    if (liveCache.size > 64) {
      const now = Date.now();
      for (const [k, v] of liveCache) if (now - v.at >= SESSION_CACHE_MS) liveCache.delete(k);
    }
    return Object.assign({}, value, { scan: 'fresh' });
  } finally {
    liveInflight.delete(key);
  }
}

/** The cold path itself: the pane read, the store/log lookup, the resolver and
 *  the §9.3 heal. Only `liveSessionFor` calls this, so the sharing above is the
 *  only way in. */
async function resolveLiveSession(paneId, entry, agent, herdrSessionId, agents, readerPick, mark) {
  if (SCAN_DELAY_MS) await new Promise((r) => setTimeout(r, SCAN_DELAY_MS));
  const cwd = typeof entry.cwd === 'string' ? entry.cwd.trim() : '';
  const inp = {
    agent,
    herdr_session_id: herdrSessionId || null,
    now: Date.now(),
    claimed: claimedByOtherPanes(agents, paneId),
    reader_pick: readerPick,
  };
  const texts = await paneTexts(paneId);
  if (mark) mark('paneTexts');
  inp.pane_text_visible = texts.visible;
  inp.pane_text_recent = texts.recent;

  if (agent === 'hermes') {
    const rows = await storeSessions();
    inp.store_sessions = rows.filter((r) => chatSession.sameCwd(r.cwd, cwd));
    // §9.1's corroboration: is the id the pane names known to the store at all?
    // Only asked when the pane names exactly one, which is when it can matter.
    const seen = new Set();
    for (const t of [texts.visible, texts.recent]) {
      for (const id of chatSession.paneSessionFields(t).distinct) seen.add(id);
    }
    if (seen.size === 1) {
      const only = [...seen][0];
      try {
        inp.store_known_ids = { [only]: chatHermes.sessionKnown(chatHermes.dbPath(), only) };
      } catch (e) { inp.store_known_ids = null; }
    }
  } else if (agent === 'claude' && cwd) {
    inp.candidates = await claudeLogs(cwd);
    if (mark) mark('claudeLogs');
    const boundFile = chatClaude.findSessionFile(herdrSessionId);
    if (boundFile) {
      const st = await fsp.stat(boundFile).catch(() => null);
      inp.bound_mtime_ms = st && st.isFile() ? st.mtimeMs : null;
    } else {
      inp.bound_mtime_ms = null;
    }
  }

  const res = chatSession.resolvePaneSession(inp);
  if (mark) mark('resolve');
  const heal = await healHerdr(paneId, agent, herdrSessionId, res, entry);
  if (mark) mark('heal');
  return { res, heal, texts, cwd };
}

/**
 * §9.3 — report the resolved session back to herdr so its stale record is
 * corrected for every other consumer. Refuses silently (with a reason) whenever
 * the resolution is not confident; `healedPanes` keeps one report per (pane,
 * session) so a 5 s herdr cache cannot turn into a report per poll.
 *
 * `source` is the pane's own `agent_session.source` (herdr's vocabulary, e.g.
 * `herdr:hermes`) rather than a name of ours: the value we are correcting is
 * herdr's record of what the AGENT reported, and every consumer of that record
 * keys on that source. We are not inventing a session — only relaying the one
 * the pane itself states.
 *
 * MEASURED (round 7.6, throwaway hermes pane, `agent.start`ed by herdr and
 * `/clear`ed by me) — two facts that decide the shape of this function:
 *   1. A report under a source of our own (`herdr-dash:hermes`) is ACCEPTED and
 *      then never exposed: `agent.list` kept reporting no session at all, while
 *      the same report under `herdr:hermes` appeared immediately. So when herdr
 *      has no record to copy the source from, the fallback is the source herdr
 *      itself uses for that agent.
 *   2. herdr's session record is WRITE-ONCE per (pane, source): the first report
 *      wins and every later one is accepted (`{"type":"ok"}`) and ignored. Tried
 *      against a live pane that already had a value: `seq` 1 / 2 / 1000 / 999999999,
 *      `session_start_source:"clear"`, `agent_session_id:null` (to clear first),
 *      and the lifecycle `pane.report_agent` with the new id — the published value
 *      never moved, while the same call on a pane herdr had NO record for landed
 *      at once.
 * So a heal can fill a missing record but cannot correct a stale one, and this
 * function therefore does not ASSUME its report took effect: it re-reads
 * `agent.list` and reports what herdr publishes now. `herdr_healed: true` is a
 * verified claim ("herdr now publishes the id this reply serves"), never just
 * "the call returned ok".
 */
async function healHerdr(paneId, agent, herdrSessionId, res, entry) {
  const out = { herdr_healed: false, heal_reason: null };
  const id = res && res.session_id ? String(res.session_id) : '';
  if (!res || !res.resolved || !id) {
    out.heal_reason = `not reported: ${(res && res.reason) || 'no session could be resolved'}`;
    return out;
  }
  if (id === herdrSessionId) {
    out.herdr_healed = true;
    out.heal_reason = 'herdr already records this session';
    return out;
  }
  const done = healedPanes.get(paneId);
  if (done && done.id === id) {
    out.herdr_healed = done.herdr_healed;
    out.heal_reason = done.heal_reason;
    return out;
  }
  const source = (entry.agent_session && typeof entry.agent_session.source === 'string' && entry.agent_session.source)
    ? entry.agent_session.source
    : `herdr:${agent}`;
  try {
    await hdr.request(
      'pane.report_agent_session',
      { pane_id: paneId, source, agent, agent_session_id: id },
      { timeoutMs: DEFAULT_TIMEOUT_MS },
    );
  } catch (e) {
    out.heal_reason = `not reported: herdr refused it (${(e && e.code) || 'error'})`;
    healedPanes.set(paneId, { id, herdr_healed: false, heal_reason: out.heal_reason });
    return out;
  }
  // Verification, because the call returning ok proves nothing about the record.
  agentListCache.at = 0;                // the 5 s cache is now knowingly stale
  storeCache.clear();
  let published = null;
  let readBack = null;
  try {
    const fresh = await agentList();
    const mine = (fresh.agents || []).find((a) => a && a.pane_id === paneId);
    published = mine && mine.agent_session && mine.agent_session.value != null ? String(mine.agent_session.value) : null;
    readBack = true;
  } catch (e) {
    readBack = false;
  }
  if (readBack && published === id) {
    out.herdr_healed = true;
    out.heal_reason = `herdr now publishes this session (source ${source}, was ${herdrSessionId || 'nothing'})`;
  } else if (readBack) {
    out.herdr_healed = false;
    out.heal_reason = `herdr accepted the report and still publishes ${published || 'no session'} (source ${source}) — its session record is write-once per (pane, source), so this view is corrected while herdr's record is not`;
  } else {
    out.herdr_healed = false;
    out.heal_reason = `reported to herdr (source ${source}, was ${herdrSessionId || 'nothing'}) but the read-back failed, so the report is unverified`;
  }
  healedPanes.set(paneId, { id, herdr_healed: out.herdr_healed, heal_reason: out.heal_reason });
  return out;
}

/** §9's fields, as every reply (success or error) carries them. */
function sessionFields(live) {
  const res = (live && live.res) || {};
  const heal = (live && live.heal) || {};
  return {
    session_id: res.session_id || null,
    session_detected_by: res.detected_by || null,
    session_change: null,
    session_candidates: res.candidates || [],
    session_note: res.note || null,
    resolved: !!res.resolved,
    resolved_reason: res.resolved ? null : (res.reason || 'no_signal'),
    stale: false,
    stale_reason: null,
    herdr_healed: !!heal.herdr_healed,
    heal_reason: heal.heal_reason || null,
  };
}

function parseTail(raw) {
  if (raw === null || raw === undefined || raw === '' || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  throw { code: 'bad_request', message: `"tail" must be 1 or 0, got ${JSON.stringify(raw)}` };
}

/** The §8.2 reply, built in one place: the frozen keys, plus the counters this
 *  round added (a merged result and a suppressed blank row both have to stay
 *  visible — see chat/common.js's accounting note). */
function chatReply(res, base, source, win, tail, since) {
  return ok(res, Object.assign(base, {
    source,
    cursor: win.cursor,
    messages: win.messages,
    truncated: win.truncated,
    skipped: win.skipped,
    unknown_records: win.unknown,
    records_with_messages: win.emittedRecords,
    merged_records: win.merged,
    empty_records: win.empty,
    no_messages_yet: win.records === 0 && win.messages.length === 0 && (tail || since === 0),
  }));
}

/** §13.12: where a /api/chat request spends its time, off unless HD_CHAT_TIMING=1.
 *  A phase list, not a single total: the route's cost is a herdr round-trip, a
 *  session binding, a file identity check and a tail read, and only a per-phase
 *  mark says which one a slow reply actually paid for. */
const CHAT_TIMING = process.env.HD_CHAT_TIMING === '1' || process.argv.includes('--chat-timing');
if (CHAT_TIMING) console.log('[hd-chat-timing] per-phase timing for /api/chat is on');
function chatClock(paneId) {
  const t0 = process.hrtime.bigint();
  const marks = [];
  const at = (name) => marks.push([name, Number(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2)]);
  at('start');
  return {
    at,
    done(extra) {
      const total = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log('[hd-chat-timing] ' + JSON.stringify(Object.assign({
        time: new Date().toISOString(), pane_id: paneId, total_ms: Number(total.toFixed(1)), phases: marks,
      }, extra || {})));
    },
  };
}

/**
 * §13.12 item 1 — remember the binding a successful claude reply was built from.
 * `live` is the resolver's own answer (or the reply path's), so this only ever
 * stores a binding §9 has already produced — the memory cannot invent one. A
 * resolution that did not resolve REMOVES the memory: a binding the resolver
 * refuses must not be served out of a cache.
 */
function rememberBinding(paneId, agent, entry, live, fileKnown) {
  const res = (live && live.res) || {};
  const sid = res.session_id ? String(res.session_id) : '';
  if (!res.resolved || !sid) { readMemory.delete(paneId); return null; }
  const file = fileKnown || (agent === 'claude' ? chatClaude.findSessionFile(sid) : null);
  const mem = {
    agent,
    session_id: sid,
    file,
    cwd: (live && live.cwd) || (entry && entry.cwd) || '',
    working: { working: !!(entry && entry.agent_status === 'working') },
    live,
    fields: sessionFields(live),
    at: Date.now(),
  };
  readMemory.set(paneId, mem);
  if (readMemory.size > READ_MEMORY_MAX) {
    let oldest = null;
    for (const [k, v] of readMemory) if (!oldest || v.at < oldest[1].at) oldest = [k, v];
    if (oldest) readMemory.delete(oldest[0]);
  }
  return mem;
}

/** The scan is allowed SCAN_WAIT_MS to answer a tail read; `SCAN_TIMEOUT` comes back
 *  when it did not. The promise stays handled either way (its rejection is
 *  delivered to the reject handler below), so losing the race cannot raise an
 *  unhandled rejection. */
const SCAN_TIMEOUT = Symbol('scan-timeout');
/** What a lane that has already SENT its reply returns. The reply value itself is
 *  `undefined` (`ok()`/`sendJson()` return nothing), so a lane cannot hand it back —
 *  and a caller that tested it would run a second reply behind the first. */
const SERVED = true;
function raceDeadline(p, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(SCAN_TIMEOUT), ms);
    if (timer.unref) timer.unref();
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * The resolving road still RUNS on every tail request — in the background when a
 * lane answered — because it is what keeps herdr's record honest (§9.3's repair)
 * and what makes the next poll's memory re-endorsed rather than older and older.
 * Its failure is logged, not thrown: nobody is waiting for it.
 */
function refreshBinding(paneId, agent, entry, herdrSessionId, agents) {
  const job = liveSessionFor(paneId, entry, agent, herdrSessionId, agents, null, null);
  job.then(
    (live) => { rememberBinding(paneId, agent, entry, live); },
    (e) => {
      // The pane is gone (or herdr refused): the memory must not outlive it.
      readMemory.delete(paneId);
      console.log('[hd-chat] ' + JSON.stringify({
        event: 'chat_background_scan_failed', pane_id: paneId, agent,
        error: String((e && e.message) || e),
      }));
    },
  );
  return job;
}

/**
 * Lane 1 answered without asking herdr anything, so the background scan has to
 * fetch herdr's record itself — in the background, where its cost (one
 * `agent.list`, served from the 5 s cache a page load has already filled) cannot
 * be felt. Two facts end the memory here rather than in the scan: a pane herdr no
 * longer knows, and a pane whose agent is no longer claude — serving either would
 * be a binding the pane has moved on from, and neither can be corrected by a scan
 * that never runs.
 */
function refreshFromHerdr(paneId) {
  agentList().then(
    ({ agents }) => {
      const entry = agents.find((a) => a && a.pane_id === paneId);
      if (!entry) { readMemory.delete(paneId); return; }
      const session = entry.agent_session;
      const agent = String((session && session.agent) || entry.agent || '');
      if (agent !== 'claude') { readMemory.delete(paneId); return; }
      refreshBinding(paneId, agent, entry, session && session.value != null ? String(session.value) : '', agents);
    },
    (e) => {
      console.log('[hd-chat] ' + JSON.stringify({
        event: 'chat_background_agent_list_failed', pane_id: paneId, error: String((e && e.message) || e),
      }));
    },
  );
}

/**
 * §13.12 item 1, lane 1 — the BOUNDED tail road: no herdr call at all, so nothing
 * here can queue behind a busy herdr or behind §9's repair write. The memory is
 * only usable when the local filesystem still agrees with it (the file is still
 * under the projects root, and one of its own records still carries the pane's
 * cwd), which is the identity check §7.1 already requires — the difference is only
 * WHERE the session id came from (this process's own last, verified read).
 *
 * Returns the reply, or null when there is no memory for this pane or the local
 * check failed. `null` means: take the resolving road, never guess.
 */
async function replyFromMemory(res, paneId, limit, mark, clk) {
  const mem = readMemory.get(paneId);
  if (!mem || mem.agent !== 'claude' || !mem.session_id) return null;
  const file = chatClaude.findSessionFile(mem.session_id);
  if (mark) mark('findSessionFile');
  if (!file) { readMemory.delete(paneId); return null; }
  const identity = await chatClaude.verifyCwd(file, mem.cwd);
  if (mark) mark('verifyCwd');
  if (!identity.ok) { readMemory.delete(paneId); return null; }
  const win = await chatClaude.readTail(file, limit, mem.working);
  if (mark) mark('readTail');
  const sessionId = mem.session_id;
  const base = Object.assign({ pane_id: paneId, agent: mem.agent }, mem.fields);
  const live = mem.live || { res: {}, texts: {}, cwd: mem.cwd };
  Object.assign(base, observeBinding(paneId, sessionId, live, win));
  const age = Date.now() - mem.at;
  res.setHeader('x-hd-session-scan', 'remembered');
  res.setHeader('x-hd-session-age-ms', String(age));
  console.log('[hd-chat] ' + JSON.stringify({
    event: 'chat_read_remembered', pane_id: paneId, session_id: sessionId,
    age_ms: age, bytes: win.tailBytes, messages: win.messages.length,
  }));
  chatReply(res, base, { kind: chatClaude.SOURCE_KIND, session_id: sessionId, path: file }, win, true, 0);
  if (clk) clk.done({ lane: 'remembered', scan: 'remembered', age_ms: age, messages: win.messages.length, tail_bytes: win.tailBytes, file_size: win.eof });
  // `SERVED`, not the reply: `ok()`/`sendJson()` returns nothing, so the only thing
  // a caller can test is that this lane answered — and a caller that tests the
  // REPLY would fall through and run the resolving road behind a reply already sent.
  return SERVED;
}

/**
 * §13.12 item 1, lane 2 — the overrun road. Only reached when the resolver did NOT
 * answer within SCAN_WAIT_MS and this process has no memory for the pane, so the
 * answer is herdr's OWN record, verified locally exactly as §7.1 requires (its file
 * exists under the projects root and one of its own records carries the pane's
 * cwd). Nothing is guessed: this is the same binding `resolvePaneSession` falls
 * back to, served without waiting for the candidate weighing that is still running.
 * Returns the reply, or null when herdr's record cannot be verified — in which case
 * the caller must wait for the scan, because the scan IS the answer for that pane.
 */
async function replyFromHerdrRecord(res, paneId, agent, entry, herdrSessionId, limit, scanMs, mark, clk) {
  if (!herdrSessionId) return null;
  const cwd = typeof entry.cwd === 'string' ? entry.cwd.trim() : '';
  if (!cwd) return null;
  const file = chatClaude.findSessionFile(herdrSessionId);
  if (mark) mark('findSessionFile');
  if (!file) return null;
  const identity = await chatClaude.verifyCwd(file, cwd);
  if (mark) mark('verifyCwd');
  if (!identity.ok) return null;
  const working = { working: entry.agent_status === 'working' };
  const win = await chatClaude.readTail(file, limit, working);
  if (mark) mark('readTail');
  const live = {
    res: {
      resolved: true, session_id: herdrSessionId, detected_by: chatSession.SIGNALS.HERDR,
      corroborated: false, reason: null, candidates: [],
      note: `herdr's own record for this pane (its file exists and carries the pane's cwd); the pane scan has been running ${scanMs} ms and is still going`,
    },
    texts: {},
    // Honest, not `null`: the heal has not been decided yet — the scan that decides
    // it (and reports the session to herdr when it disagrees) is still running, and
    // the next poll's fields carry its verdict.
    heal: { herdr_healed: false, heal_reason: 'not decided yet — the pane scan is still running (see x-hd-session-scan)' },
    cwd,
  };
  const base = Object.assign({ pane_id: paneId, agent }, sessionFields(live));
  Object.assign(base, observeBinding(paneId, herdrSessionId, live, win));
  res.setHeader('x-hd-session-scan', 'herdr-record');
  res.setHeader('x-hd-session-scan-ms', String(scanMs));
  console.log('[hd-chat] ' + JSON.stringify({
    event: 'chat_read_herdr_record', pane_id: paneId, session_id: herdrSessionId,
    scan_ms: scanMs, bytes: win.tailBytes, messages: win.messages.length,
  }));
  chatReply(res, base, { kind: chatClaude.SOURCE_KIND, session_id: herdrSessionId, path: file }, win, true, 0);
  if (clk) clk.done({ lane: 'herdr-record', scan: 'herdr-record', scan_ms: scanMs, messages: win.messages.length, tail_bytes: win.tailBytes, file_size: win.eof });
  return SERVED;
}

async function handleChat(req, res, url) {
  const clk = CHAT_TIMING ? chatClock(url.searchParams.get('pane_id')) : null;
  const mark = clk ? clk.at : () => {};
  const paneId = url.searchParams.get('pane_id');
  if (!paneId) {
    throw { code: 'bad_request', message: '"pane_id" query parameter is required, e.g. /api/chat?pane_id=w6:p2' };
  }
  const sinceRaw = url.searchParams.get('since');
  const since = chatCommon.parseCount(sinceRaw, 0);
  const limit = chatCommon.parseCount(url.searchParams.get('limit'), chatCommon.LIMITS.LIMIT_DEFAULT, chatCommon.LIMITS.LIMIT_MAX);
  const tail = parseTail(url.searchParams.get('tail'));
  if (tail && sinceRaw !== null && sinceRaw !== '') {
    // Decided, not left implicit: `since` is a cursor into the history and `tail`
    // addresses the live end, so combining them has no honest meaning. A caller
    // that wants history after a tail uses the `cursor` the tail reply returns.
    throw {
      code: 'bad_request',
      message: '"since" and "tail=1" cannot be combined — "since" walks forward from a cursor, "tail=1" starts from the end of the session; poll forward with the cursor the tail reply returns instead',
    };
  }

  const readerPick = url.searchParams.get('session_id');

  // ── §13.12 item 1, lane 1: the bounded tail road ────────────────────────────
  // A TAIL read with a memory for this pane is answered HERE, before the first
  // herdr call, so no page-load burst can queue it behind anything. The resolving
  // road is started behind the reply (see refreshFromHerdr): §9.3's repair still
  // runs, herdr's record is still corrected, and the memory is re-endorsed.
  // A reader pick is never served from memory — the pick is the reader's own
  // binding and has to be checked against the pane's candidates below.
  if (tail && !readerPick) {
    const remembered = await replyFromMemory(res, paneId, limit, mark, clk);
    if (remembered) { refreshFromHerdr(paneId); return remembered; }
  }

  // 1. herdr's own record of which agent runs in this pane.
  const { agents } = await agentList();
  mark('agentList');
  const entry = agents.find((a) => a && a.pane_id === paneId);
  if (!entry) {
    const known = await paneInSnapshot(paneId);
    if (!known.exists) {
      throw { code: 'pane_not_found', message: `unknown pane_id "${paneId}"` };
    }
    throw {
      code: 'unsupported_agent',
      message: `pane "${paneId}" is not running an agent (agent.list has no entry for it) — the raw terminal view stays available`,
    };
  }

  const session = entry.agent_session;
  const agent = String((session && session.agent) || entry.agent || '');
  const herdrSessionId = session && session.value != null ? String(session.value) : '';
  if (agent !== 'claude' && agent !== 'hermes') {
    throw {
      code: 'unsupported_agent',
      message: `agent "${agent}" has no structured log this server can read — the raw terminal view stays available`,
    };
  }

  // Round 7.6 (§9) — the pane's LIVE session, decided from the pane itself. From
  // here on `sessionId` is the resolved one: everything below (the file, the
  // cursor, the rows) follows the binding this reply announces.
  //
  // §13.12 item 1, lane 2: a claude TAIL read that this process has no memory for
  // (a cold process, or a memory the local check rejected) gives the scan
  // SCAN_WAIT_MS. If it overruns, herdr's own record answers — verified locally —
  // and the scan finishes behind the reply instead of in front of it. A window
  // read, a reader pick and every hermes pane keep the resolving road below.
  let live = null;
  if (tail && agent === 'claude' && !readerPick) {
    const job = liveSessionFor(paneId, entry, agent, herdrSessionId, agents, null, mark);
    const raced = await raceDeadline(job, SCAN_WAIT_MS);
    if (raced === SCAN_TIMEOUT) {
      job.then(
        (v) => { rememberBinding(paneId, agent, entry, v); },
        (e) => { readMemory.delete(paneId); console.log('[hd-chat] ' + JSON.stringify({
          event: 'chat_background_scan_failed', pane_id: paneId, agent, error: String((e && e.message) || e),
        })); },
      );
      const served = await replyFromHerdrRecord(res, paneId, agent, entry, herdrSessionId, limit, SCAN_WAIT_MS, mark, clk);
      if (served) return served;
      // herdr's record does not verify for this pane: nothing may be guessed, so
      // the scan IS the answer and this request waits for it (the pre-§13.12 road).
      live = Object.assign({}, await job, { scan: 'fresh' });
    } else {
      live = raced;
    }
  } else {
    live = await liveSessionFor(paneId, entry, agent, herdrSessionId, agents, readerPick, mark);
  }
  mark('liveSession');
  // §11.3's diagnostic, as a response header rather than a JSON field: §8.2's key
  // set is frozen (the local test suite asserts it exactly), and this says which of the
  // three ways the resolution was obtained — `fresh` (this request ran the cold
  // scan), `joined` (it shared a scan already in flight) or `cached` (a scan within
  // the last CHAT_SESSION_CACHE_MS). The client ignores it; a test can assert that
  // two requests 16 ms apart ran ONE scan.
  res.setHeader('x-hd-session-scan', live.scan || 'fresh');
  const sessionId = live.res.session_id ? String(live.res.session_id) : '';
  const fields = sessionFields(live);
  if (!live.res.resolved || !sessionId) {
    const listed = (fields.session_candidates || []).map((c) => c.id);
    const extra = Object.assign({}, fields, { pane_id: paneId, agent });
    if (live.res.reason === 'pick_not_a_candidate') {
      throw {
        code: 'bad_request',
        message: `"session_id"=${readerPick} is not one of pane "${paneId}"'s candidates (${listed.join(', ') || 'none listed'}) — a session the pane never named cannot be bound`,
        extra,
      };
    }
    if (!herdrSessionId && !listed.length) {
      throw {
        code: 'unsupported_agent',
        message: `pane "${paneId}" runs agent "${agent || 'unknown'}" with no session id anywhere — herdr records none (kind ${JSON.stringify(session && session.kind)}) and the pane names none — the raw terminal view stays available`,
        extra,
      };
    }
    throw {
      code: 'session_ambiguous',
      message: `pane "${paneId}" cannot be bound to one session: ${live.res.note || live.res.reason} — refusing to guess; candidates: ${listed.join(', ') || 'none'}${herdrSessionId ? ` (herdr still records ${herdrSessionId})` : ''}`,
      extra,
    };
  }

  // Round 7.3 — the pane's own liveness, the one fact a log can never carry: no
  // record says whether the agent is still generating. herdr's `agent_status` is
  // that signal ("working" is the only value meaning a turn is in flight); the
  // readers use it only to tell a genuinely-awaited pending card from one whose
  // result this reply simply does not contain — see markPendingReasons.
  const working = { working: entry.agent_status === 'working' };

  const base = Object.assign({ pane_id: paneId, agent }, fields);

  if (agent === 'claude') {
    const file = chatClaude.findSessionFile(sessionId);
    mark('findSessionFile');
    if (!file) {
      throw {
        code: 'session_file_missing',
        message: `no session file "${sessionId}.jsonl" under ${chatClaude.projectsRoot()}`,
        extra: Object.assign({}, fields, { pane_id: paneId, agent }),
      };
    }
    // The pane's cwd is herdr's, never the client's (same rule as §7.1).
    const known = await paneInSnapshot(paneId);
    mark('paneSnapshot');
    if (!known.exists || !known.cwd) {
      throw { code: 'pane_not_found', message: `pane "${paneId}" has no cwd in the herdr snapshot` };
    }
    const identity = await chatClaude.verifyCwd(file, known.cwd);
    mark('verifyCwd');
    if (!identity.ok && identity.reason === 'mismatch') {
      throw {
        code: 'session_cwd_mismatch',
        message: `session ${sessionId} belongs to ${identity.found}, not to pane ${paneId}'s cwd ${known.cwd}`,
        extra: Object.assign({}, fields, { pane_id: paneId, agent }),
      };
    }
    if (!identity.ok && identity.reason === 'unverifiable') {
      throw {
        code: 'session_cwd_mismatch',
        message: `session ${sessionId} could not be verified against pane ${paneId}'s cwd ${known.cwd} (no record in the file carries a cwd) — refusing to show it`,
        extra: Object.assign({}, fields, { pane_id: paneId, agent }),
      };
    }

    const win = tail
      ? await chatClaude.readTail(file, limit, working)
      : await chatClaude.readWindow(file, since, limit, working);
    mark('readTail');
    Object.assign(base, observeBinding(paneId, sessionId, live, win));
    // §13.12 item 1: this reply was built from a verified binding, so it is what the
    // tail lane may answer from — with the file it was read from, so the memory does
    // not have to search for it again. A reply built from the READER's pick is not
    // remembered: the pick is that request's binding, not the pane's (§9.5), and a
    // memory of it would keep serving the picked session after the pick is gone.
    if (!readerPick) rememberBinding(paneId, agent, entry, live, file);
    const reply = chatReply(res, base, { kind: chatClaude.SOURCE_KIND, session_id: sessionId, path: file }, win, tail, since);
    if (clk) clk.done({ lane: 'resolved', scan: live.scan, messages: win.messages.length, tail_bytes: win.tailBytes, file_size: win.eof });
    return reply;
  }

  // hermes
  const file = chatHermes.dbPath();
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) {
    throw {
      code: 'session_db_missing',
      message: `hermes state database not found at ${file}`,
      extra: Object.assign({}, fields, { pane_id: paneId, agent }),
    };
  }
  const win = tail
    ? chatHermes.readTail(file, sessionId, limit, working)
    : chatHermes.readWindow(file, sessionId, since, limit, working);
  Object.assign(base, observeBinding(paneId, sessionId, live, win));
  const reply = chatReply(res, base, { kind: chatHermes.SOURCE_KIND, session_id: sessionId, path: file }, win, tail, since);
  if (clk) clk.done({ lane: 'resolved', agent: 'hermes', scan: live.scan, messages: win.messages.length, records: win.records });
  return reply;
}

/**
 * Round 7.6 — feed the tracker the two facts only this function has: the head of
 * the bound session's content (`win.cursor` grows when the session gains records)
 * and the pane's text (its digest is §9.4's "the text keeps changing"). `text` is
 * the concatenation of both reads so that a change anywhere on the screen or in
 * the scrollback counts, and `null` when neither read worked — an unreadable pane
 * is not evidence of movement.
 */
function observeBinding(paneId, sessionId, live, win) {
  const texts = live.texts || {};
  const parts = [texts.visible, texts.recent].filter((t) => typeof t === 'string');
  const tracked = bindingTracker.observe(paneId, {
    session_id: sessionId,
    detected_by: live.res.detected_by,
    progress: win && Number.isFinite(win.cursor) ? win.cursor : null,
    text: parts.length ? parts.join('\n') : null,
    at: Date.now(),
  });
  return {
    session_change: tracked.session_change || null,
    stale: !!tracked.stale,
    stale_reason: tracked.stale_reason || null,
  };
}

// ── §12.3 (round 8) GET /api/status — the pane's own output, interpreted ─────
// `visible` is the source §12.3.5's single read uses, and it is the one that
// carries everything §12.3 asks about: measured live in round 8, w4:p1's visible
// text holds BOTH the `Processes · N running` block (with its ⚙ lines) AND the
// ☤ status line, and a claude pane's footer is the last line it paints. `recent`
// (scrollback) was the alternative and would have needed a second read.
const STATUS_PANE_LINES = 400;

/**
 * §12.3 `GET /api/status?pane_id=<id>` — read-only, and read-only BY CONSTRUCTION:
 * the only herdr calls on this path are `agent.list` / `session.snapshot` (both
 * served from the 5 s caches the rest of the view already keeps) and ONE
 * `pane.read` of the pane's visible text. Nothing here writes to a pane or to
 * herdr: in particular this route does NOT call `liveSessionFor`, because that
 * resolver can run §9's candidate scan and §9.3's heal (a
 * `pane.report_agent_session` write), while §12.3.5 caps the endpoint at one pane
 * read plus one jsonl tail read. The claude session id therefore comes from
 * herdr's own record in `agent.list` — the same starting point /api/chat uses —
 * and a pane herdr records no session for answers with an absent `context`
 * instead of paying for a scan.
 *
 * A pane herdr does not know at all is refused BEFORE any read, so a bogus id
 * cannot cost a `pane.read`. An agent that is neither family answers ok:true with
 * `family:"other"` and three absences: nothing there is ours to interpret, and
 * §12.3.4 forbids inventing a value or a scan for it.
 */
async function handleStatus(req, res, url) {
  const paneId = url.searchParams.get('pane_id');
  if (!paneId) {
    throw {
      code: 'bad_request',
      message: '"pane_id" query parameter is required, e.g. /api/status?pane_id=w4:p1',
    };
  }

  // §12.3.5's "the response carries the herdr round-trip latency it cost": every
  // herdr RPC this request makes is timed here (hrtime — a pane read is a few ms
  // and Date.now() cannot see that on Windows). The local jsonl read is file I/O,
  // not a herdr round trip, so it is not counted.
  let herdrNs = 0n;
  const timed = async (fn) => {
    const t0 = process.hrtime.bigint();
    try { return await fn(); } finally { herdrNs += process.hrtime.bigint() - t0; }
  };

  const { agents } = await timed(() => agentList());
  const entry = agents.find((a) => a && a.pane_id === paneId);
  let agent = '';
  let sessionId = '';
  if (entry) {
    const session = entry.agent_session;
    agent = String((session && session.agent) || entry.agent || '');
    sessionId = session && session.value != null ? String(session.value) : '';
  } else {
    const known = await timed(() => paneInSnapshot(paneId));
    if (!known.exists) throw { code: 'pane_not_found', message: `unknown pane_id "${paneId}"` };
  }

  const family = agent === 'hermes' ? 'hermes' : agent === 'claude' ? 'claude' : 'other';

  let text = null;
  let textError = null;
  if (family !== 'other') {
    try {
      const result = await timed(() => hdr.request(
        'pane.read',
        { pane_id: paneId, source: 'visible', lines: STATUS_PANE_LINES, format: 'text', strip_ansi: true },
        { timeoutMs: DEFAULT_TIMEOUT_MS },
      ));
      const read = (result && result.read) ? result.read : (result || {});
      text = typeof read.text === 'string' ? read.text : '';
    } catch (e) {
      // A pane that cannot be read is an absence with a reason, never a 500
      // (§12.3.4) — the claude half can still be answered from its log.
      text = null;
      textError = (e && e.code) || 'read_failed';
    }
  }

  let claudeTail = null;
  if (family === 'claude') {
    if (!sessionId) {
      claudeTail = { ok: false, reason: 'herdr records no session id for this pane, so there is no session log to read' };
    } else {
      const file = chatClaude.findSessionFile(sessionId);
      claudeTail = file
        ? await statusView.readUsageTail(file)
        : { ok: false, reason: `no session file "${sessionId}.jsonl" under ${chatClaude.projectsRoot()}` };
    }
  }

  const view = statusView.interpret({
    agent,
    agent_known: !!entry,
    text,
    text_error: textError,
    claude_tail: claudeTail,
  });

  ok(res, {
    pane_id: paneId,
    agent: agent || null,
    family: view.family,
    status: view.status,
    context: view.context,
    processes: view.processes,
    // §12.3 4b: how many lines of pane text this answer was interpreted from, so a
    // client can say "no status line in the last N lines" without scraping `absent`.
    lines_read: view.lines_read,
    absent: view.absent,
    // §12.3.5 names the latency but not a field; this is the one key this route
    // adds beyond the frozen shape, so it is a number of milliseconds (one
    // decimal — a warm identification + pane read is a few ms, not a whole one).
    herdr_ms: Math.round((Number(herdrNs) / 1e6) * 10) / 10,
  });
}

// ── SSE hub (§5) ────────────────────────────────────────────────────────────
// One long-lived herdr subscription, shared by every connected browser. The
// hub runs whether or not any client is attached, so the pipe state is warm.
const sseClients = new Set();
const TOPIC_SUBS = [
  'pane.created', 'pane.closed', 'pane.updated', 'pane.focused', 'pane.moved',
  'tab.created', 'tab.closed', 'tab.moved',
  'workspace.created', 'workspace.closed',
  'layout.updated',
];

const hub = {
  state: 'disconnected',   // connected | disconnected
  error: null,
  handle: null,            // hdr.subscribe handle
  panes: new Set(),        // pane ids we hold a status subscription for
  backoff: 500,
  reconnectTimer: null,
  refreshTimer: null,
  debounceTimer: null,
};

function statusData() {
  const data = { herdr: hub.state, pipe: hdr.pipe };
  if (hub.error) data.error = hub.error;
  return data;
}

function broadcast(frame) {
  const payload = 'event: dash\ndata: ' + JSON.stringify(frame) + '\n\n';
  for (const client of sseClients) {
    try { client.write(payload); } catch (e) { sseClients.delete(client); }
  }
}

function broadcastStatus() {
  broadcast({ event: 'dash.status', data: statusData() });
}

/** The subscription set: fixed topology topics + one status sub per known pane. */
function hubSubscriptions() {
  const subs = TOPIC_SUBS.map((type) => ({ type }));
  for (const paneId of hub.panes) subs.push({ type: 'pane.agent_status_changed', pane_id: paneId });
  return subs;
}

function onHerdrEvent(evt) {
  if (!evt || !evt.event) return;
  broadcast({ event: evt.event, data: evt.data || {} });
  // A pane appeared or vanished: refresh the pane set promptly, and let the
  // 30 s timer be the backstop.
  if (evt.event === 'pane.created' || evt.event === 'pane.closed') schedulePaneRefresh(250);
}

function onHubStatus(st) {
  if (st.state === 'connected') {
    hub.backoff = 500;
    hub.error = null;
    if (hub.state !== 'connected') {
      hub.state = 'connected';
      broadcastStatus();
    }
    return;
  }

  // closed or error — the caller (us) owns reconnection.
  hub.handle = null;
  hub.state = 'disconnected';
  hub.error = st.error ? (st.error.message || String(st.error.code)) : 'subscription closed';
  broadcastStatus();
  scheduleReconnect();
}

function scheduleReconnect() {
  if (hub.reconnectTimer) return;
  const delay = hub.backoff;
  hub.backoff = Math.min(hub.backoff * 2, 5000); // 0.5 s -> 5 s cap
  hub.reconnectTimer = setTimeout(() => {
    hub.reconnectTimer = null;
    connectHub();
  }, delay);
}

function connectHub() {
  if (hub.reconnectTimer) {
    clearTimeout(hub.reconnectTimer);
    hub.reconnectTimer = null;
  }
  if (hub.handle) {
    try { hub.handle.close(); } catch (e) { /* already closed */ }
    hub.handle = null;
  }
  try {
    hub.handle = hdr.subscribe(hubSubscriptions(), onHerdrEvent, onHubStatus);
  } catch (e) {
    // A synchronous failure must not take the server down either.
    hub.state = 'disconnected';
    hub.error = e.message;
    broadcastStatus();
    scheduleReconnect();
  }
}

/** Re-read pane.list; re-subscribe only when the pane set actually changed. */
async function refreshPanes() {
  try {
    const result = await hdr.request('pane.list', {}, { timeoutMs: DEFAULT_TIMEOUT_MS });
    const next = new Set(((result && result.panes) || []).map((p) => p.pane_id).filter(Boolean));
    const changed = next.size !== hub.panes.size || [...next].some((id) => !hub.panes.has(id));
    hub.panes = next;
    if (changed && hub.handle) connectHub();
  } catch (e) {
    // herdr may be down; the 30 s tick (and the backoff loop) retries.
  }
}

function schedulePaneRefresh(delayMs) {
  if (hub.debounceTimer) return;
  hub.debounceTimer = setTimeout(() => {
    hub.debounceTimer = null;
    refreshPanes();
  }, delayMs);
}

function startHub() {
  refreshPanes().then(() => connectHub());
  hub.refreshTimer = setInterval(refreshPanes, 30000);
  hub.refreshTimer.unref();
  setInterval(() => broadcast({ event: 'dash.heartbeat', data: { ts: Date.now() } }), 15000).unref();
}

// GET /api/events — SSE stream.
function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 1000\n\n');

  sseClients.add(res);
  const cleanup = () => sseClients.delete(res);
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  // Immediately tell the newcomer where herdr stands.
  res.write('event: dash\ndata: ' + JSON.stringify({ event: 'dash.status', data: statusData() }) + '\n\n');
}

// ── routing ─────────────────────────────────────────────────────────────────
async function handle(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (!pathname.startsWith('/api/')) {
    if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, pathname);
    return notFound(res, `no route for ${method} ${pathname}`);
  }

  // §10 (round 7.7): the one route whose body is RAW BYTES rather than JSON, so it
  // is dispatched before the JSON readers below — a 25 MiB upload must never be
  // buffered as a body object. It answers its own status codes (413 cap, 400 bad
  // input, 405 wrong method), because §10.3 says the client shows a refusal verbatim.
  if (pathname === '/api/attach') {
    if (method !== 'POST') {
      res.setHeader('allow', 'POST');
      return sendJson(res, {
        ok: false,
        error: {
          code: 'method_not_allowed',
          message: `${method} is not allowed on /api/attach — the endpoint takes a POST whose body is the file's bytes`,
        },
      }, 405);
    }
    return attach.handleAttach(req, res, { sendJson });
  }

  // §13.2 (round 9): the two local-action endpoints. Also dispatched before the JSON
  // readers, because §13.2.6's gate must run BEFORE the body is read — a refused
  // request must cost nothing and do nothing.
  if (pathname === '/api/pathinfo' || pathname === '/api/open') {
    if (method !== 'POST') {
      res.setHeader('allow', 'POST');
      return sendJson(res, {
        ok: false,
        error: {
          code: 'method_not_allowed',
          message: `${method} is not allowed on ${pathname} — the endpoint takes a POST with a JSON body`,
        },
      }, 405);
    }
    return pathsApi.handle(req, res, { sendJson, readJson, pathname });
  }

  // GET routes
  if (method === 'GET') {
    if (pathname === '/api/health') return handleHealth(req, res);
    if (pathname === '/api/snapshot') return handleSnapshot(req, res);
    if (pathname === '/api/events') return handleEvents(req, res);
    if (pathname === '/api/pane') return handlePane(req, res, url);
    if (pathname === '/api/git') return handleGit(req, res, url);   // §7.1
    if (pathname === '/api/chat') return handleChat(req, res, url); // §8.2
    if (pathname === '/api/status') return handleStatus(req, res, url); // §12.3
    // §2 convenience: GET /api/cli?argv=agent+list — same as the POST body, with
    // argv split on whitespace. No quoting support; use POST for arguments that
    // contain spaces.
    if (pathname === '/api/cli') {
      const raw = url.searchParams.get('argv');
      if (!raw || !raw.trim()) {
        return err(res, 'bad_request', '"argv" query parameter is required, e.g. /api/cli?argv=agent+list');
      }
      return handleCli(req, res, { argv: raw.split(/\s+/).filter(Boolean) });
    }
    return notFound(res, `no route for ${method} ${pathname}`);
  }

  // POST routes (all take a JSON body)
  if (method === 'POST') {
    const handlers = {
      '/api/pane/prompt': handlePrompt,
      '/api/pane/keys': handleKeys,
      '/api/pane/text': handleText,
      '/api/rpc': handleRpc,
      '/api/cli': handleCli,
      '/api/fanout': handleFanout,
      '/api/keys-broadcast': handleKeysBroadcast,
    };
    const handler = handlers[pathname];
    if (!handler) return notFound(res, `no route for ${method} ${pathname}`);
    const body = await readJson(req);
    return handler(req, res, body);
  }

  return notFound(res, `no route for ${method} ${pathname}`);
}

// ── process hardening + bootstrap ───────────────────────────────────────────
// A dropped pipe or a stray rejection must never take the server down.
process.on('uncaughtException', (e) => {
  console.error('[herdr-dash] uncaughtException:', (e && e.stack) || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[herdr-dash] unhandledRejection:', (e && e.stack) || e);
});

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (res.writableEnded) return;
    // Everything the handlers can throw is {code,message} and may carry `extra`
    // (round 7.6: §9's resolution fields ride along on a failure to bind, so a
    // view that cannot be served still says WHICH sessions the pane named).
    if (e && typeof e.code === 'string' && typeof e.message === 'string') {
      return err(res, e.code, e.message, e.extra);
    }
    console.error('[herdr-dash] handler error:', (e && e.stack) || e);
    err(res, 'internal', String((e && e.message) || e));
  });
});

function parseArgs(argv) {
  const opts = { port: 7433, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    let key, value;
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) i++;
      else value = undefined;
    }
    if (key === 'port' && value !== undefined) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0 && n < 65536) opts.port = n;
    } else if (key === 'host' && value) {
      opts.host = value;
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  server.on('error', (e) => {
    console.error('[herdr-dash] server error:', e.message);
    process.exitCode = 1;
  });
  server.listen(opts.port, opts.host, () => {
    const actual = server.address().port;
    console.log(`herdr-dash listening on http://${opts.host}:${actual}`);
    console.log(`[herdr-dash] herdr pipe: ${hdr.pipe}`);
    console.log(`[herdr-dash] herdr bin:  ${HERDR_BIN}`);
    startHub();
  });
}

main();
