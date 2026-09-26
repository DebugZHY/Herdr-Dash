# herdr-dash

A local web dashboard for the **herdr** terminal multiplexer: see every agent pane as a structured conversation or as
its raw terminal transcript, drive panes and run native `herdr` commands from one page, and read each pane's own usage
figures and background processes. The server binds `127.0.0.1` only and spawns `herdr` directly — no shell, nothing
leaves your machine.

> Windows-only for now: herdr's API is a local named pipe (`\\.\pipe\...\herdr\herdr.sock`).

## Requirements

- Windows 10/11 and Node.js 18+ — **no npm dependencies**, the app is pure Node standard library
- herdr installed and running
- Optional: Claude Code and/or hermes agent sessions. The chat view reads their local stores **read-only**
  (`~/.claude/projects/**/*.jsonl`, `%LOCALAPPDATA%\hermes\state.db`)

## Run

Double-click **`herdr-dash.cmd`**. It starts the control console — hidden, on <http://127.0.0.1:7432/> — if it is not
already up, then opens that page in your browser. `create-shortcut.cmd` puts a "herdr-dash" shortcut on your Desktop
if you would rather not go looking for the file.

The console is one page for both looking and acting:

- **Status**: whether the app is running, stopped, or was started outside this console — with its port, PID, uptime,
  herdr's version and protocol, and the tail of the server log, refreshed every couple of seconds.
- **Start / stop / restart** the app, and open it in a new tab. A refusal is shown with the reason it was refused.
- The app is started detached and hidden, so closing the page stops nothing.

There is a command line too, for terminals and scripts:

```
node tools/hdctl.js status           # what is running, on which port, and since when
node tools/hdctl.js start            # start the app (--app-port M to move it off 7433)
node tools/hdctl.js stop             # stop it, after checking the process really is this app
node tools/hdctl.js restart
```

`herdr-dash.cmd` hands its arguments straight to that CLI (`herdr-dash.cmd status`), so the exit code and the message
are the console's own: `0` means the operation happened, anything else is a refusal with the reason. A stop verifies
that the process on the port is a `node` running `src/server.js` that answers `/api/health` before it kills anything,
and it never kills by process name.

The app can still be run on its own: `node src/server.js` (or `npm start`, or `--port 8080`).

The old `start.cmd` and `stop.cmd` are gone — the console replaces both, and nothing here needs administrator rights.

## Usage

Three columns: the workspace / tab / pane tree on the left, the selected pane in the middle, and a **side dock** on the
right showing that pane's own usage and background processes.

- **Pick a pane** in the tree (`Ctrl+1..9` or `j` / `k`). `t` switches between the structured **chat view** and the
  **raw terminal transcript** — both stay available.
- **Send a prompt** in the box at the bottom: `Enter` sends, `Shift+Enter` adds a newline, and *wait for idle* queues
  the message until the pane is free. *send text* sends the text literally (verbatim, no newline), which is what menus
  and REPLs expect.
- **Attachments**: use the paperclip, drag a file onto the window, or paste. The file is copied into the app's own
  store — `<app>\_cache\attachments\<pane>\<utc>-name` (set `HD_ATTACH_ROOT` to move it) — and sent to the agent as an
  absolute path, which the agent opens with its own tools. Failures show the server's own reason; they are never
  silently dropped.
- **Console** (bottom): run native `herdr` commands server-side (`cli` mode) or raw RPC — useful when the GUI does not
  expose something.
- **Dock** (`d`): the selected pane's own status line (model, tokens, percentage, elapsed) and its background
  processes. Where the agent elided something with `…`, the dock says so instead of guessing; claude's figures are
  shown as claude prints them.
- **Changes view** (`g g`): read-only git status/diff for the directories herdr has panes in.
- **Copy** (`⧉` on every message, thinking block and tool card): puts that block's **verbatim** text on the clipboard —
  including text a fold is currently hiding — and reports the true character count. If the browser refuses the
  clipboard it says so and tells you what to do instead; it never pretends to have copied.
- **File paths become links**: a path in an agent's output that really exists on this machine is clickable. A **folder**
  opens in File Explorer and is brought to the front; if a window for that same folder is already open, that window is
  raised instead of a second one being opened; a **file** offers *Open* (the default program) and *Open File Location*
  (the containing folder, with the file selected). The click is answered on the page with a short receipt saying what
  was handed to the system — never a silent nothing. A path that does not exist — including anything the agent elided
  with `…` — stays plain text: nothing is guessed, and nothing is opened unless you click it.
- **Selecting text while the stream runs**: pressing the mouse in the chat view freezes the stream where it is — nothing
  re-renders or scrolls under your cursor while you drag, and no record is lost — then the queued records are added in
  order when you release. A read that takes a moment says what it is waiting for ("still reading … 4s so far"),
  reports a timeout as a timeout, and retries on its own instead of parking the panel.
- **Keys**: `Ctrl+K` command palette · `?` shortcut overlay · `Ctrl+1..9` / `j`,`k` select a pane · `/` focus the
  prompt · `Esc` closes overlays (sent to a pane only when *esc→pane* is armed) · `g b` board, `g i` inbox, `g p`
  palette, `g f` fan-out, `g s` search, `g g` changes · `\` collapse/restore the sidebar.

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

The control console (`herdr-dash.cmd`, `tools/hdctl.js`) also binds `127.0.0.1` only, on its own port 7432. Its
start / stop / restart are writes, and they need the per-run token its own page carries in `x-hd-ctl-token` **and** a
same-origin `Origin` / `Sec-Fetch-Site` — anything else is answered `403` with no action taken, so another page on
this machine cannot drive it. Its stop only ever kills one PID that passed the same three-way identity check the old
`stop.cmd` used — a `node(.exe)` whose command line runs `src\server.js`, and an `/api/health` that answers with
`uptime_ms` — and it never kills by process name (`taskkill /PID`, never `/IM`).

## License

MIT — see [LICENSE](LICENSE).
