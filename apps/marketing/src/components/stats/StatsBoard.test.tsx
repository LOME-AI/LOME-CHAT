import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublicUsageStats, UsageStatsWindowStats } from '@hushbox/shared';
import { StatsBoard } from './StatsBoard';

function windowStats(overrides: Partial<UsageStatsWindowStats> = {}): UsageStatsWindowStats {
  return {
    models: [
      {
        modelId: 'a/one',
        displayName: 'One',
        provider: 'a',
        sharePercent: 60,
        deltaPoints: 2.1,
        avgCostUsd: '0.01',
      },
      {
        modelId: 'b/two',
        displayName: 'Two',
        provider: 'b',
        sharePercent: 30,
        deltaPoints: -0.4,
        avgCostUsd: '0.002',
      },
    ],
    others: { sharePercent: 10, deltaPoints: 0.2 },
    trend: {
      bucket: 'day',
      points: [
        {
          start: '2026-06-01',
          models: [
            { modelId: 'a/one', sharePercent: 60 },
            { modelId: 'b/two', sharePercent: 30 },
          ],
          othersSharePercent: 10,
        },
        {
          start: '2026-06-02',
          models: [
            { modelId: 'a/one', sharePercent: 55 },
            { modelId: 'b/two', sharePercent: 35 },
          ],
          othersSharePercent: 10,
        },
      ],
    },
    cost: { avgUsd: '0.0051', medianUsd: '0.003', p90Usd: '0.02' },
    ...overrides,
  };
}

const RESPONSE: PublicUsageStats = {
  schemaVersion: 1,
  generatedAt: '2026-07-01T00:00:00Z',
  modalities: {
    text: { '7d': windowStats(), '30d': windowStats(), all: windowStats() },
    video: {
      all: windowStats({
        models: [
          {
            modelId: 'v/vid',
            displayName: 'Vid',
            provider: 'v',
            sharePercent: 100,
            deltaPoints: null,
            avgCostUsd: '0.5',
          },
        ],
        others: { sharePercent: 0, deltaPoints: null },
        trend: {
          bucket: 'month',
          points: [
            {
              start: '2026-06-01',
              models: [{ modelId: 'v/vid', sharePercent: 100 }],
              othersSharePercent: 0,
            },
          ],
        },
      }),
    },
  },
};

function stubFetch(payload: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok, status, json: () => Promise.resolve(payload) }))
  );
}

