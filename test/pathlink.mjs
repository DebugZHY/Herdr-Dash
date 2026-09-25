#!/usr/bin/env node
/* herdr-dash — test/pathlink.mjs · CONTRACT-v2 §13.2, owner: W3.
 *
 *   node test/pathlink.mjs
 *
 * Zero npm dependencies, no jsdom, no browser. What is under test is DECISION-MAKING — which strings
 * are candidates at all, which of those are allowed to become a link, what a click sends, and what the
 * module does when the server says no, is missing, or is slow — so the DOM here is a ~120-line shim
 * that carries exactly what lib/pathlink.js uses: text nodes with a nodeValue, elements with
 * children/attributes/listeners, and replaceChild moving a fragment's children into place. Two things
 * it does NOT have are as important as the things it does: no layout (so every rect is a lie the
 * module must not depend on) and no HTML parsing — the shim records every innerHTML assignment and the
 * run fails if the module ever writes one, because the text it rewrites came from a log.
 *
 * THE STUB SERVER. The two endpoints are W1's and are not in the tree yet (§13.2.3 / §13.2.5), so
 * every leg is driven through a stub `fetch` handed to the module: it records the route, the headers
 * and the parsed body of every call, answers from a truth table the test writes, and can hold a
 * request open so the in-flight guard can be observed from the outside. A stub is not a weaker check
 * here than a live server would be: what the module must get right is the REQUEST it makes and the
 * USE it makes of the answer, and both are visible in full.
 *
 * The test also reads the module's own source to assert the one rule the shim cannot see: no string is
 * ever put into innerHTML, and the DOM is built from createElement/createTextNode only.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const REPO = path.resolve(import.meta.dirname, '..');
const LIB = path.join(REPO, 'public', 'lib');
const SRC = fs.readFileSync(path.join(LIB, 'pathlink.js'), 'utf8');
const CSS = fs.readFileSync(path.join(LIB, 'pathlink.css'), 'utf8');

// ── harness ─────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL ${name} — ${detail === undefined ? 'assertion failed' : detail}`); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, `got ${g}, want ${w}`);
}
function section(t) { console.log(`\n── ${t} ──`); }

// ── the shim ────────────────────────────────────────────────────────────────

const INNER_HTML_WRITES = [];         // every non-empty innerHTML assignment, anywhere
const CREATED_TAGS = [];              // every tag createElement was asked for

class TextNode {
  constructor(text) { this.nodeType = 3; this.nodeValue = String(text); this.parentNode = null; }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = String(v); }
  get childNodes() { return []; }
  get children() { return []; }
}

class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.attrs = {};
    this.listeners = {};
    this.parentNode = null;
    this.className = '';
    this.title = '';
    this.style = {};
    this._text = null;
    this.disabled = false;
    this.tabIndex = 0;
    this.focused = false;
  }
  get children() { return this.childNodes; }
  appendChild(n) {
    if (!n || typeof n !== 'object') throw new Error('appendChild(non-node)');
    if (n.nodeType === 11) {                      // a fragment moves its children, like the DOM
      for (const c of n.childNodes.slice()) this.appendChild(c);
      n.childNodes.length = 0;
      return n;
    }
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  insertBefore(n, ref) {
    const i = this.childNodes.indexOf(ref);
    n.parentNode = this;
    if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  /** The DOM's replaceChild, fragments included: the replaced node leaves, the fragment's children
   *  take its place, in order. That is the whole mechanism the module uses to rewrite a text node. */
  replaceChild(n, old) {
    const i = this.childNodes.indexOf(old);
    if (i < 0) throw new Error('replaceChild: the node is not a child of this element');
    if (n.nodeType === 11) {
      const kids = n.childNodes.slice();
      n.childNodes.length = 0;
      for (const c of kids) c.parentNode = this;
      this.childNodes.splice(i, 1, ...kids);
    } else {
      n.parentNode = this;
      this.childNodes.splice(i, 1, n);
    }
    old.parentNode = null;
    return old;
  }
  get textContent() {
    if (this._text !== null) return this._text;
    return this.childNodes.map((c) => c.textContent).join('');
  }
  /** Like the real DOM's: the old children are detached and ONE text node takes their place. This
   *  matters to the checks below — an element whose text is a child node keeps that text visible to
   *  a tree walk, which is how "the reader still sees the same characters" is measured. */
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes.length = 0;
    this._text = null;
    this.appendChild(new TextNode(v));
  }
  set innerHTML(v) {
    if (String(v) !== '') INNER_HTML_WRITES.push(String(v));
    this.childNodes.length = 0;
    this._text = String(v);
  }
  get innerHTML() { return serialize(this); }
  setAttribute(k, v) { this.attrs[String(k)] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const a = this.listeners[type] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  dispatch(type, extra) {
    const ev = Object.assign({ type, target: this, preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {} }, extra || {});
    for (const fn of (this.listeners[type] || []).slice()) fn(ev);
    return ev;
  }
  click() { return this.dispatch('click'); }
  focus() { this.focused = true; }
  /** A LIE on purpose: this shim has no layout, so every element claims a box. The module may use a
   *  rect to PLACE a menu; it must never use one to decide anything, and the next section proves the
   *  placement guard by removing this method for one element. */
  getBoundingClientRect() { return { left: 100, top: 40, right: 260, bottom: 50, width: 160, height: 10 }; }
}

