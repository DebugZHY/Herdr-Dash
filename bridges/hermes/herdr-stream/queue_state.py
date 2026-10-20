"""Read-only snapshot of the Hermes CLI's pending input, for the Herdr-Dash tray.

The CLI keeps three queues of words the user has typed but the agent has not
consumed yet:

- ``cli._pending_input``      a ``queue.Queue`` of follow-up messages (FIFO)
- ``cli._interrupt_queue``    a ``queue.Queue`` of messages that also interrupt
- ``cli.agent._pending_steer`` ONE string: every accepted ``/steer`` joined with
                               newlines, guarded by ``cli.agent._pending_steer_lock``

This module only reads them. Nothing here pops an item, takes ownership of a
item, or writes to the CLI: a snapshot is a copy taken under whatever lock the
queue already has, and every field is treated as optional so a Hermes version
with a different shape degrades to fewer rows instead of an exception.

Two pieces:

- :func:`snapshot` -- pure function, ``cli -> {steering, followUp, session_id}``
- :class:`QueueObserver` -- one daemon thread that polls a CLI reference and
  calls ``emit(snapshot, reason)`` when the visible state changes

The bridge (``herdr_stream.py``) turns a snapshot into a ``type="queue"``
envelope; this module knows nothing about NDJSON, panes or sessions beyond the
id string it copies out.
"""

from __future__ import annotations

import hashlib
import threading
import time
from typing import Any, Callable, Dict, List, Mapping, Optional

# One snapshot carries at most this many rows per list, and this many characters
# per row. A queue longer than MAX_ROWS shows its head (the items that run next);
# the tray is a glance, not the transcript.
MAX_ROWS = 100
MAX_TEXT_CHARS = 4096

# The observer's poll period, per the tray's own cadence.
POLL_SECONDS = 0.75

KIND_STEER = "steer"
KIND_FOLLOWUP = "followup"
SOURCE_QUEUE = "queue"
SOURCE_INTERRUPT = "interrupt"


# ---------------------------------------------------------------------------
# defensive attribute access
# ---------------------------------------------------------------------------


def _attr(obj: Any, name: str, default: Any = None) -> Any:
    """``getattr`` that cannot raise (properties and proxies can)."""
    if obj is None:
        return default
    try:
        return getattr(obj, name, default)
    except Exception:
        return default


def _get(obj: Any, name: str, default: Any = None) -> Any:
    """Attribute first, then mapping item: a CLI or session may be either shape."""
    value = _attr(obj, name)
    if value is not None:
        return value
    if isinstance(obj, Mapping):
        try:
            return obj.get(name, default)
        except Exception:
            return default
    return default


def _collapse(text: Any) -> str:
    """One line, no runs of whitespace, at most MAX_TEXT_CHARS characters."""
    try:
        flat = " ".join(str(text).split())
    except Exception:
        return ""
    return flat[:MAX_TEXT_CHARS]


def _text_of(item: Any) -> str:
    """The words of one queue item, whatever shape the CLI stored.

    A ``str`` is itself; a ``(text, images)`` tuple (or any sequence) carries its
    text in the first string it holds; an object or mapping is read through
    ``display_text`` and then ``text``. Anything else has no words to show.
    """
    if item is None:
        return ""
    if isinstance(item, str):
        return _collapse(item)
    if isinstance(item, (tuple, list)):
        for part in item:
            if isinstance(part, str):
                return _collapse(part)
        return ""
    if isinstance(item, Mapping):
        for key in ("display_text", "text"):
            value = item.get(key)
            if isinstance(value, str):
                return _collapse(value)
        return ""
    for name in ("display_text", "text"):
        value = _attr(item, name)
        if isinstance(value, str):
            return _collapse(value)
    return ""


def _at_of(item: Any) -> Optional[int]:
    """An item's own timestamp when it has one, in epoch milliseconds."""
    for name in ("at", "ts", "timestamp", "created_at"):
        value = _get(item, name)
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, (int, float)):
            number = float(value)
            # Seconds vs milliseconds: a value below ~1.6e11 cannot be ms.
            return int(number * 1000) if number < 1.6e11 else int(number)
    return None


