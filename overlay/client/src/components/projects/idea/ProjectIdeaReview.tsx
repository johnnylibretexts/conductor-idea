import { useEffect, useMemo, useReducer, useState } from 'react';
import { Link, Prompt, useHistory, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ideaAPI, errorText, accessDenied, download, type Framework, type Capabilities, type Capture } from '../../../api/idea';
import type { IdeaSavedRecord, IdeaReview, IdeaSupport, RevisionProposal } from '../../../types/idea';
import { CaptureStatus } from './CaptureStatus';
import { ReviewSetup } from './ReviewSetup';
import { RubricForm } from './RubricForm';
import { RevisionPlan } from './RevisionPlan';
import { RunControls } from './RunControls';
import { EvidencePreview } from './EvidencePreview';
import { DraftValue } from './CrosswalkDraft';
import { SaveCoordinator } from './saveCoordinator';
import './idea.css';
function ChapterEditor({ api, initial, capabilities, framework, report }: { api: ReturnType<typeof ideaAPI>; initial: IdeaSavedRecord; capabilities: Capabilities; framework: Framework; report: (e: unknown) => void }) {
  const [, redraw] = useReducer((n) => n + 1, 0);
  const [saver] = useState(() => new SaveCoordinator(initial, (version, mutationID, data) => api.save(initial.head._id, version, mutationID, data), redraw));
  const [remote, setRemote] = useState<IdeaSavedRecord | null>(null), [support, setSupport] = useState<IdeaSupport | null>(null), [busy, setBusy] = useState(false), [checkID, setCheckID] = useState<string | null>(null);
  const record = saver.saved, review = saver.draft;
  const writable = Boolean(record.capabilities?.write && capabilities.write && !record.head.archived && review.status === 'draft');
  const snapshot = useQuery({ queryKey: ['idea-snapshot-capture', api.projectID, record.revision.snapshotIDs[0]], queryFn: () => api.capture(record.revision.snapshotIDs[0]), retry: false, cacheTime: 0 });
  const check = useQuery({ queryKey: ['idea-source-check', api.projectID, checkID], queryFn: () => api.get<Capture & { result: unknown }>(`/source-checks/${checkID}`), enabled: !!checkID, retry: false, cacheTime: 0, refetchInterval: (data) => data && ['succeeded', 'failed'].includes(data.state) ? false : 1500 });
  useEffect(() => { if (!saver.dirty || saver.error || !writable) return; const timer = setTimeout(() => { void saver.flush().catch(() => {}); }, 750); return () => clearTimeout(timer); });
  useEffect(() => { const before = (e: BeforeUnloadEvent) => { if (saver.dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before); }, [saver]);
  const edit = (data: IdeaReview) => { if (writable) saver.edit(data); };
  const flush = async () => { await saver.flush(); return saver.saved; };
  const action = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { report(e); } finally { setBusy(false); } };
  const transition = (actionName: string) => action(async () => { const saved = await flush(); await api.post(`/reviews/${saved.head._id}/transitions`, { expectedVersion: saved.head.version, mutationID: crypto.randomUUID(), action: actionName }); saver.resolve(await api.record(saved.head._id), false); });
  const addProposal = (p: RevisionProposal, id: string) => { if (review.proposals.length >= 100) { report(new Error('The plan already contains 100 proposals.')); return; } edit({ ...review, proposals: [...review.proposals, { ...p, id: crypto.randomUUID(), originRunID: id, disposition: 'proposed' }] }); };
  return <><Prompt when={saver.dirty} message="You have unsaved IDEA work. Stay to save or download it; leaving discards these local changes." />
    <h2>Chapter review · version {record.head.version}</h2><p>{snapshot.data?.manifest?.selected?.map((p) => p.title).join(' · ')}</p><p>Status: {review.status}{record.head.archived ? ' · archived' : ''}. {writable ? 'You can edit this assessment.' : 'Read-only assessment.'}</p>
    <p role="status" aria-live="polite">{saver.error ? `Save paused: ${errorText(saver.error)}` : saver.dirty ? 'Unsaved changes — saving after you pause typing.' : `Saved version ${record.head.version}`}</p>
    {saver.error != null && <section role="alert"><p>Your unsaved text is preserved here. Retry a connection failure or compare versions before resolving a conflict.</p><button disabled={busy} onClick={() => action(async () => { await saver.flush(); })}>Retry save</button><button disabled={busy} onClick={() => action(async () => { setRemote(await api.record(record.head._id)); })}>Compare with saved version</button></section>}
    {remote && <section><h3>Resolve changed saved version</h3><p>Review the saved and local text. Keeping local work explicitly replaces editable fields in the newer version.</p><div className="idea-compare"><div><h4>Saved version {remote.head.version}</h4><pre>{JSON.stringify(remote.revision.data, null, 2)}</pre></div><div><h4>Your local work</h4><pre>{JSON.stringify(review, null, 2)}</pre></div></div><button disabled={!remote.capabilities?.write || remote.head.archived || remote.revision.data.status !== 'draft'} onClick={() => { saver.resolve(remote, true); setRemote(null); }}>Keep my local work against this version</button><button onClick={() => { saver.resolve(remote, false); setRemote(null); }}>Discard local edits and use saved version</button></section>}
    <div className="idea-actions"><button disabled={!writable || busy || !saver.dirty} onClick={() => action(async () => { await flush(); })}>Save now</button>
      <button onClick={() => download(new Blob([JSON.stringify(review, null, 2)], { type: 'application/json' }), `idea-local-work-${record.head._id}.json`)}>Download local work</button>
      {(['json', 'md'] as const).map((format) => <button key={format} disabled={busy} onClick={() => action(async () => { const saved = await flush(); download(await api.export(saved.head._id, saved.revision._id, format), `idea-review-v${saved.head.version}.${format}`); })}>Export saved {format.toUpperCase()}</button>)}
      {record.capabilities?.write && !record.head.archived && <button disabled={busy || !capabilities.write || (review.status === 'draft' && review.answers.some((a) => a.rating === 'not_rated' || (a.rating === 'not_applicable' && !a.naRationale.trim())))} onClick={() => transition(review.status === 'draft' ? 'finish' : 'reopen')}>{review.status === 'draft' ? 'Finish faculty assessment' : 'Reopen assessment'}</button>}
      {record.capabilities?.archive && <button disabled={busy || !capabilities.reviewEnabled} onClick={() => transition(record.head.archived ? 'restore' : 'archive')}>{record.head.archived ? 'Restore assessment' : 'Archive assessment'}</button>}
    </div>
    <section><h3>Captured scope</h3><p>Snapshot {record.revision.snapshotIDs[0]}. {snapshot.data?.captureState === 'partial' ? 'Partial capture acknowledged when this review was created.' : ''}</p>{snapshot.data?.manifest?.selected?.filter((p) => snapshot.data?.manifest?.pages?.some((item) => item.pageID === p.pageID && item.state === 'captured')).map((p) => <button key={p.pageID} onClick={() => setSupport({ kind: 'scope', snapshotID: record.revision.snapshotIDs[0], pageIDs: [p.pageID], limitation: 'This is the immutable captured page, not a fresh source read.' })}>Read captured {p.title}</button>)}<p>Excluded pages: {snapshot.data?.excludedPageIDs.join(', ') || 'See capture manifest; unavailable while loading.'}</p>
      <button disabled={busy || !capabilities.captureEnabled || !capabilities.write} onClick={() => action(async () => { const result = await api.post<Capture>('/source-checks', { snapshotID: record.revision.snapshotIDs[0], idempotencyKey: crypto.randomUUID() }); setCheckID(result.jobID); })}>Check whether source changed</button>
      {check.data && <><p role="status">Source check: {check.data.state}</p>{check.data.result != null && <DraftValue value={check.data.result} evidence={setSupport} />}</>}{check.isError && <button onClick={() => check.refetch()}>Retry source check status</button>}
    </section>
    {support && <EvidencePreview api={api} support={support} onClose={() => setSupport(null)} />}
    <details><summary>Saved review context</summary><ReviewSetup value={review.context} onChange={(context) => edit({ ...review, context })} framework={framework} disabled={!writable} /></details>
    <RunControls api={api} record={record} capabilities={capabilities} framework={framework} flush={flush} report={report} evidence={setSupport} addProposal={addProposal} />
    <RubricForm value={review} onChange={edit} framework={framework} disabled={!writable} />
    <RevisionPlan manualSupport={snapshot.data?.manifest?.pages?.some((p) => p.state === 'captured') ? { kind: 'scope', snapshotID: record.revision.snapshotIDs[0], pageIDs: snapshot.data.manifest.pages.filter((p) => p.state === 'captured').map((p) => p.pageID), limitation: 'Faculty proposal based on the listed captured pages; excluded content was not assessed.' } : undefined} proposals={review.proposals} onChange={(proposals) => edit({ ...review, proposals })} disabled={!writable} />
  </>;
}
export default function ProjectIdeaReview() {
  const { id: projectID, reviewID } = useParams<{ id: string; reviewID?: string }>(); const history = useHistory(); const location = useLocation();
  const api = useMemo(() => ideaAPI(projectID), [projectID]);
  const [error, setError] = useState(''), [creating, setCreating] = useState(new URLSearchParams(location.search).has('capture')), [cursor, setCursor] = useState<string | null>(null);
  const capabilities = useQuery({ queryKey: ['idea-capabilities', projectID], queryFn: api.capabilities, retry: false, cacheTime: 0, refetchInterval: 30000 });
  const framework = useQuery({ queryKey: ['idea-framework', projectID], queryFn: api.framework, enabled: !!capabilities.data, retry: false, cacheTime: 0 });
  const reviews = useQuery({ queryKey: ['idea-reviews', projectID, cursor], queryFn: () => api.reviews(cursor ?? undefined), enabled: !!capabilities.data, retry: false, cacheTime: 0 });
  const record = useQuery({ queryKey: ['idea-review', projectID, reviewID], queryFn: () => api.record(reviewID!), enabled: !!reviewID && !!capabilities.data, retry: false, cacheTime: 0, refetchOnWindowFocus: false });
  const report = (e: unknown) => setError(errorText(e));
  return <main className="idea-page"><nav aria-label="Breadcrumb"><Link to={`/projects/${projectID}`}>Project</Link> / <Link to={`/projects/${projectID}/idea`}>IDEA chapter reviews</Link></nav><h1>IDEA chapter review</h1><p>Apply the OERI AI Crosswalk, examine captured evidence, and record your own assessment and revision plan.</p>
    {error && <div role="alert"><p>{error}</p><button onClick={() => setError('')}>Dismiss message</button></div>}
    {capabilities.isLoading && <p role="status">Loading project permissions…</p>}{capabilities.isError && <p role="alert">IDEA is private to project members. Your session may have expired or access may be unavailable. <button onClick={() => capabilities.refetch()}>Retry access</button></p>}
    {framework.isError && <button onClick={() => framework.refetch()}>Retry framework</button>}
    {capabilities.data && !accessDenied(capabilities.error) && framework.data && <>
      <p className="idea-attribution"><a href={framework.data.attribution.url}>{framework.data.attribution.title}</a> · {framework.data.attribution.author} · <a href={framework.data.attribution.license.url}>{framework.data.attribution.license.name}</a>. Framework text reproduced; application guidance adapted. AI outputs require faculty review.</p>
      {!capabilities.data.reviewEnabled && <p>New IDEA work is disabled for this project. Saved reviews and exports remain available.</p>}
      {reviewID ? record.data ? <ChapterEditor key={`${projectID}:${reviewID}`} api={api} initial={record.data} capabilities={capabilities.data} framework={framework.data} report={report} /> : <p role={record.isError ? 'alert' : 'status'}>{record.isError ? 'Unable to open this review.' : 'Loading review…'} <button onClick={() => record.refetch()}>Retry</button></p> : <>
        <p><Link to={`/projects/${projectID}/idea-syntheses`}>Compare chapters in a synthesis</Link></p><h2>Saved chapter reviews</h2><button onClick={() => reviews.refetch()}>Refresh reviews</button>{reviews.isError && <p role="alert">Could not load reviews.</p>}<ul>{reviews.data?.items.map((r) => <li key={r.id}><Link to={`/projects/${projectID}/idea/${r.id}`}>{r.chapterTitle || `Review ${r.id.slice(0, 8)}`} · version {r.version} · {r.status}{r.archived ? ' · archived' : ''}{r.capabilities.write ? ' · yours' : ''}</Link></li>)}</ul>{reviews.data?.nextCursor && <button onClick={() => setCursor(reviews.data!.nextCursor)}>More reviews</button>}{cursor && <button onClick={() => setCursor(null)}>Newest reviews</button>}
        {capabilities.data.write && <button onClick={() => setCreating(!creating)}>{creating ? 'Close setup' : 'Start chapter review'}</button>}
        {creating && <CaptureStatus api={api} framework={framework.data} capabilities={capabilities.data} report={report} open={(id) => history.push(`/projects/${projectID}/idea/${id}`)} />}
      </>}
    </>}
  </main>;
}
