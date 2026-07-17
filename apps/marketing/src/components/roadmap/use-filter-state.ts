import * as React from 'react';

export type FilterStatus = 'in_progress' | 'planned' | 'shipped';
export type FilterType = 'feature' | 'bug';

const ALL_STATUSES: readonly FilterStatus[] = ['in_progress', 'planned', 'shipped'];
const ALL_TYPES: readonly FilterType[] = ['feature', 'bug'];

export interface FilterState {
  statuses: ReadonlySet<FilterStatus>;
  types: ReadonlySet<FilterType>;
  toggleStatus: (status: FilterStatus) => void;
  toggleType: (type: FilterType) => void;
  reset: () => void;
  isDefault: boolean;
}

function readInitialFromUrl<T extends string>(key: string, allowed: readonly T[]): ReadonlySet<T> {
  /* v8 ignore next -- SSR guard: window is undefined during Astro SSG (this runs in the island's initial server render); jsdom always defines window, so the branch is unreachable under vitest (React DOM itself cannot render without window). */
  if ((globalThis as { window?: Window }).window === undefined) return new Set(allowed);
  const raw = new URLSearchParams(globalThis.location.search).get(key);
  if (raw === null) return new Set(allowed);
  const requested = raw.split(',').filter((value): value is T => allowed.includes(value as T));
  return requested.length > 0 ? new Set(requested) : new Set(allowed);
}

function writeToUrl(key: string, values: ReadonlySet<string>, defaults: readonly string[]): void {
  /* v8 ignore next -- SSR guard: writeToUrl never runs server-side, but the defensive window check cannot be reached under jsdom, where window is always defined and React DOM requires it to run the toggle callbacks. */
  if ((globalThis as { window?: Window }).window === undefined) return;
  const params = new URLSearchParams(globalThis.location.search);
  const valueList = [...values];
  const matchesDefault =
    valueList.length === defaults.length && defaults.every((v) => values.has(v));
  if (matchesDefault) {
    params.delete(key);
  } else {
    params.set(key, valueList.join(','));
  }
  const next = params.toString();
  const search = next.length > 0 ? `?${next}` : '';
  const url = `${globalThis.location.pathname}${search}`;
  globalThis.history.replaceState(null, '', url);
}

/**
 * URL-synced filter state for the roadmap page. Defaults: all statuses and
 * both types selected. The URL only carries non-default selections, so the
 * canonical /roadmap URL stays clean and shareable filtered URLs look like
 * /roadmap?status=in_progress&type=feature.
 *
 * Toggle behavior auto-snaps back to all-on when the user removes the last
 * member of either axis. "Show me nothing" isn't a meaningful operation;
 * the empty state surfaces when a real filter combination yields no
 * matching projects, not as a result of a single accidental toggle.
 */
export function useFilterState(): FilterState {
  const [statuses, setStatuses] = React.useState<ReadonlySet<FilterStatus>>(() =>
    readInitialFromUrl<FilterStatus>('status', ALL_STATUSES)
  );
  const [types, setTypes] = React.useState<ReadonlySet<FilterType>>(() =>
    readInitialFromUrl<FilterType>('type', ALL_TYPES)
  );

  const toggleStatus = React.useCallback((value: FilterStatus) => {
    setStatuses((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      const result = next.size === 0 ? new Set(ALL_STATUSES) : next;
      writeToUrl('status', result, ALL_STATUSES);
      return result;
    });
  }, []);

  const toggleType = React.useCallback((value: FilterType) => {
    setTypes((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      const result = next.size === 0 ? new Set(ALL_TYPES) : next;
      writeToUrl('type', result, ALL_TYPES);
      return result;
    });
  }, []);

  const reset = React.useCallback(() => {
    setStatuses(new Set(ALL_STATUSES));
    setTypes(new Set(ALL_TYPES));
    /* v8 ignore next -- SSR guard: reset only fires from a client event, so the window-undefined path is unreachable under jsdom (window is always defined); the guarded replaceState below is exercised. */
    if ((globalThis as { window?: Window }).window !== undefined) {
      globalThis.history.replaceState(null, '', globalThis.location.pathname);
    }
  }, []);

  const isDefault =
    statuses.size === ALL_STATUSES.length &&
    ALL_STATUSES.every((v) => statuses.has(v)) &&
    types.size === ALL_TYPES.length &&
    ALL_TYPES.every((v) => types.has(v));

  return { statuses, types, toggleStatus, toggleType, reset, isDefault };
}

export { ALL_STATUSES, ALL_TYPES };
