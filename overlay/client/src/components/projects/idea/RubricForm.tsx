import type { IdeaReview } from '../../../types/idea';
import type { Framework } from '../../../api/idea';
import { label } from './ReviewSetup';
import { RATING_LEGEND } from './framework-help';
export function RubricForm({ value, onChange, framework, disabled }: { value: IdeaReview; onChange: (v: IdeaReview) => void; framework: Framework; disabled: boolean }) {
  return <fieldset disabled={disabled}><legend>Faculty assessment — your judgments</legend><p>AI drafts never select these ratings. Finish requires a judgment for all ten rows and an explanation for each Not Applicable.</p>
    <details className="idea-help"><summary>How the ratings work</summary><dl>{RATING_LEGEND.map((r) => <div key={r.value}><dt>{r.label}</dt><dd>{r.value === 'not_applicable' ? `${r.text} ${framework.notApplicable}` : r.text}</dd></div>)}</dl></details>
    {framework.categories.map((c) => <section key={c.id}><h3>{c.id} {c.title}</h3><p>{c.restorative}</p>
      {c.rows.map((row) => { const answer = value.answers.find((a) => a.rowID === row.id)!; const update = (patch: Partial<typeof answer>) => onChange({ ...value, answers: value.answers.map((a) => a.rowID === row.id ? { ...a, ...patch } : a) });
        return <fieldset key={row.id}><legend>Rubric row {row.id}</legend><dl><dt>Exclusive</dt><dd>{row.exclusive}</dd><dt>Emerging inclusive</dt><dd>{row.emerging}</dd><dt>Inclusive</dt><dd>{row.inclusive}</dd><dt>Not Applicable</dt><dd>{framework.notApplicable}</dd></dl>
          <label>Faculty rating for {row.id}<select value={answer.rating} onChange={(e) => update({ rating: e.target.value as typeof answer.rating })}>{['not_rated', 'not_applicable', 'exclusive', 'emerging_inclusive', 'inclusive'].map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></label>
          <label>Faculty notes for {row.id}<textarea value={answer.note} maxLength={4000} onChange={(e) => update({ note: e.target.value, adoptedTextRunID: null })} /></label>
          {answer.rating === 'not_applicable' && <label>Why does {row.id} not apply?<textarea required value={answer.naRationale} maxLength={4000} onChange={(e) => update({ naRationale: e.target.value })} /></label>}
        </fieldset>; })}
      {value.context.depth === 'requirements_and_considerations' && <details><summary>Elements for consideration</summary>{c.elements.map((element) => <label key={element.id}>{element.text}<select value={value.checklist.find((i) => i.elementID === element.id)?.answer ?? 'skip'} onChange={(e) => onChange({ ...value, checklist: [...value.checklist.filter((i) => i.elementID !== element.id), { elementID: element.id, answer: e.target.value as 'yes' }] })}>{['skip', 'yes', 'no', 'unsure'].map((v) => <option key={v}>{v}</option>)}</select></label>)}</details>}
      <details><summary>Further reading (not automatically reviewed)</summary>{c.resources.map((r) => <p key={r.url}><a href={r.url} target="_blank" rel="noreferrer">{r.label}</a></p>)}</details>
    </section>)}
    <label>Human-observed demographic context percentage (optional; never inferred from names or images)<input type="number" min="0" max="100" value={value.demographicContextPercent ?? ''} onChange={(e) => onChange({ ...value, demographicContextPercent: e.target.value === '' ? null : Number(e.target.value) })} /></label>
    <label>Faculty summary<textarea maxLength={8000} value={value.summary} onChange={(e) => onChange({ ...value, summary: e.target.value })} /></label>
    <label>Faculty suggestions<textarea maxLength={8000} value={value.suggestions} onChange={(e) => onChange({ ...value, suggestions: e.target.value })} /></label>
  </fieldset>;
}
