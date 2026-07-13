import * as React from 'react';
import { useState, useRef, useEffect } from 'react';
import { AlertTriangle, Link as LinkIcon } from 'lucide-react';
import {
  Alert,
  Overlay,
  OverlayContent,
  OverlayHeader,
  ModalActions,
  Input,
  InlineFormError,
  useAsyncAction,
} from '@hushbox/ui';
import { createSharedLink } from '@hushbox/crypto';
import { fromBase64, toBase64, MAX_CONVERSATION_MEMBERS, TEST_IDS } from '@hushbox/shared';
import { CheckboxField } from '@/components/shared/checkbox-field.js';
import { useCreateLink } from '@/hooks/realtime/use-conversation-links.js';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav.js';
import { executeWithRotation } from '@/lib/rotation.js';
import type { MemberKeyResponse, RotationMember } from '@/lib/rotation.js';

interface InviteLinkModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  currentEpochPrivateKey: Uint8Array;
  currentEpochNumber: number;
  plaintextTitle: string;
  memberCount?: number;
}

export function InviteLinkModal({
  open,
  onOpenChange,
  conversationId,
  currentEpochPrivateKey,
  currentEpochNumber,
  plaintextTitle,
  memberCount,
}: Readonly<InviteLinkModalProps>): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const atCapacity = memberCount !== undefined && memberCount >= MAX_CONVERSATION_MEMBERS;
  const [privilege, setPrivilege] = useState('read');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Drive the "Copied" → "Copy" reset from an effect so the timer is owned by
  // React: it's cleared on unmount and when copy is pressed again before it
  // elapses, preventing a state update on an unmounted component.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  const { mutateAsync } = useCreateLink();
  // useAsyncAction wraps the generate flow: manages isPending + populates the
  // inline error region on failure. We don't use ActionModal here because the
  // success path transitions to the "show URL" phase rather than closing.
  const asyncAction = useAsyncAction();
  const { isPending, error, errorKey, run, clearError } = asyncAction;

  const [previousOpen, setPreviousOpen] = useState(open);
  if (open !== previousOpen) {
    setPreviousOpen(open);
    if (open) {
      setPrivilege('read');
      setIncludeHistory(false);
      setGuestName('');
      setGeneratedUrl(null);
      setCopied(false);
      clearError();
    }
  }

  async function handleGenerate(): Promise<void> {
    const generateResult = await run(async () => {
      const result = createSharedLink(currentEpochPrivateKey);
      const trimmedName = guestName.trim();
      const linkPublicKeyB64 = toBase64(result.linkPublicKey);
      const memberWrapB64 = toBase64(result.linkWrap);

      if (includeHistory) {
        await mutateAsync({
          conversationId,
          linkPublicKey: linkPublicKeyB64,
          memberWrap: memberWrapB64,
          privilege,
          giveFullHistory: true,
          expectedEpoch: currentEpochNumber,
          ...(trimmedName !== '' && { displayName: trimmedName }),
        });
      } else {
        const linkPublicKey = result.linkPublicKey;
        await executeWithRotation({
          conversationId,
          currentEpochPrivateKey,
          currentEpochNumber,
          plaintextTitle,
          filterMembers: (keys: MemberKeyResponse[]): RotationMember[] => {
            const members: RotationMember[] = [];
            for (const k of keys) {
              members.push({ publicKey: fromBase64(k.publicKey) });
            }
            members.push({ publicKey: linkPublicKey });
            return members;
          },
          execute: (rotation) =>
            mutateAsync({
              conversationId,
              linkPublicKey: linkPublicKeyB64,
              memberWrap: memberWrapB64,
              privilege,
              giveFullHistory: false,
              rotation,
              ...(trimmedName !== '' && { displayName: trimmedName }),
            }),
        });
      }

      return `${globalThis.location.origin}/share/c/${conversationId}#${toBase64(result.linkSecret)}`;
    });

    if (generateResult.ok) setGeneratedUrl(generateResult.value);
  }

  function handleCancel(): void {
    onOpenChange(false);
  }

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Invite via Link"
      dismissible={!isPending}
    >
      <OverlayContent data-testid={TEST_IDS.inviteLinkModal} size="md">
        <OverlayHeader title="Invite via Link" />

        {generatedUrl === null ? (
          <>
            <form
              id="invite-link-form"
              ref={formRef}
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void handleGenerate();
              }}
            >
              <p className="text-muted-foreground text-sm">
                Create a link for someone without a HushBox account to access this conversation.
              </p>

              {atCapacity && (
                <Alert>
                  <AlertTriangle />
                  <span>
                    This conversation has reached the maximum of {MAX_CONVERSATION_MEMBERS} members.
                  </span>
                </Alert>
              )}

              <Alert data-testid={TEST_IDS.inviteLinkWarning}>
                <AlertTriangle />
                <span>
                  Anyone with this link can decrypt the entire conversation. Only share it with
                  people you trust.
                </span>
              </Alert>

              <div>
                <label
                  htmlFor="invite-privilege-select"
                  className="text-muted-foreground mb-1 block text-xs font-medium uppercase"
                >
                  Permission
                </label>
                <select
                  id="invite-privilege-select"
                  data-testid={TEST_IDS.inviteLinkPrivilegeSelect}
                  value={privilege}
                  onChange={(e) => {
                    setPrivilege(e.target.value);
                  }}
                  className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                >
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                </select>
              </div>

              <div>
                <CheckboxField
                  id="invite-history-checkbox"
                  checked={includeHistory}
                  onCheckedChange={setIncludeHistory}
                  label="Give access to all history"
                  description="Leaving this unchecked will only show messages from now on"
                  testId={TEST_IDS.inviteLinkHistoryCheckbox}
                />
              </div>

              <div>
                <label
                  htmlFor="invite-name-input"
                  className="text-muted-foreground mb-1 block text-xs font-medium uppercase"
                >
                  Guest name (optional)
                </label>
                <Input
                  id="invite-name-input"
                  data-testid={TEST_IDS.inviteLinkNameInput}
                  type="text"
                  placeholder="This can be changed later"
                  value={guestName}
                  onChange={(e) => {
                    setGuestName(e.target.value);
                  }}
                />
              </div>

              {privilege === 'write' && (
                <p className="text-muted-foreground text-xs">
                  To let link guests send messages, allocate them a budget in Budget Settings.
                </p>
              )}
            </form>

            <InlineFormError error={error} errorKey={errorKey} />

            <ModalActions
              cancel={{
                label: 'Cancel',
                onClick: handleCancel,
                testId: TEST_IDS.inviteLinkCancelButton,
              }}
              primary={{
                label: 'Generate Link',
                form: 'invite-link-form',
                onClick: () => {
                  void handleGenerate();
                },
                disabled: isPending || atCapacity,
                testId: TEST_IDS.inviteLinkGenerateButton,
              }}
            />
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm text-green-600">
              <LinkIcon className="h-4 w-4" />
              <span>Link created! You can manage or revoke it from the member list.</span>
            </div>

            <div
              data-testid={TEST_IDS.inviteLinkUrl}
              className="bg-muted overflow-hidden rounded-md p-3 text-xs break-all"
            >
              {generatedUrl}
            </div>

            <ModalActions
              cancel={{
                label: 'Done',
                onClick: () => {
                  onOpenChange(false);
                },
              }}
              primary={{
                label: copied ? 'Copied' : 'Copy',
                onClick: () => {
                  void navigator.clipboard.writeText(generatedUrl);
                  setCopied(true);
                },
                testId: TEST_IDS.inviteLinkCopyButton,
              }}
            />
          </>
        )}
      </OverlayContent>
    </Overlay>
  );
}
