import { z } from 'zod';
import type { IdeaDraft, IdeaReview, IdeaEvidenceSnapshot } from '../../../shared/idea.js';
import { CATEGORY_IDS, ROW_IDS, IDEA_FRAMEWORK, TASKS } from './framework.js';
import { IDEA_LIMITS as limits } from './config.js';

const text = z.string().trim().min(1).max(4000);
const id = z.string().min(1).max(160);
const category = z.enum(CATEGORY_IDS);
const rowID = z.enum(ROW_IDS);
export const ratingSchema = z.enum(['not_applicable', 'exclusive', 'emerging_inclusive', 'inclusive']);
const draftRating = z.enum([...ratingSchema.options, 'not_assessed']);
const destination = z.enum(['original_source', 'adapted_copy', 'instructor_supplement', 'student_supplement']);
const distinct = (values: readonly string[]) => new Set(values).size === values.length;
const categoryForRow = (row: string) => row.slice(0, 3);

export const snapshotSchema = z.strictObject({
  snapshotID: id, chapterTitle: text,
  pageIDs: z.array(id).min(1).max(25).refine(distinct),
  excludedPageIDs: z.array(id).max(500).refine(distinct),
  blocks: z.array(z.strictObject({
    blockID: id, pageID: id, ordinal: z.number().int().min(0).optional(), sourceAnchor: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/).optional(), kind: z.enum(['text', 'heading', 'caption', 'alt', 'metadata']),
    text: z.string().min(1).max(256 * 1024),
  })).min(1).max(2000),
}).superRefine((snapshot, ctx) => {
  if (snapshot.excludedPageIDs.some((page) => snapshot.pageIDs.includes(page)) ||
      snapshot.blocks.some((b) => !snapshot.pageIDs.includes(b.pageID)) ||
      !distinct(snapshot.blocks.map((b) => b.blockID))) {
    ctx.addIssue({ code: 'custom', message: 'Evidence must have unique blocks in captured, nonexcluded pages' });
  }
});

export const contextSchema = z.strictObject({
  discipline: text,
  intendedUse: z.enum(['original_platform', 'downloaded_package', 'lms_adaptation', 'other']),
  intendedExtent: z.enum(['selected_chapters', 'whole_book']),
  depth: z.enum(['requirements_only', 'requirements_and_considerations']),
  focus: z.array(category).min(1).max(8).refine(distinct, 'Duplicate focus category'),
  destination,
  licenseContext: z.string().max(4000),
  promptAdjustment: z.string().max(limits.promptAdjustmentChars),
  regionalFocus: z.string().max(400),
});

const humanAnswer = z.strictObject({
  rowID, categoryID: category,
  rating: z.enum([...ratingSchema.options, 'not_rated']),
  note: z.string().max(limits.noteChars),
  naRationale: z.string().max(limits.noteChars),
  adoptedTextRunID: id.nullable(),
}).refine((row) => categoryForRow(row.rowID) === row.categoryID, 'Row/category mismatch');

export const reviewSchema = z.strictObject({
  partialCaptureAcknowledged: z.boolean().optional(),
  schemaVersion: z.literal(1), context: contextSchema,
  answers: z.array(humanAnswer).length(10).refine((rows) => distinct(rows.map((r) => r.rowID)), 'Duplicate rubric row'),
  checklist: z.array(z.strictObject({ elementID: id, answer: z.enum(['yes', 'no', 'unsure', 'skip']) }))
    .max(100).refine((items) => distinct(items.map((i) => i.elementID)) &&
      items.every((item) => IDEA_FRAMEWORK.some((c) => c.elements.some((e) => e.id === item.elementID))), 'Invalid checklist element'),
  demographicContextPercent: z.number().min(0).max(100).nullable(),
  summary: z.string().max(limits.summaryChars), suggestions: z.string().max(limits.summaryChars),
  proposals: z.array(z.lazy(() => proposalSchema.extend({
    id, originRunID: id.nullable(),
    disposition: z.enum(['proposed', 'accepted_for_plan', 'rejected', 'deferred']),
  }))).max(100).refine((items) => distinct(items.map((p) => p.id)), 'Duplicate proposal ID'),
  status: z.enum(['draft', 'finished']),
}).superRefine((review, ctx) => {
  if (review.status !== 'finished') return;
  review.answers.forEach((answer, i) => {
    if (answer.rating === 'not_rated') ctx.addIssue({ code: 'custom', path: ['answers', i, 'rating'], message: 'Every row needs a human judgment' });
    if (answer.rating === 'not_applicable' && !answer.naRationale.trim()) ctx.addIssue({ code: 'custom', path: ['answers', i, 'naRationale'], message: 'Not Applicable needs an explanation' });
  });
});

/** Only creates human-unrated state. There is deliberately no draft-to-rating conversion. */
export function createReview(context: unknown): IdeaReview {
  return reviewSchema.parse({
    schemaVersion: 1, context: contextSchema.parse(context),
    answers: ROW_IDS.map((rowID) => ({ rowID, categoryID: categoryForRow(rowID), rating: 'not_rated', note: '', naRationale: '', adoptedTextRunID: null })),
    checklist: [], demographicContextPercent: null, summary: '', suggestions: '', proposals: [], status: 'draft',
  });
}

const evidence = z.strictObject({
  snapshotID: id, pageID: id, blockID: id,
  start: z.number().int().min(0), end: z.number().int().min(1),
  quote: z.string().min(1).max(4000),
}).refine((ref) => ref.end > ref.start, 'Invalid evidence span');
export const supportSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('quoted'), evidence: z.array(evidence).min(1).max(25) }),
  z.strictObject({ kind: z.literal('scope'), snapshotID: id, pageIDs: z.array(id).min(1).max(25).refine(distinct), limitation: text }),
]);
const finding = z.strictObject({ evidence: text, interpretation: text, recommendation: text, support: supportSchema });
const area = z.strictObject({ categoryID: category, rating: draftRating, notes: text, support: supportSchema });
const areasFor = (expected: readonly string[]) => z.array(area).length(expected.length).refine(
  (rows) => distinct(rows.map((r) => r.categoryID)) && rows.every((r) => expected.includes(r.categoryID)), 'Wrong or duplicate areas');
