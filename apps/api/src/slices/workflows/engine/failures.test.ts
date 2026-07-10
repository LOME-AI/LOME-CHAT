import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import { AllBranchesFailedError, runFailureCode } from './failures.js';

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

  it('maps an all-branches-failed settlement to the unavailable code', () => {
    expect(runFailureCode({ kind: 'all-branches-failed' })).toBe(ERROR_CODES.UNAVAILABLE);
  });
});

describe('AllBranchesFailedError', () => {
  it('is a typed Error subclass the engine can discriminate via instanceof', () => {
    const error = new AllBranchesFailedError();
    expect(error).toBeInstanceOf(AllBranchesFailedError);
    expect(error).toBeInstanceOf(Error);
  });

  it('carries its class name for telemetry', () => {
    expect(new AllBranchesFailedError().name).toBe('AllBranchesFailedError');
  });
});
