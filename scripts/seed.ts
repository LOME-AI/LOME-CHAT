import { eq } from 'drizzle-orm';
import { config } from 'dotenv';
import { resolve } from 'path';

import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  conversations,
  messages,
  projects,
  accounts,
  hashPassword,
} from '@lome-chat/db';
import {
  userFactory,
  conversationFactory,
  messageFactory,
  projectFactory,
} from '@lome-chat/db/factories';
import { DEV_PASSWORD, DEV_EMAIL_DOMAIN, TEST_EMAIL_DOMAIN } from '@lome-chat/shared';

const DEV_PERSONAS = [
  {
    name: 'alice',
    displayName: 'Alice Developer',
    emailVerified: true,
    hasSampleData: true,
  },
  {
    name: 'bob',
    displayName: 'Bob Tester',
    emailVerified: true,
    hasSampleData: false,
  },
  {
    name: 'charlie',
    displayName: 'Charlie Unverified',
    emailVerified: false,
    hasSampleData: false,
  },
] as const;

const TEST_PERSONAS = [
  {
    name: 'test-alice',
    displayName: 'Test Alice',
    emailVerified: true,
    hasSampleData: true,
  },
  {
    name: 'test-bob',
    displayName: 'Test Bob',
    emailVerified: true,
    hasSampleData: false,
  },
  {
    name: 'test-charlie',
    displayName: 'Test Charlie',
    emailVerified: false,
    hasSampleData: false,
  },
] as const;

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
  // Create a simple hash of the name and format as UUID
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const char = name.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  const hex = Math.abs(hash).toString(16).padStart(12, '0').slice(0, 12);
  return `00000000-0000-4000-8000-${hex}`;
}

type User = typeof users.$inferInsert;
type Conversation = typeof conversations.$inferInsert;
type Message = typeof messages.$inferInsert;
type Project = typeof projects.$inferInsert;
type Account = typeof accounts.$inferInsert;

interface SeedData {
  users: User[];
  projects: Project[];
  conversations: Conversation[];
  messages: Message[];
}

interface PersonaData {
  users: User[];
  accounts: Account[];
  projects: Project[];
  conversations: Conversation[];
  messages: Message[];
}

export function generateSeedData(): SeedData {
  const seedUsers: User[] = [];
  const seedProjects: Project[] = [];
  const seedConversations: Conversation[] = [];
  const seedMessages: Message[] = [];

  for (let i = 0; i < SEED_CONFIG.USER_COUNT; i++) {
    const userId = seedUUID(`seed-user-${String(i + 1)}`);
    seedUsers.push(
      userFactory.build({
        id: userId,
      })
    );

    for (let j = 0; j < SEED_CONFIG.PROJECTS_PER_USER; j++) {
      seedProjects.push(
        projectFactory.build({
          id: seedUUID(`seed-project-${String(i + 1)}-${String(j + 1)}`),
          userId,
        })
      );
    }

    for (let j = 0; j < SEED_CONFIG.CONVERSATIONS_PER_USER; j++) {
      const convId = seedUUID(`seed-conv-${String(i + 1)}-${String(j + 1)}`);
      seedConversations.push(
        conversationFactory.build({
          id: convId,
          userId,
        })
      );

      for (let k = 0; k < SEED_CONFIG.MESSAGES_PER_CONVERSATION; k++) {
        const role = k % 2 === 0 ? 'user' : 'assistant';
        seedMessages.push(
          messageFactory.build({
            id: seedUUID(`seed-msg-${String(i + 1)}-${String(j + 1)}-${String(k + 1)}`),
            conversationId: convId,
            role,
            model: role === 'assistant' ? 'gpt-4' : null,
          })
        );
      }
    }
  }

  return {
    users: seedUsers,
    projects: seedProjects,
    conversations: seedConversations,
    messages: seedMessages,
  };
}

