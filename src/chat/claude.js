'use strict';
/*
 * src/chat/claude.js — claude's session log → §8.2's message shape (owner: W1).
 *
 * THE SOURCE
 *
 *   ~/.claude/projects/<slug>/<session-id>.jsonl — one JSON record per line,
 *   appended while the agent works. The slug is NOT derivable from the pane's
 *   cwd (measured, §8.1: `D--Development-New` for D:\Development\New but
 *   `d--Development-Example` for D:\Development\Example — the casing is decided by
 *   whoever created the directory). So this module globs every project directory
 *   for `<session-id>.jsonl` and then VERIFIES the file really belongs to the
 *   pane by comparing a record's own `cwd` with herdr's cwd for that pane. A
 *   file that fails that check is never read for content.
 *
 * THE CURSOR
 *
 *   A byte offset. Records already handed to the client are never re-parsed:
 *   the cursor is the offset just after the last COMPLETE line that was
 *   processed. A half-written trailing line (the writer appends while we read)
 *   is not a record, is not emitted, and does NOT move the cursor — the next
 *   call reads it from its first byte.
 *
 * WHAT A RECORD BECOMES
 *
 *   One message per content unit, and every record is accounted for in exactly
 *   one bucket (§8.2/§8.4):
 *
 *     message        assistant / user / system records (and their blocks)
 *     merged_records a record whose only renderable unit is a tool_result whose
 *                    call is in the same reply: the card already carries the text
 *                    (round 7.1, DEFECT-11 — see common.js's mergeResultIntoCall)
 *     skipped        the eight record types §8.2 names as deliberately not shown,
 *                    plus records that render to nothing at all
 *     unknown_records anything else — measured live: `queue-operation`,
 *                    `custom-title`, `cost-state` (§8 lists neither, so they are
 *                    "unrecognised" by the contract's own definition)
 *
 *   A text / thinking / system block whose content is blank (empty or only
 *   whitespace) is not a message: emitting it made 43 empty rows on the live
 *   w6:p4 session (round 7.1, DEFECT-10). A record left with nothing to render is
 *   `skipped`, and `empty_records` says how many of those were blank content, so
 *   the drop is always visible in the reply.
 *
 * TAIL MODE (round 7.1, DEFECT-9)
 *
 *   `readTail` answers with the NEWEST messages and a cursor at the end of the
 *   file, so opening a long session lands on the live turn instead of 3.8 hours
 *   (and one page) behind it. It scans BACKWARDS from EOF in 64 KiB chunks and
 *   never reads the whole file: the newest records that fit are parsed, older
 *   bytes are never decoded.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  LIMITS, clampText, isBlankValue, toMs, message, planUnits, applyPlan, planBucket, absorbPairedResults,
  mergeCounts, addUnits, emittedUnits, markPendingReasons,
} = require('./common');

const SOURCE_KIND = 'claude_jsonl';
const READ_CHUNK = 64 * 1024;

/** §9.1's candidate scan verifies at most CAND_MAX files and stops there — the
 *  cost bound is deliberate. But when that cut proves NOTHING for the pane's cwd,
 *  an empty answer is what says "this pane has no claude log", so the scan may
 *  keep verifying up to CAND_MAX * this many files before it answers that. */
const CAND_ESCALATE = 4;

/** §8.2: these record types are counted in `skipped`, never rendered. */
const EXCLUDED_TYPES = new Set([
  'attachment', 'mode', 'permission-mode', 'atis-latch',
  'last-prompt', 'ai-title', 'file-history-snapshot', 'file-history-delta',
]);

/** The types this parser knows how to turn into messages. */
const MESSAGE_TYPES = new Set(['assistant', 'user', 'system']);

/** Block types that can be rendered. Anything else (an `image` block, say) is
 *  not text and has no place in a text view. */
const TEXT_BLOCKS = new Set(['text', 'thinking', 'tool_use', 'tool_result']);

/** Every record type this parser has an opinion about — the union of the two
 *  sets above. A type outside it is `unknown_records`; a type inside EXCLUDED is
 *  `skipped`; a type inside MESSAGE_TYPES is parsed. */
