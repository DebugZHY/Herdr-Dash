#!/usr/bin/env node
'use strict';
/*
 * tools/port-probe.js - "who is on the console port?"
 *
 * One question with three answers, so the launcher can make one decision
 * without sniffing ports or speaking HTTP itself:
 *
 *     exit 0  the herdr-dash console answers /api/status  -> open its page
 *     exit 2  something answers, but it is not the console -> start nothing
 *     exit 1  nothing answers on that port                 -> start the console
 *
 * WHY THIS IS A FILE AND NOT A LINE IN THE LAUNCHER
 * It used to be a single 489-character `set "PROBE=..."` inside
 * herdr-dash.cmd, run as `node -e "%PROBE%"`. That line was itself a batch
 * defect: cmd's GOTO cannot keep its place across a line longer than its scan
 * buffer, so labels later in the file were looked up at a stale byte offset and
 * `goto pipe_denied` failed with "The system cannot find the batch label" -
 * which made the whole elevated-relaunch path unreachable. Which labels broke
 * depended on the OFFSETS, so it appeared and vanished as unrelated lines were
 * added. Moving the code out removed the line, and with it the hazard.
 *
 * It is deliberately NOT folded into tools/hdctl.js. hdctl asks a similar
 * question with different semantics - it JSON-parses the reply and requires
 * `ctl.version` and `app.state` to be strings, and it needs no 2-vs-1 split
 * because it is deciding whether to bind, not whether to open a page. Sharing
 * one implementation would have meant changing one of the two meanings.
 *
 * USAGE
 *     node tools/port-probe.js <port>
 *
 * Prints one short human line. The launcher reads the EXIT CODE only and
 * discards the text, the same way it treats tools/pipe-probe.js.
 *
 * The two timeouts are part of the contract and are unchanged from the inline
 * version: 2500 ms for the real question, 1500 ms for the "is anything at all
 * there?" fallback.
 */

const http = require('node:http');

const STATUS_PATH = '/api/status';
const STATUS_TIMEOUT_MS = 2500;
const FALLBACK_PATH = '/';
const FALLBACK_TIMEOUT_MS = 1500;

/**
 * One GET, never throws. `null` means no answer at all - refused, reset or
 * timed out - which is a different thing from an answer with a bad status.
 */
function get(port, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ code: res.statusCode, body }));
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const EXIT = { console: 0, foreign: 2, nothing: 1 };

async function main() {
  const port = Number(process.argv[2]);

  // The launcher checks the port is a number before it gets here, so this is
  // unreachable from it. Answering "nothing" is the safe answer for a caller
  // that got this far anyway: it starts a console rather than declaring the
  // port occupied by somebody else.
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write('usage: node tools/port-probe.js <port>\n');
    return EXIT.nothing;
  }

  // The console identifies itself by the `ctl` block it puts in /api/status.
  // The check is on the raw body, on purpose: it must not care whether the
  // reply is well-formed JSON, only that this is our page and not something
  // else that happens to hold the port.
  const status = await get(port, STATUS_PATH, STATUS_TIMEOUT_MS);
  if (status && status.code === 200 && status.body.indexOf('ctl') >= 0) {
    process.stdout.write(`console on 127.0.0.1:${port}\n`);
    return EXIT.console;
  }

  // Not the console - but is anything there at all? A single answer of any
  // kind, on any path, is enough: the port is taken by a stranger.
  const other = await get(port, FALLBACK_PATH, FALLBACK_TIMEOUT_MS);
  if (other) {
    process.stdout.write(`127.0.0.1:${port} answers, but not as the console\n`);
    return EXIT.foreign;
  }

  process.stdout.write(`nothing answers on 127.0.0.1:${port}\n`);
  return EXIT.nothing;
}

main().then(
  (code) => { process.exitCode = code; },
  () => { process.exitCode = EXIT.nothing; },
);
