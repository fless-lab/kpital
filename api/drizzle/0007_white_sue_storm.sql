CREATE TYPE "public"."kyc_doc_kind" AS ENUM('front', 'back', 'passport_page');--> statement-breakpoint
CREATE TYPE "public"."kyc_doc_type" AS ENUM('cni', 'passeport', 'sejour');--> statement-breakpoint
CREATE TYPE "public"."kyc_sub_status" AS ENUM('pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TABLE "kyc_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"kind" "kyc_doc_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kyc_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"doc_type" "kyc_doc_type" NOT NULL,
	"doc_number" text NOT NULL,
	"dob" date NOT NULL,
	"nationality" text NOT NULL,
	"status" "kyc_sub_status" DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"superseded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kyc_document" ADD CONSTRAINT "kyc_document_submission_id_kyc_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."kyc_submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_submission" ADD CONSTRAINT "kyc_submission_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_submission" ADD CONSTRAINT "kyc_submission_reviewed_by_account_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;