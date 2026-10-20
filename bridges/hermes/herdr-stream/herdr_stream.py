"""Herdr-Dash stream sink mapping for Hermes Agent.

Pure module: no ``hermes_cli`` / ``agent`` imports, so the unittest suite can
exercise the mapping and the writer without loading the Hermes runtime.

Design:
- Hook callbacks (in ``__init__.py``) only call the ``handle_*`` methods here.
  Those build a dict envelope and hand it to :class:`StreamWriter`, which owns a
  single daemon thread and a bounded queue. Nothing on the agent path touches
  the disk, and every public method swallows exceptions.
- Contract: ``_scratch/stream-round/CONTRACT.md`` sections 2, 3 and 5.
"""

from __future__ import annotations

import collections
import hashlib
import json
import logging
import os
import queue
import re
import threading
import time
from typing import Any, Dict, Mapping, Optional

logger = logging.getLogger(__name__)

AGENT = "hermes"
ENVELOPE_VERSION = 1

# Contract: one line <= 64 KiB, bounded payload fields <= 16 KiB.
MAX_LINE_BYTES = 64 * 1024
MAX_FIELD_BYTES = 16 * 1024
TRUNCATION_MARKER = "\u2026[truncated]"

# Contract: keep the newest 20 turn files per pane, delete files older than 2h.
KEEP_FILES = 20
MAX_AGE_SECONDS = 2 * 60 * 60

# Bounded turn bookkeeping so a long-lived process cannot grow without bound.
MAX_TRACKED_TURNS = 512

# A queue envelope is a glance at the tray, so it is bounded harder than a turn
# event: 100 rows a list, 4096 characters a row, and a total payload budget well
# under the 64 KiB line cap (a line that big would be dropped by the encoder).
QUEUE_MAX_ROWS = 100
QUEUE_MAX_TEXT_CHARS = 4096
QUEUE_BUDGET_BYTES = 48 * 1024
QUEUE_KINDS = ("steer", "followup")
QUEUE_SOURCES = ("queue", "interrupt")

_SAFE_RE = re.compile(r"[^A-Za-z0-9_.-]")

_BASE_KEYS = (
    "v",
    "seq",
    "ts",
    "agent",
    "pane_id",
    "session_id",
    "turn_id",
    "type",
)


# ---------------------------------------------------------------------------
# value helpers
# ---------------------------------------------------------------------------


def safe(value: Any) -> str:
    """Contract ``safe(s)``: non ``[A-Za-z0-9_.-]`` -> ``-``, max 80 chars."""
    text = "" if value is None else str(value)
    text = _SAFE_RE.sub("-", text)
    text = text[:80]
    return text or "unknown"


def resolve_stream_root(env: Optional[Mapping[str, str]] = None) -> str:
    """Resolve the sink root exactly like the contract's section 2."""
    source = os.environ if env is None else env
    override = source.get("HD_STREAM_DIR")
    if isinstance(override, str) and override.strip():
        return override.strip()
    local = source.get("LOCALAPPDATA")
    if isinstance(local, str) and local.strip():
        return os.path.join(local.strip(), "herdr-dash", "streams")
    return os.path.join(os.path.expanduser("~"), ".herdr-dash", "streams")


def _truncate_bytes(text: str, limit: int) -> str:
    """Cut ``text`` to at most ``limit`` UTF-8 bytes (never splits mid-char)."""
    if limit <= 0:
        return ""
    raw = text.encode("utf-8")
    if len(raw) <= limit:
        return text
    return raw[:limit].decode("utf-8", "ignore")


def bound_text(text: Any, limit: int = MAX_FIELD_BYTES) -> str:
    """Contract ``cap`` rule: keep the head, replace the tail with the marker."""
    value = "" if text is None else str(text)
    if len(value.encode("utf-8")) <= limit:
        return value
    marker_bytes = len(TRUNCATION_MARKER.encode("utf-8"))
    keep = max(0, limit - marker_bytes)
    return _truncate_bytes(value, keep) + TRUNCATION_MARKER


