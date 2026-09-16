import { IdeaSourceJob, IdeaSourceCheck } from '../../../models/idea-models.js';
import { readySnapshot } from './review-service.js';
import { publicJob } from './capture-service.js';
import { notFound } from './errors.js';
import type { Actor } from './permission-service.js';
export { enqueueSourceCheck } from './capture-service.js';
export async function getSourceCheck(actor: Actor, id: string) {
  const job = await IdeaSourceJob.findOne({ _id: id, projectID: actor.projectID, kind: 'check' }).lean();
  if (!job || !job.inputSnapshotID) throw notFound();
  await readySnapshot(actor, job.inputSnapshotID);
  const check = await IdeaSourceCheck.findOne({ _id: id, projectID: actor.projectID }).lean();
  return { ...publicJob(job), checkedAt: check?.checkedAt || null, result: job.state === 'succeeded' ? check?.result || null : null };
}
