import endpoints from '../../../util/CXOne/CXOnePageAPIEndpoints.js';
import Library from '../../../models/library.js';
import { IdeaError } from './errors.js';
import type { Actor } from './permission-service.js';

export const CAPTURE_LIMITS = Object.freeze({ nodes: 500, pages: 25, supplements: 5, depth: 50,
  fetchMs: 15_000, jobMs: 600_000, htmlBytes: 2 * 1024 * 1024,
  pageTextBytes: 256 * 1024, snapshotTextBytes: 2 * 1024 * 1024, concurrency: 2 });
export type { IdeaSourcePage as SourcePage, IdeaSourceTree as SourceTree } from '../../../../shared/idea.js';
import type { IdeaSourcePage as SourcePage, IdeaSourceTree as SourceTree } from '../../../../shared/idea.js';
export interface ContentSource {
  discover(actor: Actor, rootID?: string, signal?: AbortSignal): Promise<SourceTree>;
  page(actor: Actor, pageID: string, signal?: AbortSignal): Promise<SourcePage>;
  html(page: SourcePage, signal?: AbortSignal): Promise<string>;
}
const numeric = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,14}$/.test(v)) throw new IdeaError(422, 'INVALID_PAGE_ID');
  return v;
};
const LIBRARY = /^[a-z][a-z0-9-]{0,30}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/**
 * Demo-only seam: IDEA_LIBRARY_HOSTS='{"mirror":"library.libretexts.dev"}' points one library at a self-hosted
 * mirror that serves the same Deki page/security/tree JSON and page HTML. Unset, every library is <library>.libretexts.org.
 */
function libraryHosts(): Record<string, string> {
  const raw = process.env.IDEA_LIBRARY_HOSTS;
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new IdeaError(503, 'LIBRARY_HOSTS_MISCONFIGURED'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new IdeaError(503, 'LIBRARY_HOSTS_MISCONFIGURED');
  for (const [library, host] of Object.entries(parsed as Record<string, unknown>)) {
    if (!LIBRARY.test(library) || typeof host !== 'string' || !HOSTNAME.test(host)) throw new IdeaError(503, 'LIBRARY_HOSTS_MISCONFIGURED');
  }
  return parsed as Record<string, string>;
}
export function libraryHost(library: string): string {
  if (!LIBRARY.test(library)) throw new IdeaError(422, 'UNSUPPORTED_BOOK');
  return libraryHosts()[library] ?? `${library}.libretexts.org`;
}
/** True for <library>.libretexts.org and for any host explicitly configured in IDEA_LIBRARY_HOSTS. */
function allowedSourceHost(host: string): boolean {
  return /^[a-z][a-z0-9-]{0,30}\.libretexts\.org$/.test(host) || Object.values(libraryHosts()).includes(host);
}
export function bookIdentity(bookID: string) {
  const [library, coverID, extra] = bookID.split(':');
  if (extra !== undefined || !LIBRARY.test(library)) throw new IdeaError(422, 'UNSUPPORTED_BOOK');
  return { library, coverID: numeric(coverID), host: libraryHost(library) };
}
export function canonicalURL(value: unknown, host: string): string {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.host !== host || url.username || url.password || url.search || url.hash ||
        /^\/@(?:api|app|go)(?:\/|$)/i.test(url.pathname)) throw Error();
    return url.href;
  } catch { throw new IdeaError(422, 'UNSUPPORTED_SOURCE_URL'); }
}
export async function boundedText(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new IdeaError(413, 'SOURCE_TOO_LARGE'); }
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break; bytes += part.value.byteLength;
      if (bytes > limit) throw new IdeaError(413, 'SOURCE_TOO_LARGE'); chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
