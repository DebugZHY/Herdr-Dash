'use strict';

/**
 * herdr-stream (pi) — the async sink writer and the pi event bridge.
 *
 * CONTRACT.md §2/§3/§4. Plain CommonJS on purpose: `test/pi-bridge.test.mjs` can
 * `require()` it (no TypeScript build), and `index.ts` default-imports it.
 *
 * Rules this file exists to keep:
 *   - no synchronous disk I/O ever, and certainly not on the token path: every write
 *     goes through one FIFO of ops drained by a single async loop;
 *   - never throw into pi: every public method is total and swallows its own errors;
 *   - one turn file per agent run, opened by `turn_start` (or lazily by the first
 *     event) and closed by `agent_settled`;
 *   - `seq` monotonically increases for the life of the process and is never reused.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const mapping = require('./mapping.js');

const VERSION = 1;
const BRIDGE_ID = 'herdr-stream';
const BRIDGE_PROTOCOL = 2;               // control commands + bridge-visible queue
const AGENT = mapping.AGENT;
const QUEUE_MAX = 20000;                 // §2 "a full queue drops the event"
const QUEUE_ITEMS_MAX = 20;              // QUEUE-CONTRACT §C: one bounded list per kind
const QUEUE_TEXT_MAX = 1024;            // QUEUE-CONTRACT §C: one bounded item text
const KEEP_TURN_FILES = 20;              // §2 keep the newest 20 turn files per pane
const MAX_AGE_MS = 2 * 60 * 60 * 1000;   // §2 delete files older than 2 hours
const LOG_MIN_INTERVAL_MS = 1000;        // one log line per failure kind per second
const FLUSH_TIMEOUT_MS = 500;

function noop() {}

/**
 * The writer. One per extension instance (one pi process).
 *
 * Options (all optional; the tests and the manager's dry run use the env ones):
 *   env        — the environment used for §2 root/§4 gating (default: process.env)
 *   homedir    — homedir for the last-resort root
 *   now        — clock, ms (tests)
 *   seqStart   — first seq value (tests)
 *   keepFiles / maxAgeMs / maxQueue / logIntervalMs — §2 bounds (tests)
 */
