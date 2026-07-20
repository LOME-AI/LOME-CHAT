import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z as zodInstance } from 'zod';

import {
  contentItems,
  conversationMembers,
  conversationSpending,
  conversations,
  epochMembers,
  epochs,
  ledgerEntries,
  llmCompletions,
  mediaGenerations,
  memberBudgets,
  messages,
  payments,
  sharedLinks,
  sharedMessages,
  usageRecords,
  users,
  wallets,
} from '../schema/index';
import { accountDeletionEvents } from '../schema/account-deletion-events';
import { serviceEvidence } from '../schema/service-evidence';
import type { z } from 'zod';

export const selectUserSchema = createSelectSchema(users, {
  opaqueRegistration: () => zodInstance.instanceof(Uint8Array),
  publicKey: () => zodInstance.instanceof(Uint8Array),
  passwordWrappedPrivateKey: () => zodInstance.instanceof(Uint8Array),
  recoveryWrappedPrivateKey: () => zodInstance.instanceof(Uint8Array),
});
export const insertUserSchema = createInsertSchema(users);

export const selectConversationSchema = createSelectSchema(conversations, {
  title: () => zodInstance.instanceof(Uint8Array),
});
export const insertConversationSchema = createInsertSchema(conversations, {
  title: () => zodInstance.instanceof(Uint8Array),
});

export const selectMessageSchema = createSelectSchema(messages, {
  wrappedContentKey: () => zodInstance.instanceof(Uint8Array),
});
export const insertMessageSchema = createInsertSchema(messages, {
  wrappedContentKey: () => zodInstance.instanceof(Uint8Array),
});

// Mirrors the `content_items_type_consistency` CHECK constraint at the Zod
// boundary as a discriminated union. Validation rejects mixed text + media
// payloads BEFORE they reach Postgres, so the constraint stays a defense in
// depth instead of the only line of defense.
export const selectContentItemSchema = createSelectSchema(contentItems, {
  encryptedBlob: () => zodInstance.instanceof(Uint8Array).nullable(),
});

const contentItemBaseInsertFields = {
  id: zodInstance.string().optional(),
  messageId: zodInstance.string(),
  position: zodInstance.number().int().nonnegative().default(0),
  modelName: zodInstance.string().nullable().optional(),
  cost: zodInstance.string().nullable().optional(),
  isSmartModel: zodInstance.boolean().optional(),
  createdAt: zodInstance.date().optional(),
};

const insertTextContentItemSchema = zodInstance.object({
  ...contentItemBaseInsertFields,
  contentType: zodInstance.literal('text'),
  encryptedBlob: zodInstance.instanceof(Uint8Array),
  storageKey: zodInstance.undefined().or(zodInstance.null()).optional(),
  mimeType: zodInstance.undefined().or(zodInstance.null()).optional(),
  sizeBytes: zodInstance.undefined().or(zodInstance.null()).optional(),
  width: zodInstance.undefined().or(zodInstance.null()).optional(),
  height: zodInstance.undefined().or(zodInstance.null()).optional(),
  durationMs: zodInstance.undefined().or(zodInstance.null()).optional(),
});

const insertMediaContentItemSchema = zodInstance.object({
  ...contentItemBaseInsertFields,
  contentType: zodInstance.enum(['image', 'audio', 'video']),
  storageKey: zodInstance.string(),
  mimeType: zodInstance.string(),
  sizeBytes: zodInstance.number().int().nonnegative(),
  width: zodInstance.number().int().nullable().optional(),
  height: zodInstance.number().int().nullable().optional(),
  durationMs: zodInstance.number().int().nullable().optional(),
  encryptedBlob: zodInstance.undefined().or(zodInstance.null()).optional(),
});

export const insertContentItemSchema = zodInstance.discriminatedUnion('contentType', [
  insertTextContentItemSchema,
  insertMediaContentItemSchema,
]);

export const selectPaymentSchema = createSelectSchema(payments);
export const insertPaymentSchema = createInsertSchema(payments);

export const selectServiceEvidenceSchema = createSelectSchema(serviceEvidence);
export const insertServiceEvidenceSchema = createInsertSchema(serviceEvidence);

export const selectWalletSchema = createSelectSchema(wallets);
export const insertWalletSchema = createInsertSchema(wallets);

export const selectUsageRecordSchema = createSelectSchema(usageRecords);
export const insertUsageRecordSchema = createInsertSchema(usageRecords);

export const selectLlmCompletionSchema = createSelectSchema(llmCompletions);
export const insertLlmCompletionSchema = createInsertSchema(llmCompletions);

export const selectMediaGenerationSchema = createSelectSchema(mediaGenerations);
export const insertMediaGenerationSchema = createInsertSchema(mediaGenerations);

export const selectLedgerEntrySchema = createSelectSchema(ledgerEntries);
export const insertLedgerEntrySchema = createInsertSchema(ledgerEntries);

