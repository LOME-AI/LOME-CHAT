import * as React from 'react';
import { noticeText, REASONING_EFFORT_LABELS, REASONING_OFF, TEST_IDS } from '@hushbox/shared';
import {
  cn,
  useIsMobile,
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@hushbox/ui';
import { useReasoningEffort } from '@/hooks/chat/use-reasoning-effort';
import type {
  Availability,
  DimensionAvailability,
  ReasoningEffortSelection,
} from '@hushbox/shared';

/**
 * The menu renders the producer's PRESENTED SET for the effort dimension —
 * `affordable.turnDimensions` — and grades nothing itself.
 *
 * That set is the union of the selected models' rungs, each graded by the SAME
 * query the send gate runs (AND over pinned siblings, inside OR over the
 * arrangements a smart slot could become). The intersection clamp this replaced
 * was wrong in both directions at once: it HID a rung only one sibling offers
 * (per-model resolution falls downward, so the turn can honour it) and it
 * ENABLED a rung both siblings name but neither can fund. Greyed-never-hidden,
 * for every tier including trial.
 */
export interface EffortOption {
  readonly selection: ReasoningEffortSelection;
  readonly availability: Availability;
}

/**
 * Display order: Auto first (always selectable — it delegates the choice), then
 * the canonical rungs strongest-first, then Min last. Order is presentation;
 * MEMBERSHIP is the producer's.
 */
export function effortOptionsFrom(dimension?: DimensionAvailability): EffortOption[] {
  const auto: EffortOption = { selection: 'auto', availability: { available: true } };
  if (dimension === undefined) return [auto];
  const rungs = dimension.options.filter((option) => option.optionId !== REASONING_OFF);
  const min = dimension.options.find((option) => option.optionId === REASONING_OFF);
  const ordered = rungs.toReversed();
  const rows = min === undefined ? ordered : [...ordered, min];
  return [
    auto,
    ...rows.map(
      (option): EffortOption => ({
        selection: option.optionId as ReasoningEffortSelection,
        availability: option.availability,
      })
    ),
  ];
}

export interface ReasoningEffortMenuProps {
  /** The produced effort dimension (`affordable.turnDimensions`), or undefined while it loads. */
  effortDimension: DimensionAvailability | undefined;
}

interface MenuData {
  readonly options: readonly EffortOption[];
  readonly effective: ReasoningEffortSelection;
}

function menuDataKey(data: MenuData): string {
  const options = data.options
    .map((option) =>
      option.availability.available
        ? `${option.selection}:ok`
        : `${option.selection}:${option.availability.reason}`
    )
    .join('|');
  return `${options}@${data.effective}`;
}

function sameMenuData(a: MenuData | null, b: MenuData): boolean {
  return a !== null && menuDataKey(a) === menuDataKey(b);
}

/**
 * Slide-out needs the outgoing chip to stay in the DOM while the wrapper
 * collapses (the new model's ladder is already empty, so re-deriving options
 * would render nothing and the chip would vanish before the slide). The last
 * visible chip's data is retained in state, rendered inert until the caller
 * reports transitionend via `onCollapseEnd`. Render-phase setState (the React
 * "storing information from previous renders" pattern) keeps the retained
 * snapshot and closing flag in the SAME render the visibility flips — an
 * effect would leave a one-frame gap where the collapsing chip is empty.
 */
function useSlideRetention(
  visible: boolean,
  current: MenuData
): { menuData: MenuData | null; onCollapseEnd: () => void } {
  const [closing, setClosing] = React.useState(false);
  const [previousVisible, setPreviousVisible] = React.useState(false);
  const [retained, setRetained] = React.useState<MenuData | null>(null);

  if (previousVisible !== visible) {
    setPreviousVisible(visible);
    if (!visible) setClosing(true);
  }
  if (visible && !sameMenuData(retained, current)) setRetained(current);

  let menuData: MenuData | null = null;
  if (visible) menuData = current;
  else if (closing) menuData = retained;

  return {
    menuData,
    onCollapseEnd: () => {
      setClosing(false);
    },
  };
}

interface EffortMenuItemProps {
  readonly option: EffortOption;
  readonly isMobile: boolean;
  readonly reasonIdBase: string;
}

function EffortMenuItem({
  option,
  isMobile,
  reasonIdBase,
}: Readonly<EffortMenuItemProps>): React.JSX.Element {
  const disabled = !option.availability.available;
  const word = REASONING_EFFORT_LABELS[option.selection];
  const reasonId = `${reasonIdBase}-${option.selection}`;

  const item = (
    <DropdownMenuRadioItem
      value={option.selection}
      // aria-disabled (not Radix disabled): the item stays hoverable and
      // keyboard-focusable so the cause tooltip and aria-describedby reason
      // remain reachable — greyed-never-hidden with a discoverable why.
      {...(disabled && { 'aria-disabled': true, 'aria-describedby': reasonId })}
      onSelect={(event) => {
        if (disabled) event.preventDefault();
      }}
      className={cn(
        isMobile && 'min-h-11',
        // opacity-60, not lower: greyed options must stay perceivable for
        // low-vision users while reading as non-interactive.
        disabled && 'cursor-not-allowed opacity-60'
      )}
    >
      {word}
    </DropdownMenuRadioItem>
  );

  // Narrowing on the union itself, so the reason is reachable without a
  // defensive branch the type already rules out.
  if (option.availability.available) return item;
  // One home for money copy: the rung's reason renders the same sentence the
  // send gate would give for that condition.
  const reason = noticeText(option.availability.reason);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>{item}</TooltipTrigger>
        <TooltipContent side="left">{reason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {reason}
      </span>
    </>
  );
}

interface EffortChipProps {
  readonly data: MenuData;
  readonly isMobile: boolean;
  readonly reasonIdBase: string;
  readonly onSelect: (selection: ReasoningEffortSelection) => void;
}

function EffortChip({
  data,
  isMobile,
  reasonIdBase,
  onSelect,
}: Readonly<EffortChipProps>): React.JSX.Element {
  const effective = data.effective;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TEST_IDS.effortChip}
          // Matches the model-selector chip grammar (outline + bg-secondary).
          className="bg-secondary hover:bg-secondary/80 whitespace-nowrap"
        >
          {/* Ghost-label stack: every possible label sits invisibly in the
              same grid cell, so the chip is always exactly as wide as the
              widest "Effort · <word>" and never resizes when the selection
              changes. Chosen over a ch-based min-width because ch measures
              the "0" glyph — an approximation under the proportional UI font
              that could still under-reserve; the stack is font-exact. The
              ghosts are aria-hidden, so the accessible name stays the
              current selection only. */}
          <span className="grid text-center">
            <span className="col-start-1 row-start-1 whitespace-nowrap">
              Effort · {REASONING_EFFORT_LABELS[effective]}
            </span>
            {Object.values(REASONING_EFFORT_LABELS).map((word) => (
              <span
                key={word}
                aria-hidden="true"
                className="invisible col-start-1 row-start-1 whitespace-nowrap"
              >
                Effort · {word}
              </span>
            ))}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        // Same width as the trigger chip (the select primitive's
        // trigger-width-variable pattern); min-w-0 clears the dropdown
        // primitive's 8rem floor via twMerge so the width is exact.
        className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-0"
      >
        <DropdownMenuRadioGroup
          value={effective}
          onValueChange={(value) => {
            // Authoritative guard regardless of Radix's disabled semantics:
            // greyed options never commit a selection.
            const option = data.options.find((entry) => entry.selection === value);
            if (option?.availability.available === true)
              onSelect(value as ReasoningEffortSelection);
          }}
        >
          {data.options.map((option) => (
            <EffortMenuItem
              key={option.selection}
              option={option}
              isMobile={isMobile}
              reasonIdBase={reasonIdBase}
            />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The reasoning-effort chip in the composer controls row, immediately left of
 * the send button (founder ruling 2026-07-23 — replaces the earlier docked
 * radiogroup design).
 * The trigger is self-labeling ("Effort · <current>", ≤4-char full words from
 * the shared labels) and opens an UPWARD menu with standard menu semantics.
 * Rendered only when every selected model offers levels on its positional
 * ladder; the chip slides in/out on model/modality switches via the CSS
 * grid-columns wrapper below.
 */
export function ReasoningEffortMenu({
  effortDimension,
}: Readonly<ReasoningEffortMenuProps>): React.JSX.Element {
  const { effective, models, setSelection } = useReasoningEffort();
  const isMobile = useIsMobile();
  const reasonIdBase = React.useId();

  const visible = effective !== undefined && models !== undefined;
  // Greyed-never-hidden for EVERY tier (trial and guest included): infeasible
  // options render greyed with a reason, never filtered out.
  const options = visible ? effortOptionsFrom(effortDimension) : [];

  // `effective` is defined whenever `visible`; the 'auto' arm only feeds the
  // (never-rendered) current snapshot of hidden states.
  const { menuData, onCollapseEnd } = useSlideRetention(visible, {
    options,
    effective: effective ?? 'auto',
  });

  return (
    // The persistent slide wrapper: grid-template-columns 0fr↔1fr animates
    // to/from the chip's natural width with a pure CSS transition. No
    // motion-reduce:transition-none here — the global html.reduced-motion
    // kill (0.01ms, deliberately event-preserving) collapses the slide while
    // still firing the transitionend that unmounts the outgoing chip.
    <div
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !visible) onCollapseEnd();
      }}
      className={cn(
        'grid shrink-0 transition-[grid-template-columns] duration-300 ease-in-out',
        visible ? 'grid-cols-[1fr]' : 'grid-cols-[0fr]'
      )}
    >
      <div
        className={cn('overflow-hidden', !visible && 'pointer-events-none')}
        {...(!visible && { 'aria-hidden': true })}
      >
        {menuData !== null && (
          <EffortChip
            data={menuData}
            isMobile={isMobile}
            reasonIdBase={reasonIdBase}
            onSelect={setSelection}
          />
        )}
      </div>
    </div>
  );
}
