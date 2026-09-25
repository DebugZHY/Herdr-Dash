#!/usr/bin/env node
/* herdr-dash — test/pathlink-live.mjs (W3, CONTRACT-v2 §13.1 / §13.2)
 *
 * WHAT THIS SUITE IS FOR. test/pathlink.mjs and test/chat-render.mjs settle the LOGIC against a
 * synthetic DOM: the wire shape, the extractor, the CSS coverage, §13.1.1's markup byte for byte. They
 * cannot settle anything that needs layout, a compositor, a real key event, or a real browser's own
 * request headers — and my round-9 report listed exactly those as unverified. This suite closes them,
 * and only them.
 *
 * HOW. A standalone fixture page (test/fixtures/pathlink-live/pathlink-live.html + its .js, served
 * under /fx/) loads the SHIPPED files by the very URLs public/index.html loads them by —
 * /lib/chat-render.js, /lib/copy.js, /lib/pathlink.js, /lib/chatview.css, /lib/pathlink.css,
 * /style.css — and this file serves them and drives a real headless Chrome over CDP with REAL input
 * events (Input.dispatchMouseEvent / Input.dispatchKeyEvent), the same technique
 * test/acceptance-v2.mjs uses.
 *
 * SELF-CONTAINED. Everything this suite needs is in the repository: this file, the fixture directory
 * beside it, and the shipped public/ files. Nothing is read from a worker's scratch directory, nothing
 * is generated at run time except the browser's own throwaway profile, so a fresh clone can run it.
 *
 * The stub API is a real HTTP server in this process, and it answers /api/pathinfo by STATING THE DISK
 * (fs.statSync), so "exists:true" and "exists:false" are facts about this repository rather than a
 * table someone typed. That buys three things the driver's in-page stub cannot: the browser's own
 * `Sec-Fetch-Site: same-origin` header is observable, an AbortSignal that really fires on a really
 * unanswered request is observable, and the request socket really closing on abort is observable.
 *
 * IT IS NOT THE APP. index.html, app.js, chatview.js and style.css are W2's and are untouched. There
 * is no chatview.js in the fixture, so the fold handler there is a NAIVE STAND-IN of the same shape
 * (a bubble-phase delegation above the copy mount host) — which is what makes §13.1.4's ordering
 * question measurable here, and is also why the final ordering proof on the real page stays W2's.
 *
 * HOUSE RULES OBEYED. Page.bringToFront + `document.hidden === false` is asserted before any polling;
 * every Runtime.evaluate is a short expression and all waiting happens here in Node; the server and the
 * browser are this suite's own (own ports, own throwaway profile) and both are gone before it reports.
 *
 * PORT MAP: the static+stub server takes 7300 + pid%100 (walking forward if taken) and never touches
 * the user's 7433; the DevTools endpoint takes whatever the OS hands out. Both are printed as free.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
/* The fixture lives in the repo, next to this suite — NOT in a worker's scratch directory: it is part
   of what has to run on any clone. Everything it needs is in this directory (the page, its script, and
   the one file the stub API deliberately never answers about); nothing is created and nothing else is
   read from disk except the SHIPPED public/ files, which are loaded at the app's own URLs. */
const FIXDIR = path.join(ROOT, 'test', 'fixtures', 'pathlink-live');
const FIXTURE = path.join(FIXDIR, 'pathlink-live.html');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN, process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- results

class Fail extends Error {}
class Stop extends Error {}
const checks = [];
const results = [];
let CUR = null;

function check(id, name, fn) { checks.push({ id, name, fn }); }
/** Inside a check: record a false and keep going, so one bad measurement cannot hide the next. */
function ok(cond, msg) {
  if (!CUR) throw new Error('ok() outside a check');
  CUR.n++;
  if (!cond) CUR.fails.push(msg);
  return !!cond;
}
/** Inside a check: a false here makes the rest of the measurements meaningless. */
function must(cond, msg) {
  if (!cond) { if (CUR) { CUR.n++; CUR.fails.push(msg + ' — cannot measure past this'); } throw new Stop(msg); }
  if (CUR) CUR.n++;
  return true;
}
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);
const deep = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${msg} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);

// ---------------------------------------------------------------- the stub API + the files

/* Every request the page makes, recorded where the page cannot touch it. */
const OUT = {
  pathinfo: [], open: [], holds: 0, hangClosed: 0, other: [], held: [],
  /* the request must be a same-origin POST carrying §13.2.6's header — checked on both routes */
  holdRe: /hang-me/i,
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
};

