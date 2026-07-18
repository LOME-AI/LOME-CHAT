import { describe, expect, it } from 'vitest';
import {
  LINEAR_ISSUE_STATE_TYPES,
  LINEAR_PROJECT_STATE_TYPES,
  LINEAR_TEAM_ID,
  LINEAR_TEAM_KEY,
  linearIssueStateTypeSchema,
  linearProjectStateTypeSchema,
} from './index.js';

describe('linear workspace identity', () => {
  it('exposes the HushBox team key', () => {
    expect(LINEAR_TEAM_KEY).toBe('HUS');
  });

  it('exposes the HushBox team id', () => {
    expect(LINEAR_TEAM_ID).toBe('10ff187f-22ea-4449-a6d1-d5f7f8dfc9c9');
  });
});

describe('linear issue state types', () => {
  it('covers the full WorkflowState universe', () => {
    expect(LINEAR_ISSUE_STATE_TYPES).toEqual([
      'triage',
      'backlog',
      'unstarted',
      'started',
      'completed',
      'canceled',
    ]);
  });

  it('accepts a valid member', () => {
    expect(linearIssueStateTypeSchema.parse('started')).toBe('started');
  });

  it('rejects an unknown value', () => {
    expect(linearIssueStateTypeSchema.safeParse('nope').success).toBe(false);
  });
});

describe('linear project state types', () => {
  it('covers the project state universe', () => {
    expect(LINEAR_PROJECT_STATE_TYPES).toEqual([
      'backlog',
      'planned',
      'started',
      'paused',
      'completed',
      'canceled',
    ]);
  });

  it('accepts a valid member', () => {
    expect(linearProjectStateTypeSchema.parse('planned')).toBe('planned');
  });

  it('rejects an unknown value', () => {
    expect(linearProjectStateTypeSchema.safeParse('nope').success).toBe(false);
  });
});
