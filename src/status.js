'use strict';
/*
 * src/status.js — CONTRACT-v2 §12.3 `GET /api/status?pane_id=<id>` (round 8, owner: W1)
 *
 * INTERPRETATION ONLY. This module owns no transport: src/server.js performs the
 * only reads §12.3.5 allows (one `pane.read` of the pane's visible text, plus one
 * bounded read of a claude session log's tail) and hands the bytes here. Every
 * function below is pure over that input, which is why the parsers can be pinned
 * against §12.3's verbatim fixtures without a pipe and without a pane.
 *
 * THE RULE THIS FILE IS BUILT AROUND: NEVER INVENT A NUMBER.
 *   - The ☤ status line and the `Processes · N running` block are the hermes pane's
 *     OWN rendered text (§12.0: herdr has no structured source for either, and
 *     `state.db`'s `session_model_usage` is cumulative spend, not a context size).
 *     So both are parsed from `pane.read` text and nothing is derived.
 *   - claude prints no limit anywhere — not in its jsonl, not in its footer — so
 *     `context` carries no limit field at all; `limit_tokens` exists only for
 *     hermes, and `until_auto_compact_pct` is claude's own figure on a DIFFERENT
 *     denominator than hermes' `used_pct` (§12.3.2).
 *   - A gap becomes `null` plus a plain-language reason in `absent`. It is never
 *     filled with a plausible value, and a partially-read line says so through
 *     `confidence: "partial"`.
 *   - A GLYPH IS NOT A FIELD. `☤` marks the status line, hermes' footer hint and
 *     its message-box title alike, and `⏵⏵ auto mode on …` is a mode hint, not the
 *     source of claude's numbers. A line is read only when it yields the figures
 *     being claimed (§12.3 4d/4e, both found live rather than by the suite).
 *   - Elision is the agent's: `…` (U+2026) only, and it stays in the text with a
 *     flag beside it. ASCII `...` is ordinary text (the §12.3 fixture's elided
 *     TITLE ends in `...` while its values are complete, and the example JSON has
 *     `elided:false` — hence the codepoint matters).
 *
 * WHAT `source_line` IS, EXACTLY: the pane's own line, with surrounding whitespace
 * trimmed and nothing else changed — same characters the agent painted, including
 * any `…` the agent itself wrote.
 *
 * `absent` keys are dotted paths from the response root (`status.used_pct`,
 * `processes.items[0].last`, `context.until_auto_compact_pct`), so a reader can map
 * a reason onto the field it belongs to.
 */

const fsp = require('node:fs/promises');

// ── the agent's own vocabulary, one constant per glyph ──────────────────────
const ELISION = '…';        // …  the only elision marker (U+2026)
const STATUS_MARK = '☤';    // ☤  the hermes status line
const CACHE_MARK = '◎';     // ◎  the cache-hit figure
const CLOCK_MARK = '◷';     // ◷  the elapsed figure
const TITLE_SEP = '─';      // ─  the `─ <title>` separator
const PROC_MARK = '⚙';      // ⚙  one background process
const BAR = '·';            // ·  the agent's own field separator
const PIPE = '│';           // │  the status line's field separator

/** How much of a claude session log's tail is read for the last usage record.
 *  One read, bounded: a record is a few hundred bytes, so the last assistant
 *  record is inside this window in every session measured here. A session whose
 *  last usage record lies further back is reported absent, never read whole. */
const TAIL_BYTES = 256 * 1024;

// ── small parsers ───────────────────────────────────────────────────────────

/**
 * `~173K` → {tokens: 177152, approx: true}; `1M` → {tokens: 1000000, approx:false}.
 *
 * The two multipliers are §12.3's own frozen example, not a preference: it carries
 * `~173K` as 177152 (= 173 x 1024) beside `1M` as 1000000 (= 10^6). A test asserts
 * exactly that arithmetic so the choice stays visible instead of drifting.
 */
function parseCount(raw) {
  const m = /^(~)?\s*([0-9]+(?:\.[0-9]+)?)\s*([KMG]?)$/i.exec(String(raw == null ? '' : raw).trim());
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[3] || '').toUpperCase();
  const mult = unit === 'K' ? 1024 : unit === 'M' ? 1000000 : unit === 'G' ? 1000000000 : 1;
  return { tokens: Math.round(n * mult), approx: !!m[1] };
}

