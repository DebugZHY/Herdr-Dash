"""Herdr-Dash token-stream plugin for Hermes Agent.

Registers observer hooks that append contract envelopes to the Herdr-Dash NDJSON
sink. See ``herdr_stream.py`` for the mapping/writer; this file only adapts the
plugin API and keeps every callback non-raising and fast (the writer queue does
the disk work).

Safety:
- When ``HERDR_ENV != "1"`` or ``HERDR_PANE_ID`` is missing, ``register`` adds
  no hooks at all: the plugin writes nothing and does not make Hermes take the
  streaming path on a non-Herdr run.
- Reasoning deltas need ``plugins.stream_reasoning_deltas: true`` in Hermes
  config; without it Hermes never emits ``kind="reasoning"``.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import sys

logger = logging.getLogger(__name__)

_bridge = None


def _load_impl():
    """Load ``herdr_stream.py`` from this directory.

    Hermes imports a directory plugin as ``hermes_plugins.<slug>`` with
    ``__path__`` set, so a relative import works. The file-based fallback keeps
    the module importable when the directory is loaded under another name.
    """
    try:
        from . import herdr_stream as impl  # type: ignore

        return impl
    except Exception:
        pass
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "herdr_stream.py")
    module_name = "herdr_stream_impl"
    existing = sys.modules.get(module_name)
    if existing is not None and getattr(existing, "__file__", None) == path:
        return existing
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load herdr_stream from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


_impl = _load_impl()


# ---------------------------------------------------------------------------
# hook adapters -- never raise, never block
# ---------------------------------------------------------------------------


def _on_stream_start(**payload):
    bridge = _bridge
    if bridge is None:
        return None
    bridge.handle_stream_start(payload)
    return None


def _on_stream_delta(**payload):
    bridge = _bridge
    if bridge is None:
        return None
    bridge.handle_stream_delta(payload)
    return None


def _on_stream_end(**payload):
    bridge = _bridge
    if bridge is None:
        return None
    bridge.handle_stream_end(payload)
    return None


def _on_pre_tool_call(**payload):
    bridge = _bridge
    if bridge is None:
        return None
    bridge.handle_pre_tool_call(payload)
    return None


def _on_post_tool_call(**payload):
    bridge = _bridge
    if bridge is None:
        return None
    bridge.handle_post_tool_call(payload)
    return None


def _on_session_start(**payload):
    bridge = _bridge
    if bridge is None:
        return None
    bridge.handle_session_start(payload)
    return None


def _on_session_end(**payload):
    bridge = _bridge
    if bridge is None:
        return None
    bridge.handle_session_end(payload)
    return None


def _on_session_reset(**payload):
    bridge = _bridge
    if bridge is None:
        return None
    bridge.handle_session_reset(payload)
    return None


_HOOKS = (
    ("on_stream_start", _on_stream_start),
    ("on_stream_delta", _on_stream_delta),
    ("on_stream_end", _on_stream_end),
    ("pre_tool_call", _on_pre_tool_call),
    ("post_tool_call", _on_post_tool_call),
    ("on_session_start", _on_session_start),
    ("on_session_end", _on_session_end),
    ("on_session_reset", _on_session_reset),
)


def register(ctx):
    """Hermes plugin entrypoint: observe this pane's stream when under Herdr."""
    global _bridge
    bridge = _impl.HermesStreamBridge.from_env()
    if bridge is None:
        # Strict no-op outside Herdr (or without a pane): register nothing.
        return
    previous = _bridge
    if previous is not None:
        try:
            previous.shutdown()
        except Exception:
            pass
    _bridge = bridge
    for hook_name, callback in _HOOKS:
        try:
            ctx.register_hook(hook_name, callback)
        except Exception:
            logger.debug("herdr-stream: failed to register %s", hook_name, exc_info=True)
