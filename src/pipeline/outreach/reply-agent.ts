/**
 * Bounded autonomous replies.
 *
 * This is the only place in the system where software talks back to a real
 * person, so its authority is deliberately tiny: it may answer a question if
 * and only if the answer is already contained in the stored offer, and it may
 * ask ONE qualifying question. That is the whole mandate.
 *
 * It may NOT: invent a feature, promise an integration, promise a launch date,
 * negotiate, offer a discount that was never configured, imply the product
 * exists, or give a legal/compliance opinion.
 *
 * Those limits are enforced by checkReplySafety() — a deterministic check that
 * runs on the generated draft AFTER generation. A prompt instruction is a
 * request; this is a gate. If the draft trips it, requires_human is set and
 * nothing is sent.
 */
import { z } from 'zod';
import { getConfig, type Config } from '../../lib/config';
import { createLogger } from '../../lib/logger';
import { llmComplete } from '../../lib/llm/index';
import type { ReplyAnalysis, ReplyClassification } from '../../lib/contracts';
import { buildFooter, withHeaders, validateCompliance, type ComposedMessage, type ProspectContext } from './compose';
import { formatPrice, isFeaturePlanned, featureTokens, type OfferContext } from './offer';
import { detectQuestions, type ConversationState, type QuestionKey } from './conversation';

const logger = createLogger('outreach:reply-agent');

/** Classifications an automated reply is allowed to respond to at all. */
const REPLYABLE: ReadonlySet<ReplyClassification> = new Set<ReplyClassification>([
  'ASKING_QUESTION',
  'FEATURE_REQUIREMENT',
  'INTERESTED_WEAK',
  'INTERESTED_STRONG',
  'PRICE_ACCEPTED',
  'WANTS_PILOT',
  'USING_COMPETITOR',
]);

// --- the deterministic post-generation gate ---------------------------------

export const UNSAFE_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  {
    id: 'DATE_PROMISE',
    pattern:
      /\b(next (week|month|quarter)|this (week|month|quarter)|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|the end of)|in \d+ (days?|weeks?|months?)|within \d+ (days?|weeks?|months?)|ship(ping|s)? (it )?(on|in|by)|launch(ing|es)? (on|in|by)|(will be )?(ready|live|available) (on|by|in) |release date|eta (is|of))\b/i,
  },
  {
    id: 'DISCOUNT',
    pattern:
      /\b(discount|\d+\s?% off|percent off|coupon|promo ?code|free (month|year|trial|forever|plan)|no charge|waive|half (the )?price|lifetime deal|special (price|rate|offer)|cheaper for you|lower the price|reduce the price)\b/i,
  },
  {
    id: 'CONTRACT_NEGOTIATION',
    pattern: /\b(contract|msa\b|sla\b|terms and conditions|net ?\d{2}\b|purchase order|invoice terms|sign (an|the) agreement|legally binding)\b/i,
  },
  {
    id: 'LEGAL_OR_COMPLIANCE_OPINION',
    pattern: /\b(gdpr|ccpa|hipaa|soc ?2|pci[- ]?dss|iso ?27001|legally (compliant|required)|we are compliant|indemnif|liability|data processing agreement|dpa\b)\b/i,
  },
  {
    id: 'CLAIMS_PRODUCT_EXISTS',
    pattern: /\b(already (built|live|available|shipping|helping)|our (customers|users) (use|love)|\d+ (stores|merchants|customers) (use|are using)|you can (install|download) it (now|today)|is (now )?available)\b/i,
  },
  {
    id: 'BOOKING_A_CALL',
    pattern: /\b(book a (call|demo|meeting)|schedule a (call|demo|meeting)|calendly|hop on a (call|zoom)|jump on a call|15 minutes? (to )?chat)\b/i,
  },
  {
    id: 'GUARANTEE',
    pattern: /\b(guarantee|guaranteed|we promise|definitely will|100% sure|money[- ]back)\b/i,
  },
];

/**
 * Feature vocabulary that must not appear unless the stored offer says it.
 * Deliberately a fixed list: a model cannot widen it, and a reviewer can read
 * it in ten seconds.
 */
