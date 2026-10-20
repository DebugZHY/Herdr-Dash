"""Unit tests for the Hermes -> Herdr-Dash stream bridge.

Run from the repo root:
    python -m unittest bridges/hermes/test_bridge.py -v

The tests import ``herdr_stream.py`` directly so they never load the Hermes
runtime. They exercise real queue/thread/disk behavior into a temp
``HD_STREAM_DIR``.
"""

from __future__ import annotations

import importlib.util
import json
import os
import queue as queue_module
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.join(HERE, "herdr-stream")
IMPL_PATH = os.path.join(PLUGIN_DIR, "herdr_stream.py")
QUEUE_STATE_PATH = os.path.join(PLUGIN_DIR, "queue_state.py")
INIT_PATH = os.path.join(PLUGIN_DIR, "__init__.py")
PLUGIN_YAML = os.path.join(PLUGIN_DIR, "plugin.yaml")


def _load_module(name, path, *, package_dir=None):
    spec = importlib.util.spec_from_file_location(
        name,
        path,
        submodule_search_locations=[package_dir] if package_dir else None,
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


impl = _load_module("herdr_stream_under_test", IMPL_PATH)
queue_state = _load_module("queue_state_under_test", QUEUE_STATE_PATH)
plugin = _load_module("herdr_stream_plugin_under_test", INIT_PATH, package_dir=PLUGIN_DIR)

PANE = "wD:p2"
SESSION = "sess-1"
TURN = "turn-1"


class FakeCtx:
    def __init__(self):
        self.hooks = []

    def register_hook(self, name, callback):
        self.hooks.append((name, callback))


class FakeManager:
    """What ``ctx._manager`` looks like to the plugin: a late-bound CLI reference."""

    def __init__(self, cli=None):
        self._cli_ref = cli


class ManagedCtx(FakeCtx):
    def __init__(self, cli=None):
        super().__init__()
        self._manager = FakeManager(cli)


class FakeAgent:
    """``cli.agent``: one newline-joined steer string behind its own lock."""

    def __init__(self, steer=""):
        self._pending_steer = steer
        self._pending_steer_lock = threading.Lock()


class FakeCli:
    """The three pending queues and nothing else: no Hermes runtime is loaded."""

    def __init__(self, session_id="sess-1", steer=""):
        self.session_id = session_id
        self._pending_input = queue_module.Queue()
        self._interrupt_queue = queue_module.Queue()
        self.agent = FakeAgent(steer)


def wait_for(predicate, timeout=3.0, interval=0.01):
    """Poll ``predicate`` until it is true (the observer owns its own thread)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="herdr-stream-test-")
        self.env = {
            "HERDR_ENV": "1",
            "HERDR_PANE_ID": PANE,
            "HD_STREAM_DIR": self.tmp,
        }
        self.bridge = impl.HermesStreamBridge.from_env(self.env)
        self.assertIsNotNone(self.bridge)
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        try:
            self.bridge.shutdown()
        finally:
            # Windows can hold the file handle briefly after close.
            time.sleep(0.01)
            for root, dirs, files in os.walk(self.tmp, topdown=False):
                for name in files:
                    try:
                        os.unlink(os.path.join(root, name))
                    except OSError:
                        pass
                for name in dirs:
                    try:
                        os.rmdir(os.path.join(root, name))
                    except OSError:
                        pass
            try:
                os.rmdir(self.tmp)
            except OSError:
                pass

    # -- helpers -----------------------------------------------------------

    def pane_dir(self):
        return os.path.join(self.tmp, impl.safe(PANE))

    def turn_path(self, session=SESSION, turn=TURN):
        return os.path.join(self.pane_dir(), f"{impl.safe(session)}__{impl.safe(turn)}.ndjson")

    def read_events(self, session=SESSION, turn=TURN, *, flush=True):
        if flush:
            self.assertTrue(self.bridge.flush(5.0))
        path = self.turn_path(session, turn)
        with open(path, "rb") as handle:
            raw = handle.read()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), "sink must not have a BOM")
        lines = [line for line in raw.split(b"\n") if line]
        return [json.loads(line.decode("utf-8")) for line in lines]

    def start(self, *, turn=TURN, iteration=1, session=SESSION, model="claude-sonnet-4"):
        self.bridge.handle_stream_start(
            {
                "turn_id": turn,
                "iteration": iteration,
                "session_id": session,
                "model": model,
                "provider": "anthropic",
                "surface": "cli",
            }
        )

    def delta(self, text, *, kind="text", turn=TURN, iteration=1, session=SESSION):
        self.bridge.handle_stream_delta(
            {
                "delta": text,
                "kind": kind,
                "turn_id": turn,
                "iteration": iteration,
                "session_id": session,
                "model": "claude-sonnet-4",
                "provider": "anthropic",
                "surface": "cli",
            }
        )

    def assert_envelope(self, event, expected_type):
        self.assertEqual(event["v"], 1)
        self.assertIsInstance(event["seq"], int)
        self.assertIsInstance(event["ts"], int)
        self.assertGreater(event["ts"], 1_600_000_000_000)
        self.assertEqual(event["agent"], "hermes")
        self.assertEqual(event["pane_id"], PANE)
        self.assertEqual(event["type"], expected_type)
        for key in ("session_id", "turn_id"):
            self.assertIsInstance(event[key], str)
            self.assertTrue(event[key])

    # -- text / reasoning --------------------------------------------------

    def test_text_stream_envelopes_and_safe_path(self):
        self.start()
        self.delta("Hel")
        self.delta("lo")
        events = self.read_events()

        self.assertEqual(
            [event["type"] for event in events],
            ["turn_start", "message_start", "text_delta", "text_delta"],
        )
        for event, expected in zip(events, ["turn_start", "message_start", "text_delta", "text_delta"]):
            self.assert_envelope(event, expected)
        self.assertEqual([event["seq"] for event in events], [1, 2, 3, 4])
        self.assertEqual({event["session_id"] for event in events}, {SESSION})
        self.assertEqual({event["turn_id"] for event in events}, {TURN})

        message_start = events[1]
        self.assertEqual(message_start["message_id"], f"{TURN}:1")
        self.assertEqual(message_start["role"], "assistant")
        self.assertEqual(message_start["model"], "claude-sonnet-4")

        for event, text in zip(events[2:], ["Hel", "lo"]):
            self.assertEqual(event["message_id"], f"{TURN}:1")
            self.assertEqual(event["content_index"], 0)
            self.assertEqual(event["delta"], text)

        # Contract path: <root>/<safe(pane)>/<safe(session)>__<safe(turn)>.ndjson
        self.assertEqual(
            os.path.basename(self.turn_path()),
            f"{impl.safe(SESSION)}__{impl.safe(TURN)}.ndjson",
        )
        self.assertTrue(os.path.isdir(self.pane_dir()))
        self.assertEqual(impl.safe(PANE), "wD-p2")
        self.assertEqual(len({event["seq"] for event in events}), len(events))

    def test_reasoning_delta_is_not_text(self):
        self.start()
        self.delta("thinking about it", kind="reasoning")
        self.delta("visible", kind="text")
        events = self.read_events()
        self.assertEqual(
            [event["type"] for event in events],
            ["turn_start", "message_start", "reasoning_delta", "text_delta"],
        )
        reasoning = events[2]
        self.assertEqual(reasoning["delta"], "thinking about it")
        self.assertEqual(reasoning["message_id"], f"{TURN}:1")
        self.assertEqual(reasoning["content_index"], 0)

    def test_turn_start_once_across_iterations(self):
        self.start(iteration=1)
        self.delta("a", iteration=1)
        self.start(iteration=2)
        self.delta("b", iteration=2)
        events = self.read_events()
        self.assertEqual([event["type"] for event in events].count("turn_start"), 1)
        starts = [event for event in events if event["type"] == "message_start"]
        self.assertEqual([event["message_id"] for event in starts], [f"{TURN}:1", f"{TURN}:2"])
        deltas = [event["message_id"] for event in events if event["type"] == "text_delta"]
        self.assertEqual(deltas, [f"{TURN}:1", f"{TURN}:2"])

    def test_delta_before_start_still_opens_with_one_turn_start(self):
        # Hermes dispatches hooks on per-callback worker threads, so a delta can
        # win the race against on_stream_start.
        self.delta("early")
        self.start()
        events = self.read_events()
        self.assertEqual([event["type"] for event in events].count("turn_start"), 1)
        self.assertLess(
            [event["type"] for event in events].index("turn_start"),
            [event["type"] for event in events].index("text_delta"),
        )

    # -- tools -------------------------------------------------------------

    def test_tool_start_and_end(self):
        self.start()
        self.bridge.handle_pre_tool_call(
            {
                "tool_name": "terminal",
                "args": {"command": "echo hi"},
                "task_id": "task",
                "session_id": SESSION,
                "tool_call_id": "tc-1",
                "turn_id": TURN,
                "api_request_id": "api",
                "middleware_trace": [],
            }
        )
        self.bridge.handle_post_tool_call(
            {
                "tool_name": "terminal",
                "args": {"command": "echo hi"},
                "result": "hi\n",
                "task_id": "task",
                "session_id": SESSION,
                "tool_call_id": "tc-1",
                "turn_id": TURN,
                "api_request_id": "api",
                "duration_ms": 12,
                "status": "ok",
                "error_type": None,
                "error_message": None,
                "middleware_trace": [],
            }
        )
        self.bridge.handle_post_tool_call(
            {
                "tool_name": "terminal",
                "args": {"command": "false"},
                "result": "boom",
                "session_id": SESSION,
                "tool_call_id": "tc-2",
                "turn_id": TURN,
                "status": "error",
                "error_type": "tool_error",
                "error_message": "boom",
            }
        )
        events = self.read_events()
        types = [event["type"] for event in events]
        self.assertEqual(types, ["turn_start", "message_start", "tool_start", "tool_end", "tool_end"])

        tool_start = events[2]
        self.assertEqual(tool_start["tool_call_id"], "tc-1")
        self.assertEqual(tool_start["tool"], "terminal")
        self.assertEqual(tool_start["args"], {"command": "echo hi"})
        self.assertNotIn("parent_tool_call_id", tool_start)

        first_end, second_end = events[3], events[4]
        self.assertEqual(first_end["tool_call_id"], "tc-1")
        self.assertEqual(first_end["result"], "hi\n")
        self.assertIs(first_end["is_error"], False)
        self.assertEqual(first_end["duration_ms"], 12)
        self.assertEqual(second_end["tool_call_id"], "tc-2")
        self.assertIs(second_end["is_error"], True)
        for event in (tool_start, first_end, second_end):
            self.assertEqual(event["turn_id"], TURN)
            self.assertEqual(event["session_id"], SESSION)

    def test_tool_parent_id_forwarded(self):
        self.bridge.handle_pre_tool_call(
            {
                "tool_name": "read_file",
                "args": {"path": "a"},
                "session_id": SESSION,
                "tool_call_id": "child-1",
                "turn_id": TURN,
                "parent_tool_call_id": "parent-1",
            }
        )
        events = self.read_events()
        tool_start = [event for event in events if event["type"] == "tool_start"][0]
        self.assertEqual(tool_start["parent_tool_call_id"], "parent-1")

    # -- stream end --------------------------------------------------------

    def test_stream_end_uses_final_text_and_error(self):
        self.start()
        self.delta("partial")
        self.bridge.handle_stream_end(
            {
                "final_text": "final answer",
                "finished": True,
                "error": None,
                "turn_id": TURN,
                "iteration": 1,
                "session_id": SESSION,
            }
        )
        events = self.read_events()
        self.assertEqual(
            [event["type"] for event in events],
            ["turn_start", "message_start", "text_delta", "message_end"],
        )
        message_end = events[-1]
        self.assertEqual(message_end["message_id"], f"{TURN}:1")
        self.assertEqual(message_end["text"], "final answer")

        self.bridge.handle_stream_end(
            {
                "final_text": "",
                "finished": False,
                "error": "provider exploded",
                "turn_id": "turn-2",
                "iteration": 3,
                "session_id": SESSION,
            }
        )
        events = self.read_events(turn="turn-2")
        self.assertEqual([event["type"] for event in events], ["turn_start", "message_end", "error"])
        self.assertEqual(events[1]["message_id"], "turn-2:3")
        self.assertNotIn("text", events[1])
        self.assertEqual(events[2]["message"], "provider exploded")

    def test_never_synthesizes_deltas_from_final_text(self):
        self.start()
        self.bridge.handle_stream_end(
            {
                "final_text": "the whole answer, not a token",
                "finished": True,
                "error": None,
                "turn_id": TURN,
                "iteration": 1,
                "session_id": SESSION,
            }
        )
        events = self.read_events()
        self.assertEqual([event["type"] for event in events], ["turn_start", "message_start", "message_end"])
        self.assertFalse(any(event["type"].endswith("_delta") for event in events))

    # -- session lifecycle -------------------------------------------------

    def test_session_end_emits_turn_end_and_closes_file(self):
        self.start()
        self.delta("done")
        self.bridge.handle_session_end(
            {
                "session_id": SESSION,
                "task_id": "task",
                "turn_id": TURN,
                "completed": True,
                "failed": False,
                "interrupted": False,
                "turn_exit_reason": "final",
                "model": "claude-sonnet-4",
                "platform": "cli",
            }
        )
        self.assertTrue(self.bridge.flush(5.0))
        events = self.read_events(flush=False)
        self.assertEqual(events[-1]["type"], "turn_end")
        self.assertEqual(events[-1]["status"], "complete")

        # A later event for a new turn must land in a different file.
        self.start(turn="turn-2", iteration=1)
        self.delta("next", turn="turn-2")
        second = self.read_events(turn="turn-2")
        self.assertEqual(second[0]["type"], "turn_start")
        self.assertEqual(second[0]["turn_id"], "turn-2")
        self.assertTrue(os.path.exists(self.turn_path(turn=TURN)))

    def test_session_end_status_mapping(self):
        cases = [
            ({"completed": True, "failed": False, "interrupted": False}, "complete"),
            ({"completed": False, "failed": True, "interrupted": False}, "error"),
            ({"completed": False, "failed": False, "interrupted": True}, "aborted"),
            ({"completed": False, "interrupted": False, "turn_exit_reason": "user_interrupt"}, "aborted"),
        ]
        for index, (payload, expected) in enumerate(cases):
            turn = f"status-{index}"
            self.bridge.handle_session_end(
                {"session_id": SESSION, "turn_id": turn, **payload}
            )
            events = self.read_events(turn=turn)
            self.assertEqual(events[-1]["type"], "turn_end")
            self.assertEqual(events[-1]["status"], expected, payload)

    def test_session_reset_closes_and_forgets_current_turn(self):
        self.start()
        self.delta("before reset")
        self.bridge.handle_session_reset(
            {"session_id": SESSION, "platform": "cli", "reason": "new"}
        )
        self.assertTrue(self.bridge.flush(5.0))
        before = self.read_events(flush=False)
        self.assertNotIn("turn_end", [event["type"] for event in before])

        # Next turn opens a new file rather than appending to the old one.
        self.start(turn="after-reset")
        self.delta("new turn", turn="after-reset")
        after = self.read_events(turn="after-reset")
        self.assertEqual([event["type"] for event in after], ["turn_start", "message_start", "text_delta"])

    def test_session_start_settings_go_to_control_file_without_a_turn(self):
        self.bridge.handle_session_start(
            {"session_id": SESSION, "model": "gpt-x", "platform": "cli"}
        )
        events = self.read_events(turn="control")
        self.assertEqual(len(events), 1)
        self.assert_envelope(events[0], "settings")
        self.assertEqual(events[0]["turn_id"], "control")
        self.assertEqual(events[0]["model"], "gpt-x")

    # -- pending-input queue envelopes -------------------------------------

    def test_queue_snapshot_goes_to_control_file_with_the_exact_shape(self):
        self.bridge.handle_queue_snapshot(
            {
                "session_id": SESSION,
                "steering": [{"id": "hq-a", "kind": "steer", "text": "go left", "at": None}],
                "followUp": [
                    {"id": "hq-b", "kind": "followup", "text": "then down", "at": None, "source": "queue"},
                    {"id": "hq-c", "kind": "followup", "text": "and stop", "at": 1700000000000, "source": "interrupt"},
                ],
                "updated_at": 1700000000123,
                "reason": "change",
            }
        )
        events = self.read_events(turn="control")
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assert_envelope(event, "queue")
        self.assertEqual(event["turn_id"], "control")
        self.assertEqual(event["session_id"], SESSION)
        self.assertEqual(event["updated_at"], 1700000000123)
        self.assertEqual(event["reason"], "change")
        # The tray's own shape, no extra fields beyond the documented ones.
        self.assertEqual(event["steering"], [{"id": "hq-a", "kind": "steer", "text": "go left", "at": None}])
        self.assertEqual([row["id"] for row in event["followUp"]], ["hq-b", "hq-c"])
        self.assertEqual([row["kind"] for row in event["followUp"]], ["followup", "followup"])
        self.assertEqual([row["source"] for row in event["followUp"]], ["queue", "interrupt"])
        self.assertEqual(event["followUp"][1]["at"], 1700000000000)
        # A queue event never opens or joins a turn file, and never names the turn.
        self.assertEqual(
            sorted(os.listdir(self.pane_dir())),
            [f"{impl.safe(SESSION)}__control.ndjson"],
        )

    def test_queue_snapshot_empty_still_emits_so_the_tray_clears(self):
        self.bridge.handle_queue_snapshot(
            {"session_id": SESSION, "steering": [], "followUp": [], "reason": "first", "updated_at": 1}
        )
        self.bridge.handle_queue_snapshot({"session_id": SESSION, "steering": [], "followUp": [], "reason": "change"})
        events = self.read_events(turn="control")
        self.assertEqual([event["type"] for event in events], ["queue", "queue"])
        self.assertEqual([event["reason"] for event in events], ["first", "change"])
        for event in events:
            self.assertEqual(event["steering"], [])
            self.assertEqual(event["followUp"], [])
        self.assertIsInstance(events[1]["updated_at"], int)
        self.assertGreater(events[1]["updated_at"], 1_600_000_000_000)

    def test_queue_snapshot_bounds_rows_text_and_total_payload(self):
        huge = "x" * 20_000
        payload = {
            "session_id": SESSION,
            "steering": [{"text": huge}],
            "followUp": [{"text": huge, "kind": "followup"} for _ in range(150)],
        }
        self.bridge.handle_queue_snapshot(payload)
        events = self.read_events(turn="control")
        self.assertEqual(len(events), 1, "an oversized queue must still be delivered, not dropped")
        event = events[0]
        self.assertLessEqual(len(event["followUp"]), impl.QUEUE_MAX_ROWS)
        self.assertLessEqual(len(event["steering"]), impl.QUEUE_MAX_ROWS)
        for row in event["steering"] + event["followUp"]:
            self.assertLessEqual(len(row["text"]), impl.QUEUE_MAX_TEXT_CHARS)
        # The writer drops any line over 64 KiB and cannot shrink a list, so the
        # bridge has to keep the whole envelope well under that.
        self.assertLess(len(json.dumps(event).encode("utf-8")), impl.MAX_LINE_BYTES)
        # An id is invented for a row that arrived without one, and it is opaque.
        self.assertTrue(event["steering"][0]["id"].startswith("hq-"))
        self.assertEqual(len(event["steering"][0]["id"]), 19)

    def test_queue_snapshot_tolerates_malformed_rows_and_payloads(self):
        # No payload, no session, and lists of the wrong type: still one envelope
        # each (under the "unknown" session), still no exception.
        for payload in (
            None,
            {},
            {"steering": "not-a-list", "followUp": {"nope": 1}},
        ):
            with self.subTest(payload=payload):
                self.bridge.handle_queue_snapshot(payload)
        unknown = self.read_events(session="unknown", turn="control")
        self.assertEqual([event["type"] for event in unknown], ["queue"] * 3)
        for event in unknown:
            self.assertEqual(event["steering"], [])
            self.assertEqual(event["followUp"], [])

        # A known session: rows are validated, not trusted.
        self.bridge.handle_queue_snapshot(
            {"session_id": SESSION, "steering": [42, None, "text", {"text": 5}], "followUp": [["a", "b"]]}
        )
        self.bridge.handle_queue_snapshot(
            {"session_id": SESSION, "steering": [{"kind": "unknown-kind", "text": "  two\n lines  "}],
             "reason": 5}
        )
        events = self.read_events(turn="control")
        self.assertEqual([event["type"] for event in events], ["queue", "queue"])
        # Only the mapping survives; a non-mapping row is dropped rather than drawn blank.
        self.assertEqual([row["text"] for row in events[0]["steering"]], ["5"])
        self.assertEqual(events[0]["followUp"], [])
        # An unknown kind falls back to the list's own kind; reason is text, never dropped.
        self.assertEqual(events[1]["steering"][0]["kind"], "steer")
        self.assertEqual(events[1]["steering"][0]["text"], "two lines")
        self.assertEqual(events[1]["reason"], "5")

    # -- disabled / no-op --------------------------------------------------

    def test_no_pane_is_a_strict_noop(self):
        for env in (
            {"HERDR_ENV": "1", "HD_STREAM_DIR": self.tmp},
            {"HERDR_ENV": "1", "HERDR_PANE_ID": "   ", "HD_STREAM_DIR": self.tmp},
            {"HERDR_PANE_ID": PANE, "HD_STREAM_DIR": self.tmp},
            {"HERDR_ENV": "0", "HERDR_PANE_ID": PANE, "HD_STREAM_DIR": self.tmp},
            {"HERDR_ENV": "", "HERDR_PANE_ID": PANE, "HD_STREAM_DIR": self.tmp},
        ):
            self.assertIsNone(impl.HermesStreamBridge.from_env(env), env)
        self.assertEqual(os.listdir(self.tmp), [])

    def test_stream_root_resolution(self):
        self.assertEqual(
            impl.resolve_stream_root({"HD_STREAM_DIR": r"D:\sink"}),
            r"D:\sink",
        )
        self.assertEqual(
            impl.resolve_stream_root({"LOCALAPPDATA": r"C:\Users\x\AppData\Local"}),
            os.path.join(r"C:\Users\x\AppData\Local", "herdr-dash", "streams"),
        )
        self.assertEqual(
            impl.resolve_stream_root({}),
            os.path.join(os.path.expanduser("~"), ".herdr-dash", "streams"),
        )

    def test_concurrent_submitters_keep_seq_unique_and_ordered(self):
        import threading

        self.start()

        def worker(worker_id):
            for index in range(25):
                self.delta(f"{worker_id}-{index}")

        threads = [threading.Thread(target=worker, args=(worker_id,)) for worker_id in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        events = self.read_events()
        seqs = [event["seq"] for event in events]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(seqs), len(set(seqs)))
        self.assertEqual(len([e for e in events if e["type"] == "text_delta"]), 100)

    def test_register_registers_nothing_outside_herdr(self):
        with mock.patch.dict(os.environ, {"HERDR_ENV": "", "HERDR_PANE_ID": ""}, clear=False):
            ctx = FakeCtx()
            plugin.register(ctx)
        self.assertEqual(ctx.hooks, [])
        self.assertEqual(os.listdir(self.tmp), [])

    def test_register_registers_all_declared_hooks_under_herdr(self):
        with mock.patch.dict(
            os.environ,
            {"HERDR_ENV": "1", "HERDR_PANE_ID": PANE, "HD_STREAM_DIR": self.tmp},
            clear=False,
        ):
            ctx = FakeCtx()
            plugin.register(ctx)
        try:
            names = [name for name, _callback in ctx.hooks]
            self.assertEqual(
                names,
                [
                    "on_stream_start",
                    "on_stream_delta",
                    "on_stream_end",
                    "pre_tool_call",
                    "post_tool_call",
                    "on_session_start",
                    "on_session_end",
                    "on_session_reset",
                ],
            )
            # Callbacks must accept **kwargs and return None (pre_tool_call is
            # fail-closed on raises, so this matters).
            for _name, callback in ctx.hooks:
                self.assertIsNone(callback(session_id="s", turn_id="t", iteration=0))
        finally:
            if plugin._bridge is not None:
                plugin._bridge.shutdown()
                plugin._bridge = None
            self.bridge.shutdown()

    def test_plugin_yaml_declares_name_and_hooks(self):
        with open(PLUGIN_YAML, "r", encoding="utf-8") as handle:
            yaml_text = handle.read()
        self.assertIn("name: herdr-stream", yaml_text)
        for hook in (
            "on_stream_start",
            "on_stream_delta",
            "on_stream_end",
            "pre_tool_call",
            "post_tool_call",
            "on_session_end",
            "on_session_reset",
            "on_session_start",
        ):
            self.assertIn(f"- {hook}", yaml_text)

    # -- bounds / cleanup --------------------------------------------------

    def test_bounded_payloads(self):
        huge = "x" * (64 * 1024)
        self.start()
        self.bridge.handle_pre_tool_call(
            {
                "tool_name": "terminal",
                "args": {"blob": huge},
                "session_id": SESSION,
                "tool_call_id": "tc-big",
                "turn_id": TURN,
            }
        )
        self.bridge.handle_post_tool_call(
            {
                "tool_name": "terminal",
                "args": {"blob": huge},
                "result": huge,
                "session_id": SESSION,
                "tool_call_id": "tc-big",
                "turn_id": TURN,
                "status": "ok",
            }
        )
        self.bridge.handle_stream_end(
            {
                "final_text": huge,
                "finished": True,
                "error": None,
                "turn_id": TURN,
                "iteration": 1,
                "session_id": SESSION,
            }
        )
        events = self.read_events()

        tool_start = [event for event in events if event["type"] == "tool_start"][0]
        self.assertIsInstance(tool_start["args"], str)
        self.assertLessEqual(len(tool_start["args"].encode("utf-8")), impl.MAX_FIELD_BYTES)
        self.assertIn(impl.TRUNCATION_MARKER, tool_start["args"])

        tool_end = [event for event in events if event["type"] == "tool_end"][0]
        self.assertLessEqual(len(tool_end["result"].encode("utf-8")), impl.MAX_FIELD_BYTES)
        self.assertTrue(tool_end["result"].endswith(impl.TRUNCATION_MARKER))

        message_end = [event for event in events if event["type"] == "message_end"][0]
        self.assertLessEqual(len(message_end["text"].encode("utf-8")), impl.MAX_FIELD_BYTES)
        self.assertTrue(message_end["text"].endswith(impl.TRUNCATION_MARKER))

        path = self.turn_path()
        with open(path, "rb") as handle:
            for line in handle:
                self.assertLessEqual(len(line), impl.MAX_LINE_BYTES + 1)
                json.loads(line.decode("utf-8"))

    def test_small_payloads_keep_their_json_type(self):
        args = {"command": "echo hi", "n": 3}
        self.bridge.handle_pre_tool_call(
            {
                "tool_name": "terminal",
                "args": args,
                "session_id": SESSION,
                "tool_call_id": "tc-small",
                "turn_id": TURN,
            }
        )
        events = self.read_events()
        tool_start = [event for event in events if event["type"] == "tool_start"][0]
        self.assertEqual(tool_start["args"], args)

    def test_cleanup_keeps_newest_twenty_and_drops_stale_files(self):
        pane_dir = self.pane_dir()
        os.makedirs(pane_dir, exist_ok=True)
        now = time.time()
        fresh = []
        for index in range(25):
            path = os.path.join(pane_dir, f"s__f{index:02d}.ndjson")
            with open(path, "wb") as handle:
                handle.write(b"{}\n")
            os.utime(path, (now - index, now - index))
            fresh.append(path)
        stale = []
        for index in range(3):
            path = os.path.join(pane_dir, f"s__stale{index}.ndjson")
            with open(path, "wb") as handle:
                handle.write(b"{}\n")
            old = now - impl.MAX_AGE_SECONDS - 60 - index
            os.utime(path, (old, old))
            stale.append(path)

        self.start(turn="cleanup-turn")
        self.assertTrue(self.bridge.flush(5.0))

        remaining = sorted(name for name in os.listdir(pane_dir) if name.endswith(".ndjson"))
        self.assertEqual(len(remaining), impl.KEEP_FILES)
        self.assertIn(f"{impl.safe(SESSION)}__{impl.safe('cleanup-turn')}.ndjson", remaining)
        for path in stale:
            self.assertFalse(os.path.exists(path), f"stale file kept: {path}")
        self.assertFalse(os.path.exists(fresh[-1]), "oldest fresh file should be pruned")
        self.assertTrue(os.path.exists(fresh[0]))

    def test_writer_drop_does_not_raise_when_queue_is_full(self):
        writer = impl.StreamWriter(self.tmp, "tiny-pane", max_queue=1)
        try:
            accepted = 0
            for index in range(50):
                if writer.submit(
                    {
                        "agent": "hermes",
                        "pane_id": "tiny-pane",
                        "session_id": "s",
                        "turn_id": "t",
                        "type": "text_delta",
                        "message_id": "t:0",
                        "content_index": 0,
                        "delta": str(index),
                    }
                ):
                    accepted += 1
            # Either accepted or dropped, but never raised, and flush stays sane.
            self.assertLessEqual(accepted, 50)
            self.assertGreaterEqual(writer.dropped, 0)
            writer.flush(5.0)
        finally:
            writer.shutdown()


class QueueStateTest(unittest.TestCase):
    """The read-only snapshot: what is pending, and nothing is ever removed."""

    def test_snapshot_extracts_pending_input_interrupt_queue_and_pending_steer(self):
        cli = FakeCli(session_id="sess-9", steer="hold the elevator")
        cli._pending_input.put("first follow-up")
        cli._pending_input.put(("second, with an image", ["plan.png"]))
        cli._interrupt_queue.put({"display_text": "third, interrupts"})

        snap = queue_state.snapshot(cli)

        self.assertEqual(snap["session_id"], "sess-9")
        self.assertEqual([row["kind"] for row in snap["steering"]], ["steer"])
        self.assertEqual(snap["steering"][0]["text"], "hold the elevator")
        self.assertIsNone(snap["steering"][0]["at"])

        self.assertEqual(
            [row["text"] for row in snap["followUp"]],
            ["first follow-up", "second, with an image", "third, interrupts"],
        )
        self.assertEqual([row["kind"] for row in snap["followUp"]], ["followup"] * 3)
        self.assertEqual([row["source"] for row in snap["followUp"]], ["queue", "queue", "interrupt"])
        self.assertEqual([row["at"] for row in snap["followUp"]], [None, None, None])

        ids = [row["id"] for row in snap["followUp"]]
        self.assertEqual(len(set(ids)), 3)
        for row_id in ids + [snap["steering"][0]["id"]]:
            self.assertTrue(row_id.startswith("hq-"), row_id)
            self.assertEqual(len(row_id), 19)

        # An observer must not consume what the agent is about to run.
        self.assertEqual(cli._pending_input.qsize(), 2)
        self.assertEqual(cli._interrupt_queue.qsize(), 1)
        self.assertEqual(cli.agent._pending_steer, "hold the elevator")

        # Deterministic: the same queue produces the same ids for the tray.
        self.assertEqual(queue_state.snapshot(cli), snap)

    def test_snapshot_reads_objects_with_text_and_a_latebound_lock(self):
        class Item:
            def __init__(self, text):
                self.text = text

        class Agent:
            _pending_steer = "steer through the attribute"

        cli = type("Cli", (), {"agent": Agent(), "_pending_input": [Item("from text"), "plain"],
                               "_interrupt_queue": None, "session": {"id": "nested-session"}})()
        snap = queue_state.snapshot(cli)
        self.assertEqual([row["text"] for row in snap["followUp"]], ["from text", "plain"])
        self.assertEqual([row["source"] for row in snap["followUp"]], ["queue", "queue"])
        self.assertEqual(snap["steering"][0]["text"], "steer through the attribute")
        self.assertEqual(snap["session_id"], "nested-session")

    def test_snapshot_never_raises_on_missing_fields_broken_locks_or_objects(self):
        class Explodes:
            def __getattr__(self, name):
                raise RuntimeError("no attribute " + name)

        class BrokenLock:
            def __enter__(self):
                raise RuntimeError("lock is unusable")

            def __exit__(self, *exc_info):
                return False

        class Agent:
            _pending_steer = "still readable"

        agent = Agent()
        agent._pending_steer_lock = BrokenLock()
        cli = type("Cli", (), {"agent": agent, "_pending_input": Explodes()})()

        self.assertEqual(
            queue_state.snapshot(None),
            {"steering": [], "followUp": [], "session_id": ""},
        )
        empty = queue_state.snapshot(object())
        self.assertEqual(empty["followUp"], [])
        self.assertEqual(empty["steering"], [])

        broken = queue_state.snapshot(Explodes())
        self.assertEqual(broken, {"steering": [], "followUp": [], "session_id": ""})

        snap = queue_state.snapshot(cli)
        # The queue explodes -> no rows; the steer value is still readable past its lock.
        self.assertEqual(snap["followUp"], [])
        self.assertEqual(snap["steering"][0]["text"], "still readable")

    def test_snapshot_bounds_rows_and_text(self):
        cli = FakeCli()
        for index in range(150):
            cli._pending_input.put("item-%d" % index)
        cli._interrupt_queue.put("one too many")
        cli.agent._pending_steer = "s" * 10_000

        snap = queue_state.snapshot(cli)

        self.assertEqual(len(snap["followUp"]), queue_state.MAX_ROWS)
        self.assertEqual(snap["followUp"][0]["text"], "item-0")
        self.assertEqual(snap["followUp"][-1]["text"], "item-99")
        self.assertEqual(len(snap["steering"][0]["text"]), queue_state.MAX_TEXT_CHARS)
        # Bounding the snapshot did not touch the CLI's own queues.
        self.assertEqual(cli._pending_input.qsize(), 150)

    def test_row_ids_are_opaque_stable_and_distinct(self):
        first = queue_state.row_id("followup", "same words", 0)
        self.assertEqual(first, queue_state.row_id("followup", "same words", 0))
        self.assertNotEqual(first, queue_state.row_id("followup", "same words", 1))
        self.assertNotEqual(first, queue_state.row_id("followup", "other words", 0))
        self.assertNotEqual(first, queue_state.row_id("steer", "same words", 0))
        self.assertNotIn("same", first)
        self.assertTrue(first.startswith("hq-"))


class QueueObserverTest(unittest.TestCase):
    """The 750 ms poll: one thread, one emit per visible change, stoppable."""

    def test_emits_once_when_the_cli_appears_then_only_on_change_and_stops(self):
        cli = FakeCli(steer="")
        holder = {"cli": None}
        seen = []
        observer = queue_state.QueueObserver(
            lambda: holder["cli"], lambda snap, reason: seen.append((reason, snap)), interval=0.02
        )
        observer.start()
        try:
            self.assertTrue(observer.thread_alive)
            time.sleep(0.1)
            self.assertEqual(seen, [], "no CLI yet: nothing may be written")

            holder["cli"] = cli
            self.assertTrue(wait_for(lambda: len(seen) == 1), "the first snapshot must be emitted")
            self.assertEqual(seen[0][0], "first")
            self.assertEqual(seen[0][1]["followUp"], [])

            time.sleep(0.15)
            self.assertEqual(len(seen), 1, "an unchanged queue must not re-emit")

            cli._pending_input.put("next step")
            self.assertTrue(wait_for(lambda: len(seen) == 2))
            self.assertEqual(seen[1][0], "change")
            self.assertEqual([row["text"] for row in seen[1][1]["followUp"]], ["next step"])

            cli._pending_input.get()  # the agent takes it (test-only drain)
            self.assertTrue(wait_for(lambda: len(seen) == 3), "the cleared queue must be emitted")
            self.assertEqual(seen[2][1]["followUp"], [])
        finally:
            observer.stop()

        self.assertFalse(observer.thread_alive)
        self.assertEqual(observer.emitted, 3)
        cli._pending_input.put("after stop")
        time.sleep(0.1)
        self.assertEqual(len(seen), 3, "a stopped observer must not keep polling")

    def test_no_emit_without_a_cli_and_a_broken_emit_does_not_kill_the_thread(self):
        holder = {"cli": None}
        calls = []

        def emit(snap, reason):
            calls.append(reason)
            if len(calls) == 1:
                raise RuntimeError("sink is down")

        observer = queue_state.QueueObserver(lambda: holder["cli"], emit, interval=0.02)
        observer.start()
        try:
            time.sleep(0.1)
            self.assertEqual(calls, [])
            self.assertIsNone(observer.last_error)

            holder["cli"] = FakeCli()
            self.assertTrue(wait_for(lambda: len(calls) == 1))
            self.assertTrue(observer.thread_alive, "a failing sink must not stop the poll")
            self.assertIn("sink is down", observer.last_error or "")

            holder["cli"] = FakeCli(steer="a real change")
            self.assertTrue(wait_for(lambda: len(calls) == 2))
            self.assertEqual(calls[1], "change")
        finally:
            observer.stop()

    def test_a_raising_cli_reference_is_treated_as_no_cli(self):
        def get_cli():
            raise RuntimeError("manager went away")

        observer = queue_state.QueueObserver(get_cli, lambda snap, reason: None, interval=0.02)
        self.assertFalse(observer.poll_once())
        self.assertIn("manager went away", observer.last_error or "")


class PluginObserverWiringTest(unittest.TestCase):
    """``register`` starts exactly one observer, and only where a CLI manager exists."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="herdr-stream-observer-test-")
        self.env = mock.patch.dict(
            os.environ,
            {"HERDR_ENV": "1", "HERDR_PANE_ID": PANE, "HD_STREAM_DIR": self.tmp},
            clear=False,
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        try:
            plugin._stop_observer()
        except Exception:
            pass
        if plugin._bridge is not None:
            try:
                plugin._bridge.shutdown()
            finally:
                plugin._bridge = None
        for root, dirs, files in os.walk(self.tmp, topdown=False):
            for name in files:
                try:
                    os.unlink(os.path.join(root, name))
                except OSError:
                    pass
            for name in dirs:
                try:
                    os.rmdir(os.path.join(root, name))
                except OSError:
                    pass
        try:
            os.rmdir(self.tmp)
        except OSError:
            pass

    def test_no_manager_means_no_thread(self):
        ctx = FakeCtx()
        plugin.register(ctx)
        self.assertIsNone(plugin._observer)
        self.assertEqual(len(ctx.hooks), 8)

    def test_one_observer_per_register_and_the_previous_one_stops(self):
        ctx = ManagedCtx()  # _cli_ref is None until the CLI starts
        plugin.register(ctx)
        first = plugin._observer
        self.assertIsNotNone(first)
        self.assertTrue(first.thread_alive)

        plugin.register(ctx)
        second = plugin._observer
        self.assertIsNotNone(second)
        self.assertIsNot(second, first)
        self.assertFalse(first.thread_alive, "the replaced observer must be stopped")

        # The observer reads _cli_ref live, so a CLI that appears later is seen.
        ctx._manager._cli_ref = FakeCli(steer="started late")
        self.assertTrue(wait_for(lambda: second.emitted >= 1), "a late CLI must be picked up")
        plugin._stop_observer()
        self.assertFalse(second.thread_alive)


if __name__ == "__main__":
    unittest.main(verbosity=2)
