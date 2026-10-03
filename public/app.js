/* herdr-dash frontend — vanilla ES2020, no imports, no build step.
 * Data sources: the HTTP API in CONTRACT.md §4 / CONTRACT-v2 §2 and the SSE stream in §5.
 * Every failure is rendered inline in the panel that failed; nothing is thrown to the console.
 *
 * Round 2 (W2): DEFECT-1 (advanceBuffer, 1200-line window, reset marker, revision skip),
 * DEFECT-2, window.HD (CONTRACT-v2 §3) + defensive module mounting + the module events.
 */
'use strict';

const SELFTEST = /[?&]selftest=1(&|$)/.test(window.location.search);

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

const $ = function (id) { return document.getElementById(id); };

function show(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  if (cls) { el.className = cls; el.classList.remove('hidden'); }
}
function hide(el) { if (el) el.classList.add('hidden'); }
function clearErr(el) { if (el) { el.classList.add('hidden'); el.textContent = ''; } }
function setText(el, t) { if (el) el.textContent = t; }

/* ------------------------------------------------------------------ *
 * localStorage (never throws, even in private mode)
 * ------------------------------------------------------------------ */

const LS = {
  selected: 'herdrDash.selectedPane',
  history: 'herdrDash.cmdHistory',
  trees: 'herdrDash.collapsedTrees',
  sidebar: 'herdrDash.sidebarCollapsed',
  console: 'herdrDash.consoleCollapsed',
  width: 'herdrDash.sidebarWidth',
  templates: 'herdrDash.templates',         // owned by lib/fanout.js
  /* §12: the round-8 keys are named literally in the contract (`hd.*`), unlike the v1 `herdrDash.*`
     ones above, so they are written exactly as specified rather than in the older house style. */
  promptH: 'hd.promptH',                    // §12.1.4 — the composer's height
  dockW: 'hd.dockW',                        // §12.2.1 — the dock's width
  dockOpen: 'hd.dockOpen'                   // §12.2.1 — '1' open, anything else closed
};

function lsGet(key, dflt) {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? dflt : v;
  } catch (e) { return dflt; }
}
function lsSet(key, value) {
  try { window.localStorage.setItem(key, String(value)); } catch (e) { /* ignore */ }
}
function lsGetJSON(key, dflt) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return dflt;
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : dflt;
  } catch (e) { return dflt; }
}
function lsSetJSON(key, obj) {
  try { window.localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * CONTRACT.md §7 — transcript merge rule (v1, frozen; kept for compatibility
 * and exercised by the self-test next to its replacement)
 * ------------------------------------------------------------------ */

function mergeStream(prevLines, nextLines) {
  const max = Math.min(prevLines.length, nextLines.length);
  for (let k = max; k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (prevLines[prevLines.length - k + i] !== nextLines[i]) { same = false; break; }
    }
    if (same) return { newLines: nextLines.slice(k), overlapped: true };
  }
  return { newLines: nextLines, overlapped: false };  // no overlap: render a "--- screen cleared ---" separator
}

/* ------------------------------------------------------------------ *
 * CONTRACT-v2 §0.1 — advanceBuffer.
 *
 * The algorithm lives in exactly one place now: public/lib/advance-buffer.js, loaded before
 * this file (index.html) so that it is the implementation this page polls with, the copy
 * public/lib/grid.js picks up as ctx.util.advanceBuffer, and the file the local test suite can
 * require() in Node next to the server twin src/hdr.js (W1). Its header documents the rules,
 * the 1r/1s improvements the round-2 DEFECT-1 fix needs, and why rule 2 appends
 * `next.slice(prev.length - p)` rather than the literal `next.slice(anchor.length)`.
 * ------------------------------------------------------------------ */

const advanceBuffer = (window.HD && typeof window.HD.advanceBuffer === 'function')
  ? window.HD.advanceBuffer
  : function missingAdvanceBuffer(prevLines, nextLines) {
      // defensive only — /lib/advance-buffer.js is loaded before this script. Keeps the
      // transcript alive (append the window) and names itself so the gap is visible.
      return { newLines: (nextLines || []).slice(), mode: 'append', rule: 'missing' };
    };

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

const POLL_MS = 1000;
const SNAPSHOT_MS = 5000;
const TRANSCRIPT_LINES = 1200;   // §0.1: was 400; the window must cover a realistic burst
const MAX_DOM_LINES = 2000;      // lines rendered into <pre>
const BUFFER_MAX = 20000;        // lines kept per pane in memory
const HISTORY_MAX = 50;
const MAX_OUT_BLOCKS = 200;
const TOAST_MS = 4200;
/* §3 load order, mirrored from index.html; gitview (round 5, §7.2, W3) is appended last.
   A module in this list that never loaded is simply skipped, so the missing file cannot break
   the page — and mountModules() reports what actually mounted in the header tag. */
const MODULE_ORDER = ['palette', 'search', 'fanout', 'keys', 'board', 'inbox', 'grid', 'timebar', 'gitview'];
const STATUSES = ['working', 'blocked', 'idle', 'done', 'unknown'];
const ROLLUP_PRIORITY = ['blocked', 'working', 'unknown', 'done', 'idle'];
const STATUS_RANK = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const state = {
  snapshot: null,
  selected: lsGet(LS.selected, '') || '',
  buffers: {},               // paneId -> {lines, revision, lastText, reads, lastPollAt}
  status: {},                // paneId -> last status we announced (dedupes the status event)
  autoScroll: true,
  pollInFlight: false,
  snapInFlight: false,
  es: null,
  sseLive: false,
  herdrStatus: '',
  collapsed: lsGetJSON(LS.trees, { workspaces: {}, tabs: {} }),
  history: [],
  histIdx: -1,
  snapTimer: null,
  booted: false,
  mods: {},                  // id -> module object
  mounted: {},               // id -> true
  unmounts: {},              // id -> fn
  moduleApi: {},             // id -> the object mount() returned (show/hide/toggle)
  keys: {},                  // id -> [{key, help}]
  seenPanes: {}              // paneId -> true (every pane this session has buffered)
};

try {
  const h = lsGetJSON(LS.history, []);
  if (Array.isArray(h)) state.history = h.filter(function (x) { return typeof x === 'string'; }).slice(0, HISTORY_MAX);
} catch (e) { state.history = []; }

/* ------------------------------------------------------------------ *
 * HTTP helper — never throws; always returns {ok:...}
 * ------------------------------------------------------------------ */

async function api(path, options) {
  const opt = options || {};
  let res;
  try {
    res = await fetch(path, opt);
  } catch (e) {
    return { ok: false, error: { code: 'network', message: 'request failed: ' + (e && e.message ? e.message : String(e)) } };
  }
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (body && typeof body === 'object') {
    if (typeof body.ok !== 'boolean') body.ok = res.ok;
    return body;
  }
  return { ok: false, error: { code: 'bad_response', message: 'HTTP ' + res.status + ' (not JSON)' } };
}

function errText(payload) {
  if (!payload) return 'unknown error';
  if (payload.error) {
    const code = payload.error.code ? payload.error.code + ': ' : '';
    return code + (payload.error.message || 'no message');
  }
  return 'request failed';
}

function postJSON(path, obj) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  });
}

/* ------------------------------------------------------------------ *
 * status helpers
 * ------------------------------------------------------------------ */

