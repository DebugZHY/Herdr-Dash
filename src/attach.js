'use strict';
/*
 * src/attach.js — POST /api/attach (CONTRACT-v2 §10, option A; round 7.7, owner W1)
 *
 * herdr has no upload of any kind and `agent prompt` carries text only, so the
 * browser cannot hand a dropped file's real path to the agent. §10 rules that the
 * app copies the bytes into its own store and injects the resulting absolute path
 * into the prompt. This module is that store's only writer.
 *
 * WHAT IT GUARANTEES (each one is a test in test/attach.mjs)
 *
 *   Never outside the root. `<app root>\_cache\attachments` (§13.4 item 1 — the
 *   store used to be `<LOCALAPPDATA>\herdr-dash\attachments`, but a store on C:
 *   is one nobody remembers to clean, so it now lives inside the app's own cache
 *   folder), with `HD_ATTACH_ROOT` (absolute) as the supported override. It is
 *   app data, never project data: the client cannot name a path, only a pane and
 *   a filename, and both are reduced to ONE legal path component before they are
 *   joined. The
 *   pane id becomes a directory below the root (`w6:p2` -> `w6_p2`), the filename
 *   becomes a basename (`..\..\evil.png` -> `evil.png`), and `assertUnder()` refuses
 *   the write outright if the result ever leaves the root. Nothing here reads a
 *   pane's cwd, so no pane's workspace can be written to even by accident.
 *
 *   Never overwritten. The destination is opened with `wx`, which is atomic: the
 *   first upload of a name wins, and every later one is written as `-2`, `-3`, …
 *   A retry loop, not an `exists()` check, because two requests can collide.
 *
 *   Never a partial file. The bytes stream to disk (a 25 MiB body is never held
 *   in memory), and every failure path — cap exceeded, 0 bytes, write error,
 *   client gone — unlinks what it wrote.
 *
 *   Never a silent guess about the client's name. §10.1 says the header carries
 *   "the browser's original filename, UTF-8, percent-encoded if needed". The
 *   browser cannot put a non-ASCII byte in a header value, so the shipped client
 *   (chatview.js `headerName`) sends an ASCII name VERBATIM and percent-encodes
 *   anything else. Two consequences this module honours:
 *     - a header whose bytes are not printable ASCII is the client's UTF-8 sent
 *       raw (Node hands us latin-1), so it is re-read as UTF-8 — `curl -H
 *       'x-hd-name: 报告.png'` survives;
 *     - a percent-escape is decoded ONLY when doing so yields non-ASCII text,
 *       i.e. only when the value must be the client's encoded form. A name that
 *       is already ASCII is the literal name ("50% off.png" keeps its `%`), so a
 *       decode can never corrupt it.
 *
 * LIMITS AND WHAT IS NOT HERE
 *
 *   §10.3's 8 files per message is the client's count to enforce — the contract
 *   says so — and this module deliberately invents no server-side rate limit: the
 *   per-file cap and the name rules are the whole of its policy.
 *
 *   The pane id is NOT checked against herdr. §10.2's premise is that a pane id
 *   only selects a directory under OUR root, and sanitising is what makes that
 *   true; asking herdr would make an upload fail whenever its 5 s snapshot cache
 *   lags a brand-new pane (W4 creates panes), which is a worse failure than a
 *   directory nobody reads. No path is choosable either way.
 *
 * TEST SEAMS (env, same style as HERDR_SOCKET_PATH / CLAUDE_PROJECTS_DIR)
 *   HD_ATTACH_ROOT   the store's root. §13.4 item 1 makes this a supported
 *                    override for a reader who wants the files elsewhere, and a
 *                    test uses it for the same reason: a suite writes in _scratch
 *                    and the write-failure case can point at a path that cannot
 *                    exist. An override that is not an absolute path is refused
 *                    (see attachmentRoot), never silently resolved against a cwd.
 *   HD_ATTACH_STAMP  freezes the UTC stamp, so "the same name twice gets -2" is
 *                    deterministic instead of a race with the second boundary
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const LIMITS = {
  MAX_BYTES: 25 * 1024 * 1024,      // §10.3: 25 MiB per file
  MAX_NAME: 120,                    // §10.2: the name is capped at 120 chars
  MAX_PANE: 64,                     // a pane id is `w6:p2`; longer than this is not a pane id
  MAX_TRY: 1000,                    // `-2` … `-1000`, then a plain refusal (never a silent overwrite)
  // A refused upload may keep arriving while the client is still sending its body.
  // Draining a bounded amount lets it READ the 413 we already wrote (a browser
  // shows that reason verbatim, §10.3) before the socket goes away; the caps stop
  // a refused request from becoming a free data sink.
  DRAIN_MAX_BYTES: 64 * 1024 * 1024,
  DRAIN_MS: 5000,
};

/** Characters that may not appear in a Windows path component (§10.2). */
const ILLEGAL_COMPONENT = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
/** Control characters, which are stripped rather than replaced in a filename. */
const CONTROL = /[\u0000-\u001f\u007f]/g;
/** Windows device names are not filenames, with or without an extension. */
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * §10.3's cap is met on two paths — a declared `content-length` over the limit
 * (refused before a byte is read) and a body that only reveals its size while it
 * streams — but it is ONE condition, so it carries one reason. The client shows
 * this text verbatim (§10.3), and it cannot know in advance which path its upload
 * will take: two texts for one condition would mean the user reads a different
 * sentence depending on how their browser happened to frame the body.
 */
