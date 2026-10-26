'use strict';
/*
 * src/heartbeat.js — the selected pane's session heartbeat, one shape for hermes and pi (owner: U1).
 *
 * THE TWO STORES
 *
 *   hermes has a NATIVE session heartbeat (hermes_cli/heartbeat.py). Its state is one
 *   `state_meta` row in hermes' own sqlite store:
 *
 *     key   `heartbeat:<session_id>`
 *     value JSON {prompt, interval_seconds, status, created_at, last_fired_at, fire_count}
 *
 *   with `created_at`/`last_fired_at` in epoch SECONDS (python `time.time()`), and
 *   `status` one of active | paused | cleared (hermes keeps the row on clear and its
 *   own loader reports a `cleared` row as "no heartbeat" — this module does the same).
 *
 *   pi has NO native heartbeat; a pi extension (unit U3) reads the same six fields from
 *
 *     <pi agent home>/heartbeat/<session_id>.json
 *
 *   and the dash owns a different half of that file than the extension does:
 *
 *     the dash writes         prompt, interval_seconds, status, created_at
 *     the extension writes    last_fired_at, fire_count
 *
 *   so every dash write is a READ-MODIFY-WRITE that preserves the extension's two
 *   fields verbatim, and writes a temp file in the same directory before renaming it
 *   over the target. `clear` removes the file (absent = no heartbeat).
 *
 * THE RULES
 *
 *   Reads never mutate anything, for either agent. hermes reads open the store with
 *   the shared read-only opener in chat/hermes.js (URI `mode=ro` AND `readOnly`), so a
 *   heartbeat read can never take a write lock on a running hermes.
 *
 *   Writes go through exactly one door per agent: hermes writes ONLY by sending its
 *   official slash command into that pane through the same path /api/pane/prompt uses
 *   (`agent.prompt`), then waits ~2.5 s and re-reads the row; if the requested state
 *   has not landed yet the reply carries `pending:true` and a short pane excerpt (the
 *   CLI may still be applying it). pi writes ONLY its state file; nothing is ever sent
 *   into a pi pane.
 *
 *   HD_HEARTBEAT_DRY=1 turns every write path into a no-op that returns
 *   `applied_via:"dry-run"` plus the exact slash command (hermes) or JSON payload
 *   (pi) it would have used, so a test can exercise all four actions without touching
 *   a live pane or state file.
 *
 * PANE → SESSION
 *
 *   `resolvePaneSession` reads herdr's own `agent_session.value` for the pane; when
 *   herdr has none (it never publishes one for pi) it falls back to the pi bridge's
 *   pane-specific evidence (`pi.bridgeSessionForPane`, the same signal the chat view
 *   binds a pi pane with). The caller may pass a timeout for the herdr call only.
 *
 * FAILURE SHAPE
 *
 *   A failed action is `{ok:false, action, applied_via:null, heartbeat:null,
 *   error:{code,message}}` — the server's own error vocabulary, which is also what the
 *   U2 control reads (`body.error.code` / `body.error.message`).
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const hdr = require('./hdr');
const chatHermes = require('./chat/hermes');   // read-only sqlite opener (+ URI form)
const chatPi = require('./chat/pi');           // pi agent home + pane → bridge session

// ── constants ───────────────────────────────────────────────────────────────
const MIN_INTERVAL_SECONDS = 60;               // same floor as hermes' MIN_INTERVAL_SECONDS
const DEFAULT_TIMEOUT_MS = 10000;              // §4's per-request herdr timeout
const PANE_READ_TIMEOUT_MS = 5000;             // the pending excerpt is best-effort
const DEFAULT_WAIT_MS = 2500;                  // "wait ~2.5s and re-read" (contract)
const SUPPORTED_AGENTS = new Set(['hermes', 'pi']);
const ACTIONS = new Set(['set', 'pause', 'resume', 'clear']);
const HERMES_COMMAND = '/heartbeat';           // the official command (alias /hb not used)
/* A session id becomes a sqlite KEY and a FILE NAME; anything outside this shape is
   refused rather than escaped, so a hostile id cannot leave the heartbeat directory. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNIT_SECONDS = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
};
const INTERVAL_RE = /^\s*(?:every\s+)?(\d+(?:\.\d+)?)\s*([A-Za-z]+)\s*$/i;

/** HD_HEARTBEAT_DRY=1 makes every write path report and do nothing. Read per call so a
 *  test can flip it without reloading the module. */
