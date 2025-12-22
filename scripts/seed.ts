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
} from '@lome-chat/db';
import {
  userFactory,
  conversationFactory,
  messageFactory,
  projectFactory,
} from '@lome-chat/db/factories';

export const SEED_CONFIG = {
  USER_COUNT: 5,
  PROJECTS_PER_USER: 2,
  CONVERSATIONS_PER_USER: 2,
  MESSAGES_PER_CONVERSATION: 5,
} as const;

// Generate deterministic UUIDs for seeding (based on namespace)
// Format: 00000000-0000-4000-8000-{12 hex digits from name}
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

interface SeedData {
  users: User[];
  projects: Project[];
  conversations: Conversation[];
  messages: Message[];
}

export function generateSeedData(): SeedData {
  const seedUsers: User[] = [];
  const seedProjects: Project[] = [];
  const seedConversations: Conversation[] = [];
  const seedMessages: Message[] = [];

  // Generate users - let faker generate realistic names and emails
  for (let i = 0; i < SEED_CONFIG.USER_COUNT; i++) {
    const userId = seedUUID(`seed-user-${String(i + 1)}`);
    seedUsers.push(
      userFactory.build({
        id: userId,
      })
    );

    // Generate projects for this user - let faker generate realistic names
    for (let j = 0; j < SEED_CONFIG.PROJECTS_PER_USER; j++) {
      seedProjects.push(
        projectFactory.build({
          id: seedUUID(`seed-project-${String(i + 1)}-${String(j + 1)}`),
          userId,
        })
      );
    }

    // Generate conversations for this user - let faker generate realistic titles
    for (let j = 0; j < SEED_CONFIG.CONVERSATIONS_PER_USER; j++) {
      const convId = seedUUID(`seed-conv-${String(i + 1)}-${String(j + 1)}`);
      seedConversations.push(
        conversationFactory.build({
          id: convId,
          userId,
        })
      );

      // Generate messages for this conversation - let faker generate realistic content
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

type DbClient = ReturnType<typeof createDb>;
type Table = typeof users | typeof conversations | typeof messages | typeof projects;

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
  // Check if DATABASE_URL is already set (e.g., in tests or CI)
  // If not, load from .env.development
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

  console.log('Seeding database...');
  console.log(`  Users: ${String(data.users.length)}`);
  console.log(`  Projects: ${String(data.projects.length)}`);
  console.log(`  Conversations: ${String(data.conversations.length)}`);
  console.log(`  Messages: ${String(data.messages.length)}`);
  console.log('');

  // Seed users
  let created = 0;
  let exists = 0;
  for (const user of data.users) {
    const result = await upsertEntity(db, users, user);
    if (result === 'created') created++;
    else exists++;
  }
  console.log(`Users: ${String(created)} created, ${String(exists)} already existed`);

  // Seed projects
  created = 0;
  exists = 0;
  for (const project of data.projects) {
    const result = await upsertEntity(db, projects, project);
    if (result === 'created') created++;
    else exists++;
  }
  console.log(`Projects: ${String(created)} created, ${String(exists)} already existed`);

  // Seed conversations
  created = 0;
  exists = 0;
  for (const conv of data.conversations) {
    const result = await upsertEntity(db, conversations, conv);
    if (result === 'created') created++;
    else exists++;
  }
  console.log(`Conversations: ${String(created)} created, ${String(exists)} already existed`);

  // Seed messages
  created = 0;
  exists = 0;
  for (const msg of data.messages) {
    const result = await upsertEntity(db, messages, msg);
    if (result === 'created') created++;
    else exists++;
  }
  console.log(`Messages: ${String(created)} created, ${String(exists)} already existed`);

  console.log('\nSeed complete!');
}

// Only run if this is the entry point
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  seed().catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exit(1);
  });
}
