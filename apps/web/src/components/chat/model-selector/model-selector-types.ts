/** Shared props for premium/auth gating across model selector components. */
export interface ModelSelectorGatingProps {
  /** Set of premium model IDs */
  premiumIds?: Set<string> | undefined;
  /** Whether the user is authenticated (defaults to true) */
  isAuthenticated?: boolean | undefined;
  /** Whether the user is a link guest (suppresses premium overlay) */
  isLinkGuest?: boolean | undefined;
  /** Called when user clicks a premium model they cannot access */
  onPremiumClick?: ((modelId: string) => void) | undefined;
}

/**
 * The conversation the picker was opened from. It NAMES THE PAYER: an
 * owner-funded group turn is priced from the owner's wallet, so the producer
 * needs the conversation to ask for the right one.
 */
export interface PickerConversationContext {
  readonly conversationId: string;
}
