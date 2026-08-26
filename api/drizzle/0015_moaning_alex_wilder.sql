ALTER TYPE "public"."project_status" ADD VALUE 'defaulted';--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "defaulted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repayment_installment" ADD COLUMN "reminded_at" timestamp with time zone;