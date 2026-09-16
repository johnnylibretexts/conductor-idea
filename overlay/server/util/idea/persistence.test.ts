import './fixtures/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import express from 'express';
import type { Server } from 'node:http';
import { SignJWT } from 'jose';
import { IdeaHead, IdeaRevision, IdeaSnapshot, IdeaPage, IdeaDefinition, IdeaRun, IdeaSourceJob, IdeaSourceCheck, type Revision, type Definition } from '../../models/idea-models.js';
import Project from '../../models/project.js';
import User from '../../models/user.js';
import Session from '../../models/session.js';
import { migrateIdea, definitions } from '../../api/services/idea/migration-service.js';
import { maintainIdea } from '../../api/services/idea/maintenance-service.js';
import { createRecord, mutateRecord, readRecord, listRecords } from '../../api/services/idea/review-service.js';
import { committedRevision, hash } from '../../api/services/idea/revision-store.js';
import { membershipRole, resolveActor, requireWrite, type Actor } from '../../api/services/idea/permission-service.js';
import { exportRecord, markdownExport } from '../../api/services/idea/export-service.js';
import { context, chapters, draftFor } from './fixtures/chapters.js';
import { buildPrompt } from './prompts.js';
import { captureFixture, captureHTML } from './fixtures/capture.js';
import { enqueueCapture, enqueueSourceCheck, claimSourceJob, processSourceJob, getCapture } from '../../api/services/idea/capture-service.js';
import { startCaptureWorker } from '../../api/services/idea/capture-worker.js';
import { getSourceCheck } from '../../api/services/idea/source-check-service.js';
import { assertTestDatabase } from './test-database.js';

test('test database guard rejects production, remote hosts, options and credentials', () => {
  for (const uri of ['mongodb://127.0.0.1/conductor', 'mongodb://example.com/idea_test_a', 'mongodb://u:p@localhost/idea_test_a', 'mongodb://localhost/idea_test_a?replicaSet=x']) assert.throws(() => assertTestDatabase(uri));
  assertTestDatabase('mongodb://127.0.0.1:27028/idea_test_storage');
});
test('membership uses strongest explicit role; unrelated global roles grant nothing', () => {
  assert.equal(membershipRole({ leads: ['a'], auditors: ['a'] }, 'a'), 'lead');
  assert.equal(membershipRole({ liaisons: ['a'], auditors: ['a'] }, 'a'), 'author');
  assert.equal(membershipRole({}, 'superadmin'), null);
});

