'use strict';
/*
 * src/stream-hub.js — wave 1 token bridge: SSE tail of the NDJSON sink
 * (owner: W1; contract: _scratch/stream-round/CONTRACT.md §2, §3, §6, §9).
 *
 * WHAT THIS IS. The pi extension / hermes plugin write one JSON envelope per line
 * (`turn_start`, `text_delta`, `tool_end`, …) into
 *
 *   <root>/<safe(pane_id)>/<safe(session_id)>__<safe(turn_id)>.ndjson
 *
 * with `<root>` = `HD_STREAM_DIR` → `%LOCALAPPDATA%\herdr-dash\streams` →
 * `~/.herdr-dash/streams`. This module tails the newest such file for one pane and
 * serves it as Server-Sent Events:
 *
 *   GET /api/agent-stream?pane_id=<pane>&session_id=<optional>&since=<optional seq>
 *
 * The stream is EPHEMERAL by design (§1): `/api/chat` stays the authoritative
 * transcript, and a lost event is only ever cosmetic — the final record always wins.
 * So nothing here is allowed to fail loudly, throw into a request, or close an SSE
 * connection because of a file: a missing sink, a half-written line, a truncated
 * file, a malformed record or a duplicated `seq` all degrade to "nothing to show
 * yet", never to an error page.
 *
 * WHY A POLL AND NOT fs.watch. `fs.watch` on Windows reports one notification for a
 * burst of appends and gives no byte offset; a 50 ms `stat` + bounded read is
 * cheaper than a missed event, and it makes truncation detectable at all
 * (`size < offset`). Each cycle reads at most READ_LIMIT bytes, so a long turn can
 * never stall the connection, and the first connection never walks the whole file
 * (§6: "Do not read the whole file for a first connection").
 *
 * NO LONG-LIVED FILE HANDLE. The writer prunes old turn files (§2). Holding a handle
 * open on the file being tailed would make that delete fail on Windows, so each read
 * opens, reads and closes — and only when `size > offset`, so an idle cycle costs one
 * `stat`.
 *
 * WHAT IS NOT HERE (deliberate): no auth (§2: local, user-scoped sink), no static
 * serving of the directory, no token cursor over `/api/chat`, and no envelope
 * synthesis — this module only ever forwards what the bridge wrote, minus malformed
 * lines, which are counted rather than repaired.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const POLL_MS = 50;                    // §6: poll the file at 50 ms
const READ_LIMIT = 256 * 1024;         // §6: at most 256 KiB per cycle
const HEARTBEAT_MS = 15000;            // §6: heartbeat comment every 15 s
const RING_MAX = 500;                  // §6: last 500 envelopes per pane
const MAX_LINE = 64 * 1024;            // §2: a sink line is <= 64 KiB
const PARTIAL_MAX = 4 * MAX_LINE;      // a "line" past this is a broken writer, not a record
const CONTROL_SUFFIX = '__control.ndjson';   // §4: out-of-turn settings file: never the main stream
const SAFE_LEN = 80;                   // §2: safe() truncates to 80 chars
const SAFE_RE = /[^A-Za-z0-9_.-]/g;
const TURN_SUFFIX = '.ndjson';

/* ── §2: paths ─────────────────────────────────────────────────────────────── */

/** §2: every character outside `[A-Za-z0-9_.-]` becomes `-`, then 80 chars. */
function safeSegment(value) {
  const s = String(value === undefined || value === null ? '' : value).replace(SAFE_RE, '-');
  return s.slice(0, SAFE_LEN);
}

/** §2: `HD_STREAM_DIR`, else `%LOCALAPPDATA%\herdr-dash\streams`, else the homedir form. */
function resolveStreamRoot(env) {
  const e = env || process.env;
  const explicit = typeof e.HD_STREAM_DIR === 'string' ? e.HD_STREAM_DIR.trim() : '';
  if (explicit) return path.resolve(explicit);
  const local = typeof e.LOCALAPPDATA === 'string' ? e.LOCALAPPDATA.trim() : '';
  if (local) return path.join(local, 'herdr-dash', 'streams');
  return path.join(os.homedir(), '.herdr-dash', 'streams');
}

/**
 * A pane id that is a PATH, not a pane, is refused before anything touches the fs.
 * `safe()` alone would already stop `../x` (it becomes `..-x`), but a request that
 * asks for a traversal is a bug or an attack, and answering it with a silent
 * substitution hides that. Real ids (`wD:p2`, `w6:p4`) contain only `:` beyond the
 * safe set and are accepted.
 */
