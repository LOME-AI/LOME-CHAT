import { describe, expect, it } from 'vitest';
import {
  ORPHAN_PROJECT_ID,
  findDepth1Ancestor,
  hashLinearId,
  normalizeRoadmap,
  opaqueIdFor,
} from './normalize.js';
import type { LinearIssue, LinearProject } from './linear-types.js';

function issue(overrides: Partial<LinearIssue> & { id: string }): LinearIssue {
  return {
    title: `Issue ${overrides.id}`,
    stateName: 'Todo',
    stateType: 'unstarted',
    labelNames: ['type:feature'],
    parentId: null,
    projectId: 'proj-1',
    relations: [],
    ...overrides,
  };
}

const PROJECT: LinearProject = {
  id: 'proj-1',
  name: 'Project One',
  color: '#fff',
  stateType: 'planned',
};

describe('hashLinearId', () => {
  it('produces a stable 12-char lowercase hex prefix', async () => {
    const hash = await hashLinearId('proj-1');
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(await hashLinearId('proj-1')).toBe(hash);
    expect(await hashLinearId('proj-2')).not.toBe(hash);
  });
});

describe('opaqueIdFor', () => {
  it('returns the hashed id', () => {
    expect(opaqueIdFor(new Map([['raw', 'abc']]), 'raw')).toBe('abc');
  });

  it('throws on an id the pass never hashed (a defect, not a silent drop)', () => {
    expect(() => opaqueIdFor(new Map(), 'ghost')).toThrow(/missing id hash/);
  });
});

describe('findDepth1Ancestor', () => {
  it('returns null for an unknown issue and for a root issue', () => {
    const root = issue({ id: 'root' });
    const byId = new Map([['root', root]]);
    expect(findDepth1Ancestor('ghost', byId)).toBeNull();
    expect(findDepth1Ancestor('root', byId)).toBeNull();
  });

  it('walks a deep chain to the depth-1 ancestor', () => {
    const a = issue({ id: 'a' });
    const b = issue({ id: 'b', parentId: 'a' });
    const c = issue({ id: 'c', parentId: 'b' });
    const d = issue({ id: 'd', parentId: 'c' });
    const byId = new Map([
      ['a', a],
      ['b', b],
      ['c', c],
      ['d', d],
    ]);
    expect(findDepth1Ancestor('d', byId)).toBe('a');
  });

  it('stops on a dangling parent reference', () => {
    const child = issue({ id: 'child', parentId: 'gone' });
    const byId = new Map([['child', child]]);
    expect(findDepth1Ancestor('child', byId)).toBeNull();
  });
});

describe('normalizeRoadmap', () => {
  it('replaces every raw Linear id with its opaque hash', async () => {
    const { nodes } = await normalizeRoadmap({
      projects: [PROJECT],
      issues: [issue({ id: 'iss-1' })],
    });
    expect(nodes.map((n) => n.id)).toEqual([
      await hashLinearId('proj-1'),
      await hashLinearId('iss-1'),
    ]);
    expect(nodes[1]?.parentId).toBe(await hashLinearId('proj-1'));
  });

  it('filters issues without a feature/bug type label', async () => {
    const { nodes } = await normalizeRoadmap({
      projects: [PROJECT],
      issues: [issue({ id: 'iss-1' }), issue({ id: 'iss-infra', labelNames: ['area:infra'] })],
    });
    expect(nodes.filter((n) => n.kind !== 'project')).toHaveLength(1);
  });

  it('drops projects no filtered issue references', async () => {
    const unused: LinearProject = { ...PROJECT, id: 'proj-unused', name: 'Unused' };
    const { nodes } = await normalizeRoadmap({
      projects: [PROJECT, unused],
      issues: [issue({ id: 'iss-1' })],
    });
    expect(nodes.filter((n) => n.kind === 'project')).toHaveLength(1);
  });

  it('routes orphan issues into the synthetic Other project', async () => {
    const { nodes } = await normalizeRoadmap({
      projects: [],
      issues: [issue({ id: 'iss-orphan', projectId: null })],
    });
    const orphanHash = await hashLinearId(ORPHAN_PROJECT_ID);
    const project = nodes.find((n) => n.kind === 'project');
    expect(project?.id).toBe(orphanHash);
    expect(project?.title).toBe('Other');
    expect(nodes.find((n) => n.kind === 'task')?.parentId).toBe(orphanHash);
  });

  it('flattens issues deeper than two levels onto their depth-1 ancestor', async () => {
    const { nodes } = await normalizeRoadmap({
      projects: [PROJECT],
      issues: [
        issue({ id: 'top' }),
        issue({ id: 'mid', parentId: 'top' }),
        issue({ id: 'deep', parentId: 'mid' }),
      ],
    });
    const topHash = await hashLinearId('top');
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const deepNode = byId.get(await hashLinearId('deep'));
    expect(deepNode?.kind).toBe('subtask');
    expect(deepNode?.parentId).toBe(topHash);
  });

  it('falls a subtask back onto its project when the ancestor was filtered out', async () => {
    const { nodes } = await normalizeRoadmap({
      projects: [PROJECT],
      issues: [
        // The parent carries no feature/bug label, so it is filtered — the
        // child keeps subtask kind but re-parents onto the project.
        issue({ id: 'unlabeled-parent', labelNames: [] }),
        issue({ id: 'labeled-child', parentId: 'unlabeled-parent' }),
      ],
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const child = byId.get(await hashLinearId('labeled-child'));
    expect(child?.kind).toBe('subtask');
    expect(child?.parentId).toBe(await hashLinearId('proj-1'));
  });

  it('rolls status up: a parent is never quieter than its children', async () => {
    const { nodes } = await normalizeRoadmap({
      projects: [PROJECT],
      issues: [
        issue({ id: 'top', stateType: 'unstarted' }),
        issue({ id: 'kid', parentId: 'top', stateType: 'completed' }),
      ],
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get(await hashLinearId('top'))?.status).toBe('shipped');
    expect(byId.get(await hashLinearId('proj-1'))?.status).toBe('shipped');
  });

  it('derives project progress from top-level tasks only', async () => {
    const { nodes } = await normalizeRoadmap({
      projects: [PROJECT],
      issues: [
        issue({ id: 'done-task', stateType: 'completed' }),
        issue({ id: 'open-task', stateType: 'unstarted' }),
        // A subtask is not counted in the fraction (it rolls into its parent).
        issue({ id: 'open-sub', parentId: 'open-task', stateType: 'unstarted' }),
      ],
    });
    const project = nodes.find((n) => n.kind === 'project');
    expect(project?.progress).toEqual({ done: 1, total: 2 });
  });

  it('buckets bug labels as type bug', async () => {
    const { nodes } = await normalizeRoadmap({
      projects: [PROJECT],
      issues: [issue({ id: 'bug-1', labelNames: ['type:bug'] })],
    });
    expect(nodes.find((n) => n.kind === 'task')?.type).toBe('bug');
  });
});
