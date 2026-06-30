import type { LinearIssue, LinearProject, LinearRoadmapData } from '../linear/types.js';
import type { NormalizedGraph, NormalizedNode } from './types.js';

const TYPE_LABEL_FEATURE = 'type:feature';
const TYPE_LABEL_BUG = 'type:bug';

type PublicStatus = 'in_progress' | 'planned' | 'shipped';

/**
 * Synthetic project id used to bucket orphan issues (no Linear project
 * assigned). Exported so tests can hash this id and assert orphan routing.
 */
export const ORPHAN_PROJECT_ID = 'orphan';
const ORPHAN_PROJECT_NAME = 'Other';
const ORPHAN_PROJECT_COLOR = '#71717a';

/**
 * Status precedence for the parent roll-up. Visually shipped (green) is the
 * loudest, then in_progress (red), then planned (grey). A parent's effective
 * status is the max of its own status and all descendants' statuses, so the
 * board never shows a parent in a "quieter" colour than one of its children.
 */
const STATUS_RANK: Readonly<Record<PublicStatus, number>> = {
  planned: 0,
  in_progress: 1,
  shipped: 2,
};

function maxStatus(a: PublicStatus, b: PublicStatus): PublicStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/**
 * Compute a 12-char hex SHA-256 prefix of a Linear id. Used as the opaque
 * id on the public wire so the marketing API never exposes raw Linear ids
 * (which are workspace-scoped UUIDs that leak ticket-numbering pace).
 */
export async function hashLinearId(linearId: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(linearId));
  return Array.from(new Uint8Array(buf, 0, 6), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

function bucketStatus(
  stateType: LinearIssue['stateType'] | LinearProject['stateType']
): PublicStatus {
  if (stateType === 'started') return 'in_progress';
  if (stateType === 'completed') return 'shipped';
  return 'planned';
}

function pickIssueType(labels: readonly string[]): 'feature' | 'bug' | null {
  if (labels.includes(TYPE_LABEL_FEATURE)) return 'feature';
  if (labels.includes(TYPE_LABEL_BUG)) return 'bug';
  return null;
}

/**
 * Walk the parent chain to find the depth-1 ancestor (the task that owns
 * this subtask). Returns null if the chain is already at depth 0 (the
 * issue is itself a top-level task).
 *
 * Linear allows arbitrary nesting; this clamps any depth ≥ 2 onto depth 1.
 */
function findDepth1Ancestor(issueId: string, issuesById: Map<string, LinearIssue>): string | null {
  const start = issuesById.get(issueId);
  if (start === undefined) return null;
  if (start.parentId === null) return null;

  let cursor: LinearIssue | undefined = issuesById.get(start.parentId);
  let safetyDepth = 0;
  while (cursor !== undefined && cursor.parentId !== null && safetyDepth < 64) {
    cursor = issuesById.get(cursor.parentId);
    safetyDepth += 1;
  }
  return cursor?.id ?? null;
}

/**
 * Normalize raw Linear data into the public node list. Steps:
 *
 * 1. Filter issues to features and bugs only (defensive — the GraphQL query
 *    already filters, but the mock fixture may contain other rows).
 * 2. Assign orphan issues (no Linear project) to a synthetic "Other" project.
 * 3. Build nodes for every project and issue with hashed opaque ids.
 * 4. Flatten anything deeper than 2 levels onto its depth-1 ancestor.
 * 5. Roll status up: each parent's status = max(self, ...descendants).
 * 6. Derive per-project progress from top-level task statuses.
 */
function collectProjectsToRender(
  projects: readonly LinearProject[],
  filteredIssues: readonly LinearIssue[]
): LinearProject[] {
  const usedProjectIds = new Set<string>();
  let usedOrphan = false;
  for (const issue of filteredIssues) {
    if (issue.projectId === null) usedOrphan = true;
    else usedProjectIds.add(issue.projectId);
  }
  const rendered: LinearProject[] = projects.filter((p) => usedProjectIds.has(p.id));
  if (usedOrphan) {
    rendered.push({
      id: ORPHAN_PROJECT_ID,
      name: ORPHAN_PROJECT_NAME,
      color: ORPHAN_PROJECT_COLOR,
      stateType: 'planned',
    });
  }
  return rendered;
}

async function hashProjectIds(
  projects: readonly LinearProject[],
  orphanHashId: string
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const project of projects) {
    hashes.set(
      project.id,
      project.id === ORPHAN_PROJECT_ID ? orphanHashId : await hashLinearId(project.id)
    );
  }
  return hashes;
}

async function hashIssueIds(issues: readonly LinearIssue[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const issue of issues) {
    hashes.set(issue.id, await hashLinearId(issue.id));
  }
  return hashes;
}

