#!/usr/bin/env node
// herdr-dash round-8 harness — CONTRACT-v2 §12.3 (GET /api/status) — owner: W1.
//
// Zero dependencies beyond node itself: the fixture server is this repo's own
// src/server.js, started with the same env seams the other suites use
// (HERDR_SOCKET_PATH points at a mock herdr pipe, CLAUDE_PROJECTS_DIR at a
// fixture project tree).
//
// WHAT THIS PROVES, AND HOW
//
//   The fixtures are the contract's own. §12.3's verbatim lines (the two hermes
//   status lines, the two-process block, the two claude footers) are fed through
//   a real HTTP request to a real server and compared field by field with the
//   shape §12.3 freezes — including the two multipliers of the example JSON
//   (173K -> 177152 because K is 1024, 1M -> 1000000 because M is 10^6) and the
//   `~` that must survive as `approx:true`.
//
//   Nothing was written, and the pipe says so. The mock herdr records every
//   request with its params. The whole status phase is checked against an
//   allowlist of READ methods: `agent.list`, `session.snapshot`, `pane.read` —
//   and the write methods this endpoint must never reach (pane.prompt,
//   pane.send_keys, agent.prompt, pane.report_agent_session) are asserted absent
//   by name. The claude jsonl fixture's bytes and mtime are compared before and
//   after, so "read-only" is checked against the file system too.
//
//   One pane.read per call, of `visible`. Counted as a delta around each request,
//   with the source asserted on the recorded params — a second read (scrollback)
//   or a second call per request fails the suite.
//
//   The identification is cached, not scanned. Four status requests in a row cost
//   zero further `agent.list` calls (the 5 s cache §8.1 already keeps), and no
//   request ever asks herdr for a candidate scan: there is no §9 resolution call
//   on this path at all.
//
//   `herdr_ms` is a measurement, not a decoration. The mock holds one pane.read
//   for 300 ms; that reply's `herdr_ms` must be at least 250, and the same pane's
//   next reply (no hold) must be far below it.
//
// Usage:
//   node test/status.mjs [--port 7490]
//
//   The one instance this harness starts is killed before it exits and the port
//   is checked again.
//
// Exit code is 0 only when every check passed.

import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const statusModule = require('../src/status.js');   // the parsers, unit by unit

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
const PORT = Number(flagValue('--port', '7490'));
const BASE = `http://127.0.0.1:${PORT}`;
const SPAWN_WAIT_MS = 20000;

const SCRATCH = path.join(REPO_ROOT, '_scratch', 'w1', 'status');
const PROJECTS = path.join(SCRATCH, 'projects');
const CWD = path.join(SCRATCH, 'a-panes-cwd');
const NO_HERMES_DB = path.join(SCRATCH, 'no-hermes-state.db');

// ---------------------------------------------------------------- check runner

