import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from '@upstash/redis';
import { roadmapResponseSchema, type RoadmapResponse } from '@hushbox/shared';
import { RoadmapCache } from './cache.js';
import { buildRoadmap } from './pipeline.js';
import { MOCK_PROJECTS, MOCK_ISSUES } from '../linear/mock-fixtures/roadmap.js';
import type { LinearClient } from '../linear/index.js';

function makeStubRedis(): Redis {
  const store = new Map<string, unknown>();
  return {
    get: (key: string) => Promise.resolve(store.has(key) ? store.get(key) : null),
    set: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve('OK');
    },
  } as unknown as Redis;
}

function makeFixtureLinear(): LinearClient {
  return {
    fetchRoadmap() {
      return Promise.resolve({ projects: MOCK_PROJECTS, issues: MOCK_ISSUES });
    },
  };
}

describe('buildRoadmap', () => {
  let cache: RoadmapCache;

  beforeEach(() => {
    cache = new RoadmapCache(makeStubRedis(), 'HUS');
  });

  it('fetches Linear on a cold cache and writes the response', async () => {
    const linear = makeFixtureLinear();
    const spy = vi.spyOn(linear, 'fetchRoadmap');
    const response = await buildRoadmap(linear, cache);
    expect(spy).toHaveBeenCalledTimes(1);
    const cached = await cache.get();
    expect(cached).toEqual(response);
  });

  it('returns the cached response on a warm cache without calling Linear', async () => {
    const linear = makeFixtureLinear();
    const cold = await buildRoadmap(linear, cache);
    const spy = vi.spyOn(linear, 'fetchRoadmap');
    const warm = await buildRoadmap(linear, cache);
    expect(spy).not.toHaveBeenCalled();
    expect(warm).toEqual(cold);
  });

  it('produces a response that parses against the public schema', async () => {
    const linear = makeFixtureLinear();
    const response = await buildRoadmap(linear, cache);
    const parsed: RoadmapResponse = roadmapResponseSchema.parse(response);
    expect(parsed.nodes.length).toBeGreaterThan(0);
  });

  it('propagates Linear failures (no stale fallback)', async () => {
    const failing: LinearClient = {
      fetchRoadmap() {
        return Promise.reject(new Error('linear down'));
      },
    };
    await expect(buildRoadmap(failing, cache)).rejects.toThrow('linear down');
    expect(await cache.get()).toBeNull();
  });

  it('returns nodes with only opaque 12-hex ids', async () => {
    const linear = makeFixtureLinear();
    const response = await buildRoadmap(linear, cache);
    for (const node of response.nodes) {
      expect(node.id).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it('never includes a description or url field in any node', async () => {
    const linear = makeFixtureLinear();
    const response = await buildRoadmap(linear, cache);
    for (const node of response.nodes) {
      expect(node).not.toHaveProperty('description');
      expect(node).not.toHaveProperty('url');
      expect(node).not.toHaveProperty('assignee');
      expect(node).not.toHaveProperty('dueDate');
    }
  });

  it('attaches a progress object to every project node', async () => {
    const linear = makeFixtureLinear();
    const response = await buildRoadmap(linear, cache);
    const projects = response.nodes.filter((n) => n.kind === 'project');
    expect(projects.length).toBeGreaterThan(0);
    for (const project of projects) {
      expect(project.progress).toBeDefined();
      expect(project.progress?.done).toBeGreaterThanOrEqual(0);
      expect(project.progress?.total).toBeGreaterThanOrEqual(project.progress?.done ?? 0);
    }
  });

  it('omits progress from task and subtask nodes', async () => {
    const linear = makeFixtureLinear();
    const response = await buildRoadmap(linear, cache);
    const issues = response.nodes.filter((n) => n.kind === 'task' || n.kind === 'subtask');
    for (const issue of issues) {
      expect(issue.progress).toBeUndefined();
    }
  });
});
