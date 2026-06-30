import { describe, expect, it } from 'vitest';
import { installProductionConsolePatch } from './console-patch.js';
import type { PatchableConsole } from './console-patch.js';

const PRODUCTION_ENV = { NODE_ENV: 'production' } as const;
const DEVELOPMENT_ENV = { NODE_ENV: 'development' } as const;

interface RecordedCall {
  readonly method: keyof PatchableConsole;
  readonly args: readonly unknown[];
}

function createRecordingConsole(): { target: PatchableConsole; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const record =
    (method: keyof PatchableConsole) =>
    (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  return {
    target: {
      debug: record('debug'),
      info: record('info'),
      log: record('log'),
      warn: record('warn'),
      error: record('error'),
      trace: record('trace'),
    },
    calls,
  };
}

const SUPPRESSED_LINE = JSON.stringify({ level: 'warn', msg: 'console.suppressed' });

describe('installProductionConsolePatch gating', () => {
  it('leaves the target untouched outside production', () => {
    const { target } = createRecordingConsole();
    const before = { ...target };

    installProductionConsolePatch(DEVELOPMENT_ENV, target);

    expect(target.info).toBe(before.info);
    expect(target.error).toBe(before.error);
  });

  it('replaces every covered method in production', () => {
    const { target } = createRecordingConsole();
    const before = { ...target };

    installProductionConsolePatch(PRODUCTION_ENV, target);

    for (const method of ['debug', 'info', 'log', 'warn', 'error', 'trace'] as const) {
      expect(target[method]).not.toBe(before[method]);
    }
  });

  it('is idempotent: a second install does not re-wrap', () => {
    const { target } = createRecordingConsole();
    installProductionConsolePatch(PRODUCTION_ENV, target);
    const patched = target.info;

    installProductionConsolePatch(PRODUCTION_ENV, target);

    expect(target.info).toBe(patched);
  });

  it('patches the global console by default in production', () => {
    const original = { ...globalThis.console };
    try {
      installProductionConsolePatch(PRODUCTION_ENV);
      expect(globalThis.console.debug).not.toBe(original.debug);
    } finally {
      Object.assign(globalThis.console, original);
    }
  });
});

describe('patched console envelope filtering', () => {
  function patched(): { target: PatchableConsole; calls: RecordedCall[] } {
    const recording = createRecordingConsole();
    installProductionConsolePatch(PRODUCTION_ENV, recording.target);
    return recording;
  }

  it('forwards a conformant telemetry log line verbatim on its own channel', () => {
    const { target, calls } = patched();
    const line = JSON.stringify({ level: 'info', msg: 'turn settled', requestId: 'r-1' });

    target.info(line);

    expect(calls).toEqual([{ method: 'info', args: [line] }]);
  });

  it('forwards a conformant metric line', () => {
    const { target, calls } = patched();
    const line = JSON.stringify({ level: 'info', msg: 'metric', metric: 'chat.tokens', value: 1 });

    target.info(line);

    expect(calls).toEqual([{ method: 'info', args: [line] }]);
  });

  it('forwards a conformant captured-error line', () => {
    const { target, calls } = patched();
    const line = JSON.stringify({
      level: 'error',
      msg: 'error.captured',
      errorCode: 'defect',
      errorName: 'TypeError',
      stack: '    at run (file.ts:1:1)',
    });

    target.error(line);

    expect(calls).toEqual([{ method: 'error', args: [line] }]);
  });

  it('suppresses a stray content-bearing string', () => {
    const { target, calls } = patched();

    target.log('user password is hunter2');

    expect(calls).toEqual([{ method: 'warn', args: [SUPPRESSED_LINE] }]);
    expect(JSON.stringify(calls)).not.toContain('hunter2');
  });

  it('suppresses multi-argument calls even when the first is conformant', () => {
    const { target, calls } = patched();
    const line = JSON.stringify({ level: 'info', msg: 'ok' });

    target.info(line, 'smuggled secret');

    expect(calls).toEqual([{ method: 'warn', args: [SUPPRESSED_LINE] }]);
  });

  it('suppresses non-string arguments', () => {
    const { target, calls } = patched();

    target.debug({ secret: 'object payload' });

    expect(calls).toEqual([{ method: 'warn', args: [SUPPRESSED_LINE] }]);
  });

  it('suppresses a JSON line with a non-allowlisted key', () => {
    const { target, calls } = patched();

    target.info(JSON.stringify({ level: 'info', msg: 'ok', email: 'pii@example.com' }));

    expect(calls).toEqual([{ method: 'warn', args: [SUPPRESSED_LINE] }]);
    expect(JSON.stringify(calls)).not.toContain('pii@example.com');
  });

  it('suppresses a JSON line with a non-primitive value', () => {
    const { target, calls } = patched();

    target.info(JSON.stringify({ level: 'info', msg: 'ok', stack: { nested: 'secret' } }));

    expect(calls).toEqual([{ method: 'warn', args: [SUPPRESSED_LINE] }]);
  });

  it('suppresses a JSON array', () => {
    const { target, calls } = patched();

    target.info(JSON.stringify(['secret entry']));

    expect(calls).toEqual([{ method: 'warn', args: [SUPPRESSED_LINE] }]);
  });

  it('suppresses non-JSON strings without throwing', () => {
    const { target, calls } = patched();

    target.trace('not json at all');

    expect(calls).toEqual([{ method: 'warn', args: [SUPPRESSED_LINE] }]);
  });
});

describe('installProductionConsolePatch best-effort containment', () => {
  it('contains a failing install on a frozen target', () => {
    const { target } = createRecordingConsole();
    Object.freeze(target);

    expect(() => {
      installProductionConsolePatch(PRODUCTION_ENV, target);
    }).not.toThrow();
  });

  it('contains a throwing original method at call time', () => {
    const target: PatchableConsole = {
      debug: () => {
        throw new Error('sink down');
      },
      info: () => {
        throw new Error('sink down');
      },
      log: () => {
        throw new Error('sink down');
      },
      warn: () => {
        throw new Error('sink down');
      },
      error: () => {
        throw new Error('sink down');
      },
      trace: () => {
        throw new Error('sink down');
      },
    };
    installProductionConsolePatch(PRODUCTION_ENV, target);

    expect(() => {
      target.info(JSON.stringify({ level: 'info', msg: 'ok' }));
      target.info('stray content');
    }).not.toThrow();
  });
});
