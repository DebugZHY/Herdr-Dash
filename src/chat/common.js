'use strict';
/*
 * src/chat/common.js — the parts of the §8 chat view that both sources share
 * (owner: W1; CONTRACT-v2 §8.2's frozen message shape lives here).
 *
 * WHY THIS FILE EXISTS
 *
 *   claude and hermes keep their conversations in completely different stores —
 *   one appends JSONL records, the other commits rows to a sqlite database — but
 *   the page must not be able to tell the difference. So the shape is defined
 *   once, here, and both parsers build their messages through these helpers.
 *   Anything that decides what the client sees (caps, caps' flag names, the
 *   timestamp unit, the pairing rule) is in this file, not copied into two
 *   parsers that could drift.
 *
 * THE MESSAGE SHAPE (§8.2, frozen):
 *
 *   { key, ts, role, kind, text, tool, sidechain }
 *     key   stable and unique within a session; the parser's own coordinates
 *           (`<uuid>:<i>` for claude, `<rowid>:<i>` for hermes) so a message can
 *           always be traced back to the record it came from
 *     ts    epoch milliseconds
 *     role  "user" | "assistant" | "tool"
 *     kind  "text" | "thinking" | "tool_call" | "tool_result" | "system" | "unknown"
 *     text  the message's own text, verbatim from the source (never rewritten)
 *     tool  null, or { name, call_key, input, input_truncated, result,
 *                      result_truncated, is_error, pending }
 *     sidechain  true when the source marks the record as a sidechain
 *
 *   Additions to that list, each deliberate and reported to the contract owner:
 *     - `text_truncated` on every message (§8.2 writes the cap as `*_truncated`,
 *       and a text/thinking message is the one message kind that has a `text`
 *       field to clamp but no tool object to hang the flag on);
 *     - `tool` is always present (null when the kind has no tool), so a renderer
 *       can read `msg.tool` without guarding for the key's absence.
 *
 * ACCOUNTING (the round-7.1 restatement of §8.4's counting rule)
 *
 *   Every source record lands in exactly one bucket, and the counters say which:
 *
 *     records == messages-emitted-records + merged_records + skipped + unknown_records
 *
 *   with two documented corrections, both reported:
 *     - a record can emit MORE THAN ONE message (a claude record holding several
 *       content blocks, a hermes row holding content + reasoning + N tool calls),
 *       so `messages` counts units and the surplus is `extra_units`;
 *     - a result whose call card is in the same reply is MERGED into that card
 *       (round 7.1, DEFECT-11: it is not also emitted as its own message), so its
 *       record counts in `merged_records` and contributes no message.
 *
 *   The exact identity over a window is therefore
 *
 *     records == messages + skipped + unknown_records + merged_records − extra_units
 *
 *   `empty_records` counts the blank (empty or whitespace-only) text/thinking
 *   VALUES that were dropped so the stream carries no blank rows (DEFECT-10).
 *   It is an accounting counter, not a third bucket: the record that carried the
 *   blank value is still counted in `skipped` (it produced nothing) or in
 *   `records_with_messages` (it produced other units — a hermes row with blank
 *   content and two tool calls is a normal record), and an absent value is not a
 *   dropped row, so it is not counted. The bound that always holds is
 *
 *     empty_records <= records_with_messages + skipped
 */

// ── limits (§8.2) ───────────────────────────────────────────────────────────
const LIMITS = {
  /** §8.2: per-message text cap, in characters. Applies to text, thinking,
   *  a tool's input JSON and a tool's result — every field the client renders. */
  TEXT_MAX: 20000,
  /** §8.2: overall response byte cap. Checked as messages are added; the reply
   *  that crosses it is not included and `truncated` says so. */
  RESPONSE_BYTES_MAX: 1024 * 1024,
  /** `limit` (messages per reply): default and hard cap. §8.3 renders 200 at a
   *  time and pages with the cursor, so the default only matters for a client
   *  that does not pass one. */
  LIMIT_DEFAULT: 400,
  LIMIT_MAX: 2000,
  /** The most source bytes one call will scan before answering `truncated`.
   *  A claude jsonl can be tens of MB (the live session here is 34 MB); the
   *  cursor is a byte offset precisely so this can be paged. */
  WINDOW_BYTES_MAX: 16 * 1024 * 1024,
  /** How far findCwd() will read looking for the record that carries `cwd`. */
  CWD_SEARCH_BYTES_MAX: 4 * 1024 * 1024,
};

const ROLES = new Set(['user', 'assistant', 'tool']);

/**
 * Clamp one rendered string to the per-message cap. `truncated` is returned
 * rather than inferred by the caller: the caller must be able to tell "the text
 * was already short enough" from "we cut it", and the flag has to reach the
 * client either way.
 *
 * The returned text is always a PREFIX of the input — §8.2's "verbatim substring
 * of the source record" — never an elision with a marker spliced in. The marker
 * is the client's business; inventing text here would be the one thing the
 * contract forbids.
 */