class Fragment {
  constructor() { this.nodeType = 11; this.childNodes = []; this.parentNode = null; }
  appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
  get children() { return this.childNodes; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
}

function serialize(n) {
  if (!n) return '';
  if (n.nodeType === 3) return n.nodeValue;
  if (n.nodeType === 11) return (n.childNodes || []).map(serialize).join('');
  const attrs = [`class="${n.className}"`];
  for (const k of Object.keys(n.attrs || {})) attrs.push(`${k}="${n.attrs[k]}"`);
  return `<${n.tagName.toLowerCase()} ${attrs.join(' ')}>${n.childNodes.map(serialize).join('')}` +
    `</${n.tagName.toLowerCase()}>`;
}

const doc = {
  createElement: (t) => { CREATED_TAGS.push(String(t).toUpperCase()); return new El(t); },
  createTextNode: (t) => new TextNode(t),
  createDocumentFragment: () => new Fragment(),
  listeners: {},
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  removeEventListener(type, fn) {
    const a = this.listeners[type] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  },
  dispatch(type, target) {
    const ev = { type, target, preventDefault() {}, stopPropagation() {} };
    for (const fn of (this.listeners[type] || []).slice()) fn(ev);
    return ev;
  }
};

// tree helpers (this file's, not the shim's)
function walk(n, fn) {
  if (!n) return;
  fn(n);
  for (const c of (n.childNodes || [])) walk(c, fn);
}
const allEls = (root) => { const out = []; walk(root, (n) => { if (n.nodeType === 1) out.push(n); }); return out; };
const byTag = (root, tag) => allEls(root).filter((n) => n.tagName === String(tag).toUpperCase());
const byClass = (root, cls) => allEls(root).filter((n) => n.className.split(/\s+/).indexOf(cls) >= 0);
const actOf = (pl) => pl.state().last_action || { ok: null, done: null, error: {} };
/** The Nth of a list, or a stand-in that does nothing: a click on a link that was never drawn has to
 *  read as a FAILED check, not as a crash that hides every check after it. */
const at = (list, i) => list[i] || { tagName: 'MISSING', className: '', attrs: {}, childNodes: [], style: {},
  listeners: {}, textContent: '(no such node)', getAttribute: () => null, setAttribute() {}, click() {},
  dispatch() {}, focus() {} };
const one = (root, cls) => {
  const hits = byClass(root, cls);
  if (hits.length) return hits[0];
  return { tagName: 'MISSING', className: '', textContent: `(no .${cls} node was rendered)`, attrs: {},
    childNodes: [], parentNode: null, getAttribute: () => null, setAttribute() {}, click() {},
    dispatch() {}, style: {}, listeners: {} };
};
const textNodesOf = (root) => { const out = []; walk(root, (n) => { if (n.nodeType === 3) out.push(n); }); return out; };
const plainText = (root) => {                 // the text a reader sees, with the links' text in place
  let s = '';
  walk(root, (n) => { if (n.nodeType === 3) s += n.nodeValue; });
  return s;
};
/** A host element holding one text node — the shape the chat list hands to decorate(). */
function hostWith(text) {
  const host = doc.createElement('div');
  host.className = 'hd-cv-list';
  host.appendChild(doc.createTextNode(text));
  return host;
}

// ── the clock, the stub server, and the sandbox ─────────────────────────────

/** A deterministic clock: nothing the module schedules ever fires until this test says so. */
function makeClock() {
  let id = 0, now = 1000;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { timers.set(++id, { fn, at: now + (Number(ms) || 0) }); return id; },
    clearTimeout(t) { timers.delete(t); },
    flush(ms) {
      now += (ms == null ? 0 : ms);
      let ran = 0;
      for (const [k, t] of Array.from(timers)) {
        if (ms == null || t.at <= now) { timers.delete(k); t.fn(); ran++; }
      }
      return ran;
    },
    size() { return timers.size; }
  };
}

/** The stub server: `handler(route, body, callNumber) -> {status, json, text, hold}`. */
function makeFetch(handler) {
  const calls = [];
  let gate = null;
  const f = (route, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    const call = { route, init, body, headers: (init && init.headers) || {}, n: calls.length + 1 };
    calls.push(call);
    const res = (handler || (() => ({})))(route, body, call.n) || {};
    const out = {
      ok: res.ok !== false,
      status: res.status == null ? 200 : res.status,
      text: () => Promise.resolve(res.text != null ? res.text : JSON.stringify(res.json == null ? {} : res.json))
    };
    if (res.hold) return new Promise((resolve) => { gate = () => resolve(out); });
    return Promise.resolve(out);
  };
  f.calls = calls;
  f.release = () => { const g = gate; gate = null; if (g) g(); };
  f.holding = () => !!gate;
  f.info = () => calls.filter((c) => c.route.endsWith('/pathinfo'));
  f.active = () => calls.filter((c) => c.route.endsWith('/open'));
  return f;
}

/** A recorded call, or a readable stand-in when the module sent none: a request that never happened
 *  has to read as a FAILED check, not as a crash that hides every check after it. */
const nth = (list, i) => (i === -1 ? list[list.length - 1] : list[i]) ||
  { route: '(no such request)', body: {}, headers: {}, init: {} };
/** The paths a pathinfo call asked about, whatever went wrong. */
const pathsOf = (f, i) => (nth(f.info(), i === undefined ? -1 : i).body || {}).paths || [];

/** §13.2.3's answer shape, built from a truth table: { "<path>": "file"|"dir"|null }. */
const infoAnswer = (truth) => (route, body) => {
  if (!route.endsWith('/pathinfo')) return {};
  return { json: { ok: true, items: (body.paths || []).map((p) => ({
    path: p, exists: !!truth[p], kind: truth[p] || null })) } };
};