function truthFor(p) {
  try {
    const st = fs.statSync(p);
    return { path: p, exists: true, kind: st.isDirectory() ? 'dir' : 'file' };
  } catch {
    return { path: p, exists: false, kind: null };
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
      resolve({ raw, json });
    });
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** The page's view of a request, as this side saw it: the browser's own headers included. */
function record(req, route, body) {
  return {
    at: Date.now(), route, method: req.method, url: req.url,
    contentType: req.headers['content-type'] || null,
    action: req.headers['x-hd-action'] || null,
    sfs: req.headers['sec-fetch-site'] || null,
    sfmode: req.headers['sec-fetch-mode'] || null,
    sfdest: req.headers['sec-fetch-dest'] || null,
    origin: req.headers.origin || null,
    referer: req.headers.referer || null,
    host: req.headers.host || null,
    body,
  };
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/api/pathinfo' || url === '/api/open') {
    const { raw, json } = await readBody(req);
    const rec = record(req, url, json || { raw_len: raw.length, raw: raw.slice(0, 200) });
    if (url === '/api/pathinfo') OUT.pathinfo.push(rec); else OUT.open.push(rec);

    if (url === '/api/pathinfo') {
      const paths = (json && Array.isArray(json.paths)) ? json.paths.map(String) : [];
      if (!json || !Array.isArray(json.paths)) { return sendJson(res, 400, { ok: false, error: 'paths[] is required' }); }
      if (paths.some((p) => OUT.holdRe.test(p))) {
        // A server that never answers: the page's own 8 s AbortController is the only way out.
        OUT.holds++;
        OUT.held.push(res);
        res.on('close', () => {
          if (!res.writableEnded) OUT.hangClosed++;
        });
        return;
      }
      return sendJson(res, 200, { ok: true, items: paths.map(truthFor) });
    }
    const p = json && typeof json.path === 'string' ? json.path : '';
    const a = json && json.action;
    if (!p || (a !== 'open' && a !== 'reveal')) return sendJson(res, 400, { ok: false, error: 'path and action are required' });
    if (OUT.holdRe.test(p)) { OUT.holds++; OUT.held.push(res); return; }
    return sendJson(res, 200, { ok: true, path: p, action: a,
      done: 'handed to the system: ' + p + ' (' + a + ')' });
  }

  OUT.other.push({ at: Date.now(), method: req.method, url: req.url });

  /* The shipped files at the very URLs public/index.html loads them by (/lib/*, /style.css), and the
     fixture's own files under /fx/*, out of test/fixtures/pathlink-live — so the page under test is
     the delivered one and the harness is in the repository, not in anyone's scratch directory. */
  let file = null;
  if (url === '/' || url === '/index.html') file = FIXTURE;
  else if (url.startsWith('/fx/')) {
    file = path.resolve(FIXDIR, url.slice(4));
    if (!file.startsWith(FIXDIR)) file = null;                 // never serve outside the fixture dir
  } else if (url.startsWith('/lib/') || url === '/style.css' || url === '/app.js') {
    file = path.resolve(ROOT, 'public', url.slice(1));
  } else if (url.startsWith('/public/')) {
    file = path.resolve(ROOT, url.slice(1));
  } else {
    file = path.resolve(ROOT, url.slice(1));
  }
  if (!file || !file.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found: ' + url); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

// ---------------------------------------------------------------- the browser (CDP)

const browser = {
  proc: null, ws: null, profileDir: null, msgId: 0, pending: new Map(),
  cdpErrors: [], pageErrors: [], port: null,

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.msgId;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  },

  async open() {
    const bin = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (!bin) throw new Fail(`no Chrome/Chromium found — looked at ${CHROME_CANDIDATES.join(', ')} (set CHROME_BIN)`);
    const port = await new Promise((resolve) => {
      const s = net.createServer();
      s.on('error', () => resolve(0));
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    if (!port) throw new Fail('could not find a free port for the DevTools endpoint');
    this.port = port;
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-dash-pllive-'));
    this.proc = spawn(bin, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + this.profileDir,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--hide-scrollbars',
      '--window-size=1520,900', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    let wsUrl = null;
    for (let i = 0; i < 80 && !wsUrl; i++) {
      if (this.proc.exitCode !== null) throw new Fail(`Chrome exited during startup (code ${this.proc.exitCode})`);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        wsUrl = (list.find((t) => t.type === 'page') || {}).webSocketDebuggerUrl;
      } catch { /* not up yet */ }
      if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Fail('Chrome started but never exposed a page target');
    this.ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res);
      this.ws.addEventListener('error', () => rej(new Fail('could not open the DevTools websocket')));
    });
    this.ws.addEventListener('message', (m0) => {
      const m = JSON.parse(typeof m0.data === 'string' ? m0.data : Buffer.from(m0.data).toString('utf8'));
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        this.pageErrors.push((d.exception && d.exception.description) || d.text || 'exception');
      }
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    return this;
  },

  close() {
    if (this.ws) { try { this.ws.close(); } catch { /* gone */ } this.ws = null; }
    if (this.proc && this.proc.exitCode === null) {
      try { spawn('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
      catch { try { this.proc.kill(); } catch { /* gone */ } }
    }
    this.proc = null;
    if (this.profileDir) {
      const dir = this.profileDir;
      this.profileDir = null;
      setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left for the OS */ } }, 500).unref();
    }
  },

  /* NOTE: in this harness Runtime.evaluate answers as {result:{result:RemoteObject}}, one level deeper
     than the CDP spec's {result:RemoteObject}; both shapes are accepted. */
  async ev(expr, soft) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.error) {
      this.cdpErrors.push(JSON.stringify(r.error).slice(0, 160));
      if (soft) return undefined;
      throw new Fail('the browser refused the evaluate: ' + JSON.stringify(r.error));
    }
    const ex = r.exceptionDetails || (r.result && r.result.exceptionDetails);
    if (ex) throw new Fail('the page threw: ' + ((ex.exception && ex.exception.description) || ex.text));
    const out = (r.result && r.result.result !== undefined) ? r.result.result : r.result;
    if (!out || out.value === undefined) {
      this.cdpErrors.push('no value for ' + expr.slice(0, 40));
      if (soft) return undefined;
      throw new Fail(`the evaluate produced no value (${expr.slice(0, 120)}): ${JSON.stringify(r).slice(0, 200)}`);
    }
    return out.value;
  },

  /* a real mouse click, pressed and released on the same point — never element.click() */
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(30);
  },

  /* a real key: rawKeyDown carries no text, so a view key cannot also type itself into a field */
  async key(key, code, vk) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 };
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
    await sleep(30);
  },

  /* a clipboard READ is a permission, not a capability. The response is returned verbatim so a check
     that cannot read the clipboard can say what the browser said instead of guessing. */
  async grant(origin, permissions) {
    const r = await this.send('Browser.grantPermissions', { origin, permissions });
    return { ok: !!(r && r.result !== undefined && !r.error), error: (r && r.error) || null };
  },

  /* navigate, then the visibility handshake, then wait for the fixture to be ready */
  async reload(url) {
    await this.send('Page.navigate', { url });
    await this.send('Page.bringToFront');
    let hidden = null;
    for (let i = 0; i < 60; i++) {
      hidden = await this.ev('document.hidden', true);
      if (hidden === false) break;
      await sleep(100);
    }
    const vis = await this.ev(`JSON.stringify({ hidden: document.hidden, vis: document.visibilityState, href: location.href, ready: document.readyState })`, true);
    if (!vis || !/"hidden":false/.test(vis)) {
      throw new Fail(`the tab does not report document.hidden === false (measured ${vis}) — a backgrounded tab is not a browser, so this run would be meaningless`);
    }
    let why = null;
    for (let i = 0; i < 100; i++) {
      why = await this.ev(`(() => {
        if (document.readyState !== 'complete') return 'readyState=' + document.readyState;
        if (!window.HD) return 'no window.HD';
        if (!window.HD.chatRender || !window.HD.pathlink || !window.HD.copy) return 'modules: ' + Object.keys(window.HD).join(',');
        if (!window.fx) return 'no window.fx';
        return '';
      })()`, true);
      if (why === '') break;
      await sleep(100);
    }
    if (why !== '') throw new Fail(`the fixture never became usable from ${url}: ${why}`);
    await this.ev('window.fx.watchFetch()');
    return this;
  },
};

// ---------------------------------------------------------------- page-side helpers

const ev = (expr, soft) => browser.ev(expr, soft);
const jfx = (call) => ev('JSON.stringify(window.fx.' + call + ')').then((s) => JSON.parse(s));

/** Wait in NODE for a page predicate (the page never waits for itself). */
async function until(expr, ms = 5000, step = 80) {
  const t0 = Date.now();
  for (;;) {
    if ((await ev(expr, true)) === true) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(step);
  }
}
async function untilSettled(extra) {
  const okNow = await until(`window.HD.pathlink.state().pending === false && (${extra || 'true'})`, 8000);
  await sleep(260);                                   // one debounce window, so a second pass would show
  return okNow;
}
async function resetMenus() {
  if ((await ev('window.fx.menuCount()', true)) > 0) { await browser.key('Escape', 'Escape', 27); await sleep(80); }
}
async function hide(id) {
  await ev(`(function(){var n=document.getElementById(${JSON.stringify(id)}); if(n){n.style.display='none'; while(n.firstChild) n.removeChild(n.firstChild);} return true;})()`);
}
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const box = (r) => (r ? `[${Math.round(r.l)},${Math.round(r.t)} → ${Math.round(r.r)},${Math.round(r.b)}]` : 'null');
const overlaps = (a, b) => !!a && !!b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const D = 'D:\\Development\\New\\herdr-dash\\';
const P = {
  FILE: D + 'public\\lib\\pathlink.js',
  DIR: D + 'public\\lib',
  GONE: D + 'public\\lib\\not-on-this-disk.zzz',
  HANG: D + 'test\\fixtures\\pathlink-live\\hang-me.txt',
  EXTRA: D + 'test\\pathlink.mjs',
  BURST: [D + 'public\\lib\\chat-render.js', D + 'public\\lib\\chatview.css', D + 'public\\lib\\dock.js',
    D + 'public\\lib\\copy.js', D + 'public\\style.css', D + 'src\\chat\\common.js'],
};

// ---------------------------------------------------------------- (a) the DOM decides

check('a1', '§13.2.4 exists:true becomes .hd-pl-link with the right data-hd-path/data-hd-kind, exists:false stays plain text — asserted on the DOM', async () => {
  must(fs.existsSync(P.FILE) && fs.statSync(P.DIR).isDirectory(), 'the fixture paths are not what the disk says: the whole check rests on them');
  must(!fs.existsSync(P.GONE), `${P.GONE} exists on this disk, so "exists:false" would not be measurable`);

  const n0 = OUT.pathinfo.length;
  await ev('JSON.stringify(window.fx.seed())');
  await untilSettled('document.querySelectorAll("#fxList .hd-pl-link").length >= 2');
  const d = await jfx('dom("fxList")');

  const by = {};
  for (const l of d.links) (by[l.path] = by[l.path] || []).push(l);
  must(by[P.FILE] && by[P.FILE].length === 1, `the file link is not in the DOM exactly once (links: ${JSON.stringify(Object.keys(by))})`);
  must(by[P.DIR] && by[P.DIR].length === 1, 'the folder link is not in the DOM exactly once');

  eq(by[P.FILE][0].kind, 'file', 'the file link carries the kind the stub API stated');
  eq(by[P.DIR][0].kind, 'dir', 'the folder link carries the kind the stub API stated');
  eq(by[P.FILE][0].text, P.FILE, 'the link\'s text is the path verbatim');
  eq(by[P.DIR][0].text, P.DIR, 'the folder link\'s text is the path verbatim');
  eq(by[P.FILE][0].cls, 'hd-pl-link', 'the element really is the shipped .hd-pl-link');
  eq(by[P.FILE][0].role, 'link', 'it says what it is to assistive tech');
  eq(by[P.FILE][0].tabindex, '0', 'and it is reachable from the keyboard');
  ok(by[P.FILE][0].title && by[P.FILE][0].title.indexOf(P.FILE) === 0, 'the tooltip names the same path');

  ok(!by[P.GONE], 'a path the stub API reports exists:false must NOT be a link');
  ok(d.listText.indexOf(P.GONE) >= 0, 'the exists:false path is still on screen as plain text');
  {
    const at = [];
    let i = d.listText.indexOf(P.GONE);
    while (i >= 0) { at.push(i); i = d.listText.indexOf(P.GONE, i + 1); }
    eq(at.length, 1, 'and it appears exactly once — decoration must not duplicate or eat text');
  }
  const prose = ['The file ', ' it drew, the folder ', ' it wrote, and ', ' which is not on this disk at all.'];
  for (const s of prose) ok(d.listText.indexOf(s) >= 0, `the prose around the paths survived verbatim (missing ${JSON.stringify(s)})`);

  eq(d.state.known, 2, 'the module counts exactly the two paths the disk confirms');
  /* the readings the extractor offered and the server denied are counted as "missing" too, so the
     honest invariant is the accounting, not one number: every answer it asked for is in one bucket. */
  eq(d.state.known + d.state.missing, d.state.asked, 'every answer the server gave is accounted for');
  ok(d.state.missing >= 1, 'and the denied readings — the absent path among them — are counted as missing');
  eq(d.linkTags, 2, 'two anchors in the list and no more');
  eq(d.nestedLinks, 0, 'no link was drawn inside another link');
  ok(d.scope === 'fxList', 'the measurement was scoped to the mounted host');

  return `3 candidates → ${d.links.length} links (file+dir), ${P.GONE} left as text, everything inside the viewport ${d.links.every((l) => l.inside)}`;
});

