#!/usr/bin/env node
// herdr-dash round-5 harness — CONTRACT-v2 §7.1 (GET /api/git) — owner: W1.
//
// Zero dependencies (node:http / node:net / node:fs / node:path / node:child_process).
//
// WHAT THIS PROVES, AND WHY IT IS BUILT THIS WAY
//
//   The endpoint reports what git reports. So the oracle here is git itself: the
//   harness builds a fixture repository, then asserts the endpoint's JSON against
//   `git status --porcelain` and `git diff --numstat` run in that same repository
//   — never against a hand-written expectation of what those commands "should"
//   say. If the fixture changes, the expectations change with it. The parse on
//   this side deliberately uses git's PLAIN (human) formats while the server
//   parses the `-z` ones, so agreement between them is evidence rather than a
//   restatement of the same parser.
//
//   Diff mode is checked by BYTE EQUALITY: for a real file the harness runs
//   `git diff --no-color --unified=3 -- <file>` (and the --cached variant) and
//   requires the endpoint's `diff` string to be exactly that stdout.
//
//   Read-only is proved twice: statically (the subcommand whitelist is parsed out
//   of src/server.js and enumerated; see check names beginning "whitelist:") and
//   behaviourally (a working-tree hash, HEAD, the staged content, the stash list
//   and the commit count are captured before and after every call the harness
//   makes, and must be unchanged).
//
//   The server under test is pointed at a MOCK herdr pipe, so this runs without
//   touching the real herdr: the mock's snapshot gives each fixture directory a
//   pane id, which is how the endpoint is told which cwd to look at. Nothing here
//   reads or writes any directory other than _scratch/w1 and the OS temp dir.
//
// Usage:
//   node test/git-view.mjs [--port 7455] [--dump]
//
//   default   spawn `node src/server.js --port <port>` (plus one short-lived
//             extra on <port>+1 for the git_missing / git_failed cases), test it,
//             kill everything, then verify the ports are free again.
//   --dump    also print the raw /api/git status JSON for the fixture pane.
//
// Exit code is 0 only when every check passed.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// ---------------------------------------------------------------- paths & args

const HERE = (() => {
  if (import.meta.dirname) return import.meta.dirname;
  const p = decodeURIComponent(new URL('.', import.meta.url).pathname);
  return process.platform === 'win32' && /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
})();
const REPO_ROOT = path.resolve(HERE, '..');
const SERVER_SRC = path.join(REPO_ROOT, 'src', 'server.js');

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const PORT = Number(flagValue('--port', '7455'));
const EXTRA_PORT = PORT + 1;          // git_missing / git_failed instances
const BASE = `http://127.0.0.1:${PORT}`;
const DUMP = argv.includes('--dump');
const SPAWN_WAIT_MS = 20000;

// The git the harness itself calls. GIT_BIN_PATH is honoured so the oracle and
// the server use the same binary — but the git_missing check passes a bogus path
// to the CHILD SERVER's environment only, never to process.env.
const GIT = process.env.GIT_BIN_PATH || 'git';

const SCRATCH = path.join(REPO_ROOT, '_scratch', 'w1');
const FIX = path.join(SCRATCH, 'gitview-fixture');       // the repo under test
const EDGE = path.join(SCRATCH, 'gitview-edge');         // two rows for one path
const EMPTY = path.join(SCRATCH, 'gitview-empty');       // git init, no commits
const PLAIN = path.join(SCRATCH, 'gitview-notrepo');     // not a repo (if it is one here, see pickNonRepo)
const GHOST = path.join(SCRATCH, 'gitview-ghost-nonexistent'); // pane cwd that does not exist

// ---------------------------------------------------------------- check runner

class Fail extends Error {}
const must = (cond, msg) => { if (!cond) throw new Fail(msg); };

const results = [];
const notes = [];

