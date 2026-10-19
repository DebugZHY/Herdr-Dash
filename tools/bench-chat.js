#!/usr/bin/env node
'use strict';

/**
 * bench-chat — latency probe for one live pane's settings and stream reads.
 *
 *   node tools/bench-chat.js --pane wD:p2 --agent pi
 *   node tools/bench-chat.js --pane w6:p1 --agent hermes --port 7433 --iterations 20
 *
 * Measures, against an already running herdr-dash server:
 *   /api/settings, /api/model, /api/effort (and /api/queue for pi)
 *   /api/agent-stream: connection handshake, then the first live text/tool envelope
 *
 * Every request is a GET. The tool never sends a prompt, never types into a pane, and never
 * calls a POST endpoint, so running it cannot change what an agent is doing. The stream
 * measurement opens a fresh SSE connection and waits for whatever the pane emits on its own;
 * a quiet (idle) pane is reported as "no event within the window", not as an error.
 *
 * Output: one JSON object on stdout with count / p50 / p95 / errors per measurement.
 */

const http = require('node:http');

const EXIT_USAGE = 2;

function usage() {
  return [
    'usage: node tools/bench-chat.js --pane <id> --agent pi|hermes [options]',
    '',
    '  --pane <id>            required; the pane to read',
    '  --agent pi|hermes      required; selects which endpoints apply',
    '  --port <n>             server port (default 7433)',
    '  --host <host>          server host (default 127.0.0.1)',
    '  --iterations <n>       samples per endpoint (default 12)',
    '  --timeout-ms <n>       per-request timeout (default 10000)',
    '  --stream-wait-ms <n>   how long to wait for a live event (default 15000)',
    '  --skip-stream          do not open the SSE connection',
    '  --help                 this text',
  ].join('\n');
}

function parseArgs(argv) {
  const out = {
    pane: '', agent: '', port: 7433, host: '127.0.0.1',
    iterations: 12, timeoutMs: 10000, streamWaitMs: 15000, skipStream: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return undefined;
      i += 1;
      return v;
    };
    if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg === '--pane') out.pane = String(next() || '');
    else if (arg === '--agent') out.agent = String(next() || '').toLowerCase();
    else if (arg === '--port') out.port = Number(next());
    else if (arg === '--host') out.host = String(next() || out.host);
    else if (arg === '--iterations') out.iterations = Number(next());
    else if (arg === '--timeout-ms') out.timeoutMs = Number(next());
    else if (arg === '--stream-wait-ms') out.streamWaitMs = Number(next());
    else if (arg === '--skip-stream') out.skipStream = true;
    else if (arg.startsWith('--')) return { error: 'unknown option ' + arg };
  }
  if (!out.pane) return { error: '--pane is required' };
  if (out.agent !== 'pi' && out.agent !== 'hermes') return { error: '--agent must be "pi" or "hermes"' };
  if (!Number.isFinite(out.port) || out.port < 1 || out.port > 65535) return { error: '--port must be 1..65535' };
  if (!Number.isFinite(out.iterations) || out.iterations < 1 || out.iterations > 200) return { error: '--iterations must be 1..200' };
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 100) return { error: '--timeout-ms must be >= 100' };
  if (!Number.isFinite(out.streamWaitMs) || out.streamWaitMs < 0) return { error: '--stream-wait-ms must be >= 0' };
  out.iterations = Math.floor(out.iterations);
  return out;
}

/* ── measurement helpers ───────────────────────────────────────────────────── */

function nowMs() {
  const t = process.hrtime.bigint();
  return Number(t) / 1e6;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/** Nearest-rank percentile over ascending samples. */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const at = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return round(sorted[at]);
}

