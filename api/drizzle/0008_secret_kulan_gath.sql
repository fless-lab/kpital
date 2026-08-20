CREATE TYPE "public"."project_category" AS ENUM('immobilier', 'commerce', 'agriculture');--> statement-breakpoint
CREATE TYPE "public"."project_doc_kind" AS ENUM('rccm', 'foncier', 'releves', 'photo');--> statement-breakpoint
CREATE TYPE "public"."project_doc_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."project_score" AS ENUM('A', 'B', 'C', 'D');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('draft', 'submitted', 'in_review', 'rejected', 'showcase', 'collecting', 'funded', 'repaying', 'closed');--> statement-breakpoint
CREATE TABLE "project_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "project_doc_kind" NOT NULL,
	"visibility" "project_doc_visibility" NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_follow" (
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_follow_account_id_project_id_pk" PRIMARY KEY("account_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "project_upvote" (
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_upvote_account_id_project_id_pk" PRIMARY KEY("account_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"category" "project_category" NOT NULL,
	"title" text NOT NULL,
	"city" text NOT NULL,
	"quartier" text,
	"description" text NOT NULL,
	"target_minor" bigint NOT NULL,
	"duration_months" integer NOT NULL,
	"roi_pct" numeric NOT NULL,
	"funds_usage" text NOT NULL,
	"caution_type" text NOT NULL,
	"status" "project_status" DEFAULT 'draft' NOT NULL,
	"score" "project_score",
	"reject_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"collecting_opened_at" timestamp with time zone,
	"upvote_count" integer DEFAULT 0 NOT NULL,
	"follow_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_document" ADD CONSTRAINT "project_document_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_follow" ADD CONSTRAINT "project_follow_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_follow" ADD CONSTRAINT "project_follow_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_upvote" ADD CONSTRAINT "project_upvote_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_upvote" ADD CONSTRAINT "project_upvote_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_owner_account_id_account_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_reviewed_by_account_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;