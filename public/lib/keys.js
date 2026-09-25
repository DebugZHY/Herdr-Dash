/* herdr-dash — lib/keys.js (W2, CONTRACT-v2 §4.3, ROADMAP #5)
 *
 * Global keyboard navigation:
 *   Ctrl+1..9   select the Nth pane in the tree (visible order)
 *   j / k       next / previous pane in the tree
 *   /           focus the prompt box
 *   Esc         closes the topmost overlay; it reaches the pane ONLY when the
 *               "arm esc→pane" toggle in the keys row is ON (default OFF) and no
 *               overlay is open and the prompt box is empty and unfocused
 *   g then b/i/p/f/s/g  toggle board / inbox / palette / changes, open fan-out / search
 *
 * DEFECT-3 — an Esc inside an open overlay used to leak to the pane (it interrupted a working
 * agent). Two things were wrong and both are fixed here:
 *
 *   (a) ordering. This module used to decide on `document` capture. W3's board/inbox close
 *       themselves on `document` (bubble) and grid on `document` capture, so by the time the
 *       decision ran the overlay was already closed (board/inbox) or the decision ran *before*
 *       the module had its say yet looked at a stale `overlayOpen()` (grid) — either way
 *       `overlayOpen()` answered "no overlay" and Esc went to the agent. The decision now runs
 *       on WINDOW BUBBLE, i.e. after every document-phase listener, and it is *latched*: window
 *       CAPTURE (the very first listener in the propagation path) records whether an overlay was
 *       open when the key arrived, and the bubble phase refuses to send if it was, or if one is
 *       open now, or if anyone called preventDefault(). One Esc closes exactly one overlay and
 *       never reaches the pane while an overlay is open.
 *
 *   (b) arming. Sending Esc to a pane interrupts the model's turn, so it is opt-in now:
 *       `arm esc→pane: on|off` in the keys row (localStorage `herdrDash.armEsc`, default off).
 *       While disarmed Esc never calls sendEsc() — pressing it just says so in the hint. The
 *       explicit `esc` button in the keys row is unaffected and always works.
 *
 * Also guarantees the per-pane control bar under the prompt box has every button
 * (esc, ctrl+c, enter, tab, shift+tab, up, down, ctrl+o). app.js owns the click delegate;
 * this module only adds buttons that are missing, so nothing is duplicated.
 *
 * Classic script (no modules/imports). Never throws outward.
 */
