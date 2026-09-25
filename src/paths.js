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
 * WHAT IT GUARANTEES (each one is a test in test/paths.mjs)
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
 *   answer before `spawn` is reached (test/paths.mjs proves the spawn is never
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
 *   event loop) and carries a deadline (HD_PATHINFO_DEADLINE_MS, 2500 ms): a path that
 *   cannot be decided by then is answered `exists:false` and logged. That answer can
 *   be wrong about a host that is merely slow — there is no third state in §13.2.3's
 *   shape, and "not a path this app can act on" is the safe reading of an undecidable
 *   one. A screenful of undecidable paths costs one deadline, not one per render: the
 *   undecided verdict is cached like any other.
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

/** How long one path may go undecided before it is answered `exists:false`. See the
 *  header: a synchronous stat of an unreachable UNC path was measured at 42,155 ms,
 *  which on this server's one thread is 42 s of everything else not answering. The
 *  default is generous enough for a real network share and short enough that a
 *  screenful of hostile paths cannot outlast a user's patience. */
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

/** `stat` of a target (already in shell form) reduced to §13.2.3's verdict plus the
 *  key that invalidates a cache entry. Never throws, never blocks the event loop. */
async function statTarget(target) {
  statCount++;
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
    return { exists: true, kind, key: `${kind}:${st.mtimeMs}:${st.size}` };
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof Undecided) {
      // Not the same thing as "not there", and worth a line: it means this machine
      // could not decide in time (an unreachable host, a hung share). The answer is
      // §13.2.3's only safe one, and the log is how the difference stays visible.
      console.log('[hd-pathinfo] ' + JSON.stringify({
        time: new Date().toISOString(), path: target, undecided: true, after_ms: DEADLINE_MS,
        message: 'no answer from the filesystem before the deadline — answered exists:false',
      }));
      return { exists: false, kind: null, key: 'missing' };
    }
    // A path that cannot be stated is a path that is not there — the alternative
    // (EACCES, a reparse-point loop) is not a thing this endpoint may report, and
    // "exists" is the only question §13.2.3 asks. A file that appears later is
    // found by the next call after the TTL.
    return { exists: false, kind: null, key: 'missing' };
  }
}

/** §13.2.3's answer for one path, cached for TTL_MS. The cached verdict is about the
 *  NORMALISED target, so the two spellings of one path (`C:/x` and `C:\x`) share an
 *  entry and cannot contradict each other; `path` echoes the string that was asked
 *  about, which is what a client matches its own candidate by. */
async function info(p) {
  const target = nativePath(p);
  const now = Date.now();
  const hit = cache.get(target);
  if (hit && now - hit.at < TTL_MS) return { path: p, exists: hit.exists, kind: hit.kind };
  const st = await statTarget(target);
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
 *  desktop (test/paths.mjs points it at node and reads the audit line, so no
 *  Explorer window is ever created by the suite — and no existing window can be
 *  navigated away from the user, which `explorer /select,` does when Explorer is
 *  set to reuse one window). Same shape as the server's existing GIT_BIN_PATH knob. */
function openExe() {
  const v = process.env.HD_OPEN_EXE;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : 'explorer.exe';
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
    child = doSpawn(argv[0], argv.slice(1), { shell: false, windowsHide: true, detached: false, stdio: 'ignore' });
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
  // child's exit code (§13.2.5, §13.0).
  const found = await info(target);
  if (!found.exists) {
    return sendJson(res, { ok: false, error: { code: 'not_found', message: `no such path: ${target}` } }, 404);
  }
  if (action === 'reveal' && found.kind !== 'file') {
    return sendJson(res, {
      ok: false,
      error: { code: 'bad_request', message: `"reveal" selects a FILE in its folder; ${target} is a directory — use "open" for a folder (§13.2.5)` },
    }, 400);
  }
  const done = launch(action, target, ctx.spawnImpl, asked);
  if (!done.ok) {
    console.log('[hd-open] ' + JSON.stringify({ time: new Date().toISOString(), action, path: target, spawn_failed: String((done.error && done.error.message) || done.error) }));
    return sendJson(res, {
      ok: false,
      error: { code: 'spawn_failed', message: `the system refused to start the handler: ${String((done.error && done.error.message) || done.error)}` },
    }, 500);
  }
  return sendJson(res, {
    ok: true,
    action,
    path: target,
    // §13.2.7: what was DONE, not what the system will do with it.
    done: 'handed to the system',
  });
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
  _resetStatImpl: () => { statImpl = (target) => fsp.promises.stat(target); },
};
