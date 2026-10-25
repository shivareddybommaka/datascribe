/**
 * Versioned staff edits of draft deliverables (M6 part 3, §5.4, D-086). The shapes match what the
 * worker's stage 6 writes (apps/worker/src/pipeline/deliverables.ts and the summary provider).
 * Content is PHI: callers store it encrypted and never log or audit it.
 */
import { z } from 'zod';

export const EDITABLE_TYPES = ['index', 'chronology', 'summary'] as const;
export type EditableType = (typeof EDITABLE_TYPES)[number];

/** Case states in which a summarizer works on the drafts. */
export const EDITABLE_CASE_STATUSES = ['in_review', 'changes_requested'] as const;
/** Deliverable states a new version may be saved on top of. */
export const EDITABLE_DELIVERABLE_STATUSES = ['draft', 'changes_requested'] as const;

const Id = z.string().min(1).max(40);
const Str = (max: number) => z.string().trim().max(max);
const NullableStr = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => v || null);
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'Use YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(v.slice(0, 10))), 'Not a valid date')
  .transform((v) => v.slice(0, 10))
  .nullable();
const Page = z.number().int().min(1).max(100_000);

const Citation = z.object({ documentId: Id, fileName: Str(300), pageNumber: Page }).strict();

const ChronologyEntry = z
  .object({
    eventId: Id.optional(),
    date: IsoDate,
    provider: NullableStr(300),
    facility: NullableStr(300),
    eventType: NullableStr(100),
    description: Str(4000).min(1, 'An entry needs a description'),
    codes: z
      .array(z.object({ system: Str(40), code: Str(40), display: Str(500) }).strict())
      .max(50),
    citation: Citation,
  })
  .strict();

const IndexRow = z
  .object({
    documentId: Id,
    fileName: Str(300),
    pageFrom: Page,
    pageTo: Page,
    recordType: Str(60).min(1),
    providers: z.array(Str(300)).max(100),
    dateFrom: IsoDate,
    dateTo: IsoDate,
  })
  .strict()
  .refine((r) => r.pageFrom <= r.pageTo, 'pageFrom must not be after pageTo');

export const CONTENT_SCHEMAS = {
  chronology: z
    .object({ kind: z.literal('chronology'), entries: z.array(ChronologyEntry).max(5000) })
    .strict(),
  index: z
    .object({
      kind: z.literal('index'),
      rows: z.array(IndexRow).max(5000),
      totals: z
        .object({ documents: z.number().int().min(0), pages: z.number().int().min(0) })
        .strict(),
    })
    .strict(),
  summary: z
    .object({
      kind: z.literal('summary'),
      sections: z
        .array(
          z
            .object({
              heading: Str(300).min(1),
              paragraphs: z.array(Str(10_000).min(1)).max(200),
            })
            .strict(),
        )
        .max(100),
      provider: Str(100),
    })
    .strict(),
} as const;

export type DeliverableContent =
  | z.infer<(typeof CONTENT_SCHEMAS)['chronology']>
  | z.infer<(typeof CONTENT_SCHEMAS)['index']>
  | z.infer<(typeof CONTENT_SCHEMAS)['summary']>;

export const contentSchema = (type: EditableType) =>
  CONTENT_SCHEMAS[type] as z.ZodType<DeliverableContent, z.ZodTypeDef, unknown>;

export const SaveDeliverableBody = z
  .object({ baseVersion: z.number().int().min(1), content: z.unknown() })
  .strict();

/** Every page reference in the content: chronology citations and index page ranges. */
export function pageRefs(content: DeliverableContent): { documentId: string; page: number }[] {
  if (content.kind === 'chronology') {
    return content.entries.map((e) => ({
      documentId: e.citation.documentId,
      page: e.citation.pageNumber,
    }));
  }
  if (content.kind === 'index') {
    return content.rows.map((r) => ({ documentId: r.documentId, page: r.pageTo }));
  }
  return [];
}

/**
 * Cited pages must exist in one of the case's own documents. Returns the first problem, or null.
 * `pageCounts` maps the case's document ids to their page count (null = unknown, any page allowed).
 */
export function citationProblem(
  content: DeliverableContent,
  pageCounts: Map<string, number | null>,
): string | null {
  for (const ref of pageRefs(content)) {
    if (!pageCounts.has(ref.documentId)) return 'A citation points to a file outside this case';
    const count = pageCounts.get(ref.documentId);
    if (count != null && ref.page > count) return `A citation points past the last page (${count})`;
  }
  return null;
}

// ── QA (M6 part 4, §5.4, D-088) ────────────────────────────────────────

/** Case states from which the drafts go to QA (first time, or after changes were requested). */
export const SUBMITTABLE_CASE_STATUSES = EDITABLE_CASE_STATUSES;

export const QaDecisionBody = z
  .object({
    result: z.enum(['approved', 'changes_requested']),
    comments: z
      .string()
      .trim()
      .max(10_000)
      .nullish()
      .transform((v) => v || null),
  })
  .strict()
  .refine((v) => v.result === 'approved' || !!v.comments, {
    message: 'Say what needs to change',
    path: ['comments'],
  });

/**
 * Why a deliverable version can't go to QA or be approved, or null. Stage 6 output and staff edits
 * are both checked against the edit schemas, so "every chronology entry keeps a citation" (§5.4)
 * holds for whatever the pipeline wrote too.
 */
export function qaProblem(type: EditableType, content: unknown): string | null {
  const parsed = contentSchema(type).safeParse(content);
  if (parsed.success) return null;
  if (type === 'chronology') {
    const entries = (content as { entries?: unknown[] } | null)?.entries;
    const uncited = Array.isArray(entries)
      ? entries.filter((e) => !(e as { citation?: unknown } | null)?.citation).length
      : 0;
    if (uncited > 0) {
      return `${uncited} chronology ${uncited === 1 ? 'entry has' : 'entries have'} no source citation`;
    }
  }
  return `The ${type} is incomplete; open it, fix it and save`;
}

/** Item counts for the audit row (never content). */
export function contentCounts(content: DeliverableContent): Record<string, number> {
  if (content.kind === 'chronology') return { entries: content.entries.length };
  if (content.kind === 'index') return { rows: content.rows.length };
  return {
    sections: content.sections.length,
    paragraphs: content.sections.reduce((n, s) => n + s.paragraphs.length, 0),
  };
}
