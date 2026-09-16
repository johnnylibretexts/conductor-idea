/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { taskHelp, RATING_LEGEND, AI_DRAFT_NOTE } from './framework-help';
import type { Framework } from '../../../api/idea';

const framework: Framework = {
  categories: [
    { id: '7.1', title: 'Illustrations and Photos', restorative: 'Why 7.1 matters.', elements: [{ id: '7.1.1', text: 'Consider diversity.' }],
      rows: [{ id: '7.1.a', exclusive: 'Less than 30%', emerging: '30-70%', inclusive: 'More than 70%' }], resources: [] },
    { id: '7.7', title: 'Keyword, Glossary, and other types of Metadata Representation', restorative: 'Why 7.7 matters.', elements: [],
      rows: [{ id: '7.7.a', exclusive: 'e', emerging: 'm', inclusive: 'i' }], resources: [] },
  ] as Framework['categories'],
  attribution: { title: 'IDEA', author: 'ASCCC OERI', url: 'https://example.test', license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' } },
  notApplicable: 'Not Applicable text from the framework.',
};

test('a chapter task shows its own category: title, restorative text, considerations and row descriptors, all verbatim', () => {
  const help = taskHelp(framework, '7.1')!;
  assert.equal(help.heading, '7.1 · Illustrations and Photos');
  assert.deepEqual(help.categories.map((c) => c.id), ['7.1']);
  assert.equal(help.categories[0].restorative, 'Why 7.1 matters.');
  assert.deepEqual(help.categories[0].elements.map((e) => e.text), ['Consider diversity.']);
  assert.deepEqual(help.categories[0].rows[0], { id: '7.1.a', exclusive: 'Less than 30%', emerging: '30-70%', inclusive: 'More than 70%' });
});

test('7.7.1 explains itself with the 7.7 category, and the rubric task lists every category', () => {
  assert.deepEqual(taskHelp(framework, '7.7.1')!.categories.map((c) => c.id), ['7.7']);
  assert.match(taskHelp(framework, '7.7.1')!.heading, /^7\.7\.1 /);
  const rubric = taskHelp(framework, 'rubric')!;
  assert.deepEqual(rubric.categories.map((c) => c.id), ['7.1', '7.7']);
  assert.match(rubric.heading, /ten-row rubric/);
});

test('follow-up and synthesis get a one-line explanation and no category text; unknown modes get nothing', () => {
  const followup = taskHelp(framework, 'followup')!;
  assert.equal(followup.categories.length, 0); assert.match(followup.summary, /parent draft/);
  const synthesis = taskHelp(framework, 'synthesis')!;
  assert.equal(synthesis.categories.length, 0); assert.match(synthesis.summary, /saved assessments/);
  assert.equal(taskHelp(framework, 'nonsense'), null);
});

test('the rating legend covers every faculty rating value plus the AI-only not_assessed, one line each', () => {
  const values = RATING_LEGEND.map((r) => r.value);
  assert.deepEqual(values, ['inclusive', 'emerging_inclusive', 'exclusive', 'not_applicable', 'not_rated', 'not_assessed']);
  for (const r of RATING_LEGEND) { assert.ok(r.label.length > 0); assert.ok(!r.text.includes('\n')); assert.ok(r.text.length <= 220, r.value); }
  assert.match(RATING_LEGEND.find((r) => r.value === 'not_assessed')!.text, /AI/);
  assert.match(RATING_LEGEND.find((r) => r.value === 'not_applicable')!.text, /explanation/i);
  assert.match(AI_DRAFT_NOTE, /never sets your rating/);
});
