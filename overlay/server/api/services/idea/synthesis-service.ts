import { readRecord, selectedReview, readySnapshot } from './review-service.js';
import type { Actor } from './permission-service.js';
import { IdeaError } from './errors.js';
export async function synthesisCoverage(actor: Actor, id: string, revisionID?: string) {
  const { head, revision } = await readRecord(actor, id, 'synthesis', revisionID);
  if (!('inputs' in revision.data)) throw new IdeaError(422, 'NOT_SYNTHESIS');
  const inputs = [];
  for (const selected of revision.data.inputs) {
    const review = await selectedReview(actor, selected.revisionID, head.bookID);
    const snapshot = await readySnapshot(actor, selected.snapshotID, head.bookID);
    inputs.push({ ...selected, chapterTitle: snapshot.chapterTitle, chapterRootID: snapshot.chapterRootID,
      capturedPageIDs: snapshot.pageIDs, excludedPageIDs: snapshot.excludedPageIDs, partial: snapshot.state === 'partial',
      currentVersion: review.head.version, currentRevisionID: review.head.currentRevisionID,
      changed: review.head.currentRevisionID !== selected.revisionID, currentlyArchived: review.head.archived });
  }
  return { revisionID: revision._id, bookID: head.bookID, inputs,
    assessmentCount: inputs.length, chapterCount: new Set(inputs.map((i) => i.chapterRootID)).size,
    includedDraftIDs: revision.data.includedDraftIDs,
    limitations: ['Only the selected saved assessment versions and captured pages are included.', 'Unfinished assessments remain unfinished inputs; synthesis is not faculty consensus.', 'Newer chapter reviews do not replace these frozen inputs. Create a new synthesis to change the selection.', 'This is not a whole-book completion claim or an average of ratings.'] };
}