check('a2', '§13.2.3/§13.2.6 the real browser posts one batched /api/pathinfo asking each candidate once, with x-hd-action and its own Sec-Fetch-Site', async () => {
  must(OUT.pathinfo.length >= 1, 'the page never called /api/pathinfo — the stub API saw no request at all');
  const r = OUT.pathinfo[OUT.pathinfo.length - 1];
  eq(r.route, '/api/pathinfo', 'the last request the stub API saw is the pathinfo one');
  eq(r.method, 'POST', 'the route is a POST');
  eq(r.route, '/api/pathinfo', 'and it is the contract\'s route');
  ok(/application\/json/.test(r.contentType || ''), `Content-Type is application/json (got ${r.contentType})`);
  eq(r.action, '1', '§13.2.6\'s x-hd-action: 1 travels with it');
  eq(r.sfs, 'same-origin', 'and the browser added Sec-Fetch-Site: same-origin by itself');
  eq(r.sfmode, 'cors', 'the request really is a fetch (mode cors)');
  ok(r.origin === BASE, `the Origin is this page (got ${r.origin})`);

  const paths = (r.body && r.body.paths) || [];
  must(paths.length > 0, 'the request carried no paths');
  eq(new Set(paths).size, paths.length, 'no path is asked twice in one request');
  for (const p of paths) {
    ok(p.startsWith(P.FILE) || p.startsWith(P.DIR) || p.startsWith(P.GONE),
      `every asked string is a reading of one of the three candidates (${JSON.stringify(p)})`);
  }
  for (const want of [P.FILE, P.DIR, P.GONE]) ok(paths.indexOf(want) >= 0, `the exact path ${want} was asked about`);

  const d = await jfx('dom("fxList")');
  eq(d.state.asked, paths.length, 'the module asked exactly the paths the server was asked about');
  eq(d.state.passes >= 1, true, 'at least one decorate pass ran');
  return `${paths.length} paths in one POST (${paths.length - 3} of them extra readings the server adjudicated), asked=${d.state.asked}`;
});

check('a3', '§13.2.4 the link is reachable by a real pointer, and the exists:false path has no pointer target at all', async () => {
  const pt = JSON.parse(await ev(`JSON.stringify(window.fx.clickPoint(${JSON.stringify(P.FILE)}))`));
  must(pt.found === true, `no point inside the file link hit-tests to the link itself (${JSON.stringify(pt)})`);
  const lb = JSON.parse(await ev(`JSON.stringify(window.fx.linkBox(${JSON.stringify(P.FILE)}))`));
  eq(lb.hitIsLink, true, 'the link\'s own centre hit-tests to the link — so a real press would land on it');
  eq(await ev(`window.fx.linkBox(${JSON.stringify(P.GONE)}) === null`), true, 'the unconfirmed path has no link element to measure');
  const d = await jfx('dom("fxList")');
  const file = d.links.filter((l) => l.path === P.FILE)[0];
  eq(file.inside, true, 'and the link it does have is inside the viewport');
  return `clickable point ${pt.x},${pt.y} inside the link; ${P.GONE} has neither a target nor a missing-text`;
});

// ---------------------------------------------------------------- (b) placement, in a real engine

check('b1', '§13.2.4 inside a scrolled pane the menu is not clipped by the scroll container, and every point of it hit-tests to the menu', async () => {
  await resetMenus();
  /* a link at the END of the list, with the pane scrolled to the bottom: the link then sits a few
     pixels above the scroller's bottom edge, so the menu below it MUST reach past that edge. This is
     the only arrangement in which "would the scroll container clip the menu?" is a real question. */
  await ev(`JSON.stringify(window.fx.probe(${JSON.stringify(P.FILE)}))`);
  await untilSettled('true');
  const sc = JSON.parse(await ev('JSON.stringify(window.fx.scrollTo(1000000))'));
  ok(sc.scrollTop > 0, `the pane really scrolled (got ${sc.scrollTop})`);
  eq(sc.scrollTop, sc.scrollHeight - sc.clientHeight, 'and it is at the bottom, so the newest link is at the scroller\'s bottom edge');

  const d0 = await jfx('dom("fxList")');
  const lb = JSON.parse(await ev(`JSON.stringify(window.fx.linkBox(${JSON.stringify(P.FILE)}, "fxList", true))`));
  must(lb, 'the appended file link is not in the list');
  ok(lb.b > d0.scroller.b - 40, `the link really is at the scroller's bottom edge (link bottom ${Math.round(lb.b)} vs scroller bottom ${Math.round(d0.scroller.b)})`);
  ok(lb.t >= d0.scroller.t - 1 && lb.b <= d0.scroller.b + 1, 'and it is fully inside the scroller, not half-scrolled out of it');

  const pt = JSON.parse(await ev(`JSON.stringify(window.fx.clickPoint(${JSON.stringify(P.FILE)}, "fxList", true))`));
  must(pt.found, `the scrolled link has no clickable point (${JSON.stringify(pt)})`);
  await browser.click(pt.x, pt.y);
  must(await until('window.fx.menuCount() === 1', 3000), 'a real click on a confirmed file link opened no menu');

  const d = await jfx('dom("fxList")');
  must(d.menus.length === 1, `expected exactly one menu, dom saw ${d.menus.length}`);
  const m = d.menus[0];
  eq(m.position, 'fixed', 'the menu is out of flow, so a scroll container cannot clip it');
  ok(Number(m.zIndex) > 0, `the menu stacks above the pane (z-index ${m.zIndex})`);
  eq(m.insidePadded, true, `the menu is inside the viewport with 8 px to spare ${box(m.box)}`);
  ok(m.box.r <= d.viewport.w - 8 + 0.5, `its right edge (${Math.round(m.box.r)}) is inside the window's (${d.viewport.w} − 8)`);
  eq(m.hitIsMenu, true, `the element at the menu's own centre is the menu — nothing covers it or clips it (${m.hit})`);
  eq(m.parent, 'fxList', 'the menu lives in the mounted host, not at the end of the document');
  eq(m.pathText, P.FILE, 'and the path in it is the path verbatim');
  deep(m.buttons, ['Open', 'Open File Location'], 'both §13.2.5 actions are offered, in that order');
  deep(m.acts, ['open', 'reveal'], 'and they name the contract\'s actions');
  eq(m.pathHScroll, 0, 'the verbatim path does not need a horizontal scroll');
  eq(m.pathOverflow, 'clip', 'the path is never ellipsised');

  /* the decisive one: a point INSIDE the menu's box but BELOW the scroll container's bottom edge.
     If the overflow:auto ancestor clipped the fixed menu, that pixel would belong to whatever is
     painted behind it, and this is the measurement that would say so. */
  must(m.box.b > d.scroller.b, `the menu does not reach past the scroll container's bottom edge (menu ${Math.round(m.box.b)} vs scroller ${Math.round(d.scroller.b)}), so clipping could not be tested`);
  const below = Math.round(Math.min(m.box.b - 3, d.scroller.b + Math.min(24, (m.box.b - d.scroller.b) / 2)));
  ok(below > d.scroller.b, 'the probe point is really below the scroller');
  const hit = JSON.parse(await ev(`JSON.stringify(window.fx.hitAt(${Math.round(m.box.l + 8)}, ${below}))`));
  eq(hit.inMenu, true, `a point ${Math.round(below - d.scroller.b)} px below the scroller's bottom edge, inside the menu, hit-tests to ${hit.hit} instead of the menu — that is what a clipped menu looks like`);
  return `link at the scroller's bottom edge (${Math.round(lb.b)} of ${Math.round(d0.scroller.b)}), clicked ${pt.x},${pt.y}; menu ${box(m.box)} clears it by ${Math.round(m.box.b - d.scroller.b)}px and the pixel ${Math.round(below - d.scroller.b)}px past the edge is still the menu`;
});

