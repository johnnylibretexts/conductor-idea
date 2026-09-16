/** Shared JSON types only; the client does not import server-side Zod. */
export type {
  IdeaCategoryID, IdeaTask, IdeaRowID, IdeaRating, HumanRating, DraftRating,
  IdeaContext, HumanAnswer, IdeaReview, EvidenceRef, IdeaSupport, IdeaFinding,
  DraftRow, DraftArea, RevisionProposal, HumanProposal, IdeaDraft,
  IdeaSourcePage, IdeaSourceTree, IdeaSourceJobStatus,
  IdeaSynthesis, IdeaSavedRecord, IdeaRecordCapabilities,
  IdeaEvidenceBlock, IdeaEvidenceSnapshot, IdeaDestination,
} from '../../../shared/idea';
