import { load } from 'cheerio';
import sanitizeHTML from 'sanitize-html';
import { createHash } from 'node:crypto';
import { CAPTURE_LIMITS, type SourcePage } from './content-source.js';
import { IdeaError } from './errors.js';
import type { IdeaEvidenceBlock } from '../../../../shared/idea.js';
export const NORMALIZATION_VERSION = 'idea-text-v1';
export interface EvidenceBlock extends IdeaEvidenceBlock { ordinal: number; sourceAnchor?: string }
export interface NormalizedPage { blocks: EvidenceBlock[]; preview: string; textBytes: number; contentHash: string; limitations: string[] }
const clean = (v: string) => v.replace(/\s+/gu, ' ').trim();
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function normalizePage(html: string, source: SourcePage): NormalizedPage {
  if (Buffer.byteLength(html) > CAPTURE_LIMITS.htmlBytes) throw new IdeaError(413, 'SOURCE_TOO_LARGE');
  const $ = load(html); const holders = $('[id="pageIDHolder"]');
  if (holders.length !== 1 || !/^[1-9][0-9]*$/.test(holders.text().trim()) || holders.text().trim() !== source.pageID)
    throw new IdeaError(422, 'PAGE_ID_MISMATCH');
  const idRoots = $('[id="mt-content-container"]'); const roots = idRoots.length ? idRoots : $('.mt-content-container');
  if (roots.length !== 1) throw new IdeaError(422, 'CONTENT_ROOT_AMBIGUOUS');
  if ($('form[action*="authenticate"], form[action*="login"], .mt-error-message, #deki-error').length) throw new IdeaError(422, 'LOGIN_OR_ERROR_PAGE');
  const root = roots.first().clone();
  root.find('script[type]').each((_i, el) => {
    if (/^math\/(?:tex|asciimath)(?:\s*;\s*mode=display)?$/i.test($(el).attr('type') || ''))
      $(el).replaceWith($('<span></span>').text($(el).text()));
  });
  root.find('script,style,noscript,template,form,input,button,select,textarea,base,link,meta').remove();
  root.find('[hidden], [aria-hidden="true"], [style]').each((_i, el) => {
    if ($(el).is('[hidden], [aria-hidden="true"]') || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test($(el).attr('style') || '')) $(el).remove();
  });
  const limitations = ['Text-only capture; image identity and embedded media content were not assessed.'];
  root.find('iframe,video,audio,object,embed,canvas,svg').each((_i, el) => {
    const placeholder = $('<span></span>').attr('data-idea-media', 'true').text('[Embedded media omitted]');
    $(el).replaceWith(placeholder);
  });
  root.find('source,track').remove();
  root.find('img').each((_i, el) => {
    const alt = clean($(el).attr('alt') || '');
    if (!alt) limitations.push('An image has no alt description; no image evidence text was supplied.');
    $(el).replaceWith($('<span></span>').attr(alt ? 'data-idea-alt' : 'data-idea-media', 'true').text(alt || '[Image has no alt description]'));
  });
  // Keep readable text and HTTPS links only; generated preview never loads media/scripts.
  root.find('a').each((_i, el) => {
    try {
      const url = new URL($(el).attr('href') || '', source.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw Error();
      $(el).attr('href', url.href);
    } catch { $(el).removeAttr('href'); }
  });
  const blocks: EvidenceBlock[] = [];
  function emit(text: string, kind: EvidenceBlock['kind'], anchor?: string) {
    text = clean(text); if (!text) return;
    const ordinal = blocks.length;
    blocks.push({ blockID: `${source.pageID}:${ordinal}`, pageID: source.pageID, ordinal, kind, text,
      ...(anchor && /^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/.test(anchor) ? { sourceAnchor: anchor } : {}) });
  }
  // Flush at semantic boundaries so nested lists/tables do not duplicate their children.
  const boundaries = new Set(['p','div','section','article','h1','h2','h3','h4','h5','h6','li','dt','dd','tr','figcaption','caption','blockquote','pre','ul','ol','table','thead','tbody','tfoot','figure']);
  function visit(node: any, kind: EvidenceBlock['kind'] = 'text', anchor?: string) {
    if (node.type === 'text') { emit(node.data, kind, anchor); return; }
    if (!node.name) return;
    const el = $(node); anchor = el.attr('id') || anchor;
    if (el.attr('data-idea-media')) return;
    if (el.attr('data-idea-alt')) { emit(el.text(), 'alt', anchor); return; }
    if (/^h[1-6]$/.test(node.name)) kind = 'heading';
    if (['figcaption','caption'].includes(node.name)) kind = 'caption';
    let text = '';
    const flush = () => { emit(text, kind, anchor); text = ''; };
    for (const child of node.children || []) {
      if (child.type === 'text') { text += child.data; continue; }
      if (child.type !== 'tag') continue;
      const c = $(child);
      if (boundaries.has(child.name) || c.attr('data-idea-alt') || c.attr('data-idea-media') || c.find('[data-idea-alt], [data-idea-media]').length) {
        flush(); visit(child, kind, anchor);
      } else {
        // Textual math, inline notation and link labels remain readable.
        text += child.name === 'br' ? '\n' : ` ${c.text()} `;
      }
    }
    flush();
  }
  visit(root[0]);
  // Record explicit link destinations as source metadata, without fetching them.
  root.find('a[href]').each((_i, el) => {
    emit(`${clean($(el).text())} (${$(el).attr('href')})`, 'metadata', $(el).attr('id'));
  });
  const textBytes = blocks.reduce((n, b) => n + Buffer.byteLength(b.text), 0);
  if (textBytes > CAPTURE_LIMITS.pageTextBytes) throw new IdeaError(413, 'PAGE_TEXT_TOO_LARGE');
  const preview = sanitizeHTML(root.html() || '', {
    allowedTags: ['p','div','section','article','h1','h2','h3','h4','h5','h6','ul','ol','li','dl','dt','dd','table','thead','tbody','tfoot','tr','th','td','caption','figure','figcaption','blockquote','pre','code','strong','em','b','i','sub','sup','br','span','a','math','mi','mn','mo','mrow','msup','msub','mfrac','annotation'],
    allowedAttributes: { a: ['href'], th: ['scope','colspan','rowspan'], td: ['colspan','rowspan'] },
    allowedSchemes: ['https'], allowProtocolRelative: false,
  });
  if (Buffer.byteLength(preview) + textBytes > 3 * 1024 * 1024) throw new IdeaError(413, 'PAGE_PREVIEW_TOO_LARGE');
  return { blocks, preview, textBytes, contentHash: digest({ version: NORMALIZATION_VERSION, blocks, preview }), limitations };
}
