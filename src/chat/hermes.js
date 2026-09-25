'use strict';
/*
 * src/chat/hermes.js — hermes' sqlite state → §8.2's message shape (owner: W1).
 *
 * THE SOURCE
 *
 *   %LOCALAPPDATA%/hermes/state.db (or HERMES_STATE_DB), table `messages`:
 *
 *     id INTEGER PRIMARY KEY AUTOINCREMENT, session_id, role, content,
 *     tool_call_id, tool_calls, tool_name, timestamp REAL, reasoning,
 *     reasoning_content, …
 *
 *   hermes is RUNNING while we read: the connection is opened read-only, so a
 *   read can never take a write lock and can never be the reason a turn stalls.
 *   The URI form (`file:…?mode=ro`) and the `readOnly` option are both set —
 *   either alone is enough, and the belt-and-braces pair is free.
 *
 * THE CURSOR
 *
 *   The last row `id` handed to the client. The next call asks for `id > cursor`
 *   strictly, so a row is never emitted twice, and an idle session answers with
 *   `messages: []` at the same cursor.
 *
 * ROW → MESSAGE
 *
 *   role 'user'      content            → one text message
 *   role 'assistant' content            → text
 *                    reasoning          → thinking (see the dedupe note below)
 *                    tool_calls[i]      → one tool_call message each
 *   role 'tool'      content + tool_name→ tool_result, keyed by tool_call_id
 *   anything else                       → `unknown_records`
 *
 *   `reasoning` and `reasoning_content` hold the same text (measured: identical
 *   in 439/439 rows of the live session) — one thinking message, not two.
 *
 *   `content` is plain text in this store (a tool row's content is often a JSON
 *   *string*, but it is text and is passed through verbatim: parsing it would be
 *   rewriting the source, which §8.2 forbids).
 *
 *   hermes records no per-result error flag (`effect_disposition` is NULL in
 *   4326/4328 rows, `unknown` in the other two), so `is_error` is always false
 *   here — the failure, when there is one, is inside the result text itself.
 *
 * REPEATED CALL IDS — the pairing preference, stated
 *
 *   This store repeats `tool_call_id`: measured on the live w4:p1 session, 141
 *   ids are declared by more than one assistant row (789 tool rows over 648
 *   distinct ids in one tail window). §8.2 pairs by id, and when an id is not
 *   unique the rule here is **first card wins**: the earliest card for that id in
 *   the window is the merge target (`callIndex` registers the first card per key
 *   and never re-points), and a result row merges into it — so the later twin
 *   stays `pending: true` even though a result row for its id sits in the window.
 *   Round 7.3 labels exactly that case `pending_reason: 'duplicate_id'` rather
 *   than pretending the result has not arrived (see markPendingReasons in
 *   common.js). Changing WHICH card takes the merge is a contract question, not a
 *   reader's choice: it is left as first-wins and reported.
 */

const path = require('node:path');
const {
  LIMITS, clampText, isBlankValue, toMs, message, planUnits, applyPlan, planBucket, absorbPairedResults,
  mergeCounts, mergeDelta, addUnits, emittedUnits, markPendingReasons,
} = require('./common');

const SOURCE_KIND = 'hermes_sqlite';
const ROW_BATCH = 200;                 // rows fetched per query, never per unit

/** %LOCALAPPDATA%/hermes/state.db, or HERMES_STATE_DB when set (§8.1). */
function dbPath() {
  if (process.env.HERMES_STATE_DB) return process.env.HERMES_STATE_DB;
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || '';
  return path.join(base, 'hermes', 'state.db');
}

/** The URI sqlite itself understands; backslashes break it, forward slashes do not. */
function readOnlyUri(file) {
  const slashed = String(file).split(path.sep).join('/');
  return 'file:' + slashed + '?mode=ro';
}

/**
 * Open the state database READ-ONLY.
 *
 * node:sqlite is required lazily so that a server which never receives a chat
 * request never loads the (still experimental) module — and never prints its
 * experimental-feature warning into the startup banner.
 */
function openReadOnly(file) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(readOnlyUri(file), { readOnly: true });
}

