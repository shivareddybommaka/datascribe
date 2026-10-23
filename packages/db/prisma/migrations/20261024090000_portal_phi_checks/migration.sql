-- M4 (audit finding L5): Case.notes and Message.body are now encrypted at the application level
-- like Case.patientName (AES-256-GCM "v1:iv:tag:ct" envelopes, D-013). These CHECKs make the
-- database refuse plaintext in all three columns.
--
-- NOT VALID: enforced for every new or updated row straight away, without failing on rows written
-- before this migration. The API encrypts any such legacy rows at startup and then runs
-- VALIDATE CONSTRAINT (apps/api/src/services/phi-backfill.ts), so the encryption key never has to
-- be available to SQL.
ALTER TABLE "Case" ADD CONSTRAINT "Case_patientName_encrypted"
  CHECK ("patientName" ~ '^v[0-9]+:') NOT VALID;

ALTER TABLE "Case" ADD CONSTRAINT "Case_notes_encrypted"
  CHECK ("notes" IS NULL OR "notes" ~ '^v[0-9]+:') NOT VALID;

ALTER TABLE "Message" ADD CONSTRAINT "Message_body_encrypted"
  CHECK ("body" ~ '^v[0-9]+:') NOT VALID;
