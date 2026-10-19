/* herdr-dash — chat-render.js · the rendering layer of the structured conversation view
 * (CONTRACT-v2 §8.3, owner: W3).
 *
 * This file is NOT a §3 module: it mounts nothing and owns no panel. It is the renderer W2's
 * `chatview` module calls, and it is deliberately DOM-only so `the local test suite` can hold
 * it to fixtures without a browser.
 *
 * FROZEN INTERFACE (§8.5 — do not rename; W2 codes against it):
 *   ChatRender.renderMessage(msg, opts) -> Element
 *   ChatRender.renderList(messages, opts) -> DocumentFragment
 *   ChatRender.summaryFor(tool) -> string
 *   ChatRender.autoScrollOpts() -> {stickPx}
 * and, added in round 7.1 for §8.3 amendment A1:
 *   ChatRender.renderTurn(turn, opts) -> Element          one turn as one visual group
 *   ChatRender.renderWorkingTail(elapsedMs) -> Element     the live tail of a running turn
 *   ChatRender.foldReport(messages) -> {folded, groups}    "count it": what folding removed
 * where opts = {expandTools, maxTextLines, foldedKeys, openKeys} and msg is the §8.2 shape:
 *   {key, ts, role, kind, text, tool:{name, call_key, input, input_truncated, result,
 *    result_truncated, is_error, pending, pending_reason}, sidechain}
 *
 * SECURITY. Message text is untrusted input: an agent can print anything, and a tool result can
 * carry text fetched from the network. Every node below is built with createElement/createTextNode
 * and filled with `textContent`; the ONLY innerHTML in this file is `= ''` (clearing, in clear()).
 * Message text is therefore never parsed as HTML — there is nothing to escape on the way in, and
 * nothing an `<img onerror=…>` in a prompt or a result can execute. the local test suite serialises
 * the produced tree and asserts that a message cannot produce an element; it also fails if any
 * non-empty innerHTML assignment ever appears here.
 *
 * CLASS CONTRACT (chatview.css styles these; chatview.js may hook them):
 *   container/hooks W2 renders:  .hd-cv-scroll  .hd-cv-list  .hd-cv-jump  .hd-cv-empty
 *   produced here: .hd-cv-msg .hd-cv-role-{user|assistant|tool|system|unknown}
 *                  .hd-cv-kind-{text|thinking|tool_call|tool_result|system|unknown}
 *                  .hd-cv-sidechain .hd-cv-meta .hd-cv-who .hd-cv-time .hd-cv-side
 *                  .hd-cv-row .hd-cv-bubble .hd-cv-body .hd-cv-p .hd-cv-open .hd-cv-more
 *                  .hd-cv-code .hd-cv-codewrap .hd-cv-lang .hd-cv-icode .hd-cv-link
 *                  .hd-cv-codehead .hd-cv-codecopy
 *                  .hd-tok-str .hd-tok-com .hd-tok-num .hd-tok-kw .hd-tok-lit
 *                  .hd-cv-toolgroup .hd-cv-toolgroup-head .hd-cv-toolgroup-caret
 *                  .hd-cv-toolgroup-sum .hd-cv-toolgroup-err .hd-cv-toolgroup-body
 *                  .hd-cv-think .hd-cv-think-head .hd-cv-think-body
 *                  .hd-cv-card .hd-cv-card-head .hd-cv-card-body .hd-cv-name .hd-cv-sum
 *                  .hd-cv-toggle .hd-cv-sec .hd-cv-json .hd-cv-res .hd-cv-resbox
 *                  .hd-cv-err .hd-cv-errword .hd-cv-pending .hd-cv-pendingcard .hd-cv-pendingmsg
 *                  .hd-cv-stale .hd-cv-stalecard   (round 7.3: no result, and none is coming)
 *                  A2: .hd-cv-foldbtn .hd-cv-folded .hd-cv-foldstat
 *                      + the head row carries data-hd-foldhead, the button data-hd-fold
 *                  A3: every collapsible control carries data-hd-open="<stable id>" and states its
 *                      state in aria-expanded + hd-cv-open (the thinking head, the tool toggle,
 *                      the show-all control), and NO control is opened by a click handled here
 *                  .hd-cv-note .hd-cv-warn .hd-cv-more .hd-cv-sys .hd-cv-dupes
 *                  A1: .hd-cv-turn .hd-cv-turn-body .hd-cv-turn-pending .hd-cv-interim
 *                      .hd-cv-reply .hd-cv-replytag .hd-cv-working .hd-cv-working-text .hd-cv-dot
 *                      .hd-cv-processwrap .hd-cv-procbtn .hd-cv-proccaret .hd-cv-procsum
 *                      .hd-cv-procnotes .hd-cv-process
 *
 * A1 (round 7.1) — a turn is drawn as a group: the user's prompt is the head bubble, the agent's
 * records follow in log order as segments (thinking segment -> tool card -> interim text -> ...),
 * and the final assistant text is the closing reply bubble. While the turn is `working` there is no
 * reply by construction: the tail is renderWorkingTail() instead, so a running turn can never be
 * mistaken for a finished one. The source is block level, so there is no per-token typing (A1 rule
 * 5); the only animation here is a pulse on the "working" dot, which claims nothing about the log.
 *
 * A2 (round 7.4) — a bubble the reader folded. The prompt and the reply both fold, symmetrically
 * (A2.2), and the default is EXPANDED for every message that is not in `opts.foldedKeys` (A2.1): the
 * whole point of the view is that the prompt and the reply are readable without a click, so a fold is
 * only ever something the reader did. The folded form is a PREVIEW and never a rewrite (A2.3): the
 * message's own first non-empty line, clipped to SUMMARY_MAX with an ellipsis, plus the two counts of
 * what is not on screen. What the fold must NOT do is hide a disclosure — a server `text_truncated`
 * note and a card's pending state stay exactly where they were (A2.6) — and it must not be confused
 * with §8.3's long-text cap, which is a length guard: while folded there is no "show all · N lines",
 * and unfolding restores whatever the cap said before (A2.7). Nothing here animates, and nothing here
 * listens: `chatview.js` owns the map and the clicks (A2.4/A2.8).
 *
 * The A2 errata (round 7.5, measured on w4:p1) corrected what the fold CLAIMS. The preview is the
 * RENDERED first line, so folding cannot make markdown syntax reappear that the body was rendering;
 * and `N chars · M lines hidden` counts on the body the reader was looking at — the same markdown
 * pass, through the same §8.3 length cap — minus the preview, never on the raw record, which holds
 * text the `show all` control was already withholding (the old wording overstated the fold by
 * exactly that much). While folded, the count line also names the text still behind `show all`, so
 * folding never hides the fact that more exists.
 *
 * A3 (round 7.5) — the reader's expanded blocks survive re-rendering. Measured: expanding the newest
 * turn's thinking head or a tool card collapsed it again within seconds, because the expand state
 * lived in the render call (`var expanded = false`, `body.hidden = !opts.expandTools`) and the
 * newest turn is redrawn every time a record arrives. Every collapsible block now carries a STABLE
 * id derived from the record (A3.2) and reads its state from `opts.openKeys[id]` (A3.1); the render
 * is a pure function of the record and that map, so a redraw reproduces what the reader chose. A3
 * also forbids this file to listen or to keep state: `chatview.js` delegates the clicks (A3.3).
 *
 * OPTIONAL EXTRAS W2 may pass (additive to §8.2, ignored if absent):
 *   opts.expandTools  — tool cards start expanded (default false). A3.1: this is only the default
 *                       for a reader who has expressed no opinion — an `openKeys` entry, true OR
 *                       false, always wins.
 *   opts.maxTextLines — long-text collapse threshold (default 20)
 *   opts.openKeys     — A3.1: UI state, { "<id>": true } = the blocks the reader OPENED (a thinking
 *                       body, a tool card, a `show all` block). Ids are A3.2's: `<msg.key>#think<ord>`,
 *                       `<msg.key>#tool<call_key|ord>`, `<msg.key>#text`, plus `#in`/`#res` for the
 *                       two long blocks inside a card. Truthy opens; a present FALSY entry means the
 *                       reader closed a block the options would have opened; an absent entry leaves
 *                       the default (closed, or `expandTools`). Read, never written, never mutated.
 *   opts.foldedKeys   — A2.4: UI state, { "<msg.key>": true }. A truthy entry renders that `user` or
 *                       `assistant` TEXT bubble folded: the message head carries a `hd-cv-foldbtn`
 *                       control (`data-hd-fold`, `aria-expanded`) and `data-hd-foldhead`, its row
 *                       carries `hd-cv-folded`, and the bubble shows the first non-empty line clipped
 *                       to SUMMARY_MAX plus "N chars · M lines hidden" instead of the full text. The
 *                       default is EXPANDED (A2.1); this file reads the map and never writes it —
 *                       chatview.js owns it and the click handling (A2.4).
 *   msg.pending       — a user bubble the app just sent, not yet in the agent's log
 *   msg.pending_note  — the sentence to show under it (W2's "not found in this agent's log…")
 *   tool.pending_reason — WHY a pending call has no result (round 7.3, W1 adds the field):
 *                       'awaiting'      the result may still arrive -> "waiting for result…" + pulse
 *                       'not_in_window' the call is older than the loaded window -> a neutral note
 *                       absent/unknown -> 'awaiting' (never claim a live call lost its result)
 *   msg.text_truncated — the server clamped this text at 20,000 chars (§8.2); the note must stay
 *                        visible whether or not the reader expands the block
 *   turn.pending      — the whole turn is a just-sent prompt, not yet in the log
 *   turn.elapsedMs    — how long the turn has been running, for renderWorkingTail()
 */