function buildProjectNodes(
  projects: readonly LinearProject[],
  projectHashes: ReadonlyMap<string, string>
): NormalizedNode[] {
  const nodes: NormalizedNode[] = [];
  for (const project of projects) {
    const hashedId = projectHashes.get(project.id);
    if (hashedId === undefined) continue;
    nodes.push({
      id: hashedId,
      kind: 'project',
      parentId: null,
      title: project.name,
      status: bucketStatus(project.stateType),
      type: null,
      progress: { done: 0, total: 0 },
    });
  }
  return nodes;
}

interface IdHashes {
  readonly issues: ReadonlyMap<string, string>;
  readonly projects: ReadonlyMap<string, string>;
  readonly orphan: string;
}

function buildIssueNodes(
  filteredIssues: readonly LinearIssue[],
  issuesById: Map<string, LinearIssue>,
  hashes: IdHashes
): NormalizedNode[] {
  const nodes: NormalizedNode[] = [];
  for (const issue of filteredIssues) {
    const hashedId = hashes.issues.get(issue.id);
    if (hashedId === undefined) continue;
    const projectId = issue.projectId ?? ORPHAN_PROJECT_ID;
    const projectHash = hashes.projects.get(projectId) ?? hashes.orphan;
    const ancestorId = findDepth1Ancestor(issue.id, issuesById);
    const isSubtask = ancestorId !== null;
    const parentHash = isSubtask ? (hashes.issues.get(ancestorId) ?? projectHash) : projectHash;
    nodes.push({
      id: hashedId,
      kind: isSubtask ? 'subtask' : 'task',
      parentId: parentHash,
      title: issue.title,
      status: bucketStatus(issue.stateType),
      type: pickIssueType(issue.labelNames),
    });
  }
  return nodes;
}

export async function normalizeRoadmap(data: LinearRoadmapData): Promise<NormalizedGraph> {
  const issuesById = new Map<string, LinearIssue>();
  for (const issue of data.issues) issuesById.set(issue.id, issue);

  const filteredIssues = data.issues.filter((issue) => pickIssueType(issue.labelNames) !== null);
  const orphanHashId = await hashLinearId(ORPHAN_PROJECT_ID);
  const projectsToRender = collectProjectsToRender(data.projects, filteredIssues);
  const projectHashes = await hashProjectIds(projectsToRender, orphanHashId);
  const issueHashes = await hashIssueIds(filteredIssues);

  const nodes: NormalizedNode[] = [
    ...buildProjectNodes(projectsToRender, projectHashes),
    ...buildIssueNodes(filteredIssues, issuesById, {
      issues: issueHashes,
      projects: projectHashes,
      orphan: orphanHashId,
    }),
  ];

  rollUpStatuses(nodes);
  attachProgress(nodes);

  return { nodes };
}

/**
 * Walk the graph from subtasks → tasks → projects, mutating each non-leaf
 * node's status to max(self, ...children). Subtasks are leaves (depth-1
 * flattening earlier in the pipeline means there are no deeper levels) so
 * the order is fixed and finite — no recursion needed. Tasks roll up first
 * so projects see post-rolled task statuses when their turn comes.
 */
function rollUpStatuses(nodes: NormalizedNode[]): void {
  const childrenByParent = new Map<string, NormalizedNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = childrenByParent.get(node.parentId) ?? [];
    list.push(node);
    childrenByParent.set(node.parentId, list);
  }

  rollUpKind(nodes, childrenByParent, 'task');
  rollUpKind(nodes, childrenByParent, 'project');
}

function rollUpKind(
  nodes: NormalizedNode[],
  childrenByParent: ReadonlyMap<string, readonly NormalizedNode[]>,
  kind: NormalizedNode['kind']
): void {
  for (const node of nodes) {
    if (node.kind !== kind) continue;
    const kids = childrenByParent.get(node.id);
    if (kids === undefined) continue;
    let rolled: PublicStatus = node.status;
    for (const kid of kids) rolled = maxStatus(rolled, kid.status);
    node.status = rolled;
  }
}

/**
 * Compute progress on each project node. `done` and `total` count top-level
 * tasks only — subtasks roll up into their parent task's status during
 * {@link rollUpStatuses}, so counting them again would double-weight tasks
 * that happen to have subtasks. The visible bullet list inside each project
 * card matches what this fraction measures.
 */
function attachProgress(nodes: NormalizedNode[]): void {
  const taskCountByProject = new Map<string, { done: number; total: number }>();
  for (const node of nodes) {
    if (node.kind !== 'task' || node.parentId === null) continue;
    const counts = taskCountByProject.get(node.parentId) ?? { done: 0, total: 0 };
    counts.total += 1;
    if (node.status === 'shipped') counts.done += 1;
    taskCountByProject.set(node.parentId, counts);
  }

  for (const node of nodes) {
    if (node.kind !== 'project') continue;
    node.progress = taskCountByProject.get(node.id) ?? { done: 0, total: 0 };
  }
}
