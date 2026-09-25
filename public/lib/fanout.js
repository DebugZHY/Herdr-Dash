/* herdr-dash — lib/fanout.js (W2, CONTRACT-v2 §4.5)
 *
 * Fan a single prompt out to many panes: a "select" mode that puts checkboxes on the tree rows,
 * a prompt box, one POST /api/fanout, per-pane results, and saved templates in localStorage
 * under `herdrDash.templates` (an array of {name, text}).
 *
 * Classic script (no modules/imports). Never throws outward.
 */
(function () {
  'use strict';

  var ID = 'fanout';
  var TITLE = 'Fan-out prompt';
  var LS_TEMPLATES = 'herdrDash.templates';
  var MAX_PANES = 20;          // §2: the server rejects more than 20

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined && text !== null) d.textContent = String(text);
    return d;
  }

  function lsGet(key, dflt) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw === null ? dflt : raw;
    } catch (e) { return dflt; }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(key, String(value)); } catch (e) { /* ignore */ }
  }

  function mount(ctx) {
    var root = el('div', 'fan-panel hidden');
    root.id = 'hdFanout';

    var head = el('div', 'srch-head');
    head.appendChild(el('span', 'strong', 'fan out a prompt'));
    head.appendChild(el('span', 'dim small', 'one prompt, many panes — concurrent POST /api/fanout'));
    var selBtn = el('button', 'btn', 'select mode: off');
    var close = el('button', 'btn', 'close');
    head.appendChild(selBtn);
    head.appendChild(close);
    root.appendChild(head);

    var body = el('div', 'fan-body');
    body.appendChild(el('div', 'dim small', 'targets'));
    var targetList = el('div', 'fan-targets');
    body.appendChild(targetList);

    var ta = el('textarea', 'fan-text');
    ta.rows = 4;
    ta.placeholder = 'the prompt to send to every selected pane…';
    body.appendChild(ta);

    var actions = el('div', 'fan-actions');
    var send = el('button', 'btn primary', 'send to 0 panes');
    var clear = el('button', 'btn', 'clear targets');
    var saveTpl = el('button', 'btn', 'save as template');
    actions.appendChild(send);
    actions.appendChild(clear);
    actions.appendChild(saveTpl);
    body.appendChild(actions);

    var tplRow = el('div', 'fan-templates');
    body.appendChild(tplRow);

    var out = el('div', 'fan-results');
    body.appendChild(out);
    var err = el('div', 'err hidden');
    body.appendChild(err);
    root.appendChild(body);

    ctx.ui.container().appendChild(root);

    var state = { open: false, selectMode: false, targets: {}, busy: false, templates: [] };

    try {
      var raw = lsGet(LS_TEMPLATES, '[]');
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.templates = parsed.filter(function (t) { return t && typeof t.text === 'string'; })
          .map(function (t) { return { name: String(t.name || 'template'), text: String(t.text) }; });
      }
    } catch (e) { state.templates = []; }

    function persistTemplates() { lsSet(LS_TEMPLATES, JSON.stringify(state.templates.slice(0, 40))); }

    function targetIds() {
      var out2 = [];
      for (var id in state.targets) if (Object.prototype.hasOwnProperty.call(state.targets, id) && state.targets[id]) out2.push(id);
      return out2;
    }

    /* ---------------------------------------------------------------- tree checkboxes */
    function decorateTree() {
      var rows = document.querySelectorAll('.pane-row');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var id = row.dataset ? row.dataset.paneId : null;
        if (!id) continue;
        var existing = row.querySelector('.fan-chk');
        if (!state.selectMode) {
          if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
          continue;
        }
        if (existing) { existing.checked = !!state.targets[id]; continue; }
        var chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.className = 'fan-chk';
        chk.checked = !!state.targets[id];
        chk.title = 'include ' + id + ' in the fan-out';
        chk.addEventListener('click', function (ev) { ev.stopPropagation(); });
        chk.addEventListener('change', function (paneId, box) {
          state.targets[paneId] = box.checked;
          render();
        }.bind(null, id, chk));
        row.insertBefore(chk, row.firstChild);
      }
    }

    function setSelectMode(on) {
      state.selectMode = !!on;
      selBtn.textContent = 'select mode: ' + (state.selectMode ? 'on' : 'off');
      selBtn.classList.toggle('primary', state.selectMode);
      document.body.classList.toggle('fan-selecting', state.selectMode);
      decorateTree();
      render();
    }

    /* ---------------------------------------------------------------- render */
    function render() {
      var ids = targetIds();
      send.textContent = 'send to ' + ids.length + ' pane' + (ids.length === 1 ? '' : 's');
      send.disabled = state.busy || !ids.length || !ta.value.length;

      targetList.textContent = '';
      var panes = (ctx.state && typeof ctx.state.panes === 'function') ? ctx.state.panes() : [];
      var shown = 0;
      for (var i = 0; i < panes.length; i++) {
        var p = panes[i];
        if (!p || !p.pane_id) continue;
        var chip = el('span', 'fan-chip' + (state.targets[p.pane_id] ? ' on' : ''));
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!state.targets[p.pane_id];
        box.addEventListener('change', function (paneId, b) {
          state.targets[paneId] = b.checked;
          decorateTree();
          render();
        }.bind(null, p.pane_id, box));
        chip.appendChild(box);
        chip.appendChild(el('span', 'mono', p.pane_id));
        if (p.agent_status) chip.appendChild(el('span', 'dot ' + normStatus(p.agent_status)));
        targetList.appendChild(chip);
        shown++;
      }
      if (!shown) targetList.appendChild(el('div', 'dim small', 'no panes in the snapshot yet'));

      tplRow.textContent = '';
      tplRow.appendChild(el('span', 'dim small', 'templates'));
      if (!state.templates.length) tplRow.appendChild(el('span', 'dim small', ' — none saved yet'));
      for (var t = 0; t < state.templates.length; t++) {
        (function (idx) {
          var tpl = state.templates[idx];
          var chip2 = el('span', 'fan-tpl');
          var apply = el('button', 'btn', tpl.name);
          apply.title = 'apply this template' + (tpl.text ? ':\n' + tpl.text.slice(0, 300) : '');
          apply.addEventListener('click', function () { ta.value = tpl.text; render(); ta.focus(); });
          var del = el('button', 'btn tiny', '×');
          del.title = 'delete template';
          del.addEventListener('click', function () {
            state.templates.splice(idx, 1);
            persistTemplates();
            render();
          });
          chip2.appendChild(apply);
          chip2.appendChild(del);
          tplRow.appendChild(chip2);
        })(t);
      }
    }

    function normStatus(s) {
      var v = String(s == null ? '' : s).toLowerCase();
      return ['working', 'blocked', 'idle', 'done'].indexOf(v) >= 0 ? v : 'unknown';
    }

    function showErr(text) {
      err.textContent = text;
      err.classList.remove('hidden');
    }

    function resultRow(paneId, ok, detail) {
      var row = el('div', 'fan-res ' + (ok ? 'ok' : 'err'));
      row.appendChild(el('span', 'mono strong', paneId));
      row.appendChild(el('span', 'fan-res-detail', detail));
      out.appendChild(row);
      while (out.children.length > 60) out.removeChild(out.firstChild);
    }

    /* ---------------------------------------------------------------- send */
    async function doSend() {
      var ids = targetIds();
      var text = ta.value;
      if (!ids.length) { showErr('select at least one pane (select mode)'); return; }
      if (!text.length) { showErr('nothing to send — the prompt is empty'); return; }
      if (ids.length > MAX_PANES) { showErr('the server caps a fan-out at ' + MAX_PANES + ' panes (you selected ' + ids.length + ')'); return; }
      err.classList.add('hidden');
      out.textContent = '';
      state.busy = true;
      render();
      resultRow('·', true, 'sending to ' + ids.length + ' pane(s)…');

      var body = null;
      try {
        body = await ctx.api.fanout(ids, text, {});
      } catch (e) {
        body = { ok: false, error: { code: 'network', message: e && e.message ? e.message : String(e) } };
      }
      state.busy = false;
      out.textContent = '';

      if (!body || !body.ok) {
        var msg = (body && body.error) ? ((body.error.code ? body.error.code + ': ' : '') + (body.error.message || '')) : 'request failed';
        showErr('fan-out failed — ' + msg);
        (body && Array.isArray(body.results) ? body.results : ids.map(function (id) { return { pane_id: id, ok: false, error: { message: msg } }; }))
          .forEach(function (r) { resultRow(r.pane_id, !!r.ok, okText(r)); });
        render();
        return;
      }
      var results = Array.isArray(body.results) ? body.results : [];
      var okCount = 0;
      for (var i = 0; i < results.length; i++) {
        if (results[i].ok) okCount++;
        resultRow(results[i].pane_id, !!results[i].ok, okText(results[i]));
      }
      render();
      if (okCount === results.length && results.length) ctx.ui.toast('fan-out delivered to ' + okCount + ' pane(s)', 'ok');
      else ctx.ui.toast('fan-out: ' + okCount + '/' + results.length + ' ok — see the per-pane results', okCount ? 'info' : 'error');
      state.busy = false;
      render();
    }

    function okText(r) {
      if (r.ok) {
        var res = r.result || {};
        return res.type ? ('ok · ' + res.type + (res.agent && res.agent.agent_status ? ' · ' + res.agent.agent_status : '')) : 'ok';
      }
      var e = r.error || {};
      return (e.code ? e.code + ': ' : '') + (e.message || 'failed');
    }

    /* ---------------------------------------------------------------- open/close */
    function show() {
      root.classList.remove('hidden');
      state.open = true;
      render();
      ta.focus();
    }
    function hide() { root.classList.add('hidden'); state.open = false; setSelectMode(false); }
    function toggle() { state.open ? hide() : show(); }

    close.addEventListener('click', hide);
    selBtn.addEventListener('click', function () { setSelectMode(!state.selectMode); });
    clear.addEventListener('click', function () {
      state.targets = {};
      decorateTree();
      render();
    });
    ta.addEventListener('input', render);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); hide(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); }
    });
    send.addEventListener('click', doSend);
    saveTpl.addEventListener('click', function () {
      var text = ta.value;
      if (!text) { showErr('nothing to save — the prompt is empty'); return; }
      var name = window.prompt('template name', text.split('\n')[0].slice(0, 40) || 'template');
      if (name === null) return;
      state.templates = state.templates.filter(function (t) { return t.name !== name; });
      state.templates.unshift({ name: String(name || 'template'), text: text });
      persistTemplates();
      render();
      ctx.ui.toast('template saved', 'ok');
    });

    var onKey = function (e) {
      var t = e.target || {};
      var typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape' && state.open) { e.preventDefault(); hide(); }
    };
    document.addEventListener('keydown', onKey, true);

    /* keep the checkbox list in step with the tree */
    ctx.events.on('snapshot', function () { if (state.selectMode) decorateTree(); if (state.open) render(); });
    ctx.events.on('select', function () { if (state.open) render(); });

    ctx.events.emit('keys.register', {
      id: ID,
      help: 'fan one prompt out to many panes',
      keys: [
        { key: 'Ctrl+Enter', help: 'send the fan-out prompt (panel focused)' }
      ]
    });

    return {
      show: show, hide: hide, toggle: toggle,
      targets: targetIds,
      setSelectMode: setSelectMode,
      templates: function () { return state.templates.slice(); },
      unmount: function () {
        document.removeEventListener('keydown', onKey, true);
        document.body.classList.remove('fan-selecting');
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
