/** Version 1 JSON contracts. No server, browser, or validation-library imports. */
export type IdeaCategoryID = '7.1' | '7.2' | '7.3' | '7.4' | '7.5' | '7.6' | '7.7' | '7.8';
export type IdeaTask = IdeaCategoryID | '7.7.1' | 'rubric' | 'followup' | 'synthesis';
export type IdeaRowID = '7.1.a' | '7.1.b' | '7.1.c' | '7.2.a' | '7.3.a' | '7.4.a' | '7.5.a' | '7.6.a' | '7.7.a' | '7.8.a';
export type IdeaRating = 'not_applicable' | 'exclusive' | 'emerging_inclusive' | 'inclusive';
export type HumanRating = IdeaRating | 'not_rated';
export type DraftRating = IdeaRating | 'not_assessed';
export type IdeaDestination = 'original_source' | 'adapted_copy' | 'instructor_supplement' | 'student_supplement';
export interface IdeaContext {
  discipline: string;
  intendedUse: 'original_platform' | 'downloaded_package' | 'lms_adaptation' | 'other';
  intendedExtent: 'selected_chapters' | 'whole_book';
  depth: 'requirements_only' | 'requirements_and_considerations';
  focus: IdeaCategoryID[];
  destination: IdeaDestination;
  licenseContext: string;
  promptAdjustment: string;
  regionalFocus: string;
}
export interface HumanAnswer {
  rowID: IdeaRowID;
  categoryID: IdeaCategoryID;
  rating: HumanRating;
  note: string;
  naRationale: string;
  adoptedTextRunID: string | null;
}
export interface IdeaReview {
  partialCaptureAcknowledged?: boolean;
  schemaVersion: 1;
  context: IdeaContext;
  answers: HumanAnswer[];
  checklist: { elementID: string; answer: 'yes' | 'no' | 'unsure' | 'skip' }[];
  demographicContextPercent: number | null;
  summary: string;
  suggestions: string;
  proposals: HumanProposal[];
  status: 'draft' | 'finished';
}
export interface EvidenceRef {
  snapshotID: string;
  pageID: string;
  blockID: string;
  /** Unicode code-point offsets into the immutable block's text. */
  start: number;
  end: number;
  quote: string;
}
export type IdeaSupport =
  | { kind: 'quoted'; evidence: EvidenceRef[] }
  | { kind: 'scope'; snapshotID: string; pageIDs: string[]; limitation: string };
