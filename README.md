# herdr-dash

A local web dashboard for the **herdr** terminal multiplexer: see every agent pane as a structured conversation or as
its raw terminal transcript, and drive panes from one page. The server binds `127.0.0.1` only and spawns `herdr`
directly — no shell, nothing leaves your machine.

> Windows-only for now: herdr's API is a local named pipe (`\\.\pipe\...\herdr\herdr.sock`).

## Requirements

- Windows 10/11 and Node.js 18+ — **no npm dependencies**, the app is pure Node standard library
- herdr installed and running
- If herdr itself runs **elevated**, the dashboard must be started from the same elevation level — see
  [Windows elevation](#windows-herdr-must-be-reachable-from-the-same-elevation-level)
- Optional: Claude Code and/or hermes agent sessions. The chat view reads their local stores **read-only**
  (`~/.claude/projects/**/*.jsonl`, `%LOCALAPPDATA%\hermes\state.db`)

## Run

Double-click **`herdr-dash.cmd`** — or the Desktop shortcut that `create-shortcut.cmd` makes. It starts the **control
console** hidden on <http://127.0.0.1:7432/> if it is not already up, then opens it. One page, both looking and acting:

- **Status**: running / stopped / started outside this console — port, PID, uptime, herdr's version and protocol, and
  the tail of the server log, refreshed every couple of seconds.
- **Start / stop / restart**, and open the app in a new tab. A refusal is shown with the reason it was refused.
- **Stop this console** stops the console and releases its own port. The app keeps running — it is a separate,
  detached process on purpose, so to release both ports, stop the app and then quit the console.
- The app runs detached and hidden, so closing the page stops nothing.

The same thing from a terminal:

```
node tools/hdctl.js status           # what is running, on which port, and since when
node tools/hdctl.js start | stop | restart      # --app-port M moves the app off 7433
node tools/hdctl.js quit             # stop the console itself and release its port (--port N for another console)
node tools/pipe-probe.js             # can this shell reach herdr? exit 0 · 3 denied · 4 no herdr
```

`herdr-dash.cmd status` hands its arguments straight to that CLI: exit `0` means the operation happened, anything else
is a refusal with the reason. A stop first verifies that the port's process is a `node` running `src/server.js` that
answers `/api/health`, and it never kills by process name. `quit` does the same for the console itself — one verified
PID, never by name — and when the console was started elevated and the shell you ran it from may not kill it, it says
so and points at the page's own button rather than pretending. Nothing is listening is a success: `quit` is safe to
repeat. The app can still be run on its own: `node src/server.js [--port 8080]`.

`herdr-dash.cmd` reads a few environment variables of its own:

- `HD_CTL_PORT` — the console's port (default `7432`)
- `HD_APP_PORT` — the app port `hdctl` inspects and controls (default `7433`)
- `HD_ON_EPERM` — `inform` (the default) only explains an `EPERM` refusal; `elevate` relaunches the launcher elevated
- `HD_RESTART_LOW_CONSOLE` — `1` replaces an un-elevated console already holding `HD_CTL_PORT`
- `HD_NO_OPEN` — `1` starts the console without opening a browser
- `HD_NO_PAUSE` — `1` never waits for a keypress

## Windows: herdr must be reachable from the same elevation level

herdr's API is a Windows **named pipe**, and a pipe belongs to the process that created it: if herdr runs elevated and
this window does not, Windows refuses the pipe with `EPERM` before herdr sees the request. The reliable fix is to
**right-click `herdr-dash.cmd` → *Run as administrator*** — verified working on this machine. Without it the console
still opens and says so: its **herdr** field reads `herdr unreachable — access denied (EPERM)`, and it can show the
port and the log but cannot start or stop the app. `HD_ON_EPERM=elevate` opts into an automatic elevated relaunch,
but Windows silently drops that request on machines like this one (measured), which is why it is not the default.
`HD_RESTART_LOW_CONSOLE=1` covers the other case: an un-elevated console already holding `HD_CTL_PORT` would keep
showing the failure, so the launcher stops that pid (identity-checked) and starts an elevated one in its place. Or run
herdr itself from a NON-elevated terminal and nothing needs elevation anywhere.

## Usage

Two columns: the workspace / tab / pane tree on the left and the selected pane's conversation on the right, with the
composer pinned below it.

- **Panes** (`Ctrl+1..9` or `j` / `k`): pick the pane shown in the conversation.
- **Views**: `t` cycles terminal → **chat** (the structured history) → raw transcript → terminal; the header view chip
  does the same. The terminal streams the pane's screen (~150 ms cadence), while the chat view reads the agent's own
  log. Add `?perf=1` to the URL for a small header HUD refreshed twice a second.
- **Prompts**: `Enter` sends, `Shift+Enter` adds a newline, *wait for idle* queues until the pane is free, and *send
  text* sends the text verbatim (what menus and REPLs expect).
- **Attachments**: paperclip, drag-and-drop, or paste. The file is copied to
  `<app>\_cache\attachments\<pane>\<utc>-name` (`HD_ATTACH_ROOT` moves it) and sent to the agent as an absolute path.
  Failures show the server's own reason; they are never silently dropped.
- **Copy** (`⧉` on every message, thinking block and tool card): that block's **verbatim** text on the clipboard —
  including text a fold is hiding — with the true character count. If the browser refuses, it says so; it never
  pretends to have copied.
- **File paths become links** once the server confirms they exist. A **folder** opens in File Explorer, brought to the
  front, and an already-open window for that folder is raised instead of opening a second; a **file** offers *Open* and
  *Open File Location*. The click is answered on the page with a short receipt — never a silent nothing. Anything else,
  including a path the agent elided with `…`, stays plain text.
- **Selecting text while the stream runs** freezes the stream under your cursor until you release, then the queued
  records are added in order. A slow read says what it is waiting for ("still reading … 4s so far"), reports a timeout
  as a timeout, and retries on its own.
- **Keys**: `Ctrl+K` palette · `?` shortcuts · `Ctrl+1..9` / `j`,`k` panes · `/` prompt · `Esc` closes overlays ·
  `g p` palette, `g f` fan-out, `g s` search · `\` collapse the sidebar.

## Stream bridges (optional)

Token-level live output comes from small add-ons that run **inside** the agent and write its
stream to a local NDJSON sink; the dashboard serves that sink as SSE. Without them everything
still works from the record logs — the conversation is just record-level, not token-level.

```
powershell -ExecutionPolicy Bypass -File tools\install-stream-bridges.ps1
```

The script copies the pi extension into `%USERPROFILE%\.pi\agent\extensions\herdr-stream`,
copies the hermes plugin into `%LOCALAPPDATA%\hermes\plugins\herdr-stream`, enables the plugin
(`hermes plugins enable herdr-stream`) and, unless `-NoReasoning` is passed, opts into reasoning
deltas. It is idempotent: a target that already matches the repo is left alone, and a target that
differs is moved aside with a timestamp before the new copy is written. Nothing is deleted and no
agent process is touched.

After installing:

1. **pi** — run `/reload` in each open pi pane (new panes load the extension automatically).
2. **hermes** — restart each hermes pane; plugins load when the agent starts.
3. **dashboard** — reload the page.

`bridge_missing` means no bridge envelope has been seen for the selected pane: the extension or
plugin is not installed, not loaded in *that* pane, or the pane was started before the install.
The view stays on records and the pane is never typed into.

Token streaming requires a **live pane**: the sink is written by the agent process as it runs, so
a session read from disk cannot stream, and an idle or stopped pane produces nothing until it runs
again. Remove the add-ons with the same script and `-Uninstall`.

## What it deliberately does not do

- It never writes to a pane except the prompts you send, and never through a shell.
- The chat view never invents a reply: it shows the agent's own records, marks elisions and absences, and says plainly
  when a session could not be resolved.
- The git view is read-only (it refuses `commit`), and only for directories herdr has panes in.
- Paths are only turned into links after the server confirms they exist; everything else stays text.

## Security

The server binds `127.0.0.1` **with no authentication**, and it is powerful: it can type into your agent panes, i.e.
issue instructions as you. Do not expose the port — no port forwarding, no `0.0.0.0`, no reverse proxy. Anything that
can reach this port on this machine can act inside your agents; stop the process when you are done — the console has a
supported way out: **Stop this console** on its own page, or `herdr-dash.cmd quit`.

Requests that change something on disk go through narrow, logged endpoints: `POST /api/open` accepts only the
whitelisted actions `open` / `reveal`, refuses cross-origin callers, requires an existing path, and hands the path to
the system with an argv array (never a shell); `POST /api/pathinfo` only stats; the attachment store only ever writes
inside its own directory.

The control console binds `127.0.0.1:7432` only. Its start / stop / restart are writes and need the per-run token its
own page carries plus a same-origin check, or they are refused `403` with no action taken, so another page on this
machine cannot drive it. `POST /api/quit` is a write under the same guard and stops the console itself: it releases the
console's port and leaves the app alone. A stop kills at most one verified PID — a `node(.exe)` whose command line runs
`src\server.js` and whose `/api/health` answers with `uptime_ms` — never by process name; the CLI's `quit` resolves and
verifies the console's own PID the same way, and refuses — saying so — when the console outranks the shell it was run
from.

## License

MIT — see [LICENSE](LICENSE).
