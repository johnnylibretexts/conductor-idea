/**
 * The ASCCC OERI IDEA Framework, vendored IN FULL.
 *
 * Text is quoted from the "ASCCC OERI Inclusion, Diversity, Equity, and
 * Anti-Racism (IDEA) Framework and Implementation Guide, March 2025", which is
 * licensed CC BY 4.0. Every screen that shows this text shows
 * `FRAMEWORK_ATTRIBUTION` beside it; THIRD-PARTY-NOTICES.md carries it too.
 *
 * Quoted, not paraphrased, and not shortened: the earlier draft of this file
 * trimmed the examples out of 7.5, 7.6 and 7.8, and the examples are the part
 * an instructor unfamiliar with the Framework actually needs. The document's
 * own punctuation is kept — curly quotes, "30-70%" with a hyphen, cells with
 * and without a final full stop — because "quoted" has to mean quoted. The
 * ONE editorial act: in 7.5 the document sets a "For example, …" paragraph
 * under its fourth bullet without a bullet of its own; it is kept with that
 * bullet's text (7.5.4) rather than promoted to a bullet or dropped.
 *
 * Ids are STABLE and are what the review map keys on. Renumbering an element
 * is a data migration, not an edit: a saved checklist answer for '7.6.2' must
 * still mean "insert context, attribution, or quotations for historical
 * references" next year. Append; never renumber.
 *
 * `title` is the §7 heading; `rubricTitle` is the same category's heading in
 * Appendix A, which differs for five of the eight ("Illustrations and Photos
 * of People", "Incorporating Diverse Perspectives"). The screen shows `title`
 * because the restorative text sits under it; the export shows `rubricTitle`
 * because the export is Rubric 1.
 *
 * Rubric rows come from Appendix A (Rubric 1). Category 7.1 has three rows
 * there, each with its own "not applicable" box; every other category has one.
 * That asymmetry is the document's and is preserved rather than flattened,
 * because an assessor filling in Rubric 1 by hand answers all three.
 */
export type CategoryId = '7.1' | '7.2' | '7.3' | '7.4' | '7.5' | '7.6' | '7.7' | '7.8'

export interface FrameworkElement {
  /** `<category>.<n>`, e.g. `7.6.3`. Ours; the document does not number its bullets. */
  id: string
  text: string
}

export interface RubricRow {
  /** `<category>.<letter>`, e.g. `7.1.b`. */
  id: string
  exclusive: string
  emerging: string
  inclusive: string
}

export interface FrameworkResource {
  label: string
  url: string
}

export interface IdeaCategory {
  id: CategoryId
  /** The §7 heading. */
  title: string
  /** The same category's heading in Appendix A, Rubric 1. */
  rubricTitle: string
  /** The "Restorative Requirements" paragraph. */
  restorative: string
  /** The "Elements for Consideration" bullets. */
  elements: readonly FrameworkElement[]
  /** Rubric 1 rows for this category. */
  rows: readonly RubricRow[]
  /** The category's entries under §8.0 "Additional Resources". */
  resources: readonly FrameworkResource[]
}

export const FRAMEWORK_ATTRIBUTION = {
  title: 'ASCCC OERI Inclusion, Diversity, Equity, and Anti-Racism (IDEA) Framework and Implementation Guide, March 2025',
  author: 'ASCCC Open Educational Resources Initiative',
  url: 'https://asccc-oeri.org/asccc-oeri-inclusion-diversity-equity-and-anti-racism-idea-audit-framework/',
  license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
} as const

/** The "Not Applicable" box every Rubric 1 row carries. */
export const RUBRIC_NA_TEXT = 'This category does not apply to this resource. Explain in notes.'
/** Rubric 1's instructions for its two chapter-level free-text fields. */
export const RUBRIC_SUMMARY_HINT = 'Use this section to highlight main points and key information about the rubric assessments.'
export const RUBRIC_SUGGESTIONS_HINT = 'Use this section to provide any IDEA related suggestions beyond the specific feedback you provided on the rubric.'