export interface IdeaFinding {
  evidence: string;
  interpretation: string;
  recommendation: string;
  support: IdeaSupport;
}
export interface DraftRow {
  rowID: IdeaRowID;
  categoryID: IdeaCategoryID;
  rating: DraftRating;
  notes: string;
  support: IdeaSupport;
}
export interface DraftArea {
  categoryID: IdeaCategoryID;
  rating: DraftRating;
  notes: string;
  support: IdeaSupport;
}
export interface RevisionProposal {
  chapter: string;
  change: string;
  rationale: string;
  destination: IdeaDestination;
  priority: 'high' | 'medium' | 'low';
  support: IdeaSupport;
}
export interface HumanProposal extends RevisionProposal {
  id: string;
  originRunID: string | null;
  disposition: 'proposed' | 'accepted_for_plan' | 'rejected' | 'deferred';
}
interface DraftBase { schemaVersion: 1; summary: string; limitations: string[] }
export type IdeaDraft = DraftBase & (
  | { mode: 'rubric'; rows: DraftRow[] }
  | { mode: '7.1'; illustrations: { chapterSection: string; imageDescription: string; suggestedRevision: string; support: IdeaSupport }[] }
  | { mode: '7.2'; narrative: string; findings: IdeaFinding[] }
  | { mode: '7.3'; areas: DraftArea[]; rewrites: IdeaFinding[] }
  | { mode: '7.4'; narrative: string; findings: IdeaFinding[]; alternativeResearch: { title: string; primaryURL: string; explanation: string; verification: 'unverified' }[] }
  | { mode: '7.5'; scenarios: { scenario: string; representedPopulation: string; assumedSocialContext: string; diversityEvaluation: string; recommendation: string; support: IdeaSupport }[] }
  | { mode: '7.6'; terminology: { chapterSection: string; flaggedWording: string; historicalContext: string; suggestedRevision: string; support: IdeaSupport }[] }
  | { mode: '7.7'; areas: DraftArea[]; metadataChanges: { kind: 'glossary_entry' | 'cross_reference' | 'heading'; proposedText: string; support: IdeaSupport }[] }
  | { mode: '7.7.1'; areas: DraftArea[]; openingConcepts: IdeaFinding[]; endSummaries: IdeaFinding[]; additions: { chapter: string; missingTerms: string[]; proposedAdditions: string; support: IdeaSupport }[] }
  | { mode: '7.8'; missingPerspectives: RevisionProposal[]; presentStrengths: { perspective: string; location: string; support: IdeaSupport }[] }
  | { mode: 'followup'; focus: IdeaCategoryID | '7.7.1'; parentRunID: string; findings: IdeaFinding[] }
  | { mode: 'synthesis'; inputRevisionIDs: string[]; strengths: IdeaFinding[]; unevenApplication: IdeaFinding[]; unmetAreas: IdeaFinding[]; areas: DraftArea[]; plan: RevisionProposal[] }
);
export interface IdeaEvidenceBlock {
  ordinal?: number;
  sourceAnchor?: string;
  blockID: string;
  pageID: string;
  kind: 'text' | 'heading' | 'caption' | 'alt' | 'metadata';
  text: string;
}
export interface IdeaEvidenceSnapshot {
  snapshotID: string;
  chapterTitle: string;
  pageIDs: string[];
  excludedPageIDs: string[];
  blocks: IdeaEvidenceBlock[];
}

/** Persisted selection; newer human revisions do not change these inputs. */
export interface IdeaSynthesis {
  schemaVersion: 1;
  context: IdeaContext;
  inputs: { revisionID: string; headID: string; snapshotID: string; ownerUUID: string; version: number; status: 'draft' | 'finished' }[];
  includedDraftIDs: string[];
  draftDisposition: 'not_reviewed' | 'useful' | 'needs_correction' | 'rejected';
  dispositionRunID: string | null;
  summary: string;
  suggestions: string;
  proposals: HumanProposal[];
  status: 'draft' | 'finished';
}
export interface IdeaRecordCapabilities { read: boolean; write: boolean; archive: boolean }
export interface IdeaSavedRecord {
  head: {
    _id: string; kind: 'review' | 'synthesis'; projectID: string; bookID: string;
    ownerUUID: string; currentRevisionID: string; version: number; archived: boolean;
    createdAt: string; updatedAt: string;
  };
  revision: {
    _id: string; headID: string; parentRevisionID: string | null; version: number;
    actorUUID: string; reason: string; snapshotIDs: string[];
    data: IdeaReview | IdeaSynthesis; archived: boolean; createdAt: string;
  };
  capabilities?: IdeaRecordCapabilities;
}

export interface IdeaSourcePage {
  pageID: string;
  parentID: string | null;
  title: string;
  url: string;
  modified: string | null;
}
export interface IdeaSourceTree {
  bookID: string;
  rootID: string;
  nodes: IdeaSourcePage[];
  unsupportedBranches: boolean;
}
export interface IdeaSourceJobStatus {
  jobID: string;
  kind: 'capture' | 'check';
  state: 'queued' | 'running' | 'finalizing' | 'succeeded' | 'failed';
  completedPages: number;
  totalPages: number;
  requestedPages: number;
  excludedPageIDs: string[];
  unsupportedBranches: boolean;
  errorCode: string | null;
  snapshotID: string | null;
}
