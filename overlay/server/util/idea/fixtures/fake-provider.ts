/** Test fixture only. No registration, network access, env switch or real credential support. */
import type { IdeaAIProvider, IdeaAIRequest, IdeaAIResponse } from '../../../api/services/idea/ai-provider.js';

export type FakeStep = { response: IdeaAIResponse; delayMs?: number } | { error: Error; delayMs?: number };
export class FakeIdeaProvider implements IdeaAIProvider {
  readonly calls: IdeaAIRequest[] = [];
  constructor(private readonly steps: FakeStep[]) {}
  available(): boolean { return this.steps.length > 0; }
  async submit(input: IdeaAIRequest, signal: AbortSignal): Promise<IdeaAIResponse> {
    signal.throwIfAborted();
    const step = this.steps.shift();
    if (!step) throw new Error('Fake provider script exhausted');
    this.calls.push(structuredClone(input));
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, step.delayMs ?? 0);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
    if ('error' in step) throw step.error;
    return structuredClone(step.response);
  }
}
