/* herdr-dash — lib/copy.js (W2, CONTRACT-v2 §13.1.3 / §13.1.4)
 *
 * THE COPY BEHAVIOUR, and nothing else. chat-render.js (W3) writes the markup — one
 *   <button class="hd-cv-copy" type="button" data-hd-copy="<block-id>" aria-label="copy this block">⧉
 * as the LAST child of every copyable block's head row (§13.1.1) — and exposes the one function that
 * can read a block back: HD.chatRender.blockText(blockEl) (§13.1.2). This file turns a REAL click on
 * that button into: blockText() → navigator.clipboard.writeText → a transient status in the
 * COMPOSER'S RESULT LINE (#promptResult — the same line a send reports into) naming the TRUE
 * character count, or the honest reason no copy happened.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO DO (§13.1.3). It never reports a success it did not get: the
 * success sentence is written inside writeText's own fulfilment handler, so a refused – or absent –
 * clipboard can only ever produce a refusal sentence. It never writes to a pane, and it makes no
 * network call at all: there is no fetch, no XHR and no image in it. It never touches the fold: the
 * click is handled in the CAPTURE phase on the mount host and stopped there, so chatview.js's
 * bubble-phase fold delegation (and the `data-hd-foldhead` row the button is a child of) never sees
 * it, and nothing here reads or writes any fold state — so a click on copy with a folded block hands
 * the clipboard the WHOLE record while the block stays folded (§13.1.4).
 *
 * WHY ONE DELEGATED LISTENER, NOT ONE PER BUTTON. Every render — a poll, a fold, "load older", a
 * re-clamp — builds new buttons; a listener per button would leak one per render and would die with
 * the node it was bound to. One capture-phase listener on the mount host survives all of them, and it
 * is also what keeps the count honest: the block is read at CLICK time, from the DOM as it is then.
 *
 * FROZEN INTERFACE (the names the shell and the acceptance check use — do not rename):
 *   HD.copy.mount(host, opts) -> the module; remembers the host and installs the one listener
 *   HD.copy.unmount()         -> forget the host and remove the listener; counters are kept
 *   HD.copy.copy(btn, opts)   -> the promise of the very path a click takes (for a test or a caller)
 *   HD.copy.state()           -> { mounted, host, clicks, copies, refusals, pending, last, … }
 *   opts = { status(ok,text), ttlMs, blockText(fn), resultLine(id) }   — all optional; the defaults
 *          are the shipped ones (the composer's own result line, 5 s, HD.chatRender.blockText).
 * and, for tests only (the same convention as HD.chatRenderTest / HD.pathlinkTest):
 *   HD.copyTest = { REFUSED, NO_API, NO_TEXT, NO_RENDERER, countText, refusalText, CLS, BTN }
 *
 * THE COUNT. `text.length` — the number of UTF-16 code units of the exact string that was handed to
 * the clipboard, which is the number a verifier computes from a clipboard read-back of the same
 * string (§13.1.5). It is grouped the way §13.1.3 writes it: "copied 1,859 chars".
 */
