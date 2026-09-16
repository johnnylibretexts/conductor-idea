/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionValid, draftMatchesSelection, removeSelection } from './synthesisSelection';
import type { ReviewItem } from '../../../api/idea';
import { SaveCoordinator } from './saveCoordinator';
import type { IdeaSavedRecord, IdeaSynthesis } from '../../../types/idea';
const review = (id: string, revisionID = `${id}-v1`) => ({ id, revisionID, version: 1, status: 'draft' } as ReviewItem);
test('synthesis selection is bounded, unique, and keeps the selected version', () => {
  assert.equal(selectionValid([review('a')]), false);
  assert.equal(selectionValid([review('a'), review('b')]), true);
  assert.equal(selectionValid([review('a'), review('a', 'a-v2')]), false);
  assert.equal(selectionValid(Array.from({ length: 11 }, (_, i) => review(String(i)))), false);
  assert.equal(draftMatchesSelection({ mode: '7.8', status: 'succeeded', revisionIDs: ['a-v1'] }, review('a')), true);
  for (const run of [{ mode: '7.8', status: 'failed', revisionIDs: ['a-v1'] }, { mode: '7.8', status: 'succeeded', revisionIDs: ['a-v2'] }, { mode: 'synthesis', status: 'succeeded', revisionIDs: ['a-v1', 'b-v1'] }]) assert.equal(draftMatchesSelection(run, review('a')), false);
  assert.deepEqual(removeSelection([review('a'), review('b')], [{ id: 'draft-a', reviewID: 'a' }, { id: 'draft-b', reviewID: 'b' }], 'a'), { reviews: [review('b')], drafts: [{ id: 'draft-b', reviewID: 'b' }] });
});
test('synthesis autosave preserves human text, frozen inputs, and dispositions across a retry', async () => {
  const data = { inputs: [{ revisionID: 'a-v1' }, { revisionID: 'b-v1' }], includedDraftIDs: [], summary: 'Faculty judgment', suggestions: '', proposals: [{ disposition: 'deferred' }], draftDisposition: 'rejected', dispositionRunID: 'older-run', status: 'draft' } as unknown as IdeaSynthesis;
  const record = { head: { version: 1 }, revision: { data } } as IdeaSavedRecord; let calls = 0;
  const saver = new SaveCoordinator<IdeaSynthesis>(record, async (_v, _key, value) => { if (++calls === 1) throw Error('offline'); return { ...record, head: { ...record.head, version: 2 }, revision: { ...record.revision, data: value } }; }, () => {});
  saver.edit({ ...saver.draft, summary: 'Faculty edits after a new AI run' }); await assert.rejects(saver.flush()); await saver.flush();
  assert.deepEqual(saver.draft.inputs, data.inputs); assert.equal(saver.draft.draftDisposition, 'rejected'); assert.equal(saver.draft.proposals[0].disposition, 'deferred'); assert.equal(saver.draft.summary, 'Faculty edits after a new AI run');
});
