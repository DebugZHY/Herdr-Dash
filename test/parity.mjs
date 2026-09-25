#!/usr/bin/env node
/*
 * test/parity.mjs — regression guard for CONTRACT-v2 §0.1 + §0.2 (R1–R3).
 * Owner: W1 (round 4).
 *
 * R2 made the two copies ONE implementation: src/hdr.js requires
 * public/lib/advance-buffer.js and re-exports it, so "A ≡ B" is now structural
 * and the assertions that carry weight are the RULED INVARIANTS (R1) replayed
 * through that copy on every scenario:
 *
 *   R1.1 no duplication  a row may not appear more times in the buffer than in
 *                        the source — FAIL. This is the DEFECT-1 failure mode,
 *                        and the ruling forbids it absolutely.
 *   R1.2 order           the buffer must be a subsequence of the source, in
 *                        source order — FAIL.
 *   R1.3 tail            after the last window the buffer must end where the
 *                        pane ends: on the newest row the pane showed, or on an
 *                        earlier paint of a row the pane still shows when the
 *                        pane repaints its bottom row in place — FAIL otherwise.
 *   suppression          a repainted row the window no longer contains is
 *                        ALLOWED: reported as a count with the row text, never
 *                        a failure and never a reset (R1/R3).
 *
 * "Every source row exactly once, in order, none lost" — the round-3 assertion —
 * is unattainable for ANY line-based algorithm on a pane that repaints its
 * pinned bottom rows in place, which is exactly what §0.2 rules. The chrome/TUI
 * scenario below models that shape and asserts R1 there instead, as R3 requires.
 *
 * TEETH. R2 makes A and B the same function object, so parity alone can no
 * longer demonstrate that this harness would notice a wrong algorithm. Two
 * frozen pre-fix copies supply the teeth, both asserted in every run:
 *   - the round-1 `mergeStream` rule in src/hdr.js (the `v1` check per scenario);
 *   - the round-2 browser copy — rule 2 = the literal `next.slice(anchor.length)`
 *     — embedded verbatim below, so the evidence outlives `_scratch/`.
 * They must still duplicate rows their source holds once. If that ever stops
 * being true, the assertions above have gone blind and the run says so.
 *
 * Usage:
 *   node test/parity.mjs                      # scenarios + live capture on 7455
 *   node test/parity.mjs --no-live            # scenarios only, no server needed
 *   node test/parity.mjs --b <path>           # compare A against another copy
 *   node test/parity.mjs --port 7455 --polls 40 --window 1200 --interval 1000
 *
 * Exit: 0 = no FAIL, 1 = at least one FAIL.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const req = createRequire(import.meta.url);

// ── flags ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

const NO_LIVE = has('--no-live');
const SHARED_PATH = path.join(ROOT, 'public', 'lib', 'advance-buffer.js');
const B_PATH = path.resolve(ROOT, opt('--b', path.join('public', 'lib', 'advance-buffer.js')));
const PORT = Number(opt('--port', '7455'));
const BASE = opt('--base', `http://127.0.0.1:${PORT}`);
const PANE = opt('--pane', '');             // '' = pick a busy pane automatically
const POLLS = Number(opt('--polls', '40'));
const WINDOW = Number(opt('--window', '1200'));
const INTERVAL = Number(opt('--interval', '1000'));   // ms between live polls
const DUMP = Number(opt('--dump', '8'));              // context lines in a divergence

// ── check runner ────────────────────────────────────────────────────────────
const results = [];
let failures = 0;

function check(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    if (r && typeof r === 'object') { ok = !!r.ok; detail = r.detail || ''; }
    else ok = !!r;
  } catch (e) {
    ok = false;
    detail = `threw ${e && e.message ? e.message : e}`;
  }
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  return ok;
}

const info = (m) => console.log(`      · ${m}`);
const head = (m) => console.log(`\n── ${m} ${'─'.repeat(Math.max(0, 68 - m.length))}`);

/* A finding the harness reports but does not judge. Used for the live capture,
 * where there is no ground truth: a difference between two copies is real
 * evidence for a human to act on, but which copy is right cannot be decided from
 * a capture alone, and the capture itself varies run to run. */
const warnings = [];
function warn(name, detail) {
  warnings.push({ name, detail });
  console.log(`WARN  ${name}${detail ? `\n        ${detail}` : ''}`);
}

// ── helpers ─────────────────────────────────────────────────────────────────
const eqArr = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const clip = (s, n = 60) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const pad = (n, w = 6) => String(n).padStart(w, '0');
const hash = (i) => ((i * 2654435761) >>> 0).toString(16).padStart(8, '0');

/* Replay a window sequence the way the GUI does: append each reply's newLines
 * to the buffer and feed the buffer back in as `prev`. */
function replay(advance, windows) {
  let buf = [];
  const trace = [];
  for (let i = 0; i < windows.length; i++) {
    const prev = buf;
    let r;
    try { r = advance(prev, windows[i]) || {}; }
    catch (e) { r = { newLines: [], mode: 'throw', rule: `threw: ${e && e.message}` }; }
    const nl = Array.isArray(r.newLines) ? r.newLines : [];
    buf = prev.concat(nl);
    trace.push({ i, winLen: windows[i].length, appended: nl.length, bufLen: buf.length, rule: r.rule || r.mode });
  }
  return { buf, trace };
}

/* ── R1.1 no duplication ─────────────────────────────────────────────────────
 * The ruled invariant. A row the source holds once may appear at most once in
 * the buffer; a row the source holds twice may appear at most twice. Anything
 * above that row's own ceiling is the DEFECT-1 failure mode.
 *
 * The ceiling of a row the source does not hold AT ALL — a repainted chrome row,
 * which by construction was never part of the stream — is the number of windows
 * that showed it: the tightest bound a source-less row has, and still tight
 * enough to catch a copy that re-appends it on every poll. */
