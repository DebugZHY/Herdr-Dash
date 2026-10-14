'use strict';
/*
 * src/chat/pi.js — pi's session log → the shared chat message shape.
 *
 * THE SOURCE
 *
 *   ~/.pi/agent/sessions/<slug>/<ISO-stamp>_<uuid>.jsonl — one JSON record per
 *   line, appended while the agent works. The slug is NOT derivable from the
 *   pane's cwd (measured: `--D--PycharmProjects-mastan2-web--` for
 *   D:\PycharmProjects\mastan2-web), so this module globs every session
 *   directory for `<uuid>.jsonl` / `*_<uuid>.jsonl` and then VERIFIES the file
 *   really belongs to the pane by comparing a record's own `cwd` with herdr's
 *   cwd for that pane. A file that fails that check is never read for content.
 *
 * THE CURSOR
 *
 *   A byte offset into the file. Records already handed to the client are never
 *   re-parsed: the cursor sits just after the last COMPLETE line processed. A
 *   half-written trailing line is not a record, is not emitted, and does NOT move
 *   the cursor — the next call reads it from its first byte.
 *
 * WHAT A RECORD BECOMES
 *
 *   Every record lands in exactly one accounting bucket:
 *     message        records that produced at least one message
 *     merged         a tool result whose call card is in the same reply; the card
 *                    already carries the text
 *     skipped        `session`, `model_change`, `thinking_level_change`, `label`,
 *                    the harness's own role:"system" prompt, and records that
 *                    render to nothing
 *     unknown        any other record type — counted, never dropped
 *
 *   A text / thinking value that is blank (empty or only whitespace) is not a
 *   message and is counted so the drop is visible; an absent value is not a
 *   dropped row. A tool result whose call is in the same reply is folded into
 *   that call card rather than emitted as a second message.
 *
 * TAIL MODE
 *
 *   `readTail` answers with the NEWEST messages and a cursor at the end of the
 *   file, so opening a long session lands on the live turn. It scans BACKWARDS
 *   from EOF in `TAIL_CHUNK` pieces and never decodes older bytes.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  LIMITS, clampText, isBlankValue, toMs, message, planUnits, applyPlan, planBucket, absorbPairedResults,
  addUnits, emittedUnits, mergeCounts, markPendingReasons,
} = require('./common');

const SOURCE_KIND = 'pi_jsonl';
const READ_CHUNK = 64 * 1024;

/** The piece size of the backwards tail scan. The scan loop is piece-size
 *  agnostic (it carries a partial first line across the boundary and tracks
 *  absolute offsets), so this only trades read passes and per-pass re-copies
 *  against the size of the buffer it rebuilds. `HD_CHAT_TAIL_CHUNK` overrides
 *  it; anything below 8 KiB is refused because a piece smaller than one line is
 *  correct but pointless. */
const TAIL_CHUNK = (() => {
  const raw = Number(process.env.HD_CHAT_TAIL_CHUNK);
  return Number.isFinite(raw) && raw >= 8 * 1024 ? Math.floor(raw) : 512 * 1024;
})();

/** The candidate scan verifies at most CAND_MAX files. When that cut proves
 *  NOTHING for the pane's cwd the scan keeps verifying up to CAND_MAX * this many
 *  files before it answers "this pane has no pi log". */
const CAND_ESCALATE = 4;

/** Record types that are counted in `skipped`, never rendered. */
const EXCLUDED_TYPES = new Set(['session', 'model_change', 'thinking_level_change', 'label']);

/** The record type this parser turns into messages. */
const MESSAGE_TYPES = new Set(['message']);

/** Every record type this parser has an opinion about. A type outside this set
 *  is `unknown`. */
const KNOWN_TYPES = new Set([...MESSAGE_TYPES, ...EXCLUDED_TYPES]);

/** Where pi keeps its sessions. `PI_SESSIONS_DIR` lets a test point the reader
 *  at a fixture tree without writing inside the user's real ~/.pi. */
