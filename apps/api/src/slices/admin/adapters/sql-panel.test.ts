import { describe, expect, it } from 'vitest';
import { mapPanelError } from './sql-panel.js';

describe('mapPanelError', () => {
  it('maps insufficient_privilege to forbidden', () => {
    expect(mapPanelError({ code: '42501' }).code).toBe('forbidden');
  });

  it('maps a query-fault SQLSTATE to validation, walking nested causes', () => {
    expect(mapPanelError({ cause: { code: '42601' } }).code).toBe('validation');
  });

  it('maps infra-class SQLSTATEs to unavailable', () => {
    expect(mapPanelError({ code: '28P01' }).code).toBe('unavailable');
    expect(mapPanelError({ code: '08006' }).code).toBe('unavailable');
  });

  it('ignores non-SQLSTATE code strings (driver errno) and answers unavailable', () => {
    expect(mapPanelError({ code: 'ECONNREFUSED' }).code).toBe('unavailable');
  });

  it('answers unavailable for a codeless or non-object error', () => {
    expect(mapPanelError(new Error('socket hang up')).code).toBe('unavailable');
    expect(mapPanelError('boom').code).toBe('unavailable');
  });
});
