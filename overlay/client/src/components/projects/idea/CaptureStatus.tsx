import { useHistory, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ideaAPI, Framework, Capabilities, Capture } from '../../../api/idea';
import type { IdeaSavedRecord } from '../../../types/idea';
import { initialContext, ReviewSetup } from './ReviewSetup';
export function CaptureStatus({ api, framework, capabilities, open, report }: { api: ReturnType<typeof ideaAPI>; framework: Framework; capabilities: Capabilities; open: (id: string) => void; report: (e: unknown) => void }) {
  const history = useHistory(), location = useLocation();
  const [discover, setDiscover] = useState(false), [root, setRoot] = useState(''), [selected, setSelected] = useState<string[]>([]), [supplements, setSupplements] = useState<string[]>([]);
  const [context, setContext] = useState(initialContext), [familiar, setFamiliar] = useState(false), [partial, setPartial] = useState(false), [busy, setBusy] = useState(false);
  const [job, setJob] = useState<string | null>(new URLSearchParams(location.search).get('capture'));
  const tree = useQuery({ queryKey: ['idea-tree', api.projectID], queryFn: api.tree, enabled: discover, retry: false, cacheTime: 0 });
  const capture = useQuery({ queryKey: ['idea-capture', api.projectID, job], queryFn: () => api.capture(job!), enabled: !!job, retry: false, cacheTime: 0, refetchInterval: (data) => data && ['succeeded', 'failed'].includes(data.state) ? false : 1500 });
  const action = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { report(e); } finally { setBusy(false); } };
  return <section><h2>Start with a familiar chapter</h2><p>Capture only the pages you intend to review. Excluded pages and unavailable media remain outside the AI’s evidence.</p>
    <ReviewSetup value={context} onChange={setContext} framework={framework} disabled={busy} />
    <label className="idea-check"><input type="checkbox" checked={familiar} onChange={(e) => setFamiliar(e.target.checked)} />I am familiar with this chapter and will check AI interpretations against its context.</label>
    {!job && <><button disabled={!capabilities.captureEnabled || !capabilities.write} onClick={() => setDiscover(true)}>Discover public chapter pages</button>{!capabilities.captureEnabled && <p>Public capture is currently unavailable. Existing reviews remain readable.</p>}
      {tree.isFetching && <p role="status">Discovering public pages…</p>}{tree.isError && <p role="alert">Discovery failed. Public metadata access may be unavailable. <button onClick={() => tree.refetch()}>Retry discovery</button></p>}
      {tree.data && <><label>Chapter root<select value={root} onChange={(e) => { setRoot(e.target.value); setSelected([e.target.value]); setSupplements([]); }}><option value="">Choose a chapter</option>{tree.data.nodes.map((n) => <option key={n.pageID} value={n.pageID}>{n.title} · {n.pageID}</option>)}</select></label>
        {root && <fieldset><legend>Captured pages (up to 25, including up to 5 supplements)</legend>{tree.data.nodes.map((n) => <div key={n.pageID}><label className="idea-check"><input type="checkbox" checked={selected.includes(n.pageID)} disabled={!selected.includes(n.pageID) && selected.length >= 25} onChange={(e) => { setSelected(e.target.checked ? [...selected, n.pageID] : selected.filter((id) => id !== n.pageID)); setSupplements(supplements.filter((id) => id !== n.pageID)); }} />{n.title} <a href={n.url} target="_blank" rel="noreferrer">Read source</a></label>{selected.includes(n.pageID) && n.pageID !== root && <label className="idea-check"><input type="checkbox" checked={supplements.includes(n.pageID)} disabled={!supplements.includes(n.pageID) && supplements.length >= 5} onChange={(e) => setSupplements(e.target.checked ? [...supplements, n.pageID] : supplements.filter((id) => id !== n.pageID))} />Treat as a supplement outside this chapter</label>}</div>)}</fieldset>}
        <p>Selected {selected.length} pages. Unselected chapter pages will be explicitly excluded.</p>{tree.data.unsupportedBranches && <p>The tree contains unsupported branches. Capture will record this limitation.</p>}
        <button disabled={busy || !root || !selected.length || !familiar || !context.discipline.trim() || !context.focus.length || !capabilities.write} onClick={() => action(async () => { const result = await api.post<Capture>('/captures', { chapterRootID: root, pageIDs: selected.filter((id) => !supplements.includes(id)), supplementPageIDs: supplements, idempotencyKey: crypto.randomUUID() }); setJob(result.jobID); history.replace({ pathname: location.pathname, search: `?capture=${result.jobID}` }); })}>Capture selected pages</button>
      </>}
    </>}
    {job && <><p role="status">Capture: {capture.data?.state ?? 'loading'} · {capture.data?.completedPages ?? 0}/{capture.data?.totalPages ?? 0} pages processed</p>{capture.isError && <button onClick={() => capture.refetch()}>Retry status check</button>}
      {capture.data?.state === 'failed' && <p role="alert">Capture failed: {capture.data.errorCode}. <button onClick={() => { setJob(null); history.replace(location.pathname); }}>Choose pages again</button></p>}
      {capture.data?.state === 'succeeded' && <><p>{capture.data.captureState === 'partial' ? 'Partial capture: some requested content was unavailable.' : 'Capture ready.'} Excluded page IDs: {capture.data.excludedPageIDs.join(', ') || 'none'}.</p>
        <ul>{capture.data.manifest?.pages?.filter((p) => p.state !== 'captured').map((p) => <li key={p.pageID}>Page {p.pageID}: {p.state} {p.errorCode}</li>)}</ul>{capture.data.captureState === 'partial' && <label className="idea-check"><input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />I understand this review covers only successfully captured content.</label>}
        <button disabled={busy || !familiar || !context.discipline.trim() || !context.focus.length || !['ready', 'partial'].includes(capture.data.captureState ?? '') || (capture.data.captureState === 'partial' && !partial)} onClick={() => action(async () => { const record = await api.post<IdeaSavedRecord>('/reviews', { snapshotID: capture.data!.snapshotID, context, acknowledgePartial: partial, idempotencyKey: crypto.randomUUID() }); open(record.head._id); })}>Create faculty review</button></>}
    </>}
  </section>;
}
