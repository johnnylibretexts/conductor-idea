import { IdeaHead, IdeaRevision, IdeaSnapshot, IdeaRun, IdeaPage, type Kind, type Head, type Revision } from '../../../models/idea-models.js';
import { createReview, reviewSchema, validateDraftEvidence, parseDraft } from '../../../util/idea/contracts.js';
import { synthesisSchema, type Synthesis } from '../../validators/idea.js';
import { committedRevision, commit, getHead, hash, replay, reserveHead, type FaultHook } from './revision-store.js';
import { requireWrite, recordCapabilities, type Actor } from './permission-service.js';
import { conflict, IdeaError, notFound } from './errors.js';
import type { IdeaContext, IdeaEvidenceSnapshot } from '../../../../shared/idea.js';

export async function readySnapshot(actor: Actor, id: string, expectedBook?: string) {
  const snapshot = await IdeaSnapshot.findOne({ _id: id, projectID: actor.projectID }).lean();
  if (!snapshot) throw notFound();
  if (expectedBook && snapshot.bookID !== expectedBook) throw new IdeaError(422, 'BOOK_MISMATCH');
  if (!['ready', 'partial'].includes(snapshot.state) || !snapshot.hash || !snapshot.pageIDs.length)
    throw new IdeaError(422, 'SNAPSHOT_NOT_READY');
  const pages = await IdeaPage.find({ snapshotID: id }).select('pageID state').lean();
  if ([...snapshot.pageIDs, ...snapshot.excludedPageIDs].some((id) => !pages.some((p) => p.pageID === id)) ||
      snapshot.pageIDs.some((id) => !pages.some((p) => p.pageID === id && p.state === 'captured')))
    throw new IdeaError(422, 'SNAPSHOT_INCOMPLETE');
  return snapshot;
}
export async function readRecord(actor: Actor, id: string, kind: Kind, revisionID?: string) {
  const head = await getHead(actor.projectID, id, kind);
  const revision = await committedRevision(head, revisionID);
  for (const snapshotID of revision.snapshotIDs) await readySnapshot(actor, snapshotID, head.bookID);
  if ('inputs' in revision.data) {
    for (const input of revision.data.inputs) await selectedReview(actor, input.revisionID, head.bookID);
    for (const id of revision.data.includedDraftIDs) await authorizedRun(actor, id);
  }
  return { head, revision, capabilities: recordCapabilities(actor, head) };
}
export async function selectedReview(actor: Actor, revisionID: string, bookID?: string) {
  const candidate = await IdeaRevision.findById(revisionID).lean();
  if (!candidate) throw notFound();
  const head = await getHead(actor.projectID, candidate.headID, 'review');
  if (bookID && head.bookID !== bookID) throw new IdeaError(422, 'BOOK_MISMATCH');
  const revision = await committedRevision(head, revisionID);
  await readySnapshot(actor, revision.snapshotIDs[0], head.bookID);
  return { head, revision };
}
export async function authorizedRun(actor: Actor, id: string) {
  const run = await IdeaRun.findOne({ _id: id, projectID: actor.projectID }).lean();
  if (!run) throw notFound();
  for (const revisionID of run.revisionIDs) {
    const revision = await IdeaRevision.findById(revisionID).lean();
    if (!revision) throw notFound();
    await committedRevision(await getHead(actor.projectID, revision.headID), revisionID);
  }
  if (!run.revisionIDs.length) throw notFound();
  return run;
}
async function verifyDraft(actor: Actor, id: string, allowedRevisionIDs?: string[]) {
  const run = await authorizedRun(actor, id);
  if (run.status !== 'succeeded' || !run.output || (allowedRevisionIDs && (run.mode === 'synthesis' || run.revisionIDs.length !== 1 || run.revisionIDs.some((id) => !allowedRevisionIDs.includes(id)))))
    throw new IdeaError(422, 'DRAFT_INPUT_MISMATCH');
  parseDraft(run.mode as Parameters<typeof parseDraft>[0], run.output);
  return run;
}
export async function createRecord(actor: Actor, kind: Kind, input: {
  acknowledgePartial?: boolean; snapshotID?: string; context: IdeaContext; idempotencyKey: string; reviewRevisionIDs?: string[]; includedDraftIDs?: string[];
}, hook?: FaultHook) {
  requireWrite(actor);
  const payloadHash = hash({ kind, input });
  const existing = await IdeaHead.findOne({ projectID: actor.projectID, kind, ownerUUID: actor.uuid, creationKey: input.idempotencyKey }).lean();
  if (existing) {
    if (existing.creationHash !== payloadHash) throw new IdeaError(409, 'IDEMPOTENCY_CONFLICT');
    const result = await replay(existing, `create:${input.idempotencyKey}`, payloadHash);
    if (result) return result;
  }
  let data: Revision['data']; let snapshotIDs: string[];
  if (kind === 'review') {
    const snapshot = await readySnapshot(actor, input.snapshotID!, actor.bookID);
    if (snapshot.state === 'partial' && !input.acknowledgePartial) throw new IdeaError(422, 'PARTIAL_ACKNOWLEDGEMENT_REQUIRED');
    data = { ...createReview(input.context), partialCaptureAcknowledged: Boolean(input.acknowledgePartial) }; snapshotIDs = [snapshot._id];
  } else {
    const selected = [];
    for (const id of input.reviewRevisionIDs!) selected.push(await selectedReview(actor, id, actor.bookID));
    if (new Set(selected.map((s) => s.head._id)).size !== selected.length) throw new IdeaError(422, 'DUPLICATE_REVIEW');
    for (const id of input.includedDraftIDs!) await verifyDraft(actor, id, input.reviewRevisionIDs);
    data = synthesisSchema.parse({ schemaVersion: 1, context: input.context,
      inputs: selected.map(({ head, revision }) => ({ headID: head._id, revisionID: revision._id, snapshotID: revision.snapshotIDs[0], ownerUUID: head.ownerUUID, version: revision.version, status: revision.data.status })),
      includedDraftIDs: input.includedDraftIDs, draftDisposition: 'not_reviewed', dispositionRunID: null,
      summary: '', suggestions: '', proposals: [], status: 'draft',
    });
    snapshotIDs = [...new Set(selected.flatMap((s) => s.revision.snapshotIDs))];
  }
  const head = await reserveHead({ projectID: actor.projectID, bookID: actor.bookID, ownerUUID: actor.uuid, kind, creationKey: input.idempotencyKey, creationHash: payloadHash });
  return commit(head, { actorUUID: actor.uuid, mutationID: `create:${input.idempotencyKey}`, payloadHash, reason: 'create', data, snapshotIDs, archived: false }, hook);
}
async function validateProvenance(actor: Actor, head: Head, data: Revision['data'], snapshotIDs: string[]) {
  // Check support even for manually entered proposals; clients cannot attach foreign evidence.
  const snapshots: IdeaEvidenceSnapshot[] = [];
  for (const id of snapshotIDs) {
    const snapshot = await readySnapshot(actor, id, head.bookID);
    const pages = await IdeaPage.find({ snapshotID: id, state: 'captured' }).lean();
    snapshots.push({ snapshotID: id, chapterTitle: snapshot.chapterTitle, pageIDs: snapshot.pageIDs, excludedPageIDs: snapshot.excludedPageIDs, blocks: pages.flatMap((p) => p.blocks) as IdeaEvidenceSnapshot['blocks'] });
  }
  // The validator recursively checks every structured support in a draft-shaped container.
  const evidenceErrors = validateDraftEvidence({ mode: '7.8', schemaVersion: 1, summary: '', limitations: [], missingPerspectives: data.proposals, presentStrengths: [] }, snapshots);
  if (evidenceErrors.length) throw new IdeaError(422, 'INVALID_EVIDENCE');
  const runIDs = new Set(data.proposals.flatMap((p) => p.originRunID ? [p.originRunID] : []));
  if ('answers' in data) data.answers.forEach((a) => { if (a.adoptedTextRunID) runIDs.add(a.adoptedTextRunID); });
  if ('dispositionRunID' in data && data.dispositionRunID) runIDs.add(data.dispositionRunID);
  for (const id of runIDs) {
    const run = await verifyDraft(actor, id);
    let bound = false;
    for (const revisionID of run.revisionIDs) {
      try { await committedRevision(head, revisionID); bound = true; }
      catch (e) { if (!(e instanceof IdeaError) || e.status !== 404) throw e; }
    }
    if (!bound || ('dispositionRunID' in data && data.dispositionRunID === id && run.mode !== 'synthesis'))
      throw new IdeaError(422, 'DRAFT_INPUT_MISMATCH');
  }
}
export async function mutateRecord(actor: Actor, kind: Kind, id: string, input: {
  expectedVersion: number; mutationID: string; action?: 'finish' | 'reopen' | 'archive' | 'restore'; [key: string]: unknown;
}, hook?: FaultHook) {
  const head = await getHead(actor.projectID, id, kind);
  const { expectedVersion, mutationID, action, ...changes } = input;
  requireWrite(actor, head, action === 'archive' || action === 'restore');
  const payloadHash = hash({ actorUUID: actor.uuid, kind, id, input });
  const previous = await replay(head, mutationID, payloadHash);
  if (previous) return previous;
  if (head.version !== expectedVersion) throw conflict();
  const current = await committedRevision(head);
  if (head.archived && action !== 'restore') throw new IdeaError(409, 'RECORD_ARCHIVED');
  if (!action && current.data.status === 'finished') throw new IdeaError(409, 'REOPEN_REQUIRED');
  if ((action === 'finish' && current.data.status !== 'draft') || (action === 'reopen' && current.data.status !== 'finished') || (action === 'restore' && !head.archived))
    throw new IdeaError(409, 'INVALID_TRANSITION');
  const changed = { ...current.data, ...changes, ...(action === 'finish' && { status: 'finished' }), ...(action === 'reopen' && { status: 'draft' }) };
  const data = kind === 'review' ? reviewSchema.parse(changed) : synthesisSchema.parse(changed);
  if (action !== 'archive' && action !== 'restore') await validateProvenance(actor, head, data, current.snapshotIDs);
  return commit(head, { actorUUID: actor.uuid, mutationID, payloadHash, reason: action || 'edit', data,
    snapshotIDs: current.snapshotIDs, archived: action === 'archive' ? true : action === 'restore' ? false : head.archived }, hook);
}
export async function listRecords(actor: Actor, kind: Kind, pageSize: number, cursor?: string) {
  let after: { date: string; id: string } | undefined;
  if (cursor) {
    try {
      after = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (!after || typeof after.id !== 'string' || !/^[0-9a-f-]{36}$/.test(after.id) || typeof after.date !== 'string' || !Number.isFinite(Date.parse(after.date))) throw Error();
    } catch { throw new IdeaError(422, 'INVALID_CURSOR'); }
  }
  const heads = await IdeaHead.find({ projectID: actor.projectID, kind, currentRevisionID: { $ne: null },
    ...(after && { $or: [{ updatedAt: { $lt: new Date(after.date) } }, { updatedAt: new Date(after.date), _id: { $lt: after.id } }] }),
  }).sort({ updatedAt: -1, _id: -1 }).limit(pageSize + 1).lean();
  const hasMore = heads.length > pageSize; const page = heads.slice(0, pageSize);
  const data = [];
  for (const head of page) {
    const revision = await committedRevision(head);
    const snapshot = kind === 'review' ? await IdeaSnapshot.findOne({ _id: revision.snapshotIDs[0], projectID: actor.projectID }).select('chapterTitle').lean() : null;
    data.push({ id: head._id, ...(snapshot && { chapterTitle: snapshot.chapterTitle }), ownerUUID: head.ownerUUID, version: head.version, revisionID: revision._id,
      archived: head.archived, updatedAt: head.updatedAt, status: revision.data.status, snapshotIDs: revision.snapshotIDs,
      ...(kind === 'synthesis' && { inputs: (revision.data as Synthesis).inputs }), capabilities: recordCapabilities(actor, head) });
  }
  const last = page.at(-1);
  return { items: data, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ date: last.updatedAt.toISOString(), id: last._id })).toString('base64url') : null };
}
