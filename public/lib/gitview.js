/* herdr-dash — gitview.js · read-only "what did the agents change" (§7.2, owner: W3)
 *
 * A classic script (§3): it registers itself with window.HD.register and builds its own root
 * on document.body. Nothing here writes anywhere: the only network call is GET /api/git, whose
 * subcommand table lives in src/server.js and accepts no caller-supplied command at all — the
 * one caller-influenced value is a repo-relative path, and the panel never invents one (it only
 * passes back paths the server itself listed). The header says "read-only" out loud.
 *
 * Failure handling follows the v1 rule "every failure is visible in the panel that failed":
 * there is no path in this file that can throw outward, and no path that renders an empty list
 * where the truth is "I could not look" or "this cwd is not a repo".
 *
 * Data access: ctx.api.git({pane_id, mode, file, max_lines}) when app.js published it, else a
 * plain fetch('/api/git?…') fallback — §3's "a missing helper must not break the page".
 *
 * Pure helpers (status letters, totals line, truncation note, diff line classes, the API
 * resolution) are published on window.HD.gitviewTest for _scratch/w3/logic.mjs.
 */
(function () {
  'use strict';

  var HD = (window.HD = window.HD || {});
  var ID = 'gitview';
  var TITLE = 'Changes';

  var POLL_MS = 5000;        // status re-read while the panel is visible; nothing when hidden
  var DIFF_MAX = 400;        // §7.1's default
  var DIFF_MAX_HARD = 2000;  // §7.1's hard cap — never ask for more than the server allows
  var EMPTY = '—';           // shown where the server sent null (e.g. a repo with no commits yet)

  // ── pure helpers ───────────────────────────────────────────────────────────

  /** §7.1 `max_lines`: integer, 1..2000, default 400. Never returns something the server would reject. */
  function clampMaxLines(raw) {
    if (raw === null || raw === undefined || raw === '') return DIFF_MAX;
    var n = parseInt(raw, 10);
    if (!isFinite(n)) return DIFF_MAX;
    return Math.min(DIFF_MAX_HARD, Math.max(1, n));
  }

  /** The one-letter status the server sends ('M','A','D','R','C','?') as a word for the row. */
  function statusWord(status) {
    var s = status == null ? '' : String(status).toUpperCase();
    if (s === '?' || s === 'U') return s === 'U' ? 'conflicted' : 'untracked';
    switch (s.charAt(0)) {
      case 'M': return 'modified';
      case 'A': return 'added';
      case 'D': return 'deleted';
      case 'R': return 'renamed';
      case 'C': return 'copied';
      case 'T': return 'typechange';
      default: return s ? 'changed' : 'unknown';
    }
  }

  /** The CSS class for a row/chip: never returns anything but a fixed set of words. */
  function statusKind(status) {
    var s = status == null ? '' : String(status).toUpperCase();
    if (s === '?') return 'untracked';
    if (s === 'U' || s === 'UU' || s === 'AA') return 'conflict';
    switch (s.charAt(0)) {
      case 'M': return 'modified';
      case 'A': return 'added';
      case 'D': return 'deleted';
      case 'R': return 'renamed';
      case 'C': return 'renamed';
      default: return 'unknown';
    }
  }

  /** '+4 −1' — the server's own numstat numbers; untracked files have none (git has no diff for them). */
  function countsText(file) {
    if (!file) return '';
    var a = parseInt(file.added, 10), d = parseInt(file.deleted, 10);
    if (!isFinite(a)) a = 0;
    if (!isFinite(d)) d = 0;
    if (file.untracked || (a === 0 && d === 0)) return file.untracked ? 'new' : '+0 −0';
    return '+' + a + ' −' + d;
  }

  /** §7.2's totals row: 'N changed · M untracked · +I −D'. Reads the server's totals verbatim. */
  function totalsText(totals) {
    var t = totals || {};
    var n = function (v) { var x = parseInt(v, 10); return isFinite(x) ? x : 0; };
    // NB: the server's `changed` counts EVERY row it listed, untracked files included (that is how
    // src/server.js computes it: files.length). We show its number as sent rather than recomputing
    // a different one here — the tooltip on the totals says so.
    return n(t.changed) + ' changed · ' + n(t.untracked) + ' untracked · +' + n(t.insertions) + ' −' + n(t.deletions);
  }

  /** 'D:/Development/Example · main · abc1234 subject' — nulls are shown, never hidden. */
  function repoText(repo) {
    var r = repo || {};
    var parts = [r.toplevel || null, r.branch || null, r.head || null];
    var out = [];
    for (var i = 0; i < parts.length; i++) out.push(parts[i] == null || parts[i] === '' ? EMPTY : String(parts[i]));
    return out.join(' · ');
  }

  /**
   * The banner for a response that is a *described state* rather than a file list: a cwd that is
   * not a repo, a missing git, a transport failure, or no pane at all. Returns null when the
   * response is a normal repo body. §7.2: "never an empty list".
   */
  function bannerFor(res) {
    if (!res) return { kind: 'error', text: 'no response from /api/git' };
    var err = res.error || null;
    var code = err && err.code ? String(err.code) : '';
    var msg = err && err.message ? String(err.message) : '';
    var cwd = res.cwd ? String(res.cwd) : '';
    if (code === 'no_pane') {
      return { kind: 'info', text: 'no pane selected — pick a pane (or click one) and its repo shows up here' };
    }
    if (res.ok === false) {
      return { kind: 'error', text: 'git view failed' + (code ? ' · ' + code : '') + (msg ? ' · ' + msg : '') };
    }
    if (res.is_repo === false) {
      if (code === 'git_missing') {
        return { kind: 'error', text: 'git is not available · ' + (msg || 'could not run git') };
      }
      if (code === 'git_failed') {
        return { kind: 'error', text: 'git could not be read' + (cwd ? ' in ' + cwd : '') + ' · ' + (msg || 'unknown failure') };
      }
      // not_a_repo (or anything else that says is_repo:false): name the cwd AND git's own message
      return { kind: 'info', text: 'not a git repository · ' + (cwd || 'unknown cwd') + (msg ? ' · ' + msg : '') };
    }
    return null;
  }

  /** Normalise the file list: one row per path, sorted, with everything the body needs precomputed. */
  function fileRows(res) {
    var files = (res && Array.isArray(res.files)) ? res.files.slice() : [];
    files.sort(function (a, b) {
      var pa = (a && a.path) || '', pb = (b && b.path) || '';
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
    var out = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i] || {};
      out.push({
        path: String(f.path == null ? '' : f.path),
        letter: f.status == null || f.status === '' ? '?' : String(f.status),
        word: statusWord(f.status),
        kind: statusKind(f.status),
        untracked: !!f.untracked,
        staged: !!f.staged,
        unstaged: !!f.unstaged,
        added: parseInt(f.added, 10) || 0,
        deleted: parseInt(f.deleted, 10) || 0,
        counts: countsText(f),
      });
    }
    return out;
  }

  /** Diff text -> lines, with each line's CSS class. No line is dropped, including the last one. */
  function diffLines(text) {
    if (text == null || text === '') return [];
    var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
  function diffLineClass(line) {
    var s = line == null ? '' : String(line);
    if (s.indexOf('@@') === 0) return 'hunk';
    if (s.indexOf('+++') === 0 || s.indexOf('---') === 0) return 'meta';
    if (s.indexOf('diff ') === 0 || s.indexOf('index ') === 0 || s.indexOf('new file') === 0 ||
        s.indexOf('deleted file') === 0 || s.indexOf('similarity index') === 0 || s.indexOf('rename ') === 0) return 'meta';
    if (s.charAt(0) === '+') return 'add';
    if (s.charAt(0) === '-') return 'del';
    return '';
  }

  /** §7.2: the visible note when the server says it cut the diff. N is what we asked for. */
  function truncNote(res, maxLines) {
    if (!res || !res.truncated) return '';
    return 'truncated at ' + clampMaxLines(maxLines) + ' lines';
  }

  /**
   * The other truncation: in status mode `truncated` is the server's own capture cap on the file
   * LIST (no line count was ever requested there), so it is a different sentence in a different
   * place and must not name an N. Kept separate because the response carries no `mode` field to
   * branch on — the call site is the only thing that knows which read it made.
   */
  function statusTruncNote(res) {
    if (!res || !res.truncated) return '';
    return 'this listing is incomplete — the server hit its own output cap while reading the repo';
  }

  /**
   * §7.1 errata 2: an empty diff pane must never be blank. Prefers the endpoint's own
   * `diff_available` / `no_diff_reason`; when those are absent (W1 may land after this module)
   * it falls back to what THIS CLIENT already knows: the row the user clicked, whose
   * `untracked` flag comes from the same status read that drew the list. `row` is that row.
   */
  function emptyDiffNote(res, row) {
    if (!res) return '';
    if (res.diff) return '';                                  // there is content: show it, say nothing
    var token = res.no_diff_reason ? String(res.no_diff_reason)
      : ((row && row.untracked) ? 'untracked' : '');
    if (token === 'untracked') {
      return 'untracked file — git cannot diff it (the read-only whitelist has no --no-index), so its content is not shown here';
    }
    if (token === 'binary') return 'binary file — git has no text diff for it, so its content is not shown here';
    if (token) return 'git has no diff for this file (' + token + ') — its content is not shown here';
    if (res.diff_available === true) {
      return 'the server reported a diff for this file but sent none — try Refresh; if it stays empty the file changed since the list was drawn';
    }
    return 'git printed no diff for this file — it may be staged elsewhere, binary, or already committed';
  }

  /** The query string /api/git needs, in §7.1's spelling. */
  function gitUrl(opts) {
    var o = opts || {};
    var q = ['pane_id=' + encodeURIComponent(o.pane_id)];
    if (o.mode) q.push('mode=' + encodeURIComponent(o.mode));
    if (o.file) q.push('file=' + encodeURIComponent(o.file));
    if (o.max_lines !== undefined && o.max_lines !== null) q.push('max_lines=' + encodeURIComponent(clampMaxLines(o.max_lines)));
    return '/api/git?' + q.join('&');
  }

  /**
   * Resolve the §7.1 reader: ctx.api.git (app.js) when it exists, else fetch('/api/git?…').
   * §3: a missing helper must not break the page. Always resolves — a failure comes back as
   * {ok:false, error:{code, message}} so the caller can render it instead of catching it.
   */
  function makeGit(ctx, fetchImpl) {
    var fn = ctx && ctx.api && ctx.api.git;
    if (typeof fn === 'function') {
      return function (opts) {
        var failed = function (e) { return { ok: false, error: { code: 'api_failed', message: msgOf(e) } }; };
        try { return Promise.resolve(fn(opts)).then(null, failed); }   // a helper that rejects is a failure too
        catch (e) { return Promise.resolve(failed(e)); }
      };
    }
    var f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) {
      return function () {
        return Promise.resolve({ ok: false, error: { code: 'no_reader',
          message: 'neither ctx.api.git nor window.fetch is available — cannot reach /api/git' } });
      };
    }
    return function (opts) {
      if (!opts || !opts.pane_id) {
        return Promise.resolve({ ok: false, error: { code: 'no_pane', message: 'no pane selected — /api/git needs a pane_id' } });
      }
      var url = gitUrl(opts);
      return Promise.resolve()
        .then(function () { return f(url, { headers: { accept: 'application/json' } }); })
        .then(function (r) {
          if (!r || typeof r.json !== 'function') {
            return { ok: false, error: { code: 'fetch_failed', message: 'the server did not answer with JSON' } };
          }
          if (r.ok === false) {
            return { ok: false, error: { code: 'http_' + (r.status == null ? '?' : r.status),
              message: 'GET ' + url + ' answered HTTP ' + r.status } };
          }
          return Promise.resolve(r.json()).then(function (body) {
            if (!body || typeof body !== 'object') {
              return { ok: false, error: { code: 'fetch_failed', message: 'GET ' + url + ' answered no JSON object' } };
            }
            return body;
          });
        })
        .catch(function (e) { return { ok: false, error: { code: 'fetch_failed', message: msgOf(e) + ' (' + url + ')' } }; });
    };
  }

  function msgOf(e) { return e && e.message ? String(e.message) : String(e); }

  /** The pane whose repo we show: the live selection, read at call time (never cached across mounts). */
  function currentPaneId(ctx) {
    try {
      var id = ctx && ctx.state ? ctx.state.selectedPaneId : null;
      return (id === undefined || id === null || id === '') ? null : String(id);
    } catch (e) { return null; }
  }

  function testApi() {
    return {
      clampMaxLines: clampMaxLines, statusWord: statusWord, statusKind: statusKind,
      countsText: countsText, totalsText: totalsText, repoText: repoText,
      bannerFor: bannerFor, fileRows: fileRows, diffLines: diffLines,
      diffLineClass: diffLineClass, truncNote: truncNote, statusTruncNote: statusTruncNote,
      emptyDiffNote: emptyDiffNote,
      gitUrl: gitUrl, makeGit: makeGit, currentPaneId: currentPaneId,
      POLL_MS: POLL_MS, DIFF_MAX: DIFF_MAX, DIFF_MAX_HARD: DIFF_MAX_HARD,
    };
  }

  // ── module ─────────────────────────────────────────────────────────────────

  function mount(ctx) {
    if (!ctx || !ctx.events) return null;
    // §3: nothing here may assume a browser. The module loads and registers without a document
    // (see _scratch/w3/logic.mjs); only mounting needs one, so that is where this lives.
    if (typeof document === 'undefined' || !document.body) return null;
    var cleanupFns = [];
    // ctx.api.git, else fetch. Re-resolved per call on purpose: §3's helper may appear after
    // this module mounted, and a late helper must still be preferred over the fetch fallback.
    var read = function (opts) { return makeGit(ctx)(opts); };

    var root = document.createElement('div');
    root.className = 'hd-gv';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', TITLE);

    var head = document.createElement('div');
    head.className = 'hd-gv-head';
    var h = document.createElement('span');
    h.className = 'hd-mod-title';
    h.textContent = TITLE;
    var ro = document.createElement('span');
    ro.className = 'hd-gv-ro';
    ro.textContent = 'read-only';
    ro.title = 'this panel only ever runs git reads (status/diff) — nothing here can change your repo';
    var paneEl = document.createElement('span');
    paneEl.className = 'hd-gv-pane mono';
    var totalsEl = document.createElement('span');
    totalsEl.className = 'hd-gv-totals small dim';
    var hint = document.createElement('span');
    hint.className = 'hd-gv-hint small dim';
    hint.textContent = 'click a file for its diff · Esc closes · refreshes every ' + Math.round(POLL_MS / 1000) + ' s while open';
    var refresh = document.createElement('button');
    refresh.className = 'btn small';
    refresh.type = 'button';
    refresh.textContent = 'Refresh';
    refresh.title = 're-read git status and the open diff';
    var close = document.createElement('button');
    close.className = 'icon-btn';
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'close (Esc)';
    head.appendChild(h); head.appendChild(ro); head.appendChild(paneEl); head.appendChild(totalsEl);
    head.appendChild(hint); head.appendChild(refresh); head.appendChild(close);

    var meta = document.createElement('div');
    meta.className = 'hd-gv-meta small dim';

    var errBar = document.createElement('div');
    errBar.className = 'err hd-gv-err';
    errBar.hidden = true;

    var banner = document.createElement('div');
    banner.className = 'hd-gv-banner';
    banner.hidden = true;

    var body = document.createElement('div');
    body.className = 'hd-gv-body';
    var listWrap = document.createElement('div');
    listWrap.className = 'hd-gv-list';
    var diffWrap = document.createElement('div');
    diffWrap.className = 'hd-gv-diffwrap';
    var diffHead = document.createElement('div');
    diffHead.className = 'hd-gv-diffhead small dim';
    var diffNote = document.createElement('div');
    diffNote.className = 'hd-gv-note small';
    diffNote.hidden = true;
    var diffPre = document.createElement('pre');
    diffPre.className = 'hd-gv-diff mono';
    diffWrap.appendChild(diffHead); diffWrap.appendChild(diffNote); diffWrap.appendChild(diffPre);
    body.appendChild(listWrap); body.appendChild(diffWrap);

    root.appendChild(head); root.appendChild(meta); root.appendChild(errBar);
    root.appendChild(banner); root.appendChild(body);

    var state = {
      open: false,
      paneId: null,        // the pane the currently rendered data came from
      status: null,        // the last good status body
      rows: [],
      selected: null,      // repo-relative path whose diff is shown
      diff: null,
      diffMax: DIFF_MAX,
      // in-flight read generations: a slow read must never paint over a newer one (a 230-file
      // repo can answer slower than the user switches panes or clicks a second file)
      statusSeq: 0,
      diffSeq: 0,
      timer: null,
      err: '', errRec: null,
    };

    function msg(e) { return e && e.message ? String(e.message) : String(e); }

    /**
     * The single writer of the message bar, with the same §7.3 policy grid.js learned: a fix for
     * "a periodic tick wipes a message nobody read" must not be re-introduced by the module that
     * polls next to it. `force` = a user action; `sticky` = a refusal that must outlive ticks.
     */
    var ERR_MIN_MS = 3000, ERR_STICKY_MS = 15000;
    function errVerdict(cur, next, now) {
      var want = next && next.text != null ? String(next.text) : '';
      if (!cur || !cur.text) return { text: want, keep: false };
      if (next && next.force) return { text: want, keep: false };
      if (want) return { text: want, keep: false };
      if (cur.sticky && now < cur.stickyUntil) return { text: cur.text, keep: true };
      if (now < cur.until) return { text: cur.text, keep: true };
      return { text: '', keep: false };
    }
    function showErr(text, opts) {
      try {
        var now = Date.now();
        var v = errVerdict(state.errRec, {
          text: text == null ? '' : text, force: !!(opts && opts.force), sticky: !!(opts && opts.sticky),
        }, now);
        if (v.keep) return;
        var sticky = !!v.text && !!(opts && opts.sticky);
        state.errRec = v.text ? { text: v.text, until: now + ERR_MIN_MS, sticky: sticky,
                                  stickyUntil: sticky ? now + ERR_STICKY_MS : 0 } : null;
        state.err = v.text;
        errBar.textContent = v.text;
        errBar.hidden = !v.text;
      } catch (e) { /* the bar is cosmetic; never let it throw outward */ }
    }

    /** A described state (not a repo, git missing, no pane) gets the banner; a clean repo gets none. */
    function setBanner(b, force) {
      try {
        if (!b) { banner.hidden = true; banner.textContent = ''; banner.className = 'hd-gv-banner'; return; }
        if (!force && !banner.hidden && banner.getAttribute('data-kind') === b.kind &&
            banner.textContent === b.text) return;
        banner.className = 'hd-gv-banner ' + (b.kind === 'error' ? 'bad' : 'info');
        banner.setAttribute('data-kind', b.kind);
        banner.textContent = b.text;
        banner.hidden = false;
      } catch (e) { /* cosmetic */ }
    }

    function renderHeader() {
      try {
        var res = state.status;
        var paneId = state.paneId || currentPaneId(ctx) || '';
        paneEl.textContent = paneId ? 'pane ' + paneId : 'pane —';
        if (!res) { totalsEl.textContent = ''; meta.textContent = ''; return; }
        totalsEl.textContent = totalsText(res.totals);
        totalsEl.title = 'changed counts every row git listed, untracked files included (as /api/git reports it)';
        var repo = res.repo || {};
        meta.textContent = [
          'cwd ' + (res.cwd || EMPTY),
          'toplevel ' + (repo.toplevel || EMPTY),
          'branch ' + (repo.branch || EMPTY),
          'HEAD ' + (repo.head || EMPTY),
        ].join(' · ');
      } catch (e) { showErr('header render failed: ' + msg(e)); }
    }

    function renderList() {
      try {
        listWrap.textContent = '';
        var res = state.status;
        if (!res) {                                     // before the first answer: say so, do not guess
          var waiting = document.createElement('div');
          waiting.className = 'hd-gv-waiting dim';
          waiting.textContent = 'reading git status…';
          listWrap.appendChild(waiting);
          return;
        }
        var b = bannerFor(res);
        if (b) return;                                  // the banner IS the body when we cannot list
        // §7.1: a truncated status listing is an incomplete row set, and that belongs next to
        // the list — not in the diff pane, which is where it used to end up by accident.
        var listNote = statusTruncNote(res);
        var rows = state.rows;
        if (!rows.length) {
          var clean = document.createElement('div');
          clean.className = 'hd-empty dim';
          clean.textContent = 'nothing changed here — ' + ((res && res.repo && res.repo.toplevel) || (res && res.cwd) || 'this repo') +
            ' has a clean working tree';
          listWrap.appendChild(clean);
          if (listNote) appendListNote(listNote);
          return;
        }
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var row = document.createElement('div');
          row.className = 'hd-gv-row' + (state.selected === r.path ? ' on' : '') + ' kind-' + r.kind;
          row.setAttribute('data-path', r.path);
          row.title = r.word + (r.staged ? ' · staged' : '') + (r.unstaged ? ' · unstaged' : '') + ' · ' + r.path;
          var letter = document.createElement('span');
          letter.className = 'hd-gv-letter mono kind-' + r.kind;
          letter.textContent = r.letter;
          var p = document.createElement('span');
          p.className = 'hd-gv-path mono';
          p.textContent = r.path;
          var c = document.createElement('span');
          c.className = 'hd-gv-counts mono small';
          c.textContent = r.counts;
          row.appendChild(letter); row.appendChild(p); row.appendChild(c);
          row.addEventListener('click', function (path) { return function () { selectFile(path); }; }(r.path));
          listWrap.appendChild(row);
        }
        if (listNote) appendListNote(listNote);
      } catch (e) { showErr('file list render failed: ' + msg(e)); }
    }

    /** One line at the foot of the list, in the already-styled note class. */
    function appendListNote(text) {
      var el = document.createElement('div');
      el.className = 'hd-gv-note small warn';
      el.textContent = text;
      listWrap.appendChild(el);
    }

    function renderDiff() {
      try {
        diffPre.textContent = '';
        var res = state.diff;
        if (!state.selected) {
          diffHead.textContent = 'no file selected — click a file on the left to see its diff';
          diffNote.hidden = true;
          return;
        }
        if (!res) {
          diffHead.textContent = state.selected;
          diffNote.hidden = true;
          return;
        }
        if (res.ok === false || res.error) {
          diffHead.textContent = state.selected;
          diffNote.textContent = 'diff not available · ' + ((res.error && (res.error.message || res.error.code)) || 'unknown error');
          diffNote.className = 'hd-gv-note small bad';
          diffNote.hidden = false;
          return;
        }
        var row = null;
        for (var i = 0; i < state.rows.length; i++) if (state.rows[i].path === state.selected) row = state.rows[i];
        diffHead.textContent = state.selected + (row ? ' · ' + row.word + ' · ' + row.counts : '');
        var lines = diffLines(res.diff);
        for (var j = 0; j < lines.length; j++) {
          var span = document.createElement('span');
          var cls = diffLineClass(lines[j]);
          span.className = 'hd-gv-line' + (cls ? ' ' + cls : '');
          span.textContent = lines[j] + '\n';
          diffPre.appendChild(span);
        }
        var note = truncNote(res, state.diffMax) || emptyDiffNote(res, row);
        diffNote.className = 'hd-gv-note small' + (res.truncated ? ' warn' : '');
        diffNote.textContent = note;
        diffNote.hidden = !note;
      } catch (e) { showErr('diff render failed: ' + msg(e)); }
    }

    function render() { renderHeader(); renderList(); renderDiff(); }

    // ── reads ────────────────────────────────────────────────────────────────
    /** A status read. Resolves to the body (or null) so callers can chain the diff read. */
    function readStatus(paneId, opts) {
      var force = !!(opts && opts.force);
      var seq = ++state.statusSeq;
      function stale() {
        if (seq !== state.statusSeq) return true;              // a newer read superseded this one
        return String(currentPaneId(ctx) || '') !== String(paneId);  // the user moved on
      }
      return Promise.resolve()
        .then(function () { return read({ pane_id: paneId, mode: 'status' }); })
        .then(function (res) {
          if (stale()) return null;                            // drop it: never paint another pane's files
          if (!res || res.ok === false) {
            var e = (res && res.error) || {};
            state.status = null; state.rows = [];
            setBanner(bannerFor(res || { ok: false, error: { code: 'no_response', message: 'no response' } }));
            showErr('git status failed' + (e.code ? ' · ' + e.code : '') + (e.message ? ' · ' + e.message : ''),
              { force: force });
            render();
            return null;
          }
          state.status = res;
          state.rows = fileRows(res);
          setBanner(bannerFor(res));
          if (!force) showErr('', {});
          render();
          return res;
        })
        .catch(function (e) {
          if (stale()) return null;                            // an old failure is not this pane's news
          setBanner({ kind: 'error', text: 'git status failed · ' + msg(e) });
          showErr('git status failed: ' + msg(e), { force: force });
          return null;
        });
    }

    function readDiff(paneId, path, maxLines) {
      state.diffMax = clampMaxLines(maxLines);
      var seq = ++state.diffSeq;
      function stale() {
        if (seq !== state.diffSeq) return true;                // a newer click won
        return state.selected !== path || String(currentPaneId(ctx) || '') !== String(paneId);
      }
      return Promise.resolve()
        .then(function () { return read({ pane_id: paneId, mode: 'diff', file: path, max_lines: state.diffMax }); })
        .then(function (res) {
          if (stale()) return false;                           // never show file A's diff under file B
          if (!res || res.ok === false) {
            state.diff = res || { ok: false, error: { code: 'no_response', message: 'no response' } };
            renderDiff();
            return false;
          }
          state.diff = res;
          renderDiff();
          return true;
        })
        .catch(function (e) {
          if (stale()) return false;
          state.diff = { ok: false, error: { code: 'read_failed', message: msg(e) } };
          renderDiff();
          return false;
        });
    }

    function selectFile(path) {
      try {
        state.selected = path == null ? null : String(path);
        state.diff = null;
        renderList(); renderDiff();
        var paneId = state.paneId;
        if (paneId) readDiff(paneId, state.selected, DIFF_MAX);
      } catch (e) { showErr('selecting a file failed: ' + msg(e)); }
    }

    /**
     * One refresh: read the status for the currently selected pane, and re-read the open diff
     * when its file changed on disk (same row text) — polling that re-fetches an unchanged diff
     * every 5 s would be noise, and polling is only cheap if it stays proportional.
     */
    function refreshNow(opts) {
      try {
        var paneId = currentPaneId(ctx);
        if (!paneId) {
          state.paneId = null; state.status = null; state.rows = []; state.selected = null; state.diff = null;
          setBanner(bannerFor({ ok: true, is_repo: false, error: { code: 'no_pane' } }), true);
          render();
          return Promise.resolve(false);
        }
        var before = null;
        for (var i = 0; i < state.rows.length; i++) if (state.rows[i].path === state.selected) before = state.rows[i];
        var paneChanged = state.paneId !== paneId;
        if (paneChanged) { state.selected = null; state.diff = null; }
        state.paneId = paneId;
        return readStatus(paneId, opts).then(function (res) {
          if (!res) return false;
          var after = null;
          for (var j = 0; j < state.rows.length; j++) if (state.rows[j].path === state.selected) after = state.rows[j];
          if (!state.selected) return true;
          if (paneChanged || !after || !before || after.counts !== before.counts || after.letter !== before.letter) {
            return readDiff(paneId, state.selected, state.diffMax);
          }
          return true;
        });
      } catch (e) {
        showErr('refresh failed: ' + msg(e));
        return Promise.resolve(false);
      }
    }

    function tick() {
      if (!state.open) return;
      try { if (document.hidden) return; } catch (e) { /* no document.hidden: keep polling */ }
      refreshNow({});
    }

    // ── visibility ───────────────────────────────────────────────────────────
    function show() {
      if (state.open) return;
      state.open = true;
      root.hidden = false;
      showErr('', { force: true });          // opening the panel is a user action on it
      render();
      if (!state.timer) state.timer = setInterval(tick, POLL_MS);
      refreshNow({ force: true });
    }
    function hide() {
      if (!state.open) return;
      state.open = false;
      root.hidden = true;
      if (state.timer) { clearInterval(state.timer); state.timer = null; }   // §3: stop when hidden
    }
    function toggle() { state.open ? hide() : show(); }

    // ── wiring ───────────────────────────────────────────────────────────────
    var off = [];
    function on(type, fn) {
      try {
        var u = ctx.events.on(type, function (p) {
          try { fn(p); } catch (e) { showErr(type + ': ' + msg(e)); }
        });
        if (typeof u === 'function') off.push(u);
      } catch (e) { showErr('subscribe ' + type + ' failed: ' + msg(e)); }
    }
    on('select', function () { if (state.open) refreshNow({}); });         // follow the selected pane live
    on('module.toggle', function (p) { if (p === ID || (p && p.id === ID)) toggle(); });
    on('gitview.toggle', toggle);
    on('gitview.refresh', function () { refreshNow({ force: true }); });

    refresh.addEventListener('click', function (e) {
      e.stopPropagation();
      refreshNow({ force: true });        // a user action: it may clear a stale message
    });
    close.addEventListener('click', function () { hide(); });
    document.addEventListener('keydown', function (e) {
      if (!state.open) return;
      if (e.key !== 'Escape') return;
      var t = e.target;
      var tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      e.preventDefault(); e.stopImmediatePropagation();   // beat W2's "Esc sends esc to the pane"
      hide();
    }, true);

    // §3: every shortcut must reach W2's `?` help overlay.
    registerKeys(ctx, ID, [['Esc', 'gitview: close']], 'read-only "what did the agents change" panel');

    document.body.appendChild(root);
    render();

    cleanupFns.push(function () {
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      for (var i = 0; i < off.length; i++) { try { off[i](); } catch (e) { /* ignore */ } }
      off.length = 0;
      if (root.parentNode) root.parentNode.removeChild(root);
    });

    return {
      show: show, hide: hide, toggle: toggle, refresh: function () { return refreshNow({ force: true }); },
      selectFile: selectFile,
      paneId: function () { return state.paneId; },
      rows: function () { return state.rows.slice(); },
      selected: function () { return state.selected; },
      diffText: function () { return diffPre.textContent; },
      errorText: function () { return state.err || ''; },
      unmount: function () {
        for (var i = 0; i < cleanupFns.length; i++) { try { cleanupFns[i](); } catch (e) { /* ignore */ } }
        cleanupFns.length = 0;
      },
    };
  }

  /** §3: advertise this module's shortcuts to W2's help overlay. Never fatal. */
  function registerKeys(ctx, id, pairs, help) {
    try {
      if (ctx && ctx.events && typeof ctx.events.emit === 'function') {
        var keys = [];
        for (var i = 0; i < pairs.length; i++) keys.push({ key: pairs[i][0], help: pairs[i][1] });
        ctx.events.emit('keys.register', { id: id, keys: keys, help: help });
      }
    } catch (e) { /* the help overlay is optional */ }
  }

  HD[ID + 'Test'] = testApi();
  register({ id: ID, title: TITLE, mount: mount, test: testApi() });

  // Registration handshake — see board.js for the full note. §3 loads lib/*.js before app.js,
  // so window.HD.register does not exist yet at load time.
  function register(mod) {
    var HDx = (window.HD = window.HD || {});
    HDx.modules = HDx.modules || {};
    HDx.modules[mod.id] = mod;
    HDx.pending = HDx.pending || [];
    if (HDx.pending.indexOf(mod) < 0) HDx.pending.push(mod);
    if (typeof HDx.register === 'function') {
      try { HDx.register(mod); } catch (e) { return false; }
      return true;
    }
    scheduleRegister(mod);
    return false;
  }
  function scheduleRegister(mod) {
    try {
      if (typeof window.addEventListener !== 'function') return;
      var retry = function () {
        if (typeof window.HD.register === 'function') { try { window.HD.register(mod); } catch (e) { /* app.js decides */ } }
      };
      // both, like the other four modules: whichever fires first wins, and a second call is
      // harmless because app.js keeps one entry per id (HD.pending is deduped above).
      window.addEventListener('DOMContentLoaded', retry);
      window.addEventListener('load', retry);
    } catch (e) { /* app.js also drains HD.pending */ }
  }
})();
