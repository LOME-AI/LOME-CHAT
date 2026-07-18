import { RatelimitedLinearError } from '@linear/sdk';
import { LINEAR_TEAM_KEY } from '@hushbox/shared/linear';

import type { Backup, BackupIssue } from './schema.js';

/**
 * Structural view of the `@linear/sdk` surface this backup consumes. The SDK is
 * dependency-injected as this interface so tests run against a mock with no live
 * network; the entry point adapts a real `LinearClient` to it.
 */

export interface ConnectionLike<T> {
  pageInfo: { hasNextPage: boolean };
  nodes: T[];
  fetchNext(): Promise<ConnectionLike<T>>;
}

export interface StateNode {
  name: string;
  type: string;
}

export interface StateRow {
  id: string;
  name: string;
  type: string;
}

export interface ProjectNode {
  id: string;
  name: string;
}

export interface ParentNode {
  id: string;
  identifier: string;
}

export interface LabelNode {
  id: string;
  name: string;
}

export interface CommentNode {
  body: string;
  url: string;
  userId?: string | undefined;
  createdAt: Date | string;
}

export interface PageVariables {
  first?: number;
}

/** Team-scoping filter for the issues query — restricts the fetch to one team. */
export interface IssueFilter {
  team: { key: { eq: string } };
}

/** Issue-query variables: pagination plus the mandatory team-scope filter. */
export interface IssuePageVariables extends PageVariables {
  filter?: IssueFilter;
}

export interface IssueNode {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description?: string | null;
  priority: number;
  estimate?: number | null;
  url: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  stateId?: string | undefined;
  projectId?: string | undefined;
  parentId?: string | undefined;
  state?: Promise<StateNode | undefined> | undefined;
  project?: Promise<ProjectNode | undefined> | undefined;
  parent?: Promise<ParentNode | undefined> | undefined;
  labels(variables?: PageVariables): Promise<ConnectionLike<LabelNode>>;
  comments(variables?: PageVariables): Promise<ConnectionLike<CommentNode>>;
}

export interface BoardSource {
  issues(variables?: IssuePageVariables): Promise<ConnectionLike<IssueNode>>;
  projects(variables?: PageVariables): Promise<ConnectionLike<ProjectNode>>;
  issueLabels(variables?: PageVariables): Promise<ConnectionLike<LabelNode>>;
  workflowStates(variables?: PageVariables): Promise<ConnectionLike<StateRow>>;
}

/**
 * Input shapes for the grooming write path. Structural subsets of the SDK's
 * `IssueUpdateInput` / `IssueCreateInput` / `CommentCreateInput` /
 * `ProjectCreateInput`; every field this CLI sets is present, and each is
 * assignable to the SDK's (wider, all-optional-or-required-matching) type.
 * Labels use only the ADDITIVE `addedLabelIds`/`removedLabelIds` — never the
 * full-replace `labelIds`, which would silently drop labels left unspecified.
 */
export interface IssueUpdateInput {
  title?: string;
  description?: string;
  estimate?: number;
  priority?: number;
  stateId?: string;
  projectId?: string;
  addedLabelIds?: string[];
  removedLabelIds?: string[];
}

export interface IssueCreateInput {
  teamId: string;
  title: string;
  description?: string;
  estimate?: number;
  priority?: number;
  stateId?: string;
  projectId?: string;
  labelIds?: string[];
}

export interface CommentCreateInput {
  issueId: string;
  body: string;
}

export interface ProjectCreateInput {
  name: string;
  teamIds: string[];
  description?: string;
}

/**
 * Every Linear write returns a payload with a `success` boolean; getters can
 * report `success: false` WITHOUT throwing, so callers must check it.
 */
export interface WritePayload {
  success: boolean;
}

/**
 * Structural view of the `@linear/sdk` write surface. Dependency-injected so
 * tests exercise the grooming commands against a mock with no live network; the
 * entry point adapts a real `LinearClient` to it.
 */
export interface WriteSource {
  updateIssue(id: string, input: IssueUpdateInput): Promise<WritePayload>;
  createIssue(input: IssueCreateInput): Promise<WritePayload>;
  createComment(input: CommentCreateInput): Promise<WritePayload>;
  createProject(input: ProjectCreateInput): Promise<WritePayload>;
}

/** A call runner: wraps a single SDK call so rate limits can be handled. */
export type RunFunction = <T>(function_: () => Promise<T>) => Promise<T>;

const PAGE = 100;
const LABELS_PAGE = 50;

/** A resolved promise standing in for an absent relation, so the getter's
 * `undefined` branch still yields a promise the runner can wrap. */
