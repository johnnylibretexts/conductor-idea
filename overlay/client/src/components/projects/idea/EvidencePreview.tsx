import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { IdeaSupport, IdeaEvidenceBlock } from '../../../types/idea';
import type { ideaAPI } from '../../../api/idea';
export function EvidencePreview({ api, support, onClose }: { api: ReturnType<typeof ideaAPI>; support: IdeaSupport; onClose: () => void }) {
  const region = useRef<HTMLElement>(null);
  useEffect(() => { const prior = document.activeElement as HTMLElement | null; region.current?.focus(); return () => prior?.focus(); }, [support]);
  const refs = support.kind === 'quoted' ? support.evidence.map((r) => ({ snapshotID: r.snapshotID, pageID: r.pageID })) : support.pageIDs.map((pageID) => ({ snapshotID: support.snapshotID, pageID }));
  const query = useQuery({ queryKey: ['idea-evidence', api.projectID, refs], queryFn: () => Promise.all(refs.map((r) => api.get<{ pageID: string; blocks: IdeaEvidenceBlock[] }>(`/snapshots/${r.snapshotID}/pages/${encodeURIComponent(r.pageID)}`))), retry: false, cacheTime: 0 });
  return <section className="idea-evidence" aria-label="Captured evidence" tabIndex={-1} ref={region}><h3>Captured evidence</h3><button onClick={onClose}>Close evidence</button>
    {support.kind === 'scope' && <p>Reviewed scope: {support.limitation}</p>}{query.isLoading && <p role="status">Loading captured text…</p>}{query.isError && <p role="alert">Unable to load this evidence.</p>}
    {query.data?.map((page, i) => <section key={i}><h4>Page {page.pageID}</h4>{page.blocks.map((b) => <div key={b.blockID}><strong>{b.kind} · {b.blockID}</strong><p>{b.text}</p>{support.kind === 'quoted' && support.evidence.filter((r) => r.blockID === b.blockID && r.pageID === b.pageID).map((r, j) => <blockquote key={j}>{r.quote}<footer>Unicode code points {r.start}–{r.end}</footer></blockquote>)}</div>)}</section>)}
  </section>;
}
