import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link } from '@tanstack/react-router';
import { ChevronUp, ChevronDown, Lock, Square, CheckSquare, Info } from 'lucide-react';
import { Button, cn, Tooltip, TooltipContent, TooltipTrigger, useIsTouchDevice } from '@hushbox/ui';
import {
  NOTICE_COPY,
  noticeText,
  shortenModelName,
  TEST_IDS,
  TEST_ID_BUILDERS,
} from '@hushbox/shared';
import { type PickerMode } from '@/stores/model';

import { ModelInfoPanel } from '@/components/chat/model-selector/model-info-panel';
import {
  modelSubtitle,
  expandedRowButtonLabel,
} from '@/components/chat/model-selector/model-selector-helpers';
import type { Availability, Model, RefusalCode } from '@hushbox/shared';

/**
 * The action clause of a row's reason, rendered from the shared vocabulary —
 * the same segments the composer's notice renders, so the picker cannot phrase
 * a condition differently from the surface beside it. A segment carrying a
 * route becomes a link, which is what keeps "Add credit" and "Sign up"
 * actionable from the row itself without re-authoring either sentence.
 */
function RowReasonAction({ reason }: Readonly<{ reason: RefusalCode }>): React.JSX.Element {
  return (
    <span className="shrink-0 text-xs">
      {NOTICE_COPY[reason].action.map((segment) =>
        segment.link === undefined ? (
          <span key={segment.text} className="text-muted-foreground">
            {segment.text}
          </span>
        ) : (
          <Link
            key={segment.text}
            to={segment.link}
            className="text-primary hover:underline"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            {segment.text}
          </Link>
        )
      )}
    </span>
  );
}

interface ModelItemDetailsProps {
  model: Model;
  reason: RefusalCode | undefined;
  pinnedLabel?: string | undefined;
}

function ModelItemDetails({
  model,
  reason,
  pinnedLabel,
}: Readonly<ModelItemDetailsProps>): React.JSX.Element {
  // Per-model "Web Search" badges intentionally omitted — search is universal
  // across text models now (per gateway plan §9.2); per-model badges are noise.
  return (
    <div className="text-muted-foreground relative flex items-center justify-between text-xs">
      <span className="truncate">{modelSubtitle(model)}</span>
      {reason !== undefined && <RowReasonAction reason={reason} />}
      {reason === undefined && pinnedLabel && (
        <span className="text-muted-foreground shrink-0 text-xs">{pinnedLabel}</span>
      )}
    </div>
  );
}

interface ModelItemContentProps {
  model: Model;
  reason: RefusalCode | undefined;
  pinnedLabel?: string | undefined;
}

function ModelItemContent({
  model,
  reason,
  pinnedLabel,
}: Readonly<ModelItemContentProps>): React.JSX.Element {
  return (
    <div className="w-0 min-w-0 flex-1 p-3">
      <div className="relative flex items-center justify-between gap-2">
        <span className="truncate font-medium">{shortenModelName(model.name)}</span>
        {reason !== undefined && (
          <Lock
            data-testid={TEST_IDS.lockIcon}
            className="text-muted-foreground h-4 w-4 shrink-0"
          />
        )}
      </div>
      <ModelItemDetails model={model} reason={reason} pinnedLabel={pinnedLabel} />
    </div>
  );
}

export interface ModelListItemProps {
  model: Model;
  isFocused: boolean;
  isSelected: boolean;
  isDisabled: boolean;
  /**
   * The row's verdict as the producer marked it (`affordable.all`). A row is
   * never removed for being unavailable — it greys and carries its typed
   * reason, which is the only thing that decides the copy. Premium locks and
   * funding shortfalls differ by REASON, not by mechanism.
   */
  availability: Availability;
  pickerMode: PickerMode;
  pinnedLabel?: string | undefined;
  isExpanded: boolean;
  isMobile: boolean;
  /**
   * Highlights the row briefly via a one-shot pulse animation. Used to draw
   * attention to the carryover-selected model when entering multi mode.
   */
  isPulsing: boolean;
  /** Row position used by the checkbox cascade-in/out animation. */
  cascadeIndex: number;
  onActivate: () => void;
  onHover: () => void;
  onShowInfo: () => void;
  onToggleExpand: () => void;
}

const CHECKBOX_CASCADE_STAGGER_MS = 40;

/**
 * Each row contributes its own stagger delay based on its cascade index.
 * Enter (single → multi) and exit (multi → single) both cascade top-to-bottom.
 * Width animates from 0 → auto so the model name text slides over smoothly
 * instead of jumping when the checkbox appears.
 */
