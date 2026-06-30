import { wrapInBaseTemplate } from './base.js';
import type { z } from 'zod';

export interface EmailContent {
  html: string;
  text: string;
}

export function escapeHtml(string_: string): string {
  return string_
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function replacePlaceholders(
  template: string,
  values: Record<string, string>,
  escape: boolean
): string {
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Missing template placeholder: {{${key}}}`);
    }
    return escape ? escapeHtml(value) : value;
  });
}

export function defineEmailTemplate<T extends z.ZodType>(config: {
  schema: T;
  prepare: (params: z.output<T>) => Record<string, string>;
  html: string;
  text: string;
}): (params: z.input<T>) => EmailContent {
  return (params) => {
    const validated = config.schema.parse(params);
    const values = config.prepare(validated);
    return {
      html: wrapInBaseTemplate(replacePlaceholders(config.html, values, true)),
      text: replacePlaceholders(config.text, values, false),
    };
  };
}
