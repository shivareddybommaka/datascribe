-- M9 notifications (D-090): org-scoped rows with an email outbox, plus per-user preferences.

-- CreateEnum
CREATE TYPE "NotificationEmailStatus" AS ENUM ('none', 'pending', 'sending', 'sent', 'failed', 'skipped');

-- DropIndex
DROP INDEX "Notification_userId_readAt_idx";

-- AlterTable (organizationId is backfilled from the recipient before it becomes NOT NULL)
ALTER TABLE "Notification" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "emailAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "emailNextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "emailSentAt" TIMESTAMP(3),
ADD COLUMN     "emailStatus" "NotificationEmailStatus" NOT NULL DEFAULT 'none',
ADD COLUMN     "inApp" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "organizationId" TEXT;

UPDATE "Notification" n SET "organizationId" = u."organizationId" FROM "User" u WHERE u."id" = n."userId";

ALTER TABLE "Notification" ALTER COLUMN "organizationId" SET NOT NULL;

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "email" BOOLEAN NOT NULL,
    "inApp" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_type_key" ON "NotificationPreference"("userId", "type");

-- CreateIndex
CREATE INDEX "Notification_userId_organizationId_inApp_readAt_idx" ON "Notification"("userId", "organizationId", "inApp", "readAt");

-- CreateIndex
CREATE INDEX "Notification_emailStatus_emailNextAttemptAt_idx" ON "Notification"("emailStatus", "emailNextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