/** One GET; resolves with {ms, status, body} and never rejects. */
function getJson(base, pathAndQuery, timeoutMs) {
  return new Promise((resolve) => {
    const started = nowMs();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      result.ms = round(nowMs() - started);
      resolve(result);
    };
    let req;
    try {
      req = http.get(base + pathAndQuery, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          let parseError = null;
          try { body = JSON.parse(text); } catch (e) { parseError = e.message; }
          finish({ status: res.statusCode, body, parseError: parseError || undefined });
        });
        res.on('error', (e) => finish({ error: e.code || e.message }));
      });
    } catch (e) {
      return finish({ error: e.code || e.message });
    }
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(); } catch (e) { /* already gone */ }
      finish({ error: 'timeout' });
    });
    req.on('error', (e) => finish({ error: e.code || e.message }));
  });
}

function summarize(samples, errors, statuses) {
  const ms = samples.slice().sort((a, b) => a - b);
  return {
    count: samples.length,
    errors: errors.length,
    p50_ms: percentile(ms, 50),
    p95_ms: percentile(ms, 95),
    min_ms: ms.length ? round(ms[0]) : null,
    max_ms: ms.length ? round(ms[ms.length - 1]) : null,
    statuses: statuses,
    error_codes: errors.length ? errors.reduce((acc, code) => {
      acc[code] = (acc[code] || 0) + 1;
      return acc;
    }, {}) : {},
  };
}

/** Repeat one GET endpoint and reduce it to count/p50/p95/errors. */
async function measureEndpoint(base, pathAndQuery, iterations, timeoutMs) {
  const samples = [];
  const errors = [];
  const statuses = {};
  for (let i = 0; i < iterations; i += 1) {
    const r = await getJson(base, pathAndQuery, timeoutMs);
    const status = r.status === undefined ? 'no_response' : String(r.status);
    statuses[status] = (statuses[status] || 0) + 1;
    const bad = !r.body || r.body.ok !== true;
    if (r.error) { errors.push(String(r.error)); continue; }
    if (r.parseError) { errors.push('bad_json'); continue; }
    if (r.status !== 200) { errors.push('http_' + r.status); continue; }
    if (bad) {
      const code = r.body && r.body.error && r.body.error.code ? String(r.body.error.code) : 'not_ok';
      errors.push(code);
      continue;
    }
    samples.push(r.ms);
  }
  return summarize(samples, errors, statuses);
}

/* ── the SSE probe ─────────────────────────────────────────────────────────── */

/* A "text" event is any streamed content the reader sees as text or thinking: the bridges
   spell it text_* / thinking_* / reasoning_*. A "tool" event is a tool card's lifecycle. */
const TEXT_TYPES = /^(text_|thinking_|reasoning_)/;
const TOOL_TYPES = /^tool_/;

/**
 * Open a fresh /api/agent-stream connection and time its handshake plus the first live
 * text/tool envelope. Resolves after the wait window (or once both are seen) and always
 * closes the connection, so nothing is left listening.
 */
