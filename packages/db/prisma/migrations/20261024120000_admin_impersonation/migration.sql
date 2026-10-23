-- M2: read-only impersonation sessions (D-061)
ALTER TABLE "Session" ADD COLUMN "impersonatorId" TEXT;
