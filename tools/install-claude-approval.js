#!/usr/bin/env node
'use strict';
/*
 * tools/install-claude-approval.js - install (or remove) the Claude Code approval hook.
 *
 * WHAT IT DOES
 *   1. copies tools/claude-approval-hook.js to <state dir>/claude-approval-hook.js
 *   2. adds ONE PreToolUse entry to Claude's settings that runs that copy:
 *          { "matcher": ".*", "hooks": [ { "type": "command",
 *              "command": "node \"<absolute path>\"", "timeout": 125 } ] }
 *
 * It only ever touches the entries that run this hook. An existing entry with matcher ".*" is reused
 * and our hook is appended to its list, so a reader keeps one block per matcher; every other hook in
 * the file is copied through unchanged. Nothing here enables a permission bypass: the file's
 * `permissions` section is not read, not written and not defaulted.
 *
 * USAGE
 *   node tools/install-claude-approval.js              install (backs up settings first)
 *   node tools/install-claude-approval.js --dry-run    print the entry that would be written
 *   node tools/install-claude-approval.js --uninstall  remove the entries that run this hook
 *
 * ENVIRONMENT
 *   CLAUDE_SETTINGS_FILE   the settings file to edit (default ~/.claude/settings.json)
 *   HERDR_DASH_HOME        where the hook copy lives (default ~/.herdr-dash)
 *
 * A settings file that is not valid JSON, or whose `hooks.PreToolUse` is not a list, is reported and
 * left exactly as it was: this program never rewrites a file it could not first read as JSON.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_NAME = 'claude-approval-hook.js';
const SOURCE = path.join(__dirname, HOOK_NAME);
const MATCHER = '.*';
const TIMEOUT_SECONDS = 125;

function settingsFile() {
  const override = String(process.env.CLAUDE_SETTINGS_FILE || '').trim();
  return override !== '' ? override : path.join(os.homedir(), '.claude', 'settings.json');
}
function stateDir() {
  const override = String(process.env.HERDR_DASH_HOME || '').trim();
  return override !== '' ? override : path.join(os.homedir(), '.herdr-dash');
}
function installedHookPath() {
  return path.join(stateDir(), HOOK_NAME);
}

/** `node "<absolute path>"` - the command Claude will run. Quoted for paths with spaces. */
function hookCommand(hookPath) {
  return 'node "' + path.resolve(hookPath) + '"';
}
function hookEntry(hookPath) {
  return {
    matcher: MATCHER,
    hooks: [{ type: 'command', command: hookCommand(hookPath), timeout: TIMEOUT_SECONDS }]
  };
}

function isOurHook(hook) {
  return !!hook && typeof hook === 'object' && typeof hook.command === 'string'
    && hook.command.indexOf(HOOK_NAME) >= 0;
}

/**
 * Remove every hook in `list` that runs our file, keeping everything else in place.
 * An entry left with no hooks at all was only ever there for us, so it goes too; an entry that still
 * has other hooks keeps its matcher and those hooks untouched.
 */
function withoutOurs(list) {
  const kept = [];
  let removed = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
      kept.push(entry);
      continue;
    }
    const hooks = entry.hooks.filter(function (hook) {
      if (isOurHook(hook)) { removed += 1; return false; }
      return true;
    });
    if (hooks.length === entry.hooks.length) { kept.push(entry); continue; }
    if (hooks.length === 0) continue;
    kept.push(Object.assign({}, entry, { hooks: hooks }));
  }
  return { list: kept, removed: removed };
}

/** Deep-ish clone through JSON so a merge can never alias the object that was parsed. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * The settings document after this program has had its way with it.
 * Returns { next, changed, removed, added } so the caller can decide whether writing is worth a backup.
 */
function merge(settings, wantInstalled, hookPath) {
  const next = clone(settings);
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) {
    if (next.hooks !== undefined) throw new Error('"hooks" in this settings file is not an object');
    next.hooks = {};
  }
  const current = next.hooks.PreToolUse;
  if (current !== undefined && !Array.isArray(current)) {
    throw new Error('"hooks.PreToolUse" in this settings file is not a list');
  }
  const stripped = withoutOurs(Array.isArray(current) ? current : []);
  let list = stripped.list;
  let added = 0;

  if (wantInstalled) {
    const wanted = hookCommand(hookPath);
    let home = null;
    for (const entry of list) {
      if (entry && entry.matcher === MATCHER && Array.isArray(entry.hooks)) { home = entry; break; }
    }
    if (home) {
      home.hooks = home.hooks.concat([{ type: 'command', command: wanted, timeout: TIMEOUT_SECONDS }]);
    } else {
      list = list.concat([hookEntry(hookPath)]);
    }
    added = 1;
  }

  const before = Array.isArray(current) ? JSON.stringify(current) : '';
  next.hooks.PreToolUse = list;
  const after = JSON.stringify(list);
  return { next: next, changed: before !== after, removed: stripped.removed, added: added };
}

