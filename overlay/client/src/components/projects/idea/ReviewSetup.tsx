import type { IdeaContext } from '../../../types/idea';
import type { Framework } from '../../../api/idea';
export const initialContext: IdeaContext = { discipline: '', intendedUse: 'original_platform', intendedExtent: 'selected_chapters', depth: 'requirements_only', focus: ['7.1', '7.2', '7.3', '7.4', '7.5', '7.6', '7.7', '7.8'], destination: 'instructor_supplement', licenseContext: '', promptAdjustment: '', regionalFocus: '' };
export const label = (value: string) => value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
export function ReviewSetup({ value, onChange, framework, disabled = false }: { value: IdeaContext; onChange: (v: IdeaContext) => void; framework: Framework; disabled?: boolean }) {
  const field = (key: keyof IdeaContext, text: string, limit: number) => <label>{text}<textarea maxLength={limit} value={value[key] as string} onChange={(e) => onChange({ ...value, [key]: e.target.value })} /></label>;
  const select = (key: keyof IdeaContext, text: string, options: string[]) => <label>{text}<select value={value[key] as string} onChange={(e) => onChange({ ...value, [key]: e.target.value })}>{options.map((o) => <option key={o} value={o}>{label(o)}</option>)}</select></label>;
  return <fieldset disabled={disabled}><legend>Review context</legend>
    {field('discipline', 'Discipline', 4000)}
    {select('intendedUse', 'How will this chapter be used?', ['original_platform', 'downloaded_package', 'lms_adaptation', 'other'])}
    {select('intendedExtent', 'Intended adoption extent (captured scope remains explicit)', ['selected_chapters', 'whole_book'])}
    {select('depth', 'Review depth', ['requirements_only', 'requirements_and_considerations'])}
    {select('destination', 'Planned destination for revisions', ['original_source', 'adapted_copy', 'instructor_supplement', 'student_supplement'])}
    {field('licenseContext', 'License and adaptation context', 4000)}{field('regionalFocus', 'Regional context', 400)}
    {field('promptAdjustment', 'Faculty request to include with AI tasks', 2000)}
    <fieldset><legend>Focus categories (choose at least one)</legend>{framework.categories.map((c) => <label className="idea-check" key={c.id}><input type="checkbox" checked={value.focus.includes(c.id)} onChange={(e) => onChange({ ...value, focus: e.target.checked ? [...value.focus, c.id] : value.focus.filter((id) => id !== c.id) })} />{c.id} {c.title}</label>)}</fieldset>
  </fieldset>;
}
