import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders as render } from '@/test-utils/render';
import { ChatLayoutModals } from '@/components/chat/layout/chat-layout-modals';

let lastShareModalProps: Record<string, unknown> | null = null;

vi.mock('@/hooks/billing/billing', () => ({
  billingKeys: { balance: () => ['balance'] },
}));

vi.mock('@/components/auth/signup-modal', () => ({
  SignupModal: (): null => null,
}));

vi.mock('@/components/billing/payment-modal', () => ({
  PaymentModal: (): null => null,
}));

vi.mock('@/components/chat/message/share-message-modal', () => ({
  ShareMessageModal: (props: Record<string, unknown>): null => {
    lastShareModalProps = props;
    return null;
  },
}));

describe('ChatLayoutModals', () => {
  beforeEach(() => {
    lastShareModalProps = null;
  });

  function renderModals(): void {
    render(
      <ChatLayoutModals
        signupModalOpen={false}
        setSignupModalOpen={() => {}}
        paymentModalOpen={false}
        setPaymentModalOpen={() => {}}
        premiumModelName={undefined}
        shareMessageModalOpen
        closeShareMessageModal={() => {}}
        shareMessageId="m1"
        shareMessageConversationId="conv-1"
        sharedMessageContent="hi"
        sharedMessageEpochNumber={3}
        sharedMessageWrappedContentKey="wrapped"
        sharedMessageMediaItems={null}
        sharedMessageSenderId="sender-42"
        groupChat={undefined}
        title={undefined}
        addMemberModalOpen={false}
        closeAddMemberModal={() => {}}
        budgetSettingsModalOpen={false}
        closeBudgetSettingsModal={() => {}}
        inviteLinkModalOpen={false}
        closeInviteLinkModal={() => {}}
      />
    );
  }

  it('forwards the shared message senderId to ShareMessageModal so its media preview can build the envelope', () => {
    renderModals();

    expect(lastShareModalProps?.['senderId']).toBe('sender-42');
  });
});