function ModelCheckboxIcon({
  isSelected,
  cascadeIndex,
}: Readonly<{ isSelected: boolean; cascadeIndex: number }>): React.JSX.Element {
  const delay = (cascadeIndex * CHECKBOX_CASCADE_STAGGER_MS) / 1000;
  return (
    <motion.span
      data-testid={TEST_IDS.modelCheckbox}
      data-cascade-index={cascadeIndex}
      className="relative flex shrink-0 items-center justify-center overflow-hidden"
      aria-hidden
      initial={{ opacity: 0, scale: 0.5, width: 0, marginLeft: 0 }}
      animate={{ opacity: 1, scale: 1, width: 24, marginLeft: 8 }}
      exit={{ opacity: 0, scale: 0.5, width: 0, marginLeft: 0 }}
      transition={{ delay, duration: 0.18, ease: [0.34, 1.56, 0.64, 1] }}
    >
      {isSelected ? (
        <CheckSquare className="text-primary h-4 w-4" />
      ) : (
        <Square className="text-muted-foreground h-4 w-4" />
      )}
    </motion.span>
  );
}

interface RowMainButtonProps {
  model: Model;
  pickerMode: PickerMode;
  isSelected: boolean;
  isFocused: boolean;
  isDisabled: boolean;
  /** Greyed: aria-disabled + cause tooltip; activation is refused here too. */
  isUnavailable: boolean;
  reason: RefusalCode | undefined;
  reasonText: string;
  reasonId: string;
  pinnedLabel?: string | undefined;
  /** Row position used by the checkbox cascade-in/out animation. */
  cascadeIndex: number;
  onActivate: () => void;
  onHover: () => void;
}

function RowMainButton({
  model,
  pickerMode,
  isSelected,
  isFocused,
  isDisabled,
  isUnavailable,
  reason,
  reasonText,
  reasonId,
  pinnedLabel,
  cascadeIndex,
  onActivate,
  onHover,
}: Readonly<RowMainButtonProps>): React.JSX.Element {
  const ariaLabel =
    pickerMode === 'single' ? `Use ${model.name}` : `Toggle selection for ${model.name}`;
  const button = (
    <button
      type="button"
      aria-label={ariaLabel}
      // aria-disabled (not disabled): the row stays hoverable and
      // keyboard-focusable so the cause tooltip and aria-describedby reason
      // remain reachable — greyed-never-hidden, and discoverable why.
      {...(isUnavailable && { 'aria-disabled': true, 'aria-describedby': reasonId })}
      className={cn(
        'flex flex-1 cursor-pointer items-center rounded-md text-left transition-colors',
        !isSelected && !isFocused && !isDisabled && !isUnavailable && 'hover:bg-muted',
        isUnavailable && 'cursor-not-allowed'
      )}
      // An unavailable row still REPORTS activation. Swallowing the click here
      // would break the two things the container must still be able to do with
      // it: route a premium lock to the paywall, and let an already-selected
      // row be de-selected so a model that became unavailable cannot trap the
      // selection. Refusing to SELECT is the container's decision, not the
      // row's.
      onClick={onActivate}
      onMouseEnter={onHover}
      onFocus={onHover}
    >
      <AnimatePresence initial={false}>
        {pickerMode === 'multi' && (
          <ModelCheckboxIcon key="checkbox" isSelected={isSelected} cascadeIndex={cascadeIndex} />
        )}
      </AnimatePresence>
      <ModelItemContent model={model} reason={reason} pinnedLabel={pinnedLabel} />
    </button>
  );
  if (!isUnavailable) return button;
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="left">{reasonText}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {reasonText}
      </span>
    </>
  );
}

interface RowInfoIconButtonProps {
  modelName: string;
  onShowInfo: () => void;
}

function RowInfoIconButton({
  modelName,
  onShowInfo,
}: Readonly<RowInfoIconButtonProps>): React.JSX.Element | null {
  // Solution B: only show on touch-primary devices (no hover capability).
  // Using the JS hook (not a CSS media query) so the dev `Touch Mode` toggle
  // in the sidebar actually exercises this code path on a desktop browser.
  const isTouchDevice = useIsTouchDevice();
  if (!isTouchDevice) return null;
  return (
    <button
      data-testid={TEST_IDS.rowInfoIcon}
      type="button"
      aria-label={`Show details for ${modelName}`}
      className="text-muted-foreground hover:bg-muted/50 hover:text-foreground relative flex w-12 shrink-0 cursor-pointer items-center justify-center self-stretch rounded transition-colors"
      onClick={(e) => {
        e.stopPropagation();
        onShowInfo();
      }}
    >
      <Info className="h-5 w-5" />
    </button>
  );
}

