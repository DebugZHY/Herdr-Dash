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
const fsp = require('node:fs/promises');
const os = require('node:os');
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
 * Every session the store knows, newest activity first — the dash's own session list, so
 * the picker can be built without making the pane print `/sessions` into its transcript.
 * @returns [{id, title, cwd, model, message_count, started_at, last_activity_at, ended_at, archived, pinned}]
 */
function listSessions(file, limit) {
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 60;
  let db;
  try {
    db = openReadOnly(file);
    try {
      return db.prepare(
        `SELECT id, title, cwd, model, message_count, started_at, last_activity_at, ended_at,
                archived, pinned, hidden
           FROM sessions
          ORDER BY COALESCE(last_activity_at, started_at) DESC
          LIMIT ?`,
      ).all(n).map((r) => ({
        id: r.id == null ? '' : String(r.id),
        title: r.title == null ? null : String(r.title),
        cwd: r.cwd == null ? null : String(r.cwd),
        model: r.model == null ? null : String(r.model),
        message_count: r.message_count == null ? null : Number(r.message_count),
        started_at: r.started_at == null ? null : Number(r.started_at),
        last_activity_at: r.last_activity_at == null ? null : Number(r.last_activity_at),
        ended_at: r.ended_at == null ? null : Number(r.ended_at),
        archived: r.archived == null ? 0 : Number(r.archived),
        pinned: r.pinned == null ? 0 : Number(r.pinned),
        hidden: r.hidden == null ? 0 : Number(r.hidden),
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

/**
 * Read one session's model/provider/reasoning settings without touching the pane.
 *
 * The TUI stores the frozen session policy in `sessions.model_config` (the same
 * JSON hermes' `config.get` reports); `sessions.model` is the model. A missing
 * row means "not known yet", never a reason to type a command. Never throws.
 *
 * @param {string} file state.db path
 * @param {string} sessionId hermes session id
 * @returns {{model: string|null, provider: string|null, reasoning: string|null}}
 */
function sessionSettings(file, sessionId) {
  const empty = { model: null, provider: null, reasoning: null };
  const id = String(sessionId == null ? '' : sessionId).trim();
  if (!id) return empty;
  let db;
  try {
    db = openReadOnly(file);
    const row = db.prepare('SELECT model, model_config FROM sessions WHERE id = ? LIMIT 1').get(id);
    if (!row) return empty;
    let cfg = {};
    try { cfg = row.model_config ? JSON.parse(String(row.model_config)) : {}; } catch (e) { cfg = {}; }
    const reasoning = cfg && cfg.reasoning_config && typeof cfg.reasoning_config === 'object'
      ? (cfg.reasoning_config.enabled === false ? 'none' : (cfg.reasoning_config.effort || null))
      : null;
    const provider = (cfg && (cfg.provider || (cfg.gateway_runtime && cfg.gateway_runtime.provider))) || null;
    const model = (cfg && cfg.model) || (row.model == null ? null : String(row.model));
    return {
      model: model ? String(model) : null,
      provider: provider ? String(provider) : null,
      reasoning: reasoning ? String(reasoning) : null,
    };
  } catch (e) {
    return empty;
  } finally {
    try { if (db) db.close(); } catch (e) { /* already gone */ }
  }
}

/**
 * One session's stored policy plus where the answer came from.
 *
 * `source` is `state.db` only when the row actually carried something: a missing row is
 * "nothing recorded yet", which lets a caller fall back to the pane footer and say so.
 * Never throws.
 *
 * @param {string} file state.db path
 * @param {string} sessionId hermes session id
 * @returns {{model: string|null, provider: string|null, reasoning: string|null,
 *            found: boolean, source: string, file: string}}
 */
function sessionPolicy(file, sessionId) {
  const values = sessionSettings(file, sessionId);
  const found = !!(values.model || values.provider || values.reasoning);
  return {
    model: values.model,
    provider: values.provider,
    reasoning: values.reasoning,
    found: found,
    source: found ? 'state.db' : 'none',
    file: String(file == null ? '' : file),
  };
}

/** `$HERMES_HOME/config.yaml`, or `~/.hermes/config.yaml`; `opts.file`/`opts.home` override. */
function configPath(opts) {
  const o = opts || {};
  if (o.file) return path.resolve(String(o.file));
  if (o.home) return path.join(path.resolve(String(o.home)), 'config.yaml');
  const home = process.env.HERMES_HOME;
  if (home && String(home).trim()) return path.join(path.resolve(String(home).trim()), 'config.yaml');
  return path.join(os.homedir(), '.hermes', 'config.yaml');
}

/**
 * The `custom_providers` block of hermes' config, read from disk with no pane I/O.
 *
 * Each entry is `{name, baseUrl, apiKey}`; `apiKey` is for the server's own model fetch
 * and must never be sent to a client. A provider that is not in this list is not a
 * provider this dashboard can enumerate or switch to — callers report that as an empty
 * list plus this note rather than inventing a row.
 *
 * @param {{file?: string, home?: string}} [opts]
 * @returns {Promise<{file: string, providers: Array<{name: string, baseUrl: string, apiKey: string|null}>,
 *                    source: string, note: string}>}
 */
async function configProviders(opts) {
  const file = configPath(opts);
  let text;
  try { text = await fsp.readFile(file, 'utf8'); }
  catch (e) { return { file, providers: [], source: file, note: 'no hermes config at ' + file }; }
  const lines = text.split(/\r?\n/);
  const out = [];
  let inBlock = false;
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock) {
      if (/^custom_providers:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (/^\S/.test(line)) break;                       // back at column 0: the block ended
    let m = /^\s*-\s+name:\s*(\S+)\s*$/.exec(line);
    if (m) { cur = { name: m[1], baseUrl: null, apiKey: null }; out.push(cur); continue; }
    if (!cur) continue;
    if ((m = /^\s+base_url:\s*(\S+)/.exec(line))) cur.baseUrl = m[1];
    else if ((m = /^\s+api_key:\s*(\S+)/.exec(line))) cur.apiKey = m[1];
  }
  const providers = out.filter((p) => p.name && p.baseUrl);
  return {
    file,
    providers,
    source: file,
    note: providers.length ? '' : 'config.yaml has no usable custom_providers entries',
  };
}

/* ── native steer / queue ────────────────────────────────────────────────────
 *
 * hermes already owns two slash commands, typed through the message channel
 * (`agent.prompt`) — not into the terminal, exactly like `/model`:
 *
 *   /steer <text>   inject the text right after the next tool call
 *   /queue <text>   run the text as the next turn
 *
 * The dashboard sends those two lines verbatim. There is no second protocol, no
 * extension, no write to state.db and no read of hermes' internals: the only
 * state kept here is an ECHO of what this server sent, so the tray can show what
 * it did. That echo is an acknowledgement of our own writes, never a listing of
 * hermes' queue — HERMES_ECHO_NOTE says so in the response.
 */

const HERMES_STEER_COMMAND = '/steer';
const HERMES_FOLLOWUP_COMMAND = '/queue';
const HERMES_ECHO_NOTE = 'commands sent from herdr-dash while the pane worked; Hermes keeps its own queue';
const ECHO_ITEMS_MAX = 100;                 // bounded like the pi tray (QUEUE_ITEMS_MAX)

/** The literal hermes command line: `/steer <text>` or `/queue <text>`. */
function steerCommand(text) {
  return HERMES_STEER_COMMAND + ' ' + (text === undefined || text === null ? '' : String(text));
}
function followupCommand(text) {
  return HERMES_FOLLOWUP_COMMAND + ' ' + (text === undefined || text === null ? '' : String(text));
}

/** An opaque echo-row id (no counter the UI may arithmetic on), same shape as pi's. */
function echoItemId(nowMs) {
  const at = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  let rnd = '';
  try {
    rnd = require('node:crypto').randomBytes(6).toString('hex');
  } catch (e) {
    rnd = Math.random().toString(36).slice(2, 14);
  }
  return 'h-' + at.toString(36) + '-' + rnd;
}

/**
 * The pure decision for `mode:"steer"|"followup"` on a hermes pane.
 *
 * `agent` and `status` are resolved by the route from the live agent list, so the
 * frozen codes (`unsupported_mode`, `bad_request`, `not_streaming`) are testable
 * without a herdr connection. A refusal means the route writes nothing.
 *
 * @param {{mode?: string, agent?: string|null, status?: string|null, text?: string}} input
 * @returns {{ok: true, kind: 'steer'|'followup', command: string}
 *          | {ok: false, http: 400|409, code: string, message: string}}
 */
function planHermesQueuePrompt(input) {
  const o = input || {};
  const mode = o.mode === undefined || o.mode === null ? '' : String(o.mode);
  if (mode !== 'steer' && mode !== 'followup') {
    return {
      ok: false, http: 400, code: 'bad_request',
      message: '"mode" must be "steer" or "followup" for a queued message (plain prompts omit it)',
    };
  }
  if (o.agent !== 'hermes') {
    return {
      ok: false, http: 400, code: 'unsupported_mode',
      message: '"mode":"' + mode + '" is hermes-only here (this pane is ' + (o.agent ? String(o.agent) : 'unknown') + ')',
    };
  }
  if (typeof o.text !== 'string' || !o.text.trim()) {
    return {
      ok: false, http: 400, code: 'bad_request',
      message: '"text" must contain at least one non-whitespace character',
    };
  }
  if (o.status !== 'working') {
    return {
      ok: false, http: 409, code: 'not_streaming',
      message: 'this hermes pane is not working',
    };
  }
  return {
    ok: true,
    kind: mode,
    command: mode === 'steer' ? steerCommand(o.text) : followupCommand(o.text),
  };
}

/* The echo store: pane id → the rows this process sent while the pane worked. In
   memory only; a dashboard restart forgets them, which is honest — they were
   never hermes' rows to begin with. */
const paneEcho = new Map();

function echoBucket(paneId) {
  return paneEcho.get(String(paneId == null ? '' : paneId)) || null;
}

/** Remember one ACCEPTED command, for the tray to echo back. Bounded, newest kept. */
function rememberEcho(paneId, item) {
  const id = String(paneId == null ? '' : paneId);
  const row = echoBucket(id) || { steering: [], followUp: [], updated_at: null };
  const kind = item && item.kind === 'followup' ? 'followup' : 'steer';
  const list = kind === 'steer' ? row.steering : row.followUp;
  list.push({
    id: String(item && item.id ? item.id : ''),
    kind,
    text: item && typeof item.text === 'string' ? item.text : '',
    at: item && Number.isFinite(item.at) ? item.at : Date.now(),
  });
  if (list.length > ECHO_ITEMS_MAX) list.splice(0, list.length - ECHO_ITEMS_MAX);
  row.updated_at = list[list.length - 1].at;
  paneEcho.set(id, row);
  return row;
}

/**
 * The tray rows for a hermes pane.
 *
 * `working` is the caller's live read of `agent_status`. When the pane is no longer
 * working its echo rows are DROPPED, so an idle pane never shows stale rows — the
 * commands were consumed (or never could be) and hermes' queue is not ours to show.
 *
 * @returns {{steering: Array<object>, followUp: Array<object>, updated_at: number|null}}
 */
function echoRows(paneId, working) {
  const id = String(paneId == null ? '' : paneId);
  if (!working) {
    paneEcho.delete(id);
    return { steering: [], followUp: [], updated_at: null };
  }
  const row = echoBucket(id);
  if (!row) return { steering: [], followUp: [], updated_at: null };
  return {
    steering: row.steering.slice(),
    followUp: row.followUp.slice(),
    updated_at: row.updated_at,
  };
}

/** Forget the rows from the pane's previous run when a new normal prompt starts. */
function clearEcho(paneId) {
  paneEcho.delete(String(paneId == null ? '' : paneId));
}

module.exports = {
  SOURCE_KIND, dbPath, readOnlyUri, openReadOnly, parseToolCalls, parseRow, readWindow, readTail,
  recentSessions, listSessions, sessionKnown, sessionSettings,
  sessionPolicy, configPath, configProviders,
  /* native steer/queue: the two command lines and the echo store */
  HERMES_STEER_COMMAND, HERMES_FOLLOWUP_COMMAND, HERMES_ECHO_NOTE, ECHO_ITEMS_MAX,
  steerCommand, followupCommand, echoItemId, planHermesQueuePrompt,
  rememberEcho, echoRows, clearEcho,
};
