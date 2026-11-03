'use strict';
/*
 * src/hdr.js — herdr compatibility layer (owner: W1)
 *
 * The dashboard was written against the original herdr socket API
 * (`session.snapshot`, `pane.*`, `agent.*`, protocol 22). This machine runs
 * herdr-core (`hc`), whose API is `terminal.*` over a different pipe name.
 *
 * This file keeps the OLD method surface that server.js and the chat modules
 * call, and translates each call onto herdr-core. Nothing above this layer had
 * to change:
 *
 *   session.snapshot  -> terminal.list (panes/tabs/workspaces synthesised)
 *   pane.list         -> terminal.list
 *   pane.read         -> terminal.read
 *   pane.send_text    -> terminal.send   (herdr-core always presses Enter)
 *   pane.send_keys    -> terminal.keys
 *   agent.list        -> terminal.list, projected to agent records
 *   agent.prompt      -> terminal.send
 *   ping              -> server.status
 *   events.subscribe  -> events.subscribe, mapped to pane.* event names
 *
 * Exports: pipe, HerdrError, request, subscribe, stripAnsi, mergeStream,
 *          advanceBuffer, plus the core helpers for tests.
 */

const net = require('node:net');
const core = require('./hdr-core');

const pipe = core.pipe;

class HerdrError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HerdrError';
    this.code = code || 'herdr_error';
    this.kind = null;
    this.errno = null;
    this.pipe = null;
  }
}

/** Wrap a herdr-core failure into the error shape the HTTP layer expects. */
function wrap(err, method) {
  if (err && err.code === 'pipe_error') {
    const e = new HerdrError('pipe_error', err.message);
    e.errno = err.errno || null;
    e.kind = err.errno === 'ENOENT' ? 'missing' : (err.errno === 'EPERM' || err.errno === 'EACCES') ? 'denied' : 'other';
    e.pipe = pipe;
    return e;
  }
  if (err && err.code === 'timeout') return new HerdrError('timeout', err.message);
  const e = new HerdrError('herdr_error', (err && err.message) || `herdr-core call failed: ${method}`);
  e.upstream = err && err.code;
  return e;
}

// ── snapshot projection ─────────────────────────────────────────────────────
// herdr-core reports `status.app` only for programs that self-report (pi does).
// A plain shell running a TUI agent (hermes) keeps foreground.name = powershell.exe,
// so the dash would treat the pane as "other" and refuse the chat view. Detect those
// from the screen, cached briefly — the read costs ~3 ms and only runs for panes
// without a status.app.
//
// The same read answers the agent's status: hermes draws its run state on screen
// (`type to redirect this turn` while a turn runs, the clarify panel / `!!!` card when
// it waits for an answer) but reports nothing to herdr-core, which is why the sidebar
// used to read "unknown" for a hermes pane.
const AGENT_CACHE_MS = 2500;
const agentCache = new Map();

function screenAgent(text) {
  if (!text) return null;
  if (text.includes('\u2624')) return 'hermes';           // ☤ status/input line
  if (/Claude Code|\u23f5\u23f5/.test(text)) return 'claude';
  return null;
}

/** Run state from the pane's own drawing. Only the bottom of the screen is trusted: the
 *  transcript above can quote these words (an agent writing about its own UI). */
function screenStatus(agent, text) {
  if (!text) return null;
  const lines = String(text).split('\n');
  /* Only the TUI chrome at the very bottom is trusted. The transcript above can quote any of
     these phrases verbatim — including this agent writing about its own UI — so a wide window
     produces false "blocked"/"working" readings on a pane that is simply talking. */
  const chrome = lines.slice(-12).join('\n');
  if (agent === 'hermes') {
    if (/Hermes needs your input/.test(chrome)
        && /(to select,?\s*Enter|Enter to lock|type your answer and press Enter)/i.test(chrome)) return 'blocked';
    if (/^\s*!!!.*!!!\s*$/m.test(chrome)) return 'blocked';
    /* The input line and the activity line are single anchored widgets; reading them by anchor
       keeps prose in the transcript from ever reading as a run state. */
    const promptLine = lines.filter((l) => /^\s*\u2624\s*\u276f/.test(l)).pop() || '';
    if (/type to redirect this turn|Tab queues it for after/.test(promptLine)) return 'working';
    const activity = lines.filter((l) => /^\s*\u2500\u2500\s/.test(l)).pop() || '';
    if (/[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f]/.test(activity)) return 'working';
    return 'idle';
  }
  if (agent === 'claude') {
    if (/\u23f5\u23f5|esc to interrupt/.test(chrome)) return 'working';
    return 'idle';
  }
  return null;
}