function dryRun() {
  return process.env.HD_HEARTBEAT_DRY === '1';
}

/** How long a hermes write waits before the re-read. The env knob exists for tests. */
function waitMs() {
  const n = Number(process.env.HD_HEARTBEAT_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 30000) : DEFAULT_WAIT_MS;
}

const nowSeconds = () => Date.now() / 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── paths ───────────────────────────────────────────────────────────────────
/**
 * hermes' state.db, resolved in the contract's order:
 *   1. $HD_HEARTBEAT_DB
 *   2. %LOCALAPPDATA%/hermes/state.db  (or %APPDATA% when LOCALAPPDATA is unset)
 *   3. ~/.hermes/state.db
 */
function dbPath() {
  const explicit = process.env.HD_HEARTBEAT_DB;
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || '';
  if (base) return path.join(base, 'hermes', 'state.db');
  return path.join(os.homedir(), '.hermes', 'state.db');
}

/** `<pi agent home>/heartbeat` — the pi extension's state directory. chat/pi.js owns
 *  the agent-home resolution (PI_CODING_AGENT_DIR / PI_AGENT_HOME, else ~/.pi/agent). */
function piHeartbeatDir() {
  return path.join(chatPi.piAgentDir(), 'heartbeat');
}

/** `<pi agent home>/heartbeat/<session_id>.json`. */
function piHeartbeatFile(sessionId) {
  return path.join(piHeartbeatDir(), String(sessionId) + '.json');
}

// ── interval parse / format (mirrors hermes' own parser and formatter) ─────
/**
 * Parse `30m` / `every 2h` / `every 90 minutes` into seconds.
 * @returns {{ok:true,seconds:number}|{ok:false,message:string}} below the floor is an error.
 */
function parseInterval(text) {
  const s = typeof text === 'string' ? text : '';
  const m = INTERVAL_RE.exec(s);
  if (!m) return { ok: false, message: '"interval" must be a time like 90s, 10m, 2h or 1d' };
  const unit = UNIT_SECONDS[m[2].toLowerCase()];
  if (!unit) return { ok: false, message: `"${m[2]}" is not a time unit (use s, m, h or d)` };
  const seconds = Math.floor(Number(m[1]) * unit);
  if (!Number.isFinite(seconds) || seconds < MIN_INTERVAL_SECONDS) {
    return { ok: false, message: `the interval must be at least ${MIN_INTERVAL_SECONDS}s` };
  }
  return { ok: true, seconds };
}

/** 600 → `10m`, 3600 → `1h`, 90 → `90s` — the exact spelling hermes' format_interval uses. */
function formatInterval(seconds) {
  const s = Math.max(0, Math.trunc(Number(seconds) || 0));
  if (s && s % 86400 === 0) return (s / 86400) + 'd';
  if (s && s % 3600 === 0) return (s / 3600) + 'h';
  if (s && s % 60 === 0) return (s / 60) + 'm';
  return s + 's';
}

// ── state normalization ─────────────────────────────────────────────────────
/** One stored heartbeat → the contract's six fields; null when not an object. Epoch
 *  zero (the value hermes' dataclass writes before the first fire) reads as null. */