function createWriter(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const target = mapping.sinkTarget(env);
  const enabled = target.enabled;
  const paneId = target.paneId;
  const root = mapping.resolveStreamRoot(env, o.homedir);
  const paneDir = mapping.paneDirFor(root, paneId || 'unknown');
  const logPath = path.resolve(root, '..', 'stream.log');
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const keepFiles = Number.isFinite(o.keepFiles) ? o.keepFiles : KEEP_TURN_FILES;
  const maxAgeMs = Number.isFinite(o.maxAgeMs) ? o.maxAgeMs : MAX_AGE_MS;
  const maxQueue = Number.isFinite(o.maxQueue) ? o.maxQueue : QUEUE_MAX;
  const logIntervalMs = Number.isFinite(o.logIntervalMs) ? o.logIntervalMs : LOG_MIN_INTERVAL_MS;

  let seq = Number.isFinite(o.seqStart) ? Math.floor(o.seqStart) : 0;
  let lastSeq = seq;
  let sessionId = '';
  let turn = null;                       // { id, sessionId, file, index }
  let toolIds = new Map();               // contentIndex -> emitted tool_call_id, per message
  let toolAlias = new Map();             // real tool_call_id -> emitted tool_call_id
  let pending = { assistant: '', user: '' };
  let messageCounter = 0;
  let lastStopReason = '';
  /* QUEUE-CONTRACT §C: the BRIDGE-VISIBLE queue — only messages accepted by
     /herdr-steer and /herdr-followup in this process. pi's own TUI queue is not read
     and not claimed; an item leaves when its user message starts, or on a clear. */
  const queueState = { steering: [], followUp: [] };
  let cleaning = false;
  let cleanupPromise = Promise.resolve();

  const queue = [];                      // FIFO of { kind, ... }
  let draining = false;
  let idleWaiters = [];
  let handle = null;
  let handlePath = '';
  let written = 0;
  let dropped = 0;
  let failures = 0;
  const logTimes = new Map();

  /* ── the queue ───────────────────────────────────────────────────────────── */

  function push(op, critical) {
    if (!enabled) return false;
    if (!critical && queue.length >= maxQueue) {
      dropped += 1;
      logOnce('queue-full', 'write queue full; dropped ' + op.kind + ' op');
      return false;
    }
    queue.push(op);
    kick();
    return true;
  }

  function kick() {
    if (draining || !queue.length) return;
    draining = true;
    void Promise.resolve().then(drain);
  }

  async function drain() {
    try {
      while (queue.length) {
        const op = queue.shift();
        try {
          await exec(op);
        } catch (err) {
          failures += 1;
          if (op.kind === 'line' && handlePath && handle) {
            // a broken handle must not poison the rest of the turn: fall back to
            // a fresh append for the next line.
            const dead = handle;
            handle = null;
            handlePath = '';
            try { await dead.close(); } catch (e) { /* already gone */ }
          }
          logOnce('exec-' + op.kind, op.kind + ' failed: ' + describe(err));
        }
      }
    } finally {
      draining = false;
      if (queue.length) kick();
      else settleIdle();
    }
  }

  async function exec(op) {
    if (op.kind === 'log') {
      await fsp.mkdir(path.dirname(logPath), { recursive: true });
      await fsp.appendFile(logPath, op.line, 'utf8');
      return;
    }
    if (op.kind === 'open') {
      if (handle && handlePath === op.file) return;
      if (handle) await closeHandle();
      await fsp.mkdir(path.dirname(op.file), { recursive: true });
      handle = await fsp.open(op.file, 'a');
      handlePath = op.file;
      return;
    }
    if (op.kind === 'close') {
      await closeHandle();
      return;
    }
    if (op.kind === 'line') {
      if (handle && handlePath === op.file) {
        await handle.write(op.line);
        return;
      }
      // a settings line for the control file, or a turn file whose handle is gone
      await fsp.mkdir(path.dirname(op.file), { recursive: true });
      await fsp.appendFile(op.file, op.line, 'utf8');
      return;
    }
  }

  async function closeHandle() {
    const h = handle;
    handle = null;
    handlePath = '';
    if (!h) return;
    try { await h.close(); } catch (err) { /* already closed */ }
  }

  function settleIdle() {
    if (!idleWaiters.length) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const fn of waiters) {
      try { fn(); } catch (err) { /* a waiter must not break the drain */ }
    }
  }

  /** Resolves once the write queue is empty and no write is in flight. */
  function drained() {
    if (!draining && queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => { idleWaiters.push(resolve); });
  }

  function describe(err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    return err.message || String(err);
  }

  /** §4: best-effort diagnostics, rate-limited per kind, never on the token path. */
  function logOnce(key, message) {
    if (!enabled) return;
    const at = now();
    const prev = logTimes.get(key);
    if (prev !== undefined && at - prev < logIntervalMs && at >= prev) return;
    logTimes.set(key, at);
    push({ kind: 'log', line: new Date(at).toISOString() + ' pi-herdr-stream: ' + message + '\n' }, true);
  }

  /* ── §2 cleanup on turn start ────────────────────────────────────────────── */

  /** Runs beside the queue (never delays the first delta) and never deletes the open file. */
  async function cleanup() {
    if (!enabled || cleaning) return;
    cleaning = true;
    try {
      const names = await fsp.readdir(paneDir);
      const candidates = [];
      let openListed = !turn;
      for (const name of names) {
        if (!name.endsWith(mapping.TURN_SUFFIX)) continue;
        if (name.endsWith(mapping.CONTROL_SUFFIX)) continue;   // §4 control files are not turns
        const file = path.join(paneDir, name);
        if (turn && file === turn.file) openListed = true;
        candidates.push(file);
      }
      const stats = await Promise.all(candidates.map(async (file) => {
        try {
          const st = await fsp.stat(file);
          return st.isFile() ? { file, mtimeMs: st.mtimeMs || 0 } : null;
        } catch (err) {
          return null;                                          // vanished meanwhile
        }
      }));
      const files = stats.filter(Boolean);
      // The turn file that just opened is the newest of the 20 we keep, even when its
      // `open` op has not landed yet (cleanup runs beside the queue, not in it).
      if (!openListed) files.push({ file: turn.file, mtimeMs: now() });
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const at = now();
      const doomed = [];
      for (let i = 0; i < files.length; i += 1) {
        const item = files[i];
        const tooOld = maxAgeMs > 0 && at - item.mtimeMs > maxAgeMs;
        if (i < keepFiles && !tooOld) continue;
        if (turn && item.file === turn.file) continue;           // §2 never delete the open file
        doomed.push(item.file);
      }
      await Promise.all(doomed.map(async (file) => {
        try { await fsp.unlink(file); } catch (err) { /* someone else won */ }
      }));
    } catch (err) {
      // The pane directory only exists once the first turn file is created, so a
      // missing directory is the normal first-turn case, not a failure worth logging.
      if (!err || err.code !== 'ENOENT') logOnce('cleanup', 'cleanup failed: ' + describe(err));
    } finally {
      cleaning = false;
    }
  }

  /* ── §3 envelope ─────────────────────────────────────────────────────────── */

  function nextSeq() {
    seq += 1;
    if (seq <= lastSeq) seq = lastSeq + 1;   // invariant: a seq is emitted at most once
    lastSeq = seq;
    return seq;
  }

  function envelope(partial, turnIdValue) {
    if (!enabled) return null;
    const out = {
      v: VERSION,
      bridge: BRIDGE_ID,
      protocol: BRIDGE_PROTOCOL,
      seq: nextSeq(),
      ts: now(),
      agent: AGENT,
      pane_id: paneId,
      session_id: sessionId,
      turn_id: turnIdValue,
    };
    for (const key of Object.keys(partial)) {
      const value = partial[key];
      if (value === undefined || value === null) continue;
      out[key] = value;
    }
    return out;
  }

  function enqueueEnvelope(partial, file, turnIdValue) {
    if (!enabled || !file) return null;
    const envl = envelope(partial, turnIdValue);
    if (!envl) return null;
    const line = JSON.stringify(envl) + '\n';
    if (Buffer.byteLength(line, 'utf8') > mapping.MAX_LINE_BYTES) {
      dropped += 1;
      logOnce('line-too-long', 'dropped ' + String(envl.type) + ' over ' + String(mapping.MAX_LINE_BYTES) + ' bytes');
      return null;
    }
    if (!push({ kind: 'line', file, line })) return null;   // queue full: already counted as dropped
    written += 1;
    return envl;
  }

  function writeTurn(partial) {
    if (!turn) return null;
    return enqueueEnvelope(partial, turn.file, turn.id);
  }

  /* ── QUEUE-CONTRACT §C: the bridge-visible queue ─────────────────────────── */

  /** §C: queue envelopes ALWAYS use `<session>__control.ndjson`, even with a turn open. */
  function queueFile() {
    return path.join(paneDir, mapping.controlFileName(sessionId));
  }

  function queueList(kind) {
    return kind === 'steer' ? queueState.steering : queueState.followUp;
  }

  function queueItemCopy(item) {
    return { id: item.id, kind: item.kind, text: item.text, at: item.at };
  }

  /**
   * §C.4: one envelope per change, with the same async writer queue as the token path.
   * Bounded: at most QUEUE_ITEMS_MAX items per list and QUEUE_TEXT_MAX bytes per item, so
   * an envelope can never approach MAX_LINE_BYTES.
   */
  function writeQueue(reason) {
    if (!enabled) return null;
    return enqueueEnvelope({
      type: 'queue',
      session_id: sessionId,
      steering: queueState.steering.map(queueItemCopy),
      followUp: queueState.followUp.map(queueItemCopy),
      updated_at: now(),
      reason: reason === undefined || reason === null ? '' : String(reason),
    }, queueFile(), mapping.CONTROL_TURN_ID);
  }

  /** §C.2 delivery signal: trim-normalized text equality (a truncated item matches its head). */
  function sameQueueText(itemText, messageText) {
    const a = mapping.str(itemText).trim();
    const b = mapping.str(messageText).trim();
    if (!a || !b) return false;
    if (a === b) return true;
    if (!a.endsWith(mapping.TRUNCATION_MARK)) return false;
    const head = a.slice(0, a.length - mapping.TRUNCATION_MARK.length);
    return !!head && b.startsWith(head);
  }

  /** §C.1: record an item the extension accepted (never invents one, never throws). */
  function queueAdd(entry) {
    if (!enabled) return null;
    const e = entry || {};
    const kind = e.kind === 'steer' ? 'steer' : (e.kind === 'followup' ? 'followup' : '');
    const text = mapping.str(e.text);
    if (!kind || !text.trim()) return null;
    const list = queueList(kind);
    list.push({
      id: e.id === undefined || e.id === null ? '' : mapping.str(e.id),
      kind,
      text: mapping.boundText(text, QUEUE_TEXT_MAX) || '',
      at: now(),
    });
    if (list.length > QUEUE_ITEMS_MAX) list.splice(0, list.length - QUEUE_ITEMS_MAX);
    return writeQueue(kind);
  }

  /** §C.2: a user message that starts is delivered, so its item leaves the tray. */
  function queueRemoveText(messageText) {
    if (!enabled) return null;
    const text = mapping.str(messageText);
    if (!text.trim()) return null;
    for (const kind of ['steer', 'followup']) {
      const list = queueList(kind);
      for (let i = 0; i < list.length; i += 1) {
        if (!sameQueueText(list[i].text, text)) continue;
        list.splice(i, 1);
        return writeQueue('delivered');
      }
    }
    return null;
  }

  /**
   * §C.3/§C.4: `agent_settled`, `session_start`, `session_shutdown` empty both lists and
   * write a fresh envelope after the clear. `force` writes that empty envelope even when the
   * lists were already empty (a session boundary); without it an event that changed nothing
   * writes nothing, so a repeated `agent_settled` cannot grow seq.
   */
  function queueClear(reason, force) {
    if (!enabled) return null;
    const had = queueState.steering.length > 0 || queueState.followUp.length > 0;
    queueState.steering.length = 0;
    queueState.followUp.length = 0;
    if (!had && force !== true) return null;
    return writeQueue(reason || 'clear');
  }

  /**
   * §4 settings: into the open turn file, otherwise the per-session control file with
   * `turn_id="control"`.
   */
  function writeSettings(partial) {
    if (!enabled) return null;
    /* Every control envelope names its session: after /herdr-resume the turn file still
       belongs to the session we left, and the newest control line is the only evidence
       that the pane is now on another session. */
    const envelope = Object.assign({}, partial, { session_id: sessionId });
    if (turn) return writeTurn(envelope);
    const file = path.join(paneDir, mapping.controlFileName(sessionId));
    return enqueueEnvelope(envelope, file, mapping.CONTROL_TURN_ID);
  }

  /* ── turn lifecycle ──────────────────────────────────────────────────────── */

  function updateSession(next) {
    const value = next === undefined || next === null ? '' : String(next);
    if (!value) return;
    if (value === sessionId) return;
    if (turn && turn.sessionId && turn.sessionId !== value) {
      // a session switch while a turn is open: close it honestly before starting over
      writeTurn({ type: 'turn_end', status: 'aborted' });
      push({ kind: 'close' }, true);
      turn = null;
      toolIds = new Map();
      toolAlias = new Map();
      pending = { assistant: '', user: '' };
    }
    sessionId = value;
  }

  function openTurn(id, index) {
    const file = path.join(paneDir, mapping.turnFileName(sessionId, id));
    turn = { id, sessionId, file, index };
    toolIds = new Map();
    toolAlias = new Map();
    pending = { assistant: '', user: '' };
    messageCounter = 0;
    lastStopReason = '';
    // §2: cleanup happens on turn start; §3: the file is opened before its first line.
    cleanupPromise = cleanup();
    push({ kind: 'open', file }, true);
    return turn;
  }

  function ensureTurn(meta) {
    if (meta && meta.sessionId !== undefined) updateSession(meta.sessionId);
    if (turn) return turn;
    // §2 lazy open: the first event without a turn_start still gets a turn file.
    return openTurn(mapping.lazyTurnId(sessionId, now()), 'lazy');
  }

  function messageIdForRole(role) {
    const key = role === 'user' ? 'user' : 'assistant';
    if (!pending[key]) {
      messageCounter += 1;
      pending[key] = mapping.syntheticMessageId(turn ? turn.id : sessionId, messageCounter);
    }
    return pending[key];
  }

  /**
   * §3 "UI keys both by tool_call_id and shows one card". Some providers do not expose
   * the real id until `toolcall_end` (an OpenAI-compatible endpoint may send `id: ""`
   * on the first chunk), so the argument stream is written under a synthetic
   * per-message id. Remember the real id, so the execution events — which always carry
   * it — are written under that same synthetic id instead of creating a second card.
   */
  function aliasToolCall(realId, emittedId) {
    if (!realId || !emittedId || realId === emittedId) return;
    toolAlias.set(realId, emittedId);
  }

  function aliasEvent(event) {
    if (!event || typeof event !== 'object' || toolAlias.size === 0) return event;
    const id = toolAlias.get(mapping.str(event.toolCallId));
    const parent = toolAlias.get(mapping.str(event.parentToolCallId));
    if (!id && !parent) return event;
    const out = { ...event };
    if (id) out.toolCallId = id;
    if (parent) out.parentToolCallId = parent;
    return out;
  }

  /* ── public API ──────────────────────────────────────────────────────────── */

  /** Resolves when the queue and any pending cleanup are done, or after `timeoutMs`. */
  function flushAll(timeoutMs) {
    const wait = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : FLUSH_TIMEOUT_MS;
    if (!enabled) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, wait);
      if (typeof timer.unref === 'function') timer.unref();
      const cleanupDone = Promise.resolve(cleanupPromise).then(noop, noop);
      Promise.all([drained(), cleanupDone]).then(finish, finish);
    });
  }

  const api = {
    enabled,
    disabledReason: target.reason,
    root: enabled ? root : '',
    paneId,

    /** §4 `turn_start`. A second turn_start in the same run keeps the same file (§3). */
    turnStart(event, ctx) {
      if (!enabled) return null;
      updateSession(sessionOf(ctx));
      const index = mapping.toInt(event && event.turnIndex);
      if (turn) {
        // pi emits turn_start per LLM request and resets turnIndex to 0 on `agent_start`,
        // so index 0 after a later iteration means a NEW run whose predecessor never
        // settled (aborted/crashed). Close that one instead of growing it forever.
        const stale = index === 0 && typeof turn.index === 'number' && turn.index > 0;
        if (!stale) {
          if (index !== undefined) turn.index = index;   // remember the latest iteration
          return null;
        }
        writeTurn({ type: 'turn_end', status: 'aborted' });
        push({ kind: 'close' }, true);
        turn = null;
      }
      const at = now();
      const id = mapping.turnId(sessionId, index === undefined ? 0 : index, at);
      openTurn(id, index);
      return writeTurn(mapping.mapTurnStart(index));
    },

    messageStart(event, ctx) {
      if (!enabled) return null;
      const message = event && event.message;
      if (!mapping.roleOf(message)) return null;
      ensureTurn({ sessionId: sessionOf(ctx) });
      if (!turn) return null;
      const role = mapping.roleOf(message);
      if (role === 'assistant') {
        toolIds = new Map();           // content indexes are per assistant message
        toolAlias = new Map();
        messageCounter += 1;
      }
      const messageId = mapping.messageIdFor(message, turn.id, messageCounter || 1);
      pending[role] = messageId;
      const out = writeTurn(mapping.mapMessageStart(message, messageId));
      // §C.2: the delivery signal is a user message whose text matches a queued item.
      if (role === 'user') queueRemoveText(mapping.messageText(message));
      return out;
    },

    messageUpdate(event, ctx) {
      if (!enabled) return null;
      const message = event && event.message;
      if (!message || message.role !== 'assistant') return null;
      ensureTurn({ sessionId: sessionOf(ctx) });
      if (!turn) return null;
      const messageId = messageIdForRole('assistant');
      const assistantEvent = event.assistantMessageEvent;
      const partial = mapping.mapAssistantEvent(assistantEvent, messageId, toolIds);
      if (!partial) return null;
      if (partial.type === 'tool_call_end') {
        aliasToolCall(mapping.str(assistantEvent && assistantEvent.toolCall && assistantEvent.toolCall.id), partial.tool_call_id);
      }
      return writeTurn(partial);
    },

    messageEnd(event, ctx) {
      if (!enabled) return null;
      const message = event && event.message;
      const role = mapping.roleOf(message);
      if (!role) return null;
      ensureTurn({ sessionId: sessionOf(ctx) });
      if (!turn) return null;
      const messageId = messageIdForRole(role);
      if (role === 'assistant' && typeof message.stopReason === 'string') lastStopReason = message.stopReason;
      const errorEvent = role === 'assistant' ? mapping.mapMessageError(message, messageId) : null;
      if (errorEvent) writeTurn(errorEvent);
      const out = writeTurn(mapping.mapMessageEnd(message, messageId));
      pending[role] = '';
      return out;
    },

    toolStart(event) {
      if (!enabled) return null;
      ensureTurn();
      if (!turn) return null;
      return writeTurn(mapping.mapToolStart(aliasEvent(event)));
    },

    toolUpdate(event) {
      if (!enabled) return null;
      ensureTurn();
      if (!turn) return null;
      return writeTurn(mapping.mapToolUpdate(aliasEvent(event)));
    },

    toolEnd(event) {
      if (!enabled) return null;
      ensureTurn();
      if (!turn) return null;
      return writeTurn(mapping.mapToolEnd(aliasEvent(event)));
    },

    /** §4 `agent_settled` -> `turn_end`, then close the file (§2). */
    settled(event, ctx) {
      if (!enabled) return null;
      if (ctx) updateSession(sessionOf(ctx));
      // §C.3: the run is over, so the bridge-visible queue is empty — even when no turn
      // file was open (an accepted steer/follow-up may outlive a turn that never started).
      queueClear('settled', !!turn);
      if (!turn) return null;
      const status = mapping.turnEndStatus(event && event.aborted === true, lastStopReason);
      const out = writeTurn({ type: 'turn_end', status });
      push({ kind: 'close' }, true);
      turn = null;
      toolIds = new Map();
      toolAlias = new Map();
      pending = { assistant: '', user: '' };
      return out;
    },

    modelSelect(event, ctx) {
      if (!enabled) return null;
      updateSession(sessionOf(ctx));
      return writeSettings(mapping.mapSettingsModel(event && event.model));
    },

    sessionStart(event, ctx) {
      if (!enabled) return null;
      updateSession(sessionOf(ctx));
      const out = writeSettings({ type: 'settings', reason: (event && event.reason) || 'startup' });
      queueClear('session_start', true);
      return out;
    },

    thinkingLevelSelect(event, ctx) {
      if (!enabled) return null;
      updateSession(sessionOf(ctx));
      return writeSettings(mapping.mapSettingsThinking(event && event.level));
    },

    /** §4 `session_shutdown`: an open turn is force-closed, nothing else is emitted. */
    shutdown(event, ctx) {
      if (!enabled) return null;
      if (ctx) updateSession(sessionOf(ctx));
      queueClear('shutdown', true);
      if (!turn) return null;
      const out = writeTurn({ type: 'turn_end', status: 'aborted' });
      push({ kind: 'close' }, true);
      turn = null;
      toolIds = new Map();
      toolAlias = new Map();
      pending = { assistant: '', user: '' };
      return out;
    },

    /** §C.1/§C.2/§C.3 — used by the /herdr-steer and /herdr-followup commands. */
    queueAdd,
    queueRemoveText,
    queueClear,
    queueSnapshot() {
      return {
        steering: queueState.steering.map(queueItemCopy),
        followUp: queueState.followUp.map(queueItemCopy),
      };
    },

    /** Resolves when the queue and any pending cleanup are done, or after `timeoutMs`. */
    flush: flushAll,

    /** Abandon the writer: close any turn and the file handle, then flush. */
    dispose(timeoutMs) {
      if (!enabled) return Promise.resolve();
      turn = null;
      toolIds = new Map();
      pending = { assistant: '', user: '' };
      push({ kind: 'close' }, true);
      return flushAll(timeoutMs);
    },

    stats() {
      return {
        enabled,
        seq,
        written,
        dropped,
        failures,
        queued: queue.length,
        turnId: turn ? turn.id : '',
        file: turn ? turn.file : '',
        sessionId,
        queueSteering: queueState.steering.length,
        queueFollowUp: queueState.followUp.length,
      };
    },
  };

  return api;
}

