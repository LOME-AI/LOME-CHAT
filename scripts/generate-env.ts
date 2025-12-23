import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { envConfig } from '../packages/shared/src/env.config.js';

/**
 * Generate all environment files from the single source of truth (env.config.ts).
 *
 * Generates:
 * - .env.development (for local dev and CI tests)
 * - apps/api/.dev.vars (for wrangler dev)
 * - apps/api/wrangler.toml [vars] section (for production deployment)
 */
export function generateEnvFiles(rootDir: string): void {
  generateEnvDevelopment(rootDir);
  generateDevVars(rootDir);
  updateWranglerToml(rootDir);
  console.log('✓ All environment files generated');
}

function generateEnvDevelopment(rootDir: string): void {
  const lines: string[] = [
    '# Auto-generated from packages/shared/src/env.config.ts',
    '# Do not edit directly - run: pnpm generate:env',
    '',
  ];

  // Add vars
  lines.push('# Variables');
  for (const [key, values] of Object.entries(envConfig.vars)) {
    lines.push(`${key}=${values.development}`);
  }

  // Add secrets
  lines.push('', '# Secrets (dev values only)');
  for (const [key, values] of Object.entries(envConfig.secrets)) {
    lines.push(`${key}=${values.development}`);
  }

  // Add frontend vars
  lines.push('', '# Frontend (exposed to browser)');
  for (const [key, values] of Object.entries(envConfig.frontend)) {
    lines.push(`${key}=${values.development}`);
  }

  // Add local-only vars (not deployed to production)
  lines.push('', '# Local only (not deployed)');
  for (const [key, value] of Object.entries(envConfig.localOnly)) {
    lines.push(`${key}=${value}`);
  }

  writeFileSync(resolve(rootDir, '.env.development'), lines.join('\n') + '\n');
  console.log('  Generated .env.development');
}

function generateDevVars(rootDir: string): void {
  const lines: string[] = ['# Auto-generated - do not edit'];

  for (const varName of envConfig.workerVars) {
    let value = '';

    if (varName in envConfig.vars) {
      value = envConfig.vars[varName as keyof typeof envConfig.vars].development;
    } else if (varName in envConfig.secrets) {
      value = envConfig.secrets[varName as keyof typeof envConfig.secrets].development;
    }

    if (value) {
      lines.push(`${varName}=${value}`);
    }
  }

  writeFileSync(resolve(rootDir, 'apps/api/.dev.vars'), lines.join('\n') + '\n');
  console.log('  Generated apps/api/.dev.vars');
}

function updateWranglerToml(rootDir: string): void {
  const tomlPath = resolve(rootDir, 'apps/api/wrangler.toml');
  let content = readFileSync(tomlPath, 'utf-8');

  // Remove existing [vars] section if present
  // Match [vars] and everything until next section or end of file
  content = content.replace(/\n?\[vars\][\s\S]*?(?=\n\[[^\]]+\]|$)/, '');

  // Build new [vars] section with production values
  const varsLines: string[] = ['', '[vars]'];
  for (const [key, values] of Object.entries(envConfig.vars)) {
    varsLines.push(`${key} = "${values.production}"`);
  }

  // Add comment about secrets
  varsLines.push('');
  varsLines.push('# Secrets deployed via CI (GitHub Secrets → wrangler secret put):');
  for (const key of Object.keys(envConfig.secrets)) {
    varsLines.push(`# - ${key}`);
  }

  writeFileSync(tomlPath, content.trimEnd() + varsLines.join('\n') + '\n');
  console.log('  Updated apps/api/wrangler.toml [vars]');
}

// CLI entry point
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  generateEnvFiles(process.cwd());
}
