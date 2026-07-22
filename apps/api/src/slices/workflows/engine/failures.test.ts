import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import { conflictError, notFoundError } from '../../../lib/errors/index.js';
import {
  AllBranchesFailedError,
  SettlementConflictError,
  StorageUnavailableError,
  runFailureCode,
} from './failures.js';

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

  it('passes a node failure code through when the node carries one', () => {
    expect(
      runFailureCode({ kind: 'node-failed', nodeId: 'answer', code: ERROR_CODES.CONTENT_POLICY })
    ).toBe(ERROR_CODES.CONTENT_POLICY);
  });

  it('passes an inputs-invalid code through when one is carried', () => {
    expect(
      runFailureCode({ kind: 'inputs-invalid', code: ERROR_CODES.UNSUPPORTED_RESOLUTION })
    ).toBe(ERROR_CODES.UNSUPPORTED_RESOLUTION);
  });

  it('maps a defect to the internal code', () => {
    expect(runFailureCode({ kind: 'defect' })).toBe(ERROR_CODES.INTERNAL);
  });

  it('maps an all-branches-failed settlement to the unavailable code', () => {
    expect(runFailureCode({ kind: 'all-branches-failed' })).toBe(ERROR_CODES.UNAVAILABLE);
  });

  it('maps a storage-unavailable failure to the unavailable code', () => {
    expect(runFailureCode({ kind: 'storage-unavailable' })).toBe(ERROR_CODES.UNAVAILABLE);
  });

  it('passes a settlement-conflict code through unchanged', () => {
    expect(
      runFailureCode({ kind: 'settlement-conflict', code: ERROR_CODES.FORK_TIP_CONFLICT })
    ).toBe(ERROR_CODES.FORK_TIP_CONFLICT);
  });
});

describe('SettlementConflictError', () => {
  it('is a typed Error subclass the engine can discriminate via instanceof', () => {
    const error = new SettlementConflictError(
      notFoundError('fork gone'),
      'chat settlement: fork-tip advancement failed'
    );
    expect(error).toBeInstanceOf(SettlementConflictError);
    expect(error).toBeInstanceOf(Error);
  });

  it('carries its class name for telemetry', () => {
    expect(new SettlementConflictError(notFoundError('fork gone'), 'msg').name).toBe(
      'SettlementConflictError'
    );
  });

  it('carries the wire-code-bearing domain error the engine projects to the client', () => {
    const domainError = conflictError('epoch rotated', undefined, ERROR_CODES.CONFLICT);
    const error = new SettlementConflictError(domainError, 'chat settlement: wrap-epoch failed');
    expect(error.domainError).toBe(domainError);
    expect(error.message).toBe('chat settlement: wrap-epoch failed');
  });
});

describe('StorageUnavailableError', () => {
  it('is a typed Error subclass the engine can discriminate via instanceof', () => {
    const error = new StorageUnavailableError('storage put failed');
    expect(error).toBeInstanceOf(StorageUnavailableError);
    expect(error).toBeInstanceOf(Error);
  });

  it('carries its class name for telemetry', () => {
    expect(new StorageUnavailableError('storage put failed').name).toBe('StorageUnavailableError');
  });

  it('attaches the originating storage error as its cause when one is supplied', () => {
    const origin = new Error('minio put timed out');
    expect(new StorageUnavailableError('storage put failed', origin).cause).toBe(origin);
  });

  it('omits the cause when none is supplied', () => {
    expect(new StorageUnavailableError('storage put failed').cause).toBeUndefined();
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