function normStatus(s) {
  const v = String(s == null ? '' : s).toLowerCase();
  return STATUSES.indexOf(v) >= 0 ? v : 'unknown';
}
function statusOf(pane) {
  if (!pane) return 'unknown';
  return normStatus(pane.agent_status);
}
function rollup(list) {
  let best = null;
  for (let i = 0; i < list.length; i++) {
    const s = normStatus(list[i].agent_status);
    if (best === null || ROLLUP_PRIORITY.indexOf(s) < ROLLUP_PRIORITY.indexOf(best)) best = s;
  }
  return best;
}
function statusRank(s) {
  const v = normStatus(s);
  return STATUS_RANK[v] === undefined ? 9 : STATUS_RANK[v];
}
function statusClass(s) { return 'st-' + normStatus(s); }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function fmtAge(ts) {
  if (!ts) return '-';
  const ms = Math.max(0, Date.now() - ts);
  if (ms < 1000) return ms + ' ms ago';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s ago';
  return Math.floor(ms / 60000) + ' m ' + pad2(Math.floor((ms % 60000) / 1000)) + ' s ago';
}
function fmtClock(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ *
 * snapshot lookup helpers
 * ------------------------------------------------------------------ */

function snap() { return (state.snapshot && typeof state.snapshot === 'object') ? state.snapshot : null; }
function workspaces() { const s = snap(); return (s && Array.isArray(s.workspaces)) ? s.workspaces : []; }
function tabsAll() { const s = snap(); return (s && Array.isArray(s.tabs)) ? s.tabs : []; }
function panesAll() { const s = snap(); return (s && Array.isArray(s.panes)) ? s.panes : []; }
function findPane(id) {
  const list = panesAll();
  for (let i = 0; i < list.length; i++) if (list[i] && list[i].pane_id === id) return list[i];
  return null;
}
function paneName(p) {
  if (!p) return '';
  return p.label || p.title || p.terminal_title_stripped || p.terminal_title || '';
}

/* ------------------------------------------------------------------ *
 * per-pane buffers (the client's transcript per pane)
 * ------------------------------------------------------------------ */

function bufferFor(paneId) {
  let b = state.buffers[paneId];
  if (!b) {
    b = { lines: [], revision: null, lastText: null, reads: 0, lastPollAt: 0 };
    state.buffers[paneId] = b;
    state.seenPanes[paneId] = true;
  }
  return b;
}
function seenPaneIds() {
  const out = [];
  for (const id in state.seenPanes) if (Object.prototype.hasOwnProperty.call(state.seenPanes, id)) out.push(id);
  return out;
}
function currentBuffer() { return state.selected ? state.buffers[state.selected] : null; }

/* ------------------------------------------------------------------ *
 * tiny event bus (CONTRACT-v2 §3: snapshot | select | buffer | status | sse + module types)
 * ------------------------------------------------------------------ */

const listeners = {};

function on(type, fn) {
  if (typeof type !== 'string' || typeof fn !== 'function') return function () {};
  if (!listeners[type]) listeners[type] = [];
  listeners[type].push(fn);
  return function () {
    const list = listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
}

function emit(type, payload) {
  const list = listeners[type];
  if (!list || !list.length) return;
  const copy = list.slice();
  for (let i = 0; i < copy.length; i++) {
    try { copy[i](payload); }
    catch (e) {
      // a broken listener must never break the app or the other listeners
      moduleProblem(type + ' listener', e);
    }
  }
}

function moduleProblem(what, e) {
  const msg = what + ' — ' + (e && e.message ? e.message : String(e));
  toast(msg, 'error');
}

/* ------------------------------------------------------------------ *
 * toasts + hint line (ctx.ui)
 * ------------------------------------------------------------------ */

let toastTimer = null;
function toast(message, kind) {
  const el = $('hdToast');
  if (!el) return;
  el.textContent = String(message == null ? '' : message);
  el.className = 'toast ' + (kind === 'error' ? 'err' : (kind === 'ok' ? 'ok' : 'info'));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(function () { el.classList.add('hidden'); }, TOAST_MS);
}
function setHint(text) { setText($('hHint'), text || ''); }
function overlayContainer() { return $('hdOverlays') || document.body; }

/* ------------------------------------------------------------------ *
 * sidebar tree
 * ------------------------------------------------------------------ */

function isCollapsed(kind, id) {
  const c = state.collapsed || {};
  const m = (kind === 'tab') ? c.tabs : c.workspaces;
  return !!(m && m[id]);
}
function setCollapsed(kind, id, val) {
  if (!state.collapsed) state.collapsed = { workspaces: {}, tabs: {} };
  const key = (kind === 'tab') ? 'tabs' : 'workspaces';
  if (!state.collapsed[key]) state.collapsed[key] = {};
  if (val) state.collapsed[key][id] = true; else delete state.collapsed[key][id];
  lsSetJSON(LS.trees, state.collapsed);
}

function rowEl(cls) { const d = document.createElement('div'); d.className = cls; return d; }
function span(cls, text) { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; return s; }
function dot(status) { const s = document.createElement('span'); s.className = 'dot ' + status; s.title = 'agent_status: ' + status; return s; }

function renderTree() {
  const host = $('sidebarBody');
  if (!host) return;
  host.textContent = '';

  const s = snap();
  if (!s) {
    const d = document.createElement('div');
    d.className = 'muted pad';
    d.textContent = 'no snapshot yet — waiting for /api/snapshot';
    host.appendChild(d);
    return;
  }

  const wss = workspaces();
  if (!wss.length) {
    const d = document.createElement('div');
    d.className = 'muted pad';
    d.textContent = 'no workspaces in snapshot';
    host.appendChild(d);
    return;
  }

  const tabs = tabsAll();
  const panes = panesAll();

  wss.forEach(function (w) {
    const wid = w.workspace_id;
    const wTabs = tabs.filter(function (t) { return t && t.workspace_id === wid; });
    const wPanes = panes.filter(function (p) { return p && p.workspace_id === wid; });
    const collapsed = isCollapsed('ws', wid);

    const wr = rowEl('ws-row');
    wr.title = 'workspace ' + wid;
    const wc = span('caret' + (collapsed ? '' : ' open'), collapsed ? '▸' : '▾');
    wr.appendChild(wc);
    wr.appendChild(span('mono n', '#' + (w.number != null ? w.number : '?') + ' ' + (w.label || wid)));
    wr.appendChild(span('mono dim small', '(' + wPanes.length + ')'));
    const wst = rollup(wPanes);
    if (wst) wr.appendChild(dot(wst));
    wr.addEventListener('click', function (ev) {
      ev.stopPropagation();
      setCollapsed('ws', wid, !collapsed);
      renderTree();
    });
    host.appendChild(wr);
    if (collapsed) return;

    wTabs.forEach(function (t) {
      const tid = t.tab_id;
      const tPanes = wPanes.filter(function (p) { return p && p.tab_id === tid; });
      const tCol = isCollapsed('tab', tid);

      const tr = rowEl('tab-row');
      tr.title = 'tab ' + tid;
      tr.appendChild(span('caret' + (tCol ? '' : ' open'), tCol ? '▸' : '▾'));
      tr.appendChild(span('mono n', 'tab ' + (t.number != null ? t.number : '?') + ' ' + (t.label || '')));
      tr.appendChild(span('mono dim small', '(' + tPanes.length + ')'));
      if (t.focused) tr.appendChild(span('focus-mark', '●'));
      const tst = rollup(tPanes);
      if (tst) tr.appendChild(dot(tst));
      tr.addEventListener('click', function (ev) {
        ev.stopPropagation();
        setCollapsed('tab', tid, !tCol);
        renderTree();
      });
      host.appendChild(tr);
      if (tCol) return;

      tPanes.forEach(function (p) {
        const pr = rowEl('pane-row' + (p.pane_id === state.selected ? ' selected' : ''));
        pr.title = 'pane ' + p.pane_id + (p.cwd ? '  cwd=' + p.cwd : '');
        pr.dataset.paneId = p.pane_id;                       // lib/fanout.js reads this
        pr.appendChild(dot(statusOf(p)));
        pr.appendChild(span('mono n', p.pane_id));
        if (p.agent) pr.appendChild(span('mono dim small', p.agent));
        const nm = paneName(p);
        if (nm) pr.appendChild(span('dim small n', nm));
        if (p.focused) pr.appendChild(span('focus-mark', '●'));
        pr.appendChild(span('badge', statusOf(p)));
        pr.addEventListener('click', function (ev) {
          ev.stopPropagation();
          selectPane(p.pane_id);
        });
        host.appendChild(pr);
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 * selection + header
 * ------------------------------------------------------------------ */

function selectPane(paneId) {
  if (!paneId || paneId === state.selected) return;
  state.selected = paneId;
  lsSet(LS.selected, paneId);
  state.autoScroll = true;
  bufferFor(paneId);
  clearErr($('transcriptError'));
  clearHighlight();
  renderTree();
  renderHeader();
  renderTranscript(true);
  emit('select', { pane_id: paneId, paneId: paneId });
  pollPane();
}

/* Pick a pane when nothing valid is selected (first load, or the pane disappeared). */
function pickDefaultPane() {
  if (state.selected && findPane(state.selected)) return;
  const panes = panesAll();
  const focused = panes.filter(function (p) { return p && p.focused; })[0];
  const next = focused || panes[0];
  if (!next) { state.selected = ''; renderHeader(); renderTranscript(true); return; }
  selectPane(next.pane_id);
}

function renderHeader() {
  const p = findPane(state.selected);
  setText($('hPane'), state.selected || 'no pane selected');
  setText($('hLabel'), p ? paneName(p) : '');
  setText($('hAgent'), p ? (p.agent || '-') : '-');
  setText($('hCwd'), p ? (p.cwd || p.foreground_cwd || '-') : '-');
  const st = p ? statusOf(p) : 'unknown';
  setText($('hStatus'), state.selected ? (p ? st : 'not in snapshot') : 'unknown');
  const d = $('hStatusDot');
  if (d) d.className = 'dot ' + st;
  renderUsage();                 // §12.2.2: a pane change re-evaluates the chip at once, not in 500ms
}

function renderAge() {
  const b = currentBuffer();
  setText($('hAge'), b ? fmtAge(b.lastPollAt) : '-');
}

/* ------------------------------------------------------------------ *
 * transcript
 * ------------------------------------------------------------------ */

function renderTranscript(force) {
  const pre = $('transcript');
  if (!pre) return;
  if (!state.selected) {
    pre.textContent = 'select a pane in the sidebar to stream its output.';
    return;
  }
  const b = state.buffers[state.selected];
  const lines = b ? b.lines : [];
  if (!force && !lines.length) {
    pre.textContent = 'waiting for first read of ' + state.selected + ' …';
    return;
  }
  pre.textContent = lines.length ? lines.slice(-MAX_DOM_LINES).join('\n')
                                 : 'waiting for first read of ' + state.selected + ' …';
  if (state.autoScroll) pre.scrollTop = pre.scrollHeight;
}

function appendToBuffer(b, newLines) {
  for (let i = 0; i < newLines.length; i++) b.lines.push(newLines[i]);
  if (b.lines.length > BUFFER_MAX) b.lines.splice(0, b.lines.length - BUFFER_MAX);  // keeps the live reference
}

async function pollPane() {
  const paneId = state.selected;
  if (!paneId || state.pollInFlight) return;
  state.pollInFlight = true;
  const b = bufferFor(paneId);
  const q = '/api/pane?pane_id=' + encodeURIComponent(paneId) +
            '&lines=' + TRANSCRIPT_LINES + '&source=recent_unwrapped';
  const body = await api(q);
  state.pollInFlight = false;

  if (!body.ok) {
    if (paneId === state.selected) {
      show($('transcriptError'), 'transcript (' + paneId + ') — ' + errText(body), 'err overlay');
    }
    return;
  }
  if (paneId === state.selected) clearErr($('transcriptError'));

  const text = (typeof body.text === 'string') ? body.text : '';
  const revision = (body.revision === undefined || body.revision === null) ? null : String(body.revision);

  // §0.1 "skip the merge when revision is unchanged". Measured against the live server:
  // /api/pane reports revision 0 on every read (even while the text changes), so gating on the
  // revision alone would freeze the transcript. Gate on revision AND byte-identical text:
  // an unchanged revision with changed text still merges; identical text never merges.
  if (b.reads > 0 && b.revision === revision && b.lastText === text) {
    b.lastPollAt = Date.now();
    if (paneId === state.selected) renderAge();
    return;
  }

  const nextLines = text.length ? text.split('\n') : [];
  const firstLoad = b.lines.length === 0;
  const adv = advanceBuffer(b.lines, nextLines);
  b.reads++;
  b.revision = revision;
  b.lastText = text;
  b.lastPollAt = Date.now();

  const cleared = (adv.mode === 'reset' && !firstLoad && nextLines.length > 0);
  if (cleared) appendToBuffer(b, ['--- screen cleared ---']);
  if (adv.newLines.length) appendToBuffer(b, adv.newLines);

  emit('buffer', {
    pane_id: paneId, paneId: paneId, mode: adv.mode, rule: adv.rule,
    lines: adv.newLines, buffer: b.lines, cleared: cleared
  });

  if (paneId !== state.selected) return;    // its buffer is updated; the view moved on
  if (firstLoad || cleared || adv.newLines.length) renderTranscript(true);
  else updateJumpButton();
  renderAge();
}

function updateJumpButton() {
  const pre = $('transcript');
  const btn = $('jumpLatest');
  if (!pre || !btn) return;
  const atBottom = (pre.scrollHeight - pre.scrollTop - pre.clientHeight) < 12;
  state.autoScroll = atBottom;
  if (atBottom) btn.classList.add('hidden'); else btn.classList.remove('hidden');
}

/* search highlight: a class on the wrapper + a scroll to the line. Cleared on selection change. */
let hlTimer = null;
function highlightLine(lineIndex) {
  const pre = $('transcript');
  const wrap = $('transcriptWrap');
  const b = currentBuffer();
  if (!pre || !wrap || !b) return;
  wrap.classList.add('hl-flash');
  window.clearTimeout(hlTimer);
  hlTimer = window.setTimeout(function () { wrap.classList.remove('hl-flash'); }, 1600);
  const total = b.lines.length;
  const shown = b.lines.slice(-MAX_DOM_LINES);
  const base = total - shown.length;
  const idx = Math.max(0, Math.min(shown.length - 1, lineIndex - base));
  let offset = 0;
  for (let i = 0; i < idx; i++) offset += shown[i].length + 1;
  state.autoScroll = false;
  try {
    const node = pre.firstChild;
    if (node && node.nodeType === 3) {
      const range = document.createRange();
      const len = node.nodeValue.length;
      range.setStart(node, Math.min(offset, len));
      range.setEnd(node, Math.min(offset + 1, len));
      const r = range.getBoundingClientRect();
      const pr = pre.getBoundingClientRect();
      pre.scrollTop += (r.top - pr.top) - (pre.clientHeight / 2);
      return;
    }
  } catch (e) { /* fall through to the simple estimate */ }
  pre.scrollTop = Math.max(0, idx * 18 - pre.clientHeight / 2);
}
function clearHighlight() {
  const wrap = $('transcriptWrap');
  if (wrap) wrap.classList.remove('hl-flash');
}

/* ------------------------------------------------------------------ *
 * snapshot
 * ------------------------------------------------------------------ */

function announceStatuses() {
  const panes = panesAll();
  for (let i = 0; i < panes.length; i++) {
    const p = panes[i];
    if (!p || !p.pane_id) continue;
    const st = statusOf(p);
    if (state.status[p.pane_id] !== st) {
      const from = state.status[p.pane_id] || null;
      state.status[p.pane_id] = st;
      emit('status', {
        pane_id: p.pane_id, paneId: p.pane_id,
        agent_status: st, status: st, from_status: from, fromStatus: from,
        pane: p, at: Date.now()
      });
    }
  }
}

async function refreshSnapshot() {
  if (state.snapInFlight) return;
  state.snapInFlight = true;
  const body = await api('/api/snapshot');
  state.snapInFlight = false;

  if (!body.ok) {
    show($('treeError'), 'snapshot — ' + errText(body), 'err');
    return;
  }
  clearErr($('treeError'));
  state.snapshot = body.snapshot || null;

  renderTree();
  renderHeader();
  emit('snapshot', { snapshot: state.snapshot, at: Date.now() });
  announceStatuses();
  pickDefaultPane();   // first load / stale selection -> focus the focused pane
}

function scheduleSnapshot() {
  if (state.snapTimer) return;
  state.snapTimer = window.setTimeout(function () {
    state.snapTimer = null;
    refreshSnapshot();
  }, 200);
}

/* ------------------------------------------------------------------ *
 * SSE
 * ------------------------------------------------------------------ */

const TOPOLOGY = /^(pane\.(created|closed|updated|focused|moved|exited)|tab\.(created|closed|moved|renamed|focused)|workspace\.[a-z_]+|layout\.updated|worktree\.[a-z_]+)$/;

function setLive(live, note) {
  const was = state.sseLive;
  state.sseLive = !!live;
  const d = $('liveDot');
  if (d) d.className = 'dot ' + (live ? 'live-on' : 'live-off');
  const parts = ['stream: ' + (live ? 'connected' : 'disconnected')];
  if (state.herdrStatus) parts.push('herdr: ' + state.herdrStatus);
  if (note) parts.push(note);
  setText($('liveText'), parts.join('  ·  '));
  if (was !== state.sseLive) emit('sse', { connected: state.sseLive, note: note || '', at: Date.now() });
}

function patchPaneStatus(paneId, status) {
  const st = normStatus(status);
  const list = panesAll();
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].pane_id === paneId) list[i].agent_status = st;
  }
  renderTree();
  if (paneId === state.selected) renderHeader();
  if (state.status[paneId] !== st) {
    const from = state.status[paneId] || null;
    state.status[paneId] = st;
    emit('status', {
      pane_id: paneId, paneId: paneId, agent_status: st, status: st,
      from_status: from, fromStatus: from, pane: findPane(paneId), at: Date.now()
    });
  }
}

function onDash(ev) {
  try {
    setLive(true);
    const msg = JSON.parse(ev.data);
    const name = msg && msg.event;
    const data = (msg && msg.data) || {};

    if (name === 'dash.status') {
      state.herdrStatus = data.herdr || '';
      setLive(true, data.error ? ('error: ' + data.error) : '');
      return;
    }
    if (name === 'dash.heartbeat') return;

    if (name === 'pane.agent_status_changed') {
      if (data.pane_id) patchPaneStatus(data.pane_id, data.agent_status);
      return;
    }
    if (TOPOLOGY.test(String(name))) { scheduleSnapshot(); return; }
    if (name === 'pane.scroll_changed' || name === 'pane.output_matched') return;
    scheduleSnapshot();
  } catch (e) {
    // a malformed frame must never break the stream
    setLive(true, 'bad frame');
  }
}

function connectEvents() {
  if (typeof window.EventSource !== 'function') {
    setLive(false, 'EventSource unsupported');
    return;
  }
  let es;
  try { es = new window.EventSource('/api/events'); }
  catch (e) { setLive(false, 'cannot open stream'); return; }
  state.es = es;
  es.onopen = function () { setLive(true); };
  es.onerror = function () { setLive(false, 'reconnecting…'); };  // EventSource retries on its own
  es.addEventListener('dash', onDash);
}

/* ------------------------------------------------------------------ *
 * prompt box
 * ------------------------------------------------------------------ */

function flashResult(ok, text) {
  const el = $('promptResult');
  if (!el) return;
  el.textContent = text;
  el.className = 'result ' + (ok ? 'ok' : 'err');
}
function needPane() {
  if (state.selected) return true;
  flashResult(false, 'no pane selected — click a pane in the sidebar first');
  return false;
}

/* CONTRACT-v2 §8.3: a sent prompt shows up in the chat view immediately as a PENDING bubble, and
   the structured log replaces it (with its real timestamp) when the record appears. The chat view
   owns that state; the send path only reports it — and never fails because of a module. */
function noteChatSend(paneId, text) {
  try {
    const cv = state.moduleApi.chatview;
    if (cv && typeof cv.notePending === 'function') cv.notePending(paneId, text);
  } catch (e) { /* a broken chat view must not break sending */ }
}

async function sendPrompt() {
  const ta = $('promptText');
  if (!ta || !needPane()) return;
  const typed = ta.value;
  /* CONTRACT-v2 §10.4/§10.5: the chat view owns the chips, so it owns the composed text. The send
     path never builds a block of its own, and a blocked send sends NOTHING — the reason is the
     module's own sentence, shown in the composer's result line and in its note beside the chips. */
  const cv = attachApi();
  const plan = (cv && typeof cv.composeSend === 'function')
    ? cv.composeSend(state.selected, typed)
    : { ok: true, text: typed, paths: [] };
  if (!plan || plan.ok !== true) {
    flashResult(false, (plan && plan.why) || 'sending is blocked — an attachment is not ready');
    return;
  }
  const text = plan.text;
  if (!text.length) { flashResult(false, 'nothing to send (empty prompt)'); return; }
  const wait = !!($('promptWait') && $('promptWait').checked);
  const payload = { pane_id: state.selected, text: text };
  if (wait) { payload.wait = true; payload.timeout_ms = 600000; }

  const btn = $('promptSend');
  if (btn) btn.disabled = true;
  flashResult(true, 'sending…');
  const body = await postJSON('/api/pane/prompt', payload);
  if (btn) btn.disabled = false;

  if (!body.ok) { flashResult(false, 'prompt failed — ' + errText(body)); return; }
  const r = body.result || {};
  flashResult(true, 'ok · ' + (r.type || 'prompted') +
    (r.agent && r.agent.agent_status ? ' · status: ' + r.agent.agent_status : ''));
  /* §8.3 + §10.4: the bubble carries what was SENT — the typed text and the attachment block — so the
     reader sees the paths the agent was given, in their own message, until the log confirms it. */
  noteChatSend(state.selected, text);
  ta.value = '';
  /* the chips are cleared only after the prompt really went out: an attachment that failed to send
     must never look sent, and the uploaded files stay on disk (§10.7: no cleanup this round) */
  if (plan.paths && plan.paths.length && cv && typeof cv.clearAttachments === 'function') {
    try { cv.clearAttachments(); } catch (e) { /* a broken chat view must not break sending */ }
  }
}

/* ------------------------------------------------------------------ *
 * CONTRACT-v2 §10 attachments — the composer's three input paths
 * ------------------------------------------------------------------ */

/* The chat view is the attachment engine (it owns the chips and the §10.4 block). It is reachable
   two ways: app.js's own moduleApi map and the handle the module publishes as window.HD.chatview. */
function attachApi() {
  try {
    const cv = state.moduleApi.chatview || (window.HD && window.HD.chatview) || null;
    return (cv && typeof cv.attachFiles === 'function') ? cv : null;
  } catch (e) { return null; }
}

/* One entry point for the picker, the drop and the paste, so all three land in exactly the same
   path. Never silent: every refusal is said out loud, and the module's own note (beside the chips)
   carries the per-file reason. */
function attachAccept(files, source) {
  const cv = attachApi();
  if (!cv) {
    flashResult(false, 'attachments need the chat view module (public/lib/chatview.js) — it is not mounted');
    return null;
  }
  if (!state.selected) {
    flashResult(false, 'no pane selected — click a pane in the sidebar before attaching a file');
    return null;
  }
  let r = null;
  try { r = cv.attachFiles(files, state.selected, { source: source || 'file' }); }
  catch (e) { flashResult(false, 'attach failed: ' + (e && e.message ? e.message : String(e))); return null; }
  const added = (r && r.added) || 0;
  const refused = (r && r.refused) || [];
  if (refused.length && !added) {
    flashResult(false, refused.length + ' file(s) refused — ' + refused[0].why +
      (refused.length > 1 ? ' (and ' + (refused.length - 1) + ' more)' : ''));
  } else if (added) {
    flashResult(true, added + ' file(s) sent to the app store — they upload now (§10.5: the send is ' +
      'blocked until every chip is ready)' + (refused.length ? ' · ' + refused.length + ' refused' : ''));
  }
  return r;
}

function wireAttachComposer() {
  /* whether the composer's line is currently carrying a failed upload's reason, so it is retired
     exactly once (see the on('attach') listener below) */
  let attachFailShown = false;
  const box = $('promptBox');
  const input = $('promptAttachInput');
  const open = $('promptAttachBtn');
  if (open && input) open.addEventListener('click', function () { input.click(); });
  if (input) input.addEventListener('change', function () {
    const list = input.files;
    if (list && list.length) attachAccept(list, 'picker');
    input.value = '';            // so the SAME file can be picked again right after
  });
  if (!box) return;
  /* a drop target needs dragover prevented or the drop event never fires; the class is removed on
     leave and on drop, and dragenter/dragleave are counted because they fire again for every child
     element the pointer crosses (a plain toggle flickers). */
  const hasFiles = function (e) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types && typeof dt.types.indexOf === 'function') {
      try { return dt.types.indexOf('Files') >= 0; } catch (err) { return true; }
    }
    return true;
  };
  let depth = 0;
  const unmark = function () { depth = 0; box.classList.remove('hd-cv-drop-active'); };
  const filesOf = function (dt) {
    const out = [];
    if (!dt) return out;
    if (dt.files && dt.files.length) {
      for (let i = 0; i < dt.files.length; i++) if (dt.files[i]) out.push(dt.files[i]);
      return out;
    }
    if (dt.items) {
      for (let i = 0; i < dt.items.length; i++) {
        const item = dt.items[i];
        if (item && item.kind === 'file' && item.getAsFile) {
          const f = item.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    return out;
  };
  box.addEventListener('dragenter', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth++; box.classList.add('hd-cv-drop-active');
  });
  box.addEventListener('dragover', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* read-only in some engines */ }
    box.classList.add('hd-cv-drop-active');
  });
  box.addEventListener('dragleave', function (e) {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) box.classList.remove('hd-cv-drop-active');
  });
  box.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();                          // a dropped file must not navigate the page
    unmark();
    const files = filesOf(e.dataTransfer);
    if (!files.length) { flashResult(false, 'the drop carried no file'); return; }
    attachAccept(files, 'drop');
  });
  /* §10.1: a paste of files (a screenshot, a copied file) is the third way in. Text pastes are left
     completely alone — this only acts when the clipboard really carries file items. */
  box.addEventListener('paste', function (e) {
    const dt = e.clipboardData;
    if (!dt || !dt.items) return;
    const files = filesOf(dt);
    if (!files.length) return;
    attachAccept(files, 'paste');
  });
  /* the send button follows the chips: §10.5 says a send is blocked while any chip is uploading or
     has failed, so the button is disabled with the module's own reason as its tooltip — and the send
     path checks again for real (a disabled button is an affordance, not the rule) */
  on('attach', function (info) {
    const btn = $('promptSend');
    if (!btn) return;
    btn.disabled = !!(info && info.blocked);
    btn.title = (info && info.reason) ? info.reason : '';
    /* §10.5: the moment a chip turns failed, the composer's own line must say so — it used to keep
       the acceptance sentence it flashed when the file was taken ("they upload now") while the
       server had already refused it (measured live 2026-09-25: a 26 MiB drop answered 413 while the
       line still read "they upload now"). The sentence is the module's own, so it carries the
       server's reason verbatim; and it is retired when the last failed chip goes, so the line never
       keeps saying something that has stopped being true. */
    if (info && info.failed > 0) {
      attachFailShown = true;
      flashResult(false, info.reason);
    } else if (attachFailShown) {
      attachFailShown = false;
      flashResult(true, 'the failed attachment is gone — nothing is blocking the send');
    }
  });
}

async function sendKeys(keys) {
  if (!needPane()) return;
  const body = await postJSON('/api/pane/keys', { pane_id: state.selected, keys: keys });
  if (!body.ok) { flashResult(false, 'keys failed — ' + errText(body)); return; }
  const r = body.result || {};
  flashResult(true, 'ok · ' + (r.type || ('keys ' + keys.join(' '))));
}

async function sendLiteral() {
  const inp = $('literalText');
  if (!inp || !needPane()) return;
  const text = inp.value;
  if (!text.length) { flashResult(false, 'nothing to send (empty text)'); return; }
  const body = await postJSON('/api/pane/text', { pane_id: state.selected, text: text });
  if (!body.ok) { flashResult(false, 'text failed — ' + errText(body)); return; }
  const r = body.result || {};
  flashResult(true, 'ok · ' + (r.type || 'text sent'));
  noteChatSend(state.selected, text);          // §8.3: literal text is a send too
  inp.value = '';
}

/* ------------------------------------------------------------------ *
 * console panel
 * ------------------------------------------------------------------ */

/* Shell-like splitter, deliberately simple and documented:
 *   - whitespace separates arguments
 *   - '...' and "..." group one argument; both quote styles are stripped
 *   - inside "..." a backslash escapes the next character; outside quotes a
 *     backslash escapes the next character too
 *   - no globbing, no variable expansion, no pipes/redirection (there is no shell:
 *     the argv array goes straight to spawn) */
function splitArgs(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; }
      else if (c === '\\' && quote === '"' && i + 1 < line.length) { cur += line[++i]; }
      else { cur += c; }
    } else if (c === ' ' || c === '\t') {
      if (has) { out.push(cur); cur = ''; has = false; }
    } else if (c === '\'' || c === '"') {
      quote = c; has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i]; has = true;
    } else {
      cur += c; has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

function outBlock(cmdLine, exitCode, stdout, stderr, extra) {
  const host = $('consoleOut');
  if (!host) return;
  const blk = document.createElement('div');
  blk.className = 'blk';

  const h = document.createElement('div');
  h.className = 'blk-cmd';
  h.textContent = '$ ' + cmdLine;
  blk.appendChild(h);

  if (extra) {
    const m = document.createElement('div');
    m.className = 'blk-meta';
    m.textContent = extra;
    blk.appendChild(m);
  }
  if (exitCode !== null && exitCode !== undefined) {
    const e = document.createElement('div');
    e.className = (exitCode === 0) ? 'blk-exit-ok' : 'blk-exit-bad';
    e.textContent = 'exit ' + exitCode;
    blk.appendChild(e);
  }
  if (stdout) {
    const so = document.createElement('div');
    so.textContent = stdout.replace(/\s+$/, '');
    blk.appendChild(so);
  }
  if (stderr) {
    const se = document.createElement('div');
    se.className = 'blk-err';
    se.textContent = stderr.replace(/\s+$/, '');
    blk.appendChild(se);
  }
  host.appendChild(blk);
  while (host.children.length > MAX_OUT_BLOCKS) host.removeChild(host.firstChild);
  host.scrollTop = host.scrollHeight;
}

function outError(cmdLine, message) {
  outBlock(cmdLine, null, '', message);
}

function pushHistory(line) {
  state.history = state.history.filter(function (x) { return x !== line; });
  state.history.unshift(line);
  if (state.history.length > HISTORY_MAX) state.history = state.history.slice(0, HISTORY_MAX);
  lsSetJSON(LS.history, state.history);
  renderHistory();
  state.histIdx = -1;
}

function renderHistory() {
  const host = $('cmdHistoryList');
  if (!host) return;
  host.textContent = '';
  state.history.forEach(function (line) {
    const b = document.createElement('span');
    b.className = 'hist';
    b.textContent = line;
    b.title = 'click to run again';
    b.addEventListener('click', function () { runCliLine(line); });
    host.appendChild(b);
  });
}

async function runCliLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return;
  let argv = splitArgs(raw);
  if (!argv.length) return;
  if (argv[0] === 'herdr') argv = argv.slice(1);
  if (!argv.length) return;

  const shown = '$ herdr ' + argv.join(' ');
  pushHistory(raw);
  outBlock(shown, null, '', '', 'running…');
  const placeholder = $('consoleOut') ? $('consoleOut').lastChild : null;
  if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);

  const body = await postJSON('/api/cli', { argv: argv, timeout_ms: 15000 });
  if (!body.ok) {
    outError(shown, 'cli failed — ' + errText(body) +
      (body.stdout ? '\nstdout:\n' + body.stdout : '') +
      (body.stderr ? '\nstderr:\n' + body.stderr : ''));
    return;
  }
  outBlock(shown, body.exit_code, body.stdout || '', body.stderr || '',
    (typeof body.duration_ms === 'number') ? ('took ' + body.duration_ms + ' ms') : '');
}