function stamp(date) {
  const d = date || new Date();
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** A copy of the settings file, never overwriting an earlier backup. */
function backupSettings(file) {
  const base = file + '.bak-' + stamp();
  let target = base;
  let n = 1;
  while (fs.existsSync(target)) { n += 1; target = base + '-' + n; }
  fs.copyFileSync(file, target);
  return target;
}

function writeJson(file, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
  fs.writeFileSync(temp, text, 'utf8');
  try {
    fs.renameSync(temp, file);
  } catch (e) {
    fs.writeFileSync(file, text, 'utf8');
    try { fs.unlinkSync(temp); } catch (e2) { /* already gone */ }
    return;
  }
}

function usage() {
  return [
    'usage: node tools/install-claude-approval.js [--dry-run | --uninstall | --help]',
    '',
    '  (no flag)    copy the hook into ' + stateDir() + ' and add it to ' + settingsFile(),
    '  --dry-run    print the entry that would be written, change nothing',
    '  --uninstall  remove the entries that run this hook'
  ].join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const dryRun = args.indexOf('--dry-run') >= 0;
  const uninstall = args.indexOf('--uninstall') >= 0;
  if (args.indexOf('--help') >= 0 || args.indexOf('-h') >= 0) {
    console.log(usage());
    return 0;
  }
  const unknown = args.filter(function (a) { return a !== '--dry-run' && a !== '--uninstall'; });
  if (unknown.length) {
    console.error('unknown argument: ' + unknown[0]);
    console.error(usage());
    return 2;
  }
  if (dryRun && uninstall) {
    console.error('--dry-run and --uninstall do the opposite things; pick one');
    return 2;
  }

  const target = settingsFile();
  const hookPath = installedHookPath();

  if (!uninstall && !fs.existsSync(SOURCE)) {
    console.error('the hook is missing next to this installer: ' + SOURCE);
    return 1;
  }

  let settings = {};
  let exists = false;
  if (fs.existsSync(target)) {
    exists = true;
    try {
      const text = fs.readFileSync(target, 'utf8');
      settings = text.trim() === '' ? {} : JSON.parse(text);
    } catch (e) {
      console.error('cannot read ' + target + ' as JSON: ' + e.message);
      console.error('nothing was written - fix the file (or move it aside) and run this again');
      return 1;
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      console.error(target + ' does not hold a JSON object; nothing was written');
      return 1;
    }
  }

  let result;
  try {
    result = merge(settings, !uninstall, hookPath);
  } catch (e) {
    console.error(target + ' has a shape this installer will not rewrite: ' + e.message);
    return 1;
  }

  if (dryRun) {
    console.log('would write: ' + target);
    console.log('would copy:  ' + SOURCE + ' -> ' + hookPath);
    console.log('entry:');
    console.log(JSON.stringify(uninstall ? { removed: result.removed } : hookEntry(hookPath), null, 2));
    console.log('dry run: nothing was written, copied or backed up');
    return 0;
  }

  if (!result.changed) {
    console.log(uninstall
      ? 'no hook entry for ' + HOOK_NAME + ' in ' + target + ' - nothing to remove'
      : 'already installed in ' + target + ' - nothing changed');
    if (!uninstall) console.log('hook copy: ' + hookPath);
    return 0;
  }

  let backup = null;
  if (exists) {
    try {
      backup = backupSettings(target);
    } catch (e) {
      console.error('could not back up ' + target + ' (' + e.message + '); nothing was written');
      return 1;
    }
  }

  try {
    writeJson(target, result.next);
  } catch (e) {
    console.error('could not write ' + target + ': ' + e.message);
    if (backup) console.error('the previous file is at ' + backup);
    return 1;
  }

  if (!uninstall) {
    try {
      fs.mkdirSync(path.dirname(hookPath), { recursive: true });
      fs.copyFileSync(SOURCE, hookPath);
    } catch (e) {
      console.error('settings updated, but the hook copy failed: ' + e.message);
      console.error('the entry points at ' + hookPath + ', so the hook will do nothing until it is there');
      return 1;
    }
  }

  if (backup) console.log('backed up: ' + backup);
  if (uninstall) {
    console.log('removed ' + result.removed + ' hook entr' + (result.removed === 1 ? 'y' : 'ies') + ' from ' + target);
    console.log('the copied hook at ' + hookPath + ' was left in place (delete it if you want it gone)');
  } else {
    console.log('installed: ' + target);
    console.log('hook copy: ' + hookPath);
    console.log('the dashboard writes ' + path.join(stateDir(), 'approval-token'));
    console.log('until that token exists the hook does nothing and Claude asks as usual');
  }
  return 0;
}

process.exitCode = main(process.argv);