function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const interval = Number(value.interval_seconds);
  const created = Number(value.created_at);
  const lastFired = Number(value.last_fired_at);
  const fireCount = Number(value.fire_count);
  return {
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
    interval_seconds: Number.isFinite(interval) ? Math.trunc(interval) : 0,
    status: typeof value.status === 'string' && value.status ? value.status : 'active',
    created_at: Number.isFinite(created) && created > 0 ? created : null,
    last_fired_at: Number.isFinite(lastFired) && lastFired > 0 ? lastFired : null,
    fire_count: Number.isFinite(fireCount) && fireCount > 0 ? Math.trunc(fireCount) : 0,
  };
}

/**
 * Seconds until the next fire, or null when there is no scheduled one (paused, or no
 * usable anchor). Hermes' own rule: anchor = last_fired_at, else created_at; a missed
 * tick coalesces, so an overdue heartbeat answers 0 (it fires on the next idle poll).
 */
function nextFireInSeconds(state, now) {
  if (!state || state.status !== 'active') return null;
  const interval = Number(state.interval_seconds);
  if (!Number.isFinite(interval) || interval <= 0) return null;
  const anchor = state.last_fired_at != null ? state.last_fired_at : state.created_at;
  if (!Number.isFinite(anchor)) return null;
  return Math.max(0, Math.round(anchor + interval - (Number.isFinite(now) ? now : nowSeconds())));
}

/** The contract's heartbeat object: the six fields plus the derived countdown. */
function withNextFire(state, now) {
  const out = Object.assign({}, state);
  out.next_fire_in_seconds = nextFireInSeconds(state, now);
  return out;
}

// ── hermes store (READ ONLY) ────────────────────────────────────────────────
/**
 * Read one `heartbeat:<session_id>` row without taking a write lock.
 * @returns {{found:boolean,file:string,raw:string|null,state:object|null,note:string}}
 *          `state` is the parsed row even when its status is `cleared`; readHeartbeat
 *          is the layer that reports a cleared row as "no heartbeat".
 */
function readHermesState(sessionId) {
  const file = dbPath();
  let db;
  try {
    db = chatHermes.openReadOnly(file);
    const row = db.prepare('SELECT value FROM state_meta WHERE key = ?').get('heartbeat:' + sessionId);
    if (!row || row.value == null) return { found: false, file, raw: null, state: null, note: '' };
    const raw = String(row.value);
    try {
      return { found: true, file, raw, state: normalizeState(JSON.parse(raw)), note: '' };
    } catch (e) {
      return { found: true, file, raw, state: null, note: 'the stored heartbeat for this session is not valid JSON' };
    }
  } catch (e) {
    return { found: false, file, raw: null, state: null, note: 'state.db could not be read: ' + e.message };
  } finally {
    if (db) { try { db.close(); } catch (e) { /* already gone */ } }
  }
}

// ── read ────────────────────────────────────────────────────────────────────
/**
 * The contract's GET shape. Never mutates; a missing store/file is `heartbeat:null`
 * plus a note, not an error.
 *
 * @param {{agent?:string, sessionId?:string, now?:number}} input
 * @returns {Promise<{ok:true,agent:string|null,session_id:string|null,supported:boolean,
 *                    source:string|null,heartbeat:object|null,note?:string}>}
 */