check('b2', '§13.2.4 at the viewport\'s right edge the menu is pulled back inside instead of hanging off the screen', async () => {
  await resetMenus();
  await ev('JSON.stringify(window.fx.edge("corner"))');
  await untilSettled('document.querySelectorAll("#fxCorner .hd-pl-link").length >= 1');
  const lb = JSON.parse(await ev(`JSON.stringify(window.fx.linkBox(${JSON.stringify(P.FILE)}, "fxCorner"))`));
  const pt = JSON.parse(await ev(`JSON.stringify(window.fx.clickPoint(${JSON.stringify(P.FILE)}, "fxCorner"))`));
  must(pt.found, `the right-edge link has no clickable point (${JSON.stringify(pt)})`);
  ok(lb.r > lb.l, 'the link box is real');

  await browser.click(pt.x, pt.y);
  must(await until('window.fx.menuCount() === 1', 3000), 'the right-edge link opened no menu');
  const d = await jfx('dom("fxCorner")');
  must(d.menus.length === 1, `expected exactly one menu, dom saw ${d.menus.length}`);
  const m = d.menus[0];
  eq(m.insidePadded, true, `the menu is fully inside the window with 8 px to spare ${box(m.box)}`);
  ok(m.box.r <= d.viewport.w - 8 + 0.5, `the menu's right edge (${Math.round(m.box.r)}) is inside the window's (${d.viewport.w} − 8)`);
  ok(m.box.l >= 8 - 0.5, `and its left edge (${Math.round(m.box.l)}) did not fall off the other side`);
  eq(m.hitIsMenu, true, 'and its centre hit-tests to the menu');
  eq(m.position, 'fixed', 'still out of flow');
  /* The precondition, measured rather than assumed: put the menu back at the link's own left edge and
     it would overhang by this much — that is what there was to clamp. A link whose RIGHT edge is at
     the window is not the same claim, and with a hyphen in the path the wrap can stop well short of it. */
  const over = lb.l + m.box.w - (d.viewport.w - 8);
  ok(over > 0, `the menu (${Math.round(m.box.w)} px wide) placed at the link's left edge (${Math.round(lb.l)}) would overhang the window by ${Math.round(over)} px — so the clamp had work to do`);
  ok(m.box.l < lb.l - 0.5, `and it really moved: the menu sits at ${Math.round(m.box.l)}, left of the link's ${Math.round(lb.l)}`);
  ok(Math.abs((d.viewport.w - m.box.r) - 8) <= 1.5, `leaving exactly the 8 px gap the placement promises (measured ${Math.round(d.viewport.w - m.box.r)})`);
  return `link left ${Math.round(lb.l)} right ${Math.round(lb.r)} of ${d.viewport.w}; menu ${box(m.box)} would have overhung ${Math.round(over)} px at the link and was pulled ${Math.round(lb.l - m.box.l)} px left, 8 px clear of the edge`;
});

check('b3', '§13.2.4 at the bottom edge the menu flips above the link rather than hanging off the screen', async () => {
  await resetMenus();
  await ev('JSON.stringify(window.fx.edge("edge"))');
  await untilSettled('document.querySelectorAll("#fxEdge .hd-pl-link").length >= 1');
  const lb = JSON.parse(await ev(`JSON.stringify(window.fx.linkBox(${JSON.stringify(P.FILE)}, "fxEdge"))`));
  const pt = JSON.parse(await ev(`JSON.stringify(window.fx.clickPoint(${JSON.stringify(P.FILE)}, "fxEdge"))`));
  must(pt.found, `the bottom-edge link has no clickable point (${JSON.stringify(pt)})`);

  await browser.click(pt.x, pt.y);
  must(await until('window.fx.menuCount() === 1', 3000), 'the bottom-edge link opened no menu');
  const d = await jfx('dom("fxEdge")');
  must(d.menus.length === 1, `expected exactly one menu, dom saw ${d.menus.length}`);
  const m = d.menus[0];
  eq(m.insidePadded, true, `the menu is fully inside the window with 8 px to spare ${box(m.box)}`);
  ok(m.box.r <= d.viewport.w - 8 + 0.5, `its right edge (${Math.round(m.box.r)}) is inside the window's (${d.viewport.w} − 8)`);
  ok(m.box.b <= d.viewport.h - 8 + 0.5, `its bottom edge (${Math.round(m.box.b)}) is inside the window's (${d.viewport.h} − 8)`);
  ok(m.box.b <= lb.t + 0.5, `it was placed ABOVE the link (menu bottom ${Math.round(m.box.b)} vs link top ${Math.round(lb.t)}) — below was off-screen`);
  eq(m.hitIsMenu, true, 'and its centre hit-tests to the menu');
  ok(lb.b > d.viewport.h - 20, `the link really is at the bottom edge (${Math.round(lb.b)} of ${d.viewport.h})`);
  await resetMenus();
  await hide('fxCorner');
  await hide('fxEdge');
  await ev('window.fx.mountOn("fxList")');
  await untilSettled('true');
  eq(await ev('window.fx.menuCount()'), 0, 'the edge hosts are gone and no menu is left behind');
  return `link bottom ${Math.round(lb.b)} → menu ${box(m.box)}, flipped above; pane remounted on fxList, edges hidden`;
});

// ---------------------------------------------------------------- (c) closing it

check('c1', '§13.2.7 a real Escape closes the file menu', async () => {
  await resetMenus();
  /* the (b) checks left the pane scrolled to its bottom, where this link is off-screen — so scroll it
     back into view first: the click must land on a link a reader could actually see. */
  const pt = JSON.parse(await ev(`JSON.stringify(window.fx.showLink(${JSON.stringify(P.FILE)}))`));
  must(pt.found, `no clickable point inside the file link (${JSON.stringify(pt)})`);
  eq(pt.inPane, true, 'the link is inside the scrolled pane after the scroll');
  await browser.click(pt.x, pt.y);
  must(await until('window.fx.menuCount() === 1', 3000), 'no menu to close');
  const before = JSON.parse(await ev('JSON.stringify(window.HD.pathlink.state())'));
  eq(before.menu, true, 'the module says a menu is open');

  await browser.key('Escape', 'Escape', 27);
  eq(await ev('window.fx.menuCount()'), 0, 'a real Escape keypress left the menu on screen');
  const after = JSON.parse(await ev('JSON.stringify(window.HD.pathlink.state())'));
  eq(after.menu, false, 'the module forgot the menu too (no detached node kept alive)');
  eq(after.menu_path, null, 'and it forgot which link owned it');
  eq(OUT.open.length, 0, 'and closing the menu asked the server for nothing');
  return 'menuOpened → Escape → menuCount 0, state.menu false, no /api/open';
});

check('c2', '§13.2.7 a real click outside the menu closes it, and does nothing else', async () => {
  await resetMenus();
  const pt = JSON.parse(await ev(`JSON.stringify(window.fx.showLink(${JSON.stringify(P.FILE)}))`));
  must(pt.found, `no clickable point inside the file link (${JSON.stringify(pt)})`);
  eq(pt.inPane, true, 'the link is inside the scrolled pane after the scroll');
  await browser.click(pt.x, pt.y);
  must(await until('window.fx.menuCount() === 1', 3000), 'no menu to close');
  const before = JSON.parse(await ev('JSON.stringify(window.HD.pathlink.state())'));

  /* a point in the page's other column: outside the list, outside the menu, on nothing that acts */
  const aside = JSON.parse(await ev(`(function(){ var r = document.getElementById('fxAside').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 30) }); })()`));
  await browser.click(aside.x, aside.y);
  await sleep(120);
  eq(await ev('window.fx.menuCount()'), 0, 'a click outside the menu left it on screen');
  const after = JSON.parse(await ev('JSON.stringify(window.HD.pathlink.state())'));
  eq(after.menu, false, 'the module forgot the menu');
  eq(after.last_action, before.last_action, 'the dismissal was not an action: last_action is unchanged');
  eq(OUT.open.length, 0, 'and it asked the server for nothing');
  return `outside click at ${aside.x},${aside.y} → closed, no action, no request`;
});

