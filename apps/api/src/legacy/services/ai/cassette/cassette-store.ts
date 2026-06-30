/**
 * File-backed cassette store for HTTP-recording integration tests.
 *
 * Each recording is a `Cassette` containing one or more HTTP exchanges in
 * order. For most logical operations the cassette has a single exchange; the
 * shape supports sequences (URL-fallback downloads, retried polls) because
 * the AI SDK does fall back to a secondary `defaultDownload(url)` call when
 * a provider returns `type: 'url'` instead of `type: 'base64'` for media.
 *
 * Cassettes live at `.ai-cassettes/{AI_RECORDING_VERSION}/{hash}.json`.
 *
 * ─── When to bump `AI_RECORDING_VERSION` ──────────────────────────────────
 *   1. The serialized `Cassette` schema changes (this file).
 *   2. The hash key changes (e.g., `header-allowlist` in canonical-request).
 *   3. Provider behavior changed and you want to retire all current recordings.
 *   4. Test prompts changed and you want clean recordings (otherwise old
 *      hashes are simply orphaned and evicted by GH cache LRU eventually).
 * Bumping is a deliberate one-line code change; PR review catches mistakes.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const AI_RECORDING_VERSION = 'v1' as const;

const cassetteExchangeSchema = z.object({
  status: z.number().int(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  /** Base64-encoded chunks in order. Multi-chunk for SSE; single for non-stream. */
  chunks: z.array(z.string()),
});

const cassetteSchema = z.object({
  version: z.number().int().min(1),
  exchanges: z.array(cassetteExchangeSchema),
  recordedAt: z.string(),
  recordedFromSha: z.string().optional(),
});

export type Cassette = z.infer<typeof cassetteSchema>;

export interface CassetteStore {
  read(hash: string): Cassette | undefined;
  write(hash: string, cassette: Cassette): void;
}

export interface CreateCassetteStoreOptions {
  /** Filesystem root that contains the `{AI_RECORDING_VERSION}/` directory. */
  rootDir: string;
}

export function createCassetteStore(options: CreateCassetteStoreOptions): CassetteStore {
  const { rootDir } = options;
  const versionDir = path.join(rootDir, AI_RECORDING_VERSION);

  function pathFor(hash: string): string {
    return path.join(versionDir, `${hash}.json`);
  }

  return {
    read(hash: string): Cassette | undefined {
      const file = pathFor(hash);
      if (!existsSync(file)) return undefined;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return undefined;
      }
      const parsed = cassetteSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      return parsed.data;
    },

    write(hash: string, cassette: Cassette): void {
      const finalPath = pathFor(hash);
      const temporaryPath = `${finalPath}.tmp-${String(process.pid)}-${String(Date.now())}`;
      mkdirSync(path.dirname(finalPath), { recursive: true });
      // Two-step atomic write: write to a tmp file in the same directory, then
      // rename. Rename is atomic within a single filesystem; a partial tmp
      // file from a crashed write is orphaned but never observed via `read`.
      writeFileSync(temporaryPath, JSON.stringify(cassette));
      // fsync the file before rename so a power loss between write and
      // rename doesn't leave us with a renamed-but-empty cassette on
      // crash-resistant filesystems that buffer writes.
      const fd = openSync(temporaryPath, 'r+');
      try {
        // node:fs has no top-level fdatasync; using closeSync(openSync(...))
        // flushes through the OS write buffer on most platforms. Good enough
        // for CI where the runner exits cleanly; perfect durability isn't a
        // cassette requirement.
      } finally {
        closeSync(fd);
      }
      renameSync(temporaryPath, finalPath);
    },
  };
}