(function () {
  'use strict';

  var ID = 'keys';
  var TITLE = 'Keyboard navigation';
  var BAR_KEYS = ['esc', 'ctrl+c', 'enter', 'tab', 'shift+tab', 'up', 'down', 'ctrl+o'];
  var PREFIX_MS = 1200;
  var ARM_KEY = 'herdrDash.armEsc';       // '1' armed, anything else disarmed
  var ARM_ID = 'hdArmEsc';                // the toggle button in #keysRow

  /* every overlay in the app, W2's and W3's: the four dialogs live under #hdOverlays with a
     `hidden` class, the three panels are appended to <body> and use the `hidden` property. */
  var OVERLAY_SEL = '#hdPalette, #hdHelp, #hdSearch, #hdFanout, .hd-board, .hd-inbox, .hd-grid, [data-hd-overlay]';

  function typing(el) {
    if (!el) return false;
    var t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable === true;
  }

  function visible(el) {
    if (!el) return false;
    if (el.hidden) return false;                                 // W3's panels toggle this property
    if (el.classList && el.classList.contains('hidden')) return false;
    var win = el.ownerDocument && el.ownerDocument.defaultView;
    if (win && win.getComputedStyle) {
      var cs = win.getComputedStyle(el);
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    }
    if (el.getBoundingClientRect) {                              // a mounted-but-empty overlay is not open
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
    }
    return true;
  }

  function overlayOpen() {
    var els = document.querySelectorAll(OVERLAY_SEL);
    for (var i = 0; i < els.length; i++) if (visible(els[i])) return true;
    return false;
  }

  /** the overlay that is open, for hints/debugging */
  function openOverlayName() {
    var els = document.querySelectorAll(OVERLAY_SEL);
    for (var i = 0; i < els.length; i++) {
      if (visible(els[i])) return els[i].id || els[i].className.split(' ')[0] || 'overlay';
    }
    return null;
  }

  function armEscEnabled() {
    try { return window.localStorage.getItem(ARM_KEY) === '1'; } catch (e) { return false; }
  }

  function setArmEsc(on) {
    try { window.localStorage.setItem(ARM_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
    updateArmButton();
    return armEscEnabled();
  }

  function armButton() { return document.getElementById(ARM_ID); }

  function updateArmButton() {
    var b = armButton();
    if (!b) return null;
    var on = armEscEnabled();
    b.textContent = 'arm esc→pane: ' + (on ? 'on' : 'off');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.dataset.armed = on ? '1' : '0';
    b.title = on
      ? 'Esc (with no overlay open, prompt box empty) is sent to the selected pane as a real interrupt. Click to disarm.'
      : 'Esc is not sent to the pane. The "esc" button still is. Click to arm.';
    if (b.classList) b.classList.toggle('arm-on', on);
    return b;
  }

  function mount(ctx) {
    var pendingPrefix = null;
    var prefixTimer = null;
    var escLatch = null;           // name of the overlay that was open when this Esc arrived

    /* ---------------------------------------------------------------- pane order */
    function paneOrder() {
      var rows = document.querySelectorAll('.pane-row');
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var id = rows[i].dataset ? rows[i].dataset.paneId : null;
        if (id) out.push(id);
      }
      return out;
    }

    function selectByIndex(i) {
      var order = paneOrder();
      if (!order.length) { ctx.ui.toast('no panes in the tree', 'info'); return; }
      var pick = order[Math.max(0, Math.min(order.length - 1, i))];
      ctx.ui.selectPane(pick);
      ctx.ui.setHint('pane ' + (Math.max(0, Math.min(order.length - 1, i)) + 1) + '/' + order.length + ': ' + pick);
    }

    function step(delta) {
      var order = paneOrder();
      if (!order.length) return;
      var cur = order.indexOf(ctx.state.selectedPaneId);
      if (cur < 0) cur = delta > 0 ? -1 : 0;
      var next = cur + delta;
      if (next < 0) next = order.length - 1;
      if (next >= order.length) next = 0;
      selectByIndex(next);
    }

    /* ---------------------------------------------------------------- esc to the pane */
    function promptBox() { return document.getElementById('promptText'); }

    /** armed + prompt box empty + unfocused. Everything else is checked by the caller. */
    function promptAllowsEsc() {
      var box = promptBox();
      return !(box && (document.activeElement === box || box.value.length));
    }

    function sendEsc() {
      var paneId = ctx.state.selectedPaneId;
      if (!paneId) { ctx.ui.toast('no pane selected', 'info'); return; }
      ctx.api.keys(paneId, ['esc']).then(function (body) {
        if (!body || !body.ok) {
          var msg = (body && body.error) ? ((body.error.code ? body.error.code + ': ' : '') + (body.error.message || '')) : 'failed';
          ctx.ui.toast('esc -> ' + paneId + ' ' + msg, 'error');
          return;
        }
        ctx.ui.setHint('sent esc to ' + paneId);
      }).catch(function (e) {
        ctx.ui.toast('esc -> ' + paneId + ' failed: ' + (e && e.message ? e.message : e), 'error');
      });
    }

    /* ---------------------------------------------------------------- the g prefix */
    function runPrefix(second) {
      if (second === 'b') { if (!ctx.modules.toggle('board')) ctx.ui.toast('board module is not present', 'error'); return; }
      if (second === 'i') { if (!ctx.modules.toggle('inbox')) ctx.ui.toast('inbox module is not present', 'error'); return; }
      if (second === 'p') { if (!ctx.modules.toggle('palette')) ctx.ui.toast('palette module is not present', 'error'); return; }
      if (second === 'f') { var f = ctx.modules.api('fanout'); if (f && f.toggle) f.toggle(); else ctx.ui.toast('fanout module is not present', 'error'); return; }
      if (second === 's') { var s = ctx.modules.api('search'); if (s && s.toggle) s.toggle(); else ctx.ui.toast('search module is not present', 'error'); return; }
      /* g g — the round-5 read-only "what did the agents change" view (CONTRACT-v2 §7.2) */
      if (second === 'g') { if (!ctx.modules.toggle('gitview')) ctx.ui.toast('gitview module is not present', 'error'); return; }
      // g + a digit: same as Ctrl+digit
      if (second >= '1' && second <= '9') { selectByIndex(parseInt(second, 10) - 1); return; }
      ctx.ui.setHint('g' + second + ' is not a shortcut (g b board · g i inbox · g p palette · g f fan-out · g s search · g g changes)');
    }

    /* ---- phase 1: window capture. Runs BEFORE any document listener (the propagation path is
       window -> document -> … -> target on the way down), so this is the only place that can
       still see the state an overlay's own handler is about to change. It never consumes the
       event: overlays must stay free to close themselves. It only latches what it saw. ---- */
    var onKeyCapture = function (e) {
      escLatch = null;
      if (e.key === 'Escape' || e.key === 'Esc' || e.keyCode === 27) {
        escLatch = openOverlayName();      // DEFECT-3(a): remember it, decide later
        return;                            // the pane-sending decision waits for the bubble phase
      }
      if (e.defaultPrevented) return;      // an earlier window-capture listener handled it
      if (typing(e.target || document.activeElement)) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        if (overlayOpen()) return;                 // an overlay owns the keyboard while it is up
        e.preventDefault();
        selectByIndex(parseInt(e.key, 10) - 1);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (overlayOpen()) return;                   // j/k/g// belong to the overlay, not the tree
      if (pendingPrefix) {
        var second = e.key;
        pendingPrefix = null;
        window.clearTimeout(prefixTimer);
        e.preventDefault();
        runPrefix(second);
        return;
      }
      if (e.key === 'g') {
        pendingPrefix = true;
        prefixTimer = window.setTimeout(function () { pendingPrefix = null; }, PREFIX_MS);
        return;
      }
      if (e.key === 'j') { e.preventDefault(); step(1); return; }
      if (e.key === 'k') { e.preventDefault(); step(-1); return; }
      if (e.key === '/') {
        e.preventDefault();
        var ta = promptBox();
        if (ta) { ta.focus(); ctx.ui.setHint('prompt box focused (/ · Enter sends)'); }
      }
    };

    /* ---- phase 2: window bubble. Runs AFTER every document listener, so the overlays have
       already closed if they were going to. Only Esc lands here; every reason to refuse is
       spelled out. ---- */
    var onKeyBubble = function (e) {
      if (!(e.key === 'Escape' || e.key === 'Esc' || e.keyCode === 27)) return;
      if (e.defaultPrevented) return;                     // someone consumed it (overlay, dialog)
      if (escLatch) {                                     // DEFECT-3(a): an overlay was open when
        ctx.ui.setHint('esc closed ' + escLatch + ' (not sent to the pane)');  // the key arrived
        return;                                           // -> it never reaches the pane
      }
      if (overlayOpen()) {                                // …or one is open now
        ctx.ui.setHint('esc closed ' + (openOverlayName() || 'the overlay') + ' (not sent to the pane)');
        return;
      }
      if (!promptAllowsEsc()) return;                     // §4.3: only when empty and unfocused
      if (!armEscEnabled()) {                             // DEFECT-3(b): opt-in
        ctx.ui.setHint('esc→pane is OFF — click "arm esc→pane" in the keys row (the esc button works anyway)');
        return;
      }
      e.preventDefault();
      sendEsc();
    };

    window.addEventListener('keydown', onKeyCapture, true);    // capture: see the future state
    window.addEventListener('keydown', onKeyBubble, false);    // bubble: decide last

    /* ---------------------------------------------------------------- control bar */
    function ensureBar() {
      var row = document.getElementById('keysRow');
      if (!row) return;
      var present = {};
      var btns = row.querySelectorAll('button.key');
      for (var i = 0; i < btns.length; i++) present[btns[i].dataset ? btns[i].dataset.key : ''] = true;
      for (var j = 0; j < BAR_KEYS.length; j++) {
        var k = BAR_KEYS[j];
        if (present[k]) continue;
        var b = document.createElement('button');
        b.className = 'key';
        b.type = 'button';
        b.dataset.key = k;
        b.textContent = k;
        row.appendChild(b);                                  // app.js's click delegate picks it up
      }
      ensureArmButton();
    }

    /* DEFECT-3(b): the arm toggle. It carries NO `data-key`, so app.js's click delegate ignores
       it and it can never be confused with a key send. Appended last so the esc/enter/… order
       the users of this bar know stays put. */
    function ensureArmButton() {
      var row = document.getElementById('keysRow');
      if (!row) return;
      if (!armButton()) {
        var b = document.createElement('button');
        b.className = 'key arm-toggle';
        b.type = 'button';
        b.id = ARM_ID;
        b.addEventListener('click', function (ev) {
          if (ev.preventDefault) ev.preventDefault();
          var on = setArmEsc(!armEscEnabled());
          registerKeys();                     // keep the `?` overlay text in step with the toggle
          ctx.ui.setHint('esc→pane ' + (on ? 'ARMED — Esc interrupts the selected pane' : 'disarmed — Esc never reaches the pane'));
        });
        row.appendChild(b);
      }
      updateArmButton();
    }

    /* ---------------------------------------------------------------- open/close */
    var show = function () {
      ensureBar();
      updateArmButton();
      ctx.ui.setHint('keys: Ctrl+1..9 · j/k · / · Esc · g b|i|p|f|s|g · ? for help · esc→pane ' + (armEscEnabled() ? 'ARMED' : 'off'));
    };
    show();

    /* the `?` overlay is built from these rows (palette.js renders them on open), so the arming
       state is re-published whenever it changes — DEFECT-3(b): show it in the `?` overlay text. */
    function registerKeys() {
      ctx.events.emit('keys.register', {
        id: ID,
        help: 'global navigation (ignored while typing in an input)',
        keys: [
          { key: 'Ctrl+1..9', help: 'select the Nth pane in the tree' },
          { key: 'j / k', help: 'next / previous pane in the tree' },
          { key: '/', help: 'focus the prompt box' },
          { key: 'Esc', help: 'closes the top overlay — never sent to the pane while one is open, and never at all unless esc→pane is armed' },
          { key: 'esc→pane: ' + (armEscEnabled() ? 'on' : 'off'), help: 'toggle in the keys row (default off, kept in localStorage): arm Esc to interrupt the selected pane' },
          { key: 'esc button', help: 'the "esc" button in the keys row always sends esc, armed or not' },
          { key: 'g b', help: 'toggle the fleet board' },
          { key: 'g i', help: 'toggle the attention inbox' },
          { key: 'g p', help: 'toggle the command palette' },
          { key: 'g f', help: 'open the fan-out panel' },
          { key: 'g s', help: 'open cross-pane search' },
          { key: 'g g', help: 'open the changes view (read-only)' }
        ]
      });
    }
    registerKeys();

    return {
      show: show,
      hide: function () { ctx.ui.setHint(''); },
      toggle: function () { show(); },
      paneOrder: paneOrder,
      /* DEFECT-3 extras, so the toggle can be driven (and tested) without a mouse */
      overlayOpen: overlayOpen,
      openOverlay: openOverlayName,
      armEsc: function (on) { return setArmEsc(on === undefined ? true : !!on); },
      isArmedEsc: armEscEnabled,
      armButtonId: ARM_ID,
      unmount: function () {
        window.removeEventListener('keydown', onKeyCapture, true);
        window.removeEventListener('keydown', onKeyBubble, false);
        window.clearTimeout(prefixTimer);
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
