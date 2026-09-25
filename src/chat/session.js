'use strict';
/*
 * src/chat/session.js — WHICH session is LIVE in a pane (round 7.6, owner: W1)
 *
 * §9 (DEFECT-17): herdr's `agent_session.value` is a hint, not the truth. When a
 * hermes pane runs `/clear` — or a claude pane starts a new conversation — the
 * agent begins a NEW session and herdr's record keeps the old one, because that
 * record only moves when the agent reports it, and `/clear` does not report.
 *
 * Measured on w4:p7 (2026-09-25), the exact case §9 was written from:
 *   pane text (ANSI stripped)   │  Session: 20260925_111907_781d40  …        <- live
 *   agent.list                  agent_session.value = 20260923_182255_0de6a5 <- stale
 *   hermes state.db             the new id has NO row in `sessions` and NO row
 *                               in `messages` — so the banner is not merely a
 *                               corroboration, for this case it is the ONLY signal.
 *   the app's cursor for the pane was exactly MAX(id) of the old session (3581),
 *   so the view sat at the end of a session that can never grow again.
 *
 * The pane text is UNTRUSTED (markdown/JSON from panes, and a conversation can
 * quote a session id — w6:p1's scrollback does, in prose). Everything below is
 * built so that a wrong switch needs several independent things to line up:
 *   - the field must be a `Session:` field at the START of a line (box-drawing
 *     and whitespace allowed before it, nothing else) — prose mentions are not,
 *     measured against the three live panes that mention the word;
 *   - the id must match hermes' strict shape `\d{8}_\d{6}_[0-9a-f]{6}`;
 *   - the read must carry exactly ONE distinct id, the on-screen one first and
 *     the scrollback second — two banners anywhere is ambiguity, not a guess;
 *   - the id must DIFFER from herdr's and be strictly NEWER (hermes ids are
 *     timestamp-ordered, so "newer" is decidable; a claude uuid is not);
 *   - it must not be a session herdr already binds to a DIFFERENT pane.
 *
 * Signal order (documented; `detected_by` names the winner):
 *   0 reader        an explicit `?session_id=` pick, from the candidates listed
 *   1 pane_banner   the pane's own text (on screen first, scrollback second)
 *   2 store_session hermes `sessions` table: this cwd, newest activity
 *   3 cwd_newest    claude: the newest jsonl under the pane's cwd that PROVES
 *                   the pane's cwd (a claude project dir is named after a slug
 *                   that is not derivable from the cwd — §8.1 — so the file is
 *                   found by mtime and proven by its own `cwd` record)
 *   4 herdr         `agent_session.value` — the fallback, never a veto
 * A declined signal is not an error: it stays in `candidates` with its note.
 *
 * `resolved:false` is a real answer, not a failure: it means the server will not
 * claim to know which session is live (no signal at all, or two candidates it
 * refuses to choose between — §9.5). The caller turns that into an error carrying
 * these fields, so the view says it cannot tell instead of painting a dead
 * session as if it were live.
 */

const hdr = require('../hdr');

const LIMITS = {
  STALE_MS_DEFAULT: 60000,     // §9.4: "~60 s" of a moving pane with a frozen session
  AMBIG_MARGIN_MS: 5000,       // two claude candidates closer than this are ambiguous
  STALE_NOVEL_MIN: 200,        // §9.4: chars of NEW pane text that count as "moving"
  FILE_FRESH_MS: 600000,       // a claude candidate must be written within 10 min
  STORE_FRESH_MS: 600000,      // a hermes `sessions` row must have activity within 10 min
  CAND_MAX: 8,                 // never verify more than this many claude files per poll
  CAND_WINDOW_MS: 900000,      // only files written within 15 min can be candidates
  PANE_LINES_VISIBLE: 60,      // the on-screen read: the banner of a /cleared screen sits here
  PANE_LINES_RECENT: 200,      // the scrollback read: where the banner goes once it scrolls
};