/** `~173K/1M` → {used, limit}; null when the segment is not a used/limit pair. */
function parseCountPair(seg) {
  const m = /^(~?\s*[0-9]+(?:\.[0-9]+)?\s*[KMG]?)\s*\/\s*(~?\s*[0-9]+(?:\.[0-9]+)?\s*[KMG]?)$/i
    .exec(String(seg || '').trim());
  if (!m) return null;
  const used = parseCount(m[1]);
  const limit = parseCount(m[2]);
  if (!used && !limit) return null;
  return { used, limit };
}

/** The LAST `<n>%` in a segment, with the `~` immediately before it if there is
 *  one (`~17%` is approximate; the bar around it is not a value we carry). */
function pctOf(seg) {
  const re = /(~?)\s*([0-9]+(?:\.[0-9]+)?)\s*%/g;
  let hit = null;
  let m;
  while ((m = re.exec(String(seg || '')))) hit = m;
  if (!hit) return null;
  return { value: Number(hit[2]), approx: hit[1] === '~' };
}

// ── §12.3.1 status: the hermes ☤ line ───────────────────────────────────────

/**
 * Does this line carry the USAGE SHAPE — the `<used>/<limit>` pair, or a ◎/◷
 * figure? A `☤` mark alone is not enough to make a line a status line.
 *
 * DEFECT-19 (§12.3 4d), measured live: `☤` marks three different things in one
 * pane — the status line, the footer hint `☤ ❯ msg=interrupt · /queue · /bg ·
 * /steer · Ctrl+C cancel` (which paints BELOW the status line while a turn is
 * interruptible) and the message-box title `╭─ ☤ Hermes ──╮`. A backwards scan for
 * the mark alone met the hint first and filled `model` with hint text while every
 * figure stayed null. So a candidate must yield at least one figure to be read at
 * all; if none does, the answer is `status:null`, never a field invented from a
 * line that prints no number.
 */
function statusShape(line) {
  const head = String(line).split(new RegExp(`\\s*${TITLE_SEP}\\s*`))[0];
  for (const seg of head.split(PIPE).map((s) => s.trim()).filter(Boolean)) {
    if (seg.includes(CACHE_MARK)) {
      const p = pctOf(seg.slice(seg.indexOf(CACHE_MARK) + CACHE_MARK.length));
      if (p) return 'cache';
    }
    if (seg.includes(CLOCK_MARK)) {
      if (/([0-9]+(?:\.[0-9]+)?)\s*s/i.test(seg.slice(seg.indexOf(CLOCK_MARK)))) return 'elapsed';
    }
    const pair = parseCountPair(seg);
    if (pair && pair.used) return 'pair';
  }
  return null;
}

/**
 * The LAST ☤ line that EARNED the status role (see `statusShape`) — hermes repaints
 * its status just above the prompt, so of the qualifying lines the newest is the
 * lowest. Lines carrying the mark but no figure are counted and named in the reason
 * rather than parsed: a hint is not a status line, and a pane showing only hints has
 * no status line to report.
 *
 * The `─ <title>` tail is cut before parsing: it is a conversation title, not one
 * of the values this object carries, which is also why its elision does not set
 * `elided`. Everything before it (model, used/limit, bar+pct, cache, elapsed) is
 * read by MARKER rather than by position, so a segment hermes drops does not shift
 * the others into the wrong field.
 */
