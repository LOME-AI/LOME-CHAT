import * as React from 'react';
import { useState, useMemo, useRef } from 'react';
import {
  Overlay,
  OverlayContent,
  OverlayHeader,
  ModalActions,
  Input,
  InlineFormError,
  useAsyncAction,
} from '@hushbox/ui';
import {
  displayUsername,
  dollarsToCents,
  nanoUsdToDollarString,
  TEST_IDS,
  TEST_ID_BUILDERS,
} from '@hushbox/shared';
import {
  useConversationBudgets,
  useUpdateMemberBudget,
  useUpdateConversationBudget,
  type ConversationBudgetsResponse,
} from '@/hooks/billing/use-conversation-budgets.js';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav.js';

type MemberBudget = ConversationBudgetsResponse['members'][number];

interface MemberInfo {
  id: string;
  userId: string | null;
  linkId?: string | null;
  username: string | null;
  privilege: string;
}

interface BudgetSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  members: readonly MemberInfo[];
  currentUserPrivilege: string;
}

interface BudgetRowProps {
  label: string;
  budgetValue: string;
  spentValue: string;
  isEditable?: boolean;
  isSummary?: boolean;
  onChange?: (value: string) => void;
  inputTestId?: string;
  spentTestId?: string;
  rowTestId?: string;
}

/** Cents for comparison/submission, treating blank as zero so an empty field
 *  reads as $0.00 rather than NaN. Callers guarantee `dollars` is valid money
 *  via {@link isValidMoneyInput}. */
function moneyToCents(dollars: string): number {
  if (dollars === '') return 0;
  return dollarsToCents(dollars);
}

/** Accepts the empty string and non-negative money with up to two decimals.
 *  Rejects letters, signs, and over-precise input before it reaches state, so
 *  NaN/negative cents can never be submitted to the API. */
function isValidMoneyInput(value: string): boolean {
  return value === '' || /^\d*(\.\d{0,2})?$/.test(value);
}

function BudgetRow({
  label,
  budgetValue,
  spentValue,
  isEditable,
  isSummary,
  onChange,
  inputTestId,
  spentTestId,
  rowTestId,
}: Readonly<BudgetRowProps>): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 py-1.5" data-testid={rowTestId}>
      <div className={`min-w-[80px] flex-1 text-sm ${isSummary ? 'font-medium' : ''}`}>{label}</div>
      <div className="w-28 text-right">
        {isEditable ? (
          <div className="flex items-center justify-end gap-1">
            <span className="text-muted-foreground text-sm">$</span>
            <Input
              data-testid={inputTestId}
              type="text"
              inputMode="decimal"
              value={budgetValue}
              onChange={(e) => {
                if (isValidMoneyInput(e.target.value)) {
                  onChange?.(e.target.value);
                }
              }}
              className="h-8 w-24 text-right"
            />
          </div>
        ) : (
          <span data-testid={inputTestId} className="text-sm font-medium">
            ${budgetValue}
          </span>
        )}
      </div>
      <div className="w-24 text-right">
        <span data-testid={spentTestId} className="text-muted-foreground text-xs">
          ${spentValue} spent
        </span>
      </div>
    </div>
  );
}

interface BudgetContentProps {
  formRef?: React.RefObject<HTMLFormElement | null>;
  onSubmit?: () => void;
  children: React.ReactNode;
}

function BudgetContent({
  formRef,
  onSubmit,
  children,
}: Readonly<BudgetContentProps>): React.JSX.Element {
  if (formRef && onSubmit) {
    return (
      <form
        id="budget-settings-form"
        ref={formRef}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {children}
      </form>
    );
  }
  return <>{children}</>;
}

interface BudgetFormState {
  currentConvBudget: string;
  setEditedConvBudget: React.Dispatch<React.SetStateAction<string | null>>;
  currentValues: Record<string, string>;
  editedValues: Record<string, string>;
  setEditedValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  hasChanges: boolean;
  convBudgetChanged: boolean;
  initialValues: Record<string, string>;
  allocatedCents: number;
}

