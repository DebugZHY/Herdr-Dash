/* herdr-dash — test/fixtures/pathlink-live/pathlink-live.js (W3, CONTRACT-v2 §13.1/§13.2)
 *
 * The PAGE half of test/pathlink-live.mjs. Loaded by the pathlink-live.html beside it (the suite serves
 * this directory under /fx/) after the shipped chat-render.js, copy.js and pathlink.js, so every call
 * below is the delivered file being driven, not a copy.
 *
 * It asserts nothing. Every function acts on the page and hands back plain JSON; the Node suite decides
 * what the numbers mean. That split is deliberate: a page that decides its own pass/fail cannot be
 * checked by anyone, and a suite that cannot see the measurement has to guess.
 *
 * The file-path sets it uses are REAL paths in this repository (the fixture's stub API stats the
 * filesystem to answer /api/pathinfo), plus one path that really does not exist, so "exists:true" and
 * "exists:false" are facts about the disk rather than a table someone typed.
 */
(function () {
  'use strict';
  var HR = 'D:\\Development\\New\\herdr-dash\\';
  var P = {
    FILE: HR + 'public\\lib\\pathlink.js',            // a real file
    DIR: HR + 'public\\lib',                          // a real folder
    GONE: HR + 'public\\lib\\not-on-this-disk.zzz',   // real path, really absent
    HANG: HR + 'test\\fixtures\\pathlink-live\\hang-me.txt',   // real file; the stub API never answers for it
    EXTRA: HR + 'test\\pathlink.mjs',                 // a real file no scenario asks about until the end
    BURST: [
      HR + 'public\\lib\\chat-render.js', HR + 'public\\lib\\chatview.css',
      HR + 'public\\lib\\dock.js', HR + 'public\\lib\\copy.js',
      HR + 'public\\style.css', HR + 'src\\chat\\common.js'
    ]
  };

  /* the nearest element at or above `n` that §13.1.2 could read a block out of */
  function nearestBlock(n) {
    while (n && n.nodeType === 1) {
      if (n.getAttribute && n.getAttribute('data-hd-block') !== null) return n.getAttribute('data-hd-block');
      n = n.parentNode;
    }
    return null;
  }

  var fx = {
    paths: P,
    mountedOn: null,
    sigs: [],                    // every fetch this page made, with the AbortSignal it was handed
    statuses: [],                // every sentence HD.copy reported through the status sink
    folds: 0,                    // how often the naive row-level fold handler WOULD have folded
    foldAttempts: 0,             // how often a click reached it carrying a [data-hd-foldhead] row
    copyReachedAncestor: 0,      // …and how often that click was a COPY click: must stay 0 with copy.js
    copyMounted: false,
    probes: 0,                   // how many probe messages decorate() has been handed
    events: [],                  // the composed path of every point probed with eventPath()

    list: function () { return document.getElementById('fxList'); },
    el: function (id) { return document.getElementById(id); },

    /* Record what the page's own fetch is handed (§13.2.8's abort path can only be observed here),
       and pass every call through untouched. Installed before the first mount. */
    watchFetch: function () {
      if (window.__fxWatched) return true;
      var real = window.fetch.bind(window);
      window.__fxWatched = true;
      window.fetch = function (u, o) {
        var sig = o && o.signal;
        fx.sigs.push({
          url: String(u), method: String((o && o.method) || 'GET'),
          isAbortSignal: !!(window.AbortSignal && sig instanceof window.AbortSignal),
          /* Both shapes a caller uses: a Headers instance (forEach) and a plain object — which is what
             pathlink.js itself passes (`headers: {'Content-Type': …}` + `[ACTION_HEADER]`). Reading
             only forEach silently reported EVERY request as header-less, so this handles both. */
          headers: (function () {
            var out = {}, h = o && o.headers, k;
            if (!h) return out;
            try {
              if (typeof h.forEach === 'function') h.forEach(function (v, kk) { out[String(kk).toLowerCase()] = String(v); });
              else for (k in h) if (Object.prototype.hasOwnProperty.call(h, k)) out[String(k).toLowerCase()] = String(h[k]);
            } catch (e) { out.__err = String(e && e.message); }
            return out;
          })(),
          body: String((o && o.body) || ''),
          aborted: null, abortedAt: null
        });
        var rec = fx.sigs[fx.sigs.length - 1];
        if (sig) {
          if (sig.aborted) { rec.aborted = true; rec.abortedAt = 0; }
          else sig.addEventListener('abort', function () { rec.aborted = true; rec.abortedAt = Date.now(); });
        }
        return real(u, o);
      };
      return true;
    },
    sigsSoFar: function () {
      return fx.sigs.map(function (s) {
        return { url: s.url, method: s.method, isAbortSignal: s.isAbortSignal, aborted: s.aborted,
          headers: s.headers, body: s.body, at: s.abortedAt };
      });
    },

    /* ── §13.1.4: is a copy click reachable by a fold handler? ──────────────────
       W2's copy.js is mounted on #fxCopy in the CAPTURE phase and stops the click there. This installs
       the HAZARD it has to defeat: a naive row-level fold delegation in the BUBBLE phase on #fxCopyPane,
       the ANCESTOR of the mount host — the position chatview.js's own delegated handler occupies. It
       counts every click that reaches it carrying a [data-hd-foldhead] row in its path, how many of
       those were copy clicks (the number that must stay 0), and it folds unless a copy button is under
       the pointer (the fix a bubble-phase handler needs and a capture-phase one does not). */
    wireCopy: function (opts) {
      var o = opts || {};
      var pane = document.getElementById('fxCopyPane');
      var host = document.getElementById('fxCopy');
      if (!pane.__fxFoldWired) {
        pane.__fxFoldWired = true;
        pane.addEventListener('click', function (ev) {
          var head = null, n = ev.target;
          while (n && n.nodeType === 1) {
            if (n.getAttribute && n.getAttribute('data-hd-foldhead') !== null) { head = n; break; }
            n = n.parentNode;
          }
          if (!head) return;
          fx.foldAttempts++;
          var b = ev.target;
          while (b && b.nodeType === 1 && !(b.getAttribute && b.getAttribute('data-hd-copy'))) b = b.parentNode;
          if (b) fx.copyReachedAncestor++;
          if (window.__fxFoldChecksCopy && b) return;        // the bubble-phase fix: copy first, fold second
          fx.folds++;
          var key = head.getAttribute('data-hd-foldhead');
          fx.lastFoldKey = key;
          /* …and it really folds, the way a fold handler has to: the state moves and the message is
             REDRAWN with the shipped renderer, which is what makes the tail leave the document (the
             folded form is a preview, not a clipped rewrite) and the control's wording flip with it.
             Flipping a class by hand would look like a fold and change nothing a reader could see. */
          var msg = head;
          while (msg && msg.nodeType === 1 && !(msg.classList && msg.classList.contains('hd-cv-msg'))) msg = msg.parentNode;
          var row = msg ? msg.querySelector('.hd-cv-row') : null;
          var rec = fx.records && fx.records[key];
          var next = row ? !(row.classList && row.classList.contains('hd-cv-folded')) : true;
          if (rec && msg && msg.parentNode && window.HD.chatRender) {
            fx.foldState[key] = next;
            msg.parentNode.replaceChild(window.HD.chatRender.renderMessage(rec, { foldedKeys: fx.foldState }), msg);
          }
        }, false);
      }
      window.__fxFoldChecksCopy = !!o.checksCopy;
      var mod = window.HD.copy;
      if (mod && typeof mod.mount === 'function') {
        mod.mount(host, { status: function (ok, text) { fx.statuses.push({ ok: !!ok, text: String(text), at: Date.now() }); } });
        fx.copyMounted = true;
      }
      return { mounted: fx.copyMounted, checksCopy: !!o.checksCopy, state: (mod && mod.state) ? mod.state() : null };
    },
    unmountCopy: function () {
      if (window.HD.copy && window.HD.copy.unmount) window.HD.copy.unmount();
      fx.copyMounted = false;
      return true;
    },
    /* The guarded-handler flag on its own, WITHOUT mounting anything: with copy.js mounted its capture
       listener stops the click before any bubble-phase ancestor sees it, so the guard could never be
       observed. The comparison that means something is the same click, the same delegation, one
       guarded and one not — both with the copy behaviour out of the way. */
    guard: function (checksCopy) {
      window.__fxFoldChecksCopy = !!checksCopy;
      return { checksCopy: !!window.__fxFoldChecksCopy };
    },
    copyState: function () { return (window.HD.copy && window.HD.copy.state) ? window.HD.copy.state() : null; },
    statusesSoFar: function () { return fx.statuses.slice(); },
    copyCounters: function () {
      return { folds: fx.folds, foldAttempts: fx.foldAttempts, copyReachedAncestor: fx.copyReachedAncestor,
        lastFoldKey: fx.lastFoldKey === undefined ? null : fx.lastFoldKey };
    },
    resetCopy: function () {
      fx.statuses = []; fx.folds = 0; fx.foldAttempts = 0; fx.copyReachedAncestor = 0;
      return { mounted: fx.copyMounted };
    },

    /* ── §13.1: the copy fixtures, drawn by the shipped renderer ─────────────── */
    copyFixture: function () {
      var CR = window.HD.chatRender;
      var root = document.getElementById('fxCopy');
      while (root.firstChild) root.removeChild(root.firstChild);
      var lines = [];
      for (var i = 0; i < 23; i++) lines.push('line ' + (i + 2));
      var raw = 'first line\n' + lines.join('\n') + '\nTAIL-SENTINEL-25';
      fx.records = { 'fx-folded-1': { key: 'fx-folded-1', ts: Date.now(), role: 'user', kind: 'text', text: raw } };
      fx.foldState = { 'fx-folded-1': true };
      var folded = CR.renderMessage(fx.records['fx-folded-1'], { foldedKeys: fx.foldState });
      var card = CR.renderMessage({ key: 'fx-card-1', ts: Date.now(), role: 'assistant', kind: 'tool_call',
        text: '', tool: { name: 'Bash', call_key: 'fx', input: { command: 'npm test' }, result: 'ok' } });
      root.appendChild(folded);
      root.appendChild(card);
      var box = function (n) {
        if (!n) return null;
        var r = n.getBoundingClientRect();
        return { w: r.width, h: r.height, l: r.left, t: r.top, r: r.right, b: r.bottom };
      };
      var head = folded.querySelector('.hd-cv-meta');
      var btn = folded.querySelector('.hd-cv-copy');
      var fold = head.querySelector('.hd-cv-foldbtn');
      /* A2.4 puts the fold class on the ROW (chat-render.js:730). Note WHICH row: buildMessage puts the
         head (`.hd-cv-meta`, which carries data-hd-foldhead) directly under the message root, so the
         head is NOT inside the folded row — the folded row is the one wrapping the bubble, i.e. the
         message root's `.hd-cv-row` descendant. Reading `head.closest('.hd-cv-row')` finds nothing. */
      var foldRow = folded.querySelector('.hd-cv-row');
      var cardHead = card.querySelector('.hd-cv-card-head');
      var cardBtn = card.querySelector('.hd-cv-copy');
      var b = btn.getBoundingClientRect(), f = fold ? fold.getBoundingClientRect() : null;
      var hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
      return {
        copyBox: box(btn),
        foldBox: box(fold),
        cardCopyBox: box(cardBtn),
        lastChild: head.lastElementChild === btn,
        cardLastChild: !!(cardHead && cardBtn && cardHead.lastElementChild === cardBtn),
        headTag: head.tagName + '.' + head.className,
        headChildren: Array.prototype.map.call(head.children, function (c) { return c.tagName + '.' + c.className; }),
        inline: getComputedStyle(btn).display,
        aria: btn.getAttribute('aria-label'), glyph: btn.textContent,
        copyId: btn.getAttribute('data-hd-copy'), blockId: folded.getAttribute('data-hd-block'),
        cardCopyId: cardBtn ? cardBtn.getAttribute('data-hd-copy') : null,
        cardBlockId: card.getAttribute('data-hd-block'),
        /* §13.1.2's rule as a measurement: the nearest marked block at or above the button is the
           block the button names. This is what makes "the button names the right block" checkable. */
        headNearestBlock: nearestBlock(btn), cardNearestBlock: nearestBlock(cardBtn),
        directTextNodesInHead: (function () {
          var out = 0;
          for (var i = 0; i < head.childNodes.length; i++) if (head.childNodes[i].nodeType === 3 && head.childNodes[i].nodeValue.trim() !== '') out++;
          return out;
        })(),
        headHasFoldheadValue: head.getAttribute('data-hd-foldhead'),
        rowHasFoldhead: folded.getAttribute('data-hd-foldhead') !== null,
        foldedBefore: foldRow ? foldRow.className : null,
        rootCls: folded.className,
        foldStatText: ((folded.querySelector('.hd-cv-foldstat') || {}).textContent || ''),
        drawnChars: folded.textContent.length,
        foldBtnText: fold ? fold.textContent : null,
        foldAria: fold ? fold.getAttribute('aria-expanded') : null,
        bodyTextNow: folded.textContent,
        tailOnScreen: folded.textContent.indexOf('TAIL-SENTINEL-25') >= 0,
        copiedText: CR.blockText(btn),
        copiedCard: CR.blockText(cardBtn),
        rawText: raw,
        hitIsButton: !!(hit && (hit === btn || btn.contains(hit))),
        hitIsFold: !!(hit && fold && (hit === fold || fold.contains(hit))),
        centres: { btn: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) },
          fold: f ? { x: Math.round(f.left + f.width / 2), y: Math.round(f.top + f.height / 2) } : null }
      };
    },
    /* The fold state of the copy fixture after whatever the suite did to it, read from the elements
       that carry it: the fold class is on the ROW (chat-render.js:730) and the control on the HEAD, so
       looking for `.hd-cv-msg` and calling that "the fold state" would be reading the wrong node. */
    copyNow: function () {
      var root = document.getElementById('fxCopy');
      var head = root.querySelector('[data-hd-foldhead]');
      if (!head) return { key: null, foldedNow: null, foldBtnText: null, foldAria: null, tailOnScreen: null, text: null };
      var msg = head;
      while (msg && msg.nodeType === 1 && !(msg.classList && msg.classList.contains('hd-cv-msg'))) msg = msg.parentNode;
      var row = msg ? msg.querySelector('.hd-cv-row') : null;
      var fbtn = head.querySelector('.hd-cv-foldbtn');
      return { key: head.getAttribute('data-hd-foldhead'),
        foldedNow: row ? row.className : null,
        foldBtnText: fbtn ? fbtn.textContent : null,
        foldAria: fbtn ? fbtn.getAttribute('aria-expanded') : null,
        hasFoldStat: !!(msg && msg.querySelector('.hd-cv-foldstat')),
        drawnChars: msg ? msg.textContent.length : null,
        tailOnScreen: msg ? msg.textContent.indexOf('TAIL-SENTINEL-25') >= 0 : null,
        text: msg ? msg.textContent : null };
    },
    /* what a click at a viewport point actually passes through, as class names — the composed path */
    eventPath: function (x, y) {
      var hit = document.elementFromPoint(x, y);
      var out = [], n = hit;
      while (n && n.nodeType === 1) { out.push(n.tagName + '.' + String(n.className).split(' ').join('.')); n = n.parentNode; }
      fx.events.push({ x: x, y: y, path: out });
      return { hit: hit ? hit.tagName + '.' + hit.className : null, path: out };
    },
    hitAt: function (x, y) {
      var r = fx.eventPath(x, y);
      return { hit: r.hit, path: r.path,
        inMenu: r.path.some(function (p) { return p.indexOf('hd-pl-menu') >= 0; }),
        inLink: r.path.some(function (p) { return p.indexOf('hd-pl-link') >= 0; }) };
    },

    /* ── §13.2: the scenarios ────────────────────────────────────────────────── */
    clear: function () {
      ['fxList', 'fxCorner', 'fxEdge'].forEach(function (id) {
        var n = document.getElementById(id);
        while (n.firstChild) n.removeChild(n.firstChild);
        n.style.display = 'none';
      });
      return true;
    },
    /* (a) three paths in one rendered message: one file, one folder, one that is not there */
    seed: function () {
      var CR = window.HD.chatRender;
      var list = fx.list();
      while (list.firstChild) list.removeChild(list.firstChild);
      var text = 'The file ' + P.FILE + ' it drew, the folder ' + P.DIR + ' it wrote, and '
        + P.GONE + ' which is not on this disk at all.';
      var filler = [];
      for (var i = 0; i < 22; i++) filler.push('filler line ' + (i + 1) + ' to make the pane really scroll');
      var drawn = CR.renderMessage({ key: 'fx-a-1', ts: Date.now(), role: 'user', kind: 'text', text: text }, {});
      var fat = CR.renderMessage({ key: 'fx-a-2', ts: Date.now(), role: 'assistant', kind: 'text', text: filler.join('\n') }, {});
      list.appendChild(drawn);
      list.appendChild(fat);
      fx.expectedText = text + '\n' + filler.join('\n') + '\n' + filler.join('\n');
      fx.mountedOn = 'fxList';
      window.HD.pathlink.mount(list);
      return { text: text, drawnKey: 'fx-a-1', fillerKey: 'fx-a-2' };
    },
    /* mount again on one of the three hosts (the observer follows the LAST mount) */
    mountOn: function (id) {
      fx.mountedOn = id;
      window.HD.pathlink.mount(document.getElementById(id));
      return { host: id };
    },
    /* (b1) the pane scrolled to a real offset, so the link inside it moves with the scroll */
    scrollTo: function (top) {
      var s = document.getElementById('fxScroller');
      s.scrollTop = top;
      return { scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight };
    },
    /* (b2) a link as far right (and, for fxEdge, as far down) as the viewport allows */
    edge: function (which) {
      var CR = window.HD.chatRender;
      var id = which === 'corner' ? 'fxCorner' : 'fxEdge';
      var host = document.getElementById(id);
      while (host.firstChild) host.removeChild(host.firstChild);
      host.appendChild(CR.renderMessage({ key: 'fx-' + which, ts: Date.now(), role: 'assistant', kind: 'text',
        text: 'see ' + P.FILE }, {}));
      host.style.display = 'block';
      fx.mountedOn = id;
      window.HD.pathlink.mount(host);
      return { host: id };
    },
    /* A second observer on the same host, counting CALLBACKS: it is what says whether a whole-list
       replacement arrived in one go or as one mutation per row. */
    watchMutations: function () {
      fx.calls = [];
      if (fx.obs && fx.obs.disconnect) { try { fx.obs.disconnect(); } catch (e) { /* gone */ } }
      if (typeof MutationObserver !== 'function') return false;
      fx.obs = new MutationObserver(function (records) {
        var added = 0, removed = 0;
        for (var i = 0; i < records.length; i++) { added += records[i].addedNodes.length; removed += records[i].removedNodes.length; }
        fx.calls.push({ records: records.length, added: added, removed: removed, at: Date.now() });
      });
      fx.obs.observe(fx.list(), { childList: true, subtree: true, characterData: true });
      return true;
    },
    callsSoFar: function () { return (fx.calls || []).slice(); },

    /* (f) a WHOLE-LIST replacement in one go: the burst a re-render really is */
    burst: function (n) {
      var CR = window.HD.chatRender, list = fx.list();
      var frag = document.createDocumentFragment(), keys = [];
      var before = window.HD.pathlink.state();
      fx.watchMutations();
      for (var i = 0; i < (n || 12); i++) {
        var p = i < P.BURST.length ? P.BURST[i] : null;
        var key = 'fx-burst-' + i;
        keys.push(key);
        frag.appendChild(CR.renderMessage({ key: key, ts: Date.now(), role: i % 2 ? 'assistant' : 'user',
          kind: 'text', text: p ? ('burst record ' + i + ' names ' + p) : ('burst record ' + i + ' names nothing at all') }, {}));
      }
      // one replaced child list, not twelve appended rows: this is the mutation the observer must see.
      // NOTHING re-mounts here — the observer the suite installed earlier is the only thing that can
      // notice this, which is the whole point of the burst.
      while (list.firstChild) list.removeChild(list.firstChild);
      list.appendChild(frag);
      return { keys: keys, paths: P.BURST, linksBefore: before.links, passesBefore: before.passes,
        mountedOn: fx.mountedOn };
    },
    /* (e) one more message, whose only new candidate is the path the stub API never answers for */
    hang: function () {
      var CR = window.HD.chatRender, list = fx.list();
      list.appendChild(CR.renderMessage({ key: 'fx-hang-1', ts: Date.now(), role: 'user', kind: 'text',
        text: 'the file ' + P.HANG + ' is the one the server will not answer about' }, {}));
      return { path: P.HANG };
    },
    /* one more message naming a path nothing has asked about yet: the probe for "asking has stopped" */
    probe: function (which) {
      var CR = window.HD.chatRender, list = fx.list();
      var p = which === 'extra' ? P.EXTRA : (which === 'hang' ? P.HANG : String(which));
      list.appendChild(CR.renderMessage({ key: 'fx-probe-' + fx.probes++, ts: Date.now(), role: 'assistant',
        kind: 'text', text: 'and here is ' + p + ' as well' }, {}));
      return { path: p };
    },

    /* ── measurements the suite reads ───────────────────────────────────────── */
    dom: function (scopeId) {
      var scope = document.getElementById(scopeId || 'fxList');
      var links = Array.prototype.slice.call(scope.querySelectorAll('.hd-pl-link'));
      var menus = Array.prototype.slice.call(scope.querySelectorAll('.hd-pl-menu'));
      var box = function (n) {
        var r = n.getBoundingClientRect();
        return { w: r.width, h: r.height, l: r.left, t: r.top, r: r.right, b: r.bottom };
      };
      var vw = window.innerWidth, vh = window.innerHeight;
      var inside = function (r, pad) {
        var p = pad === undefined ? 0 : pad;
        return r.l >= -p && r.t >= -p && r.r <= vw + p && r.b <= vh + p;
      };
      var byPath = {};
      links.forEach(function (a) {
        var p = a.getAttribute('data-hd-path');
        byPath[p] = (byPath[p] || 0) + 1;
      });
      return {
        scope: scope.id,
        viewport: { w: vw, h: vh },
        linkCount: links.length,
        byPath: byPath,
        nestedLinks: scope.querySelectorAll('.hd-pl-link .hd-pl-link').length,
        linkTags: scope.querySelectorAll('a').length,
        links: links.map(function (a) {
          return { path: a.getAttribute('data-hd-path'), kind: a.getAttribute('data-hd-kind'),
            text: a.textContent, role: a.getAttribute('role'), tabindex: a.getAttribute('tabindex'),
            title: a.getAttribute('title'), cls: a.className, box: box(a), inside: inside(box(a)) };
        }),
        menus: menus.map(function (m) {
          var mr = box(m);
          var p = m.querySelector('.hd-pl-menu-path');
          var pr = p ? box(p) : null;
          var mid = document.elementFromPoint(Math.round(mr.l + mr.w / 2), Math.round(mr.t + mr.h / 2));
          return { box: mr, inside: inside(mr), insidePadded: inside(mr, 8),
            parent: m.parentNode ? (m.parentNode.id || m.parentNode.className) : null,
            position: getComputedStyle(m).position, zIndex: getComputedStyle(m).zIndex,
            widthCss: getComputedStyle(m).width,
            pathText: p ? p.textContent : null,
            pathBox: pr, pathWhite: p ? getComputedStyle(p).whiteSpace : null,
            pathOverflow: p ? getComputedStyle(p).textOverflow : null,
            pathHScroll: p ? p.scrollWidth - p.clientWidth : null,
            note: (m.querySelector('.hd-pl-menu-note') || {}).textContent || '',
            noteCls: (m.querySelector('.hd-pl-menu-note') || {}).className || '',
            buttons: Array.prototype.map.call(m.querySelectorAll('.hd-pl-menu-btn'), function (b) { return b.textContent; }),
            acts: Array.prototype.map.call(m.querySelectorAll('.hd-pl-menu-btn'), function (b) { return b.getAttribute('data-hd-act'); }),
            btnBoxes: Array.prototype.map.call(m.querySelectorAll('.hd-pl-menu-btn'), function (b) { return box(b); }),
            hitIsMenu: !!(mid && (mid === m || m.contains(mid))),
            hit: mid ? mid.tagName + '.' + mid.className : null };
        }),
        scroller: (function () { var s = document.getElementById('fxScroller'); return box(s); })(),
        scroll: (function () { var s = document.getElementById('fxScroller');
          return { top: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight }; })(),
        listText: scope.textContent,
        state: window.HD.pathlink.state()
      };
    },
    /* The links of one path. NOT a CSS attribute selector: a Windows path is full of backslashes,
       which the selector grammar reads as escapes, so the selector silently matches nothing. */
    linksOf: function (path, scopeId, last) {
      var scope = document.getElementById(scopeId || 'fxList');
      var all = scope.querySelectorAll('.hd-pl-link'), out = [];
      for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-hd-path') === path) out.push(all[i]);
      return last ? out.slice(-1) : out;
    },
    /* a link's geometry for the suite's own clicks, by path (last: the newest link for that path) */
    linkBox: function (path, scopeId, last) {
      var a = fx.linksOf(path, scopeId, last)[0];
      if (!a) return null;
      var r = a.getBoundingClientRect();
      var c = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      var hit = document.elementFromPoint(c.x, c.y);
      return { x: c.x, y: c.y, l: r.left, t: r.top, r: r.right, b: r.bottom, kind: a.getAttribute('data-hd-kind'),
        hitIsLink: !!(hit && (hit === a || a.contains(hit))), hit: hit ? hit.tagName + '.' + hit.className : null };
    },
    /* A point inside the link that a real mouse press would actually land on. A wrapped inline's
       union box has holes between its line boxes, so "the centre" can be a point that hit-tests to
       the paragraph behind it: this samples a grid inside the box and returns the first point whose
       elementFromPoint is the link itself. `found:false` is a real answer — the suite reports it. */
    clickPoint: function (path, scopeId, last) {
      var a = fx.linksOf(path, scopeId, last)[0];
      if (!a) return { found: false, why: 'no such link', tried: 0 };
      var r = a.getBoundingClientRect(), tried = 0, i, j;
      for (i = 1; i <= 5 && !tried; i++) {
        for (j = 1; j <= 5; j++) {
          var x = Math.round(r.left + (r.width * i) / 6), y = Math.round(r.top + (r.height * j) / 6);
          var hit = document.elementFromPoint(x, y);
          if (hit && (hit === a || a.contains(hit))) { tried = 1; return { found: true, x: x, y: y, tried: 1 }; }
        }
      }
      return { found: false, why: 'every sampled point inside the link hit-tests elsewhere', tried: 0,
        box: { l: r.left, t: r.top, r: r.right, b: r.bottom }, samples: 25 };
    },
    /* Bring a link fully inside the scrolled pane first, then hand back a point inside it. The (b)
       checks deliberately leave the pane scrolled to the bottom, so a link from the top of the list
       would be off-screen and unclickable — which is exactly what a reader would face, and exactly
       what an unscrolled click would silently measure instead. */
    showLink: function (path, scopeId) {
      var a = fx.linksOf(path, scopeId)[0];
      if (!a) return { found: false, why: 'no such link' };
      var s = document.getElementById('fxScroller');
      var ra = a.getBoundingClientRect(), rs = s.getBoundingClientRect();
      if (ra.top < rs.top || ra.bottom > rs.bottom) {
        s.scrollTop += Math.round(ra.top - rs.top) - 20;      // the link 20 px below the pane's top edge
      }
      var out = fx.clickPoint(path, scopeId);
      var r2 = a.getBoundingClientRect();
      out.scrolledTo = Math.round(s.scrollTop);
      out.box = { l: r2.left, t: r2.top, r: r2.right, b: r2.bottom };
      out.inPane = r2.top >= rs.top - 1 && r2.bottom <= rs.bottom + 1;
      return out;
    },
    /* focus a link without a click: the keyboard checks need the focus, not the side effect */
    focusLink: function (path, scopeId) {
      var a = fx.linksOf(path, scopeId)[0];
      if (!a) return null;
      a.focus();
      return { focused: document.activeElement === a, tag: a.tagName, tabindex: a.getAttribute('tabindex') };
    },
    menuNote: function () {
      var n = document.querySelector('.hd-pl-menu-note');
      return n ? { text: n.textContent, cls: n.className } : null;
    },
    menuCount: function () { return document.querySelectorAll('.hd-pl-menu').length; },
    elapsed: function (ms) { return new Promise(function (r) { setTimeout(function () { r(ms); }, ms); }); }
  };
  window.HD = window.HD || {};
  window.HD.fx = fx;
  window.fx = fx;
})();