check('c3', '§13.2.5/§13.2.6 the menu\'s own button posts the real path and action, shows the server\'s sentence verbatim, then closes itself', async () => {
  await resetMenus();
  const n0 = OUT.open.length;
  const pt = JSON.parse(await ev(`JSON.stringify(window.fx.showLink(${JSON.stringify(P.FILE)}))`));
  must(pt.found, `no clickable point inside the file link (${JSON.stringify(pt)})`);
  eq(pt.inPane, true, 'the link is inside the scrolled pane after the scroll');
  await browser.click(pt.x, pt.y);
  must(await until('window.fx.menuCount() === 1', 3000), 'no menu to act in');
  const d = await jfx('dom("fxList")');
  const m = d.menus[0];
  const reveal = m.btnBoxes[1];
  must(reveal && reveal.w > 0, 'the second action has no hit area');
  await browser.click(Math.round(reveal.l + reveal.w / 2), Math.round(reveal.t + reveal.h / 2));

  must(await until(`window.fx.menuNote() !== null && window.HD.pathlink.state().last_action !== null`, 4000),
    'the action never reported anything back');
  const rows = OUT.open.slice(n0);
  eq(rows.length, 1, 'exactly one /api/open for one click');
  const r = rows[0];
  eq(r.method, 'POST', 'it is a POST');
  eq(r.action, '1', '§13.2.6\'s x-hd-action: 1 travels with it');
  eq(r.sfs, 'same-origin', 'and the browser added Sec-Fetch-Site: same-origin by itself');
  ok(/application\/json/.test(r.contentType || ''), `Content-Type is application/json (got ${r.contentType})`);
  deep(r.body, { path: P.FILE, action: 'reveal' }, 'the body is the path and the action, and nothing else');

  const st = JSON.parse(await ev('JSON.stringify(window.HD.pathlink.state().last_action)'));
  eq(st.ok, true, 'the module recorded a success');
  eq(st.action, 'reveal', 'for the action that was clicked');
  eq(st.path, P.FILE, 'on the path that was clicked');
  eq(st.kind, 'file', 'and it read the kind off the link');
  const note = JSON.parse(await ev('JSON.stringify(window.fx.menuNote())'));
  eq(note.text, `handed to the system: ${P.FILE} (reveal)`, 'the menu shows the server\'s own sentence, verbatim');
  ok(!/hd-pl-bad/.test(note.cls), 'and it does not look like a refusal');

  const closed = await until('window.fx.menuCount() === 0', 4000);
  eq(closed, true, 'a successful reveal left the menu open — §13.2.7 says it closes itself');
  eq(await ev('window.fx.menuCount()'), 0, 'and it really is gone');
  return `Open File Location → POST /api/open {path, action:"reveal"} with x-hd-action and sec-fetch-site; note ${JSON.stringify(note.text)}; menu closed on its own`;
});

// ---------------------------------------------------------------- (d) Space, as Enter

check('d1', '§13.2.4 Space on a folder link opens it, and the outcome is the same one Enter gives (both real key events)', async () => {
  await resetMenus();
  const f = JSON.parse(await ev(`JSON.stringify(window.fx.focusLink(${JSON.stringify(P.DIR)}))`));
  must(f && f.focused, 'the folder link could not take focus (tabindex)');
  eq(f.tabindex, '0', 'and it is focusable by attribute');

  const n0 = OUT.open.length;
  await browser.key(' ', 'Space', 32);
  must(await until(`window.HD.pathlink.state().last_action !== null && window.HD.pathlink.state().last_action.path === ${JSON.stringify(P.DIR)}`, 4000),
    'a real Space on the folder link did nothing');
  const space = JSON.parse(await ev('JSON.stringify(window.HD.pathlink.state().last_action)'));
  eq(await ev('window.fx.menuCount()'), 0, 'a folder opens with no menu in the way (§13.2.4)');
  const madeAfterSpace = OUT.open.length - n0;
  eq(madeAfterSpace, 1, 'one action, one request');

  const at = space.at;
  await ev(`JSON.stringify(window.fx.focusLink(${JSON.stringify(P.DIR)}))`);
  await browser.key('Enter', 'Enter', 13);
  must(await until(`(function(){var a=window.HD.pathlink.state().last_action; return !!a && a.at !== ${at};})()`, 4000),
    'a real Enter on the folder link did nothing');
  const enter = JSON.parse(await ev('JSON.stringify(window.HD.pathlink.state().last_action)'));

  eq(enter.action, space.action, 'Enter and Space asked for the same action');
  eq(enter.ok, space.ok, 'and got the same outcome');
  eq(enter.path, space.path, 'on the same path');
  eq(enter.kind, space.kind, 'with the same kind');
  eq(enter.done, space.done, 'and the same sentence back from the server');
  eq(enter.action, 'open', 'the action really was the contract\'s "open"');
  eq(OUT.open[n0].body.action, 'open', 'and the server saw "open" in the body');
  eq(OUT.open.length - n0, 2, 'two key presses, two requests, no duplicates');
  return `Space and Enter both POSTed {path: DIR, action:"open"} and both read back ${JSON.stringify(space.done)}`;
});

check('d2', '§13.2.4 Space on a file link opens the in-page menu, as Enter does', async () => {
  await resetMenus();
  await ev(`JSON.stringify(window.fx.focusLink(${JSON.stringify(P.FILE)}))`);
  const nOpen = OUT.open.length;
  await browser.key(' ', 'Space', 32);
  must(await until('window.fx.menuCount() === 1', 3000), 'a real Space on the file link opened no menu');
  const m1 = JSON.parse(await ev('JSON.stringify(window.HD.pathlink.state())'));
  eq(m1.menu_path, P.FILE, 'the menu belongs to the file link that had focus');
  eq(OUT.open.length, nOpen, 'a file needs no request just to be asked about');
  await browser.key('Escape', 'Escape', 27);
  eq(await ev('window.fx.menuCount()'), 0, 'Escape closed it again');

  await ev(`JSON.stringify(window.fx.focusLink(${JSON.stringify(P.FILE)}))`);
  await browser.key('Enter', 'Enter', 13);
  must(await until('window.fx.menuCount() === 1', 3000), 'a real Enter on the file link opened no menu');
  const m2 = JSON.parse(await ev('JSON.stringify(window.HD.pathlink.state())'));
  eq(m2.menu_path, m1.menu_path, 'Enter and Space opened the same menu for the same link');
  eq(OUT.open.length, nOpen, 'and neither of them asked the server to open anything');
  await browser.key('Escape', 'Escape', 27);
  return 'Space and Enter both opened the file menu (menu_path = the same path); no /api/open from either';
});

// ---------------------------------------------------------------- (f) a real observer burst

check('f1', '§13.2.1 a whole-list replacement in one MutationObserver burst decorates every new path exactly once', async () => {
  await resetMenus();
  const n0 = OUT.pathinfo.length;
  const b = JSON.parse(await ev('JSON.stringify(window.fx.burst(12))'));
  eq(b.mountedOn, 'fxList', 'the burst has to land in the host the observer is watching, or it proves nothing');

  must(await untilSettled('document.querySelectorAll("#fxList .hd-pl-link").length >= 6'), 'the burst was never decorated');
  await sleep(300);                                    // a second pass would show up as more links
  const d = await jfx('dom("fxList")');
  eq(d.linkCount, 6, `each of the six paths must be decorated exactly once (saw ${d.linkCount} links)`);
  eq(d.nestedLinks, 0, 'and none of them inside another link');
  eq(Object.keys(d.byPath).length, 6, 'six distinct paths');
  for (const p of P.BURST) eq(d.byPath[p], 1, `the path ${p} must appear as exactly one link`);
  eq(d.state.links - b.linksBefore, 6, 'the module drew exactly six anchors for six paths — not twelve');
  ok(d.state.passes - b.passesBefore <= 3,
    `the burst cost ${d.state.passes - b.passesBefore} decorate passes, not one per row — the observer batched it`);
  /* the burst itself, as a real MutationObserver saw it: one callback carrying the whole replacement */
  const calls = await jfx('callsSoFar()');
  must(calls.length >= 1, 'the second observer saw no mutation at all — the list was not replaced in this document');
  eq(calls[0].added, 12, 'the whole replacement arrived in ONE observer callback, not one callback per row');
  ok(calls[0].removed >= 1, 'and the old rows were removed in the same callback');
  const rows = OUT.pathinfo.slice(n0);
  eq(rows.length, 1, `the burst cost exactly one request (saw ${rows.length})`);
  const asked = rows[0].body.paths;
  eq(asked.length, 6, 'and that request asked about exactly the six new paths');
  eq(new Set(asked).size, 6, 'with no duplicates');
  for (const p of P.BURST) ok(asked.indexOf(p) >= 0, `the request named ${p}`);
  ok(d.state.asked >= 6, 'the module counted them as asked');
  for (const l of d.links) eq(l.text, l.path, 'and every anchor still reads as its own path verbatim');
  return `12 rows replaced in one callback (${calls[0].records} records: ${calls[0].removed} removed, ${calls[0].added} added) → ${d.state.passes - b.passesBefore} decorate pass(es) → 1 POST with 6 paths → 6 links, each exactly once`;
});

