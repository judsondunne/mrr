/**
 * Inbound email parsing.
 *
 * Inbound mail is UNTRUSTED INPUT. It is never rendered, never interpreted as
 * markup, and never evaluated. HTML is reduced to text by stripping tags — the
 * result is stored as data and nothing downstream treats it as anything else.
 *
 * Quoted history and signatures are removed deterministically so the classifier
 * reads what the person actually wrote, not a copy of our own email.
 */

const MAX_STORED_CHARS = 20_000;

/**
 * Tag-stripping, not HTML parsing. Script/style contents are dropped wholesale
 * so nothing executable survives into the database.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Lines that mark the start of quoted history in every common mail client. */
const QUOTE_MARKERS: readonly RegExp[] = [
  /^\s*on .{5,120}\bwrote:\s*$/i,
  /^\s*-{2,}\s*original message\s*-{2,}\s*$/i,
  /^\s*_{5,}\s*$/,
  /^\s*from:\s*.+$/i,
  /^\s*sent from my \w+/i,
  /^\s*>{1,}/,
  /^\s*\|\s*unsubscribe/i,
];

/** A `-- ` line, or a closing salutation followed only by contact details. */
const SIGNATURE_START = /^\s*(--\s*$|—\s*$|thanks[,!.]?\s*$|thank you[,!.]?\s*$|best[,!.]?\s*$|best regards[,!.]?\s*$|regards[,!.]?\s*$|cheers[,!.]?\s*$|sincerely[,!.]?\s*$|sent from )/i;

const CONTACT_LINE =
  /(^\s*$|@|https?:\/\/|www\.|\+?\d[\d\s().-]{6,}|\b(ceo|founder|owner|manager|director|llc|inc\.?|ltd\.?)\b)/i;

export function stripQuotedHistory(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (QUOTE_MARKERS.some((re) => re.test(line))) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

export function stripSignature(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!SIGNATURE_START.test(line)) continue;
    // Everything after the marker must look like contact details, otherwise it
    // is real content that happens to start with "Thanks,".
    const rest = lines.slice(i + 1);
    const looksLikeSignature = rest.length <= 6 && rest.every((l) => CONTACT_LINE.test(l) || l.trim().split(/\s+/).length <= 4);
    if (looksLikeSignature) return lines.slice(0, i).join('\n').trim();
  }
  return text.trim();
}

export interface ParsedInbound {
  /** What the human actually wrote, for classification. */
  cleaned: string;
  /** The full sanitized body, for the audit trail. */
  full: string;
}

export function parseInboundBody(params: { text?: string | null; html?: string | null }): ParsedInbound {
  const raw = params.text && params.text.trim() !== ''
    ? params.text
    : params.html
      ? stripHtml(params.html)
      : '';
  const full = raw.replace(/\r\n/g, '\n').slice(0, MAX_STORED_CHARS);
  const cleaned = stripSignature(stripQuotedHistory(full)).slice(0, MAX_STORED_CHARS);
  return { cleaned: cleaned === '' ? full.slice(0, 2000) : cleaned, full };
}

/** Pulls the bare address out of `Name <a@b.com>` or `a@b.com`. */
export function parseAddress(value: string | string[] | null | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) return null;
  const angle = /<([^>]+)>/.exec(first);
  const candidate = (angle?.[1] ?? first).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}

/** Message-Id values referenced by this reply, most specific first. */
export function referencedMessageIds(params: {
  inReplyTo?: string | null;
  references?: string | null;
}): string[] {
  const ids: string[] = [];
  const push = (raw: string | null | undefined) => {
    if (!raw) return;
    let matched = false;
    for (const match of raw.matchAll(/<([^>]+)>|([^\s<>]+@[^\s<>]+)/g)) {
      const id = match[1] ?? match[2];
      if (id && !ids.includes(id)) {
        ids.push(id);
        matched = true;
      }
    }
    // Providers that use opaque ids (Resend returns a bare UUID) never match
    // the RFC form, so fall back to the value itself.
    if (!matched) {
      for (const token of raw.split(/[\s,]+/)) {
        const id = token.trim();
        if (id !== '' && !ids.includes(id)) ids.push(id);
      }
    }
  };
  push(params.inReplyTo);
  push(params.references);
  return ids;
}
