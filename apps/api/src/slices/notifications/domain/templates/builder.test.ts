import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { escapeHtml, defineEmailTemplate, heading, paragraph } from './builder.js';

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes quotes', () => {
    expect(escapeHtml(`He said "hello" and 'goodbye'`)).toBe(
      'He said &quot;hello&quot; and &#39;goodbye&#39;'
    );
  });

  it('returns plain text unchanged', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
  });
});

describe('defineEmailTemplate', () => {
  it('throws on missing placeholder key', () => {
    const schema = z.object({ name: z.string() });
    const template = defineEmailTemplate({
      schema,
      prepare: (params) => ({ name: params.name }),
      html: '<p>{{greeting}}</p>',
      text: '{{greeting}}',
    });

    expect(() => template({ name: 'Alice' })).toThrow('Missing template placeholder: {{greeting}}');
  });

  it('validates input via Zod and rejects invalid params', () => {
    const schema = z.object({ age: z.number() });
    const template = defineEmailTemplate({
      schema,
      prepare: (params) => ({ age: String(params.age) }),
      html: '<p>{{age}}</p>',
      text: '{{age}}',
    });

    expect(() => template({ age: 'not a number' as unknown as number })).toThrow();
  });

  it('produces html wrapped in base template', () => {
    const schema = z.object({ message: z.string() });
    const template = defineEmailTemplate({
      schema,
      prepare: (params) => ({ message: params.message }),
      html: '<p>{{message}}</p>',
      text: '{{message}}',
    });

    const result = template({ message: 'Test' });

    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('<p>Test</p>');
    expect(result.html).toContain('Hush<span');
    expect(result.html).toContain('Box</span>');
    expect(result.html).toContain('LOME-AI LLC');
  });

  it('HTML-escapes values in html output', () => {
    const schema = z.object({ userInput: z.string() });
    const template = defineEmailTemplate({
      schema,
      prepare: (params) => ({ userInput: params.userInput }),
      html: '<p>{{userInput}}</p>',
      text: '{{userInput}}',
    });

    const result = template({ userInput: '<script>alert("xss")</script>' });

    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).not.toContain('<script>');
  });

  it('does NOT escape values in text output', () => {
    const schema = z.object({ userInput: z.string() });
    const template = defineEmailTemplate({
      schema,
      prepare: (params) => ({ userInput: params.userInput }),
      html: '<p>{{userInput}}</p>',
      text: '{{userInput}}',
    });

    const result = template({ userInput: '<script>alert("xss")</script>' });

    expect(result.text).toBe('<script>alert("xss")</script>');
  });

  it('handles a template with no placeholders', () => {
    const schema = z.object({});
    const template = defineEmailTemplate({
      schema,
      prepare: () => ({}),
      html: '<p>Static content</p>',
      text: 'Static content',
    });

    const result = template({});

    expect(result.html).toContain('<p>Static content</p>');
    expect(result.text).toBe('Static content');
  });
});

describe('heading', () => {
  it('renders an h1 with the primary color and 24px size', () => {
    expect(heading(1, 'Title')).toBe(
      '\n    <h1 style="margin: 0 0 16px 0; color: #fafafa; font-size: 24px; font-weight: 600;">\n      Title\n    </h1>'
    );
  });

  it('renders an h2 with the tighter margin and 18px size', () => {
    expect(heading(2, 'Sub')).toBe(
      '\n    <h2 style="margin: 0 0 8px 0; color: #fafafa; font-size: 18px; font-weight: 600;">\n      Sub\n    </h2>'
    );
  });
});

describe('paragraph', () => {
  it('defaults to secondary color, 16px, and a 16px bottom margin', () => {
    expect(paragraph({ text: 'Body' })).toBe(
      '\n    <p style="margin: 0 0 16px 0; color: #a1a1aa; font-size: 16px; line-height: 1.5;">\n      Body\n    </p>'
    );
  });

  it('uses the primary color and given bottom margin when asked', () => {
    expect(paragraph({ text: '{{greeting}}', tone: 'primary', marginBottom: 8 })).toBe(
      '\n    <p style="margin: 0 0 8px 0; color: #fafafa; font-size: 16px; line-height: 1.5;">\n      {{greeting}}\n    </p>'
    );
  });

  it('collapses a zero bottom margin to `margin: 0`', () => {
    expect(paragraph({ text: 'Fine print', fontSize: 12, marginBottom: 0 })).toBe(
      '\n    <p style="margin: 0; color: #a1a1aa; font-size: 12px; line-height: 1.5;">\n      Fine print\n    </p>'
    );
  });
});
