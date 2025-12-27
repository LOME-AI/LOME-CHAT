import { describe, it, expect } from 'vitest';
import {
  MESSAGE_ROLES,
  DEV_PASSWORD,
  DEV_EMAIL_DOMAIN,
  TEST_EMAIL_DOMAIN,
  STRONGEST_MODEL_ID,
  VALUE_MODEL_ID,
} from '../constants.js';

describe('MESSAGE_ROLES', () => {
  it('contains user, assistant, and system roles', () => {
    expect(MESSAGE_ROLES).toEqual(['user', 'assistant', 'system']);
  });
});

describe('DEV_PASSWORD', () => {
  it('is a non-empty string', () => {
    expect(typeof DEV_PASSWORD).toBe('string');
    expect(DEV_PASSWORD.length).toBeGreaterThan(0);
  });

  it('has at least 8 characters for minimal security', () => {
    expect(DEV_PASSWORD.length).toBeGreaterThanOrEqual(8);
  });
});

describe('DEV_EMAIL_DOMAIN', () => {
  it('is dev.lome-chat.com', () => {
    expect(DEV_EMAIL_DOMAIN).toBe('dev.lome-chat.com');
  });
});

describe('TEST_EMAIL_DOMAIN', () => {
  it('is test.lome-chat.com', () => {
    expect(TEST_EMAIL_DOMAIN).toBe('test.lome-chat.com');
  });

  it('is different from DEV_EMAIL_DOMAIN', () => {
    expect(TEST_EMAIL_DOMAIN).not.toBe(DEV_EMAIL_DOMAIN);
  });
});

describe('STRONGEST_MODEL_ID', () => {
  it('is anthropic/claude-3.5-sonnet', () => {
    expect(STRONGEST_MODEL_ID).toBe('anthropic/claude-3.5-sonnet');
  });

  it('follows provider/model format', () => {
    expect(STRONGEST_MODEL_ID).toMatch(/^[a-z-]+\/[a-z0-9.-]+$/);
  });
});

describe('VALUE_MODEL_ID', () => {
  it('is meta-llama/llama-3.1-70b-instruct', () => {
    expect(VALUE_MODEL_ID).toBe('meta-llama/llama-3.1-70b-instruct');
  });

  it('follows provider/model format', () => {
    expect(VALUE_MODEL_ID).toMatch(/^[a-z-]+\/[a-z0-9.-]+$/);
  });

  it('is different from STRONGEST_MODEL_ID', () => {
    expect(VALUE_MODEL_ID).not.toBe(STRONGEST_MODEL_ID);
  });
});
