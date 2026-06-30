/**
 * `pnpm db:seed` — intentionally failing placeholder.
 *
 * The previous seed wrote pre-redesign tables that no longer exist; it was
 * retired when packages/db took over the public schema. Seed data for the
 * redesigned schema is not yet defined, and seeding must fail loudly rather
 * than pretend the database was populated.
 */
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

// `new URL('postgres://[::1]:5432/db').hostname` returns the bracketed form
// `[::1]`, so the bracketed literal — not the bare `::1` — is what the allowlist
// check sees for an IPv6-loopback dev DB.
const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * The seed is local-development only. The redesigned seed is not defined yet,
 * but the remote-DB safety boundary from the legacy seed is carried forward so
 * the guard is already in place when seed data is wired in: an unparseable URL
 * is not provably local, so it fails closed (treated as remote).
 */
function isLocalDatabaseUrl(databaseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return false;
  }
  return LOCAL_DATABASE_HOSTS.has(host);
}

export const SEED_REMOTE_REFUSAL_MESSAGE =
  'Refusing to seed: DATABASE_URL does not point at a local database. ' +
  'The seed is local-development only and must never run against a remote (production) database.';

export const SEED_NOT_DEFINED_MESSAGE =
  'db:seed: seed data for the redesigned schema is not yet defined. ' +
  'Define seed data for the current schema and wire it into this script before seeding.';

export function runSeedPlaceholder(): never {
  const databaseUrl = process.env['DATABASE_URL'];
  // A remote DATABASE_URL is refused outright rather than reaching a future
  // (destructive) seed implementation; only then does the not-defined state surface.
  if (databaseUrl !== undefined && !isLocalDatabaseUrl(databaseUrl)) {
    throw new Error(SEED_REMOTE_REFUSAL_MESSAGE);
  }
  throw new Error(SEED_NOT_DEFINED_MESSAGE);
}

/* v8 ignore start -- CLI wiring; behavior covered via the execa entry-point tests */
if (isMainModule(import.meta.url)) {
  await runMain(() => runSeedPlaceholder());
}
/* v8 ignore stop */
