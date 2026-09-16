import type { IdeaTask } from '../../../../shared/idea.js';

/** One attempt only. The durable worker owns execution; no automatic retry or fallback. */
export interface IdeaAIRequest {
  runID: string;
  attemptID: string;
  projectID: string;
  inputHash: string;
  profileID: 'idea-openai-luna-v1';
  provider: 'openai';
  mode: IdeaTask;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  outputSchema: Record<string, unknown>;
  answerTokenLimit: 8000;
  reasoningAllowance: 8192;
}
export interface IdeaAIResponse {
  requestId?: string;
  actualProvider: IdeaAIRequest['provider'];
  actualModel: string;
  text: string;
  finish: 'complete' | 'length' | 'refused';
  usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number };
}
export interface IdeaAIProvider {
  available(): boolean;
  submit(input: IdeaAIRequest, signal: AbortSignal): Promise<IdeaAIResponse>;
}