export const IDEA_FRAMEWORK: readonly IdeaCategory[] = [
  {
    id: '7.1',
    title: 'Illustrations and Photos',
    rubricTitle: 'Illustrations and Photos of People',
    restorative:
      'When illustrations and photos are reflective of diverse populations, students can see themselves, or people like them, in the learning materials. At the same time, visuals should not serve to perpetuate stereotypes. When images of people are not a typical element of the resources for a discipline (such as math or physics), consider incorporating images to humanize the content.',
    elements: [
      { id: '7.1.1', text: 'Consider diversity in terms of race, ethnicity, age, gender, gender expression, physical and mental abilities, sexual orientation and more.' },
      { id: '7.1.2', text: 'Examine the number of images and illustrations and the individuals and populations represented therein. Ensure that all populations are equitably represented throughout the resource.' },
      { id: '7.1.3', text: 'Include images of people where the context of the image does not relate to their identity.' },
      { id: '7.1.4', text: 'Analyze the role, depiction, connotation, expressions of authority, and purpose of the people represented in the image. Ensure that images do not perpetuate stereotypes. Examine the background or setting of the image to assess whether it depicts anything that may be perceived as negative.' },
      { id: '7.1.5', text: 'Consider diversity on a section or chapter level and in the work as a whole. Although it is impossible to represent every population in every illustration or photo, the resource should include a diversity of images and illustrations throughout.' },
    ],
    rows: [
      { id: '7.1.a', exclusive: 'Less than 30% of photos and illustrations include BIPOC', emerging: '30-70% of photos and illustrations include BIPOC', inclusive: 'More than 70% of photos and illustrations include BIPOC' },
      { id: '7.1.b', exclusive: 'Very few to no examples of diversity beyond race and ethnicity.', emerging: '1-2 examples of diversity beyond race and ethnicity.', inclusive: 'More than 2 examples of diversity beyond race and ethnicity.' },
      { id: '7.1.c', exclusive: 'Many examples of illustrations and photos that are not culturally sensitive or appropriate. Include examples in notes', emerging: 'Some examples of illustrations and photos that are not culturally sensitive or appropriate. Include examples in notes', inclusive: 'Very few to no examples of illustrations and photos that are not culturally sensitive or appropriate. Include examples in notes' },
    ],
    resources: [
      { label: 'Sources of stock photos featuring people of color', url: 'https://www.diversetechgeek.com/stock-photos-people-of-color/' },
      { label: 'Sources of free LGBTQ stock photos', url: 'https://www.diversetechgeek.com/sources-free-lgbtq-stock-photos/' },
      { label: 'List of diverse and free stock photo sites', url: 'https://blog.walls.io/socialmedia/diverse-and-free-stock-photo-sites/' },
      { label: 'Source of free photos of Black and Brown people (nappy)', url: 'https://nappy.co/' },
    ],
  },
  {
    id: '7.2',
    title: 'Example Names',
    rubricTitle: 'Example Names',
    restorative:
      'Names of people are often needed for examples, exercises, and scenarios, and they should represent various countries of origin, ethnicities, genders, and races and be properly portrayed. At the same time, negative comparisons or stereotypes associated with particular names and national origins or ethnicities should be avoided.',
    elements: [
      { id: '7.2.1', text: 'Consider the diversity and overall representation on a quantitative and qualitative basis.' },
      { id: '7.2.2', text: 'Determine whether names indicative of a particular race, ethnicity, or national origin are associated with stereotypes or negative concepts.' },
      { id: '7.2.3', text: 'Seek other opinions, including those of students, when necessary.' },
      { id: '7.2.4', text: 'Seek out name pronunciations, if in doubt, when recording video presentations or lectures.' },
      { id: '7.2.5', text: 'Consider using your own roster of students to find diverse names.' },
    ],
    rows: [
      { id: '7.2.a', exclusive: 'Less than 30% of names reflect BIPOC culture', emerging: '30-70% of names reflect BIPOC culture', inclusive: 'More than 70% of names reflect BIPOC culture' },
    ],
    resources: [
      { label: 'Popular names from around the world', url: 'https://babynames.mom.com/name-list/global' },
      { label: 'Multicultural names', url: 'https://nameberry.com/userlist/view/62227/all' },
      { label: 'Gender neutral names', url: 'https://nameberry.com/unisex-names' },
      { label: 'Name pronunciation guide', url: 'https://www.pronouncenames.com/' },
    ],
  },
  {
    id: '7.3',
    title: 'Gender-Inclusive Language and Use of Pronouns',
    rubricTitle: 'Gender Inclusive Language and Use of Pronouns',
    restorative:
      'Gender inclusivity is important because all students should be able to see themselves represented. Gender inclusive language can refer to the use of gender-neutral pronouns or language that intentionally dispels gender stereotypes.',
    elements: [
      { id: '7.3.1', text: 'Pay attention to connotations and make sure that gender stereotypes are not perpetuated. If in doubt, ask for another opinion.' },
      { id: '7.3.2', text: 'Use pronouns clearly. If using traditionally plural pronouns (such as them or they) confuses the context, change the wording to reflect the situation clearly.' },
      { id: '7.3.3', text: 'Explicitly state what pronouns an individual uses, if appropriate.' },
      { id: '7.3.4', text: 'Consider reducing the use of pronouns and rewriting sentences to eliminate pronouns.' },
      { id: '7.3.5', text: 'Avoid making assumptions about an individual’s gender.' },
    ],
    rows: [
      { id: '7.3.a', exclusive: 'Many examples of language that is not gender inclusive and inappropriate use of pronouns. Include examples in notes.', emerging: 'Some examples of language that is not gender inclusive and inappropriate use of pronouns. Include examples in notes.', inclusive: 'Very few to no examples of language that is not gender inclusive and inappropriate use of pronouns. Include examples in notes.' },
    ],
    resources: [
      { label: 'GLSEN Pronoun Guide', url: 'https://www.glsen.org/activity/pronouns-guide-glsen' },
      { label: 'Alternatives to gendered nouns (EIGE)', url: 'https://eige.europa.eu/publications-resources/toolkits-guides/gender-sensitive-communication/practical-tools/examples-common-gendered-nouns-alternatives' },
      { label: 'GLSEN Gender Terminology Guide', url: 'https://www.glsen.org/activity/gender-terminology' },
      { label: 'Key gender and sexuality terms (MSU)', url: 'https://gscc.msu.edu/education/glossary.html' },
      { label: 'Gender-Inclusive Biology', url: 'https://www.genderinclusivebiology.com/' },
    ],
  },
  {
    id: '7.4',
    title: 'Diverse Authors, Researchers, and Studies',
    rubricTitle: 'Diverse Authors, Researchers, and Studies',
    restorative:
      'Referencing discipline contributors—e.g., researchers, scholars, academics—with backgrounds like those of students both validates and affirms the students as student-scholars and invites them into the academic conversation. Recognize that all people carry around biases that affect what they include and exclude. Counteract these biases by actively seeking out achievements and discipline contributions from all cultures and countries. Note that diversity may not be perceptible in some of the references. Consider the use of open-source articles and diversify research by using diverse resources.',
    elements: [
      { id: '7.4.1', text: 'Examine the diversity of included contributors in the discipline. If diversity is lacking, seek diversity in the contributions mentioned.' },
      { id: '7.4.2', text: 'If the contributions are dominated by cis-hetero white men, discuss this with the class and include some of the historical and structural explanations for the lack of diversity i.e., lack of educational opportunities for minoritized groups.' },
      { id: '7.4.3', text: 'Include current, more diverse contributors when possible and relevant where historical contributors are not diverse. Keep in mind that your goal is to ensure the inclusion of forgotten perspectives.' },
      { id: '7.4.4', text: 'Avoid isolating diverse contributors to specific sections, e.g., “multicultural impacts on psychology.”' },
      { id: '7.4.5', text: 'Include examples of and references to historically underrepresented groups, such as Arabic contributors to mathematics and astronomy.' },
      { id: '7.4.6', text: 'Seek out specific efforts and programs to drive inclusive citation.' },
      { id: '7.4.7', text: 'If less formal, in-text mentions of specific researchers or studies are included, these references should be as diverse as possible.' },
    ],
    rows: [
      { id: '7.4.a', exclusive: 'Very few to no examples of diverse authors and researchers with few to no studies related to BIPOC', emerging: 'Some examples of diverse authors and researchers with some studies related to BIPOC', inclusive: 'Many examples of diverse authors and researchers with many studies related to BIPOC' },
    ],
    resources: [
      { label: '500 Queer Scientists', url: 'https://500queerscientists.com/' },
      { label: 'Cite Black Authors', url: 'https://citeblackauthors.com/listings/' },
      { label: 'Disabled Writers Database', url: 'https://disabledwriters.com/the-database/' },
      { label: 'Scientist Spotlights Initiative', url: 'https://scientistspotlights.org/' },
      { label: 'Directory of Open Access Journals', url: 'https://doaj.org/' },
    ],
  },
  {
    id: '7.5',
    title: 'Applications, Examples, and Problem Scenarios that Relate to Diverse Audiences',
    rubricTitle: 'Applications, Examples and Problem Scenarios',
    restorative:
      'When using real-world examples, one should include diverse and relatable examples for students and avoid stereotypes. This should be done on a chapter or section basis in the resource as well as holistically. Examples that rely on cultural knowledge will not be understandable by everyone and should be appropriately explained.',
    elements: [
      { id: '7.5.1', text: 'Review, and potentially have students review, problems and exercises, giving special consideration to their context and inclusivity.' },
      { id: '7.5.2', text: 'Analyze terminology, contexts, and situations presented in problems and applications to ensure that they are comprehensible by all populations.' },
      { id: '7.5.3', text: 'Write and use examples that include diverse people, organizations, geographies, and situations.' },
      { id: '7.5.4', text: 'Avoid negative stereotypes or sensitive subjects in problems and applications unless the subject matter demands it. For example, a section on mental health may require statistics on suicide rates, but a math textbook can likely employ an example that does not rely on such sensitive material.' },
      { id: '7.5.5', text: 'Be mindful when creating exercises that require specific knowledge, context, or frame of reference.' },
      { id: '7.5.6', text: 'Examine and adjust assumptions and expectations about prior knowledge, especially regarding knowledge from different subjects or cultural contexts. For example, in a history course, do not assume that everyone has read The Red Badge of Courage or has seen Saving Private Ryan; in an astronomy course, do not assume students have cooked when discussing heating or cooling. Even very common cultural elements such as Harry Potter, Disney, or popular game shows are not universal.' },
    ],
    rows: [
      { id: '7.5.a', exclusive: 'Very few to no examples of applications, examples and scenarios reflect BIPOC culture', emerging: 'Some examples of applications, examples and scenarios reflect BIPOC culture', inclusive: 'Many examples of applications, examples and scenarios reflect BIPOC culture' },
    ],
    resources: [],
  },
  {
    id: '7.6',
    title: 'Appropriate Terminology',
    rubricTitle: 'Appropriate Terminology',
    restorative:
      'References to people, groups, populations, categories, conditions, and disabilities should use appropriate verbiage and not contain derogatory, colloquial, inappropriate, or otherwise incorrect language. For historical uses that must remain in place, consider adding context, such as “a widely-used term at the time.” While “slave” was once commonly used to refer to African Americans who were enslaved and individuals who had schizophrenia were referred to as “schizophrenics”, today we strive to not use terminology that reduces a person to something that was done to them - and language that reflects their status as property - or a medical condition which they are living with. Ensure that quotations or paraphrases using outdated terms are attributed, contextualized, and limited. As language is not static, it is important to keep in mind that what terms are deemed “acceptable” is ever-changing. The need to begin referring to yesterday’s “master” bedroom” as today’s “primary” bedroom” or “foreign” languages as “world” languages may seem understandable and obvious today but was not commonly challenged historically.',
    elements: [
      { id: '7.6.1', text: 'Identify any outmoded or incorrect terminology and replace or reframe the terminology.' },
      { id: '7.6.2', text: 'Insert context, attribution, or quotations for historical references as needed.' },
      { id: '7.6.3', text: 'Identify and use the best terminology at the time. As noted, terminology changes regularly and acceptability is not universal. Consult style guides as necessary; note they may conflict. Do not feel obligated to use the latest term if it is not widely used or is controversial.' },
      { id: '7.6.4', text: 'Define outmoded terminology in historical situations—e.g., court cases, laws, or articles—using quotations or annotated with contextual information. For example, the use of “illegal alien” in a discussion of law can be framed as “as stated in the decision” or something similar.' },
      { id: '7.6.5', text: 'Avoid ableist language. Language that is offensive to people with disabilities is ableist. This includes using words like “psycho,” and “crazy” or phrases like “blind spot” or “falling on deaf ears”. This type of language is problematic because it expresses contempt for having a disability.' },
      { id: '7.6.6', text: 'Avoid or limit idioms or colloquialisms that may lead to misconceptions among those who natively speak other languages or who may not have the educational or cultural context to understand them. While “hitting the books” and “break a leg” may have clear meanings to most speakers of English raised in the United States, those meanings are not universal and a literal interpretation of such phrases could create not only confusion, but fear of bodily harm. Clarify the context and use of common idioms or colloquialisms when they appear so that students may understand them better.' },
    ],
    rows: [
      { id: '7.6.a', exclusive: 'Many examples of terminology that is derogatory/ inappropriate. Include examples in notes', emerging: 'Some examples of terminology that is derogatory/inappropriate. Include examples in notes', inclusive: 'Very few to no examples of terminology that is derogatory/inappropriate. Include examples in notes' },
    ],
    resources: [
      { label: 'Disability Language Style Guide (NCDJ)', url: 'https://ncdj.org/style-guide/' },
      { label: 'Ableism in writing and everyday language (ACES)', url: 'https://aceseditors.org/news/2021/ableism-in-writing-and-everyday-language' },
      { label: 'Diversity/Inclusivity Style Guide (CSU)', url: 'https://www.calstate.edu/csu-system/csu-branding-standards/editorial-style-guide/Pages/diversity-style-guide.aspx' },
      { label: 'The Diversity Style Guide', url: 'https://www.diversitystyleguide.com/' },
      { label: 'GLAAD Media Reference Guide', url: 'https://www.glaad.org/reference' },
      { label: 'NABJ Style Guide', url: 'https://www.nabj.org/page/styleguide' },
      { label: 'Racial Equity Tools Glossary', url: 'https://www.racialequitytools.org/glossary' },
      { label: 'Religion Stylebook', url: 'http://religionstylebook.com/' },
      { label: 'Style guide: reporting on mental health', url: 'https://sprc.org/wp-content/uploads/2023/01/mental-health-reporting-style-guide.pdf' },
    ],
  },
  {
    id: '7.7',
    title: 'Keyword, Glossary, and other types of Metadata Representation',
    rubricTitle: 'Keyword, Glossary and Metadata Representation',
    restorative:
      'Quite often textbooks include metadata sections like chapter outlines/summaries, key takeaways, keywords, glossaries, indexes, etc. What’s included in these sections signal high priority to students, and, as such, one should ensure that diverse topics, scholars, perspectives and terms are appropriately represented in these sections.',
    elements: [
      { id: '7.7.1', text: 'Analyze keyword lists and glossaries and identify core terms that reflect diverse scholars and perspectives that are not represented or highlighted.' },
      { id: '7.7.2', text: 'Assess whether software is negatively impacting the resource’s index. Book indexes are usually not fully representative of book content; they are often built by software, and search capabilities do not always lend themselves to inclusivity.' },
      { id: '7.7.3', text: 'Add keywords, perspectives and key takeaways that specifically highlight issues important to underrepresented groups.' },
    ],
    rows: [
      { id: '7.7.a', exclusive: 'Very few to no examples of keywords or glossary terms reflect diverse topics and/or folks', emerging: 'Some examples of keywords or glossary terms reflect diverse topics and/or folks', inclusive: 'Many examples of keywords or glossary terms reflect diverse topics and/or folks' },
    ],
    resources: [],
  },
  {
    id: '7.8',
    title: 'Incorporating Diverse Perspectives on Issues, Events, and Concepts That Are Relevant to Underrepresented Groups',
    rubricTitle: 'Incorporating Diverse Perspectives',
    restorative:
      'Diverse populations experience issues such as social problems, health, politics, business practices, and economic conditions that may differ from the mainstream. Purposefully incorporating perspectives from populations that are commonly not included allows for how – and why – perspectives may vary to be examined.',
    elements: [
      { id: '7.8.1', text: 'Include diverse perspectives when presenting controversies, arguments, and opinions for each topic or concept covered. A variety of perspectives will expose students to different points of view and widen the context. Do not avoid the inclusion of a perspective due to the discomfort it might create.' },
      { id: '7.8.2', text: 'Do not stigmatize individuals having a specific condition, occupation, experience, or background.' },
      { id: '7.8.3', text: 'Be aware that certain controversial topics, when necessary to include, should be described in an academic manner that recognizes the existing controversy and provides an analysis of the relevant facts or data.' },
      { id: '7.8.4', text: 'If a discipline has accepted a specific position on a topic—e.g., climate change, sexual orientation being partially determined biologically—describe that position. Consider alternative points of view in relation to the discipline adopted position and explain rationale for the position.' },
      { id: '7.8.5', text: 'If a sociopolitical issue without a consensus must be described—e.g., campus carry, voting rights—include a balanced viewpoint by providing differing perspectives on the issue.' },
      { id: '7.8.6', text: 'Avoid characterizations that lead to generalization, such as “rural communities tend to support gun rights.” If a generalization must be stated, provide a reference to support that generalization and additional context for understanding. Also, include any counterpoints from within that generalization.' },
    ],
    rows: [
      { id: '7.8.a', exclusive: 'Use of 0 diverse perspectives relevant to underrepresented groups', emerging: 'Use of 1 diverse perspective relevant to underrepresented groups', inclusive: 'Use of 2 or more diverse perspectives relevant to underrepresented groups' },
    ],
    resources: [
      { label: 'Culturally Responsive & Inclusive Curriculum Resources (PSU)', url: 'https://guides.library.pdx.edu/culturallyresponsivecurriculum' },
      { label: 'Culturally Responsive Higher Education Curriculum Assessment Tool (ASCCC)', url: 'https://www.asccc.org/sites/default/files/Culturally_Responsive_Assessment_Tool.pdf' },
    ],
  },
]

export const IDEA_CATEGORY_IDS: readonly CategoryId[] = IDEA_FRAMEWORK.map((c) => c.id)

export const isCategoryId = (v: unknown): v is CategoryId =>
  typeof v === 'string' && (IDEA_CATEGORY_IDS as readonly string[]).includes(v)

const BY_ID: ReadonlyMap<CategoryId, IdeaCategory> = new Map(IDEA_FRAMEWORK.map((c) => [c.id, c]))

export function categoryById(id: CategoryId): IdeaCategory {
  const c = BY_ID.get(id)
  if (!c) throw new Error(`unknown IDEA category ${id}`)
  return c
}
