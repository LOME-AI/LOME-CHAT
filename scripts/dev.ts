import { execa } from 'execa';
import { config } from 'dotenv';
import { resolve } from 'path';
import { generateDevVars } from './generate-dev-vars.js';

const DOCKER_SERVICES = ['postgres', 'neon-proxy'];

export function loadEnv(): NodeJS.ProcessEnv {
  const envPath = resolve(process.cwd(), '.env.development');
  config({ path: envPath });
  return process.env;
}

export async function startDocker(): Promise<void> {
  console.log('Starting Docker services...');
  await execa('docker', ['compose', 'up', '-d', '--wait', ...DOCKER_SERVICES], {
    stdio: 'inherit',
    env: process.env,
  });
  console.log('Docker services ready');
}

export async function runMigrations(): Promise<void> {
  console.log('Running database migrations...');
  await execa('pnpm', ['--filter', '@lome-chat/db', 'db:migrate'], {
    stdio: 'inherit',
    env: process.env,
  });
  console.log('Migrations complete');
}

export async function startTurbo(): Promise<void> {
  console.log('Starting dev servers...');
  await execa('turbo', ['dev'], {
    stdio: 'inherit',
    env: process.env,
  });
}

export async function main(): Promise<void> {
  loadEnv();
  generateDevVars(process.cwd());
  await startDocker();
  await runMigrations();
  await startTurbo();
}

// Only run main if this is the entry point
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  main().catch((error: unknown) => {
    console.error('Dev startup failed:', error);
    process.exit(1);
  });
}
