/**
 * Newcomer help drawn from the pinned OERI framework text. Category prose, considerations and row
 * descriptors are quoted verbatim from the framework the server serves; the only sentences written
 * here are the rating one-liners and the AI-draft note, kept neutral and framework-agnostic.
 */
import type { Framework } from '../../../api/idea';

type Category = Framework['categories'][number];
export interface TaskHelp { heading: string; summary: string; categories: Category[] }

const RUBRIC_SUMMARY = 'Drafts every rubric row for all selected categories in one run, using only the captured pages.';
const FOLLOWUP_SUMMARY = 'Asks the AI to look again at one category, starting from the parent draft you select; the captured evidence stays the same.';
const SYNTHESIS_SUMMARY = 'Compares the saved assessments you selected across chapters. It reads only those saved versions and their captured pages; it never averages ratings.';

/** What a Crosswalk task is asking, for the selected mode; null for a mode the UI does not offer. */
export function taskHelp(framework: Framework, mode: string): TaskHelp | null {
  if (mode === 'rubric') return { heading: 'Full ten-row rubric draft', summary: RUBRIC_SUMMARY, categories: [...framework.categories] };
  if (mode === 'followup') return { heading: 'Follow-up on selected draft', summary: FOLLOWUP_SUMMARY, categories: [] };
  if (mode === 'synthesis') return { heading: 'Synthesis across chapters', summary: SYNTHESIS_SUMMARY, categories: [] };
  const categoryID = mode === '7.7.1' ? '7.7' : mode;
  const category = framework.categories.find((c) => c.id === categoryID);
  if (!category) return null;
  const heading = mode === '7.7.1' ? `7.7.1 · Opening concepts and end summaries (${category.title})` : `${category.id} · ${category.title}`;
  return { heading, summary: 'The draft applies this one category to the captured pages.', categories: [category] };
}

export const AI_DRAFT_NOTE = 'The AI draft reports evidence, interpretation, uncertainty and a recommendation for this category. It never sets your rating.';

/** One line per rating value. The first three point at the row descriptors shown under each rubric row. */
export const RATING_LEGEND: readonly { value: string; label: string; text: string }[] = Object.freeze([
  { value: 'inclusive', label: 'Inclusive', text: 'The captured chapter meets the “Inclusive” descriptor shown for that row.' },
  { value: 'emerging_inclusive', label: 'Emerging inclusive', text: 'The chapter partly meets the row — it matches the “Emerging inclusive” descriptor.' },
  { value: 'exclusive', label: 'Exclusive', text: 'The chapter matches the “Exclusive” descriptor for that row; note the examples you found.' },
  { value: 'not_applicable', label: 'Not Applicable', text: 'The row genuinely cannot apply to this resource (see the framework’s definition); an explanation is required.' },
  { value: 'not_rated', label: 'Not rated', text: 'You have not judged this row yet. Finishing the review requires a judgment for every row.' },
  { value: 'not_assessed', label: 'Not assessed (AI drafts only)', text: 'The AI found too little evidence in the captured pages to say. It is not a rating and never becomes one.' },
]);
