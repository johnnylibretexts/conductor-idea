import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentSource, boundedRead, boundedText, CAPTURE_LIMITS, selectCapture, type SourcePage } from '../../api/services/idea/content-source.js';
import { normalizePage } from '../../api/services/idea/normalizer.js';
const actor = { uuid: 'test-user', projectID: 'test-project', role: 'author' as const, bookID: 'bio:1' };
const page: SourcePage = { pageID: '2', parentID: '1', title: 'Chapter', url: 'https://bio.libretexts.org/Books/Chapter', modified: null };
export const html = (id = '2', text = '<p>Readable chapter</p>') => `<html><div id="pageIDHolder">${id}</div><main id="mt-content-container">${text}</main></html>`;
const metadata = (id: string, parent = '1', restriction = 'Public') => ({ '@id': id, title: `Page ${id}`, 'uri.ui': `https://bio.libretexts.org/Books/${id}`,
  ...(id !== '1' && { 'page.parent': { '@id': parent } }), security: { 'permissions.page': { restriction: { '#text': restriction } } } });
function fakeSource(extra: Record<string, unknown> = {}, tree: unknown = { page: { '@id': '1', subpages: { page: [{ '@id': '2' }, { '@id': '3', subpages: { page: { '@id': '4' } } }] } } }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    if (!String(url).includes('/@api/')) return new Response(html(), { headers: { 'content-type': 'text/html' } });
    const id = String(url).match(/\/pages\/(\d+)\//)![1];
    const data = String(url).includes('/tree?') ? tree : extra[id] || metadata(id, id === '4' ? '3' : '1', id === '3' ? 'Private' : 'Public');
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  };
  return { calls, source: createContentSource({ fetcher, headers: async () => ({ 'X-Deki-Token': 'test-metadata-only' }), allowed: async (lib) => lib === 'bio' }) };
}
test('discovery proves public ancestry and omits private descendants without their titles', async () => {
  const { source, calls } = fakeSource(); const tree = await source.discover(actor);
  assert.deepEqual(tree.nodes.map((p) => p.pageID), ['1','2']); assert.equal(tree.unsupportedBranches, true);
  assert.ok(!calls.some((c) => c.url.includes('/pages/4/')));
  assert.ok(!JSON.stringify(tree).includes('Page 3'));
});
test('metadata token never enters anonymous HTML requests; both transports reject redirects', async () => {
  const { source, calls } = fakeSource(); await source.page(actor, '2'); await source.html(page);
  const last = calls.at(-1)!; assert.deepEqual(last.init.headers, { Accept: 'text/html' });
  assert.equal(last.init.credentials, 'omit'); assert.equal(last.init.redirect, 'error');
  assert.ok(calls.slice(0, -1).every((c) => new Headers(c.init.headers).has('X-Deki-Token')));
  await assert.rejects(boundedRead(page.url, async () => new Response(null, { status: 302 }), {}, 'html'), { code: 'SOURCE_REDIRECT' });
});
test('unapproved libraries, external metadata URLs and unknown visibility fail closed', async () => {
  const { source } = fakeSource(); await assert.rejects(source.discover({ ...actor, bookID: 'attacker:1' }), { code: 'UNSUPPORTED_LIBRARY' });
  await assert.rejects(source.page(actor, '3'), { code: 'PUBLIC_VISIBILITY_UNCONFIRMED' });
  await assert.rejects(fakeSource({ '2': { ...metadata('2'), 'uri.ui': 'https://evil.test/book' } }).source.page(actor, '2'), { code: 'UNSUPPORTED_SOURCE_URL' });
  await assert.rejects(fakeSource({ '2': { ...metadata('2'), security: {} } }).source.page(actor, '2'), { code: 'PUBLIC_VISIBILITY_UNCONFIRMED' });
  await assert.rejects(fakeSource({ '2': metadata('2', '9'), '9': { ...metadata('9'), 'page.parent': undefined } }).source.page(actor, '2'), { code: 'PAGE_OUTSIDE_BOOK' });
});
test('tree overflow, truncation, cycles and moved children are explicit errors', async () => {
  await assert.rejects(fakeSource({}, { page: { '@id': '1', subpages: { page: Array.from({ length: 500 }, (_, i) => ({ '@id': String(i + 2) })) } } }).source.discover(actor), { code: 'TREE_SCOPE_TOO_LARGE' });
  await assert.rejects(fakeSource({}, { page: { '@id': '1', subpages: { '@count': '2', page: { '@id': '2' } } } }).source.discover(actor), { code: 'INCOMPLETE_TREE' });
  await assert.rejects(fakeSource({}, { page: { '@id': '1', subpages: { page: { '@id': '1' } } } }).source.discover(actor), { code: 'INVALID_TREE' });
  await assert.rejects(fakeSource({ '2': metadata('2', '9') }).source.discover(actor), { code: 'TREE_CHANGED' });
});
test('selection stays in the chapter, requires its root and caps total/supplement pages', () => {
  const tree = { bookID: actor.bookID, rootID: '2', unsupportedBranches: false, nodes: [{ ...page, parentID: null }, { ...page, pageID: '3', parentID: '2' }] };
  assert.deepEqual(selectCapture(tree, '2', ['2'], []).excluded.map((p) => p.pageID), ['3']);
  assert.throws(() => selectCapture(tree, '2', ['3'], []), { code: 'INVALID_CAPTURE_SELECTION' });
  assert.throws(() => selectCapture(tree, '2', ['2','99'], []), { code: 'INVALID_CAPTURE_SELECTION' });
  assert.throws(() => selectCapture(tree, '2', ['2'], [page]), { code: 'INVALID_CAPTURE_SELECTION' });
});
test('normalization preserves Unicode, captions, lists, tables, math and safe links without executable previews', () => {
  const result = normalizePage(html('2', '<h2 id="topic">Topic</h2><p>Hi 😀 <a href="https://example.test">reference</a></p><ul><li>A<ul><li>B</li></ul></li></ul><table><tr><th>X</th><td>Y</td></tr></table><figure><img src="https://tracking.test/pixel" alt="Team description"><figcaption>Caption</figcaption></figure><p><math><mi>x</mi><mo>+</mo><mn>1</mn></math></p><script>bad()</script><iframe src="https://evil.test">secret embed text</iframe><p hidden>Hidden</p><a href="javascript:bad()" onclick="bad()">unsafe link</a>'), page);
  const text = result.blocks.map((b) => b.text).join('\n');
  assert.match(text, /😀/); assert.match(text, /x\+1/); assert.ok(result.blocks.some((b) => b.kind === 'alt' && b.text === 'Team description'));
  assert.ok(result.blocks.some((b) => b.kind === 'caption' && b.text === 'Caption'));
  assert.ok(result.blocks.some((b) => b.kind === 'metadata' && b.text.includes('https://example.test')));
  assert.equal(text.match(/^B$/gm)?.length, 1); assert.ok(!/bad\(\)|Hidden|secret embed text/.test(text));
  assert.ok(!/<(?:script|iframe)\b|\s(?:src|onclick)=|javascript:/.test(result.preview)); assert.match(result.preview, /Embedded media omitted/);
  result.blocks.forEach((b, i) => assert.equal(b.blockID, `2:${i}`));
  assert.equal(normalizePage(html('2', '<p>same</p>'), page).contentHash, normalizePage(html('2', '<p>same</p>'), page).contentHash);
});
test('inert math source is retained as escaped text and missing alt is not fabricated evidence', () => {
  const result = normalizePage(html('2', '<p><script type="math/tex">x^2</script><img src="x"></p>'), page);
  assert.ok(result.blocks.some((b) => b.text === 'x^2'));
  assert.ok(!result.blocks.some((b) => b.kind === 'alt'));
  assert.ok(!result.preview.includes('<script'));
  assert.ok(result.limitations.some((s) => s.includes('no alt description')));
});
test('normalization rejects identity/root errors, marks empty pages and enforces size limits', () => {
  assert.throws(() => normalizePage(html('3'), page), { code: 'PAGE_ID_MISMATCH' });
  assert.throws(() => normalizePage(html() + '<div id="mt-content-container"></div>', page), { code: 'CONTENT_ROOT_AMBIGUOUS' });
  assert.throws(() => normalizePage(html() + '<div id="pageIDHolder">2</div>', page), { code: 'PAGE_ID_MISMATCH' });
  assert.throws(() => normalizePage(html('2', '<form action="/login"></form>'), page), { code: 'LOGIN_OR_ERROR_PAGE' });
  assert.equal(normalizePage(html('2', ''), page).blocks.length, 0);
  assert.equal(normalizePage(html('2', '').replace('id="mt-content-container"', 'class="mt-content-container"'), page).blocks.length, 0);
  assert.throws(() => normalizePage(html('2', 'x'.repeat(CAPTURE_LIMITS.pageTextBytes + 1)), page), { code: 'PAGE_TEXT_TOO_LARGE' });
});
test('bounded reads enforce decoded stream size, response type, timeout and transient status', async () => {
  await assert.rejects(boundedText(new Response('123456'), 5, new AbortController().signal), { code: 'SOURCE_TOO_LARGE' });
  await assert.rejects(boundedRead(page.url, async () => new Response('bad', { status: 503 }), {}, 'html'), { code: 'ANONYMOUS_READ_FAILED', retryable: true });
  await assert.rejects(boundedRead(page.url, async () => new Response('{}', { headers: { 'content-type': 'application/json' } }), {}, 'html'), { code: 'SOURCE_CONTENT_TYPE' });
  const hanging: typeof fetch = async (_u, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error('aborted'))));
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(boundedRead(page.url, hanging, {}, 'html', undefined, 5), { code: 'SOURCE_TIMEOUT' }); }
  finally { clearTimeout(keepAlive); }
});

