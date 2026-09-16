export function reviewEnabled(projectID: string) {
  if (process.env.IDEA_REVIEW_ENABLED !== 'true') return false;
  try { const ids: unknown = JSON.parse(process.env.IDEA_PILOT_PROJECT_IDS || '[]'); return Array.isArray(ids) && ids.includes(projectID); }
  catch { return false; }
}
export const captureEnabled = (projectID: string) => reviewEnabled(projectID) && process.env.IDEA_WORKER_ENABLED === 'true';