const TOO_LARGE = `the upload is over the ${LIMITS.MAX_BYTES} byte (25 MiB) limit for one attachment — nothing was written`;

/**
 * The app's own directory — the repo root, one level above `src/`. Derived from
 * this file's location, never from `process.cwd()`: the server is normally started
 * from the repo root, but a shortcut, a scheduled task or a test may start it from
 * anywhere, and the store must not move with the caller's cwd.
 */
const APP_ROOT = path.resolve(__dirname, '..');

/** Logged once per refused value, so a per-request call cannot spam the console. */
const warned = new Set();
function warnOnce(value, why) {
  const key = `${value}\u0000${why}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.log('[hd-attach] ' + JSON.stringify({ time: new Date().toISOString(), warning: why,
    HD_ATTACH_ROOT: value, using: path.join(APP_ROOT, '_cache', 'attachments') }));
}

/**
 * The store's root: `<app root>\_cache\attachments`, or `HD_ATTACH_ROOT` when it
 * is set to an absolute path (§13.4 item 1; §10.2's app-data location is
 * superseded by it).
 *
 * The override is validated rather than trusted, because a RELATIVE path would
 * mean a different store depending on where the process happened to start — the
 * one failure mode that would scatter attachments silently, and the reason this
 * module reads `__dirname` for the default too. `C:` and `C:foo` are refused with
 * it: Win32 calls the first absolute, but `path.resolve` turns it into the current
 * directory ON that drive, which is exactly the cwd-dependent store just described.
 * A refused value is a warning in the log and the app-relative default — never a
 * failed upload, and never a store where the reader did not ask for one.
 */
function attachmentRoot() {
  const override = process.env.HD_ATTACH_ROOT;
  const raw = override && override.trim();
  if (raw) {
    if (path.isAbsolute(raw) && !/^[A-Za-z]:$/.test(raw)) return path.resolve(raw);
    warnOnce(raw, path.isAbsolute(raw)
      ? 'HD_ATTACH_ROOT is a drive with no path (which Windows resolves against the process\'s current directory on that drive) — using the app\'s own _cache/attachments instead'
      : 'HD_ATTACH_ROOT is not an absolute path (which would put the store wherever the process was started, and let two runs share it silently) — using the app\'s own _cache/attachments instead');
  }
  return path.join(APP_ROOT, '_cache', 'attachments');
}

/** `20260925T113000Z` — §10.2/§10.4's stamp shape, UTC, sorts chronologically. */
function utcStamp(now) {
  const d = now instanceof Date ? now : new Date();
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

/** The stamp this upload uses; the env override is stripped of anything that
 *  could not be part of a filename, because a test seam is still untrusted. */
function stampNow() {
  const seam = process.env.HD_ATTACH_STAMP;
  if (seam && seam.trim()) {
    const clean = seam.trim().replace(ILLEGAL_COMPONENT, '').replace(/^[.\s]+|[.\s]+$/g, '');
    if (clean) return clean;
  }
  return utcStamp(new Date());
}

/**
 * Recover the header's real text.
 *
 * Node decodes header bytes as latin-1, so a client that sent UTF-8 bytes raw
 * arrives as mojibake and is reinterpreted here. A percent-encoded value is
 * decoded only when the decode produces characters that could not have travelled
 * in a header at all — which is exactly the case the client encodes for.
 * @returns {string} the name as the client meant it (untrusted; sanitised next)
 */
function decodeHeaderName(raw) {
  let s = String(raw == null ? '' : raw);
  if (!s) return '';
  // eslint-disable-next-line no-control-regex
  if (/[^ -~]/.test(s)) {
    const bytes = Buffer.from(s, 'latin1');
    if (bytes.toString('utf8').indexOf('�') === -1) s = bytes.toString('utf8');
  }
  if (s.indexOf('%') >= 0) {
    try {
      const decoded = decodeURIComponent(s);
      if (/[^ -~]/.test(decoded)) s = decoded;
    } catch (e) {
      // A bare `%` that is not an escape: the literal name, kept as it is.
    }
  }
  return s;
}

/** Shorten to `max`, keeping the extension when there is a sane one. */
function capName(s, max) {
  if (s.length <= max) return s;
  const dot = s.lastIndexOf('.');
  const ext = (dot > 0 && s.length - dot <= 20) ? s.slice(dot) : '';
  const stem = ext ? s.slice(0, dot) : s;
  const room = Math.max(1, max - ext.length);
  return stem.slice(0, room).replace(/[.\s]+$/, '') + ext;
}

/**
 * §10.2's safe-name, in the order the ruling lists it: directory components,
 * control characters, the reserved set, whitespace, leading/trailing dots and
 * spaces, then the 120-char cap. A name that survives as nothing is refused —
 * an empty name is never invented into something.
 * @returns {{ok:true,name:string}|{ok:false,reason:string}}
 */
function sanitizeName(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(CONTROL, '');
  if (s.indexOf('/') >= 0 || s.indexOf('\\') >= 0) s = s.split(/[\\/]/).pop();  // no directory components
  s = s.replace(/[<>:"|?*]/g, '');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) {
    return { ok: false, reason: `the filename becomes empty once its path separators, reserved characters and leading/trailing dots and spaces are removed (was ${JSON.stringify(String(raw == null ? '' : raw).slice(0, 80))}) — a file needs a name` };
  }
  if (s.length > LIMITS.MAX_NAME) s = capName(s, LIMITS.MAX_NAME);
  // `NUL` is a device, `NUL.txt` is refused by Win32 too: the check is on the
  // part before the first dot.
  if (DEVICE.test(s.split('.')[0])) s = '_' + s;
  return { ok: true, name: s };
}

/**
 * §10.2's safe-pane: every character illegal in a Windows component becomes `_`
 * (a replaced character is a hint that something was there — the pane the reader
 * picked is still recognisable as `w6_p2`). A value that reduces to nothing, or
 * to a dot-only component, is refused rather than silently mapped to a shared
 * directory, and so is one that is longer than any pane id: two different panes
 * must never land in one directory.
 * @returns {{ok:true,pane:string}|{ok:false,reason:string}}
 */
function sanitizePane(raw) {
  const original = String(raw == null ? '' : raw);
  if (!original) {
    return { ok: false, reason: 'the "x-hd-pane" header is required — the upload is stored per pane, and without it there is nowhere honest to put the file' };
  }
  let s = original.replace(ILLEGAL_COMPONENT, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) {
    return { ok: false, reason: `pane id ${JSON.stringify(original.slice(0, 60))} has no character that can name a directory (separators, dots and spaces are not a pane) — refusing rather than writing into a shared folder` };
  }
  if (s.length > LIMITS.MAX_PANE) {
    return { ok: false, reason: `pane id ${JSON.stringify(original.slice(0, 60))} is ${s.length} characters after sanitising, over the ${LIMITS.MAX_PANE} this store allows — a pane id is short (w6:p2), and truncating one could mix two panes' files` };
  }
  if (DEVICE.test(s.split('.')[0])) s = '_' + s;
  return { ok: true, pane: s };
}