async function renderLoaded(): Promise<void> {
  render(<StatsBoard />);
  await waitFor(() => {
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
}

describe('StatsBoard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not emit the settled or ready signal while the fetch is in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
    const { container } = render(<StatsBoard />);
    expect(container.querySelector('[data-stats-settled]')).toBeNull();
    expect(container.querySelector('[data-stats-ready]')).toBeNull();
  });

  it('marks the loaded board settled and ready', async () => {
    stubFetch(RESPONSE);
    const { container } = render(<StatsBoard />);
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
    const settled = container.querySelector('[data-stats-settled="true"]');
    expect(settled).not.toBeNull();
    expect(settled).toHaveAttribute('data-stats-ready');
  });

  it('marks the unavailable state settled but not ready', async () => {
    stubFetch({}, false, 503);
    const { container } = render(<StatsBoard />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveAttribute('data-stats-settled', 'true');
    expect(container.querySelector('[data-stats-ready]')).toBeNull();
  });

  it('renders an inert ghost skeleton while the fetch is in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
    render(<StatsBoard />);
    const skeleton = screen.getByRole('status', { name: 'Loading stats' });
    expect(skeleton).toHaveAttribute('data-skeleton');
    expect(skeleton).toHaveAttribute('inert');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the unavailable state on a fetch failure', async () => {
    stubFetch({}, false, 503);
    render(<StatsBoard />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText('Stats are unavailable right now.')).toBeInTheDocument();
  });

  it('renders the unavailable state when the payload has no modalities', async () => {
    stubFetch({ schemaVersion: 1, generatedAt: '2026-07-01T00:00:00Z', modalities: {} });
    render(<StatsBoard />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  it('renders modality tabs only for modalities present in the payload', async () => {
    stubFetch(RESPONSE);
    await renderLoaded();
    const tabs = screen.getByRole('group', { name: 'Modality' });
    expect(within(tabs).getByRole('button', { name: 'Text' })).toBeInTheDocument();
    expect(within(tabs).getByRole('button', { name: 'Video' })).toBeInTheDocument();
    expect(within(tabs).queryByRole('button', { name: 'Image' })).not.toBeInTheDocument();
  });

  it('defaults to the first modality and the 30 day window', async () => {
    stubFetch(RESPONSE);
    await renderLoaded();
    const tabs = screen.getByRole('group', { name: 'Modality' });
    expect(within(tabs).getByRole('button', { name: 'Text' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const pills = screen.getByRole('group', { name: 'Window' });
    expect(within(pills).getByRole('button', { name: '30 days' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('renders the chart, ranked list, cost card and dot plot for the selected view', async () => {
    stubFetch(RESPONSE);
    await renderLoaded();
    expect(screen.getByRole('img', { name: /Model share/ })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Model share ranking' })).toBeInTheDocument();
    expect(screen.getByText('average cost per message')).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Average cost per model, log scale' })
    ).toBeInTheDocument();
  });

  it('annotates the cost-by-model header with the per-message basis on the same line', async () => {
    stubFetch(RESPONSE);
    await renderLoaded();
    const heading = screen.getByRole('heading', { name: 'Cost by model' });
    const annotation = screen.getByText('average per message');
    expect(annotation.parentElement).toBe(heading.parentElement);
  });

  it('shows delta badges for a windowed view', async () => {
    stubFetch(RESPONSE);
    await renderLoaded();
    expect(screen.getByText('+2.1')).toBeInTheDocument();
  });

  it('switches windows and suppresses deltas on the all-time window', async () => {
    stubFetch(RESPONSE);
    await renderLoaded();
    const pills = screen.getByRole('group', { name: 'Window' });
    await userEvent.click(within(pills).getByRole('button', { name: 'All time' }));
    expect(within(pills).getByRole('button', { name: 'All time' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.queryByText('+2.1')).not.toBeInTheDocument();
  });

  it('applies the shared focus ring treatment to selector buttons', async () => {
    stubFetch(RESPONSE);
    await renderLoaded();
    const tabs = screen.getByRole('group', { name: 'Modality' });
    const button = within(tabs).getByRole('button', { name: 'Text' });
    expect(button).toHaveClass(
      'outline-none',
      'focus-visible:border-ring',
      'focus-visible:ring-ring/50',
      'focus-visible:ring-[3px]'
    );
  });

  it('shows the trend placeholder for a single-point trend', async () => {
    stubFetch(RESPONSE);
    await renderLoaded();
    const tabs = screen.getByRole('group', { name: 'Modality' });
    await userEvent.click(within(tabs).getByRole('button', { name: 'Video' }));
    expect(screen.getByText('Not enough data yet')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Model share/ })).not.toBeInTheDocument();
  });

  it('omits a zero-share Others row from the ranking', async () => {
    stubFetch(RESPONSE);
    await renderLoaded();
    const tabs = screen.getByRole('group', { name: 'Modality' });
    await userEvent.click(within(tabs).getByRole('button', { name: 'Video' }));
    const ranking = screen.getByRole('list', { name: 'Model share ranking' });
    expect(within(ranking).queryByText('Others')).not.toBeInTheDocument();
  });

  it('falls back to an available window when switching to a modality without the selected one', async () => {
    stubFetch(RESPONSE);
    await renderLoaded();
    const tabs = screen.getByRole('group', { name: 'Modality' });
    await userEvent.click(within(tabs).getByRole('button', { name: 'Video' }));
    const pills = screen.getByRole('group', { name: 'Window' });
    expect(within(pills).getByRole('button', { name: 'All time' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(pills).queryByRole('button', { name: '30 days' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Model share ranking' })).toBeInTheDocument();
    expect(screen.getAllByText('Vid').length).toBeGreaterThan(0);
  });

  it('fetches the /public/stats endpoint', async () => {
    let requestedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        requestedUrl = String(url);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(RESPONSE) });
      })
    );
    await renderLoaded();
    expect(requestedUrl).toContain('/public/stats');
  });
});
