#!/usr/bin/env node
// herdr-dash round-7.7 harness — CONTRACT-v2 §10 (POST /api/attach) + §11.3 — owner: W1.
//
// Zero dependencies beyond node itself: the fixture server is this repo's own
// src/server.js, started with the same env seams the other suites use.
//
// WHAT THIS PROVES, AND HOW
//
//   Real bytes on a real disk. Every upload is a real HTTP request with a real
//   body, and every assertion is made against the FILE SYSTEM — existsSync,
//   statSync, readFileSync, readdirSync — never against the server's own claim
//   about itself. The reply's `path` is compared with the bytes that were sent,
//   and the traversal suite ends by listing the whole attachment root.
//
//   The root is a lie detector, not a parameter. The server is started with
//   HD_ATTACH_ROOT inside this repo's _scratch, so "nothing was written outside
//   the root" is checkable: the root is walked, every file under it is checked
//   for a name that is one legal path component, and the repo's own tree plus a
//   stand-in for "a pane's cwd" are snapshotted before the first upload and
//   compared after the last one.
//
//   §13.4 item 1 moved the store off app data on C: and into the app's own
//   _cache/attachments. A fourth instance runs with the seam UNSET, so the
//   shipped default is proved by a real upload rather than by reading the code:
//   the file lands under <repo>/_cache/attachments, the reply's path is still
//   absolute, and it is nowhere near LOCALAPPDATA. That check removes what it
//   created; `_cache` is the one folder the repo-tree walk skips, because it is
//   where the store now belongs.
//
//   The cap is proved twice, because it is two code paths: a declared
//   content-length over the cap (a browser sending a big file — refused before a
//   byte is read, and the connection must survive for the next upload) and a
//   chunked body that crosses the cap mid-stream (the file exists by then, so
//   the check is that it is GONE afterwards).
//
//   The stamp is frozen (HD_ATTACH_STAMP) on a second instance so that "the same
//   name twice gets -2" is a fact rather than a race with the second boundary.
//
//   §11.3's single-flight is measured on a third instance whose mock herdr pipe
//   counts `pane.read` calls: a cold resolution reads the pane twice, so two
//   concurrent requests that produce TWO reads ran ONE resolution, and the reply
//   header `x-hd-session-scan` says which request paid for it (`fresh`) and which
//   one shared it (`joined`) or reused it (`cached`).
//
// Usage:
//   node test/attach.mjs [--port 7480]
//
//   <port> is the fixture instance, <port>+1 answers from a store that cannot be
//   written, <port>+2 has the frozen stamp and the mock pipe, <port>+3 is the
//   SHIPPED configuration (no HD_ATTACH_ROOT). All four are killed before the
//   harness exits and the ports are checked again.
//
// Exit code is 0 only when every check passed.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const attachModule = require('../src/attach.js');   // the sanitisers, unit by unit

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
const PORT = Number(flagValue('--port', '7480'));
const PORT_BAD_ROOT = PORT + 1;
const PORT_FROZEN = PORT + 2;
const PORT_DEFAULT = PORT + 3;                            // §13.4 item 1: no HD_ATTACH_ROOT
const BASE = `http://127.0.0.1:${PORT}`;
const BASE_BAD_ROOT = `http://127.0.0.1:${PORT_BAD_ROOT}`;
const BASE_FROZEN = `http://127.0.0.1:${PORT_FROZEN}`;
const BASE_DEFAULT = `http://127.0.0.1:${PORT_DEFAULT}`;
const SPAWN_WAIT_MS = 20000;

const SCRATCH = path.join(REPO_ROOT, '_scratch', 'w1', 'attach');
const ROOT = path.join(SCRATCH, 'root');
const ROOT_FROZEN = path.join(SCRATCH, 'root-frozen');
const BLOCKED_FILE = path.join(SCRATCH, 'not-a-directory');
const BLOCKED_ROOT = path.join(BLOCKED_FILE, 'attachments');
const PANE_CWD = path.join(SCRATCH, 'pane-cwd');          // stands in for a pane's workspace
const PROJECTS = path.join(SCRATCH, 'projects');          // CLAUDE_PROJECTS_DIR for §11.3

const FROZEN_STAMP = '20260925T113000Z';                  // §10.4's own example
const MAX_BYTES = 25 * 1024 * 1024;
const CACHE_MS = 800;                                     // §11.3's TTL, shortened for the test

const COLD_PANE = 'w2:cold';                              // the pane §11.3's checks ask about
const SESS_COLD = 'aa11bb22-cc33-dd44-ee55-ff6677889900';
const CWD_COLD = PANE_CWD;                                // the cwd the mock herdr reports

/** §13.4 item 1's shipped default: `<app root>/_cache/attachments`, app-relative. */
const APP_ROOT = REPO_ROOT;
const DEFAULT_ROOT = path.join(APP_ROOT, '_cache', 'attachments');
/** The one list both repo-tree walks use. It lived twice for a moment and the two
 *  copies drifted immediately (the "gained files" check failed on a folder it was
 *  told to ignore), so it is one constant with one meaning: `_cache` is the store's
 *  home now, and `_scratch`/`node_modules`/`.git` are never part of the app's tree. */
const REPO_WALK_SKIP = new Set(['_scratch', 'node_modules', '.git', '_cache']);

// ---------------------------------------------------------------- check runner

class Fail extends Error {}
const must = (cond, message) => { if (!cond) throw new Fail(message); };
const eq = (got, want, what) => {
  if (got !== want) throw new Fail(`${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};

const results = [];
const notes = [];
let currentCheck = '(startup)';

async function check(name, fn) {
  currentCheck = name;
  let passed = false;
  let detail = '';
  const started = Date.now();
  try {
    const r = await fn();
    if (r && typeof r === 'object') {
      passed = 'ok' in r ? !!r.ok : true;
      detail = r.detail || '';
    } else {
      passed = r !== false;
    }
  } catch (e) {
    passed = false;
    detail = e instanceof Fail ? e.message : `unexpected ${(e && e.name) || 'error'}: ${(e && e.message) || String(e)}`;
  }
  results.push({ name, passed, detail });
  const ms = Date.now() - started;
  const note = detail ? ` — ${detail.length > 200 ? `${detail.slice(0, 197)}…` : detail}` : '';
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${passed ? note : ` — ${detail}`}${ms > 400 && passed ? ` [${ms}ms]` : ''}`);
  return passed;
}

