import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeIdeaProvider } from './fixtures/fake-provider.js';
import { chapters, context, draftFor } from './fixtures/chapters.js';
import { buildPrompt } from './prompts.js';
import { createReview, parseDraft } from './contracts.js';
import type { IdeaAIRequest, IdeaAIResponse } from '../../api/services/idea/ai-provider.js';

function request(): IdeaAIRequest {
  const prompt = buildPrompt({ mode: '7.8', context, snapshots: [chapters[0]] });
  return { runID: 'test-run', attemptID: 'primary', projectID: 'test-project', inputHash: prompt.manifest.inputHash,
    profileID: 'idea-openai-luna-v1', provider: 'openai', mode: prompt.mode,
    messages: prompt.messages, outputSchema: prompt.outputSchema, answerTokenLimit: 8000, reasoningAllowance: 8192 };
}
const response = (): IdeaAIResponse => ({ actualProvider: 'openai', actualModel: 'gpt-5.6-luna',
  text: JSON.stringify(draftFor('7.8')), finish: 'complete', usage: { inputTokens: 120, outputTokens: 200, reasoningTokens: 50 } });
test('test provider preserves structured results and usage without selecting faculty ratings', async () => {
  const review = createReview(context);
  const before = structuredClone(review);
  const provider = new FakeIdeaProvider([{ response: response() }]);
  const result = await provider.submit(request(), new AbortController().signal);
  assert.equal(parseDraft('7.8', JSON.parse(result.text)).mode, '7.8');
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 200, reasoningTokens: 50 });
  assert.deepEqual(review, before);
  assert.equal(provider.calls.length, 1);
});
test('test provider surfaces failures, truncation and refusal without adding retries', async () => {
  const provider = new FakeIdeaProvider([{ error: new Error('simulated timeout') }, { response: { ...response(), finish: 'length' } }, { response: { ...response(), text: '', finish: 'refused' } }]);
  await assert.rejects(provider.submit(request(), new AbortController().signal), /simulated timeout/);
  assert.equal(provider.calls.length, 1);
  assert.equal((await provider.submit(request(), new AbortController().signal)).finish, 'length');
  assert.equal((await provider.submit(request(), new AbortController().signal)).finish, 'refused');
  assert.equal(provider.available(), false);
});
test('abort before or during a fake request cancels without returning a late result', async () => {
  const provider = new FakeIdeaProvider([{ response: response(), delayMs: 1000 }]);
  const before = new AbortController(); before.abort();
  await assert.rejects(provider.submit(request(), before.signal), { name: 'AbortError' });
  assert.equal(provider.calls.length, 0);
  const during = new AbortController();
  const pending = provider.submit(request(), during.signal);
  during.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(provider.calls.length, 1);
});
