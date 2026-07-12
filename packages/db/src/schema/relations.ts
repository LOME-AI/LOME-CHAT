import { relations } from 'drizzle-orm';

import { accountDeletionEvents } from './account-deletion-events';
import { adminAudit } from './admin-audit';
import { allowanceSpending } from './allowance-spending';
import { bannerConfig } from './banner-config';
import { bannerDismissals } from './banner-dismissals';
import { contentItems } from './content-items';
import { conversationForks } from './conversation-forks';
import { conversationMembers } from './conversation-members';
import { conversationSpending } from './conversation-spending';
import { conversations } from './conversations';
import { customInstructions } from './custom-instructions';
import { deviceTokens } from './device-tokens';
import { epochMembers } from './epoch-members';
import { epochs } from './epochs';
import { idempotencyKeys } from './idempotency-keys';
import { jobs } from './jobs';
import { ledgerEntries } from './ledger-entries';
import { llmCompletions } from './llm-completions';
import { mediaGenerations } from './media-generations';
import { memberBudgets } from './member-budgets';
import { messages } from './messages';
import { modelCatalog } from './model-catalog';
import { payments } from './payments';
import { preferences } from './preferences';
import { serviceEvidence } from './service-evidence';
import { sharedLinks } from './shared-links';
import { sharedMessages } from './shared-messages';
import { usageRecords } from './usage-records';
import { users } from './users';
import { verificationTokens } from './verification-tokens';
import { wallets } from './wallets';

/** Every table declares relations() so relational queries stay usable. */

export const usersRelations = relations(users, ({ one, many }) => ({
  wallets: many(wallets),
  payments: many(payments),
  usageRecords: many(usageRecords),
  conversations: many(conversations),
  memberships: many(conversationMembers, { relationName: 'member' }),
  sentInvites: many(conversationMembers, { relationName: 'inviter' }),
  sharedMessages: many(sharedMessages),
  allowanceSpending: many(allowanceSpending),
  deviceTokens: many(deviceTokens),
  verificationTokens: many(verificationTokens),
  customInstructions: one(customInstructions),
  preferences: one(preferences),
  bannerDismissal: one(bannerDismissals),
}));

export const walletsRelations = relations(wallets, ({ one, many }) => ({
  user: one(users, { fields: [wallets.userId], references: [users.id] }),
  ledgerEntries: many(ledgerEntries),
}));

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  wallet: one(wallets, { fields: [ledgerEntries.walletId], references: [wallets.id] }),
  payment: one(payments, { fields: [ledgerEntries.paymentId], references: [payments.id] }),
  usageRecord: one(usageRecords, {
    fields: [ledgerEntries.usageRecordId],
    references: [usageRecords.id],
  }),
}));

export const usageRecordsRelations = relations(usageRecords, ({ one, many }) => ({
  user: one(users, { fields: [usageRecords.userId], references: [users.id] }),
  contentItem: one(contentItems, {
    fields: [usageRecords.contentItemId],
    references: [contentItems.id],
  }),
  conversation: one(conversations, {
    fields: [usageRecords.conversationId],
    references: [conversations.id],
  }),
  llmCompletion: one(llmCompletions),
  mediaGeneration: one(mediaGenerations),
  ledgerEntries: many(ledgerEntries),
}));

export const llmCompletionsRelations = relations(llmCompletions, ({ one }) => ({
  usageRecord: one(usageRecords, {
    fields: [llmCompletions.usageRecordId],
    references: [usageRecords.id],
  }),
}));

export const mediaGenerationsRelations = relations(mediaGenerations, ({ one }) => ({
  usageRecord: one(usageRecords, {
    fields: [mediaGenerations.usageRecordId],
    references: [usageRecords.id],
  }),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  user: one(users, { fields: [payments.userId], references: [users.id] }),
  ledgerEntries: many(ledgerEntries),
}));

export const memberBudgetsRelations = relations(memberBudgets, ({ one }) => ({
  member: one(conversationMembers, {
    fields: [memberBudgets.memberId],
    references: [conversationMembers.id],
  }),
}));

export const conversationSpendingRelations = relations(conversationSpending, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationSpending.conversationId],
    references: [conversations.id],
  }),
}));

