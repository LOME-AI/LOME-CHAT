import { describe, it, expect } from 'vitest';
import { verificationEmail } from './verification.js';

describe('verificationEmail', () => {
  const params = { verificationUrl: 'https://hushbox.ai/verify-email?token=abc123' };

  it('contains the verification url in the html button', () => {
    const result = verificationEmail(params);

    expect(result.html).toContain('href="https://hushbox.ai/verify-email?token=abc123"');
  });

  it('contains the verification url in the text output', () => {
    const result = verificationEmail(params);

    expect(result.text).toContain('https://hushbox.ai/verify-email?token=abc123');
  });

  it('greets the user by name when provided', () => {
    const result = verificationEmail({ ...params, userName: 'Alice' });

    expect(result.html).toContain('Hi Alice,');
  });

  it('uses a generic greeting when no user name is provided', () => {
    const result = verificationEmail(params);

    expect(result.html).toContain('Hi,');
    expect(result.html).not.toContain('undefined');
  });

  it('escapes html in the user name', () => {
    const result = verificationEmail({ ...params, userName: '<b>Eve</b>' });

    expect(result.html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
    expect(result.html).not.toContain('<b>Eve</b>');
  });

  it('defaults the expiry to 24 hours', () => {
    const result = verificationEmail(params);

    expect(result.html).toContain('24 hours');
  });

  it('uses a custom expiry when provided', () => {
    const result = verificationEmail({ ...params, expiresInHours: 48 });

    expect(result.html).toContain('48 hours');
    expect(result.html).not.toContain('24 hours');
  });

  it('rejects a missing verification url', () => {
    expect(() => verificationEmail({} as { verificationUrl: string })).toThrow();
  });

  it('wraps the content in the base template', () => {
    const result = verificationEmail(params);

    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('LOME-AI LLC');
  });
});