function probeStream(base, paneId, waitMs, timeoutMs) {
  return new Promise((resolve) => {
    const result = {
      connections: 0,
      handshake_ms: null,
      ready_ms: null,
      first_text_ms: null,
      first_text_type: null,
      first_tool_ms: null,
      first_tool_type: null,
      events: 0,
      event_types: {},
      frames: [],
      error: null,
      note: '',
    };
    if (waitMs === 0) {
      result.note = 'stream probe skipped';
      return resolve(result);
    }
    const started = nowMs();
    let done = false;
    let req = null;
    let timer = null;
    let buf = '';
    const finish = (note) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { if (req) req.destroy(); } catch (e) { /* already gone */ }
      if (note) result.note = note;
      if (result.handshake_ms !== null && result.first_text_ms === null && result.first_tool_ms === null) {
        result.note = result.note || 'no text/tool event within ' + waitMs + ' ms (the pane is probably idle)';
      }
      resolve(result);
    };
    try {
      req = http.get(base + '/api/agent-stream?pane_id=' + encodeURIComponent(paneId), (res) => {
        result.connections = 1;
        result.handshake_ms = round(nowMs() - started);
        if (res.statusCode !== 200) {
          result.error = 'http_' + res.statusCode;
          try { res.resume(); } catch (e) { /* already gone */ }
          return finish('the stream endpoint refused the connection');
        }
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let at;
          while ((at = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, at);
            buf = buf.slice(at + 2);
            let name = '';
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) name = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            let payload = null;
            try { payload = JSON.parse(data); } catch (e) { continue; }
            const elapsed = round(nowMs() - started);
            if (name === 'stream.ready') {
              if (result.frames.length < 20) result.frames.push(name);
              if (result.ready_ms === null) result.ready_ms = elapsed;
              continue;
            }
            if (name !== 'stream' || !payload || typeof payload.type !== 'string') {
              if (name && result.frames.length < 20 && result.frames.indexOf(name) < 0) result.frames.push(name);
              continue;
            }
            result.events += 1;
            if (result.event_types[payload.type] === undefined) result.event_types[payload.type] = 0;
            result.event_types[payload.type] += 1;
            if (result.first_text_ms === null && TEXT_TYPES.test(payload.type)) {
              result.first_text_ms = elapsed;
              result.first_text_type = payload.type;
            }
            if (result.first_tool_ms === null && TOOL_TYPES.test(payload.type)) {
              result.first_tool_ms = elapsed;
              result.first_tool_type = payload.type;
            }
          }
          if (result.first_text_ms !== null && result.first_tool_ms !== null) finish('both a text and a tool event arrived');
        });
        res.on('error', (e) => {
          result.error = e.code || e.message;
          finish('the stream connection failed');
        });
        res.on('end', () => finish('the server closed the stream'));
      });
    } catch (e) {
      result.error = e.code || e.message;
      return finish('the stream connection could not be opened');
    }
    /* No socket idle timeout here: an SSE connection is idle by design, so the wait window
       above is the only bound. A refused or dropped connection still arrives as 'error'. */
    req.on('error', (e) => {
      result.error = result.error || e.code || e.message;
      finish();
    });
    timer = setTimeout(() => finish(), waitMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/* ── main ──────────────────────────────────────────────────────────────────── */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  if (opts.error) {
    process.stderr.write('bench-chat: ' + opts.error + '\n\n' + usage() + '\n');
    return EXIT_USAGE;
  }

  const base = 'http://' + opts.host + ':' + opts.port;
  const q = '?pane_id=' + encodeURIComponent(opts.pane);
  const report = {
    ok: false,
    pane_id: opts.pane,
    agent: opts.agent,
    base: base,
    iterations: opts.iterations,
    generated_at: new Date().toISOString(),
    results: {},
  };

  report.results.settings_get = await measureEndpoint(base, '/api/settings' + q, opts.iterations, opts.timeoutMs);
  report.results.model_get = await measureEndpoint(base, '/api/model' + q, opts.iterations, opts.timeoutMs);
  report.results.effort_get = await measureEndpoint(base, '/api/effort' + q, opts.iterations, opts.timeoutMs);
  if (opts.agent === 'pi') {
    report.results.queue_get = await measureEndpoint(base, '/api/queue' + q, opts.iterations, opts.timeoutMs);
  } else {
    report.results.queue_get = { skipped: 'the queued tray is pi-only' };
  }

  if (opts.skipStream) {
    report.results.agent_stream = { skipped: '--skip-stream' };
  } else {
    report.results.agent_stream = await probeStream(base, opts.pane, opts.streamWaitMs, opts.timeoutMs);
  }

  const r = report.results;
  const jsonOk = ['settings_get', 'model_get', 'effort_get'].every((k) => r[k].count > 0);
  const streamOk = r.agent_stream.skipped
    ? true
    : (r.agent_stream.connections === 1 && !r.agent_stream.error);
  report.ok = jsonOk && streamOk;
  if (!jsonOk) report.note = 'one or more JSON endpoints returned no successful sample';

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  process.stderr.write('bench-chat failed: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exitCode = 1;
});
