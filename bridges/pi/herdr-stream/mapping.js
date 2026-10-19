'use strict';

/**
 * herdr-stream (pi) — pure mapping helpers for CONTRACT.md §2/§3/§4.
 *
 * This module is deliberately plain CommonJS with no I/O, no timers and no module
 * state, so `test/pi-bridge.test.mjs` can `require()` it (and `index.ts` can import
 * it) without a TypeScript build. The stateful writer lives in `sink.js`.
 *
 * Everything here is best-effort and total: no input shape throws, unknown pi events
 * map to `null` (= "nothing to write"), and every string field stays bounded.
 */

const path = require('node:path');
const os = require('node:os');

const SAFE_RE = /[^A-Za-z0-9_.-]/g;
const SAFE_LEN = 80;                            // §2 safe() truncates to 80 chars
const MAX_PAYLOAD_BYTES = 16 * 1024;            // §2 args/result/partial/final_text cap
const MAX_LINE_BYTES = 64 * 1024;               // §2 one line <= 64 KiB
const TRUNCATION_MARK = '\u2026[truncated]';    // §2 "replacing the tail with …[truncated]"
const CONTROL_TURN_ID = 'control';              // §4 out-of-turn settings use this turn_id
const CONTROL_SUFFIX = '__control.ndjson';      // §4 `<session>__control.ndjson`
const TURN_SUFFIX = '.ndjson';                  // §2 `<session>__<turn>.ndjson`
const AGENT = 'pi';

/* ── §2 paths ──────────────────────────────────────────────────────────────── */

/**
 * §2 `safe(s)`: every character outside `[A-Za-z0-9_.-]` becomes `-`, then 80 chars.
 *
 * Two degenerate results are repaired, because `.` is inside that set: an empty name
 * (no file, please) and an all-dot name (`safe("..")` would otherwise be a parent
 * directory). Neither case can occur for real pane/session/turn ids.
 */
function safeSegment(value) {
  let s = String(value === undefined || value === null ? '' : value)
    .replace(SAFE_RE, '-')
    .slice(0, SAFE_LEN);
  if (!s.length) return '-';
  if (/^\.+$/.test(s)) s = s.replace(/\./g, '-');
  return s;
}

/** §2 `HD_STREAM_DIR`, else `%LOCALAPPDATA%\herdr-dash\streams`, else the homedir form. */
function resolveStreamRoot(env, homedir) {
  const e = env || process.env;
  const explicit = typeof e.HD_STREAM_DIR === 'string' ? e.HD_STREAM_DIR.trim() : '';
  if (explicit) return path.resolve(explicit);
  const local = typeof e.LOCALAPPDATA === 'string' ? e.LOCALAPPDATA.trim() : '';
  if (local) return path.join(local, 'herdr-dash', 'streams');
  return path.join(homedir || os.homedir(), '.herdr-dash', 'streams');
}

/** §2 per pane directory. */
function paneDirFor(root, paneId) {
  return path.join(root, safeSegment(paneId));
}

/** §2 `<root>/<safe(pane)>/<safe(session)>__<safe(turn)>.ndjson`. */
function turnFileName(sessionId, turnId) {
  return safeSegment(sessionId) + '__' + safeSegment(turnId) + TURN_SUFFIX;
}

/** §4 `<root>/<safe(pane)>/<safe(session)>__control.ndjson`. */
function controlFileName(sessionId) {
  return safeSegment(sessionId) + CONTROL_SUFFIX;
}

/**
 * §2 "no sink unless HERDR_ENV=1 and a pane id is present". The bridge asks this once
 * at construction; when it says no, nothing is ever created on disk.
 */
function sinkTarget(env) {
  const e = env || process.env;
  const flag = String(e.HERDR_ENV === undefined || e.HERDR_ENV === null ? '' : e.HERDR_ENV);
  if (flag !== '1') return { enabled: false, paneId: '', reason: 'HERDR_ENV is not "1"' };
  const pane = typeof e.HERDR_PANE_ID === 'string' ? e.HERDR_PANE_ID.trim() : '';
  if (!pane) return { enabled: false, paneId: '', reason: 'HERDR_PANE_ID is empty' };
  return { enabled: true, paneId: pane, reason: '' };
}

/* ── §2 bounding ───────────────────────────────────────────────────────────── */

/** Bounded text: strings pass through, everything else is stringified first. */
function toText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (value instanceof Error) return value.message || String(value);
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(value, (key, val) => {
      if (typeof val === 'bigint') return String(val);
      if (val instanceof Error) return val.message || String(val);
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[circular]';
        seen.add(val);
      }
      return val;
    });
    return json === undefined ? String(value) : json;
  } catch (err) {
    return String(value);
  }
}

