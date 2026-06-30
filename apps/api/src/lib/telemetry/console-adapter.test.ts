import { describe, expect, it, vi } from 'vitest';
import { createConsoleTelemetry } from './console-adapter.js';
import type { ConsoleSink } from './console-adapter.js';
import type { Telemetry } from './port.js';
import type { SafeLogFields } from './safe-log-fields.js';

interface RecordedLine {
  readonly method: 'debug' | 'info' | 'warn' | 'error';
  readonly line: string;
}

function createRecordingSink(): { sink: ConsoleSink; lines: RecordedLine[] } {
  const lines: RecordedLine[] = [];
  const record =
    (method: RecordedLine['method']) =>
    (line: string): void => {
      lines.push({ method, line });
    };
  return {
    sink: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    lines,
  };
}

describe('createConsoleTelemetry structured log emission', () => {
  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'emits a JSON line on the %s sink method with level, msg, and fields',
    (level) => {
      const { sink, lines } = createRecordingSink();
      const telemetry = createConsoleTelemetry(sink);

      telemetry[level]('turn settled', { requestId: 'r-1', latencyMs: 42 });

      expect(lines).toHaveLength(1);
      expect(lines[0]?.method).toBe(level);
      expect(JSON.parse(lines[0]?.line ?? '')).toEqual({
        level,
        msg: 'turn settled',
        requestId: 'r-1',
        latencyMs: 42,
      });
    }
  );

  it('emits only level and msg when fields are omitted', () => {
    const { sink, lines } = createRecordingSink();
    createConsoleTelemetry(sink).info('booted');

    expect(JSON.parse(lines[0]?.line ?? '')).toEqual({ level: 'info', msg: 'booted' });
  });

  it('scrubs non-allowlisted keys at runtime', () => {
    const { sink, lines } = createRecordingSink();
    const smuggled = { requestId: 'r-1', password: 'hunter2' } as SafeLogFields;

    createConsoleTelemetry(sink).warn('suspicious', smuggled);

    expect(JSON.parse(lines[0]?.line ?? '')).toEqual({
      level: 'warn',
      msg: 'suspicious',
      requestId: 'r-1',
    });
  });
});

describe('createConsoleTelemetry metric emission', () => {
  it('drops a non-number value smuggled past the types', () => {
    const { sink, lines } = createRecordingSink();

    createConsoleTelemetry(sink).emitMetric('chat.tokens', '1280' as unknown as number);

    expect(JSON.parse(lines[0]?.line ?? '')).toEqual({
      level: 'info',
      msg: 'metric',
      metric: 'chat.tokens',
    });
  });

  it('drops a non-finite value', () => {
    const { sink, lines } = createRecordingSink();

    createConsoleTelemetry(sink).emitMetric('chat.tokens', Number.NaN);

    expect(JSON.parse(lines[0]?.line ?? '')).toEqual({
      level: 'info',
      msg: 'metric',
      metric: 'chat.tokens',
    });
  });

  it('emits a metric line with name, value, and allowlisted dimensions', () => {
    const { sink, lines } = createRecordingSink();

    createConsoleTelemetry(sink).emitMetric('chat.tokens', 1280, { modelName: 'gpt-4o' });

    expect(lines[0]?.method).toBe('info');
    expect(JSON.parse(lines[0]?.line ?? '')).toEqual({
      level: 'info',
      msg: 'metric',
      metric: 'chat.tokens',
      value: 1280,
      modelName: 'gpt-4o',
    });
  });

  it('scrubs non-allowlisted dimension keys', () => {
    const { sink, lines } = createRecordingSink();
    const smuggled = { modelName: 'gpt-4o', promptText: 'secret' } as SafeLogFields;

    createConsoleTelemetry(sink).emitMetric('chat.tokens', 1, smuggled);

    expect(JSON.parse(lines[0]?.line ?? '')).toEqual({
      level: 'info',
      msg: 'metric',
      metric: 'chat.tokens',
      value: 1,
      modelName: 'gpt-4o',
    });
  });
});

