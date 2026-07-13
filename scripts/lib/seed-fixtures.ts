/**
 * Curated fixture content for local-dev seeding — pure data structures, no DB
 * writes. The seed orchestrator feeds these to the conversation / payment /
 * usage factories (each row addressed by `seedUUID(seedKey)` or a per-record
 * derivation), resolving the wall-clock "now" from the relative offsets carried
 * here.
 *
 * Money note: legacy stored payment amounts and usage costs as 8-decimal dollar
 * strings and computed costs with floating point. This module expresses every
 * monetary value as integer nano-USD (`bigint`); usage costs are derived with
 * exact bigint math from per-1k-token nano rates (see the deliberate-change note
 * on `computeCostNanoUsd`).
 */

/** A single message inside a curated conversation. */
export interface FixtureMessageSpec {
  /** Persona name for a user message, or `'ai'` for an assistant reply. */
  sender: string;
  text: string;
}

/** A curated screenshot conversation the orchestrator seeds verbatim. */
export interface ScreenshotConversationSpec {
  /** Deterministic key; the row id is `seedUUID(seedKey)`. */
  seedKey: string;
  /** Persona name that owns the conversation. */
  ownerPersona: string;
  /** Persona names for a group conversation; omitted for a solo conversation. */
  members?: string[];
  messages: FixtureMessageSpec[];
}

const CHAT_USER_MESSAGE =
  'Can you explain how async/await works in JavaScript and show me an example with error handling?';

const CHAT_AI_MESSAGE =
  '## Async/Await in JavaScript\n\n`async/await` is syntactic sugar over Promises that makes asynchronous code look synchronous.\n\n### How It Works\n\n1. **`async`** keyword before a function makes it return a Promise\n2. **`await`** pauses execution until the Promise resolves\n\n### Example with Error Handling\n\n```javascript\nasync function fetchUserData(userId) {\n  try {\n    const response = await fetch(`/api/users/${userId}`);\n    if (!response.ok) {\n      throw new Error(`HTTP ${response.status}`);\n    }\n    const data = await response.json();\n    return data;\n  } catch (error) {\n    console.error("Failed to fetch user:", error.message);\n    throw error;\n  }\n}\n```\n\nThe `try/catch` block handles both network errors and HTTP error responses cleanly.';

const CODE_USER_MESSAGE = 'Write a React hook that fetches data with loading and error states';

const CODE_AI_MESSAGE =
  'Here\'s a reusable data fetching hook:\n\n```typescript\nimport { useState, useEffect, useCallback } from "react";\n\ninterface UseFetchResult<T> {\n  data: T | null;\n  isLoading: boolean;\n  error: Error | null;\n  refetch: () => void;\n}\n\nexport function useFetch<T>(url: string): UseFetchResult<T> {\n  const [data, setData] = useState<T | null>(null);\n  const [isLoading, setIsLoading] = useState(true);\n  const [error, setError] = useState<Error | null>(null);\n\n  const fetchData = useCallback(async () => {\n    setIsLoading(true);\n    setError(null);\n    try {\n      const response = await fetch(url);\n      if (!response.ok) {\n        throw new Error(`HTTP error: ${response.status}`);\n      }\n      const result = await response.json();\n      setData(result as T);\n    } catch (err) {\n      setError(err instanceof Error ? err : new Error("Unknown error"));\n    } finally {\n      setIsLoading(false);\n    }\n  }, [url]);\n\n  useEffect(() => {\n    void fetchData();\n  }, [fetchData]);\n\n  return { data, isLoading, error, refetch: fetchData };\n}\n```\n\nUsage:\n```tsx\nconst { data, isLoading, error } = useFetch<User[]>("/api/users");\n```';

const MERMAID_USER_MESSAGE =
  'Show me a simple flowchart for how a user signs up and verifies their email';

const MERMAID_AI_MESSAGE =
  "Here's the signup and email verification flow:\n\n```mermaid\nflowchart TD\n    A[User visits signup page] --> B[Fills in email & password]\n    B --> C[Clicks Sign Up]\n    C --> D[Server creates account]\n    D --> E[Verification email sent]\n    E --> F[User opens email]\n    F --> G[Clicks verification link]\n    G --> H{Token valid?}\n    H -->|Yes| I[Account verified]\n    H -->|No| J[Show error message]\n    I --> K[Redirect to dashboard]\n    J --> L[Resend verification]\n    L --> E\n\n    classDef default fill:#faf5ed,stroke:#b5a790,color:#1a1a1a,stroke-width:1.5px\n    classDef accent fill:#ec4755,stroke:#b3323d,color:#ffffff,stroke-width:2.5px\n    classDef decision fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2.5px\n    classDef success fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2.5px\n    classDef error fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2.5px\n    classDef info fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px\n    class A accent\n    class B,C info\n    class F,G info\n    class H decision\n    class I success\n    class J error\n    class K success\n    class L info\n    linkStyle default stroke:#8a8783,stroke-width:1.75px\n```\n\nThe key steps are account creation, email delivery, and token validation. The flow handles the unhappy path where the token expires or is invalid by allowing the user to request a new verification email.";

