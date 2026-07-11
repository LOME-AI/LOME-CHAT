import { describe, expect, it } from 'vitest';
import { errAsync, okAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import { runCronEntries, runOrThrow } from './cron.js';
import type { SafeLogFields, Telemetry } from '../lib/telemetry/index.js';

interface TelemetryRecorder {
  readonly telemetry: Telemetry;
  readonly errors: { msg: string; fields: SafeLogFields | undefined }[];
  readonly captured: { message: string; code: string }[];
}

function recordingTelemetry(): TelemetryRecorder {
  const errors: TelemetryRecorder['errors'] = [];
  const captured: TelemetryRecorder['captured'] = [];
  const telemetry: Telemetry = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: string, fields?: SafeLogFields) => {
      errors.push({ msg, fields });
    },
    emitMetric: () => {},
    captureError: (error: Error, code: string) => {
      captured.push({ message: error.message, code });
    },
  };
  return { telemetry, errors, captured };
}

describe('runCronEntries', () => {
  it('runs every entry even when an earlier one throws', async () => {
    const ran: string[] = [];
    const { telemetry } = recordingTelemetry();
    await runCronEntries(
      [
        {
          name: 'first-exploding-entry',
          run: () => {
            ran.push('first');
            return Promise.reject(new Error('boom'));
          },
        },
        {
          name: 'second-healthy-entry',
          run: () => {
            ran.push('second');
            return Promise.resolve();
          },
        },
      ],
      telemetry
    );
    expect(ran).toEqual(['first', 'second']);
  });

  it('captures each failing entry with its name in the structured log', async () => {
    const recorder = recordingTelemetry();
    await runCronEntries(
      [
        { name: 'broken-entry', run: () => Promise.reject(new Error('boom')) },
        { name: 'healthy-entry', run: () => Promise.resolve() },
      ],
      recorder.telemetry
    );
    expect(recorder.errors).toEqual([
      {
        msg: 'cron entry failed',
        fields: { jobType: 'broken-entry', errorCode: 'cron_entry_failed' },
      },
    ]);
    expect(recorder.captured).toEqual([{ message: 'boom', code: 'cron_entry_failed' }]);
  });

  it('wraps a non-Error rejection before capturing it', async () => {
    const recorder = recordingTelemetry();
    await runCronEntries(
      [
        {
          name: 'string-thrower',
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the runner must wrap exactly this non-Error rejection shape
          run: () => Promise.reject('plain string'),
        },
      ],
      recorder.telemetry
    );
    expect(recorder.captured).toEqual([{ message: 'plain string', code: 'cron_entry_failed' }]);
  });

  it('stays silent when every entry succeeds', async () => {
    const recorder = recordingTelemetry();
    await runCronEntries(
      [{ name: 'healthy-entry', run: () => Promise.resolve() }],
      recorder.telemetry
    );
    expect(recorder.errors).toEqual([]);
    expect(recorder.captured).toEqual([]);
  });
});

describe('runOrThrow', () => {
  it('returns the ok value', async () => {
    await expect(runOrThrow(okAsync(42))).resolves.toBe(42);
  });

  it('throws the domain code with the domain error as cause', async () => {
    const domainError = unavailableError('redis down');
    const thrown = await runOrThrow(errAsync(domainError)).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('unavailable');
    expect((thrown as Error).cause).toBe(domainError);
  });
});
