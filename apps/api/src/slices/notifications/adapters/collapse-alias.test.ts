import { describe, it, expect } from 'vitest';
import { createCollapseAliasDeriver } from './collapse-alias.js';

const CONVERSATION_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60';

describe('createCollapseAliasDeriver', () => {
  it('derives the pinned HMAC-SHA-256 base64url alias, truncated to 32 chars', async () => {
    const derive = createCollapseAliasDeriver('test-secret-value');

    const alias = await derive(CONVERSATION_ID);

    expect(alias).toBe('LP8HoKvhpgV7wlyNkKm5FzNGj9H6Rs3q');
    expect(alias).toHaveLength(32);
  });

  it('produces only URL/base64url-safe characters (a valid Web Push Topic)', async () => {
    const derive = createCollapseAliasDeriver('test-secret-value');

    const alias = await derive(CONVERSATION_ID);

    expect(alias).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });

  it('is deterministic for the same conversationId and secret', async () => {
    const derive = createCollapseAliasDeriver('test-secret-value');

    expect(await derive(CONVERSATION_ID)).toBe(await derive(CONVERSATION_ID));
  });

  it('never returns the raw conversationId', async () => {
    const derive = createCollapseAliasDeriver('test-secret-value');

    expect(await derive(CONVERSATION_ID)).not.toContain(CONVERSATION_ID);
  });

  it('separates two conversations under the same secret', async () => {
    const derive = createCollapseAliasDeriver('test-secret-value');

    const a = await derive(CONVERSATION_ID);
    const b = await derive('018f4e2a-1c3b-7d4e-9f0a-000000000000');

    expect(a).not.toBe(b);
  });

  it('separates the same conversation under two secrets', async () => {
    const a = await createCollapseAliasDeriver('secret-one')(CONVERSATION_ID);
    const b = await createCollapseAliasDeriver('secret-two')(CONVERSATION_ID);

    expect(a).not.toBe(b);
  });
});