export const FEATURE_VOCABULARY: readonly string[] = [
  'api',
  'webhook',
  'webhooks',
  'sso',
  'single sign-on',
  'white label',
  'white-label',
  'multi-currency',
  'multicurrency',
  'csv export',
  'csv import',
  'bulk import',
  'mobile app',
  'ios app',
  'android app',
  'zapier',
  'quickbooks',
  'netsuite',
  'salesforce',
  'hubspot',
  'shipstation',
  'klaviyo',
  'mailchimp',
  'erp',
  'crm',
  'analytics dashboard',
  'reporting dashboard',
  'ai',
  'machine learning',
  'automation rules',
  'custom fields',
  'roles and permissions',
  'audit log',
  'integration',
  'integrations',
  'integrates',
  'sync',
  'syncs',
];

function offerVocabulary(offer: OfferContext): string {
  return [
    offer.copy.productName,
    offer.copy.outcome,
    offer.copy.whoItIsFor,
    offer.copy.workflow,
    offer.copy.incumbentComplexity,
    offer.copy.earlyAccess,
    offer.copy.validationDisclosure,
    ...offer.copy.capabilities,
  ]
    .join(' \n ')
    .toLowerCase();
}

/**
 * What the gate actually reads: the human-facing body with URLs and the
 * code-generated footer removed. Both of those are built by this codebase from
 * configuration, never by the model, and scanning them only produces false
 * positives (an "/api/unsubscribe" link is not a promised API).
 */
export function scannableText(draftText: string): string {
  const footerAt = draftText.indexOf('\n--\n');
  const body = footerAt >= 0 ? draftText.slice(0, footerAt) : draftText;
  return body.replace(/https?:\/\/\S+/g, ' ');
}

export interface ReplySafetyReport {
  ok: boolean;
  violations: string[];
}

/**
 * THE GATE. Runs on the draft text, not on the prompt. Returns every violation
 * it finds so the audit trail says exactly why a human has to take over.
 */
export function checkReplySafety(draftText: string, offer: OfferContext): ReplySafetyReport {
  const violations: string[] = [];
  const scannable = scannableText(draftText ?? '');
  const text = scannable.toLowerCase();

  for (const { id, pattern } of UNSAFE_PATTERNS) {
    if (pattern.test(scannable)) violations.push(`UNSAFE:${id}`);
  }

  const vocabulary = offerVocabulary(offer);
  for (const term of FEATURE_VOCABULARY) {
    const boundary = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (boundary.test(text) && !vocabulary.includes(term)) {
      violations.push(`INVENTED_FEATURE:${term}`);
    }
  }

  if ((draftText ?? '').length > 1400) violations.push('REPLY_TOO_LONG');

  return { ok: violations.length === 0, violations };
}

// --- generation --------------------------------------------------------------

const ReplyAnswer = z.object({
  /** False when the stored offer simply does not contain the answer. */
  canAnswerFromOffer: z.boolean(),
  /** One or two sentences. Only facts present in the offer. */
  answer: z.string().max(400),
  /** ONE question, only if genuinely needed to qualify. */
  clarifyingQuestion: z.string().max(200).nullable(),
  needsHuman: z.boolean(),
});

const REPLY_SYSTEM = [
  'You draft at most two sentences answering a merchant who replied to an outreach email.',
  'The product DOES NOT EXIST YET. It is being validated. Never imply otherwise.',
  'You may ONLY state things contained in the OFFER object you are given.',
  'If the answer is not in the OFFER, set canAnswerFromOffer=false and needsHuman=true.',
  'NEVER: promise a date, promise an integration, offer a discount, discuss contracts or legal/compliance topics,',
  'invent a feature, or propose a call. The goal is a commitment to the pilot, not a meeting.',
  'ALREADY_ANSWERED lists things this thread has already covered. Never repeat or re-ask them.',
  'ALREADY_STATED contains sentences code has already written into this same reply. Do not restate them.',
  'Plain sentences. No greeting, no sign-off, no links — those are added by code.',
].join('\n');