function clampText(value, max) {
  const s = value == null ? '' : String(value);
  const cap = max == null ? LIMITS.TEXT_MAX : max;
  if (s.length <= cap) return { text: s, truncated: false };
  return { text: s.slice(0, cap), truncated: true };
}

/**
 * Timestamps: claude writes ISO-8601 strings ("2026-09-24T03:53:11.528Z"),
 * hermes writes unix SECONDS as a REAL (1790160778.563366). Both become epoch
 * milliseconds; anything unreadable becomes null rather than 0 — a message with
 * no usable timestamp must not claim to be from 1970.
 */
function toMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Anything this large is already milliseconds (year 33658 in seconds).
    return Math.round(value > 1e11 ? value : value * 1000);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return toMs(Number(s));
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Round 7.1 / DEFECT-10: is this a blank value that has to be dropped (and
 * counted) rather than rendered as an empty row?
 *
 *   "blank" means the field was WRITTEN and holds nothing visible — "" or "   ".
 *   An absent field (null/undefined) is not a dropped row: there was no text to
 *   show in the first place, so counting it would inflate the number that says
 *   how many blank rows this reader avoided.
 */
function isBlankValue(value) {
  return value != null && String(value).trim() === '';
}

/** A numeric query parameter, or `fallback`. Rejects anything that is not a
 *  non-negative integer so a typo cannot silently mean "from the beginning". */
function parseCount(raw, fallback, max) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw))) {
    throw { code: 'bad_request', message: `not a non-negative integer: ${JSON.stringify(raw)}` };
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw { code: 'bad_request', message: `not a number: ${JSON.stringify(raw)}` };
  return max == null ? n : Math.min(n, max);
}

/**
 * §8.2 pairing: a `tool_use` and its `tool_result` are joined by id.
 *
 * Round 7.1 (DEFECT-11) tightened this. The result is attached to the CALL
 * message — that is what makes `pending` and `is_error` mean something for a card
 * the user is looking at — and the result's own message is then DROPPED, because
 * the card already carries the same text. Sending both was measured at roughly
 * double the payload for tool-heavy sessions (one 681 KB page of a hermes
 * session), so `kind:"tool_result"` messages now exist only for results with no
 * matching call — the "unpaired" case the renderer already draws differently.
 *
 * A call whose result is not in this reply stays `pending: true`. That is the
 * honest answer for a windowed read; the result normally arrives in the NEXT
 * window, and the client folds it into the card by `call_key`.
 */
function mergeResultIntoCall(call, res) {
  if (!call || !call.tool || !res || !res.tool) return false;
  call.tool.name = call.tool.name || res.tool.name || null;   // the result knows the name too
  res.tool.name = res.tool.name || call.tool.name || null;
  call.tool.result = res.tool.result;
  call.tool.result_truncated = res.tool.result_truncated;
  call.tool.is_error = res.tool.is_error;
  call.tool.pending = false;
  return true;
}

/**
 * Fold every tool_result message whose call is ALSO in `messages` into that
 * call, and return how many were folded away.
 *
 * The parsers merge inline as they read (so the byte budget prices exactly what
 * the reply will carry — see planUnits), which leaves one ordering for this pass
 * to catch: a result that appears BEFORE its call. claude writes the call block
 * first and hermes writes the result on a later row, so neither store does that
 * in practice; the pass exists so an unusual log cannot produce a duplicated
 * result. It is also the one definition of the merge rule.
 */
function absorbPairedResults(messages) {
  const calls = new Map();
  for (const m of messages) {
    if (m && m.kind === 'tool_call' && m.tool && m.tool.call_key && !calls.has(m.tool.call_key)) {
      calls.set(m.tool.call_key, m);
    }
  }
  let merged = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.kind !== 'tool_result' || !m.tool || !m.tool.call_key) continue;
    const call = calls.get(m.tool.call_key);
    if (!call) continue;                       // unpaired: it stays a message of its own
    mergeResultIntoCall(call, m);
    messages.splice(i, 1);
    merged++;
  }
  return merged;
}

/**
 * How many MESSAGES a set of units will emit once the pairs in it are joined —
 * the number both tail readers must budget, because a window is counted in
 * messages and a joined result is not one (round 7.1).
 *
 * The rule is planUnits/absorbPairedResults': a tool_result unit collapses when a
 * card carrying its call_key is in the SAME window, wherever in that window the
 * card sits (both of those functions look the card up in a set, so the pair is
 * order-independent). So the count is
 *
 *     emitted = units - Σ over kept cards of (result units under that call_key)
 *
 * which is exact, and the tail needs it BEFORE it builds anything: the window is
 * chosen walking backwards, and pricing the chosen rows in raw units made a tail
 * open with ~60 % of the messages it was asked for (limit=200 on the brief's
 * w6:p4 answered with 123, because the 77 joined results were all charged as if
 * they were messages of their own).
 *
 * These are plain counters over a kept window: addUnits is order-independent, so
 * the backward walk may feed them in any order.
 */