const KNOWN_TYPES = new Set([...MESSAGE_TYPES, ...EXCLUDED_TYPES]);

/**
 * Where claude keeps its projects. `CLAUDE_PROJECTS_DIR` is honoured the same
 * way the rest of this server honours HERDR_SOCKET_PATH / GIT_BIN_PATH: so a
 * test (this repo's test/chat.mjs) can point the endpoint at a fixture tree
 * without writing a byte inside the user's real ~/.claude.
 */
function projectsRoot() {
  return process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Find `<session-id>.jsonl` under any project directory.
 *
 * The session id comes from herdr, but it is a value that ends up in a path, so
 * it is checked first: an id containing a separator or `..` could not be a real
 * session id anyway, and refusing it here means no other code has to trust it.
 * Returns null when nothing matches — the caller reports `session_file_missing`.
 */
function findSessionFile(sessionId) {
  const id = String(sessionId == null ? '' : sessionId);
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') return null;
  const root = projectsRoot();
  let dirs;
  try {
    dirs = require('node:fs').readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return null;                                  // no projects dir at all
  }
  const wanted = id + '.jsonl';
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(root, d.name, wanted);
    try {
      const st = require('node:fs').statSync(candidate);
      if (st.isFile()) return candidate;
    } catch (e) { /* not in this project */ }
  }
  return null;
}

/** Compare herdr's cwd for the pane with a cwd a claude record carries. Windows
 *  paths are case-insensitive and may arrive with either separator or a trailing
 *  slash; anything else must match exactly. */
function sameCwd(a, b) {
  const norm = (p) => {
    const s = String(p == null ? '' : p).trim().replace(/[\\/]+$/, '');
    const slashed = s.replace(/\\/g, '/');
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
  };
  return !!a && !!b && norm(a) === norm(b);
}

/**
 * Verify the file belongs to this pane by reading records until one carries a
 * `cwd`, and comparing it with herdr's. Reads at most CWD_SEARCH_BYTES_MAX bytes
 * — every record claude writes into a session carries cwd in practice.
 *
 * Returns {ok:true, cwd} | {ok:false, reason}. `reason: 'empty'` means the file
 * has no records at all: there is nothing to leak, and the caller answers
 * `no_messages_yet` rather than accusing a brand-new session of a mismatch.
 */
async function verifyCwd(file, paneCwd) {
  const fh = await fsp.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    if (size === 0) return { ok: false, reason: 'empty' };
    const buf = Buffer.alloc(Math.min(READ_CHUNK, size));
    let pos = 0;
    let pending = '';
    while (pos < size && pos < LIMITS.CWD_SEARCH_BYTES_MAX) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const lines = (pending + buf.subarray(0, bytesRead).toString('utf8')).split('\n');
      pending = lines.pop();                      // last element: may be partial
      for (const line of lines) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (e) { continue; }
        if (typeof rec.cwd === 'string' && rec.cwd) {
          return sameCwd(rec.cwd, paneCwd)
            ? { ok: true, cwd: rec.cwd }
            : { ok: false, reason: 'mismatch', found: rec.cwd };
        }
      }
    }
    // Records exist but not one of them names a cwd: we cannot prove which
    // project this file belongs to, and an unproven file must not be shown.
    return { ok: false, reason: 'unverifiable' };
  } finally {
    await fh.close().catch(() => {});
  }
}

