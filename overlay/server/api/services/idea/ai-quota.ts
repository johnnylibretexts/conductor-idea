import { IdeaDailyLimit, type DailyLimit, type Run } from '../../../models/idea-models.js';
import { IdeaError } from './errors.js';
export const AI_BUDGET = Object.freeze({ reservationMicroUSD: 36416, inputTokens: 48512, completionTokens: 16192, pricingVersion: 'openai-luna-2026-09-13', queuedPerUser: 3 });
const scopes = (run: Pick<Run, 'ownerUUID' | 'projectID'>) => [
  { scope: `actor:${run.ownerUUID}`, count: 20, money: 2000000 },
  { scope: `project:${run.projectID}`, count: 100, money: 10000000 },
  { scope: 'deployment', count: 10000, money: 25000000 },
];
async function change(scope: string, day: string, fn: (doc: DailyLimit) => void) {
  const id = `${scope}:${day}`;
  try { await IdeaDailyLimit.updateOne({ _id: id }, { $setOnInsert: { scope, day, reservations: [], consumedCount: 0, spentMicroUSD: 0, version: 0, paused: false } }, { upsert: true }); }
  catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  for (let retry = 0; retry < 100; retry++) {
    const doc = await IdeaDailyLimit.findById(id).lean(); if (!doc) throw new IdeaError(503, 'QUOTA_UNAVAILABLE');
    const version = doc.version; fn(doc);
    const updated = await IdeaDailyLimit.updateOne({ _id: id, version }, { $set: { reservations: doc.reservations, spentMicroUSD: doc.spentMicroUSD, consumedCount: doc.consumedCount, paused: doc.paused }, $inc: { version: 1 } });
    if (updated.modifiedCount) return;
  }
  throw new IdeaError(503, 'QUOTA_BUSY');
}
export async function assertBudgetOpen() {
  if ((await IdeaDailyLimit.findById('control:all').lean())?.paused) throw new IdeaError(503, 'AI_SPENDING_PAUSED');
}
export async function reserveBudget(run: Run) {
  await assertBudgetOpen();
  for (const limit of scopes(run)) await change(limit.scope, run.day!, (doc) => {
    const prior = doc.reservations.find((r) => r.id === run._id);
    if (prior?.settled) throw new IdeaError(409, 'ADMISSION_EXPIRED');
    if (prior) return;
    const active = doc.reservations.filter((r) => !r.settled);
    if (limit.scope.startsWith('actor:') && active.filter((r) => r.queued).length >= 3) throw new IdeaError(429, 'AI_QUEUE_LIMIT');
    if (doc.consumedCount + active.filter((r) => !r.consumed).length >= limit.count ||
      doc.spentMicroUSD + active.reduce((sum, r) => sum + r.amount, 0) + AI_BUDGET.reservationMicroUSD > limit.money) throw new IdeaError(429, 'AI_DAILY_LIMIT');
    doc.reservations.push({ id: run._id, amount: AI_BUDGET.reservationMicroUSD, queued: true, consumed: false, settled: false });
  });
}
export async function consumeBudget(run: Run) {
  await assertBudgetOpen();
  for (const limit of scopes(run)) await change(limit.scope, run.day!, (doc) => {
    const r = doc.reservations.find((r) => r.id === run._id);
    if (!r || r.settled) throw new IdeaError(409, 'RESERVATION_MISSING');
    if (!r.consumed) { r.consumed = true; doc.consumedCount++; }
    r.queued = false;
  });
}
/** Completion counts already include reasoning; never add reasoning_tokens a second time. */
export function lunaCost(usage: { inputTokens?: number; outputTokens?: number }) {
  return usage.inputTokens === undefined || usage.outputTokens === undefined ? AI_BUDGET.reservationMicroUSD : Math.ceil(usage.inputTokens * 0.2 + usage.outputTokens * 1.2);
}
export async function settleBudget(run: Run) {
  const attempts = run.attempts as any[];
  const submitted = attempts.some((a) => a.submissionStarted);
  const luna = attempts.find((a) => a.provider === 'openai' && a.submissionStarted);
  const amount = luna ? lunaCost(luna.usage ?? {}) : 0;
  if (amount > AI_BUDGET.reservationMicroUSD || (luna?.usage?.inputTokens ?? 0) > AI_BUDGET.inputTokens || (luna?.usage?.outputTokens ?? 0) > AI_BUDGET.completionTokens)
    await change('control', 'all', (doc) => { doc.paused = true; });
  for (const limit of scopes(run)) await change(limit.scope, run.day!, (doc) => {
    let r = doc.reservations.find((r) => r.id === run._id);
    if (!r) { r = { id: run._id, consumed: false, settled: false, queued: false, amount: 0 }; doc.reservations.push(r); }
    if (r.settled) return;
    if (submitted && !r.consumed) doc.consumedCount++;
    if (!submitted && r.consumed) doc.consumedCount--;
    if (!submitted) { r.consumed = false; r.settled = true; r.queued = false; r.amount = 0; return; }
    r.consumed = true; r.queued = false; r.settled = true; r.amount = amount; doc.spentMicroUSD += amount;
  });
}
export async function remainingBudget(actor: { uuid: string; projectID: string }) {
  const day = new Date().toISOString().slice(0, 10);
  return Promise.all(scopes({ ownerUUID: actor.uuid, projectID: actor.projectID }).map(async (limit) => {
    const doc = await IdeaDailyLimit.findById(`${limit.scope}:${day}`).lean();
    const pending = doc?.reservations.filter((r) => !r.settled) ?? [];
    return { scope: limit.scope.split(':')[0], day, remainingRuns: Math.max(0, limit.count - (doc?.consumedCount ?? 0) - pending.filter((r) => !r.consumed).length), remainingMicroUSD: Math.max(0, limit.money - (doc?.spentMicroUSD ?? 0) - pending.reduce((s, r) => s + r.amount, 0)) };
  }));
}