async function readHeartbeat(input) {
  const o = input || {};
  const agent = o.agent == null ? '' : String(o.agent);
  const sessionId = o.sessionId == null ? '' : String(o.sessionId);
  const now = Number.isFinite(o.now) ? o.now : nowSeconds();

  if (!SUPPORTED_AGENTS.has(agent)) {
    return {
      ok: true, agent: agent || null, session_id: sessionId || null,
      supported: false, source: null, heartbeat: null,
      note: 'the heartbeat is hermes- and pi-only (this pane is ' + (agent || 'unknown') + ')',
    };
  }
  const source = agent === 'hermes' ? 'hermes_state_meta' : 'pi_state_file';
  if (!sessionId || !SAFE_SESSION_ID.test(sessionId)) {
    return {
      ok: true, agent, session_id: sessionId || null, supported: true, source, heartbeat: null,
      note: sessionId
        ? 'the session id is not a safe key/file token, so its heartbeat cannot be located'
        : 'the pane\'s session could not be resolved, so its heartbeat cannot be located',
    };
  }

  if (agent === 'hermes') {
    const read = readHermesState(sessionId);
    const state = read.state && read.state.status !== 'cleared' ? read.state : null;
    const note = !read.found
      ? (read.note || 'no heartbeat is set for this session')
      : (!read.state ? read.note : '');
    const payload = { ok: true, agent: 'hermes', session_id: sessionId, supported: true, source, heartbeat: state ? withNextFire(state, now) : null };
    if (note) payload.note = note;
    return payload;
  }

  // pi: absent file = no heartbeat
  const file = piHeartbeatFile(sessionId);
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    return {
      ok: true, agent: 'pi', session_id: sessionId, supported: true, source, heartbeat: null,
      note: e && e.code === 'ENOENT'
        ? 'no heartbeat file for this pi session yet'
        : 'the pi heartbeat file could not be read: ' + ((e && e.message) || e),
    };
  }
  let state = null;
  try { state = normalizeState(JSON.parse(raw)); } catch (e) { state = null; }
  if (!state) {
    return { ok: true, agent: 'pi', session_id: sessionId, supported: true, source, heartbeat: null, note: 'the pi heartbeat file is not valid JSON' };
  }
  if (state.status === 'cleared') return { ok: true, agent: 'pi', session_id: sessionId, supported: true, source, heartbeat: null };
  return { ok: true, agent: 'pi', session_id: sessionId, supported: true, source, heartbeat: withNextFire(state, now) };
}

// ── pane → session ──────────────────────────────────────────────────────────
/**
 * Which session is live in a pane, for locating its heartbeat. Reuses the repo's two
 * existing signals in their existing order: herdr's `agent_session.value`, then the pi
 * bridge's pane-specific evidence (the same one chat/session.js trusts first for pi).
 *
 * @param {string} paneId
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{pane_id:string,agent:string|null,session_id:string|null,
 *                    source:string|null,note:string}>}
 */
async function resolvePaneSession(paneId, opts) {
  const o = opts || {};
  const id = paneId === undefined || paneId === null ? '' : String(paneId);
  if (!id) return { pane_id: '', agent: null, session_id: null, source: null, note: 'no pane id was given' };
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : DEFAULT_TIMEOUT_MS;

  let entry = null;
  let listError = null;
  try {
    const list = await hdr.request('agent.list', {}, { timeoutMs });
    const agents = (list && (list.agents || (list.result && list.result.agents))) || [];
    entry = agents.find((a) => a && a.pane_id === id) || null;
  } catch (e) {
    listError = e;
  }

  const session = entry && entry.agent_session;
  let agent = String((session && session.agent) || (entry && entry.agent) || '') || null;
  let sessionId = session && session.value != null ? String(session.value) : '';
  let source = sessionId ? 'herdr' : null;

  if (!sessionId) {
    const bridge = await chatPi.bridgeSessionForPane(id).catch(() => null);
    if (bridge && bridge.id) {
      sessionId = String(bridge.id);
      source = bridge.kind === 'control' ? 'pi_control_file' : 'pi_sink_file';
      if (!agent) agent = 'pi';
    }
  }

  // herdr unreachable AND no pi evidence: the caller should see why nothing resolved.
  if (!entry && listError && !sessionId) throw listError;

  return {
    pane_id: id,
    agent,
    session_id: sessionId || null,
    source,
    note: entry
      ? ''
      : (sessionId ? 'herdr lists no agent entry for this pane; the pi bridge named its session' : 'herdr lists no agent entry for this pane'),
  };
}

// ── write helpers ───────────────────────────────────────────────────────────
/** The contract's failure body, with the server's machine-readable error shape. */
function fail(action, code, message) {
  return { ok: false, action: action || null, applied_via: null, heartbeat: null, error: { code, message } };
}