function mergeCounts() {
  return { cards: new Set(), results: new Map(), units: 0, merged: 0 };
}

/** How many of `units` would collapse if they joined `model` — no mutation, so a
 *  caller can price a candidate row before deciding to keep it. */
function mergeDelta(model, units) {
  let delta = 0;
  for (const u of units) {
    if (!u || !u.tool || !u.tool.call_key) continue;
    const k = u.tool.call_key;
    if (u.kind === 'tool_result') {
      if (model.cards.has(k)) delta++;
    } else if (u.kind === 'tool_call' && !model.cards.has(k)) {
      delta += model.results.get(k) || 0;      // this card takes its results with it
    }
  }
  return delta;
}

/** Add a record's units to the model. Returns the model. */
function addUnits(model, units) {
  model.merged += mergeDelta(model, units);
  for (const u of units) {
    model.units++;
    if (!u || !u.tool || !u.tool.call_key) continue;
    const k = u.tool.call_key;
    if (u.kind === 'tool_result') model.results.set(k, (model.results.get(k) || 0) + 1);
    else if (u.kind === 'tool_call' && !model.cards.has(k)) model.cards.add(k);
  }
  return model;
}

/** The messages `model` would emit. */
function emittedUnits(model) {
  return model.units - model.merged;
}

/** Bytes a join adds beyond the payload copy: the name/flag fields it fills and
 *  the JSON punctuation around them. A small constant, never a guess at text. */
const PAIR_SLACK = 128;

/**
 * Decide — WITHOUT changing anything — what a record's units will cost the
 * reply: which units become messages of their own, which are merged into a call
 * already in this reply, and the total bytes all of that adds.
 *
 * §8.2's byte cap is a cap on the reply the client receives. A merged result is
 * not a message, but its text still travels inside the card, so it is charged the
 * copy (+ PAIR_SLACK) — charging it a whole message would be an over-estimate
 * (that message's JSON is the same text plus keys), which is the safe direction.
 *
 * How far the charge could under-count: a call whose result is merged here also
 * gains the result's NAME if the call had none, and PAIR_SLACK covers that. That
 * is why nothing is charged when the copy is not made — a call whose result is
 * outside this reply costs a few bytes at most, never a copy.
 *
 * The measurement must not mutate: on overflow the record is left for the next
 * call, and a merge applied here would double a result that this reply will not
 * carry as its own message.
 *
 * @param callKeys Set/Map of call_key values already in this reply
 */
function planUnits(units, callKeys) {
  const emit = [];
  const merge = [];
  let bytes = 0;
  for (const u of units) {
    if (u && u.kind === 'tool_result' && u.tool && u.tool.call_key && callKeys && callKeys.has(u.tool.call_key)) {
      merge.push(u);
      bytes += Buffer.byteLength(u.tool.result || '', 'utf8') + PAIR_SLACK;
    } else {
      emit.push(u);
      bytes += Buffer.byteLength(JSON.stringify(u), 'utf8');
    }
  }
  return { emit, merge, bytes };
}

/** Apply what a plan measured: fold the merged units into their call cards. */
function applyPlan(plan, callIndex) {
  for (const u of plan.merge) mergeResultIntoCall(callIndex.get(u.tool.call_key), u);
}

/**
 * Which bucket a record lands in, given its plan (§8.4's counting rule, restated
 * in this file's header). A record whose every unit travelled inside a card is
 * `merged_records`; a record that produced no unit at all is `skipped`.
 */
function planBucket(plan) {
  if (plan.emit.length) return 'message';
  if (plan.merge.length) return 'merged';
  return 'skipped';
}

/** Build one message with the frozen key set, in a fixed order (so the same
 *  cursor twice serialises to the same bytes — §8.2's idempotence). */
function message(fields) {  const role = ROLES.has(fields.role) ? fields.role : 'tool';
  const t = fields.tool || null;
  return {
    key: String(fields.key),
    ts: fields.ts == null ? null : fields.ts,
    role,
    kind: fields.kind,
    text: fields.text == null ? '' : String(fields.text),
    text_truncated: !!fields.text_truncated,
    tool: t && {
      name: t.name == null ? null : String(t.name),
      call_key: t.call_key == null ? null : String(t.call_key),
      input: t.input == null ? null : String(t.input),
      input_truncated: !!t.input_truncated,
      result: t.result == null ? null : String(t.result),
      result_truncated: !!t.result_truncated,
      is_error: !!t.is_error,
      pending: !!t.pending,
      // Round 7.3 — WHY a card is pending, never only THAT it is (see
      // markPendingReasons). null whenever `pending` is false.
      pending_reason: t.pending_reason == null ? null : String(t.pending_reason),
    },
    sidechain: !!fields.sidechain,
  };
}

