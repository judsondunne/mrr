/**
 * REPLY INTENT — what a prospect actually told us.
 *
 * The existing `ReplyClassification` decides how the conversation should be
 * handled. This is a finer-grained, commercially-oriented reading of the same
 * message: how far up the validation ladder this reply is entitled to move an
 * opportunity, and what it taught us about the buyer.
 *
 * THE WHOLE POINT IS CONSERVATISM. The failure mode this file exists to prevent
 * is a system that congratulates itself: "sounds interesting" is not willingness
 * to pay, agreeing that a problem exists is not a commitment, and politeness is
 * not intent. Every promotion to a commercial stage requires words a reasonable
 * person would read as commercial.
 *
 * Deterministic rules decide whatever they can. The model is used to EXTRACT
 * structure, and its verdict is then re-checked against the literal text — a
 * model may not promote a reply the words do not support.
 */
import { z } from 'zod';
import { createLogger } from '../../lib/logger';

const logger = createLogger('outreach:intent');

/**
 * The taxonomy, ordered from least to most commercially meaningful. Order
 * matters: `rank()` uses it, and the validation ladder reads that rank.
 */
export const REPLY_INTENTS = [
  'AUTO_REPLY',
  'OUT_OF_OFFICE',
  'WRONG_PERSON',
  'REFERRAL_TO_OTHER_PERSON',
  'UNSUBSCRIBE',
  'NOT_INTERESTED',
  'CONFUSED',
  'NEUTRAL',
  'OTHER',
  'INTERESTED',
  'PAIN_CONFIRMED',
  'ASKED_FOR_MORE_INFO',
  'ASKED_FOR_DEMO',
  'ASKED_PRICE',
  'PRICE_ACCEPTABLE',
  'WILLING_TO_TRY',
  'PILOT_INTEREST',
  'WILLING_TO_PAY',
  'PAYMENT_COMMITMENT',
] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export function rank(intent: ReplyIntent): number {
  return REPLY_INTENTS.indexOf(intent);
}

/** Intents that end the conversation, whatever else the message contains. */
export const TERMINAL_INTENTS: ReadonlySet<ReplyIntent> = new Set<ReplyIntent>([
  'UNSUBSCRIBE',
  'NOT_INTERESTED',
]);

/**
 * Intents that represent real commercial intent from a qualified buyer.
 * Nothing below WILLING_TO_PAY counts toward the payment-intent gate.
 */
export const COMMERCIAL_INTENTS: ReadonlySet<ReplyIntent> = new Set<ReplyIntent>([
  'WILLING_TO_PAY',
  'PAYMENT_COMMITMENT',
]);

/** Intents that show a buyer leaning in without committing money. */
export const STRONG_SIGNAL_INTENTS: ReadonlySet<ReplyIntent> = new Set<ReplyIntent>([
  'PRICE_ACCEPTABLE',
  'WILLING_TO_TRY',
  'PILOT_INTEREST',
]);

export const ReplyIntentSchema = z.enum(REPLY_INTENTS);

const clip = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? v.slice(0, max) : v), z.string().max(max));

export const IntentExtraction = z.object({
  intent: ReplyIntentSchema,
  confidence: z.number().min(0).max(1),
  /** Verbatim from the reply. Checked. A classification without support fails. */
  evidenceQuote: clip(400),
  currentWorkflow: clip(300).nullable(),
  currentTools: clip(200).nullable(),
  currentSpend: clip(160).nullable(),
  /** A concrete figure the prospect themselves named, in USD. */
  statedAmountUsd: z.number().nullable(),
  priceSensitivity: clip(200).nullable(),
  requestedCapability: clip(240).nullable(),
  objection: clip(300).nullable(),
  nextAction: clip(200).nullable(),
  decisionMaker: clip(160).nullable(),
  /** True when the prospect volunteered this, not merely agreed to a leading question. */
  unsolicited: z.boolean(),
  /** False for vendors, consultants selling in, students, competitors. */
  qualifiedCompany: z.boolean(),
  disqualifiedReason: clip(200).nullable(),
});
export type IntentExtraction = z.infer<typeof IntentExtraction>;

// --- deterministic rules -----------------------------------------------------

