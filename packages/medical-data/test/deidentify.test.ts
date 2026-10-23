import { describe, expect, it } from 'vitest';
import {
  MAX_RAW_LENGTH,
  TermRefusedError,
  deidentifyTerm,
  requireSafeTerm,
  type IdentifierKind,
} from '../src/deidentify';

/** All names, numbers and addresses below are synthetic. */
function clean(input: string, knownIdentifiers?: string[]) {
  const r = deidentifyTerm(input, { knownIdentifiers });
  if (!r.ok) throw new Error(`refused (${r.reason}): ${input}`);
  return r;
}

describe('deidentifyTerm: clinical terms pass through unchanged', () => {
  it.each([
    'lumbar radiculopathy',
    'gabapentin 300 mg',
    'gabapentin 300 mg oral capsule',
    'L4-L5 disc herniation',
    'C5-6 radiculopathy',
    'type 2 diabetes mellitus with diabetic neuropathy',
    'hydrocodone/acetaminophen 10/325 mg',
    'vitamin B12 1000 mcg',
    'M54.16',
    'S06.0X0A',
    'MS flare',
    'CT lumbar spine',
    "Parkinson's disease",
    'post-traumatic headache',
    'heparin 5000 units',
    'acetaminophen 2000 mg',
  ])('%s', (term) => {
    const r = clean(term);
    expect(r.term).toBe(term);
    expect(r.removed).toEqual([]);
  });

  it('collapses whitespace and trims', () => {
    expect(clean('  lumbar    radiculopathy \n').term).toBe('lumbar radiculopathy');
  });
});

describe('deidentifyTerm: names', () => {
  it.each<[string, string]>([
    ['Mr. John Smith lumbar radiculopathy', 'lumbar radiculopathy'],
    ['Mrs Jane Doe-Carter neck pain', 'neck pain'],
    ['Dr. Alan Grant cervical sprain', 'cervical sprain'],
    ['Patient: Maria Lopez low back pain', 'low back pain'],
    ['pt - Kim Lee concussion', 'concussion'],
    ['Patient Ramiro Jacobs whiplash', 'whiplash'],
    ['Ramiro608 Jacobs452 whiplash', 'whiplash'],
    ['claimant: Devi Rao, sciatica', 'sciatica'],
    ["John Smith's lumbar sprain", 'lumbar sprain'],
  ])('%s', (input, expected) => {
    const r = clean(input);
    expect(r.term).toBe(expected);
    expect(r.removed).toContain<IdentifierKind>('name');
  });

  it('strips known identifiers for the case, whole or in parts, case-insensitively', () => {
    const r = clean('rowan quill knee effusion Quill', ['Rowan Quill']);
    expect(r.term).toBe('knee effusion');
    expect(r.removed).toContain('name');
  });

  it('strips a known case number', () => {
    const r = clean('DS-2026-0042 tibia fracture', ['DS-2026-0042']);
    expect(r.term).toBe('tibia fracture');
    expect(r.removed).toContain('record_number');
  });
});

describe('deidentifyTerm: dates including DOB', () => {
  it.each<[string, string]>([
    ['DOB 01/02/1950 hypertension', 'hypertension'],
    ['D.O.B.: 1950-02-01 hypertension', 'hypertension'],
    ['date of birth March 3, 1948 diabetes', 'diabetes'],
    ['born 12 Jan 1931 dementia', 'dementia'],
    ['seen 03/15/2024 for neck pain', 'seen for neck pain'],
    ['2024-03-15 lumbar sprain', 'lumbar sprain'],
    ['15.3.24 concussion', 'concussion'],
    ['neck pain since March 2024', 'neck pain since'],
    ['neck pain since Mar 15', 'neck pain since'],
    ['neck pain since 15th of March', 'neck pain since'],
    ['knee pain since 06/2023', 'knee pain since'],
    ['knee surgery in 2019', 'knee surgery in'],
    ['DOI: 2/3/24 whiplash', 'whiplash'],
  ])('%s', (input, expected) => {
    const r = clean(input);
    expect(r.term).toBe(expected);
    expect(r.removed).toContain<IdentifierKind>('date');
  });
});

describe('deidentifyTerm: MRNs, case and account numbers', () => {
  it.each<[string, string]>([
    ['MRN 00123456 lumbar radiculopathy', 'lumbar radiculopathy'],
    ['MRN: A1234567 sciatica', 'sciatica'],
    ['MR# 778899 sciatica', 'sciatica'],
    ['medical record number 4455667 neck pain', 'neck pain'],
    ['case no. DS-2026-0001 whiplash', 'whiplash'],
    ['Case # 24-1187 concussion', 'concussion'],
    ['claim number CLM-99812 back sprain', 'back sprain'],
    ['account 88812345 cervicalgia', 'cervicalgia'],
    ['2:24-cv-01234 neck pain', 'neck pain'],
    ['patient id 4471 vertigo', 'vertigo'],
    ['00981234 vertigo', 'vertigo'],
    ['123456789 neck pain', 'neck pain'],
  ])('%s', (input, expected) => {
    const r = clean(input);
    expect(r.term).toBe(expected);
    expect(r.removed.some((k) => k === 'record_number' || k === 'phone')).toBe(true);
  });

  it('strips SSNs', () => {
    const r = clean('SSN 123-45-6789 neck pain');
    expect(r.term).toBe('neck pain');
    expect(r.removed).toEqual(expect.arrayContaining(['ssn']));
  });
});

