import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildOpInput, describeField, describeOpFields } from './op-fields.js';

describe('describeOpFields', () => {
  it('derives text controls for the wallet.credit contract fields', () => {
    const fields = describeOpFields('wallet.credit', []);
    expect(fields.map((field) => field.name)).toEqual(['walletId', 'amountNanoUsd', 'reason']);
    expect(fields.every((field) => field.control === 'text')).toBe(true);
    expect(fields.every((field) => field.required)).toBe(true);
  });

  it('derives an enum control with options for user.lock lockReason', () => {
    const fields = describeOpFields('user.lock', []);
    const lockReason = fields.find((field) => field.name === 'lockReason');
    expect(lockReason?.control).toBe('enum');
    expect(lockReason?.options).toEqual(['chargeback', 'admin']);
  });

  it('orders reason last even when the contract declares it earlier', () => {
    const fields = describeOpFields('user.lock', []);
    expect(fields.at(-1)?.name).toBe('reason');
  });

  it('falls back to required text fields from the wire list for an unknown op', () => {
    const fields = describeOpFields('future.op', ['targetId', 'reason']);
    expect(fields).toEqual([
      { name: 'targetId', required: true, control: 'text' },
      { name: 'reason', required: true, control: 'text' },
    ]);
  });
});

describe('describeField', () => {
  it('marks an optional field as not required and unwraps to its control', () => {
    const field = describeField('note', z.string().optional());
    expect(field.required).toBe(false);
    expect(field.control).toBe('text');
  });

  it('treats a defaulted field as not required', () => {
    const field = describeField('count', z.number().default(1));
    expect(field.required).toBe(false);
    expect(field.control).toBe('number');
  });

  it('derives a number control from a plain number schema', () => {
    const field = describeField('count', z.number().int());
    expect(field).toMatchObject({ required: true, control: 'number' });
  });

  it('unwraps a readonly-wrapped enum to an enum control', () => {
    const field = describeField('mode', z.enum(['a', 'b']).readonly());
    expect(field.control).toBe('enum');
    expect(field.options).toEqual(['a', 'b']);
  });
});

describe('buildOpInput', () => {
  it('returns the wire input for valid values', () => {
    const fields = describeOpFields('wallet.credit', []);
    const result = buildOpInput(fields, {
      walletId: '5b6a4a1e-7f4f-4bfb-9d5e-0a4c1d2e3f40',
      amountNanoUsd: '5000000000',
      reason: 'test credit',
    });
    expect(result.errors).toEqual({});
    expect(result.input).toEqual({
      walletId: '5b6a4a1e-7f4f-4bfb-9d5e-0a4c1d2e3f40',
      amountNanoUsd: '5000000000',
      reason: 'test credit',
    });
  });

  it('reports a required error for a blank required field', () => {
    const fields = describeOpFields('wallet.credit', []);
    const result = buildOpInput(fields, { walletId: '', amountNanoUsd: '', reason: '' });
    expect(result.errors['walletId']).toBe('This field is required.');
    expect(result.errors['reason']).toBe('This field is required.');
  });

  it('reports the schema message for a value the contract rejects', () => {
    const fields = describeOpFields('wallet.credit', []);
    const result = buildOpInput(fields, {
      walletId: 'not-a-uuid',
      amountNanoUsd: '12',
      reason: 'x',
    });
    expect(result.errors['walletId']).toBeTruthy();
    expect(result.errors['amountNanoUsd']).toBeUndefined();
  });

  it('submits number controls as numbers', () => {
    const result = buildOpInput([{ name: 'count', required: true, control: 'number' }], {
      count: '3',
    });
    expect(result.input['count']).toBe(3);
  });

  it('omits blank optional fields from the input', () => {
    const result = buildOpInput([{ name: 'note', required: false, control: 'text' }], {
      note: '',
    });
    expect(result.errors).toEqual({});
    expect('note' in result.input).toBe(false);
  });
});
