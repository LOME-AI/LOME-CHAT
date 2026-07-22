import * as React from 'react';
import { planReasoning, planReasoningOff, REASONING_EFFORT_LABELS } from '@hushbox/shared';
import { cn, useIsMobile, Tooltip, TooltipContent, TooltipTrigger } from '@hushbox/ui';
import {
  useReasoningEffort,
  railOfferedLabels,
  railOffersNone,
} from '@/hooks/chat/use-reasoning-effort';
import type { ReasoningEffortSelection, CANONICAL_REASONING_EFFORTS } from '@hushbox/shared';
import type { RailModel } from '@/hooks/chat/use-reasoning-effort';

type PillState = 'enabled' | 'balance' | 'output-limit';

export interface RailPill {
  readonly selection: ReasoningEffortSelection;
  readonly state: PillState;
}

/** Cause-specific disabled copy, exposed via tooltip AND `aria-describedby`. */
export const RAIL_DISABLED_REASONS: Readonly<Record<Exclude<PillState, 'enabled'>, string>> = {
  balance: "Doesn't fit your current balance",
  'output-limit': "Exceeds the model's output limit",
};

/** Two-glyph collapsed labels (one letter collides: Max/Med/Min). Visual only — aria-hidden. */
const RAIL_ABBREVIATIONS: Readonly<Record<ReasoningEffortSelection, string>> = {
  auto: 'A',
  max: 'MX',
  high: 'HI',
  medium: 'MD',
  low: 'LO',
  min: 'MN',
  none: 'OFF',
};

interface RailPillStatesInput {
  readonly models: readonly RailModel[];
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
  models: readonly RailModel[],
  label: (typeof CANONICAL_REASONING_EFFORTS)[number],
  input: RailPillStatesInput,
  contextHeadroom: number
): PillState {
  let maxBudget = 0;
  for (const model of models) {
    const probe = planReasoning(model, label, 1);
    /* v8 ignore next -- unreachable: labels come from railOfferedLabels, so the probe is feasible by construction */
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
 * The rail's pills in display order — Auto (top), offered levels strongest
 * first, None (hard off) last — each with its live feasibility state. Auto is
 * never disabled: the server picks a fitting level or engages nothing.
 */
export function railPillStates(input: RailPillStatesInput): RailPill[] {
  const { models } = input;
  const contextHeadroom =
    Math.min(...models.map((model) => model.contextLength)) - input.estimatedInputTokens;
  const descending = railOfferedLabels(models).toReversed();
  const pills: RailPill[] = [{ selection: 'auto', state: 'enabled' }];
  for (const label of descending) {
    pills.push({ selection: label, state: classifyLevel(models, label, input, contextHeadroom) });
  }
  if (railOffersNone(models)) {
    const offHeadroom = Math.min(input.maxOutputTokens, contextHeadroom);
    const capable = models.filter((model) => model.reasoning !== undefined);
    const offFeasible =
      offHeadroom >= 1 && capable.every((model) => planReasoningOff(model, offHeadroom).feasible);
    const offBlocked: PillState = contextHeadroom < 1 ? 'output-limit' : 'balance';
    pills.push({ selection: 'none', state: offFeasible ? 'enabled' : offBlocked });
  }
  return pills;
}

export interface ReasoningEffortRailProps {
  /** Trial users (false) get infeasible levels HIDDEN (G9), never greyed. */
  isAuthenticated: boolean;
  maxOutputTokens: number;
  estimatedInputTokens: number;
}

interface RailButtonProps {
  readonly pill: RailPill;
  readonly checked: boolean;
  readonly isMobile: boolean;
  readonly reasonIdBase: string;
  readonly onSelect: (selection: ReasoningEffortSelection) => void;
  readonly onArrow: (event: React.KeyboardEvent, selection: ReasoningEffortSelection) => void;
  readonly registerRef: (
    selection: ReasoningEffortSelection,
    node: HTMLButtonElement | null
  ) => void;
}

function RailButton({
  pill,
  checked,
  isMobile,
  reasonIdBase,
  onSelect,
  onArrow,
  registerRef,
}: Readonly<RailButtonProps>): React.JSX.Element {
  const disabled = pill.state !== 'enabled';
  const word = REASONING_EFFORT_LABELS[pill.selection];
  const reasonId = `${reasonIdBase}-${pill.selection}`;

  const handleActivate = (): void => {
    if (!disabled) onSelect(pill.selection);
  };

  const button = (
    <button
      type="button"
      role="radio"
      ref={(node) => {
        registerRef(pill.selection, node);
      }}
      aria-checked={checked}
      aria-label={word}
      {...(disabled && { 'aria-disabled': true, 'aria-describedby': reasonId })}
      tabIndex={checked ? 0 : -1}
      onClick={handleActivate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleActivate();
          return;
        }
        onArrow(event, pill.selection);
      }}
      className={cn(
        'flex items-center justify-end rounded-md px-2 text-xs font-medium tracking-wide',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]',
        'transition-colors motion-reduce:transition-none',
        isMobile ? 'min-h-11 min-w-11' : 'h-7 min-w-9',
        checked
          ? 'bg-primary text-primary-foreground font-semibold'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        disabled && 'hover:text-muted-foreground cursor-not-allowed opacity-40 hover:bg-transparent'
      )}
    >
      <span aria-hidden className="group-focus-within/rail:hidden group-hover/rail:hidden">
        {RAIL_ABBREVIATIONS[pill.selection]}
      </span>
      <span aria-hidden className="hidden group-focus-within/rail:inline group-hover/rail:inline">
        {word}
      </span>
    </button>
  );

  if (!disabled) return button;
  const reason = RAIL_DISABLED_REASONS[pill.state];
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="left">{reason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {reason}
      </span>
    </>
  );
}

