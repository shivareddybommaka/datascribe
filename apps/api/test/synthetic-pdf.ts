import { createHash, randomBytes } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * SYNTHETIC medical-record PDF for upload tests and the M4 demo (no real PHI: Synthea-style
 * names only). `padBytes` attaches incompressible filler so the file spans several multipart
 * parts. Also used by the Playwright portal journey.
 */
export async function syntheticRecordPdf(opts: { pages: number; padBytes?: number }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Synthetic medical record (test data)');
  pdf.setProducer('Datascribe test fixtures');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= opts.pages; n++) {
    const page = pdf.addPage([612, 792]);
    page.drawText('SYNTHETIC TEST RECORD - NOT A REAL PATIENT', { x: 50, y: 740, size: 10, font });
    page.drawText(`Patient: Ramiro608 Jacobs452   MRN: SYN-000${n % 10}`, {
      x: 50,
      y: 710,
      size: 12,
      font,
    });
    page.drawText(`Riverside Clinic (synthetic) - office visit note, page ${n} of ${opts.pages}`, {
      x: 50,
      y: 690,
      size: 12,
      font,
    });
    page.drawText('Assessment: lumbar radiculopathy. Plan: gabapentin 300 mg, physical therapy.', {
      x: 50,
      y: 660,
      size: 11,
      font,
    });
  }
  if (opts.padBytes) {
    await pdf.attach(randomBytes(opts.padBytes), 'filler.bin', {
      mimeType: 'application/octet-stream',
      description: 'test filler',
    });
  }
  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
