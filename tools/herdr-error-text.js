'use strict';
/**
 * herdr-error-text — turn a herdr failure into words a person can act on.
 *
 * WHY THIS FILE EXISTS. On Windows herdr's API is a named pipe whose name is the socket
 * file path (CONTRACT.md §2). When the app cannot reach it, the errno that comes back is
 * either a permission problem (`EPERM` — herdr runs elevated and this process does not) or
 * an absence problem (`ENOENT` — nothing is listening). Both used to reach the user as the
 * same wall of text: `unknown — herdr pipe error on ping: connect EPERM \\.\pipe\...`.
 * "unknown" told them nothing, and `EPERM` is not a word.
 *
 * So: ONE pure function decides which of three situations this is and renders the line the
 * console prints plus the one line that says what to DO. Pure — no I/O, no clock, no
 * requires, nothing that can fail at import time. It never throws: the whole body is
 * guarded and anything unrecognisable comes back as kind `other` with the original message
 * preserved verbatim in `raw`, because a message we cannot explain must still be shown,
 * not swallowed.
 *
 * SHAPES. Two callers exist right now, so both shapes are accepted:
 *   new    { kind:'denied'|'missing'|'other', errno:'EPERM', message:'...' }   (app, in flight)
 *   legacy { code:'pipe_error', message:'herdr pipe error on ping: connect EPERM \\.\pipe\...' }
 * and (defensively) a bare string, since an older app may put the text straight in
 * `health.error`. A stated kind of `denied`/`missing` is believed; `other` or absent means
 * we look for evidence ourselves — errno first, then the errno tokens in the message text,
 * so a legacy payload classifies exactly as well as a new one. `denied` wins over `missing`
 * when both appear: an access denial is the precise, actionable diagnosis.
 *
 * HELPERS. `explainHerdrError` is the interface; `isHerdrErrorText` is exported too so the
 * console can tell "this log line is a herdr pipe failure" from any other line before it
 * asks for an explanation of it.
 */

// The default pipe, named the way CONTRACT.md §2 names it: '\\.\pipe\' + the socket path.
const PIPE_PREFIX = '\\\\.\\pipe\\';
const DEFAULT_SOCKET_REL = 'herdr\\herdr.sock';

const DENIED_TOKENS = ['EPERM', 'EACCES'];
const MISSING_TOKENS = ['ENOENT', 'ENOTSOCK', 'timed out'];

// Filled in verbatim from the requirement — the two hints are the point of the file.
const HINT_DENIED = 'herdr is running elevated (Administrator) and this console is not: start herdr-dash from an elevated shell (right-click herdr-dash.cmd \u2192 Run as administrator), or run herdr itself unelevated.';
const SHORT_DENIED = 'herdr unreachable \u2014 access denied (EPERM)';
const SHORT_MISSING = 'herdr unreachable \u2014 no herdr server is listening on this pipe';

