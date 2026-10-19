/* herdr-dash — lib/stream-md.js
 *
 * Progressive Markdown for the ephemeral live turn.
 *
 * The live text arrives in deltas, so the same buffer is re-rendered many times
 * while it is being written. This module splits that buffer into block-level
 * chunks — prose paragraphs and fenced code — and rebuilds only the chunk that
 * is still growing. Chunks the writer has already finished keep their DOM nodes,
 * so a long reply costs one block per flush instead of the whole reply.
 *
 * Every string here is model output and is untrusted: prose and code are built
 * from text nodes and elements only, so no markup is ever parsed out of the
 * text, and a "<script>" in the text stays text.
 *
 * Public shape:
 *   HD.streamMd.split(text)            -> [{type, text, lang, closed}, ...]
 *   HD.streamMd.settled(text)          -> {blocks, settled, pending}
 *   HD.streamMd.render(el, text, opts) -> {reused, settled, pending, blocks}
 *
 * Markup written by render():
 *   div.hd-md-p                                  one prose chunk
 *   div.hd-md-code > div.hd-md-codehead > span.hd-md-lang
 *                  > pre.hd-md-pre                one fenced chunk
 * Each block carries data-md-key (stable while the text only grows); a code
 * block also carries data-md-closed, because a fence that is still open is a
 * live code block rather than an error.
 */
