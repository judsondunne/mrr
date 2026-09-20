/**
 * HTML reading helpers.
 *
 * Every function here is total: a malformed page returns an empty result, it
 * never throws. A prospecting run must not die because one merchant ships
 * broken markup.
 */
import * as cheerio from 'cheerio';
import { createLogger } from '../../lib/logger.js';
import { domainToCompanyName } from './domain.js';

const logger = createLogger('prospecting:html');

/** Hard cap so one pathological page cannot blow up prompt size or memory. */
export const MAX_EXTRACTED_TEXT = 120_000;

type Api = cheerio.CheerioAPI;

function load(html: string): Api | null {
  try {
    return cheerio.load(html);
  } catch (err) {
    logger.warn('html parse failed', { err: String(err) });
    return null;
  }
}

/** Visible text with scripts, styles and other noise stripped. */
export function extractText(html: string): string {
  const $ = load(html);
  if (!$) return '';
  try {
    $('script, style, noscript, svg, iframe, template, link, meta').remove();
    const body = $('body');
    const raw = (body.length > 0 ? body.text() : $.root().text()) ?? '';
    const text = raw.replace(/\s+/g, ' ').trim();
    return text.length > MAX_EXTRACTED_TEXT ? text.slice(0, MAX_EXTRACTED_TEXT) : text;
  } catch (err) {
    logger.warn('html text extraction failed', { err: String(err) });
    return '';
  }
}

export function extractTitle(html: string): string | null {
  const $ = load(html);
  if (!$) return null;
  const title = $('title').first().text().replace(/\s+/g, ' ').trim();
  return title === '' ? null : title;
}

export function extractMeta(html: string, selectors: readonly string[]): string | null {
  const $ = load(html);
  if (!$) return null;
  for (const selector of selectors) {
    const value = $(selector).first().attr('content');
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

const ORG_TYPES = new Set([
  'organization',
  'localbusiness',
  'store',
  'onlinestore',
  'corporation',
  'retailstore',
  'foodestablishment',
  'restaurant',
  'brewery',
  'bakery',
]);

function jsonLdNames($: Api): string[] {
  const out: string[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).text();
    if (!raw || raw.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const queue: unknown[] = [parsed];
    while (queue.length > 0) {
      const node = queue.shift();
      if (Array.isArray(node)) {
        queue.push(...node);
        continue;
      }
      if (node === null || typeof node !== 'object') continue;
      const obj = node as Record<string, unknown>;
      const graph = obj['@graph'];
      if (Array.isArray(graph)) queue.push(...graph);
      const type = obj['@type'];
      const types = (Array.isArray(type) ? type : [type])
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.toLowerCase());
      const name = obj['name'];
      if (types.some((t) => ORG_TYPES.has(t)) && typeof name === 'string' && name.trim() !== '') {
        out.push(name.trim());
      }
    }
  });
  return out;
}

const TITLE_SEPARATORS = /\s+[|–—•·]\s+|\s+-\s+/;

/**
 * Best-effort company name: structured data first, then og:site_name, then the
 * document title, then the domain itself. Never fails.
 */
export function extractCompanyName(html: string, domain: string): string {
  const $ = load(html);
  if ($) {
    const structured = jsonLdNames($)[0];
    if (structured !== undefined && structured.length >= 2) return clampName(structured);
  }
  const meta = extractMeta(html, [
    'meta[property="og:site_name"]',
    'meta[name="application-name"]',
    'meta[name="apple-mobile-web-app-title"]',
    'meta[property="og:title"]',
  ]);
  if (meta !== null && meta.length >= 2) return clampName(meta);

  const title = extractTitle(html);
  if (title !== null) {
    const parts = title.split(TITLE_SEPARATORS).map((p) => p.trim()).filter((p) => p.length >= 2);
    const best = parts[parts.length - 1] !== undefined && parts.length > 1 ? pickNamePart(parts) : parts[0];
    if (best !== undefined && best.length >= 2) return clampName(best);
  }
  return domainToCompanyName(domain);
}

/** Titles read "Wholesale | Northfield Supply Co" as often as the reverse. */
function pickNamePart(parts: string[]): string | undefined {
  const generic = /^(home|shop|wholesale|trade|contact|about|products|store|official site|welcome)$/i;
  const named = parts.filter((p) => !generic.test(p));
  return named[named.length - 1] ?? parts[0];
}

function clampName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 120);
}

export interface PageLink {
  url: string;
  text: string;
}

/** Absolute, http(s)-only links with their anchor text. */
export function extractLinks(html: string, baseUrl: string): PageLink[] {
  const $ = load(html);
  if (!$) return [];
  const seen = new Set<string>();
  const out: PageLink[] = [];
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href');
    if (typeof href !== 'string') return;
    let abs: URL;
    try {
      abs = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
    abs.hash = '';
    const key = abs.toString();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: key, text: $(el).text().replace(/\s+/g, ' ').trim().slice(0, 120) });
  });
  return out;
}

/** `mailto:` targets, which are the strongest "this address is published" signal. */
export function extractMailtoAddresses(html: string): string[] {
  const $ = load(html);
  if (!$) return [];
  const out: string[] = [];
  $('a[href^="mailto:" i]').each((_i, el) => {
    const href = $(el).attr('href');
    if (typeof href !== 'string') return;
    const address = href.slice(href.indexOf(':') + 1).split('?')[0];
    if (address === undefined) return;
    const decoded = safeDecode(address).trim().toLowerCase();
    if (decoded !== '') out.push(decoded);
  });
  return out;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** True when the fetched page is a login wall rather than public content. */
export function looksLikeAuthWall(html: string, finalUrl: string): boolean {
  if (/\/(login|signin|sign-in|account\/login|auth|session|admin)(\/|\?|$)/i.test(finalUrl)) {
    return true;
  }
  const $ = load(html);
  if (!$) return false;
  const passwordFields = $('input[type="password" i]').length;
  if (passwordFields === 0) return false;
  const text = extractText(html).toLowerCase();
  // A storefront password page or a login-only page: no public content behind it.
  return /sign in|log in|login|password|members only|enter store using password/.test(text);
}