/**
 * Apply §8.2's response-level caps to an ordered message list.
 *
 * `truncated` is true when anything was held back — the message count, the byte
 * cap, or the caller's own window — because the client's only question is "is
 * there more?". `kept` is what to emit; `emitted` is how many of the input
 * messages were kept, which is what the caller needs to place the cursor after
 * the last COMPLETE record it reported.
 */
function capMessages(messages, limit) {
  const max = limit == null ? LIMITS.LIMIT_DEFAULT : limit;
  const kept = [];
  let bytes = 0;
  let truncated = messages.length > max;
  const n = Math.min(messages.length, max);
  for (let i = 0; i < n; i++) {
    const size = Buffer.byteLength(JSON.stringify(messages[i]), 'utf8');
    if (bytes + size > LIMITS.RESPONSE_BYTES_MAX) {
      truncated = true;
      break;
    }
    bytes += size;
    kept.push(messages[i]);
  }
  return { messages: kept, emitted: kept.length, truncated };
}

/**
 * Round 7.3 — stamp `pending_reason` on every card that is still waiting.
 *
 * `pending: true` keeps its §8.2 meaning, exactly: this reply carries no result
 * for that call. What it never said is WHY, and the two states a client watches
 * are not the same thing:
 *
 *   'awaiting'       the call may yet be answered — this window reaches the live
 *                    end of the store, the pane's agent is working right now, and
 *                    no user record follows the card here, so the card belongs to
 *                    the turn being generated.
 *   'not_in_window'  the reply simply does not contain the result: an older call
 *                    whose result lies elsewhere (a truncated page, a window that
 *                    has moved past it), or a live-end window on a pane that is
 *                    not working. Nothing is coming to THIS reply.
 *   'duplicate_id'   the log repeats this call id and another card in this same
 *                    reply already took the result row — the result is inside the
 *                    window, attached to the twin card. Measured on the live
 *                    hermes store: 141 call ids are repeated, and every pending
 *                    card in a 297-message w4:p1 tail was of this kind (round
 *                    7.3's finding — see the round's report).
 *
 * The caller supplies what the log cannot: `opts.working` (the pane's agent is
 * generating) and `opts.atLiveEnd` (nothing newer than this window exists in the
 * store) — both must be true, and strictly, for 'awaiting'. Everything else is
 * read off the reply: the cards, their ids, the last user record, and the call
 * ids whose result it carries (a card with a result, or a standalone tool_result,
 * is the proof that the row was inside the window).
 *
 * Never invents a result; only labels the absence. Mutates and returns `messages`.
 */
function markPendingReasons(messages, opts) {
  const o = opts || {};
  const working = o.working === true;
  const atLiveEnd = o.atLiveEnd === true;

  // The call ids whose result THIS reply carries.
  const resultKeys = new Set();
  for (const m of messages) {
    if (m && m.tool && m.tool.call_key != null && !m.tool.pending) resultKeys.add(String(m.tool.call_key));
  }

  // Cards per call id within THIS reply: two cards sharing one id cannot both be
  // the merge target — the merge rule is first-wins, so the later twin waits.
  const cards = new Map();
  for (const m of messages) {
    if (m && m.kind === 'tool_call' && m.tool && m.tool.call_key != null) {
      const k = String(m.tool.call_key);
      cards.set(k, (cards.get(k) || 0) + 1);
    }
  }

  // The window's last user record: everything after it is the generating turn.
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') { lastUser = i; break; }
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !m.tool) continue;
    if (!m.tool.pending) { m.tool.pending_reason = null; continue; }
    const k = m.tool.call_key == null ? null : String(m.tool.call_key);
    if (k != null && (cards.get(k) || 0) > 1 && resultKeys.has(k)) {
      m.tool.pending_reason = 'duplicate_id';
    } else if (atLiveEnd && working && i > lastUser) {
      m.tool.pending_reason = 'awaiting';
    } else {
      m.tool.pending_reason = 'not_in_window';
    }
  }
  return messages;
}

module.exports = {
  LIMITS, ROLES, clampText, toMs, parseCount, message, capMessages, isBlankValue,
  mergeResultIntoCall, absorbPairedResults, planUnits, applyPlan, planBucket, PAIR_SLACK,
  mergeCounts, mergeDelta, addUnits, emittedUnits, markPendingReasons,
};
