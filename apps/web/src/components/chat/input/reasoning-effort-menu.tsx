import * as React from 'react';
import {
  planReasoning,
  planReasoningOff,
  REASONING_EFFORT_LABELS,
  TEST_IDS,
} from '@hushbox/shared';
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
import {
  useReasoningEffort,
  offeredEffortLabels,
  offersEffortNone,
} from '@/hooks/chat/use-reasoning-effort';
import type { ReasoningEffortSelection, CANONICAL_REASONING_EFFORTS } from '@hushbox/shared';
import type { EffortModel } from '@/hooks/chat/use-reasoning-effort';

type OptionState = 'enabled' | 'balance' | 'output-limit';

export interface EffortOption {
  readonly selection: ReasoningEffortSelection;
  readonly state: OptionState;
}

/** Cause-specific disabled copy, exposed via tooltip AND `aria-describedby`. */
export const EFFORT_DISABLED_REASONS: Readonly<Record<Exclude<OptionState, 'enabled'>, string>> = {
  balance: "Doesn't fit your current balance",
  'output-limit': "Exceeds the model's output limit",
};

interface EffortOptionStatesInput {
  readonly models: readonly EffortModel[];
  /** Affordable output tokens from the shared budget calc (0 when the balance funds nothing). */
  readonly maxOutputTokens: number;
  readonly estimatedInputTokens: number;
}

/**
 * Feasibility of one offered level across every selected model, THROUGH the
 * shared plan (G5): the answer headroom mirrors the server's derivation —
 * min(balance-affordable output, context headroom) minus the level's largest
 * reasoning budget — and the shared `planReasoning` has the final word. The
 * cause split drives the copy: a level the model's context can never hold is
 * `output-limit`; one only the balance blocks is `balance`.
 */
function classifyLevel(
  models: readonly EffortModel[],
  label: (typeof CANONICAL_REASONING_EFFORTS)[number],
  input: EffortOptionStatesInput,
  contextHeadroom: number
): OptionState {
  let maxBudget = 0;
  for (const model of models) {
    const probe = planReasoning(model, label, 1);
    /* v8 ignore next -- unreachable: labels come from offeredEffortLabels, so the probe is feasible by construction */
    if (!probe.feasible) return 'output-limit';
    maxBudget = Math.max(maxBudget, probe.plan.reasoningBudgetTokens);
  }
  const headroom = Math.min(input.maxOutputTokens, contextHeadroom) - maxBudget;
  if (headroom >= 1 && models.every((model) => planReasoning(model, label, headroom).feasible)) {
    return 'enabled';
  }
  return contextHeadroom - maxBudget < 1 ? 'output-limit' : 'balance';
}

/**
 * The menu's options in display order — Auto (first), offered levels
 * strongest first, None (hard off) last — each with its live feasibility
 * state. Auto is never disabled: the server picks a fitting level or engages
 * nothing.
 */
export function effortOptionStates(input: EffortOptionStatesInput): EffortOption[] {
  const { models } = input;
  const contextHeadroom =
    Math.min(...models.map((model) => model.contextLength)) - input.estimatedInputTokens;
  const descending = offeredEffortLabels(models).toReversed();
  const options: EffortOption[] = [{ selection: 'auto', state: 'enabled' }];
  for (const label of descending) {
    options.push({ selection: label, state: classifyLevel(models, label, input, contextHeadroom) });
  }
  if (offersEffortNone(models)) {
    const offHeadroom = Math.min(input.maxOutputTokens, contextHeadroom);
    const capable = models.filter((model) => model.reasoning !== undefined);
    const offFeasible =
      offHeadroom >= 1 && capable.every((model) => planReasoningOff(model, offHeadroom).feasible);
    const offBlocked: OptionState = contextHeadroom < 1 ? 'output-limit' : 'balance';
    options.push({ selection: 'none', state: offFeasible ? 'enabled' : offBlocked });
  }
  return options;
}

export interface ReasoningEffortMenuProps {
  /** Trial users (false) get infeasible levels HIDDEN (G9), never greyed. */
  isAuthenticated: boolean;
  maxOutputTokens: number;
  estimatedInputTokens: number;
}

interface MenuData {
  readonly options: readonly EffortOption[];
  readonly effective: ReasoningEffortSelection;
}

function menuDataKey(data: MenuData): string {
  const options = data.options.map((option) => `${option.selection}:${option.state}`).join('|');
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
  const disabled = option.state !== 'enabled';
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

  if (!disabled) return item;
  const reason = EFFORT_DISABLED_REASONS[option.state];
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
            if (option?.state === 'enabled') onSelect(value as ReasoningEffortSelection);
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
  isAuthenticated,
  maxOutputTokens,
  estimatedInputTokens,
}: Readonly<ReasoningEffortMenuProps>): React.JSX.Element {
  const { preferred, effective, models, setSelection } = useReasoningEffort();
  const isMobile = useIsMobile();
  const reasonIdBase = React.useId();

  const visible = effective !== undefined && models !== undefined;
  const options = visible
    ? effortOptionStates({ models, maxOutputTokens, estimatedInputTokens })
    : [];
  // Trial turns offer exactly the ceiling-fitting levels (G9): infeasible
  // options are hidden, not greyed — greyed-never-hidden applies outside trial.
  const shown = isAuthenticated ? options : options.filter((option) => option.state === 'enabled');

  // A trial preference whose level is no longer offered resets to Auto: the
  // option is hidden (not greyed), so an invisible active selection would
  // otherwise send a level the trial ceiling refuses.
  React.useEffect(() => {
    if (isAuthenticated || !visible || preferred === 'auto') return;
    if (!shown.some((option) => option.selection === preferred)) setSelection('auto');
  });

  // `effective` is defined whenever `visible`; the 'auto' arm only feeds the
  // (never-rendered) current snapshot of hidden states.
  const { menuData, onCollapseEnd } = useSlideRetention(visible, {
    options: shown,
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
