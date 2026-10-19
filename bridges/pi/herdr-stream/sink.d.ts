/**
 * Types for `sink.js` (plain CommonJS, loaded by pi's jiti loader and by the Node
 * tests). Runtime shape: `module.exports = { createWriter, createPiBridge, ... }`,
 * which both `import x from "./sink.js"` and `require()` resolve to the same object.
 */

export interface WriterStats {
  enabled: boolean;
  seq: number;
  written: number;
  dropped: number;
  failures: number;
  queued: number;
  turnId: string;
  file: string;
  sessionId: string;
}

/** The raw writer: one turn file per run, an async FIFO, no synchronous I/O. */
export interface HerdrStreamWriter {
  readonly enabled: boolean;
  readonly disabledReason: string;
  readonly root: string;
  readonly paneId: string;
  turnStart(event: unknown, ctx?: unknown): unknown;
  messageStart(event: unknown, ctx?: unknown): unknown;
  messageUpdate(event: unknown, ctx?: unknown): unknown;
  messageEnd(event: unknown, ctx?: unknown): unknown;
  toolStart(event: unknown, ctx?: unknown): unknown;
  toolUpdate(event: unknown, ctx?: unknown): unknown;
  toolEnd(event: unknown, ctx?: unknown): unknown;
  settled(event: unknown, ctx?: unknown): unknown;
  modelSelect(event: unknown, ctx?: unknown): unknown;
  thinkingLevelSelect(event: unknown, ctx?: unknown): unknown;
  shutdown(event: unknown, ctx?: unknown): unknown;
  flush(timeoutMs?: number): Promise<void>;
  stats(): WriterStats;
}

/** What `index.ts` consumes: the writer plus the total, never-throwing handlers. */
export interface PiBridge {
  readonly enabled: boolean;
  readonly disabledReason: string;
  readonly root: string;
  readonly paneId: string;
  readonly writer: HerdrStreamWriter;
  stats(): WriterStats;
  flush(timeoutMs?: number): Promise<void>;
  turnStart(event: unknown, ctx?: unknown): void;
  messageStart(event: unknown, ctx?: unknown): void;
  messageUpdate(event: unknown, ctx?: unknown): void;
  messageEnd(event: unknown, ctx?: unknown): void;
  toolStart(event: unknown, ctx?: unknown): void;
  toolUpdate(event: unknown, ctx?: unknown): void;
  toolEnd(event: unknown, ctx?: unknown): void;
  settled(event: unknown, ctx?: unknown): Promise<void>;
  modelSelect(event: unknown, ctx?: unknown): void;
  thinkingLevelSelect(event: unknown, ctx?: unknown): void;
  shutdown(event: unknown, ctx?: unknown): Promise<void>;
}

export interface BridgeOptions {
  env?: Record<string, string | undefined>;
  homedir?: string;
  now?: () => number;
  seqStart?: number;
  keepFiles?: number;
  maxAgeMs?: number;
  maxQueue?: number;
  logIntervalMs?: number;
}

export declare function createWriter(opts?: BridgeOptions): HerdrStreamWriter;
export declare function createPiBridge(opts?: BridgeOptions): PiBridge;
export declare function sessionOf(ctx: unknown): string;

declare const herdrStream: {
  VERSION: number;
  AGENT: string;
  QUEUE_MAX: number;
  KEEP_TURN_FILES: number;
  MAX_AGE_MS: number;
  createWriter: typeof createWriter;
  createPiBridge: typeof createPiBridge;
  sessionOf: typeof sessionOf;
};

export default herdrStream;
