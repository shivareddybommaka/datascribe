-- Audit L1 (D-103): record why a session ended, so only rotated tokens raise reuse alerts.
ALTER TABLE "Session" ADD COLUMN "revokedReason" TEXT;