/** `<stem>-2<ext>` — where a name collision lands (§10.2). */
function withSuffix(name, n) {
  const dot = name.lastIndexOf('.');
  const keepExt = dot > 0;
  const stem = keepExt ? name.slice(0, dot) : name;
  const ext = keepExt ? name.slice(dot) : '';
  return `${stem}-${n}${ext}`;
}

/** The one place that decides a path may be written: it must stay under `root`. */
function assertUnder(root, full) {
  const r = path.resolve(root);
  const f = path.resolve(full);
  if (f !== r && !f.startsWith(r + path.sep)) {
    throw { code: 'write_failed', message: `${f} is outside the attachment root ${r}` };
  }
  return f;
}

/**
 * Create the destination, exclusively. `wx` fails with EEXIST instead of
 * truncating, so "never overwrite" is the file system's guarantee, not ours.
 * @returns {Promise<{full, name, fd}>}
 */
async function createExclusive(dir, wanted) {
  let last = null;
  for (let n = 1; n <= LIMITS.MAX_TRY; n++) {
    const name = n === 1 ? wanted : withSuffix(wanted, n);
    const full = path.join(dir, name);
    try {
      const fd = fs.openSync(full, 'wx');
      return { full, name, fd };
    } catch (e) {
      last = e;
      if (e && e.code === 'EEXIST') continue;
      throw e;
    }
  }
  throw { code: 'write_failed', message: `could not find a free name for ${JSON.stringify(wanted)} after ${LIMITS.MAX_TRY} attempts: ${(last && last.message) || 'unknown'}` };
}

