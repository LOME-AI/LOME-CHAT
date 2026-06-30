import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusSection, type ProjectWithTasks } from './StatusSection';
import type { RoadmapNode } from '@hushbox/shared';
import type { FilterStatus, FilterType } from './use-filter-state';

const allTypes = new Set<FilterType>(['feature', 'bug']);

function makeProject(overrides: Partial<RoadmapNode> = {}): RoadmapNode {
  return {
    id: '000000000099',
    kind: 'project',
    parentId: null,
    title: 'A project',
    status: 'in_progress',
    type: null,
    progress: { done: 0, total: 0 },
    ...overrides,
  };
}

describe('StatusSection', () => {
  it('renders the banner with the status label and count', () => {
    const projects: ProjectWithTasks[] = [
      { project: makeProject({ id: 'a00000000001', title: 'A' }), tasks: [] },
      { project: makeProject({ id: 'a00000000002', title: 'B' }), tasks: [] },
    ];
    render(<StatusSection status="in_progress" projects={projects} activeTypes={allTypes} />);
    expect(screen.getByRole('heading', { name: /Shipping now/i })).toBeInTheDocument();
    expect(screen.getByText('2 items')).toBeInTheDocument();
  });

  it('renders the singular "1 item" label when there is one project', () => {
    const projects: ProjectWithTasks[] = [
      { project: makeProject({ id: 'a00000000001', title: 'A' }), tasks: [] },
    ];
    render(<StatusSection status="in_progress" projects={projects} activeTypes={allTypes} />);
    expect(screen.getByText('1 item')).toBeInTheDocument();
  });

  it.each<[FilterStatus, string]>([
    ['in_progress', 'Shipping now'],
    ['planned', 'Up next'],
    ['shipped', 'Shipped'],
  ])('uses the right label for status %s', (status, label) => {
    const projects: ProjectWithTasks[] = [
      { project: makeProject({ id: 'a00000000001' }), tasks: [] },
    ];
    render(<StatusSection status={status} projects={projects} activeTypes={allTypes} />);
    expect(screen.getByRole('heading', { name: new RegExp(label, 'i') })).toBeInTheDocument();
  });

  it('renders one ProjectCard per project', () => {
    const projects: ProjectWithTasks[] = [
      { project: makeProject({ id: 'a00000000001', title: 'A' }), tasks: [] },
      { project: makeProject({ id: 'a00000000002', title: 'B' }), tasks: [] },
    ];
    render(<StatusSection status="in_progress" projects={projects} activeTypes={allTypes} />);
    expect(screen.getByRole('heading', { name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'B' })).toBeInTheDocument();
  });

  it('returns null when there are no projects in this status', () => {
    const { container } = render(
      <StatusSection status="in_progress" projects={[]} activeTypes={allTypes} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('tags the section with data-status for E2E selectors', () => {
    const projects: ProjectWithTasks[] = [
      { project: makeProject({ id: 'a00000000001' }), tasks: [] },
    ];
    const { container } = render(
      <StatusSection status="planned" projects={projects} activeTypes={allTypes} />
    );
    const section = container.querySelector('section');
    expect(section).toHaveAttribute('data-status', 'planned');
  });
});