interface RowChevronButtonProps {
  modelName: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

function RowChevronButton({
  modelName,
  isExpanded,
  onToggleExpand,
}: Readonly<RowChevronButtonProps>): React.JSX.Element {
  const ChevronIcon = isExpanded ? ChevronUp : ChevronDown;
  const ariaLabel = isExpanded
    ? `Collapse details for ${modelName}`
    : `Show details for ${modelName}`;
  return (
    <button
      data-testid={TEST_IDS.rowExpandChevron}
      type="button"
      aria-label={ariaLabel}
      aria-expanded={isExpanded}
      className="text-muted-foreground hover:bg-muted/50 hover:text-foreground relative flex w-12 shrink-0 cursor-pointer items-center justify-center self-stretch rounded transition-colors"
      onClick={(e) => {
        e.stopPropagation();
        onToggleExpand();
      }}
    >
      <ChevronIcon className="h-5 w-5" />
    </button>
  );
}

interface RowExpandedInfoProps {
  model: Model;
  pickerMode: PickerMode;
  isSelected: boolean;
  onActivate: () => void;
}

function RowExpandedInfo({
  model,
  pickerMode,
  isSelected,
  onActivate,
}: Readonly<RowExpandedInfoProps>): React.JSX.Element {
  return (
    <div
      data-testid={TEST_IDS.rowExpandedInfo}
      className="border-border-strong border-t px-4 pt-3 pb-4"
    >
      <ModelInfoPanel model={model} compact />
      <Button
        type="button"
        variant="default"
        size="sm"
        className="mt-3 w-full"
        onClick={(e) => {
          e.stopPropagation();
          onActivate();
        }}
        data-testid={TEST_IDS.rowExpandedUseButton}
      >
        {expandedRowButtonLabel(pickerMode, isSelected, model.name)}
      </Button>
    </div>
  );
}

interface RowSecondaryAffordanceProps {
  modelName: string;
  isExpanded: boolean;
  isMobile: boolean;
  onShowInfo: () => void;
  onToggleExpand: () => void;
}

function RowSecondaryAffordance({
  modelName,
  isExpanded,
  isMobile,
  onShowInfo,
  onToggleExpand,
}: Readonly<RowSecondaryAffordanceProps>): React.JSX.Element {
  if (isMobile) {
    return (
      <RowChevronButton
        modelName={modelName}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
      />
    );
  }
  return <RowInfoIconButton modelName={modelName} onShowInfo={onShowInfo} />;
}

function modelListItemRowClass(params: {
  isSelected: boolean;
  isFocused: boolean;
  isDisabled: boolean;
  isPulsing: boolean;
  isUnavailable: boolean;
}): string {
  return cn(
    'group/row relative flex flex-col rounded-md transition-colors',
    params.isSelected && 'bg-accent/50',
    params.isFocused && 'ring-primary ring-2',
    params.isDisabled && 'pointer-events-none opacity-40',
    // opacity-60, not lower: greyed rows must stay perceivable for
    // low-vision users while reading as non-interactive. No
    // pointer-events-none — the cause tooltip must stay reachable.
    params.isUnavailable && 'opacity-60',
    params.isPulsing && 'animate-picker-pulse'
  );
}

export function ModelListItem({
  model,
  isFocused,
  isSelected,
  isDisabled,
  availability,
  pickerMode,
  pinnedLabel,
  isExpanded,
  isMobile,
  isPulsing,
  cascadeIndex,
  onActivate,
  onHover,
  onShowInfo,
  onToggleExpand,
}: Readonly<ModelListItemProps>): React.JSX.Element {
  // ONE greyed state with ONE reason. The premium lock used to be a separate
  // gate with its own overlay and its own sentence; it is now a reason like
  // any other, which is what keeps a condition from acquiring a second
  // phrasing by being explained on a second surface.
  const isUnavailable = !availability.available;
  const reasonText = availability.available ? '' : noticeText(availability.reason);
  const showInlineExpansion = isExpanded && isMobile;
  const reasonId = React.useId();

  return (
    <div
      data-testid={TEST_ID_BUILDERS.modelItem(model.id)}
      data-selected={isSelected}
      data-expanded={isExpanded}
      data-pulsing={isPulsing ? 'true' : undefined}
      data-unavailable={isUnavailable ? 'true' : undefined}
      className={modelListItemRowClass({
        isSelected,
        isFocused,
        isDisabled,
        isPulsing,
        isUnavailable,
      })}
      role="option"
      aria-selected={isSelected}
    >
      {isUnavailable && (
        <div
          data-testid={TEST_IDS.premiumOverlay}
          className="bg-background/60 pointer-events-none absolute inset-0 rounded-md"
        />
      )}

      <div className="flex">
        <RowMainButton
          model={model}
          pickerMode={pickerMode}
          isSelected={isSelected}
          isFocused={isFocused}
          isDisabled={isDisabled}
          isUnavailable={isUnavailable}
          reason={availability.available ? undefined : availability.reason}
          reasonText={reasonText}
          reasonId={reasonId}
          pinnedLabel={pinnedLabel}
          cascadeIndex={cascadeIndex}
          onActivate={onActivate}
          onHover={onHover}
        />
        <RowSecondaryAffordance
          modelName={model.name}
          isExpanded={isExpanded}
          isMobile={isMobile}
          onShowInfo={onShowInfo}
          onToggleExpand={onToggleExpand}
        />
      </div>

      {showInlineExpansion && (
        <RowExpandedInfo
          model={model}
          pickerMode={pickerMode}
          isSelected={isSelected}
          onActivate={onActivate}
        />
      )}
    </div>
  );
}
