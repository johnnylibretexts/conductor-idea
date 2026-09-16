import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ideaAPI, Framework, ReviewItem } from '../../../api/idea';
import type { IdeaSavedRecord } from '../../../types/idea';
import { ReviewSetup, initialContext } from './ReviewSetup';
import { draftMatchesSelection, removeSelection, selectionValid } from './synthesisSelection';
function DraftSelection({ api, review, selected, change }: { api: ReturnType<typeof ideaAPI>; review: ReviewItem; selected: string[]; change: (id: string, checked: boolean) => void }) {
  const [before, setBefore] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['idea-synthesis-candidates', api.projectID, review.id, before], queryFn: () => api.get<{ items: { _id: string; mode: string; status: string; revisionIDs: string[] }[]; nextCursor: string | null }>(`/runs?headID=${review.id}${before ? `&before=${encodeURIComponent(before)}` : ''}`), retry: false, cacheTime: 0 });
  const eligible = query.data?.items.filter((r) => draftMatchesSelection(r, review)) ?? [];
  return <fieldset><legend>Optional AI inputs for {review.chapterTitle || review.id} · v{review.version}</legend><p>Nothing is included automatically. Only successful drafts from this exact saved review version are eligible.</p>
    {query.isLoading && <p role="status">Loading candidate drafts…</p>}{query.isError && <button onClick={() => query.refetch()}>Retry draft list</button>}{!query.isLoading && !eligible.length && <p>No eligible drafts on this page.</p>}
    {eligible.map((r) => <label className="idea-check" key={r._id}><input type="checkbox" disabled={!selected.includes(r._id) && selected.length >= 10} checked={selected.includes(r._id)} onChange={(e) => change(r._id, e.target.checked)} />Include AI {r.mode} draft · {r._id}</label>)}
    {query.data?.nextCursor && <button onClick={() => setBefore(query.data!.nextCursor)}>Older draft candidates</button>}{before && <button onClick={() => setBefore(null)}>Newest draft candidates</button>}
  </fieldset>;
}
export function SynthesisSetup({ api, framework, open, report }: { api: ReturnType<typeof ideaAPI>; framework: Framework; open: (id: string) => void; report: (e: unknown) => void }) {
  const [cursor, setCursor] = useState<string | null>(null), [reviews, setReviews] = useState<ReviewItem[]>([]), [drafts, setDrafts] = useState<{ id: string; reviewID: string }[]>([]), [context, setContext] = useState(initialContext), [ack, setAck] = useState(false), [busy, setBusy] = useState(false);
  const query = useQuery({ queryKey: ['idea-synthesis-review-choices', api.projectID, cursor], queryFn: () => api.reviews(cursor ?? undefined), retry: false, cacheTime: 0 });
  const remove = (id: string) => { const next = removeSelection(reviews, drafts, id); setReviews(next.reviews); setDrafts(next.drafts); setAck(false); };
  return <section><h2>Choose saved assessments</h2><p>Select 2–10 reviews from this project and book. Each selected version stays fixed even if its author later edits the chapter review. Unfinished inputs remain visibly unfinished. Refreshing available reviews never replaces your selected version; remove and reselect to change it.</p>
    <fieldset disabled={busy}><legend>Available chapter reviews</legend>{query.isLoading && <p role="status">Loading reviews…</p>}{query.isError && <button onClick={() => query.refetch()}>Retry reviews</button>}{query.data?.items.map((r) => <label className="idea-check" key={r.id}><input type="checkbox" checked={reviews.some((s) => s.id === r.id)} disabled={!reviews.some((s) => s.id === r.id) && (reviews.length >= 10 || r.archived)} onChange={(e) => { if (e.target.checked) setReviews([...reviews, r]); else remove(r.id); setAck(false); }} />{r.chapterTitle || r.id} · assessor {r.ownerUUID || "see saved assessment"} · version {r.version} · {r.status}{r.archived ? ' · archived (open a saved synthesis to inspect its older inputs)' : ''}</label>)}
      {query.data?.nextCursor && <button onClick={() => setCursor(query.data!.nextCursor)}>More reviews</button>}{cursor && <button onClick={() => setCursor(null)}>Newest reviews</button>}<button onClick={() => query.refetch()}>Refresh available versions</button>
    </fieldset>
    <h3>Frozen selection · {reviews.length} assessments</h3><ul>{reviews.map((r) => <li key={r.id}>{r.chapterTitle || r.id} · assessor {r.ownerUUID || "see saved assessment"} · v{r.version} · {r.status} · {r.revisionID} <button disabled={busy} onClick={() => remove(r.id)}>Remove this assessment</button></li>)}</ul>
    <fieldset disabled={busy}><legend>Optional machine drafts · {drafts.length}/10 selected</legend>{reviews.map((r) => <DraftSelection key={r.id} api={api} review={r} selected={drafts.map((d) => d.id)} change={(id, checked) => { setDrafts(checked ? [...drafts, { id, reviewID: r.id }] : drafts.filter((d) => d.id !== id)); setAck(false); }} />)}</fieldset>
    <ReviewSetup framework={framework} value={context} onChange={setContext} disabled={busy} />
    <label className="idea-check"><input type="checkbox" disabled={busy} checked={ack} onChange={(e) => setAck(e.target.checked)} />I understand the selection includes the saved faculty notes and any unfinished judgments, plus only the AI drafts I explicitly selected. It is not whole-book completion or faculty consensus.</label>
    <button disabled={busy || !selectionValid(reviews) || !context.discipline.trim() || !context.focus.length || !ack} onClick={async () => { setBusy(true); try { const result = await api.post<IdeaSavedRecord>('/syntheses', { reviewRevisionIDs: reviews.map((r) => r.revisionID), includedDraftIDs: drafts.map((d) => d.id), context, idempotencyKey: crypto.randomUUID() }); open(result.head._id); } catch (e) { report(e); } finally { setBusy(false); } }}>Create synthesis with these saved versions</button>
  </section>;
}