export const proposalSchema = z.strictObject({
  chapter: text, change: text, rationale: text, destination,
  priority: z.enum(['high', 'medium', 'low']), support: supportSchema,
});
const findings = z.array(finding).max(100);
const base = z.strictObject({ schemaVersion: z.literal(1), summary: text, limitations: z.array(text).max(25) });
const draftRows = z.array(z.strictObject({ rowID, categoryID: category, rating: draftRating, notes: text, support: supportSchema }))
  .length(10).refine((rows) => distinct(rows.map((r) => r.rowID)) && rows.every((r) => categoryForRow(r.rowID) === r.categoryID), 'Missing, duplicate or mismatched rubric rows');
const httpsURL = z.string().min(1).max(2000).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}, 'Only HTTPS links without credentials');

export const outputSchemas = {
  rubric: base.extend({ mode: z.literal('rubric'), rows: draftRows }),
  '7.1': base.extend({ mode: z.literal('7.1'), illustrations: z.array(z.strictObject({ chapterSection: text, imageDescription: text, suggestedRevision: text, support: supportSchema })).max(100) }),
  '7.2': base.extend({ mode: z.literal('7.2'), narrative: text, findings }),
  '7.3': base.extend({ mode: z.literal('7.3'), areas: areasFor(['7.3']), rewrites: findings }),
  '7.4': base.extend({ mode: z.literal('7.4'), narrative: text, findings, alternativeResearch: z.array(z.strictObject({ title: text, primaryURL: httpsURL, explanation: text, verification: z.literal('unverified') })).max(20) }),
  '7.5': base.extend({ mode: z.literal('7.5'), scenarios: z.array(z.strictObject({ scenario: text, representedPopulation: text, assumedSocialContext: text, diversityEvaluation: text, recommendation: text, support: supportSchema })).max(100) }),
  '7.6': base.extend({ mode: z.literal('7.6'), terminology: z.array(z.strictObject({ chapterSection: text, flaggedWording: text, historicalContext: text, suggestedRevision: text, support: supportSchema })).max(100) }),
  '7.7': base.extend({ mode: z.literal('7.7'), areas: areasFor(['7.7']), metadataChanges: z.array(z.strictObject({ kind: z.enum(['glossary_entry', 'cross_reference', 'heading']), proposedText: text, support: supportSchema })).max(100) }),
  '7.7.1': base.extend({ mode: z.literal('7.7.1'), areas: areasFor(['7.7']), openingConcepts: findings, endSummaries: findings, additions: z.array(z.strictObject({ chapter: text, missingTerms: z.array(text).min(1).max(50), proposedAdditions: text, support: supportSchema })).max(100) }),
  '7.8': base.extend({ mode: z.literal('7.8'), missingPerspectives: z.array(proposalSchema).max(100), presentStrengths: z.array(z.strictObject({ perspective: text, location: text, support: supportSchema })).max(100) }),
  followup: base.extend({ mode: z.literal('followup'), focus: z.enum([...CATEGORY_IDS, '7.7.1']), parentRunID: id, findings }),
  synthesis: base.extend({ mode: z.literal('synthesis'), inputRevisionIDs: z.array(id).min(2).max(10).refine(distinct), strengths: findings, unevenApplication: findings, unmetAreas: findings, areas: areasFor(CATEGORY_IDS), plan: z.array(proposalSchema).max(100) }),
} satisfies Record<typeof TASKS[number], z.ZodType<IdeaDraft>>;

export function parseDraft(mode: typeof TASKS[number], value: unknown): IdeaDraft {
  return outputSchemas[z.enum(TASKS).parse(mode)].parse(value);
}

/** Native schema is a first filter. Cross-field refinements still run locally. */
export function outputJSONSchema(mode: typeof TASKS[number]): Record<string, unknown> {
  return z.toJSONSchema(outputSchemas[z.enum(TASKS).parse(mode)]);
}

/** No fetching, identity classification or speculative citation verification. */
export function validateDraftEvidence(draft: IdeaDraft, snapshots: readonly IdeaEvidenceSnapshot[]): string[] {
  const errors: string[] = [];
  function walk(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (object.kind === 'quoted' || object.kind === 'scope') {
      const support = supportSchema.parse(value);
      if (support.kind === 'scope') {
        const snapshot = snapshots.find((s) => s.snapshotID === support.snapshotID);
        if (!snapshot || support.pageIDs.some((page) => !snapshot.pageIDs.includes(page) || snapshot.excludedPageIDs.includes(page))) errors.push('UNKNOWN_REVIEWED_SCOPE');
      } else {
        for (const ref of support.evidence) {
          const snapshot = snapshots.find((s) => s.snapshotID === ref.snapshotID);
          const block = snapshot?.blocks.find((b) => b.pageID === ref.pageID && b.blockID === ref.blockID);
          if (!snapshot?.pageIDs.includes(ref.pageID) || snapshot.excludedPageIDs.includes(ref.pageID) || !block) errors.push('UNKNOWN_EVIDENCE_LOCATION');
          else if (ref.end > Array.from(block.text).length || Array.from(block.text).slice(ref.start, ref.end).join('') !== ref.quote) errors.push('QUOTE_MISMATCH');
        }
      }
      return;
    }
    Object.values(object).forEach(walk);
  }
  walk(draft);
  return errors;
}
