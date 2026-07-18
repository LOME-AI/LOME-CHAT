import * as React from 'react';
import { cn } from '@hushbox/ui';

interface DurationSnapSliderProps {
  value: number;
  min: number;
  max: number;
  /**
   * Discrete values that should render as clickable tick marks above the
   * track. When undefined the slider runs as a continuous range with no ticks.
   */
  snapPoints?: readonly number[];
  onChange: (value: number) => void;
  ariaLabel: string;
}

function positionPercent(n: number, min: number, max: number): number {
  if (max === min) return 0;
  return ((n - min) / (max - min)) * 100;
}

/**
 * Half-width of the custom thumb (size-4 = 16px). The native slider reserves
 * this much space on each side of the track for the thumb to slide through,
 * so value=min lands at x=THUMB_HALF_PX (not 0) and value=max lands at
 * trackWidth-THUMB_HALF_PX. The snap-mark layer is inset by the same amount
 * so a mark at percent N lines up with the thumb position at value N.
 */
const THUMB_HALF_PX = 8;

const SLIDER_INPUT_CLASS = cn(
  'absolute inset-0 w-full cursor-pointer appearance-none bg-transparent',
  // Webkit (Chrome, Safari): styles only apply with appearance:none on parent.
  '[&::-webkit-slider-runnable-track]:bg-transparent',
  '[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none',
  '[&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:rounded-full',
  '[&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow',
  '[&::-webkit-slider-thumb]:ring-background [&::-webkit-slider-thumb]:ring-2',
  // Firefox
  '[&::-moz-range-track]:bg-transparent',
  '[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:appearance-none',
  '[&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:rounded-full',
  '[&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-0',
  '[&::-moz-range-thumb]:shadow'
);

export function DurationSnapSlider({
  value,
  min,
  max,
  snapPoints,
  onChange,
  ariaLabel,
}: Readonly<DurationSnapSliderProps>): React.JSX.Element {
  const fillPercent = positionPercent(value, min, max);
  return (
    <div className="relative flex h-5 flex-1 items-center">
      {/* Visible track with primary-colored fill up to the thumb. The native
          input above is transparent and provides only the thumb + interaction. */}
      <div
        className="bg-muted absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full"
        aria-hidden="true"
      >
        <div
          className="bg-primary h-full rounded-full"
          style={{ width: `${String(fillPercent)}%` }}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        aria-label={ariaLabel}
        aria-valuetext={`${String(value)} seconds`}
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
        className={SLIDER_INPUT_CLASS}
      />
      {snapPoints ? (
        <div
          className="pointer-events-none absolute inset-y-0 z-10"
          style={{ left: `${String(THUMB_HALF_PX)}px`, right: `${String(THUMB_HALF_PX)}px` }}
        >
          {snapPoints.map((point) => {
            const isActive = point === value;
            return (
              <button
                key={point}
                type="button"
                aria-label={`Set duration to ${String(point)} seconds`}
                aria-pressed={isActive}
                onClick={() => {
                  onChange(point);
                }}
                className={cn(
                  'absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full',
                  isActive
                    ? 'pointer-events-none opacity-0'
                    : 'bg-foreground focus-visible:ring-ring/50 pointer-events-auto cursor-pointer hover:scale-125 focus-visible:ring-2'
                )}
                style={{ left: `${String(positionPercent(point, min, max))}%` }}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