check('f2', '§13.2.1 the same burst again re-draws every link with no new request — a path is never re-asked', async () => {
  const n0 = OUT.pathinfo.length;
  const b = JSON.parse(await ev('JSON.stringify(window.fx.burst(12))'));
  must(await untilSettled('document.querySelectorAll("#fxList .hd-pl-link").length >= 6'), 'the second burst was never decorated');
  await sleep(300);
  const d = await jfx('dom("fxList")');
  eq(OUT.pathinfo.length, n0, 'a re-render asked the server again — §13.2.1 forbids that');
  eq(d.linkCount, 6, 'each path still appears exactly once');
  for (const p of P.BURST) eq(d.byPath[p], 1, `the path ${p} is drawn once`);
  eq(d.state.links - b.linksBefore, 6, 'six new anchors for six known paths');
  const calls = await jfx('callsSoFar()');
  eq(calls[0].added, 12, 'and the second replacement was one observer callback too');
  return `second burst: ${OUT.pathinfo.length - n0} new requests, 6 links, ${d.state.passes - b.passesBefore} pass(es)`;
});

// ---------------------------------------------------------------- (g) the copy button, in the real DOM

check('g1', '§13.1.1 the copy button is a >=20x20 real target and the LAST child of its head row, for a message and for a tool card', async () => {
  await ev('JSON.stringify(window.fx.wireCopy({ checksCopy: false }))');
  const c = JSON.parse(await ev('JSON.stringify(window.fx.copyFixture())'));

  ok(c.copyBox.w >= 20 && c.copyBox.h >= 20, `the button measures ${c.copyBox.w}x${c.copyBox.h} — §13.1.1 wants >= 20x20`);
  ok(/(^|-)flex$/.test(c.inline), `the button lays itself out (computed display ${c.inline}) — as a flex item it is blockified, and the box above is its own`);
  eq(c.lastChild, true, `the copy button must be the LAST child of the head row (head children: ${JSON.stringify(c.headChildren)})`);
  eq(c.headChildren[c.headChildren.length - 1], 'BUTTON.hd-cv-copy', 'and the last child really is the button');
  eq(c.glyph, '⧉', 'the glyph is the contract\'s');
  eq(c.aria, 'copy this block', 'and its accessible name is the frozen one');
  ok(c.copyId && c.copyId.length > 0, 'it names the block it copies');
  eq(c.copyId, c.blockId, 'and the name matches the block row it sits in');
  eq(c.headNearestBlock, c.copyId, '§13.1.2: the nearest marked block at or above the button is the one it names');
  ok(c.headHasFoldheadValue, 'this head row is the fold target — which is what makes the ordering question real');
  eq(c.headHasFoldheadValue, 'fx-folded-1', 'and it is the fold key §10.9 froze, not the block id');
  eq(c.rowHasFoldhead, false, 'the foldhead marks the HEAD row, not the whole message row — that is the row the delegation looks for');

  ok(c.cardCopyBox && c.cardCopyBox.w >= 20 && c.cardCopyBox.h >= 20,
    `the tool card's copy button measures ${c.cardCopyBox && c.cardCopyBox.w}x${c.cardCopyBox && c.cardCopyBox.h}`);
  eq(c.cardLastChild, true, 'the tool card\'s copy button is the last child of its block head');
  eq(c.cardNearestBlock, c.cardCopyId, 'and it names the block it really sits in (a card has its own, deeper block id)');
  ok(c.cardCopyId !== c.copyId, 'the two blocks are not the same block');

  eq(c.copiedText, c.rawText, 'blockText() handed back the whole 25-line record, verbatim');
  eq(c.tailOnScreen, false, 'and the tail really is hidden by the fold — so the two are different strings');
  ok(/hidden/.test(c.foldStatText), `the folded block says what it is hiding (${JSON.stringify(c.foldStatText)})`);
  /* the count line's first number is what the fold HIDES (chat-render's foldForm), not what is drawn:
     one line of the body is the preview, the rest of it is behind the fold, and the tail behind the cap
     as well. Either way the number is real and smaller than the record, which is the point below. */
  const statChars = Number((c.foldStatText.match(/^([\d,]+)/) || [])[1]?.replace(/,/g, '') || 0);
  ok(statChars > 0 && statChars < c.copiedText.length,
    `the fold says it hides ${statChars} of the record's ${c.copiedText.length} chars — so what is drawn and what is copied are not the same string`);

  return `${c.copyBox.w}x${c.copyBox.h} at ${box(c.copyBox)}, last of ${c.headChildren.length} head children; blockText ${c.copiedText.length} chars while the fold hides ${statChars} of them`;
});

check('g2', '§13.1.1 the button\'s own centre belongs to the button, and the two controls do not overlap', async () => {
  const c = JSON.parse(await ev('JSON.stringify(window.fx.copyFixture())'));
  must(c.centres.btn, 'the button has no centre to click');
  eq(c.hitIsButton, true, `the element at the button's centre is ${c.hitIsButton ? 'the button' : 'NOT the button'} — geometry and hit-test disagree`);
  eq(c.hitIsFold, false, 'and the fold control is not what is under it');
  ok(!overlaps(c.copyBox, c.foldBox), `the copy target ${box(c.copyBox)} overlaps the fold target ${box(c.foldBox)}`);
  ok(c.foldBox && c.foldBox.w > 0 && c.foldBox.h > 0, 'the fold control has its own hit area');
  const gap = c.foldBox ? Math.round(c.copyBox.l - c.foldBox.r) : null;
  ok(gap !== null && gap >= 0, `they sit side by side, not stacked (gap ${gap}px)`);

  const hit = JSON.parse(await ev(`JSON.stringify(window.fx.hitAt(${c.centres.btn.x}, ${c.centres.btn.y}))`));
  eq(hit.inLink, false, 'the copy button is not inside a path link either');
  eq(await ev(`document.querySelectorAll('#fxCopy .hd-pl-link').length`), 0,
    'and the copy fixture drew no path link — the two features did not collide');
  return `copy ${box(c.copyBox)} vs fold ${box(c.foldBox)}: no overlap, centre hits the button, hit-test ${hit.hit}`;
});