function parseHermesStatus(text, textError) {
  const absent = {};
  const lines = String(text == null ? '' : text).split('\n');
  let line = null;
  let candidates = 0;
  let rejected = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(STATUS_MARK)) continue;
    candidates++;
    if (statusShape(lines[i])) { line = lines[i]; break; }
    rejected++;
  }
  if (line === null) {
    absent.status = text == null
      ? `the pane could not be read${textError ? ` (${textError})` : ''}, so there is no status line to interpret`
      : candidates > 0
        ? `${candidates} ${STATUS_MARK} line(s) in the pane's visible text, but none carries usage figures ("<used>/<limit>", ${CACHE_MARK} or ${CLOCK_MARK}) — ${rejected} of them carry the mark alone (hermes' footer hint and its message-box title do), and the mark on its own is not a status line`
        : `no ${STATUS_MARK} status line in the pane's visible text (${lines.length} line(s) read)`;
    return { status: null, absent };
  }

  const sourceLine = line.trim();
  const head = sourceLine.split(new RegExp(`\\s*${TITLE_SEP}\\s*`))[0].trim();
  const elided = head.includes(ELISION);
  const segs = head.split(PIPE).map((s) => s.trim()).filter(Boolean);

  let model = null;
  let pair = null;
  let usedPct = null;
  let cachePct = null;
  let elapsed = null;

  for (const seg of segs) {
    if (model === null && seg.includes(STATUS_MARK)) {
      const name = seg.split(STATUS_MARK).join('').trim();
      if (name) model = name;
      continue;
    }
    if (seg.includes(CACHE_MARK) && cachePct === null) {
      const p = pctOf(seg.slice(seg.indexOf(CACHE_MARK) + CACHE_MARK.length));
      if (p) cachePct = p.value;
      continue;
    }
    if (seg.includes(CLOCK_MARK) && elapsed === null) {
      const m = /([0-9]+(?:\.[0-9]+)?)\s*s/i.exec(seg.slice(seg.indexOf(CLOCK_MARK)));
      if (m) elapsed = Number(m[1]);
      continue;
    }
    if (pair === null) {
      const p = parseCountPair(seg);
      if (p) { pair = p; continue; }
    }
    if (usedPct === null && seg.includes('%')) {
      const p = pctOf(seg);
      if (p) usedPct = p;
    }
  }

  const usedTokens = pair && pair.used ? pair.used.tokens : null;
  const limitTokens = pair && pair.limit ? pair.limit.tokens : null;
  const approx = !!((pair && pair.used && pair.used.approx)
    || (pair && pair.limit && pair.limit.approx)
    || (usedPct && usedPct.approx));
  const pctValue = usedPct ? usedPct.value : null;

  if (model === null) absent['status.model'] = `the ${STATUS_MARK} status line names no model`;
  if (usedTokens === null) {
    absent['status.used_tokens'] = pair
      ? 'the used figure on the status line could not be read as a number'
      : 'the status line carries no "<used>/<limit>" figure';
  }
  if (limitTokens === null) {
    absent['status.limit_tokens'] = pair
      ? 'the status line prints a used figure with no limit beside it — the limit is not derivable'
      : 'the status line carries no "<used>/<limit>" figure';
  }
  if (pctValue === null) absent['status.used_pct'] = 'the status line carries no percentage';
  if (cachePct === null) absent['status.cache_pct'] = `the status line carries no "${CACHE_MARK} <n>%" cache figure`;
  if (elapsed === null) absent['status.elapsed_s'] = `the status line carries no "${CLOCK_MARK} <n>s" elapsed figure`;

  const complete = model !== null && usedTokens !== null && limitTokens !== null
    && pctValue !== null && cachePct !== null && elapsed !== null;

  return {
    status: {
      source: 'pane_text',
      source_line: sourceLine,
      elided,
      confidence: complete ? 'parsed' : 'partial',
      approx,
      model,
      used_tokens: usedTokens,
      limit_tokens: limitTokens,
      used_pct: pctValue,
      cache_pct: cachePct,
      elapsed_s: elapsed,
    },
    absent,
  };
}

// ── §12.3.3 processes: the hermes background-process block ──────────────────

/** One `⚙ <cmd> · <n>s · last: <text>` line. The command and the last line are the
 *  agent's own text: they are copied, never completed or summarised. */
