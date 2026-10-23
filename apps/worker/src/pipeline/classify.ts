/**
 * Stage 3 — classify pages (REQUIREMENTS.md §7). Keyword rules only; an LLM classifier can be added
 * behind config later. Pure: page text in, record type out. Never logs the text.
 */

export const RECORD_TYPES = [
  'office_visit',
  'er',
  'imaging',
  'lab',
  'operative',
  'therapy',
  'pharmacy',
  'billing',
  'other',
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

type Rule = [pattern: RegExp, weight: number];

/** Strong, document-header style phrases weigh 3; common body words weigh 1. */
const RULES: Record<Exclude<RecordType, 'other'>, Rule[]> = {
  er: [
    [/\bemergency (department|room)\b/, 3],
    [/\bED (course|visit|note|provider)\b/i, 3],
    [/\btriage\b/, 2],
    [/\bchief complaint\b/, 1],
    [/\bdischarged? (home|from (the )?ed)\b/, 1],
    [/\b(ambulance|ems)\b/, 1],
  ],
  imaging: [
    [/\b(radiology|imaging) report\b/, 3],
    [/\b(mri|ct|x-ray|xray|radiograph|ultrasound|fluoroscopy)\b/, 2],
    [/\bimpression:/, 1],
    [/\bfindings:/, 1],
    [/\btechnique:/, 1],
  ],
  lab: [
    [/\blaboratory (report|results)\b/, 3],
    [/\b(cbc|cmp|bmp|hba1c|lipid panel|urinalysis)\b/, 2],
    [/\breference range\b/, 2],
    [/\bspecimen\b/, 1],
    [/\b(collected|resulted):/, 1],
  ],
  operative: [
    [/\boperative (report|note)\b/, 3],
    [/\b(pre|post)-?operative diagnosis\b/, 3],
    [/\banesthesia\b/, 1],
    [/\bestimated blood loss\b/, 2],
    [/\bprocedure performed\b/, 1],
    [/\bincision\b/, 1],
  ],
  therapy: [
    [/\b(physical|occupational) therapy\b/, 3],
    [/\bpt (evaluation|daily note|progress note)\b/i, 3],
    [/\brange of motion\b/, 1],
    [/\btherapeutic exercise\b/, 2],
    [/\bchiropractic\b/, 2],
    [/\bvisits? remaining\b/, 1],
  ],
  pharmacy: [
    [/\bpharmacy\b/, 3],
    [/\b(rx|prescription) (number|#|no\.?)\b/i, 3],
    [/\bdispensed\b/, 2],
    [/\brefills?\b/, 1],
    [/\bqty\b/, 1],
  ],
  billing: [
    [/\b(itemi[sz]ed )?(statement|invoice) of (account|charges)\b/, 3],
    [/\b(ub-04|cms-1500|hcfa)\b/, 3],
    [/\bamount due\b/, 2],
    [/\b(balance|charges|payments?|adjustments?)\b/, 1],
    [/\bcpt\b/, 1],
  ],
  office_visit: [
    [/\b(office|clinic) visit\b/, 3],
    [/\bprogress note\b/, 2],
    [/\b(history of present illness|hpi)\b/, 2],
    [/\breview of systems\b/, 1],
    [/\bassessment( and|\/| &) plan\b/, 1],
    [/\bfollow[- ]up\b/, 1],
  ],
};

/** Minimum score for a type to win; below this a page is `other`. */
const MIN_SCORE = 2;

export function classifyPage(text: string | null | undefined): RecordType {
  if (!text) return 'other';
  const haystack = text.toLowerCase();
  let best: RecordType = 'other';
  let bestScore = MIN_SCORE - 1;
  // Object order is the tie-break: more specific types are listed first.
  for (const [type, rules] of Object.entries(RULES) as [RecordType, Rule[]][]) {
    let score = 0;
    for (const [pattern, weight] of rules) if (pattern.test(haystack)) score += weight;
    if (score > bestScore) {
      best = type;
      bestScore = score;
    }
  }
  return best;
}
