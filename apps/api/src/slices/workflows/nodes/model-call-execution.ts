import { MediaValue } from '@hushbox/shared';
import { err, ok } from '../../../lib/result/index.js';
import { validateNodeInput } from './node-input.js';
import type {
  InferenceEvent,
  InferenceRequest,
  InputPart,
  ModelDescriptor,
  Node,
  NodePortDeclaration,
  SchemaNameRegistry,
  Usage,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { ModelProvider } from '../../models/index.js';
import type {
  NodeExecution,
  NodeRunContext,
  NodeRunError,
  NodeRunSuccess,
} from '../engine/execution-registry.js';

/**
 * The `modelCall` capability execution: one gateway generation (or an agentic
 * loop) over the `ModelProvider` port. It is streaming-terminal — when the
 * engine hands it an `emit` seam, every inference event rides the run's stream
 * to the client; otherwise the node resolves quietly to its value. Money never
 * moves here: the observed usage is priced against the model's catalog rates
 * and reported as `costNanoUsd`, and settlement charges once at run end.
 */

type ModelCallNode = Extract<Node, { type: 'modelCall' }>;

/** A model resolved from the catalog: its descriptor, declared ports, and pricer. */
export interface ModelBinding {
  readonly descriptor: ModelDescriptor;
  readonly ports: NodePortDeclaration;
  /** Prices observed usage against the model's catalog rates (markup applied). */
  readonly price: (usage: Usage) => Result<bigint, DomainError>;
}

export interface ModelCallExecutionDeps {
  readonly provider: ModelProvider;
  readonly binding: ModelBinding;
  readonly schemas: SchemaNameRegistry;
}

export function createModelCallExecution(deps: ModelCallExecutionDeps): NodeExecution {
  return {
    streaming: true,
    run: (node, input, ctx) => runModelCall(deps, node as ModelCallNode, input, ctx),
  };
}

async function runModelCall(
  deps: ModelCallExecutionDeps,
  node: ModelCallNode,
  input: readonly unknown[],
  ctx: NodeRunContext
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const validated = validateNodeInput(deps.binding.ports, deps.schemas, input);
  if (validated.isErr()) return err(validated.error);
  const part = toInputPart(input[0]);
  if (part === undefined) return err({});
  const request: InferenceRequest = {
    model: node.model,
    inputs: [part],
    parameters: node.params,
    outputs: deps.binding.descriptor.outputs,
  };
  return streamCall(deps, request, ctx);
}

interface CallAccumulator {
  text: string;
  media: MediaValue | undefined;
  usage: Usage | undefined;
}

async function streamCall(
  deps: ModelCallExecutionDeps,
  request: InferenceRequest,
  ctx: NodeRunContext
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const accumulator: CallAccumulator = { text: '', media: undefined, usage: undefined };
  try {
    for await (const event of deps.provider.infer(request, deps.binding.descriptor, {
      signal: ctx.signal,
    })) {
      ctx.emit?.(event);
      absorb(accumulator, event);
    }
  } catch (error) {
    if (isInferenceError(error)) return err({});
    throw error;
  }
  const cost = accumulator.usage === undefined ? ok(0n) : deps.binding.price(accumulator.usage);
  // A pricing failure means no catalog rate resolved for the observed usage, so
  // there is no priceable amount to accrue — the error carries none (see the
  // NodeRunError.costNanoUsd contract).
  if (cost.isErr()) return err({});
  return ok({ value: accumulator.media ?? accumulator.text, costNanoUsd: cost.value });
}

function absorb(accumulator: CallAccumulator, event: InferenceEvent): void {
  if (event.kind === 'text-delta') {
    accumulator.text += event.content;
    return;
  }
  if (event.kind === 'media-done') {
    accumulator.media = event.value;
    return;
  }
  if (event.kind === 'finish') {
    accumulator.usage = event.metadata.usage;
  }
}

const REF_MODALITIES: ReadonlySet<string> = new Set(['image', 'audio', 'video']);

function toInputPart(value: unknown): InputPart | undefined {
  if (typeof value === 'string') return { modality: 'text', text: value };
  const media = MediaValue.safeParse(value);
  if (media.success && REF_MODALITIES.has(media.data.modality)) {
    return {
      modality: media.data.modality as 'image' | 'audio' | 'video',
      ref: {
        ref: media.data.ref,
        mimeType: media.data.mimeType,
        byteLength: media.data.byteLength,
      },
    };
  }
  return undefined;
}

/**
 * Expected inference failures surface as thrown `InferenceError`s (the port's
 * stream has no error variant). Recognized structurally so node code stays
 * free of a slice-barrel value import; anything else rethrows to the
 * interpreter's defect path.
 */
function isInferenceError(error: unknown): boolean {
  return error instanceof Error && error.name === 'InferenceError';
}
