/* Herdr-Dash — ANSI SGR parser for the terminal view.
 *
 * Dependency-free, classic script: exposes window.HD.ansi and a CommonJS shim so the
 * same code can be exercised under `node --test` / a scratch harness.
 *
 * Supported attributes: reset (0 / empty), bold (1), dim (2), normal intensity (22),
 * default fg/bg (39 / 49), the 16 base colours (30-37, 90-97, 40-47, 100-107),
 * 256-colour 38;5;n / 48;5;n, and 24-bit 38;2;r;g;b / 48;2;r;g;b.
 *
 * Everything else is removed, never rendered:
 *   - other SGR attributes (italic, underline, blink, reverse, strike, …) are ignored;
 *     the parameter is dropped and the text is kept with the attributes applied so far
 *   - non-SGR CSI sequences, OSC sequences (title, hyperlinks, clipboard), single-character
 *     escapes, carriage returns and C0 controls (tab is kept) are stripped
 *   - an unterminated escape sequence at end of line is dropped
 *
 * There is no innerHTML anywhere: the DOM path only creates text nodes and spans whose
 * class names come from a fixed list and whose inline colours are validated integers.
 *
 * API
 *   parseSGR(text) -> {segments: [{text, fg, bg, bold, dim}], unknown}
 *     fg/bg: null | {kind:'base', n:0-15} | {kind:'256', n:0-255} | {kind:'rgb', r,g,b}
 *   toNodes(text, doc?) -> DocumentFragment (doc defaults to the global document)
 *   strip(text) -> the plain text, no escapes
 *   palette256(n) -> '#rrggbb' for 16..255 (0..15 answer the base palette hex)
 *   BASE_HEX -> the 16 base colours as #rrggbb, the same values the CSS classes use
 */