function sessionsRoot() {
  return process.env.PI_SESSIONS_DIR || path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

/** The session id a file name carries: the part after the LAST '_', which is the
 *  uuid herdr reports. A name with no '_' is used whole. */
function sessionIdOf(name) {
  const base = String(name).replace(/\.jsonl$/, '');
  const i = base.lastIndexOf('_');
  return i >= 0 ? base.slice(i + 1) : base;
}

/**
 * Find `<id>.jsonl` or `*_<id>.jsonl` under any session directory.
 *
 * The id comes from herdr but ends up in a path, so it is validated first: an id
 * containing a separator or `..` could not be a real session id, and refusing it
 * here means no other code has to trust it. Returns null when nothing matches.
 */
function findSessionFile(sessionId) {
  const id = String(sessionId == null ? '' : sessionId);
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') return null;
  const root = sessionsRoot();
  const fs = require('node:fs');
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return null;                                  // no sessions dir at all
  }
  const exact = id + '.jsonl';
  const suffix = '_' + id + '.jsonl';
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    let hit = names.includes(exact) ? exact : names.find((n) => n.endsWith(suffix));
    if (!hit) continue;
    const candidate = path.join(dir, hit);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (e) { /* not in this session directory */ }
  }
  return null;
}

/** Compare herdr's cwd for the pane with a cwd a pi record carries. Windows
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
 * `cwd`, and comparing it with herdr's. Reads at most CWD_SEARCH_BYTES_MAX bytes.
 *
 * Returns {ok:true, cwd} | {ok:false, reason}. `reason: 'empty'` means the file
 * has no records at all: there is nothing to leak, so the caller can answer
 * "no messages yet" rather than accusing a brand-new session of a mismatch.
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
    // Records exist but none names a cwd: we cannot prove which project this
    // file belongs to, and an unproven file must not be shown.
    return { ok: false, reason: 'unverifiable' };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Which conversations could belong to a pane whose herdr record cannot be
 * trusted? The directory is named after a slug that is not derivable from the
 * cwd, so this searches ALL session directories and keeps a file only when it
 * PROVES the pane's cwd the same way the bound file does.
 *
 * Cost is bounded: one readdir+stat pass, then `verifyCwd` on at most `max`
 * files, and only files written within `windowMs` are verified at all. Every
 * directory's newest log is taken first (newest directory first), so a log in
 * the pane's own directory cannot lose its slot to `max` unrelated logs in other
 * directories. An EMPTY result is escalated: the scan keeps verifying
 * newer-to-older up to `max * CAND_ESCALATE` files, because "no log" is the
 * answer the caller acts on.
 *
 * @returns {candidates, scanned, verified} — candidates: [{id, path, mtimeMs}]
 */
async function candidatesForCwd(paneCwd, opts) {
  const o = opts || {};
  const max = Number.isFinite(o.max) && o.max > 0 ? Math.floor(o.max) : 8;
  // pi sessions outlive a 15-minute liveness window by hours (a pane can sit
  // idle overnight and still be resumed), so the default here is a day; the
  // caller may still narrow it through opts.
  const windowMs = Number.isFinite(o.windowMs) && o.windowMs > 0 ? o.windowMs : 24 * 60 * 60 * 1000;
  const root = sessionsRoot();
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
      const id = sessionIdOf(n);
      if (!/^[A-Za-z0-9._-]+$/.test(id)) continue;
      const p = path.join(root, d.name, n);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        files.push({ id, path: p, mtimeMs: st.mtimeMs });
      } catch (e) { /* vanished between readdir and stat */ }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const fresh = files.filter((f) => now - f.mtimeMs <= windowMs);
  // One slot per directory before any directory's second log: `fresh` is already
  // newest-first, so the first file seen per directory IS that directory's newest.
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
  // Nothing in the cut proved this cwd: keep verifying, newest-first, up to the
  // escalation bound. The cost is paid only on the path that would otherwise
  // answer "no log at all".
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

/** Flatten a tool result's value to text: a string is itself, an array joins the
 *  text it holds, anything else is its JSON. This never rewrites the source
 *  characters; it only decides which field carries them. */
function flattenValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = [];
    for (const b of value) {
      if (b == null) continue;
      if (typeof b === 'string') { parts.push(b); continue; }
      if (typeof b.text === 'string') parts.push(b.text);
      else if (typeof b.content === 'string') parts.push(b.content);
      else parts.push(JSON.stringify(b));
    }
    return parts.join('\n');
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** The text a tool result part or a role:"tool" message carries. */
function resultText(part) {
  const c = part.content !== undefined ? part.content
    : part.output !== undefined ? part.output
      : part.result !== undefined ? part.result
        : part.text;
  return flattenValue(c);
}

/**
 * One record → the units renderable from it, in source order.
 *
 * @returns {units, suppressed, kind}
 *   kind        'unknown' | 'skipped' | 'content'. 'content' means the record has
 *               units and its bucket depends on the merge decision the READER
 *               makes — see planBucket in common.js.
 *   suppressed  how many blank text / thinking values were dropped; an absent
 *               field is not a dropped row and is not counted.
 */
function parseRecord(rec) {
  const type = typeof rec.type === 'string' ? rec.type : '';
  if (!KNOWN_TYPES.has(type)) return { units: [], suppressed: 0, kind: 'unknown' };
  if (EXCLUDED_TYPES.has(type)) return { units: [], suppressed: 0, kind: 'skipped' };

  const uuid = typeof rec.id === 'string' && rec.id ? rec.id : null;
  const ts = toMs(rec.timestamp);
  const msg = rec.message && typeof rec.message === 'object' ? rec.message : {};
  const role = typeof msg.role === 'string' ? msg.role : '';
  // The harness writes its own giant system prompt as a role:"system" message;
  // it is not conversation, so it is skipped like the structural records.
  if (role === 'system') return { units: [], suppressed: 0, kind: 'skipped' };

  const out = [];
  let suppressed = 0;
  const emitRole = role === 'user' ? 'user' : 'assistant';
  const content = msg.content;
  const blocks = Array.isArray(content)
    ? content
    : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
  const fallbackCall = msg.toolCallId != null ? msg.toolCallId : (rec.toolCallId != null ? rec.toolCallId : null);

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] || {};
    const bt = typeof b.type === 'string' ? b.type : '';
    const key = `${uuid || 'rec'}:${i}`;
    const callKey = b.toolCallId != null ? b.toolCallId : (b.id != null ? b.id : fallbackCall);

    if (role === 'tool' || bt === 'toolResult') {
      const { text, truncated } = clampText(resultText(b));
      out.push(message({
        key, ts, role: 'tool', kind: 'tool_result', text: '',
        tool: {
          name: b.name == null ? null : b.name, call_key: callKey,
          input: null, input_truncated: false,
          result: text, result_truncated: truncated,
          is_error: !!(b.isError || b.is_error), pending: false,
        },
      }));
    } else if (bt === 'text') {
      const { text, truncated } = clampText(b.text);
      if (!text.trim()) { if (isBlankValue(b.text)) suppressed++; continue; }
      out.push(message({ key, ts, role: emitRole, kind: 'text', text, text_truncated: truncated, sidechain: false }));
    } else if (bt === 'thinking') {
      const raw = b.thinking !== undefined ? b.thinking : b.text;
      const { text, truncated } = clampText(raw);
      if (!text.trim()) { if (isBlankValue(raw)) suppressed++; continue; }
      out.push(message({ key, ts, role: emitRole, kind: 'thinking', text, text_truncated: truncated, sidechain: false }));
    } else if (bt === 'toolCall') {
      // `input` is sent as the JSON text of the object: the client pretty-prints
      // it, and a JSON string cannot drift from what the record holds.
      const rawInput = b.input !== undefined ? b.input : b.args;
      let input;
      try { input = JSON.stringify(rawInput === undefined ? null : rawInput); } catch (e) { input = String(rawInput); }
      const clamped = clampText(input);
      out.push(message({
        key, ts, role: emitRole, kind: 'tool_call', text: '',
        tool: {
          name: b.name == null ? null : b.name, call_key: callKey,
          input: clamped.text, input_truncated: clamped.truncated,
          result: null, result_truncated: false, is_error: false, pending: true,
        },
      }));
    }
  }

  return { units: out, suppressed, kind: 'content' };
}