// ---------------------------------------------------------------- process + http

const children = [];
let mockPipe = null;
function killChild(c) {
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  try { c.kill(); } catch { /* ignore */ }
  setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } }, 1500).unref();
}
function killAll() { while (children.length) killChild(children.pop()); }
process.on('exit', killAll);

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
  // Never test a server this harness did not start: a leftover process answers
  // every request and the checks then report on the WRONG build. (Measured in
  // this round: another worker's harness was listening on the first port tried.)
  if (await listening(port)) {
    throw new Fail(`something is already listening on ${port} — refusing to test a server this harness did not start (stop it, or pass --port)`);
  }
  const proc = spawn(process.execPath, ['src/server.js', '--port', String(port)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: Object.assign({}, process.env, env || {}),
  });
  children.push(proc);
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
    if (await listening(port)) return { proc, banner: out.trim().split(/\r?\n/)[0] || '(no listen line)' };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Fail(`the ${label} server on ${port} was not listening within ${SPAWN_WAIT_MS}ms; output: ${out.trim().slice(0, 400) || '(none)'}`);
}

/** POST /api/attach with a real body. Never throws: the failure IS the assertion. */
function postAttach({ base = BASE, name, pane, body, headers = {}, chunks = null, agent = undefined, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const payload = body || Buffer.alloc(0);
    const h = Object.assign({}, headers);
    if (name !== undefined) h['x-hd-name'] = name;
    if (pane !== undefined) h['x-hd-pane'] = pane;
    if (chunks === null) h['content-length'] = String(payload.length);
    else h['content-length'] = String(chunks.total);
    const u = new URL(`${base}/api/attach`);
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({
      method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: h,
      agent: agent === undefined ? undefined : agent,
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        finish({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', (e) => finish({ error: `response error: ${e.message}` }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ error: `timed out after ${timeoutMs}ms` }); });
    req.on('error', (e) => finish({ error: `${e.code || 'network error'}: ${e.message}` }));
    if (chunks === null) {
      if (payload.length) req.write(payload);
      req.end();
      return;
    }
    // A body larger than the cap, written in pieces (no content-length: chunked).
    const piece = Buffer.alloc(Math.min(1024 * 1024, chunks.total), 0x41);
    let sent = 0;
    const pump = () => {
      while (sent < chunks.total) {
        const take = Math.min(piece.length, chunks.total - sent);
        sent += take;
        if (!req.write(take === piece.length ? piece : piece.subarray(0, take))) return req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });
}

/**
 * A body with NO content-length: node frames it chunked, which is the only way to
 * make the server meet the cap while it is already streaming (a browser streaming
 * a file of unknown length does the same). The whole body is sent — a client that
 * lies about its length and then stops talking is a malformed client, not a case
 * worth writing a test around.
 */
function postAttachNoLength({ name, pane, total, base = BASE }) {
  return new Promise((resolve) => {
    const u = new URL(`${base}/api/attach`);
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({
      method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname,
      headers: { 'x-hd-name': name, 'x-hd-pane': pane },
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        finish({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(60000, () => { req.destroy(); finish({ error: 'timed out' }); });
    req.on('error', (e) => finish({ error: `${e.code}: ${e.message}` }));
    const piece = Buffer.alloc(1024 * 1024, 0x42);
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        const take = Math.min(piece.length, total - sent);
        sent += take;
        if (!req.write(take === piece.length ? piece : piece.subarray(0, take))) return req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });
}

/** A JSON GET, for the §11.3 half. */
function getJson(url, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        finish({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ error: `timed out after ${timeoutMs}ms` }); });
    req.on('error', (e) => finish({ error: `${e.code || 'network error'}: ${e.message}` }));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const listDir = (p) => { try { return fs.readdirSync(p); } catch { return []; } };
const paneDir = (dir, pane) => path.join(dir, attachModule.sanitizePane(pane).pane);

/** Every file below `dir`, as paths relative to it (bounded, so a runaway tree
 *  cannot hang the suite). */
function walk(dir, { skip = new Set(), max = 20000 } = {}) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < max) {
    const rel = stack.pop();
    const abs = rel ? path.join(dir, rel) : dir;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const child = rel ? path.join(rel, e.name) : e.name;
      out.push(child);
      if (e.isDirectory()) stack.push(child);
    }
  }
  return out.sort();
}
const diffList = (before, after) => {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((x) => !b.has(x)),
    removed: before.filter((x) => !a.has(x)),
  };
};

// ---------------------------------------------------------------- mock herdr pipe (§11.3)
/**
 * Only what the §11.3 check needs: `agent.list` with one claude pane, a snapshot
 * carrying its cwd, and a `pane.read` that answers with empty text (so the
 * resolver's banner step finds nothing and herdr's own record is the winner —
 * which is not the point of the check; the point is that the COLD PATH, candidate
 * scan included, runs once). Every request is recorded, so `pane.read` can be
 * counted, and one cold resolution reads the pane exactly twice.
 */
function startMockPipe(agents, paneTexts, paneCwd) {
  return new Promise((resolve) => {
    const name = `herdr-dash-attachtest-${process.pid}-${Date.now()}`;
    const sockets = new Set();
    const calls = [];
    const texts = paneTexts || new Map();
    const snapshot = {
      version: '0.0.0-mock', protocol: 22,
      focused_workspace_id: 'w2', focused_tab_id: 'w2:t1', focused_pane_id: agents[0].pane_id,
      workspaces: [], tabs: [], layouts: [],
      panes: agents.map((a) => ({ pane_id: a.pane_id, cwd: paneCwd, workspace_id: 'w2', tab_id: 'w2:t1' })),
    };
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.on('error', () => sockets.delete(sock));
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          const params = msg.params || {};
          calls.push({ method: msg.method, params });
          const reply = (result) => {
            if (sock.destroyed) return;
            sock.write(JSON.stringify({ id: msg.id, result }) + '\n');
            if (msg.method !== 'events.subscribe') sock.end();
          };
          if (msg.method === 'session.snapshot') reply({ snapshot });
          else if (msg.method === 'agent.list') reply({ agents, type: 'agent_list' });
          else if (msg.method === 'events.subscribe') reply({ type: 'subscription_started' });
          else if (msg.method === 'pane.list') reply({ panes: [] });
          else if (msg.method === 'pane.read') {
            const t = texts.get(params.pane_id) || {};
            const text = params.source === 'visible' ? (t.visible || '') : (t.recent || '');
            reply({
              type: 'pane_read',
              read: {
                pane_id: params.pane_id, workspace_id: 'w2', tab_id: 'w2:t1',
                source: params.source, format: 'text', text, revision: 1, truncated: false,
              },
            });
          } else if (msg.method === 'pane.report_agent_session') reply({ type: 'ok' });
          else reply({ ok: true });
        }
      });
    });
    server.on('error', (e) => resolve({ error: e.message, close: async () => {} }));
    server.listen('\\\\.\\pipe\\' + name, () => {
      resolve({
        name, calls, agents, texts,
        reads: () => calls.filter((c) => c.method === 'pane.read').length,
        close: () => new Promise((done) => {
          for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
          server.close(() => done());
        }),
      });
    });
  });
}