describe('createConsoleTelemetry error capture', () => {
  it('emits errorCode and errorName, never the error message', () => {
    const { sink, lines } = createRecordingSink();
    const error = new TypeError('SELECT * FROM users WHERE email = secret@example.com');

    createConsoleTelemetry(sink).captureError(error, 'db_query_failed');

    expect(lines[0]?.method).toBe('error');
    const parsed = JSON.parse(lines[0]?.line ?? '') as Record<string, unknown>;
    expect(parsed['errorCode']).toBe('db_query_failed');
    expect(parsed['errorName']).toBe('TypeError');
    expect(lines[0]?.line).not.toContain('secret@example.com');
  });

  it('emits only call-site frames of the stack, not the message header', () => {
    const { sink, lines } = createRecordingSink();
    const error = new Error('PLAINTEXT-MARKER');

    createConsoleTelemetry(sink).captureError(error, 'defect');

    const parsed = JSON.parse(lines[0]?.line ?? '') as { stack: string };
    expect(parsed.stack.length).toBeGreaterThan(0);
    for (const frame of parsed.stack.split('\n')) {
      expect(frame).toMatch(/^\s+at /);
    }
    expect(parsed.stack).not.toContain('PLAINTEXT-MARKER');
  });

  it('handles an error without a stack', () => {
    const { sink, lines } = createRecordingSink();
    const error = new Error('no trace');
    delete error.stack;

    createConsoleTelemetry(sink).captureError(error, 'defect');

    const parsed = JSON.parse(lines[0]?.line ?? '') as { stack: string };
    expect(parsed.stack).toBe('');
  });

  it('does not leak a multi-line message whose lines mimic stack frames', () => {
    const { sink, lines } = createRecordingSink();
    const error = new Error(
      'lookup failed for 742 Evergreen Terrace\n    at SSN 123-45-6789 (content.ts:1:1)'
    );

    createConsoleTelemetry(sink).captureError(error, 'defect');

    const emitted = lines[0]?.line ?? '';
    expect(emitted).not.toContain('123-45-6789');
    expect(emitted).not.toContain('Evergreen');
  });

  it('drops a frame-shaped line embedded in the message while keeping real frames', () => {
    const { sink, lines } = createRecordingSink();
    const error = new Error('boom\n    at fake (x.ts:1:1)');

    createConsoleTelemetry(sink).captureError(error, 'defect');

    const parsed = JSON.parse(lines[0]?.line ?? '') as { stack: string };
    expect(parsed.stack).not.toContain('fake (x.ts:1:1)');
    expect(parsed.stack.length).toBeGreaterThan(0);
    for (const frame of parsed.stack.split('\n')) {
      expect(frame).toMatch(/^\s+at /);
    }
  });

  it('keeps real frames for an empty-message error (header is the bare name)', () => {
    const { sink, lines } = createRecordingSink();
    // Cleared post-construction: V8 derives the stack header lazily at first
    // access, so this exercises the bare-name header (no `: message` part).
    const error = new Error('placeholder');
    error.message = '';

    createConsoleTelemetry(sink).captureError(error, 'defect');

    const parsed = JSON.parse(lines[0]?.line ?? '') as { stack: string };
    expect(parsed.stack.length).toBeGreaterThan(0);
    for (const frame of parsed.stack.split('\n')) {
      expect(frame).toMatch(/^\s+at /);
    }
  });

  it('emits an empty stack when the header cannot be derived (fail closed)', () => {
    const { sink, lines } = createRecordingSink();
    const error = new Error('m');
    error.stack = 'mangled by a library: secret content\n    at real (file.ts:1:1)';

    createConsoleTelemetry(sink).captureError(error, 'defect');

    const parsed = JSON.parse(lines[0]?.line ?? '') as { stack: string };
    expect(parsed.stack).toBe('');
  });

  it('sanitizes a content-bearing error name', () => {
    const { sink, lines } = createRecordingSink();
    const error = new Error('x');
    error.name = 'ENOENT: /home/alice/.ssh/id_rsa';

    createConsoleTelemetry(sink).captureError(error, 'defect');

    const parsed = JSON.parse(lines[0]?.line ?? '') as { errorName: string };
    expect(parsed.errorName).toBe('Error');
    expect(lines[0]?.line ?? '').not.toContain('id_rsa');
  });
});

