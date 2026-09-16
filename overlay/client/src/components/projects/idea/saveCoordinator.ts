import type { IdeaReview, IdeaSynthesis, IdeaSavedRecord } from '../../../types/idea';
/** Serialize writes; retry the identical mutation after an ambiguous network failure. */
export class SaveCoordinator<T extends IdeaReview | IdeaSynthesis = IdeaReview> {
  draft: T;
  saved: IdeaSavedRecord;
  dirty = false;
  error: unknown;
  private generation = 0;
  private pending?: { data: T; version: number; mutationID: string; generation: number };
  private running?: Promise<void>;
  constructor(saved: IdeaSavedRecord, private write: (version: number, mutationID: string, data: T) => Promise<IdeaSavedRecord>, private notify: () => void) { this.saved = saved; this.draft = structuredClone(saved.revision.data as T); }
  edit(data: T) { this.draft = data; this.dirty = true; this.generation++; this.notify(); }
  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = undefined; this.notify(); }); return this.running;
  }
  private async drain() {
    while (this.dirty) {
      this.pending ??= { data: structuredClone(this.draft), version: this.saved.head.version, mutationID: crypto.randomUUID(), generation: this.generation };
      try {
        const saved = await this.write(this.pending.version, this.pending.mutationID, this.pending.data);
        this.saved = { ...saved, capabilities: this.saved.capabilities }; this.dirty = this.generation !== this.pending.generation;
        this.pending = undefined; this.error = undefined; this.notify();
      } catch (error) {
        // A validation rejection never committed. Let a corrected draft replace it;
        // ambiguous network failures must retain the exact original mutation.
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status === 422 || status === 413) this.pending = undefined;
        this.error = error; this.notify(); throw error;
      }
    }
  }
  resolve(remote: IdeaSavedRecord, keepMine: boolean) {
    this.saved = remote; this.pending = undefined; this.error = undefined;
    if (!keepMine) { this.draft = structuredClone(remote.revision.data as T); this.dirty = false; }
    else { this.generation++; this.dirty = true; }
    this.notify();
  }
}
