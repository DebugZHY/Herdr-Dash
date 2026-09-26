/* herdr-dash — lib/pathlink.js (W3, CONTRACT-v2 §13.2)
 *
 * File paths in agent output become links — but only paths the SERVER says exist, and only ever by
 * rewriting TEXT NODES, never HTML. This module is self-contained: it depends on nothing but the DOM,
 * `fetch` and the two endpoints (§13.2.3 / §13.2.5, W1's), and it never touches the panel's own
 * modules. It is mounted by W2 (§13.2.1's "mounting of §13.2.1") and it draws nothing when there is
 * nothing to draw.
 *
 * FROZEN INTERFACE (§13.2.1 — do not rename):
 *   HD.pathlink.mount(host, opts)  -> the module (a handle); remembers the host and decorates it
 *   HD.pathlink.unmount()          -> forget the host, stop observing, close any menu
 *   HD.pathlink.decorate(rootEl)   -> one pass over a subtree; returns a promise of its summary
 *   HD.pathlink.state()            -> a snapshot: what it knows, what it asked, what it drew
 * and, for the tests only (the same convention as HD.chatRenderTest / HD.dockTest):
 *   HD.pathlinkTest = { candidatesIn, anchorsIn, CLS, MAX_PER_PASS, REJECT_AT, STOP }
 *
 * WHY A PATH MAY NOT BECOME A LINK. §13.2.2: candidates are absolute drive paths (`C:\…`, `C:/…`),
 * UNC shares (`\\server\share\…`) and MSYS forms (`/c/…`). A relative path is NOT a candidate (there
 * is nothing to resolve it against — resolving it against the server's own cwd would open something
 * the agent never named). A path the agent ELIDED with `…` is not a candidate either: the reader was
 * shown `C:\Users\…\x`, and a link to the readable prefix `C:\Users` would claim to be the path the
 * agent wrote while going somewhere else. Same for a line-broken fragment: half a path is not a path.
 *
 * WHAT THE EXTRACTOR ACTUALLY DOES. It scans each text node for the three anchors, takes the maximal
 * run from the anchor up to a hard stop (whitespace, a quote, `…`, an XML/glob character, or a
 * control character), then derives a few VARIANTS of that run — the whole run, and (when it contains
 * spaces) only up to the first space, each with the trailing prose punctuation trimmed. Variants
 * matter because a path can contain a space ("C:\Program Files\app.exe") AND be followed by prose
 * ("…\\app.exe and then"): asking about both forms and letting the SERVER's `exists` choose is what
 * keeps a real path from being swallowed by the prose around it and keeps prose from becoming a link.
 * A wrong guess costs one entry in a request; it can never produce a link (§13.2.4).
 *
 * WHAT MAKES A LINK. Only `exists:true` (§13.2.4). A directory opens on a real click
 * (`action:"open"`); a FILE opens an in-page menu with Open and Open File Location, so the reader
 * chooses between handing it to its default app and revealing it in Explorer. `exists:false`, or no
 * answer yet, leaves the agent's text exactly as written: no link, no tooltip, no click.
 *
 * A FOLDER CLICK MUST BE VISIBLE (§13.5). A directory opens directly, so the page has no in-page
 * result of its own to show: the system's file manager takes the path and says nothing back — it may
 * open behind this window, or reuse a window already open. The reader therefore saw nothing happen
 * and clicked again: four times in 1.6 s. So a directory click leaves a transient note in this
 * module's own host, naming the path the server RESOLVED and handed over (the native form — that is
 * what the system got, which is not necessarily the `/d/…` the agent wrote) and the server's own
 * sentence that it was handed over. Never "opened" (§13.2.7), and no claim that a window came to the
 * front. It is never modal, never takes focus, and is positioned out of flow, so it cannot scroll the
 * chat or move the reader's place in it. A refusal shows the same surface with the server's own
 * reason instead of nothing. A second click replaces the note rather than stacking; Escape and the
 * next click anywhere dismiss it. A FILE is unchanged: it still opens its menu.
 *
 * HONESTY (§13.2.7). The answer says what was DONE — "handed to the system" — never "opened": the
 * server hands the path to `explorer.exe`, and `explorer.exe` exits 1 even when it succeeds, so the
 * exit code is not evidence (§13.0). The menu shows the path VERBATIM (never prettified, never
 * truncated), and a refusal or a failure is shown in the menu, verbatim, instead of closing it
 * silently. Nothing here writes to a pane, and nothing is reported as done that was not answered.
 *
 * DEGRADATION (§13.2.8). No candidates → no request and nothing rendered. `/api/pathinfo` missing or
 * failing → every path stays plain text, asking stops for good, and `state().available === false`
 * with the reason. A click while a request is in flight is IGNORED (never a queue of spawns), and
 * `state().pending` says one is running.
 *
 * DOM (the frozen names; pathlink.css styles these — a later round reuses them, never a second shape):
 *   a.hd-pl-link[data-hd-path][data-hd-kind="file"|"dir"]      one confirmed path, verbatim text
 *   .hd-pl-menu[role="menu"]                 the file menu, in the mounted host
 *     .hd-pl-menu-path                        the path verbatim, wrapped, never ellipsised
 *     button.hd-pl-menu-btn[data-hd-act="open"|"reveal"]   "Open" / "Open File Location"
 *     .hd-pl-menu-note                        what was done, or why it was not
 *   .hd-pl-note[role="status"]               §13.5's transient note for a FOLDER click, same host
 *     .hd-pl-note-path                        the path the server RESOLVED and handed over
 *     .hd-pl-note-text                        the server's sentence, or its refusal, verbatim
 *
 * The only innerHTML in this file is '' (clearing, in clear()); everything else is createElement,
 * createTextNode and textContent, because the path came from a log and the log is untrusted text.
 */
