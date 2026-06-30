import { z } from 'zod';
import { FEE_CATEGORIES, formatFeePercent, TOTAL_FEE_RATE } from '@hushbox/shared';
import { COLORS } from './base.js';
import { defineEmailTemplate } from './builder.js';

const schema = z.object({
  userName: z.string().optional(),
});

const totalFeePercent = formatFeePercent(TOTAL_FEE_RATE);

const feeRowsHtml = FEE_CATEGORIES.map(
  (category) => `
      <tr>
        <td style="color: ${COLORS.accent}; font-size: 14px; padding: 2px 8px 2px 0; vertical-align: top;">&#8226;</td>
        <td style="color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">${formatFeePercent(category.rate)} &mdash; ${category.shortLabel}</td>
      </tr>`
).join('');

const feeBulletsText = FEE_CATEGORIES.map(
  (category) => `  - ${formatFeePercent(category.rate)} - ${category.shortLabel}`
).join('\n');

export const welcomeEmail = defineEmailTemplate({
  schema,
  prepare: (params) => {
    const greeting = params.userName ? `Hi ${params.userName},` : 'Hi,';
    return { greeting };
  },
  html: `
    <h1 style="margin: 0 0 16px 0; color: ${COLORS.textPrimary}; font-size: 24px; font-weight: 600;">
      Welcome to HushBox
    </h1>
    <p style="margin: 0 0 8px 0; color: ${COLORS.textPrimary}; font-size: 16px; line-height: 1.5;">
      {{greeting}}
    </p>
    <p style="margin: 0 0 16px 0; color: ${COLORS.textSecondary}; font-size: 16px; line-height: 1.5;">
      One interface. Every AI model. Private.
    </p>

    <h2 style="margin: 0 0 8px 0; color: ${COLORS.textPrimary}; font-size: 18px; font-weight: 600;">
      How Billing Works
    </h2>
    <p style="margin: 0 0 8px 0; color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">
      HushBox is pay-as-you-go. No subscriptions, no recurring charges. Add credits when you need them &mdash; they never expire.
    </p>
    <p style="margin: 0 0 4px 0; color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">
      We charge a transparent ${totalFeePercent} fee on AI model usage:
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 16px 16px;">${feeRowsHtml}
    </table>

    <h2 style="margin: 0 0 8px 0; color: ${COLORS.textPrimary}; font-size: 18px; font-weight: 600;">
      Adding Credits
    </h2>
    <p style="margin: 0 0 16px 0; color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">
      Visit the Billing page to add credits with any card. Your credits never expire and are ready to use across all models.
    </p>

    <h2 style="margin: 0 0 8px 0; color: ${COLORS.textPrimary}; font-size: 18px; font-weight: 600;">
      For Mobile App Users
    </h2>
    <p style="margin: 0 0 16px 0; color: ${COLORS.textSecondary}; font-size: 14px; line-height: 1.5;">
      Tap &ldquo;Manage Balance Online&rdquo; to add credits through our website. We route you to the web to avoid passing high in-app processing fees on to you &mdash; keeping your costs low.
    </p>
  `,
  text: `HushBox

Welcome to HushBox

{{greeting}}

One interface. Every AI model. Private.

How Billing Works
-----------------
HushBox is pay-as-you-go. No subscriptions, no recurring charges. Add credits when you need them - they never expire.

We charge a transparent ${totalFeePercent} fee on AI model usage:
${feeBulletsText}

Adding Credits
--------------
Visit the Billing page to add credits with any card. Your credits never expire and are ready to use across all models.

For Mobile App Users
--------------------
Tap "Manage Balance Online" to add credits through our website. We route you to the web to avoid passing high in-app processing fees on to you - keeping your costs low.

---
© 2026 LOME-AI LLC
Questions? hello@hushbox.ai
`,
});
