import { execa } from 'execa';
import { isMainModule } from './lib/is-main.js';

export interface DockerComposeProject {
  projectName: string;
  workingDir: string;
}

export interface CleanupResult {
  orphaned: DockerComposeProject[];
  removed: string[];
  failed: string[];
}

export function parseArgs(args: string[]): { dryRun: boolean } {
  return { dryRun: args.includes('--dry-run') };
}

export function parseWorktreePaths(output: string): string[] {
  if (!output.trim()) return [];
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

export function parseDockerProjects(output: string): DockerComposeProject[] {
  if (!output.trim()) return [];
  const seen = new Set<string>();
  const projects: DockerComposeProject[] = [];

  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    const [projectName, workingDir] = parts as [string, string];
    if (!projectName.startsWith('hushbox-')) continue;
    if (seen.has(projectName)) continue;
    seen.add(projectName);
    projects.push({ projectName, workingDir });
  }

  return projects;
}

/**
 * Normalize a path for cross-platform set membership.
 * Docker may store working_dir with backslashes (Windows native) while
 * git worktree list emits forward slashes on every platform. Drive-letter
 * casing also differs across tools on Windows.
 */
export function normalizeProjectPath(input: string): string {
  const slashNormalized = input.replaceAll('\\', '/');
  const driveLetter = slashNormalized.charAt(0);
  if (/^[A-Za-z]:\//.test(slashNormalized)) {
    return driveLetter.toLowerCase() + slashNormalized.slice(1);
  }
  return slashNormalized;
}

export function findOrphanedProjects(
  projects: DockerComposeProject[],
  activeWorktreePaths: string[]
): DockerComposeProject[] {
  const activeSet = new Set(activeWorktreePaths.map((p) => normalizeProjectPath(p)));
  return projects.filter((p) => !activeSet.has(normalizeProjectPath(p.workingDir)));
}

export async function getActiveWorktreePaths(): Promise<string[]> {
  const result = await execa('git', ['worktree', 'list', '--porcelain']);
  return parseWorktreePaths(result.stdout);
}

export async function getRunningDockerProjects(): Promise<DockerComposeProject[]> {
  try {
    const result = await execa('docker', [
      'ps',
      '--filter',
      'label=com.docker.compose.project',
      '--format',
      '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
    ]);
    return parseDockerProjects(result.stdout);
  } catch {
    return [];
  }
}

export async function removeProject(projectName: string): Promise<void> {
  await execa('docker', ['compose', '-p', projectName, 'down'], {
    stdio: 'inherit',
  });
}

export async function cleanupOrphanedProjects(options: {
  dryRun: boolean;
}): Promise<CleanupResult> {
  const [activePaths, projects] = await Promise.all([
    getActiveWorktreePaths(),
    getRunningDockerProjects(),
  ]);

  const orphaned = findOrphanedProjects(projects, activePaths);
  const removed: string[] = [];
  const failed: string[] = [];

  if (orphaned.length === 0) {
    return { orphaned, removed, failed };
  }

  console.log(`Found ${String(orphaned.length)} orphaned Docker compose project(s):`);
  for (const p of orphaned) {
    console.log(`  ${p.projectName} → ${p.workingDir}`);
  }

  if (options.dryRun) {
    console.log('Dry run — no containers removed.');
    return { orphaned, removed, failed };
  }

  for (const p of orphaned) {
    try {
      console.log(`Removing ${p.projectName}...`);
      await removeProject(p.projectName);
      removed.push(p.projectName);
    } catch {
      console.warn(`Failed to remove ${p.projectName}`);
      failed.push(p.projectName);
    }
  }

  console.log(
    `Cleanup complete: ${String(removed.length)} removed, ${String(failed.length)} failed`
  );
  return { orphaned, removed, failed };
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await cleanupOrphanedProjects(options);
}

/* v8 ignore start -- CLI wiring; main() is covered via unit tests */
const isMain = isMainModule(import.meta.url);
if (isMain) {
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      console.error('Docker cleanup failed:', error);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
