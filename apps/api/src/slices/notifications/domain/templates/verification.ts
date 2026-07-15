import { z } from 'zod';
import { COLORS } from './base.js';
import { defineEmailTemplate } from './builder.js';

const schema = z.object({
  userName: z.string().optional(),
  verificationUrl: z.string(),
  expiresInHours: z.number().optional(),
});

const DEFAULT_EXPIRES_IN_HOURS = 24;

export const verificationEmail = defineEmailTemplate({
  schema,
  prepare: (params) => {
    const greeting = params.userName ? `Hi ${params.userName},` : 'Hi,';
    const expiresInHours = String(params.expiresInHours ?? DEFAULT_EXPIRES_IN_HOURS);
    return {
      greeting,
      verificationUrl: params.verificationUrl,
      expiresInHours,
    };
  },
  // Hand-authored markup rather than the heading()/paragraph() helpers:
  // paragraph() emits only a bottom margin and always a line-height: 1.5, but
  // this template needs a top-margin paragraph (margin: 16px 0 0 0) and a
  // line-height-less 14px paragraph — neither is expressible via the helpers.
  html: `
    <h1 style="margin: 0 0 16px 0; color: ${COLORS.textPrimary}; font-size: 24px; font-weight: 600;">
      Welcome to HushBox
    </h1>
    <p style="margin: 0 0 8px 0; color: ${COLORS.textPrimary}; font-size: 16px; line-height: 1.5;">
      {{greeting}}
    </p>
    <p style="margin: 0 0 32px 0; color: ${COLORS.textSecondary}; font-size: 16px; line-height: 1.5;">
      Please verify your email address to get started.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 32px 0;">
      <tr>
        <td align="center" style="background-color: ${COLORS.accent}; border-radius: 8px;">
          <a href="{{verificationUrl}}" style="display: inline-block; padding: 16px 32px; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; min-width: 120px; text-align: center;">
            Verify Email
          </a>
        </td>
      </tr>
    </table>
    <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 14px;">
      This link expires in {{expiresInHours}} hours.
    </p>
    <p style="margin: 16px 0 0 0; color: ${COLORS.textSecondary}; font-size: 12px; line-height: 1.5;">
      If you didn't create an account with HushBox, you can safely ignore this email.
    </p>
  `,
  text: `HushBox

Welcome to HushBox

{{greeting}}

Please verify your email address to get started.

Verify your email by visiting this link:
{{verificationUrl}}

This link expires in {{expiresInHours}} hours.

If you didn't create an account with HushBox, you can safely ignore this email.

---
© 2026 LOME-AI LLC
Questions? hello@hushbox.ai
`,
});
