import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PolicyHooks, WorkflowDefinition, mediaTag, nanoUSD, textTag } from '@hushbox/shared';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  buildWorkflow,
  createConstraintRegistry,
  createLiveExecutionRegistry,
  createWorkflowExecutor,
  modelCall,
  predicateCode,
  reducerCode,
  workflowInputs,
} from '../../workflows/index.js';
import { ok } from '../../../lib/result/index.js';
import {
  MEDIA_PROGRESS_HEARTBEAT_MS,
  MEDIA_PROGRESS_MAX_PERCENT,
  MEDIA_PROGRESS_STEP_PERCENT,
  VIDEO_DEFAULT_DURATION_SECONDS,
  VIDEO_EXPECTED_GENERATION_MULTIPLIER,
  createVideoProgressEmitter,
} from './media-progress.js';
import type {
  FlowStreamEvent,
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
} from '@hushbox/shared';
import type {
  ModelBinding,
  NodeRegistryContext,
  SubWorkflowBinding,
} from '../../workflows/index.js';
import type { ModelProvider } from '../../models/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';

/** A media-classed definition of bare video modelCall siblings (shape-parsed). */
function mediaDefinition(
  nodes: readonly { id: string; params: Record<string, unknown> }[]
): WorkflowDefinition {
  return WorkflowDefinition.parse({
    version: 1,
    deadlineClass: 'media',
    hooks: { admission: 'chat', settlement: 'chat' },
    nodes: nodes.map(({ id, params }) => ({
      id,
      type: 'modelCall',
      version: 1,
      out: 'out',
      model: 'video-model',
      params,
      in: { node: 'input', port: 'prompt' },
    })),
    edges: [],
  });
}

function streamStart(modality?: 'image' | 'video'): InferenceEvent {
  return {
    kind: 'stream-start',
    modelId: 'video-model',
    ...(modality === undefined ? {} : { outputModality: modality }),
  };
}

const MEDIA_DONE: InferenceEvent = {
  kind: 'media-done',
  index: 0,
  value: {
    ref: 'media/a/b/c',
    mimeType: 'video/mp4',
    modality: 'video',
    byteLength: 4,
    metadata: {},
  },
};

