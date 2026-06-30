CREATE TABLE "service_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
