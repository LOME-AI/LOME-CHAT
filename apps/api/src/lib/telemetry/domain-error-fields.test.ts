import { describe, expect, it } from 'vitest';
import { rateLimitedError, validationError } from '../errors/index.js';
import { domainErrorFields } from './domain-error-fields.js';

describe('domainErrorFields', () => {
  it('maps a DomainError to its errorCode field', () => {
    expect(domainErrorFields(rateLimitedError('too many runs'))).toEqual({
      errorCode: 'rate_limited',
    });
  });

  it('never carries the error message', () => {
    const fields = domainErrorFields(validationError('email failed validation'));
    expect(Object.keys(fields)).toEqual(['errorCode']);
  });
});