function duplicationCeiling(scn) {
  const ceiling = new Map();
  for (const l of scn.source) ceiling.set(l, (ceiling.get(l) || 0) + 1);
  const shown = new Map();
  for (const w of scn.windows) for (const l of w) shown.set(l, (shown.get(l) || 0) + 1);
  for (const [l, n] of shown) if (!ceiling.has(l)) ceiling.set(l, n);
  return ceiling;
}
function noDuplication(buf, ceiling) {
  const got = new Map();
  for (const l of buf) got.set(l, (got.get(l) || 0) + 1);
  for (const [l, n] of got) {
    const have = ceiling.get(l) || 0;
    if (n > have) {
      return { ok: false, detail: `a row appears ${n}x in the buffer but only ${have}x in the source (${clip(l, 44)})` };
    }
  }
  return { ok: true, detail: `${buf.length} buffer rows, ${got.size} distinct — none exceeds its own ceiling` };
}

/* ── R1.2 order ──────────────────────────────────────────────────────────────
 * The buffer must be a subsequence of the source, in source order. Repeated
 * rows are matched with multiplicity: each buffer row consumes the next source
 * occurrence of that row that sits after the last matched position. A buffer row
 * the source does not contain at all (repainted chrome) is skipped — R1 permits
 * suppression, it does not permit reordering. */
function sourcePositions(source) {
  const pos = new Map();
  for (let i = 0; i < source.length; i++) {
    const a = pos.get(source[i]);
    if (a) a.push(i); else pos.set(source[i], [i]);
  }
  return pos;
}
function orderCheck(buf, pos) {
  const cursor = new Map();
  let last = -1;
  let matched = 0;
  for (const l of buf) {
    const arr = pos.get(l);
    if (!arr) continue;
    let k = cursor.get(l) || 0;
    while (k < arr.length && arr[k] <= last) k++;
    if (k >= arr.length) {
      return { ok: false, detail: `the buffer is out of order at its row #${matched + 1}: its remaining source position(s) are behind #${last}: ${clip(l, 44)}` };
    }
    cursor.set(l, k + 1);
    last = arr[k];
    matched++;
  }
  return { ok: true, detail: `${matched} of ${buf.length} buffer rows matched source positions in ascending order` };
}

/* "same screen row, redrawn": equal length, at most two characters differ. This
 * is the shared copy's own repaint test, restated here so the harness judges
 * independently of the code it is judging. */
function isRepaintRow(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a === b) return true;
  if (a.length !== b.length || a.length < 6) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 2) return false;
  return true;
}

/* ── R1 suppression (permitted, reported) ────────────────────────────────────
 * A row that some window contained, that never reached the buffer, and that is a
 * repaint of a row the buffer does hold is the pane rewriting that row in place.
 * R1 permits it, R3 requires it to be reported as a count with the row text. */
function suppressionReport(buf, windows) {
  const shown = new Set(buf);
  const missing = new Map();
  for (const w of windows) for (const l of w) if (!shown.has(l)) missing.set(l, (missing.get(l) || 0) + 1);

  const byLen = new Map();
  for (let i = Math.max(0, buf.length - 4096); i < buf.length; i++) {
    const a = byLen.get(buf[i].length);
    if (a) a.push(buf[i]); else byLen.set(buf[i].length, [buf[i]]);
  }
  const repainted = [];
  const other = [];
  for (const l of missing.keys()) {
    let hit = false;
    for (const b of byLen.get(l.length) || []) if (isRepaintRow(b, l)) { hit = true; break; }
    (hit ? repainted : other).push(l);
  }
  const ex = repainted.slice(0, 3).map((l) => clip(l, 44)).join(' | ');
  let detail = `suppressed ${repainted.length} repainted row${repainted.length === 1 ? '' : 's'}`
    + `${repainted.length ? `: ${ex}` : ''} — rows the window no longer contains, redrawn in place (permitted by R1; never an error, never a reset)`;
  detail += other.length
    ? `; ${other.length} other row(s) never reached the buffer (permitted too — R1 trades an invisible omission for a duplication)`
    : '; no other row was dropped';
  return { suppressed: repainted.length, other: other.length, detail };
}

/* ── R1.3 tail ───────────────────────────────────────────────────────────────
 * The highest source index any window still shows: for a plain stream that is
 * the source's final row; when the pane's bottom rows are repainted chrome it is
 * the newest *stream* row above them. */
function newestShownRow(scn) {
  let best = -1;
  let row = null;
  for (const w of scn.windows) {
    for (const l of w) {
      const i = scn.indexOf.get(l);
      if (i !== undefined && i > best) { best = i; row = l; }
    }
  }
  return { i: best, row };
}

function tailCheckSynthetic(buf, scn, label) {
  if (!buf.length) return { ok: false, detail: `${label}: the buffer is empty` };
  const tail = buf[buf.length - 1];
  const shown = newestShownRow(scn);
  if (tail === shown.row) return { ok: true, detail: `the buffer ends on the newest row the pane showed (source #${shown.i})` };
  // The repaint tolerance is justified only where the pane is modelled as
  // repainting rows in place (R3's labelled scenario). Everywhere else a tail
  // that is merely *similar* to a current row is a drifting buffer, not a
  // suppressed paint — so it fails.
  if (scn.painted) {
    const lastWin = scn.windows[scn.windows.length - 1];
    for (const l of lastWin) {
      if (isRepaintRow(tail, l)) {
        return { ok: true, detail: `the buffer ends on an earlier paint of a row the pane still shows — a suppressed repaint, permitted by R1: ${clip(tail, 34)}` };
      }
    }
  }
  return { ok: false, detail: `the buffer ends at ${clip(tail, 40)} but the newest row the pane showed is ${clip(shown.row, 40)} (source #${shown.i})` };
}

/* Live form: with no source to index, the sound statement is that the buffer
 * ends on something the pane's newest read still contains (exactly, or as an
 * earlier paint of one of its rows). A copy holding a stale tail — the forever
 * -behind failure mode — ends on rows the current view no longer has. */
