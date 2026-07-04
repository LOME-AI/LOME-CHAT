import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import { runFailureCode } from './failures.js';

describe('runFailureCode', () => {
  it('maps invalid run inputs to the validation code', () => {
    expect(runFailureCode({ kind: 'inputs-invalid' })).toBe(ERROR_CODES.VALIDATION);
  });

  it('maps a byte-budget breach to the validation code', () => {
    expect(runFailureCode({ kind: 'byte-budget-exceeded' })).toBe(ERROR_CODES.VALIDATION);
  });

  it('passes an admission refusal code through unchanged', () => {
    expect(
      runFailureCode({ kind: 'admission-refused', code: ERROR_CODES.ADMISSION_UNAVAILABLE })
    ).toBe(ERROR_CODES.ADMISSION_UNAVAILABLE);
  });

  it('maps a cost-circuit trip to the insufficient-admission code', () => {
    expect(runFailureCode({ kind: 'cost-circuit-tripped' })).toBe(
      ERROR_CODES.INSUFFICIENT_ADMISSION
    );
  });

  it('maps a failed node to the unavailable code', () => {
    expect(runFailureCode({ kind: 'node-failed', nodeId: 'answer' })).toBe(ERROR_CODES.UNAVAILABLE);
  });

  it('maps a defect to the internal code', () => {
    expect(runFailureCode({ kind: 'defect' })).toBe(ERROR_CODES.INTERNAL);
  });
});
