import { describe, it, expect } from 'vitest';
import { NEWSLETTER_POSTAL_ADDRESS } from '@hushbox/shared';
import { newsletterConfirmationEmail } from './newsletter-confirmation.js';

describe('newsletterConfirmationEmail', () => {
  const params = { confirmUrl: 'https://hushbox.ai/newsletter/confirm?token=abc123' };

  it('contains the card heading', () => {
    const result = newsletterConfirmationEmail(params);

    expect(result.html).toContain('Confirm your subscription');
  });

  it('contains the scoundrel body line', () => {
    const result = newsletterConfirmationEmail(params);

    expect(result.html).toContain(
      'You (or some scoundrel with your email address) asked to join the HushBox mailing list. Either way, nothing happens until you confirm.'
    );
  });

  it('links the button to the confirm url', () => {
    const result = newsletterConfirmationEmail(params);

    expect(result.html).toContain('href="https://hushbox.ai/newsletter/confirm?token=abc123"');
    expect(result.html).toContain('Confirm subscription');
  });

  it('contains the expiry fine print', () => {
    const result = newsletterConfirmationEmail(params);

    expect(result.html).toContain('This link expires in 24 hours.');
  });

  it('contains the not-you fine print', () => {
    const result = newsletterConfirmationEmail(params);

    expect(result.html).toContain("Not you? Ignore this email and we'll never write again.");
  });

  it('contains the confirm url in the text output', () => {
    const result = newsletterConfirmationEmail(params);

    expect(result.text).toContain('https://hushbox.ai/newsletter/confirm?token=abc123');
    expect(result.text).toContain('nothing happens until you confirm');
  });

  it('has no postal address', () => {
    const result = newsletterConfirmationEmail(params);

    expect(result.html).not.toContain(NEWSLETTER_POSTAL_ADDRESS);
    expect(result.text).not.toContain(NEWSLETTER_POSTAL_ADDRESS);
  });

  it('has no unsubscribe link', () => {
    const result = newsletterConfirmationEmail(params);

    expect(result.html.toLowerCase()).not.toContain('unsubscribe');
    expect(result.text.toLowerCase()).not.toContain('unsubscribe');
  });

  it('rejects a missing confirm url', () => {
    expect(() => newsletterConfirmationEmail({} as { confirmUrl: string })).toThrow();
  });

  it('wraps the content in the base template', () => {
    const result = newsletterConfirmationEmail(params);

    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('LOME-AI LLC');
  });
});