async function check(name, fn) {
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
    detail = e instanceof Fail
      ? e.message
      : `unexpected ${(e && e.name) || 'error'}: ${(e && e.message) || String(e)}`;
  }
  results.push({ name, passed, detail });
  const ms = Date.now() - started;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${passed ? '' : ` — ${detail}`}${ms > 400 && passed ? ` [${ms}ms]` : ''}`);
  return passed;
}

// ---------------------------------------------------------------- process + http helpers

const children = [];
function killChild(c) {
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  try { c.kill(); } catch { /* ignore */ }
  setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } }, 1500).unref();
}
function killAll() {
  while (children.length) killChild(children.pop());
}
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

async function startServer(port, env) {
  // Refuse to test a server this harness did not start. Without this, a leftover
  // process on the port answers every request and the checks report on the WRONG
  // build — which is exactly what happened once while writing this file.
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
    if (spawnErr) throw new Fail(`could not spawn the server on ${port}: ${spawnErr.message}`);
    if (exited !== null) throw new Fail(`the server on ${port} ${exited} during startup; output: ${out.trim().slice(0, 400) || '(none)'}`);
    if (await listening(port)) return { proc, banner: out.trim().split(/\r?\n/)[0] || '(no listen line)' };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Fail(`the server on ${port} was not listening within ${SPAWN_WAIT_MS}ms; output: ${out.trim().slice(0, 400) || '(none)'}`);
}

function request(method, url, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ error: `bad url ${url}: ${e.message}` }); }
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({
      method, hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
    }, (res) => {
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

/** GET /api/git with query parts, asserting we actually reached a JSON reply. */
async function apiGit(params, opts) {
  const qs = new URLSearchParams(params).toString();
  const url = `${(opts && opts.base) || BASE}/api/git?${qs}`;
  const r = await request('GET', url);
  if (r.error) throw new Fail(`could not reach ${url} — ${r.error}`);
  must(r.json != null, `${url}: reply was not JSON (HTTP ${r.status}): ${(r.text || '').slice(0, 200)}`);
  return r;
}

// ---------------------------------------------------------------- the harness' own git

function git(args, cwd, opts = {}) {
  const r = spawnSync(GIT, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

function gitOk(args, cwd) {
  const r = git(args, cwd);
  if (r.error) throw new Fail(`could not run git ${args.join(' ')} in ${cwd}: ${r.error.message}`);
  if (r.code !== 0) throw new Fail(`git ${args.join(' ')} failed (${r.code}) in ${cwd}: ${r.stderr.trim()}`);
  return r.stdout;
}

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const writeLF = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');   // '\n' stays '\n': no CRLF rewriting
};
const appendLF = (p, text) => fs.appendFileSync(p, text, 'utf8');

// ---------------------------------------------------------------- fixtures

const ini = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function buildFixture() {
  rmrf(FIX);
  fs.mkdirSync(FIX, { recursive: true });
  const g = (args) => gitOk(args, FIX);

  g(['init', '-q', '.']);
  // Hermetic: identity, no line-ending rewriting, no signing prompts.
  g(['config', 'user.email', 'w1@example.invalid']);
  g(['config', 'user.name', 'W1 Git-View Fixture']);
  g(['config', 'core.autocrlf', 'false']);
  g(['config', 'commit.gpgsign', 'false']);

  writeLF(path.join(FIX, 'worktree.txt'), ini(5));     // -> ' M' (unstaged modify)
  writeLF(path.join(FIX, 'staged.txt'), 'alpha\nbeta\n');
  writeLF(path.join(FIX, 'deleted.txt'), ini(3));
  writeLF(path.join(FIX, 'old.txt'), 'rename me\n');
  writeLF(path.join(FIX, 'sub', 'deep.txt'), 'deep one\ndeep two\n');
  writeLF(path.join(FIX, 'big.txt'), ini(2500));       // long diff: exercises max_lines
  writeLF(path.join(FIX, 'clean.txt'), 'never touched\n');  // stays clean: no diff at all
  fs.writeFileSync(path.join(FIX, 'binary.bin'), Buffer.from([65, 0, 66, 0, 67, 0])); // tracked binary
  writeLF(path.join(FIX, '.gitignore'), 'ignored.txt\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'one']);

  // The state §7.1 has to describe: one of each row type.
  appendLF(path.join(FIX, 'worktree.txt'), 'worktree change\n');      // unstaged modify
  appendLF(path.join(FIX, 'staged.txt'), 'staged change\n');
  g(['add', 'staged.txt']);                                           // staged modify
  fs.unlinkSync(path.join(FIX, 'deleted.txt'));                       // unstaged delete
  writeLF(path.join(FIX, 'untracked.txt'), 'brand new\n');             // untracked
  g(['mv', 'old.txt', 'renamed.txt']);                                 // staged rename
  appendLF(path.join(FIX, 'sub', 'deep.txt'), 'deep change\n');        // unstaged, nested path
  writeLF(path.join(FIX, 'big.txt'), ini(2500).replace(/line /g, 'changed ')); // 2500 -/+
  writeLF(path.join(FIX, 'ignored.txt'), 'ignore me\n');               // must never appear
  fs.writeFileSync(path.join(FIX, 'binary.bin'), Buffer.from([65, 0, 66, 0, 67, 0, 68, 0])); // binary modify
}

/**
 * A second, tiny repo for the one state whose status holds TWO rows for one path:
 * a staged delete plus an untracked file of the same name. Before §7.1 errata 2
 * this answered with an empty diff while git held a real deletion.
 */
function buildEdge() {
  rmrf(EDGE);
  fs.mkdirSync(EDGE, { recursive: true });
  const g = (args) => gitOk(args, EDGE);
  g(['init', '-q', '.']);
  g(['config', 'user.email', 'w1@example.invalid']);
  g(['config', 'user.name', 'W1 Git-View Fixture']);
  g(['config', 'core.autocrlf', 'false']);
  g(['config', 'commit.gpgsign', 'false']);
  writeLF(path.join(EDGE, 'twice.txt'), ini(6));
  writeLF(path.join(EDGE, 'plain.txt'), ini(3));
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'one']);
  g(['rm', '-q', '--cached', 'twice.txt']);            // staged delete  -> 'D '
  fs.unlinkSync(path.join(EDGE, 'twice.txt'));
  writeLF(path.join(EDGE, 'twice.txt'), 'recreated, untracked\n');  // -> '??' same path
  appendLF(path.join(EDGE, 'plain.txt'), 'plain change\n');         // ordinary tracked modify
}

function buildEmpty() {
  rmrf(EMPTY);
  fs.mkdirSync(EMPTY, { recursive: true });
  gitOk(['init', '-q', '.'], EMPTY);
}

/**
 * The not-a-repo case needs a directory git genuinely does not consider a repo.
 * Rather than assume one, ask git — and if the scratch dir turns out to live
 * inside some repo, fall back to a fresh temp dir, because then the scratch path
 * cannot demonstrate the state at all.
 */
function pickNonRepo() {
  const candidates = [PLAIN, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-dash-norepo-')), 'inside')];
  for (const dir of candidates) {
    rmrf(dir);
    fs.mkdirSync(dir, { recursive: true });
    const r = git(['rev-parse', '--show-toplevel'], dir);
    if (r.error) throw new Fail(`could not run git in ${dir}: ${r.error.message}`);
    if (r.code !== 0) return { dir, stderr: r.stderr.trim() };
  }
  throw new Fail(`could not find a directory outside a git repo (tried ${candidates.join(' and ')}) — the not_a_repo state cannot be exercised here`);
}

// ---------------------------------------------------------------- mock herdr pipe

/**
 * Stands in for herdr's named pipe. The endpoint takes the pane's cwd from
 * `session.snapshot`, so this is what points it at the fixture directories — the
 * client never gets to name a directory. The pipe name is the HERDR_SOCKET_PATH
 * value src/hdr.js prefixes with `\\.\pipe\`.
 */
function startMockPipe(panes) {
  return new Promise((resolve) => {
    const name = `herdr-dash-gittest-${process.pid}-${Date.now()}`;
    const sockets = new Set();
    const snapshot = {
      version: '0.0.0-mock',
      protocol: 22,
      focused_workspace_id: 'w1',
      focused_tab_id: 'w1:t1',
      focused_pane_id: panes[0] && panes[0].pane_id,
      workspaces: [],
      tabs: [],
      layouts: [],
      agents: [],
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
          const reply = (result) => {
            if (sock.destroyed) return;
            sock.write(JSON.stringify({ id: msg.id, result }) + '\n');
            if (msg.method !== 'events.subscribe') sock.end();  // one shot, like the real one
          };
          if (msg.method === 'session.snapshot') reply({ snapshot });
          else if (msg.method === 'events.subscribe') reply({ type: 'subscription_started' });
          else if (msg.method === 'pane.list') reply({ panes: [] });
          else reply({ ok: true });
        }
      });
    });

    server.on('error', (e) => resolve({ error: e.message, close: async () => {} }));
    server.listen('\\\\.\\pipe\\' + name, () => {
      resolve({
        name,
        close: () => new Promise((done) => {
          for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
          server.close(() => done());
        }),
      });
    });
  });
}

// ---------------------------------------------------------------- git's own answers (the oracle)

/**
 * Parse `git status --porcelain` (PLAIN format, not -z) for the fixture.
 *
 * `??` rows are reported as untracked ONLY: an untracked file is not in the index,
 * so §7.1's `staged` and `unstaged` are both false for it. §7.1 does not say this
 * outright, so the choice is asserted from both sides — here, and by the
 * "one badge per row" invariant two checks below.
 */
function porcelainRows() {
  const out = gitOk(['status', '--porcelain', '--untracked-files=all'], FIX);
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    let p = line.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') p = p.split(' -> ').pop();   // rename: post-image
    if (p.startsWith('"') && p.endsWith('"')) p = JSON.parse(p);
    p = p.replace(/\\/g, '/');
    rows.push({
      path: p,
      xy,
      untracked: xy === '??',
      staged: xy !== '??' && xy[0] !== ' ',
      unstaged: xy !== '??' && xy[1] !== ' ',
    });
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows;
}

/** Parse `git diff [--cached] --numstat` (PLAIN format) into path -> {added,deleted}. */
function numstatMap(args) {
  const out = gitOk(args, FIX);
  const map = new Map();
  for (const line of out.split('\n')) {
    if (!line.includes('\t')) continue;
    const f = line.split('\t');
    if (f.length < 3) continue;
    let p = f.slice(2).join('\t');
    if (p.includes(' => ')) p = p.split(' => ').pop().replace(/[{}]/g, '').trim(); // rename: post-image
    map.set(p.replace(/\\/g, '/'), {
      added: f[0] === '-' ? 0 : Number.parseInt(f[0], 10),
      deleted: f[1] === '-' ? 0 : Number.parseInt(f[1], 10),
    });
  }
  return map;
}

/** §7.1 line 320 + errata 2: the exact key set of a mode=diff reply. */
function mustDiffKeys(j, what) {
  const base = ['ok', 'pane_id', 'cwd', 'is_repo', 'repo', 'files', 'totals', 'truncated', 'file', 'diff', 'diff_available'];
  const want = (j.diff_available === false ? base.concat(['no_diff_reason']) : base).sort();
  must(JSON.stringify(Object.keys(j).sort()) === JSON.stringify(want),
    `${what}: keys are ${JSON.stringify(Object.keys(j).sort())}, §7.1 + errata 2 declares ${JSON.stringify(want)}`);
}

/** The rule §7.1's handler documents for picking which pass describes a row. */
function expectedCounts(row, unstaged, staged) {
  if (row.untracked) return { added: 0, deleted: 0 };
  const m = row.unstaged ? unstaged : staged;
  return (m && m.get(row.path)) || { added: 0, deleted: 0 };
}

/** Content hash of a directory tree, excluding .git (git itself may refresh it). */
function treeHash(dir) {
  const h = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (path.basename(p) === '.git') return '';
      return fs.readdirSync(p).sort().map((n) => `${n}:${h(path.join(p, n))}`).join('|');
    }
    return `${st.size}:${fs.readFileSync(p).toString('base64')}`;
  };
  return h(dir);
}

function readOnlyFingerprint() {
  return JSON.stringify({
    tree: treeHash(FIX),
    head: gitOk(['rev-parse', 'HEAD'], FIX).trim(),
    branch: gitOk(['rev-parse', '--abbrev-ref', 'HEAD'], FIX).trim(),
    staged: gitOk(['diff', '--cached', '--numstat', '-z'], FIX),
    stash: gitOk(['stash', 'list'], FIX).trim(),
    commits: gitOk(['rev-list', '--count', '--all'], FIX).trim(),
  });
}

// ---------------------------------------------------------------- static source checks

function readSource() {
  return fs.readFileSync(SERVER_SRC, 'utf8');
}

/** Pull the marked §7.1 whitelist table out of the handler's own source. */
function whitelistFromSource(src) {
  const m = src.match(/\/\* BEGIN §7\.1 SUBCOMMAND WHITELIST[^\n]*\*\/\n([\s\S]*?)\n\/\* END §7\.1 SUBCOMMAND WHITELIST \*\//);
  must(m, 'src/server.js has no marked §7.1 SUBCOMMAND WHITELIST block — the enumeration proof has nothing to read');
  // eslint-disable-next-line no-new-func
  const table = new Function(`${m[1]}\nreturn GIT_ARGV;`)();
  must(table && typeof table === 'object', 'the marked block did not evaluate to a GIT_ARGV table');
  return table;
}

function fileRowsFromSource(src) {
  const m = src.match(/const GIT_FILE_ROWS = new Set\(\[([^\]]*)\]\);/);
  must(m, 'src/server.js has no literal GIT_FILE_ROWS set');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
}

// The seven (here: nine rows, two of them the --cached diff variants) §7.1 lists,
// transcribed from CONTRACT-v2 §7.1. This is the contract side of the comparison.
const CONTRACT_ROWS = {
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

// Every subcommand git has that can change the repository, the index, the working
// tree or the stash. No row may contain any of these tokens.
const WRITE_SUBCOMMANDS = [
  'add', 'am', 'apply', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'config',
  'fetch', 'gc', 'init', 'merge', 'mv', 'prune', 'pull', 'push', 'rebase', 'reflog', 'remote',
  'reset', 'restore', 'revert', 'rm', 'stash', 'submodule', 'switch', 'tag', 'update-index',
  'update-ref', 'worktree', 'write-tree', 'hash-object', 'commit-tree', 'repack', 'filter-branch',
];
// The read-only verbs the table is allowed to use.
const READ_VERBS = new Set(['rev-parse', 'log', 'status', 'diff', 'ls-files']);

// ---------------------------------------------------------------- main

async function main() {
  console.log(`herdr-dash §7.1 git-view harness — git: ${GIT} — node ${process.version}`);
  console.log(`fixture: ${FIX}`);

  // ---- setup. An unbuildable fixture is a hard stop, not a cascade of FAILs.
  const version = git(['--version'], REPO_ROOT);
  if (version.error) {
    console.error(`FATAL: could not run "${GIT}": ${version.error.message}`);
    process.exit(1);
  }
  console.log(`oracle: ${version.stdout.trim()}\n`);

  buildFixture();
  buildEdge();
  buildEmpty();
  const nonRepo = pickNonRepo();
  notes.push(`not-a-repo cwd used: ${nonRepo.dir}`);

  const src = readSource();
  const table = whitelistFromSource(src);

  const mock = await startMockPipe([
    { pane_id: 'w1:fixture', cwd: FIX, agent: null, scroll: 0, revision: 4 },
    { pane_id: 'w1:edge', cwd: EDGE, agent: null, scroll: 0, revision: 4 },
    { pane_id: 'w1:empty', cwd: EMPTY, agent: null, scroll: 0, revision: 4 },
    { pane_id: 'w1:norepo', cwd: nonRepo.dir, agent: null, scroll: 0, revision: 4 },
    { pane_id: 'w1:ghost', cwd: GHOST, agent: null, scroll: 0, revision: 4 },
  ]);
  if (mock.error) {
    console.error(`FATAL: could not start the mock herdr pipe: ${mock.error}`);
    process.exit(1);
  }

  const spawned = await startServer(PORT, { HERDR_SOCKET_PATH: mock.name });
  console.log(`server: ${spawned.banner}\n`);

  const P = { pane_id: 'w1:fixture' };
  const before = readOnlyFingerprint();

  // ── Task 3: the whitelist, by enumeration ─────────────────────────────────
  await check('whitelist: the table is exactly the rows §7.1 lists', () => {
    const names = Object.keys(table).sort();
    const want = Object.keys(CONTRACT_ROWS).sort();
    must(JSON.stringify(names) === JSON.stringify(want),
      `rows differ\n  contract: ${want.join(', ')}\n  handler:  ${names.join(', ')}`);
    for (const k of want) {
      must(JSON.stringify(table[k]) === JSON.stringify(CONTRACT_ROWS[k]),
        `row "${k}" is ${JSON.stringify(table[k])}, §7.1 says ${JSON.stringify(CONTRACT_ROWS[k])}`);
    }
    return `${names.length} rows, each argument-for-argument equal to §7.1`;
  });

  await check('whitelist: no row holds a subcommand that can write', () => {
    const verbs = new Set(Object.values(table).map((row) => row[0]));
    for (const v of verbs) must(READ_VERBS.has(v), `row subcommand "${v}" is not one of the read-only verbs ${[...READ_VERBS].join('/')}`);
    for (const [name, row] of Object.entries(table)) {
      const hit = row.filter((tok) => WRITE_SUBCOMMANDS.includes(tok.replace(/^-+/, '')));
      must(hit.length === 0, `row "${name}" (${row.join(' ')}) contains write subcommand token(s) ${hit.join(', ')}`);
    }
    const verbsList = [...verbs].sort();
    console.log(`     reachable subcommands: ${verbsList.join(', ')} (${verbsList.length}; deny-list of ${WRITE_SUBCOMMANDS.length} write verbs all absent)`);
    return `subcommands spawnable by the handler: ${verbsList.join(', ')}`;
  });

  await check('whitelist: only the two diff rows can take a caller path', () => {
    const rows = fileRowsFromSource(src);
    must(JSON.stringify(rows) === JSON.stringify(['diffFile', 'diffFileCached']),
      `GIT_FILE_ROWS is ${JSON.stringify(rows)}, expected the two diff rows`);
    for (const k of rows) must(table[k], `GIT_FILE_ROWS names "${k}", which is not a whitelist row`);
    for (const k of rows) must(table[k][table[k].length - 1] === '--', `row "${k}" takes a path but does not end in -- : ${JSON.stringify(table[k])}`);
    return `path-taking rows: ${rows.join(', ')} — both end in --, so the path is a pathspec, not an option`;
  });

  await check('no shell: the source never builds a command string', () => {
    const banned = [/shell\s*:\s*true/, /\bexecSync\s*\(/, /\bexecFileSync\s*\(/, /\bchild_process\.exec\s*\(/, /\bcp\.exec\s*\(/, /\bspawnSync\s*\(/];
    for (const re of banned) must(!re.test(src), `src/server.js matches ${re} — a command string could be built`);
    must(!/\bshell\s*:\s*(?!false)/.test(src.replace(/shell\s*:\s*false/g, '')), 'src/server.js spawns without shell:false');
    const spawnCalls = (src.match(/cp\.spawn\(/g) || []).length;
    const gitRuns = (src.match(/runProc\(GIT_BIN/g) || []).length;
    must(spawnCalls === 1, `expected exactly one cp.spawn call, found ${spawnCalls}`);
    must(gitRuns === 1, `expected exactly one runProc(GIT_BIN …) call, found ${gitRuns}`);
    return `1 cp.spawn(shell:false) for the whole server; git is run from 1 place`;
  });

  // ── Task 1/2: parameter rejection ─────────────────────────────────────────
  await check('reject: /api/git without pane_id', async () => {
    const r = await apiGit({});
    must(r.status === 200, `HTTP ${r.status} — every JSON reply is 200 in this API`);
    must(r.json.ok === false && r.json.error.code === 'bad_request', `got ${JSON.stringify(r.json).slice(0, 200)}`);
    return 'bad_request';
  });

  await check('reject: unknown pane -> pane_not_found', async () => {
    const r = await apiGit({ pane_id: 'w1:no-such-pane' });
    must(r.json.ok === false && r.json.error.code === 'pane_not_found', `got ${JSON.stringify(r.json).slice(0, 200)}`);
    return `pane_not_found (${r.json.error.message})`;
  });

  await check('reject: mode=commit and other write modes -> bad_request', async () => {
    const modes = ['commit', 'checkout', 'push', 'add', 'reset', 'stash', 'clean', 'apply', 'rm', 'mv', 'branch', 'clone', 'pull', 'fetch', 'rebase', 'init'];
    const seen = [];
    for (const m of modes) {
      const r = await apiGit(Object.assign({ mode: m }, P));
      must(r.json.ok === false && r.json.error.code === 'bad_request',
        `mode=${m} was not refused: ${JSON.stringify(r.json).slice(0, 200)}`);
      seen.push(m);
    }
    return `${seen.length} write modes refused: ${seen.join(', ')}`;
  });

  await check('reject: mode cannot smuggle a shell or a second argument', async () => {
    const modes = ['status; commit -m x', 'status && rm -rf /', 'status|commit', 'diff --cached', 'STATUS', ' status', '', 'commit\n'];
    const seen = [];
    for (const m of modes) {
      const r = await apiGit(Object.assign({ mode: m }, P));
      must(r.json.ok === false && r.json.error.code === 'bad_request',
        `mode=${JSON.stringify(m)} was not refused: ${JSON.stringify(r.json).slice(0, 200)}`);
      seen.push(JSON.stringify(m));
    }
    return `${seen.length} malformed modes refused: ${seen.join(', ')}`;
  });

  await check('reject: absolute and .. paths in file -> bad_request', async () => {
    const bad = ['../../etc/passwd', '..\\..\\windows\\win.ini', '/etc/passwd', 'C:/Windows/win.ini', 'c:\\Windows\\win.ini',
      '\\\\server\\share\\file', '//server/share/file', 'sub/../../escape.txt', 'sub\\..\\..\\escape.txt', 'a/../../b'];
    const seen = [];
    for (const f of bad) {
      const r = await apiGit(Object.assign({ mode: 'diff', file: f }, P));
      must(r.json.ok === false && r.json.error.code === 'bad_request',
        `file=${JSON.stringify(f)} was not refused: ${JSON.stringify(r.json).slice(0, 240)}`);
      seen.push(JSON.stringify(f));
    }
    return `${seen.length} paths refused: ${seen.join(', ')}`;
  });

  await check('reject: mode=diff without file, and file without mode=diff', async () => {
    const a = await apiGit(Object.assign({ mode: 'diff' }, P));
    must(a.json.ok === false && a.json.error.code === 'bad_request', `mode=diff with no file: ${JSON.stringify(a.json).slice(0, 200)}`);
    const b = await apiGit(Object.assign({ file: 'worktree.txt' }, P));   // default mode=status
    must(b.json.ok === false && b.json.error.code === 'bad_request', `file with mode=status: ${JSON.stringify(b.json).slice(0, 200)}`);
    const c = await apiGit(Object.assign({ mode: 'diff', file: '' }, P));
    must(c.json.ok === false && c.json.error.code === 'bad_request', `empty file: ${JSON.stringify(c.json).slice(0, 200)}`);
    return 'bad_request in all three shapes';
  });

  // ── Task 2: the fixture, asserted against git's own output ────────────────
  const statusReply = await apiGit(P);
  const body = statusReply.json;

  await check('status: repo identity matches git itself', async () => {
    must(body.ok === true && body.is_repo === true, `ok=${body.ok} is_repo=${body.is_repo}: ${JSON.stringify(body).slice(0, 240)}`);
    must(body.pane_id === 'w1:fixture', `pane_id ${body.pane_id}`);
    must(path.resolve(body.cwd) === path.resolve(FIX), `cwd ${body.cwd} != ${FIX}`);
    const top = gitOk(['rev-parse', '--show-toplevel'], FIX).trim();
    must(path.resolve(body.repo.toplevel) === path.resolve(top), `toplevel ${body.repo.toplevel} != git's ${top}`);
    const br = gitOk(['rev-parse', '--abbrev-ref', 'HEAD'], FIX).trim();
    must(body.repo.branch === br, `branch ${body.repo.branch} != git's ${br}`);
    const head = gitOk(['log', '-1', '--format=%h %s'], FIX).trim();
    must(body.repo.head === head, `head ${JSON.stringify(body.repo.head)} != git's ${JSON.stringify(head)}`);
    return `toplevel/branch/head all equal git's own answers (${br}, ${head})`;
  });

  await check('status: files[] is exactly git status --porcelain', () => {
    const expected = porcelainRows().map((r) => r.path);
    const got = body.files.map((f) => f.path);
    must(expected.length > 0, 'the fixture produced no changes — the harness built nothing to compare');
    must(JSON.stringify(got) === JSON.stringify(expected),
      `paths differ\n  git:    ${JSON.stringify(expected)}\n  server: ${JSON.stringify(got)}`);
    return `${got.length} rows, same set and order as git: ${got.join(', ')}`;
  });

  await check('status: per-row status letters + staged/unstaged/untracked match git', () => {
    const byPath = new Map(body.files.map((f) => [f.path, f]));
    const rows = porcelainRows();
    for (const row of rows) {
      const f = byPath.get(row.path);
      must(f, `git reported ${row.path}, the endpoint did not`);
      const wantLetter = row.untracked ? '?' : (row.xy[0] !== ' ' ? row.xy[0] : row.xy[1]);
      must(f.status === wantLetter, `${row.path}: status ${JSON.stringify(f.status)}, git says ${JSON.stringify(wantLetter)} (XY=${JSON.stringify(row.xy)})`);
      must(f.untracked === row.untracked, `${row.path}: untracked ${f.untracked}, git says ${row.untracked}`);
      must(f.staged === row.staged, `${row.path}: staged ${f.staged}, git says ${row.staged} (XY=${JSON.stringify(row.xy)})`);
      must(f.unstaged === row.unstaged, `${row.path}: unstaged ${f.unstaged}, git says ${row.unstaged} (XY=${JSON.stringify(row.xy)})`);
    }
    must(body.files.length === rows.length, `endpoint listed ${body.files.length} rows, git listed ${rows.length}`);
    return `${rows.length} rows agree on XY, staged, unstaged and untracked`;
  });

  await check('status: staged/unstaged/untracked are one badge per row', () => {
    // The invariant that makes the untracked-is-neither reading the right one:
    // every row is described, no row is described twice. (§7.1 leaves this open.)
    for (const f of body.files) {
      must(!(f.untracked && (f.staged || f.unstaged)), `${f.path}: untracked rows must not also be staged/unstaged (${JSON.stringify(f)})`);
      if (!f.untracked) must(f.staged || f.unstaged, `${f.path}: a tracked row with no side marked (${JSON.stringify(f)})`);
    }
    const untracked = body.files.filter((f) => f.untracked).length;
    must(body.totals.untracked === untracked, `totals.untracked ${body.totals.untracked} != ${untracked} untracked rows`);
    const doubleBadged = body.files.filter((f) => f.staged && f.unstaged).map((f) => f.path);
    return `each of ${body.files.length} rows has exactly the badges git's XY implies${doubleBadged.length ? ` (both sides changed: ${doubleBadged.join(', ')})` : ''}`;
  });

  await check('status: added/deleted come from git diff --numstat (both passes)', () => {
    const unstaged = numstatMap(['diff', '--numstat']);
    const staged = numstatMap(['diff', '--cached', '--numstat']);
    const byPath = new Map(body.files.map((f) => [f.path, f]));
    const shown = [];
    for (const row of porcelainRows()) {
      const want = expectedCounts(row, unstaged, staged);
      const f = byPath.get(row.path);
      must(f, `no endpoint row for ${row.path}`);
      must(f.added === want.added && f.deleted === want.deleted,
        `${row.path}: endpoint ${f.added}/${f.deleted}, git ${want.added}/${want.deleted} (XY=${JSON.stringify(row.xy)})`);
      if (want.added || want.deleted) shown.push(`${row.path} +${want.added}/-${want.deleted}`);
    }
    return `line counts equal git's numstat: ${shown.join(', ')}`;
  });

  await check('status: totals add up to the rows git reported', () => {
    const rows = porcelainRows();
    const unstaged = numstatMap(['diff', '--numstat']);
    const staged = numstatMap(['diff', '--cached', '--numstat']);
    const sums = rows.reduce((acc, row) => {
      const c = expectedCounts(row, unstaged, staged);
      acc.changed++;
      if (row.staged) acc.staged++;
      if (row.unstaged) acc.unstaged++;
      if (row.untracked) acc.untracked++;
      acc.insertions += c.added;
      acc.deletions += c.deleted;
      return acc;
    }, { changed: 0, staged: 0, unstaged: 0, untracked: 0, insertions: 0, deletions: 0 });
    for (const k of Object.keys(sums)) {
      must(body.totals[k] === sums[k], `totals.${k} is ${body.totals[k]}, git's own rows sum to ${sums[k]}`);
    }
    return JSON.stringify(sums);
  });

  await check('status: paths are repo-relative, sorted, and ignore .gitignore matches', () => {
    const paths = body.files.map((f) => f.path);
    for (const p of paths) {
      must(!p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.includes('\\') && !p.split('/').includes('..'),
        `path is not repo-relative: ${p}`);
    }
    const sorted = [...paths].sort();
    must(JSON.stringify(paths) === JSON.stringify(sorted), `paths are not sorted: ${JSON.stringify(paths)}`);
    must(paths.includes('sub/deep.txt'), `nested path missing; got ${JSON.stringify(paths)}`);
    must(!paths.includes('ignored.txt'), 'an ignored file appeared in files[] — --exclude-standard is not in effect');
    must(!paths.some((p) => p === 'old.txt' || p === 'deleted.txt' && false), 'rename pre-image leaked');
    must(!paths.includes('.gitignore'), '.gitignore should be committed and unchanged');
    must(body.truncated === false, `truncated=${body.truncated} on a small status`);
    return `${paths.length} repo-relative sorted paths, ignored file absent, rename pre-image absent`;
  });

  await check('status: an untracked file carries no line counts', () => {
    const f = body.files.find((x) => x.path === 'untracked.txt');
    must(f, 'untracked.txt is missing from files[]');
    must(f.untracked === true && f.status === '?', `untracked.txt row: ${JSON.stringify(f)}`);
    must(f.added === 0 && f.deleted === 0, `untracked.txt counts ${f.added}/${f.deleted}, expected 0/0 (no diff row in the whitelist covers it)`);
    return 'untracked.txt is ?? with 0/0, as documented';
  });

  // ── Task 2: diff mode ────────────────────────────────────────────────────
  await check('diff: an unstaged file is byte-identical to git diff (nested path too)', async () => {
    const cases = ['worktree.txt', 'sub/deep.txt'];
    const sizes = [];
    for (const file of cases) {
      const r = await apiGit(Object.assign({ mode: 'diff', file }, P));
      must(r.json.ok === true, `${file}: ${JSON.stringify(r.json).slice(0, 240)}`);
      must(r.json.file === file, `${file}: file=${r.json.file}`);
      must(r.json.diff_available === true, `${file}: diff_available=${JSON.stringify(r.json.diff_available)} for a tracked dirty file`);
      must(!('no_diff_reason' in r.json), `${file}: no_diff_reason must be absent when the diff is available`);
      mustDiffKeys(r.json, file);
      const want = gitOk(['diff', '--no-color', '--unified=3', '--', file], FIX);
      must(r.json.diff === want, `${file}: diff text differs from git's own stdout\n--- endpoint ---\n${JSON.stringify(r.json.diff).slice(0, 300)}\n--- git ---\n${JSON.stringify(want).slice(0, 300)}`);
      must(r.json.truncated === false, `${file}: truncated=${r.json.truncated} on a short diff`);
      sizes.push(`${file} ${want.split('\n').length - 1} lines`);
    }
    return `byte-equal to git: ${sizes.join(', ')}`;
  });

  await check('diff: a staged file returns the --cached diff, byte for byte', async () => {
    const r = await apiGit(Object.assign({ mode: 'diff', file: 'staged.txt' }, P));
    must(r.json.ok === true, JSON.stringify(r.json).slice(0, 240));
    const want = gitOk(['diff', '--cached', '--no-color', '--unified=3', '--', 'staged.txt'], FIX);
    must(r.json.diff === want, `the cached diff differs from git's own\n--- endpoint ---\n${JSON.stringify(r.json.diff).slice(0, 300)}\n--- git ---\n${JSON.stringify(want).slice(0, 300)}`);
    return `${want.split('\n').length - 1} lines, equal to git diff --cached`;
  });

  await check('diff: an untracked file is an empty diff WITH a reason (§7.1 errata 2)', async () => {
    const r = await apiGit(Object.assign({ mode: 'diff', file: 'untracked.txt' }, P));
    must(r.json.ok === true, JSON.stringify(r.json).slice(0, 240));
    must(r.json.diff === '', `expected an empty diff, got ${JSON.stringify(r.json.diff).slice(0, 200)}`);
    must(r.json.truncated === false, `truncated=${r.json.truncated}`);
    must(r.json.diff_available === false, `diff_available=${JSON.stringify(r.json.diff_available)} for an untracked file`);
    must(r.json.no_diff_reason === 'untracked', `no_diff_reason=${JSON.stringify(r.json.no_diff_reason)}, expected "untracked"`);
    mustDiffKeys(r.json, 'untracked.txt');
    // and the other side of the same rule: a tracked dirty file says true and
    // carries no reason at all.
    const dirty = await apiGit(Object.assign({ mode: 'diff', file: 'worktree.txt' }, P));
    must(dirty.json.diff_available === true && !('no_diff_reason' in dirty.json),
      `a tracked dirty file reported ${JSON.stringify(dirty.json.diff_available)} / ${JSON.stringify(dirty.json.no_diff_reason)}`);
    return `untracked -> false + "untracked"; tracked dirty -> true + no reason key`;
  });

  await check('diff: the no_change token covers git\'s own "nothing to show" states', async () => {
    // Four shapes that all reach the same bucket, each asserted separately. The
    // frozen whitelist cannot tell them apart: an ignored path, one that does not
    // exist, a clean tracked file, and a directory with no changes all reach
    // `git diff -- <path>` as a pathspec that matches nothing.
    const cases = [
      { file: 'ignored.txt', what: 'an ignored path (.gitignore\'d)' },
      { file: 'no-such-file-xyz.txt', what: 'a path that does not exist' },
      { file: 'clean.txt', what: 'a clean tracked file' },
      { file: 'sub/nothing-changed-here', what: 'a path under a real directory' },
    ];
    const seen = [];
    for (const c of cases) {
      const r = await apiGit(Object.assign({ mode: 'diff', file: c.file }, P));
      must(r.json.ok === true, `${c.what}: ${JSON.stringify(r.json).slice(0, 200)}`);
      must(r.json.diff === '', `${c.what}: expected "", got ${JSON.stringify(r.json.diff).slice(0, 120)}`);
      must(r.json.truncated === false, `${c.what}: truncated=${r.json.truncated}`);
      must(r.json.diff_available === false, `${c.what}: diff_available=${JSON.stringify(r.json.diff_available)}`);
      must(r.json.no_diff_reason === 'no_change', `${c.what}: no_diff_reason=${JSON.stringify(r.json.no_diff_reason)}, expected "no_change"`);
      mustDiffKeys(r.json, c.file);
      seen.push(c.what);
    }
    notes.push('ignored / nonexistent / clean / no-change-dir all report no_change: telling them apart needs a subcommand outside the frozen whitelist (check-ignore, plain ls-files) or a stat outside git');
    return `${seen.length} no-diff states all report no_change: ${seen.join('; ')}`;
  });

  await check('diff: a binary file is NOT an empty-diff case (so no `binary` token is reachable)', async () => {
    const want = gitOk(['diff', '--no-color', '--unified=3', '--', 'binary.bin'], FIX);
    must(want.length > 0, 'the fixture binary has no diff to compare against');
    const r = await apiGit(Object.assign({ mode: 'diff', file: 'binary.bin' }, P));
    must(r.json.ok === true, JSON.stringify(r.json).slice(0, 240));
    must(r.json.diff === want, `binary diff differs from git's own\n  endpoint: ${JSON.stringify(r.json.diff).slice(0, 160)}\n  git:      ${JSON.stringify(want).slice(0, 160)}`);
    must(r.json.diff_available === true, `diff_available=${JSON.stringify(r.json.diff_available)} — git does emit a line for a binary file`);
    must(r.json.diff.includes('Binary files'), `git's binary notice vanished from the diff: ${JSON.stringify(r.json.diff.slice(0, 120))}`);
    // numstat reports a binary file as `-`/`-`; §7.1's schema has no binary flag,
    // so the row counts 0 — that is the documented reading, asserted here so the
    // two facts (non-empty diff, zero counts) cannot drift apart silently.
    const row = body.files.find((f) => f.path === 'binary.bin');
    must(row && row.added === 0 && row.deleted === 0, `binary row counts are ${row && row.added}/${row && row.deleted}, expected 0/0 (§7.1 has no binary flag)`);
    return `git's own ${want.length}-byte "${want.split('\n')[0].trim()}" is returned verbatim with diff_available true`;
  });

  await check('diff: a staged delete + untracked file of the same name is not reported empty', async () => {
    // git reports TWO rows for this path, the preferred pass is the empty one, and
    // before errata 2 this answered `diff:""` while git held a real deletion.
    const edge = { pane_id: 'w1:edge' };
    const status = await apiGit(edge);
    must(status.json.ok === true && status.json.is_repo === true, `edge fixture: ${JSON.stringify(status.json).slice(0, 200)}`);
    const rows = status.json.files.filter((f) => f.path === 'twice.txt');
    must(rows.length === 2, `expected two rows for twice.txt (a staged delete and an untracked file), got ${JSON.stringify(status.json.files.map((f) => `${f.path}=${f.status}`))}`);
    must(rows.some((f) => f.untracked) && rows.some((f) => f.staged), `the two rows are ${JSON.stringify(rows)}`);

    const want = gitOk(['diff', '--cached', '--no-color', '--unified=3', '--', 'twice.txt'], EDGE);
    must(want.length > 0, 'the edge fixture has no staged deletion to return');
    const r = await apiGit(Object.assign({ mode: 'diff', file: 'twice.txt' }, edge));
    must(r.json.ok === true, JSON.stringify(r.json).slice(0, 240));
    must(r.json.diff_available === true, `diff_available=${JSON.stringify(r.json.diff_available)} — git holds a real deletion for this path`);
    must(r.json.diff === want, `expected git's own staged deletion\n  endpoint: ${JSON.stringify(r.json.diff).slice(0, 200)}\n  git:      ${JSON.stringify(want).slice(0, 200)}`);
    mustDiffKeys(r.json, 'twice.txt (edge)');

    // The ordinary file in the same repo still behaves normally.
    const plain = await apiGit(Object.assign({ mode: 'diff', file: 'plain.txt' }, edge));
    must(plain.json.diff_available === true && plain.json.diff === gitOk(['diff', '--no-color', '--unified=3', '--', 'plain.txt'], EDGE),
      `plain.txt in the edge fixture: ${JSON.stringify(plain.json).slice(0, 200)}`);
    notes.push(`staged-delete + untracked (same name) was an empty diff before this round: git holds ${want.length} bytes staged, ${gitOk(['diff', '--no-color', '--unified=3', '--', 'twice.txt'], EDGE).length} bytes unstaged`);
    return `two rows for one path, and the ${want.length}-byte staged deletion is returned with diff_available true`;
  });

  await check('diff: max_lines clamps to 1..2000 and truncated is honest', async () => {
    const full = gitOk(['diff', '--no-color', '--unified=3', '--', 'big.txt'], FIX);
    const fullLines = full.split('\n').length - 1;
    must(fullLines > 2000, `big.txt produced only ${fullLines} diff lines — the cap cannot be exercised`);

    const cases = [
      { q: {}, want: 400, why: 'default' },
      { q: { max_lines: '2000' }, want: 2000, why: 'cap' },
      { q: { max_lines: '99999' }, want: 2000, why: 'clamped down to the cap' },
      { q: { max_lines: '1' }, want: 1, why: 'minimum' },
      { q: { max_lines: '0' }, want: 1, why: '0 clamped up to 1' },
      { q: { max_lines: 'junk' }, want: 400, why: 'unparsable -> default' },
      { q: { max_lines: '-5' }, want: 1, why: 'negative clamped up to 1' },
    ];
    const seen = [];
    for (const c of cases) {
      const r = await apiGit(Object.assign({ mode: 'diff', file: 'big.txt' }, c.q, P));
      must(r.json.ok === true, `${c.why}: ${JSON.stringify(r.json).slice(0, 240)}`);
      const lines = r.json.diff.split('\n').length - 1;
      must(lines === c.want, `${c.why} (max_lines=${JSON.stringify(c.q.max_lines)}): ${lines} lines, expected ${c.want}`);
      must(r.json.truncated === true, `${c.why}: truncated=${r.json.truncated} (git's own diff is ${fullLines} lines)`);
      must(full.startsWith(r.json.diff), `${c.why}: the returned diff is not a prefix of git's own diff`);
      seen.push(`${c.why}=${lines}`);
    }

    // ...and the same file with enough room is complete, with truncated false.
    const spec = { mode: 'diff', file: 'worktree.txt' };
    const small = await apiGit(Object.assign({}, spec, P));
    must(small.json.truncated === false && small.json.diff.length > 0, 'a short diff must be complete and untruncated');
    notes.push(`big.txt: git's own diff is ${fullLines} lines (checked as a prefix in all ${cases.length} clamped cases)`);
    return `${seen.join(', ')} — all prefixes of git's ${fullLines}-line diff`;
  });

  await check('diff: a flag-shaped path is a pathspec, not a flag', async () => {
    // `file=--cached` must NOT turn into a cached diff: after the row's `--` it is
    // a path git does not have, so the answer is an empty diff.
    const r = await apiGit(Object.assign({ mode: 'diff', file: '--cached' }, P));
    must(r.json.ok === true, `file=--cached was refused instead of treated as a path: ${JSON.stringify(r.json).slice(0, 240)}`);
    must(r.json.diff === '', `file=--cached produced a diff (${JSON.stringify(r.json.diff).slice(0, 200)}) — the path escaped its --`);
    const cached = gitOk(['diff', '--cached', '--no-color', '--unified=3', '--'], FIX);
    must(cached.length > 0, 'the fixture has no staged change — this check would pass vacuously');
    must(r.json.diff !== cached, 'file=--cached returned the cached diff — the path was read as an option');
    return `"${r.json.file}" -> empty diff (git's cached diff is ${cached.split('\n').length - 1} lines and was NOT returned)`;
  });

  // ── Task 2: the other cwd states ─────────────────────────────────────────
  await check('not-a-repo: is_repo false, with git\'s own stderr as the message', async () => {
    const r = await apiGit({ pane_id: 'w1:norepo' });
    must(r.json.ok === true, `ok=${r.json.ok}: ${JSON.stringify(r.json).slice(0, 240)}`);
    must(r.json.is_repo === false, `is_repo=${r.json.is_repo} for ${nonRepo.dir}`);
    must(r.json.error && r.json.error.code === 'not_a_repo', `error=${JSON.stringify(r.json.error)}`);
    must(r.json.error.message === nonRepo.stderr,
      `message is ${JSON.stringify(r.json.error.message)}, git's stderr was ${JSON.stringify(nonRepo.stderr)}`);
    must(Array.isArray(r.json.files) && r.json.files.length === 0, `files should be empty, got ${JSON.stringify(r.json.files)}`);
    return `not_a_repo, message === git's stderr (${JSON.stringify(nonRepo.stderr.slice(0, 60))}…)`;
  });

  await check('empty repo: is_repo true, branch/head null, no error', async () => {
    const r = await apiGit({ pane_id: 'w1:empty' });
    must(r.json.ok === true && r.json.is_repo === true, `ok=${r.json.ok} is_repo=${r.json.is_repo}: ${JSON.stringify(r.json).slice(0, 240)}`);
    must(r.json.repo && r.json.repo.branch === null && r.json.repo.head === null,
      `a repo with no commits must report null branch/head, got ${JSON.stringify(r.json.repo)}`);
    must(path.resolve(r.json.repo.toplevel) === path.resolve(gitOk(['rev-parse', '--show-toplevel'], EMPTY).trim()), 'toplevel mismatch');
    must(r.json.files.length === 0 && r.json.totals.changed === 0, `files should be empty, got ${JSON.stringify(r.json.files)}`);
    must(!r.json.error, `an empty repo is a state, not an error: ${JSON.stringify(r.json.error)}`);
    return 'is_repo true, branch/head null (git exits 128 there), files [] and no error';
  });

  await check('missing cwd: git_failed naming the cwd, not a 500', async () => {
    const r = await apiGit({ pane_id: 'w1:ghost' });
    must(r.json.ok === false, `ok=${r.json.ok}: ${JSON.stringify(r.json).slice(0, 240)}`);
    must(r.json.error.code === 'git_failed', `error.code=${r.json.error.code} (a vanished cwd must not be reported as git_missing)`);
    must(r.json.error.message.includes(GHOST), `message does not name the cwd: ${r.json.error.message}`);
    return `git_failed: ${r.json.error.message}`;
  });

  await check('described state: a git failure still carries is_repo:false for the banner', async () => {
    // §7.1 line 323 + §7.2 line 341: the client renders the same banner it shows
    // for a non-repo cwd, so is_repo, cwd and error.message must all be present.
    const bogus = path.join(SCRATCH, 'no-such-git-binary-xyz');
    const extra = await startServer(EXTRA_PORT, { HERDR_SOCKET_PATH: mock.name, GIT_BIN_PATH: bogus });
    try {
      const r = await apiGit(Object.assign({ pane_id: 'w1:empty' }, P), { base: `http://127.0.0.1:${EXTRA_PORT}` });
      must(r.json.ok === false, `expected a failure reply, got ${JSON.stringify(r.json).slice(0, 200)}`);
      must(r.json.error.code === 'git_missing', `error.code=${r.json.error.code}`);
      must(r.json.is_repo === false, `is_repo is ${JSON.stringify(r.json.is_repo)}, §7.1 line 323 says false`);
      must(r.json.pane_id === 'w1:fixture' && typeof r.json.cwd === 'string', 'the banner needs pane_id and cwd');
      must(Array.isArray(r.json.files) && r.json.files.length === 0, 'files must be [] — "never an empty list" is about the message, not the array');
      must(typeof r.json.error.message === 'string' && r.json.error.message.length > 0, 'the banner needs error.message');
      return `git_missing carries is_repo:false, pane_id, cwd, files:[] and a message`;
    } finally {
      killChild(extra.proc);
      children.splice(children.indexOf(extra.proc), 1);
      await new Promise((r) => setTimeout(r, 400));
    }
  });

  await check('status: no repo query is ever run outside the pane cwd (cwd is herdr\'s)', async () => {
    // The endpoint is told the directory only through the mock snapshot; a client
    // that passes a path in `file` cannot move it. Prove it by asking for a file
    // that exists in the repo root but under a different pane's repo — the answer
    // must be the fixture's own content, and a path that only exists in the OTHER
    // directory must yield an empty diff, never the other repo's data.
    rmrf(path.join(EMPTY, 'only-in-empty.txt'));
    writeLF(path.join(EMPTY, 'only-in-empty.txt'), 'secret from another cwd\n');
    const r = await apiGit(Object.assign({ mode: 'diff', file: 'only-in-empty.txt' }, P));
    must(r.json.ok === true, JSON.stringify(r.json).slice(0, 240));
    must(r.json.diff === '', `the endpoint read a file outside the pane's cwd: ${JSON.stringify(r.json.diff).slice(0, 200)}`);
    must(path.resolve(r.json.cwd) === path.resolve(FIX), `cwd moved to ${r.json.cwd}`);
    return 'a path belonging to another pane\'s directory yields an empty diff; cwd stayed the fixture';
  });

  // ── read-only, proved behaviourally ──────────────────────────────────────
  await check('read-only: every call above left the repository untouched', () => {
    const after = readOnlyFingerprint();
    if (after !== before) {
      const a = JSON.parse(before);
      const b = JSON.parse(after);
      const changed = Object.keys(a).filter((k) => a[k] !== b[k]);
      throw new Fail(`the endpoint changed the repository: ${changed.join(', ')} differ after ${results.length} calls`);
    }
    return 'working tree hash, HEAD, branch, staged content, stash list and commit count are unchanged';
  });

  await check('git_missing: a missing git binary is reported, not crashed on', async () => {
    const bogus = path.join(SCRATCH, 'no-such-git-binary-xyz');
    const extra = await startServer(EXTRA_PORT, { HERDR_SOCKET_PATH: mock.name, GIT_BIN_PATH: bogus });
    try {
      const r = await apiGit(P, { base: `http://127.0.0.1:${EXTRA_PORT}` });
      must(r.status === 200, `HTTP ${r.status}`);
      must(r.json.ok === false && r.json.error.code === 'git_missing', `got ${JSON.stringify(r.json).slice(0, 240)}`);
      return `git_missing (${extra.banner ? 'server up on ' + EXTRA_PORT : ''}): ${r.json.error.message}`;
    } finally {
      killChild(extra.proc);
      children.splice(children.indexOf(extra.proc), 1);
      await new Promise((r) => setTimeout(r, 400));
    }
  });

  await check('git_failed: a git that cannot be executed is reported distinctly', async () => {
    // GIT_BIN_PATH pointing at a DIRECTORY: spawn fails with something other than
    // ENOENT, which must land on git_failed rather than being called "missing".
    const extra = await startServer(EXTRA_PORT, { HERDR_SOCKET_PATH: mock.name, GIT_BIN_PATH: SCRATCH });
    try {
      const r = await apiGit(P, { base: `http://127.0.0.1:${EXTRA_PORT}` });
      must(r.json.ok === false, `expected a failure, got ${JSON.stringify(r.json).slice(0, 240)}`);
      must(r.json.error.code === 'git_failed', `error.code=${r.json.error.code}: ${JSON.stringify(r.json.error).slice(0, 200)}`);
      return `git_failed: ${r.json.error.message}`;
    } finally {
      killChild(extra.proc);
      children.splice(children.indexOf(extra.proc), 1);
      await new Promise((r) => setTimeout(r, 400));
    }
  });

  if (DUMP) {
    console.log('\n--- raw GET /api/git?pane_id=w1:fixture ---');
    console.log(JSON.stringify(body, null, 2));
    const one = await apiGit(Object.assign({ mode: 'diff', file: 'worktree.txt' }, P));
    console.log('--- raw GET /api/git?pane_id=w1:fixture&mode=diff&file=worktree.txt ---');
    console.log(JSON.stringify(one.json, null, 2));
  }

  // ── cleanup, then prove the ports are ours to give back ──────────────────
  await mock.close();
  killAll();
  await check('cleanup: the test ports are free again', async () => {
    // A closed socket does not leave LISTENING instantly on Windows, so give the
    // ports a few seconds to come back before calling it a leak.
    const deadline = Date.now() + 8000;
    let busy = [];
    do {
      await new Promise((r) => setTimeout(r, 400));
      busy = [];
      for (const p of [PORT, EXTRA_PORT]) if (await listening(p)) busy.push(p);
    } while (busy.length && Date.now() < deadline);
    must(busy.length === 0, `still listening on ${busy.join(', ')} after 8s`);
    return `${PORT} and ${EXTRA_PORT} both free`;
  });

  // ---------------------------------------------------------------- report
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log('');
  for (const n of notes) console.log(`NOTE ${n}`);
  if (passed !== total) {
    console.log('FAILURES:');
    for (const r of results.filter((x) => !x.passed)) console.log(`  - ${r.name}: ${r.detail}`);
  }
  console.log(`TOTAL: ${passed}/${total} passed`);
  return passed === total ? 0 : 1;
}

main().then((code) => {
  killAll();
  process.exit(code);
}).catch((e) => {
  killAll();
  console.error(`\nFATAL: ${(e && e.stack) || e}`);
  process.exit(1);
});
