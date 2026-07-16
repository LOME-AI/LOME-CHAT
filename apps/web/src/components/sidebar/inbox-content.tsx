import * as React from 'react';
import { Check, X } from 'lucide-react';
import { IconButton } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import {
  useAcceptMembership,
  useDeclineInvitation,
} from '@/hooks/realtime/use-conversation-members';
import { LeaveConfirmationModal } from '@/components/chat/member/leave-confirmation-modal';

interface InboxConversation {
  id: string;
  title: string;
  currentEpoch: number;
  updatedAt: string;
  invitedByUsername?: string | null;
}

interface InboxContentProps {
  conversations: InboxConversation[];
}

export function InboxContent({ conversations }: Readonly<InboxContentProps>): React.JSX.Element {
  const acceptMembership = useAcceptMembership();
  const declineInvitation = useDeclineInvitation();
  const [declineTarget, setDeclineTarget] = React.useState<string | null>(null);

  if (conversations.length === 0) {
    return (
      <div
        data-testid={TEST_IDS.inboxContent}
        className="text-sidebar-foreground/50 px-2 py-8 text-center text-sm"
      >
        No pending invites
      </div>
    );
  }

  return (
    <div data-testid={TEST_IDS.inboxContent} className="flex flex-col gap-2">
      {conversations.map((conv) => (
        <div key={conv.id} className="bg-sidebar-accent/30 rounded-lg px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sidebar-foreground min-w-0 flex-1 truncate text-sm font-medium">
              {conv.title}
            </p>
            <IconButton
              aria-label={`Accept ${conv.title}`}
              className="text-green-500 hover:text-green-400"
              onClick={() => {
                acceptMembership.mutate({ conversationId: conv.id });
              }}
            >
              <Check className="h-4 w-4" />
            </IconButton>
          </div>
          <div className="flex items-center justify-between gap-2">
            {conv.invitedByUsername ? (
              <p className="text-sidebar-foreground/50 min-w-0 flex-1 truncate text-xs">
                @{conv.invitedByUsername}
              </p>
            ) : (
              <span />
            )}
            <IconButton
              aria-label={`Decline ${conv.title}`}
              className="text-red-500 hover:text-red-400"
              onClick={() => {
                setDeclineTarget(conv.id);
              }}
            >
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      ))}

      <LeaveConfirmationModal
        open={declineTarget !== null}
        onOpenChange={(open) => {
          /* v8 ignore next -- the modal is controlled by declineTarget with no trigger, so onOpenChange only ever fires on close (open=false); the open=true arm is unreachable */
          if (!open) setDeclineTarget(null);
        }}
        isOwner={false}
        onConfirm={async () => {
          // Capture before clearing — declineTarget is closure state and the
          // modal close path (onOpenChange) nulls it before mutateAsync
          // resolves. Awaiting forwards any thrown error to ActionModal's
          // inline error region.
          const conversationId = declineTarget;
          /* v8 ignore next -- onConfirm only fires while the modal is open, so declineTarget is always set here; the null guard is defensive against a documented close race */
          if (conversationId) {
            await declineInvitation.mutateAsync({ conversationId });
          }
        }}
      />
    </div>
  );
}
