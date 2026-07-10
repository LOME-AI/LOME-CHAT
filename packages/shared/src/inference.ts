import { z } from 'zod';
import { MediaValue } from './content-value.js';
import { Modality } from './modality.js';

/**
 * Multimodal I/O contract — replaces the text-or-one-blob event model.
 * Text rides inline; media inputs ride by reference (request-body staging or
 * the short-TTL `inputs/` fallback). Extending input modalities = add a
 * variant here alongside the enum migration (rare, deliberate).
 */
export const MediaRef = z.object({
  ref: z.string().min(1),
  mimeType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
});

export type MediaRef = z.infer<typeof MediaRef>;

export const InputPart = z.discriminatedUnion('modality', [
  z.object({ modality: z.literal('text'), text: z.string() }),
  z.object({ modality: z.literal('image'), ref: MediaRef }),
  z.object({ modality: z.literal('audio'), ref: MediaRef }),
  z.object({ modality: z.literal('video'), ref: MediaRef }),
]);

export type InputPart = z.infer<typeof InputPart>;

/**
 * One prior turn of client-supplied conversation history. Content is
 * E2E-encrypted at rest, so the server cannot reconstruct history — the client
 * decrypts and resends it each turn (stateless). Deliberately unbounded: no
 * count cap, no length cap, no alternation constraint (founder ruling); the
 * engine/platform byte budgets and the trial price gate are the only limits.
 */
export const ChatHistoryMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

export type ChatHistoryMessage = z.infer<typeof ChatHistoryMessage>;

export const InferenceRequest = z.object({
  model: z.string().min(1),
  inputs: z.array(InputPart),
  parameters: z.record(z.string(), z.unknown()), // validated against descriptor.parameters
  outputs: z.array(Modality),
  /**
   * PRIOR turns only, oldest first — the current turn rides `inputs` and the
   * language adapter appends it last. Absent means exactly the single-message
   * behavior that predates history.
   */
  history: z.array(ChatHistoryMessage).optional(),
  /**
   * Client-supplied plaintext custom instructions, folded into the base system
   * prompt. Stored instructions are E2E-encrypted (the server cannot decrypt the
   * blob), so — like `history` — the client decrypts and resends them each turn.
   * Absent leaves the base system prompt untouched.
   */
  customInstructions: z.string().max(5000).optional(),
});

export type InferenceRequest = z.infer<typeof InferenceRequest>;

/**
 * Terminal finish reasons — mirrors the ai v6 SDK's `FinishReason` union
 * exactly (the SDK maps unmapped provider reasons to `other`). `length` with
 * empty output is billable terminal success — truncation, not error; that
 * semantic lives in consumers, the event only carries the reason.
 */
export const FINISH_REASONS = [
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'other',
] as const;

export const FinishReason = z.enum(FINISH_REASONS);
export type FinishReason = z.infer<typeof FinishReason>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
});

export type Usage = z.infer<typeof Usage>;

/**
 * Terminal metadata: observed usage feeds the settlement estimate;
 * `generationId` keys a per-generation record (absent on multi-step runs,
 * where each step-finish carries its own id). `providerCostUsd` is the raw
 * provider-charged cost in USD read inline off the response — the billing
 * truth settlement charges directly (no true-up); absent when the provider
 * returns no inline cost (image generation, or the pathological missing-cost
 * path), where settlement falls back to the deterministic estimate. Carried
 * as the raw USD number; nano-USD conversion happens at settlement.
 */
export const ProviderMetadata = z.object({
  generationId: z.string().min(1).optional(),
  usage: Usage,
  finishReason: FinishReason,
  providerCostUsd: z.number().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

export type ProviderMetadata = z.infer<typeof ProviderMetadata>;

export const ToolCall = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown(),
});

export type ToolCall = z.infer<typeof ToolCall>;

export const ToolResult = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  result: z.unknown(),
});

export type ToolResult = z.infer<typeof ToolResult>;

/**
 * The extended streaming event union: text/reasoning deltas,
 * agentic tool activity with per-step generations (each step's generationId
 * feeds its own usage_records row), media events, and the terminal finish.
 */
export const InferenceEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text-delta'), index: z.number(), content: z.string() }),
  z.object({ kind: z.literal('reasoning-delta'), index: z.number(), content: z.string() }),
  ToolCall.extend({ kind: z.literal('tool-call') }),
  ToolResult.extend({ kind: z.literal('tool-result') }),
  z.object({ kind: z.literal('step-start'), step: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('step-finish'),
    step: z.number().int().nonnegative(),
    generationId: z.string().min(1),
    // Per-step provider cost (USD) for an agentic step, read inline off the
    // step's response; summed across steps into the run's terminal cost.
    providerCostUsd: z.number().optional(),
  }),
  z.object({
    kind: z.literal('media-start'),
    index: z.number(),
    modality: Modality,
    mimeType: z.string().min(1),
  }),
  z.object({ kind: z.literal('media-done'), index: z.number(), value: MediaValue }),
  z.object({ kind: z.literal('finish'), metadata: ProviderMetadata }),
]);

export type InferenceEvent = z.infer<typeof InferenceEvent>;

/**
 * Multi-output rule: a text+image model streams `file` parts through
 * the *language* call-shape; the language adapter maps each file part to a
 * media-start/media-done event pair.
 */
export const FilePart = z.object({
  mediaType: z.string().min(1),
  data: z.instanceof(Uint8Array),
});

export type FilePart = z.infer<typeof FilePart>;

type EventOfKind<K extends InferenceEvent['kind']> = Extract<InferenceEvent, { kind: K }>;

export type FilePartMediaEvents = readonly [EventOfKind<'media-start'>, EventOfKind<'media-done'>];

export type FilePartMapper = (part: FilePart, index: number) => FilePartMediaEvents;

/**
 * The persisted tool-step shape (mirrored by the llm-completions content rows):
 * one gateway generation per agentic step, with the step's tool activity.
 */
export const PersistedToolStep = z.object({
  step: z.number().int().nonnegative(),
  generationId: z.string().min(1),
  toolCalls: z.array(ToolCall),
  toolResults: z.array(ToolResult),
});

export type PersistedToolStep = z.infer<typeof PersistedToolStep>;
