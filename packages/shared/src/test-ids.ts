import type { MemberPrivilege } from './enums.js';

/**
 * Single source of truth for `data-testid` values.
 *
 * Every static id below is emitted by production source (`apps/web/src`,
 * `packages/ui/src`, `apps/marketing/src`) — directly, via `testId`/`titleTestId`/
 * `inputTestId`/`spentTestId`/`rowTestId` props, or composed through
 * `makeTestId(...)` / `${testIdPrefix}` — or is referenced from `e2e/**`.
 * Components and specs read from this registry instead of hardcoding literals,
 * so a renamed id breaks the build rather than a test at runtime.
 *
 * Keys are camelCase; values are the literal kebab-case `data-testid`.
 *
 * Templated ids (anything with a `${...}` segment in source) are NOT listed
 * here as strings — they live in `TEST_ID_BUILDERS` as typed functions so
 * call sites and specs derive the exact same value from the same place.
 */
export const TEST_IDS = {
  // App shell & navigation
  appShell: 'app-shell',
  authLayout: 'auth-layout',
  chatItemMoreButton: 'chat-item-more-button',
  chatLink: 'chat-link',
  chatListScrollContainer: 'chat-list-scroll-container',
  chatWelcome: 'chat-welcome',
  checkYourEmail: 'check-your-email',
  desktopTopQuadrant: 'desktop-top-quadrant',
  hamburgerButton: 'hamburger-button',
  landingMenuToggle: 'landing-menu-toggle',
  landingMobileMenu: 'landing-mobile-menu',
  newChatPage: 'new-chat-page',
  sidebar: 'sidebar',
  sidebarFooter: 'sidebar-footer',
  sidebarHeader: 'sidebar-header',
  sidebarNav: 'sidebar-nav',
  sidebarTrigger: 'sidebar-trigger',
  userAvatarIcon: 'user-avatar-icon',

  // App menu items
  menuAccessibility: 'menu-accessibility',
  menuAddCredits: 'menu-add-credits',
  menuAdmin: 'menu-admin',
  menuAssets: 'menu-assets',
  menuDbStudio: 'menu-db-studio',
  menuEmails: 'menu-emails',
  menuGithub: 'menu-github',
  menuLogin: 'menu-login',
  menuLogout: 'menu-logout',
  menuMarketing: 'menu-marketing',
  menuPersonas: 'menu-personas',
  menuSettings: 'menu-settings',
  menuSignup: 'menu-signup',
  menuTouchMode: 'menu-touch-mode',
  menuUsage: 'menu-usage',

  // Admin app (apps/admin)
  adminShell: 'admin-shell',
  adminNav: 'admin-nav',
  adminTopbar: 'admin-topbar',
  adminSearch: 'admin-search',
  adminActorSwitcher: 'admin-actor-switcher',
  adminDashboardJobs: 'admin-dashboard-jobs',
  adminDashboardRecent: 'admin-dashboard-recent',
  adminOpsTable: 'admin-ops-table',
  adminOpsRun: 'admin-ops-run',
  adminOpModal: 'admin-op-modal',
  adminOpForm: 'admin-op-form',
  adminOpFieldError: 'admin-op-field-error',
  adminOpDiff: 'admin-op-diff',
  adminOpError: 'admin-op-error',
  adminOpExecute: 'admin-op-execute',
  adminOpResult: 'admin-op-result',
  adminOpAuditId: 'admin-op-audit-id',
  adminOpCopyAudit: 'admin-op-copy-audit',
  adminOpUndo: 'admin-op-undo',
  adminPalette: 'admin-palette',
  adminPaletteInput: 'admin-palette-input',
  adminPaletteOption: 'admin-palette-option',
  adminAuditUndo: 'admin-audit-undo',
  adminCopyId: 'admin-copy-id',
  adminDashboardTiles: 'admin-dashboard-tiles',
  adminPanelError: 'admin-panel-error',
  adminRateLimited: 'admin-rate-limited',
  adminRateLimitedRetry: 'admin-rate-limited-retry',
  adminUserSearch: 'admin-user-search',
  adminUserSearchInput: 'admin-user-search-input',
  adminC360Header: 'admin-c360-header',
  adminC360Empty: 'admin-c360-empty',
  adminC360Miss: 'admin-c360-miss',
  adminC360Panels: 'admin-c360-panels',

  // Chat & messages
  aiMessageLiveRegion: 'ai-message-live-region',
  chatHeader: 'chat-header',
  chatTitle: 'chat-title',
  clearSelectionButton: 'clear-selection-button',
  expensiveModelWarning: 'expensive-model-warning',
  messageActions: 'message-actions',
  messageCost: 'message-cost',
  messageIcon: 'message-icon',
  messageItem: 'message-item',
  messageList: 'message-list',
  messageListEmpty: 'message-list-empty',
  pinnedSeparator: 'pinned-separator',
  promptInput: 'prompt-input',
  selectedModelsBar: 'selected-models-bar',
  sendButton: 'send-button',
  senderLabel: 'sender-label',
  smartModelChip: 'smart-model-chip',
  suggestionChips: 'suggestion-chips',
  suggestionChipsRow: 'suggestion-chips-row',
  thinkingIndicator: 'thinking-indicator',
  typingIndicator: 'typing-indicator',

  // Model selector
  comparisonBarAddButton: 'comparison-bar-add-button',
  modelCheckbox: 'model-checkbox',
  modelDetailsPanel: 'model-details-panel',
  modelErrorMessage: 'model-error-message',
  modelFilter: 'model-filter',
  modelListPanel: 'model-list-panel',
  modelListScroll: 'model-list-scroll',
  modelNametag: 'model-nametag',
  modelNametagContainer: 'model-nametag-container',
  modelSelectorButton: 'model-selector-button',
  modelSelectorFooterMotion: 'model-selector-footer-motion',
  modelSelectorModal: 'model-selector-modal',
  pickerModeCounter: 'picker-mode-counter',
  pickerModeMulti: 'picker-mode-multi',
  pickerModeSingle: 'picker-mode-single',
  pickerModeToggle: 'picker-mode-toggle',
  pickerModeToggleWrapper: 'picker-mode-toggle-wrapper',
  useModelsButton: 'use-models-button',

  // Members & sidebar
  addMemberCancelButton: 'add-member-cancel-button',
  addMemberHistoryCheckbox: 'add-member-history-checkbox',
  addMemberModal: 'add-member-modal',
  addMemberPrivilegeSelect: 'add-member-privilege-select',
  addMemberSearchInput: 'add-member-search-input',
  addMemberSelected: 'add-member-selected',
  addMemberSubmitButton: 'add-member-submit-button',
  manageOnlineButton: 'manage-online-button',
  memberBudget: 'member-budget',
  memberBudgetFooter: 'member-budget-footer',
  memberBudgetTrigger: 'member-budget-trigger',
  memberCountBadge: 'member-count-badge',
  memberFacepile: 'member-facepile',
  memberLeaveAction: 'member-leave-action',
  memberOverflowCount: 'member-overflow-count',
  memberSearchInput: 'member-search-input',
  memberSidebar: 'member-sidebar',
  memberSidebarContent: 'member-sidebar-content',
  memberSidebarHeaderIcon: 'member-sidebar-header-icon',
  memberYouBadge: 'member-you-badge',
  newMemberButton: 'new-member-button',

  // Invite links
  inviteLinkButton: 'invite-link-button',
  inviteLinkCancelButton: 'invite-link-cancel-button',
  inviteLinkCopyButton: 'invite-link-copy-button',
  inviteLinkGenerateButton: 'invite-link-generate-button',
  inviteLinkHistoryCheckbox: 'invite-link-history-checkbox',
  inviteLinkModal: 'invite-link-modal',
  inviteLinkNameInput: 'invite-link-name-input',
  inviteLinkPrivilegeSelect: 'invite-link-privilege-select',
  inviteLinkUrl: 'invite-link-url',
  inviteLinkWarning: 'invite-link-warning',
  linkIconContainer: 'link-icon-container',
  linkYouBadge: 'link-you-badge',
  revokeLinkConfirm: 'revoke-link-confirm',
  revokeLinkModal: 'revoke-link-modal',
  revokeLinkWarning: 'revoke-link-warning',

  // Budgets
  budgetCancelButton: 'budget-cancel-button',
  budgetConversationInput: 'budget-conversation-input',
  budgetConversationSection: 'budget-conversation-section',
  budgetConversationValue: 'budget-conversation-value',
  budgetLoading: 'budget-loading',
  budgetMembersList: 'budget-members-list',
  budgetMessages: 'budget-messages',
  budgetSaveButton: 'budget-save-button',
  budgetSettingsModal: 'budget-settings-modal',
  budgetSpent: 'budget-spent',
  budgetTotalAllocated: 'budget-total-allocated',
  budgetTotalSpent: 'budget-total-spent',

  // Confirmation dialogs
  cancelButton: 'cancel-button',
  cancelDeleteButton: 'cancel-delete-button',
  cancelRenameButton: 'cancel-rename-button',
  confirmDeleteButton: 'confirm-delete-button',
  deleteConversationDialog: 'delete-conversation-dialog',
  leaveConfirmationCancel: 'leave-confirmation-cancel',
  leaveConfirmationConfirm: 'leave-confirmation-confirm',
  leaveConfirmationModal: 'leave-confirmation-modal',
  leaveConfirmationTitle: 'leave-confirmation-title',
  leaveConfirmationWarning: 'leave-confirmation-warning',
  removeMemberCancel: 'remove-member-cancel',
  removeMemberConfirm: 'remove-member-confirm',
  removeMemberModal: 'remove-member-modal',
  removeMemberWarning: 'remove-member-warning',
  renameConversationDialog: 'rename-conversation-dialog',
  saveRenameButton: 'save-rename-button',

  // Sharing
  shareMessageCancelButton: 'share-message-cancel-button',
  shareMessageCopyButton: 'share-message-copy-button',
  shareMessageCreateButton: 'share-message-create-button',
  shareMessageIsolationInfo: 'share-message-isolation-info',
  shareMessageModal: 'share-message-modal',
  shareMessagePreview: 'share-message-preview',
  shareMessageSuccess: 'share-message-success',
  shareMessageUrl: 'share-message-url',
  sharedConversationError: 'shared-conversation-error',
  sharedConversationLoading: 'shared-conversation-loading',
  sharedMessageContent: 'shared-message-content',
  sharedMessageError: 'shared-message-error',
  sharedMessageLoading: 'shared-message-loading',

  // Usage & charts
  balanceHistoryChart: 'balance-history-chart',
  categoryPlatformFee: 'category-platform-fee',
  categoryPlatformFeePct: 'category-platform-fee-pct',
  categoryServiceValue: 'category-service-value',
  categoryServiceValuePct: 'category-service-value-pct',
  categoryTransactionCosts: 'category-transaction-costs',
  categoryTransactionCostsPct: 'category-transaction-costs-pct',
  costByModelChart: 'cost-by-model-chart',
  costPieChart: 'cost-pie-chart',
  dateRangeButtons: 'date-range-buttons',
  feeBreakdown: 'fee-breakdown',
  itemModelUsage: 'item-model-usage',
  itemModelUsagePct: 'item-model-usage-pct',
  itemStorage: 'item-storage',
  itemStoragePct: 'item-storage-pct',
  kpiAvgCost: 'kpi-avg-cost',
  kpiMessages: 'kpi-messages',
  kpiTokens: 'kpi-tokens',
  kpiTotalSpent: 'kpi-total-spent',
  rowExpandChevron: 'row-expand-chevron',
  rowExpandedInfo: 'row-expanded-info',
  rowExpandedUseButton: 'row-expanded-use-button',
  rowInfoIcon: 'row-info-icon',
  searchAndSortRow: 'search-and-sort-row',
  slicePlatformFee: 'slice-platform-fee',
  sliceServiceValue: 'slice-service-value',
  sliceTransactionCosts: 'slice-transaction-costs',
  spendingByConversationChart: 'spending-by-conversation-chart',
  spendingOverTimeChart: 'spending-over-time-chart',
  tokenUsageChart: 'token-usage-chart',
  transactionListContainer: 'transaction-list-container',
  transactionRow: 'transaction-row',
  transactionSkeletonRow: 'transaction-skeleton-row',
  usageContent: 'usage-content',
  usageFilters: 'usage-filters',
  usageKpiCards: 'usage-kpi-cards',

  // Billing & payments
  balanceDisplay: 'balance-display',
  billingContent: 'billing-content',
  billingPortal: 'billing-portal',
  billingPortalError: 'billing-portal-error',
  helcimLoading: 'helcim-loading',
  helcimSecurityBadge: 'helcim-security-badge',
  paymentModal: 'payment-modal',

  // Auth & account.
  // The three keys containing "password" hold kebab-case `data-testid` strings,
  // not secrets; the SonarJS heuristic flags any literal on a password-named key.
  changePasswordModal: 'change-password-modal', // eslint-disable-line sonarjs/no-hardcoded-passwords -- test id, not a secret
  changePasswordSubmit: 'change-password-submit', // eslint-disable-line sonarjs/no-hardcoded-passwords -- test id, not a secret
  deleteAccountCancel: 'delete-account-cancel',
  deleteAccountConfirmationInput: 'delete-account-confirmation-input',
  deleteAccountFinalSubmit: 'delete-account-final-submit',
  deleteAccountForfeitCheckbox: 'delete-account-forfeit-checkbox',
  deleteAccountIntroContinue: 'delete-account-intro-continue',
  deleteAccountModal: 'delete-account-modal',
  deleteAccountPasswordContinue: 'delete-account-password-continue', // eslint-disable-line sonarjs/no-hardcoded-passwords -- test id, not a secret
  deleteAccountStartOver: 'delete-account-start-over',
  deleteAccountTotpContinue: 'delete-account-totp-continue',
  deleteAccountTrigger: 'delete-account-trigger',
  deleteAccountWalletContinue: 'delete-account-wallet-continue',
  disableTwoFactorModal: 'disable-two-factor-modal',
  multiModelSignupModal: 'multi-model-signup-modal',
  otpInput: 'otp-input',
  recoveryPhraseModal: 'recovery-phrase-modal',
  signupModal: 'signup-modal',
  strengthIndicator: 'strength-indicator',
  strengthSegment: 'strength-segment',
  twoFactorInputModal: 'two-factor-input-modal',
  twoFactorSetupModal: 'two-factor-setup-modal',

  // Settings
  accessibilityContent: 'accessibility-content',
  customInstructionsModal: 'custom-instructions-modal',
  settingCardNext: 'setting-card-next',
  settingCardPrev: 'setting-card-prev',
  settingsContent: 'settings-content',
  themeMorphIcon: 'theme-morph-icon',
  themeToggle: 'theme-toggle',

  // Content rendering
  documentCard: 'document-card',
  documentPanel: 'document-panel',
  documentPanelScroll: 'document-panel-scroll',
  highlightedCode: 'highlighted-code',
  latentDevelop: 'latent-develop',
  latentDevelopSheen: 'latent-develop-sheen',
  markdownRenderFallback: 'markdown-render-fallback',
  markdownRenderer: 'markdown-renderer',
  mediaProgressBar: 'media-progress-bar',
  mermaidDiagram: 'mermaid-diagram',
  mermaidLoading: 'mermaid-loading',
  videoSummaryText: 'video-summary-text',

  // Icons & native assets
  appIcon: 'app-icon',
  aspectRatioShape: 'aspect-ratio-shape',
  codeIcon: 'code-icon',
  decryptingLockIcon: 'decrypting-lock-icon',
  diagramIcon: 'diagram-icon',
  encryptionBadgeIcon: 'encryption-badge-icon',
  htmlIcon: 'html-icon',
  iconBackground: 'icon-background',
  iconForeground: 'icon-foreground',
  iconMorph: 'icon-morph',
  inputIcon: 'input-icon',
  lockIcon: 'lock-icon',
  logo: 'logo',
  maskCircle: 'mask-circle',
  morphWidth: 'morph-width',
  openIcon: 'open-icon',
  plusIcon: 'plus-icon',
  reactIcon: 'react-icon',
  renderAssetWrapper: 'render-asset-wrapper',
  socialBannerWordmark: 'social-banner-wordmark',
  socialBannerHeadline: 'social-banner-headline',
  socialBannerSubline: 'social-banner-subline',
  socialBannerUrl: 'social-banner-url',
  socialBannerPreview: 'social-banner-preview',
  socialBannerReady: 'social-banner-ready',
  sunBody: 'sun-body',
  sunRays: 'sun-rays',
  wordGrid: 'word-grid',

  // Encryption indicators
  capacityBar: 'capacity-bar',
  capacityBarFill: 'capacity-bar-fill',
  capacityBarTrack: 'capacity-bar-track',
  cipherOutput: 'cipher-output',
  cipherWall: 'cipher-wall',
  decryptingIndicator: 'decrypting-indicator',
  decryptingTitle: 'decrypting-title',
  encryptionBadge: 'encryption-badge',

  // Overlays & layout
  offlineOverlay: 'offline-overlay',
  offlineOverlayDescription: 'offline-overlay-description',
  offlineOverlayTitle: 'offline-overlay-title',
  overlayBackdrop: 'overlay-backdrop',
  overlayContent: 'overlay-content',
  premiumOverlay: 'premium-overlay',
  resizeHandle: 'resize-handle',
  resizeIndicator: 'resize-indicator',
  upgradeRequiredDescription: 'upgrade-required-description',
  upgradeRequiredModal: 'upgrade-required-modal',
  upgradeRequiredRefresh: 'upgrade-required-refresh',
  upgradeRequiredTitle: 'upgrade-required-title',

  // Loading & misc UI
  animatedPlaceholder: 'animated-placeholder',
  privacyTagline: 'privacy-tagline',
  roadmapLoading: 'roadmap-loading',
  skeletonBlock: 'skeleton-block',
  typedText: 'typed-text',
  typingAnimation: 'typing-animation',
  typingCursor: 'typing-cursor',

  // Dev & test surfaces
  devSimulateFailures: 'dev-simulate-failures',
  devSimulationButtons: 'dev-simulation-buttons',
  formInputFeedback: 'form-input-feedback',
  inboxContent: 'inbox-content',
  inputSuffix: 'input-suffix',
  resendButton: 'resend-button',
  resendFeedback: 'resend-feedback',
  settledIndicator: 'settled-indicator',
  simulateFailureBtn: 'simulate-failure-btn',
  simulateSuccessBtn: 'simulate-success-btn',
} as const;

