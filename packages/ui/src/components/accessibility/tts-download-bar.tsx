import * as React from 'react';

import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { cn } from '../../lib/utilities';

export interface TtsDownloadBarProps {
  /** Download progress, 0–100. Values outside the range are clamped. */
  readonly percent: number;
  /**
   * Accessible name for the live region. Also rendered as the visible header
   * label (left of the percent readout) when `showLabel` is set.
   */
  readonly label: string;
  /**
   * Render a visible "{label} … {percent}%" header row above the track. The
   * blog reader card sets this; the accessibility widget's audio section omits
   * it and renders its own byte/speed/ETA line beneath the bar.
   */
  readonly showLabel?: boolean;
}

/**
 * Borderless model-download progress bar shared by the accessibility widget's
 * audio section and the blog reader card (One Implementation, Shared). A thin
 * track carries a percent-driven fill; the fill's width transition is dropped
 * under the merged reduced-motion signal (OS `prefers-reduced-motion`, the a11y
 * widget's "stop animations", or an E2E build) so nothing moves when motion is
 * suppressed. No border stroke and no container background: the track and
 * its fill are the only painted surfaces.
 */
export function TtsDownloadBar({
  percent,
  label,
  showLabel = false,
}: TtsDownloadBarProps): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const animated = !useReducedMotion();
  return (
    <div role="status" aria-label={label} className="flex w-full flex-col gap-1">
      {showLabel ? (
        <div className="text-muted-foreground flex justify-between text-xs tabular-nums">
          <span>{label}</span>
          <span>{pct.toString()}%</span>
        </div>
      ) : null}
      <div className="bg-input h-2 w-full overflow-hidden rounded-full">
        <div
          className={cn('bg-primary h-full', animated && 'transition-all')}
          style={{ width: `${pct.toString()}%` }}
        />
      </div>
    </div>
  );
}