async function detectAgent(t) {
  if (t.status && t.status.app) return null;
  const cached = agentCache.get(t.address);
  if (cached && Date.now() - cached.at < AGENT_CACHE_MS) return cached;
  let info = { agent: null, status: null };
  try {
    const r = await core.rpc('terminal.read', { terminal: t.address, lines: 0 }, { timeoutMs: 3000 });
    const text = typeof r.text === 'string' ? r.text : '';
    const agent = screenAgent(text);
    info = { agent, status: agent ? screenStatus(agent, text) : null };
  } catch (e) {
    info = { agent: null, status: null };
  }
  agentCache.set(t.address, Object.assign({ at: Date.now() }, info));
  return info;
}

async function detectAgents(terminals) {
  const overrides = new Map();
  await Promise.all(terminals.map(async (t) => {
    const info = await detectAgent(t);
    if (info && info.agent) overrides.set(t.address, info);
  }));
  return overrides;
}

function paneFrom(t, index, agentOverride) {
  const labels = t.labels || {};
  const detected = agentOverride || null;
  return {
    pane_id: t.address,
    workspace_id: labels['herdr.space'] || 'w1',
    tab_id: labels['herdr.tab'] || null,
    agent: (detected && detected.agent) || core.agentOf(t),
    agent_status: core.statusOf(t) || (detected && detected.status) || null,
    cwd: t.cwd || '',
    title: t.title || '',
    label: t.name || '',
    terminal_title: t.title || '',
    focused: false,
    state: t.state,
    index,
  };
}

function projectSnapshot(terminals, agentOverrides) {
  const overrides = agentOverrides || new Map();
  const panes = terminals.map((t, i) => paneFrom(t, i, overrides.get(t.address)));
  const workspaces = [];
  const tabs = [];
  const seenW = new Set();
  const seenT = new Set();
  for (const p of panes) {
    if (!seenW.has(p.workspace_id)) {
      seenW.add(p.workspace_id);
      workspaces.push({
        workspace_id: p.workspace_id,
        number: workspaces.length + 1,
        label: 'herdr',
      });
    }
    const tabId = p.tab_id || `${p.workspace_id}:unassigned`;
    if (!seenT.has(tabId)) {
      seenT.add(tabId);
      tabs.push({
        tab_id: tabId,
        workspace_id: p.workspace_id,
        number: tabs.length + 1,
        label: 'main',
      });
      if (!p.tab_id) p.tab_id = tabId;
    }
  }
  return {
    version: 'herdr-core',
    protocol: 0,
    panes,
    tabs,
    workspaces,
    focused_pane_id: panes.length ? panes[0].pane_id : null,
  };
}

async function listTerminals(opts) {
  const res = await core.rpc('terminal.list', {}, opts);
  return Array.isArray(res.terminals) ? res.terminals : [];
}

async function snapshot() {
  const terminals = await listTerminals();
  const overrides = await detectAgents(terminals);
  return { snapshot: projectSnapshot(terminals, overrides) };
}

async function agentList() {
  const terminals = await listTerminals();
  const overrides = await detectAgents(terminals);
  return {
    agents: terminals.map((t) => {
      const ov = overrides.get(t.address) || null;
      return {
        pane_id: t.address,
        agent: (ov && ov.agent) || core.agentOf(t),
        agent_status: core.statusOf(t) || (ov && ov.status) || null,
        cwd: t.cwd || '',
        // herdr-core keeps no agent-session id; the chat resolver falls back to
        // the agent's own store, which is what it does for panes without one.
        agent_session: null,
      };
    }),
  };
}

async function readPane(params) {
  const paneId = params && params.pane_id;
  const source = (params && params.source) || 'recent_unwrapped';
  const format = (params && params.format) === 'ansi' ? 'ansi' : 'text';
  const want = Number(params && params.lines);
  const lines = !Number.isFinite(want) || want <= 0 ? (source === 'visible' ? 0 : 200)
    : (source === 'visible' ? 0 : Math.min(5000, want));
  const res = await core.rpc('terminal.read', { terminal: paneId, lines });
  let text = typeof res.text === 'string' ? res.text : '';
  if (format !== 'ansi') text = stripAnsi(text);
  return {
    read: {
      pane_id: paneId,
      source,
      format,
      revision: null,
      text,
    },
  };
}

