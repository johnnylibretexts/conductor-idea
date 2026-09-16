import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrompt, validateDraftForPrompt, type PromptInput } from './prompts.js';
import { createReview } from './contracts.js';
import { TASKS } from './framework.js';
import { chapters, context, draftFor } from './fixtures/chapters.js';

const inputFor = (mode: PromptInput['mode']): PromptInput => ({
  mode, context, snapshots: mode === 'synthesis' ? chapters : [chapters[0]],
  ...(mode === 'followup' ? { parent: { runID: 'parent-run', draft: draftFor('7.8'), focus: '7.8' as const } } : {}),
  ...(mode === 'synthesis' ? { assessments: chapters.map((s, i) => ({ revisionID: `review-${i}`, snapshotID: s.snapshotID, review: createReview(context) })) } : {}),
});
for (const mode of TASKS) test(`${mode}: bounded prompt supplies evidence, definitions and explicit resource provenance`, () => {
  const prompt = buildPrompt(inputFor(mode));
  assert.ok(prompt.manifest.inputBytes <= 48000);
  assert.match(prompt.manifest.inputHash, /^[0-9a-f]{64}$/);
  const body = JSON.parse(prompt.messages[1].content);
  assert.equal(body.snapshots[0].blocks[0].text, chapters[0].blocks[mode === '7.1' ? 1 : 0].text);
  assert.ok(body.suppliedReferences[0].text.length > 100);
  assert.ok(Array.isArray(body.furtherReadingNotSupplied));
  assert.equal(prompt.manifest.sources[0].excludedPageIDs[0], 'external-video');
});
test('depth changes the supplied lens and hash, while use/focus/destination remain explicit', () => {
  const input = inputFor('7.7');
  const requirements = buildPrompt(input);
  const expanded = buildPrompt({ ...input, context: { ...context, depth: 'requirements_and_considerations' } });
  const body = JSON.parse(requirements.messages[1].content);
  assert.ok(!('considerations' in body.lenses[0]));
  assert.ok(JSON.parse(expanded.messages[1].content).lenses[0].considerations.length > 0);
  assert.notEqual(requirements.manifest.inputHash, expanded.manifest.inputHash);
  assert.equal(body.context.intendedUse, 'lms_adaptation');
  assert.equal(body.context.destination, 'instructor_supplement');
  assert.equal(body.lenses[0].id, '7.7');
  assert.deepEqual(input.context, context);
});
test('7.7.1 uses category 7.7; rubric always supplies ten descriptor rows', () => {
  const summary = JSON.parse(buildPrompt(inputFor('7.7.1')).messages[1].content);
  assert.equal(summary.lenses.length, 1);
  assert.equal(summary.lenses[0].id, '7.7');
  const rubric = JSON.parse(buildPrompt(inputFor('rubric')).messages[1].content);
  assert.equal(rubric.lenses.flatMap((c: { rows: unknown[] }) => c.rows).length, 10);
});
test('source instructions remain data; over-limit input is rejected, not truncated', () => {
  const input = inputFor('7.6');
  const prompt = buildPrompt(input);
  assert.ok(prompt.messages[1].content.includes('UNTRUSTED TEST PASSAGE'));
  assert.ok(!prompt.messages[0].content.includes('UNTRUSTED TEST PASSAGE'));
  const snapshots = structuredClone(input.snapshots);
  snapshots[0].blocks[0].text = 'x'.repeat(48000);
  assert.throws(() => buildPrompt({ ...input, snapshots }), /IDEA_INPUT_LIMIT/);
});
test('followups and synthesis cannot lose parent, saved versions or selected coverage', () => {
  assert.throws(() => buildPrompt({ ...inputFor('followup'), parent: undefined }), /parent/);
  assert.throws(() => buildPrompt({ ...inputFor('synthesis'), assessments: [] }), /2–10/);
  const input = inputFor('synthesis');
  input.assessments![1].revisionID = input.assessments![0].revisionID;
  assert.throws(() => buildPrompt(input), /distinct/);
  const valid = buildPrompt(inputFor('synthesis'));
  assert.deepEqual(valid.manifest.inputRevisionIDs, ['review-0', 'review-1']);
  assert.equal(JSON.parse(valid.messages[1].content).assessments[0].review.status, 'draft');
});
test('unsupported focus, empty capture and excluded-page blocks fail before inference', () => {
  assert.throws(() => buildPrompt({ ...inputFor('7.6'), context: { ...context, focus: ['7.7'] } }), /outside/);
  assert.throws(() => buildPrompt({ ...inputFor('rubric'), snapshots: [] }));
  const input = inputFor('rubric');
  input.snapshots = structuredClone(input.snapshots);
  input.snapshots[0].excludedPageIDs.push('water');
  assert.throws(() => buildPrompt(input));
});
test('illustrations receive descriptions only and cannot cite unsupplied narrative text', () => {
  const prompt = buildPrompt(inputFor('7.1'));
  const body = JSON.parse(prompt.messages[1].content);
  assert.ok(body.snapshots[0].blocks.every((b: {kind:string}) => ['caption', 'alt'].includes(b.kind)));
  assert.deepEqual(prompt.manifest.sources[0].blockIDs, ['water:1']);
  const draft = draftFor('7.1');
  const names = draftFor('7.2');
  if (draft.mode !== '7.1' || names.mode !== '7.2') throw new Error('Fixture contract');
  draft.illustrations[0].support = names.findings[0].support;
  assert.deepEqual(validateDraftForPrompt(draft, inputFor('7.1')).errors, ['UNKNOWN_EVIDENCE_LOCATION']);
});
test('draft validation binds parent, synthesis versions and focused rubric coverage', () => {
  const followup = draftFor('followup');
  if (followup.mode !== 'followup') throw new Error('Fixture contract');
  followup.parentRunID = 'invented-parent';
  assert.ok(validateDraftForPrompt(followup, inputFor('followup')).errors.includes('FOLLOWUP_CONTEXT_MISMATCH'));
  assert.ok(validateDraftForPrompt(draftFor('synthesis'), inputFor('synthesis')).errors.includes('SYNTHESIS_CONTEXT_MISMATCH'));
  const rubric = draftFor('rubric');
  if (rubric.mode !== 'rubric') throw new Error('Fixture contract');
  rubric.rows[0].rating = 'inclusive';
  assert.ok(validateDraftForPrompt(rubric, { ...inputFor('rubric'), context: { ...context, focus: ['7.8'] } }).errors.includes('UNFOCUSED_ROW_RATED'));
});
test('synthesis retains explicitly selected drafts and never treats them as faculty ratings', () => {
  const input = inputFor('synthesis');
  input.includedDrafts = [{ revisionID: 'review-0', runID: 'selected-draft', draft: draftFor('7.8') }];
  const prompt = buildPrompt(input);
  const body = JSON.parse(prompt.messages[1].content);
  assert.deepEqual(prompt.manifest.includedDraftIDs, ['selected-draft']);
  assert.equal(body.includedDrafts[0].status, 'AI draft, not faculty judgment');
  assert.ok(body.assessments[0].review.answers.every((a: {rating:string}) => a.rating === 'not_rated'));
  input.includedDrafts[0].revisionID = 'foreign-review';
  assert.throws(() => buildPrompt(input), /selected assessment/);
});

 test('GLM format and Unicode span hints are deterministic without changing source evidence', () => {
  const input = inputFor('7.3');
  input.snapshots = structuredClone(input.snapshots);
  input.snapshots[0].blocks[0].text = 'A😀B';
  const before = structuredClone(input.snapshots);
  const prompt = buildPrompt(input);
  const body = JSON.parse(prompt.messages[1].content);
  assert.equal(body.snapshots[0].blocks[0].codePointLength, 3);
  assert.match(prompt.messages[0].content, /Do not wrap the object in Markdown code fences/);
  assert.match(prompt.messages[0].content, /do not estimate offsets/);
  assert.deepEqual(input.snapshots, before);
  const draft = draftFor('7.2');
  if (draft.mode !== '7.2' || draft.findings[0].support.kind !== 'quoted') throw new Error('Fixture');
  Object.assign(draft.findings[0].support.evidence[0], {quote: 'A😀B', start: 0, end: 4});
  assert.ok(validateDraftForPrompt(draft, {...input,mode:'7.2'}).errors.includes('QUOTE_MISMATCH'));
 });
