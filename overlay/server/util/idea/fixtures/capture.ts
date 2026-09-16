/** Original synthetic pages; this source adapter is imported only by tests. */
import { IdeaError } from '../../../api/services/idea/errors.js';
import type { ContentSource, SourcePage } from '../../../api/services/idea/content-source.js';
export const captureHTML = (id: string, content = `<p>Fictional chapter ${id}: community perspectives.</p>`) => `<div id="pageIDHolder">${id}</div><main id="mt-content-container">${content}</main>`;
export function captureFixture() {
  const pages: SourcePage[] = ['10','11','12'].map((id) => ({ pageID: id, parentID: id === '10' ? null : '10', title: `Fictional ${id}`, url: `https://bio.libretexts.org/Fictional/${id}`, modified: null }));
  const html = new Map(pages.map((p) => [p.pageID, captureHTML(p.pageID)]));
  const calls: string[] = []; const failures = new Map<string, number>(); let active = 0; let peak = 0;
  const source: ContentSource = {
    async discover(actor, rootID) {
      return { bookID: actor.bookID, rootID: rootID || '10', nodes: structuredClone(pages), unsupportedBranches: false };
    },
    async page(_actor, id) { const page = pages.find((p) => p.pageID === id); if (!page) throw new IdeaError(422, 'PAGE_REMOVED'); return structuredClone(page); },
    async html(page, signal) {
      calls.push(page.pageID); active++; peak = Math.max(peak, active);
      try {
        await new Promise((r) => setTimeout(r, 2)); signal?.throwIfAborted();
        if ((failures.get(page.pageID) || 0) > 0) { failures.set(page.pageID, failures.get(page.pageID)! - 1); throw new IdeaError(503, 'SOURCE_TIMEOUT', 'Test timeout', true); }
        return html.get(page.pageID)!;
      } finally { active--; }
    },
  };
  return { pages, html, calls, failures, source, peak: () => peak };
}