/** Refuse and finish the exchange. The client is very likely still sending its
 *  body, because the reason we are here is that the body is bigger than the cap:
 *  the reply is already written, and this reads (and discards) the rest so the
 *  client can READ it — §10.3 says the reader shows that reason verbatim, and a
 *  socket reset before it arrives would turn "25 MiB is too big" into "network
 *  error". The drain is bounded twice over (bytes and time) so a refused request
 *  cannot become a free data sink, and:
 *    - a body that ends inside the budget leaves the connection USABLE (the
 *      request was consumed; destroying it here would break a client's keep-alive
 *      reuse for a request that was answered correctly);
 *    - a body that runs past the budget, or a peer that stops talking, is
 *      destroyed — which is the brief's "destroy the request cleanly if the cap is
 *      exceeded mid-stream". */
function finishRefused(req, ms, maxBytes) {
  // The body may already have arrived in full (a refusal decided after an await
  // is the case that can happen): there is nothing to drain, and destroying a
  // request that was read and answered correctly would only cost the client its
  // keep-alive connection.
  if (req.complete) return undefined;
  let seen = 0;
  let done = false;
  let timer = null;
  const stop = (destroy) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    if (destroy) { try { req.destroy(); } catch (e) { /* already gone */ } }
  };
  timer = setTimeout(() => stop(true), ms);
  if (timer.unref) timer.unref();
  req.on('data', (chunk) => {
    seen += chunk.length;
    if (seen > maxBytes) stop(true);
  });
  req.on('end', () => stop(false));
  req.on('error', () => stop(false));
  try { req.resume(); } catch (e) { /* already flowing */ }
}

