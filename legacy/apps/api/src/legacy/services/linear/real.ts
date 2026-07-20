import { z } from 'zod';
import type {
  LinearClient,
  LinearIssue,
  LinearIssueStateType,
  LinearProject,
  LinearProjectStateType,
  LinearRoadmapData,
  LinearRelation,
} from './types.js';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const ISSUE_PAGE_SIZE = 100;

const projectStateTypeSchema = z.enum([
  'started',
  'planned',
  'completed',
  'paused',
  'backlog',
]) satisfies z.ZodType<LinearProjectStateType>;

const issueStateTypeSchema = z.enum([
  'unstarted',
  'started',
  'completed',
  'backlog',
]) satisfies z.ZodType<LinearIssueStateType>;

const relationKindSchema = z.enum(['blocks', 'blocked_by', 'related', 'duplicate']);

const projectsResponseSchema = z.object({
  data: z.object({
    teams: z.object({
      nodes: z.array(
        z.object({
          projects: z.object({
            nodes: z.array(
              z.object({
                id: z.string().min(1),
                name: z.string().min(1),
                color: z.string().min(1),
                status: z.object({
                  type: projectStateTypeSchema,
                }),
              })
            ),
          }),
        })
      ),
    }),
  }),
});

const issuesResponseSchema = z.object({
  data: z.object({
    issues: z.object({
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullable(),
      }),
      nodes: z.array(
        z.object({
          id: z.string().min(1),
          title: z.string().min(1),
          state: z.object({
            name: z.string().min(1),
            type: issueStateTypeSchema,
          }),
          labels: z.object({
            nodes: z.array(z.object({ name: z.string() })),
          }),
          parent: z.object({ id: z.string() }).nullable(),
          project: z.object({ id: z.string() }).nullable(),
          relations: z.object({
            nodes: z.array(
              z.object({
                type: relationKindSchema,
                relatedIssue: z.object({ id: z.string() }).nullable(),
              })
            ),
          }),
        })
      ),
    }),
  }),
});

// Linear's `Query.team` takes only `id: String!` (a UUID), not the team key.
// We hold the key ("HUS"), so resolve via the `teams` connection filtered by
// key — the same lookup the issues query uses (`team: { key: { eq } }`).
const PROJECTS_QUERY = `
  query PublicRoadmapProjects($teamKey: String!) {
    teams(filter: { key: { eq: $teamKey } }) {
      nodes {
        projects(filter: { status: { type: { neq: "canceled" } } }) {
          nodes {
            id
            name
            color
            status { type }
          }
        }
      }
    }
  }
`;

const ISSUES_QUERY = `
  query PublicRoadmapIssues($teamKey: String!, $after: String) {
    issues(
      first: ${String(ISSUE_PAGE_SIZE)},
      after: $after,
      filter: {
        team: { key: { eq: $teamKey } }
        state: { type: { nin: ["canceled", "triage"] } }
        labels: {
          and: [
            { name: { in: ["type:feature", "type:bug"] } }
            { name: { nin: ["area:infra"] } }
          ]
        }
      }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        state { name type }
        labels(first: 20) { nodes { name } }
        parent { id }
        project { id }
        relations(first: 20) {
          nodes {
            type
            relatedIssue { id }
          }
        }
      }
    }
  }
`;

/**
 * Real Linear GraphQL client. Used in CiVitest (validates schema against
 * live Linear) and Production. Local dev and E2E use the mock client.
 *
 * Network errors and Linear schema mismatches both throw — the route handler
 * maps thrown errors to a 503 with `code: 'SERVICE_UNAVAILABLE'`.
 */
export function createRealLinearClient(apiKey: string): LinearClient {
  return {
    fetchRoadmap: async (teamKey: string): Promise<LinearRoadmapData> => {
      const projects = await fetchProjects(apiKey, teamKey);
      const issues = await fetchIssues(apiKey, teamKey);
      return { projects, issues };
    },
  };
}

async function fetchProjects(apiKey: string, teamKey: string): Promise<readonly LinearProject[]> {
  const response = await postGraphQL(apiKey, PROJECTS_QUERY, { teamKey });
  const parsed = projectsResponseSchema.parse(response);
  const team = parsed.data.teams.nodes[0];
  if (team === undefined) return [];
  return team.projects.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    color: node.color,
    stateType: node.status.type,
  }));
}

type ParsedIssueNode = z.infer<typeof issuesResponseSchema>['data']['issues']['nodes'][number];

function mapIssueNode(node: ParsedIssueNode): LinearIssue {
  const relations: LinearRelation[] = [];
  for (const relation of node.relations.nodes) {
    if (
      (relation.type === 'blocks' || relation.type === 'blocked_by') &&
      relation.relatedIssue !== null
    ) {
      relations.push({ type: relation.type, relatedIssueId: relation.relatedIssue.id });
    }
  }
  return {
    id: node.id,
    title: node.title,
    stateName: node.state.name,
    stateType: node.state.type,
    labelNames: node.labels.nodes.map((l) => l.name),
    parentId: node.parent?.id ?? null,
    projectId: node.project?.id ?? null,
    relations,
  };
}

async function fetchIssues(apiKey: string, teamKey: string): Promise<readonly LinearIssue[]> {
  const all: LinearIssue[] = [];
  let cursor: string | null = null;
  do {
    const response = await postGraphQL(apiKey, ISSUES_QUERY, { teamKey, after: cursor });
    const parsed = issuesResponseSchema.parse(response);
    for (const node of parsed.data.issues.nodes) all.push(mapIssueNode(node));
    cursor = parsed.data.issues.pageInfo.hasNextPage ? parsed.data.issues.pageInfo.endCursor : null;
  } while (cursor !== null);
  return all;
}

async function postGraphQL(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new LinearApiError(response.status, body);
  }
  return response.json();
}

export class LinearApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    const truncated = body.length > 500 ? `${body.slice(0, 500)}…` : body;
    super(`Linear API responded with status ${String(status)}: ${truncated}`);
    this.name = 'LinearApiError';
    this.status = status;
    this.body = body;
  }
}
