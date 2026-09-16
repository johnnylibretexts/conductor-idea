import OpenAI from 'openai';
import type { IdeaAIProvider, IdeaAIRequest, IdeaAIResponse } from './ai-provider.js';
import { IDEA_INFERENCE_PROFILE } from '../../../util/idea/config.js';

export class ProviderError extends Error {
  constructor(public code: string, public fallbackEligible: boolean, public status?: number) { super(code); }
}
export const eligibleStatus = (status: number) => [401, 404, 408, 409, 425, 429].includes(status) || status >= 500;
export function providerConfiguration(env: NodeJS.ProcessEnv = process.env) {
  // Reuse Remedy's centrally managed Luna settings; its primary/Ollama settings
  // are unrelated to IDEA while Ollama is excluded.
  const expected: Record<string, string> = {
    REMEDY_FALLBACK_PROVIDER: 'openai', REMEDY_FALLBACK_BASE_URL: 'https://api.openai.com/v1',
    REMEDY_FALLBACK_TEXT_MODEL: 'gpt-5.6-luna', REMEDY_FALLBACK_REASONING_EFFORT: 'high',
    REMEDY_FALLBACK_REASONING_TOKEN_BUDGET: '8192',
  };
  const valid = Object.entries(expected).every(([key, value]) => env[key] === undefined || env[key] === value);
  return { valid, primary: valid && Boolean(env.OPENAI_API_KEY?.trim()) };
}
/** Native schema is a transport constraint; the complete original Zod schema is always checked locally. */
export function nativeSchema(value: unknown): any {
  if (Array.isArray(value)) return value.map(nativeSchema);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (['$schema', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'format', 'minItems', 'maxItems'].includes(key)) continue;
    if (key === 'const') result.enum = [item];
    else result[key === 'oneOf' ? 'anyOf' : key] = nativeSchema(item);
  }
  if (result.type === 'object') {
    result.additionalProperties = false;
    const required = result.required ?? [];
    for (const [key, schema] of Object.entries(result.properties ?? {})) if (!required.includes(key)) result.properties[key] = { anyOf: [schema, { type: 'null' }] };
    result.required = Object.keys(result.properties ?? {});
  }
  return result;
}
function token(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
export function finalResponse(raw: any, provider: IdeaAIRequest['provider']): IdeaAIResponse {
  const choice = raw?.choices?.[0];
  if (typeof raw?.model !== 'string' || raw.model.length > 200) throw new ProviderError('INVALID_PROVIDER_RESPONSE', true);
  const refused = Boolean(choice?.message?.refusal) || choice?.finish_reason === 'content_filter';
  return {
    ...(typeof raw.id === 'string' && raw.id.length <= 200 ? { requestId: raw.id } : {}),
    actualProvider: provider, actualModel: raw.model,
    text: typeof choice?.message?.content === 'string' ? choice.message.content : '',
    finish: refused ? 'refused' : choice?.finish_reason === 'stop' ? 'complete' : 'length',
    usage: { inputTokens: token(raw?.usage?.prompt_tokens), outputTokens: token(raw?.usage?.completion_tokens), reasoningTokens: token(raw?.usage?.completion_tokens_details?.reasoning_tokens) },
  };
}
function boundedTransport(transport: typeof fetch): typeof fetch {
  return async (url, init) => {
    const response = await transport(url, { ...init, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); return new Response('{}', { status: response.status, headers: { 'content-type': 'application/json' } }); }
    const reader = response.body?.getReader(); if (!reader) throw new ProviderError('EMPTY_RESPONSE', true);
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new ProviderError('RESPONSE_TOO_LARGE', false); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: { 'content-type': 'application/json' } });
  };
}
export function createProviders(env: NodeJS.ProcessEnv = process.env, transport: typeof fetch = fetch): Record<IdeaAIRequest['provider'], IdeaAIProvider> {
  return {
    openai: {
      available: () => providerConfiguration(env).primary,
      async submit(input, signal) {
        if (!providerConfiguration(env).primary) throw new ProviderError('PROVIDER_UNAVAILABLE', true);
        try {
          const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout: 120000, logLevel: 'off', fetchOptions: { redirect: 'error' }, fetch: boundedTransport(transport) });
          const result = await client.chat.completions.create({
            model: IDEA_INFERENCE_PROFILE.primary.model, messages: input.messages,
            max_completion_tokens: 16192, reasoning_effort: 'high', store: false, stream: false,
            response_format: { type: 'json_schema', json_schema: { name: 'idea_crosswalk', strict: true, schema: nativeSchema(input.outputSchema) } },
          }, { signal, maxRetries: 0 });
          return finalResponse(result, 'openai');
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          if (error instanceof Error && error.cause instanceof ProviderError) throw error.cause;
          if (error instanceof OpenAI.APIError && error.status) throw new ProviderError('PROVIDER_HTTP_ERROR', eligibleStatus(error.status), error.status);
          throw new ProviderError(signal.aborted ? 'PROVIDER_ABORTED' : 'PROVIDER_TRANSPORT_ERROR', true);
        }
      },
    },
  };
}
