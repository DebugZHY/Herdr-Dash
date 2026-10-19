/* Herdr-Dash — terminal engine.
 *
 * Classic script. window.HD.terminal.create(opts) -> handle.
 *
 * The engine owns the terminal DOM, its timers, the in-flight AbortControllers,
 * scroll/follow state, selection pause, the status line and read backoff. It never
 * polls by itself: it only runs while setActive(true) and a pane is set.
 *
 * Content is written with textContent / createTextNode only. innerHTML is used
 * exactly once per reset, to clear the host.
 */
(function (global) {
  'use strict';

  var HD = global.HD || (global.HD = {});

  var READ_TIMEOUT_MS = 3000;
  var SCROLLBACK_INTERVAL_MS = 1000;
  var BACKOFF_MS = [250, 500, 1000, 2000, 5000];
  var IDLE_AFTER_MS = 5000;
  var JUMP_THRESHOLD_PX = 24;
  var RATE_WINDOW_MS = 2000;
  var TRIM_ROWS = 1000;

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function getMerge() {
    if (HD.terminalMerge) return HD.terminalMerge;
    if (typeof require === 'function') {
      try {
        return require('./terminal-merge.js');
      } catch (e) {
        /* fall through to the error below */
      }
    }
    throw new Error('HD.terminalMerge is not loaded (load terminal-merge.js first)');
  }

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function endsWith(haystack, needle) {
    if (!needle.length) return true;
    if (haystack.length < needle.length) return false;
    var off = haystack.length - needle.length;
    for (var i = 0; i < needle.length; i += 1) {
      if (haystack[off + i] !== needle[i]) return false;
    }
    return true;
  }

  /**
   * @param {{
   *   host: HTMLElement,
   *   readScreen: function (paneId: string, signal?: AbortSignal): Promise<any>,
   *   readScrollback: function (paneId: string, lines: number, signal?: AbortSignal): Promise<any>,
   *   intervalMs: number, idleMs: number, scrollbackLines: number, maxBuffer: number,
   *   onState?: function (state: object): void
   * }} opts
   */
  function create(opts) {
    if (!opts || !opts.host || typeof opts.readScreen !== 'function' ||
        typeof opts.readScrollback !== 'function') {
      throw new TypeError('HD.terminal.create: host, readScreen and readScrollback are required');
    }

    var settings = {
      intervalMs: opts.intervalMs > 0 ? opts.intervalMs : 150,
      idleMs: opts.idleMs > 0 ? opts.idleMs : 600,
      scrollbackLines: opts.scrollbackLines > 0 ? opts.scrollbackLines : 1200,
      maxBuffer: opts.maxBuffer > 0 ? opts.maxBuffer : 6000
    };
    var merge = getMerge();
    var host = opts.host;

    // ---------------------------------------------------------------- DOM
    host.innerHTML = '';
    host.classList.add('hd-term-host');

    var scrollEl = el('div', 'hd-term-scroll');
    scrollEl.tabIndex = 0;
    scrollEl.setAttribute('role', 'log');
    scrollEl.setAttribute('aria-live', 'off');

    var listEl = el('div', 'hd-term-list');
    var jumpEl = el('button', 'hd-term-jump');
    jumpEl.type = 'button';
    jumpEl.hidden = true;
    jumpEl.textContent = '0 new \u2193';

    var statusEl = el('div', 'hd-term-status');
    statusEl.setAttribute('aria-live', 'polite');

    scrollEl.appendChild(listEl);
    host.appendChild(scrollEl);
    host.appendChild(jumpEl);
    host.appendChild(statusEl);

    // -------------------------------------------------------------- state
    var paneId = null;
    var active = false;
    var follow = true;
    var selecting = false;
    var destroyed = false;
    var gen = 0;

    var screen = [];
    var buffer = [];
    var rows = [];

    var mode = 'idle';
    var lastReadMs = 0;
    var updates = 0;
    var errors = 0;
    var lastError = '';
    var errStreak = 0;
    var lastChangeAt = Date.now();
    var followAnchor = 0;
    var readStamps = [];

    var pendingFrame = null;

    var screenTimer = null;
    var scrollTimer = null;
    var screenInFlight = null; // Promise while a screen read is outstanding
    var screenCtrl = null;
    var scrollCtrl = null;
    var scrollInFlight = false;

    // ------------------------------------------------------------- helpers
    /* Rows may carry SGR escapes when the pane read asked for ANSI. They are rendered through
       lib/ansi.js when it is loaded, and as the plain text they always were when it is not (or
       when the row has no escape at all — the common case, and the cheap one).

       `rowSrc` remembers the SOURCE line behind each row. A rendered row's textContent is the
       escape-free text, so comparing it with the buffer would redraw every coloured row on every
       frame; comparing the source does not. */
    var rowSrc = [];

    function ansiApi() {
      var HDx = (typeof window !== 'undefined' && window.HD) ? window.HD : null;
      return (HDx && HDx.ansi && typeof HDx.ansi.toNodes === 'function') ? HDx.ansi : null;
    }

    function setRowContent(row, source) {
      var text = (source === undefined || source === null) ? '' : String(source);
      if (text.indexOf('\u001b') < 0) { row.textContent = text; return; }
      var api = ansiApi();
      if (!api) { row.textContent = text; return; }
      var out;
      try {
        out = api.toNodes(text);            // parsed BEFORE the row is touched
      } catch (e) {
        out = null;
      }
      if (out && out.nodeType === 11) {
        row.textContent = '';
        row.appendChild(out);
        return;
      }
      if (out && out.length !== undefined) {
        row.textContent = '';
        for (var i = 0; i < out.length; i += 1) {
          var node = out[i];
          row.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
        }
        return;
      }
      row.textContent = text;               // no parser result (or it failed): never blank a row
    }

    function makeRow(source) {
      var row = el('div', 'hd-term-row');
      setRowContent(row, source);
      return row;
    }

    function rebuildDom() {
      listEl.innerHTML = '';
      var frag = document.createDocumentFragment();
      rows = new Array(buffer.length);
      rowSrc = new Array(buffer.length);
      for (var i = 0; i < buffer.length; i += 1) {
        var row = makeRow(buffer[i]);
        rows[i] = row;
        rowSrc[i] = buffer[i];
        frag.appendChild(row);
      }
      listEl.appendChild(frag);
    }

    function syncDom(changed) {
      var i;
      if (rows.length > buffer.length) {
        for (i = rows.length - 1; i >= buffer.length; i -= 1) {
          var dead = rows[i];
          if (dead && dead.parentNode) dead.parentNode.removeChild(dead);
        }
        rows.length = buffer.length;
        rowSrc.length = buffer.length;
      } else if (rows.length < buffer.length) {
        var frag = document.createDocumentFragment();
        for (i = rows.length; i < buffer.length; i += 1) {
          var row = makeRow(buffer[i]);
          rows.push(row);
          rowSrc.push(buffer[i]);
          frag.appendChild(row);
        }
        listEl.appendChild(frag);
      }
      if (!changed || !changed.length) return;
      for (i = 0; i < changed.length; i += 1) {
        var idx = changed[i];
        if (idx < 0 || idx >= rows.length) continue;
        if (rowSrc[idx] !== buffer[idx]) {
          setRowContent(rows[idx], buffer[idx]);
          rowSrc[idx] = buffer[idx];
        }
      }
    }

    function isNearBottom() {
      return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= JUMP_THRESHOLD_PX;
    }

    function scrollToBottom() {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    function adoptSeededBuffer(next, frame) {
      // next.length <= buffer.length: stale seed rows are dropped, the frame window patched.
      for (var i = rows.length - 1; i >= next.length; i -= 1) {
        var dead = rows[i];
        if (dead && dead.parentNode) dead.parentNode.removeChild(dead);
      }
      if (rows.length > next.length) rows.length = next.length;
      if (rowSrc.length > next.length) rowSrc.length = next.length;
      buffer = next;
      var start = Math.max(0, buffer.length - frame.length);
      for (var j = start; j < buffer.length; j += 1) {
        if (rows[j] && rowSrc[j] !== buffer[j]) {
          setRowContent(rows[j], buffer[j]);
          rowSrc[j] = buffer[j];
        }
      }
      if (follow) scrollToBottom();
      updateJump();
    }

    function trimHead(count) {
      if (count <= 0 || buffer.length <= count) return;
      var beforeHeight = scrollEl.scrollHeight;
      for (var i = 0; i < count; i += 1) {
        var row = rows.shift();
        if (row && row.parentNode) row.parentNode.removeChild(row);
      }
      buffer.splice(0, count);
      rowSrc.splice(0, count);
      followAnchor = Math.max(0, followAnchor - count);
      if (!follow) {
        var removed = beforeHeight - scrollEl.scrollHeight;
        if (removed > 0) scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop - removed);
      }
    }

    function maybeTrim() {
      var soft = settings.maxBuffer;
      if (follow) {
        if (buffer.length > soft) trimHead(TRIM_ROWS);
      } else if (buffer.length > soft + TRIM_ROWS) {
        trimHead(TRIM_ROWS);
      }
    }

    function updateJump() {
      var count = follow ? 0 : Math.max(0, buffer.length - followAnchor);
      jumpEl.hidden = !(count > 0 && !follow);
      if (!jumpEl.hidden) jumpEl.textContent = count + ' new \u2193';
    }

    function rateLabel() {
      var cutoff = now() - RATE_WINDOW_MS;
      while (readStamps.length && readStamps[0] < cutoff) readStamps.shift();
      var rate = readStamps.length / (RATE_WINDOW_MS / 1000);
      return rate.toFixed(1) + '/s';
    }

    function idleNow() {
      return Date.now() - lastChangeAt >= IDLE_AFTER_MS;
    }

    function currentMode() {
      if (destroyed) return 'destroyed';
      if (!paneId) return 'idle';
      if (!active) return 'paused';
      if (selecting) return 'selecting';
      if (mode === 'error') return 'error';
      return idleNow() ? 'idle' : 'live';
    }

    function updateStatus() {
      var m = currentMode();
      var text;
      if (m === 'idle' && !paneId) {
        text = 'no pane';
      } else if (m === 'paused') {
        text = 'paused' + (lastReadMs ? ' \u00b7 ' + lastReadMs + ' ms' : '');
      } else if (m === 'selecting') {
        text = 'selecting \u00b7 updates deferred \u00b7 ' + lastReadMs + ' ms';
      } else if (m === 'error') {
        text = 'error: ' + (lastError || 'read failed');
      } else {
        text = m + ' \u00b7 ' + lastReadMs + ' ms \u00b7 ' + rateLabel();
      }
      if (statusEl.textContent !== text) statusEl.textContent = text;
    }

    function state() {
      return {
        paneId: paneId,
        active: active,
        follow: follow,
        selecting: selecting,
        bufferLines: buffer.length,
        domRows: rows.length,
        screenRows: screen.length,
        lastReadMs: lastReadMs,
        updates: updates,
        errors: errors,
        mode: currentMode()
      };
    }

    function emit() {
      if (typeof opts.onState === 'function') {
        try {
          opts.onState(state());
        } catch (e) {
          /* a broken observer must not break the engine */
        }
      }
    }

    // -------------------------------------------------------------- render
    function renderFrame(result) {
      syncDom(result.changed);
      if (result.mode !== 'same') {
        lastChangeAt = Date.now();
        if (follow) scrollToBottom();
      }
      maybeTrim();
      updateJump();
      updateStatus();
    }

    function applyScreenFrame(frame) {
      if (selecting) {
        pendingFrame = frame; // keep only the newest frame; nothing touches the DOM
        updateStatus();
        return;
      }
      // Seeded from scrollback but no screen yet: adopt the frame window in place.
      if (screen.length === 0 && buffer.length > 0) {
        var adopted = null;
        if (endsWith(buffer, frame)) {
          adopted = buffer;
        } else {
          // Tolerant alignment also covers seeds that differ by a line or two. The
          // marker fallback grows the seed and must never be adopted (it would
          // duplicate the screen rows), so only accept results that do not grow it.
          var aligned = merge.alignScrollback(buffer.join('\n'), frame);
          if (aligned.length > 0 && aligned.length <= buffer.length && endsWith(aligned, frame)) {
            adopted = aligned;
          }
        }
        if (adopted) {
          if (adopted !== buffer) adoptSeededBuffer(adopted, frame);
          screen = frame.slice();
          lastChangeAt = Date.now();
          updateStatus();
          return;
        }
      }
      var result = merge.applyFrame({ screen: screen, buffer: buffer }, frame);
      screen = result.screen;
      buffer = result.buffer;
      renderFrame(result);
    }

    function applyPending() {
      if (pendingFrame === null) return;
      var frame = pendingFrame;
      pendingFrame = null;
      applyScreenFrame(frame);
    }

    function mergeScrollback(text) {
      var aligned = merge.alignScrollback(text, screen);
      if (!aligned.length) return;

      if (!screen.length) {
        // Seed history before the first screen arrives; the screen frame adopts it later.
        if (aligned.length > buffer.length) {
          buffer = aligned;
          rebuildDom();
          if (follow) scrollToBottom();
          updateJump();
        }
        return;
      }

      if (!endsWith(aligned, screen)) return;
      if (buffer.length === 0 || !endsWith(aligned, buffer)) {
        // Our buffer is not a prefix-tail of the upstream scrollback: a repaint was
        // already handled by applyFrame, so leave the buffer alone.
        return;
      }
      if (aligned.length > buffer.length) {
        var beforeHeight = scrollEl.scrollHeight;
        buffer = aligned;
        rebuildDom();
        if (follow) {
          scrollToBottom();
        } else {
          var grew = scrollEl.scrollHeight - beforeHeight;
          if (grew > 0) scrollEl.scrollTop += grew;
        }
        maybeTrim();
        updateJump();
      }
    }

    // --------------------------------------------------------------- reads
    function makeController() {
      if (typeof AbortController === 'function') return new AbortController();
      return null;
    }

    function abortController(ctrl) {
      if (ctrl) {
        try {
          ctrl.abort();
        } catch (e) {
          /* already aborted */
        }
      }
    }

    function readScreenOnce() {
      if (screenInFlight) return screenInFlight;
      if (destroyed || !paneId || !active) return Promise.resolve();

      var g = gen;
      var pid = paneId;
      var ctrl = makeController();
      var started = now();
      var timedOut = false;
      screenCtrl = ctrl;

      var timer = setTimeout(function () {
        timedOut = true;
        abortController(ctrl);
      }, READ_TIMEOUT_MS);

      var settle;
      var promise = new Promise(function (resolve) {
        settle = resolve;
      });
      screenInFlight = promise;

      function done(res, err) {
        clearTimeout(timer);
        if (screenInFlight === promise) screenInFlight = null;
        if (screenCtrl === ctrl) screenCtrl = null;
        try {
          if (destroyed || g !== gen || pid !== paneId) return; // stale generation
          if (!active) return; // paused while in flight
          lastReadMs = Math.max(0, Math.round(now() - started));

          var failed = !!err || !res || res.ok === false;
          if (failed) {
            errors += 1;
            errStreak += 1;
            if (err) {
              lastError = timedOut
                ? 'timeout after ' + READ_TIMEOUT_MS + ' ms'
                : err.name === 'AbortError'
                  ? 'request aborted'
                  : err.message || String(err);
            } else {
              lastError = String((res && (res.error || (res.status && 'HTTP ' + res.status))) || 'read failed');
            }
            mode = 'error';
            updateStatus();
            emit();
            var backoff = BACKOFF_MS[Math.min(errStreak - 1, BACKOFF_MS.length - 1)];
            scheduleScreen(backoff);
            return;
          }

          errStreak = 0;
          lastError = '';
          mode = 'live';
          updates += 1;
          readStamps.push(now());

          var text = res && res.text != null ? res.text : '';
          var frame = text === '' ? [] : merge.splitText(text);
          applyScreenFrame(frame);
          emit();
          scheduleScreen(idleNow() ? settings.idleMs : settings.intervalMs);
        } finally {
          settle();
        }
      }

      var call;
      try {
        call = Promise.resolve(opts.readScreen(pid, ctrl ? ctrl.signal : undefined));
      } catch (e) {
        call = Promise.reject(e);
      }
      call.then(
        function (res) {
          done(res, null);
        },
        function (err) {
          done(null, err);
        }
      );

      return promise;
    }

    function scheduleScreen(delay) {
      if (destroyed || !active || !paneId) return;
      if (screenTimer !== null) clearTimeout(screenTimer);
      screenTimer = setTimeout(function () {
        screenTimer = null;
        readScreenOnce();
      }, Math.max(0, delay));
    }

    function readScrollbackOnce() {
      if (scrollInFlight) return;
      if (destroyed || !paneId || !active) return;

      var g = gen;
      var pid = paneId;
      var ctrl = makeController();
      var timedOut = false;
      var token = {};
      scrollCtrl = ctrl;
      scrollInFlight = token;

      var timer = setTimeout(function () {
        timedOut = true;
        abortController(ctrl);
      }, READ_TIMEOUT_MS);

      function done(res, err) {
        clearTimeout(timer);
        if (scrollInFlight === token) scrollInFlight = false;
        if (scrollCtrl === ctrl) scrollCtrl = null;
        if (destroyed || g !== gen || pid !== paneId || !active) return;
        if (err || !res || res.ok === false) {
          // The screen loop owns the status line; scrollback just retries quietly.
          scheduleScroll(2000);
          return;
        }
        var text = res.text != null ? res.text : '';
        if (text) mergeScrollback(text);
        updateStatus();
        scheduleScroll(SCROLLBACK_INTERVAL_MS);
      }

      var call;
      try {
        call = Promise.resolve(opts.readScrollback(pid, settings.scrollbackLines, ctrl ? ctrl.signal : undefined));
      } catch (e) {
        call = Promise.reject(e);
      }
      call.then(
        function (res) {
          done(res, null);
        },
        function (err) {
          done(null, err);
        }
      );
    }

    function scheduleScroll(delay) {
      if (destroyed || !active || !paneId) return;
      if (scrollTimer !== null) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function () {
        scrollTimer = null;
        readScrollbackOnce();
      }, Math.max(0, delay));
    }

    function stopTimers() {
      if (screenTimer !== null) {
        clearTimeout(screenTimer);
        screenTimer = null;
      }
      if (scrollTimer !== null) {
        clearTimeout(scrollTimer);
        scrollTimer = null;
      }
    }

    function abortReads() {
      abortController(screenCtrl);
      abortController(scrollCtrl);
      screenCtrl = null;
      scrollCtrl = null;
      screenInFlight = null;
      scrollInFlight = false;
    }

    // ------------------------------------------------------------ selection
    function selectionHitsHost() {
      var sel = typeof document.getSelection === 'function' ? document.getSelection() : null;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
      var hostRect = host.getBoundingClientRect();
      for (var i = 0; i < sel.rangeCount; i += 1) {
        var rect = sel.getRangeAt(i).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.bottom >= hostRect.top && rect.top <= hostRect.bottom &&
            rect.right >= hostRect.left && rect.left <= hostRect.right) {
          return true;
        }
      }
      return false;
    }

    function onSelectionChange() {
      if (destroyed) return;
      var next = selectionHitsHost();
      if (next === selecting) return;
      selecting = next;
      if (!selecting) applyPending();
      updateStatus();
      emit();
    }

    // ------------------------------------------------------------- events
    function onScroll() {
      if (destroyed) return;
      var near = isNearBottom();
      if (near && !follow) {
        follow = true;
        followAnchor = buffer.length;
      } else if (!near && follow) {
        follow = false;
        followAnchor = buffer.length;
      }
      updateJump();
    }

    function onJump() {
      setFollow(true);
    }

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    jumpEl.addEventListener('click', onJump);
    document.addEventListener('selectionchange', onSelectionChange);

    // --------------------------------------------------------------- API
    function setPane(nextPaneId) {
      if (destroyed) return;
      paneId = nextPaneId === null || nextPaneId === undefined ? null : String(nextPaneId);
      gen += 1;
      stopTimers();
      abortReads();

      screen = [];
      buffer = [];
      rows = [];
      pendingFrame = null;
      selecting = false;
      follow = true;
      followAnchor = 0;
      lastReadMs = 0;
      errStreak = 0;
      lastError = '';
      mode = paneId ? 'live' : 'idle';
      lastChangeAt = Date.now();
      readStamps = [];

      listEl.innerHTML = '';
      updateJump();
      updateStatus();
      emit();

      if (paneId && active) {
        readScreenOnce();
        readScrollbackOnce();
      }
    }

    function setActive(nextActive) {
      if (destroyed) return;
      var want = !!nextActive;
      if (want === active) return;
      active = want;
      if (!active) {
        stopTimers();
        abortReads();
        updateStatus();
        emit();
        return;
      }
      updateStatus();
      emit();
      if (paneId) {
        readScreenOnce();
        readScrollbackOnce();
      }
    }

    function setFollow(nextFollow) {
      if (destroyed) return;
      follow = !!nextFollow;
      if (follow) {
        followAnchor = buffer.length;
        scrollToBottom();
      } else {
        followAnchor = buffer.length;
      }
      updateJump();
      emit();
    }

    function refresh() {
      if (destroyed || !paneId || !active) return Promise.resolve();
      return readScreenOnce();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      gen += 1;
      stopTimers();
      abortReads();
      scrollEl.removeEventListener('scroll', onScroll);
      jumpEl.removeEventListener('click', onJump);
      document.removeEventListener('selectionchange', onSelectionChange);
      host.innerHTML = '';
      host.classList.remove('hd-term-host');
      rows = [];
      buffer = [];
      screen = [];
      updateStatus();
    }

    updateStatus();

    return {
      setPane: setPane,
      setActive: setActive,
      setFollow: setFollow,
      refresh: refresh,
      destroy: destroy,
      state: state
    };
  }

  HD.terminal = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
