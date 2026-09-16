/** Nonsecret fixed release profile shared with the remediation deployment. */
export const IDEA_LIMITS = Object.freeze({
  inputBytes: 48_000, answerTokens: 8_000, reasoningTokens: 8_192,
  attemptTimeoutMs: 120_000, runTimeoutMs: 130_000,
  maxAttempts: 1, pagesPerSnapshot: 25, maxSynthesisReviews: 10,
  maxProposals: 100, noteChars: 4_000, summaryChars: 8_000,
  promptAdjustmentChars: 2_000,
});
export const IDEA_INFERENCE_PROFILE = Object.freeze({
  id: 'idea-openai-luna-v1',
  primary: Object.freeze({ provider: 'openai', model: 'gpt-5.6-luna', reasoningEffort: 'high' }),
});