function useBudgetFormState(budgetData: ConversationBudgetsResponse | undefined): BudgetFormState {
  const initialConvBudget = useMemo(() => {
    if (!budgetData) return '';
    return nanoUsdToDollarString(budgetData.conversationCapNanoUsd);
  }, [budgetData]);

  const [editedConvBudget, setEditedConvBudget] = useState<string | null>(null);

  const currentConvBudget = editedConvBudget ?? initialConvBudget;

  const initialValues = useMemo(() => {
    if (!budgetData) return {};
    const map: Record<string, string> = {};
    for (const mb of budgetData.members) {
      map[mb.memberId] = nanoUsdToDollarString(mb.capNanoUsd);
    }
    return map;
  }, [budgetData]);

  const [editedValues, setEditedValues] = useState<Record<string, string>>({});

  const currentValues = useMemo(() => {
    return { ...initialValues, ...editedValues };
  }, [initialValues, editedValues]);

  // Compare on cents, not the raw string, so re-typing the same amount in a
  // different shape ('25' vs '25.00') is a no-op rather than a phantom change.
  const convBudgetChanged =
    editedConvBudget !== null && moneyToCents(editedConvBudget) !== moneyToCents(initialConvBudget);

  const memberBudgetChanged = useMemo(() => {
    for (const [memberId, value] of Object.entries(editedValues)) {
      /* v8 ignore next -- editedValues keys are always members present in initialValues; the ?? '' only satisfies noUncheckedIndexedAccess */
      if (moneyToCents(initialValues[memberId] ?? '') !== moneyToCents(value)) return true;
    }
    return false;
  }, [editedValues, initialValues]);

  const hasChanges = convBudgetChanged || memberBudgetChanged;

  const totalMemberBudgetCents = useMemo(() => {
    if (!budgetData) return 0;
    let sum = 0;
    for (const mb of budgetData.members) {
      /* v8 ignore next -- currentValues always contains every member's id (derived from budgetData.members); the ?? only satisfies noUncheckedIndexedAccess */
      const value = currentValues[mb.memberId] ?? nanoUsdToDollarString(mb.capNanoUsd);
      sum += dollarsToCents(value);
    }
    return sum;
  }, [budgetData, currentValues]);

  const allocatedCents = useMemo(() => {
    const convCents = moneyToCents(currentConvBudget);
    if (convCents > 0) {
      return Math.min(convCents, totalMemberBudgetCents);
    }
    return totalMemberBudgetCents;
  }, [currentConvBudget, totalMemberBudgetCents]);

  return {
    currentConvBudget,
    setEditedConvBudget,
    currentValues,
    editedValues,
    setEditedValues,
    hasChanges,
    convBudgetChanged,
    initialValues,
    allocatedCents,
  };
}