export interface AutoReplyDecision {
  message: ComposedMessage | null;
  requiresHuman: boolean;
  reason: string;
  violations: string[];
  /** Question keys this reply actually answered, for the conversation record. */
  answered: QuestionKey[];
  /** The price this reply quoted, if it quoted one. */
  quotedPrice: number | null;
  /** Capabilities the prospect asked for that the pilot does NOT include. */
  featureRequests: string[];
}

function makeDecision(overrides: Partial<AutoReplyDecision>): AutoReplyDecision {
  return {
    message: null,
    requiresHuman: false,
    reason: 'OK',
    violations: [],
    answered: [],
    quotedPrice: null,
    featureRequests: [],
    ...overrides,
  };
}

export function shouldAttemptAutoReply(analysis: ReplyAnalysis): boolean {
  if (analysis.requiresHuman) return false;
  return REPLYABLE.has(analysis.classification);
}

// --- deterministic answers ---------------------------------------------------

/**
 * Replies whose only correct response is "reserve a spot". Somebody saying
 * "I'd use this" does not need a model to be asked what they meant.
 */
const RESERVATION_INTENT: ReadonlySet<ReplyClassification> = new Set<ReplyClassification>([
  'INTERESTED_STRONG',
  'WANTS_PILOT',
  'PRICE_ACCEPTED',
]);

export interface DeterministicAnswer {
  key: QuestionKey;
  text: string;
  /** Set when the answer was "that is not in the pilot" and we owe a log entry. */
  featureRequest?: string;
}

/**
 * The answers code is allowed to give on its own, because they are facts about
 * the stored offer rather than judgement calls:
 *
 *   PRICE    - the price assigned to THIS prospect, stated exactly.
 *   TIMELINE - the truth: not built, being validated, and no date. Ever.
 *   FEATURE  - planned for the pilot, or explicitly not part of it.
 *
 * Everything else is left to the model, which is then re-checked by
 * checkReplySafety before a single byte reaches anybody.
 */
export function deterministicAnswers(params: {
  questions: readonly QuestionKey[];
  analysis: ReplyAnalysis;
  offer: OfferContext;
}): DeterministicAnswer[] {
  const { questions, analysis, offer } = params;
  const out: DeterministicAnswer[] = [];

  if (questions.includes('PRICE')) {
    out.push({ key: 'PRICE', text: `It's ${formatPrice(offer.priceMonthly)}/month.` });
  }

  if (questions.includes('TIMELINE')) {
    // No date. Not "soon", not "shortly", not a quarter. This sentence is
    // deliberately fixed so no generated text can drift into a promise.
    out.push({
      key: 'TIMELINE',
      text:
        "It isn't built yet — I'm validating it first, so I can't give you a date. " +
        'Pilot stores get the first install if it goes ahead.',
    });
  }

  const requested = analysis.requestedFeature?.trim() ?? '';
  if (questions.includes('FEATURE') && requested !== '') {
    const planned = plannedCapabilityFor(requested, offer);
    if (planned) {
      out.push({ key: 'FEATURE', text: `${capitalize(planned)} is planned for the pilot.` });
    } else {
      out.push({
        key: 'FEATURE',
        text: notInPilotSentence(requested, offer),
        featureRequest: requested.slice(0, 200),
      });
    }
  }

  return out;
}

/** The stored capability that actually covers what they asked for, if any. */
function plannedCapabilityFor(feature: string, offer: OfferContext): string | null {
  if (!isFeaturePlanned(feature, offer)) return null;
  const asked = featureTokens(feature);
  for (const capability of offer.copy.capabilities) {
    const have = new Set(featureTokens(capability));
    const overlap = asked.filter((token) => have.has(token)).length;
    if (asked.length > 0 && overlap / asked.length >= 0.6) return capability;
  }
  return offer.copy.capabilities[0] ?? null;
}

/**
 * Naming the feature is clearer, but only if naming it does not itself trip
 * the invented-feature gate — "csv export is not part of the pilot" is honest
 * and still must not smuggle "csv export" into a message about an offer that
 * never mentioned it. So the specific wording is tried, checked, and dropped
 * to a generic denial if it fails.
 */