describe('deidentifyTerm: phone numbers and emails', () => {
  it.each<[string, string, IdentifierKind]>([
    ['(555) 123-4567 neck pain', 'neck pain', 'phone'],
    ['555-123-4567 neck pain', 'neck pain', 'phone'],
    ['555.123.4567 neck pain', 'neck pain', 'phone'],
    ['+1 555 123 4567 neck pain', 'neck pain', 'phone'],
    ['+61 2 9999 9999 neck pain', 'neck pain', 'phone'],
    ['+91 98765 43210 neck pain', 'neck pain', 'phone'],
    ['tel: 5551234 neck pain', 'neck pain', 'phone'],
    ['jane.doe@example.com neck pain', 'neck pain', 'email'],
    ['contact pt+1@mail.example.org re sciatica', 'contact re sciatica', 'email'],
    ['https://portal.example.com/p/123 neck pain', 'neck pain', 'url'],
  ])('%s', (input, expected, kind) => {
    const r = clean(input);
    expect(r.term).toBe(expected);
    expect(r.removed).toContain(kind);
  });

  it('does not treat doses as phone numbers', () => {
    expect(clean('gabapentin 300 600 900 mg').term).toBe('gabapentin 300 600 900 mg');
  });
});

describe('deidentifyTerm: addresses', () => {
  it.each<[string, string]>([
    ['123 Main St neck pain', 'neck pain'],
    ['4500 North Harbor Blvd. lumbar sprain', 'lumbar sprain'],
    ['12 elm street fall injury', 'fall injury'],
    ['PO Box 4412 sciatica', 'sciatica'],
    ['Apt 4B whiplash', 'whiplash'],
    ['Springfield, IL 62704 concussion', 'Springfield, concussion'],
    ['ZIP 90210 neck pain', 'ZIP neck pain'],
    ['PIN 560001 neck pain', 'PIN neck pain'],
  ])('%s', (input, expected) => {
    const r = clean(input);
    expect(r.term).toBe(expected);
    expect(r.removed.some((k) => k === 'address' || k === 'record_number')).toBe(true);
  });
});

describe('deidentifyTerm: ages (all removed; >89 is the HIPAA requirement)', () => {
  it.each<[string, string]>([
    ['92 year old hip fracture', 'hip fracture'],
    ['92-year-old hip fracture', 'hip fracture'],
    ['hip fracture 95 y/o', 'hip fracture'],
    ['hip fracture 101yo', 'hip fracture'],
    ['age 97 dementia', 'dementia'],
    ['aged 90 dementia', 'dementia'],
    ['dementia, 93 years of age', 'dementia'],
    ['45 yo low back pain', 'low back pain'],
  ])('%s', (input, expected) => {
    const r = clean(input);
    expect(r.term).toBe(expected);
    expect(r.removed).toContain<IdentifierKind>('age');
  });
});

describe('deidentifyTerm: refuses free text and empty results', () => {
  it('refuses raw input longer than a short phrase', () => {
    const r = deidentifyTerm('a'.repeat(MAX_RAW_LENGTH + 1));
    expect(r).toMatchObject({ ok: false, reason: 'too_long' });
  });

  it('refuses sentences with too many words', () => {
    const r = deidentifyTerm(
      'patient reports worsening low back pain radiating to the left leg after lifting boxes at work',
    );
    expect(r).toMatchObject({ ok: false, reason: 'too_long' });
  });

  it('refuses input that is only identifiers', () => {
    const r = deidentifyTerm('Mr. John Smith DOB 01/02/1950 MRN 12345678');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('empty');
      expect(r.removed).toEqual(expect.arrayContaining(['name', 'date', 'record_number']));
    }
  });

  it.each(['', '   ', '12345', '---', '(555) 123-4567'])('refuses %j', (input) => {
    expect(deidentifyTerm(input)).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('strips everything in a mixed note and keeps only the clinical part', () => {
    const r = clean(
      'Mr. Ramiro608 Jacobs452 DOB 1950-02-01 MRN 00981234 (555) 123-4567 lumbar radiculopathy',
    );
    expect(r.term).toBe('lumbar radiculopathy');
    expect(r.removed).toEqual(expect.arrayContaining(['name', 'date', 'record_number', 'phone']));
  });

  it('removes control characters and markup', () => {
    expect(clean('lumbar\u0000 radiculopathy<script>').term).toBe('lumbar radiculopathy script');
  });
});

describe('requireSafeTerm', () => {
  it('returns the cleaned term', () => {
    expect(requireSafeTerm('MRN 1234567 sciatica')).toBe('sciatica');
  });
  it('throws TermRefusedError with the reason', () => {
    expect(() => requireSafeTerm('DOB 01/02/1950')).toThrow(TermRefusedError);
    try {
      requireSafeTerm('x'.repeat(500));
    } catch (e) {
      expect((e as TermRefusedError).reason).toBe('too_long');
    }
  });
});
