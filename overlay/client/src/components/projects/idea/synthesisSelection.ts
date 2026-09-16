import type { ReviewItem } from '../../../api/idea';
export function selectionValid(reviews: ReviewItem[]) { return reviews.length >= 2 && reviews.length <= 10 && new Set(reviews.map((r) => r.id)).size === reviews.length; }
export function draftMatchesSelection(run: { status: string; mode: string; revisionIDs: string[] }, review: ReviewItem) {
  return run.status === 'succeeded' && run.mode !== 'synthesis' && run.revisionIDs.length === 1 && run.revisionIDs[0] === review.revisionID;
}
export function removeSelection(reviews: ReviewItem[], drafts: { id: string; reviewID: string }[], id: string) {
  return { reviews: reviews.filter((r) => r.id !== id), drafts: drafts.filter((r) => r.reviewID !== id) };
}
