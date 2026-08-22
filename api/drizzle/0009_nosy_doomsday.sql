CREATE TYPE "public"."investment_source" AS ENUM('payment', 'wallet');--> statement-breakpoint
CREATE TYPE "public"."investment_status" AS ENUM('confirmed');--> statement-breakpoint
CREATE TABLE "investment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"investor_account_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"source" "investment_source" NOT NULL,
	"payment_ref" text,
	"status" "investment_status" DEFAULT 'confirmed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "raised_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_investor_account_id_account_id_fk" FOREIGN KEY ("investor_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;