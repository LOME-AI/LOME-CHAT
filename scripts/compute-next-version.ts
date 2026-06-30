import { execFileSync } from 'node:child_process';

import { semverToCode, writeGithubOutput } from './extract-version.js';

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

type BumpType = 'major' | 'minor' | 'patch';

interface ComputeVersionInput {
  latestTag: string | null;
  labels: string[];
}

interface ComputeVersionResult {
  version: string;
  versionName: string;
  versionCode: number;
}

const STRICT_SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Parse a strict semver string (with optional v prefix) into components. */
export function parseSemver(tag: string): Semver {
  const match = STRICT_SEMVER.exec(tag);
  if (!match) {
    throw new Error(`Invalid semver: "${tag}" (expected [v]X.Y.Z)`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Determine which semver component to bump based on PR labels. */
export function determineBumpType(labels: string[]): BumpType {
  if (labels.includes('major')) return 'major';
  if (labels.includes('minor')) return 'minor';
  return 'patch';
}

/** Compute the next version from the latest git tag and PR labels. */
export function computeNextVersion(input: ComputeVersionInput): ComputeVersionResult {
  if (input.latestTag === null) {
    const version = '1.0.0';
    return { version, versionName: version, versionCode: semverToCode(version) };
  }

  const current = parseSemver(input.latestTag);
  const bump = determineBumpType(input.labels);

  let next: Semver;
  switch (bump) {
    case 'major': {
      next = { major: current.major + 1, minor: 0, patch: 0 };
      break;
    }
    case 'minor': {
      next = { major: current.major, minor: current.minor + 1, patch: 0 };
      break;
    }
    case 'patch': {
      next = { major: current.major, minor: current.minor, patch: current.patch + 1 };
      break;
    }
  }

  const version = `${String(next.major)}.${String(next.minor)}.${String(next.patch)}`;
  return { version, versionName: version, versionCode: semverToCode(version) };
}

/** Find the latest stable git tag matching vX.Y.Z (no pre-release). */
export function findLatestStableTag(): string | null {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard tool in CI runners
  const output = execFileSync('git', ['tag', '--list', 'v*', '--sort=-version:refname'], {
    encoding: 'utf8',
  }).trim();

  if (!output) return null;

  for (const line of output.split('\n')) {
    if (STRICT_SEMVER.test(line.trim())) {
      return line.trim();
    }
  }

  return null;
}

/** Fetch PR labels for the given commit SHA via GitHub API. */
export async function findMergedPrLabels(
  repository: string,
  sha: string,
  token: string
): Promise<string[]> {
  const url = `https://api.github.com/repos/${repository}/commits/${sha}/pulls`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${String(response.status)} ${response.statusText}`);
  }

  const pulls = (await response.json()) as { labels: { name: string }[] }[];
  if (pulls.length === 0) return [];

  return (pulls[0]?.labels ?? []).map((l) => l.name);
}

export async function main(): Promise<void> {
  const token = process.env['GITHUB_TOKEN'];
  const repository = process.env['GITHUB_REPOSITORY'];
  const sha = process.env['GITHUB_SHA'];

  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  if (!sha) throw new Error('GITHUB_SHA is required');

  const latestTag = findLatestStableTag();
  const labels = await findMergedPrLabels(repository, sha, token);
  const result = computeNextVersion({ latestTag, labels });

  writeGithubOutput([
    `version=${result.version}`,
    `version_name=${result.versionName}`,
    `version_code=${String(result.versionCode)}`,
  ]);
}

/* v8 ignore start -- CLI wiring; main() is covered via unit tests */
const scriptPath = process.argv[1] ?? '';
const isDirectExecution =
  scriptPath.endsWith('compute-next-version.ts') || scriptPath.endsWith('compute-next-version.js');
if (isDirectExecution) {
  void (async (): Promise<void> => {
    try {
      await main();
    } catch (error: unknown) {
      console.error(error);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