// ── round 7.6 (§9.1): the store's own record of which sessions ran in a cwd ──
/**
 * The newest `sessions` rows, newest first. This is the SECOND signal of §9.1's
 * order: a `/clear`ed pane can be re-bound from the store alone when its banner
 * has scrolled away, and a banner id can be CORROBORATED here (a brand-new
 * session has no row yet — measured on 20260925_111907_781d40 — so "no row" is
 * information, never an error).
 *
 * The caller filters by cwd: the comparison is the same case-insensitive,
 * separator-insensitive one §8.1 uses for claude, and doing it in JS keeps the
 * cwd out of SQL string building entirely.
 *
 * @param limit max rows to look at (newest first, by last activity)
 * @returns [{id, cwd, started_at, last_activity_at, ended_at, message_count}]
 *          `[]` when the store has no such table (an older store) or no rows.
 */
function recentSessions(file, limit) {
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 40;
  let db;
  try {
    db = openReadOnly(file);
    try {
      return db.prepare(
        `SELECT id, cwd, started_at, last_activity_at, ended_at, message_count
           FROM sessions
          ORDER BY COALESCE(last_activity_at, started_at) DESC
          LIMIT ?`,
      ).all(n).map((r) => ({
        id: r.id == null ? '' : String(r.id),
        cwd: r.cwd == null ? null : String(r.cwd),
        started_at: r.started_at == null ? null : Number(r.started_at),
        last_activity_at: r.last_activity_at == null ? null : Number(r.last_activity_at),
        ended_at: r.ended_at == null ? null : Number(r.ended_at),
        message_count: r.message_count == null ? null : Number(r.message_count),
      })).filter((r) => r.id);
    } catch (e) {
      return [];                       // no `sessions` table: nothing to say
    }
  } catch (e) {
    return [];                         // no database at all
  } finally {
    if (db) { try { db.close(); } catch (e) { /* already gone */ } }
  }
}

/**
 * Does the store know this session at all — a `sessions` row or any message row?
 * §9.1's corroboration for a banner id. Cheap: two indexed lookups, and both are
 * allowed to fail into `false` (an unreadable store cannot corroborate anything).
 */
function sessionKnown(file, sessionId) {
  const id = sessionId == null ? '' : String(sessionId);
  if (!id) return false;
  let db;
  try {
    db = openReadOnly(file);
    try {
      const s = db.prepare('SELECT 1 AS x FROM sessions WHERE id = ? LIMIT 1').get(id);
      if (s) return true;
    } catch (e) { /* no sessions table */ }
    try {
      const m = db.prepare('SELECT 1 AS x FROM messages WHERE session_id = ? LIMIT 1').get(id);
      return !!m;
    } catch (e) {
      return false;
    }
  } catch (e) {
    return false;
  } finally {
    if (db) { try { db.close(); } catch (e) { /* already gone */ } }
  }
}