export async function boundedRead(url: string, fetcher: typeof fetch, headers: HeadersInit, type: 'html' | 'json', parent?: AbortSignal, timeoutMs: number = CAPTURE_LIMITS.fetchMs) {
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(parent ? [parent] : [])]);
  try {
    signal.throwIfAborted();
    const response = await fetcher(url, { method: 'GET', headers, redirect: 'error', credentials: 'omit', signal });
    if (response.redirected || (response.status >= 300 && response.status < 400)) { await response.body?.cancel(); throw new IdeaError(422, 'SOURCE_REDIRECT'); }
    if (!response.ok) {
      await response.body?.cancel();
      const transient = [408, 429, 500, 502, 503, 504].includes(response.status);
      throw new IdeaError(transient ? 503 : 422, type === 'html' ? 'ANONYMOUS_READ_FAILED' : 'METADATA_READ_FAILED', 'Source read failed', transient);
    }
    if (!(response.headers.get('content-type') || '').toLowerCase().includes(type === 'html' ? 'text/html' : 'json')) {
      await response.body?.cancel(); throw new IdeaError(422, 'SOURCE_CONTENT_TYPE');
    }
    return await boundedText(response, CAPTURE_LIMITS.htmlBytes, signal);
  } catch (e) {
    if (e instanceof IdeaError) throw e;
    if (parent?.aborted) throw new IdeaError(503, 'CAPTURE_INTERRUPTED', 'Capture interrupted', true);
    const cause = (e as { cause?: { message?: string } })?.cause?.message || '';
    if (/redirect/i.test(cause)) throw new IdeaError(422, 'SOURCE_REDIRECT');
    throw new IdeaError(503, signal.aborted ? 'SOURCE_TIMEOUT' : 'SOURCE_NETWORK_ERROR', 'Source unavailable', true);
  }
}
type ObjectJSON = Record<string, any>;
const object = (v: unknown): ObjectJSON => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new IdeaError(422, 'INVALID_METADATA'); return v as ObjectJSON; };
export const publicSecurity = (v: unknown) => {
  const security = v as ObjectJSON | undefined;
  const restriction = security?.['permissions.page']?.restriction;
  return ['Public', 'Semi-Public'].includes(typeof restriction === 'string' ? restriction : restriction?.['#text']);
};
/** Bounded GET transport reuses Conductor's token generator only for metadata. */
export function createContentSource(options: {
  fetcher?: typeof fetch; headers?: (library: string, signal?: AbortSignal) => Promise<HeadersInit | null>;
  allowed?: (library: string) => Promise<boolean>;
} = {}): ContentSource {
  const fetcher = options.fetcher || fetch;
  const allowed = options.allowed || (async (library) => Boolean(await Library.exists({ subdomain: library, hidden: false })));
  // A library pointed at a demo mirror by IDEA_LIBRARY_HOSTS is read anonymously: no SSM lookup, no library token.
  const getHeaders = options.headers || (async (library, signal) => library in libraryHosts()
    ? { Accept: 'application/json' }
    : (await import('../../../util/librariesclient.js')).generateAPIRequestHeaders(library, signal));
  async function identity(actor: Actor) { const identity = bookIdentity(actor.bookID); if (!await allowed(identity.library)) throw new IdeaError(422, 'UNSUPPORTED_LIBRARY'); return identity; }
  async function metadata(actor: Actor, id: string, endpoint: string, signal?: AbortSignal) {
    const { library, host } = await identity(actor); numeric(id);
    const deadline = AbortSignal.any([AbortSignal.timeout(CAPTURE_LIMITS.fetchMs), ...(signal ? [signal] : [])]);
    // The request deadline covers credential lookup as well as response/body reads.
    let abort: () => void = () => {};
    const unavailable = new Promise<never>((_resolve, reject) => { abort = () => reject(new IdeaError(503, 'METADATA_UNAVAILABLE', 'Metadata unavailable', true)); deadline.addEventListener('abort', abort, { once: true }); if (deadline.aborted) abort(); });
    try {
      const headers = await Promise.race([getHeaders(library, deadline), unavailable]);
      if (!headers) throw new IdeaError(503, 'METADATA_NOT_CONFIGURED');
      const raw = await boundedRead(`https://${host}/@api/deki/pages/${id}/${endpoint}`, fetcher, headers, 'json', deadline);
      try { return object(JSON.parse(raw)); } catch (e) { if (e instanceof IdeaError) throw e; throw new IdeaError(422, 'INVALID_METADATA'); }
    } finally { deadline.removeEventListener('abort', abort); }
  }
  async function publicPage(actor: Actor, id: string, signal?: AbortSignal): Promise<SourcePage> {
    const raw = await metadata(actor, id, endpoints.GET_Page, signal);
    if (raw['@id'] !== id || raw['@deleted'] === 'true' || raw['@virtual'] === 'true' || raw['@type']?.includes('redirect')) throw new IdeaError(422, 'INVALID_METADATA');
    const security = raw.security || await metadata(actor, id, endpoints.GET_Page_Security, signal);
    if (!publicSecurity(security)) throw new IdeaError(422, 'PUBLIC_VISIBILITY_UNCONFIRMED');
    if (typeof raw.title !== 'string' || raw.title.length > 4000) throw new IdeaError(422, 'INVALID_METADATA');
    return { pageID: id, parentID: raw['page.parent']?.['@id'] ? numeric(raw['page.parent']['@id']) : null,
      title: raw.title, url: canonicalURL(raw['uri.ui'], bookIdentity(actor.bookID).host), modified: typeof raw['date.modified'] === 'string' ? raw['date.modified'] : null };
  }
  async function withinBook(actor: Actor, id: string, signal?: AbortSignal) {
    const { coverID } = await identity(actor); const start = await publicPage(actor, id, signal);
    let current = start; const seen = new Set<string>();
    while (current.pageID !== coverID) {
      if (!current.parentID || seen.has(current.pageID) || seen.size >= CAPTURE_LIMITS.depth) throw new IdeaError(422, 'PAGE_OUTSIDE_BOOK');
      seen.add(current.pageID); current = await publicPage(actor, current.parentID, signal);
    }
    return start;
  }
  return {
    page: withinBook,
    async discover(actor, rootID, signal) {
      const root = await withinBook(actor, rootID || bookIdentity(actor.bookID).coverID, signal);
      const raw = await metadata(actor, root.pageID, endpoints.GET_Page_Tree, signal);
      const rootNode = object(raw.page); const pending: { id: string; parentID: string | null }[] = [];
      const seen = new Set<string>();
      function flatten(raw: ObjectJSON, parentID: string | null, depth: number) {
        const id = numeric(raw['@id']); if (seen.has(id) || depth > CAPTURE_LIMITS.depth) throw new IdeaError(422, 'INVALID_TREE');
        seen.add(id); if (seen.size > CAPTURE_LIMITS.nodes) throw new IdeaError(413, 'TREE_SCOPE_TOO_LARGE', 'Choose a smaller chapter root within this book');
        pending.push({ id, parentID });
        const pages = raw.subpages?.page; const children = pages === undefined ? [] : Array.isArray(pages) ? pages : [object(pages)];
        const count = raw.subpages?.['@count'];
        if (count !== undefined && Number(count) !== children.length) throw new IdeaError(422, 'INCOMPLETE_TREE');
        children.forEach((c: unknown) => flatten(object(c), id, depth + 1));
      }
      flatten(rootNode, null, 0); if (pending[0].id !== root.pageID) throw new IdeaError(422, 'INVALID_TREE');
      const visible = new Map<string, SourcePage>([[root.pageID, { ...root, parentID: null }]]); let unsupportedBranches = false;
      // Parent-first traversal prevents revealing descendants of a private/unknown ancestor.
      for (const node of pending.slice(1)) {
        if (!visible.has(node.parentID!)) continue;
        try {
          const page = await publicPage(actor, node.id, signal);
          if (page.parentID !== node.parentID) throw new IdeaError(422, 'TREE_CHANGED');
          visible.set(node.id, page);
        } catch (e) { if (e instanceof IdeaError && e.code === 'PUBLIC_VISIBILITY_UNCONFIRMED') unsupportedBranches = true; else throw e; }
      }
      return { bookID: actor.bookID, rootID: root.pageID, nodes: [...visible.values()], unsupportedBranches };
    },
    async html(page, signal) {
      const host = new URL(page.url).host;
      if (!allowedSourceHost(host)) throw new IdeaError(422, 'UNSUPPORTED_SOURCE_URL');
      canonicalURL(page.url, host);
      // Deliberately no shared headers, cookie jar, tokens, or privileged content fallback.
      return boundedRead(page.url, fetcher, { Accept: 'text/html' }, 'html', signal);
    },
  };
}
export function selectCapture(tree: SourceTree, chapterRootID: string, pageIDs: string[], supplements: SourcePage[]) {
  if (!tree.nodes.some((p) => p.pageID === chapterRootID)) throw new IdeaError(422, 'CHAPTER_NOT_IN_TREE');
  const descendants = new Set([chapterRootID]);
  for (const p of tree.nodes) if (p.parentID && descendants.has(p.parentID)) descendants.add(p.pageID);
  if (!pageIDs.includes(chapterRootID) || pageIDs.some((id) => !descendants.has(id)) ||
      supplements.length > CAPTURE_LIMITS.supplements || supplements.some((p) => descendants.has(p.pageID)) ||
      new Set([...pageIDs, ...supplements.map((p) => p.pageID)]).size !== pageIDs.length + supplements.length) throw new IdeaError(422, 'INVALID_CAPTURE_SELECTION');
  if (pageIDs.length + supplements.length > CAPTURE_LIMITS.pages) throw new IdeaError(413, 'CAPTURE_SCOPE_TOO_LARGE');
  return { selected: [...tree.nodes.filter((p) => pageIDs.includes(p.pageID)), ...supplements],
    excluded: tree.nodes.filter((p) => descendants.has(p.pageID) && !pageIDs.includes(p.pageID)),
    unsupportedBranches: tree.unsupportedBranches };
}