def _queue_items(source: Any) -> List[Any]:
    """A copy of a ``queue.Queue``'s contents, oldest first, without removing any.

    ``queue.Queue`` exposes its deque and a mutex; both are used when present so
    a concurrent ``put``/``get`` cannot tear the copy. A plain list is accepted
    too (tests and future shapes), and a missing or unusable queue is empty.
    """
    if source is None:
        return []
    mutex = _attr(source, "mutex")
    inner = _attr(source, "queue")
    if inner is not None:
        if mutex is not None and hasattr(mutex, "acquire") and hasattr(mutex, "release"):
            try:
                mutex.acquire()
                try:
                    return list(inner)
                finally:
                    mutex.release()
            except Exception:
                pass
        try:
            return list(inner)
        except Exception:
            return []
    try:
        return list(source)
    except Exception:
        return []


def row_id(kind: str, text: str, index: int) -> str:
    """Deterministic opaque id: the same row keeps the same id across polls.

    The tray needs to recognise a row it already drew, and a UI action must be
    able to name one row without the observer having kept any state, so the id is
    a hash of what the row *is* (kind, text, position) rather than a counter.
    """
    digest = hashlib.sha1(f"{kind}\x00{text}\x00{index}".encode("utf-8", "replace")).hexdigest()
    return "hq-" + digest[:16]


def _row(kind: str, text: str, index: int, *, source: Optional[str] = None, at: Optional[int] = None) -> Dict[str, Any]:
    text = _collapse(text)
    row: Dict[str, Any] = {"id": row_id(kind, text, index), "kind": kind, "text": text, "at": at}
    if source is not None:
        row["source"] = source
    return row


# ---------------------------------------------------------------------------
# the pending-steer string
# ---------------------------------------------------------------------------


def _pending_steer(agent: Any) -> str:
    """Read ``_pending_steer`` under its own lock when the lock is usable.

    Hermes joins every accepted ``/steer`` into one newline-separated string, so
    this is one row however many times the user steered -- see :func:`snapshot`.
    A missing or broken lock still yields the value (a lock is a nicety, not a
    precondition), and a missing attribute is simply no steering.
    """
    if agent is None:
        return ""
    lock = _attr(agent, "_pending_steer_lock")
    value = None
    if lock is not None and hasattr(lock, "__enter__") and hasattr(lock, "__exit__"):
        try:
            with lock:
                value = _attr(agent, "_pending_steer")
        except Exception:
            value = None
    if value is None:
        value = _attr(agent, "_pending_steer")
    return _collapse(value) if isinstance(value, str) else ""


# ---------------------------------------------------------------------------
# session id
# ---------------------------------------------------------------------------


def _session_id(cli: Any) -> str:
    """The CLI's session id, from the first place that holds one."""
    for path in (("session_id",), ("session", "id"), ("agent", "session_id")):
        node = cli
        for name in path:
            node = _get(node, name)
            if node is None:
                break
        if isinstance(node, str) and node:
            return _collapse(node)[:200]
    return ""


# ---------------------------------------------------------------------------
# snapshot
# ---------------------------------------------------------------------------


def snapshot(cli: Any) -> Dict[str, Any]:
    """One read-only view of the CLI's pending work: ``{steering, followUp, session_id}``.

    ``steering`` holds at most one row: Hermes stores the accepted ``/steer``
    text as a single newline-joined string, so the individual entries are no
    longer separable here. ``followUp`` is ``_pending_input`` in FIFO order
    followed by ``_interrupt_queue``, each row labelled ``kind="followup"`` with
    ``source`` saying which queue it came from. Empty or absent queues, a missing
    agent, and any attribute that raises all produce an empty list.
    """
    result: Dict[str, Any] = {"steering": [], "followUp": [], "session_id": ""}
    try:
        result["session_id"] = _session_id(cli)
    except Exception:
        result["session_id"] = ""

    try:
        steer = _pending_steer(_get(cli, "agent"))
        if steer:
            result["steering"].append(_row(KIND_STEER, steer, 0))
    except Exception:
        pass

    follow: List[Dict[str, Any]] = []
    try:
        for index, item in enumerate(_queue_items(_get(cli, "_pending_input"))):
            if len(follow) >= MAX_ROWS:
                break
            follow.append(_row(KIND_FOLLOWUP, _text_of(item), index, source=SOURCE_QUEUE, at=_at_of(item)))
        offset = len(follow)
        for index, item in enumerate(_queue_items(_get(cli, "_interrupt_queue"))):
            if len(follow) >= MAX_ROWS:
                break
            follow.append(
                _row(KIND_FOLLOWUP, _text_of(item), offset + index, source=SOURCE_INTERRUPT, at=_at_of(item))
            )
    except Exception:
        pass
    result["followUp"] = follow
    return result


