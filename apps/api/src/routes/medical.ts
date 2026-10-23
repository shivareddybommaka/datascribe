import {
  CODE_PATTERN,
  MAX_RAW_LENGTH,
  createMedicalData,
  deidentifyTerm,
  isRxcui,
  type MedicalData,
} from '@datascribe/medical-data';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../auth/middleware';
import type { Deps } from '../context';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validate';
import { requireInternal } from './crm/common';

const Query = z.string().trim().min(2).max(MAX_RAW_LENGTH);
const Limit = z.coerce.number().int().min(1).max(50).default(10);

/** De-identify a staff-typed term (§8.4) or answer 422. The raw input is never echoed or logged. */
function safeTerm(raw: string) {
  const r = deidentifyTerm(raw);
  if (!r.ok) {
    throw new HttpError(
      422,
      'term_refused',
      r.reason === 'too_long'
        ? 'Enter a short clinical term, not free text'
        : 'Nothing left to search after removing identifiers',
      { reason: r.reason, removed: r.removed },
    );
  }
  return r;
}

/**
 * §9 medical lookups for manual coding. Staff only: internal org + cases:edit, so sales, finance,
 * QA (view-only) and every client user get 403. Responses carry source attribution (§8.4).
 */
export function medicalRouter(deps: Deps): Router {
  const md: MedicalData = deps.medical ?? createMedicalData({ provider: 'mock' });
  const r = Router();
  r.use('/medical', authenticate(deps), requireInternal, requirePermission('cases', 'edit'));

  r.get('/medical/icd10', async (req, res) => {
    const q = parse(z.object({ q: Query, limit: Limit }), req.query);
    const t = safeTerm(q.q);
    const items = await md.diagnosis.search(t.term, q.limit);
    res.json({ query: t.term, removed: t.removed, items, attribution: md.diagnosis.attribution });
  });

  r.get('/medical/rxnorm', async (req, res) => {
    const q = parse(z.object({ q: Query }), req.query);
    const t = safeTerm(q.q);
    const items = await md.medication.normalize(t.term);
    res.json({ query: t.term, removed: t.removed, items, attribution: md.medication.attribution });
  });

  r.get('/medical/drug-label', async (req, res) => {
    const q = parse(
      z
        .object({
          q: Query.optional(),
          rxcui: z.string().trim().refine(isRxcui, 'RxCUI must be digits').optional(),
        })
        .refine((v) => Boolean(v.q) !== Boolean(v.rxcui), 'Give exactly one of q or rxcui'),
      req.query,
    );
    const t = q.rxcui ? { term: q.rxcui, removed: [] } : safeTerm(q.q!);
    const label = await md.drugInfo.getLabel(t.term);
    res.json({ query: t.term, removed: t.removed, label, attribution: md.drugInfo.attribution });
  });

  r.get('/medical/define', async (req, res) => {
    const q = parse(
      z
        .object({
          code: z.string().trim().toUpperCase().max(20),
          system: z.enum(['ICD10CM', 'RXNORM', 'SNOMED']).default('ICD10CM'),
        })
        // codes are validated by shape, so nothing but a code can reach MedlinePlus
        .refine((v) => CODE_PATTERN[v.system].test(v.code), {
          message: 'Not a valid code for this system',
          path: ['code'],
        }),
      req.query,
    );
    const definition = await md.consumerHealth.define({
      system: q.system,
      code: q.code,
      display: '',
      source: '',
    });
    res.json({
      code: q.code,
      system: q.system,
      definition,
      attribution: md.consumerHealth.attribution,
    });
  });

  return r;
}
