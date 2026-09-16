import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { ideaAPI } from './idea';

test('IDEA requests use Conductor shared API prefix exactly once', async () => {
  const baseURL = axios.defaults.baseURL, adapter = axios.defaults.adapter;
  const urls: string[] = [];
  axios.defaults.baseURL = '/api/v1';
  axios.defaults.adapter = async (config) => {
    urls.push(axios.getUri(config));
    return { data: { data: {} }, status: 200, statusText: 'OK', headers: {}, config };
  };
  try {
    const api = ideaAPI('project one');
    await api.capabilities();
    await api.post('/reviews', { idempotencyKey: 'test', context: {} });
    await api.export('review', 'revision', 'json');
    assert.deepEqual(urls, [
      '/api/v1/projects/project%20one/idea/capabilities',
      '/api/v1/projects/project%20one/idea/reviews',
      '/api/v1/projects/project%20one/idea/exports/review/review?revisionID=revision&format=json',
    ]);
  } finally { axios.defaults.baseURL = baseURL; axios.defaults.adapter = adapter; }
});
