import { COLORS, wrapInBaseTemplate } from './base.js';
import type { z } from 'zod';

export interface EmailContent {
  html: string;
  text: string;
}

/**
 * The email content blocks: a heading or paragraph rendered with the shared
 * dark-theme inline styles (email clients strip <style> blocks, so every rule
 * must be inline). Each returns the exact `\n    <tag …>\n      inner\n    </tag>`
 * fragment templates compose directly — killing the copy-pasted `<h1 style=…>`
 * / `<p style=…>` boilerplate while rendering byte-identical HTML. `inner` is
 * placed verbatim (may hold `{{placeholders}}` or inline anchors); the
 * `defineEmailTemplate` pass escapes only the placeholder values.
 */
export function heading(level: 1 | 2, inner: string): string {
  const marginBottom = level === 1 ? 16 : 8;
  const fontSize = level === 1 ? 24 : 18;
  return `
    <h${String(level)} style="margin: 0 0 ${String(marginBottom)}px 0; color: ${COLORS.textPrimary}; font-size: ${String(fontSize)}px; font-weight: 600;">
      ${inner}
    </h${String(level)}>`;
}

export function paragraph(config: {
  readonly text: string;
  readonly tone?: 'primary' | 'secondary';
  readonly fontSize?: number;
  readonly marginBottom?: number;
}): string {
  const color = config.tone === 'primary' ? COLORS.textPrimary : COLORS.textSecondary;
  const fontSize = config.fontSize ?? 16;
  const marginBottom = config.marginBottom ?? 16;
  const margin = marginBottom === 0 ? 'margin: 0;' : `margin: 0 0 ${String(marginBottom)}px 0;`;
  return `
    <p style="${margin} color: ${color}; font-size: ${String(fontSize)}px; line-height: 1.5;">
      ${config.text}
    </p>`;
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
