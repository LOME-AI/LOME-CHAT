import { createHash } from 'node:crypto';

import { backupSchema } from './schema.js';

import type { Backup } from './schema.js';

/** States whose issues are done and therefore never counted as ungroomed. */
const INACTIVE_STATE_TYPES = new Set(['completed', 'canceled']);

/** The label whose presence marks an issue as already groomed. */
const GROOMED_LABEL = 'groomed';

export interface ValidateOptions {
  /** Issue count of the previous backup; a decrease is rejected unless allowed. */
  prevCount?: number | undefined;
  /** Permit an issue count below `prevCount` (an intentional bulk delete). */
  allowShrink?: boolean | undefined;
}

/**
 * The groomed-marker hash. Stored in an issue comment so a later grooming pass
 * can tell whether the title/description it groomed still match — a changed
 * hash means the issue was edited after grooming and should be re-evaluated.
 */
export function groomedHash(title: string, description: string): string {
  return createHash('sha256').update(`${title}\n${description}`).digest('hex');
}

/**
 * Decode and validate a serialized board backup. Throws on any failure — this
 * backup is the only revert path for autonomous writes, so a partial or shrunk
 * backup must never be silently accepted.
 */
function assertIssuesValid(board: Backup): void {
  if (board.issues.length === 0) {
    throw new Error('backup validation failed: no issues fetched');
  }
  for (const issue of board.issues) {
    if (!issue.id || !issue.title) {
      throw new Error(`backup validation failed: issue missing id+title (${issue.id || '?'})`);
    }
    if (!issue.commentsComplete || !issue.labelsComplete) {
      throw new Error(
        `backup validation failed: incomplete pagination for issue ${issue.identifier}`
      );
    }
  }
}

function assertPaginationComplete(board: Backup): void {
  const { issues, projects, labels, workflowStates } = board.pagination;
  if (!issues || !projects || !labels || !workflowStates) {
    throw new Error('backup validation failed: incomplete pagination for a top-level collection');
  }
}

function assertNoUnexpectedShrink(count: number, options: ValidateOptions): void {
  if (options.prevCount !== undefined && count < options.prevCount && !options.allowShrink) {
    throw new Error(
      `backup validation failed: issue count shrank from ${String(options.prevCount)} to ${String(count)} (pass --allow-shrink to override)`
    );
  }
}

export function validateBackup(raw: unknown, options: ValidateOptions): Backup {
  const board = backupSchema.parse(raw);
  assertIssuesValid(board);
  assertPaginationComplete(board);
  assertNoUnexpectedShrink(board.issues.length, options);
  return board;
}

/**
 * Count active issues (not completed/canceled) that lack the groomed label.
 * Operates over a decoded backup so it needs no network access.
 */
export function countUngroomed(board: Backup): number {
  return board.issues.filter((issue) => {
    const active = !issue.state || !INACTIVE_STATE_TYPES.has(issue.state.type);
    const groomed = issue.labels.some((label) => label.name === GROOMED_LABEL);
    return active && !groomed;
  }).length;
}
