/**
 * Database seed script for local development.
 *
 * Limitation — media bytes are NOT seeded to MinIO.
 *
 * The seed populates `content_items` rows with `contentType: 'text'` only;
 * media-typed content items (image, video, audio) are not generated. As a
 * result, no encrypted media blobs are uploaded to the local MinIO bucket.
 * Any dev flow that fetches a presigned URL for a seeded media row would get
 * a missing-object response — but in practice there are no such rows because
 * we don't seed media content items.
 *
 * To exercise media end-to-end in dev, run a real chat flow that triggers
 * the media pipeline (which both encrypts the bytes and uploads them to
 * MinIO via the same code path used in production).
 */
import { eq, getTableColumns, getTableName, sql, type Column, type SQL } from 'drizzle-orm';
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  conversations,
  messages,
  contentItems,
  projects,
  payments,
  wallets,
  ledgerEntries,
  epochs,
  epochMembers,
  conversationMembers,
  usageRecords,
  llmCompletions,
  conversationSpending,
} from '@hushbox/db';
import {
  userFactory,
  conversationFactory,
  messageFactory,
  contentItemFactory,
  projectFactory,
  paymentFactory,
  walletFactory,
  ledgerEntryFactory,
  epochFactory,
  epochMemberFactory,
  conversationMemberFactory,
  usageRecordFactory,
  llmCompletionFactory,
} from '@hushbox/db/factories';
import {
  DEV_EMAIL_DOMAIN,
  TEST_EMAIL_DOMAIN,
  FREE_ALLOWANCE_DOLLARS,
  DEV_PASSWORD,
  envConfig,
  resolveRaw,
  Mode,
  normalizeUsername,
} from '@hushbox/shared';
import { fetchModels, pickValueTextModel } from '@hushbox/shared/models';
import {
  createOpaqueClient,
  startRegistration,
  finishRegistration,
  createAccount,
  createFirstEpoch,
  encryptTextForEpoch,
  beginMessageEnvelope,
  encryptTextWithContentKey,
  OpaqueClientConfig,
  OpaqueRegistrationRequest,
  createOpaqueServer,
  OPAQUE_SERVER_IDENTIFIER,
  deriveTotpEncryptionKey,
  encryptTotpSecret,
} from '@hushbox/crypto';
import { isMainModule } from './lib/is-main.js';
import {
  CACHE_VERSION,
  computeCryptoFingerprint,
  type CryptoBytes,
} from './lib/seed-crypto-cache.js';
import { ensurePersonaCrypto, type PersonaCryptoRequest } from './lib/seed-crypto-pool.js';

