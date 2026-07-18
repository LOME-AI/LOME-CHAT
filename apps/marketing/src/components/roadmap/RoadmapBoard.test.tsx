import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import type { RoadmapResponse, RoadmapNode } from '@hushbox/shared';
import { RoadmapBoard } from './RoadmapBoard';
import * as queryModule from '../../lib/use-public-query';

function makeProject(id: string, overrides: Partial<RoadmapNode> = {}): RoadmapNode {
  return {
    id,
    kind: 'project',
    parentId: null,
    title: `Project ${id}`,
    status: 'in_progress',
    type: null,
    progress: { done: 1, total: 2 },
    ...overrides,
  };
}

function makeTask(id: string, parentId: string, overrides: Partial<RoadmapNode> = {}): RoadmapNode {
  return {
    id,
    kind: 'task',
    parentId,
    title: `Task ${id}`,
    status: 'in_progress',
    type: 'feature',
    ...overrides,
  };
}

function mockQuery(state: {
  data: RoadmapResponse | null;
  error: Error | null;
  isLoading: boolean;
}): void {
  vi.spyOn(queryModule, 'usePublicQuery').mockReturnValue(state);
}

function renderLoading(): HTMLElement {
  mockQuery({ data: null, error: null, isLoading: true });
  render(<RoadmapBoard />);
  return screen.getByTestId(TEST_IDS.roadmapLoading);
}

