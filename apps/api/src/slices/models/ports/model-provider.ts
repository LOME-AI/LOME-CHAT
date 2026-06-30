import type { z } from 'zod';
import type {
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
} from '@hushbox/shared';

/**
 * One server-side tool the model may call during an agentic loop. The
 * registry is closed: callers resolve definitions from their own closed set
 * and inject them per call — adapters never know concrete tools.
 */
export interface ToolDefinition {
  readonly description: string;
  readonly inputSchema: z.ZodType;
  execute(input: unknown): Promise<unknown>;
}

export type ToolRegistry = Readonly<Record<string, ToolDefinition>>;

/**
 * Enables the SDK's multi-step tool loop inside the adapter. `maxSteps` is
 * the hard step ceiling (each step is its own gateway generation); it feeds
 * admission estimates upstream the same way fan-out width does.
 */
export interface ToolLoopOptions {
  readonly registry: ToolRegistry;
  readonly maxSteps: number;
}

export interface InferOptions {
  /** Cooperative cancel — wired through the SDK to abort the gateway fetch. */
  readonly signal?: AbortSignal;
  readonly tools?: ToolLoopOptions;
  /**
   * Maps multi-output `file` parts (a text+image model streaming through the
   * language call-shape) to media-start/media-done events. Where the bytes
   * rest is the caller's decision (the engine's ValueStore seam), never the
   * adapter's. Required whenever the model can emit file parts.
   */
  readonly mapFilePart?: FilePartMapper;
}

/**
 * The modality-agnostic inference port. One adapter per SDK call-shape
 * family implements it; dispatch by output family lives with the catalog.
 * Expected failures travel as thrown `InferenceError`s — the stream has no
 * error event variant.
 */
export interface ModelProvider {
  infer(
    request: InferenceRequest,
    descriptor: ModelDescriptor,
    options?: InferOptions
  ): AsyncIterable<InferenceEvent>;
}