function parseProcItem(line, absent, at) {
  const rest = String(line).trim().slice(PROC_MARK.length).trim();
  const key = (field) => `processes.items[${at}].${field}`;
  let cmd = rest;
  let age = null;
  let last = null;

  const m = new RegExp(`^(.*?)\\s*${BAR}\\s*([0-9]+)s\\s*${BAR}\\s*last:\\s?(.*)$`).exec(rest);
  if (m) {
    cmd = m[1].trim();
    age = Number(m[2]);
    last = m[3];
  } else {
    const short = new RegExp(`^(.*?)\\s*${BAR}\\s*([0-9]+)s\\s*$`).exec(rest);
    if (short) {
      cmd = short[1].trim();
      age = Number(short[2]);
      absent[key('last')] = 'this process line prints no "last:" output';
    } else {
      absent[key('age_s')] = 'this process line prints no age in seconds';
      absent[key('last')] = 'this process line prints no "last:" output';
    }
  }
  if (!cmd) {
    cmd = rest;
    absent[key('cmd')] = 'this process line prints no command before its age';
  }

  return {
    cmd,
    cmd_elided: cmd.includes(ELISION),
    age_s: age,
    last,
    last_elided: last != null && last.includes(ELISION),
  };
}

/**
 * The last `Processes · N running · <hint>` line plus every `⚙` line directly
 * below it. `running` is the agent's own count — if it disagrees with the number of
 * ⚙ lines the pane shows, that disagreement is disclosed rather than reconciled
 * (hermes elides, and a short pane clips the list).
 *
 * `textError` is set when the caller's `pane.read` failed at all: then there is no
 * text to search, and the reason has to blame the read (naming herdr's code) rather
 * than claim hermes printed no such block.
 */
function parseProcesses(text, textError) {
  const absent = {};
  const lines = String(text == null ? '' : text).split('\n');
  let idx = -1;
  let running = null;
  let hint = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith('Processes') || !/\brunning\b/.test(t)) continue;
    idx = i;
    const m = new RegExp(`^Processes\\s*${BAR}\\s*([0-9]+)\\s*running\\s*(?:${BAR}\\s*(.*))?$`).exec(t);
    if (m) {
      running = Number(m[1]);
      hint = m[2] ? m[2].trim() : null;
    }
    break;
  }

  if (idx < 0) {
    absent.processes = text == null
      ? `the pane could not be read${textError ? ` (${textError})` : ''}, so it is unknown whether anything is running`
      : `no "Processes ${BAR} N running" block in the pane's visible text (${lines.length} line(s) read)`;
    return { processes: null, absent };
  }
  if (running === null) {
    absent['processes.running'] = 'the "Processes" line does not read as "Processes · N running"';
  }
  if (hint === null) {
    absent['processes.hint'] = 'the "Processes" line carries no hint after the running count';
  }

  const items = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (!t.startsWith(PROC_MARK)) break;
    items.push(parseProcItem(t, absent, items.length));
  }
  if (running !== null && running !== items.length) {
    absent['processes.items'] = `hermes says ${running} process(es) are running but prints ${items.length} ${PROC_MARK} line(s) — the rest are not on screen`;
  }

  return {
    processes: { source: 'pane_text', running, hint, items },
    absent,
  };
}

// ── §12.3.2 context: claude's own jsonl + footer ────────────────────────────

/** The last claude footer line in the pane's text, and the two figures claude
 *  itself prints on it. Searched bottom-up, one pattern at a time, because the
 *  `8% until auto-compact` figure and the auto-mode line are sometimes the same
 *  line and sometimes not.
 *
 *  `source_line` is ONLY the line the figure was read from (§12.3 4e). The mode
 *  hint (`⏵⏵ auto mode on …`) and the `/clear to save N tokens` offer are found so
 *  the reason can name what is on screen instead, but neither is presented as the
 *  source of the jsonl's numbers: when the auto-compact figure is not there,
 *  `source_line` is null and `absent['context.source_line']` says why. */
function parseClaudeFooter(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const findLast = (re) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (re.test(t)) return t;
    }
    return null;
  };
  const pctLine = findLast(new RegExp('%\\s*until auto-compact', 'i'));
  const clearLine = findLast(new RegExp('clear to save\\s+[0-9.]+\\s*[kKmM]?\\s*tokens', 'i'));
  const modeLine = findLast(/auto mode on/i);
  const line = pctLine || clearLine || modeLine;
  const pct = pctLine ? Number(new RegExp('([0-9]+(?:\\.[0-9]+)?)\\s*%\\s*until auto-compact', 'i').exec(pctLine)[1]) : null;
  const clear = clearLine
    ? new RegExp('clear to save\\s+([0-9.]+)\\s*([kKmM]?)\\s*tokens', 'i').exec(clearLine)
    : null;
  return {
    has_footer: line !== null,
    source_line: pctLine,
    until_auto_compact_pct: pct,
    clear_tokens: clear ? `${clear[1]}${(clear[2] || '').toLowerCase()}` : null,
  };
}

