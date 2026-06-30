import { defineConfig } from 'drizzle-kit';

// package.json scripts launch drizzle-kit as `tsx ./node_modules/drizzle-kit/bin.cjs`
// instead of the drizzle-kit binary: the schema imports @hushbox/shared
// TypeScript source over ESM, which drizzle-kit's own loader cannot resolve;
// tsx supplies the loader.

// Use MIGRATION_DATABASE_URL for local dev (TCP), fall back to DATABASE_URL for production
const connectionString = process.env['MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_URL'];

if (!connectionString) {
  throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL environment variable is required');
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: connectionString,
  },
});