/** `\\.\pipe\C:\...\herdr.sock` as it appears inside a message. */
const PIPE_RE = /\\\\\.\\pipe\\[^\s"'`,;)\]]+/;

function str(v) {
  return typeof v === 'string' ? v : null;
}

/**
 * The unmodified message carried by any of the accepted shapes, or null when there is none.
 */
function messageOf(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return null;
  const m = input.message ?? input.error ?? input.errno_message;
  if (typeof m === 'string') return m;
  // An Error-shaped object: use its message but keep its strerror if that is all there is.
  const c = str(input.code);
  return c && c !== 'pipe_error' ? c : null;
}

/**
 * The message without the wrapper the app puts around every pipe failure, so `other` can
 * say `connect ECONNREFUSED \\.\pipe\...` instead of repeating "herdr pipe error on ping".
 */
function reasonOf(message) {
  if (!message) return null;
  const stripped = message.replace(/^\s*(herdr\s+)?pipe error( on [A-Za-z0-9_.-]+)?\s*:\s*/i, '').trim();
  return stripped || message.trim();
}

/** The pipe path named in the message, when the message names one. */
function pipePathIn(message) {
  const m = message ? message.match(PIPE_RE) : null;
  return m ? m[0] : null;
}

/**
 * The pipe we would have used had nothing gone wrong: the pipe the message names if it
 * names one, else HERDR_SOCKET_PATH, else the APPDATA default. Reads env only — no I/O,
 * and every step guarded so a locked-down environment degrades to a description.
 */
function expectedPipe(message) {
  const named = pipePathIn(message);
  if (named) return named;
  try {
    const sock = process.env && process.env.HERDR_SOCKET_PATH;
    if (sock) return PIPE_PREFIX + sock;
    const appdata = process.env && process.env.APPDATA;
    if (appdata) return PIPE_PREFIX + appdata.replace(/[\\/]+$/, '') + '\\' + DEFAULT_SOCKET_REL;
  } catch (e) { /* env unreadable — fall through to the description */ }
  return 'the herdr pipe (HERDR_SOCKET_PATH, or %APPDATA%\\' + DEFAULT_SOCKET_REL + ')';
}

/** Does this text read as an errno, whichever way it is written? */
function hasToken(text, token) {
  if (!text) return false;
  if (text === token) return true;
  return new RegExp('(^|[^A-Za-z0-9_])' + token.replace(/ /g, '\\s+') + '([^A-Za-z0-9_]|$)', 'i').test(text);
}

/**
 * Which situation is this? A stated `denied`/`missing` is believed; otherwise the evidence
 * decides, denied before missing, and no evidence at all means `other`.
 */
function detectKind(input) {
  const stated = str(input && typeof input === 'object' ? input.kind : null);
  if (stated === 'denied' || stated === 'missing') return stated;

  const message = messageOf(input);
  const errno = str(input && typeof input === 'object' ? input.errno : null);
  const evidence = [errno, message];   // errno is the sharper source, so it is asked first

  for (const text of evidence) if (DENIED_TOKENS.some((t) => hasToken(text, t))) return 'denied';
  for (const text of evidence) if (MISSING_TOKENS.some((t) => hasToken(text, t))) return 'missing';
  return 'other';
}

/**
 * explainHerdrError(input) -> { short, hint, raw, kind }
 *
 *   short — the value the console shows.
 *   hint  — the line under it: what to do, or the untouched reason when we cannot say.
 *   raw   — the message exactly as it arrived, for dim secondary text.
 *   kind  — 'denied' | 'missing' | 'other'.
 */
function explainHerdrError(input) {
  let raw = '';
  try {
    const message = messageOf(input);
    raw = message === null ? '' : message;

    const kind = detectKind(input);
    if (kind === 'denied') {
      return { short: SHORT_DENIED, hint: HINT_DENIED, raw, kind };
    }
    if (kind === 'missing') {
      return { short: SHORT_MISSING, hint: 'start herdr, or check HERDR_SOCKET_PATH (expected: ' + expectedPipe(message) + ').', raw, kind };
    }

    const reason = reasonOf(message) || 'herdr reported a failure without saying why';
    return { short: 'herdr unreachable \u2014 ' + reason, hint: raw || reason, raw, kind: 'other' };
  } catch (e) {
    // Nothing above should throw; if something does, the error itself is the only truth
    // left, and the console must not die because a message was shaped oddly.
    const detail = (e && e.message) ? String(e.message) : 'unrecognised herdr error';
    return { short: 'herdr unreachable \u2014 ' + detail, hint: raw || detail, raw, kind: 'other' };
  }
}

/**
 * Is this line of text a herdr pipe failure at all? Used to pick the lines of an app log
 * that deserve an explanation, so unrelated log noise is never fed to the classifier.
 */
function isHerdrErrorText(text) {
  if (typeof text !== 'string' || !text) return false;
  if (/herdr pipe error/i.test(text)) return true;
  const mentionsHerdr = /herdr/i.test(text) && (/(herdr|nope)\.sock/i.test(text) || /\\\\\.\\pipe\\/i.test(text));
  if (!mentionsHerdr) return false;
  return [...DENIED_TOKENS, ...MISSING_TOKENS].some((t) => hasToken(text, t)) || /connect\s+\w*error/i.test(text);
}

module.exports = { explainHerdrError, isHerdrErrorText, expectedPipe };
