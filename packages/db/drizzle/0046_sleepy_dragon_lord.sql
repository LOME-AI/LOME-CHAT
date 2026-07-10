ALTER TABLE "conversation_spending" DROP CONSTRAINT "conversation_spending_conversation_month_unique";--> statement-breakpoint
ALTER TABLE "member_budgets" DROP CONSTRAINT "member_budgets_member_month_unique";--> statement-breakpoint
ALTER TABLE "conversation_spending" DROP CONSTRAINT "conversation_spending_month_format";--> statement-breakpoint
ALTER TABLE "member_budgets" DROP CONSTRAINT "member_budgets_month_format";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "conversation_budget_nano_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_spending" DROP COLUMN "month";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "budget_nano_usd";--> statement-breakpoint
ALTER TABLE "member_budgets" DROP COLUMN "month";--> statement-breakpoint
ALTER TABLE "conversation_spending" ADD CONSTRAINT "conversation_spending_conversation_unique" UNIQUE("conversation_id");--> statement-breakpoint
ALTER TABLE "member_budgets" ADD CONSTRAINT "member_budgets_member_unique" UNIQUE("member_id");