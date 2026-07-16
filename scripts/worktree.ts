import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const BASE_PORTS = {
  vite: 5173,
  preview: 4173,
  api: 8788,
  postgres: 5432,
  neon: 4444,
  redis: 6379,
  redisHttp: 8079,
  astro: 4321,
  emulatorAdb: 5555,
  emulatorVnc: 6080,
  readmePreview: 6419,
  minioApi: 9000,
  minioConsole: 9001,
  studio: 4983,
  // Admin SPA dev server. Base chosen so the slot+offset window (7000..7199)
  // stays disjoint from every other base's 200-wide window (nearest neighbors:
  // readmePreview 6419..6618 below, idleDaemon 7700..7899 above).
  admin: 7000,
  // Idle-killer daemon (scripts/lib/idle-killer.ts) binds 127.0.0.1:idleDaemon
  // as its singleton sentinel. Base chosen in an open range so the slot+offset
  // window (7700..7899) doesn't overlap any other port range listed here.
  idleDaemon: 7700,
} as const;

export type PortKey = keyof typeof BASE_PORTS;

export interface WorktreeConfig {
  isWorktree: boolean;
  name: string;
  slot: number;
  projectName: string;
  ports: Record<PortKey, number>;
}

/** djb2 hash — deterministic, fast, good distribution for short strings */
export function djb2Hash(input: string): number {
  let hash = 5381;
  for (const char of input) {
    hash = Math.trunc((hash << 5) + hash + (char.codePointAt(0) ?? 0));
  }
  return Math.abs(hash);
}

export function getWorktreeConfig(rootDir?: string): WorktreeConfig {
  const dir = rootDir ?? process.cwd();
  const gitPath = path.join(dir, '.git');

  const stat = statSync(gitPath);

  if (stat.isDirectory()) {
    return {
      isWorktree: false,
      name: 'main',
      slot: 0,
      projectName: 'hushbox',
      ports: { ...BASE_PORTS },
    };
  }

  // .git is a file — this is a worktree
  const content = readFileSync(gitPath, 'utf8').trim();
  const match = /^gitdir:\s+(.+)$/.exec(content);
  if (!match?.[1]) {
    throw new Error(`Invalid .git file: expected "gitdir: <path>", got "${content}"`);
  }

  const gitdir = match[1];
  const name = path.basename(gitdir);
  const slot = (djb2Hash(name) % 199) + 1;

  const ports = {} as Record<PortKey, number>;
  for (const [key, base] of Object.entries(BASE_PORTS)) {
    ports[key as PortKey] = base + slot;
  }

  return {
    isWorktree: true,
    name,
    slot,
    projectName: `hushbox-${String(slot)}`,
    ports,
  };
}
