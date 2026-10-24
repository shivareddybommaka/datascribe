-- D-128: retention job tombstone. Purged documents keep their row (citations, portal list).
ALTER TABLE "Document" ADD COLUMN "purgedAt" TIMESTAMP(3);
