import { createHash } from 'node:crypto';

export const PROMPT_PACK_VERSION = 'crosswalk-2026-04-v2';
/** Adapted guidance, not an assertion that any resource URL was fetched. */
export const CROSSWALK_REFERENCE = Object.freeze({
  id: PROMPT_PACK_VERSION,
  title: 'ASCCC OERI IDEA Framework AI Crosswalk Instructions',
  url: 'https://asccc-oeri.org/wp-content/uploads/2026/04/IDEA-Framework-AI-Crosswalk-Instructions.pdf',
  pages: '3–12',
  attribution: 'ASCCC Open Educational Resources Initiative; guidance paraphrased for this application.',
  text: 'Select suitable disciplinary OER and record intended use, scope, depth and focus. Begin with a familiar chapter and check its draft using disciplinary expertise. Repeat and use focused follow-ups as needed. Distinguish explicit evidence from interpretation and recommendations. Plan restorative revisions or instructor/student supplements with chapter locations and rationale. Synthesize only assessments actually supplied. Generated ratings remain drafts; faculty record their own judgments.',
});
export const REFERENCE_HASH = createHash('sha256').update(JSON.stringify(CROSSWALK_REFERENCE)).digest('hex');