/** A claude conversation whose records PROVE the pane's cwd (§8.1's rule). */
function buildClaudeFixture() {
  rmrf(PROJECTS);
  const dir = path.join(PROJECTS, 'proj-cold');
  fs.mkdirSync(dir, { recursive: true });
  const rec = (type, uuid, content) => JSON.stringify({
    parentUuid: null, isSidechain: false, type, uuid,
    timestamp: '2026-09-25T11:30:00.000Z', sessionId: SESS_COLD, cwd: CWD_COLD, version: '2.1.280',
    message: { role: type, content },
  });
  const lines = [
    rec('user', 'u-1', 'a cold pane is asked about twice'),
    rec('assistant', 'a-1', [{ type: 'text', text: 'and answers once' }]),
  ];
  fs.writeFileSync(path.join(dir, `${SESS_COLD}.jsonl`), lines.join('\n') + '\n');
}

// ---------------------------------------------------------------- the checks

async function main() {
  rmrf(SCRATCH);
  buildClaudeFixture();
  // A pane's workspace, standing beside the store: the mock herdr reports it as
  // the pane's cwd, this suite snapshots it, and nothing may appear in it.
  fs.mkdirSync(PANE_CWD, { recursive: true });
  fs.writeFileSync(path.join(PANE_CWD, 'marker.txt'), 'a pane\'s workspace, not ours\n');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(ROOT_FROZEN, { recursive: true });
  fs.writeFileSync(BLOCKED_FILE, 'this path is a file, so nothing can be created inside it\n');

  // Snapshots taken before the first upload, compared after the last one. `_cache`
  // is skipped because it is where the store now BELONGS (§13.4 item 1) and this
  // suite deliberately writes there — the default-root check below proves those
  // writes land in exactly that folder rather than letting them slip past this walk
  // unremarked. Everything else in the tree must still be untouched.
  const repoBefore = walk(REPO_ROOT, { skip: REPO_WALK_SKIP });
  const paneCwdBefore = listDir(PANE_CWD);
  const coldSession = { pane_id: COLD_PANE, cwd: CWD_COLD, agent: 'claude', agent_status: 'idle',
    agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: SESS_COLD } };
  const mock = await startMockPipe([coldSession], new Map(), PANE_CWD);
  if (mock.error) throw new Fail(`mock pipe failed: ${mock.error}`);
  mockPipe = mock;

  const fixtureEnv = {
    HERDR_SOCKET_PATH: mock.name,
    CLAUDE_PROJECTS_DIR: PROJECTS,
    HERMES_STATE_DB: path.join(SCRATCH, 'no-hermes-state.db'),
    HD_ATTACH_ROOT: ROOT,
    CHAT_SESSION_CACHE_MS: String(CACHE_MS),
  };
  await startServer(PORT, fixtureEnv, 'fixture');
  // The failure surface needs its own instance: its root cannot be created.
  await startServer(PORT_BAD_ROOT, Object.assign({}, fixtureEnv, { HD_ATTACH_ROOT: BLOCKED_ROOT }), 'unwritable-root');
  // The collision rule needs the stamp to stand still.
  await startServer(PORT_FROZEN, Object.assign({}, fixtureEnv, { HD_ATTACH_ROOT: ROOT_FROZEN, HD_ATTACH_STAMP: FROZEN_STAMP }), 'frozen-stamp');
  // §13.4 item 1: the SHIPPED configuration — no HD_ATTACH_ROOT at all, so this
  // instance writes to the app's own _cache/attachments. The seam is deleted rather
  // than overwritten, because "unset" is the case being tested.
  const defaultEnv = Object.assign({}, fixtureEnv, { HD_ATTACH_STAMP: FROZEN_STAMP });
  delete defaultEnv.HD_ATTACH_ROOT;
  await startServer(PORT_DEFAULT, defaultEnv, 'default-root');

  // ── (a) the happy path ────────────────────────────────────────────────────
  await check('attach: a 1 KB file lands under the root, byte for byte, and the reply says where', async () => {
    const payload = Buffer.alloc(1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const r = await postAttach({ name: 'shot.png', pane: 'w9:happy', body: payload });
    must(r.status === 200, `expected HTTP 200, got ${r.status}: ${(r.text || r.error || '').slice(0, 200)}`);
    const j = r.json;
    must(j && j.ok === true, `the reply was not ok: ${JSON.stringify(j)}`);
    eq(Object.keys(j).sort().join(','), 'bytes,name,ok,path', 'the reply keys');
    eq(j.bytes, payload.length, 'bytes');
    eq(j.name, 'shot.png', 'name (what the store made of the client\'s name)');
    must(path.isAbsolute(j.path), `path is not absolute: ${j.path}`);
    must(j.path.startsWith(ROOT + path.sep), `path is not under the attachment root: ${j.path}`);
    must(fs.existsSync(j.path), `the reply's path does not exist: ${j.path}`);
    const onDisk = fs.readFileSync(j.path);
    must(onDisk.equals(payload), `the file is not the bytes that were sent (${onDisk.length} bytes on disk)`);
    must(/^\d{8}T\d{6}Z-shot\.png$/.test(path.basename(j.path)), `the stored basename should be <stamp>-shot.png, got ${path.basename(j.path)}`);
    return { detail: `${payload.length} bytes at ${path.relative(REPO_ROOT, j.path)}` };
  });

  // ── the shipped default root, end to end (§13.4 item 1) ───────────────────
  //
  // The three instances above are all pointed at _scratch with the seam, so on
  // their own they would pass just as happily if the DEFAULT were still app data on
  // C:. This one runs with HD_ATTACH_ROOT unset and asserts where the bytes really
  // landed — the user's actual case ("the C: path is hard to remember to clean").
  await check('attach §13.4: with no seam at all, the file lands in the app\'s own _cache/attachments', async () => {
    const payload = Buffer.from('the shipped default root, not app data on C:\n', 'utf8');
    const r = await postAttach({ base: BASE_DEFAULT, name: 'default-root.txt', pane: 'w1:default', body: payload });
    must(r.status === 200, `expected HTTP 200, got ${r.status}: ${(r.text || r.error || '').slice(0, 200)}`);
    const j = r.json;
    must(j && j.ok === true, `the reply was not ok: ${JSON.stringify(j)}`);
    must(path.isAbsolute(j.path), `the injected path must be absolute (§13.4 item 1): ${j.path}`);
    must(j.path.startsWith(DEFAULT_ROOT + path.sep),
      `the file is not under <app root>/_cache/attachments: ${j.path}`);
    must(fs.readFileSync(j.path).equals(payload), 'the stored bytes are not the bytes that were sent');
    must(path.dirname(j.path) === path.join(DEFAULT_ROOT, 'w1:default'.replace(':', '_')),
      `the pane directory should be the sanitised pane id: ${path.dirname(j.path)}`);
    const appData = process.env.LOCALAPPDATA || process.env.APPDATA
      || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local');
    must(!j.path.toLowerCase().startsWith(path.resolve(appData).toLowerCase() + path.sep),
      `§10.2's app-data store must not be written any more: ${j.path}`);
    // Clean up exactly what this check caused — the file it wrote, and its pane
    // directory only if this check's upload is what left it empty afterwards.
    fs.unlinkSync(j.path);
    try { fs.rmdirSync(path.dirname(j.path)); } catch (e) { /* still holds other files: leave it */ }
    must(!fs.existsSync(j.path), 'the check must not leave the file behind');
    return { detail: `${path.relative(REPO_ROOT, j.path)} (no HD_ATTACH_ROOT)` };
  });

  // ── (g) the path is the file, untouched ───────────────────────────────────
  await check('attach: the reply path IS the file — same bytes, no rewriting, one legal component', async () => {
    const payload = Buffer.alloc(4096);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 256;
    const r = await postAttach({ name: 'round-trip.bin', pane: 'w9:roundtrip', body: payload });
    must(r.status === 200, `HTTP ${r.status}: ${(r.text || r.error || '').slice(0, 200)}`);
    const p = r.json.path;
    eq(path.resolve(p), p, 'the path is already resolved (no . or .. left to rewrite)');
    eq(fs.realpathSync.native(p), p, 'the path is the file system\'s own spelling (no short name, no link)');
    eq(fs.readdirSync(path.dirname(p)).includes(path.basename(p)), true, 'the file is listed under exactly that basename');
    must(fs.readFileSync(p).equals(payload), 'reading the path back does not return the bytes that were sent');
    eq(fs.statSync(p).size, payload.length, 'size on disk');
    must(!/[\\/:*?"<>|]/.test(path.basename(p)), `the basename carries an illegal character: ${path.basename(p)}`);
    return { detail: `${path.relative(REPO_ROOT, p)} reads back identical` };
  });

  // ── (b) the cap, both paths ───────────────────────────────────────────────
  await check('attach: a body over 25 MiB is refused 413 with a reason, and leaves nothing behind', async () => {
    const before = listDir(paneDir(ROOT, 'w9:cap'));
    // (i) a browser's case: content-length declared, whole body sent.
    const over = await postAttach({ name: 'big.bin', pane: 'w9:cap', chunks: { total: MAX_BYTES + 1 } });
    must(over.status === 413, `expected HTTP 413 for ${MAX_BYTES + 1} bytes, got ${over.status}: ${(over.text || over.error || '').slice(0, 200)}`);
    const omsg = (over.json && over.json.error && over.json.error.message) || '';
    must(/\b25 MiB\b/.test(omsg), `the 413 must say what the limit is (the client shows this verbatim), got ${JSON.stringify(omsg)}`);
    must(/nothing was written/.test(omsg), `the 413 should say the store was left alone, got ${JSON.stringify(omsg)}`);
    eq(over.json.error.code, 'too_large', 'the 413 body\'s error code');
    must(!over.json.ok, 'the 413 body must be ok:false');
    eq(listDir(paneDir(ROOT, 'w9:cap')).join(','), before.join(','), 'the refused upload left a file behind');
    // The connection must survive a refusal: this is a keep-alive client's next upload.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
    try {
      const small = await postAttach({ name: 'after-cap.png', pane: 'w9:cap', body: Buffer.from('still works'), agent });
      must(small.status === 200, `the upload after a refusal failed: HTTP ${small.status} ${(small.text || small.error || '').slice(0, 200)}`);
    } finally { agent.destroy(); }
    // (ii) the mid-stream case: no content-length at all (a body whose size the
    // client does not know yet, which is what a streaming browser sends), so the
    // server meets the cap only while the bytes arrive. The file exists by then,
    // so the check is that it is gone afterwards.
    const chunkedBefore = listDir(paneDir(ROOT, 'w9:cap2'));
    const noCl = await postAttachNoLength({ name: 'streamed.bin', pane: 'w9:cap2', total: MAX_BYTES + 1 });
    must(noCl.status === 413, `a chunked body over the cap: expected 413, got ${noCl.status}: ${(noCl.text || noCl.error || '').slice(0, 200)}`);
    const cmsg = (noCl.json && noCl.json.error && noCl.json.error.message) || '';
    // ONE condition, ONE reason: §10.3 has the client show this text verbatim, and
    // it cannot know which path its own upload takes — so the two refusals must be
    // the same sentence, and the file must be gone before it is sent (the listings
    // above and below are what makes that claim true rather than aspirational).
    eq(cmsg, omsg, 'the declared and the streamed refusals must carry the same reason');
    eq(noCl.json.error.code, 'too_large', 'the mid-stream 413 body\'s error code');
    eq(listDir(paneDir(ROOT, 'w9:cap2')).join(','), chunkedBefore.join(','), 'the cut-off upload left a partial file behind');
    return { detail: `${MAX_BYTES + 1} bytes refused twice (declared, and streaming), no file either time` };
  });

  // ── (b) empty body / name / pane ─────────────────────────────────────────
  await check('attach: an empty body, an empty name, a missing pane and a long pane are 400 with reasons', async () => {
    const cases = [
      ['a 0-byte body', { name: 'empty.bin', pane: 'w9:empty', body: Buffer.alloc(0) }, /empty/i],
      ['a name of nothing but dots and spaces', { name: '   ...   ', pane: 'w9:empty', body: Buffer.from('x') }, /name/i],
      ['no name header at all', { name: undefined, pane: 'w9:empty', body: Buffer.from('x') }, /name/i],
      ['no pane header at all', { name: 'a.png', pane: undefined, body: Buffer.from('x') }, /pane/i],
      ['a pane id of only dots', { name: 'a.png', pane: '..', body: Buffer.from('x') }, /pane/i],
      ['a pane id longer than any pane', { name: 'a.png', pane: 'w'.repeat(200), body: Buffer.from('x') }, /pane/i],
    ];
    const seen = [];
    for (const [what, args, regex] of cases) {
      const r = await postAttach(args);
      must(r.status === 400, `${what}: expected HTTP 400, got ${r.status}: ${(r.text || r.error || '').slice(0, 200)}`);
      const msg = (r.json && r.json.error && r.json.error.message) || '';
      must(r.json && r.json.ok === false, `${what}: the body must be ok:false, got ${JSON.stringify(r.json)}`);
      must(regex.test(msg), `${what}: the reason does not name the problem (${JSON.stringify(msg)})`);
      seen.push(`${what} -> ${msg.slice(0, 40)}…`);
    }
    eq(listDir(paneDir(ROOT, 'w9:empty')).length, 0, 'a refused upload wrote a file anyway');
    return { detail: seen.join(' | ') };
  });

  // ── (c) traversal ────────────────────────────────────────────────────────
  await check('attach: a name that is a path is reduced to one legal component under the root', async () => {
    const names = [
      '..\\..\\evil.png', 'C:\\Windows\\evil.png', 'sub/dir/evil.png', '..%2F..%2Fevil.png',
      'NUL', 'CON.txt', 'a'.repeat(380) + '.png', '   ...   ',
    ];
    const outcomes = [];
    for (let i = 0; i < names.length; i++) {
      const declared = names[i];
      const r = await postAttach({ name: declared, pane: 'w9:traversal', body: Buffer.from(`payload ${i}`) });
      if (r.status === 400) {
        must(r.json && r.json.ok === false && r.json.error && r.json.error.message, `${declared}: a 400 must carry a reason`);
        outcomes.push(`${JSON.stringify(declared.slice(0, 22))} -> 400`);
        continue;
      }
      must(r.status === 200, `${declared}: expected 200 or 400, got ${r.status}: ${(r.text || r.error || '').slice(0, 200)}`);
      const p = r.json.path;
      const base = path.basename(p);
      must(p.startsWith(ROOT + path.sep), `${declared}: landed outside the root: ${p}`);
      must(p.startsWith(path.join(ROOT, 'w9_traversal') + path.sep), `${declared}: landed outside its pane's directory: ${p}`);
      must(!/[\\/:*?"<>|]/.test(base), `${declared}: the stored basename is not one legal component: ${base}`);
      const stored = base.replace(/^\d{8}T\d{6}Z-/, '');     // the safe-name inside the stamped basename
      must(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(stored),
        `${declared}: a Windows device name survived as the basename: ${base}`);
      must(stored.length <= 120, `${declared}: the safe-name was not capped at 120 (${stored.length} chars): ${base}`);
      if (declared.length > 200) must(stored.endsWith('.png'), `${declared}: the 120-char cap must keep the extension, got ${base}`);
      must(fs.existsSync(p), `${declared}: the reply's path does not exist: ${p}`);
      outcomes.push(`${JSON.stringify(declared.slice(0, 22))} -> ${base}`);
    }
    // The whole root, walked: every file is under it, every basename is one
    // legal component, and the pane directories are the only ones there.
    const files = walk(ROOT);
    for (const rel of files) {
      const base = path.basename(rel);
      must(!/[\\/:*?"<>|]/.test(base), `a file under the root carries an illegal character: ${rel}`);
    }
    const outside = files.filter((rel) => !rel.startsWith('w9_happy') && !rel.startsWith('w9_roundtrip')
      && !rel.startsWith('w9_cap') && !rel.startsWith('w9_empty') && !rel.startsWith('w9_traversal'));
    eq(outside.join(','), '', 'the root holds files outside the panes this suite uploaded for');
    return { detail: outcomes.join(' | ') };
  });

  // ── (c) nothing outside the root ─────────────────────────────────────────
  await check('attach: nothing was created in the repo, in a pane\'s cwd, or outside the root', async () => {
    const repoAfter = walk(REPO_ROOT, { skip: REPO_WALK_SKIP });
    const d = diffList(repoBefore, repoAfter);
    eq(d.added.join(','), '', 'the repo gained files during this suite');
    eq(d.removed.join(','), '', 'the repo lost files during this suite');
    eq(listDir(PANE_CWD).join(','), paneCwdBefore.join(','), 'a pane\'s cwd changed during this suite');
    // The root holds pane directories and nothing else — no file of its own, no
    // directory whose name could not be a pane.
    const top = fs.readdirSync(ROOT, { withFileTypes: true });
    must(top.length > 0, 'the suite wrote nothing, so this check proves nothing');
    for (const e of top) {
      must(e.isDirectory(), `the root holds a file of its own (only pane directories belong there): ${e.name}`);
      must(!/[\\/:*?"<>|]/.test(e.name), `a pane directory carries an illegal character: ${e.name}`);
    }
    return { detail: `repo unchanged (${repoAfter.length} entries), pane cwd unchanged, ${top.length} pane directories holding ${walk(ROOT).length} entries` };
  });

  // ── (d) the pane id ──────────────────────────────────────────────────────
  await check('attach: a pane id with illegal characters becomes a legal directory name', async () => {
    const cases = [
      ['w6:p2', 'w6_p2'],
      ['a/b\\c:d*e?f"g<h>i|j', 'a_b_c_d_e_f_g_h_i_j'],
      ['NUL', '_NUL'],
      ['  w6:p2  ', 'w6_p2'],
    ];
    for (const [pane, want] of cases) {
      const r = await postAttach({ name: 'panecheck.txt', pane, body: Buffer.from(pane) });
      must(r.status === 200, `pane ${JSON.stringify(pane)}: HTTP ${r.status}: ${(r.text || r.error || '').slice(0, 200)}`);
      const dir = path.dirname(r.json.path);
      eq(path.basename(dir), want, `pane ${JSON.stringify(pane)} directory name`);
      must(dir === path.join(ROOT, want), `pane ${JSON.stringify(pane)}: the directory is not <root>/${want}: ${dir}`);
      eq(fs.readFileSync(r.json.path).toString('utf8'), pane, 'the bytes under that directory');
    }
    return { detail: cases.map(([p, w]) => `${p} -> ${w}`).join(' | ') };
  });

  // ── (e) unicode ─────────────────────────────────────────────────────────
  await check('attach: a CJK/emoji filename survives as readable text (encoded or raw UTF-8 bytes)', async () => {
    const cjk = '报告-💡.png';
    // The shipped client percent-encodes a non-ASCII name (chatview.js headerName).
    const encoded = await postAttach({ name: encodeURIComponent(cjk), pane: 'w9:unicode', body: Buffer.from('encoded') });
    must(encoded.status === 200, `percent-encoded: HTTP ${encoded.status}: ${(encoded.text || encoded.error || '').slice(0, 200)}`);
    eq(encoded.json.name, cjk, 'the percent-encoded name must come back readable');
    must(path.basename(encoded.json.path).endsWith(`-${cjk}`), `the stored basename must carry the readable name: ${encoded.json.path}`);
    eq(fs.readFileSync(encoded.json.path).toString('utf8'), 'encoded', 'the encoded upload\'s bytes');
    // A client that puts the UTF-8 bytes straight into the header (curl can).
    const rawName = Buffer.from(cjk, 'utf8').toString('latin1');
    const raw = await postAttach({ name: rawName, pane: 'w9:unicode', body: Buffer.from('raw') });
    must(raw.status === 200, `raw UTF-8: HTTP ${raw.status}: ${(raw.text || raw.error || '').slice(0, 200)}`);
    eq(raw.json.name, cjk, 'the raw UTF-8 name must come back readable');
    must(fs.existsSync(raw.json.path), 'the raw UTF-8 upload is not on disk');
    // An ASCII name is the literal name: a decode would corrupt a real `%`.
    const literal = await postAttach({ name: '50% off.png', pane: 'w9:unicode', body: Buffer.from('literal') });
    must(literal.status === 200, `literal percent: HTTP ${literal.status}`);
    eq(literal.json.name, '50% off.png', 'an ASCII name must not be percent-decoded');
    const names = listDir(paneDir(ROOT, 'w9:unicode'));
    must(names.some((n) => n.endsWith(`-${cjk}`)), `the unicode basename is not in the directory listing: ${names.join(', ')}`);
    return { detail: `stored as ${names.filter((n) => n.endsWith(`-${cjk}`))[0] || '(?)'} ; ASCII '%' kept literal` };
  });

  // ── (f) collisions ──────────────────────────────────────────────────────
  await check('attach: a repeated name is stored beside the first with -2, never overwritten', async () => {
    const payloads = ['one', 'two', 'three'];
    const got = [];
    for (const p of payloads) {
      const r = await postAttach({ base: BASE_FROZEN, name: 'same.png', pane: 'w9:dupe', body: Buffer.from(p) });
      must(r.status === 200, `upload ${p}: HTTP ${r.status}: ${(r.text || r.error || '').slice(0, 200)}`);
      got.push(r.json.path);
    }
    eq(new Set(got).size, 3, `three uploads of one name produced ${new Set(got).size} distinct paths`);
    const dir = paneDir(ROOT_FROZEN, 'w9:dupe');
    eq(listDir(dir).sort().join(','), [
      `${FROZEN_STAMP}-same-2.png`, `${FROZEN_STAMP}-same-3.png`, `${FROZEN_STAMP}-same.png`,
    ].join(','), 'the pane directory after three uploads of one name');
    for (let i = 0; i < got.length; i++) {
      eq(fs.readFileSync(got[i]).toString('utf8'), payloads[i], `file ${i + 1}'s bytes (nothing was overwritten)`);
    }
    must(path.basename(got[1]).includes('-2'), `the second file should carry -2: ${got[1]}`);
    must(path.basename(got[2]).includes('-3'), `the third file should carry -3: ${got[2]}`);
    return { detail: listDir(dir).sort().join(', ') };
  });

  // ── (6) a store that cannot be written ──────────────────────────────────
  await check('attach: a store that cannot be written answers with a reason and leaves nothing behind', async () => {
    const r = await postAttach({ base: BASE_BAD_ROOT, name: 'nope.png', pane: 'w9:blocked', body: Buffer.from('x'.repeat(64)) });
    must(r.status === 500, `expected HTTP 500 for an impossible root, got ${r.status}: ${(r.text || r.error || '').slice(0, 200)}`);
    must(r.json && r.json.ok === false, `the failure body must be ok:false, got ${JSON.stringify(r.json)}`);
    const msg = (r.json.error && r.json.error.message) || '';
    must(msg.length > 20, `the failure must carry a real reason, got ${JSON.stringify(msg)}`);
    must(/could not be created|ENOTDIR|EEXIST|EPERM|EACCES/i.test(msg), `the reason should name what the OS said: ${msg}`);
    must(!msg.includes('undefined'), `the reason mentions undefined: ${msg}`);
    must(!fs.existsSync(BLOCKED_ROOT), `something was created under an impossible root: ${BLOCKED_ROOT}`);
    eq(fs.readFileSync(BLOCKED_FILE, 'utf8').startsWith('this path is a file'), true, 'the blocker file was modified');
    return { detail: msg.slice(0, 120) };
  });

  // ── the method rule ─────────────────────────────────────────────────────
  await check('attach: GET, PUT and DELETE are refused with 405 and an Allow header', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const r = await new Promise((resolve) => {
        const req = http.request({ method, hostname: '127.0.0.1', port: PORT, path: '/api/attach' }, (res) => {
          const parts = [];
          res.on('data', (c) => parts.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString('utf8') }));
        });
        req.on('error', (e) => resolve({ error: e.message }));
        req.end();
      });
      must(r.status === 405, `${method} /api/attach: expected 405, got ${r.status} ${(r.text || r.error || '').slice(0, 120)}`);
      eq(String(r.headers.allow || ''), 'POST', `${method}: the Allow header`);
      let json = null;
      try { json = JSON.parse(r.text); } catch { /* not json */ }
      must(json && json.error && json.error.message, `${method}: a 405 must carry a reason`);
    }
    return { detail: 'GET/PUT/DELETE/PATCH -> 405 Allow: POST' };
  });

  // ── the unit rules, stated once ─────────────────────────────────────────
  await check('attach unit: the sanitiser\'s rules, one case at a time', async () => {
    const A = attachModule;
    eq(A.sanitizePane('w6:p2').pane, 'w6_p2', 'pane w6:p2');
    eq(A.sanitizePane('..').ok, false, 'pane ".." must be refused');
    eq(A.sanitizePane('').ok, false, 'an empty pane must be refused');
    eq(A.sanitizeName('..\\..\\evil.png').name, 'evil.png', 'a traversal name');
    eq(A.sanitizeName('  spaced  name .png ').name, 'spaced name .png', 'whitespace and dots');
    eq(A.sanitizeName('NUL').name, '_NUL', 'the NUL device');
    eq(A.sanitizeName('CON.txt').name, '_CON.txt', 'the CON device with an extension');
    eq(A.sanitizeName('a'.repeat(400) + '.png').name.length <= 120, true, 'the 400-char name is capped');
    must(A.sanitizeName('a'.repeat(400) + '.png').name.endsWith('.png'), 'the cap must keep the extension');
    eq(A.sanitizeName('..').ok, false, 'a dot-only name must be refused');
    eq(A.decodeHeaderName(encodeURIComponent('报告.png')), '报告.png', 'the percent-encoded UTF-8 name');
    eq(A.decodeHeaderName('50% off.png'), '50% off.png', 'an ASCII name is literal');
    eq(A.decodeHeaderName(Buffer.from('报告.png', 'utf8').toString('latin1')), '报告.png', 'raw UTF-8 header bytes');
    eq(A.utcStamp(new Date('2026-09-25T11:30:00.000Z')), '20260925T113000Z', 'the UTC stamp shape');
    eq(A.withSuffix('a.png', 2), 'a-2.png', 'a collision suffix keeps the extension');
    eq(A.LIMITS.MAX_BYTES, 25 * 1024 * 1024, 'the per-file cap');
    // §13.4 item 1's destination, in the shipped case (no seam of any kind): the
    // root is <app root>\_cache\attachments, NOT app data on C:. Read, never written
    // here: the seam is removed for this call and put back exactly as it was.
    const saved = process.env.HD_ATTACH_ROOT;
    let realRoot = '';
    try {
      delete process.env.HD_ATTACH_ROOT;
      realRoot = A.attachmentRoot();
    } finally {
      if (saved === undefined) delete process.env.HD_ATTACH_ROOT; else process.env.HD_ATTACH_ROOT = saved;
    }
    eq(realRoot, DEFAULT_ROOT, 'the destination §13.4 item 1 names');
    must(realRoot.startsWith(REPO_ROOT + path.sep), `the store is not inside the app: ${realRoot}`);
    const appData = process.env.LOCALAPPDATA || process.env.APPDATA
      || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local');
    must(!realRoot.toLowerCase().startsWith(path.resolve(appData).toLowerCase() + path.sep),
      `the store must be off the app-data path (§13.4 item 1 replaced §10.2): ${realRoot}`);
    // The override is honoured in the form the contract allows.
    process.env.HD_ATTACH_ROOT = ROOT;
    try { eq(A.attachmentRoot(), path.resolve(ROOT), 'an absolute HD_ATTACH_ROOT is used as given'); } finally {
      if (saved === undefined) delete process.env.HD_ATTACH_ROOT; else process.env.HD_ATTACH_ROOT = saved;
    }
    let threw = false;
    try { A.assertUnder(path.join(ROOT), path.join(ROOT, '..', 'outside.png')); } catch (e) { threw = true; }
    must(threw, 'assertUnder must refuse a path above the root');
    // A relative override is refused rather than resolved against whatever cwd the
    // server was started from — the one failure that would scatter attachments
    // silently. It must fall back to the app-relative default, not throw (an upload
    // must not fail because a reader mistyped an env var).
    process.env.HD_ATTACH_ROOT = 'relative/store';
    try {
      eq(A.attachmentRoot(), DEFAULT_ROOT, 'a relative HD_ATTACH_ROOT falls back to the default');
    } finally {
      if (saved === undefined) delete process.env.HD_ATTACH_ROOT; else process.env.HD_ATTACH_ROOT = saved;
    }
    return { detail: 'the sanitiser, decode and path rules, one case at a time' };
  });

  // ── §11.3: one cold resolution for two concurrent requests ──────────────
  //
  // The cost of ONE cold resolution is measured first, from a single request,
  // and every later assertion is a comparison with that measurement — so this
  // suite states "two requests cost what one costs", not a number copied out of
  // the implementation that could quietly drift from it.
  const chatUrl = (pane) => `${BASE}/api/chat?pane_id=${encodeURIComponent(pane)}&limit=5&tail=1`;
  let coldCost = 0;

  await check('chat §11.3: a cold request runs the scan and says so', async () => {
    const before = mock.reads();
    const r = await getJson(chatUrl(COLD_PANE));
    must(r.json != null, `the cold request is not JSON (HTTP ${r.status}) ${(r.text || r.error || '').slice(0, 200)}`);
    must(r.json.ok === true, `the cold request failed: ${JSON.stringify(r.json.error || r.json).slice(0, 240)}`);
    eq(r.json.session_id, SESS_COLD, 'the cold request\'s session');
    eq(String(r.headers['x-hd-session-scan']), 'fresh', 'a cold request is the one that runs the scan');
    coldCost = mock.reads() - before;
    must(coldCost >= 1, 'a cold resolution made no pane.read calls, so nothing below can be measured');
    return { detail: `one cold resolution = ${coldCost} pane.read calls` };
  });

  await check('chat §11.3: two requests for a cold pane produce ONE scan and both answer', async () => {
    await sleep(CACHE_MS + 300);                       // both requests are cold again
    const readsBefore = mock.reads();
    const [a, b] = await Promise.all([getJson(chatUrl(COLD_PANE)), getJson(chatUrl(COLD_PANE))]);
    for (const [what, r] of [['the first', a], ['the second', b]]) {
      must(r.json != null, `${what} request: not JSON (HTTP ${r.status}) ${(r.text || r.error || '').slice(0, 200)}`);
      must(r.json.ok === true, `${what} request: ok was ${JSON.stringify(r.json.ok)} ${JSON.stringify(r.json.error || null)}`);
      eq(r.json.session_id, SESS_COLD, `${what} request's session`);
    }
    const reads = mock.reads() - readsBefore;
    eq(reads, coldCost, `two concurrent requests made ${reads} pane.read calls; one cold resolution costs ${coldCost}, so two scans would be ${coldCost * 2}`);
    const scans = [a, b].map((r) => String(r.headers['x-hd-session-scan'] || ''));
    eq(scans.filter((s) => s === 'fresh').length, 1, `exactly one request should have run the scan, got ${JSON.stringify(scans)}`);
    must(scans.every((s) => s === 'fresh' || s === 'joined' || s === 'cached'), `unknown scan label(s): ${JSON.stringify(scans)}`);
    return { detail: `2 requests, ${reads} pane.read calls (= one resolution; two would be ${coldCost * 2}), scans ${JSON.stringify(scans)}` };
  });

  await check('chat §11.3: the resolution is reused inside its TTL and recomputed after it', async () => {
    const before = mock.reads();
    const warm = await getJson(chatUrl(COLD_PANE));
    must(warm.json && warm.json.ok === true, `the warm request failed: ${(warm.text || warm.error || '').slice(0, 200)}`);
    eq(mock.reads() - before, 0, 'a request inside the TTL re-read the pane');
    eq(String(warm.headers['x-hd-session-scan']), 'cached', 'a request inside the TTL should say it was served from the cache');
    await sleep(CACHE_MS + 300);
    const coldAgain = await getJson(chatUrl(COLD_PANE));
    must(coldAgain.json && coldAgain.json.ok === true, `the post-TTL request failed: ${(coldAgain.text || coldAgain.error || '').slice(0, 200)}`);
    eq(mock.reads() - before, coldCost, `a request after the ${CACHE_MS}ms TTL should scan again (${coldCost} pane reads)`);
    eq(String(coldAgain.headers['x-hd-session-scan']), 'fresh', 'a request after the TTL should report a fresh scan');
    return { detail: `TTL ${CACHE_MS}ms: 0 pane.read calls inside it, ${coldCost} after` };
  });

  await check('cleanup: the test ports are free again', async () => {
    killAll();
    if (mockPipe) { await mockPipe.close(); mockPipe = null; }
    const ports = [PORT, PORT_BAD_ROOT, PORT_FROZEN, PORT_DEFAULT];
    const deadline = Date.now() + 10000;
    let busy = [];
    do {
      busy = [];
      for (const p of ports) if (await listening(p)) busy.push(p);
      if (!busy.length) break;
      await sleep(300);
    } while (Date.now() < deadline);
    eq(busy.join(','), '', `ports still listening: ${busy.join(', ')}`);
    return { detail: `${ports.join(', ')} free` };
  });

  // ── report ──────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.passed).length;
  console.log('');
  notes.push(`attachment root used by this run: ${path.relative(REPO_ROOT, ROOT)} (and ${path.relative(REPO_ROOT, ROOT_FROZEN)} with the frozen stamp, and ${path.relative(REPO_ROOT, DEFAULT_ROOT)} for the SHIPPED configuration — no HD_ATTACH_ROOT)`);
  for (const n of notes) console.log(`NOTE ${n}`);
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  if (pass !== results.length) {
    console.log('');
    for (const r of results) if (!r.passed) console.log(`  FAILED: ${r.name} — ${r.detail}`);
  }
  report(pass === results.length ? 0 : 1);
}

/**
 * Leave nothing behind: kill every child, close the mock pipe, drop pooled
 * sockets, and make the exit unconditional (a harness that lingers holds a port
 * the next run — or another worker — needs).
 */
function report(code) {
  process.exitCode = code;
  killAll();
  if (mockPipe) { try { mockPipe.close(); } catch { /* already gone */ } mockPipe = null; }
  try { http.globalAgent.destroy(); } catch { /* nothing pooled */ }
  const t = setTimeout(() => process.exit(code), 400);
  t.unref();
}

main().catch((e) => {
  console.error(`harness failed: ${(e && e.message) || e}`);
  console.error(`completed before the failure: ${results.map((r) => `${r.passed ? 'P' : 'F'}:${r.name}`).join(' | ') || '(none)'}`);
  console.error(`current check: ${currentCheck}`);
  report(1);
});