(function (root) {
  'use strict';

  var ESC = '\u001b';

  /* The 16 base colours. `terminal.css` repeats these values in .hd-term-fg-N /
     .hd-term-bg-N so a 256-colour index below 16 can use the themed class instead of an
     inline colour; keep the two in step. */
  var BASE_HEX = [
    '#11151c', '#e5484d', '#3fb950', '#e0a02a',
    '#4aa3ff', '#a371f7', '#39c5cf', '#d6dee8',
    '#6e7681', '#ff7b72', '#56d364', '#f2cc60',
    '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff'
  ];

  function clampByte(n) {
    if (typeof n !== 'number' || !isFinite(n) || Math.floor(n) !== n || n < 0) return -1;
    return n > 255 ? -1 : n;
  }

  function hex2(n) {
    var s = clampByte(n);
    if (s < 0) s = 0;
    return (s < 16 ? '0' : '') + s.toString(16);
  }

  /** '#rrggbb' for a 256-colour index; 0-15 use the base palette. */
  function palette256(n) {
    var idx = clampByte(n);
    if (idx < 0) return null;
    if (idx < 16) return BASE_HEX[idx];
    if (idx >= 232) {
      var v = 8 + (idx - 232) * 10;
      return '#' + hex2(v) + hex2(v) + hex2(v);
    }
    var i = idx - 16;
    var steps = [0, 95, 135, 175, 215, 255];
    return '#' + hex2(steps[Math.floor(i / 36) % 6]) +
      hex2(steps[Math.floor(i / 6) % 6]) +
      hex2(steps[i % 6]);
  }

  function initialState() {
    return { fg: null, bg: null, bold: false, dim: false };
  }

  function color(kind, a, b, c) {
    if (kind === 'base') return { kind: 'base', n: a };
    if (kind === '256') return { kind: '256', n: a };
    return { kind: 'rgb', r: a, g: b, b: c };
  }

  /**
   * Apply one SGR parameter list to `st` (in place).
   * Returns how many parameters were unsupported, so a caller can report them.
   */
  function applySGR(st, params) {
    var parts = params === '' ? ['0'] : String(params).split(';');
    var unknown = 0;
    for (var i = 0; i < parts.length; i += 1) {
      var raw = parts[i] === '' ? '0' : parts[i];
      var n = Number(raw);
      if (!isFinite(n) || Math.floor(n) !== n || n < 0) { unknown += 1; continue; }
      if (n === 0) {
        st.fg = null; st.bg = null; st.bold = false; st.dim = false;
      } else if (n === 1) {
        st.bold = true;
      } else if (n === 2) {
        st.dim = true;
      } else if (n === 22) {
        st.bold = false; st.dim = false;
      } else if (n === 39) {
        st.fg = null;
      } else if (n === 49) {
        st.bg = null;
      } else if (n >= 30 && n <= 37) {
        st.fg = color('base', n - 30);
      } else if (n >= 90 && n <= 97) {
        st.fg = color('base', n - 90 + 8);
      } else if (n >= 40 && n <= 47) {
        st.bg = color('base', n - 40);
      } else if (n >= 100 && n <= 107) {
        st.bg = color('base', n - 100 + 8);
      } else if (n === 38 || n === 48) {
        var slot = (n === 38) ? 'fg' : 'bg';
        var mode = Number(parts[i + 1]);
        if (mode === 5) {
          var idx = Number(parts[i + 2]);
          if (clampByte(idx) >= 0) {
            st[slot] = color('256', idx);
          } else {
            unknown += 1;
          }
          i += 2;
        } else if (mode === 2) {
          var r = Number(parts[i + 2]);
          var g = Number(parts[i + 3]);
          var b = Number(parts[i + 4]);
          if (clampByte(r) >= 0 && clampByte(g) >= 0 && clampByte(b) >= 0) {
            st[slot] = color('rgb', r, g, b);
          } else {
            unknown += 1;
          }
          i += 4;
        } else {
          /* a malformed extended colour: drop it, keep the following text */
          unknown += 1;
          i += 1;
        }
      } else {
        /* italic, underline, blink, reverse, strike, overline, fonts, … */
        unknown += 1;
      }
    }
    return unknown;
  }

  function pushSegment(out, text, st) {
    if (!text) return;
    out.push({
      text: text,
      fg: st.fg,
      bg: st.bg,
      bold: !!st.bold,
      dim: !!st.dim
    });
  }

  /**
   * Parse a line of text with ANSI SGR codes into styled segments.
   * The concatenated segment text is exactly the input minus escape sequences.
   */
  function parseSGR(input) {
    var text = (input === undefined || input === null) ? '' : String(input);
    var out = [];
    var unknown = 0;
    var st = initialState();
    var buf = '';
    var i = 0;
    while (i < text.length) {
      var ch = text.charAt(i);
      if (ch !== ESC) {
        if (ch === '\r') { i += 1; continue; }
        var code = text.charCodeAt(i);
        if (code < 0x20 && ch !== '\t') { i += 1; continue; }   /* other C0 controls */
        if (code === 0x7f) { i += 1; continue; }                /* DEL */
        buf += ch;
        i += 1;
        continue;
      }

      /* ESC: decide by the next byte */
      var next = text.charAt(i + 1);
      if (next === '[') {
        var j = i + 2;
        var params = '';
        while (j < text.length) {
          var c = text.charCodeAt(j);
          if (c >= 0x40 && c <= 0x7e) break;      /* final byte */
          params += text.charAt(j);
          j += 1;
        }
        if (j >= text.length) break;              /* unterminated: drop the rest */
        if (text.charAt(j) === 'm') {
          pushSegment(out, buf, st);
          buf = '';
          unknown += applySGR(st, params);
        }
        /* any other CSI (cursor moves, erase, …) is stripped */
        i = j + 1;
        continue;
      }
      if (next === ']') {
        /* OSC: terminated by BEL or ST (ESC \) */
        var k = i + 2;
        while (k < text.length) {
          if (text.charAt(k) === '\u0007') { k += 1; break; }
          if (text.charAt(k) === ESC && text.charAt(k + 1) === '\\') { k += 2; break; }
          k += 1;
        }
        i = k;
        continue;
      }
      /* ESC ( B / ESC ) 0 / ESC # 8 …: a designator plus one byte. Other escapes
         (ESC c, ESC 7, …) are two bytes; a trailing ESC at end of line is dropped. */
      if (next === '(' || next === ')' || next === '*' || next === '+' || next === '#' || next === '%') {
        i += 3;
      } else {
        i += 2;
      }
    }
    pushSegment(out, buf, st);
    return { segments: out, unknown: unknown };
  }

  function strip(text) {
    var res = parseSGR(text);
    var s = '';
    for (var i = 0; i < res.segments.length; i += 1) s += res.segments[i].text;
    return s;
  }

  function segmentStyle(seg) {
    var classes = [];
    var style = null;
    if (seg.fg) {
      if (seg.fg.kind === 'base') classes.push('hd-term-fg-' + seg.fg.n);
      else if (seg.fg.kind === '256' && seg.fg.n < 16) classes.push('hd-term-fg-' + seg.fg.n);
      else if (seg.fg.kind === '256') { style = style || {}; style.color = palette256(seg.fg.n); }
      else { style = style || {}; style.color = 'rgb(' + seg.fg.r + ', ' + seg.fg.g + ', ' + seg.fg.b + ')'; }
    }
    if (seg.bg) {
      if (seg.bg.kind === 'base') classes.push('hd-term-bg-' + seg.bg.n);
      else if (seg.bg.kind === '256' && seg.bg.n < 16) classes.push('hd-term-bg-' + seg.bg.n);
      else if (seg.bg.kind === '256') { style = style || {}; style.backgroundColor = palette256(seg.bg.n); }
      else { style = style || {}; style.backgroundColor = 'rgb(' + seg.bg.r + ', ' + seg.bg.g + ', ' + seg.bg.b + ')'; }
    }
    if (seg.bold) classes.push('hd-term-bold');
    if (seg.dim) classes.push('hd-term-dim');
    return { classes: classes, style: style };
  }

  /**
   * Build a DocumentFragment (or, without a document, an array of nodes).
   * `doc` is injectable so a test can pass a stub; it defaults to `document`.
   */
  function toNodes(text, doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    var res = parseSGR(text);
    var nodes = [];
    for (var i = 0; i < res.segments.length; i += 1) {
      var seg = res.segments[i];
      var look = segmentStyle(seg);
      if (!look.classes.length && !look.style) {
        nodes.push(d ? d.createTextNode(seg.text) : seg.text);
        continue;
      }
      if (!d) { nodes.push(seg.text); continue; }
      var span = d.createElement('span');
      if (look.classes.length) span.className = look.classes.join(' ');
      if (look.style) {
        if (look.style.color) span.style.color = look.style.color;
        if (look.style.backgroundColor) span.style.backgroundColor = look.style.backgroundColor;
      }
      span.appendChild(d.createTextNode(seg.text));
      nodes.push(span);
    }
    if (!d || typeof d.createDocumentFragment !== 'function') return nodes;
    var frag = d.createDocumentFragment();
    for (var k = 0; k < nodes.length; k += 1) frag.appendChild(nodes[k]);
    return frag;
  }

  var api = {
    version: 1,
    BASE_HEX: BASE_HEX,
    parseSGR: parseSGR,
    toNodes: toNodes,
    strip: strip,
    palette256: palette256
  };

  root.HD = root.HD || {};
  root.HD.ansi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