/** `content-length`, or null when the client did not declare one (chunked). */
function declaredLength(req) {
  const raw = req.headers['content-length'];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * POST /api/attach. Owns the whole exchange for this route: the bytes are the
 * request body, so the reply can be written at any point of the stream, and the
 * status codes are the ones §10 names (413 / 400 / 405), not the API's usual
 * always-200 envelope.
 *
 * `senders` is `{ sendJson }` — the server's own writer, passed in rather than
 * required back (src/server.js requires this module, not the other way round).
 */
async function handleAttach(req, res, senders) {
  const sendJson = senders && senders.sendJson;
  const fail = (status, code, message) => sendJson(res, { ok: false, error: { code, message } }, status);

  // ── who and what, before a byte is read ────────────────────────────────────
  const pane = sanitizePane(req.headers['x-hd-pane']);
  if (!pane.ok) return fail(400, 'bad_request', pane.reason);
  const name = sanitizeName(decodeHeaderName(req.headers['x-hd-name']));
  if (!name.ok) return fail(400, 'bad_request', name.reason);

  const declared = declaredLength(req);
  if (declared === 0) {
    return fail(400, 'bad_request', 'the upload is empty (0 bytes) — an empty file is not an attachment; send the bytes of a real file');
  }
  if (declared !== null && declared > LIMITS.MAX_BYTES) {
    // §10.3: the client is told before its body is read. `fail` writes the reason
    // the chip shows verbatim; the drain below is what lets the client read it.
    fail(413, 'too_large', TOO_LARGE);
    finishRefused(req, LIMITS.DRAIN_MS, LIMITS.DRAIN_MAX_BYTES);
    return undefined;
  }

  const root = attachmentRoot();
  const dir = path.join(root, pane.pane);
  const wanted = `${stampNow()}-${name.name}`;
  let target;
  try {
    assertUnder(root, path.join(dir, wanted));
    await fsp.mkdir(dir, { recursive: true });
    target = await createExclusive(dir, wanted);
    assertUnder(root, target.full);
  } catch (e) {
    if (e && e.code === 'write_failed') return fail(500, 'write_failed', e.message);
    const where = (e && e.path) || dir;
    return fail(500, 'write_failed',
      `the attachment could not be created under ${where}: ${(e && e.code) ? e.code + ' ' : ''}${(e && e.message) || e} — nothing was written, the pane's own files are untouched`);
  }

  // ── the body, streamed ─────────────────────────────────────────────────────
  const ws = fs.createWriteStream(target.full, { fd: target.fd, autoClose: true });
  let bytes = 0;
  let refusing = false;

  const removePartial = () => {
    fs.promises.unlink(target.full).catch(() => { /* never existed, or already gone */ });
  };

  /**
   * Stop writing, delete the partial file, THEN answer. Everywhere else the
   * unlink is fire-and-forget — the client is already gone, or the answer says
   * nothing about the file — but here the answer IS the promise that nothing was
   * written, and on Windows an open fd blocks the unlink: the fd is closed first
   * (with a bounded wait, so a stream that never reports close cannot hang the
   * request), the removal is awaited, and only then is the reason sent. A client
   * that lists the store the moment it reads the 413 finds nothing.
   */
  const closeAndRemove = async () => {
    try { ws.destroy(); } catch (e) { /* already closed */ }
    await new Promise((done) => {
      if (ws.closed) return done();
      const guard = setTimeout(done, 2000);
      if (guard.unref) guard.unref();
      ws.once('close', () => { clearTimeout(guard); done(); });
      return undefined;
    });
    await fs.promises.unlink(target.full).catch(() => { /* never existed, or already gone */ });
  };

  ws.on('drain', () => { try { req.resume(); } catch (e) { /* gone */ } });
  ws.on('error', (e) => {
    if (refusing) return;
    refusing = true;
    removePartial();
    fail(500, 'write_failed', `the bytes could not be written to ${target.full}: ${(e && e.code) ? e.code + ' ' : ''}${(e && e.message) || e} — the partial file was removed`);
    try { req.destroy(); } catch (err) { /* gone */ }
  });

  req.on('data', (chunk) => {
    if (refusing) return;
    bytes += chunk.length;
    if (bytes > LIMITS.MAX_BYTES) {
      refusing = true;
      void closeAndRemove().then(() => {
        fail(413, 'too_large', TOO_LARGE);
        finishRefused(req, LIMITS.DRAIN_MS, LIMITS.DRAIN_MAX_BYTES);
      });
      return;
    }
    if (!ws.write(chunk)) { try { req.pause(); } catch (e) { /* gone */ } }
  });

  req.on('aborted', () => {
    if (refusing) return;
    refusing = true;
    try { ws.destroy(); } catch (e) { /* already closed */ }
    removePartial();
  });
  req.on('error', () => {
    if (refusing) return;
    refusing = true;
    try { ws.destroy(); } catch (e) { /* already closed */ }
    removePartial();
  });

  req.on('end', () => {
    if (refusing) return;
    ws.end();
  });

  ws.on('finish', () => {
    if (refusing) return;
    if (bytes === 0) {
      refusing = true;
      removePartial();
      fail(400, 'bad_request', 'the upload is empty (0 bytes) — an empty file is not an attachment; send the bytes of a real file');
      return;
    }
    // `name` is what the store made of the name the CLIENT sent (sanitised for a
    // path component), not the on-disk basename: the file that exists is
    // `<stamp>-<that name>`, plus `-2`/`-3` on a collision, so `path` and its
    // basename stay the authority on the file's own name and the reply still says
    // what became of the client's name (`..\..\evil.png` -> `evil.png`).
    sendJson(res, { ok: true, path: target.full, bytes, name: name.name }, 200);
  });

  return undefined;
}

module.exports = {
  LIMITS,
  attachmentRoot,
  utcStamp,
  stampNow,
  decodeHeaderName,
  sanitizeName,
  sanitizePane,
  withSuffix,
  capName,
  assertUnder,
  handleAttach,
};
