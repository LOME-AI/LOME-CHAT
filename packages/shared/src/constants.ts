export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** Shared password for all dev personas. Only for local development. */
export const DEV_PASSWORD = 'password123';

/** Email domain for development personas */
export const DEV_EMAIL_DOMAIN = 'dev.lome-chat.com';

/** Email domain for test personas (used by E2E tests) */
export const TEST_EMAIL_DOMAIN = 'test.lome-chat.com';

/** Model ID for the "Strongest" quick-select button */
export const STRONGEST_MODEL_ID = 'anthropic/claude-3.5-sonnet';

/** Model ID for the "Value" quick-select button */
export const VALUE_MODEL_ID = 'meta-llama/llama-3.1-70b-instruct';