const FINISH: InferenceEvent = {
  kind: 'finish',
  metadata: { usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' },
};

/** durationSeconds=9 → expected 72 000 ms → a clean 8 000 ms sweep tick. */
const NINE_SECONDS_TICK_MS = (9 * VIDEO_EXPECTED_GENERATION_MULTIPLIER * 1000) / 9;

interface Harness {
  readonly frames: FlowStreamEvent[];
  readonly emit: (event: FlowStreamEvent) => void;
  readonly stopAll: () => void;
}

function harness(definition: WorkflowDefinition): Harness {
  const frames: FlowStreamEvent[] = [];
  const emitter = createVideoProgressEmitter(definition, (frame) => frames.push(frame));
  return { frames, emit: emitter.emit, stopAll: emitter.stopAll };
}

function percentsOf(frames: readonly FlowStreamEvent[], streamId: string): number[] {
  return frames
    .filter((frame) => frame.streamId === streamId && frame.event.kind === 'media-progress')
    .map((frame) => (frame.event as Extract<InferenceEvent, { kind: 'media-progress' }>).percent);
}

describe('createVideoProgressEmitter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a synthetic sweep when a video stream-start arrives', () => {
    const h = harness(mediaDefinition([{ id: 'answer', params: { durationSeconds: 9 } }]));
    h.emit({ streamId: 'answer#0', cursor: 1, event: streamStart('video') });
    vi.advanceTimersByTime(NINE_SECONDS_TICK_MS);
    expect(percentsOf(h.frames, 'answer#0')).toEqual([MEDIA_PROGRESS_STEP_PERCENT]);
    h.stopAll();
  });

  it('paces the sweep by the declared durationSeconds times the generation multiplier', () => {
    const h = harness(mediaDefinition([{ id: 'answer', params: { durationSeconds: 9 } }]));
    h.emit({ streamId: 'answer#0', cursor: 1, event: streamStart('video') });
    vi.advanceTimersByTime(NINE_SECONDS_TICK_MS - 1);
    expect(percentsOf(h.frames, 'answer#0')).toEqual([]);
    vi.advanceTimersByTime(1 + 2 * NINE_SECONDS_TICK_MS);
    expect(percentsOf(h.frames, 'answer#0')).toEqual([10, 20, 30]);
    h.stopAll();
  });

  it('caps at the max percent and heartbeats it until stopped', () => {
    const h = harness(mediaDefinition([{ id: 'answer', params: { durationSeconds: 9 } }]));
    h.emit({ streamId: 'answer#0', cursor: 1, event: streamStart('video') });
    vi.advanceTimersByTime(10 * NINE_SECONDS_TICK_MS);
    expect(percentsOf(h.frames, 'answer#0')).toEqual([
      10,
      20,
      30,
      40,
      50,
      60,
      70,
      80,
      90,
      MEDIA_PROGRESS_MAX_PERCENT,
    ]);
    vi.advanceTimersByTime(2 * MEDIA_PROGRESS_HEARTBEAT_MS);
    expect(percentsOf(h.frames, 'answer#0')).toEqual([
      10,
      20,
      30,
      40,
      50,
      60,
      70,
      80,
      90,
      MEDIA_PROGRESS_MAX_PERCENT,
      MEDIA_PROGRESS_MAX_PERCENT,
      MEDIA_PROGRESS_MAX_PERCENT,
    ]);
    h.stopAll();
  });

  it('defaults the expected duration when the node declares no durationSeconds', () => {
    const h = harness(mediaDefinition([{ id: 'answer', params: {} }]));
    h.emit({ streamId: 'answer#0', cursor: 1, event: streamStart('video') });
    const stepCount = Math.floor(MEDIA_PROGRESS_MAX_PERCENT / MEDIA_PROGRESS_STEP_PERCENT);
    const defaultTick = Math.floor(
      (VIDEO_DEFAULT_DURATION_SECONDS * VIDEO_EXPECTED_GENERATION_MULTIPLIER * 1000) / stepCount
    );
    vi.advanceTimersByTime(defaultTick);
    expect(percentsOf(h.frames, 'answer#0')).toEqual([MEDIA_PROGRESS_STEP_PERCENT]);
    h.stopAll();
  });

  it('gives an image stream no sweep (start/done only, matching legacy)', () => {
    const h = harness(mediaDefinition([{ id: 'answer', params: {} }]));
    h.emit({ streamId: 'answer#0', cursor: 1, event: streamStart('image') });
    vi.advanceTimersByTime(10 * NINE_SECONDS_TICK_MS);
    expect(percentsOf(h.frames, 'answer#0')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a modality-free (text) stream no sweep', () => {
    const h = harness(mediaDefinition([{ id: 'answer', params: {} }]));
    h.emit({ streamId: 'answer#0', cursor: 1, event: streamStart() });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the sweep on media-done without leaking timers', () => {
    const h = harness(mediaDefinition([{ id: 'answer', params: { durationSeconds: 9 } }]));
    h.emit({ streamId: 'answer#0', cursor: 1, event: streamStart('video') });
    vi.advanceTimersByTime(2 * NINE_SECONDS_TICK_MS);
    h.emit({ streamId: 'answer#0', cursor: 2, event: MEDIA_DONE });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * NINE_SECONDS_TICK_MS);
    expect(percentsOf(h.frames, 'answer#0')).toEqual([10, 20]);
  });

  it('stops the heartbeat on the terminal finish without leaking timers', () => {
    const h = harness(mediaDefinition([{ id: 'answer', params: { durationSeconds: 9 } }]));
    h.emit({ streamId: 'answer#0', cursor: 1, event: streamStart('video') });
    vi.advanceTimersByTime(10 * NINE_SECONDS_TICK_MS + MEDIA_PROGRESS_HEARTBEAT_MS);
    h.emit({ streamId: 'answer#0', cursor: 2, event: FINISH });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stopAll silently clears every timer (abort/deadline path)', () => {
    const h = harness(
      mediaDefinition([
        { id: 'a', params: { durationSeconds: 9 } },
        { id: 'b', params: { durationSeconds: 9 } },
      ])
    );
    h.emit({ streamId: 'a#0', cursor: 1, event: streamStart('video') });
    h.emit({ streamId: 'b#1', cursor: 1, event: streamStart('video') });
    vi.advanceTimersByTime(NINE_SECONDS_TICK_MS);
    h.stopAll();
    expect(vi.getTimerCount()).toBe(0);
    const framesBefore = h.frames.length;
    vi.advanceTimersByTime(10 * NINE_SECONDS_TICK_MS);
    expect(h.frames.length).toBe(framesBefore);
  });

  it('keeps per-stream cursors monotonic across forwarded and injected frames', () => {
    const h = harness(mediaDefinition([{ id: 'answer', params: { durationSeconds: 9 } }]));
    h.emit({ streamId: 'answer#0', cursor: 1, event: streamStart('video') });
    vi.advanceTimersByTime(NINE_SECONDS_TICK_MS);
    h.emit({ streamId: 'answer#0', cursor: 2, event: MEDIA_DONE });
    h.emit({ streamId: 'answer#0', cursor: 3, event: FINISH });
    expect(h.frames.map((frame) => frame.cursor)).toEqual([1, 2, 3, 4]);
    expect(h.frames.map((frame) => frame.event.kind)).toEqual([
      'stream-start',
      'media-progress',
      'media-done',
      'finish',
    ]);
  });

  it('runs an independent sweep per video sibling', () => {
    const h = harness(
      mediaDefinition([
        { id: 'a', params: { durationSeconds: 9 } },
        { id: 'b', params: { durationSeconds: 18 } },
      ])
    );
    h.emit({ streamId: 'a#0', cursor: 1, event: streamStart('video') });
    h.emit({ streamId: 'b#1', cursor: 1, event: streamStart('video') });
    vi.advanceTimersByTime(NINE_SECONDS_TICK_MS);
    expect(percentsOf(h.frames, 'a#0')).toEqual([10]);
    expect(percentsOf(h.frames, 'b#1')).toEqual([]);
    vi.advanceTimersByTime(NINE_SECONDS_TICK_MS);
    expect(percentsOf(h.frames, 'a#0')).toEqual([10, 20]);
    expect(percentsOf(h.frames, 'b#1')).toEqual([10]);
    h.stopAll();
  });

  it('ignores a repeated video stream-start (one sweep per stream)', () => {
    const h = harness(mediaDefinition([{ id: 'answer', params: { durationSeconds: 9 } }]));
    h.emit({ streamId: 'answer#0', cursor: 1, event: streamStart('video') });
    h.emit({ streamId: 'answer#0', cursor: 2, event: streamStart('video') });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(NINE_SECONDS_TICK_MS);
    expect(percentsOf(h.frames, 'answer#0')).toEqual([10]);
    h.stopAll();
  });

  it('starts no sweep for a stream of a node the definition does not declare', () => {
    const h = harness(mediaDefinition([{ id: 'answer', params: { durationSeconds: 9 } }]));
    h.emit({ streamId: 'ghost#0', cursor: 1, event: streamStart('video') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves an unsuffixed stream id as the node id itself', () => {
    const h = harness(mediaDefinition([{ id: 'answer', params: { durationSeconds: 9 } }]));
    h.emit({ streamId: 'answer', cursor: 1, event: streamStart('video') });
    vi.advanceTimersByTime(NINE_SECONDS_TICK_MS);
    expect(percentsOf(h.frames, 'answer')).toEqual([10]);
    h.stopAll();
  });

  it('paces only modelCall nodes (control nodes declare no generation duration)', () => {
    const definition = WorkflowDefinition.parse({
      version: 1,
      deadlineClass: 'media',
      hooks: { admission: 'chat', settlement: 'chat' },
      nodes: [
        {
          id: 'answer',
          type: 'modelCall',
          version: 1,
          out: 'out',
          model: 'video-model',
          params: { durationSeconds: 9 },
          in: { node: 'input', port: 'prompt' },
        },
        {
          id: 'shape',
          type: 'transform',
          version: 1,
          out: 'out',
          transform: 'identity',
          in: { node: 'answer', port: 'out' },
        },
      ],
      edges: [],
    });
    const frames: FlowStreamEvent[] = [];
    const emitter = createVideoProgressEmitter(definition, (frame) => frames.push(frame));
    emitter.emit({ streamId: 'shape#0', cursor: 1, event: streamStart('video') });
    expect(vi.getTimerCount()).toBe(0);
    emitter.emit({ streamId: 'answer#1', cursor: 1, event: streamStart('video') });
    vi.advanceTimersByTime(NINE_SECONDS_TICK_MS);
    expect(percentsOf(frames, 'answer#1')).toEqual([10]);
    emitter.stopAll();
  });

  it('forwards a sweep-free stream byte-identically (cursor and order preserved)', () => {
    const h = harness(mediaDefinition([{ id: 'answer', params: {} }]));
    const first: FlowStreamEvent = { streamId: 'answer#0', cursor: 1, event: streamStart('image') };
    const second: FlowStreamEvent = { streamId: 'answer#0', cursor: 2, event: MEDIA_DONE };
    h.emit(first);
    h.emit(second);
    expect(h.frames).toEqual([first, second]);
  });
});

/**
 * The full seam, composed exactly as the chat runtime wires it: the REAL
 * interpreter + modelCall execution stream a video node through the wrapped
 * emit, with `stopAll` hooked to the run's terminal (done). Proves the legacy
 * contract end to end: early modality-labeled start → increasing synthetic
 * percents → the 95 cap → the real media-done/finish, with no leaked timer.
 */
describe('video progress over a live engine run', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const VIDEO_DESCRIPTOR: ModelDescriptor = {
    id: 'video-model',
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['video'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: {},
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };

  const VIDEO_TAG = mediaTag('video', ['video/mp4']);

  /** The video run resolves no sub-workflows; every ref misses. */
  const NO_SUB_WORKFLOWS: Record<string, SubWorkflowBinding | undefined> = {};

  const VIDEO_BINDING: ModelBinding = {
    descriptor: VIDEO_DESCRIPTOR,
    ports: { in: [textTag()], out: VIDEO_TAG },
    price: () => ok(5n),
    priceMedia: () => ok(70n),
  };

  function fakeTelemetry(): Telemetry {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      emitMetric: vi.fn(),
      captureError: vi.fn(),
    };
  }

  it('emits start, increasing percents capped at 95, then ends with the run', async () => {
    let releaseProvider: () => void = () => {};
    const generated = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider: ModelProvider = {
      infer: (_request: InferenceRequest) =>
        (async function* stream(): AsyncGenerator<InferenceEvent> {
          await generated;
          yield { kind: 'media-start', index: 0, modality: 'video', mimeType: 'video/mp4' };
          yield MEDIA_DONE;
          yield FINISH;
        })(),
    };
    const nodes: NodeRegistryContext = {
      hasNode: (_type, version) => version === 1,
      resolveValuePorts: () => ({ in: [textTag()], out: VIDEO_TAG }),
    };
    const constraints = createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES);
    const inputs = workflowInputs({ prompt: textTag() });
    const definition = buildWorkflow({
      deadlineClass: 'media',
      hooks: PolicyHooks.parse({ admission: 'chat', settlement: 'chat' }),
      inputs,
      nodes: [
        modelCall({
          id: 'answer',
          model: 'video-model',
          accepts: textTag(),
          in: inputs.ports.prompt,
          produces: VIDEO_TAG,
          params: { durationSeconds: 9 },
        }),
      ],
      registries: { nodes, constraints },
    })._unsafeUnwrap().definition;
    const execution = createLiveExecutionRegistry({
      provider,
      models: { resolve: (id) => (id === 'video-model' ? VIDEO_BINDING : undefined) },
      compute: { execute: vi.fn(), resolvePorts: vi.fn() } as never,
      subWorkflows: { resolve: (ref: string) => NO_SUB_WORKFLOWS[ref] },
      schemas: { resolveSchema: (name) => constraints.resolve('schema', name)?.schema },
      predicates: predicateCode(DEFAULT_WORKFLOW_CAPABILITIES),
      reducers: reducerCode(DEFAULT_WORKFLOW_CAPABILITIES),
    });
    const executor = createWorkflowExecutor({
      registries: { nodes, constraints },
      execution,
      estimateRun: () => ok(nanoUSD(100n)),
      clock: { now: () => 1000 },
      rng: { random: () => 0.5 },
      telemetry: fakeTelemetry(),
    });
    const frames: FlowStreamEvent[] = [];
    const progress = createVideoProgressEmitter(definition, (frame) => frames.push(frame));
    const handle = executor.start({
      definition,
      inputs: { prompt: { kind: 'text', text: 'a cat surfing' } },
      hooks: {
        admission: () =>
          Promise.resolve({
            admitted: true as const,
            holdRef: 'hold',
            circuit: {
              estimateNanoUsd: 1_000_000n,
              costCircuitMultiplier: 5n,
              costCircuitLimitNanoUsd: 1_000_000n,
            },
          }),
        settlement: () => Promise.resolve(),
      },
      runKey: 'run-key',
      emit: progress.emit,
    });
    // Let the run reach the provider call, sweep past the cap, then heartbeat.
    await vi.advanceTimersByTimeAsync(11 * NINE_SECONDS_TICK_MS + MEDIA_PROGRESS_HEARTBEAT_MS);
    releaseProvider();
    const outcome = await handle.done;
    // The runtime's terminal sink calls this on every terminal (mirrored here).
    progress.stopAll();
    expect(outcome).toEqual({ outcome: 'succeeded' });
    const streamId = frames[0]?.streamId ?? '';
    expect(frames[0]?.event).toEqual({
      kind: 'stream-start',
      modelId: 'video-model',
      outputModality: 'video',
    });
    const percents = percentsOf(frames, streamId);
    // Sweep caps at the 10th tick (80 s); the heartbeat then fires at 85 s and
    // 90 s inside the advanced window — two 95 pulses after the capping one.
    expect(percents).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 95, 95]);
    expect(frames.map((frame) => frame.cursor)).toEqual(frames.map((_, index) => index + 1));
    expect(frames.at(-2)?.event.kind).toBe('media-done');
    expect(frames.at(-1)?.event.kind).toBe('finish');
    expect(vi.getTimerCount()).toBe(0);
  });
});