/** Validate the fields every action needs; a failure is a finished reply. */
function commonContext(o, action) {
  const paneId = o.paneId == null ? '' : String(o.paneId);
  const agent = o.agent == null ? '' : String(o.agent);
  const sessionId = o.sessionId == null ? '' : String(o.sessionId);
  if (!paneId) return { failure: fail(action, 'bad_request', '"pane_id" is required') };
  if (!SUPPORTED_AGENTS.has(agent)) {
    return { failure: fail(action, 'unsupported_agent', 'the heartbeat is hermes- and pi-only (this pane is ' + (agent || 'unknown') + ')') };
  }
  if (!sessionId || !SAFE_SESSION_ID.test(sessionId)) {
    return { failure: fail(action, 'no_session', 'the pane\'s session could not be resolved, so its heartbeat cannot be updated') };
  }
  return { paneId, agent, sessionId };
}

/** `set` needs both fields; returns the trimmed prompt and parsed interval. */
function validateSet(o) {
  const rawPrompt = typeof o.prompt === 'string' ? o.prompt : '';
  const prompt = rawPrompt.trim();
  if (!prompt) return { error: 'the heartbeat prompt is required' };
  if (/[\r\n]/.test(rawPrompt)) return { error: 'the heartbeat prompt must be a single line' };
  const parsed = parseInterval(o.interval);
  if (!parsed.ok) return { error: parsed.message };
  return { prompt, intervalSeconds: parsed.seconds, intervalToken: formatInterval(parsed.seconds) };
}

/** A short tail of the pane's visible text for the pending reply; never throws. */
async function readPaneExcerpt(paneId) {
  try {
    const read = await hdr.request(
      'pane.read',
      { pane_id: paneId, source: 'visible', lines: 10, format: 'text', strip_ansi: true },
      { timeoutMs: PANE_READ_TIMEOUT_MS },
    );
    const text = (read && read.read && read.read.text) || (read && read.text) || '';
    const lines = hdr.stripAnsi(String(text)).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
    const tail = lines.slice(-4).join('\n');
    return tail.length > 240 ? tail.slice(tail.length - 240) : tail;
  } catch (e) {
    return '';
  }
}

/** What hermes' CLI would leave in the store after this action (used by dry-run). */
function hermesWouldBe(ctx, current) {
  const base = current && current.status !== 'cleared' ? current : null;
  if (ctx.action === 'clear') return null;
  if (ctx.action === 'set') {
    return { prompt: ctx.prompt, interval_seconds: ctx.intervalSeconds, status: 'active', created_at: nowSeconds(), last_fired_at: null, fire_count: 0 };
  }
  if (!base) return null;
  if (ctx.action === 'pause') return Object.assign({}, base, { status: 'paused' });
  return Object.assign({}, base, { status: 'active', last_fired_at: nowSeconds() });   // resume re-anchors
}

/** Did the CLI reach the requested state? (A concurrent fire changes the row without
 *  applying the command, so "the raw value changed" alone is not enough.) */
function hermesTargetReached(ctx, after) {
  const state = after && after.status !== 'cleared' ? after : null;
  if (ctx.action === 'clear') return !state;
  if (ctx.action === 'pause') return !!state && state.status === 'paused';
  if (ctx.action === 'resume') return !!state && state.status === 'active';
  return !!state && state.status === 'active' && state.prompt === ctx.prompt && state.interval_seconds === ctx.intervalSeconds;
}

/**
 * hermes: send the official slash command through the repo's pane-send path, wait, and
 * re-read. Dry-run skips the send and the wait and reports the would-be state instead.
 */
