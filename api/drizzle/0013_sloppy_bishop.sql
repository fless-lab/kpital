CREATE TYPE "public"."repayment_installment_status" AS ENUM('due', 'pending', 'paid');--> statement-breakpoint
CREATE TABLE "repayment_distribution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installment_id" uuid NOT NULL,
	"investment_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repayment_installment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"amount_minor" bigint NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "repayment_installment_status" DEFAULT 'due' NOT NULL,
	"repayment_ref" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repayment_distribution" ADD CONSTRAINT "repayment_distribution_installment_id_repayment_installment_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."repayment_installment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_distribution" ADD CONSTRAINT "repayment_distribution_investment_id_investment_id_fk" FOREIGN KEY ("investment_id") REFERENCES "public"."investment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_installment" ADD CONSTRAINT "repayment_installment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repayment_distribution_installment_investment_unique" ON "repayment_distribution" USING btree ("installment_id","investment_id");