/* herdr-dash — lib/search.js (W2, CONTRACT-v2 §4.4)
 *
 * Cross-pane search over the client buffers of every pane seen this session
 * (ctx.state.buffer(paneId), a live reference) plus in-transcript n / N.
 * Clicking a result selects that pane and highlights the matching line
 * (ctx.ui.highlightLine puts a CSS class on the transcript wrapper).
 *
 * Classic script (no modules/imports). Never throws outward.
 */
(function () {
  'use strict';

  var ID = 'search';
  var TITLE = 'Cross-pane search';
  var MAX_ROWS = 400;
  var MAX_PER_PANE = 200;

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined && text !== null) d.textContent = String(text);
    return d;
  }

  function mount(ctx) {
    var root = el('div', 'srch-panel hidden');
    root.id = 'hdSearch';

    var head = el('div', 'srch-head');
    head.appendChild(el('span', 'strong', 'search transcripts'));
    head.appendChild(el('span', 'dim small', 'every pane buffered this session · n / N walk the current pane'));
    var close = el('button', 'btn', 'close');
    head.appendChild(close);
    root.appendChild(head);

    var bar = el('div', 'srch-bar');
    var input = el('input', 'srch-input');
    input.type = 'text';
    input.placeholder = 'find text in the client-side transcripts…  (Enter searches)';
    input.spellcheck = false;
    var caseChk = document.createElement('input');
    caseChk.type = 'checkbox';
    var caseLbl = el('label', 'chk');
    caseLbl.appendChild(caseChk);
    caseLbl.appendChild(el('span', null, 'match case'));
    var go = el('button', 'btn primary', 'search');
    var status = el('span', 'dim small', '');
    bar.appendChild(input);
    bar.appendChild(caseLbl);
    bar.appendChild(go);
    bar.appendChild(status);
    root.appendChild(bar);

    var results = el('div', 'srch-results');
    root.appendChild(results);
    var err = el('div', 'err hidden');
    root.appendChild(err);

    ctx.ui.container().appendChild(root);

    var state = { open: false, matches: [], cursor: -1, query: '', paneMatches: [] };

    /* ---------------------------------------------------------------- panes */
    function knownPanes() {
      var ids = [];
      var seen = (ctx.state && typeof ctx.state.seenPanes === 'function') ? ctx.state.seenPanes() : [];
      for (var i = 0; i < seen.length; i++) ids.push(seen[i]);
      var panes = (ctx.state && typeof ctx.state.panes === 'function') ? ctx.state.panes() : [];
      for (var j = 0; j < panes.length; j++) {
        if (panes[j] && panes[j].pane_id && ids.indexOf(panes[j].pane_id) < 0) ids.push(panes[j].pane_id);
      }
      return ids;
    }

    function labelFor(paneId) {
      var p = (ctx.state && typeof ctx.state.pane === 'function') ? ctx.state.pane(paneId) : null;
      if (!p) return '';
      return [p.label || '', p.agent || ''].filter(Boolean).join(' ');
    }

    /* ---------------------------------------------------------------- search */
    function doSearch() {
      state.query = input.value;
      results.textContent = '';
      err.classList.add('hidden');
      state.matches = [];
      state.paneMatches = [];
      state.cursor = -1;
      if (!state.query) { status.textContent = ''; return; }

      var needle = caseChk.checked ? state.query : state.query.toLowerCase();
      var ids = knownPanes();
      var total = 0, shown = 0, panesWithHits = 0;

      for (var i = 0; i < ids.length; i++) {
        var paneId = ids[i];
        var buf = null;
        try { buf = ctx.state.buffer(paneId); } catch (e) { buf = null; }
        if (!buf || !buf.length) continue;
        var hits = [];
        for (var ln = 0; ln < buf.length; ln++) {
          var line = String(buf[ln] == null ? '' : buf[ln]);
          var hay = caseChk.checked ? line : line.toLowerCase();
          var at = hay.indexOf(needle);
          if (at < 0) continue;
          hits.push({ line: ln, text: line, at: at });
          total++;
          if (hits.length >= MAX_PER_PANE) break;
        }
        if (!hits.length) continue;
        panesWithHits++;
        state.paneMatches.push({ paneId: paneId, hits: hits });

        var group = el('div', 'srch-group' + (paneId === ctx.state.selectedPaneId ? ' current' : ''));
        var gh = el('div', 'srch-group-head');
        gh.appendChild(el('span', 'mono strong', paneId));
        gh.appendChild(el('span', 'dim small', labelFor(paneId)));
        gh.appendChild(el('span', 'badge', hits.length + (hits.length >= MAX_PER_PANE ? '+' : '') + ' hits'));
        gh.addEventListener('click', function (id) { ctx.ui.selectPane(id); }.bind(null, paneId));
        group.appendChild(gh);

        for (var h = 0; h < hits.length && shown < MAX_ROWS; h++) {
          var hit = hits[h];
          var row = el('div', 'srch-row');
          row.appendChild(el('span', 'mono dim small srch-ln', hit.line + 1));
          row.appendChild(el('span', 'mono srch-snip', snippet(hit.text, hit.at, needle.length)));
          (function (paneId2, lineIdx) {
            row.addEventListener('click', function () { jumpTo(paneId2, lineIdx); });
          })(paneId, hit.line);
          group.appendChild(row);
          shown++;
          state.matches.push({ paneId: paneId, line: hit.line });
        }
        if (shown >= MAX_ROWS) group.appendChild(el('div', 'srch-row dim', '… more matches (showing ' + MAX_ROWS + ')'));
        results.appendChild(group);
        if (shown >= MAX_ROWS) break;
      }

      status.textContent = total
        ? (total + ' hit' + (total === 1 ? '' : 's') + ' in ' + panesWithHits + ' pane' + (panesWithHits === 1 ? '' : 's') +
           (total > shown ? ' · showing ' + shown : ''))
        : ('no match for "' + state.query + '" in ' + ids.length + ' buffered pane' + (ids.length === 1 ? '' : 's'));
    }

    function snippet(text, at, len) {
      var pad = 34;
      var start = Math.max(0, at - pad);
      var end = Math.min(text.length, at + len + pad);
      return (start > 0 ? '…' : '') + text.slice(start, at) + '[' + text.slice(at, at + len) + ']' +
             text.slice(at + len, end) + (end < text.length ? '…' : '');
    }

    function jumpTo(paneId, lineIdx) {
      try {
        if (paneId !== ctx.state.selectedPaneId) ctx.ui.selectPane(paneId);
        window.setTimeout(function () {
          try { ctx.ui.highlightLine(lineIdx); } catch (e) { /* ignore */ }
        }, 180);
      } catch (e) {
        ctx.ui.toast('jump failed: ' + (e && e.message ? e.message : e), 'error');
      }
    }

    /* ---------------------------------------------------------------- n / N */
    function walk(direction) {
      var paneId = ctx.state.selectedPaneId;
      if (!paneId || !state.query) {
        ctx.ui.toast('search first (Ctrl+F), then n / N walks the hits in this pane', 'info');
        return;
      }
      var group = null;
      for (var i = 0; i < state.paneMatches.length; i++) {
        if (state.paneMatches[i].paneId === paneId) { group = state.paneMatches[i]; break; }
      }
      if (!group || !group.hits.length) {
        ctx.ui.toast('no "' + state.query + '" hits buffered for ' + paneId, 'info');
        return;
      }
      var lines = group.hits.map(function (h) { return h.line; });
      var pick = null;
      if (direction > 0) {
        for (var j = 0; j < lines.length; j++) if (lines[j] > state.cursor) { pick = lines[j]; break; }
        if (pick === null) pick = lines[0];
      } else {
        for (var k = lines.length - 1; k >= 0; k--) if (lines[k] < state.cursor) { pick = lines[k]; break; }
        if (pick === null) pick = lines[lines.length - 1];
      }
      state.cursor = pick;
      ctx.ui.highlightLine(pick);
      status.textContent = 'hit at line ' + (pick + 1) + ' of ' + paneId;
    }

    /* ---------------------------------------------------------------- open/close */
    function show() {
      root.classList.remove('hidden');
      state.open = true;
      input.focus();
    }
    function hide() { root.classList.add('hidden'); state.open = false; }
    function toggle() { state.open ? hide() : show(); }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
      if (e.key === 'Escape') { e.preventDefault(); hide(); }
    });
    go.addEventListener('click', doSearch);
    close.addEventListener('click', hide);
    caseChk.addEventListener('change', function () { if (state.query) doSearch(); });

    var onKey = function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        show();
        if (input.value) doSearch();
        return;
      }
      var t = e.target || {};
      var typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'n') { e.preventDefault(); walk(1); return; }
      if (e.key === 'N') { e.preventDefault(); walk(-1); return; }
      if (e.key === 'Escape' && state.open) { e.preventDefault(); hide(); }
    };
    document.addEventListener('keydown', onKey, true);

    /* a new buffer may contain new hits: re-run the query, debounced */
    var stale = null;
    ctx.events.on('buffer', function () {
      if (!state.open || !state.query) return;
      window.clearTimeout(stale);
      stale = window.setTimeout(function () { try { doSearch(); } catch (e) { /* keep the old list */ } }, 400);
    });

    ctx.events.emit('keys.register', {
      id: ID,
      help: 'cross-pane search over the client buffers',
      keys: [
        { key: 'Ctrl+F', help: 'open cross-pane search' },
        { key: 'n', help: 'next search hit in the current pane' },
        { key: 'N', help: 'previous search hit in the current pane' }
      ]
    });

    return {
      show: show, hide: hide, toggle: toggle,
      search: doSearch,
      hits: function () { return state.matches.slice(); },
      unmount: function () {
        document.removeEventListener('keydown', onKey, true);
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  var mod = { id: ID, title: TITLE, mount: mount };
  var HD = (window.HD = window.HD || {});
  HD.modules = HD.modules || {};
  HD.modules[ID] = mod;
  HD.pending = HD.pending || [];
  if (HD.pending.indexOf(mod) < 0) HD.pending.push(mod);
  if (typeof HD.register === 'function') { try { HD.register(mod); } catch (e) { /* app.js reports it */ } }
})();
