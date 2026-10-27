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

/* ── hermes' clarify panel ──────────────────────────────────────────────────
   A bordered box titled "Hermes needs your input": one status row per question (✓ answered,
   ▸ active, · pending) and, under the active one, its numbered choices plus "Other (type your
   answer)" — a multi-question clarify keeps every question in this one box, answering one
   advances the ▸ mark to the next. The box is drawn at the top of the pane while the input hint
   stays at the bottom, so the blank rows between them can run to dozens and the tail walk used
   for claude never reaches across them. The panel is therefore parsed from its own title, and
   the wrapped continuation rows are folded back into the option they belong to so the label is
   complete rather than cut at the panel's width. */
const HERMES_PANEL_TITLE = /^[╭┌][─━\s]*Hermes needs your input/i;
/* A status row: the marker (answered / active / pending), then the question text — which the
   multi-question panel puts on the rows BELOW the marker instead of beside it, leaving the
   marker alone on its row. */
const HERMES_PANEL_STATUS = /^([✓▸·>])\s*(.*)$/;
/* The panel's own header row ("5 questions") names the count, not a question. */
const HERMES_PANEL_COUNT = /^\d+\s+questions?$/i;
/* A panel choice: an optional cursor, the number, and a label that may be empty — hermes wraps a
   choice whose first token carries no space (a path) onto the rows below, which leaves the first
   row as "1." alone. The dot must be followed by a space or the end of the row, so a wrapped
   continuation that starts with "1.5" or "20261021/" is not mistaken for a choice. */
function panelChoice(line) {
  const m = /^\s*[❯›>]?\s*(\d{1,2})[.)](?:\s+(.*?))?\s*$/.exec(line);
  if (!m) return null;
  return { n: Number(m[1]), label: (m[2] || '').trim() };
}

function detectHermesPanel(lines) {
  let headIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HERMES_PANEL_TITLE.test(inner(lines[i]).trim())) { headIdx = i; break; }
  }
  if (headIdx < 0) return null;

  const options = [];
  let question = '';
  let meta = null;
  let last = null;                       // the option/meta item a continuation row belongs to
  let inActive = true;                   // rows before any status row: a single-question panel
  const stop = Math.min(lines.length, headIdx + 40);
  for (let i = headIdx + 1; i < stop; i++) {
    /* a panel inside a nested layout can be indented: strip the offset so the box border and the
       cursor column still read at the start of the row */
    const raw = String(lines[i]).replace(/^\s+(?=[│┃|])/, '');
    const t = inner(raw).trim();
    if (/^[╰└]/.test(t)) break;                          // the panel's bottom border ends the box
    if (!t) continue;                                    // blank rows inside the box
    if (HERMES_PANEL_COUNT.test(t)) continue;            // "5 questions" — the count, not a question
        const st = HERMES_PANEL_STATUS.exec(t);
        if (st) {
          inActive = st[1] === '▸' || st[1] === '>';
          if (inActive) question = st[2].trim();             // '' when the marker stands on its own row
          last = null;
          continue;
        }
    if (!inActive) continue;                             // a choice or answer of another question
    const it = panelChoice(t);
    if (it) {
      /* the meta check reads the raw label: cleanLabel's "…(type your answer)" strip would hide it */
      const entry = { n: it.n, label: cleanLabel(it.label) };
      if (isMetaOption(it.label)) { if (!meta) { meta = entry; last = meta; } }
      else { options.push(entry); last = options[options.length - 1]; }
      continue;
    }
    /* an unmarked row: the question of a single-question panel, the wrapped rest of it, or the
       wrapped rest of the item above — re-cleaned, since a "(Recommended)" marker can land on the
       wrapped part of a label */
    if (!question) { question = t; continue; }
    if (last) last.label = cleanLabel((last.label + ' ' + t).trim());
    else if (!options.length) question += ' ' + t;
  }
  if (!options.length && !meta) return null;             // nothing answerable inside the box
  return {
    kind: 'hermes_clarify',
    question: question || 'the agent asked a question',
    options: options,
    free_text: !!meta,
    free_text_n: meta ? meta.n : null,
    answer_hint: 'send-keys down to the choice then enter (the panel is arrow-driven); the "Other" item opens a text box',
    raw: lines.slice(headIdx, stop),
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

/* pi's /model picker is a single flat list, no numbers. The current model row leads with
   "→ ✓", the others are plain indented rows; the footer is "Enter to select · Ctrl+S ...".
   Selection is a relative arrow walk from the current row, so the rows are numbered by their
   position (1-based) and highlight_n is the ✓ row's position. */
const PI_MODEL_FOOTER = /enter to select.*ctrl\+s to set as default|ctrl\+s to set as default/i;
function detectPiModel(lines) {
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    if (PI_MODEL_FOOTER.test(inner(lines[i]))) { footerIdx = i; break; }
  }
  if (footerIdx < 0) return null;
  /* walk up from the footer collecting option rows, keeping their order and which is current.
     a row is either the current row "→ ✓ <label>" or a plain indented "<label> [provider]". */
  const rows = [];                                    // { label, current } in top-to-bottom order
  for (let i = footerIdx - 1; i >= 0 && rows.length < 40; i--) {
    const raw = lines[i];
    const t = inner(raw).trim();
    if (!t) continue;                                 // blank lines inside the picker are allowed
    if (isRule(raw)) break;                           // a box rule ends the picker upward
    let label = null, current = false;
    const mCur = /^→\s*✓?\s*(.+)$/.exec(t);
    if (mCur) { label = mCur[1].trim(); current = true; }
    else if (/^\S/.test(t) && t !== '>' && !/model name|model catalog|catalogs refreshed|use \/login|only showing/i.test(t)) { label = t; }
    if (label === null) { if (rows.length) break; else continue; }   // a non-option line ends the list
    rows.unshift({ label, current });
  }
  if (rows.length < 2) return null;
  let highlightN = null;
  const options = rows.map((r, idx) => {
    if (r.current) highlightN = idx + 1;
    return { n: idx + 1, label: r.label };
  });
  return {
    kind: 'pi_model',
    question: 'select a model',
    options,
    free_text: false,
    highlight_n: highlightN,
    answer_hint: 'send-keys up/down to the model then enter',
    raw: lines.slice(Math.max(0, footerIdx - rows.length - 2), footerIdx + 1),
  };
}

