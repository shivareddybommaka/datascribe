-- M8 billing + subscriptions (additive only)

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('subscription', 'one_off');

-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'refunded';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "kind" "InvoiceKind" NOT NULL DEFAULT 'one_off',
ADD COLUMN     "lastReminderAt" TIMESTAMP(3),
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "remindersSent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "subscriptionId" TEXT,
ADD COLUMN     "taxLabel" TEXT,
ADD COLUMN     "taxRatePercent" DECIMAL(5,2),
ADD COLUMN     "voidedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN     "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Invoice_status_dueAt_idx" ON "Invoice"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_subscriptionId_periodStart_key" ON "Invoice"("subscriptionId", "periodStart");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

-- CreateIndex
CREATE INDEX "Subscription_status_currentPeriodEnd_idx" ON "Subscription"("status", "currentPeriodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "UsageRecord_caseId_metric_key" ON "UsageRecord"("caseId", "metric");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
