CREATE TYPE "public"."payout_type" AS ENUM('tmoney', 'flooz', 'bank');--> statement-breakpoint
CREATE TABLE "notification_pref" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"channels" text[] DEFAULT '{"email"}' NOT NULL,
	"categories" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"type" "payout_type" NOT NULL,
	"details" jsonb NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_pref" ADD CONSTRAINT "notification_pref_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_method" ADD CONSTRAINT "payout_method_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;