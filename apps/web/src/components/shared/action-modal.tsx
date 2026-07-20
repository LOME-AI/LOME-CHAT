import * as React from 'react';
import {
  Button,
  InlineFormError,
  ModalActions,
  Overlay,
  OverlayContent,
  OverlayHeader,
  type ModalActionButton,
  type OverlayContentProps,
  type UseAsyncActionReturn,
} from '@hushbox/ui';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { DevOnly } from './dev-only';
import type { ErrorCode } from '@hushbox/shared';

export interface ActionModalPrimaryButton {
  label: string;
  loadingLabel?: string;
  variant?: 'default' | 'destructive' | 'outline';
  disabled?: boolean;
  /**
   * Async work to perform. Runs through `asyncAction.run`; on resolve the
   * modal closes, on reject the inline error region renders and the modal
   * stays open for retry.
   */
  onSubmit: () => Promise<unknown>;
  testId?: string;
  /**
   * HTML button type. Defaults to `'button'`. Set to `'submit'` (with `form`)
   * to wire Enter-key implicit submission to the primary handler — the
   * browser fires `click` on the linked submit button, which routes through
   * `onSubmit`.
   */
  type?: 'button' | 'submit';
  /** `form` attribute — links a `type='submit'` button to a form by id. */
  form?: string;
}

export interface ActionModalCancelButton {
  label: string;
  onClick?: () => void;
  testId?: string;
}

export interface ActionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Hook return value from `useAsyncAction()`. Owns isPending, error, errorKey. */
  asyncAction: UseAsyncActionReturn;
  primary: ActionModalPrimaryButton;
  cancel?: ActionModalCancelButton;
  /**
   * Dev-only failure-simulator buttons. One button per code. Each fires the
   * exact same surface path as a real server-returned failure — no network
   * call. Hidden in CI and production via the `DevOnly` wrapper.
   */
  devSimulateCodes?: readonly (ErrorCode | (string & {}))[];
  ariaLabel?: string;
  testId: string;
  /** Optional test id placed on the title wrapper (for legacy assertion shapes). */
  titleTestId?: string;
  /** Forwarded to the underlying Overlay — controls auto-focus on open. */
  onOpenAutoFocus?: (event: Event) => void;
  /** Form / input children. Their `onChange` events auto-clear the inline error. */
  children: React.ReactNode;
  /** Size variant. */
  size?: OverlayContentProps['size'];
}

function ActionTitle({
  title,
  titleTestId,
}: Readonly<{ title: string; titleTestId: string | undefined }>): React.JSX.Element {
  if (titleTestId === undefined) {
    return <OverlayHeader title={title} />;
  }
  return (
    <div data-testid={titleTestId}>
      <OverlayHeader title={title} />
    </div>
  );
}

function DevSimulateButtons({
  codes,
  onSimulate,
}: Readonly<{
  codes: readonly (ErrorCode | (string & {}))[];
  onSimulate: (code: ErrorCode | (string & {})) => void;
}>): React.JSX.Element | null {
  if (codes.length === 0) return null;
  return (
    <DevOnly>
      <div className="flex flex-col gap-2" data-testid={TEST_IDS.devSimulateFailures}>
        {codes.map((code) => (
          <Button
            key={code}
            type="button"
            variant="outline"
            onClick={() => {
              onSimulate(code);
            }}
            data-testid={TEST_ID_BUILDERS.devSimulate(String(code))}
            className="w-full"
          >
            Simulate {String(code)}
          </Button>
        ))}
      </div>
    </DevOnly>
  );
}

function buildPrimaryConfig(
  primary: ActionModalPrimaryButton,
  onClick: () => void,
  isPending: boolean
): ModalActionButton {
  // Optional fields are only added when defined — ModalActions distinguishes
  // `prop: undefined` from `prop` not being there at all in a few places.
  const config: ModalActionButton = {
    label: primary.label,
    onClick,
    loading: isPending,
    disabled: primary.disabled === true || isPending,
  };
  if (primary.loadingLabel !== undefined) config.loadingLabel = primary.loadingLabel;
  if (primary.variant !== undefined) config.variant = primary.variant;
  if (primary.testId !== undefined) config.testId = primary.testId;
  if (primary.type !== undefined) config.type = primary.type;
  if (primary.form !== undefined) config.form = primary.form;
  return config;
}

