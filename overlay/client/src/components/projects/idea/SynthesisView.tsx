import { useEffect, useMemo, useReducer, useState } from 'react';
import { Link, Prompt, useHistory, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { accessDenied, download, errorText, ideaAPI, type Capabilities, type Framework } from '../../../api/idea';
import type { IdeaSavedRecord, IdeaSynthesis, IdeaSupport } from '../../../types/idea';
import { SynthesisSetup } from './SynthesisSetup';
import { SaveCoordinator } from './saveCoordinator';
import { ReviewSetup, label } from './ReviewSetup';
import { RunControls } from './RunControls';
import { RevisionPlan } from './RevisionPlan';
import { EvidencePreview } from './EvidencePreview';
import { DraftValue } from './CrosswalkDraft';
import { ExportMenu } from './ExportMenu';
import './idea.css';
export interface SynthesisCoverage {
  bookID: string; revisionID: string; assessmentCount: number; chapterCount: number; includedDraftIDs: string[]; limitations: string[];
  inputs: (IdeaSynthesis['inputs'][number] & { chapterTitle: string; capturedPageIDs: string[]; excludedPageIDs: string[]; partial: boolean; changed: boolean; currentVersion: number; currentlyArchived: boolean })[];
}
function SynthesisEditor({ initial, api, framework, capabilities, report }: { initial: IdeaSavedRecord; api: ReturnType<typeof ideaAPI>; framework: Framework; capabilities: Capabilities; report: (e: unknown) => void }) {
  const [, redraw] = useReducer((n) => n + 1, 0);
  const [saver] = useState(() => new SaveCoordinator<IdeaSynthesis>(initial, (v, key, data) => api.saveSynthesis(initial.head._id, v, key, data), redraw));
  const [busy, setBusy] = useState(false), [remote, setRemote] = useState<IdeaSavedRecord | null>(null), [support, setSupport] = useState<IdeaSupport | null>(null), [inspection, setInspection] = useState<IdeaSavedRecord | null>(null), [manualChapter, setManualChapter] = useState('');
  const data = saver.draft, record = saver.saved;
  const writable = Boolean(record.capabilities?.write && capabilities.write && !record.head.archived && data.status === 'draft');
  const coverage = useQuery({ queryKey: ['idea-synthesis-coverage', api.projectID, record.head._id, record.revision._id], queryFn: () => api.get<SynthesisCoverage>(`/syntheses/${record.head._id}/coverage?revisionID=${record.revision._id}`), retry: false, cacheTime: 0, refetchInterval: 15000 });
  useEffect(() => { if (!saver.dirty || saver.error || !writable) return; const timer = setTimeout(() => { void saver.flush().catch(() => {}); }, 750); return () => clearTimeout(timer); });
  useEffect(() => { const before = (e: BeforeUnloadEvent) => { if (saver.dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before); }, [saver]);
  const save = async () => { await saver.flush(); return saver.saved; };
  const action = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { report(e); } finally { setBusy(false); } };
  const transition = (name: string) => action(async () => { const current = await save(); await api.post(`/syntheses/${record.head._id}/transitions`, { expectedVersion: current.head.version, mutationID: crypto.randomUUID(), action: name }); saver.resolve(await api.record(record.head._id, 'synthesis'), false); });
  const edit = (patch: Partial<IdeaSynthesis>) => { if (writable) saver.edit({ ...saver.draft, ...patch }); };
  const chapter = coverage.data?.inputs.find((c) => c.headID === manualChapter) ?? coverage.data?.inputs[0];
  return <><Prompt when={saver.dirty} message="You have unsaved synthesis work. Stay to save or download it; leaving discards local changes." />
    <h2>Multi-chapter synthesis · version {record.head.version}</h2><p>{data.status}{record.head.archived ? ' · archived' : ''} · {writable ? 'Your editable faculty synthesis' : 'Read-only synthesis'}</p>
    <p role="status">{saver.error ? `Save paused: ${errorText(saver.error)}` : saver.dirty ? 'Unsaved changes — autosaving after you pause.' : `Saved version ${record.head.version}`}</p>
    {saver.error != null && <section role="alert"><p>Local work is preserved. Retry a connection failure or compare saved/local versions to resolve a conflict.</p><button disabled={busy} onClick={() => action(async () => { await save(); })}>Retry save</button><button disabled={busy} onClick={() => action(async () => setRemote(await api.record(record.head._id, 'synthesis')))}>Compare saved version</button></section>}
    {remote && <section><h3>Resolve synthesis conflict</h3><div className="idea-compare"><div><h4>Saved v{remote.head.version}</h4><pre>{JSON.stringify(remote.revision.data, null, 2)}</pre></div><div><h4>Your local work</h4><pre>{JSON.stringify(data, null, 2)}</pre></div></div><button disabled={!remote.capabilities?.write || remote.head.archived || remote.revision.data.status !== 'draft'} onClick={() => { saver.resolve(remote, true); setRemote(null); }}>Keep local edits against this version</button><button onClick={() => { saver.resolve(remote, false); setRemote(null); }}>Discard local edits and use saved version</button></section>}
    <div className="idea-actions"><button disabled={!writable || busy || !saver.dirty} onClick={() => action(async () => { await save(); })}>Save now</button><button onClick={() => download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `idea-synthesis-local-${record.head._id}.json`)}>Download local work</button><ExportMenu api={api} save={save} disabled={busy} report={report} />
      {record.capabilities?.write && !record.head.archived && <button disabled={busy || !capabilities.write || (data.status === 'draft' && (!data.summary.trim() || data.draftDisposition === 'not_reviewed' || !data.dispositionRunID))} onClick={() => transition(data.status === 'draft' ? 'finish' : 'reopen')}>{data.status === 'draft' ? 'Finish faculty synthesis' : 'Reopen synthesis'}</button>}
      {record.capabilities?.archive && <button disabled={busy || !capabilities.reviewEnabled} onClick={() => transition(record.head.archived ? 'restore' : 'archive')}>{record.head.archived ? 'Restore synthesis' : 'Archive synthesis'}</button>}
    </div>
    <section><h3>Frozen coverage</h3>{coverage.isError && <p role="alert">Coverage could not be checked. <button onClick={() => coverage.refetch()}>Retry coverage</button></p>}{coverage.data && !accessDenied(coverage.error) && <><p>{coverage.data.assessmentCount} saved assessments across {coverage.data.chapterCount} chapter roots in book {coverage.data.bookID}.</p><ul>{coverage.data.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
      {coverage.data.inputs.map((input) => <fieldset key={input.revisionID}><legend>{input.chapterTitle} · selected v{input.version}</legend><p>Assessor: {input.ownerUUID}. Saved status: <strong>{input.status}</strong>{input.partial ? ' · partial capture' : ''}.</p>{input.changed && <p role="status">A newer review version exists (v{input.currentVersion}). This synthesis still uses v{input.version}.</p>}{input.currentlyArchived && <p>The source assessment is now archived; its selected saved version remains part of this synthesis.</p>}<p>Captured pages: {input.capturedPageIDs.join(', ')}. Excluded: {input.excludedPageIDs.join(', ') || 'none'}.</p>
        <button disabled={busy} onClick={() => action(async () => setInspection(await api.record(input.headID, 'review', input.revisionID)))}>Inspect selected faculty assessment</button><Link to={`/projects/${api.projectID}/idea/${input.headID}`}>Open current chapter review</Link>
        {input.capturedPageIDs.map((pageID) => <button key={pageID} onClick={() => setSupport({ kind: 'scope', snapshotID: input.snapshotID, pageIDs: [pageID], limitation: 'Only this saved captured page is shown.' })}>Inspect captured page {pageID}</button>)}
      </fieldset>)}<p>Explicitly included machine draft IDs: {data.includedDraftIDs.join(', ') || 'none'}.</p><Link to={`/projects/${api.projectID}/idea-syntheses`}>Create another synthesis to select different versions</Link></>}
    </section>
    {inspection && <section><h3>Selected saved assessment · v{inspection.revision.version}</h3><button onClick={() => setInspection(null)}>Close assessment inspection</button><DraftValue value={inspection.revision.data} evidence={setSupport} /></section>}
    {support && <EvidencePreview api={api} support={support} onClose={() => setSupport(null)} />}
    <details><summary>Synthesis context and faculty request</summary><ReviewSetup value={data.context} framework={framework} onChange={(context) => edit({ context })} disabled={!writable} /></details>
    <RunControls api={api} record={record} capabilities={capabilities} framework={framework} flush={save} report={report} evidence={setSupport} onDisposition={(dispositionRunID, draftDisposition) => edit({ dispositionRunID, draftDisposition })} addProposal={(p, originRunID) => { if (saver.draft.proposals.length >= 100) { report(new Error('The plan already contains 100 proposals.')); return; } edit({ proposals: [...saver.draft.proposals, { ...p, id: crypto.randomUUID(), originRunID, disposition: 'proposed' }] }); }} />
    <fieldset disabled={!writable}><legend>Faculty synthesis and judgment</legend><p>AI reruns do not replace this text or your plan. No chapter ratings are averaged.</p><p>Disposition: {label(data.draftDisposition)}{data.dispositionRunID ? ` · run ${data.dispositionRunID}` : ''}. Inspect a completed run and save feedback to record the synthesis disposition.</p><label>Faculty summary (required to finish)<textarea value={data.summary} maxLength={8000} onChange={(e) => edit({ summary: e.target.value })} /></label><label>Faculty suggestions<textarea value={data.suggestions} maxLength={8000} onChange={(e) => edit({ suggestions: e.target.value })} /></label>
      <label>Chapter for a new faculty proposal<select value={chapter?.headID ?? ''} onChange={(e) => setManualChapter(e.target.value)}>{coverage.data?.inputs.map((c) => <option key={c.headID} value={c.headID}>{c.chapterTitle} · v{c.version}</option>)}</select></label>
    </fieldset>
    <RevisionPlan proposals={data.proposals} onChange={(proposals) => edit({ proposals })} disabled={!writable} manualChapter={chapter?.chapterTitle} manualSupport={chapter ? { kind: 'scope', snapshotID: chapter.snapshotID, pageIDs: chapter.capturedPageIDs, limitation: 'Faculty proposal based only on the selected captured chapter scope.' } : undefined} />
  </>;
}
export default function SynthesisView() {
  const { id: projectID, synthesisID } = useParams<{ id: string; synthesisID?: string }>(); const history = useHistory();
  const api = useMemo(() => ideaAPI(projectID), [projectID]); const [error, setError] = useState(''), [creating, setCreating] = useState(false), [cursor, setCursor] = useState<string | null>(null);
  const cap = useQuery({ queryKey: ['idea-capabilities', projectID], queryFn: api.capabilities, retry: false, cacheTime: 0, refetchInterval: 30000 });
  const framework = useQuery({ queryKey: ['idea-framework', projectID], queryFn: api.framework, enabled: !!cap.data, retry: false, cacheTime: 0 });
  const list = useQuery({ queryKey: ['idea-syntheses', projectID, cursor], queryFn: () => api.get<{ items: { id: string; version: number; status: string; archived: boolean; inputs: IdeaSynthesis['inputs'] }[]; nextCursor: string | null }>(`/syntheses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`), enabled: !!cap.data, retry: false, cacheTime: 0 });
  const record = useQuery({ queryKey: ['idea-synthesis', projectID, synthesisID], queryFn: () => api.record(synthesisID!, 'synthesis'), enabled: !!synthesisID && !!cap.data, retry: false, cacheTime: 0, refetchOnWindowFocus: false });
  const report = (e: unknown) => setError(errorText(e));
  return <main className="idea-page"><nav aria-label="Breadcrumb"><Link to={`/projects/${projectID}`}>Project</Link> / <Link to={`/projects/${projectID}/idea`}>Chapter reviews</Link> / <Link to={`/projects/${projectID}/idea-syntheses`}>Syntheses</Link></nav><h1>Multi-chapter IDEA synthesis</h1><p>Compare selected saved assessments, inspect strengths and gaps, and develop a faculty revision plan.</p>{error && <div role="alert"><p>{error}</p><button onClick={() => setError('')}>Dismiss message</button></div>}
    {cap.isLoading && <p role="status">Loading project permissions…</p>}{cap.isError && <p role="alert">Access or connection unavailable. <button onClick={() => cap.refetch()}>Retry access</button></p>}{framework.isError && <button onClick={() => framework.refetch()}>Retry framework</button>}
    {cap.data && !accessDenied(cap.error) && framework.data && <><p className="idea-attribution"><a href={framework.data.attribution.url}>{framework.data.attribution.title}</a> · {framework.data.attribution.author} · <a href={framework.data.attribution.license.url}>{framework.data.attribution.license.name}</a>. Framework reproduced; application guidance adapted.</p>
      {synthesisID ? record.data && !accessDenied(record.error) ? <SynthesisEditor key={`${projectID}:${synthesisID}`} initial={record.data} api={api} framework={framework.data} capabilities={cap.data} report={report} /> : <p role={record.isError ? 'alert' : 'status'}>{record.isError ? 'Unable to open synthesis.' : 'Loading synthesis…'} <button onClick={() => record.refetch()}>Retry</button></p> : <><h2>Saved syntheses</h2><button onClick={() => list.refetch()}>Refresh syntheses</button>{list.isError && <p role="alert">Could not load syntheses.</p>}<ul>{list.data?.items.map((s) => <li key={s.id}><Link to={`/projects/${projectID}/idea-syntheses/${s.id}`}>{s.inputs.length} saved assessments · v{s.version} · {s.status}{s.archived ? ' · archived' : ''} · {s.id.slice(0, 8)}</Link></li>)}</ul>{list.data?.nextCursor && <button onClick={() => setCursor(list.data!.nextCursor)}>More syntheses</button>}{cursor && <button onClick={() => setCursor(null)}>Newest syntheses</button>}
        {cap.data.write && <button onClick={() => setCreating(!creating)}>{creating ? 'Close synthesis setup' : 'Select chapters for synthesis'}</button>}{creating && cap.data.write && <SynthesisSetup api={api} framework={framework.data} report={report} open={(id) => history.push(`/projects/${projectID}/idea-syntheses/${id}`)} />}
      </>}
    </>}
  </main>;
}