(function () {
  'use strict';

  var HD = (window.HD = window.HD || {});

  var ROUTE_INFO = '/api/pathinfo';      // §13.2.3 (W1)
  var ROUTE_OPEN = '/api/open';          // §13.2.5 (W1)
  var ACTION_HEADER = 'x-hd-action';     // §13.2.6: required, with a same-origin request
  var ACTION_VALUE = '1';
  var MAX_PER_PASS = 200;                // §13.2.2: at most 200 NEW candidates per pass
  var MAX_CANDIDATE = 1000;              // a run longer than this is not a path, it is a paragraph
  var MIN_CANDIDATE = 4;                 // `C:\a`, `/c/x`; the bare anchors (`/c/`) are not paths
  var MAX_VARIANTS = 8;                  // how many readings of one run are offered (see anchorsIn)
  var REQ_TIMEOUT_MS = 8000;             // a request the server never answers cannot freeze the panel
  var DEBOUNCE_MS = 120;                 // a burst of appends is one pass, not twenty
  var MENU_DONE_MS = 1400;               // how long the "done" sentence stays before the menu closes
  var NOTE_MS = 4000;                    // §13.5: how long a folder note stays before it dismisses itself
  var CSS_HREF = '/lib/pathlink.css';

  var CLS = {
    link: 'hd-pl-link',
    menu: 'hd-pl-menu', menuPath: 'hd-pl-menu-path', menuBtn: 'hd-pl-menu-btn', menuNote: 'hd-pl-menu-note',
    note: 'hd-pl-note', notePath: 'hd-pl-note-path', noteText: 'hd-pl-note-text'
  };
  var ACT_OPEN = 'open';
  var ACT_REVEAL = 'reveal';

  /* The three anchors (§13.2.2) and the characters that END a run. `\s` is NOT a stop: a Windows
     path carries spaces, so only a tab, a newline or a control character ends a run at whitespace.
     `…` is a stop because the agent's own ellipsis means the text is not the whole path. */
  var ANCHOR = /[A-Za-z]:[\\/]|\\\\|\/[A-Za-z]\//;
  var STOP = /[\t\n\r\u0000-\u001f\u007f\u2026"'<>|*?]/;
  /* A character that says "the run before this was a path or a URL too". `https://a/b` matches the
     MSYS anchor at `/a/`, and `foo/C:/x` matches the drive anchor — neither is a path the agent
     named, so both are refused at the position where they would start. */
  var BEFORE = /[\w\\/:.\-]/;
  /* The prose a path is often wrapped in: closing punctuation and sentence-end marks. The trimmed
     form is offered ALONGSIDE the untrimmed one, never instead of it — a directory really can be
     named `Program Files (x86)`, and only the server's answer can tell the two cases apart. */
  var TRAIL = /[.,;:!?)\]\}\u00bb\u201d]/;
  var REJECT_AT = '\u2026';              // the elision mark, named once

  // ── small helpers ────────────────────────────────────────────────────────────

  function str(v) { return v == null ? '' : String(v); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function clear(n) { n.innerHTML = ''; }
  function on(node, type, fn) { if (node && node.addEventListener) node.addEventListener(type, fn); }
  function off(node, type, fn) { if (node && node.removeEventListener) node.removeEventListener(type, fn); }
  function setAttr(node, k, v) { if (node && node.setAttribute) node.setAttribute(k, str(v)); }
  /** One stylesheet link, once (the page may already carry it; W2 may also add it to index.html). */
  function ensureCss() {
    if (!document.head || !document.createElement) return;
    var links = document.head.querySelectorAll ? document.head.querySelectorAll('link[rel="stylesheet"]') : [];
    for (var i = 0; i < links.length; i++) if (links[i].getAttribute('href') === CSS_HREF) return;
    var l = el('link');
    setAttr(l, 'rel', 'stylesheet');
    setAttr(l, 'href', CSS_HREF);
    document.head.appendChild(l);
  }

  // ── the extractor (§13.2.2) ──────────────────────────────────────────────────

  /** The maximal run from `at` up to the first hard stop. A run that reaches the end of the node is
   *  as long as the node: a text node is a slice of a line, so a path can legitimately end there. */
  function runFrom(text, at) {
    var i = at;
    while (i < text.length && !STOP.test(text.charAt(i))) i++;
    return text.slice(at, i);
  }
  /** Trailing spaces are not part of a path, trailing prose punctuation may not be either: both
   *  forms are offered as variants and the server decides. `trimmed` counts the characters removed,
   *  so a caller knows how much of the run the chosen variant covers. */
  function trimRun(run) {
    var out = run.replace(/[ \u00a0]+$/, ''), steps = run.length - out.length;
    while (out.length > MIN_CANDIDATE && TRAIL.test(out.charAt(out.length - 1))) {
      out = out.slice(0, out.length - 1);
      steps++;
    }
    return { text: out, steps: steps };
  }
  /** One reading of a run, added to a list of readings: the run with its trailing whitespace removed,
   *  and \u2014 when that differs \u2014 the same reading with its trailing prose punctuation removed as well.
   *  BOTH are asked, because the corpus has directories that really end in `)` (a `C:\Program Files
   *  (x86)` is an everyday folder) and sentences that really end in `.` right after a path, and only
   *  the server's answer can tell them apart. The longest reading that exists is the one that wins. */
  function addReading(list, raw) {
    var spaced = raw.replace(/[ \u00a0]+$/, '');
    var trimmed = trimRun(raw).text;
    if (spaced.length && list.indexOf(spaced) < 0) list.push(spaced);
    if (trimmed.length && trimmed !== spaced && list.indexOf(trimmed) < 0) list.push(trimmed);
    return list;
  }
  /** Every candidate this text offers, as `{at, variants:[…]}` in the order they appear. The
   *  variants of one anchor are its whole run and (when the run has a space) its first token, each
   *  also with the trailing punctuation trimmed — deduped, longest first, so "the longest confirmed
   *  variant wins" is a rule the decoration code can state in one line. */
  function anchorsIn(text) {
    var s = str(text), out = [], m;
    /* ANCHOR is shared state and has no `g` flag of its own, so the scan uses its own global copy:
       a non-global regexp's exec() always answers the same index, which would spin here forever.
       The copy is also what guarantees one anchor per position is examined exactly once. */
    var re = new RegExp(ANCHOR.source, 'g');
    while ((m = re.exec(s)) !== null) {
      var at = m.index;
      var before = at > 0 ? s.charAt(at - 1) : '';
      if (before !== '' && BEFORE.test(before)) continue;         // inside a URL, or after a path
      var run = runFrom(s, at);
      if (run === '') continue;
      // §13.2.2: the agent elided this path. `C:\Users\…` and `C:\…\x` both land here — the whole
      // position is refused, because the readable prefix is not the path the agent wrote.
      if (s.charAt(at + run.length) === REJECT_AT || run.indexOf(REJECT_AT) >= 0) continue;
      var variants = addReading([], run);
      /* A space does not end a run — a Windows path may contain one — which means a run also contains
         whatever prose follows the path ("wrote C:\a\b.txt to disk"). So every reading that ends at a
         space boundary is offered as well, from the anchor forward (the path's own spaces come first;
         deeper ones are the sentence), capped so one long line cannot cost a request of its readings.
         A reading that has already swallowed a SECOND path is where this stops: `C:\a C:\b` cut after
         the first space is a reading; the same line cut after the second space is not. */
      var cuts = [], k;
      for (k = 1; k < run.length && cuts.length < MAX_VARIANTS; k++) {
        if (run.charAt(k) === ' ') cuts.push(k);
      }
      for (var c = 0; c < cuts.length; c++) {
        var head = run.slice(0, cuts[c]);
        if (ANCHOR.test(head.slice(1))) break;      // this reading is two paths, not one
        addReading(variants, head);                 // cuts[0] is the first token: `C:\Program`
      }
      variants = variants.filter(function (v) {
        return v.length >= MIN_CANDIDATE && v.length <= MAX_CANDIDATE && v.indexOf(REJECT_AT) < 0
          && !STOP.test(v);                                        // defensive: never a control char
      });
      if (!variants.length) continue;
      variants.sort(function (a, b) { return b.length - a.length; });
      out.push({ at: at, len: variants[0].length, variants: variants });
    }
    return out;
  }
  /** The candidates of one text, flat and deduped — the shape the pure tests read. */
  function candidatesIn(text) {
    var seen = {}, out = [];
    var anchors = anchorsIn(text);
    for (var i = 0; i < anchors.length; i++) {
      for (var j = 0; j < anchors[i].variants.length; j++) {
        var v = anchors[i].variants[j];
        if (!seen[v]) { seen[v] = true; out.push(v); }
      }
    }
    return out;
  }

  // ── module state ─────────────────────────────────────────────────────────────

  var host = null, mounted = false, observer = null, debounce = null;
  var menu = null, menuLink = null, menuNote = null, doneTimer = null;
  var noteEl = null, noteTimer = null, notePathText = null;   // §13.5: the one note a folder click leaves
  var asked = {};             // path -> true: asked at least once, never asked again (§13.2.2)
  var truth = {};             // path -> {exists, kind}: what the server answered
  var links = 0;              // how many anchors this module has drawn (across passes)
  var available = true, unavailableReason = null;
  var pending = false, lastAnswer = null, lastAction = null, lastError = null, held = 0, passes = 0;

  function fetchImpl(opts) { return (opts && opts.fetch) || window.fetch; }

  /** POST one of the two endpoints (§13.2.3 / §13.2.5). Resolves — never rejects — to
   *  `{ok, status, body, error}`, so a caller has no rejection to forget. The custom header of
   *  §13.2.6 travels with every call; the same-origin `Sec-Fetch-Site` is the browser's own doing. */
  function post(route, payload, opts) {
    var doFetch = fetchImpl(opts);
    if (typeof doFetch !== 'function') {
      return Promise.resolve({ ok: false, status: 0, error: { code: 'no_fetch', message: 'fetch is not available in this page' } });
    }
    var init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin'
    };
    init.headers[ACTION_HEADER] = ACTION_VALUE;
    var ctl = null, timer = null;
    try {
      if (typeof AbortController === 'function') { ctl = new AbortController(); init.signal = ctl.signal; }
    } catch (e) { ctl = null; }
    var timeout = new Promise(function (resolve) {
      timer = setTimeout(function () {
        if (ctl) { try { ctl.abort(); } catch (e) { /* already gone */ } }
        resolve({ ok: false, status: 0, error: { code: 'timeout', message: 'the server did not answer within ' + REQ_TIMEOUT_MS + 'ms' } });
      }, REQ_TIMEOUT_MS);
    });
    return Promise.race([doFetch(route, init).then(function (res) {
      return res.text().then(function (t) {
        var body = null;
        try { body = t ? JSON.parse(t) : null; } catch (e) { body = null; }
        return { ok: !!res.ok, status: res.status, body: body, text: str(t) };
      });
    }, function (e) {
      return { ok: false, status: 0, error: { code: 'network', message: str(e && e.message || e) } };
    }), timeout]).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    });
  }

  // ── asking (§13.2.2 / §13.2.3) ───────────────────────────────────────────────

  /** Ask about the new candidates of one pass, and record the answers. A pass that has nothing new
   *  asks nothing at all; a pass with more than MAX_PER_PASS new candidates asks for the first 200
   *  and leaves the rest for the next pass (reported by state().held). */
  function ask(cands, opts) {
    var fresh = [], seen = {}, i;
    for (i = 0; i < cands.length; i++) {
      var p = cands[i];
      if (asked[p] || seen[p]) continue;
      seen[p] = true; fresh.push(p);
    }
    held = fresh.length > MAX_PER_PASS ? fresh.length - MAX_PER_PASS : 0;
    if (fresh.length > MAX_PER_PASS) fresh = fresh.slice(0, MAX_PER_PASS);
    if (!fresh.length) return Promise.resolve({ asked: 0 });
    for (i = 0; i < fresh.length; i++) asked[fresh[i]] = true;
    return post(ROUTE_INFO, { paths: fresh }, opts).then(function (r) {
      lastAnswer = { at: Date.now(), ok: !!r.ok, status: r.status };
      if (!r.ok) {
        lastError = r.error || { code: 'http_' + r.status, message: 'the server answered ' + r.status };
        // §13.2.8: no endpoint, no answers — every path stays plain text and asking stops for good.
        if (r.status === 404 || r.status === 405 || r.status === 0) {
          available = false;
          unavailableReason = lastError.message;
        }
        return { asked: fresh.length, ok: false };
      }
      var items = (r.body && r.body.items) || [];
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        if (!it || it.path == null) continue;
        truth[str(it.path)] = { exists: !!it.exists, kind: it.kind === 'file' || it.kind === 'dir' ? it.kind : null };
      }
      // An item the answer did not mention is not an answer: it stays unknown, so the text stays
      // plain — never "exists" by omission.
      return { asked: fresh.length, ok: true };
    });
  }

  // ── decorating (§13.2.1 / §13.2.4) ───────────────────────────────────────────

  function isText(n) { return n && n.nodeType === 3; }
  function isElement(n) { return n && n.nodeType === 1; }
  /* A re-render can throw a text node away between the walk and the answer, so every rewrite checks
     `parentNode` first: a detached node has nowhere to put a link, and its text is already gone. */
  function insideLink(node) {
    var n = node && node.parentNode;
    while (isElement(n)) {
      if (String(n.className).split(/\s+/).indexOf(CLS.link) >= 0) return true;
      n = n.parentNode;
    }
    return false;
  }
  /* Our own chrome carries a path as verbatim TEXT, which is exactly the shape the decorator exists to
     rewrite — so it must never be read back in. Measured on the shipped build: 1.4 s after a file menu
     opened, the menu's own `.hd-pl-menu-path` had become an `<a class="hd-pl-link">` (the module's
     observer fired on its own append, and the verbatim path was by definition a confirmed one). That
     put a link inside the menu that opened it. The same would happen to §13.5's note, which is the
     path the server just confirmed. Chrome is not the agent's output: the walk stops at it. */
  function insideChrome(node) {
    var n = node && node.parentNode;
    while (isElement(n)) {
      var c = String(n.className).split(/\s+/);
      if (c.indexOf(CLS.menu) >= 0 || c.indexOf(CLS.note) >= 0) return true;
      n = n.parentNode;
    }
    return false;
  }
  /** The text nodes under `root`, in document order, skipping anything already inside a link of ours
   *  (that text is the LAST thing we rewrote, not a new candidate), anything inside our own chrome
   *  (a path we are quoting, not a path we were asked about), and optionally one node. */
  function textNodes(root, skip) {
    var out = [];
    (function walk(n) {
      if (!n || n === skip) return;
      if (isText(n)) { if (!insideLink(n) && !insideChrome(n)) out.push(n); return; }
      if (!isElement(n) && n.nodeType !== 11 && n.nodeType !== 9) return;
      var kids = n.childNodes || n.children || [];
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
    })(root);
    return out;
  }

  /** The confirmed candidates of one text node, longest-first at each position and non-overlapping:
   *  the decoration of every text node under `root` is decided by this one function. */
  function linksIn(text) {
    var anchors = anchorsIn(text), out = [], upTo = 0;
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (a.at < upTo) continue;                                  // inside the previous link
      for (var j = 0; j < a.variants.length; j++) {
        var v = a.variants[j];
        var t = truth[v];
        if (t && t.exists && t.kind) {
          out.push({ at: a.at, len: v.length, path: v, kind: t.kind });
          upTo = a.at + v.length;
          break;
        }
      }
    }
    return out;
  }

  /** §13.2.4: a directory opens on a click; a file opens the menu. Both are W2's/§13.2.5's actions —
   *  this only decides which of the two a click gets. */
  function makeLink(hit, opts) {
    var a = el('a', CLS.link);
    setAttr(a, 'data-hd-path', hit.path);
    setAttr(a, 'data-hd-kind', hit.kind);
    a.textContent = hit.path;                                     // the agent's own text, verbatim
    a.title = hit.path + (hit.kind === 'dir' ? ' — a folder' : ' — a file');   // never a prettified path
    setAttr(a, 'role', 'link');
    setAttr(a, 'tabindex', '0');
    var activate = function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (ev && ev.stopPropagation) ev.stopPropagation();
      onLinkActivate(a, hit, opts);
    };
    on(a, 'click', activate);
    on(a, 'keydown', function (ev) {
      var k = str(ev && ev.key);
      if (k === 'Enter' || k === ' ' || k === 'Spacebar') activate(ev);
    });
    links++;
    return a;
  }

  /** Rewrite ONE text node in place: the text around each confirmed path stays text (new nodes —
   *  never a serialised string), each confirmed path becomes an anchor. */
  function decorateNode(node, opts) {
    var text = str(node.nodeValue), hits = linksIn(text);
    if (!hits.length) return 0;
    var parent = node.parentNode;
    if (!parent) return 0;
    var frag = document.createDocumentFragment(), last = 0, i;
    for (i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (h.at > last) frag.appendChild(document.createTextNode(text.slice(last, h.at)));
      frag.appendChild(makeLink(h, opts));
      last = h.at + h.len;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (parent.replaceChild) parent.replaceChild(frag, node);
    else { parent.insertBefore(frag, node); parent.removeChild(node); }
    return hits.length;
  }

  /** One pass (§13.2.1): collect the candidates under `root`, ask about the new ones, and paint the
   *  confirmed ones — including the ones confirmed by an EARLIER pass, so a re-render gets its links
   *  back without a single new request (that is what "never re-asked" buys). */
  function decorate(rootEl, opts) {
    var root = rootEl || host;
    if (!root) return Promise.resolve({ ok: false, error: 'no_root' });
    if (!available) return Promise.resolve({ ok: false, error: 'pathinfo_unavailable' });
    passes++;
    var nodes = textNodes(root), cands = [], i, j;
    for (i = 0; i < nodes.length; i++) {
      var a = anchorsIn(str(nodes[i].nodeValue));
      for (j = 0; j < a.length; j++) for (var k = 0; k < a[j].variants.length; k++) cands.push(a[j].variants[k]);
    }
    var drawn = 0;
    for (i = 0; i < nodes.length; i++) drawn += decorateNode(nodes[i], opts);
    return ask(cands, opts).then(function (r) {
      var more = 0;
      // The answer may name paths in nodes the walk above did not touch (a variant that only the
      // server could tell apart, or a node a re-render added while the request was in flight).
      var again = textNodes(root);
      for (var n = 0; n < again.length; n++) more += decorateNode(again[n], opts);
      return { ok: true, asked: r.asked || 0, drawn: drawn + more, held: held, passes: passes };
    }, function (e) {
      lastError = { code: 'decorate_failed', message: str(e && e.message || e) };
      return { ok: false, error: lastError };
    });
  }

  // ── the menu and the two actions (§13.2.4 / §13.2.5 / §13.2.7) ────────────────

  function closeMenu() {
    if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
    if (menu) {
      off(document, 'keydown', onDocKey);
      off(document, 'mousedown', onDocClick);
      if (menu.parentNode) menu.parentNode.removeChild(menu);
      menu = null; menuLink = null; menuNote = null;
    }
  }
  function onDocKey(ev) { if (str(ev && ev.key) === 'Escape') closeMenu(); }
  function onDocClick(ev) {
    var t = ev && ev.target;
    var n = t;
    while (isElement(n)) { if (n === menu) return; n = n.parentNode; }
    closeMenu();
  }
  function say(note, text, cls) {
    if (!note) return;
    note.textContent = str(text);
    note.className = cls || CLS.menuNote;
  }
  /** §13.2.7: what the answer says is what the reader is shown — the server's own sentence, or the
   *  refusal, verbatim. A failure never closes the menu silently, and §13.5's note is the same
   *  sentence on a surface a folder click has. Composed here, once, so the two can never drift. */
  function doneText(r) {
    var b = (r && r.body) || {};
    return str(b.done) || str(b.message) || 'the server answered ok';
  }
  function badText(r) {
    var e = (r && (r.error || (r.body && r.body.error))) || {};
    return 'not done: ' + (e.message || ('the server answered ' + ((r && r.status) || 0)))
      + (e.code ? ' (' + e.code + ')' : '')
      + (r && r.text && !r.body ? ' — ' + str(r.text).slice(0, 200) : '');
  }
  function report(note, r) {
    if (r && r.ok) { say(note, doneText(r), CLS.menuNote); return true; }
    say(note, badText(r), CLS.menuNote + ' hd-pl-bad');
    return false;
  }
  /** Put the menu at the link and keep it inside the window. A menu that opens off the right edge or
   *  below the bottom of the window is a menu the reader cannot use, and a path near a corner is not
   *  an edge case in a 38,966-block log. Two measurements, both real: the first places it under the
   *  link, the second pulls it back inside — and flips it ABOVE the link when there is no room below —
   *  because the box the menu needs is only known once it has been laid out. Idempotent: a second call
   *  on a settled box changes nothing (the sheet gives the menu a `max-content` width precisely so
   *  that moving it cannot resize it, which is what makes the fixpoint reachable in one pass). */
  function place(link, m) {
    if (!link || !m || !m.style) return;
    if (typeof link.getBoundingClientRect !== 'function' || typeof m.getBoundingClientRect !== 'function') return;
    var r = link.getBoundingClientRect(), mr = m.getBoundingClientRect();
    if (!r || !mr) return;
    if (!isFinite(r.left) || !isFinite(r.bottom) || !isFinite(r.top) || !isFinite(mr.width) || !isFinite(mr.height)) return;
    var vw = window.innerWidth || 0, vh = window.innerHeight || 0, pad = 8;
    var left = r.left, top = r.bottom + 4;
    if (vw && mr.width) {
      if (left + mr.width > vw - pad) left = vw - mr.width - pad;
      if (left < pad) left = pad;
    }
    if (vh && mr.height) {
      if (top + mr.height > vh - pad) {
        var above = r.top - mr.height - 4;                    // flip above the link when it fits
        top = above >= pad ? above : vh - mr.height - pad;
      }
      if (top < pad) top = pad;
      if (top + mr.height > vh - pad) top = Math.max(pad, vh - mr.height - pad);
    }
    m.style.left = Math.round(left) + 'px';
    m.style.top = Math.round(top) + 'px';
  }

  // ── §13.5: what a folder click leaves behind ──────────────────────────────────

  /* Why a note at all: the reader clicked a folder, the page did nothing it could see, so the reader
     clicked again — four times in 1.6 s. The only thing that acted was the system's file manager, and
     it answers nothing. So the page says which path was handed over, and dismisses itself. */
  function onNoteKey(ev) { if (str(ev && ev.key) === 'Escape') hideNote(); }
  function onNoteClick() { hideNote(); }        // the next click anywhere, including on the link again
  function hideNote() {
    if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
    if (!noteEl) return;
    off(document, 'keydown', onNoteKey);
    off(document, 'mousedown', onNoteClick);
    if (noteEl.parentNode) noteEl.parentNode.removeChild(noteEl);
    noteEl = null;
    notePathText = null;
  }
  /** Show the ONE note. `pathText` is the path the server said it handed over — null on a refusal,
   *  where the server's reason already names what it could not reach, and naming a path we did not
   *  hand over would be the dishonest part. `sentence` is the server's own words, verbatim. */
  function showNote(link, pathText, sentence, bad) {
    hideNote();                                   // §13.5: replace, never stack
    var owner = (host && host.appendChild) ? host : (link && link.parentNode);
    if (!owner || !owner.appendChild) return null;
    var n = el('div', CLS.note + (bad ? ' hd-pl-bad' : ''));
    setAttr(n, 'role', 'status');                 // announced to a reader that wants announcing…
    setAttr(n, 'aria-live', 'polite');
    if (pathText) n.appendChild(el('div', CLS.notePath, pathText));
    n.appendChild(el('div', CLS.noteText, sentence));
    owner.appendChild(n);
    noteEl = n;
    notePathText = pathText ? str(pathText) : null;
    /* Dismissal, both by §13.5: the next Escape, and the next click anywhere. The note never receives
       a click (pathlink.css gives it `pointer-events: none`), so a second click on the same folder
       link reaches the LINK — which is what lets it REPLACE this note rather than be swallowed by it. */
    on(document, 'keydown', onNoteKey);
    on(document, 'mousedown', onNoteClick);
    noteTimer = setTimeout(function () { noteTimer = null; hideNote(); }, NOTE_MS);
    /* Out of flow and placed at the link, like the menu: `position: fixed` cannot move the chat, and
       the chat's scroll position is the reader's place in it (§13.5). A DOM without layout (the shim)
       gets no position at all rather than a wrong one, exactly as the menu does. */
    try { place(link, n); place(link, n); }
    catch (e) { /* a page that cannot measure still gets the note */ }
    return n;
  }
  function openMenu(link, hit, opts) {
    closeMenu();
    hideNote();          // one surface at a time: a file menu replaces a folder note, never stacks on it
    var owner = host && host.appendChild ? host : link.parentNode;
    if (!owner) return null;
    menu = el('div', CLS.menu);
    setAttr(menu, 'role', 'menu');
    var p = el('div', CLS.menuPath, hit.path);      // verbatim: no clip, no ellipsis, no rewrite
    p.title = hit.path;
    var bOpen = el('button', CLS.menuBtn, 'Open');
    setAttr(bOpen, 'type', 'button');
    setAttr(bOpen, 'data-hd-act', ACT_OPEN);
    var bReveal = el('button', CLS.menuBtn, 'Open File Location');
    setAttr(bReveal, 'type', 'button');
    setAttr(bReveal, 'data-hd-act', ACT_REVEAL);
    menuNote = el('div', CLS.menuNote);
    var act = function (what) {
      return function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        if (ev && ev.stopPropagation) ev.stopPropagation();
        run(link, hit.path, what, opts);
      };
    };
    on(bOpen, 'click', act(ACT_OPEN));
    on(bReveal, 'click', act(ACT_REVEAL));
    menu.appendChild(p); menu.appendChild(bOpen); menu.appendChild(bReveal); menu.appendChild(menuNote);
    owner.appendChild(menu);
    // Placed at the link, THEN pulled back inside the window — and a DOM without layout (the shim)
    // gets no position at all rather than a wrong one.
    try { place(link, menu); place(link, menu); }
    catch (e) { /* a page that cannot measure still gets the menu, unpositioned */ }
    menuLink = link;
    on(document, 'keydown', onDocKey);
    on(document, 'mousedown', onDocClick);
    // focus the first action so the menu is usable from the keyboard, exactly as §10.9's chips are
    try { if (bOpen.focus) bOpen.focus(); } catch (e) { /* no focus in this document */ }
    return menu;
  }
  /** One action, one request (§13.2.8's guard: a click while a request is in flight is ignored). */
  function run(link, path, action, opts) {
    if (pending) return Promise.resolve({ ok: false, error: 'busy' });
    pending = true;
    var note = menuNote;
    /* §13.5: a folder click has no menu, so its outcome has no other surface to land on. */
    var folder = !note && !!(link && link.getAttribute && str(link.getAttribute('data-hd-kind')) === 'dir');
    if (note) say(note, action === ACT_REVEAL ? 'asking the server to reveal it…' : 'asking the server to hand it to the system…');
    return post(ROUTE_OPEN, { path: path, action: action }, opts).then(function (r) {
      pending = false;
      var kind = link && link.getAttribute ? str(link.getAttribute('data-hd-kind')) : '';
      lastError = r.ok ? null : (r.error || { code: 'http_' + r.status, message: 'the server answered ' + r.status });
      if (note) {
        if (report(note, r) || action === ACT_REVEAL) {
          if (r.ok) doneTimer = setTimeout(function () { doneTimer = null; closeMenu(); }, MENU_DONE_MS);
        }
      } else if (folder) {
        // The path shown is the one the SERVER resolved (body.path) — the native form the system was
        // handed, not the `/d/…` or `C:/…` the agent may have written. `path` is the fallback for a
        // server that answers ok without echoing it.
        if (r.ok) showNote(link, str(r.body && r.body.path) || path, doneText(r), false);
        else showNote(link, null, badText(r), true);       // the reason, verbatim, never silence
      }
      // A directory opens with no menu in the way (§13.2.4), so the outcome has to be readable
      // somewhere: last_action carries the server's own sentence, the same one the note shows.
      lastAction = { at: Date.now(), path: path, action: action, kind: kind, ok: !!r.ok,
        done: (r.body && (r.body.done || r.body.message)) || null, status: r.status, error: lastError };
      return { ok: !!r.ok, status: r.status, action: action, path: path, done: lastAction.done,
        error: lastError };
    }, function (e) {
      pending = false;
      lastError = { code: 'network', message: str(e && e.message || e) };
      if (note) say(note, 'not done: ' + lastError.message, CLS.menuNote + ' hd-pl-bad');
      else if (folder) showNote(link, null, 'not done: ' + lastError.message, true);
      return { ok: false, error: lastError };
    });
  }
  function onLinkActivate(link, hit, opts) {
    if (pending) return;                                  // §13.2.8: no queue of spawns
    if (hit.kind === 'dir') { run(link, hit.path, ACT_OPEN, opts); return; }
    openMenu(link, hit, opts);
  }

  // ── observing (§13.2.1: mount) ───────────────────────────────────────────────

  function schedule(opts) {
    if (debounce) return;
    debounce = setTimeout(function () {
      debounce = null;
      decorate(host, opts);
    }, DEBOUNCE_MS);
  }
  function observe(opts) {
    if (typeof MutationObserver !== 'function' || !host) return;
    observer = new MutationObserver(function () {
      if (!mounted) return;
      if (pending) { schedule(opts); return; }              // nothing new while an answer is out
      schedule(opts);
    });
    observer.observe(host, { childList: true, subtree: true, characterData: true });
  }

  function mount(hostEl, opts) {
    hideNote();                     // a remount is a new host: a note belongs to the one it was shown in
    host = hostEl || null;
    mounted = !!host;
    ensureCss();
    if (observer && observer.disconnect) { try { observer.disconnect(); } catch (e) { /* gone */ } }
    observer = null;
    if (!mounted) return mod;
    observe(opts);
    decorate(host, opts);
    return mod;
  }
  /* A remount never re-asks what the previous mount already learned: `asked` and `truth` are module
     state, not mount state, and they are deliberately not reset by unmount(). */

  function unmount() {
    mounted = false;
    if (debounce) { clearTimeout(debounce); debounce = null; }
    if (observer && observer.disconnect) { try { observer.disconnect(); } catch (e) { /* gone */ } }
    observer = null;
    closeMenu();
    hideNote();
    host = null;
    return mod;
  }

  function state() {
    var confirmed = 0, missing = 0, k;
    for (k in truth) if (Object.prototype.hasOwnProperty.call(truth, k)) {
      if (truth[k].exists) confirmed++; else missing++;
    }
    var askedCount = 0;
    for (k in asked) if (Object.prototype.hasOwnProperty.call(asked, k)) askedCount++;
    return {
      mounted: mounted,
      host: !!host,
      available: available,
      unavailable_reason: unavailableReason,
      asked: askedCount,
      known: confirmed,
      missing: missing,
      links: links,          // anchors drawn so far; a re-render draws its own again
      pending: pending,
      held: held,
      passes: passes,
      menu: !!menu,
      menu_path: menuLink && menuLink.getAttribute ? str(menuLink.getAttribute('data-hd-path')) : null,
      note: !!noteEl,        // §13.5: the note a folder click is showing, if one is showing
      note_path: notePathText,
      last_answer: lastAnswer,
      last_action: lastAction,
      last_error: lastError
    };
  }

  var mod = {
    mount: mount,
    unmount: unmount,
    decorate: decorate,
    state: state
  };
  window.HD.pathlink = mod;
  /** The pure parts, for the local test suite. Not part of the frozen interface. */
  window.HD.pathlinkTest = {
    candidatesIn: candidatesIn, anchorsIn: anchorsIn, linksIn: linksIn, trimRun: trimRun,
    runFrom: runFrom, CLS: CLS, MAX_PER_PASS: MAX_PER_PASS, MIN_CANDIDATE: MIN_CANDIDATE,
    MAX_CANDIDATE: MAX_CANDIDATE, REJECT_AT: REJECT_AT, ANCHOR: ANCHOR, STOP: STOP, BEFORE: BEFORE,
    ROUTE_INFO: ROUTE_INFO, ROUTE_OPEN: ROUTE_OPEN, ACTION_HEADER: ACTION_HEADER, NOTE_MS: NOTE_MS
  };
})();
