import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION,
  MockOcrProvider,
  TesseractOcrProvider,
  createMedicalData,
  createOcrProvider,
  createSummaryProvider,
  medicalDataConfigFromEnv,
  ocrProviderFromEnv,
} from '../src';

describe('factory', () => {
  it('defaults to mock providers', () => {
    expect(createMedicalData().provider).toBe('mock');
    expect(medicalDataConfigFromEnv({})).toEqual({ provider: 'mock', openFdaApiKey: undefined });
  });

  it('reads MEDICAL_DATA_PROVIDER and OPENFDA_API_KEY, rejecting unknown providers', () => {
    expect(
      medicalDataConfigFromEnv({ MEDICAL_DATA_PROVIDER: 'nlm', OPENFDA_API_KEY: 'k' }),
    ).toEqual({
      provider: 'nlm',
      openFdaApiKey: 'k',
    });
    expect(() => medicalDataConfigFromEnv({ MEDICAL_DATA_PROVIDER: 'umls' })).toThrow(
      /MEDICAL_DATA_PROVIDER/,
    );
    expect(createMedicalData({ provider: 'nlm' }).provider).toBe('nlm');
  });

  it('OCR and summary factories provide mocks and refuse unimplemented providers', () => {
    expect(createOcrProvider()).toBeInstanceOf(MockOcrProvider);
    expect(createOcrProvider('tesseract')).toBeInstanceOf(TesseractOcrProvider);
    expect(() => createOcrProvider('textract')).toThrow(/not implemented/);
    expect(ocrProviderFromEnv({})).toBe('mock');
    expect(ocrProviderFromEnv({ OCR_PROVIDER: 'tesseract' })).toBe('tesseract');
    expect(() => ocrProviderFromEnv({ OCR_PROVIDER: 'abbyy' })).toThrow(/OCR_PROVIDER/);
    expect(createSummaryProvider('mock')).toBeDefined();
    expect(() => createSummaryProvider('anthropic')).toThrow(/not implemented/);
  });
});

describe('mock providers are deterministic and offline', () => {
  const md = createMedicalData({ provider: 'mock' });

  it('DiagnosisCoder', async () => {
    const a = await md.diagnosis.search('lumbar radiculopathy');
    expect(a[0]).toEqual({
      system: 'ICD10CM',
      code: 'M54.16',
      display: 'Radiculopathy, lumbar region',
      score: 1,
      source: ATTRIBUTION.mock.source,
    });
    expect(await md.diagnosis.search('lumbar radiculopathy')).toEqual(a);
    expect(await md.diagnosis.search('unknown condition xyz')).toEqual([]);
    expect(await md.diagnosis.search('MRN 12345678')).toEqual([]);
    expect((await md.diagnosis.search('pain', 1)).length).toBe(1);
  });

  it('ProcedureCoder and MedicationNormalizer', async () => {
    expect((await md.procedure.search('cervical collar'))[0]).toMatchObject({
      system: 'HCPCS',
      code: 'L0120',
    });
    expect((await md.medication.normalize('Gabapentin 300 mg'))[0]).toMatchObject({
      system: 'RXNORM',
      code: '25480',
    });
  });

  it('DrugInfoProvider by name or RxCUI', async () => {
    expect(await md.drugInfo.getLabel('25480')).toMatchObject({ source: ATTRIBUTION.mock.source });
    expect((await md.drugInfo.getLabel('ibuprofen'))?.indications).toMatch(/ibuprofen/);
    expect(await md.drugInfo.getLabel('99999999')).toBeNull();
    expect(await md.drugInfo.getLabel('unknownium')).toBeNull();
  });

  it('ConsumerHealthInfo', async () => {
    const def = await md.consumerHealth.define({
      system: 'ICD10CM',
      code: 'm54.16',
      display: '',
      source: '',
    });
    expect(def).toMatchObject({ title: 'Radiculopathy, lumbar region' });
    expect(
      await md.consumerHealth.define({ system: 'ICD10CM', code: 'Z99.9', display: '', source: '' }),
    ).toBeNull();
    expect(await md.usageStats()).toEqual([]);
  });

  it('OcrProvider returns text buffers as text and a stable placeholder for images', async () => {
    const ocr = createOcrProvider('mock');
    expect(await ocr.recognize(Buffer.from('Office visit: neck pain'))).toEqual({
      text: 'Office visit: neck pain',
      confidence: 0.99,
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const a = await ocr.recognize(png);
    expect(a).toEqual(await ocr.recognize(png));
    expect(a.text).toMatch(/^\[mock OCR page [0-9a-f]{12}\]$/);
    expect(a.confidence).toBe(0.5);
  });

  it('SummaryProvider builds the same cited sections for the same input', async () => {
    const s = createSummaryProvider();
    const input = {
      caseId: 'c1',
      events: [
        {
          date: '2024-02-01',
          description: 'Follow-up, gabapentin started',
          codes: [{ system: 'RXNORM' as const, code: '25480', display: 'gabapentin', source: 'm' }],
          citation: { documentId: 'd1', pageNumber: 4 },
        },
        {
          date: '2024-01-10',
          description: 'ER visit after fall',
          codes: [
            {
              system: 'ICD10CM' as const,
              code: 'M54.16',
              display: 'Radiculopathy, lumbar region',
              source: 'm',
            },
          ],
          citation: { documentId: 'd1', pageNumber: 1 },
        },
        {
          date: null,
          description: 'Undated note',
          codes: [],
          citation: { documentId: 'd2', pageNumber: 2 },
        },
      ],
    };
    const out = await s.summarize(input);
    expect(out).toEqual(await s.summarize(input));
    expect(out.provider).toBe('mock');
    expect(out.sections.map((x) => x.heading)).toEqual([
      'Overview',
      'Diagnoses',
      'Treatment course',
      'Medications',
    ]);
    expect(out.sections[0]!.paragraphs[0]).toBe(
      'The records contain 3 clinical event(s) dated 2024-01-10 to 2024-02-01.',
    );
    expect(out.sections[2]!.paragraphs[0]).toBe('2024-01-10: ER visit after fall [doc d1 p.1]');
    expect(out.sections[2]!.paragraphs[2]).toMatch(/^Undated: Undated note \[doc d2 p\.2\]$/);
    for (const p of out.sections.slice(1).flatMap((x) => x.paragraphs))
      expect(p).toMatch(/\[doc \w+ p\.\d+\]$/);

    const empty = await s.summarize({ caseId: 'c2', events: [] });
    expect(empty.sections[0]!.paragraphs[0]).toBe('No clinical events were extracted.');
  });
});