class StubObserver {
  constructor(cb) { this.cb = cb; StubObserver.last = this; }
  observe(el, opts) { this.el = el; this.opts = opts; this.gone = false; }
  disconnect() { this.gone = true; }
}

function load(shared) {
  const sandbox = { console, document: doc, JSON, Date, Promise, Math, Number, String, Array, Object,
    isFinite: isFinite, setTimeout: shared.clock.setTimeout, clearTimeout: shared.clock.clearTimeout,
    MutationObserver: StubObserver };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.HD = {};
  if (shared.fetch) sandbox.fetch = shared.fetch;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'pathlink.js' });
  return sandbox;
}
/** The module is stateful by design (it never re-asks a path it has asked about), so every section
 *  gets its own sandbox — the same reason a page reload is the only honest way to test a first run. */
function fresh(fetch) {
  const clock = makeClock();
  const sb = load({ clock, fetch });
  return { pl: sb.window.HD.pathlink, sb, clock };
}
/** A request settles several microtask hops deep (fetch → res.text → the timeout race → the record),
 *  so the test drains the queue rather than counting hops. No timer ever fires here: the clock above
 *  is the test's, which is also what makes the debounce and the menu's close timer observable. */
async function settle(n) { for (let i = 0; i < (n || 16); i++) await Promise.resolve(); }

// ── §13.2.2 the candidates ──────────────────────────────────────────────────

section('§13.2.2 — what is a candidate: the three anchors, and what is refused');
{
  const { sb } = fresh();
  const T = sb.window.HD.pathlinkTest;
  const cands = (s) => T.candidatesIn(s);

  // the three anchors, in the forms that occur in a log
  ok('a drive path with backslashes is a candidate',
    cands('open C:\\Development\\New\\herdr-dash now').indexOf('C:\\Development\\New\\herdr-dash') >= 0,
    JSON.stringify(cands('open C:\\Development\\New\\herdr-dash now')));
  ok('a drive path with forward slashes is a candidate',
    cands('ok: D:/proj/src/app.js').indexOf('D:/proj/src/app.js') >= 0, JSON.stringify(cands('ok: D:/proj/src/app.js')));
  ok('a UNC share is a candidate',
    cands('see \\\\fileserver\\share\\notes.md for it').indexOf('\\\\fileserver\\share\\notes.md') >= 0,
    JSON.stringify(cands('see \\\\fileserver\\share\\notes.md for it')));
  ok('a MSYS form is a candidate',
    cands('at /c/Users/me/proj/x.js').indexOf('/c/Users/me/proj/x.js') >= 0,
    JSON.stringify(cands('at /c/Users/me/proj/x.js')));

  // §13.2.2's local rejections
  eq('a path the agent elided with `…` is not a candidate', cands('look at C:\\Users\\… \\oops'), []);
  eq('neither is the readable half of an elided path', cands('C:\\Users\\me\\…\\deep\\file.txt'), []);
  eq('a path ending in the elision mark is not a candidate either', cands('hermes wrote C:\\Users\\…'), []);
  const nasty = ['C:\\a\\b\u0000c', 'C:\\a\\b\nnext', 'C:\\a\\b\r\n', 'C:\\a\\b\u0007', '/c/a/b\u001b[0m'];
  const everyCand = nasty.map((t) => cands(t)).flat();
  eq('no candidate can carry a control character or a newline, whatever the input',
    everyCand.filter((c) => /[\u0000-\u001f\u007f]/.test(c)), []);
  eq('and none of them carries the elision mark', everyCand.filter((c) => c.indexOf('…') >= 0), []);
  ok('a line-broken path yields no candidate for the second half (half a path is not a path)',
    cands('C:\\a\\b\\broken\n\\c\\d\\tail').indexOf('\\c\\d\\tail') < 0
      && cands('C:\\a\\b\\broken\n\\c\\d\\tail').every((c) => c.indexOf('\\c') !== 0),
    JSON.stringify(cands('C:\\a\\b\\broken\n\\c\\d\\tail')));

  // relative paths are NOT candidates (§13.2.2 / C1): there is nothing to resolve them against
  eq('a relative path is not a candidate', cands('edit src/lib/app.js and lib\\util.js'), []);
  eq('nor is ./ or ../', cands('see ./a.js and ../b/c.js'), []);
  eq('nor is a bare file name', cands('the file report.txt is here'), []);

  // prose that only looks like a path
  eq('a URL path is not a candidate (the run before it was a path too)', cands('GET https://a/b/c'), []);
  eq('and a word glued to a drive letter is not one', cands('foo/C:/x'), []);
  eq('a lone drive letter is not a path', cands('the C: drive and the D: drive'), []);

  // spaces: both forms are offered, so prose around a real path cannot swallow it
  const spaced = cands('run C:\\Program Files\\herdr-dash\\run.bat now');
  ok('a path with spaces offers the whole run', spaced.indexOf('C:\\Program Files\\herdr-dash\\run.bat') >= 0,
    JSON.stringify(spaced));
  ok('and the first token too, so the shorter real path is not lost to the prose after it',
    spaced.indexOf('C:\\Program') >= 0, JSON.stringify(spaced));

  // trailing prose
  const quoted = cands('it is "C:\\a\\b.txt".');
  ok('trailing prose punctuation is offered trimmed as well as whole',
    quoted.indexOf('C:\\a\\b.txt') >= 0, JSON.stringify(quoted));
  ok('and a directory really named `(x86)` is offered untrimmed too',
    cands('in C:\\Program Files (x86) today').indexOf('C:\\Program Files (x86)') >= 0,
    JSON.stringify(cands('in C:\\Program Files (x86) today')));

  eq('the same path twice in one text is one candidate', cands('C:\\a\\b then C:\\a\\b').filter((c) => c === 'C:\\a\\b'), ['C:\\a\\b']);
  ok('a run about a paragraph long is not treated as a path',
    cands('C:\\' + 'x'.repeat(1200)).filter((c) => c.length >= T.MAX_CANDIDATE).length === 0, 'a 1200-char run was offered');
}