/**
 * The vertical reasoning-effort rail docked right of the prompt input
 * (founder ruling R1). Renders only when every selected model offers levels
 * on its positional ladder; one touch/click changes the level on desktop and
 * mobile alike (collapsed two-glyph pills are direct targets — 44px minimum
 * on touch). Full words appear on hover/focus of the rail; accessible names
 * are ALWAYS the full words. The active level is the One Red Rule signal.
 */
export function ReasoningEffortRail({
  isAuthenticated,
  maxOutputTokens,
  estimatedInputTokens,
}: Readonly<ReasoningEffortRailProps>): React.JSX.Element | null {
  const { preferred, effective, models, setSelection } = useReasoningEffort();
  const isMobile = useIsMobile();
  const reasonIdBase = React.useId();
  const references = React.useRef(new Map<ReasoningEffortSelection, HTMLButtonElement>());

  const visible = effective !== undefined && models !== undefined;
  const pills = visible ? railPillStates({ models, maxOutputTokens, estimatedInputTokens }) : [];
  // Trial turns offer exactly the ceiling-fitting levels (G9): infeasible
  // pills are hidden, not greyed — greyed-never-hidden applies outside trial.
  const shown = isAuthenticated ? pills : pills.filter((pill) => pill.state === 'enabled');

  // A trial preference whose level is no longer offered resets to Auto: the
  // pill is hidden (not greyed), so an invisible active selection would
  // otherwise send a level the trial ceiling refuses.
  React.useEffect(() => {
    if (isAuthenticated || !visible || preferred === 'auto') return;
    if (!shown.some((pill) => pill.selection === preferred)) setSelection('auto');
  });

  // Auto is always present and always enabled, so a visible rail is never
  // empty — visibility alone gates rendering.
  if (!visible) return null;

  const registerRef = (
    selection: ReasoningEffortSelection,
    node: HTMLButtonElement | null
  ): void => {
    if (node === null) references.current.delete(selection);
    else references.current.set(selection, node);
  };

  const onArrow = (event: React.KeyboardEvent, selection: ReasoningEffortSelection): void => {
    const order = shown.map((pill) => pill.selection);
    const index = order.indexOf(selection);
    let target: ReasoningEffortSelection | undefined;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight': {
        target = order[index + 1];
        break;
      }
      case 'ArrowUp':
      case 'ArrowLeft': {
        target = order[index - 1];
        break;
      }
      case 'Home': {
        target = order[0];
        break;
      }
      case 'End': {
        target = order.at(-1);
        break;
      }
      default: {
        return;
      }
    }
    if (target === undefined) return;
    event.preventDefault();
    references.current.get(target)?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Reasoning effort"
      data-chrome=""
      className="group/rail flex shrink-0 flex-col items-stretch justify-end gap-0.5 self-end"
    >
      {shown.map((pill, index) => (
        <React.Fragment key={pill.selection}>
          <RailButton
            pill={pill}
            checked={pill.selection === effective}
            isMobile={isMobile}
            reasonIdBase={reasonIdBase}
            onSelect={setSelection}
            onArrow={onArrow}
            registerRef={registerRef}
          />
          {index === 0 && shown.length > 1 && (
            <span aria-hidden className="bg-border mx-1.5 my-0.5 h-px" />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}
