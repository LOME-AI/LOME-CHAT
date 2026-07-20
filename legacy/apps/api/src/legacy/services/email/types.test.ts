import { describe, it, expect } from 'vitest';
import type { EmailOptions } from './types.js';

describe('EmailOptions type', () => {
  it('requires to, subject, and html fields', () => {
    const validEmail: EmailOptions = {
      to: 'test@example.com',
      subject: 'Subject',
      html: '<p>Body</p>',
    };

    expect(validEmail.to).toBeDefined();
    expect(validEmail.subject).toBeDefined();
    expect(validEmail.html).toBeDefined();
  });

  it('allows optional from field', () => {
    const emailWithFrom: EmailOptions = {
      to: 'test@example.com',
      subject: 'Subject',
      html: '<p>Body</p>',
      from: 'sender@example.com',
    };

    expect(emailWithFrom.from).toBe('sender@example.com');
  });
});
