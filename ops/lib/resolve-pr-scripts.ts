#!/usr/bin/env tsx
/**
 * Resolve `run-script:<name>` labels on the merged PR for the current commit
 * against `ops/manifest.yml`, validate them, and emit pre-deploy / post-deploy
 * partitions to `$GITHUB_OUTPUT`.
 *
 * Designed to replace an inline `actions/github-script` step so the
 * workflow has access to ops's workspace deps (js-yaml in particular —
 * pnpm doesn't hoist to the repo root, so `require('js-yaml')` inside
 * github-script can't resolve).
 *
 * Inputs (env):
 *   GITHUB_TOKEN      — bearer for the GitHub REST API (provided by Actions)
 *   GITHUB_REPOSITORY — "owner/repo" (provided by Actions)
 *   GITHUB_SHA        — merge commit SHA (provided by Actions)
 *   GITHUB_OUTPUT     — path to write workflow outputs (provided by Actions)
 *   <secrets...>      — every value listed in any script's requires_secrets
 *
 * Outputs (`$GITHUB_OUTPUT`):
 *   pre  — JSON array of `{ name, file }` for pre-deploy scripts
 *   post — JSON array of `{ name, file }` for post-deploy scripts
 *
 * Hard-fails (exit 1) on:
 *   - unknown `run-script:<name>` label (name not in ops/manifest.yml)
 *   - script whose `requires_secrets` is missing or empty in env
 */
import { loadManifest, type OpsManifest, type OpsScript } from './generate-labels.js';
import { requireEnv, writeGithubOutput } from './run-cli.js';

export const LABEL_PREFIX = 'run-script:';

export interface ResolveInput {
  labels: readonly string[];
  manifest: OpsManifest;
  env: Readonly<Record<string, string | undefined>>;
}

export interface ScriptRef {
  name: OpsScript['name'];
  file: OpsScript['file'];
}

export type ResolveOutput =
  | { ok: true; pre: readonly ScriptRef[]; post: readonly ScriptRef[] }
  | { ok: false; error: string };

function unknownLabelError(name: string): string {
  return (
    `Label run-script:${name} is not in ops/manifest.yml. ` +
    `Either remove the label, or add the script to the manifest ` +
    `(requires CODEOWNERS approval).`
  );
}

function missingSecretError(scriptName: string, secret: string): string {
  return (
    `Script ${scriptName} requires secret ${secret}, but it's missing ` +
    `(or empty) in the runner env. Did someone forget to run ` +
    `'pnpm generate:env' after editing packages/shared/src/env.config.ts?`
  );
}

function findUnknownLabel(
  requested: readonly string[],
  allowed: ReadonlyMap<string, OpsScript>
): string | null {
  for (const name of requested) {
    if (!allowed.has(name)) return name;
  }
  return null;
}

function findMissingSecret(
  requested: readonly string[],
  allowed: ReadonlyMap<string, OpsScript>,
  env: Readonly<Record<string, string | undefined>>
): { script: string; secret: string } | null {
  for (const name of requested) {
    const script = allowed.get(name);
    if (script === undefined) continue;
    for (const secret of script.requires_secrets) {
      const value = env[secret];
      if (value === undefined || value === '') {
        return { script: name, secret };
      }
    }
  }
  return null;
}

function projectRef(script: OpsScript): ScriptRef {
  return { name: script.name, file: script.file };
}

/**
 * Pure resolution logic — exported for testability. The CLI entry point
 * below wraps this with GitHub-API + filesystem I/O.
 */
export function resolveLabels(input: ResolveInput): ResolveOutput {
  const allowed = new Map(input.manifest.scripts.map((s) => [s.name, s]));

  const requested = input.labels
    .filter((l) => l.startsWith(LABEL_PREFIX))
    .map((l) => l.slice(LABEL_PREFIX.length));

  const unknown = findUnknownLabel(requested, allowed);
  if (unknown !== null) {
    return { ok: false, error: unknownLabelError(unknown) };
  }

  const missing = findMissingSecret(requested, allowed, input.env);
  if (missing !== null) {
    return { ok: false, error: missingSecretError(missing.script, missing.secret) };
  }

  const requestedSet = new Set(requested);
  const pre = input.manifest.scripts
    .filter((s) => s.phase === 'pre-deploy' && requestedSet.has(s.name))
    .map((s) => projectRef(s));
  const post = input.manifest.scripts
    .filter((s) => s.phase === 'post-deploy' && requestedSet.has(s.name))
    .map((s) => projectRef(s));

  return { ok: true, pre, post };
}