export type TestId = (typeof TEST_IDS)[keyof typeof TEST_IDS];

/**
 * Typed builders for `data-testid` values that are templated in source
 * (every `${...}`-interpolated id). Each function reproduces the exact
 * interpolation used by the emitting component so production and `e2e/**`
 * derive identical strings from one place.
 */
export const TEST_ID_BUILDERS = {
  // Members (apps/web/src/components/chat/member-sidebar.tsx; `memberAvatar` also
  // member-facepile.tsx). Online-dot builders are below; see `onlineFor`.
  memberItem: (memberId: string): string => `member-item-${memberId}`,
  memberActions: (memberId: string): string => `member-actions-${memberId}`,
  memberAvatar: (memberId: string): string => `member-avatar-${memberId}`,
  memberChangePrivilege: (memberId: string): string => `member-change-privilege-${memberId}`,
  memberRemoveAction: (memberId: string): string => `member-remove-action-${memberId}`,
  // member-sidebar.tsx MemberAvatar online dot. The prefix is the avatar's
  // `testIdPrefix` ("member" in expanded rows, "member-avatar" in the collapsed
  // rail), so this covers both `member-online-*` and `member-avatar-online-*`.
  // member-facepile.tsx uses `onlineIndicator` (a different id) for its dot.
  onlineFor: (prefix: string, entityId: string): string => `${prefix}-online-${entityId}`,
  // Retained shorthand for the expanded MemberRow dot (`onlineFor('member', id)`).
  memberOnline: (entityId: string): string => `member-online-${entityId}`,
  memberSection: (privilege: MemberPrivilege): string => `member-section-${privilege}`,
  privilegeOption: (memberId: string, privilege: MemberPrivilege): string =>
    `privilege-option-${memberId}-${privilege}`,

  // Invite links (apps/web/src/components/chat/member-sidebar.tsx)
  linkItem: (linkId: string): string => `link-item-${linkId}`,
  linkActions: (linkId: string): string => `link-actions-${linkId}`,
  linkNameInput: (linkId: string): string => `link-name-input-${linkId}`,
  linkChangeName: (linkId: string): string => `link-change-name-${linkId}`,
  linkChangePrivilege: (linkId: string): string => `link-change-privilege-${linkId}`,
  linkRevokeAction: (linkId: string): string => `link-revoke-action-${linkId}`,
  linkPrivilegeOption: (linkId: string, privilege: MemberPrivilege): string =>
    `link-privilege-option-${linkId}-${privilege}`,

  // Member facepile online dot (apps/web/src/components/chat/member-facepile.tsx)
  onlineIndicator: (memberId: string): string => `online-indicator-${memberId}`,

  // Model selector (apps/web/src/components/chat/model-selector-modal.tsx)
  modelItem: (modelId: string): string => `model-item-${modelId}`,

  // Deposit fee breakdown (packages/ui/src/components/marketing/fee-breakdown.tsx)
  feeItem: (categoryId: string): string => `item-fee-${categoryId}`,
  feeItemPct: (categoryId: string): string => `item-fee-${categoryId}-pct`,

  // Budgets (apps/web/src/components/chat/budget-settings-modal.tsx, budget-messages.tsx)
  budgetMember: (memberId: string): string => `budget-member-${memberId}`,
  budgetInput: (memberId: string): string => `budget-input-${memberId}`,
  budgetValue: (memberId: string): string => `budget-value-${memberId}`,
  budgetMessage: (errorId: string): string => `budget-message-${errorId}`,
  budgetMessageIcon: (errorId: string): string => `budget-message-icon-${errorId}`,
  budgetDismiss: (errorId: string): string => `budget-dismiss-${errorId}`,

  // Usage KPI cards (apps/web/src/components/usage/usage-kpi-cards.tsx) — `${testId}-value`
  kpiValue: (baseId: string): string => `${baseId}-value`,

  // Fork tabs (apps/web/src/components/chat/fork-tabs.tsx)
  forkTab: (forkId: string): string => `fork-tab-${forkId}`,

  // Usage date-range filter (apps/web/src/components/usage/usage-filters.tsx)
  range: (rangeValue: string): string => `range-${rangeValue}`,

  // Chat suggestions (apps/web/src/components/chat/suggestion-chips.tsx)
  suggestionSlot: (index: number): string => `suggestion-slot-${String(index)}`,

  // Recovery phrase verification (apps/web/src/components/auth/RecoveryPhraseModal.tsx)
  wordCheck: (index: number): string => `word-check-${String(index)}`,

  // Add-member search results (apps/web/src/components/chat/add-member-modal.tsx)
  addMemberResult: (userId: string): string => `add-member-result-${userId}`,

  // Action-modal failure simulation (apps/web/src/components/shared/action-modal.tsx)
  devSimulate: (code: string): string => `dev-simulate-${code}`,

  // Persona picker (apps/web/src/routes/dev.personas.tsx)
  personaCard: (personaName: string): string => `persona-card-${personaName}`,

  // Splash-screen native asset (apps/web/src/components/native-assets/splash-screen.tsx)
  splash: (variant: 'dark' | 'light'): string => `splash-${variant}`,

  // Social banner native asset (apps/web/src/components/native-assets/social-banner.tsx)
  socialBanner: (variant: 'dark' | 'light'): string => `social-banner-${variant}`,

  // Dev asset browser (apps/web/src/routes/dev.assets.tsx)
  assetCard: (assetName: string): string => `asset-card-${assetName}`,
  assetPreview: (assetName: string): string => `asset-preview-${assetName}`,
  assetLink: (assetName: string): string => `asset-link-${assetName}`,
  assetOpenImage: (assetName: string): string => `asset-open-image-${assetName}`,
  resolutionGroup: (resolutionName: string): string => `resolution-group-${resolutionName}`,
  screenshotCard: (resolutionName: string, screenshotName: string): string =>
    `screenshot-card-${resolutionName}-${screenshotName}`,
  screenshotOpenImage: (resolutionName: string, screenshotName: string): string =>
    `screenshot-open-image-${resolutionName}-${screenshotName}`,

  // Dev email previews (apps/web/src/routes/dev.emails.tsx)
  emailIframe: (templateName: string): string => `email-iframe-${templateName}`,
} as const;