function tailCheckLive(buf, newestWin) {
  if (!buf.length) return { ok: false, detail: 'the buffer is empty' };
  const tail = buf[buf.length - 1];
  if (tail === newestWin[newestWin.length - 1]) return { ok: true, detail: `the buffer ends on the pane's newest row (${clip(tail, 40)})` };
  for (const l of newestWin) {
    if (isRepaintRow(tail, l)) {
      return { ok: true, detail: `the buffer ends on an earlier paint of a row the pane still shows (suppressed repaint, permitted by R1): ${clip(tail, 34)}` };
    }
  }
  return { ok: false, detail: `the buffer ends at ${clip(tail, 40)}, which the pane's newest read no longer contains` };
}

/* Live form of R1.1: there is no source to count against, so the ceiling is the
 * number of windows each row appeared in. A duplication shows up as a row
 * repeated once per poll (far past any ceiling a pane's own repeats reach); the
 * slack absorbs a row the pane legitimately printed twice inside one window. */
const LIVE_SLACK = 3;
function looseDuplication(buf, windows) {
  const ceiling = new Map();
  for (const w of windows) for (const l of w) ceiling.set(l, (ceiling.get(l) || 0) + 1);
  const got = new Map();
  for (const l of buf) got.set(l, (got.get(l) || 0) + 1);
  let worst = null;
  for (const [l, n] of got) {
    const c = ceiling.get(l) || 0;
    if (n > c + LIVE_SLACK && (!worst || n - c > worst.n - worst.c)) worst = { l, n, c };
  }
  if (worst) {
    return { ok: false, detail: `a row appears ${worst.n}x in the buffer but only ${worst.c}x across all ${windows.length} windows: ${clip(worst.l, 40)}` };
  }
  return { ok: true, detail: `no row exceeds its window ceiling + ${LIVE_SLACK} (buffer ${buf.length} rows, ${got.size} distinct)` };
}

/* Live form of R1.2: no source to order against, so assert the part that needs
 * no ground truth — whatever a poll appends must be that window's own rows in
 * that window's order. A copy may drop rows (R1 allows it); it may not invent or
 * reorder them. The synthetic scenarios carry the full source-order check. */
function appendedIsSubsequence(advance, windows) {
  let buf = [];
  for (let i = 0; i < windows.length; i++) {
    const r = advance(buf, windows[i]) || {};
    const nl = Array.isArray(r.newLines) ? r.newLines : [];
    let k = 0;
    for (let j = 0; j < windows[i].length && k < nl.length; j++) if (windows[i][j] === nl[k]) k++;
    if (k < nl.length) {
      return { ok: false, detail: `poll #${i} appended ${nl.length} rows but only ${k} of them are its window's rows in order (first miss: ${clip(nl[k], 40)})` };
    }
    buf = buf.concat(nl);
  }
  return { ok: true, detail: `${windows.length} polls: every append is a subsequence of the window it came from` };
}

/* Replay A and B in lockstep and stop at the first poll whose buffers differ. */
function firstDivergence(windows) {
  let bufA = [];
  let bufB = [];
  for (let i = 0; i < windows.length; i++) {
    const prevA = bufA;
    const prevB = bufB;
    const next = windows[i];
    const ra = A(prevA, next) || {};
    const rb = B(prevB, next) || {};
    const na = Array.isArray(ra.newLines) ? ra.newLines : [];
    const nb = Array.isArray(rb.newLines) ? rb.newLines : [];
    bufA = prevA.concat(na);
    bufB = prevB.concat(nb);
    if (na.length !== nb.length || !eqArr(bufA, bufB)) {
      return {
        i, prevA, prevB, next, na, nb,
        prevTail: (prevA.length >= prevB.length ? prevA : prevB).slice(-8),
        nextHead: next.slice(0, 8),
        winLen: next.length,
        ruleA: ra.rule || ra.mode, ruleB: rb.rule || rb.mode,
      };
    }
  }
  return null;
}

function dumpDivergence(label, d) {
  const line = (s) => console.log(`        ${s}`);
  line(`first divergence: poll #${d.i} of "${label}"`);
  line(`buffer before it: A ${d.prevA.length} lines, B ${d.prevB.length} lines (window is ${d.winLen} lines)`);
  line(`A appended ${d.na.length} via rule ${d.ruleA}; B appended ${d.nb.length} via rule ${d.ruleB}`);
  line('prev tail (last 8 rows):');
  d.prevTail.forEach((l, k) => line(`  [${String(k - 8).padStart(3)}] ${clip(l, 56)}`));
  line('next head (first 8 rows):');
  d.nextHead.forEach((l, k) => line(`  [${String(k).padStart(3)}] ${clip(l, 56)}`));
  line(`A output (${Math.min(DUMP, d.na.length)} of ${d.na.length}):`);
  d.na.slice(0, DUMP).forEach((l) => line(`  + ${clip(l, 56)}`));
  line(`B output (${Math.min(DUMP, d.nb.length)} of ${d.nb.length}):`);
  d.nb.slice(0, DUMP).forEach((l) => line(`  + ${clip(l, 56)}`));
}

// ── load the copies ─────────────────────────────────────────────────────────
/* A is src/hdr.js, which per R2 requires and re-exports the shared file. */
head('loading the copies');
let hdr = null;
let A = null;
check('A  src/hdr.js loads and exports advanceBuffer() (R2: it requires the shared copy)', () => {
  try {
    hdr = req(path.join(ROOT, 'src', 'hdr.js'));
    A = hdr.advanceBuffer;
    return { ok: typeof A === 'function', detail: typeof A === 'function' ? 'advanceBuffer re-exported' : `advanceBuffer is ${typeof A}` };
  } catch (e) {
    return { ok: false, detail: `require('src/hdr.js') threw: ${e && e.message}` };
  }
});
if (typeof A !== 'function') {
  console.log('\nFAIL: src/hdr.js did not provide advanceBuffer. R2 makes public/lib/advance-buffer.js');
  console.log('      a hard dependency of it, so this is a broken tree, not a missing peer file.');
  console.log(`TOTAL: ${results.filter((r) => r.ok).length}/${results.length} passed`);
  process.exit(1);
}
check('A  src/hdr.js still exports mergeStream() (the v1 harness needs it)', () => ({ ok: typeof hdr.mergeStream === 'function' }));