/** The tool_calls column is a JSON array string; each entry is one call. */
function parseToolCalls(raw) {
  if (raw == null) return [];
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch (e) { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((c) => c && typeof c === 'object');
}

/** An OpenAI-shaped call: {id|call_id, function:{name, arguments}}. */
function callName(call) {
  const fn = call.function || call;
  return fn && fn.name != null ? String(fn.name) : null;
}
function callId(call, i) {
  const id = call.id || call.call_id || call.tool_call_id;
  return id == null ? `call#${i}` : String(id);
}
function callInput(call) {
  const fn = call.function || call;
  const args = fn ? fn.arguments : undefined;
  if (args == null) return null;
  if (typeof args === 'string') return args;         // already JSON text
  try { return JSON.stringify(args); } catch (e) { return String(args); }
}

/**
 * One row → the units renderable from it, in source order — the same contract as
 * claude.js's parseRecord, so one counting rule covers both stores.
 *
 * @returns {units, suppressed, kind}
 *   kind        'unknown' | 'content' ('content' = the bucket depends on the
 *               merge decision the reader makes — see planBucket in common.js)
 *   suppressed  how many blank (empty or whitespace-only) content/reasoning
 *               fields were dropped so the stream carries no blank rows
 *               (round 7.1, DEFECT-10). Counted, never silently lost.
 */
function parseRow(row) {
  const role = typeof row.role === 'string' ? row.role : '';
  const id = row.id;
  const ts = toMs(row.timestamp);
  const out = [];
  let suppressed = 0;

  if (role === 'user') {
    const { text, truncated } = clampText(row.content);
    if (text.trim()) {
      out.push(message({ key: `${id}:0`, ts, role: 'user', kind: 'text', text, text_truncated: truncated }));
    } else if (isBlankValue(row.content)) {
      suppressed++;                          // a written-but-empty prompt, dropped
    }
    return { units: out, suppressed, kind: 'content' };
  }

  if (role === 'assistant') {
    let i = 0;
    const content = clampText(row.content);
    if (content.text.trim()) {
      out.push(message({ key: `${id}:${i++}`, ts, role: 'assistant', kind: 'text', text: content.text, text_truncated: content.truncated }));
    } else if (isBlankValue(row.content)) {
      // Round 7.1 / DEFECT-10: "" and "   " are not rows. Counted, and counted
      // even when the row carries calls or reasoning of its own (the blank value
      // was dropped either way) — the row is still a normal record then.
      suppressed++;
    }
    const thinking = (row.reasoning != null && String(row.reasoning)) || (row.reasoning_content != null && String(row.reasoning_content)) || '';
    const think = clampText(thinking);
    if (think.text.trim()) {
      out.push(message({ key: `${id}:${i++}`, ts, role: 'assistant', kind: 'thinking', text: think.text, text_truncated: think.truncated }));
    } else if (isBlankValue(row.reasoning) || isBlankValue(row.reasoning_content)) {
      suppressed++;
    }
    const calls = parseToolCalls(row.tool_calls);
    for (let c = 0; c < calls.length; c++) {
      const clamped = clampText(callInput(calls[c]));
      out.push(message({
        key: `${id}:${i++}`, ts, role: 'assistant', kind: 'tool_call', text: '',
        tool: {
          name: callName(calls[c]), call_key: callId(calls[c], c),
          input: clamped.text, input_truncated: clamped.truncated,
          result: null, result_truncated: false, is_error: false, pending: true,
        },
      }));
    }
    return { units: out, suppressed, kind: 'content' };
  }

  if (role === 'tool') {
    // A tool row always becomes a card: an empty `content` is real (a command that
    // printed nothing), and its name/call_key are what the renderer pairs on.
    const { text, truncated } = clampText(row.content == null ? '' : String(row.content));
    out.push(message({
      key: `${id}:0`, ts, role: 'tool', kind: 'tool_result', text: '',
      tool: {
        name: row.tool_name == null ? null : String(row.tool_name),
        call_key: row.tool_call_id == null ? null : String(row.tool_call_id),
        input: null, input_truncated: false,
        result: text, result_truncated: truncated,
        is_error: false, pending: false,
      },
    }));
    return { units: out, suppressed, kind: 'content' };
  }

  // Measured roles in the live store are exactly user / assistant / tool; a row
  // with any other role is a shape this parser has no rule for, and is counted
  // rather than guessed at.
  return { units: [], suppressed: 0, kind: 'unknown' };
}

/** Would adding this plan stay inside the count and byte caps? The plan already
 *  prices the copy a merge makes (see planUnits in common.js). */
function fits(messages, plan, limit, bytes) {
  const max = limit == null ? LIMITS.LIMIT_DEFAULT : limit;
  if (messages.length + plan.emit.length > max) return false;
  return bytes + plan.bytes <= LIMITS.RESPONSE_BYTES_MAX;
}

/**
 * Read one window of a session, row by row, stopping only at ROW boundaries so
 * no row's units are ever split across two replies.
 *
 * `opts.working` is the caller's read of the pane's agent status (src/server.js
 * gets it from the pane list); it only ever downgrades a pending card's
 * `pending_reason` — see markPendingReasons.
 *
 * @returns {messages, cursor, records, skipped, unknown, empty, merged,
 *           emittedRecords, truncated, tail:false}
 */
function readWindow(file, sessionId, since, limit, opts) {
  const db = openReadOnly(file);
  try {
    const sel = db.prepare('SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?');
    const messages = [];
    let bytes = 0;
    let records = 0;
    let skipped = 0;
    let unknown = 0;
    let empty = 0;
    let merged = 0;
    let emittedRecords = 0;
    let cursor = since;
    let truncated = false;

    // The call cards already in this window, by call_key: a tool row whose card is
    // here is merged into it instead of being sent as a second message (round 7.1,
    // DEFECT-11 — see mergeResultIntoCall in common.js). A row holds calls or a
    // result, never both.
    const callIndex = new Map();
    const rememberCalls = (units) => {
      for (const u of units) {
        if (u && u.kind === 'tool_call' && u.tool && u.tool.call_key && !callIndex.has(u.tool.call_key)) {
          callIndex.set(u.tool.call_key, u);
        }
      }
    };

    let next = since;
    for (;;) {
      const batch = sel.all(sessionId, next, ROW_BATCH);
      if (!batch.length) break;
      let stopped = false;
      for (const row of batch) {
        const parsed = parseRow(row);
        const plan = planUnits(parsed.units, callIndex);
        const bucket = parsed.kind === 'content' ? planBucket(plan) : parsed.kind;
        if (!fits(messages, plan, limit, bytes)) {
          if (!messages.length && plan.emit.length) {
            // A single row too large for one reply: emit its first unit, count the
            // row, and leave the rest to the next call (the cursor is at this row,
            // so the remaining units are re-derived from it).
            const first = plan.emit[0];
            messages.push(first);
            bytes += Buffer.byteLength(JSON.stringify(first), 'utf8');
            records++;
            emittedRecords++;
            empty += parsed.suppressed;
            cursor = row.id;
            truncated = true;
          } else {
            truncated = true;
          }
          stopped = true;
          break;
        }
        for (const m of plan.emit) messages.push(m);
        bytes += plan.bytes;
        applyPlan(plan, callIndex);
        rememberCalls(plan.emit);
        records++;
        if (bucket === 'merged') merged++;
        else if (bucket === 'unknown') unknown++;
        else if (bucket === 'skipped') skipped++;
        else emittedRecords++;
        empty += parsed.suppressed;
        cursor = row.id;
        next = row.id;
      }
      if (stopped) break;
      if (batch.length < ROW_BATCH) break;
    }

    if (!truncated) {
      // Exact "is there more?": one cheap indexed count from the cursor on.
      const rest = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND id > ?').get(sessionId, cursor);
      if (rest && rest.n > 0) truncated = true;
    }
    const absorbed = absorbPairedResults(messages);
    if (absorbed) { merged += absorbed; emittedRecords -= absorbed; }
    // `!truncated` is exactly "nothing newer than this window exists in the store".
    markPendingReasons(messages, { working: !!(opts && opts.working), atLiveEnd: !truncated });
    return {
      messages, cursor, records, skipped, unknown, empty, merged, emittedRecords,
      truncated, tail: false,
    };
  } finally {
    try { db.close(); } catch (e) { /* already gone */ }
  }
}

/**
 * Round 7.1 (DEFECT-9) — the NEWEST rows, with the cursor at the session's highest
 * row id, so opening a long hermes session lands on the live turn.
 *
 * The rows are read newest-first (`ORDER BY id DESC`) and only a batch at a time,
 * so the newest page never loads the whole session. Rows are included whole —
 * the window never starts mid-row — and a row whose call card is inside the
 * window has its result merged into that card like everywhere else.
 *
 * `truncated` is true when rows older than the window exist (or when the caps cut
 * the walk short). The exact question is answered with one indexed EXISTS below.
 *
 * A tail window is a suffix, so it ends at the live end of the store whenever the
 * newest row was emitted (`cursor == MAX(id)`); a cap that cut the newest rows is
 * the one case where it does not, and `pending_reason` says so.
 */
function readTail(file, sessionId, limit, opts) {
  const db = openReadOnly(file);
  try {
    const max = limit == null ? LIMITS.LIMIT_DEFAULT : limit;
    const top = db.prepare('SELECT MAX(id) AS m FROM messages WHERE session_id = ?').get(sessionId);
    const base = {
      messages: [], cursor: 0, records: 0, skipped: 0, unknown: 0, empty: 0,
      merged: 0, emittedRecords: 0, truncated: false, tail: true,
    };
    if (!top || top.m == null) return base;

    const sel = db.prepare('SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?');
    const kept = [];                        // newest-first while walking, then reversed
    // The count is MESSAGES, the number `limit` means: a row whose result joins a
    // card inside the window emits one message, not two (see mergeCounts in
    // common.js). Pricing raw units instead made the tail open with ~60 % of the
    // messages it was asked for (round 7.1).
    const model = mergeCounts();
    let bytes = 0;
    let cut = false;
    let before = top.m + 1;                 // exclusive upper bound of the next batch
    for (;;) {
      const batch = sel.all(sessionId, before, ROW_BATCH);
      if (!batch.length) break;
      for (const row of batch) {
        const parsed = parseRow(row);
        const n = parsed.units.length;
        const b = Buffer.byteLength(JSON.stringify(parsed.units), 'utf8');
        // Priced on a trial basis: mergeDelta does not mutate, and rows are only
        // added to the model once the row is actually kept.
        const wouldEmit = emittedUnits(model) + n - mergeDelta(model, parsed.units);
        if (kept.length && (wouldEmit > max || bytes + b > LIMITS.RESPONSE_BYTES_MAX)) { cut = true; break; }
        kept.push({ row, parsed });
        addUnits(model, parsed.units);
        bytes += b;
        before = row.id;
      }
      if (cut) break;
      if (batch.length < ROW_BATCH) break;
      if (emittedUnits(model) >= max || bytes >= LIMITS.RESPONSE_BYTES_MAX) break;
    }
    kept.reverse();

    const messages = [];
    let records = 0;
    let skipped = 0;
    let unknown = 0;
    let empty = 0;
    let merged = 0;
    let emittedRecords = 0;
    let emittedBytes = 0;
    let truncated = cut;
    const callIndex = new Map();
    let lastEmitted = null;
    for (const { row, parsed } of kept) {
      const plan = planUnits(parsed.units, callIndex);
      // The newest row is always kept, so this only fires for a row larger than
      // the whole byte cap by itself; the reply still stops at the caps.
      if (emittedBytes + plan.bytes > LIMITS.RESPONSE_BYTES_MAX
        || (messages.length + plan.emit.length > max && messages.length)) {
        if (!messages.length && plan.emit.length) {
          messages.push(plan.emit[0]);
          emittedBytes += Buffer.byteLength(JSON.stringify(plan.emit[0]), 'utf8');
          records++;
          emittedRecords++;
          empty += parsed.suppressed;
          lastEmitted = row;
        }
        truncated = true;
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
      const bucket = parsed.kind === 'content' ? planBucket(plan) : parsed.kind;
      records++;
      if (bucket === 'merged') merged++;
      else if (bucket === 'unknown') unknown++;
      else if (bucket === 'skipped') skipped++;
      else emittedRecords++;
      empty += parsed.suppressed;
      emittedBytes += plan.bytes;
      lastEmitted = row;
    }
    const absorbed = absorbPairedResults(messages);
    if (absorbed) { merged += absorbed; emittedRecords -= absorbed; }

    if (!truncated && kept.length) {
      const older = db.prepare('SELECT 1 AS x FROM messages WHERE session_id = ? AND id < ? LIMIT 1').get(sessionId, kept[0].row.id);
      if (older) truncated = true;
    }
    markPendingReasons(messages, {
      working: !!(opts && opts.working),
      atLiveEnd: !!lastEmitted && lastEmitted.id === top.m,
    });
    return {
      messages,
      cursor: lastEmitted ? lastEmitted.id : 0,   // = MAX(id) for the session
      records, skipped, unknown, empty, merged, emittedRecords,
      truncated, tail: true,
    };
  } finally {
    try { db.close(); } catch (e) { /* already gone */ }
  }
}

module.exports = {
  SOURCE_KIND, dbPath, readOnlyUri, openReadOnly, parseToolCalls, parseRow, readWindow, readTail,
  recentSessions, sessionKnown,
};
