/**
 * Persona roster for local-dev and E2E seeding — pure data plus the two
 * derivation helpers (`seedUUID`, `testPersonaName`) the orchestrator composes
 * with. No DB, no infra: the seed orchestrator feeds these records to the
 * factories.
 *
 * Money note: the legacy seed expressed persona balances and payment amounts as
 * 8-decimal dollar strings. This module expresses every monetary value as
 * integer nano-USD (`bigint`) — the money unit of the redesigned system — via
 * exact integer conversion (`usdDecimalToNanoUsd`); no floating point is used.
 */

// The frozen name → UUID hash lives in one module; re-exported here so persona
// callers get it from `seed-personas` without a second copy (its pinned-value
// test guards the algorithm).
export { seedUUID } from './seed-uuid.js';

/** Nano-USD (1e-9 USD) per whole USD. */
const NANO_USD_PER_USD = 1_000_000_000n;

/**
 * Exact integer conversion of a decimal dollar string (e.g. `'10000.00000000'`,
 * `'0.20000000'`, `'5'`) to nano-USD `bigint`. Accepts at most 9 fractional
 * digits (nano precision). No floating point — the fractional digits are padded
 * to 9 and combined with bigint math. Throws on malformed input (fail-fast).
 */
export function usdDecimalToNanoUsd(usd: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(usd.trim());
  if (!match) {
    throw new Error(`usdDecimalToNanoUsd: not a decimal dollar string: "${usd}"`);
  }
  const [, sign, whole, frac = ''] = match;
  if (frac.length > 9) {
    throw new Error(`usdDecimalToNanoUsd: more than 9 fractional digits: "${usd}"`);
  }
  const magnitude = BigInt(whole ?? '0') * NANO_USD_PER_USD + BigInt(frac.padEnd(9, '0'));
  return sign === '-' ? -magnitude : magnitude;
}

/** A local-dev persona (rich sample data, deterministic identity). */
export interface DevPersona {
  name: string;
  displayName: string;
  emailVerified: boolean;
  hasSampleData: boolean;
  /** Starting purchased-wallet balance in nano-USD. */
  balanceNanoUsd: bigint;
  conversationCount: number;
}

export const DEV_PERSONAS: DevPersona[] = [
  {
    name: 'alice',
    displayName: 'Sarah Chen',
    emailVerified: true,
    hasSampleData: true,
    balanceNanoUsd: usdDecimalToNanoUsd('10000.00000000'),
    conversationCount: 150,
  },
  {
    name: 'bob',
    displayName: 'Marcus Johnson',
    emailVerified: true,
    hasSampleData: false,
    balanceNanoUsd: usdDecimalToNanoUsd('0.20000000'),
    conversationCount: 3,
  },
  {
    name: 'charlie',
    displayName: 'Priya Patel',
    emailVerified: true,
    hasSampleData: false,
    balanceNanoUsd: usdDecimalToNanoUsd('0.00000000'),
    conversationCount: 3,
  },
];

export const TEST_2FA_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** Playwright project names; persona×project seeds per-project wallets. */
export const E2E_PROJECT_NAMES = [
  'chromium',
  'firefox',
  'webkit',
  'iphone-15',
  'pixel-7',
  'ipad-pro',
  'auth-tests',
] as const;

export type E2EProjectName = (typeof E2E_PROJECT_NAMES)[number];

/**
 * 2-char project codes used to suffix usernames. `username` is `varchar(20)` and
 * must stay unique across the persona×project cross-product — full project names
 * (e.g. "chromium" + a 20-char base displayName) would overflow.
 */
export const PROJECT_CODE: Record<E2EProjectName, string> = {
  chromium: 'cr',
  firefox: 'ff',
  webkit: 'wk',
  'iphone-15': 'ih',
  'pixel-7': 'px',
  'ipad-pro': 'ip',
  'auth-tests': 'au',
};

export interface BaseTestPersona {
  name: string;
  displayName: string;
  emailVerified: boolean;
  hasSampleData: boolean;
  totpSecret: string | null;
  /**
   * Authoritative starting purchased-wallet balance in nano-USD. Set last by the
   * e2e seed (`setWalletBalance`), overriding the mint's $0.20 welcome credit —
   * so a live AI send (the composer defaults to Smart Model, whose admission hold
   * exceeds the welcome credit) doesn't 402. `0n` deliberately zeroes the welcome
   * credit: the group-billing suite proves owner-funding by keeping the sender
   * broke.
   */
  balanceNanoUsd: bigint;
}

