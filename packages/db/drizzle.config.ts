import { defineConfig } from 'drizzle-kit';
import { createEnvUtilities } from '@hushbox/shared';

// package.json scripts launch drizzle-kit as `tsx ./node_modules/drizzle-kit/bin.cjs`
// instead of the drizzle-kit binary: the schema imports @hushbox/shared
// TypeScript source over ESM, which drizzle-kit's own loader cannot resolve;
// tsx supplies the loader.

/**
 * Selects the migration connection string by MODE, never by which var happens
 * to be set. Production migrations run against DATABASE_URL; every other mode
 * uses MIGRATION_DATABASE_URL (the direct TCP URL drizzle-kit needs — the
 * pooled DATABASE_URL is not migratable). A missing value for the chosen mode
 * is a tooling misconfiguration, so fail fast rather than crossing modes.
 */
export function resolveMigrationConnectionString(env: NodeJS.ProcessEnv): string {
  const { isProduction } = createEnvUtilities(env);
  const url = isProduction ? env['DATABASE_URL'] : env['MIGRATION_DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      isProduction
        ? 'DATABASE_URL is required to run migrations in production'
        : 'MIGRATION_DATABASE_URL is required to run migrations outside production'
    );
  }
  return url;
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: resolveMigrationConnectionString(process.env),
  },
});
