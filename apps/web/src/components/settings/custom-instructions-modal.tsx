import * as React from 'react';
import { useState, useCallback } from 'react';
import { Textarea, UserMessageError, useAsyncAction } from '@hushbox/ui';
import { toBase64, TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import { encryptTextForEpoch, getPublicKeyFromPrivate } from '@hushbox/crypto';
import { useAuthStore } from '@/lib/auth';
import { client, fetchJson } from '@/lib/api-client';
import { ActionModal } from '@/components/shared/action-modal';

const MAX_LENGTH = 5000;

interface CustomInstructionsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function CustomInstructionsModal({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<CustomInstructionsModalProps>): React.JSX.Element | null {
  const currentInstructions = useAuthStore((s) => s.customInstructions);
  const [value, setValue] = useState(currentInstructions ?? '');
  const asyncAction = useAsyncAction();

  const { clearError } = asyncAction;
  React.useEffect(() => {
    if (open) {
      setValue(currentInstructions ?? '');
      clearError();
    }
  }, [open, currentInstructions, clearError]);

  const handleSave = useCallback(async (): Promise<void> => {
    const trimmed = value.trim();
    let encryptedBase64: string | null = null;

    if (trimmed.length > 0) {
      const privateKey = useAuthStore.getState().privateKey;
      if (!privateKey) {
        throw new UserMessageError(friendlyErrorMessage('ACCOUNT_KEY_NOT_AVAILABLE'));
      }
      const publicKey = getPublicKeyFromPrivate(privateKey);
      const encrypted = encryptTextForEpoch(publicKey, trimmed);
      encryptedBase64 = toBase64(encrypted);
    }

    try {
      // The rebuilt backend splits the legacy PATCH into PUT (set) and
      // DELETE (clear) on /account/instructions.
      await (encryptedBase64 === null
        ? fetchJson(client.account.instructions.$delete())
        : fetchJson(client.account.instructions.$put({ json: { instructions: encryptedBase64 } })));
    } catch {
      throw new UserMessageError(friendlyErrorMessage('CUSTOM_INSTRUCTIONS_SAVE_FAILED'));
    }

    useAuthStore.getState().setCustomInstructions(trimmed.length > 0 ? trimmed : null);
    onSuccess();
  }, [value, onSuccess]);

  if (!open) return null;

  return (
    <ActionModal
      open={open}
      onOpenChange={onOpenChange}
      title="Custom Instructions"
      ariaLabel="Custom instructions"
      asyncAction={asyncAction}
      primary={{
        label: 'Save',
        loadingLabel: 'Saving...',
        onSubmit: handleSave,
      }}
      testId={TEST_IDS.customInstructionsModal}
      size="md"
    >
      <p className="text-muted-foreground text-sm">
        These instructions are included in every conversation. Tell the AI about yourself and
        {"how you'd like it to respond."}
      </p>
      <div className="space-y-2">
        <Textarea
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
          }}
          maxLength={MAX_LENGTH}
          rows={6}
          placeholder="e.g., I'm a software engineer. Be concise and use code examples."
          className="resize-none overflow-y-auto"
          style={{ height: 'calc(6 * 1.5em + 1rem)' }}
        />
        <p className="text-muted-foreground text-right text-xs">
          {value.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
        </p>
      </div>
    </ActionModal>
  );
}
