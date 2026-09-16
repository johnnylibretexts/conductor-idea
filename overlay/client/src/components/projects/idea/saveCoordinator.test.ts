/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { SaveCoordinator } from './saveCoordinator';
import type { IdeaSavedRecord, IdeaReview } from '../../../types/idea';
const record = { head: { _id: 'review', version: 1 }, revision: { data: { summary: '', answers: [{ rating: 'not_rated' }] } }, capabilities: { write: true } } as unknown as IdeaSavedRecord;
const updated = (version: number, data: IdeaReview) => ({ ...record, head: { ...record.head, version }, revision: { ...record.revision, data } });
test('autosave serializes writes and retains edits made while a request is pending', async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); const writes: number[] = [];
  const saver = new SaveCoordinator(record, async (version, _key, data) => { writes.push(version); if (writes.length === 1) await gate; return updated(version + 1, data); }, () => {});
  saver.edit({ ...saver.draft, summary: 'First edit' }); const pending = saver.flush();
  saver.edit({ ...saver.draft, summary: 'Newer edit' }); release(); await pending;
  assert.deepEqual(writes, [1, 2]); assert.equal(saver.saved.head.version, 3); assert.equal(saver.draft.summary, 'Newer edit'); assert.equal(saver.dirty, false);
  assert.equal(saver.draft.answers[0].rating, 'not_rated');
});
test('ambiguous failure retries the original mutation before sending subsequent edits', async () => {
  const keys: string[] = []; const texts: string[] = []; let fail = true;
  const saver = new SaveCoordinator(record, async (version, key, data) => { keys.push(key); texts.push(data.summary); if (fail) { fail = false; throw Error('offline'); } return updated(version + 1, data); }, () => {});
  saver.edit({ ...saver.draft, summary: 'Original' }); await assert.rejects(saver.flush());
  saver.edit({ ...saver.draft, summary: 'Still here' }); await saver.flush();
  assert.equal(keys[0], keys[1]); assert.notEqual(keys[1], keys[2]); assert.deepEqual(texts, ['Original', 'Original', 'Still here']);
});
test('conflict resolution is explicit and uses the reviewed remote version', async () => {
  let versionSeen = 0; const saver = new SaveCoordinator(record, async (version, _key, data) => { versionSeen = version; return updated(version + 1, data); }, () => {});
  saver.edit({ ...saver.draft, summary: 'Local' }); saver.resolve(updated(4, { ...saver.draft, summary: 'Remote' }), true); await saver.flush(); assert.equal(versionSeen, 4); assert.equal(saver.draft.summary, 'Local');
  saver.edit({ ...saver.draft, summary: 'Discard me' }); saver.resolve(updated(6, { ...saver.draft, summary: 'Remote chosen' }), false); assert.equal(saver.draft.summary, 'Remote chosen'); assert.equal(saver.dirty, false);
});

test('a corrected field can replace an explicitly rejected validation payload', async () => {
  let calls = 0;
  const saver = new SaveCoordinator(record, async (version, _key, data) => { calls++; if (calls === 1) throw { response: { status: 422 } }; assert.equal(data.summary, 'Corrected'); return updated(version + 1, data); }, () => {});
  saver.edit({ ...saver.draft, summary: 'Invalid' }); await assert.rejects(saver.flush());
  saver.edit({ ...saver.draft, summary: 'Corrected' }); await saver.flush(); assert.equal(saver.dirty, false);
});