function notInPilotSentence(feature: string, offer: OfferContext): string {
  const generic = "That isn't part of the proposed pilot, so I can't promise it.";
  const cleaned = feature.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (cleaned === '' || /[\n\r<>{}]/.test(cleaned)) return generic;
  const specific = `${capitalize(cleaned)} isn't part of the proposed pilot, so I can't promise it.`;
  return checkReplySafety(specific, offer).ok ? specific : generic;
}

function capitalize(text: string): string {
  const t = text.trim();
  return t === '' ? t : t.charAt(0).toUpperCase() + t.slice(1);
}

/** The fixed, honest close. Asks for the commitment; never for a call. */
export function commitmentClose(offer: OfferContext): string {
  const price = formatPrice(offer.priceMonthly);
  return [
    `We're validating the first pilot at ${price}/month — it isn't built yet.`,
    `If you'd like one of the first installs, you can reserve it here: ${offer.landingUrl}`,
  ].join('\n');
}

export function assembleReplyBody(params: {
  answer: string;
  question: string | null;
  offer: OfferContext;
  prospect: ProspectContext;
  cfg: Config;
}): string {
  const { answer, question, offer, prospect, cfg } = params;
  const senderName = cfg.ownerName.trim() !== '' ? cfg.ownerName.trim() : cfg.senderCompany.trim();
  const lines = ['Hi —', '', 'Thanks for the reply.'];
  if (answer.trim() !== '') lines.push('', answer.trim());
  lines.push('', commitmentClose(offer));
  if (question && question.trim() !== '') lines.push('', question.trim());
  lines.push('', `— ${senderName}`, '', buildFooter(prospect.contactEmail, cfg, prospect.publicEvidenceUrl));
  return lines.join('\n');
}

/**
 * Drafts an auto-reply, or refuses. A refusal is a normal, expected outcome:
 * requires_human is set on the inbound message and a person answers it.
 *
 * Order of authority, strongest first:
 *   1. CODE answers what code can answer exactly — the assigned price, the
 *      no-date truth, and whether a requested capability is in the pilot.
 *   2. The MODEL is asked only for what is left, and only for this thread's
 *      unanswered questions.
 *   3. checkReplySafety re-reads whatever came back, and a violation means a
 *      human answers instead.
 *
 * `conversation` is the memory: it stops the agent greeting somebody twice,
 * re-asking a question they already answered, or quoting a second price.
 */
