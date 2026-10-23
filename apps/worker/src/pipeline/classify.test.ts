import { describe, expect, it } from 'vitest';
import { classifyPage } from './classify';

// Synthetic page text only.
describe('classifyPage', () => {
  it.each([
    ['EMERGENCY DEPARTMENT RECORD\nTriage: ESI 3\nChief complaint: neck pain after MVC', 'er'],
    [
      'RADIOLOGY REPORT\nMRI lumbar spine without contrast\nFindings: L4-5 disc protrusion',
      'imaging',
    ],
    ['LABORATORY RESULTS\nCBC with differential\nReference range 4.5-11.0', 'lab'],
    [
      'OPERATIVE REPORT\nPreoperative diagnosis: torn meniscus\nEstimated blood loss: 10 mL',
      'operative',
    ],
    [
      'PHYSICAL THERAPY DAILY NOTE\nTherapeutic exercise 30 min\nRange of motion improved',
      'therapy',
    ],
    ['Main Street Pharmacy\nRx Number: 448812\nDispensed: gabapentin 300 mg, Qty 90', 'pharmacy'],
    ['ITEMIZED STATEMENT OF ACCOUNT\nCPT 99213 charges 180.00\nAmount due 40.00', 'billing'],
    [
      'OFFICE VISIT\nHistory of present illness: low back pain\nAssessment and plan: PT',
      'office_visit',
    ],
  ] as const)('classifies %#', (text, expected) => {
    expect(classifyPage(text)).toBe(expected);
  });

  it('returns other for empty, missing or unrecognised text', () => {
    expect(classifyPage('')).toBe('other');
    expect(classifyPage(null)).toBe('other');
    expect(classifyPage('Fax cover sheet. Pages: 4. Please call with questions.')).toBe('other');
  });

  it('needs more than one weak keyword', () => {
    expect(classifyPage('Patient to follow up as needed.')).toBe('other');
  });

  it('does not match keywords inside other words', () => {
    expect(classifyPage('Items listed: ctrl, scanned, specimens of handwriting')).toBe('other');
  });
});
