/**
 * Internal Linear client types. These are the shape returned by both the
 * real GraphQL client and the mock client. Downstream code (normalize,
 * pipeline) consumes this type and never sees raw GraphQL responses.
 *
 * Sensitive Linear fields (description, assignee, creator, comments, customer
 * data, urls, dueDate, estimate, priority, identifier) are NEVER included
 * here. The narrow type IS the first wall against accidental leaks; the
 * public {@link RoadmapResponseSchema} in `@hushbox/shared` is the second.
 */

export interface LinearClient {
  /**
   * Fetch all visible roadmap data for a team. Returns the project list
   * and the issue list separately because the real GraphQL API exposes
   * them as separate queries; downstream code joins them.
   */
  fetchRoadmap(teamKey: string): Promise<LinearRoadmapData>;
}

export interface LinearRoadmapData {
  projects: readonly LinearProject[];
  issues: readonly LinearIssue[];
}

export type LinearProjectStateType = 'started' | 'planned' | 'completed' | 'paused' | 'backlog';

export interface LinearProject {
  id: string;
  name: string;
  color: string;
  stateType: LinearProjectStateType;
}

export type LinearIssueStateType = 'unstarted' | 'started' | 'completed' | 'backlog';

export interface LinearIssue {
  id: string;
  title: string;
  stateName: string;
  stateType: LinearIssueStateType;
  labelNames: readonly string[];
  parentId: string | null;
  projectId: string | null;
  relations: readonly LinearRelation[];
}

export type LinearRelationKind = 'blocks' | 'blocked_by';

export interface LinearRelation {
  type: LinearRelationKind;
  relatedIssueId: string;
}