(function () {
  'use strict';

  var HD = (window.HD = window.HD || {});

  // ── frozen numbers ───────────────────────────────────────────────────────────

  var STICK_PX = 48;           // autoScrollOpts().stickPx: how close to the tail still counts as
                               // "following". W2 compares scrollHeight - scrollTop - clientHeight.
  var DEF_MAX_TEXT_LINES = 20; // §8.3 long-text collapse: a bubble longer than this collapses.
  var SUMMARY_MAX = 160;       // summaryFor() clips its one line to this many characters.
  // round 7.3 — a call with no result. "waiting for result…" is a claim that something is happening
  // NOW, so it may only be made when the result really may still arrive. W1's tool.pending_reason
  // separates the two cases; a card that says this instead is stating a fact about the window.
  var PENDING_WORD = 'waiting for result…';
  var STALE_WORD = 'no result in the loaded window (older record) — press "load older" to look '
    + 'further back';

  // ── tiny helpers (no DOM, no state) ──────────────────────────────────────────

  function isStr(v) { return typeof v === 'string'; }
  function str(v) { return v == null ? '' : String(v); }
  /** One line, always: summaries and labels must not wrap (they are clipped, not rewrapped). */
  function oneLine(v) { return str(v).replace(/\s+/g, ' ').trim(); }
  function clip(s, max) {
    var t = str(s);
    return t.length <= max ? t : t.slice(0, max - 1) + '…';
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function pad4(n) { var s = String(n); while (s.length < 4) s = '0' + s; return s; }
  /** §8.3 timestamps come from the record's own `ts`; a record without one is marked as such. */
  function tsMs(ts) {
    var n = typeof ts === 'number' ? ts : (isStr(ts) && ts.replace(/\s/g, '') !== '' ? Number(ts) : NaN);
    if (!isFinite(n) || n <= 0) return null;
    n = Math.floor(n);
    return isNaN(new Date(n).getTime()) ? null : n;
  }
  function fmtTime(ts) {
    var n = tsMs(ts);
    if (n === null) return null;
    var d = new Date(n);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function fmtFull(ts) {
    var n = tsMs(ts);
    if (n === null) return null;
    var d = new Date(n);
    return pad4(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  /** "N chars" counts characters as a reader counts them (code points), not UTF-16 units. */
  function charCount(s) { return Array.from(str(s)).length; }
  function countLines(s) { return str(s).split('\n').length; }
  function firstLines(s, max) {
    var all = str(s).split('\n');
    return all.length <= max ? str(s) : all.slice(0, max).join('\n');
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  /** The only innerHTML in this file: '' removes children, and message text never goes through it.
   *  Nothing calls it any more — A3 removed the last in-place re-render (a reader's expand is now
   *  redrawn from `opts.openKeys` instead of repainting a live box) — but the invariant "the one
   *  innerHTML assignment in this source line-clear" is pinned by the local test suite. */
  function clear(node) { node.innerHTML = ''; }
  function pre(text, cls) { var p = el('pre', cls); p.textContent = str(text); return p; }
  /** A class-name token we are willing to put in className. §8.2's fields are the server's, but a
   *  future kind/role must not be able to write arbitrary text into an attribute. */
  function token(v, fallback) {
    var t = String(v == null ? '' : v).toLowerCase();
    return /^[a-z][a-z0-9_]*$/.test(t) ? t : fallback;
  }

  var KINDS = ['text', 'thinking', 'tool_call', 'tool_result', 'system', 'unknown'];
  function normKind(k) {
    var t = token(k, '');
    return KINDS.indexOf(t) >= 0 ? t : 'unknown';
  }
  function normRole(r, kind) {
    var t = token(r, '');
    if (t === 'user' || t === 'assistant' || t === 'tool' || t === 'system') return t;
    return kind === 'tool_call' || kind === 'tool_result' ? 'tool' : 'assistant';
  }
  function roleLabel(role, kind) {
    if (role === 'user') return 'you';
    if (role === 'tool' || kind === 'tool_call' || kind === 'tool_result') return 'tool';
    if (role === 'system' || kind === 'system') return 'system';
    return 'assistant';
  }
  function normOpts(opts) {
    var o = opts || {};
    var n = typeof o.maxTextLines === 'number' ? o.maxTextLines : Number(o.maxTextLines);
    if (!isFinite(n) || n < 1) n = DEF_MAX_TEXT_LINES;
    var d = typeof o.dupes === 'number' ? o.dupes : Number(o.dupes);
    return {
      expandTools: !!o.expandTools,
      maxTextLines: Math.max(1, Math.floor(n)),
      // The next two are NOT caller options: renderList/renderTurn set them on a record whose
      // neighbours make it special — an unpaired result, or a call the log contains more than once.
      unpaired: !!o.unpaired,
      dupes: isFinite(d) && d > 1 ? Math.floor(d) : 0,
      // A2.4: W2's fold state, { "<msg.key>": true }. The reference is passed through, never copied
      // and never mutated — W2 owns the map. Anything that is not an object means "nothing folded",
      // so an opts built before A2 (or by a caller that does not fold) renders exactly as it did.
      foldedKeys: (o.foldedKeys && typeof o.foldedKeys === 'object') ? o.foldedKeys : null,
      // A3.1: the same for the blocks the reader OPENED (thinking body, tool card, `show all`),
      // { "<id>": true }. Passed through for the same reason and read the same way: a copy of the
      // opts (extend(), neighbourOpts()) keeps the reference, and an absent/foreign value means
      // "nobody has opened anything", which is what every caller before A3 rendered.
      openKeys: (o.openKeys && typeof o.openKeys === 'object') ? o.openKeys : null
    };
  }
  function extend(opts, extra) {
    var o = opts || {}, out = {}, k;
    for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    return out;
  }

  // ── markdown-lite ────────────────────────────────────────────────────────────
  // The subset §8.3 asks for: fenced code, inline code, **bold**, bare URLs. It is a tokenizer
  // that emits NODES, never markup, so a message cannot escape into the document.

  /**
   * Split text into blocks: {code:false, text} prose and {code:true, lang, text} fences. A fence
   * that is never closed runs to the end of the text — which is exactly what a collapsed preview
   * of the first N lines usually is, so the preview stays honest instead of dropping the block.
   */
  function splitFences(raw) {
    var lines = str(raw).split('\n');
    var out = [], buf = [], open = null;
    function flushProse() {
      var t = buf.join('\n');
      if (t.replace(/\s/g, '') !== '') out.push({ code: false, text: t });
      buf = [];
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\r$/, '');
      var m = /^[ \t]*```([^`]*)$/.exec(line);
      if (m) {
        if (open === null) {
          flushProse();
          open = { lang: oneLine(m[1]) };
        } else {
          out.push({ code: true, lang: open.lang, text: buf.join('\n') });
          buf = [];
          open = null;
        }
        continue;
      }
      buf.push(line);
    }
    if (open !== null) out.push({ code: true, lang: open.lang, text: buf.join('\n') });
    else flushProse();
    return out;
  }

  /** Inline code first (a URL or ** inside backticks is literal), then bold, then URLs. */
  function splitInlineCode(text) {
    var s = str(text), parts = [], re = /`([^`\n]*)`/g, last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push({ code: false, text: s.slice(last, m.index) });
      parts.push({ code: true, text: m[1] });
      last = m.index + m[0].length;
    }
    if (last < s.length) parts.push({ code: false, text: s.slice(last) });
    return parts;
  }

  /* Inline: bold, a markdown link, then a bare URL. The markdown link is tried first so that its
     label cannot be re-read as a bare URL; only an http(s) href ever becomes an anchor, and every
     other href (javascript:, data:, a relative or local path) is left as the text the agent wrote
     — never a link, never an executable URL. The character class stops at quotes and angle
     brackets, so a URL can never swallow markup that follows it. */
  var INLINE_RE = /\*\*([^*]+)\*\*|\[([^\]\n]+)\]\(\s*<?([^)\s<>]+)>?\s*\)|(https?:\/\/[^\s<>"'`)\]]+)/gi;

  /** http(s) only — the single gate every anchor below goes through. A URL carrying whitespace, a
   *  quote or an angle bracket is not a URL we will put in an href. */
  function safeHttpUrl(url) {
    var s = str(url);
    return /^https?:\/\//i.test(s) && !/[\s<>"'`]/.test(s);
  }
  function linkNode(url, label) {
    if (!safeHttpUrl(url)) return document.createTextNode(label == null ? url : label);
    var a = el('a', 'hd-cv-link');
    a.textContent = label == null ? url : label;
    a.setAttribute('href', url);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    return a;
  }
  /** bold, markdown links and bare URLs, appended as nodes. A sentence's trailing punctuation
   *  stays in the text; a link's label is plain text (never parsed as markup). */
  function appendRich(parent, text) {
    var s = str(text), re = new RegExp(INLINE_RE.source, 'gi'), last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) parent.appendChild(document.createTextNode(s.slice(last, m.index)));
      if (m[1] != null) parent.appendChild(el('strong', null, m[1]));
      else if (m[2] != null) {
        if (safeHttpUrl(m[3])) parent.appendChild(linkNode(m[3], m[2]));
        else parent.appendChild(document.createTextNode(m[0]));    // unsafe href: left as written
      } else {
        var url = m[4], tail = '';
        while (/[.,;:!?]$/.test(url)) { tail = url.slice(-1) + tail; url = url.slice(0, -1); }
        parent.appendChild(linkNode(url));
        if (tail) parent.appendChild(document.createTextNode(tail));
      }
      last = m.index + m[0].length;
    }
    if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
  }
  function appendInline(parent, text) {
    var parts = splitInlineCode(text);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].code) parent.appendChild(el('code', 'hd-cv-icode', parts[i].text));
      else appendRich(parent, parts[i].text);
    }
  }
  // ── code blocks: the language label, the copy control, and the token colours ─
  // A fence is drawn as one object: a head that names its language and carries the copy control for
  // exactly this block's code, then the code itself. Colouring scans the text into slices and wraps
  // some of them in a span; the slices always concatenate back to the input, so what the `pre` holds
  // as text is the code the record contained, unchanged. Nothing is parsed and nothing is escaped:
  // markup inside a fence is text here, exactly as it is everywhere else in this file.

  var codeSeq = 0;                     // ids only have to be unique inside the tree being built

  /** The first word of a fence's info string, which is the language a reader sees named. */
  function codeLang(raw) {
    var word = str(raw).replace(/^\s+/, '').split(/\s+/)[0] || '';
    return word.replace(/^[{(]+|[)}.,;]+$/g, '');
  }

  // Which scanner rules a language word gets. A word that is not listed here is not a failure: its
  // code is drawn as one plain text node, which is what every fence got before the colours existed.
  var CODE_ALIAS = {
    json: 'json',
    js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    ts: 'js', typescript: 'js', tsx: 'js',
    python: 'python', py: 'python', python3: 'python',
    bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash'
  };
  function wordSet(s) {
    var out = {}, parts = str(s).split(' ');
    for (var i = 0; i < parts.length; i++) if (parts[i] !== '') out[parts[i]] = true;
    return out;
  }
  var CODE_KW = {
    js: wordSet('as async await break case catch class const continue debugger declare default ' +
      'delete do else enum export extends finally for from function get if implements import in ' +
      'instanceof interface let namespace new of private protected public readonly return set ' +
      'static super switch this throw try type typeof var void while with yield abstract any ' +
      'boolean never number object string symbol unknown'),
    python: wordSet('and as assert async await break class continue def del elif else except ' +
      'finally for from global if import in is lambda nonlocal not or pass raise return try ' +
      'while with yield match case'),
    bash: wordSet('alias case coproc declare do done elif else esac export fi for function if in ' +
      'local readarray readonly return select shift source then time until unset while')
  };
  var CODE_LIT = {
    json: wordSet('true false null'),
    js: wordSet('true false null undefined NaN Infinity'),
    python: wordSet('True False None NotImplemented Ellipsis'),
    bash: wordSet('true false')
  };
  var CODE_RULES = {
    json: { line: null, block: null, quotes: '"', triple: false },
    js: { line: '//', block: '/*', quotes: '\'"`', triple: false },
    python: { line: '#', block: null, quotes: '\'"', triple: true, hashAfterSpace: false },
    bash: { line: '#', block: null, quotes: '\'"', triple: false, hashAfterSpace: true }
  };

  function isDigitCh(c) { return c >= '0' && c <= '9'; }
  function isSpaceCh(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r'; }
  function isHexCh(c) {
    return isDigitCh(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
  }
  function isWordStart(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
  }
  function isWordCh(c) {
    return isWordStart(c) || isDigitCh(c);
  }
  /** End of a `//`/`#` comment: the newline itself is not part of it. */
  function lineCommentEnd(src, i) {
    var j = src.indexOf('\n', i);
    return j < 0 ? src.length : j;
  }
  /** End of a block comment, from its opening two characters to just past its closing ones; an
   *  unterminated one runs to the end, which is how a reader sees it too. */
  function blockCommentEnd(src, i, close) {
    var j = src.indexOf(close, i + 2);
    return j < 0 ? src.length : j + close.length;
  }
  /** End of a quoted string, escapes honoured. A one-line quote that never closes stops at the
   *  newline so the rest of the block is still read as code; a triple quote may span lines. */
  function stringEnd(src, i, quote, triple) {
    var n = src.length, k = i + (triple ? 3 : 1), stop = quote + quote + quote;
    while (k < n) {
      var c = src.charAt(k);
      if (c === '\\') { k += 2; continue; }
      if (triple) {
        if (src.substr(k, 3) === stop) return k + 3;
        k++;
        continue;
      }
      if (c === quote) return k + 1;
      if (c === '\n') return k;
      k++;
    }
    return n;
  }
  /** End of a numeric literal: decimal with an optional fraction/exponent, or a 0x/0b form. */
  function numberEnd(src, i) {
    var n = src.length, j = i, c = src.charAt(j), k = src.charAt(j + 1);
    if (c === '0' && (k === 'x' || k === 'X')) {
      j += 2;
      while (j < n && (isHexCh(src.charAt(j)) || src.charAt(j) === '_')) j++;
      return j;
    }
    if (c === '0' && (k === 'b' || k === 'B')) {
      j += 2;
      while (j < n && (src.charAt(j) === '0' || src.charAt(j) === '1' || src.charAt(j) === '_')) j++;
      return j;
    }
    while (j < n && (isDigitCh(src.charAt(j)) || src.charAt(j) === '_')) j++;
    if (src.charAt(j) === '.') {
      j++;
      while (j < n && isDigitCh(src.charAt(j))) j++;
    }
    c = src.charAt(j);
    if (c === 'e' || c === 'E') {
      k = j + 1;
      if (src.charAt(k) === '+' || src.charAt(k) === '-') k++;
      if (isDigitCh(src.charAt(k))) {
        j = k;
        while (j < n && isDigitCh(src.charAt(j))) j++;
      }
    }
    return j;
  }

  /**
   * Cut one block of code into `{text, cls}` slices. The slices' texts concatenate back to `src`
   * exactly — that property is the whole point of this function, and every branch below either
   * consumes characters into a slice or into plain text, so none can drop or duplicate one.
   *   cls is one of hd-tok-str, hd-tok-com, hd-tok-num, hd-tok-kw, hd-tok-lit, or null for plain.
   * `family` is a key of CODE_RULES; anything else (including '') means "no colouring at all".
   */
  function scanCode(src, family) {
    var text = str(src), rules = CODE_RULES[family];
    if (!rules) return [{ text: text, cls: null }];
    var out = [], plain = '', i = 0, n = text.length, lineMark = rules.line;
    var kw = CODE_KW[family] || {}, lit = CODE_LIT[family] || {};
    function flush() { if (plain !== '') { out.push({ text: plain, cls: null }); plain = ''; } }
    function push(from, to, cls) { flush(); out.push({ text: text.slice(from, to), cls: cls }); }
    function has(map, word) { return Object.prototype.hasOwnProperty.call(map, word); }
    while (i < n) {
      var c = text.charAt(i), two = text.substr(i, 2), j;
      // `#` opens a comment anywhere in python, but in a shell only at a word boundary (`$#` is a
      // parameter, not a comment).
      if (lineMark !== null && (lineMark.length === 2 ? two === lineMark : c === lineMark) &&
          !(rules.hashAfterSpace && i > 0 && !isSpaceCh(text.charAt(i - 1)))) {
        j = lineCommentEnd(text, i);
        push(i, j, 'hd-tok-com');
        i = j;
        continue;
      }
      if (rules.block !== null && two === rules.block) {
        j = blockCommentEnd(text, i, '*/');
        push(i, j, 'hd-tok-com');
        i = j;
        continue;
      }
      if (rules.quotes.indexOf(c) >= 0) {
        var triple = !!rules.triple && text.substr(i, 3) === c + c + c;
        j = stringEnd(text, i, c, triple);
        push(i, j, 'hd-tok-str');
        i = j;
        continue;
      }
      if (isDigitCh(c)) {
        j = numberEnd(text, i);
        push(i, j, 'hd-tok-num');
        i = j;
        continue;
      }
      if (isWordStart(c)) {
        j = i + 1;
        while (j < n && isWordCh(text.charAt(j))) j++;
        var word = text.slice(i, j);
        if (has(kw, word)) push(i, j, 'hd-tok-kw');
        else if (has(lit, word)) push(i, j, 'hd-tok-lit');
        else plain += word;
        i = j;
        continue;
      }
      plain += c;
      i++;
    }
    flush();
    return out;
  }

  /** The public name for the scanner: the same slices, with the language word resolved. */
  function highlightCode(text, lang) {
    return scanCode(text, CODE_ALIAS[str(lang).toLowerCase()] || '');
  }

  /** The code itself. A language this build knows is cut into coloured slices; anything else — or a
   *  block in which nothing is colourable — stays the one text node it always was, so an unknown
   *  fence is rendered exactly as before. Either way the node's text is the fence's text. */
  function codeNode(text, lang) {
    var src = str(text);
    var node = el('pre', 'hd-cv-code');
    var toks = highlightCode(src, lang), styled = false, i;
    for (i = 0; i < toks.length; i++) if (toks[i].cls) { styled = true; break; }
    if (!styled) {
      node.textContent = src;
      return node;
    }
    for (i = 0; i < toks.length; i++) {
      node.appendChild(toks[i].cls
        ? el('span', toks[i].cls, toks[i].text)
        : document.createTextNode(toks[i].text));
    }
    return node;
  }

  /** One fence: head (language, copy) and the code. The block marked for copying is the wrapper, so
   *  the clipboard gets this block's code and the message's own words, never the whole bubble. */
  function codeBlock(b) {
    var lang = codeLang(b.lang);
    var id = 'code#' + (++codeSeq);
    var wrap = el('div', 'hd-cv-codewrap');
    var head = el('div', 'hd-cv-codehead');
    head.appendChild(el('span', 'hd-cv-lang', lang === '' ? 'text' : lang));
    var btn = copyButton(id, 'copy this code block');
    btn.className += ' hd-cv-codecopy';
    head.appendChild(btn);
    wrap.appendChild(head);
    wrap.appendChild(codeNode(b.text, lang));
    markBlock(wrap, id, b.text);
    return wrap;
  }

  /** The body of a bubble: prose blocks keep their own line breaks (verbatim), fences are <pre>. */
  function bodyInto(parent, raw) {
    var blocks = splitFences(raw);
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.code) {
        parent.appendChild(codeBlock(b));
      } else {
        var p = el('div', 'hd-cv-p');
        appendInline(p, b.text);
        parent.appendChild(p);
      }
    }
  }
  function mdRenderer(raw) {
    return function (full, into, max) { bodyInto(into, full ? raw : firstLines(raw, max)); };
  }

  // ── A3: the reader's opened/closed state (which blocks are open) ─────────────
  // A3.1: the expand state of every collapsible block lives in `opts.openKeys` (UI state W2 owns,
  // `{ "<id>": true }`), NEVER in a variable inside the render call. A round-7.5 measurement caught
  // what the old closure state cost: the newest turn is re-rendered whenever a record arrives, so a
  // reader who expanded its thinking head or a tool card watched it collapse again seconds later.
  // So this file reads the map, writes the state into the markup (id + aria-expanded + hd-cv-open)
  // and attaches no listener at all (A3.3: chatview.js delegates the clicks).

  /** A3.2: the id base of a record's controls. Ids are derived from the record, never from the DOM,
   *  so the same record always draws the same ids. A record with no key at all cannot be named by
   *  one; it still gets usable ids from the ordinal rule below, rather than a control that cannot
   *  work at all. */
  function idBase(msg) { return str(msg && msg.key); }
  /** A3.2: the ordinal of one row within its record — counted per render pass, so it only ever grows
   *  as a log grows: appending a record can never renumber a control that is already on screen. A
   *  well-formed record draws one row of each kind, so the ordinal is 0; it exists so that two rows
   *  that legitimately share a key (the log repeating a record, or a keyless record) cannot collide
   *  on one id and open each other. */
  var pass = null, passDepth = 0;
  function passBegin() { passDepth++; if (passDepth === 1) pass = {}; }
  function passEnd() { if (passDepth > 0) passDepth--; if (passDepth === 0) pass = null; }
  function segOrdinal(base, what) {
    if (!pass) return 0;
    var k = base + '#' + what;
    var n = Object.prototype.hasOwnProperty.call(pass, k) ? pass[k] : 0;
    pass[k] = n + 1;
    return n;
  }
  function thinkId(msg) { var b = idBase(msg); return b + '#think' + segOrdinal(b, 'think'); }
  function toolId(msg) {
    var b = idBase(msg);
    var tool = (msg && msg.tool && typeof msg.tool === 'object') ? msg.tool : {};
    var ck = (tool.call_key == null || str(tool.call_key) === '') ? null : str(tool.call_key);
    return b + '#tool' + (ck !== null ? ck : segOrdinal(b, 'tool'));
  }
  function textId(msg) { return idBase(msg) + '#text'; }

  /**
   * A3.1: what the reader decided about one id, or null when they have expressed no opinion.
   * `hasOwnProperty` is the whole point: `{ "<id>": false }` is a reader who CLOSED a block the
   * option opened, which is not the same as an id nobody mentioned. The option is only the default
   * for a reader who has not spoken.
   */
  function readerOpen(o, id) {
    var m = o && o.openKeys;
    if (!m || typeof m !== 'object' || id === null || id === undefined) return null;
    if (!Object.prototype.hasOwnProperty.call(m, id)) return null;
    return !!m[id];
  }
  function isOpen(o, id, def) {
    var r = readerOpen(o, id);
    return r === null ? !!def : r;
  }

  /**
   * §8.3 long-text collapse: past `max` lines the block shows the first `max` lines of the RAW
   * text (verbatim — nothing is rewritten or summarised) plus a "show all · N lines" control
   * carrying the true total. Expanding re-renders the whole text; nothing is kept only in CSS, so
   * what a test (or a reader of the DOM) sees is what is on screen.
   *
   * A3: the state is `opts.openKeys[id]` (default: closed), the control carries the id, and this
   * function attaches no listener — so a re-render redraws the reader's own choice instead of
   * resetting it (which is exactly the defect A3 measured).
   */
  function withClamp(raw, o, container, cls, render, id, def) {
    var text = str(raw), total = countLines(text), max = o.maxTextLines;
    var box = el('div', cls);
    container.appendChild(box);
    if (total <= max) { render(true, box, max); return; }
    var open = isOpen(o, id, def);
    var btn = el('button', 'hd-cv-more');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-lines', String(total));
    btn.setAttribute('data-hd-open', id);
    render(open, box, max);
    btn.textContent = (open ? 'show less' : 'show all') + ' · ' + total + ' lines';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    box.className = open ? cls + ' hd-cv-open' : cls;
    container.appendChild(btn);
  }

  // ── tool summaries ───────────────────────────────────────────────────────────

  function toolName(tool) {
    var t = tool || {};
    return oneLine(t.name || t.tool_name || t.tool || '');
  }
  /** What a reader wants on the card's one line. First key that carries something wins; a key that
   *  is not there falls through. Nothing is invented — no key present means no summary. */
  var SUMMARY_KEYS = {
    bash: ['command'], shell: ['command'], exec: ['command'], run: ['command'], sh: ['command'],
    cmd: ['command'], powershell: ['command'], bashoutput: ['command'],
    read: ['file_path'], readfile: ['file_path'], write: ['file_path'], edit: ['file_path'],
    multiedit: ['file_path'], notebookedit: ['notebook_path'], ls: ['path'],
    glob: ['pattern', 'path'], grep: ['pattern', 'path'], rg: ['pattern', 'path'],
    search: ['pattern', 'query'], webfetch: ['url'], websearch: ['query'],
    task: ['description', 'prompt'], agent: ['description', 'prompt'], skill: ['skill', 'args'],
    kill: ['shell_id', 'pid'], todowrite: ['todos'], todoread: [],
  };
  var SUMMARY_FALLBACK = ['command', 'file_path', 'path', 'notebook_path', 'pattern', 'query', 'url',
    'description', 'prompt', 'skill', 'text', 'content', 'message', 'args'];
  var BASH_LIKE = { bash: 1, shell: 1, exec: 1, run: 1, sh: 1, cmd: 1, powershell: 1, bashoutput: 1 };

  function argToText(v) {
    if (v == null) return '';
    if (isStr(v)) return oneLine(v);
    if (Array.isArray(v)) return v.length + ' item' + (v.length === 1 ? '' : 's');
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return oneLine(JSON.stringify(v)); } catch (e) { return oneLine(String(v)); }
  }
  /** The tool argument object (or the parsed text of a JSON-string input, as hermes stores it). */
  function argObject(input) {
    if (input == null) return null;
    if (isStr(input)) {
      var s = input.trim();
      if (s.charAt(0) === '{' || s.charAt(0) === '[') {
        try { return JSON.parse(s); } catch (e) { return null; }
      }
      return null;
    }
    return typeof input === 'object' ? input : null;
  }
  function summaryArg(tool) {
    var name = toolName(tool).toLowerCase().replace(/[^a-z0-9]/g, '');
    var input = tool && tool.input;
    var obj = argObject(input);
    var keys = SUMMARY_KEYS[name];
    var i;
    if (obj && keys) {
      for (i = 0; i < keys.length; i++) {
        var t = argToText(obj[keys[i]]);
        if (t) return t;
      }
    }
    if (obj) {
      for (i = 0; i < SUMMARY_FALLBACK.length; i++) {
        var t2 = argToText(obj[SUMMARY_FALLBACK[i]]);
        if (t2) return t2;
      }
      // an unknown tool whose input has none of the usual keys: the first value it does have
      var names = Object.keys(obj);
      for (i = 0; i < names.length; i++) {
        var t3 = argToText(obj[names[i]]);
        if (t3) return t3;
      }
      return names.length ? names.length + ' fields' : '';
    }
    return argToText(input);
  }
  /**
   * §8.3: the one-line summary of a tool card. Never throws (a card must render whatever the log
   * held), never multi-line, clipped with an ellipsis when the command is long. It repeats no
   * data: the value it shows is the value the log contained.
   */
  function summaryFor(tool) {
    try {
      var name = toolName(tool);
      var arg = summaryArg(tool || {});
      var lower = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (arg && BASH_LIKE[lower]) arg = '$ ' + arg;
      if (!arg) return name || 'tool call';
      return clip(arg, SUMMARY_MAX);
    } catch (e) {
      return 'tool call';
    }
  }

  // ── values that may be absent, empty, or text ────────────────────────────────

  /** null = absent (no block at all), '' = present but empty (shown as a note, never as a void). */
  function textOf(v) {
    if (v == null) return null;
    if (isStr(v)) return v;
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }
  /** §8.3: pretty-printed input, 2-space JSON. A JSON-string input (hermes) is parsed first. */
  function prettyInput(input) {
    if (input == null) return null;
    if (isStr(input)) {
      var s = input;
      if (s.trim() === '') return null;
      var t = s.trim();
      if (t.charAt(0) === '{' || t.charAt(0) === '[') {
        try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) { /* not JSON: verbatim */ }
      }
      return s;
    }
    try { return JSON.stringify(input, null, 2); } catch (e) { return String(input); }
  }
  /** The result text: tool.result when present, else a tool_result record's own text (§8.2 maps
   *  hermes' row content onto `text`). null = no result yet → no block (§8.3). */
  function resultText(msg, tool, isResult) {
    var r = textOf(tool && tool.result);
    if (r !== null) return r;
    if (isResult) return textOf(msg && msg.text);
    return null;
  }

  // ── rows ─────────────────────────────────────────────────────────────────────

  function metaLine(msg, role, kind) {
    var meta = el('div', 'hd-cv-meta');
    if (msg.sidechain) meta.appendChild(el('span', 'hd-cv-side', 'sidechain (subagent)'));
    meta.appendChild(el('span', 'hd-cv-who', roleLabel(role, kind)));
    var t = el('span', 'hd-cv-time');
    var time = fmtTime(msg.ts), full = fmtFull(msg.ts);
    t.textContent = time || '--:--:--';
    t.title = full || 'this record carries no timestamp';
    meta.appendChild(t);
    return meta;
  }
  function rowOf(child) { var r = el('div', 'hd-cv-row'); r.appendChild(child); return r; }

  // ── folding (A2: the reader folds a bubble) ──────────────────────────────────
  // A2.4: the fold is UI state W2 owns (`opts.foldedKeys = {"<msg.key>": true}`); this file only
  // decides what a folded message looks like, and never listens for a click (W2 handles both the
  // button and the head). A2.1: the DEFAULT is expanded — an absent map, an absent key and a falsy
  // value all render the message in full, which is what every caller before A2 gets for free.

  /** The key this message is folded under, or null when it is drawn expanded. A keyless message
   *  cannot be folded: there would be nothing to key the reader's decision by. */
  function foldedKey(o, msg) {
    var m = o && o.foldedKeys;
    if (!m || typeof m !== 'object' || !msg || msg.key == null) return null;
    var k = str(msg.key);
    if (k === '' || !Object.prototype.hasOwnProperty.call(m, k)) return null;
    return m[k] ? k : null;
  }

  /** The body of one text record as the reader sees it when it is NOT folded: the same markdown
   *  pass, through the same §8.3 length cap. Rendering the raw text instead would count markdown
   *  syntax the reader was never shown, and the text the `show all` control was holding back. */
  function renderedBody(raw, o) {
    var into = el('div', 'hd-cv-body');
    mdRenderer(raw)(false, into, o.maxTextLines);
    return into.textContent;
  }

  /**
   * A2.3 (as corrected by the A2 errata): the folded form. The preview is the RENDERED first
   * non-empty line — folding must not make markdown syntax (`**bold**`, backticks) reappear that the
   * unfolded body was rendering — clipped to SUMMARY_MAX and otherwise verbatim: plain text, no
   * rewrite, and nothing kept only in a `title`.
   *
   * The two counts say what the fold actually HIDES: the characters of the rendered body the preview
   * does not show, and the lines that are not the preview's line. The basis is the body the reader
   * was looking at (cap included), never the raw record, because the raw record contains text that
   * was already behind `show all` — counting that would claim the fold hid more than was on screen.
   * Both are counted, never guessed (§8.3's honesty rule), and counted the way a reader counts (code
   * points), so the clip cannot split a character in half the way a UTF-16 slice can.
   */
  function foldForm(raw, o) {
    var shown = renderedBody(raw, o), lines = shown.split('\n'), i, at = -1;
    for (i = 0; i < lines.length; i++) if (lines[i].trim() !== '') { at = i; break; }
    var line = at < 0 ? '' : lines[at];
    var chars = Array.from(line);
    var clipped = chars.length > SUMMARY_MAX;
    var preview = clipped ? chars.slice(0, SUMMARY_MAX - 1).join('') + '…' : line;
    var pchars = clipped ? SUMMARY_MAX - 1 : chars.length;      // the '…' is ours, not the message's
    return {
      preview: preview,
      chars: Math.max(0, charCount(shown) - pchars),
      lines: Math.max(0, lines.length - (at < 0 ? 0 : 1)),
      // The rest of the disclosure: the lines the local cap is still holding behind `show all`,
      // counted the way that control counts them (its total is the record's own line count). A
      // record inside the cap holds none, so this is 0 and the note says nothing extra.
      behind: Math.max(0, countLines(raw) - lines.length)
    };
  }

  /**
   * A2.3/A2.7: the folded body REPLACES the long-text clamp, so a folded bubble draws no
   * "show all · N lines" control at all. Unfolding renders the message through withClamp() again,
   * which restores exactly what the cap said before the reader folded it — the fold overrides the
   * cap while it lasts, it does not change it.
   *
   * A2 errata rule 3: what the fold must NOT do is hide a disclosure. So the count line also names
   * the text the cap is holding behind `show all` (the reader can no longer see the control that
   * said so), and the server's `text_truncated` note stays outside this body (A2.6).
   */
  function foldInto(bubble, raw, o) {
    var f = foldForm(raw, o);
    var body = el('div', 'hd-cv-body');
    body.appendChild(el('div', 'hd-cv-p', f.preview));
    var stat = f.chars + ' chars · ' + f.lines + ' lines hidden';
    if (f.behind > 0) stat += ' · ' + f.behind + ' more lines behind show all';
    body.appendChild(el('div', 'hd-cv-foldstat', stat));
    bubble.appendChild(body);
  }

  /**
   * A2.4: the message head is half the fold target (the button is the other half), and this is where
   * the control lives. The renderer writes markup only: `data-hd-fold` is what chatview.js toggles,
   * `aria-expanded` states the current state, and `data-hd-foldhead` on the head row makes the whole
   * `who · time` row clickable the way the button is.
   */
  function markFoldHead(meta, key, folded) {
    meta.setAttribute('data-hd-foldhead', key);
    var btn = el('button', 'hd-cv-foldbtn');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-hd-fold', key);
    btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
    btn.textContent = folded ? '▸ unfold' : '▾ fold';
    btn.title = folded ? 'show this message in full' : 'fold this message to its first line';
    meta.appendChild(btn);
    return btn;
  }

  // ── §13.1: the copy button, and the one function that reads a block back ─────
  // MARKUP ONLY, like the fold control above: no listener is attached here, W2's copy.js delegates the
  // click. §13.1.1's button is identical for all three kinds (a bubble's head, a thinking block, a
  // tool card) and is always the LAST child of its head row, so whatever control was already there
  // keeps its own hit area.

  function copyButton(blockId, label) {
    var b = el('button', 'hd-cv-copy');
    b.setAttribute('type', 'button');
    b.setAttribute('data-hd-copy', str(blockId));
    b.setAttribute('aria-label', label == null ? 'copy this block' : str(label));
    b.textContent = '⧉';
    return b;
  }

  /** The verbatim text of every block this file draws, keyed by the block ELEMENT. A WeakMap and not
   *  an attribute: the string is the raw record (up to §8.2's 20,000 chars), and untrusted text must
   *  never become markup — keeping it off the node keeps it out of the DOM entirely. `data-hd-block`
   *  names the block the way `data-hd-copy` names it on the button, so a reader (or a test) can pair
   *  the two; the attribute carries a name and no text, and no state. */
  var BLOCK_TEXT = new WeakMap();
  function markBlock(node, id, text) {
    node.setAttribute('data-hd-block', str(id));
    BLOCK_TEXT.set(node, text == null ? '' : String(text));
    return node;
  }
  /** §13.1.2, the single implementation (the R2 rule). The block a node belongs to is the nearest
   *  marked element at or above it, so a caller may hand this the block, the button, or anything
   *  inside either. An element that is no block at all yields '' — never null — so a caller can take
   *  its length with no special case. What comes back is the string the RENDERER used: a record's own
   *  text (which a fold hides from the reader but not from the clipboard), or a card's input and
   *  result, joined. Head controls, counters and the folded preview are not part of it — those are
   *  this file's chrome, not the log's words. */
  function blockText(blockEl) {
    var n = blockEl;
    while (n && n.nodeType === 1) {
      if (BLOCK_TEXT.has(n)) return BLOCK_TEXT.get(n);
      n = n.parentNode;
    }
    return '';
  }
  /** A card's verbatim text, in the order the card draws it: the input, then the result. The section
   *  labels ("input" / "result") are chrome and are not in it; a part that is absent, or present but
   *  empty, contributes nothing — an empty result draws a note and has no words to copy. */
  function cardText(msg, isResult) {
    var tool = (msg && msg.tool && typeof msg.tool === 'object') ? msg.tool : {};
    var parts = [];
    var input = isResult ? null : prettyInput(tool.input);
    if (input !== null && input !== '') parts.push(input);
    var res = resultText(msg, tool, isResult);
    if (res !== null && res !== '') parts.push(res);
    return parts.join('\n\n');
  }
  /** §13.1.1: does this kind draw a head of its own below the message head? A thinking record and a
   *  tool record do (`.hd-cv-think-row`, `.hd-cv-card-head`), so the copy button lives there and the
   *  message head does not duplicate it. Everything else — a bubble, a system note, an unknown kind —
   *  has only the message head to carry it. */
  function hasBlockHead(kind) {
    return kind === 'thinking' || kind === 'tool_call' || kind === 'tool_result';
  }

  /** The block id of a message row. A record with no key has no name to copy by (A3.2), so it borrows
   *  the same per-pass ordinal the block ids use — computed ONCE per message, so the button and the
   *  block it names cannot end up with two different names. */
  function msgBlockId(msg) {
    var b = idBase(msg);
    return b === '' ? '#msg' + segOrdinal('', 'msg') : b;
  }

  function textRow(msg, text, o, role, foldKey) {
    var bubble = el('div', 'hd-cv-bubble' + (role === 'user' ? ' hd-cv-mine' : ''));
    if (text === '') bubble.appendChild(el('span', 'hd-cv-note', '(this message has no text)'));
    else if (foldKey !== null) foldInto(bubble, text, o);
    else withClamp(text, o, bubble, 'hd-cv-body', mdRenderer(text), textId(msg), false);
    // §8.2 caps a message's text at 20,000 chars. The clamp above is OUR display choice; this note
    // is the SERVER's clamp, and it stays outside the collapsible box so it is visible either way —
    // A2.6: a fold must never hide a disclosure, so folding does not touch it.
    if (msg && msg.text_truncated) bubble.appendChild(truncNote('text'));
    var row = rowOf(bubble);
    if (foldKey !== null) row.className += ' hd-cv-folded';    // A2.4: the class is on the ROW
    return row;
  }

  /** The one wording for a server-side clamp, whichever field was clamped. */
  function truncNote(what) { return el('span', 'hd-cv-note hd-cv-warn', what + ' truncated by the server'); }

  function systemRow(text) {
    // A system line is a diagnostic, not prose: shown verbatim, as one text node.
    var box = el('div', 'hd-cv-sys');
    box.textContent = text === '' ? '(empty system note)' : text;
    return rowOf(box);
  }

  function unknownRow(msg, text, o) {
    var box = el('div', 'hd-cv-sys');
    box.appendChild(el('div', 'hd-cv-note hd-cv-warn',
      'this record has a kind this build does not know (' + str(msg.kind) + ') — its text is shown as sent'));
    if (text !== '') withClamp(text, o, box, 'hd-cv-body', mdRenderer(text), textId(msg), false);
    return rowOf(box);
  }

  /**
   * A3.1: collapsed unless `opts.openKeys[id]` says the reader opened it. The state is in the
   * markup — id on the control, `aria-expanded` stating it, `hd-cv-open` on the body — and no
   * listener is attached here, so re-rendering the turn redraws the reader's own choice instead of
   * collapsing a block they had opened (A3.3: chatview.js delegates the click).
   */
  function thinkingRow(msg, text, o) {
    var box = el('div', 'hd-cv-think');
    var n = charCount(text);
    var id = thinkId(msg);
    var open = isOpen(o, id, false);
    var head = el('button', 'hd-cv-think-head');
    head.setAttribute('type', 'button');
    head.textContent = 'thinking · ' + n + ' chars';          // §8.3's header, exactly
    head.setAttribute('data-hd-open', id);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    var body = el('div', 'hd-cv-think-body' + (open ? ' hd-cv-open' : ''));
    body.hidden = !open;                                      // collapsed unless the reader opened it
    if (text === '') body.appendChild(el('span', 'hd-cv-note', '(this thinking record has no text)'));
    else bodyInto(body, text);                                // expanded: the whole record, as sent
    // §13.1.1: the whole head IS the open/collapse control, so the copy button cannot be its last
    // child — a button may not contain a button. The row is that last child's home instead, and the
    // control keeps every pixel of its own hit area.
    var headRow = el('div', 'hd-cv-think-row');
    headRow.appendChild(head);
    headRow.appendChild(copyButton(id));                      // last child of the head row
    box.appendChild(headRow);
    // Outside the collapsed body on purpose: a server clamp must be visible while folded, so it
    // cannot sit inside the very element the reader has to expand to see it.
    if (msg && msg.text_truncated) box.appendChild(truncNote('text'));
    box.appendChild(body);
    markBlock(box, id, text);                                 // §13.1.2: the thinking block's own text
    return rowOf(box);
  }

  /**
   * A tool call or a tool result. `isResult` is true for a §8.2 `tool_result` record, which — per
   * §8.3 — only ever reaches this function when it could NOT be paired with its call (renderList
   * drops the paired ones, since the result already shows inside the call's card).
   */
  function cardRow(msg, o, isResult) {
    var tool = (msg && msg.tool && typeof msg.tool === 'object') ? msg.tool : {};
    var name = toolName(tool);
    var isErr = !!tool.is_error;
    var res = resultText(msg, tool, isResult);
    // "waiting" is a claim about right now, so it needs two things: no result on the card (a card
    // that HAS one renders it — a stale `pending` flag is not allowed to hide it), and a reason that
    // says the result may still arrive. Only 'not_in_window' retracts the claim; every other value,
    // including the field being absent, keeps the wording above, because a call that is genuinely in
    // flight must never be told its result is not coming.
    var pending = !isResult && !!tool.pending && res === null;
    var stale = pending && tool.pending_reason === 'not_in_window';
    var word = stale ? STALE_WORD : PENDING_WORD;
    var card = el('div', 'hd-cv-card' + (isErr ? ' hd-cv-err' : '')
      + (pending ? (stale ? ' hd-cv-stalecard' : ' hd-cv-pendingcard') : ''));

    var head = el('div', 'hd-cv-card-head');
    if (name) head.appendChild(el('span', 'hd-cv-name', name));
    if (o.unpaired) head.appendChild(el('span', 'hd-cv-note hd-cv-warn', 'unpaired result'));
    var sum = summaryFor(tool);
    if (sum) head.appendChild(el('span', 'hd-cv-sum', sum));
    if (isErr) head.appendChild(el('span', 'hd-cv-errword', 'error'));
    if (pending) head.appendChild(el('span', stale ? 'hd-cv-note hd-cv-stale' : 'hd-cv-pending', word));
    // this card stands for N identical calls the log contains: say so, with the count
    if (o.dupes > 1) head.appendChild(el('span', 'hd-cv-note hd-cv-warn hd-cv-dupes', dupeNote(o.dupes)));

    var body = el('div', 'hd-cv-card-body');
    // A3.1: `opts.expandTools` is only the default for a reader who has expressed no opinion; an
    // `openKeys` entry — true OR false — is the reader's own decision and always wins.
    var tid = toolId(msg);
    var open = isOpen(o, tid, o.expandTools);
    if (open) body.className = 'hd-cv-card-body hd-cv-open';
    else body.hidden = true;

    var inputText = isResult ? null : prettyInput(tool.input);
    if (inputText !== null) {
      body.appendChild(el('div', 'hd-cv-sec', 'input'));
      if (inputText === '') body.appendChild(el('span', 'hd-cv-note', '(this call carried no input)'));
      else withClamp(inputText, o, body, 'hd-cv-resbox', function (full, into, max) {
        into.appendChild(pre(full ? inputText : firstLines(inputText, max), 'hd-cv-json'));
      }, tid + '#in', false);
      if (tool.input_truncated) body.appendChild(truncNote('input'));
    }

    if (res !== null) {
      body.appendChild(el('div', 'hd-cv-sec', 'result'));
      if (res === '') body.appendChild(el('span', 'hd-cv-note', 'the tool returned an empty result'));
      else withClamp(res, o, body, 'hd-cv-resbox', function (full, into, max) {
        into.appendChild(pre(full ? res : firstLines(res, max), 'hd-cv-res'));
      }, tid + '#res', false);
      // an unpaired result's text came in on the record itself (§8.2 maps hermes' row content onto
      // `text`), so the server's cap on it is flagged on the message, not inside `tool`
      if (tool.result_truncated || (isResult && msg && msg.text_truncated)) body.appendChild(truncNote('result'));
    }
    if (!body.children.length) {
      body.appendChild(el('span', stale ? 'hd-cv-note hd-cv-stale' : 'hd-cv-note',
        pending ? word : '(this record carried no input and no result)'));
    }

    var toggle = el('button', 'hd-cv-toggle');
    toggle.setAttribute('type', 'button');
    toggle.setAttribute('data-hd-open', tid);
    toggle.textContent = open ? 'collapse' : 'expand';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    head.appendChild(toggle);
    head.appendChild(copyButton(tid));          // §13.1.1: last child, after the expand/collapse control

    card.appendChild(head);
    card.appendChild(body);
    markBlock(card, tid, cardText(msg, isResult));   // §13.1.2: input, then result, verbatim
    return rowOf(card);
  }

  // ── messages ─────────────────────────────────────────────────────────────────

  /** Any message we cannot draw is still drawn: a note saying so, never a blank, never silent. */
  function noteMessage(text, msg) {
    var root = el('div', 'hd-cv-msg hd-cv-kind-unknown hd-cv-role-system');
    if (msg && msg.key != null) root.setAttribute('data-key', str(msg.key));
    var box = el('div', 'hd-cv-sys');
    box.appendChild(el('div', 'hd-cv-note hd-cv-warn', text));
    root.appendChild(box);
    return root;
  }

  function buildMessage(msg, opts) {
    var o = normOpts(opts);
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return noteMessage('the server sent nothing to render for this message', msg);
    }
    var kind = normKind(msg.kind);
    var role = normRole(msg.role, kind);
    var cls = 'hd-cv-msg hd-cv-role-' + role + ' hd-cv-kind-' + kind;
    if (msg.sidechain) cls += ' hd-cv-sidechain';
    if (msg.pending) cls += ' hd-cv-pendingmsg';
    var root = el('div', cls);
    root.setAttribute('data-key', str(msg.key));
    root.setAttribute('data-role', role);
    root.setAttribute('data-kind', kind);
    if (msg.sidechain) root.setAttribute('data-sidechain', '1');
    if (msg.pending) root.setAttribute('data-pending', '1');

    var text = textOf(msg.text);
    if (text === null) text = '';
    // A2.2: the two text bubbles a reader writes and reads are the ones that fold — a `user` prompt
    // and an `assistant` reply. A thinking record, a tool card, a system note and an unknown kind
    // keep exactly the behaviour they had (A2: "tool cards keep their own expand, unchanged"), and a
    // bubble with no text has nothing to fold, so it keeps its "(no text)" note instead.
    var key = (msg.key == null || str(msg.key) === '') ? null : str(msg.key);
    var foldable = key !== null && kind === 'text' && (role === 'user' || role === 'assistant')
      && text !== '';
    var foldKey = foldable ? foldedKey(o, msg) : null;
    var bid = msgBlockId(msg);
    var meta = metaLine(msg, role, kind);
    if (foldable) markFoldHead(meta, key, foldKey);
    // §13.1.1: the copy button goes in the head of the block the reader wants to copy. For the three
    // copyable blocks that is: a bubble's own head row (here), a thinking block's head, and a tool
    // card's head — so a thinking or tool record does NOT also get one here: its block head already
    // carries the identical button for the same string, and two buttons for one block would be one
    // copy affordance too many. A system note and an unknown-kind record have no other head, so this
    // is theirs. Always the LAST child of the head row, after any fold control (§13.1.1).
    if (!hasBlockHead(kind)) meta.appendChild(copyButton(bid));
    root.appendChild(meta);

    if (kind === 'thinking') root.appendChild(thinkingRow(msg, text, o));
    else if (kind === 'tool_call') root.appendChild(cardRow(msg, o, false));
    else if (kind === 'tool_result') root.appendChild(cardRow(msg, o, true));
    else if (kind === 'system') root.appendChild(systemRow(text));
    else if (kind === 'unknown') root.appendChild(unknownRow(msg, text, o));
    else root.appendChild(textRow(msg, text, o, role, foldKey));

    if (msg.pending && isStr(msg.pending_note) && msg.pending_note !== '') {
      root.appendChild(el('div', 'hd-cv-note', msg.pending_note));   // W2's 20 s sentence, verbatim
    }
    // §13.1.2: the message block — what the head's own button copies, whatever the kind. A tool
    // record's words live in its card, so the message block reads the same string that card does;
    // every other kind reads the record's text. Either way it is the RAW string: a fold (and the
    // long-text clamp behind it) changes only what is DRAWN, never what is copied.
    markBlock(root, bid, (kind === 'tool_call' || kind === 'tool_result')
      ? cardText(msg, kind === 'tool_result') : text);
    return root;
  }

  /** §8.5. Never throws: a malformed record is rendered as the note that says it is malformed. */
  function renderMessage(msg, opts) {
    passBegin();                       // A3.2: one render call = one ordinal pass (see segOrdinal)
    try {
      return buildMessage(msg, opts);
    } catch (e) {
      return noteMessage('this message could not be rendered: ' + (e && e.message ? e.message : String(e)), msg);
    } finally {
      passEnd();
    }
  }

  // ── pairing (§8.3: a paired result must not appear a second time) ─────────────

  /** call_key values that have a tool_call in this list. Two passes, so order cannot matter. */
  function callKeys(messages) {
    var out = {}, list = Array.isArray(messages) ? messages : [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || normKind(m.kind) !== 'tool_call') continue;
      var k = m.tool && m.tool.call_key;
      if (k != null && str(k) !== '') out[str(k)] = true;
    }
    return out;
  }
  /** A tool_result whose call is in this list is already inside that call's card. */
  function isPairedResult(msg, calls) {
    if (!msg || normKind(msg.kind) !== 'tool_result') return false;
    var k = msg.tool && msg.tool.call_key;
    return !!(k != null && str(k) !== '' && calls && calls[str(k)]);
  }

  // ── a call the log contains twice ────────────────────────────────────────────
  // hermes' own db repeats some calls (same call_key, same input, same result) — 104 of them in the
  // session Hermes measured. Drawing both would read as the agent having done the work twice, so
  // identical cards are drawn once and the anomaly is stated with its count instead of hidden.

  /** The note a folded card carries. N=2 is the wording the round asked for, verbatim. */
  function dupeNote(n) {
    var c = Math.floor(Number(n));
    if (!isFinite(c) || c < 2) return '';
    return '×' + c + ' ' + (c === 2
      ? '(the log contains this call twice)'
      : '(the log repeats this call ' + c + ' times)');
  }

  /**
   * What makes two cards "the same call": name + input + result + call_key, all four. A DELIBERATE
   * narrowing of "identical in name+input+result": two calls whose call_key is present and DIFFERENT
   * are never folded, because the server's own id says they are two calls and folding them would
   * drop a real one out of the record. Absent/equal call_keys fold — equal ids are one call recorded
   * twice, which is exactly the hermes shape (§8.2 pairs by id). Returns null for records that are
   * not call cards.
   */
  function dupeIdentity(msg) {
    if (!msg || typeof msg !== 'object') return null;
    if (normKind(msg.kind) !== 'tool_call') return null;
    var tool = (msg.tool && typeof msg.tool === 'object') ? msg.tool : {};
    var key = tool.call_key;
    var input = prettyInput(tool.input);
    var result = resultText(msg, tool, false);
    return [
      toolName(tool).toLowerCase(),
      input === null ? '\u0002absent' : input,
      result === null ? '\u0002absent' : result,
      (key == null || str(key) === '') ? '\u0002nokey' : str(key)
    ].join('\u0001');
  }

  /** index -> how many identical cards start here; plus which indexes are the copies to skip. */
  function foldMap(messages) {
    var list = Array.isArray(messages) ? messages : [];
    var first = {}, count = {}, skip = {};
    for (var i = 0; i < list.length; i++) {
      var id = dupeIdentity(list[i]);
      if (id === null) continue;
      if (Object.prototype.hasOwnProperty.call(first, id)) { count[first[id]]++; skip[i] = true; }
      else { first[id] = i; count[i] = 1; }
    }
    return { skip: skip, count: count };
  }

  /** "count it": how many cards folding removed, and one entry per folded group. */
  function foldReport(messages) {
    var list = Array.isArray(messages) ? messages : [];
    var f = foldMap(list), groups = [], folded = 0, i;
    for (i = 0; i < list.length; i++) {
      if (f.count[i] > 1) {
        var tool = (list[i] && list[i].tool && typeof list[i].tool === 'object') ? list[i].tool : {};
        groups.push({ index: i, count: f.count[i], name: toolName(tool) });
        folded += f.count[i] - 1;
      }
    }
    return { folded: folded, groups: groups };
  }

  /** The opts a record needs because of its neighbours: an unpaired result, a folded call. */
  function neighbourOpts(msg, fold, i, opts) {
    var extra = null;
    if (msg && normKind(msg.kind) === 'tool_result') extra = { unpaired: true };
    if (fold && fold.count[i] > 1) extra = extend(extra, { dupes: fold.count[i] });
    return extra ? extend(opts, extra) : opts;
  }

  /** §8.5. Returns a DocumentFragment of the messages that still need drawing. */
  function renderList(messages, opts) {
    passBegin();
    try {
      var frag = document.createDocumentFragment();
      var list = Array.isArray(messages) ? messages : [];
      var calls = callKeys(list);
      var fold = foldMap(list);
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (isPairedResult(m, calls)) continue;
        if (fold.skip[i]) continue;
        frag.appendChild(renderMessage(m, neighbourOpts(m, fold, i, opts)));
      }
      return frag;
    } finally {
      passEnd();
    }
  }

  /** §8.5. A fresh object each call: the caller may keep or mutate it without surprising anyone. */
  function autoScrollOpts() { return { stickPx: STICK_PX }; }

  // ── turns (A1: progressive, segmented rendering) ──────────────────────────────

  /**
   * A segment with nothing in it is skipped rather than drawn as a blank row (A1). A tool card is
   * not "empty": a call the agent made is a fact the reader is owed, so a card with no arguments is
   * still drawn (it says so). Only a card that carries no name, no input AND no result is nothing.
   */
  function isEmptySegment(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return true;
    var kind = normKind(msg.kind);
    var text = textOf(msg.text);
    if (text !== null && text !== '') return false;
    if (kind === 'tool_call' || kind === 'tool_result') {
      var tool = (msg.tool && typeof msg.tool === 'object') ? msg.tool : {};
      return tool.input === undefined && toolName(tool) === '' &&
        resultText(msg, tool, kind === 'tool_result') === null;
    }
    return true;
  }

  /** ms -> the whole seconds in "working · 12s". null when the caller did not give us a number:
   *  an unknown elapsed time is reported as unknown, never as a 0 we invented. */
  function elapsedSeconds(ms) {
    var n = typeof ms === 'number' ? ms : (isStr(ms) && ms.replace(/\s/g, '') !== '' ? Number(ms) : NaN);
    if (!isFinite(n) || n < 0) return null;
    return Math.floor(n / 1000);
  }
  /** The readable form of the same value, for the title only. */
  function elapsedLabel(ms) {
    var s = elapsedSeconds(ms);
    if (s === null) return null;
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + pad2(s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + pad2(Math.floor((s % 3600) / 60)) + 'm';
  }

  /**
   * A1 rule 4: the live tail of a turn whose pane's `agent_status` is `working`, drawn instead of a
   * reply bubble so a running turn can never look finished. It claims exactly one thing — that the
   * turn is still running, and for how long the caller measured — and it is deliberately not a
   * bubble. The pulse is decoration on a dot (A1 rule 5 forbids a per-token typing effect: the
   * source is block level, so any token-level motion would be an animation pretending to be the
   * log).
   */
  function renderWorkingTail(elapsedMs) {
    var secs = elapsedSeconds(elapsedMs);
    var box = el('div', 'hd-cv-working');
    if (secs !== null) box.setAttribute('data-elapsed-ms', String(Math.floor(Number(elapsedMs))));
    var dot = el('span', 'hd-cv-dot');
    dot.setAttribute('aria-hidden', 'true');
    box.appendChild(dot);
    var label = el('span', 'hd-cv-working-text', secs === null ? 'working' : 'working · ' + secs + 's');
    label.title = secs === null
      ? 'this turn is running; the server did not report for how long'
      : 'this turn has been running for ' + elapsedLabel(elapsedMs);
    box.appendChild(label);
    return box;
  }

  /**
   * A note a turn shows only because it has nothing else yet. It is marked `data-hd-placeholder`
   * because the panel appends records into a LIVE turn (W3 §9: a running turn is no longer rebuilt on
   * every poll): the moment a record lands, the sentence is no longer true and the appender removes
   * exactly the nodes carrying that mark — never a note that is part of the record. The wording is the
   * same string it always was; only the attribute is new.
   */
  function placeholder(text) {
    var n = el('div', 'hd-cv-note', text);
    n.setAttribute('data-hd-placeholder', '1');
    return n;
  }

  // ── a closed turn's process fold ─────────────────────────────────────────────
  // The answer is what the reader came for, so the records that produced it sit behind ONE control.
  // The control carries a stable id, its state lives in `opts.openKeys` like every other collapsible
  // block, and it is toggled by chatview.js's delegation (`data-hd-open`) — this file only draws it.

  function isToolKind(m) {
    var k = normKind(m && m.kind);
    return k === 'tool_call' || k === 'tool_result';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  /** The control's id: derived from the turn's own first record, never from the DOM or the span, so
   *  appending a record to the turn cannot rename the reader's fold. */
  function procIdOf(t, kept) {
    var first = (t && t.user) ? t.user : (kept.length ? kept[0] : null);
    var base = first ? idBase(first) : '';
    if (base !== '') return base + '#proc';
    var ts = first ? tsMs(first.ts) : null;      // keyless records: the timestamp is the best name
    return '#turn' + (ts === null ? '0' : String(ts)) + '#proc';
  }
  /** `N messages · M tool calls · 12s` — what the fold hides. A tool call/result record is a tool
   *  call; every other record (thinking, interim text) is a message. The duration is the turn's own
   *  span, prompt to answer, and is omitted when either end carries no timestamp. */
  function processSummary(entries, toolCalls, durationMs) {
    var msgs = entries.length - toolCalls;
    var parts = [];
    if (msgs > 0) parts.push(plural(msgs, 'message', 'messages'));
    if (toolCalls > 0) parts.push(plural(toolCalls, 'tool call', 'tool calls'));
    var dur = elapsedLabel(durationMs);
    if (dur) parts.push(dur);
    return parts.length ? parts.join(' · ') : plural(entries.length, 'record', 'records');
  }
  /** The disclosures a fold must not swallow. The records inside the fold still carry their own
   *  notes; this line restates them ABOVE the fold so a collapsed turn never hides a server clamp or
   *  pretends a pending call is a finished one. */
  function disclosureNotes(entries) {
    var textTrunc = 0, toolTrunc = 0, waiting = 0, stale = 0;
    for (var i = 0; i < entries.length; i++) {
      var m = entries[i].msg, kind = normKind(m && m.kind);
      var tool = (m && m.tool && typeof m.tool === 'object') ? m.tool : {};
      var isResult = kind === 'tool_result';
      if (isToolKind(m)) {
        if (tool.input_truncated || tool.result_truncated || (isResult && m.text_truncated)) toolTrunc++;
        if (!isResult && tool.pending && resultText(m, tool, false) === null) {
          if (tool.pending_reason === 'not_in_window') stale++;
          else waiting++;
        }
      } else if (m && m.text_truncated) textTrunc++;
    }
    var parts = [];
    if (textTrunc) parts.push(plural(textTrunc, 'message', 'messages') + ' truncated by the server');
    if (toolTrunc) parts.push('tool ' + (toolTrunc === 1 ? 'output' : 'outputs') + ' truncated by the server');
    if (waiting) parts.push(plural(waiting, 'call', 'calls') + ' waiting for a result');
    if (stale) parts.push(plural(stale, 'call', 'calls') + ' with no result in the loaded window');
    return parts.join(' · ');
  }

  /** The folded process: control, restated disclosures, then the hidden records themselves. */
  function processGroup(t, kept, entries, toolCalls, durationMs, fold, opts) {
    var o = normOpts(opts);
    var id = procIdOf(t, kept);
    var open = isOpen(o, id, false);            // a closed turn starts folded; openKeys always wins
    var wrap = el('div', 'hd-cv-processwrap');

    var btn = el('button', 'hd-cv-procbtn');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-hd-open', id);
    btn.setAttribute('data-hd-proc', id);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.title = open ? 'hide the records behind this answer' : 'show the records behind this answer';
    var caret = el('span', 'hd-cv-proccaret', open ? '▾' : '▸');
    caret.setAttribute('aria-hidden', 'true');
    btn.appendChild(caret);
    btn.appendChild(el('span', 'hd-cv-procsum', processSummary(entries, toolCalls, durationMs)));
    wrap.appendChild(btn);

    var notes = disclosureNotes(entries);
    if (notes) {
      var note = el('div', 'hd-cv-procnotes', notes);
      note.setAttribute('data-hd-procnotes', '1');
      wrap.appendChild(note);
    }

    var box = el('div', 'hd-cv-process' + (open ? ' hd-cv-open' : ''));
    box.hidden = !open;
    for (var i = 0; i < entries.length; i++) {
      var m = entries[i].msg;
      var node = renderMessage(m, neighbourOpts(m, fold, entries[i].at, opts));
      if (normKind(m.kind) === 'text') node.className += ' hd-cv-interim';   // not the answer
      box.appendChild(node);
    }
    wrap.appendChild(box);
    return wrap;
  }

  // ── runs of tool records drawn in the open ───────────────────────────────────
  // A running turn, and the records a finished turn keeps after its answer, have no fold to live
  // in — so a dozen consecutive tool calls used to be a dozen identical frames. Two or more in a
  // row are drawn as one group with a count and a state; the cards themselves are unchanged inside
  // the body, each keeping its own expand control, copy button, clamps and pending wording. One
  // tool record on its own is not a group: a run of one is drawn exactly as before.

  var TOOL_GROUP_NAMES = 3;          // names in the head's one line, before the ellipsis

  /** The group's id, named after the record that starts it — so appending a record to the turn
   *  cannot rename a group the reader already closed. A record with no key falls back to its index
   *  in the turn, which is the only stable name such a record has. */
  function toolGroupId(items) {
    var base = items.length ? idBase(items[0].msg) : '';
    return base !== '' ? base + '#tgrp' : '#tgrp' + items[0].at;
  }

  /** What the head says: the count, the first few names, and the facts a reader must not have to open
   *  the group to learn — a failed call, a call still waiting, and a result outside this window. */
  function toolGroupFacts(items) {
    var names = [], more = false, errors = 0, waiting = 0, stale = 0, i;
    for (i = 0; i < items.length; i++) {
      var m = items[i].msg;
      var tool = (m && m.tool && typeof m.tool === 'object') ? m.tool : {};
      var isResult = normKind(m.kind) === 'tool_result';
      if (tool.is_error) errors++;
      // The same "is this still coming" test the card itself uses, so the count and the card can
      // never disagree: no result on the record, and the server has not retracted the claim. A call
      // whose result is simply outside the loaded window is not still running — the card says that
      // in its own words, and the group must not call it waiting.
      if (!isResult && tool.pending && resultText(m, tool, false) === null) {
        if (tool.pending_reason === 'not_in_window') stale++;
        else waiting++;
      }
      if (names.length >= TOOL_GROUP_NAMES) { more = true; continue; }
      var name = toolName(tool);
      if (name) names.push(name);
    }
    var summary = plural(items.length, 'tool call', 'tool calls');
    if (names.length) summary += ' · ' + names.join(', ') + (more ? ', …' : '');
    var facts = [];
    if (errors) facts.push(plural(errors, 'error', 'errors'));
    if (waiting) facts.push(waiting + ' waiting');
    if (stale) facts.push(plural(stale, 'call', 'calls') + ' with no result in this window');
    return { summary: summary, facts: facts.join(' · '), attention: errors > 0 || waiting > 0 || stale > 0 };
  }

  /** One run of two or more tool records. Collapsed by default unless something in it needs the
   *  reader's eyes; `opts.openKeys[id]` is the reader's own choice and always wins. No listener is
   *  attached here: the head carries the id and the state, and the panel delegates the click. */
  function toolGroup(items, fold, opts) {
    var o = normOpts(opts);
    var id = toolGroupId(items);
    var facts = toolGroupFacts(items);
    var open = isOpen(o, id, facts.attention);
    var wrap = el('div', 'hd-cv-toolgroup');

    var head = el('button', 'hd-cv-toolgroup-head');
    head.setAttribute('type', 'button');
    head.setAttribute('data-hd-open', id);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    head.title = open ? 'hide these tool calls' : 'show these tool calls';
    var caret = el('span', 'hd-cv-toolgroup-caret', open ? '▾' : '▸');
    caret.setAttribute('aria-hidden', 'true');
    head.appendChild(caret);
    head.appendChild(el('span', 'hd-cv-toolgroup-sum', facts.summary));
    if (facts.facts) head.appendChild(el('span', 'hd-cv-toolgroup-err', facts.facts));
    wrap.appendChild(head);

    var body = el('div', 'hd-cv-toolgroup-body' + (open ? ' hd-cv-open' : ''));
    body.hidden = !open;
    for (var i = 0; i < items.length; i++) {
      body.appendChild(renderMessage(items[i].msg, neighbourOpts(items[i].msg, fold, items[i].at, opts)));
    }
    wrap.appendChild(body);
    return wrap;
  }

  /** Draw records in log order, one node each except for the runs a toolGroup takes over. `interim`
   *  marks a text record as an interim note rather than the answer (a turn with no reply has no
   *  answer to mark). */
  function drawRecords(parent, items, fold, opts, interim) {
    var i = 0;
    while (i < items.length) {
      var m = items[i].msg;
      if (isToolKind(m)) {
        var j = i;
        while (j < items.length && isToolKind(items[j].msg)) j++;
        if (j - i > 1) {
          parent.appendChild(toolGroup(items.slice(i, j), fold, opts));
          i = j;
          continue;
        }
      }
      var node = renderMessage(m, neighbourOpts(m, fold, items[i].at, opts));
      if (interim && normKind(m.kind) === 'text') node.className += ' hd-cv-interim';  // not the answer
      parent.appendChild(node);
      i++;
    }
  }

  /** The same counts the control shows, for a caller that appends to an already-drawn turn and must
   *  refresh its summary without redrawing the group. `turn` has the renderTurn shape ({user,
   *  segments, working}); returns {text, notes, count, toolCalls, durationMs}. */
  function processInfo(turn) {
    var t = (turn && typeof turn === 'object' && !Array.isArray(turn)) ? turn : {};
    var segs = Array.isArray(t.segments) ? t.segments : [];
    var kept = [], i;
    for (i = 0; i < segs.length; i++) if (!isEmptySegment(segs[i])) kept.push(segs[i]);
    var lastText = -1;
    if (!t.working) {
      for (i = kept.length - 1; i >= 0; i--) {
        if (normKind(kept[i].kind) === 'text' && normRole(kept[i].role, 'text') === 'assistant') {
          lastText = i;
          break;
        }
      }
    }
    var entries = [], toolCalls = 0;
    for (i = 0; i < kept.length; i++) {
      if (i === lastText || i > lastText) continue;
      entries.push({ msg: kept[i], at: i });
      if (isToolKind(kept[i])) toolCalls++;
    }
    var startTs = t.user ? tsMs(t.user.ts) : (kept.length ? tsMs(kept[0].ts) : null);
    var endTs = lastText >= 0 ? tsMs(kept[lastText].ts) : null;
    var duration = (startTs !== null && endTs !== null) ? Math.max(0, endTs - startTs) : null;
    return {
      text: processSummary(entries, toolCalls, duration),
      notes: disclosureNotes(entries),
      count: entries.length, toolCalls: toolCalls, durationMs: duration
    };
  }

  /**
   * A1: one turn as ONE visual group — the user's prompt is the head bubble, the agent's records
   * follow in log order as distinguishable segments, and the last assistant text is the closing
   * reply bubble (marked, so the answer is findable without reading the process). While `working`
   * there is no reply by construction: the group ends in renderWorkingTail() instead, and every
   * text segment is marked interim. Nothing is reordered and nothing is merged across kinds.
   *
   * A closed turn keeps its answer visible and puts the work behind ONE control (`N messages ·
   * M tool calls · duration`). The control defaults to folded because the answer is what the reader
   * came for; while a turn is running there is nothing to fold yet, so its records stay in the open
   * (the expanded state the control would name). Server clamps and pending/stale facts are restated
   * above the folded body, so folding can never hide a disclosure.
   */
  function renderTurn(turn, opts) {
    passBegin();
    try {
      var o = normOpts(opts);
      var t = (turn && typeof turn === 'object' && !Array.isArray(turn)) ? turn : {};
      var segs = Array.isArray(t.segments) ? t.segments : [];
      var group = el('div', 'hd-cv-turn' + (t.pending ? ' hd-cv-turn-pending' : ''));
      if (t.pending) group.setAttribute('data-pending', '1');

      var user = (t.user && typeof t.user === 'object' && !Array.isArray(t.user)) ? t.user : null;
      if (user) group.appendChild(renderMessage(user, opts));
      else group.appendChild(noteMessage('this turn has no prompt record — the agent\'s own records follow', null));

      var body = el('div', 'hd-cv-turn-body');
      var kept = [], i;
      for (i = 0; i < segs.length; i++) if (!isEmptySegment(segs[i])) kept.push(segs[i]);

      // the reply is the LAST assistant text record — only a turn that is no longer working has one
      var lastText = -1;
      if (!t.working) {
        for (i = kept.length - 1; i >= 0; i--) {
          if (normKind(kept[i].kind) === 'text' && normRole(kept[i].role, 'text') === 'assistant') {
            lastText = i;
            break;
          }
        }
      }

      var fold = foldMap(kept), drawn = 0;
      if (lastText >= 0) {
        /* the answer closes the turn: the records before it are the process, the answer itself is
           never inside the fold, and a record that came after the answer keeps its log position */
        var answer = kept[lastText];
        var before = [], after = [], toolCalls = 0;
        for (i = 0; i < kept.length; i++) {
          if (i === lastText || fold.skip[i]) continue;
          var item = { msg: kept[i], at: i };
          if (i < lastText) {
            before.push(item);
            if (isToolKind(kept[i])) toolCalls++;
          } else after.push(item);
        }
        var startTs = user ? tsMs(user.ts) : (kept.length ? tsMs(kept[0].ts) : null);
        var endTs = tsMs(answer.ts);
        var duration = (startTs !== null && endTs !== null) ? Math.max(0, endTs - startTs) : null;
        if (before.length) body.appendChild(processGroup(t, kept, before, toolCalls, duration, fold, opts));
        var answerNode = renderMessage(answer, neighbourOpts(answer, fold, lastText, opts));
        answerNode.className += ' hd-cv-reply';
        body.appendChild(el('div', 'hd-cv-replytag', 'reply'));
        body.appendChild(answerNode);
        // records the log kept after the answer are drawn in the open, so they group the way a
        // running turn's do; the records before the answer stay inside the process fold, which has
        // its own summary and is not grouped
        drawRecords(body, after, fold, opts, false);
        drawn = before.length + 1 + after.length;
      } else {
        var openRecords = [];
        for (i = 0; i < kept.length; i++) {
          if (fold.skip[i]) continue;
          openRecords.push({ msg: kept[i], at: i });
        }
        drawRecords(body, openRecords, fold, opts, true);
        drawn = openRecords.length;
      }
      if (t.working) body.appendChild(renderWorkingTail(t.elapsedMs));
      else if (!drawn) {
        // only worth saying when there WAS a prompt: a turn with neither prompt nor records has
        // already said so in the head, and two notes about one silence is noise
        if (user) body.appendChild(placeholder('(this turn has no records to show yet)'));
      }
      else if (lastText < 0) body.appendChild(placeholder(
        '(no reply in this turn — the log ends with the records above)'));

      group.appendChild(body);
      return group;
    } catch (e) {
      return noteMessage('this turn could not be drawn (' + str(e && e.message) + ')', null);
    } finally {
      passEnd();
    }
  }

  // ── publication ──────────────────────────────────────────────────────────────
  // No §3 module object: nothing here mounts, and chatview (W2) owns the panel. The name is the
  // frozen one, so load order is the only rule — chat-render.js must come before chatview.js.

  var ChatRender = {
    renderMessage: renderMessage,
    renderList: renderList,
    summaryFor: summaryFor,
    autoScrollOpts: autoScrollOpts,
    renderTurn: renderTurn,                 // A1
    renderWorkingTail: renderWorkingTail,    // A1
    foldReport: foldReport,                  // "count it", for whoever wants to show the total
    processInfo: processInfo,                // the control's summary/notes, for an in-place append
    blockText: blockText,                    // §13.1.2: W2's copy.js consumes this
  };
  window.ChatRender = ChatRender;
  HD.chatRender = ChatRender;
  /** The pure parts, for the local test suite (and W2, if it wants the same formatting). */
  HD.chatRenderTest = {
    fmtTime: fmtTime, fmtFull: fmtFull, tsMs: tsMs, charCount: charCount, countLines: countLines,
    firstLines: firstLines, splitFences: splitFences, splitInlineCode: splitInlineCode,
    prettyInput: prettyInput, textOf: textOf, resultText: resultText, summaryArg: summaryArg,
    cardText: cardText, msgBlockId: msgBlockId, highlightCode: highlightCode,
    toolName: toolName, callKeys: callKeys, isPairedResult: isPairedResult, normKind: normKind,
    normRole: normRole, normOpts: normOpts, roleLabel: roleLabel, clip: clip, linkNode: linkNode,
    dupeNote: dupeNote, dupeIdentity: dupeIdentity, foldMap: foldMap, isEmptySegment: isEmptySegment,
    elapsedSeconds: elapsedSeconds, elapsedLabel: elapsedLabel, processInfo: processInfo,
    STICK_PX: STICK_PX, DEF_MAX_TEXT_LINES: DEF_MAX_TEXT_LINES, SUMMARY_MAX: SUMMARY_MAX,
  };
})();