export async function draftAutoReply(params: {
  analysis: ReplyAnalysis;
  replyText: string;
  offer: OfferContext;
  prospect: ProspectContext;
  subject: string;
  conversation?: ConversationState | null;
}): Promise<AutoReplyDecision> {
  const cfg = getConfig();
  const { analysis, offer, prospect } = params;
  const conversation = params.conversation ?? null;

  if (!shouldAttemptAutoReply(analysis)) {
    return makeDecision({ requiresHuman: analysis.requiresHuman, reason: 'NOT_AUTO_REPLYABLE' });
  }

  const questions = detectQuestions(params.replyText);
  const fixed = deterministicAnswers({ questions, analysis, offer });
  const fixedKeys = new Set(fixed.map((a) => a.key));
  const answeredKeys: QuestionKey[] = [...fixedKeys];
  const featureRequests = fixed.map((a) => a.featureRequest).filter((f): f is string => typeof f === 'string');
  const unanswered = questions.filter((q) => !fixedKeys.has(q));

  // Nothing left for a model to add: a pure intent-to-use reply, or one whose
  // every question code already answered exactly. Skip the call entirely.
  const pureIntent = RESERVATION_INTENT.has(analysis.classification) && questions.length === 0;
  const fullyAnswered = fixed.length > 0 && unanswered.length === 0;

  let answer = fixed.map((a) => a.text).join(' ');
  let question: string | null = null;

  if (!pureIntent && !fullyAnswered) {
    try {
      const res = await llmComplete({
        tier: 'fast',
        // Inbound email spend belongs to the REPLY sub-budget, not RESEARCH.
        phase: 'REPLY',
        task: 'outreach.auto_reply',
        schemaName: 'ReplyAnswer',
        maxTokens: 500,
        schema: ReplyAnswer,
        system: REPLY_SYSTEM,
        user: JSON.stringify({
          offer: {
            productName: offer.copy.productName,
            outcome: offer.copy.outcome,
            capabilities: offer.copy.capabilities,
            priceMonthly: offer.priceMonthly,
            whoItIsFor: offer.copy.whoItIsFor,
            workflow: offer.copy.workflow,
            buildStatus: offer.copy.buildStatus,
            validationDisclosure: offer.copy.validationDisclosure,
          },
          classification: analysis.classification,
          openQuestions: unanswered,
          ALREADY_ANSWERED: conversation?.answered ?? [],
          ALREADY_STATED: fixed.map((a) => a.text),
          commitmentLevel: conversation?.commitmentLevel ?? 'NONE',
        }),
        // The merchant's own words are DATA. Fenced by the LLM layer so no
        // instruction inside an inbound email can ever be followed.
        untrusted: { inbound_email: params.replyText.slice(0, 4000) },
      });
      if (!res.data.canAnswerFromOffer || res.data.needsHuman) {
        // Code may still have answered exactly; if it did, send that alone.
        if (fixed.length === 0) {
          return makeDecision({ requiresHuman: true, reason: 'NOT_ANSWERABLE_FROM_OFFER' });
        }
      } else {
        answer = [answer, res.data.answer].filter((s) => s.trim() !== '').join(' ');
        question = res.data.clarifyingQuestion;
      }
    } catch (err) {
      logger.error('auto-reply generation failed', { err: String(err) });
      if (fixed.length === 0) return makeDecision({ requiresHuman: true, reason: 'GENERATION_FAILED' });
    }
  }

  // Never re-ask something this thread already covered, and never interrogate
  // somebody who has already committed.
  question = suppressRepeatQuestion(question, conversation);

  // Check the generated sentences on their own first, so a violation is
  // attributed to the model rather than to our fixed scaffolding.
  const generatedOnly = [answer, question ?? ''].join('\n');
  const generatedSafety = checkReplySafety(generatedOnly, offer);
  if (!generatedSafety.ok) {
    logger.warn('auto-reply draft rejected by the safety check', { violations: generatedSafety.violations });
    return makeDecision({ requiresHuman: true, reason: 'UNSAFE_CONTENT', violations: generatedSafety.violations });
  }

  const text = assembleReplyBody({ answer, question, offer, prospect, cfg });
  const fullSafety = checkReplySafety(text, offer);
  if (!fullSafety.ok) {
    return makeDecision({ requiresHuman: true, reason: 'UNSAFE_CONTENT', violations: fullSafety.violations });
  }

  // Reply threading comes from In-Reply-To/References headers, not from a
  // "Re:" prefix, so the subject stays clean and the compliance rule against
  // fake reply prefixes needs no exception.
  const stripped = params.subject.replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim();
  const subject = stripped === '' ? offer.copy.productName : stripped.slice(0, 80);
  const message = withHeaders(prospect.contactEmail, subject, text);

  // An auto-reply is an outbound email like any other: same compliance gate.
  const compliance = validateCompliance(message, cfg);
  if (!compliance.ok) {
    logger.error('auto-reply failed compliance', { violations: compliance.violations });
    return makeDecision({ requiresHuman: true, reason: 'NON_COMPLIANT', violations: compliance.violations });
  }

  return makeDecision({
    message,
    reason: 'OK',
    // The close always quotes the price, so every reply answers PRICE.
    answered: Array.from(new Set<QuestionKey>([...answeredKeys, 'PRICE'])),
    quotedPrice: offer.priceMonthly,
    featureRequests,
  });
}

/**
 * Drops a clarifying question the thread has already asked or answered. A
 * committed prospect is never asked anything at all — they said yes.
 */
export function suppressRepeatQuestion(
  question: string | null,
  conversation: ConversationState | null,
): string | null {
  if (!question || question.trim() === '') return null;
  if (!conversation) return question;
  if (conversation.commitmentLevel === 'COMMITTED' || conversation.commitmentLevel === 'DECLINED') return null;
  const covered = new Set<QuestionKey>([...conversation.answered, ...conversation.asked]);
  const keys = detectQuestions(question);
  if (keys.length > 0 && keys.every((key) => covered.has(key))) {
    logger.info('dropped a clarifying question this thread already covered', { keys });
    return null;
  }
  return question;
}