def signature(snap: Optional[Mapping[str, Any]]) -> Any:
    """What the reader can see: enough to tell one snapshot from the next.

    Row ids already hash kind, text and position, so comparing them (plus the
    session) is the same as comparing every visible field, and cheaper than
    hashing the whole snapshot.
    """
    if not isinstance(snap, Mapping):
        return None
    steering = snap.get("steering") or []
    follow = snap.get("followUp") or []
    return (
        snap.get("session_id") or "",
        tuple(row.get("id") for row in steering if isinstance(row, Mapping)),
        tuple(row.get("id") for row in follow if isinstance(row, Mapping)),
    )


# ---------------------------------------------------------------------------
# the observer
# ---------------------------------------------------------------------------


class QueueObserver:
    """Poll a CLI reference and report the snapshots that changed.

    ``get_cli`` is called on every poll and may return None (the CLI has not
    started, or has exited): nothing is emitted then, so a tray that is already
    empty stays empty and no file is touched. ``emit(snapshot, reason)`` runs on
    the observer thread and is wrapped so a failing emit cannot stop the thread.

    The first non-None snapshot is always emitted (reason ``"first"``), which is
    how a tray learns it has a queue at all; afterwards only a change in
    :func:`signature` is emitted, including the change to empty lists that clears
    the tray.
    """

    def __init__(
        self,
        get_cli: Callable[[], Any],
        emit: Callable[[Dict[str, Any], str], Any],
        *,
        interval: float = POLL_SECONDS,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        self._get_cli = get_cli
        self._emit = emit
        self._interval = max(0.01, float(interval))
        self._clock = clock or time.monotonic
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._last_sig: Any = None
        self._first = True
        self.emitted = 0
        self.last_error: Optional[str] = None

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> "QueueObserver":
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return self
            self._stop.clear()
            thread = threading.Thread(target=self._run, name="herdr-queue-observer", daemon=True)
            self._thread = thread
            thread.start()
        return self

    def stop(self, timeout: float = 2.0) -> None:
        """Ask the thread to end and wait briefly for it. Safe to call twice."""
        self._stop.set()
        with self._lock:
            thread = self._thread
            self._thread = None
        if thread is not None and thread.is_alive():
            try:
                thread.join(timeout)
            except Exception:
                pass

    @property
    def thread_alive(self) -> bool:
        thread = self._thread
        return bool(thread is not None and thread.is_alive())

    # -- one poll ----------------------------------------------------------

    def poll_once(self) -> bool:
        """Read once; emit and return True when the visible state changed."""
        try:
            cli = self._get_cli()
        except Exception as error:  # a broken reference is the same as no CLI
            self.last_error = str(error) or error.__class__.__name__
            return False
        if cli is None:
            return False
        try:
            snap = snapshot(cli)
        except Exception as error:
            self.last_error = str(error) or error.__class__.__name__
            return False
        sig = signature(snap)
        if not self._first and sig == self._last_sig:
            return False
        reason = "first" if self._first else "change"
        self._first = False
        self._last_sig = sig
        try:
            self._emit(snap, reason)
            self.emitted += 1
        except Exception as error:
            # the state was recorded before the emit, so a failing sink is not
            # retried on every tick; the next real change is still delivered
            self.last_error = str(error) or error.__class__.__name__
            return False
        return True

    # -- thread body -------------------------------------------------------

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.poll_once()
            except Exception as error:  # pragma: no cover - poll_once already guards
                self.last_error = str(error) or error.__class__.__name__
            if self._stop.wait(self._interval):
                return
