import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { IdeaDraft, IdeaEvidenceSnapshot, IdeaReview } from '../../../../shared/idea.js';
import { IdeaEstimate, IdeaHead, IdeaPage, IdeaRevision, IdeaRun, type Run } from '../../../models/idea-models.js';
import { buildPrompt, type PromptInput } from '../../../util/idea/prompts.js';
import { IDEA_INFERENCE_PROFILE } from '../../../util/idea/config.js';
import type { aiEstimateInput, aiSubmitInput } from '../../validators/idea.js';
import { readRecord, readySnapshot, selectedReview, authorizedRun } from './review-service.js';
import { requireWrite, resolveActor, type Actor } from './permission-service.js';
import { hash } from './revision-store.js';
import { IdeaError } from './errors.js';
import { reviewEnabled } from './capture-config.js';
import { AI_BUDGET, reserveBudget, settleBudget, assertBudgetOpen } from './ai-quota.js';
import { createProviders, providerConfiguration } from './live-provider.js';

export const AI_DISCLOSURE = Object.freeze({
  version: 'idea-data-use-openai-v2',
  text: 'Selected chapter text, alt text/captions, review context and reviewer prompt adjustments are sent to OpenAI Luna. Synthesis includes the selected saved assessments (including notes) and explicitly selected AI drafts; follow-up includes its parent draft. OpenAI store:false does not eliminate default abuse-monitoring retention. Output is an AI draft requiring faculty review. No source changes are made.',
  cost: 'Each submitted run reserves Luna spending allowance and settles at reported usage, or the full reservation if usage is unknown.',

});
export const aiEnabled = (projectID: string) => reviewEnabled(projectID) && process.env.IDEA_AI_ENABLED === 'true' && process.env.IDEA_WORKER_ENABLED === 'true';
export function assertAIEnabled(projectID: string) {
  if (!aiEnabled(projectID)) throw new IdeaError(503, 'AI_DISABLED');
  if (!providerConfiguration().valid) throw new IdeaError(503, 'AI_PROFILE_MISMATCH');
}
export interface AIBundle {
  request: z.infer<typeof aiEstimateInput>; headID: string; revisionIDs: string[]; bookID: string;
  promptInput: PromptInput; prompt: ReturnType<typeof buildPrompt>;
  profile: typeof IDEA_INFERENCE_PROFILE; budget: typeof AI_BUDGET; disclosure: typeof AI_DISCLOSURE;
}
async function currentActor(actor: Actor) { return resolveActor({ uuid: actor.uuid, sessionId: actor.sessionID }, actor.projectID); }
export async function assertFresh(actor: Actor, bundle: AIBundle) {
  requireWrite(actor);
  const head = await IdeaHead.findOne({ _id: bundle.headID, projectID: actor.projectID }).lean();
  if (!head) throw new IdeaError(404, 'NOT_FOUND'); requireWrite(actor, head);
  const revision = await IdeaRevision.findById(head.currentRevisionID).lean();
  if (head.archived || head.currentRevisionID !== bundle.request.revisionID || revision?.data.status !== 'draft' || head.bookID !== actor.bookID || head.bookID !== bundle.bookID ||
      hash(bundle.profile) !== hash(IDEA_INFERENCE_PROFILE) || hash(bundle.budget) !== hash(AI_BUDGET) || hash(bundle.disclosure) !== hash(AI_DISCLOSURE) ||
      hash(buildPrompt(bundle.promptInput)) !== hash(bundle.prompt)) throw new IdeaError(409, 'INPUT_STALE');
  for (const id of bundle.revisionIDs) {
    const r = await IdeaRevision.findById(id).lean(); if (!r) throw new IdeaError(409, 'INPUT_STALE');
    await readRecord(actor, r.headID, r.data && 'inputs' in r.data ? 'synthesis' : 'review', id);
  }
}
export async function estimateRun(actor: Actor, request: z.infer<typeof aiEstimateInput>) {
  actor = await currentActor(actor); assertAIEnabled(actor.projectID); requireWrite(actor); await assertBudgetOpen();
  const providers = createProviders(); if (!providers.openai.available()) throw new IdeaError(503, 'PROVIDER_UNAVAILABLE');
  const kind = request.mode === 'synthesis' ? 'synthesis' : 'review';
  const { head, revision } = await readRecord(actor, request.headID, kind, request.revisionID); requireWrite(actor, head);
  if (request.mode !== 'followup' && (request.parentRunID || request.focus)) throw new IdeaError(422, 'INVALID_PARENT');
  const snapshots: IdeaEvidenceSnapshot[] = [];
  for (const id of revision.snapshotIDs) {
    const snapshot = await readySnapshot(actor, id, head.bookID);
    const pages = await IdeaPage.find({ snapshotID: id, state: 'captured' }).lean();
    snapshots.push({ snapshotID: id, chapterTitle: snapshot.chapterTitle, pageIDs: snapshot.pageIDs, excludedPageIDs: snapshot.excludedPageIDs,
      blocks: snapshot.pageIDs.flatMap((id) => pages.find((p) => p.pageID === id)?.blocks ?? []) as IdeaEvidenceSnapshot['blocks'] });
  }
  const promptInput: PromptInput = { mode: request.mode, context: revision.data.context, snapshots };
  const revisionIDs = [revision._id];
  if ('inputs' in revision.data) {
    promptInput.assessments = [];
    for (const entry of revision.data.inputs) {
      const selected = await selectedReview(actor, entry.revisionID, head.bookID);
      promptInput.assessments.push({ revisionID: entry.revisionID, snapshotID: entry.snapshotID, review: selected.revision.data as IdeaReview });
      revisionIDs.push(entry.revisionID);
    }
    promptInput.includedDrafts = [];
    for (const id of revision.data.includedDraftIDs) {
      const run = await authorizedRun(actor, id);
      if (run.status !== 'succeeded' || run.revisionIDs.length !== 1 || !revisionIDs.includes(run.revisionIDs[0])) throw new IdeaError(422, 'DRAFT_INPUT_MISMATCH');
      promptInput.includedDrafts.push({ runID: id, revisionID: run.revisionIDs[0], draft: run.output as IdeaDraft });
    }
  }
  if (request.mode === 'followup') {
    if (!request.parentRunID || !request.focus) throw new IdeaError(422, 'PARENT_REQUIRED');
    const parent = await authorizedRun(actor, request.parentRunID);
    // Follow-up may use an older draft on this same review; the evidence snapshot is immutable.
    const parentRevision = await IdeaRevision.findById(parent.revisionIDs[0]).lean();
    if (parent.status !== 'succeeded' || parentRevision?.headID !== head._id || parent.mode === 'synthesis') throw new IdeaError(422, 'DRAFT_INPUT_MISMATCH');
    promptInput.parent = { runID: parent._id, draft: parent.output as IdeaDraft, focus: request.focus };
  }
  let prompt: ReturnType<typeof buildPrompt>;
  try { prompt = buildPrompt(promptInput); } catch { throw new IdeaError(422, 'AI_INPUT_INVALID_OR_TOO_LARGE'); }
  const bundle: AIBundle = { request, headID: head._id, bookID: head.bookID, revisionIDs, promptInput, prompt, profile: IDEA_INFERENCE_PROFILE, budget: AI_BUDGET, disclosure: AI_DISCLOSURE };
  await assertFresh(actor, bundle);
  const estimate = await IdeaEstimate.create({ _id: randomUUID(), projectID: actor.projectID, ownerUUID: actor.uuid, input: bundle, inputHash: hash(bundle), createdAt: new Date(), expiresAt: new Date(Date.now() + 300000) });
  return { estimateID: estimate._id, inputHash: estimate.inputHash, expiresAt: estimate.expiresAt, manifest: prompt.manifest, profile: bundle.profile, budget: bundle.budget, disclosure: AI_DISCLOSURE };
}
export async function submitRun(actor: Actor, request: z.infer<typeof aiSubmitInput>) {
  actor = await currentActor(actor); requireWrite(actor); assertAIEnabled(actor.projectID);
  const payloadHash = hash(request);
  const previous = await IdeaRun.findOne({ projectID: actor.projectID, ownerUUID: actor.uuid, idempotencyKey: request.idempotencyKey }).lean();
  if (previous) {
    await authorizedRun(actor, previous._id);
    if (previous.payloadHash !== payloadHash) throw new IdeaError(409, 'IDEMPOTENCY_CONFLICT');
    return { runID: previous._id, status: previous.status };
  }
  const estimate = await IdeaEstimate.findOne({ _id: request.estimateID, projectID: actor.projectID, ownerUUID: actor.uuid }).lean();
  if (!estimate || estimate.expiresAt.getTime() <= Date.now() || estimate.inputHash !== request.inputHash || hash(estimate.input) !== estimate.inputHash) throw new IdeaError(409, 'ESTIMATE_STALE');
  const bundle = estimate.input as AIBundle; await assertFresh(actor, bundle);
  const now = new Date();
  let run: Run;
  try { run = (await IdeaRun.create({ _id: randomUUID(), projectID: actor.projectID, ownerUUID: actor.uuid, sessionID: actor.sessionID,
    revisionIDs: bundle.revisionIDs, mode: bundle.request.mode, parentRunID: bundle.request.parentRunID, input: bundle, inputHash: estimate.inputHash, profile: bundle.profile,
    estimateID: estimate._id, day: now.toISOString().slice(0, 10), payloadHash, idempotencyKey: request.idempotencyKey,
    status: 'admission', phase: 'reserving', attempts: [], cancelRequested: false, settled: false, createdAt: now, updatedAt: now })).toObject(); }
  catch (error) { if ((error as { code?: number }).code === 11000) return submitRun(actor, request); throw error; }
  try {
    await reserveBudget(run);
    // Repair only fences admission after 60 seconds; a delayed admission cannot queue after repair.
    const result = await IdeaRun.updateOne({ _id: run._id, status: 'admission', updatedAt: { $gt: new Date(Date.now() - 60000) } }, { $set: { status: 'queued', phase: 'queued', updatedAt: new Date() } });
    if (!result.modifiedCount) throw new IdeaError(409, 'ADMISSION_EXPIRED');
    return { runID: run._id, status: 'queued' };
  } catch (error) {
    await IdeaRun.updateOne({ _id: run._id, status: 'admission' }, { $set: { status: 'failed', phase: 'admission_failed', error: { code: error instanceof IdeaError ? error.code : 'ADMISSION_FAILED' }, updatedAt: new Date() } });
    await settleBudget(run);
    await IdeaRun.updateOne({ _id: run._id, status: 'failed' }, { $set: { settled: true } });
    throw error;
  }
}