// ── round 7.6 (§9.1): the newest log under the pane's cwd ───────────────────
/**
 * Which conversations could belong to a pane whose herdr record cannot be
 * trusted? The project DIRECTORY is named after a slug that is not derivable
 * from the cwd (§8.1: measured `D--Development-Sample` next to `d--Development-Example`,
 * and this machine also carries `d--Development-Example-extra` beside
 * `d--Development-Example`), so this searches ALL project directories and keeps a
 * file only when it PROVES the pane's cwd the same way the bound file does —
 * by carrying that cwd in one of its own records.
 *
 * Cost is bounded on purpose: one readdir+stat pass (measured 4 ms over 128
 * files), then `verifyCwd` on at most CAND_MAX files, and only files written
 * within CAND_WINDOW_MS are verified at all. `verified` reports how many files
 * were actually verified — normally ≤ CAND_MAX, and up to CAND_MAX * CAND_ESCALATE
 * on the empty path described below.
 *
 * WHICH files get those slots is per-slug, not globally newest-first. §9.1's rule
 * is "the newest jsonl under the cwd's project slug", so a log must not lose its
 * slot to CAND_MAX unrelated logs in OTHER slugs. Measured (round 8 fix): with 8
 * fresh logs written in another project dir, a global newest-first cut returned
 * ZERO candidates for the pane's own cwd — and a pane whose herdr record points at
 * a missing log then answers `session_file_missing` although its live log was on
 * disk. So every slug's newest log is taken first (newest slug first), and only
 * then the second-newest log of a slug, up to CAND_MAX verifies. Inside one slug
 * the ranking is still mtime, which is what §9.1 asks for.
 *
 * An EMPTY result is then escalated: if the cut proved no candidate, the scan
 * keeps verifying newer-to-older up to CAND_MAX * CAND_ESCALATE files, because
 * "no log" is the answer the caller acts on (see the note in the body). No early
 * exit on the first hit — §9.1's ambiguity rule needs to see the close runner-up.
 *
 * @param paneCwd  herdr's cwd for the pane
 * @param opts     {max, windowMs}
 * @returns {candidates, scanned, verified} — candidates: [{id, path, mtimeMs}]
 */
async function candidatesForCwd(paneCwd, opts) {
  const o = opts || {};
  const max = Number.isFinite(o.max) && o.max > 0 ? Math.floor(o.max) : 8;
  const windowMs = Number.isFinite(o.windowMs) && o.windowMs > 0 ? o.windowMs : 900000;
  const root = projectsRoot();
  const fs = require('node:fs');
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return { candidates: [], scanned: 0, verified: 0 };
  }
  const now = Date.now();
  const files = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let names;
    try { names = fs.readdirSync(path.join(root, d.name)); } catch (e) { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const p = path.join(root, d.name, n);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        files.push({ id: n.slice(0, -'.jsonl'.length), path: p, mtimeMs: st.mtimeMs, size: st.size });
      } catch (e) { /* vanished between readdir and stat */ }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const fresh = files.filter((f) => now - f.mtimeMs <= windowMs && /^[A-Za-z0-9._-]+$/.test(f.id));
  // One slot per project slug before any slug's second log (see the note above):
  // `fresh` is already newest-first, so the first file seen per dir IS that dir's
  // newest.
  const perSlug = [];
  const seenSlugs = new Set();
  for (const f of fresh) {
    const slug = path.dirname(f.path);
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    perSlug.push(f);
  }
  const takenPaths = new Set(perSlug.map((f) => f.path));
  const considered = perSlug.concat(fresh.filter((f) => !takenPaths.has(f.path))).slice(0, max);
  const candidates = [];
  /** Verify one file and keep it if its own records prove this cwd. */
  const prove = async (f) => {
    let why;
    try {
      why = await verifyCwd(f.path, paneCwd);        // reads at most CWD_SEARCH_BYTES_MAX
    } catch (e) {
      why = { ok: false, reason: 'unreadable' };
    }
    if (why.ok) candidates.push({ id: f.id, path: f.path, mtimeMs: f.mtimeMs });
  };
  for (const f of considered) await prove(f);
  // Nothing in the cut proved this cwd — and that is the answer that matters: the
  // caller then falls back to herdr's record, whose dangling id becomes
  // `session_file_missing`. Measured (round 8 fix, a leftover fixture root): a pane
  // whose own FRESH log sat at rank 9 of 18 got zero candidates while its log was on
  // disk, because the eight ahead of it were other cwds sharing one synthetic slug.
  // So keep verifying, newest-first, up to CAND_ESCALATE * CAND_MAX files — the cost
  // is paid only on the path that would otherwise answer "no log at all".
  if (candidates.length === 0) {
    const seen = new Set(considered.map((f) => f.path));
    for (const f of fresh) {
      if (considered.length >= max * CAND_ESCALATE) break;
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      considered.push(f);
      await prove(f);
    }
  }
  return { candidates, scanned: files.length, verified: considered.length };
}