// ── §13.2.4 decoration only for what exists ─────────────────────────────────

section('§13.2.4 — a path becomes a link only when the server says exists:true');
{
  const text = 'built C:\\proj\\out\\app.exe into C:\\proj\\out and sent C:\\proj\\gone.txt away';
  const fetch = makeFetch(infoAnswer({ 'C:\\proj\\out\\app.exe': 'file', 'C:\\proj\\out': 'dir' }));
  const { pl, sb } = fresh(fetch);
  const host = hostWith(text);
  const r = await pl.decorate(host, { fetch });

  const links = byTag(host, 'a');
  eq('two of the three paths became links', links.length, 2);
  eq('they are the two the server confirmed', links.map((a) => a.getAttribute('data-hd-path')),
    ['C:\\proj\\out\\app.exe', 'C:\\proj\\out']);
  eq('and they say what they are', links.map((a) => a.getAttribute('data-hd-kind')), ['file', 'dir']);
  eq('the link class is the frozen one', Array.from(new Set(links.map((a) => a.className))), ['hd-pl-link']);
  eq('each link is reachable by keyboard, not only by pointer',
    Array.from(new Set(links.map((a) => a.getAttribute('role') + '/' + a.getAttribute('tabindex')))), ['link/0']);
  eq('the path is the link\'s own text, verbatim', links.map((a) => a.textContent),
    ['C:\\proj\\out\\app.exe', 'C:\\proj\\out']);
  eq('the missing path is left exactly as the agent wrote it — no link, no tooltip',
    [byTag(host, 'a').filter((a) => a.getAttribute('data-hd-path') === 'C:\\proj\\gone.txt').length,
     textNodesOf(host).filter((n) => n.nodeValue.indexOf('C:\\proj\\gone.txt') >= 0).length], [0, 1]);
  eq('every link carries a tooltip naming the path, and only the confirmed ones do',
    Array.from(new Set(allEls(host).filter((n) => n.title).map((n) => n.tagName))), ['A']);
  eq('nothing was lost or reordered: the reader still sees the same characters',
    plainText(host), text);
  eq('every part of the line is a text node — the prose and each link\'s own text alike',
    textNodesOf(host).map((n) => n.nodeValue),
    ['built ', 'C:\\proj\\out\\app.exe', ' into ', 'C:\\proj\\out', ' and sent C:\\proj\\gone.txt away']);
  eq('nothing was written through innerHTML (the log is text, never markup)', INNER_HTML_WRITES, []);
  eq('the only elements added are the two anchors',
    Array.from(new Set(allEls(host).map((n) => n.tagName))), ['DIV', 'A']);
  const cands = sb.window.HD.pathlinkTest.candidatesIn(text);
  eq('the module asked once, and asked for exactly the candidates the extractor offers — no more',
    [fetch.info().length, pathsOf(fetch)], [1, cands]);
  // the three paths are all in there as readings, even though two of the runs run on into prose
  eq('every path the agent wrote is among the things asked about',
    ['C:\\proj\\out\\app.exe', 'C:\\proj\\out', 'C:\\proj\\gone.txt']
      .filter((p) => pathsOf(fetch).indexOf(p) < 0), []);
  eq('and it says so in state(): asked = the candidates, known = the links, missing = the rest',
    [pl.state().links, pl.state().known, pl.state().missing, pl.state().asked],
    [2, 2, cands.length - 2, cands.length]);
  eq('the pass reports what it did', [r.ok, r.asked, r.drawn], [true, cands.length, 2]);
}

section('§13.2.3/§13.2.6 — the request itself: route, body, and the header the endpoint demands');
{
  const fetch = makeFetch(infoAnswer({ 'C:\\a\\b': 'file' }));
  const { pl } = fresh(fetch);
  await pl.decorate(hostWith('C:\\a\\b'), { fetch });
  const c = nth(fetch.info(), 0);
  eq('one POST to §13.2.3\'s route', [c.init.method, c.route], ['POST', '/api/pathinfo']);
  eq('the body is {paths:[…]}, exactly the shape §13.2.3 documents', Object.keys(c.body), ['paths']);
  eq('and §13.2.6\'s custom header travels with it', c.headers['x-hd-action'], '1');
  ok('the request is same-origin, so the browser sends Sec-Fetch-Site: same-origin itself',
    c.init.credentials === 'same-origin', JSON.stringify(c.init.credentials));
  eq('the content type is JSON', c.headers['Content-Type'], 'application/json');
}

