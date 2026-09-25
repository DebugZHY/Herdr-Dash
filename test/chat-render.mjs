#!/usr/bin/env node
/* herdr-dash — test/chat-render.mjs · fixture tests for the chat rendering layer (CONTRACT-v2
 * §8.3/§8.4, owner: W3). Zero npm dependencies, no jsdom.
 *
 *   Everything except the last section runs on the shim below: no browser at all. The last section
 *   (§10, "as the engine lays them out") drives headless Chrome over CDP against the real page,
 *   because "the failed chip does not look like the ready one" and "the 200-character name does not
 *   widen the row" are questions about COMPUTED style and laid-out boxes — a regex over the
 *   stylesheet cannot tell a declaration that applies from one that is overridden, and the shim has
 *   no layout. That section starts its own throwaway static server on a private port and its own
 *   headless browser; it is a hard failure, not a skip, when the browser is missing (set HD_CHROME to
 *   point at one), because a skipped style check is exactly the "assert the intention" this round
 *   asked to stop doing.
 *
 * WHY A DOM SHIM AND NOT STRUCTURAL ASSERTIONS
 *
 *   The point of this round is that untrusted text (a prompt, an agent's prose, a tool result —
 *   anything an agent printed or fetched) must never become markup. A test that asserted on a
 *   plain object structure ("the code block is at structure[2].code") could not tell whether the
 *   renderer had built a `<pre>` with textContent or had pasted a string into innerHTML: both
 *   would look the same to the structure. So this file carries a ~150-line shim that:
 *     - records EVERY innerHTML assignment, and fails the run if any of them is not '' (§8.3
 *       allows exactly one use: assigning '' to clear);
 *     - serialises the produced tree back to HTML with text escaped, so the assertions can look
 *       for '<img' / '<script' in the OUTPUT the way a browser's parser would see it;
 *     - exposes the tree as nodes, so the run can assert the tag whitelist — if a message text
 *       ever produced an element, the tag would not be one this renderer creates.
 *   The shim is deliberately separate from _scratch/w3/dom.mjs: test/ must stand alone, and this
 *   one has a different job (serialisation + innerHTML policing rather than event-driven module
 *   mounting). It is not a DOM: it implements only what chat-render.js uses, and the run fails if
 *   the renderer reaches for anything the shim lacks (the throw surfaces as a FAIL, not a pass).
 *
 * Usage: node test/chat-render.mjs
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO = path.resolve(import.meta.dirname, '..');
const LIB = path.join(REPO, 'public', 'lib');
const RENDER_SRC = fs.readFileSync(path.join(LIB, 'chat-render.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(LIB, 'chatview.css'), 'utf8');

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

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

class TextNode {
  constructor(text) { this.nodeType = 3; this._text = String(text); this.parentNode = null; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get children() { return []; }
}

class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.parentNode = null;
    this._text = null;
    this.className = '';
    this.hidden = false;
    this.title = '';
  }
  appendChild(n) {
    if (!n || typeof n !== 'object') throw new Error('appendChild(non-node)');
    if (n.nodeType === 11) {                      // a fragment moves its children, like the DOM
      for (const c of n.children.slice()) this.appendChild(c);
      n.children.length = 0;
      return n;
    }
    this.children.push(n);
    n.parentNode = this;
    return n;
  }
  get textContent() {
    if (this._text !== null) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) { this.children.length = 0; this._text = String(v); }
  set innerHTML(v) {
    if (String(v) !== '') INNER_HTML_WRITES.push({ tag: this.tagName, html: String(v) });
    this.children.length = 0;
    this._text = String(v);
  }
  get innerHTML() { return html(this); }
  setAttribute(k, v) { this.attrs[String(k)] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type) {
    const ev = { type, target: this, preventDefault() {}, stopPropagation() {} };
    for (const fn of (this.listeners[type] || []).slice()) fn(ev);
    return ev;
  }
  click() { return this.dispatch('click'); }
}

class Fragment {
  constructor() { this.nodeType = 11; this.children = []; this.parentNode = null; }
  appendChild(n) { this.children.push(n); n.parentNode = this; return n; }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
}

function html(n) {
  if (!n) return '';
  if (n.nodeType === 3) return esc(n._text);
  // Anything that is not a node at all is a mistake in the test (a fixture passed where a rendered
  // element belongs). Say so loudly: silently serialising it would let the assertion pass vacuously.
  if (n.nodeType !== 1 && n.nodeType !== 11) {
    throw new Error('html(): not a node — a fixture (message object) was passed instead of a rendered element');
  }
  if (n.nodeType === 11) return (n.children || []).map(html).join('');
  const attrs = [];
  if (n.className) attrs.push(`class="${esc(n.className)}"`);
  if (n.title) attrs.push(`title="${esc(n.title)}"`);
  if (n.hidden) attrs.push('hidden');
  for (const k of Object.keys(n.attrs || {})) attrs.push(`${k}="${esc(n.attrs[k])}"`);
  const tag = String(n.tagName || '?').toLowerCase();
  const inner = n._text != null ? esc(n._text) : (n.children || []).map(html).join('');
  return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</${tag}>`;
}

const doc = {
  createElement: (t) => new El(t),
  createTextNode: (t) => new TextNode(t),
  createDocumentFragment: () => new Fragment(),
};

function loadRenderer() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = doc;
  vm.createContext(sandbox);
  vm.runInContext(RENDER_SRC, sandbox, { filename: 'chat-render.js' });
  return sandbox;
}
const SB = loadRenderer();
const CR = SB.window.ChatRender;
const T = SB.window.HD && SB.window.HD.chatRenderTest;

/* The same file with a feature's wiring neutralised, for "this change is additive" checks (A2 below):
   the variant is the same code everywhere else, so a byte comparison of its output against the real
   renderer's isolates exactly what the feature added — no golden strings to keep in sync, and it fails
   loudly if the anchor text ever moves. Each anchor must be found or the run stops. */
function loadVariant(replacements) {
  let src = RENDER_SRC;
  for (const [from, to] of replacements) {
    if (src.indexOf(from) < 0) throw new Error(`the variant anchor is gone from chat-render.js: ${from}`);
    src = src.replace(from, to);
  }
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = doc;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'chat-render.variant.js' });
  return sandbox.window.ChatRender;
}

// tree helpers (this file's, not the shim's)
function walk(n, fn) {
  if (!n) return;
  fn(n);
  for (const c of (n.children || [])) walk(c, fn);
}
function allEls(root) { const out = []; walk(root, (n) => { if (n.nodeType === 1) out.push(n); }); return out; }
function byClass(root, cls) {
  return allEls(root).filter((n) => n.className.split(/\s+/).indexOf(cls) >= 0);
}
/* A missing node must produce a clear FAIL, not a TypeError that aborts the run and hides every
   assertion after it. So `one()` never returns null: it returns a stand-in whose every accessor
   reports the absence. `textOfClass` still returns null (an assertion wants to see that). */
function one(root, cls) {
  const hits = byClass(root, cls);
  if (hits.length) return hits[0];
  return {
    nodeType: 1, tagName: 'MISSING', children: [], className: '', hidden: null, title: null,
    parentNode: null, baseURI: '', ownerDocument: doc,
    textContent: `(no .${cls} node was rendered)`, attrs: {},
    getAttribute: () => null, setAttribute() {}, addEventListener() {}, dispatch() {}, click() {},
  };
}
function textOfClass(root, cls) { const hits = byClass(root, cls); return hits.length ? hits[0].textContent : null; }
/* `one(x, c).parentNode.className` and `one(x, c).hidden` are the two spellings that would throw on
   the stand-in above; these say what a missing node's parent/visibility is without dereferencing. */
function parentClass(node) { return (node && node.parentNode) ? String(node.parentNode.className) : '(no parent — nothing was rendered)'; }
function hiddenOf(node) { return node ? node.hidden : '(no node — nothing was rendered)'; }
function textsOfClass(root, cls) { return byClass(root, cls).map((n) => n.textContent); }
function tags(root) { return Array.from(new Set(allEls(root).map((n) => n.tagName))).sort(); }
/** Render a list and flatten it into a container, the way the panel would. */
function listRoot(messages, opts) {
  const frag = CR.renderList(messages, opts);
  const box = doc.createElement('div');
  box.appendChild(frag);
  return { frag, box };
}

const ALLOWED_TAGS = ['A', 'BUTTON', 'CODE', 'DIV', 'PRE', 'SPAN', 'STRONG'];
const MARKUP_SIGNS = ['<img', '<script', '<iframe', '<svg', '<object', '<embed', '<style', '<link', '<form'];
function noInjectedMarkup(root) {
  const h = html(root);
  const found = MARKUP_SIGNS.filter((s) => h.indexOf(s) >= 0);
  const badTags = tags(root).filter((t) => ALLOWED_TAGS.indexOf(t) < 0);
  // an attribute that could run code, if a message ever became one
  const badAttrs = [];
  for (const n of allEls(root)) for (const k of Object.keys(n.attrs || {})) if (/^on/i.test(k)) badAttrs.push(k);
  return { found, badTags, badAttrs, html: h };
}

// fixtures
// NOTE the signatures: MSG/CALL/RESULT return a §8.2 MESSAGE OBJECT, not a rendered element — they
// must be passed to CR.renderMessage/renderList/renderTurn. CALL(toolOverrides, msgOverrides) folds
// the first argument into `tool`, so a `tool:` key in the SECOND argument replaces the whole tool
// object (that reads as a fixture bug whenever a result "disappears").
const T0 = 1700000000000;             // 2023-11-14T22:13:20Z, a fixed instant
const MSG = (over) => Object.assign({ key: 'k1', ts: T0, role: 'assistant', kind: 'text', text: 'hello', sidechain: false }, over);
const TOOL = (over) => Object.assign({ name: 'Bash', call_key: 'c1', input: { command: 'npm test' } }, over);
const CALL = (tool, over) => MSG(Object.assign({ kind: 'tool_call', role: 'assistant', text: '', tool: TOOL(tool) }, over));
const RESULT = (tool, over) => MSG(Object.assign({ kind: 'tool_result', role: 'tool', text: 'ok', tool: TOOL(tool) }, over));
const lines = (n, p) => Array.from({ length: n }, (_, i) => (p || 'L') + (i + 1)).join('\n');

// A1 fixtures. A turn: {user, segments, working, elapsedMs, pending} — segments are §8.2 messages.
const TURN = (over) => Object.assign({
  user: MSG({ key: 'u1', role: 'user', kind: 'text', text: 'please fix it' }),
  segments: [], working: false, elapsedMs: 0, pending: false,
}, over);
/** The agent's process, in log order: thinking -> call -> interim text -> call -> final text. */
const SEGMENTS = () => [
  MSG({ key: 's1', kind: 'thinking', text: 'the file must be read first' }),
  CALL({ result: 'file contents', call_key: 'c2' }, { key: 's2' }),
  MSG({ key: 's3', kind: 'text', text: 'checking the second file' }),
  CALL({ name: 'Read', call_key: 'c4', input: { file_path: 'a/b.js' }, result: 'more contents' }, { key: 's4' }),
  MSG({ key: 's5', kind: 'text', text: 'done: the bug was a stale cache' }),
];
const msgKeys = (root) => byClass(root, 'hd-cv-msg').map((n) => n.getAttribute('data-key'));
const segKinds = (root) => byClass(root, 'hd-cv-msg').map((n) => n.getAttribute('data-kind'));
const notesOf = (root) => byClass(root, 'hd-cv-note').map((n) => n.textContent);

// ── §8.5 the frozen interface ────────────────────────────────────────────────

section('§8.5 — the frozen interface exists under the frozen names');
{
  ok('window.ChatRender is published at load time', !!CR, Object.keys(SB.window).join(','));
  ok('renderMessage(msg, opts) -> Element', typeof (CR || {}).renderMessage === 'function', typeof (CR || {}).renderMessage);
  ok('renderList(messages, opts) -> DocumentFragment', typeof (CR || {}).renderList === 'function', typeof (CR || {}).renderList);
  ok('summaryFor(tool) -> string', typeof (CR || {}).summaryFor === 'function', typeof (CR || {}).summaryFor);
  ok('autoScrollOpts() -> {stickPx}', typeof (CR || {}).autoScrollOpts === 'function', typeof (CR || {}).autoScrollOpts);
  ok('the same object is reachable as HD.chatRender', SB.window.HD.chatRender === CR, 'two different objects');
  eq('autoScrollOpts() returns exactly {stickPx: 48}', CR.autoScrollOpts(), { stickPx: 48 });
  ok('and a fresh object each call (a caller may keep it)',
    CR.autoScrollOpts() !== CR.autoScrollOpts(), 'the same object was returned twice');
  const a = CR.autoScrollOpts(); a.stickPx = 1;
  eq('mutating one does not change the next', CR.autoScrollOpts().stickPx, 48);
  ok('the pure parts are published for this harness', !!T && typeof T.fmtTime === 'function', 'no HD.chatRenderTest');
}

// ── bubbles, roles, kinds ────────────────────────────────────────────────────

section('§8.3 — bubbles: user right, assistant left, system as a note');
{
  const u = CR.renderMessage(MSG({ role: 'user', kind: 'text', text: 'do the thing' }));
  eq('a user message is a user-role element', byClass(u, 'hd-cv-role-user').length, 1);
  eq('and it is a bubble', byClass(u, 'hd-cv-bubble').length, 1);
  eq('with the prompt text verbatim', textOfClass(u, 'hd-cv-bubble'), 'do the thing');
  ok('it carries the "mine" hook the stylesheet tints', byClass(u, 'hd-cv-mine').length === 1, 'no hd-cv-mine');

  const a = CR.renderMessage(MSG({ role: 'assistant', text: 'I did it' }));
  eq('an assistant message is an assistant-role element', byClass(a, 'hd-cv-role-assistant').length, 1);
  eq('and its bubble has the text verbatim', textOfClass(a, 'hd-cv-bubble'), 'I did it');

  const sys = CR.renderMessage(MSG({ role: 'assistant', kind: 'system', text: 'permission granted' }));
  eq('a system record is a small note (.hd-cv-sys)', byClass(sys, 'hd-cv-sys').length, 1);
  eq('and is NOT a bubble', byClass(sys, 'hd-cv-bubble').length, 0);
  eq('with its text verbatim', textOfClass(sys, 'hd-cv-sys'), 'permission granted');

  const unk = CR.renderMessage(MSG({ kind: 'file-history-delta', text: 'x' }));
  ok('an unknown kind says so and names the kind',
    /does not know \(file-history-delta\)/.test(unk.textContent), unk.textContent);
  eq('and still shows the text it came with', textOfClass(unk, 'hd-cv-p'), 'x');

  eq('the message key is on the element for W2 to find', a.getAttribute('data-key'), 'k1');
  eq('and the kind/role are readable as attributes', [a.getAttribute('data-kind'), a.getAttribute('data-role')], ['text', 'assistant']);
}

section('§8.3 — timestamps: HH:MM:SS visible, the full date in the title');
{
  const d = new Date(T0);
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  const wantTime = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  const wantFull = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
    ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  const m = CR.renderMessage(MSG({}));
  const span = one(m, 'hd-cv-time');
  eq('the visible time is HH:MM:SS', span.textContent, wantTime);
  ok('and matches the shape a reader can scan', /^\d{2}:\d{2}:\d{2}$/.test(span.textContent), span.textContent);
  eq('the title carries the full date', span.title, wantFull);
  eq('fmtTime agrees with the rendered time', T.fmtTime(T0), wantTime);
  eq('fmtFull agrees with the rendered title', T.fmtFull(T0), wantFull);
  eq('a string timestamp is accepted', T.fmtTime(String(T0)), wantTime);

  const none = one(CR.renderMessage(MSG({ ts: null })), 'hd-cv-time');
  eq('a record with no timestamp says so instead of inventing one', none.textContent, '--:--:--');
  eq('and its title is honest about it', none.title, 'this record carries no timestamp');
  eq('junk timestamps are treated the same', [T.fmtTime('nope'), T.fmtTime(-1), T.fmtTime(NaN), T.fmtTime(0)],
    [null, null, null, null]);
}

// ── markdown-lite ───────────────────────────────────────────────────────────

section('§8.3 — the safe markdown subset: fences, inline code, bold, bare URLs');
{
  const fence = CR.renderMessage(MSG({ text: 'before\n```js\nconst a = 1;\n```\nafter' }));
  const pre = one(fence, 'hd-cv-code');
  ok('a fenced block becomes <pre class="hd-cv-code">', !!pre, html(fence));
  eq('with the code verbatim, fence markers gone', pre.textContent, 'const a = 1;');
  eq('its language is shown as a badge', textOfClass(fence, 'hd-cv-lang'), 'js');
  eq('the prose around it is kept', textsOfClass(fence, 'hd-cv-p'), ['before', 'after']);
  eq('a fence without a language still renders', one(CR.renderMessage(MSG({ text: '```\nx\n```' })), 'hd-cv-code').textContent, 'x');
  eq('an unclosed fence runs to the end (a preview cut mid-fence stays honest)',
    one(CR.renderMessage(MSG({ text: 'a\n```\nb\nc' })), 'hd-cv-code').textContent, 'b\nc');

  const inl = CR.renderMessage(MSG({ text: 'run `npm test` now' }));
  eq('inline code becomes <code class="hd-cv-icode">', textOfClass(inl, 'hd-cv-icode'), 'npm test');
  eq('and the backticks are gone from the text', one(inl, 'hd-cv-p').textContent, 'run npm test now');

  const bold = CR.renderMessage(MSG({ text: 'this is **important** stuff' }));
  eq('**bold** becomes <strong>', textsOfClass(bold, 'hd-cv-p'), ['this is important stuff']);
  const strongs = allEls(one(bold, 'hd-cv-p')).filter((n) => n.tagName === 'STRONG');
  eq('with the emphasis in a strong element', strongs.map((n) => n.textContent), ['important']);

  const url = CR.renderMessage(MSG({ text: 'see https://example.com/a?b=1 for details' }));
  const link = one(url, 'hd-cv-link');
  ok('a bare URL becomes an anchor', !!link, html(url));
  eq('pointing at the URL', link.getAttribute('href'), 'https://example.com/a?b=1');
  eq('with the URL as its text', link.textContent, 'https://example.com/a?b=1');
  eq('opened safely in a new tab', [link.getAttribute('target'), link.getAttribute('rel')],
    ['_blank', 'noopener noreferrer']);
  eq('the words around it stay text', one(url, 'hd-cv-p').textContent, 'see https://example.com/a?b=1 for details');

  const punct = CR.renderMessage(MSG({ text: 'go to https://example.com/x.' }));
  eq('a sentence\'s full stop is not swallowed into the link',
    one(punct, 'hd-cv-link').getAttribute('href'), 'https://example.com/x');
  eq('and it stays in the visible text', one(punct, 'hd-cv-p').textContent, 'go to https://example.com/x.');

  const js = CR.renderMessage(MSG({ text: 'click javascript:alert(1) and data:text/html,x' }));
  eq('javascript:/data: are never turned into links', byClass(js, 'hd-cv-link').length, 0);
  ok('they stay as literal text', one(js, 'hd-cv-p').textContent.indexOf('javascript:alert(1)') >= 0,
    one(js, 'hd-cv-p').textContent);

  // Two layers refuse a hostile scheme: the URL pattern only recognises http(s), and linkNode
  // itself degrades to a text node for anything else. With both in place each hides the other, so
  // the pair can only be tested from both ends: the pattern by rendering (below, via a URL the
  // guard would happily accept but a narrowed pattern would miss), and the guard by calling it.
  eq('a URL in any case is still a link (the pattern is case-insensitive)',
    one(CR.renderMessage(MSG({ text: 'see HTTP://Example.com/x ok' })), 'hd-cv-link').getAttribute('href'),
    'HTTP://Example.com/x');
  for (const scheme of ['javascript:alert(1)', 'data:text/html,<b>x', 'ftp://h/p', 'not a url', '']) {
    const n = T.linkNode(scheme);
    ok(`linkNode(${JSON.stringify(scheme)}) is a text node, not an anchor`,
      n.nodeType === 3 && n.tagName === undefined, `${n.nodeType}/${n.tagName}`);
  }
  const upper = T.linkNode('HTTP://Example.com/x');
  ok('linkNode accepts a scheme in any case', upper.nodeType === 1 && upper.tagName === 'A',
    `${upper.nodeType}/${upper.tagName}`);
  eq('and it is the anchor the renderer builds, opened safely',
    [upper.getAttribute('href'), upper.getAttribute('target'), upper.getAttribute('rel')],
    ['HTTP://Example.com/x', '_blank', 'noopener noreferrer']);
}

// ── injection ───────────────────────────────────────────────────────────────

