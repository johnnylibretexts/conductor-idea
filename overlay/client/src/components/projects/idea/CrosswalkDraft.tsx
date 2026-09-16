import type { IdeaDraft, IdeaSupport, RevisionProposal } from '../../../types/idea';
import { label } from './ReviewSetup';
/** Task-shaped objects render as tables; support is always an explicit evidence action. */
export function DraftValue({ value, evidence }: { value: unknown; evidence: (s: IdeaSupport) => void }): JSX.Element {
  if (value === null || value === undefined) return <span>—</span>;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  if ('kind' in value && ['quoted', 'scope'].includes(String(value.kind))) return <button onClick={() => evidence(value as IdeaSupport)}>Check captured evidence</button>;
  if (Array.isArray(value)) {
    if (!value.length) return <p>No entries supplied.</p>;
    if (value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
      const keys = [...new Set(value.flatMap((v) => Object.keys(v)))];
      return <div className="idea-table" tabIndex={0} role="region" aria-label="AI draft table"><table><thead><tr>{keys.map((k) => <th scope="col" key={k}>{label(k.replace(/([a-z])([A-Z])/g, '$1 $2'))}</th>)}</tr></thead><tbody>{value.map((v, i) => <tr key={i}>{keys.map((k) => <td key={k}><DraftValue value={v[k]} evidence={evidence} /></td>)}</tr>)}</tbody></table></div>;
    }
    return <ul>{value.map((v, i) => <li key={i}><DraftValue value={v} evidence={evidence} /></li>)}</ul>;
  }
  return <dl>{Object.entries(value).map(([key, v]) => <div key={key}><dt>{label(key.replace(/([a-z])([A-Z])/g, '$1 $2'))}</dt><dd><DraftValue value={v} evidence={evidence} /></dd></div>)}</dl>;
}
export function CrosswalkDraft({ draft, evidence, addProposal }: { draft: IdeaDraft; evidence: (s: IdeaSupport) => void; addProposal?: (p: RevisionProposal) => void }) {
  const { schemaVersion, mode, summary, limitations, ...content } = draft;
  const proposals = draft.mode === '7.8' ? draft.missingPerspectives : draft.mode === 'synthesis' ? draft.plan : [];
  return <section><h3>AI draft · {mode}</h3><p>Check every claim against captured evidence. Sensitive identity claims and unverified research require faculty judgment. This draft does not change your ratings.</p><p>{summary}</p><h4>Scope and limitations</h4><ul>{limitations.map((l, i) => <li key={i}>{l}</li>)}</ul><DraftValue value={content} evidence={evidence} />
    {addProposal && proposals.map((p, i) => <button key={i} onClick={() => addProposal(p)}>Add suggestion {i + 1} to faculty plan: {p.change}</button>)}
  </section>;
}
