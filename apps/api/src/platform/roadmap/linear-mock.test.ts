import { describe, expect, it } from 'vitest';
import { createMockLinearClient } from './linear-mock.js';
import { MOCK_ISSUES, MOCK_PROJECTS } from './mock-roadmap-fixture.js';

describe('mock linear client', () => {
  it('returns the committed fixture regardless of team key', async () => {
    const client = createMockLinearClient();
    const data = await client.fetchRoadmap('ANY');
    expect(data.projects).toBe(MOCK_PROJECTS);
    expect(data.issues).toBe(MOCK_ISSUES);
  });

  it('ships a fixture with projects, an orphan issue and a subtask (board coverage)', () => {
    expect(MOCK_PROJECTS.length).toBeGreaterThan(2);
    expect(MOCK_ISSUES.some((issue) => issue.projectId === null)).toBe(true);
    expect(MOCK_ISSUES.some((issue) => issue.parentId !== null)).toBe(true);
  });
});