const PRIVACY_USER_MESSAGE =
  'How does HushBox keep my conversations private? Can you or anyone else read my messages?';

const PRIVACY_AI_MESSAGE =
  "## Encrypted at Rest, Private by Design\n\nHushBox protects your conversations with multiple layers of security.\n\n### Your Password Never Leaves Your Device\n- We use the **OPAQUE protocol** — your password is verified cryptographically without ever being transmitted to our servers\n- Not during login, not during registration, not ever\n\n### Encrypted Storage\n- Every conversation is encrypted before being stored using **XChaCha20-Poly1305**, a modern AEAD cipher\n- Encryption keys are derived from your account credentials using **Argon2id**, the gold standard for key derivation\n- Our database contains only encrypted blobs — **a database breach alone would not expose your conversations**\n\n### Pseudonymous AI Access\n- When your messages reach AI providers, they see **HushBox's credentials — not yours**\n- Providers cannot link your conversations to your identity\n- We request that providers do not store or train on your data\n\n### Your Recovery Phrase Is Your Safety Net\n- If you lose both your password and recovery phrase, your stored data is permanently inaccessible\n- We cannot recover it for you — by design, not by oversight";

export const SCREENSHOT_CONVERSATIONS: ScreenshotConversationSpec[] = [
  {
    seedKey: 'screenshot-conv-chat',
    ownerPersona: 'alice',
    messages: [
      { sender: 'alice', text: CHAT_USER_MESSAGE },
      { sender: 'ai', text: CHAT_AI_MESSAGE },
    ],
  },
  {
    seedKey: 'screenshot-conv-code',
    ownerPersona: 'alice',
    messages: [
      { sender: 'alice', text: CODE_USER_MESSAGE },
      { sender: 'ai', text: CODE_AI_MESSAGE },
    ],
  },
  {
    seedKey: 'screenshot-conv-mermaid',
    ownerPersona: 'alice',
    messages: [
      { sender: 'alice', text: MERMAID_USER_MESSAGE },
      { sender: 'ai', text: MERMAID_AI_MESSAGE },
    ],
  },
  {
    seedKey: 'screenshot-conv-privacy',
    ownerPersona: 'alice',
    messages: [
      { sender: 'alice', text: PRIVACY_USER_MESSAGE },
      { sender: 'ai', text: PRIVACY_AI_MESSAGE },
    ],
  },
  {
    seedKey: 'screenshot-conv-group-chat',
    ownerPersona: 'alice',
    members: ['alice', 'bob', 'charlie'],
    messages: [
      {
        sender: 'alice',
        text: 'Hey team, should we go with PostgreSQL or MongoDB for the new project?',
      },
      {
        sender: 'bob',
        text: 'PostgreSQL — we need relational integrity for the billing data',
      },
      {
        sender: 'charlie',
        text: 'Agreed. Plus Drizzle ORM support is excellent for Postgres',
      },
      {
        sender: 'ai',
        text: "Great consensus! PostgreSQL is the right choice here. You get relational integrity for billing, excellent Drizzle ORM support, and JSONB columns for any semi-structured data you might need. It's the best of both worlds.",
      },
    ],
  },
];

/** Nano-USD (1e-9 USD) per whole USD. */
const NANO_USD_PER_USD = 1_000_000_000n;

/** A demo-history payment charged to alice's purchased wallet. */
export interface PaymentSpec {
  amountNanoUsd: bigint;
  cardType: 'Visa' | 'Mastercard';
  cardLastFour: string;
  /** Whole days before "now" the payment settled. */
  daysAgo: number;
}

/**
 * 14 completed payments backdated over the last two weeks. Preserves the legacy
 * amount ladder (base `5 + (i % 5)` dollars, a `+4` top-up on the final one),
 * card-brand alternation, and derived last-four.
 */
export const ALICE_PAYMENT_SPECS: PaymentSpec[] = Array.from({ length: 14 }, (_, index) => {
  const baseAmount = 5 + (index % 5);
  const amountDollars = index === 13 ? baseAmount + 4 : baseAmount;
  return {
    amountNanoUsd: BigInt(amountDollars) * NANO_USD_PER_USD,
    cardType: index % 2 === 0 ? 'Visa' : 'Mastercard',
    cardLastFour: String(4000 + index).slice(-4),
    daysAgo: 14 - index,
  };
});

