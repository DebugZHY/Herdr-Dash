/* herdr-dash — lib/palette.js (W2, CONTRACT-v2 §4.2)
 *
 * Ctrl+K / Cmd+K command palette: fuzzy filter over every pane and over a command list.
 * `?` opens the help overlay, which lists every shortcut modules registered through
 * ctx.events.emit('keys.register', {id, keys:[{key,help}], help}).
 *
 * Classic script (no modules/imports). Owns its own DOM; never touches app.js state directly,
 * only ctx. Never throws outward: every failure is shown inside the palette.
 */
(function () {
  'use strict';

  var ID = 'palette';
  var TITLE = 'Command palette';

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined && text !== null) d.textContent = String(text);
    return d;
  }

  /* ---------------------------------------------------------------- fuzzy match */
  /* subsequence match with a small score: earlier and more contiguous wins. */
  function fuzzy(needle, hay) {
    var n = String(needle || '').toLowerCase();
    var h = String(hay || '').toLowerCase();
    if (!n) return { score: 1, hits: [] };
    var hi = 0, score = 0, streak = 0, hits = [];
    for (var i = 0; i < n.length; i++) {
      var c = n[i];
      if (c === ' ') continue;
      var found = -1;
      while (hi < h.length) {
        if (h[hi] === c) { found = hi; hi++; break; }
        hi++;
      }
      if (found < 0) return null;
      streak = (i > 0 && found === hits[hits.length - 1] + 1) ? streak + 1 : 0;
      score += 10 + streak * 5 - Math.min(9, found / 4);
      hits.push(found);
    }
    return { score: score, hits: hits };
  }

  function mount(ctx) {
    var root = el('div', 'pal-root hidden');
    root.id = 'hdPalette';
    var box = el('div', 'pal-box');
    var input = el('input', 'pal-input');
    input.type = 'text';
    input.placeholder = 'type a pane or a command…  (↑↓ move, Enter run, Esc close)';
    input.spellcheck = false;
    var list = el('div', 'pal-list');
    var foot = el('div', 'pal-foot');
    foot.textContent = 'Ctrl+K / Cmd+K toggle  ·  ? help';
    box.appendChild(input);
    box.appendChild(list);
    box.appendChild(foot);
    root.appendChild(box);
    document.body.appendChild(root);

    var help = el('div', 'pal-root hidden');
    help.id = 'hdHelp';
    var hbox = el('div', 'pal-box');
    var hhead = el('div', 'pal-head', 'keyboard shortcuts');
    var hbody = el('div', 'pal-list');
    var hfoot = el('div', 'pal-foot', 'Esc or ? closes  ·  shortcuts are ignored while typing in an input');
    hbox.appendChild(hhead);
    hbox.appendChild(hbody);
    hbox.appendChild(hfoot);
    help.appendChild(hbox);
    document.body.appendChild(help);

    var state = { open: false, helpOpen: false, items: [], cursor: 0, mode: 'root' };

    /* ---------------------------------------------------------------- commands */
    function paneItems() {
      var out = [];
      var panes = (ctx.state && typeof ctx.state.panes === 'function') ? ctx.state.panes() : [];
      for (var i = 0; i < panes.length; i++) {
        var p = panes[i];
        if (!p || !p.pane_id) continue;
        var st = statusOf(p);
        out.push({
          kind: 'pane',
          key: p.pane_id,
          label: p.pane_id,
          sub: [p.label || '', p.agent || '', st, p.cwd || ''].filter(Boolean).join('  '),
          hay: [p.pane_id, p.label || '', p.agent || '', st, p.cwd || '', p.tab_id || '', p.workspace_id || ''].join(' '),
          run: function (id) {
            ctx.ui.selectPane(id);
            ctx.ui.toast('focused ' + id, 'ok');
          }.bind(null, p.pane_id)
        });
      }
      return out;
    }

    function moduleToggle(label, id) {
      return {
        kind: 'command',
        key: label,
        label: label,
        sub: 'toggle the ' + id + ' module',
        hay: label + ' ' + id,
        run: function () {
          if (!ctx.modules || !ctx.modules.toggle(id)) {
            ctx.ui.toast('module "' + id + '" is not present', 'error');
          }
        }
      };
    }

    function commandItems() {
      var cmds = [
        { kind: 'command', key: 'focus pane', label: 'focus pane', sub: 'pick a pane from the tree', hay: 'focus pane select goto switch',
          run: function () { state.mode = 'panes'; input.value = ''; render(); } },
        { kind: 'command', key: 'send prompt…', label: 'send prompt…', sub: 'focus the prompt box of the selected pane', hay: 'send prompt text message write',
          run: function () { close(); var ta = document.getElementById('promptText'); if (ta) { ta.focus(); } } },
        { kind: 'command', key: 'run herdr command…', label: 'run herdr command…', sub: 'focus the console cli line', hay: 'run herdr command cli console exec',
          run: function () { close(); openConsole(); var ci = document.getElementById('cmdInput'); if (ci) ci.focus(); } },
        { kind: 'command', key: 'open console', label: 'open console', sub: 'show the cli / rpc panel', hay: 'open console cli rpc panel',
          run: function () { close(); openConsole(); } },
        moduleToggle('toggle grid', 'grid'),
        moduleToggle('toggle board', 'board'),
        moduleToggle('toggle inbox', 'inbox'),
        moduleToggle('toggle gitview', 'gitview'),   // round 5: read-only changes view (§7.2)
        /* round 7.1 (DEFECT-13): the chat view / raw terminal have no module to toggle — they are
           the two faces of the same panel, so each row asks the chatview module for its face */
        { kind: 'command', key: 'chat view', label: 'chat view', sub: 'prompts + replies as a chat (§8.3)', hay: 'chat view conversation bubbles transcript',
          run: function () { close(); var api = ctx.modules && ctx.modules.api('chatview'); if (api && api.show) api.show(); else ctx.ui.toast('chatview module is not present', 'error'); } },
        { kind: 'command', key: 'raw terminal', label: 'raw terminal', sub: 'the raw transcript the pane writes (permission prompts live here)', hay: 'raw terminal transcript pre text t',
          run: function () { close(); var api = ctx.modules && ctx.modules.api('chatview'); if (api && api.hide) api.hide(); else ctx.ui.toast('chatview module is not present', 'error'); } },
        { kind: 'command', key: 'search transcripts…', label: 'search transcripts…', sub: 'cross-pane search over the client buffers', hay: 'search find grep transcripts',
          run: function () { close(); var api = ctx.modules && ctx.modules.api('search'); if (api && api.show) api.show(); else ctx.ui.toast('search module is not present', 'error'); } },
        { kind: 'command', key: 'fan out a prompt…', label: 'fan out a prompt…', sub: 'one prompt to many panes', hay: 'fan out fanout broadcast multi prompt',
          run: function () { close(); var api = ctx.modules && ctx.modules.api('fanout'); if (api && api.show) api.show(); else ctx.ui.toast('fanout module is not present', 'error'); } },
        { kind: 'command', key: 'run self-test', label: 'run self-test', sub: 'reload with ?selftest=1 (algorithm PASS/FAIL into the transcript)', hay: 'run self-test selftest test advancebuffer regression',
          run: function () {
            var q = window.location.search || '';
            window.location.search = q.indexOf('selftest=1') >= 0 ? q.replace(/[?&]selftest=1/, '') : (q ? q + '&selftest=1' : '?selftest=1');
          } }
      ];
      return cmds;
    }

    function openConsole() {
      var p = document.getElementById('consolePanel');
      if (!p) return;
      if (p.classList.contains('collapsed')) {
        try { window.localStorage.setItem('herdrDash.consoleCollapsed', '0'); } catch (e) { /* ignore */ }
        p.classList.remove('collapsed');
      }
    }

    function statusOf(p) {
      var s = String((p && p.agent_status) || '').toLowerCase();
      return ['working', 'blocked', 'idle', 'done'].indexOf(s) >= 0 ? s : 'unknown';
    }

    /* ---------------------------------------------------------------- render */
    function candidates() {
      return state.mode === 'panes' ? paneItems() : paneItems().concat(commandItems());
    }

    function render() {
      var q = input.value;
      var items = candidates();
      var scored = [];
      for (var i = 0; i < items.length; i++) {
        var m = fuzzy(q, items[i].hay);
        if (!m) continue;
        scored.push({ item: items[i], score: m.score });
      }
      if (state.mode !== 'panes') {
        // commands first when the query is empty, otherwise best score wins
        scored.sort(function (a, b) {
          var ac = a.item.kind === 'command' ? 1 : 0, bc = b.item.kind === 'command' ? 1 : 0;
          if (!q && ac !== bc) return bc - ac;
          if (ac !== bc && (a.score - b.score) === 0) return bc - ac;
          return b.score - a.score;
        });
      }
      state.items = scored.slice(0, 60).map(function (s) { return s.item; });
      if (state.cursor >= state.items.length) state.cursor = Math.max(0, state.items.length - 1);
      list.textContent = '';
      if (!state.items.length) {
        list.appendChild(el('div', 'pal-row empty', 'no match for "' + q + '"'));
        return;
      }
      for (var j = 0; j < state.items.length; j++) {
        var it = state.items[j];
        var row = el('div', 'pal-row' + (j === state.cursor ? ' sel' : ''));
        row.appendChild(el('span', 'pal-kind ' + it.kind, it.kind === 'pane' ? 'pane' : 'cmd'));
        row.appendChild(el('span', 'pal-label', it.label));
        row.appendChild(el('span', 'pal-sub', it.sub));
        row.appendChild(el('span', 'pal-key', it.key));
        row.addEventListener('mousedown', function (idx, ev) {
          ev.preventDefault();
          state.cursor = idx;
          run();
        }.bind(null, j));
        list.appendChild(row);
      }
      var sel = list.children[state.cursor];
      if (sel && sel.scrollIntoView) { try { sel.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } }
    }

    function run() {
      var it = state.items[state.cursor];
      if (!it) return;
      try { it.run(); } catch (e) { ctx.ui.toast('command failed: ' + (e && e.message ? e.message : e), 'error'); }
      if (state.mode !== 'panes') close();
      else render();
    }

    /* ---------------------------------------------------------------- open/close */
    function open(mode) {
      if (state.helpOpen) closeHelp();
      state.mode = mode || 'root';
      state.cursor = 0;
      input.value = '';
      root.classList.remove('hidden');
      state.open = true;
      render();
      input.focus();
    }
    function close() {
      root.classList.add('hidden');
      state.open = false;
    }
    function toggle() { state.open ? close() : open('root'); }

    function openHelp() {
      if (state.open) close();
      hbody.textContent = '';
      var reg = ctx.__keys || null;   // set below from the keys.register stream
      var ids = Object.keys(reg || {});
      if (!ids.length) hbody.appendChild(el('div', 'pal-row empty', 'no shortcuts registered yet'));
      for (var i = 0; i < ids.length; i++) {
        var group = el('div', 'pal-group');
        group.appendChild(el('div', 'pal-group-head', ids[i]));
        var keys = reg[ids[i]] || [];
        for (var j = 0; j < keys.length; j++) {
          var row = el('div', 'pal-row');
          row.appendChild(el('span', 'pal-kind kbd', keys[j].key || '?'));
          row.appendChild(el('span', 'pal-sub', keys[j].help || ''));
          group.appendChild(row);
        }
        hbody.appendChild(group);
      }
      var extra = el('div', 'pal-group');
      extra.appendChild(el('div', 'pal-group-head', 'app'));
      var appKeys = [
        { key: 'Ctrl+K', help: 'command palette' },
        { key: '?', help: 'this overlay' },
        { key: 'Enter', help: 'send the prompt box' },
        { key: 'Shift+Enter', help: 'newline in the prompt box' }
      ];
      for (var k = 0; k < appKeys.length; k++) {
        var r2 = el('div', 'pal-row');
        r2.appendChild(el('span', 'pal-kind kbd', appKeys[k].key));
        r2.appendChild(el('span', 'pal-sub', appKeys[k].help));
        extra.appendChild(r2);
      }
      hbody.appendChild(extra);
      help.classList.remove('hidden');
      state.helpOpen = true;
    }
    function closeHelp() { help.classList.add('hidden'); state.helpOpen = false; }
    function toggleHelp() { state.helpOpen ? closeHelp() : openHelp(); }

    /* ---------------------------------------------------------------- events */
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); state.cursor = Math.min(state.items.length - 1, state.cursor + 1); render(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); state.cursor = Math.max(0, state.cursor - 1); render(); return; }
      if (e.key === 'Enter') { e.preventDefault(); run(); return; }
      if (e.key === 'Escape') { e.preventDefault(); state.mode === 'panes' ? (state.mode = 'root', input.value = '', render()) : close(); return; }
      if (e.key === 'Tab') { e.preventDefault(); close(); }
    });
    input.addEventListener('input', function () { state.cursor = 0; render(); });
    root.addEventListener('mousedown', function (e) { if (e.target === root) close(); });
    help.addEventListener('mousedown', function (e) { if (e.target === help) closeHelp(); });

    var onKey = function (e) {
      var t = e.target || {};
      var typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        toggle();
        return;
      }
      if (typing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }
      if (e.key === 'Escape' && state.helpOpen) { e.preventDefault(); closeHelp(); }
    };
    document.addEventListener('keydown', onKey, true);

    /* the help overlay is fed by the module shortcut registrations */
    var savedKeys = {};
    ctx.events.on('keys.register', function (payload) {
      if (!payload || !payload.id) return;
      savedKeys[payload.id] = Array.isArray(payload.keys) ? payload.keys.map(function (k) {
        return (k && typeof k === 'object') ? { key: k.key, help: k.help } : { key: String(k), help: payload.help || '' };
      }) : [];
      ctx.__keys = savedKeys;
      if (state.helpOpen) openHelp();
    });
    ctx.__keys = savedKeys;

    var btn = document.getElementById('helpBtn');
    if (btn) btn.addEventListener('click', function () { toggleHelp(); });

    ctx.events.emit('keys.register', {
      id: ID,
      help: 'command palette + this overlay',
      keys: [
        { key: 'Ctrl+K', help: 'open the command palette (panes + commands)' },
        { key: '?', help: 'open this shortcut overlay' }
      ]
    });

    return {
      show: function () { open('root'); },
      hide: close,
      toggle: toggle,
      showHelp: openHelp,
      keys: function () { return savedKeys; },
      unmount: function () {
        document.removeEventListener('keydown', onKey, true);
        if (root.parentNode) root.parentNode.removeChild(root);
        if (help.parentNode) help.parentNode.removeChild(help);
      }
    };
  }

  /* §3 registration handshake (lib/*.js loads before app.js) */
  var mod = { id: ID, title: TITLE, mount: mount };
  var HD = (window.HD = window.HD || {});
  HD.modules = HD.modules || {};
  HD.modules[ID] = mod;
  HD.pending = HD.pending || [];
  if (HD.pending.indexOf(mod) < 0) HD.pending.push(mod);
  if (typeof HD.register === 'function') { try { HD.register(mod); } catch (e) { /* app.js reports it */ } }
})();