/** One content block → the text the client shows (verbatim, never rewritten). */
function blockText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // claude writes tool results as a plain string; a newer shape can carry an
    // array of blocks. Join their text — this is the only place a message's text
    // is not literally one field of one record, and it is still made of the
    // source characters in source order.
    const parts = [];
    for (const b of c) {
      if (b && typeof b.text === 'string') parts.push(b.text);
      else if (typeof b === 'string') parts.push(b);
    }
    return parts.join('\n');
  }
  if (c == null) return '';
  return typeof c === 'object' ? JSON.stringify(c) : String(c);
}

/**
 * One record → the units renderable from it, in source order (§8.2: claude's
 * order is file order).
 *
 * @returns {units, suppressed, kind}
 *   kind        'unknown' | 'skipped' | 'content'. 'content' means the record has
 *               units and its bucket depends on the merge decision the READER
 *               makes (a record whose only unit is a tool_result that pairs with
 *               a call already in the reply is `merged_records`) — see planBucket
 *               in common.js.
 *   suppressed  how many blank (empty or whitespace-only) text / thinking /
 *               system values were dropped so the stream carries no blank rows
 *               (round 7.1, DEFECT-10). Counted, never silently lost. A value
 *               that was never written (no field at all) is not a dropped row and
 *               is not counted — see isBlankValue in common.js.
 */
function parseRecord(rec) {
  const type = typeof rec.type === 'string' ? rec.type : '';
  if (!KNOWN_TYPES.has(type)) return { units: [], suppressed: 0, kind: 'unknown' };
  if (EXCLUDED_TYPES.has(type)) return { units: [], suppressed: 0, kind: 'skipped' };

  const uuid = typeof rec.uuid === 'string' && rec.uuid ? rec.uuid : null;
  const ts = toMs(rec.timestamp);
  const sidechain = !!rec.isSidechain;
  const out = [];
  let suppressed = 0;

  if (type === 'system') {
    // A local-command / informational line. It has no role of its own: it is
    // machine output, so it is 'tool' with kind 'system' (reported as a resolved
    // ambiguity — §8.2's role enum has no 'system').
    const { text, truncated } = clampText(rec.content == null ? '' : String(rec.content));
    if (text.trim()) {
      out.push(message({
        key: `${uuid || 'system'}:0`, ts, role: 'tool', kind: 'system',
        text, text_truncated: truncated, sidechain,
      }));
    } else if (isBlankValue(rec.content)) {
      suppressed++;
    }
    return { units: out, suppressed, kind: 'content' };
  }

  const content = rec.message && rec.message.content;
  const role = type === 'user' ? 'user' : 'assistant';
  const blocks = Array.isArray(content)
    ? content
    : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] || {};
    const bt = typeof b.type === 'string' ? b.type : '';
    if (!TEXT_BLOCKS.has(bt)) continue;             // an image, say: not text, not a unit
    const key = `${uuid || 'rec'}:${i}`;

    if (bt === 'text') {
      const { text, truncated } = clampText(b.text);
      if (!text.trim()) { suppressed++; continue; }  // DEFECT-10: a blank row is not a message
      out.push(message({ key, ts, role, kind: 'text', text, text_truncated: truncated, sidechain }));
    } else if (bt === 'thinking') {
      const { text, truncated } = clampText(b.thinking);
      if (!text.trim()) { suppressed++; continue; }
      out.push(message({ key, ts, role, kind: 'thinking', text, text_truncated: truncated, sidechain }));
    } else if (bt === 'tool_use') {
      // `input` is sent as the JSON text of the object: the client pretty-prints
      // it, and a JSON string is the only representation that cannot drift from
      // what the record holds.
      let input;
      try { input = JSON.stringify(b.input === undefined ? null : b.input); } catch (e) { input = String(b.input); }
      const clamped = clampText(input);
      out.push(message({
        key, ts, role, kind: 'tool_call', text: '', sidechain,
        tool: {
          name: b.name == null ? null : b.name, call_key: b.id == null ? null : b.id,
          input: clamped.text, input_truncated: clamped.truncated,
          result: null, result_truncated: false, is_error: false, pending: true,
        },
      }));
    } else {                                       // tool_result
      const { text, truncated } = clampText(blockText(b));
      out.push(message({
        key, ts, role, kind: 'tool_result', text: '', sidechain,
        tool: {
          name: null, call_key: b.tool_use_id == null ? null : b.tool_use_id,
          input: null, input_truncated: false,
          result: text, result_truncated: truncated,
          is_error: !!b.is_error, pending: false,
        },
      }));
    }
  }

  return { units: out, suppressed, kind: 'content' };
}

