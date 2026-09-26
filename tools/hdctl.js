#!/usr/bin/env node
/**
 * herdr-dash control console — CONTRACT-v2 §14 (user's option A, 2026-09-26).
 *
 * ONE file, zero npm dependencies (Node standard library only). It is two things:
 *   * a tiny local service on 127.0.0.1:7432 serving an inline status page + a JSON API,
 *   * the start/stop/restart machinery, in place of the ~330 lines of cmd/PowerShell glue
 *     this console replaced (those files are gone; the rules they enforced are kept here,
 *     because the rules — not the starting — were their real value).
 *
 * THE IDENTITY RULES (unchanged, and the whole point):
 *   * start  — before starting: probe the app port. /api/health answers -> an instance is
 *              already running, never start a second. Something else listens -> REFUSE and
 *              say so (and point at another port). Free -> start.
 *   * stop   — the port's owning PID must be node(.exe) AND its CommandLine must contain
 *              src\server.js AND /api/health must answer with a body containing uptime_ms.
 *              Any leg fails -> REFUSE with the printed reason, and never kill — with ONE
 *              exception: a process this console itself spawned and recorded may be stopped
 *              even when the health leg never answered, so the console can clear an orphan
 *              it made (see stopApp; the pid, the record and the process identity must all
 *              agree, and the result names the leg that was missing).
 *   * never kill by process name. No `taskkill /IM`, no `Stop-Process -Name`, no `wmic`.
 *     Only the verified PID, only when the legs above pass.
 *   * after killing, verify the port is really free and report the truth.
 *
 * HONESTY (§13.2.7, §13.5): every message says what was handed over / what actually
 * happened, never what we hope happened. A running instance this console did not start is
 * reported as `started_by:"external"` and its log is flagged as not ours — because a
 * process we did not spawn may not be writing to our log file at all.
 *
 * FROZEN INTERFACE (other workers build against this; do not change the shapes):
 *   node tools/hdctl.js                        serve 127.0.0.1:7432 (--port N | HD_CTL_PORT)
 *                                              prints: [hdctl] listening on http://127.0.0.1:7432
 *   node tools/hdctl.js status|start|stop|restart [--app-port M]   (env HD_APP_PORT)
 *                                              exit 0 = the operation happened (or the desired
 *                                              state already held); non-zero + reason on stderr
 *                                              = refused. Machine-readable JSON on stdout,
 *                                              human narration on stderr.
 *   GET  /api/status   -> {ok, app:{state,port,pid,uptime_ms,herdr:{version,protocol},
 *                          started_by}, ctl:{port,pid,version}, log:{path,size,rotated}}
 *   GET  /api/log?tail=N -> {ok, path, tail, lines:[...], truncated, size, mine}
 *   POST /api/start|stop|restart -> header `x-hd-ctl-token` + same-origin Origin/
 *                          Sec-Fetch-Site, else 403.
 *
 * ADDITIVE FIELDS beyond the frozen shape, because honesty needs them and extra keys break
 * no reader: `app.why`, `app.orphan`, `app.record_state`, `app.record_note`, `app.herdr.error`,
 * `app.listener_pids`; `log.name`, `log.mine`, `log.from`, `log.files`, `log.server_log`
 * (whether the frozen path `server.log` resolves, and why not when it does not); and
 * `stopped_pid` in a CLI stop answer. `log.path` is the file the tail really came from.
 *
 * THE LOG (round-10 follow-up, defect 3): every start writes a NEW file
 * `_cache/logs/server-<UTC stamp>.log`, and `server.log` is kept as a hardlink to it so the
 * familiar path still resolves. Two rules keep this away from another instance's handle:
 * nothing is ever renamed (names are added or removed, never moved), and the only names
 * hdctl touches are ones whose FILE is one of its own run logs — verified by file identity
 * (dev:ino), so a `server.log` belonging to an instance started outside hdctl is left alone
 * and reported as such. `server.log.1` is the previous run under a second name when it passed
 * ~5 MB. Old per-run logs are never deleted, and the status/log endpoints always name the
 * file the tail really came from.
 *
 * `ctl.pid` is the PID of the process that answered: the long-lived console when the page
 * asked, and the CLI process itself when a `status`/`start`/… command printed it.
 */

'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

// --------------------------------------------------------------------------- constants

const APP_ROOT = path.resolve(__dirname, '..');           // the repo root (…/Herdr-Dash)
const SERVER_JS = path.join(APP_ROOT, 'src', 'server.js');
const HDCTL_VERSION = '1.0.0';

const DEFAULT_CTL_PORT = 7432;
const DEFAULT_APP_PORT = 7433;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;                 // §14: ~5 MB becomes server.log.1
const START_WAIT_MS = 15000;                              // §14: poll /api/health for up to 15 s
const SPAWN_GRACE_MS = START_WAIT_MS + 5000;              // after this, no start is still waiting
const CREATION_SKEW_MS = 120000;                          // record vs OS process start time
const STOP_WAIT_MS = 5000;                                // after the kill, wait for the port
const PROBE_TIMEOUT_MS = 2500;                            // one /api/health read
const CONNECT_TIMEOUT_MS = 700;                           // one TCP connect

// ------------------------------------------------------------------------------- output

function say(line) { process.stderr.write('[hdctl] ' + line + '\n'); }
function fail(line) { process.stderr.write('[hdctl] ' + line + '\n'); }
function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

// --------------------------------------------------------------------------- port probes

/**
 * Every distinct PID that netstat reports LISTENING on the port. netstat is the authority
 * for "who holds this port"; it is read-only and never touches a process. An empty array
 * means nothing listens — or that netstat could not be read, which the caller must not
 * confuse with "free" (see portState).
 */
function listenersOn(port) {
  const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  if (r.error || typeof r.stdout !== 'string') return { pids: [], read: false, error: String((r.error && r.error.message) || 'netstat produced no output') };
  const re = new RegExp('^\\s*TCP\\s+\\S+:' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$', 'i');
  const seen = new Set();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) seen.add(Number(m[1]));
  }
  return { pids: [...seen], read: true, error: null };
}

/** A plain TCP connect: true when something accepted the connection. Loopback refuses instantly. */
function tcpConnect(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(CONNECT_TIMEOUT_MS);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/**
 * The two questions a start/stop decision needs, kept separate on purpose:
 *   pids    — what netstat says (authoritative, names the owner)
 *   connects — did a TCP connect succeed
 * `unknown` is a true third answer: netstat could not be read AND nothing connected. It
 * must never be reported as "free" (an undecided verdict is not a negative one).
 */
async function portState(port) {
  const net_ = listenersOn(port);
  const connects = await tcpConnect(port);
  const listening = net_.pids.length > 0 || connects;
  const unknown = !listening && !net_.read;
  return { port, listening, unknown, pids: net_.pids, connects, netstat_error: net_.error };
}

/** One GET, never throws. `timeout` is a distinct answer from a refused connection. */
function httpGetJson(port, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch { json = null; }
          resolve({ answered: true, status: res.statusCode, body, json, error: null });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ answered: false, status: 0, body: '', json: null, error: 'no answer within ' + timeoutMs + ' ms' }); });
    req.on('error', (e) => { resolve({ answered: false, status: 0, body: '', json: null, error: e.code || e.message }); });
    req.end();
  });
}

/** §14's identity leg: the health body must contain uptime_ms. A 503 with that field counts. */
function isAppHealth(json) {
  return !!json && typeof json.uptime_ms === 'number';
}