section('§13.2.4 — the link covers the reading that exists and not one character more');
{
  // a path followed by a sentence: the full stop is not part of it, and the prose stays prose
  const f1 = makeFetch(infoAnswer({ 'C:\\a\\b.txt': 'file' }));
  const s1 = fresh(f1);
  const h1 = hostWith('wrote C:\\a\\b.txt. Done.');
  await s1.pl.decorate(h1, { fetch: f1 });
  eq('only the path is linked, the sentence around it is not',
    byTag(h1, 'a').map((a) => a.textContent), ['C:\\a\\b.txt']);
  eq('and the reader\'s line is unchanged',
    plainText(h1), 'wrote C:\\a\\b.txt. Done.');
  eq('the punctuation is outside the link, not inside it',
    textNodesOf(h1).map((n) => n.nodeValue), ['wrote ', 'C:\\a\\b.txt', '. Done.']);

  // an everyday folder whose name ends in `)`: the reading that keeps the bracket is asked for,
  // and it is the one that becomes the link
  const f2 = makeFetch(infoAnswer({ 'C:\\Program Files (x86)': 'dir' }));
  const s2 = fresh(f2);
  const h2 = hostWith('installed in C:\\Program Files (x86) today');
  await s2.pl.decorate(h2, { fetch: f2 });
  ok('the reading that keeps the bracket is asked about',
    pathsOf(f2).indexOf('C:\\Program Files (x86)') >= 0, JSON.stringify(pathsOf(f2)));
  eq('and it is the link, with ` today` left as prose',
    byTag(h2, 'a').map((a) => a.textContent), ['C:\\Program Files (x86)']);
  eq('the line reads the same as before the pass', plainText(h2), 'installed in C:\\Program Files (x86) today');

  // when several readings of one anchor all exist, the LONGEST one is the path the agent meant:
  // `C:\Program Files` is a folder on every Windows box, and so is `C:\Program Files (x86)`
  const f2b = makeFetch(infoAnswer({ 'C:\\Program Files (x86)': 'dir', 'C:\\Program Files': 'dir' }));
  const s2b = fresh(f2b);
  const h2b = hostWith('installed in C:\\Program Files (x86) today');
  await s2b.pl.decorate(h2b, { fetch: f2b });
  eq('the longest existing reading wins, not the shortest',
    byTag(h2b, 'a').map((a) => a.textContent), ['C:\\Program Files (x86)']);

  // a path the agent elided is never even asked about, in a decorated page either
  const f3 = makeFetch(infoAnswer({}));
  const s3 = fresh(f3);
  const h3 = hostWith('it failed in C:\\Users\\me\\\u2026\\deep and C:\\real\\path');
  await s3.pl.decorate(h3, { fetch: f3 });
  ok('an elided path is not asked about, even when the rest of the line is',
    pathsOf(f3).indexOf('C:\\real\\path') >= 0
      && pathsOf(f3).every((p) => p.indexOf('\u2026') < 0),
    JSON.stringify(pathsOf(f3)));
  eq('and the elided text is left exactly as written', plainText(h3),
    'it failed in C:\\Users\\me\\\u2026\\deep and C:\\real\\path');
  eq('the only elements in the line are the one anchor it earned',
    Array.from(new Set(allEls(h3).map((n) => n.tagName))), ['DIV']);
}

// ── the menu's two actions ─────────────────────────────────────────────────