check('g3', '§13.1.4 a real click on the copy button copies the WHOLE folded block and never reaches the fold handler above it', async () => {
  const grant = await browser.grant(BASE, ['clipboardReadWrite', 'clipboardSanitizedWrite']);
  ok(grant.ok, `the clipboard permissions could not be granted (${JSON.stringify(grant.error)}) — without them this check cannot say what the reader would get`);

  await ev('JSON.stringify(window.fx.wireCopy({ checksCopy: false }))');
  await ev('window.fx.resetCopy()');
  const c = JSON.parse(await ev('JSON.stringify(window.fx.copyFixture())'));
  const nSigs = await ev('window.fx.sigs.length');

  await browser.click(c.centres.btn.x, c.centres.btn.y);
  must(await until('window.fx.statuses.length === 1', 4000),
    'a real click on the copy button produced no status — the click never reached the copy behaviour');

  const st = (await jfx('statusesSoFar()'))[0];
  const n = c.copiedText.length;
  eq(st.ok, true, 'the status is a success');
  eq(st.text, `copied ${grouped(n)} chars`, `the status names the TRUE character count of the block (got ${JSON.stringify(st.text)})`);

  const mod = JSON.parse(await ev('JSON.stringify(window.fx.copyState())'));
  eq(mod.copies, 1, 'the shipped copy module recorded exactly one copy');
  eq(mod.refusals, 0, 'and no refusal');
  eq(mod.pending, 0, 'and nothing left in flight');
  eq(mod.last.chars, n, 'the count it recorded is the block\'s length');
  eq(mod.last.block_id, c.copyId, 'and it is attributed to the button\'s own block id');

  const rb = await ev(`navigator.clipboard.readText().then(function (t) { return JSON.stringify({ ok: true, text: t }); }, function (e) { return JSON.stringify({ ok: false, name: e && e.name, message: e && e.message }); })`);
  const back = JSON.parse(rb);
  must(back.ok === true, `the clipboard could not be read back (${back.name}: ${back.message})`);
  /* The ONE difference the platform is allowed to make: the Windows clipboard is a CRLF medium, so a
     LF string written by copy.js comes back with CRLF. Everything else must be byte-identical — hence
     the normalisation below is stated rather than silent, and the stray-CR assertion keeps it honest. */
  const nl = (t) => String(t).replace(/\r\n/g, '\n');
  const crlf = back.text.length !== nl(back.text).length;
  eq(nl(back.text), c.copiedText, 'what the clipboard HOLDS is the block, character for character (modulo the platform\'s CRLF)');
  eq(nl(back.text), c.rawText, 'and that block is the raw 25-line record, tail included');
  eq(/\r(?!\n)/.test(back.text), false, 'and the only convention in it is a CRLF — no stray carriage return');

  const cnt = await jfx('copyCounters()');
  eq(cnt.copyReachedAncestor, 0, `the copy click reached the fold delegation above the mount host ${cnt.copyReachedAncestor} times — §13.1.4 forbids it`);
  eq(cnt.foldAttempts, 0, 'and it did not even arrive there to be judged');
  eq(cnt.folds, 0, 'nothing folded');

  const now = JSON.parse(await ev('JSON.stringify(window.fx.copyNow())'));
  eq(now.foldedNow, c.foldedBefore, 'the block is in the same fold state it was in before the click');
  ok(/hd-cv-folded/.test(now.foldedNow), 'and that state is still "folded"');
  eq(now.tailOnScreen, false, 'the tail is still hidden from the reader — only the clipboard got it');
  eq(await ev('window.fx.sigs.length'), nSigs, 'the copy made no network request at all');
  return `click at ${c.centres.btn.x},${c.centres.btn.y} → ${st.text}; clipboard read back ${back.text.length} chars equal to blockText() (${crlf ? 'the platform turned its 24 LFs into CRLF: identical otherwise, no stray CR' : 'LF, character for character'}); fold handler above saw the click 0 times; fold state unchanged`;
});

check('g4', '§13.1.4 the hazard is real: with copy.js unmounted the very same click folds the block, so g3\'s zero is not vacuous', async () => {
  await ev('window.fx.unmountCopy()');
  await ev('window.fx.resetCopy()');
  const c = JSON.parse(await ev('JSON.stringify(window.fx.copyFixture())'));
  await browser.click(c.centres.btn.x, c.centres.btn.y);

  must(await until('window.fx.copyCounters().foldAttempts === 1', 3000),
    'with the copy module unmounted the click still never reached the fold delegation — then the counter proves nothing');
  const cnt1 = await jfx('copyCounters()');
  eq(cnt1.copyReachedAncestor, 1, 'the copy click DID reach the naive fold delegation once copy.js was gone');
  eq(cnt1.folds, 1, 'and it folded the block');
  eq(cnt1.lastFoldKey, 'fx-folded-1', 'on the message the button lives in (the head\'s own fold key)');
  eq((await jfx('statusesSoFar()')).length, 0, 'and nothing was copied');
  const now1 = JSON.parse(await ev('JSON.stringify(window.fx.copyNow())'));
  ok(!/hd-cv-folded/.test(now1.foldedNow), `the block really unfolded: the class went from ${c.foldedBefore} to ${now1.foldedNow}`);
  eq(now1.hasFoldStat, false, 'the folded preview\'s own marker is gone with it');
  ok(now1.drawnChars > c.drawnChars, `and the reader now gets the body instead of the one-line preview (${now1.drawnChars} characters drawn, was ${c.drawnChars})`);
  /* …but NOT the whole record: 25 lines is past §8.3's 20-line long-text cap, so the tail stays behind
     the CAP's own control. Two different mechanisms, and neither is the other's job — which is exactly
     why §13.1.2 has blockText read the raw record rather than what is drawn. */
  ok(now1.drawnChars < c.copiedText.length, `and the tail is still not drawn (${now1.drawnChars} of the block's ${c.copiedText.length} characters): the cap holds it, not the fold`);
  eq(now1.tailOnScreen, false, 'the tail is behind the "show all" control, not on screen');
  eq(now1.foldBtnText, '▾ fold', 'the control offers the opposite now');
  eq(now1.foldAria, 'true', 'and its aria-expanded says the message is expanded (A2.4: false means folded)');

  /* …and a bubble-phase handler CAN be written to survive it: the fix §13.1.4 asks a consumer for.
     copy.js stays UNMOUNTED for this half on purpose, and the reason is itself a finding: with it
     mounted its capture-phase listener stops the click at the mount host, so no bubble-phase ancestor
     sees it at all and the guard could never be observed. The comparison that means something is
     therefore the same click on the same delegation, one guarded and one not, both with the copy
     behaviour out of the way. On the real page the equivalent proof is W2's, with chatview.js's own
     delegation: this fixture's fold handler is the shape, not the thing. */
  await ev('window.fx.guard(true)');
  await ev('window.fx.resetCopy()');
  const c2 = JSON.parse(await ev('JSON.stringify(window.fx.copyFixture())'));
  await browser.click(c2.centres.btn.x, c2.centres.btn.y);
  must(await until('window.fx.copyCounters().foldAttempts === 1', 3000), 'the guarded handler never saw the click');
  const cnt2 = await jfx('copyCounters()');
  eq(cnt2.copyReachedAncestor, 1, 'the same click still arrives at the delegation');
  eq(cnt2.folds, 0, 'and this time the delegation declines it — the counter is live, not stuck');
  const now2 = JSON.parse(await ev('JSON.stringify(window.fx.copyNow())'));
  ok(/hd-cv-folded/.test(now2.foldedNow), 'and the block is exactly where it was: still folded, nothing redrawn');
  eq(now2.hasFoldStat, true, 'still carrying the folded preview\'s marker, untouched');
  eq(now2.tailOnScreen, false, 'with the tail still off screen');
  await ev('window.fx.guard(false)');
  return `the hazard unguarded: reached ${cnt1.copyReachedAncestor}, folded ${cnt1.folds}× (fold undone, ${now1.drawnChars} chars drawn instead of the preview); guarded: reached ${cnt2.copyReachedAncestor}, folded ${cnt2.folds}× (still folded, ${now2.drawnChars} chars drawn)`;
});

// ---------------------------------------------------------------- (e) the 8 s abort, with a real AbortController

check('e1', '§13.2.8 the request for the unanswered path carries a real AbortSignal from the engine\'s own AbortController', async () => {
  const shown = await ev('typeof AbortController === "function" && typeof AbortSignal === "function"');
  eq(shown, true, 'this engine has AbortController/AbortSignal, so the timeout path can really be taken');
  const n0 = OUT.pathinfo.length;
  const h = JSON.parse(await ev('JSON.stringify(window.fx.hang())'));

  must(await until(`window.fx.sigs.length > 0 && window.fx.sigs[window.fx.sigs.length - 1].body.indexOf('hang-me') >= 0`, 5000),
    'no /api/pathinfo request went out for the unanswered path');
  const sig = (await jfx('sigsSoFar()')).slice(-1)[0];
  eq(sig.method, 'POST', 'the request is a POST');
  eq(sig.isAbortSignal, true, 'the init carried an AbortSignal instance — not a lookalike object');
  eq(sig.aborted, null, 'and it is not aborted yet');
  eq(sig.headers['x-hd-action'], '1', 'the hanging request carries §13.2.6\'s x-hd-action: 1 like every other one');
  eq(OUT.pathinfo.length - n0, 1, 'exactly one request went out for it');
  const asked = OUT.pathinfo[OUT.pathinfo.length - 1].body.paths;
  /* §13.2.3 asks READINGS, not one canonical path: the extractor hands the server every reading it
     can see ("<path>", "<path> is", "<path> is the one…"), and the SERVER is what adjudicates which
     one is real. So the honest claim is that this request is about the unanswered path and nothing
     else — every reading begins with it, and the path itself is among them. */
  ok(asked.length >= 1 && asked.every((s) => s === h.path || s.indexOf(h.path + ' ') === 0),
    `every reading in that request is the unanswered path plus trailing words (got ${JSON.stringify(asked)})`);
  ok(asked.indexOf(h.path) >= 0, 'and the path itself is one of them, so the honest reading was asked');
  eq(asked.filter((s) => s === h.path).length, 1, 'and it was asked exactly once');
  ok(asked.every((s) => s.indexOf(P.FILE) < 0 && s.indexOf(P.DIR) < 0 && s.indexOf(P.BURST[0]) < 0),
    'with no reading of any path the module already had an answer for');
  eq(OUT.holds >= 1, true, 'the stub API is holding that request open, so time is the only thing that can end it');
  return `POST /api/pathinfo carrying ${asked.length} readings of the unanswered path, with a real AbortSignal and x-hd-action: ${sig.headers['x-hd-action']}`;
});

