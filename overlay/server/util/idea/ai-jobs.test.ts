import './fixtures/test-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import Project from '../../models/project.js';
import User from '../../models/user.js';
import Session from '../../models/session.js';
import { IdeaRun, IdeaPage, IdeaSnapshot, IdeaEstimate, IdeaDailyLimit } from '../../models/idea-models.js';
import { migrateIdea } from '../../api/services/idea/migration-service.js';
import { readRecord, createRecord, mutateRecord } from '../../api/services/idea/review-service.js';
import { estimateRun, submitRun } from '../../api/services/idea/ai-run-service.js';
import { claimAIJob, processAIJob, repairAIJobs, startAIWorker } from '../../api/services/idea/ai-worker.js';
import { synthesisCoverage } from '../../api/services/idea/synthesis-service.js';
import { exportRecord, markdownExport } from '../../api/services/idea/export-service.js';
import { ProviderError } from '../../api/services/idea/live-provider.js';
import { settleBudget, reserveBudget, assertBudgetOpen } from '../../api/services/idea/ai-quota.js';
import { FakeIdeaProvider } from './fixtures/fake-provider.js';
import { chapters, context, draftFor } from './fixtures/chapters.js';
import { assertTestDatabase } from './test-database.js';
import type { Actor } from '../../api/services/idea/permission-service.js';
const uri = process.env.IDEA_TEST_MONGO_URI;
test('durable AI jobs on standalone MongoDB', { skip: !uri }, async (t) => {
  assertTestDatabase(uri!); const dbURI = `${uri!}_ai`; assertTestDatabase(dbURI);
  await mongoose.connect(dbURI, { autoIndex: false, autoCreate: false });
  try {
    await mongoose.connection.dropDatabase(); await migrateIdea();
    Object.assign(process.env, { IDEA_REVIEW_ENABLED: 'true', IDEA_AI_ENABLED: 'true', IDEA_WORKER_ENABLED: 'true', IDEA_PILOT_PROJECT_IDS: '["ai-project"]', OLLAMA_API_KEY: 'fixture-no-network', OPENAI_API_KEY: 'fixture-no-network' });
    const actor: Actor = { uuid: randomUUID(), sessionID: randomUUID(), projectID: 'ai-project', role: 'author', bookID: 'bio:1' };
    await User.collection.insertOne({ uuid: actor.uuid } as never);
    await Session.create({ sessionId: actor.sessionID, userId: actor.uuid, valid: true, createdAt: new Date(), expiresAt: new Date(Date.now() + 3600000) });
    await Project.collection.insertOne({ projectID: actor.projectID, libreLibrary: 'bio', libreCoverID: '1', members: [actor.uuid] } as never);
    const snapshotID = randomUUID(), chapter = chapters[0];
    await IdeaPage.create([...chapter.pageIDs, ...chapter.excludedPageIDs].map((pageID) => ({ _id: randomUUID(), snapshotID, pageID, state: chapter.pageIDs.includes(pageID) ? 'captured' : 'excluded', blocks: chapter.blocks.filter((b) => b.pageID === pageID), preview: '<p>Fictional</p>', source: {}, createdAt: new Date() })));
    await IdeaSnapshot.create({ _id: snapshotID, projectID: actor.projectID, bookID: actor.bookID, chapterRootID: '1', chapterTitle: chapter.chapterTitle, state: 'ready', pageIDs: chapter.pageIDs, excludedPageIDs: chapter.excludedPageIDs, definitionIDs: [], hash: 'fixture', manifest: {}, createdAt: new Date() });
    const record = await createRecord(actor, 'review', { snapshotID, context, idempotencyKey: randomUUID() });
    const estimate = () => estimateRun(actor, { headID: record.head._id, revisionID: record.revision._id, mode: '7.3' });
    const submission = (e: Awaited<ReturnType<typeof estimate>>) => ({ estimateID: e.estimateID, inputHash: e.inputHash, disclosureVersion: 'idea-data-use-openai-v2' as const, acknowledgeDataUse: true as const, idempotencyKey: randomUUID() });
    const enqueue = async () => submitRun(actor, submission(await estimate()));
    const response = (provider: 'openai', text = JSON.stringify(draftFor('7.3')).replaceAll('environment-v1', snapshotID)) => ({ actualProvider: provider, actualModel: 'served-test-model', text, finish: 'complete' as const, usage: { inputTokens: 100, outputTokens: 200, reasoningTokens: 150 } });
    const fake = (steps: any[]) => ({ openai: new FakeIdeaProvider(steps) });
    await t.test('frozen estimate, idempotent admission, global slot, success and no human changes', async () => {
      const e = await estimate(), body = submission(e);
      const [a, b] = await Promise.all([submitRun(actor, body), submitRun(actor, body)]); assert.equal(a.runID, b.runID);
      const run = await claimAIJob(); assert.ok(run); assert.equal(await claimAIJob(), null);
      const providers = fake([{ response: response('openai') }]); await processAIJob(run, providers);
      const saved = await IdeaRun.findById(a.runID).lean(); assert.equal(saved?.status, 'succeeded'); assert.equal(saved?.settled, true);
      assert.equal(providers.openai.calls.length, 1); assert.equal(saved?.attempts.length, 1); assert.equal((await IdeaDailyLimit.findOne({ scope: 'deployment' }).lean())?.spentMicroUSD, 260);
      assert.equal(record.revision.data.status, 'draft');
      assert.equal((saved?.attempts[0] as any).actualModel, 'served-test-model');
    });
    await t.test('OpenAI 429 fails once and conservatively settles unknown usage without fallback', async () => {
      await enqueue(); const run = await claimAIJob(); assert.ok(run);
      const providers = fake([{ error: new ProviderError('RATE_LIMIT', true, 429) }, { response: response('openai') }]);
      await processAIJob(run, providers); const saved = await IdeaRun.findById(run._id).lean();
      assert.equal(saved?.status, 'failed'); assert.equal(saved?.attempts.length, 1); assert.equal(providers.openai.calls.length, 1);
      const ledger = await IdeaDailyLimit.findOne({ scope: 'deployment' }).lean();
      assert.equal(ledger?.reservations.find(r=>r.id===run._id)?.amount, 36416);
      const spent=ledger?.spentMicroUSD;await settleBudget(saved!);
      assert.equal((await IdeaDailyLimit.findById(ledger!._id).lean())?.spentMicroUSD, spent);
    });
    await t.test('queued legacy profile fails closed without either provider being called', async () => {
      const job=await enqueue();
      await IdeaRun.updateOne({_id:job.runID},{$set:{'input.profile.id':'idea-remedy-glm-luna-v2'}});
      const run=await claimAIJob();assert.ok(run);
      const providers=fake([{response:response('openai')}]);await processAIJob(run,providers);
      assert.equal(providers.openai.calls.length,0);
      const saved=await IdeaRun.findById(job.runID).lean();assert.deepEqual(saved?.error,{code:'INPUT_STALE'});assert.equal(saved?.settled,true);
    });
    await t.test('invalid schema, refusal and grounding failure all stop after one OpenAI attempt', async () => {
      for (const scenario of ['schema', 'refusal', 'grounding']) {
        await enqueue(); const run = await claimAIJob(); assert.ok(run);
        const r = response('openai', scenario === 'schema' ? '{}' : scenario === 'grounding' ? JSON.stringify(draftFor('7.3')) : undefined);
        const providers = fake([{ response: { ...r, finish: scenario === 'refusal' ? 'refused' : 'complete' } }]);
        await processAIJob(run, providers);
        assert.equal(providers.openai.calls.length, 1);
        assert.equal((await IdeaRun.findById(run._id).lean())?.status, 'failed');
        if (scenario === 'grounding') {
          const saved = await IdeaRun.findById(run._id).lean();
          assert.deepEqual((saved?.attempts[0] as any).validationErrors, ['UNKNOWN_REVIEWED_SCOPE']);
          assert.equal(saved?.output, undefined);
        }
      }
    });
    await t.test('AI disablement drains queued reservations without any provider submission', async () => {
      const job = await enqueue(); process.env.IDEA_AI_ENABLED = 'false';
      await IdeaDailyLimit.create({ _id: 'control:all', scope: 'control', day: 'all', reservations: [], consumedCount: 0, spentMicroUSD: 0, version: 0, paused: true });
      const providers = fake([{ response: response('openai') }]);
      const stop = startAIWorker(providers);
      try {
        const deadline = Date.now() + 8000;
        while (!(await IdeaRun.findById(job.runID).lean())?.settled && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
        const saved = await IdeaRun.findById(job.runID).lean();
        assert.equal(saved?.status, 'failed'); assert.deepEqual(saved?.error, { code: 'AI_DISABLED' }); assert.equal(saved?.settled, true);
        assert.equal(providers.openai.calls.length, 0);
        const limits = await IdeaDailyLimit.find({ scope: { $ne: 'control' } }).lean();
        assert.ok(limits.every(l => l.reservations.every(r => r.settled)));
      } finally { await stop(); await IdeaDailyLimit.deleteOne({ _id: 'control:all' }); process.env.IDEA_AI_ENABLED = 'true'; }
    });
    await t.test('canceled queued job makes no calls and releases unsubmitted count', async () => {
      const job = await enqueue(); await IdeaRun.updateOne({ _id: job.runID }, { $set: { cancelRequested: true } });
      const run = await claimAIJob(); assert.ok(run); const providers = fake([{ response: response('openai') }]);
      await processAIJob(run, providers); assert.equal(providers.openai.calls.length, 0); assert.equal((await IdeaRun.findById(run._id).lean())?.status, 'canceled');
    });
    await t.test('crash with submitted OpenAI attempt consumes reservation and never resubmits', async () => {
      await enqueue(); const run = await claimAIJob(); assert.ok(run);
      await IdeaRun.updateOne({ _id: run._id }, { $set: { leaseUntil: new Date(0), attempts: [{ provider: 'openai', submissionStarted: new Date().toISOString() }] } });
      await repairAIJobs(); const saved = await IdeaRun.findById(run._id).lean();
      assert.deepEqual(saved?.error, { code: 'PROVIDER_OUTCOME_UNKNOWN' }); assert.equal(saved?.settled, true);
      assert.equal(await claimAIJob(), null);
    });
    await t.test('queue cap is atomic under concurrent admissions and failures compensate', async () => {
      const e = await estimate(); const results = await Promise.allSettled(Array.from({ length: 6 }, () => submitRun(actor, submission(e))));
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
      assert.equal(await IdeaRun.countDocuments({ status: 'queued' }), 3);
      for (const run of await IdeaRun.find({ status: 'queued' }).lean()) await IdeaRun.updateOne({ _id: run._id }, { $set: { status: 'failed' } });
      await repairAIJobs();
      const ledger = await IdeaDailyLimit.findOne({ scope: `actor:${actor.uuid}` }).lean(); assert.equal(ledger?.reservations.filter((r) => !r.settled).length, 0);
    });
    await t.test('mid-flight cancellation aborts provider without fallback', async () => {
      const job = await enqueue(); const run = await claimAIJob(); assert.ok(run);
      const providers = fake([{ response: response('openai'), delayMs: 5000 }]);
      const timer = setTimeout(() => { void IdeaRun.updateOne({ _id: job.runID }, { $set: { cancelRequested: true } }).exec(); }, 150);
      try { await processAIJob(run, providers); } finally { clearTimeout(timer); }
      assert.equal(providers.openai.calls.length, 1);
      assert.equal((await IdeaRun.findById(run._id).lean())?.status, 'canceled');
    });
    await t.test('revoked session blocks a queued call', async () => {
      await enqueue(); const run = await claimAIJob(); assert.ok(run);
      await Session.updateOne({ sessionId: actor.sessionID }, { $set: { valid: false } });
      const providers = fake([{ response: response('openai') }]);
      await processAIJob(run, providers); assert.equal(providers.openai.calls.length, 0);
      assert.deepEqual((await IdeaRun.findById(run._id).lean())?.error, { code: 'INVALID_SESSION' });
      await Session.updateOne({ sessionId: actor.sessionID }, { $set: { valid: true } });
    });
    await t.test('repair compensates a partial admission and prevents late reservations', async () => {
      const job = await enqueue();
      await IdeaRun.updateOne({ _id: job.runID }, { $set: { status: 'admission', updatedAt: new Date(0) } });
      await repairAIJobs(); const saved = await IdeaRun.findById(job.runID).lean();
      assert.equal(saved?.settled, true); assert.equal(saved?.status, 'failed');
      await assert.rejects(reserveBudget(saved!), { code: 'ADMISSION_EXPIRED' });
    });
    await t.test('expired estimates and changed reviews cannot submit', async () => {
      const e = await estimate(); await IdeaEstimate.updateOne({ _id: e.estimateID }, { $set: { expiresAt: new Date(0) } });
      await assert.rejects(submitRun(actor, submission(e)), { code: 'ESTIMATE_STALE' });
      const pending = await enqueue(); await mutateRecord(actor, 'review', record.head._id, { expectedVersion: 1, mutationID: randomUUID(), summary: 'Changed while queued' });
      const run = await claimAIJob(); assert.ok(run); const providers = fake([{ response: response('openai') }]);
      await processAIJob(run, providers); assert.equal(providers.openai.calls.length, 0);
      assert.deepEqual((await IdeaRun.findById(pending.runID).lean())?.error, { code: 'INPUT_STALE' });
    });
    await t.test('two independent chapters synthesize frozen versions; reruns preserve faculty judgments and export provenance', async () => {
      const secondID = randomUUID(), second = chapters[1];
      await IdeaPage.create(second.pageIDs.map((pageID) => ({ _id: randomUUID(), snapshotID: secondID, pageID, state: 'captured', blocks: second.blocks.filter((b) => b.pageID === pageID), preview: '<p>Fictional second chapter</p>', source: {}, createdAt: new Date() })));
      await IdeaSnapshot.create({ _id: secondID, projectID: actor.projectID, bookID: actor.bookID, chapterRootID: '2', chapterTitle: second.chapterTitle, state: 'ready', pageIDs: second.pageIDs, excludedPageIDs: [], definitionIDs: [], hash: 'fictional-second', manifest: {}, createdAt: new Date() });
      const secondReview = await createRecord(actor, 'review', { snapshotID: secondID, context, idempotencyKey: randomUUID() });
      const selected = [record.revision._id, secondReview.revision._id];
      const included = await IdeaRun.findOne({ mode: '7.3', status: 'succeeded', revisionIDs: record.revision._id }).lean(); assert.ok(included);
      const synthesis = await createRecord(actor, 'synthesis', { context, reviewRevisionIDs: selected, includedDraftIDs: [included._id], idempotencyKey: randomUUID() });
      const coverage = await synthesisCoverage(actor, synthesis.head._id); assert.equal(coverage.chapterCount, 2); assert.equal(coverage.inputs[0].changed, true); assert.equal(coverage.inputs[1].status, 'draft');
      const runSynthesis = async (revisionID: string) => {
        const e = await estimateRun(actor, { headID: synthesis.head._id, revisionID, mode: 'synthesis' });
        const submitted = await submitRun(actor, submission(e)); const job = await claimAIJob(); assert.ok(job);
        const output = JSON.parse(JSON.stringify(draftFor('synthesis')).replaceAll('environment-v1', snapshotID)); output.inputRevisionIDs = selected;
        const providers = fake([{ response: response('openai', JSON.stringify(output)) }]);
        await processAIJob(job, providers);
        const saved = await IdeaRun.findById(submitted.runID).lean(); assert.equal(saved?.status, 'succeeded');
        const payload = JSON.parse(providers.openai.calls[0].messages[1].content);
        assert.deepEqual(payload.assessments.map((a: any) => a.revisionID), selected); assert.equal(payload.includedDrafts[0].runID, included._id);
        return { run: saved!, output };
      };
      const firstRun = await runSynthesis(synthesis.revision._id);
      const human = await mutateRecord(actor, 'synthesis', synthesis.head._id, { expectedVersion: 1, mutationID: randomUUID(), summary: 'Faculty | summary\nwith <script>unsafe</script>', draftDisposition: 'rejected', dispositionRunID: firstRun.run._id,
        proposals: [{ ...firstRun.output.plan[0], id: randomUUID(), originRunID: firstRun.run._id, disposition: 'deferred' }] });
      await runSynthesis(human.revision._id);
      const reread = await readRecord(actor, synthesis.head._id, 'synthesis'); assert.deepEqual(reread.revision.data, human.revision.data);
      const finished = await mutateRecord(actor, 'synthesis', synthesis.head._id, { expectedVersion: 2, mutationID: randomUUID(), action: 'finish' });
      const exported = await exportRecord(actor, 'synthesis', synthesis.head._id, finished.revision._id);
      assert.equal(exported.selectedAssessments.length, 2); assert.deepEqual(exported.selectedAssessments.map((a) => a.revisionID), selected);
      assert.equal(exported.selectedAssessments[0].humanReview.summary, ''); // original v1, not the newer review
      assert.equal(exported.includedDrafts.length, 2); assert.equal(exported.includedDrafts.find((d) => d.id === firstRun.run._id)?.attempts[0].actualModel, 'served-test-model');
      const md = markdownExport(exported); assert.ok(md.includes('deferred')); assert.ok(md.includes('rejected')); assert.ok(md.includes('not\\_rated')); assert.ok(md.includes('Faculty \\| summary')); assert.ok(!md.includes('<script>'));
    });
    await t.test('usage overrun records actual cost and pauses all new calls', async () => {
      const run = await IdeaRun.findOne({ status: 'succeeded' }).lean(); assert.ok(run);
      const id = randomUUID(); const overrun = { ...run, _id: id, attempts: [{ provider: 'openai', submissionStarted: new Date().toISOString(), usage: { inputTokens: 1000000, outputTokens: 1000000 } }] };
      await reserveBudget({ ...overrun, attempts: [] }); await settleBudget(overrun);
      const ledger = await IdeaDailyLimit.findOne({ scope: 'deployment' }).lean();
      assert.equal(ledger?.reservations.find((r) => r.id === id)?.amount, 1400000);
      await assert.rejects(assertBudgetOpen(), { code: 'AI_SPENDING_PAUSED' });
    });
  } finally { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});