// ----------------------------------------------------------------------- process identity

/**
 * Name, CommandLine and creation time of one PID, through PowerShell's CIM — a read-only
 * query, one argv element, no shell, no kill. Returns {exists, name, commandLine, creationMs,
 * error}; `error` means "could not tell", which is never treated as "not ours" without saying so.
 */
function processIdentity(pid) {
  const script =
    "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "'; " +
    "if (-not $p) { Write-Output '{\"exists\":false}' } " +
    "else { [pscustomobject]@{ ProcessId = $p.ProcessId; Name = $p.Name; CommandLine = $p.CommandLine; " +
    "CreationDate = $p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (r.error) return { exists: null, name: null, commandLine: null, creationMs: null, error: String(r.error.message) };
  const out = String(r.stdout || '').trim();
  if (!out) return { exists: null, name: null, commandLine: null, creationMs: null, error: 'PowerShell returned nothing' };
  let j = null;
  try { j = JSON.parse(out); } catch { return { exists: null, name: null, commandLine: null, creationMs: null, error: 'unparseable identity answer: ' + out.slice(0, 120) }; }
  if (j.exists === false) return { exists: false, name: null, commandLine: null, creationMs: null, error: null };
  const created = j.CreationDate ? Date.parse(j.CreationDate) : NaN;
  return { exists: true, name: j.Name || null, commandLine: j.CommandLine || null, creationMs: Number.isFinite(created) ? created : null, error: null };
}

/** §14 stop legs 1 + 2: node(.exe) whose command line names src\server.js. */
function identityVerdict(ident) {
  if (ident.error) return { ok: false, reason: 'the process could not be identified (' + ident.error + ')' };
  if (!ident.exists) return { ok: false, reason: 'the process is already gone' };
  if (!/^node(\.exe)?$/i.test(String(ident.name || ''))) {
    return { ok: false, reason: 'the process is ' + ident.name + ', not node(.exe)' };
  }
  if (!/src[\\/]server\.js/i.test(String(ident.commandLine || ''))) {
    return { ok: false, reason: 'its command line does not run src\\server.js' };
  }
  return { ok: true, reason: null };
}

// ----------------------------------------------------------------------------------- log

function logDir() { return path.join(APP_ROOT, '_cache', 'logs'); }
function legacyLogPath() { return path.join(logDir(), 'server.log'); }   // the familiar name, kept as a hardlink
function rotatedLogPath() { return path.join(logDir(), 'server.log.1'); }
function runLogPath(stamp) { return path.join(logDir(), 'server-' + stamp + '.log'); }

function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }

/**
 * The identity of the FILE a path names, not of the path: two hardlinks to one file share
 * `dev:ino` on NTFS, so this is how a name can be asked "are you a link to a file hdctl
 * made?" without opening or writing anything. `key:null` on an existing file means the
 * volume does not report file ids — a "cannot tell" that is never treated as "ours".
 */
function fileIdentity(p) {
  const st = safeStat(p);
  if (!st || !st.isFile()) return { exists: false, key: null, size: 0 };
  return { exists: true, key: st.ino ? String(st.dev) + ':' + String(st.ino) : null, size: st.size };
}

async function listRunLogs() {
  let names = [];
  try { names = await fsp.readdir(logDir()); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^server-.*\.log$/.test(n)) continue;
    const p = path.join(logDir(), n);
    const st = safeStat(p);
    if (st && st.isFile()) out.push({ name: n, path: p, size: st.size, mtime: st.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * Create this run's log file and point the familiar `server.log` name at it with a hardlink.
 *
 * Two rules make this safe against an instance hdctl did NOT start (§14 follow-up, defect 3):
 *   1. nothing is ever RENAMED — a name is added or removed, and a file already open by
 *      another process keeps its own name and its own bytes either way;
 *   2. the ONLY names this console touches are names whose file is one of its own run logs.
 *      `server.log` is unlinked and re-linked only when its file identity matches a
 *      `server-<stamp>.log` this console wrote. A `server.log` belonging to somebody else
 *      (an externally started instance appending to the familiar path) is LEFT ALONE, and
 *      the caller says so instead of pretending the name is ours.
 *
 * `server.log.1` is the previous run's file under a second name, only when it passed the
 * rotation size, and only when the existing `server.log.1` is absent or ours. Run logs are
 * never deleted.
 */
async function openRunLog() {
  await fsp.mkdir(logDir(), { recursive: true });
  const before = await listRunLogs();                     // read BEFORE this run's file exists
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');  // 20260926T074521
  const runPath = runLogPath(stamp);
  await fsp.writeFile(runPath, '');                       // create a new file (never append to a stranger's)

  const ourKeys = new Set();
  for (const r of before) { const k = fileIdentity(r.path).key; if (k) ourKeys.add(k); }
  const runKey = fileIdentity(runPath).key;
  if (runKey) ourKeys.add(runKey);

  // 1. rotation: link the previous run under its second name — add a name, never move one.
  let rotated = false;
  let rotateNote = null;
  const prev = before.find((r) => r.size >= LOG_ROTATE_BYTES && ourKeys.has(fileIdentity(r.path).key));
  if (prev) {
    const dest = rotatedLogPath();
    const destId = fileIdentity(dest);
    if (!destId.exists || (destId.key && ourKeys.has(destId.key))) {
      try { await fsp.rm(dest, { force: true }); await fsp.link(prev.path, dest); rotated = true; }
      catch (e) { rotateNote = 'the previous run file could not be linked to server.log.1 (' + e.message + ')'; }
    } else {
      rotateNote = 'server.log.1 is not a file this console wrote — left untouched';
    }
  }

  // 2. the familiar name.
  const legacy = legacyLogPath();
  const cur = fileIdentity(legacy);
  const link = { ok: false, error: null, untouched: false };
  if (!cur.exists || (cur.key && ourKeys.has(cur.key))) {
    try {
      if (cur.exists) await fsp.rm(legacy, { force: true });   // the NAME only; the file keeps its run name
      await fsp.link(runPath, legacy);
      link.ok = true;
    } catch (e) { link.error = String(e.message); }
  } else if (!cur.key) {
    link.untouched = true;
    link.error = 'server.log exists but its file identity could not be read on this volume — left untouched; this run\'s log is ' + path.basename(runPath);
  } else {
    link.untouched = true;
    link.error = 'server.log is not a file this console wrote (an instance started outside hdctl may be appending to it) — left untouched; this run\'s log is ' + path.basename(runPath);
  }
  return { path: runPath, name: path.basename(runPath), rotated, rotate_note: rotateNote, link };
}

/**
 * Which file the tail should come from, in order of truth:
 *   * an instance this console started -> the very file it was spawned with (the record),
 *   * an instance started elsewhere     -> the familiar server.log, which is the path such a
 *     start conventionally writes to (and which is flagged as not ours),
 *   * nothing known                     -> the newest run log, else the familiar name.
 */
async function pickLogFile(record, startedBy) {
  if (record && record.log_path) {
    const id = fileIdentity(record.log_path);
    if (id.exists) return { path: record.log_path, name: path.basename(record.log_path), size: id.size, from: 'record' };
  }
  const legacy = fileIdentity(legacyLogPath());
  const runs = await listRunLogs();
  if (startedBy === 'external' && legacy.exists) return { path: legacyLogPath(), name: 'server.log', size: legacy.size, from: 'server_log' };
  // Nothing is known about an owner: show the freshest run log that actually has content,
  // rather than a newer empty file, and fall back to the familiar name. Whichever it is, the
  // answer names it, so the page never implies a file it is not reading.
  const newestWithContent = runs.find((r) => r.size > 0);
  if (newestWithContent) return { path: newestWithContent.path, name: newestWithContent.name, size: newestWithContent.size, from: 'newest_run' };
  if (legacy.exists) return { path: legacyLogPath(), name: 'server.log', size: legacy.size, from: 'server_log' };
  if (runs.length) return { path: runs[0].path, name: runs[0].name, size: runs[0].size, from: 'newest_run' };
  return { path: legacyLogPath(), name: 'server.log', size: 0, from: 'none' };
}

async function logInfo(record, startedBy) {
  const picked = await pickLogFile(record, startedBy);
  const runs = await listRunLogs();
  const legacy = fileIdentity(legacyLogPath());
  const pickedId = fileIdentity(picked.path);
  // Does the familiar name resolve to the file we are actually reading? Say so, either way.
  let serverLogNote = null;
  if (!legacy.exists) serverLogNote = 'server.log does not exist';
  else if (!legacy.key || !pickedId.key) serverLogNote = 'server.log exists; whether it is the file being read could not be determined on this volume';
  else if (legacy.key === pickedId.key) serverLogNote = 'server.log is the file being read';
  else serverLogNote = 'server.log points at a DIFFERENT file than the one being read';
  return {
    path: picked.path,
    name: picked.name,
    size: picked.size,
    rotated: !!safeStat(rotatedLogPath()),
    mine: startedBy === 'hdctl',
    from: picked.from,
    files: runs.length,
    server_log: { path: legacyLogPath(), exists: legacy.exists, size: legacy.size, note: serverLogNote, is_read_file: !!(legacy.key && pickedId.key && legacy.key === pickedId.key) },
  };
}

async function readLogTail(filePath, n) {
  const st = safeStat(filePath);
  if (!st || !st.isFile()) return { lines: [], size: 0, truncated: false, exists: false };
  const want = Math.max(0, Math.min(500, Number(n) || 0));
  const chunk = Math.min(st.size, 512 * 1024);
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(chunk);
    await fh.read(buf, 0, chunk, st.size - chunk);
    let text = buf.toString('utf8');
    // A tail read can start mid-line: drop the first (partial) line when we did not start at 0.
    if (st.size > chunk) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1); }
    const all = text.split(/\r?\n/);
    if (all.length && all[all.length - 1] === '') all.pop();
    const lines = want === 0 ? [] : all.slice(-want);
    return { lines, size: st.size, truncated: all.length > lines.length || st.size > chunk, exists: true };
  } finally { await fh.close(); }
}

