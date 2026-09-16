import { IdeaDefinition, IdeaSnapshot, IdeaSourceCheck } from '../../../models/idea-models.js';
import { readRecord, selectedReview, authorizedRun } from './review-service.js';
import type { Actor } from './permission-service.js';
import type { Kind } from '../../../models/idea-models.js';
import { notFound, IdeaError } from './errors.js';
export async function exportRecord(actor: Actor, kind: Kind, id: string, revisionID: string) {
  const { head, revision } = await readRecord(actor, id, kind, revisionID);
  const selectedAssessments = [];
  if ('inputs' in revision.data) for (const input of revision.data.inputs) {
    const selected = await selectedReview(actor, input.revisionID, head.bookID);
    selectedAssessments.push({ ...input, label: 'Saved faculty assessment; not machine consensus', humanReview: selected.revision.data });
  }
  const snapshots = [];
  for (const id of revision.snapshotIDs) {
    const snapshot = await IdeaSnapshot.findOne({ _id: id, projectID: actor.projectID }).lean();
    if (!snapshot) throw notFound();
    const latestCheck = await IdeaSourceCheck.findOne({ projectID: actor.projectID, snapshotID: id }).sort({ checkedAt: -1 }).lean();
    snapshots.push({ ...snapshot, latestSourceCheck: latestCheck ? { state: latestCheck.state, checkedAt: latestCheck.checkedAt, result: latestCheck.result } : null });
  }
  const definitionIDs = [...new Set(snapshots.flatMap((s) => s.definitionIDs))];
  const definitions = await IdeaDefinition.find({ _id: { $in: definitionIDs } }).lean();
  if (definitions.length !== definitionIDs.length) throw new IdeaError(500, 'DEFINITION_MISSING');
  const includedDrafts = [];
  const draftIDs = new Set<string>('includedDraftIDs' in revision.data ? revision.data.includedDraftIDs : []);
  revision.data.proposals.forEach((p) => { if (p.originRunID) draftIDs.add(p.originRunID); });
  if ('answers' in revision.data) revision.data.answers.forEach((a) => { if (a.adoptedTextRunID) draftIDs.add(a.adoptedTextRunID); });
  if ('dispositionRunID' in revision.data && revision.data.dispositionRunID) draftIDs.add(revision.data.dispositionRunID);
  for (const id of draftIDs) {
    const run = await authorizedRun(actor, id);
    includedDrafts.push({ id: run._id, label: 'AI-generated draft; not a human judgment', revisionIDs: run.revisionIDs, mode: run.mode, output: run.output, status: run.status, attempts: (run.attempts as any[]).map((a) => ({ provider: a.provider, actualModel: a.actualModel, finish: a.finish, fallbackReason: a.fallbackReason, requestId: a.requestId, usage: a.usage ? { inputTokens: a.usage.inputTokens, outputTokens: a.usage.outputTokens, reasoningTokens: a.usage.reasoningTokens } : undefined, errorCode: a.error?.code })), profile: run.profile, inputHash: run.inputHash });
  }
  return { schemaVersion: 1, kind, projectID: head.projectID, bookID: head.bookID,
    assessorUUID: head.ownerUUID, headID: head._id, revisionID: revision._id, version: revision.version,
    savedAt: revision.createdAt, archivedAtRevision: revision.archived,
    humanReview: revision.data, selectedAssessments, snapshots, definitions, includedDrafts,
    limitations: ['Private faculty review; not certification or a public book rating.', 'Source freshness is unknown unless a successful comparison is recorded.', 'AI suggestions are drafts; accepted proposals do not change source content.'],
  };
}
/** One canonical representation drives both formats. Escape Markdown/HTML supplied by users. */
export function markdownExport(data: Awaited<ReturnType<typeof exportRecord>>) {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|])/g, '\\$1');
  const lines = [`# IDEA ${data.kind}`, '', `Assessor: ${data.assessorUUID}`, `Saved revision: ${data.revisionID} (v${data.version})`, '',
    ...data.limitations.map((s) => `- ${s}`), '', '## Saved record', ''];
  // Recursive rendering preserves all human fields, coverage, definitions and explicit drafts.
  const render = (value: unknown, indent = '') => {
    if (value instanceof Date) { lines.push(`${indent}${value.toISOString()}`); return; }
    if (Array.isArray(value)) { if (!value.length) lines.push(`${indent}(none)`); value.forEach((v, i) => { lines.push(`${indent}- Item ${i + 1}`); render(v, `${indent}  `); }); return; }
    if (value && typeof value === 'object') { for (const [k, v] of Object.entries(value)) { lines.push(`${indent}- ${escape(k)}:`); render(v, `${indent}  `); } return; }
    lines.push(`${indent}${escape(String(value ?? '(not recorded)')).replace(/\n/g, `\n${indent}`)}`);
  };
  render(data);
  return `${lines.join('\n')}\n`;
}