class Fail extends Error {}
const must = (cond, message) => { if (!cond) throw new Fail(message); };
const eq = (got, want, what) => {
  if (got !== want) throw new Fail(`${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};
const eqJson = (got, want, what) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Fail(`${what}: got ${a}, expected ${b}`);
};
const keysOf = (o) => Object.keys(o || {}).sort().join(',');

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

/** A JSON GET. Never throws: the failure IS the assertion. */
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

// ---------------------------------------------------------------- mock herdr pipe
/**
 * Records every request (method + params + arrival order), so the suite can prove
 * WHICH calls the endpoint made: the method allowlist, the one-read-per-call rule,
 * the source of that read, and the absence of every write. `delayMs` is mutable —
 * one check raises it to time a real round trip.
 */
function startMockPipe(spec) {
  return new Promise((resolve) => {
    const name = `herdr-dash-statustest-${process.pid}-${Date.now()}`;
    const sockets = new Set();
    const calls = [];
    const agents = spec.agents || [];
    const texts = spec.texts || new Map();
    const failReads = new Set(spec.failReads || []);
    const snapshot = {
      version: '0.0.0-mock', protocol: 22,
      focused_workspace_id: 'w8', focused_tab_id: 'w8:t1', focused_pane_id: agents.length ? agents[0].pane_id : 'w8:n1',
      workspaces: [], tabs: [], layouts: [],
      panes: spec.panes.map((p) => ({ pane_id: p, cwd: spec.cwd, workspace_id: 'w8', tab_id: 'w8:t1' })),
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
          calls.push({ method: msg.method, params, at: Date.now() });
          const reply = (result) => {
            if (sock.destroyed) return;
            sock.write(JSON.stringify({ id: msg.id, result }) + '\n');
            if (msg.method !== 'events.subscribe') sock.end();
          };
          if (msg.method === 'session.snapshot') reply({ snapshot });
          else if (msg.method === 'agent.list') reply({ agents, type: 'agent_list' });
          else if (msg.method === 'events.subscribe') reply({ type: 'subscription_started' });
          else if (msg.method === 'pane.list') reply({ panes: [] });
          else if (msg.method === 'pane.read' && failReads.has(params.pane_id)) {
            // §12.3 rule 5: "must not 500 when an agent prints nothing" — and a
            // pane.read that herdr refuses is the same shape of problem, so the
            // mock can refuse one too (herdr's own reply shape: {id, error:{code,message}}).
            if (sock.destroyed) return;
            sock.write(JSON.stringify({ id: msg.id, error: { code: 'pane_not_found', message: `no such pane: ${params.pane_id}` } }) + '\n');
            sock.end();
          }
          else if (msg.method === 'pane.read') {
            const t = texts.get(params.pane_id) || {};
            const text = params.source === 'visible' ? (t.visible || '') : (t.recent || '');
            const send = () => reply({
              type: 'pane_read',
              read: {
                pane_id: params.pane_id, workspace_id: 'w8', tab_id: 'w8:t1',
                source: params.source, format: 'text', text, revision: 1, truncated: false,
              },
            });
            if (mock.delayMs) setTimeout(send, mock.delayMs);
            else send();
          } else reply({ type: 'ok' });
        }
      });
    });
    const mock = {
      name, calls, agents, texts,
      delayMs: 0,
      reads: (from = 0) => calls.slice(from).filter((c) => c.method === 'pane.read').length,
      methods: (from = 0) => calls.slice(from).map((c) => c.method),
      close: () => new Promise((done) => {
        for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
        server.close(() => done());
      }),
    };
    server.on('error', (e) => resolve(Object.assign(mock, { error: e.message })));
    server.listen('\\\\.\\pipe\\' + name, () => resolve(mock));
  });
}

// ---------------------------------------------------------------- the fixtures
//
// Every line below is either §12.3's own verbatim fixture (marked `§12.3`) or a
// round-8 live capture off the running app (marked `live`), copied unchanged —
// including the pane's own leading indent and the trailing `...` / `…` the agent
// itself wrote.

const FIX_STATUS_W4P1 = ' ☤ deepseek-flash │ ~173K/1M │ [██░░░░░░░░] ~17% │ ◎ 98.7% │ ◷ 4.0s. ─ 检查 Example Source Code 的...';   // §12.3
const FIX_STATUS_W6P1 = ' ☤ deepseek-flash │ 146K/1M │ [██░░░░░░░░] 15% │ ◎ 97.9% │ ◷ 8.8s.. ─ Build GUI for herdr multi...';     // §12.3
const FIX_PROC_HEAD2 = '  Processes · 2 running · Ctrl+T expand · F7 collapse';                                              // §12.3
const FIX_PROC_2A = '  ⚙ cd… · 10199s · last: 127.0.0.1 - - [25/Sep/2026 10:27:21] "GET /core/solver/analysis-worker.js…';    // §12.3
const FIX_PROC_2B = '  ⚙ cd "D:/Development/Sample/app" && node s… · 844s · last: bash: no job control in this shell';    // §12.3
const FIX_FOOTER_W6P2 = '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents                        8% until auto-compact';  // §12.3
const FIX_FOOTER_W4P2 = '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents       new task? /clear to save 124.2k tokens'; // §12.3
const FIX_USAGE = { input_tokens: 223, cache_creation_input_tokens: 0, cache_read_input_tokens: 145536, output_tokens: 2404 }; // §12.3

// live, round 8 (w4:p1 while this round was being written)
const LIVE_PROC_HEAD2 = '  Processes · 2 running · Ctrl+T expand · F7 collapse';
const LIVE_PROC_2A = '  ⚙ cd… · 10444s · last: 127.0.0.1 - - [25/Sep/2026 10:27:21] "GET /core/solver/analysis-worker.js…';
const LIVE_PROC_2B = '  ⚙ cd… · 10398s · last: 127.0.0.1 - - [25/Sep/2026 10:40:58] "GET /Nida%20Test%20Model/Arup%20Ste…';
// live, round 8 (w6:p1 — a pane with four background processes)
const LIVE_PROC_HEAD4 = ' Processes · 4 running · Ctrl+T expand · F7 collapse';
const LIVE_PROC_4 = [
  ' ⚙ cd "D:/Development/Sample/app" && node … · 1094s · last: bash: no job control in this shell',
  ' ⚙ cd "$TMPDIR"; sleep 25;… · 87s · last: 2026-09-25T05:20:15.680Z approval loop started for w6:p2',
  ' ⚙ cd "$TMPDIR"; sleep 25;… · 87s · last: 2026-09-25T05:20:15.719Z approval loop started for w6:p3',
  ' ⚙ cd "$TMPDIR"; sleep 25;… · 87s · last: 2026-09-25T05:20:15.799Z approval loop started for w6:p4',
];
const LIVE_STATUS_W6P1 = ' ☤ deepseek-flash │ 188K/1M │ [██░░░░░░░░] 19% │ ◎ 98.4% │ ◷ 8.3s.. ─ Build GUI for herdr multi...';

// DEFECT-19 (§12.3 4d). Two things are real here and neither is synthesized:
//
//  1. `FIX_MARK_TITLE` / `FIX_STATUS_ELAPSED` — a REAL capture off the running app,
//     `herdr pane read w6:p1 --source visible --lines 400` (kept in
//     `_scratch/w1/capture-w6-p1-r8fix.txt`), copied verbatim including the pane's
//     own indents. It contains TWO ☤ lines: hermes' message-box title and the status
//     line, whose `◷` figure the agent itself elided (`◷ 1...`). A scan that trusts
//     the mark alone can pick the title.
//  2. `FIX_HINT_BELOW` — the defect's own shape: the hint line sits BELOW the status
//     line, so a backwards scan for ☤ meets the hint FIRST. The hint text is Hermes'
//     verbatim capture quoted in §12.3 4d; the status line above it is the same real
//     w4:p1 line as `FIX_STATUS_W4P1`. (The hint only paints while hermes has an
//     interruptible turn; this reader must not prompt a pane to force it, so the
//     pair is composed from two real captures rather than re-captured live.)
const FIX_MARK_TITLE = '╭─ ☤ Hermes ───────────────────────────────────────────────────────────────────────────────────────╮';
const FIX_STATUS_ELAPSED = ' ☤ deepseek-flash │ ~160K/1M │ [██░░░░░░░░] ~16% │ ◎ 97.8% │ ◷ 1... ─ Build GUI for herdr multi...';
const FIX_HINT_BELOW = ' ☤ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel';
const LIVE_FOOTER_W6P2 = '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents';
const PROMPT_RULE = '────────────────────────────────────────────────────────────────────────────────────────────────────';

const SESS = {
  c1: '11111111-1111-1111-1111-111111111111',
  c2: '22222222-2222-2222-2222-222222222222',
  c3: '33333333-3333-3333-3333-333333333333',
  c4_missing: '44444444-4444-4444-4444-444444444444',   // recorded by herdr, no jsonl on disk
  c5: '55555555-5555-5555-5555-555555555555',
  c6: '66666666-6666-6666-6666-666666666666',
  c8: '88888888-8888-8888-8888-888888888888',   // claude pane whose pane.read herdr refuses
};

/** A claude session log whose LAST assistant record is the one under test. */
function claudeLog(id, records) {
  const dir = path.join(PROJECTS, 'D--Development-New');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const line = (rec) => JSON.stringify(rec);
  const head = [
    line({ type: 'user', uuid: 'u-1', timestamp: '2026-09-25T05:00:00.000Z', cwd: CWD, sessionId: id, message: { role: 'user', content: 'a question' } }),
  ];
  fs.writeFileSync(file, head.concat(records.map(line)).join('\n') + '\n');
  return file;
}

const usageRecord = (usage, model = 'deepseek-flash') => ({
  type: 'assistant', uuid: 'a-last', timestamp: '2026-09-25T05:20:00.000Z', cwd: CWD, sessionId: 'x',
  message: { role: 'assistant', model, usage },
});

// Pane → visible text, one pane per case so no case can be confused with another.
const TEXTS = new Map([
  ['w8:h1', { visible: [FIX_PROC_HEAD2, FIX_PROC_2A, FIX_PROC_2B, FIX_STATUS_W4P1, PROMPT_RULE, '❯ Turn these notes into a to-do list'].join('\n') }],
  ['w8:h2', { visible: [FIX_STATUS_W6P1].join('\n') }],
  ['w8:h3', { visible: ' ☤ deepseek-flash │ ~146K/1M │ [██░░░░░░░░] 15% │ ◎ 97.9% │ ◷ 2.5s. ─ mixed approximation...' }],
  ['w8:h4', { visible: ' ☤ deepseek-flash │ ~173K/1M │ … │ ◎ 98.7% │ ◷ 4.0s. ─ the percentage is elided' }],
  ['w8:h5', { visible: [FIX_PROC_HEAD2, FIX_PROC_2A, FIX_PROC_2B, PROMPT_RULE].join('\n') }],
  ['w8:h6', { visible: ['  Processes · 0 running · Ctrl+T expand · F7 collapse', PROMPT_RULE, '❯ ready'].join('\n') }],
  ['w8:h7', { visible: '' }],
  ['w8:h8', { visible: ' ☤ deepseek-flash │ ~173K/1M │ [██░░░░░░░░] ~17% ─ nothing after the percentage' }],
  ['w8:h9', { visible: [LIVE_PROC_HEAD4].concat(LIVE_PROC_4, [LIVE_STATUS_W6P1, PROMPT_RULE]).join('\n') }],
  ['w8:c1', { visible: [PROMPT_RULE, '❯ go', PROMPT_RULE, FIX_FOOTER_W6P2].join('\n') }],
  ['w8:c2', { visible: [PROMPT_RULE, '❯ go', PROMPT_RULE, LIVE_FOOTER_W6P2].join('\n') }],
  ['w8:c3', { visible: [PROMPT_RULE, '❯ go', PROMPT_RULE, FIX_FOOTER_W4P2].join('\n') }],
  ['w8:c4', { visible: [PROMPT_RULE, FIX_FOOTER_W6P2].join('\n') }],
  ['w8:c5', { visible: [PROMPT_RULE, FIX_FOOTER_W6P2].join('\n') }],
  ['w8:c6', { visible: [PROMPT_RULE, FIX_FOOTER_W6P2].join('\n') }],
  // h10 and c8 have text, but herdr refuses to hand it over (failReads below).
  ['w8:h10', { visible: [FIX_STATUS_W4P1].join('\n') }],
  // DEFECT-19 (§12.3 4d): the real two-☤ capture, the hint-below-status shape, and a
  // pane showing nothing BUT the hint.
  ['w8:h11', { visible: [FIX_MARK_TITLE, '', FIX_PROC_HEAD2, FIX_PROC_2A, FIX_STATUS_ELAPSED, PROMPT_RULE, '❯ Summarize what\'s in this folder'].join('\n') }],
  ['w8:h12', { visible: [FIX_STATUS_W4P1, FIX_HINT_BELOW].join('\n') }],
  ['w8:h13', { visible: [PROMPT_RULE, '❯ ready', FIX_HINT_BELOW].join('\n') }],
  ['w8:c8', { visible: [PROMPT_RULE, FIX_FOOTER_W6P2].join('\n') }],
  ['w8:o1', { visible: ' ☤ deepseek-flash │ ~173K/1M │ [██░░░░░░░░] ~17% │ ◎ 98.7% │ ◷ 4.0s. ─ a ☤ line inside a non-hermes pane' }],
]);

const AGENT = (pane, agent, session) => ({
  pane_id: pane, cwd: CWD, agent, agent_status: 'idle',
  agent_session: session === null ? null : { agent, kind: 'id', source: `herdr:${agent}`, value: session },
});

const AGENTS = [
  AGENT('w8:h1', 'hermes', '20260924_114721_d2973c'),
  AGENT('w8:h2', 'hermes', '20260924_215031_ca078c'),
  AGENT('w8:h3', 'hermes', '20260925_000000_aaaaaa'),
  AGENT('w8:h4', 'hermes', '20260925_000000_bbbbbb'),
  AGENT('w8:h5', 'hermes', '20260925_000000_cccccc'),
  AGENT('w8:h6', 'hermes', '20260925_000000_dddddd'),
  AGENT('w8:h7', 'hermes', '20260925_000000_eeeeee'),
  AGENT('w8:h8', 'hermes', '20260925_000000_ffffff'),
  AGENT('w8:h9', 'hermes', '20260925_111907_781d40'),
  AGENT('w8:c1', 'claude', SESS.c1),
  AGENT('w8:c2', 'claude', SESS.c2),
  AGENT('w8:c3', 'claude', SESS.c3),
  AGENT('w8:c4', 'claude', SESS.c4_missing),   // no jsonl on disk
  AGENT('w8:c5', 'claude', SESS.c5),
  AGENT('w8:c6', 'claude', SESS.c6),
  AGENT('w8:c7', 'claude', null),              // herdr records no session id
  AGENT('w8:h10', 'hermes', '20260925_000000_101010'),  // pane.read refused
  AGENT('w8:h11', 'hermes', '20260925_120000_111111'),  // two ☤ lines, real capture
  AGENT('w8:h12', 'hermes', '20260925_120000_222222'),  // hint below the status line
  AGENT('w8:h13', 'hermes', '20260925_120000_333333'),  // nothing but the hint
  AGENT('w8:c8', 'claude', SESS.c8),                    // pane.read refused, jsonl readable
  AGENT('w8:o1', 'codex', 'codex-session-1'),  // neither family
];

const STATUS_PANES = AGENTS.map((a) => a.pane_id);
const ALL_PANES = STATUS_PANES.concat(['w8:n1', 'w8:bogus-id']);

// ---------------------------------------------------------------- helpers

const READ_METHODS = new Set(['agent.list', 'session.snapshot', 'pane.read']);
const WRITE_METHODS = ['pane.prompt', 'pane.send_keys', 'agent.prompt', 'pane.report_agent_session', 'pane.text', 'pane.resize'];

/** GET /api/status and require a 200 {ok:true} answer; returns the parsed body. */
async function statusOk(paneId) {
  const r = await getJson(`${BASE}/api/status?pane_id=${encodeURIComponent(paneId)}`);
  eq(r.status, 200, `HTTP status for ${paneId}`);
  must(r.json, `no JSON body for ${paneId}: ${(r.text || r.error || '').slice(0, 200)}`);
  if (r.json.ok !== true) {
    throw new Fail(`${paneId} answered ok:false: ${JSON.stringify(r.json.error || r.json)}`);
  }
  eq(r.json.pane_id, paneId, 'pane_id echoed back');
  return r.json;
}

// ---------------------------------------------------------------- the checks

async function main() {
  rmrf(SCRATCH);
  fs.mkdirSync(CWD, { recursive: true });
  fs.writeFileSync(path.join(CWD, 'marker.txt'), 'a pane\'s workspace, and nothing may appear in it\n');
  fs.mkdirSync(PROJECTS, { recursive: true });

  // claude logs: c1 = §12.3's usage JSON; c2/c3 the same record (their footers are
  // what differs); c5 = a last assistant record with no usage at all; c6 = a record
  // missing one counter.
  claudeLog(SESS.c1, [usageRecord(FIX_USAGE)]);
  claudeLog(SESS.c2, [usageRecord(FIX_USAGE)]);
  claudeLog(SESS.c3, [usageRecord(FIX_USAGE)]);
  claudeLog(SESS.c5, [{ type: 'assistant', uuid: 'a-last', timestamp: '2026-09-25T05:20:00.000Z', cwd: CWD, message: { role: 'assistant', model: 'deepseek-flash', content: [{ type: 'text', text: 'no usage here' }] } }]);
  claudeLog(SESS.c6, [usageRecord({ input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 })]);
  claudeLog(SESS.c8, [usageRecord(FIX_USAGE)]);
  const jsonlBefore = [SESS.c1, SESS.c2, SESS.c3, SESS.c5, SESS.c6, SESS.c8].map((id) => {
    const f = path.join(PROJECTS, 'D--Development-New', `${id}.jsonl`);
    const st = fs.statSync(f);
    return { file: f, size: st.size, mtime: st.mtimeMs, bytes: fs.readFileSync(f) };
  });

  const mock = await startMockPipe({ agents: AGENTS, texts: TEXTS, cwd: CWD, panes: ALL_PANES, failReads: ['w8:h10', 'w8:c8'] });
  if (mock.error) throw new Fail(`mock pipe failed: ${mock.error}`);
  mockPipe = mock;

  await startServer(PORT, {
    HERDR_SOCKET_PATH: mock.name,
    CLAUDE_PROJECTS_DIR: PROJECTS,
    HERMES_STATE_DB: NO_HERMES_DB,
    CHAT_SESSION_CACHE_MS: '200',
  }, 'fixture');

  // Let the SSE hub's own startup calls (pane.list / events.subscribe) land before
  // the baseline: they are not this endpoint's traffic.
  await sleep(700);
  const base = mock.calls.length;

  // ── hermes: §12.3's own fixtures ──────────────────────────────────────────
  await check('status: the §12.3 w4:p1 fixture parses to the frozen example, field for field', async () => {
    const j = await statusOk('w8:h1');
    eq(keysOf(j), 'absent,agent,context,family,herdr_ms,lines_read,ok,pane_id,processes,status', 'the reply keys (the frozen shape plus herdr_ms)');
    eq(j.agent, 'hermes', 'agent');
    eq(j.family, 'hermes', 'family');
    const s = j.status;
    must(s, 'status is null for a pane whose ☤ line is on screen');
    eq(keysOf(s), 'approx,cache_pct,confidence,elapsed_s,elided,limit_tokens,model,source,source_line,used_pct,used_tokens', 'the status keys');
    eq(s.source, 'pane_text', 'status.source');
    eq(s.source_line, FIX_STATUS_W4P1.trim(), 'status.source_line (the pane\'s own line, surrounding whitespace trimmed)');
    eq(s.confidence, 'parsed', 'confidence: every figure of the line was read');
    eq(s.elided, false, 'elided: the fixture\'s trailing "..." is ASCII text, not the agent\'s `…`');
    eq(s.approx, true, 'approx: `~173K` and `~17%` are both marked approximate');
    eq(s.model, 'deepseek-flash', 'model');
    eq(s.used_tokens, 177152, 'used_tokens (173K at 1024/K, as the example JSON has it)');
    eq(s.limit_tokens, 1000000, 'limit_tokens (1M at 10^6, as the example JSON has it)');
    eq(s.used_pct, 17, 'used_pct');
    eq(s.cache_pct, 98.7, 'cache_pct');
    eq(s.elapsed_s, 4, 'elapsed_s (from `◷ 4.0s.`)');
    eqJson(j.absent, {}, 'absent: nothing is missing from this fixture');
    return { detail: '177152/1000000, ~17%, 98.7%, 4.0s' };
  });

  await check('status: the §12.3 process block keeps the agent\'s own elisions and adds nothing', async () => {
    const j = await statusOk('w8:h1');
    const p = j.processes;
    must(p, 'processes is null for a pane that prints a Processes block');
    eq(keysOf(p), 'hint,items,running,source', 'the processes keys');
    eq(p.source, 'pane_text', 'processes.source');
    eq(p.running, 2, 'running (the agent\'s own count)');
    eq(p.hint, 'Ctrl+T expand · F7 collapse', 'hint');
    eq(p.items.length, 2, 'items');
    eq(keysOf(p.items[0]), 'age_s,cmd,cmd_elided,last,last_elided', 'the item keys');
    eqJson(p.items[0], {
      cmd: 'cd…', cmd_elided: true, age_s: 10199,
      last: '127.0.0.1 - - [25/Sep/2026 10:27:21] "GET /core/solver/analysis-worker.js…', last_elided: true,
    }, 'item 0 (the elided one)');
    eqJson(p.items[1], {
      cmd: 'cd "D:/Development/Sample/app" && node s…', cmd_elided: true, age_s: 844,
      last: 'bash: no job control in this shell', last_elided: false,
    }, 'item 1 (elided command, complete last line)');
    // Verbatim, not "completed": each cmd and last must be a substring of the pane.
    const pane = TEXTS.get('w8:h1').visible;
    for (const it of p.items) {
      must(pane.includes(it.cmd), `cmd is not the pane's own text: ${it.cmd}`);
      must(pane.includes(it.last), `last is not the pane's own text: ${it.last}`);
      must(!/complet|finish|done/i.test(JSON.stringify(it)), `an item field invents a status: ${JSON.stringify(it)}`);
    }
    return { detail: '2 items, both cmd/last verbatim, elisions flagged' };
  });

  await check('status: the §12.3 w6:p1 fixture is NOT approximate and reads 8.8s..', async () => {
    const j = await statusOk('w8:h2');
    eq(j.status.source_line, FIX_STATUS_W6P1.trim(), 'source_line');
    eq(j.status.approx, false, 'approx: neither `146K` nor `15%` carries a `~`');
    eq(j.status.used_tokens, 149504, 'used_tokens (146 x 1024)');
    eq(j.status.limit_tokens, 1000000, 'limit_tokens');
    eq(j.status.used_pct, 15, 'used_pct');
    eq(j.status.cache_pct, 97.9, 'cache_pct');
    eq(j.status.elapsed_s, 8.8, 'elapsed_s (from `◷ 8.8s..` — the extra dot is not a number)');
    eq(j.status.confidence, 'parsed', 'confidence');
    eqJson(j.processes, null, 'processes for a pane that prints no block');
    eq(j.absent.processes, "no \"Processes · N running\" block in the pane's visible text (1 line(s) read)", 'the reason for the missing block');
    return { detail: '149504/1000000, 15%, 97.9%, 8.8s, no processes' };
  });

  await check('status: a `~` on either half makes the whole figure approximate', async () => {
    const j = await statusOk('w8:h3');
    eq(j.status.approx, true, 'approx: `~146K` on the used figure');
    eq(j.status.used_tokens, 149504, 'used_tokens (the `~` does not change the number)');
    eq(j.status.used_pct, 15, 'used_pct');
    return { detail: '~146K → 149504, approx true' };
  });

  await check('status: an elided value stays elided, is flagged, and says so in absent', async () => {
    const j = await statusOk('w8:h4');
    eq(j.status.elided, true, 'elided: the pane cut the percentage out with `…`');
    eq(j.status.confidence, 'partial', 'confidence: one figure of the line is missing');
    eq(j.status.used_pct, null, 'used_pct is null, never guessed from the bar');
    eq(j.absent['status.used_pct'], 'the status line carries no percentage', 'the reason for the null percentage');
    eq(j.status.model, 'deepseek-flash', 'the fields that ARE there are still served');
    eq(j.status.used_tokens, 177152, 'used_tokens');
    eq(j.status.cache_pct, 98.7, 'cache_pct');
    eq(j.status.elapsed_s, 4, 'elapsed_s');
    return { detail: 'elided true, used_pct null + reason, the rest intact' };
  });

  await check('status: a line missing its cache and elapsed figures is partial, with one reason each', async () => {
    const j = await statusOk('w8:h8');
    eq(j.status.confidence, 'partial', 'confidence');
    eq(j.status.cache_pct, null, 'cache_pct');
    eq(j.status.elapsed_s, null, 'elapsed_s');
    eq(j.absent['status.cache_pct'], 'the status line carries no "◎ <n>%" cache figure', 'cache reason');
    eq(j.absent['status.elapsed_s'], 'the status line carries no "◷ <n>s" elapsed figure', 'elapsed reason');
    eq(j.status.used_pct, 17, 'the percentage is still read');
    eq(j.status.approx, true, 'approx');
    return { detail: 'partial with both figures named in absent' };
  });

  await check('status: a pane with no status line answers 200 with null and a plain reason', async () => {
    const j = await statusOk('w8:h5');
    eqJson(j.status, null, 'status');
    must(/no ☤ status line/.test(j.absent.status || ''), `the reason should name the missing line, got ${JSON.stringify(j.absent.status)}`);
    must(/4 line\(s\) read/.test(j.absent.status || ''), `the reason should say how much was read, got ${JSON.stringify(j.absent.status)}`);
    must(j.processes, 'the process block on the same pane is still served');
    eq(j.processes.running, 2, 'running');
    return { detail: 'ok:true, status null, processes served' };
  });

  await check('status: a pane that prints nothing at all is still a 200 with reasons', async () => {
    const r = await getJson(`${BASE}/api/status?pane_id=w8:h7`);
    eq(r.status, 200, 'HTTP status for an agent that printed nothing');
    eq(r.json.ok, true, 'ok');
    eqJson(r.json.status, null, 'status');
    eqJson(r.json.processes, null, 'processes');
    must(/no ☤ status line/.test(r.json.absent.status || ''), 'a reason for the status');
    must(/no "Processes/.test(r.json.absent.processes || ''), 'a reason for the processes');
    return { detail: 'HTTP 200, ok:true, two absences' };
  });

  await check('status: hermes with zero processes is a block with running:0 and no items', async () => {
    const j = await statusOk('w8:h6');
    must(j.processes, 'processes is null for a 0-running block');
    eq(j.processes.running, 0, 'running');
    eqJson(j.processes.items, [], 'items');
    eq(j.processes.hint, 'Ctrl+T expand · F7 collapse', 'hint');
    must(!('processes' in j.absent), `a 0-running block is complete: no processes reason, got ${JSON.stringify(j.absent.processes)}`);
    must(!/processes\./.test(Object.keys(j.absent).join(',')), 'no per-field process reason either');
    must(/no ☤ status line/.test(j.absent.status || ''), 'the missing status line is still named (this pane prints none)');
    return { detail: 'running 0, items [], no process absence' };
  });

  await check('status: the round-8 live capture (4 processes, 188K/1M) reads without a fixture edit', async () => {
    const j = await statusOk('w8:h9');
    eq(j.processes.running, 4, 'running');
    eq(j.processes.items.length, 4, 'items');
    eq(j.processes.items[0].cmd, 'cd "D:/Development/Sample/app" && node …', 'item 0 cmd, verbatim');
    eq(j.processes.items[0].cmd_elided, true, 'item 0 cmd elided');
    must(/approval loop started for w6:p4/.test(j.processes.items[3].last), `item 3 last, got ${JSON.stringify(j.processes.items[3].last)}`);
    eq(j.processes.items[3].last_elided, false, 'item 3 last is complete');
    eq(j.status.used_tokens, 192512, 'used_tokens (188 x 1024)');
    eq(j.status.used_pct, 19, 'used_pct');
    eq(j.status.cache_pct, 98.4, 'cache_pct');
    eq(j.status.elapsed_s, 8.3, 'elapsed_s');
    eqJson(j.absent, {}, 'absent');
    return { detail: '4/4 items, 192512/1000000, 19%, 98.4%, 8.3s' };
  });

  // ── DEFECT-19 (§12.3 4d): the ☤ mark is not a status line ─────────────────
  await check('status: the real two-☤ capture reads the status line, not the box title', async () => {
    const j = await statusOk('w8:h11');
    must(j.status, 'a pane with a real status line must have one');
    eq(j.status.model, 'deepseek-flash', 'model — never the box title');
    must(!j.status.source_line.includes('╭'), 'source_line must not be the box title');
    eq(j.status.used_tokens, 163840, 'used_tokens (160 x 1024)');
    eq(j.status.limit_tokens, 1000000, 'limit_tokens');
    eq(j.status.used_pct, 16, 'used_pct');
    eq(j.status.cache_pct, 97.8, 'cache_pct');
    eq(j.status.approx, true, 'the ~ on used and pct');
    // The agent elided its own elapsed figure: `◷ 1...` is not a number, so the
    // field is null with a reason — never 1, never 1.0.
    eqJson(j.status.elapsed_s, null, 'elapsed_s');
    eq(j.absent['status.elapsed_s'], `the status line carries no "◷ <n>s" elapsed figure`, 'the reason');
    // The agent elided this one with ASCII `...`, not `…` — so by §12.3's own rule
    // (repeated in the §12.3 fixture, whose elided title ends in `...` while its
    // values are complete) `elided` stays false, exactly as this capture shows.
    // The elision is still visible where it costs something: elapsed_s is null.
    eq(j.status.elided, false, 'elided: ASCII "..." is ordinary text, not the U+2026 marker');
    eq(j.status.confidence, 'partial', 'confidence: one figure is unreadable');
    eq(j.processes.running, 2, 'the process block below it is still read');
    return { detail: 'model deepseek-flash, 163840/1000000, elapsed elided → null' };
  });

  await check('status: the hint BELOW the status line does not become the model (DEFECT-19)', async () => {
    const j = await statusOk('w8:h12');
    must(j.status, 'the status line above the hint must still be found');
    eq(j.status.model, 'deepseek-flash', 'model');
    eq(j.status.used_tokens, 177152, 'used_tokens');
    eq(j.status.limit_tokens, 1000000, 'limit_tokens');
    eq(j.status.used_pct, 17, 'used_pct');
    eq(j.status.cache_pct, 98.7, 'cache_pct');
    eq(j.status.elapsed_s, 4, 'elapsed_s');
    eq(j.status.source_line, FIX_STATUS_W4P1.trim(), 'source_line is the status line, not the hint below it');
    // This pane prints no process block, so `processes` is legitimately absent; the
    // point here is that nothing about the STATUS block is absent.
    must(!Object.keys(j.absent).some((k) => k.startsWith('status')),
      `no status field may be absent: ${JSON.stringify(j.absent)}`);
    must(!/msg=interrupt/.test(JSON.stringify(j.status)), `nothing in status may come from the hint: ${JSON.stringify(j.status)}`);
    return { detail: 'the backwards scan skipped the hint and read the line that carries figures' };
  });

  await check('status: a pane showing nothing but the hint has NO status line, and invents nothing', async () => {
    const j = await statusOk('w8:h13');
    eqJson(j.status, null, 'status');
    must(/msg=interrupt/.test(FIX_HINT_BELOW) && /☤ line\(s\)/.test(j.absent.status || ''),
      `the reason should say the mark alone is not a status line, got ${JSON.stringify(j.absent.status)}`);
    must(/not a status line/.test(j.absent.status || ''), 'and say so plainly');
    must(!/deepseek|msg=interrupt/.test(j.absent.status || ''), 'the reason must not echo the untrusted pane text as a value');
    eqJson(j.processes, null, 'processes');
    eq(j.lines_read, 3, 'lines_read is still reported, so a client can say "in the last 3 lines"');
    return { detail: j.absent.status.slice(0, 96) };
  });

  await check('status: lines_read reports the text the answer came from, and null when nothing was read', async () => {
    const h = await statusOk('w8:h2');            // one line of pane text: the §12.3 w6:p1 status line
    eq(h.lines_read, 1, 'a one-line pane reads 1 line');
    must(!Object.keys(h.absent).some((k) => k.startsWith('status')), `no status field may be absent: ${JSON.stringify(h.absent)}`);
    const o = await statusOk('w8:o1');            // family other: no read at all
    eqJson(o.lines_read, null, 'no read → null, not 0');
    const x = await statusOk('w8:h10');           // the read was refused
    eqJson(x.lines_read, null, 'a refused read has no line count to report');
    return { detail: 'w8:h2 → 1, family "other" → null, refused read → null' };
  });

  // ── claude: context from its own log, the footer from its own text ────────
  await check('status: claude context is §12.3.2\'s sum of the last assistant record', async () => {
    const j = await statusOk('w8:c1');
    eq(j.family, 'claude', 'family');
    const c = j.context;
    must(c, 'context is null for a claude pane with a readable log');
    eq(keysOf(c), 'age_s,breakdown,model,source,source_line,tokens,until_auto_compact_pct', 'the context keys');
    eq(c.source, 'claude_jsonl', 'context.source');
    eq(c.model, 'deepseek-flash', 'model, from the record');
    eqJson(c.breakdown, { input: 223, cache_read: 145536, cache_create: 0, output: 2404 }, 'breakdown');
    // Rule 2's sentence: input + cache_read + cache_creation + output. The example
    // JSON beside it shows 145759, which is the same sum WITHOUT the output tokens;
    // the sentence is normative, so 148163 is what the server serves (NOTES say so).
    eq(c.tokens, 148163, 'tokens = input + cache_read + cache_create + output');
    eq(c.tokens, 145759 + c.breakdown.output, 'the output tokens are part of the sum');
    eq(c.until_auto_compact_pct, 8, 'until_auto_compact_pct, claude\'s own footer figure');
    eq(c.source_line, FIX_FOOTER_W6P2.trim(), 'source_line: the footer line the figure came from, verbatim');
    must(Number.isFinite(c.age_s) && c.age_s >= 0, `age_s should be the log's age in seconds, got ${JSON.stringify(c.age_s)}`);
    eqJson(j.status, null, 'status: a claude pane prints no ☤ line');
    must(/hermes/.test(j.absent.status || ''), `the reason should name whose line it is, got ${JSON.stringify(j.absent.status)}`);
    must(/hermes/.test(j.absent.processes || ''), `the process reason should name whose block it is, got ${JSON.stringify(j.absent.processes)}`);
    return { detail: `tokens 148163 (223+145536+0+2404), 8% until auto-compact, age ${c.age_s}s` };
  });

  await check('status: a claude footer without the percentage leaves the field null, with a reason', async () => {
    const j = await statusOk('w8:c2');
    eq(j.context.until_auto_compact_pct, null, 'until_auto_compact_pct');
    // §12.3 4e: with no auto-compact figure there is no source line either — the
    // mode hint on screen did not support these numbers, so it is not offered as
    // if it did. The hint is named in the reason instead.
    eqJson(j.context.source_line, null, 'source_line');
    eq(j.absent['context.source_line'],
      'the only footer line on screen is claude\'s mode hint ("auto mode on"), which carries no figure — it is not the source of these numbers',
      'the reason says why there is no source line');
    eq(j.absent['context.until_auto_compact_pct'], 'claude prints no "% until auto-compact" figure on its footer right now', 'the reason');
    eq(j.context.tokens, 148163, 'the jsonl half of the context is unaffected by the footer');
    return { detail: 'pct null + reason, source_line null + reason, tokens still served' };
  });

  await check('status: a footer offering `/clear to save N tokens` is named in absent, not presented as the source', async () => {
    const j = await statusOk('w8:c3');
    eq(j.context.until_auto_compact_pct, null, 'until_auto_compact_pct');
    eqJson(j.context.source_line, null, 'source_line: the offer holds no auto-compact figure');
    eq(j.absent['context.until_auto_compact_pct'],
      'claude\'s footer offers "clear to save 124.2k tokens" instead of a "% until auto-compact" figure',
      'the reason names the alternative claude printed');
    eq(j.absent['context.source_line'],
      'the footer line on screen offers "/clear to save N tokens" instead of a figure — it is not the source of these numbers',
      'and the source-line reason says why');
    eq(j.context.tokens, 148163, 'the jsonl half is untouched');
    return { detail: 'the /clear offer is quoted in absent; source_line is null' };
  });

  await check('status: a claude pane whose session log is missing says so, and still answers', async () => {
    const j = await statusOk('w8:c4');
    eqJson(j.context, null, 'context');
    must(/no session file/.test(j.absent.context || ''), `the reason should name the missing file, got ${JSON.stringify(j.absent.context)}`);
    must(j.absent.context.includes(SESS.c4_missing), 'the reason should carry the session id herdr recorded');
    return { detail: j.absent.context.slice(0, 80) };
  });

  await check('status: a log whose last assistant record carries no usage yields no number', async () => {
    const j = await statusOk('w8:c5');
    eqJson(j.context, null, 'context');
    must(/no assistant record carrying a usage figure/.test(j.absent.context || ''), `got ${JSON.stringify(j.absent.context)}`);
    return { detail: j.absent.context.slice(0, 80) };
  });

  await check('status: a record missing one counter is refused, not completed with a zero', async () => {
    const j = await statusOk('w8:c6');
    eqJson(j.context, null, 'context');
    must(/cache_create/.test(j.absent.context || ''), `the reason should name the missing counter, got ${JSON.stringify(j.absent.context)}`);
    must(!/\b0\b/.test(JSON.stringify(j.context)), 'no counter may be invented');
    return { detail: j.absent.context.slice(0, 90) };
  });

  await check('status: a claude pane herdr records no session for is absent, not scanned', async () => {
    const before = mock.calls.length;
    const j = await statusOk('w8:c7');
    eqJson(j.context, null, 'context');
    must(/herdr records no session id/.test(j.absent.context || ''), `got ${JSON.stringify(j.absent.context)}`);
    eq(mock.reads(before), 1, 'the pane was still read once (its footer is in the text)');
    return { detail: 'no session → absent without a scan' };
  });

  // ── the other family, and the panes herdr cannot identify ────────────────
  await check('status: an agent of neither family answers family:"other", nulls, and no read at all', async () => {
    const before = mock.calls.length;
    const j = await statusOk('w8:o1');
    eq(j.family, 'other', 'family');
    eq(j.agent, 'codex', 'agent');
    eqJson(j.status, null, 'status');
    eqJson(j.context, null, 'context');
    eqJson(j.processes, null, 'processes');
    must(/codex/.test(j.absent.status || ''), `status reason should name the agent, got ${JSON.stringify(j.absent.status)}`);
    must(/codex/.test(j.absent.context || ''), 'context reason should name the agent');
    must(/codex/.test(j.absent.processes || ''), 'process reason should name the agent');
    eq(mock.reads(before), 0, 'no pane.read for a family nothing can be interpreted from');
    return { detail: 'three absences, zero reads' };
  });

  await check('status: a pane in the snapshot with no agent answers family:"other" with a null agent', async () => {
    const before = mock.calls.length;
    const j = await statusOk('w8:n1');
    eq(j.family, 'other', 'family');
    eqJson(j.agent, null, 'agent');
    eq(j.absent.agent, "herdr's agent list names no agent for this pane", 'the reason for the null agent');
    eqJson(j.status, null, 'status');
    eq(mock.reads(before), 0, 'no pane.read for a pane running nothing');
    return { detail: 'family other, agent null + reason, zero reads' };
  });

  await check('status: an unknown pane id is refused as pane_not_found, before any read', async () => {
    const before = mock.calls.length;
    const r = await getJson(`${BASE}/api/status?pane_id=w8:no-such-pane`);
    eq(r.status, 200, 'HTTP status (this server answers API errors as 200 with ok:false)');
    eq(r.json.ok, false, 'ok');
    eq(r.json.error.code, 'pane_not_found', 'error code');
    must(/no-such-pane/.test(r.json.error.message || ''), 'the message should echo the id');
    eq(mock.reads(before), 0, 'a bogus id must not cost a pane.read');
    return { detail: r.json.error.message };
  });

  // ── a pane herdr will not hand over is still a 200, never a 500 ──────────
  await check('status: a pane whose read is refused is a 200 with the failure named, not a 500', async () => {
    const before = mock.calls.length;
    const j = await statusOk('w8:h10');
    eq(j.family, 'hermes', 'family is still known from the agent list');
    eqJson(j.status, null, 'status');
    eqJson(j.processes, null, 'processes');
    must(/pane_not_found/.test(j.absent.status || ''), `status reason should name herdr's code, got ${JSON.stringify(j.absent.status)}`);
    must(/could not be read|pane_not_found/.test(j.absent.processes || ''), `process reason should say the text was unreadable, got ${JSON.stringify(j.absent.processes)}`);
    must(j.absent.status && j.absent.status.length > 20, 'the reason must be a sentence, not a bare code');
    eq(mock.reads(before), 1, 'the refusal costs the one read it attempted — and no retry');
    return { detail: j.absent.status.slice(0, 96) };
  });

  await check('status: a claude pane whose read is refused still gets its context from the jsonl', async () => {
    const before = mock.calls.length;
    const j = await statusOk('w8:c8');
    eq(j.family, 'claude', 'family');
    must(j.context && j.context.tokens === 148163, `context must survive an unreadable pane, got ${JSON.stringify(j.context && j.context.tokens)}`);
    eq(j.context.breakdown.output, 2404, 'breakdown.output');
    eqJson(j.context.until_auto_compact_pct, null, 'no footer figure, because there is no footer to read');
    must(/could not be read/.test(j.absent['context.until_auto_compact_pct'] || ''),
      `the absence must blame the read, not the agent: ${JSON.stringify(j.absent['context.until_auto_compact_pct'])}`);
    must(/pane_not_found/.test(j.absent['context.source_line'] || ''),
      `and it should quote herdr's code: ${JSON.stringify(j.absent['context.source_line'])}`);
    eqJson(j.status, null, 'status');
    eq(mock.reads(before), 1, 'one read attempted');
    return { detail: 'jsonl still answers; the footer absence blames the read' };
  });

  await check('status: a missing pane_id is a bad_request', async () => {
    const r = await getJson(`${BASE}/api/status`);
    eq(r.json.ok, false, 'ok');
    eq(r.json.error.code, 'bad_request', 'error code');
    must(/pane_id/.test(r.json.error.message || ''), 'the message should name the parameter');
    return { detail: r.json.error.message.slice(0, 70) };
  });

  // ── cost: one read per call, no scan, a measured round trip ───────────────
  await check('status: every call costs exactly ONE pane.read, of `visible`', async () => {
    const seen = [];
    for (const pane of ['w8:h1', 'w8:c1', 'w8:h6', 'w8:h9']) {
      const before = mock.calls.length;
      await statusOk(pane);
      const reads = mock.calls.slice(before).filter((c) => c.method === 'pane.read');
      eq(reads.length, 1, `pane.read calls for ${pane}`);
      eq(reads[0].params.source, 'visible', `the source read for ${pane}`);
      eq(reads[0].params.format, 'text', 'format');
      eq(reads[0].params.strip_ansi, true, 'strip_ansi');
      eq(reads[0].params.pane_id, pane, 'the pane read is the pane asked about');
      must(Number.isFinite(reads[0].params.lines), 'lines must be a number');
      seen.push(`${pane}:1`);
    }
    return { detail: seen.join(' ') };
  });

  await check('status: the identification comes from the 5 s cache, never from a scan', async () => {
    const before = mock.calls.length;
    for (const pane of ['w8:h1', 'w8:c1', 'w8:o1', 'w8:h2']) await statusOk(pane);
    const delta = mock.methods(before);
    const lists = delta.filter((m) => m === 'agent.list').length;
    const snaps = delta.filter((m) => m === 'session.snapshot').length;
    eq(lists, 0, 'agent.list calls inside the 5 s cache window (four status requests in a row)');
    eq(snaps, 0, 'session.snapshot calls for panes herdr has an agent entry for');
    // Four requests, three reads: w8:o1 is `codex`, and §12.3.4 forbids reading a
    // pane whose agent is neither family — nothing there is ours to interpret.
    eq(delta.filter((m) => m === 'pane.read').length, 3, 'pane reads (one per request that has text to interpret)');
    return { detail: `4 requests: ${delta.length} herdr calls, all pane.read (the codex pane costs none)` };
  });

  await check('status: `herdr_ms` is the round trip it cost, not a decoration', async () => {
    mock.delayMs = 300;
    let slow;
    try {
      slow = await statusOk('w8:h2');
    } finally {
      mock.delayMs = 0;
    }
    must(slow.herdr_ms >= 250, `a pane.read held for 300 ms should show up in herdr_ms, got ${slow.herdr_ms}`);
    const fast = await statusOk('w8:h2');
    must(fast.herdr_ms >= 0 && fast.herdr_ms < slow.herdr_ms, `an undelayed read (${fast.herdr_ms} ms) must be below the delayed one (${slow.herdr_ms} ms)`);
    must(typeof slow.herdr_ms === 'number' && Number.isFinite(slow.herdr_ms), 'herdr_ms must be a finite number');
    return { detail: `held read ${slow.herdr_ms} ms vs ${fast.herdr_ms} ms` };
  });

  // ── read-only, proved twice ───────────────────────────────────────────────
  await check('status: the whole run issued read methods only — no pane was written to', async () => {
    const delta = mock.calls.slice(base);
    const methods = [...new Set(delta.map((c) => c.method))].sort();
    const foreign = methods.filter((m) => !READ_METHODS.has(m));
    eq(foreign.join(','), '', `methods outside the read allowlist: ${foreign.join(', ')}`);
    for (const m of WRITE_METHODS) {
      eq(delta.filter((c) => c.method === m).length, 0, `${m} calls`);
    }
    const count = mock.calls.filter((c) => c.method === 'agent.list').length;
    notes.push(`${delta.length} herdr calls over the status phase, methods: ${methods.join(', ')} (agent.list ${count} time(s) for the whole run, SSE hub calls excluded via the baseline)`);
    eq(count < 2, true, `agent.list should be cached, not called per status request (${count} over ~20 requests)`);
    return { detail: `${delta.length} calls, methods ${methods.join('/')}` };
  });

  await check('status: the claude logs are byte-identical after every read', async () => {
    for (const b of jsonlBefore) {
      const st = fs.statSync(b.file);
      eq(st.size, b.size, `${path.basename(b.file)} size`);
      eq(st.mtimeMs, b.mtime, `${path.basename(b.file)} mtime`);
      must(fs.readFileSync(b.file).equals(b.bytes), `${path.basename(b.file)} bytes changed`);
    }
    const outside = fs.readdirSync(CWD);
    eq(outside.join(','), 'marker.txt', 'the pane\'s cwd gained nothing');
    return { detail: `${jsonlBefore.length} logs unchanged, cwd untouched` };
  });

  await check('cleanup: the test port is free again', async () => {
    killAll();
    if (mockPipe) { await mockPipe.close(); mockPipe = null; }
    const deadline = Date.now() + 10000;
    let busy = false;
    do {
      busy = await listening(PORT);
      if (!busy) break;
      await sleep(300);
    } while (Date.now() < deadline);
    eq(busy, false, `port ${PORT} still listening`);
    return { detail: `port ${PORT} free` };
  });

  // ── report ──────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.passed).length;
  console.log('');
  notes.push('§12.3.2 says tokens = input + cache_read + cache_creation + output; the example JSON beside it shows 145759, which is that sum WITHOUT the output tokens (148163 with them). The sentence is what this server follows.');
  notes.push('the response carries one key the frozen shape does not name: `herdr_ms`, §12.3.5\'s round-trip latency, in milliseconds (the contract names the latency but no field).');
  notes.push('`absent` keys are dotted paths from the response root (`status.used_pct`, `processes.items[0].last`, `context.until_auto_compact_pct`).');
  notes.push(`fixtures: §12.3's verbatim lines plus a round-8 live capture (w4:p1 with 2 processes, w6:p1 with 4 processes, 188K/1M, and w6:p2's footer without a percentage)`);
  notes.push('DEFECT-19 (§12.3 4d): a `☤` line is read only if it carries usage figures. The fixture is a real capture (\`herdr pane read w6:p1 --source visible --lines 400\`, \`_scratch/w1/capture-w6-p1-r8fix.txt\`) holding hermes\' message-box title AND the status line; the hint-below-status arrangement is composed from that pane\'s status line plus the hint line quoted verbatim in §12.3 4d, because the hint paints only during an interruptible turn and this reader does not prompt a pane to force it.');
  notes.push('§12.3 4e: `context.source_line` is only the line the auto-compact figure came from — with no figure it is null and `absent[\'context.source_line\']` names what is on screen instead (the mode hint, or the /clear offer).');
  notes.push('§12.3 4b: `lines_read` is reported (null when nothing was read); the counts in the `absent` prose are unchanged, so a client that ignores the field still shows a truthful reason.');
  for (const n of notes) console.log(`NOTE ${n}`);
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  if (pass !== results.length) {
    console.log('');
    for (const r of results) if (!r.passed) console.log(`  FAILED: ${r.name} — ${r.detail}`);
  }
  report(pass === results.length ? 0 : 1);
}

/**
 * Leave nothing behind: kill the child, close the mock pipe, drop pooled sockets,
 * and make the exit unconditional.
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