async function runRpc() {
  const inp = $('rpcInput');
  if (!inp) return;
  const raw = inp.value.trim();
  if (!raw) return;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { outError('$ rpc (raw)', 'invalid JSON: ' + (e && e.message ? e.message : String(e))); return; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.method !== 'string') {
    outError('$ rpc (raw)', 'JSON must be {"method":"...","params":{...}}');
    return;
  }
  const params = (parsed.params && typeof parsed.params === 'object') ? parsed.params : {};
  const shown = '$ rpc ' + parsed.method;
  outBlock(shown, null, '', '', 'sending…');
  if ($('consoleOut') && $('consoleOut').lastChild) $('consoleOut').removeChild($('consoleOut').lastChild);

  const body = await postJSON('/api/rpc', { method: parsed.method, params: params });
  if (!body.ok) { outError(shown, 'rpc failed — ' + errText(body)); return; }
  let pretty;
  try { pretty = JSON.stringify(body.result, null, 2); }
  catch (e) { pretty = String(body.result); }
  outBlock(shown, null, pretty, '');
}

/* ------------------------------------------------------------------ *
 * panel chrome: sidebar width/collapse, console collapse
 * ------------------------------------------------------------------ */

/* DEFECT-16 — the invariant is not "the restore button exists" (it did) but "a real click at its
   centre reaches it". This is that test, and applySidebar() refuses to stay collapsed without it. */
function restoreReachable() {
  return hitReachable($('sidebarToggleOpen'));   // hitReachable is defined below, in the §12 block
}
function applySidebar(forceOpen) {
  const sb = $('sidebar');
  const handle = $('sidebarResize');
  if (forceOpen) lsSet(LS.sidebar, '0');
  const collapsed = lsGet(LS.sidebar, '0') === '1';
  if (sb) sb.classList.toggle('collapsed', collapsed);
  if (handle) handle.classList.toggle('hidden', collapsed);
  const openBtn = $('sidebarToggleOpen');
  if (openBtn) openBtn.classList.toggle('hidden', !collapsed);
  const w = parseInt(lsGet(LS.width, '300'), 10);
  if (w >= 240) document.documentElement.style.setProperty('--sidebar-w', w + 'px');
  /* a stored `collapsed` that leaves no usable way back must not survive the page load */
  if (collapsed && !restoreReachable()) {
    lsSet(LS.sidebar, '0');
    applySidebar(true);
    if (ctx.ui && ctx.ui.setHint) ctx.ui.setHint('the sidebar was stored as collapsed with no way back — expanded it for you');
  }
}
function toggleSidebar() {
  const collapsed = lsGet(LS.sidebar, '0') === '1';
  lsSet(LS.sidebar, collapsed ? '0' : '1');
  applySidebar();
}
function applyConsole() {
  const collapsed = lsGet(LS.console, '0') === '1';
  const p = $('consolePanel');
  if (p) p.classList.toggle('collapsed', collapsed);
}
function toggleConsole() {
  const collapsed = lsGet(LS.console, '0') === '1';
  lsSet(LS.console, collapsed ? '0' : '1');
  applyConsole();
}

/* ------------------------------------------------------------------ *
 * CONTRACT-v2 §12.1 — the composer resizes from its TOP edge
 * ------------------------------------------------------------------ */

const PROMPT_MIN = 120;            // §12.1.2's floor, in px
const PROMPT_MAX_FRACTION = 0.6;   // §12.1.2's ceiling: 60% of the main area's height
/* §12.1 item 6 (frozen): the console has to be REACHABLE, not fully visible. What that buys is the
   console's own header plus at least one line of output, and its content then scrolls inside it —
   hence a strip of at most this many px may be reserved below the composer. */
const CONSOLE_STRIP = 64;
let promptHPref = (function () {   // the height the user last chose (null = never chosen: auto)
  const v = parseInt(lsGet(LS.promptH, ''), 10);
  return (isFinite(v) && v > 0) ? v : null;
})();
let promptDragging = false;        // while the top edge is under the pointer, the drag rules — not the
                                   // stored preference (the layout watcher below must not fight it)

/* The panel may never be dragged shorter than its own content. §12.1.3 requires a drag with
   attachment chips present to leave every chip uncovered, and a chip clipped by the panel's own
   overflow is a covered chip. `scrollHeight` cannot answer this: it never reports less than the
   current client height, so while the panel is tall it reports the tall height. The height has to be
   released for the one measurement. */
function promptContentFloor(box) {
  if (!box) return PROMPT_MIN;
  const had = box.style.getPropertyValue('--prompt-h');
  box.style.removeProperty('--prompt-h');
  const h = Math.ceil(box.getBoundingClientRect().height);
  if (had) box.style.setProperty('--prompt-h', had);
  return h;
}

/* §12.1.2's ceiling is 60% of the main area, but the composer is not the only thing #main holds: the
   console sits BELOW the panel and #main is a fixed-height flex column, so a height that leaves the
   console no room at all pushes it past the viewport's bottom edge (DEFECT-21: at a 622px viewport,
   --prompt-h 373 put the console at y=645 — off screen, and nothing could scroll to it).

   What fits is measured the same way as before — a sibling that cannot shrink keeps its own height, a
   sibling that can shrink is counted at its min-height — but the console now counts at its min-height
   too, because §12.1 item 6 lets it be reduced to a strip and scroll its own content (DEFECT-25: the
   first version reserved the console's FULL height, which at 1000x620 left the panel a range of
   163..163 — travel zero — and gutted the feature the user asked for). */
function promptFitCap(box) {
  const main = $('main');
  if (!main || !box) return Infinity;
  const cs = getComputedStyle(main);
  const gap = parseFloat(cs.rowGap) || 0;
  let rest = 0, n = 0;
  for (const el of main.children) {
    const c = getComputedStyle(el);
    if (c.display === 'none' || c.position === 'absolute' || c.position === 'fixed') continue;
    n++;
    if (el === box) continue;
    const minH = /px$/.test(c.minHeight) ? parseFloat(c.minHeight) : null;
    const shrinks = parseFloat(c.flexShrink) !== 0;
    rest += (shrinks && minH !== null) ? minH : el.getBoundingClientRect().height;
  }
  return Math.floor(main.clientHeight - rest - gap * Math.max(0, n - 1));
}

function promptLimits() {
  const main = $('main');
  const mainH = main ? main.getBoundingClientRect().height : 0;
  const cap60 = Math.round(mainH * PROMPT_MAX_FRACTION);
  /* §12.1 item 6 — the 60% ceiling stands. What fits is preferred; where that would cost the panel
     more than the console's own strip, the ceiling gives up the strip's 64px and no more (the column
     scrolls the rest of the way, which is #main's own backstop). `ceil` so the guarantee is the rule
     as written: the ceiling is never below 0.6 x the main area minus the strip. */
  const cap = Math.max(PROMPT_MIN, Math.min(cap60, promptFitCap($('promptBox'))),
    Math.ceil(mainH * PROMPT_MAX_FRACTION) - CONSOLE_STRIP);
  const floor = Math.max(PROMPT_MIN, promptContentFloor($('promptBox')));
  /* the content floor wins over the cap: an out-of-range value here would cover a chip, and §12.1.3
     forbids that outright — so in a window too short for both, the panel keeps its floor and #main
     (which may scroll, see #main's own rule) is what gives the console back. */
  return { min: floor, max: Math.max(cap, floor) };
}

const CONSOLE_STRIP_AT = 100;   // below this the console cannot hold its command row AND a line of output

/* §12.1 item 6 again, from the console's side: when the composer has taken the room the console needs,
   the console IS the strip — its header plus one line of its output, which is what the ruling calls
   "reachable". Two things follow, and both are the console's own height deciding them, never the
   composer's: the class below, and `#consoleBody`'s strip rules in style.css, where the body scrolls
   and the output is ordered to the top so the line on screen is output rather than the command row
   (the command row is then one scroll away, not gone). Drag the composer back down and the class
   drops off on the same measurement. */
function syncConsoleStrip() {
  const cons = $('consolePanel');
  if (!cons) return;
  const h = Math.ceil(cons.getBoundingClientRect().height);
  cons.classList.toggle('strip', h > 0 && h <= CONSOLE_STRIP_AT);
}

/* apply a height that is already the user's intent; returns what the panel actually got */
function setPromptH(px, remember) {
  const box = $('promptBox');
  if (!box) return 0;
  const lim = promptLimits();
  const h = Math.max(lim.min, Math.min(lim.max, Math.round(px)));
  box.style.setProperty('--prompt-h', h + 'px');
  if (remember) { promptHPref = h; lsSet(LS.promptH, h); }
  syncConsoleStrip();
  return h;
}

/* §12.1.4 — restored on load and re-clamped whenever the window changes size, so a smaller window
   can never leave an out-of-range height applied. The stored preference is NOT rewritten by the
   clamp: shrink the window and grow it again and the user's own height comes back. */
function applyPromptH() {
  if (promptHPref === null) return;
  setPromptH(promptHPref, false);
}

/* ------------------------------------------------------------------ *
 * CONTRACT-v2 §12.2 — the side dock's shell (the content inside it is W3's `dock` module)
 * ------------------------------------------------------------------ */

const DOCK_MIN = 260;              // §12.2.1's clamp
const DOCK_MAX = 640;
const DOCK_W_DEFAULT = 320;

/* DEFECT-16's invariant, generalised: "a way back that a REAL click can reach". Not "the button
   exists" — the button existed all along. */
function hitReachable(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 &&
        r.right <= window.innerWidth && r.bottom <= window.innerHeight)) return false;
  const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
  return !!hit && (hit === el || el.contains(hit));
}

function applyDockWidth() {
  const w = parseInt(lsGet(LS.dockW, ''), 10);
  if (isFinite(w) && w >= DOCK_MIN && w <= DOCK_MAX) {
    document.documentElement.style.setProperty('--dock-w', w + 'px');
  }
}

