import { describe, it, expect } from 'vitest';
import {
  resolveLabels,
  resolveAssociatedPrLabels,
  type ResolveOutput,
  type AssociatedPullRequest,
  type PullRequestLabelsResult,
} from './resolve-pr-scripts.js';
import type { OpsManifest, OpsScript } from './generate-labels.js';

const PRE_DEPLOY_SCRIPT: OpsScript = {
  name: 'configure-r2-cors',
  file: 'ops/r2/configure-cors.ts',
  phase: 'pre-deploy',
  description: 'Apply CORS rules.',
  requires_secrets: ['R2_S3_ENDPOINT'],
};

const POST_DEPLOY_SCRIPT: OpsScript = {
  name: 'rotate-keys',
  file: 'ops/keys/rotate.ts',
  phase: 'post-deploy',
  description: 'Rotate epoch keys.',
  requires_secrets: ['ROTATION_KEY'],
};

const MANIFEST: OpsManifest = {
  scripts: [PRE_DEPLOY_SCRIPT, POST_DEPLOY_SCRIPT],
};

describe('resolveLabels', () => {
  it('returns empty pre/post arrays when no run-script labels are applied', () => {
    const result = resolveLabels({
      labels: ['enhancement', 'docs'],
      manifest: MANIFEST,
      env: { R2_S3_ENDPOINT: 'set', ROTATION_KEY: 'set' },
    });

    expect(result).toEqual<ResolveOutput>({ ok: true, pre: [], post: [] });
  });

  it('partitions matched labels into pre and post by manifest phase', () => {
    const result = resolveLabels({
      labels: ['run-script:configure-r2-cors', 'run-script:rotate-keys'],
      manifest: MANIFEST,
      env: { R2_S3_ENDPOINT: 'set', ROTATION_KEY: 'set' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pre).toEqual([{ name: PRE_DEPLOY_SCRIPT.name, file: PRE_DEPLOY_SCRIPT.file }]);
    expect(result.post).toEqual([{ name: POST_DEPLOY_SCRIPT.name, file: POST_DEPLOY_SCRIPT.file }]);
  });

  it('projects only {name, file} into outputs (no description, no requires_secrets)', () => {
    const result = resolveLabels({
      labels: ['run-script:configure-r2-cors'],
      manifest: MANIFEST,
      env: { R2_S3_ENDPOINT: 'set' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.pre[0] ?? {})).toEqual(['name', 'file']);
  });

  it('hard-fails when a run-script label is not in the manifest', () => {
    const result = resolveLabels({
      labels: ['run-script:nonexistent'],
      manifest: MANIFEST,
      env: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('run-script:nonexistent');
    expect(result.error).toContain('ops/manifest.yml');
  });

  it('hard-fails when a script declares a secret that is missing from env', () => {
    const result = resolveLabels({
      labels: ['run-script:configure-r2-cors'],
      manifest: MANIFEST,
      env: {}, // R2_S3_ENDPOINT missing
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('R2_S3_ENDPOINT');
    expect(result.error).toContain('configure-r2-cors');
  });

  it('treats empty-string env values as missing (not just undefined)', () => {
    const result = resolveLabels({
      labels: ['run-script:configure-r2-cors'],
      manifest: MANIFEST,
      env: { R2_S3_ENDPOINT: '' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('R2_S3_ENDPOINT');
  });

  it('ignores non-run-script labels in the input', () => {
    const result = resolveLabels({
      labels: ['bug', 'run-script:configure-r2-cors', 'priority:high'],
      manifest: MANIFEST,
      env: { R2_S3_ENDPOINT: 'set' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pre).toHaveLength(1);
    expect(result.post).toHaveLength(0);
  });

  it('preserves manifest order, not label-application order, in the output', () => {
    const reversedManifest: OpsManifest = {
      scripts: [POST_DEPLOY_SCRIPT, PRE_DEPLOY_SCRIPT],
    };

    const result = resolveLabels({
      labels: ['run-script:configure-r2-cors', 'run-script:rotate-keys'],
      manifest: reversedManifest,
      env: { R2_S3_ENDPOINT: 'set', ROTATION_KEY: 'set' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pre[0]?.name).toBe('configure-r2-cors');
    expect(result.post[0]?.name).toBe('rotate-keys');
  });

  it('handles a manifest with no scripts cleanly', () => {
    const result = resolveLabels({
      labels: [],
      manifest: { scripts: [] },
      env: {},
    });

    expect(result).toEqual<ResolveOutput>({ ok: true, pre: [], post: [] });
  });
});

describe('resolveAssociatedPrLabels', () => {
  it('returns the labels of the single associated PR', () => {
    const prs: readonly AssociatedPullRequest[] = [
      { number: 42, labels: [{ name: 'run-script:configure-r2-cors' }, { name: 'bug' }] },
    ];

    const result = resolveAssociatedPrLabels(prs);

    expect(result).toEqual<PullRequestLabelsResult>({
      ok: true,
      labels: ['run-script:configure-r2-cors', 'bug'],
    });
  });

  it('returns empty labels when no PR is associated with the commit', () => {
    const result = resolveAssociatedPrLabels([]);

    expect(result).toEqual<PullRequestLabelsResult>({ ok: true, labels: [] });
  });

  it('fails loudly instead of silently picking prs[0] when a commit maps to multiple PRs', () => {
    const prs: readonly AssociatedPullRequest[] = [
      { number: 42, labels: [{ name: 'run-script:configure-r2-cors' }] },
      { number: 99, labels: [{ name: 'run-script:rotate-keys' }] },
    ];

    const result = resolveAssociatedPrLabels(prs);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The old code returned prs[0]'s labels (configure-r2-cors) silently;
    // ambiguity must now surface, naming every candidate PR.
    expect(result.error).toContain('#42');
    expect(result.error).toContain('#99');
    expect(result.error).toContain('2');
  });
});

// Uncoverable branch note: findMissingSecret's `script === undefined`
// continue-guard is unreachable through the exported API. resolveLabels
// calls findUnknownLabel first and returns early on any name absent from
// the allowed map, so by the time findMissingSecret runs every requested
// name resolves. The guard exists only to narrow `Map.get`'s
// `OpsScript | undefined` return type; no off-contract input can reach it
// because the map's values are always the (non-undefined) script objects.