const uri = process.env.IDEA_TEST_MONGO_URI;
test('standalone MongoDB persistence and private HTTP API', { skip: !uri }, async (t) => {
  assertTestDatabase(uri!);
  process.env.SECRETKEY = 'idea-tests-only-not-a-deployment-secret';
  process.env.PRODUCTIONURLS = 'https://idea.example.test';
  process.env.IDEA_ALLOWED_ORIGINS = 'https://idea.example.test';
  process.env.IDEA_REVIEW_ENABLED = 'true';
  process.env.IDEA_PILOT_PROJECT_IDS = '["idea-project"]';
  await mongoose.connect(uri!, { autoIndex: false, autoCreate: false });
  let server: Server | undefined;
  try {
    const info = await mongoose.connection.db!.admin().serverInfo();
    assert.match(info.version, /^7\./);
    assert.equal((await mongoose.connection.db!.admin().command({ hello: 1 })).setName, undefined);
    // Test URI guard has run before the first connection or destructive operation.
    await mongoose.connection.dropDatabase();
    await assert.rejects(migrateIdea(true), /MIGRATION_INCOMPLETE/);
    await migrateIdea(); await migrateIdea(); await migrateIdea(true);
    const owner = randomUUID(), teammate = randomUUID(), lead = randomUUID(), auditor = randomUUID(), outsider = randomUUID();
    const sessionIDs = new Map<string, string>();
    for (const uuid of [owner, teammate, lead, auditor, outsider]) {
      await User.collection.insertOne({ uuid, roles: uuid === outsider ? [{ org: 'libretexts', role: 'superadmin' }] : [] } as never);
      const sessionId = randomUUID(); sessionIDs.set(uuid, sessionId);
      await Session.create({ sessionId, userId: uuid, valid: true, createdAt: new Date(), expiresAt: new Date(Date.now() + 3600000) });
    }
    await Project.collection.insertOne({ projectID: 'idea-project', visibility: 'public', libreLibrary: 'bio', libreCoverID: '1', leads: [lead], members: [owner, teammate], auditors: [auditor] } as never);
    await Project.collection.insertOne({ projectID: 'other-project', visibility: 'public', libreLibrary: 'bio', libreCoverID: '1', members: [owner] } as never);
    const actor: Actor = { uuid: owner, sessionID: sessionIDs.get(owner), projectID: 'idea-project', role: 'author', bookID: 'bio:1' };
    const otherActor: Actor = { ...actor, projectID: 'other-project' };
    const as = (uuid: string, role: Actor['role']): Actor => ({ ...actor, uuid, role });
    async function snapshot(projectID = actor.projectID, state: 'ready' | 'capturing' | 'partial' = 'ready') {
      const id = randomUUID(); const chapter = chapters[0];
      await IdeaPage.create([...chapter.pageIDs, ...chapter.excludedPageIDs].map((pageID) => ({ _id: randomUUID(), snapshotID: id, pageID,
        state: chapter.pageIDs.includes(pageID) ? 'captured' : 'excluded', blocks: chapter.blocks.filter((b) => b.pageID === pageID), preview: '<p>Fictional evidence</p>', source: { url: 'https://bio.libretexts.org/test' }, createdAt: new Date() })));
      await IdeaSnapshot.create({ _id: id, projectID, bookID: 'bio:1', chapterRootID: '1', chapterTitle: chapter.chapterTitle, state,
        pageIDs: chapter.pageIDs, excludedPageIDs: chapter.excludedPageIDs, definitionIDs: definitions.map((d) => d._id), hash: hash(chapter), manifest: { partial: true }, createdAt: new Date() });
      return id;
    }
    const snapshotID = await snapshot();
    const create = (a = actor, id: string = snapshotID, key: string = randomUUID()) => createRecord(a, 'review', { snapshotID: id, context, idempotencyKey: key });
    const first = await create();
    await t.test('readers, authors, leads and outsiders follow the exact policy', async () => {
      assert.equal((await resolveActor({ uuid: owner, sessionId: sessionIDs.get(owner) }, actor.projectID)).role, 'author');
      await assert.rejects(resolveActor({ uuid: outsider, sessionId: sessionIDs.get(outsider) }, actor.projectID), { status: 404 });
      await assert.rejects(resolveActor({ uuid: owner, sessionId: sessionIDs.get(lead) }, actor.projectID), { status: 401 });
      assert.equal((await readRecord(as(auditor, 'auditor'), first.head._id, 'review')).revision._id, first.revision._id);
      await assert.rejects(create(as(auditor, 'auditor')), { status: 403 });
      for (const a of [as(lead, 'lead'), as(teammate, 'author')]) await assert.rejects(mutateRecord(a, 'review', first.head._id, { expectedVersion: 1, mutationID: randomUUID(), summary: 'not mine' }), { status: 403 });
      await assert.rejects(readRecord(otherActor, first.head._id, 'review'), { status: 404 });
    });
    await t.test('capturing and foreign snapshots cannot create reviews', async () => {
      await assert.rejects(create(actor, await snapshot(actor.projectID, 'capturing')), { status: 422 });
      await assert.rejects(create(actor, await snapshot('other-project')), { status: 404 });
    });
    await t.test('create retry is stable and changed payload conflicts', async () => {
      const key = randomUUID(); const a = await create(actor, snapshotID, key); const b = await create(actor, snapshotID, key);
      assert.equal(a.revision._id, b.revision._id);
      await assert.rejects(createRecord(actor, 'review', { snapshotID, context: { ...context, discipline: 'Changed' }, idempotencyKey: key }), { code: 'IDEMPOTENCY_CONFLICT' });
    });
    await t.test('two expected-version saves yield one authoritative winner', async () => {
      const base = await create();
      const outcomes = await Promise.allSettled(['A', 'B'].map((summary) => mutateRecord(actor, 'review', base.head._id, { expectedVersion: 1, mutationID: randomUUID(), summary })));
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 1);
      const current = await readRecord(actor, base.head._id, 'review'); assert.equal(current.head.version, 2);
      const candidates = await IdeaRevision.find({ headID: base.head._id, version: 2 }).lean(); assert.equal(candidates.length, 2);
      const loser = candidates.find((c) => c._id !== current.revision._id)!;
      await assert.rejects(readRecord(actor, base.head._id, 'review', loser._id), { status: 404 });
    });
    await t.test('crash before/after head commit recovers one mutation without duplicate revisions', async () => {
      for (const point of ['candidate_inserted', 'head_committed'] as const) {
        const base = await create(); const body = { expectedVersion: 1, mutationID: randomUUID(), summary: point };
        await assert.rejects(mutateRecord(actor, 'review', base.head._id, body, async (p) => { if (p === point) throw Error('simulated crash'); }), /simulated crash/);
        const recovered = await mutateRecord(actor, 'review', base.head._id, body);
        assert.equal(recovered.revision.version, 2);
        assert.equal(await IdeaRevision.countDocuments({ headID: base.head._id, mutationID: body.mutationID }), 1);
        await assert.rejects(mutateRecord(actor, 'review', base.head._id, { ...body, summary: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
      }
    });
    await t.test('finish requires judgments; edits require reopen; lead can archive but cannot edit', async () => {
      const base = await create(); const id = base.head._id;
      await assert.rejects(mutateRecord(actor, 'review', id, { expectedVersion: 1, mutationID: randomUUID(), action: 'finish' }));
      const data = base.revision.data; assert.ok('answers' in data);
      await mutateRecord(actor, 'review', id, { expectedVersion: 1, mutationID: randomUUID(), answers: data.answers.map((a) => ({ ...a, rating: 'inclusive' })) });
      await mutateRecord(actor, 'review', id, { expectedVersion: 2, mutationID: randomUUID(), action: 'finish' });
      await assert.rejects(mutateRecord(actor, 'review', id, { expectedVersion: 3, mutationID: randomUUID(), summary: 'bad' }), { code: 'REOPEN_REQUIRED' });
      await mutateRecord(as(lead, 'lead'), 'review', id, { expectedVersion: 3, mutationID: randomUUID(), action: 'archive' });
      await assert.rejects(mutateRecord(actor, 'review', id, { expectedVersion: 4, mutationID: randomUUID(), action: 'reopen' }), { code: 'RECORD_ARCHIVED' });
      await mutateRecord(as(lead, 'lead'), 'review', id, { expectedVersion: 4, mutationID: randomUUID(), action: 'restore' });
      await mutateRecord(actor, 'review', id, { expectedVersion: 5, mutationID: randomUUID(), action: 'reopen' });
    });
    await t.test('manual proposal evidence cannot reference another snapshot or fabricate a quote', async () => {
      const base = await create();
      const proposal = { id: randomUUID(), originRunID: null, disposition: 'proposed', chapter: 'water', change: 'Example', rationale: 'Example', destination: 'instructor_supplement', priority: 'high', support: { kind: 'scope', snapshotID: randomUUID(), pageIDs: ['water'], limitation: 'Only selected evidence' } };
      await assert.rejects(mutateRecord(actor, 'review', base.head._id, { expectedVersion: 1, mutationID: randomUUID(), proposals: [proposal] }), { code: 'INVALID_EVIDENCE' });
    });
    await t.test('synthesis freezes committed same-project versions and refuses foreign/duplicate inputs', async () => {
      const second = await create(actor, await snapshot()); const foreign = await create(otherActor, await snapshot('other-project'));
      const input = { context, reviewRevisionIDs: [first.revision._id, second.revision._id], includedDraftIDs: [], idempotencyKey: randomUUID() };
      const synthesis = await createRecord(actor, 'synthesis', input); assert.ok('inputs' in synthesis.revision.data);
      await mutateRecord(actor, 'review', second.head._id, { expectedVersion: 1, mutationID: randomUUID(), summary: 'later' });
      assert.equal(synthesis.revision.data.inputs[1].version, 1);
      await assert.rejects(createRecord(actor, 'synthesis', { ...input, idempotencyKey: randomUUID(), reviewRevisionIDs: [first.revision._id, foreign.revision._id] }), { status: 404 });
      await assert.rejects(createRecord(actor, 'synthesis', { ...input, idempotencyKey: randomUUID(), reviewRevisionIDs: [first.revision._id, first.revision._id] }), { code: 'DUPLICATE_REVIEW' });
      await assert.rejects(mutateRecord(actor, 'synthesis', synthesis.head._id, { expectedVersion: 1, mutationID: randomUUID(), action: 'finish' }));
      const exported = await exportRecord(actor, 'synthesis', synthesis.head._id, synthesis.revision._id);
      assert.ok('inputs' in exported.humanReview); assert.equal(exported.humanReview.inputs[1].revisionID, second.revision._id);
    });
    await t.test('list summaries omit answer/page/draft bodies; pagination and exports bind versions', async () => {
      const page = await listRecords(actor, 'review', 2); assert.equal(page.items.length, 2); assert.ok(page.nextCursor);
      const next = await listRecords(actor, 'review', 2, page.nextCursor!); assert.ok(next.items.every((i) => !page.items.some((p) => p.id === i.id)));
      assert.equal('data' in page.items[0], false);
      const data = await exportRecord(as(auditor, 'auditor'), 'review', first.head._id, first.revision._id);
      assert.ok('answers' in data.humanReview); assert.equal(data.humanReview.answers.length, 10);
      assert.equal(data.definitions.length, 3); assert.ok(markdownExport(data).includes(first.revision._id));
    });
    await t.test('maintenance preserves committed chain, fences crashed candidates, and retains job references', async () => {
      const base = await create(); const body = { expectedVersion: 1, mutationID: randomUUID(), summary: 'orphan' };
      await assert.rejects(mutateRecord(actor, 'review', base.head._id, body, async () => { throw Error('crash'); }));
      const candidate = (await IdeaRevision.findOne({ headID: base.head._id, mutationID: body.mutationID }).lean())!;
      await IdeaRevision.db.collection<Revision>(IdeaRevision.collection.name).updateOne({ _id: candidate._id }, { $set: { createdAt: new Date(Date.now() - 8 * 86400000) } });
      const dry = await maintainIdea(); assert.ok(dry.unreachableCandidates.includes(candidate._id)); assert.ok(await IdeaRevision.exists({ _id: candidate._id }));
      const applied = await maintainIdea(true); assert.ok(applied.removed.includes(candidate._id));
      await assert.rejects(mutateRecord(actor, 'review', base.head._id, body), { status: 409 });
      assert.equal((await IdeaRevision.findById(candidate._id).lean())?.discarded, true);
      const current = await readRecord(actor, base.head._id, 'review'); assert.equal(current.revision._id, base.revision._id);
      assert.ok(await IdeaRevision.exists({ _id: base.revision._id }));
    });
    await t.test('maintenance fences an in-flight save and preserves candidates referenced by jobs', async () => {
      const base = await create(); const body = { expectedVersion: 1, mutationID: randomUUID(), summary: 'paused save' };
      await assert.rejects(mutateRecord(actor, 'review', base.head._id, body, async (point) => {
        if (point === 'candidate_inserted') await maintainIdea(true);
      }), { status: 409 });
      const candidate = (await IdeaRevision.findOne({ headID: base.head._id, mutationID: body.mutationID }).lean())!;
      await IdeaRevision.db.collection<Revision>(IdeaRevision.collection.name).updateOne({ _id: candidate._id }, { $set: { createdAt: new Date(Date.now() - 8 * 86400000) } });
      await IdeaRun.create({ _id: randomUUID(), projectID: actor.projectID, ownerUUID: actor.uuid, revisionIDs: [candidate._id], mode: 'rubric', status: 'queued', idempotencyKey: randomUUID(), attempts: [] });
      assert.ok(!(await maintainIdea(true)).removed.includes(candidate._id));
      assert.equal((await readRecord(actor, base.head._id, 'review')).revision._id, base.revision._id);
    });
    await t.test('corrupt chains are reported and preserved by maintenance', async () => {
      const base = await create();
      await IdeaRevision.db.collection<Revision>(IdeaRevision.collection.name).updateOne({ _id: base.revision._id }, { $set: { parentRevisionID: randomUUID() } });
      assert.ok((await maintainIdea()).corruptHeads.includes(base.head._id));
      await assert.rejects(maintainIdea(true), { code: 'REVISION_CHAIN_CORRUPT' });
      assert.ok(await IdeaRevision.exists({ _id: base.revision._id }));
      await IdeaRevision.db.collection<Revision>(IdeaRevision.collection.name).updateOne({ _id: base.revision._id }, { $set: { parentRevisionID: null } });
    });
    await t.test('immutable definition drift fails migration without rewriting it', async () => {
      await assert.rejects(IdeaRevision.updateOne({ _id: first.revision._id }, { $set: { reason: 'tamper' } }), /IMMUTABLE/);
      const definition = definitions[0];
      await IdeaDefinition.db.collection<Definition>(IdeaDefinition.collection.name).updateOne({ _id: definition._id }, { $set: { modifications: 'corrupted' } });
      await assert.rejects(migrateIdea(), /IMMUTABLE_DEFINITION_MISMATCH/);
      await IdeaDefinition.db.collection<Definition>(IdeaDefinition.collection.name).updateOne({ _id: definition._id }, { $set: { modifications: definition.modifications } });
      await migrateIdea(true);
    });
    process.env.IDEA_WORKER_ENABLED = 'true';
    const capture = captureFixture();
    const captureRequest = () => ({ chapterRootID: '10', pageIDs: ['10','11','12'], supplementPageIDs: [], idempotencyKey: randomUUID() });
    async function runCapture() { const job = await claimSourceJob(); assert.ok(job); await processSourceJob(job, capture.source); return job; }
    let completedCaptureID = '';
    await t.test('capture saves immutable normalized pages before manifest and accepts an idempotent retry', async () => {
      const input = captureRequest(); const submitted = await enqueueCapture(actor, input, capture.source);
      assert.equal((await enqueueCapture(actor, input, capture.source)).jobID, submitted.jobID);
      await assert.rejects(enqueueCapture(actor, { ...input, pageIDs: ['10'] }, capture.source), { code: 'IDEMPOTENCY_CONFLICT' });
      assert.equal(await IdeaSnapshot.exists({ _id: submitted.jobID }), null);
      await runCapture(); const result = await getCapture(actor, submitted.jobID); completedCaptureID = submitted.jobID;
      assert.equal(result.captureState, 'ready'); assert.equal(result.state, 'succeeded'); assert.equal(capture.peak(), 2);
      assert.equal(await IdeaPage.countDocuments({ snapshotID: submitted.jobID }), 3);
      const review = await createRecord(actor, 'review', { snapshotID: submitted.jobID, context, idempotencyKey: randomUUID() }); assert.equal(review.revision.version, 1);
      const capturedPages = await IdeaPage.find({ snapshotID: submitted.jobID }).lean();
      const prompt = buildPrompt({ mode: 'rubric', context, snapshots: [{ snapshotID: submitted.jobID, chapterTitle: 'Captured fixture', pageIDs: ['10','11','12'], excludedPageIDs: [], blocks: capturedPages.flatMap((p) => p.blocks) as Parameters<typeof buildPrompt>[0]['snapshots'][number]['blocks'] }] });
      assert.ok(prompt.manifest.inputHash);
      await assert.rejects(getCapture(otherActor, submitted.jobID), { status: 404 });
    });
    await t.test('partial selection and exhausted read retry require recorded acknowledgement', async () => {
      const input = { ...captureRequest(), pageIDs: ['10','11'] }; capture.failures.set('11', 2);
      const before = capture.calls.filter((id) => id === '11').length;
      const submitted = await enqueueCapture(actor, input, capture.source); await runCapture();
      assert.equal(capture.calls.filter((id) => id === '11').length - before, 2);
      const snap = (await IdeaSnapshot.findById(submitted.jobID).lean())!;
      assert.equal(snap.state, 'partial'); assert.deepEqual(snap.excludedPageIDs, ['11','12']);
      await assert.rejects(createRecord(actor, 'review', { snapshotID: snap._id, context, idempotencyKey: randomUUID() }), { code: 'PARTIAL_ACKNOWLEDGEMENT_REQUIRED' });
      const saved = await createRecord(actor, 'review', { snapshotID: snap._id, context, idempotencyKey: randomUUID(), acknowledgePartial: true });
      assert.ok('answers' in saved.revision.data); assert.equal(saved.revision.data.partialCaptureAcknowledged, true);
      capture.failures.clear();
    });
    await t.test('transient retry preserves success; empty public pages differ from failed capture', async () => {
      capture.failures.set('11', 1); capture.html.set('12', captureHTML('12', ''));
      const submitted = await enqueueCapture(actor, captureRequest(), capture.source); await runCapture();
      assert.equal((await IdeaSnapshot.findById(submitted.jobID).lean())!.state, 'ready');
      const empty = (await IdeaPage.findOne({ snapshotID: submitted.jobID, pageID: '12' }).lean())!; assert.equal(empty.state, 'captured'); assert.equal(empty.blocks.length, 0);
      capture.html.set('12', captureHTML('12'));
      for (const id of ['10','11','12']) capture.failures.set(id, 2);
      const failed = await enqueueCapture(actor, captureRequest(), capture.source); await runCapture();
      assert.equal((await IdeaSnapshot.findById(failed.jobID).lean())!.state, 'failed');
      await assert.rejects(create(actor, failed.jobID), { code: 'SNAPSHOT_NOT_READY' }); capture.failures.clear();
    });
    await t.test('expired lease recovery reuses durable pages and excludes stale worker publication', async () => {
      const submitted = await enqueueCapture(actor, captureRequest(), capture.source); const original = (await claimSourceJob())!;
      let thrown = false;
      await assert.rejects(processSourceJob(original, capture.source, undefined, async (point) => { if (point === 'page_pinned' && !thrown) { thrown = true; throw Error('capture crash'); } }), /capture crash/);
      const pinned = (await IdeaSourceJob.findById(submitted.jobID).lean())!.results.map((r) => r.pageID);
      const before = [...capture.calls];
      await IdeaSourceJob.updateOne({ _id: submitted.jobID }, { $set: { leaseUntil: new Date(0) } });
      const resumed = (await claimSourceJob())!; assert.notEqual(resumed.leaseToken, original.leaseToken);
      await processSourceJob(original, capture.source); assert.equal((await IdeaSourceJob.findById(submitted.jobID).lean())!.leaseToken, resumed.leaseToken);
      await processSourceJob(resumed, capture.source);
      for (const id of pinned) assert.equal(capture.calls.filter((c) => c === id).length, before.filter((c) => c === id).length);
      assert.equal((await getCapture(actor, submitted.jobID)).state, 'succeeded');
    });
    await t.test('crash at frozen manifest or after snapshot insert recovers without refetching', async () => {
      for (const failure of ['manifest_frozen','snapshot_persisted'] as const) {
        const submitted = await enqueueCapture(actor, captureRequest(), capture.source); const job = (await claimSourceJob())!;
        await assert.rejects(processSourceJob(job, capture.source, undefined, async (point) => { if (point === failure) throw Error('finalize crash'); }), /finalize crash/);
        const calls = capture.calls.length;
        await IdeaSourceJob.updateOne({ _id: submitted.jobID }, { $set: { leaseUntil: new Date(0) } });
        const resumed = (await claimSourceJob())!; await processSourceJob(resumed, capture.source);
        assert.equal(capture.calls.length, calls); assert.equal((await getCapture(actor, submitted.jobID)).state, 'succeeded');
      }
    });
    await t.test('source slot is global; removed membership and expired deadline prevent new source reads', async () => {
      const submitted = await enqueueCapture(actor, captureRequest(), capture.source); const job = (await claimSourceJob())!;
      assert.equal(await claimSourceJob(), null);
      await Project.collection.updateOne({ projectID: actor.projectID }, { $pull: { members: owner } } as never);
      const calls = capture.calls.length; await processSourceJob(job, capture.source); assert.equal(capture.calls.length, calls);
      assert.equal((await IdeaSourceJob.findById(submitted.jobID).lean())!.state, 'failed');
      await Project.collection.updateOne({ projectID: actor.projectID }, { $push: { members: owner } } as never);
      const expired = await enqueueCapture(actor, captureRequest(), capture.source);
      await IdeaSourceJob.updateOne({ _id: expired.jobID }, { $set: { deadline: new Date(0) } }); await runCapture();
      assert.equal(capture.calls.length, calls); assert.equal((await IdeaSnapshot.findById(expired.jobID).lean())!.state, 'failed');
    });
    await t.test('two workers contend for one global slot and shutdown releases unfinished capture', async () => {
      const one = await enqueueCapture(actor, captureRequest(), capture.source); await enqueueCapture(actor, captureRequest(), capture.source);
      const claims = await Promise.all([claimSourceJob(), claimSourceJob()]); assert.equal(claims.filter(Boolean).length, 1);
      const active = claims.find(Boolean)!; const stop = new AbortController(); stop.abort();
      await processSourceJob(active, capture.source, stop.signal);
      const released = (await IdeaSourceJob.findById(active._id).lean())!; assert.equal(released.leaseToken, null); assert.ok(['queued','running'].includes(released.state));
      await runCapture(); await runCapture(); assert.equal((await getCapture(actor, one.jobID)).state, 'succeeded');
    });
    await t.test('worker loop starts after storage readiness and drains a pending fetch on stop', async () => {
      const submitted = await enqueueCapture(actor, captureRequest(), capture.source);
      let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
      const stop = startCaptureWorker({ ...capture.source, async html(_page, signal) {
        started(); return new Promise<string>((_resolve, reject) => { const abort = () => reject(Error('aborted')); signal!.addEventListener('abort', abort, { once: true }); if (signal!.aborted) abort(); });
      } });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([ready, new Promise((_r, reject) => { timer = setTimeout(() => reject(Error('worker did not start')), 3000); })]); }
      finally { clearTimeout(timer); await stop(); }
      assert.equal((await IdeaSourceJob.findById(submitted.jobID).lean())!.leaseToken, null);
      await runCapture(); assert.equal((await getCapture(actor, submitted.jobID)).state, 'succeeded');
    });
    await t.test('snapshot text cap fails explicitly instead of truncating successful page evidence', async () => {
      const wide = captureFixture(); wide.pages.splice(0, wide.pages.length, ...Array.from({ length: 11 }, (_, i) => ({ pageID: String(i + 10), parentID: i ? '10' : null, title: `Large ${i}`, url: `https://bio.libretexts.org/Large/${i}`, modified: null })));
      wide.pages.forEach((p) => wide.html.set(p.pageID, captureHTML(p.pageID, `<p>${'x'.repeat(200000)}</p>`)));
      const queued = await enqueueCapture(actor, { ...captureRequest(), pageIDs: wide.pages.map((p) => p.pageID) }, wide.source); const job = (await claimSourceJob())!;
      await processSourceJob(job, wide.source); const result = await getCapture(actor, queued.jobID);
      assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'SNAPSHOT_TEXT_TOO_LARGE'); assert.equal(await IdeaSnapshot.exists({ _id: job._id }), null);
    });
    await t.test('candidate cleanup preserves live jobs and committed pages', async () => {
      const old = new Date(Date.now() - 8 * 86400000); const id = randomUUID();
      await IdeaPage.create({ _id: id, snapshotID: randomUUID(), pageID: '999', state: 'captured', blocks: [], preview: '', source: {}, createdAt: old });
      assert.ok((await maintainIdea()).unusedPageCandidates.includes(id));
      assert.ok((await maintainIdea(true)).removedPageCandidates.includes(id));
      assert.equal(await IdeaPage.exists({ _id: id }), null);
      assert.equal(await IdeaPage.countDocuments({ snapshotID: completedCaptureID }), 3);
      const submitted = await enqueueCapture(actor, captureRequest(), capture.source); const job = (await claimSourceJob())!;
      const heldID = randomUUID(); await IdeaPage.create({ _id: heldID, snapshotID: job.leaseToken!, pageID: '998', state: 'captured', blocks: [], preview: '', source: {}, createdAt: old });
      assert.ok(!(await maintainIdea(true)).removedPageCandidates.includes(heldID));
      await processSourceJob(job, capture.source); assert.equal((await getCapture(actor, submitted.jobID)).state, 'succeeded');
    });
    await t.test('source comparison detects content/rename/add/remove changes and preserves the old snapshot', async () => {
      const original = (await IdeaSnapshot.findById(completedCaptureID).lean())!;
      capture.html.set('11', captureHTML('11', '<p>Changed content</p>')); capture.pages[1].title = 'Renamed chapter';
      const removed = capture.pages.pop()!; capture.pages.push({ ...removed, pageID: '13' });
      const submitted = await enqueueSourceCheck(actor, { snapshotID: completedCaptureID, idempotencyKey: randomUUID() }); await runCapture();
      const result = await getSourceCheck(actor, submitted.jobID); const data = result.result as { status: string; coverage: { added: string[]; removed: string[]; renamed: string[] }; deltas: { pageID: string; state: string }[] };
      assert.equal(data.status, 'unknown'); assert.deepEqual(data.coverage.added, ['13']); assert.deepEqual(data.coverage.removed, ['12']); assert.deepEqual(data.coverage.renamed, ['11']);
      assert.equal(data.deltas.find((d) => d.pageID === '11')!.state, 'changed');
      assert.equal((await IdeaSnapshot.findById(completedCaptureID).lean())!.hash, original.hash);
      capture.pages.pop(); capture.pages.push(removed); capture.pages[1].title = 'Fictional 11'; capture.html.set('11', captureHTML('11'));
      const unchanged = await enqueueSourceCheck(actor, { snapshotID: completedCaptureID, idempotencyKey: randomUUID() }); await runCapture();
      assert.equal(((await getSourceCheck(actor, unchanged.jobID)).result as { status: string }).status, 'unchanged');
    });
    const { createIdeaRouter, ideaJSONParser, ideaError } = await import('../../api/idea.js');
    const router = createIdeaRouter(capture.source);

    const app = express(); app.use('/api/v1/projects/:projectID/idea', ideaJSONParser, ideaError); app.use(express.json());
    app.use('/api/v1/projects/:projectID/idea', router); app.post('/ordinary', (_req, res) => res.sendStatus(200));
    server = app.listen(0, '127.0.0.1'); await new Promise<void>((r) => server!.once('listening', r));
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const baseURL = `http://127.0.0.1:${address.port}`;
    async function request(path: string, uuid = owner, method = 'GET', body?: unknown, origin = 'https://idea.example.test') {
      const token = await new SignJWT({ uuid, sessionId: sessionIDs.get(uuid) }).setProtectedHeader({ alg: 'HS256' }).setIssuer('https://idea.example.test').setAudience('https://idea.example.test').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SECRETKEY));
      return fetch(`${baseURL}/api/v1/projects/idea-project/idea${path}`, { method, headers: { authorization: token, 'content-type': 'application/json', ...(origin && { origin }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    }
    await t.test('HTTP sessions, revocation, privacy and origin enforcement', async () => {
      assert.equal((await request('/capabilities')).status, 200);
      assert.equal((await request('/capabilities', outsider)).status, 404);
      const unauth = await fetch(`${baseURL}/api/v1/projects/idea-project/idea/reviews`); assert.equal(unauth.status, 401); assert.equal((await unauth.json()).code, 'INVALID_SESSION');
      assert.equal((await request('/reviews', auditor, 'POST', { snapshotID, context, idempotencyKey: randomUUID() })).status, 403);
      for (const origin of ['', 'https://evil.example']) assert.equal((await request('/reviews', owner, 'POST', { snapshotID, context, idempotencyKey: randomUUID() }, origin)).status, 403);
      await Project.collection.updateOne({ projectID: actor.projectID }, { $pull: { members: owner } } as never);
      assert.equal((await request(`/exports/review/${first.head._id}?revisionID=${first.revision._id}&format=json`)).status, 404);
      await Project.collection.updateOne({ projectID: actor.projectID }, { $push: { members: owner } } as never);
      await Session.updateOne({ sessionId: sessionIDs.get(owner) }, { $set: { valid: false } });
      assert.equal((await request('/capabilities')).status, 401);
      await Session.updateOne({ sessionId: sessionIDs.get(owner) }, { $set: { valid: true } });
    });
    await t.test('HTTP create, patch, history, preview and cross-project reference rejection', async () => {
      const created = await request('/reviews', owner, 'POST', { snapshotID, context, idempotencyKey: randomUUID() });
      assert.equal(created.status, 201); const original = (await created.json()).data;
      const mutation = { expectedVersion: 1, mutationID: randomUUID(), summary: 'HTTP saved text' };
      const edited = await request(`/reviews/${original.head._id}`, owner, 'PATCH', mutation); assert.equal(edited.status, 200);
      assert.equal((await edited.json()).data.revision.data.summary, 'HTTP saved text');
      const history = await request(`/reviews/${original.head._id}?revisionID=${original.revision._id}`); assert.equal((await history.json()).data.revision.data.summary, '');
      const collision = await request(`/reviews/${original.head._id}`, owner, 'PATCH', { ...mutation, summary: 'collision' }); assert.equal(collision.status, 409);
      assert.equal((await request(`/snapshots/${snapshotID}/pages/water`, auditor)).status, 200);
      const foreignSnapshot = await snapshot('other-project'); assert.equal((await request(`/snapshots/${foreignSnapshot}/pages/water`)).status, 404);
      assert.equal((await request(`/reviews/${original.head._id}`, owner, 'PATCH', { expectedVersion: 2, mutationID: randomUUID(), bodyHTML: '<script>bad</script>' })).status, 422);
    });
    await t.test('HTTP run reads, feedback and cancellation authorize underlying records and owner', async () => {
      const runID = randomUUID();
      await IdeaRun.create({ _id: runID, projectID: actor.projectID, ownerUUID: owner, revisionIDs: [first.revision._id], mode: '7.2', status: 'succeeded', idempotencyKey: randomUUID(), attempts: [], output: draftFor('7.2'), input: { internalOnly: true } });
      const result = await request(`/runs/${runID}`, auditor); assert.equal(result.status, 200); assert.equal('input' in (await result.json()).data, false);
      const body = { expectedVersion: 0, disposition: 'useful', note: 'Checked' };
      assert.equal((await request(`/runs/${runID}/feedback`, lead, 'POST', body)).status, 403);
      assert.equal((await request(`/runs/${runID}/feedback`, owner, 'POST', body)).status, 200);
      assert.equal((await request(`/runs/${runID}/feedback`, owner, 'POST', body)).status, 409);
      const pendingID = randomUUID();
      await IdeaRun.create({ _id: pendingID, projectID: actor.projectID, ownerUUID: owner, revisionIDs: [first.revision._id], mode: '7.2', status: 'queued', idempotencyKey: randomUUID(), attempts: [] });
      assert.equal((await request(`/runs/${pendingID}/cancel`, owner, 'POST', {})).status, 200);
      const canceled = await request(`/runs/${pendingID}/cancel`, owner, 'POST', {}); assert.equal((await canceled.json()).data.cancelRequested, true);
      const foreign = await create(otherActor, await snapshot('other-project')); const foreignRunID = randomUUID();
      await IdeaRun.create({ _id: foreignRunID, projectID: actor.projectID, ownerUUID: owner, revisionIDs: [foreign.revision._id], mode: '7.2', status: 'queued', idempotencyKey: randomUUID(), attempts: [] });
      assert.equal((await request(`/runs/${foreignRunID}`)).status, 404);
    });
    await t.test('HTTP public tree/capture/progress/check routes retain authentication and strict inputs', async () => {
      assert.equal((await request('/source-tree', auditor)).status, 200);
      assert.equal((await request('/source-tree?url=https://evil.test')).status, 422);
      const submitted = await request('/captures', owner, 'POST', captureRequest()); assert.equal(submitted.status, 202);
      const id = (await submitted.json()).data.jobID;
      assert.equal((await request(`/captures/${id}`, auditor)).status, 200); await runCapture();
      const completed = (await (await request(`/captures/${id}`)).json()).data; assert.equal(completed.captureState, 'ready');
      const check = await request('/source-checks', owner, 'POST', { snapshotID: id, idempotencyKey: randomUUID() }); assert.equal(check.status, 202);
      const checkID = (await check.json()).data.jobID; await runCapture();
      assert.equal((await request(`/source-checks/${checkID}`, auditor)).status, 200);
      process.env.IDEA_WORKER_ENABLED = 'false'; assert.equal((await request('/captures', owner, 'POST', captureRequest())).status, 503); process.env.IDEA_WORKER_ENABLED = 'true';
    });
    await t.test('missing indexes block writes and duplicate keys make migration fail safely', async () => {
      const indexes = await IdeaHead.collection.indexes();
      const unique = indexes.find((i) => i.key.creationKey)!; await IdeaHead.collection.dropIndex(unique.name!);
      const response = await request('/reviews', owner, 'POST', { snapshotID, context, idempotencyKey: randomUUID() });
      assert.equal(response.status, 503); assert.equal((await response.json()).code, 'STORAGE_NOT_READY');
      const duplicate = { ...(await IdeaHead.findById(first.head._id).lean())!, _id: randomUUID() };
      await IdeaHead.create(duplicate);
      await assert.rejects(migrateIdea());
      await IdeaHead.deleteOne({ _id: duplicate._id }); await migrateIdea(); await migrateIdea(true);
    });
    await t.test('HTTP schemas, local parser limits and disabled worker/feature behavior', async () => {
      const extra = await request('/reviews', owner, 'POST', { snapshotID, context, idempotencyKey: randomUUID(), ownerUUID: outsider }); assert.equal(extra.status, 422);
      const large = await request('/reviews', owner, 'POST', { extra: 'x'.repeat(120000) }); assert.equal(large.status, 422); // reaches strict schema, not default 100 KiB parser
      const oversized = await request('/reviews', owner, 'POST', { extra: 'x'.repeat(270000) }); assert.equal(oversized.status, 413);
      assert.equal((await fetch(`${baseURL}/ordinary`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'x'.repeat(120000) }) })).status, 413);
      assert.equal((await request('/runs', owner, 'POST', {})).status, 503);
      process.env.IDEA_REVIEW_ENABLED = 'false';
      assert.equal((await request('/reviews', owner, 'POST', { snapshotID, context, idempotencyKey: randomUUID() })).status, 503);
      assert.equal((await request(`/reviews/${first.head._id}`)).status, 200);
      const exported = await request(`/exports/review/${first.head._id}?revisionID=${first.revision._id}&format=json`, auditor);
      assert.equal(exported.status, 200); assert.match(exported.headers.get('content-disposition')!, /attachment/); assert.match(exported.headers.get('cache-control')!, /no-store/);
      process.env.IDEA_REVIEW_ENABLED = 'true';
    });
    await t.test('private AI estimate/admission HTTP contract rejects client model and identity overrides', async () => {
      process.env.IDEA_AI_ENABLED = 'true'; process.env.IDEA_WORKER_ENABLED = 'true';
      process.env.OPENAI_API_KEY = 'fixture-no-network';
      const record = await create();
      const body = { headID: record.head._id, revisionID: record.revision._id, mode: '7.3' };
      assert.equal((await request('/runs/estimate', auditor, 'POST', body)).status, 403);
      assert.equal((await request('/runs/estimate', teammate, 'POST', body)).status, 403);
      assert.equal((await request('/runs/estimate', owner, 'POST', { ...body, model: 'override' })).status, 422);
      const estimateResponse = await request('/runs/estimate', owner, 'POST', body); assert.equal(estimateResponse.status, 200);
      const estimate = (await estimateResponse.json()).data;
      const submission = { estimateID: estimate.estimateID, inputHash: estimate.inputHash, disclosureVersion: 'idea-data-use-openai-v2', acknowledgeDataUse: true, idempotencyKey: randomUUID() };
      assert.equal((await request('/runs', owner, 'POST', { ...submission, acknowledgeDataUse: false })).status, 422);
      assert.equal((await request('/runs', owner, 'POST', { ...submission, disclosureVersion: 'idea-data-use-v1' })).status, 422);
      const admitted = await request('/runs', owner, 'POST', submission); assert.equal(admitted.status, 202);
      const id = (await admitted.json()).data.runID;
      const read = await request(`/runs/${id}`, auditor); assert.equal(read.status, 200);
      const data = (await read.json()).data; assert.equal(data.status, 'queued'); assert.equal('input' in data, false);
      assert.equal(JSON.stringify(data).includes('fixture-no-network'), false);
      assert.equal((await request(`/runs/${id}/cancel`, owner, 'POST', {})).status, 200);
      const framework = await request('/framework', auditor); assert.equal(framework.status, 200); assert.equal((await framework.json()).data.categories.length, 8);
      const history = await request(`/runs?headID=${record.head._id}`, auditor); assert.equal(history.status, 200);
      const rows = (await history.json()).data.items; assert.equal(rows.length, 1); assert.equal(rows[0]._id, id); assert.equal('input' in rows[0], false); assert.equal('output' in rows[0], false);
      assert.equal((await request(`/runs?headID=${record.head._id}`, outsider)).status, 404);
      assert.equal((await request(`/runs?headID=${record.head._id}&before=invalid`, owner)).status, 422);
      const secondReview = await create();
      const synthesis = await createRecord(actor, 'synthesis', { context, reviewRevisionIDs: [record.revision._id, secondReview.revision._id], includedDraftIDs: [], idempotencyKey: randomUUID() });
      const synthesisRunID = randomUUID();
      await IdeaRun.create({ _id: synthesisRunID, projectID: actor.projectID, ownerUUID: owner, revisionIDs: [synthesis.revision._id, record.revision._id, secondReview.revision._id], mode: 'synthesis', status: 'queued', phase: 'queued', attempts: [], idempotencyKey: randomUUID(), createdAt: new Date(), updatedAt: new Date() });
      const synthesisHistory = await request(`/runs?headID=${synthesis.head._id}&kind=synthesis`, auditor);
      assert.equal(synthesisHistory.status, 200); assert.equal((await synthesisHistory.json()).data.items[0]._id, synthesisRunID);
      const chapterHistory = (await (await request(`/runs?headID=${record.head._id}`, auditor)).json()).data.items;
      assert.equal(chapterHistory.length, 1); assert.equal(chapterHistory[0]._id, id);
      assert.equal((await request(`/runs?headID=${synthesis.head._id}`, auditor)).status, 404);
      const coverage = await request(`/syntheses/${synthesis.head._id}/coverage`, auditor); assert.equal(coverage.status, 200); assert.equal((await coverage.json()).data.assessmentCount, 2);
      assert.equal((await request(`/syntheses/${synthesis.head._id}/coverage`, outsider)).status, 404);
      process.env.IDEA_AI_ENABLED = 'false'; delete process.env.OPENAI_API_KEY;
    });
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});