const ABSENT_RELATION = Promise.resolve() as Promise<undefined>;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run an SDK call, honoring Linear's rate limit. The SDK does NOT auto-retry;
 * on `RatelimitedLinearError` it exposes `retryAfter` (seconds). We sleep that
 * long and re-issue the call. Any other error propagates unchanged.
 */
export async function withBackoff<T>(
  function_: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<T> {
  try {
    return await function_();
  } catch (error: unknown) {
    if (error instanceof RatelimitedLinearError) {
      await sleep((error.retryAfter ?? 1) * 1000);
      return withBackoff(function_, sleep);
    }
    throw error;
  }
}

/** Read a required environment variable, failing fast with a clear message. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

/** Drain a Relay connection through the runner, reporting whether it completed. */
async function collectAll<T>(
  fetchFirst: () => Promise<ConnectionLike<T>>,
  run: RunFunction
): Promise<{ nodes: T[]; complete: boolean }> {
  let connection = await run(fetchFirst);
  while (connection.pageInfo.hasNextPage) {
    const current = connection;
    connection = await run(() => current.fetchNext());
  }
  return { nodes: connection.nodes, complete: !connection.pageInfo.hasNextPage };
}

/**
 * Resolve a lazy issue relation into its serialized shape. Skips the fetch when
 * the scalar id is absent (no relation). Re-accesses the getter on each call so
 * `run`'s rate-limit retries re-issue the request rather than re-awaiting a
 * settled promise.
 */
async function resolveRelation<T, R>(
  id: string | undefined,
  get: () => Promise<T | undefined> | undefined,
  map: (value: T) => R,
  run: RunFunction
): Promise<R | null> {
  if (!id) {
    return null;
  }
  const value = await run(() => get() ?? ABSENT_RELATION);
  return value ? map(value) : null;
}

async function toBackupIssue(node: IssueNode, run: RunFunction): Promise<BackupIssue> {
  const state = await resolveRelation(
    node.stateId,
    () => node.state,
    (value) => ({ name: value.name, type: value.type }),
    run
  );
  const project = await resolveRelation(
    node.projectId,
    () => node.project,
    (value) => ({ id: value.id, name: value.name }),
    run
  );
  const parent = await resolveRelation(
    node.parentId,
    () => node.parent,
    (value) => ({ id: value.id, identifier: value.identifier }),
    run
  );

  const labels = await collectAll(() => node.labels({ first: LABELS_PAGE }), run);
  const comments = await collectAll(() => node.comments({ first: PAGE }), run);

  return {
    id: node.id,
    identifier: node.identifier,
    number: node.number,
    title: node.title,
    description: node.description ?? null,
    priority: node.priority,
    estimate: node.estimate ?? null,
    url: node.url,
    createdAt: toIso(node.createdAt),
    updatedAt: toIso(node.updatedAt),
    stateId: node.stateId ?? null,
    projectId: node.projectId ?? null,
    parentId: node.parentId ?? null,
    state,
    project,
    parent,
    labels: labels.nodes.map((label) => ({ id: label.id, name: label.name })),
    comments: comments.nodes.map((comment) => ({
      body: comment.body,
      url: comment.url,
      authorId: comment.userId ?? null,
      createdAt: toIso(comment.createdAt),
    })),
    commentsComplete: comments.complete,
    labelsComplete: labels.complete,
  };
}

/**
 * Fetch the full board: every issue (all states) with relations and comments,
 * plus all projects, labels, and workflow states. Every call passes through
 * `run` so rate limits are absorbed. Read-only — writes nothing to Linear.
 */
export async function fetchBoard(
  source: BoardSource,
  run: RunFunction = withBackoff
): Promise<Backup> {
  const issueConn = await collectAll(
    () => source.issues({ first: PAGE, filter: { team: { key: { eq: LINEAR_TEAM_KEY } } } }),
    run
  );
  const projectConn = await collectAll(() => source.projects({ first: PAGE }), run);
  const labelConn = await collectAll(() => source.issueLabels({ first: PAGE }), run);
  const stateConn = await collectAll(() => source.workflowStates({ first: PAGE }), run);

  const issues: BackupIssue[] = [];
  for (const node of issueConn.nodes) {
    issues.push(await toBackupIssue(node, run));
  }

  return {
    fetchedAt: new Date().toISOString(),
    pagination: {
      issues: issueConn.complete,
      projects: projectConn.complete,
      labels: labelConn.complete,
      workflowStates: stateConn.complete,
    },
    issues,
    projects: projectConn.nodes.map((project) => ({ id: project.id, name: project.name })),
    labels: labelConn.nodes.map((label) => ({ id: label.id, name: label.name })),
    workflowStates: stateConn.nodes.map((state) => ({
      id: state.id,
      name: state.name,
      type: state.type,
    })),
  };
}
