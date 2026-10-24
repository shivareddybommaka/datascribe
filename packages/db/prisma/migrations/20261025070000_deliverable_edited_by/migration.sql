-- D-086: versioned staff edits. Null = the version was written by the pipeline.
ALTER TABLE "Deliverable" ADD COLUMN "editedById" TEXT;

ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
