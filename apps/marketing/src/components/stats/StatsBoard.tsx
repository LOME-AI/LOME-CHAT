import * as React from 'react';
import { cn } from '@hushbox/ui';
import { publicUsageStatsSchema } from '@hushbox/shared';
import { usePublicQuery } from '../../lib/use-public-query';
import {
  availableModalities,
  availableWindows,
  dotPlotPositions,
  rankModels,
  selectView,
  trendSeries,
  xAxisLabels,
} from './compute-stats';
import { placeholderStats } from './placeholder-data';
import { TrendChart } from './TrendChart';
import { RankedList } from './RankedList';
import { CostCard } from './CostCard';
import { CostDotPlot } from './CostDotPlot';
import type { Modality, UsageStatsWindow, UsageStatsWindowKey } from '@hushbox/shared';

function modalityLabel(modality: Modality): string {
  return modality.charAt(0).toUpperCase() + modality.slice(1);
}

function windowLabel(window: UsageStatsWindow): string {
  return window.days === null ? 'All time' : `${String(window.days)} days`;
}

/**
 * Top-level React island for the public stats page. Owns the API query and
 * the modality/window selection; everything below is presentational. The
 * loading state renders the same tree against a placeholder dataset wrapped
 * in `data-skeleton` + `inert` (the roadmap island's ghost-UI convention).
 * Selection is resolved through `selectView`, so a selection invalidated by
 * the loaded payload falls back instead of crashing.
 *
 * E2E state signals (names registered in `TEST_SIGNALS`): once the fetch has
 * resolved, either branch carries `data-stats-settled="true"`; only the
 * loaded-with-data wrapper also carries `data-stats-ready`. The loading
 * skeleton carries neither, so tests can distinguish not-yet-loaded,
 * loaded-unavailable, and loaded-with-data.
 */
export function StatsBoard(): React.JSX.Element {
  const { data, error, isLoading } = usePublicQuery(
    '/public/stats',
    publicUsageStatsSchema,
    'stats'
  );
  const [selectedModality, setSelectedModality] = React.useState<Modality | null>(null);
  const [selectedWindow, setSelectedWindow] = React.useState<UsageStatsWindowKey | null>(null);

  const effectiveData = isLoading ? placeholderStats : data;
  const view =
    effectiveData === null ? null : selectView(effectiveData, selectedModality, selectedWindow);

  if (error !== null || effectiveData === null || view === null) {
    return <StatsUnavailable />;
  }

  const modalities = availableModalities(effectiveData);
  const windows = availableWindows(effectiveData, view.modality);
  const ranked = rankModels(view.stats);
  const bands = trendSeries(view.stats.trend, ranked, view.stats.others.sharePercent);
  const axis = xAxisLabels(view.window, view.stats.trend);

  const body = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div role="group" aria-label="Modality" className="flex flex-wrap items-center gap-2">
          {modalities.map((modality) => (
            <SelectorButton
              key={modality}
              active={modality === view.modality}
              label={modalityLabel(modality)}
              onClick={() => {
                setSelectedModality(modality);
              }}
            />
          ))}
        </div>
        <div role="group" aria-label="Window" className="flex flex-wrap items-center gap-2">
          {windows.map((window) => (
            <SelectorButton
              key={window.key}
              active={window.key === view.window.key}
              label={windowLabel(window)}
              onClick={() => {
                setSelectedWindow(window.key);
              }}
            />
          ))}
        </div>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-foreground text-xl font-semibold">Model share</h2>
        <TrendChart
          bands={bands}
          axis={axis}
          ariaLabel={`Model share for ${modalityLabel(view.modality)}, ${windowLabel(view.window).toLowerCase()}, as a stacked area chart. The ranking below carries the same data.`}
        />
        <RankedList models={ranked} others={view.stats.others} showDelta={view.window.hasDelta} />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-foreground text-xl font-semibold">Cost per message</h2>
        <CostCard cost={view.stats.cost} />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-foreground text-xl font-semibold">Cost by model</h2>
          <span className="text-muted-foreground text-sm">average per message</span>
        </div>
        <CostDotPlot entries={dotPlotPositions(ranked)} />
      </section>
    </>
  );

  if (isLoading) {
    return (
      <div
        className="flex flex-col gap-10"
        data-skeleton
        inert
        role="status"
        aria-label="Loading stats"
        aria-busy={true}
      >
        {body}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10" data-stats-settled="true" data-stats-ready>
      {body}
    </div>
  );
}

interface SelectorButtonProps {
  readonly active: boolean;
  readonly label: string;
  readonly onClick: () => void;
}

function SelectorButton({ active, label, onClick }: SelectorButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        // Focus treatment mirrors the shared button primitive's ring recipe so
        // keyboard focus matches the design system.
        'focus-visible:border-ring focus-visible:ring-ring/50 inline-flex cursor-pointer items-center rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px]',
        active
          ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border-border bg-background text-muted-foreground hover:bg-background-subtle hover:text-foreground'
      )}
    >
      {label}
    </button>
  );
}

function StatsUnavailable(): React.JSX.Element {
  return (
    <div
      role="alert"
      data-stats-settled="true"
      className="border-border bg-background rounded-md border p-6 text-center"
    >
      <p className="text-muted-foreground text-sm">Stats are unavailable right now.</p>
    </div>
  );
}
