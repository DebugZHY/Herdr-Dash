'use strict';
/*
 * src/paths.js — POST /api/pathinfo and POST /api/open (CONTRACT-v2 §13.2.3/5/6/7,
 * round 9, owner W1).
 *
 * §13.2 turns the absolute paths an agent writes into links, and the two things a
 * link can then do are LOCAL actions: ask whether a path exists, and hand one to
 * the system. Both are small, and both are the kind of small that is dangerous —
 * an endpoint that opens what it is told to open is a remote-control for the
 * desktop. This module is the only place in the app that spawns a process.
 *
 * WHAT IT GUARANTEES (each one is a test in the local test suite)
 *
 *   Only the browser that is already looking at this app may ask. §13.2.6: a
 *   request needs `x-hd-action: 1` AND (`Sec-Fetch-Site: same-origin` OR an
 *   `Origin` of the app itself). Anything else is 403 and NOTHING happens — the
 *   gate runs before the body is even read, so a refused request costs no work and
 *   has no side effect. The app's own origin is judged from the request's Host, not
 *   from a trusted list: the point is to refuse a FOREIGN Origin, which a browser
 *   cannot forge, not to authenticate a caller (anything that can reach a loopback
 *   socket can set every header it likes — measured, and why the custom header is
 *   the real gate: a cross-site page cannot set it without a preflight this server
 *   never answers).
 *
 *   Loopback only. These two endpoints act on THIS machine, so a request whose
 *   peer is not a loopback address is refused even if every header is right. The
 *   server already binds 127.0.0.1 by default; this is the same rule applied at
 *   the socket, so `--host 0.0.0.0` does not silently publish a desktop opener.
 *
 *   The path is ONE argument. `spawn('explorer.exe', [path])` — an argv array, no
 *   shell, ever. A space, a quote or a `&` in the path therefore cannot change what
 *   is executed; measured (§13.0) with a path containing spaces. `reveal` is
 *   `/select,<path>` as ONE element, which is the form §13.0 verified focuses the
 *   item in its folder.
 *
 *   Nothing is spawned that was not asked for. Every action is whitelisted, a path
 *   that does not exist is a 404, and `reveal` on a directory is a 400 — all three
 *   answer before `spawn` is reached (the local test suite proves the spawn is never
 *   called, not merely that the answer was an error).
 *
 *   Never a claim about the exit code. §13.0 measured that `explorer.exe` exits 1
 *   even when it worked, so the exit code is not read at all: the answer says what
 *   was DONE ("handed to the system") and nothing about what the system then did,
 *   and the child's exit is never logged as success or failure. The one failure
 *   this module does report is its own — the OS refusing to create the process,
 *   which is a real error and is answered as one.
 *
 *   Every action is logged. One line per spawn with the time, the path, the action
 *   and the argv, so an action can be audited after the fact. Refusals log nothing:
 *   they performed nothing.
 *
 *   The cache never lies about the file it is caching. `pathinfo` keeps a short TTL
 *   entry per path (§13.2.3) so a screenful of paths re-asked by a re-render costs
 *   one `stat` per path per TTL — and at the TTL the path is re-stated, with the
 *   mtime (and the kind) deciding whether the cached verdict still describes the
 *   file: a directory replaced by a file, or a file replaced in place, is seen on
 *   the first call after the TTL. Inside the TTL the cached verdict is served
 *   as-is, which is why a path deleted a moment ago can still answer exists:true
 *   for up to the TTL — and a click then refuses with the honest 404.
 *
 *   No stat can hold the server. Measured on this machine: `fs.statSync` of a path
 *   on an unreachable UNC host (`\\192.0.2.1\share\x`) blocks its caller for 42,155
 *   ms. The server is one thread, so a synchronous stat of a hostile path in a pane's
 *   text would freeze every other endpoint — `/api/chat` included — for that long.
 *   Every stat here is therefore asynchronous (it waits in the thread pool, not in the
 *   event loop) and carries a deadline (HD_PATHINFO_DEADLINE_MS, 2500 ms).
 *
 *   A deadline is NOT a verdict, and §13.11 is the section that says so. It fires when
 *   the filesystem never ANSWERED — measured, and the mechanism of the round-9.10 false
 *   negatives: four stats of an unreachable host hold all four libuv pool threads (libuv
 *   cannot cancel a stat; the OS keeps the thread until it returns), so every later stat
 *   — of a directory sitting right there — is queued, not slow, and the deadline fires
 *   for all of them. Measured on demand: 8 concurrent batches × 30 existing paths
 *   answered 0/240 `exists:true`, in 2,520 ms, three rounds running, while a plain
 *   `fs.statSync` of the same paths in another process answered in 0 ms. Reported as
 *   `exists:false` that is a page-load burst of links that all 404 — the user's
 *   "clicking a link does nothing for a while after a page load".
 *
 *   So there are THREE outcomes here, not two (§13.11 items 1–3): a measured existence;
 *   a measured ABSENCE (the filesystem answered "no such path" — ENOENT/ENOTDIR); and
 *   `unaskable` (the deadline, or any error that never asked the question: EMFILE,
 *   EACCES, EIO). `missing` is written by exactly one code path — the measured-absence
 *   branch, which logs every write — and the unaskable branch carries no `missing` key
 *   at all, so the code path §13.11 item 2 forbids is not reachable from it. An
 *   unaskable path is answered with the last verdict this process MEASURED for it (a
 *   memory of a real answer is what is left when the filesystem cannot be reached), or,
 *   when there is no memory at all, as `exists:true, kind:null, undecided:true`: a link
 *   is not thrown away over a question nobody answered, and `open` hands such a path
 *   over and lets Explorer be the judge (§13.11 item 1). Nothing is ever cached from an
 *   unaskable stat, so the answer stays the same ask to ask and a path that becomes
 *   reachable again is found on the next call rather than after the TTL.
 *
 *   The path handed to the shell is in NATIVE Windows form (§13.2 errata 9, measured):
 *   `explorer.exe` does not accept forward slashes. `open` with `C:/…/dir` opened
 *   **Documents** while the API answered 200 "handed to the system" — three runs, the
 *   same wrong window each time, and Hermes hit the same thing through the live UI with
 *   a path carrying forward slashes AND a trailing one. So before anything else a path
 *   is normalised (`/` → `\`, a UNC's or namespace's leading `\\` kept, a trailing
 *   separator dropped, nothing else rewritten), the existence test runs on that
 *   normalised path, the spawn gets that normalised path, and `/api/open`'s reply
 *   echoes **the normalised path that was handed over**, never the raw request string.
 *   Because agent text and therefore §13.2's candidates commonly use `/`, this is the
 *   main path, not an edge case. A trailing separator is dropped because it names no
 *   component: it is the same directory either way, and the spelling whose correctness
 *   is actually measured is the one without it (`C:\…\dir`), so that is the one that
 *   goes to the shell. A drive root (`C:\`) and a server root (`\\server\`) are never
 *   stripped — `C:` and `C:\` are different paths.
 *
 *   A candidate may also be an MSYS form (§13.2.2 lists `/c/…` as a candidate class).
 *   `/c/dir` is read as `C:\dir`: `/` plus a single-letter first component names a
 *   drive. The alternative reading — a rooted path `\c\dir` on whatever drive this
 *   process happens to run on — depends on that drive and is not something a user
 *   writing `/c/…` can mean. So the MSYS shape is translated once at the top, and the
 *   two endpoints agree about it by construction because both go through the same
 *   function. Nothing else is rewritten: a trailing space or dot is left alone, and
 *   `\\?\`/`\\.\` paths are passed through untouched, because there the OS's own rule
 *   is to read the string literally.
 *
 *   Known honest degradation (measured, reported rather than papered over): Windows'
 *   *shell* ignores a trailing space or dot in a path (`cmd /c dir /b "plain.txt "`
 *   and PowerShell `Test-Path 'plain.txt.'` both resolve to `plain.txt`), while Node's
 *   own `fs` — which reads paths in the `\\?\` style internally — answers ENOENT for
 *   both. Such a path is therefore answered `exists:false` here and `open` refuses it
 *   with `not_found`, even though Explorer would have resolved it. Rewriting it to its
 *   stripped form would mean the string judged and handed over was no longer the string
 *   that was asked about, which §13.2 errata 9 rules out ("rewrite nothing else"); the
 *   degradation is also in the safe direction — a path stays plain text, and no wrong
 *   window is opened under a claim of success.
 *
 *   Case is left exactly as typed: Windows matches it case-insensitively (measured:
 *   `C:\WINDOWS` and `c:\windows` are one directory), which is why two spellings of one
 *   path answer identically, but folding case in the cache key would be a lie on a
 *   case-sensitive directory, so each spelling is stated on its own. `pathinfo`'s
 *   item `path` is always the string that was asked about — it is the key a client
 *   matches its own candidate by — while `exists`/`kind` describe what was stat'ed;
 *   `open`'s `path` is the normalised path handed over, as errata 9 requires.
 */

const fsp = require('node:fs');
const { spawn } = require('node:child_process');

