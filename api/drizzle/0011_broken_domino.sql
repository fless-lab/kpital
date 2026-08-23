ALTER TYPE "public"."entry_type" ADD VALUE 'disbursement';--> statement-breakpoint
ALTER TYPE "public"."entry_type" ADD VALUE 'refund';--> statement-breakpoint
ALTER TYPE "public"."project_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "investment" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "investment" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."investment_status";--> statement-breakpoint
CREATE TYPE "public"."investment_status" AS ENUM('pending', 'escrowed', 'released', 'refunded', 'failed');--> statement-breakpoint
ALTER TABLE "investment" ALTER COLUMN "status" SET DATA TYPE "public"."investment_status" USING "status"::"public"."investment_status";--> statement-breakpoint
ALTER TABLE "investment" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "resolution_ref" text;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "resolved_at" timestamp with time zone;
