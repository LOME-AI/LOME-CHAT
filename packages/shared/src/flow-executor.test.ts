import { describe, expect, it } from 'vitest';
import { nanoUSD } from './nano-usd.js';
import { WorkflowDefinition } from './workflow.js';
import type {
  AdmissionDecision,
  FlowExecutor,
  FlowRunOutcome,
  FlowStreamEvent,
} from './flow-executor.js';

const definition = WorkflowDefinition.parse({
  version: 1,
  deadlineClass: 'text',
  hooks: { admission: 'chatBalanceHold', settlement: 'saveChatTurn' },
  nodes: [
    {
      id: 'answer',
      version: 1,
      out: 'out',
      type: 'modelCall',
      model: 'openai/gpt-5',
      params: {},
      in: { node: 'input', port: 'out' },
    },
  ],
  edges: [],
});

/**
 * A minimal in-memory implementation proving the seam is implementable: the
 * DO in packages/realtime is parameterized over this interface and apps/api
 * binds it. Behavior here is fake; the contract is the test.
 */
function fakeExecutor(): FlowExecutor {
  return {
    start(request) {
      let cursor = 0;
      const streamId = 'stream-1';
      const run = async (): Promise<FlowRunOutcome> => {
        const decision = await request.hooks.admission({
          definition: request.definition,
          estimate: nanoUSD(1000n),
        });
        if (!decision.admitted) {
          return { outcome: 'failed', code: decision.code };
        }
        request.emit({
          streamId,
          cursor: cursor++,
          event: { kind: 'text-delta', index: 0, content: 'hi' },
        });
        await request.hooks.settlement({ runKey: request.runKey, outputs: {}, charges: [] });
        return { outcome: 'succeeded' };
      };
      return { runId: 'run-1', done: run(), stop: () => {} };
    },
  };
}

describe('FlowExecutor contract', () => {
  it('starts a run, emits per-stream cursored events, settles, and resolves succeeded', async () => {
    const events: FlowStreamEvent[] = [];
    const settled: string[] = [];
    const executor = fakeExecutor();
    const handle = executor.start({
      definition,
      inputs: { prompt: { kind: 'text', text: 'hello' } },
      runKey: 'key-1',
      hooks: {
        admission: () => Promise.resolve({ admitted: true, holdRef: 'hold-1' }),
        settlement: (request) => {
          settled.push(request.runKey);
          return Promise.resolve();
        },
      },
      emit: (event) => events.push(event),
    });
    expect(handle.runId).toBe('run-1');
    await expect(handle.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ streamId: 'stream-1', cursor: 0 });
    expect(settled).toEqual(['key-1']);
  });

  it('a refused admission terminal-fails the run with the typed code (nothing billed)', async () => {
    const refusal: AdmissionDecision = { admitted: false, code: 'INSUFFICIENT_ADMISSION' };
    const executor = fakeExecutor();
    const handle = executor.start({
      definition,
      inputs: {},
      runKey: 'key-2',
      hooks: {
        admission: () => Promise.resolve(refusal),
        settlement: () => Promise.resolve(),
      },
      emit: () => {},
    });
    await expect(handle.done).resolves.toEqual({
      outcome: 'failed',
      code: 'INSUFFICIENT_ADMISSION',
    });
  });

  it('expresses stop reasons and outcomes at the type level', () => {
    const outcomes: FlowRunOutcome[] = [
      { outcome: 'succeeded' },
      { outcome: 'stopped' },
      { outcome: 'failed', code: 'TIMEOUT' },
    ];
    expect(outcomes).toHaveLength(3);
  });
});