/**
 * Patterns that settle an intent without a model. These are the cases where
 * being wrong is expensive: an opt-out that is missed, or a polite brush-off
 * scored as interest.
 */
const HARD_RULES: ReadonlyArray<{ intent: ReplyIntent; re: RegExp }> = [
  { intent: 'UNSUBSCRIBE', re: /\b(unsubscribe|remove me|take me off|stop emailing|do not (contact|email)|opt[- ]?out)\b/i },
  { intent: 'NOT_INTERESTED', re: /\b(not interested|no thanks|no thank you|we'?re (all set|good)|pass on this|not a fit|not for us)\b/i },
  { intent: 'OUT_OF_OFFICE', re: /\b(out of (the )?office|on (annual )?leave|on holiday|away from my desk|return(ing)? on|maternity|paternity) \b/i },
  { intent: 'WRONG_PERSON', re: /\b(wrong person|not my (area|department|remit)|i no longer work|i've left|no longer with)\b/i },
  { intent: 'REFERRAL_TO_OTHER_PERSON', re: /\b(speak (to|with)|talk to|reach out to|contact|forward(ed|ing)? (this )?to|copying in|cc'?ing)\s+(our|my|the)\b/i },
];

/** Auto-responders announce themselves in headers far more reliably than in prose. */
export function looksAutomated(headers: Record<string, string>): boolean {
  const get = (k: string): string => (headers[k] ?? headers[k.toLowerCase()] ?? '').toLowerCase();
  if (get('auto-submitted').includes('auto-')) return true;
  if (get('x-autoreply') !== '' || get('x-autorespond') !== '') return true;
  if (get('precedence').match(/auto_reply|bulk|junk/)) return true;
  return get('x-auto-response-suppress') !== '';
}

/**
 * An explicit monetary figure the PROSPECT named, in a paying context.
 *
 * Deliberately narrow. "$300/mo" in "we already pay $300/mo for X" is current
 * spend, not willingness to pay, and the surrounding verb is what separates
 * them. This returns a figure only when the sentence reads as payment for the
 * thing being discussed.
 */
export function extractWillingnessAmount(text: string): number | null {
  const money = /\$\s?([\d,]+(?:\.\d{2})?)\s*(?:\/|per\s+)?\s*(?:mo|month|monthly|yr|year|user)?/gi;
  for (const m of text.matchAll(money)) {
    const raw = m[1];
    if (!raw) continue;
    const amount = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) continue;

    // Look at the sentence this figure sits in.
    const start = Math.max(0, (m.index ?? 0) - 160);
    const end = Math.min(text.length, (m.index ?? 0) + 160);
    const around = text.slice(start, end).toLowerCase();

    const paying = /\b(we'?d pay|we would pay|i'?d pay|i would pay|happy to pay|willing to pay|worth it at|works for us|that works|no problem at|reasonable|we'?ll take|sign us up|send.{0,20}invoice)\b/.test(around);
    const currentSpend = /\b(we (currently )?(pay|spend)|we'?re paying|already pay(ing)?|costs us|charged us)\b/.test(around);

    if (paying && !currentSpend) return amount;
  }
  return null;
}

/**
 * Words that would have to be present for a reply to mean "I will pay".
 * Used to VETO a model that over-reads enthusiasm as commitment.
 */
const PAYMENT_LANGUAGE =
  /\b(we'?d pay|we would pay|i'?d pay|i would pay|happy to pay|willing to pay|send (me |us )?an? (invoice|quote)|sign (us|me) up|take my money|purchase order|start a paid|paid pilot|put (us|me) down|we'?ll buy|budget for (it|this))\b/i;

const PILOT_LANGUAGE =
  /\b(pilot|trial|try it|test it|early access|beta|proof of concept|poc)\b/i;

/**
 * The deterministic verdict, when the words alone settle it.
 * Returns null when the message genuinely needs interpretation.
 */
export function deterministicIntent(
  text: string,
  headers: Record<string, string> = {},
): { intent: ReplyIntent; rule: string } | null {
  const body = (text ?? '').slice(0, 20_000);

  // Opt-out first, always. Nothing overrides it.
  const optOut = HARD_RULES[0];
  if (optOut && optOut.re.test(body)) return { intent: 'UNSUBSCRIBE', rule: 'UNSUBSCRIBE_PHRASE' };

  if (looksAutomated(headers)) {
    return { intent: /\b(out of (the )?office|on leave|on holiday)\b/i.test(body)
      ? 'OUT_OF_OFFICE'
      : 'AUTO_REPLY', rule: 'AUTOMATED_HEADERS' };
  }

  for (const rule of HARD_RULES.slice(1)) {
    if (rule.re.test(body)) return { intent: rule.intent, rule: `${rule.intent}_PHRASE` };
  }
  return null;
}

/**
 * The guard that keeps the system honest.
 *
 * A model may classify freely, but it may not promote a reply into commercial
 * territory that the literal words do not support. Enthusiasm is not payment.
 */
export function capIntentToEvidence(
  proposed: ReplyIntent,
  text: string,
): { intent: ReplyIntent; demoted: boolean; why: string } {
  const body = (text ?? '').slice(0, 20_000);

  if (COMMERCIAL_INTENTS.has(proposed)) {
    const hasPaymentWords = PAYMENT_LANGUAGE.test(body);
    const hasAmount = extractWillingnessAmount(body) !== null;
    if (!hasPaymentWords && !hasAmount) {
      return {
        intent: 'INTERESTED',
        demoted: true,
        why: 'no payment language and no figure the prospect named; enthusiasm is not willingness to pay',
      };
    }
    if (proposed === 'PAYMENT_COMMITMENT' && !/\b(invoice|purchase order|sign (us|me) up|send.{0,20}(contract|paperwork)|start (the )?paid|we'?ll buy|deposit)\b/i.test(body)) {
      return {
        intent: 'WILLING_TO_PAY',
        demoted: true,
        why: 'states willingness but asks for no concrete commercial next step',
      };
    }
  }

  if ((proposed === 'PILOT_INTEREST' || proposed === 'WILLING_TO_TRY') && !PILOT_LANGUAGE.test(body)) {
    return { intent: 'INTERESTED', demoted: true, why: 'no pilot or trial language in the reply' };
  }

  if (proposed === 'PRICE_ACCEPTABLE' && !/\$|\b(price|pricing|cost|per month|monthly|budget)\b/i.test(body)) {
    return { intent: 'INTERESTED', demoted: true, why: 'price never discussed in this reply' };
  }

  return { intent: proposed, demoted: false, why: '' };
}

/**
 * Applies the full conservative reading to a model extraction.
 * The returned extraction is what may be persisted and acted on.
 */
export function reconcile(
  extraction: IntentExtraction,
  text: string,
  headers: Record<string, string> = {},
): IntentExtraction & { demoted: boolean; demotionReason: string; quoteVerified: boolean } {
  const deterministic = deterministicIntent(text, headers);

  // A deterministic opt-out or bounce-style verdict always wins.
  if (deterministic && rank(deterministic.intent) <= rank('OTHER')) {
    return {
      ...extraction,
      intent: deterministic.intent,
      statedAmountUsd: null,
      demoted: extraction.intent !== deterministic.intent,
      demotionReason: extraction.intent !== deterministic.intent ? `deterministic rule ${deterministic.rule}` : '',
      quoteVerified: quoteAppears(extraction.evidenceQuote, text),
    };
  }

  const capped = capIntentToEvidence(extraction.intent, text);
  const amount = extractWillingnessAmount(text);

  if (capped.demoted) {
    logger.info('demoted a reply intent to match its words', {
      from: extraction.intent,
      to: capped.intent,
      why: capped.why,
    });
  }

  return {
    ...extraction,
    intent: capped.intent,
    // Only a figure the prospect themselves named survives.
    statedAmountUsd: amount,
    demoted: capped.demoted,
    demotionReason: capped.why,
    quoteVerified: quoteAppears(extraction.evidenceQuote, text),
  };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s ]+/g, ' ').replace(/[“”‘’]/g, "'").trim();
}

/** The classification must be supported by words that are actually there. */
export function quoteAppears(quote: string, text: string): boolean {
  const q = normalize(quote);
  if (q.length < 8) return false;
  return normalize(text).includes(q);
}