export const allowanceSpendingRelations = relations(allowanceSpending, ({ one }) => ({
  user: one(users, { fields: [allowanceSpending.userId], references: [users.id] }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  owner: one(users, { fields: [conversations.userId], references: [users.id] }),
  messages: many(messages),
  members: many(conversationMembers),
  forks: many(conversationForks),
  epochs: many(epochs),
  sharedLinks: many(sharedLinks),
  spending: many(conversationSpending),
}));

export const conversationMembersRelations = relations(conversationMembers, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [conversationMembers.conversationId],
    references: [conversations.id],
  }),
  user: one(users, {
    fields: [conversationMembers.userId],
    references: [users.id],
    relationName: 'member',
  }),
  link: one(sharedLinks, {
    fields: [conversationMembers.linkId],
    references: [sharedLinks.id],
  }),
  invitedBy: one(users, {
    fields: [conversationMembers.invitedByUserId],
    references: [users.id],
    relationName: 'inviter',
  }),
  budgets: many(memberBudgets),
}));

export const conversationForksRelations = relations(conversationForks, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationForks.conversationId],
    references: [conversations.id],
  }),
  tipMessage: one(messages, {
    fields: [conversationForks.tipMessageId],
    references: [messages.id],
  }),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  parent: one(messages, {
    fields: [messages.parentMessageId],
    references: [messages.id],
    relationName: 'thread',
  }),
  children: many(messages, { relationName: 'thread' }),
  epoch: one(epochs, {
    fields: [messages.conversationId, messages.epochNumber],
    references: [epochs.conversationId, epochs.epochNumber],
  }),
  contentItems: many(contentItems),
  sharedMessages: many(sharedMessages),
}));

export const contentItemsRelations = relations(contentItems, ({ one, many }) => ({
  message: one(messages, { fields: [contentItems.messageId], references: [messages.id] }),
  usageRecords: many(usageRecords),
}));

export const epochsRelations = relations(epochs, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [epochs.conversationId],
    references: [conversations.id],
  }),
  previousEpoch: one(epochs, {
    fields: [epochs.previousEpochId],
    references: [epochs.id],
    relationName: 'chain',
  }),
  nextEpochs: many(epochs, { relationName: 'chain' }),
  members: many(epochMembers),
  messages: many(messages),
}));

export const epochMembersRelations = relations(epochMembers, ({ one }) => ({
  epoch: one(epochs, { fields: [epochMembers.epochId], references: [epochs.id] }),
}));

export const sharedLinksRelations = relations(sharedLinks, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [sharedLinks.conversationId],
    references: [conversations.id],
  }),
  members: many(conversationMembers),
}));

export const sharedMessagesRelations = relations(sharedMessages, ({ one }) => ({
  message: one(messages, { fields: [sharedMessages.messageId], references: [messages.id] }),
  creator: one(users, { fields: [sharedMessages.createdBy], references: [users.id] }),
}));

// usage_records and content_items reference the model by plain string, not by
// FK, so model_catalog has no inbound relations to declare.
export const modelCatalogRelations = relations(modelCatalog, () => ({}));

export const idempotencyKeysRelations = relations(idempotencyKeys, () => ({}));

export const jobsRelations = relations(jobs, () => ({}));

export const adminAuditRelations = relations(adminAudit, () => ({}));

export const bannerConfigRelations = relations(bannerConfig, () => ({}));

export const bannerDismissalsRelations = relations(bannerDismissals, ({ one }) => ({
  user: one(users, { fields: [bannerDismissals.userId], references: [users.id] }),
}));

export const deviceTokensRelations = relations(deviceTokens, ({ one }) => ({
  user: one(users, { fields: [deviceTokens.userId], references: [users.id] }),
}));

export const customInstructionsRelations = relations(customInstructions, ({ one }) => ({
  user: one(users, { fields: [customInstructions.userId], references: [users.id] }),
}));

export const preferencesRelations = relations(preferences, ({ one }) => ({
  user: one(users, { fields: [preferences.userId], references: [users.id] }),
}));

export const verificationTokensRelations = relations(verificationTokens, ({ one }) => ({
  user: one(users, { fields: [verificationTokens.userId], references: [users.id] }),
}));

export const serviceEvidenceRelations = relations(serviceEvidence, () => ({}));

// Anonymous by design — no user FK to relate through.
export const accountDeletionEventsRelations = relations(accountDeletionEvents, () => ({}));
