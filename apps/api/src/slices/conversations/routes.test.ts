import { describe, expect, it } from 'vitest';
import { requiredIdempotencyKey } from './routes.js';
import type { Context } from 'hono';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';

function contextWithHeader(value?: string): Context<AppEnv> {
  return { req: { header: () => value } } as unknown as Context<AppEnv>;
}

describe('requiredIdempotencyKey', () => {
  it('reads the header the pipeline stage already enforced', () => {
    expect(requiredIdempotencyKey(contextWithHeader('key-1'))).toBe('key-1');
  });

  it('treats an absent header behind the pipeline as a defect', () => {
    expect(() => requiredIdempotencyKey(contextWithHeader())).toThrow(
      /idempotency key missing after the pipeline stage/
    );
  });
});
