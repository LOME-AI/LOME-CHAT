import { describe, it, expect } from 'vitest';
import { resolveMigrationConnectionString } from '../drizzle.config';

describe('resolveMigrationConnectionString', () => {
  it('uses MIGRATION_DATABASE_URL outside production', () => {
    const url = resolveMigrationConnectionString({
      NODE_ENV: 'development',
      MIGRATION_DATABASE_URL: 'postgres://local/mig',
      DATABASE_URL: 'postgres://prod/db',
    });
    expect(url).toBe('postgres://local/mig');
  });

  it('uses DATABASE_URL in production', () => {
    const url = resolveMigrationConnectionString({
      NODE_ENV: 'production',
      MIGRATION_DATABASE_URL: 'postgres://local/mig',
      DATABASE_URL: 'postgres://prod/db',
    });
    expect(url).toBe('postgres://prod/db');
  });

  it('fails fast when MIGRATION_DATABASE_URL is missing outside production', () => {
    expect(() => resolveMigrationConnectionString({ NODE_ENV: 'development' })).toThrow(
      /MIGRATION_DATABASE_URL/
    );
  });

  it('fails fast when DATABASE_URL is missing in production', () => {
    expect(() => resolveMigrationConnectionString({ NODE_ENV: 'production' })).toThrow(
      /DATABASE_URL/
    );
  });
});