section('§8.3 — agent output is untrusted: it can never become markup');
{
  const IMG = '<img src=x onerror=alert(1)>';
  const SCRIPT = '<script>alert(1)</script>';

  const cases = [
    ['message text with an <img onerror>', MSG({ text: 'hi ' + IMG + ' there' }), IMG],
    ['message text with a <script>', MSG({ text: SCRIPT }), SCRIPT],
    ['bold wrapping an <img>', MSG({ text: '**' + IMG + '**' }), IMG],
    ['a fence holding a <script>', MSG({ text: '```\n' + SCRIPT + '\n```' }), SCRIPT],
    ['inline code holding an <img>', MSG({ text: '`' + IMG + '`' }), IMG],
    ['a system note holding a <script>', MSG({ kind: 'system', text: SCRIPT }), SCRIPT],
    ['an unknown kind holding an <img>', MSG({ kind: 'ai-title', text: IMG }), IMG],
    ['a thinking body holding a <script>', MSG({ kind: 'thinking', text: SCRIPT }), SCRIPT],
    ['a user prompt holding a <script>', MSG({ role: 'user', text: SCRIPT }), SCRIPT],
    ['a tool name holding an <img>', CALL({ name: IMG }), IMG],
    ['a tool summary (input) holding a <script>', CALL({ name: 'Bash', input: { command: SCRIPT } }), SCRIPT],
    ['a tool result holding a <script>', CALL({ result: SCRIPT }), SCRIPT],
    ['an unpaired result holding an <img>', RESULT({ result: IMG }), IMG],
    ['a URL followed by markup', MSG({ text: 'https://x/"><img src=x onerror=1>' }), '<img'],
    // (e) all three no-result paths, with the payload where it would do damage: the summary is built
    // from the call's input, and the result is drawn through the same text path as any other.
    ['an awaiting card with a <script> in its summary',
      CALL({ name: 'Bash', pending: true, pending_reason: 'awaiting', input: { command: SCRIPT } }), SCRIPT],
    ['a not-in-window card with a <script> in its summary',
      CALL({ name: 'Bash', pending: true, pending_reason: 'not_in_window', input: { command: SCRIPT } }), SCRIPT],
    ['a card with no pending_reason at all, holding an <img> in its summary',
      CALL({ name: 'Bash', pending: true, input: { command: IMG } }), IMG],
    ['an awaiting card with a result holding an <img>',
      CALL({ name: 'Bash', pending: true, pending_reason: 'awaiting', result: IMG }), IMG],
    ['a not-in-window card whose result holds a <script> (the result wins over the reason)',
      CALL({ name: 'Bash', pending: true, pending_reason: 'not_in_window', result: SCRIPT }), SCRIPT],
    ['a not-in-window card with a <script> in its input and no result',
      CALL({ name: 'Bash', pending: true, pending_reason: 'not_in_window', input: { command: SCRIPT } }), SCRIPT],
  ];
  for (const [label, msg, needle] of cases) {
    const node = CR.renderMessage(msg);
    const scan = noInjectedMarkup(node);
    const literal = node.textContent.indexOf(needle) >= 0;
    ok(`${label}: comes out as literal text`, literal, node.textContent);
    ok(`${label}: no injected element survives`, scan.found.length === 0 && scan.badTags.length === 0,
      JSON.stringify(scan));
  }
  // the new state's label is the renderer's own sentence: nothing from the record can reach it
  const hostileStale = CR.renderMessage(CALL({ name: IMG, pending: true, pending_reason: 'not_in_window',
    input: { command: SCRIPT } }));
  eq('a hostile not-in-window card still carries exactly the renderer\'s own sentence',
    textOfClass(hostileStale, 'hd-cv-stale'),
    'no result in the loaded window (older record) — press "load older" to look further back');

  // the whole list at once, the way the panel renders a conversation
  const inj = listRoot([
    MSG({ key: 'a', role: 'user', text: 'prompt ' + SCRIPT }),
    MSG({ key: 'b', text: IMG }),
    CALL({ result: '<pre>' + SCRIPT }, { key: 'c' }),
    RESULT({ result: IMG }, { key: 'd' }),
    MSG({ key: 'e', kind: 'thinking', text: SCRIPT }),
  ]).box;
  const listScan = noInjectedMarkup(inj);
  ok('a whole conversation cannot produce markup either',
    listScan.found.length === 0 && listScan.badTags.length === 0 && listScan.badAttrs.length === 0,
    JSON.stringify(listScan));
  ok('every element is one this renderer creates', tags(inj).every((t) => ALLOWED_TAGS.indexOf(t) >= 0),
    JSON.stringify(tags(inj)));
  ok('and no message text became an attribute either', listScan.badAttrs.length === 0, JSON.stringify(listScan.badAttrs));

  eq('the renderer assigned a non-empty innerHTML exactly never', INNER_HTML_WRITES, []);

  // the static side of the same rule: the source has no other innerHTML use
  const writes = RENDER_SRC.match(/innerHTML\s*=\s*[^;]+;/g) || [];
  eq('the only innerHTML assignment in the source is clearing', writes.map((s) => s.replace(/\s+/g, ' ')), ["innerHTML = '';"]);
  ok('and the module never calls insertAdjacentHTML/document.write/eval',
    !/insertAdjacentHTML|document\.write|eval\(|new Function/.test(RENDER_SRC), 'a dynamic-execution API is present');
}

// ── thinking ────────────────────────────────────────────────────────────────

section('§8.3 — thinking is collapsed by default and counts its characters');
{
  const text = 'let me think: 思考 and one 👍 emoji';
  const m = CR.renderMessage(MSG({ kind: 'thinking', text }));
  const head = one(m, 'hd-cv-think-head');
  const body = one(m, 'hd-cv-think-body');
  const chars = T.charCount(text);
  eq('the header is exactly "thinking · N chars"', head.textContent, 'thinking · ' + chars + ' chars');
  ok('N counts characters, not UTF-16 units (the emoji is one)', chars === Array.from(text).length && chars !== text.length,
    `chars=${chars} length=${text.length}`);
  eq('the body starts hidden', body.hidden, true);
  eq('and the header says so for assistive tech', head.getAttribute('aria-expanded'), 'false');
  eq('the body holds the record verbatim', body.textContent, text);
  // A3.1: the state is the READER's, read out of opts.openKeys — the renderer keeps no state of its
  // own and attaches no listener (which is what used to make a re-render collapse the block).
  eq('the head names the A3 id of this record\'s thinking row', head.getAttribute('data-hd-open'), 'k1#think0');
  const opened = CR.renderMessage(MSG({ kind: 'thinking', text }), { openKeys: { 'k1#think0': true } });
  eq('openKeys opens the body', one(opened, 'hd-cv-think-body').hidden, false);
  ok('and no hidden attribute is left in its markup (nothing hides it by CSS either)',
    html(one(opened, 'hd-cv-think-body')).indexOf(' hidden') < 0,
    html(one(opened, 'hd-cv-think-body')).slice(0, 90));
  eq('and the header states the open state', one(opened, 'hd-cv-think-head').getAttribute('aria-expanded'), 'true');
  eq('the body carries the open marker A3.3 names', one(opened, 'hd-cv-think-body').className, 'hd-cv-think-body hd-cv-open');
  eq('and a click still changes nothing: the renderer owns no state and no listener (A3.3)',
    (() => { one(opened, 'hd-cv-think-head').click(); return hiddenOf(one(opened, 'hd-cv-think-body')); })(), false);
  const empty = CR.renderMessage(MSG({ kind: 'thinking', text: '' }));
  eq('an empty thinking record says so, and counts 0', [one(empty, 'hd-cv-think-head').textContent, one(empty, 'hd-cv-think-body').textContent],
    ['thinking · 0 chars', '(this thinking record has no text)']);
}

// ── tool cards ──────────────────────────────────────────────────────────────

section('§8.3 — tool cards: name, summary, input as 2-space JSON, result, states');
{
  const withRes = CR.renderMessage(CALL({ result: 'all tests passed\n2 files' }));
  const head = one(withRes, 'hd-cv-card-head');
  eq('the card names the tool', textOfClass(withRes, 'hd-cv-name'), 'Bash');
  eq('the header carries the one-line summary', textOfClass(withRes, 'hd-cv-sum'), '$ npm test');
  eq('the summary is also what summaryFor() says', textOfClass(withRes, 'hd-cv-sum'), CR.summaryFor(TOOL()));
  const body = one(withRes, 'hd-cv-card-body');
  eq('the body starts collapsed', body.hidden, true);
  eq('with a control that says what it does', textOfClass(withRes, 'hd-cv-toggle'), 'expand');
  // A3.1: the card's state is the reader's, keyed by the call's own id (A3.2) and read from
  // opts.openKeys — not from a variable inside the render call.
  eq('the toggle names the id A3.2 gives the call', one(withRes, 'hd-cv-toggle').getAttribute('data-hd-open'), 'k1#toolc1');
  const cardOpen = CR.renderMessage(CALL({ result: 'all tests passed\n2 files' }), { openKeys: { 'k1#toolc1': true } });
  eq('openKeys opens the card body', one(cardOpen, 'hd-cv-card-body').hidden, false);
  eq('and the control flips', textOfClass(cardOpen, 'hd-cv-toggle'), 'collapse');
  eq('and the body is marked open for the stylesheet and for W2',
    one(cardOpen, 'hd-cv-card-body').className, 'hd-cv-card-body hd-cv-open');
  eq('the input is pretty-printed with 2 spaces', one(withRes, 'hd-cv-json').textContent,
    '{\n  "command": "npm test"\n}');
  eq('the result is shown verbatim, monospaced', one(withRes, 'hd-cv-res').textContent, 'all tests passed\n2 files');
  eq('both sections are labelled', textsOfClass(withRes, 'hd-cv-sec'), ['input', 'result']);

  const noRes = CR.renderMessage(CALL({}));
  eq('a call with no result yet renders NO empty result block',
    [byClass(noRes, 'hd-cv-res').length, textsOfClass(noRes, 'hd-cv-sec')], [0, ['input']]);
  ok('and it is not dressed as waitin when it is not pending', !/waiting for result/.test(noRes.textContent), noRes.textContent);

  const pending = CR.renderMessage(CALL({ pending: true, input: null }));
  ok('pending:true says "waiting for result…"', /waiting for result…/.test(pending.textContent), pending.textContent);
  ok('and marks the card, so it cannot look like a finished call',
    byClass(pending, 'hd-cv-pendingcard').length === 1 && byClass(pending, 'hd-cv-pending').length === 1,
    html(pending));

  // ── round 7.3: a call with no result must not claim something is happening right now ──────────
  // W1's tool.pending_reason says WHY the result is absent. Measured on pane w4:p1: the tail window
  // held 201 cards, 37 with `pending: true`, and those calls were 21,484–32,502 s old (6–9 hours) —
  // every one of them drawing the amber pulse and promising a result that was never coming from this
  // view. 'awaiting' keeps today's wording; 'not_in_window' must stop claiming.
  const awaiting = CR.renderMessage(CALL({ pending: true, pending_reason: 'awaiting' }));
  ok('(a) pending_reason:awaiting still says "waiting for result…"',
    /waiting for result…/.test(awaiting.textContent), awaiting.textContent);
  eq('(a) and still carries the pending card and pulse classes',
    [byClass(awaiting, 'hd-cv-pendingcard').length, byClass(awaiting, 'hd-cv-pending').length], [1, 1]);
  eq('(a) with nothing of the stale state on it',
    [byClass(awaiting, 'hd-cv-stale').length, byClass(awaiting, 'hd-cv-stalecard').length], [0, 0]);

  const stale = CR.renderMessage(CALL({ pending: true, pending_reason: 'not_in_window' }));
  ok('(b) pending_reason:not_in_window never claims the result is still coming',
    !/waiting for result/.test(stale.textContent), stale.textContent);
  ok('(b) and shows the neutral label instead', byClass(stale, 'hd-cv-stale').length === 1,
    html(stale));
  eq('(b) the card carries no pulse class and no amber pending span',
    [byClass(stale, 'hd-cv-pending').length, byClass(stale, 'hd-cv-pendingcard').length], [0, 0]);
  eq('(b) it is a different card from the awaiting one', byClass(stale, 'hd-cv-stalecard').length, 1);
  ok('(b) and it says which window the result is missing from',
    /loaded window/.test(stale.textContent) && /older record/.test(stale.textContent), stale.textContent);
  ok('(b) and names the control that goes further back', /"load older"/.test(stale.textContent),
    stale.textContent);
  ok('(b) and does not end in a "…" that promises more to come',
    !/…\s*$/.test(textOfClass(stale, 'hd-cv-stale')), textOfClass(stale, 'hd-cv-stale'));
  // the label is a renderer constant, never assembled from the record
  eq('(b) the label is fixed text, not something derived from the call',
    textOfClass(stale, 'hd-cv-stale'),
    'no result in the loaded window (older record) — press "load older" to look further back');
  // the body of a stale card with nothing in it says the same thing, not the old promise
  const staleNoInput = CR.renderMessage(CALL({ pending: true, pending_reason: 'not_in_window', input: null }));
  eq('(b) a stale card with neither input nor result states it in the body too',
    [textsOfClass(staleNoInput, 'hd-cv-stale').length, /waiting for result/.test(staleNoInput.textContent)],
    [2, false]);

  const absent = CR.renderMessage(CALL({ pending: true }));
  eq('(c) with the field absent the card falls back to the awaiting wording',
    [textOfClass(absent, 'hd-cv-pending'), byClass(absent, 'hd-cv-pendingcard').length,
      byClass(absent, 'hd-cv-stale').length, byClass(absent, 'hd-cv-stalecard').length],
    ['waiting for result…', 1, 0, 0]);
  eq('(c) an unknown reason is not treated as stale either',
    byClass(CR.renderMessage(CALL({ pending: true, pending_reason: 'maybe_later' })), 'hd-cv-stale').length, 0);
  eq('(c) and a non-string reason cannot decide anything',
    byClass(CR.renderMessage(CALL({ pending: true, pending_reason: { why: 'not_in_window' } })), 'hd-cv-stale').length, 0);
  eq('(c) nor does a reason on a card that is not pending',
    byClass(CR.renderMessage(CALL({ pending_reason: 'not_in_window' })), 'hd-cv-stale').length, 0);

  // (d) a card that HAS a result renders it, whatever the flags say
  const withResultAwaiting = CR.renderMessage(CALL({ pending: true, pending_reason: 'awaiting', result: 'done' }));
  const withResultStale = CR.renderMessage(CALL({ pending: true, pending_reason: 'not_in_window', result: 'done' }));
  eq('(d) a card with a result is not "waiting", even with pending:true',
    [byClass(withResultAwaiting, 'hd-cv-pending').length, byClass(withResultAwaiting, 'hd-cv-pendingcard').length],
    [0, 0]);
  eq('(d) and not "not in the window" either',
    [byClass(withResultStale, 'hd-cv-stale').length, byClass(withResultStale, 'hd-cv-stalecard').length], [0, 0]);
  eq('(d) both draw the result itself',
    [one(withResultAwaiting, 'hd-cv-res').textContent, one(withResultStale, 'hd-cv-res').textContent],
    ['done', 'done']);
  eq('(d) an EMPTY result is a result too, not a wait',
    byClass(CR.renderMessage(CALL({ pending: true, pending_reason: 'not_in_window', result: '' })), 'hd-cv-stale').length, 0);
  eq('(d) and a result the card hides behind a collapse is still a result',
    byClass(CR.renderMessage(CALL({ pending: true, pending_reason: 'not_in_window', result: lines(60) })), 'hd-cv-stale').length, 0);
  eq('(d) the wording is not decided by the reason on an unpaired RESULT record',
    byClass(CR.renderMessage(RESULT({ pending: true, pending_reason: 'not_in_window', result: 'late' })), 'hd-cv-stale').length, 0);

  const expanded = CR.renderMessage(CALL({ result: 'r' }), { expandTools: true });
  eq('opts.expandTools:true opens cards from the start', one(expanded, 'hd-cv-card-body').hidden, false);

  const err = CR.renderMessage(CALL({ is_error: true, result: 'boom' }));
  ok('is_error shows a red accent class', byClass(err, 'hd-cv-err').length === 1, html(err));
  eq('and the word "error"', textOfClass(err, 'hd-cv-errword'), 'error');

  const tIn = CR.renderMessage(CALL({ input: { command: 'x' }, input_truncated: true }));
  ok('input_truncated says the server cut it', /input truncated by the server/.test(tIn.textContent), tIn.textContent);
  const tRes = CR.renderMessage(CALL({ result: 'x', result_truncated: true }));
  ok('result_truncated says the server cut it', /result truncated by the server/.test(tRes.textContent), tRes.textContent);
  ok('a truncated record does not claim to be complete', !/complete/.test(tRes.textContent), tRes.textContent);

  const emptyRes = CR.renderMessage(CALL({ result: '' }));
  ok('an empty result is shown as a note, not as a blank block',
    /empty result/.test(emptyRes.textContent) && byClass(emptyRes, 'hd-cv-res').length === 0, html(emptyRes));

  const bare = CR.renderMessage(MSG({ kind: 'tool_call', text: '' }));
  ok('a tool_call with no tool object still renders a card', byClass(bare, 'hd-cv-card').length === 1, html(bare));
  eq('with no invented name badge', byClass(bare, 'hd-cv-name').length, 0);
  eq('and the honest fallback summary', textOfClass(bare, 'hd-cv-sum'), 'tool call');
  ok('saying it carried nothing rather than showing an empty body',
    /no input and no result/.test(bare.textContent), bare.textContent);

  const hermes = CR.renderMessage(CALL({ name: 'read_file', input: '{"file_path":"a/b.js"}' }));
  eq('a JSON-string input (hermes) is parsed for the summary', textOfClass(hermes, 'hd-cv-sum'), 'a/b.js');
  eq('and pretty-printed for the body', one(hermes, 'hd-cv-json').textContent, '{\n  "file_path": "a/b.js"\n}');
}

// ── pairing / unpaired results ──────────────────────────────────────────────

section('§8.3 — a paired result is not drawn twice; an unpaired one is always visible');
{
  const call = CALL({ result: 'the output' }, { key: 'c1' });
  const res = RESULT({ result: 'the output' }, { key: 'r1' });
  const both = listRoot([call, res]);
  eq('renderList returns a DocumentFragment', both.frag.nodeType, 11);
  eq('the paired result is not a second card', byClass(both.box, 'hd-cv-card').length, 1);
  eq('and nothing claims to be unpaired', byClass(both.box, 'hd-cv-warn').length, 0);
  eq('the result text is inside the call (once)', both.box.textContent.split('the output').length - 1, 1);
  eq('the drawn message keys are the ones that needed drawing', allEls(both.box).filter((n) => n.getAttribute('data-key')).map((n) => n.getAttribute('data-key')), ['c1']);

  const lone = listRoot([RESULT({ result: 'orphan' }, { key: 'r9' })]).box;
  eq('an unpaired result is rendered, not hidden', byClass(lone, 'hd-cv-card').length, 1);
  eq('marked "unpaired result"', textOfClass(lone, 'hd-cv-note'), 'unpaired result');
  eq('with the result text', one(lone, 'hd-cv-res').textContent, 'orphan');

  eq('a result whose call_key is not in the list is unpaired',
    byClass(listRoot([RESULT({ result: 'x' }, { key: 'r' }), CALL({}, { key: 'c', tool: TOOL({ call_key: 'other' }) })]).box, 'hd-cv-note').length, 1);
  eq('a result with no call_key at all is unpaired',
    textOfClass(listRoot([RESULT({ result: 'x', call_key: '' }, { key: 'r' })]).box, 'hd-cv-note'), 'unpaired result');
  eq('a result that arrives BEFORE its call is still paired (order cannot matter)',
    byClass(listRoot([res, call]).box, 'hd-cv-card').length, 1);
  eq('two results paired to two calls are both folded in',
    byClass(listRoot([
      CALL({ result: 'a' }, { key: 'c1' }), RESULT({ result: 'a' }, { key: 'r1' }),
      CALL({ result: 'b' }, { key: 'c2', tool: TOOL({ call_key: 'c2' }) }), RESULT({ result: 'b' }, { key: 'r2', tool: TOOL({ call_key: 'c2' }) }),
    ]).box, 'hd-cv-card').length, 2);
  eq('messages keep their order in the list',
    allEls(listRoot([MSG({ key: 'a' }), MSG({ key: 'b' }), MSG({ key: 'c' })]).box)
      .filter((n) => n.getAttribute('data-key')).map((n) => n.getAttribute('data-key')), ['a', 'b', 'c']);
  eq('an empty list is an empty fragment, not a throw', listRoot([]).box.children.length, 0);
  eq('a non-array is an empty fragment too', listRoot(null).box.children.length, 0);
  ok('a null message still renders a visible note', /nothing to render/.test(CR.renderMessage(null).textContent),
    CR.renderMessage(null).textContent);
  ok('a string message does not throw', /nothing to render/.test(CR.renderMessage('nope').textContent),
    CR.renderMessage('nope').textContent);
  ok('an empty object does not throw and is not blank',
    CR.renderMessage({}).textContent.length > 0, CR.renderMessage({}).textContent);
}

// ── long text ───────────────────────────────────────────────────────────────

section('§8.3 — long text collapses behind "show all · N lines"');
{
  const text = lines(25);
  const m = CR.renderMessage(MSG({ text }));
  const preview = textOfClass(m, 'hd-cv-p');
  eq('a 25-line message shows the first 20 lines', preview.split('\n'), lines(20).split('\n'));
  eq('and names the true total', textOfClass(m, 'hd-cv-more'), 'show all · 25 lines');
  ok('the hidden lines are not in the DOM at all (nothing is only hidden by CSS)',
    m.textContent.indexOf('L21') < 0, 'L21 leaked into the collapsed bubble');
  ok('the control says how many lines are hidden', one(m, 'hd-cv-more').getAttribute('data-lines') === '25',
    one(m, 'hd-cv-more').getAttribute('data-lines'));
  // A3.1/A3.3: "opened" is the reader's state, in opts.openKeys under A3.2's id for this record's
  // text — the renderer neither toggles anything itself nor keeps the answer anywhere.
  eq('the control names the id A3.2 gives this record\'s text', one(m, 'hd-cv-more').getAttribute('data-hd-open'), 'k1#text');
  const shown = CR.renderMessage(MSG({ text }), { openKeys: { 'k1#text': true } });
  eq('openKeys shows all of it', textOfClass(shown, 'hd-cv-p').split('\n').length, 25);
  eq('and the control flips', textOfClass(shown, 'hd-cv-more'), 'show less · 25 lines');
  eq('and the body carries the open marker', one(shown, 'hd-cv-body').className, 'hd-cv-body hd-cv-open');
  eq('while the default stays the capped view', textOfClass(m, 'hd-cv-p').split('\n').length, 20);
  eq('and a click on the control still changes nothing (no listener in the renderer)',
    (() => { one(m, 'hd-cv-more').click(); return textOfClass(m, 'hd-cv-p').split('\n').length; })(), 20);

  eq('exactly 20 lines needs no control (the boundary is >, not >=)',
    byClass(CR.renderMessage(MSG({ text: lines(20) })), 'hd-cv-more').length, 0);
  eq('21 lines needs one', byClass(CR.renderMessage(MSG({ text: lines(21) })), 'hd-cv-more').length, 1);
  const three = CR.renderMessage(MSG({ text }), { maxTextLines: 3 });
  eq('opts.maxTextLines=3 changes the threshold', textOfClass(three, 'hd-cv-p').split('\n'), lines(3).split('\n'));
  eq('while the total stays the message\'s own', textOfClass(three, 'hd-cv-more'), 'show all · 25 lines');
  eq('junk maxTextLines falls back to the default, never to 0 lines',
    [textOfClass(CR.renderMessage(MSG({ text }), { maxTextLines: 0 }), 'hd-cv-more'),
     textOfClass(CR.renderMessage(MSG({ text }), { maxTextLines: 'x' }), 'hd-cv-more')],
    ['show all · 25 lines', 'show all · 25 lines']);

  const longRes = CR.renderMessage(CALL({ result: lines(40, 'R') }));
  ok('a long tool result collapses the same way',
    /show all · 40 lines/.test(longRes.textContent), longRes.textContent);
  const resBox = one(longRes, 'hd-cv-res');
  eq('showing the first 20 lines of the result', resBox.textContent.split('\n').length, 20);
  eq('the result block names its own id inside the card, so it cannot collide with the card or its input',
    one(longRes, 'hd-cv-more').getAttribute('data-hd-open'), 'k1#toolc1#res');
  const longIn = CR.renderMessage(CALL({ input: lines(30, 'I') }));
  eq('and the input block has its own id too (the card holds two long blocks, not one)',
    one(longIn, 'hd-cv-more').getAttribute('data-hd-open'), 'k1#toolc1#in');
  eq('which is a different control from the result clamp in the same card',
    one(longIn, 'hd-cv-more').getAttribute('data-hd-open') !==
      one(longRes, 'hd-cv-more').getAttribute('data-hd-open'), true);
  const longResOpen = CR.renderMessage(CALL({ result: lines(40, 'R') }), { openKeys: { 'k1#toolc1#res': true } });
  eq('and the control expands it in place', one(longResOpen, 'hd-cv-res').textContent.split('\n').length, 40);
  eq('while the card body around it stays as the option left it', hiddenOf(one(longResOpen, 'hd-cv-card-body')), true);
}

// ── A2: folding a bubble ────────────────────────────────────────────────────

section('A2 — the prompt and the reply both fold; the fold is always the reader\'s action');
{
  const Z240 = 'Z'.repeat(240);
  const FOUR = [Z240, 'line two', 'line three', 'line four'].join('\n');
  const SHORT = 'a short first line\nand a second line';
  const PAD = T.SUMMARY_MAX;                            // the frozen clip: 160
  const charsOf = (s) => Array.from(s).length;          // counted the way a reader counts
  const btnOf = (root) => one(root, 'hd-cv-foldbtn');
  const previewOf = (root) => textOfClass(root, 'hd-cv-p');
  const statOf = (root) => textOfClass(root, 'hd-cv-foldstat');
  const isRow = (n) => (n.className || '').split(/\s+/).indexOf('hd-cv-row') >= 0;
  /** the row the message with this key was drawn as (a never-null stand-in when it is not there) */
  const rowFor = (root, key) => {
    const hit = byClass(root, 'hd-cv-msg').filter((n) => n.getAttribute('data-key') === key);
    return hit.length === 1 ? one(hit[0], 'hd-cv-row') : one(null, 'hd-cv-row');
  };
  const rowIsFolded = (root, key) => {
    const r = rowFor(root, key);
    return isRow(r) && r.className.indexOf('hd-cv-folded') >= 0;
  };

  // ── A2.1: expanded by default. A fold is never something the view decided.
  const user = MSG({ key: 'f-user', role: 'user', kind: 'text', text: FOUR });
  const reply = MSG({ key: 'f-reply', role: 'assistant', kind: 'text', text: FOUR });
  const plain = CR.renderMessage(user);
  eq('a text bubble is expanded unless the reader folded it (no folded row anywhere)',
    byClass(plain, 'hd-cv-folded').length, 0);
  eq('and the whole message is drawn, all four lines of it',
    textOfClass(plain, 'hd-cv-p').split('\n').length, 4);
  eq('nothing states a hidden count, because nothing is hidden', byClass(plain, 'hd-cv-foldstat').length, 0);
  eq('the control is there to fold WITH, and it reports the message as currently open',
    [btnOf(plain).getAttribute('data-hd-fold'), btnOf(plain).getAttribute('aria-expanded')],
    ['f-user', 'true']);
  eq('and the head is marked as the other half of the target (A2.4)',
    one(plain, 'hd-cv-meta').getAttribute('data-hd-foldhead'), 'f-user');

  // ── (a) a folded user bubble and a folded assistant bubble, symmetrically (A2.2)
  for (const [what, msg, key] of [
    ['the user\'s own prompt', user, 'f-user'],
    ['the agent\'s reply', reply, 'f-reply'],
  ]) {
    const f = CR.renderMessage(msg, { foldedKeys: { [key]: true } });
    const row = rowFor(f, key);
    ok(`${what}: the ROW carries hd-cv-folded (A2.4)`,
      isRow(row) && row.className.indexOf('hd-cv-folded') >= 0, `row classes: "${row.className}"`);
    eq(`${what}: the toggle names the message it folds`, btnOf(f).getAttribute('data-hd-fold'), key);
    eq(`${what}: and states the folded state, not just the styling`, btnOf(f).getAttribute('aria-expanded'), 'false');
    eq(`${what}: the head carries the key too, so the whole head toggles`,
      one(f, 'hd-cv-meta').getAttribute('data-hd-foldhead'), key);
    eq(`${what}: the preview is the message's first line, clipped at the cap`,
      previewOf(f), Z240.slice(0, PAD - 1) + '…');
    ok(`${what}: and the rest of the message is not in the DOM at all — not as text, not in an attribute`,
      f.textContent.indexOf('line two') < 0 && f.textContent.indexOf('line three') < 0
        && f.textContent.indexOf('line four') < 0 && html(f).indexOf('line two') < 0
        && html(f).indexOf('line four') < 0,
      `text: ${f.textContent.indexOf('line two')} · markup: ${html(f).indexOf('line two')}`);
    eq(`${what}: the counts say exactly how much is not on screen`,
      statOf(f), (charsOf(FOUR) - (PAD - 1)) + ' chars · 3 lines hidden');
    ok(`${what}: the bubble itself is still the same bubble (same frame, not re-created)`,
      byClass(f, 'hd-cv-bubble').length === 1 && byClass(f, 'hd-cv-row').length === 1,
      `${byClass(f, 'hd-cv-bubble').length} bubble(s) / ${byClass(f, 'hd-cv-row').length} row(s)`);
  }

  // ── (b) the preview is verbatim, and the two counts are the message's own
  const shortFolded = CR.renderMessage(MSG({ key: 'f-short', role: 'user', text: SHORT }),
    { foldedKeys: { 'f-short': true } });
  eq('a first line shorter than the cap is shown in full, not padded and not cut',
    previewOf(shortFolded), 'a short first line');
  eq('and its counts are still the message\'s own, in the same units',
    statOf(shortFolded), (charsOf(SHORT) - charsOf('a short first line')) + ' chars · 1 lines hidden');
  eq('folding a one-line message hides nothing, and says exactly that',
    statOf(CR.renderMessage(MSG({ key: 'f-one', text: 'just the one line' }), { foldedKeys: { 'f-one': true } })),
    '0 chars · 0 lines hidden');
  eq('the clip is exactly SUMMARY_MAX characters long',
    charsOf(previewOf(CR.renderMessage(user, { foldedKeys: { 'f-user': true } }))), PAD);
  const blankFirst = '\n\n  \nthe real first line\nmore';
  const blankFolded = CR.renderMessage(MSG({ key: 'f-blank', text: blankFirst }), { foldedKeys: { 'f-blank': true } });
  eq('the preview skips leading blank lines instead of drawing an empty bubble',
    previewOf(blankFolded), 'the real first line');
  eq('and the counts still describe the whole message',
    statOf(blankFolded), (charsOf(blankFirst) - charsOf('the real first line')) + ' chars · 4 lines hidden');
  // counted in code points: a UTF-16 slice would cut a character in half and show a replacement char
  const emojiText = '😀'.repeat(200) + '\nafter';
  const emojiFolded = CR.renderMessage(MSG({ key: 'f-emoji', text: emojiText }), { foldedKeys: { 'f-emoji': true } });
  const emojiPreview = previewOf(emojiFolded);
  ok('an astral first line is clipped between characters, never through one',
    charsOf(emojiPreview) === PAD && emojiPreview.indexOf('�') < 0
      && /^😀+…$/u.test(emojiPreview) && charsOf(emojiPreview.slice(0, -1)) === PAD - 1,
    `${charsOf(emojiPreview)} chars, ends ${JSON.stringify(Array.from(emojiPreview).slice(-2))}`);
  eq('and the counts are the message\'s own, in the same units',
    statOf(emojiFolded), (charsOf(emojiText) - (PAD - 1)) + ' chars · 1 lines hidden');

  // ── (c) folded vs the §8.3 length cap: two levels, and the cap is only overridden (A2.7)
  const many = lines(25);
  const manyMsg = MSG({ key: 'f-long', kind: 'text', text: many });
  const manyFolded = CR.renderMessage(manyMsg, { foldedKeys: { 'f-long': true } });
  eq('while folded there is no "show all · N lines" control', byClass(manyFolded, 'hd-cv-more').length, 0);
  eq('and no expanded-body marker either', byClass(manyFolded, 'hd-cv-open').length, 0);
  eq('the preview is the first line only', previewOf(manyFolded), 'L1');
  // A2 errata rules 1+3: the count is on the body the reader was looking at (the §8.3 cap's 20
  // lines), never the raw 25, and the lines the cap still holds are named instead of dropped.
  eq('with the count of what the fold actually hid, on the capped body the reader was looking at',
    statOf(manyFolded),
    (charsOf(lines(20)) - charsOf('L1')) + ' chars · 19 lines hidden · 5 more lines behind show all');
  const manyOpen = CR.renderMessage(manyMsg, { foldedKeys: { 'f-long': false } });
  eq('unfolding restores exactly what the cap said before: "show all · 25 lines"',
    textOfClass(manyOpen, 'hd-cv-more'), 'show all · 25 lines');
  eq('and the cap draws its own first 20 lines again',
    textOfClass(manyOpen, 'hd-cv-p').split('\n').length, 20);
  eq('the folded form and the capped form are the only two shapes — nothing half-folded',
    byClass(manyFolded, 'hd-cv-more').length + byClass(manyFolded, 'hd-cv-open').length
      + byClass(manyOpen, 'hd-cv-more').length, 1);
  eq('the renderer attaches no click handling of its own: clicking the button changes nothing until ' +
    'W2 (which owns the map) handles it (A2.4)',
    (() => { btnOf(manyFolded).click(); return [byClass(manyFolded, 'hd-cv-folded').length,
      byClass(manyFolded, 'hd-cv-more').length, btnOf(manyFolded).getAttribute('aria-expanded')]; })(),
    [1, 0, 'false']);

  // ── (d) a fold never hides a disclosure (A2.6)
  const truncFolded = CR.renderMessage(
    MSG({ key: 'f-trunc', role: 'user', text: FOUR, text_truncated: true }), { foldedKeys: { 'f-trunc': true } });
  const truncNotes = byClass(truncFolded, 'hd-cv-note').filter((n) => /truncated by the server/.test(n.textContent));
  eq('the server\'s truncation note is still drawn while the bubble is folded', truncNotes.length, 1);
  ok('it is outside the folded body (a sibling of the preview, not inside the fold)',
    truncNotes.length === 1 && String((truncNotes[0].parentNode || {}).className).indexOf('hd-cv-bubble') >= 0,
    truncNotes.length ? `parent: "${(truncNotes[0].parentNode || {}).className}"` : 'no note at all');
  ok('and no ancestor of it is hidden',
    truncNotes.length === 1 && (() => {
      for (let n = truncNotes[0]; n; n = n.parentNode) if (n.hidden === true) return false;
      return true;
    })(), 'an ancestor is hidden');

  // ── (e) the folded path is the same untrusted-text path as every other
  const IMG = '<img src=x onerror=alert(1)>';
  const SCRIPT = '<script>alert(1)</script>';
  for (const [label, payload] of [['a <script>', SCRIPT], ['an <img onerror>', IMG]]) {
    const f = CR.renderMessage(MSG({ key: 'f-x', role: 'user', text: payload + '\nand more text' }),
      { foldedKeys: { 'f-x': true } });
    const scan = noInjectedMarkup(f);
    eq(`${label} in a folded preview is drawn as the literal text it is`, previewOf(f), payload);
    eq(`${label} in a folded preview produces no element and no attribute`,
      [scan.found, scan.badTags, scan.badAttrs], [[], [], []]);
    ok(`${label} in a folded preview reaches no title attribute either`,
      allEls(f).every((n) => typeof n.title !== 'string' || n.title.indexOf('alert') < 0),
      'the payload is parked in a title');
  }

  // ── (f) a reader who never folds sees what they saw before this round. Not "looks similar": the
  // same file with the A2 wiring neutralised has to produce byte-identical markup. What the fold adds
  // to an unfolded message is ONE control in the head — so the head is compared with that control
  // taken back out, and the bubble row (everything the reader came for) is compared as it stands.
  const PRE_A2 = loadVariant([
    ['    var foldKey = foldable ? foldedKey(o, msg) : null;\n', '    var foldKey = null;\n'],
    ['    if (foldable) markFoldHead(meta, key, foldKey);\n', ''],
  ]);
  const textShapes = [
    ['a short user prompt', MSG({ key: 'g1', role: 'user', kind: 'text', text: 'hello there' })],
    ['an assistant reply with markdown', MSG({ key: 'g2', kind: 'text', text: 'a **bold** answer with `code`\nand a second line' })],
    ['a 25-line message (the cap path)', MSG({ key: 'g3', kind: 'text', text: lines(25) })],
    ['a server-truncated message', MSG({ key: 'g4', role: 'user', text: 'short', text_truncated: true })],
  ];
  for (const [what, msg] of textShapes) {
    const nowRow = one(CR.renderMessage(msg), 'hd-cv-row');
    const beforeRow = one(PRE_A2.renderMessage(msg), 'hd-cv-row');
    ok(`the bubble row of unfolded ${what} is byte-identical to the pre-A2 renderer`,
      html(nowRow).length > 40 && html(nowRow) === html(beforeRow),
      `now: ${html(nowRow).slice(0, 130)} · before: ${html(beforeRow).slice(0, 130)}`);
    const nowHead = byClass(CR.renderMessage(msg), 'hd-cv-meta')[0];
    const beforeHead = byClass(PRE_A2.renderMessage(msg), 'hd-cv-meta')[0];
    const buttons = nowHead ? byClass(nowHead, 'hd-cv-foldbtn') : [];
    if (buttons.length === 1) {                        // strip the control out again, in place
      nowHead.children = nowHead.children.filter((c) => c !== buttons[0]);
      delete nowHead.attrs['data-hd-foldhead'];
    }
    ok(`and the head of unfolded ${what} is the pre-A2 head plus that one control, nothing else`,
      buttons.length === 1 && !!beforeHead && html(nowHead) === html(beforeHead),
      buttons.length !== 1 ? 'no control was rendered — the comparison would be vacuous'
        : `stripped: ${html(nowHead).slice(0, 130)} · before: ${html(beforeHead).slice(0, 130)}`);
  }
  const otherShapes = [
    ['a thinking record', MSG({ key: 'g6', kind: 'thinking', text: 'a thought' })],
    ['a tool card', CALL({ name: 'Bash', input: { command: 'npm test' }, result: 'ok' }, { key: 'g7' })],
    ['a system note', MSG({ key: 'g8', kind: 'system', text: 'a note' })],
    ['a record with no key at all', MSG({ key: null, kind: 'text', text: 'keyless' })],
    // deliberately unfoldable: with no text the fold could only hide the "(no text)" note it exists
    // to state, so the note always wins and the bubble is left as it was
    ['a text bubble with no text', MSG({ key: 'g5', kind: 'text', text: '' })],
  ];
  let identical = 0;
  for (const [what, msg] of otherShapes) {
    const now = html(CR.renderMessage(msg)), before = html(PRE_A2.renderMessage(msg));
    if (now === before) identical++;
    else ok(`unfolded ${what} renders byte-identically to the same file without the fold code`, false,
      `now: ${now.slice(0, 130)} · before: ${before.slice(0, 130)}`);
  }
  eq('a shape that does not fold is byte-identical to the pre-A2 renderer, whole message',
    identical, otherShapes.length);
  ok('the variant really is the pre-A2 renderer (no control, no head marker)',
    byClass(PRE_A2.renderMessage(textShapes[0][1]), 'hd-cv-foldbtn').length === 0
      && html(PRE_A2.renderMessage(textShapes[1][1])).indexOf('data-hd-fold') < 0, 'the variant folds too');
  ok('while the real renderer carries it, so that comparison is not two identical files',
    byClass(CR.renderMessage(textShapes[0][1]), 'hd-cv-foldbtn').length === 1
      && html(CR.renderMessage(textShapes[1][1])).indexOf('data-hd-foldhead="g2"') >= 0,
    'the real renderer has no control either');

  // the map is W2's state: read, never written, and a falsy or absent entry means expanded (A2.1)
  const map = { 'f-user': true, 'f-reply': false };
  const mapCopy = JSON.parse(JSON.stringify(map));
  const foldedByMap = CR.renderMessage(user, { foldedKeys: map });
  eq('reading the fold map does not change it', map, mapCopy);
  eq('and the truthy entry in it is the one that folded (the falsy one is not)',
    [byClass(foldedByMap, 'hd-cv-folded').length, rowIsFolded(foldedByMap, 'f-user')], [1, true]);
  const base = html(CR.renderMessage(user));
  eq('no map, an empty map, a map of other keys, a false entry and a null map all render as today',
    [html(CR.renderMessage(user, {})), html(CR.renderMessage(user, { foldedKeys: {} })),
     html(CR.renderMessage(user, { foldedKeys: { other: true } })),
     html(CR.renderMessage(user, { foldedKeys: { 'f-user': false } })),
     html(CR.renderMessage(user, { foldedKeys: null }))].map((h) => h === base),
    [true, true, true, true, true]);
  eq('junk in foldedKeys falls back to expanded instead of throwing',
    [42, 'x', true, [], { 'f-user': 'yes' }]
      .map((fk) => byClass(CR.renderMessage(user, { foldedKeys: fk }), 'hd-cv-folded').length),
    [0, 0, 0, 0, 1]);
  eq('a key that collides with Object.prototype is not folded by accident',
    ['constructor', 'toString', '__proto__']
      .map((k) => byClass(CR.renderMessage(MSG({ key: k, text: 'x' }), { foldedKeys: {} }), 'hd-cv-folded').length),
    [0, 0, 0]);
  eq('a message with no key cannot be folded (there would be nothing to key the decision by)',
    [byClass(CR.renderMessage(MSG({ key: null, text: 'x' }), { foldedKeys: { '': true, null: true } }), 'hd-cv-folded').length,
     byClass(CR.renderMessage(MSG({ key: null, text: 'x' }), { foldedKeys: { '': true } }), 'hd-cv-foldbtn').length],
    [0, 0]);

  // A2.2: only the two text bubbles fold. Everything else keeps the behaviour it had.
  const notFoldable = [
    ['a thinking record', MSG({ key: 'n1', kind: 'thinking', text: 'a thought' })],
    ['a tool card', CALL({}, { key: 'n2' })],
    ['a system note', MSG({ key: 'n3', kind: 'system', text: 'a note' })],
    ['an unknown kind', MSG({ key: 'n4', kind: 'ai-title', text: 'a title' })],
    ['a message with no text', MSG({ key: 'n5', kind: 'text', text: '' })],
    ['a text record with the tool role', MSG({ key: 'n6', role: 'tool', kind: 'text', text: 'result text' })],
  ];
  eq('nothing but a user or assistant text bubble gains a fold control',
    notFoldable.filter(([, m]) => byClass(CR.renderMessage(m), 'hd-cv-foldbtn').length > 0).map(([w]) => w), []);
  eq('and folding one of them anyway renders exactly what it always did (no half-folded shapes)',
    notFoldable.map(([, m], i) => {
      const node = CR.renderMessage(m, { foldedKeys: { ['n' + (i + 1)]: true } });
      return [byClass(node, 'hd-cv-folded').length, html(node) === html(CR.renderMessage(m))];
    }),
    notFoldable.map(() => [0, true]));

  // ── (g) renderTurn passes the map through to every segment (A2.4)
  const turnInput = TURN({
    user: MSG({ key: 't-user', role: 'user', kind: 'text', text: FOUR }),
    segments: [
      MSG({ key: 't-think', kind: 'thinking', text: 'a thought the reader can expand' }),
      MSG({ key: 't-interim', kind: 'text', text: 'an interim sentence' }),
      CALL({ name: 'Bash', input: { command: 'npm test' }, result: 'ok' }, { key: 't-call' }),
      MSG({ key: 't-reply', kind: 'text', text: 'the closing answer\nwith a second line' }),
    ],
  });
  const turnFolded = CR.renderTurn(turnInput,
    { foldedKeys: { 't-user': true, 't-think': true, 't-interim': true, 't-call': true, 't-reply': true } });
  eq('the turn drew the prompt and all four segments', msgKeys(turnFolded),
    ['t-user', 't-think', 't-interim', 't-call', 't-reply']);
  eq('the folded rows are exactly the text bubbles the map named — a map entry cannot fold a thinking ' +
    'record or a card (A2.2)', msgKeys(turnFolded).map((k) => [k, rowIsFolded(turnFolded, k)]),
    [['t-user', true], ['t-think', false], ['t-interim', true], ['t-call', false], ['t-reply', true]]);
  eq('the folded prompt shows its preview, not the prompt',
    textOfClass(byClass(turnFolded, 'hd-cv-msg').filter((n) => n.getAttribute('data-key') === 't-user')[0], 'hd-cv-p'),
    Z240.slice(0, PAD - 1) + '…');
  eq('the interim segment keeps its own not-final marking while folded (A1, unchanged)',
    byClass(turnFolded, 'hd-cv-interim').length, 1);
  eq('the reply is still marked as the reply while folded — the tag lives outside the bubble',
    [byClass(turnFolded, 'hd-cv-reply').length, byClass(turnFolded, 'hd-cv-replytag').length,
     textsOfClass(turnFolded, 'hd-cv-replytag')[0]], [1, 1, 'reply']);
  const turnPlain = CR.renderTurn(turnInput);
  eq('and with no map at all the same turn is drawn in full (A2.1)',
    [byClass(turnPlain, 'hd-cv-folded').length, byClass(turnPlain, 'hd-cv-replytag').length,
     textOfClass(turnPlain, 'hd-cv-p').split('\n').length, byClass(turnPlain, 'hd-cv-foldbtn').length],
    [0, 1, 4, 3]);                       // the prompt, the interim text and the reply: three controls
  ok('a folded list is drawn by renderList too (the panel\'s other entry point)',
    byClass(listRoot([user, reply], { foldedKeys: { 'f-user': true } }).box, 'hd-cv-folded').length === 1
      && rowIsFolded(listRoot([user, reply], { foldedKeys: { 'f-user': true } }).box, 'f-user'),
    'renderList did not pass the map through');
  ok('and the folded path threw nothing and wrote no innerHTML', INNER_HTML_WRITES.length === 0,
    INNER_HTML_WRITES.map((w) => w.tag).join(','));
}

// ── A2 errata: what the fold claims ─────────────────────────────────────────

section('A2 errata — the folded counter counts what the fold HIDES, on the body the reader saw');
{
  // The fixture the errata is about: a record whose RAW form and RENDERED form differ (markdown
  // emphasis AND inline code on the first line), longer than the §8.3 cap, with the text behind
  // `show all` being the LONG part — which is exactly what made the old counter overstate it.
  const RAW_FIRST = '**3 个真问题** and `code` too';
  const RENDERED_FIRST = '3 个真问题 and code too';
  const TAIL = Array.from({ length: 5 }, (_, i) => 'x'.repeat(200) + i).join('\n');
  const mdText = RAW_FIRST + '\n' + lines(19, 'M') + '\n' + TAIL;        // 25 lines: 5 behind the cap
  const md = MSG({ key: 'e1', kind: 'text', text: mdText });
  const folded = CR.renderMessage(md, { foldedKeys: { e1: true } });
  const stat = textOfClass(folded, 'hd-cv-foldstat');
  const preview = textOfClass(folded, 'hd-cv-p');
  // what the unfolded view actually draws: the first 20 lines, rendered — read out of the DOM, so
  // the expectation below cannot agree with a wrong renderer by sharing its arithmetic
  const renderedCapped = textOfClass(CR.renderMessage(md), 'hd-cv-p');
  const hiddenChars = T.charCount(renderedCapped) - T.charCount(RENDERED_FIRST);

  // ruling 2: the preview is the RENDERED first line — folding must not make markdown syntax reappear
  eq('the preview is exactly what the unfolded body renders for that line', preview, RENDERED_FIRST);
  ok('so no markdown syntax comes back when the message is folded',
    preview.indexOf('**') < 0 && preview.indexOf('`') < 0, preview);
  ok('and the raw line really did differ, so the check above is not vacuous',
    RAW_FIRST !== RENDERED_FIRST && T.charCount(RAW_FIRST) !== T.charCount(RENDERED_FIRST),
    `${T.charCount(RAW_FIRST)} raw vs ${T.charCount(RENDERED_FIRST)} rendered`);

  // ruling 1: the count is the rendered capped body minus the preview — the cap and the markdown
  // syntax are both excluded, because neither was on screen for the fold to take away
  eq('the counts name exactly the characters and lines the fold took off the screen (exact numbers)',
    stat, hiddenChars + ' chars · 19 lines hidden · 5 more lines behind show all');
  eq('and those numbers are the ones the fixture is built to produce, not whatever came out',
    [T.charCount(renderedCapped), T.charCount(RENDERED_FIRST), hiddenChars], [86, 19, 67]);
  const rawReading = T.charCount(mdText) - T.charCount(RAW_FIRST);       // the old, overstated number
  ok('the old reading (the whole raw record) would be a far bigger, dishonest number',
    rawReading > 3 * hiddenChars, `raw ${rawReading} vs honest ${hiddenChars}`);

  // ruling 3: the disclosure survives — the lines the cap still holds are named, and the server note
  const truncatedFolded = CR.renderMessage(MSG({ key: 'e2', text: mdText, text_truncated: true }),
    { foldedKeys: { e2: true } });
  ok('a folded, server-truncated, over-cap record still says both things',
    textOfClass(truncatedFolded, 'hd-cv-foldstat').indexOf('5 more lines behind show all') > 0
      && truncatedFolded.textContent.indexOf('text truncated by the server') > 0,
    textOfClass(truncatedFolded, 'hd-cv-foldstat'));
  eq('while a record inside the cap says nothing about `show all` (there is nothing behind it)',
    textOfClass(CR.renderMessage(MSG({ key: 'e3', text: 'one line\nand a second' }), { foldedKeys: { e3: true } }),
      'hd-cv-foldstat').indexOf('behind show all'), -1);

  // ruling 4: a single line hides nothing, and says exactly that
  eq('a single-line message still reads 0 chars · 0 lines hidden',
    textOfClass(CR.renderMessage(MSG({ key: 'e4', text: 'just one line' }), { foldedKeys: { e4: true } }),
      'hd-cv-foldstat'), '0 chars · 0 lines hidden');

  // ruling 2 again, on the injection path: a payload in the first line is rendered (literally), and
  // the preview shows it as the unfolded body does — not as source
  const hostile = CR.renderMessage(MSG({ key: 'e5', text: '<img src=x onerror=alert(1)> and **bold**\nmore' }),
    { foldedKeys: { e5: true } });
  const hostileScan = noInjectedMarkup(hostile);
  eq('a payload in a folded first line is literal text, exactly as the unfolded body draws it',
    [textOfClass(hostile, 'hd-cv-p'), hostileScan.found, hostileScan.badTags, hostileScan.badAttrs],
    ['<img src=x onerror=alert(1)> and bold', [], [], []]);
}

// ── A3: reader state survives re-rendering ──────────────────────────────────

section('A3 — every collapsible block reads its state from opts.openKeys (ids stay put)');
{
  const openIds = (root) => byClass(root, 'hd-cv-open').length;
  const idsIn = (root) => allEls(root).filter((n) => n.getAttribute('data-hd-open') !== null)
    .map((n) => n.getAttribute('data-hd-open'));

  // (a) the three controls: each opens from the map, and the DOM states it three ways
  const think = MSG({ key: 'a1', kind: 'thinking', text: 'a thought' });
  const call = CALL({ name: 'Bash', input: { command: 'npm test' }, result: lines(30, 'R') }, { key: 'a2' });
  const longText = MSG({ key: 'a3', kind: 'text', text: lines(30, 'L') });
  const all = listRoot([think, call, longText], {
    openKeys: { 'a1#think0': true, 'a2#toolc1': true, 'a2#toolc1#res': true, 'a3#text': true },
  }).box;
  const [thinkBody, cardBody, textBody] = [one(all, 'hd-cv-think-body'), one(all, 'hd-cv-card-body'),
    one(all, 'hd-cv-body')];
  const resBoxes = byClass(all, 'hd-cv-resbox');      // the card draws two: [0] the input, [1] the result
  const resBody = resBoxes[1];
  eq('the thinking body is open, marked open, and not hidden',
    [hiddenOf(thinkBody), one(all, 'hd-cv-think-head').getAttribute('aria-expanded'),
     thinkBody.className.indexOf('hd-cv-open') >= 0,
     html(thinkBody).indexOf(' hidden') < 0],
    [false, 'true', true, true]);
  eq('the card body is open, marked open, and not hidden',
    [hiddenOf(cardBody), one(all, 'hd-cv-toggle').getAttribute('aria-expanded'),
     cardBody.className.indexOf('hd-cv-open') >= 0, html(cardBody).indexOf(' hidden') < 0],
    [false, 'true', true, true]);
  eq('the long-text body is open and the control says `show less`',
    [textOfClass(all, 'hd-cv-more'), one(all, 'hd-cv-more').getAttribute('aria-expanded'),
     textBody.className.indexOf('hd-cv-open') >= 0],
    ['show less · 30 lines', 'true', true]);
  eq('the long result inside the card opens on its own id, without opening the card around it',
    [one(all, 'hd-cv-res').textContent.split('\n').length, resBody.className.indexOf('hd-cv-open') >= 0],
    [30, true]);
  ok('everything is drawn and nothing is hidden: an opened block really shows its content',
    thinkBody.textContent === 'a thought' && textBody.textContent.indexOf('L30') > 0
      && cardBody.textContent.indexOf('R30') > 0, cardBody.textContent.slice(0, 60));
  eq('and the default for a map that mentions none of them stays collapsed',
    openIds(listRoot([think, call, longText], {}).box), 0);

  // (b) the ids are A3.2's, they do not collide, and an append cannot renumber one
  const idShapes = listRoot([
    CALL({ call_key: 'c9' }, { key: 'i1' }),                       // a call that names itself
    CALL({ call_key: null, name: 'Bash' }, { key: 'i2' }),         // a call that cannot: the ordinal rule
    MSG({ key: 'i3', kind: 'thinking', text: 'a thought' }),
    MSG({ key: 'i4', kind: 'text', text: lines(25) }),
    MSG({ key: null, kind: 'thinking', text: 'no key at all' }),
    // keyless records share the '' base, so #think and #tool must not draw from ONE counter: the
    // thinking ordinal is the ordinal among thinking segments, the tool ordinal among tool cards.
    CALL({ call_key: null, name: 'Read', input: { file_path: 'a/b' } }, { key: null }),
  ], {}).box;
  eq('the ids are exactly A3.2\'s strings (call_key, then the ordinal rule, then #think/#text)',
    idsIn(idShapes),
    ['i1#toolc9', 'i2#tool0', 'i3#think0', 'i4#text', '#think0', '#tool0']);
  const three = MSG({ key: 'same', kind: 'thinking', text: 'the same row, in the log three times' });
  const box3 = doc.createElement('div'); box3.appendChild(CR.renderList([three, three, three], {}));
  eq('a record drawn three times in one pass gets three distinct ordinals, never a collision',
    idsIn(box3), ['same#think0', 'same#think1', 'same#think2']);
  const box4 = doc.createElement('div');
  box4.appendChild(CR.renderList([three, three, three, three], {}));
  eq('and appending a fourth does not renumber the first three (ordinals only ever grow)',
    idsIn(box4), ['same#think0', 'same#think1', 'same#think2', 'same#think3']);
  const turnIds = idsIn(CR.renderTurn(TURN({ segments: SEGMENTS() }), {}));
  ok('every id in a drawn turn is unique, and the check is not vacuous',
    turnIds.length >= 3 && new Set(turnIds).size === turnIds.length, JSON.stringify(turnIds));

  // (c) the option is only a default: the reader's closed wins over expandTools
  const optOpen = CR.renderMessage(call, { expandTools: true });
  eq('expandTools:true still starts a card expanded when the reader has said nothing',
    [hiddenOf(one(optOpen, 'hd-cv-card-body')), textOfClass(optOpen, 'hd-cv-toggle')], [false, 'collapse']);
  const readerClosed = CR.renderMessage(call, { expandTools: true, openKeys: { 'a2#toolc1': false } });
  eq('a FALSY openKeys entry means the reader closed what the option had opened',
    [hiddenOf(one(readerClosed, 'hd-cv-card-body')), textOfClass(readerClosed, 'hd-cv-toggle'),
     one(readerClosed, 'hd-cv-card-body').className.indexOf('hd-cv-open')],
    [true, 'expand', -1]);
  eq('and junk in openKeys never opens anything',
    [42, 'x', true, [], null].map((ok) => openIds(CR.renderMessage(call, { openKeys: ok }))), [0, 0, 0, 0, 0]);
  eq('a key that collides with Object.prototype does not open a block by accident',
    ['constructor', 'toString', '__proto__']
      .map((k) => openIds(CR.renderMessage(MSG({ key: k, kind: 'thinking', text: 'x' }), { openKeys: {} }))),
    [0, 0, 0]);

  // (d) THE PROPERTY THE DEFECT VIOLATED: two renders of the same record are the same render
  const opts = { openKeys: { 'a1#think0': true, 'a2#toolc1': true, 'a3#text': true } };
  const first = CR.renderMessage(think, opts), second = CR.renderMessage(think, opts);
  const msg = MSG({ key: 'd1', kind: 'thinking', text: 'kept open across a re-render' });
  const stateOf = (n) => [hiddenOf(one(n, 'hd-cv-think-body')), one(n, 'hd-cv-think-head').getAttribute('aria-expanded')];
  eq('re-rendering the same record with the same map gives the same expanded state',
    stateOf(CR.renderMessage(msg, { openKeys: { 'd1#think0': true } })),
    stateOf(CR.renderMessage(msg, { openKeys: { 'd1#think0': true } })));
  eq('and the two renders are byte-identical, so nothing about a redraw is bespoke',
    html(CR.renderMessage(msg, { openKeys: { 'd1#think0': true } })),
    html(CR.renderMessage(msg, { openKeys: { 'd1#think0': true } })));
  ok('the open state comes from the map and not from the previous node (the two are not the same object)',
    first !== second && openIds(first) === openIds(second) && openIds(first) > 0, `${openIds(first)}`);
  ok('the map is read, never written', JSON.stringify(opts.openKeys) ===
    JSON.stringify({ 'a1#think0': true, 'a2#toolc1': true, 'a3#text': true }), JSON.stringify(opts.openKeys));

  // (e) renderTurn / renderList pass the map to every segment, exactly like foldedKeys
  const turn = TURN({
    user: MSG({ key: 'tu', role: 'user', kind: 'text', text: 'please fix it' }),
    segments: [MSG({ key: 'ts1', kind: 'thinking', text: 'first thought' }),
      CALL({ name: 'Read', call_key: 'c7', input: { file_path: 'a.js' }, result: lines(25, 'R') }, { key: 'ts2' }),
      MSG({ key: 'ts3', kind: 'text', text: lines(25, 'T') })],
  });
  const turnOpen = CR.renderTurn(turn, { openKeys: { 'ts1#think0': true, 'ts2#toolc7': true, 'ts3#text': true } });
  eq('a turn opens the thinking segment, the card and the long text from one map',
    [openIds(turnOpen), hiddenOf(one(turnOpen, 'hd-cv-think-body')), hiddenOf(one(turnOpen, 'hd-cv-card-body'))],
    [3, false, false]);
  // the card's own long result is NOT in the map, so the segment's control is open and the card's
  // one is not: the ids are independent down to the block inside the card
  eq('and each control inside the turn reports its own state, not its neighbour\'s',
    textsOfClass(turnOpen, 'hd-cv-more'), ['show all · 25 lines', 'show less · 25 lines']);
  eq('and renderList passes it through too',
    openIds(listRoot([think, call, longText], { openKeys: { 'a1#think0': true, 'a3#text': true } }).box), 2);
  ok('a turn opened from the map is byte-identical on a redraw (the streaming case that was broken)',
    html(CR.renderTurn(turn, { openKeys: { 'ts1#think0': true } })) ===
      html(CR.renderTurn(turn, { openKeys: { 'ts1#think0': true } })));

  // (e2) injection: a payload in a thinking body or a card summary stays literal text
  const payload = '<script>alert(1)</script>';
  const injected = CR.renderTurn(TURN({
    segments: [MSG({ key: 'p1', kind: 'thinking', text: payload + ' and more' }),
      CALL({ name: '<img src=x onerror=alert(1)>', input: { command: payload }, result: payload }, { key: 'p2' })],
  }), { openKeys: { 'p1#think0': true, 'p2#toolc1': true, 'p2#toolc1#res': true } });
  const scan = noInjectedMarkup(injected);
  eq('a payload in an opened thinking body / card summary / result is literal text',
    [scan.found, scan.badTags, scan.badAttrs], [[], [], []]);
  // drawn four times over, all of them literal: the thinking body, the card's summary line, its
  // input JSON and its result — every one of them a place a payload would have to execute
  eq('and it is present verbatim, not escaped away or dropped',
    [injected.textContent.split(payload).length - 1, injected.textContent.indexOf(payload + ' and more') >= 0,
     tags(injected).every((t) => ALLOWED_TAGS.indexOf(t) >= 0)],
    [4, true, true]);

  // no local state: the controls carry no listener, so a click cannot change the drawn state
  const clickable = listRoot([think, call, longText], { openKeys: { 'a1#think0': true } }).box;
  const beforeClick = html(clickable);
  for (const b of byClass(clickable, 'hd-cv-think-head').concat(byClass(clickable, 'hd-cv-toggle'))
    .concat(byClass(clickable, 'hd-cv-more'))) b.click();
  eq('clicking every control in a rendered list changes nothing at all (W2 owns the clicks, A3.3)',
    html(clickable), beforeClick);
  // comments are stripped first: this is a statement about the CODE, and the A3 header above quotes
  // the old lines on purpose (they are what the measurement caught).
  const RENDER_CODE = RENDER_SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  ok('and no source line in this file toggles a body from a closure variable any more (A3.1)',
    !/var expanded\s*=/.test(RENDER_CODE) && !/body\.hidden\s*=\s*!o\.expandTools/.test(RENDER_CODE)
      && !/body\.hidden\s*=\s*!body\.hidden/.test(RENDER_CODE) && !/<details/.test(RENDER_CODE),
    'the round-7.5 defect\'s root cause is still in the code');
  eq('and the renderer registers no click listener at all',
    (RENDER_CODE.match(/addEventListener/g) || []).length, 0);
  ok('while the header still names the defect it fixes, so a reader knows why nothing listens here',
    /var expanded = false/.test(RENDER_SRC) && /opts\.openKeys/.test(RENDER_SRC), 'the A3 note is gone');
}

// ── summaryFor ──────────────────────────────────────────────────────────────

section('§8.3 — summaryFor(tool): one honest line, from the log\'s own values');
{
  const cases = [
    [{ name: 'Bash', input: { command: 'ls -la' } }, '$ ls -la'],
    [{ name: 'Read', input: { file_path: 'src/x.js' } }, 'src/x.js'],
    [{ name: 'Edit', input: { file_path: 'a/b.ts', old_string: 'x' } }, 'a/b.ts'],
    [{ name: 'Grep', input: { pattern: 'needle', path: 'src' } }, 'needle'],
    [{ name: 'Glob', input: { pattern: '**/*.mjs' } }, '**/*.mjs'],
    [{ name: 'WebFetch', input: { url: 'https://x/y' } }, 'https://x/y'],
    [{ name: 'WebSearch', input: { query: 'how to' } }, 'how to'],
    [{ name: 'Task', input: { description: 'do a thing' } }, 'do a thing'],
    [{ name: 'TodoWrite', input: { todos: [{}, {}] } }, '2 items'],
    [{ name: 'read_file', input: '{"file_path":"a/b.js"}' }, 'a/b.js'],
    [{ name: 'Bash', input: { command: 'line one\nline two' } }, '$ line one line two'],
    [{ name: 'mystery', input: { zeta: 'last key wins when nothing else matches' } }, 'last key wins when nothing else matches'],
    [{ name: 'mystery', input: { a: 1, b: true } }, '1'],
    [{ name: 'mystery', input: { obj: { deep: 1 } } }, '{"deep":1}'],
  ];
  for (const [tool, want] of cases) {
    eq(`summaryFor(${tool.name}) is the value the log held: ${want}`, CR.summaryFor(tool), want);
  }
  eq('no tool at all is still a string', CR.summaryFor(null), 'tool call');
  eq('a tool with no input shows its name', CR.summaryFor({ name: 'Bash' }), 'Bash');
  eq('an empty-name tool is a generic card', CR.summaryFor({}), 'tool call');
  eq('a long command is clipped to one line', CR.summaryFor({ name: 'Bash', input: { command: 'x'.repeat(500) } }).length, 160);
  ok('and the clip is marked with an ellipsis',
    /…$/.test(CR.summaryFor({ name: 'Bash', input: { command: 'x'.repeat(500) } })), 'no ellipsis');
  ok('never multi-line, whatever the input',
    ['a\nb', 'a\r\nb', '  a  \n\n b '].every((s) => CR.summaryFor({ name: 'Bash', input: { command: s } }).indexOf('\n') < 0),
    'a newline survived into the summary');
  const circular = { name: 'Bash' }; circular.input = { command: circular };
  ok('a circular input does not throw', typeof CR.summaryFor(circular) === 'string', 'threw or returned a non-string');
  for (const junk of [null, undefined, 42, 'str', [], [1, 2], { name: 7 }, { input: undefined }, true]) {
    const got = CR.summaryFor(junk);
    ok(`summaryFor(${JSON.stringify(junk)}) is a non-empty string`, typeof got === 'string' && got.length > 0, String(got));
  }
}

// ── malformed input / never throws ──────────────────────────────────────────

section('§3 discipline — the renderer never throws and never returns a blank');
{
  const junk = [null, undefined, 0, '', 'text', [], [1], 42, true, {}, { kind: null }, { kind: 'text' },
    { kind: 'text', text: null }, { kind: 'text', text: 42 }, { kind: 'tool_call' }, { kind: 'tool_result' },
    { role: 'user', kind: 'thinking', text: '' }, { kind: 'text', text: '', sidechain: true },
    { kind: 'tool_call', tool: { name: '', input: null, result: null } }];
  let threw = null, blank = null;
  for (const m of junk) {
    let node;
    try { node = CR.renderMessage(m); } catch (e) { threw = { m, e: String(e) }; break; }
    if (!node || typeof node.textContent !== 'string') { blank = { m, why: 'not a node' }; break; }
    if (node.textContent === '') { blank = { m, why: 'rendered an empty element' }; break; }
  }
  ok('no malformed message throws', threw === null, JSON.stringify(threw));
  ok('and none of them renders as a blank', blank === null, JSON.stringify(blank));

  const sc = CR.renderMessage(MSG({ sidechain: true, text: 'subagent work' }));
  eq('sidechain:true marks the message', byClass(sc, 'hd-cv-sidechain').length, 1);
  eq('with a visible badge', textOfClass(sc, 'hd-cv-side'), 'sidechain (subagent)');
  eq('and the message is still its own bubble', textOfClass(sc, 'hd-cv-bubble'), 'subagent work');
  eq('a non-sidechain message has no such badge', byClass(CR.renderMessage(MSG({})), 'hd-cv-side').length, 0);

  const pend = CR.renderMessage(MSG({ role: 'user', text: 'sent it', pending: true, pending_note: 'not found in this agent\'s log — sent to the terminal; press t for the raw view' }));
  eq('a pending send is marked as pending', byClass(pend, 'hd-cv-pendingmsg').length, 1);
  ok('and keeps W2\'s sentence verbatim',
    /not found in this agent's log — sent to the terminal; press t for the raw view/.test(pend.textContent), pend.textContent);

  eq('a malformed role cannot write into the class attribute',
    CR.renderMessage(MSG({ role: 'assistant" onmouseover="x', text: 'hi' })).getAttribute('data-role'), 'assistant');
  const hostileKind = CR.renderMessage(MSG({ kind: 'x onmouseover=y', text: 'hi' }));
  eq('nor can a malformed kind', hostileKind.getAttribute('data-kind'), 'unknown');
  ok('and the class list stays a class list', /^[a-z0-9_ -]*$/.test(hostileKind.className), hostileKind.className);
}

// ── A1: a turn as one group ─────────────────────────────────────────────────

section('A1 — renderTurn: the prompt is the head, the segments follow in log order, the reply closes');
{
  ok('renderTurn(turn, opts) -> Element', typeof CR.renderTurn === 'function', typeof CR.renderTurn);
  const turn = CR.renderTurn(TURN({ segments: SEGMENTS() }));
  eq('a turn is ONE group element', byClass(turn, 'hd-cv-turn').length, 1);
  const head = turn.children[0];
  eq('whose head is the user bubble', [head.getAttribute('data-key'), byClass(head, 'hd-cv-role-user').length], ['u1', 1]);
  eq('and the prompt is rendered as a proper right-hand bubble', byClass(head, 'hd-cv-mine').length, 1);
  eq('the segments live in the group body', byClass(turn, 'hd-cv-turn-body').length, 1);
  const body = one(turn, 'hd-cv-turn-body');

  eq('the segments keep the log order (kind by kind)', segKinds(body),
    ['thinking', 'tool_call', 'text', 'tool_call', 'text']);
  eq('and the log order of keys is untouched', msgKeys(body), ['s1', 's2', 's3', 's4', 's5']);
  ok('each segment stays individually distinguishable, not merged into one wall of text',
    byClass(body, 'hd-cv-think').length === 1 && byClass(body, 'hd-cv-card').length === 2 &&
    byClass(body, 'hd-cv-bubble').length === 2,
    JSON.stringify({ think: byClass(body, 'hd-cv-think').length, card: byClass(body, 'hd-cv-card').length, bubble: byClass(body, 'hd-cv-bubble').length }));
  eq('each tool result shows inside its own card, once',
    [body.textContent.split('file contents').length - 1, body.textContent.split('more contents').length - 1], [1, 1]);

  const replies = byClass(body, 'hd-cv-reply');
  eq('exactly one segment is the closing reply', replies.length, 1);
  // `one()`'s stand-in instead of `replies[0]`: indexing an empty list would throw here and take the
  // rest of the run (every assertion after it) down with the first real failure.
  const theReply = one(body, 'hd-cv-reply');
  eq('and it is the LAST assistant text', theReply.getAttribute('data-key'), 's5');
  eq('the reply carries the answer', one(theReply, 'hd-cv-p').textContent, 'done: the bug was a stale cache');
  eq('it is labelled so the answer is findable', textOfClass(body, 'hd-cv-replytag'), 'reply');
  eq('and the label sits immediately before the reply bubble', (() => {
    const kids = body.children;
    const tag = kids.findIndex((n) => n.className.split(/\s+/).indexOf('hd-cv-replytag') >= 0);
    const rep = kids.findIndex((n) => n.className.split(/\s+/).indexOf('hd-cv-reply') >= 0);
    return { tag, rep, adjacent: rep === tag + 1 };
  })(), { tag: 4, rep: 5, adjacent: true });
  eq('the earlier text segment is marked interim, not reply',
    byClass(body, 'hd-cv-interim').map((n) => n.getAttribute('data-key')), ['s3']);
  ok('and therefore the interim text is NOT dressed as the answer',
    one(one(body, 'hd-cv-interim'), 'hd-cv-p').textContent === 'checking the second file',
    one(one(body, 'hd-cv-interim'), 'hd-cv-p').textContent);
}

section('A1 — a working turn can never look finished');
{
  const working = CR.renderTurn(TURN({ segments: SEGMENTS(), working: true, elapsedMs: 12000 }));
  const body = one(working, 'hd-cv-turn-body');
  eq('a working turn has no reply segment', byClass(working, 'hd-cv-reply').length, 0);
  eq('and no reply label', byClass(working, 'hd-cv-replytag').length, 0);
  eq('every text segment is interim while it works',
    byClass(body, 'hd-cv-interim').map((n) => n.getAttribute('data-key')), ['s3', 's5']);
  eq('the group ends in the live tail', byClass(working, 'hd-cv-working').length, 1);
  eq('and the live tail is the last thing in the group',
    body.children[body.children.length - 1].className.split(/\s+/)[0], 'hd-cv-working');
  eq('which reads its elapsed time', textOfClass(working, 'hd-cv-working-text'), 'working · 12s');
  eq('the whole group is still one group', byClass(working, 'hd-cv-turn').length, 1);

  const landed = CR.renderTurn(TURN({ segments: SEGMENTS(), working: false, elapsedMs: 12000 }));
  eq('once the final text lands, the tail is gone', byClass(landed, 'hd-cv-working').length, 0);
  eq('and the reply bubble has taken its place', byClass(landed, 'hd-cv-reply').length, 1);
}

section('A1 — empties are skipped, system records stay notes, nothing goes blank');
{
  const t = CR.renderTurn(TURN({ segments: [
    MSG({ key: 'e1', kind: 'text', text: '' }),
    MSG({ key: 'e2', kind: 'thinking', text: '' }),
    MSG({ key: 'e3', kind: 'system', text: 'permission granted' }),
    MSG({ key: 'e4', kind: 'text', text: 'the only prose' }),
  ] }));
  const body = one(t, 'hd-cv-turn-body');
  eq('empty text/thinking segments are skipped, not drawn as blank rows', msgKeys(body), ['e3', 'e4']);
  ok('and no empty bubble is left behind', !byClass(body, 'hd-cv-bubble').some((n) => n.textContent === ''),
    JSON.stringify(byClass(body, 'hd-cv-bubble').map((n) => n.textContent)));
  eq('a system record inside the turn is a note', byClass(body, 'hd-cv-sys').length, 1);
  eq('and NOT a bubble', byClass(body, 'hd-cv-bubble').length, 1);
  eq('with its text verbatim', textOfClass(body, 'hd-cv-sys'), 'permission granted');
  eq('the note also stays inside the group', byClass(t, 'hd-cv-turn-body').length, 1);

  const side = CR.renderTurn(TURN({ segments: [
    MSG({ key: 'sc', text: 'subagent work', sidechain: true }),
    MSG({ key: 'fin', text: 'summary' }),
  ] }));
  eq('a sidechain segment is nested inside the group, not flattened into it',
    [byClass(side, 'hd-cv-sidechain').length, byClass(side, 'hd-cv-turn-body').length], [1, 1]);

  eq('a turn with no prompt record says so rather than starting blank',
    notesOf(CR.renderTurn({ segments: [] })), ['this turn has no prompt record — the agent\'s own records follow']);
  eq('a finished turn with no records to show says so',
    notesOf(CR.renderTurn(TURN({ segments: [] }))), ['(this turn has no records to show yet)']);
  eq('a finished turn that ends without a reply says so',
    notesOf(CR.renderTurn(TURN({ segments: [CALL({ result: 'x' })] }))),
    ['(no reply in this turn — the log ends with the records above)']);
  const lonely = CR.renderTurn(TURN({ segments: [CALL({ result: 'x' })] }));
  eq('and it still draws the records it does have', byClass(lonely, 'hd-cv-card').length, 1);
  eq('while a working turn does not claim a reply is missing',
    byClass(CR.renderTurn(TURN({ segments: [CALL({ result: 'x' })], working: true })), 'hd-cv-working').length, 1);
}

section('A1 — malformed turns and hostile segment text');
{
  const junk = [null, undefined, 0, '', 'x', 42, true, [], [1], {}, { user: 5, segments: 'nope' },
    { user: null, segments: null }, { segments: [null, 1, 'x', {}, []] },
    { user: MSG({ role: 'user', text: 'hi' }), segments: [MSG({ kind: 'text', text: 'a' })], elapsedMs: 'nope', working: true },
    { user: MSG({}), segments: [MSG({ kind: 'tool_call' })], pending: true }];
  let threw = null, blank = null;
  for (const t of junk) {
    let node;
    try { node = CR.renderTurn(t); } catch (e) { threw = { t: String(t), e: String(e) }; break; }
    if (!node || typeof node.textContent !== 'string') { blank = { t: String(t), why: 'not a node' }; break; }
    if (node.textContent === '') { blank = { t: JSON.stringify(t), why: 'rendered empty' }; break; }
  }
  ok('no malformed turn throws', threw === null, JSON.stringify(threw));
  ok('and none renders empty', blank === null, JSON.stringify(blank));

  const IMG = '<img src=x onerror=alert(1)>', SCRIPT = '<script>alert(1)</script>';
  const hostile = CR.renderTurn({
    user: MSG({ role: 'user', text: 'prompt ' + SCRIPT }),
    segments: [
      MSG({ key: 'h1', kind: 'thinking', text: IMG }),
      CALL({ name: IMG, input: { command: IMG }, result: SCRIPT, call_key: 'h2' }, { key: 'h2' }),
      MSG({ key: 'h3', kind: 'text', text: IMG }),
      MSG({ key: 'h4', kind: 'text', text: SCRIPT }),
      MSG({ key: 'h5', kind: 'system', text: IMG }),
    ],
  });
  const scan = noInjectedMarkup(hostile);
  ok('no part of a turn can produce markup',
    scan.found.length === 0 && scan.badTags.length === 0 && scan.badAttrs.length === 0, JSON.stringify(scan));
  ok('the payloads are all still literal text',
    ['prompt ' + SCRIPT, IMG, SCRIPT].every((s) => hostile.textContent.indexOf(s) >= 0), hostile.textContent.slice(0, 200));
  ok('including the one in the tool summary and the one in the tool result',
    hostile.textContent.indexOf(IMG) >= 0 && hostile.textContent.indexOf(SCRIPT) >= 0,
    hostile.textContent.slice(0, 400));
  eq('a turn never assigns a non-empty innerHTML either', INNER_HTML_WRITES, []);
}

// ── A1: the live tail ───────────────────────────────────────────────────────

section('A1 — renderWorkingTail(elapsedMs): alive, and never a finished turn');
{
  ok('renderWorkingTail(elapsedMs) -> Element', typeof CR.renderWorkingTail === 'function', typeof CR.renderWorkingTail);
  const w = CR.renderWorkingTail(12000);
  eq('the indicator says what it is and for how long', textOfClass(w, 'hd-cv-working-text'), 'working · 12s');
  eq('it is one element with the live hook', byClass(w, 'hd-cv-working').length, 1);
  eq('it carries a pulsing dot', byClass(w, 'hd-cv-dot').length, 1);
  eq('the dot claims nothing to a screen reader', one(w, 'hd-cv-dot').getAttribute('aria-hidden'), 'true');
  eq('data-elapsed-ms carries the raw value for anything that needs to recompute it',
    w.getAttribute('data-elapsed-ms'), '12000');
  eq('and the text is exactly the contract\'s form', /^working · \d+s$/.test(textOfClass(w, 'hd-cv-working-text')), true);
  ok('it is NOT a bubble and NOT a reply', byClass(w, 'hd-cv-bubble').length === 0 && byClass(w, 'hd-cv-reply').length === 0,
    html(w));
  eq('and it is not a message either', byClass(w, 'hd-cv-msg').length, 0);

  eq('the title spells the same time out readably', one(w, 'hd-cv-working-text').title,
    'this turn has been running for 12s');
  eq('under a minute: seconds', textOfClass(CR.renderWorkingTail(0), 'hd-cv-working-text'), 'working · 0s');
  eq('partial seconds are floored, not rounded up', textOfClass(CR.renderWorkingTail(999), 'hd-cv-working-text'), 'working · 0s');
  eq('one second is one second', textOfClass(CR.renderWorkingTail(1000), 'hd-cv-working-text'), 'working · 1s');
  eq('a number given as a string is honoured', textOfClass(CR.renderWorkingTail('12000'), 'hd-cv-working-text'), 'working · 12s');
  eq('minutes and seconds in the title after a minute', one(CR.renderWorkingTail(125000), 'hd-cv-working-text').title,
    'this turn has been running for 2m 05s');
  eq('hours after an hour', one(CR.renderWorkingTail(7200000), 'hd-cv-working-text').title,
    'this turn has been running for 2h 00m');
  eq('and the visible number stays the raw seconds the contract asks for',
    textOfClass(CR.renderWorkingTail(125000), 'hd-cv-working-text'), 'working · 125s');

  for (const bad of [undefined, null, 'x', NaN, Infinity, -1, -5000, {}, [], '<img src=x onerror=1>']) {
    const node = CR.renderWorkingTail(bad);
    ok(`an unknown elapsed time (${JSON.stringify(bad)}) is reported as unknown, not as 0s`,
      textOfClass(node, 'hd-cv-working-text') === 'working',
      textOfClass(node, 'hd-cv-working-text'));
    eq(`and it invents no data-elapsed-ms (${JSON.stringify(bad)})`, node.getAttribute('data-elapsed-ms'), null);
  }
  ok('an unknown elapsed time still says which turn it belongs to',
    /this turn is running/.test(one(CR.renderWorkingTail(undefined), 'hd-cv-working-text').title),
    one(CR.renderWorkingTail(undefined), 'hd-cv-working-text').title);
  eq('the tail never assigns a non-empty innerHTML', INNER_HTML_WRITES, []);
}

// ── the log's own duplicates ────────────────────────────────────────────────

section('§8.2 — a call the log contains twice is drawn once, and the fold is counted');
{
  const dup = (n) => Array.from({ length: n }, (_, i) =>
    CALL({ result: 'same output', call_key: 'k1' }, { key: 'c' + i }));
  const box = listRoot(dup(2)).box;
  eq('two identical calls are one card', byClass(box, 'hd-cv-card').length, 1);
  eq('with the wording the round asked for', textOfClass(box, 'hd-cv-dupes'),
    '×2 (the log contains this call twice)');
  eq('the surviving card is the first occurrence', msgKeys(box), ['c0']);
  eq('and its result is still shown, once', box.textContent.split('same output').length - 1, 1);

  const three = listRoot(dup(3)).box;
  eq('three identical calls are one card too', byClass(three, 'hd-cv-card').length, 1);
  eq('with the count stated', textOfClass(three, 'hd-cv-dupes'),
    '×3 (the log repeats this call 3 times)');

  // Same call_key on both, so the input is the ONLY thing that distinguishes them: if the input were
  // left out of the identity these two would fold, and the second command would vanish from the log.
  const diffInput = listRoot([
    CALL({ result: 'r', call_key: 'k1' }, { key: 'a' }),
    CALL({ result: 'r', call_key: 'k1', input: { command: 'other' } }, { key: 'b' }),
  ]).box;
  eq('two calls with different input are never folded', byClass(diffInput, 'hd-cv-card').length, 2);
  eq('and nothing claims a duplicate', byClass(diffInput, 'hd-cv-dupes').length, 0);
  eq('so both inputs stay visible', /other/.test(diffInput.textContent), true);
  eq('and the report counts neither as folded',
    CR.foldReport([
      CALL({ result: 'r', call_key: 'k1' }),
      CALL({ result: 'r', call_key: 'k1', input: { command: 'other' } }),
    ]), { folded: 0, groups: [] });

  const diffResult = listRoot([
    CALL({ result: 'r1', call_key: 'k1' }, { key: 'a' }),
    CALL({ result: 'r2', call_key: 'k1' }, { key: 'b' }),
  ]).box;
  eq('two calls with different results are never folded', byClass(diffResult, 'hd-cv-card').length, 2);
  eq('so both results stay visible',
    [diffResult.textContent.indexOf('r1') >= 0, diffResult.textContent.indexOf('r2') >= 0], [true, true]);

  const noKeys = listRoot([
    CALL({ result: 'r', call_key: '' }, { key: 'a' }),
    CALL({ result: 'r', call_key: '' }, { key: 'b' }),
  ]).box;
  eq('with no call_key at all, identical cards still fold (nothing distinguishes them)',
    byClass(noKeys, 'hd-cv-card').length, 1);

  // The deliberate narrowing, asserted so it cannot drift: the server's own id wins.
  const twoIds = listRoot([
    CALL({ result: 'r', call_key: 'k1' }, { key: 'a' }),
    CALL({ result: 'r', call_key: 'k2' }, { key: 'b' }),
  ]).box;
  eq('two DIFFERENT call_keys are two calls, even with identical name+input+result',
    byClass(twoIds, 'hd-cv-card').length, 2);
  eq('and both are counted as kept, not folded', CR.foldReport([
    CALL({ result: 'r', call_key: 'k1' }),
    CALL({ result: 'r', call_key: 'k2' }),
  ]), { folded: 0, groups: [] });

  eq('foldReport counts what folding removed', CR.foldReport(dup(4)),
    { folded: 3, groups: [{ index: 0, count: 4, name: 'Bash' }] });
  eq('and reports nothing for a log without duplicates', CR.foldReport([MSG({}), CALL({ result: 'r' })]),
    { folded: 0, groups: [] });
  for (const junk of [null, undefined, 'x', 42, {}, [1, 2, null], [MSG({}), MSG({})]]) {
    const r = CR.foldReport(junk);
    ok(`foldReport(${JSON.stringify(junk)}) is a report, not a throw`,
      r && typeof r.folded === 'number' && Array.isArray(r.groups), JSON.stringify(r));
  }

  const inTurn = CR.renderTurn(TURN({ segments: [
    CALL({ result: 'same output', call_key: 'k1' }, { key: 't1' }),
    MSG({ key: 't2', kind: 'thinking', text: 'then it answered' }),
    CALL({ result: 'same output', call_key: 'k1' }, { key: 't3' }),
    MSG({ key: 't4', kind: 'text', text: 'the reply' }),
  ] }));
  eq('a turn folds its own duplicated call the same way', byClass(inTurn, 'hd-cv-card').length, 1);
  eq('with the same note', textOfClass(inTurn, 'hd-cv-dupes'), '×2 (the log contains this call twice)');
  eq('and the reply is still the last text', one(inTurn, 'hd-cv-reply').getAttribute('data-key'), 't4');
  eq('while the segment order of what remains is untouched',
    msgKeys(one(inTurn, 'hd-cv-turn-body')), ['t1', 't2', 't4']);

  const hostile = listRoot([
    CALL({ result: '<img src=x onerror=1>', name: '<script>alert(1)</script>', call_key: '' }, { key: 'x1' }),
    CALL({ result: '<img src=x onerror=1>', name: '<script>alert(1)</script>', call_key: '' }, { key: 'x2' }),
  ]).box;
  const scan = noInjectedMarkup(hostile);
  ok('a fold note is built from text, like everything else',
    scan.found.length === 0 && scan.badTags.length === 0, JSON.stringify(scan));
  eq('and the fold still happened around hostile content', byClass(hostile, 'hd-cv-card').length, 1);
  eq('the fold never assigns a non-empty innerHTML', INNER_HTML_WRITES, []);
}

// ── the server's own caps ───────────────────────────────────────────────────

section('§8.2 — the server\'s truncation flags stay visible, folded or not');
{
  const m = CR.renderMessage(MSG({ text: 'a short prompt', text_truncated: true }));
  eq('a clamped text says so', notesOf(m), ['text truncated by the server']);
  eq('it does not restate the word "input" or "result"', /input truncated|result truncated/.test(m.textContent), false);
  eq('and the text shown is the text the server gave', one(m, 'hd-cv-p').textContent, 'a short prompt');

  const long = CR.renderMessage(MSG({ text: lines(25), text_truncated: true }));
  ok('a clamped text that is ALSO long-capped shows both facts',
    /show all · 25 lines/.test(long.textContent) && /text truncated by the server/.test(long.textContent),
    long.textContent.slice(0, 120));
  const noteInBubble = byClass(long, 'hd-cv-note').filter((n) => /truncated/.test(n.textContent));
  eq('and the server note is outside the collapsible box, so collapsing cannot hide it',
    noteInBubble.map((n) => n.parentNode.className), ['hd-cv-bubble']);
  ok('while the display clamp is the only thing inside the box',
    byClass(one(long, 'hd-cv-body'), 'hd-cv-note').length === 0, html(long).slice(0, 200));

  const think = CR.renderMessage(MSG({ kind: 'thinking', text: 'long thoughts', text_truncated: true }));
  eq('a clamped thinking record announces it while still collapsed',
    [textOfClass(think, 'hd-cv-note'), parentClass(one(think, 'hd-cv-note')), hiddenOf(one(think, 'hd-cv-think-body'))],
    ['text truncated by the server', 'hd-cv-think', true]);
  ok('the note is a sibling of the collapsed body, not inside it',
    byClass(one(think, 'hd-cv-think-body'), 'hd-cv-note').length === 0, html(think).slice(0, 200));

  const res = RESULT({ result: 'output', call_key: 'gone' }, { text: 'output', text_truncated: true });
  eq('an unpaired result clamped on the record says "result"',
    notesOf(listRoot([res]).box), ['unpaired result', 'result truncated by the server']);
  eq('and the tool-level flag says the same thing',
    notesOf(CR.renderMessage(CALL({ result: 'output', result_truncated: true }))),
    ['result truncated by the server']);
  eq('an input clamp is named as such',
    notesOf(CR.renderMessage(CALL({ input_truncated: true }))), ['input truncated by the server']);

  const clamps = (root) => notesOf(root).filter((s) => /truncated/.test(s));
  eq('nothing is flagged when nothing was clamped',
    [clamps(CR.renderMessage(MSG({ text: lines(25) }))),
     clamps(CR.renderMessage(CALL({ result: lines(25, 'R') }))),
     clamps(listRoot([RESULT({ result: 'x' })]).box)],
    [[], [], []]);

  const folded = listRoot([
    CALL({ result: 'r', call_key: 'k1', input_truncated: true, result_truncated: true }, { key: 'f1' }),
    CALL({ result: 'r', call_key: 'k1', input_truncated: true, result_truncated: true }, { key: 'f2' }),
  ]).box;
  ok('a folded card still carries every truncation note',
    ['input truncated by the server', 'result truncated by the server', '×2 (the log contains this call twice)']
      .every((s) => folded.textContent.indexOf(s) >= 0), folded.textContent);
  eq('all on the one surviving card', byClass(folded, 'hd-cv-card').length, 1);
}

// ── the stylesheet ──────────────────────────────────────────────────────────

// ── §13.1 the copy button, and the one function that reads a block back ──────

section('§13.1.1 — the copy button: one per head, §13.1.1\'s markup verbatim, always the last child');
{
  /** The frozen string, written out here the way the contract writes it. A literal, not a call into
   *  the renderer: the point of this check is that the MARKUP matches the spec, and comparing the
   *  renderer against itself could not tell either of them apart from a typo. */
  const COPY = (id) => `<button class="hd-cv-copy" type="button" data-hd-copy="${id}" aria-label="copy this block">⧉</button>`;
  const shapes = [
    ['a bubble', MSG({ key: 'x1', role: 'user', kind: 'text', text: 'a prompt' }), 'x1', 'hd-cv-meta'],
    ['an assistant reply', MSG({ key: 'x2', kind: 'text', text: 'an answer' }), 'x2', 'hd-cv-meta'],
    ['a thinking block', MSG({ key: 'x3', kind: 'thinking', text: 'a thought' }), 'x3#think0', 'hd-cv-think-row'],
    ['a tool call card', CALL({ name: 'Bash', input: { command: 'npm test' }, result: 'ok' }, { key: 'x4' }), 'x4#toolc1', 'hd-cv-card-head'],
    ['an unpaired tool result', RESULT({ name: 'Bash', call_key: 'zz', result: null }, { key: 'x5' }), 'x5#toolzz', 'hd-cv-card-head'],
    ['a system note', MSG({ key: 'x6', kind: 'system', text: 'a note' }), 'x6', 'hd-cv-meta'],
    ['a record of an unknown kind', MSG({ key: 'x7', kind: 'weird', text: 'what' }), 'x7', 'hd-cv-meta'],
  ];
  for (const [what, msg, id, rowCls] of shapes) {
    const root = CR.renderMessage(msg);
    const btns = byClass(root, 'hd-cv-copy');
    if (btns.length !== 1) {
      ok(`${what}: exactly one copy button in the head`, false, `${btns.length} were rendered`);
      continue;
    }
    const b = btns[0];
    eq(`the copy button of ${what} is §13.1.1's markup, byte for byte`, html(b), COPY(id));
    const row = one(root, rowCls);
    ok(`and it sits in the ${rowCls} head row, not in the message head`, !!row);
    ok(`it is the LAST child of the ${rowCls} head row it belongs to`,
      row.children[row.children.length - 1] === b,
      `last child is ${row.children.length ? row.children[row.children.length - 1].className : '(none)'}`);
    ok(`the head row — not a control inside it — is its parent`, b.parentNode === row, parentClass(b));
    ok(`it carries no fold/open hook of its own (it is not a peer control)`,
      b.getAttribute('data-hd-fold') === null && b.getAttribute('data-hd-open') === null
        && b.getAttribute('data-hd-foldhead') === null,
      JSON.stringify(b.attrs));
    ok(`the renderer attaches no listener to it — the click is W2's to delegate`,
      Object.keys(b.listeners || {}).length === 0, JSON.stringify(Object.keys(b.listeners || {})));
    ok(`and it is never inside a body or a preview: a head control only`,
      byClass(root, 'hd-cv-body').concat(byClass(root, 'hd-cv-think-body'), byClass(root, 'hd-cv-card-body'))
        .every((box) => byClass(box, 'hd-cv-copy').length === 0),
      'a copy button was rendered inside a body');
    const again = CR.renderMessage(msg);
    ok(`and a second render draws it identically (no counter, no state in it)`,
      html(again) === html(root), `again: ${html(again).slice(0, 120)}`);
  }

  // §13.1.1 says EVERY message head, so the count over a whole list is: one per drawn message, plus
  // one more for each block that draws a head of its own (a thinking record, a tool card).
  const list = [
    MSG({ key: 'l1', role: 'user', kind: 'text', text: 'a prompt' }),
    MSG({ key: 'l2', kind: 'thinking', text: 'a thought' }),
    CALL({ name: 'Bash', call_key: 'q1', input: { command: 'x' }, result: 'y' }, { key: 'l3' }),
    RESULT({ name: 'Read', call_key: 'q9', result: null }, { key: 'l4' }),
    MSG({ key: 'l5', kind: 'system', text: 'a note' }),
    MSG({ key: 'l6', kind: 'not-a-kind', text: 'what' }),
    MSG({ key: 'l7', kind: 'text', text: '' }),
  ];
  const { box } = listRoot(list);
  const msgs = byClass(box, 'hd-cv-msg').length, thinks = byClass(box, 'hd-cv-think').length,
    cards = byClass(box, 'hd-cv-card').length;
  eq('seven records are drawn', [msgs, thinks, cards], [7, 1, 2]);
  eq('and the list carries exactly one copy button per block — not one per head row',
    byClass(box, 'hd-cv-copy').length, msgs);
  eq('every drawn message has exactly one, in whichever of its heads that kind uses',
    byClass(box, 'hd-cv-msg').filter((m) => byClass(m, 'hd-cv-copy').length !== 1).length, 0);
  // The rule, stated where it can fail: a bubble, a system note and an unknown kind are copied from
  // their MESSAGE head; a thinking or tool record is copied from its BLOCK head and NOT from the
  // message head — one button per block, never two for the same string.
  const headOf = (m) => [byClass(one(m, 'hd-cv-meta'), 'hd-cv-copy').length,
    byClass(m, 'hd-cv-copy').length];
  eq('bubble / system note / unknown kind: the message head holds it',
    [headOf(byClass(box, 'hd-cv-msg')[0]), headOf(byClass(box, 'hd-cv-msg')[4]),
     headOf(byClass(box, 'hd-cv-msg')[5])], [[1, 1], [1, 1], [1, 1]]);
  eq('thinking and tool records: the block head holds it, the message head does not',
    [headOf(byClass(box, 'hd-cv-msg')[1]), headOf(byClass(box, 'hd-cv-msg')[2]),
     headOf(byClass(box, 'hd-cv-msg')[3])], [[0, 1], [0, 1], [0, 1]]);
  eq('and no message carries two buttons for one block', byClass(box, 'hd-cv-copy').length, msgs);

  // "the fold control keeps its own hit area": the two controls are siblings, never nested, and the
  // fold control still comes first in the row it shares.
  const folded = CR.renderMessage(MSG({ key: 'h1', role: 'user', text: 'one line' }), { foldedKeys: { h1: true } });
  const head = one(folded, 'hd-cv-meta');
  const foldBtn = one(folded, 'hd-cv-foldbtn');
  const copyBtn = one(folded, 'hd-cv-copy');
  ok('the fold control is still in the head, next to the copy button',
    byClass(head, 'hd-cv-foldbtn').length === 1 && byClass(head, 'hd-cv-copy').length === 1,
    html(head).slice(0, 160));
  ok('neither control is nested in the other',
    byClass(foldBtn, 'hd-cv-copy').length === 0 && byClass(copyBtn, 'hd-cv-foldbtn').length === 0,
    'one control was rendered inside the other');
  ok('and the fold control still comes first, so its own hit area is untouched',
    head.children.indexOf(foldBtn) < head.children.indexOf(copyBtn),
    `fold at ${head.children.indexOf(foldBtn)}, copy at ${head.children.indexOf(copyBtn)}`);

  const card = CR.renderMessage(CALL({ name: 'Read', input: { file_path: 'a.js' }, result: 'x' }, { key: 'h2' }));
  const cardHead = one(card, 'hd-cv-card-head');
  ok('the card\'s expand/collapse control is likewise first, the copy button last',
    html(cardHead).indexOf('hd-cv-toggle') < html(cardHead).indexOf('hd-cv-copy')
      && byClass(one(card, 'hd-cv-toggle'), 'hd-cv-copy').length === 0,
    html(cardHead).slice(0, 200));

  const think = CR.renderMessage(MSG({ key: 'h3', kind: 'thinking', text: 'a thought' }));
  ok('a thinking block\'s head row holds the control and the copy button as siblings — a button may ' +
    'not contain a button', byClass(one(think, 'hd-cv-think-row'), 'hd-cv-think-head').length === 1
      && byClass(one(think, 'hd-cv-think-head'), 'hd-cv-copy').length === 0
      && one(think, 'hd-cv-think-row').children[0] === one(think, 'hd-cv-think-head'),
    html(one(think, 'hd-cv-think-row')).slice(0, 200));

  // A turn draws its messages through the same function, so the head of the reply carries a button too.
  const turn = CR.renderTurn(TURN({ segments: SEGMENTS() }));
  eq('every message the turn drew has a copy button',
    byClass(turn, 'hd-cv-msg').filter((m) => byClass(m, 'hd-cv-copy').length === 1).length,
    byClass(turn, 'hd-cv-msg').length);
}

section('§13.1.2 — blockText(blockEl): the renderer\'s own string, fold and clamp included');
{
  ok('one function, published as HD.chatRender.blockText (the §13.1.2 name)',
    typeof CR.blockText === 'function' && SB.window.HD.chatRender.blockText === CR.blockText,
    typeof CR.blockText);
  ok('and it is the only new name this round put on the frozen interface',
    JSON.stringify(Object.keys(CR).sort()) === JSON.stringify(['autoScrollOpts', 'blockText', 'foldReport',
      'renderList', 'renderMessage', 'renderTurn', 'renderWorkingTail', 'summaryFor']),
    Object.keys(CR).join(','));

  // (a) the raw record, not the rendered body: markdown syntax is in the string the renderer used.
  const md = 'a **bold** word, `code`, and a bare https://example.com/path link';
  const msg = MSG({ key: 'b1', role: 'user', text: md });
  eq('a bubble\'s block text is the record verbatim, markdown and all',
    CR.blockText(CR.renderMessage(msg)), md);

  // (b) a folded bubble: the reader sees one line, the clipboard gets the whole record.
  const SENTINEL = 'line-25-IS-HERE';
  const long = 'first line\n' + Array.from({ length: 23 }, (_, i) => 'line ' + (i + 2)).join('\n')
    + '\n' + SENTINEL;
  const foldedRoot = CR.renderMessage(MSG({ key: 'b2', role: 'user', text: long }), { foldedKeys: { b2: true } });
  ok('the folded bubble really is folded (its own line count says what it hides, and the last line ' +
    'is not on screen)', byClass(foldedRoot, 'hd-cv-folded').length === 1
      && foldedRoot.textContent.indexOf(SENTINEL) < 0 && html(foldedRoot).indexOf(SENTINEL) < 0,
    html(foldedRoot).slice(0, 200));
  eq('a folded block\'s blockText() is the text the fold is hiding', CR.blockText(foldedRoot), long);
  ok('and it is what the folded PREVIEW hid, not what the preview said: the copy is longer than the' +
    ' page',
    CR.blockText(foldedRoot).length > foldedRoot.textContent.length,
    `${CR.blockText(foldedRoot).length} chars vs ${foldedRoot.textContent.length} on the page`);
  eq('the same message unfolded copies the same string', CR.blockText(CR.renderMessage(MSG({ key: 'b2', role: 'user', text: long }))), long);

  // (c) the long-text clamp behind "show all" is display too: what is copied is the whole record.
  const clamped = CR.renderMessage(MSG({ key: 'b3', text: long }));
  ok('the clamp really is holding text back (the control says how much)',
    /show all/.test(textOfClass(clamped, 'hd-cv-more') || '') && clamped.textContent.indexOf(SENTINEL) < 0,
    `${textOfClass(clamped, 'hd-cv-more')} · sentinel on screen: ${clamped.textContent.indexOf(SENTINEL)}`);
  eq('and blockText() still returns the whole record', CR.blockText(clamped), long);

  // (d) the head's own chrome is not in it: no glyph, no state word, no count, no preview.
  const foldedText = CR.blockText(foldedRoot);
  eq('nothing from the head is in the copied string', ['⧉', 'fold', 'hidden', 'show all', 'you', '--:--:--']
    .filter((s) => foldedText.indexOf(s) >= 0), []);

  // (e) the block id on the button and on the block are one name.
  /* The block a button belongs to, found the way blockText() finds it: the nearest marked ancestor. */
  const blockOf = (root) => {
    let n = one(root, 'hd-cv-copy').parentNode;
    while (n && !n.getAttribute('data-hd-block')) n = n.parentNode;
    return n || { getAttribute: () => null };
  };
  for (const [what, m] of [['a bubble', msg],
    ['a thinking record', MSG({ key: 'b4', kind: 'thinking', text: 'thoughts' })],
    ['a tool card', CALL({ name: 'Bash', input: { command: 'ls' }, result: 'files' }, { key: 'b5' })]]) {
    const r = CR.renderMessage(m);
    eq(`${what}: the button's data-hd-copy names the block it copies`,
      one(r, 'hd-cv-copy').getAttribute('data-hd-copy'), blockOf(r).getAttribute('data-hd-block'));
  }

  // (f) the thinking block and the tool card have their own text.
  const thinkMsg = MSG({ key: 'b6', kind: 'thinking', text: 'the thought, verbatim' });
  const thinkRoot = CR.renderMessage(thinkMsg);
  eq('a thinking block\'s text is the thinking record, not the head or the counter',
    [CR.blockText(one(thinkRoot, 'hd-cv-think')), CR.blockText(one(thinkRoot, 'hd-cv-copy'))],
    ['the thought, verbatim', 'the thought, verbatim']);
  const callMsg = CALL({ name: 'Bash', input: { command: 'npm test', cwd: 'D:/x' }, result: 'ok\nsecond line' }, { key: 'b7' });
  const callRoot = CR.renderMessage(callMsg);
  const wantCard = '{\n  "command": "npm test",\n  "cwd": "D:/x"\n}\n\nok\nsecond line';
  eq('a tool card\'s text is its input and its result, verbatim and in that order',
    [CR.blockText(one(callRoot, 'hd-cv-card')), CR.blockText(one(callRoot, 'hd-cv-copy'))],
    [wantCard, wantCard]);
  eq('and the card\'s own message head copies that same block text',
    CR.blockText(callRoot), wantCard);
  eq('an input-only card copies the input, with no empty result half',
    CR.blockText(CR.renderMessage(CALL({ name: 'Read', input: { file_path: 'a.js' } }, { key: 'b8' }))),
    '{\n  "file_path": "a.js"\n}');
  eq('a result-only card copies the result',
    CR.blockText(CR.renderMessage(RESULT({ name: 'Bash', call_key: 'q8', result: 'only the result' }, { key: 'b9' }))),
    'only the result');
  eq('an empty-object input copies the JSON the card drew, not an invented blank',
    CR.blockText(CR.renderMessage(CALL({ name: 'Bash', input: {} }, { key: 'b10' }))), '{}');
  eq('a card with neither an input nor a result copies nothing at all',
    CR.blockText(CR.renderMessage(CALL({ name: 'Bash', input: null, result: null }, { key: 'b10b' }))), '');
  // The card DRAWS the two section labels; the copy does not carry them, because they are this
  // file's chrome and not the log's words (the same rule as the head's counters).
  eq('the section labels "input"/"result" are drawn but not copied',
    [byClass(one(callRoot, 'hd-cv-card-body'), 'hd-cv-sec').length,
     wantCard.indexOf('input') < 0 && wantCard.indexOf('result') < 0], [2, true]);

  // (g) the spellings a caller may reasonably use, and the one it may not.
  const bubble = CR.renderMessage(MSG({ key: 'b11', role: 'user', text: 'from the button' }));
  eq('handing it the BUTTON finds the block above it',
    CR.blockText(one(bubble, 'hd-cv-copy')), 'from the button');
  eq('handing it the block itself works too', CR.blockText(bubble), 'from the button');
  eq('and so does anything between the two (the head row)',
    CR.blockText(one(bubble, 'hd-cv-meta')), 'from the button');
  eq('a node that is no block at all yields an empty string, never null',
    [typeof CR.blockText(doc.createElement('div')), CR.blockText(doc.createElement('div'))], ['string', '']);
  eq('an empty record copies an empty string', CR.blockText(CR.renderMessage(MSG({ key: 'b12', text: '' }))), '');
  ok('the message head of a keyless record still names a block, and the name is not empty',
    (() => { const r = CR.renderMessage(MSG({ key: null, text: 'keyless' }));
      return /^[#\w]/.test(one(r, 'hd-cv-copy').getAttribute('data-hd-copy'))
        && CR.blockText(r) === 'keyless'; })(),
    'a keyless message rendered no usable block name');

  // (h) untrusted text stays text: a message that IS copy-button markup is copied, not executed.
  const hostile = '<button class="hd-cv-copy" data-hd-copy="evil">⧉</button> <img src=x onerror=1>';
  const hostileRoot = CR.renderMessage(MSG({ key: 'b13', role: 'user', text: hostile }));
  eq('a message containing copy-button markup is copied verbatim', CR.blockText(hostileRoot), hostile);
  eq('while the page still holds exactly one copy button for it',
    byClass(hostileRoot, 'hd-cv-copy').length, 1);
  const inj = noInjectedMarkup(hostileRoot);
  eq('and none of it became markup', [inj.found, inj.badTags, inj.badAttrs], [[], [], []]);

  // (i) 20,000 chars — the §8.2 cap — come back whole.
  const big = 'Z'.repeat(20000);
  eq('a 20,000-character record copies 20,000 characters',
    CR.blockText(CR.renderMessage(MSG({ key: 'b14', text: big }))).length, 20000);

  // (j) an open block copies the same string as a closed one: the reader's own state is not in it.
  const openMsg = MSG({ key: 'b15', kind: 'thinking', text: 'a thought' });
  eq('opening a block does not change what it copies',
    CR.blockText(CR.renderMessage(openMsg, { openKeys: { 'b15#think0': true } })),
    CR.blockText(CR.renderMessage(openMsg)));
}

section('§13.1.1 — the button is ≥20×20 px and the two heads it sits in are styled');
{
  const bodies = (sel) => {
    const re = new RegExp('[^{}]*' + sel.replace(/\./g, '\\.') + '[^{}]*\\{([^}]*)\\}', 'g');
    const out = []; let m;
    while ((m = re.exec(CSS_SRC))) out.push(m[1]);
    return out;
  };
  const copy = bodies('.hd-cv-copy').join(' ');
  ok('the copy button declares a 20x20 hit area of its own (§10.9\'s convention)',
    /width:\s*20px/.test(copy) && /height:\s*20px/.test(copy)
      && /min-width:\s*20px/.test(copy) && /min-height:\s*20px/.test(copy), copy);
  ok('it cannot be squeezed below that by the head row it shares',
    /flex:\s*0 0 auto/.test(copy), copy);
  ok('and its ring is drawn with outline, so focus cannot resize the row',
    /\.hd-cv-copy:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/.test(CSS_SRC), 'no focus style');
  ok('the thinking head row places the two controls side by side',
    /\.hd-cv-think-row\s*\{[^}]*display:\s*flex/.test(CSS_SRC), bodies('.hd-cv-think-row').join(' '));
  ok('and the head control may shrink there instead of pushing the row past the pane',
    /\.hd-cv-think-head\s*\{[^}]*min-width:\s*0/.test(CSS_SRC), bodies('.hd-cv-think-head').join(' '));
}

section('chatview.css — every class the renderer emits is styled, and nothing dead is left');
{
  // Classes this sheet styles that the RENDERER never emits: W2's own nodes. The last five are the
  // §10 attachment markup, frozen in §10.9 and built by W2's composer — the sheet is the only place
  // they are named on this side of the wire.
  const W2_HOOKS = ['hd-cv-scroll', 'hd-cv-list', 'hd-cv-jump', 'hd-cv-empty',
    'hd-cv-attach-list', 'hd-cv-attach', 'hd-cv-attach-meta', 'hd-cv-attach-remove', 'hd-cv-drop-active'];
  // Class names are read out of the source with comments stripped, so a class named only in a
  // comment (the CLASS CONTRACT header, say) cannot vouch for a rule. Both sides are read the same
  // way, which is what makes the two directions comparable:
  //   atom ending in '-'  -> a family built by concatenation ('hd-cv-kind-' + kind), covers a prefix
  //   any other atom      -> one class
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/@keyframes\s+hd-cv-[\w-]+/g, ' ');
  const atoms = (s, re) => Array.from(new Set((strip(s).match(re) || [])));
  const emitted = atoms(RENDER_SRC, /hd-cv-[a-z0-9-]+/g);
  const families = emitted.filter((c) => /-$/.test(c));
  const singles = emitted.filter((c) => !/-$/.test(c));
  const isFamily = (c) => families.some((f) => c.indexOf(f) === 0);
  const hasRule = (c) => new RegExp('\\.' + c + '(?![a-z0-9_-])').test(CSS_SRC);
  console.log(`     ${singles.length} hd-cv-* classes + ${families.length} families in the renderer, ` +
    `${W2_HOOKS.length} W2 hooks`);

  eq('every class the renderer can emit has a rule in chatview.css',
    singles.filter((c) => !hasRule(c)), []);
  // @keyframes names are animation names, not classes: drop both the definition and every
  // `animation:` reference before judging which class selectors were left unused.
  const cssNoAnim = strip(CSS_SRC).replace(/animation\s*:[^;}]*/g, ' ');
  const cssAtoms = atoms(cssNoAnim, /hd-cv-[a-z0-9_-]+/g);
  eq('every family the renderer can build has at least one rule',
    families.filter((f) => !new RegExp('\\.' + f).test(CSS_SRC)), []);
  eq('and no rule in the stylesheet is dead',
    cssAtoms.filter((c) => W2_HOOKS.indexOf(c) < 0 && singles.indexOf(c) < 0 && !isFamily(c)), []);
  ok('the stylesheet actually names classes, so the check above is not vacuous',
    cssAtoms.length > 25, `${cssAtoms.length} class atoms in the CSS`);

  const literals = (CSS_SRC.match(/(^|[\s;{])color\s*:\s*[^;}]+/g) || []).map((s) => s.replace(/.*color\s*:/, '').trim());
  eq('no text colour is a literal — text always comes from the shared palette',
    literals.filter((v) => v.indexOf('var(') < 0), []);
  ok('the stylesheet leans on the shared variables', (CSS_SRC.match(/var\(--/g) || []).length > 20,
    `${(CSS_SRC.match(/var\(--/g) || []).length} variable uses`);
  // A misspelt variable name is silent in CSS: var(--nope) has no fallback, so the declaration is
  // dropped and the text just inherits. So every name this sheet reads must be one style.css sets.
  const STYLE_SRC = fs.readFileSync(path.join(REPO, 'public', 'style.css'), 'utf8');
  const declared = new Set((STYLE_SRC.match(/--[a-z0-9-]+(?=\s*:)/g) || []));
  const used = Array.from(new Set((CSS_SRC.match(/var\(\s*(--[a-z0-9-]+)\s*\)/g) || [])
    .map((s) => s.replace(/var\(\s*|\s*\)/g, ''))));
  eq('every variable it reads is one style.css declares', used.filter((v) => !declared.has(v)), []);
  ok('and it reads a real set of them, so the check above is not vacuous',
    used.length > 8 && declared.size > 8, `${used.length} read / ${declared.size} declared`);
  ok('it declares no second palette (no :root block)', !/:root\s*\{/.test(CSS_SRC), 'a :root block appeared');
  ok('the jump button is styled for W2 to render', /\.hd-cv-jump\s*\{/.test(CSS_SRC), 'no .hd-cv-jump rule');
  ok('the scroll container is styled', /\.hd-cv-scroll\s*\{/.test(CSS_SRC), 'no .hd-cv-scroll rule');
}

section('QA — the tightened stylesheet, checked rather than asserted in a comment');
{
  const STYLE_SRC = fs.readFileSync(path.join(REPO, 'public', 'style.css'), 'utf8');
  const rule = (sel) => {
    const m = CSS_SRC.match(new RegExp(sel.replace(/\./g, '\\.') + '\\s*\\{([^}]*)\\}'));
    return m ? m[1] : '';
  };
  /** Every rule body this class appears in — as a selector of its own, or as one part of a longer
   *  one. The bound on an expanded block lives in a compound rule (`.hd-cv-body.hd-cv-open`), so
   *  asking only for `\.hd-cv-body {` would miss the rule that does the bounding. */
  const bodies = (sel) => {
    const re = new RegExp('[^{}]*' + sel.replace(/\./g, '\\.') + '[^{}]*\\{([^}]*)\\}', 'g');
    const out = []; let m;
    while ((m = re.exec(CSS_SRC))) out.push(m[1]);
    return out;
  };
  const jump = rule('.hd-cv-jump');
  ok('the jump pill sticks to the foot of the scroll box', /position:\s*sticky/.test(jump), jump);
  ok('above the bubbles and cards it floats over', /z-index:\s*[3-9]/.test(jump), jump);
  ok('and cannot wrap or overflow a narrow pane',
    /white-space:\s*nowrap/.test(jump) && /max-width:\s*calc\(100%\s*-\s*24px\)/.test(jump), jump);
  ok('it is keyboard-reachable, not only hoverable',
    /\.hd-cv-jump:focus-visible\s*\{/.test(CSS_SRC), 'no focus style');
  ok('it has its own edge, so it reads as a chip over a bubble', /border:\s*1px solid var\(--bg\)/.test(jump), jump);

  // Contrast, computed rather than claimed. The palette is the source: --accent fills the pill and
  // --bg is both its text and the panel behind it, so both pairs matter (text legibility and the
  // 3:1 the guidelines ask of a UI control against its background).
  const varOf = (name) => {
    const m = STYLE_SRC.match(new RegExp('--' + name + '\\s*:\\s*(#[0-9a-fA-F]{6})'));
    return m ? m[1] : null;
  };
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const accent = varOf('accent'), bg = varOf('bg');
  ok('the palette still defines --accent and --bg as plain hex, so this can be computed',
    !!accent && !!bg, `${accent} / ${bg}`);
  const text = ratio(accent, bg), control = ratio(accent, varOf('bg-panel'));
  console.log(`     jump pill: text ${bg} on ${accent} = ${text.toFixed(2)}:1 · fill on the panel = ${control.toFixed(2)}:1`);
  ok('the pill\'s text clears the 4.5:1 body-text bar', text >= 4.5, `${text.toFixed(2)}:1`);
  ok('and the pill\'s fill clears the 3:1 control bar against the panel', control >= 3, `${control.toFixed(2)}:1`);
  ok('the pill really does use those two colours',
    /color:\s*var\(--bg\)/.test(jump) && /background:\s*var\(--accent\)/.test(jump), jump);

  const boxes = (CSS_SRC.match(/overscroll-behavior:\s*contain/g) || []).length;
  ok('every long-output region contains its own scroll (no chaining to the panel)', boxes >= 4, `${boxes} regions`);
  ok('and gives the dark theme a dark scrollbar, not an OS stripe',
    (CSS_SRC.match(/scrollbar-color:\s*var\(--line\)\s+transparent/g) || []).length >= 4,
    `${(CSS_SRC.match(/scrollbar-color/g) || []).length} scrollbar-color rules`);
  // A selector can have several rules (a shared one early, a tightening one later), so ask them all.
  ok('the helper above really reads rules, so the bound check cannot pass on an empty list',
    bodies('.hd-cv-res').length > 0 && bodies('.hd-cv-think-body').length > 0,
    `${bodies('.hd-cv-res').length} / ${bodies('.hd-cv-think-body').length} rules read`);
  ok('a long result, a long input, a long expansion and a long thinking body are all bounded',
    ['.hd-cv-res', '.hd-cv-json', '.hd-cv-body', '.hd-cv-think-body']
      .every((s) => bodies(s).some((b) => /max-height/.test(b))), 'a scroll region lost its bound');

  // Both halves matter: the dot has to reference the animation, and the keyframes it names have to
  // exist. Either one alone is a dead end — the dot silently stops moving, or names nothing.
  ok('the working tail actually pulses (the dot animates, and the keyframes it names exist)',
    /animation:\s*hd-cv-pulse\b/.test(rule('.hd-cv-dot')) && /@keyframes hd-cv-pulse\s*\{/.test(CSS_SRC),
    `dot: ${rule('.hd-cv-dot')}`);
  ok('the pulse is motion, so it is off under prefers-reduced-motion',
    /prefers-reduced-motion[^{]*\{[^}]*\.hd-cv-dot\s*\{[^}]*animation:\s*none/.test(CSS_SRC.replace(/\s+/g, ' ')),
    'no reduced-motion opt-out');
  ok('an interim segment is drawn as not-final (the same dashed language as a pending call)',
    /\.hd-cv-interim\s+\.hd-cv-bubble\s*\{[^}]*border-style:\s*dashed/.test(CSS_SRC), 'interim is not distinguished');
  ok('and the reply bubble carries the accent', /\.hd-cv-reply\s+\.hd-cv-bubble\s*\{[^}]*border-color:\s*var\(--accent\)/.test(CSS_SRC),
    'the reply is not marked');
  ok('a turn reads as one group by a spine, not by a heavy box',
    /\.hd-cv-turn-body\s*\{[^}]*border-left:\s*2px solid var\(--line-soft\)/.test(CSS_SRC), 'no spine');

  // round 7.3 — the live and the stale no-result states must be distinguishable in the sheet itself,
  // not only in the class names the renderer writes.
  ok('the live "waiting" state pulses in the working accent',
    /\.hd-cv-pending\s*\{[^}]*color:\s*var\(--st-working\)/.test(CSS_SRC)
      && /\.hd-cv-pending\s*\{[^}]*animation:\s*hd-cv-wait/.test(CSS_SRC), rule('.hd-cv-pending'));
  ok('the stale state declares no animation anywhere, so it cannot pulse',
    bodies('.hd-cv-stale').length > 0 && bodies('.hd-cv-stale').every((b) => !/animation\s*:/.test(b)),
    JSON.stringify(bodies('.hd-cv-stale')));
  ok('and it is the dim note colour, not the amber working accent',
    /color:\s*var\(--fg-dim\)/.test(rule('.hd-cv-stale')) && !/--st-working/.test(bodies('.hd-cv-stale').join(' ')),
    rule('.hd-cv-stale'));
  ok('and the stale card keeps the quiet hairline edge instead of the dashed in-flight one',
    /border-color:\s*var\(--line-soft\)/.test(rule('.hd-cv-stalecard'))
      && !/--st-working/.test(rule('.hd-cv-stalecard')), rule('.hd-cv-stalecard'));
  ok('the stale sentence is allowed to shrink and wrap, so it can neither widen the card nor run under the toggle',
    /min-width:\s*0/.test(rule('.hd-cv-stale')) && /white-space:\s*normal/.test(rule('.hd-cv-stale'))
      && /flex:\s*1 1 auto/.test(rule('.hd-cv-stale')), rule('.hd-cv-stale'));

  // round 7.4 (A2) — the fold. The rules the sheet has to carry are the ones the markup cannot say:
  // that the control is a real control, that the head is clickable too, and that a folded row is not a
  // running state (no pulse, no working accent — the amber is A1's "this is happening now").
  ok('the fold control is drawn as a control: a pointer, a hover and a keyboard focus ring',
    /\.hd-cv-foldbtn\s*\{[^}]*cursor:\s*pointer/.test(CSS_SRC)
      && /\.hd-cv-foldbtn:hover\s*\{/.test(CSS_SRC)
      // a ring that is actually drawn: `outline: none` / `outline: 0` is a focus style on paper only
      && /\.hd-cv-foldbtn:focus-visible\s*\{[^}]*outline:\s*(?!none\b)[1-9]/.test(CSS_SRC),
    rule('.hd-cv-foldbtn:focus-visible'));
  ok('the head row reads as clickable the way the button does',
    /\.hd-cv-meta\[data-hd-foldhead\]\s*\{[^}]*cursor:\s*pointer/.test(CSS_SRC),
    'the head carries no clickable affordance');
  ok('a folded row declares no animation anywhere, and borrows no working accent',
    bodies('.hd-cv-folded').length > 0
      && bodies('.hd-cv-folded').every((b) => !/animation\s*:/.test(b) && !/--st-working/.test(b)),
    JSON.stringify(bodies('.hd-cv-folded')));
  ok('a folded bubble is marked by the same hairline spine the expanded-body idiom uses',
    /\.hd-cv-folded \.hd-cv-bubble\s*\{[^}]*border-left:\s*2px solid var\(--line-soft\)/.test(CSS_SRC),
    bodies('.hd-cv-folded').join(' '));
  ok('the fold control is not a clipping preview — nothing of a message may be ellipsised away',
    !/\.hd-cv-foldbtn[^{]*\{[^}]*text-overflow/.test(CSS_SRC), 'the button clips its own label');
  ok('and the hidden counts are drawn in the plain dim note colour',
    /color:\s*var\(--fg-dim\)/.test(rule('.hd-cv-foldstat')), rule('.hd-cv-foldstat'));

  // round 7.5 (A3) — the state the reader set. The markup states it (id, aria-expanded, hd-cv-open);
  // the sheet has to make it mean something: a closed block is not drawn at all, an open one carries
  // the marker, and neither of them animates or borrows the working accent (the amber is A1's "this
  // is happening now", and an open block is a state, not an event).
  ok('a closed thinking body and a closed card body are not drawn (their [hidden] rules survive)',
    /\.hd-cv-think-body\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(CSS_SRC)
      && /\.hd-cv-card-body\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(CSS_SRC),
    'a closed block would still be laid out');
  ok('the open state of a thinking body and of a card body each have their own rule',
    bodies('.hd-cv-think-body.hd-cv-open').length > 0 && bodies('.hd-cv-card-body.hd-cv-open').length > 0,
    `${bodies('.hd-cv-think-body.hd-cv-open').length} / ${bodies('.hd-cv-card-body.hd-cv-open').length}`);
  ok('and neither open state animates or uses the working accent',
    ['.hd-cv-think-body.hd-cv-open', '.hd-cv-card-body.hd-cv-open']
      .every((s) => bodies(s).every((b) => !/animation\s*:/.test(b) && !/--st-working/.test(b))),
    JSON.stringify(bodies('.hd-cv-think-body.hd-cv-open').concat(bodies('.hd-cv-card-body.hd-cv-open'))));
  ok('the open marker cannot reflow the block it marks (it is a colour, not a size)',
    ['.hd-cv-think-body.hd-cv-open', '.hd-cv-card-body.hd-cv-open']
      .every((s) => bodies(s).every((b) => !/\b(width|padding|margin|font-size)/.test(b))),
    'the A3 state rule changes a box, so opening a block would move the row');
  ok('and the show-all block keeps the expanded-body idiom it had (spine, inner scroll)',
    bodies('.hd-cv-body.hd-cv-open').some((b) => /border-left:\s*2px solid var\(--line-soft\)/.test(b))
      && bodies('.hd-cv-resbox.hd-cv-open').some((b) => /max-height/.test(b)),
    JSON.stringify(bodies('.hd-cv-body.hd-cv-open')));

  // round 7.7 (§10) — the attachment chips. The markup states which of the three states a chip is in
  // (§10.9's data-state); the sheet has to make those three states three DIFFERENT things without
  // resizing the composer, and has to survive the name a reader's filesystem hands it. The computed
  // side of these claims is measured in a real engine in the §10 section at the end of this file;
  // what is checked here is only what no engine is needed for.
  ok('the chip row is bounded in both directions, so chips cannot grow the composer',
    /\.hd-cv-attach-list\s*\{[^}]*max-height/.test(CSS_SRC)
      && /\.hd-cv-attach-list\s*\{[^}]*max-width:\s*100%/.test(CSS_SRC)
      && /\.hd-cv-attach-list\s*\{[^}]*overflow-y:\s*auto/.test(CSS_SRC),
    rule('.hd-cv-attach-list'));
  ok('a chip may not exceed the row it is in, and its name may shrink below its own text (DEFECT-14)',
    /\.hd-cv-attach\s*\{[^}]*max-width:\s*100%/.test(CSS_SRC)
      && /\.hd-cv-attach-meta\s*\{[^}]*min-width:\s*0/.test(CSS_SRC)
      && /\.hd-cv-attach-meta\s*\{[^}]*text-overflow:\s*ellipsis/.test(CSS_SRC),
    rule('.hd-cv-attach-meta'));
  ok('the remove control has a hit area of its own, not the size of its glyph',
    /\.hd-cv-attach-remove\s*\{[^}]*min-width:\s*20px/.test(CSS_SRC)
      && /\.hd-cv-attach-remove\s*\{[^}]*min-height:\s*20px/.test(CSS_SRC),
    rule('.hd-cv-attach-remove'));
  ok('and a ring that is drawn, on :focus-visible like the sheet\'s other controls',
    /\.hd-cv-attach-remove:focus-visible\s*\{[^}]*outline:\s*(?!none\b)[1-9]/.test(CSS_SRC),
    rule('.hd-cv-attach-remove:focus-visible'));
  ok('the failed chip is marked by the blocked red AND by a shape, not by a shade of the ready grey',
    /\.hd-cv-attach\[data-state="failed"\]\s*\{[^}]*border-color:\s*var\(--st-blocked\)/.test(CSS_SRC)
      && /\.hd-cv-attach\[data-state="failed"\]\s*\{[^}]*box-shadow:\s*inset/.test(CSS_SRC)
      && !/--fg-dim/.test(rule('.hd-cv-attach[data-state="failed"]')),
    rule('.hd-cv-attach[data-state="failed"]'));
  ok('the failed marker cannot resize the chip (it is an inset shadow, not a wider border)',
    !/\bborder-width/.test(bodies('.hd-cv-attach').join(' ')),
    bodies('.hd-cv-attach').join(' '));
  ok('the uploading chip borrows the dashed in-flight edge in the working amber',
    /\.hd-cv-attach\[data-state="uploading"\]\s*\{[^}]*border-style:\s*dashed/.test(CSS_SRC)
      && /\.hd-cv-attach\[data-state="uploading"\]\s*\{[^}]*border-color:\s*var\(--st-working\)/.test(CSS_SRC),
    rule('.hd-cv-attach[data-state="uploading"]'));
  ok('and no chip state declares an animation, so none of them needs a pulse to be understood',
    bodies('.hd-cv-attach').every((b) => !/animation\s*:/.test(b))
      && bodies('.hd-cv-attach-list').every((b) => !/animation\s*:/.test(b)),
    JSON.stringify(bodies('.hd-cv-attach')));
  ok('no chip state is drawn with generated content (a chip\'s text stays the server\'s text)',
    !/\.hd-cv-attach[a-z-]*[^{]*\{[^}]*[;\s]content\s*:/.test(CSS_SRC), 'a content: declaration appeared');
  ok('the drop affordance is drawn with outline + background, so it cannot resize the composer',
    /\.hd-cv-drop-active\s*\{[^}]*outline:\s*2px dashed var\(--accent\)/.test(CSS_SRC)
      && /\.hd-cv-drop-active\s*\{[^}]*background-color:/.test(CSS_SRC)
      && !/\.hd-cv-drop-active\s*\{[^}]*(border-width|padding|margin|font-size)/.test(CSS_SRC),
    rule('.hd-cv-drop-active'));

  // Every class that animates must be switched off under prefers-reduced-motion — enforced over the
  // whole sheet, so a new animation (this state, or the next one) cannot ship without its opt-out.
  const rmLines = (CSS_SRC.match(/@media \(prefers-reduced-motion: reduce\)[^\n]*/g) || []).join('\n');
  const animating = [...CSS_SRC.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel, body]) => /\banimation\s*:\s*(?!none)/.test(body) && sel.trim().charAt(0) !== '@')
    .flatMap(([, sel]) => sel.match(/\.hd-cv-[a-z0-9-]+/g) || []);
  ok('the sheet really animates something, so the reduced-motion sweep is not vacuous',
    animating.length > 0, `${animating.length} animating selectors`);
  ok('every animating class in the sheet is switched off under prefers-reduced-motion',
    animating.every((c) => new RegExp(c.replace(/\./g, '\\.') + '[^{}]*\\{[^{}]*animation:\\s*none').test(rmLines)),
    `${[...new Set(animating)].join(', ')} | reduced-motion block: ${rmLines.replace(/\s+/g, ' ')}`);
}

// ══ DEFECT-14 — the width checks the defect would have failed ═══════════════

section('DEFECT-14 — nothing inside the chat scroll region may exceed its client width');
{
  /* WHY A LAYOUT MODEL AND NOT A BROWSER. The shim above has no layout, and DEFECT-14 is a layout
     defect: the numbers ARE the assertion. Pulling a browser into `node test/` would make the suite
     unrunnable where Chrome is missing, so this section carries a small model of the horizontal
     layout, written to the mechanism the defect actually had and nothing beyond it:

       definite     a child with `width: 100%` resolves against the container's content box. This is
                    the fix, and it is why the fix does not depend on how the panel displays the
                    scroller (both modes are run below).
       fit-content  an AUTO-width child of a COLUMN flex container that has auto cross-axis margins
                    (`margin: 0 auto`, exactly what .hd-cv-list carries) is sized as
                    max(min-content, min(max-content, available)) and only then clamped by max-width.
                    A ceiling over a box that has already been sized by its widest unbreakable child
                    is not a constraint: that is DEFECT-14, and the red check below re-creates it by
                    removing the single declaration the fix added.
       row          an item of a row flex container is min(max-content, its max-width, the row's
                    content box), floored by min-width: auto (= the content-based minimum, itself
                    capped by max-width) unless the stylesheet sets min-width: 0. A percentage
                    max-width resolves against the ROW — which is why "the bubble's max-width must be
                    relative to the container, not to a wider row".
       text         max-content = characters × CHAR_W. min-content = the longest run with no wrap
                    opportunity — one character when overflow-wrap: anywhere applies (the only value
                    that also shrinks min-content; break-word does not), the whole run otherwise. So
                    the model can see the difference .hd-cv-msg's `anywhere` makes.
       intrinsic    while a min-content size is being computed a percentage has no definite basis and
                    behaves as auto (CSS Sizing). The browser showed exactly this: the bubbles'
                    percentage ceilings did not stop a 1200-char run from reaching the column's own
                    980px ceiling, and 980 is precisely what the column measured.
       containment  a box with overflow other than visible contains its children's overflow, so the
                    children do not widen it (that is why a wide result inside .hd-cv-res is fine).

     WHAT THE MODEL DOES NOT DO, so a green run is not read as more than it is: vertical layout (this
     defect is horizontal), real font metrics (CHAR_W is an estimate, so a width here can be a few
     percent off a browser), non-auto margins, inline-level layout, percentages against anything but
     the immediate containing block, `!important`, and rules a @media would switch off. The browser is
     the reference for the live numbers (_scratch/w3/defect14-measure.mjs); this model exists so the
     same regression fails here, on every run, without a browser. */

  const CHAR_W = 7.2;              // one character at this sheet's 12px UI/mono sizes, generously

  // ── reading the stylesheet ─────────────────────────────────────────────────
  const CSS_CODE = CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, ' ');   // comments carry colons; selectors don't
  const RULES = (() => {
    const out = [], re = /([^{}]+)\{([^{}]*)\}/g; let m;
    while ((m = re.exec(CSS_CODE))) {
      const sel = m[1].trim();
      if (!sel || sel.charAt(0) === '@') continue;      // an @media/@keyframes header, not a selector
      out.push([sel, m[2]]);
    }
    return out;
  })();
  const classesOf = (n) => String(n.className || '').split(/\s+/).filter(Boolean);
  /** One compound selector: '.a.b', 'div', '*', '[hidden]'. A pseudo-class never matches a static
   *  tree (the model has no states), and a construct it does not understand never matches either —
   *  which is why a @keyframes frame ("0%, 100%") silently applies to nothing. */
  function compoundMatches(n, tok) {
    if (tok === '*') return true;
    let rest = tok, needHidden = false;
    if (rest.indexOf('[hidden]') >= 0) { needHidden = true; rest = rest.replace(/\[hidden\]/g, ''); }
    if (needHidden && !n.hidden) return false;
    if (!rest) return needHidden;
    if (rest.charAt(0) === '.') return rest.split('.').filter(Boolean).every((c) => classesOf(n).indexOf(c) >= 0);
    if (/^[a-z][a-z0-9]*$/i.test(rest)) return String(n.tagName || '').toLowerCase() === rest.toLowerCase();
    return false;
  }
  function selMatches(node, sel) {
    return sel.split(',').some((raw) => {
      const part = raw.trim();
      if (!part || /:/.test(part)) return false;         // hover/focus-visible/::before — a state
      const chain = [];
      for (const t of part.split(/\s+/).filter(Boolean)) {
        if (t === '>') { if (chain.length) chain[chain.length - 1].child = true; continue; }
        chain.push({ sel: t, child: false });
      }
      if (!chain.length || !compoundMatches(node, chain[chain.length - 1].sel)) return false;
      let i = chain.length - 1, cur = node.parentNode;
      while (i > 0) {
        const want = chain[i - 1];
        if (want.child) {
          if (!cur || !compoundMatches(cur, want.sel)) return false;
          i--; cur = cur.parentNode; continue;
        }
        let p = cur, hit = false;
        while (p) { if (compoundMatches(p, want.sel)) { hit = true; cur = p.parentNode; i--; break; } p = p.parentNode; }
        if (!hit) return false;
      }
      return true;
    });
  }
  /** Every declaration this node has, from the real stylesheet, plus the test's own overrides (the
   *  red check below uses those to put a pre-fix declaration back). `overrides` is keyed by class. */
  function declsOf(node, overrides) {
    const out = {};
    for (const [sel, body] of RULES) {
      if (!selMatches(node, sel)) continue;
      for (const d of body.split(';')) {
        const i = d.indexOf(':');
        if (i < 0) continue;
        const k = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).replace(/!important/g, '').trim();
        if (k && v) out[k] = v;
      }
    }
    for (const c of classesOf(node)) if (overrides && overrides[c]) Object.assign(out, overrides[c]);
    // the shorthands the widths read (style.css sets box-sizing: border-box on *, so a width here is
    // the border box, exactly as the browser reported it)
    if (out.margin) { const p = box4(out.margin); out['margin-left'] = p[1]; out['margin-right'] = p[3]; }
    if (out.padding) { const p = box4(out.padding); out['padding-left'] = p[1]; out['padding-right'] = p[3]; }
    if (out.border) { out['border-left'] = out.border; out['border-right'] = out.border; }
    return out;
  }
  function box4(v) {
    const p = String(v).split(/\s+/);
    if (p.length === 1) return [p[0], p[0], p[0], p[0]];
    if (p.length === 2) return [p[0], p[1], p[0], p[1]];
    if (p.length === 3) return [p[0], p[1], p[2], p[1]];
    return [p[0], p[1], p[2], p[3]];
  }
  const pxOf = (v) => { const m = /^(-?[\d.]+)px$/.exec(String(v == null ? '' : v).trim()); return m ? Number(m[1]) : 0; };
  /** A length, in px: `Npx`, `N%` of `basis`, `min(a, b)`, `calc(100% - 24px)`. null means "no size
   *  from this property" (auto/none/inherit). In the `intrinsic` pass a percentage has no definite
   *  basis, so any expression containing one resolves to null — see the header. */
  function len(v, basis, intrinsic) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s === 'auto' || s === 'none' || s === 'normal' || s === 'inherit') return null;
    if (intrinsic && s.indexOf('%') >= 0) return null;
    const mmin = /^min\(([^)]*)\)$/.exec(s);
    if (mmin) {
      const parts = mmin[1].split(',').map((p) => len(p, basis, intrinsic)).filter((x) => x !== null);
      return parts.length ? Math.min.apply(null, parts) : null;
    }
    const mcalc = /^calc\(([^)]*)\)$/.exec(s);
    if (mcalc) {
      const bits = mcalc[1].split(/\s*([+-])\s*/);
      let acc = len(bits[0], basis, intrinsic);
      for (let i = 1; i < bits.length; i += 2) {
        const n = len(bits[i + 1], basis, intrinsic);
        if (acc === null || n === null) return null;
        acc = bits[i] === '+' ? acc + n : acc - n;
      }
      return acc;
    }
    if (/%$/.test(s)) return (parseFloat(s) / 100) * basis;
    const mnum = /^(-?[\d.]+)(px)?$/.exec(s);
    return mnum ? Number(mnum[1]) : null;
  }
  const gapOf = (d) => pxOf(d.gap);
  const isRow = (d) => d.display === 'flex' && (d['flex-direction'] || 'row') === 'row';
  const hiddenBy = (d, node) => d.display === 'none' || node.hidden === true || classesOf(node).indexOf('hidden') >= 0;

  // ── text ───────────────────────────────────────────────────────────────────
  const longestRun = (text, ws) => {
    let best = 0;
    const lines = /^pre/.test(ws) ? String(text).split('\n') : [String(text)];
    for (const line of lines) for (const run of line.split(/[\s ]+/)) best = Math.max(best, run.length);
    return best;
  };
  const longestLine = (text, ws) => {
    const lines = /^pre/.test(ws) ? String(text).split('\n') : [String(text).replace(/\s+/g, ' ')];
    return lines.reduce((m, l) => Math.max(m, l.length), 0);
  };
  const canBreakAnywhere = (ctx) => ctx.wrap === 'anywhere' || ctx.wrap === 'break-all'
    || ctx.wordBreak === 'break-all' || ctx.wordBreak === 'break-word';
  function textIntrinsic(text, ctx) {
    const t = String(text);
    if (!t) return { max: 0, min: 0 };
    const max = longestLine(t, ctx.ws) * CHAR_W;
    if (ctx.ws === 'nowrap' || ctx.ws === 'pre') return { max, min: max };
    const min = canBreakAnywhere(ctx) ? CHAR_W : longestRun(t, ctx.ws) * CHAR_W;
    return { max, min };
  }
  /** What this text's line box needs once it is wrapped into `box` px. */
  function textWrapped(text, ctx, box) {
    const t = String(text);
    if (!t) return 0;
    const mx = longestLine(t, ctx.ws) * CHAR_W;
    if (ctx.ws === 'nowrap' || ctx.ws === 'pre') return mx;
    if (canBreakAnywhere(ctx)) return Math.max(CHAR_W, Math.min(mx, box));
    return Math.min(mx, Math.max(box, longestRun(t, ctx.ws) * CHAR_W));
  }
  const ctxFor = (parent, d) => ({
    wrap: d['overflow-wrap'] || parent.wrap,
    wordBreak: d['word-break'] || parent.wordBreak,
    ws: d['white-space'] || parent.ws,
    overrides: parent.overrides,
  });
  const ROOT_CTX = (overrides) => ({ wrap: 'normal', wordBreak: 'normal', ws: 'normal', overrides: overrides || {} });
  /** The inherited text context AT a node: walk down from the root applying each element's own
   *  declarations. This is how the checks know whether a token can break where it is drawn — and it
   *  is the property the fix relies on (one `overflow-wrap` on .hd-cv-msg reaches every path). */
  function ctxOf(node, overrides) {
    const chain = [];
    for (let n = node; n; n = n.parentNode) chain.unshift(n);
    let ctx = ROOT_CTX(overrides);
    for (const n of chain) if (n.nodeType === 1) ctx = ctxFor(ctx, declsOf(n, ctx.overrides));
    return ctx;
  }

  // ── intrinsic sizes: what a box's content wants, before any container decides ──
  function intrinsicOf(node, ctx) {
    if (node.nodeType === 3) return textIntrinsic(node.textContent, ctx);
    const d = declsOf(node, ctx.overrides);
    if (hiddenBy(d, node)) return { max: 0, min: 0 };
    const cctx = ctxFor(ctx, d);
    const kids = node.children || [];
    let max = 0, min = 0;
    if (node._text != null) {
      // the shim's shorthand: a string child kept as `_text` is one anonymous text run, exactly the
      // way the DOM would hold it (and `textContent` already reads only that)
      const t = textIntrinsic(node._text, cctx);
      max = t.max; min = t.min;
    } else if (isRow(d)) {
      for (const k of kids) { const r = intrinsicOf(k, cctx); max += r.max; min += r.min; }
      const g = gapOf(d) * Math.max(0, kids.length - 1);
      max += g; min += g;
    } else {
      for (const k of kids) { const r = intrinsicOf(k, cctx); max = Math.max(max, r.max); min = Math.max(min, r.min); }
    }
    max += pxOf(d['padding-left']) + pxOf(d['padding-right']) + pxOf(d['border-left']) + pxOf(d['border-right']);
    min += pxOf(d['padding-left']) + pxOf(d['padding-right']) + pxOf(d['border-left']) + pxOf(d['border-right']);
    const mx = len(d['max-width'], 0, true);             // percentages: no basis while sizing intrinsically
    if (mx !== null) { max = Math.min(max, mx); min = Math.min(min, mx); }
    return { max, min };
  }

  // ── the layout pass ────────────────────────────────────────────────────────
  /* Coordinates are px, x=0 at the scroll container's client-area left edge — the same origin the
     browser check uses (scroll.getBoundingClientRect().left), so a `right` here is directly
     comparable to `scroll.clientWidth`. Vertical geometry is not modelled at all. */
  const marginsOf = (d) => {
    const ml = d['margin-left'], mr = d['margin-right'];
    return { l: /auto/.test(ml || '') ? 0 : pxOf(ml), r: /auto/.test(mr || '') ? 0 : pxOf(mr),
      auto: /auto/.test(ml || '') || /auto/.test(mr || '') };
  };
  const inlineish = (node, d) => String(node.tagName) === 'BUTTON' || d.display === 'inline-block';

  function measure(scroll, opts) {
    const overrides = opts.overrides || {};
    const boxes = new Map();
    const d0 = declsOf(scroll, overrides);
    const padL = pxOf(d0['padding-left']), padR = pxOf(d0['padding-right']);
    const clientWidth = opts.clientWidth;
    const contentWidth = clientWidth - padL - padR;
    // the scroll box's own CLIENT box (x=0, its client width): layChildren takes off its padding
    const info = { left: 0, width: clientWidth, display: opts.display || d0.display || 'block',
      dir: opts.dir || d0['flex-direction'] || 'row', isRow: false, ctx: ctxFor(ROOT_CTX(overrides), d0) };
    layChildren(scroll, info, d0);
    const els = [];
    walk(scroll, (n) => { const b = boxes.get(n); if (n !== scroll && b && !b.isText) els.push(b); });
    const escapes = els.filter((b) => b.right > clientWidth + 1);
    const overflowing = els.filter((b) => b.overflowing && !b.contained && !b.ellipsis);
    return { clientWidth, contentWidth, listWidth: (boxes.get(opts.listEl) || {}).width, boxes, els, escapes, overflowing };

    /** The width one child gets, plus the flex numbers the row algorithm needs. */
    function widthOf(node, ctx, cbWidth, parentIsRow, pinfo) {
      const d = declsOf(node, ctx.overrides);
      const mg = marginsOf(d);
      const avail = Math.max(0, cbWidth - mg.l - mg.r);
      const mx = len(d['max-width'], cbWidth, false);
      const mn = len(d['min-width'], cbWidth, false);
      const wDef = len(d['width'], cbWidth, false);
      const intr = intrinsicOf(node, ctx);
      const maxW = mx === null ? Infinity : mx;
      const floor = mn !== null ? mn : (parentIsRow ? Math.min(intr.min, maxW) : 0);
      const columnFlex = pinfo.display === 'flex' && pinfo.dir === 'column';
      let w;
      if (wDef !== null) w = wDef;
      else if (parentIsRow) w = Math.min(intr.max, maxW);
      else if (columnFlex && (mg.auto || (d['align-self'] && d['align-self'] !== 'stretch')))
        w = Math.max(intr.min, Math.min(avail, intr.max));      // fit-content — the DEFECT-14 path
      else if (!columnFlex && inlineish(node, d)) w = Math.min(intr.max, maxW);   // shrinks to its content
      else w = avail;                                           // block or stretched flex item: fills
      w = Math.max(w, floor);
      if (mx !== null) w = Math.min(w, maxW);                    // max-width wins over min-width, as in CSS
      let flex = null;
      if (d.flex) {
        const p = d.flex.split(/\s+/);
        flex = { grow: parseFloat(p[0]) || 0, shrink: p[1] === undefined ? 1 : (parseFloat(p[1]) || 0) };
      }
      return { w: Math.max(0, w), floor, max: maxW, flex, mg };
    }

    /** Lay out `parent`'s children inside `pinfo` (its content box, and how it displays). */
    function layChildren(parent, pinfo, pd) {
      const kids = (parent.children || []).filter((k) => k.nodeType === 1 || k.nodeType === 3);
      const cctx = ctxFor(pinfo.ctx, pd);
      const borderL = pxOf(pd['border-left']), borderR = pxOf(pd['border-right']);
      const contentLeft = pinfo.left + borderL + pxOf(pd['padding-left']);
      const contentBox = Math.max(0, pinfo.width - borderL - borderR
        - pxOf(pd['padding-left']) - pxOf(pd['padding-right']));
      const row = pinfo.isRow;
      const items = [];
      for (const k of kids) {
        if (k.nodeType === 3) {
          items.push({ node: k, w: textWrapped(k.textContent, cctx, contentBox), isText: true, mg: { l: 0, auto: false } });
          continue;
        }
        const kd = declsOf(k, cctx.overrides);
        if (hiddenBy(kd, k)) continue;
        items.push(Object.assign({ node: k, isText: false, d: kd }, widthOf(k, cctx, contentBox, row, pinfo)));
      }
      const gap = gapOf(pd);
      const g = row ? gap * Math.max(0, items.length - 1) : 0;
      if (row && items.length) {
        const free = contentBox - (items.reduce((s, it) => s + it.w, 0) + g);
        if (free > 0) {
          const growers = items.filter((it) => it.flex && it.flex.grow > 0);
          for (const it of growers) it.w = Math.min(it.w + free / growers.length, it.max);
        } else if (free < 0) {
          const shrinkables = items.filter((it) => it.flex && it.flex.shrink > 0 && it.w > it.floor);
          const weight = shrinkables.reduce((s, it) => s + it.w * it.flex.shrink, 0);
          for (const it of shrinkables) it.w = Math.max(it.floor, it.w - ((-free) * it.w * it.flex.shrink) / (weight || 1));
        }
      }
      const total = items.reduce((s, it) => s + it.w, 0) + g;
      const justify = pd['justify-content'] || 'flex-start';
      let x = contentLeft + (row && justify === 'flex-end' ? Math.max(0, contentBox - total)
        : row && justify === 'center' ? Math.max(0, contentBox - total) / 2 : 0);
      for (const it of items) {
        let left = (row ? x : contentLeft) + it.mg.l;   // a column/block stack restarts at its content edge
        if (!row) {
          const align = it.isText ? '' : (it.d['align-self'] || '');
          if (it.mg.auto || align === 'center') left = contentLeft + Math.max(0, (contentBox - it.w) / 2);
          else if (align === 'flex-end') left = contentLeft + contentBox - it.w;
        }
        if (it.isText) {
          boxes.set(it.node, { left, width: it.w, right: left + it.w, clientWidth: it.w, scrollWidth: it.w,
            contained: true, overflowX: 'visible', ellipsis: false, overflowing: false, isText: true,
            extent: left + it.w, tag: '#text', cls: '' });
        } else {
          lay(it.node, { left, width: it.w, ctx: cctx }, it.d);
        }
        x = left + it.w + (row ? gap : 0);
      }
    }

    /** Measure one element and recurse into it. */
    function lay(node, cb, d) {
      const borderL = pxOf(d['border-left']), borderR = pxOf(d['border-right']);
      const box = { left: cb.left, width: cb.width, right: cb.left + cb.width, tag: node.tagName || '?',
        cls: String(node.className || ''), isText: false,
        clientWidth: Math.max(0, cb.width - borderL - borderR) };
      const ov = d.overflow || 'visible', ovx = d['overflow-x'] || ov, ovy = d['overflow-y'] || ov;
      box.overflowX = ovx;
      box.contained = ovx !== 'visible' || ovy !== 'visible';
      box.ellipsis = d['text-overflow'] === 'ellipsis';
      boxes.set(node, box);
      const contentLeft = cb.left + borderL + pxOf(d['padding-left']);
      const contentBox = Math.max(0, cb.width - borderL - borderR
        - pxOf(d['padding-left']) - pxOf(d['padding-right']));
      // a shim element whose content is a plain string (`el(tag, cls, text)`) is one anonymous text
      // run in a browser, so it is measured as one and holds no element children of its own
      let ext = box.right;
      if (node._text != null) {
        ext = Math.max(ext, contentLeft + textWrapped(node._text, ctxFor(cb.ctx, d), contentBox));
      } else {
        layChildren(node, { left: cb.left, width: cb.width, display: d.display || 'block',
          dir: d['flex-direction'] || 'row', isRow: isRow(d), ctx: cb.ctx }, d);
        // what the box's own content needs: children's boxes, extended by any child that is not
        // itself a scroll container, so an overflowing line is attributed to the element it is in
        for (const c of (node.children || [])) {
          const b = boxes.get(c);
          if (b) ext = Math.max(ext, b.extent === undefined ? b.right : b.extent);
        }
      }
      box.scrollWidth = Math.max(box.clientWidth, ext - (cb.left + borderL));
      box.overflowing = box.scrollWidth > box.clientWidth + 1;
      box.extent = box.contained ? box.right : Math.max(box.right, ext);
    }
  }

  // ── the fixture: the shape of the live page, with the user's own situation in it ──
  const USER_TEXT = ('reply with exactly this one line: CHAT-OK-71, and before that please restructure the '
    + 'chat view so that my own prompt is never clipped at the right edge of the panel: check the long tool '
    + 'results and the thinking blocks for the same problem, then tell me what you changed and how you '
    + 'measured it').padEnd(400, ' x').slice(0, 400);
  const ASSIST_TEXT = ('I fixed it at the list element: a max-width alone does not constrain an item with auto '
    + 'cross-axis margins, so the column was laid out at its fit-content width and its right-aligned bubble '
    + 'hung off the scroll viewport; width:100% makes the size definite and the bubble wraps inside the '
    + 'visible area now').padEnd(400, ' y').slice(0, 400);
  const TOKEN_TEXT = 'z'.repeat(240);          // one unbreakable run: the min-content driver
  const SYS_TEXT = 'q'.repeat(400);            // the same, on the path a system note is drawn through
  const HOSTILE_INPUT = '{"command": "' + 'c'.repeat(200) + '"}';   // a tool summary that cannot fit one line
  // round 7.4 (A2): the folded form is a DIFFERENT subtree from the one DEFECT-14 was measured on, and
  // the first line here is over SUMMARY_MAX so the preview is clipped as well. It is 25 lines long, so
  // its unfolded form would take the "show all" path — which is exactly why the clamp check below is
  // meaningful for the folded case: while folded there is no clamp control at all (A2.7).
  const FOLD_LINE = ('a folded preview line ' + 'F'.repeat(200)).slice(0, 200);

  const turn = CR.renderTurn(TURN({
    user: MSG({ key: 'd1', role: 'user', kind: 'text', text: USER_TEXT }),
    segments: [
      MSG({ key: 'd2', kind: 'thinking', text: 'a note the reader can expand' }),
      CALL({ name: 'Bash', call_key: 'd3', input: HOSTILE_INPUT, result: 'ok' }, { key: 'd3' }),
      MSG({ key: 'd4', kind: 'system', text: SYS_TEXT }),
      MSG({ key: 'd5', kind: 'text', text: ASSIST_TEXT }),
    ],
  }, { expandTools: true }));   // the expanded card is the "long input / long result" case
  const loose = listRoot([
    MSG({ key: 'd6', role: 'user', kind: 'text', text: TOKEN_TEXT }),
    RESULT({ name: 'Bash', call_key: 'd7', result: 'unpaired result' }, { key: 'd7' }),
    // round 7.3: both no-result states, in the same row the width checks walk. The stale label is a
    // 90-character sentence inside a card HEAD — a fixed-width flex item in a row is exactly the
    // shape that widened this column before, so it is measured here rather than assumed safe.
    CALL({ name: 'Bash', call_key: 'd8', pending: true, pending_reason: 'not_in_window',
      input: HOSTILE_INPUT }, { key: 'd8' }),
    CALL({ name: 'Bash', call_key: 'd9', pending: true, pending_reason: 'awaiting' }, { key: 'd9' }),
    // round 7.4 (A2): a FOLDED 25-line assistant text bubble, in the same row the width checks walk
    MSG({ key: 'd10', kind: 'text', role: 'assistant', text: FOLD_LINE + '\n' + lines(24, 'g') }),
  ], { foldedKeys: { d10: true } }).box;

  // the wrappers are W2's (§8.4: #hdChatScroll > #hdChatList, the state block and the jump pill inside
  // them) — the renderer returns a fragment, the panel is what gives it a width. Built here so the
  // measurement is of the real chain and not of a friendlier one.
  const sc = doc.createElement('div'); sc.className = 'hd-cv-scroll chat-scroll'; sc.id = 'hdChatScroll';
  const li = doc.createElement('div'); li.className = 'hd-cv-list chat-list'; li.id = 'hdChatList';
  const st = doc.createElement('div'); st.className = 'hd-cv-empty chat-state'; st.id = 'hdChatState';
  st.appendChild(doc.createTextNode('q'.repeat(300)));            // a hostile server message in the state block
  const jump = doc.createElement('button'); jump.className = 'hd-cv-jump chat-jump'; jump.id = 'hdChatJump';
  jump.appendChild(doc.createTextNode('3 new ↓'));
  sc.appendChild(li); sc.appendChild(jump);
  li.appendChild(st); li.appendChild(turn); li.appendChild(loose);

  const CLIENT_W = 937;          // the user's own measurement: a 980px list inside a 937px client area
  const container = (display, overrides, dir) => measure(sc, {
    clientWidth: CLIENT_W, display: display, dir: dir || 'column', listEl: li, overrides: overrides,
  });
  const live = container('flex');                                  // W2's fallback: a column flex box
  const blocked = container('block');                              // ...and the same sheet as a block box
  const preFix = container('flex', { 'hd-cv-list': { width: 'auto' } });   // the pre-fix declaration

  const userBubble = one(one(sc, 'hd-cv-role-user'), 'hd-cv-bubble');
  const replyBubble = one(one(sc, 'hd-cv-reply'), 'hd-cv-bubble');
  const tokenBubble = one(loose, 'hd-cv-bubble');
  const sysNote = one(turn, 'hd-cv-sys');
  const boxOf = (node) => live.boxes.get(node) || {};
  const widest = (m) => Math.max(0, ...m.els.map((b) => b.right));
  /** a box's or node's name, for a readable failure message */
  const label = (b) => String((b && (b.cls || b.className)) || (b && (b.tag || b.tagName)) || '?')
    .split(/\s+/).slice(0, 2).join('.');

  // the fixture's own guards: without these the checks below could pass on a fixture that never
  // entered the path DEFECT-14 lived on, or on a model that read no rules at all
  ok('the fixture holds the exact texts the checks compare (a 400-char prompt, a 400-char reply)',
    USER_TEXT.length === 400 && ASSIST_TEXT.length === 400, `${USER_TEXT.length} / ${ASSIST_TEXT.length}`);
  ok('and the unbreakable tokens really are unbreakable (no space to wrap at)',
    /^\S+$/.test(TOKEN_TEXT) && /^\S+$/.test(SYS_TEXT) && TOKEN_TEXT.length === 240,
    `${TOKEN_TEXT.length} chars, contains whitespace: ${/\s/.test(TOKEN_TEXT)}`);
  ok('the model reads the real stylesheet: it found the sheet\'s rules and the fix\'s declarations',
    RULES.length > 40 && declsOf(li, {}).width === '100%' && declsOf(li, {})['min-width'] === '0'
      && declsOf(userBubble, {})['max-width'] === 'min(780px, 88%)',
    `${RULES.length} rules read; .hd-cv-list ${JSON.stringify(declsOf(li, {}))}`);
  ok('and a row item is allowed to shrink: the summary sets min-width:0 and clips itself, the bubble ' +
    'leaves its floor to its own min-content (one character, because overflow-wrap:anywhere shrinks it)',
    declsOf(one(sc, 'hd-cv-sum'), {})['min-width'] === '0'
      && declsOf(one(sc, 'hd-cv-sum'), {})['overflow'] === 'hidden'
      && ctxOf(userBubble).wrap === 'anywhere',
    JSON.stringify({ sumMinWidth: declsOf(one(sc, 'hd-cv-sum'), {})['min-width'],
      bubbleWrap: ctxOf(userBubble).wrap }));
  console.log(`     list ${preFix.listWidth}px → ${live.listWidth}px in a ${CLIENT_W}px client box · ` +
    `escapes ${preFix.escapes.length} → ${live.escapes.length} · widest right ${widest(preFix).toFixed(0)} → ${widest(live).toFixed(0)}`);

  ok('the model reproduces DEFECT-14 with the fix removed (a list at its 980px ceiling in a 937px box, ' +
    'and the user\'s own bubble outside the visible area) — this is the check that would have caught it',
    preFix.listWidth === 980 && preFix.escapes.length > 0
      && (preFix.boxes.get(userBubble) || {}).right > CLIENT_W + 1,
    JSON.stringify({ listWidth: preFix.listWidth, escapes: preFix.escapes.length,
      userBubbleRight: (preFix.boxes.get(userBubble) || {}).right, clientWidth: CLIENT_W }));

  ok('with the stylesheet as it stands the list is laid out inside the client box (no 980px column)',
    live.listWidth === CLIENT_W - 24 && live.escapes.length === 0,
    `list ${live.listWidth}, escapes ${live.escapes.length} (${live.escapes.map((b) => label(b)).join(' | ')})`);
  eq('the model took the container\'s own padding from the sheet (12px a side, so 24px less to lay out in)',
    live.contentWidth, CLIENT_W - 24);

  // (a) the bubble's own content never spills sideways, and its right edge stays in the client area
  const wide = [[boxOf(userBubble), USER_TEXT, 'the user\'s own 400-char prompt', userBubble],
    [boxOf(replyBubble), ASSIST_TEXT, 'the 400-char assistant reply', replyBubble]];
  for (const [b, text, what, node] of wide) {
    const drawn = String(node.textContent);
    ok(`nothing of ${what} is clipped horizontally (scrollWidth <= clientWidth)`,
      b.scrollWidth !== undefined && b.scrollWidth <= b.clientWidth + 1,
      `scrollWidth ${b.scrollWidth} > clientWidth ${b.clientWidth}`);
    ok(`and its right edge is inside the scroll container's client area (+1px)`,
      b.right !== undefined && b.right <= CLIENT_W + 1,
      `right ${b.right} vs clientWidth ${CLIENT_W}`);
    ok(`it is drawn at a width that needs wrapping, so "not clipped" is not "too small to clip"`,
      b.width > 200 && b.width < CLIENT_W, `width ${b.width}`);
    ok(`the whole text is still in the DOM, verbatim (not ellipsised out, not parked in a title)`,
      drawn === text || drawn.indexOf(text) >= 0,
      `the bubble carries ${drawn.length} chars, ${text.length} were passed in: "${drawn.slice(0, 30)}…"`);
  }
  ok('the 240-char unbreakable token breaks rather than overflowing its bubble (the other half of the fix)',
    (boxOf(tokenBubble).scrollWidth || 0) <= (boxOf(tokenBubble).clientWidth || 0) + 1,
    `scrollWidth ${boxOf(tokenBubble).scrollWidth} vs clientWidth ${boxOf(tokenBubble).clientWidth}`);
  ok('a system note drawn outside any bubble breaks too (that path had no wrapping at all before the fix)',
    (boxOf(sysNote).scrollWidth || 0) <= (boxOf(sysNote).clientWidth || 0) + 1,
    `scrollWidth ${boxOf(sysNote).scrollWidth} vs clientWidth ${boxOf(sysNote).clientWidth}`);

  // round 7.3: the "not in the loaded window" sentence is a 90-character FIXED string in a card HEAD,
  // i.e. the same shape as everything DEFECT-14 was made of — a long unbreakable item in a row. It is
  // measured here so the new state cannot be the next thing that widens the column.
  // `one()` rather than `byClass(...)[0]`: if a mutation removes the node, these must FAIL and let the
  // rest of the section run, not throw and hide every assertion after them.
  const staleLabel = one(loose, 'hd-cv-stale');
  const stalePulse = one(loose, 'hd-cv-pending');
  const staleCard = staleLabel.parentNode && staleLabel.parentNode.parentNode;
  ok('the fixture really drew both no-result states (so the checks below are not vacuous)',
    byClass(loose, 'hd-cv-stale').length === 1 && byClass(loose, 'hd-cv-pending').length === 1,
    `stale label x${byClass(loose, 'hd-cv-stale').length}, awaiting span x${byClass(loose, 'hd-cv-pending').length}`);
  ok('the not-in-window sentence wraps inside its card (nothing clipped, nothing escaping)',
    (boxOf(staleLabel).scrollWidth || 0) <= (boxOf(staleLabel).clientWidth || 0) + 1
      && (boxOf(staleLabel).right || 0) <= CLIENT_W + 1
      && String(staleLabel.textContent).indexOf('loaded window') >= 0,
    JSON.stringify(Object.assign(boxOf(staleLabel), { text: String(staleLabel.textContent).slice(0, 40) })));
  ok('and it really was narrowed by the layout: its box is smaller than the sentence\'s own max-content',
    (boxOf(staleLabel).width || 0) > 0 && (boxOf(staleLabel).width || 0) < String(staleLabel.textContent).length * CHAR_W,
    `width ${boxOf(staleLabel).width} vs the text's ${String(staleLabel.textContent).length * CHAR_W}px max-content`);
  ok('and the card holding it is bounded by the list, not by the sentence',
    !!staleCard && (boxOf(staleCard).right || 0) <= CLIENT_W + 1,
    staleCard ? JSON.stringify(boxOf(staleCard)) : '(no card: no stale node was rendered)');

  // round 7.4 (A2): the folded subtree, measured like everything else in this section. A folded row
  // is a different shape from the ones DEFECT-14 was made of (a clipped 160-char preview plus a count
  // line, inside the bubble, with a new control in the head), so it is walked rather than assumed.
  const d10 = byClass(loose, 'hd-cv-msg').filter((n) => n.getAttribute('data-key') === 'd10')[0] || loose;
  const foldStat = one(d10, 'hd-cv-foldstat');
  const foldPreview = one(d10, 'hd-cv-p');
  const foldBtn = one(d10, 'hd-cv-foldbtn');
  ok('the fixture really drew a folded bubble with a control in its head (so the A2 checks are not vacuous)',
    byClass(loose, 'hd-cv-folded').length === 1 && byClass(d10, 'hd-cv-foldbtn').length === 1
      && String(foldStat.textContent).indexOf('lines hidden') >= 0
      && String(foldPreview.textContent).length === T.SUMMARY_MAX,
    `folded ${byClass(loose, 'hd-cv-folded').length}, controls ${byClass(d10, 'hd-cv-foldbtn').length}, ` +
    `preview ${String(foldPreview.textContent).length} chars`);
  ok('the folded preview and its counts wrap inside the bubble instead of widening the row',
    (boxOf(foldStat).scrollWidth || 0) <= (boxOf(foldStat).clientWidth || 0) + 1
      && (boxOf(foldStat).right || 0) <= CLIENT_W + 1
      && (boxOf(foldPreview).scrollWidth || 0) <= (boxOf(foldPreview).clientWidth || 0) + 1
      && (boxOf(foldPreview).right || 0) <= CLIENT_W + 1,
    JSON.stringify({ stat: boxOf(foldStat), preview: boxOf(foldPreview) }));
  ok('the fold control is measured in the head row and stays inside the client area',
    (boxOf(foldBtn).width || 0) > 0 && (boxOf(foldBtn).right || 0) <= CLIENT_W + 1,
    JSON.stringify(boxOf(foldBtn)));
  ok('and the fold control is not a box that clips its own label',
    boxOf(foldBtn).overflowing !== true && boxOf(foldBtn).ellipsis !== true,
    JSON.stringify({ overflowing: boxOf(foldBtn).overflowing, ellipsis: boxOf(foldBtn).ellipsis }));

  // (b) nothing anywhere inside the scroll region reaches past the client area — checked on every
  // element the fixture produced, W2's own nodes included
  ok('no element inside the scroll region has a right edge beyond the client area (+1px)',
    live.escapes.length === 0,
    live.escapes.map((b) => `${label(b)} at ${b.right.toFixed(1)} > ${CLIENT_W + 1}`).join(' | '));
  ok(`every element the fixture produced was actually measured (not skipped by the model)`,
    live.els.length > 25, `${live.els.length} boxes`);
  /* A box may hold content wider than itself, but only if the stylesheet DECLARES how that is
     contained AND the box is one this view is allowed to clip: the tool card's one-line summary, a
     nowrap ellipsised PREVIEW whose full text sits in the expandable JSON right beside it, with the
     counts stated. An allow-list by name, not by property: "it has an ellipsis" must never be enough
     for the user's own prompt to be clipped. */
  const ALLOWED_PREVIEWS = ['hd-cv-sum'];
  const previews = live.els.filter((b) => b.overflowing && b.contained);
  const uncontained = (m) => m.els.filter((b) => b.overflowing && !b.contained);
  eq('nothing has content wider than its own box with no declaration containing it (live display)',
    uncontained(live).map((b) => `${label(b)} ${b.scrollWidth}>${b.clientWidth} (overflow ${b.overflowX})`), []);
  eq('and the same holds with the scroller as a plain block box',
    uncontained(blocked).map((b) => `${label(b)} ${b.scrollWidth}>${b.clientWidth}`), []);
  eq('the only boxes that clip their content by declaration are the tool summaries',
    Array.from(new Set(previews.map((b) => label(b)))), ALLOWED_PREVIEWS);

  // the same must hold however the panel displays the scroller: a definite width is not display-specific
  ok('the checks hold with the scroller as a column flex box (the panel\'s own fallback)',
    live.escapes.length === 0 && live.overflowing.length === 0 && live.listWidth === CLIENT_W - 24,
    `list ${live.listWidth}`);
  ok('and with the scroller as a plain block box',
    blocked.escapes.length === 0 && blocked.overflowing.length === 0 && blocked.listWidth === CLIENT_W - 24,
    `list ${blocked.listWidth}, escapes ${blocked.escapes.length}, overflowing ${blocked.overflowing.length}`);

  // (c) the text is in the DOM as text: nothing was ellipsised into a title attribute
  const scrollerText = sc.textContent;
  ok('the user\'s prompt and the reply are both present verbatim in the scroll region\'s text',
    scrollerText.indexOf(USER_TEXT) >= 0 && scrollerText.indexOf(ASSIST_TEXT) >= 0,
    `${USER_TEXT.slice(0, 24)}… / ${ASSIST_TEXT.slice(0, 24)}…`);
  ok('the unbreakable token is present verbatim too (breaking characters is not losing them)',
    scrollerText.indexOf(TOKEN_TEXT) >= 0 && scrollerText.indexOf(SYS_TEXT) >= 0, 'a token is missing');
  const slices = [USER_TEXT.slice(0, 40), ASSIST_TEXT.slice(0, 40), TOKEN_TEXT.slice(0, 40), SYS_TEXT.slice(0, 40)];
  const titled = allEls(sc).filter((n) => typeof n.title === 'string'
    && n.title.length > 20 && slices.some((s) => n.title.indexOf(s) >= 0));
  eq('and none of it is hidden behind a title attribute instead of being drawn',
    titled.map((n) => [label(n), String(n.title).slice(0, 40)]), []);
  ok('the fixture does not take the "show all · N lines" path, so "fully present" is about width',
    byClass(sc, 'hd-cv-more').length === 0, `${byClass(sc, 'hd-cv-more').length} clamp buttons`);

  // the one element allowed to have content wider than its box is the tool card's one-line summary:
  // it is a nowrap PREVIEW under `overflow: hidden` with an ellipsis, its own full text is in the
  // expandable JSON beside it, and its width is the row's leftover (see .hd-cv-sum in the sheet)
  const sum = one(sc, 'hd-cv-sum');
  const sb = boxOf(sum);
  ok('the only content wider than its own box is the tool summary, which is a declared ellipsised preview',
    sb.overflowing === true && sb.contained === true && sb.ellipsis === true,
    JSON.stringify({ overflowing: sb.overflowing, contained: sb.contained, ellipsis: sb.ellipsis }));
  ok('and that summary is bounded by the card that owns it, not by its text',
    sb.right <= (boxOf(one(sc, 'hd-cv-card')).right || 0) + 1 && sb.width > 100,
    `summary right ${sb.right}, card right ${(boxOf(one(sc, 'hd-cv-card')) || {}).right}`);
  ok('the card\'s body is bounded as well (a wide input JSON or result cannot widen the card)',
    (boxOf(one(sc, 'hd-cv-json')).right || 0) <= CLIENT_W + 1,
    `json right ${(boxOf(one(sc, 'hd-cv-json')) || {}).right}`);
  ok('and the collapsed thinking body is not measured at all — it is not drawn',
    (boxOf(one(sc, 'hd-cv-think-body')) || {}).width === undefined,
    JSON.stringify(boxOf(one(sc, 'hd-cv-think-body'))));

  // W2's own two nodes are inside the region, so they are held to the same bound
  ok('the state block (#hdChatState, W2\'s) wraps its text instead of widening the column',
    (boxOf(st).scrollWidth || 0) <= (boxOf(st).clientWidth || 0) + 1,
    `scrollWidth ${boxOf(st).scrollWidth} vs clientWidth ${boxOf(st).clientWidth}`);
  ok('and the jump pill (#hdChatJump, W2\'s) stays inside the client area',
    (boxOf(jump).right || 0) <= CLIENT_W + 1, `right ${boxOf(jump).right}`);
  ok('the fixture really did render W2\'s nodes and the hostile input (no vacuous green)',
    !!boxOf(st).width && !!boxOf(jump).width && HOSTILE_INPUT.length > 200
      && one(sc, 'hd-cv-card') !== null && byClass(sc, 'hd-cv-role-user').length === 2,
    JSON.stringify({ state: boxOf(st).width, jump: boxOf(jump).width }));
  ok('and no rendered tree in this section wrote innerHTML',
    INNER_HTML_WRITES.length === 0, INNER_HTML_WRITES.map((w) => w.tag).join(','));
}

// ══ §10 attachments — the chip row, measured in a real engine ═══════════════

section('§10 — the attachment chips, as the engine lays them out (headless Chrome)');
{
  const CHROME = process.env.HD_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  // Both ports are derived from the pid so two copies of this suite (or a second worker's run at the
  // same time) cannot steal each other's browser: a fixed port would make the second run attach to the
  // first one's Chrome and measure someone else's page. The static server walks forward from its base
  // if the port is taken.
  const SEED = process.pid % 100;
  const CDP_PORT = 9200 + SEED;
  const HTTP_BASE = 7300 + SEED;
  const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  const PUB = path.join(REPO, 'public');

  /* The assertion names live here so the failure branch below can report the SAME checks as failed
     with the reason, instead of printing a section that quietly lost its assertions. */
  const C = {
    ran: 'the pass measured the real page with this round\'s row bound applied (not an unstyled page)',
    ready: 'the stylesheet really is applied to the page the chips are measured in (no vacuous green)',
    above: 'the chip row waits above the input, in the composer\'s own flow',
    visible: 'the input the reader types in is still fully inside the viewport with the chips in place',
    focus: 'adding chips does not take the focus away from the input',
    failed: 'the failed chip is not a shade of the ready chip: edge, fill, bar and text all differ measurably',
    uploading: 'the uploading chip is stated, not animated: a dashed edge in the working amber, no animation',
    readyChip: 'the ready chip keeps the plain hairline',
    drop: 'the drop state changes the composer measurably (a dashed accent outline and an inset ring)',
    noSize: 'and moves nothing: the composer and the input are the same box in both states',
    hit: 'the remove button measures at least 20x20 whatever glyph sits in it',
    keyboard: 'it is a real button in the tab order, not a span with a click handler',
    ring: 'it draws a focus ring under programmatic focus',
    overflow: 'a 200-character file name does not widen the chip row',
    inside: 'and the chip stays inside that row',
    ellipsis: 'the name is ellipsised where it was clipped, not silently dropped',
    stress: 'eight chips with 200-character names still cannot push the input out of the viewport',
    copyHit: 'the §13.1 copy button measures at least 20x20 in the real engine',
    copyLast: 'it is the last child of its head row, and its hit area is clear of the fold control',
    copyFold: 'a folded block\'s blockText() is the text the fold hid, read out of the real page',
    copyCard: 'a tool card is copied from its own head, input and result as the card drew them',
  };

  // The page-side work: build §10.9's markup in the REAL composer, measure, and hand the numbers
  // back. One synchronous task, so nothing the page does on a timer can interleave with it.
  const PAGE_FN = `(() => {
  const cs = (n) => getComputedStyle(n);
  const bx = (n) => { const b = n.getBoundingClientRect();
    return { l: +b.left.toFixed(2), t: +b.top.toFixed(2), r: +b.right.toFixed(2), b: +b.bottom.toFixed(2),
      w: +b.width.toFixed(2), h: +b.height.toFixed(2) }; };
  const composer = document.getElementById('promptBox');
  const input = document.getElementById('promptText');
  if (!composer || !input) return { error: 'the real composer is not in this page (no #promptBox / #promptText)' };
  const viewport = { w: window.innerWidth, h: window.innerHeight };

  const chip = (name, state, size) => {
    const c = document.createElement('div');
    c.className = 'hd-cv-attach';
    c.setAttribute('data-state', state);
    if (state === 'ready') c.setAttribute('data-path', 'C:/attachments/w6_p2/' + name);   // §10.9
    const meta = document.createElement('span');
    meta.className = 'hd-cv-attach-meta';
    meta.textContent = name + ' · ' + size;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'hd-cv-attach-remove';
    rm.setAttribute('aria-label', 'remove attachment');
    rm.textContent = 'x';
    c.appendChild(meta); c.appendChild(rm);
    return c;
  };
  const row = (names) => {
    const r = document.createElement('div');
    r.className = 'hd-cv-attach-list';
    for (const c of names) r.appendChild(c);
    return r;
  };
  const NAME = 'x'.repeat(191) + '-shot.png';        // exactly 200 characters
  const names = [chip('shot.png', 'uploading', '1.2 MB'), chip('notes.md', 'ready', '4 KB'),
    chip('broken.zip', 'failed', '0 B'), chip(NAME, 'ready', '9 MB')];

  // the reader is typing: the chips must not take their focus away
  input.focus();
  const before = { focus: document.activeElement === input, box: bx(input) };
  const list = row(names);
  composer.insertBefore(list, composer.querySelector('.prompt-line') || null);
  const after = { focus: document.activeElement === input, box: bx(input) };

  const snap = (c) => { const s = cs(c), m = cs(c.querySelector('.hd-cv-attach-meta'));
    return { border: s.borderTopColor, style: s.borderTopStyle, bg: s.backgroundColor,
      shadow: s.boxShadow, anim: s.animationName, meta: m.color, weight: m.fontWeight }; };
  const states = { uploading: snap(names[0]), ready: snap(names[1]), failed: snap(names[2]) };

  // the three states have to be three things, so ask the engine for the ones that animate too
  const animations = names.map((c) => cs(c).animationName).concat(names.map((c) => cs(c.querySelector('.hd-cv-attach-meta')).animationName));

  const rm = names[2].querySelector('.hd-cv-attach-remove');
  const ringOf = () => ({ outline: cs(rm).outlineStyle, width: cs(rm).outlineWidth,
    color: cs(rm).outlineColor, focused: document.activeElement === rm, focusVisible: rm.matches(':focus-visible') });
  rm.blur(); rm.focus();
  const cold = ringOf();                     // a bare script focus, with nothing focused before it
  input.focus(); rm.focus();
  const primed = ringOf();                   // script focus moved off a text field, as a browser applies :focus-visible

  const idle = { outline: cs(composer).outlineStyle, color: cs(composer).outlineColor,
    bg: cs(composer).backgroundColor, shadow: cs(composer).boxShadow,
    box: bx(composer), inputBox: bx(input) };
  composer.classList.add('hd-cv-drop-active');
  const active = { outline: cs(composer).outlineStyle, color: cs(composer).outlineColor,
    bg: cs(composer).backgroundColor, shadow: cs(composer).boxShadow,
    box: bx(composer), inputBox: bx(input) };
  composer.classList.remove('hd-cv-drop-active');

  const longChip = names[3], longMeta = longChip.querySelector('.hd-cv-attach-meta');
  const overflow = { row: { sw: list.scrollWidth, cw: list.clientWidth, right: bx(list).r, bottom: bx(list).b },
    chip: { sw: longChip.scrollWidth, cw: longChip.clientWidth, right: bx(longChip).r },
    meta: { sw: longMeta.scrollWidth, cw: longMeta.clientWidth,
      ellipsis: cs(longMeta).textOverflow, white: cs(longMeta).whiteSpace },
    nameChars: [...NAME].length };

  // §10.3 allows eight chips: the worst case, all eight with 200-character names
  const eight = Array.from({ length: 8 }, (_, i) => chip(NAME.slice(0, 199) + i, 'ready', '9 MB'));
  const wide = row(eight);
  composer.insertBefore(wide, composer.querySelector('.prompt-line') || null);
  const stress = { box: bx(wide), sw: wide.scrollWidth, cw: wide.clientWidth,
    inputBox: bx(input), viewport: { w: window.innerWidth, h: window.innerHeight } };
  // everything that has to be measured is measured BEFORE the nodes come out: a detached node has no
  // box at all, and a 0x0 hit area would read as "the button has no size" rather than as a bug here.
  const hit = bx(rm);
  wide.remove();
  list.remove();

  return { viewport, before, after, states, animations, hit, tabIndex: rm.tabIndex,
    tag: rm.tagName, disabled: rm.disabled, cold, primed, idle, active, overflow, stress };
})()`;

  /* §13.1, measured in the same page: the real renderer, the real sheet, the real engine. The chip
     pass above proves the stylesheet is applied; this pass asks the two §13.1.1 questions that only a
     layout engine can answer — does the button MEASURE at least 20x20, and does it keep its own hit
     area instead of covering the fold control it follows — plus §13.1.2's answer read out of the
     DOM: a folded block's blockText() is the text the fold hid. */
  const COPY_FN = `(() => {
  const bx = (n) => { const b = n.getBoundingClientRect();
    return { l: +b.left.toFixed(2), t: +b.top.toFixed(2), r: +b.right.toFixed(2), b: +b.bottom.toFixed(2),
      w: +b.width.toFixed(2), h: +b.height.toFixed(2) }; };
  const CR = window.ChatRender;
  if (!CR || typeof CR.blockText !== 'function') return { error: 'window.ChatRender.blockText is not on this page' };
  const raw = 'first line\\n' + Array.from({ length: 23 }, (_, i) => 'line ' + (i + 2)).join('\\n')
    + '\\nTAIL-SENTINEL-25';
  const msg = { key: 'live-copy-1', ts: Date.now(), role: 'user', kind: 'text', text: raw };
  const tool = { key: 'live-copy-2', ts: Date.now(), role: 'assistant', kind: 'tool_call',
    text: '', tool: { name: 'Bash', call_key: 'live', input: { command: 'npm test' }, result: 'ok' } };
  // Off-screen but LAID OUT: getBoundingClientRect on a display:none node is all zeros, which would
  // read as "the button has no size" rather than as a measurement.
  const host = document.createElement('div');
  host.className = 'hd-cv-scroll';
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:520px;visibility:hidden';
  document.body.appendChild(host);
  const list = document.createElement('div');
  list.className = 'hd-cv-list';
  host.appendChild(list);
  const folded = CR.renderMessage(msg, { foldedKeys: { 'live-copy-1': true } });
  const card = CR.renderMessage(tool);
  list.appendChild(folded); list.appendChild(card);
  const head = folded.querySelector('.hd-cv-meta');
  const btn = folded.querySelector('.hd-cv-copy');
  const fold = head.querySelector('.hd-cv-foldbtn');
  const cb = bx(btn), fb = bx(fold);
  const out = {
    copyBox: cb, foldBox: fb,
    lastChild: head.lastElementChild === btn,
    buttons: folded.querySelectorAll('.hd-cv-copy').length,
    foldButtons: head.querySelectorAll('.hd-cv-foldbtn').length,
    apart: (cb.r <= fb.l + 0.5) || (fb.r <= cb.l + 0.5) || (cb.b <= fb.t + 0.5) || (fb.b <= cb.t + 0.5),
    inline: getComputedStyle(btn).display,
    aria: btn.getAttribute('aria-label'), glyph: btn.textContent,
    foldedText: CR.blockText(folded), tailOnScreen: folded.textContent.indexOf('TAIL-SENTINEL-25') >= 0,
    fromButton: CR.blockText(btn),
    cardBox: bx(card.querySelector('.hd-cv-copy')), cardFromButton: CR.blockText(card.querySelector('.hd-cv-copy')),
    cardWant: '{\\n  "command": "npm test"\\n}\\n\\nok',
    cardButtons: card.querySelectorAll('.hd-cv-copy').length,
  };
  host.remove();
  return out;
})()`;

  const rgb = (s) => (String(s).match(/[0-9]+/g) || []).map(Number).slice(0, 3);
  const dist = (a, b) => { const A = rgb(a), B = rgb(b); return Math.max(...A.map((v, i) => Math.abs(v - B[i]))); };
  const sameBox = (a, b) => ['l', 't', 'r', 'b', 'w', 'h'].every((k) => a[k] === b[k]);

  let port = 0, kid = null, profile = null, ws = null, m = null, m2 = null, err = null;
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://hd').pathname);
    const file = path.join(PUB, rel === '/' ? 'index.html' : rel);
    if (rel.indexOf('/api/') === 0 || !file.startsWith(PUB)
      || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not served here');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  /* Close the socket, the server and the browser, then the profile directory. The kill is the one
     that needs care: taskkill returns as soon as the signal is sent, and Windows keeps the profile's
     files locked until the browser's processes are really gone, so the directory is removed with a
     few retries rather than once (a leftover profile in %TEMP% would be litter the next run inherits). */
  const cleanup = async () => {
    try { if (ws) ws.close(); } catch { /* gone */ }
    try { server.close(); } catch { /* gone */ }
    if (kid) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(kid.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else kid.kill('SIGKILL');
      } catch { /* gone */ }
    }
    if (profile) {
      for (let i = 0; i < 12; i++) {
        try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(150); }
      }
    }
  };

  try {
    port = await new Promise((res, rej) => {
      const attempt = (i) => {
        if (i > 2) { rej(new Error(`ports ${HTTP_BASE}-${HTTP_BASE + 2} are all in use`)); return; }
        const p = HTTP_BASE + i;
        const onErr = () => { server.removeListener('listening', onUp); attempt(i + 1); };
        const onUp = () => { server.removeListener('error', onErr); res(p); };
        server.once('error', onErr); server.once('listening', onUp); server.listen(p, '127.0.0.1');
      };
      attempt(0);
    });
    if (!fs.existsSync(CHROME)) throw new Error('no Chrome at ' + CHROME + ' — set HD_CHROME to point at one');
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-cv-attach-css-'));
    kid = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
      '--window-size=1200,900', 'about:blank'], { stdio: 'ignore', windowsHide: true });

    let wsUrl = null;
    for (let i = 0; i < 60 && !wsUrl; i++) {
      try {
        const l = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
        wsUrl = (l.find((t) => t.type === 'page') || {}).webSocketDebuggerUrl;
      } catch { /* not up yet */ }
      if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error('no CDP target on ' + CDP_PORT + ' within 15 s');
    ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('CDP socket failed'))); });
    let seq = 0; const waiting = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8'));
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    });
    const send = (method, params = {}) => new Promise((r) => { const i = ++seq; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
    await send('Page.bringToFront');
    if (await ev('document.hidden === false') !== true) {
      throw new Error('the tab is not foregrounded (document.hidden !== false) — the page would not be laid out');
    }
    // The page is ready when MY sheet is in it, asked directly rather than hoped for: a probe element
    // with the row's class must already carry the row's own bound.
    let applied = null;
    for (let i = 0; i < 50; i++) {
      applied = await ev(`(() => { const d = document.createElement('div'); d.className = 'hd-cv-attach-list';
        document.body.appendChild(d); const v = getComputedStyle(d).maxHeight; d.remove(); return v; })()`);
      if (applied === '92px') break;
      await sleep(200);
    }
    m = await ev(PAGE_FN);
    if (!m || m.error) throw new Error('the measurement did not run: ' + JSON.stringify(m));
    m2 = await ev(COPY_FN);
    if (!m2 || m2.error) throw new Error('the §13.1 measurement did not run: ' + JSON.stringify(m2));
    m.applied = applied;
  } catch (e) {
    err = e && e.message ? e.message : String(e);
  } finally { await cleanup(); }

  if (err) {
    for (const name of Object.values(C)) ok(name, false, `the engine pass did not run: ${err}`);
  } else {
    const vh = m.viewport.h;
    // A probe element carrying the row's own class must already be bounded by it: that single number
    // proves this sheet — not the browser's defaults — is what the chips below were measured under.
    ok(C.ran, m.applied === '92px' && !!m.hit.w,
      `a bare .hd-cv-attach-list had max-height=${m.applied} (want 92px) viewport=${m.viewport.w}x${m.viewport.h}`);
    ok(C.ready, dist(m.states.failed.border, m.states.ready.border) > 0,
      'the three chips were measured without the stylesheet, so nothing here would mean anything');
    ok(C.above, m.overflow.row.bottom <= m.after.box.t + 1 && m.after.box.t >= 0,
      `row bottom ${m.overflow.row.bottom}, input top ${m.after.box.t}`);
    ok(C.visible, m.after.box.t >= 0 && m.after.box.b <= vh && m.after.box.h >= 20,
      `input ${JSON.stringify(m.after.box)} in a ${vh}px viewport`);
    ok(C.focus, m.before.focus && m.after.focus, `focus before/after the chips: ${m.before.focus}/${m.after.focus}`);
    console.log(`     failed vs ready: border ${m.states.failed.border} vs ${m.states.ready.border} ` +
      `(Δ${dist(m.states.failed.border, m.states.ready.border)}), fill ${m.states.failed.bg} vs ${m.states.ready.bg} ` +
      `(Δ${dist(m.states.failed.bg, m.states.ready.bg)}), text ${m.states.failed.meta} vs ${m.states.ready.meta} ` +
      `(Δ${dist(m.states.failed.meta, m.states.ready.meta)}), bar ${JSON.stringify(m.states.failed.shadow)} vs ` +
      `${JSON.stringify(m.states.ready.shadow)}`);
    ok(C.failed, dist(m.states.failed.border, m.states.ready.border) >= 40
      && dist(m.states.failed.bg, m.states.ready.bg) >= 10
      && dist(m.states.failed.meta, m.states.ready.meta) >= 40
      && m.states.failed.shadow !== m.states.ready.shadow
      && m.states.failed.weight !== m.states.ready.weight,
      `${JSON.stringify(m.states.failed)} vs ${JSON.stringify(m.states.ready)}`);
    ok(C.uploading, m.states.uploading.style === 'dashed'
      && dist(m.states.uploading.border, m.states.ready.border) >= 40
      && m.animations.every((a) => a === 'none'),
      `uploading ${m.states.uploading.border} ${m.states.uploading.style}, animations ${JSON.stringify([...new Set(m.animations)])}`);
    ok(C.readyChip, m.states.ready.style === 'solid' && m.states.ready.border === 'rgb(38, 48, 64)',
      JSON.stringify(m.states.ready));
    console.log(`     drop state: outline ${m.idle.outline} -> ${m.active.outline} (${m.active.color}), ` +
      `ring ${JSON.stringify(m.idle.shadow)} -> ${JSON.stringify(m.active.shadow)}, ` +
      `fill ${m.idle.bg} -> ${m.active.bg}`);
    // What is asserted is what MEASURABLY changes on this container. The fill is declared too, but
    // W2's `#promptBox { background: … }` outranks it at id specificity — the engine said so
    // (rgb(20,26,34) on both sides), which is why the affordance is drawn with the outline and the
    // inset ring, neither of which any other rule sets.
    ok(C.drop, m.idle.outline === 'none' && m.active.outline === 'dashed'
      && m.active.color === 'rgb(74, 163, 255)'
      && m.idle.shadow === 'none' && /inset/.test(m.active.shadow),
      `idle ${JSON.stringify(m.idle)} vs active ${JSON.stringify(m.active)}`);
    ok(C.noSize, sameBox(m.idle.box, m.active.box) && sameBox(m.idle.inputBox, m.active.inputBox),
      `composer ${JSON.stringify(m.idle.box)} -> ${JSON.stringify(m.active.box)}, ` +
      `input ${JSON.stringify(m.idle.inputBox)} -> ${JSON.stringify(m.active.inputBox)}`);
    ok(C.hit, m.hit.w >= 20 && m.hit.h >= 20, `${m.hit.w}x${m.hit.h}`);
    ok(C.keyboard, m.tag === 'BUTTON' && m.tabIndex === 0 && m.disabled === false,
      `${m.tag} tabIndex=${m.tabIndex} disabled=${m.disabled}`);
    console.log(`     remove button focus: cold = ${JSON.stringify(m.cold)} · primed = ${JSON.stringify(m.primed)}`);
    // The asserted path is the spec-grounded one: focus moved by script OFF a text field, which is
    // where browsers apply :focus-visible to a button. (This engine also draws the ring for a bare
    // script focus — the `cold` numbers above — but that carries over from whatever had focus before,
    // so the check does not lean on it.)
    ok(C.ring, m.primed.focused && m.primed.focusVisible && m.primed.outline === 'solid'
      && parseFloat(m.primed.width) >= 2 && m.primed.color === 'rgb(74, 163, 255)',
      JSON.stringify(m.primed));
    ok(C.overflow, m.overflow.row.sw <= m.overflow.row.cw && m.overflow.chip.sw <= m.overflow.chip.cw,
      `row ${m.overflow.row.sw}/${m.overflow.row.cw}, chip ${m.overflow.chip.sw}/${m.overflow.chip.cw}`);
    ok(C.inside, m.overflow.chip.right <= m.overflow.row.right + 1,
      `chip right ${m.overflow.chip.right} vs row right ${m.overflow.row.right}`);
    ok(C.ellipsis, m.overflow.nameChars === 200 && m.overflow.meta.sw > m.overflow.meta.cw
      && m.overflow.meta.ellipsis === 'ellipsis' && m.overflow.meta.white === 'nowrap',
      `name ${m.overflow.nameChars} chars, meta ${m.overflow.meta.sw}/${m.overflow.meta.cw} ` +
      `${m.overflow.meta.ellipsis}/${m.overflow.meta.white}`);
    ok(C.stress, m.stress.box.h <= 93 && m.stress.sw <= m.stress.cw
      && m.stress.inputBox.t >= 0 && m.stress.inputBox.b <= m.stress.viewport.h && m.stress.inputBox.h >= 20,
      `row ${m.stress.sw}/${m.stress.cw} h=${m.stress.box.h}, input ${JSON.stringify(m.stress.inputBox)} ` +
      `in ${m.stress.viewport.h}px`);

    console.log(`     copy button: ${m2.copyBox.w}x${m2.copyBox.h} ${m2.inline}, ` +
      `fold control ${m2.foldBox.w}x${m2.foldBox.h}, gap ${(m2.copyBox.l - m2.foldBox.r).toFixed(2)}px`);
    // The measured box, not the declaration: 20x20 is what the engine laid out, at the same time as
    // the sheet that declares it is proven applied by the probe above.
    ok(C.copyHit, m2.copyBox.w >= 20 && m2.copyBox.h >= 20 && m2.cardBox.w >= 20 && m2.cardBox.h >= 20,
      `bubble ${m2.copyBox.w}x${m2.copyBox.h}, card ${m2.cardBox.w}x${m2.cardBox.h}`);
    ok(C.copyLast, m2.lastChild && m2.buttons === 1 && m2.foldButtons === 1 && m2.apart
      && m2.aria === 'copy this block' && m2.glyph === '⧉',
      `last=${m2.lastChild} buttons=${m2.buttons} fold=${m2.foldButtons} apart=${m2.apart} ` +
      `aria=${JSON.stringify(m2.aria)} glyph=${JSON.stringify(m2.glyph)}`);
    // §13.1.2 read out of the DOM: the sentinel is nowhere on the page and everywhere in the copy.
    ok(C.copyFold, m2.tailOnScreen === false && m2.foldedText.indexOf('TAIL-SENTINEL-25') > 0
      && m2.fromButton === m2.foldedText && m2.foldedText.split('\n').length === 25,
      `on screen: ${m2.tailOnScreen}, copied ${m2.foldedText.length} chars in ` +
      `${m2.foldedText.split('\n').length} lines, from the button: ${m2.fromButton === m2.foldedText}`);
    ok(C.copyCard, m2.cardButtons === 1 && m2.cardFromButton === m2.cardWant,
      `${m2.cardButtons} buttons, copied ${JSON.stringify(m2.cardFromButton)}`);
  }
}

// ── total ───────────────────────────────────────────────────────────────────

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
if (fail) console.log(`failing: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