export const selectSharedLinkSchema = createSelectSchema(sharedLinks, {
  linkPublicKey: () => zodInstance.instanceof(Uint8Array),
});
export const insertSharedLinkSchema = createInsertSchema(sharedLinks, {
  linkPublicKey: () => zodInstance.instanceof(Uint8Array),
});

export const selectConversationMemberSchema = createSelectSchema(conversationMembers);
export const insertConversationMemberSchema = createInsertSchema(conversationMembers);

export const selectEpochSchema = createSelectSchema(epochs, {
  epochPublicKey: () => zodInstance.instanceof(Uint8Array),
  confirmationHash: () => zodInstance.instanceof(Uint8Array),
  chainLink: () => zodInstance.instanceof(Uint8Array).nullable(),
});
export const insertEpochSchema = createInsertSchema(epochs, {
  epochPublicKey: () => zodInstance.instanceof(Uint8Array),
  confirmationHash: () => zodInstance.instanceof(Uint8Array),
  chainLink: () => zodInstance.instanceof(Uint8Array).nullable(),
});

export const selectEpochMemberSchema = createSelectSchema(epochMembers, {
  memberPublicKey: () => zodInstance.instanceof(Uint8Array),
  wrap: () => zodInstance.instanceof(Uint8Array),
});
export const insertEpochMemberSchema = createInsertSchema(epochMembers, {
  memberPublicKey: () => zodInstance.instanceof(Uint8Array),
  wrap: () => zodInstance.instanceof(Uint8Array),
});

export const selectSharedMessageSchema = createSelectSchema(sharedMessages, {
  wrappedContentKey: () => zodInstance.instanceof(Uint8Array),
});
export const insertSharedMessageSchema = createInsertSchema(sharedMessages, {
  wrappedContentKey: () => zodInstance.instanceof(Uint8Array),
});

export const selectMemberBudgetSchema = createSelectSchema(memberBudgets);
export const insertMemberBudgetSchema = createInsertSchema(memberBudgets);

export const selectConversationSpendingSchema = createSelectSchema(conversationSpending);
export const insertConversationSpendingSchema = createInsertSchema(conversationSpending);

export const selectAccountDeletionEventSchema = createSelectSchema(accountDeletionEvents);
export const insertAccountDeletionEventSchema = createInsertSchema(accountDeletionEvents);

export type User = typeof users.$inferSelect;
export type NewUser = z.infer<typeof insertUserSchema>;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = z.infer<typeof insertConversationSchema>;
export type Message = typeof messages.$inferSelect;
export type NewMessage = z.infer<typeof insertMessageSchema>;
export type ContentItem = typeof contentItems.$inferSelect;
export type NewContentItem = z.infer<typeof insertContentItemSchema>;
export type Payment = z.infer<typeof selectPaymentSchema>;
export type NewPayment = z.infer<typeof insertPaymentSchema>;
export type ServiceEvidence = z.infer<typeof selectServiceEvidenceSchema>;
export type NewServiceEvidence = z.infer<typeof insertServiceEvidenceSchema>;
export type Wallet = z.infer<typeof selectWalletSchema>;
export type NewWallet = z.infer<typeof insertWalletSchema>;
export type UsageRecord = z.infer<typeof selectUsageRecordSchema>;
export type NewUsageRecord = z.infer<typeof insertUsageRecordSchema>;
export type LlmCompletion = z.infer<typeof selectLlmCompletionSchema>;
export type NewLlmCompletion = z.infer<typeof insertLlmCompletionSchema>;
export type MediaGeneration = z.infer<typeof selectMediaGenerationSchema>;
export type NewMediaGeneration = z.infer<typeof insertMediaGenerationSchema>;
export type LedgerEntry = z.infer<typeof selectLedgerEntrySchema>;
export type NewLedgerEntry = z.infer<typeof insertLedgerEntrySchema>;
export type SharedLink = z.infer<typeof selectSharedLinkSchema>;
export type NewSharedLink = z.infer<typeof insertSharedLinkSchema>;
export type ConversationMember = z.infer<typeof selectConversationMemberSchema>;
export type NewConversationMember = z.infer<typeof insertConversationMemberSchema>;
export type Epoch = z.infer<typeof selectEpochSchema>;
export type NewEpoch = z.infer<typeof insertEpochSchema>;
export type EpochMember = z.infer<typeof selectEpochMemberSchema>;
export type NewEpochMember = z.infer<typeof insertEpochMemberSchema>;
export type SharedMessage = z.infer<typeof selectSharedMessageSchema>;
export type NewSharedMessage = z.infer<typeof insertSharedMessageSchema>;
export type MemberBudget = z.infer<typeof selectMemberBudgetSchema>;
export type NewMemberBudget = z.infer<typeof insertMemberBudgetSchema>;
export type ConversationSpending = z.infer<typeof selectConversationSpendingSchema>;
export type NewConversationSpending = z.infer<typeof insertConversationSpendingSchema>;
export type AccountDeletionEvent = z.infer<typeof selectAccountDeletionEventSchema>;
export type NewAccountDeletionEvent = z.infer<typeof insertAccountDeletionEventSchema>;
