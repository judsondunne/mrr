/**
 * Outbound content.
 *
 * Plain text. Short. True. The only personalized sentence is generated from
 * evidence this system actually fetched and stored on the prospect row
 * (public_evidence_url + qualification_reason), and even that sentence is run
 * through a deterministic sanitizer before it is allowed into a message.
 *
 * NOTHING here may:
 *   - claim familiarity we do not have ("I've been following you for years")
 *   - imply the product exists, has customers, or has testimonials
 *   - invent scarcity ("only 3 spots left")
 *   - use a RE:/FWD: subject to fake an existing thread
 *
 * Every message — initial, follow-up, or auto-reply — is assembled here and
 * passed through assertCompliant() before any send path will touch it.
 */
import { z } from 'zod';
import { getConfig, type Config } from '../../lib/config';
import { createLogger } from '../../lib/logger';
import { llmComplete } from '../../lib/llm/index';
import { ComplianceError } from './errors';
import { type OfferContext, displayEcosystem, formatPrice } from './offer';
import {
  buildUnsubscribeUrl,
  extractUnsubscribeToken,
  unsubscribeHeaders,
  verifyUnsubscribeToken,
} from './unsubscribe';
import { normalizeEmail } from './suppression';

const logger = createLogger('outreach:compose');

export interface ProspectContext {
  id: string;
  companyName: string;
  domain: string;
  contactEmail: string;
  contactName: string | null;
  publicEvidenceUrl: string | null;
  qualificationReason: string | null;
}

export interface ComposedMessage {
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
  unsubscribeUrl: string;
}

const MAX_BODY_CHARS = 2400;
const MAX_SUBJECT_CHARS = 90;

// --- personalization ---------------------------------------------------------

const Personalization = z.object({
  /**
   * One clause, lowercase, restating a fact that is literally present in the
   * supplied verified evidence. No adjectives of admiration, no claims about
   * our relationship to the business, no URLs.
   */
  observation: z.string().min(8).max(180),
});

