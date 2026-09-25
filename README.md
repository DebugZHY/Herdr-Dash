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

```
node src/server.js            # or: npm start        (start.cmd / stop.cmd on Windows)
node src/server.js --port 8080
```

Then open <http://127.0.0.1:7433>. `start.cmd` does the whole thing (probes the port first, never starts a second
instance, waits for `/api/health`, opens the browser); `stop.cmd` stops only its own instance and tells you what it
found.

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
  opens directly; a **file** offers *Open* (the default program) and *Open File Location* (the containing folder, with
  the file selected). A path that does not exist — including anything the agent elided with `…` — stays plain text:
  nothing is guessed, and nothing is opened unless you click it.
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

## Tests

```
node test/acceptance.mjs       # end-to-end in a real browser (spawns its own server)
node test/acceptance-v2.mjs    # layout/geometry acceptance, incl. real drags and clicks
node test/chat.mjs             # chat adapters against offline log fixtures
node test/chat-render.mjs      # the renderer's DOM fixtures (blocks, folds, copy, path links)
node test/pathlink.mjs         # path-link decoration against a stubbed /api/pathinfo
node test/pathlink-live.mjs    # path links in a real browser (own fixture page)
node test/paths.mjs            # path resolution, /api/pathinfo and /api/open
node test/status.mjs           # status-line parsing against captured fixtures
node test/dock.mjs             # the side dock and console module
node test/attach.mjs           # the attachment store
node test/git-view.mjs         # the changes view
node test/parity.mjs --base http://127.0.0.1:7433   # buffer parity against a live pane
```

In-page self-test: <http://127.0.0.1:7433/?selftest=1> (89 checks).

| suite | what it covers | checks |
|---|---|---|
| `test/acceptance.mjs` | End-to-end acceptance, real browser | 21/21 |
| `test/acceptance-v2.mjs` | Layout and geometry acceptance, real browser | 73/73 |
| `test/chat.mjs` | Chat adapters, offline fixtures | 59/59 |
| `test/chat-render.mjs` | Chat renderer (blocks, folds, copy, links) | 715/715 |
| `test/pathlink.mjs` | Path-link decoration, stubbed `/api/pathinfo` | 133/133 |
| `test/pathlink-live.mjs` | Path links, real browser + own fixture | 20/20 |
| `test/paths.mjs` | Path resolution, `/api/pathinfo`, `/api/open` | 23/23 |
| `test/status.mjs` | Status-line parsing, captured fixtures | 33/33 |
| `test/dock.mjs` | Console dock: keyboard, layout, live data | 297/297 |
| `test/attach.mjs` | Attachment store | 17/17 |
| `test/git-view.mjs` | Changes view | 35/35 |
| `test/parity.mjs` | Pane parity (w1 vs w2 read paths) | 36/36 deterministic + 8 live |

The totals are the last run of each suite on the release tree. `parity` is the exception worth reading closely: its 36
deterministic checks always pass, and its 8 live-capture checks depend on the pane the harness ends up watching — they
report 44/44 while an agent is genuinely streaming into that pane, and less when the watched pane is idle or its
capture window shrinks. The suite names the failing check in its output (`the capture actually moved`, `the buffer
retains at least a whole window`, `mergeStream still reproduces DEFECT-1`), so a partial run says exactly what it could
not exercise rather than passing quietly.

## License

MIT — see [LICENSE](LICENSE).