function resolveOpaqueMasterSecret(): string {
  const fromEnv = process.env['OPAQUE_MASTER_SECRET'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return resolveRaw(envConfig.OPAQUE_MASTER_SECRET, Mode.Development) as string;
}

let cachedOpaqueServer: Awaited<ReturnType<typeof createOpaqueServer>> | null = null;
async function getSharedOpaqueServer(): Promise<Awaited<ReturnType<typeof createOpaqueServer>>> {
  if (!cachedOpaqueServer) {
    const masterSecretBytes = new TextEncoder().encode(resolveOpaqueMasterSecret());
    cachedOpaqueServer = await createOpaqueServer(masterSecretBytes, OPAQUE_SERVER_IDENTIFIER);
  }
  return cachedOpaqueServer;
}

async function createOpaqueUserCrypto(
  password: string,
  credentialIdentifier: string
): Promise<CryptoBytes> {
  const opaqueServer = await getSharedOpaqueServer();
  const client = createOpaqueClient();
  const { serialized } = await startRegistration(client, password);

  const request = OpaqueRegistrationRequest.deserialize(OpaqueClientConfig, serialized);
  const serverResult = await opaqueServer.registerInit(request, credentialIdentifier);
  if (serverResult instanceof Error) throw serverResult;

  const { record, exportKey } = await finishRegistration(
    client,
    serverResult.serialize(),
    OPAQUE_SERVER_IDENTIFIER
  );

  const account = await createAccount(new Uint8Array(exportKey));

  return {
    opaqueRegistration: new Uint8Array(record),
    publicKey: account.publicKey,
    passwordWrappedPrivateKey: account.passwordWrappedPrivateKey,
    recoveryWrappedPrivateKey: account.recoveryWrappedPrivateKey,
  };
}

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const DEFAULT_CACHE_DIR = path.join(REPO_ROOT, 'scripts', '.cache', 'seed-crypto');
const DEFAULT_CRYPTO_DIR = path.join(REPO_ROOT, 'packages', 'crypto', 'src');

async function loadPersonaCryptoFromCache(): Promise<Map<string, CryptoBytes>> {
  const requests: PersonaCryptoRequest[] = [
    ...DEV_PERSONAS.map((persona) => ({
      credentialIdentifier: seedUUID(`dev-user-${persona.name}`),
      password: DEV_PASSWORD,
    })),
    ...TEST_PERSONAS.map((persona) => ({
      credentialIdentifier: seedUUID(`test-user-${persona.name}`),
      password: DEV_PASSWORD,
    })),
    {
      credentialIdentifier: seedUUID(`test-user-${MOBILE_TEST_PERSONA.name}`),
      password: DEV_PASSWORD,
    },
  ];
  const cryptoFingerprint = await computeCryptoFingerprint(DEFAULT_CRYPTO_DIR);
  return ensurePersonaCrypto(requests, {
    cacheDir: DEFAULT_CACHE_DIR,
    cacheVersion: CACHE_VERSION,
    cryptoFingerprint,
    masterSecret: resolveOpaqueMasterSecret(),
  });
}

export const DEV_PERSONAS = [
  {
    name: 'alice',
    displayName: 'Sarah Chen',
    emailVerified: true,
    hasSampleData: true,
    balance: '10000.00000000',
    conversationCount: 150,
  },
  {
    name: 'bob',
    displayName: 'Marcus Johnson',
    emailVerified: true,
    hasSampleData: false,
    balance: '0.20000000',
    conversationCount: 3,
  },
  {
    name: 'charlie',
    displayName: 'Priya Patel',
    emailVerified: true,
    hasSampleData: false,
    balance: '0.00000000',
    conversationCount: 3,
  },
] as const;

export const TEST_2FA_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** Playwright project names; persona×project seeds the per-project wallets. */
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
 * 2-char project codes used to suffix usernames. `username` is `varchar(20)`
 * and must stay unique across the persona×project cross-product — full project
 * names (e.g. "chromium" + a 20-char base displayName) overflow.
 */
const PROJECT_CODE: Record<E2EProjectName, string> = {
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
}

export interface SeededTestPersona extends BaseTestPersona {
  /** Pre-computed username (≤20 chars, unique). Use this verbatim when seeding. */
  username: string;
}

export const BASE_TEST_PERSONAS: BaseTestPersona[] = [
  {
    name: 'test-alice',
    displayName: 'Test Alice',
    emailVerified: true,
    hasSampleData: true,
    totpSecret: null,
  },
  {
    name: 'test-bob',
    displayName: 'Test Bob',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
  },
  {
    name: 'test-charlie',
    displayName: 'Test Charlie',
    emailVerified: false,
    hasSampleData: false,
    totpSecret: null,
  },
  {
    name: 'test-dave',
    displayName: 'Test Dave',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
  },
  // Dedicated billing test users (isolated to avoid balance state bleeding between tests)
  // displayNames are abbreviated ("Bill" not "Billing") so normalized username +
  // "_<2-char-project>" fits in varchar(20).
  {
    name: 'test-billing-success',
    displayName: 'Test Bill Success',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
  },
  {
    name: 'test-billing-failure',
    displayName: 'Test Bill Failure',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
  },
  {
    name: 'test-billing-validation',
    displayName: 'Test Bill Valid',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
  },
  {
    name: 'test-billing-success-2',
    displayName: 'Test Bill OK 2',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
  },
  {
    name: 'test-billing-devmode',
    displayName: 'Test Bill Dev',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
  },
  {
    name: 'test-billing-token',
    displayName: 'Test Bill Token',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: null,
  },
  {
    name: 'test-2fa',
    displayName: 'Test 2FA User',
    emailVerified: true,
    hasSampleData: false,
    totpSecret: TEST_2FA_TOTP_SECRET,
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
  // issue #2718), so trimming the username from 11 chars to 3 saves ~80 s
  // per `inputText ${TEST_USERNAME}` call in mobile-tests/flows.
  username: 'tmu',
  emailVerified: true,
  hasSampleData: true,
  totpSecret: null,
};

export function testPersonaName(baseName: string, projectName: E2EProjectName): string {
  return `${baseName}-${projectName}`;
}

function devEmail(name: string): string {
  return `${name}@${DEV_EMAIL_DOMAIN}`;
}

function testEmail(name: string): string {
  return `${name}@${TEST_EMAIL_DOMAIN}`;
}

export const SEED_CONFIG = {
  USER_COUNT: 5,
  PROJECTS_PER_USER: 2,
  CONVERSATIONS_PER_USER: 2,
  MESSAGES_PER_CONVERSATION: 5,
} as const;

export function seedUUID(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index++) {
    const char = name.codePointAt(index) ?? 0;
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  const hex = Math.abs(hash).toString(16).padStart(12, '0').slice(0, 12);
  return `00000000-0000-4000-8000-${hex}`;
}

type User = typeof users.$inferInsert;
type Conversation = typeof conversations.$inferInsert;
type Message = typeof messages.$inferInsert;
type Project = typeof projects.$inferInsert;
type Payment = typeof payments.$inferInsert;
type Wallet = typeof wallets.$inferInsert;
type LedgerEntry = typeof ledgerEntries.$inferInsert;
type Epoch = typeof epochs.$inferInsert;
type EpochMember = typeof epochMembers.$inferInsert;
type ConversationMember = typeof conversationMembers.$inferInsert;
type UsageRecord = typeof usageRecords.$inferInsert;
type LlmCompletion = typeof llmCompletions.$inferInsert;
type ConversationSpendingRow = typeof conversationSpending.$inferInsert;
type ContentItem = typeof contentItems.$inferInsert;

type UserWithId = User & { id: string };
type ConversationWithId = Conversation & { id: string };
type MessageWithId = Message & { id: string };
type ProjectWithId = Project & { id: string };
type PaymentWithId = Payment & { id: string };
type WalletWithId = Wallet & { id: string };
type LedgerEntryWithId = LedgerEntry & { id: string };
type EpochWithId = Epoch & { id: string };
type EpochMemberWithId = EpochMember & { id: string };
type ConversationMemberWithId = ConversationMember & { id: string };
type UsageRecordWithId = UsageRecord & { id: string };
type LlmCompletionWithId = LlmCompletion & { id: string };
type ConversationSpendingWithId = ConversationSpendingRow & { id: string };
type ContentItemWithId = ContentItem & { id: string };

interface SeedData {
  users: UserWithId[];
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
  contentItems: ContentItemWithId[];
  epochs: EpochWithId[];
  epochMembers: EpochMemberWithId[];
  conversationMembers: ConversationMemberWithId[];
}

interface PersonaData {
  users: UserWithId[];
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
  contentItems: ContentItemWithId[];
  payments: PaymentWithId[];
  wallets: WalletWithId[];
  ledgerEntries: LedgerEntryWithId[];
  epochs: EpochWithId[];
  epochMembers: EpochMemberWithId[];
  conversationMembers: ConversationMemberWithId[];
  usageRecords: UsageRecordWithId[];
  llmCompletions: LlmCompletionWithId[];
  conversationSpending: ConversationSpendingWithId[];
}

interface UserEntities {
  user: UserWithId;
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
  contentItems: ContentItemWithId[];
  epochs: EpochWithId[];
  epochMembers: EpochMemberWithId[];
  conversationMembers: ConversationMemberWithId[];
}

function createConversationEpochData(
  convId: string,
  userId: string,
  userPublicKey: Uint8Array
): {
  epoch: EpochWithId;
  epochMember: EpochMemberWithId;
  conversationMember: ConversationMemberWithId;
  epochPublicKey: Uint8Array;
} {
  const epochResult = createFirstEpoch([userPublicKey]);
  const epochId = seedUUID(`${convId}-epoch-1`);

  const epoch = epochFactory.build({
    id: epochId,
    conversationId: convId,
    epochNumber: 1,
    epochPublicKey: epochResult.epochPublicKey,
    confirmationHash: epochResult.confirmationHash,
    chainLink: null,
  });

  const epochMember = epochMemberFactory.build({
    id: seedUUID(`${convId}-epoch-member`),
    epochId,
    memberPublicKey: userPublicKey,
    wrap: epochResult.memberWraps[0]?.wrap ?? new Uint8Array(0),
    visibleFromEpoch: 1,
  });

  const conversationMember = conversationMemberFactory.build({
    id: seedUUID(`${convId}-member`),
    conversationId: convId,
    userId,
    privilege: 'owner',
    visibleFromEpoch: 1,
  });

  return { epoch, epochMember, conversationMember, epochPublicKey: epochResult.epochPublicKey };
}

/**
 * Resolved at script startup via `loadSeedAiModel()` so AI seed messages
 * reference a model that currently exists in the live AI Gateway catalog,
 * not a hardcoded id that drifts when the gateway retires models. Mirrors
 * the runtime behavior added to `apps/api/src/services/dev/dev.ts`.
 */
let seedAiModelId: string | null = null;

export async function loadSeedAiModel(): Promise<void> {
  const publicModelsUrl = process.env['PUBLIC_MODELS_URL'];
  if (publicModelsUrl === undefined || publicModelsUrl.length === 0) {
    throw new Error(
      'PUBLIC_MODELS_URL env var is required so the seed script can pick a live AI model id'
    );
  }
  const rawModels = await fetchModels({ publicModelsUrl });
  seedAiModelId = pickValueTextModel(rawModels);
}

function buildSeedMessageAndContentItem(
  epochPublicKey: Uint8Array,
  text: string,
  msgOverrides: {
    id: string;
    conversationId: string;
    senderType: string;
    epochNumber: number;
    sequenceNumber: number;
    senderId?: string | null;
    parentMessageId?: string | null;
    createdAt?: Date;
  }
): { message: MessageWithId; contentItem: ContentItemWithId } {
  if (seedAiModelId === null) {
    throw new Error('invariant: loadSeedAiModel() must run before buildSeedMessageAndContentItem');
  }
  const { contentKey, wrappedContentKey } = beginMessageEnvelope(epochPublicKey);
  const encryptedBlob = encryptTextWithContentKey(contentKey, text);

  const message = messageFactory.build({
    ...msgOverrides,
    wrappedContentKey,
  });

  const contentItem = contentItemFactory.build({
    id: seedUUID(`${msgOverrides.id}-ci`),
    messageId: message.id,
    contentType: 'text',
    position: 0,
    encryptedBlob,
    modelName: msgOverrides.senderType === 'ai' ? seedAiModelId : null,
    cost: null,
    isSmartModel: false,
  });

  return { message, contentItem };
}

function generateUserEntities(userIndex: number): UserEntities {
  const seedKey = `seed-user-${String(userIndex + 1)}`;
  const userId = seedUUID(seedKey);
  // email and username are unique-constrained, so derive them from the stable
  // seed key (like the id) instead of the factory's faker defaults. Faker values
  // differ every run and can collide; bulkUpsert conflicts only on id and cannot
  // absorb a duplicate email/username, which aborts the whole insert.
  const user = userFactory.build({
    id: userId,
    email: `${seedKey}@${DEV_EMAIL_DOMAIN}`,
    username: `seeduser${String(userIndex + 1)}`,
  });
  const userPublicKey: Uint8Array = user.publicKey;
  const projects: ProjectWithId[] = [];
  const allConversations: ConversationWithId[] = [];
  const allMessages: MessageWithId[] = [];
  const allContentItems: ContentItemWithId[] = [];
  const allEpochs: EpochWithId[] = [];
  const allEpochMembers: EpochMemberWithId[] = [];
  const allConversationMembers: ConversationMemberWithId[] = [];

  for (let projectIndex = 0; projectIndex < SEED_CONFIG.PROJECTS_PER_USER; projectIndex++) {
    projects.push(
      projectFactory.build({
        id: seedUUID(`seed-project-${String(userIndex + 1)}-${String(projectIndex + 1)}`),
        userId,
        encryptedName: encryptTextForEpoch(userPublicKey, `Project ${String(projectIndex + 1)}`),
        encryptedDescription: null,
      })
    );
  }

  for (let convIndex = 0; convIndex < SEED_CONFIG.CONVERSATIONS_PER_USER; convIndex++) {
    const convId = seedUUID(`seed-conv-${String(userIndex + 1)}-${String(convIndex + 1)}`);
    const { epoch, epochMember, conversationMember, epochPublicKey } = createConversationEpochData(
      convId,
      userId,
      userPublicKey
    );

    allConversations.push(
      conversationFactory.build({
        id: convId,
        userId,
        title: encryptTextForEpoch(epochPublicKey, `Seed Conversation ${String(convIndex + 1)}`),
      })
    );
    allEpochs.push(epoch);
    allEpochMembers.push(epochMember);
    allConversationMembers.push(conversationMember);

    let previousMsgId: string | null = null;
    for (let msgIndex = 0; msgIndex < SEED_CONFIG.MESSAGES_PER_CONVERSATION; msgIndex++) {
      const senderType = msgIndex % 2 === 0 ? 'user' : 'ai';
      const msgId = seedUUID(
        `seed-msg-${String(userIndex + 1)}-${String(convIndex + 1)}-${String(msgIndex + 1)}`
      );
      const { message, contentItem } = buildSeedMessageAndContentItem(
        epochPublicKey,
        `Sample message ${String(msgIndex + 1)}`,
        {
          id: msgId,
          conversationId: convId,
          senderType,
          senderId: senderType === 'user' ? userId : null,
          epochNumber: 1,
          sequenceNumber: msgIndex + 1,
          parentMessageId: previousMsgId,
        }
      );
      allMessages.push(message);
      allContentItems.push(contentItem);
      previousMsgId = msgId;
    }
  }

  return {
    user,
    projects,
    conversations: allConversations,
    messages: allMessages,
    contentItems: allContentItems,
    epochs: allEpochs,
    epochMembers: allEpochMembers,
    conversationMembers: allConversationMembers,
  };
}

export function generateSeedData(): SeedData {
  const seedUsers: UserWithId[] = [];
  const seedProjects: ProjectWithId[] = [];
  const seedConversations: ConversationWithId[] = [];
  const seedMessages: MessageWithId[] = [];
  const seedContentItems: ContentItemWithId[] = [];
  const seedEpochs: EpochWithId[] = [];
  const seedEpochMembers: EpochMemberWithId[] = [];
  const seedConversationMembers: ConversationMemberWithId[] = [];

  for (let index = 0; index < SEED_CONFIG.USER_COUNT; index++) {
    const entities = generateUserEntities(index);
    seedUsers.push(entities.user);
    seedProjects.push(...entities.projects);
    seedConversations.push(...entities.conversations);
    seedMessages.push(...entities.messages);
    seedContentItems.push(...entities.contentItems);
    seedEpochs.push(...entities.epochs);
    seedEpochMembers.push(...entities.epochMembers);
    seedConversationMembers.push(...entities.conversationMembers);
  }

  return {
    users: seedUsers,
    projects: seedProjects,
    conversations: seedConversations,
    messages: seedMessages,
    contentItems: seedContentItems,
    epochs: seedEpochs,
    epochMembers: seedEpochMembers,
    conversationMembers: seedConversationMembers,
  };
}

async function createPersonaUser(
  persona: (typeof DEV_PERSONAS)[number],
  now: Date,
  cryptoMap?: Map<string, CryptoBytes>
): Promise<{ user: UserWithId; publicKey: Uint8Array }> {
  const userId = seedUUID(`dev-user-${persona.name}`);
  const email = devEmail(persona.name);
  const crypto = cryptoMap?.get(userId) ?? (await createOpaqueUserCrypto(DEV_PASSWORD, userId));

  const user: UserWithId = {
    id: userId,
    email,
    username: normalizeUsername(persona.displayName),
    emailVerified: persona.emailVerified,
    hasAcknowledgedPhrase: true,
    createdAt: now,
    updatedAt: now,
    opaqueRegistration: crypto.opaqueRegistration,
    publicKey: crypto.publicKey,
    passwordWrappedPrivateKey: crypto.passwordWrappedPrivateKey,
    recoveryWrappedPrivateKey: crypto.recoveryWrappedPrivateKey,
  };

  return { user, publicKey: crypto.publicKey };
}

const SEARCH_MESSAGES = [
  { role: 'user' as const, text: 'What are the latest developments in quantum computing?' },
  {
    role: 'ai' as const,
    text:
      'Based on recent web results, here are the latest developments in quantum computing:\n\n' +
      'According to [nature.com](https://nature.com/articles/quantum-2024), researchers have ' +
      'achieved a major breakthrough in error correction, demonstrating logical qubits with ' +
      'error rates below the threshold needed for practical computation.\n\n' +
      'A recent paper on [arxiv.org](https://arxiv.org/abs/2401.00001) describes a new ' +
      'approach to topological quantum computing that could make systems more stable at ' +
      'higher temperatures.',
  },
  {
    role: 'user' as const,
    text: 'How does this compare to classical computing for optimization problems?',
  },
  {
    role: 'ai' as const,
    text:
      'Quantum computing shows significant advantages for specific optimization problems:\n\n' +
      'According to [science.org](https://science.org/quantum-optimization), quantum annealers ' +
      'have demonstrated up to 100x speedups on certain combinatorial optimization tasks ' +
      'compared to classical solvers.\n\n' +
      'However, as noted by [ieee.org](https://spectrum.ieee.org/quantum-classical), for many ' +
      'real-world problems classical algorithms remain competitive, and the crossover point ' +
      'depends heavily on problem structure and size.',
  },
];

interface ConversationMessageContext {
  personaName: string;
  convIndex: number;
  convId: string;
  userId: string;
  epochPublicKey: Uint8Array;
  now: Date;
}

function createSearchConversationMessages(ctx: ConversationMessageContext): {
  messages: MessageWithId[];
  contentItems: ContentItemWithId[];
} {
  const msgs: MessageWithId[] = [];
  const items: ContentItemWithId[] = [];
  let previousMsgId: string | null = null;
  for (const [msgIndex, msg] of SEARCH_MESSAGES.entries()) {
    const msgTime = new Date(ctx.now.getTime() + ctx.convIndex * 10_000 + msgIndex * 1000);
    const msgId = seedUUID(
      `${ctx.personaName}-msg-${String(ctx.convIndex + 1)}-${String(msgIndex + 1)}`
    );
    const { message, contentItem } = buildSeedMessageAndContentItem(ctx.epochPublicKey, msg.text, {
      id: msgId,
      conversationId: ctx.convId,
      senderType: msg.role,
      senderId: msg.role === 'user' ? ctx.userId : null,
      epochNumber: 1,
      sequenceNumber: msgIndex + 1,
      parentMessageId: previousMsgId,
      createdAt: msgTime,
    });
    msgs.push(message);
    items.push(contentItem);
    previousMsgId = msgId;
  }
  return { messages: msgs, contentItems: items };
}

function createGenericConversationMessages(ctx: ConversationMessageContext): {
  messages: MessageWithId[];
  contentItems: ContentItemWithId[];
} {
  const msgs: MessageWithId[] = [];
  const items: ContentItemWithId[] = [];
  const messageCount = 3 + (ctx.convIndex % 3);
  let previousMsgId: string | null = null;
  for (let msgIndex = 0; msgIndex < messageCount; msgIndex++) {
    const senderType = msgIndex % 2 === 0 ? 'user' : 'ai';
    const msgTime = new Date(ctx.now.getTime() + ctx.convIndex * 10_000 + msgIndex * 1000);
    const msgId = seedUUID(
      `${ctx.personaName}-msg-${String(ctx.convIndex + 1)}-${String(msgIndex + 1)}`
    );
    const { message, contentItem } = buildSeedMessageAndContentItem(
      ctx.epochPublicKey,
      `${ctx.personaName} message ${String(ctx.convIndex + 1)}-${String(msgIndex + 1)}`,
      {
        id: msgId,
        conversationId: ctx.convId,
        senderType,
        senderId: senderType === 'user' ? ctx.userId : null,
        epochNumber: 1,
        sequenceNumber: msgIndex + 1,
        parentMessageId: previousMsgId,
        createdAt: msgTime,
      }
    );
    msgs.push(message);
    items.push(contentItem);
    previousMsgId = msgId;
  }
  return { messages: msgs, contentItems: items };
}

function createPersonaSampleData(
  personaName: string,
  userId: string,
  userPublicKey: Uint8Array,
  options: { now: Date; conversationCount?: number }
): {
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
  contentItems: ContentItemWithId[];
  epochs: EpochWithId[];
  epochMembers: EpochMemberWithId[];
  conversationMembers: ConversationMemberWithId[];
} {
  const { now, conversationCount = 3 } = options;
  const sampleProjects: ProjectWithId[] = [];
  const sampleConversations: ConversationWithId[] = [];
  const sampleMessages: MessageWithId[] = [];
  const sampleContentItems: ContentItemWithId[] = [];
  const sampleEpochs: EpochWithId[] = [];
  const sampleEpochMembers: EpochMemberWithId[] = [];
  const sampleConversationMembers: ConversationMemberWithId[] = [];

  for (let projectIndex = 0; projectIndex < 2; projectIndex++) {
    sampleProjects.push(
      projectFactory.build({
        id: seedUUID(`${personaName}-project-${String(projectIndex + 1)}`),
        userId,
        encryptedName: encryptTextForEpoch(
          userPublicKey,
          `${personaName} Project ${String(projectIndex + 1)}`
        ),
        encryptedDescription: null,
      })
    );
  }

  for (let convIndex = 0; convIndex < conversationCount; convIndex++) {
    const convId = seedUUID(`${personaName}-conv-${String(convIndex + 1)}`);
    const { epoch, epochMember, conversationMember, epochPublicKey } = createConversationEpochData(
      convId,
      userId,
      userPublicKey
    );

    const isSearchConversation = convIndex === 2;
    const convTitle = isSearchConversation
      ? 'Quantum Computing Research'
      : `${personaName} Conversation ${String(convIndex + 1)}`;

    sampleConversations.push(
      conversationFactory.build({
        id: convId,
        userId,
        title: encryptTextForEpoch(epochPublicKey, convTitle),
      })
    );
    sampleEpochs.push(epoch);
    sampleEpochMembers.push(epochMember);
    sampleConversationMembers.push(conversationMember);

    const msgCtx: ConversationMessageContext = {
      personaName,
      convIndex,
      convId,
      userId,
      epochPublicKey,
      now,
    };
    const convResult = isSearchConversation
      ? createSearchConversationMessages(msgCtx)
      : createGenericConversationMessages(msgCtx);
    sampleMessages.push(...convResult.messages);
    sampleContentItems.push(...convResult.contentItems);
  }

  return {
    projects: sampleProjects,
    conversations: sampleConversations,
    messages: sampleMessages,
    contentItems: sampleContentItems,
    epochs: sampleEpochs,
    epochMembers: sampleEpochMembers,
    conversationMembers: sampleConversationMembers,
  };
}

const USAGE_MODELS = [
  {
    model: 'anthropic/claude-opus-4.6',
    provider: 'anthropic',
    weight: 40,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
  },
  {
    model: 'openai/gpt-4o',
    provider: 'openai',
    weight: 25,
    costPer1kInput: 0.0025,
    costPer1kOutput: 0.01,
  },
  {
    model: 'google/gemini-2.5-pro',
    provider: 'google',
    weight: 15,
    costPer1kInput: 0.001_25,
    costPer1kOutput: 0.01,
  },
  {
    model: 'deepseek/deepseek-r1',
    provider: 'deepseek',
    weight: 10,
    costPer1kInput: 0.000_55,
    costPer1kOutput: 0.002_19,
  },
  {
    model: 'anthropic/claude-sonnet-4.5',
    provider: 'anthropic',
    weight: 10,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
  },
];

/**
 * Deterministic pseudo-random model picker that ensures overlapping usage.
 * Uses a simple hash to spread models across days so multiple models
 * appear on the same day, creating realistic overlapping chart areas.
 */
function pickModel(index: number, daysAgo: number): (typeof USAGE_MODELS)[number] {
  const hash = ((index * 2_654_435_761) ^ (daysAgo * 40_503)) >>> 0;
  const picked = USAGE_MODELS[hash % USAGE_MODELS.length];
  if (!picked) throw new Error('USAGE_MODELS is empty');
  return picked;
}

interface UsageDataContext {
  personaName: string;
  userId: string;
  conversationIds: string[];
  walletId: string;
  now: Date;
}

function createPersonaUsageData(context: UsageDataContext): {
  usageRecords: UsageRecordWithId[];
  llmCompletions: LlmCompletionWithId[];
  conversationSpending: ConversationSpendingWithId[];
  ledgerEntries: LedgerEntryWithId[];
} {
  const { personaName, userId, conversationIds, walletId, now } = context;
  const records: UsageRecordWithId[] = [];
  const completions: LlmCompletionWithId[] = [];
  const entries: LedgerEntryWithId[] = [];
  const convSpendingMap = new Map<string, number>();

  let runningBalance = 10_000;
  const recordCount = 200;

  for (let index = 0; index < recordCount; index++) {
    const usageId = seedUUID(`${personaName}-usage-${String(index)}`);
    const completionId = seedUUID(`${personaName}-completion-${String(index)}`);
    const ledgerEntryId = seedUUID(`${personaName}-usage-le-${String(index)}`);

    const daysAgo = Math.floor(90 - (index / recordCount) * 90);
    const hoursOffset = (index * 7) % 24;
    const usageDate = new Date(now);
    usageDate.setDate(usageDate.getDate() - daysAgo);
    usageDate.setHours(hoursOffset, (index * 13) % 60, 0, 0);

    const modelInfo = pickModel(index, daysAgo);
    const convId = conversationIds[index % conversationIds.length];
    if (!convId) throw new Error('conversationIds is empty');

    const inputTokens = 200 + ((index * 137) % 8000);
    const outputTokens = 100 + ((index * 89) % 4000);
    const cachedTokens = index % 4 === 0 ? 50 + ((index * 43) % 1500) : 0;

    const cost =
      (inputTokens / 1000) * modelInfo.costPer1kInput +
      (outputTokens / 1000) * modelInfo.costPer1kOutput;
    const costString = cost.toFixed(8);

    records.push(
      usageRecordFactory.build({
        id: usageId,
        userId,
        type: 'llm_completion',
        status: 'completed',
        cost: costString,
        sourceType: 'conversation',
        sourceId: convId,
        createdAt: usageDate,
        completedAt: usageDate,
      })
    );

    completions.push(
      llmCompletionFactory.build({
        id: completionId,
        usageRecordId: usageId,
        model: modelInfo.model,
        provider: modelInfo.provider,
        inputTokens,
        outputTokens,
        cachedTokens,
      })
    );

    convSpendingMap.set(convId, (convSpendingMap.get(convId) ?? 0) + cost);

    runningBalance -= cost;
    entries.push(
      ledgerEntryFactory.build({
        id: ledgerEntryId,
        walletId,
        amount: `-${costString}`,
        balanceAfter: runningBalance.toFixed(8),
        entryType: 'usage_charge',
        usageRecordId: usageId,
        createdAt: usageDate,
      })
    );
  }

  const spending: ConversationSpendingWithId[] = [];
  for (const [convId, totalSpent] of convSpendingMap) {
    spending.push({
      id: seedUUID(`${personaName}-convspend-${convId}`),
      conversationId: convId,
      totalSpent: totalSpent.toFixed(8),
      updatedAt: now,
    });
  }

  return {
    usageRecords: records,
    llmCompletions: completions,
    conversationSpending: spending,
    ledgerEntries: entries,
  };
}

function createPersonaPayments(
  personaName: string,
  userId: string,
  purchasedWalletId: string,
  now: Date
): { payments: PaymentWithId[]; ledgerEntries: LedgerEntryWithId[] } {
  const personaPayments: PaymentWithId[] = [];
  const entries: LedgerEntryWithId[] = [];
  let runningBalance = 0;

  for (let index = 0; index < 14; index++) {
    const paymentId = seedUUID(`${personaName}-payment-${String(index + 1)}`);
    const baseAmount = 5 + (index % 5);
    const amount = index === 13 ? baseAmount + 4 : baseAmount;
    runningBalance += amount;

    const paymentDate = new Date(now);
    paymentDate.setDate(paymentDate.getDate() - (14 - index));

    personaPayments.push(
      paymentFactory.build({
        id: paymentId,
        userId,
        amount: amount.toFixed(8),
        status: 'completed',
        helcimTransactionId: `hlcm-${personaName}-${String(index + 1)}`,
        cardType: index % 2 === 0 ? 'Visa' : 'Mastercard',
        cardLastFour: String(4000 + index).slice(-4),
        createdAt: paymentDate,
        updatedAt: paymentDate,
        webhookReceivedAt: paymentDate,
      })
    );

    entries.push(
      ledgerEntryFactory.build({
        id: seedUUID(`${personaName}-tx-${String(index + 1)}`),
        walletId: purchasedWalletId,
        amount: amount.toFixed(8),
        balanceAfter: runningBalance.toFixed(8),
        entryType: 'deposit',
        paymentId,
        createdAt: paymentDate,
      })
    );
  }

  return { payments: personaPayments, ledgerEntries: entries };
}

function createCharlieConversation(
  userId: string,
  userPublicKey: Uint8Array,
  now: Date
): {
  conversation: ConversationWithId;
  messages: MessageWithId[];
  contentItems: ContentItemWithId[];
  epoch: EpochWithId;
  epochMember: EpochMemberWithId;
  conversationMember: ConversationMemberWithId;
} {
  const convId = seedUUID('charlie-conv-1');
  const { epoch, epochMember, conversationMember, epochPublicKey } = createConversationEpochData(
    convId,
    userId,
    userPublicKey
  );

  const conversation = conversationFactory.build({
    id: convId,
    userId,
    title: encryptTextForEpoch(epochPublicKey, 'Charlie Conversation'),
  });
  const charlieMessages: MessageWithId[] = [];
  const charlieContentItems: ContentItemWithId[] = [];

  let charliePreviousMsgId: string | null = null;
  for (let index = 0; index < 4; index++) {
    const senderType = index % 2 === 0 ? 'user' : 'ai';
    const msgTime = new Date(now.getTime() + index * 1000);
    const msgId = seedUUID(`charlie-msg-1-${String(index + 1)}`);
    const { message, contentItem } = buildSeedMessageAndContentItem(
      epochPublicKey,
      `Charlie message ${String(index + 1)}`,
      {
        id: msgId,
        conversationId: convId,
        senderType,
        senderId: senderType === 'user' ? userId : null,
        epochNumber: 1,
        sequenceNumber: index + 1,
        parentMessageId: charliePreviousMsgId,
        createdAt: msgTime,
      }
    );
    charlieMessages.push(message);
    charlieContentItems.push(contentItem);
    charliePreviousMsgId = msgId;
  }

  return {
    conversation,
    messages: charlieMessages,
    contentItems: charlieContentItems,
    epoch,
    epochMember,
    conversationMember,
  };
}

function createPersonaWallets(
  personaName: string,
  userId: string,
  balance: string
): {
  wallets: WalletWithId[];
  ledgerEntries: LedgerEntryWithId[];
} {
  const purchasedWalletId = seedUUID(`${personaName}-wallet-purchased`);
  const freeWalletId = seedUUID(`${personaName}-wallet-free`);

  const personaWallets: WalletWithId[] = [
    walletFactory.build({
      id: purchasedWalletId,
      userId,
      type: 'purchased',
      balance,
      priority: 0,
    }),
    walletFactory.build({
      id: freeWalletId,
      userId,
      type: 'free_tier',
      balance: FREE_ALLOWANCE_DOLLARS,
      priority: 1,
    }),
  ];

  const welcomeEntries: LedgerEntryWithId[] = [
    ledgerEntryFactory.build({
      id: seedUUID(`${personaName}-welcome-purchased`),
      walletId: purchasedWalletId,
      amount: balance,
      balanceAfter: balance,
      entryType: 'welcome_credit',
      sourceWalletId: purchasedWalletId,
    }),
    ledgerEntryFactory.build({
      id: seedUUID(`${personaName}-welcome-free`),
      walletId: freeWalletId,
      amount: FREE_ALLOWANCE_DOLLARS,
      balanceAfter: FREE_ALLOWANCE_DOLLARS,
      entryType: 'welcome_credit',
      sourceWalletId: freeWalletId,
    }),
  ];

  return { wallets: personaWallets, ledgerEntries: welcomeEntries };
}

interface ScreenshotConversationsParams {
  aliceUserId: string;
  alicePublicKey: Uint8Array;
  bobUserId: string;
  bobPublicKey: Uint8Array;
  charlieUserId: string;
  charliePublicKey: Uint8Array;
  now: Date;
}

interface ScreenshotConversationsResult {
  conversations: ConversationWithId[];
  messages: MessageWithId[];
  contentItems: ContentItemWithId[];
  epochs: EpochWithId[];
  epochMembers: EpochMemberWithId[];
  conversationMembers: ConversationMemberWithId[];
}

export function createScreenshotConversations(
  params: ScreenshotConversationsParams
): ScreenshotConversationsResult {
  const allConversations: ConversationWithId[] = [];
  const allMessages: MessageWithId[] = [];
  const allContentItems: ContentItemWithId[] = [];
  const allEpochs: EpochWithId[] = [];
  const allEpochMembers: EpochMemberWithId[] = [];
  const allConversationMembers: ConversationMemberWithId[] = [];

  const soloConversations: { name: string; userMessage: string; aiMessage: string }[] = [
    {
      name: 'chat',
      userMessage:
        'Can you explain how async/await works in JavaScript and show me an example with error handling?',
      aiMessage:
        '## Async/Await in JavaScript\n\n`async/await` is syntactic sugar over Promises that makes asynchronous code look synchronous.\n\n### How It Works\n\n1. **`async`** keyword before a function makes it return a Promise\n2. **`await`** pauses execution until the Promise resolves\n\n### Example with Error Handling\n\n```javascript\nasync function fetchUserData(userId) {\n  try {\n    const response = await fetch(`/api/users/${userId}`);\n    if (!response.ok) {\n      throw new Error(`HTTP ${response.status}`);\n    }\n    const data = await response.json();\n    return data;\n  } catch (error) {\n    console.error("Failed to fetch user:", error.message);\n    throw error;\n  }\n}\n```\n\nThe `try/catch` block handles both network errors and HTTP error responses cleanly.',
    },
    {
      name: 'code',
      userMessage: 'Write a React hook that fetches data with loading and error states',
      aiMessage:
        'Here\'s a reusable data fetching hook:\n\n```typescript\nimport { useState, useEffect, useCallback } from "react";\n\ninterface UseFetchResult<T> {\n  data: T | null;\n  isLoading: boolean;\n  error: Error | null;\n  refetch: () => void;\n}\n\nexport function useFetch<T>(url: string): UseFetchResult<T> {\n  const [data, setData] = useState<T | null>(null);\n  const [isLoading, setIsLoading] = useState(true);\n  const [error, setError] = useState<Error | null>(null);\n\n  const fetchData = useCallback(async () => {\n    setIsLoading(true);\n    setError(null);\n    try {\n      const response = await fetch(url);\n      if (!response.ok) {\n        throw new Error(`HTTP error: ${response.status}`);\n      }\n      const result = await response.json();\n      setData(result as T);\n    } catch (err) {\n      setError(err instanceof Error ? err : new Error("Unknown error"));\n    } finally {\n      setIsLoading(false);\n    }\n  }, [url]);\n\n  useEffect(() => {\n    void fetchData();\n  }, [fetchData]);\n\n  return { data, isLoading, error, refetch: fetchData };\n}\n```\n\nUsage:\n```tsx\nconst { data, isLoading, error } = useFetch<User[]>("/api/users");\n```',
    },
    {
      name: 'mermaid',
      userMessage: 'Show me a simple flowchart for how a user signs up and verifies their email',
      aiMessage:
        "Here's the signup and email verification flow:\n\n```mermaid\nflowchart TD\n    A[User visits signup page] --> B[Fills in email & password]\n    B --> C[Clicks Sign Up]\n    C --> D[Server creates account]\n    D --> E[Verification email sent]\n    E --> F[User opens email]\n    F --> G[Clicks verification link]\n    G --> H{Token valid?}\n    H -->|Yes| I[Account verified]\n    H -->|No| J[Show error message]\n    I --> K[Redirect to dashboard]\n    J --> L[Resend verification]\n    L --> E\n\n    classDef default fill:#faf5ed,stroke:#b5a790,color:#1a1a1a,stroke-width:1.5px\n    classDef accent fill:#ec4755,stroke:#b3323d,color:#ffffff,stroke-width:2.5px\n    classDef decision fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2.5px\n    classDef success fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2.5px\n    classDef error fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2.5px\n    classDef info fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px\n    class A accent\n    class B,C info\n    class F,G info\n    class H decision\n    class I success\n    class J error\n    class K success\n    class L info\n    linkStyle default stroke:#8a8783,stroke-width:1.75px\n```\n\nThe key steps are account creation, email delivery, and token validation. The flow handles the unhappy path where the token expires or is invalid by allowing the user to request a new verification email.",
    },
    {
      name: 'privacy',
      userMessage:
        'How does HushBox keep my conversations private? Can you or anyone else read my messages?',
      aiMessage:
        "## Encrypted at Rest, Private by Design\n\nHushBox protects your conversations with multiple layers of security.\n\n### Your Password Never Leaves Your Device\n- We use the **OPAQUE protocol** — your password is verified cryptographically without ever being transmitted to our servers\n- Not during login, not during registration, not ever\n\n### Encrypted Storage\n- Every conversation is encrypted before being stored using **XChaCha20-Poly1305**, a modern AEAD cipher\n- Encryption keys are derived from your account credentials using **Argon2id**, the gold standard for key derivation\n- Our database contains only encrypted blobs — **a database breach alone would not expose your conversations**\n\n### Pseudonymous AI Access\n- When your messages reach AI providers, they see **HushBox's credentials — not yours**\n- Providers cannot link your conversations to your identity\n- We request that providers do not store or train on your data\n\n### Your Recovery Phrase Is Your Safety Net\n- If you lose both your password and recovery phrase, your stored data is permanently inaccessible\n- We cannot recover it for you — by design, not by oversight",
    },
  ];

  for (const solo of soloConversations) {
    const convId = seedUUID(`screenshot-conv-${solo.name}`);
    const { epoch, epochMember, conversationMember, epochPublicKey } = createConversationEpochData(
      convId,
      params.aliceUserId,
      params.alicePublicKey
    );

    allConversations.push(
      conversationFactory.build({
        id: convId,
        userId: params.aliceUserId,
        title: encryptTextForEpoch(epochPublicKey, `Screenshot: ${solo.name}`),
      })
    );
    allEpochs.push(epoch);
    allEpochMembers.push(epochMember);
    allConversationMembers.push(conversationMember);

    const userMsgId = seedUUID(`screenshot-msg-${solo.name}-1`);
    const userMsgTime = new Date(params.now.getTime() + allMessages.length * 1000);
    const userResult = buildSeedMessageAndContentItem(epochPublicKey, solo.userMessage, {
      id: userMsgId,
      conversationId: convId,
      senderType: 'user',
      senderId: params.aliceUserId,
      epochNumber: 1,
      sequenceNumber: 1,
      parentMessageId: null,
      createdAt: userMsgTime,
    });
    allMessages.push(userResult.message);
    allContentItems.push(userResult.contentItem);

    const aiMsgTime = new Date(params.now.getTime() + allMessages.length * 1000);
    const aiResult = buildSeedMessageAndContentItem(epochPublicKey, solo.aiMessage, {
      id: seedUUID(`screenshot-msg-${solo.name}-2`),
      conversationId: convId,
      senderType: 'ai',
      senderId: null,
      epochNumber: 1,
      sequenceNumber: 2,
      parentMessageId: userMsgId,
      createdAt: aiMsgTime,
    });
    allMessages.push(aiResult.message);
    allContentItems.push(aiResult.contentItem);
  }

  const groupConvId = seedUUID('screenshot-conv-group-chat');
  const groupEpochResult = createFirstEpoch([
    params.alicePublicKey,
    params.bobPublicKey,
    params.charliePublicKey,
  ]);
  const groupEpochId = seedUUID(`${groupConvId}-epoch-1`);

  const groupEpoch = epochFactory.build({
    id: groupEpochId,
    conversationId: groupConvId,
    epochNumber: 1,
    epochPublicKey: groupEpochResult.epochPublicKey,
    confirmationHash: groupEpochResult.confirmationHash,
    chainLink: null,
  });
  allEpochs.push(groupEpoch);

  const groupMembers: { userId: string; publicKey: Uint8Array; privilege: string }[] = [
    { userId: params.aliceUserId, publicKey: params.alicePublicKey, privilege: 'owner' },
    { userId: params.bobUserId, publicKey: params.bobPublicKey, privilege: 'write' },
    { userId: params.charlieUserId, publicKey: params.charliePublicKey, privilege: 'write' },
  ];

  for (const [index, groupMember] of groupMembers.entries()) {
    const member = groupMember;
    allEpochMembers.push(
      epochMemberFactory.build({
        id: seedUUID(`${groupConvId}-epoch-member-${String(index)}`),
        epochId: groupEpochId,
        memberPublicKey: member.publicKey,
        wrap: groupEpochResult.memberWraps[index]?.wrap ?? new Uint8Array(0),
        visibleFromEpoch: 1,
      })
    );
    allConversationMembers.push(
      conversationMemberFactory.build({
        id: seedUUID(`${groupConvId}-member-${String(index)}`),
        conversationId: groupConvId,
        userId: member.userId,
        privilege: member.privilege,
        visibleFromEpoch: 1,
      })
    );
  }

  allConversations.push(
    conversationFactory.build({
      id: groupConvId,
      userId: params.aliceUserId,
      title: encryptTextForEpoch(groupEpochResult.epochPublicKey, 'Screenshot: group-chat'),
    })
  );

  const groupMessages: { senderId: string | null; senderType: string; content: string }[] = [
    {
      senderId: params.aliceUserId,
      senderType: 'user',
      content: 'Hey team, should we go with PostgreSQL or MongoDB for the new project?',
    },
    {
      senderId: params.bobUserId,
      senderType: 'user',
      content: 'PostgreSQL — we need relational integrity for the billing data',
    },
    {
      senderId: params.charlieUserId,
      senderType: 'user',
      content: 'Agreed. Plus Drizzle ORM support is excellent for Postgres',
    },
    {
      senderId: null,
      senderType: 'ai',
      content:
        "Great consensus! PostgreSQL is the right choice here. You get relational integrity for billing, excellent Drizzle ORM support, and JSONB columns for any semi-structured data you might need. It's the best of both worlds.",
    },
  ];

  let groupPreviousMsgId: string | null = null;
  for (const [index, groupMessage] of groupMessages.entries()) {
    const msg = groupMessage;
    const msgTime = new Date(params.now.getTime() + (allMessages.length + index) * 1000);
    const groupMsgId = seedUUID(`screenshot-msg-group-chat-${String(index + 1)}`);
    const { message, contentItem } = buildSeedMessageAndContentItem(
      groupEpochResult.epochPublicKey,
      msg.content,
      {
        id: groupMsgId,
        conversationId: groupConvId,
        senderType: msg.senderType,
        senderId: msg.senderId,
        epochNumber: 1,
        sequenceNumber: index + 1,
        parentMessageId: groupPreviousMsgId,
        createdAt: msgTime,
      }
    );
    allMessages.push(message);
    allContentItems.push(contentItem);
    groupPreviousMsgId = groupMsgId;
  }

  return {
    conversations: allConversations,
    messages: allMessages,
    contentItems: allContentItems,
    epochs: allEpochs,
    epochMembers: allEpochMembers,
    conversationMembers: allConversationMembers,
  };
}

export async function generatePersonaData(
  cryptoMap?: Map<string, CryptoBytes>
): Promise<PersonaData> {
  const personaUsers: UserWithId[] = [];
  const personaProjects: ProjectWithId[] = [];
  const personaConversations: ConversationWithId[] = [];
  const personaMessages: MessageWithId[] = [];
  const personaContentItems: ContentItemWithId[] = [];
  const personaPayments: PaymentWithId[] = [];
  const personaWallets: WalletWithId[] = [];
  const personaLedgerEntries: LedgerEntryWithId[] = [];
  const personaEpochs: EpochWithId[] = [];
  const personaEpochMembers: EpochMemberWithId[] = [];
  const personaConversationMembers: ConversationMemberWithId[] = [];
  const personaUsageRecords: UsageRecordWithId[] = [];
  const personaLlmCompletions: LlmCompletionWithId[] = [];
  const personaConvSpending: ConversationSpendingWithId[] = [];

  const now = new Date();
  const publicKeys = new Map<string, Uint8Array>();

  for (const persona of DEV_PERSONAS) {
    const { user, publicKey } = await createPersonaUser(persona, now, cryptoMap);
    personaUsers.push(user);
    publicKeys.set(persona.name, publicKey);

    const walletData = createPersonaWallets(persona.name, user.id, persona.balance);
    personaWallets.push(...walletData.wallets);
    personaLedgerEntries.push(...walletData.ledgerEntries);

    if (persona.hasSampleData) {
      const sampleData = createPersonaSampleData(persona.name, user.id, publicKey, {
        now,
        conversationCount: persona.conversationCount,
      });
      personaProjects.push(...sampleData.projects);
      personaConversations.push(...sampleData.conversations);
      personaMessages.push(...sampleData.messages);
      personaContentItems.push(...sampleData.contentItems);
      personaEpochs.push(...sampleData.epochs);
      personaEpochMembers.push(...sampleData.epochMembers);
      personaConversationMembers.push(...sampleData.conversationMembers);

      const purchasedWalletId = seedUUID(`${persona.name}-wallet-purchased`);
      const paymentData = createPersonaPayments(persona.name, user.id, purchasedWalletId, now);
      personaPayments.push(...paymentData.payments);
      personaLedgerEntries.push(...paymentData.ledgerEntries);

      const conversationIds = sampleData.conversations.map((c) => c.id);
      const usageData = createPersonaUsageData({
        personaName: persona.name,
        userId: user.id,
        conversationIds,
        walletId: purchasedWalletId,
        now,
      });
      personaUsageRecords.push(...usageData.usageRecords);
      personaLlmCompletions.push(...usageData.llmCompletions);
      personaConvSpending.push(...usageData.conversationSpending);
      personaLedgerEntries.push(...usageData.ledgerEntries);
    }

    if (persona.name === 'charlie') {
      const charlieData = createCharlieConversation(user.id, publicKey, now);
      personaConversations.push(charlieData.conversation);
      personaMessages.push(...charlieData.messages);
      personaContentItems.push(...charlieData.contentItems);
      personaEpochs.push(charlieData.epoch);
      personaEpochMembers.push(charlieData.epochMember);
      personaConversationMembers.push(charlieData.conversationMember);
    }
  }

  // Screenshot conversations for store screenshots (alice + group with bob, charlie)
  const aliceUser = personaUsers.find((u) => u.id === seedUUID('dev-user-alice'));
  const bobUser = personaUsers.find((u) => u.id === seedUUID('dev-user-bob'));
  const charlieUser = personaUsers.find((u) => u.id === seedUUID('dev-user-charlie'));

  if (aliceUser && bobUser && charlieUser) {
    const screenshotData = createScreenshotConversations({
      aliceUserId: aliceUser.id,
      alicePublicKey: publicKeys.get('alice') ?? aliceUser.publicKey,
      bobUserId: bobUser.id,
      bobPublicKey: publicKeys.get('bob') ?? bobUser.publicKey,
      charlieUserId: charlieUser.id,
      charliePublicKey: publicKeys.get('charlie') ?? charlieUser.publicKey,
      now,
    });
    personaConversations.push(...screenshotData.conversations);
    personaMessages.push(...screenshotData.messages);
    personaContentItems.push(...screenshotData.contentItems);
    personaEpochs.push(...screenshotData.epochs);
    personaEpochMembers.push(...screenshotData.epochMembers);
    personaConversationMembers.push(...screenshotData.conversationMembers);
  }

  return {
    users: personaUsers,
    projects: personaProjects,
    conversations: personaConversations,
    messages: personaMessages,
    contentItems: personaContentItems,
    payments: personaPayments,
    wallets: personaWallets,
    ledgerEntries: personaLedgerEntries,
    epochs: personaEpochs,
    epochMembers: personaEpochMembers,
    conversationMembers: personaConversationMembers,
    usageRecords: personaUsageRecords,
    llmCompletions: personaLlmCompletions,
    conversationSpending: personaConvSpending,
  };
}

async function createTestPersonaUser(
  persona: (typeof TEST_PERSONAS)[number],
  now: Date,
  cryptoMap?: Map<string, CryptoBytes>
): Promise<{ user: UserWithId; publicKey: Uint8Array }> {
  const userId = seedUUID(`test-user-${persona.name}`);
  const email = testEmail(persona.name);
  const crypto = cryptoMap?.get(userId) ?? (await createOpaqueUserCrypto(DEV_PASSWORD, userId));

  let totpEnabled = false;
  let totpSecretEncrypted: Uint8Array | null = null;

  if (persona.totpSecret) {
    const masterSecret = resolveRaw(envConfig.OPAQUE_MASTER_SECRET, Mode.Development) as string;
    const masterSecretBytes = new TextEncoder().encode(masterSecret);
    const totpKey = deriveTotpEncryptionKey(masterSecretBytes);
    totpSecretEncrypted = encryptTotpSecret(persona.totpSecret, totpKey);
    totpEnabled = true;
  }

  const user: UserWithId = {
    id: userId,
    email,
    username: persona.username,
    emailVerified: persona.emailVerified,
    hasAcknowledgedPhrase: true,
    createdAt: now,
    updatedAt: now,
    opaqueRegistration: crypto.opaqueRegistration,
    publicKey: crypto.publicKey,
    passwordWrappedPrivateKey: crypto.passwordWrappedPrivateKey,
    recoveryWrappedPrivateKey: crypto.recoveryWrappedPrivateKey,
    totpEnabled,
    totpSecretEncrypted,
  };

  return { user, publicKey: crypto.publicKey };
}

function createTestSampleData(
  personaName: string,
  userId: string,
  userPublicKey: Uint8Array
): {
  projects: ProjectWithId[];
  conversations: ConversationWithId[];
  messages: MessageWithId[];
  contentItems: ContentItemWithId[];
  epochs: EpochWithId[];
  epochMembers: EpochMemberWithId[];
  conversationMembers: ConversationMemberWithId[];
} {
  const testProjects: ProjectWithId[] = [];
  const testConversations: ConversationWithId[] = [];
  const testMessages: MessageWithId[] = [];
  const testContentItems: ContentItemWithId[] = [];
  const testEpochs: EpochWithId[] = [];
  const testEpochMembers: EpochMemberWithId[] = [];
  const testConversationMembers: ConversationMemberWithId[] = [];

  for (let index = 0; index < 2; index++) {
    testProjects.push(
      projectFactory.build({
        id: seedUUID(`${personaName}-project-${String(index + 1)}`),
        userId,
        encryptedName: encryptTextForEpoch(
          userPublicKey,
          `${personaName} Project ${String(index + 1)}`
        ),
        encryptedDescription: null,
      })
    );
  }

  for (let index = 0; index < 3; index++) {
    const convId = seedUUID(`${personaName}-conv-${String(index + 1)}`);
    const { epoch, epochMember, conversationMember, epochPublicKey } = createConversationEpochData(
      convId,
      userId,
      userPublicKey
    );

    testConversations.push(
      conversationFactory.build({
        id: convId,
        userId,
        title: encryptTextForEpoch(
          epochPublicKey,
          `${personaName} Conversation ${String(index + 1)}`
        ),
      })
    );
    testEpochs.push(epoch);
    testEpochMembers.push(epochMember);
    testConversationMembers.push(conversationMember);

    const messageCount = 3 + (index % 3);
    let testPreviousMsgId: string | null = null;
    for (let msgIndex = 0; msgIndex < messageCount; msgIndex++) {
      const senderType = msgIndex % 2 === 0 ? 'user' : 'ai';
      const msgId = seedUUID(`${personaName}-msg-${String(index + 1)}-${String(msgIndex + 1)}`);
      const { message, contentItem } = buildSeedMessageAndContentItem(
        epochPublicKey,
        `${personaName} message ${String(index + 1)}-${String(msgIndex + 1)}`,
        {
          id: msgId,
          conversationId: convId,
          senderType,
          senderId: senderType === 'user' ? userId : null,
          epochNumber: 1,
          sequenceNumber: msgIndex + 1,
          parentMessageId: testPreviousMsgId,
        }
      );
      testMessages.push(message);
      testContentItems.push(contentItem);
      testPreviousMsgId = msgId;
    }
  }

  return {
    projects: testProjects,
    conversations: testConversations,
    messages: testMessages,
    contentItems: testContentItems,
    epochs: testEpochs,
    epochMembers: testEpochMembers,
    conversationMembers: testConversationMembers,
  };
}

function createTestPaymentData(
  personaName: string,
  userId: string,
  purchasedWalletId: string,
  now: Date
): { payment: PaymentWithId; ledgerEntry: LedgerEntryWithId } {
  const paymentId = seedUUID(`${personaName}-payment-1`);
  const amount = 100;

  const payment = paymentFactory.build({
    id: paymentId,
    userId,
    amount: amount.toFixed(8),
    status: 'completed',
    helcimTransactionId: `hlcm-${personaName}-1`,
    cardType: 'Visa',
    cardLastFour: '4242',
    createdAt: now,
    updatedAt: now,
    webhookReceivedAt: now,
  });

  const ledgerEntry = ledgerEntryFactory.build({
    id: seedUUID(`${personaName}-tx-1`),
    walletId: purchasedWalletId,
    amount: amount.toFixed(8),
    balanceAfter: amount.toFixed(8),
    entryType: 'deposit',
    paymentId,
    createdAt: now,
  });

  return { payment, ledgerEntry };
}

export async function generateTestPersonaData(
  cryptoMap?: Map<string, CryptoBytes>
): Promise<PersonaData> {
  const testUsers: UserWithId[] = [];
  const testProjects: ProjectWithId[] = [];
  const testConversations: ConversationWithId[] = [];
  const testMessages: MessageWithId[] = [];
  const testContentItems: ContentItemWithId[] = [];
  const testPayments: PaymentWithId[] = [];
  const testWallets: WalletWithId[] = [];
  const testLedgerEntries: LedgerEntryWithId[] = [];
  const testEpochs: EpochWithId[] = [];
  const testEpochMembers: EpochMemberWithId[] = [];
  const testConversationMembers: ConversationMemberWithId[] = [];
  const testUsageRecords: UsageRecordWithId[] = [];
  const testLlmCompletions: LlmCompletionWithId[] = [];
  const testConvSpending: ConversationSpendingWithId[] = [];

  const now = new Date();

  for (const persona of [...TEST_PERSONAS, MOBILE_TEST_PERSONA]) {
    const { user, publicKey } = await createTestPersonaUser(persona, now, cryptoMap);
    testUsers.push(user);

    const balance = persona.hasSampleData ? '10000.00000000' : '0.00000000';
    const walletData = createPersonaWallets(persona.name, user.id, balance);
    testWallets.push(...walletData.wallets);
    testLedgerEntries.push(...walletData.ledgerEntries);

    if (persona.hasSampleData) {
      const sampleData = createTestSampleData(persona.name, user.id, publicKey);
      testProjects.push(...sampleData.projects);
      testConversations.push(...sampleData.conversations);
      testMessages.push(...sampleData.messages);
      testContentItems.push(...sampleData.contentItems);
      testEpochs.push(...sampleData.epochs);
      testEpochMembers.push(...sampleData.epochMembers);
      testConversationMembers.push(...sampleData.conversationMembers);

      const purchasedWalletId = seedUUID(`${persona.name}-wallet-purchased`);
      const paymentData = createTestPaymentData(persona.name, user.id, purchasedWalletId, now);
      testPayments.push(paymentData.payment);
      testLedgerEntries.push(paymentData.ledgerEntry);

      const conversationIds = sampleData.conversations.map((c) => c.id);
      const usageData = createPersonaUsageData({
        personaName: persona.name,
        userId: user.id,
        conversationIds,
        walletId: purchasedWalletId,
        now,
      });
      testUsageRecords.push(...usageData.usageRecords);
      testLlmCompletions.push(...usageData.llmCompletions);
      testConvSpending.push(...usageData.conversationSpending);
      testLedgerEntries.push(...usageData.ledgerEntries);
    }
  }

  return {
    users: testUsers,
    projects: testProjects,
    conversations: testConversations,
    messages: testMessages,
    contentItems: testContentItems,
    payments: testPayments,
    wallets: testWallets,
    ledgerEntries: testLedgerEntries,
    epochs: testEpochs,
    epochMembers: testEpochMembers,
    conversationMembers: testConversationMembers,
    usageRecords: testUsageRecords,
    llmCompletions: testLlmCompletions,
    conversationSpending: testConvSpending,
  };
}

type DbClient = ReturnType<typeof createDb>;

/**
 * Source of truth for which physical tables `seed()` writes to.
 *
 * Both this seed itself AND `scripts/ensure-stack-cli.ts` consume this list:
 *   - The seed: `bulkUpsert` is typed against `TrackedTable`, so adding a new
 *     `bulkUpsert(db, X, …)` call where X is not in this array is a compile
 *     error.
 *   - ensure-stack-cli: derives SQL identifiers via `getTableName(t)` for the
 *     `__stack_meta` trigger install and the TRUNCATE … CASCADE step.
 *
 * Adding a table here ripples through both sides; forgetting to update it on
 * one side is a type error on the other.
 */
export const TRACKED_TABLE_OBJECTS = [
  users,
  conversations,
  messages,
  contentItems,
  projects,
  payments,
  wallets,
  ledgerEntries,
  epochs,
  epochMembers,
  conversationMembers,
  usageRecords,
  llmCompletions,
  conversationSpending,
] as const;

export type TrackedTable = (typeof TRACKED_TABLE_OBJECTS)[number];

/** Snake-case physical names derived from the Drizzle table objects. */
export const TRACKED_TABLE_NAMES = TRACKED_TABLE_OBJECTS.map((t) => getTableName(t));

export async function upsertEntity(
  db: DbClient,
  table: TrackedTable,
  data: { id: string }
): Promise<'created' | 'updated'> {
  const existing = await db.select().from(table).where(eq(table.id, data.id)).limit(1);

  if (existing.length === 0) {
    await db.insert(table).values(data);
    return 'created';
  }

  // eslint-disable-next-line sonarjs/no-unused-vars -- destructure to exclude id from update
  const { id: _id, ...rest } = data;
  await db.update(table).set(rest).where(eq(table.id, data.id));
  return 'updated';
}

interface UpsertResult {
  created: number;
  updated: number;
}

/**
 * One multi-row INSERT ... ON CONFLICT (id) DO UPDATE per batch. Avoids N
 * sequential round-trips at the cost of losing the created-vs-updated
 * distinction — both are reported as `total`. Batched to stay under PostgreSQL's
 * 65535 parameter limit on tables with many columns.
 */
const BULK_UPSERT_BATCH_SIZE = 500;

async function bulkUpsert(
  db: DbClient,
  table: TrackedTable,
  entities: { id: string }[]
): Promise<{ total: number }> {
  if (entities.length === 0) return { total: 0 };

  const columns: Record<string, Column> = getTableColumns(table);
  const setClause: Record<string, SQL> = {};
  for (const [jsKey, col] of Object.entries(columns)) {
    if (jsKey === 'id') continue;
    setClause[jsKey] = sql.raw(`excluded."${col.name}"`);
  }

  for (let index = 0; index < entities.length; index += BULK_UPSERT_BATCH_SIZE) {
    const batch = entities.slice(index, index + BULK_UPSERT_BATCH_SIZE);
    await db.insert(table).values(batch).onConflictDoUpdate({
      target: table.id,
      set: setClause,
    });
  }

  return { total: entities.length };
}

function logUpsertResult(entityName: string, result: UpsertResult | { total: number }): void {
  if ('total' in result) {
    console.log(`${entityName}: ${String(result.total)} upserted`);
    return;
  }
  console.log(
    `${entityName}: ${String(result.created)} created, ${String(result.updated)} updated`
  );
}

// `new URL('postgres://[::1]:5432/db').hostname` returns the bracketed form
// `[::1]`, so the bracketed literal — not the bare `::1` — is what the allowlist
// check sees for an IPv6-loopback dev DB.
const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * The seed only ever targets a local development database (the Neon proxy on
 * localhost). Hardcoded dev credentials and destructive upserts make running it
 * against any remote host unacceptable, so the host allowlist is the safety
 * boundary: anything not in {@link LOCAL_DATABASE_HOSTS} is treated as remote.
 */
function isLocalDatabaseUrl(databaseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    // An unparseable URL is not provably local — fail closed.
    return false;
  }
  return LOCAL_DATABASE_HOSTS.has(host);
}

export async function seed(): Promise<void> {
  if (!process.env['DATABASE_URL']) {
    const envPath = path.resolve(process.cwd(), '.env.development');
    config({ path: envPath });
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  if (!isLocalDatabaseUrl(databaseUrl)) {
    throw new Error(
      'Refusing to seed: DATABASE_URL does not point at a local database. ' +
        'The seed is local-development only and must never run against a remote (production) database.'
    );
  }

  const db = createDb({
    connectionString: databaseUrl,
    neonDev: LOCAL_NEON_DEV_CONFIG,
  });

  // Resolve the AI seed model id once from the live catalog before any
  // data-generation runs.
  await loadSeedAiModel();

  const cryptoStart = Date.now();
  const cryptoMap = await loadPersonaCryptoFromCache();
  const cryptoElapsed = ((Date.now() - cryptoStart) / 1000).toFixed(1);
  console.log(`Persona crypto: ${String(cryptoMap.size)} resolved in ${cryptoElapsed}s`);

  const data = generateSeedData();
  const personaData = await generatePersonaData(cryptoMap);
  const testPersonaData = await generateTestPersonaData(cryptoMap);

  console.log('Seeding database...');
  console.log('');
  console.log('Dev Personas:');
  console.log(`  Users: ${String(personaData.users.length)}`);
  console.log(`  Wallets: ${String(personaData.wallets.length)}`);
  console.log(`  Projects: ${String(personaData.projects.length)}`);
  console.log(`  Conversations: ${String(personaData.conversations.length)}`);
  console.log(`  ConversationMembers: ${String(personaData.conversationMembers.length)}`);
  console.log(`  Epochs: ${String(personaData.epochs.length)}`);
  console.log(`  EpochMembers: ${String(personaData.epochMembers.length)}`);
  console.log(`  Messages: ${String(personaData.messages.length)}`);
  console.log(`  Content Items: ${String(personaData.contentItems.length)}`);
  console.log(`  Payments: ${String(personaData.payments.length)}`);
  console.log(`  Ledger Entries: ${String(personaData.ledgerEntries.length)}`);
  console.log(`  Usage Records: ${String(personaData.usageRecords.length)}`);
  console.log(`  LLM Completions: ${String(personaData.llmCompletions.length)}`);
  console.log(`  Conversation Spending: ${String(personaData.conversationSpending.length)}`);
  console.log('');
  console.log('Test Personas:');
  console.log(`  Users: ${String(testPersonaData.users.length)}`);
  console.log(`  Wallets: ${String(testPersonaData.wallets.length)}`);
  console.log(`  Projects: ${String(testPersonaData.projects.length)}`);
  console.log(`  Conversations: ${String(testPersonaData.conversations.length)}`);
  console.log(`  ConversationMembers: ${String(testPersonaData.conversationMembers.length)}`);
  console.log(`  Epochs: ${String(testPersonaData.epochs.length)}`);
  console.log(`  EpochMembers: ${String(testPersonaData.epochMembers.length)}`);
  console.log(`  Messages: ${String(testPersonaData.messages.length)}`);
  console.log(`  Content Items: ${String(testPersonaData.contentItems.length)}`);
  console.log(`  Payments: ${String(testPersonaData.payments.length)}`);
  console.log(`  Ledger Entries: ${String(testPersonaData.ledgerEntries.length)}`);
  console.log(`  Usage Records: ${String(testPersonaData.usageRecords.length)}`);
  console.log(`  LLM Completions: ${String(testPersonaData.llmCompletions.length)}`);
  console.log(`  Conversation Spending: ${String(testPersonaData.conversationSpending.length)}`);
  console.log('');
  console.log('Random Seed Data:');
  console.log(`  Users: ${String(data.users.length)}`);
  console.log(`  Projects: ${String(data.projects.length)}`);
  console.log(`  Conversations: ${String(data.conversations.length)}`);
  console.log(`  Epochs: ${String(data.epochs.length)}`);
  console.log(`  Messages: ${String(data.messages.length)}`);
  console.log(`  Content Items: ${String(data.contentItems.length)}`);
  console.log('');

  const personaUserResult = await bulkUpsert(db, users, [
    ...personaData.users,
    ...testPersonaData.users,
  ]);
  logUpsertResult('Persona Users', personaUserResult);

  const randomUserResult = await bulkUpsert(db, users, data.users);
  logUpsertResult('Random Users', randomUserResult);

  // 2. Wallets (depends on users)
  const walletResult = await bulkUpsert(db, wallets, [
    ...personaData.wallets,
    ...testPersonaData.wallets,
  ]);
  logUpsertResult('Wallets', walletResult);

  const projectResult = await bulkUpsert(db, projects, [
    ...personaData.projects,
    ...testPersonaData.projects,
    ...data.projects,
  ]);
  logUpsertResult('Projects', projectResult);

  const conversationResult = await bulkUpsert(db, conversations, [
    ...personaData.conversations,
    ...testPersonaData.conversations,
    ...data.conversations,
  ]);
  logUpsertResult('Conversations', conversationResult);

  // 5. ConversationMembers (depends on conversations + users)
  const conversationMemberResult = await bulkUpsert(db, conversationMembers, [
    ...personaData.conversationMembers,
    ...testPersonaData.conversationMembers,
    ...data.conversationMembers,
  ]);
  logUpsertResult('ConversationMembers', conversationMemberResult);

  // 6. Epochs (depends on conversations)
  const epochResult = await bulkUpsert(db, epochs, [
    ...personaData.epochs,
    ...testPersonaData.epochs,
    ...data.epochs,
  ]);
  logUpsertResult('Epochs', epochResult);

  // 7. EpochMembers (depends on epochs)
  const epochMemberResult = await bulkUpsert(db, epochMembers, [
    ...personaData.epochMembers,
    ...testPersonaData.epochMembers,
    ...data.epochMembers,
  ]);
  logUpsertResult('EpochMembers', epochMemberResult);

  // 8. Messages (depends on conversations)
  const messageResult = await bulkUpsert(db, messages, [
    ...personaData.messages,
    ...testPersonaData.messages,
    ...data.messages,
  ]);
  logUpsertResult('Messages', messageResult);

  // 8b. Content Items (depends on messages)
  const contentItemResult = await bulkUpsert(db, contentItems, [
    ...personaData.contentItems,
    ...testPersonaData.contentItems,
    ...data.contentItems,
  ]);
  logUpsertResult('Content Items', contentItemResult);

  // 9. UsageRecords (depends on users)
  const usageRecordResult = await bulkUpsert(db, usageRecords, [
    ...personaData.usageRecords,
    ...testPersonaData.usageRecords,
  ]);
  logUpsertResult('Usage Records', usageRecordResult);

  // 10. LLM Completions (depends on usage records)
  const llmCompletionResult = await bulkUpsert(db, llmCompletions, [
    ...personaData.llmCompletions,
    ...testPersonaData.llmCompletions,
  ]);
  logUpsertResult('LLM Completions', llmCompletionResult);

  // 11. Conversation Spending (depends on conversations)
  const convSpendingResult = await bulkUpsert(db, conversationSpending, [
    ...personaData.conversationSpending,
    ...testPersonaData.conversationSpending,
  ]);
  logUpsertResult('Conversation Spending', convSpendingResult);

  // 12. Payments (depends on users)
  const paymentResult = await bulkUpsert(db, payments, [
    ...personaData.payments,
    ...testPersonaData.payments,
  ]);
  logUpsertResult('Payments', paymentResult);

  // 13. LedgerEntries (depends on wallets + payments + usage records)
  const ledgerEntryResult = await bulkUpsert(db, ledgerEntries, [
    ...personaData.ledgerEntries,
    ...testPersonaData.ledgerEntries,
  ]);
  logUpsertResult('Ledger Entries', ledgerEntryResult);

  console.log('\nSeed complete!');
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  void (async () => {
    try {
      await seed();
    } catch (error: unknown) {
      console.error('Seed failed:', error);
      process.exit(1);
    }
  })();
}