/** Phrases that assert a relationship, endorsement, or knowledge we do not have. */
const FALSE_FAMILIARITY =
  /\b(i(?:'ve| have) been (?:following|watching|using|a fan)|long[- ]?time (?:fan|customer|user)|we (?:work|worked) with|our (?:customers|clients|users)|as discussed|per our (?:call|conversation)|great to (?:meet|connect) again|love what you|huge fan|i'm a customer)\b/i;

/** Marketing puffery that is not a checkable fact about the business. */
const UNVERIFIABLE_PRAISE =
  /\b(amazing|incredible|awesome|world[- ]class|best[- ]in[- ]class|industry[- ]leading|impressive growth|crushing it)\b/i;

/**
 * Cleans an observation clause and rejects anything that is not a plain
 * restatement of the stored evidence. Returns null when it must be discarded.
 */
export function sanitizeObservation(raw: string): string | null {
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .replace(/^["'`“‘]+|["'`”’]+$/g, '')
    .replace(/^(?:i noticed|i saw|i see|noticed)\s+(?:that\s+)?/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  if (cleaned.length < 8 || cleaned.length > 180) return null;
  if (/https?:\/\/|www\.|@/i.test(cleaned)) return null;
  if (/[\n\r<>{}]/.test(cleaned)) return null;
  if (FALSE_FAMILIARITY.test(cleaned)) return null;
  if (UNVERIFIABLE_PRAISE.test(cleaned)) return null;
  return cleaned;
}

/**
 * Deterministic fallback used whenever the model output is unusable: the
 * qualification reason this system already recorded, verbatim. It came from the
 * prospecting layer's verified page fetch, so it is safe to restate.
 */
export function fallbackObservation(prospect: ProspectContext): string | null {
  const reason = prospect.qualificationReason?.replace(/\s+/g, ' ').trim() ?? '';
  if (reason === '') return null;

  // The recorded reason always cites where the evidence was found — the
  // qualifier appends "...published at https://<url>". `sanitizeObservation`
  // rejects any string containing a URL or an address, so passing the reason
  // through verbatim made this fallback impossible to satisfy: every model
  // failure became "refuse to draft" and no prospect was ever emailed.
  //
  // The citation is exactly the part that must not appear in the email, so it
  // is dropped here rather than disqualifying the clause it is attached to.
  const withoutCitation = reason
    .replace(/[;,]?\s*(?:published|found|listed|stated)\s+at\s+\S+/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/\S+@\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s;,]+$/, '')
    .trim();
  if (withoutCitation === '') return null;

  const lowered = withoutCitation.charAt(0).toLowerCase() + withoutCitation.slice(1);
  return sanitizeObservation(lowered.slice(0, 180));
}

/**
 * Generates the single personalized clause. Fast tier only, tight schema,
 * and the result is only used if it survives sanitizeObservation().
 */
export async function generateObservation(
  prospect: ProspectContext,
  offer: OfferContext,
): Promise<string | null> {
  const evidence = {
    companyName: prospect.companyName,
    publicPageUrl: prospect.publicEvidenceUrl,
    verifiedFact: prospect.qualificationReason,
    relevantWorkflow: offer.copy.workflow,
  };
  if (!evidence.verifiedFact && !evidence.publicPageUrl) return null;

  try {
    const res = await llmComplete({
      tier: 'fast',
      task: 'outreach.personalize',
      schemaName: 'OutreachPersonalization',
      maxTokens: 300,
      schema: Personalization,
      system: [
        'You restate ONE fact about a business from verified evidence that was already fetched from its own public website.',
        'Output a single lowercase clause that completes the sentence "I noticed ___.".',
        'HARD RULES:',
        '- Use only what is in VERIFIED_FACT. Never add a fact that is not there.',
        '- Never claim to be a customer, a fan, or to have spoken to them before.',
        '- No compliments, no adjectives of praise, no URLs, no email addresses.',
        '- No line breaks. Under 180 characters. No trailing period.',
        'If the evidence is too thin to restate honestly, return the evidence text itself, shortened.',
      ].join('\n'),
      user: JSON.stringify(evidence),
    });
    const sanitized = sanitizeObservation(res.data.observation);
    if (sanitized) return sanitized;
    logger.warn('discarded personalization that failed the sanitizer', { prospectId: prospect.id });
  } catch (err) {
    logger.warn('personalization failed; falling back to stored evidence', {
      prospectId: prospect.id,
      err: String(err),
    });
  }
  return fallbackObservation(prospect);
}

// --- assembly ----------------------------------------------------------------

function senderName(cfg: Config): string {
  return cfg.ownerName.trim() !== '' ? cfg.ownerName.trim() : cfg.senderCompany.trim();
}

/**
 * Sender identification + one-step opt-out. Appended to EVERY outbound message
 * without exception; the compliance validator re-checks that it is present.
 */
export function buildFooter(email: string, cfg: Config, evidenceUrl: string | null): string {
  const lines = [
    '--',
    cfg.senderCompany,
    cfg.senderPostalAddress,
  ];
  lines.push(
    evidenceUrl
      ? `Sent to ${normalizeEmail(email)} — a business address published at ${evidenceUrl}.`
      : `Sent to ${normalizeEmail(email)} — a publicly listed business address.`,
  );
  // Reply-based opt-out. In this low-volume validation mode there is no public
  // endpoint, so the link alone would be a dead promise; a reply is something
  // the poller genuinely acts on within minutes. The signed link stays for
  // clients that surface List-Unsubscribe.
  lines.push("If you'd prefer I don't email you again, just reply \"unsubscribe\".");
  lines.push(`Unsubscribe in one click: ${buildUnsubscribeUrl(email)}`);
  return lines.join('\n');
}

function shortWorkflow(offer: OfferContext, max = 60): string {
  const w = offer.copy.workflow.replace(/\s+/g, ' ').trim();
  if (w.length <= max) return w;
  const cut = w.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
}

export function buildSubject(prospect: ProspectContext, offer: OfferContext): string {
  const subject = `Question about ${prospect.companyName}: ${shortWorkflow(offer, 50)}`;
  return subject.length > MAX_SUBJECT_CHARS
    ? `${subject.slice(0, MAX_SUBJECT_CHARS - 1).trimEnd()}…`
    : subject;
}

/**
 * The initial outreach message. The frame is fixed; only the bracketed facts
 * come from data, and every one of them is already stored and verified.
 */
export function assembleInitialBody(params: {
  observation: string;
  offer: OfferContext;
  prospect: ProspectContext;
  cfg: Config;
}): string {
  const { observation, offer, prospect, cfg } = params;
  const price = formatPrice(offer.priceMonthly);
  const ecosystem = displayEcosystem(offer.copy.ecosystem);

  return [
    'Hi —',
    '',
    `I noticed ${observation}.`,
    '',
    `I'm validating a small ${ecosystem} app specifically for ${offer.copy.workflow}.`,
    `It would ${offer.copy.outcome}, without ${offer.copy.incumbentComplexity}.`,
    '',
    `I'm planning to price it at ${price}/month.`,
    '',
    "If I had this ready for your store, would you want me to send you the install when the pilot opens?",
    '',
    offer.landingUrl,
    '',
    `— ${senderName(cfg)}`,
    '',
    buildFooter(prospect.contactEmail, cfg, prospect.publicEvidenceUrl),
  ].join('\n');
}

export function assembleFollowupBody(params: {
  step: 1 | 2;
  offer: OfferContext;
  prospect: ProspectContext;
  cfg: Config;
}): string {
  const { step, offer, prospect, cfg } = params;
  const price = formatPrice(offer.priceMonthly);
  const ecosystem = displayEcosystem(offer.copy.ecosystem);
  const footer = buildFooter(prospect.contactEmail, cfg, prospect.publicEvidenceUrl);

  if (step === 1) {
    return [
      'Hi —',
      '',
      `Following up once on my note about ${offer.copy.workflow}.`,
      '',
      `The short version: a small ${ecosystem} app that would ${offer.copy.outcome}, at ${price}/month.`,
      'It is not built yet — I only build it if enough stores say they want it.',
      '',
      'Would you want one of the first pilot installs?',
      '',
      offer.landingUrl,
      '',
      `— ${senderName(cfg)}`,
      '',
      footer,
    ].join('\n');
  }

  return [
    'Hi —',
    '',
    "Last note from me on this — I won't follow up again.",
    '',
    `If a ${ecosystem} app that would ${offer.copy.outcome} at ${price}/month would be useful,`,
    'you can reserve one of the first pilot installs here:',
    '',
    offer.landingUrl,
    '',
    'If not, no action needed — and thanks for your time.',
    '',
    `— ${senderName(cfg)}`,
    '',
    footer,
  ].join('\n');
}

export function withHeaders(to: string, subject: string, text: string): ComposedMessage {
  const unsubscribeUrl = buildUnsubscribeUrl(to);
  return {
    to: normalizeEmail(to),
    subject,
    text,
    headers: {
      ...unsubscribeHeaders(unsubscribeUrl),
      'X-Entity-Ref-ID': 'mrr-validator-outreach',
    },
    unsubscribeUrl,
  };
}

/** Initial message. The only place in the layer that spends an LLM call per prospect. */
export async function composeInitialMessage(
  prospect: ProspectContext,
  offer: OfferContext,
): Promise<ComposedMessage | null> {
  const cfg = getConfig();
  const observation = (await generateObservation(prospect, offer)) ?? fallbackObservation(prospect);
  if (!observation) {
    // No verified public fact => no personalization => we do not email at all.
    logger.warn('refusing to draft: no verified public evidence for prospect', { prospectId: prospect.id });
    return null;
  }
  const text = assembleInitialBody({ observation, offer, prospect, cfg });
  return withHeaders(prospect.contactEmail, buildSubject(prospect, offer), text);
}

/** Follow-ups are fully deterministic — no model call, nothing new is claimed. */
export function composeFollowupMessage(
  step: 1 | 2,
  prospect: ProspectContext,
  offer: OfferContext,
): ComposedMessage {
  const cfg = getConfig();
  const text = assembleFollowupBody({ step, offer, prospect, cfg });
  // Same subject line, threaded by In-Reply-To/References. Deliberately NOT
  // prefixed with "Re:" — a fake reply prefix is exactly the deception this
  // layer is not allowed to use.
  return withHeaders(prospect.contactEmail, buildSubject(prospect, offer), text);
}

// --- compliance --------------------------------------------------------------

/** Deceptive patterns. If any of these is in a body, the message is not sent. */
const DECEPTION_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'FAKE_SCARCITY', pattern: /\b(only \d+ (spots|seats|licen[cs]es)|limited time|act (now|fast)|expires (today|tonight|in \d+)|last chance)\b/i },
  { id: 'FAKE_SOCIAL_PROOF', pattern: /\b(join \d[\d,]* (other )?(stores|merchants|customers|companies)|trusted by|loved by|our customers (say|love)|\d[\d,]*\+? (happy )?(customers|users) )/i },
  { id: 'CLAIMS_PRODUCT_EXISTS', pattern: /\b(already (live|available|shipping|helping)|is now available|thousands of (stores|users)|used by \d)/i },
  { id: 'FALSE_FAMILIARITY', pattern: FALSE_FAMILIARITY },
  { id: 'FAKE_URGENCY_DEADLINE', pattern: /\b(offer ends|price goes up|before (midnight|friday))\b/i },
  { id: 'HTML_CONTENT', pattern: /<\s*(html|body|div|table|img|a\s|script|style)\b/i },
];

const MISLEADING_SUBJECT = /^\s*(re|fw|fwd)\s*:/i;

export interface ComplianceReport {
  ok: boolean;
  violations: string[];
}

/**
 * THE CODE-LEVEL GATE. Runs on every message on the way to the provider.
 *
 * This is not advisory and it is not a prompt instruction: if it returns
 * violations, the send path refuses to send and the message is marked FAILED.
 */
export function validateCompliance(message: ComposedMessage, cfg: Config = getConfig()): ComplianceReport {
  const violations: string[] = [];
  const text = message.text ?? '';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to ?? '')) violations.push('INVALID_RECIPIENT');

  if (!message.subject || message.subject.trim() === '') violations.push('MISSING_SUBJECT');
  if (message.subject && MISLEADING_SUBJECT.test(message.subject)) violations.push('MISLEADING_SUBJECT_PREFIX');
  if (message.subject && message.subject.length > MAX_SUBJECT_CHARS) violations.push('SUBJECT_TOO_LONG');

  if (text.trim() === '') violations.push('EMPTY_BODY');
  if (text.length > MAX_BODY_CHARS) violations.push('BODY_TOO_LONG');

  // --- sender identification (legally required) ---
  if (cfg.senderCompany.trim() === '') violations.push('SENDER_COMPANY_NOT_CONFIGURED');
  else if (!text.includes(cfg.senderCompany.trim())) violations.push('MISSING_SENDER_COMPANY');

  if (cfg.senderPostalAddress.trim() === '') violations.push('SENDER_POSTAL_ADDRESS_NOT_CONFIGURED');
  else if (!text.includes(cfg.senderPostalAddress.trim())) violations.push('MISSING_POSTAL_ADDRESS');

  if (!text.includes('--\n')) violations.push('MISSING_FOOTER');

  // --- working one-step opt-out ---
  const token = extractUnsubscribeToken(text);
  if (!token) {
    violations.push('MISSING_UNSUBSCRIBE_LINK');
  } else {
    const signedFor = verifyUnsubscribeToken(token);
    if (!signedFor) violations.push('UNSUBSCRIBE_TOKEN_INVALID');
    else if (signedFor !== normalizeEmail(message.to ?? '')) violations.push('UNSUBSCRIBE_TOKEN_WRONG_RECIPIENT');
  }

  const headers = message.headers ?? {};
  const listUnsub = headers['List-Unsubscribe'];
  const listUnsubPost = headers['List-Unsubscribe-Post'];
  if (!listUnsub || !/^<https?:\/\/\S+>$/.test(listUnsub)) violations.push('MISSING_LIST_UNSUBSCRIBE_HEADER');
  if (listUnsubPost !== 'List-Unsubscribe=One-Click') violations.push('MISSING_LIST_UNSUBSCRIBE_POST_HEADER');
  if (message.unsubscribeUrl && listUnsub && listUnsub !== `<${message.unsubscribeUrl}>`) {
    violations.push('LIST_UNSUBSCRIBE_HEADER_MISMATCH');
  }

  // --- truthfulness ---
  for (const { id, pattern } of DECEPTION_PATTERNS) {
    if (pattern.test(text)) violations.push(`DECEPTIVE_CONTENT:${id}`);
  }

  return { ok: violations.length === 0, violations };
}

/** Throws rather than returning, for the call sites that must not continue. */
export function assertCompliant(message: ComposedMessage, cfg: Config = getConfig()): void {
  const report = validateCompliance(message, cfg);
  if (!report.ok) {
    throw new ComplianceError(report.violations, { to: message.to, subject: message.subject });
  }
}
