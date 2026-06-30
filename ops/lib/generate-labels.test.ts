import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { loadManifest, manifestToLabels, type OpsManifest } from './generate-labels.js';

describe('manifestToLabels', () => {
  it('emits one label per script with run-script: prefix', () => {
    const manifest: OpsManifest = {
      scripts: [
        {
          name: 'configure-r2-cors',
          file: 'ops/r2/configure-cors.ts',
          phase: 'pre-deploy',
          description: 'Apply CORS rules to the production R2 media bucket.',
          requires_secrets: ['R2_S3_ENDPOINT'],
        },
        {
          name: 'rotate-keys',
          file: 'ops/keys/rotate.ts',
          phase: 'post-deploy',
          description: 'Rotate epoch encryption keys.',
          requires_secrets: [],
        },
      ],
    };

    const labels = manifestToLabels(manifest);

    expect(labels).toHaveLength(2);
    expect(labels[0]?.name).toBe('run-script:configure-r2-cors');
    expect(labels[1]?.name).toBe('run-script:rotate-keys');
  });

  it('uses the description as the label description (first line only)', () => {
    const manifest: OpsManifest = {
      scripts: [
        {
          name: 'multiline',
          file: 'ops/multi.ts',
          phase: 'pre-deploy',
          description: 'First line.\nSecond line should not appear.\nThird line.',
          requires_secrets: [],
        },
      ],
    };

    const [label] = manifestToLabels(manifest);
    expect(label?.description).toBe('First line.');
    expect(label?.description).not.toContain('Second line');
  });

  it('truncates descriptions at GitHub label cap (100 chars)', () => {
    const longLine = 'x'.repeat(150);
    const manifest: OpsManifest = {
      scripts: [
        {
          name: 'long-desc',
          file: 'ops/long.ts',
          phase: 'pre-deploy',
          description: longLine,
          requires_secrets: [],
        },
      ],
    };

    const [label] = manifestToLabels(manifest);
    expect(label?.description.length).toBeLessThanOrEqual(100);
  });

  it('assigns a deterministic color to every label', () => {
    const manifest: OpsManifest = {
      scripts: [
        {
          name: 'a',
          file: 'ops/a.ts',
          phase: 'pre-deploy',
          description: 'A.',
          requires_secrets: [],
        },
        {
          name: 'b',
          file: 'ops/b.ts',
          phase: 'post-deploy',
          description: 'B.',
          requires_secrets: [],
        },
      ],
    };

    const labels = manifestToLabels(manifest);
    expect(labels[0]?.color).toBe(labels[1]?.color);
    expect(labels[0]?.color).toMatch(/^[0-9a-f]{6}$/i);
  });

  it('returns an empty array when the manifest has no scripts', () => {
    expect(manifestToLabels({ scripts: [] })).toEqual([]);
  });
});

describe('loadManifest', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'hushbox-ops-load-manifest-'));
    mkdirSync(path.join(rootDir, 'ops'), { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function writeManifest(contents: string): void {
    writeFileSync(path.join(rootDir, 'ops/manifest.yml'), contents);
  }

  it('parses a well-formed manifest into typed scripts', () => {
    writeManifest(`scripts:
  - name: configure-r2-cors
    file: ops/r2/configure-cors.ts
    phase: pre-deploy
    description: Apply CORS rules.
    requires_secrets:
      - R2_S3_ENDPOINT
      - R2_BUCKET_MEDIA
`);

    const manifest = loadManifest(rootDir);

    expect(manifest.scripts).toHaveLength(1);
    expect(manifest.scripts[0]).toEqual({
      name: 'configure-r2-cors',
      file: 'ops/r2/configure-cors.ts',
      phase: 'pre-deploy',
      description: 'Apply CORS rules.',
      requires_secrets: ['R2_S3_ENDPOINT', 'R2_BUCKET_MEDIA'],
    });
  });

  it('throws when ops/manifest.yml is missing', () => {
    expect(() => loadManifest(rootDir)).toThrow(/ENOENT|no such file/i);
  });

  it('throws on malformed YAML', () => {
    writeManifest(`scripts:
  - this is: : not valid
    [yaml`);
    expect(() => loadManifest(rootDir)).toThrow();
  });

  it('throws when the top-level shape is wrong (missing scripts key)', () => {
    writeManifest(`other_key: value\n`);
    expect(() => loadManifest(rootDir)).toThrow(/malformed/i);
  });

  // Characterization: YAML that parses to a scalar (not a mapping) must fail
  // the manifest guard, not slip through as a truthy non-object.
  it('throws when the manifest parses to a scalar instead of a mapping', () => {
    writeManifest(`just a plain string\n`);
    expect(() => loadManifest(rootDir)).toThrow(/malformed/i);
  });

  // Characterization: an empty file parses to null; the guard must reject it
  // rather than treating null as an object.
  it('throws when the manifest file is empty', () => {
    writeManifest('');
    expect(() => loadManifest(rootDir)).toThrow(/malformed/i);
  });

  // Characterization: a scripts entry that is a scalar (not a mapping) must
  // fail the per-script guard.
  it('throws when a script entry is a scalar instead of a mapping', () => {
    writeManifest(`scripts:\n  - 42\n`);
    expect(() => loadManifest(rootDir)).toThrow(/malformed/i);
  });

  it('throws when scripts is not an array', () => {
    writeManifest(`scripts:\n  not: an-array\n`);
    expect(() => loadManifest(rootDir)).toThrow(/malformed/i);
  });

  it('throws when a script entry is missing required fields', () => {
    writeManifest(`scripts:
  - name: missing-file-and-phase
    description: Incomplete entry.
`);
    expect(() => loadManifest(rootDir)).toThrow(/malformed/i);
  });

  it('throws when a script declares an invalid phase value', () => {
    writeManifest(`scripts:
  - name: bad-phase
    file: ops/x.ts
    phase: someday-deploy
    description: Wrong phase.
    requires_secrets: []
`);
    expect(() => loadManifest(rootDir)).toThrow(/malformed/i);
  });

  it('throws when requires_secrets contains non-string entries', () => {
    writeManifest(`scripts:
  - name: bad-secrets
    file: ops/x.ts
    phase: pre-deploy
    description: Wrong secrets shape.
    requires_secrets:
      - R2_S3_ENDPOINT
      - 123
`);
    expect(() => loadManifest(rootDir)).toThrow(/malformed/i);
  });
});