(function () {
  'use strict';

  var CLS = { copy: 'hd-cv-copy', row: 'result', ok: 'ok', err: 'err', hidden: 'hidden' };
  var BTN = '[data-hd-copy]';
  var MARK = 'data-hd-copystatus';       // on the result line while the sentence on it is ours
  var DEFAULT_LINE = 'promptResult';
  var DEFAULT_TTL_MS = 5000;             // §13.1.3's "transient": long enough to read, not a log

  /* The two sentences §13.1.3 freezes: the refusal, and the same advice when there is no API at all.
     Both say what the reader can do instead — Ctrl+C on a selection is a real clipboard path. */
  var REFUSED = 'the browser refused the clipboard — select the text and press Ctrl+C';
  var NO_API = 'this browser exposes no clipboard API — select the text and press Ctrl+C';
  var NO_TEXT = 'this block has no text to copy';
  var NO_RENDERER = 'the conversation renderer is not loaded, so this block cannot be read back';

  var host = null, mounted = false, mountOpts = null, listener = null;
  var clicks = 0, copies = 0, refusals = 0, pending = 0;
  var last = null, lastError = null, written = null, timer = null;

  function str(v) { return (v === null || v === undefined) ? '' : String(v); }
  function attr(el, name) {
    if (!el || !el.getAttribute) return null;
    var v = el.getAttribute(name);
    return v === null ? null : str(v);
  }
  function on(el, type, fn, capture) {
    if (el && typeof el.addEventListener === 'function') { try { el.addEventListener(type, fn, !!capture); return true; } catch (e) { /* gone */ } }
    return false;
  }
  function off(el, type, fn, capture) {
    if (el && typeof el.removeEventListener === 'function') { try { el.removeEventListener(type, fn, !!capture); } catch (e) { /* gone */ } }
  }

  /** §13.1.3's count as a reader reads it: "1,859". */
  function countText(n) {
    return str(Math.max(0, Math.floor(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** The honest reason a write did not happen. §13.1.3's own sentence for a refusal the browser
   *  reported by name; the measured reason when the browser named one we can act on (an unfocused
   *  document is not "the clipboard refused you" — clicking the page fixes it, and saying so is the
   *  only useful answer); and the error's own name otherwise, because claiming a cause we did not
   *  measure is exactly the fake report this module exists to avoid. */
  function refusalText(err) {
    var name = str(err && err.name), msg = str(err && err.message);
    if (/focus/i.test(msg)) {
      return 'the clipboard refused the write because this tab is not focused — click the page and try again';
    }
    if (name === 'NotAllowedError' || name === 'SecurityError' || /not allowed|denied|permission|disallowed/i.test(msg)) return REFUSED;
    if (name === '' && msg === '') return REFUSED;
    return 'the clipboard refused the write (' + (name || msg) + ') — select the text and press Ctrl+C';
  }

  /** §13.1.2's function, found at call time: the renderer publishes HD.chatRender, and a page that
   *  loads this file without it can say honestly that it cannot read the block back. */
  function blockReader(opts) {
    if (opts && typeof opts.blockText === 'function') return opts.blockText;
    var CR = window.HD && window.HD.chatRender;
    return (CR && typeof CR.blockText === 'function') ? CR.blockText : null;
  }

  /* The block is whatever the RENDERER says it is, and the button is a legal argument to blockText()
     (§13.1.2: the nearest marked element at or above it), so nothing here has to know how a bubble,
     a thinking block or a tool card is shaped — or to be revised when that shape changes. */
  function readBlock(btn, opts) {
    var fn = blockReader(opts);
    if (!fn) return { ok: false, why: NO_RENDERER };
    try { return { ok: true, text: str(fn(btn)) }; }
    catch (e) { return { ok: false, why: 'the block could not be read back (' + str(e && e.message) + ')' }; }
  }

  function lineOf(opts) {
    var id = (opts && opts.resultLine) || DEFAULT_LINE;
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  /** Clear the sentence again after its TTL — but only if the line still holds OUR sentence (an
   *  exact text match AND the marker we set), so a send's result, or a newer copy, is never wiped by
   *  an older timer. A caller-provided sink owns its own line and is never cleared from here. */
  function clearLine(text, opts) {
    timer = null;
    if (opts && typeof opts.status === 'function') return;
    var el = lineOf(opts);
    if (!el) return;
    if (str(el.textContent) !== text) return;
    if (!attr(el, MARK)) return;
    el.textContent = '';
    el.className = CLS.row + ' ' + CLS.hidden;
    if (el.removeAttribute) el.removeAttribute(MARK);
  }

  /** §13.1.3's status, written where the shell already reports (the composer's result line) in the
   *  very shape app.js's own flashResult uses — same element, same two classes — and transient. */
  function report(ok, text, opts) {
    var sink = (opts && typeof opts.status === 'function') ? opts.status : null;
    if (sink) {
      try { sink(!!ok, text); } catch (e) { /* the sink's problem, never the click's */ }
    } else {
      var el = lineOf(opts);
      if (el) {
        el.textContent = text;
        el.className = CLS.row + ' ' + (ok ? CLS.ok : CLS.err);
        if (el.setAttribute) el.setAttribute(MARK, '1');
      }
    }
    if (timer) { clearTimeout(timer); timer = null; }
    var ttl = (opts && typeof opts.ttlMs === 'number') ? opts.ttlMs : DEFAULT_TTL_MS;
    if (ttl > 0) timer = setTimeout(function () { clearLine(text, opts); }, ttl);
  }

  /** One refusal: record it, say it, and resolve — never reject, so a caller (or a click) has no
   *  rejection to forget. */
  function fail(why, id, chars, opts, code, cause) {
    refusals++;
    last = { ok: false, text: why, chars: (chars === undefined ? null : chars), block_id: id, at: Date.now() };
    lastError = { code: code || 'clipboard_refused', message: why, name: str(cause && cause.name) };
    report(false, why, opts);
    return Promise.resolve(last);
  }

  /** writeText may be absent, may throw synchronously, and — in a page that has replaced it — may
   *  return no promise at all. Only a real thenable counts as "the clipboard answered": an API that
   *  returns nothing is not evidence that anything was copied, so it is reported as a refusal. */
  function writeClip(cl, text) {
    var p;
    try { p = cl.writeText(text); } catch (e) { return Promise.reject(e); }
    if (!p || typeof p.then !== 'function') {
      var e2 = new Error('navigator.clipboard.writeText returned no promise');
      e2.name = 'NoPromiseError';
      return Promise.reject(e2);
    }
    return Promise.resolve(p);
  }

  /** §13.1.3 end to end, for a button the renderer drew. Returns the promise of what was reported. */
  function copy(btn, opts) {
    var o = opts || mountOpts || {};
    clicks++;
    var id = attr(btn, 'data-hd-copy');
    var r = readBlock(btn, o);
    if (!r.ok) return fail(r.why, id, null, o, 'no_block_text');
    var text = r.text;
    var n = text.length;
    if (n === 0) return fail(NO_TEXT, id, 0, o, 'no_block_text');
    var cl = (typeof navigator === 'object' && navigator) ? navigator.clipboard : null;
    if (!cl || typeof cl.writeText !== 'function') return fail(NO_API, id, n, o, 'no_clipboard_api');
    pending++;
    return writeClip(cl, text).then(function () {
      pending--;
      copies++;
      var msg = 'copied ' + countText(n) + ' chars';
      last = { ok: true, text: msg, chars: n, block_id: id, at: Date.now() };
      lastError = null;
      written = { chars: n, at: last.at, block_id: id };
      report(true, msg, o);
      return last;
    }, function (e) {
      pending--;
      return fail(refusalText(e), id, n, o, 'clipboard_refused', e);
    });
  }

  /** §13.1.4: the copy button is not a fold control. This listener is on the mount host in the
   *  CAPTURE phase, so stopping the event here means chatview.js's bubble-phase fold/open delegation
   *  never runs for a copy click — and the fold state is not merely left alone, it is never consulted. */
  function onClick(ev) {
    if (!mounted || !host) return;
    var t = ev && ev.target;
    var btn = (t && t.closest) ? t.closest(BTN) : null;
    if (!btn || !host.contains(btn)) return;
    if (ev.stopPropagation) ev.stopPropagation();
    if (ev.preventDefault) ev.preventDefault();
    copy(btn, mountOpts);
  }

  function mount(hostEl, opts) {
    unmount();
    mountOpts = (opts && typeof opts === 'object') ? opts : null;
    host = hostEl || null;
    mounted = !!host;
    if (!mounted) return mod;
    listener = onClick;
    on(host, 'click', listener, true);
    return mod;
  }
  /* unmount() forgets the host and removes the listener; it does NOT reset the counters or `last`,
     which describe what the reader did with the module, not with one mount. */

  function unmount() {
    if (listener && host) off(host, 'click', listener, true);
    listener = null;
    host = null;
    mounted = false;
    mountOpts = null;
  }

  function state() {
    return {
      mounted: mounted,
      host: !!host,
      clicks: clicks,
      copies: copies,
      refusals: refusals,
      pending: pending,
      ttl_ms: (mountOpts && typeof mountOpts.ttlMs === 'number') ? mountOpts.ttlMs : DEFAULT_TTL_MS,
      result_line: !!lineOf(mountOpts),
      last: last ? { ok: last.ok, text: last.text, chars: last.chars, block_id: last.block_id, at: last.at } : null,
      last_error: lastError ? { code: lastError.code, message: lastError.message, name: lastError.name } : null,
      /* the COUNT the clipboard was handed (never the string itself: the copied text is the reader's
         log, and it has no business sitting in a snapshot a console or a test prints) */
      written: written ? { chars: written.chars, at: written.at, block_id: written.block_id } : null
    };
  }

  var mod = {
    mount: mount,
    unmount: unmount,
    copy: copy,
    state: state
  };

  var HDx = (window.HD = window.HD || {});
  HDx.copy = mod;
  /** The pure parts, for the acceptance check. Not part of the frozen interface. */
  HDx.copyTest = {
    REFUSED: REFUSED, NO_API: NO_API, NO_TEXT: NO_TEXT, NO_RENDERER: NO_RENDERER,
    countText: countText, refusalText: refusalText, CLS: CLS, BTN: BTN, MARK: MARK,
    DEFAULT_TTL_MS: DEFAULT_TTL_MS, DEFAULT_LINE: DEFAULT_LINE
  };
})();
