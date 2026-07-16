import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { SpendingByConversationChart } from './spending-by-conversation-chart';
import type { SpendingByConversationResponse } from '@hushbox/shared';

// Capture the props of the tooltip element the chart wires into recharts.
// recharts' <Tooltip> never renders its `content` in jsdom (no hover), so we
// assert the wiring (nameKey) here and exercise the resolution separately.
const tooltipElements: Record<string, unknown>[] = [];
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    ChartTooltipContent: (props: Record<string, unknown>) => {
      tooltipElements.push(props);
      return actual.ChartTooltipContent(props);
    },
  };
});

// Recharts renders the tooltip via its own internal pipeline and never invokes
// a custom `content` component in jsdom (no hover). To observe the wired props,
// render the chart's children directly: ResponsiveContainer passes dimensions,
// PieChart/Pie become plain passthroughs, and the active Tooltip renders its
// `content` with a pie-shaped payload (numeric `value` dataKey, slice `name`).
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 800, height: 300 }}>{children}</div>
    ),
    PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Pie: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Cell: () => null,
    Legend: () => null,
    Tooltip: ({
      content,
    }: {
      content: React.ReactElement<Record<string, unknown>>;
    }): React.ReactElement =>
      React.cloneElement(content, {
        active: true,
        payload: [
          {
            name: 'Tax planning chat',
            dataKey: 'value',
            value: 1.5,
            payload: { name: 'Tax planning chat' },
          },
        ],
      }),
  };
});

function makeData(
  rows: { conversationId: string; totalSpent: string }[]
): SpendingByConversationResponse {
  return { data: rows };
}

const SAMPLE_DATA = makeData([
  { conversationId: 'conv-aaaaaa', totalSpent: '1.50' },
  { conversationId: 'conv-bbbbbb', totalSpent: '0.75' },
]);

const TITLES = [
  { id: 'conv-aaaaaa', title: 'Tax planning chat' },
  { id: 'conv-bbbbbb', title: 'Dinner recipes' },
];

describe('SpendingByConversationChart', () => {
  describe('loading state', () => {
    it('renders skeleton when loading', () => {
      render(<SpendingByConversationChart data={undefined} isLoading={true} />);
      expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('renders empty message when data is undefined', () => {
      render(<SpendingByConversationChart data={undefined} isLoading={false} />);
      expect(screen.getByText('No conversation data')).toBeInTheDocument();
    });

    it('renders empty message when data array is empty', () => {
      render(<SpendingByConversationChart data={makeData([])} isLoading={false} />);
      expect(screen.getByText('No conversation data')).toBeInTheDocument();
    });
  });

  describe('chart rendering', () => {
    it('renders chart card with correct testid', () => {
      render(
        <SpendingByConversationChart
          data={SAMPLE_DATA}
          isLoading={false}
          conversationTitles={TITLES}
        />
      );
      expect(screen.getByTestId(TEST_IDS.spendingByConversationChart)).toBeInTheDocument();
    });
  });

  describe('tooltip names', () => {
    it('wires the tooltip to resolve slice names instead of the value dataKey', () => {
      tooltipElements.length = 0;
      render(
        <SpendingByConversationChart
          data={SAMPLE_DATA}
          isLoading={false}
          conversationTitles={TITLES}
        />
      );
      expect(tooltipElements.at(-1)).toMatchObject({ nameKey: 'name' });
    });

    it('shows the conversation title for a pie slice, not the literal "value"', () => {
      render(
        <SpendingByConversationChart
          data={SAMPLE_DATA}
          isLoading={false}
          conversationTitles={TITLES}
        />
      );
      // The title appears in both the visually-hidden data table (<th>) and the
      // tooltip; assert the tooltip occurrence specifically renders in a <span>.
      const tooltipLabel = screen
        .getAllByText('Tax planning chat')
        .find((el) => el.tagName === 'SPAN');
      expect(tooltipLabel).toBeInTheDocument();
      expect(screen.queryByText('value')).not.toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('exposes the chart as an image region with an accessible name', () => {
      render(
        <SpendingByConversationChart
          data={SAMPLE_DATA}
          isLoading={false}
          conversationTitles={TITLES}
        />
      );
      expect(screen.getByRole('img', { name: /Top Conversations/i })).toBeInTheDocument();
    });

    it('renders a data-table alternative naming each conversation and its spend', () => {
      render(
        <SpendingByConversationChart
          data={SAMPLE_DATA}
          isLoading={false}
          conversationTitles={TITLES}
        />
      );
      const table = screen.getByRole('table', { hidden: true });
      expect(table.closest('.sr-only')).not.toBeNull();
      expect(
        screen.getByRole('rowheader', { name: 'Tax planning chat', hidden: true })
      ).toBeInTheDocument();
      expect(screen.getByRole('cell', { name: '$0.7500', hidden: true })).toBeInTheDocument();
    });
  });

  describe('conversation label resolution', () => {
    it('falls back to a conv- id label when no titles are provided', () => {
      // No conversationTitles: titleMap is empty and every title is undefined.
      render(<SpendingByConversationChart data={SAMPLE_DATA} isLoading={false} />);

      expect(
        screen.getByRole('rowheader', { name: 'conv-aaaaaa', hidden: true })
      ).toBeInTheDocument();
    });

    it('uses a conv- id label for placeholder titles', () => {
      render(
        <SpendingByConversationChart
          data={makeData([{ conversationId: 'conv-cccccc', totalSpent: '2.00' }])}
          isLoading={false}
          conversationTitles={[{ id: 'conv-cccccc', title: 'Decrypting...' }]}
        />
      );

      expect(
        screen.getByRole('rowheader', { name: 'conv-cccccc', hidden: true })
      ).toBeInTheDocument();
    });

    it('uses a conv- id label for the encrypted-conversation placeholder', () => {
      render(
        <SpendingByConversationChart
          data={makeData([{ conversationId: 'conv-dddddd', totalSpent: '2.00' }])}
          isLoading={false}
          conversationTitles={[{ id: 'conv-dddddd', title: 'Encrypted conversation' }]}
        />
      );

      expect(
        screen.getByRole('rowheader', { name: 'conv-dddddd', hidden: true })
      ).toBeInTheDocument();
    });

    it('truncates titles longer than 24 characters', () => {
      render(
        <SpendingByConversationChart
          data={makeData([{ conversationId: 'conv-eeeeee', totalSpent: '2.00' }])}
          isLoading={false}
          conversationTitles={[
            { id: 'conv-eeeeee', title: 'A very long conversation title beyond the limit' },
          ]}
        />
      );

      expect(
        screen.getByRole('rowheader', { name: 'A very long conversation...', hidden: true })
      ).toBeInTheDocument();
    });

    it('renders a singular aria label for a single conversation', () => {
      render(
        <SpendingByConversationChart
          data={makeData([{ conversationId: 'conv-ffffff', totalSpent: '2.00' }])}
          isLoading={false}
        />
      );

      expect(screen.getByLabelText(/1 top conversation\./)).toBeInTheDocument();
    });
  });
});
