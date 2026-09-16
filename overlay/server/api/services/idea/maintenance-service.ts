import { IdeaHead, IdeaRevision, IdeaRun, IdeaPage, IdeaSnapshot, IdeaSourceJob, type Head, type Revision, type Page } from '../../../models/idea-models.js';
import { IdeaError } from './errors.js';
/** Only unreachable revision candidates are collected here. Evidence is never TTL'd. */
export async function maintainIdea(apply = false, now = new Date()) {
  const cutoff = new Date(now.getTime() - 7 * 86400_000);
  const report = { apply, unreachableCandidates: [] as string[], removed: [] as string[], corruptHeads: [] as string[], unusedPageCandidates: [] as string[], removedPageCandidates: [] as string[] };
  for await (const original of IdeaHead.find().lean().cursor()) {
    // Fence every outstanding CAS before traversal/deletion. A retry retains its old epoch.
    const head: Head | null = apply ? await IdeaHead.findOneAndUpdate({ _id: original._id, epoch: original.epoch }, { $inc: { epoch: 1 } }, { new: true }).lean() : original;
    if (!head) continue;
    const reachable = new Set<string>(); let cursor = head.currentRevisionID; let corrupt = false;
    while (cursor) {
      if (reachable.has(cursor)) { corrupt = true; break; }
      reachable.add(cursor);
      const revision = await IdeaRevision.findOne({ _id: cursor, headID: head._id }).lean();
      if (!revision) { corrupt = true; break; }
      cursor = revision.parentRevisionID;
    }
    if (corrupt) { report.corruptHeads.push(head._id); continue; }
    const candidates = await IdeaRevision.find({ headID: head._id, createdAt: { $lt: cutoff }, discarded: { $ne: true }, _id: { $nin: [...reachable] }, ...(apply && { epoch: { $lt: head.epoch } }) }).lean();
    for (const candidate of candidates) {
      // Conservatively preserve any job reference, including terminal provenance.
      if (await IdeaRun.exists({ revisionIDs: candidate._id })) continue;
      report.unreachableCandidates.push(candidate._id);
      if (apply) {
        // Retain mutation identity so this failed save can never create another candidate.
        await IdeaRevision.db.collection<Revision>(IdeaRevision.collection.name).updateOne({ _id: candidate._id, epoch: candidate.epoch }, { $set: { discarded: true }, $unset: { data: '' } });
        report.removed.push(candidate._id);
      }
    }
  }
  for await (const page of IdeaPage.find({ createdAt: { $lt: cutoff } }).lean().cursor()) {
    // Keep committed evidence and every page that a live/finalizing job can reference.
    if (await IdeaSnapshot.exists({ _id: page.snapshotID })) continue;
    if (await IdeaSourceJob.exists({ $or: [{ _id: page.snapshotID }, { leaseToken: page.snapshotID }, { 'results.pageRecordID': page._id }], state: { $in: ['queued', 'running', 'finalizing'] } })) continue;
    report.unusedPageCandidates.push(page._id);
    if (apply) { await IdeaPage.db.collection<Page>(IdeaPage.collection.name).deleteOne({ _id: page._id }); report.removedPageCandidates.push(page._id); }
  }
  if (report.corruptHeads.length && apply) throw new IdeaError(500, 'REVISION_CHAIN_CORRUPT', 'Corrupt heads were preserved; run maintenance without --apply for the report');
  return report;
}
