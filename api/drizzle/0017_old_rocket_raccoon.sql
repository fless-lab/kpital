CREATE TYPE "public"."repayment_payment_status" AS ENUM('pending', 'settled', 'failed');--> statement-breakpoint
CREATE TABLE "repayment_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"installment_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repayment_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"ref" text,
	"status" "repayment_payment_status" DEFAULT 'pending' NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repayment_distribution" ADD COLUMN "application_id" uuid;--> statement-breakpoint
ALTER TABLE "repayment_installment" ADD COLUMN "paid_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repayment_application" ADD CONSTRAINT "repayment_application_payment_id_repayment_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."repayment_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_application" ADD CONSTRAINT "repayment_application_installment_id_repayment_installment_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."repayment_installment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_payment" ADD CONSTRAINT "repayment_payment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repayment_application_payment_installment_unique" ON "repayment_application" USING btree ("payment_id","installment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repayment_payment_ref_unique" ON "repayment_payment" USING btree ("ref") WHERE "repayment_payment"."ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "repayment_distribution" ADD CONSTRAINT "repayment_distribution_application_id_repayment_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."repayment_application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_installment" ADD CONSTRAINT "repayment_installment_paid_within_amount" CHECK ("repayment_installment"."paid_minor" >= 0 AND "repayment_installment"."paid_minor" <= "repayment_installment"."amount_minor");