(function (root) {
  'use strict';

  var FENCE = '```';

  /* ── block scan ─────────────────────────────────────────────────────── */

  function isFenceLine(line) {
    return line.trim().indexOf(FENCE) === 0;
  }

  /** The info string of a fence line, first word only ("```js title" -> "js"). */
  function langOf(line) {
    var t = line.trim();
    var i = 0;
    while (i < t.length && t.charAt(i) === '`') i += 1;
    t = t.slice(i).trim();
    return t ? t.split(/\s+/)[0] : '';
  }

  /**
   * Block-level scan. A fence line opens a code block; the next fence line
   * closes it. Prose between fences is split into paragraphs at blank lines, so
   * a finished paragraph is a chunk of its own even though more prose follows.
   * Block text keeps its own newlines; a prose chunk never starts with a blank
   * line and never includes the blank line that closes it.
   *
   * `base` is added to each block's start offset, so a scan of a slice reports
   * offsets in the whole buffer.
   */
  function scan(text, base) {
    var blocks = [];
    var len = text.length;
    var lineStart = 0;
    var inFence = false;
    var fenceStart = 0;
    var fenceLang = '';
    var fenceParts = null;
    var prose = null;                  // { start, parts }

    function flushProse() {
      if (!prose) return;
      var body = prose.parts.join('\n');
      if (body) {
        blocks.push({
          type: 'prose',
          text: body,
          lang: null,
          closed: body.charAt(body.length - 1) === '\n',
          start: base + prose.start
        });
      }
      prose = null;
    }

    for (;;) {
      var nl = text.indexOf('\n', lineStart);
      var line = nl === -1 ? text.slice(lineStart) : text.slice(lineStart, nl);

      if (!inFence) {
        if (isFenceLine(line)) {
          // The prose chunk ends with the line break that the fence line follows,
          // which is what makes a chunk before a fence a settled one.
          if (prose) { prose.parts.push(''); flushProse(); }
          inFence = true;
          fenceStart = lineStart;
          fenceLang = langOf(line);
          fenceParts = [];
        } else if (line.trim() === '') {
          if (prose) { prose.parts.push(line); flushProse(); }
        } else {
          if (!prose) prose = { start: lineStart, parts: [] };
          prose.parts.push(line);
        }
      } else if (isFenceLine(line)) {
        blocks.push({
          type: 'code',
          text: fenceParts.join('\n'),
          lang: fenceLang,
          closed: true,
          start: base + fenceStart
        });
        inFence = false;
        fenceParts = null;
        prose = null;
      } else {
        fenceParts.push(line);
      }

      if (nl === -1) break;
      lineStart = nl + 1;
    }

    if (inFence) {
      blocks.push({
        type: 'code',
        text: fenceParts.join('\n'),
        lang: fenceLang,
        closed: false,
        start: base + fenceStart
      });
    } else {
      flushProse();
    }
    return blocks;
  }

  /**
   * Key and settled flag for a scanned block list. A block is settled when its
   * fence is closed or when something later in the buffer follows it; the last
   * block is pending while it is still being written.
   */
  function decorate(blocks) {
    for (var i = 0; i < blocks.length; i += 1) {
      blocks[i].key = blocks[i].type + '@' + blocks[i].start;
      blocks[i].settled = blocks[i].closed || i < blocks.length - 1;
    }
    return blocks;
  }

  function asText(value) {
    return (value === undefined || value === null) ? '' : String(value);
  }

  function split(text) {
    var blocks = scan(asText(text), 0);
    var out = [];
    for (var i = 0; i < blocks.length; i += 1) {
      out.push({ type: blocks[i].type, text: blocks[i].text, lang: blocks[i].lang, closed: blocks[i].closed });
    }
    return out;
  }

  function settled(text) {
    var blocks = decorate(scan(asText(text), 0));
    var done = 0;
    var open = 0;
    for (var i = 0; i < blocks.length; i += 1) {
      if (blocks[i].settled) done += 1;
      else open += 1;
    }
    return { blocks: blocks, settled: done, pending: open };
  }

  /* ── DOM ────────────────────────────────────────────────────────────── */

  function doc() {
    if (typeof document !== 'undefined' && document) return document;
    return null;
  }

  function makeEl(tag, cls) {
    var d = doc();
    if (!d || typeof d.createElement !== 'function') return null;
    var node = d.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function makeText(value) {
    var d = doc();
    if (!d || typeof d.createTextNode !== 'function') return null;
    return d.createTextNode(value);
  }

  function appendText(parent, value) {
    if (!value) return;
    var node = makeText(value);
    if (node) parent.appendChild(node);
  }

  var LINK = /^https?:\/\/[^\s<>"'`]+/i;
  var TRAILING = '.,;:!?';

  function appendLink(parent, url) {
    var link = makeEl('a', 'hd-md-link');
    if (!link) return;
    link.setAttribute('href', url);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    appendText(link, url);
    parent.appendChild(link);
  }

  /**
   * The inline subset shared with the record renderer, kept deliberately small:
   * inline code, bold, and bare http(s) links. Anything else is text, which is
   * what keeps a tag-looking string inert.
   */
  function inlineInto(parent, line) {
    var i = 0;
    var run = '';

    function flush() {
      if (!run) return;
      appendText(parent, run);
      run = '';
    }

    while (i < line.length) {
      var ch = line.charAt(i);

      if (ch === '`') {
        var tickEnd = line.indexOf('`', i + 1);
        if (tickEnd > i + 1) {
          flush();
          var code = makeEl('code', 'hd-md-icode');
          if (code) { appendText(code, line.slice(i + 1, tickEnd)); parent.appendChild(code); }
          i = tickEnd + 1;
          continue;
        }
      }

      if (ch === '*' && line.charAt(i + 1) === '*') {
        var boldEnd = line.indexOf('**', i + 2);
        if (boldEnd > i + 2) {
          flush();
          var strong = makeEl('strong');
          if (strong) { appendText(strong, line.slice(i + 2, boldEnd)); parent.appendChild(strong); }
          i = boldEnd + 2;
          continue;
        }
      }

      if (ch === 'h' || ch === 'H') {
        var match = LINK.exec(line.slice(i));
        if (match) {
          var url = match[0];
          while (url.length && TRAILING.indexOf(url.charAt(url.length - 1)) !== -1) url = url.slice(0, -1);
          flush();
          appendLink(parent, url);
          i += url.length;
          continue;
        }
      }

      run += ch;
      i += 1;
    }
    flush();
  }

  function buildProse(block) {
    var node = makeEl('div', 'hd-md-p');
    if (!node) return null;
    var lines = block.text.split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      // A <br> per line break, so newlines survive without relying on CSS.
      if (i > 0) {
        var br = makeEl('br');
        if (br) node.appendChild(br);
      }
      inlineInto(node, lines[i]);
    }
    return node;
  }

  function buildCode(block) {
    var node = makeEl('div', 'hd-md-code');
    if (!node) return null;
    var head = makeEl('div', 'hd-md-codehead');
    var lang = makeEl('span', 'hd-md-lang');
    if (lang) appendText(lang, block.lang || 'text');
    if (head && lang) head.appendChild(lang);
    if (head) node.appendChild(head);
    var pre = makeEl('pre', 'hd-md-pre');
    if (pre) {
      appendText(pre, block.text);
      node.appendChild(pre);
    }
    return node;
  }

  function buildBlock(block) {
    var node = block.type === 'code' ? buildCode(block) : buildProse(block);
    if (!node) return null;
    node.setAttribute('data-md-key', block.key);
    if (block.type === 'code') node.setAttribute('data-md-closed', block.closed ? 'true' : 'false');
    return node;
  }

  /** Make the element's children exactly `nodes`, keeping every node it already has. */
  function reconcile(parent, nodes) {
    var i;
    for (i = 0; i < nodes.length; i += 1) {
      var have = parent.childNodes ? parent.childNodes[i] : null;
      if (have !== nodes[i]) parent.insertBefore(nodes[i], have || null);
    }
    while (parent.childNodes && parent.childNodes.length > nodes.length) {
      parent.removeChild(parent.childNodes[parent.childNodes.length - 1]);
    }
  }

  /* ── render ─────────────────────────────────────────────────────────── */

  function cacheFor(el) {
    var cache = el.__hdMd;
    if (!cache || !cache.blocks || !cache.nodes) {
      cache = el.__hdMd = { text: '', blocks: [], nodes: [] };
    }
    return cache;
  }

  /**
   * Render `text` into the live element. Blocks that were already finished are
   * left alone (they are not even re-scanned: an append-only buffer is scanned
   * from the offset of its last block), so the cost of a delta follows the tail.
   *
   * opts.done marks the trailing block settled — the writer said the message is
   * complete, so nothing more will be appended to it.
   */
  function render(el, text, opts) {
    var out = { reused: 0, settled: 0, pending: 0, blocks: [] };
    if (!el || !doc()) return out;

    var value = asText(text);
    var done = !!(opts && opts.done);
    var cache = cacheFor(el);

    var parsed;
    var prefix = [];
    if (cache.text && cache.blocks.length && value.indexOf(cache.text) === 0) {
      var lastKnown = cache.blocks[cache.blocks.length - 1];
      var tail = scan(value.slice(lastKnown.start), lastKnown.start);
      prefix = cache.blocks.slice(0, cache.blocks.length - 1);
      parsed = prefix.concat(tail);
    } else {
      parsed = scan(value, 0);
    }
    decorate(parsed);

    // Every cached block is a reuse candidate, the trailing one included: a scan
    // from its start reproduces its key, so an unchanged tail keeps its nodes.
    var known = {};
    for (var p = 0; p < cache.blocks.length; p += 1) known[cache.blocks[p].key] = cache.blocks[p];

    var nodes = [];
    for (var i = 0; i < parsed.length; i += 1) {
      var block = parsed[i];
      var previous = known[block.key];
      var node = null;
      if (previous && previous.type === block.type && previous.text === block.text &&
          previous.lang === block.lang && previous.closed === block.closed && previous.node) {
        node = previous.node;
        out.reused += 1;
      } else {
        node = buildBlock(block);
      }
      if (!node) continue;
      block.node = node;
      nodes.push(node);
      if (done) {
        block.settled = true;
        out.settled += 1;
      } else if (block.settled) {
        out.settled += 1;
      } else {
        out.pending += 1;
      }
    }

    reconcile(el, nodes);
    cache.text = value;
    cache.blocks = parsed;
    cache.nodes = nodes;
    out.blocks = parsed;
    return out;
  }

  var api = {
    version: 1,
    split: split,
    settled: settled,
    render: render
  };

  root.HD = root.HD || {};
  root.HD.streamMd = api;

  // The selftest seam: the pure parts, no DOM needed.
  root.HD.streamMdTest = {
    scan: scan,
    decorate: decorate,
    split: split,
    settled: settled
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
