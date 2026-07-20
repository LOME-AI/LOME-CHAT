import * as React from 'react';
import { useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import { Alert, Input, useAsyncAction } from '@hushbox/ui';
import {
  MAX_CONVERSATION_MEMBERS,
  displayUsername,
  TEST_IDS,
  TEST_ID_BUILDERS,
  type ErrorCode,
} from '@hushbox/shared';
import { ActionModal } from '@/components/shared/action-modal.js';
import { CheckboxField } from '@/components/shared/checkbox-field.js';
import { useUserSearch } from '@/hooks/realtime/use-user-search.js';

interface SelectedUser {
  id: string;
  username: string;
  publicKey: string;
}

interface AddMemberModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  memberCount?: number;
  onAddMember: (params: {
    userId: string;
    username: string;
    publicKey: string;
    privilege: string;
    giveFullHistory: boolean;
  }) => void | Promise<void>;
}

// Failure modes the add-member endpoint can surface (server-side codes from
// apps/api/src/routes/members.ts and apps/api/src/services/keys/keys.ts).
// One DevOnly button per code so the visual treatment of each friendly
// message can be reviewed in the running app.
const ADD_MEMBER_ERROR_CODES = [
  'STALE_EPOCH',
  'WRAP_SET_MISMATCH',
  'MEMBER_LIMIT_REACHED',
] as const satisfies readonly ErrorCode[];

export function AddMemberModal({
  open,
  onOpenChange,
  conversationId,
  memberCount,
  onAddMember,
}: Readonly<AddMemberModalProps>): React.JSX.Element {
  const atCapacity = memberCount !== undefined && memberCount >= MAX_CONVERSATION_MEMBERS;
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<SelectedUser | null>(null);
  const [privilege, setPrivilege] = useState('write');
  const [giveFullHistory, setGiveFullHistory] = useState(false);
  const asyncAction = useAsyncAction();

  const { data } = useUserSearch(searchQuery, {
    excludeConversationId: conversationId,
  });

  const users =
    (data as { users: { id: string; username: string; publicKey: string }[] } | undefined)?.users ??
    [];

  function handleSelectUser(user: { id: string; username: string; publicKey: string }): void {
    setSelectedUser({ id: user.id, username: user.username, publicKey: user.publicKey });
    setSearchQuery('');
  }

  // ActionModal's primary.onSubmit runs through useAsyncAction.run. Returning
  // the Promise from onAddMember (or a resolved one for sync callers) lets
  // the modal close on success and surface the inline error on failure.
  const handleSubmit = React.useCallback(async (): Promise<void> => {
    /* v8 ignore next -- defensive guard: the submit button is disabled while selectedUser is null, so ActionModal never invokes onSubmit without a selection */
    if (!selectedUser) throw new Error('VALIDATION');
    const maybe = onAddMember({
      userId: selectedUser.id,
      username: selectedUser.username,
      publicKey: selectedUser.publicKey,
      privilege,
      giveFullHistory,
    });
    if (maybe instanceof Promise) await maybe;
  }, [selectedUser, onAddMember, privilege, giveFullHistory]);

  return (
    <ActionModal
      open={open}
      onOpenChange={onOpenChange}
      title="Add Member"
      ariaLabel="Add Member"
      asyncAction={asyncAction}
      size="md"
      primary={{
        label: 'Add Member',
        loadingLabel: 'Adding…',
        onSubmit: handleSubmit,
        disabled: !selectedUser || atCapacity,
        testId: TEST_IDS.addMemberSubmitButton,
      }}
      cancel={{
        label: 'Cancel',
        testId: TEST_IDS.addMemberCancelButton,
      }}
      testId={TEST_IDS.addMemberModal}
      devSimulateCodes={ADD_MEMBER_ERROR_CODES}
    >
      <div className="flex flex-col gap-4">
        {atCapacity && (
          <Alert>
            <AlertTriangle />
            <span>
              This conversation has reached the maximum of {MAX_CONVERSATION_MEMBERS} members.
            </span>
          </Alert>
        )}

        <div>
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              data-testid={TEST_IDS.addMemberSearchInput}
              type="text"
              placeholder="Search by username..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
              }}
              className="pl-9"
            />
            {users.length > 0 && (
              <div className="border-border bg-background absolute top-full z-10 mt-1 max-h-40 w-full overflow-y-auto rounded-md border shadow-md">
                {users.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    data-testid={TEST_ID_BUILDERS.addMemberResult(user.id)}
                    onClick={() => {
                      handleSelectUser(user);
                    }}
                    className={`hover:bg-accent flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors ${
                      selectedUser?.id === user.id ? 'bg-accent' : ''
                    }`}
                  >
                    <span className="bg-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium uppercase">
                      {displayUsername(user.username).charAt(0)}
                    </span>
                    <span className="text-sm">{displayUsername(user.username)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {selectedUser && (
            <div
              data-testid={TEST_IDS.addMemberSelected}
              className="border-border rounded-md border px-3 py-2 text-sm"
            >
              Selected:{' '}
              <span className="font-medium">{displayUsername(selectedUser.username)}</span>
            </div>
          )}
        </div>

        <div>
          <label
            htmlFor="privilege-select"
            className="text-muted-foreground mb-1 block text-xs font-medium uppercase"
          >
            Privilege
          </label>
          <select
            id="privilege-select"
            data-testid={TEST_IDS.addMemberPrivilegeSelect}
            value={privilege}
            onChange={(e) => {
              setPrivilege(e.target.value);
            }}
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        <div>
          <CheckboxField
            id="history-checkbox"
            checked={giveFullHistory}
            onCheckedChange={setGiveFullHistory}
            label="Give access to all history"
            description="Leaving this unchecked will only show messages from now on"
            testId={TEST_IDS.addMemberHistoryCheckbox}
          />
        </div>
      </div>
    </ActionModal>
  );
}
