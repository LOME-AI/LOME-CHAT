import type { z } from 'zod';
import type {
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
} from '@hushbox/shared';

/**
 * A PROVIDER-executed ("server-side") tool: its work happens inside the model
 * provider (e.g. OpenRouter's `openrouter:web_search`), so it carries no client
 * `execute`. The adapter builds the concrete provider tool from this spec —
 * `kind` selects which provider tool, `args` is forwarded verbatim (an engine
 * pin, result cap, …). This keeps the registry provider-agnostic: the domain
 * names the capability, the adapter owns the SDK construction.
 */
export interface ProviderToolSpec {
  readonly kind: 'web-search';
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * One tool the model may call during an agentic loop. The registry is closed:
 * callers resolve definitions from their own closed set and inject them per
 * call — adapters never know concrete tools by name, only by shape. A plain
 * tool is client-executed via `execute`; when `providerTool` is present the
 * adapter builds a provider-executed server tool from it instead and `execute`
 * is a defensive stub the provider never invokes.
 */
export interface ToolDefinition {
  readonly description: string;
  readonly inputSchema: z.ZodType;
  execute(input: unknown): Promise<unknown>;
  readonly providerTool?: ProviderToolSpec;
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
  /**
   * Upper bound (bytes) on a downloaded media artifact — the run's remaining
   * ValueStore budget, threaded from the engine as a plain value so a large
   * video aborts mid-download before the whole blob materializes in the
   * isolate. Enforced only on the video download (the one path that
   * materializes a full artifact outside the SDK). Absent leaves the download
   * bounded solely by the provider/SDK default.
   */
  readonly downloadByteCap?: number;
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
