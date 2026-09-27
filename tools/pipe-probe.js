#!/usr/bin/env node
'use strict';
/*
 * tools/pipe-probe.js — "can THIS process reach herdr, and if not, why?"
 *
 * A standalone checker with no app server and no listening socket: it opens one
 * fresh connection to the herdr named pipe, sends exactly one `ping`, and turns
 * the answer — or the OS refusal — into a machine-readable verdict.
 *
 * It exists because the control console started from Explorer (Medium integrity)
 * cannot reach a herdr server that was started elevated (High integrity), and
 * both failures used to look like the same wall of text:
 *
 *     connect EPERM  -> the pipe is there, our token may not open it. ELEVATE.
 *     connect ENOENT -> there is no such pipe. herdr is not running. START IT.
 *
 * Those two need opposite fixes, so they get opposite exit codes.
 *
 * USAGE
 *     node tools/pipe-probe.js [--json] [--timeout-ms N]
 *
 *     --json          one line of JSON on stdout (stable keys, JSON.parse-able)
 *     --timeout-ms N  ping timeout in milliseconds (default 5000)
 *
 * EXIT CODES — the primary interface; a launcher branches on these
 *     0  reachable
 *     3  denied  (EPERM/EACCES) — herdr is elevated, we are not
 *     4  missing (ENOENT)       — no pipe with that name
 *     5  any other transport / API failure (timeout, closed, herdr error reply)
 *     2  usage error
 *
 * The pipe path is whatever src/hdr.js resolved (HERDR_SOCKET_PATH or the
 * APPDATA default). This file NEVER re-derives it — one owner, no drift.
 */

const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// The transport module is the single source of truth for the pipe path and the
// error classification. Requiring it must not start anything — it does not.
const hdr = require(path.join(__dirname, '..', 'src', 'hdr.js'));

const DEFAULT_TIMEOUT_MS = 5000;

// ── integrity levels ────────────────────────────────────────────────────────
// `whoami` on PATH is not reliably Windows' own: under Git-bash / MSYS it is a
// coreutils whoami that takes no /groups and prints no SIDs. Resolve the real
// binary by absolute path and fall back only if it is missing.
const WHOAMI = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'whoami.exe')
  : 'whoami.exe';

/**
 * Read an integrity level out of `whoami /groups` output.
 * Matching is on the mandatory-label SIDs, which are locale-independent:
 *   S-1-16-4096 LOW · S-1-16-8192 MEDIUM · S-1-16-12288 HIGH
 * A missing SID yields 'unknown' rather than a guess.
 */
function parseIntegrity(text) {
  if (typeof text !== 'string' || text.indexOf('S-1-16-') < 0) return 'unknown';
  if (/S-1-16-12288\b/.test(text)) return 'HIGH';
  if (/S-1-16-8192\b/.test(text)) return 'MEDIUM';
  if (/S-1-16-4096\b/.test(text)) return 'LOW';
  return 'unknown';
}

/** This process's own integrity level. Never rejects. */
function ownIntegrity() {
  return new Promise((resolve) => {
    const bin = fs.existsSync(WHOAMI) ? WHOAMI : 'whoami';
    execFile(bin, ['/groups'], { windowsHide: true, timeout: 5000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        // Parse the output even on a non-zero exit: a partial listing can still
        // carry the label line, and 'unknown' is a safe answer either way.
        resolve(parseIntegrity(stdout || ''));
      });
  });
}

/**
 * The integrity level of the herdr SERVER process.
 *
 * Deliberately NOT on the fast path: it shells out to PowerShell, which has to
 * Add-Type a P/Invoke helper (~1 s). It is only worth paying for when the ping
 * was denied, because that is the only verdict where the caller's next move
 * depends on how elevated the server is.
 *
 * Returns 'HIGH' | 'MEDIUM' | 'LOW' | null. Uses tools/token-il.ps1; no
 * -ExecutionPolicy flag, which is not needed to run a local script here.
 */
function herdrIntegrity() {
  return new Promise((resolve) => {
    const script = path.join(__dirname, 'token-il.ps1');
    execFile('powershell', ['-NoProfile', '-File', script],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        const m = /integrity=([A-Za-z0-9]+)/.exec(stdout || '');
        const v = m ? m[1].toUpperCase() : '';
        resolve(v === 'HIGH' || v === 'MEDIUM' || v === 'LOW' ? v : null);
      });
  });
}

// ── one ping on one fresh connection ────────────────────────────────────────
function ping(timeoutMs) {
  const started = Date.now();
  return hdr.request('ping', {}, { timeoutMs }).then(
    (pong) => ({
      ok: true,
      ms: Date.now() - started,
      version: pong && typeof pong.version === 'string' ? pong.version : null,
      protocol: pong && Number.isInteger(pong.protocol) ? pong.protocol : null,
    }),
    (err) => ({ ok: false, ms: Date.now() - started, err }),
  );
}

/**
 * Map a thrown HerdrError onto {verdict, code}.
 *
 * `verdict` has only four values (ok/denied/missing/error); `kind` is the wider
 * three-way classification. So a socket refusal that is neither EPERM nor
 * ENOENT — ENOTSOCK, EPIPE — is verdict 'error' while still reporting its errno
 * string as `code`, which is what tells it apart from a timeout.
 */
