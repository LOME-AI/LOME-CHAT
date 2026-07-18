import { z } from 'zod';

/**
 * Single source for the HushBox Linear workspace identity and the Linear
 * WorkflowState universe. The Worker's roadmap slice keeps deliberately
 * narrower issue/project state enums as a leak-prevention wall
 * (`apps/api/src/platform/roadmap/linear-types.ts`); these are the full
 * Linear-defined sets, used where the whole universe is meant.
 */

/** HushBox team key in Linear (the `HUS-123` identifier prefix). */
export const LINEAR_TEAM_KEY = 'HUS' as const;

/** HushBox team UUID in Linear. */
export const LINEAR_TEAM_ID = '10ff187f-22ea-4449-a6d1-d5f7f8dfc9c9' as const;

/** The full Linear WorkflowState `type` universe for issues. */
export const LINEAR_ISSUE_STATE_TYPES = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const;

/** Zod schema validating an issue WorkflowState type. */
export const linearIssueStateTypeSchema = z.enum(LINEAR_ISSUE_STATE_TYPES);

/** TypeScript type for an issue WorkflowState type. */
export type LinearWorkflowStateType = z.infer<typeof linearIssueStateTypeSchema>;

/** The full Linear ProjectStatus `type` universe. */
export const LINEAR_PROJECT_STATE_TYPES = [
  'backlog',
  'planned',
  'started',
  'paused',
  'completed',
  'canceled',
] as const;

/** Zod schema validating a project ProjectStatus type. */
export const linearProjectStateTypeSchema = z.enum(LINEAR_PROJECT_STATE_TYPES);

/** TypeScript type for a project ProjectStatus type. */
export type LinearProjectStatusType = z.infer<typeof linearProjectStateTypeSchema>;
