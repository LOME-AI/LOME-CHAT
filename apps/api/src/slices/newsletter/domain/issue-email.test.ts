import { describe, expect, it } from 'vitest';
import { createMockEmailSender } from '../../notifications/index.js';
import { renderIssueEmail, sendIssueTest } from './issue-email.js';

const URLS = { apiUrl: 'https://api.hushbox.ai', marketingUrl: 'https://hushbox.ai' };

describe('renderIssueEmail', () => {
  const rendered = renderIssueEmail({
    subject: 'July release notes',
    bodyMarkdown: 'Hello **subscriber**',
    unsubscribeToken: 'tok-123',
    urls: URLS,
  });

  it('renders the markdown body into the issue template', () => {
    expect(rendered.subject).toBe('July release notes');
    expect(rendered.html).toContain('<strong>subscriber</strong>');
  });

  it('links the visible unsubscribe to the marketing goodbye page with the recipient token', () => {
    expect(rendered.html).toContain('https://hushbox.ai/newsletter/unsubscribed?token=tok-123');
  });

  it('keeps the RFC 8058 one-click header on the API unsubscribe route, not the page', () => {
    expect(rendered.headers).toEqual({
      'List-Unsubscribe': '<https://api.hushbox.ai/newsletter/unsubscribe?token=tok-123>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('includes the marketing unsubscribe link in the text alternative', () => {
    expect(rendered.text).toContain('https://hushbox.ai/newsletter/unsubscribed?token=tok-123');
  });
});

describe('sendIssueTest', () => {
  it('sends a single rendered email to the given address', async () => {
    const sender = createMockEmailSender();

    const result = await sendIssueTest({
      sender,
      subject: 'Draft preview',
      bodyMarkdown: 'A *draft*',
      to: 'admin@hushbox.ai',
    });

    expect(result.isOk()).toBe(true);
    const [sent] = sender.getSentMessages();
    expect(sent?.to).toBe('admin@hushbox.ai');
    expect(sent?.subject).toBe('Draft preview');
    expect(sent?.html).toContain('<em>draft</em>');
  });

  it('renders an inert unsubscribe link and no one-click headers', async () => {
    const sender = createMockEmailSender();

    const result = await sendIssueTest({
      sender,
      subject: 'Draft preview',
      bodyMarkdown: 'body',
      to: 'admin@hushbox.ai',
    });

    expect(result.isOk()).toBe(true);
    const [sent] = sender.getSentMessages();
    expect(sent?.html).toContain('href="#"');
    expect(sent?.headers).toBeUndefined();
  });
});