async function sendText(paneId, text) {
  await core.rpc('terminal.send', { terminal: paneId, text: String(text == null ? '' : text) });
  return { ok: true };
}

async function sendKeys(paneId, keys) {
  await core.rpc('terminal.keys', { terminal: paneId, keys: Array.isArray(keys) ? keys : [keys] });
  return { ok: true };
}

// ── request ─────────────────────────────────────────────────────────────────
async function request(method, params, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 10000;
  const o = { timeoutMs };
  const p = params || {};
  try {
    switch (method) {
      case 'ping': {
        const st = await core.rpc('server.status', {}, o);
        return { ok: true, version: st.version, protocol: 0, core: st.core };
      }
      case 'session.snapshot':
        return await snapshot();
      case 'pane.list': {
        const terminals = await listTerminals(o);
        const overrides = await detectAgents(terminals);
        return { panes: projectSnapshot(terminals, overrides).panes };
      }
      case 'pane.read':
        return await readPane(p);
      case 'pane.send_text':
        return await sendText(p.pane_id, p.text);
      case 'pane.send_keys':
        return await sendKeys(p.pane_id, p.keys);
      case 'agent.list':
        return await agentList();
      case 'agent.prompt':
        return await sendText(p.target || p.pane_id, p.text);
      default:
        // Anything else is passed through so new herdr-core calls stay usable.
        return await core.rpc(method, p, o);
    }
  } catch (err) {
    throw wrap(err, method);
  }
}

// ── subscriptions ───────────────────────────────────────────────────────────
const EVENT_MAP = {
  created: 'pane.created',
  finished: 'pane.closed',
  removed: 'pane.closed',
  status: 'pane.agent_status_changed',
};

function legacyEvent(params) {
  const type = String((params && params.type) || '');
  const terminal = params && (params.terminal || (params.data && params.data.address));
  const data = (params && params.data) || {};
  const paneId = terminal || data.address || null;
  const event = EVENT_MAP[type] || 'pane.updated';
  if (event === 'pane.agent_status_changed') {
    const status = (data.status && data.status.state) || data.state || null;
    return { event, data: { pane_id: paneId, agent_status: status } };
  }
  return { event, data: { pane_id: paneId } };
}

function subscribe(subscriptions, onEvent, onStatus) {
  const socket = net.connect(pipe);
  let buf = '';
  let acked = false;
  let closed = false;

  const status = (st) => { try { if (onStatus) onStatus(st); } catch (e) { /* ignore */ } };
  const event = (evt) => { try { if (onEvent) onEvent(evt); } catch (e) { /* ignore */ } };

  socket.setNoDelay(true);
  socket.on('connect', () => {
    socket.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 'sub',
      method: 'events.subscribe',
      params: {},
    }) + '\n');
  });

  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }

      if (!acked) {
        if (msg.error) {
          closed = true;
          socket.destroy();
          status({ state: 'error', error: { code: 'subscribe_failed', message: msg.error.message || 'subscribe failed' } });
          return;
        }
        if (msg.result) {
          acked = true;
          status({ state: 'connected' });
          continue;
        }
      }
      if (msg.method === 'event' && msg.params) event(legacyEvent(msg.params));
    }
  });

  socket.on('error', (err) => {
    if (closed) return;
    closed = true;
    status({ state: 'error', error: { code: 'pipe_error', message: err.message } });
  });
  socket.on('close', () => {
    if (closed) return;
    closed = true;
    status({ state: 'closed' });
  });

  return {
    close() {
      closed = true;
      try { socket.destroy(); } catch (e) { /* gone */ }
    },
  };
}

// ── text helpers (unchanged) ────────────────────────────────────────────────
const ANSI_RE = new RegExp([
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
  '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
].join('|'), 'g');

function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI_RE, '') : text;
}

function mergeStream(prevLines, nextLines) {
  const max = Math.min(prevLines.length, nextLines.length);
  for (let k = max; k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (prevLines[prevLines.length - k + i] !== nextLines[i]) { same = false; break; }
    }
    if (same) return { newLines: nextLines.slice(k), overlapped: true };
  }
  return { newLines: nextLines, overlapped: false };
}

const { advanceBuffer } = require('../public/lib/advance-buffer.js');

module.exports = {
  pipe,
  HerdrError,
  request,
  subscribe,
  stripAnsi,
  mergeStream,
  advanceBuffer,
  projectSnapshot,
  legacyEvent,
  readPane,
  screenStatus,
};
