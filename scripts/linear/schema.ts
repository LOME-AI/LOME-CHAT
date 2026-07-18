import { z } from 'zod';

/**
 * Zod schemas for the serialized Linear board backup. This backup is the ONLY
 * revert path for autonomous grooming writes, so the shape is validated on
 * every backup run (see `validateBackup`) and a decode failure is a hard error.
 */

export const commentSchema = z.object({
  body: z.string(),
  url: z.string(),
  authorId: z.string().nullable(),
  createdAt: z.string(),
});

export const labelRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const stateRefSchema = z.object({
  name: z.string(),
  type: z.string(),
});

export const projectRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const parentRefSchema = z.object({
  id: z.string(),
  identifier: z.string(),
});

export const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  number: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  priority: z.number(),
  estimate: z.number().nullable(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stateId: z.string().nullable(),
  projectId: z.string().nullable(),
  parentId: z.string().nullable(),
  state: stateRefSchema.nullable(),
  project: projectRefSchema.nullable(),
  parent: parentRefSchema.nullable(),
  labels: z.array(labelRefSchema),
  comments: z.array(commentSchema),
  // Per-issue relation pagination markers. A false here means the comment or
  // label fetch loop was truncated, which `validateBackup` rejects — a partial
  // issue must never be trusted as a revert source.
  commentsComplete: z.boolean(),
  labelsComplete: z.boolean(),
});

export const workflowStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});

export const paginationSchema = z.object({
  issues: z.boolean(),
  projects: z.boolean(),
  labels: z.boolean(),
  workflowStates: z.boolean(),
});

export const backupSchema = z.object({
  fetchedAt: z.string(),
  pagination: paginationSchema,
  issues: z.array(issueSchema),
  projects: z.array(projectRefSchema),
  labels: z.array(labelRefSchema),
  workflowStates: z.array(workflowStateSchema),
});

export type BackupIssue = z.infer<typeof issueSchema>;
export type Backup = z.infer<typeof backupSchema>;
