import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../lib/errors/index.js';
import { createSmokeHarness } from './harness.js';

describe('notifications smoke', () => {
  it('mounts the notifications slice (anonymous probe of POST /notifications/device-tokens is not 404)', async () => {
    const { client } = createSmokeHarness();
    const res = await client.notifications['device-tokens'].$post({
      json: { token: 'smoke-probe-token', platform: 'ios' },
    });
    expect(res.status).not.toBe(404);
  });

  it('guards the session-class route (anonymous POST /notifications/device-tokens answers 401 {code})', async () => {
    const { client } = createSmokeHarness();
    const res = await client.notifications['device-tokens'].$post({
      json: { token: 'smoke-probe-token', platform: 'ios' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
  });
});