export function BudgetSettingsModal({
  open,
  onOpenChange,
  conversationId,
  members,
  currentUserPrivilege,
}: Readonly<BudgetSettingsModalProps>): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const { data: budgetData, isLoading } = useConversationBudgets(conversationId);
  const { mutateAsync, isPending } = useUpdateMemberBudget();
  const { mutateAsync: convBudgetMutateAsync, isPending: convBudgetIsPending } =
    useUpdateConversationBudget();

  const isOwner = currentUserPrivilege === 'owner';
  // Surface mutation failures inline. The two sequential awaits in handleSave
  // (conv budget then per-member budgets) can each fail; useAsyncAction wraps
  // the whole sequence so the user sees one error message and can retry.
  const asyncAction = useAsyncAction();

  const {
    currentConvBudget,
    setEditedConvBudget,
    currentValues,
    editedValues,
    setEditedValues,
    hasChanges,
    convBudgetChanged,
    initialValues,
    allocatedCents,
  } = useBudgetFormState(budgetData);

  function getMemberName(mb: MemberBudget): string {
    const member = members.find((m) => m.id === mb.memberId);
    if (member?.username) return displayUsername(member.username);
    if (mb.username) return displayUsername(mb.username);
    // A member row with no user is a link guest (the response carries no linkId).
    if (mb.userId === null) return 'Guest Link';
    return 'Unknown';
  }

  function handleInputChange(memberId: string, value: string): void {
    setEditedValues((previous) => ({ ...previous, [memberId]: value }));
  }

  async function handleSave(): Promise<void> {
    const result = await asyncAction.run(async () => {
      if (convBudgetChanged) {
        await convBudgetMutateAsync({
          conversationId,
          budgetCents: moneyToCents(currentConvBudget),
        });
      }

      const changedEntries = Object.entries(editedValues).filter(
        /* v8 ignore next -- editedValues keys are always members present in initialValues; the ?? '' only satisfies noUncheckedIndexedAccess */
        ([memberId, value]) => moneyToCents(initialValues[memberId] ?? '') !== moneyToCents(value)
      );

      for (const [memberId, value] of changedEntries) {
        await mutateAsync({
          conversationId,
          memberId,
          budgetCents: moneyToCents(value),
        });
      }
    });

    if (result.ok) {
      setEditedConvBudget(null);
      setEditedValues({});
      onOpenChange(false);
    }
  }

  function handleCancel(): void {
    setEditedConvBudget(null);
    setEditedValues({});
    onOpenChange(false);
  }

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Budget Settings"
      dismissible={!asyncAction.isPending}
    >
      <OverlayContent data-testid={TEST_IDS.budgetSettingsModal} size="lg">
        <OverlayHeader
          title="Budget Settings"
          description="The owner can fund AI usage for members. When exhausted, members use their own balance."
        />

        {isLoading || !budgetData ? (
          <div
            data-testid={TEST_IDS.budgetLoading}
            className="text-muted-foreground py-8 text-center text-sm"
          >
            Loading budgets...
          </div>
        ) : (
          <>
            <BudgetContent
              {...(isOwner && { formRef })}
              {...(isOwner && {
                onSubmit: () => {
                  void handleSave();
                },
              })}
            >
              <div
                data-testid={TEST_IDS.budgetConversationSection}
                className="[scrollbar-gutter:stable] overflow-y-auto pr-2"
              >
                <span className="text-muted-foreground mb-2 block text-xs font-medium tracking-wide uppercase">
                  Conversation
                </span>
                <BudgetRow
                  label="Funding limit"
                  budgetValue={currentConvBudget}
                  spentValue={nanoUsdToDollarString(budgetData.conversationSpentNanoUsd)}
                  isEditable={isOwner}
                  onChange={(value) => {
                    setEditedConvBudget(value);
                  }}
                  inputTestId={
                    isOwner ? TEST_IDS.budgetConversationInput : TEST_IDS.budgetConversationValue
                  }
                  spentTestId={TEST_IDS.budgetTotalSpent}
                />
              </div>

              {budgetData.members.length > 0 && (
                <>
                  <div>
                    <span className="text-muted-foreground mb-2 block text-xs font-medium tracking-wide uppercase">
                      Members
                    </span>
                    <div
                      data-testid={TEST_IDS.budgetMembersList}
                      className="max-h-60 [scrollbar-gutter:stable] space-y-1 overflow-y-auto pr-2"
                    >
                      {budgetData.members.map((mb) => (
                        <BudgetRow
                          key={mb.memberId}
                          label={getMemberName(mb)}
                          /* v8 ignore next -- currentValues always contains every member's id (derived from budgetData.members); the ?? only satisfies noUncheckedIndexedAccess */
                          budgetValue={
                            currentValues[mb.memberId] ?? nanoUsdToDollarString(mb.capNanoUsd)
                          }
                          spentValue={nanoUsdToDollarString(mb.spentNanoUsd)}
                          isEditable={isOwner}
                          onChange={(value) => {
                            handleInputChange(mb.memberId, value);
                          }}
                          inputTestId={
                            isOwner
                              ? TEST_ID_BUILDERS.budgetInput(mb.memberId)
                              : TEST_ID_BUILDERS.budgetValue(mb.memberId)
                          }
                          spentTestId={TEST_IDS.budgetSpent}
                          rowTestId={TEST_ID_BUILDERS.budgetMember(mb.memberId)}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="border-border [scrollbar-gutter:stable] overflow-y-auto border-t pt-3 pr-2">
                    <BudgetRow
                      label="Allocated"
                      budgetValue={(allocatedCents / 100).toFixed(2)}
                      spentValue={nanoUsdToDollarString(budgetData.conversationSpentNanoUsd)}
                      isSummary
                      rowTestId={TEST_IDS.budgetTotalAllocated}
                    />
                  </div>
                </>
              )}
            </BudgetContent>

            <InlineFormError error={asyncAction.error} errorKey={asyncAction.errorKey} />

            {isOwner ? (
              <ModalActions
                cancel={{
                  label: 'Cancel',
                  onClick: handleCancel,
                  testId: TEST_IDS.budgetCancelButton,
                }}
                primary={{
                  label: 'Save Changes',
                  loadingLabel: 'Saving…',
                  form: 'budget-settings-form',
                  onClick: () => {
                    void handleSave();
                  },
                  disabled: !hasChanges || isPending || convBudgetIsPending,
                  loading: asyncAction.isPending,
                  testId: TEST_IDS.budgetSaveButton,
                }}
              />
            ) : (
              <ModalActions
                primary={{
                  label: 'Close',
                  variant: 'outline',
                  onClick: handleCancel,
                  testId: TEST_IDS.budgetCancelButton,
                }}
              />
            )}
          </>
        )}
      </OverlayContent>
    </Overlay>
  );
}
