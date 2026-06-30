import { describe, it, expect } from 'vitest';
import { FEE_CATEGORIES, formatFeePercent, TOTAL_FEE_RATE } from '@hushbox/shared';
import { welcomeEmail } from './welcome.js';

describe('welcomeEmail', () => {
  it('contains the welcome title', () => {
    const result = welcomeEmail({});

    expect(result.html).toContain('Welcome to HushBox');
  });

  it('greets the user by name when provided', () => {
    const result = welcomeEmail({ userName: 'Alice' });

    expect(result.html).toContain('Hi Alice,');
  });

  it('uses a generic greeting when no user name is provided', () => {
    const result = welcomeEmail({});

    expect(result.html).toContain('Hi,');
    expect(result.html).not.toContain('undefined');
  });

  it('states the total fee percentage', () => {
    const result = welcomeEmail({});

    expect(result.html).toContain(formatFeePercent(TOTAL_FEE_RATE));
  });

  it('lists every fee category in the html output', () => {
    const result = welcomeEmail({});

    for (const category of FEE_CATEGORIES) {
      expect(result.html).toContain(category.shortLabel);
    }
  });

  it('lists every fee category in the text output', () => {
    const result = welcomeEmail({});

    for (const category of FEE_CATEGORIES) {
      expect(result.text).toContain(category.shortLabel);
    }
  });

  it('mentions the mobile billing handoff', () => {
    const result = welcomeEmail({});

    expect(result.html).toContain('Manage Balance Online');
  });
});