/** Cut to `limit` UTF-8 bytes without splitting a character, then add the §2 marker. */
function truncateBytes(text, limit) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_PAYLOAD_BYTES;
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  const markBytes = Buffer.byteLength(TRUNCATION_MARK, 'utf8');
  const room = Math.max(0, max - markBytes);
  const head = buf.subarray(0, room).toString('utf8').replace(/\uFFFD+$/, '');
  return head + TRUNCATION_MARK;
}

/** §2 cap for `args`, `result`, `partial`, `final_text`. `undefined` means "omit". */
function boundText(value, limit) {
  if (value === undefined || value === null) return undefined;
  return truncateBytes(toText(value), limit);
}

/* ── §3/§4 envelope pieces ─────────────────────────────────────────────────── */

function str(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

function toInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return undefined;
}

/** §4 `turn_id = <session_id>:<turnIndex>:<Date.now()>`. */
function turnId(sessionId, turnIndex, at) {
  const idx = toInt(turnIndex);
  return str(sessionId) + ':' + (idx === undefined ? '0' : String(idx)) + ':' + String(at);
}

/** §4 lazy open (first event without a turn_start) keeps the same 3-field shape. */
function lazyTurnId(sessionId, at) {
  return str(sessionId) + ':lazy:' + String(at);
}

/** §4 `message_id = message.id when present, otherwise <turn_id>:m<counter>`. */
function syntheticMessageId(turn, counter) {
  return str(turn) + ':m' + String(counter);
}

function messageIdFor(message, turn, counter) {
  const id = message && typeof message.id === 'string' ? message.id.trim() : '';
  return id || syntheticMessageId(turn, counter);
}

/** Join the text blocks of a user/assistant message (never the reasoning blocks). */
function messageText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('');
}

function roleOf(message) {
  const role = message && typeof message.role === 'string' ? message.role : '';
  return role === 'assistant' || role === 'user' ? role : '';
}

/** §4 assistant `message_start` carries the model when the message knows it. */
function mapMessageStart(message, messageId) {
  const role = roleOf(message);
  if (!role) return null;
  const out = { type: 'message_start', message_id: messageId, role };
  const model = message && typeof message.model === 'string' ? message.model.trim() : '';
  if (role === 'assistant' && model) out.model = model;
  return out;
}

/** §4 `message_end` -> `message_end` with the authoritative text when available. */
function mapMessageEnd(message, messageId) {
  const role = roleOf(message);
  if (!role) return null;
  const text = boundText(messageText(message));
  const out = { type: 'message_end', message_id: messageId };
  if (text) out.text = text;
  return out;
}

/** §4 provider failure: the contract's `error` envelope (status-specific, not a delta). */
function mapMessageError(message, messageId) {
  const stopReason = message && message.stopReason;
  const errorMessage = message && typeof message.errorMessage === 'string' ? message.errorMessage.trim() : '';
  if (stopReason !== 'error' || !errorMessage) return null;
  const out = { type: 'error', message: truncateBytes(errorMessage, MAX_PAYLOAD_BYTES) };
  if (messageId) out.message_id = messageId;
  return out;
}

function contentAt(message, index) {
  if (!message || !Array.isArray(message.content)) return null;
  if (typeof index !== 'number' || index < 0) return null;
  const item = message.content[index];
  return item && typeof item === 'object' ? item : null;
}

/**
 * Resolve the `tool_call_id` of a streaming tool call. `toolcall_start/delta` carry no
 * id of their own, only the partial message, so the id is read from the partial content
 * at `contentIndex` and cached per message. The FIRST id seen for a content index wins
 * ("pinned"): a provider that withholds the id until `toolcall_end` would otherwise
 * rename the call mid-stream and the UI would show two cards for one call. A provider
 * that never exposes an id gets a stable per-message synthetic one.
 */
function toolCallIdFor(toolIds, contentIndex, id, messageId) {
  const key = typeof contentIndex === 'number' ? contentIndex : -1;
  const pinned = toolIds.get(key);
  if (pinned) return pinned;
  const known = typeof id === 'string' && id.trim() ? id.trim() : '';
  const value = known || str(messageId) + ':c' + String(key);
  toolIds.set(key, value);
  return value;
}

/**
 * §4 `message_update` -> the contract's delta/end events. `start`, `text_start`,
 * `thinking_start`, `done` and `error` have no envelope of their own: the stream is
 * described by the deltas plus `message_end`, so they map to `null`.
 */
