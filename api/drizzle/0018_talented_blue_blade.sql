DROP INDEX "repayment_distribution_installment_investment_unique";--> statement-breakpoint
ALTER TABLE "repayment_distribution" ALTER COLUMN "application_id" SET NOT NULL;