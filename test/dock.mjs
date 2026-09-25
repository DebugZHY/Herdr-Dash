#!/usr/bin/env node
/* herdr-dash — test/dock.mjs · the side dock module (CONTRACT-v2 §12.2, owner: W3).
 * Zero npm dependencies, no jsdom, no live server, no browser.
 *
 * WHAT THIS FILE PROVES, AND HOW
 *
 *   public/lib/dock.js is loaded into a sandbox with a small DOM, a CONTROLLED CLOCK, fake timers
 *   and a STUBBED fetch, and driven through its real code path: the module's own `poll()` issues the
 *   request, the stubbed fetch answers with a §12.3 body, and the assertions read the tree the module
 *   built. Nothing here calls a helper that builds the DOM for it — if the module's poll did not run,
 *   the assertions see an empty host.
 *
 *   The fixtures are CONTRACT-v2 §12.3's own samples, captured live from the panes (hermes with a
 *   status line and two processes, claude with a footer with and without `% until auto-compact`,
 *   claude's `usage` record). They are ground truth: a value on screen that differs by one character
 *   from the fixture is a defect, and this file says so.
 *
 *   The honesty bar is asserted in BOTH directions, which is the only way it can be asserted at all:
 *   a hermes body must render hermes' shape and contain NO claude node, a claude body must render
 *   claude's shape with NO hermes row and NO bar. "used_pct is the response's number, not recomputed"
 *   is asserted by rendering two bodies whose token counts are IDENTICAL and whose used_pct differs —
 *   a recomputed percentage would move with the tokens.
 *
 *   The `d` key belongs to W2's shell (§12.2.1), so this module claims no shortcut: the run asserts
 *   it registers no key listener anywhere and emits no `keys.register`. The `#dockHost`-absent path
 *   is its own state — mount nothing, keep the API alive, put nothing on the wire, adopt the host
 *   when it appears.
 *
 *   A COLLAPSED DOCK (§12.2's errata, DEFECT-20) is its own section, and it is measured the way Hermes
 *   measured the defect: a window of ticks with the panel closed, and a count of what went on the
 *   wire — which must be nothing. The world has W2's own shell (`<aside id="dock">` holding the host),
 *   the class is flipped the way W2 flips it (`classList.toggle('collapsed', …)`, delivered to the
 *   observer in a microtask, with no event), and the reopening must read ONCE, at once, with no tick
 *   waited for. A page with no MutationObserver at all is a separate case: there the module keeps its
 *   tick and re-checks, and still asks nothing. What a paused dock must NOT do is present the answer
 *   it is holding as current — the reopening keeps those numbers only inside the same not-current
 *   block a failed read uses, and `latest()` is not re-stamped, so W2's chip can age it out.
 *
 * Usage: node test/dock.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const REPO = path.resolve(import.meta.dirname, '..');
const LIB = path.join(REPO, 'public', 'lib');
const DOCK_SRC = fs.readFileSync(path.join(LIB, 'dock.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(LIB, 'dock.css'), 'utf8');
const STYLE_SRC = fs.readFileSync(path.join(REPO, 'public', 'style.css'), 'utf8');

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
/* the answer a test is holding back, released if the read that was supposed to create it happened at
   all: a mutation that stops the read must FAIL the assertion about it, not throw here and take the
   rest of the section down with it */
function held(fn) { return typeof fn === 'function' ? fn() : null; }
/* one microtask flush is not enough for a promise chain through a stubbed fetch */
async function settle() { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); }

// ── the shim: a DOM with only what dock.js uses, plus a fake clock and fake timers ──

const INNER_HTML_WRITES = [];               // every non-empty innerHTML assignment, anywhere

