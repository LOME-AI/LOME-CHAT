import * as React from 'react';
import { useState, useCallback } from 'react';
import {
  CharacterCountTextarea,
  ToggleGroup,
  ToggleGroupItem,
  UserMessageError,
  useAsyncAction,
  toast,
} from '@hushbox/ui';
import {
  FEEDBACK_KINDS,
  FEEDBACK_BODY_MAX_LENGTH,
  TEST_IDS,
  ERROR_CODES,
  friendlyErrorMessage,
  type FeedbackKind,
} from '@hushbox/shared';
import { ActionModal } from '@/components/shared/action-modal';
import { getErrorBody } from '@/lib/api';
import { useSubmitFeedback } from '@/hooks/feedback/use-submit-feedback';

const KIND_META: Record<FeedbackKind, { label: string; testId: string }> = {
  bug: { label: 'Bug', testId: TEST_IDS.feedbackTypeBug },
  idea: { label: 'Idea', testId: TEST_IDS.feedbackTypeIdea },
  praise: { label: 'Praise', testId: TEST_IDS.feedbackTypePraise },
};

interface FeedbackModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FeedbackModal({
  open,
  onOpenChange,
}: Readonly<FeedbackModalProps>): React.JSX.Element | null {
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [body, setBody] = useState('');
  const asyncAction = useAsyncAction();
  const submit = useSubmitFeedback();

  const { clearError } = asyncAction;
  React.useEffect(() => {
    if (open) {
      setKind('bug');
      setBody('');
      clearError();
    }
  }, [open, clearError]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    try {
      await submit.mutateAsync({
        kind,
        body: body.trim().slice(0, FEEDBACK_BODY_MAX_LENGTH),
      });
    } catch (error) {
      // A same-body resubmit inside the dedup window answers FEEDBACK_DUPLICATE;
      // surface its specific copy so the user learns the note already landed
      // rather than the generic "couldn't send". Any other failure keeps the
      // generic message. The modal stays open either way (thrown to asyncAction).
      const code = getErrorBody(error)?.code;
      const wireCode =
        code === ERROR_CODES.FEEDBACK_DUPLICATE
          ? ERROR_CODES.FEEDBACK_DUPLICATE
          : ERROR_CODES.FEEDBACK_SUBMIT_FAILED;
      throw new UserMessageError(friendlyErrorMessage(wireCode));
    }
    toast.success('Thanks — we read every one.');
  }, [submit, kind, body]);

  if (!open) return null;

  return (
    <ActionModal
      open={open}
      onOpenChange={onOpenChange}
      title="Send feedback"
      ariaLabel="Send feedback"
      asyncAction={asyncAction}
      primary={{
        label: 'Send',
        loadingLabel: 'Sending...',
        onSubmit: handleSubmit,
        disabled: body.trim().length === 0,
        testId: TEST_IDS.feedbackSubmit,
      }}
      testId={TEST_IDS.feedbackModal}
      size="md"
    >
      <div className="space-y-2">
        <ToggleGroup
          type="single"
          value={kind}
          onValueChange={(value) => {
            if (value) setKind(value as FeedbackKind);
          }}
          variant="outline"
          className="w-full"
          aria-label="Feedback type"
        >
          {FEEDBACK_KINDS.map((option) => (
            <ToggleGroupItem
              key={option}
              value={option}
              data-testid={KIND_META[option].testId}
              aria-label={KIND_META[option].label}
            >
              {KIND_META[option].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <CharacterCountTextarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
          }}
          limit={FEEDBACK_BODY_MAX_LENGTH}
          rows={5}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- dialog input: focus management for keyboard users opening the feedback modal
          autoFocus
          placeholder="What's on your mind?"
          data-testid={TEST_IDS.feedbackBody}
        />
        <p className="text-muted-foreground text-xs">
          Only what you type here is sent. We never see your conversations.
        </p>
      </div>
    </ActionModal>
  );
}
