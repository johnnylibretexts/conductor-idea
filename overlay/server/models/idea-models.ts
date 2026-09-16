/** Private IDEA collections. No fields are added to public Project/Book models. */
import mongoose, { Schema } from 'mongoose';
import type { IdeaReview } from '../../shared/idea.js';
import type { Synthesis } from '../api/validators/idea.js';
export type Kind = 'review' | 'synthesis';
export interface Head {
  _id: string; kind: Kind; projectID: string; bookID: string; ownerUUID: string;
  currentRevisionID: string | null; version: number; epoch: number; archived: boolean;
  creationKey: string; creationHash: string; createdAt: Date; updatedAt: Date;
}
export interface Revision {
  _id: string; headID: string; parentRevisionID: string | null; version: number;
  actorUUID: string; reason: string; mutationID: string; payloadHash: string; epoch: number;
  discarded?: boolean; snapshotIDs: string[]; data: IdeaReview | Synthesis; archived: boolean; createdAt: Date;
}
const str = { type: String, required: true };
const mixed = Schema.Types.Mixed;
function define<T>(name: string, fields: Record<string, unknown>, indexes: [Record<string, 1 | -1>, Record<string, unknown>?][] = [], maxBytes = 512 * 1024) {
  const schema = new Schema<T>({ _id: str, ...fields } as never, {
    collection: name, strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false,
  });
  for (const [keys, options] of indexes) schema.index(keys, options);
  schema.pre('validate', function () {
    if (Buffer.byteLength(JSON.stringify(this.toObject())) > maxBytes) throw new Error('IDEA_DOCUMENT_TOO_LARGE');
  });
  if (name === 'ideaSnapshots') {
    schema.pre('save', function () { if (!this.isNew) throw new Error('IMMUTABLE_IDEA_SNAPSHOT'); });
    for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'] as const) {
      schema.pre(operation, function () {
        if (this.getFilter().state !== 'capturing') throw new Error('FINALIZED_SNAPSHOT_IMMUTABLE');
      });
    }
  }
  if (['ideaDefinitions', 'ideaPages', 'ideaRevisions'].includes(name)) {
    schema.pre('save', function () { if (!this.isNew) throw new Error('IMMUTABLE_IDEA_RECORD'); });
    for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'] as const) {
      schema.pre(operation, function () { throw new Error('IMMUTABLE_IDEA_RECORD'); });
    }
  }
  return mongoose.model<T>(name, schema);
}
export const IdeaHead = define<Head>('ideaHeads', {
  kind: { type: String, enum: ['review', 'synthesis'], required: true }, projectID: str, bookID: str, ownerUUID: str,
  currentRevisionID: { type: String, default: null }, version: { type: Number, required: true }, epoch: { type: Number, default: 0 },
  archived: { type: Boolean, default: false }, creationKey: str, creationHash: str, createdAt: Date, updatedAt: Date,
}, [[{ projectID: 1, kind: 1, updatedAt: -1, _id: -1 }], [{ projectID: 1, ownerUUID: 1, kind: 1, creationKey: 1 }, { unique: true }]]);
export const IdeaRevision = define<Revision>('ideaRevisions', {
  headID: str, parentRevisionID: { type: String, default: null }, version: Number, actorUUID: str,
  reason: str, mutationID: str, payloadHash: str, epoch: Number, discarded: Boolean, snapshotIDs: [String], data: { type: mixed, required: true },
  archived: Boolean, createdAt: Date,
}, [[{ headID: 1, mutationID: 1 }, { unique: true }], [{ headID: 1, createdAt: 1 }]]);
export interface Snapshot {
  _id: string; projectID: string; bookID: string; chapterRootID: string; chapterTitle: string;
  state: 'capturing' | 'ready' | 'partial' | 'failed'; pageIDs: string[]; excludedPageIDs: string[];
  definitionIDs: string[]; hash: string; manifest: Record<string, unknown>; createdAt: Date;
}
export const IdeaSnapshot = define<Snapshot>('ideaSnapshots', {
  projectID: str, bookID: str, chapterRootID: str, chapterTitle: str,
  state: { type: String, enum: ['capturing', 'ready', 'partial', 'failed'], required: true },
  pageIDs: [String], excludedPageIDs: [String], definitionIDs: [String], hash: String, manifest: mixed, createdAt: Date,
}, [[{ projectID: 1, bookID: 1, chapterRootID: 1 }]]);
export interface Page {
  _id: string; snapshotID: string; pageID: string; state: 'captured' | 'failed' | 'excluded';
  blocks: { blockID: string; pageID: string; kind: string; text: string }[];
  preview: string; source: Record<string, unknown>; errorCode?: string; createdAt: Date;
}
export const IdeaPage = define<Page>('ideaPages', {
  snapshotID: str, pageID: str, state: { type: String, enum: ['captured', 'failed', 'excluded'], required: true },
  blocks: [mixed], preview: String, source: mixed, errorCode: String, createdAt: Date,
}, [[{ snapshotID: 1, pageID: 1 }, { unique: true }], [{ createdAt: 1 }]], 4 * 1024 * 1024);
export interface Definition { _id: string; kind: string; id: string; hash: string; content: unknown; attribution: unknown; sourceVersion: string; modifications: string }
export const IdeaDefinition = define<Definition>('ideaDefinitions', {
  kind: str, id: str, hash: str, content: { type: mixed, required: true }, attribution: mixed, sourceVersion: str, modifications: String,
}, [[{ kind: 1, id: 1, hash: 1 }, { unique: true }]]);
export interface Run {
  sessionID?: string; estimateID?: string; day?: string; slot?: number; leaseToken?: string; leaseUntil?: Date; deadline?: Date; settled?: boolean; payloadHash?: string;
  _id: string; projectID: string; ownerUUID: string; revisionIDs: string[]; mode: string; parentRunID?: string;
  input: unknown; inputHash: string; profile: unknown; status: string; phase: string; lease: unknown;
  attempts: unknown[]; validation: unknown; output: unknown; error: unknown; idempotencyKey: string;
  feedback: { version: number; disposition: 'useful' | 'needs_correction' | 'rejected'; note: string } | null;
  cancelRequested: boolean; createdAt: Date; updatedAt: Date;
}
export const IdeaRun = define<Run>('ideaRuns', {
  sessionID: String, estimateID: String, day: String, slot: Number, leaseToken: String, leaseUntil: Date, deadline: Date, settled: Boolean, payloadHash: String,
  projectID: str, ownerUUID: str, revisionIDs: [String], mode: str, parentRunID: String,
  input: mixed, inputHash: String, profile: mixed, status: str, phase: String, lease: mixed,
  attempts: { type: [mixed], validate: (a: unknown[]) => a.length <= 2 }, validation: mixed, output: mixed,
  error: mixed, idempotencyKey: str, feedback: { type: mixed, default: null }, cancelRequested: Boolean, createdAt: Date, updatedAt: Date,
}, [[{ ownerUUID: 1, projectID: 1, idempotencyKey: 1 }, { unique: true }], [{ status: 1, updatedAt: 1 }], [{ slot: 1 }, { unique: true, partialFilterExpression: { slot: 1 } }]], 4 * 1024 * 1024);
export interface SourceCheck { _id: string; projectID: string; snapshotID: string; requestedBy: string; idempotencyKey: string; state: string; checkedAt: Date; result: unknown }
export const IdeaSourceCheck = define<SourceCheck>('ideaSourceChecks', {
  projectID: str, snapshotID: str, requestedBy: str, idempotencyKey: str,
  state: str, checkedAt: Date, result: mixed,
}, [[{ projectID: 1, requestedBy: 1, idempotencyKey: 1 }, { unique: true }], [{ snapshotID: 1, checkedAt: -1 }]]);
export interface DailyLimit { _id: string; scope: string; day: string; reservations: any[]; consumedCount: number; spentMicroUSD: number; version: number; paused: boolean }
export const IdeaDailyLimit = define<DailyLimit>('ideaDailyLimits', {
  scope: str, day: str, reservations: [mixed], consumedCount: Number, spentMicroUSD: Number, version: { type: Number, default: 0 }, paused: { type: Boolean, default: false },
}, [[{ scope: 1, day: 1 }, { unique: true }]], 4 * 1024 * 1024);
export interface SourceJob {
  _id: string; slot?: number; kind: 'capture' | 'check'; projectID: string; ownerUUID: string; sessionID: string; bookID: string;
  idempotencyKey: string; payloadHash: string; state: 'queued' | 'running' | 'finalizing' | 'succeeded' | 'failed';
  chapterRootID: string; selected: import('../api/services/idea/content-source.js').SourcePage[];
  excluded: import('../api/services/idea/content-source.js').SourcePage[]; unsupportedBranches: boolean;
  inputSnapshotID?: string; results: { pageID: string; pageRecordID: string }[];
  leaseToken: string | null; leaseUntil: Date; createdAt: Date; deadline: Date; errorCode?: string;
  comparison?: unknown; frozenAt?: Date;
}
export const IdeaSourceJob = define<SourceJob>('ideaSourceJobs', {
  slot: Number, kind: { type: String, enum: ['capture', 'check'], required: true }, projectID: str, ownerUUID: str, sessionID: str, bookID: str,
  idempotencyKey: str, payloadHash: str, state: { type: String, enum: ['queued', 'running', 'finalizing', 'succeeded', 'failed'], required: true },
  chapterRootID: str, selected: [mixed], excluded: [mixed], unsupportedBranches: Boolean, inputSnapshotID: String,
  results: [mixed], leaseToken: { type: String, default: null }, leaseUntil: Date, createdAt: Date, deadline: Date, errorCode: String, comparison: mixed, frozenAt: Date,
}, [[{ projectID: 1, ownerUUID: 1, kind: 1, idempotencyKey: 1 }, { unique: true }], [{ state: 1, leaseUntil: 1, createdAt: 1 }], [{ slot: 1 }, { unique: true, partialFilterExpression: { slot: 1 } }], [{ 'results.pageRecordID': 1 }]]);
export interface Estimate { _id: string; projectID: string; ownerUUID: string; input: unknown; inputHash: string; createdAt: Date; expiresAt: Date }
export const IdeaEstimate = define<Estimate>('ideaEstimates', { projectID: str, ownerUUID: str, input: mixed, inputHash: str, createdAt: Date, expiresAt: Date }, [[{ expiresAt: 1 }, { expireAfterSeconds: 86400 }]], 4 * 1024 * 1024);
export const ideaModels = [IdeaDefinition, IdeaSnapshot, IdeaPage, IdeaHead, IdeaRevision, IdeaRun, IdeaSourceCheck, IdeaDailyLimit, IdeaSourceJob, IdeaEstimate];