interface GitHubLabel {
  readonly name: string;
}

export interface AssociatedPullRequest {
  readonly number: number;
  readonly labels: readonly GitHubLabel[];
}

export type PullRequestLabelsResult =
  | { ok: true; labels: readonly string[] }
  | { ok: false; error: string };

/**
 * Reduce the PRs GitHub associates with a commit to the single label set that
 * drives ops-script selection.
 *
 * A commit can map to more than one pull request (e.g. a squash-merged branch
 * that was also cherry-picked). The labels feed a single downstream deploy
 * decision that mutates infrastructure, and no PR is authoritative over
 * another, so silently taking the first PR's labels could run the wrong ops
 * scripts. Ambiguity is a hard failure the caller must surface — matching this
 * module's unknown-label / missing-secret hard-fail doctrine.
 */
export function resolveAssociatedPrLabels(
  prs: readonly AssociatedPullRequest[]
): PullRequestLabelsResult {
  if (prs.length === 0) {
    return { ok: true, labels: [] };
  }
  if (prs.length > 1) {
    const numbers = prs.map((p) => `#${String(p.number)}`).join(', ');
    return {
      ok: false,
      error:
        `Commit is associated with ${String(prs.length)} pull requests (${numbers}). ` +
        `resolve-pr-scripts cannot decide which one's run-script labels apply. ` +
        `Resolve the ambiguity (close/relabel the extra PRs) before deploying.`,
    };
  }
  return { ok: true, labels: (prs[0]?.labels ?? []).map((l) => l.name) };
}

/* v8 ignore start -- CLI entry: real I/O, hits GitHub API, writes to $GITHUB_OUTPUT */

async function fetchPullRequestLabels(
  token: string,
  repository: string,
  sha: string
): Promise<PullRequestLabelsResult> {
  const url = `https://api.github.com/repos/${repository}/commits/${sha}/pulls`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'hushbox-ops-resolver',
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable body>');
    throw new Error(
      `GitHub API listPullRequestsAssociatedWithCommit returned ${String(response.status)}: ${body}`
    );
  }
  const prs = (await response.json()) as readonly AssociatedPullRequest[];
  return resolveAssociatedPrLabels(prs);
}

async function main(): Promise<void> {
  const token = requireEnv('GITHUB_TOKEN');
  const repository = requireEnv('GITHUB_REPOSITORY');
  const sha = requireEnv('GITHUB_SHA');
  const githubOutput = requireEnv('GITHUB_OUTPUT');

  const prLabels = await fetchPullRequestLabels(token, repository, sha);
  if (!prLabels.ok) {
    console.error(prLabels.error);
    process.exit(1);
  }

  const labels = prLabels.labels;
  if (labels.length === 0) {
    console.log('No PR associated with this commit; no ops scripts to run.');
    writeGithubOutput(githubOutput, 'pre', '[]');
    writeGithubOutput(githubOutput, 'post', '[]');
    return;
  }

  const manifest = loadManifest(process.cwd());
  const result = resolveLabels({
    labels,
    manifest,
    env: process.env,
  });

  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }

  const preNames = result.pre.map((s) => s.name).join(', ') || '(none)';
  const postNames = result.post.map((s) => s.name).join(', ') || '(none)';
  console.log(`Pre-deploy ops scripts: ${preNames}`);
  console.log(`Post-deploy ops scripts: ${postNames}`);

  writeGithubOutput(githubOutput, 'pre', JSON.stringify(result.pre));
  writeGithubOutput(githubOutput, 'post', JSON.stringify(result.post));
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  void main();
}
/* v8 ignore stop */
