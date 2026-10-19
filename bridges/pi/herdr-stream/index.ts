/**
 * herdr-stream (pi extension): append pi's real token stream to the Herdr-Dash NDJSON
 * sink, so the dashboard can render assistant text/reasoning as it is generated.
 *
 * Contract: `_scratch/stream-round/CONTRACT.md` §2 (sink), §3 (envelope), §4 (pi
 * mapping). This extension is an OBSERVER ONLY: it registers handlers, writes lines
 * and returns nothing. It never aborts, never changes a model, a session or a tool
 * result, and it never throws into the agent loop.
 *
 * Gating (§4): nothing at all is written unless `HERDR_ENV=1` and `HERDR_PANE_ID` is
 * set — the pane id is also the directory the dashboard tails.
 *
 * The whole mapping/writer path lives in `mapping.js` + `sink.js` as plain CommonJS,
 * so `test/pi-bridge.test.mjs` can require it without a TypeScript build. This file is
 * only the wiring.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import herdrStream from "./sink.js";

type Handler = (event: any, ctx: any) => unknown;

export default function herdrStreamExtension(pi: ExtensionAPI) {
	const bridge = herdrStream.createPiBridge({ env: process.env });

	/**
	 * Register one handler. Registration itself is guarded (an older pi without an
	 * event must still load the extension), and the handler body is guarded again so a
	 * bridge bug can only ever cost us a stream line, never the agent loop.
	 */
	const on = (name: string, fn: Handler) => {
		try {
			(pi.on as any)(name, async (event: any, ctx: any) => {
				try {
					await fn(event, ctx);
				} catch (err) {
					// swallow: §4 "never throw into pi"
				}
			});
		} catch (err) {
			// an unknown event name on an older pi is not a startup failure
		}
	};

	// §4 turn boundary. pi emits turn_start per LLM request (so a tool-using run emits
	// several); sink.js keeps ONE turn file per run and only opens a new one when the
	// previous run has settled.
	on("session_start", (event, ctx) => bridge.sessionStart(event, ctx));
	on("turn_start", (event, ctx) => bridge.turnStart(event, ctx));

	// §4 messages. Only `assistant`/`user` map to envelopes; toolResult/custom are skipped.
	on("message_start", (event, ctx) => bridge.messageStart(event, ctx));
	on("message_update", (event, ctx) => bridge.messageUpdate(event, ctx));
	on("message_end", (event, ctx) => bridge.messageEnd(event, ctx));

	// §4 execution side of a tool call (`tool_call_*` comes from message_update).
	on("tool_execution_start", (event) => bridge.toolStart(event));
	on("tool_execution_update", (event) => bridge.toolUpdate(event));
	on("tool_execution_end", (event) => bridge.toolEnd(event));

	// §4 end of run -> turn_end (+ close). Returns a promise so pi waits for the flush.
	on("agent_settled", (event, ctx) => bridge.settled(event, ctx));

	// §4 settings: into the open turn file, else `<session>__control.ndjson`.
	on("model_select", (event, ctx) => bridge.modelSelect(event, ctx));
	on("thinking_level_select", (event, ctx) => bridge.thinkingLevelSelect(event, ctx));

	// §4 teardown: an open turn is force-closed (aborted) and flushed.
	on("session_shutdown", (event, ctx) => bridge.shutdown(event, ctx));

	registerControlCommands(pi);
}

/* ── wave 2: the pi control plane ─────────────────────────────────────────────
 *
 * Herdr-Dash cannot drive sessions, models or a run's stop by typing at the TUI: `/resume`
 * opens a selector that disturbs the composer, `/model` is the picker, and a cancel key can
 * kill the process. These four commands are the dashboard's only writes, and each one goes
 * through pi's own context methods:
 *
 *   /herdr-resume <absolute .jsonl path>   ctx.switchSession(path)
 *   /herdr-model <provider>/<modelId>      ctx.modelRegistry.find + pi.setModel
 *   /herdr-abort                           ctx.abort()   (never ctx.shutdown())
 *   /herdr-new                             ctx.newSession()
 *
 * Rules: a no-op outside a Herdr pane, never throw into pi, never leave the session
 * directory, and print exactly one short line.
 */

/** pi receives the text after the command name, so a Windows path with spaces survives. */
function inHerdrPane(): boolean {
	return process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
}

