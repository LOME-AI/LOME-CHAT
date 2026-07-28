CREATE TYPE "public"."reasoning_effort" AS ENUM('lite', 'low', 'medium', 'high', 'max', 'off');--> statement-breakpoint
ALTER TABLE "llm_completions" ADD COLUMN "reasoning_effort" "reasoning_effort";