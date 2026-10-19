/* Herdr-Dash — terminal merge algorithm.
 *
 * Classic script: exposes window.HD.terminalMerge and a CommonJS shim so the same
 * code runs in the browser and under `node --test`.
 *
 * No DOM access. Inputs and outputs are plain arrays of line strings.
 */
(function (root) {
  'use strict';

  var REPAINT_MARK = '--- screen repainted ---';
  var SCREEN_MARK = '--- screen ---';
  var BACKSCAN = 200;

  /**
   * Normalise a herdr text snapshot into lines.
   * - CRLF -> LF
   * - split on LF
   * - if the text ends with LF, drop only the trailing empty item
   * Trailing spaces and interior blank lines are preserved.
   *
   * @param {string} text
   * @returns {string[]}
   */
  function splitText(text) {
    var s = text == null ? '' : String(text);
    s = s.replace(/\r\n/g, '\n');
    var parts = s.split('\n');
    if (s.charAt(s.length - 1) === '\n' && parts.length > 0 && parts[parts.length - 1] === '') {
      parts.pop();
    }
    return parts;
  }

  /** True when a[len-k..len) equals b[0..k). */
  function tailHeadEqual(a, b, k) {
    if (k <= 0) return true;
    if (k > a.length || k > b.length) return false;
    var off = a.length - k;
    for (var i = 0; i < k; i += 1) {
      if (a[off + i] !== b[i]) return false;
    }
    return true;
  }

  /** True when the last k rows of a equal the last k rows of b. */
  function tailEqual(a, b, k) {
    if (k <= 0) return true;
    if (k > a.length || k > b.length) return false;
    var ao = a.length - k;
    var bo = b.length - k;
    for (var i = 0; i < k; i += 1) {
      if (a[ao + i] !== b[bo + i]) return false;
    }
    return true;
  }

  function arrayEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Merge one screen frame into the rolling buffer.
   *
   * @param {{screen: string[], buffer: string[]}} state
   * @param {string[]} frame screen snapshot, oldest line first
   * @returns {{screen: string[], buffer: string[], mode: string, appended: number, changed: number[]}}
   *   mode is one of 'same' | 'init' | 'append' | 'replace' | 'reset'.
   *   Invariant: result.buffer.slice(-result.screen.length) deep-equals result.screen.
   */
  function applyFrame(state, frame) {
    var screen = state && Array.isArray(state.screen) ? state.screen : [];
    var buffer = state && Array.isArray(state.buffer) ? state.buffer : [];
    var f = Array.isArray(frame) ? frame : [];

    // 1. Empty frame: nothing to do.
    if (f.length === 0) {
      return { screen: screen, buffer: buffer, mode: 'same', appended: 0, changed: [] };
    }

    // 2. First frame for this state.
    if (screen.length === 0) {
      var initChanged = [];
      for (var a = 0; a < f.length; a += 1) initChanged.push(buffer.length + a);
      return {
        screen: f.slice(),
        buffer: buffer.concat(f),
        mode: 'init',
        appended: f.length,
        changed: initChanged
      };
    }

    // 3. Identical screen.
    if (arrayEqual(screen, f)) {
      return { screen: screen, buffer: buffer, mode: 'same', appended: 0, changed: [] };
    }

    // 4. Largest overlap: screen tail == frame head. Scroll by k lines.
    var maxK = Math.min(screen.length, f.length);
    var k = 0;
    for (var kk = maxK; kk >= 1; kk -= 1) {
      if (tailHeadEqual(screen, f, kk)) {
        k = kk;
        break;
      }
    }
    if (k >= 1) {
      var newRows = f.slice(k);
      var base = buffer.length;
      var appendedChanged = [];
      for (var b = 0; b < newRows.length; b += 1) appendedChanged.push(base + b);
      return {
        screen: f.slice(),
        buffer: buffer.concat(newRows),
        mode: 'append',
        appended: newRows.length,
        changed: appendedChanged
      };
    }

    // 4b. Viewport grew: the frame ends with the old screen. Replace the overlapping
    //     buffer suffix instead of appending, which would duplicate rows.
    if (f.length > screen.length && tailEqual(f, screen, screen.length)) {
      var maxL = Math.min(buffer.length, f.length);
      var L = 0;
      for (var ll = maxL; ll >= screen.length; ll -= 1) {
        if (tailEqual(buffer, f, ll)) {
          L = ll;
          break;
        }
      }
      if (L >= screen.length && L > 0) {
        var p = buffer.length - L;
        var grown = buffer.slice(0, p).concat(f);
        var grownChanged = [];
        for (var q = p; q < grown.length; q += 1) grownChanged.push(q);
        return {
          screen: f.slice(),
          buffer: grown,
          mode: 'reset',
          appended: grown.length - buffer.length,
          changed: grownChanged
        };
      }
    }

    // 5. Same height, no overlap: in-place repaint of the screen window.
    if (f.length === screen.length) {
      var start = buffer.length - screen.length;
      var next = buffer.slice();
      var replaceChanged = [];
      for (var c = 0; c < f.length; c += 1) {
        if (next[start + c] !== f[c]) {
          next[start + c] = f[c];
          replaceChanged.push(start + c);
        }
      }
      return {
        screen: f.slice(),
        buffer: next,
        mode: 'replace',
        appended: 0,
        changed: replaceChanged
      };
    }

    // 6. Height changed and no overlap: repaint the screen window.
    //    Prefer replacing the previous screen rows over duplicating the whole screen.
    var tailHoldsScreen =
      buffer.length >= screen.length && tailEqual(buffer, screen, screen.length);
    var resetBuffer;
    var resetChanged = [];
    if (tailHoldsScreen) {
      resetBuffer = buffer.slice(0, buffer.length - screen.length).concat(f);
      var resetStart = resetBuffer.length - f.length;
      for (var d = 0; d < f.length; d += 1) resetChanged.push(resetStart + d);
      return {
        screen: f.slice(),
        buffer: resetBuffer,
        mode: 'reset',
        appended: f.length,
        changed: resetChanged
      };
    }
    resetBuffer = buffer.concat([REPAINT_MARK]).concat(f);
    // The marker row must be patched too, not only the frame rows.
    var markerIndex = resetBuffer.length - f.length - 1;
    resetChanged.push(markerIndex);
    var markStart = resetBuffer.length - f.length;
    for (var e = 0; e < f.length; e += 1) resetChanged.push(markStart + e);
    return {
      screen: f.slice(),
      buffer: resetBuffer,
      mode: 'reset',
      appended: f.length + 1,
      changed: resetChanged
    };
  }

  /**
   * Align a scrollback snapshot with the current screen frame.
   *
   * @param {string} scrollbackText
   * @param {string[]} frame
   * @returns {string[]} scrollback lines that end with the screen frame
   */
  function alignScrollback(scrollbackText, frame) {
    var scrollback = splitText(scrollbackText);
    var f = Array.isArray(frame) ? frame : [];

    if (f.length === 0) return scrollback;
    if (tailEqual(scrollback, f, f.length)) return scrollback;

    // Tolerant window match: herdr's visible and recent_unwrapped snapshots can differ
    // by a line or two, so allow maxDiff mismatching rows inside the window. Scan from
    // the newest candidate backwards and take the last match; never add a marker when
    // one exists.
    var maxDiff = f.length >= 10 ? 2 : 0;
    var from = Math.max(0, scrollback.length - BACKSCAN);
    for (var p = scrollback.length - f.length; p >= from; p -= 1) {
      var diffs = 0;
      for (var i = 0; i < f.length; i += 1) {
        if (scrollback[p + i] !== f[i]) {
          diffs += 1;
          if (diffs > maxDiff) break;
        }
      }
      if (diffs <= maxDiff) return scrollback.slice(0, p).concat(f);
    }

    return scrollback.concat([SCREEN_MARK]).concat(f);
  }

  var api = {
    splitText: splitText,
    applyFrame: applyFrame,
    alignScrollback: alignScrollback
  };

  var HD = root.HD || (root.HD = {});
  HD.terminalMerge = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(
  typeof window !== 'undefined'
    ? window
    : typeof globalThis !== 'undefined'
      ? globalThis
      : this
);