function buildCancelConfig(
  cancel: ActionModalCancelButton,
  onClick: () => void,
  isPending: boolean
): ModalActionButton {
  const config: ModalActionButton = {
    label: cancel.label,
    onClick,
    disabled: isPending,
  };
  if (cancel.testId !== undefined) config.testId = cancel.testId;
  return config;
}

/**
 * Composite modal for an async user action (add member, remove member, save
 * settings, etc.). Standardises the four properties that every action modal
 * in the app needs and that have historically been re-implemented (or
 * forgotten) per-modal:
 *
 *   1. Loading state on the primary button (spinner + disabled, stable width).
 *   2. Inline error region below the form when the action fails.
 *   3. Dismiss-lock while pending — Escape, backdrop click, mobile swipe-down,
 *      close button all suppressed until the in-flight action settles.
 *   4. Auto-clear-on-input — any keystroke in a child input dismisses the
 *      inline error so the user doesn't read a stale message during retry.
 *
 * The primitive intentionally never falls back to a toast — toasts are the
 * wrong UX for action errors per NN/G (users miss them). Use
 * `useAsyncAction({ fallback: 'toast' })` for non-modal mutations instead.
 */
export function ActionModal({
  open,
  onOpenChange,
  title,
  asyncAction,
  primary,
  cancel,
  devSimulateCodes,
  ariaLabel,
  testId,
  titleTestId,
  onOpenAutoFocus,
  children,
  size,
}: Readonly<ActionModalProps>): React.JSX.Element {
  const { isPending, error, errorKey, run, clearError, simulateFailure } = asyncAction;

  const handlePrimary = React.useCallback((): void => {
    void (async (): Promise<void> => {
      const result = await run(primary.onSubmit);
      // Discriminated result: `ok: true` means the action resolved (even if
      // its value was undefined); `ok: false` means it threw and the hook
      // already populated `error` + bumped `errorKey`. Only close on success.
      if (result.ok) {
        onOpenChange(false);
      }
    })();
  }, [run, primary, onOpenChange]);

  const handleCancel = React.useCallback((): void => {
    cancel?.onClick?.();
    onOpenChange(false);
  }, [cancel, onOpenChange]);

  // Auto-clear-on-input: only react when the change/input bubbled up from an
  // actual form control. Catching arbitrary descendant change events would
  // clear errors prematurely if a non-form widget (custom Switch, etc.)
  // bubbles a synthetic `onChange`.
  const handleChange = React.useCallback(
    (event: React.SyntheticEvent): void => {
      if (error === null) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        clearError();
      }
    },
    [error, clearError]
  );

  const overlayProps = onOpenAutoFocus === undefined ? {} : { onOpenAutoFocus };
  const contentProps = size === undefined ? {} : { size };

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel={ariaLabel ?? title}
      dismissible={!isPending}
      {...overlayProps}
    >
      <OverlayContent data-testid={testId} {...contentProps}>
        <ActionTitle title={title} titleTestId={titleTestId} />

        {/* Children form region. The `onChange` capture clears stale errors
            without each modal having to wire it manually. */}
        <div onChange={handleChange} onInput={handleChange}>
          {children}
        </div>

        <InlineFormError error={error} errorKey={errorKey} />

        <ModalActions
          {...(cancel === undefined
            ? {}
            : { cancel: buildCancelConfig(cancel, handleCancel, isPending) })}
          primary={buildPrimaryConfig(primary, handlePrimary, isPending)}
        />

        {devSimulateCodes !== undefined && (
          <DevSimulateButtons codes={devSimulateCodes} onSimulate={simulateFailure} />
        )}
      </OverlayContent>
    </Overlay>
  );
}