def bound_payload(value: Any, limit: int = MAX_FIELD_BYTES) -> Any:
    """Bound an args/result/partial/final_text payload.

    Strings are truncated in place. Structured values are kept as-is while their
    JSON encoding fits; otherwise the JSON text is stored truncated (the UI must
    treat every payload field as untrusted text anyway).
    """
    if value is None:
        return None
    if isinstance(value, str):
        return bound_text(value, limit)
    try:
        encoded = json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        return bound_text(repr(value), limit)
    if len(encoded.encode("utf-8")) <= limit:
        return value
    return bound_text(encoded, limit)


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _epoch_ms(value: Any) -> int:
    """A payload timestamp in epoch milliseconds, never a crash."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return int(time.time() * 1000)
    return int(value)


def _queue_row_id(kind: str, text: str, index: int) -> str:
    """The observer's row id for a row that arrived without one.

    Same recipe as ``queue_state.row_id`` (hash of kind+text+position) so an id
    this bridge invents is the id the observer would have given the same row.
    """
    digest = hashlib.sha1(f"{kind}\x00{text}\x00{index}".encode("utf-8", "replace")).hexdigest()
    return "hq-" + digest[:16]


def _queue_rows(value: Any, default_kind: str) -> list:
    """Validate, normalise and bound one list of queue rows.

    Anything that is not a mapping is dropped rather than rendered as a blank
    card; a row without a usable id gets the deterministic one for its content,
    a kind outside the two the tray knows falls back to the list's own kind, and
    the text is collapsed to one line and capped. Never raises.
    """
    rows = []
    if not isinstance(value, (list, tuple)):
        return rows
    for index, raw in enumerate(value):
        if len(rows) >= QUEUE_MAX_ROWS:
            break
        if not isinstance(raw, Mapping):
            continue
        kind = raw.get("kind")
        kind = kind if isinstance(kind, str) and kind in QUEUE_KINDS else default_kind
        text = raw.get("text")
        if text is None:
            text = ""
        elif not isinstance(text, str):
            text = str(text)
        try:
            text = " ".join(text.split())[:QUEUE_MAX_TEXT_CHARS]
        except Exception:
            text = ""
        row_id = raw.get("id")
        if not isinstance(row_id, str) or not row_id:
            row_id = _queue_row_id(kind, text, index)
        row: Dict[str, Any] = {"id": row_id[:80], "kind": kind, "text": text, "at": None}
        at = raw.get("at")
        if isinstance(at, (int, float)) and not isinstance(at, bool):
            row["at"] = int(at)
        source = raw.get("source")
        if isinstance(source, str) and source in QUEUE_SOURCES:
            row["source"] = source
        rows.append(row)
    return rows


def _queue_payload_size(steering: list, follow_up: list) -> int:
    try:
        blob = json.dumps([steering, follow_up], ensure_ascii=False, default=str)
    except Exception:
        return QUEUE_BUDGET_BYTES + 1
    return len(blob.encode("utf-8"))


def _fit_queue_budget(steering: list, follow_up: list) -> tuple:
    """Keep the whole queue payload inside QUEUE_BUDGET_BYTES.

    The writer caps a line at 64 KiB and only knows how to shrink top-level
    strings, so an oversized queue would be dropped silently. Here the row texts
    are halved first (readable truncation beats a lost tray), then the tails of
    the lists are dropped, oldest first.
    """
    cap = QUEUE_MAX_TEXT_CHARS
    while _queue_payload_size(steering, follow_up) > QUEUE_BUDGET_BYTES and cap > 256:
        cap = max(256, cap // 2)
        for rows in (steering, follow_up):
            for row in rows:
                row["text"] = row["text"][:cap]
    while _queue_payload_size(steering, follow_up) > QUEUE_BUDGET_BYTES:
        longer = steering if len(steering) >= len(follow_up) else follow_up
        if not longer:
            break
        longer.pop()
    return steering, follow_up


def _ordered(env: Mapping[str, Any]) -> Dict[str, Any]:
    """Stable envelope key order: base keys first, then type-specific fields."""
    ordered: Dict[str, Any] = {}
    for key in _BASE_KEYS:
        if key in env:
            ordered[key] = env[key]
    for key, value in env.items():
        if key not in ordered:
            ordered[key] = value
    return ordered


# ---------------------------------------------------------------------------
# bounded async writer
# ---------------------------------------------------------------------------


class StreamWriter:
    """Thread-safe queued NDJSON writer.

    ``submit`` assigns ``seq``/``ts`` and enqueues; a single daemon thread owns
    the file handle, pruning and line encoding. A full queue drops the newest
    event and never blocks or raises into the caller.
    """

    def __init__(
        self,
        root: str,
        pane_id: str,
        *,
        agent: str = AGENT,
        clock: Optional[Any] = None,
        max_queue: int = 8192,
        keep_files: int = KEEP_FILES,
        max_age_seconds: int = MAX_AGE_SECONDS,
    ) -> None:
        self.root = os.path.abspath(root)
        self.pane_id = str(pane_id)
        self.agent = agent
        self.pane_dir = os.path.join(self.root, safe(self.pane_id))
        self.keep_files = max(1, int(keep_files))
        self.max_age_seconds = max(0, int(max_age_seconds))

        self.dropped = 0
        self._clock = clock or time.time
        self._lock = threading.Lock()
        self._seq = 0
        self._closed = False
        self._queue: "queue.Queue[tuple]" = queue.Queue(maxsize=max(1, int(max_queue)))
        self._thread = threading.Thread(
            target=self._run,
            name="herdr-stream-writer",
            daemon=True,
        )
        self._thread.start()

    # -- public API --------------------------------------------------------

    def submit(self, envelope: Mapping[str, Any], file_key: Optional[str] = None) -> bool:
        """Enqueue one envelope. Never raises; returns False when dropped."""
        try:
            env = dict(envelope)
            env["agent"] = self.agent
            env["pane_id"] = self.pane_id
            with self._lock:
                if self._closed:
                    return False
                seq = self._seq + 1
                env["v"] = ENVELOPE_VERSION
                env["seq"] = seq
                env["ts"] = int(self._clock() * 1000)
                item = ("event", _ordered(env), file_key)
                try:
                    self._queue.put_nowait(item)
                except queue.Full:
                    self.dropped += 1
                    return False
                self._seq = seq
            return True
        except Exception:
            self.dropped += 1
            return False

    def close_current(self) -> None:
        """Ask the writer thread to close the open turn file; keep running."""
        self._control("close")

    def flush(self, timeout: float = 5.0) -> bool:
        """Block until every previously submitted item has been processed."""
        if self._closed:
            return False
        done = threading.Event()
        try:
            self._queue.put(("barrier", done), timeout=timeout)
        except queue.Full:
            return False
        except Exception:
            return False
        return bool(done.wait(timeout))

    def shutdown(self, timeout: float = 5.0) -> None:
        """Flush what is queued, close the file and stop the writer thread."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
        try:
            self._queue.put(("shutdown",), timeout=timeout)
        except Exception:
            pass
        try:
            self._thread.join(timeout)
        except Exception:
            pass

    @property
    def thread_alive(self) -> bool:
        return self._thread.is_alive()

    # -- internals ---------------------------------------------------------

    def _control(self, kind: str) -> None:
        try:
            self._queue.put_nowait((kind,))
        except Exception:
            pass

    def _path_for(self, env: Mapping[str, Any], file_key: Optional[str]) -> str:
        session = safe(env.get("session_id"))
        turn = safe(file_key if file_key is not None else env.get("turn_id"))
        return os.path.join(self.pane_dir, f"{session}__{turn}.ndjson")

    def _run(self) -> None:
        handle = None
        current_path: Optional[str] = None
        try:
            while True:
                item = self._queue.get()
                try:
                    kind = item[0]
                    if kind == "event":
                        current_path, handle = self._handle_event(item[1], item[2], handle, current_path)
                    elif kind == "close":
                        if handle is not None:
                            self._safe_close(handle)
                        handle = None
                        current_path = None
                    elif kind == "barrier":
                        item[1].set()
                    elif kind == "shutdown":
                        return
                except Exception:
                    logger.debug("herdr-stream writer item failed", exc_info=True)
                    try:
                        if handle is not None:
                            self._safe_close(handle)
                    except Exception:
                        pass
                    handle = None
                    current_path = None
                finally:
                    try:
                        self._queue.task_done()
                    except Exception:
                        pass
        finally:
            if handle is not None:
                self._safe_close(handle)

    def _handle_event(self, env, file_key, handle, current_path):
        path = self._path_for(env, file_key)
        if handle is None or path != current_path:
            old_path = current_path
            if handle is not None:
                self._safe_close(handle)
            handle = self._open(path)
            current_path = path
            if env.get("type") == "turn_start":
                protect = {path}
                if old_path:
                    protect.add(old_path)
                self._prune(self.pane_dir, protect)
        line = self._encode(env)
        if line:
            handle.write(line)
        if env.get("type") == "turn_end":
            self._safe_close(handle)
            handle = None
            current_path = None
        return current_path, handle

    def _open(self, path: str):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # Binary append, unbuffered: no BOM, no newline translation, one syscall
        # per line so a tailing reader sees deltas immediately.
        return open(path, "ab", buffering=0)

    @staticmethod
    def _safe_close(handle) -> None:
        try:
            handle.close()
        except Exception:
            pass

    def _encode(self, env: Dict[str, Any]) -> Optional[bytes]:
        try:
            raw = json.dumps(env, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
            if len(raw) <= MAX_LINE_BYTES:
                return raw + b"\n"
            # Pathological line: shrink the largest free-text field first. Deltas
            # are normally never touched (bounded fields keep lines well under
            # 64 KiB); the hard cap wins over the no-truncate rule.
            shrinkable = ("delta", "text", "args", "result", "final_text", "partial", "error", "message")
            for _ in range(12):
                target_key = None
                target_len = 0
                for key in shrinkable:
                    value = env.get(key)
                    if isinstance(value, str):
                        size = len(value.encode("utf-8"))
                        if size > target_len:
                            target_key, target_len = key, size
                if target_key is None or target_len == 0:
                    break
                excess = len(raw) - MAX_LINE_BYTES
                new_cap = max(0, target_len - excess - 8)
                if new_cap >= target_len:
                    new_cap = target_len // 2
                env[target_key] = bound_text(env[target_key], new_cap)
                raw = json.dumps(env, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
                if len(raw) <= MAX_LINE_BYTES:
                    return raw + b"\n"
            for key in shrinkable:
                if key in env:
                    env[key] = TRUNCATION_MARKER
            raw = json.dumps(env, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
            if len(raw) > MAX_LINE_BYTES:
                return None
            return raw + b"\n"
        except Exception:
            logger.debug("herdr-stream line encode failed", exc_info=True)
            return None

    def _prune(self, pane_dir: str, protect: set) -> None:
        """Contract cleanup: drop >2h old files, then keep the newest 20."""
        try:
            now = self._clock()
            entries = []
            with os.scandir(pane_dir) as walker:
                for entry in walker:
                    if not entry.name.endswith(".ndjson"):
                        continue
                    try:
                        if not entry.is_file():
                            continue
                        stat = entry.stat()
                    except OSError:
                        continue
                    entries.append((stat.st_mtime, entry.path))
        except FileNotFoundError:
            return
        except Exception:
            logger.debug("herdr-stream prune scan failed", exc_info=True)
            return
        protected = {os.path.abspath(path) for path in protect if path}
        entries.sort(key=lambda item: item[0], reverse=True)
        survivors = []
        for mtime, path in entries:
            absolute = os.path.abspath(path)
            if absolute in protected:
                survivors.append((mtime, path))
                continue
            if self.max_age_seconds and (now - mtime) > self.max_age_seconds:
                self._unlink(path)
                continue
            survivors.append((mtime, path))
        for index, (_mtime, path) in enumerate(survivors):
            if index < self.keep_files:
                continue
            if os.path.abspath(path) in protected:
                continue
            self._unlink(path)

    @staticmethod
    def _unlink(path: str) -> None:
        try:
            os.unlink(path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# hook payload -> envelope mapping
# ---------------------------------------------------------------------------


class HermesStreamBridge:
    """Map Hermes hook payloads to contract envelopes.

    One instance per process. Disabled instances are never created: the plugin
    only registers hooks (and only starts a writer thread) when
    ``HERDR_ENV == "1"`` and ``HERDR_PANE_ID`` is present.
    """

    def __init__(self, pane_id: str, writer: StreamWriter, *, agent: str = AGENT) -> None:
        self.pane_id = str(pane_id)
        self.agent = agent
        self.writer = writer
        self._lock = threading.Lock()
        self._started_turns: "collections.OrderedDict[str, None]" = collections.OrderedDict()
        self._session_id = ""
        self._turn_id = ""
        self._current_turn = ""
        self._model = ""
        self._platform = ""
        self._tool_counter = 0

    # -- construction ------------------------------------------------------

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> Optional["HermesStreamBridge"]:
        """Return a bridge, or None when the plugin must be a strict no-op."""
        source = os.environ if env is None else env
        try:
            if str(source.get("HERDR_ENV", "")) != "1":
                return None
            pane = str(source.get("HERDR_PANE_ID") or "").strip()
            if not pane:
                return None
            writer = StreamWriter(resolve_stream_root(source), pane)
            return cls(pane, writer)
        except Exception:
            return None

    # -- plugin entrypoints (all never raise) ------------------------------

    def handle_stream_start(self, payload: Optional[Mapping[str, Any]] = None) -> None:
        try:
            p = dict(payload or {})
            self._remember(p)
            turn_id = self._turn(p)
            iteration = _int(p.get("iteration"), 0)
            self._begin(p, turn_id)
            fields: Dict[str, Any] = {
                "message_id": self._message_id(turn_id, iteration),
                "role": "assistant",
            }
            model = self._model_of(p)
            if model:
                fields["model"] = model
            self._emit(p, "message_start", fields, turn_id=turn_id)
        except Exception:
            logger.debug("herdr-stream on_stream_start failed", exc_info=True)

    def handle_stream_delta(self, payload: Optional[Mapping[str, Any]] = None) -> None:
        try:
            p = dict(payload or {})
            delta = p.get("delta")
            if not isinstance(delta, str) or not delta:
                return
            self._remember(p)
            turn_id = self._turn(p)
            self._begin(p, turn_id)
            iteration = _int(p.get("iteration"), 0)
            kind = str(p.get("kind") or "text").lower()
            event_type = "reasoning_delta" if kind == "reasoning" else "text_delta"
            self._emit(
                p,
                event_type,
                {
                    "message_id": self._message_id(turn_id, iteration),
                    "content_index": 0,
                    "delta": delta,
                },
                turn_id=turn_id,
            )
        except Exception:
            logger.debug("herdr-stream on_stream_delta failed", exc_info=True)

    def handle_stream_end(self, payload: Optional[Mapping[str, Any]] = None) -> None:
        try:
            p = dict(payload or {})
            self._remember(p)
            turn_id = self._turn(p)
            self._begin(p, turn_id)
            iteration = _int(p.get("iteration"), 0)
            message_id = self._message_id(turn_id, iteration)
            fields: Dict[str, Any] = {"message_id": message_id}
            final_text = p.get("final_text")
            if isinstance(final_text, str):
                if final_text:
                    fields["text"] = bound_payload(final_text)
            elif final_text is not None:
                fields["text"] = bound_payload(final_text)
            self._emit(p, "message_end", fields, turn_id=turn_id)
            error = p.get("error")
            if error:
                self._emit(p, "error", {"message": bound_text(error)}, turn_id=turn_id)
        except Exception:
            logger.debug("herdr-stream on_stream_end failed", exc_info=True)

    def handle_pre_tool_call(self, payload: Optional[Mapping[str, Any]] = None) -> None:
        try:
            p = dict(payload or {})
            self._remember(p)
            turn_id = self._turn(p)
            self._begin(p, turn_id)
            tool_call_id = self._tool_call_id(p, turn_id)
            args = p.get("args")
            fields: Dict[str, Any] = {
                "tool_call_id": tool_call_id,
                "tool": str(p.get("tool_name") or ""),
                "args": bound_payload({} if args is None else args),
            }
            parent = p.get("parent_tool_call_id")
            if isinstance(parent, str) and parent:
                fields["parent_tool_call_id"] = parent
            self._emit(p, "tool_start", fields, turn_id=turn_id)
        except Exception:
            logger.debug("herdr-stream pre_tool_call failed", exc_info=True)

    def handle_post_tool_call(self, payload: Optional[Mapping[str, Any]] = None) -> None:
        try:
            p = dict(payload or {})
            self._remember(p)
            turn_id = self._turn(p)
            self._begin(p, turn_id)
            tool_call_id = self._tool_call_id(p, turn_id)
            status = p.get("status")
            is_error = False
            if isinstance(status, str) and status.strip().lower() not in ("", "ok", "success"):
                is_error = True
            if p.get("error_type") or p.get("error_message"):
                is_error = True
            fields: Dict[str, Any] = {
                "tool_call_id": tool_call_id,
                "result": bound_payload(p.get("result")),
                "is_error": is_error,
            }
            duration = p.get("duration_ms")
            if isinstance(duration, (int, float)) and not isinstance(duration, bool):
                fields["duration_ms"] = int(duration)
            self._emit(p, "tool_end", fields, turn_id=turn_id)
        except Exception:
            logger.debug("herdr-stream post_tool_call failed", exc_info=True)

    def handle_session_start(self, payload: Optional[Mapping[str, Any]] = None) -> None:
        try:
            p = dict(payload or {})
            self._remember(p)
            session_id = self._session_id
            fields: Dict[str, Any] = {}
            model = p.get("model")
            if isinstance(model, str) and model:
                fields["model"] = model
            if not fields:
                return
            with self._lock:
                open_turn = self._current_turn
            if open_turn:
                self._emit(p, "settings", fields, turn_id=open_turn)
            else:
                # Mirrors the pi bridge: a one-line control file, turn_id="control".
                self._emit_raw(session_id, "control", "settings", fields, file_key="control")
        except Exception:
            logger.debug("herdr-stream on_session_start failed", exc_info=True)

    def handle_session_end(self, payload: Optional[Mapping[str, Any]] = None) -> None:
        try:
            p = dict(payload or {})
            self._remember(p)
            turn_id = self._turn(p)
            self._begin(p, turn_id)
            status = self._session_end_status(p)
            self._emit(p, "turn_end", {"status": status}, turn_id=turn_id)
            self.writer.close_current()
            with self._lock:
                if self._current_turn == turn_id:
                    self._current_turn = ""
        except Exception:
            logger.debug("herdr-stream on_session_end failed", exc_info=True)

    def handle_session_reset(self, payload: Optional[Mapping[str, Any]] = None) -> None:
        try:
            p = dict(payload or {})
            self._remember(p)
            self.writer.close_current()
            with self._lock:
                self._started_turns.clear()
                self._current_turn = ""
                self._turn_id = ""
        except Exception:
            logger.debug("herdr-stream on_session_reset failed", exc_info=True)

    def handle_queue_snapshot(self, payload: Optional[Mapping[str, Any]] = None, *, reason: Optional[str] = None) -> None:
        """Emit one ``type="queue"`` envelope to this session's control file.

        The tray is a control-plane view, not part of a turn: the envelope always
        goes to ``<session>__control.ndjson`` with ``turn_id="control"`` so it
        keeps working between turns (and while one is open). An empty snapshot is
        emitted like any other -- that is the message that clears the tray -- so
        there is no early return here. Never raises.
        """
        try:
            p = dict(payload or {})
            self._remember(p)
            session_id = self._session_id_of(p)
            steering, follow_up = _fit_queue_budget(
                _queue_rows(p.get("steering"), "steer"),
                _queue_rows(p.get("followUp"), "followup"),
            )
            reason_text = reason if reason is not None else p.get("reason")
            fields: Dict[str, Any] = {
                "steering": steering,
                "followUp": follow_up,
                "updated_at": _epoch_ms(p.get("updated_at")),
                "reason": bound_text("" if reason_text is None else str(reason_text), 200),
            }
            self._emit_raw(session_id, "control", "queue", fields, file_key="control")
        except Exception:
            logger.debug("herdr-stream queue snapshot failed", exc_info=True)

    # -- test / lifecycle helpers -----------------------------------------

    def flush(self, timeout: float = 5.0) -> bool:
        return self.writer.flush(timeout)

    def shutdown(self, timeout: float = 5.0) -> None:
        self.writer.shutdown(timeout)

    # -- internals ---------------------------------------------------------

    def _remember(self, p: Mapping[str, Any]) -> None:
        session = p.get("session_id")
        turn = p.get("turn_id")
        model = p.get("model")
        platform = p.get("platform")
        with self._lock:
            if isinstance(session, str) and session:
                self._session_id = session
            if isinstance(turn, str) and turn:
                self._turn_id = turn
            if isinstance(model, str) and model:
                self._model = model
            if isinstance(platform, str) and platform:
                self._platform = platform

    def _turn(self, p: Mapping[str, Any]) -> str:
        turn = p.get("turn_id")
        if isinstance(turn, str) and turn:
            return turn
        with self._lock:
            if self._turn_id:
                return self._turn_id
            session = self._session_id
        return f"{session}:turn" if session else "turn"

    def _session_id_of(self, p: Mapping[str, Any]) -> str:
        session = p.get("session_id")
        if isinstance(session, str) and session:
            return session
        with self._lock:
            return self._session_id

    def _model_of(self, p: Mapping[str, Any]) -> str:
        model = p.get("model")
        if isinstance(model, str) and model:
            return model
        with self._lock:
            return self._model

    def _ensure_turn(self, turn_id: str) -> bool:
        """Mark ``turn_id`` started; True only the first time for that turn."""
        with self._lock:
            if turn_id in self._started_turns:
                if not self._current_turn:
                    self._current_turn = turn_id
                return False
            self._started_turns[turn_id] = None
            self._current_turn = turn_id
            while len(self._started_turns) > MAX_TRACKED_TURNS:
                self._started_turns.popitem(last=False)
            return True

    def _begin(self, p: Mapping[str, Any], turn_id: str) -> None:
        """Emit exactly one ``turn_start`` per turn, even if start arrives late.

        on_stream_start normally does this first. Hermes dispatches each hook to
        its own worker thread, so a delta/tool event can beat the start event;
        the first event for a turn opens the file with exactly one turn_start.
        """
        if self._ensure_turn(turn_id):
            self._emit(p, "turn_start", {}, turn_id=turn_id)

    def _message_id(self, turn_id: str, iteration: int) -> str:
        return f"{turn_id}:{iteration}"

    def _tool_call_id(self, p: Mapping[str, Any], turn_id: str) -> str:
        existing = p.get("tool_call_id")
        if isinstance(existing, str) and existing:
            return existing
        with self._lock:
            self._tool_counter += 1
            counter = self._tool_counter
        return f"{turn_id}:tool:{counter}"

    @staticmethod
    def _session_end_status(p: Mapping[str, Any]) -> str:
        if p.get("interrupted"):
            return "aborted"
        if p.get("failed"):
            return "error"
        if p.get("completed") is False:
            # A turn that did not complete and was not interrupted failed.
            reason = str(p.get("reason") or p.get("turn_exit_reason") or "").lower()
            if "interrupt" in reason or "stop" in reason or "cancel" in reason:
                return "aborted"
            return "error"
        return "complete"

    def _emit(
        self,
        p: Mapping[str, Any],
        event_type: str,
        fields: Mapping[str, Any],
        *,
        turn_id: Optional[str] = None,
    ) -> None:
        self._emit_raw(
            self._session_id_of(p),
            turn_id or self._turn(p),
            event_type,
            fields,
            file_key=None,
        )

    def _emit_raw(
        self,
        session_id: str,
        turn_id: str,
        event_type: str,
        fields: Mapping[str, Any],
        *,
        file_key: Optional[str],
    ) -> None:
        envelope: Dict[str, Any] = {
            "agent": self.agent,
            "pane_id": self.pane_id,
            "session_id": session_id,
            "turn_id": turn_id,
            "type": event_type,
        }
        for key, value in fields.items():
            envelope[key] = value
        self.writer.submit(envelope, file_key=file_key)
