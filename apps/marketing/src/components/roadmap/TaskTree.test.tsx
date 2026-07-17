import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskTree, type TaskWithSubtasks } from './TaskTree';
import type { RoadmapNode } from '@hushbox/shared';
import type { FilterType } from './use-filter-state';

const allTypes = new Set<FilterType>(['feature', 'bug']);

function makeTask(overrides: Partial<RoadmapNode> = {}): RoadmapNode {
  return {
    id: '000000000001',
    kind: 'task',
    parentId: '000000000099',
    title: 'A task',
    status: 'in_progress',
    type: 'feature',
    ...overrides,
  };
}

function makeSubtask(overrides: Partial<RoadmapNode>): RoadmapNode {
  return makeTask({ kind: 'subtask', ...overrides });
}

describe('TaskTree', () => {
  it('renders one row per task with its title', () => {
    const tasks: TaskWithSubtasks[] = [
      { task: makeTask({ id: 'a00000000001', title: 'Schema design' }), subtasks: [] },
      { task: makeTask({ id: 'a00000000002', title: 'Settings UI' }), subtasks: [] },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('Schema design')).toBeInTheDocument();
    expect(screen.getByText('Settings UI')).toBeInTheDocument();
  });

  it('renders subtasks under their parent task', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Cross-device sync' }),
        subtasks: [
          makeSubtask({
            id: 'b00000000001',
            parentId: 'a00000000001',
            title: 'Conflict resolution',
          }),
          makeSubtask({
            id: 'b00000000002',
            parentId: 'a00000000001',
            title: 'Migration backfill',
          }),
        ],
      },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('Cross-device sync')).toBeInTheDocument();
    expect(screen.getByText('Conflict resolution')).toBeInTheDocument();
    expect(screen.getByText('Migration backfill')).toBeInTheDocument();
  });

  it('hides tasks whose type is not in activeTypes', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Schema feature', type: 'feature' }),
        subtasks: [],
      },
      { task: makeTask({ id: 'a00000000002', title: 'Schema bug', type: 'bug' }), subtasks: [] },
    ];
    render(<TaskTree tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />);
    expect(screen.getByText('Schema feature')).toBeInTheDocument();
    expect(screen.queryByText('Schema bug')).not.toBeInTheDocument();
  });

  it('hides a subtask whose type is not in activeTypes (parent visible)', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Cross-device sync', type: 'feature' }),
        subtasks: [
          makeSubtask({
            id: 'b00000000001',
            parentId: 'a00000000001',
            title: 'Migration bug',
            type: 'bug',
          }),
        ],
      },
    ];
    render(<TaskTree tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />);
    expect(screen.getByText('Cross-device sync')).toBeInTheDocument();
    expect(screen.queryByText('Migration bug')).not.toBeInTheDocument();
  });

  it('hides subtasks when their parent task is hidden (hierarchy wins)', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'A bug task', type: 'bug' }),
        subtasks: [
          makeSubtask({
            id: 'b00000000001',
            parentId: 'a00000000001',
            title: 'Feature subtask',
            type: 'feature',
          }),
        ],
      },
    ];
    render(<TaskTree tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />);
    expect(screen.queryByText('A bug task')).not.toBeInTheDocument();
    expect(screen.queryByText('Feature subtask')).not.toBeInTheDocument();
  });

  it('shows a status icon for each visible task', () => {
    const tasks: TaskWithSubtasks[] = [
      { task: makeTask({ id: 'a00000000001', title: 'Done', status: 'shipped' }), subtasks: [] },
      { task: makeTask({ id: 'a00000000002', title: 'WIP', status: 'in_progress' }), subtasks: [] },
      { task: makeTask({ id: 'a00000000003', title: 'Plan', status: 'planned' }), subtasks: [] },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('Done').closest('li')).toHaveAttribute('data-status', 'shipped');
    expect(screen.getByText('WIP').closest('li')).toHaveAttribute('data-status', 'in_progress');
    expect(screen.getByText('Plan').closest('li')).toHaveAttribute('data-status', 'planned');
  });

  it('marks tasks with their type via data-type', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'A feature task', type: 'feature' }),
        subtasks: [],
      },
      { task: makeTask({ id: 'a00000000002', title: 'A bug task', type: 'bug' }), subtasks: [] },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('A feature task').closest('li')).toHaveAttribute(
      'data-type',
      'feature'
    );
    expect(screen.getByText('A bug task').closest('li')).toHaveAttribute('data-type', 'bug');
  });

  it('renders subtask rows with data-kind="subtask" for styling', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Parent' }),
        subtasks: [makeSubtask({ id: 'b00000000001', parentId: 'a00000000001', title: 'Child' })],
      },
    ];
    render(<TaskTree tasks={tasks} activeTypes={allTypes} />);
    expect(screen.getByText('Parent').closest('li')).toHaveAttribute('data-kind', 'task');
    expect(screen.getByText('Child').closest('li')).toHaveAttribute('data-kind', 'subtask');
  });

  it('always shows a typeless task and renders no type badge for it', () => {
    const tasks: TaskWithSubtasks[] = [
      {
        task: makeTask({ id: 'a00000000001', title: 'Untyped milestone', type: null }),
        subtasks: [],
      },
    ];
    render(<TaskTree tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />);
    const row = screen.getByText('Untyped milestone').closest('li');
    // A null-type node bypasses the type filter (hierarchy/section headers
    // stay visible) and carries no data-type / badge.
    expect(row).toBeInTheDocument();
    expect(row).not.toHaveAttribute('data-type');
    expect(screen.queryByText('Feature')).not.toBeInTheDocument();
    expect(screen.queryByText('Bug')).not.toBeInTheDocument();
  });

  it('renders an empty list element when every task is filtered out', () => {
    const tasks: TaskWithSubtasks[] = [
      { task: makeTask({ id: 'a00000000001', title: 'Bug-only', type: 'bug' }), subtasks: [] },
    ];
    const { container } = render(
      <TaskTree tasks={tasks} activeTypes={new Set<FilterType>(['feature'])} />
    );
    // The component renders no <li> elements when nothing is visible.
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });
});
