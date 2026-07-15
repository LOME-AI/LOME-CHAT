import { z } from 'zod';
import { FEE_CATEGORIES, formatFeePercent, TOTAL_FEE_RATE } from '@hushbox/shared';
import { COLORS } from './base.js';
import { defineEmailTemplate, heading, paragraph } from './builder.js';

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
  html: [
    heading(1, 'Welcome to HushBox'),
    paragraph({ text: '{{greeting}}', tone: 'primary', marginBottom: 8 }),
    paragraph({ text: 'One interface. Every feature. Private.' }),
    '\n',
    heading(2, 'How Billing Works'),
    paragraph({
      text: 'HushBox is pay-as-you-go. No subscriptions, no recurring charges. Add credits when you need them &mdash; they never expire.',
      fontSize: 14,
      marginBottom: 8,
    }),
    paragraph({
      text: `We charge a transparent ${totalFeePercent} fee on AI model usage:`,
      fontSize: 14,
      marginBottom: 4,
    }),
    `\n    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 16px 16px;">${feeRowsHtml}\n    </table>`,
    '\n',
    heading(2, 'Adding Credits'),
    paragraph({
      text: 'Visit the Billing page to add credits with any card. Your credits never expire and are ready to use across all models.',
      fontSize: 14,
    }),
    '\n',
    heading(2, 'For Mobile App Users'),
    paragraph({
      text: 'Tap &ldquo;Manage Balance Online&rdquo; to add credits through our website. We route you to the web to avoid passing high in-app processing fees on to you &mdash; keeping your costs low.',
      fontSize: 14,
    }),
    '\n  ',
  ].join(''),
  text: `HushBox

Welcome to HushBox

{{greeting}}

One interface. Every feature. Private.

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