/**
 * Read one window of the log, forward from `since`.
 *
 * @returns {messages, cursor, records, skipped, unknown, empty, merged,
 *           emittedRecords, truncated, start, eof, tail:false}
 *
 * Each processed record is in exactly one of `emittedRecords`, `merged`,
 * `skipped` or `unknown`. `messages` counts units, so it can exceed
 * `emittedRecords` when a record holds several blocks. `opts.working` is the
 * caller's read of the pane's agent status; it only affects a pending card's
 * `pending_reason`.
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
    // card is here is merged into it instead of sent as a second message.
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
              // so, rather than looping forever on the same offset.
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
    const absorbed = absorbPairedResults(messages);
    if (absorbed) { merged += absorbed; emittedRecords -= absorbed; }
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
 * The NEWEST whole records, with the cursor at the end of the file, so opening a
 * long session lands on the live turn.
 *
 * Reads BACKWARDS from EOF in TAIL_CHUNK pieces: bytes older than the window are
 * never read at all. Only lines terminated by '\n' are records — the file's
 * trailing partial line is left alone, exactly as in the forward reader, so
 * nothing half-written is ever shown. `truncated` is true when messages were left
 * out because they are older than the window, or because the newest record alone
 * does not fit. `opts.working` is the caller's read of the pane's agent status.
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
    // is what `limit` counts.
    const seen = mergeCounts();
    let cost = 0;                   // two caps, the same the reply obeys
    let tailBytes = 0;

    for (;;) {
      const start = Math.max(0, bufStart - TAIL_CHUNK);
      const chunk = Buffer.alloc(bufStart - start);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, start);
      if (!bytesRead) break;
      tailBytes += bytesRead;
      buf = Buffer.concat([chunk.subarray(0, bytesRead), buf]);
      bufStart = start;

      const fresh = [];
      const floor = parsedFrom;    // lines at or after this were parsed in earlier passes
      let from = 0;                // buffer-relative scan position
      let lineStart = bufStart;    // ABSOLUTE offset of the line being read
      let nl;
      let isFirstLine = true;
      while ((nl = buf.indexOf(0x0a, from)) >= 0) {
        const lineEnd = bufStart + nl;                // absolute offset of the '\n'
        const isFirst = isFirstLine;
        isFirstLine = false;
        from = nl + 1;
        // Skip a line only when it is at or after the floor (an earlier pass had
        // it) or when it is the buffer's first line and its beginning is still in
        // an earlier chunk.
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
            // this pass, so assigning blindly would hide the ones before it.
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
    //    MESSAGES the window will emit: `suffix[i]` is what records i..end emit
    //    together, so a record whose pairs live inside the window is charged one
    //    message, not two.
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
      // `kept` was chosen to fit, so this can only fire when ONE record is larger
      // than the whole byte cap by itself. The reply still stops at the caps,
      // exactly as the forward reader does, and `truncated` says so.
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
    // card's result.
    markPendingReasons(messages, {
      working: !!(opts && opts.working),
      atLiveEnd: !!lastEmitted && !droppedNewest,
    });

    const oldest = kept.length ? kept[0] : null;
    return {
      messages,
      // Where the next forward call must resume: after the newest record actually
      // emitted. That is EOF whenever the file ends on a record boundary, and just
      // before a half-written trailing line when it does not.
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

/** Would adding this plan to `messages` stay inside the count and byte caps? */
function fits(messages, plan, limit, bytes) {
  const max = limit == null ? LIMITS.LIMIT_DEFAULT : limit;
  if (messages.length + plan.emit.length > max) return false;
  return bytes + plan.bytes <= LIMITS.RESPONSE_BYTES_MAX;
}

module.exports = {
  SOURCE_KIND, EXCLUDED_TYPES, KNOWN_TYPES, MESSAGE_TYPES, sessionsRoot, findSessionFile,
  verifyCwd, sameCwd, parseRecord, readWindow, readTail, candidatesForCwd,
};