import * as React from 'react';
import type { TrendBand } from './compute-stats';

interface TrendChartProps {
  readonly bands: readonly TrendBand[];
  readonly axis: { readonly left: string; readonly right: string };
  readonly ariaLabel: string;
}

/**
 * Hand-rolled 100%-stacked-area SVG (repo pattern — no chart library). The
 * geometry lives in compute-stats; this renders pre-built band paths in a
 * 100x100 viewBox stretched to the container. The ranked list beside the
 * chart is the text alternative for the per-model breakdown; the aria-label
 * summarizes what the image shows.
 */
export function TrendChart({ bands, axis, ariaLabel }: TrendChartProps): React.JSX.Element {
  const gradientBaseId = React.useId();
  const gradientId = (index: number): string => `${gradientBaseId}-band-${String(index)}`;
  if (bands.length === 0) {
    return (
      <div className="text-muted-foreground flex h-48 w-full items-center justify-center rounded-md font-mono text-xs tracking-widest uppercase">
        Not enough data yet
      </div>
    );
  }
  return (
    <figure className="flex flex-col gap-3">
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="border-border h-48 w-full rounded-md border"
      >
        <defs>
          {bands.map((band, index) => (
            // objectBoundingBox units: the fade spans exactly the band's own
            // vertical extent — strongest under its top line, faint where the
            // next band's hard top line takes over (or the baseline).
            <linearGradient key={band.id} id={gradientId(index)} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={band.color} stopOpacity="0.75" />
              <stop offset="1" stopColor={band.color} stopOpacity="0.08" />
            </linearGradient>
          ))}
        </defs>
        {bands.map((band, index) => (
          <path key={band.id} d={band.path} fill={`url(#${gradientId(index)})`} />
        ))}
        {bands.map((band) => (
          <path
            key={band.id}
            d={band.topPath}
            fill="none"
            stroke={band.color}
            strokeWidth={2}
            // The 100x100 viewBox stretches non-uniformly; keep the line 2px on screen.
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="text-muted-foreground flex justify-between font-mono text-xs tracking-widest uppercase">
        <span>{axis.left}</span>
        <span>{axis.right}</span>
      </div>
      <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1">
        {bands.map((band) => (
          <li key={band.id} className="flex items-center gap-1.5 text-sm">
            <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 rounded-xs" aria-hidden="true">
              <rect width="10" height="10" fill={band.color} />
            </svg>
            <span className="text-muted-foreground">{band.label}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
