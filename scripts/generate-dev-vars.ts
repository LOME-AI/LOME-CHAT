import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Vars that Workers needs (subset of .env.development)
const WORKER_VARS = ['DATABASE_URL', 'NODE_ENV'];

export function generateDevVars(rootDir: string): void {
  const envPath = resolve(rootDir, '.env.development');
  const devVarsPath = resolve(rootDir, 'apps/api/.dev.vars');

  const envContent = readFileSync(envPath, 'utf-8');
  const lines = envContent.split('\n');

  const workerVars: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;

    const [key] = trimmed.split('=');
    if (key && WORKER_VARS.includes(key)) {
      workerVars.push(trimmed);
    }
  }

  writeFileSync(devVarsPath, workerVars.join('\n') + '\n');
  console.log(`Generated ${devVarsPath}`);
}

// Only run if this is the entry point
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  generateDevVars(process.cwd());
}
