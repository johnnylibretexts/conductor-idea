import { createHash, randomUUID } from 'node:crypto';
import { IdeaHead, IdeaRevision, type Head, type Revision, type Kind } from '../../../models/idea-models.js';
import { bytesWithin, conflict, IdeaError, notFound } from './errors.js';

/** Canonical object keys make JSON key order irrelevant to mutation identity. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const duplicate = (e: unknown) => (e as { code?: number })?.code === 11000;
export type SaveResult = { head: Head; revision: Revision };
export async function getHead(projectID: string, id: string, kind?: Kind): Promise<Head> {
  const head = await IdeaHead.findOne({ _id: id, projectID, ...(kind && { kind }) }).lean();
  if (!head || !head.currentRevisionID) throw notFound();
  return head;
}
/** The pointer chain is authoritative; existence of a candidate is insufficient. */
export async function committedRevision(head: Head, revisionID = head.currentRevisionID): Promise<Revision> {
  let cursor = head.currentRevisionID;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) throw new IdeaError(500, 'REVISION_CHAIN_CORRUPT');
    seen.add(cursor);
    const revision = await IdeaRevision.findOne({ _id: cursor, headID: head._id }).lean();
    if (!revision) throw new IdeaError(500, 'REVISION_CHAIN_CORRUPT');
    if (revision._id === revisionID) return revision;
    cursor = revision.parentRevisionID;
  }
  throw notFound();
}
export async function replay(head: Head, mutationID: string, payloadHash: string): Promise<SaveResult | null> {
  const candidate = await IdeaRevision.findOne({ headID: head._id, mutationID }).lean();
  if (!candidate) return null;
  if (candidate.discarded) throw conflict();
  if (candidate.payloadHash !== payloadHash) throw new IdeaError(409, 'IDEMPOTENCY_CONFLICT');
  try { return { head, revision: await committedRevision(head, candidate._id) }; }
  catch (e) { if (!(e instanceof IdeaError) || e.status !== 404) throw e; }
  return null;
}
export type FaultHook = (point: 'candidate_inserted' | 'head_committed') => Promise<void>;
export async function commit(head: Head, input: {
  actorUUID: string; mutationID: string; payloadHash: string; reason: string;
  data: Revision['data']; snapshotIDs: string[]; archived: boolean;
}, hook?: FaultHook): Promise<SaveResult> {
  let candidate: Revision = {
    _id: randomUUID(), headID: head._id, parentRevisionID: head.currentRevisionID,
    version: head.version + 1, epoch: head.epoch, ...input, createdAt: new Date(),
  };
  bytesWithin(candidate, 512 * 1024);
  try { await IdeaRevision.create(candidate); }
  catch (e) {
    if (!duplicate(e)) throw e;
    const existing = await IdeaRevision.findOne({ headID: head._id, mutationID: input.mutationID }).lean();
    if (!existing || existing.payloadHash !== input.payloadHash) throw new IdeaError(409, 'IDEMPOTENCY_CONFLICT');
    if (existing.discarded) throw conflict();
    candidate = existing;
  }
  await hook?.('candidate_inserted');
  // A candidate always retains its original parent/version/maintenance fence.
  const saved = await IdeaHead.findOneAndUpdate({
    _id: head._id, projectID: head.projectID, version: candidate.version - 1,
    currentRevisionID: candidate.parentRevisionID, epoch: candidate.epoch,
  }, { $set: { currentRevisionID: candidate._id, version: candidate.version, archived: candidate.archived, updatedAt: new Date() } }, { new: true }).lean();
  if (saved) {
    await hook?.('head_committed');
    return { head: saved, revision: candidate };
  }
  const current = await IdeaHead.findById(head._id).lean();
  if (current) {
    const result = await replay(current, input.mutationID, input.payloadHash);
    if (result) return result;
  }
  throw conflict();
}
export async function reserveHead(input: Pick<Head, 'projectID' | 'bookID' | 'ownerUUID' | 'kind' | 'creationKey' | 'creationHash'>): Promise<Head> {
  try {
    return (await IdeaHead.create({ ...input, _id: randomUUID(), currentRevisionID: null, version: 0, epoch: 0, archived: false, createdAt: new Date(), updatedAt: new Date() })).toObject();
  } catch (e) {
    if (!duplicate(e)) throw e;
    const existing = await IdeaHead.findOne({ projectID: input.projectID, ownerUUID: input.ownerUUID, kind: input.kind, creationKey: input.creationKey }).lean();
    if (!existing || existing.creationHash !== input.creationHash) throw new IdeaError(409, 'IDEMPOTENCY_CONFLICT');
    return existing;
  }
}
