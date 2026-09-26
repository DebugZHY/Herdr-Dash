/* herdr-dash — lib/advance-buffer.js · CONTRACT-v2 §0.1 advanceBuffer (owner: W2)
 *
 * ONE copy of the transcript merge rule, used by the browser and loadable by Node:
 *   - the page loads this classic script before app.js and before every module, so
 *     `window.HD.advanceBuffer` is the implementation app.js polls with and the one
 *     public/lib/grid.js picks up through ctx.util.advanceBuffer;
 *   - the local test suite can `require()` this exact file in Node and compare it with the
 *     server twin, src/hdr.js (W1), which is why the CommonJS shim at the bottom exists.
 *
 * ---------------------------------------------------------------------------------------
 * THE RULES (CONTRACT-v2 §0.1), in the order they are tried
 *
 *   rule 4   prev empty            -> show the whole window ('append')
 *   rule 1   exact tail overlap    -> append the part of the window past the overlap
 *   rule 1r  the same, tolerating repainted rows  (<=1% of k, k >= 50)
 *   rule 1s  no clean overlap      -> append only the window rows this client has never
 *                                     shown, order- and repeat-preserving
 *   rule 2   anchor search         -> the window's head is somewhere in the buffer, so the
 *                                     buffer already covers `prev.length - p` of its lines:
 *                                     append `next.slice(prev.length - p)`, or nothing when
 *                                     that covers the whole window (W1's corrected formula —
 *                                     NOT the literal `next.slice(anchor.length)`, which
 *                                     re-appends the lines between the anchor and the buffer
 *                                     end)
 *   rule 3   neither               -> 'reset': the streams diverged, show the window
 *
 * WHY 1r AND 1s EXIST (they are additions on top of §0.1, agreed in round 2)
 * A TUI pane keeps a pinned bottom region (input box, status bar, spinner) and repaints rows
 * in place. Its window therefore never lines up tail-to-head with the buffer, so rules 1 and 2
 * both miss; rule 2's corrected form answers "append nothing" for that shape, but for a *pane
 * that is genuinely producing output* the window's head is new text with no anchor in the
 * buffer, where rule 2 finds nothing and rule 3 would throw the whole window away as a reset.
 * 1s is the honest answer in between: append the rows this client has not shown. Measured on
 * the live server (round 2): an idle TUI pane polled 46 times accumulates 1,000 lines with
 * 1s (the window size, no repeats) versus 46,000 lines with the v1 rule.
 *
 * Every branch's candidate is post-processed by the same two guards: a prefix the buffer
 * already shows is dropped, and a block of >=32 rows that is less than 25% unseen text is
 * discarded (that is the shape of a whole-window re-append).
 *
 * `newLines` and `mode` are the frozen result. The `rule` field is diagnostic only and is
 * defined NON-ENUMERABLE on purpose: a parity check that deep-compares this function's result
 * with src/hdr.js's must see `{newLines, mode}` and nothing else.
 * ---------------------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var AB_RECENT = 4096;   // how far back the "have I shown this?" scan looks
  var AB_NEAR = 64;       // how far back the repaint scan looks
  var AB_MIN_OVERLAP = 50; // rule 1r only applies to overlaps at least this long
  var AB_ANCHOR = 8;      // §0.1: anchor = next.slice(0, min(8, next.length))
  var AB_MIN_BLOCK = 32;  // the "almost entirely already shown" guard only judges blocks this big
  var AB_MIN_NOVEL = 0.25;

  /** Attach the frozen {newLines, mode} plus a non-enumerable diagnostic `rule`. */
  function result(newLines, mode, rule) {
    var out = { newLines: newLines, mode: mode };
    try {
      Object.defineProperty(out, 'rule', { value: rule, enumerable: false, writable: true, configurable: true });
    } catch (e) { out.rule = rule; }   // ancient engines: better a visible field than a lost one
    return out;
  }

  /**
   * Advance a transcript buffer (CONTRACT-v2 §0.1).
   * @param {string[]} prevLines everything the client has already shown for the pane
   * @param {string[]} nextLines the fresh window (usually the tail of the scrollback)
   * @returns {{newLines: string[], mode: 'append'|'reset'}} lines to append, and whether the
   *          caller should render a "--- screen cleared ---" separator.
   */
  function advanceBuffer(prevLines, nextLines) {
    var prev = prevLines || [];
    var next = nextLines || [];
    if (!prev.length) return result(next.slice(), 'append', '4');       // rule 4
    if (!next.length) return result([], 'append', 'noop');
    var max = Math.min(prev.length, next.length);
    var k, i, bad, tol, candidate;

    for (k = max; k > 0; k--) {                                          // rule 1 (exact)
      bad = false;
      for (i = 0; i < k; i++) {
        if (prev[prev.length - k + i] !== next[i]) { bad = true; break; }
      }
      if (!bad) return finish(prev, next.slice(k), 'append', '1');
    }
    for (k = max; k >= AB_MIN_OVERLAP; k--) {                            // rule 1r (repaints)
      tol = Math.max(1, Math.floor(k / 100));
      bad = 0;
      for (i = 0; i < k; i++) {
        if (prev[prev.length - k + i] !== next[i] && ++bad > tol) break;
      }
      if (bad <= tol) return finish(prev, next.slice(k), 'append', '1r');
    }
    candidate = novelRows(prev, next);                                   // rule 1s
    if (candidate.length < next.length) return finish(prev, candidate, 'append', '1s');

    var anchorLen = Math.min(AB_ANCHOR, next.length);                    // rule 2 (anchor)
    var anchor = next.slice(0, anchorLen);
    for (var p = prev.length - anchorLen; p >= 0; p--) {
      var same = true;
      for (i = 0; i < anchorLen; i++) {
        if (prev[p + i] !== anchor[i]) { same = false; break; }
      }
      if (same) {
        // the buffer covers `known` lines of the window (src/hdr.js: `known >= next.length ? []`)
        var known = prev.length - p;
        candidate = known >= next.length ? [] : next.slice(known);
        return finish(prev, candidate, 'append', '2');
      }
    }
    return finish(prev, next.slice(), 'reset', '3');                     // rule 3 (reset)
  }

  /** rule 1s: keep, in order, only the window rows this client has not shown yet. Rows are
   *  consumed from the recent tail with multiplicity, so a pane that legitimately prints the
   *  same line twice still gets both. A row whose recent neighbour differs only in a repainted
   *  way (spinner glyph, elapsed time, progress) is not new output either. */
  function novelRows(prev, next) {
    var tail = prev.slice(Math.max(0, prev.length - AB_RECENT));
    var counts = new Map();
    for (var i = 0; i < tail.length; i++) counts.set(tail[i], (counts.get(tail[i]) || 0) + 1);
    var near = prev.slice(Math.max(0, prev.length - AB_NEAR));
    var out = [];
    for (var j = 0; j < next.length; j++) {
      var line = next[j];
      var c = counts.get(line) || 0;
      if (c > 0) { counts.set(line, c - 1); continue; }
      var repaint = false;
      for (var n = 0; n < near.length; n++) {
        if (isRepaint(near[n], line)) { repaint = true; break; }
      }
      if (repaint) continue;
      out.push(line);
    }
    return out;
  }

  /** the guards every branch goes through */
  function finish(prev, candidate, mode, rule) {
    var out = trimShown(prev, candidate);
    if (out.length >= AB_MIN_BLOCK) {
      var have = new Set(prev.slice(Math.max(0, prev.length - AB_RECENT)));
      var novel = 0;
      for (var i = 0; i < out.length; i++) if (!have.has(out[i])) novel++;
      if (novel / out.length < AB_MIN_NOVEL) out = [];
    }
    return result(out, mode, rule);
  }

  /** "same screen row, redrawn": equal length and at most two characters differ. */
  function isRepaint(a, b) {
    if (!a || !b || a.length !== b.length || a.length < 6) return false;
    var pre = 0;
    while (pre < a.length && a[pre] === b[pre]) pre++;
    if (pre < 2) return false;
    var suf = 0;
    while (suf < a.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    return pre + suf >= a.length - 2;
  }

  /** never re-append a prefix the buffer's tail already shows (exact, then repaint-tolerant) */
  function trimShown(prev, candidate) {
    var max = Math.min(prev.length, candidate.length);
    var j, i, bad, tol;
    for (j = max; j > 0; j--) {
      bad = false;
      for (i = 0; i < j; i++) {
        if (prev[prev.length - j + i] !== candidate[i]) { bad = true; break; }
      }
      if (!bad) return candidate.slice(j);
    }
    for (j = max; j >= AB_MIN_OVERLAP; j--) {
      tol = Math.max(1, Math.floor(j / 100));
      bad = 0;
      for (i = 0; i < j; i++) {
        if (prev[prev.length - j + i] !== candidate[i] && ++bad > tol) break;
      }
      if (bad <= tol) return candidate.slice(j);
    }
    return candidate;
  }

  /* ---------------------------------------------------------------- publication */
  if (typeof window !== 'undefined') {
    window.HD = window.HD || {};
    window.HD.advanceBuffer = advanceBuffer;
  }
  /* CommonJS shim: the local test suite requires this exact file in Node, next to src/hdr.js. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { advanceBuffer: advanceBuffer };
  }
})();
