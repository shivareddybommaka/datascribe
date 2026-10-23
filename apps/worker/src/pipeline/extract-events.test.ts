import { describe, expect, it } from 'vitest';
import { extractEvent, findServiceDate } from './extract-events';

// Synthetic page text only.
const OFFICE = `RIVERSIDE ORTHOPAEDICS
Facility: Riverside Orthopaedic Clinic
Patient: Jane Testpatient   DOB: 01/02/1980
Date of Service: 03/14/2025
Seen by: Dr. Alan Synthetic, MD
BP 128/82  HR 76  Pain: 6/10
Diagnoses:
1. Lumbar radiculopathy (M54.16)
2. Cervical strain
Medications: gabapentin 300 mg; ibuprofen 600 mg
Procedure: lumbar epidural steroid injection
Follow-up in 4 weeks.`;

describe('findServiceDate', () => {
  it('prefers the labelled service date and skips the birth date', () => {
    expect(findServiceDate(OFFICE)).toBe('2025-03-14');
  });

  it('reads ISO and long-form dates', () => {
    expect(findServiceDate('Exam date: 2024-11-05')).toBe('2024-11-05');
    expect(findServiceDate('Seen on March 3, 2025 for follow-up')).toBe('2025-03-03');
    expect(findServiceDate('Sept. 9 2024 note')).toBe('2024-09-09');
  });

  it('rejects impossible dates and birth-date-only pages', () => {
    expect(findServiceDate('Date of service: 02/31/2025')).toBeNull();
    expect(findServiceDate('DOB: 01/02/1980')).toBeNull();
    expect(findServiceDate('no dates here')).toBeNull();
  });
});

describe('extractEvent', () => {
  it('pulls date, provider, facility, terms and vitals with a page citation', () => {
    const e = extractEvent({
      documentId: 'doc1',
      pageNumber: 7,
      text: OFFICE,
      recordType: 'office_visit',
    });
    expect(e).toMatchObject({
      documentId: 'doc1',
      pageNumber: 7,
      eventDate: '2025-03-14',
      provider: 'Dr. Alan Synthetic, MD',
      facility: 'Riverside Orthopaedic Clinic',
      eventType: 'office_visit',
      terms: {
        diagnoses: ['Lumbar radiculopathy', 'Cervical strain'],
        procedures: ['lumbar epidural steroid injection'],
        medications: ['gabapentin 300 mg', 'ibuprofen 600 mg'],
      },
    });
    expect(e!.vitals).toEqual(['BP 128/82', 'HR 76', 'Pain: 6/10']);
    expect(e!.description).toMatch(
      /^Office visit\. Diagnoses: Lumbar radiculopathy; Cervical strain\./,
    );
  });

  it('keeps the patient name out of terms', () => {
    const e = extractEvent({
      documentId: 'd',
      pageNumber: 1,
      text: OFFICE,
      recordType: 'office_visit',
    });
    const all = Object.values(e!.terms).flat().join(' ');
    expect(all).not.toMatch(/Testpatient/);
  });

  it('skips billing pages and pages with no date or clinical terms', () => {
    expect(
      extractEvent({ documentId: 'd', pageNumber: 1, text: OFFICE, recordType: 'billing' }),
    ).toBeNull();
    expect(
      extractEvent({
        documentId: 'd',
        pageNumber: 2,
        text: 'Fax cover sheet',
        recordType: 'other',
      }),
    ).toBeNull();
    expect(
      extractEvent({ documentId: 'd', pageNumber: 3, text: null, recordType: 'other' }),
    ).toBeNull();
  });

  it('keeps an undated page that has clinical terms (date null)', () => {
    const e = extractEvent({
      documentId: 'd',
      pageNumber: 4,
      text: 'Impression: mild degenerative disc disease',
      recordType: 'imaging',
    });
    expect(e).toMatchObject({
      eventDate: null,
      terms: { diagnoses: ['mild degenerative disc disease'] },
    });
  });
});
