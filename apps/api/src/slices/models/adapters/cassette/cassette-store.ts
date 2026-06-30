/**
 * File-backed cassette store for the HTTP cassette harness.
 *
 * The on-disk layout and JSON shape
 * (`.ai-cassettes/{AI_RECORDING_VERSION}/{hash}.json`) predate this module;
 * recordings are shared with the prior implementation in both directions
 * until it is deleted at cutover. The optional `request` field below is the
 * one addition — the prior reader strips it (zod default), and this reader
 * tolerates its absence. Duplicated rather than imported because new code
 * never imports `legacy_` paths (lint-enforced).
 *
 * ─── When to bump `AI_RECORDING_VERSION` ──────────────────────────────────
 *   1. The serialized `Cassette` schema changes incompatibly (an optional
 *      field addition is compatible and does NOT need a bump).
 *   2. The hash key changes (e.g., `header-allowlist` in canonical-request).
 *   3. Provider behavior changed and you want to retire all current recordings.
 *   4. Test prompts changed and you want clean recordings.
 * Bumping is a deliberate one-line code change; PR review catches mistakes.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Must match the legacy harness's version constant — same on-disk dir. */
export const AI_RECORDING_VERSION = 'v1' as const;

const cassetteExchangeSchema = z.object({
  status: z.number().int(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  /** Base64-encoded chunks in order. Multi-chunk for SSE; single for non-stream. */
  chunks: z.array(z.string()),
});

/**
 * The canonical request that produced the recording. Captured so tests can
 * assert over what was actually sent (e.g. the ZDR flag on every gateway
 * call) without re-issuing the request. Optional: legacy recordings predate
 * request capture.
 */
const cassetteRequestSchema = z.object({
  method: z.string(),
  pathAndQuery: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
});

const cassetteSchema = z.object({
  version: z.number().int().min(1),
  exchanges: z.array(cassetteExchangeSchema),
  recordedAt: z.string(),
  recordedFromSha: z.string().optional(),
  request: cassetteRequestSchema.optional(),
});

export type Cassette = z.infer<typeof cassetteSchema>;

export interface CassetteStore {
  read(hash: string): Cassette | undefined;
  write(hash: string, cassette: Cassette): void;
  /** Hashes of every readable cassette in the store (for store-wide assertions). */
  list(): string[];
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
      renameSync(temporaryPath, finalPath);
    },

    list(): string[] {
      if (!existsSync(versionDir)) return [];
      return readdirSync(versionDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length));
    },
  };
}
