import { describe, expect, it } from 'vitest';
import { toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import {
  MAX_ENCRYPTED_INSTRUCTIONS_BYTES,
  clearInstructions,
  getInstructions,
  putInstructionsBodySchema,
  saveInstructions,
} from './instructions.js';
import type { InstructionsStore } from '../ports/index.js';

const USER_ID = '0197a000-0000-7000-8000-000000000009';

function storeWith(overrides: Partial<InstructionsStore>): InstructionsStore {
  return {
    read: () => okAsync(null),
    upsert: () => okAsync(null),
    remove: () => okAsync(null),
    ...overrides,
  };
}

describe('getInstructions', () => {
  it('returns the stored blob encoded as base64', async () => {
    const store = storeWith({ read: () => okAsync(new Uint8Array([9, 8, 7])) });
    const result = await getInstructions(store, USER_ID);
    expect(result._unsafeUnwrap()).toEqual({ instructions: toBase64(new Uint8Array([9, 8, 7])) });
  });

  it('returns null when no instructions are stored', async () => {
    const result = await getInstructions(storeWith({}), USER_ID);
    expect(result._unsafeUnwrap()).toEqual({ instructions: null });
  });
});

describe('saveInstructions', () => {
  it('stores the decoded ciphertext bytes', async () => {
    const writes: Uint8Array[] = [];
    const store = storeWith({
      upsert: (_userId, blob) => {
        writes.push(blob);
        return okAsync(null);
      },
    });
    const result = await saveInstructions(store, USER_ID, toBase64(new Uint8Array([1, 2, 3])));
    expect(result._unsafeUnwrap()).toEqual({ success: true });
    expect(writes).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it('rejects a blob that is not valid base64', async () => {
    const result = await saveInstructions(storeWith({}), USER_ID, '!!not-base64!!');
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a blob over the byte cap', async () => {
    const oversized = toBase64(new Uint8Array(MAX_ENCRYPTED_INSTRUCTIONS_BYTES + 1));
    const result = await saveInstructions(storeWith({}), USER_ID, oversized);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('accepts a blob exactly at the byte cap', async () => {
    const atCap = toBase64(new Uint8Array(MAX_ENCRYPTED_INSTRUCTIONS_BYTES));
    const result = await saveInstructions(storeWith({}), USER_ID, atCap);
    expect(result.isOk()).toBe(true);
  });
});

describe('clearInstructions', () => {
  it('transitions to cleared when a row was deleted', async () => {
    const params = clearInstructions(
      storeWith({ remove: () => okAsync({ removed: true }) }),
      USER_ID
    );
    const result = await params.transition();
    expect(result._unsafeUnwrap()).toEqual({ success: true });
  });

  it('reports zero rows when nothing was stored', async () => {
    const params = clearInstructions(storeWith({}), USER_ID);
    const result = await params.transition();
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('treats already-clear as a no-op success', async () => {
    const params = clearInstructions(storeWith({}), USER_ID);
    const result = await params.onZeroRows();
    expect(result._unsafeUnwrap()).toEqual({ success: true });
  });
});

describe('putInstructionsBodySchema', () => {
  it('rejects an empty instructions string', () => {
    expect(putInstructionsBodySchema.safeParse({ instructions: '' }).success).toBe(false);
  });

  it('rejects an encoded payload longer than the encoded cap', () => {
    const tooLong = 'A'.repeat(43_692);
    expect(putInstructionsBodySchema.safeParse({ instructions: tooLong }).success).toBe(false);
  });
});