/** Case-insensitive on Windows; anything not strictly inside `dir` is refused. */
function insideDir(dir: string, file: string): boolean {
	const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
	const rel = path.relative(fold(path.resolve(dir)), fold(path.resolve(file)));
	return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

type Say = { line: string; type?: "info" | "warning" | "error" };

type ControlContext = {
	waitForIdle(): Promise<void>;
	newSession(options?: unknown): Promise<{ cancelled?: boolean }>;
	switchSession(sessionPath: string, options?: unknown): Promise<{ cancelled?: boolean }>;
	abort(): void;
	signal?: AbortSignal;
	sessionManager: { getSessionDir(): string };
	modelRegistry: { find(provider: string, modelId: string): unknown };
	ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
};

export function registerControlCommands(pi: ExtensionAPI): void {
	const register = (name: string, description: string,
		run: (argument: string, ctx: ControlContext) => Promise<Say>) => {
		try {
			pi.registerCommand(name, {
				description,
				handler: async (args: string, ctx: unknown) => {
					const c = ctx as ControlContext;
					let say: Say;
					try {
						if (!inHerdrPane()) {
							say = { line: name + ": not a Herdr pane — nothing was sent" };
						} else {
							say = await run(String(args || "").trim(), c);
						}
					} catch (err) {
						say = { line: name + ": failed — " + (err instanceof Error ? err.message : String(err)), type: "error" };
					}
					try {
						c.ui?.notify(say.line, say.type || "info");
					} catch (err) {
						// no UI (print/RPC mode): the line is simply not shown
					}
				},
			});
		} catch (err) {
			// an older pi without registerCommand must still load this extension
		}
	};

	register("herdr-resume", "Herdr-Dash: resume an absolute pi session file (no selector)",
		async (argument, ctx) => {
			if (!argument) return { line: "herdr-resume: usage /herdr-resume <absolute .jsonl path>", type: "warning" };
			if (!path.isAbsolute(argument)) return { line: "herdr-resume: not an absolute path", type: "warning" };
			const file = path.resolve(argument);
			if (!/\.jsonl$/i.test(file)) return { line: "herdr-resume: not a .jsonl file", type: "warning" };
			let dir = "";
			try {
				dir = ctx.sessionManager.getSessionDir();
			} catch (err) {
				return { line: "herdr-resume: this pi has no session directory", type: "warning" };
			}
			if (!dir || !insideDir(dir, file)) {
				return { line: "herdr-resume: path is outside the session directory", type: "warning" };
			}
			let stat;
			try {
				stat = fs.statSync(file);
			} catch (err) {
				return { line: "herdr-resume: file not found", type: "warning" };
			}
			if (!stat.isFile()) return { line: "herdr-resume: not a file", type: "warning" };
			await ctx.waitForIdle();
			const result = await ctx.switchSession(file);
			if (result && result.cancelled) return { line: "herdr-resume: cancelled", type: "warning" };
			return { line: "herdr-resume: " + path.basename(file) };
		});

	register("herdr-model", "Herdr-Dash: switch to <provider>/<modelId> (no picker)",
		async (argument, ctx) => {
			const at = argument.indexOf("/");
			if (at <= 0 || at === argument.length - 1) {
				return { line: "herdr-model: usage /herdr-model <provider>/<model>", type: "warning" };
			}
			const provider = argument.slice(0, at);
			const modelId = argument.slice(at + 1);
			const model = ctx.modelRegistry.find(provider, modelId);
			if (!model) return { line: "herdr-model: unknown model " + provider + "/" + modelId, type: "warning" };
			const okSet = await pi.setModel(model);
			if (okSet === false) return { line: "herdr-model: the session refused " + provider + "/" + modelId, type: "warning" };
			return { line: "herdr-model: " + provider + "/" + modelId };
		});

	register("herdr-abort", "Herdr-Dash: abort the current run (never shuts pi down)",
		async (_argument, ctx) => {
			if (!ctx.signal) return { line: "herdr-abort: nothing is running" };
			ctx.abort();
			return { line: "herdr-abort: aborted" };
		});

	register("herdr-new", "Herdr-Dash: start a new pi session",
		async (_argument, ctx) => {
			await ctx.waitForIdle();
			const result = await ctx.newSession();
			if (result && result.cancelled) return { line: "herdr-new: cancelled", type: "warning" };
			return { line: "herdr-new: new session" };
		});
}
