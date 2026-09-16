import { createContentSource, type ContentSource } from './content-source.js';
import { claimSourceJob, processSourceJob } from './capture-service.js';
import { migrateIdea } from './migration-service.js';
/** Read-only capture/check worker. No AI submission or provider transport lives here. */
export function startCaptureWorker(source: ContentSource = createContentSource()) {
  const stop = new AbortController();
  const finished = (async () => {
    while (!stop.signal.aborted) {
      try {
        if (process.env.IDEA_WORKER_ENABLED === 'true') {
          await migrateIdea(true);
          const job = await claimSourceJob();
          if (job) { await processSourceJob(job, source, stop.signal); continue; }
        }
      } catch { /* A failed DB/migration check cannot start network work. Retry next tick. */ }
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); stop.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 2000); timer.unref();
        stop.signal.addEventListener('abort', done, { once: true }); if (stop.signal.aborted) done();
      });
    }
  })();
  return async () => { stop.abort(); await finished; };
}
