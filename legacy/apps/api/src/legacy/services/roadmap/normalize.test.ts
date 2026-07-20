import { describe, it, expect } from 'vitest';
import { normalizeRoadmap, hashLinearId, ORPHAN_PROJECT_ID } from './normalize.js';
import type { LinearRoadmapData } from '../linear/types.js';

function makeData(overrides: Partial<LinearRoadmapData>): LinearRoadmapData {
  return {
    projects: [],
    issues: [],
    ...overrides,
  };
}

describe('hashLinearId', () => {
  it('returns a 12-char lowercase hex string', async () => {
    const result = await hashLinearId('linear-id-1');
    expect(result).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic for the same input', async () => {
    const a = await hashLinearId('same');
    const b = await hashLinearId('same');
    expect(a).toBe(b);
  });

  it('differs for different inputs', async () => {
    const a = await hashLinearId('input-a');
    const b = await hashLinearId('input-b');
    expect(a).not.toBe(b);
  });
});

describe('normalizeRoadmap', () => {
  it('emits an empty nodes array for empty input', async () => {
    const result = await normalizeRoadmap(makeData({}));
    expect(result.nodes).toHaveLength(0);
  });

  it('drops issues that lack a type:feature or type:bug label', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#ec4755', stateType: 'started' }],
      issues: [
        {
          id: 'i1',
          title: 'no type label',
          stateName: 'In Progress',
          stateType: 'started',
          labelNames: ['area:web'],
          parentId: null,
          projectId: 'p1',
          relations: [],
        },
      ],
    });
    const result = await normalizeRoadmap(data);
    expect(result.nodes).toHaveLength(0);
  });

  it('buckets state types into the three public statuses', async () => {
    const data = makeData({
      projects: [
        { id: 'p-go', name: 'Going', color: '#000000', stateType: 'started' },
        { id: 'p-pl', name: 'Plan', color: '#000000', stateType: 'planned' },
        { id: 'p-bl', name: 'Back', color: '#000000', stateType: 'backlog' },
        { id: 'p-ps', name: 'Paus', color: '#000000', stateType: 'paused' },
        { id: 'p-do', name: 'Done', color: '#000000', stateType: 'completed' },
      ],
      issues: [
        makeFeature('i-go', 'p-go', 'started'),
        makeFeature('i-pl', 'p-pl', 'unstarted'),
        makeFeature('i-bl', 'p-bl', 'backlog'),
        makeFeature('i-ps', 'p-ps', 'unstarted'),
        makeFeature('i-do', 'p-do', 'completed'),
      ],
    });
    const result = await normalizeRoadmap(data);
    const projectStatuses = result.nodes
      .filter((n) => n.kind === 'project')
      .map((n) => `${n.title}=${n.status}`)
      .toSorted((a, b) => a.localeCompare(b));
    expect(projectStatuses).toEqual([
      'Back=planned',
      'Done=shipped',
      'Going=in_progress',
      'Paus=planned',
      'Plan=planned',
    ]);
  });

  it('routes orphan issues into the synthetic Other project', async () => {
    const data = makeData({
      projects: [],
      issues: [
        {
          id: 'i-orph',
          title: 'no project',
          stateName: 'Todo',
          stateType: 'unstarted',
          labelNames: ['type:feature'],
          parentId: null,
          projectId: null,
          relations: [],
        },
      ],
    });
    const result = await normalizeRoadmap(data);
    const orphanHash = await hashLinearId(ORPHAN_PROJECT_ID);
    const orphanProject = result.nodes.find((n) => n.id === orphanHash);
    expect(orphanProject?.title).toBe('Other');
    expect(orphanProject?.kind).toBe('project');
    const task = result.nodes.find((n) => n.kind === 'task');
    expect(task?.parentId).toBe(orphanHash);
  });

  it('omits projects that have no surviving issues', async () => {
    const data = makeData({
      projects: [
        { id: 'p-empty', name: 'Empty', color: '#000000', stateType: 'planned' },
        { id: 'p-full', name: 'Full', color: '#000000', stateType: 'started' },
      ],
      issues: [makeFeature('i-only', 'p-full', 'started')],
    });
    const result = await normalizeRoadmap(data);
    const projectTitles = result.nodes.filter((n) => n.kind === 'project').map((n) => n.title);
    expect(projectTitles).toEqual(['Full']);
  });

  it('uses parentId to encode the project → task → subtask hierarchy', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [
        makeFeature('task', 'p1', 'started'),
        { ...makeFeature('sub', 'p1', 'started'), parentId: 'task' },
      ],
    });
    const result = await normalizeRoadmap(data);
    const project = result.nodes.find((n) => n.kind === 'project');
    const task = result.nodes.find((n) => n.title === 'task');
    const sub = result.nodes.find((n) => n.title === 'sub');
    expect(task?.kind).toBe('task');
    expect(task?.parentId).toBe(project?.id);
    expect(sub?.kind).toBe('subtask');
    expect(sub?.parentId).toBe(task?.id);
  });

  it('flattens deeper-than-2 hierarchies onto the depth-1 ancestor', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [
        makeFeature('task', 'p1', 'started'),
        { ...makeFeature('sub', 'p1', 'started'), parentId: 'task' },
        { ...makeFeature('subsub', 'p1', 'started'), parentId: 'sub' },
        { ...makeFeature('subsubsub', 'p1', 'started'), parentId: 'subsub' },
      ],
    });
    const result = await normalizeRoadmap(data);
    const taskNode = result.nodes.find((n) => n.title === 'task');
    const deepNodes = result.nodes.filter((n) => n.title.startsWith('subsub'));
    for (const node of deepNodes) {
      expect(node.kind).toBe('subtask');
      expect(node.parentId).toBe(taskNode?.id);
    }
  });

  it('uses opaque 12-hex ids on the wire, never raw Linear ids', async () => {
    const data = makeData({
      projects: [{ id: 'p1-uuid-style', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [makeFeature('i1-uuid-style', 'p1-uuid-style', 'started')],
    });
    const result = await normalizeRoadmap(data);
    for (const node of result.nodes) {
      expect(node.id).toMatch(/^[0-9a-f]{12}$/);
      expect(node.id).not.toContain('-');
      expect(node.id).not.toContain('uuid');
    }
  });

  it('extracts the issue type from the label set', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [
        { ...makeFeature('feat', 'p1', 'started'), labelNames: ['type:feature'] },
        { ...makeFeature('bug', 'p1', 'started'), labelNames: ['type:bug'] },
      ],
    });
    const result = await normalizeRoadmap(data);
    const feat = result.nodes.find((n) => n.title === 'feat');
    const bug = result.nodes.find((n) => n.title === 'bug');
    expect(feat?.type).toBe('feature');
    expect(bug?.type).toBe('bug');
  });

  it('rolls a planned project up to in_progress when it has an in_progress task', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'planned' }],
      issues: [makeFeature('t1', 'p1', 'started')],
    });
    const result = await normalizeRoadmap(data);
    const project = result.nodes.find((n) => n.kind === 'project');
    expect(project?.status).toBe('in_progress');
  });

  it('rolls a planned project up to shipped when it has a shipped task', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'planned' }],
      issues: [makeFeature('t1', 'p1', 'completed')],
    });
    const result = await normalizeRoadmap(data);
    const project = result.nodes.find((n) => n.kind === 'project');
    expect(project?.status).toBe('shipped');
  });

  it('rolls in_progress project up to shipped when it has a shipped task', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [makeFeature('t1', 'p1', 'completed')],
    });
    const result = await normalizeRoadmap(data);
    const project = result.nodes.find((n) => n.kind === 'project');
    expect(project?.status).toBe('shipped');
  });

  it('keeps a shipped project shipped even if a child task is planned (max of self + children)', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'completed' }],
      issues: [makeFeature('t1', 'p1', 'unstarted')],
    });
    const result = await normalizeRoadmap(data);
    const project = result.nodes.find((n) => n.kind === 'project');
    expect(project?.status).toBe('shipped');
  });

  it('rolls a planned task up to in_progress when it has an in_progress subtask', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [
        { ...makeFeature('task', 'p1', 'unstarted'), id: 'task' },
        { ...makeFeature('sub', 'p1', 'started'), parentId: 'task' },
      ],
    });
    const result = await normalizeRoadmap(data);
    const task = result.nodes.find((n) => n.title === 'task');
    expect(task?.status).toBe('in_progress');
  });

  it('rolls subtask status up the chain to the project', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'planned' }],
      issues: [
        { ...makeFeature('task', 'p1', 'unstarted'), id: 'task' },
        { ...makeFeature('sub', 'p1', 'started'), parentId: 'task' },
      ],
    });
    const result = await normalizeRoadmap(data);
    const project = result.nodes.find((n) => n.kind === 'project');
    expect(project?.status).toBe('in_progress');
  });

  it('does not emit edges on the public response', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [makeFeature('t1', 'p1', 'started')],
    });
    const result = await normalizeRoadmap(data);
    expect(result).not.toHaveProperty('edges');
  });

  it('does not emit progress on task nodes', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [makeFeature('t1', 'p1', 'started')],
    });
    const result = await normalizeRoadmap(data);
    const task = result.nodes.find((n) => n.kind === 'task');
    expect(task?.progress).toBeUndefined();
  });

  it('does not emit progress on subtask nodes', async () => {
    const data = makeData({
      projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
      issues: [
        { ...makeFeature('task', 'p1', 'unstarted'), id: 'task' },
        { ...makeFeature('sub', 'p1', 'completed'), parentId: 'task' },
      ],
    });
    const result = await normalizeRoadmap(data);
    const sub = result.nodes.find((n) => n.kind === 'subtask');
    expect(sub?.progress).toBeUndefined();
  });

  describe('progress', () => {
    it('reports 0/0 on a project with no tasks (impossible in practice but defensive)', async () => {
      const data = makeData({
        projects: [{ id: 'p1', name: 'Empty', color: '#000000', stateType: 'planned' }],
        issues: [],
      });
      const result = await normalizeRoadmap(data);
      const project = result.nodes.find((n) => n.kind === 'project');
      // Empty projects are omitted upstream, so the project shouldn't appear.
      expect(project).toBeUndefined();
    });

    it('counts only top-level tasks (subtasks do not increase the denominator)', async () => {
      const data = makeData({
        projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
        issues: [
          { ...makeFeature('task', 'p1', 'unstarted'), id: 'task' },
          { ...makeFeature('sub-a', 'p1', 'completed'), parentId: 'task' },
          { ...makeFeature('sub-b', 'p1', 'completed'), parentId: 'task' },
        ],
      });
      const result = await normalizeRoadmap(data);
      const project = result.nodes.find((n) => n.kind === 'project');
      // 1 task, fully rolled-up to shipped because all its subtasks are shipped.
      expect(project?.progress).toEqual({ done: 1, total: 1 });
    });

    it('counts task as done when its rolled-up status is shipped', async () => {
      const data = makeData({
        projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
        issues: [
          makeFeature('a', 'p1', 'completed'),
          makeFeature('b', 'p1', 'completed'),
          makeFeature('c', 'p1', 'started'),
          makeFeature('d', 'p1', 'unstarted'),
        ],
      });
      const result = await normalizeRoadmap(data);
      const project = result.nodes.find((n) => n.kind === 'project');
      expect(project?.progress).toEqual({ done: 2, total: 4 });
    });

    it('counts a task with all-shipped subtasks as done in the project progress', async () => {
      const data = makeData({
        projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'started' }],
        issues: [
          { ...makeFeature('task-rolled', 'p1', 'unstarted'), id: 'task-rolled' },
          { ...makeFeature('s1', 'p1', 'completed'), parentId: 'task-rolled' },
          { ...makeFeature('s2', 'p1', 'completed'), parentId: 'task-rolled' },
          makeFeature('task-todo', 'p1', 'unstarted'),
        ],
      });
      const result = await normalizeRoadmap(data);
      const project = result.nodes.find((n) => n.kind === 'project');
      expect(project?.progress).toEqual({ done: 1, total: 2 });
    });

    it('returns 0/N when no tasks are shipped', async () => {
      const data = makeData({
        projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'planned' }],
        issues: [
          makeFeature('a', 'p1', 'unstarted'),
          makeFeature('b', 'p1', 'unstarted'),
          makeFeature('c', 'p1', 'unstarted'),
        ],
      });
      const result = await normalizeRoadmap(data);
      const project = result.nodes.find((n) => n.kind === 'project');
      expect(project?.progress).toEqual({ done: 0, total: 3 });
    });

    it('returns N/N when every task is shipped', async () => {
      const data = makeData({
        projects: [{ id: 'p1', name: 'P', color: '#000000', stateType: 'completed' }],
        issues: [makeFeature('a', 'p1', 'completed'), makeFeature('b', 'p1', 'completed')],
      });
      const result = await normalizeRoadmap(data);
      const project = result.nodes.find((n) => n.kind === 'project');
      expect(project?.progress).toEqual({ done: 2, total: 2 });
    });
  });
});

function makeFeature(
  id: string,
  projectId: string | null,
  stateType: 'started' | 'unstarted' | 'completed' | 'backlog'
): import('../linear/types.js').LinearIssue {
  return {
    id,
    title: id,
    stateName: stateType,
    stateType,
    labelNames: ['type:feature'],
    parentId: null,
    projectId,
    relations: [],
  };
}
