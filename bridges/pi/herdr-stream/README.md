# herdr-stream (pi bridge)

A pi extension that observes pi's real token stream and appends it to the Herdr-Dash NDJSON sink.
envelopes to the local NDJSON sink, so Herdr-Dash can render assistant text/reasoning
while it is generated instead of waiting for the final `/api/chat` record.

**Observer only.** It does not abort runs, change models, change sessions, or touch
tool results. It never throws into the agent loop, and it does no synchronous disk I/O
anywhere — not on the token path, not anywhere else.

Files:

| file | role |
|---|---|
| `index.ts` | the pi extension: registers the 11 handlers, nothing else |
| `sink.js` | the async writer (turn files, seq, queue, cleanup) + the ctx-aware bridge |
| `mapping.js` | pure mapping: paths, bounding, pi event → envelope (no I/O, no state) |
| `sink.d.ts` | types for `sink.js` (editors/`tsc` only; never loaded at runtime) |
| `../../test/pi-bridge.test.mjs` | `node --test test/pi-bridge.test.mjs` (repo root) |

`sink.js`/`mapping.js` are plain CommonJS on purpose: `node --test` can `require()`
them with no TypeScript build, and pi's jiti loader resolves `import herdrStream from
"./sink.js"` from `index.ts` (verified against pi 1.2.0's jiti, and against Node's
native TypeScript stripping).

## Install (manager)

pi discovers `<agentDir>/extensions/<name>/index.ts`, so the whole directory is copied:

```
copy bridges\pi\herdr-stream  ->  %USERPROFILE%\.pi\agent\extensions\herdr-stream\
```

Nothing else is needed (no dependencies, no build, no package.json). `sink.d.ts` is
optional. Enable by restarting pi, or `/reload`.

Required environment for the pane pi runs in (**nothing is written without both**):

| var | value |
|---|---|
| `HERDR_ENV` | `1` |
| `HERDR_PANE_ID` | the herdr pane id, e.g. `wD:p2` → directory `wD-p2` |
| `HD_STREAM_DIR` | optional override; default `%LOCALAPPDATA%\herdr-dash\streams` |

Back out by removing the directory again; there is no config to edit.

## What it writes

```
<root>/<safe(pane_id)>/<safe(session_id)>__<safe(turn_id)>.ndjson     one file per turn
<root>/<safe(pane_id)>/<safe(session_id)>__control.ndjson            settings with no open turn
<root>/../stream.log                                                 best-effort diagnostics
```

- One JSON object per line, UTF-8, no BOM, append-only, ≤ 64 KiB per line.
- `seq` is monotonic per process and never reused; `ts` is epoch ms.
- Bounding: `args`, `result`, `partial`, `text` (i.e. `final_text`) cap at 16 KiB with
  the tail replaced by `…[truncated]`; token deltas are never truncated (a single delta
  that would push its line past 64 KiB is dropped and counted instead of corrupted).
- Cleanup on turn start: newest 20 turn files per pane stay, files older than 2 hours
  go, the open file is never deleted, `__control.ndjson` is never counted or deleted.

## Mapping

| pi event | envelope |
|---|---|
| `turn_start` | `turn_start` (`turn_index`); `turn_id = <session>:<turnIndex>:<Date.now()>` |
| `message_start` (assistant/user) | `message_start` (`message_id`, `role`, `model` for assistant) |
| `message_update` `text_delta` | `text_delta` |
| `message_update` `text_end` | `text_end` (`text` = block text) |
| `message_update` `thinking_delta` | `reasoning_delta` |
| `message_update` `thinking_end` | `reasoning_end` |
| `message_update` `toolcall_start/delta/end` | `tool_call_start/delta/end` (`content_index` from pi) |
| `message_end` (assistant) | `error` first when `stopReason === "error"`, then `message_end` (`text`) |
| `tool_execution_start` | `tool_start` (`tool_call_id`, `tool`, `args`, `parent_tool_call_id`) |
| `tool_execution_update` | `tool_update` (`partial`) |
| `tool_execution_end` | `tool_end` (`result`, `is_error`, `duration_ms`) |
| `agent_settled` | `turn_end` (`complete`/`aborted`/`error`), then the file closes |
| `model_select` / `thinking_level_select` | `settings` (`model` / `thinking_level`) |
| `session_shutdown` | nothing; an open turn is force-closed with `turn_end status="aborted"` |

`message_update` `start`, `text_start`, `thinking_start`, `done` have no envelope of
their own (they carry no delta and no text): the file describes the message through its
deltas plus `message_end.text`, which is authoritative.

`message_start`/`message_end` for `toolResult` and `custom` messages are skipped (only
names `assistant`/`user`).

## Decisions worth knowing about

1. **One turn file per agent RUN, not per pi `turn_start`.** pi emits `turn_start` once
   per LLM request, so a run with tool calls emits several. A turn may contain
   several assistant messages, and the bridge closes the file on `agent_settled`, so the second
   and later `turn_start` events of a run keep the open file (they are not written as
   extra `turn_start` lines either: the client opens a live turn per `turn_start`, and a
   mid-run `turn_start` would clear the bubbles it is still filling). A `turn_start`
   with `turn_index === 0` while a later iteration is open means the previous run never
   settled — that file is closed with `turn_end status="aborted"` and a new one starts.
2. **`turn_end` status `error`.** The contract says "aborted, else complete"; `error` is also
   pi reports provider failures as an assistant message with `stopReason === "error"`
   (not `aborted`). Reporting those runs as `complete` would tell the UI a broken turn
   finished, so the status is `aborted` → `aborted`, last `stopReason === "error"` →
   `error`, otherwise `complete`.
3. **`message_id` is synthetic in practice.** pi 1.2.0's `AssistantMessage` has no `id`,
   so `<turn_id>:m<counter>` is the path that runs; the `message.id` branch stays for
   shapes that do carry one. Start/end of one message always share the same id.
4. **Tool calls: one `tool_call_id`, pinned on first sight.** `toolcall_start/delta`
   carry no id, only the partial message; the id is read from
   `assistantMessageEvent.partial.content[contentIndex].id`. Some OpenAI-compatible
   endpoints send `id: ""` at first and only reveal it later; the first id seen is
   pinned, and `tool_execution_*` ids are aliased onto the pinned value, so the UI shows
   one card per call instead of two (UI keys both by `tool_call_id`). A provider
   that never exposes an id falls back to `<message_id>:c<contentIndex>`.
5. **`parent_tool_call_id`** is in pi's `ToolExecutionStartEvent` type but pi 1.2.0 does
   not forward it from the agent event (`core/agent-session.js` builds the extension
   event with `toolCallId`/`toolName`/`args` only). The field is written when present and
   omitted otherwise; nested-call parents will therefore usually be absent.
6. **Settings without an open turn** append to `<session>__control.ndjson` with
   `turn_id="control"` (one line per event, so the file keeps the history). `model.id`
   is what lands in `model`.
7. **Lazy open** (extension reloaded mid-turn, or any event before `turn_start`) uses
   `turn_id = <session>:lazy:<Date.now()>`.
8. **`seq` is process-wide** and does not reset when a turn file closes, so
   `(session_id, turn_id, seq)` stays unique across turns as well as within one.

## Failure behaviour

Every write goes through one FIFO drained by a single async loop. A full queue
(20 000 ops) drops the newest event, a failing disk drops the event and logs once per
second per kind, and `settled`/`shutdown` flush with a 500 ms cap so teardown cannot
hang. Nothing is written, not even `stream.log`, when `HERDR_ENV != "1"` or
`HERDR_PANE_ID` is missing.

## Tests

```
node --check bridges/pi/herdr-stream/mapping.js
node --check bridges/pi/herdr-stream/sink.js
node --test test/pi-bridge.test.mjs          # 31 tests
```

The suite covers text, reasoning, tool argument streams, tool execution, `message_end`
replacement, `turn_end` complete/aborted/error, settings (in-turn and control file),
missing pane / wrong `HERDR_ENV`, bounded payloads and the 64 KiB line rule, monotonic
and never-reused `seq`, lazy open, multi-iteration runs, cleanup (20 files / 2 hours),
and a dry run into a temp `HD_STREAM_DIR`.

## Not verified here (needs the manager's live pane)

- That pi emits these events in this order for a real provider turn. The
  shapes are taken from `dist/core/extensions/types.d.ts`, `pi-ai/dist/types.d.ts` and
  the emitters in `core/agent-session.js`; the whole path was exercised through the real
  `index.ts` + jiti loader with synthetic events only.
- Whether a live provider ever withholds a tool-call id (decision 4) — the alias path is
  unit-tested, not observed live.
- `parentToolCallId` forwarding (decision 5) — absent in this pi build's emitted events.
- Real throughput on the token path: the writer is async and unbounded in the happy
  path, but the 20 000-op queue cap has only been exercised synthetically.
