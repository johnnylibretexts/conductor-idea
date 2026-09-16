/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { CrosswalkDraft } from './CrosswalkDraft';
import { RubricForm } from './RubricForm';
import { draftFor, context } from '../../../../../server/util/idea/fixtures/chapters';
import { IDEA_FRAMEWORK, FRAMEWORK_ATTRIBUTION, RUBRIC_NA_TEXT } from '../../../../../server/util/idea/vendor/oeri-framework';
import type { Framework } from '../../../api/idea';
import type { IdeaTask, IdeaReview } from '../../../types/idea';
test('all twelve task drafts render structured output and explicit evidence actions without executing markup', () => {
  for (const mode of ['rubric', '7.1', '7.2', '7.3', '7.4', '7.5', '7.6', '7.7', '7.7.1', '7.8', 'followup', 'synthesis'] as IdeaTask[]) {
    const draft = draftFor(mode); draft.summary = '<img src=x onerror=alert(1)>';
    const html = renderToStaticMarkup(React.createElement(CrosswalkDraft, { draft, evidence: () => {} }));
    const document = new JSDOM(html).window.document;
    assert.equal(document.querySelector('img'), null); assert.match(document.body.textContent!, /Check captured evidence/); assert.match(html, /AI draft/);
    assert.ok(document.querySelectorAll('th[scope=col]').length > 0);
  }
});
test('faculty rubric starts with ten unrated judgments and separate framework descriptions', () => {
  const review = { context, answers: IDEA_FRAMEWORK.flatMap((c) => c.rows.map((r) => ({ rowID: r.id, categoryID: c.id, rating: 'not_rated', note: '', naRationale: '', adoptedTextRunID: null }))), checklist: [], summary: '', suggestions: '', demographicContextPercent: null } as unknown as IdeaReview;
  const framework = { categories: IDEA_FRAMEWORK, attribution: FRAMEWORK_ATTRIBUTION, notApplicable: RUBRIC_NA_TEXT } as unknown as Framework;
  const document = new JSDOM(renderToStaticMarkup(React.createElement(RubricForm, { value: review, onChange: () => {}, framework, disabled: false }))).window.document;
  assert.equal(document.querySelectorAll('option[value=not_rated][selected]').length, 10);
  assert.equal(document.querySelectorAll('option[value=inclusive][selected]').length, 0);
  assert.match(document.body.textContent!, /AI drafts never select these ratings/);
});