/**
 * The last assistant record carrying a `usage` object, read from the tail of a
 * session log. ONE bounded read (§12.3.5) — `TAIL_BYTES` from the end, split on
 * newlines, scanned backwards, so the first record found is the newest complete one
 * in the window (the window's own first line may be a partial one; a failed
 * `JSON.parse` skips it, which is the only correct thing to do with a half record).
 *
 * @returns {ok:true, usage, model, ts, mtime_ms, bytes_read} | {ok:false, reason, mtime_ms?}
 */
async function readUsageTail(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
  } catch (e) {
    return { ok: false, reason: `the session log could not be opened (${(e && e.code) || 'error'})` };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, reason: 'the session log path is not a file' };
    if (st.size === 0) return { ok: false, reason: 'the session log is empty', mtime_ms: st.mtimeMs };
    const start = Math.max(0, st.size - TAIL_BYTES);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let rec;
      try { rec = JSON.parse(lines[i]); } catch (e) { continue; }
      const usage = rec && rec.message && rec.message.usage;
      if (rec && rec.type === 'assistant' && usage && typeof usage === 'object') {
        return {
          ok: true,
          usage,
          model: (rec.message && rec.message.model) || rec.model || usage.model || null,
          ts: rec.timestamp || null,
          mtime_ms: st.mtimeMs,
          bytes_read: bytesRead,
          window_start: start,
          file_size: st.size,
        };
      }
    }
    return {
      ok: false,
      reason: `no assistant record carrying a usage figure in the last ${Math.round(TAIL_BYTES / 1024)} KiB of the session log`,
      mtime_ms: st.mtimeMs,
      bytes_read: bytesRead,
    };
  } catch (e) {
    return { ok: false, reason: `the session log could not be read (${(e && e.code) || 'error'})` };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * claude's context block.
 *
 * `tokens` follows §12.3.2's sentence: input + cache_read + cache_creation +
 * output. NOTE, disclosed rather than smoothed over: the example JSON beside the
 * rule shows 145759, which is input + cache_read + cache_creation WITHOUT output
 * (148163 with it). The sentence is normative; the example's arithmetic is not.
 * `the local test suite` pins the sentence's sum so the choice is visible.
 *
 * A usage object missing any of the four counters has no honest total, so the
 * whole block is absent rather than short a term.
 */
function contextFromClaude(tail, footer, textError) {
  const absent = {};
  if (!tail || !tail.ok) {
    absent.context = (tail && tail.reason) || 'there is no session log to read a context figure from';
    return { context: null, absent };
  }
  const u = tail.usage || {};
  const parts = {
    input: u.input_tokens,
    cache_read: u.cache_read_input_tokens,
    cache_create: u.cache_creation_input_tokens,
    output: u.output_tokens,
  };
  const missing = Object.keys(parts).filter((k) => !Number.isFinite(parts[k]));
  if (missing.length) {
    absent.context = `the session log's last assistant record carries no ${missing.join(', ')} token count(s), so no total can be added up`;
    return { context: null, absent };
  }
  const tokens = parts.input + parts.cache_read + parts.cache_create + parts.output;
  const ageS = tail.mtime_ms != null ? Math.max(0, Math.round((Date.now() - tail.mtime_ms) / 1000)) : null;
  if (footer.until_auto_compact_pct === null) {
    absent['context.until_auto_compact_pct'] = textError
      ? `the pane could not be read (${textError}), so its footer is unknown`
      : footer.clear_tokens
        ? `claude's footer offers "clear to save ${footer.clear_tokens} tokens" instead of a "% until auto-compact" figure`
        : 'claude prints no "% until auto-compact" figure on its footer right now';
  }
  if (footer.source_line === null) {
    // §12.3 4e: the tokens come from the jsonl, so the footer line is only the
    // source of the footer figure — with no figure there is no source line, and
    // the mode hint must not be handed out as if it supported these numbers.
    absent['context.source_line'] = textError
      ? `the pane could not be read (${textError}), so its footer is unknown`
      : footer.clear_tokens
        ? 'the footer line on screen offers "/clear to save N tokens" instead of a figure — it is not the source of these numbers'
        : footer.has_footer
          ? "the only footer line on screen is claude's mode hint (\"auto mode on\"), which carries no figure — it is not the source of these numbers"
          : "claude's footer line is not in the pane's visible text";
  }
  if (ageS === null) absent['context.age_s'] = "the session log's own timestamp could not be read";

  return {
    context: {
      source: 'claude_jsonl',
      model: tail.model || null,
      tokens,
      breakdown: {
        input: parts.input,
        cache_read: parts.cache_read,
        cache_create: parts.cache_create,
        output: parts.output,
      },
      until_auto_compact_pct: footer.until_auto_compact_pct,
      source_line: footer.source_line,
      age_s: ageS,
    },
    absent,
  };
}

// ── the shape §12.3 freezes ─────────────────────────────────────────────────

/**
 * Turn the reads into §12.3's three blocks plus `absent` and `lines_read`.
 *
 * @param input {
 *   agent, agent_known,   herdr's names for the pane (agent_known false when
 *                         agent.list has no entry at all)
 *   text, text_error,     the `pane.read` result for `visible` (text null when
 *                         the read was refused, with `text_error` = herdr's code)
 *   claude_tail           the readUsageTail() result for a claude pane
 * }
 * @returns {family, status, context, processes, lines_read, absent}
 *   `lines_read` (§12.3 4b) = how many lines of pane text this answer was
 *   interpreted from, or null when there was no text (a family nothing is parsed
 *   for, or a refused read) — the prose in `absent` names the count too, so a
 *   client that ignores this field still shows a truthful reason.
 */
function interpret(input) {
  const agent = input.agent == null ? '' : String(input.agent);
  const family = agent === 'hermes' ? 'hermes' : agent === 'claude' ? 'claude' : 'other';
  let status = null;
  let context = null;
  let processes = null;
  const absent = {};

  if (family === 'hermes') {
    const s = parseHermesStatus(input.text, input.text_error);
    const p = parseProcesses(input.text, input.text_error);
    status = s.status;
    processes = p.processes;
    Object.assign(absent, s.absent, p.absent);
  } else if (family === 'claude') {
    // §12.3.2: claude's figures are its jsonl's (a real context size) and its own
    // footer's (a percentage on claude's denominator). It prints no ☤ line and no
    // process block — those are hermes' own output, so both are absent WITH the
    // reason said out loud rather than reported as an empty value.
    absent.status = `the ${STATUS_MARK} status line is hermes' own output; this pane runs claude, whose figures are in "context"`;
    absent.processes = `the "Processes ${BAR} N running" block is hermes' own output; this pane runs claude`;
    const footer = parseClaudeFooter(input.text);
    const textError = input.text === null ? (input.text_error || 'the read failed') : null;
    const c = contextFromClaude(input.claude_tail, footer, textError);
    context = c.context;
    Object.assign(absent, c.absent);
  } else {
    const who = agent ? `agent "${agent}"` : 'this pane';
    if (!agent) absent.agent = "herdr's agent list names no agent for this pane";
    absent.status = agent
      ? `${who} is not hermes, so the ${STATUS_MARK} status line is not its output`
      : `${who} has no entry in herdr's agent list — nothing is printing a status line here`;
    absent.context = agent
      ? `${who} is not claude, so there is no session log to read a context figure from`
      : `${who} has no entry in herdr's agent list — no session is bound to it`;
    absent.processes = agent
      ? `${who} is not hermes, so the "Processes ${BAR} N running" block is not its output`
      : `${who} has no entry in herdr's agent list — nothing is printing a process list here`;
  }

  const linesRead = input.text == null ? null : String(input.text).split('\n').length;

  return { family, status, context, processes, lines_read: linesRead, absent };
}

module.exports = {
  TAIL_BYTES,
  ELISION,
  STATUS_MARK,
  PROC_MARK,
  parseCount,
  parseCountPair,
  pctOf,
  parseHermesStatus,
  parseProcesses,
  parseClaudeFooter,
  readUsageTail,
  contextFromClaude,
  interpret,
};
