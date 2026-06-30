import { describe, expect, it } from 'vitest';
import { SAFE_LOG_FIELD_KEYS } from '../safe-log-fields.js';
import { createWaeTelemetry } from './wae-adapter.js';
import type { SafeLogFields } from '../safe-log-fields.js';

interface RecordedPoint {
  readonly indexes?: ((ArrayBuffer | string) | null)[];
  readonly doubles?: number[];
  readonly blobs?: ((ArrayBuffer | string) | null)[];
}

function createRecordingDataset(): { dataset: AnalyticsEngineDataset; points: RecordedPoint[] } {
  const points: RecordedPoint[] = [];
  return {
    dataset: {
      writeDataPoint(event?: AnalyticsEngineDataPoint): void {
        points.push(event ?? {});
      },
    },
    points,
  };
}

function blobPosition(key: (typeof SAFE_LOG_FIELD_KEYS)[number]): number {
  return SAFE_LOG_FIELD_KEYS.indexOf(key);
}

describe('createWaeTelemetry metric emission', () => {
  it('writes the metric name as the single index', () => {
    const { dataset, points } = createRecordingDataset();

    createWaeTelemetry(dataset).emitMetric('chat.tokens', 1280);

    expect(points).toHaveLength(1);
    expect(points[0]?.indexes).toEqual(['chat.tokens']);
  });

  it('writes the value as the single double', () => {
    const { dataset, points } = createRecordingDataset();

    createWaeTelemetry(dataset).emitMetric('chat.tokens', 1280);

    expect(points[0]?.doubles).toEqual([1280]);
  });

  it('maps string dimensions to their positional blob slot', () => {
    const { dataset, points } = createRecordingDataset();

    createWaeTelemetry(dataset).emitMetric('chat.tokens', 1, { modelName: 'gpt-4o' });

    expect(points[0]?.blobs?.[blobPosition('modelName')]).toBe('gpt-4o');
  });

  it('stringifies numeric dimensions into their blob slot', () => {
    const { dataset, points } = createRecordingDataset();

    createWaeTelemetry(dataset).emitMetric('chat.tokens', 1, { latencyMs: 42 });

    expect(points[0]?.blobs?.[blobPosition('latencyMs')]).toBe('42');
  });

  it('fills absent dimensions with null across the full positional layout', () => {
    const { dataset, points } = createRecordingDataset();

    createWaeTelemetry(dataset).emitMetric('chat.tokens', 1, { modelName: 'gpt-4o' });

    const blobs = points[0]?.blobs ?? [];
    expect(blobs).toHaveLength(SAFE_LOG_FIELD_KEYS.length);
    for (const [position, blob] of blobs.entries()) {
      if (position !== blobPosition('modelName')) {
        expect(blob).toBeNull();
      }
    }
  });

  it('drops a non-finite value but still records the occurrence', () => {
    const { dataset, points } = createRecordingDataset();

    createWaeTelemetry(dataset).emitMetric('chat.tokens', Number.NaN);

    expect(points[0]?.doubles).toEqual([]);
    expect(points[0]?.indexes).toEqual(['chat.tokens']);
  });

  it('drops a non-number value smuggled past the types', () => {
    const { dataset, points } = createRecordingDataset();

    createWaeTelemetry(dataset).emitMetric('chat.tokens', '1280' as unknown as number);

    expect(points[0]?.doubles).toEqual([]);
  });

  it('scrubs non-allowlisted dimension keys', () => {
    const { dataset, points } = createRecordingDataset();
    const smuggled = { modelName: 'gpt-4o', promptText: 'secret' } as SafeLogFields;

    createWaeTelemetry(dataset).emitMetric('chat.tokens', 1, smuggled);

    expect(JSON.stringify(points[0])).not.toContain('secret');
  });
});

describe('createWaeTelemetry non-metric methods are inert', () => {
  it.each(['debug', 'info', 'warn', 'error'] as const)('%s writes nothing', (level) => {
    const { dataset, points } = createRecordingDataset();

    createWaeTelemetry(dataset)[level]('turn settled', { requestId: 'r-1' });

    expect(points).toHaveLength(0);
  });

  it('captureError writes nothing', () => {
    const { dataset, points } = createRecordingDataset();

    createWaeTelemetry(dataset).captureError(new Error('boom'), 'defect');

    expect(points).toHaveLength(0);
  });
});

describe('createWaeTelemetry best-effort containment (error channel is never)', () => {
  it('contains a throwing binding', () => {
    const dataset: AnalyticsEngineDataset = {
      writeDataPoint(): void {
        throw new Error('binding down');
      },
    };

    expect(() => {
      createWaeTelemetry(dataset).emitMetric('chat.tokens', 1);
    }).not.toThrow();
  });

  it('contains a throwing dimensions getter and writes nothing', () => {
    const { dataset, points } = createRecordingDataset();
    const fields: SafeLogFields = {};
    Object.defineProperty(fields, 'requestId', {
      enumerable: true,
      get(): string {
        throw new Error('hostile getter');
      },
    });

    expect(() => {
      createWaeTelemetry(dataset).emitMetric('chat.tokens', 1, fields);
    }).not.toThrow();
    expect(points).toHaveLength(0);
  });
});
