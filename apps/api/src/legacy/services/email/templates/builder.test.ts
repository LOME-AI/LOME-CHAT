import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { escapeHtml, defineEmailTemplate } from './builder.js';

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    const result = escapeHtml('Tom & Jerry');

    expect(result).toBe('Tom &amp; Jerry');
  });

  it('escapes angle brackets', () => {
    const result = escapeHtml('<script>alert("xss")</script>');

    expect(result).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('escapes quotes', () => {
    const result = escapeHtml(`He said "hello" and 'goodbye'`);

    expect(result).toBe('He said &quot;hello&quot; and &#39;goodbye&#39;');
  });

  it('returns plain text unchanged', () => {
    const result = escapeHtml('Hello World');

    expect(result).toBe('Hello World');
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

  it('handles template with no placeholders', () => {
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
