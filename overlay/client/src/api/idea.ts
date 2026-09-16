import axios from 'axios';
import type { IdeaSavedRecord, IdeaReview, IdeaSynthesis, IdeaSourceTree, IdeaSourceJobStatus, IdeaDraft, IdeaCategoryID } from '../types/idea';
export type Framework = { categories: { id: IdeaCategoryID; title: string; restorative: string; elements: { id: string; text: string }[]; rows: { id: string; exclusive: string; emerging: string; inclusive: string }[]; resources: { label: string; url: string }[] }[]; attribution: { title: string; author: string; url: string; license: { name: string; url: string } }; notApplicable: string };
export type Capabilities = { read: boolean; write: boolean; reviewEnabled: boolean; aiEnabled: boolean; captureEnabled: boolean; storageReady: boolean; profile: { primary: { model: string } }; disclosure: { version: string; text: string; cost: string }; remainingQuota: { scope: string; remainingRuns: number; remainingMicroUSD: number }[] | null };
export type Capture = IdeaSourceJobStatus & { captureState?: string; manifest?: { selected: { pageID: string; title: string }[]; failed?: unknown[]; pages?: { pageID: string; state: string; errorCode?: string }[]; limitations?: string[] } };
export type Run = { id: string; ownerUUID: string; mode: string; status: string; phase: string; output: IdeaDraft | null; revisionIDs: string[]; cancelRequested: boolean; error?: { code: string }; feedback: { version: number; disposition: string; note: string } | null; attempts: { provider: string; actualModel?: string; fallbackReason?: string; error?: { code: string }; usage?: { inputTokens?: number; outputTokens?: number } }[] };
export type Estimate = { estimateID: string; inputHash: string; expiresAt: string; budget: { reservationMicroUSD: number }; disclosure: Capabilities['disclosure']; manifest: { inputBytes: number; sources: { snapshotID: string; pageIDs: string[]; excludedPageIDs: string[] }[] } };
export type ReviewItem = { id: string; chapterTitle?: string; ownerUUID?: string; version: number; revisionID: string; status: string; archived: boolean; snapshotIDs: string[]; capabilities: { write: boolean } };
export function ideaAPI(projectID: string) {
  const root = `/projects/${encodeURIComponent(projectID)}/idea`;
  async function get<T>(path: string): Promise<T> { return (await axios.get(root + path)).data.data; }
  const pending = new Map<string, string>();
  async function post<T>(path: string, data: unknown): Promise<T> {
    if (data && typeof data === 'object' && 'idempotencyKey' in data) {
      const { idempotencyKey, ...payload } = data; const signature = path + JSON.stringify(payload);
      const key = pending.get(signature) ?? String(idempotencyKey); pending.set(signature, key);
      const result = (await axios.post(root + path, { ...payload, idempotencyKey: key })).data.data;
      pending.delete(signature); return result;
    }
    return (await axios.post(root + path, data)).data.data;
  }
  return { get, post, projectID,
    capabilities: () => get<Capabilities>('/capabilities'), framework: () => get<Framework>('/framework'),
    tree: () => get<IdeaSourceTree>('/source-tree'), capture: (id: string) => get<Capture>(`/captures/${id}`),
    reviews: (cursor?: string) => get<{ items: ReviewItem[]; nextCursor: string | null }>(`/reviews${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
    record: (id: string, kind: 'review' | 'synthesis' = 'review', revisionID?: string) => get<IdeaSavedRecord>(`/${kind === 'review' ? 'reviews' : 'syntheses'}/${id}${revisionID ? `?revisionID=${revisionID}` : ''}`),
    save: async (id: string, version: number, mutationID: string, review: IdeaReview): Promise<IdeaSavedRecord> => {
      const { schemaVersion, status, partialCaptureAcknowledged, ...changes } = review;
      return (await axios.patch(`${root}/reviews/${id}`, { ...changes, expectedVersion: version, mutationID })).data.data;
    },
    saveSynthesis: async (id: string, version: number, mutationID: string, data: IdeaSynthesis): Promise<IdeaSavedRecord> => {
      const { context, summary, suggestions, proposals, draftDisposition, dispositionRunID } = data;
      return (await axios.patch(`${root}/syntheses/${id}`, { context, summary, suggestions, proposals, draftDisposition, dispositionRunID, expectedVersion: version, mutationID })).data.data;
    },
    run: (id: string) => get<Run>(`/runs/${id}`),
    export: async (id: string, revisionID: string, format: 'json' | 'md', kind: 'review' | 'synthesis' = 'review') => (await axios.get(`${root}/exports/${kind}/${id}?revisionID=${revisionID}&format=${format}`, { responseType: 'blob' })).data as Blob,
  };
}
export const errorText = (error: unknown) => axios.isAxiosError(error) ? error.response?.data?.code || 'Connection failed. Your unsaved work is still here.' : error instanceof Error ? error.message : 'Unable to complete this action.';
export function download(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export const accessDenied = (error: unknown) => axios.isAxiosError(error) && [401, 403, 404].includes(error.response?.status ?? 0);