function applyDock(forceOpen) {
  const dock = $('dock');
  const handle = $('dockResize');
  if (forceOpen) lsSet(LS.dockOpen, '1');
  /* closed unless the user opened it: the default layout is the one every other check measures */
  const open = lsGet(LS.dockOpen, '0') === '1';
  if (dock) dock.classList.toggle('collapsed', !open);
  if (handle) handle.classList.toggle('hidden', !open);
  const t = $('dockToggle');
  if (t) {
    t.textContent = open ? '❯' : '❮';   // ❯ / ❮, like the sidebar's pair
    t.title = open ? 'd — collapse the dock'
                   : 'd — open the dock (the selected pane\'s usage + background processes)';
    t.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  applyDockWidth();
  /* the sidebar's self-heal, mirrored: a stored "closed" with no reachable way back must not
     survive the page load */
  if (!open && !hitReachable(t)) {
    lsSet(LS.dockOpen, '1');
    applyDock(true);
    if (ctx.ui && ctx.ui.setHint) ctx.ui.setHint('the dock was stored as closed with no way back — opened it for you');
  }
}

function toggleDock() {
  const open = lsGet(LS.dockOpen, '0') === '1';
  lsSet(LS.dockOpen, open ? '0' : '1');
  applyDock();
}

/* ------------------------------------------------------------------ *
 * CONTRACT-v2 §12.2.2 — the usage chip in the header
 * ------------------------------------------------------------------ */

/* Four times the dock module's §12.2.3 cadence (2s): an answer the module has not replaced in that
   long is not "current" and must not be shown as if it were. */
const USAGE_STALE_MS = 6000;
const USAGE_DASH = '—';       // —
let usageSeen = null;              // { answer, at } — the last answer the chip accepted, and when
let usageSummary = null;           // the module's own one-line summary for its newest answer

/* DEFECT-23: the chip's number must be the dock's number and the endpoint's number for the SAME
   answer. The endpoint answers in exact integers (87357, 144384), the dock prints them grouped
   (87,357) — the chip used to print them in a 1024-base bucket (85K), so the same live answer read
   85K in the header and 87,357 in the dock, and a chip that rounds to the nearest K looks frozen
   next to a dock that counts single tokens. These two formatters are dock.js's own group()/pcts()
   kept character-for-character identical on purpose: a reading aid must never become a second,
   disagreeing reading. */
/* dock.js's num(), guard for guard: `null` means "the agent printed nothing here" and must never
   become the number 0 — `Number(null)` is 0, so an absent `until_auto_compact_pct` would otherwise
   reach the chip as a confident "0% until auto-compact". */
function usageNum(v) {
  if (v === undefined || v === null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function group3(n) {
  const v = usageNum(n);
  return v === null ? null : String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function pct1(v) {
  const n = usageNum(v);
  return n === null ? null : (Math.round(n * 10) / 10) + '%';
}

/* the chip's own text for an answer, or null when the answer carries no usage to show. The two
   families are deliberately NOT rendered in the same shape: hermes prints used/limit and a bar
   percentage, claude prints a context size and its own "until auto-compact" figure, and §12.3.2
   says those two denominators must never be shown as if they were the same number.

   The shape mirrors the module's own summary (dock.js's summarize(), the one the dock paints from)
   so that the header and the panel cannot disagree about the same answer. */
function usageTextOf(ans) {
  const st = ans && ans.status;
  const cx = ans && ans.context;
  if (st && (st.model || st.used_tokens != null)) {
    const out = [];
    if (st.model) out.push(String(st.model));
    const u = group3(st.used_tokens), l = group3(st.limit_tokens);
    if (u !== null && l !== null) out.push(u + '/' + l);
    const p = pct1(st.used_pct);
    if (p !== null) out.push((st.approx ? '~' : '') + p);
    if (out.length) return out.join(' · ');
  }
  if (cx && cx.tokens != null) {
    const out = [];
    if (cx.model) out.push(String(cx.model));
    /* the `~` is the module's own mark on a count computed from claude's jsonl rather than printed
       by the agent (§12.3.2) — §12.3.1 forbids dropping it */
    out.push('~' + group3(cx.tokens) + ' tokens');
    const up = pct1(cx.until_auto_compact_pct);
    if (up !== null) out.push(up + ' until auto-compact');
    return out.join(' · ');
  }
  return null;
}

function usageAbsentReasons(ans) {
  const a = ans && ans.absent;
  if (!a || typeof a !== 'object') return '';
  const parts = [];
  for (const k in a) if (Object.prototype.hasOwnProperty.call(a, k)) parts.push(k + ': ' + a[k]);
  return parts.join('; ');
}

/* called on a timer, on every header render, and on every answer the module emits (DEFECT-23).
   Never innerHTML: the module's strings (model names, and the agent's own verbatim source lines)
   are data.

   The module's `latest()` is the last /api/status ANSWER (§12.2.3): `{ok, pane_id, at, body}` — the
   §12.3 body under `.body`, the arrival stamp under `.at` — or `{ok:false, pane_id, at, error}` when
   the read itself failed. A plain §12.3 body is accepted too, so the chip cannot be broken by a
   module that hands back the response unwrapped. */
function renderUsage() {
  const el = $('hUsage');
  if (!el) return null;
  const put = function (text, title, cls) {
    if (el.textContent !== text) el.textContent = text;
    if (el.title !== title) el.title = title;
    if (el.className !== cls) el.className = cls;
    return text;
  };
  const api = (ctx.modules && ctx.modules.api) ? ctx.modules.api('dock') : null;
  if (!api || typeof api.latest !== 'function') {
    usageSeen = null;
    usageSummary = null;
    return put(USAGE_DASH, 'usage: the dock module (id "dock") is not mounted — nothing is reading /api/status', 'mono dim');
  }
  let ans = null;
  try { ans = api.latest(); } catch (e) { ans = null; }
  if (!ans || typeof ans !== 'object') {
    usageSeen = null;
    usageSummary = null;
    return put(USAGE_DASH, 'usage: the dock module has no /api/status answer yet' +
      (state.selected ? ' for ' + state.selected : ''), 'mono dim');
  }
  /* the age of this ANSWER, not of the chip: an answer object that has not been replaced since the
     last tick is the same answer, however often it is read. The module stamps its answers, so the
     stamp is used when it is there; the fallback only covers a shape that does not carry one. */
  const at = (typeof ans.at === 'number' && isFinite(ans.at)) ? ans.at
    : ((usageSeen && usageSeen.answer === ans) ? usageSeen.at : Date.now());
  const age = Date.now() - at;
  usageSeen = { answer: ans, at: at };
  const ageS = Math.round(age / 1000);
  const sel = state.selected || '';
  if (ans.ok === false) {
    const err = ans.error || {};
    return put(USAGE_DASH, 'usage: the read for ' + (ans.pane_id || sel || 'the selected pane') + ' failed' +
      (err.message ? ' — ' + err.message : '') + (ageS ? ' (' + ageS + 's ago)' : '') +
      '; nothing is shown as current', 'mono dim');
  }
  if (ans.pane_id && ans.pane_id !== sel) {
    return put(USAGE_DASH, 'usage: the last answer is for ' + ans.pane_id + ', the selected pane is ' +
      (sel || 'none') + ' — not shown as current', 'mono dim');
  }
  if (age > USAGE_STALE_MS) {
    return put(USAGE_DASH, 'usage: the last answer for ' + (ans.pane_id || sel) + ' is ' + ageS +
      's old and has not been replaced within ' + (USAGE_STALE_MS / 1000) + 's — not shown as current', 'mono dim');
  }
  const body = (ans.body && typeof ans.body === 'object') ? ans.body : ans;
  /* DEFECT-23: the module hands a one-line summary over with every answer (the `dock` event) and
     paints the dock from that same summary. When the summary on hand belongs to THIS answer, its
     text is what the chip shows — chip ≡ dock then holds by construction rather than by two
     formatters happening to agree. The fallback below renders the same numbers the same way for a
     module that has not emitted (or a summary that predates this answer). */
  const sum = usageSummary;
  const text = (sum && sum.text && sum.at === at && (!sum.pane_id || sum.pane_id === ans.pane_id))
    ? String(sum.text)
    : usageTextOf(body);
  if (!text) {
    const why = usageAbsentReasons(body);
    return put(USAGE_DASH, 'usage: ' + (why || 'the answer carries neither a status line nor a context block'), 'mono dim');
  }
  const src = (body.status && body.status.source_line) || (body.context && body.context.source_line) || '';
  return put(text, 'usage: ' + (body.pane_id || ans.pane_id) + (src ? ' — ' + src : '') +
    '  (answer ' + ageS + 's old, ' + (body.family || 'unknown') + ')', 'mono');
}

/* ------------------------------------------------------------------ *
 * window.HD — the frozen module API (CONTRACT-v2 §3)
 * ------------------------------------------------------------------ */

const HD = (window.HD = window.HD || {});
HD.modules = HD.modules || {};

const ctx = {
  api: {
    /* Every method here resolves to the parsed JSON body and never rejects: HTTP errors and
       network failures come back as {ok:false, error:{code,message}} (see api() above), so a
       module can render the failure instead of crashing on it.
         snapshot()                     -> GET /api/snapshot
         pane(paneId, lines?)           -> GET /api/pane
         prompt(paneId, text, opts?)    -> POST /api/pane/prompt
         keys(paneId, keys)             -> POST /api/pane/keys
         sendText(paneId, text)         -> POST /api/pane/text
         cli(argv, opts?)               -> POST /api/cli
         rpc(method, params?)           -> POST /api/rpc
         fanout(paneIds, text, opts?)   -> POST /api/fanout
         broadcast(paneIds, keys)       -> POST /api/keys-broadcast
         git(opts?)                     -> GET /api/git          (CONTRACT-v2 §7.1, read-only)
           opts = {pane_id?, mode?, file?, max_lines?}
             pane_id    defaults to ctx.state.selectedPaneId; the SERVER takes the working
                        directory from herdr's own pane record, never from the client
             mode       'status' (default) | 'diff' — anything else is rejected by the server
             file       repo-relative path, diff mode only
             max_lines  diff mode only, default 400, hard cap 2000
           Resolves to the §7.1 body: {ok:true, pane_id, cwd, is_repo, repo:{toplevel,branch,head},
           files:[{path,status,staged,unstaged,untracked,added,deleted}], totals:{…}, truncated}
           — or, for a cwd that is not a repo / git missing, {ok:true, is_repo:false, error:{code,
           message}}, which is a described state and not a transport failure.
           With no pane selected nothing is fetched: {ok:false, error:{code:'no_pane', …}}.
         chat(opts?)                   -> GET /api/chat        (CONTRACT-v2 §8.2, read-only)
           opts = {pane_id?, since?, limit?}
             pane_id  defaults to ctx.state.selectedPaneId; the SERVER resolves the pane to its
                      agent session (claude jsonl / hermes sqlite) — the client never sends paths
             since    the previous response's `cursor` (byte offset for claude, row id for hermes)
             limit    page size (the chat view uses 200 while polling, 800 for "load older")
           Resolves to {ok:true, pane_id, agent, source:{kind, session_id, path}, cursor,
           messages:[{key, ts, role, kind, text, tool:{name, call_key, input, input_truncated,
           result, result_truncated, is_error, pending}, sidechain}], truncated, skipped,
           unknown_records} — or {ok:false, error:{code, …}} for every §8.1 failure
           (unsupported_agent, session_file_missing, session_db_missing, session_cwd_mismatch,
           pane_not_found, bad_request) and for a missing route, exactly like the other helpers.
           An empty session is a SUCCESS with messages: [] (code no_messages_yet). */
    snapshot: function () { return api('/api/snapshot'); },
    pane: function (paneId, lines) {
      const n = (lines === undefined || lines === null) ? TRANSCRIPT_LINES : lines;
      return api('/api/pane?pane_id=' + encodeURIComponent(paneId) + '&lines=' + encodeURIComponent(n) +
                 '&source=recent_unwrapped');
    },
    prompt: function (paneId, text, opts) {
      const payload = { pane_id: paneId, text: text };
      if (opts && typeof opts === 'object') {
        if (opts.wait !== undefined) payload.wait = !!opts.wait;
        if (opts.timeout_ms !== undefined) payload.timeout_ms = opts.timeout_ms;
      }
      return postJSON('/api/pane/prompt', payload);
    },
    keys: function (paneId, keys) { return postJSON('/api/pane/keys', { pane_id: paneId, keys: keys }); },
    /* CONTRACT-v2 §10.1: the one request whose body is not JSON — the body IS the file's bytes, its
       name travels in x-hd-name (already made header-safe by the caller: verbatim when ASCII,
       percent-encoded UTF-8 otherwise) and the destination pane in x-hd-pane. The client can never
       choose a path: the server answers with the absolute path it wrote, which is what gets sent to
       the agent. Resolves like every other helper here — {ok:true, path, bytes, name} or
       {ok:false, error:{code,message}} — and never rejects. */
    attachFile: function (paneId, headerSafeName, file) {
      return api('/api/attach', {
        method: 'POST',
        headers: { 'x-hd-name': String(headerSafeName == null ? '' : headerSafeName), 'x-hd-pane': String(paneId || '') },
        body: file
      });
    },
    sendText: function (paneId, text) { return postJSON('/api/pane/text', { pane_id: paneId, text: text }); },
    cli: function (argv, opts) {
      const payload = { argv: argv };
      payload.timeout_ms = (opts && typeof opts.timeout_ms === 'number') ? opts.timeout_ms : 15000;
      return postJSON('/api/cli', payload);
    },
    rpc: function (method, params) { return postJSON('/api/rpc', { method: method, params: params || {} }); },
    git: function (opts) {
      const o = opts || {};
      const paneId = (o.pane_id === undefined || o.pane_id === null || o.pane_id === '') ? state.selected : o.pane_id;
      if (!paneId) {
        return Promise.resolve({ ok: false, error: { code: 'no_pane', message: 'no pane selected — /api/git needs a pane_id' } });
      }
      const q = ['pane_id=' + encodeURIComponent(paneId)];
      if (o.mode) q.push('mode=' + encodeURIComponent(o.mode));
      if (o.file) q.push('file=' + encodeURIComponent(o.file));
      if (o.max_lines !== undefined && o.max_lines !== null) q.push('max_lines=' + encodeURIComponent(o.max_lines));
      return api('/api/git?' + q.join('&'));
    },
    chat: function (opts) {
      const o = opts || {};
      const paneId = (o.pane_id === undefined || o.pane_id === null || o.pane_id === '') ? state.selected : o.pane_id;
      if (!paneId) {
        return Promise.resolve({ ok: false, error: { code: 'no_pane', message: 'no pane selected — /api/chat needs a pane_id' } });
      }
      const q = ['pane_id=' + encodeURIComponent(paneId)];
      /* `since` is the previous cursor; it is omitted (not sent as empty) when the caller wants the
         whole session, which is how §8.3's "load older" re-request is expressed */
      if (o.since !== undefined && o.since !== null && o.since !== '') q.push('since=' + encodeURIComponent(o.since));
      if (o.limit !== undefined && o.limit !== null) q.push('limit=' + encodeURIComponent(o.limit));
      /* round 7.1: `tail=1` asks for the LAST `limit` records with the cursor at EOF, so a first
         load is one request instead of a walk from the beginning (§8.2 tail mode, W1). */
      if (o.tail) q.push('tail=1');
      /* an AbortSignal is passed straight through: chatview aborts a request the server never
         answered so that one stalled response cannot freeze the view (DEFECT-12) */
      return api('/api/chat?' + q.join('&'), o.signal ? { signal: o.signal } : undefined);
    },
    fanout: function (paneIds, text, opts) {
      const payload = { pane_ids: paneIds, text: text };
      if (opts && typeof opts === 'object') {
        if (opts.wait !== undefined) payload.wait = !!opts.wait;
        if (opts.timeout_ms !== undefined) payload.timeout_ms = opts.timeout_ms;
      }
      return postJSON('/api/fanout', payload);
    },
    broadcast: function (paneIds, keys) { return postJSON('/api/keys-broadcast', { pane_ids: paneIds, keys: keys }); }
  },
  state: {
    get selectedPaneId() { return state.selected || null; },
    get snapshot() { return state.snapshot; },
    panes: function () { return panesAll(); },
    pane: function (id) { return findPane(id); },
    buffer: function (paneId) {
      const b = state.buffers[paneId];
      return b ? b.lines : null;           // live reference
    },
    sse: { connected: false },             // live reference; kept in step by setLive()
    seenPanes: function () { return seenPaneIds(); }   // W2 extra: every pane buffered this session
  },
  events: { on: on, emit: emit },
  modules: {                             // W2 extra: call into a mounted module (palette/keys use it)
    ids: function () { return Object.keys(state.moduleApi); },
    api: function (id) { return state.moduleApi[id] || null; },
    toggle: function (id) {
      const api = state.moduleApi[id];
      if (api && typeof api.toggle === 'function') { api.toggle(); return true; }
      return false;
    }
  },
  ui: {
    selectPane: function (paneId) { selectPane(paneId); },
    toast: toast,
    setHint: setHint,
    container: overlayContainer,
    highlightLine: highlightLine,          // W2 extra: used by the cross-pane search
    clearHighlight: clearHighlight
  },
  util: {
    statusRank: statusRank,
    statusClass: statusClass,
    fmtAge: fmtAge,
    escapeHtml: escapeHtml,
    now: function () { return Date.now(); },
    advanceBuffer: advanceBuffer,          // W2 extra: public/lib/grid.js prefers this copy
    fmtClock: fmtClock,
    toast: toast
  }
};
HD.ctx = ctx;
ctx.state.sse = { get connected() { return state.sseLive; } };

/* modules call this; registrations from before app.js ran are already in HD.modules */
function register(mod) {
  if (!mod || typeof mod.id !== 'string' || !mod.id) return false;
  HD.modules[mod.id] = mod;
  if (state.booted) mountModule(mod.id, mod);
  return true;
}
HD.register = register;

/* collect the shortcuts modules advertise for the `?` overlay */
on('keys.register', function (payload) {
  try {
    if (!payload || !payload.id) return;
    const list = Array.isArray(payload.keys) ? payload.keys : [];
    state.keys[payload.id] = list.map(function (k) {
      if (k && typeof k === 'object') return { key: String(k.key == null ? '' : k.key), help: String(k.help == null ? '' : k.help) };
      return { key: String(k == null ? '' : k), help: String(payload.help == null ? '' : payload.help) };
    });
  } catch (e) { /* the overlay is optional */ }
});

function mountModule(id, mod) {
  if (state.mounted[id]) return;
  state.mounted[id] = true;
  try {
    const r = mod.mount(ctx);
    if (r && typeof r === 'object') state.moduleApi[id] = r;
    if (r && typeof r.unmount === 'function') state.unmounts[id] = r.unmount;
    /* DEFECT-3(c): the module handle is also reachable as window.HD.<id> — W3's modules (and the
       console) call window.HD.board.toggle() / .open() / .close(). A null return stays null-ish
       rather than clobbering a handle the module itself published under that name. */
    if (r !== undefined && (!(id in HD) || HD[id] == null || r)) HD[id] = r;
    /* a module that registers after boot (a late script, or a test) still shows up in the header
       module tag; during boot mountModules() writes it once at the end. */
    if (state.booted) updateModuleTag();
  } catch (e) {
    moduleProblem('module "' + id + '" failed to mount', e);
    const host = overlayContainer();
    if (host) {
      const d = document.createElement('div');
      d.className = 'mod-err';
      d.textContent = 'module "' + id + '" failed to mount: ' + (e && e.message ? e.message : String(e));
      host.appendChild(d);
    }
  }
}

/* the header module tag: the ids that actually mounted, in the §3 order. gitview (§7.2) is in
   MODULE_ORDER, so it appears here the moment public/lib/gitview.js lands — and its absence
   before that is simply not claimed. */
function updateModuleTag() {
  const ids = MODULE_ORDER.slice();
  for (const id in HD.modules) {
    if (Object.prototype.hasOwnProperty.call(HD.modules, id) && ids.indexOf(id) < 0) ids.push(id);
  }
  const present = ids.filter(function (id) { return !!state.mounted[id]; });
  setHint(present.length ? ('modules: ' + present.join(' ')) : 'no modules present');
  return present;
}

/* mount every module present, in the §3 order; missing files are simply skipped */
function mountModules() {
  const ids = MODULE_ORDER.slice();
  for (const id in HD.modules) {
    if (Object.prototype.hasOwnProperty.call(HD.modules, id) && ids.indexOf(id) < 0) ids.push(id);
  }
  state.booted = true;              // set before the loop so a module that mounts late is still tagged
  for (let i = 0; i < ids.length; i++) {
    const mod = HD.modules[ids[i]];
    if (mod && typeof mod.mount === 'function') mountModule(ids[i], mod);
  }
  updateModuleTag();
}

/* ------------------------------------------------------------------ *
 * self-test (?selftest=1) — CONTRACT-v2 §0.1
 * Runs the five v1 §7 expectations, the four advanceBuffer rules and the
 * scrolling regression in the browser and prints PASS/FAIL into #transcript.
 * ------------------------------------------------------------------ */

function runSelfTest() {
  const out = [];
  let pass = 0, fail = 0;
  function line(s) { out.push(s); }
  function check(name, ok, detail) {
    if (ok) { pass++; line('PASS  ' + name); }
    else { fail++; line('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
  }
  function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  line('herdr-dash self-test — ?selftest=1');
  line('checks: five CONTRACT.md §7 merge expectations, the CONTRACT-v2 §0.1 advanceBuffer');
  line('        rules (the shipped /lib/advance-buffer.js copy), and the scrolling regression');
  line('        (5,000-line stream, 400- and 1,200-line windows)');
  line('');

  /* ---- the shared copy is the one under test ---- */
  line('-- REFACTOR-1: one copy of advanceBuffer, loaded before app.js --');
  check('/lib/advance-buffer.js loaded (window.HD.advanceBuffer is a function, and the one app.js polls with)',
    typeof window.HD.advanceBuffer === 'function' && advanceBuffer === window.HD.advanceBuffer,
    'typeof=' + typeof window.HD.advanceBuffer + ' identical=' + (advanceBuffer === window.HD.advanceBuffer));
  check('modules get the same copy as ctx.util.advanceBuffer',
    ctx.util.advanceBuffer === window.HD.advanceBuffer,
    'ctx.util.advanceBuffer === ' + (ctx.util.advanceBuffer === window.HD.advanceBuffer));

  /* ---- five v1 §7 expectations ---- */
  line('-- CONTRACT.md §7 mergeStream: five expectations --');
  const merge = [
    ['(i)   [A,B,C]+[A,B,C,D] -> newLines [D], overlapped true', ['A', 'B', 'C'], ['A', 'B', 'C', 'D'], ['D'], true],
    ['(ii)  [A,B,C]+[B,C,D]   -> newLines [D], overlapped true', ['A', 'B', 'C'], ['B', 'C', 'D'], ['D'], true],
    ['(iii) [A,B,C]+[X,Y]     -> newLines [X,Y], overlapped false', ['A', 'B', 'C'], ['X', 'Y'], ['X', 'Y'], false],
    ['(iv)  []+[A]            -> newLines [A], overlapped false', [], ['A'], ['A'], false],
    ['(v)   [A,B,C] identical -> newLines [], overlapped true', ['A', 'B', 'C'], ['A', 'B', 'C'], [], true]
  ];
  for (let i = 0; i < merge.length; i++) {
    const c = merge[i];
    let got = null, threw = null;
    try { got = mergeStream(c[1], c[2]); } catch (e) { threw = e; }
    check(c[0], !threw && !!got && eq(got.newLines, c[3]) && got.overlapped === c[4],
      threw ? ('threw ' + threw.message) : ('got ' + JSON.stringify(got)));
  }

  /* ---- the advanceBuffer rules ---- */
  line('');
  line('-- CONTRACT-v2 §0.1 advanceBuffer: rules 4 / 1 / 1r / 1s / 2 / 3 --');
  const K = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const fillers = [];
  for (let i = 0; i < 5000; i++) fillers.push('filler-' + i + ' ' + (i * 7919 % 9973));
  const rules = [
    ['rule 4 empty prev -> whole window, append', [], ['A'], ['A'], 'append'],
    ['rule 1 exact tail overlap [A,B,C]+[A,B,C,D] -> [D] append', K.slice(0, 3), K.slice(0, 4), ['D'], 'append'],
    ['rule 1r repainted row tolerated (1 of 100) -> [NEW] append',
      ['A', 'B', 'C'].concat(new Array(97).fill('z')), ['A', 'B', 'X'].concat(new Array(97).fill('z'), ['NEW']), ['NEW'], 'append'],
    ['rule 1s anchor mid-buffer, window head never shown -> [I,J] append', K.slice(0, 8).concat(['Z']), K.slice(0, 10), ['I', 'J'], 'append'],
    /* rule 2's corrected formula: the buffer already covers prev.length - p of the window, which
       here is all of it -> append nothing (the literal next.slice(anchor.length) appended I,J). */
    ['rule 2 anchor at buffer start, buffer covers the window -> [] append',
      K.slice(0, 8).concat(fillers), K.slice(0, 10), [], 'append'],
    ['rule 3 no overlap and no anchor -> whole window, reset', ['A', 'B', 'C'], ['X', 'Y', 'Z'], ['X', 'Y', 'Z'], 'reset']
  ];
  for (let i = 0; i < rules.length; i++) {
    const c = rules[i];
    let got = null, threw = null;
    try { got = advanceBuffer(c[1], c[2]); } catch (e) { threw = e; }
    check(c[0], !threw && !!got && eq(got.newLines, c[3]) && got.mode === c[4],
      threw ? ('threw ' + threw.message) : ('got mode=' + (got && got.mode) + ' rule=' + (got && got.rule) +
        ' newLines=' + JSON.stringify(got && got.newLines)));
  }

  /* ---- the scrolling regression ---- */
  line('');
  line('-- CONTRACT-v2 §0.1 scrolling regression: 5,000-line stream --');
  const SRC_N = 5000;
  const LVL = ['info', 'warn', 'debug'];
  const SRC = [];
  for (let i = 0; i < SRC_N; i++) {
    SRC.push(pad2(Math.floor(i / 3600)) + ':' + pad2(Math.floor(i / 60) % 60) + ':' + pad2(i % 60) + '.' + String(i * 7 % 1000).padStart(3, '0') +
             ' [' + LVL[i % 3] + '] tool_use step=' + i + ' args={"n":' + (i * 7919 % 9973) + '} result=' + (i * 104729 % 8999));
  }
  const FOOT = ['❯ ', '  status: idle   tokens: 12.3k', '  ───────────────────────────',
                '  ctrl+c to interrupt', '  /help for commands', '  model: claude-sonnet-5'];
  const CHROME = 7;   // spinner row + 6 pinned footer rows of a TUI pane
  const isSrc = function (l) { return /^\d\d:\d\d:\d\d\./.test(l); };

  /* windows for a walk: TUI panes keep a pinned bottom region (which a TUI repaints in place) */
  function walk(Wn, step, tui, ticks) {
    const srcRows = Wn - (tui ? CHROME : 0);
    const windows = [];
    for (let t = 0; t < ticks; t++) {
      const emitted = srcRows + t * step;
      if (emitted > SRC_N) break;
      const body = SRC.slice(emitted - srcRows, emitted);
      windows.push(tui ? body.concat(['✽ Working… (3m ' + (20 + t) + 's)'], FOOT) : body);
    }
    return { windows: windows, srcRows: srcRows };
  }

  function accumulate(algo, windows) {
    let buf = [];
    for (let i = 0; i < windows.length; i++) {
      const r = algo(buf, windows[i]);
      if (r.newLines && r.newLines.length) buf = buf.concat(r.newLines);
    }
    return buf;
  }

  function v1Rule(prev, next) {          // the round-1 rule, for contrast
    const max = Math.min(prev.length, next.length);
    for (let k = max; k > 0; k--) {
      let same = true;
      for (let i = 0; i < k; i++) if (prev[prev.length - k + i] !== next[i]) { same = false; break; }
      if (same) return { newLines: next.slice(k) };
    }
    return { newLines: next.slice() };
  }

  function regression(label, Wn, step, tui, ticks) {
    const w = walk(Wn, step, tui, ticks || SRC_N);
    const expected = SRC.slice(0, w.srcRows + (w.windows.length - 1) * step);
    const buf = accumulate(advanceBuffer, w.windows);
    const src = buf.filter(isSrc);
    const distinct = new Set(src).size;
    const sameOrder = src.length === expected.length && src.every(function (l, i) { return l === expected[i]; });
    check('walk ' + label + ': accumulated buffer equals the source exactly (' +
          src.length + ' lines, same order, no repeats)',
      sameOrder && distinct === src.length,
      'src=' + src.length + '/' + expected.length + ' distinct=' + distinct + ' repeats=' + (src.length - distinct));
    const v1 = accumulate(v1Rule, w.windows).filter(isSrc);
    if (tui) {
      check('walk ' + label + ': the v1 rule reproduces DEFECT-1 on the same windows (' +
            v1.length + ' lines for ' + expected.length + ')', v1.length > expected.length * 2,
        'v1 produced ' + v1.length + ' lines');
    }
    return { expected: expected.length, ours: src.length, v1: v1.length };
  }

  // plain walks: the whole 5,000-line stream, both window sizes
  const rPlain = regression('400-line window, plain appending pane (whole stream)', 400, 1, false);
  const rPlain1200 = regression('1,200-line window, plain appending pane (whole stream)', 1200, 1, false);
  // TUI walks: pinned chrome + in-place repaints (the DEFECT-1 shape), 700 polls each
  const r400 = regression('400-line window, scrolling TUI pane', 400, 1, true, 700);
  const r1200 = regression('1,200-line window, scrolling TUI pane', 1200, 1, true, 700);
  const rStep = regression('400-line window, TUI pane scrolling 7 rows/poll', 400, 7, true, 700);

  /* idle TUI pane: the window must not inflate (measured DEFECT-1 shape) */
  line('');
  line('-- DEFECT-1 shape measured on the live server: an idle TUI repaints one row per poll --');
  const idle = walk(400, 0, true, 120);
  const idleBuf = accumulate(advanceBuffer, idle.windows);
  const v1Idle = accumulate(v1Rule, idle.windows);
  check('idle 400-line TUI window over ' + idle.windows.length + ' polls: buffer stays at the window size (' +
        idleBuf.length + ' lines)', idleBuf.length === 400, idleBuf.length + ' lines');
  check('idle: the v1 rule inflates the same window (' + v1Idle.length + ' lines for 120 polls)',
    v1Idle.length > 400 * 10, v1Idle.length + ' lines');

  line('');
  line('regression summary: plain 400-window ' + rPlain.ours + '/' + rPlain.expected + ', ' +
       'plain 1200-window ' + rPlain1200.ours + '/' + rPlain1200.expected + ', ' +
       'TUI 400-window ' + r400.ours + '/' + r400.expected + ' (v1 rule ' + r400.v1 + '), ' +
       'TUI 1200-window ' + r1200.ours + '/' + r1200.expected + ' (v1 rule ' + r1200.v1 + '), ' +
       'TUI step7 ' + rStep.ours + '/' + rStep.expected + ' (v1 rule ' + rStep.v1 + ')');
  /* ---- CONTRACT-v2 §8.3: the chat view (pending sends, honest states, the `t` toggle) ----
     The cases drive the SHIPPED module through window.HD.chatviewTest, which feeds the very same
     functions the network path calls (ingest / notePending / the pending clock). Polling is turned
     off for the run (setAuto(false)) so nothing here depends on the server having /api/chat yet. */
  line('');
  line('-- CONTRACT-v2 §8.3 chat view: pending sends, honest states, the t toggle --');
  const CHAT_LS = 'herdrDash.transcriptView';
  const promo = state.selected;
  try {
    const chatMod = HD.modules.chatview;
    check('lib/chatview.js registered (id chatview) and exposes show/hide/toggle/mounted/state/unmount',
      !!(chatMod && typeof chatMod.mount === 'function' && window.HD.chatviewTest),
      'module=' + typeof chatMod + ' testApi=' + typeof window.HD.chatviewTest);

    if (chatMod) {
      mountModule('chatview', chatMod);
      const chat = window.HD.chatviewTest;
      const api = state.moduleApi.chatview;
      const lsBefore = window.localStorage.getItem(CHAT_LS);
      chat.setAuto(false);                       // hermetic: no timer, no fetch
      chat.setPane('selftest:p1');               // test-only pane override
      let dom = chat.dom();
      const pendNodes = function () { return document.querySelectorAll('#hdChatScroll .chat-pending'); };

      /* (a) a sent prompt is pending, then replaced by the real record */
      chat.pending('selftest:p1', 'selftest: hello from the prompt box');
      const shown = pendNodes();
      check('(a) a sent prompt shows immediately as a pending bubble with the waiting note',
        shown.length === 1 && /waiting for the agent's log/.test(shown[0].textContent),
        'nodes=' + shown.length + ' text=' + JSON.stringify(shown[0] ? shown[0].textContent : ''));
      const tsReal = Date.now();
      chat.ingest('selftest:p1', {
        ok: true, pane_id: 'selftest:p1', agent: 'claude',
        source: { kind: 'claude_jsonl', session_id: 'selftest-session', path: 'C:/tmp/selftest.jsonl' },
        cursor: 4096, truncated: false, skipped: 0, unknown_records: 0,
        messages: [
          { key: 's1', ts: tsReal - 5000, role: 'user', kind: 'text', text: 'selftest: hello from the prompt box', sidechain: false },
          { key: 's2', ts: tsReal, role: 'assistant', kind: 'text', text: 'selftest: acknowledged', sidechain: false }
        ]
      });
      check('(a) the real record replaces the pending bubble (one bubble, not two)',
        pendNodes().length === 0 && /acknowledged/.test(dom.scroll.textContent) &&
        (dom.scroll.textContent.match(/hello from the prompt box/g) || []).length === 1,
        'pending=' + pendNodes().length + ' userBubbles=' +
        (dom.scroll.textContent.match(/hello from the prompt box/g) || []).length);
      check('(a) the record kept the log\'s own timestamp (not the send time)',
        chat.messages('selftest:p1').some(function (m) { return m.key === 's1' && m.ts === tsReal - 5000; }),
        JSON.stringify(chat.messages('selftest:p1').map(function (m) { return m.key + '@' + m.ts; })));

      /* (b) a prompt that never lands in the log keeps its bubble and says so after 20 s */
      chat.pending('selftest:p1', 'selftest: a prompt that never reaches the log');
      const lost = chat.tick(Date.now() + 21000);
      const still = Array.from(pendNodes()).filter(function (n) { return /never reaches the log/.test(n.textContent); });
      check('(b) after 20 s the pending bubble is still there with the explicit note',
        lost === true && still.length === 1 &&
        still[0].textContent.indexOf("not found in this agent's log — sent to the terminal; press t for the raw view") >= 0,
        'nodes=' + still.length + ' text=' + JSON.stringify(still[0] ? still[0].textContent : ''));

      /* (c) a log-format change must be visible, not look like lost history */
      chat.ingest('selftest:p1', {
        ok: true, cursor: 8192, truncated: false, skipped: 7, unknown_records: 3,
        messages: [{ key: 's3', ts: Date.now(), role: 'assistant', kind: 'tool_call', text: '',
                     tool: { name: 'Bash', call_key: 'c1', input: { command: 'ls' }, pending: true } }]
      });
      check('(c) unknown_records > 0 is surfaced ("this log format may have changed")',
        dom.status.textContent.indexOf('3 records of an unknown type (this log format may have changed)') >= 0,
        JSON.stringify(dom.status.textContent));
      /* the card class comes from whichever renderer is in the tree: ChatRender's .hd-cv-card,
         or the built-in fallback's .chat-tool when lib/chat-render.js is absent */
      const toolCard = document.querySelector('#hdChatScroll .hd-cv-card, #hdChatScroll .chat-tool');
      check('(c) skipped records and the cursor are shown too, and a tool call renders as a card',
        dom.status.textContent.indexOf('7 records skipped') >= 0 &&
        dom.status.textContent.indexOf('cursor 8192') >= 0 && !!toolCard,
        JSON.stringify(dom.status.textContent) + ' card=' + (toolCard ? toolCard.className : 'none'));

      /* (d) `t` toggles chat ↔ raw, is persisted, and does not fire while typing.
         The stored preference is the user's, so the case starts from an explicit state instead of
         assuming one — a previous session may have left `raw` in localStorage. */
      api.show();
      const dStart = api.viewMode();
      document.getElementById('promptText').dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }));
      check('(d) t does not fire while the user types in the prompt box',
        api.viewMode() === 'chat' && dStart === 'chat', 'mode=' + api.viewMode());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }));
      check('(d) t switches to the raw terminal view (chat host hidden, #transcript back)',
        api.viewMode() === 'raw' && dom.host.classList.contains('hidden') &&
        !document.getElementById('transcript').classList.contains('hidden'),
        'mode=' + api.viewMode() + ' hostHidden=' + dom.host.classList.contains('hidden'));
      check('(d) the choice is persisted in localStorage ' + CHAT_LS,
        window.localStorage.getItem(CHAT_LS) === 'raw', 'stored=' + JSON.stringify(window.localStorage.getItem(CHAT_LS)));
      api.unmount();
      const api2 = chatMod.mount(ctx);
      dom = chat.dom();   // a remount builds a NEW host: the old element is detached, so re-bind
      check('(d) a remount reads the persisted choice back (raw)', api2.viewMode() === 'raw',
        'mode=' + api2.viewMode());
      api2.show();
      check('(d) t also switches back to the chat view', api2.viewMode() === 'chat' && api2.state().visible === true,
        'mode=' + api2.viewMode());
      /* the remount is a fresh instance: point it back at the test pane for the (e) cases */
      chat.setPane('selftest:p1');

      /* (e) every error renders its own readable explanation — never a blank panel */
      const codes = ['unsupported_agent', 'session_file_missing', 'session_db_missing',
                     'session_cwd_mismatch', 'pane_not_found', 'bad_request', 'not_found', 'network'];
      const seen = [];
      for (let i = 0; i < codes.length; i++) {
        chat.ingest('selftest:p1', { ok: false, error: { code: codes[i], message: 'server said ' + codes[i] } });
        seen.push(chat.dom().state.textContent);
      }
      check('(e) all ' + codes.length + ' §8.1 errors render a non-empty explanation',
        seen.every(function (s) { return s && s.length > 20; }),
        JSON.stringify(seen.map(function (s) { return s.slice(0, 24); })));
      check('(e) the explanations are distinct (no catch-all text)',
        new Set(seen).size === codes.length, 'distinct=' + new Set(seen).size);
      check('(e) the failing states point at t (the raw terminal stays one key away)',
        /press t for the raw terminal view/.test(seen[0]) && /press t/.test(seen[1]) &&
        /press t/.test(seen[3]) && /press t/.test(seen[6]) && /press t/.test(seen[7]),
        JSON.stringify(seen[0].slice(0, 80)));
      chat.ingest('selftest:p1', { ok: true, cursor: 9, messages: [], skipped: 0, unknown_records: 0,
                                   error: { code: 'no_messages_yet', message: 'empty session' } });
      check('(e) no_messages_yet is a success state, not an error',
        /no messages in this session yet/.test(chat.dom().state.textContent),
        JSON.stringify(chat.dom().state.textContent));
      check('(e) the view is not an overlay (keys.js never sees it as one: Esc containment unaffected)',
        !document.querySelector('#chatHost').matches(
          '#hdPalette, #hdHelp, #hdSearch, #hdFanout, .hd-board, .hd-inbox, .hd-grid, [data-hd-overlay]'),
        'classes=' + document.querySelector('#chatHost').className);

      /* (f) A1 — a turn renders as ONE group: the prompt at its head, the agent's records as
         segments in log order, the closing assistant text as the reply. */
      chat.setPane('selftest:p2');
      chat.setStatus('selftest:p2', 'idle');
      const turns = function () {
        return document.querySelectorAll('#hdChatScroll .hd-cv-turn');
      };
      const t0 = Date.now() - 40000;
      chat.ingest('selftest:p2', { ok: true, pane_id: 'selftest:p2', agent: 'claude', cursor: 100,
        truncated: false, skipped: 0, unknown_records: 0, messages: [
          { key: 'f1', ts: t0, role: 'user', kind: 'text', text: 'selftest: one prompt', sidechain: false },
          { key: 'f2', ts: t0 + 1000, role: 'assistant', kind: 'thinking', text: 'weighing the options' },
          { key: 'f3', ts: t0 + 2000, role: 'assistant', kind: 'tool_call', text: '',
            tool: { name: 'Read', call_key: 'x1', input: { file_path: 'public/app.js' }, pending: true } },
          { key: 'f4', ts: t0 + 3000, role: 'assistant', kind: 'text', text: 'selftest: the closing reply' }
        ] });
      check('(f) a prompt + its records are ONE turn group, not four bubbles',
        turns().length === 1, 'turns=' + turns().length + ' text=' + JSON.stringify(dom.scroll.textContent.slice(0, 60)));
      check('(f) the turn keeps log order (prompt, thinking, tool card, reply) and marks the reply',
        /one prompt[\s\S]*weighing the options[\s\S]*public\/app\.js[\s\S]*the closing reply/.test(dom.scroll.textContent),
        JSON.stringify(dom.scroll.textContent.slice(0, 160)));
      check('(f) the turn group carries data-turn (the record span it was built from)',
        turns().length === 1 && turns()[0].getAttribute('data-turn') === '0-4',
        'data-turn=' + (turns()[0] ? turns()[0].getAttribute('data-turn') : 'none'));

      /* A1 rule 1 — progressive: each poll draws what has landed, mid-turn, without waiting */
      chat.ingest('selftest:p2', { ok: true, cursor: 200, truncated: false, skipped: 0, unknown_records: 0,
        messages: [{ key: 'f5', ts: t0 + 4000, role: 'assistant', kind: 'text', text: 'selftest: more coming' }] });
      check('(f) a record that arrives mid-turn is drawn at once (still ONE group)',
        turns().length === 1 && /more coming/.test(dom.scroll.textContent) &&
        turns()[0].getAttribute('data-turn') === '0-5',
        'turns=' + turns().length + ' data-turn=' + (turns()[0] ? turns()[0].getAttribute('data-turn') : 'none'));
      /* A record that never got a prompt of its own must not start a turn of its own, either */
      chat.ingest('selftest:p2', { ok: true, cursor: 300, truncated: false, skipped: 0, unknown_records: 0,
        messages: [{ key: 'f6', ts: t0 + 5000, role: 'user', kind: 'text', text: 'selftest: a second prompt' },
                   { key: 'f7', ts: t0 + 6000, role: 'assistant', kind: 'text', text: 'selftest: second reply' }] });
      check('(f) the next prompt starts the next turn',
        turns().length === 2, 'turns=' + turns().length);
      /* switching panes must take the previous pane's records off the screen (the DOM is per-pane
         state, and a leftover bubble reads as "this pane said that") */
      check('(f) selecting another pane leaves none of the previous pane\'s records on screen',
        dom.list.textContent.indexOf('selftest: hello from the prompt box') < 0 &&
        dom.list.textContent.indexOf('acknowledged') < 0,
        JSON.stringify(dom.list.textContent.slice(0, 70)));

      /* (g) A1 rule 4 — a running turn ends in "working · Ns", NEVER in a reply bubble */
      chat.setPane('selftest:p3');
      chat.setStatus('selftest:p3', 'working');
      const w0 = Date.now() - 12000;
      chat.ingest('selftest:p3', { ok: true, pane_id: 'selftest:p3', agent: 'claude', cursor: 50,
        truncated: false, skipped: 0, unknown_records: 0, messages: [
          { key: 'w1', ts: w0, role: 'user', kind: 'text', text: 'selftest: a long job', sidechain: false },
          { key: 'w2', ts: w0 + 500, role: 'assistant', kind: 'text', text: 'selftest: starting now' }
        ] });
      const workingEl = function () { return document.querySelector('#hdChatScroll .hd-cv-working, #hdChatScroll .chat-working'); };
      check('(g) while the pane works the group ends in a live tail, and says how long it has run',
        !!workingEl() && /working · 1[12]s/.test(workingEl().textContent),
        'tail=' + JSON.stringify(workingEl() ? workingEl().textContent : null));
      check('(g) a running turn has no "reply" marker (the last text is interim, not the answer)',
        !document.querySelector('#hdChatScroll .hd-cv-replytag'),
        'replytags=' + document.querySelectorAll('#hdChatScroll .hd-cv-replytag').length);
      check('(g) the tail is not a bubble (A1 rule 5: no animated typing pretence) and the view is not re-rendered per tick',
        workingEl().className.indexOf('bubble') < 0 && document.querySelectorAll('#hdChatScroll .hd-cv-turn').length === 1,
        'tailClass=' + workingEl().className);
      chat.setStatus('selftest:p3', 'idle');
      check('(g) when the pane stops working the tail is gone and the turn closes with its reply',
        !workingEl() && /reply/.test(dom.scroll.textContent),
        'tail=' + (workingEl() ? workingEl().textContent : 'gone') + ' replytags=' +
        document.querySelectorAll('#hdChatScroll .hd-cv-replytag').length);

      /* (h) DEFECT-10 — an empty text/thinking record is never a blank row, and never silent */
      chat.setPane('selftest:p4');
      chat.setStatus('selftest:p4', 'idle');
      chat.ingest('selftest:p4', { ok: true, pane_id: 'selftest:p4', agent: 'claude', cursor: 70,
        truncated: false, skipped: 0, unknown_records: 0, messages: [
          { key: 'n1', ts: t0, role: 'user', kind: 'text', text: 'selftest: empties follow', sidechain: false },
          { key: 'n2', ts: t0 + 1, role: 'assistant', kind: 'thinking', text: '   ' },
          { key: 'n3', ts: t0 + 2, role: 'assistant', kind: 'text', text: '' },
          { key: 'n4', ts: t0 + 3, role: 'assistant', kind: 'text', text: 'selftest: the only visible answer' }
        ] });
      const blanks = Array.prototype.filter.call(
        document.querySelectorAll('#hdChatScroll .hd-cv-msg, #hdChatScroll .chat-msg'),
        function (n) { return n.textContent.replace(/\s+/g, '') === ''; });
      check('(h) 2 empty records are hidden — no blank row, no empty bubble',
        chat.state().empties === 2 && blanks.length === 0 && /the only visible answer/.test(dom.scroll.textContent),
        'empties=' + chat.state().empties + ' blankNodes=' + blanks.length);
      check('(h) and the hiding is stated, not silent ("2 empty records (no text) hidden")',
        dom.status.textContent.indexOf('2 empty records (no text) hidden') >= 0,
        JSON.stringify(dom.status.textContent));

      /* (i) DEFECT-12 — the in-flight latch carries a clock and an owner. This is the decision that
         froze the panel: with a boolean latch the answer was ALWAYS 'wait', for every pane, forever. */
      const latch = chat.latch, TMO = chat.reqTimeoutMs();
      const nowT = Date.now();
      /* The checks below pass `null`/objects to the latch directly, so they need no network — but the
         page this suite runs in is the real app, and if the reader's last pane is remembered the
         mount's own first poll for it is on the wire when this suite starts. The suite is
         synchronous, so a promise in flight cannot settle until it ends: that request would be the
         latch's honest contents for the whole run and the check below ("nothing in flight") would
         read it as a defect. Name it, release it, then assert the release — the latch's bookkeeping
         is what is under test here, not whether the network answered in time. */
      const straggler = chat.inflight();
      const released = straggler ? chat.abandon('selftest') : false;
      check('(i) the suite starts from an idle latch: any request the mount already had on the wire is released first, and the release is reported',
        chat.inflight() === null && (straggler === null || released === true),
        'straggler=' + JSON.stringify(straggler) + ' released=' + released +
        ' inflight=' + JSON.stringify(chat.inflight()));
      check('(i) no request in flight → the next poll goes (nothing waits on a latch that is not set)',
        latch(null, 'selftest:p1', nowT) === 'go', 'got=' + latch(null, 'selftest:p1', nowT));
      check('(i) a young request for this pane waits (we do not open a second one)',
        latch({ id: 'selftest:p1', startedAt: nowT - 1000 }, 'selftest:p1', nowT) === 'wait',
        'got=' + latch({ id: 'selftest:p1', startedAt: nowT - 1000 }, 'selftest:p1', nowT));
      /* The regression that a latched clock invites: measuring the age from the REQUEST'S CURSOR
         instead of from the request's start time. Cursors are protocol numbers (0 on a first load,
         a byte offset on a live session) — every one of them is smaller than now-minus-12s, so a
         cursor-clock abandons every request on the first tick that sees it: a bogus "1 request
         stalled" and the same page fetched twice. Both shapes below are young and must WAIT. */
      check('(i) the age comes from the request\'s START TIME, not from its cursor (a first load: cursor 0)',
        latch({ id: 'selftest:p1', cursor: 0, startedAt: nowT }, 'selftest:p1', nowT) === 'wait',
        'got=' + latch({ id: 'selftest:p1', cursor: 0, startedAt: nowT }, 'selftest:p1', nowT));
      check('(i) …and not from a live session\'s byte-offset cursor either',
        latch({ id: 'selftest:p1', cursor: 9400000, startedAt: nowT }, 'selftest:p1', nowT) === 'wait',
        'got=' + latch({ id: 'selftest:p1', cursor: 9400000, startedAt: nowT }, 'selftest:p1', nowT));
      check('(i) a request older than ' + TMO + 'ms is ABANDONED, not waited on forever ' +
            '(this is the line the old boolean latch could not express)',
        latch({ id: 'selftest:p1', startedAt: nowT - TMO - 1 }, 'selftest:p1', nowT) === 'abandon',
        'got=' + latch({ id: 'selftest:p1', startedAt: nowT - TMO - 1 }, 'selftest:p1', nowT));
      check('(i) another pane\'s in-flight request is abandoned when the user switches panes',
        latch({ id: 'selftest:p2', startedAt: nowT }, 'selftest:p1', nowT) === 'abandon',
        'got=' + latch({ id: 'selftest:p2', startedAt: nowT }, 'selftest:p1', nowT));
      check('(i) abandoning the in-flight request releases the latch and records the stall honestly',
        chat.inflight() === null && chat.abandon('test') === false,
        'inflight=' + JSON.stringify(chat.inflight()) + ' abandonWithNothingInFlight=' + chat.abandon('test'));

      /* (j) §8.2 tail mode — the FIRST load is one tail request (§8.3/DEFECT-9) */
      chat.setPane('selftest:p5');
      chat.setStatus('selftest:p5', 'idle');
      const long = [];
      for (let i = 0; i < 300; i++) {
        long.push(i % 2 === 0
          ? { key: 'L' + i, ts: t0 + i * 1000, role: 'user', kind: 'text', text: 'prompt #' + i, sidechain: false }
          : { key: 'L' + i, ts: t0 + i * 1000, role: 'assistant', kind: 'text', text: 'answer #' + i, sidechain: false });
      }
      chat.ingestTail('selftest:p5', { ok: true, pane_id: 'selftest:p5', agent: 'claude', tail: true,
        cursor: 300, truncated: true, skipped: 0, unknown_records: 0, messages: long.slice(100) });
      check('(j) a tail response opens the view at the END of the log, in one request',
        /answer #299/.test(dom.scroll.textContent) && dom.scroll.textContent.indexOf('prompt #0') < 0 &&
        chat.state().domFirst === 0 && chat.state().messages === 200,
        'messages=' + chat.state().messages + ' hasOldest=' + (dom.scroll.textContent.indexOf('prompt #0') >= 0));
      check('(j) tail mode is recognised (so the catch-up walk does not run) and said in the status strip',
        chat.state().tailMode === true && dom.status.textContent.indexOf('tail mode (opened at the end of the log)') >= 0,
        'tailMode=' + chat.state().tailMode + ' status=' + JSON.stringify(dom.status.textContent));
      check('(j) the OLDEST records the tail page did bring are the ones drawn (no window drift)',
        /prompt #100/.test(dom.scroll.textContent), JSON.stringify(dom.scroll.textContent.slice(0, 40)));

      /* a server without tail mode answers the same request with a HEAD page: they look identical,
         so one forward call decides — records came → we were at the head (walk as before) */
      chat.setPane('selftest:p6');
      chat.ingestTail('selftest:p6', { ok: true, pane_id: 'selftest:p6', agent: 'claude',
        cursor: 200, truncated: true, skipped: 0, unknown_records: 0, messages: long.slice(0, 200) });
      check('(j) a tail request answered with a HEAD page is not trusted: one forward call is queued',
        chat.state().tailMode === false, 'tailMode=' + chat.state().tailMode);
      chat.ingest('selftest:p6', { ok: true, cursor: 201, truncated: false, skipped: 0, unknown_records: 0,
        messages: [long[200]] });
      check('(j) records came back → the server has no tail mode, and the old forward walk resumes',
        chat.state().tailMode === false &&
        dom.status.textContent.indexOf('tail mode not available') >= 0,
        'tailMode=' + chat.state().tailMode + ' status=' + JSON.stringify(dom.status.textContent.slice(0, 90)));
      chat.setPane('selftest:p7');
      chat.ingestTail('selftest:p7', { ok: true, pane_id: 'selftest:p7', agent: 'claude',
        cursor: 200, truncated: true, skipped: 0, unknown_records: 0, messages: long.slice(0, 200) });
      chat.ingest('selftest:p7', { ok: true, cursor: 200, truncated: false, skipped: 0, unknown_records: 0, messages: [] });
      check('(j) nothing came back → the cursor really was at EOF, and no page is fetched again',
        chat.state().tailMode === true, 'tailMode=' + chat.state().tailMode);

      /* (k) DEFECT-13 — the palette offers the chat view and the raw terminal.
         ?selftest=1 skips init(), so no module is mounted yet: mount the palette here (twice-mount
         is a no-op) and drive it the way Ctrl+K does. */
      let palApi = (state.moduleApi && state.moduleApi.palette) || null;
      if (!palApi && HD.modules.palette && typeof HD.modules.palette.mount === 'function') {
        mountModule('palette', HD.modules.palette);
        palApi = state.moduleApi.palette || null;
      }
      if (palApi && typeof palApi.show === 'function') {
        palApi.show();
        const pin = document.querySelector('#hdPalette .pal-input');
        pin.value = 'chat view';
        pin.dispatchEvent(new Event('input', { bubbles: true }));
        const keys = Array.prototype.map.call(document.querySelectorAll('#hdPalette .pal-key'),
          function (n) { return n.textContent; });
        check('(k) the command palette has a row for the chat view',
          keys.indexOf('chat view') >= 0, 'keys=' + JSON.stringify(keys.slice(0, 6)));
        pin.value = 'raw terminal';
        pin.dispatchEvent(new Event('input', { bubbles: true }));
        const keys2 = Array.prototype.map.call(document.querySelectorAll('#hdPalette .pal-key'),
          function (n) { return n.textContent; });
        check('(k) the command palette has a row for the raw terminal',
          keys2.indexOf('raw terminal') >= 0, 'keys=' + JSON.stringify(keys2.slice(0, 6)));
        palApi.hide();
      } else {
        check('(k) the command palette module is mounted (chat view / raw terminal rows live in it)',
          false, 'moduleApi.palette=' + typeof palApi);
      }

      /* (l) §8.3 amendment A2 — the reader's own prompt bubble and the agent's reply bubble both
         fold, on a reader's click only, and the fold is in-memory UI state of ONE pane. The fold
         marker is read wherever the drawing renderer puts it: A2.4 puts `hd-cv-folded` on the
         bubble's own row, this module's fallback puts it on the message node — both are "the row". */
      chat.setPane('selftest:p8');
      chat.setStatus('selftest:p8', 'idle');
      const foldFirst = 'selftest: the prompt the reader folds, and its first line is the preview';
      chat.ingest('selftest:p8', { ok: true, pane_id: 'selftest:p8', agent: 'claude', cursor: 90,
        truncated: false, skipped: 0, unknown_records: 0, messages: [
          { key: 'f1', ts: t0, role: 'user', kind: 'text', sidechain: false,
            text: foldFirst + '\nSELFTEST-FOLD-FIRST-SENTINEL: the body a fold must take off the screen' },
          { key: 'f2', ts: t0 + 1000, role: 'assistant', kind: 'text', sidechain: false,
            text: 'selftest: the reply the reader folds\nSELFTEST-FOLD-SECOND-SENTINEL: the reply body' }
        ] });
      const foldRow = (key) => Array.prototype.find.call(
        document.querySelectorAll('#hdChatList .hd-cv-msg, #hdChatList .chat-msg'),
        function (n) { return n.getAttribute('data-key') === key; }) || null;
      const foldMarks = (key) => { const r = foldRow(key); return r ? r.querySelectorAll('.hd-cv-folded').length : -1; };
      const foldCtl = (key) => { const r = foldRow(key); return r ? r.querySelector('[data-hd-fold]') : null; };
      const foldDom = (key) => { const r = foldRow(key); return r ? (r.textContent || '') : ''; };
      check('(l) the prompt and the reply each carry their own fold control, under the message head (A2.2/A2.4)',
        !!foldCtl('f1') && !!foldCtl('f2') && !!foldCtl('f1').getAttribute('aria-expanded') &&
        !!foldRow('f1').querySelector('[data-hd-foldhead]'),
        'promptControl=' + !!foldCtl('f1') + ' replyControl=' + !!foldCtl('f2') +
        ' head=' + !!foldRow('f1').querySelector('[data-hd-foldhead]'));
      check('(l) the default is EXPANDED: nothing marked folded, the control says so, the whole body is on screen (A2.1)',
        foldMarks('f1') === 0 && foldCtl('f1').getAttribute('aria-expanded') === 'true' &&
        foldDom('f1').indexOf('SELFTEST-FOLD-FIRST-SENTINEL') >= 0,
        'marks=' + foldMarks('f1') + ' aria=' + foldCtl('f1').getAttribute('aria-expanded'));
      const foldInflight = chat.inflight();
      foldCtl('f1').click();
      check('(l) one click folds that bubble: the row is marked folded, aria-expanded=false, the body is gone',
        foldMarks('f1') > 0 && foldCtl('f1').getAttribute('aria-expanded') === 'false' &&
        foldDom('f1').indexOf('SELFTEST-FOLD-FIRST-SENTINEL') < 0,
        'marks=' + foldMarks('f1') + ' aria=' + foldCtl('f1').getAttribute('aria-expanded') +
        ' bodyStillThere=' + (foldDom('f1').indexOf('SELFTEST-FOLD-FIRST-SENTINEL') >= 0));
      check('(l) the folded form is the message\'s own first line plus what is hidden — not a rewrite (A2.3)',
        foldDom('f1').indexOf(foldFirst) >= 0 && /\d+ chars · \d+ lines hidden/.test(foldDom('f1')),
        JSON.stringify(foldDom('f1').slice(0, 160)));
      check('(l) folding is UI state and nothing else: the reply is untouched, the pane\'s map holds it, no request went out',
        foldMarks('f2') === 0 && foldDom('f2').indexOf('SELFTEST-FOLD-SECOND-SENTINEL') >= 0 &&
        chat.foldKeys('selftest:p8').join(',') === 'f1' && foldInflight === null && chat.inflight() === null,
        'map=' + JSON.stringify(chat.foldKeys('selftest:p8')) + ' inflightBefore=' + JSON.stringify(foldInflight));
      chat.ingest('selftest:p8', { ok: true, cursor: 91, truncated: false, skipped: 0, unknown_records: 0,
        messages: [{ key: 'f3', ts: t0 + 2000, role: 'assistant', kind: 'text', sidechain: false,
                     text: 'selftest: a record that arrives after the fold' }] });
      check('(l) a record arriving later does not resurrect the folded bubble (A2.5)',
        foldMarks('f1') > 0 && foldDom('f1').indexOf('SELFTEST-FOLD-FIRST-SENTINEL') < 0 &&
        document.getElementById('hdChatList').textContent.indexOf('a record that arrives after the fold') >= 0,
        'marks=' + foldMarks('f1') + ' appended=' +
        (document.getElementById('hdChatList').textContent.indexOf('a record that arrives after the fold') >= 0));
      chat.setPane('selftest:p9');
      chat.ingest('selftest:p9', { ok: true, pane_id: 'selftest:p9', agent: 'claude', cursor: 5,
        truncated: false, skipped: 0, unknown_records: 0, messages: [
          { key: 'f1', ts: t0, role: 'user', kind: 'text', sidechain: false,
            text: 'selftest: another pane reusing the same key' }] });
      check('(l) the fold belongs to one pane and one record: the same key in another pane is expanded (A2.5)',
        foldMarks('f1') === 0 && foldDom('f1').indexOf('another pane reusing') >= 0 &&
        chat.foldKeys('selftest:p9').length === 0 && chat.foldKeys('selftest:p8').join(',') === 'f1',
        'otherMarks=' + foldMarks('f1') + ' otherMap=' + JSON.stringify(chat.foldKeys('selftest:p9')));
      chat.setPane('selftest:p8');
      foldCtl('f1').click();
      check('(l) the second click unfolds it and the text comes back verbatim (A2.6)',
        foldMarks('f1') === 0 && foldCtl('f1').getAttribute('aria-expanded') === 'true' &&
        foldDom('f1').indexOf('SELFTEST-FOLD-FIRST-SENTINEL') >= 0 && chat.foldKeys('selftest:p8').length === 0,
        'marks=' + foldMarks('f1') + ' map=' + JSON.stringify(chat.foldKeys('selftest:p8')));

      /* (m) §8.3 amendment A3 — the reader's OPEN BLOCKS (a thinking head, a tool card's expand, a
         long-text "show all") live in a per-pane map that every render path consults, so a turn that
         is re-rendered while the reader watches it cannot collapse what they just opened. The defect
         this pins down: expand the newest turn's block, a record arrives, A1 redraws that turn — and
         the block came back collapsed. */
      const A3_P = 'selftest:p10';
      const A3_Q = 'selftest:p11';
      const A3_TAIL = 'SELFTEST-OPEN-TAIL: the tail of the long reply, behind the show-all control';
      const a3Long = ['selftest: a reply long enough to hide its own tail']
        .concat(Array.from({ length: 24 }, (_, i) => 'SELFTEST-OPEN-LINE ' + (i + 1)))
        .concat([A3_TAIL]).join('\n');
      const a3Fixture = (p, pre) => ({
        ok: true, pane_id: p, agent: 'claude', cursor: 42, truncated: false, skipped: 0,
        unknown_records: 0, messages: [
          { key: pre + '-u', ts: t0 + 3000, role: 'user', kind: 'text', sidechain: false,
            text: 'selftest: the prompt of the turn the reader watches\nSELFTEST-OPEN-PROMPT-BODY: hidden by a fold' },
          { key: pre + '-t', ts: t0 + 4000, role: 'assistant', kind: 'thinking', sidechain: false,
            text: 'selftest: the agent weighing this up\nSELFTEST-THINK-BODY: the thinking text an open block must keep' },
          { key: pre + '-c', ts: t0 + 5000, role: 'assistant', kind: 'tool_call', sidechain: false, text: '',
            tool: { name: 'Bash', call_key: pre + 'ck', input: { command: 'echo selftest' },
                    result: 'SELFTEST-TOOL-BODY: the result an expanded card must keep', is_error: false } },
          { key: pre + '-s', ts: t0 + 6000, role: 'assistant', kind: 'text', sidechain: false, text: a3Long }
        ] });
      const A3_THINK = 'selftest-t#think0', A3_TOOL = 'selftest-c#toolselftestck', A3_CLAMP = 'selftest-s#text';
      const a3Ctl = (id) => Array.prototype.find.call(document.querySelectorAll('#hdChatList [data-hd-open]'),
        (e) => e.getAttribute('data-hd-open') === id) || null;
      const a3Body = (ctl) => {
        if (!ctl) return null;
        const cls = String(ctl.className || '');
        if (cls.indexOf('hd-cv-think-head') >= 0) { const t = ctl.closest('.hd-cv-think'); return t ? t.querySelector('.hd-cv-think-body') : null; }
        if (cls.indexOf('hd-cv-toggle') >= 0) { const c = ctl.closest('.hd-cv-card'); return c ? c.querySelector('.hd-cv-card-body') : null; }
        const prev = ctl.previousElementSibling;
        if (prev && prev.classList && (prev.classList.contains('hd-cv-body') || prev.classList.contains('hd-cv-resbox'))) return prev;
        return ctl.parentNode ? ctl.parentNode.querySelector('.hd-cv-body, .hd-cv-resbox') : null;
      };
      const a3Probe = (id) => { const c = a3Ctl(id); const b = a3Body(c);
        return { ctl: c, body: b, aria: c ? c.getAttribute('aria-expanded') : null,
          open: !!(b && b.classList.contains('hd-cv-open')), text: b ? (b.textContent || '') : '',
          hidden: b ? !!b.hidden : null }; };
      chat.setAuto(false);
      chat.setStatus(A3_P, 'idle');
      chat.setPane(A3_P);
      chat.ingest(A3_P, a3Fixture(A3_P, 'selftest'));
      check('(m) the thinking head, the tool toggle and the reply\'s show-all each carry the A3.2 id — the record\'s key + its own part (A3.2)',
        !!a3Ctl(A3_THINK) && !!a3Ctl(A3_TOOL) && !!a3Ctl(A3_CLAMP),
        'think=' + !!a3Ctl(A3_THINK) + ' tool=' + !!a3Ctl(A3_TOOL) + ' clamp=' + !!a3Ctl(A3_CLAMP) +
        ' (drawn: ' + JSON.stringify(Array.prototype.map.call(document.querySelectorAll('#hdChatList [data-hd-open]'),
          (e) => e.getAttribute('data-hd-open')).slice(0, 6)) + ')');
      check('(m) every A3 block starts CLOSED and says so, and the reader\'s map is empty until they speak (A3.1)',
        a3Probe(A3_THINK).aria === 'false' && !a3Probe(A3_THINK).open && a3Probe(A3_TOOL).aria === 'false' &&
        a3Probe(A3_CLAMP).aria === 'false' && Object.keys(chat.openKeys(A3_P)).length === 0,
        'think=' + a3Probe(A3_THINK).aria + ' tool=' + a3Probe(A3_TOOL).aria + ' clamp=' + a3Probe(A3_CLAMP).aria +
        ' map=' + JSON.stringify(chat.openKeys(A3_P)));
      const a3Inflight = chat.inflight();
      a3Ctl(A3_THINK).click();
      const a3ThinkText = a3Probe(A3_THINK).text;
      check('(m) one click opens the thinking block: aria-expanded=true, hd-cv-open on the body, the text on screen',
        a3Probe(A3_THINK).aria === 'true' && a3Probe(A3_THINK).open && !a3Probe(A3_THINK).hidden &&
        a3ThinkText.indexOf('SELFTEST-THINK-BODY') >= 0,
        'aria=' + a3Probe(A3_THINK).aria + ' open=' + a3Probe(A3_THINK).open +
        ' hidden=' + a3Probe(A3_THINK).hidden + ' text=' + JSON.stringify(a3ThinkText.slice(0, 60)));
      check('(m) the open is written into the pane\'s own map as the reader\'s decision, and nothing went to a pane (A3.1/A3.6)',
        chat.openKeys(A3_P)[A3_THINK] === true && Object.keys(chat.openKeys(A3_P)).length === 1 &&
        a3Inflight === null && chat.inflight() === null,
        'map=' + JSON.stringify(chat.openKeys(A3_P)) + ' inflightBefore=' + JSON.stringify(a3Inflight));
      a3Ctl(A3_TOOL).click();
      a3Ctl(A3_CLAMP).click();
      check('(m) the tool card expands and the reply\'s show-all reveals its hidden tail, both with real state (A3.3)',
        a3Probe(A3_TOOL).aria === 'true' && a3Probe(A3_TOOL).open && a3Probe(A3_TOOL).text.indexOf('SELFTEST-TOOL-BODY') >= 0 &&
        a3Probe(A3_CLAMP).aria === 'true' && a3Probe(A3_CLAMP).text.indexOf(A3_TAIL) >= 0,
        'tool=' + a3Probe(A3_TOOL).aria + '/' + a3Probe(A3_TOOL).open + ' clamp=' + a3Probe(A3_CLAMP).aria +
        ' tailShown=' + (a3Probe(A3_CLAMP).text.indexOf(A3_TAIL) >= 0));
      foldCtl('selftest-u') && foldCtl('selftest-u').click();
      check('(m) the prompt bubble folds in the same turn, so the redraw below carries both kinds of reader state (A2 + A3)',
        foldMarks('selftest-u') > 0 && foldCtl('selftest-u').getAttribute('aria-expanded') === 'false',
        'marks=' + foldMarks('selftest-u'));
      /* THE DEFECT: the agent produces a record, A1 re-renders that turn, and the reader's open blocks
         must come back open. The click's own nodes are marked first: if the mark is still there when
         the record lands, the turn was not re-rendered and this case would prove nothing. */
      a3Ctl(A3_THINK).setAttribute('data-selftest-probe', '1');
      A3_TOOL && a3Ctl(A3_TOOL).setAttribute('data-selftest-probe', '1');
      chat.ingest(A3_P, { ok: true, cursor: 43, truncated: false, skipped: 0, unknown_records: 0,
        messages: [{ key: 'selftest-t2', ts: t0 + 7000, role: 'assistant', kind: 'thinking', sidechain: false,
                     text: 'selftest: a record that arrives while the reader is watching this turn' }] });
      const a3Probes = document.querySelectorAll('#hdChatList [data-selftest-probe]').length;
      const a3After = a3Probe(A3_THINK);
      check('(m) the turn really was re-rendered (every marked node was detached) — the round-7.5 defect\'s own trigger',
        a3Probes === 0 && document.getElementById('hdChatList').textContent.indexOf('a record that arrives while the reader is watching') >= 0,
        'probes=' + a3Probes);
      check('(m) THE DEFECT: the thinking block survives the re-render — still aria-expanded=true, still hd-cv-open, same text',
        a3After.aria === 'true' && a3After.open && !a3After.hidden && a3After.text === a3ThinkText,
        'aria=' + a3After.aria + ' open=' + a3After.open + ' sameText=' + (a3After.text === a3ThinkText));
      check('(m) the tool card and the show-all block survive it too, and the folded bubble stays folded',
        a3Probe(A3_TOOL).aria === 'true' && a3Probe(A3_TOOL).open &&
        a3Probe(A3_TOOL).text.indexOf('SELFTEST-TOOL-BODY') >= 0 &&
        a3Probe(A3_CLAMP).aria === 'true' && a3Probe(A3_CLAMP).text.indexOf(A3_TAIL) >= 0 &&
        foldMarks('selftest-u') > 0,
        'tool=' + a3Probe(A3_TOOL).aria + ' clamp=' + a3Probe(A3_CLAMP).aria + ' foldMarks=' + foldMarks('selftest-u'));
      chat.setPane(A3_Q);
      chat.ingest(A3_Q, a3Fixture(A3_Q, 'selftest'));
      check('(m) the opens belong to ONE pane: the same record in another pane is closed, and that pane\'s map is empty (A3.5)',
        a3Probe(A3_THINK).aria === 'false' && !a3Probe(A3_THINK).open &&
        Object.keys(chat.openKeys(A3_Q)).length === 0,
        'otherAria=' + a3Probe(A3_THINK).aria + ' otherMap=' + JSON.stringify(chat.openKeys(A3_Q)));
      chat.setPane(A3_P);
      check('(m) switching back leaves pane A exactly as the reader left it (A3.5) — open block, folded bubble, untouched other pane',
        a3Probe(A3_THINK).aria === 'true' && a3Probe(A3_THINK).open && foldMarks('selftest-u') > 0 &&
        chat.openKeys(A3_P)[A3_THINK] === true && Object.keys(chat.openKeys(A3_Q)).length === 0,
        'aria=' + a3Probe(A3_THINK).aria + ' mapA=' + JSON.stringify(chat.openKeys(A3_P)));
      a3Ctl(A3_THINK).click();
      check('(m) a second click CLOSES it and the map records the close as a value, not as an absence (A3.1)',
        a3Probe(A3_THINK).aria === 'false' && !a3Probe(A3_THINK).open &&
        chat.openKeys(A3_P)[A3_THINK] === false &&
        Object.prototype.hasOwnProperty.call(chat.openKeys(A3_P), A3_THINK),
        'aria=' + a3Probe(A3_THINK).aria + ' map=' + JSON.stringify(chat.openKeys(A3_P)));
      /* A3.5: an id whose record left the buffer is dropped, so the map cannot grow for ever */
      const A3_R = 'selftest:p12';
      chat.setPane(A3_R);
      chat.setStatus(A3_R, 'idle');
      chat.ingest(A3_R, { ok: true, pane_id: A3_R, agent: 'claude', cursor: 1, truncated: false, skipped: 0,
        unknown_records: 0, messages: [{ key: 'selftest-old', ts: t0, role: 'assistant', kind: 'thinking',
          sidechain: false, text: 'selftest: the oldest record, which the memory cap will trim away' }] });
      a3Ctl('selftest-old#think0').click();
      const a3Opened = chat.openKeys(A3_R)['selftest-old#think0'];
      chat.ingest(A3_R, { ok: true, cursor: 2, truncated: false, skipped: 0, unknown_records: 0,
        messages: Array.from({ length: 2005 }, (_, i) => ({ key: 'selftest-fill-' + i, ts: t0 + i,
          role: 'assistant', kind: 'text', sidechain: false, text: 'selftest: filler record ' + i })) });
      const a3State = chat.state();
      check('(m) a record the memory cap trimmed away takes its ids with it: the map holds no entry for a record that is gone (A3.5)',
        a3Opened === true && a3State.messages === 2000 && !a3Ctl('selftest-old#think0') &&
        !Object.prototype.hasOwnProperty.call(chat.openKeys(A3_R), 'selftest-old#think0'),
        'openedBefore=' + a3Opened + ' messages=' + a3State.messages +
        ' mapHasTrimmedId=' + Object.prototype.hasOwnProperty.call(chat.openKeys(A3_R), 'selftest-old#think0'));

      /* (n) the reader's position INSIDE a block that has its own scrollbar. Two halves have to hold
         on their own: the browser's scroll event is what writes the position into the pane's map (and
         it lands after this synchronous task, so nothing may lean on it having already landed), and a
         redraw must put the reader back no matter what. The defect: the box scrolls on its own, the
         reader drags it, a record arrives, the turn is redrawn — and the box came back at the top. */
      const N_P = 'selftest:p13';
      const N_FIRST = 'SELFTEST-SCROLL-FIRST: the head of a reply long enough to scroll on its own';
      const nLong = [N_FIRST]
        .concat(Array.from({ length: 300 }, (_, i) => 'SELFTEST-SCROLL line ' + (i + 1))).join('\n');
      const N_CTL = 'selftest-scroll-a#text';
      const nCtl = (id) => a3Ctl(id);
      const nBox = (id) => a3Body(nCtl(id));
      chat.setAuto(false);
      chat.setStatus(N_P, 'idle');
      chat.setPane(N_P);
      chat.ingest(N_P, { ok: true, pane_id: N_P, agent: 'claude', cursor: 1, truncated: false, skipped: 0,
        unknown_records: 0, messages: [
          { key: 'selftest-scroll-u', ts: t0, role: 'user', kind: 'text', sidechain: false,
            text: 'selftest: a prompt whose reply is far too long for one screen' },
          { key: 'selftest-scroll-a', ts: t0 + 1000, role: 'assistant', kind: 'text', sidechain: false,
            text: nLong }
        ] });
      const nClosed = nCtl(N_CTL);
      const nClosedAria = nClosed ? nClosed.getAttribute('aria-expanded') : null;
      if (nClosed) nClosed.click();
      const nOpenCtl = nCtl(N_CTL);   // re-found: the click re-rendered the node, so nClosed is stale
      const nOpenBox = nBox(N_CTL);
      check('(n) the long block is a real scroll region and starts closed',
        !!nClosed && nClosedAria === 'false' && !!nOpenCtl &&
        nOpenCtl.getAttribute('aria-expanded') === 'true' &&
        !!nOpenBox && nOpenBox.scrollHeight > nOpenBox.clientHeight + 50,
        'ctl=' + !!nClosed + ' ariaBefore=' + nClosedAria + ' ariaAfter=' + (nOpenCtl && nOpenCtl.getAttribute('aria-expanded')) +
        ' scrollHeight=' + (nOpenBox && nOpenBox.scrollHeight) + ' clientHeight=' + (nOpenBox && nOpenBox.clientHeight));
      if (nOpenBox) nOpenBox.scrollTop = 200;
      const nAt200 = nOpenBox ? nOpenBox.scrollTop : null;
      check('(n) setting the position alone records nothing: the map is written by the listener, not by the assignment',
        nAt200 === 200 && Object.keys(chat.scrollKeys(N_P)).length === 0,
        'readBack=' + nAt200 + ' map=' + JSON.stringify(chat.scrollKeys(N_P)));
      if (nOpenBox) nOpenBox.setAttribute('data-selftest-probe', '1');
      chat.ingest(N_P, { ok: true, cursor: 2, truncated: false, skipped: 0, unknown_records: 0,
        messages: [{ key: 'selftest-scroll-t', ts: t0 + 2000, role: 'assistant', kind: 'thinking',
          sidechain: false, text: 'selftest: a record that arrives while the reader is scrolled inside the long block' }] });
      const nProbes = document.querySelectorAll('#hdChatList [data-selftest-probe]').length;
      check('(n) the redraw really happened: the marked block node was detached',
        nProbes === 0, 'probes=' + nProbes);
      const nKeptCtl = nCtl(N_CTL);
      const nKeptBox = nBox(N_CTL);
      check('(n) the reader\'s position inside the open block survives the redraw even when no scroll event has landed yet',
        !!nKeptCtl && nKeptCtl.getAttribute('aria-expanded') === 'true' && !!nKeptBox && nKeptBox.scrollTop === 200,
        'aria=' + (nKeptCtl && nKeptCtl.getAttribute('aria-expanded')) + ' scrollTop=' + (nKeptBox && nKeptBox.scrollTop));
      const nKeys = Object.keys(chat.scrollKeys(N_P));
      check('(n) the position is per record: the map key names the record that owns the block',
        nKeys.length === 1 && nKeys[0].indexOf('selftest-scroll-a') === 0,
        'keys=' + JSON.stringify(nKeys));
      if (nKeptBox) nKeptBox.scrollTop = 120;
      if (nKeptBox) nKeptBox.dispatchEvent(new Event('scroll'));
      const nMap6 = chat.scrollKeys(N_P);
      const nKeys6 = Object.keys(nMap6);
      check('(n) a landed scroll event is recorded by the list\'s own listener (the browser\'s async event, delivered here)',
        nKeys6.length === 1 && nMap6[nKeys6[0]] === 120,
        'map=' + JSON.stringify(nMap6));

      /* leave the page readable: raw transcript on screen, the user's stored preference restored */
      chat.setStatus(null, null);
      chat.setPane('selftest:p1');
      api2.hide();
      chat.setPane(null);
      if (lsBefore === null) { try { window.localStorage.removeItem(CHAT_LS); } catch (e) { /* ignore */ } }
      else lsSet(CHAT_LS, lsBefore);
    }
  } catch (e) {
    fail++;
    line('FAIL  §8.3 chat self-test threw  -> ' + (e && e.message ? e.message : e));
  }
  state.selected = promo;

  line('');
  line('SELFTEST: ' + pass + '/' + (pass + fail) + ' ' + (fail ? 'FAIL' : 'PASS'));

  const pre = $('transcript');
  if (pre) pre.textContent = out.join('\n');
  const wrap = $('transcriptWrap');
  if (wrap) wrap.classList.add('selftest');
  setLive(false, 'self-test');
  document.title = (fail ? 'FAIL ' : 'PASS ') + 'herdr-dash self-test';
}

/* ------------------------------------------------------------------ *
 * init
 * ------------------------------------------------------------------ */

/* DEFECT-21 (cont.) — the ceiling is measured from the panel's siblings, and those are not all final
   when `init` runs: the modules mount during boot and the time strip grows as status events arrive.
   A height restored against a stale layout can leave the console below the fold with no window resize
   to correct it, so the clamp is re-applied whenever a sibling changes size (or #main gains one). It
   can only ever bring the panel back into what the layout now holds: the preference itself is not
   rewritten, exactly like the window-resize clamp. */
function watchMainLayout(box) {
  const main = $('main');
  if (!main) return;
  /* Not while the top edge is under the pointer: a drag sets the height per move from the pointer's
     own position, and a sibling growing mid-drag would otherwise yank the panel back to the stored
     preference for a frame. The drag re-measures its own limits on every move anyway. */
  const apply = function () { if (!promptDragging) applyPromptH(); syncConsoleStrip(); };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(apply);
    const attach = function () {
      ro.disconnect();
      for (const el of main.children) if (el !== box) ro.observe(el);
    };
    attach();
    if (typeof MutationObserver === 'function') new MutationObserver(attach).observe(main, { childList: true });
  }
}

