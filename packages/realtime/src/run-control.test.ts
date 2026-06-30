import { describe, expect, it } from 'vitest';
import { RunControl } from './run-control.js';
import type { FlowRunHandle, FlowStopReason } from '@hushbox/shared';

function fakeHandle(): { handle: FlowRunHandle; stops: FlowStopReason[] } {
  const stops: FlowStopReason[] = [];
  const handle: FlowRunHandle = {
    runId: 'r1',
    done: new Promise(() => {
      // never settles — these tests drive the handle directly
    }),
    stop: (reason) => {
      stops.push(reason);
    },
  };
  return { handle, stops };
}

describe('claim', () => {
  it('claims the run when idle', () => {
    const control = new RunControl();
    expect(control.claim('r1', 9000)).toEqual({ ok: true });
  });

  it('rejects a second claim with the concurrent-run code', () => {
    const control = new RunControl();
    control.claim('r1', 9000);
    expect(control.claim('r2', 9000)).toEqual({ ok: false, code: 'CONCURRENT_RUN' });
  });

  it('claims again after the active run is released', () => {
    const control = new RunControl();
    control.claim('r1', 9000);
    control.release('r1');
    expect(control.claim('r2', 9000)).toEqual({ ok: true });
  });

  it('exposes the active deadline for alarm scheduling', () => {
    const control = new RunControl();
    control.claim('r1', 9000);
    expect(control.deadlineAt()).toBe(9000);
  });

  it('exposes the active run id', () => {
    const control = new RunControl();
    control.claim('r1', 9000);
    expect(control.activeRunId()).toBe('r1');
  });

  it('reports a null deadline when idle', () => {
    expect(new RunControl().deadlineAt()).toBeNull();
  });
});

describe('attach', () => {
  it('ignores a handle attached without an active claim', () => {
    const control = new RunControl();
    const { handle, stops } = fakeHandle();
    control.attach(handle);
    expect(control.stop('user-stop')).toBe(false);
    expect(stops).toEqual([]);
  });
});

describe('release', () => {
  it('ignores a stale release racing a newer claim', () => {
    const control = new RunControl();
    control.claim('r1', 9000);
    control.release('r1');
    control.claim('r2', 9000);
    control.release('r1');
    expect(control.activeRunId()).toBe('r2');
  });
});

describe('stop', () => {
  it('forwards a user stop to the attached handle', () => {
    const control = new RunControl();
    const { handle, stops } = fakeHandle();
    control.claim('r1', 9000);
    control.attach(handle);
    expect(control.stop('user-stop')).toBe(true);
    expect(stops).toEqual(['user-stop']);
  });

  it('reports false when no run is active', () => {
    const control = new RunControl();
    expect(control.stop('user-stop')).toBe(false);
  });

  it('reports false before a handle is attached', () => {
    const control = new RunControl();
    control.claim('r1', 9000);
    expect(control.stop('user-stop')).toBe(false);
  });
});

describe('onAlarm (deadline run control)', () => {
  it('stops the active run with the deadline reason', () => {
    const control = new RunControl();
    const { handle, stops } = fakeHandle();
    control.claim('r1', 9000);
    control.attach(handle);
    expect(control.onAlarm()).toBe('stopped');
    expect(stops).toEqual(['deadline']);
  });

  it('is a no-op when no run is active', () => {
    const control = new RunControl();
    expect(control.onAlarm()).toBe('idle');
  });
});
