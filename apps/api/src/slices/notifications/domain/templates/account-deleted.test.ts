import { describe, it, expect } from 'vitest';
import { accountDeletedEmail } from './account-deleted.js';

describe('accountDeletedEmail', () => {
  it('contains the account deleted title', () => {
    const result = accountDeletedEmail({});

    expect(result.html).toContain('Account Permanently Deleted');
  });

  it('mentions the permanent deletion', () => {
    const result = accountDeletedEmail({});

    expect(result.html).toContain('permanently deleted');
  });

  it('mentions financial-record retention', () => {
    const result = accountDeletedEmail({});

    expect(result.html).toContain('Financial records');
  });

  it('contains the security contact', () => {
    const result = accountDeletedEmail({});

    expect(result.html).toContain('security@hushbox.ai');
    expect(result.text).toContain('security@hushbox.ai');
  });
});