/* ── /resume pickers ────────────────────────────────────────────────────────
   Both claude and pi show session lists the dash can switch through, but only the agents'
   own selectors know which sessions exist, so the list is read from the selector itself and
   a switch walks it with the arrow keys. Kept out of detect(): these are not questions to
   answer, and a half-open picker would otherwise surface an unanswerable card. */

/* claude: "Resume session (3 of 49)" then, per session, a title row ("❯ "/"↓ "/indent) and a
   detail row ("14 minutes ago · main · 669.1KB · D:\\path"). ❯ is the selection, ↓ the
   scroll affordance on the last visible row; both are real entries. */
const CLAUDE_RESUME_HEADER = /^\s*Resume session\s*(?:\(\s*(\d+)\s+of\s+(\d+)\s*\))?\s*$/i;
const RESUME_DETAIL = /^(?:\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago|just now|yesterday)\s*·/i;
const RESUME_FOOTER = /^(?:Ctrl\+[A-Za-z]|Esc to cancel|Type to search|Space to preview|tab scope)/i;

function detectClaudeResume(lines) {
  let headIdx = -1;
  let total = null;
  let cursorAbs = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = CLAUDE_RESUME_HEADER.exec(inner(lines[i]));
    if (m) { headIdx = i; total = m[2] ? Number(m[2]) : null; cursorAbs = m[1] ? Number(m[1]) : null; break; }
  }
  if (headIdx < 0) return null;

  for (let i = headIdx; i < lines.length; i++) {
    if (/Loading conversations/i.test(inner(lines[i]))) {
      return { kind: 'claude_resume', loading: true, options: [], highlight_n: null, total: null, cursor_abs: null };
    }
  }

  const options = [];
  let hl = null;
  let pending = null;
  for (let i = headIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const t = inner(raw).trim();
    if (!t) continue;
    if (/[│╭╰╮╯]/.test(raw)) continue;                 // the search box frame
    if (RESUME_FOOTER.test(t)) continue;
    if (/Esc to cancel|Type to search|Space to preview/i.test(t)) continue;   // the footer's second line
    if (RESUME_DETAIL.test(t)) {                        // belongs to the row above it
      if (pending && !pending.detail) pending.detail = t;
      continue;
    }
    const label = t.replace(/^[❯↓↑›>]\s*/, '').trim();
    if (!label) continue;
    pending = { n: options.length + 1, label: label, detail: null };
    options.push(pending);
    if (/^\s*❯\s+/.test(raw)) hl = pending.n;
  }
  return { kind: 'claude_resume', options: options, highlight_n: hl, total: total, cursor_abs: cursorAbs };
}

/* pi: "Resume Session (Current Folder)" … rows "<›| > <preview>  <count> <age>". */
const PI_RESUME_HEADER = /^\s*Resume Session\b/i;
const PI_RESUME_ROW = /^\s*([›»>])?\s*(.*?)\s{2,}(\d+)\s+(now|just now|[\d.]+[a-z]+)\s*$/;
const PI_RESUME_FOOTER = /^(?:tab scope|ctrl\+[a-z]|re:<pattern>)/i;

function detectPiResume(lines) {
  let headIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PI_RESUME_HEADER.test(inner(lines[i]))) { headIdx = i; break; }
  }
  if (headIdx < 0) return null;

  const scope = /\(([^)]*)\)/.exec(inner(lines[headIdx]));
  const options = [];
  let hl = null;
  for (let i = headIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const t = inner(raw).trim();
    if (!t) continue;
    if (PI_RESUME_FOOTER.test(t)) continue;
    if (/^[>›»]?$/.test(t)) continue;                   // the empty search input row
    const m = PI_RESUME_ROW.exec(t);
    if (!m) continue;
    const label = (m[2] || '').trim();
    if (!label) continue;
    const o = { n: options.length + 1, label: label, detail: (m[3] + ' messages · ' + m[4] + ' ago') };
    options.push(o);
    if (m[1] === '›' || m[1] === '»') hl = o.n;
  }
  return { kind: 'pi_resume', options: options, highlight_n: hl, total: options.length || null, scope: scope ? scope[1] : null };
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
  return detectHermesPanel(lines) || detectClaude(lines) || detectPiModel(lines) || detectPiPicker(lines) || detectYn(lines);
}

module.exports = { detect, detectClaudeResume, detectPiResume, _inner: inner, _numbered: numbered };
