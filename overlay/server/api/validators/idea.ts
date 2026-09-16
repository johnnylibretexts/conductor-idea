import { z } from 'zod';
import type { IdeaSynthesis } from '../../../shared/idea.js';
import { contextSchema, reviewSchema } from '../../util/idea/contracts.js';
export const uuid = z.uuid();
export const key = z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const distinct = (ids: string[]) => new Set(ids).size === ids.length;
export const createReviewInput = z.strictObject({ snapshotID: uuid, context: contextSchema, idempotencyKey: key, acknowledgePartial: z.boolean().optional() });
export const createSynthesisInput = z.strictObject({
  reviewRevisionIDs: z.array(uuid).min(2).max(10).refine(distinct),
  includedDraftIDs: z.array(uuid).max(10).refine(distinct), context: contextSchema, idempotencyKey: key,
});
export const synthesisSchema = z.strictObject({
  schemaVersion: z.literal(1), context: contextSchema,
  inputs: z.array(z.strictObject({ revisionID: uuid, headID: uuid, snapshotID: uuid, ownerUUID: uuid, version: z.number().int().positive(), status: z.enum(['draft', 'finished']) })).min(2).max(10),
  includedDraftIDs: z.array(uuid).max(10),
  draftDisposition: z.enum(['not_reviewed', 'useful', 'needs_correction', 'rejected']),
  dispositionRunID: uuid.nullable(), summary: z.string().max(8000), suggestions: z.string().max(8000),
  proposals: reviewSchema.shape.proposals, status: z.enum(['draft', 'finished']),
}).superRefine((v, ctx) => {
  if (v.status === 'finished' && (!v.summary.trim() || v.draftDisposition === 'not_reviewed' || !v.dispositionRunID))
    ctx.addIssue({ code: 'custom', message: 'Finish requires a saved draft disposition and human summary' });
});
export type Synthesis = IdeaSynthesis;
const mutation = { expectedVersion: z.number().int().min(1), mutationID: key };
export const patchReviewInput = z.strictObject({
  ...mutation, answers: reviewSchema.shape.answers.optional(), context: contextSchema.optional(),
  checklist: reviewSchema.shape.checklist.optional(), demographicContextPercent: reviewSchema.shape.demographicContextPercent.optional(),
  summary: z.string().max(8000).optional(), suggestions: z.string().max(8000).optional(), proposals: reviewSchema.shape.proposals.optional(),
}).refine((v) => Object.keys(v).length > 2, 'No changes supplied');
export const patchSynthesisInput = z.strictObject({
  ...mutation, context: contextSchema.optional(), summary: z.string().max(8000).optional(), suggestions: z.string().max(8000).optional(),
  proposals: reviewSchema.shape.proposals.optional(), draftDisposition: synthesisSchema.shape.draftDisposition.optional(),
  dispositionRunID: uuid.nullable().optional(),
}).refine((v) => Object.keys(v).length > 2, 'No changes supplied');
export const transitionInput = z.strictObject({ ...mutation, action: z.enum(['finish', 'reopen', 'archive', 'restore']) });
export const listInput = z.strictObject({ pageSize: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(512).optional() });
export const readInput = z.strictObject({ revisionID: uuid.optional() });
export const exportInput = z.strictObject({ revisionID: uuid, format: z.enum(['md', 'json']) });
export const feedbackInput = z.strictObject({ expectedVersion: z.number().int().min(0), disposition: z.enum(['useful', 'needs_correction', 'rejected']), note: z.string().max(4000) });


export const pageID = z.string().regex(/^[1-9][0-9]{0,14}$/);
export const sourceTreeInput = z.strictObject({ rootID: pageID.optional() });
export const captureInput = z.strictObject({
  chapterRootID: pageID, pageIDs: z.array(pageID).min(1).max(25).refine(distinct),
  supplementPageIDs: z.array(pageID).max(5).refine(distinct), idempotencyKey: key,
});
export const sourceCheckInput = z.strictObject({ snapshotID: uuid, idempotencyKey: key });

export const aiEstimateInput = z.strictObject({
  headID: uuid, revisionID: uuid, mode: z.enum(['7.1', '7.2', '7.3', '7.4', '7.5', '7.6', '7.7', '7.7.1', '7.8', 'rubric', 'followup', 'synthesis']),
  parentRunID: uuid.optional(), focus: z.enum(['7.1', '7.2', '7.3', '7.4', '7.5', '7.6', '7.7', '7.7.1', '7.8']).optional(),
});
export const aiSubmitInput = z.strictObject({ estimateID: uuid, inputHash: z.string().regex(/^[a-f0-9]{64}$/), disclosureVersion: z.literal('idea-data-use-openai-v2'), acknowledgeDataUse: z.literal(true), idempotencyKey: key });

export const runListInput = z.strictObject({ headID: uuid, kind: z.enum(['review', 'synthesis']).default('review'), before: z.string().regex(/^[0-9TZ:.\-]+\|[a-f0-9-]{36}$/).refine((v) => Number.isFinite(Date.parse(v.split('|')[0]))).optional() });
