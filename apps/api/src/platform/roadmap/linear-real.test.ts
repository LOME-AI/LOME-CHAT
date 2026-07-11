import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinearApiError, createRealLinearClient } from './linear-real.js';

interface RecordedCall {
  readonly query: string;
  readonly variables: Record<string, unknown>;
  readonly authorization: string | null;
}

function projectsPayload(): unknown {
  return {
    data: {
      teams: {
        nodes: [
          {
            projects: {
              nodes: [{ id: 'proj-1', name: 'One', color: '#fff', status: { type: 'started' } }],
            },
          },
        ],
      },
    },
  };
}

function issuesPayload(
  ids: readonly string[],
  page: { hasNextPage: boolean; endCursor: string | null }
): unknown {
  return {
    data: {
      issues: {
        pageInfo: page,
        nodes: ids.map((id) => ({
          id,
          title: `Issue ${id}`,
          state: { name: 'Todo', type: 'unstarted' },
          labels: { nodes: [{ name: 'type:feature' }] },
          parent: null,
          project: { id: 'proj-1' },
          relations: {
            nodes: [
              { type: 'blocks', relatedIssue: { id: 'related-1' } },
              { type: 'related', relatedIssue: { id: 'ignored' } },
              { type: 'blocked_by', relatedIssue: null },
            ],
          },
        })),
      },
    },
  };
}

function stubFetch(responses: readonly unknown[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const headers = new Headers(init?.headers);
      calls.push({
        query: body.query,
        variables: body.variables,
        authorization: headers.get('Authorization'),
      });
      const payload = responses[index];
      index += 1;
      return Promise.resolve(Response.json(payload, { status: 200 }));
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('real linear client', () => {
  it('fetches projects + issues and maps blocking relations only', async () => {
    const calls = stubFetch([
      projectsPayload(),
      issuesPayload(['iss-1'], { hasNextPage: false, endCursor: null }),
    ]);
    const data = await createRealLinearClient('lin_key').fetchRoadmap('HUS');

    expect(calls).toHaveLength(2);
    expect(calls[0]?.authorization).toBe('lin_key');
    expect(calls.every((call) => call.variables['teamKey'] === 'HUS')).toBe(true);
    expect(data.projects).toEqual([
      { id: 'proj-1', name: 'One', color: '#fff', stateType: 'started' },
    ]);
    expect(data.issues).toEqual([
      {
        id: 'iss-1',
        title: 'Issue iss-1',
        stateName: 'Todo',
        stateType: 'unstarted',
        labelNames: ['type:feature'],
        parentId: null,
        projectId: 'proj-1',
        relations: [{ type: 'blocks', relatedIssueId: 'related-1' }],
      },
    ]);
  });

  it('returns no projects when the team key matches nothing', async () => {
    stubFetch([
      { data: { teams: { nodes: [] } } },
      issuesPayload([], { hasNextPage: false, endCursor: null }),
    ]);
    const data = await createRealLinearClient('lin_key').fetchRoadmap('NOPE');
    expect(data.projects).toEqual([]);
  });

  it('paginates issues until hasNextPage is false', async () => {
    const calls = stubFetch([
      projectsPayload(),
      issuesPayload(['iss-1'], { hasNextPage: true, endCursor: 'cursor-1' }),
      issuesPayload(['iss-2'], { hasNextPage: false, endCursor: null }),
    ]);
    const data = await createRealLinearClient('lin_key').fetchRoadmap('HUS');
    expect(data.issues.map((issue) => issue.id)).toEqual(['iss-1', 'iss-2']);
    expect(calls[2]?.variables['after']).toBe('cursor-1');
  });

  it('throws LinearApiError (truncated body) on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('x'.repeat(600), { status: 500 })))
    );
    const attempt = createRealLinearClient('lin_key').fetchRoadmap('HUS');
    await expect(attempt).rejects.toBeInstanceOf(LinearApiError);
    await expect(createRealLinearClient('lin_key').fetchRoadmap('HUS')).rejects.toThrow(
      /status 500/
    );
  });

  it('maps a parented, project-less issue node', async () => {
    stubFetch([
      projectsPayload(),
      {
        data: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'iss-child',
                title: 'Child',
                state: { name: 'Todo', type: 'unstarted' },
                labels: { nodes: [] },
                parent: { id: 'iss-parent' },
                project: null,
                relations: { nodes: [] },
              },
            ],
          },
        },
      },
    ]);
    const data = await createRealLinearClient('lin_key').fetchRoadmap('HUS');
    expect(data.issues[0]?.parentId).toBe('iss-parent');
    expect(data.issues[0]?.projectId).toBeNull();
    expect(data.issues[0]?.labelNames).toEqual([]);
  });

  it('keeps a short error body untruncated in the LinearApiError message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('short failure', { status: 503 })))
    );
    await expect(createRealLinearClient('lin_key').fetchRoadmap('HUS')).rejects.toThrow(
      /short failure$/
    );
  });

  it('throws on a schema-mismatched payload', async () => {
    stubFetch([{ data: { nope: true } }]);
    await expect(createRealLinearClient('lin_key').fetchRoadmap('HUS')).rejects.toThrow();
  });
});