export async function generatePersonaData(): Promise<PersonaData> {
  const personaUsers: User[] = [];
  const personaAccounts: Account[] = [];
  const personaProjects: Project[] = [];
  const personaConversations: Conversation[] = [];
  const personaMessages: Message[] = [];

  const hashedPassword = await hashPassword(DEV_PASSWORD);
  const now = new Date();

  for (const persona of DEV_PERSONAS) {
    const userId = seedUUID(`dev-user-${persona.name}`);
    const email = devEmail(persona.name);

    personaUsers.push({
      id: userId,
      email,
      name: persona.displayName,
      emailVerified: persona.emailVerified,
      image: null,
      createdAt: now,
      updatedAt: now,
    });

    personaAccounts.push({
      id: seedUUID(`account-${persona.name}`),
      userId,
      accountId: email,
      providerId: 'credential',
      password: hashedPassword,
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      idToken: null,
      createdAt: now,
      updatedAt: now,
    });

    if (persona.hasSampleData) {
      for (let i = 0; i < 2; i++) {
        personaProjects.push(
          projectFactory.build({
            id: seedUUID(`${persona.name}-project-${String(i + 1)}`),
            userId,
          })
        );
      }

      for (let i = 0; i < 3; i++) {
        const convId = seedUUID(`${persona.name}-conv-${String(i + 1)}`);
        personaConversations.push(
          conversationFactory.build({
            id: convId,
            userId,
          })
        );

        const messageCount = 3 + (i % 3);
        for (let j = 0; j < messageCount; j++) {
          const role = j % 2 === 0 ? 'user' : 'assistant';
          personaMessages.push(
            messageFactory.build({
              id: seedUUID(`${persona.name}-msg-${String(i + 1)}-${String(j + 1)}`),
              conversationId: convId,
              role,
              model: role === 'assistant' ? 'gpt-4' : null,
            })
          );
        }
      }
    }
  }

  return {
    users: personaUsers,
    accounts: personaAccounts,
    projects: personaProjects,
    conversations: personaConversations,
    messages: personaMessages,
  };
}

export async function generateTestPersonaData(): Promise<PersonaData> {
  const testUsers: User[] = [];
  const testAccounts: Account[] = [];
  const testProjects: Project[] = [];
  const testConversations: Conversation[] = [];
  const testMessages: Message[] = [];

  const hashedPassword = await hashPassword(DEV_PASSWORD);
  const now = new Date();

  for (const persona of TEST_PERSONAS) {
    const userId = seedUUID(`test-user-${persona.name}`);
    const email = testEmail(persona.name);

    testUsers.push({
      id: userId,
      email,
      name: persona.displayName,
      emailVerified: persona.emailVerified,
      image: null,
      createdAt: now,
      updatedAt: now,
    });

    testAccounts.push({
      id: seedUUID(`test-account-${persona.name}`),
      userId,
      accountId: email,
      providerId: 'credential',
      password: hashedPassword,
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      idToken: null,
      createdAt: now,
      updatedAt: now,
    });

    if (persona.hasSampleData) {
      for (let i = 0; i < 2; i++) {
        testProjects.push(
          projectFactory.build({
            id: seedUUID(`${persona.name}-project-${String(i + 1)}`),
            userId,
          })
        );
      }

      for (let i = 0; i < 3; i++) {
        const convId = seedUUID(`${persona.name}-conv-${String(i + 1)}`);
        testConversations.push(
          conversationFactory.build({
            id: convId,
            userId,
          })
        );

        const messageCount = 3 + (i % 3);
        for (let j = 0; j < messageCount; j++) {
          const role = j % 2 === 0 ? 'user' : 'assistant';
          testMessages.push(
            messageFactory.build({
              id: seedUUID(`${persona.name}-msg-${String(i + 1)}-${String(j + 1)}`),
              conversationId: convId,
              role,
              model: role === 'assistant' ? 'gpt-4' : null,
            })
          );
        }
      }
    }
  }

  return {
    users: testUsers,
    accounts: testAccounts,
    projects: testProjects,
    conversations: testConversations,
    messages: testMessages,
  };
}