/**
 * Read one window of the log, forward from `since`.
 *
 * @param file    absolute path to the session jsonl
 * @param since   byte offset to start at (`cursor` from the previous reply)
 * @param limit   max messages to return
 * @returns {messages, cursor, records, skipped, unknown, empty, merged,
 *           emittedRecords, truncated, start, eof, tail:false}
 *
 * `records` counts the records this window processed; each one is in exactly one
 * of `emittedRecords` (produced ≥1 message), `merged` (its result was carried by
 * a card), `skipped` or `unknown`. `messages` counts units, so it can exceed
 * `emittedRecords` when a record holds several blocks — see common.js's header.
 *
 * `opts.working` is the caller's read of the pane's agent status (src/server.js
 * gets it from the pane list); it only ever affects a pending card's
 * `pending_reason` — see markPendingReasons.
 */
async function readWindow(file, since, limit, opts) {
  const fh = await fsp.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const start = Math.min(Math.max(0, since | 0), size);
    const messages = [];
    let bytes = 0;
    let records = 0;
    let skipped = 0;
    let unknown = 0;
    let empty = 0;
    let merged = 0;
    let emittedRecords = 0;
    let cursor = start;
    let truncated = false;

    let pos = start;
    let lineStart = start;          // absolute offset of the pending partial line
    let pending = null;             // Buffer of that partial line, or null
    let stop = false;

    // The call cards already in this window, by call_key: a tool_result whose
    // card is here is merged into it instead of being sent as a second message
    // (round 7.1, DEFECT-11 — see mergeResultIntoCall in common.js).
    const callIndex = new Map();
    const rememberCalls = (units) => {
      for (const u of units) {
        if (u && u.kind === 'tool_call' && u.tool && u.tool.call_key && !callIndex.has(u.tool.call_key)) {
          callIndex.set(u.tool.call_key, u);
        }
      }
    };

    while (!stop && pos < size) {
      if (pos - start >= LIMITS.WINDOW_BYTES_MAX) { truncated = true; break; }
      const want = Math.min(READ_CHUNK, size - pos);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (!bytesRead) break;
      pos += bytesRead;

      let data = pending ? Buffer.concat([pending, buf.subarray(0, bytesRead)], pending.length + bytesRead)
        : buf.subarray(0, bytesRead);
      let dataStart = lineStart;
      let nl;
      while ((nl = data.indexOf(0x0a)) >= 0) {
        const lineEnd = dataStart + nl;              // offset of the '\n'
        const raw = data.subarray(0, nl);
        data = data.subarray(nl + 1);
        dataStart = lineEnd + 1;

        const afterLine = lineEnd + 1;
        const text = raw.toString('utf8').replace(/^\uFEFF/, '');
        let rec = null;
        let parseFailed = false;
        if (text.trim()) {
          try { rec = JSON.parse(text); } catch (e) { parseFailed = true; }
        }

        // A blank line is not a record; an unparsable one is a record we cannot
        // read, and saying so beats dropping it.
        if (text.trim()) {
          const parsed = parseFailed
            ? { units: [], suppressed: 0, kind: 'unknown' }
            : parseRecord(rec);
          const plan = planUnits(parsed.units, callIndex);
          const bucket = parsed.kind === 'content' ? planBucket(plan) : parsed.kind;

          // Stop at RECORD boundaries: a record is either fully emitted or left
          // for the next call, so no unit is ever emitted twice.
          if (!fits(messages, plan, limit, bytes)) {
            if (!messages.length && plan.emit.length) {
              // One record alone overflows the reply: emit its first unit and say
              // so, rather than looping forever on the same offset. The record is
              // counted in its bucket like any other, so the counting identity
              // holds even here.
              const first = plan.emit[0];
              messages.push(first);
              bytes += Buffer.byteLength(JSON.stringify(first), 'utf8');
              records++;
              emittedRecords++;
              empty += parsed.suppressed;
              truncated = true;
              cursor = afterLine;
            } else {
              truncated = true;
            }
            stop = true;
            break;
          }

          bytes += plan.bytes;
          applyPlan(plan, callIndex);
          for (const m of plan.emit) messages.push(m);
          rememberCalls(plan.emit);
          records++;
          if (bucket === 'merged') merged++;
          else if (bucket === 'unknown') unknown++;
          else if (bucket === 'skipped') skipped++;
          else emittedRecords++;
          empty += parsed.suppressed;
          cursor = afterLine;
        }
        if (stop) break;
      }
      if (stop) break;
      // Whatever is left over has no '\n' yet: it is a partial line, not a record.
      pending = data.length ? Buffer.from(data) : null;
      lineStart = dataStart;
    }

    if (!stop && cursor < size) truncated = true;    // unread bytes (or a partial line) remain
    // The one ordering the inline merge cannot see: a result BEFORE its call.
    // Unmeasured in the live logs; it exists so an unusual log cannot duplicate a
    // result. Both counters move together, so the identity stays exact.
    const absorbed = absorbPairedResults(messages);
    if (absorbed) { merged += absorbed; emittedRecords -= absorbed; }
    // `!stop` is exactly "no whole record after this window": stopping early means
    // the caps were reached with complete records still unread. A half-written
    // trailing line is NOT a newer record — it is the live end mid-write, which is
    // the state 'awaiting' describes.
    markPendingReasons(messages, { working: !!(opts && opts.working), atLiveEnd: !stop });
    return {
      messages, cursor, records, skipped, unknown, empty, merged, emittedRecords,
      truncated, start, eof: size, tail: false,
    };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Round 7.1 (DEFECT-9) — the NEWEST whole records, with the cursor at the end of
 * the file, so opening a long session lands on the live turn.
 *
 * Reads BACKWARDS from EOF in READ_CHUNK pieces: bytes older than the window are
 * never read at all, so a large session costs a few chunks (the measured cost is
 * in the round-7.1 report), not a full scan. Only lines terminated by '\n' are
 * records — the file's trailing partial line is left alone, exactly as in the
 * forward reader, so nothing half-written is ever shown.
 *
 * `truncated` is true when messages were left out because they are OLDER than the
 * window — or because the newest record alone does not fit, the same edge the
 * forward reader has, carrying the same signal. The client gets the newest page
 * plus a cursor it can poll forward with from here on.
 *
 * A tail is a suffix, so it reaches the live end of the log unless a cap cut the
 * newest records; that is what decides `pending_reason: 'awaiting'` versus
 * `'not_in_window'` (see markPendingReasons in common.js). `opts.working` is the
 * caller's read of the pane's agent status.
 *
 * @returns the readWindow shape, plus `tailBytes` (source bytes actually read).
 */
async function readTail(file, limit, opts) {
  const fh = await fsp.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const max = limit == null ? LIMITS.LIMIT_DEFAULT : limit;
    const base = {
      messages: [], cursor: 0, records: 0, skipped: 0, unknown: 0, empty: 0,
      merged: 0, emittedRecords: 0, truncated: false, start: 0, eof: size,
      tailBytes: 0, tail: true,
    };
    if (!size) return base;

    // 1. Collect whole records from the end, oldest-first. `parsedFrom` is the
    //    offset of the oldest line already parsed, so a line cut by a chunk
    //    boundary is parsed exactly once — when the next chunk completes it.
    let scanned = [];               // [{start, end, parsed}] ascending
    let buf = Buffer.alloc(0);      // bytes [bufStart, size)
    let bufStart = size;
    let parsedFrom = size;
    // What the scanned records would EMIT — units minus the pairs that join, which
    // is what `limit` counts (see mergeCounts in common.js): scanning to `max` raw
    // units alone stops short, because every joined result is charged as a unit but
    // never becomes a message.
    const seen = mergeCounts();
    let cost = 0;                   // two caps, the same the reply obeys
    let tailBytes = 0;

    for (;;) {
      const start = Math.max(0, bufStart - READ_CHUNK);
      const chunk = Buffer.alloc(bufStart - start);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, start);
      if (!bytesRead) break;
      tailBytes += bytesRead;
      buf = Buffer.concat([chunk.subarray(0, bytesRead), buf]);
      bufStart = start;

      const fresh = [];
      const floor = parsedFrom;    // lines at or after this were parsed in earlier rounds
      let from = 0;                // buffer-relative scan position
      let lineStart = bufStart;    // ABSOLUTE offset of the line being read
      let nl;
      let isFirstLine = true;
      while ((nl = buf.indexOf(0x0a, from)) >= 0) {
        const lineEnd = bufStart + nl;                // absolute offset of the '\n'
        const isFirst = isFirstLine;
        isFirstLine = false;
        from = nl + 1;
        // `floor`, not `parsedFrom`: within a round the line starts only grow, so
        // comparing against a value this loop keeps lowering would hide every line
        // after the first one it parsed. Skip a line only when it is at or after
        // the floor (an earlier round had it) or when it is the buffer's first line
        // and its beginning is still in an earlier chunk.
        if (lineStart < floor && !(isFirst && bufStart > 0)) {
          const text = buf.subarray(lineStart - bufStart, nl).toString('utf8').replace(/^\uFEFF/, '');
          // A blank line is not a record. It too is re-checked rather than marked.
          if (text.trim()) {
            let rec = null;
            let parseFailed = false;
            try { rec = JSON.parse(text); } catch (e) { parseFailed = true; }
            const parsed = parseFailed ? { units: [], suppressed: 0, kind: 'unknown' } : parseRecord(rec);
            fresh.push({ start: lineStart, end: lineEnd + 1, parsed });
            // The floor is the SMALLEST start parsed so far — lines ascend inside
            // this round, so assigning blindly would hide the ones before it.
            if (lineStart < parsedFrom) parsedFrom = lineStart;
            addUnits(seen, parsed.units);
            cost += Buffer.byteLength(JSON.stringify(parsed.units), 'utf8');
          }
        }
        lineStart = lineEnd + 1;
      }
      if (fresh.length) scanned = fresh.concat(scanned);

      if (bufStart === 0) break;
      if (emittedUnits(seen) >= max) break;
      if (cost >= LIMITS.RESPONSE_BYTES_MAX) break;
      if (size - bufStart >= LIMITS.WINDOW_BYTES_MAX) break;
    }

    // 2. Keep the newest whole records that fit. The newest one is always kept, so
    //    the caller always sees the live end of the conversation. The count is the
    //    MESSAGES the window will emit, the number `limit` means: `suffix[i]` is
    //    what records i..end emit together, so a record whose pairs live inside the
    //    window is charged one message, not two.
    const suffix = new Array(scanned.length);
    const model = mergeCounts();
    for (let i = scanned.length - 1; i >= 0; i--) {
      addUnits(model, scanned[i].parsed.units);
      suffix[i] = emittedUnits(model);
    }
    const kept = [];
    let keptBytes = 0;
    for (let i = scanned.length - 1; i >= 0; i--) {
      const rec = scanned[i];
      const b = Buffer.byteLength(JSON.stringify(rec.parsed.units), 'utf8');
      if (kept.length && (suffix[i] > max || keptBytes + b > LIMITS.RESPONSE_BYTES_MAX)) break;
      kept.push(rec);
      keptBytes += b;
    }
    kept.reverse();

    // 3. Build the messages in source order, merging results into the cards that
    //    are already in the window (a call is written before its result, so this
    //    is the normal case and the window is self-contained).
    const messages = [];
    let records = 0;
    let skipped = 0;
    let unknown = 0;
    let empty = 0;
    let merged = 0;
    let emittedRecords = 0;
    let emittedBytes = 0;
    let truncated = !!(kept.length && kept[0].start > 0);
    const callIndex = new Map();
    let lastEmitted = null;
    let droppedNewest = false;     // a cap cut records that are NEWER than the window
    for (const rec of kept) {
      const plan = planUnits(rec.parsed.units, callIndex);
      // `kept` was chosen to fit, so this can only fire for the newest record
      // when ONE record is larger than the whole byte cap by itself — 250 KB in
      // the largest live record measured (round 7.1). The reply still stops at the
      // caps, exactly as the forward reader does, and `truncated` says so.
      if (emittedBytes + plan.bytes > LIMITS.RESPONSE_BYTES_MAX
        || (messages.length + plan.emit.length > max && messages.length)) {
        if (!messages.length && plan.emit.length) {
          const first = plan.emit[0];
          messages.push(first);
          emittedBytes += Buffer.byteLength(JSON.stringify(first), 'utf8');
          records++;
          emittedRecords++;
          empty += rec.parsed.suppressed;
          lastEmitted = rec;
        }
        truncated = true;
        droppedNewest = true;
        break;
      }
      for (const u of plan.emit) {
        messages.push(u);
        if (u.kind === 'tool_call' && u.tool && u.tool.call_key && !callIndex.has(u.tool.call_key)) {
          callIndex.set(u.tool.call_key, u);
        }
      }
      // A result whose card is in this window rides inside that card — the merge
      // planUnits decided on and priced. Without this the card would be emitted
      // `pending: true` and the result text would be dropped from the reply.
      applyPlan(plan, callIndex);
      const bucket = rec.parsed.kind === 'content' ? planBucket(plan) : rec.parsed.kind;
      records++;
      if (bucket === 'merged') merged++;
      else if (bucket === 'unknown') unknown++;
      else if (bucket === 'skipped') skipped++;
      else emittedRecords++;
      empty += rec.parsed.suppressed;
      emittedBytes += plan.bytes;
      lastEmitted = rec;
    }
    const absorbed = absorbPairedResults(messages);
    if (absorbed) { merged += absorbed; emittedRecords -= absorbed; }

    // The newest scanned record is always in `kept`, so `!droppedNewest` is "the
    // log's newest whole record was emitted": nothing newer exists to hold this
    // card's result. (A half-written trailing line is the live end mid-write, the
    // state this reason is about — not a newer record.)
    markPendingReasons(messages, {
      working: !!(opts && opts.working),
      atLiveEnd: !!lastEmitted && !droppedNewest,
    });

    const oldest = kept.length ? kept[0] : null;
    return {
      messages,
      // Where the next forward call must resume: after the newest record actually
      // emitted. That is EOF whenever the file ends on a record boundary, and just
      // before a half-written trailing line when it does not — so the next poll
      // picks that line up whole instead of reading it twice.
      cursor: lastEmitted ? lastEmitted.end : 0,
      records, skipped, unknown, empty, merged, emittedRecords,
      truncated,
      start: oldest ? oldest.start : size,
      eof: size,
      tailBytes,
      tail: true,
    };
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Would adding this plan to `messages` stay inside the count and byte caps? The
 *  plan already prices the copy a merge makes (common.js's planUnits). */
function fits(messages, plan, limit, bytes) {
  const max = limit == null ? LIMITS.LIMIT_DEFAULT : limit;
  if (messages.length + plan.emit.length > max) return false;
  return bytes + plan.bytes <= LIMITS.RESPONSE_BYTES_MAX;
}

module.exports = {
  SOURCE_KIND, EXCLUDED_TYPES, KNOWN_TYPES, MESSAGE_TYPES, projectsRoot, findSessionFile,
  verifyCwd, sameCwd, parseRecord, readWindow, readTail, blockText, candidatesForCwd,
};
