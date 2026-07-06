import { createConversationRoomClass } from '../conversation-room.js';
import { createJobDispatcherClass } from '../job-dispatcher.js';
import type { FlowExecutor, FlowRunOutcome, FlowStopReason } from '@hushbox/shared';
import type { RoomBindings } from '../conversation-room.js';
import type { JobPassResult } from '../job-dispatcher-core.js';

/**
 * Thin-shell test DO (the arch pattern: a DO class contains only platform
 * glue). All room behavior lives in the plain core the node project covers;
 * this binding exists solely to prove the shell's platform glue — upgrade,
 * hibernatable attachments, the deadline alarm, eviction — under workerd.
 *
 * The executor fake completes only when stopped, so the deadline-alarm test
 * can observe run control: alarm → stop('deadline') → outcome 'stopped' →
 * run-finished frame.
 */
const stopDrivenExecutor: FlowExecutor = {
  start() {
    let resolveDone: (outcome: FlowRunOutcome) => void;
    const done = new Promise<FlowRunOutcome>((resolve) => {
      resolveDone = resolve;
    });
    return {
      runId: 'workers-validation-run',
      done,
      stop(reason: FlowStopReason): void {
        resolveDone(reason === 'deadline' ? { outcome: 'stopped' } : { outcome: 'succeeded' });
      },
    };
  },
};

let runCounter = 0;

const dropTelemetryEvent = (): void => {
  // The validation room drops telemetry: these tests assert platform glue,
  // not observability.
};

const bindings: RoomBindings = {
  executor: stopDrivenExecutor,
  verifier: { verify: () => Promise.resolve('member') },
  telemetry: {
    runStarted: dropTelemetryEvent,
    runFinished: dropTelemetryEvent,
    runRejected: dropTelemetryEvent,
    deadlineFired: dropTelemetryEvent,
    principalEvicted: dropTelemetryEvent,
    deliveryPaused: dropTelemetryEvent,
    clientMessageRejected: dropTelemetryEvent,
  },
  // Fresh executor claim so the shell tests exercise the run-start → alarm →
  // run-finished platform glue; the real referee lives in the workflows engine.
  claimRun: () =>
    Promise.resolve({
      outcome: 'executor',
      fence: {
        id: 'workers-validation-fence',
        executorId: 'workers-validation-executor',
        claims: 1,
      },
    }),
  bindHooks: () => ({
    admission: () => Promise.resolve({ admitted: true, holdRef: 'workers-validation-hold' }),
    settlement: () => Promise.resolve(),
  }),
  maxStreamBytes: 1_000_000,
  now: () => Date.now(),
  newRunId: () => {
    runCounter += 1;
    return `run-${String(runCounter)}`;
  },
};

export const TestConversationRoom = createConversationRoomClass(() => bindings);
export type TestConversationRoom = InstanceType<typeof TestConversationRoom>;

/**
 * Scripts the dispatcher's fake pass executor. The workers project runs in
 * the same isolate as this worker, so tests mutate this module state
 * directly; the dispatcher shell tests assert platform glue only (arm-first
 * through a real alarm, wake over fetch) — pass behavior lives in the
 * node-covered cores.
 */
export const jobDispatcherControl = {
  passes: [] as string[],
  results: [] as JobPassResult[],
  failNextPass: false,
};

export const TestJobDispatcher = createJobDispatcherClass(() => ({
  executor: {
    runPass: (shard: string): Promise<JobPassResult> => {
      jobDispatcherControl.passes.push(shard);
      if (jobDispatcherControl.failNextPass) {
        jobDispatcherControl.failNextPass = false;
        return Promise.reject(new Error('scripted pass failure'));
      }
      const next = jobDispatcherControl.results.shift();
      return Promise.resolve(next ?? { kind: 'idle' });
    },
  },
  telemetry: { passFailed: dropTelemetryEvent },
  now: () => Date.now(),
}));
export type TestJobDispatcher = InstanceType<typeof TestJobDispatcher>;

export default {
  fetch(): Response {
    return new Response('realtime workers-validation test worker');
  },
};
