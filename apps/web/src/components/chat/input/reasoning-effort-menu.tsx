import * as React from 'react';
import { REASONING_EFFORT_LABELS, TEST_IDS, turnEffortOptions } from '@hushbox/shared';
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
import { useReasoningEffort, serverAcceptsChoice } from '@/hooks/chat/use-reasoning-effort';
import type { EffortOption as SharedEffortOption, ReasoningEffortSelection } from '@hushbox/shared';
import type { EffortModel } from '@/hooks/chat/use-reasoning-effort';

type OptionState = 'enabled' | 'balance' | 'output-limit' | 'unsupported';

export interface EffortOption {
  readonly selection: ReasoningEffortSelection;
  readonly state: OptionState;
}

/** Cause-specific disabled copy, exposed via tooltip AND `aria-describedby`. */
export const EFFORT_DISABLED_REASONS: Readonly<Record<Exclude<OptionState, 'enabled'>, string>> = {
  balance: "Doesn't fit your current balance",
  'output-limit': "Exceeds the model's output limit",
  unsupported: 'Not supported by every selected model',
};

interface EffortOptionStatesInput {
  readonly models: readonly EffortModel[];
  /** Affordable output tokens from the shared budget calc (0 when the balance funds nothing). */
  readonly maxOutputTokens: number;
  readonly estimatedInputTokens: number;
}

/**
 * Feasibility of one shared choice: the answer headroom is
 * min(balance-affordable output, context headroom, the option's declared
 * completion cap) minus the option's resolved reasoning budget — every term
 * except the two client-measured ones rides the shared option itself. The
 * cause split drives the copy: a choice no physical ceiling can hold is
 * `output-limit`; one only the balance blocks is `balance`. A choice the
 * server's current validation would refuse is `unsupported` regardless of
 * headroom (see {@link serverAcceptsChoice}).
 */
function classifyOption(
  models: readonly EffortModel[],
  option: SharedEffortOption,
  input: EffortOptionStatesInput,
  contextHeadroom: number
): OptionState {
  if (!serverAcceptsChoice(models, option.choice)) return 'unsupported';
  const physicalCeiling =
    option.completionCapTokens === undefined
      ? contextHeadroom
      : Math.min(contextHeadroom, option.completionCapTokens);
  const headroom =
    Math.min(input.maxOutputTokens, physicalCeiling) - option.maxReasoningBudgetTokens;
  if (headroom >= 1) return 'enabled';
  return physicalCeiling - option.maxReasoningBudgetTokens < 1 ? 'output-limit' : 'balance';
}

/**
 * The menu's options in display order — Auto (first), the shared union
 * choice set strongest-level first, Min (the off row) last — each with its
 * live feasibility state. The choice SET is exactly `turnEffortOptions`
 * (union across the selection, Min included when any model can disable);
 * only the ordering is presentation. Auto is never disabled: the server
 * picks a fitting level or engages nothing.
 */
export function effortOptionStates(input: EffortOptionStatesInput): EffortOption[] {
  const { models } = input;
  const contextHeadroom =
    Math.min(...models.map((model) => model.contextLength)) - input.estimatedInputTokens;
  const shared = turnEffortOptions(models);
  const levelsDescending = shared.filter((option) => option.choice !== 'none').toReversed();
  const min = shared.find((option) => option.choice === 'none');
  const displayOrder = min === undefined ? levelsDescending : [...levelsDescending, min];
  const options: EffortOption[] = [{ selection: 'auto', state: 'enabled' }];
  for (const option of displayOrder) {
    options.push({
      selection: option.choice,
      state: classifyOption(models, option, input, contextHeadroom),
    });
  }
  return options;
}

export interface ReasoningEffortMenuProps {
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
  maxOutputTokens,
  estimatedInputTokens,
}: Readonly<ReasoningEffortMenuProps>): React.JSX.Element {
  const { effective, models, setSelection } = useReasoningEffort();
  const isMobile = useIsMobile();
  const reasonIdBase = React.useId();

  const visible = effective !== undefined && models !== undefined;
  // Greyed-never-hidden for EVERY tier (trial and guest included): infeasible
  // options render greyed with a reason, never filtered out.
  const options = visible
    ? effortOptionStates({ models, maxOutputTokens, estimatedInputTokens })
    : [];

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