function sessionOf(ctx) {
  try {
    const manager = ctx && ctx.sessionManager;
    if (!manager || typeof manager.getSessionId !== 'function') return '';
    const id = manager.getSessionId();
    return typeof id === 'string' ? id : '';
  } catch (err) {
    return '';
  }
}

/* ── the pi-facing bridge ──────────────────────────────────────────────────── */

/**
 * `index.ts` gets one of these. Every method is total: a broken event, a full disk or
 * a closed handle must never surface in the agent loop (§4 "never throw into pi").
 * Only `settled`/`shutdown` return a promise, and only so the file is flushed before
 * pi tears the extension down.
 */
function createPiBridge(opts) {
  const writer = createWriter(opts);

  function guard(fn) {
    return function guarded(event, ctx) {
      try {
        return fn(event, ctx);
      } catch (err) {
        return undefined;
      }
    };
  }

  return {
    enabled: writer.enabled,
    disabledReason: writer.disabledReason,
    root: writer.root,
    paneId: writer.paneId,
    writer,
    stats: () => writer.stats(),
    flush: (timeoutMs) => writer.flush(timeoutMs),

    /** QUEUE-CONTRACT §B/§C: the extension's queue commands write through these. */
    queueAdd: guard(writer.queueAdd),
    queueRemoveText: guard(writer.queueRemoveText),
    queueClear: guard(writer.queueClear),
    queueSnapshot: () => writer.queueSnapshot(),

    turnStart: guard(writer.turnStart),
    messageStart: guard(writer.messageStart),
    messageUpdate: guard(writer.messageUpdate),
    messageEnd: guard(writer.messageEnd),
    toolStart: guard(writer.toolStart),
    toolUpdate: guard(writer.toolUpdate),
    toolEnd: guard(writer.toolEnd),
    modelSelect: guard(writer.modelSelect),
    thinkingLevelSelect: guard(writer.thinkingLevelSelect),
    /** `session_start`: settings + the §C.3 queue clear (index.ts has always called this). */
    sessionStart: guard(writer.sessionStart),

    /** `agent_settled`: turn_end + close, then flush so the file is complete on return. */
    async settled(event, ctx) {
      try {
        writer.settled(event, ctx);
        await writer.flush(FLUSH_TIMEOUT_MS);
      } catch (err) { /* never throw into pi */ }
    },

    /** `session_shutdown`: force-close an open turn and flush before pi exits/reloads. */
    async shutdown(event, ctx) {
      try {
        writer.shutdown(event, ctx);
        await writer.flush(FLUSH_TIMEOUT_MS);
      } catch (err) { /* never throw into pi */ }
    },

    /** Drop the writer (tests, and any host that needs the fd closed). */
    dispose(timeoutMs) {
      return writer.dispose(timeoutMs);
    },
  };
}

module.exports = {
  VERSION,
  AGENT,
  QUEUE_MAX,
  KEEP_TURN_FILES,
  MAX_AGE_MS,
  QUEUE_ITEMS_MAX,
  QUEUE_TEXT_MAX,
  createWriter,
  createPiBridge,
  sessionOf,
  noop,
  /** QUEUE-CONTRACT §B: re-exported so `index.ts` reads the argument parser from the
   *  module it already imports (both sides must parse the command the same way). */
  parseQueueArgument: mapping.parseQueueArgument,
};
