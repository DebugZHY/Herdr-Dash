'use strict';

/* promptdetect.js — detect an agent's pending question from the visible terminal
 * text of a blocked pane, and describe how to answer it.
 *
 * Pure, dependency-free, synchronous — unit-tested in Node; the server uses this
 * directly, so it is the single source of truth for the parsing rules.
 *
 * Three agent question shapes, most specific first:
 *
 *   1. claude AskUserQuestion — a numbered list whose footer reads
 *      "Enter to select · ↑/↓ to navigate · Esc to cancel", items "> 1. Red",
 *      "  2. Green", …, usually ending in "N. Type something."/"Chat about this".
 *      Answer = send_text("<n>") (claude maps the typed digit to the item), or
 *      send_text(text) for the "Type something" free-text path.
 *
 *   2. pi inline picker — an arrow list "> red"/"  green", no box, no numbers.
 *      Answer = send-keys up/down then enter (keystrokes, not digits).
 *
 *   3. generic y/n — a trailing "[y/N]" / "(yes/no)" / "yes/no?".
 *      Answer = send_text("y"|"n") — single keystroke, no enter.
 *
 * detect() returns null when nothing is recognised, else
 *   { kind, question, options:[{n,label}], free_text, answer_hint, raw }.
 * Conservative: only fires when the question is still the tail of the visible
 * screen, so an answered / scrolled-away question is NOT detected.
 */

function inner(line) {
  return String(line)
    .replace(/^[│┃|]\s?/, '')
    .replace(/\s?[│┃|]$/, '')
    .trimEnd();
}

function isRule(line) {
  const s = String(line);
  // a horizontal rule, or a hermes box edge/corner line (╭─…─╮, ╰─…─╯, ────)
  return (/[─━═┈┉]/.test(s) && s.replace(/[\s─━═\-_┈┉]/g, '').length === 0 && s.trim().length > 3)
      || /^[╭╰]/.test(s.trim()) && /[╮╯]/.test(s.trim());
}

function numbered(line) {
  const m = /^[❯›>\s]*\s*(\d+)[.)]\s+(.+?)\s*$/.exec(inner(line).trim());
  if (!m) return null;
  return { n: Number(m[1]), label: m[2] };
}
/* numbered, with the label's decoration stripped (used for the options shown to the user). */
function numberedClean(line) {
  const it = numbered(line);
  return it ? { n: it.n, label: cleanLabel(it.label) } : it;
}

const CLAUDE_FOOTER = /enter to select|to navigate|esc to cancel|to select, enter|enter to lock|to lock|enter to set as default|to use this session only/i;
const YN = /(\[\s*y\s*\/\s*n\s*\]|\(\s*y(?:es)?\s*\/\s*n(?:o)?\s*\)|\[\s*y\s*\/\s*N\s*\]|\byes\s*\/\s*no\b)\s*[:?]?\s*$/i;