function assertPaneId(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw);
  if (!s.length) return { code: 'bad_request', message: '"pane_id" query parameter is required' };
  if (s === '.' || s === '..' || s.indexOf('\u0000') >= 0 || /[\\/]/.test(s)) {
    return { code: 'bad_request', message: '"pane_id" must be a pane id, not a path' };
  }
  if (!safeSegment(s).length) {
    return { code: 'bad_request', message: '"pane_id" is empty after sanitising' };
  }
  return null;
}

/** `<root>/<safe(pane)>`, guaranteed to stay inside `root` (defence in depth). */
function paneDirFor(root, paneId) {
  const dir = path.resolve(root, safeSegment(paneId));
  const rootResolved = path.resolve(root);
  if (dir !== rootResolved && !dir.startsWith(rootResolved + path.sep)) {
    throw { code: 'bad_request', message: '"pane_id" resolves outside the stream root' };
  }
  return dir;
}

/* ── §3: envelopes ─────────────────────────────────────────────────────────── */

/** The de-duplication identity §3 names: `(session_id, turn_id, seq)`. */
function eventKey(env) {
  return String(env.session_id === undefined ? '' : env.session_id) + '\u0000'
    + String(env.turn_id === undefined ? '' : env.turn_id) + '\u0000'
    + String(env.seq);
}

/**
 * A parsed line becomes an envelope or `null`. Only the fields this module NEEDS are
 * enforced (`v === 1`, a string `type`, a numeric `seq`) — the rest of §3's field set
 * belongs to the writer, and a bridge that adds a field must not be counted as
 * malformed here. Anything else is a malformed line: skipped and counted (§6).
 */
function parseEnvelope(line) {
  if (!line) return null;
  let obj;
  try { obj = JSON.parse(line); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.v !== 1) return null;
  if (typeof obj.type !== 'string' || !obj.type.length) return null;
  if (typeof obj.seq !== 'number' || !Number.isFinite(obj.seq)) return null;
  return obj;
}

/* ── file discovery ────────────────────────────────────────────────────────── */

function isTurnFile(name, sessionSafe) {
  if (typeof name !== 'string' || !name.endsWith(TURN_SUFFIX)) return false;
  if (name.endsWith(CONTROL_SUFFIX)) return false;          // §4: control file is not the stream
  if (sessionSafe && !name.startsWith(sessionSafe + '__')) return false;
  return true;
}

/**
 * The newest turn file under one pane dir, by mtime (§6). A missing directory is not
 * an error — it is "the bridge has not written anything yet" — so it answers null.
 * A file that vanishes between readdir and stat is skipped for the same reason.
 */
async function newestTurnFile(dir, sessionSafe) {
  let names;
  try { names = await fsp.readdir(dir); } catch (e) { return null; }
  let best = null;
  for (const name of names) {
    if (!isTurnFile(name, sessionSafe)) continue;
    const file = path.join(dir, name);
    let st;
    try { st = await fsp.stat(file); } catch (e) { continue; }
    if (!st.isFile()) continue;
    const mtimeMs = st.mtimeMs || 0;
    if (!best || mtimeMs > best.mtimeMs || (mtimeMs === best.mtimeMs && name > best.name)) {
      best = { file, name, mtimeMs, size: st.size };
    }
  }
  return best;
}

/** §6 `stream.ready.agent`: the writer stamps every envelope, so the first line knows. */
async function sniffAgent(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (!bytesRead) return null;
    const line = buf.slice(0, bytesRead).toString('utf8').split('\n')[0];
    const env = parseEnvelope(line.replace(/\r$/, ''));
    return env && typeof env.agent === 'string' ? env.agent : null;
  } catch (e) {
    return null;
  } finally {
    if (fh) { try { await fh.close(); } catch (e) { /* already gone */ } }
  }
}

/* ── the hub ───────────────────────────────────────────────────────────────── */

/**
 * One hub per server process: it owns the stream root and the per-pane ring, and it
 * hands out one independent tail per SSE connection (each connection has its own
 * offset, partial-line buffer and duplicate set — two tabs on one pane must not
 * starve each other).
 *
 * `opts` exists for the local tests only: a temp root, a 10 ms poll, a short
 * heartbeat. The route always calls it with defaults.
 */
