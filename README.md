# herdr-dash

A local web dashboard for the **herdr** terminal multiplexer: see every agent pane as a structured conversation or as
its raw terminal transcript, drive panes and run native `herdr` commands from one page, and read each pane's own usage
figures and background processes. The server binds `127.0.0.1` only and spawns `herdr` directly — no shell, nothing
leaves your machine.

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
- The app runs detached and hidden, so closing the page stops nothing.

The same thing from a terminal:

```
node tools/hdctl.js status           # what is running, on which port, and since when
node tools/hdctl.js start | stop | restart      # --app-port M moves the app off 7433
node tools/pipe-probe.js             # can this shell reach herdr? exit 0 · 3 denied · 4 no herdr
```

`herdr-dash.cmd status` hands its arguments straight to that CLI: exit `0` means the operation happened, anything else
is a refusal with the reason. A stop first verifies that the port's process is a `node` running `src/server.js` that
answers `/api/health`, and it never kills by process name. The app can still be run on its own:
`node src/server.js [--port 8080]`.

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

Three columns: the workspace / tab / pane tree on the left, the selected pane in the middle, and a **side dock** on the
right showing that pane's own usage and background processes.

- **Panes** (`Ctrl+1..9` or `j` / `k`): `t` switches between the structured **chat view** and the raw terminal
  transcript — both stay available.
- **Prompts**: `Enter` sends, `Shift+Enter` adds a newline, *wait for idle* queues until the pane is free, and *send
  text* sends the text verbatim (what menus and REPLs expect).
- **Attachments**: paperclip, drag-and-drop, or paste. The file is copied to
  `<app>\_cache\attachments\<pane>\<utc>-name` (`HD_ATTACH_ROOT` moves it) and sent to the agent as an absolute path.
  Failures show the server's own reason; they are never silently dropped.
- **Console** (bottom): run native `herdr` commands server-side (`cli` mode) or raw RPC — for what the GUI does not
  expose.
- **Dock** (`d`): the pane's own status line (model, tokens, percentage, elapsed) and its background processes. Where
  the agent elided something with `…`, the dock says so instead of guessing.
- **Changes** (`g g`): read-only git status/diff for the directories herdr has panes in.
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
  `g b` board, `g i` inbox, `g p` palette, `g f` fan-out, `g s` search, `g g` changes · `\` collapse the sidebar.

## What it deliberately does not do

- It never writes to a pane except the prompts you send, and never through a shell.
- The chat view never invents a reply: it shows the agent's own records, marks elisions and absences, and says plainly
  when a session could not be resolved.
- The git view is read-only (it refuses `commit`), and only for directories herdr has panes in.
- Paths are only turned into links after the server confirms they exist; everything else stays text.

## Security

The server binds `127.0.0.1` **with no authentication**, and it is powerful: it can type into your agent panes, i.e.
issue instructions as you. Do not expose the port — no port forwarding, no `0.0.0.0`, no reverse proxy. Anything that
can reach this port on this machine can act inside your agents; stop the process when you are done.

Requests that change something on disk go through narrow, logged endpoints: `POST /api/open` accepts only the
whitelisted actions `open` / `reveal`, refuses cross-origin callers, requires an existing path, and hands the path to
the system with an argv array (never a shell); `POST /api/pathinfo` only stats; the attachment store only ever writes
inside its own directory.

The control console binds `127.0.0.1:7432` only. Its start / stop / restart are writes and need the per-run token its
own page carries plus a same-origin check, or they are refused `403` with no action taken, so another page on this
machine cannot drive it. A stop kills at most one verified PID — a `node(.exe)` whose command line runs
`src\server.js` and whose `/api/health` answers with `uptime_ms` — never by process name.

## License

MIT — see [LICENSE](LICENSE).