/* B is the file under comparison. With the default `--b` that is the very file
 * src/hdr.js requires, so the check is one of IDENTITY — it bites the moment a
 * second algorithm is re-introduced into src/hdr.js. Pass --b <path> to compare
 * two genuinely different copies (that is how the frozen pre-fix copies are
 * exercised). */
let B = null;
let B_HOW = '';
const bRel = path.relative(ROOT, B_PATH);
if (!fs.existsSync(B_PATH)) {
  console.log(`SKIP  B  ${bRel} is not in the tree — no comparison possible; the R1 assertions below still run on A.`);
} else if (path.resolve(B_PATH) === path.resolve(SHARED_PATH)) {
  check('R2  A IS the shared copy — one implementation, not two hand copies', () => {
    const m = req(SHARED_PATH);
    return {
      ok: A === m.advanceBuffer,
      detail: A === m.advanceBuffer
        ? 'src/hdr.js re-exports public/lib/advance-buffer.js (same function object)'
        : 'src/hdr.js exports a DIFFERENT function from the shared file — R2 is violated',
    };
  });
  B = A;
  B_HOW = 'the same function object as A (R2)';
} else {
  check(`B  ${bRel} exports advanceBuffer()`, () => {
    const loaded = loadB(B_PATH);
    B = loaded.fn;
    B_HOW = `${bRel} via ${loaded.how}`;
    return { ok: typeof B === 'function', detail: `loaded via ${loaded.how}` };
  });
  if (typeof B !== 'function') {
    console.log('\nFAIL: the --b file did not provide advanceBuffer, so no comparison is possible.');
    console.log(`TOTAL: ${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(1);
  }
}

/* The shared file publishes the rule twice — once for the browser
 * (window.HD.advanceBuffer, which grid.js prefers) and once for Node
 * (module.exports, which src/hdr.js requires). Two evaluations of the same
 * source can never be the same object, so the check is that both paths produce
 * the same result on the frozen rule cases: a shim that published a different
 * function (or the browser path silently going missing) fails here. */
if (fs.existsSync(SHARED_PATH)) {
  const RULE_CASES = [
    [[], ['a', 'b']],
    [['a', 'b', 'c'], ['b', 'c', 'd']],
    [['a', 'b', 'c'], ['b', 'c']],
    [['x', 'y'], ['p', 'q', 'r']],
    [['dup', 'dup', 'z'], ['dup', 'dup', 'z', 'w']],
  ];
  check('B  window.HD.advanceBuffer and module.exports agree on the frozen rule cases', () => {
    const viaWindow = loadClassic(SHARED_PATH);
    if (typeof viaWindow !== 'function') return { ok: false, detail: 'the browser path published no window.HD.advanceBuffer — grid.js would fall back to its own copy' };
    const viaModule = req(SHARED_PATH).advanceBuffer;
    for (const [p, n] of RULE_CASES) {
      const w = viaWindow(p, n);
      const m = viaModule(p, n);
      if (w.mode !== m.mode || !eqArr(w.newLines, m.newLines)) {
        return { ok: false, detail: `the two publication paths disagree on prev=${JSON.stringify(p)} next=${JSON.stringify(n)}: window.HD ${w.mode}/${w.newLines.length} lines vs module.exports ${m.mode}/${m.newLines.length}` };
      }
    }
    return { ok: true, detail: `${RULE_CASES.length} frozen rule cases identical through window.HD and module.exports` };
  });
}

/* B is a classic browser script with a CommonJS shim. Try `require` first (the
 * shim path); if that yields nothing, run the file in a vm context that has
 * `module`/`exports`/`window` and read the binding off the global — so a missing
 * shim is still loadable and cannot hide a real difference. */
function loadB(p) {
  const code = fs.readFileSync(p, 'utf8');
  try {
    const m = req(p);
    if (m && typeof m.advanceBuffer === 'function') return { fn: m.advanceBuffer, how: 'require (CommonJS shim)' };
  } catch (e) { /* not a CJS module — fall through to the classic-script path */ }

  const sandbox = { module: { exports: {} }, exports: {}, console };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: p });
  const fn = sandbox.advanceBuffer
    || (sandbox.module.exports && sandbox.module.exports.advanceBuffer);
  if (typeof fn === 'function') return { fn, how: 'vm (classic script)' };
  throw new Error('the file loaded, but no `advanceBuffer` binding was exported');
}

/* The browser path only: a context with no `module`, i.e. exactly what the page
 * gives the file. */
function loadClassic(p) {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: p });
  return (sandbox.HD && sandbox.HD.advanceBuffer) || sandbox.advanceBuffer;
}

/* The copies the R1 assertions run against: A alone when B *is* A (R2), both
 * when --b named a different file. */
const COPIES = (B && B !== A) ? [{ label: 'A', fn: A }, { label: 'B', fn: B }] : [{ label: 'A≡B', fn: A }];

/* The v1 rule, adapted to the advanceBuffer contract (teeth). */
function v1Rule(prev, next) {
  const r = hdr.mergeStream(prev, next);
  return { newLines: r.newLines, mode: r.overlapped ? 'append' : 'reset' };
}

// ── the synthetic scenarios ─────────────────────────────────────────────────
/*
 * All of them model the same thing — a sliding window over a growing stream —
 * and differ only in how the window can misbehave, because that is the regime
 * the rules exist for:
 *
 *   clean   the window always ends at the newest row, nothing is redrawn.
 *           (Rule 1 handles this; mergeStream is correct here, so the teeth
 *            check goes the other way: v1 must agree.)
 *   lag     every Nth poll answers with a window that ends behind the buffer's
 *           end — a response that was overtaken in flight.
 *   tui     R3's labelled case: a TUI whose newest rows are pinned bottom UI
 *           (input box, status line) that the pane REPAINTS IN PLACE rather than
 *           scrolling. "Every source row exactly once, in order, none lost" is
 *           unattainable for ANY line-based algorithm here — with no terminal
 *           cursor semantics, a fresh paint and a new line are indistinguishable
 *           — so this scenario asserts R1 (no duplication, order, tail,
 *           suppression reported) and nothing stronger. One repainted row also
 *           defeats a suffix/prefix overlap scan for every k, which is what makes
 *           the real DEFECT-1 measurements (40 polls x 1200-line windows ->
 *           40,000-line buffer) reproducible.
 *   long    the buffer runs past 4096 rows, i.e. past any fixed "have I shown
 *           this?" lookback.
 *   deep    one response so stale that its window starts thousands of rows
 *           behind the buffer's end — the regime where a rule-2 that appends
 *           `next.slice(anchor.length)` instead of the genuinely-new tail
 *           re-appends the whole window.
 */
const GROW = 53;

/** Window ends for `polls` polls: monotonic, every `lagEvery`-th served stale. */
function makeEnds({ polls, grow, start, lagEvery, maxLag, rand, deepLag }) {
  const ends = [];
  let end = start;
  let highest = start;
  for (let i = 0; i < polls; i++) {
    if (deepLag && i === deepLag.at) {
      ends.push(Math.max(grow + 1, end - deepLag.back));      // in flight for thousands of rows
    } else if (i > 0 && lagEvery && i % lagEvery === 0) {
      ends.push(Math.max(grow + 1, highest - (20 + Math.floor(rand() * maxLag))));
    } else {
      end += grow;
      ends.push(end);
    }
    highest = Math.max(highest, ends[ends.length - 1]);
  }
  return ends;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Pinned bottom UI, 50 chars wide, repainted each poll by rewriting the last
 * two characters — a spinner / elapsed-time / context-percentage. Successive
 * paints differ by at most two characters and never in length, which is exactly
 * what a "tolerate repainted rows" rule keys off. */
const CHROME = 3;
function paintChrome(i) {
  const n = String(i % 100).padStart(2, '0');
  const t = (s) => s.slice(0, 48) + n;
  return [
    t('  ⏵⏵ bypass permissions on (shift+tab to cycle)'),
    t('  > '),
    t('  ? for shortcuts                     12% context'),
  ];
}

function scenario({ name, tag, polls, start, lagEvery, maxLag, randSeed, deepLag, longRows }) {
  const ends = makeEnds({ polls, grow: GROW, start, lagEvery, maxLag, rand: rng(randSeed), deepLag });
  const last = Math.max(...ends);
  const source = Array.from({ length: last }, (_, i) => `L${pad(i)} ${hash(i)} ${tag}`);
  const windows = ends.map((e, i) => {
    const ws = Math.max(0, e - WINDOW);
    const win = source.slice(ws, e);
    if (!longRows) return win;
    win.length = Math.max(0, win.length - CHROME);      // the newest rows are the pinned UI
    return win.concat(paintChrome(i));
  });
  return {
    name, tag, source, windows, painted: !!longRows,
    indexOf: new Map(source.map((l, i) => [l, i])),
  };
}

const LAG = { polls: 80, start: 200, lagEvery: 4, maxLag: 300 };
const SCENARIOS = [
  scenario({ name: `clean sliding window (${LAG.polls} polls, ${WINDOW}-line window, +${GROW}/poll)`, tag: 'clean', ...LAG, lagEvery: 0, randSeed: 1 }),
  scenario({ name: `lagging in-flight windows (every 4th poll ends 20-320 rows behind the buffer)`, tag: 'lag', ...LAG, randSeed: 2 }),
  scenario({ name: `TUI pinned chrome repainted in place every poll — R3 case: asserts R1, "exactly once" is unattainable for any line-based algorithm`, tag: 'tui', ...LAG, longRows: true, randSeed: 3 }),
  scenario({ name: `long buffer past a 4096-row lookback (120 polls, every 3rd lags)`, tag: 'long', polls: 120, start: 200, lagEvery: 3, maxLag: 400, randSeed: 4 }),
  scenario({ name: `deeply stale response (window starts 6400 rows behind the buffer end)`, tag: 'deep', polls: 140, start: 200, lagEvery: 0, randSeed: 5, deepLag: { at: 139, back: 5200 } }),
];

// ── teeth: the frozen pre-fix browser copy ──────────────────────────────────
/*
 * R2 leaves A and B the same object, so parity alone cannot show that this
 * harness would notice a wrong algorithm. This is the round-2 browser copy —
 * CONTRACT-v2 §0.1's LITERAL rule 2, `next.slice(anchor.length)` — verbatim from
 * public/app.js lines 102-197 as they stood before W2 moved it into
 * public/lib/advance-buffer.js (the same text as _scratch/w1/b-appjs.js).
 * module.exports is dropped because it is loaded here through `new Function`.
 *
 * It is a frozen test fixture, not an implementation: R2's "one implementation"
 * governs what ships, and what ships is public/lib/advance-buffer.js.
 */
const PREFIX_COPY = `
const AB_RECENT = 4096;
const AB_NEAR = 64;

function advanceBuffer(prevLines, nextLines) {
  const prev = prevLines || [];
  const next = nextLines || [];
  if (!prev.length) return { newLines: next.slice(), mode: 'append', rule: '4' };
  if (!next.length) return { newLines: [], mode: 'append', rule: 'noop' };
  const max = Math.min(prev.length, next.length);

  for (let k = max; k > 0; k--) {                                     // rule 1 (exact)
    let bad = false;
    for (let i = 0; i < k; i++) if (prev[prev.length - k + i] !== next[i]) { bad = true; break; }
    if (!bad) return abFinish(prev, next, next.slice(k), 'append', '1');
  }
  for (let k = max; k >= 50; k--) {                                   // rule 1r (repaints)
    const tol = Math.max(1, Math.floor(k / 100));
    let bad = 0;
    for (let i = 0; i < k; i++) if (prev[prev.length - k + i] !== next[i] && ++bad > tol) break;
    if (bad <= tol) return abFinish(prev, next, next.slice(k), 'append', '1r');
  }
  const fresh = abNovelRows(prev, next);                              // rule 1s
  if (fresh.length < next.length) return abFinish(prev, next, fresh, 'append', '1s');

  const anchor = next.slice(0, Math.min(8, next.length));             // rule 2 (anchor)
  for (let p = prev.length - anchor.length; p >= 0; p--) {
    let same = true;
    for (let i = 0; i < anchor.length; i++) if (prev[p + i] !== anchor[i]) { same = false; break; }
    if (same) return abFinish(prev, next, next.slice(anchor.length), 'append', '2');
  }
  return abFinish(prev, next, next.slice(), 'reset', '3');            // rule 3 (reset)
}

function abNovelRows(prev, next) {
  const tail = prev.slice(Math.max(0, prev.length - AB_RECENT));
  const counts = new Map();
  for (let i = 0; i < tail.length; i++) {
    const l = tail[i];
    counts.set(l, (counts.get(l) || 0) + 1);
  }
  const near = prev.slice(Math.max(0, prev.length - AB_NEAR));
  const out = [];
  for (let i = 0; i < next.length; i++) {
    const l = next[i];
    const c = counts.get(l) || 0;
    if (c > 0) { counts.set(l, c - 1); continue; }
    let repaint = false;
    for (let j = 0; j < near.length; j++) if (abIsRepaint(near[j], l)) { repaint = true; break; }
    if (repaint) continue;
    out.push(l);
  }
  return out;
}

function abFinish(prev, next, cand, mode, rule) {
  let out = abTrimShown(prev, cand);
  if (out.length >= 32) {
    const have = new Set(prev.slice(Math.max(0, prev.length - AB_RECENT)));
    let novel = 0;
    for (let i = 0; i < out.length; i++) if (!have.has(out[i])) novel++;
    if (novel / out.length < 0.25) out = [];
  }
  return { newLines: out, mode: mode, rule: rule };
}

function abIsRepaint(a, b) {
  if (!a || !b || a.length !== b.length || a.length < 6) return false;
  let pre = 0;
  while (pre < a.length && a[pre] === b[pre]) pre++;
  if (pre < 2) return false;
  let suf = 0;
  while (suf < a.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return pre + suf >= a.length - 2;
}

function abTrimShown(prev, cand) {
  const max = Math.min(prev.length, cand.length);
  for (let j = max; j > 0; j--) {
    let bad = false;
    for (let i = 0; i < j; i++) if (prev[prev.length - j + i] !== cand[i]) { bad = true; break; }
    if (!bad) return cand.slice(j);
  }
  for (let j = max; j >= 50; j--) {
    const tol = Math.max(1, Math.floor(j / 100));
    let bad = 0;
    for (let i = 0; i < j; i++) if (prev[prev.length - j + i] !== cand[i] && ++bad > tol) break;
    if (bad <= tol) return cand.slice(j);
  }
  return cand;
}
`;
const prefixCopy = new Function(`'use strict';${PREFIX_COPY}\nreturn advanceBuffer;`)();

// ── live capture ────────────────────────────────────────────────────────────
function getJson(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`bad JSON from ${url}: ${body.slice(0, 120)}`)); }
      });
    });
    r.on('timeout', () => { r.destroy(new Error(`timeout after ${timeoutMs}ms: ${url}`)); });
    r.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* How many rows the pane appended between two reads. The anchor has to come
 * from ABOVE the pinned bottom region — a TUI's last rows are permanent UI (the
 * input box, the update banner), so they sit at the end of every window and a
 * distance measured from them is always 0. Returns null when the anchor is gone
 * entirely: the window moved further than its own length, so a poll's worth of
 * output was missed and there is nothing to line up on. */
const PINNED = 15;
function appendedBetween(prevWin, nextWin) {
  const at = prevWin.length - 1 - PINNED;
  if (at < 0) return null;
  const anchor = prevWin[at];
  const want = nextWin.length - 1 - PINNED;
  for (let i = nextWin.length - 1; i >= 0; i--) if (nextWin[i] === anchor) return want - i;
  return null;
}

async function readPane(paneId, lines) {
  const j = await getJson(`${BASE}/api/pane?pane_id=${encodeURIComponent(paneId)}&lines=${lines}&source=recent_unwrapped`);
  if (!j || j.ok === false) throw new Error(`/api/pane failed: ${j && j.error ? JSON.stringify(j.error) : 'no ok field'}`);
  const text = typeof j.text === 'string' ? j.text : '';
  return { lines: text.split('\n'), revision: j.revision, bytes: Buffer.byteLength(text, 'utf8') };
}

/** Poll every pane once, wait, poll again, and take one whose CONTENT moved.
 *  A line count cannot show growth — herdr caps a read at 1000 lines, so a busy
 *  pane's count is pinned — the fingerprint has to come from the text. */
async function pickBusyPane() {
  if (PANE) return PANE;
  const snap = await getJson(`${BASE}/api/snapshot`);
  const panes = (snap.snapshot && (snap.snapshot.panes || [])) || snap.panes || [];
  const ids = panes.map((p) => p.pane_id).filter(Boolean).slice(0, 12);
  if (!ids.length) throw new Error('no panes in /api/snapshot');

  const fingerprint = async (id) => {
    const j = await getJson(`${BASE}/api/pane?pane_id=${encodeURIComponent(id)}&lines=40&source=recent_unwrapped`);
    const t = (j && typeof j.text === 'string') ? j.text : '';
    return `${t.length}:${t.slice(-300)}`;
  };

  const first = new Map();
  for (const id of ids) {
    try { first.set(id, await fingerprint(id)); } catch (e) { first.set(id, null); }
  }
  await sleep(2500);
  const moved = [];
  for (const id of ids) {
    if (first.get(id) === null) continue;
    try { if (await fingerprint(id) !== first.get(id)) moved.push(id); } catch (e) { /* unreadable */ }
  }
  if (!moved.length) {
    info(`no pane is producing output right now (checked ${ids.length}); using ${ids[0]}`);
    return ids[0];
  }
  info(`panes producing output: ${moved.join(', ')} — using ${moved[0]}`);
  return moved[0];
}

/** Sequential tail reads, one per interval — the poll the GUI actually makes. */
async function captureLive() {
  const pane = await pickBusyPane();
  const windows = [];
  const metas = [];
  for (let i = 0; i < POLLS; i++) {
    const r = await readPane(pane, WINDOW);
    windows.push(r.lines);
    metas.push({ revision: r.revision, lines: r.lines.length, bytes: r.bytes });
    if (i < POLLS - 1) await sleep(INTERVAL);
  }
  return { pane, windows, metas };
}

// ── run the scenarios ───────────────────────────────────────────────────────
function runScenario(scn) {
  head(scn.name);
  const pos = sourcePositions(scn.source);
  const ceiling = duplicationCeiling(scn);
  const rows = `${scn.source.length} source rows`;

  if (B && A !== B) {
    const d = firstDivergence(scn.windows);
    check('parity  A and B produce byte-identical buffers', () => {
      if (d) {
        dumpDivergence(scn.name, d);
        return { ok: false, detail: `diverged at poll #${d.i}: A appended ${d.na.length} (rule ${d.ruleA}), B appended ${d.nb.length} (rule ${d.ruleB})` };
      }
      return { ok: true };
    });
  }

  const v1 = replay(v1Rule, scn.windows);

  for (const { label, fn } of COPIES) {
    const r = replay(fn, scn.windows);
    check(`R1.1 no duplication (${label}, ${rows})`, () => noDuplication(r.buf, ceiling));
    check(`R1.2 order — the buffer is a subsequence of the source (${label})`, () => orderCheck(r.buf, pos));
    check(`R1.3 tail — the buffer ends where the pane ends (${label})`, () => tailCheckSynthetic(r.buf, scn, label));
    const sup = suppressionReport(r.buf, scn.windows);
    check(`R1  suppression is reported, not failed (${label})`, () => ({ ok: true, detail: sup.detail }));
    if (!scn.painted && label === COPIES[0].label) {
      check('exact   the buffer equals the source element for element', () => ({
        ok: eqArr(r.buf, scn.source),
        detail: `buffer ${r.buf.length} lines vs source ${scn.source.length}`,
      }));
    }
    info(`appended per poll (${label}): ${r.trace[0].appended}…${r.trace[r.trace.length - 1].appended}; buffer ${r.buf.length} lines; rules ${[...new Set(r.trace.map((t) => t.rule))].join(',')}`);
  }

  const v1Detail = `v1 buffer ${v1.buf.length} lines vs source ${scn.source.length}`;
  if (scn.tag === 'clean') {
    check('v1      mergeStream is CORRECT here, so it must agree (no lag, no repaint)', () => ({
      ok: eqArr(v1.buf, scn.source),
      detail: v1Detail,
    }));
  } else {
    check('v1      mergeStream re-appends rows it already has (DEFECT-1 teeth)', () => ({
      ok: v1.buf.length > scn.source.length,
      detail: `${v1Detail} — ${v1.buf.length - scn.source.length} rows duplicated (x${(v1.buf.length / scn.source.length).toFixed(1)})`,
    }));
  }
}