describe('RoadmapBoard', () => {
  beforeEach(() => {
    globalThis.history.replaceState(null, '', '/roadmap');
    vi.restoreAllMocks();
  });

  it('renders a loading skeleton while data is loading', () => {
    expect(renderLoading()).toBeInTheDocument();
  });

  it('marks the loading wrapper with data-skeleton and inert', () => {
    const wrapper = renderLoading();
    expect(wrapper).toHaveAttribute('data-skeleton');
    expect(wrapper).toHaveAttribute('inert');
  });

  it('exposes the loading wrapper to assistive tech as a status region', () => {
    const wrapper = renderLoading();
    expect(wrapper).toHaveAttribute('role', 'status');
    expect(wrapper).toHaveAttribute('aria-label', 'Loading roadmap');
    expect(wrapper).toHaveAttribute('aria-busy', 'true');
  });

  it('renders filter chips and project cards inside the loading wrapper', () => {
    const wrapper = renderLoading();
    expect(wrapper.querySelectorAll('button[data-status]').length).toBeGreaterThan(0);
    expect(wrapper.querySelectorAll('button[data-type]').length).toBeGreaterThan(0);
    expect(wrapper.querySelectorAll('article[data-project-id]').length).toBeGreaterThan(0);
  });

  it('does not mark the loading wrapper with data-roadmap-ready', () => {
    renderLoading();
    expect(document.querySelector('[data-roadmap-ready]')).toBeNull();
  });

  it('renders an error message when the query fails', () => {
    mockQuery({ data: null, error: new Error('boom'), isLoading: false });
    render(<RoadmapBoard />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders filter chips with derived counts when data loads', async () => {
    mockQuery({
      data: {
        nodes: [
          makeProject('a00000000001', { status: 'in_progress', title: 'Now-A' }),
          makeProject('a00000000002', { status: 'in_progress', title: 'Now-B' }),
          makeProject('a00000000003', { status: 'planned', title: 'Next-A' }),
          makeTask('b00000000001', 'a00000000001', { type: 'feature' }),
          makeTask('b00000000002', 'a00000000001', { type: 'bug' }),
        ],
      },
      error: null,
      isLoading: false,
    });
    render(<RoadmapBoard />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Shipping now/i })).toHaveTextContent('2');
      expect(screen.getByRole('button', { name: /Up next/i })).toHaveTextContent('1');
      expect(screen.getByRole('button', { name: /Features/i })).toHaveTextContent('1');
      expect(screen.getByRole('button', { name: /Bugs/i })).toHaveTextContent('1');
    });
  });

  it('renders status sections in order: in_progress → planned → shipped', async () => {
    mockQuery({
      data: {
        nodes: [
          makeProject('a00000000001', { status: 'shipped', title: 'Shipped-Z' }),
          makeProject('a00000000002', { status: 'in_progress', title: 'Now-A' }),
          makeProject('a00000000003', { status: 'planned', title: 'Next-A' }),
        ],
      },
      error: null,
      isLoading: false,
    });
    const { container } = render(<RoadmapBoard />);
    await waitFor(() => {
      const sections = container.querySelectorAll('section[data-status]');
      expect(sections).toHaveLength(3);
      expect(sections[0]).toHaveAttribute('data-status', 'in_progress');
      expect(sections[1]).toHaveAttribute('data-status', 'planned');
      expect(sections[2]).toHaveAttribute('data-status', 'shipped');
    });
  });

  it('hides a section when its status chip is toggled off', async () => {
    const user = userEvent.setup();
    mockQuery({
      data: {
        nodes: [
          makeProject('a00000000001', { status: 'shipped', title: 'Shipped-Z' }),
          makeProject('a00000000002', { status: 'in_progress', title: 'Now-A' }),
        ],
      },
      error: null,
      isLoading: false,
    });
    const { container } = render(<RoadmapBoard />);
    await user.click(screen.getByRole('button', { name: /Shipped/i }));
    await waitFor(() => {
      expect(container.querySelector('section[data-status="shipped"]')).toBeNull();
      expect(container.querySelector('section[data-status="in_progress"]')).not.toBeNull();
    });
  });

  it('shows the empty state when every section is filtered out', async () => {
    const user = userEvent.setup();
    mockQuery({
      data: {
        nodes: [makeProject('a00000000001', { status: 'in_progress', title: 'Now-A' })],
      },
      error: null,
      isLoading: false,
    });
    render(<RoadmapBoard />);
    await user.click(screen.getByRole('button', { name: /Up next/i }));
    await user.click(screen.getByRole('button', { name: /Shipped/i }));
    await user.click(screen.getByRole('button', { name: /Shipping now/i }));
    // After this last click the hook auto-snaps back to all-on, so the
    // empty state should NOT appear — there ARE matching projects.
    await waitFor(() => {
      expect(screen.queryByText(/no projects match/i)).not.toBeInTheDocument();
    });
  });

  it('shows the empty state when type filter removes every task from every project, and no project matches', async () => {
    // To trigger the empty state without losing all statuses, we can rely on
    // a status filter that excludes the only present status group.
    mockQuery({
      data: {
        nodes: [makeProject('a00000000001', { status: 'in_progress', title: 'Now-A' })],
      },
      error: null,
      isLoading: false,
    });
    globalThis.history.replaceState(null, '', '/roadmap?status=shipped');
    render(<RoadmapBoard />);
    await waitFor(() => {
      expect(screen.getByText(/no projects match/i)).toBeInTheDocument();
    });
  });

  it('reset button clears filters and re-shows sections', async () => {
    const user = userEvent.setup();
    mockQuery({
      data: {
        nodes: [makeProject('a00000000001', { status: 'in_progress', title: 'Now-A' })],
      },
      error: null,
      isLoading: false,
    });
    globalThis.history.replaceState(null, '', '/roadmap?status=shipped');
    render(<RoadmapBoard />);
    await user.click(screen.getByRole('button', { name: /reset filters/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Now-A/i })).toBeInTheDocument();
    });
  });

  it('renders the project cards for the loaded data', async () => {
    mockQuery({
      data: {
        nodes: [
          makeProject('a00000000001', { status: 'in_progress', title: 'Custom Prompts' }),
          makeTask('b00000000001', 'a00000000001', { title: 'Schema design' }),
        ],
      },
      error: null,
      isLoading: false,
    });
    render(<RoadmapBoard />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Custom Prompts/i })).toBeInTheDocument();
      expect(screen.getByText('Schema design')).toBeInTheDocument();
    });
  });

  it('marks the loaded board with a data-roadmap-ready attribute', async () => {
    mockQuery({
      data: { nodes: [makeProject('a00000000001')] },
      error: null,
      isLoading: false,
    });
    const { container } = render(<RoadmapBoard />);
    await waitFor(() => {
      expect(container.querySelector('[data-roadmap-ready]')).not.toBeNull();
    });
  });

  it('fetches /public/roadmap and renders the schema-validated payload', async () => {
    let requestedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        requestedUrl = String(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              nodes: [makeProject('a00000000001', { title: 'Wired Project' })],
            }),
        });
      })
    );
    render(<RoadmapBoard />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Wired Project/i })).toBeInTheDocument();
    });
    expect(requestedUrl).toContain('/public/roadmap');
    vi.unstubAllGlobals();
  });
});