function createStreamHub(opts) {
  const options = opts || {};
  const root = options.streamRoot ? path.resolve(options.streamRoot) : resolveStreamRoot(options.env);
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : POLL_MS;
  const heartbeatMs = Number.isFinite(options.heartbeatMs) && options.heartbeatMs > 0
    ? options.heartbeatMs : HEARTBEAT_MS;
  const readLimit = Number.isFinite(options.readLimitBytes) && options.readLimitBytes > 0
    ? options.readLimitBytes : READ_LIMIT;

  /* §6 ring: last RING_MAX envelopes per pane dir, shared by every connection of that
     pane, so a client that reconnects with `since=<seq>` can be caught up without
     touching the file. It is a RECOVERY WINDOW, not a history: past 500 events the
     oldest are gone and a `since` older than the window simply gets what is left. */
  const rings = new Map();     // paneDir -> { list: [], keys: Set }

  function ringFor(paneDir) {
    let r = rings.get(paneDir);
    if (!r) { r = { list: [], keys: new Set() }; rings.set(paneDir, r); }
    return r;
  }
  function ringPush(paneDir, env) {
    const r = ringFor(paneDir);
    const key = eventKey(env);
    if (r.keys.has(key)) return false;
    r.list.push(env);
    r.keys.add(key);
    while (r.list.length > RING_MAX) {
      const gone = r.list.shift();
      r.keys.delete(eventKey(gone));
    }
    return true;
  }

  /**
   * `GET /api/agent-stream`. Writes the SSE response and returns immediately; the
   * tail runs on its own interval until the client goes away.
   *
   * `deps.sendJson` is the server's own JSON writer (status code + body), so a
   * refused request looks exactly like every other refusal on this server. Without
   * it (unit tests, an embedding host) an identical minimal writer is used.
   */
  function handleAgentStream(req, res, url, deps) {
    const sendJson = (deps && typeof deps.sendJson === 'function') ? deps.sendJson : fallbackSendJson;
    const rawPane = url && url.searchParams ? url.searchParams.get('pane_id') : null;
    const bad = assertPaneId(rawPane);
    if (bad) return sendJson(res, { ok: false, error: bad }, 400);

    let paneDir;
    try {
      paneDir = paneDirFor(root, rawPane.trim());
    } catch (e) {
      return sendJson(res, { ok: false, error: { code: e.code, message: e.message } }, 400);
    }

    const rawSession = url.searchParams.get('session_id');
    const sessionSafe = rawSession === null || rawSession === '' ? null : safeSegment(rawSession);
    const sinceRaw = url.searchParams.get('since');
    const sinceNum = (sinceRaw === null || sinceRaw === '') ? NaN : Number(sinceRaw);
    const since = Number.isFinite(sinceNum) ? sinceNum : null;

    /* §6 headers, byte for byte the ones /api/events already sends (no-transform is
       what keeps a proxy from buffering a stream into one late burst). */
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 1000\n\n');

    const state = {
      file: null,
      offset: 0,
      partial: '',
      seen: new Set(),          // §6 per-connection duplicate set, keyed as eventKey()
      malformed: 0,
      duplicates: 0,
      skippedBlanks: 0,
      readySent: false,
      waitingSent: false,
      lastWriteAt: Date.now(),
      closed: false,
      timer: null,
    };

    function write(chunk) {
      if (state.closed || res.writableEnded) return false;
      try { res.write(chunk); state.lastWriteAt = Date.now(); return true; }
      catch (e) { close(); return false; }
    }
    function sendEvent(name, data) {
      return write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n');
    }
    function close() {
      if (state.closed) return;
      state.closed = true;
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      try { if (!res.writableEnded) res.end(); } catch (e) { /* already gone */ }
    }

    /** send one envelope to this connection, de-duplicated and ring-buffered */
    function deliver(env) {
      const key = eventKey(env);
      if (state.seen.has(key)) { state.duplicates++; return; }
      state.seen.add(key);
      ringPush(paneDir, env);
      sendEvent('stream', env);
    }

    /** §6 `since`: replay the ring, then let the tail carry on from EOF. */
    function replaySince() {
      if (since === null) return 0;
      const r = ringFor(paneDir);
      let n = 0;
      for (const env of r.list) {
        if (!(Number(env.seq) > since)) continue;
        if (sessionSafe && safeSegment(env.session_id) !== sessionSafe) continue;
        deliver(env);
        n++;
      }
      return n;
    }

    /**
     * Take over a file: announce it (once), replay the ring for a `since` client, and set
     * the offset this connection continues from.
     *
     * `startAt` is the one place the contract's two rules meet. On the FIRST connection to
     * an existing file the offset is the file's end (§6: "Do not read the whole file for a
     * first connection" — a long turn must not stall, and its deltas are already history).
     * But a file that appears only after this connection was WAITING, or a newer file that
     * replaces the one being tailed, is the live turn: its first bytes were written while
     * nobody was reading, so it starts at 0 or those deltas would be lost for ever.
     */
    async function adopt(fileInfo, reason, startAt) {
      state.file = fileInfo.file;
      state.offset = startAt === 'start' ? 0 : fileInfo.size;
      state.partial = '';
      state.waitingSent = false;
      const agent = await sniffAgent(fileInfo.file);
      if (reason) sendEvent('stream.reset', { pane_id: rawPane, file: fileInfo.file, reason: reason });
      if (!state.readySent) {
        state.readySent = true;
        sendEvent('stream.ready', { pane_id: rawPane, file: fileInfo.file, agent: agent });
        replaySince();
      } else if (reason) {
        replaySince();          // a switched file: the ring may already hold its first events
      }
    }

    /**
     * One poll cycle. Every failure is swallowed: a permission error, a vanished file
     * or a malformed line must not close a stream the reader is watching.
     */
    async function tick() {
      if (state.closed) return;
      let info;
      try { info = await newestTurnFile(paneDir, sessionSafe); } catch (e) { info = null; }
      if (state.closed) return;

      if (!info) {
        if (!state.waitingSent) {
          state.waitingSent = true;
          sendEvent('stream.waiting', {
            pane_id: rawPane,
            reason: 'no stream file for this pane yet — the bridge has not written a turn',
          });
        }
      } else if (!state.file || info.file !== state.file) {
        /* a file that appears after we were waiting is read from its first byte; a file that
           was already there when the connection opened is read from its end (see adopt) */
        const wasWaiting = state.waitingSent;
        await adopt(info, state.file ? 'newer_file' : null, (state.file || wasWaiting) ? 'start' : 'tail');
      } else {
        await readGrowth(info);
      }

      if (!state.closed && (Date.now() - state.lastWriteAt) >= heartbeatMs) write(':\n\n');
    }

    /** §6: bounded read from the current offset, complete lines only, truncation resets. */
    async function readGrowth(info) {
      let size = info.size;
      if (size < state.offset) {
        /* the file was truncated or replaced by a shorter one (fs copy, log rotation):
           start over rather than reading past a stale offset. The client is told, so it
           can drop what it drew from the bytes that are gone. */
        state.offset = 0;
        state.partial = '';
        sendEvent('stream.reset', { pane_id: rawPane, file: state.file, reason: 'truncated' });
      }
      if (size <= state.offset) return;

      const want = Math.min(size - state.offset, readLimit);
      let buf;
      let fh;
      try {
        fh = await fsp.open(state.file, 'r');
        buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, state.offset);
        if (!bytesRead) return;
        buf = buf.slice(0, bytesRead);
      } catch (e) {
        return;                       // a pruned/renamed file: the next cycle re-discovers it
      } finally {
        if (fh) { try { await fh.close(); } catch (e) { /* already gone */ } }
      }

      state.offset += buf.length;
      state.partial += buf.toString('utf8');

      /* A writer that never emits a newline must not grow this buffer without bound:
         past PARTIAL_MAX the fragment cannot be a §2 line, so it is dropped and counted. */
      if (state.partial.length > PARTIAL_MAX) {
        state.malformed++;
        state.partial = '';
        return;
      }

      let nl;
      while (!state.closed && (nl = state.partial.indexOf('\n')) >= 0) {
        const line = state.partial.slice(0, nl).replace(/\r$/, '');
        state.partial = state.partial.slice(nl + 1);
        if (!line.trim()) { state.skippedBlanks++; continue; }
        if (line.length > MAX_LINE) { state.malformed++; continue; }
        const env = parseEnvelope(line);
        if (!env) { state.malformed++; continue; }
        deliver(env);
      }
    }

    req.on('close', close);
    res.on('close', close);
    res.on('error', close);

    /* first cycle runs now, so `stream.ready` / `stream.waiting` is not a poll late */
    tick().catch(() => {});
    state.timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
    if (state.timer.unref) state.timer.unref();

    return { close: close, state: state };
  }

  return {
    root: root,
    handleAgentStream: handleAgentStream,
    /* the ring as a probe sees it (tests, a future /api/stream-stats) */
    ringSize: function (paneId) {
      const r = rings.get(paneDirFor(root, paneId));
      return r ? r.list.length : 0;
    },
  };
}

/** The refusal shape of this server (`sendJson` in src/server.js), for hosts without one. */
function fallbackSendJson(res, body, statusCode) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(statusCode || 200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

module.exports = {
  createStreamHub,
  resolveStreamRoot,
  safeSegment,
  paneDirFor,
  assertPaneId,
  // exported for the local tests (pure parts, no fs)
  _internals: { eventKey, parseEnvelope, isTurnFile, newestTurnFile, sniffAgent, CONTROL_SUFFIX },
  LIMITS: { POLL_MS, READ_LIMIT, HEARTBEAT_MS, RING_MAX, MAX_LINE, SAFE_LEN },
};