class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.parentNode = null;
    this._text = null;
    this._obs = null;                 // the MutationObservers watching THIS node's class
    this._cls = '';
    this.title = '';
    this.hidden = false;
    this.style = {};
    this.id = '';
  }
  /* className and classList write the same thing, and both tell the observers — which is the signal
     §12.2's errata turns on (W2 flips `collapsed` on W2's own <aside id="dock"> and emits no event) */
  get className() { return this._cls; }
  set className(v) { this._cls = String(v === null || v === undefined ? '' : v); this._notifyClass(); }
  _classes() { return this._cls.split(/\s+/).filter((c) => c !== ''); }
  _notifyClass() {
    if (!this._obs || !this._obs.length) return;
    const recs = [{ type: 'attributes', attributeName: 'class', target: this }];
    for (const o of this._obs.slice()) {
      /* the real MutationObserver delivers in a MICROTASK, not on the line that changed the class:
         the shim is faithful about that, so a module that only read the class inside its own timer
         would fail these checks */
      const fire = () => { if (o.live) o.cb(recs, o); };
      if (typeof queueMicrotask === 'function') queueMicrotask(fire); else setImmediate(fire);
    }
  }
  get classList() {
    const self = this;
    return {
      contains(w) { return self._classes().indexOf(String(w)) >= 0; },
      add(w) { if (self._classes().indexOf(String(w)) < 0) self.className = self._classes().concat([String(w)]).join(' '); },
      remove(w) { const l = self._classes().filter((c) => c !== String(w)); if (l.length !== self._classes().length) self.className = l.join(' '); },
      toggle(w, force) {
        const has = self._classes().indexOf(String(w)) >= 0;
        const want = (force === undefined) ? !has : !!force;
        if (want === has) return want;
        if (want) this.add(w); else this.remove(w);
        return want;
      }
    };
  }
  appendChild(n) {
    if (!n || typeof n !== 'object') throw new Error('appendChild(non-node)');
    this.children.push(n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) {
    const i = this.children.indexOf(n);
    if (i < 0) throw new Error('removeChild(a node that is not a child)');
    this.children.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get firstChild() { return this.children.length ? this.children[0] : null; }
  get childNodes() { return this.children; }
  /* the spec's rule: reading textContent concatenates this node's own text with every descendant's */
  get textContent() { return (this._text === null ? '' : this._text) + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children.length = 0; this._text = String(v); }
  set innerHTML(v) {
    if (String(v) !== '') INNER_HTML_WRITES.push({ tag: this.tagName, html: String(v) });
    this.children.length = 0;
    this._text = String(v);
  }
  get innerHTML() { return html(this); }
  /* href is a REFLECTED attribute in the real DOM: assigning the property writes the attribute, which
     is why a page's own <link href> and a module-built one read the same way */
  get href() { return Object.prototype.hasOwnProperty.call(this.attrs, 'href') ? this.attrs.href : ''; }
  set href(v) { this.attrs.href = String(v); }
  setAttribute(k, v) { this.attrs[String(k)] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const l = this.listeners[type] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  dispatch(type) {
    const ev = { type, target: this, preventDefault() {}, stopPropagation() {} };
    for (const fn of (this.listeners[type] || []).slice()) fn(ev);
    return ev;
  }
  click() { return this.dispatch('click'); }
  /* a deliberately tiny matcher: the module asks for '.hd-dock' and '.hd-dock-x' and nothing else */
  querySelector(sel) { const h = this.querySelectorAll(sel); return h.length ? h[0] : null; }
  querySelectorAll(sel) {
    const want = String(sel).replace(/^\./, '');
    return allEls(this).filter((n) => n.className.split(/\s+/).indexOf(want) >= 0);
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function html(n) {
  if (!n) return '';
  const attrs = [];
  if (n.className) attrs.push(`class="${esc(n.className)}"`);
  if (n.title) attrs.push(`title="${esc(n.title)}"`);
  if (n.hidden) attrs.push('hidden');
  for (const k of Object.keys(n.attrs || {})) attrs.push(`${k}="${esc(n.attrs[k])}"`);
  const tag = String(n.tagName || '?').toLowerCase();
  return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>` +
    (n._text === null ? '' : esc(n._text)) + (n.children || []).map(html).join('') + `</${tag}>`;
}
function allEls(root) {
  const out = [];
  const walk = (n) => { for (const c of n.children || []) { if (c.nodeType === 1) { out.push(c); walk(c); } } };
  walk(root);
  return out;
}

class Doc {
  constructor() {
    this.createElement = (t) => new El(t);
    this.byId = {};
    this.head = new El('head');
    this.body = new El('body');
    this.listeners = {};
    this.hidden = false;
    this._links = [];
  }
  add(el, id) { el.id = id; this.byId[id] = el; return el; }
  getElementById(id) { return Object.prototype.hasOwnProperty.call(this.byId, id) ? this.byId[id] : null; }
  getElementsByTagName(tag) {
    const t = String(tag).toLowerCase();
    if (t === 'head') return [this.head];
    if (t === 'body') return [this.body];
    /* the real thing walks the tree: a <link> the module appended itself is found like any other */
    return allEls(this.head).concat(allEls(this.body)).filter((n) => n.tagName.toLowerCase() === t);
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const l = this.listeners[type] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  dispatch(type) { const ev = { type, target: this }; for (const fn of (this.listeners[type] || []).slice()) fn(ev); }
  addLink(href) {
    const l = new El('link');
    l.setAttribute('href', href);
    this._links.push(l);
    this.head.appendChild(l);
    return l;
  }
  /* a link may carry its href as the attribute (a page) or as the property (a module building one) */
  linksTo(name) {
    return this.getElementsByTagName('link')
      .filter((l) => String(l.getAttribute('href') || l.href || '').indexOf(name) >= 0);
  }
}

class Timers {
  constructor() { this.seq = 0; this.items = new Map(); }
  setInterval(fn, ms) { const id = ++this.seq; this.items.set(id, { kind: 'interval', fn, ms }); return id; }
  setTimeout(fn, ms) { const id = ++this.seq; this.items.set(id, { kind: 'timeout', fn, ms }); return id; }
  clearInterval(id) { this.items.delete(id); }
  clearTimeout(id) { this.items.delete(id); }
  of(kind) { return [...this.items.values()].filter((t) => t.kind === kind); }
  msOf(kind) { return [...this.items.values()].filter((t) => t.kind === kind).map((t) => t.ms).sort((a, b) => a - b); }
  fire(kind, ms) {
    let n = 0;
    for (const t of [...this.items.values()]) {
      if (t.kind !== kind) continue;
      if (ms !== undefined && t.ms !== ms) continue;
      n++; t.fn();
    }
    return n;
  }
}

class AbortCtl {
  constructor() { this.signal = { aborted: false }; }
  abort() { this.signal.aborted = true; }
}

/* MutationObserver, as far as dock.js uses it: `new MutationObserver(cb)`, `observe(node, {attributes})`
   and `disconnect()`. `live` is the shim's own record of whether the observer is still attached:
   a disconnected observer must never fire again (that is what unmount() has to get right). */
class Watch {
  constructor(cb) { this.cb = cb; this.nodes = []; this.live = true; }
  observe(node) {
    if (this.nodes.indexOf(node) < 0) this.nodes.push(node);
    if (!node._obs) node._obs = [];
    if (node._obs.indexOf(this) < 0) node._obs.push(this);
  }
  disconnect() {
    this.live = false;
    for (const n of this.nodes) { const l = n._obs || []; const i = l.indexOf(this); if (i >= 0) l.splice(i, 1); }
    this.nodes.length = 0;
  }
  takeRecords() { return []; }
}

// ── the world: one sandbox, one module instance, one stubbed wire ───────────

function makeWorld(opts = {}) {
  const doc = new Doc();
  const timers = new Timers();
  const wire = { calls: [] };
  const windowListeners = [];
  const watchers = [];              // every MutationObserver this world's page handed out
  let selected = opts.pane === undefined ? 'w4:p1' : opts.pane;
  let now = 1_000_000;
  let responder = opts.responder || (() => ({ ok: true, status: 200, json: () => Promise.resolve({}) }));
  const bus = {
    listeners: {}, emitted: [],
    on(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
      return () => { const l = this.listeners[type] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
    },
    emit(type, payload) { this.emitted.push({ type, payload }); for (const fn of (this.listeners[type] || []).slice()) fn(payload); }
  };
  const ctx = {
    api: opts.api || {},
    state: { get selectedPaneId() { return selected; } },
    events: bus, ui: {}, util: {}
  };
  /* index.html's own shell (§12.2.1): <aside id="dock"> holding #dockHost. The module reads the
     collapse off THAT element, so the world has to have one — `shell: false` is the case where the
     host sits somewhere else in the page and there is no collapse to pause for. It starts OPEN here
     (no `collapsed` class) because a collapsed dock reads nothing at all, and the checks about the
     panel's content are checks about a panel a reader can see; the collapse section and
     `shellCollapsed: true` (W2's own default at load: closed unless hd.dockOpen says otherwise) are
     the cases that assert the pause. */
  let shell = null;
  if (opts.dockHost !== false) {
    const hostEl = new El('div');
    if (opts.shell !== false) {
      shell = doc.add(new El('aside'), 'dock');
      if (opts.shellCollapsed) shell.className = 'collapsed';
      shell.appendChild(hostEl);
    }
    doc.add(hostEl, 'dockHost');
  }
  if (opts.linkCss) doc.addLink('/lib/dock.css');
  /* `hidden: true` is the page LOADED in a background tab (§3): the mount's one read must not fire
     there, which is why `doc.hidden` is set before the module is mounted rather than after */
  if (opts.hidden) doc.hidden = true;

  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    document: doc,
    /* a clock the test drives: the module reads Date.now() and nothing else from Date */
    Date: { now: () => now },
    setInterval: (fn, ms) => timers.setInterval(fn, ms),
    clearInterval: (id) => timers.clearInterval(id),
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeout: (id) => timers.clearTimeout(id),
    AbortController: AbortCtl,
    addEventListener(type) { windowListeners.push(type); },
    removeEventListener() {},
    fetch: (url, o) => {
      wire.calls.push({ url, opts: o || {}, selectedAt: selected, aborted: () => !!(o && o.signal && o.signal.aborted) });
      return responder(url, o);
    }
  };
  /* `observer: false` is a page with no MutationObserver at all: the module may not depend on one
     (it re-checks on its own tick and stays paused), and that path is asserted separately */
  if (opts.observer !== false) {
    sandbox.MutationObserver = function (cb) { const o = new Watch(cb); watchers.push(o); return o; };
  }
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.HD = { modules: {}, pending: [], register(m) { sandbox.HD.modules[m.id] = m; return true; } };
  vm.createContext(sandbox);
  vm.runInContext(DOCK_SRC, sandbox, { filename: 'dock.js' });

  const mod = sandbox.HD.modules.dock;
  const handle = mod ? mod.mount(ctx) : null;

  const api = {
    doc, timers, wire, bus, ctx, mod, handle, sandbox, windowListeners,
    get host() { return doc.getElementById('dockHost'); },
    root() { const h = api.host; return h ? h.querySelector('.hd-dock') : null; },
    setPane(id) { selected = id; },
    advance(ms) { now += ms; },
    setHidden(v) { doc.hidden = !!v; },
    /* W2's own way of collapsing the dock: classList.toggle('collapsed', …) on <aside id="dock">.
       There is no event — the class IS the signal (§12.2.1), and the observer is told in a microtask. */
    get shell() { return shell; },
    setCollapsed(v) { if (!shell) throw new Error('this world has no #dock shell'); shell.classList.toggle('collapsed', !!v); return v; },
    watchers() { return { made: watchers.length, live: watchers.filter((o) => o.live).length }; },
    respond(fnOrObj) {
      responder = (typeof fnOrObj === 'function') ? fnOrObj
        : () => ({ ok: true, status: 200, json: () => Promise.resolve(fnOrObj) });
    },
    rejectWith(err) { responder = () => Promise.reject(err || new Error('boom')); },
    cls(name) { const r = api.root(); return r ? allEls(r).filter((n) => n.className.split(/\s+/).indexOf(name) >= 0) : []; },
    one(name) { return api.cls(name)[0] || null; },
    /* null-safe on purpose: a missing node must FAIL an assertion with a readable diff, not throw
       and take every check after it down with it */
    attr(name, key) { const n = api.one(name); return n ? n.getAttribute(key) : null; },
    text(name) { const n = api.one(name); return n ? n.textContent : null; },
    fig(name) { const r = api.root(); if (!r) return null; return allEls(r).filter((n) => n.getAttribute('data-fig') === name)[0] || null; },
    figText(name) { const f = api.fig(name); return f ? f.textContent : null; },
    emptyWhy(why) { const r = api.root(); if (!r) return null; return allEls(r).filter((n) => n.className === 'hd-dock-empty' && n.getAttribute('data-why') === why)[0] || null; },
    /* the sentence of an empty section, or a readable stand-in: a missing sentence must FAIL an
       assertion with a diff, not throw and hide every check after it */
    whyText(key) { const n = api.emptyWhy(key); return n ? n.textContent : `<no .hd-dock-empty[data-why="${key}"]>`; },
    whyAttr(key) { const n = api.emptyWhy(key); return n ? n.getAttribute('data-why') : null; },
    tick() { timers.fire('interval', 2000); return wire.calls.length; },
    labelTick() { timers.fire('interval', 1000); },
    fireTimeouts() { return timers.fire('timeout'); },
    urls() { return wire.calls.map((c) => c.url); },
    panesAsked() { return wire.calls.map((c) => paneOfUrl(c.url)); },
    calls() { return wire.calls; },
    clearCalls() { wire.calls.length = 0; }
  };
  return api;
}
function paneOfUrl(u) {
  const q = String(u).split('pane_id=')[1];
  return q === undefined ? null : decodeURIComponent(q);
}

// ── the fixtures (CONTRACT-v2 §12.3, captured live — ground truth) ──────────

const HERMES_LINE_A = '☤ deepseek-flash │ ~173K/1M │ [██░░░░░░░░] ~17% │ ◎ 98.7% │ ◷ 4.0s. ─ 检查 Example Source Code 的...';
const HERMES_LINE_B = '☤ deepseek-flash │ 146K/1M │ [██░░░░░░░░] 15% │ ◎ 97.9% │ ◷ 8.8s.. ─ Build GUI for herdr multi...';
const PROC_HINT = 'Ctrl+T expand · F7 collapse';
const PROC_LAST_A = '127.0.0.1 - - [25/Sep/2026 10:27:21] "GET /core/solver/analysis-worker.js…';
const PROC_CMD_B = 'cd "D:/Development/Sample/app" && node s…';
const CLAUDE_FOOTER_8 = '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents                        8% until auto-compact';
const CLAUDE_FOOTER_CLEAR = '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents       new task? /clear to save 124.2k tokens';

function hermesBody(pane = 'w4:p1') {
  return {
    ok: true, pane_id: pane, agent: 'hermes', family: 'hermes',
    status: {
      source: 'pane_text', source_line: HERMES_LINE_A, elided: true, confidence: 'parsed',
      approx: true, model: 'deepseek-flash', used_tokens: 177152, limit_tokens: 1000000,
      used_pct: 17, cache_pct: 98.7, elapsed_s: 4.0
    },
    context: null,
    processes: {
      source: 'pane_text', running: 2, hint: PROC_HINT,
      items: [
        { cmd: 'cd…', cmd_elided: true, age_s: 10199, last: PROC_LAST_A, last_elided: true },
        { cmd: PROC_CMD_B, cmd_elided: true, age_s: 844, last: 'bash: no job control in this shell' }
      ]
    },
    absent: {}
  };
}
function claudeBody(pane = 'w6:p2', untilPct = 8, footer = CLAUDE_FOOTER_8) {
  return {
    ok: true, pane_id: pane, agent: 'claude', family: 'claude',
    status: null,
    context: {
      source: 'claude_jsonl', model: 'deepseek-flash', tokens: 145759,
      breakdown: { input: 223, cache_read: 145536, cache_create: 0, output: 2404 },
      until_auto_compact_pct: untilPct, source_line: footer, age_s: 12
    },
    processes: null,
    absent: { processes: 'this agent prints no process list' }
  };
}

// ── registration, the handle, and the keys this module does NOT take ────────

section('registration, the handle, and the keys this module does not take (§12.2.3)');

{
  const w = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) }) });
  ok('dock.js registers the module id "dock"', !!w.mod && w.mod.id === 'dock', `mod=${w.mod && w.mod.id}`);
  ok('the module lands in HD.modules.dock and HD.pending',
    w.sandbox.HD.modules.dock === w.mod && w.sandbox.HD.pending.indexOf(w.mod) >= 0,
    JSON.stringify(Object.keys(w.sandbox.HD.modules)));
  const h = w.handle;
  ok('mount() returns latest(), refresh(), unmount() (§12.2.3)',
    !!h && typeof h.latest === 'function' && typeof h.refresh === 'function' && typeof h.unmount === 'function',
    h ? Object.keys(h).join(',') : 'no handle');
  ok('the test seams are published as window.HD.dockTest',
    !!(w.sandbox.HD.dockTest && typeof w.sandbox.HD.dockTest.mount === 'function'));
  /* the `d` key is W2's (§12.2.1): this module listens for no key anywhere */
  eq('the module adds only its visibilitychange listener to the document', Object.keys(w.doc.listeners), ['visibilitychange']);
  eq('and no key listener to the window', w.windowListeners.filter((t) => /^key/.test(t)), []);
  eq('the module emits no keys.register', w.bus.emitted.filter((e) => e.type === 'keys.register'), []);
  eq('and no keydown handler on any element it built',
    allEls(w.host).filter((n) => (n.listeners.keydown || []).length).length, 0);

  /* the idempotence guard: mounting twice must not poll the same pane twice into the same host */
  const again = w.mod.mount(w.ctx);
  ok('a second mount() returns the same handle (no second instance, no twin poll)', again === h,
    again === h ? '' : 'a new handle was returned');
  await settle();
  eq('and that second mount did not add a second read or a second timer',
    [w.calls().length, w.timers.of('interval').length], [1, 2]);
  eq('nothing in this run assigned innerHTML', INNER_HTML_WRITES, []);
}

// ── the cadence: 2 s, the selected pane only, and nothing at all while hidden ──

section('the cadence: 2 s, the selected pane only, nothing while hidden (§12.2.3)');

{
  const w = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) }) });
  await settle();
  eq('mount reads the selected pane once, at once', w.panesAsked(), ['w4:p1']);
  eq('the cadence is 2 s, with a 1 s label tick beside it', w.timers.msOf('interval'), [1000, 2000]);
  w.clearCalls();
  w.advance(2000);
  w.tick();
  eq('one tick = exactly one request', w.calls().length, 1);
  eq('the request is GET /api/status?pane_id=<selected pane> (the pane id percent-encoded, decoded by the server)',
    w.urls()[0], '/api/status?pane_id=' + encodeURIComponent('w4:p1'));
  await settle();
  w.clearCalls();
  /* the dedup window: a second tick in the same instant cannot return anything new */
  w.tick();
  eq('a second tick in the same instant is not a second request', w.calls().length, 0);
  await settle();
  w.clearCalls();
  w.advance(2000);
  w.tick();
  await settle();
  eq('the next tick 2 s later does read again', w.calls().length, 1);

  /* a read in flight is never stacked */
  let release;
  w.respond(() => new Promise((res) => { release = () => res({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) }); }));
  w.clearCalls();
  w.advance(2000); w.tick();
  w.advance(2000); w.tick();
  w.advance(2000); w.tick();
  eq('an unanswered read is never stacked (one pane.read per call, §12.3.5)', w.calls().length, 1);
  held(release);
  await settle();

  /* hidden: not one request, and the label tick is not a request either */
  w.clearCalls();
  w.setHidden(true);
  for (let i = 0; i < 5; i++) { w.advance(2000); w.tick(); w.labelTick(); }
  eq('while document.hidden the dock asks nothing at all', w.calls().length, 0);
  w.setHidden(false);
  w.doc.dispatch('visibilitychange');
  await settle();
  eq('becoming visible again reads the pane once', w.calls().length, 1);

  /* the invariant behind "ONLY for the selected pane": no request is ever issued for a pane that was
     not the selected one at that moment */
  w.clearCalls();
  const seen = new Set();
  for (const p of ['w6:p1', 'w6:p2', 'w4:p1']) {
    w.setPane(p);
    w.respond(hermesBody(p));
    w.bus.emit('select', { pane_id: p, paneId: p });
    await settle();
    w.advance(2000);
    w.tick();
    await settle();
    for (const c of w.calls()) seen.add(paneOfUrl(c.url));
  }
  ok('across three pane switches only the selected pane was ever read',
    w.calls().every((c) => paneOfUrl(c.url) === c.selectedAt),
    JSON.stringify(w.calls().map((c) => [paneOfUrl(c.url), c.selectedAt])));
  ok('and the check was not vacuous — all three panes were read', seen.size === 3, JSON.stringify([...seen]));
}

// ── a collapsed dock reads nothing, and opening it reads once at once ──────

section('a COLLAPSED dock: the poll pauses, the reopening reads once (§12.2 errata)');

{
  /* Hermes measured the defect in a real browser, A/B over an 8 s window: 4 x /api/status with the
     dock collapsed and 4 x with it open, 0 x with the tab hidden. The collapsed case is the one that
     buys nothing — one herdr read + one jsonl read per tick for a panel nobody can see. This is that
     measurement, as a check: the same 8 s window, and the answers are held back so the panel can be
     read while a read is still in flight. */
  let release = null;
  const w = makeWorld({
    responder: () => new Promise((res) => { release = () => res({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) }); })
  });
  await settle();
  eq('the module found W2\'s <aside id="dock"> above its host (§12.2.1)',
    [!!w.shell, w.handle.state().shell_present], [true, true]);
  ok('and it watches that element\'s class, because the shell emits no event',
    w.handle.state().shell_watch === true, JSON.stringify(w.handle.state()));
  eq('with the dock open the cadence and the label tick both run',
    [w.handle.state().collapsed, w.handle.state().paused, w.handle.state().polling, w.handle.state().label_timer],
    [false, null, true, true]);

  held(release); await settle();
  eq('the first read drew the panel', w.handle.state().data_state, 'live');
  const atLive = w.handle.latest().at;

  /* collapse: W2's own way — classList.toggle('collapsed', true) on #dock */
  w.clearCalls();
  w.setCollapsed(true);
  await settle();
  eq('collapsing pauses the cadence AND the label timer',
    [w.handle.state().paused, w.handle.state().polling, w.handle.state().label_timer], ['collapsed', false, false]);
  ok('and names the reason in words a caller can show',
    /the dock is collapsed/.test(String(w.handle.state().paused_reason)), String(w.handle.state().paused_reason));
  eq('and the collapse is read off W2\'s element, not remembered as a flag of its own',
    w.handle.state().collapsed, true);

  const when = w.text('hd-dock-when');
  for (let i = 0; i < 4; i++) { w.advance(2000); w.tick(); w.labelTick(); }
  eq('over the whole 8 s window a collapsed dock asks NOTHING (Hermes measured 4 x before)',
    w.calls().length, 0);
  eq('and not even the label is ticked — a collapsed panel is not re-rendered',
    w.text('hd-dock-when'), when);
  eq('and the answer it holds is neither replaced nor re-stamped while paused',
    w.handle.latest().at, atLive);
  eq('and nothing it holds is presented as current anywhere new',
    w.cls('hd-dock-stale-last').length, 0);

  /* opening: ONE read, at once. Nothing ticks the clock or the timers here — the read is the
     reopening's own, and the answer is held back so the in-flight state can be read too. */
  let release2 = null;
  w.respond(() => new Promise((res) => { release2 = () => res({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) }); }));
  w.clearCalls();
  const clockBefore = w.handle.state().last_ask;
  w.setCollapsed(false);
  await settle();
  eq('opening reads the selected pane exactly ONCE, with no tick fired and no clock advanced',
    [w.calls().length, w.panesAsked()], [1, ['w4:p1']]);
  const asked = w.handle.state().last_ask;
  eq('and the dedup window did not swallow it (it is a fresh ask, not the old one)',
    asked && asked.pane, 'w4:p1');
  ok('and it is a new ask, not the one that was standing when the dock closed',
    !asked || clockBefore === null || asked.at >= clockBefore.at, JSON.stringify([clockBefore, asked]));
  eq('and the cadence and label tick are running again',
    [w.handle.state().paused, w.handle.state().polling, w.handle.state().label_timer], [null, true, true]);

  eq('while that read is in flight the 8 s old answer does NOT wear a current face',
    w.handle.state().data_state, 'reading');
  eq('the old numbers are still there — inside the not-current block',
    [w.cls('hd-dock-stale-last').length, w.attr('hd-dock-stale-last', 'data-stale')], [1, '1']);
  ok('with a label that says so, and an age that ages',
    /not current/.test(String(w.text('hd-dock-stale-note'))), String(w.text('hd-dock-stale-note')));
  ok('and the head says re-reading, not read',
    /re-reading/.test(String(w.text('hd-dock-when'))), String(w.text('hd-dock-when')));
  held(release2); await settle();
  eq('and when the answer lands the panel is live with it and the old block is gone',
    [w.handle.state().data_state, w.cls('hd-dock-stale-last').length], ['live', 0]);

  /* the other half of the same rule: a fast collapse/open must NOT label a fresh answer stale */
  w.clearCalls();
  w.setCollapsed(true);
  await settle();
  w.setCollapsed(false);
  await settle();
  eq('a reopen inside one cadence still reads once', w.calls().length, 1);
  eq('and a fresh answer keeps its current face (nothing is labelled stale for nothing)',
    [w.handle.state().data_state, w.cls('hd-dock-stale-last').length], ['live', 0]);

  /* A pane selected while the panel is COLLAPSED: EXACTLY ONE read for it, because the chip W2 draws
     from this module is on screen whether or not the dock is open. Hermes froze this in §12.2 after a
     live A/B: one call, not zero (the old behaviour, which left the chip at `—` for the pane the user
     had just selected) and not the cadence's four. The panel stays paused afterwards. */
  w.setCollapsed(true);
  await settle();
  w.clearCalls();
  w.respond((url) => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody(paneOfUrl(url))) }));
  w.setPane('w6:p1');
  w.bus.emit('select', { pane_id: 'w6:p1', paneId: 'w6:p1' });
  await settle();
  eq('a selection change with the panel collapsed reads that pane exactly ONCE',
    [w.calls().length, w.panesAsked()], [1, ['w6:p1']]);
  ok('and latest() is that pane\'s own answer, so the always-on chip has one to show',
    !!(w.handle.latest() && w.handle.latest().pane_id === 'w6:p1'), JSON.stringify(w.handle.latest() && w.handle.latest().pane_id));
  eq('and the cadence is exactly as paused as it was — nothing here started a timer',
    [w.handle.state().paused, w.handle.state().polling, w.handle.state().label_timer], ['collapsed', false, false]);
  for (let i = 0; i < 4; i++) { w.advance(2000); w.tick(); w.labelTick(); }
  eq('and over the 8 s after the switch that is still ONE read, not the cadence\'s four',
    w.calls().length, 1);
  eq('and the panel holds the new pane\'s OWN answer, drawn behind the closed panel',
    [w.text('hd-dock-pane'), w.handle.state().data_state], ['w6:p1', 'live']);

  /* the same switch, with the answer HELD: the pane the user LEFT must never stand in for the new one
     while its read is in flight — the collage that would put w6:p1's numbers under w7:p1's name */
  const other = hermesBody('w7:p1');
  other.status.model = 'w7-model';
  other.status.used_pct = 41;
  other.status.used_tokens = 146000;
  let release3 = null;
  w.respond(() => new Promise((res) => { release3 = () => res({ ok: true, status: 200, json: () => Promise.resolve(other) }); }));
  w.clearCalls();
  w.setPane('w7:p1');
  w.bus.emit('select', { pane_id: 'w7:p1', paneId: 'w7:p1' });
  await settle();
  eq('and a switch to a third pane reads it once as well', [w.calls().length, w.panesAsked()], [1, ['w7:p1']]);
  eq('and until it answers, the panel holds NO figure from the pane that was left',
    [w.figText('model'), w.figText('used'), w.figText('pct')], [null, null, null]);
  ok('and it says why, instead of showing another pane\'s numbers',
    /no numbers are shown from another pane/.test(String(w.text('hd-dock-msg'))), String(w.text('hd-dock-msg')));
  held(release3); await settle();
  eq('and the answer that lands is the new pane\'s own, with the agent\'s own ~ kept',
    [w.text('hd-dock-pane'), w.figText('model'), w.figText('pct')], ['w7:p1', 'w7-model', '~41%']);

  /* and opening after all that reads the pane the user actually selected, once */
  w.clearCalls();
  w.setCollapsed(false);
  await settle();
  eq('opening after that switch reads the pane the user actually selected, once',
    [w.calls().length, w.panesAsked()], [1, ['w7:p1']]);
  eq('and the reopen did not strike the answer the switch had just fetched as stale',
    [w.handle.state().paused, w.handle.state().polling, w.handle.state().data_state], [null, true, 'live']);
  eq('and nothing is labelled not-current behind it', w.cls('hd-dock-stale-last').length, 0);
}

{
  /* both reasons at once: neither may start the other's read */
  const w = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) }) });
  await settle();
  w.setCollapsed(true);
  await settle();
  w.setHidden(true);
  w.clearCalls();
  for (let i = 0; i < 4; i++) { w.advance(2000); w.tick(); w.labelTick(); }
  eq('collapsed AND hidden is still nothing at all', w.calls().length, 0);
  w.setHidden(false);
  w.doc.dispatch('visibilitychange');
  await settle();
  eq('the tab coming back with the dock still collapsed reads the selected pane once — the return is one of the three moments that read (§12.2 errata)',
    [w.calls().length, w.panesAsked()], [1, ['w4:p1']]);
  eq('and the pause still names the collapse, not the tab that is now shown',
    [w.handle.state().paused, w.handle.state().polling], ['collapsed', false]);
  w.setCollapsed(false);
  await settle();
  eq('the shell opening is what reads — once more', [w.calls().length, w.panesAsked()], [2, ['w4:p1', 'w4:p1']]);
  eq('and the cadence is running again', [w.handle.state().paused, w.handle.state().polling], [null, true]);

  /* hidden while open, then collapsed and opened again INSIDE the hidden tab: neither the reopen nor
     the mount behind it reads — a hidden tab has no reader for a fresh answer to be current FOR, and
     the read waits for the tab (§3's pause is the one that wins) */
  w.setHidden(true);
  w.setCollapsed(true);
  await settle();
  w.setCollapsed(false);
  await settle();
  eq('opening the dock in a hidden tab reads nothing', w.calls().length, 2);
  eq('and the reason is the hidden tab, not the shell',
    [w.handle.state().paused, /the tab is hidden/.test(String(w.handle.state().paused_reason))], ['hidden', true]);
  eq('and its cadence stays stood down while the tab is hidden — the reopen does not restart it',
    [w.handle.state().polling, w.handle.state().label_timer], [false, false]);
  w.setHidden(false);
  w.doc.dispatch('visibilitychange');
  await settle();
  eq('and showing the tab is what reads — once', [w.calls().length, w.panesAsked()], [3, ['w4:p1', 'w4:p1', 'w4:p1']]);
}

{
  /* a page that LOADS in a background tab (§3): the mount is one of the three moments that read, but a
     hidden tab has no reader — the read waits for the tab rather than going out for nobody */
  const w = makeWorld({
    hidden: true,
    responder: (url) => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody(paneOfUrl(url))) })
  });
  await settle();
  eq('a dock mounted in a hidden tab reads nothing at all', w.calls().length, 0);
  eq('and starts no timer either — the hidden pause is settled at the mount',
    [w.handle.state().paused, w.handle.state().polling, w.handle.state().label_timer], ['hidden', false, false]);
  eq('and latest() is still empty, so nothing is claimed about a pane that was never read',
    w.handle.latest(), null);
  w.setHidden(false);
  w.doc.dispatch('visibilitychange');
  await settle();
  eq('and showing the tab is what reads — once, for the selected pane',
    [w.calls().length, w.panesAsked()], [1, ['w4:p1']]);
  eq('and the cadence runs again', [w.handle.state().paused, w.handle.state().polling], [null, true]);
}

{
  /* a page with NO MutationObserver: the module may not depend on one. It keeps the tick (nothing
     could wake it otherwise), asks nothing on it, and re-checks the shell there instead. */
  const w = makeWorld({
    observer: false,
    responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) })
  });
  await settle();
  eq('with no observer the module watches nothing', [w.handle.state().shell_watch, w.watchers().made], [false, 0]);
  w.setCollapsed(true);
  await settle();
  eq('with no observer the collapse is read off the element on the next tick, not at once',
    [w.handle.state().collapsed, w.handle.state().paused], [true, null]);
  eq('and the timers stay, because nothing could restart them if they stopped',
    [w.handle.state().polling, w.handle.state().label_timer], [true, true]);
  const when = w.text('hd-dock-when');
  w.clearCalls();
  for (let i = 0; i < 4; i++) { w.advance(2000); w.tick(); w.labelTick(); }
  eq('and over the same window it asks nothing either', w.calls().length, 0);
  eq('and the pause is taken on the first of those ticks', w.handle.state().paused, 'collapsed');
  eq('and from then on its label tick refuses to run for a collapsed panel', w.text('hd-dock-when'), when);
  w.setCollapsed(false);
  w.advance(2000); w.tick();
  await settle();
  eq('and the reopening is caught on that tick, which reads once',
    [w.calls().length, w.panesAsked()], [1, ['w4:p1']]);
  eq('and the pause is over', [w.handle.state().paused, w.handle.state().data_state], [null, 'live']);
}

{
  /* no MutationObserver, the two shapes the §12.2 errata has to survive without one. pauseReason()
     reads the element itself, so neither the mount's read nor a selection change's depends on an
     observer having NOTICED the collapse first. */
  const w = makeWorld({
    observer: false, shellCollapsed: true,
    responder: (url) => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody(paneOfUrl(url))) })
  });
  await settle();
  eq('with no observer and a panel closed at mount: one read, for the pane the page opened on',
    [w.calls().length, w.panesAsked()], [1, ['w4:p1']]);
  eq('and no timer at all — the pause is settled before start() is asked',
    [w.handle.state().paused, w.handle.state().polling, w.handle.state().label_timer], ['collapsed', false, false]);

  /* the other shape: open at mount (timers running), collapsed afterwards with nothing to notice it.
     The tick it keeps must ask nothing, and a selection change still reads its one pane. */
  const w2 = makeWorld({
    observer: false,
    responder: (url) => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody(paneOfUrl(url))) })
  });
  await settle();
  w2.setCollapsed(true);
  await settle();
  w2.clearCalls();
  w2.setPane('w6:p1');
  w2.bus.emit('select', { pane_id: 'w6:p1', paneId: 'w6:p1' });
  await settle();
  eq('a selection change while collapsed reads its pane once even with no observer to notice the collapse',
    [w2.calls().length, w2.panesAsked()], [1, ['w6:p1']]);
  ok('and latest() is that pane\'s own answer, for the chip',
    !!(w2.handle.latest() && w2.handle.latest().pane_id === 'w6:p1'), JSON.stringify(w2.handle.latest() && w2.handle.latest().pane_id));
  eq('and the panel holds that pane\'s own numbers behind the closed panel',
    [w2.text('hd-dock-pane'), w2.figText('model')], ['w6:p1', 'deepseek-flash']);
  for (let i = 0; i < 4; i++) { w2.advance(2000); w2.tick(); w2.labelTick(); }
  eq('and the tick it still keeps asks nothing more over the next 8 s', w2.calls().length, 1);
  eq('and the pause it finally names is the collapse', w2.handle.state().paused, 'collapsed');
}

{
  /* mounted into a panel that is ALREADY closed — which is W2's own default layout (index.html ships
     class="collapsed" and hd.dockOpen is unset). §12.2 errata: the MOUNT is one of the three moments
     that read — exactly one, for the pane the page opened on, so the always-visible chip has an answer
     without anyone opening the dock first. The cadence stays paused: one read, no timer, ever. */
  const w = makeWorld({
    shellCollapsed: true,
    responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) })
  });
  await settle();
  eq('the dock mounts into a closed panel, and stays mounted', [w.calls().length, w.handle.mounted()], [1, true]);
  eq('and the one read it made is for the pane the page opened on', w.panesAsked(), ['w4:p1']);
  ok('and latest() holds it, so the chip has the selected pane\'s own answer at load',
    !!(w.handle.latest() && w.handle.latest().pane_id === 'w4:p1'), JSON.stringify(w.handle.latest() && w.handle.latest().pane_id));
  eq('and the panel was drawn with it, behind the closed panel',
    [w.handle.state().data_state, w.text('hd-dock-pane')], ['live', 'w4:p1']);
  eq('with no timer at all from the first instant',
    [w.handle.state().paused, w.handle.state().polling, w.handle.state().label_timer], ['collapsed', false, false]);
  for (let i = 0; i < 4; i++) { w.advance(2000); w.tick(); w.labelTick(); }
  eq('and over a whole window it stays at that ONE read — the cadence never resumed', w.calls().length, 1);
  const mountedAt = (w.handle.latest() || {});           // null-safe: a missing answer must FAIL a check, not throw
  eq('and the answer it holds is not re-stamped by any of those ticks',
    [(w.handle.latest() || {}).at, (w.handle.latest() || {}).pane_id], [mountedAt.at, 'w4:p1']);
  w.setCollapsed(false);
  await settle();
  eq('opening it reads the selected pane once more', [w.calls().length, w.panesAsked()], [2, ['w4:p1', 'w4:p1']]);
  eq('and the panel is live with that answer, with nothing left labelled not-current',
    [w.handle.state().data_state, w.cls('hd-dock-stale-last').length], ['live', 0]);
}

{
  /* a host with no #dock above it: there is no collapse in this page, so the cadence is exactly what
     it was before this round */
  const w = makeWorld({
    shell: false,
    responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) })
  });
  await settle();
  eq('a host with no shell above it has no collapse to pause for',
    [w.handle.state().shell_present, w.handle.state().collapsed, w.handle.state().paused], [false, false, null]);
  eq('and no watcher was made for a shell that is not there', w.watchers().made, 0);
  w.clearCalls();
  w.advance(2000); w.tick();
  await settle();
  eq('and it still reads every 2 s, once per tick', [w.calls().length, w.panesAsked()], [1, ['w4:p1']]);
}

{
  /* an explicit refresh() is the caller asking for a read — the §12.2 errata governs the POLL, not a
     caller's own request. The chip's honesty is the stamp: `at` is the read's own arrival time, so an
     answer that is not being replaced ages, which is how W2 dashes it out after 6 s. */
  const w = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) }) });
  await settle();
  w.setCollapsed(true);
  await settle();
  w.clearCalls();
  const p = w.handle.refresh();
  await settle();
  eq('an explicit refresh reads once, collapsed or not', w.calls().length, 1);
  eq('and it answers the caller with that read', (await p).ok, true);
  eq('and the poll is still paused afterwards',
    [w.handle.state().paused, w.handle.state().polling, w.handle.state().label_timer], ['collapsed', false, false]);
  const a = w.handle.latest();
  w.advance(8000); w.tick(); w.labelTick();
  eq('and no further read goes out behind it', w.calls().length, 1);
  eq('and latest() is the same answer with the same stamp, so W2 can see it is 8 s old',
    [w.handle.latest() === a, w.handle.latest().at], [true, a.at]);
}

{
  /* unmount takes the watcher off the shell: a class flip after that must reach nobody */
  const w = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) }) });
  await settle();
  w.setCollapsed(true);
  await settle();
  eq('exactly one watcher, and it is attached', w.watchers(), { made: 1, live: 1 });
  w.clearCalls();
  eq('unmount says it did something', w.handle.unmount(), true);
  eq('and the watcher is disconnected from the shell', w.watchers().live, 0);
  w.setCollapsed(false);
  await settle();
  eq('and a shell change after unmount reads nothing and mounts nothing',
    [w.calls().length, w.handle.mounted()], [0, false]);
  eq('and the state reports no shell and no pause',
    [w.handle.state().paused, w.handle.state().shell_present], [null, false]);
}

// ── hermes: model · used/limit · bar · used_pct · elapsed, plus the processes ──

section('hermes: model · used/limit · bar · used_pct · elapsed, plus the process list (§12.2.4, §12.3.3)');

{
  const w = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) }) });
  await settle();
  const r = w.root();
  ok('the panel is the dock\'s own tree, carrying the answer\'s family and a live state',
    !!r && r.getAttribute('data-family') === 'hermes' && r.getAttribute('data-state') === 'live',
    r ? `family=${r.getAttribute('data-family')} state=${r.getAttribute('data-state')}` : 'no .hd-dock');
  eq('the header names the pane and the family', [w.text('hd-dock-pane'), w.text('hd-dock-family')], ['w4:p1', 'hermes']);
  eq('the family badge carries the family as data, not only as text',
    w.one('hd-dock-family').getAttribute('data-family'), 'hermes');

  eq('the usage section is drawn in the hermes shape', w.one('hd-dock-usage').getAttribute('data-shape'), 'hermes');
  eq('hermes has exactly one row node', w.cls('hd-dock-hermes').length, 1);
  eq('the claude shape is NOT in this tree (the two metrics are never one shape)', w.cls('hd-dock-claude').length, 0);
  eq('model, from the response', w.figText('model'), 'deepseek-flash');
  eq('used/limit, the response\'s token counts', w.figText('used'), '177,152 / 1,000,000 tokens');
  eq('used_pct, the response\'s percentage, with the agent\'s own ~', w.figText('pct'), '~17%');
  eq('elapsed, the response\'s own figure', w.figText('elapsed'), '4s');
  const ap = w.one('hd-dock-approx');
  ok('the agent\'s ~ is shown as an approx badge and explained',
    !!ap && ap.textContent === 'approx' && /~/.test(ap.title || ''), ap ? `${ap.textContent} / ${ap.title}` : 'no badge');
  const bar = w.one('hd-dock-bar');
  const fill = w.one('hd-dock-bar-fill');
  ok('the bar carries the response\'s percentage and is drawn from it',
    !!bar && bar.getAttribute('data-pct') === '17' && !!fill
    && fill.getAttribute('data-fill') === '17' && fill.style.width === '17%',
    `${bar && bar.getAttribute('data-pct')} / ${fill && fill.style.width}`);
  ok('the bar is decoration beside the number, not a second reading of it', bar.getAttribute('aria-hidden') === 'true');
  ok('the row says where its numbers came from', /hermes/.test(w.text('hd-dock-note') || ''), w.text('hd-dock-note'));
  eq('no empty sentence is needed in the usage section', w.emptyWhy('no-usage'), null);

  /* processes: the agent's own list, verbatim, with the elision labelled and never "completed" */
  eq('the process head is the response\'s own count', w.text('hd-dock-procs-head'), '2 processes running');
  eq('the agent\'s own hint, verbatim', w.text('hd-dock-hint'), PROC_HINT);
  eq('one row per process', w.cls('hd-dock-proc').length, 2);
  const rows = w.cls('hd-dock-proc');
  const cmdA = rows[0].children[0];
  eq('the elided command is the agent\'s own text, its … intact', cmdA.textContent.split('the agent elided')[0], 'cd…');
  eq('an elided command is flagged', cmdA.getAttribute('data-elided'), '1');
  eq('and labelled with the contract\'s sentence',
    (cmdA.querySelector('.hd-dock-elide') || {}).textContent, 'the agent elided this with …');
  eq('the age is the response\'s own', rows[0].children[1].textContent, '10199s');
  ok('the last line is verbatim, its … the agent\'s',
    rows[0].children[2].textContent.indexOf('last: ' + PROC_LAST_A) === 0, rows[0].children[2].textContent);
  eq('the second command keeps its quoting and its …', rows[1].children[0].textContent.split('the agent elided')[0], PROC_CMD_B);
  eq('a last line the agent did NOT elide is not labelled elided', rows[1].children[2].getAttribute('data-elided'), null);
  eq('and it reads as the agent printed it', rows[1].children[2].textContent, 'last: bash: no job control in this shell');

  /* the source area: verbatim, folded, and honest about its state */
  const head = w.one('hd-dock-src-head');
  ok('the source control is a real button with its state on it',
    !!head && head.tagName === 'BUTTON' && head.getAttribute('aria-expanded') === 'false' && head.getAttribute('data-open') === '0',
    head ? `${head.tagName} aria=${head.getAttribute('aria-expanded')}` : 'no control');
  eq('the control counts the verbatim lines it holds', head.textContent, 'show source · 1 line');
  const box = w.one('hd-dock-src');
  ok('the folded source really is hidden, both ways a stylesheet can read it',
    !!box && box.hidden === true && box.getAttribute('hidden') !== null);
  const line = w.one('hd-dock-src-line');
  eq('the source line is the response\'s own string, character for character', line.textContent, HERMES_LINE_A);
  ok('and its tail is intact — the dock truncated nothing of its own',
    line.textContent.endsWith(HERMES_LINE_A.slice(-24)) && line.textContent.length === HERMES_LINE_A.length,
    `${line.textContent.length} chars vs ${HERMES_LINE_A.length}`);
  eq('the line is attributed to the status section', line.getAttribute('data-from'), 'status');
  eq('a status line the response marks elided is marked in the tree too', line.getAttribute('data-elided'), '1');

  /* the agent's own `…` is a character, not a marker we strip: it must survive into the tree */
  const b2 = hermesBody();
  b2.status.source_line = '☤ deepseek-flash │ ~173K/1M │ [██░░] ~17% │ ◎ 98.7% │ ◷ 4.0s. ─ 检查…';
  const w2 = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(b2) }) });
  await settle();
  const l2 = w2.one('hd-dock-src-line');
  eq('an elision the agent wrote survives character for character', l2.textContent, b2.status.source_line);
  ok('and it is a real U+2026, not three dots we substituted',
    l2.textContent.charCodeAt(l2.textContent.length - 1) === 0x2026,
    `last char U+${l2.textContent.charCodeAt(l2.textContent.length - 1).toString(16).toUpperCase()}`);
}

// ── used_pct is the response's number, never recomputed from used/limit ────

section('the percentage is the response\'s, not recomputed from used/limit (§12.2.4)');

{
  const base = hermesBody();
  const mk = (pct) => { const b = JSON.parse(JSON.stringify(base)); b.status.used_pct = pct; return b; };
  const w1 = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(mk(17)) }) });
  const w2 = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(mk(42)) }) });
  await settle(); await settle();
  ok('identical token counts with a different used_pct draw a different number and a different bar',
    w1.figText('used') === w2.figText('used') && w1.figText('pct') !== w2.figText('pct')
    && w1.one('hd-dock-bar-fill').style.width !== w2.one('hd-dock-bar-fill').style.width,
    `used ${w1.figText('used')} vs ${w2.figText('used')} · pct ${w1.figText('pct')} vs ${w2.figText('pct')} · ` +
    `bar ${w1.one('hd-dock-bar-fill').style.width} vs ${w2.one('hd-dock-bar-fill').style.width}`);
  eq('the bar is the response\'s 17% and 42%, not the 17.7152% the tokens would give',
    [w1.one('hd-dock-bar-fill').style.width, w2.one('hd-dock-bar-fill').style.width], ['17%', '42%']);
  const w3 = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(mk(183)) }) });
  await settle();
  eq('an out-of-range percentage is clamped for the drawing', w3.one('hd-dock-bar-fill').style.width, '100%');
  eq('and the number shown is still the response\'s own', w3.figText('pct'), '~183%');
}

// ── claude: a different shape, with and without the auto-compact figure ────

section('claude: context ~N tokens (breakdown) · N% until auto-compact — a different shape (§12.2.4)');

{
  const w = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(claudeBody('w4:p1')) }) });
  await settle();
  eq('the family comes from the response', w.root().getAttribute('data-family'), 'claude');
  eq('the usage section is drawn in the claude shape', w.one('hd-dock-usage').getAttribute('data-shape'), 'claude');
  eq('claude has exactly one block node', w.cls('hd-dock-claude').length, 1);
  eq('hermes\' row is NOT in this tree', w.cls('hd-dock-hermes').length, 0);
  eq('claude gets NO bar — nothing prints a limit to draw one against', w.cls('hd-dock-bar').length, 0);
  eq('model', w.figText('model'), 'deepseek-flash');
  eq('the context size the server computed from claude\'s own records', w.figText('context'), 'context ~145,759 tokens');
  eq('the breakdown, all four parts, as the response reports them', w.text('hd-dock-breakdown'),
    'input 223 · cache read 145,536 · cache create 0 · output 2,404');
  eq('claude\'s own auto-compact footer figure', w.figText('until'), '8% until auto-compact');
  const notes = w.cls('hd-dock-note').map((n) => [n.getAttribute('data-note'), n.textContent]);
  ok('the note that claude prints no limit is present',
    !!notes.find((n) => n[0] === 'claude-no-limit' && /no used\/limit/.test(n[1])), JSON.stringify(notes));
  ok('the age of claude\'s own record is stated', !!notes.find((n) => n[0] === 'claude-age' && /12s/.test(n[1])),
    JSON.stringify(notes));
  eq('the verbatim footer is the source line, spaces and all',
    w.cls('hd-dock-src-line').map((n) => [n.getAttribute('data-from'), n.textContent]), [['context', CLAUDE_FOOTER_8]]);
  eq('the processes section shows the response\'s own reason, not a blank box',
    w.whyText('no-list'), 'this agent prints no process list');

  /* the same pane with a footer that carries no auto-compact figure at all */
  const w2 = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(claudeBody('w4:p1', null, CLAUDE_FOOTER_CLEAR)) }) });
  await settle();
  eq('with no figure there is no until node', w2.fig('until'), null);
  eq('the tokens are still shown', w2.figText('context'), 'context ~145,759 tokens');
  const why = w2.whyText('no-until');
  ok('and a sentence says the footer printed none',
    /printed no auto-compact figure/.test(why), why);
  eq('the source line is this footer, verbatim', w2.one('hd-dock-src-line').textContent, CLAUDE_FOOTER_CLEAR);
  eq('nothing is downgraded to the hermes shape just because the figure is missing',
    [w2.cls('hd-dock-hermes').length, w2.cls('hd-dock-bar').length], [0, 0]);
}

// ── a failed read: a described state, never a stale number wearing a current face ──

section('a failed read: the failure is stated, and when the last read succeeded (§12.2.4)');

{
  const w = makeWorld({ responder: () => Promise.reject(new Error('connect ECONNREFUSED')) });
  await settle();
  eq('a failed read puts the panel in its failure state', w.root().getAttribute('data-state'), 'failed');
  eq('the live body is gone — no number is shown as current', w.cls('hd-dock-body').length, 0);
  const msg = w.one('hd-dock-stale-msg');
  ok('the failure is said in words, with the reason',
    !!msg && /reading the status failed/.test(msg.textContent) && /ECONNREFUSED/.test(msg.textContent),
    msg && msg.textContent);
  eq('the failure carries its code', msg.getAttribute('data-code'), 'network');
  eq('and it says nothing has ever been read', w.text('hd-dock-stale-note'), 'no successful read since this page loaded');
  eq('with no last good answer there is no stale block', w.cls('hd-dock-stale-last').length, 0);

  /* a good answer, then a failure: the numbers stay, but only under a label that says they are not current */
  w.respond(hermesBody());
  w.advance(2000);
  w.tick();
  await settle();
  eq('the good answer is live', w.root().getAttribute('data-state'), 'live');
  w.advance(12_000);
  w.rejectWith(new Error('socket hang up'));
  const res = await w.handle.refresh();
  ok('refresh() resolves with the failed answer rather than rejecting',
    !!res && res.ok === false && res.error.code === 'network', JSON.stringify(res && res.error));
  eq('the failure state is back and the live body is gone',
    [w.root().getAttribute('data-state'), w.cls('hd-dock-body').length], ['failed', 0]);
  const last = w.one('hd-dock-stale-last');
  ok('the last good answer is kept in a block marked not current',
    !!last && last.getAttribute('data-stale') === '1', last ? `data-stale=${last.getAttribute('data-stale')}` : 'no stale block');
  const lab = last ? last.querySelector('.hd-dock-stale-note') : null;
  eq('the block says what it is, how old it is and which pane', lab ? lab.textContent : '<no label in the stale block>',
    'last good answer · 12s ago · pane w4:p1 — not current');
  eq('the stale numbers are the last good ones', w.figText('pct'), '~17%');
  eq('and they are NOT in a live body', w.cls('hd-dock-body').length, 0);
  eq('the head names when the last read succeeded', w.text('hd-dock-when'), 'last read 12s ago · this read failed');
  eq('the panel says when the last read succeeded, and for which pane',
    w.text('hd-dock-stale-note'), 'last successful read 12s ago (pane w4:p1)');

  /* the age is a clock, not a snapshot taken once */
  w.advance(48_000);
  const before = w.calls().length;
  w.labelTick();
  eq('the label ages on its own tick', w.one('hd-dock-stale-note').textContent,
    'last successful read 1m 0s ago (pane w4:p1)');
  eq('and that tick issued no request', w.calls().length, before);
}

{
  /* an HTTP error, a timeout, and an answer for the wrong pane: three more described failures */
  const w = makeWorld({
    responder: () => ({ ok: false, status: 500, json: () => Promise.resolve({ ok: false, error: { code: 'pane_read_failed', message: 'herdr did not answer' } }) })
  });
  await settle();
  const m = w.one('hd-dock-stale-msg');
  ok('an HTTP error shows the server\'s own reason', /herdr did not answer/.test(m.textContent), m.textContent);
  eq('with the server\'s own code', m.getAttribute('data-code'), 'pane_read_failed');

  const w2 = makeWorld({ responder: () => new Promise(() => {}) });     // never answers
  await settle();
  eq('a hanging read has not answered yet, and the panel says nothing else', w2.calls().length, 1);
  w2.fireTimeouts();
  await settle();
  const m2 = w2.one('hd-dock-stale-msg');
  eq('a read the server never answers times out and says so', m2.getAttribute('data-code'), 'timeout');
  ok('the timeout sentence names the deadline', /timed out after 6s/.test(m2.textContent), m2.textContent);
  ok('and the abandoned request was really aborted at the socket',
    w2.calls().every((c) => c.aborted()), JSON.stringify(w2.calls().map((c) => c.aborted())));

  const w3 = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody('w9:p9')) }) });
  await settle();
  eq('an answer for another pane is refused, not drawn', w3.root().getAttribute('data-state'), 'failed');
  const m3 = w3.text('hd-dock-stale-msg');
  ok('and it says which pane answered',
    /answered for w9:p9 while w4:p1 is the selected pane/.test(m3 || ''), m3);
  eq('the mismatched numbers are nowhere on screen', w3.cls('hd-dock-proc').length, 0);
  eq('and no stale block claims them either', w3.cls('hd-dock-stale-last').length, 0);
}

// ── absent fields: explicit sentences, labelled gaps, never a guess ────────

section('absent fields: explicit sentences and labelled gaps, never a guess (§12.2.4, §12.3.4)');

{
  const bare = {
    ok: true, pane_id: 'w4:p1', agent: 'hermes', family: 'hermes',
    status: null, context: null, processes: null,
    absent: { status: 'no status line in the last 60 lines', processes: 'no process list in the last 60 lines' }
  };
  const w = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(bare) }) });
  await settle();
  eq('a hermes pane with no status line shows the response\'s own sentence',
    w.one('hd-dock-empty').textContent, 'no status line in the last 60 lines');
  eq('in the usage section, with its own reason key', w.whyAttr('no-usage'), 'no-usage');
  eq('no number is invented for it', w.cls('hd-dock-fig').length, 0);
  eq('the process section too', w.whyText('no-list'), 'no process list in the last 60 lines');
  const secs = w.cls('hd-dock-sec');
  ok('no section is a blank box — every one of them has content',
    secs.every((s) => s.children.length >= 2),
    JSON.stringify(secs.map((s) => [s.getAttribute('data-sec'), s.children.length])));

  /* without the response's own reason the sentence is still a sentence, and it invents no N */
  const bare2 = JSON.parse(JSON.stringify(bare));
  bare2.absent = {};
  const w2 = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(bare2) }) });
  await settle();
  eq('with no reason from the server the sentence drops N rather than inventing it',
    w2.one('hd-dock-empty').textContent, 'no status line in this pane\'s recent output');

  /* the read window, when the response reports it, names the N */
  const bare3 = JSON.parse(JSON.stringify(bare));
  bare3.absent = {}; bare3.lines_read = 80;
  const w3 = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(bare3) }) });
  await settle();
  eq('a reported read window is named in the sentence', w3.one('hd-dock-empty').textContent, 'no status line in the last 80 lines');

  /* a pane whose agent is neither family */
  const other = {
    ok: true, pane_id: 'w1:p1', agent: 'codex', family: 'other',
    status: null, context: null, processes: null, absent: {}
  };
  const w4 = makeWorld({ pane: 'w1:p1', responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(other) }) });
  await settle();
  eq('another family gets the contract\'s process sentence', w4.whyText('no-list'), 'this agent prints no process list');
  eq('and its usage section is not drawn as hermes\' or claude\'s',
    [w4.cls('hd-dock-hermes').length, w4.cls('hd-dock-claude').length, w4.cls('hd-dock-bar').length], [0, 0, 0]);
  eq('the family badge says so', w4.root().getAttribute('data-family'), 'other');

  /* a hermes status the parser could only read in part: the gaps are labelled, not filled */
  const partial = {
    ok: true, pane_id: 'w6:p1', agent: 'hermes', family: 'hermes',
    status: {
      source: 'pane_text', source_line: HERMES_LINE_B, elided: false, confidence: 'partial',
      approx: false, model: 'deepseek-flash', used_tokens: 146000, limit_tokens: null,
      used_pct: null, cache_pct: 97.9, elapsed_s: null
    },
    context: null,
    processes: { source: 'pane_text', running: 0, hint: PROC_HINT, items: [] },
    absent: {}
  };
  const w5 = makeWorld({ pane: 'w6:p1', responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(partial) }) });
  await settle();
  eq('a partial status labels the missing half instead of filling it',
    w5.figText('used'), '146,000 / limit unknown (partial)');
  eq('and the gap is flagged', w5.fig('used').getAttribute('data-missing'), '1');
  eq('a missing percentage is stated, not computed from the tokens', w5.figText('pct'), 'no percentage printed');
  eq('with no percentage, no bar is drawn', w5.one('hd-dock-bar').getAttribute('data-pct'), 'none');
  eq('and the section says so', w5.whyText('no-pct'), 'the agent printed no percentage — no bar is drawn');
  eq('a missing elapsed figure is labelled', w5.figText('elapsed'), 'elapsed not printed');
  eq('no approx badge when the agent wrote no ~', w5.one('hd-dock-approx'), null);
  eq('zero processes is the agent\'s own value, not an empty box', w5.text('hd-dock-procs-head'), '0 processes running');
  eq('and the list area says what that means', w5.whyText('no-procs'),
    'the agent lists no background processes (0 running)');

  /* a partial claude context: the breakdown's gaps are labelled too */
  const cbody = claudeBody();
  cbody.context.breakdown = { input: 223, cache_read: null, cache_create: 0, output: 2404 };
  cbody.context.tokens = null;
  const w6 = makeWorld({ pane: 'w6:p2', responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(cbody) }) });
  await settle();
  eq('a missing breakdown part reads as unknown', w6.text('hd-dock-breakdown'),
    'input 223 · cache read unknown · cache create 0 · output 2,404');
  eq('a missing context size is not invented', w6.figText('context'), 'context size unknown');
  eq('and that gap is flagged', w6.fig('context').getAttribute('data-missing'), '1');
}

// ── the other data path: app.js publishes api.status ──────────────────────

section('the same answer through ctx.api.status, with nothing on the wire (§12.2.3)');

{
  const w = makeWorld({ api: { status: (pane) => Promise.resolve(hermesBody(pane)) } });
  await settle();
  eq('with ctx.api.status the module asks the helper, not fetch', w.calls().length, 0);
  eq('and still renders the same shapes', [w.one('hd-dock-usage').getAttribute('data-shape'), w.figText('pct')], ['hermes', '~17%']);
  w.advance(2000);
  w.tick();
  await settle();
  eq('the cadence is unchanged on that path too', w.calls().length, 0);
  eq('and the panel is live', w.root().getAttribute('data-state'), 'live');
  /* an api.status that reports failure is a described state, not a crash */
  const w2 = makeWorld({ api: { status: () => Promise.resolve({ ok: false, error: { code: 'pane_not_found', message: 'no such pane' } }) } });
  await settle();
  eq('a helper failure is rendered, not thrown', w2.root().getAttribute('data-state'), 'failed');
  eq('with the helper\'s own code', w2.one('hd-dock-stale-msg').getAttribute('data-code'), 'pane_not_found');
  /* and a helper that throws synchronously is caught */
  const w3 = makeWorld({ api: { status: () => { throw new Error('helper exploded'); } } });
  await settle();
  eq('a helper that throws does not break the mount', w3.handle.mounted(), true);
  ok('and the throw is on screen', /helper exploded/.test(w3.one('hd-dock-stale-msg').textContent), w3.text('hd-dock-stale-msg'));
}

// ── untrusted agent text stays text ───────────────────────────────────────

section('agent text is untrusted: it is text, never markup');

{
  const body = hermesBody();
  body.processes.items[0].cmd = '<img src=x onerror=alert(1)>';
  body.status.source_line = '</div><script>alert(2)</script>';
  body.processes.items[0].last = '<b>bold</b>';
  const w = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(body) }) });
  await settle();
  const out = html(w.root());
  ok('the injected markup is escaped in the tree',
    out.indexOf('&lt;img src=x onerror=alert(1)&gt;') >= 0 && out.indexOf('&lt;script&gt;') >= 0, out.slice(0, 160));
  eq('no element was created from agent text',
    allEls(w.root()).filter((n) => ['IMG', 'SCRIPT', 'B'].indexOf(n.tagName) >= 0).length, 0);
  eq('the text is on screen verbatim',
    w.cls('hd-dock-proc')[0].children[0].textContent.split('the agent elided')[0], '<img src=x onerror=alert(1)>');
  eq('and nothing was assigned as markup anywhere in the run', INNER_HTML_WRITES, []);
}

// ── the shell element is absent: mount nothing, keep the API alive ─────────

section('the #dockHost-absent path: mount nothing, keep the API alive, adopt later (§12.2.3)');

{
  const w = makeWorld({ dockHost: false, responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) }) });
  await settle();
  const h = w.handle;
  ok('mount() still returns a live handle with the three methods',
    !!h && typeof h.latest === 'function' && typeof h.refresh === 'function' && typeof h.unmount === 'function');
  eq('nothing was mounted', h.mounted(), false);
  eq('latest() is null — no answer has ever been read', h.latest(), null);
  ok('state() says why, by name', /#dockHost is not in this page/.test(h.state().reason), h.state().reason);
  eq('and reports that nothing is polling or in flight',
    [h.state().polling, h.state().label_timer, h.state().inflight], [false, false, false]);
  eq('no timer was registered at all', w.timers.items.size, 0);
  eq('no DOM was created for it', w.doc.body.children.length, 0);

  for (let i = 0; i < 10; i++) { w.advance(2000); w.tick(); w.labelTick(); }
  eq('ten ticks asked the server nothing', w.calls().length, 0);
  w.setPane('w6:p1');
  w.bus.emit('select', { pane_id: 'w6:p1', paneId: 'w6:p1' });
  await settle();
  eq('selecting a pane while unmounted asks nothing either', w.calls().length, 0);
  const res = await h.refresh();
  ok('refresh() resolves with a described no_host answer instead of rejecting',
    !!res && res.ok === false && res.error.code === 'no_host' && /dockHost/.test(res.error.message),
    JSON.stringify(res && res.error));
  eq('and that answered nothing over the wire', w.calls().length, 0);

  /* the host appears: adopt() mounts for real */
  eq('adopt() with still no host reports false', h.adopt(), false);
  w.respond(hermesBody('w6:p1'));                 // the pane that is selected now
  w.doc.add(new El('div'), 'dockHost');
  eq('adopt() now takes the host', h.adopt(), true);
  await settle();
  eq('it read the selected pane at once', w.panesAsked(), ['w6:p1']);
  ok('and it renders', !!w.root() && w.one('hd-dock-pane').textContent === 'w6:p1');
  ok('the header chip W2 feeds gets an event with the answer',
    w.bus.emitted.filter((e) => e.type === 'dock' && e.payload && e.payload.ok === true).length >= 1,
    JSON.stringify(w.bus.emitted.map((e) => e.type)));
  const chip = w.bus.emitted.filter((e) => e.type === 'dock').pop().payload;
  eq('and that event carries a usage shape a chip can print',
    [chip.shape, chip.percent, chip.pane_id], ['hermes', 17, 'w6:p1']);
  w.clearCalls();
  w.advance(2000);
  w.tick();
  await settle();
  eq('and it now polls on the cadence like any other mount', w.calls().length, 1);

  /* unmount really stops it */
  eq('unmount() reports true', h.unmount(), true);
  eq('the host is emptied', w.root(), null);
  eq('every timer is gone', w.timers.items.size, 0);
  eq('after unmount the module is not mounted and not polling', [h.mounted(), h.state().polling], [false, false]);
  w.clearCalls();
  for (let i = 0; i < 3; i++) { w.advance(2000); w.tick(); }
  eq('and no request can be issued any more', w.calls().length, 0);
  const res2 = await h.refresh();
  eq('refresh() after unmount says so', res2.error.code, 'unmounted');
  eq('the document listener was released', (w.doc.listeners.visibilitychange || []).length, 0);
}

// ── no pane selected, and switching panes ─────────────────────────────────

section('no pane selected, and a pane switch: sentences, never another pane\'s numbers');

{
  const w = makeWorld({ pane: null, responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) }) });
  await settle();
  eq('nothing is asked for without a pane', w.calls().length, 0);
  eq('the panel says what it is waiting for', w.text('hd-dock-msg'),
    'no pane selected — the dock reads the status of the pane you select');
  eq('and it claims no live reading', w.root().getAttribute('data-state'), 'reading');
  const res = await w.handle.refresh();
  eq('refresh() without a pane is a described no_pane answer', res.error.code, 'no_pane');
  eq('still nothing on the wire', w.calls().length, 0);

  w.setPane('w6:p1');
  w.respond(hermesBody('w6:p1'));
  w.bus.emit('select', { pane_id: 'w6:p1', paneId: 'w6:p1' });
  await settle();
  eq('the pane that was selected is the one read', w.panesAsked(), ['w6:p1']);
  eq('and its own answer is what is drawn', w.one('hd-dock-pane').textContent, 'w6:p1');

  /* switching panes must not leave the previous pane's numbers on screen for even a moment */
  const w2 = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody('w4:p1')) }) });
  await settle();
  eq('pane A is live first', w2.root().getAttribute('data-state'), 'live');
  w2.respond(() => new Promise(() => {}));                   // pane B never answers
  w2.setPane('w6:p1');
  w2.bus.emit('select', { pane_id: 'w6:p1', paneId: 'w6:p1' });
  await settle();
  eq('on the pane switch the panel is reading, not showing A\'s numbers', w2.root().getAttribute('data-state'), 'reading');
  eq('with a sentence naming the pane', w2.text('hd-dock-msg'),
    'reading w6:p1 … its status has not been read yet — no numbers are shown from another pane');
  eq('and not one node of the previous pane\'s answer',
    [w2.cls('hd-dock-fig').length, w2.cls('hd-dock-proc').length, w2.cls('hd-dock-body').length], [0, 0, 0]);
}

// ── the source area: collapsible, labelled, and free ──────────────────────

section('the source area: collapsible, keyboard-reachable, and no request of its own (§12.2.4)');

{
  const w = makeWorld({ responder: () => ({ ok: true, status: 200, json: () => Promise.resolve(hermesBody()) }) });
  await settle();
  const btn = w.one('hd-dock-src-head');
  eq('the control is a real button, focusable without a custom tabindex', [btn.tagName, btn.type], ['BUTTON', 'button']);
  const before = w.calls().length;
  btn.click();
  eq('opening the source shows the verbatim lines',
    [w.one('hd-dock-src').hidden, btn.getAttribute('aria-expanded'), btn.getAttribute('data-open')], [false, 'true', '1']);
  eq('the control now offers to hide it', btn.textContent, 'hide source · 1 line');
  ok('the control the user pressed is still the node in the tree — a toggle does not throw away the button (and with it keyboard focus)',
    w.one('hd-dock-src-head') === btn, 'the toggle re-rendered the panel and replaced the control');
  eq('opening it issued no request of its own', w.calls().length, before);
  btn.click();
  eq('closing it folds the lines again', [w.one('hd-dock-src').hidden, btn.getAttribute('aria-expanded')], [true, 'false']);
  btn.click();
  eq('and the state is remembered, per pane', w.handle.state().source_open, { 'w4:p1': true });

  /* a failure while the source is open must still leave a described panel, never a blank one */
  w.rejectWith(new Error('boom'));
  w.advance(2000);
  w.tick();
  await settle();
  ok('a failed read still leaves the failure sentence and its sections',
    !!w.one('hd-dock-stale-msg') && w.cls('hd-dock-sec').length >= 3, 'no failure sentence or no sections');
}

// ── dock.css: frozen names, the two shapes, the focus/hit-area rules, no motion ──

section('dock.css: the frozen names, the two shapes, the focus and hit-area rules, no motion');

/* the last block of a selector's own rule (skipping the names quoted in the file's header comment) */
function rule(sel) {
  let i = -1;
  while ((i = CSS_SRC.indexOf(sel, i + 1)) >= 0) {
    if (/^\s*[,{]/.test(CSS_SRC.slice(i + sel.length))) {
      const open = CSS_SRC.indexOf('{', i);
      const close = CSS_SRC.indexOf('}', open);
      return CSS_SRC.slice(open + 1, close);
    }
  }
  return '';
}
const CSS_CLASSES = new Set();
for (const m of CSS_SRC.matchAll(/\.hd-dock(-[a-z0-9-]+)?/g)) CSS_CLASSES.add(m[0].slice(1));
const MODULE_CLASSES = new Set();
for (const m of DOCK_SRC.matchAll(/'hd-dock(-[a-z0-9-]+)?'/g)) MODULE_CLASSES.add(m[0].slice(1, -1));
const CSS_VARS = new Set();
for (const m of STYLE_SRC.matchAll(/(--[a-z0-9-]+)\s*:/g)) CSS_VARS.add(m[1]);
const CSS_VARS_USED = new Set();
for (const m of CSS_SRC.matchAll(/var\((--[a-z0-9-]+)\)/g)) CSS_VARS_USED.add(m[1]);

{
  eq('every .hd-dock-* name dock.js builds has a rule in dock.css',
    [...MODULE_CLASSES].filter((c) => !CSS_CLASSES.has(c)), []);
  eq('dock.css carries no .hd-dock-* name the module never builds (no second shape)',
    [...CSS_CLASSES].filter((c) => !MODULE_CLASSES.has(c)), []);
  ok('the frozen inventory is a real inventory', MODULE_CLASSES.size >= 25,
    `${MODULE_CLASSES.size} names: ${[...MODULE_CLASSES].sort().join(' ')}`);
  eq('every var() dock.css uses is declared in style.css',
    [...CSS_VARS_USED].filter((v) => !CSS_VARS.has(v)), []);
  /* motion: there is none to reduce, which is why there is no prefers-reduced-motion block. The
     checks read the DECLARATIONS, so the file's own header prose (which says there is no motion)
     cannot make them pass or fail. */
  const CSS_DECL = CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('dock.css animates nothing at all — no animation, no @keyframes, no transition',
    !/(^|[;\s])animation\s*:/.test(CSS_DECL) && !/@keyframes/.test(CSS_DECL)
    && !/(^|[;\s])transition\s*:/.test(CSS_DECL), 'a motion declaration is present');
  ok('and nothing would be left to reduce, so no reduced-motion block is needed',
    !/prefers-reduced-motion/.test(CSS_DECL));
  ok('nothing in dock.css generates text (no content:)', !/(^|[;\s])content\s*:/.test(CSS_DECL), 'a content: declaration is present');

  /* the two families are different rules, not one rule tinted twice */
  const hermesRule = rule('.hd-dock-hermes');
  const claudeRule = rule('.hd-dock-claude');
  ok('the hermes row is a wrapping row and the claude block is a column',
    /display:\s*flex/.test(hermesRule) && /flex-wrap:\s*wrap/.test(hermesRule) && /flex-direction:\s*column/.test(claudeRule),
    JSON.stringify({ hermesRule, claudeRule }));
  ok('the claude block is marked with its own left border and background, so the two never read as one shape',
    /border-left:\s*2px solid var\(--accent\)/.test(claudeRule) && /background:\s*var\(--bg-panel2\)/.test(claudeRule),
    claudeRule);
  ok('the bar belongs to the hermes row\'s shape only', /\.hd-dock-bar \{/.test(CSS_SRC) && /\.hd-dock-bar\[data-pct="none"\]/.test(CSS_SRC));
  ok('and no bar is placed inside the claude block', !/\.hd-dock-claude[^{]*\.hd-dock-bar/.test(CSS_SRC));

  /* the source control: keyboard-reachable, ringed, at least 20x20 (the §10.9 rule) */
  const headRule = rule('.hd-dock-src-head');
  ok('the source control has a hit area of at least 20x20',
    /min-height:\s*20px/.test(headRule) && /min-width:\s*20px/.test(headRule), headRule);
  ok('the source control looks pressable', /cursor:\s*pointer/.test(headRule), headRule);
  ok('the source control has a visible :focus-visible ring',
    /\.hd-dock-src-head:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/.test(CSS_SRC), 'no ring rule');

  /* a failed read is unmistakable, and the kept answer is dimmed AND labelled */
  const staleRule = rule('.hd-dock-stale');
  ok('a failed read is drawn in the error colour with an inset bar, not a shade of grey',
    /border:\s*1px solid var\(--st-blocked\)/.test(staleRule) && /border-left-width:\s*3px/.test(staleRule)
    && /background:\s*#2a1416/.test(staleRule), staleRule);
  ok('and the failure sentence is not the dim note colour', /color:\s*var\(--st-blocked\)/.test(rule('.hd-dock-stale-msg')),
    rule('.hd-dock-stale-msg'));
  const lastRule = rule('.hd-dock-stale-last');
  ok('the kept last answer is dashed, dimmed, and labelled not current',
    /border:\s*1px dashed var\(--line\)/.test(lastRule) && /opacity:\s*0?\.\d+/.test(lastRule)
    && /\[data-stale-label="1"\]/.test(CSS_SRC), lastRule);
  ok('the kept answer\'s numbers are not drawn in the live colour',
    /\.hd-dock-stale-last \.hd-dock-fig[^{]*\{[^}]*color:\s*var\(--fg-dim\)/.test(CSS_SRC),
    'no dim rule for the stale figures');
  ok('and the head says the failure in the error colour',
    /\.hd-dock-when\[data-state="failed"\]\s*\{\s*color:\s*var\(--st-blocked\)/.test(CSS_SRC), 'no failed label colour');

  /* long agent strings must not widen the dock */
  ok('verbatim lines wrap instead of widening the panel',
    /white-space:\s*pre-wrap/.test(rule('.hd-dock-src-line')) && /overflow-wrap:\s*anywhere/.test(rule('.hd-dock-src-line')),
    rule('.hd-dock-src-line'));
  ok('the panel never scrolls sideways', /overflow-x:\s*hidden/.test(rule('.hd-dock')), rule('.hd-dock'));
  ok('a folded source area is display:none, not merely invisible',
    /\.hd-dock-src\[hidden\]\s*\{\s*display:\s*none/.test(CSS_SRC));
  ok('the process text wraps too', /overflow-wrap:\s*anywhere/.test(rule('.hd-dock-proc-last')), rule('.hd-dock-proc-last'));
}

// ── what W2's shell still has to provide (stated, not assumed) ────────────

section('what W2\'s shell still has to provide (stated, not assumed)');

{
  const indexHtml = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
  console.log(`     index.html as it stands: dock.js ${/lib\/dock\.js/.test(indexHtml) ? 'linked' : 'NOT linked'} · ` +
    `#dockHost ${/id="dockHost"/.test(indexHtml) ? 'present' : 'MISSING'} · ` +
    `dock.css ${/lib\/dock\.css/.test(indexHtml) ? 'linked' : 'not linked'}`);
  const w = makeWorld({ dockHost: false });
  eq('the module mounts nothing when the shell is missing, whatever the page says today',
    [w.handle.mounted(), w.calls().length], [false, 0]);
  /* dock.css must be self-loadable: index.html is W2's file (§12.4) */
  const w2 = makeWorld({ linkCss: false });
  eq('a page with no dock.css link gets exactly one added by the module', w2.doc.linksTo('dock.css').length, 1);
  eq('and it points at the module\'s own file', w2.doc.linksTo('dock.css')[0].getAttribute('href'), '/lib/dock.css');
  const w3 = makeWorld({ linkCss: true });
  eq('a page that already links dock.css gets no second link', w3.doc.linksTo('dock.css').length, 1);
  const w4 = makeWorld({ dockHost: false, linkCss: true });
  eq('and a page with no host is not given a stylesheet for a panel that is not there',
    w4.doc.linksTo('dock.css').length, 1);           // the one the page already had
}

// ── total ───────────────────────────────────────────────────────────────────

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
if (fail) console.log(`failing: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