/** A model in the weighted demo-usage mix, with per-1k-token nano-USD rates. */
export interface UsageModel {
  model: string;
  provider: string;
  weight: number;
  costPer1kInputNanoUsd: bigint;
  costPer1kOutputNanoUsd: bigint;
}

/**
 * The weighted model mix for demo usage. `weight` is preserved from legacy for
 * fidelity; note the legacy picker (`pickUsageModel` below) selects uniformly by
 * hash and does not consult `weight` — replicated faithfully.
 *
 * Rates are the legacy per-1k-token dollar prices expressed exactly in nano-USD
 * (e.g. $0.015 → 15_000_000 nano).
 */
export const USAGE_MODELS: UsageModel[] = [
  {
    model: 'anthropic/claude-opus-4.6',
    provider: 'anthropic',
    weight: 40,
    costPer1kInputNanoUsd: 15_000_000n,
    costPer1kOutputNanoUsd: 75_000_000n,
  },
  {
    model: 'openai/gpt-4o',
    provider: 'openai',
    weight: 25,
    costPer1kInputNanoUsd: 2_500_000n,
    costPer1kOutputNanoUsd: 10_000_000n,
  },
  {
    model: 'google/gemini-2.5-pro',
    provider: 'google',
    weight: 15,
    costPer1kInputNanoUsd: 1_250_000n,
    costPer1kOutputNanoUsd: 10_000_000n,
  },
  {
    model: 'deepseek/deepseek-r1',
    provider: 'deepseek',
    weight: 10,
    costPer1kInputNanoUsd: 550_000n,
    costPer1kOutputNanoUsd: 2_190_000n,
  },
  {
    model: 'anthropic/claude-sonnet-4.5',
    provider: 'anthropic',
    weight: 10,
    costPer1kInputNanoUsd: 3_000_000n,
    costPer1kOutputNanoUsd: 15_000_000n,
  },
];

/**
 * Deterministic uniform-hash model picker (legacy `pickModel`). Spreads models
 * across days so multiple appear on the same day for realistic overlapping
 * chart areas. Uniform over the array — does not weight by `UsageModel.weight`.
 */
function pickUsageModel(index: number, daysAgo: number): UsageModel {
  const hash = ((index * 2_654_435_761) ^ (daysAgo * 40_503)) >>> 0;
  const picked = USAGE_MODELS[hash % USAGE_MODELS.length];
  if (!picked) throw new Error('USAGE_MODELS is empty');
  return picked;
}

/**
 * Exact nano-USD cost from token counts and per-1k nano rates, via bigint math
 * (integer-divided by 1000).
 *
 * Deliberate change from legacy: legacy computed cost in floating-point dollars
 * `(tokens/1000) * rate` then stored `toFixed(8)`. Here the cost is nano-USD by
 * construction (the redesign's money unit) and float-free; the value is
 * demo/display history, so exact bit-parity with the old float string is not a
 * requirement.
 */
function computeCostNanoUsd(inputTokens: number, outputTokens: number, model: UsageModel): bigint {
  const inputCost = (BigInt(inputTokens) * model.costPer1kInputNanoUsd) / 1000n;
  const outputCost = (BigInt(outputTokens) * model.costPer1kOutputNanoUsd) / 1000n;
  return inputCost + outputCost;
}

/** A demo-usage record (one llm completion) over the trailing 90 days. */
export interface UsageSpec {
  /** Stable sequence index; the row id is derived from it by the orchestrator. */
  index: number;
  /** Whole days before "now". */
  daysAgo: number;
  /** Hour-of-day (0–23) for the backdated timestamp. */
  hour: number;
  /** Minute-of-hour (0–59) for the backdated timestamp. */
  minute: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costNanoUsd: bigint;
}

const USAGE_RECORD_COUNT = 200;

/**
 * 200 usage records spread over the trailing 90 days with overlapping models,
 * preserving legacy's exact token/clock/model formulas. The orchestrator maps
 * each record to a conversation by `index % conversationIds.length`.
 */
export const ALICE_USAGE_SPECS: UsageSpec[] = Array.from(
  { length: USAGE_RECORD_COUNT },
  (_, index) => {
    const daysAgo = Math.floor(90 - (index / USAGE_RECORD_COUNT) * 90);
    const hour = (index * 7) % 24;
    const minute = (index * 13) % 60;
    const model = pickUsageModel(index, daysAgo);
    const inputTokens = 200 + ((index * 137) % 8000);
    const outputTokens = 100 + ((index * 89) % 4000);
    const cachedTokens = index % 4 === 0 ? 50 + ((index * 43) % 1500) : 0;
    return {
      index,
      daysAgo,
      hour,
      minute,
      model: model.model,
      provider: model.provider,
      inputTokens,
      outputTokens,
      cachedTokens,
      costNanoUsd: computeCostNanoUsd(inputTokens, outputTokens, model),
    };
  }
);
