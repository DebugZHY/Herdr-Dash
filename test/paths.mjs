#!/usr/bin/env node
// herdr-dash round-9 harness — CONTRACT-v2 §13.2.3/5/6/7 (POST /api/pathinfo, POST
// /api/open) — owner: W1.
//
// Zero dependencies beyond node itself.
//
// WHAT THIS PROVES, AND HOW
//
//   Two halves, because the two halves are different claims. The HTTP half starts a
//   real server (the one the app runs) and makes real requests, so §13.2.6's gate,
//   the status codes and the audit log are measured as the browser will meet them.
//   The unit half calls the module directly with an injected spawner, because the
//   claims that matter most must be provable WITHOUT launching anything: that a
//   refused request never reaches `spawn`, and that the argv handed over is exactly
//   two elements with the path verbatim.
//
//   NO EXPLORER IS LAUNCHED BY THIS SUITE — not even one. §13.2.5's argv is proven
//   through the audit line (§13.2.6's own log) with the handler pointed at node
//   (`HD_OPEN_EXE`, the same kind of knob as the server's GIT_BIN_PATH), so the
//   suite observes the real spawn without a window appearing, and without the risk
//   that `explorer /select,` navigates an Explorer window the user already has open
//   (it reuses the existing window when Explorer is set to one window). §13.0's
//   measurements of what explorer does with that argv are Hermes' and are not
//   re-derived here; this suite tests THIS side of the call.
//
//   A path with a QUOTE in it is tested at both levels. Windows forbids `"` in a
//   filename, so the end-to-end case uses a real file named with spaces and a
//   single quote (which a shell would mangle and an argv array cannot), and the
//   double-quote case is tested where it is reachable: `argvFor()` builds the argv
//   for any string, and a path containing `"` that does not exist is refused with
//   404 and never reaches spawn.
//
//   The module-level half writes its own audit lines into this suite's output (the
//   module logs when it hands an argv over). Those lines are the module telling the
//   truth about the argv it was given; the process they name is the recording
//   spawner, which creates nothing.
//
//   WINDOWS PATH REALITY (round 9, second pass). §13.2 errata 9 measured that
//   explorer.exe does not accept forward slashes and opened **Documents** while the
//   API said "handed to the system"; the teeth case for that is here, and it asserts
//   the SPAWNED ARGV (a forward-slash directory must be handed over in backslash
//   form), never the HTTP code. The rest of this pass is the same idea — answer
//   honestly about the path the OS really has — for the shapes Windows' own paths can
//   take: the `\\?\` namespace form and `\\localhost\C$` UNC, a path longer than 260
//   characters, a directory junction (which must be a `dir`), a trailing space or dot
//   (which the shell strips and Node's `fs` does not — measured here, both sides, so
//   the answer's honesty is checked against the shell's own opinion), the same
//   directory spelled in two cases (`C:\WINDOWS`/`c:\windows`), and a path on an
//   unreachable UNC host (measured: a synchronous stat of one blocked its caller for
//   42,155 ms, which on this single-threaded server is every endpoint frozen for 42
//   seconds — so the stats are asynchronous under a deadline, and the check below
//   proves `/api/health` still answers while such a path is in flight).
//
// Usage:
//   node test/paths.mjs [--port 7492]
//
// The server listens on <port>, is killed before the harness exits, and the port is
// re-checked. Exit code is 0 only when every check passed.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const HERE = (() => {
  if (import.meta.dirname) return import.meta.dirname;
  const p = decodeURIComponent(new URL('.', import.meta.url).pathname);
  return process.platform === 'win32' && /^[A-Za-z]:/.test(p.slice(1)) ? p.slice(1) : p;
})();
const REPO_ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const PORT = Number(flagValue('--port', '7492'));
const BASE = `http://127.0.0.1:${PORT}`;
const SPAWN_WAIT_MS = 20000;
// Short enough that the suite can watch §13.2.3's TTL happen; the product default
// is asserted against its own constant below. Both halves must run with the SAME
// TTL: the unit half calls the module in THIS process, so the knob is set here
// before the module is loaded (it is read once, at load — see src/paths.js).
const TTL_MS = 250;
process.env.HD_PATHINFO_TTL_MS = String(TTL_MS);
// Same rule for the deadline: the suite must not wait the product's 2500 ms per
// undecidable path, but it must still watch the deadline ANSWER (see the UNC check).
const DEADLINE_MS = 400;
process.env.HD_PATHINFO_DEADLINE_MS = String(DEADLINE_MS);

const paths = require(path.join(REPO_ROOT, 'src', 'paths.js'));

// ── fixtures ────────────────────────────────────────────────────────────────
// Repo-local, like the other suites' scratch: the fixtures are files on a real
// filesystem, which is the only thing §13.2.3 asks about.
const SCRATCH = path.join(REPO_ROOT, '_scratch', 'w1', 'paths');
const TMP = path.join(SCRATCH, 'tmp');
const DIR_SPACES = path.join(TMP, 'a dir with spaces');
const FILE_PLAIN = path.join(TMP, 'plain.txt');
const FILE_QUOTED = path.join(DIR_SPACES, "quote ' and space.txt");
const MISSING = path.join(TMP, 'nope', 'missing.txt');
const SWAP = path.join(TMP, 'kind-swap');
// ── the Windows-reality fixtures ────────────────────────────────────────────
const FILE_FS = FILE_PLAIN.replace(/\\/g, '/');        // the same file, forward slashes
const DIR_FS = DIR_SPACES.replace(/\\/g, '/');         // the same directory, forward slashes
const JUNC_TARGET = path.join(TMP, 'junction-target');
const JUNC = path.join(TMP, 'junction-to-dir');
const LONG_SEG = 'd'.repeat(100);
const LONG_DIR = path.join(TMP, 'deep', LONG_SEG, LONG_SEG);   // 257 chars on this root
const LONG_FILE = path.join(LONG_DIR, 'x.txt');                // 263 chars
const UNC_UNREACHABLE = '\\\\192.0.2.1\\share\\x';     // TEST-NET-1: nothing answers
const UNC_SLOW = '\\\\192.0.2.2\\share\\y';            // a second unroutable host

function buildFixtures() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(DIR_SPACES, { recursive: true });
  fs.writeFileSync(FILE_PLAIN, 'plain\n');
  fs.writeFileSync(FILE_QUOTED, 'quoted name\n');
  fs.mkdirSync(SWAP, { recursive: true });
  fs.mkdirSync(JUNC_TARGET, { recursive: true });
  fs.mkdirSync(LONG_DIR, { recursive: true });
  fs.writeFileSync(LONG_FILE, 'long path\n');
}

/** A directory junction: the filesystem's own way of pointing one directory at
 *  another, and the case where `isDirectory()` must win over "it is a reparse point".
 *  `mklink /J` needs no elevation (a symlink would). Returns null on success or the
 *  reason, so a machine that cannot make junctions fails loudly instead of quietly. */
function makeJunction() {
  const r = spawnSync('cmd.exe', ['/c', 'mklink', '/J', JUNC, JUNC_TARGET], { encoding: 'utf8' });
  if (r.status === 0) return null;
  return `${(r.stderr || r.stdout || '').trim()} (status ${r.status})`;
}

