// Adapter interfaces (REQUIREMENTS.md §8.3). Implementations (nlm, openfda, medlineplus, mock) land in M5.

export interface CodeMatch {
  system: 'ICD10CM' | 'RXNORM' | 'HCPCS' | 'SNOMED';
  code: string;
  display: string;
  score?: number;
  source: string;
}

export interface DiagnosisCoder {
  search(term: string, limit?: number): Promise<CodeMatch[]>;
}
export interface ProcedureCoder {
  search(term: string, limit?: number): Promise<CodeMatch[]>;
}
export interface MedicationNormalizer {
  normalize(name: string): Promise<CodeMatch[]>;
}
export interface DrugInfoProvider {
  getLabel(
    rxcuiOrName: string,
  ): Promise<{ indications?: string; warnings?: string; source: string } | null>;
}
export interface ConsumerHealthInfo {
  define(code: CodeMatch): Promise<{ title: string; summary: string; url: string } | null>;
}

export interface OcrProvider {
  recognize(image: Buffer): Promise<{ text: string; confidence: number }>;
}

export interface SummaryInput {
  caseId: string;
  events: {
    date: string | null;
    description: string;
    codes: CodeMatch[];
    citation: { documentId: string; pageNumber: number };
  }[];
}
export interface SummaryOutput {
  sections: { heading: string; paragraphs: string[] }[];
  provider: string;
}
export interface SummaryProvider {
  summarize(input: SummaryInput): Promise<SummaryOutput>;
}
