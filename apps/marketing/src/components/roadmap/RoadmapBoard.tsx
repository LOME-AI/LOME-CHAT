import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { roadmapResponseSchema } from '@hushbox/shared';
import { usePublicQuery } from '../../lib/use-public-query';
import { useFilterState, type FilterStatus } from './use-filter-state';
import { computeBoard } from './compute-board';
import { FilterChips } from './FilterChips';
import { StatusSection } from './StatusSection';
import { EmptyState } from './EmptyState';
import { placeholderRoadmap } from './placeholder-data';

const STATUS_ORDER: readonly FilterStatus[] = ['in_progress', 'planned', 'shipped'];

/**
 * Top-level React island for the public roadmap page. Owns the API query
 * and the filter state; everything below is presentational. During loading
 * the same component tree renders against a placeholder dataset wrapped in
 * `data-skeleton` + `inert`; a global CSS rule masks the text into shimmer
 * bars (see `src/styles/global.css`). Rendering the real tree as the
 * skeleton means a future layout change to {@link ProjectCard} or
 * {@link FilterChips} cannot drift away from what the skeleton displays.
 */
export function RoadmapBoard(): React.JSX.Element {
  const { data, error, isLoading } = usePublicQuery(
    '/public/roadmap',
    roadmapResponseSchema,
    'roadmap'
  );
  const { statuses, types, toggleStatus, toggleType, reset } = useFilterState();

  const effectiveData = isLoading ? placeholderRoadmap : data;
  const board = React.useMemo(
    () => (effectiveData === null ? null : computeBoard(effectiveData.nodes)),
    [effectiveData]
  );

  if (error !== null || board === null) {
    return <BoardError />;
  }

  const visibleSections = STATUS_ORDER.filter((status) => statuses.has(status));
  const visibleCount = visibleSections.reduce(
    (sum, status) => sum + board.byStatus[status].length,
    0
  );

  const body = (
    <>
      <FilterChips
        statuses={statuses}
        types={types}
        statusCounts={board.statusCounts}
        typeCounts={board.typeCounts}
        onToggleStatus={toggleStatus}
        onToggleType={toggleType}
      />
      {visibleCount === 0 ? (
        <EmptyState onReset={reset} />
      ) : (
        visibleSections.map((status) => (
          <StatusSection
            key={status}
            status={status}
            projects={board.byStatus[status]}
            activeTypes={types}
          />
        ))
      )}
    </>
  );

  if (isLoading) {
    return (
      <div
        className="flex flex-col gap-8"
        data-testid={TEST_IDS.roadmapLoading}
        data-skeleton
        inert
        role="status"
        aria-label="Loading roadmap"
        aria-busy={true}
      >
        {body}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8" data-roadmap-ready>
      {body}
    </div>
  );
}

function BoardError(): React.JSX.Element {
  return (
    <div role="alert" className="border-border bg-background rounded-md border p-6 text-center">
      <p className="text-muted-foreground text-sm">
        The roadmap is temporarily unavailable. Please try again shortly.
      </p>
    </div>
  );
}
