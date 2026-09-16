import express, { type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import authAPI from './auth.js';
import { createContentSource, CAPTURE_LIMITS, type ContentSource } from './services/idea/content-source.js';
import { enqueueCapture, getCapture } from './services/idea/capture-service.js';
import { enqueueSourceCheck, getSourceCheck } from './services/idea/source-check-service.js';
import { estimateRun, submitRun, aiEnabled, assertAIEnabled, AI_DISCLOSURE } from './services/idea/ai-run-service.js';
import { remainingBudget } from './services/idea/ai-quota.js';
import { providerConfiguration } from './services/idea/live-provider.js';
import { synthesisCoverage } from './services/idea/synthesis-service.js';
import { reviewEnabled, captureEnabled } from './services/idea/capture-config.js';
import { migrateIdea } from './services/idea/migration-service.js';
import { IdeaError, notFound } from './services/idea/errors.js';
import { resolveActor, requireWrite, type Actor } from './services/idea/permission-service.js';
import { createRecord, readRecord, mutateRecord, listRecords, readySnapshot, authorizedRun } from './services/idea/review-service.js';
import { exportRecord, markdownExport } from './services/idea/export-service.js';
import { IdeaPage, IdeaSourceCheck, IdeaRun, IdeaRevision, type Kind } from '../models/idea-models.js';
import * as input from './validators/idea.js';
import { IDEA_FRAMEWORK, FRAMEWORK_ATTRIBUTION, RUBRIC_NA_TEXT } from '../util/idea/framework.js';
import { IDEA_LIMITS, IDEA_INFERENCE_PROFILE } from '../util/idea/config.js';
export function ideaError(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  res.set('Cache-Control', 'private, no-store');
  const err = error instanceof IdeaError ? error : error instanceof ZodError ? new IdeaError(422, 'INVALID_INPUT', 'Request fields failed validation') :
    (error as { type?: string })?.type === 'entity.too.large' ? new IdeaError(413, 'PAYLOAD_TOO_LARGE') :
    (error as { type?: string })?.type === 'entity.parse.failed' ? new IdeaError(422, 'INVALID_JSON') : new IdeaError(500, 'INTERNAL_ERROR', 'Unable to complete IDEA request', true);
  return res.status(err.status).json({ err: true, code: err.code, errMsg: err.message, retryable: err.retryable });
}
/** Mounted before the global 100 KiB parser; unrelated endpoints retain their limit. */
export const ideaJSONParser = express.json({ limit: '256kb', strict: true });
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env) {
  const values = [env.IDEA_ALLOWED_ORIGINS, env.PRODUCTIONURLS, env.DEVELOPMENTURLS].filter(Boolean).join(',').split(',').map((v) => v.trim()).filter(Boolean);
  return new Set(values.filter((v) => { try { return new URL(v).origin === v; } catch { return false; } }));
}
export function assertOrigin(req: Request, origins: Set<string>) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (!req.headers.origin || !origins.has(req.headers.origin)) throw new IdeaError(403, 'ORIGIN_FORBIDDEN', 'An explicitly configured deployment origin is required');
}
type AsyncHandler = (req: Request, res: Response, actor: Actor) => Promise<unknown>;
export function createIdeaRouter(source: ContentSource = createContentSource()) {
  const router = express.Router({ mergeParams: true });
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store'); res.set('X-Content-Type-Options', 'nosniff');
    // Normalize the existing session verifier's legacy 401 envelope on this router only.
    const send = res.send.bind(res);
    res.send = (body) => send(res.statusCode === 401 && body?.err ? { err: true, code: 'INVALID_SESSION', errMsg: 'Invalid session', retryable: false } : body);
    next();
  });
  router.use(authAPI.verifyRequest);
  router.use((req, res, next) => {
    const decoded = (req as Request & { user?: { decoded?: { uuid?: unknown; sessionId?: unknown } } }).user?.decoded;
    resolveActor(decoded, req.params.projectID).then((actor) => { res.locals.ideaActor = actor; next(); }).catch(next);
  });
  router.use((req, _res, next) => { try { assertOrigin(req, allowedOrigins()); if (!['GET', 'HEAD'].includes(req.method)) input.readInput.omit({ revisionID: true }).parse(req.query); next(); } catch (e) { next(e); } });
  const route = (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res, res.locals.ideaActor)).catch(next); };
  const send = (res: Response, data: unknown, status = 200) => res.status(status).json({ err: false, data });
  router.get('/capabilities', route(async (req, res, actor) => {
    input.readInput.omit({ revisionID: true }).parse(req.query);
    let storageReady = false;
    try { await migrateIdea(true); storageReady = true; } catch { /* Availability only; no raw database errors. */ }
    return send(res, { read: true, storageReady, write: storageReady && reviewEnabled(actor.projectID) && actor.role !== 'auditor', archive: actor.role === 'lead',
      reviewEnabled: reviewEnabled(actor.projectID), aiEnabled: storageReady && aiEnabled(actor.projectID), captureEnabled: storageReady && captureEnabled(actor.projectID), captureLimits: CAPTURE_LIMITS,
      profile: IDEA_INFERENCE_PROFILE, providerAvailability: providerConfiguration(), disclosure: AI_DISCLOSURE, remainingQuota: storageReady ? await remainingBudget(actor) : null, limits: IDEA_LIMITS });
  }));
  router.get('/syntheses/:id/coverage', route(async (req, res, actor) => { const q = input.readInput.parse(req.query); return send(res, await synthesisCoverage(actor, input.uuid.parse(req.params.id), q.revisionID)); }));
  router.get('/framework', route(async (req, res) => {
    input.readInput.omit({ revisionID: true }).parse(req.query);
    return send(res, { categories: IDEA_FRAMEWORK, attribution: FRAMEWORK_ATTRIBUTION, notApplicable: RUBRIC_NA_TEXT });
  }));
  router.get('/runs', route(async (req, res, actor) => {
    const query = input.runListInput.parse(req.query);
    await readRecord(actor, query.headID, query.kind);
    const revisions = await IdeaRevision.find({ headID: query.headID }).select('_id').lean();
    const runs = await IdeaRun.find({ projectID: actor.projectID, 'revisionIDs.0': { $in: revisions.map((r) => r._id) }, ...(query.before ? { $or: [{ createdAt: { $lt: new Date(query.before.split('|')[0]) } }, { createdAt: new Date(query.before.split('|')[0]), _id: { $lt: query.before.split('|')[1] } }] } : {}) })
      .select('_id mode status createdAt revisionIDs ownerUUID').sort({ createdAt: -1, _id: -1 }).limit(26).lean();
    return send(res, { items: runs.slice(0, 25), nextCursor: runs.length > 25 ? `${runs[24].createdAt.toISOString()}|${runs[24]._id}` : null });
  }));
  // Disable new human mutations while preserving authenticated reads and exports.
  router.use((req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    try { requireWrite(_res.locals.ideaActor); } catch (e) { return next(e); }
    if (!reviewEnabled(req.params.projectID)) return next(new IdeaError(503, 'REVIEW_DISABLED'));
    // Never admit saves without the uniqueness indexes their correctness requires.
    migrateIdea(true).then(() => next()).catch(() => next(new IdeaError(503, 'STORAGE_NOT_READY')));
  });
  for (const [plural, kind] of [['reviews', 'review'], ['syntheses', 'synthesis']] as const) {
    router.post(`/${plural}`, route(async (req, res, actor) => {
      requireWrite(actor);
      const body = kind === 'review' ? input.createReviewInput.parse(req.body) : input.createSynthesisInput.parse(req.body);
      return send(res, await createRecord(actor, kind, body), 201);
    }));
    router.get(`/${plural}`, route(async (req, res, actor) => { const q = input.listInput.parse(req.query); return send(res, await listRecords(actor, kind, q.pageSize, q.cursor)); }));
    router.get(`/${plural}/:id`, route(async (req, res, actor) => { const q = input.readInput.parse(req.query); return send(res, await readRecord(actor, input.uuid.parse(req.params.id), kind, q.revisionID)); }));
    router.patch(`/${plural}/:id`, route(async (req, res, actor) => {
      const body = kind === 'review' ? input.patchReviewInput.parse(req.body) : input.patchSynthesisInput.parse(req.body);
      return send(res, await mutateRecord(actor, kind, input.uuid.parse(req.params.id), body));
    }));
    router.post(`/${plural}/:id/transitions`, route(async (req, res, actor) => send(res, await mutateRecord(actor, kind, input.uuid.parse(req.params.id), input.transitionInput.parse(req.body)))));
  }
  router.get('/snapshots/:id/pages/:pageID', route(async (req, res, actor) => {
    input.readInput.omit({ revisionID: true }).parse(req.query);
    const snapshot = await readySnapshot(actor, input.uuid.parse(req.params.id));
    if (![...snapshot.pageIDs, ...snapshot.excludedPageIDs].includes(req.params.pageID)) throw notFound();
    const page = await IdeaPage.findOne({ snapshotID: snapshot._id, pageID: req.params.pageID }).lean();
    if (!page) throw notFound();
    return send(res, page);
  }));
  router.get('/source-checks/:id', route(async (req, res, actor) => {
    input.readInput.omit({ revisionID: true }).parse(req.query);
    return send(res, await getSourceCheck(actor, input.uuid.parse(req.params.id)));
  }));
  router.get('/runs/:id', route(async (req, res, actor) => {
    input.readInput.omit({ revisionID: true }).parse(req.query);
    const run = await authorizedRun(actor, input.uuid.parse(req.params.id));
    return send(res, { id: run._id, ownerUUID: run.ownerUUID, mode: run.mode, status: run.status, phase: run.phase, output: run.status === 'succeeded' ? run.output : null,
      attempts: run.attempts, validation: run.validation, error: run.error, feedback: run.feedback, cancelRequested: run.cancelRequested, profile: run.profile, revisionIDs: run.revisionIDs });
  }));
  router.post('/runs/:id/cancel', route(async (req, res, actor) => {
    const run = await authorizedRun(actor, input.uuid.parse(req.params.id)); requireWrite(actor);
    if (run.ownerUUID !== actor.uuid) throw new IdeaError(403, 'FORBIDDEN');
    input.readInput.omit({ revisionID: true }).parse(req.body);
    if (!['succeeded', 'failed', 'canceled'].includes(run.status)) await IdeaRun.updateOne({ _id: run._id, status: { $in: ['queued', 'running', 'admission'] } }, { $set: { cancelRequested: true, updatedAt: new Date() } });
    const saved = await authorizedRun(actor, run._id);
    return send(res, { id: saved._id, status: saved.status, cancelRequested: saved.cancelRequested });
  }));
  router.post('/runs/:id/feedback', route(async (req, res, actor) => {
    const run = await authorizedRun(actor, input.uuid.parse(req.params.id)); requireWrite(actor);
    if (run.ownerUUID !== actor.uuid) throw new IdeaError(403, 'FORBIDDEN');
    if (run.status !== 'succeeded') throw new IdeaError(409, 'DRAFT_NOT_READY');
    const body = input.feedbackInput.parse(req.body);
    const feedback = { version: body.expectedVersion + 1, disposition: body.disposition, note: body.note };
    const saved = await IdeaRun.findOneAndUpdate({ _id: run._id, ...(body.expectedVersion === 0 ? { feedback: null } : { 'feedback.version': body.expectedVersion }) }, { $set: { feedback } }, { new: true }).lean();
    if (!saved) throw new IdeaError(409, 'VERSION_CONFLICT');
    return send(res, saved.feedback);
  }));
  router.get('/exports/:kind/:id', route(async (req, res, actor) => {
    if (!['review', 'synthesis'].includes(req.params.kind)) throw notFound();
    const q = input.exportInput.parse(req.query); const id = input.uuid.parse(req.params.id);
    const record = await exportRecord(actor, req.params.kind as Kind, id, q.revisionID);
    res.attachment(`idea-${req.params.kind}-${id}-v${record.version}.${q.format}`);
    return res.type(q.format === 'json' ? 'application/json' : 'text/markdown').send(q.format === 'json' ? JSON.stringify(record, null, 2) : markdownExport(record));
  }));
  router.get('/source-tree', route(async (req, res, actor) => {
    const q = input.sourceTreeInput.parse(req.query);
    if (!reviewEnabled(actor.projectID)) throw new IdeaError(503, 'REVIEW_DISABLED');
    return send(res, await source.discover(actor, q.rootID, AbortSignal.timeout(CAPTURE_LIMITS.jobMs)));
  }));
  router.post('/captures', route(async (req, res, actor) => {
    if (!captureEnabled(actor.projectID)) throw new IdeaError(503, 'CAPTURE_DISABLED');
    return send(res, await enqueueCapture(actor, input.captureInput.parse(req.body), source), 202);
  }));
  router.get('/captures/:id', route(async (req, res, actor) => {
    input.readInput.omit({ revisionID: true }).parse(req.query);
    return send(res, await getCapture(actor, input.uuid.parse(req.params.id)));
  }));
  router.post('/source-checks', route(async (req, res, actor) => {
    if (!captureEnabled(actor.projectID)) throw new IdeaError(503, 'CAPTURE_DISABLED');
    return send(res, await enqueueSourceCheck(actor, input.sourceCheckInput.parse(req.body)), 202);
  }));
  router.post('/runs/estimate', route(async (req, res, actor) => { assertAIEnabled(actor.projectID); return send(res, await estimateRun(actor, input.aiEstimateInput.parse(req.body))); }));
  router.post('/runs', route(async (req, res, actor) => { assertAIEnabled(actor.projectID); return send(res, await submitRun(actor, input.aiSubmitInput.parse(req.body)), 202); }));
  router.use((_req, _res, next) => next(notFound()));
  router.use(ideaError);
  return router;
}
export default createIdeaRouter();