function classify(err) {
  if (err && err.code === 'pipe_error') {
    // `kind` is set by src/hdr.js on the socket 'error' path.
    const verdict = err.kind === 'denied' ? 'denied' : err.kind === 'missing' ? 'missing' : 'error';
    return { verdict, code: err.errno || null };
  }
  // Our own codes ('timeout', 'pipe_closed') and herdr's error replies are not
  // OS refusals — there is no errno to report, so report the transport code.
  return { verdict: 'error', code: (err && err.code) || null };
}

// ── argv ────────────────────────────────────────────────────────────────────
const USAGE = [
  'usage: node tools/pipe-probe.js [--json] [--timeout-ms N]',
  '',
  '  --json          emit one line of JSON instead of the human line',
  '  --timeout-ms N  ping timeout in milliseconds (default ' + DEFAULT_TIMEOUT_MS + ')',
  '',
  'exit: 0 reachable · 3 denied (EPERM) · 4 missing (ENOENT) · 5 other failure · 2 usage',
].join('\n');

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { json: false, timeoutMs: DEFAULT_TIMEOUT_MS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      opts.json = true;
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a === '--timeout-ms' || a.startsWith('--timeout-ms=')) {
      const raw = a === '--timeout-ms' ? argv[++i] : a.slice('--timeout-ms='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new UsageError(`--timeout-ms needs a positive integer, got ${JSON.stringify(raw)}`);
      }
      opts.timeoutMs = n;
    } else {
      throw new UsageError(`unrecognised argument: ${a}`);
    }
  }
  return opts;
}

// ── verdict → lines and exit code ───────────────────────────────────────────
const EXIT = { ok: 0, denied: 3, missing: 4, error: 5 };

function actionFor(verdict) {
  if (verdict === 'denied') return 'elevate';
  if (verdict === 'missing') return 'start_herdr';
  return null;
}

function humanLine(r) {
  if (r.reachable) {
    const vp = r.version
      ? ` (version ${r.version}${r.protocol == null ? '' : `, protocol ${r.protocol}`})`
      : '';
    return `herdr reachable via ${r.pipe}${vp}`;
  }
  if (r.verdict === 'denied') {
    const server = r.herdr_integrity
      ? `herdr's server is ${r.herdr_integrity}`
      : `herdr's server integrity could not be read (it is likely HIGH)`;
    return `herdr unreachable: access denied (${r.code || 'EPERM'}) — this process is `
      + `${r.own_integrity === 'unknown' ? 'not elevated' : r.own_integrity}, ${server}; run this elevated`;
  }
  if (r.verdict === 'missing') {
    return `herdr unreachable: no pipe at ${r.pipe} (${r.code || 'ENOENT'}) — herdr is not running; start it`;
  }
  const msg = String(r.message || '').replace(/\s+/g, ' ').trim();
  return `herdr unreachable: ${r.code || 'error'}${msg ? ' — ' + (msg.length > 160 ? msg.slice(0, 157) + '...' : msg) : ''}`;
}

function emit(r, opts) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(r) + '\n');
  } else {
    process.stdout.write(humanLine(r) + '\n');
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(String(e.message) + '\n\n' + USAGE + '\n');
    process.exitCode = 2; // main()'s return value is discarded — set it here
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE + '\n');
    process.exitCode = 0;
    return 0;
  }

  // `ownIntegrity` runs beside the ping, never before it: the probe's own token
  // does not depend on the ping, and running them together keeps the reachable
  // path at ~one cheap spawn instead of two round-trips in series.
  const [own, res] = await Promise.all([ownIntegrity(), ping(opts.timeoutMs)]);

  let reachable = false;
  let verdict = 'error';
  let code = null;
  let message = '';
  let version = null;
  let protocol = null;

  if (res.ok) {
    reachable = true;
    verdict = 'ok';
    version = res.version;
    protocol = res.protocol;
  } else {
    const c = classify(res.err);
    verdict = c.verdict;
    code = c.code;
    message = String((res.err && res.err.message) || res.err || 'unknown failure');
  }

  // Only the denied verdict needs the server's own level: it is the only one
  // where "elevate" vs "you are already elevated" changes the advice.
  const herdrIl = verdict === 'denied' ? await herdrIntegrity() : null;

  const out = {
    pipe: hdr.pipe,
    reachable,
    verdict,
    code,
    message,
    version,
    protocol,
    own_integrity: own,
    herdr_integrity: herdrIl,
    action: actionFor(verdict),
  };

  emit(out, opts);
  process.exitCode = EXIT[verdict];
  return process.exitCode;
}

main().catch((e) => {
  // An unexpected throw must still be machine-readable, so the launcher is not
  // left parsing a stack trace.
  const opts = { json: process.argv.includes('--json') };
  const out = {
    pipe: hdr.pipe,
    reachable: false,
    verdict: 'error',
    code: 'probe_error',
    message: String((e && e.message) || e),
    version: null,
    protocol: null,
    own_integrity: 'unknown',
    herdr_integrity: null,
    action: null,
  };
  emit(out, opts);
  process.exitCode = EXIT.error;
});