function init() {
  applySidebar();
  applyConsole();
  applyDock();          // §12.2.1 — the dock is closed unless hd.dockOpen says otherwise
  applyPromptH();       // §12.1.4 — the composer's stored height, re-clamped for this window
  watchMainLayout($('promptBox'));
  /* the console's strip state is the console's own height, so it also has to follow a bare window
     resize — one where no stored composer height exists to re-apply and move it on its own */
  window.addEventListener('resize', syncConsoleStrip);
  syncConsoleStrip();

  const S = $('sidebarToggle');
  if (S) S.addEventListener('click', toggleSidebar);
  const SO = $('sidebarToggleOpen');
  if (SO) SO.addEventListener('click', toggleSidebar);

  /* DEFECT-16: a keyboard way back, so a hidden panel can never trap the page again. `\` (like the
     chat view's `t`) is a view key: it never reaches an agent. */
  window.addEventListener('keydown', function (e) {
    try {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key !== '\\') return;
      const t = e.target || {};
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
      const k = ctx.modules && ctx.modules.api ? ctx.modules.api('keys') : null;
      if (k && typeof k.overlayOpen === 'function' && k.overlayOpen()) return;
      e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      toggleSidebar();
      const sbEl = $('sidebar');
      const nowCollapsed = !!(sbEl && sbEl.classList.contains('collapsed'));
      if (ctx.ui && ctx.ui.setHint) {
        ctx.ui.setHint(nowCollapsed ? 'sidebar collapsed — press \\ to bring it back' : 'sidebar shown — press \\ to hide it');
      }
    } catch (err) { /* a shortcut must never break the page */ }
  }, true);
  const DT = $('dockToggle');
  if (DT) DT.addEventListener('click', toggleDock);

  /* §12.2.1 — `d` toggles the dock. Registered like every other view key: guarded on modifiers, on
     the typing targets (so a `d` typed into the composer is a `d`, not a layout change) and on an
     open overlay; it never reaches a pane and never claims a key something else already has (the
     `?` overlay is fed by the keys.register below). */
  window.addEventListener('keydown', function (e) {
    try {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key !== 'd') return;
      const t = e.target || {};
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
      const k = ctx.modules && ctx.modules.api ? ctx.modules.api('keys') : null;
      if (k && typeof k.overlayOpen === 'function' && k.overlayOpen()) return;
      e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      toggleDock();
      const dEl = $('dock');
      const open = !!(dEl && !dEl.classList.contains('collapsed'));
      if (ctx.ui && ctx.ui.setHint) {
        ctx.ui.setHint(open ? 'dock shown — press d to collapse it' : 'dock collapsed — press d to bring it back');
      }
    } catch (err) { /* a shortcut must never break the page */ }
  }, true);

  /* §12.1.4 — both panels' stored sizes are re-clamped when the window changes: a smaller window
     must not be left holding an out-of-range value, and growing it again restores the user's own */
  window.addEventListener('resize', function () {
    applyPromptH();
    applyDockWidth();
  });

  const CT = $('consoleToggle');
  if (CT) CT.addEventListener('click', function (ev) {
    if (ev.target && ev.target.id === 'consoleMode') return;   // don't fold when using the select
    toggleConsole();
  });

  // sidebar resize
  const handle = $('sidebarResize');
  if (handle) {
    let dragging = false;
    handle.addEventListener('mousedown', function (e) {
      dragging = true;
      e.preventDefault();
      document.body.style.cursor = 'col-resize';
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      const w = Math.max(240, Math.min(700, e.clientX));
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    });
    window.addEventListener('mouseup', function (e) {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      const w = Math.max(240, Math.min(700, e.clientX));
      lsSet(LS.width, w);
    });
  }

  // CONTRACT-v2 §12.1 — the composer's TOP edge (the same shape as the sidebar drag above; the
  // panel's bottom edge is what stands still, so the drag reads the panel, not the window)
  const pHandle = $('promptResize');
  if (pHandle) {
    let dragging = false;
    let base = 0;                       // the panel's bottom edge, measured once per drag: re-reading
                                        // it per move would feed the drag its own result once the
                                        // transcript reaches its floor and the console is pushed down
    let pressY = 0;                     // where the press landed…
    let moved = false;                  // …and whether the pointer ever actually moved (DEFECT-22)
    pHandle.addEventListener('mousedown', function (e) {
      const box = $('promptBox');
      if (!box) return;
      dragging = true;
      promptDragging = true;
      moved = false;
      pressY = e.clientY;
      base = box.getBoundingClientRect().bottom;
      e.preventDefault();
      document.body.style.cursor = 'row-resize';
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      if (e.clientY !== pressY) moved = true;
      if (!moved) return;                     // a press that has not moved yet is not a drag
      setPromptH(base - e.clientY, false);    // limits are re-measured per move: a chip may land mid-drag
    });
    window.addEventListener('mouseup', function (e) {
      if (!dragging) return;
      dragging = false;
      promptDragging = false;
      document.body.style.cursor = '';
      /* DEFECT-22: the handle's centre sits a few px inside the panel's top edge, so a plain CLICK
         (press + release with no pointer movement) used to snap the edge onto the pointer and shorten
         the panel by exactly that offset. A gesture that never moved is not a drag: leave both the
         applied height and the stored preference untouched. */
      if (!moved && e.clientY === pressY) return;
      setPromptH(base - e.clientY, true);
    });
    /* §12.1.5 — the same four keys on the focused handle. Every other key is left alone, so the
       handle never swallows anything meant for the composer, and nothing here touches a pane. */
    pHandle.addEventListener('keydown', function (e) {
      const box = $('promptBox');
      if (!box) return;
      const lim = promptLimits();
      const cur = box.getBoundingClientRect().height;
      let next;
      if (e.key === 'ArrowUp') next = cur + 16;                 // the top edge moves up → taller
      else if (e.key === 'ArrowDown') next = cur - 16;
      else if (e.key === 'Home') next = lim.min;
      else if (e.key === 'End') next = lim.max;
      else return;
      e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      setPromptH(next, true);
    });
  }

  // CONTRACT-v2 §12.2.1 — the dock's left edge; the mirror of #sidebarResize, read from the right
  const dHandle = $('dockResize');
  if (dHandle) {
    let dragging = false;
    dHandle.addEventListener('mousedown', function (e) {
      dragging = true;
      e.preventDefault();
      document.body.style.cursor = 'col-resize';
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      const w = Math.max(DOCK_MIN, Math.min(DOCK_MAX, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty('--dock-w', w + 'px');
    });
    window.addEventListener('mouseup', function (e) {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      const w = Math.max(DOCK_MIN, Math.min(DOCK_MAX, window.innerWidth - e.clientX));
      lsSet(LS.dockW, w);
    });
  }

  // transcript scrolling
  const pre = $('transcript');
  if (pre) {
    pre.addEventListener('scroll', function () { updateJumpButton(); });
    pre.addEventListener('keydown', function (e) {
      if (e.key === 'End' || e.key === 'PageDown') window.setTimeout(updateJumpButton, 0);
      if (e.key === 'Home' || e.key === 'PageUp') window.setTimeout(updateJumpButton, 0);
    });
  }
  const jump = $('jumpLatest');
  if (jump) jump.addEventListener('click', function () {
    state.autoScroll = true;
    pre.scrollTop = pre.scrollHeight;
    jump.classList.add('hidden');
    pre.focus();
  });

  // prompt box
  const ta = $('promptText');
  if (ta) ta.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
  });
  const ps = $('promptSend');
  if (ps) ps.addEventListener('click', sendPrompt);
  wireAttachComposer();                          // CONTRACT-v2 §10: picker, drop and paste
  const kr = $('keysRow');
  if (kr) kr.addEventListener('click', function (e) {
    const t = e.target;
    if (t && t.dataset && t.dataset.key) sendKeys([t.dataset.key]);
  });
  const lsb = $('literalSend');
  if (lsb) lsb.addEventListener('click', sendLiteral);
  const lt = $('literalText');
  if (lt) lt.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendLiteral(); });

  // console
  const mode = $('consoleMode');
  if (mode) mode.addEventListener('change', function () {
    const rpc = mode.value === 'rpc';
    const cli = $('cliRow'), rr = $('rpcRow');
    if (cli) cli.classList.toggle('hidden', rpc);
    if (rr) rr.classList.toggle('hidden', !rpc);
    const focus = rpc ? $('rpcInput') : $('cmdInput');
    if (focus) focus.focus();
  });
  const ci = $('cmdInput');
  if (ci) ci.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); runCliLine(ci.value); return; }
    if (e.key === 'ArrowUp') {
      if (!state.history.length) return;
      e.preventDefault();
      state.histIdx = Math.min(state.history.length - 1, state.histIdx + 1);
      ci.value = state.history[state.histIdx];
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.histIdx = state.histIdx - 1;
      if (state.histIdx < 0) { state.histIdx = -1; ci.value = ''; return; }
      ci.value = state.history[state.histIdx];
    }
  });
  const cr = $('cmdRun');
  if (cr) cr.addEventListener('click', function () { const i = $('cmdInput'); runCliLine(i ? i.value : ''); });
  const cp = $('cmdPreset');
  if (cp) cp.addEventListener('change', function () {
    if (!cp.value) return;
    const i = $('cmdInput');
    if (i) i.value = cp.value;
    runCliLine(cp.value);
    cp.value = '';
  });
  const rs = $('rpcSend');
  if (rs) rs.addEventListener('click', runRpc);
  const ri = $('rpcInput');
  if (ri) ri.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); runRpc(); } });

  renderHistory();
  setLive(false, 'connecting…');
  connectEvents();
  renderTree();
  renderHeader();

  refreshSnapshot();
  pollPane();
  window.setInterval(refreshSnapshot, SNAPSHOT_MS);
  window.setInterval(pollPane, POLL_MS);
  window.setInterval(renderAge, 250);
  /* §12.2.2 — the usage chip is re-read twice a second: fast enough that a fresh answer replaces a
     stale one promptly, slow enough that it never competes with the module's own 2s poll */
  window.setInterval(renderUsage, 500);

  /* DEFECT-23 — the chip re-renders on EVERY answer the module emits, not at the next tick of the
     timer above: a pane switch, an open, or a read that lands just after a tick must not leave the
     old number sitting in the header while the dock already shows the new one. The timer stays, so
     a module that answers without emitting cannot freeze the chip either. */
  ctx.events.on('dock', function (s) {
    usageSummary = (s && typeof s === 'object') ? s : null;
    renderUsage();
  });

  mountModules();     // after the ctx exists and the shell is wired

  /* DEFECT-16: emitted AFTER mountModules() on purpose. Palette only starts collecting
     `keys.register` when IT mounts, so a registration emitted from init() (earlier) is silently
     dropped — the first version of this fix landed exactly that way: the `\` key worked, the help
     line did not. Registrations from app.js belong here, next to the modules they describe. */
  try {
    ctx.events.emit('keys.register', {
      id: 'sidebar',
      keys: [{ key: '\\', help: 'toggle the sidebar (collapse / restore) — works even when nothing else is visible' }]
    });
    /* §12.2.1 — `d`, under its own id: the palette keys `id -> list` (a second registration for an
       id REPLACES the first), and W3's dock module registers under `dock`, so the shell's own key
       must not take that id. The `d` key is free — asserted in the local test suite. */
    ctx.events.emit('keys.register', {
      id: 'dock-shell',
      keys: [{ key: 'd', help: 'toggle the side dock (the selected pane\'s usage + background processes)' }]
    });
  } catch (e) { /* the help overlay is optional */ }
}

/* the modules are loaded before app.js; mount them once the DOM is up */
function boot() {
  if (SELFTEST) { runSelfTest(); return; }
  init();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