type DbClient = ReturnType<typeof createDb>;
type Table =
  | typeof users
  | typeof conversations
  | typeof messages
  | typeof projects
  | typeof accounts;

export async function upsertEntity(
  db: DbClient,
  table: Table,
  data: { id: string }
): Promise<'created' | 'exists'> {
  const existing = await db.select().from(table).where(eq(table.id, data.id)).limit(1);

  if (existing.length === 0) {
    await db.insert(table).values(data);
    return 'created';
  }
  return 'exists';
}

export async function seed(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    const envPath = resolve(process.cwd(), '.env.development');
    config({ path: envPath });
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const db = createDb({
    connectionString: databaseUrl,
    neonDev: LOCAL_NEON_DEV_CONFIG,
  });

  const data = generateSeedData();
  const personaData = await generatePersonaData();
  const testPersonaData = await generateTestPersonaData();

  console.log('Seeding database...');
  console.log('');
  console.log('Dev Personas:');
  console.log(`  Users: ${String(personaData.users.length)}`);
  console.log(`  Accounts: ${String(personaData.accounts.length)}`);
  console.log(`  Projects: ${String(personaData.projects.length)}`);
  console.log(`  Conversations: ${String(personaData.conversations.length)}`);
  console.log(`  Messages: ${String(personaData.messages.length)}`);
  console.log('');
  console.log('Test Personas:');
  console.log(`  Users: ${String(testPersonaData.users.length)}`);
  console.log(`  Accounts: ${String(testPersonaData.accounts.length)}`);
  console.log(`  Projects: ${String(testPersonaData.projects.length)}`);
  console.log(`  Conversations: ${String(testPersonaData.conversations.length)}`);
  console.log(`  Messages: ${String(testPersonaData.messages.length)}`);
  console.log('');
  console.log('Random Seed Data:');
  console.log(`  Users: ${String(data.users.length)}`);
  console.log(`  Projects: ${String(data.projects.length)}`);
  console.log(`  Conversations: ${String(data.conversations.length)}`);
  console.log(`  Messages: ${String(data.messages.length)}`);
  console.log('');

  let created = 0;
  let exists = 0;
  for (const user of [...personaData.users, ...testPersonaData.users]) {
    const result = await upsertEntity(db, users, user);
    if (result === 'created') created++;
    else exists++;
  }
  console.log(`Persona Users: ${String(created)} created, ${String(exists)} already existed`);

  created = 0;
  exists = 0;
  for (const account of [...personaData.accounts, ...testPersonaData.accounts]) {
    const result = await upsertEntity(db, accounts, account);
    if (result === 'created') created++;
    else exists++;
  }
  console.log(`Persona Accounts: ${String(created)} created, ${String(exists)} already existed`);

  created = 0;
  exists = 0;
  for (const user of data.users) {
    const result = await upsertEntity(db, users, user);
    if (result === 'created') created++;
    else exists++;
  }
  console.log(`Random Users: ${String(created)} created, ${String(exists)} already existed`);

  created = 0;
  exists = 0;
  for (const project of [...personaData.projects, ...testPersonaData.projects, ...data.projects]) {
    const result = await upsertEntity(db, projects, project);
    if (result === 'created') created++;
    else exists++;
  }
  console.log(`Projects: ${String(created)} created, ${String(exists)} already existed`);

  created = 0;
  exists = 0;
  for (const conv of [
    ...personaData.conversations,
    ...testPersonaData.conversations,
    ...data.conversations,
  ]) {
    const result = await upsertEntity(db, conversations, conv);
    if (result === 'created') created++;
    else exists++;
  }
  console.log(`Conversations: ${String(created)} created, ${String(exists)} already existed`);

  created = 0;
  exists = 0;
  for (const msg of [...personaData.messages, ...testPersonaData.messages, ...data.messages]) {
    const result = await upsertEntity(db, messages, msg);
    if (result === 'created') created++;
    else exists++;
  }
  console.log(`Messages: ${String(created)} created, ${String(exists)} already existed`);

  console.log('\nSeed complete!');
}

const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  seed().catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exit(1);
  });
}