/** What the SHELL thinks of a path, which is the opinion the answer has to respect:
 *  `cmd`'s own `dir` on a name with a trailing space or dot. Returns the names it
 *  listed, so the divergence from Node's `fs` can be asserted rather than asserted
 *  to exist. */
function shellResolves(name) {
  const r = spawnSync('cmd.exe', ['/c', 'dir', '/b', name], { cwd: TMP, encoding: 'utf8' });
  return (r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
}

// ── harness ─────────────────────────────────────────────────────────────────
class Fail extends Error {}
const must = (cond, msg) => { if (!cond) throw new Fail(msg); };
const eq = (got, want, what) => {
  if (got !== want) throw new Fail(`${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};
const eqJson = (got, want, what) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Fail(`${what}: got ${a}, expected ${b}`);
};

const results = [];
const notes = [];
let currentCheck = '(startup)';
let server = null;

async function check(name, fn) {
  currentCheck = name;
  let passed = false;
  let detail = '';
  const started = Date.now();
  try {
    const r = await fn();
    if (r && typeof r === 'object' && 'ok' in r) {
      passed = !!r.ok;
      detail = r.detail || '';
    } else {
      passed = r !== false;
    }
  } catch (e) {
    passed = false;
    detail = e instanceof Fail ? e.message : `unexpected ${(e && e.name) || 'error'}: ${(e && e.message) || String(e)}`;
  }
  const ms = Date.now() - started;
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` [${detail}]` : ''}${ms > 500 ? ` (${ms} ms)` : ''}`);
  return passed;
}

function note(s) {
  notes.push(s);
  console.log(`NOTE ${s}`);
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function request(method, route, { headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const payload = body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (payload !== null) {
      h['content-type'] = 'application/json';
      h['content-length'] = Buffer.byteLength(payload);
    }
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({ method, hostname: '127.0.0.1', port: PORT, path: route, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        finish({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', (e) => finish({ error: `response error: ${e.message}` }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ error: `timed out after ${timeoutMs}ms` }); });
    req.on('error', (e) => finish({ error: e.message }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** The two headers a real browser sends to the app's own fetch (§13.2.6). */
const SAME_ORIGIN = { 'x-hd-action': '1', 'sec-fetch-site': 'same-origin' };
const APP_ORIGIN = { 'x-hd-action': '1', origin: BASE };

function listening(port) {
  return new Promise((resolve) => {
    const req = http.request({ method: 'GET', hostname: '127.0.0.1', port, path: '/api/health', timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function startServer(port, env, label) {
  if (await listening(port)) {
    throw new Fail(`something is already listening on ${port} — refusing to test a server this harness did not start (stop it, or pass --port)`);
  }
  const proc = spawn(process.execPath, ['src/server.js', '--port', String(port)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: Object.assign({}, process.env, env || {}),
  });
  let out = '';
  let spawnErr = null;
  let exited = null;
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  proc.on('error', (e) => { spawnErr = e; });
  proc.on('exit', (code, sig) => { exited = `exit ${code}${sig ? ` (${sig})` : ''}`; });

  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    if (spawnErr) throw new Fail(`could not spawn the ${label} server on ${port}: ${spawnErr.message}`);
    if (exited !== null) throw new Fail(`the ${label} server on ${port} ${exited} during startup; output: ${out.trim().slice(0, 400) || '(none)'}`);
    if (await listening(port)) return { proc, output: () => out };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Fail(`the ${label} server on ${port} was not listening within ${SPAWN_WAIT_MS}ms; output: ${out.trim().slice(0, 400) || '(none)'}`);
}

function killChild(proc) {
  if (!proc || proc.exitCode !== null) return;
  try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
}

/** The audit lines §13.2.6 asks for, parsed out of the server's own stdout. */
const auditLines = (text) => text.split(/\r?\n/).filter((l) => l.startsWith('[hd-open] ')).map((l) => {
  try { return JSON.parse(l.slice('[hd-open] '.length)); } catch { return { unparsable: l }; }
});

// The module-level half runs in THIS process, so the audit lines its own calls produce
// are on this process's stdout, not the server child's — a different stream, and one a
// check needs to read to see the argv the module recorded for the call it just made.
const localAudit = [];
const localUndecided = [];
{
  const realLog = console.log;
  const keep = (text, into, tag) => {
    try { into.push(JSON.parse(text.slice(tag.length))); } catch { /* unparsable: not evidence */ }
  };
  console.log = (...args) => {
    const first = args[0];
    if (typeof first === 'string') {
      if (first.startsWith('[hd-open] ')) keep(first, localAudit, '[hd-open] ');
      else if (first.startsWith('[hd-pathinfo] ')) keep(first, localUndecided, '[hd-pathinfo] ');
    }
    return realLog.apply(console, args);
  };
}

// ── a fake res for the module-level half ────────────────────────────────────
function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writableEnded: false,
    setHeader(k, v) { (this.headers = this.headers || {})[k] = v; },
    writeHead(code, headers) { this.statusCode = code; this.headers = Object.assign(this.headers || {}, headers || {}); },
    end(payload) { this.body = payload; this.writableEnded = true; },
  };
}

const fakeReq = (over) => Object.assign({
  method: 'POST',
  headers: Object.assign({ host: `127.0.0.1:${PORT}` }, SAME_ORIGIN),
  socket: { remoteAddress: '127.0.0.1' },
}, over || {});

/** Call the module's route handler with a recording spawner — NO process is created. */
async function routeDirect(pathname, body, reqOver) {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { pid: 4242, on() {}, unref() {} };
  };
  const res = fakeRes();
  const req = fakeReq(reqOver);
  req.method = 'POST';
  await paths.handle(req, res, {
    pathname,
    spawnImpl,
    readJson: async () => body,
    sendJson: (r, payload, code) => {
      r.writeHead(code || 200, { 'content-type': 'application/json' });
      r.end(JSON.stringify(payload));
    },
  });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, calls };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the run ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`herdr-dash paths — server ${BASE}, TTL ${TTL_MS} ms, module ${path.relative(REPO_ROOT, require.resolve(path.join(REPO_ROOT, 'src', 'paths.js')))}`);
  buildFixtures();

  const watchdog = setTimeout(() => {
    console.error(`WATCHDOG: no result after 240s — the check that stalled was "${currentCheck}"`);
    killChild(server && server.proc);
    process.exit(2);
  }, 240000);
  watchdog.unref();

  // `HD_OPEN_EXE` points the handler at node so a real spawn can be observed
  // without a window: see the header. The argv shape is what is under test here.
  const started = await startServer(PORT, {
    HD_PATHINFO_TTL_MS: String(TTL_MS),
    HD_PATHINFO_DEADLINE_MS: String(DEADLINE_MS),
    HD_OPEN_EXE: process.execPath,
  }, 'paths');
  server = started;
  const out = () => started.output();

  // ── §13.2.6: the gate ─────────────────────────────────────────────────────
  await check('gate: the peer, the header and the origin are each required (§13.2.6)', async () => {
    const ok = fakeReq();
    must(paths.guard(ok) === null, `a same-origin loopback request with the header must pass, got ${JSON.stringify(paths.guard(ok))}`);
    // The OR §13.2.6 writes: an Origin of the app is enough on its own.
    const byOrigin = fakeReq({ headers: { host: `127.0.0.1:${PORT}`, 'x-hd-action': '1', origin: BASE } });
    must(paths.guard(byOrigin) === null, `an app Origin must satisfy the second half of the OR, got ${JSON.stringify(paths.guard(byOrigin))}`);
    const cases = [
      ['no x-hd-action header', fakeReq({ headers: { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin' } })],
      ['x-hd-action: 0', fakeReq({ headers: { host: `127.0.0.1:${PORT}`, 'x-hd-action': '0', 'sec-fetch-site': 'same-origin' } })],
      ['no origin and no sec-fetch-site', fakeReq({ headers: { host: `127.0.0.1:${PORT}`, 'x-hd-action': '1' } })],
      ['sec-fetch-site: cross-site, foreign Origin', fakeReq({ headers: { host: `127.0.0.1:${PORT}`, 'x-hd-action': '1', 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' } })],
      ['an Origin with the wrong port', fakeReq({ headers: { host: `127.0.0.1:${PORT}`, 'x-hd-action': '1', origin: `http://127.0.0.1:${PORT + 7}` } })],
      ['a non-loopback peer', fakeReq({ socket: { remoteAddress: '192.168.1.44' } })],
    ];
    for (const [what, req] of cases) {
      const d = paths.guard(req);
      must(d && d.code === 'forbidden', `${what} must be refused, got ${JSON.stringify(d)}`);
    }
    // The peer rule on its own: 127.0.0.0/8 is all loopback (Windows included).
    const peers = [['127.0.0.1', true], ['127.9.9.9', true], ['::1', true], ['::ffff:127.0.0.1', true],
      ['192.168.1.44', false], ['10.0.0.5', false], ['::ffff:8.8.8.8', false], ['', false], [undefined, false]];
    for (const [addr, want] of peers) {
      eq(paths.isLoopback({ socket: { remoteAddress: addr } }), want, `isLoopback(${JSON.stringify(addr)})`);
    }
    return { detail: `6 refusals, 2 admissions, ${peers.length} peer addresses` };
  });

  await check('gate: a refused request never reaches spawn, whatever it asked for (§13.2.6)', async () => {
    const before = auditLines(out()).length;
    const refused = [
      ['no header', '/api/open', { path: FILE_PLAIN, action: 'open' }, { headers: { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin' } }, 403],
      ['foreign origin', '/api/open', { path: FILE_PLAIN, action: 'open' }, { headers: { host: `127.0.0.1:${PORT}`, 'x-hd-action': '1', origin: 'http://evil.example' } }, 403],
      ['non-loopback peer', '/api/open', { path: FILE_PLAIN, action: 'open' }, { socket: { remoteAddress: '8.8.8.8' } }, 403],
      ['an action that is not whitelisted', '/api/open', { path: FILE_PLAIN, action: 'exec' }, {}, 400],
      ['reveal on a directory', '/api/open', { path: DIR_SPACES, action: 'reveal' }, {}, 400],
      ['a path that is not there', '/api/open', { path: MISSING, action: 'open' }, {}, 404],
      ['a path carrying a double quote that is not there', '/api/open', { path: `${TMP}\\a " quoted missing.txt`, action: 'open' }, {}, 404],
    ];
    for (const [what, route, body, reqOver, wantStatus] of refused) {
      const r = await routeDirect(route, body, reqOver);
      eq(r.status, wantStatus, `${what}: status`);
      eq(r.calls.length, 0, `${what}: spawn calls (a refusal must never launch anything)`);
      must(!/opened/i.test(r.json && r.json.error ? r.json.error.message : ''), `${what}: the refusal must not claim anything was opened`);
    }
    await sleep(100);
    eq(auditLines(out()).length, before, 'refused requests must log no action at all');
    return { detail: `${refused.length} refusals, 0 spawn calls, 0 audit lines` };
  });

  await check('pathinfo: the request shape is checked before any path is stated (§13.2.3)', async () => {
    const cases = [
      [{}, 'bad_request'],
      [{ paths: 'C:\\x' }, 'bad_request'],
      [{ paths: ['C:\\x', 7] }, 'bad_request'],
      [{ paths: [''] }, 'bad_request'],
      [{ paths: ['C:\\x\u0000y'] }, 'bad_request'],
      [{ paths: ['C:\\' + 'a'.repeat(40000)] }, 'bad_request'],
      [{ paths: new Array(paths.LIMITS.MAX_PATHS + 1).fill('C:\\x') }, 'too_many_paths'],
    ];
    for (const [body, wantCode] of cases) {
      const n = paths.normalizePaths(body);
      eq(n.code, wantCode, `normalizePaths(${JSON.stringify(body).slice(0, 60)})`);
      must(typeof n.error === 'string' && n.error.length > 20, 'a refusal must say what was wrong, in words');
    }
    const ok = paths.normalizePaths({ paths: ['C:\\a', 'C:\\b'] });
    eqJson(ok.paths, ['C:\\a', 'C:\\b'], 'a well-formed request comes back unchanged');
    return { detail: `${cases.length} refusals, the cap named as ${paths.LIMITS.MAX_PATHS}` };
  });

  await check('pathinfo: a file, a directory and a path that is not there (§13.2.3)', async () => {
    const r = await request('POST', '/api/pathinfo', {
      headers: SAME_ORIGIN,
      body: { paths: [FILE_PLAIN, DIR_SPACES, MISSING] },
    });
    eq(r.status, 200, 'status');
    eq(r.json.ok, true, 'ok');
    eq(r.json.items.length, 3, 'one item per requested path');
    eqJson(r.json.items.map((i) => i.path), [FILE_PLAIN, DIR_SPACES, MISSING], 'the answers mirror the request order');
    eqJson(r.json.items.map((i) => i.exists), [true, true, false], 'exists');
    eqJson(r.json.items.map((i) => i.kind), ['file', 'dir', null], 'kind');
    // The app-Origin form of the gate, end to end.
    const byOrigin = await request('POST', '/api/pathinfo', { headers: APP_ORIGIN, body: { paths: [FILE_PLAIN] } });
    eq(byOrigin.status, 200, 'an app Origin is enough for pathinfo too (§13.2.6)');
    return { detail: `${path.basename(FILE_PLAIN)}=file, a dir with spaces=dir, nope/missing.txt=missing` };
  });

  await check('pathinfo: the batch cap is 200 paths, and 200 is allowed (§13.2.3)', async () => {
    const at = await request('POST', '/api/pathinfo', {
      headers: SAME_ORIGIN,
      body: { paths: new Array(paths.LIMITS.MAX_PATHS).fill(FILE_PLAIN) },
    });
    eq(at.status, 200, `${paths.LIMITS.MAX_PATHS} paths must be accepted`);
    eq(at.json.items.length, paths.LIMITS.MAX_PATHS, 'one item per path');
    const over = await request('POST', '/api/pathinfo', {
      headers: SAME_ORIGIN,
      body: { paths: new Array(paths.LIMITS.MAX_PATHS + 1).fill(FILE_PLAIN) },
    });
    eq(over.status, 400, 'one over the cap is refused');
    eq(over.json.error.code, 'too_many_paths', 'and the code names the reason');
    return { detail: `200 accepted, 201 → ${over.json.error.code}` };
  });

  await check('pathinfo: a TTL hit costs no stat, and after the TTL the path is re-stated (§13.2.3)', async () => {
    const late = path.join(TMP, 'appears-later.txt');
    fs.rmSync(late, { force: true });
    eq(paths.TTL_MS, TTL_MS, 'this process runs on the TTL the suite set');
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'paths.js'), 'utf8');
    must(/n >= 0 \? n : 2000;/.test(src), 'the product default TTL is 2000 ms when nothing overrides it');
    paths._clearCache();
    paths._resetStatCount();
    const first = await paths.info(late);
    eqJson([first.exists, first.kind], [false, null], 'the path is not there yet');
    eq(paths._statCount(), 1, 'the first answer cost one stat');
    fs.writeFileSync(late, 'now it is\n');
    const cached = await paths.info(late);
    eq(cached.exists, false, 'inside the TTL the cached verdict is served (that is what the cache is)');
    eq(paths._statCount(), 1, 'and a hit costs NO stat — the TTL is what bounds the work');
    await sleep(TTL_MS + 120);
    const restated = await paths.info(late);
    eqJson([restated.exists, restated.kind], [true, 'file'], 'after the TTL the path is re-stated and the file is found');
    eq(paths._statCount(), 2, 'the re-statement is exactly one stat');
    const again = await paths.info(FILE_PLAIN);
    await sleep(TTL_MS + 120);
    const same = await paths.info(FILE_PLAIN);
    eq(same.kind, 'file', 'an unchanged file keeps answering after the TTL');
    must(paths._cacheSize() >= 1, 'entries stay keyed by path, not one blob');
    return { detail: `1 stat per path per ${TTL_MS} ms (missing → created → found on the first call after the TTL)` };
  });

  await check('pathinfo: the TTL works in the other direction too — a deleted file stops existing (§13.2.3)', async () => {
    // The mirror of the check above. A cache that can only see files APPEAR (because a
    // stale "missing" is harmless) but keeps reporting a DELETED file as existing is
    // the failure that puts a link on the screen for something that is gone — and the
    // click then refuses with a 404 the user did not expect.
    const doomed = path.join(TMP, 'deleted-later.txt');
    fs.writeFileSync(doomed, 'here for now\n');
    paths._clearCache();
    const before = await paths.info(doomed);
    eqJson([before.exists, before.kind], [true, 'file'], 'it exists to begin with');
    fs.rmSync(doomed, { force: true });
    must(!fs.existsSync(doomed), 'the fixture really is gone');
    const stillCached = await paths.info(doomed);
    eq(stillCached.exists, true, 'inside the TTL the cached verdict still stands — that IS the TTL, and the click is refused with an honest 404');
    await sleep(TTL_MS + 120);
    const afterTtl = await paths.info(doomed);
    eqJson([afterTtl.exists, afterTtl.kind], [false, null], 'past the TTL a deleted file must NOT still be reported as existing');
    // And the 404 really is what a click gets in that window (HTTP, real stat).
    fs.writeFileSync(doomed, 'second life\n');
    paths._clearCache();
    const linkOk = await request('POST', '/api/open', { headers: SAME_ORIGIN, body: { path: FILE_PLAIN, action: 'open' } });
    eq(linkOk.status, 200, 'a path that exists is still handed over');
    fs.rmSync(doomed, { force: true });
    const gone = await request('POST', '/api/open', { headers: SAME_ORIGIN, body: { path: doomed, action: 'open' } });
    eq(gone.status, 404, 'and the same path once deleted answers not_found');
    eq(gone.json.error.code, 'not_found', 'with the code the menu shows verbatim (§13.2.5)');
    return { detail: `exists → deleted: cached inside ${TTL_MS} ms, honest (false) after it, 404 on a click` };
  });

  await check('pathinfo: the mtime decides whether a cached verdict still describes the file (§13.2.3)', async () => {
    fs.rmSync(SWAP, { recursive: true, force: true });
    fs.mkdirSync(SWAP, { recursive: true });
    paths._clearCache();
    eq((await paths.info(SWAP)).kind, 'dir', 'it starts as a directory');
    fs.rmSync(SWAP, { recursive: true, force: true });
    fs.writeFileSync(SWAP, 'now a file\n');
    eq((await paths.info(SWAP)).kind, 'dir', 'inside the TTL the cached verdict stands');
    await sleep(TTL_MS + 120);
    eq((await paths.info(SWAP)).kind, 'file', 'after the TTL the re-statement sees the new truth (the mtime/size key changed)');
    const st = fs.statSync(SWAP);
    must(Number.isFinite(st.mtimeMs) && st.size > 0, 'the fixture really is a file with an mtime');
    return { detail: 'dir → file with the same path: invisible inside the TTL, exact on the first call after it' };
  });

  await check('pathinfo: what is remembered is bounded, and a full answer is never (13.2.3)', async () => {
    // The cap bounds the MAP, not the answer: every one of these paths is still
    // stated and answered, and the cache is what gets dropped when it fills.
    paths._clearCache();
    const n = paths.LIMITS.CACHE_MAX_ENTRIES + 50;
    for (let i = 0; i < n; i++) {
      const v = await paths.info(path.join(TMP, 'never', `p${i}.txt`));
      eq(v.exists, false, `path ${i} is still answered truthfully`);
    }
    const size = paths._cacheSize();
    must(size <= paths.LIMITS.CACHE_MAX_ENTRIES, `the cache must stay bounded, got ${size} entries for ${n} distinct paths`);
    eq((await paths.info(FILE_PLAIN)).kind, 'file', 'and a real path is still answered after the sweep');
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'paths.js'), 'utf8');
    must(/CACHE_MAX_ENTRIES/.test(src), 'the bound is declared where it is used');
    return { detail: `${n} distinct paths answered, cache held ${size} ≤ ${paths.LIMITS.CACHE_MAX_ENTRIES}` };
  });

  await check('open: the refusal table over HTTP, with no spawn behind any of it (§13.2.5/6)', async () => {
    const before = auditLines(out()).length;
    const table = [
      ['no x-hd-action', { 'sec-fetch-site': 'same-origin' }, { path: FILE_PLAIN, action: 'open' }, 403, 'forbidden'],
      ['foreign Origin', { 'x-hd-action': '1', origin: 'http://evil.example' }, { path: FILE_PLAIN, action: 'open' }, 403, 'forbidden'],
      ['cross-site fetch', { 'x-hd-action': '1', 'sec-fetch-site': 'cross-site' }, { path: FILE_PLAIN, action: 'reveal' }, 403, 'forbidden'],
      ['action: exec', SAME_ORIGIN, { path: FILE_PLAIN, action: 'exec' }, 400, 'bad_request'],
      ['no action', SAME_ORIGIN, { path: FILE_PLAIN }, 400, 'bad_request'],
      ['no path', SAME_ORIGIN, { action: 'open' }, 400, 'bad_request'],
      ['reveal on a directory', SAME_ORIGIN, { path: DIR_SPACES, action: 'reveal' }, 400, 'bad_request'],
      ['a missing path', SAME_ORIGIN, { path: MISSING, action: 'open' }, 404, 'not_found'],
      ['a missing path, named with a quote', SAME_ORIGIN, { path: `${TMP}\\a " quoted missing.txt`, action: 'reveal' }, 404, 'not_found'],
    ];
    for (const [what, headers, body, wantStatus, wantCode] of table) {
      const r = await request('POST', '/api/open', { headers, body });
      eq(r.status, wantStatus, `${what}: status`);
      eq(r.json.error.code, wantCode, `${what}: error code`);
      must(!/\bopened\b/i.test(JSON.stringify(r.json)), `${what}: the answer must never say "opened"`);
      must(!("done" in r.json), `${what}: a refusal carries no "done"`);
    }
    await sleep(150);
    eq(auditLines(out()).length, before, 'and not one of them logged an action');
    return { detail: `${table.length} refusals, 0 audit lines` };
  });

  await check('open: the path arrives as ONE argv element — spaces and a quote included (§13.2.5)', async () => {
    const before = auditLines(out()).length;
    const r = await request('POST', '/api/open', { headers: SAME_ORIGIN, body: { path: FILE_QUOTED, action: 'reveal' } });
    eq(r.status, 200, `status (a real file with spaces and a quote in its name), body ${JSON.stringify(r.json)}`);
    eq(r.json.ok, true, 'ok');
    eq(r.json.done, 'handed to the system', 'the answer says what was DONE (§13.2.7)');
    eq(r.json.path, FILE_QUOTED, 'the echo is the native path handed over — here the asked string already was native, so they are one string');
    must(!/\bopened\b/i.test(JSON.stringify(r.json)), 'and never claims the file was opened');
    await sleep(200);
    const lines = auditLines(out());
    eq(lines.length, before + 1, 'exactly one action was logged');
    const line = lines[lines.length - 1];
    must(Array.isArray(line.argv), `the audit line carries the argv, got ${JSON.stringify(line)}`);
    eq(line.argv.length, 2, 'argv has exactly two elements — the handler and the path, never a shell string');
    eq(line.argv[1], '/select,' + FILE_QUOTED, 'and element 1 is the whole "/select,<path>" verbatim, quote and spaces included');
    must(line.path === FILE_QUOTED, 'the logged path is the native path that was handed over');
    // The same shape with no prefix, and with a double quote, at the value level: a
    // quote can only ever be a character inside element 1.
    eqJson(paths.argvFor('open', 'C:\\a b\\c.txt'), [paths.openExe(), 'C:\\a b\\c.txt'], 'open → [exe, path]');
    eqJson(paths.argvFor('reveal', 'C:\\a "b"\\c.txt'), [paths.openExe(), '/select,C:\\a "b"\\c.txt'], 'a double quote stays inside one element');
    eq(paths.openExe(), 'explorer.exe', 'the product handler is explorer.exe when nothing overrides it');
    return { detail: `argv = ["${path.basename(line.argv[0])}", ${JSON.stringify(line.argv[1])}] — one element, verbatim` };
  });

  await check('open: the product handler, one element, no shell — and nothing else (§13.2.5)', async () => {
    // The same handler the dispatcher calls, with a recording spawner: this is the
    // only place the OPTIONS are visible, and `shell` is the one that decides whether
    // a path can be re-interpreted. No process is created here.
    const open = await routeDirect('/api/open', { path: FILE_PLAIN, action: 'open' });
    eq(open.status, 200, 'status');
    eq(open.json.done, 'handed to the system', 'the answer says what was done');
    eq(open.calls.length, 1, 'exactly one spawn');
    eq(open.calls[0].cmd, 'explorer.exe', 'the handler is explorer.exe when nothing overrides it (§13.2.5)');
    eqJson(open.calls[0].args, [FILE_PLAIN], 'args carry the path as the ONE argv element');
    eq(open.calls[0].opts.shell, false, 'no shell can be involved, ever');
    const reveal = await routeDirect('/api/open', { path: FILE_QUOTED, action: 'reveal' });
    eq(reveal.status, 200, 'reveal status');
    eqJson(reveal.calls[0].args, ['/select,' + FILE_QUOTED], 'reveal passes "/select,<path>" as one element');
    eq(reveal.calls[0].opts.shell, false, 'reveal is shell-free too');
    const dir = await routeDirect('/api/open', { path: DIR_SPACES, action: 'open' });
    eq(dir.status, 200, 'a directory may be opened');
    eqJson(dir.calls[0].args, [DIR_SPACES], 'and is passed as itself, one element');
    return { detail: `open → ["explorer.exe", ${JSON.stringify(FILE_PLAIN)}], reveal → ["explorer.exe", "/select,…"], shell:false` };
  });

  await check('open: the audit line names the time, the path and the action (§13.2.6)', async () => {
    const lines = auditLines(out());
    must(lines.length > 0, 'at least the launch above must be logged');
    const line = lines[lines.length - 1];
    eqJson(Object.keys(line).sort(), ['action', 'argv', 'path', 'pid', 'time'], 'the audit line carries exactly these fields');
    eq(line.action, 'reveal', 'action');
    must(Number.isFinite(Date.parse(line.time)), `time must be a parseable timestamp, got ${JSON.stringify(line.time)}`);
    must(Number.isFinite(line.pid) || line.pid === null, `pid must be a number (or null when the child is already gone), got ${JSON.stringify(line.pid)}`);
    for (const banned of ['exit', 'exitCode', 'code', 'success', 'ok']) {
      must(!(banned in line), `the audit line must not carry ${banned}: §13.0 measured that the exit code says nothing`);
    }
    return { detail: `${new Date(line.time).toISOString()} action=${line.action} path="${line.path}"` };
  });

  // ── §13.2 errata 9: the shell gets native form ─────────────────────────────

  await check('open: the shell is handed NATIVE form — a forward-slash directory must arrive with backslashes (errata 9)', async () => {
    // The measured defect this case exists for: explorer.exe does not accept forward
    // slashes, so `open` with `C:/…/dir` opened **Documents** while the answer said
    // 200 "handed to the system" — three runs, the same wrong window. The assertion is
    // the SPAWNED ARGV, never the HTTP code: the HTTP code was 200 in both worlds.
    const dir = await routeDirect('/api/open', { path: DIR_FS, action: 'open' });
    eq(dir.status, 200, `status for the forward-slash form ${DIR_FS}`);
    eq(dir.calls.length, 1, 'exactly one spawn');
    eqJson(dir.calls[0].args, [DIR_SPACES], 'the argv element is the BACKSLASH form of the same directory');
    must(!dir.calls[0].args[0].includes('/'), `no forward slash may reach the shell, got ${JSON.stringify(dir.calls[0].args[0])}`);
    eq(dir.json.path, DIR_SPACES, 'the reply echoes the NORMALISED path that was handed over');
    must(dir.json.path !== DIR_FS, 'never the raw request string (errata 9)');
    eqJson(dir.calls[0].args, [dir.json.path], 'and the echo is exactly what was spawned, not a third spelling');
    // A file, with the prefix the reveal action needs.
    const rev = await routeDirect('/api/open', { path: FILE_FS, action: 'reveal' });
    eq(rev.status, 200, 'a forward-slash file exists and may be revealed');
    eqJson(rev.calls[0].args, ['/select,' + FILE_PLAIN], '"/select," takes the native form too — one element, whole path');
    // An MSYS candidate (§13.2.2 names `/c/…`), read as the drive it names.
    const msys = await routeDirect('/api/open', { path: '/c/Windows', action: 'open' });
    eq(msys.status, 200, '/c/Windows must resolve to C:\\Windows');
    eqJson(msys.calls[0].args, ['C:\\Windows'], 'the MSYS form is handed over as the native path it names');
    eq(msys.json.path, 'C:\\Windows', 'and echoed as such');
    // The two shapes Hermes measured THROUGH THE LIVE UI, both of which opened
    // Documents before this fix: forward slashes with a trailing one, and a mixed form
    // with a trailing backslash. The trailing separator names no component, so the
    // spelling handed over is the native one without it — the spelling whose
    // correctness is measured live.
    for (const [what, asked] of [
      ['forward slashes with a trailing one (the live click)', DIR_FS + '/'],
      ['a mixed form with a trailing backslash (the corpus)', DIR_SPACES.replace('\\', '/') + '\\'],
      ['forward slashes with a trailing backslash', DIR_FS + '\\'],
    ]) {
      const r = await routeDirect('/api/open', { path: asked, action: 'open' });
      eq(r.status, 200, `${what}: ${asked} must be a directory that exists`);
      eqJson(r.calls[0].args, [DIR_SPACES], `${what}: the argv is the native form with no trailing separator`);
      must(!r.calls[0].args[0].includes('/'), `${what}: no forward slash may reach the shell`);
      must(!/[\\/]$/.test(r.calls[0].args[0]), `${what}: a trailing separator is dropped before the shell sees it`);
      eq(r.json.path, DIR_SPACES, `${what}: the echo is the normalised path that was handed over`);
    }
    // And such a path is still a DIRECTORY for the refusal rule: reveal on it is a 400.
    const revTrailing = await routeDirect('/api/open', { path: DIR_FS + '/', action: 'reveal' });
    eq(revTrailing.status, 400, 'reveal on a directory named with a trailing slash is still a 400');
    eq(revTrailing.json.error.code, 'bad_request', 'with the code the menu shows verbatim');
    eq(revTrailing.calls.length, 0, 'and nothing is spawned for it');
    // pathinfo agrees: the same directory, stated as a dir, whichever way it is spelled.
    const spelled = await request('POST', '/api/pathinfo', {
      headers: SAME_ORIGIN,
      body: { paths: [DIR_SPACES, DIR_FS, DIR_FS + '/', DIR_SPACES + '\\', DIR_SPACES + '/'] },
    });
    eq(spelled.status, 200, 'pathinfo status');
    eqJson(spelled.json.items.map((i) => i.kind), ['dir', 'dir', 'dir', 'dir', 'dir'], 'every spelling is the same directory');
    eqJson(spelled.json.items.map((i) => i.exists), [true, true, true, true, true], 'and none of them is "missing"');
    // Existence is decided on the normalised path: a forward-slash path that is not
    // there is refused, not handed over in a form the shell would misread.
    const missingFs = MISSING.replace(/\\/g, '/');
    const gone = await routeDirect('/api/open', { path: missingFs, action: 'open' });
    eq(gone.status, 404, `a forward-slash path that does not exist → 404 (${missingFs})`);
    eq(gone.calls.length, 0, 'and nothing is spawned for it');
    must(localAudit.length >= 4, `the module must have logged its own actions, got ${localAudit.length}`);
    const msysLine = localAudit.filter((l) => l.requested === '/c/Windows').pop();
    must(msysLine, 'the MSYS call must be in the local audit');
    eq(msysLine.path, 'C:\\Windows', 'the audit line records the normalised path that was handed over');
    eq(msysLine.requested, '/c/Windows', 'and the raw request beside it, so the normalisation is visible in the audit');
    eqJson(msysLine.argv, ['explorer.exe', 'C:\\Windows'], 'and the argv it really ran, which is the two-element native form');
    // The rule over EVERY spawn this suite has made: element 1 is a native path (or a
    // "/select," prefix followed by one). Nothing else may reach a process.
    const bad = localAudit.filter((l) => !(!String(l.argv[1]).includes('/') || String(l.argv[1]).startsWith('/select,')));
    eqJson(bad.map((l) => l.argv), [], 'no spawn may be handed a forward slash outside the "/select," prefix');
    return { detail: `${DIR_FS} → argv ${JSON.stringify([DIR_SPACES])}; /c/Windows → C:\\Windows; a missing forward-slash path → 404` };
  });

  await check('pathinfo: slashes, an MSYS form and the \\\\?\\ namespace all answer about the right file (§13.2.3)', async () => {
    const ns = '\\\\?\\' + FILE_PLAIN;
    const r = await request('POST', '/api/pathinfo', {
      headers: SAME_ORIGIN,
      body: { paths: [DIR_FS, FILE_FS, '/c/Windows', ns, DIR_FS.toUpperCase()] },
    });
    eq(r.status, 200, 'every one of these shapes must be ANSWERED, never a 500');
    eqJson(r.json.items.map((i) => i.exists), [true, true, true, true, true], 'all five name something real');
    eqJson(r.json.items.map((i) => i.kind), ['dir', 'file', 'dir', 'file', 'dir'], 'and are stated as what they are');
    eqJson(r.json.items.map((i) => i.path), [DIR_FS, FILE_FS, '/c/Windows', ns, DIR_FS.toUpperCase()],
      'each item echoes the string that was asked — it is the key a client matches its own candidate by');
    return { detail: `${DIR_FS} + ${FILE_FS} + /c/Windows + \\\\?\\… all stated, each echoing what was asked` };
  });

  await check('pathinfo: UNC, the namespace form, and the trailing space/dot the shell strips but fs does not (§13.2.3)', async () => {
    // Both sides measured here, so the divergence is evidence and not a claim: cmd
    // resolves a trailing space or dot, Node's fs answers ENOENT, and this endpoint
    // reports what IT stat'ed — errata 9 forbids rewriting the path further.
    eqJson(shellResolves(path.basename(FILE_PLAIN) + ' '), [path.basename(FILE_PLAIN)], 'cmd itself resolves "plain.txt " to plain.txt');
    eqJson(shellResolves(path.basename(FILE_PLAIN) + '.'), [path.basename(FILE_PLAIN)], 'and "plain.txt." likewise');
    const ns = '\\\\?\\' + FILE_PLAIN;
    const r = await request('POST', '/api/pathinfo', {
      headers: SAME_ORIGIN,
      body: { paths: [FILE_PLAIN + ' ', FILE_PLAIN + '.', ns + ' ', ns, '\\\\localhost\\C$', '\\\\localhost\\C$\\nope-w1-xyz'] },
    });
    eq(r.status, 200, 'UNC and namespace shapes are answered, not thrown at');
    const [spaced, dotted, nsSpaced, nsFile, share, shareMissing] = r.json.items;
    // The namespace prefix means "read this literally", so a trailing space there is
    // part of the name and there is no such name: false on both sides, for the same reason.
    eqJson([nsSpaced.exists, nsSpaced.kind], [false, null], '\\\\?\\…plain.txt (trailing space) is ENOENT inside the namespace — the prefix turns the strip off');
    eqJson([nsFile.exists, nsFile.kind], [true, 'file'], 'the namespace form of the real file is stated normally');
    // Without the prefix the shell would strip; this endpoint does not rewrite, so it
    // reports the string it stat'ed. Honest, and in the safe direction: the path stays
    // plain text instead of becoming a link that opens something else.
    eqJson([spaced.exists, spaced.kind], [false, null], 'a trailing space is not a name this stat can find: answered false, not silently rewritten to the stripped path');
    eqJson([dotted.exists, dotted.kind], [false, null], 'the same for a trailing dot');
    eqJson([share.exists, share.kind], [true, 'dir'], '\\\\localhost\\C$ resolves on this machine and is a directory');
    eqJson([shareMissing.exists, shareMissing.kind], [false, null], 'a missing name inside it is answered false');
    note('pathinfo: a path with a trailing space or dot answers exists:false here while cmd (and Explorer) would resolve it — Node\'s fs reads paths in the \\\\?\\ style and does not strip, and errata 9 forbids rewriting the string further. Safe direction: the text stays plain, no wrong window.');
    return { detail: `UNC admin share dir ✓, missing below it ✓, \\\\?\\ literal ✓, trailing space/dot answered as stat'ed (false) with cmd's opposite opinion measured above` };
  });

  await check('pathinfo: a path longer than 260 characters is stated honestly (§13.2.3)', async () => {
    must(LONG_FILE.length > 260, `the fixture must really exceed 260 characters, got ${LONG_FILE.length}`);
    const longMissing = path.join(LONG_DIR, 'nope-w1-xyz.txt');
    const nsLong = '\\\\?\\' + LONG_FILE;
    const r = await request('POST', '/api/pathinfo', {
      headers: SAME_ORIGIN,
      body: { paths: [LONG_FILE, LONG_DIR, nsLong, longMissing] },
    });
    eq(r.status, 200, `a ${LONG_FILE.length}-character path is a valid request (the cap is ${paths.LIMITS.MAX_PATH_CHARS})`);
    eqJson(r.json.items.map((i) => [i.exists, i.kind]),
      [[true, 'file'], [true, 'dir'], [true, 'file'], [false, null]],
      'the long file and its long directory are found; the long-namespace form too; a missing one inside it is false');
    // `open` must hand the long path over untouched — native already, so nothing to rewrite.
    const open = await routeDirect('/api/open', { path: LONG_FILE, action: 'open' });
    eq(open.status, 200, 'and a long path may be handed over');
    eqJson(open.calls[0].args, [LONG_FILE], 'as ONE argv element, unmodified');
    // Cleanup is part of the check: a long tree that cannot be removed would poison the
    // next run's fixture build, so it is removed and its removal asserted here.
    fs.rmSync(path.join(TMP, 'deep'), { recursive: true, force: true });
    must(!fs.existsSync(LONG_DIR), 'the long fixture is removable (otherwise every later run inherits it)');
    note(`pathinfo: the >260-character case is real on this machine (plain ${LONG_FILE.length} chars, no \\\\?\\ needed — node's fs applies the long-path form itself); the namespace form answers identically.`);
    return { detail: `${LONG_FILE.length}-char file=file, ${LONG_DIR.length}-char dir=dir, no throw, removed afterwards` };
  });

  await check('pathinfo/open: a directory junction is a DIRECTORY (§13.2.3, §13.2.5)', async () => {
    const why = makeJunction();
    must(why === null, `this machine must be able to create a directory junction (mklink /J needs no elevation): ${why}`);
    const j = await paths.info(JUNC);
    eqJson([j.exists, j.kind], [true, 'dir'], 'a junction to a directory is reported as kind:"dir" (the stat follows the reparse point)');
    // §13.2.5: reveal is files-only, so a junction to a directory must be refused as a
    // directory — over HTTP, the way the menu meets it.
    const rev = await request('POST', '/api/open', { headers: SAME_ORIGIN, body: { path: JUNC, action: 'reveal' } });
    eq(rev.status, 400, 'reveal on a junction-to-a-directory → 400, the same as on any directory');
    eq(rev.json.error.code, 'bad_request', 'with the code the menu shows verbatim');
    const open = await routeDirect('/api/open', { path: JUNC, action: 'open' });
    eq(open.status, 200, 'open on it is allowed (a directory may be opened)');
    eqJson(open.calls[0].args, [JUNC], 'and the junction is handed over as itself, one element');
    // Cleanup: rmdir removes the link, not the target's contents.
    try {
      fs.rmdirSync(JUNC);
      must(!fs.existsSync(JUNC), 'the junction link is gone');
      must(fs.existsSync(JUNC_TARGET), "and removing the link must not touch the directory it pointed at");
    } catch (e) {
      note(`pathinfo: the junction fixture could not be removed with rmdirSync (${e.code || e.message}) — it lives inside the suite's own scratch dir, which the next run rebuilds.`);
    }
    return { detail: 'junction → dir; reveal → 400; open → the junction itself; link removed without touching its target' };
  });

  await check('pathinfo: one directory spelled three ways cannot contradict itself (§13.2.3)', async () => {
    // Windows matches case-insensitively (measured), so these are one directory. The
    // slash spellings share a cache entry because the module normalises them; the case
    // spellings do not, because folding case would be a lie on a case-sensitive
    // directory — either way the two answers must agree.
    paths._clearCache();
    const slash = await paths.info('C:/WINDOWS');
    const backslash = await paths.info('C:\\WINDOWS');
    eqJson([backslash.exists, backslash.kind], [slash.exists, slash.kind], 'the two slash spellings answer identically');
    eq(paths._cacheSize(), 1, 'and share one cache entry, so they cannot drift apart');
    const lower = await paths.info('c:\\windows');
    eqJson([lower.exists, lower.kind], [slash.exists, slash.kind], 'c:\\windows and C:\\WINDOWS are one directory and must not contradict each other');
    eq(paths._cacheSize(), 2, 'case is deliberately not folded in the key, yet the answers still agree');
    // Same claim on a repo-local fixture, so this does not depend on the system dir alone.
    const upper = await paths.info(TMP.toUpperCase());
    const normal = await paths.info(TMP);
    eqJson([upper.exists, upper.kind], [normal.exists, normal.kind], 'a fixture directory spelled in two cases answers the same way');
    eqJson([normal.exists, normal.kind], [true, 'dir'], 'and it is a directory in both');
    return { detail: `C:/WINDOWS, C:\\WINDOWS (1 cache entry), c:\\windows (2 entries) — same verdict; fixture uppercased too` };
  });

  await check('pathinfo: a stat that never answers is answered by the deadline, and blocks nothing (§13.2.3)', async () => {
    // The measured reason this endpoint is asynchronous: `fs.statSync` of a path on an
    // unreachable UNC host blocked its caller for 42,155 ms, and the server is ONE
    // thread — a synchronous stat here freezes /api/chat and every other endpoint for
    // that long, while a batch of 200 such paths freezes it for hours. A real host
    // cannot be made to stall on demand (the OS remembers, see the check below), so the
    // stall is injected: the seam is the same shape as the injectable spawner, and
    // production always gets `fs.promises.stat`. Both halves are deterministic here —
    // the deadline answers, and a timer that was already scheduled still fires while
    // the call is in flight. That is what a synchronous stat would break.
    paths._setStatImpl(() => new Promise(() => {}));
    try {
      paths._clearCache();
      const before = localUndecided.length;
      let ticked = null;
      const tick = setTimeout(() => { ticked = Date.now(); }, DEADLINE_MS - 150);
      const t0 = Date.now();
      const v = await paths.info(path.join(TMP, 'never-answers.txt'));
      const dt = Date.now() - t0;
      clearTimeout(tick);
      eqJson([v.exists, v.kind], [false, null], 'a stat that never answers is answered exists:false — §13.2.3 has no third state');
      must(dt >= DEADLINE_MS - 25, `the answer must come from the deadline, took ${dt} ms for a ${DEADLINE_MS} ms deadline`);
      must(dt < DEADLINE_MS + 400, `and be the deadline and nothing slower, took ${dt} ms`);
      must(ticked !== null && ticked - t0 < DEADLINE_MS - 100, `the event loop must stay free while the stat is in flight (a blocking stat would have starved the timer): ticked at ${ticked ? ticked - t0 : 'never'} ms`);
      // The same thing through the HTTP route, with a stalling stat: the whole batch is
      // bounded by the deadline and every item is still answered.
      const r = await routeDirect('/api/pathinfo', { paths: [FILE_PLAIN, path.join(TMP, 'never-2.txt')] });
      eq(r.status, 200, 'a request whose stats never answer still answers');
      eqJson(r.json.items.map((i) => [i.exists, i.kind]), [[false, null], [false, null]], 'and answers every path in it');
      eq(localUndecided.length, before + 3, 'each of the three undecidable paths (one direct, two in the batch) is logged, so "could not tell" stays distinguishable from "not there"');
      const line = localUndecided[localUndecided.length - 1];
      eq(line.undecided, true, 'the line says what happened');
      eq(line.after_ms, DEADLINE_MS, 'and with which deadline');
      must(Number.isFinite(Date.parse(line.time)), `the line is timestamped, got ${JSON.stringify(line.time)}`);
    } finally {
      paths._resetStatImpl();
      paths._clearCache();
    }
    return { detail: `injected stall: answered at ${DEADLINE_MS} ms, timer fired on time, 3 logged as undecided, seam restored` };
  });

  await check('pathinfo: a real unreachable UNC host is answered honestly, and the server keeps serving (§13.2.3)', async () => {
    // The same property against the real network, where the answer is evidence about
    // THIS machine rather than about a seam: an unroutable address (TEST-NET-1). The
    // timing of the platform is what it is and is not asserted as a constant — measured
    // cold, one synchronous stat of such a path blocked for 42,155 ms; measured warm,
    // the redirector answers ENOENT in ~1 ms from its own negative cache. So the
    // assertions here are the ones that hold either way: the call is BOUNDED, the answer
    // is the honest one, and /api/health keeps answering while it is in flight.
    const started = Date.now();
    const pending = request('POST', '/api/pathinfo', {
      headers: SAME_ORIGIN,
      body: { paths: [UNC_SLOW, FILE_PLAIN] },
      timeoutMs: 15000,
    });
    await sleep(60);
    const health = await request('GET', '/api/health', { headers: {}, timeoutMs: DEADLINE_MS + 1500 });
    const healthMs = Date.now() - started;
    eq(health.status, 200, 'the server must answer /api/health while a host that may never answer is being stat\'ed');
    must(healthMs < DEADLINE_MS + 900, `and answer it promptly, took ${healthMs} ms against a ${DEADLINE_MS} ms path deadline`);
    const r = await pending;
    const elapsed = Date.now() - started;
    eq(r.status, 200, 'the pathinfo call itself answers');
    eqJson(r.json.items.map((i) => [i.exists, i.kind]), [[false, null], [true, 'file']],
      'the unreachable path is answered exists:false, and the real file beside it is still answered honestly');
    must(elapsed < DEADLINE_MS + 3000, `the whole call must be bounded by the deadline, took ${elapsed} ms (a blocking stat took 42,155 ms on this machine)`);
    await sleep(200);
    const fromServer = out().split(/\r?\n/).filter((l) => l.startsWith('[hd-pathinfo] '));
    if (fromServer.length > 0) {
      const line = JSON.parse(fromServer[fromServer.length - 1].slice('[hd-pathinfo] '.length));
      eq(line.undecided, true, 'the server logged the undecidable path');
      eq(line.path, UNC_SLOW, 'and named it');
      eq(line.after_ms, DEADLINE_MS, 'with the deadline it waited');
      note(`pathinfo: ${UNC_SLOW} was undecidable at the ${DEADLINE_MS} ms deadline in the server — the platform fact the asynchronous stat exists for (the same stat, synchronous, blocked its caller for 42,155 ms on this machine).`);
    } else {
      note(`pathinfo: this run the OS answered ${UNC_SLOW} from its own negative cache before the deadline (measured: ~1 ms warm against 42,155 ms cold) — the answer is still the honest false, and the check above proves the deadline itself deterministically.`);
    }
    // The module-level answer, through the same path the server takes.
    const t0 = Date.now();
    const v = await paths.info(UNC_UNREACHABLE);
    const dt = Date.now() - t0;
    eqJson([v.exists, v.kind], [false, null], 'an unroutable host is answered as not-there (never thrown, never a 500)');
    must(dt < DEADLINE_MS + 2500, `and bounded by the deadline, took ${dt} ms`);
    return { detail: `health answered in ${healthMs} ms while the path was pending; pathinfo answered in ${elapsed} ms; module-level unc answer in ${dt} ms; ${fromServer.length > 0 ? 'deadline logged' : 'OS cache answered'}` };
  });

  await check('api: the gate runs before the body is read, and a wrong method says so', async () => {
    // Invalid JSON with no header: the gate must answer 403, not a parse error —
    // that is the observable difference between "before" and "after" the body.
    const gated = await request('POST', '/api/pathinfo', {
      headers: { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin' },
      body: 'this is not json',
    });
    eq(gated.status, 403, 'no header + unparsable body → the gate answers first');
    const parsed = await request('POST', '/api/pathinfo', { headers: SAME_ORIGIN, body: 'this is not json' });
    eq(parsed.status, 400, 'with the header, the body is read and rejected honestly');
    for (const route of ['/api/pathinfo', '/api/open']) {
      const g = await request('GET', route, { headers: SAME_ORIGIN });
      eq(g.status, 405, `GET ${route} → 405`);
      eq(g.headers.allow, 'POST', `${route} names the allowed method`);
    }
    const empty = await request('POST', '/api/pathinfo', { headers: SAME_ORIGIN, body: { paths: [] } });
    eq(empty.status, 200, 'an empty batch is a valid (empty) answer, not an error');
    eqJson(empty.json.items, [], 'items');
    return { detail: '403 before the body, 400 after it, 405 for GET with allow: POST' };
  });

  await check('cleanup: the test port is free again', async () => {
    killChild(server.proc);
    server = null;
    for (let i = 0; i < 40; i++) {
      if (!(await listening(PORT))) return { detail: `${PORT} is free` };
      await sleep(100);
    }
    throw new Fail(`${PORT} is still answering after the server was killed`);
  });

  // ── the report ────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.passed).length;
  console.log('');
  for (const n of notes) console.log(`NOTE ${n}`);
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  if (pass !== results.length) {
    console.log('');
    for (const r of results) if (!r.passed) console.log(`  FAILED: ${r.name} — ${r.detail}`);
  }
  report(pass === results.length ? 0 : 1);
}

function report(code) {
  process.exitCode = code;
  killChild(server && server.proc);
  try { http.globalAgent.destroy(); } catch (e) { /* nothing pooled */ }
  const t = setTimeout(() => process.exit(code), 400);
  t.unref();
}

main().catch((e) => {
  console.error(`harness failed: ${(e && e.message) || e}`);
  console.error(`completed before the failure: ${results.map((r) => `${r.passed ? 'P' : 'F'}:${r.name}`).join(' | ') || '(none)'}`);
  report(1);
});
