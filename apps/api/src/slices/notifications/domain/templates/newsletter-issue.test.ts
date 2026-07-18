import { describe, it, expect } from 'vitest';
import { NEWSLETTER_POSTAL_ADDRESS } from '@hushbox/shared';
import { newsletterIssueEmail } from './newsletter-issue.js';

describe('newsletterIssueEmail', () => {
  const params = {
    subject: 'July at HushBox',
    bodyMarkdown:
      '## What shipped\n\nSomething **big** landed. [Read more](https://hushbox.ai/blog).',
    unsubscribeUrl: 'https://hushbox.ai/newsletter/unsubscribe?token=xyz789',
  };

  it('renders markdown headings into the html', () => {
    const result = newsletterIssueEmail(params);

    expect(result.html).toMatch(/<h2[^>]*>What shipped<\/h2>/);
  });

  it('renders markdown bold into the html', () => {
    const result = newsletterIssueEmail(params);

    expect(result.html).toContain('<strong>big</strong>');
  });

  it('renders markdown links into the html', () => {
    const result = newsletterIssueEmail(params);

    expect(result.html).toContain('href="https://hushbox.ai/blog"');
  });

  it('escapes html in the subject while markdown-rendered tags survive', () => {
    const result = newsletterIssueEmail({
      ...params,
      subject: 'Fun <script>alert(1)</script>',
    });

    expect(result.html).toContain('Fun &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.html).not.toContain('<script>');
    expect(result.html).toMatch(/<h2[^>]*>What shipped<\/h2>/);
  });

  it('contains the postal address footer', () => {
    const result = newsletterIssueEmail(params);

    expect(result.html).toContain(NEWSLETTER_POSTAL_ADDRESS);
    expect(result.html).toContain('HushBox ·');
  });

  it('contains the provenance line', () => {
    const result = newsletterIssueEmail(params);

    expect(result.html).toContain("You're receiving this because you subscribed at hushbox.ai.");
  });

  it('links unsubscribe to the unsubscribe url', () => {
    const result = newsletterIssueEmail(params);

    expect(result.html).toContain('href="https://hushbox.ai/newsletter/unsubscribe?token=xyz789"');
    expect(result.html).toContain('Unsubscribe');
  });

  it('renders the text variant with the raw markdown body', () => {
    const result = newsletterIssueEmail(params);

    expect(result.text).toContain('## What shipped');
    expect(result.text).toContain('Something **big** landed.');
  });

  it('renders the text variant footer with the unsubscribe url', () => {
    const result = newsletterIssueEmail(params);

    expect(result.text).toContain(NEWSLETTER_POSTAL_ADDRESS);
    expect(result.text).toContain("You're receiving this because you subscribed at hushbox.ai.");
    expect(result.text).toContain('https://hushbox.ai/newsletter/unsubscribe?token=xyz789');
  });

  it('rejects missing params', () => {
    expect(() => newsletterIssueEmail({ subject: 'x' } as unknown as typeof params)).toThrow();
  });

  it('wraps the content in the base template', () => {
    const result = newsletterIssueEmail(params);

    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('LOME-AI LLC');
  });
});
