import assert from 'node:assert/strict';
import test from 'node:test';
import { createReview, parseDraft, reviewSchema, validateDraftEvidence, outputJSONSchema, outputSchemas } from './contracts.js';
import { categoryById, IDEA_FRAMEWORK, TASKS } from './framework.js';
import { chapters, context, draftFor } from './fixtures/chapters.js';

test('human form preserves three image rows and all seven other categories', () => {
  const review = createReview(context);
  assert.deepEqual(review.answers.map((r) => r.rowID), ['7.1.a', '7.1.b', '7.1.c', '7.2.a', '7.3.a', '7.4.a', '7.5.a', '7.6.a', '7.7.a', '7.8.a']);
  assert.ok(review.answers.every((r) => r.rating === 'not_rated'));
  assert.throws(() => reviewSchema.parse({ ...review, answers: review.answers.slice(1) }));
  assert.throws(() => reviewSchema.parse({ ...review, answers: review.answers.map((r) => ({ ...r, categoryID: '7.1' })) }));
  assert.throws(() => reviewSchema.parse({ ...review, answers: review.answers.map(() => review.answers[0]) }));
});
test('finishing needs explicit judgments and explanations; an unfinished export shape is valid', () => {
  const review = createReview(context);
  assert.throws(() => reviewSchema.parse({ ...review, status: 'finished' }));
  review.answers.forEach((answer) => { answer.rating = 'not_applicable'; });
  assert.throws(() => reviewSchema.parse({ ...review, status: 'finished' }));
  review.answers.forEach((answer) => { answer.naRationale = 'This fictional resource has no relevant evidence for this row.'; });
  assert.equal(reviewSchema.parse({ ...review, status: 'finished' }).status, 'finished');
  assert.equal(review.status, 'draft');
});
test('draft state cannot be passed as human ratings and cannot carry human acceptance', () => {
  const review = createReview(context);
  const before = structuredClone(review);
  parseDraft('rubric', draftFor('rubric'));
  assert.deepEqual(review, before);
  assert.throws(() => reviewSchema.parse({ ...review, answers: review.answers.map((r) => ({ ...r, rating: 'not_assessed' })) }));
  assert.throws(() => parseDraft('7.8', { ...draftFor('7.8'), status: 'finished' }));
});
test('demographic context never rescales immutable descriptors or creates inferred population counts', () => {
  const review = createReview(context);
  review.demographicContextPercent = 20;
  assert.equal(reviewSchema.parse(review).demographicContextPercent, 20);
  assert.equal(categoryById('7.1').rows[0].emerging, '30-70% of photos and illustrations include BIPOC');
  assert.ok(Object.isFrozen(IDEA_FRAMEWORK));
  assert.ok(Object.isFrozen(categoryById('7.1').rows[0]));
  assert.throws(() => reviewSchema.parse({ ...review, inferredRaceCounts: { exampleName: 1 } }));
});
for (const mode of TASKS) test(`${mode}: accepts task output and exports a strict JSON schema`, () => {
  const draft = parseDraft(mode, draftFor(mode));
  assert.equal(draft.mode, mode);
  assert.deepEqual(validateDraftEvidence(draft, chapters), []);
  assert.equal(outputJSONSchema(mode).additionalProperties, false);
});
test('schemas reject missing 7.8 strengths, lost 7.5 columns and a ninth rubric category', () => {
  const perspectives = draftFor('7.8') as Extract<ReturnType<typeof draftFor>, {mode:'7.8'}>;
  const { presentStrengths: _, ...missing } = perspectives;
  assert.throws(() => parseDraft('7.8', missing));
  const scenarios = draftFor('7.5') as Extract<ReturnType<typeof draftFor>, {mode:'7.5'}>;
  const { assumedSocialContext: ignored, ...partial } = scenarios.scenarios[0];
  assert.throws(() => parseDraft('7.5', { ...scenarios, scenarios: [partial] }));
  const summary = draftFor('7.7.1') as Extract<ReturnType<typeof draftFor>, {mode:'7.7.1'}>;
  assert.throws(() => parseDraft('7.7.1', { ...summary, areas: [{ ...summary.areas[0], categoryID: '7.7.1' }] }));
});
test('invented quotation, foreign snapshot and excluded evidence fail validation', () => {
  const draft = draftFor('7.2') as Extract<ReturnType<typeof draftFor>, {mode:'7.2'}>;
  const support = structuredClone(draft.findings[0].support);
  assert.equal(support.kind, 'quoted');
  if (support.kind !== 'quoted') throw new Error('Fixture contract');
  support.evidence[0].quote = 'Invented quote';
  draft.findings[0].support = support;
  assert.deepEqual(validateDraftEvidence(draft, chapters), ['QUOTE_MISMATCH']);
  support.evidence[0].snapshotID = 'other-project';
  assert.deepEqual(validateDraftEvidence(draft, chapters), ['UNKNOWN_EVIDENCE_LOCATION']);
  draft.findings[0].support = { kind: 'scope', snapshotID: chapters[0].snapshotID, pageIDs: ['external-video'], limitation: 'Unavailable' };
  assert.deepEqual(validateDraftEvidence(draft, chapters), ['UNKNOWN_REVIEWED_SCOPE']);
});
test('quote offsets use Unicode code points, not UTF-16 code units', () => {
  const evidence = structuredClone(chapters);
  evidence[0].blocks[0].text = '🌱 Water';
  const draft = draftFor('7.2') as Extract<ReturnType<typeof draftFor>, {mode:'7.2'}>;
  draft.findings[0].support = { kind: 'quoted', evidence: [{ snapshotID: 'environment-v1', pageID: 'water', blockID: 'water:0', start: 2, end: 7, quote: 'Water' }] };
  assert.deepEqual(validateDraftEvidence(draft, evidence), []);
});
test('AI cannot mark a scholarly link verified, even when its URL looks valid', () => {
  const draft = draftFor('7.4');
  const item = { title: 'Possible study', primaryURL: 'https://example.org/paper', explanation: 'Requires human checking', verification: 'verified' };
  assert.throws(() => parseDraft('7.4', { ...draft, alternativeResearch: [item] }));
  assert.throws(() => parseDraft('7.4', { ...draft, alternativeResearch: [{ ...item, verification: 'unverified', primaryURL: 'javascript:alert(1)' }] }));
  assert.equal(outputSchemas['7.4'].safeParse({ ...draft, alternativeResearch: [{ ...item, verification: 'unverified', primaryURL: 'not a URL' }] }).success, false);
});