function mapAssistantEvent(event, messageId, toolIds) {
  if (!event || typeof event !== 'object') return null;
  const type = event.type;
  const index = toInt(event.contentIndex);
  const ids = toolIds instanceof Map ? toolIds : new Map();
  switch (type) {
    case 'text_delta':
      return { type: 'text_delta', message_id: messageId, content_index: index, delta: str(event.delta) };
    case 'text_end':
      return { type: 'text_end', message_id: messageId, content_index: index, text: boundText(event.content) };
    case 'thinking_delta':
      return { type: 'reasoning_delta', message_id: messageId, content_index: index, delta: str(event.delta) };
    case 'thinking_end':
      return { type: 'reasoning_end', message_id: messageId, content_index: index, text: boundText(event.content) };
    case 'toolcall_start': {
      const call = contentAt(event.partial, index);
      return {
        type: 'tool_call_start',
        tool_call_id: toolCallIdFor(ids, index, call && call.id, messageId),
        tool: str(call && call.name),
        content_index: index,
      };
    }
    case 'toolcall_delta': {
      const call = contentAt(event.partial, index);
      return {
        type: 'tool_call_delta',
        tool_call_id: toolCallIdFor(ids, index, call && call.id, messageId),
        content_index: index,
        delta: str(event.delta),
      };
    }
    case 'toolcall_end': {
      const call = (event.toolCall && typeof event.toolCall === 'object')
        ? event.toolCall
        : (contentAt(event.partial, index) || {});
      return {
        type: 'tool_call_end',
        tool_call_id: toolCallIdFor(ids, index, call.id, messageId),
        content_index: index,
        tool: str(call.name),
        args: boundText(call.arguments),
      };
    }
    default:
      return null;
  }
}

/* ── §4 tool execution (execution, not argument generation) ────────────────── */

function mapToolStart(event) {
  if (!event || typeof event !== 'object') return null;
  const out = {
    type: 'tool_start',
    tool_call_id: str(event.toolCallId),
    tool: str(event.toolName),
    args: boundText(event.args),
  };
  const parent = str(event.parentToolCallId);
  if (parent) out.parent_tool_call_id = parent;
  return out;
}

function mapToolUpdate(event) {
  if (!event || typeof event !== 'object') return null;
  return {
    type: 'tool_update',
    tool_call_id: str(event.toolCallId),
    partial: boundText(event.partialResult),
  };
}

function mapToolEnd(event) {
  if (!event || typeof event !== 'object') return null;
  const out = {
    type: 'tool_end',
    tool_call_id: str(event.toolCallId),
    result: boundText(event.result),
    is_error: event.isError === true,
  };
  const duration = toInt(event.durationMs);
  if (duration !== undefined) out.duration_ms = duration;
  return out;
}

/* ── §4 settings / turn end ────────────────────────────────────────────────── */

/** §4 `model_select` -> `settings { model }`. `model.id` is the stable identifier. */
function mapSettingsModel(model) {
  if (!model || typeof model !== 'object') return { type: 'settings' };
  const id = str(model.id).trim() || str(model.name).trim();
  const out = { type: 'settings' };
  if (id) out.model = id;
  const level = str(model.thinkingLevel).trim();
  if (level) out.thinking_level = level;
  return out;
}

/** §4 `thinking_level_select` -> `settings { thinking_level }`. */
function mapSettingsThinking(level) {
  const value = str(level).trim();
  const out = { type: 'settings' };
  if (value) out.thinking_level = value;
  return out;
}

/**
 * §4 `agent_settled` -> `turn_end`. `aborted` wins; otherwise a run whose last
 * assistant message stopped on a provider error is reported as `error` rather than
 * `complete` (§3 allows all three statuses).
 */
function turnEndStatus(aborted, lastStopReason) {
  if (aborted === true) return 'aborted';
  if (lastStopReason === 'error') return 'error';
  return 'complete';
}

/** §4 `turn_start` -> `turn_start` (`turn_index` is optional in §3). */
function mapTurnStart(turnIndex) {
  const out = { type: 'turn_start' };
  const index = toInt(turnIndex);
  if (index !== undefined) out.turn_index = index;
  return out;
}

module.exports = {
  AGENT,
  SAFE_LEN,
  MAX_PAYLOAD_BYTES,
  MAX_LINE_BYTES,
  TRUNCATION_MARK,
  CONTROL_TURN_ID,
  CONTROL_SUFFIX,
  TURN_SUFFIX,
  safeSegment,
  resolveStreamRoot,
  paneDirFor,
  turnFileName,
  controlFileName,
  sinkTarget,
  toText,
  truncateBytes,
  boundText,
  str,
  toInt,
  turnId,
  lazyTurnId,
  syntheticMessageId,
  messageIdFor,
  messageText,
  roleOf,
  mapMessageStart,
  mapMessageEnd,
  mapMessageError,
  mapAssistantEvent,
  mapToolStart,
  mapToolUpdate,
  mapToolEnd,
  mapSettingsModel,
  mapSettingsThinking,
  turnEndStatus,
  mapTurnStart,
};
