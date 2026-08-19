CREATE TYPE "public"."otp_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."otp_purpose" AS ENUM('login', 'password_reset', 'verify_contact');--> statement-breakpoint
CREATE TABLE "otp_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"channel" "otp_channel" NOT NULL,
	"purpose" "otp_purpose" NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "otp_code" ADD CONSTRAINT "otp_code_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;