async function applyHermes(ctx) {
  const before = readHermesState(ctx.sessionId);
  if (dryRun()) {
    const would = hermesWouldBe(ctx, before.state);
    return {
      ok: true, action: ctx.action, applied_via: 'dry-run',
      heartbeat: would ? withNextFire(would) : null,
      pending: false,
      command: ctx.command,
    };
  }

  await hdr.request('agent.prompt', { target: ctx.paneId, text: ctx.command }, { timeoutMs: DEFAULT_TIMEOUT_MS });
  await sleep(waitMs());
  const after = readHermesState(ctx.sessionId);
  const applied = hermesTargetReached(ctx, after.state);
  const state = after.state && after.state.status !== 'cleared' ? after.state : null;
  const reply = {
    ok: true, action: ctx.action, applied_via: 'slash-command',
    heartbeat: state ? withNextFire(state) : null,
    pending: !applied,
  };
  if (!applied) {
    const excerpt = await readPaneExcerpt(ctx.paneId);
    if (excerpt) reply.pane_excerpt = excerpt;
  }
  return reply;
}

/** The pi state file as bytes for read-modify-write. `error` only for non-ENOENT I/O. */
async function readPiRaw(sessionId) {
  const file = piHeartbeatFile(sessionId);
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    return { file, exists: false, raw: null, json: null, error: e && e.code === 'ENOENT' ? null : ('the pi heartbeat file could not be read: ' + ((e && e.message) || e)) };
  }
  let json = null;
  try { json = JSON.parse(raw); } catch (e) { json = null; }
  return { file, exists: true, raw, json, error: null };
}

/** The exact six-field payload, with the extension's two fields preserved verbatim. */
function piPayload(base, overrides) {
  const b = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    prompt: overrides.prompt !== undefined ? overrides.prompt : (typeof b.prompt === 'string' ? b.prompt : ''),
    interval_seconds: overrides.interval_seconds !== undefined
      ? overrides.interval_seconds
      : (Number.isFinite(Number(b.interval_seconds)) ? Math.trunc(Number(b.interval_seconds)) : 0),
    status: overrides.status !== undefined ? overrides.status : (typeof b.status === 'string' && b.status ? b.status : 'active'),
    created_at: overrides.created_at !== undefined ? overrides.created_at : (num(b.created_at) || nowSeconds()),
    last_fired_at: num(b.last_fired_at),
    fire_count: num(b.fire_count) ? Math.trunc(num(b.fire_count)) : 0,
  };
}

/** Temp file in the SAME directory, then rename over the target (atomic swap). */
async function writePiState(file, payload) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp');
  try {
    await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fsp.rename(tmp, file);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch (e2) { /* nothing left to clean */ }
    throw e;
  }
}

/** pi: atomic read-modify-write of the state file; never touches the extension's fields. */
async function applyPi(ctx) {
  const current = await readPiRaw(ctx.sessionId);
  if (current.error) return fail(ctx.action, 'state_unreadable', current.error);
  const base = current.exists && current.json && typeof current.json === 'object' && !Array.isArray(current.json) ? current.json : null;
  if (current.exists && !base) {
    return fail(ctx.action, 'state_corrupt', 'the pi heartbeat file is not a JSON object; clear it before writing a new heartbeat');
  }

  // clear: absent file = no heartbeat already — idempotent, nothing written.
  if (ctx.action === 'clear') {
    if (dryRun()) {
      return { ok: true, action: 'clear', applied_via: 'dry-run', heartbeat: null, pending: false, target_file: current.file, payload: null, remove: true };
    }
    if (current.exists) await fsp.unlink(current.file);
    return { ok: true, action: 'clear', applied_via: 'state-file', heartbeat: null, pending: false, target_file: current.file };
  }

  // pause/resume with no heartbeat: the requested end state already holds.
  if (!base && (ctx.action === 'pause' || ctx.action === 'resume')) {
    return {
      ok: true, action: ctx.action, applied_via: dryRun() ? 'dry-run' : 'state-file',
      heartbeat: null, pending: false, target_file: current.file,
      note: 'no heartbeat is set for this pi session',
    };
  }

  const overrides = ctx.action === 'set'
    ? { prompt: ctx.prompt, interval_seconds: ctx.intervalSeconds, status: 'active', created_at: nowSeconds() }
    : { status: ctx.action === 'pause' ? 'paused' : 'active' };
  const payload = piPayload(base, overrides);

  if (dryRun()) {
    return {
      ok: true, action: ctx.action, applied_via: 'dry-run',
      heartbeat: withNextFire(normalizeState(payload)),
      pending: false,
      target_file: current.file,
      payload,
    };
  }
  try {
    await writePiState(current.file, payload);
  } catch (e) {
    return fail(ctx.action, 'state_write_failed', 'the pi heartbeat file could not be written: ' + ((e && e.message) || e));
  }
  return {
    ok: true, action: ctx.action, applied_via: 'state-file',
    heartbeat: withNextFire(normalizeState(payload)),
    pending: false,
    target_file: current.file,
  };
}