// IDEA_LIBRARY_HOSTS lets a self-hosted demo mirror stand in for <library>.libretexts.org. Unset, nothing changes.
import { bookIdentity, libraryHost } from '../../api/services/idea/content-source.js';
const withHosts = async (value: string | undefined, fn: () => Promise<void> | void) => {
  const previous = process.env.IDEA_LIBRARY_HOSTS;
  if (value === undefined) delete process.env.IDEA_LIBRARY_HOSTS; else process.env.IDEA_LIBRARY_HOSTS = value;
  try { await fn(); } finally { if (previous === undefined) delete process.env.IDEA_LIBRARY_HOSTS; else process.env.IDEA_LIBRARY_HOSTS = previous; }
};
test('library host defaults to <library>.libretexts.org and follows IDEA_LIBRARY_HOSTS only for the named library', async () => {
  await withHosts(undefined, () => { assert.equal(bookIdentity('mirror:1').host, 'mirror.libretexts.org'); assert.equal(libraryHost('bio'), 'bio.libretexts.org'); });
  await withHosts('{"mirror":"library.libretexts.dev"}', () => {
    assert.equal(bookIdentity('mirror:1').host, 'library.libretexts.dev');
    assert.equal(bookIdentity('bio:1').host, 'bio.libretexts.org');
  });
});
test('an overridden library reads metadata and anonymous HTML from the configured host and nowhere else', async () => {
  await withHosts('{"mirror":"library.libretexts.dev"}', async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (url) => { calls.push(String(url));
      if (!String(url).includes('/@api/')) return new Response(html(), { headers: { 'content-type': 'text/html' } });
      const id = String(url).match(/\/pages\/(\d+)\//)![1];
      const data = String(url).includes('/tree?') ? { page: { '@id': '1', subpages: { page: { '@id': '2' } } } }
        : { ...metadata(id), 'uri.ui': `https://library.libretexts.dev/Books/${id}` };
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); };
    const source = createContentSource({ fetcher, headers: async () => ({ 'X-Deki-Token': 't' }), allowed: async (lib) => lib === 'mirror' });
    const mirrorActor = { ...actor, bookID: 'mirror:1' };
    const tree = await source.discover(mirrorActor);
    assert.deepEqual(tree.nodes.map((p) => p.url), ['https://library.libretexts.dev/Books/1', 'https://library.libretexts.dev/Books/2']);
    await source.html(tree.nodes[1]);
    assert.ok(calls.every((u) => u.startsWith('https://library.libretexts.dev/')), calls.join('\n'));
    await assert.rejects(source.html({ ...page, url: 'https://evil.test/Books/2' }), { code: 'UNSUPPORTED_SOURCE_URL' });
    await assert.rejects(source.html({ ...page, url: 'https://library.libretexts.dev.evil.test/Books/2' }), { code: 'UNSUPPORTED_SOURCE_URL' });
  });
});
test('malformed IDEA_LIBRARY_HOSTS fails closed instead of silently falling back', async () => {
  for (const bad of ['not json', '{"mirror":"https://library.libretexts.dev"}', '{"mirror":"library.libretexts.dev/path"}', '{"mirror":"Library.Libretexts.Dev"}', '{"Mirror!":"library.libretexts.dev"}', '[]']) {
    await withHosts(bad, () => assert.throws(() => bookIdentity('mirror:1'), { code: 'LIBRARY_HOSTS_MISCONFIGURED' }, bad));
  }
});
test('an overridden library never asks the library token generator; its metadata reads are anonymous', async () => {
  await withHosts('{"mirror":"library.libretexts.dev"}', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init: init! });
      if (!String(url).includes('/@api/')) return new Response(html(), { headers: { 'content-type': 'text/html' } });
      const id = String(url).match(/\/pages\/(\d+)\//)![1];
      const data = String(url).includes('/tree?') ? { page: { '@id': '1', subpages: { page: { '@id': '2' } } } }
        : { ...metadata(id), 'uri.ui': `https://library.libretexts.dev/Books/${id}` };
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); };
    // No `headers` option: the default header path is exercised. For a configured host it must not touch SSM.
    const source = createContentSource({ fetcher, allowed: async (lib) => lib === 'mirror' });
    const tree = await source.discover({ ...actor, bookID: 'mirror:1' });
    assert.equal(tree.nodes.length, 2);
    assert.ok(calls.length >= 2);
    assert.ok(calls.every((c) => !new Headers(c.init.headers).has('X-Deki-Token')), 'no library token may be sent to a demo mirror');
  });
});