describe('best-effort containment (error channel is never)', () => {
  function createThrowingSink(): ConsoleSink {
    const explode = (): void => {
      throw new Error('sink down');
    };
    return { debug: explode, info: explode, warn: explode, error: explode };
  }

  it('contains sink failures in log methods', () => {
    const telemetry = createConsoleTelemetry(createThrowingSink());
    expect(() => {
      telemetry.debug('a');
      telemetry.info('b');
      telemetry.warn('c');
      telemetry.error('d');
    }).not.toThrow();
  });

  it('contains sink failures in emitMetric', () => {
    const telemetry = createConsoleTelemetry(createThrowingSink());
    expect(() => {
      telemetry.emitMetric('chat.tokens', 1);
    }).not.toThrow();
  });

  it('contains sink failures in captureError', () => {
    const telemetry = createConsoleTelemetry(createThrowingSink());
    expect(() => {
      telemetry.captureError(new Error('boom'), 'defect');
    }).not.toThrow();
  });

  // Hostile inputs satisfy the parameter types with zero casts: payload
  // construction (field scrub, error-name read, stack processing) must run
  // inside the guard, not just the sink call.
  function throwingFields(): SafeLogFields {
    const fields: SafeLogFields = {};
    Object.defineProperty(fields, 'requestId', {
      enumerable: true,
      get(): string {
        throw new Error('hostile getter');
      },
    });
    return fields;
  }

  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'contains a throwing fields getter in %s',
    (level) => {
      const { sink, lines } = createRecordingSink();
      const telemetry = createConsoleTelemetry(sink);

      expect(() => {
        telemetry[level]('probe', throwingFields());
      }).not.toThrow();
      expect(lines).toHaveLength(0);
    }
  );

  it('contains a throwing dimensions getter in emitMetric', () => {
    const { sink, lines } = createRecordingSink();
    const telemetry = createConsoleTelemetry(sink);

    expect(() => {
      telemetry.emitMetric('chat.tokens', 1, throwingFields());
    }).not.toThrow();
    expect(lines).toHaveLength(0);
  });

  it('contains a throwing name getter in captureError', () => {
    const { sink, lines } = createRecordingSink();
    const telemetry = createConsoleTelemetry(sink);
    const error = new Error('boom');
    Object.defineProperty(error, 'name', {
      get(): string {
        throw new Error('hostile name');
      },
    });

    expect(() => {
      telemetry.captureError(error, 'defect');
    }).not.toThrow();
    expect(lines).toHaveLength(0);
  });
});

describe('default sink', () => {
  it('writes to the global console', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {
      // Silenced: the assertion is on the call, not the output.
    });

    createConsoleTelemetry().info('booted');

    expect(spy).toHaveBeenCalledWith(JSON.stringify({ level: 'info', msg: 'booted' }));
    spy.mockRestore();
  });
});

describe('compile-time port contract', () => {
  it('rejects dynamic strings, unknown fields, and widened field objects', () => {
    const telemetry: Telemetry = createConsoleTelemetry(createRecordingSink().sink);
    const dynamicMsg = 'built at runtime' as string;
    const widened = { requestId: 'r-1', password: 'hunter2' };

    // @ts-expect-error -- msg accepts compile-time string literals only; a string-typed value must not compile
    telemetry.info(dynamicMsg);
    // @ts-expect-error -- string concatenation types as `string` and must not compile
    telemetry.info('user ' + dynamicMsg);
    // @ts-expect-error -- 'password' is not an allowlisted SafeLogFields key (fresh-literal excess check)
    telemetry.info('login failed', { password: 'hunter2' });
    // @ts-expect-error -- ExactSafeLogFields rejects extra keys even on pre-built (non-fresh) objects
    telemetry.info('login failed', widened);
    // @ts-expect-error -- metric names are compile-time literals too
    telemetry.emitMetric(dynamicMsg, 1);

    expect(telemetry).toBeDefined();
  });

  it('rejects dynamic strings and free text as captureError codes', () => {
    const telemetry: Telemetry = createConsoleTelemetry(createRecordingSink().sink);
    const dynamicCode = 'built at runtime' as string;

    // Compiles: an errorCode is a compile-time literal in code shape.
    telemetry.captureError(new Error('boom'), 'db_query_failed');
    // @ts-expect-error -- errorCode accepts compile-time literal codes only; a string-typed value must not compile
    telemetry.captureError(new Error('boom'), dynamicCode);
    // @ts-expect-error -- whitespace marks free text, not a code; prose in a fingerprint is the content-leak vector
    telemetry.captureError(new Error('boom'), 'database exploded near line 7');
    // @ts-expect-error -- a colon marks an `Error: message` header echo, not a code
    telemetry.captureError(new Error('boom'), 'TypeError: secret');

    expect(telemetry).toBeDefined();
  });
});
