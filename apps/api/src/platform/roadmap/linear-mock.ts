import { MOCK_ISSUES, MOCK_PROJECTS } from './mock-roadmap-fixture.js';
import type { LinearClient, LinearRoadmapData } from './linear-types.js';

/**
 * Mock Linear client used in local dev and E2E. Returns the committed
 * fixture from `mock-roadmap-fixture.ts` regardless of which team key is
 * passed — the fixture is fixed test data, not a real Linear workspace.
 *
 * Stateless: every call returns the same object. Cross-test bleed is
 * impossible because the fixture is `readonly`.
 */
export function createMockLinearClient(): LinearClient {
  return {
    fetchRoadmap(_teamKey: string): Promise<LinearRoadmapData> {
      const data: LinearRoadmapData = {
        projects: MOCK_PROJECTS,
        issues: MOCK_ISSUES,
      };
      return Promise.resolve(data);
    },
  };
}
