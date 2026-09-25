#!/usr/bin/env node
// herdr-dash round-7 harness — CONTRACT-v2 §8.2 (GET /api/chat) — owner: W1.
//
// Zero dependencies beyond node itself (node:sqlite is a builtin): the fixture
// sqlite database is created with the same module the server reads it with.
//
// WHAT THIS PROVES, AND HOW
//
//   Fixtures, not mocks of our own code. A synthetic claude jsonl tree and a
//   synthetic state.db are built from literal records, the server is pointed at
//   them (CLAUDE_PROJECTS_DIR / HERMES_STATE_DB — the same env knobs the server
//   already honours for HERDR_SOCKET_PATH and GIT_BIN_PATH), and the assertions
//   are made against the DATA, not against the parser: "every emitted text is a
//   substring of the record it claims to come from" is checked by re-reading the
//   fixture with an independent parse, and the counting identity is checked
//   against the fixture's own line/row count.
//
//   The cursor is checked by arithmetic on bytes: a window's `cursor` must equal
//   the offset just after the last complete line it reported, a half-written
//   trailing line must leave the cursor exactly where it was, and completing
//   that line must make the record appear exactly once.
//
//   Read-only is proved three ways: (a) a working copy of a live session and the
//   live state.db are measured (size, mtime, row count, max id) before and after
//   at least three real requests, (b) a write through the server's own
//   openReadOnly() must throw, (c) the module source is parsed to confirm it
//   builds a `mode=ro` URI and passes readOnly.
//
//   The live half is GUARDED: it needs a real claude pane and a real hermes pane
//   on this machine and is reported as SKIPPED (not counted) when they are not
//   there. It runs against a second server instance started WITHOUT the mock
//   pipe, so it talks to the real herdr.
//
// Usage:
//   node test/chat.mjs [--port 7456]
//
//   The fixture server listens on <port>, a second instance for the
//   `session_db_missing` case on <port>+1, and the live instance on <port>+2.
//   All three are killed before the harness exits, and the ports are re-checked.
//
// Exit code is 0 only when every check passed.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- paths & args

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
const PORT = Number(flagValue('--port', '7456'));
// §9's end-to-end check creates a real workspace in the user's herdr and starts a
// real hermes in it, so it is opt-in: `node test/chat.mjs --e2e` (it closes what it
// created, and it never touches a pane it did not create).
const E2E = argv.includes('--e2e');
const PORT_NO_DB = PORT + 1;      // instance whose hermess db path does not exist
const PORT_LIVE = PORT + 2;       // instance attached to the REAL herdr
const BASE = `http://127.0.0.1:${PORT}`;
const BASE_NO_DB = `http://127.0.0.1:${PORT_NO_DB}`;
const BASE_LIVE = `http://127.0.0.1:${PORT_LIVE}`;
const SPAWN_WAIT_MS = 20000;

const SCRATCH = path.join(REPO_ROOT, '_scratch', 'w1', 'chat');
const FIX = path.join(SCRATCH, 'fixture');
const PROJECTS = path.join(FIX, 'projects');
const DB_FILE = path.join(FIX, 'state.db');
const NO_DB_FILE = path.join(FIX, 'definitely-missing', 'state.db');

// The cwd every fixture claude session claims. The mock herdr snapshot reports
// the same string for the panes that are meant to resolve, and a DIFFERENT one
// for the pane that must be refused.
const CWD_OK = 'D:\\Development\\New\\_scratch\\w1\\chat\\fixture\\project';
const CWD_OTHER = 'D:\\Development\\Other';
// Round 7.6 (§9): cwds with a known candidate set, so the claude cwd-newest rule
// can be pinned: one log (unambiguous → picked), two logs milliseconds apart
// (ambiguous → disclosed, never guessed), and none at all (herdr's own record is
// the only thing left to serve).
const CWD_LONE = 'D:\\Development\\New\\_scratch\\w1\\chat\\fixture\\lone';
const CWD_ONE = 'D:\\Development\\New\\_scratch\\w1\\chat\\fixture\\cwd-one';
const CWD_AMB = 'D:\\Development\\New\\_scratch\\w1\\chat\\fixture\\cwd-amb';
const CWD_BOUND = 'D:\\Development\\New\\_scratch\\w1\\chat\\fixture\\cwd-bound';
const CWD_FRESH = 'D:\\Development\\New\\_scratch\\w1\\chat\\fixture\\cwd-fresh';
// hermes panes of round 7.6 whose cwd is private to them, so the store rows and
// banners below cannot leak into the panes the older checks use.
const CWD_HB = 'D:\\Development\\New\\_scratch\\w1\\chat\\fixture\\hermes-banner';
const CWD_HM = 'D:\\Development\\New\\_scratch\\w1\\chat\\fixture\\hermes-morph';
const CWD_HS = 'D:\\Development\\New\\_scratch\\w1\\chat\\fixture\\hermes-store';

const SESS_BASIC = 'aaaa1111-2222-3333-4444-555566667777';
const SESS_PARTIAL = 'bbbb1111-2222-3333-4444-555566667777';
const SESS_CAPS = 'cccc1111-2222-3333-4444-555566667777';
const SESS_MULTI = 'dddd1111-2222-3333-4444-555566667777';
const SESS_MISMATCH = 'eeee1111-2222-3333-4444-555566667777';
const SESS_EMPTY = 'ffff1111-2222-3333-4444-555566667777';
const SESS_ONLYSKIPPED = 'f0f0f0f0-0000-0000-0000-00000000000f';   // written by a check below
const SESS_MISSING = 'a0a0a0a0-0000-0000-0000-000000000000';
const SESS_UNPAIRED = 'a1a1a1a1-0000-0000-0000-00000000000a';       // a result with no call
const SESS_TAIL = 'b2b2b2b2-0000-0000-0000-00000000000b';           // ends mid-write
const SESS_HEAVY = 'c3c3c3c3-0000-0000-0000-00000000000c';          // long paired results
const SESS_PENDING = 'd4d4d4d4-0000-0000-0000-00000000000d';         // ends on an unanswered call
const HERMES_SESSION = 'fixture_hermes_session';
const HERMES_DUP_SESSION = 'fixture_dup_ids';                        // repeated call ids

// ── round 7.6 (§9): strict hermes ids (the shape herdr's hermes panes carry),
// the ids herdr's own record names, and the ids the panes' own text names.
const H_HOLD = '20260924_120000_aaaaaa';     // what herdr records (stale, as in DEFECT-17)
const H_NEW = '20260925_111907_781d40';      // the id the banner names (measured on w4:p7)
const H_NEW_ANSI = '20260925_111908_222222'; // the same banner, read with ANSI around it
const H_NEW_STATUS = '20260925_111909_333333';// the id only the /status block carries
const H_NEW_FRESH = '20260925_123000_444444';// a pane herdr has NO record for at all
const H_OLDER = '20260923_182255_0de6a5';    // an older id: never a reason to move back
const H_ANCHOR = '20260924_200000_ffffff';   // what herdr records for that pane
const H_AMB = '20260924_090000_abcde1';      // what herdr records for the two-banner pane
const H_MORPH_OLD = '20260924_150000_bbbbbb';// a pane that starts on this and then /clears
const H_MORPH_NEW = '20260925_121500_eeeeee';// the session that /clear moves it to
const H_STORE = '20260925_130000_cccccc';    // the store's newest row, named by no pane
const H_STORE_OLD = '20260924_100000_dddddd';// what herdr records for the store pane
// claude: ids herdr records (whose logs are gone: the dangling-record case §9.5
// discloses) and the logs that lie in each cwd — one cwd each, so no two panes
// compete for the same log (a session another pane is bound to is never adopted).
const SESS_ONE_DANGLE = 'e6e6e6e6-0000-0000-0000-00000000000f';  // no log: the cwd's one log is picked
const SESS_AMB_DANGLE = 'f7f7f7f7-0000-0000-0000-000000000010';  // no log: two logs compete
const CAND_ONE = 'c0c0c0c0-0000-0000-0000-000000000011';         // the only log under CWD_ONE
const CAND_BOUND = 'c3c3c3c3-0000-0000-0000-000000000015';       // the only log under CWD_BOUND
const CAND_AMB_A = 'c1c1c1c1-0000-0000-0000-000000000012';       // under CWD_AMB
const CAND_AMB_B = 'c2c2c2c2-0000-0000-0000-000000000013';       // under CWD_AMB, milliseconds apart
const CAND_FRESH = 'c4c4c4c4-0000-0000-0000-000000000016';       // under CWD_FRESH, herdr records nothing
// ── the crowding case (round 8 fix's teeth): the pane's own log is OLDER than
// CAND_MAX logs belonging to other cwds in other slugs, so an answer that depends on
// being in the global newest-eight cannot find it. */
const CWD_CROWD = 'D:\\Development\\New\\_scratch\\w1\\chat\\fixture\\cwd-crowd';
const SESS_CROWD_DANGLE = 'd8d8d8d8-0000-0000-0000-000000000009'; // no log: the crowded cwd's own log is picked
const CAND_CROWD = 'c5c5c5c5-0000-0000-0000-000000000017';         // under CWD_CROWD, in its own slug
const CROWD_SLUGS = 8;                                             // one noise log per slug, all newer

// ---------------------------------------------------------------- check runner

class Fail extends Error {}
const must = (cond, msg) => { if (!cond) throw new Fail(msg); };
const eq = (got, want, what) => {
  if (got !== want) throw new Fail(`${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};

const results = [];
const notes = [];
let skippedLive = 0;
let currentCheck = '(startup)';     // what the watchdog names if a check never returns

async function check(name, fn) {
  currentCheck = name;
  let passed = false;
  let detail = '';
  const started = Date.now();
  try {
    const r = await fn();
    if (r && typeof r === 'object' && 'skip' in r) {
      skippedLive++;
      console.log(`SKIP LIVE: ${name} — ${r.reason}`);
      return false;
    }
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
  results.push({ name, passed, detail });
  const ms = Date.now() - started;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${passed ? '' : ` — ${detail}`}${ms > 400 && passed ? ` [${ms}ms]` : ''}`);
  return passed;
}

// ---------------------------------------------------------------- process + http

const children = [];
let mockPipe = null;        // the mock herdr pipe, so the failure path can close it too
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
  // every request and the checks then report on the WRONG build.
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

function request(method, url, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ error: `bad url ${url}: ${e.message}` }); }
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({ method, hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        finish({ status: res.statusCode, text, json });
      });
      res.on('error', (e) => finish({ error: `response error: ${e.message}` }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ error: `timed out after ${timeoutMs}ms` }); });
    req.on('error', (e) => finish({ error: `${e.code || 'network error'}: ${e.message}` }));
    req.end();
  });
}

/** GET /api/chat, asserting we actually reached a JSON reply. */
async function apiChat(params, opts) {
  const base = (opts && opts.base) || BASE;
  const qs = new URLSearchParams(params).toString();
  const url = `${base}/api/chat?${qs}`;
  const r = await request('GET', url);
  if (r.error) throw new Fail(`could not reach ${url} — ${r.error}`);
  must(r.json != null, `${url}: reply was not JSON (HTTP ${r.status}): ${(r.text || '').slice(0, 200)}`);
  return r;
}

/**
 * Poll a CONDITION with a bounded retry.
 *
 * A check whose subject is "the resolver's verdict once time has passed" (a
 * staleness window, a file that must appear, a scan that must see the fixtures)
 * cannot be decided by one sleep and one request: under load the request lands
 * outside the window, or lands before the state it is asking about exists, and
 * the failure reads as a bare `ok: false` with no story. This retries the request
 * until the condition holds, and when it never does it throws with the label, how
 * long it waited, how many attempts it made, and the decisive fields of the LAST
 * answer — the state is in the failure text, not in the reader's head.
 *
 * It never loosens the assertion: `ok` is the same condition the single request
 * used to assert, so a real regression still fails, just legibly.
 */