// ── actions ─────────────────────────────────────────────────────────────────
/**
 * POST /api/heartbeat `set`. Requires `interval` and `prompt`; see the header for how
 * each agent applies it and what dry-run returns.
 */
async function set(o) {
  const input = o || {};
  const ctx = commonContext(input, 'set');
  if (ctx.failure) return ctx.failure;
  const v = validateSet(input);
  if (v.error) return fail('set', 'bad_request', v.error);
  const job = {
    action: 'set', paneId: ctx.paneId, agent: ctx.agent, sessionId: ctx.sessionId,
    prompt: v.prompt, intervalSeconds: v.intervalSeconds,
    command: HERMES_COMMAND + ' every ' + v.intervalToken + ' ' + v.prompt,
  };
  return ctx.agent === 'hermes' ? applyHermes(job) : applyPi(job);
}

/** POST /api/heartbeat `pause`. */
async function pause(o) {
  const input = o || {};
  const ctx = commonContext(input, 'pause');
  if (ctx.failure) return ctx.failure;
  const job = { action: 'pause', paneId: ctx.paneId, agent: ctx.agent, sessionId: ctx.sessionId, command: HERMES_COMMAND + ' pause' };
  return ctx.agent === 'hermes' ? applyHermes(job) : applyPi(job);
}

/** POST /api/heartbeat `resume`. */
async function resume(o) {
  const input = o || {};
  const ctx = commonContext(input, 'resume');
  if (ctx.failure) return ctx.failure;
  const job = { action: 'resume', paneId: ctx.paneId, agent: ctx.agent, sessionId: ctx.sessionId, command: HERMES_COMMAND + ' resume' };
  return ctx.agent === 'hermes' ? applyHermes(job) : applyPi(job);
}

/** POST /api/heartbeat `clear`. */
async function clear(o) {
  const input = o || {};
  const ctx = commonContext(input, 'clear');
  if (ctx.failure) return ctx.failure;
  const job = { action: 'clear', paneId: ctx.paneId, agent: ctx.agent, sessionId: ctx.sessionId, command: HERMES_COMMAND + ' clear' };
  return ctx.agent === 'hermes' ? applyHermes(job) : applyPi(job);
}

/** Route the contract's `action`; an unknown one is a finished bad_request reply. */
async function apply(input) {
  const o = input || {};
  const action = typeof o.action === 'string' ? o.action : '';
  if (!ACTIONS.has(action)) {
    return fail(action || null, 'bad_request', '"action" must be "set", "pause", "resume" or "clear"');
  }
  if (action === 'set') return set(o);
  if (action === 'pause') return pause(o);
  if (action === 'resume') return resume(o);
  return clear(o);
}

module.exports = {
  MIN_INTERVAL_SECONDS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WAIT_MS,
  SAFE_SESSION_ID,
  dbPath,
  piHeartbeatDir,
  piHeartbeatFile,
  parseInterval,
  formatInterval,
  normalizeState,
  nextFireInSeconds,
  readHeartbeat,
  resolvePaneSession,
  set,
  pause,
  resume,
  clear,
  apply,
};