// --------------------------------------------------------------------- started_by record

/**
 * One record file PER APP PORT: `_cache/hdctl-<port>.json`. Per-port means two consoles
 * working on different ports can never overwrite each other's record, and a start that
 * loses a race only ever removes an entry that still names its own PID — so the survivor
 * keeps its true record. The record is a memory, never proof: it is only believed when it
 * names the PID that really holds the port.
 *
 * Fields: { app_port, pid, spawned_at, state:"starting"|"running"|"unanswered", log_path }
 */
function recordPath(appPort) { return path.join(APP_ROOT, '_cache', 'hdctl-' + appPort + '.json'); }

async function readRecord(appPort) {
  try {
    const j = JSON.parse(await fsp.readFile(recordPath(appPort), 'utf8'));
    if (!j || typeof j !== 'object') return null;
    if (Number(j.app_port) !== Number(appPort)) return null;   // a record that is not about this port is not ours to use
    return j;
  } catch { return null; }
}

async function writeRecord(appPort, entry) {
  try {
    await fsp.mkdir(path.dirname(recordPath(appPort)), { recursive: true });
    await fsp.writeFile(recordPath(appPort), JSON.stringify({ app_port: appPort, ...entry }, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) { say('could not record the start for port ' + appPort + ' (' + e.message + ') — started_by will read "external"'); return false; }
}

/**
 * A provisional record — the one written at spawn, before anything is known. It yields to a
 * DIFFERENT pid that was recorded within the last SPAWN_GRACE_MS, because that other start
 * may still be in flight (and may be about to own the port). Without this, two concurrent
 * starts could each overwrite the other, and whichever one lost the race would then delete
 * the survivor's record as "its own" — the record loss defect 1 was about. A verified final
 * record (state "running", written from netstat) never yields: it is not a hope, it is the
 * port's owner.
 */
async function writeRecordProvisional(appPort, entry) {
  const cur = await readRecord(appPort);
  if (cur && Number(cur.pid) !== Number(entry.pid) && cur.spawned_at
    && Date.now() - Date.parse(cur.spawned_at) < SPAWN_GRACE_MS) {
    return { written: false, kept: cur.pid, reason: 'a start of pid ' + cur.pid + ' on this port was recorded less than ' + (SPAWN_GRACE_MS / 1000) + ' s ago and looks like it is still in flight, so its record was kept' };
  }
  return { written: await writeRecord(appPort, entry), kept: null, reason: null };
}

/** Remove the record only when it still names `onlyIfPid` — a loser never clears a winner. */
async function removeRecordIfPid(appPort, onlyIfPid) {
  const rec = await readRecord(appPort);
  if (!rec) return false;
  if (onlyIfPid !== null && Number(rec.pid) !== Number(onlyIfPid)) return false;
  try { await fsp.rm(recordPath(appPort), { force: true }); } catch { /* already gone */ }
  return true;
}

// --------------------------------------------------------------------------------- status

/**
 * The whole read-only picture, and the only place /api/health is interpreted. Never throws:
 * a probe that fails is part of the answer.
 */
async function statusPayload(appPort) {
  const ps = await portState(appPort);
  const health = ps.listening ? await httpGetJson(appPort, '/api/health', PROBE_TIMEOUT_MS) : { answered: false, json: null, error: 'nothing is listening on this port' };
  const ourHealth = ps.listening && health.answered && isAppHealth(health.json);

  let state, why;
  if (ourHealth) { state = 'running'; why = null; }
  else if (ps.unknown) { state = 'stopped'; why = 'netstat could not be read and nothing answered a connect — the port looks free, but that could not be confirmed'; }
  else if (ps.listening) {
    state = 'foreign';
    if (!health.answered) why = 'something is listening on ' + appPort + ' but /api/health did not answer' + (health.error ? ' (' + health.error + ')' : '');
    else why = 'something answers /api/health on ' + appPort + ' but not with this app\'s health body (no uptime_ms; HTTP ' + health.status + ')';
  } else { state = 'stopped'; why = null; }

  const pid = ps.pids.length ? ps.pids[0] : null;   // the port's listener, whoever it is
  const rec = await readRecord(appPort);
  const recMatches = !!(rec && pid !== null && Number(rec.pid) === Number(pid));

  const app = {
    state,
    port: appPort,
    pid,
    listener_pids: ps.pids,                          // additive: >1 means an ambiguous port
    uptime_ms: ourHealth ? health.json.uptime_ms : null,
    herdr: ourHealth && health.json.herdr && typeof health.json.herdr === 'object'
      ? { version: health.json.herdr.version ?? null, protocol: health.json.herdr.protocol ?? null }
      : { version: null, protocol: null },
    started_by: null,
  };
  if (state === 'running' && app.herdr.version === null) {
    app.herdr.error = (health.json && health.json.error && (health.json.error.message || health.json.error.code))
      || 'the app answered without a herdr version (herdr may be unreachable)';
  }
  if (state === 'foreign' || state === 'stopped') app.why = why;

  // started_by answers "was it started by this console, or was it already there" — so it
  // comes from the record naming the port's real listener, not from the health answer.
  if (pid !== null) app.started_by = recMatches ? 'hdctl' : 'external';
  app.record_state = recMatches ? (rec.state || null) : null;
  if (rec && !recMatches) {
    app.record_note = 'a start of this console recorded pid ' + rec.pid + ' on port ' + rec.app_port + ', which is not the pid now listening';
  }
  if (recMatches && !ourHealth && rec.state === 'unanswered') {
    // The console's own spawn never answered /api/health and is still holding the port:
    // it is not an app (no health) but it is not a stranger either, and stop can clear it.
    app.orphan = true;
    app.record_note = 'this console spawned pid ' + pid + ' on this port and it never answered /api/health — `stop` can clear it (the record and the process identity agree)';
  } else if (recMatches && !ourHealth && rec.state === 'starting') {
    app.record_note = 'a start of pid ' + pid + ' by this console is recorded and has not answered /api/health yet — a start may still be in flight';
  }

  const log = await logInfo(recMatches ? rec : null, app.started_by);

  return {
    ok: true,
    app,
    ctl: { port: null, pid: process.pid, version: HDCTL_VERSION },
    log,
  };
}

// ------------------------------------------------------------------ app operations (§14)

/**
 * Start, with the port probe in front of it. Returns a result envelope; never throws and
 * never starts a second instance.
 */
async function startApp(appPort) {
  const ps = await portState(appPort);
  if (ps.unknown) {
    return { ok: false, did: 'refused', message: 'the port state could not be determined (netstat could not be read and nothing answered a connect) — refusing to start blindly' };
  }
  if (ps.listening) {
    const health = await httpGetJson(appPort, '/api/health', PROBE_TIMEOUT_MS);
    if (health.answered && isAppHealth(health.json)) {
      return { ok: true, did: 'already_running', message: 'an instance is already running on ' + appPort + ' — /api/health answers there, so no second server was started' };
    }
    return {
      ok: false, did: 'refused',
      message: 'port ' + appPort + ' is held by pid ' + (ps.pids.join(', ') || '(pid unknown)') + ', which does not answer /api/health as this app does — refusing to start a second instance. Use another port: --app-port 8080',
    };
  }

  if (!fs.existsSync(SERVER_JS)) return { ok: false, did: 'refused', message: 'src/server.js is not next to this file (' + SERVER_JS + ')' };

  let opened;
  try { opened = await openRunLog(); }
  catch (e) { return { ok: false, did: 'failed', message: 'could not create this run\'s log file in ' + logDir() + ': ' + e.message }; }

  let fd;
  try { fd = fs.openSync(opened.path, 'a'); }
  catch (e) { return { ok: false, did: 'failed', message: 'could not open the log file ' + opened.path + ': ' + e.message }; }

  let child;
  try {
    // Detached + hidden: closing the page or quitting hdctl must not kill the app, and no
    // console window may appear. stdout/stderr go to the log file (not a pipe — a pipe
    // would tie the app's life to this process).
    child = spawn(process.execPath, [SERVER_JS, '--port', String(appPort)], {
      cwd: APP_ROOT, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
    });
  } catch (e) {
    fs.closeSync(fd);
    return { ok: false, did: 'failed', message: 'could not spawn the server: ' + e.message };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }

  const spawnedPid = child.pid;
  const spawnedAt = new Date().toISOString();
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (e) => { exited = { code: null, signal: null, error: String(e.message) }; });
  child.unref();

  // The provisional record: written at spawn so that a process this console leaves behind
  // is still recognisable as ours (and clearable), and rewritten on success with the pid
  // that really owns the port. It yields to a different start that is still in flight.
  const recorded = await writeRecordProvisional(appPort, { pid: spawnedPid, spawned_at: spawnedAt, state: 'starting', log_path: opened.path });

  // Poll /api/health for up to 15 s, but stop early if the child dies — and say which.
  const t0 = Date.now();
  let health = null;
  while (Date.now() - t0 < START_WAIT_MS) {
    if (exited) break;
    health = await httpGetJson(appPort, '/api/health', PROBE_TIMEOUT_MS);
    if (health.answered && isAppHealth(health.json)) break;
    health = null;
    await new Promise((r) => setTimeout(r, 250));
  }
  const waited = Date.now() - t0;

  if (health) {
    const ps2 = await portState(appPort);
    const listener = ps2.pids.length ? ps2.pids[0] : null;
    if (listener !== null && Number(listener) !== Number(spawnedPid)) {
      // Someone else owns the port we were told was free: our child did not get it. Do not
      // claim the record for a process we did not start.
      const cleaned = await removeRecordIfPid(appPort, spawnedPid);
      return {
        ok: true, did: 'already_running', spawned_pid: spawnedPid, listener_pid: listener, waited_ms: waited, log_path: opened.path,
        message: 'pid ' + listener + ' holds port ' + appPort + ' and answers /api/health, but it is NOT the pid this console spawned (' + spawnedPid + ') — so this console did not start that instance and does not record it as its own'
          + (cleaned ? ' (the provisional record was removed)' : ''),
      };
    }
    const wrote = await writeRecord(appPort, { pid: listener ?? spawnedPid, spawned_at: spawnedAt, state: 'running', log_path: opened.path });
    let note = 'started and answering /api/health after ' + waited + ' ms';
    if (!opened.link.ok) note += ' — the familiar server.log name was not linked (' + opened.link.error + ')';
    if (opened.rotate_note) note += ' — ' + opened.rotate_note;
    if (recorded.reason) note += ' — ' + recorded.reason;
    if (!wrote) note += ' — the start could not be recorded, so started_by will read "external"';
    return {
      ok: true, did: 'started', message: note, spawned_pid: spawnedPid, listener_pid: listener ?? null,
      waited_ms: waited, log_path: opened.path, log_name: opened.name, rotated: opened.rotated, record_written: recorded.written && wrote,
    };
  }

  // It never answered: show the truth (exit code if it died, and the log's last lines).
  const tail = await readLogTail(opened.path, 12);
  if (exited) {
    const cleaned = await removeRecordIfPid(appPort, spawnedPid);
    const still = await portState(appPort);
    return {
      ok: false, did: 'failed', spawned_pid: spawnedPid, waited_ms: waited, log_tail: tail.lines, log_path: opened.path, log_name: opened.name,
      message: 'the server exited' + (exited.code === null ? ' (signal ' + exited.signal + (exited.error ? ', ' + exited.error : '') + ')' : ' with code ' + exited.code) + ' after ' + waited + ' ms without answering /api/health'
        + (still.listening ? ' — and something else now holds port ' + appPort + ' (pids ' + (still.pids.join(', ') || 'unknown') + ')' : '')
        + (cleaned ? '; the provisional record was removed' : ''),
    };
  }

  // Still alive but silent: keep the record (marked unanswered) so `stop` may clear it, and
  // say exactly that.
  await writeRecord(appPort, { pid: spawnedPid, spawned_at: spawnedAt, state: 'unanswered', log_path: opened.path });
  return {
    ok: false, did: 'failed', spawned_pid: spawnedPid, waited_ms: waited, log_tail: tail.lines, log_path: opened.path, log_name: opened.name, orphan: true,
    message: 'pid ' + spawnedPid + ' is still running but /api/health never answered within ' + (START_WAIT_MS / 1000) + ' s — it was NOT reported as started. It still holds port ' + appPort
      + ', and because this console spawned and recorded it, `stop` can clear it (the health leg will be reported as the missing one)',
  };
}

/**
 * Stop, with the three identity legs and the refusal table. Kills exactly one verified PID.
 *
 * The one relaxation: a process this console itself spawned and recorded (same port record,
 * same PID, created at the recorded time) may be stopped when the health leg never answered —
 * otherwise the console could not clear an orphan it made. Legs 1 and 2 still have to pass,
 * and the answer names the leg that was missing.
 */
async function stopApp(appPort) {
  const ps = await portState(appPort);
  if (!ps.listening && ps.pids.length === 0) {
    const rec = await readRecord(appPort);
    const inflight = !!(rec && rec.state === 'starting' && rec.spawned_at && Date.now() - Date.parse(rec.spawned_at) < SPAWN_GRACE_MS);
    const cleaned = inflight ? false : await removeRecordIfPid(appPort, null);
    return {
      ok: true, did: 'nothing_listening',
      message: 'nothing is listening on ' + appPort + ' — nothing to stop'
        + (inflight ? ' (a start of pid ' + rec.pid + ' was recorded less than ' + (SPAWN_GRACE_MS / 1000) + ' s ago and may still be in flight, so its record was kept)' : '')
        + (cleaned ? ' (a stale record for this port was removed)' : ''),
    };
  }
  if (!ps.pids.length) {
    return { ok: false, did: 'refused', message: 'something is listening on ' + appPort + ' but its owning process could not be determined (netstat reported no listener' + (ps.netstat_error ? ': ' + ps.netstat_error : '') + ') — not killing anything' };
  }
  if (ps.pids.length > 1) {
    return { ok: false, did: 'refused', message: 'more than one process listens on ' + appPort + ' (pids ' + ps.pids.join(', ') + ') — this is not a state a single decision can be made in, so nothing was killed' };
  }
  const pid = ps.pids[0];

  const ident = processIdentity(pid);
  const verdict = identityVerdict(ident);
  if (!verdict.ok) {
    if (!ident.exists && ident.error === null) {
      return { ok: false, did: 'refused', message: 'pid ' + pid + ' holds port ' + appPort + ' but "the process is already gone" is the only thing the identity check answered — refusing (re-check the port)' };
    }
    return { ok: false, did: 'refused', message: 'pid ' + pid + ' holds port ' + appPort + ' but ' + verdict.reason + ' — not killing it' };
  }

  const health = await httpGetJson(appPort, '/api/health', PROBE_TIMEOUT_MS);
  const healthOk = health.answered && isAppHealth(health.json);
  let missingLeg = null;
  let orphanCleared = false;
  if (!healthOk) {
    missingLeg = !health.answered
      ? '/api/health did not answer (' + health.error + ')'
      : '/api/health answered without uptime_ms (HTTP ' + health.status + ')';
    const rec = await readRecord(appPort);
    const ours = rec && Number(rec.pid) === Number(pid);
    const created = ident.creationMs;
    const fresh = !!(ours && created && rec.spawned_at && Math.abs(created - Date.parse(rec.spawned_at)) <= CREATION_SKEW_MS);
    const settled = !!(ours && (rec.state === 'unanswered'
      || (rec.state === 'starting' && rec.spawned_at && Date.now() - Date.parse(rec.spawned_at) > SPAWN_GRACE_MS)));
    if (!(ours && fresh && settled)) {
      const why = !ours
        ? 'this console has no record that it spawned pid ' + pid + ' on port ' + appPort
        : !fresh ? 'the record for pid ' + pid + ' on port ' + appPort + ' does not match when that process started (the record is stale)'
          : 'a start of pid ' + pid + ' on port ' + appPort + ' may still be waiting for /api/health';
      return { ok: false, did: 'refused', message: 'pid ' + pid + ' runs src\\server.js but ' + missingLeg + ' — not killing it, because ' + why };
    }
    orphanCleared = true;   // legs 1+2 pass, and the record proves this console made it
  }

  // All the legs that apply passed. Only now, and only this PID (never /IM, never by name).
  const kill = spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const killOut = String((kill.stdout || '') + (kill.stderr || '')).trim();
  if (kill.error || kill.status !== 0) {
    return { ok: false, did: 'failed', pid, message: 'could not stop pid ' + pid + ': ' + (kill.error ? kill.error.message : killOut || 'taskkill exit ' + kill.status) };
  }

  const t0 = Date.now();
  let after = null;
  while (Date.now() - t0 < STOP_WAIT_MS) {
    after = await portState(appPort);
    if (!after.listening) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await removeRecordIfPid(appPort, pid);

  const legNote = orphanCleared ? ' — the ' + missingLeg + ' leg was missing, but this console spawned and recorded that pid, so it was cleared' : '';
  if (after.listening) {
    return { ok: false, did: 'still_listening', pid, message: 'pid ' + pid + ' was killed, but something is STILL listening on ' + appPort + ' (pids ' + (after.pids.join(', ') || 'unknown') + ') — check it with: netstat -ano | findstr :' + appPort + legNote };
  }
  return { ok: true, did: 'stopped', pid, message: 'stopped pid ' + pid + '; port ' + appPort + ' is free — nothing is listening there now' + legNote };
}

/** Stop then start, with the stop's refusal table honoured (a refused stop never starts). */
async function restartApp(appPort) {
  const before = await statusPayload(appPort);
  const previousPid = before.app.pid;
  if (before.app.state === 'foreign' && !before.app.orphan) {
    return { ok: false, did: 'refused', message: 'port ' + appPort + ' is held by something that is not this app (' + before.app.why + ') — refusing to restart' };
  }
  let stopResult = null;
  if (before.app.state === 'foreign' && before.app.orphan) {
    stopResult = await stopApp(appPort);          // the orphan this console made: clear it first
    if (!stopResult.ok) return { ok: false, did: 'refused', message: 'the restart stopped after the stop step refused: ' + stopResult.message, stop: stopResult };
  } else if (before.app.state === 'running') {
    stopResult = await stopApp(appPort);
    if (!stopResult.ok) return { ok: false, did: 'refused', message: 'the restart stopped after the stop step refused: ' + stopResult.message, stop: stopResult };
  }
  const startResult = await startApp(appPort);
  if (startResult.ok) {
    const after = await statusPayload(appPort);
    let message = (previousPid === null ? 'it was not running; started it — ' : 'stopped pid ' + previousPid + ' and started pid ' + after.app.pid + ' — ')
      + (Number(after.app.pid) === Number(previousPid) && previousPid !== null ? 'WARNING: the new listener has the same pid as the old one (Windows reuses pids; check the uptime) ' : '')
      + (startResult.message || '');
    if (stopResult && stopResult.did === 'stopped' && /leg was missing/.test(stopResult.message)) message += ' [the old instance was an orphan that never answered /api/health]';
    return { ok: true, did: 'restarted', previous_pid: previousPid, pid: after.app.pid, message, stop: stopResult, start: startResult };
  }
  return { ok: false, did: startResult.did === 'already_running' ? 'already_running' : 'failed', message: 'the stop step succeeded but the start step did not: ' + startResult.message, stop: stopResult, start: startResult };
}

// ----------------------------------------------------------------------------------- page

const PAGE_TOKEN_KEY = '__HDCTL_TOKEN__';

function page({ ctlPort, appPort, token }) {
  // NOTE: no template literals inside this string (the page's own JS uses concatenation),
  // so nothing here collides with the outer template literal.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>herdr-dash control</title>
<style>
  :root { --bg:#14161a; --card:#1c1f25; --line:#2c313a; --fg:#e6e8ec; --dim:#9aa3b1;
          --ok:#4cc38a; --bad:#e5534b; --warn:#d9a441; --mono:Consolas,'Cascadia Mono',monospace; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 'Segoe UI',system-ui,sans-serif; }
  header { padding:14px 18px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  .dim { color:var(--dim); }
  main { padding:18px; display:flex; flex-direction:column; gap:14px; max-width:1100px; }
  section.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
  .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .row + .row { margin-top:10px; }
  .spacer { flex:1; }
  .badge { display:inline-block; padding:3px 10px; border-radius:999px; font-weight:600; font-size:12px; letter-spacing:.03em; text-transform:uppercase; }
  .badge.running { background:rgba(76,195,138,.15); color:var(--ok); border:1px solid rgba(76,195,138,.4); }
  .badge.stopped { background:rgba(154,163,177,.12); color:var(--dim); border:1px solid var(--line); }
  .badge.foreign { background:rgba(229,83,75,.15); color:var(--bad); border:1px solid rgba(229,83,75,.4); }
  dl { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; margin:12px 0 0; }
  dt { color:var(--dim); }
  dd { margin:0; font-family:var(--mono); word-break:break-all; }
  button { background:#242931; color:var(--fg); border:1px solid var(--line); border-radius:6px;
           padding:7px 14px; font:inherit; cursor:pointer; }
  button:hover:not(:disabled) { background:#2c3340; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  button.primary { border-color:rgba(76,195,138,.5); }
  button.danger { border-color:rgba(229,83,75,.5); }
  .result { margin-top:12px; padding:9px 12px; border-radius:6px; border:1px solid var(--line); white-space:pre-wrap; font-family:var(--mono); font-size:12.5px; }
  .result.ok { border-color:rgba(76,195,138,.45); color:var(--ok); }
  .result.err { border-color:rgba(229,83,75,.45); color:var(--bad); }
  .result.busy { color:var(--warn); }
  pre#logTail { margin:10px 0 0; padding:10px 12px; background:#0f1114; border:1px solid var(--line);
                border-radius:6px; max-height:340px; overflow:auto; font-family:var(--mono); font-size:12.5px;
                white-space:pre-wrap; word-break:break-word; color:#cfd6e0; }
  .warn { color:var(--warn); }
</style>
</head>
<body>
<header>
  <h1>herdr-dash <span class="dim">control console</span></h1>
  <span class="dim" id="ctlLine">…</span>
  <span class="spacer"></span>
  <span class="dim" id="tick">…</span>
</header>
<main>
  <section class="card">
    <div class="row">
      <span class="badge stopped" id="stateBadge">…</span>
      <span class="dim" id="stateWhy"></span>
    </div>
    <dl>
      <dt>app</dt><dd id="fApp">…</dd>
      <dt>pid</dt><dd id="fPid">…</dd>
      <dt>uptime</dt><dd id="fUptime">…</dd>
      <dt>started by</dt><dd id="fBy">…</dd>
      <dt>herdr</dt><dd id="fHerdr">…</dd>
      <dt>log</dt><dd id="fLog">…</dd>
    </dl>
    <div class="row" style="margin-top:14px">
      <button id="bStart" class="primary">Start</button>
      <button id="bStop" class="danger">Stop</button>
      <button id="bRestart">Restart</button>
      <button id="bOpen">Open the app in a new tab</button>
      <button id="bCopy">Copy the app URL</button>
    </div>
    <div id="result" class="result" hidden></div>
  </section>

  <section class="card">
    <div class="row">
      <strong>Server log</strong>
      <span class="dim" id="logMeta">…</span>
      <span class="spacer"></span>
      <button data-tail="30">last 30</button>
      <button data-tail="100">100</button>
      <button data-tail="300">300</button>
      <button id="bLogRefresh">refresh</button>
    </div>
    <div class="dim" id="logFile" style="font-family:var(--mono);margin-top:6px">…</div>
    <pre id="logTail">…</pre>
  </section>
</main>
<script>
(function () {
  var TOKEN = '${PAGE_TOKEN_KEY}';
  var APP_PORT = ${appPort};
  var last = null;
  var busy = false;
  var currentTail = 30;

  function $(id) { return document.getElementById(id); }

  function fmtUptime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    if (d) return d + 'd ' + h + 'h ' + m + 'm';
    if (h) return h + 'h ' + m + 'm ' + r + 's';
    if (m) return m + 'm ' + r + 's';
    return r + 's';
  }
  function fmtBytes(n) {
    if (typeof n !== 'number') return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function show(kind, text) {
    var el = $('result');
    el.hidden = false;
    el.className = 'result ' + kind;
    el.textContent = text;
  }

  function render(st) {
    last = st;
    var app = st.app || {};
    var log = st.log || {};
    var badge = $('stateBadge');
    badge.textContent = app.state;
    badge.className = 'badge ' + app.state;
    var why = app.why || '';
    if (app.state === 'running') {
      why = 'answering /api/health on port ' + app.port;
      if (app.record_note) why += ' · ' + app.record_note;
    } else if (app.orphan) {
      why = app.record_note || 'a process this console started is holding the port without answering /api/health';
    } else if (app.record_note) {
      why += (why ? ' · ' : '') + app.record_note;
    }
    $('stateWhy').textContent = why;
    $('fApp').textContent = '127.0.0.1:' + app.port + (app.state === 'running' ? '  (open http://127.0.0.1:' + app.port + '/)' : '');
    $('fPid').textContent = (app.pid === null || app.pid === undefined) ? '—' : app.pid + (app.state === 'running' ? '' : ' (listener)');
    $('fUptime').textContent = fmtUptime(app.uptime_ms);
    if (app.started_by === 'hdctl') $('fBy').textContent = 'this console (hdctl) — the log below is this instance\\'s output';
    else if (app.started_by === 'external') $('fBy').textContent = 'started outside this console — its output is NOT written by hdctl, so the log shown below may belong to another run';
    else $('fBy').textContent = '—';
    var h = app.herdr || {};
    if (h.version || h.protocol) $('fHerdr').textContent = 'v' + h.version + ' · protocol ' + h.protocol;
    else if (h.error) $('fHerdr').textContent = 'unknown — ' + h.error;
    else $('fHerdr').textContent = app.state === 'running' ? 'unknown — the health answer carries no herdr figures' : '—';
    $('fLog').textContent = (log.path || '—') + ' · ' + fmtBytes(log.size) + (log.rotated ? ' · previous run kept as server.log.1' : '')
      + (log.mine ? '' : (app.state === 'running' || app.orphan ? ' · not written by this console' : ''))
      + (log.server_log && log.server_log.exists && !log.server_log.is_read_file ? ' · ' + log.server_log.note : '');
    $('ctlLine').textContent = 'ctl 127.0.0.1:' + st.ctl.port + ' · hdctl ' + st.ctl.version + ' · pid ' + st.ctl.pid;
    $('tick').textContent = 'updated ' + new Date().toLocaleTimeString();

    var running = app.state === 'running';
    $('bStart').disabled = busy || running || app.orphan === true;
    $('bStart').title = app.orphan ? 'a process this console started still holds the port — stop it first' : (running ? 'already running — this console never starts a second instance' : '');
    $('bStop').disabled = busy || (app.state === 'stopped' && !app.orphan);
    $('bStop').title = (app.state === 'foreign' && !app.orphan) ? 'will be refused: this is not this app' : '';
    $('bRestart').disabled = busy || (app.state === 'foreign' && !app.orphan);
    $('bOpen').disabled = !running;
    $('bOpen').title = running ? '' : 'the app is not answering';
  }

  function load() {
    fetch('/api/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (st) {
      if (st && st.ok) render(st); else show('err', 'the console answered without a status: ' + JSON.stringify(st));
    }).catch(function (e) { show('err', 'the console did not answer: ' + e.message); });
  }

  function loadLog(n) {
    fetch('/api/log?tail=' + n, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      $('logTail').textContent = (d.lines && d.lines.length) ? d.lines.join('\\n') : '(no log lines yet' + (d.mine === false ? ' — and this may not be the running instance\\'s file' : '') + ')';
      var meta = fmtBytes(d.size) + (d.truncated ? ' · showing the tail only' : '') + (d.rotated ? ' · server.log.1 kept' : '') + ' · ' + (d.files || 0) + ' run log' + ((d.files === 1) ? '' : 's') + ' kept';
      $('logMeta').textContent = meta;
      var line = 'reading ' + (d.path || '—');
      if (d.server_log && d.server_log.note) line += ' · ' + d.server_log.note;
      if (d.from === 'record') line += ' · the file this instance was started with';
      if (d.mine === false) line += ' · not written by this console';
      $('logFile').textContent = line;
    }).catch(function (e) { $('logTail').textContent = 'the log could not be read: ' + e.message; });
  }

  function act(verb) {
    if (busy) return;
    busy = true;
    show('busy', verb + '… (this can take up to 15 s: the app is polled until /api/health answers)');
    load();
    fetch('/api/' + verb, { method: 'POST', headers: { 'x-hd-ctl-token': TOKEN } })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        busy = false;
        var b = res.body || {};
        var msg = b.message || (b.error && (b.error.message || b.error.code)) || JSON.stringify(b);
        if (res.status === 200 && b.ok) show('ok', verb + ': ' + msg);
        else show('err', verb + ' refused (' + res.status + '): ' + msg);
        if (b.log_tail && b.log_tail.length) $('logTail').textContent = b.log_tail.join('\\n');
        load(); loadLog(currentTail);
      })
      .catch(function (e) { busy = false; show('err', verb + ' failed: ' + e.message); load(); });
  }

  $('bStart').onclick = function () { act('start'); };
  $('bStop').onclick = function () { act('stop'); };
  $('bRestart').onclick = function () { act('restart'); };
  $('bOpen').onclick = function () { window.open('http://127.0.0.1:' + APP_PORT + '/', '_blank'); };
  $('bCopy').onclick = function () {
    var url = 'http://127.0.0.1:' + APP_PORT + '/';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { show('ok', 'copied the URL: ' + url); },
        function (e) { show('err', 'the browser refused the clipboard (' + (e && e.message ? e.message : 'unknown reason') + ') — the URL is ' + url); });
    } else {
      show('err', 'this browser has no clipboard API — the URL is ' + url);
    }
  };
  $('bLogRefresh').onclick = function () { loadLog(currentTail); };
  Array.prototype.forEach.call(document.querySelectorAll('button[data-tail]'), function (b) {
    b.onclick = function () { currentTail = Number(b.getAttribute('data-tail')); loadLog(currentTail); };
  });

  load(); loadLog(currentTail);
  setInterval(function () { if (!document.hidden && !busy) { load(); loadLog(currentTail); } }, 2000);
})();
</script>
</body>
</html>
`;
  return html.replace(PAGE_TOKEN_KEY, token);
}

// ------------------------------------------------------------------------------- service

function ctlStatus(ctlPort) {
  return { port: ctlPort, pid: process.pid, version: HDCTL_VERSION };
}

function sameOrigin(req, ctlPort) {
  const sfs = String(req.headers['sec-fetch-site'] || '');
  if (sfs === 'same-origin') return true;
  if (sfs && sfs !== 'same-origin') return false;
  const origin = String(req.headers.origin || '');
  return origin === 'http://127.0.0.1:' + ctlPort || origin === 'http://localhost:' + ctlPort;
}

function tokenOk(req, token) {
  const got = String(req.headers['x-hd-ctl-token'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function serve({ ctlPort, appPort }) {
  // Already someone on the ctl port? Distinguish an hdctl from a foreign listener by the
  // SHAPE of its answer (an app instance answers /api/status too — with ctl absent).
  const pre = await portState(ctlPort);
  if (pre.listening) {
    const probe = await httpGetJson(ctlPort, '/api/status', PROBE_TIMEOUT_MS);
    const j = probe.json;
    const isHdctl = !!(j && j.ctl && typeof j.ctl.version === 'string' && j.app && typeof j.app.state === 'string');
    if (isHdctl) {
      say('another hdctl is already serving http://127.0.0.1:' + ctlPort + ' (pid ' + j.ctl.pid + ', version ' + j.ctl.version + ') — not starting a second one.');
      say('open http://127.0.0.1:' + ctlPort + '/ instead.');
      return 0;
    }
    fail('port ' + ctlPort + ' is held by something that is not hdctl (' + (probe.answered ? 'it answered /api/status without a ctl block, HTTP ' + probe.status : 'it did not answer: ' + probe.error) + ') — refusing to bind it. Use another port: --port 7442');
    return 1;
  }
  if (pre.unknown) { fail('port ' + ctlPort + ' state could not be determined (netstat unreadable, nothing connected) — refusing to bind blindly'); return 1; }

  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1:' + ctlPort); } catch { return sendJson(res, 400, { ok: false, error: { code: 'bad_request', message: 'unparseable URL' } }); }
    const route = url.pathname;
    try {
      if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
        const body = page({ ctlPort, appPort, token });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
        return res.end(body);
      }
      if (req.method === 'GET' && route === '/api/status') {
        const st = await statusPayload(appPort);
        st.ctl = ctlStatus(ctlPort);
        return sendJson(res, 200, st);
      }
      if (req.method === 'GET' && route === '/api/log') {
        const rawTail = url.searchParams.get('tail');
        const tail = rawTail === null ? 30 : Number(rawTail);
        if (!Number.isFinite(tail) || tail < 0) {
          return sendJson(res, 400, { ok: false, error: { code: 'bad_request', message: '"tail" must be a number (default 30, cap 500)' } });
        }
        const clamped = Math.min(500, Math.floor(tail));
        const st = await statusPayload(appPort);
        const rec = st.app.started_by === 'hdctl' ? await readRecord(appPort) : null;
        const picked = await pickLogFile(rec, st.app.started_by);
        const read = await readLogTail(picked.path, clamped);
        return sendJson(res, 200, {
          ok: true, path: picked.path, name: picked.name, from: picked.from,
          size: read.size, tail: clamped, lines: read.lines,
          truncated: read.truncated || clamped < tail, mine: st.log.mine, rotated: st.log.rotated,
          files: st.log.files, server_log: st.log.server_log,
        });
      }
      if (req.method === 'POST' && (route === '/api/start' || route === '/api/stop' || route === '/api/restart')) {
        if (!sameOrigin(req, ctlPort)) {
          return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'the request did not come from this console\'s own page (Origin/Sec-Fetch-Site) — no action was taken' } });
        }
        if (!tokenOk(req, token)) {
          return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'a write needs the per-run token in the x-hd-ctl-token header — no action was taken' } });
        }
        // Drain the (unused) body before acting, so a slow client cannot stall the socket.
        req.resume();
        const verb = route.slice('/api/'.length);
        say(verb + ': requested from the page (pid ' + process.pid + ')');
        const result = verb === 'start' ? await startApp(appPort) : verb === 'stop' ? await stopApp(appPort) : await restartApp(appPort);
        say(verb + ': ' + result.did + ' — ' + result.message);
        const st = await statusPayload(appPort);
        st.ctl = ctlStatus(ctlPort);
        // A refusal is not an HTTP failure of the request — it is an answer, and 409 says
        // "the state you asked for was not reached" without pretending the call went wrong.
        return sendJson(res, result.ok ? 200 : 409, {
          ok: result.ok, action: verb, did: result.did, message: result.message,
          pid: st.app.pid, spawned_pid: result.spawned_pid ?? null, listener_pid: result.listener_pid ?? null,
          previous_pid: result.previous_pid ?? null, waited_ms: result.waited_ms ?? null,
          log_path: result.log_path ?? null, log_name: result.log_name ?? null,
          log_tail: result.log_tail ?? null, status: st,
        });
      }
      if (route === '/api/start' || route === '/api/stop' || route === '/api/restart') {
        return sendJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: route + ' needs POST (with the token header)' } });
      }
      if (route === '/api/status' || route === '/api/log') {
        return sendJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: route + ' is GET only' } });
      }
      return sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'no route for ' + req.method + ' ' + route } });
    } catch (e) {
      say('handler failed for ' + req.method + ' ' + route + ': ' + String(e && e.stack ? e.stack : e));
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal', message: String((e && e.message) || e) } });
    }
  });

  try {
    await new Promise((resolve, reject) => {
      const onErr = (e) => { server.removeListener('listening', onUp); reject(e); };
      const onUp = () => { server.removeListener('error', onErr); resolve(); };
      server.once('error', onErr);
      server.once('listening', onUp);
      server.listen(ctlPort, '127.0.0.1');
    });
  } catch (e) {
    fail('the console could not listen on ' + ctlPort + ': ' + e.message);
    return 1;
  }
  say('listening on http://127.0.0.1:' + ctlPort);
  say('app port ' + appPort + ' · logs in ' + logDir());
  return null; // keep serving until the process is stopped
}

// ------------------------------------------------------------------------------------ CLI

const USAGE = [
  'usage:',
  '  node tools/hdctl.js                          serve the control page on 127.0.0.1:7432',
  '  node tools/hdctl.js status                   print the app status as JSON (exit 0)',
  '  node tools/hdctl.js start|stop|restart       do it; exit 0 = it happened, non-zero = refused',
  '',
  'options:',
  '  --port N        the control console\'s own port (default 7432, env HD_CTL_PORT)',
  '  --app-port M    the app port to inspect/control (default 7433, env HD_APP_PORT)',
  '  --help          this text',
  '',
  'stdout carries one JSON object; narration and refusal reasons go to stderr.',
].join('\n');

function parseArgv(argv) {
  const out = { verb: null, ctlPort: DEFAULT_CTL_PORT, appPort: DEFAULT_APP_PORT, help: false, bad: null };
  const envCtl = Number(process.env.HD_CTL_PORT);
  const envApp = Number(process.env.HD_APP_PORT);
  if (Number.isFinite(envCtl) && envCtl > 0) out.ctlPort = Math.floor(envCtl);
  if (Number.isFinite(envApp) && envApp > 0) out.appPort = Math.floor(envApp);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--port' || a === '--app-port') {
      const v = argv[i + 1];
      i += 1;
      if (v === undefined || !/^\d+$/.test(String(v))) { out.bad = a + ' needs a port number, got ' + JSON.stringify(v === undefined ? null : v); continue; }
      const n = Number(v);
      if (n < 1 || n > 65535) { out.bad = a + ' must be 1..65535, got ' + n; continue; }
      if (a === '--port') out.ctlPort = n; else out.appPort = n;
      continue;
    }
    if (/^[a-z]+$/.test(a) && ['status', 'start', 'stop', 'restart'].includes(a)) {
      if (out.verb) { out.bad = 'more than one verb: ' + out.verb + ' and ' + a; continue; }
      out.verb = a;
      continue;
    }
    out.bad = 'unknown option: ' + a;
  }
  return out;
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (args.bad) {
    fail(args.bad);
    process.stderr.write(USAGE + '\n');
    return 2;
  }

  if (!args.verb) return serve({ ctlPort: args.ctlPort, appPort: args.appPort });

  const appPort = args.appPort;
  if (args.verb === 'status') {
    const st = await statusPayload(appPort);
    st.ctl = ctlStatus(args.ctlPort);
    emit(st);
    const a = st.app;
    say('port ' + appPort + ': ' + a.state + (a.state === 'foreign' ? ' — ' + a.why : '') + (a.pid ? ' · pid ' + a.pid : '') + (a.started_by ? ' · started_by ' + a.started_by : ''));
    if (a.state === 'running') say('herdr ' + (a.herdr.version ? 'v' + a.herdr.version + ' protocol ' + a.herdr.protocol : 'unknown (' + (a.herdr.error || 'no figures') + ')') + ' · uptime ' + Math.floor(a.uptime_ms / 1000) + 's · log ' + st.log.name + ' (' + st.log.size + ' bytes' + (st.log.mine ? '' : ', NOT written by hdctl') + ')');
    if (a.orphan) say('orphan: ' + a.record_note);
    return 0;
  }

  const result = args.verb === 'start' ? await startApp(appPort)
    : args.verb === 'stop' ? await stopApp(appPort)
      : await restartApp(appPort);

  const st = await statusPayload(appPort);
  st.ctl = ctlStatus(args.ctlPort);
  emit({
    ok: result.ok, action: args.verb, did: result.did, message: result.message,
    pid: st.app.pid, spawned_pid: result.spawned_pid ?? null, listener_pid: result.listener_pid ?? null,
    stopped_pid: result.did === 'stopped' || result.did === 'still_listening' ? result.pid ?? null : null,
    previous_pid: result.previous_pid ?? null, waited_ms: result.waited_ms ?? null,
    log_path: result.log_path ?? null, log_name: result.log_name ?? null,
    log_tail: result.log_tail ?? null, status: st,
  });
  (result.ok ? say : fail)(args.verb + ': ' + result.did + ' — ' + result.message);
  if (result.log_tail && result.log_tail.length) {
    say('last lines of ' + (result.log_name || st.log.name) + ':');
    for (const l of result.log_tail) process.stderr.write('    ' + l + '\n');
  }
  return result.ok ? 0 : 1;
}

main().then((code) => { if (code !== null && code !== undefined) process.exitCode = code; })
  .catch((e) => { fail('unexpected failure: ' + String(e && e.stack ? e.stack : e)); process.exitCode = 1; });