check('e2', '§13.2.8 while the server has not answered, nothing is decorated, nothing is retried and nothing is reported', async () => {
  await sleep(1500);                                   // well inside §13.2.8's 8 s
  const sig = (await jfx('sigsSoFar()')).slice(-1)[0];
  eq(sig.aborted, null, 'the signal fired early — 8 s had not passed');
  const d = await jfx('dom("fxList")');
  ok(!d.byPath[P.HANG], 'the unanswered path was decorated without an answer');
  ok(d.listText.indexOf(P.HANG) >= 0, 'and its text is still plain and still there');
  eq(OUT.pathinfo.length >= 1, true, 'the request is still the only one');
  eq(d.state.available, true, 'the module has not given up: the request is out, not dead');
  const held = await ev(`document.querySelectorAll("#fxList .hd-pl-link").length >= 6`);
  eq(held, true, 'the links the burst drew are still on screen while the answer is outstanding');
  return `after 1.5s: signal un-aborted, ${P.HANG} still plain text, no retry, module still available`;
});

check('e3', '§13.2.8 after 8 s the signal aborts for real, the module degrades honestly, and asking stops for good', async () => {
  const t0 = Date.now();
  const fired = await until('window.fx.sigs[window.fx.sigs.length - 1].aborted === true', 12000, 200);
  const took = Date.now() - t0;
  must(fired, 'the AbortController never fired — the request would have hung for ever');
  ok(took > 5000, `the abort came after ${took}ms — the 8 s timeout is what ended it, and nothing else`);

  const st = JSON.parse(await ev('JSON.stringify(window.HD.pathlink.state())'));
  eq(st.last_error && st.last_error.code, 'timeout', `the module recorded the honest reason (${JSON.stringify(st.last_error)})`);
  ok(/8000/.test((st.last_error && st.last_error.message) || ''), 'and the reason names the 8 s it waited');
  eq(st.available, false, 'an unanswered server is treated as no server: decoration stops');
  const d = await jfx('dom("fxList")');
  ok(!d.byPath[P.HANG], 'the unanswered path is STILL plain text, not a link');
  ok(d.listText.indexOf(P.HANG) >= 0, 'and still on screen');
  eq(d.linkCount, 6, 'and the links that had answers are untouched');
  eq(d.state.known, 8, 'the module still remembers what it knows (the 6 burst paths plus the file and the folder the earlier checks confirmed)');

  eq(OUT.hangClosed >= 1, true, 'the browser really cancelled the request at the socket (the stub API saw it close without an answer)');

  /* the decisive one: a new candidate after the degrade is not even asked about */
  const n0 = OUT.pathinfo.length;
  await ev('JSON.stringify(window.fx.probe("extra"))');
  await sleep(1200);
  eq(OUT.pathinfo.length, n0, 'a new path was asked about after the module had degraded — §13.2.8 says asking stops');
  const d2 = await jfx('dom("fxList")');
  ok(!d2.byPath[P.EXTRA], 'and the new path was left as plain text');
  ok(d2.listText.indexOf(P.EXTRA) >= 0, 'without being removed or rewritten');
  eq(d2.state.mounted, true, 'the mount is still alive — it just cannot ask any more');
  eq(d2.state.available, false, 'and it says plainly why it is not asking');
  return `aborted after ${Math.round(took / 100) / 10}s of waiting (8 s timeout + scheduling); last_error ${JSON.stringify(st.last_error.code)}; asking stopped (new path left alone)`;
});

// ---------------------------------------------------------------- run

let BASE = null;

async function main() {
  /* Preflight, before anything is spawned: the fixture and every file the page will be asked about
     must be on disk, because the stub API answers from the disk — a missing file would look like a
     product bug. This suite is self-contained, so a failure here means the repo, not a scratch dir. */
  if (!fs.existsSync(FIXTURE)) {
    throw new Fail(`the fixture is missing: ${FIXTURE} — it ships in test/fixtures/pathlink-live/ with this suite`);
  }
  for (const p of [P.FILE, P.HANG, P.EXTRA]) {
    if (!fs.existsSync(p)) throw new Fail(`the fixture path ${p} is not on this disk, and the stub API answers from the disk`);
  }

  let port = 7300 + (process.pid % 100);
  for (let i = 0; i < 40; i++) { if (await portFree(port)) break; port++; }
  BASE = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  console.log('herdr-dash — test/pathlink-live.mjs (W3, §13.1/§13.2)');
  console.log('A standalone fixture loading the SHIPPED public/lib files, driven by real headless Chrome:');
  console.log(`  fixture  ${FIXTURE}`);
  console.log(`  served   / → the page, /fx/* → that directory, /lib/* and /style.css → public/ (the app's own URLs)`);
  console.log(`  server   ${BASE} (static files + a stub /api/pathinfo that stats this repository)`);
  console.log('  window   asked for 1520x900, real Input.dispatchMouseEvent / Input.dispatchKeyEvent');
  console.log('  note     this is NOT the app: index.html, app.js, chatview.js and style.css are untouched');
  console.log('');

  await browser.open();
  console.log(`  chrome   pid ${browser.proc.pid}, DevTools on 127.0.0.1:${browser.port}, profile ${browser.profileDir}`);
  console.log('');
  await browser.reload(BASE + '/');
  console.log(`  viewport ${await ev('JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })')} — the real one, as every check below sees it`);
  console.log('');
  await sleep(150);

  for (const c of checks) {
    CUR = { id: c.id, n: 0, fails: [] };
    let detail = '';
    try {
      detail = await c.fn();
    } catch (e) {
      if (!(e instanceof Stop)) {
        CUR.fails.push(`threw: ${e && e.message ? e.message : String(e)}`);
      }
    }
    const bad = CUR.fails.length > 0;
    results.push({ id: c.id, name: c.name, ok: !bad, n: CUR.n, fails: CUR.fails });
    if (bad) {
      console.log(`FAIL ${c.id} ${c.name}`);
      for (const f of CUR.fails.slice(0, 8)) console.log(`       · ${f}`);
      if (CUR.fails.length > 8) console.log(`       · …and ${CUR.fails.length - 8} more`);
    } else {
      console.log(`PASS ${c.id} ${c.name}`);
      if (detail) console.log(`       · ${detail}`);
    }
    CUR = null;
  }
  await browser.close();
  return results;
}

let code = 1;
try {
  await main();
  const failed = results.filter((r) => !r.ok);
  const asserts = results.reduce((s, r) => s + r.n, 0);
  console.log('');
  console.log(`TOTAL: ${results.length - failed.length}/${results.length} checks passed (${asserts} assertions)`);
  code = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.log(`FAIL harness — ${e && e.message ? e.message : String(e)}`);
  code = 1;
} finally {
  for (const res of OUT.held) { try { res.destroy(); } catch { /* gone */ } }
  browser.close();
  const ports = [];
  try {
    const a = server.address();
    if (a) ports.push(a.port);
  } catch { /* never bound */ }
  await new Promise((resolve) => { try { server.close(resolve); } catch { resolve(); } });
  await sleep(300);
  console.log('');
  console.log(`cleanup: chrome killed, profile removed, stub server closed; ports ${ports.join(', ') || '(none bound)'}${browser.port ? ' and ' + browser.port : ''} are free`);
}
process.exit(code);