for (const scn of SCENARIOS) runScenario(scn);

// ── teeth ───────────────────────────────────────────────────────────────────
head('teeth — the frozen pre-fix copies must still duplicate');
const deep = SCENARIOS.find((s) => s.tag === 'deep');
const pre = replay(prefixCopy, deep.windows);
check('teeth  the frozen round-2 browser copy violates R1.1 (a row the source holds once appears twice)', () => {
  const r = noDuplication(pre.buf, duplicationCeiling(deep));
  return {
    ok: !r.ok,
    detail: r.ok
      ? 'the pre-fix copy did NOT duplicate — these assertions have gone blind and must be fixed'
      : `${r.detail} — the DEFECT-1 failure mode, still reproducible`,
  };
});
check('teeth  its duplication is a whole window re-appended (the §0.1 evidence)', () => {
  const excess = pre.buf.length - deep.source.length;
  return {
    ok: excess > 0 && pre.trace.some((t) => t.rule === '2' && t.appended > 100),
    detail: `${excess} extra rows for ${deep.source.length} source rows; the first big rule-2 append was ${(() => { const t = pre.trace.find((x) => x.rule === '2' && x.appended > 100); return t ? `${t.appended} lines at poll #${t.i} (buffer was ${t.bufLen - t.appended} lines, window ${t.winLen})` : 'none'; })()}`,
  };
});
check('teeth  the harness still finds a divergence when the copies differ (A vs the pre-fix copy)', () => {
  const d = divergeWith(prefixCopy, deep.windows);
  return {
    ok: !!d,
    detail: d ? `poll #${d.i}: A appended ${d.na.length} (rule ${d.ruleA}), the pre-fix copy appended ${d.nb.length} (rule ${d.ruleB})` : 'no divergence found — the comparison machinery is broken',
  };
});