function isMetaOption(label) {
  return /type something|chat about this|something else|other\s*\(\s*type/i.test(label);
}
/* a "(Recommended)"-style suffix an agent appends to an option label — strip it. */
function cleanLabel(label) {
  let t = String(label);
  /* a trailing "(recommended) ✔"-style marker */
  t = t.replace(/\s*\((?:recommended|type your answer|type something)\)\s*[✔✓]?\s*$/i, '');
  /* claude's /model rows read "kimi-k3                  Custom Opus model (1M context) · $5/$25":
     the model id and its description sit far apart, and the price is noise. Keep "id — desc"
     but drop the price, the parenthesised context size, and collapse the gap. */
  t = t.replace(/\s*[·•]\s*\$.*$/, '');                       // drop "· $5/$25 per Mtok"
  t = t.replace(/\((?:1M|\d+K|\d+M)\s*context\)/i, '');     // drop "(1M context)"
  t = t.replace(/\s{2,}/, ' — ');                              // first wide gap -> an em dash
  t = t.replace(/\s{2,}/g, ' ');                               // any remaining gap -> one space
  return t.trim();
}

function detectClaude(lines) {
  const tailStart = Math.max(0, lines.length - 8);
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= tailStart; i--) {
    if (CLAUDE_FOOTER.test(inner(lines[i]))) { footerIdx = i; break; }
  }
  if (footerIdx < 0) return null;

  const footerText = inner(lines[footerIdx]);
  /* claude has two numbered selectors: AskUserQuestion answers a typed digit, but /model's
     picker ignores typed digits and is arrow-driven (verified live). Tell them apart by the
     footer so the answer goes out as the right kind of input. */
  const kindName = /enter to lock|to lock/i.test(footerText) ? 'hermes_clarify'
    : /set as default|use this session only/i.test(footerText) ? 'claude_model'
    : 'claude_ask';
  const collected = [];
  let firstItemIdx = -1;
  let i = footerIdx - 1;
  let gap = 0;
  let highlightN = null;                        // the ❯-marked row (claude /model opens on the current model)
  while (i >= 0 && gap < 12) {
    const it = numbered(lines[i]);
    if (it) {
      collected.push({ idx: i, it });
      if (firstItemIdx < 0 || i < firstItemIdx) firstItemIdx = i;
      if (/❯/.test(lines[i])) highlightN = it.n;
      gap = 0;
    } else {
      gap++;                                    // blank, rule, or option description line
    }
    i--;
  }
  if (!collected.length || firstItemIdx < 0) return null;
  const all = collected.map((c) => ({ n: c.it.n, label: cleanLabel(c.it.label), meta: isMetaOption(c.it.label) })).sort((a, b) => a.n - b.n);
  const options = all.filter((o) => !o.meta).map((o) => ({ n: o.n, label: o.label }));
  const meta = all.find((o) => o.meta);
  const freeText = !!meta;

  let question = '';
  for (let j = firstItemIdx - 1; j >= 0; j--) {
    const t = inner(lines[j]).trim();
    if (isRule(lines[j])) break;
    if (!t) continue;
    if (/^[☐☑]/.test(t)) continue;                       // the "☐ Color" title line
    const clean = t.replace(/^[▸►›→]\s*/, '');
    if (/\?/.test(clean) || /[：:]$/.test(clean)) { question = clean; break; }  // prefer a real question / prompt
    if (!question) question = clean;                     // else nearest non-empty line
  }

  return {
    kind: kindName,
    question: question || 'the agent asked a question',
    options: options,
    free_text: freeText,
    free_text_n: freeText ? meta.n : null,
    highlight_n: highlightN,
    answer_hint: 'send_text the option number (e.g. "2"); for free text, first send_text the "Type something" number then send_text your text',
    raw: lines.slice(Math.max(0, firstItemIdx - 4), footerIdx + 1),
  };
}

function detectPiPicker(lines) {
  const tailStart = Math.max(0, lines.length - 14);
  const items = [];
  let firstIdx = -1;
  let lastIdx = -1;
  let active = false;
  for (let i = tailStart; i < lines.length; i++) {
    const raw = lines[i];
    const t = inner(raw).trim();
    const arrowed = /^\s*[❯›>]/.test(raw) && !/^\s*[❯›>]\s*\d/.test(raw);
    /* a lone prompt glyph or a "/cmd" echo on the input line (e.g. claude re-printing
       "❯ /model" after the picker closed) is NOT a picker row */
    const isInputEcho = /^[❯›>]\s*\//.test(t);
    if (arrowed && t.length > 0 && !/\?/.test(t) && !isInputEcho) {
      active = true;
      items.push({ n: items.length + 1, label: t.replace(/^[❯›>]\s*/, '') });
      if (firstIdx < 0) firstIdx = i;
      lastIdx = i;
      continue;
    }
    // continuation: an indented non-empty, non-rule line right after an arrow item
    if (active && /^\s+\S/.test(raw) && t.length > 0 && !isRule(raw) && !/\?/.test(t) && !CLAUDE_FOOTER.test(t)) {
      items.push({ n: items.length + 1, label: t });
      lastIdx = i;
      continue;
    }
    if (t === '' ) continue;                       // blank lines inside a picker are allowed
    if (isRule(raw)) { if (items.length) break; else continue; }
    active = false;                                 // a real text line ends the picker run
  }
  if (items.length < 2) return null;
  let question = '';
  for (let j = firstIdx - 1; j >= 0 && j > firstIdx - 5; j--) {
    const t = inner(lines[j]).trim();
    if (/\?/.test(t)) { question = t; break; }
    if (isRule(lines[j])) break;
  }
  return {
    kind: 'pi_picker',
    question: question || 'the agent asked you to pick one',
    options: items,
    free_text: false,
    answer_hint: 'send-keys up/down to the option then enter (pi pickers take keystrokes, not digits)',
    raw: lines.slice(Math.max(0, firstIdx - 3), lastIdx + 1),
  };
}

function detectYn(lines) {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const t = inner(lines[i]).trim();
    if (!t) continue;
    if (YN.test(t)) {
      return {
        kind: 'yn',
        question: t.replace(YN, '').trim() || t,
        options: [{ n: 1, label: 'yes' }, { n: 2, label: 'no' }],
        free_text: false,
        answer_hint: 'send_text "y" or "n" (single keystroke, no enter)',
        raw: [lines[i]],
      };
    }
  }
  return null;
}

function detect(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.replace(/\r/g, '').split('\n');
  return detectClaude(lines) || detectPiPicker(lines) || detectYn(lines);
}

module.exports = { detect, _inner: inner, _numbered: numbered };
