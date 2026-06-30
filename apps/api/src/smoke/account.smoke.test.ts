import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../lib/errors/index.js';
import { createSmokeHarness } from './harness.js';

describe('account smoke', () => {
  it('mounts the account slice (anonymous probe of GET /account/instructions is not 404)', async () => {
    const { client } = createSmokeHarness();
    const res = await client.account.instructions.$get();
    expect(res.status).not.toBe(404);
  });

  it('guards the session-class route (anonymous GET /account/instructions answers 401 {code})', async () => {
    const { client } = createSmokeHarness();
    const res = await client.account.instructions.$get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
  });
});