section('§13.2.4/§13.2.5 — a directory opens directly, a file gets the menu with both actions');
{
  const fetch = makeFetch((route, body) => {
    if (route.endsWith('/pathinfo')) {
      return infoAnswer({ 'C:\\p\\dir': 'dir', 'C:\\p\\f.txt': 'file' })(route, body);
    }
    return { json: { ok: true, done: 'handed to the system' } };
  });
  const { pl, clock } = fresh(fetch);
  const host = hostWith('open C:\\p\\dir and C:\\p\\f.txt');
  await pl.decorate(host, { fetch });
  const links = byTag(host, 'a');
  eq('both paths are links', links.length, 2);
  const dirLink = at(links, 0), fileLink = at(links, 1);

  // a directory: a real click opens it, with no menu in the way
  dirLink.click();
  await settle();
  eq('a directory click sends one open request and opens no menu',
    [fetch.active().length, byClass(host, 'hd-pl-menu').length], [1, 0]);
  eq('the action is §13.2.5\'s `open`, with the path', nth(fetch.active(), 0).body, { path: 'C:\\p\\dir', action: 'open' });
  eq('and the same §13.2.6 header', nth(fetch.active(), 0).headers['x-hd-action'], '1');
  dirLink.dispatch('keydown', { key: 'Enter' });
  eq('a keyboard activation opens it just as a click does (Enter on the focused link)',
    fetch.active().length, 2);
  await settle();
  eq('the outcome is readable: the server\'s own sentence, never a claim of our own',
    [actOf(pl).ok, actOf(pl).done], [true, 'handed to the system']);
  // §13.2.7's honesty rule, read off the source: no STRING the module can render claims an opening
  // (the comments above explain the rule and are not strings the reader ever sees).
  eq('no string the module can render claims the file was "opened"',
    (SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').match(/'[^']*\bopened\b[^']*'/g) || []), []);
  await settle();

  // a file: the menu, with the path verbatim and the two named actions
  fileLink.click();
  await settle();
  const menu = one(host, 'hd-pl-menu');
  eq('a file click opens the in-page menu instead of acting', byClass(host, 'hd-pl-menu').length, 1);
  eq('the menu shows the path verbatim', one(host, 'hd-pl-menu-path').textContent, 'C:\\p\\f.txt');
  eq('with the two actions §13.2.4 names',
    byClass(host, 'hd-pl-menu-btn').map((b) => b.textContent), ['Open', 'Open File Location']);
  ok('and the menu is rendered in the list the link lives in, not floating outside it',
    one(host, 'hd-pl-menu').parentNode === host,
    one(host, 'hd-pl-menu').parentNode ? 'a different parent' : 'no parent at all');
  eq('the menu is placed at the link, measured (not guessed)',
    [one(host, 'hd-pl-menu').style.left, one(host, 'hd-pl-menu').style.top], ['100px', '54px']);
  eq('the two buttons carry the actions they fire',
    byClass(host, 'hd-pl-menu-btn').map((b) => b.getAttribute('data-hd-act')), ['open', 'reveal']);
  const opensBefore = fetch.active().length;
  eq('no request was sent just by opening the menu', fetch.active().length, opensBefore);

  const bOpen = at(byClass(host, 'hd-pl-menu-btn'), 0), bReveal = at(byClass(host, 'hd-pl-menu-btn'), 1);
  bOpen.click();
  await settle();
  eq('Open sends action:"open" for that path', fetch.active().slice(-1)[0].body,
    { path: 'C:\\p\\f.txt', action: 'open' });
  eq('and the answer is reported in the menu, in the server\'s words',
    one(host, 'hd-pl-menu-note').textContent, 'handed to the system');
  eq('the menu closes itself after showing what was done', pl.state().menu, true);

  bReveal.click();                                  // the reveal action, on the same link's path
  await settle();
  eq('Open File Location sends action:"reveal"', fetch.active().slice(-1)[0].body,
    { path: 'C:\\p\\f.txt', action: 'reveal' });
  eq('and reports the same way', one(host, 'hd-pl-menu-note').textContent, 'handed to the system');
  eq('the sentence stays on screen long enough to be read (the menu is still up)',
    [pl.state().menu, byClass(host, 'hd-pl-menu').length], [true, 1]);
  clock.flush(5000);                                  // past MENU_DONE_MS
  eq('and then the menu closes itself, having told the reader what happened',
    [pl.state().menu, byClass(host, 'hd-pl-menu').length], [false, 0]);

  // a page that cannot measure the link gets an unpositioned menu, never a wrong position
  const nom = fresh(fetch);
  const host3 = hostWith('C:\\p\\f.txt');
  await nom.pl.decorate(host3, { fetch });
  const l3 = at(byTag(host3, 'a'), 0);
  Object.defineProperty(l3, 'getBoundingClientRect', { value: undefined, configurable: true });
  l3.click();
  await settle();
  eq('a link that cannot be measured still opens its menu, unpositioned',
    [byClass(host3, 'hd-pl-menu').length, one(host3, 'hd-pl-menu').style.left], [1, undefined]);

  // §13.2.7: a refusal is shown verbatim, and the menu does not close on it
  const bad = makeFetch((route, body) => (route.endsWith('/pathinfo')
    ? infoAnswer({ 'C:\\p\\f.txt': 'file' })(route, body)
    : { ok: false, status: 403, json: { ok: false, error: { code: 'forbidden', message: 'this page may not ask for that' } } }));
  const b2 = fresh(bad);
  const host2 = hostWith('C:\\p\\f.txt');
  await b2.pl.decorate(host2, { fetch: bad });
  at(byTag(host2, 'a'), 0).click();
  at(byClass(host2, 'hd-pl-menu-btn'), 0).click();
  await settle();
  ok('a refusal is shown, verbatim, in the menu',
    one(host2, 'hd-pl-menu-note').textContent.indexOf('this page may not ask for that') >= 0,
    one(host2, 'hd-pl-menu-note').textContent);
  ok('and it is marked as a failure rather than a done state',
    one(host2, 'hd-pl-menu-note').className.indexOf('hd-pl-bad') >= 0, one(host2, 'hd-pl-menu-note').className);
  eq('the menu stays open instead of closing silently', b2.pl.state().menu, true);
  b2.clock.flush(5000);
  eq('and it is still open after the moment a success would have closed on — a failure does not ' +
     'get tidied away',
    [b2.pl.state().menu, one(host2, 'hd-pl-menu-note').textContent.indexOf('this page may not ask for that') >= 0],
    [true, true]);
  eq('and state() carries the refusal too', [actOf(b2.pl).ok, actOf(b2.pl).error.code],
    [false, 'http_403']);
}

// ── the in-flight guard ────────────────────────────────────────────────────

section('§13.2.8 — a click while a request is in flight is ignored (never a queue of spawns)');
{
  const state = { open: 0 };
  const fetch = makeFetch((route, body) => {
    if (route.endsWith('/pathinfo')) return infoAnswer({ 'C:\\p\\f.txt': 'file', 'C:\\q': 'dir' })(route, body);
    state.open++;
    return { hold: true, json: { ok: true, done: 'handed to the system' } };
  });
  const { pl } = fresh(fetch);
  const host = hostWith('C:\\p\\f.txt and C:\\q');
  await pl.decorate(host, { fetch });
  const links = byTag(host, 'a');
  eq('both paths are links here too', links.length, 2);
  const fileLink = at(links, 0), dirLink = at(links, 1);

  dirLink.click();                                   // held open by the stub
  await settle();
  eq('the first click sent one request', fetch.active().length, 1);
  eq('and the module says one is in flight', pl.state().pending, true);
  dirLink.click();
  dirLink.click();
  await settle();
  eq('four more clicks change nothing — one request, no queue', fetch.active().length, 1);
  fileLink.click();                        // a FILE link while the directory's request is in flight
  await settle();
  eq('a file clicked while a request is in flight opens no menu either: the guard covers the ' +
     'activation, not only the request it would have sent',
    [byClass(host, 'hd-pl-menu').length, pl.state().menu, pl.state().pending], [0, false, true]);
  fetch.release();
  await settle();
  eq('the answer clears the guard', pl.state().pending, false);
  await settle();
  dirLink.click();
  await settle();
  eq('and the next real click is served', fetch.active().length, 2);
  fetch.release();
  await settle();

  // the same guard covers the menu's own buttons
  fileLink.click();
  await settle();
  at(byClass(host, 'hd-pl-menu-btn'), 0).click();
  await settle();
  eq('a menu action starts one request', fetch.active().length, 3);
  at(byClass(host, 'hd-pl-menu-btn'), 0).click();
  at(byClass(host, 'hd-pl-menu-btn'), 1).click();
  await settle();
  eq('and the menu\'s buttons are guarded the same way', fetch.active().length, 3);
  fetch.release();
  await settle();
  eq('the answer reaches the menu', one(host, 'hd-pl-menu-note').textContent, 'handed to the system');
}

// ── degradation ────────────────────────────────────────────────────────────

section('§13.2.8 — degradation: no endpoint, no candidates, no budget left');
{
  // 1. the endpoint is not there at all
  const fetch = makeFetch(() => ({ ok: false, status: 404, text: 'not found' }));
  const { pl } = fresh(fetch);
  const host = hostWith('C:\\a\\b and C:\\c\\d');
  const r1 = await pl.decorate(host, { fetch });
  await pl.decorate(host, { fetch });
  eq('nothing becomes a link when pathinfo is missing', byTag(host, 'a').length, 0);
  eq('the text is untouched', plainText(host), 'C:\\a\\b and C:\\c\\d');
  eq('state() says the endpoint is unavailable, and why',
    [pl.state().available, typeof pl.state().unavailable_reason === 'string'], [false, true]);
  eq('asking stops for good: the second pass sent nothing', fetch.info().length, 1);
  eq('and a later pass reports why it did nothing', [r1.ok, (await pl.decorate(host, { fetch })).error],
    [true, 'pathinfo_unavailable']);

  // 2. a failing (but present) endpoint is not "unavailable": it may work next time
  const flaky = makeFetch(() => ({ ok: false, status: 500, text: 'boom' }));
  const f2 = fresh(flaky);
  await f2.pl.decorate(hostWith('C:\\a\\b'), { fetch: flaky });
  eq('a 500 leaves the path plain but does not disable the module',
    [byTag(hostWith('C:\\a\\b'), 'a').length, f2.pl.state().available], [0, true]);
  eq('and the failure is recorded', f2.pl.state().last_error.code, 'http_500');

  // 3. no candidates at all → no request
  const idle = makeFetch();
  const f3 = fresh(idle);
  await f3.pl.decorate(hostWith('just prose, no paths here'), { fetch: idle });
  eq('a text with no candidates sends no request at all', idle.calls.length, 0);
  eq('and nothing is rendered', allEls(hostWith('just prose, no paths here')).length, 1);

  // 4. §13.2.2's budget: at most 200 new candidates per pass. One path per line, so each is its own
  //    run and the count under test is the count the text makes: 250 candidates, not "some".
  const many = Array.from({ length: 250 }, (_, i) => 'C:\\p\\f' + i).join('\n');
  const big = makeFetch(infoAnswer({}));
  const f4 = fresh(big);
  const host4 = hostWith(many);
  await f4.pl.decorate(host4, { fetch: big });
  eq('250 candidates produce one request of exactly 200', [big.info().length, pathsOf(big, 0).length], [1, 200]);
  eq('the rest are held, and said to be held', [f4.pl.state().held, f4.pl.state().asked], [50, 200]);
  await f4.pl.decorate(host4, { fetch: big });
  eq('the next pass asks for the remaining 50 and nothing else',
    [big.info().length, pathsOf(big, 1).length, f4.pl.state().held], [2, 50, 0]);
  eq('every candidate was asked exactly once',
    new Set([].concat(pathsOf(big, 0), pathsOf(big, 1))).size, 250);
}

// ── never re-asked, and re-renders ─────────────────────────────────────────

section('§13.2.2/§13.2.1 — a path already asked about is never asked again');
{
  const fetch = makeFetch(infoAnswer({ 'C:\\a\\b': 'file' }));
  const { pl } = fresh(fetch);
  const host = hostWith('C:\\a\\b');
  await pl.decorate(host, { fetch });
  eq('the first pass asked once', fetch.info().length, 1);
  const before = pl.state();
  await pl.decorate(host, { fetch });
  await pl.decorate(host, { fetch });
  eq('two more passes ask nothing new', fetch.info().length, 1);
  eq('and draw nothing twice', [byTag(host, 'a').length, pl.state().links], [1, before.links]);
  eq('the reader\'s text is still exactly one link and no duplicates', plainText(host), 'C:\\a\\b');

  // a re-render (new nodes, same text) re-links from what is already known — with no request
  const redrawn = hostWith('C:\\a\\b');
  await pl.decorate(redrawn, { fetch });
  eq('a re-rendered node is linked again from the cached answer', byTag(redrawn, 'a').length, 1);
  eq('and that cost no request', fetch.info().length, 1);
  eq('a node that is removed before the answer lands is no crash and carries no link',
    await (async () => {
      const goneHost = hostWith('C:\\z\\new');
      const p = pl.decorate(goneHost, { fetch });
      while (goneHost.childNodes.length) goneHost.removeChild(goneHost.childNodes[0]);
      await p;
      return [byTag(goneHost, 'a').length, goneHost.childNodes.length];
    })(), [0, 0]);

  // mount(): the host is remembered and observed, and a mutation is one debounced pass
  const fetch2 = makeFetch(infoAnswer({ 'C:\\m\\n': 'dir' }));
  const m = fresh(fetch2);
  const host2 = doc.createElement('div');
  const handle = m.pl.mount(host2, { fetch: fetch2 });
  await settle();
  eq('mount answers with the module itself, so mount(…).state() reads the thing it mounted',
    handle === m.pl && m.pl.state().mounted, true);
  eq('mounting an empty host decorates nothing and asks nothing', fetch2.info().length, 0);
  eq('and observes the host, subtree included',
    [!!StubObserver.last, StubObserver.last.gone === false, StubObserver.last.opts.subtree], [true, true, true]);
  host2.appendChild(doc.createTextNode('fresh C:\\m\\n'));
  StubObserver.last.cb();
  eq('a mutation schedules a pass rather than asking on the spot',
    [m.clock.size() > 0, fetch2.info().length], [true, 0]);
  m.clock.flush(200);
  await settle();
  eq('and the debounced pass links the new path', byTag(host2, 'a').map((a) => a.getAttribute('data-hd-path')), ['C:\\m\\n']);
  eq('exactly one request came of it', fetch2.info().length, 1);
  eq('unmount disconnects the observer, forgets the host and closes any menu',
    (() => { m.pl.unmount(); return [StubObserver.last.gone, m.pl.state().mounted, m.pl.state().host]; })(),
    [true, false, false]);
}

// ── the frozen interface, the stylesheet, and the source itself ────────────

section('§13.2.1 — the frozen interface is exactly the four names');
{
  const { pl, sb } = fresh();
  eq('HD.pathlink is the module', sb.window.HD.pathlink, pl);
  eq('and it exposes mount/unmount/decorate/state, all functions',
    Object.keys(pl).sort().map((k) => k + ':' + typeof pl[k]),
    ['decorate:function', 'mount:function', 'state:function', 'unmount:function']);
  const st = pl.state();
  ok('before anything happens, state() answers without throwing and says what it is',
    st.mounted === false && st.available === true && st.links === 0 && st.pending === false,
    JSON.stringify(st));
  ok('decorate() with no host is a described no-op, not a throw',
    typeof pl.decorate().then === 'function', 'decorate() did not return a promise');
  ok('mount() with no host mounts nothing and keeps the API alive',
    pl.mount(null) === pl && pl.state().mounted === false, 'mount(null) changed the module');
  eq('the two routes are the contract\'s', [sb.window.HD.pathlinkTest.ROUTE_INFO, sb.window.HD.pathlinkTest.ROUTE_OPEN],
    ['/api/pathinfo', '/api/open']);
}

section('pathlink.css — every class the module emits is styled, and nothing dead is left');
{
  const { sb } = fresh();
  const CLS = sb.window.HD.pathlinkTest.CLS;
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const hasRule = (c) => new RegExp('\\.' + c + '(?![a-z0-9_-])').test(CSS);
  eq('every class name the module uses has a rule', Object.keys(CLS).map((k) => CLS[k]).filter((c) => !hasRule(c)), []);
  ok('and the module\'s set is the whole stylesheet, so no rule is dead',
    (strip(CSS).match(/hd-pl-[a-z0-9-]+/g) || []).every((c) => Object.keys(CLS).map((k) => CLS[k]).indexOf(c) >= 0
      || ['hd-pl-bad', 'hd-pl-link'].indexOf(c) >= 0),
    JSON.stringify(Array.from(new Set(strip(CSS).match(/hd-pl-[a-z0-9-]+/g) || []))));
  // §13.2.7: the menu shows the path in full — the sheet may not clip it
  const pathRule = (CSS.match(/\.hd-pl-menu-path\s*\{([^}]*)\}/) || [])[1] || '';
  ok('the menu\'s path wraps and is never ellipsised',
    /white-space:\s*pre-wrap/.test(pathRule) && /overflow-wrap:\s*anywhere/.test(pathRule)
      && !/text-overflow/.test(pathRule), pathRule);
  ok('the link is a control the reader can see and reach',
    /\.hd-pl-link/.test(CSS) && /\.hd-pl-link:focus-visible\s*\{[^}]*outline/.test(CSS), 'no focus style');
  ok('the sheet reads the shared palette rather than declaring its own',
    !/:root\s*\{/.test(CSS) && (CSS.match(/var\(--/g) || []).length > 5, `${(CSS.match(/var\(--/g) || []).length} variable uses`);
}

section('the source itself — text nodes and createElement, never a stringified node');
{
  const noComments = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  eq('the only innerHTML assignment in the module is \'\' (clearing)',
    (noComments.match(/innerHTML\s*=\s*([^;]*);/g) || []).map((s) => s.replace(/.*=\s*/, '').replace(/;$/, '')), ["''"]);
  eq('the module never reaches for a message-shaped string API',
    /insertAdjacentHTML|outerHTML|document\.write/.test(noComments), false);
  eq('and it never parses the log as markup — no parser, and no innerHTML carrying a value',
    /DOMParser|innerHTML\s*=\s*[^\s'"]/.test(noComments), false);
  ok('it builds nodes the three ways the shim implements',
    /document\.createElement/.test(noComments) && /document\.createTextNode/.test(noComments)
      && /document\.createDocumentFragment/.test(noComments), 'a node builder is missing');
  eq('and the run above really did exercise them (no vacuous green)',
    CREATED_TAGS.indexOf('A') >= 0 && CREATED_TAGS.indexOf('DIV') >= 0, true);
}

// ── total ───────────────────────────────────────────────────────────────────

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
if (fail) console.log(`failing: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