const SIGNALS = {
  READER: 'reader',
  PANE_BANNER: 'pane_banner',
  STORE_SESSION: 'store_session',
  CWD_NEWEST: 'cwd_newest',
  HERDR: 'herdr',
};

/** hermes session ids are `YYYYMMDD_HHMMSS_<6 hex>` — fixed width, so they sort
 *  chronologically as strings, which is what "newer" means everywhere below. */
const HERMES_ID_RE = /^\d{8}_\d{6}_[0-9a-f]{6}$/;

/** A session FIELD, not a mention: start of line (box-drawing/space allowed
 *  before it), then the token. The token charset excludes the box characters and
 *  whitespace, so a bordered row (`│  Session: <id>  research: …`) splits right.
 *
 *  Two labels carry it, both measured on a live hermes pane (round 7.6):
 *    the banner   `│  Session: 20260925_114552_50c6dc  research: …`
 *    `/status`    `Session ID: 20260925_114552_50c6dc`
 *  The bare `Session:` form is checked first and the label is anchored at the
 *  line start, so prose that mentions a session (`the pane banner reads Session: …`)
 *  still cannot bind a reader to a session it only talks about. */
const SESSION_FIELD_RE = /^[\s│┃║|]*Session(?: ID)?:\s*([^\s│┃║|]+)/;

const isHermesSessionId = (v) => typeof v === 'string' && HERMES_ID_RE.test(v);

/** Same rule as chat/claude.js `sameCwd`, kept local so the resolver depends on
 *  no reader: Windows paths are case-insensitive and may arrive with either
 *  separator or a trailing slash. */
function sameCwd(a, b) {
  const norm = (p) => {
    const s = String(p == null ? '' : p).trim().replace(/[\\/]+$/, '');
    const slashed = s.replace(/\\/g, '/');
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
  };
  return !!a && !!b && norm(a) === norm(b);
}

/**
 * Every `Session:` field in a pane read, ANSI-tolerant.
 * @returns {fields, ids, distinct, invalid, last}
 *   fields   one entry per field: {line, token, id|null, text}
 *   ids      the valid ids in text order (duplicates kept)
 *   distinct the valid ids, each once, in text order — >1 means ambiguity
 *   invalid  tokens in a `Session:` field that are NOT session ids (garbage)
 *   last     the last valid id in text order, or null
 */
function paneSessionFields(text) {
  const out = { fields: [], ids: [], distinct: [], invalid: [], last: null };
  if (typeof text !== 'string' || !text) return out;
  const clean = hdr.stripAnsi(text);
  const lines = clean.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = SESSION_FIELD_RE.exec(lines[i]);
    if (!m) continue;
    // Trailing punctuation/quotes are the border of a mention, not part of an id.
    const raw = m[1];
    const token = raw.replace(/[.,;:)\]}>'"`]+$/, '');
    const valid = HERMES_ID_RE.test(token);
    out.fields.push({ line: i + 1, token, id: valid ? token : null, text: lines[i].slice(0, 160) });
    if (valid) {
      out.ids.push(token);
      if (!out.distinct.includes(token)) out.distinct.push(token);
      out.last = token;
    } else {
      out.invalid.push(raw);            // what the pane actually said, for disclosure
    }
  }
  return out;
}

/**
 * One pane line, folded to what counts as CONTENT.
 *
 * A hermes/claude pane is a full-screen TUI: its screen carries a live elapsed
 * timer (`17m │ ⏲ 0s`), a session-age and a pending-turn timer, and any of them
 * ticking must not look like the agent working. So digits fold to `#` and a
 * time unit right after a number folds to `#u` (`17m` → `#u`, `0s` → `#u`,
 * `3h` → `#u` — while `3 days` keeps its word, because `d` there is not the
 * whole token). Whitespace runs collapse within the line.
 *
 * MEASURED (round 7.6, throwaway hermes pane, visible + 200 unwrapped lines
 * sampled every 8 s for 2.5 min, nothing typed into it): with this folding the
 * pane produced ZERO novel lines. Before it, the same pane looked like it was
 * moving on every poll — the whole-text digest also collapsed newlines, so a
 * TUI repaint that merely SCROLLED the window (splash out of the 200-line
 * window, footer redrawn) changed the string without adding one word of content.
 */