export interface SeededTestPersona extends BaseTestPersona {
  /** Pre-computed username (≤20 chars, unique). Use verbatim when seeding. */
  username: string;
}

/**
 * Default funded purchased-wallet balance ($100) for e2e personas that perform
 * live AI sends. Large enough to clear any admission hold (incl. Smart Model,
 * the composer default).
 */
const DEFAULT_TEST_BALANCE_NANO_USD = usdDecimalToNanoUsd('100.00000000');

export const BASE_TEST_PERSONAS: BaseTestPersona[] = [
  {
    name: 'test-alice',
    displayName: 'Test Alice',
    emailVerified: true,
    hasSampleData: true,
    totpSecret: null,
    // Paid-tier owner/sender across the group, realtime, and billing suites
    // (group-chat-billing.spec.ts requires exactly $100.00 purchased).
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-bob',
    displayName: 'Test Bob',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    // Deliberately broke: group-chat-billing.spec.ts proves owner-funding and
    // free-tier fallthrough by keeping Bob at $0 purchased (its "owner balance
    // exhausted" test asserts ownerRemaining = 0). `0n` zeroes the mint's
    // welcome credit.
    balanceNanoUsd: 0n,
  },
  {
    name: 'test-charlie',
    displayName: 'Test Charlie',
    emailVerified: false,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-dave',
    displayName: 'Test Dave',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  // Dedicated billing test users (isolated to avoid balance state bleeding
  // between tests). displayNames are abbreviated ("Bill" not "Billing") so the
  // normalized username + "_<2-char-project>" fits in varchar(20).
  {
    name: 'test-billing-success',
    displayName: 'Test Bill Success',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-billing-failure',
    displayName: 'Test Bill Failure',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-billing-validation',
    displayName: 'Test Bill Valid',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    // Funded default; the `lowBalancePage` fixture zeroes both wallets inline
    // when a test needs this persona broke.
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-billing-success-2',
    displayName: 'Test Bill OK 2',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-billing-devmode',
    displayName: 'Test Bill Dev',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-billing-token',
    displayName: 'Test Bill Token',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
  {
    name: 'test-2fa',
    displayName: 'Test 2FA User',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: TEST_2FA_TOTP_SECRET,
    balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
  },
];

const USERNAME_MAX_LENGTH = 20;

export const TEST_PERSONAS: SeededTestPersona[] = E2E_PROJECT_NAMES.flatMap((projectName) =>
  BASE_TEST_PERSONAS.map((p) => {
    const baseUsername = p.displayName.trim().toLowerCase().replaceAll(/\s+/g, '_');
    const username = `${baseUsername}_${PROJECT_CODE[projectName]}`;
    if (username.length > USERNAME_MAX_LENGTH) {
      throw new Error(
        `seed: persona username "${username}" exceeds ${String(USERNAME_MAX_LENGTH)} chars; shorten "${p.displayName}".`
      );
    }
    return {
      ...p,
      name: `${p.name}-${projectName}`,
      username,
    };
  })
);

/**
 * Single mobile-test persona — kept outside the E2E_PROJECT_NAMES cross-product
 * so Maestro flows can hardcode `test-mobile@test.hushbox.ai` without taking a
 * dependency on Playwright project state.
 */
export const MOBILE_TEST_PERSONA: SeededTestPersona = {
  name: 'test-mobile',
  displayName: 'Test Mobile',
  // Username is the shortest legal value (3 chars, ^[a-z][a-z0-9_]{2,19}$).
  // Maestro 2.6.0 spends ~10 s per character on Capacitor WebView inputs on
  // docker-android (UiDevice.pressKeyCode synchronous dispatch — Maestro
  // issue #2718), so trimming the username from 11 chars to 3 saves ~80 s per
  // `inputText ${TEST_USERNAME}` call in mobile-tests/flows.
  username: 'tmu',
  emailVerified: true,
  hasSampleData: true,
  totpSecret: null,
  balanceNanoUsd: DEFAULT_TEST_BALANCE_NANO_USD,
};

export function testPersonaName(baseName: string, projectName: E2EProjectName): string {
  return `${baseName}-${projectName}`;
}
