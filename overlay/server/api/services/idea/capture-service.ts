import { randomUUID } from 'node:crypto';
import { IdeaSourceJob, IdeaPage, IdeaSnapshot, IdeaSourceCheck, type SourceJob, type Page, type Snapshot } from '../../../models/idea-models.js';
import { definitions } from './migration-service.js';
import { hash } from './revision-store.js';
import { resolveActor, requireWrite, type Actor } from './permission-service.js';
import { IdeaError, notFound, bytesWithin } from './errors.js';
import { readySnapshot } from './review-service.js';
import { CAPTURE_LIMITS, selectCapture, type ContentSource, type SourcePage } from './content-source.js';
import { normalizePage, NORMALIZATION_VERSION } from './normalizer.js';
import { captureEnabled } from './capture-config.js';
import type { z } from 'zod';
import { captureInput, sourceCheckInput } from '../../validators/idea.js';
const duplicate = (e: unknown) => (e as { code?: number }).code === 11000;
export async function authorizeSourceJob(job: Pick<SourceJob, 'ownerUUID' | 'sessionID' | 'projectID' | 'bookID'>) {
  const actor = await resolveActor({ uuid: job.ownerUUID, sessionId: job.sessionID }, job.projectID);
  requireWrite(actor);
  if (actor.bookID !== job.bookID) throw new IdeaError(422, 'PROJECT_BOOK_CHANGED');
  if (!captureEnabled(actor.projectID)) throw new IdeaError(503, 'CAPTURE_DISABLED');
  return actor;
}
export async function enqueueCapture(actor: Actor, value: z.infer<typeof captureInput>, source: ContentSource) {
  const input = captureInput.parse(value); requireWrite(actor);
  const payloadHash = hash(input);
  const existing = await IdeaSourceJob.findOne({ projectID: actor.projectID, ownerUUID: actor.uuid, kind: 'capture', idempotencyKey: input.idempotencyKey }).lean();
  if (existing) { if (existing.payloadHash !== payloadHash) throw new IdeaError(409, 'IDEMPOTENCY_CONFLICT'); return publicJob(existing); }
  const signal = AbortSignal.timeout(CAPTURE_LIMITS.jobMs);
  const tree = await source.discover(actor, input.chapterRootID, signal);
  const supplements = [];
  for (const id of input.supplementPageIDs) supplements.push(await source.page(actor, id, signal));
  const selection = selectCapture(tree, input.chapterRootID, input.pageIDs, supplements);
  return insertJob(actor, 'capture', input.idempotencyKey, payloadHash, input.chapterRootID, selection);
}
export async function enqueueSourceCheck(actor: Actor, value: z.infer<typeof sourceCheckInput>) {
  const input = sourceCheckInput.parse(value); requireWrite(actor);
  const snapshot = await readySnapshot(actor, input.snapshotID, actor.bookID);
  const selected = snapshot.manifest.selected as SourcePage[] | undefined;
  if (!selected?.length || snapshot.manifest.normalizationVersion !== NORMALIZATION_VERSION) throw new IdeaError(422, 'UNSUPPORTED_SNAPSHOT_VERSION');
  return insertJob(actor, 'check', input.idempotencyKey, hash(input), snapshot.chapterRootID,
    { selected, excluded: (snapshot.manifest.excluded || []) as SourcePage[], unsupportedBranches: Boolean(snapshot.manifest.unsupportedBranches) }, snapshot._id);
}
async function insertJob(actor: Actor, kind: 'capture' | 'check', idempotencyKey: string, payloadHash: string, chapterRootID: string,
  selection: Pick<SourceJob, 'selected' | 'excluded' | 'unsupportedBranches'>, inputSnapshotID?: string) {
  if (!actor.sessionID) throw new IdeaError(401, 'INVALID_SESSION');
  const job: SourceJob = { _id: randomUUID(), kind, projectID: actor.projectID, ownerUUID: actor.uuid, sessionID: actor.sessionID, bookID: actor.bookID,
    idempotencyKey, payloadHash, chapterRootID, ...selection, inputSnapshotID, state: 'queued', results: [],
    leaseToken: null, leaseUntil: new Date(0), createdAt: new Date(), deadline: new Date(Date.now() + CAPTURE_LIMITS.jobMs) };
  await authorizeSourceJob(job); bytesWithin(job, 512 * 1024);
  try { await IdeaSourceJob.create(job); return publicJob(job); }
  catch (e) {
    if (!duplicate(e)) throw e;
    const existing = await IdeaSourceJob.findOne({ projectID: actor.projectID, ownerUUID: actor.uuid, kind, idempotencyKey }).lean();
    if (!existing || existing.payloadHash !== payloadHash) throw new IdeaError(409, 'IDEMPOTENCY_CONFLICT');
    return publicJob(existing);
  }
}
export function publicJob(job: SourceJob) {
  return { jobID: job._id, kind: job.kind, state: job.state, completedPages: job.results.length,
    totalPages: job.selected.length + job.excluded.length, requestedPages: job.selected.length,
    excludedPageIDs: job.excluded.map((p) => p.pageID), unsupportedBranches: job.unsupportedBranches,
    errorCode: job.errorCode || null, snapshotID: job.kind === 'capture' && job.state === 'succeeded' ? job._id : null };
}
export async function getCapture(actor: Actor, id: string) {
  const job = await IdeaSourceJob.findOne({ _id: id, projectID: actor.projectID, kind: 'capture' }).lean();
  if (!job) throw notFound();
  const snapshot = job.state === 'succeeded' ? await IdeaSnapshot.findOne({ _id: id, projectID: actor.projectID }).lean() : null;
  return { ...publicJob(job), manifest: snapshot?.manifest || null, captureState: snapshot?.state || null };
}
const fence = (job: SourceJob) => ({ _id: job._id, leaseToken: job.leaseToken, leaseUntil: { $gt: new Date() } });
export async function claimSourceJob() {
  const lease = { leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000), slot: 1 };
  // The unique partial slot index elects one source worker across processes.
  const expired = await IdeaSourceJob.findOneAndUpdate({ slot: 1, state: { $in: ['queued', 'running', 'finalizing'] }, leaseUntil: { $lte: new Date() } }, { $set: lease }, { new: true }).lean();
  if (expired) return expired;
  try {
    return await IdeaSourceJob.findOneAndUpdate({ state: 'queued', slot: { $exists: false } }, { $set: lease }, { new: true, sort: { createdAt: 1 } }).lean();
  } catch (e) { if (duplicate(e)) return null; throw e; }
}
async function liveJob(job: SourceJob) {
  const current = await IdeaSourceJob.findOne(fence(job)).lean();
  if (!current || ['succeeded','failed'].includes(current.state)) throw new IdeaError(409, 'LEASE_LOST');
  return current;
}
/** Capture operations are idempotent GETs. Only transient reads receive one retry. */
async function capturePage(actor: Actor, page: SourcePage, source: ContentSource, signal: AbortSignal): Promise<Omit<Page, '_id' | 'snapshotID'>> {
  for (let attempt = 0; ; attempt++) {
    try {
      signal.throwIfAborted();
      const current = await source.page(actor, page.pageID, signal);
      if (page.parentID && current.parentID !== page.parentID) throw new IdeaError(422, 'PAGE_MOVED');
      const normalized = normalizePage(await source.html(current, signal), current);
      return { pageID: page.pageID, state: 'captured', blocks: normalized.blocks, preview: normalized.preview,
        source: { ...current, normalizationVersion: NORMALIZATION_VERSION, contentHash: normalized.contentHash, textBytes: normalized.textBytes, limitations: normalized.limitations }, createdAt: new Date() };
    } catch (e) {
      if (!signal.aborted && attempt === 0 && e instanceof IdeaError && e.retryable) continue;
      return { pageID: page.pageID, state: 'failed', blocks: [], preview: '', source: { ...page },
        errorCode: signal.aborted ? 'CAPTURE_DEADLINE' : e instanceof IdeaError ? e.code : 'SOURCE_READ_FAILED', createdAt: new Date() };
    }
  }
}
async function pinPage(job: SourceJob, page: Omit<Page, '_id' | 'snapshotID'>) {
  await liveJob(job);
  const record: Page = { ...page, _id: randomUUID(), snapshotID: job.leaseToken! };
  // Attempt pages are isolated. A stale worker can at most leave an unreferenced candidate.
  await IdeaPage.create(record);
  const saved = await IdeaSourceJob.updateOne({ ...fence(job), state: 'running', 'results.pageID': { $ne: page.pageID } },
    { $push: { results: { pageID: page.pageID, pageRecordID: record._id } } });
  if (!saved.matchedCount) throw new IdeaError(409, 'LEASE_LOST');
}
export type CaptureHook = (point: 'page_pinned' | 'manifest_frozen' | 'snapshot_persisted', job: SourceJob) => Promise<void>;
export async function processSourceJob(job: SourceJob, source: ContentSource, parent?: AbortSignal, hook?: CaptureHook) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(parent ? [parent] : [])]);
  const heartbeat = setInterval(() => { void (async () => {
    try {
      await authorizeSourceJob(job);
      const renewed = await IdeaSourceJob.updateOne(fence(job), { $set: { leaseUntil: new Date(Date.now() + 60_000) } });
      if (!renewed.matchedCount) controller.abort();
    } catch { controller.abort(); }
  })(); }, 10_000);
  heartbeat.unref();
  try {
    const actor = await authorizeSourceJob(job); job = await liveJob(job);
    if (job.state !== 'finalizing') {
      await IdeaSourceJob.updateOne(fence(job), { $set: { state: 'running' } }); job.state = 'running';
      if (job.kind === 'check' && job.comparison === undefined) {
        // Discovery uses the same privacy filter, never privileged names of new private pages.
        let comparison: unknown;
        try {
          if (Date.now() >= job.deadline.getTime()) throw new IdeaError(503, 'CAPTURE_DEADLINE');
          const tree = await source.discover(actor, job.chapterRootID, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, job.deadline.getTime() - Date.now()))]));
          const before = [...job.selected, ...job.excluded]; const ids = new Set(before.map((p) => p.pageID));
          comparison = { added: tree.nodes.filter((p) => !ids.has(p.pageID)).map((p) => p.pageID),
            removed: before.filter((p) => !tree.nodes.some((n) => n.pageID === p.pageID) && (p.pageID === job.chapterRootID || before.some((b) => b.pageID === p.parentID))).map((p) => p.pageID),
            renamed: tree.nodes.filter((p) => before.some((b) => b.pageID === p.pageID && (b.title !== p.title || b.url !== p.url))).map((p) => p.pageID),
            unsupportedBranches: tree.unsupportedBranches };
        } catch { comparison = { errorCode: 'SOURCE_TREE_UNKNOWN' }; }
        await IdeaSourceJob.updateOne(fence(job), { $set: { comparison } });
      }
      const done = new Set(job.results.map((r) => r.pageID));
      for (const excluded of job.excluded) if (!done.has(excluded.pageID)) {
        await pinPage(job, { pageID: excluded.pageID, state: 'excluded', blocks: [], preview: '', source: { ...excluded }, errorCode: 'NOT_SELECTED', createdAt: new Date() });
      }
      const pending = job.selected.filter((p) => !done.has(p.pageID)); let next = 0;
      const outcomes = await Promise.allSettled(Array.from({ length: CAPTURE_LIMITS.concurrency }, async () => {
        while (next < pending.length) {
          const page = pending[next++]; signal.throwIfAborted(); await authorizeSourceJob(job); await liveJob(job);
          const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, job.deadline.getTime() - Date.now()))]);
          const captured = Date.now() >= job.deadline.getTime()
            ? { pageID: page.pageID, state: 'failed' as const, blocks: [], preview: '', source: { ...page }, errorCode: 'CAPTURE_DEADLINE', createdAt: new Date() }
            : await capturePage(actor, page, source, deadline);
          signal.throwIfAborted(); await pinPage(job, captured); await hook?.('page_pinned', job);
        }
      }));
      const rejected = outcomes.find((r) => r.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      await authorizeSourceJob(job);
      const frozen = await IdeaSourceJob.findOneAndUpdate({ ...fence(job), state: 'running', results: { $size: job.selected.length + job.excluded.length } }, { $set: { state: 'finalizing', frozenAt: new Date() } }, { new: true }).lean();
      if (!frozen) throw new IdeaError(409, 'LEASE_LOST'); job = frozen;
      await hook?.('manifest_frozen', job);
    }
    await authorizeSourceJob(job); await materialize(job); await hook?.('snapshot_persisted', job);
    await IdeaSourceJob.updateOne(fence(job), { $set: { state: 'succeeded', leaseUntil: new Date(0), leaseToken: null }, $unset: { slot: '' } });
  } catch (e) {
    if (hook) throw e; // Fault injection leaves exactly the crash state for recovery tests.
    if (!signal.aborted && !(e instanceof IdeaError && e.code === 'LEASE_LOST')) {
      await IdeaSourceJob.updateOne(fence(job), { $set: { state: 'failed', errorCode: e instanceof IdeaError ? e.code : 'CAPTURE_FAILED', leaseUntil: new Date(0), leaseToken: null }, $unset: { slot: '' } });
    }
  } finally {
    clearInterval(heartbeat);
    if (signal.aborted) await IdeaSourceJob.updateOne(fence(job), { $set: { leaseUntil: new Date(0), leaseToken: null } });
  }
}
async function materialize(job: SourceJob) {
  const records = await IdeaPage.find({ _id: { $in: job.results.map((r) => r.pageRecordID) } }).lean();
  if (records.length !== job.results.length) throw new IdeaError(500, 'CAPTURE_PAGE_MISSING');
  const ordered = [...job.selected, ...job.excluded].map((p) => records.find((r) => r.pageID === p.pageID)!);
  if (ordered.some((p) => !p)) throw new IdeaError(500, 'CAPTURE_PAGE_MISSING');
  const totalBytes = ordered.reduce((n, p) => n + (p.state === 'captured' ? Number(p.source.textBytes || 0) : 0), 0);
  if (totalBytes > CAPTURE_LIMITS.snapshotTextBytes) throw new IdeaError(413, 'SNAPSHOT_TEXT_TOO_LARGE');
  if (job.kind === 'check') {
    const old = await IdeaPage.find({ snapshotID: job.inputSnapshotID }).lean();
    const comparison = job.comparison as { added?: string[]; removed?: string[]; renamed?: string[]; errorCode?: string; unsupportedBranches?: boolean };
    const deltas = ordered.filter((p) => p.state !== 'excluded').map((p) => ({ pageID: p.pageID,
      state: p.state !== 'captured' ? 'unknown' : old.find((o) => o.pageID === p.pageID)?.source.contentHash === p.source.contentHash ? 'unchanged' : 'changed', errorCode: p.errorCode || null }));
    const unknown = comparison?.errorCode || comparison?.unsupportedBranches || deltas.some((d) => d.state === 'unknown');
    const changed = deltas.some((d) => d.state === 'changed') || comparison?.added?.length || comparison?.removed?.length || comparison?.renamed?.length;
    const result = { status: unknown ? 'unknown' : changed ? 'changed' : 'unchanged', deltas, coverage: comparison, normalizationVersion: NORMALIZATION_VERSION };
    try { await IdeaSourceCheck.create({ _id: job._id, projectID: job.projectID, snapshotID: job.inputSnapshotID, requestedBy: job.ownerUUID, idempotencyKey: job.idempotencyKey, state: 'succeeded', checkedAt: job.frozenAt || job.createdAt, result }); }
    catch (e) { if (!duplicate(e)) throw e; }
    return;
  }
  // Freeze precedes copying. Concurrent/restarted materializers copy identical pinned pages.
  for (const page of ordered) {
    const { _id: _candidateID, snapshotID: _attemptID, ...data } = page;
    try { await IdeaPage.create({ ...data, _id: randomUUID(), snapshotID: job._id }); }
    catch (e) {
      if (!duplicate(e)) throw e;
      const existing = await IdeaPage.findOne({ snapshotID: job._id, pageID: page.pageID }).lean();
      if (!existing || hash(existing.blocks) !== hash(page.blocks) || existing.state !== page.state) throw new IdeaError(500, 'PAGE_COMMIT_CONFLICT');
    }
  }
  const captured = ordered.filter((p) => p.state === 'captured');
  const excluded = ordered.filter((p) => p.state !== 'captured');
  const capturedSelection = job.selected.map((selected) => {
    const page = ordered.find((p) => p.pageID === selected.pageID)!;
    return page.state === 'captured' ? { pageID: selected.pageID, parentID: page.source.parentID as string | null,
      title: String(page.source.title), url: String(page.source.url), modified: page.source.modified as string | null } : selected;
  });
  const manifest = { completedAt: (job.frozenAt || job.createdAt).toISOString(), normalizationVersion: NORMALIZATION_VERSION, selected: capturedSelection, excluded: job.excluded,
    unsupportedBranches: job.unsupportedBranches, textBytes: totalBytes, partial: excluded.length > 0 || job.unsupportedBranches,
    pages: ordered.map((p) => ({ pageID: p.pageID, state: p.state, contentHash: p.source.contentHash || null, capturedAt: p.createdAt.toISOString(), errorCode: p.errorCode || null })),
    limits: CAPTURE_LIMITS, limitations: ['Anonymous rendered text only; embedded media were not fetched.', 'Public visibility was checked at capture time; later changes require a source check.'] };
  const snapshot: Snapshot = { _id: job._id, projectID: job.projectID, bookID: job.bookID, chapterRootID: job.chapterRootID,
    chapterTitle: capturedSelection.find((p) => p.pageID === job.chapterRootID)!.title,
    state: !captured.length ? 'failed' : manifest.partial ? 'partial' : 'ready', pageIDs: captured.map((p) => p.pageID), excludedPageIDs: excluded.map((p) => p.pageID),
    definitionIDs: definitions.map((d) => d._id), hash: hash(manifest), manifest, createdAt: job.createdAt };
  bytesWithin(snapshot, 512 * 1024);
  try { await IdeaSnapshot.create(snapshot); }
  catch (e) { if (!duplicate(e)) throw e; const existing = await IdeaSnapshot.findById(job._id).lean(); if (existing?.hash !== snapshot.hash) throw new IdeaError(500, 'SNAPSHOT_COMMIT_CONFLICT'); }
}
