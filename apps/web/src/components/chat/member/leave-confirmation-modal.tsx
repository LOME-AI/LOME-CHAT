import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, useAsyncAction } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { ActionModal } from '@/components/shared/action-modal.js';
import type { ErrorCode } from '@hushbox/shared';

interface LeaveConfirmationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isOwner: boolean;
  onConfirm: () => void | Promise<void>;
}

// Owner leave deletes the conversation (no rotation); non-owner leave runs
// `executeWithRotation` which can race against concurrent member edits.
const LEAVE_ERROR_CODES = [
  'STALE_EPOCH',
  'WRAP_SET_MISMATCH',
] as const satisfies readonly ErrorCode[];

export function LeaveConfirmationModal({
  open,
  onOpenChange,
  isOwner,
  onConfirm,
}: Readonly<LeaveConfirmationModalProps>): React.JSX.Element {
  const asyncAction = useAsyncAction();

  return (
    <ActionModal
      open={open}
      onOpenChange={onOpenChange}
      title="Leave Conversation?"
      ariaLabel="Leave Conversation"
      asyncAction={asyncAction}
      primary={{
        label: 'Leave',
        loadingLabel: 'Leaving…',
        variant: 'destructive',
        // `await` on a non-Promise resolves immediately, so we can adapt the
        // void-or-Promise callback to ActionModal's Promise-returning
        // contract without a runtime `instanceof Promise` check.
        onSubmit: async () => {
          await onConfirm();
        },
        testId: TEST_IDS.leaveConfirmationConfirm,
      }}
      cancel={{
        label: 'Cancel',
        testId: TEST_IDS.leaveConfirmationCancel,
      }}
      testId={TEST_IDS.leaveConfirmationModal}
      titleTestId={TEST_IDS.leaveConfirmationTitle}
      devSimulateCodes={LEAVE_ERROR_CODES}
    >
      <Alert data-testid={TEST_IDS.leaveConfirmationWarning}>
        <AlertTriangle />
        <span>
          {isOwner
            ? 'As the owner, leaving will delete all messages and remove all members.'
            : "You will lose access to this conversation's messages."}
        </span>
      </Alert>
    </ActionModal>
  );
}