const LIMITS = {
  MAX_PATHS: 200,             // §13.2.3: at most 200 paths per call
  MAX_PATH_CHARS: 32767,      // the longest string Windows calls a path (a longer one is not a path)
  CACHE_MAX_ENTRIES: 4096,    // 20 screenfuls of DISTINCT paths — a bound on the map, not on an answer
};

/** §13.2.3's "short TTL": short enough that a path the agent just created becomes a
 *  link within a couple of seconds, long enough that a re-render does not re-stat a
 *  whole screenful. Overridable so a test can watch the TTL happen. */
const TTL_MS = (() => {
  const n = Number(process.env.HD_PATHINFO_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
})();

/** §13.2.5's two actions, whitelisted: `reveal` is a file-only action. */
const ACTIONS = new Set(['open', 'reveal']);

/** How long one path may go undecided before the stat is abandoned and the path is
 *  answered as unaskable (see the header: §13.11 item 2 — never as `exists:false`).
 *  A synchronous stat of an unreachable UNC path was measured at 42,155 ms, which on
 *  this server's one thread is 42 s of everything else not answering. The default is
 *  generous enough for a real network share and short enough that a screenful of
 *  hostile paths cannot outlast a user's patience. */
const DEADLINE_MS = (() => {
  const n = Number(process.env.HD_PATHINFO_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? n : 2500;
})();

/** The `\\?\` / `\\.\` prefixes — Windows' own escape from path interpretation: inside
 *  one, a path is read literally, so nothing here may rewrite it. */
const NAMESPACE = /^\\\\[?.]\\/;

/** A trailing separator names no further component: `C:\a\b\` and `C:\a\b` are one
 *  directory to every API there is, so dropping it changes no path — while keeping it
 *  would hand the shell a spelling nobody has verified. Measured (Hermes, live): the
 *  click that opened **Documents** carried forward slashes AND a trailing forward
 *  slash, so the shape that must go to the shell is the one whose correctness IS
 *  measured — `C:\…\scratch`, not an untested `C:\…\scratch\`. A drive root (`C:\`) and
 *  a server root (`\\server\`) are left alone: `C:` and `\\server` are DIFFERENT paths
 *  (drive-relative and a bare server name), so this must never strip those.
 *  Pure. */
function dropTrailingSeparator(t) {
  if (t.length < 2 || !/[\\/]$/.test(t)) return t;
  const cut = t.replace(/[\\/]+$/, '');
  if (cut === '' || /^[A-Za-z]:$/.test(cut) || /^\\\\[^\\]+$/.test(cut)) return t;
  return cut;
}

/** §13.2 errata 9: the path as it must be handed to the shell — native Windows form,
 *  `/` → `\`, prefixes kept, a trailing separator dropped (see above), nothing else
 *  rewritten. The one translation beyond the slashes is §13.2.2's MSYS candidate class
 *  (`/c/dir` → `C:\dir`). Pure, and idempotent, so both endpoints can call it and
 *  agree. */
function nativePath(p) {
  if (typeof p !== 'string' || p === '' || NAMESPACE.test(p)) return p;
  if (p.charCodeAt(0) === 47 /* '/' */) {
    const msys = /^\/([A-Za-z])(?:\/|$)/.exec(p);
    if (msys) {
      const rest = p.slice(2);
      return dropTrailingSeparator(msys[1].toUpperCase() + ':' + (rest === '' ? '\\' : rest.replace(/\//g, '\\')));
    }
  }
  return dropTrailingSeparator(p.replace(/\//g, '\\'));
}

// ── who may ask ─────────────────────────────────────────────────────────────

const LOOPBACK_V4 = /^127\./;
const LOOPBACK_V6 = /^::ffff:127\./;

/** §13.2.6's first rule, at the socket: only a loopback peer may ask. 127.0.0.0/8 is
 *  all loopback (Windows included), and `::1` is its v6 form. Pure, so the table can
 *  be tested without two network interfaces. */
function isLoopback(req) {
  const a = req && req.socket && req.socket.remoteAddress;
  if (typeof a !== 'string' || a === '') return false;
  return a === '::1' || a === 'localhost' || LOOPBACK_V4.test(a) || LOOPBACK_V6.test(a);
}

/** §13.2.6's second rule: `Sec-Fetch-Site: same-origin`, or an `Origin` naming this
 *  app. A browser sets both, and cannot be made to set either to a foreign value for
 *  a request to us. */
function sameOriginOrApp(req) {
  const site = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase();
  if (site === 'same-origin') return true;
  const origin = (req.headers && req.headers.origin) || '';
  if (!origin) return false;
  let u;
  try {
    u = new URL(origin);
  } catch (e) {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const loop = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  if (!loop) return false;
  // The port must be this app's port, taken from the request's own Host — a browser
  // sets Host too, so a foreign page cannot make the two agree on this app.
  const hostPort = String((req.headers && req.headers.host) || '').replace(/^.*:/, '');
  return !u.port || !hostPort || u.port === hostPort;
}

/** The whole §13.2.6 gate. Returns null when the request may proceed. */
function guard(req) {
  if (!isLoopback(req)) {
    return { code: 'forbidden', message: 'this endpoint acts on the local machine and only answers a loopback connection (§13.2.6)' };
  }
  if (String((req.headers && req.headers['x-hd-action']) || '') !== '1') {
    return { code: 'forbidden', message: 'the header "x-hd-action: 1" is required — it is what a cross-site page cannot send (§13.2.6)' };
  }
  if (!sameOriginOrApp(req)) {
    return { code: 'forbidden', message: 'the request must come from this app: "Sec-Fetch-Site: same-origin" or an Origin of the app is required (§13.2.6)' };
  }
  return null;
}

// ── pathinfo ────────────────────────────────────────────────────────────────

const cache = new Map();      // shellTarget -> {exists, kind, at, key}; see the header
let statCount = 0;            // test seam: proves the TTL bounds the re-stats

/** The one call to the filesystem, behind a seam so a test can prove what happens when
 *  it never answers — the case the deadline exists for and the case no real path on a
 *  working machine can be made to produce on demand. Same shape as the injectable
 *  spawner: production always gets `fs.promises.stat`. */
let statImpl = (target) => fsp.promises.stat(target);

class Undecided extends Error {}   // the deadline fired; see the header

/** `stat` of a target (already in shell form) reduced to one of the three outcomes in
 *  the header. Returns `{verdict, exists, kind, key}` — or `{verdict: 'unaskable'}`,
 *  which is the absence of an answer and carries no `key` at all, so it cannot be
 *  stored under `missing` by any caller (§13.11 item 2). Never throws, never blocks
 *  the event loop. */
async function statTarget(target) {
  statCount++;
  const t0 = Date.now();
  const stat = statImpl(target);
  // The deadline below may abandon this promise while the thread pool is still
  // waiting on it (a UNC stat cannot be cancelled), so its rejection is swallowed
  // here rather than surfacing as an unhandled rejection later.
  stat.catch(() => {});
  let timer;
  try {
    const st = await Promise.race([
      stat,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Undecided()), DEADLINE_MS); }),
    ]);
    clearTimeout(timer);
    const kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
    return { verdict: 'exists', exists: true, kind, key: `${kind}:${st.mtimeMs}:${st.size}` };
  } catch (e) {
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (e instanceof Undecided) {
      // The filesystem never answered. Not the same thing as "not there" — the reason
      // may be this machine (the thread pool is full of stats that cannot return, which
      // is the measured round-9.10 mechanism) or the host (a share that does not reply).
      // Either way there is no verdict here, so nothing is written and nothing is cached:
      // §13.11 item 2 forbids answering an undecided path with exists:false, and §13.7
      // item 2 forbids remembering one.
      console.log('[hd-pathinfo] ' + JSON.stringify({
        time: new Date().toISOString(), path: target, verdict: 'unaskable', undecided: true, why: 'deadline',
        after_ms: DEADLINE_MS, waited_ms: ms,
        message: 'no answer from the filesystem before the deadline — answered from the last measured verdict, or as an unverified path: never cached, never reported missing (§13.11 item 2)',
      }));
      return { verdict: 'unaskable', why: 'deadline', ms };
    }
    const code = (e && e.code) || null;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // The one and only way a `missing` verdict is born (§13.11 item 2): the filesystem
      // ANSWERED the question — it is not there. Every write of that key is logged here,
      // which is what makes the writer auditable.
      console.log('[hd-pathinfo] ' + JSON.stringify({
        time: new Date().toISOString(), path: target, verdict: 'missing', why: 'stat:' + code, waited_ms: ms,
        message: 'the filesystem answered "no such path" — the only code path that writes a negative verdict (§13.11 item 2)',
      }));
      return { verdict: 'absent', exists: false, kind: null, key: 'missing', code };
    }
    // Any other error is the filesystem declining to answer: too many open files, a
    // permission that stops the QUESTION rather than the path, an IO error. That is not
    // evidence of absence (the path may well be there and Explorer may well open it), so
    // it is not a verdict either.
    console.log('[hd-pathinfo] ' + JSON.stringify({
      time: new Date().toISOString(), path: target, verdict: 'unaskable', why: 'stat:' + code, waited_ms: ms,
      message: `the stat did not answer the question: ${String((e && e.message) || e).slice(0, 240)} — not a verdict, so not cached and not reported missing (§13.11 item 2)`,
    }));
    return { verdict: 'unaskable', why: 'stat:' + code, ms };
  }
}

/** §13.2.3's answer for one path, cached for TTL_MS. The cached verdict is about the
 *  NORMALISED target, so the two spellings of one path (`C:/x` and `C:\x`) share an
 *  entry and cannot contradict each other; `path` echoes the string that was asked
 *  about, which is what a client matches its own candidate by.
 *
 *  An answer is `{path, exists, kind}` and, when the filesystem never answered, also
 *  `undecided: true`. That extra field is what lets a client tell a measured "yes" from
 *  an unasked question (§13.11 item 5): an undecided answer must not cost the user their
 *  link, and only the client knows whether it would. */
async function info(p, opts) {
  // `opts.freshNegative` is what §13.7 item 2 asks of `open`: never act on a REMEMBERED
  // "not there". A positive may be trusted — a file that exists does not stop existing
  // because of a cache — but a negative is the one verdict that must not outlive its
  // cause, so the opener re-states instead of opening nothing on a memory. The cost is
  // one stat, and only when the memory says no.
  const freshNegative = !!(opts && opts.freshNegative);
  const target = nativePath(p);
  const now = Date.now();
  const hit = cache.get(target);
  if (hit && now - hit.at < TTL_MS && !(freshNegative && !hit.exists)) {
    return { path: p, exists: hit.exists, kind: hit.kind };
  }
  const st = await statTarget(target);
  // §13.11 items 1–3: the filesystem was never ASKED, or never answered. That is not
  // "not there" — a directory sitting right there answers this way when the thread pool
  // is full of stats that cannot return (measured: 0/240 exists:true for a burst of
  // existing paths while four hostile stats held the pool) — so it is never written as
  // `missing` and never answered `exists:false`. What is left to answer is the last
  // verdict this process MEASURED for the target, of whatever age: a real answer about
  // this path beats a guess about it, and answering it the same way every time is what
  // §13.11 item 3 asks for. Nothing is written to the cache here, so no memory is
  // created out of a question nobody answered.
  if (st.verdict === 'unaskable') {
    if (hit) {
      console.log('[hd-pathinfo] ' + JSON.stringify({
        time: new Date().toISOString(), event: 'unaskable_remembered', undecided: true, path: target,
        why: st.why, answered: hit.exists, kind: hit.kind, age_ms: now - hit.at,
      }));
      return { path: p, exists: hit.exists, kind: hit.kind, undecided: true, why: st.why };
    }
    // No memory of this path at all. The one answer §13.11 item 2 leaves: not false.
    // The cost of this direction is a link to a path that may not be there, and it is
    // the direction the contract chooses — Explorer is the judge of existence when a
    // click lands, and a click that opens nothing is worse than a link that was never
    // needed. `kind:null` says "a path, but I did not see what it is"; the item's
    // `undecided` says why.
    console.log('[hd-pathinfo] ' + JSON.stringify({
      time: new Date().toISOString(), event: 'unaskable_unverified', undecided: true, path: target,
      why: st.why, answered: true,
      message: 'no measured verdict for this path and no answer from the filesystem: answered exists:true, kind:null, undecided:true — not cached (§13.11 item 2)',
    }));
    return { path: p, exists: true, kind: null, undecided: true, why: st.why };
  }
  if (hit && hit.key === st.key) {
    hit.at = now;                        // same file: keep the entry, reset its clock
    return { path: p, exists: hit.exists, kind: hit.kind };
  }
  // The map is keyed by target and would otherwise grow with every distinct path the
  // agent ever mentions in a long session. The cap is not a limit on what can be
  // asked — a full answer is always computed — it only bounds what is REMEMBERED:
  // expired entries go first, and if that is not enough the map starts over (the
  // next call re-states, which is what a miss costs anyway).
  if (cache.size >= LIMITS.CACHE_MAX_ENTRIES && !cache.has(target)) {
    for (const [k, v] of cache) if (now - v.at >= TTL_MS) cache.delete(k);
    if (cache.size >= LIMITS.CACHE_MAX_ENTRIES) cache.clear();
  }
  cache.set(target, { exists: st.exists, kind: st.kind, at: now, key: st.key });
  return { path: p, exists: st.exists, kind: st.kind };
}

/** §13.2.3's request shape. Returns {paths} or {error, code}. */
function normalizePaths(body) {
  const list = body && body.paths;
  if (!Array.isArray(list)) {
    return { code: 'bad_request', error: 'the body must carry "paths": an array of absolute path strings, e.g. {"paths":["C:\\\\dir\\\\file.txt"]}' };
  }
  if (list.length > LIMITS.MAX_PATHS) {
    return { code: 'too_many_paths', error: `at most ${LIMITS.MAX_PATHS} paths per call (§13.2.3), got ${list.length}` };
  }
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (typeof p !== 'string' || p === '') {
      return { code: 'bad_request', error: `paths[${i}] must be a non-empty string` };
    }
    if (p.length > LIMITS.MAX_PATH_CHARS) {
      return { code: 'bad_request', error: `paths[${i}] is ${p.length} characters — longer than the ${LIMITS.MAX_PATH_CHARS} Windows gives a path` };
    }
    if (/[\u0000\r\n]/.test(p)) {
      return { code: 'bad_request', error: `paths[${i}] contains a null byte or a newline — that is not a path` };
    }
  }
  return { paths: list.slice() };
}

// ── open ────────────────────────────────────────────────────────────────────

/** The handler §13.2.5 names. `explorer.exe` is the product behaviour; the override
 *  exists so a harness can observe the ARGV without opening a window on a working
 *  desktop (the local test suite points it at node and reads the audit line, so no
 *  Explorer window is ever created by the suite — and no existing window can be
 *  navigated away from the user, which `explorer /select,` does when Explorer is
 *  set to reuse one window). Same shape as the server's existing GIT_BIN_PATH knob. */
function openExe() {
  const v = process.env.HD_OPEN_EXE;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : 'explorer.exe';
}

/** The file name of an exe path, without pulling in `node:path` for one comparison. */
function baseName(exe) {
  const s = String(exe || '');
  const cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return (cut >= 0 ? s.slice(cut + 1) : s).toLowerCase();
}

/** Should the child's console window be hidden? Yes for anything that can own one —
 *  but NOT when we are handing a path to the Windows shell (§13.7 item 1).
 *
 *  Measured on this machine, `explorer.exe <folder>` spawned both ways into fresh
 *  folders, with NO helper and NO ShowWindow anywhere, watching the top-level window
 *  list (a claim of "no window is created at all" would be wrong — one is):
 *    windowsHide:true   -> `CabinetWClass`, title `File Explorer`, WS_VISIBLE = 0
 *    windowsHide:false  -> the same window, WS_VISIBLE = 1, on screen and in front
 *  Node's `windowsHide` becomes a STARTUPINFO asking for SW_HIDE, and Explorer hands
 *  that show-state on to the folder window it creates. So the flag whose whole job was
 *  to stop a console from flashing was also the reason the user saw "handed to the
 *  system" and nothing else, and why the raise helper had to show a window itself:
 *  the window arrives hidden. Explorer owns no console, so dropping the flag for it
 *  costs nothing; every other target keeps it. */
function hidesConsole(exe) {
  return baseName(exe) !== 'explorer.exe';
}

/** §13.2.5's argv, as a value so the shape itself is testable: exactly two elements
 *  for both actions, the second one the whole path (or the whole `/select,<path>`).
 *  Never a shell string, so nothing in the path can be re-interpreted. */
function argvFor(action, p) {
  return [openExe(), action === 'reveal' ? '/select,' + p : p];
}

/** The log line §13.2.6 asks for: time, path, action — plus the argv, because that
 *  is what actually ran. One JSON object per line on stdout. The child's exit code is
 *  deliberately not here: §13.0 measured it is 1 even on success, so logging it would
 *  invite exactly the misreading the contract forbids. `path` is the NORMALISED path
 *  that was handed over and `requested` appears only when the two differ, so the audit
 *  shows the normalisation when it happened and stays uncluttered when it did not. */
function logAction(action, p, argv, pid, requested) {
  const line = {
    time: new Date().toISOString(),
    action,
    path: p,
    argv,
    pid: pid === undefined ? null : pid,
  };
  if (requested !== undefined && requested !== p) line.requested = requested;
  console.log('[hd-open] ' + JSON.stringify(line));
}

/** Spawn, and report the truth about what happened. `spawn` is injectable so the
 *  suite can prove the argv without opening a window on the developer's desktop;
 *  production always uses child_process.spawn. */
function launch(action, p, spawnImpl, requested) {
  const argv = argvFor(action, p);
  const doSpawn = spawnImpl || spawn;
  let child;
  try {
    child = doSpawn(argv[0], argv.slice(1), { shell: false, windowsHide: hidesConsole(argv[0]), detached: false, stdio: 'ignore' });
  } catch (e) {
    return { ok: false, error: e };
  }
  // A process the OS refused to start reports through 'error' (asynchronously), and
  // is logged as the failure it is — the reply says a process was handed over, which
  // is all that has happened at the moment it is written.
  if (child && typeof child.on === 'function') {
    child.on('error', (e) => {
      console.log('[hd-open] ' + JSON.stringify({ time: new Date().toISOString(), action, path: p, argv, spawn_failed: String((e && e.message) || e) }));
    });
    if (typeof child.unref === 'function') child.unref();
  }
  logAction(action, p, argv, child && child.pid, requested);
  return { ok: true, argv, pid: child && child.pid };
}

// ── §13.6/§13.9: making the window this click caused actually reach the user ─
//
// §13.6 asked for the window to be raised. Round 9.6 got it there by starting a
// PowerShell process PER CLICK and waiting for it: measured, `POST /api/open` answered in
// 709-720 ms while the OS hand-off it was wrapped around, `spawn('explorer.exe',[p])`,
// costs 3-6 ms. §13.9 corrected the budget — the hand-off IS the critical path and must
// answer in ≤ 50 ms warm, with the raise issued AFTER the response — and both halves of
// that live here:
//
//   * the raise is one line of JSON to a WARM worker (`src/raise-worker.ps1`: ONE process
//     for the life of the server, holding the window APIs, started lazily), so a click
//     starts no process at all;
//   * nothing below awaits it. `arm` is a ~40-byte pipe write before the hand-off, the
//     reply goes out, and the `raise` job is written after it — so a worker that is
//     slow, hung, missing or dead cannot move this answer by a millisecond, let alone
//     fail it (§13.6 item 4, kept).
//
// The `arm`/`raise` split is what keeps the diff honest: only a snapshot taken BEFORE the
// hand-off can say which window the hand-off caused, and the worker cannot take one when
// the job arrives (the window may already exist by then), so the click supplies it. An
// unclaimed snapshot is bounded on the worker's side, so a click whose hand-off fails
// after arming cannot leak one.
//
// HONESTY (§13.2.7 + §13.9): the reply is written before the raise has happened, so it
// cannot describe one. `doneString()` is therefore the same sentence in every case, and
// what the worker later measured is logged under `[hd-raise]`, where a later note may
// surface it — never claimed in advance.

// Bounds on the WORKER's time, not on the click's: the click waits for nothing, so these
// only decide when a raise stops being worth waiting for.
const RAISE_WAIT_MS = 350;   // how long the worker watches for the window to appear
// A raise DISPATCHED and never answered is a distinct fact from a raise not attempted,
// and only the log can tell the two apart (§13.2.7/§13.9). Comfortably past the worker's
// own worst case (350 ms diff + 2000 ms shell bound + 800 ms raise), so it never fires
// for a job that is merely slow.
const RAISE_RESULT_MS = 8000;

/** The worker script. `HD_RAISE_HELPER` is the seam a test uses to hand this code a
 *  different worker, exactly as `HD_OPEN_EXE` does for the spawn. */
function raiseHelperPath() {
  const v = process.env.HD_RAISE_HELPER;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : __dirname + '/raise-worker.ps1';
}

function raiseMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The worker's `@HD-RAISE@` line as a value. `raised` is the worker's measurement — the
 *  window on screen AND in front — so it is true only when the worker said so after
 *  confirming it; anything unreadable is the ABSENCE of a claim, never a success. Pure. */
function parseRaiseLine(line) {
  const out = { id: '', raised: false, vis: false, how: 'unreadable', hwnd: 0, armed: false, ms: 0 };
  try {
    const j = JSON.parse(line.slice('@HD-RAISE@'.length).trim());
    out.id = j.id === undefined || j.id === null ? '' : String(j.id);
    out.raised = j.raised === true;
    out.vis = j.vis === true;
    out.how = typeof j.how === 'string' ? j.how : 'none';
    out.hwnd = Number(j.hwnd) || 0;
    out.armed = j.armed === true;
    out.ms = Number(j.ms) || 0;
    // The worker's own phase timings, carried into the log: a raise that found nothing
    // after three seconds has to say WHERE the three seconds went, or the next person
    // reading it is guessing. `cut` is the reuse scan saying it hit its bound.
    if (j.t_diff !== undefined) out.t_diff = Number(j.t_diff) || 0;
    if (j.t_shell !== undefined) out.t_shell = Number(j.t_shell) || 0;
    if (j.t_raise !== undefined) out.t_raise = Number(j.t_raise) || 0;
    if (j.cut !== undefined) out.cut = j.cut === true;
    if (j.shells !== undefined) out.shells = Number(j.shells) || 0;
    if (Array.isArray(j.touch)) out.touch = j.touch;
    // §13.10: the exact path this job was about, echoed back by the worker, and the
    // process that owned the window it picked. The path is what the memory is keyed on —
    // THIS file's reduction of the string it sent, never the worker's own — so a
    // remembered window can never be filed under a folder it was not measured against.
    if (typeof j.t === 'string') out.t = j.t;
    if (j.pid !== undefined) out.pid = Number(j.pid) || 0;
    if (typeof j.mode === 'string') out.mode = j.mode;
    // An explicit error from the worker is the one thing that must survive into the log.
    if (typeof j.error === 'string') out.error = j.error;
  } catch (e) { /* an unreadable result is not a raised window */ }
  return out;
}

/** §13.10: the worker's answer to `probe` — is that remembered window still there? Pure,
 *  and as strict as `parseRaiseLine`: an unreadable line decides NOTHING (the caller is
 *  told `unreadable` and keeps its memory), because the alternative is a parser bug
 *  quietly answering "gone" and making a click open a second window. */
function parseProbeLine(line) {
  const out = { id: '', alive: false, folder: false, hwnd: 0, ok: false };
  try {
    const j = JSON.parse(line.slice('@HD-PROBE@'.length).trim());
    out.id = j.id === undefined || j.id === null ? '' : String(j.id);
    out.alive = j.alive === true;
    out.folder = j.folder === true;
    out.hwnd = Number(j.hwnd) || 0;
    out.ok = true;
  } catch (e) { /* unreadable: the caller learns nothing, and stays where it was */ }
  return out;
}

/** §13.2.7 + §13.9: the sentence the reply carries, which the client note renders
 *  verbatim (§13.5), so the sentence IS the answer. With the raise issued AFTER the
 *  response, that answer is written before anything has been measured — which leaves
 *  exactly one honest sentence, and it never varies. "and raised" would be a claim about
 *  the future; "(the window stayed behind)" a claim about a measurement that has not
 *  happened yet. §13.6's three strings were written for an answer that waited for the
 *  helper, and this is what §13.9 replacing that ordering costs. The outcome is logged,
 *  never predicted. Pure. */
function doneString() {
  return 'handed to the system';
}

/** Is the raise switched off by hand? Read the same way everywhere one could start. */
function raiseDisabled() {
  const off = process.env.HD_RAISE;
  return typeof off === 'string' && off.trim().toLowerCase() === 'off';
}

// ── the warm worker: one process for the life of the server ─────────────────

let worker = null;             // { child, dead, buf } — null when there is none
let workerWarnedMissing = false;
let workerExitHook = false;
let jobSeq = 0;
const inertLogged = new Set();
// id -> { timer, onLost?, onResult? }, for jobs dispatched and unanswered. `onLost` is
// §13.10's only way to act on a job that never came back: a reuse job whose answer is
// lost is a click that has not opened anything yet.
const pendingRaises = new Map();

/** A dispatched job has been answered; stop watching it, and hand the now-orphaned
 *  reaction back to the caller so it can act on what the worker measured. */
function noteRaiseResult(id) {
  const p = pendingRaises.get(id);
  if (!p) return null;
  clearTimeout(p.timer);
  pendingRaises.delete(id);
  return p;
}

/** A job was dispatched and never came back. §13.9's whole honesty rule is that the
 *  answer never claims a raise, so what is left is the log — and a log that is SILENT
 *  about a hung worker cannot be told apart from one where no raise was attempted. */
function noteRaiseLost(id, reason) {
  const p = pendingRaises.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pendingRaises.delete(id);
  console.log('[hd-raise] ' + JSON.stringify({ time: new Date().toISOString(), event: 'no_result', id, reason }));
  if (typeof p.onLost === 'function') {
    try { p.onLost(reason); } catch (e) { /* a reaction is never allowed to kill the server */ }
  }
}

/** Where the worker's stdout goes: one line per job, and that LOG is where the
 *  measurement ends up. Nothing here is readable by the click that caused it (§13.9) —
 *  with one exception §13.10 bought with a bound: a PROBE, which the click that asked for
 *  it is waiting on, for at most `HD_REUSE_PROBE_MS`. */
function onWorkerLine(line) {
  const time = new Date().toISOString();
  if (line.startsWith('@HD-WORKER-READY@')) {
    if (worker) worker.ready = true;
    console.log('[hd-raise] ' + JSON.stringify({ time, worker: 'ready' }));
    primeProbe();
    return;
  }
  if (line.startsWith('@HD-PROBE@')) {
    const p = parseProbeLine(line);
    const waiting = probes.get(p.id);
    // `alive` alone is not enough: a recycled handle is a live window belonging to
    // somebody else, and the memory is about a FOLDER window or it is about nothing.
    if (waiting) waiting.finish(p.ok && p.alive && p.folder ? 'alive' : (p.ok ? 'gone' : 'unknown'));
    return;
  }
  if (line.startsWith('@HD-RAISE@')) {
    const r = parseRaiseLine(line);
    const p = noteRaiseResult(r.id);
    console.log('[hd-raise] ' + JSON.stringify(Object.assign({ time, event: 'result' }, r)));
    rememberWindow(r);
    forgetWindow(r);
    if (p && typeof p.onResult === 'function') {
      try { p.onResult(r); } catch (e) { /* as above: a reaction never kills the server */ }
    }
  }
}

/** The worker, started on first use and started again if it dies. Returns null when
 *  there is none — a state this code REPORTS, never one it fails the click over. */
function ensureWorker() {
  if (worker && !worker.dead) return worker;
  const script = raiseHelperPath();
  let exists = false;
  try { exists = fsp.existsSync(script); } catch (e) { exists = false; }
  if (!exists) {
    // Once per absence, not once per click: a missing worker script is a standing
    // condition, and a log line per click would bury the click's own audit lines.
    if (!workerWarnedMissing) {
      workerWarnedMissing = true;
      console.log('[hd-raise] ' + JSON.stringify({ time: new Date().toISOString(), worker: 'absent', reason: 'no_helper', script }));
    }
    return null;
  }
  workerWarnedMissing = false;
  const interpreter = (process.env.HD_RAISE_PWSH || '').trim() || 'powershell.exe';
  const w = { child: null, dead: false, buf: '' };
  try {
    // windowsHide here is correct and unrelated to §13.7 item 1: this child IS a console
    // program, and its console is the only thing the flag touches. The flag that must
    // never reach the SHELL is the one on the hand-off, in `launch`.
    w.child = spawn(interpreter, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { shell: false, windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (e) {
    console.log('[hd-raise] ' + JSON.stringify({ time: new Date().toISOString(), worker: 'absent', reason: 'spawn_failed', error: String((e && e.message) || e) }));
    return null;
  }
  worker = w;
  const drop = (reason) => {
    w.dead = true;
    if (worker === w) worker = null;
    console.log('[hd-raise] ' + JSON.stringify({ time: new Date().toISOString(), worker: 'down', reason }));
    // Whatever it was holding is now known to be lost, and saying so is the only way
    // that fact reaches anyone: the click that dispatched them is long answered.
    for (const id of [...pendingRaises.keys()]) noteRaiseLost(id, 'worker_down');
  };
  // A pipe to a process that has already exited fails ASYNCHRONOUSLY through an 'error'
  // event, which no `try` around the write can catch — and an unhandled one takes the
  // whole server down. A worker exiting early is a normal race (it was killed, its start
  // failed, the server is stopping), so both pipes carry a listener.
  if (w.child.stdin && typeof w.child.stdin.on === 'function') w.child.stdin.on('error', () => {});
  if (w.child.stdout && typeof w.child.stdout.on === 'function') {
    w.child.stdout.on('error', () => {});
    w.child.stdout.on('data', (d) => {
      w.buf += d.toString();
      let i;
      while ((i = w.buf.indexOf('\n')) >= 0) {
        const line = w.buf.slice(0, i).trim();
        w.buf = w.buf.slice(i + 1);
        if (line !== '') onWorkerLine(line);
      }
    });
  }
  if (typeof w.child.on === 'function') {
    w.child.on('error', () => drop('spawn_failed'));
    w.child.on('exit', (code) => drop('exited:' + code));
    if (typeof w.child.unref === 'function') w.child.unref();
  }
  // The worker also leaves on its own when its stdin closes — which happens when this
  // process goes away, however it goes away — so this hook is the second line of defence
  // against an orphan PowerShell. The first is that no click ever starts one.
  if (!workerExitHook) {
    workerExitHook = true;
    process.on('exit', () => { stopWorker(); });
  }
  return w;
}

/** Write one job. Never awaited, never throws; false means "there was nobody to tell",
 *  which the log already says and the click never asks about. */
function tell(job) {
  const w = ensureWorker();
  if (!w) return false;
  try {
    w.child.stdin.write(JSON.stringify(job) + '\n');
    return true;
  } catch (e) {
    return false;
  }
}

/** Stop the worker: for a clean exit, and for the suite. Safe when there is none, and
 *  safe twice. */
function stopWorker() {
  const w = worker;
  worker = null;
  // Stopping the worker loses whatever it was holding, and a raise that was dispatched
  // and never answered is exactly the fact this log exists to keep.
  for (const id of [...pendingRaises.keys()]) noteRaiseLost(id, 'worker_stopped');
  if (!w || !w.child) return;
  w.dead = true;
  try { if (w.child.stdin) w.child.stdin.end('{"cmd":"quit"}\n'); } catch (e) { /* already gone */ }
  try { w.child.kill(); } catch (e) { /* already gone */ }
}

/** Warm the worker behind a request nobody is waiting on. §13.9: a link is rendered from
 *  a `/api/pathinfo` answer, so warming there means the first CLICK is already warm —
 *  while a click that arrives before any warming still starts no process of its own.
 *  A harness that injected its own spawner or sink is never given a real worker. */
function warmRaise(ctx) {
  if (ctx && (ctx.spawnImpl || (ctx.raiseSink && typeof ctx.raiseSink.arm === 'function'))) return false;
  if (raiseDisabled() || process.platform !== 'win32') return false;
  return ensureWorker() !== null;
}

/** A sink that does nothing, for the cases where there is nothing to raise. Logged once
 *  per reason: the click's own answer is unchanged either way, and repeating a standing
 *  condition on every click is how a log stops being readable.
 *
 *  Deliberately WITHOUT a `reuse`: this process cannot raise a window in any of these
 *  states, and §13.10 only ever answers "raised the window that was already open" from a
 *  sink that could have. A `reuse` here would be a method that always refuses, which reads
 *  as "capable but not right now" — the distinction the two predicates exist to keep. */
function inertSink(reason) {
  if (!inertLogged.has(reason)) {
    inertLogged.add(reason);
    console.log('[hd-raise] ' + JSON.stringify({ time: new Date().toISOString(), worker: 'skipped', reason }));
  }
  return { arm() {}, raise() {}, canReuse() { return false; } };
}

/** Write a job and hold the worker to it, so a job that is never answered is a fact
 *  rather than a silence. Unref'd: this must never be a reason for the server not to
 *  exit. Never awaited, never throws, false means "nobody to tell". */
function dispatchRaise(job, handlers) {
  const sent = tell(job);
  if (!sent) return false;
  const ms = (handlers && handlers.watchdogMs) || RAISE_RESULT_MS;
  const timer = setTimeout(() => noteRaiseLost(job.id, 'no_answer'), ms);
  if (typeof timer.unref === 'function') timer.unref();
  pendingRaises.set(job.id, { timer, onLost: handlers && handlers.onLost, onResult: handlers && handlers.onResult });
  return true;
}

/** The sink for one click: two writes to the warm worker, nothing awaited, nothing
 *  returned to the caller. §13.9 — this, and only this, is what a raise costs the click.
 *  Honours the seams in order of precedence. */
function raiseSink(ctx) {
  // A harness may observe the two jobs instead of performing them.
  if (ctx && ctx.raiseSink && typeof ctx.raiseSink.arm === 'function' && typeof ctx.raiseSink.raise === 'function') return ctx.raiseSink;
  // A harness that injected its own spawner has opened nothing, so there is nothing that
  // could be raised — and starting the real worker would put a PowerShell process on a
  // developer's desktop for a window that does not exist.
  if (ctx && ctx.spawnImpl) return inertSink('not_spawned');
  // `HD_RAISE=off` is the explicit, documented "do not reach for a window at all": a
  // headless or CI run must never start PowerShell or touch a desktop. The suite sets it
  // for the same reason it sets `HD_OPEN_EXE`: to observe the hand-off and nothing else.
  if (raiseDisabled()) return inertSink('disabled');
  if (process.platform !== 'win32') return inertSink('not_windows');
  return {
    // Before the hand-off: the only moment at which a snapshot can still say what THIS
    // click caused. Never awaited.
    arm(id) { tell({ cmd: 'arm', id }); },
    // After the response: the raise itself, with a target and a bound. Never awaited.
    raise(id, target, kind) {
      dispatchRaise({ cmd: 'raise', id, target, kind: kind === 'file' ? 'file' : 'dir', wait_ms: raiseMs('HD_RAISE_WAIT_MS', RAISE_WAIT_MS) }, null);
    },
    /** §13.10: can a window that already exists be raised at all? Only while the worker is
     *  up AND has said READY — a worker that has never answered cannot be trusted to make
     *  a window appear, and deciding to reuse a window this sink might not raise is the
     *  silent no-op §13.10 item 4 forbids. Judged before the memory is even read. */
    canReuse() {
      const w = worker;
      return !!(w && !w.dead && w.ready === true);
    },
    // §13.10, after the answer: find the window by its exact shell location and raise it.
    // `no_diff` because this click spawned nothing (see the worker's header).
    reuse(id, target, opts, handlers) {
      const wait = opts && opts.waitMs ? opts.waitMs : raiseMs('HD_RAISE_WAIT_MS', RAISE_WAIT_MS);
      return dispatchRaise({ cmd: 'raise', id, target, kind: 'dir', no_diff: true, wait_ms: wait }, handlers);
    },
  };
}

/** A click's job id. Only used to pair this click's `arm` with its own `raise`. */
function nextJobId() {
  jobSeq += 1;
  return String(jobSeq);
}

// ── §13.10: a folder that is already open is raised, not opened again ────────
//
// The user chose A, and the defect it answers was visible in this file's own log: eight
// clicks on one folder produced four distinct new HWNDs (round 9.8 report). Each click
// hands the path to the shell, and the shell makes a window — so the fix is to not hand
// it over when a window for exactly that path already exists.
//
// WHAT "EXISTS" IS ALLOWED TO MEAN. §13.9 gives this check 50 ms warm, and the honest
// measure of "a window for this path exists" is the shell's own enumeration, which
// measured 1.7-2.9 s when it ran just after a spawn — the exact moment a second click
// arrives. So the check is a per-process MEMORY of `path -> the HWND this app's own
// hand-off produced`, and the memory is consulted with no work at all. Nothing about a
// memory is a measurement, though, and §13.10 item 4 forbids a stale one becoming a
// click that quietly does nothing, so there are three layers under it:
//
//   1. a bounded PROBE (`@HD-PROBE@`, `HD_REUSE_PROBE_MS`, default 20 ms): before the answer,
//      the worker is asked whether that one HWND is still a live folder window. This is
//      what makes the answer honest — "close the window, click again" answers "gone" and
//      pays for it with the probe alone, not with a wrong sentence;
//   2. the memory is never trust on its own: the `no_diff` raise job re-reads the
//      window's exact shell location before it touches anything, so a remembered HWND
//      the user navigated elsewhere is never raised (§13.6 item 4 kept);
//   3. if the worker finds NOTHING (`hwnd: 0`) — a memory that went stale without the
//      probe seeing it, a scan cut short, a worker that never answered — the click is
//      SAVED by an ordinary hand-off issued after the response (`rescueOpen`). A second
//      window is a nuisance; a click that does nothing is a bug.
//
// WHAT THIS DOES NOT COVER, stated rather than hidden: a folder the USER opened by hand
// has no entry here, because this app never saw a hand-off produce it, so the first
// click after that still opens a second window. The memory is for windows this app made.
// The worker could index the shell instead, but that is the 1.7-2.9 s enumeration this
// budget forbids on the click's path — the trade is deliberate.
const MEM_PENDING_MS = 2500;          // a hand-off in flight: the window is still coming
const MEM_CONFIRMED_MS = 30 * 60 * 1000;   // a measured window: the probe re-checks it
const MEM_MAX = 128;                  // remembered paths, oldest evicted first
// Measured here once the worker is primed (see `primeProbe`): the probe's round trip is
// 1-4 ms p50 and 5 ms max over 12 samples against a live window and a closed one. 20 ms is
// four times that max, and a click that spends it is still well inside §13.9's 50 ms.
const PROBE_MS = 20;                  // how long the click will wait for its own probe
const REUSE_WATCHDOG_MS = 4000;       // a reuse job that is never answered is a rescue
const REUSE_WAIT_MS = 1200;           // how long the worker waits for a pending window
// §13.2.7 + §13.10 item 3: a raise-without-spawn must not say "handed to the system" —
// nothing was handed over. Both sentences are rendered verbatim by the §13.5 note.
const REUSE_DONE = 'raised the window that was already open';
const PENDING_DONE = 'already opening that folder';

const openMemory = new Map();   // key -> { hwnd, pid, at, how, mode }; hwnd 0 = pending
const probes = new Map();       // probe id -> { finish, timer }
let probeSeq = 0;
// The last probe this process finished, CAPPED at PROBE_MS by construction: the number the
// §13.9 budget is actually paying for, and the only way to state it honestly rather than
// from a memory of a log. Test seam; nothing in the product reads it.
let lastProbe = null;
// Paths whose PENDING window is being looked for right now, so a burst of clicks asks the
// worker once instead of once per click. Measured-window jobs are never folded together:
// each of those clicks claimed a raise, and each raise is its own job.
const reuseInFlight = new Map();

/** The memory's key for a path: one spelling per folder, so two spellings of the same
 *  directory cannot pile up two windows. Deliberately NOT a decode — a native path is
 *  literal, and decoding it would make `a%20b` and `a b` the same folder. Pure. */
function memKey(p) {
  if (typeof p !== 'string' || p === '') return '';
  let t = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return t.toLowerCase();
}

function capMemory() {
  while (openMemory.size > MEM_MAX) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of openMemory) {
      if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    }
    if (oldestKey === null) return;
    openMemory.delete(oldestKey);
  }
}

/** Every memory write takes the next number of a monotonic counter, and every reuse job
 *  remembers which number was current when it was dispatched. Order is then exact, which a
 *  millisecond timestamp is not: measured here, a whole test of this state (write, two
 *  clicks, two answers) fits inside one millisecond, and "was a hand-off made after this
 *  job started looking" must not be answered by a tie. */
let memSeq = 0;
function stampEntry(entry) {
  memSeq += 1;
  entry.seq = memSeq;
  return entry;
}

/** A hand-off this click just made: the window has not appeared yet, so there is no HWND
 *  to remember — but the path is now this app's, and that is what stops the second click
 *  of a double-click from spawning a second Explorer (measured: the shell takes ~200-400 ms
 *  to show the window, and a person's second click arrives long before that). */
function rememberOpening(target) {
  const key = memKey(target);
  if (key === '') return;
  openMemory.set(key, stampEntry({ hwnd: 0, pid: 0, at: Date.now(), how: 'opening', mode: '' }));
  capMemory();
}

function forgetPath(key) {
  if (key !== '') openMemory.delete(key);
}

/** What the worker MEASURED, remembered. Only two kinds of result may seed the memory,
 *  because a memory is what a later click acts on without asking: a window whose exact
 *  shell location the worker read (`how:"reuse"`), or one this click's own hand-off
 *  produced and the worker then brought to the front (`how:"diff"` + raised). A window
 *  the worker could not raise is not evidence of anything and is not remembered. */
function rememberWindow(r) {
  if (!r || !r.t || !r.hwnd) return;
  if (!(r.how === 'reuse' || (r.how === 'diff' && r.raised === true))) return;
  const key = memKey(r.t);
  if (key === '') return;
  openMemory.set(key, stampEntry({ hwnd: r.hwnd, pid: r.pid || 0, at: Date.now(), how: r.how, mode: r.mode || '' }));
  capMemory();
}

/** The other half: a job that found NOTHING for its path is the worker saying the window
 *  this app remembered is not there. Dropping the entry here is what makes the click
 *  after a user's close an ordinary hand-off, with no rescue and no wrong sentence. */
function forgetWindow(r) {
  if (!r || typeof r.t !== 'string' || r.how !== 'none') return;
  forgetPath(memKey(r.t));
}

/** Is there a remembered window for this path, and is it still there? The synchronous
 *  half is a Map lookup; the measured half is one bounded probe. Returns null when the
 *  click must hand the folder over as it always has. */
async function reuseDecision(target, sink) {
  // A sink that could not raise a window even if told to: there is no decision to make,
  // and the click hands the folder over as it always has.
  if (!canReuseJob(sink)) return null;
  const key = memKey(target);
  const entry = openMemory.get(key);
  if (!entry) return null;
  const ttl = entry.hwnd ? MEM_CONFIRMED_MS : MEM_PENDING_MS;
  if (Date.now() - entry.at > ttl) { openMemory.delete(key); return null; }
  // A hand-off of OUR OWN that is still in flight. This answer needs no worker and no
  // measurement: nothing can make "we just handed this folder over" truer, and the click
  // that arrives 200 ms later is the SECOND HALF OF A DOUBLE CLICK — measured here, the
  // worker takes ~480 ms to come up on a cold server, so requiring one for this case is
  // exactly how the pile-up this section exists for happens (measured: 5 clicks on a cold
  // server, click 2 before READY, 2 windows).
  if (!entry.hwnd) return { kind: 'pending', hwnd: 0, done: PENDING_DONE };
  // A measured window. The probe is what keeps the sentence true, so the sentence is only
  // claimed when there is a worker to ask: no worker means no reuse, and the click hands
  // the folder over exactly as it did before §13.10.
  if (!canReuse(sink)) return null;
  const t0 = Date.now();
  const verdict = await probeWindow(entry.hwnd);
  if (verdict === 'unknown') {
    // The click says "raised the window that was already open" and this is the fact behind
    // that sentence: the worker did not answer in time. It is not a lie the user has to
    // live with — the reuse job written after the answer scans for that exact path and
    // hands the folder over itself if there is no such window (§13.10 item 4) — but a claim
    // decided on the memory alone is exactly the kind of thing this log exists to keep.
    console.log('[hd-open] ' + JSON.stringify({
      time: new Date().toISOString(), event: 'probe_unknown', path: target, hwnd: entry.hwnd, after_ms: Date.now() - t0,
    }));
  }
  if (verdict === 'gone') {
    // §13.10 item 4, and the one case a memory alone would get wrong: the user closed the
    // window (measured here: closing a folder window does NOT end its Explorer process, so
    // no cheap liveness test on the pid could have found this — the window has to be asked
    // about, and asking costs the click only this probe).
    openMemory.delete(key);
    console.log('[hd-open] ' + JSON.stringify({
      time: new Date().toISOString(), event: 'memory_stale', path: target, hwnd: entry.hwnd, how: 'probe',
    }));
    return null;
  }
  return { kind: 'reuse', hwnd: entry.hwnd, done: REUSE_DONE };
}

/** One probe nobody is waiting for, sent the moment the worker says READY. Measured on this
 *  machine: the FIRST message of a fresh worker takes 15-19 ms round trip while every later
 *  one takes 1-4 — PowerShell paying for its first pipe read, not the window API. That cost
 *  belongs behind a `/api/pathinfo` warm-up, not on a click, and paying it here is what lets
 *  `PROBE_MS` stay small enough to fit §13.9's budget. Its answer is discarded. */
function primeProbe() {
  // Only the worker that just said READY: `probeWindow` reaches `ensureWorker`, and a
  // READY line that arrives from a worker already being replaced must not start another.
  if (!worker || worker.dead || worker.ready !== true) return;
  probeWindow(0).then(() => {}, () => {});
}

/** Ask the worker about ONE remembered handle. Bounded: an answer that does not arrive in
 *  time is `unknown`, and the click proceeds on its memory rather than waiting — §13.9's
 *  budget is 50 ms and this may spend a small part of it, no more. */
function probeWindow(hwnd) {
  const w = ensureWorker();
  if (!w || w.ready !== true) return Promise.resolve('unknown');
  const id = 'p' + (probeSeq += 1);
  const ms = reuseMs('HD_REUSE_PROBE_MS', PROBE_MS);
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      probes.delete(id);
      lastProbe = { hwnd, verdict: v, ms: Date.now() - t0, at: Date.now() };
      resolve(v);
    };
    const timer = setTimeout(() => finish('unknown'), ms);
    if (typeof timer.unref === 'function') timer.unref();
    probes.set(id, { finish, timer });
    try {
      w.child.stdin.write(JSON.stringify({ cmd: 'probe', id, hwnd }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      finish('unknown');
    }
  });
}

function reuseMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** A click that decided to reuse a window is a click that must not quietly do nothing, so
 *  the reuse job is held to its answer: no answer at all, or an answer that found no
 *  window, ends in the ordinary hand-off (§13.10 item 4). Never awaited by the click —
 *  every path into this runs after the response has been written. */
function dispatchReuse(ctx, sink, action, target, asked, reuse) {
  // What a failed reuse job means depends on what was claimed. A measured window was
  // claimed as RAISED, so anything that did not raise it leaves the click having done
  // nothing at all — that must end in a hand-off. A pending memory claimed only that OUR
  // OWN hand-off is in flight; the window is the shell's to show, and a job that was never
  // delivered is not evidence that it failed to show. Rescuing there would spawn exactly
  // the second Explorer this section exists to remove.
  const measured = reuse.kind === 'reuse';
  const key = memKey(target);
  // One lookup per burst, not one per click. Measured on this machine: a `no_diff` job
  // costs the worker 22-53 ms of Get-ShellWindows, and a pending job holds itself open for
  // up to REUSE_WAIT_MS on top of that — so a double-click of 8 would queue 7 lookups for
  // the same path, delay the NEXT click's probe behind them (measured here: two probes at
  // 28 and 30 ms, i.e. past the 20 ms budget, while a job ran), and give 7 chances to
  // answer "nothing there" and each hand the folder over. The job already in flight is
  // asking exactly the same question about exactly this path.
  if (!measured && reuseInFlight.has(key)) {
    console.log('[hd-open] ' + JSON.stringify({
      time: new Date().toISOString(), action, path: target, event: 'reuse_queued', job: reuseInFlight.get(key),
    }));
    return;
  }
  const job = nextJobId();
  // The memory as it stood when this job started looking. Anything written after it is a
  // hand-off this job knows nothing about — see `rescueOpen`.
  const sinceSeq = memSeq;
  const done = () => { if (!measured) reuseInFlight.delete(key); };
  // A pending memory has ONE exception, and it is the only thing a later click can learn
  // and this one cannot: the worker LOOKED and there is no window for that path (§13.10
  // item 4). `sinceSeq` is what keeps a burst from turning that into a pile-up.
  const onEmpty = (r) => {
    done();
    if (r.hwnd === 0) rescueOpen(ctx, sink, action, target, asked, 'worker_found_nothing', sinceSeq);
  };
  const onLost = (reason) => {
    done();
    if (measured) { rescueOpen(ctx, sink, action, target, asked, 'no_answer:' + reason, sinceSeq); return; }
    console.log('[hd-open] ' + JSON.stringify({
      time: new Date().toISOString(), action, path: target, event: 'reuse_unchecked', why: 'no_answer:' + reason,
    }));
  };
  if (!measured) reuseInFlight.set(key, job);
  let sent = false;
  try {
    sent = sink.reuse(job, target, {
      // `no_diff` for BOTH kinds, and this is not a detail: this click has made no hand-off
      // either way, so there is no "new window" for a diff to find. A diff job on a pending
      // entry would snapshot the desktop and then look for something newer than the
      // snapshot — and the window the PREVIOUS click spawned may already be on screen by
      // then, which reads as "nothing new" and would hand the folder over a second time.
      // The job's whole question is "is there a window for exactly this path", so it must
      // ask exactly that.
      noDiff: true,
      // A pending entry is a window the shell has not shown yet (measured: 200-400 ms), so
      // the worker is allowed to look more than once. A measured window is being raised as
      // it is, and one pass is the whole job.
      waitMs: reuse.kind === 'pending' ? reuseMs('HD_REUSE_WAIT_MS', REUSE_WAIT_MS) : 0,
    }, {
      watchdogMs: reuseMs('HD_REUSE_WATCHDOG_MS', REUSE_WATCHDOG_MS),
      onLost,
      // `hwnd: 0` is the worker saying it found no window for that path at all — the
      // memory was stale in a way the probe could not see (a scan cut short, a window
      // navigated away, a handle recycled). A window it DID find and could not raise is
      // not a reason to open a second one.
      onResult: onEmpty,
    });
  } catch (e) {
    sent = false;
  }
  if (!sent) {
    done();
    if (measured) rescueOpen(ctx, sink, action, target, asked, 'not_sent', sinceSeq);
    else console.log('[hd-open] ' + JSON.stringify({
      time: new Date().toISOString(), action, path: target, event: 'reuse_unchecked', why: 'not_sent',
    }));
  }
}

/** The ordinary hand-off, issued AFTER the answer for a click that meant to reuse a window
 *  and could not. Synchronous with respect to the click only in that it is not on the
 *  click's path at all: everything that reaches here is a timer or a worker line.
 *  Swallows its own errors — an uncaught throw in a callback like this one is a dead
 *  server, and §13.6 item 4 says a failed raise never fails a click. */
function rescueOpen(ctx, sink, action, target, asked, why, sinceSeq) {
  try {
    // The one thing that must not happen twice. `sinceSeq` is the memory's counter when the
    // job that is asking started looking; if a HAND-OFF for this path was recorded after
    // that, the folder is already being opened by us and this rescue would be the pile-up
    // §13.10 exists to remove. This is the burst case measured here: N clicks inside one
    // lookup's lifetime all get the same "nothing there", and only the first may act on it.
    const key = memKey(target);
    const cur = openMemory.get(key);
    if (typeof sinceSeq === 'number' && cur && cur.hwnd === 0 && typeof cur.seq === 'number' && cur.seq > sinceSeq) {
      console.log('[hd-open] ' + JSON.stringify({
        time: new Date().toISOString(), action, path: target, event: 'reuse_rescue_skipped', why, after_handoff: cur.at,
      }));
      return;
    }
    console.log('[hd-open] ' + JSON.stringify({
      time: new Date().toISOString(), action, path: target, event: 'reuse_rescue', why,
    }));
    forgetPath(key);
    const job = nextJobId();
    sink.arm(job);                                   // the snapshot must predate the hand-off
    const done = launch(action, target, ctx.spawnImpl, asked);
    if (!done.ok) return;
    rememberOpening(target);
    sink.raise(job, target, 'dir');
  } catch (e) {
    console.log('[hd-raise] ' + JSON.stringify({
      time: new Date().toISOString(), event: 'rescue_failed', path: target, error: String((e && e.message) || e),
    }));
  }
}

/** Could this sink raise a window that is already open, if it were asked? This is the
 *  weaker of the two questions on purpose: it must be answerable BEFORE the worker is up,
 *  because that is exactly when the second click of a double-click arrives (measured: the
 *  worker takes ~480 ms to say READY, and the pile-up in run p8 was click 2 landing inside
 *  that window). A harness sink without `reuse` and the inert sinks still answer no. */
function canReuseJob(sink) {
  return !!sink && typeof sink.canReuse === 'function' && typeof sink.reuse === 'function';
}

/** Could this sink raise a window that is already open RIGHT NOW? Only a sink that can do
 *  it AND has said it is up — a worker that has never answered cannot be trusted to make a
 *  window appear, and claiming a window this sink might not raise is the silent no-op
 *  §13.10 item 4 forbids. Needed only for the memory that names a measured window: that
 *  sentence is a claim about the window, so it may only be said when the window can be
 *  checked and raised. The pending sentence is a claim about our own hand-off, and needs
 *  neither (see `reuseDecision`). */
function canReuse(sink) {
  return canReuseJob(sink) && sink.canReuse() === true;
}

// ── the routes ──────────────────────────────────────────────────────────────

/**
 * Both endpoints live behind the same gate, and the gate runs first (§13.2.6).
 * `ctx`: {sendJson, readJson, pathname, spawnImpl?}.
 */
async function handle(req, res, ctx) {
  const { sendJson, readJson, pathname } = ctx;
  const denied = guard(req);
  if (denied) {
    return sendJson(res, { ok: false, error: { code: denied.code, message: denied.message } }, 403);
  }
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendJson(res, { ok: false, error: { code: (e && e.code) || 'bad_request', message: String((e && e.message) || e) } }, 400);
  }

  if (pathname === '/api/pathinfo') {
    const norm = normalizePaths(body);
    if (norm.error) {
      return sendJson(res, { ok: false, error: { code: norm.code, message: norm.error } }, 400);
    }
    // §13.9: the links a user clicks are drawn from this route's answers, so the worker
    // is warmed here — behind a request nobody waits on — and the first CLICK does not
    // pay for a cold start. It is a no-op after the first time: one worker per server.
    warmRaise(ctx);
    // Awaiting the whole screenful is bounded by DEADLINE_MS: the stats run in the
    // thread pool, so a slow path lengthens this answer and nothing else.
    return sendJson(res, { ok: true, items: await Promise.all(norm.paths.map((p) => info(p))) });
  }

  // /api/open
  const action = body && body.action;
  const asked = body && body.path;
  if (typeof action !== 'string' || !ACTIONS.has(action)) {
    return sendJson(res, {
      ok: false,
      error: { code: 'bad_request', message: `"action" must be one of ${[...ACTIONS].map((a) => `"${a}"`).join(' or ')}, got ${JSON.stringify(action)}` },
    }, 400);
  }
  if (typeof asked !== 'string' || asked === '') {
    return sendJson(res, { ok: false, error: { code: 'bad_request', message: '"path" must be a non-empty absolute path string' } }, 400);
  }
  if (asked.length > LIMITS.MAX_PATH_CHARS || /[\u0000\r\n]/.test(asked)) {
    return sendJson(res, { ok: false, error: { code: 'bad_request', message: '"path" is not a path: it is longer than Windows allows or carries a null byte or newline' } }, 400);
  }
  // The path the SHELL will reach, which is the path this endpoint must judge and the
  // path it hands over — so the existence test, the reveal-is-file test and the argv
  // are all about one string, and the answer cannot be about a different file than
  // the one that gets opened.
  const target = nativePath(asked);
  // Existence is decided HERE, by our own stat — never by the spawn, and never by the
  // child's exit code (§13.2.5, §13.0). `freshNegative`: a remembered "not there" must
  // not be able to refuse a folder that is there (§13.7 item 2 — measured: a cached
  // timeout-born negative answered `not_found` for `…\Herdr-Dash\src`, so the click
  // performed no system call at all).
  const found = await info(target, { freshNegative: true });
  // §13.11 item 1: the gate is a DEFINITE, fresh answer from the filesystem — nothing
  // else. `exists:false` with no `undecided` flag is that answer: a stat ran and said
  // there is no such path (the remembered-negative case cannot reach here either, since
  // `freshNegative` re-states before this line). An unaskable verdict is not evidence of
  // absence — the measured case is a directory that exists with a thread pool that could
  // not stat it — so the path is handed over exactly as a measured one is, and the Shell
  // is left to say the truth. That is the difference between a click that does something
  // and the measured 404 that did nothing at all.
  if (!found.exists && !found.undecided) {
    return sendJson(res, { ok: false, error: { code: 'not_found', message: `no such path: ${target}` } }, 404);
  }
  if (found.undecided) {
    console.log('[hd-open] ' + JSON.stringify({
      time: new Date().toISOString(), event: 'open_unverified', action, path: target, requested: asked,
      why: found.why, handed_over: true,
      message: 'the filesystem did not answer, so this is not a refusal: the path is handed over and Explorer decides (§13.11 item 1)',
    }));
  }
  // Only a MEASURED directory is refused for `reveal`; "I do not know what this is" is
  // not a reason to refuse the click either (§13.11 item 1).
  if (action === 'reveal' && found.kind && found.kind !== 'file') {
    return sendJson(res, {
      ok: false,
      error: { code: 'bad_request', message: `"reveal" selects a FILE in its folder; ${target} is a directory — use "open" for a folder (§13.2.5)` },
    }, 400);
  }
  // §13.9: the hand-off IS the critical path. Two ~40-byte pipe writes to a warm worker
  // are the entire cost the raise adds to this answer — neither is awaited, and the
  // second is written after the response.
  const sink = raiseSink(ctx);
  const job = nextJobId();

  // §13.10: before handing a FOLDER over, ask whether this app already has a window for
  // it. Two cheap things answer: a Map lookup, and — when there is a window to check — one
  // probe the worker answers from local Win32 calls. `reuseDecision` returns null the
  // moment anything is uncertain, and null is this function's old behaviour exactly. Note
  // that the gate here is only "could this sink raise a window": a pending memory is a
  // decision the sink is not needed to make, and requiring a READY worker for it is the
  // measured cause of run p8's second window.
  const reuse = (action === 'open' && found.kind === 'dir')
    ? await reuseDecision(target, sink)
    : null;

  if (reuse) {
    // Nothing was handed over, so the sentence must not say it was (§13.2.7/§13.10 item 3).
    const answer = sendJson(res, { ok: true, action, path: target, done: reuse.done });
    // After the answer, like the raise it replaces. A reuse job that finds no window ends
    // in the ordinary hand-off, so this branch can never be a click that did nothing.
    dispatchReuse(ctx, sink, action, target, asked, reuse);
    return answer;
  }

  // BEFORE the hand-off, because this snapshot is the only thing that can later say
  // which window the hand-off caused. `launch` below is what the user is waiting for.
  sink.arm(job);

  const done = launch(action, target, ctx.spawnImpl, asked);
  if (!done.ok) {
    // Nothing was opened, so there is nothing to raise; the worker drops the unclaimed
    // snapshot on its own (§13.9). The click fails for the hand-off's reason only.
    console.log('[hd-open] ' + JSON.stringify({ time: new Date().toISOString(), action, path: target, spawn_failed: String((done.error && done.error.message) || done.error) }));
    return sendJson(res, {
      ok: false,
      error: { code: 'spawn_failed', message: `the system refused to start the handler: ${String((done.error && done.error.message) || done.error)}` },
    }, 500);
  }
  // §13.10: this app now owns a window for this folder — it is merely not on screen yet
  // (measured: ~200-400 ms after the spawn). Remembering that BEFORE the answer is what
  // stops the second click of a double-click from spawning a second Explorer.
  if (action === 'open' && found.kind === 'dir') rememberOpening(target);

  // The response first, the raise second — that order is the point of §13.9. The answer
  // cannot describe a raise it has not waited for, which is why `doneString()` has one
  // value; whatever the worker measures lands in the `[hd-raise]` log afterwards.
  const answer = sendJson(res, {
    ok: true,
    action,
    path: target,
    // §13.2.7: what was DONE, not what the system will do with it.
    done: doneString(),
  });
  sink.raise(job, target, found.kind);
  return answer;
}

module.exports = {
  handle,
  guard,
  isLoopback,
  sameOriginOrApp,
  normalizePaths,
  argvFor,
  openExe,
  nativePath,
  launch,
  info,
  hidesConsole,
  doneString,
  parseRaiseLine,
  parseProbeLine,
  raiseHelperPath,
  raiseSink,
  warmRaise,
  stopWorker,
  RAISE_WAIT_MS,
  REUSE_DONE,
  PENDING_DONE,
  LIMITS,
  TTL_MS,
  DEADLINE_MS,
  ACTIONS,
  // ── test seams ──
  _cacheSize: () => cache.size,
  _clearCache: () => cache.clear(),
  _statCount: () => statCount,
  _resetStatCount: () => { statCount = 0; },
  _setStatImpl: (fn) => { statImpl = fn; },
  _raiseSink: raiseSink,
  _workerUp: () => worker !== null && !worker.dead,
  _stopWorker: stopWorker,
  _memKey: memKey,
  _memorySize: () => openMemory.size,
  _memoryGet: (p) => openMemory.get(memKey(p)) || null,
  _clearMemory: () => { openMemory.clear(); probes.clear(); reuseInFlight.clear(); },
  // A seam that writes a memory goes through the same stamp as a click does, or a test
  // would be exercising a state the product can never be in.
  _memorySet: (target, entry) => {
    const key = memKey(target);
    if (key === '') return;
    openMemory.set(key, stampEntry(Object.assign({}, entry)));
    capMemory();
  },
  _probeCount: () => probes.size,
  _lastProbe: () => lastProbe,
  _reuseInFlight: () => reuseInFlight.size,
  _resetStatImpl: () => { statImpl = (target) => fsp.promises.stat(target); },
};
