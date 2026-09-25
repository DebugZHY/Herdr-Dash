#!/usr/bin/env node
// herdr-dash acceptance harness — owner: W3.
//
// Zero dependencies (node:http / node:fs / node:path / node:child_process only).
// READ-ONLY against herdr: this script never prompts a real agent, never closes a pane
// and never renames anything. The only side effect is starting and stopping its own
// child `node src/server.js`.
//
// Usage:
//   node test/acceptance.mjs [--port 7456] [--base http://127.0.0.1:7456] [--no-spawn]
//
//   default    spawn `node src/server.js --port <port>` from the repo root, wait for it,
//              test it, then kill it (also on failure).
//   --no-spawn test an already-running server at --base instead.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------- paths & args

const HERE = (() => {
  if (import.meta.dirname) return import.meta.dirname;
  const p = decodeURIComponent(new URL('.', import.meta.url).pathname);
  return process.platform === 'win32' && /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
})();
const REPO_ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const PORT = Number(flagValue('--port', '7456'));
const NO_SPAWN = argv.includes('--no-spawn');
const BASE = flagValue('--base', `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const SPAWN_WAIT_MS = 15000;
const SSE_WAIT_MS = 8000;

// ---------------------------------------------------------------- check runner

class Fail extends Error {}
const must = (cond, msg) => { if (!cond) throw new Fail(msg); };

const results = [];
let child = null;

async function check(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = await fn();
    if (r && typeof r === 'object' && 'ok' in r) {
      ok = !!r.ok;
      detail = r.detail || '';
    } else {
      ok = r !== false;
    }
  } catch (e) {
    ok = false;
    detail = e instanceof Fail ? e.message : `unexpected ${e && e.name ? e.name : 'error'}: ${e && e.message ? e.message : String(e)}`;
  }
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
  return ok;
}

// ---------------------------------------------------------------- http helpers

function request(method, url, { body = null, headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ error: `bad url ${url}: ${e.message}` }); }
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const opt = {
      method,
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: { ...headers },
    };
    if (payload != null) {
      opt.headers['content-type'] = opt.headers['content-type'] || 'application/json';
      opt.headers['content-length'] = Buffer.byteLength(payload);
    }
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request(opt, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json — leave null */ }
        finish({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', (e) => finish({ error: `response error: ${e.message}` }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ error: `timed out after ${timeoutMs}ms` });
    });
    req.on('error', (e) => finish({ error: `${e.code || 'network error'}: ${e.message}` }));
    if (payload != null) req.write(payload);
    req.end();
  });
}

const GET = (p, o) => request('GET', BASE + p, o);
const POST = (p, body, o) => request('POST', BASE + p, { body, ...o });

// Fails the enclosing check with a readable detail if the transport itself broke.
function reachable(r, what) {
  if (r.error) throw new Fail(`could not reach server for ${what} — ${r.error}`);
  return r;
}
function needJson(r, what) {
  reachable(r, what);
  if (r.json == null) throw new Fail(`${what}: response was not JSON (HTTP ${r.status}): ${(r.text || '').slice(0, 160)}`);
  return r.json;
}

// ---------------------------------------------------------------- SSE probe

function sseProbe(url, waitMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ error: `bad url: ${e.message}` }); }
    let settled = false;
    let timer = null;
    let frameCount = 0;
    let sawDashEvent = false;
    let sample = '';
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { req.destroy(); } catch { /* already gone */ }
      resolve(v);
    };
    const req = http.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: { accept: 'text/event-stream', 'cache-control': 'no-cache' },
    }, (res) => {
      if (res.statusCode !== 200) return finish({ error: `HTTP ${res.statusCode}` });
      const ct = String(res.headers['content-type'] || '');
      if (!ct.includes('text/event-stream')) return finish({ error: `content-type was "${ct}", expected text/event-stream` });
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop();
        for (const raw of parts) {
          const frame = raw.trim();
          if (!frame) continue;
          frameCount++;
          if (!sample) sample = frame.replace(/\s+/g, ' ').slice(0, 200);
          const lines = frame.split(/\r?\n/);
          const evLine = lines.find((l) => l.startsWith('event:'));
          const dataLine = lines.find((l) => l.startsWith('data:'));
          const evName = evLine ? evLine.slice(6).trim() : '';
          if (evName !== 'dash') continue;
          sawDashEvent = true;
          if (!dataLine) continue;
          let obj = null;
          try { obj = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          if (obj && obj.event === 'dash.status') {
            return finish({ ok: true, status: obj.data || {}, frames: frameCount });
          }
        }
      });
      res.on('end', () => finish({ error: 'stream ended before a dash.status frame arrived' }));
    });
    req.on('error', (e) => finish({ error: `${e.code || 'network error'}: ${e.message}` }));
    req.end();
    timer = setTimeout(() => {
      const why = sawDashEvent
        ? `only ${frameCount} frame(s) seen, none had data.event === "dash.status"`
        : `no "event: dash" frame seen in ${frameCount} frame(s)`;
      finish({ error: `${why} within ${waitMs}ms${sample ? ` (first frame: ${sample})` : ''}` });
    }, waitMs);
  });
}

// ---------------------------------------------------------------- server spawn

function tcpListening(port) {
  return new Promise((resolve) => {
    const s = http.request({ method: 'GET', hostname: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
    s.end();
  });
}

function killChild(c) {
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  try { c.kill(); } catch { /* ignore */ }
  setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } }, 1500).unref();
}

async function startServer() {
  const entry = path.join(REPO_ROOT, 'src', 'server.js');
  if (!fs.existsSync(entry)) {
    return { error: `W1 has not landed yet: ${entry} does not exist` };
  }
  child = spawn(process.execPath, ['src/server.js', '--port', String(PORT)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let spawnErr = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('error', (e) => { spawnErr = e; });
  let exited = null;
  child.on('exit', (code, sig) => { exited = `exit ${code}${sig ? ` (${sig})` : ''}`; });

  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    if (spawnErr) return { error: `could not spawn server: ${spawnErr.message}` };
    if (exited !== null) return { error: `server ${exited} during startup; output: ${out.trim().slice(0, 400) || '(none)'}` };
    if (/listening on /i.test(out) && await tcpListening(PORT)) return { ok: true, banner: out.trim().split(/\r?\n/)[0] || '' };
    if (await tcpListening(PORT)) return { ok: true, banner: out.trim().split(/\r?\n/)[0] || '(no listen line printed)' };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { error: `server not listening within ${SPAWN_WAIT_MS}ms; output: ${out.trim().slice(0, 400) || '(none)'}` };
}

// ---------------------------------------------------------------- the checks

async function runChecks() {
  let snapshot = null;
  let firstPaneId = null;

  // 1. health
  await check('/api/health returns ok:true with herdr.version, herdr.protocol, pipe', async () => {
    const j = needJson(await GET('/api/health'), '/api/health');
    must(j.ok === true, `ok was ${JSON.stringify(j.ok)}`);
    must(j.herdr && typeof j.herdr.version === 'string', `herdr.version was ${JSON.stringify(j.herdr && j.herdr.version)} (expected a string)`);
    must(j.herdr && typeof j.herdr.protocol === 'number', `herdr.protocol was ${JSON.stringify(j.herdr && j.herdr.protocol)} (expected a number)`);
    must(typeof j.pipe === 'string' && j.pipe.length > 0, `pipe was ${JSON.stringify(j.pipe)} (expected a non-empty string)`);
  });

  // 2. snapshot + referential integrity
  await check('/api/snapshot returns non-empty workspaces with intact tab/pane references', async () => {
    const j = needJson(await GET('/api/snapshot'), '/api/snapshot');
    must(j.ok === true, `ok was ${JSON.stringify(j.ok)}`);
    snapshot = j.snapshot;
    must(snapshot && typeof snapshot === 'object', 'snapshot was missing from the response');
    must(Array.isArray(snapshot.workspaces) && snapshot.workspaces.length > 0, `snapshot.workspaces was ${JSON.stringify(snapshot.workspaces && snapshot.workspaces.length)} (expected a non-empty array)`);
    const tabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : [];
    const panes = Array.isArray(snapshot.panes) ? snapshot.panes : [];
    const wsIds = new Set(snapshot.workspaces.map((w) => w && w.workspace_id));
    const badTab = tabs.find((t) => !wsIds.has(t && t.workspace_id));
    must(!badTab, `tab ${badTab && badTab.tab_id} references workspace_id ${JSON.stringify(badTab && badTab.workspace_id)} which is not in snapshot.workspaces`);
    const tabIds = new Set(tabs.map((t) => t && t.tab_id));
    const badPane = panes.find((p) => !tabIds.has(p && p.tab_id));
    must(!badPane, `pane ${badPane && badPane.pane_id} references tab_id ${JSON.stringify(badPane && badPane.tab_id)} which is not in snapshot.tabs`);
    must(panes.length > 0, `snapshot.panes was empty (${panes.length}) — no pane to read for check 3`);
    firstPaneId = panes[0] && panes[0].pane_id;
    must(typeof firstPaneId === 'string' && firstPaneId, `first pane had no pane_id (${JSON.stringify(panes[0])})`);
    return { ok: true, detail: '' };
  });

  // 3. pane read
  await check(`/api/pane reads the first pane (${firstPaneId || 'none'}) with lines=40`, async () => {
    must(firstPaneId, 'skipped: no pane id was available from the snapshot check');
    const j = needJson(await GET(`/api/pane?pane_id=${encodeURIComponent(firstPaneId)}&lines=40`), '/api/pane');
    must(j.ok === true, `ok was ${JSON.stringify(j.ok)} (${j.error ? j.error.code + ': ' + j.error.message : 'no error field'})`);
    must(typeof j.text === 'string', `text was ${typeof j.text} (expected a string)`);
    must(typeof j.revision === 'number', `revision was ${JSON.stringify(j.revision)} (expected a number)`);
  });

  // 4. unknown pane fails cleanly and does not take the server down
  await check('/api/pane with an unknown pane_id returns ok:false + error.code, server survives', async () => {
    const j = needJson(await GET('/api/pane?pane_id=does-not-exist'), '/api/pane?pane_id=does-not-exist');
    must(j.ok === false, `ok was ${JSON.stringify(j.ok)} (expected false)`);
    must(j.error && typeof j.error.code === 'string' && j.error.code, `error.code was ${JSON.stringify(j.error && j.error.code)}`);
    const h = needJson(await GET('/api/health'), '/api/health (after the failed read)');
    must(h.ok === true, `follow-up /api/health returned ok:${JSON.stringify(h.ok)} — the server did not recover`);
  });

  // 5. prompt validation — must not reach herdr
  await check('POST /api/pane/prompt without `text` is rejected before reaching herdr', async () => {
    const j = needJson(await POST('/api/pane/prompt', { pane_id: firstPaneId || 'does-not-exist' }), 'POST /api/pane/prompt (no text)');
    must(j.ok === false, `ok was ${JSON.stringify(j.ok)} — a prompt with no text must not be accepted`);
    must(j.error && j.error.code, `error.code was ${JSON.stringify(j.error && j.error.code)}`);
  });

  // 6. raw rpc ping
  await check('POST /api/rpc {"method":"ping"} returns result.type === "pong"', async () => {
    const j = needJson(await POST('/api/rpc', { method: 'ping', params: {} }), 'POST /api/rpc ping');
    must(j.ok === true, `ok was ${JSON.stringify(j.ok)} (${j.error ? j.error.code + ': ' + j.error.message : 'no error field'})`);
    must(j.result && j.result.type === 'pong', `result.type was ${JSON.stringify(j.result && j.result.type)} (expected "pong")`);
  });

  // 7. cli passthrough, happy path
  await check('POST /api/cli ["agent","list"] exits 0 with JSON stdout', async () => {
    const j = needJson(await POST('/api/cli', { argv: ['agent', 'list'] }, { timeoutMs: 25000 }), 'POST /api/cli agent list');
    must(j.ok === true, `ok was ${JSON.stringify(j.ok)} (${j.error ? j.error.code + ': ' + j.error.message : 'no error field'})`);
    must(j.exit_code === 0, `exit_code was ${JSON.stringify(j.exit_code)}; stderr: ${String(j.stderr || '').trim().slice(0, 200) || '(empty)'}`);
    let parsed = null;
    try { parsed = JSON.parse(String(j.stdout || '').trim()); } catch { /* leave null */ }
    must(parsed !== null, `stdout was not JSON: ${String(j.stdout || '').trim().slice(0, 200) || '(empty)'}`);
  });

  // 8. cli failure must be surfaced, not swallowed
  await check('POST /api/cli with a bogus argv surfaces the failure', async () => {
    const j = needJson(await POST('/api/cli', { argv: ['no-such-binary-xyz'] }, { timeoutMs: 25000 }), 'POST /api/cli bogus argv');
    if (j.ok === false) {
      must(j.error && j.error.code === 'spawn_error', `ok:false but error.code was ${JSON.stringify(j.error && j.error.code)} (expected "spawn_error")`);
      must(String(j.error.message || '').length > 0, 'ok:false with an empty error.message — the failure was swallowed');
      return;
    }
    must(j.ok === true, `ok was ${JSON.stringify(j.ok)}`);
    const surfaced = String(j.stderr || '').trim() || String((j.error && j.error.message) || '').trim();
    must(surfaced.length > 0, `ok:true with exit_code ${JSON.stringify(j.exit_code)} but empty stderr — the failure was swallowed`);
  });

  // 9. unknown rpc method
  await check('POST /api/rpc with an unknown method returns ok:false + error.message', async () => {
    const j = needJson(await POST('/api/rpc', { method: 'nope.nope', params: {} }), 'POST /api/rpc nope.nope');
    must(j.ok === false, `ok was ${JSON.stringify(j.ok)} (expected false)`);
    must(j.error && typeof j.error.message === 'string' && j.error.message.length > 0, `error.message was ${JSON.stringify(j.error && j.error.message)}`);
  });

  // 10. index.html
  await check('GET / serves index.html that references app.js', async () => {
    const r = reachable(await GET('/'), 'GET /');
    must(r.status === 200, `HTTP ${r.status}`);
    const ct = String(r.headers['content-type'] || '');
    must(ct.startsWith('text/html'), `content-type was "${ct}"`);
    must(r.text.includes('app.js'), 'body did not contain "app.js"');
  });

  // 11. static assets at both paths
  for (const file of ['app.js', 'style.css']) {
    await check(`GET /${file} is 200 and non-empty`, async () => {
      const r = reachable(await GET(`/${file}`), `GET /${file}`);
      must(r.status === 200, `HTTP ${r.status}`);
      must(r.text.length > 0, 'body was empty');
    });
  }
  await check('GET /static/app.js is 200 (both root and /static/ paths)', async () => {
    const r = reachable(await GET('/static/app.js'), 'GET /static/app.js');
    must(r.status === 200, `HTTP ${r.status}`);
    must(r.text.length > 0, 'body was empty');
  });

  // 12. unknown path -> 404
  await check('GET /definitely-not-here returns HTTP 404', async () => {
    const r = reachable(await GET('/definitely-not-here'), 'GET /definitely-not-here');
    must(r.status === 404, `HTTP ${r.status} (expected 404)`);
  });

  // 13. SSE
  await check('GET /api/events emits a dash frame whose data.event is "dash.status"', async () => {
    const r = await sseProbe(`${BASE}/api/events`, SSE_WAIT_MS);
    must(r.ok === true, r.error || 'no dash.status frame');
  });

  // 14. mergeStream (§7) — imported from W1's src/hdr.js
  let mod = null;
  await check("src/hdr.js exports mergeStream", async () => {
    try {
      mod = await import('../src/hdr.js');
    } catch (e) {
      throw new Fail(`could not import ../src/hdr.js — ${e && e.code ? e.code + ': ' : ''}${e && e.message ? e.message : String(e)}`);
    }
    must(typeof mod.mergeStream === 'function', `mergeStream export is ${typeof mod.mergeStream} (expected a function)`);
  });

  const mergeCases = [
    ['identical tails produce no new lines', ['a', 'b', 'c'], ['a', 'b', 'c'], { newLines: [], overlapped: true }],
    ['partial overlap appends only the new tail', ['a', 'b', 'c'], ['b', 'c', 'd'], { newLines: ['d'], overlapped: true }],
    ['no overlap returns the whole tail with overlapped:false', ['x', 'y'], ['a', 'b'], { newLines: ['a', 'b'], overlapped: false }],
    ['empty prev returns the whole tail', [], ['a', 'b'], { newLines: ['a', 'b'], overlapped: false }],
    ['next being a suffix of prev appends nothing', ['a', 'b', 'c', 'd'], ['c', 'd'], { newLines: [], overlapped: true }],
  ];
  for (const [label, prev, next, want] of mergeCases) {
    await check(`mergeStream: ${label}`, () => {
      must(typeof mod?.mergeStream === 'function', 'mergeStream is not exported by src/hdr.js');
      const got = mod.mergeStream(prev, next);
      must(got && typeof got === 'object', `returned ${JSON.stringify(got)} (expected an object)`);
      must(Array.isArray(got.newLines) && got.newLines.join('\u0000') === want.newLines.join('\u0000'),
        `newLines was ${JSON.stringify(got.newLines)} (expected ${JSON.stringify(want.newLines)}) for prev=${JSON.stringify(prev)} next=${JSON.stringify(next)}`);
      must(got.overlapped === want.overlapped, `overlapped was ${JSON.stringify(got.overlapped)} (expected ${JSON.stringify(want.overlapped)})`);
    });
  }
}

// ---------------------------------------------------------------- main

let watchdog = null;
async function main() {
  console.log(`herdr-dash acceptance — base ${BASE}, ${NO_SPAWN ? 'no-spawn' : 'spawning server'}`);
  console.log(`repo root: ${REPO_ROOT}`);
  console.log('');

  if (!NO_SPAWN) {
    const started = await startServer();
    if (started.error) {
      console.log(`FAIL server start — ${started.error}`);
      console.log('');
      console.log('TOTAL: 0/1 passed');
      return 1;
    }
    console.log(`server: ${started.banner || 'listening'}`);
    console.log('');
  }

  // Hard watchdog: every request already has its own timeout, this is only a backstop
  // so the harness can never hang a CI run.
  watchdog = setTimeout(() => {
    console.log('');
    console.log(`FAIL harness watchdog — exceeded 150s, aborting`);
    report();
    killChild(child);
    process.exit(1);
  }, 150000);

  try {
    await runChecks();
  } catch (e) {
    // A throw can only escape if the runner itself broke; report it as a failed check
    // rather than an unhandled rejection.
    console.log(`FAIL harness — unexpected ${e && e.name ? e.name : 'error'}: ${e && e.message ? e.message : String(e)}`);
    results.push({ name: 'harness', ok: false, detail: 'aborted' });
  }
  clearTimeout(watchdog);
  return report();
}

function report() {
  const passed = results.filter((r) => r.ok).length;
  console.log('');
  console.log(`TOTAL: ${passed}/${results.length} passed`);
  return passed === results.length ? 0 : 1;
}

process.on('exit', () => killChild(child));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    killChild(child);
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.log(`FAIL harness — ${e && e.message ? e.message : String(e)}`);
  code = 1;
} finally {
  killChild(child);
}
process.exit(code);
