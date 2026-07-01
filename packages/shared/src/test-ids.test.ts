import { describe, it, expect } from 'vitest';
import { TEST_IDS, TEST_ID_BUILDERS } from './test-ids.js';

describe('TEST_IDS', () => {
  const entries = Object.entries(TEST_IDS);
  const values = Object.values(TEST_IDS);

  it('is a non-empty registry of static test ids', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('has every value as a non-empty string', () => {
    for (const [key, value] of entries) {
      expect(typeof value, `TEST_IDS.${key} is not a string`).toBe('string');
      expect(value.length, `TEST_IDS.${key} is empty`).toBeGreaterThan(0);
    }
  });

  it('has every value in kebab-case', () => {
    for (const [key, value] of entries) {
      expect(value, `TEST_IDS.${key} = "${value}" is not kebab-case`).toMatch(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/
      );
    }
  });

  it('has every key in camelCase', () => {
    for (const key of Object.keys(TEST_IDS)) {
      expect(key, `TEST_IDS key "${key}" is not camelCase`).toMatch(/^[a-z][a-zA-Z0-9]*$/);
    }
  });

  it('has no duplicate values', () => {
    const unique = new Set(values);
    expect(unique.size, 'TEST_IDS has duplicate values').toBe(values.length);
  });
});

describe('TEST_ID_BUILDERS', () => {
  it('builds member-scoped ids from a member id', () => {
    expect(TEST_ID_BUILDERS.memberItem('abc')).toBe('member-item-abc');
    expect(TEST_ID_BUILDERS.memberActions('abc')).toBe('member-actions-abc');
    expect(TEST_ID_BUILDERS.memberAvatar('abc')).toBe('member-avatar-abc');
    expect(TEST_ID_BUILDERS.memberChangePrivilege('abc')).toBe('member-change-privilege-abc');
    expect(TEST_ID_BUILDERS.memberRemoveAction('abc')).toBe('member-remove-action-abc');
    expect(TEST_ID_BUILDERS.memberOnline('abc')).toBe('member-online-abc');
  });

  it('builds an online indicator id from an entity id and prefix', () => {
    expect(TEST_ID_BUILDERS.onlineFor('member', 'm1')).toBe('member-online-m1');
    expect(TEST_ID_BUILDERS.onlineFor('member-avatar', 'm1')).toBe('member-avatar-online-m1');
  });

  it('builds a facepile online indicator id from a member id', () => {
    expect(TEST_ID_BUILDERS.onlineIndicator('user-1')).toBe('online-indicator-user-1');
  });

  it('builds a member section id from a privilege', () => {
    expect(TEST_ID_BUILDERS.memberSection('write')).toBe('member-section-write');
  });

  it('builds a privilege option id from a member id and privilege', () => {
    expect(TEST_ID_BUILDERS.privilegeOption('m1', 'admin')).toBe('privilege-option-m1-admin');
  });

  it('builds link-scoped ids from a link id', () => {
    expect(TEST_ID_BUILDERS.linkItem('l1')).toBe('link-item-l1');
    expect(TEST_ID_BUILDERS.linkActions('l1')).toBe('link-actions-l1');
    expect(TEST_ID_BUILDERS.linkNameInput('l1')).toBe('link-name-input-l1');
    expect(TEST_ID_BUILDERS.linkChangeName('l1')).toBe('link-change-name-l1');
    expect(TEST_ID_BUILDERS.linkChangePrivilege('l1')).toBe('link-change-privilege-l1');
    expect(TEST_ID_BUILDERS.linkRevokeAction('l1')).toBe('link-revoke-action-l1');
  });

  it('builds a link privilege option id from a link id and privilege', () => {
    expect(TEST_ID_BUILDERS.linkPrivilegeOption('l1', 'write')).toBe(
      'link-privilege-option-l1-write'
    );
  });

  it('builds a model item id from a model id', () => {
    expect(TEST_ID_BUILDERS.modelItem('openai/gpt-4o')).toBe('model-item-openai/gpt-4o');
  });

  it('builds fee item ids from a fee category id', () => {
    expect(TEST_ID_BUILDERS.feeItem('payment-processing')).toBe('item-fee-payment-processing');
    expect(TEST_ID_BUILDERS.feeItemPct('payment-processing')).toBe(
      'item-fee-payment-processing-pct'
    );
  });

  it('builds budget-scoped ids from a member id', () => {
    expect(TEST_ID_BUILDERS.budgetMember('m1')).toBe('budget-member-m1');
    expect(TEST_ID_BUILDERS.budgetInput('m1')).toBe('budget-input-m1');
    expect(TEST_ID_BUILDERS.budgetValue('m1')).toBe('budget-value-m1');
  });

  it('builds budget message ids from an error id', () => {
    expect(TEST_ID_BUILDERS.budgetMessage('trial_notice')).toBe('budget-message-trial_notice');
    expect(TEST_ID_BUILDERS.budgetMessageIcon('trial_notice')).toBe(
      'budget-message-icon-trial_notice'
    );
    expect(TEST_ID_BUILDERS.budgetDismiss('trial_notice')).toBe('budget-dismiss-trial_notice');
  });

  it('builds a kpi value id from a base kpi id', () => {
    expect(TEST_ID_BUILDERS.kpiValue('kpi-messages')).toBe('kpi-messages-value');
  });

  it('builds a fork tab id from a fork id', () => {
    expect(TEST_ID_BUILDERS.forkTab('f1')).toBe('fork-tab-f1');
  });

  it('builds a date range id from a range value', () => {
    expect(TEST_ID_BUILDERS.range('30d')).toBe('range-30d');
  });

  it('builds a persona card id from a persona name', () => {
    expect(TEST_ID_BUILDERS.personaCard('alice')).toBe('persona-card-alice');
  });

  it('builds a suggestion slot id from an index', () => {
    expect(TEST_ID_BUILDERS.suggestionSlot(0)).toBe('suggestion-slot-0');
  });

  it('builds a word check id from an index', () => {
    expect(TEST_ID_BUILDERS.wordCheck(3)).toBe('word-check-3');
  });

  it('builds an add member result id from a user id', () => {
    expect(TEST_ID_BUILDERS.addMemberResult('u1')).toBe('add-member-result-u1');
  });

  it('builds a dev simulate id from a code', () => {
    expect(TEST_ID_BUILDERS.devSimulate('rate_limited')).toBe('dev-simulate-rate_limited');
  });

  it('builds a splash id from a variant', () => {
    expect(TEST_ID_BUILDERS.splash('dark')).toBe('splash-dark');
  });

  it('builds a social banner id from a variant', () => {
    expect(TEST_ID_BUILDERS.socialBanner('dark')).toBe('social-banner-dark');
    expect(TEST_ID_BUILDERS.socialBanner('light')).toBe('social-banner-light');
  });

  it('builds asset ids from an asset name', () => {
    expect(TEST_ID_BUILDERS.assetCard('banner')).toBe('asset-card-banner');
    expect(TEST_ID_BUILDERS.assetPreview('banner')).toBe('asset-preview-banner');
    expect(TEST_ID_BUILDERS.assetLink('banner')).toBe('asset-link-banner');
    expect(TEST_ID_BUILDERS.assetOpenImage('banner')).toBe('asset-open-image-banner');
  });

  it('builds a resolution group id from a resolution name', () => {
    expect(TEST_ID_BUILDERS.resolutionGroup('mobile')).toBe('resolution-group-mobile');
  });

  it('builds screenshot ids from a resolution name and screenshot name', () => {
    expect(TEST_ID_BUILDERS.screenshotCard('mobile', 'home')).toBe('screenshot-card-mobile-home');
    expect(TEST_ID_BUILDERS.screenshotOpenImage('mobile', 'home')).toBe(
      'screenshot-open-image-mobile-home'
    );
  });

  it('builds an email iframe id from a template name', () => {
    expect(TEST_ID_BUILDERS.emailIframe('verify')).toBe('email-iframe-verify');
  });
});