function foldPaneLine(line) {
  const s = hdr.stripAnsi(String(line == null ? '' : line))
    .replace(/\d+/g, '#')
    .replace(/#\s?([smhd])\b/g, '#u')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

/** The folded lines of a pane read, blanks dropped, order kept. §9.4's movement
 *  test is over the SET of these (`new lines`), not over the concatenation: a
 *  window that slides shows the same lines in a different slice. */
function foldPaneLines(text) {
  return String(text == null ? '' : text)
    .split(/\r?\n/)
    .map(foldPaneLine)
    .filter((l) => l !== '');
}

/**
 * A digest of the pane text — the same folding, joined into one string, hashed
 * (FNV-1a) and sized. Kept as the cheap equality test ("did this read differ at
 * all?") and for the tests; the MOVEMENT verdict uses foldPaneLines, because a
 * digest of the whole text treats a scrolled window as a change.
 */
function digestPaneText(text) {
  const norm = foldPaneLines(text).join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16) + ':' + norm.length;
}

// ── the resolver ────────────────────────────────────────────────────────────
/**
 * Pure: every input is a value the caller measured (see src/server.js's
 * gatherLiveSession). Nothing here reads a file, a database or the clock.
 *
 * @param {object} input
 *   agent                'hermes' | 'claude' (the agent herdr reports for the pane)
 *   herdr_session_id     herdr's `agent_session.value` (string or null/empty)
 *   pane_text_visible    the pane's on-screen text (may carry ANSI), or null if unread
 *   pane_text_recent     the pane's recent-unwrapped text, or null if unread
 *   store_sessions       hermes, newest first: [{id, cwd, started_at, last_activity_at}]
 *   store_known_ids      hermes: {[id]: true} — ids this store knows for this pane
 *   candidates           claude, newest first: [{id, path, mtimeMs}] verified against the cwd
 *   bound_mtime_ms       claude: mtime of herdr's bound file (null when it has none)
 *   claimed              {[sessionId]: paneId} — ids herdr binds to OTHER panes
 *   reader_pick          `?session_id=` — the reader's explicit choice
 *   now                  ms epoch
 * @returns {resolved, session_id, detected_by, reason, note, corroborated,
 *           candidates:[{id, source, detail}], ambiguous, ambiguous_ids}
 */
function resolvePaneSession(input) {
  const inp = input || {};
  const agent = String(inp.agent || '');
  const now = Number.isFinite(inp.now) ? inp.now : Date.now();
  const herdr = inp.herdr_session_id == null ? '' : String(inp.herdr_session_id);
  const claimed = (inp.claimed && typeof inp.claimed === 'object') ? inp.claimed : {};
  const candidates = [];
  // One entry per (id, signal) — the same id seen in two reads is one candidate,
  // with both reads named, because this list is what the reader is shown.
  const push = (id, source, detail) => {
    const s = id == null ? '' : String(id);
    if (!s) return;
    const same = candidates.find((c) => c.id === s && c.source === source);
    if (same) {
      const parts = String(same.detail || '').split(', ');
      if (detail && !parts.includes(detail)) same.detail = parts.concat(detail).filter(Boolean).join(', ');
      return;
    }
    candidates.push({ id: s, source, detail: detail || null });
  };

  const out = {
    resolved: false,
    session_id: null,
    detected_by: null,
    reason: null,
    note: null,
    corroborated: false,
    candidates,
    ambiguous: false,
    ambiguous_ids: [],
  };

  // ── gather the pane's own fields ──────────────────────────────────────────
  const vis = paneSessionFields(inp.pane_text_visible);
  const rec = paneSessionFields(inp.pane_text_recent);
  const bannerOf = (f, src) => f.distinct.forEach((id) => push(id, SIGNALS.PANE_BANNER, src));
  bannerOf(vis, 'visible');
  bannerOf(rec, 'recent_unwrapped');
  const badTokens = vis.invalid.concat(rec.invalid.filter((t) => !vis.invalid.includes(t)));
  for (const t of badTokens.slice(0, 4)) push(t, SIGNALS.PANE_BANNER, 'not a session id');

  // Exactly one distinct id on screen wins; otherwise exactly one in the
  // scrollback; otherwise (two or more anywhere) it is ambiguity, never a guess.
  let banner = null;
  let bannerSrc = null;
  let ambiguousIds = [];
  if (vis.distinct.length === 1) { banner = vis.distinct[0]; bannerSrc = 'visible'; }
  else if (vis.distinct.length === 0 && rec.distinct.length === 1) { banner = rec.distinct[0]; bannerSrc = 'recent_unwrapped'; }
  else if (vis.distinct.length > 1) ambiguousIds = vis.distinct.slice();
  else if (rec.distinct.length > 1) ambiguousIds = rec.distinct.slice();

  // The store's rows for this cwd, and herdr's value, in the candidate list too:
  // §9.5 says the reader chooses from what was CONSIDERED, not from a hidden set.
  const storeRows = Array.isArray(inp.store_sessions) ? inp.store_sessions.filter((r) => r && r.id) : [];
  for (const r of storeRows.slice(0, 4)) push(r.id, SIGNALS.STORE_SESSION, r.cwd ? `cwd ${r.cwd}` : null);
  const filerows = Array.isArray(inp.candidates) ? inp.candidates.filter((c) => c && c.id) : [];
  for (const c of filerows.slice(0, 6)) push(c.id, SIGNALS.CWD_NEWEST, c.mtimeMs ? `${Math.round((now - c.mtimeMs) / 1000)}s ago` : null);
  if (herdr) push(herdr, SIGNALS.HERDR, 'agent_session.value');
  out.ambiguous_ids = ambiguousIds;

  const byId = (id) => candidates.find((c) => c.id === id) || null;
  const note = (s) => { out.note = out.note || s; };
  const claimOf = (id) => (claimed && claimed[id]) || null;

  /** Can hermes' "newer" be decided at all? Both sides must be strict ids. */
  const newer = (cand, base) => (isHermesSessionId(cand) && isHermesSessionId(base) ? cand > base : null);

  // ── 0. the reader's explicit pick (§9.5 "let the reader choose") ───────────
  // Decided FIRST, and only out of the candidates gathered above: whatever the
  // signals would have said, an id the pane never named cannot be bound.
  if (inp.reader_pick != null && String(inp.reader_pick) !== '') {
    const pick = String(inp.reader_pick);
    if (!byId(pick)) {
      out.resolved = false;
      out.session_id = null;
      out.detected_by = null;
      out.reason = 'pick_not_a_candidate';
      out.note = `${pick} is not one of this pane's candidates — refusing to bind to a session the pane never named`;
      return out;
    }
    out.resolved = true;
    out.session_id = pick;
    out.detected_by = SIGNALS.READER;
    out.reason = null;
    out.note = pick === herdr
      ? 'the reader confirmed herdr\'s value'
      : `the reader chose ${pick}${herdr ? ` (herdr records ${herdr})` : ''}`;
    out.corroborated = byId(pick).source !== SIGNALS.READER;
    return out;
  }

  // ── 1. the pane's own banner (hermes; the claude TUI prints no such field) ──
  if (agent === 'hermes' && banner) {
    const owner = claimOf(banner);
    const rel = herdr ? newer(banner, herdr) : true;
    if (owner) {
      note(`pane banner names ${banner}, but herdr binds it to pane ${owner}`);
      push(banner, SIGNALS.PANE_BANNER, `bound to ${owner}`);
    } else if (herdr && banner === herdr) {
      // The pane and herdr agree — nothing to switch, and the pane corroborates.
      return Object.assign(out, { resolved: true, session_id: herdr, detected_by: SIGNALS.HERDR, corroborated: true });
    } else if (herdr && rel === false) {
      note(`pane banner names ${banner}, which is older than herdr's ${herdr} — kept herdr`);
      push(banner, SIGNALS.PANE_BANNER, 'older than herdr');
    } else if (herdr && rel === null) {
      note(`pane banner names ${banner}; herdr's value ${herdr} is not a hermes id, so "newer" cannot be decided`);
      push(banner, SIGNALS.PANE_BANNER, 'uncomparable with herdr');
    } else {
      const known = !!(inp.store_known_ids && inp.store_known_ids[banner]);
      return Object.assign(out, {
        resolved: true,
        session_id: banner,
        detected_by: SIGNALS.PANE_BANNER,
        corroborated: known,
        note: known ? null : 'the store has no row for this id yet (a brand-new session)',
      });
    }
  } else if (agent === 'hermes' && !banner && ambiguousIds.length > 1) {
    // The pane names several sessions (banners in the scrollback) — §9.5.
    if (herdr) note(`the pane's text names ${ambiguousIds.length} sessions (${ambiguousIds.join(', ')}) — kept herdr's ${herdr}`);
  }

  // ── 2. the hermes store's newest session for this cwd ──────────────────────
  if (agent === 'hermes' && storeRows.length) {
    for (const r of storeRows) {
      const id = String(r.id);
      const owner = claimOf(id);
      const rel = herdr ? newer(id, herdr) : true;
      const lastMs = Number.isFinite(r.last_activity_at) ? r.last_activity_at * 1000 : null;
      const fresh = lastMs == null ? false : (now - lastMs) <= LIMITS.STORE_FRESH_MS;
      if (id === herdr) break;                       // herdr's own value: nothing to switch to
      if (owner) continue;                           // another pane owns it
      if (rel !== true) { note(`store session ${id} is not newer than herdr's ${herdr}`); continue; }
      if (!fresh) { note(`store session ${id} for this cwd is older than ${Math.round(LIMITS.STORE_FRESH_MS / 60000)} min`); continue; }
      return Object.assign(out, { resolved: true, session_id: id, detected_by: SIGNALS.STORE_SESSION, corroborated: true });
    }
  }

  // ── 3. claude: the newest jsonl under this pane's cwd ──────────────────────
  if (agent === 'claude' && filerows.length) {
    const newest = filerows[0];
    const runnerUp = filerows.slice(1).find((c) => newest.mtimeMs - c.mtimeMs <= LIMITS.AMBIG_MARGIN_MS) || null;
    const age = Number.isFinite(newest.mtimeMs) ? now - newest.mtimeMs : Infinity;
    const owner = claimOf(newest.id);
    const bound = Number.isFinite(inp.bound_mtime_ms) ? inp.bound_mtime_ms : null;
    const gained = bound == null ? null : (newest.mtimeMs - bound);
    if (newest.id === herdr) {
      // herdr is already the newest thing under this cwd: nothing to do.
    } else if (owner) {
      note(`the newest log under this cwd (${newest.id}) is herdr's session for pane ${owner}`);
      push(newest.id, SIGNALS.CWD_NEWEST, `bound to ${owner}`);
    } else if (runnerUp) {
      note(`two logs under this cwd are within ${Math.round(LIMITS.AMBIG_MARGIN_MS / 1000)}s of each other (${newest.id}, ${runnerUp.id}) — not picking either`);
      push(newest.id, SIGNALS.CWD_NEWEST, 'ambiguous');
      push(runnerUp.id, SIGNALS.CWD_NEWEST, 'ambiguous');
      out.ambiguous = true;
      out.ambiguous_ids = [newest.id, runnerUp.id];
    } else if (age > LIMITS.FILE_FRESH_MS) {
      note(`the newest log under this cwd (${newest.id}) was written ${Math.round(age / 60000)} min ago — too old to be the live session`);
      push(newest.id, SIGNALS.CWD_NEWEST, 'stale');
    } else if (gained != null && gained <= LIMITS.AMBIG_MARGIN_MS) {
      note(`the newest log under this cwd (${newest.id}) is not materially fresher than herdr's ${herdr}`);
    } else {
      return Object.assign(out, {
        resolved: true,
        session_id: newest.id,
        detected_by: SIGNALS.CWD_NEWEST,
        corroborated: true,
        note: bound == null ? 'herdr binds no log under this cwd' : null,
      });
    }
  } else if (agent === 'claude' && !filerows.length) {
    note('no log file under this cwd proves it belongs to the pane');
  }

  // ── 4. herdr's own record: the fallback ───────────────────────────────────
  // For claude, herdr is only an answer when it is not competing with logs: with
  // candidates to weigh, herdr's record is usable only when its own file exists —
  // a record pointing at a log that does not exist is not "a live session we
  // know", it is exactly the dangling state §9.5 says to disclose instead of
  // serving. With NO candidate at all there is nothing to weigh, so herdr's value
  // is the fallback §9.1 names and the caller's own file check turns it into the
  // precise `session_file_missing` (the answer this had before round 7.6).
  const herdrUsable = !!herdr
    && (agent !== 'claude' || !filerows.length || Number.isFinite(inp.bound_mtime_ms));
  const paneNamesHerdr = vis.distinct.includes(herdr) || rec.distinct.includes(herdr);
  if (herdrUsable) {
    out.resolved = true;
    out.session_id = herdr;
    out.detected_by = SIGNALS.HERDR;
    out.corroborated = agent === 'hermes' ? paneNamesHerdr : false;
    if (!out.note) {
      if (agent === 'hermes' && ambiguousIds.length > 1) {
        out.note = 'the pane names several sessions and herdr is the only one that can be checked';
      } else if (agent === 'hermes' && !paneNamesHerdr) {
        out.note = 'the pane names no session';
      }
    }
  } else {
    out.resolved = false;
    out.session_id = null;
    out.reason = (out.ambiguous || ambiguousIds.length > 1) ? 'ambiguous_candidates' : 'no_signal';
    // A pane whose `Session:` field holds something that is not a session id (a
    // template, a truncation, a translated string) is not the same as a pane that
    // names nothing, and the reader is told which one it is — the token itself is
    // in `candidates` with detail `not a session id`.
    const named = badTokens.length
      ? `the pane's Session: field carries ${badTokens.slice(0, 2).map((t) => JSON.stringify(t)).join(', ')}, which is not a session id`
      : null;
    out.note = out.note || named || (herdr
      ? `herdr records ${herdr}, which no log under this cwd proves`
      : 'the pane names no session and herdr records none for it');
  }
  return out;
}

// ── the per-pane binding state: session_change + the staleness watchdog ─────
/**
 * Per pane, remembers (a) the session id last REPORTED — `session_change` is
 * emitted exactly once per change, never on every poll — and (b) enough to tell
 * §9.4's two cases apart: a pane that is MOVING while its session gained nothing
 * (stale: the binding is dead) versus a pane that is simply IDLE (not stale).
 *
 * `progress` is the head of the bound session's content (hermes: the row id the
 * reader handed back, claude: the byte offset). It grows only when the session
 * gains records, which is exactly the fact the watchdog needs; it is the caller's
 * job to pass it from the read it already did, so no extra query exists for it.
 *
 * The clock is injectable (test/chat.mjs drives the 60 s window in milliseconds).
 */
function createBindingTracker(opts) {
  const o = opts || {};
  const clock = typeof o.now === 'function' ? o.now : () => Date.now();
  const staleMs = Number.isFinite(o.staleMs) && o.staleMs > 0 ? o.staleMs : LIMITS.STALE_MS_DEFAULT;
  // The floor under "the text moved": a full-screen TUI can add one chrome line
  // (a rotated tip, a warning banner) without the agent doing anything. A real
  // turn adds hundreds of characters. See the measurement note on foldPaneLine.
  const novelMin = Number.isFinite(o.novelMin) && o.novelMin >= 0 ? o.novelMin : LIMITS.STALE_NOVEL_MIN;
  const panes = new Map();

  function newState(id, at, changes) {
    return {
      session_id: id,
      progress: null,
      last_gain_at: at,
      bound_at: at,
      lines: null,                 // Set of folded lines seen last, or null
      last_text_at: null,
      movement: [],                // [{at, chars}] of novel content, newest last
      moved: 0,                    // novel characters inside the current window
      changes: changes || 0,
    };
  }

  /** Novel characters in this read, and the new line set (only this read's
   *  lines, so the memory per tracked pane is one screenful, not a history). */
  function textNovelty(st, text) {
    const lines = foldPaneLines(text);
    if (!st.lines) return { chars: 0, first: true, lines: new Set(lines) };
    let chars = 0;
    for (const l of lines) if (!st.lines.has(l)) chars += l.length;
    return { chars, first: false, lines: new Set(lines) };
  }

  function windowed(st, at) {
    const keep = st.movement.filter((m) => at - m.at <= staleMs);
    st.movement = keep;
    st.moved = keep.reduce((n, m) => n + m.chars, 0);
    return st.moved;
  }

  return {
    /** Observe one successful poll. `text` null means the pane could not be read
     *  (that is not evidence of movement). Returns the change (once) and the
     *  staleness verdict for this poll. */
    observe(paneId, obs) {
      const ob = obs || {};
      const at = Number.isFinite(ob.at) ? ob.at : clock();
      const id = ob.session_id == null ? '' : String(ob.session_id);
      if (!paneId || !id) return { first: false, session_change: null, stale: false, stale_reason: null, bound_ms: 0, moved: 0 };

      let st = panes.get(paneId);
      const first = !st;
      let change = null;
      if (!st) {
        st = newState(id, at, 0);
        panes.set(paneId, st);
      } else if (st.session_id !== id) {
        change = { from: st.session_id, to: id, detected_by: ob.detected_by || null, at };
        st = newState(id, at, st.changes + 1);
        panes.set(paneId, st);
      }

      if (Number.isFinite(ob.progress) && (st.progress === null || ob.progress > st.progress)) {
        st.progress = ob.progress;
        st.last_gain_at = at;
        st.movement = [];                      // only movement AFTER the last gain counts
        st.moved = 0;
      }

      if (typeof ob.text === 'string') {
        const nov = textNovelty(st, ob.text);
        st.lines = nov.lines;
        // The first sight of a pane (or of a session) is not "the text moved":
        // there is nothing to compare it against, so it is recorded, not counted.
        if (!first && !nov.first && nov.chars > 0) {
          st.movement.push({ at, chars: nov.chars });
          st.last_text_at = at;
        }
        windowed(st, at);
      }

      const gainAge = at - st.last_gain_at;
      const boundAge = at - st.bound_at;
      const stale = !first && boundAge >= staleMs && gainAge >= staleMs && st.moved >= novelMin
        && st.last_text_at !== null && st.last_text_at > st.last_gain_at;
      return {
        first,
        session_change: change,
        stale,
        stale_reason: stale
          ? `the pane's text gained ${st.moved} characters in ${Math.round(boundAge / 1000)}s while session ${id} gained no records for ${Math.round(gainAge / 1000)}s`
          : null,
        bound_ms: boundAge,
        moved: st.moved,
      };
    },
    /** What this pane is currently bound to, without observing (for tests/status). */
    peek(paneId) {
      const st = panes.get(paneId);
      return st ? { session_id: st.session_id, moved: st.moved, changes: st.changes, bound_ms: clock() - st.bound_at } : null;
    },
    forget(paneId) { panes.delete(paneId); },
    reset() { panes.clear(); },
    staleMs,
    novelMin,
  };
}

module.exports = {
  LIMITS,
  SIGNALS,
  HERMES_ID_RE,
  isHermesSessionId,
  sameCwd,
  paneSessionFields,
  foldPaneLine,
  foldPaneLines,
  digestPaneText,
  resolvePaneSession,
  createBindingTracker,
};
