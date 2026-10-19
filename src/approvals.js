'use strict';
/*
 * src/approvals.js — one-shot human approval requests for Claude Code tool calls.
 *
 * A Claude Code PreToolUse hook posts a pending tool call to /api/claude/approval
 * and waits on that HTTP response. The dashboard lists the pending call above the
 * composer; Allow/Deny resolves the wait. A request that nobody answers expires and
 * resolves to decision:null, which the hook treats as "no opinion" (Claude's own
 * permission flow then decides). Nothing here executes or inspects a tool.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 110000;
const MAX_PREVIEW_CHARS = 6000;
const MAX_SUMMARY_CHARS = 160;
const MAX_INPUT_CHARS = 64000;

function cleanString(value, max) {
  const s = value == null ? '' : String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function oneLine(value, max) {
  return cleanString(value, max).replace(/\s+/g, ' ').trim().slice(0, max);
}

function jsonPreview(input) {
  let text;
  try { text = JSON.stringify(input, null, 2); } catch (e) { text = String(input); }
  return cleanString(text, MAX_INPUT_CHARS);
}

function toolView(toolName, input, hookTruncated) {
  const name = cleanString(toolName, 120) || 'tool';
  const obj = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const lower = name.toLowerCase();
  let title = 'Claude wants to use ' + name;
  let summary = '';
  let body = '';
  let truncated = !!hookTruncated;

  if (lower === 'bash' || lower === 'powershell' || lower === 'shell' || lower === 'terminal') {
    title = 'Claude wants to run a command';
    summary = oneLine(obj.command, MAX_SUMMARY_CHARS) || '(no command)';
    body = 'command:\n' + cleanString(obj.command, MAX_INPUT_CHARS);
    if (obj.description) body += '\n\ndescription: ' + cleanString(obj.description, 1000);
  } else if (lower === 'write') {
    title = 'Claude wants to write a file';
    summary = oneLine(obj.file_path, MAX_SUMMARY_CHARS) || '(no path)';
    body = 'path: ' + cleanString(obj.file_path, 1000);
    if (obj.content != null) body += '\n\ncontent:\n' + cleanString(obj.content, MAX_INPUT_CHARS);
  } else if (lower === 'edit' || lower === 'multiedit' || lower === 'notebookedit') {
    title = 'Claude wants to edit a file';
    summary = oneLine(obj.file_path || obj.notebook_path, MAX_SUMMARY_CHARS) || '(no path)';
    body = 'path: ' + cleanString(obj.file_path || obj.notebook_path, 1000);
    if (obj.old_string != null) body += '\n\nreplace:\n' + cleanString(obj.old_string, MAX_INPUT_CHARS);
    if (obj.new_string != null) body += '\n\nwith:\n' + cleanString(obj.new_string, MAX_INPUT_CHARS);
    if (obj.content != null) body += '\n\ncontent:\n' + cleanString(obj.content, MAX_INPUT_CHARS);
  } else if (lower === 'webfetch' || lower === 'websearch') {
    title = lower === 'websearch' ? 'Claude wants to search the web' : 'Claude wants to fetch a URL';
    summary = oneLine(obj.url || obj.query, MAX_SUMMARY_CHARS) || '(no target)';
    body = (obj.url ? 'url: ' + cleanString(obj.url, 2000) : 'query: ' + cleanString(obj.query, 2000));
  } else {
    body = jsonPreview(obj);
    summary = oneLine(Object.keys(obj).slice(0, 3).join(', '), MAX_SUMMARY_CHARS);
  }

  body = cleanString(body || jsonPreview(obj), MAX_PREVIEW_CHARS);
  if (!body) body = '(no input)';
  if (truncated) body += '\n\n[input was truncated by the approval hook]';
  if (body.length >= MAX_PREVIEW_CHARS) {
    body = body.slice(0, MAX_PREVIEW_CHARS - 46) + '\n\n[preview truncated — the full input was not shown]';
    truncated = true;
  }
  return { title: title, summary: summary, preview: body, input_truncated: truncated };
}

function createApprovalBridge(opts) {
  const options = opts || {};
  const dir = options.dir || path.join(require('node:os').homedir(), '.herdr-dash');
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Math.min(600000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const random = typeof options.random === 'function' ? options.random : (n) => crypto.randomBytes(n).toString('hex');
  const tokenFile = path.join(dir, 'approval-token');

  fs.mkdirSync(dir, { recursive: true });
  let token = '';
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch (e) { token = ''; }
  if (!/^[a-f0-9]{32,128}$/i.test(token)) {
    token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  }
  try { fs.chmodSync(tokenFile, 0o600); } catch (e) { /* Windows ACLs may not expose POSIX modes */ }

  const records = new Map();
  const uiToken = crypto.randomBytes(32).toString('hex');

  function removeLater(rec) {
    const timer = setTimeout(() => {
      if (records.get(rec.id) === rec && rec.status === 'pending') {
        finish(rec, null, 'expired');
      }
      if (records.get(rec.id) === rec && rec.status !== 'pending') {
        records.delete(rec.id);
      }
    }, Math.max(0, rec.expires_at - now()) + 1000);
    if (timer.unref) timer.unref();
    return timer;
  }

  function finish(rec, decision, reason) {
    if (rec.status !== 'pending') return;
    rec.status = decision === 'allow' ? 'allowed' : (decision === 'deny' ? 'denied' : 'expired');
    rec.decision = decision;
    rec.reason = cleanString(reason, 300);
    rec.resolved_at = now();
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    const cleanup = setTimeout(() => {
      if (records.get(rec.id) === rec) records.delete(rec.id);
    }, 30000);
    if (cleanup.unref) cleanup.unref();
    const resolve = rec.resolve;
    rec.resolve = null;
    if (resolve) resolve({ decision: decision, reason: rec.reason });
  }

  function create(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw { code: 'bad_request', message: 'approval request must be an object' };
    }
    const paneId = cleanString(input.pane_id, 80).trim();
    const toolName = cleanString(input.tool_name, 120).trim();
    if (!/^[A-Za-z0-9:_-]{1,80}$/.test(paneId)) {
      throw { code: 'bad_request', message: '"pane_id" is required and must look like a herdr pane id' };
    }
    if (!toolName) throw { code: 'bad_request', message: '"tool_name" is required' };
    const toolInput = input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input)
      ? input.tool_input : {};
    const view = toolView(toolName, toolInput, input.tool_input_truncated);
    const id = 'ap-' + now().toString(36) + '-' + random(4).slice(0, 8);
    const createdAt = now();
    let resolveFn = null;
    const wait = new Promise((resolve) => { resolveFn = resolve; });
    const rec = {
      id: id,
      pane_id: paneId,
      session_id: cleanString(input.session_id, 200),
      cwd: cleanString(input.cwd, 1000),
      permission_mode: cleanString(input.permission_mode, 60),
      tool_name: toolName,
      title: view.title,
      summary: view.summary,
      preview: view.preview,
      input_truncated: view.input_truncated,
      created_at: createdAt,
      expires_at: createdAt + timeoutMs,
      status: 'pending',
      decision: null,
      reason: '',
      resolve: resolveFn,
      wait: wait,
      timer: null,
    };
    rec.timer = removeLater(rec);
    records.set(id, rec);
    return rec;
  }

  function list(paneId) {
    const id = cleanString(paneId, 80);
    const out = [];
    for (const rec of records.values()) {
      if (rec.pane_id !== id || rec.status !== 'pending') continue;
      out.push({
        id: rec.id,
        pane_id: rec.pane_id,
        tool_name: rec.tool_name,
        title: rec.title,
        summary: rec.summary,
        preview: rec.preview,
        input_truncated: rec.input_truncated,
        permission_mode: rec.permission_mode,
        created_at: rec.created_at,
        expires_at: rec.expires_at,
      });
    }
    out.sort((a, b) => a.created_at - b.created_at);
    return out;
  }

  function decide(id, paneId, decision) {
    const rec = records.get(cleanString(id, 120));
    if (!rec) throw { code: 'not_found', message: 'no approval request with that id' };
    if (rec.status !== 'pending') throw { code: 'already_resolved', message: 'this approval was already resolved' };
    if (rec.pane_id !== cleanString(paneId, 80)) {
      throw { code: 'pane_mismatch', message: 'this approval belongs to a different pane' };
    }
    if (decision !== 'allow' && decision !== 'deny') {
      throw { code: 'bad_request', message: '"decision" must be "allow" or "deny"' };
    }
    if (rec.expires_at <= now()) {
      finish(rec, null, 'expired');
      throw { code: 'expired', message: 'this approval expired before a decision' };
    }
    finish(rec, decision, decision === 'allow' ? 'approved in Herdr-Dash' : 'denied in Herdr-Dash');
    return { id: rec.id, decision: rec.decision, reason: rec.reason };
  }

  function cancel(id, reason) {
    const rec = records.get(cleanString(id, 120));
    if (rec && rec.status === 'pending') finish(rec, null, reason || 'cancelled');
  }

  function close() {
    for (const rec of records.values()) {
      if (rec.timer) clearTimeout(rec.timer);
      if (rec.status === 'pending') finish(rec, null, 'server_closed');
    }
    records.clear();
  }

  function authorized(header) {
    const m = /^Bearer\s+([a-f0-9]{32,128})$/i.exec(cleanString(header, 200));
    if (!m) return false;
    const a = Buffer.from(m[1].toLowerCase(), 'utf8');
    const b = Buffer.from(token.toLowerCase(), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function authorizedUi(cookieHeader) {
    const raw = cleanString(cookieHeader, 1000);
    const m = /(?:^|;\s*)hd_approval=([a-f0-9]{32,128})(?:;|$)/i.exec(raw);
    if (!m) return false;
    const a = Buffer.from(m[1].toLowerCase(), 'utf8');
    const b = Buffer.from(uiToken, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  return {
    dir: dir,
    tokenFile: tokenFile,
    token: token,
    uiToken: uiToken,
    timeoutMs: timeoutMs,
    create: create,
    list: list,
    decide: decide,
    cancel: cancel,
    close: close,
    authorized: authorized,
    authorizedUi: authorizedUi,
    _records: records,
  };
}

module.exports = { createApprovalBridge, toolView, DEFAULT_TIMEOUT_MS };