async function until(label, fn, ok, { timeoutMs = 5000, intervalMs = 150, fields } = {}) {
  const shown = fields || ['ok', 'session_id', 'session_detected_by', 'resolved', 'resolved_reason', 'stale', 'stale_reason', 'herdr_healed', 'heal_reason', 'error'];
  const t0 = Date.now();
  let last = null;
  let attempts = 0;
  for (;;) {
    last = await fn();
    attempts++;
    if (ok(last)) return { last, attempts, ms: Date.now() - t0 };
    const waited = Date.now() - t0;
    if (waited >= timeoutMs) {
      const j = (last && last.json) || {};
      const state = shown.filter((f) => f in j).map((f) => `${f}=${JSON.stringify(j[f])}`).join(' ');
      throw new Fail(`${label}: still false after ${waited} ms and ${attempts} attempt(s) — the API answered ${state || JSON.stringify(j).slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const writeLF = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');       // '\n' stays '\n'
};
const appendLF = (p, text) => fs.appendFileSync(p, text, 'utf8');

// ---------------------------------------------------------------- claude fixtures

/** A claude record envelope with the keys the live logs carry. */
function rec(type, uuid, ts, content, extra = {}) {
  const r = {
    parentUuid: null,
    isSidechain: false,
    type,
    uuid,
    timestamp: ts,
    sessionId: 'x',
    cwd: CWD_OK,
    version: '2.1.280',
  };
  if (content !== undefined) r.message = { role: type === 'user' ? 'user' : 'assistant', content };
  return Object.assign(r, extra);
}
const T = (n) => `2026-09-24T10:00:${String(n).padStart(2, '0')}.000Z`;

/** The main fixture conversation: every shape §8.2 names, in file order. */
function basicRecords() {
  return [
    rec('user', 'u-1', T(1), 'hello from the user'),
    rec('assistant', 'a-1', T(2), [{ type: 'thinking', thinking: 'let me think about it' }]),
    rec('assistant', 'a-2', T(3), [{ type: 'text', text: 'here is my answer' }]),
    rec('assistant', 'a-3', T(4), [{ type: 'tool_use', id: 'call_A', name: 'Bash', input: { command: 'ls' } }]),
    rec('user', 'u-2', T(5), [{ type: 'tool_result', tool_use_id: 'call_A', content: 'file1\nfile2', is_error: false }]),  // merged into call_A
    rec('assistant', 'a-4', T(6), [{ type: 'tool_use', id: 'call_B', name: 'Read', input: { file_path: 'x.js' } }]),   // no result: pending
    rec('assistant', 'a-5', T(7), [{ type: 'tool_use', id: 'call_C', name: 'Bash', input: { command: 'false' } }]),
    rec('user', 'u-3', T(8), [{ type: 'tool_result', tool_use_id: 'call_C', content: 'boom: exit 1', is_error: true }]), // merged into call_C
    { type: 'file-history-snapshot', messageId: 'm-1', snapshot: {}, isSnapshotUpdate: false },          // skipped
    { type: 'attachment', uuid: 'att-1', timestamp: T(9), cwd: CWD_OK, attachment: { kind: 'x' } },       // skipped
    { type: 'queue-operation', operation: 'enqueue', timestamp: T(10), content: '<task-notification>' },  // unknown
    { type: 'custom-title', timestamp: T(11), title: 'a title' },                                          // unknown
    rec('system', 's-1', T(12), undefined, { subtype: 'local_command', content: '<local-command-stdout>done</local-command-stdout>' }),
    rec('assistant', 'a-6', T(13), [{ type: 'text', text: 'sidechain note' }], { isSidechain: true }),
    // Round 7.1 / DEFECT-10: blank content is not a row. Both records are skipped,
    // both are counted in empty_records, and neither adds a message.
    rec('assistant', 'a-7', T(14), [{ type: 'text', text: '' }]),
    rec('assistant', 'a-8', T(15), [{ type: 'thinking', thinking: '   \n  ' }]),
  ];
}

/**
 * A result whose call is NOT in the file: the one case that still needs its own
 * `kind:"tool_result"` message (the renderer draws it as unpaired).
 */
function unpairedRecords() {
  return [
    rec('user', 'un-1', T(1), [{ type: 'tool_result', tool_use_id: 'call_absent', content: 'output with no card' }]),
  ];
}

/**
 * The tail fixture: a conversation that ends mid-write. The last line has no
 * trailing newline, so a tail read must stop at the newest COMPLETE record and
 * leave its cursor there — and must still find the newest records by scanning
 * backwards from EOF.
 */
function tailRecords() {
  return [
    rec('user', 't-1', T(1), 'tail one'),
    rec('assistant', 't-2', T(2), [{ type: 'text', text: 'tail two' }]),
    rec('assistant', 't-3', T(3), [{ type: 'tool_use', id: 'call_T', name: 'Bash', input: { command: 'echo hi' } }]),
    rec('user', 't-4', T(4), [{ type: 'tool_result', tool_use_id: 'call_T', content: 'hi', is_error: false }]),
    rec('assistant', 't-5', T(5), [{ type: 'text', text: 'tail five' }]),
  ];
}

/**
 * Round 7.3: a session whose newest record is a tool call nothing has answered
 * yet. Two records only, so the tail window reaches the live end and the call
 * belongs to the generating turn — the one shape that may say 'awaiting'.
 */
function pendingRecords() {
  return [
    rec('user', 'pd-1', T(1), 'run the thing'),
    rec('assistant', 'pd-2', T(2), [{ type: 'tool_use', id: 'call_PD', name: 'Bash', input: { command: 'sleep 100' } }]),
  ];
}

/** A tool-heavy session with long results and unique markers: the payload check
 *  counts how many times each result text appears in the raw reply. */
function heavyRecords(n = 12) {
  const out = [rec('user', 'h-0', T(1), 'start')];
  for (let i = 0; i < n; i++) {
    out.push(rec('assistant', `h-c${i}`, T(2), [{ type: 'tool_use', id: `call_H${i}`, name: 'Bash', input: { command: `run ${i}` } }]));
    out.push(rec('user', `h-r${i}`, T(3), [{ type: 'tool_result', tool_use_id: `call_H${i}`, content: `MARKER-${i}-` + 'Z'.repeat(900), is_error: false }]));
  }
  return out;
}

/**
 * The caps fixture: one record per cap, then enough bulk records to cross the
 * response byte cap. Text lengths are exact so the clamping is arithmetic.
 */
function capsRecords() {
  const out = [
    rec('user', 'c-1', T(1), 'L'.repeat(25000)),                                      // text cap
    rec('assistant', 'c-2', T(2), [{ type: 'tool_use', id: 'call_L', name: 'Big', input: { blob: 'I'.repeat(30000) } }]),   // input cap
    rec('user', 'c-3', T(3), [{ type: 'tool_result', tool_use_id: 'call_L', content: 'R'.repeat(30000) }]),                 // result cap
  ];
  for (let i = 0; i < 100; i++) out.push(rec('assistant', `b-${i}`, T(4), [{ type: 'text', text: `${i}:`.padEnd(2) + 'B'.repeat(12000) }]));
  return out;
}

function writeSession(id, records, { finalNewline = true } = {}) {
  writeLF(path.join(PROJECTS, 'proj-one', `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + (finalNewline ? '\n' : ''));
}

/**
 * Make these fixture logs the newest things in the projects root, explicitly.
 *
 * §9.1 ranks candidates by mtime and the scan verifies only the newest CAND_MAX
 * (8) of them. This fixture root deliberately holds the logs of MANY different
 * cwds in ONE slug (that is how the "the cwd is proven by the log's own records,
 * not by the slug name" rule is tested), so a check that merely hoped its log was
 * among the newest eight was betting on write timing and on how ties at the
 * microsecond were enumerated. Measured (round 8 fix, on this loaded machine): the
 * pane's own log could sit at rank 9 of 16 — one failed run in four — and the pane
 * then answered `ok:false` although its log was on disk.
 *
 * Stamping states the precondition the check needs: the rule under test is the
 * cwd-newest rule, not the ranking of a crowded directory. 1 ms apart, so the
 * order is explicit and nothing ties at the boundary.
 */
function stampNewest(ids) {
  const t = Date.now();
  ids.forEach((id, i) => {
    const p = path.join(PROJECTS, 'proj-one', `${id}.jsonl`);
    const at = new Date(t - i);
    fs.utimesSync(p, at, at);
  });
}

function buildClaudeFixtures() {
  rmrf(FIX);
  fs.mkdirSync(path.join(PROJECTS, 'proj-one'), { recursive: true });
  fs.mkdirSync(path.join(PROJECTS, 'proj-two'), { recursive: true });

  // The basic conversation lives in proj-two on purpose: the file is found by
  // session id, not by any slug derived from the cwd.
  writeLF(path.join(PROJECTS, 'proj-two', `${SESS_BASIC}.jsonl`), basicRecords().map((r) => JSON.stringify(r)).join('\n') + '\n');

  // A session whose records all claim another project: must be refused.
  const mismatch = [rec('user', 'm-1', T(1), 'someone else', { cwd: CWD_OTHER })];
  writeLF(path.join(PROJECTS, 'proj-one', `${SESS_MISMATCH}.jsonl`), mismatch.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // Empty file: a brand new session.
  writeLF(path.join(PROJECTS, 'proj-one', `${SESS_EMPTY}.jsonl`), '');

  // One record, two text blocks: the multi-unit case the counting rule has to
  // state explicitly (see the counting check).
  const multi = [rec('assistant', 'mu-1', T(1), [{ type: 'text', text: 'first part' }, { type: 'text', text: 'second part' }])];
  writeLF(path.join(PROJECTS, 'proj-one', `${SESS_MULTI}.jsonl`), multi.map((r) => JSON.stringify(r)).join('\n') + '\n');

  writeSession(SESS_CAPS, capsRecords());

  // A result whose call never appears in the file (round 7.1 / DEFECT-11: this is
  // the only case that keeps its own tool_result message).
  writeLF(path.join(PROJECTS, 'proj-one', `${SESS_UNPAIRED}.jsonl`),
    unpairedRecords().map((r) => JSON.stringify(r)).join('\n') + '\n');

  // The tail fixture: five records, a merged pair, and a half-written sixth line.
  const tailAll = tailRecords();
  writeLF(path.join(PROJECTS, 'proj-one', `${SESS_TAIL}.jsonl`),
    tailAll.map((r) => JSON.stringify(r)).join('\n') + '\n'
    + JSON.stringify(rec('assistant', 't-6', T(6), [{ type: 'text', text: 'STILL WRITING' }])).slice(0, 40));

  writeSession(SESS_HEAVY, heavyRecords());

  // Round 7.3: the newest record is a call nothing has answered — the state that
  // must read as 'awaiting' on a working pane and 'not_in_window' on an idle one.
  writeSession(SESS_PENDING, pendingRecords());

  // The partial fixture is written so its last line has no trailing newline —
  // the writer's half-written record. It is completed later by the test.
  const p1 = rec('user', 'p-1', T(1), 'complete line one');
  const p2 = rec('assistant', 'p-2', T(2), [{ type: 'text', text: 'complete line two' }]);
  const half = JSON.stringify(rec('assistant', 'p-3', T(3), [{ type: 'text', text: 'HALF WRITTEN LINE' }]));
  writeLF(path.join(PROJECTS, 'proj-one', `${SESS_PARTIAL}.jsonl`),
    [JSON.stringify(p1), JSON.stringify(p2)].join('\n') + '\n' + half.slice(0, 60));

  // ── round 7.6 (§9): the cwd-newest rule's three cases. Written LAST, because
  // by mtime these must be the newest logs under their own cwd (src/chat/claude.js
  // verifies a bounded number of the newest files, and a cwd is only ever claimed
  // by a log whose own records PROVE that cwd).
  const one = [rec('user', 'o-1', T(1), 'the only session in this cwd', { cwd: CWD_ONE })];
  writeLF(path.join(PROJECTS, 'proj-one', `${CAND_ONE}.jsonl`), one.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const ambA = [rec('user', 'ab-1', T(2), 'the newest of two', { cwd: CWD_AMB })];
  const ambB = [rec('user', 'ab-2', T(1), 'the older of two', { cwd: CWD_AMB })];
  writeLF(path.join(PROJECTS, 'proj-one', `${CAND_AMB_A}.jsonl`), ambA.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeLF(path.join(PROJECTS, 'proj-one', `${CAND_AMB_B}.jsonl`), ambB.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // The pane herdr records no session for at all: the cwd's one log is the only
  // signal, and reporting it back is the one heal herdr can actually take.
  const bound = [rec('user', 'b-1', T(1), 'herdr itself is bound to this log', { cwd: CWD_BOUND })];
  writeLF(path.join(PROJECTS, 'proj-one', `${CAND_BOUND}.jsonl`), bound.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const fresh = [rec('user', 'f-1', T(1), 'a session in a cwd herdr records nothing for', { cwd: CWD_FRESH })];
  writeLF(path.join(PROJECTS, 'proj-one', `${CAND_FRESH}.jsonl`), fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/**
 * The crowding fixture: CROWD_SLUGS logs of OTHER cwds, one per slug, each strictly
 * newer than the pane's own log, which sits in a further slug of its own. Built at
 * check time and removed afterwards, so the rest of the run never sees these files.
 *
 * One slug each is the whole point. A global "verify the newest CAND_MAX files" cut
 * spends all eight slots on the noise; a per-slug-first cut spends one slot per noise
 * SLUG and is therefore also full. Only verifying further once the cut has proved
 * nothing finds the pane's log — which is the escalation this fixture is the teeth
 * for (see src/chat/claude.js, CAND_ESCALATE).
 *
 * Returns the text the pane's own log carries, so the check can assert what is served.
 */
function buildCrowdFixture() {
  removeCrowdFixture();
  const text = 'the only session in a crowded cwd';
  const crowdDir = path.join(PROJECTS, 'proj-crowd');
  fs.mkdirSync(crowdDir, { recursive: true });
  const own = path.join(crowdDir, `${CAND_CROWD}.jsonl`);
  writeLF(own, JSON.stringify(rec('user', 'cr-1', T(1), text, { cwd: CWD_CROWD })) + '\n');
  const now = Date.now();
  for (let i = 0; i < CROWD_SLUGS; i++) {
    const dir = path.join(PROJECTS, `proj-crowd-noise-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `n0${i}0000-0000-0000-0000-00000000000${i}.jsonl`);
    writeLF(p, JSON.stringify(rec('user', `n-${i}`, T(1), `noise ${i}`, { cwd: `D:\\noise\\cwd-${i}` })) + '\n');
    const at = new Date(now - i);                 // 1 ms apart, all newer than the own log
    fs.utimesSync(p, at, at);
  }
  const older = new Date(now - 120000);           // two minutes old: inside the scan's own window
  fs.utimesSync(own, older, older);
  return { text, own };
}

function removeCrowdFixture() {
  rmrf(path.join(PROJECTS, 'proj-crowd'));
  for (let i = 0; i < CROWD_SLUGS; i++) rmrf(path.join(PROJECTS, `proj-crowd-noise-${i}`));
}

// ---------------------------------------------------------------- hermes fixture

/** Rows in the shape the live table has (only the columns this parser reads). */
function hermesRows() {
  return [
    { id: 1, role: 'user', content: 'first prompt', timestamp: 1790160000.5 },
    { id: 2, role: 'assistant', content: 'answer text', reasoning: 'thinking text', reasoning_content: 'thinking text', timestamp: 1790160001.25 },
    {
      id: 3,
      role: 'assistant',
      content: '',
      reasoning: 'second thought',
      timestamp: 1790160002,
      tool_calls: JSON.stringify([{ id: 'c1', call_id: 'c1', type: 'function', function: { name: 'terminal', arguments: '{"command":"ls"}' } }]),
    },
    { id: 4, role: 'tool', content: '{"output":"a\\nb"}', tool_name: 'terminal', tool_call_id: 'c1', timestamp: 1790160003 },
    {
      id: 5,
      role: 'assistant',
      content: '',
      timestamp: 1790160004,
      tool_calls: JSON.stringify([
        { id: 'c2', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        { id: 'c3', function: { name: 'write_file', arguments: '{"path":"b"}' } },
      ]),
    },
    { id: 6, role: 'systemish', content: 'a role this parser has no rule for', timestamp: 1790160005 },
    { id: 7, role: 'assistant', content: '', reasoning: null, tool_calls: null, timestamp: 1790160006 },   // blank: skipped + empty
    // A tool row whose call row is absent: the unpaired case that keeps its own
    // tool_result message (round 7.1 / DEFECT-11).
    { id: 8, role: 'tool', content: 'output with no card', tool_name: 'terminal', tool_call_id: 'c_absent', timestamp: 1790160007 },
  ];
}

/**
 * Round 7.3's row set, in its own session: one call id declared TWICE and answered
 * TWICE (rows 23 and 24 both answer dup1), one normally answered call, and one
 * call with no answer at all. Real stores look like this — the live w4:p1 session
 * repeats 141 tool_call_ids — and it is where the pairing preference and the three
 * pending reasons are pinned.
 */
function hermesDupRows() {
  const call = (id, name) => JSON.stringify([{ id, function: { name, arguments: '{}' } }]);
  return [
    { id: 20, role: 'user', content: 'dup prompt', timestamp: 1790160100 },
    { id: 21, role: 'assistant', content: '', tool_calls: call('dup1', 'write_file'), timestamp: 1790160101 },
    { id: 22, role: 'assistant', content: '', tool_calls: call('dup1', 'write_file'), timestamp: 1790160102 },
    { id: 23, role: 'tool', content: 'FIRST-dup1-result', tool_name: 'write_file', tool_call_id: 'dup1', timestamp: 1790160103 },
    { id: 24, role: 'tool', content: 'SECOND-dup1-result', tool_name: 'write_file', tool_call_id: 'dup1', timestamp: 1790160104 },
    { id: 25, role: 'assistant', content: '', tool_calls: call('dup2', 'terminal'), timestamp: 1790160105 },
    { id: 26, role: 'tool', content: 'dup2 result', tool_name: 'terminal', tool_call_id: 'dup2', timestamp: 1790160106 },
    { id: 27, role: 'assistant', content: '', tool_calls: call('dup3', 'terminal'), timestamp: 1790160107 },
  ];
}

/**
 * Round 7.6 (§9): rows for the sessions the round-7.6 panes serve. Each session
 * gets two rows, so a reply can be shown to carry the CONTENT of the session its
 * `session_id` names — which is how a session change is proven to have switched
 * what the reader is given, not just the id in the header.
 */
function hermesBannerRows() {
  const row = (id, session, who, text, ts) => ({ id, session, role: 'user', content: text, timestamp: ts });
  return [
    row(30, H_MORPH_OLD, 'user', 'the conversation the pane started with', 1790170000),
    row(31, H_MORPH_OLD, 'assistant', 'answer in the OLD session', 1790170001),
    row(32, H_MORPH_NEW, 'user', 'the fresh session after /clear', 1790170100),
    row(33, H_MORPH_NEW, 'assistant', 'answer in the NEW session', 1790170101),
    row(40, H_NEW, 'user', 'the session the banner names', 1790170200),
    row(41, H_NEW, 'assistant', 'answer from the banner session', 1790170201),
    row(50, H_STORE, 'user', 'the store knows this session', 1790170300),
    row(51, H_STORE, 'assistant', 'answer from the store session', 1790170301),
    // The session the pane's OLD banner names (yesterday's, the DEFECT-17 shape):
    // it has content of its own, so a reply that serves the anchored session can be
    // told apart from one that followed the stale banner.
    row(60, H_OLDER, 'user', 'the session the stale banner names', 1790100000),
    row(61, H_OLDER, 'assistant', 'answer from the stale session', 1790100001),
    row(62, H_ANCHOR, 'user', 'the session herdr is anchored to', 1790170400),
    row(63, H_ANCHOR, 'assistant', 'answer from the anchored session', 1790170401),
    // H_NEW_ANSI deliberately has NO row here: the measured DEFECT-17 state is a
    // session so new that the store has neither a `sessions` row nor a message for
    // it, which is what makes the reply's `session_note` say so.
    row(80, H_NEW_STATUS, 'user', 'the session /status reports', 1790170600),
    row(81, H_NEW_STATUS, 'assistant', 'answer from the /status session', 1790170601),
    row(90, H_NEW_FRESH, 'user', 'the session of a pane herdr never recorded', 1790170700),
    row(91, H_NEW_FRESH, 'assistant', 'answer from the never-recorded session', 1790170701),
  ];
}

/**
 * The `sessions` rows §9.1 reads. `last_activity_at` is relative to the fixture
 * build (the store's freshness window is 10 minutes), and only the cwds of the
 * round-7.6 panes appear — the older panes' cwds deliberately have no row, so
 * their resolution is exactly what it was before this table existed.
 * H_MORPH_NEW is deliberately ABSENT: after `/clear` the store has no row for
 * the new session yet, which is the state measured on the live w4:p7.
 */
function hermesSessionRows(now) {
  return [
    { id: H_NEW, cwd: CWD_HB, started_at: now - 300, last_activity_at: now - 120, message_count: 2 },
    { id: H_STORE, cwd: CWD_HS, started_at: now - 90, last_activity_at: now - 30, message_count: 2 },
    // Yesterday's row, the defunct session DEFECT-17 keeps the pane pinned to: it
    // makes the id KNOWN (so a pane naming it gets no "unknown id" note) while its
    // age is what stops it from ever being resolved as a live session.
    { id: H_OLDER, cwd: CWD_HB, started_at: now - 172800, last_activity_at: now - 172000, message_count: 2 },
  ];
}

function buildHermesFixture() {
  rmrf(DB_FILE);
  const db = new DatabaseSync(DB_FILE);          // writable: this is the FIXTURE
  // Round 7.6: the live store has a `sessions` table (id, cwd, started_at,
  // last_activity_at, ended_at, message_count) and §9.1 reads two things from it:
  // whether a session id the pane names is KNOWN, and the newest session for a
  // pane's cwd. Only the columns src/chat/hermes.js reads exist here, and only
  // rows whose cwd belongs to a round-7.6 pane, so the older checks' panes see
  // exactly what they saw before this table existed.
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT,
    started_at REAL,
    last_activity_at REAL,
    ended_at REAL,
    message_count INTEGER
  )`);
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    timestamp REAL NOT NULL,
    reasoning TEXT,
    reasoning_content TEXT
  )`);
  const ins = db.prepare('INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning, reasoning_content) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const r of hermesRows()) {
    ins.run(r.id, r.session ?? HERMES_SESSION, r.role, r.content ?? null, r.tool_call_id ?? null, r.tool_calls ?? null,
      r.tool_name ?? null, r.timestamp, r.reasoning ?? null, r.reasoning_content ?? null);
  }
  for (const r of hermesDupRows()) {
    ins.run(r.id, HERMES_DUP_SESSION, r.role, r.content ?? null, r.tool_call_id ?? null, r.tool_calls ?? null,
      r.tool_name ?? null, r.timestamp, r.reasoning ?? null, r.reasoning_content ?? null);
  }
  for (const r of hermesBannerRows()) {
    ins.run(r.id, r.session, r.role, r.content ?? null, null, null, null, r.timestamp, null, null);
  }
  const now = Date.now() / 1000;
  const sessIns = db.prepare('INSERT INTO sessions (id, cwd, started_at, last_activity_at, ended_at, message_count) VALUES (?,?,?,?,?,?)');
  for (const s of hermesSessionRows(now)) {
    sessIns.run(s.id, s.cwd, s.started_at, s.last_activity_at, s.ended_at ?? null, s.message_count ?? 0);
  }
  db.close();
  rmrf(path.dirname(NO_DB_FILE));
}

// ---------------------------------------------------------------- mock herdr pipe

/**
 * Stands in for herdr's named pipe, answering the two calls /api/chat makes:
 * `agent.list` (which pane runs which agent and session) and `session.snapshot`
 * (the pane's cwd — §8.1's identity check is against herdr's cwd, never the
 * client's).
 */
function startMockPipe(panes, agents, texts) {
  return new Promise((resolve) => {
    const name = `herdr-dash-chattest-${process.pid}-${Date.now()}`;
    const sockets = new Set();
    // Round 7.6: the pane text each read returns, per pane and source, mutable so
    // a test can act out "/clear wrote a new banner". A pane with no entry reads
    // as empty text — the state of every older fixture pane.
    const paneText = texts || new Map();
    const calls = [];                       // every request the server made, in order
    const snapshot = {
      version: '0.0.0-mock',
      protocol: 22,
      focused_workspace_id: 'w1',
      focused_tab_id: 'w1:t1',
      focused_pane_id: panes[0] && panes[0].pane_id,
      workspaces: [],
      tabs: [],
      layouts: [],
      panes,
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
            // Faithful to the real reply shape (verified against herdr 0.9.1): the
            // text rides in `read.text`, and the source is echoed back.
            const t = paneText.get(params.pane_id) || {};
            const text = params.source === 'visible' ? (t.visible || '') : (t.recent || '');
            reply({
              type: 'pane_read',
              read: {
                pane_id: params.pane_id, workspace_id: 'w1', tab_id: 'w1:t1',
                source: params.source, format: 'text', text, revision: 1, truncated: false,
              },
            });
          } else if (msg.method === 'pane.report_agent_session') {
            // MEASURED herdr behaviour (round 7.6, see src/server.js healHerdr): a
            // report FILLS a missing record and cannot change an existing one —
            // accepted with {"type":"ok"} either way.
            const entry = agents.find((a) => a.pane_id === params.pane_id);
            const has = !!(entry && entry.agent_session && entry.agent_session.value);
            if (entry && !has && params.agent_session_id) {
              entry.agent_session = { agent: params.agent, kind: 'id', source: params.source, value: params.agent_session_id };
            }
            reply({ type: 'ok' });
          } else reply({ ok: true });
        }
      });
    });
    server.on('error', (e) => resolve({ error: e.message, close: async () => {} }));
    server.listen('\\\\.\\pipe\\' + name, () => {
      resolve({
        name,
        calls,
        paneText,
        agents,                                 // the live table: a heal mutates it
        setText: (paneId, t) => { paneText.set(paneId, t); },
        reports: () => calls.filter((c) => c.method === 'pane.report_agent_session'),
        close: () => new Promise((done) => {
          for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
          server.close(() => done());
        }),
      });
    });
  });
}

/** The pane table the fixture server runs against. */
function fixturePanes() {
  const agent = (pane_id, agent, value, cwd, agent_status = 'idle') => ({
    pane_id, cwd, agent, agent_status,
    agent_session: { agent, kind: 'id', source: `herdr:${agent}`, value },
  });
  const agents = [
    agent('w1:basic', 'claude', SESS_BASIC, CWD_OK),
    agent('w1:partial', 'claude', SESS_PARTIAL, CWD_OK),
    agent('w1:caps', 'claude', SESS_CAPS, CWD_OK),
    agent('w1:multi', 'claude', SESS_MULTI, CWD_OK),
    agent('w1:mismatch', 'claude', SESS_MISMATCH, CWD_OK),
    agent('w1:empty', 'claude', SESS_EMPTY, CWD_OK),
    agent('w1:onlyskipped', 'claude', SESS_ONLYSKIPPED, CWD_OK),
    // no log under this cwd at all, so herdr's own (dangling) record is the only
    // thing that could be served — and it is refused: session_file_missing.
    agent('w1:missing', 'claude', SESS_MISSING, CWD_LONE),
    agent('w1:unpaired', 'claude', SESS_UNPAIRED, CWD_OK),
    agent('w1:tail', 'claude', SESS_TAIL, CWD_OK),
    agent('w1:heavy', 'claude', SESS_HEAVY, CWD_OK),
    agent('w1:hermes', 'hermes', HERMES_SESSION, CWD_OK),
    agent('w1:nodb', 'hermes', HERMES_SESSION, CWD_OK),
    agent('w1:hermes-empty', 'hermes', 'a_session_with_no_rows', CWD_OK),
    // Round 7.3: the same session behind a pane that herdr says is WORKING and one
    // it says is idle — the only difference between 'awaiting' and 'not_in_window'
    // for a call with no result in the window.
    agent('w1:dup', 'hermes', HERMES_DUP_SESSION, CWD_OK, 'working'),
    agent('w1:dup-idle', 'hermes', HERMES_DUP_SESSION, CWD_OK, 'idle'),
    agent('w1:pending', 'claude', SESS_PENDING, CWD_OK, 'working'),
    agent('w1:pending-idle', 'claude', SESS_PENDING, CWD_OK, 'idle'),
    agent('w1:codex', 'codex', 'whatever', CWD_OK),
    // ── round 7.6 (§9) ────────────────────────────────────────────────────────
    // hermes: the pane's own banner against herdr's stale record (DEFECT-17). The
    // banner ids are distinct per pane on purpose: herdr's own record is write-once
    // (measured), so a pane that heals under `herdr:hermes` makes its id look
    // "claimed" to the next pane, and one id per pane keeps every expectation
    // independent of the order the checks run in.
    agent('w1:banner', 'hermes', H_HOLD, CWD_HB),                 // banner says H_NEW
    agent('w1:banner-ansi', 'hermes', H_HOLD, CWD_HB),            // same banner through ANSI
    agent('w1:banner-old', 'hermes', H_ANCHOR, CWD_OK),           // banner says H_OLDER: keep herdr
    agent('w1:banner-amb', 'hermes', H_AMB, CWD_OK),              // two banners: disclose, never pick
    agent('w1:banner-garbage', 'hermes', '', CWD_OK),             // only garbage: resolve nothing
    agent('w1:banner-status', 'hermes', H_HOLD, CWD_HB),          // the /status form of the field
    agent('w1:banner-new', 'hermes', '', CWD_HB),                 // herdr records nothing at all
    agent('w1:morph', 'hermes', H_MORPH_OLD, CWD_HM),             // /clear happens to this one
    agent('w1:store', 'hermes', H_STORE_OLD, CWD_HS),             // only the store knows
    agent('w1:stale', 'hermes', HERMES_SESSION, CWD_OK),          // §9.4's watchdog
    // claude: herdr's record versus the logs under the pane's own cwd (one cwd per
    // pane: a session another pane is bound to is never adopted).
    agent('w1:cwdone', 'claude', SESS_ONE_DANGLE, CWD_ONE),       // one log -> picked
    agent('w1:cwdamb', 'claude', SESS_AMB_DANGLE, CWD_AMB),       // two logs -> disclosed
    agent('w1:cwdbound', 'claude', CAND_BOUND, CWD_BOUND),        // herdr's log IS the newest
    agent('w1:cwdnew', 'claude', '', CWD_FRESH),                  // herdr records nothing
    agent('w1:cwdcrowd', 'claude', SESS_CROWD_DANGLE, CWD_CROWD), // its own log is crowded out globally
  ];
  // w1:noagent exists in herdr but runs no agent: it is in the snapshot only.
  const panes = agents.map((a) => ({ pane_id: a.pane_id, cwd: a.cwd }));
  panes.push({ pane_id: 'w1:noagent', cwd: CWD_OK });
  return { panes, agents };
}

/**
 * The pane texts the round-7.6 checks read, keyed by pane id. Everything here is
 * copied from real reads of live panes (§9.1 works on text a terminal wrote, so
 * the fixtures are that text, not a convenient paraphrase):
 *
 *   banner()  the w4:p7 banner DEFECT-17 was written from, byte for byte, and the
 *             `Session:` label measured on it;
 *   ansi()    the SAME banner with SGR sequences around every line — the read asks
 *             herdr for `strip_ansi: true`, but the pane text is untrusted input,
 *             so the parser must not depend on that;
 *   status()  the measured `/status` output, whose `Session ID:` line is the second
 *             place a live hermes writes its id;
 *   quiet()   an idle footer: the elapsed timer is the only thing that moves when
 *             nobody is typing (§9.4 must not read that as the pane working).
 */
function fixturePaneTexts() {
  const banner = (id) => '            │\n'
    + `│  Session: ${id}  research: arxiv, competitor-news-monitor, +2 more\n`
    + '            │\n'
    + '│                                   software-development: atomic-update-verification, +18\n'
    + 'more        │\n'
    + '  ✨ (◕‿◕)✨ Fresh start! Screen cleared and conversation reset.\n';
  const ansi = (s) => s.split('\n').map((l) => '\u001b[38;5;240m' + l + '\u001b[0m').join('\n');
  const quiet = (m = 1, s = 0) => ` ☤ deepseek-flash │ ctx -- │ [░░░░░░░░░░] -- │ ${m}m │ ⏲ ${s}s\n❯ `;
  const status = (id) => [
    '⚙️  /status', 'Hermes CLI Status', '',
    `Session ID: ${id}`, 'Path: ~/AppData/Local/hermes', 'Model: deepseek-flash (deepseek)',
    'Reasoning: medium (display: off)', 'Approvals: smart', 'Created: 2026-09-25 11:45',
    'Last Activity: 2026-09-25 11:45', 'Tokens: 0', 'Agent Running: No', '',
  ].join('\n');
  return new Map([
    // The banner is in BOTH reads (the live case: the candidates came back
    // `visible, recent_unwrapped`), the on-screen one deciding.
    ['w1:banner', { visible: banner(H_NEW) + quiet(17, 3), recent: quiet() + banner(H_NEW) }],
    ['w1:banner-ansi', { visible: ansi(banner(H_NEW_ANSI) + quiet(2, 1)), recent: '' }],
    ['w1:banner-old', { visible: banner(H_OLDER) + quiet(4, 0), recent: '' }],
    // Two DISTINCT sessions on one screen: the DEFECT-17 scrollback shape without
    // a decided answer, which §9.5 says to disclose instead of choosing.
    ['w1:banner-amb', { visible: banner(H_HOLD) + quiet(9, 0) + banner(H_NEW), recent: banner(H_HOLD) + banner(H_NEW) }],
    // A `Session:` field whose value is not a session id: not "no signal", but
    // never a guess either.
    ['w1:banner-garbage', { visible: '│  Session: <id>  │\nSession ID: not-a-session\n❯ waiting\n', recent: '' }],
    ['w1:banner-status', { visible: quiet(5, 12), recent: status(H_NEW_STATUS) }],
    ['w1:banner-new', { visible: banner(H_NEW_FRESH) + quiet(0, 4), recent: '' }],
    // The /clear act: last-seen text first, then the new banner (mutated by the
    // check itself through the mock's setText).
    ['w1:morph', { visible: banner(H_MORPH_OLD) + quiet(6, 0), recent: quiet() }],
    ['w1:store', { visible: quiet(3, 3), recent: '' }],
    ['w1:stale', { visible: quiet(1, 0), recent: '' }],
  ]);
}

// ---------------------------------------------------------------- independent oracle

/** Count records in a fixture jsonl the way the contract counts them. */
function countLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
}

/** Re-read a claude fixture independently: uuid -> its content blocks. */
function blocksByUuid(file) {
  const map = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }
    if (r && r.uuid) map.set(r.uuid, r);
  }
  return map;
}

/** The text a claude tool_result block carries, per §8.2's rule (a string, or
 *  the text blocks of an array, joined in source order). */
function liveResultText(b) {
  const c = b.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === 'string' ? x.text : (typeof x === 'string' ? x : ''))).join('\n');
  return c == null ? '' : JSON.stringify(c);
}

/**
 * tool_use_id -> EVERY text of a tool_result block that answers it, in file
 * order, read straight out of a claude log. The oracle for "the card's result is
 * verbatim": it never asks the parser under test what the result was.
 *
 * It is a MULTIMAP because the logs repeat ids: round 7.3's failure was a map
 * that kept only the LAST row per id (measured: one hermes session declares 141
 * ids twice), so the check compared a card against a row the reader never used.
 */
function liveClaudeResults(file) {
  const map = new Map();
  const add = (id, text) => {
    const k = String(id);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(text);
  };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }
    const content = r && r.message && r.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === 'tool_result' && b.tool_use_id != null) add(b.tool_use_id, liveResultText(b));
    }
  }
  return map;
}

/**
 * The anti-invention rule for cards, in one place so it has teeth that can be
 * tested: every card carrying a result must carry a VERBATIM piece of at least
 * one store row that declares its call id. Both live stores repeat call ids, so
 * "at least one row" is the honest property — a result that appears in NO row
 * carrying the id, and a card whose id no row carries, both fail.
 *
 * @param messages the reply's messages
 * @param sources  call id -> [verbatim row texts] (see liveClaudeResults)
 * @returns how many cards were checked
 */
function checkCardsVerbatim(messages, sources) {
  const cards = messages.filter((m) => m.kind === 'tool_call' && m.tool && m.tool.result != null);
  for (const m of cards) {
    const rows = sources.get(String(m.tool.call_key));
    must(rows && rows.length, `${m.key}: the store has no tool row for ${m.tool.call_key}`);
    must(rows.some((s) => s.includes(m.tool.result)),
      `${m.key}: the card's result is not a verbatim piece of any of the ${rows.length} row(s) carrying ${m.tool.call_key}`);
  }
  return cards.length;
}

/**
 * Round 7.3: tally `pending_reason` over a reply, asserting the vocabulary — and
 * that a card carrying a result carries no reason at all. The live checks only
 * ever run against servers this harness spawned from `src/`, so this is asked of
 * every build the suite starts; the fixture check asserts the key set itself.
 */
function pendingReasonTally(messages, what) {
  const tally = new Map();
  for (const m of messages) {
    if (!m.tool) continue;
    must('pending_reason' in m.tool, `${what} ${m.key}: the tool object carries no pending_reason (round 7.3's field)`);
    if (!m.tool.pending) {
      must(m.tool.pending_reason == null, `${what} ${m.key}: a card with a result carries no pending_reason`);
      continue;
    }
    const r = m.tool.pending_reason;
    must(r === 'awaiting' || r === 'not_in_window' || r === 'duplicate_id',
      `${what} ${m.key}: pending_reason is ${JSON.stringify(r)}, not one of the three states`);
    tally.set(r, (tally.get(r) || 0) + 1);
  }
  return tally;
}

/** The tally as one phrase, for a check's detail line. */
function tallyText(t) {
  return [...t].map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing pending';
}

/**
 * The units a hermes row should yield, rebuilt here from the row alone — the
 * order §8.2's mapping names (content → text, reasoning → thinking, tool_calls →
 * one card each, role "tool" → the result). This is an ORACLE, not the parser:
 * the live check compares the reply against it rather than trusting the code
 * under test to grade itself.
 */
function hermesUnits(row) {
  const content = row.content == null ? '' : String(row.content);
  const reasoning = (row.reasoning != null && String(row.reasoning)) ||
    (row.reasoning_content != null && String(row.reasoning_content)) || '';
  const units = [];
  // Re-derived from the row, not from the server: the only rule taken from round
  // 7.1 is DEFECT-10's — a blank text/thinking value is not a unit, so it does not
  // shift the unit index a message's key ends with.
  if (row.role === 'user') {
    if (content.trim()) units.push({ kind: 'text', text: content });
    return units;
  }
  if (row.role === 'assistant') {
    if (content.trim()) units.push({ kind: 'text', text: content });
    if (reasoning.trim()) units.push({ kind: 'thinking', text: reasoning });
    let calls = null;
    try { calls = JSON.parse(row.tool_calls || '[]'); } catch (e) { calls = null; }
    for (const c of Array.isArray(calls) ? calls : []) {
      const fn = (c && (c.function || c)) || {};
      const args = fn.arguments;
      units.push({
        kind: 'tool_call',
        name: fn.name == null ? null : String(fn.name),
        input: args == null ? null : (typeof args === 'string' ? args : JSON.stringify(args)),
      });
    }
    return units;
  }
  if (row.role === 'tool') {
    units.push({ kind: 'tool_result', name: row.tool_name == null ? null : String(row.tool_name), text: content });
    return units;
  }
  return [];
}

/** §8.2: the message key set, with the two additions this round reports. */
function mustMessageKeys(m, what) {
  const want = ['key', 'ts', 'role', 'kind', 'text', 'text_truncated', 'tool', 'sidechain'].sort();
  const got = Object.keys(m).sort();
  must(JSON.stringify(got) === JSON.stringify(want), `${what}: message keys are ${JSON.stringify(got)}, §8.2 declares ${JSON.stringify(want)}`);
}

/** §8.2's response key set, plus the three counters round 7.1 added: without them
 *  the counting identity cannot be checked once a result is merged into its card
 *  (merged_records) and a blank text/thinking value is not a row (empty_records;
 *  records_with_messages is the per-record half of the same identity) — plus the
 *  eleven §9 fields round 7.6 added: which live session the reply was served
 *  from and how that was decided, whether the binding CHANGED for this pane,
 *  the §9.4 staleness verdict, and whether herdr's own record could be healed
 *  (with the reason when it could not). Declaring them exactly is the point: a
 *  reply that stops carrying one of them — or invents a new one — fails here. */
function mustChatKeys(j, what) {
  const want = [
    'ok', 'pane_id', 'agent', 'source', 'cursor', 'messages', 'truncated', 'skipped',
    'unknown_records', 'no_messages_yet', 'records_with_messages', 'merged_records', 'empty_records',
    'session_id', 'session_detected_by', 'session_change', 'session_candidates', 'session_note',
    'resolved', 'resolved_reason', 'stale', 'stale_reason', 'herdr_healed', 'heal_reason',
  ].sort();
  const got = Object.keys(j).sort();
  must(JSON.stringify(got) === JSON.stringify(want), `${what}: response keys are ${JSON.stringify(got)}, the contract declares ${JSON.stringify(want)}`);
}

/** The counting identity, over one reply's own counters (§8.4, restated in
 *  src/chat/common.js's header): every source record is in exactly one bucket. */
function mustCountingIdentity(j, records, what) {
  const sum = j.records_with_messages + j.merged_records + j.skipped + j.unknown_records;
  eq(sum, records, `${what}: ${j.records_with_messages} records with messages + ${j.merged_records} merged + ${j.skipped} skipped + ${j.unknown_records} unknown must be the ${records} source records`);
  // empty_records is an accounting counter, not a bucket: it counts the blank
  // text/thinking VALUES dropped (DEFECT-10). A record that dropped one and still
  // emitted other units is in records_with_messages, one that emitted nothing is
  // in skipped — so the counter can never exceed those two buckets together.
  must(j.empty_records <= j.records_with_messages + j.skipped,
    `${what}: empty_records (${j.empty_records}) can only come from records that emitted (${j.records_with_messages}) or were skipped (${j.skipped})`);
  must(j.messages.length >= j.records_with_messages,
    `${what}: ${j.messages.length} messages must cover at least the ${j.records_with_messages} records that produced one`);
}

/** Every message's `text`/`tool.result` must be a verbatim piece of its record. */
function mustBeVerbatim(file, messages) {
  const byUuid = blocksByUuid(file);
  for (const m of messages) {
    const [uuid, idx] = String(m.key).split(':');
    const r = byUuid.get(uuid);
    must(r, `${m.key}: no record with uuid ${uuid} in ${path.basename(file)}`);
    const content = r.message && r.message.content;
    const blocks = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
    const b = Number(idx) >= 0 ? blocks[Number(idx)] : null;
    if (m.kind === 'system') {
      must(String(r.content).includes(m.text) || m.text === '', `${m.key}: system text is not a piece of the record`);
      continue;
    }
    must(b, `${m.key}: record has no block ${idx}`);
    const src = b.type === 'thinking' ? b.thinking : b.type === 'tool_result' ? b.content : b.text;
    if (m.kind === 'text' || m.kind === 'thinking') {
      must(typeof src === 'string' && src.includes(m.text), `${m.key}: text is not a verbatim substring of the record`);
    }
    if (m.kind === 'tool_call') {
      must(typeof b.input !== 'undefined', `${m.key}: tool_use block has no input`);
      must(JSON.stringify(b.input).includes(m.tool.input) || m.tool.input === JSON.stringify(b.input),
        `${m.key}: tool input is not a piece of the record's input`);
    }
    if (m.kind === 'tool_result') {
      must(typeof src === 'string' && src.includes(m.tool.result), `${m.key}: tool result is not a verbatim substring of the record`);
    }
  }
}

// ---------------------------------------------------------------- fixture lookups

const FILES = {
  basic: path.join(PROJECTS, 'proj-two', `${SESS_BASIC}.jsonl`),
  partial: path.join(PROJECTS, 'proj-one', `${SESS_PARTIAL}.jsonl`),
  caps: path.join(PROJECTS, 'proj-one', `${SESS_CAPS}.jsonl`),
  multi: path.join(PROJECTS, 'proj-one', `${SESS_MULTI}.jsonl`),
  mismatch: path.join(PROJECTS, 'proj-one', `${SESS_MISMATCH}.jsonl`),
  empty: path.join(PROJECTS, 'proj-one', `${SESS_EMPTY}.jsonl`),
  unpaired: path.join(PROJECTS, 'proj-one', `${SESS_UNPAIRED}.jsonl`),
  tail: path.join(PROJECTS, 'proj-one', `${SESS_TAIL}.jsonl`),
  heavy: path.join(PROJECTS, 'proj-one', `${SESS_HEAVY}.jsonl`),
};

/** How many bytes are in the file right now (the cursor is a byte offset). */
const sizeOf = (p) => fs.statSync(p).size;

/** Walk a session forward from the beginning until the cursor stops moving — the
 *  reference a tail window must end (round 7.1 / DEFECT-9's equivalence claim). */
async function forwardAll(pane, base = BASE) {
  const out = [];
  let cursor = 0;
  for (let i = 0; i < 60; i++) {
    const { json } = await apiChat({ pane_id: pane, since: cursor, limit: 2000 }, { base });
    must(json.ok !== false, `${pane}: forward walk answered ${JSON.stringify(json.error || json.ok)}`);
    for (const m of json.messages) out.push(m);
    if (json.cursor === cursor) break;
    cursor = json.cursor;
  }
  return out;
}

const forwardAllKeys = async (pane, base) => (await forwardAll(pane, base)).map((m) => m.key);

const isSuffix = (tail, full) => tail.length <= full.length
  && full.slice(full.length - tail.length).join(',') === tail.join(',');

// ---------------------------------------------------------------- the run

async function main() {
  console.log(`herdr-dash chat — fixture server ${BASE}, no-db server ${BASE_NO_DB}, live server ${BASE_LIVE}`);

  // A hang must never look like "still running": say where it stalled and stop.
  const watchdog = setTimeout(() => {
    console.error(`WATCHDOG: no result after 240s — the check that stalled was "${currentCheck}"`);
    killAll();
    process.exit(2);
  }, 240000);
  watchdog.unref();

  buildClaudeFixtures();
  buildHermesFixture();

  const { panes, agents } = fixturePanes();
  const mock = await startMockPipe(panes, agents, fixturePaneTexts());
  if (mock.error) throw new Fail(`mock pipe failed: ${mock.error}`);
  mockPipe = mock;

  const fixtureEnv = {
    HERDR_SOCKET_PATH: mock.name,
    CLAUDE_PROJECTS_DIR: PROJECTS,
    HERMES_STATE_DB: DB_FILE,
    // §9's own timings, shortened for the tests that must watch them happen: no
    // cache in the way of an act (every poll re-reads the pane) and a 300 ms
    // staleness window instead of "~60 s".
    CHAT_SESSION_CACHE_MS: '0',
    CHAT_STALE_MS: '300',
  };
  await startServer(PORT, fixtureEnv, 'fixture');
  await startServer(PORT_NO_DB, Object.assign({}, fixtureEnv, { HERMES_STATE_DB: NO_DB_FILE }), 'no-db');

  // ── shape and happy path ───────────────────────────────────────────────────
  await check('shape: the response carries §8.2\'s exact keys and a resolved source', async () => {
    const { json } = await apiChat({ pane_id: 'w1:basic' });
    mustChatKeys(json, 'basic');
    eq(json.agent, 'claude', 'agent');
    eq(json.source.kind, 'claude_jsonl', 'source.kind');
    eq(json.source.session_id, SESS_BASIC, 'source.session_id');
    eq(json.source.path, path.resolve(FILES.basic), 'source.path');
    must(json.cursor > 0 && Number.isInteger(json.cursor), 'cursor must be a positive byte offset, got ' + json.cursor);
    return { detail: `${json.messages.length} messages, cursor ${json.cursor}` };
  });

  await check('claude: every record in the fixture is accounted for (records_with_messages + merged + skipped + unknown)', async () => {
    const { json } = await apiChat({ pane_id: 'w1:basic' });
    const lines = countLines(FILES.basic);
    eq(lines, 16, 'fixture record count');
    mustCountingIdentity(json, lines, 'basic');
    eq(json.skipped, 4, 'the two excluded records (file-history-snapshot, attachment) + the two blank blocks');
    eq(json.empty_records, 2, 'the two blank text/thinking blocks (DEFECT-10: not rows, but counted)');
    eq(json.unknown_records, 2, 'the two unrecognised types (queue-operation, custom-title)');
    eq(json.merged_records, 2, 'the two results carried by the cards they answer (DEFECT-11)');
    eq(json.messages.length, 8, 'messages');
    eq(json.records_with_messages, 8, 'records that produced a message');
    return { detail: `${lines} records = 8 with messages + 2 merged + 4 skipped (2 blank) + 2 unknown` };
  });

  await check('DEFECT-10: no blank rows — every text/thinking message carries visible text', async () => {
    for (const pane of ['w1:basic', 'w1:tail', 'w1:heavy']) {
      const { json } = await apiChat({ pane_id: pane, limit: 2000 });
      const blank = json.messages.filter((m) => (m.kind === 'text' || m.kind === 'thinking') && m.text.trim() === '');
      eq(blank.length, 0, `${pane}: blank rows in the stream`);
    }
    const basic = (await apiChat({ pane_id: 'w1:basic' })).json;
    must(basic.empty_records === 2, `the two blank blocks must still be counted, saw ${basic.empty_records}`);
    return { detail: 'no message with empty text in three sessions; the suppressed blocks stay visible as empty_records' };
  });

  await check('DEFECT-11: a paired result is carried ONCE, in its card — and an unpaired one keeps its own message', async () => {
    const { json } = await apiChat({ pane_id: 'w1:basic' });
    const resultMsgs = json.messages.filter((m) => m.kind === 'tool_result');
    eq(resultMsgs.length, 0, 'a result whose card is in the reply must not also be a message');
    const callA = json.messages.find((m) => m.tool && m.tool.call_key === 'call_A');
    eq(callA.tool.result, 'file1\nfile2', 'call_A carries its result');
    const callC = json.messages.find((m) => m.tool && m.tool.call_key === 'call_C');
    eq(callC.tool.result, 'boom: exit 1', 'call_C carries its result');
    eq(callC.tool.is_error, true, 'call_C is_error');

    // The unpaired result is the one case that stays its own message.
    const un = await apiChat({ pane_id: 'w1:unpaired' });
    eq(un.json.messages.length, 1, 'the unpaired result is one message');
    const um = un.json.messages[0];
    eq(um.kind, 'tool_result', 'kind');
    eq(um.tool.call_key, 'call_absent', 'call_key');
    eq(um.tool.result, 'output with no card', 'result');
    eq(um.tool.pending, false, 'a result is never pending');
    mustCountingIdentity(un.json, countLines(FILES.unpaired), 'unpaired');

    // hermes: same rule, and the unpaired row survives the merge pass.
    const hz = await apiChat({ pane_id: 'w1:hermes' });
    const hResult = hz.json.messages.filter((m) => m.kind === 'tool_result');
    eq(hResult.length, 1, 'hermes: exactly the unpaired result row keeps its own message');
    eq(hResult[0].tool.call_key, 'c_absent', 'hermes: the unpaired row');
    eq(hResult[0].tool.name, 'terminal', 'hermes: the unpaired row carries its tool name');
    const hCall = hz.json.messages.find((m) => m.tool && m.tool.call_key === 'c1');
    eq(hCall.tool.result, '{"output":"a\\nb"}', 'hermes: the paired card carries the row\'s output');
    eq(hCall.tool.pending, false, 'hermes: the paired card is no longer pending');
    return { detail: 'no duplicate result in either store; 1 unpaired result per store keeps its message' };
  });

  await check('DEFECT-11: the payload effect — each result text appears exactly once in the raw reply', async () => {
    const res = await request('GET', `${BASE}/api/chat?pane_id=w1:heavy&limit=2000`);
    must(res.json && res.json.ok !== false, `heavy fixture answered ${res.text.slice(0, 120)}`);
    const n = heavyRecords().length;
    eq(res.json.messages.length, 13, `13 units (1 user + 12 cards), saw ${res.json.messages.length}`);
    const sizes = [];
    for (let i = 0; i < 12; i++) {
      const marker = `MARKER-${i}-`;
      const at = res.text.indexOf(marker);
      must(at >= 0, `the reply does not carry the result text ${marker}`);
      eq(res.text.indexOf(marker, at + 1), -1, `${marker} appears more than once in the reply`);
      // What a pre-7.1 reply added: the same result again, as its own message.
      const resultText = res.json.messages.find((m) => m.tool && m.tool.call_key === `call_H${i}`).tool.result;
      sizes.push(Buffer.byteLength(JSON.stringify({
        key: 'h-r0:0', ts: null, role: 'user', kind: 'tool_result', text: '', text_truncated: false,
        tool: { name: null, call_key: `call_H${i}`, input: null, input_truncated: false, result: resultText, result_truncated: false, is_error: false, pending: false },
        sidechain: false,
      }), 'utf8'));
    }
    const after = Buffer.byteLength(res.text, 'utf8');
    const removed = sizes.reduce((a, b) => a + b, 0);
    must(n === 25, 'the heavy fixture is 25 records');
    return { detail: `${after} bytes now; the 12 duplicate result messages a pre-7.1 reply carried were ${removed} more (${Math.round((after + removed) / after * 10) / 10}× the payload)` };
  });

  await check('claude: every emitted text is a verbatim substring of its source record', async () => {
    const { json } = await apiChat({ pane_id: 'w1:basic' });
    mustBeVerbatim(FILES.basic, json.messages);
    return true;
  });

  await check('claude: the message shape is §8.2\'s, key by key', async () => {
    const { json } = await apiChat({ pane_id: 'w1:basic' });
    for (const m of json.messages) mustMessageKeys(m, m.key);
    const user = json.messages.find((m) => m.role === 'user' && m.kind === 'text');
    must(user, 'no user text message');
    eq(user.text, 'hello from the user', 'user text');
    eq(user.tool, null, 'a text message has no tool object');
    eq(user.ts, Date.parse('2026-09-24T10:00:01.000Z'), 'ts is epoch ms');
    return true;
  });

  await check('claude: order is file order and thinking/text/call keep their kinds', async () => {
    const { json } = await apiChat({ pane_id: 'w1:basic' });
    const kinds = json.messages.map((m) => m.kind);
    eq(kinds.slice(0, 5).join(','), 'text,thinking,text,tool_call,tool_call', 'first five kinds (the result of call_A rides in its card)');
    const uuids = json.messages.map((m) => String(m.key).split(':')[0]);
    const sorted = [...uuids].sort();
    must(uuids.join(',') !== sorted.join(',') || uuids.length < 2, 'expected file order, not sorted order');
    must(uuids.indexOf('u-1') < uuids.indexOf('a-6'), 'u-1 must come before a-6 (file order)');
    return true;
  });

  await check('claude: tool_use and tool_result are paired by id (name, result, is_error, pending)', async () => {
    const { json } = await apiChat({ pane_id: 'w1:basic' });
    const callA = json.messages.find((m) => m.tool && m.tool.call_key === 'call_A');
    must(callA, 'no message for call_A');
    eq(callA.kind, 'tool_call', 'call_A kind');
    eq(callA.tool.name, 'Bash', 'call_A name');
    eq(callA.tool.pending, false, 'call_A pending (its result is in the same window)');
    eq(callA.tool.result, 'file1\nfile2', 'call_A result');
    eq(callA.tool.is_error, false, 'call_A is_error');

    const callB = json.messages.find((m) => m.tool && m.tool.call_key === 'call_B');
    must(callB, 'no message for call_B');
    eq(callB.tool.pending, true, 'call_B pending (no result in this log)');
    eq(callB.tool.result, null, 'call_B result must be null while pending');

    const callC = json.messages.find((m) => m.tool && m.tool.call_key === 'call_C');
    eq(callC.tool.is_error, true, 'call_C is_error');
    eq(callC.tool.pending, false, 'call_C pending');
    // The result is a VERBATIM piece of the record that carried it — the card's
    // text comes from the result record, never from the call's own block.
    const rawRecords = blocksByUuid(FILES.basic);
    eq(rawRecords.get('u-2').message.content[0].content, callA.tool.result, 'call_A\'s result is the tool_result record\'s text');
    return true;
  });

  await check('claude: isSidechain is flagged on the message, not merged into the thread', async () => {
    const { json } = await apiChat({ pane_id: 'w1:basic' });
    const side = json.messages.filter((m) => m.sidechain);
    eq(side.length, 1, 'sidechain messages');
    eq(side[0].text, 'sidechain note', 'sidechain text');
    const main = json.messages.filter((m) => !m.sidechain && m.text === 'sidechain note');
    eq(main.length, 0, 'the sidechain text must not also appear as a main-thread message');
    return true;
  });

  await check('claude: a system record becomes kind "system"', async () => {
    const { json } = await apiChat({ pane_id: 'w1:basic' });
    const sys = json.messages.filter((m) => m.kind === 'system');
    eq(sys.length, 1, 'system messages');
    eq(sys[0].text, '<local-command-stdout>done</local-command-stdout>', 'system text');
    eq(sys[0].role, 'tool', 'system lines are machine output, not user or assistant');
    return true;
  });

  // ── cursor ─────────────────────────────────────────────────────────────────
  const fullBasic = await apiChat({ pane_id: 'w1:basic' });
  await check('cursor: a second call with the same cursor is byte-identical, with no messages', async () => {
    const a = await request('GET', `${BASE}/api/chat?pane_id=w1:basic&since=${fullBasic.json.cursor}`);
    const b = await request('GET', `${BASE}/api/chat?pane_id=w1:basic&since=${fullBasic.json.cursor}`);
    must(a.json && b.json, 'no JSON reply');
    eq(a.text, b.text, 'two replies at the same cursor must be byte-identical');
    eq(a.json.messages.length, 0, 'messages at a consumed cursor');
    eq(a.json.cursor, fullBasic.json.cursor, 'cursor must not move');
    eq(a.json.skipped + a.json.unknown_records, 0, 'a consumed cursor re-counts nothing');
    return true;
  });

  await check('cursor: claude is a byte offset that lands exactly after the last reported line', async () => {
    const first = await apiChat({ pane_id: 'w1:basic', limit: 4 });
    const raw = fs.readFileSync(FILES.basic, 'utf8');
    eq(first.json.messages.length, 4, 'messages in the limited window');
    eq(first.json.truncated, true, 'truncated with more records left');
    must(first.json.cursor < sizeOf(FILES.basic), 'cursor must be inside the file');
    eq(raw.slice(0, first.json.cursor).endsWith('\n'), true, 'the cursor must land after a newline');
    const reported = raw.slice(0, first.json.cursor).split('\n').filter((l) => l.trim()).length;
    // Everything before the cursor is accounted for by the reply's own counters.
    // It is 5 records for 4 messages here because the window ends on call_A's card
    // and that call's result record rides in the card (merged_records) — which is
    // exactly why the cursor has to cover it: otherwise the next forward poll would
    // report the same result a second time.
    eq(reported, first.json.records_with_messages + first.json.merged_records + first.json.skipped + first.json.unknown_records,
      'the cursor covers exactly the records the reply accounted for');
    eq(reported, first.json.messages.length + first.json.merged_records, 'one merged record rides along with the four messages');
    mustCountingIdentity(first.json, reported, 'a limited claude window');
    const next = await apiChat({ pane_id: 'w1:basic', since: first.json.cursor, limit: 4 });
    eq(next.json.messages.length, 4, 'the next window');
    must(next.json.messages[0].key !== first.json.messages[0].key, 'the next window must start somewhere else');
    must(next.json.messages.every((m) => !first.json.messages.some((f) => f.key === m.key)), 'no message may be reported twice');
    eq(next.json.messages[0].ts > first.json.messages[3].ts, true, 'file order: the next window is later in the file');
    return true;
  });

  await check('cursor: a half-written trailing line is not emitted and does not move the cursor', async () => {
    const before = sizeOf(FILES.partial);
    const first = await apiChat({ pane_id: 'w1:partial' });
    eq(first.json.messages.length, 2, 'the two complete records');
    eq(first.json.truncated, true, 'more bytes are sitting there unread');
    must(first.json.cursor < before, 'the cursor must not have passed the partial line');
    eq(fs.readFileSync(FILES.partial, 'utf8').slice(first.json.cursor).includes('\n'), false,
      'everything after the cursor must be the partial line (no newline yet)');
    // Same cursor again while the writer has not finished: nothing new, nothing moves.
    const again = await apiChat({ pane_id: 'w1:partial', since: first.json.cursor });
    eq(again.json.messages.length, 0, 'the partial line must not be emitted');
    eq(again.json.cursor, first.json.cursor, 'the cursor must not advance over a partial line');
    return { detail: `cursor held at ${first.json.cursor} of ${before} bytes` };
  });

  await check('cursor: completing the half-written line makes the record appear exactly once', async () => {
    const before = await apiChat({ pane_id: 'w1:partial' });
    const file = FILES.partial;
    const raw = fs.readFileSync(file, 'utf8');
    const partial = raw.slice(before.json.cursor);
    const full = JSON.stringify(rec('assistant', 'p-3', T(3), [{ type: 'text', text: 'HALF WRITTEN LINE' }]));
    must(full.startsWith(partial), 'the fixture\'s partial line must be a prefix of the completed record');
    fs.appendFileSync(file, full.slice(partial.length) + '\n', 'utf8');    // the writer finishes
    const after = await apiChat({ pane_id: 'w1:partial', since: before.json.cursor });
    eq(after.json.messages.length, 1, 'exactly the completed record');
    eq(after.json.messages[0].text, 'HALF WRITTEN LINE', 'the completed record\'s text');
    const end = await apiChat({ pane_id: 'w1:partial', since: after.json.cursor });
    eq(end.json.messages.length, 0, 'and nothing again');
    return true;
  });

  await check('cursor: skipped and unknown records still advance it (no stall on excluded types)', async () => {
    const only = [ // a window whose records are all excluded or unknown
      { type: 'attachment', uuid: 'x-1', timestamp: T(1), cwd: CWD_OK },
      { type: 'mode', sessionId: 'x' },
      { type: 'queue-operation', operation: 'enqueue', timestamp: T(2), content: 'q' },
    ];
    const file = path.join(PROJECTS, 'proj-one', `${SESS_ONLYSKIPPED}.jsonl`);
    writeLF(file, only.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const { json } = await apiChat({ pane_id: 'w1:onlyskipped' });
    eq(json.messages.length, 0, 'no messages');
    eq(json.skipped, 2, 'two excluded records');
    eq(json.unknown_records, 1, 'one unrecognised record');
    eq(json.cursor, sizeOf(file), 'the cursor must be at EOF');
    const again = await apiChat({ pane_id: 'w1:onlyskipped', since: json.cursor });
    eq(again.json.skipped + again.json.unknown_records, 0, 'a consumed cursor must not re-count skipped records');
    return true;
  });

  // ── tail (round 7.1 / DEFECT-9) ─────────────────────────────────────────────
  await check('tail: the NEWEST units, in source order, with the cursor at EOF', async () => {
    const { json } = await apiChat({ pane_id: 'w1:basic', tail: 1, limit: 3 });
    must(json.ok !== false, `tail answered ${JSON.stringify(json.error || json.ok)}`);
    mustChatKeys(json, 'tail');
    const whole = await forwardAll('w1:basic');
    const full = whole.map((m) => m.key);
    const tailKeys = json.messages.map((m) => m.key);
    eq(tailKeys.length, 3, 'three units asked for, three returned');
    // The conversation's last three MESSAGES: a-5 (call_C's card, with u-3's result
    // folded into it), a-6, s-1. `limit` counts messages, so the pair costs the
    // window one slot, not two — the card comes along and the result rides in it
    // instead of being left outside as an unpaired tool_result. Everything after
    // the window ends the conversation exactly.
    let lead = 0;
    while (lead < json.messages.length && json.messages[lead].kind === 'tool_result') lead++;
    const calls = new Set(whole.filter((m) => m.kind === 'tool_call').map((m) => m.tool.call_key));
    must(json.messages.slice(0, lead).every((m) => m.tool && calls.has(m.tool.call_key)),
      'a leading unpaired result must name a call that really exists');
    must(isSuffix(tailKeys.slice(lead), full),
      `the tail window minus its ${lead} leading unpaired result(s) must be the END of the conversation, got ${JSON.stringify(tailKeys)} of ${JSON.stringify(full)}`);
    eq(json.cursor, sizeOf(FILES.basic), 'the cursor is at EOF (the file ends on a record boundary)');
    eq(json.truncated, true, 'older messages exist before the window');
    // The counters describe the RECORDS THE WINDOW WALKED, not the whole session.
    // To reach three messages the backwards walk passes the four records older
    // than s-1 that render nothing (two excluded types, two unrecognised) —
    // exactly as a forward page advances its cursor over them. That is 10 records:
    // 3 with messages (a-5, a-6, s-1), 1 merged (u-3's result record), 4 skipped
    // (2 of them blank), 2 unknown.
    const walked = json.records_with_messages + json.merged_records + json.skipped + json.unknown_records;
    eq(walked, 10, 'records the window walked');
    eq(json.records_with_messages, 3, 'of which produced the three messages');
    eq(json.merged_records, 1, 'one record travelled inside the card the window reached');
    eq(json.skipped, 4, 'two excluded records and the two blank ones');
    eq(json.unknown_records, 2, 'two unrecognised types');
    return { detail: `last 3 of ${full.length} messages, cursor at EOF ${json.cursor}` };
  });

  await check('tail: the same request twice is byte-identical, and tail=0 is the forward read', async () => {
    const a = await request('GET', `${BASE}/api/chat?pane_id=w1:basic&tail=1&limit=4`);
    const b = await request('GET', `${BASE}/api/chat?pane_id=w1:basic&tail=1&limit=4`);
    eq(a.text, b.text, 'two tail replies must be byte-identical');
    const zero = await request('GET', `${BASE}/api/chat?pane_id=w1:basic&tail=0&limit=4`);
    const plain = await request('GET', `${BASE}/api/chat?pane_id=w1:basic&limit=4`);
    eq(zero.text, plain.text, 'tail=0 must be the forward read, byte for byte');
    must(plain.json.messages[0].key !== a.json.messages[0].key || plain.json.messages.length > 1,
      'the forward read and the tail must be different windows');
    const falsey = await request('GET', `${BASE}/api/chat?pane_id=w1:basic&tail=false&limit=4`);
    eq(falsey.text, plain.text, 'tail=false is the forward read too');
    return true;
  });

  await check('tail: since and tail=1 together are rejected (bad_request), not silently combined', async () => {
    const both = await apiChat({ pane_id: 'w1:basic', since: 10, tail: 1 });
    eq(both.json.ok, false, 'ok');
    eq(both.json.error.code, 'bad_request', 'code');
    must(/since/.test(both.json.error.message) && /tail/.test(both.json.error.message),
      'the message must name both parameters');
    const zeroSince = await apiChat({ pane_id: 'w1:basic', since: 0, tail: 1 });
    eq(zeroSince.json.error.code, 'bad_request', 'since=0 is a cursor too');
    const empty = await apiChat({ pane_id: 'w1:basic', since: '', tail: 1 });
    eq(empty.json.ok, true, 'an empty since= is not a cursor and must be accepted');
    const bad = await apiChat({ pane_id: 'w1:basic', tail: 'yesterday' });
    eq(bad.json.error.code, 'bad_request', 'a tail value that is neither 1 nor 0');
    return true;
  });

  await check('tail: the newest whole records, never a fragment (a half-written last line)', async () => {
    const size = sizeOf(FILES.tail);
    const all = await apiChat({ pane_id: 'w1:tail', tail: 1, limit: 2000 });
    eq(all.json.messages.length, 4, 'units: t-1, t-2, call_T, t-5 (t-4 rides in call_T\'s card)');
    eq(all.json.merged_records, 1, 'the result record is merged');
    // …and it is IN the card, not just counted: a tail window whose cards were left
    // pending would drop the result text from the reply.
    const card = all.json.messages.find((m) => m.kind === 'tool_call');
    eq(card.tool.call_key, 'call_T', 'the card in the window');
    eq(card.tool.result, 'hi', 'carries its result');
    eq(card.tool.pending, false, 'and is not pending');
    eq(all.json.messages.filter((m) => m.tool && m.tool.result != null).length, all.json.merged_records,
      'every merged record is a card carrying its result');
    eq(all.json.truncated, false, 'nothing is older than this window');
    // A tail wide enough to hold the session accounts for every record in it.
    mustCountingIdentity(all.json, countLines(FILES.tail) - 1, 'the whole tail file (the half-written line is not a record)');
    must(all.json.cursor < size, 'the cursor must stop before the half-written line');
    eq(fs.readFileSync(FILES.tail, 'utf8').slice(all.json.cursor).includes('\n'), false,
      'everything after the cursor must be the half-written line');
    // A window narrower than the conversation keeps only the newest records, and
    // still hands the caller a cursor it can poll forward from.
    const small = await apiChat({ pane_id: 'w1:tail', tail: 1, limit: 2 });
    eq(small.json.messages.length, 2, 'two messages');
    // t-5's text and call_T's card carrying t-4's result. Two units (the card and
    // the result) cost the window ONE slot, so a window this narrow still reaches
    // the card and the result is folded into it — not left outside as a second,
    // unpaired tool_result message.
    eq(small.json.messages[1].kind, 'text', 'the newest message is t-5\'s text');
    eq(small.json.messages[0].kind, 'tool_call', 'and call_T\'s card before it');
    eq(small.json.messages[0].tool.call_key, 'call_T', 'the card in the window');
    eq(small.json.messages[0].tool.result, 'hi', 'with its verbatim result folded in');
    eq(small.json.messages[0].tool.pending, false, 'and not left pending');
    eq(small.json.messages.filter((m) => m.kind === 'tool_result').length, 0,
      'the result is not also sent as a message of its own');
    eq(small.json.truncated, true, 'older messages exist before this window');
    eq(small.json.cursor, all.json.cursor, 'the cursor is the same live end either way');
    const fwd = await apiChat({ pane_id: 'w1:tail', since: small.json.cursor });
    eq(fwd.json.messages.length, 0, 'polling forward from the tail cursor is a no-op while nothing is written');
    eq(fwd.json.cursor, small.json.cursor, 'and it does not move');
    return { detail: `cursor ${all.json.cursor} of ${size} bytes (the rest is the half-written line)` };
  });

  await check('tail: a tail window ends the conversation — the suffix the forward reader produces', async () => {
    for (const pane of ['w1:basic', 'w1:heavy', 'w1:caps']) {
      const whole = await forwardAll(pane);
      const full = whole.map((m) => m.key);
      const calls = new Set(whole.filter((m) => m.kind === 'tool_call').map((m) => m.tool.call_key));
      for (const limit of [1, 3, 7, 2000]) {
        const { json } = await apiChat({ pane_id: pane, tail: 1, limit });
        const keys = json.messages.map((m) => m.key);
        must(keys.length <= limit, `${pane} tail limit=${limit}: ${keys.length} messages exceeds the limit`);
        must(keys.length > 0, `${pane} tail limit=${limit}: empty`);
        // Where the window starts inside a call/result pair, it cannot carry the
        // card (the card is older than the window) and must NOT invent one: the
        // result stays a tool_result message naming its call — DEFECT-11's unpaired
        // case. Such results can only be the window's OLDEST messages, and the rest
        // of the window is still the exact end of the conversation.
        let lead = 0;
        while (lead < json.messages.length && json.messages[lead].kind === 'tool_result') {
          const m = json.messages[lead];
          must(m.tool && m.tool.call_key, `${pane} tail limit=${limit}: an unpaired result must name the call it answers`);
          must(calls.has(m.tool.call_key),
            `${pane} tail limit=${limit}: ${m.tool.call_key} is not a call in this session — a result may not invent one`);
          lead++;
        }
        const rest = keys.slice(lead);
        must(isSuffix(rest, full),
          `${pane} tail limit=${limit}: the window minus its ${lead} leading unpaired result(s) must be the end of the conversation, got ${JSON.stringify(keys)}`);
      }
      // The tail's cursor must equal the forward walk's end, or sit before a
      // half-written line — a caller that polls forward from it must never see a
      // message twice.
      const end = await apiChat({ pane_id: pane, tail: 1, limit: 2000 });
      const fwd = await apiChat({ pane_id: pane, since: end.json.cursor, limit: 2000 });
      const dup = fwd.json.messages.filter((m) => end.json.messages.some((e) => e.key === m.key));
      eq(dup.length, 0, `${pane}: a forward poll from the tail cursor must not repeat a message`);
    }
    return { detail: 'basic, heavy and caps: every tail window ends the conversation; leading unpaired results name real calls' };
  });

  await check('tail: hermes — the newest rows in source order, cursor at MAX(id), rows kept whole', async () => {
    // The newest row is row 8, a tool row whose call row is absent: it keeps its
    // own tool_result message and names the call it answers. limit=2 cannot also
    // carry row 5 (content + two calls is three units on one row), and a row is
    // never split — so one message, and `truncated` says the rest is there.
    const { json } = await apiChat({ pane_id: 'w1:hermes', tail: 1, limit: 2 });
    eq(json.cursor, 8, 'the cursor is the highest row id');
    eq(json.truncated, true, 'older rows exist');
    eq(json.messages.length, 1, 'rows are atomic: one whole row fits, the next one does not');
    eq(json.messages[0].kind, 'tool_result', 'the newest unit is row 8\'s result');
    eq(json.messages[0].tool.call_key, 'c_absent', 'which names the call it answers');
    // Wider than the conversation: everything, cursor still at MAX(id).
    const all = await apiChat({ pane_id: 'w1:hermes', tail: 1, limit: 2000 });
    eq(all.json.messages.map((m) => m.kind).join(','), 'text,text,thinking,thinking,tool_call,tool_call,tool_call,tool_result',
      'all eight units, in source order');
    eq(all.json.cursor, 8, 'cursor at MAX(id)');
    eq(all.json.truncated, false, 'no rows are older than this window');
    mustCountingIdentity(all.json, hermesRows().length, 'hermes tail');
    // The merged row's result is inside row 3's card — a tail window that counted
    // the merge but left the card pending would lose the tool output entirely.
    const c1 = all.json.messages.find((m) => m.kind === 'tool_call' && m.tool.call_key === 'c1');
    eq(c1.tool.result, '{"output":"a\\nb"}', 'c1\'s card carries row 4\'s output');
    eq(c1.tool.pending, false, 'and is not pending');
    eq(all.json.messages.filter((m) => m.kind === 'tool_call' && m.tool.result != null).length, all.json.merged_records,
      'every merged row is a card carrying its result');
    // DEFECT-11's boundary, as the tail has to draw it too: a window that starts
    // between c1's call (row 3) and its result (row 4). The result has no card in
    // the window, so it keeps its own message — the renderer's "unpaired" case,
    // which is why every tool_result carries tool.call_key.
    const straddle = await apiChat({ pane_id: 'w1:hermes', tail: 1, limit: 4 });
    eq(straddle.json.messages.map((m) => m.kind).join(','), 'tool_result,tool_call,tool_call,tool_result',
      'limit=4 reaches back to row 4 but not to its call');
    const first = straddle.json.messages[0];
    eq(first.tool.call_key, 'c1', 'the leading result names the call it answers');
    eq(straddle.json.messages.filter((m) => m.kind === 'tool_call' && m.tool.call_key === 'c1').length, 0,
      'and that card is not in this window');
    eq(straddle.json.messages.filter((m) => m.tool && m.tool.pending).length, 2, 'c2 and c3 are still pending');
    mustCountingIdentity(straddle.json, 5, 'the hermes tail window (rows 4..8)');
    return { detail: `limit=2 -> row 8 only, cursor ${json.cursor}; limit=2000 -> 8 units over ${hermesRows().length} rows` };
  });

  // ── duplicates and honest pending state (round 7.3) ────────────────────────
  await check('duplicates: a repeated call id pairs with the FIRST card, and the LAST result row wins its text', async () => {
    const { json } = await apiChat({ pane_id: 'w1:dup', tail: 1, limit: 200 });
    eq(json.source.kind, 'hermes_sqlite', 'source.kind');
    const cards = json.messages.filter((m) => m.kind === 'tool_call');
    eq(cards.map((m) => m.key).join(','), '21:0,22:0,25:0,27:0', 'the four cards, in row order');
    // The preference the reader documents (hermes.js's header): among cards that
    // declare one id, the FIRST is the merge target — and because
    // absorbPairedResults folds from the end, the LAST result row for that id is
    // the text it carries.
    const paired = cards.filter((m) => m.tool.call_key === 'dup1' && m.tool.result != null);
    eq(paired.length, 1, 'exactly one of the two cards declaring dup1 carries a result');
    eq(paired[0].key, '21:0', 'the first card with that id is the one that gets it');
    eq(paired[0].tool.result, 'SECOND-dup1-result', 'and the last result row for that id is the text it carries');
    eq(paired[0].tool.pending, false, 'a card carrying a result is not pending');
    const twin = cards.find((m) => m.key === '22:0');
    eq(twin.tool.pending, true, 'the later twin never becomes a merge target');
    eq(twin.tool.result, null, 'and invents no result of its own');
    eq(cards.find((m) => m.key === '25:0').tool.result, 'dup2 result', 'an id that appears once pairs normally');
    eq(cards.find((m) => m.key === '27:0').tool.result, null, 'the unanswered call stays without one');
    eq(json.merged_records, 3, 'rows 23, 24 and 26 all merged into a card');
    mustCountingIdentity(json, hermesDupRows().length, 'the dup window (rows 20..27)');
    return { detail: `${cards.length} cards, 3 of 8 rows merged, the repeated id paired once` };
  });

  await check('pending_reason: awaiting | not_in_window | duplicate_id, and null on every card that has a result', async () => {
    // 1. The pane herdr calls working, the window at the live end, the newest call
    //    answered by nothing: 'awaiting' — and the twin of a repeated id keeps its
    //    own reason, which no liveness signal can change.
    const live = await apiChat({ pane_id: 'w1:dup', tail: 1, limit: 200 });
    const reasons = live.json.messages.filter((m) => m.tool && m.tool.pending)
      .map((m) => `${m.key}=${m.tool.pending_reason}`).join(' ');
    eq(reasons, '22:0=duplicate_id 27:0=awaiting', 'a working pane at the live end');
    must(live.json.messages.filter((m) => m.tool && !m.tool.pending).every((m) => m.tool.pending_reason === null),
      'a card with a result carries no pending_reason');
    must(live.json.messages.every((m) => !m.tool || m.tool.pending_reason !== 'awaiting' || m.tool.pending),
      'only a pending card may say awaiting');

    // 2. The SAME window on a pane herdr calls idle: nothing is in flight, so
    //    nothing may say 'awaiting' — the honest word is 'not_in_window'.
    const idle = await apiChat({ pane_id: 'w1:dup-idle', tail: 1, limit: 200 });
    const idleReasons = idle.json.messages.filter((m) => m.tool && m.tool.pending)
      .map((m) => `${m.key}=${m.tool.pending_reason}`).join(' ');
    eq(idleReasons, '22:0=duplicate_id 27:0=not_in_window', 'the same rows on an idle pane');

    // 3. A window cut between a card and the rows that answer it: limit counts
    //    MESSAGES, so a merge is free and only a cut like this one leaves a card
    //    whose result is genuinely outside the reply. It may not claim to await it.
    const cut = await apiChat({ pane_id: 'w1:dup', limit: 2 });
    eq(cut.json.truncated, true, 'the window is cut short, more rows follow');
    eq(cut.json.cursor, 21, 'the cursor stops at the last row this reply reported');
    eq(cut.json.messages.filter((m) => m.tool).map((m) => `${m.key}=${m.tool.pending_reason}`).join(' '),
      '21:0=not_in_window', 'a result beyond the window is not_in_window, not awaiting');

    // 4. claude, both sides of the same signal: a session whose newest record is a
    //    call nothing has answered.
    const claudeLive = await apiChat({ pane_id: 'w1:pending', tail: 1, limit: 200 });
    eq(claudeLive.json.messages.map((m) => m.kind).join(','), 'text,tool_call', 'the pending claude session');
    eq(claudeLive.json.messages[1].tool.pending_reason, 'awaiting', 'a working claude pane, newest record, no result');
    const claudeIdle = await apiChat({ pane_id: 'w1:pending-idle', tail: 1, limit: 200 });
    eq(claudeIdle.json.messages[1].tool.pending_reason, 'not_in_window', 'the same record on an idle pane');
    //    ...and a truncated claude window, whose remaining records hold the answer.
    const basic = await apiChat({ pane_id: 'w1:basic', limit: 5 });
    const callB = basic.json.messages.find((m) => m.tool && m.tool.call_key === 'call_B');
    eq(callB.tool.pending, true, 'call_B has no result record at all');
    eq(callB.tool.pending_reason, 'not_in_window', 'and its window is not the live end');
    return { detail: 'duplicate_id + awaiting + not_in_window (both stores, both liveness readings)' };
  });

  await check('pending_reason: the card-vs-store rule keeps its teeth (an invented result fails)', async () => {
    // The rule the live check runs, tested against a synthetic store it cannot
    // edit: a result present only in the SECOND row of a repeated id is accepted
    // (that is the round-7.3 fix), an invented result and an unknown id are not.
    const sources = new Map([['call_x', ['alpha beta', 'alpha beta']], ['call_y', ['gamma']]]);
    const card = (key, result) => ({ key, kind: 'tool_call', tool: { call_key: key, result } });
    eq(checkCardsVerbatim([card('call_x', 'beta')], sources), 1, 'a result that only the second row carries is accepted');
    const failed = [];
    for (const bad of [card('call_x', 'invented'), card('call_z', 'gamma')]) {
      try { checkCardsVerbatim([bad], sources); failed.push(`${bad.key}: passed`); } catch (e) { /* expected */ }
    }
    eq(failed.join(', '), '', 'an invented result and an id no store row carries must both fail');
    // §8.2's tool keys, plus the one field this round adds — asserted here so the
    // addition is deliberate rather than a silent shape change.
    const real = (await apiChat({ pane_id: 'w1:dup', tail: 1, limit: 200 })).json.messages.find((m) => m.tool);
    const want = ['name', 'call_key', 'input', 'input_truncated', 'result', 'result_truncated', 'is_error', 'pending', 'pending_reason'].sort();
    eq(Object.keys(real.tool).sort().join(','), want.join(','), 'tool keys');
    return { detail: 'duplicate-tolerant, invention-proof, and the tool key set is the 8 + pending_reason' };
  });

  // ── caps ───────────────────────────────────────────────────────────────────
  await check('caps: per-message text/input/result clamps at 20,000 characters, with *_truncated', async () => {
    const { json } = await apiChat({ pane_id: 'w1:caps', limit: 4 });
    const user = json.messages.find((m) => m.kind === 'text');
    eq(user.text.length, 20000, 'text length');
    eq(user.text_truncated, true, 'text_truncated');
    eq('L'.repeat(25000).includes(user.text), true, 'the clamped text must be a prefix of the source');
    const call = json.messages.find((m) => m.kind === 'tool_call');
    eq(call.tool.input_truncated, true, 'input_truncated');
    eq(call.tool.input.length, 20000, 'input length');
    eq(call.tool.result_truncated, true, 'result_truncated');
    eq(call.tool.result.length, 20000, 'result length');
    eq(json.messages.filter((m) => m.kind === 'tool_result').length, 0, 'the paired result is not a second message');
    must('R'.repeat(30000).includes(call.tool.result), 'the clamped result must be a prefix of the source');
    return true;
  });

  await check('caps: the response byte cap sets truncated and stops mid-listing', async () => {
    const { json } = await apiChat({ pane_id: 'w1:caps', limit: 2000 });
    eq(json.truncated, true, 'truncated');
    const total = json.messages.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m), 'utf8'), 0);
    const { LIMITS } = require(path.join(REPO_ROOT, 'src', 'chat', 'common.js'));
    must(total <= LIMITS.RESPONSE_BYTES_MAX, `reply carries ${total} bytes, cap is ${LIMITS.RESPONSE_BYTES_MAX}`);
    must(json.messages.length > 1 && json.messages.length < 104, `expected the byte cap to cut the listing, got ${json.messages.length} messages`);
    must(json.cursor < sizeOf(FILES.caps), 'the cursor must leave the rest for the next call');
    const rest = await apiChat({ pane_id: 'w1:caps', since: json.cursor, limit: 2000 });
    must(rest.json.messages.length > 0, 'the rest of the session must still be reachable');
    return { detail: `${json.messages.length} messages / ${total} bytes, ${rest.json.messages.length} more after the cursor` };
  });

  await check('limit: cuts the reply, advances the cursor, and loses nothing', async () => {
    const seen = [];
    let cursor = 0;
    for (let i = 0; i < 40; i++) {
      const { json } = await apiChat({ pane_id: 'w1:caps', since: cursor, limit: 7 });
      for (const m of json.messages) seen.push(m.key);
      if (json.cursor === cursor) break;
      cursor = json.cursor;
    }
    const uniq = new Set(seen);
    eq(uniq.size, seen.length, 'a paged walk must never repeat a message');
    // Every record of the fixture is reachable, in one order, whatever the page
    // size: one record of 103 is merged into call_L's card (its result), so 102
    // messages. Compare against the same walk done in one big page, not a constant.
    const whole = await forwardAllKeys('w1:caps');
    eq(seen.join(','), whole.join(','), 'a walk at limit=7 must reach exactly what a walk at limit=2000 reaches');
    eq(seen.length, countLines(FILES.caps) - 1, '103 records, one of them merged into its call card');
    return { detail: `${seen.length} messages paged at limit=7, no repeats, identical to the limit=2000 walk` };
  });

  // ── recorded decisions ─────────────────────────────────────────────────────
  await check('counting: a multi-unit record is documented, not hidden (limit is messages, not records)', async () => {
    const { json } = await apiChat({ pane_id: 'w1:multi' });
    const lines = countLines(FILES.multi);
    eq(lines, 1, 'one record in the file');
    eq(json.messages.length, 2, 'one record with two text blocks yields two messages');
    eq(json.records_with_messages, 1, 'but it is ONE record that produced messages');
    mustCountingIdentity(json, lines, 'multi');
    return { detail: '1 record → 2 messages; the identity is stated per record (records_with_messages), so it stays exact' };
  });

  await check('error: a session whose records claim another project is refused (session_cwd_mismatch)', async () => {
    const { json } = await apiChat({ pane_id: 'w1:mismatch' });
    eq(json.ok, false, 'ok');
    eq(json.error.code, 'session_cwd_mismatch', 'code');
    must(json.error.message.includes(CWD_OTHER), 'the message must name the cwd the session belongs to');
    must(!json.messages, 'no messages may be served for a foreign session');
    return true;
  });

  await check('error: a pane with an agent this server cannot read is unsupported_agent', async () => {
    const codex = await apiChat({ pane_id: 'w1:codex' });
    eq(codex.json.ok, false, 'ok');
    eq(codex.json.error.code, 'unsupported_agent', 'codex pane');
    const noAgent = await apiChat({ pane_id: 'w1:noagent' });
    eq(noAgent.json.ok, false, 'ok');
    eq(noAgent.json.error.code, 'unsupported_agent', 'pane with no agent');
    return true;
  });

  await check('error: an unknown pane is pane_not_found, and pane_id is required', async () => {
    const unknown = await apiChat({ pane_id: 'w9:nosuchpane' });
    eq(unknown.json.ok, false, 'ok');
    eq(unknown.json.error.code, 'pane_not_found', 'code');
    const none = await apiChat({});
    eq(none.json.ok, false, 'ok');
    eq(none.json.error.code, 'bad_request', 'code without pane_id');
    return true;
  });

  await check('error: a claude session with no log file is session_file_missing', async () => {
    const { json } = await apiChat({ pane_id: 'w1:missing' });
    eq(json.ok, false, 'ok');
    eq(json.error.code, 'session_file_missing', 'code');
    must(json.error.message.includes(SESS_MISSING), 'the message must name the session id');
    return true;
  });

  await check('error: a missing hermes database is session_db_missing', async () => {
    const { json } = await apiChat({ pane_id: 'w1:nodb' }, { base: BASE_NO_DB });
    eq(json.ok, false, 'ok');
    eq(json.error.code, 'session_db_missing', 'code');
    must(json.error.message.includes('state.db'), 'the message must name the database path');
    return true;
  });

  await check('empty: a session with no records is a SUCCESS with no_messages_yet', async () => {
    const claudeEmpty = await apiChat({ pane_id: 'w1:empty' });
    eq(claudeEmpty.json.ok, true, 'ok (an empty session is not an error)');
    eq(claudeEmpty.json.messages.length, 0, 'messages');
    eq(claudeEmpty.json.no_messages_yet, true, 'no_messages_yet');
    eq(claudeEmpty.json.cursor, 0, 'cursor');
    const hermesEmpty = await apiChat({ pane_id: 'w1:hermes-empty' });
    eq(hermesEmpty.json.ok, true, 'ok');
    eq(hermesEmpty.json.messages.length, 0, 'messages');
    eq(hermesEmpty.json.no_messages_yet, true, 'no_messages_yet');
    // and it must NOT be claimed once the session has content
    const basic = await apiChat({ pane_id: 'w1:basic' });
    eq(basic.json.no_messages_yet, false, 'a session with records must not say no_messages_yet');
    return true;
  });

  // ── hermes ─────────────────────────────────────────────────────────────────
  await check('hermes: the row mapping (text, thinking, tool cards, results) and its keys', async () => {
    const { json } = await apiChat({ pane_id: 'w1:hermes' });
    mustChatKeys(json, 'hermes');
    eq(json.agent, 'hermes', 'agent');
    eq(json.source.kind, 'hermes_sqlite', 'source.kind');
    eq(json.source.session_id, HERMES_SESSION, 'source.session_id');
    eq(path.resolve(json.source.path), path.resolve(DB_FILE), 'source.path');
    for (const m of json.messages) mustMessageKeys(m, m.key);
    const want = 'text,text,thinking,thinking,tool_call,tool_call,tool_call,tool_result';
    const kinds = json.messages.map((m) => m.kind).join(',');
    eq(kinds, want, 'the rows\' kinds in row order (row 4\'s output rides in c1\'s card; row 8 has no card)');
    const user = json.messages[0];
    eq(user.role, 'user', 'row 1 role');
    eq(user.text, 'first prompt', 'row 1 text');
    eq(user.ts, Math.round(1790160000.5 * 1000), 'row 1 ts is unix seconds → ms');
    return true;
  });

  await check('hermes: reasoning becomes ONE thinking message (reasoning === reasoning_content)', async () => {
    const { json } = await apiChat({ pane_id: 'w1:hermes' });
    const think = json.messages.filter((m) => m.kind === 'thinking' && m.text === 'thinking text');
    eq(think.length, 1, 'row 2 must yield one thinking message, not two');
    return true;
  });

  await check('hermes: tool_calls become cards and pair with their tool row', async () => {
    const { json } = await apiChat({ pane_id: 'w1:hermes' });
    const c1 = json.messages.find((m) => m.tool && m.tool.call_key === 'c1');
    eq(c1.tool.name, 'terminal', 'call name');
    eq(c1.tool.input, '{"command":"ls"}', 'call input is the arguments text');
    eq(c1.tool.input_truncated, false, 'input_truncated');
    eq(c1.tool.pending, false, 'c1 is paired with row 4');
    eq(c1.tool.result, '{"output":"a\\nb"}', 'c1 result');
    eq(c1.tool.is_error, false, 'hermes records no error flag: is_error stays false');
    const pending = json.messages.filter((m) => m.kind === 'tool_call' && m.tool.pending);
    eq(pending.length, 2, 'c2 and c3 have no result row: pending');
    must(pending.every((m) => m.tool.result === null), 'a pending call carries no result');
    return true;
  });

  await check('hermes: every row is counted (rows == records_with_messages + merged + skipped + unknown)', async () => {
    const { json } = await apiChat({ pane_id: 'w1:hermes' });
    const rows = hermesRows().length;
    eq(rows, 8, 'fixture rows');
    eq(json.skipped, 1, 'the row with nothing renderable');
    // DEFECT-10 accounting: three rows carry a content field that was written and
    // is empty (rows 3, 5 and 7) — none of them becomes a blank row, all three are
    // counted. Only row 7 was blank ALONE, which is why skipped is still 1.
    eq(json.empty_records, 3, 'the three rows whose content was written but blank');
    eq(json.unknown_records, 1, 'the row with an unrecognised role');
    eq(json.merged_records, 1, 'the tool row merged into c1\'s card');
    eq(json.records_with_messages, 5, 'rows that produced at least one message');
    eq(json.messages.length, 8, 'messages (three rows yield more than one unit: content+thinking, thinking+2 calls)');
    mustCountingIdentity(json, rows, 'hermes fixture');
    return { detail: `${rows} rows = 5 with messages + 1 merged + 1 skipped + 1 unknown; ${json.messages.length} messages in total` };
  });

  await check('hermes: the cursor is the last row id, strictly greater next time', async () => {
    const first = await apiChat({ pane_id: 'w1:hermes', limit: 3 });
    eq(first.json.messages.length, 3, 'messages');
    eq(first.json.truncated, true, 'truncated');
    must(Number.isInteger(first.json.cursor) && first.json.cursor > 0, 'the cursor must be a row id');
    const ids = first.json.messages.map((m) => Number(String(m.key).split(':')[0]));
    eq(Math.max(...ids), first.json.cursor, 'the cursor must be the last reported row id');
    const next = await apiChat({ pane_id: 'w1:hermes', since: first.json.cursor });
    const nextIds = next.json.messages.map((m) => Number(String(m.key).split(':')[0]));
    must(nextIds.every((id) => id > first.json.cursor), 'the next window must be strictly greater rows');
    const same = await request('GET', `${BASE}/api/chat?pane_id=w1:hermes&since=${next.json.cursor}`);
    eq(same.json.messages.length, 0, 'a consumed cursor yields nothing');
    eq(same.json.cursor, next.json.cursor, 'and does not move');
    const twiceA = await request('GET', `${BASE}/api/chat?pane_id=w1:hermes&since=3`);
    const twiceB = await request('GET', `${BASE}/api/chat?pane_id=w1:hermes&since=3`);
    eq(twiceA.text, twiceB.text, 'two replies at the same cursor must be byte-identical');
    return true;
  });

  await check('hermes: reading is READ-ONLY by construction (mode=ro, and a write throws)', async () => {
    const hermes = require(path.join(REPO_ROOT, 'src', 'chat', 'hermes.js'));
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'chat', 'hermes.js'), 'utf8');
    must(/mode=ro/.test(src), 'src/chat/hermes.js must build a mode=ro URI');
    must(/readOnly:\s*true/.test(src), 'src/chat/hermes.js must pass readOnly: true');
    must(hermes.readOnlyUri('D:\\x\\state.db').endsWith('?mode=ro'), 'readOnlyUri must end in ?mode=ro');
    const db = hermes.openReadOnly(DB_FILE);
    let threw = null;
    try { db.exec('CREATE TABLE should_not_exist (x)'); } catch (e) { threw = e; }
    finally { try { db.close(); } catch (e) { /* gone */ } }
    must(threw, 'a write on the read-only connection must throw');
    must(/readonly/i.test(threw.message), `expected a read-only error, got: ${threw.message}`);
    const check2 = new DatabaseSync(DB_FILE);
    // The refused CREATE TABLE must have left nothing behind. (sqlite_sequence
    // is there from the fixture's own AUTOINCREMENT, not from the attempt.)
    const tables = check2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    check2.close();
    must(tables.includes('messages'), 'the fixture database must still hold the messages table');
    must(!tables.includes('should_not_exist'), `the refused write created a table: ${tables.join(',')}`);
    return { detail: threw.message };
  });

  // ── §9 (round 7.6 / DEFECT-17): the pane's LIVE session ────────────────────
  // The fixtures drive the real server against a mock herdr whose pane text is
  // the measured text of real panes (fixturePaneTexts), so these checks exercise
  // the whole path §9 names: pane read → resolver → reply fields → heal.

  const msgTexts = (j) => j.messages.map((m) => m.text);
  const candFor = (j, id) => (j.session_candidates || []).find((c) => c.id === id) || null;

  await check('session: the hermes banner decides the live session (plain, ANSI, /status)', async () => {
    // 1. The measured w4:p7 banner, herdr still on the stale id.
    const plain = await apiChat({ pane_id: 'w1:banner' });
    mustChatKeys(plain.json, 'banner');
    eq(plain.json.ok, true, 'ok');
    eq(plain.json.session_id, H_NEW, 'the banner id, not herdr\'s stale one');
    eq(plain.json.session_detected_by, 'pane_banner', 'detected_by');
    eq(plain.json.resolved, true, 'resolved');
    eq(plain.json.resolved_reason, null, 'resolved_reason');
    eq(plain.json.session_change, null, 'the first report of a binding is not a change');
    // The served source follows the RESOLUTION, not herdr's record.
    eq(plain.json.source.session_id, H_NEW, 'source.session_id is the resolved session');
    eq(plain.json.source.kind, 'hermes_sqlite', 'source.kind');
    // The content is the NEW session's, so the switch is real and not just a header.
    must(msgTexts(plain.json).includes('the session the banner names'), 'the reply must carry the banner session\'s rows');
    must(!msgTexts(plain.json).includes('the session the stale banner names'), 'the stale session\'s rows must not be served');
    const cand = candFor(plain.json, H_NEW);
    must(cand && cand.source === 'pane_banner', 'the id must be a pane_banner candidate');
    must(String(cand.detail).includes('visible') && String(cand.detail).includes('recent_unwrapped'),
      `both reads named this id — detail was ${JSON.stringify(cand && cand.detail)}`);
    // herdr HAS a value for this pane, and its record is write-once (measured), so
    // the honest answer is: this view is corrected, herdr's record is not.
    eq(plain.json.herdr_healed, false, 'herdr_healed must not claim a record herdr never published');
    must(String(plain.json.heal_reason).includes('write-once'), `heal_reason must say why: ${JSON.stringify(plain.json.heal_reason)}`);

    // 2. The same banner as a real terminal read carries it, SGR sequences and all.
    const ansi = await apiChat({ pane_id: 'w1:banner-ansi' });
    eq(ansi.json.session_id, H_NEW_ANSI, 'the ANSI read must parse to the same field');
    eq(ansi.json.session_detected_by, 'pane_banner', 'detected_by');
    // This id has no row anywhere in the store — measured on the live pane after
    // /clear — so the reply must say the session is brand new, not invent content.
    must(String(ansi.json.session_note).includes('no row'), `the note must disclose the brand-new session: ${JSON.stringify(ansi.json.session_note)}`);
    eq(ansi.json.messages.length, 0, 'a session with no rows is empty');
    eq(ansi.json.no_messages_yet, true, 'no_messages_yet');

    // 3. The `/status` block: the same id, in the read the banner is NOT in.
    const status = await apiChat({ pane_id: 'w1:banner-status' });
    eq(status.json.session_id, H_NEW_STATUS, 'the /status Session ID field must parse');
    eq(status.json.session_detected_by, 'pane_banner', 'detected_by');
    const sc = candFor(status.json, H_NEW_STATUS);
    must(sc && String(sc.detail).includes('recent_unwrapped'), 'this one is only in the scrollback read');
    must(msgTexts(status.json).includes('the session /status reports'), 'the /status session\'s rows are served');
    return { detail: 'plain → ' + H_NEW + ', ANSI → ' + H_NEW_ANSI + ', /status → ' + H_NEW_STATUS };
  });

  await check('session: a pane whose Session: field is not an id resolves to NOTHING (never a guess)', async () => {
    const { json } = await apiChat({ pane_id: 'w1:banner-garbage' });
    eq(json.ok, false, 'ok');
    eq(json.session_id, null, 'no session may be served');
    eq(json.resolved, false, 'resolved');
    eq(json.resolved_reason, 'no_signal', 'resolved_reason');
    eq(json.error.code, 'session_ambiguous', 'code: the pane cannot be bound, and it says so');
    const ids = (json.session_candidates || []).map((c) => c.id);
    // The candidates carry the token the pane ACTUALLY wrote — a template
    // placeholder and a translated string — so the reader sees what was refused.
    must(ids.includes('<id>') && ids.includes('not-a-session'), `the raw tokens must be disclosed as candidates, got ${JSON.stringify(ids)}`);
    must((json.session_candidates || []).filter((c) => c.detail === 'not a session id').length === 2, 'both are disclosed as not session ids');
    must(json.error.message.includes('<id>'), 'the message must quote what the pane actually said');
    must(!ids.some((i) => /^\d{8}_\d{6}_[0-9a-f]{6}$/.test(i)), 'no token may be dressed up as a session id');
    return { detail: 'candidates: ' + JSON.stringify(ids) + ' — none of them bindable' };
  });

  await check('session: an older banner never drags the binding back (herdr is kept)', async () => {
    const { json } = await apiChat({ pane_id: 'w1:banner-old' });
    eq(json.session_id, H_ANCHOR, 'herdr\'s session, not the defunct one the scrollback names');
    eq(json.session_detected_by, 'herdr', 'detected_by');
    must(String(json.session_note).includes('older than herdr'), `the refusal must be explained: ${JSON.stringify(json.session_note)}`);
    must(msgTexts(json).includes('the session herdr is anchored to'), 'the anchored session\'s rows are served');
    must(!msgTexts(json).includes('the session the stale banner names'), 'the stale session\'s rows are not');
    eq(json.herdr_healed, true, 'herdr already records it: nothing to report');
    eq(json.heal_reason, 'herdr already records this session', 'heal_reason');
    const reports = mockPipe.reports().filter((c) => c.params.pane_id === 'w1:banner-old');
    eq(reports.length, 0, 'no report may be sent for a session herdr already publishes');
    return true;
  });

  await check('session: two banners on one screen are disclosed, and herdr is kept (§9.5)', async () => {
    const { json } = await apiChat({ pane_id: 'w1:banner-amb' });
    eq(json.ok, true, 'ok');
    eq(json.session_id, H_AMB, 'no switch: the pane named two sessions');
    eq(json.session_detected_by, 'herdr', 'detected_by');
    must(String(json.session_note).includes(H_HOLD) && String(json.session_note).includes(H_NEW),
      `both named sessions must be disclosed: ${JSON.stringify(json.session_note)}`);
    eq(candFor(json, H_HOLD) && candFor(json, H_HOLD).source, 'pane_banner', 'candidate 1 source');
    eq(candFor(json, H_NEW) && candFor(json, H_NEW).source, 'pane_banner', 'candidate 2 source');
    eq(json.session_change, null, 'a refusal to switch is not a change');
    return true;
  });

  await check('session: a pane herdr records NOTHING for resolves from its banner and heals herdr', async () => {
    const { json } = await apiChat({ pane_id: 'w1:banner-new' });
    eq(json.session_id, H_NEW_FRESH, 'the banner id');
    eq(json.session_detected_by, 'pane_banner', 'detected_by');
    eq(json.herdr_healed, true, 'herdr had no record: the report lands');
    must(String(json.heal_reason).includes('now publishes'), `heal_reason must be the verified claim: ${JSON.stringify(json.heal_reason)}`);
    const entry = mockPipe.agents.find((a) => a.pane_id === 'w1:banner-new');
    eq(entry.agent_session.value, H_NEW_FRESH, 'herdr\'s own record must now carry the resolved id');
    const reports = mockPipe.reports().filter((c) => c.params.pane_id === 'w1:banner-new');
    eq(reports.length, 1, 'exactly one report for this (pane, session)');
    eq(reports[0].params.agent_session_id, H_NEW_FRESH, 'the reported id');
    eq(reports[0].params.agent, 'hermes', 'the reported agent');
    eq(reports[0].params.source, 'herdr:hermes', 'the source herdr itself uses for this agent');
    // Re-poll: with herdr now publishing the id, the very same reply must say so —
    // and must not announce the binding again.
    const again = await apiChat({ pane_id: 'w1:banner-new' });
    eq(again.json.session_id, H_NEW_FRESH, 'still the same session');
    eq(again.json.session_change, null, 'nothing changed');
    eq(again.json.heal_reason, 'herdr already records this session', 'and now there is nothing left to heal');
    return { detail: 'reported ' + H_NEW_FRESH + ' to herdr as herdr:hermes, then herdr published it' };
  });

  await check('session: the hermes store\'s newest session for the cwd is the next signal', async () => {
    const { json } = await apiChat({ pane_id: 'w1:store' });
    eq(json.session_id, H_STORE, 'the store\'s newest row for this cwd');
    eq(json.session_detected_by, 'store_session', 'detected_by');
    eq(json.resolved, true, 'resolved');
    must(msgTexts(json).includes('the store knows this session'), 'the store session\'s rows are served');
    // The pane's text names nothing at all: this is the signal that only the store
    // can answer, and §9.1 keeps it below the pane's own banner.
    eq(json.session_note, null, 'a corroborated store session needs no note');
    eq(json.herdr_healed, false, 'herdr already had a (stale) value: write-once again');
    return true;
  });

  await check('session_change: reported EXACTLY once, with {from,to,detected_by,at}, then null', async () => {
    const before = await apiChat({ pane_id: 'w1:morph' });
    eq(before.json.session_id, H_MORPH_OLD, 'the session the pane and herdr agree on');
    eq(before.json.session_detected_by, 'herdr', 'agreement is herdr\'s to report');
    eq(before.json.session_change, null, 'the first sight is not a change');
    eq(before.json.herdr_healed, true, 'herdr already records it');
    must(msgTexts(before.json).includes('the conversation the pane started with'), 'the old session\'s rows are served');

    // /clear: the pane starts a new session and writes a new banner (the mock's
    // text is the pane's own read, mutated the way the act mutates it).
    const texts = mockPipe.paneText.get('w1:morph');
    mockPipe.setText('w1:morph', {
      visible: '            │\n'
        + `│  Session: ${H_MORPH_NEW}  research: arxiv, +2 more\n`
        + '            │\n'
        + '  ✨ (◕‿◕)✨ Fresh start! Screen cleared and conversation reset.\n'
        + ' ☤ deepseek-flash │ ctx -- │ [░░░░░░░░░░] -- │ 0m │ ⏲ 0s\n❯ ',
      recent: texts.recent,
    });
    const after = await apiChat({ pane_id: 'w1:morph' });
    eq(after.json.session_id, H_MORPH_NEW, 'the new session');
    eq(after.json.session_detected_by, 'pane_banner', 'detected_by');
    const change = after.json.session_change;
    must(change && typeof change === 'object', 'session_change must be reported');
    eq(Object.keys(change).sort().join(','), 'at,detected_by,from,to', 'session_change keys');
    eq(change.from, H_MORPH_OLD, 'from');
    eq(change.to, H_MORPH_NEW, 'to');
    eq(change.detected_by, 'pane_banner', 'detected_by');
    must(Number.isFinite(change.at) && Math.abs(Date.now() - change.at) < 60000, 'at must be a recent epoch ms');
    must(msgTexts(after.json).includes('the fresh session after /clear'), 'the NEW session\'s rows are served');
    must(!msgTexts(after.json).includes('the conversation the pane started with'), 'and not the old session\'s');

    // The same state again: the change is not re-announced.
    const repeat = await apiChat({ pane_id: 'w1:morph' });
    eq(repeat.json.session_id, H_MORPH_NEW, 'still the new session');
    eq(repeat.json.session_change, null, 'a change is announced once, not on every poll');
    return { detail: `${H_MORPH_OLD} → ${H_MORPH_NEW}, announced once` };
  });

  await check('stale: a moving pane over a frozen session is flagged; an idle pane is not', async () => {
    const first = await apiChat({ pane_id: 'w1:stale' });
    eq(first.json.session_id, HERMES_SESSION, 'the bound session');
    eq(first.json.stale, false, 'the first sight of a pane is not stale');
    // The agent writes a turn while the BOUND session gains no rows at all (its
    // cursor cannot move: the mock database is not being written). A real turn
    // adds hundreds of characters — §9.4's floor is 200, and the measured 194
    // characters of a three-line draft stayed BELOW it — so this text is one.
    const busyText = (m, s) => ` ☤ deepseek-flash │ ctx -- │ [░░░░░░░░░░] -- │ ${m}m │ ⏲ ${s}s\n`
      + '✦ Reading src/server.js\n✦ Editing src/chat/session.js\n'
      + '✦ The agent is clearly working on something that takes a while to produce\n'
      + '✦ It has now written four lines of commentary about the resolver, which is\n'
      + '  the kind of output a real turn produces and a ticking timer is not\n'
      + '❯ please refactor the resolver so the pane is asked first, then herdr\n';
    // What counts as movement is the SET of FOLDED lines the previous read did not
    // carry — and foldPaneLine folds digits to `#`. So the ticking timers in the
    // chrome line (and re-painting the same draft) contribute NOTHING, and each
    // attempt has to paint a line that is new this attempt AND, on its own, over
    // §9.4's 200-character floor. `n` becomes a LETTER for the same reason.
    const novelLine = (n) => {
      const tag = String.fromCharCode(97 + (n % 26));
      return `✦ pass ${tag}: `
        + 'the agent is rewriting the resolver so the pane is asked first, then herdr '.repeat(4)
        + '\n';
    };
    must(novelLine(1).trim().length >= 240,
      `fixture: one painted line must clear §9.4's 200-character floor on its own, got ${novelLine(1).trim().length}`);
    // The tracker decides from what it has SEEN inside its window (CHAT_STALE_MS,
    // 300 ms in this run), and a poll is what makes it see — so this polls the
    // verdict with a bounded retry, each attempt painting a fresh line. The verdict
    // itself waits on the window elapsing for BOTH ages (the pane's binding, and the
    // bound session's cursor having not moved), which is why a retry — not a longer
    // sleep — is what makes this decidable; `until` names the verdict, the movement
    // and the reason it actually saw when it gives up.
    let tick = 0;
    const busy = await until('a moving pane over a frozen session is flagged stale',
      async () => {
        tick++;
        mockPipe.setText('w1:stale', { visible: busyText(0, 0) + novelLine(tick), recent: '' });
        return apiChat({ pane_id: 'w1:stale' });
      },
      (r) => r.json.stale === true, { timeoutMs: 8000 });
    const moved = busy.last;
    eq(moved.json.session_id, HERMES_SESSION, 'the session did not change');
    eq(moved.json.stale, true, 'a pane whose text moves over a session that gains nothing is stale');
    const reason = String(moved.json.stale_reason);
    must(reason.includes(HERMES_SESSION) && / characters /.test(reason),
      `stale_reason must name the session and the movement: ${JSON.stringify(moved.json.stale_reason)}`);
    // The verdict's own number, read back out of the reason: the movement it rested
    // on must be the novel text, not the folded-away timer digits.
    const gained = Number((reason.match(/(\d+) characters/) || [])[1]);
    must(Number.isFinite(gained) && gained >= 200,
      `the movement the verdict rests on must clear §9.4's 200-character floor: ${JSON.stringify(reason)}`);
    eq(moved.json.session_change, null, 'staleness is not a session change');
    // Idle again: the text STOPS — every attempt paints the SAME screen, differing
    // only in the timer digits, which fold away. One last movement entry is recorded
    // by the transition, then it falls out of the window and the verdict clears.
    const idleText = busyText(0, 0) + novelLine(1);
    const idle = await until('an idle pane over the same session is NOT stale',
      async () => { mockPipe.setText('w1:stale', { visible: idleText, recent: '' }); return apiChat({ pane_id: 'w1:stale' }); },
      (r) => r.json.stale === false && r.json.session_id === HERMES_SESSION, { timeoutMs: 8000 });
    eq(idle.last.json.stale, false, 'an idle pane over the same session is NOT stale');
    eq(idle.last.json.stale_reason, null, 'and carries no reason');
    return { detail: `${moved.json.stale_reason} (stale after ${busy.attempts} poll(s)/${busy.ms} ms; clear after ${idle.attempts}/${idle.ms} ms)` };
  });

  await check('session: claude — one log under the cwd is picked, two close ones are disclosed', async () => {
    // The five cwd-rule logs must be the newest in the root for the scan to verify
    // them (see stampNewest): this is the fixture stating its own precondition, and
    // the poll below reports the state it saw if that ever stops holding.
    stampNewest([CAND_ONE, CAND_AMB_A, CAND_AMB_B, CAND_BOUND, CAND_FRESH]);
    // One candidate: the dangling herdr record is replaced by the cwd's own log.
    const one = (await until('the cwd\'s only log is picked over a dangling herdr record',
      () => apiChat({ pane_id: 'w1:cwdone' }),
      (r) => r.json.ok === true && r.json.session_id === CAND_ONE)).last;
    eq(one.json.ok, true, 'ok');
    eq(one.json.session_id, CAND_ONE, 'the cwd\'s only log');
    eq(one.json.session_detected_by, 'cwd_newest', 'detected_by');
    eq(one.json.resolved, true, 'resolved');
    eq(candFor(one.json, CAND_ONE) && candFor(one.json, CAND_ONE).source, 'cwd_newest', 'candidate source');
    must(msgTexts(one.json).includes('the only session in this cwd'), 'the picked log\'s records are served');
    eq(one.json.herdr_healed, false, 'herdr records a dangling id: write-once, so the report cannot land');
    must(String(one.json.heal_reason).includes('write-once'), 'and the reason says so');

    // Two candidates milliseconds apart: ambiguity, NOT a coin flip.
    const amb = await apiChat({ pane_id: 'w1:cwdamb' });
    eq(amb.json.ok, false, 'ok');
    eq(amb.json.error.code, 'session_ambiguous', 'code');
    eq(amb.json.session_id, null, 'nothing may be served');
    eq(amb.json.resolved, false, 'resolved');
    eq(amb.json.resolved_reason, 'ambiguous_candidates', 'resolved_reason');
    const ids = (amb.json.session_candidates || []).map((c) => c.id).filter((id) => id === CAND_AMB_A || id === CAND_AMB_B);
    eq(ids.length, 2, 'both logs must be disclosed as candidates');
    eq(amb.json.error.message.includes(CAND_AMB_A) && amb.json.error.message.includes(CAND_AMB_B), true, 'the message names both');

    // herdr's own log IS the newest under the cwd: nothing to pick, nothing to report.
    const bound = await apiChat({ pane_id: 'w1:cwdbound' });
    eq(bound.json.session_id, CAND_BOUND, 'herdr\'s own session');
    eq(bound.json.session_detected_by, 'herdr', 'detected_by');
    eq(bound.json.herdr_healed, true, 'already recorded');
    eq(mockPipe.reports().filter((c) => c.params.pane_id === 'w1:cwdbound').length, 0, 'no report for a pane herdr is already right about');
    return { detail: `${CAND_ONE} picked; ${CAND_AMB_A}/${CAND_AMB_B} disclosed` };
  });

  await check('session: claude — a pane herdr records nothing for is picked from the cwd and healed', async () => {
    const { json } = await apiChat({ pane_id: 'w1:cwdnew' });
    eq(json.session_id, CAND_FRESH, 'the cwd\'s only log');
    eq(json.session_detected_by, 'cwd_newest', 'detected_by');
    eq(json.herdr_healed, true, 'herdr had no record for this pane: the report lands');
    const entry = mockPipe.agents.find((a) => a.pane_id === 'w1:cwdnew');
    eq(entry.agent_session.value, CAND_FRESH, 'herdr\'s own record now carries it');
    eq(entry.agent_session.source, 'herdr:claude', 'under herdr\'s own source for claude');
    // Nothing announced as a change: this pane was first SEEN in this session.
    eq(json.session_change, null, 'the first report of a binding is not a change');
    return { detail: CAND_FRESH + ' reported as herdr:claude' };
  });

  await check('session: claude — the cwd\'s own log is found even when CAND_MAX newer logs crowd it out', async () => {
    // The case the round-8 fix exists for, and the only check here that gates the
    // RANKING as such (the checks above only gate that some ranking finds a log that
    // was already inside the newest eight — see stampNewest, which exists for exactly
    // that reason). The pane's own log is on disk, fresh, and provably its cwd's, but
    // it is NOT among the globally newest CAND_MAX files: CROWD_SLUGS noise logs, one
    // per slug, are newer. So
    //   * a global "verify the newest eight" cut spends all eight slots on the noise
    //     and answers "this pane has no log at all", and
    //   * a per-slug-first cut also spends its eight slots, one per noise SLUG.
    // Only verifying further once the cut has proved nothing finds it, which is the
    // escalation under test. Measured against both earlier revisions: this check fails
    // there (session_file_missing / a null session) while the whole rest of the suite
    // passes.
    const built = buildCrowdFixture();
    try {
      // The check states its own precondition, from the filesystem, so a fixture
      // change cannot make it pass for the wrong reason: the pane's log must really be
      // outside the top CROWD_SLUGS, and those must really be the noise this built.
      const all = [];
      for (const d of fs.readdirSync(PROJECTS, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        for (const n of fs.readdirSync(path.join(PROJECTS, d.name))) {
          if (!n.endsWith('.jsonl')) continue;
          const p = path.join(PROJECTS, d.name, n);
          all.push({ name: n, dir: d.name, mtimeMs: fs.statSync(p).mtimeMs });
        }
      }
      all.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const top = all.slice(0, 8);
      must(!top.some((f) => f.name === CAND_CROWD + '.jsonl'),
        `the pane's own log must NOT be inside the newest 8, or this check is not evidence (newest: ${top.map((f) => f.dir + '/' + f.name).join(', ')})`);
      must(top.every((f) => f.dir.startsWith('proj-crowd-noise')), `the newest 8 must be this check's noise (got ${top.map((f) => f.dir).join(', ')})`);
      const own = all.find((f) => f.name === CAND_CROWD + '.jsonl');
      must(own && own.mtimeMs < top[top.length - 1].mtimeMs, 'the pane\'s own log must be strictly older than the cut');

      const r = (await until('the crowded cwd\'s own log is picked',
        () => apiChat({ pane_id: 'w1:cwdcrowd' }),
        (x) => x.json.ok === true && x.json.session_id === CAND_CROWD)).last;
      eq(r.json.ok, true, 'ok');
      eq(r.json.session_id, CAND_CROWD, 'the cwd\'s own log, found although eight newer logs of other cwds are ahead of it');
      eq(r.json.session_detected_by, 'cwd_newest', 'detected_by');
      eq(r.json.resolved, true, 'resolved');
      must(msgTexts(r.json).includes(built.text), 'the picked log\'s own records are served');
      return { detail: `${CROWD_SLUGS} newer logs in ${CROWD_SLUGS} other slugs; ${CAND_CROWD} older than all of them and still picked` };
    } finally {
      removeCrowdFixture();
    }
  });

  await check('session: a reader can pin a session from the candidates — and only from them (§9.5)', async () => {
    const bad = await apiChat({ pane_id: 'w1:banner-amb', session_id: '20260925_121200_999999' });
    eq(bad.json.ok, false, 'ok');
    eq(bad.json.error.code, 'bad_request', 'code for an id the pane never named');
    eq(bad.json.session_id, null, 'no session is bound');
    eq(bad.json.resolved_reason, 'pick_not_a_candidate', 'resolved_reason');
    must(bad.json.error.message.includes(H_HOLD) && bad.json.error.message.includes(H_NEW),
      'the refusal must list what COULD have been chosen');
    const good = await apiChat({ pane_id: 'w1:banner-amb', session_id: H_NEW });
    eq(good.json.session_id, H_NEW, 'the reader\'s pick wins over herdr');
    eq(good.json.session_detected_by, 'reader', 'detected_by');
    must(String(good.json.session_note).includes('reader'), `the note must say who decided: ${JSON.stringify(good.json.session_note)}`);
    const change = good.json.session_change;
    must(change && change.from === H_AMB && change.to === H_NEW && change.detected_by === 'reader',
      `a reader\'s switch is still a switch: ${JSON.stringify(change)}`);
    return { detail: 'refused an invented id, then bound ' + H_NEW + ' as the reader chose' };
  });

  // ── live (guarded) ─────────────────────────────────────────────────────────
  // A second server instance WITHOUT the mock pipe talks to the real herdr, so
  // the live checks exercise the real resolution path end to end. Which panes
  // exist is answered by herdr itself (src/hdr.js), not guessed at.
  let liveProc = null;
  let liveClaudePane = null;
  let liveHermesPane = null;
  try {
    liveProc = await startServer(PORT_LIVE, {}, 'live');
    const hdr = require(path.join(REPO_ROOT, 'src', 'hdr.js'));
    const result = await hdr.request('agent.list', {}, { timeoutMs: 10000 });
    const agents = (result && Array.isArray(result.agents)) ? result.agents : [];
    const claudeEntry = agents.find((a) => a && a.agent === 'claude' && a.agent_session && a.agent_session.value);
    const hermesEntry = agents.find((a) => a && a.agent === 'hermes' && a.agent_session && a.agent_session.value);
    liveClaudePane = claudeEntry ? claudeEntry.pane_id : null;
    liveHermesPane = hermesEntry ? hermesEntry.pane_id : null;
    notes.push(`live panes: ${agents.length} agent(s) — claude ${liveClaudePane || '(none)'}, hermes ${liveHermesPane || '(none)'}`);
  } catch (e) {
    notes.push(`live discovery failed (${(e && e.message) || e}) — the live checks are skipped`);
    liveProc = null;
  }

  await check('live: a real claude pane returns a conversation whose every text is in its record', async () => {
    if (!liveClaudePane) return { skip: true, reason: 'no live claude pane on this machine' };
    const { json } = await apiChat({ pane_id: liveClaudePane, limit: 300 }, { base: BASE_LIVE });
    if (!json.ok) return { skip: true, reason: `live claude pane answered ${json.ok === false ? json.error.code : 'no json'}` };
    must(json.messages.length > 0, `expected messages from the live claude session, got ${json.messages.length}`);
    eq(json.agent, 'claude', 'agent');
    // Independent re-read: parse the file ourselves and require every emitted
    // text to be a piece of the record it names.
    const byUuid = blocksByUuid(json.source.path);
    let checked = 0;
    for (const m of json.messages) {
      if (m.kind === 'system') continue;              // a record-level line, no block
      const [uuid, idx] = String(m.key).split(':');
      const r = byUuid.get(uuid);
      must(r, `${m.key}: the live file has no record ${uuid}`);
      const content = r.message && r.message.content;
      const blocks = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
      const b = blocks[Number(idx)];
      must(b, `${m.key}: the live record has no block ${idx}`);
      if (m.kind === 'text') {
        must(typeof b.text === 'string' && b.text.includes(m.text), `${m.key}: emitted text is not in the live record`);
      } else if (m.kind === 'thinking') {
        must(typeof b.thinking === 'string' && b.thinking.includes(m.text), `${m.key}: emitted thinking is not in the live record`);
      } else if (m.kind === 'tool_call') {
        must(b.type === 'tool_use', `${m.key}: block is ${b.type}, not tool_use`);
        must(JSON.stringify(b.input).includes(m.tool.input), `${m.key}: emitted input is not a piece of the live record`);
      } else if (m.kind === 'tool_result') {
        must(b.type === 'tool_result', `${m.key}: block is ${b.type}, not tool_result`);
        must(liveResultText(b).includes(m.tool.result), `${m.key}: emitted result is not a piece of the live record`);
      }
      checked++;
    }
    must(checked > 0, 'no message was checked');
    return { detail: `${json.messages.length} messages, all ${checked} verified against the live log` };
  });

  await check('live: a real hermes pane returns a conversation whose texts come from its rows', async () => {
    if (!liveHermesPane) return { skip: true, reason: 'no live hermes pane on this machine' };
    const { json } = await apiChat({ pane_id: liveHermesPane, limit: 300 }, { base: BASE_LIVE });
    if (!json.ok) return { skip: true, reason: `live hermes pane answered ${json.ok === false ? json.error.code : 'no json'}` };
    must(json.messages.length > 0, `expected messages from the live hermes session, got ${json.messages.length}`);
    eq(json.source.kind, 'hermes_sqlite', 'source.kind');
    const hermes = require(path.join(REPO_ROOT, 'src', 'chat', 'hermes.js'));
    const db = hermes.openReadOnly(json.source.path);
    const rows = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(json.source.session_id);
    db.close();
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    let checked = 0;
    for (const m of json.messages) {
      const [id, idx] = String(m.key).split(':');
      const r = byId.get(id);
      must(r, `${m.key}: the live database has no row ${id}`);
      const u = hermesUnits(r)[Number(idx)];
      must(u, `${m.key}: row ${id} yields no unit ${idx}`);
      eq(m.kind, u.kind, `${m.key}: kind`);
      if (u.kind === 'text' || u.kind === 'thinking') {
        must(u.text.includes(m.text), `${m.key}: emitted text is not a verbatim piece of the live row`);
      } else if (u.kind === 'tool_call') {
        must(m.tool && m.tool.name === u.name, `${m.key}: call name`);
        must(u.input == null || (m.tool.input && u.input.includes(m.tool.input)),
          `${m.key}: emitted input is not a piece of the live row`);
      } else if (u.kind === 'tool_result') {
        must(m.tool && m.tool.name === u.name, `${m.key}: result name`);
        must(u.text.includes(m.tool.result), `${m.key}: emitted result is not a verbatim piece of the live row`);
      }
      checked++;
    }
    must(checked > 0, 'no message was checked');
    return { detail: `${json.messages.length} messages over ${rows.length} rows, all ${checked} verified against their rows` };
  });

  await check('live: tail=1 lands on the live turn, and every merged result rides in its card', async () => {
    if (!liveClaudePane && !liveHermesPane) return { skip: true, reason: 'the live server is not available' };
    const detail = [];

    if (liveClaudePane) {
      const { json } = await apiChat({ pane_id: liveClaudePane, tail: 1, limit: 300 }, { base: BASE_LIVE });
      if (!json.ok) return { skip: true, reason: `live claude pane answered ${json.ok === false ? json.error.code : 'no json'}` };
      must(json.messages.length > 0, 'a tail of the live log must carry messages');
      const cards = json.messages.filter((m) => m.kind === 'tool_call');
      const withResult = cards.filter((m) => m.tool && m.tool.result != null);
      // claude cards are born with no result and only ever get one from a merge, so
      // these two numbers must agree. This is the check that catches a merge being
      // counted but not applied (a card left `pending` with its result dropped).
      eq(withResult.length, json.merged_records, 'every merged record must be a card carrying its result');
      must(withResult.every((m) => m.tool.pending === false), 'a card carrying a result is not pending');
      must(cards.filter((m) => m.tool.pending).every((m) => m.tool.result == null), 'a pending card carries no result');
      // Verbatim, re-read independently: the text inside each card is a piece of a
      // result record that declares its tool_use_id — "at least one", because the
      // log repeats ids (see checkCardsVerbatim).
      checkCardsVerbatim(json.messages, liveClaudeResults(json.source.path));
      const reasonTally = pendingReasonTally(json.messages, 'claude');
      // The cursor is the live end: polling forward from it may only produce NEW
      // messages, never one of these again.
      const fwd = await apiChat({ pane_id: liveClaudePane, since: json.cursor, limit: 300 }, { base: BASE_LIVE });
      const seen = new Set(json.messages.map((m) => m.key));
      eq(fwd.json.messages.filter((m) => seen.has(m.key)).length, 0, 'a forward poll from the tail cursor must not repeat a message');
      detail.push(`claude: ${json.messages.length} messages at cursor ${json.cursor} (${withResult.length} results inside their cards; ${tallyText(reasonTally)})`);
    }

    if (liveHermesPane) {
      const { json } = await apiChat({ pane_id: liveHermesPane, tail: 1, limit: 300 }, { base: BASE_LIVE });
      if (!json.ok) return { skip: true, reason: `live hermes pane answered ${json.ok === false ? json.error.code : 'no json'}` };
      must(json.messages.length > 0, 'a tail of the live session must carry messages');
      const cards = json.messages.filter((m) => m.kind === 'tool_call');
      const withResult = cards.filter((m) => m.tool && m.tool.result != null);
      must(withResult.length <= json.merged_records, 'more cards carry a result than merged records — a result appeared from nowhere');
      must(json.merged_records === 0 || withResult.length > 0, `${json.merged_records} merged records but no card carries a result`);
      must(withResult.every((m) => m.tool.pending === false), 'a card carrying a result is not pending');
      const hermes = require(path.join(REPO_ROOT, 'src', 'chat', 'hermes.js'));
      const db = hermes.openReadOnly(json.source.path);
      // ORDER BY id, and one entry per row: an id this store declares twice has two
      // rows, and the card may carry either one's text (round 7.3 — the unordered
      // single-value map compared cards against rows the reader never used).
      const rows = db.prepare("SELECT tool_call_id, content FROM messages WHERE session_id = ? AND role = 'tool' ORDER BY id").all(json.source.session_id);
      db.close();
      const byCall = new Map();
      for (const r of rows) {
        const k = String(r.tool_call_id);
        if (!byCall.has(k)) byCall.set(k, []);
        byCall.get(k).push(String(r.content == null ? '' : r.content));
      }
      checkCardsVerbatim(json.messages, byCall);
      const reasonTally = pendingReasonTally(json.messages, 'hermes');
      const fwd = await apiChat({ pane_id: liveHermesPane, since: json.cursor, limit: 300 }, { base: BASE_LIVE });
      const seen = new Set(json.messages.map((m) => m.key));
      eq(fwd.json.messages.filter((m) => seen.has(m.key)).length, 0, 'a forward poll from the tail cursor must not repeat a message');
      eq(json.cursor, json.cursor | 0, 'the hermes cursor is a row id');
      detail.push(`hermes: ${json.messages.length} messages at cursor ${json.cursor} (${withResult.length} results inside their cards over ${rows.length} tool rows; ${tallyText(reasonTally)})`);
    }
    return { detail: detail.join('; ') };
  });

  await check('live: three real requests leave the claude log and the state.db untouched', async () => {
    if (!liveProc || (!liveClaudePane && !liveHermesPane)) return { skip: true, reason: 'the live server is not available' };
    const claudeFile = liveClaudePane ? (await apiChat({ pane_id: liveClaudePane }, { base: BASE_LIVE })).json.source.path : null;
    const hermesFile = liveHermesPane ? (await apiChat({ pane_id: liveHermesPane }, { base: BASE_LIVE })).json.source.path : null;
    const snap = (p) => {
      const st = fs.statSync(p);
      return { size: st.size, mtime: st.mtimeMs };
    };
    const dbState = (p) => {
      const db = new DatabaseSync(p, { readOnly: true });
      const r = db.prepare('SELECT COUNT(*) AS n, MAX(id) AS m FROM messages').get();
      db.close();
      return { n: r.n, m: r.m, file: snap(p) };
    };
    const before = { claude: claudeFile ? snap(claudeFile) : null, hermes: hermesFile ? dbState(hermesFile) : null };
    for (let i = 0; i < 3; i++) {
      if (liveClaudePane) await apiChat({ pane_id: liveClaudePane, limit: 50 }, { base: BASE_LIVE });
      if (liveHermesPane) await apiChat({ pane_id: liveHermesPane, limit: 50 }, { base: BASE_LIVE });
    }
    const after = { claude: claudeFile ? snap(claudeFile) : null, hermes: hermesFile ? dbState(hermesFile) : null };
    if (before.claude && (before.claude.size !== after.claude.size || before.claude.mtime !== after.claude.mtime)) {
      // The live log belongs to a running agent: it may have appended to its own
      // file while we were reading. That is not our write, and it cannot be told
      // apart from one here — say so instead of claiming a pass or a failure.
      return {
        skip: true,
        reason: `the live claude log changed during the window (${before.claude.size} → ${after.claude.size} bytes) — its own agent was writing; the fixture check above covers the read-only claim`,
      };
    }
    if (before.hermes && (before.hermes.n !== after.hermes.n || before.hermes.m !== after.hermes.m ||
        before.hermes.file.size !== after.hermes.file.size || before.hermes.file.mtime !== after.hermes.file.mtime)) {
      return {
        skip: true,
        reason: `the live state.db changed during the window (${before.hermes.n} → ${after.hermes.n} rows) — hermes was writing; the fixture check above covers the read-only claim`,
      };
    }
    return {
      detail: `${liveClaudePane ? 'claude log' : ''}${liveClaudePane && liveHermesPane ? ' + ' : ''}${liveHermesPane ? `state.db (${after.hermes.n} rows, max id ${after.hermes.m})` : ''} unchanged across 3 requests`,
    };
  });

  await check('live: the live claude file the endpoint served really belongs to that pane (cwd, independently)', async () => {
    if (!liveClaudePane) return { skip: true, reason: 'no live claude pane' };
    const { json } = await apiChat({ pane_id: liveClaudePane, limit: 1 }, { base: BASE_LIVE });
    must(json.ok === true, `the live pane must answer ok, got ${JSON.stringify(json.error || json.ok)}`);
    // What the FILE says its project is, read here rather than taken on trust.
    let fileCwd = null;
    for (const line of fs.readFileSync(json.source.path, 'utf8').split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try { const r = JSON.parse(line); if (typeof r.cwd === 'string' && r.cwd) { fileCwd = r.cwd; break; } } catch (e) { /* partial */ }
    }
    must(fileCwd, 'the live session file must carry a cwd for this check to mean anything');
    // What HERDR says the pane's cwd is — the value §8.1 says to compare against.
    const hdr2 = require(path.join(REPO_ROOT, 'src', 'hdr.js'));
    const snap = await hdr2.request('session.snapshot', {}, { timeoutMs: 10000 });
    const s = (snap && (snap.snapshot || snap)) || {};
    const pane = (s.panes || []).find((p) => p && p.pane_id === liveClaudePane);
    must(pane, `herdr's snapshot has no pane ${liveClaudePane}`);
    const claude = require(path.join(REPO_ROOT, 'src', 'chat', 'claude.js'));
    must(claude.sameCwd(fileCwd, pane.cwd), `the served file claims ${fileCwd}, while herdr says ${liveClaudePane} is at ${pane.cwd}`);
    notes.push(`live ${liveClaudePane}: session ${json.source.session_id}, file cwd ${fileCwd} == herdr cwd`);
    return true;
  });

  // ── §9 end to end, against the REAL herdr (--e2e) ──────────────────────────
  // The fixture checks prove the resolver; only this one proves the whole path on
  // a real pane: hermes is started by herdr, `/clear` is typed into it, and the id
  // the PANE then announces is the id /api/chat serves. Opt-in (`--e2e`) because
  // it creates a workspace in the user's herdr — one it creates itself, in its own
  // workspace, which it closes before returning. It never reads or writes a pane
  // it did not create (w4:*/w6:* are the user's and stay untouched).
  await check('e2e: /clear in a throwaway hermes pane switches /api/chat to the new session', async () => {
    if (!E2E) return { skip: true, reason: 'pass --e2e to run the real-herdr throwaway-pane check' };
    if (!liveProc) return { skip: true, reason: 'the live server (real herdr) is not available' };
    const hdrE = require(path.join(REPO_ROOT, 'src', 'hdr.js'));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const paneTextOf = async (paneId) => {
      const r = await hdrE.request('pane.read',
        { pane_id: paneId, source: 'visible', lines: 80, format: 'text', strip_ansi: true }, { timeoutMs: 15000 });
      return (r && r.read && typeof r.read.text === 'string') ? r.read.text : '';
    };
    // §9.3's verified claim, checked here from the OUTSIDE: what herdr publishes
    // for this pane, read by this check rather than taken from the reply.
    const publishedSession = async (paneId) => {
      const r = await hdrE.request('agent.list', {}, { timeoutMs: 15000 });
      const a = ((r && r.agents) || []).find((x) => x && x.pane_id === paneId);
      return a && a.agent_session ? a.agent_session.value : null;
    };

    let workspaceId = null;
    let paneId = null;
    try {
      const created = await hdrE.request('workspace.create', { label: 'w1-7.6-e2e-throwaway', focus: false }, { timeoutMs: 20000 });
      // `workspace_created` carries {workspace: WorkspaceInfo, tab, root_pane}.
      workspaceId = (created.workspace && created.workspace.workspace_id) || created.workspace_id || null;
      paneId = (created.root_pane && created.root_pane.pane_id) || (created.pane && created.pane.pane_id) || null;
      must(paneId && workspaceId, `workspace.create must name its workspace and root pane: ${JSON.stringify(created).slice(0, 300)}`);
      const started = await hdrE.request('agent.start',
        { name: 'w1-e2e-hermes', kind: 'hermes', pane_id: paneId }, { timeoutMs: 30000 });
      must(!(started && started.error), `agent.start refused: ${JSON.stringify(started).slice(0, 200)}`);

      // 1. hermes prints its banner; the pane announces its first session.
      let before = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        await sleep(2000);
        const { json } = await apiChat({ pane_id: paneId, limit: 3 }, { base: BASE_LIVE });
        if (json && json.ok && json.session_id) { before = json; break; }
      }
      must(before, `no session was served for ${paneId} within 60 s; pane text: ${JSON.stringify((await paneTextOf(paneId)).slice(-300))}`);
      const textBefore = await paneTextOf(paneId);
      must(textBefore.includes(before.session_id), 'the served id must be in the pane\'s own text');
      const publishedBefore = await publishedSession(paneId);
      must(publishedBefore === before.session_id,
        `herdr must publish the id this reply serves (pane ${paneId}): herdr says ${publishedBefore}, the reply says ${before.session_id}`);
      eq(before.herdr_healed, true, 'herdr had no record for a brand-new pane: the report is verified in the reply');

      // 2. /clear. It asks for confirmation (measured), so answer the prompt —
      // polled for, not waited on: a prompt that paints at 6 s must still be
      // answered, and a fixed sleep here was a bet on when it paints (it loses
      // under load, and then the 90 s poll below fails with a pane dump).
      await hdrE.request('agent.prompt', { target: paneId, text: '/clear' }, { timeoutMs: 20000 }).catch(() => null);
      let answered = false;
      const tp = Date.now();
      while (Date.now() - tp < 20000) {
        if (/type 1\/2\/3|Approve Once|approve/i.test(await paneTextOf(paneId))) {
          await hdrE.request('agent.send_keys', { target: paneId, keys: ['1', 'Enter'] }, { timeoutMs: 20000 }).catch(() => null);
          answered = true;
          break;
        }
        await sleep(1000);
      }

      // 3. The pane's own banner moves to a NEW session — and so must the API.
      let after = null;
      const t1 = Date.now();
      while (Date.now() - t1 < 90000) {
        await sleep(2000);
        const { json } = await apiChat({ pane_id: paneId, limit: 3 }, { base: BASE_LIVE });
        if (json && json.ok && json.session_id && json.session_id !== before.session_id) { after = json; break; }
      }
      must(after, `the session did not change within 90 s of /clear${answered ? '' : ' (no confirmation prompt was ever seen in 20 s)'}; pane text: ${JSON.stringify((await paneTextOf(paneId)).slice(-300))}`);
      const textAfter = await paneTextOf(paneId);
      must(textAfter.includes(after.session_id), 'the NEW served id must be in the pane\'s own text');
      must(/^\d{8}_\d{6}_[0-9a-f]{6}$/.test(after.session_id), `the served id must be a hermes session id, got ${after.session_id}`);
      const change = after.session_change;
      must(change && typeof change === 'object', 'the switch must be announced as a session_change');
      eq(change.from, before.session_id, 'session_change.from');
      eq(change.to, after.session_id, 'session_change.to');
      eq(change.detected_by, after.session_detected_by, 'session_change.detected_by');
      eq(after.source.session_id, after.session_id, 'the served source is the new session');
      // §9.3's truthfulness rule, measured from outside the reply: `herdr_healed`
      // is exactly "herdr publishes the id this reply serves" — true when herdr
      // had no record (the fill above) and false when it already had the old one
      // (its session record is write-once per (pane, source)).
      const publishedAfter = await publishedSession(paneId);
      must(after.herdr_healed === (publishedAfter === after.session_id),
        `herdr_healed (${after.herdr_healed}) must equal "herdr publishes this session": herdr says ${publishedAfter}, the reply serves ${after.session_id}`);
      // and once, exactly once
      const repeat = await apiChat({ pane_id: paneId, limit: 3 }, { base: BASE_LIVE });
      eq(repeat.json.session_change, null, 'the change is announced once, not on every poll');
      eq(repeat.json.session_id, after.session_id, 'still the new session');

      notes.push(`e2e ${paneId}: ${before.session_id} → ${after.session_id} (detected_by ${after.session_detected_by}); `
        + `herdr had ${publishedBefore || 'nothing'} before the /clear (first report healed ${before.herdr_healed}: ${before.heal_reason}), `
        + `now publishes ${publishedAfter} (healed ${after.herdr_healed}: ${after.heal_reason})`);
      return {
        detail: `${paneId}: ${before.session_id} → ${after.session_id} by ${after.session_detected_by}; `
          + `herdr had ${publishedBefore}, now publishes ${publishedAfter}; herdr_healed=${after.herdr_healed}`,
      };
    } finally {
      // Give the pane back: close it, then the workspace it lives in.
      if (paneId) await hdrE.request('pane.close', { pane_id: paneId }, { timeoutMs: 15000 }).catch(() => null);
      if (workspaceId) await hdrE.request('workspace.close', { workspace_id: workspaceId }, { timeoutMs: 15000 }).catch(() => null);
      let gone = false;
      for (let i = 0; i < 10 && !gone; i++) {
        await sleep(1000);
        const r = await hdrE.request('agent.list', {}, { timeoutMs: 15000 }).catch(() => null);
        gone = !(((r && r.agents) || []).some((a) => a && a.pane_id === paneId));
      }
      notes.push(`e2e cleanup: created and closed ${workspaceId || '?'} (pane ${paneId || '?'}) — throwaway pane gone: ${gone}`);
    }
  });

  if (liveProc) killChild(liveProc.proc);

  // ── cleanup + the ports ────────────────────────────────────────────────────
  await mock.close();
  killAll();
  await new Promise((r) => setTimeout(r, 800));

  await check('cleanup: the test ports are free again', async () => {
    for (const p of [PORT, PORT_NO_DB, PORT_LIVE]) {
      must(!(await listening(p)), `port ${p} is still answering`);
    }
    return true;
  });

  // ── report ────────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.passed).length;
  console.log('');
  for (const n of notes) console.log(`NOTE ${n}`);
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  if (skippedLive) console.log(`SKIPPED (not counted): ${skippedLive} live check(s)`);
  if (pass !== results.length) {
    console.log('');
    for (const r of results) if (!r.passed) console.log(`  FAILED: ${r.name} — ${r.detail}`);
  }
  report(pass === results.length ? 0 : 1);
}

/**
 * Leave nothing behind.
 *
 * A harness that finishes its report and then stays alive holds a port other
 * workers' suites need — measured once already in this round (a stray
 * `src/server.js --port 7456` surviving a stopped run, which then made the next
 * run refuse to test a server it had not started). So: kill every child, close
 * every listener, drop the pooled HTTP sockets, and make exit unconditional.
 */
function report(code) {
  process.exitCode = code;
  killAll();
  if (mockPipe) { try { mockPipe.close(); } catch (e) { /* already gone */ } mockPipe = null; }
  try { http.globalAgent.destroy(); } catch (e) { /* nothing pooled */ }
  const t = setTimeout(() => process.exit(code), 400);
  t.unref();
}

main().catch((e) => {
  console.error(`harness failed: ${(e && e.message) || e}`);
  console.error(`completed before the failure: ${results.map((r) => `${r.passed ? 'P' : 'F'}:${r.name}`).join(' | ') || '(none)'}`);
  report(1);
});
