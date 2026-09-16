import { randomUUID } from 'node:crypto';
import { IdeaRun, type Run } from '../../../models/idea-models.js';
import { validateDraftForPrompt } from '../../../util/idea/prompts.js';
import { IDEA_LIMITS } from '../../../util/idea/config.js';
import { aiEnabled, assertAIEnabled, assertFresh, type AIBundle } from './ai-run-service.js';
import { consumeBudget, settleBudget, assertBudgetOpen } from './ai-quota.js';
import { createProviders, ProviderError } from './live-provider.js';
import type { IdeaAIProvider, IdeaAIRequest } from './ai-provider.js';
import { resolveActor, requireWrite } from './permission-service.js';
import { hash } from './revision-store.js';
import { IdeaError } from './errors.js';
import { migrateIdea } from './migration-service.js';

type Providers = Record<IdeaAIRequest['provider'], IdeaAIProvider>;
const terminal = ['succeeded', 'failed', 'canceled'];
const fence = (run: Run) => ({ _id: run._id, status: 'running', leaseToken: run.leaseToken, leaseUntil: { $gt: new Date() } });
async function persist(run: Run, values: Record<string, unknown>) {
  const result = await IdeaRun.updateOne(fence(run), { $set: { ...values, updatedAt: new Date() } });
  if (!result.modifiedCount) throw new IdeaError(409, 'LEASE_LOST');
}
async function finish(run: Run, status: string, code?: string) {
  await persist(run, { status, phase: status, ...(code ? { error: { code } } : {}) });
  const saved = await IdeaRun.findById(run._id).lean(); if (!saved) return;
  // Retain the global slot until all ledgers have settled, including overrun pause.
  await settleBudget(saved);
  await IdeaRun.updateOne({ _id: run._id, status }, { $set: { settled: true }, $unset: { slot: 1 } });
}
export async function repairAIJobs(now = new Date()) {
  // Settle unsubmitted disabled jobs even if a spending pause prevents new claims.
  for (const run of await IdeaRun.find({ status: 'queued' }).select('_id projectID').lean()) {
    if (!aiEnabled(run.projectID)) await IdeaRun.updateOne({ _id: run._id, status: 'queued' },
      { $set: { status: 'failed', phase: 'disabled', error: { code: 'AI_DISABLED' }, updatedAt: now } });
  }
  const expired = await IdeaRun.find({ $or: [
    { status: 'admission', updatedAt: { $lte: new Date(now.getTime() - 60000) } },
    { status: 'running', leaseUntil: { $lte: now } },
  ] }).lean();
  for (const run of expired) {
    const submitted = (run.attempts as any[]).some((a) => a.submissionStarted);
    const changed = await IdeaRun.updateOne({ _id: run._id, status: run.status, updatedAt: run.updatedAt, ...(run.status === 'running' ? { leaseUntil: { $lte: now } } : {}) },
      { $set: { status: 'failed', phase: 'recovery', error: { code: submitted ? 'PROVIDER_OUTCOME_UNKNOWN' : 'JOB_INTERRUPTED' }, updatedAt: now } });
    if (!changed.modifiedCount) continue;
  }
  for (const run of await IdeaRun.find({ status: { $in: terminal }, settled: false }).lean()) {
    await settleBudget(run);
    await IdeaRun.updateOne({ _id: run._id, status: run.status }, { $set: { settled: true }, $unset: { slot: 1 } });
  }
}
export async function claimAIJob() {
  await repairAIJobs(); await assertBudgetOpen();
  try {
    return await IdeaRun.findOneAndUpdate({ status: 'queued' }, { $set: {
      status: 'running', phase: 'preparing', slot: 1, leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000), deadline: new Date(Date.now() + IDEA_LIMITS.runTimeoutMs), updatedAt: new Date(),
    } }, { new: true, sort: { createdAt: 1 } }).lean();
  } catch (error) { if ((error as { code?: number }).code === 11000) return null; throw error; }
}
export async function processAIJob(run: Run, providers: Providers = createProviders(), stop: AbortSignal = new AbortController().signal) {
  const controller = new AbortController();
  let guardError: string | undefined;
  let monitoring = false;
  const stopped = () => { guardError = 'WORKER_STOPPED'; controller.abort(); };
  stop.addEventListener('abort', stopped, { once: true }); if (stop.aborted) stopped();
  const bundle = run.input as AIBundle;
  const authorize = async (checkFresh: boolean) => {
    if (run.deadline && Date.now() >= run.deadline.getTime()) throw new IdeaError(408, 'RUN_TIMEOUT');
    if (controller.signal.aborted) throw new IdeaError(409, guardError ?? 'RUN_ABORTED');
    const current = await IdeaRun.findOne(fence(run)).lean();
    if (!current) throw new IdeaError(409, 'LEASE_LOST');
    if (current.cancelRequested) throw new IdeaError(409, 'CANCELED');
    assertAIEnabled(run.projectID); await assertBudgetOpen();
    const actor = await resolveActor({ uuid: run.ownerUUID, sessionId: run.sessionID }, run.projectID); requireWrite(actor);
    if (checkFresh) await assertFresh(actor, bundle);
    return actor;
  };
  const timer = setInterval(async () => {
    if (monitoring) return; monitoring = true;
    try {
      await authorize(false);
      await persist(run, { leaseUntil: new Date(Date.now() + 60000) });
    } catch (error) { guardError = error instanceof IdeaError ? error.code : 'GUARD_UNAVAILABLE'; controller.abort(); }
    finally { monitoring = false; }
  }, 1000); timer.unref();
  const attempts: any[] = [];
  try {
    await authorize(true);
    if (run.day !== new Date().toISOString().slice(0, 10)) throw new IdeaError(409, 'UTC_DAY_CHANGED');
    if (hash(bundle) !== run.inputHash) throw new IdeaError(409, 'INPUT_STALE');
    for (const provider of ['openai'] as const) {
      await authorize(true);
      if (!providers[provider].available()) {
        throw new IdeaError(503, 'PROVIDER_UNAVAILABLE');
      }
      const attempt: any = { attemptID: randomUUID(), provider, phase: 'preparing' };
      attempts.push(attempt); await persist(run, { attempts, phase: 'preparing' });
      await consumeBudget(run); await authorize(true);
      const remaining = (run.deadline?.getTime() ?? 0) - Date.now();
      if (remaining <= 0) throw new IdeaError(408, 'RUN_TIMEOUT');
      attempt.submissionStarted = new Date().toISOString(); attempt.phase = 'submission_started';
      await persist(run, { attempts, phase: 'submission_started' });
      const request: IdeaAIRequest = { runID: run._id, attemptID: attempt.attemptID, projectID: run.projectID, inputHash: bundle.prompt.manifest.inputHash,
        profileID: bundle.profile.id, provider, mode: bundle.prompt.mode, messages: bundle.prompt.messages, outputSchema: bundle.prompt.outputSchema,
        answerTokenLimit: 8000, reasoningAllowance: 8192 };
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(IDEA_LIMITS.attemptTimeoutMs, remaining))]);
        const response = await providers[provider].submit(request, signal);
        if (response.actualProvider !== provider || typeof response.actualModel !== 'string') throw new ProviderError('INVALID_PROVIDER_RESPONSE', true);
        attempt.phase = 'response_received'; attempt.actualModel = response.actualModel; attempt.requestId = response.requestId;
        attempt.usage = response.usage; attempt.finish = response.finish; attempt.responseReceived = new Date().toISOString();
        await persist(run, { attempts, phase: 'response_received' });
        await authorize(false);
        if (response.finish === 'refused') throw new ProviderError('PROVIDER_REFUSED', false);
        if (response.finish === 'length' || !response.text.trim()) throw new ProviderError('INCOMPLETE_RESPONSE', true);
        let validated: ReturnType<typeof validateDraftForPrompt>;
        try { validated = validateDraftForPrompt(JSON.parse(response.text), bundle.promptInput); }
        catch { throw new ProviderError('INVALID_DRAFT_SCHEMA', true); }
        // Grounding failures are semantic failures, not a reason to shop for another model.
        if (validated.errors.length) {
          // Retain bounded validator codes, never the failed response or quoted source text.
          attempt.validationErrors = [...new Set(validated.errors)];
          throw new ProviderError('INVALID_DRAFT_EVIDENCE', false);
        }
        attempt.phase = 'validated';
        await authorize(false);
        await persist(run, { attempts, output: validated.draft, validation: { valid: true, evidenceValidated: true, facultyReviewRequired: true }, phase: 'validated' });
        await finish(run, 'succeeded'); return;
      } catch (error) {
        if (error instanceof IdeaError) throw error;
        const safe = error instanceof ProviderError ? error : new ProviderError('PROVIDER_OUTCOME_UNKNOWN', false);
        attempt.error = { code: safe.code, ...(safe.status ? { status: safe.status } : {}) };
        await persist(run, { attempts });
        await authorize(false);
        throw new IdeaError(502, safe.code);
      }
    }
    throw new IdeaError(503, 'PROVIDER_UNAVAILABLE');
  } catch (error) {
    const code = guardError ?? (error instanceof IdeaError ? error.code : 'AI_JOB_FAILED');
    try { await finish(run, code === 'CANCELED' ? 'canceled' : 'failed', code); }
    catch { /* Lost leases are recovered with their persisted submission marker; no resubmission. */ }
  } finally { clearInterval(timer); stop.removeEventListener('abort', stopped); }
}
export function startAIWorker(providers: Providers = createProviders()) {
  const stop = new AbortController();
  const finished = (async () => {
    while (!stop.signal.aborted) {
      try {
        if (process.env.IDEA_WORKER_ENABLED === 'true') {
          await migrateIdea(true); await repairAIJobs();
          if (process.env.IDEA_AI_ENABLED === 'true') {
            const run = await claimAIJob(); if (run) { await processAIJob(run, providers, stop.signal); continue; }
          }
        }
      } catch { /* Redacted, fail-closed tick. */ }
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); stop.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 2000); timer.unref();
        stop.signal.addEventListener('abort', done, { once: true }); if (stop.signal.aborted) done();
      });
    }
  })();
  return async () => { stop.abort(); await finished; };
}
