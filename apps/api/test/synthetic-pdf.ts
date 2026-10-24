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

/**
 * SYNTHETIC case file for the M5 DoD (upload → pipeline → review): one page per record type, with
 * dates of service, providers and coded terms the mock adapters know. The billing page carries no
 * clinical event. Invented names and facilities only.
 */
export const SYNTHETIC_CASE_PAGES: string[][] = [
  [
    'EMERGENCY DEPARTMENT RECORD',
    'Facility: Lakeside General Hospital (synthetic)',
    'Patient: Ramiro608 Jacobs452   DOB: 07/19/1984',
    'Date of Service: 01/05/2025',
    'Attending: Dr. Maya Synthetic, MD',
    'Chief complaint: low back pain after motor vehicle collision.',
    'Diagnosis: lumbar radiculopathy',
  ],
  ['LABORATORY RESULTS', 'Collected: 2025-02-01', 'Hemoglobin A1c 5.4 %  reference range 4.0-5.6'],
  [
    'RADIOLOGY REPORT - MRI LUMBAR SPINE',
    'Facility: Lakeside Imaging Center (synthetic)',
    'Date of Service: 02/10/2025',
    'Impression: L4-L5 disc herniation with lumbar radiculopathy.',
  ],
  [
    'OFFICE VISIT - RIVERSIDE ORTHOPAEDICS',
    'Facility: Riverside Orthopaedic Clinic',
    'Date of Service: 03/14/2025',
    'Seen by: Dr. Alan Synthetic, MD',
    'Diagnoses: 1. Lumbar radiculopathy 2. Essential hypertension',
    'Medications: gabapentin 300 mg',
  ],
  [
    'PHYSICAL THERAPY PROGRESS NOTE',
    'Date of Service: 04/02/2025',
    'Therapist: Sam Synthetic, PT',
    'Lumbar stabilisation exercises; pain improved.',
  ],
  ['ITEMIZED STATEMENT OF CHARGES', 'Account SYN-0001', 'Total charges: $1,234.00', 'Amount due'],
];

export async function syntheticCasePdf() {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Synthetic case records (test data)');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const lines of SYNTHETIC_CASE_PAGES) {
    const page = pdf.addPage([612, 792]);
    page.drawText('SYNTHETIC TEST RECORD - NOT A REAL PATIENT', { x: 50, y: 760, size: 9, font });
    lines.forEach((line, i) => page.drawText(line, { x: 50, y: 730 - i * 18, size: 11, font }));
  }
  return pdf.save({ useObjectStreams: false });
}