/* firstDivergence() compares the module-level A and B; this is the same walk for
 * an arbitrary second copy, so the teeth do not depend on B being loaded. */
function divergeWith(other, windows) {
  let bufA = [];
  let bufO = [];
  for (let i = 0; i < windows.length; i++) {
    const ra = A(bufA, windows[i]) || {};
    const ro = other(bufO, windows[i]) || {};
    const na = Array.isArray(ra.newLines) ? ra.newLines : [];
    const no = Array.isArray(ro.newLines) ? ro.newLines : [];
    bufA = bufA.concat(na);
    bufO = bufO.concat(no);
    if (na.length !== no.length || !eqArr(bufA, bufO)) {
      return { i, na, nb: no, ruleA: ra.rule || ra.mode, ruleB: ro.rule || ro.mode };
    }
  }
  return null;
}

const synthEnd = results.length;
const synthPass = results.filter((r) => r.ok).length;

// ── live ────────────────────────────────────────────────────────────────────
if (NO_LIVE) {
  console.log('\nSKIP  live capture (--no-live)');
} else {
  head(`live capture on ${BASE}`);
  try {
    const cap = await captureLive();
    const lens = cap.metas.map((m) => m.lines);
    const revs = new Set(cap.metas.map((m) => m.revision));
    const prints = new Set(cap.windows.map((w) => w.join('\n')));
    info(`${cap.pane}: ${cap.windows.length} polls x ${WINDOW}-line window, ${Math.min(...lens)}-${Math.max(...lens)} lines returned, ${revs.size} distinct revisions, ${prints.size} distinct window contents`);

    const gaps = [];
    for (let i = 1; i < cap.windows.length; i++) gaps.push(appendedBetween(cap.windows[i - 1], cap.windows[i]));
    const known = gaps.filter((g) => g !== null).sort((a, b) => a - b);
    const missed = gaps.filter((g) => g === null).length;
    info(`the pane appended ${known.length ? `median ${known[Math.floor(known.length / 2)]} rows` : 'no measurable rows'} between polls (min ${known[0] === undefined ? '-' : known[0]}, max ${known[known.length - 1] === undefined ? '-' : known[known.length - 1]}); ${missed} poll(s) moved further than a whole window`);

    /* A capture where the window never changes proves nothing: every copy
     * appends nothing and every check passes vacuously. Say so out loud. */
    check('live    the capture actually moved (the window is not frozen)', () => ({
      ok: prints.size > 1,
      detail: prints.size > 1 ? `${prints.size} of ${cap.windows.length} polls differed from their predecessor` : `all ${cap.windows.length} polls returned identical text — pass --pane <id> with a pane that is producing output`,
    }));

    if (B && A !== B) {
      const d = firstDivergence(cap.windows);
      if (d) {
        dumpDivergence('live capture', d);
        warn('parity  A and B diverged on the live capture', `poll #${d.i}: A appended ${d.na.length}, B appended ${d.nb.length} — see the dump above`);
      } else {
        info('A and B agreed on every poll of the live capture');
      }
    } else {
      info('A and B are one function object (R2), so there is nothing to compare live');
    }

    const ra = replay(A, cap.windows);
    const newestWin = cap.windows[cap.windows.length - 1];
    const windowSum = cap.windows.reduce((n, w) => n + w.length, 0);
    const ceiling = Math.max(WINDOW * 2, cap.windows[0].length * 2);

    /* The live forms of R1 are the ones a capture can support without ground
     * truth; each says in its detail what it can and cannot see. Per-row
     * completeness against a live pane is NOT assertable: a TUI rewrites its
     * bottom rows in place and an append-only transcript is right to keep the
     * older paint, so the rows that never reach the buffer are reported as
     * suppression (above) rather than counted as loss. */
    check('R1.1 no duplication (live: a row may not exceed its occurrence count across all windows)', () => looseDuplication(ra.buf, cap.windows));
    check('R1.2 order (live: each poll appends a subsequence of its own window — no invention, no reordering)', () => appendedIsSubsequence(A, cap.windows));
    check('R1.3 tail (live: the buffer ends on a row the pane\'s newest read still contains)', () => tailCheckLive(ra.buf, newestWin));
    const sup = suppressionReport(ra.buf, cap.windows);
    check('R1  suppression is reported, not failed (live)', () => ({ ok: true, detail: sup.detail }));

    /* Retention, not per-row completeness: a correct append-only buffer never
     * holds less than one whole window, because every window it consumed is
     * still in it. A copy that drifts loses rows and ends up shorter than the
     * window it just read. */
    const newestLen = newestWin.length;
    check(`A ok    the buffer retains at least a whole window (>= ${newestLen} lines)`, () => ({
      ok: ra.buf.length >= newestLen,
      detail: `A buffer ${ra.buf.length} lines`,
    }));
    check('ok      the buffer did not balloon (the DEFECT-1 check)', () => ({
      ok: ra.buf.length <= ceiling,
      detail: `A ${ra.buf.length} lines after ${cap.windows.length} windows totalling ${windowSum} lines (ceiling ${ceiling})`,
    }));
    const v1 = replay(v1Rule, cap.windows);
    check('v1      mergeStream still reproduces DEFECT-1 on the live capture (teeth)', () => ({
      ok: v1.buf.length > windowSum * 0.5,
      detail: `v1 buffer ${v1.buf.length} lines for ${windowSum} lines of windows (x${(v1.buf.length / Math.max(1, windowSum)).toFixed(2)})`,
    }));
  } catch (e) {
    console.log(`FAIL  live capture: ${e && e.message ? e.message : e}`);
    console.log(`        (is a herdr-dash server listening on ${BASE}? start one, or pass --no-live)`);
    results.push({ name: 'live capture', ok: false });
    failures++;
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const passCount = results.filter((r) => r.ok).length;
const liveTotal = results.length - synthEnd;
const livePass = passCount - synthPass;
console.log(`\nA = src/hdr.js   B = ${B_HOW ? B_HOW : `${bRel} (not in the tree — A alone)`}`);
console.log(`SYNTHETIC: ${synthPass}/${synthEnd} passed`);
console.log(`LIVE:      ${NO_LIVE ? 'skipped (--no-live)' : `${livePass}/${liveTotal} passed`}`);
console.log(`TOTAL: ${passCount}/${results.length} passed${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
const r1 = results.filter((r) => !r.ok && /^R1/.test(r.name));
console.log(`R1: ${r1.length ? `${r1.length} VIOLATION(S) — ${r1.map((r) => r.name).join('; ')}` : 'no duplication, ordering or tail violation'}`);
if (failures) {
  console.log('\nFAILED:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}`);
}
if (warnings.length) {
  console.log('\nWARNINGS (reported, not judged):');
  for (const w of warnings) console.log(`  - ${w.name}`);
}
process.exit(failures ? 1 : 0);
