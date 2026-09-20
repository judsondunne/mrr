/**
 * Reply understanding and the bounded reply agent.
 *
 * Two properties matter more than accuracy here:
 *   - compliance ("stop", "remove me") is decided by code, with no model in
 *     the loop at all, so it cannot fail because of a budget or an outage;
 *   - a commitment requires evidence IN THE TEXT. A confident model, a high
 *     intent score, and an enthusiastic adjective are all worth nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown, insertOpportunity, insertCampaign } from '../helpers';
import { resetConfigCache } from '../../src/lib/config';
import type { ReplyAnalysis } from '../../src/lib/contracts';
import {
  classifyDeterministic,
  classifyReply,
  commitmentTypesFor,
  recordCommitments,
} from '../../src/pipeline/outreach/classify';
import {
  checkReplySafety,
  draftAutoReply,
  shouldAttemptAutoReply,
  commitmentClose,
} from '../../src/pipeline/outreach/reply-agent';
import { buildLandingCopy, landingUrlFor, type OfferContext } from '../../src/pipeline/outreach/offer';
import { parseInboundBody, stripHtml } from '../../src/pipeline/outreach/inbound-parse';
import type { Wedge } from '../../src/lib/contracts';

const ORIGINAL_ENV = { ...process.env };

const BASE_ENV: Record<string, string> = {
  AUTONOMY_ENABLED: 'true',
  OUTREACH_ENABLED: 'true',
  PUBLIC_BASE_URL: 'https://validator.example',
  UNSUBSCRIBE_SECRET: 'unsubscribe-secret-used-only-by-tests',
  SENDER_COMPANY: 'Example Labs LLC',
  SENDER_EMAIL: 'founder@validator.example',
  SENDER_POSTAL_ADDRESS: '55 Test Street, Boston MA 02118',
  OWNER_NAME: 'Alex Founder',
  MONTHLY_LLM_BUDGET_USD: '20',
};

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value !== undefined) process.env[key] = value;
  }
  resetConfigCache();
}

afterEach(async () => {
  await teardown();
  restoreEnv();
});

const WEDGE: Wedge = {
  statement: 'For Shopify stores with a wholesale channel, enforce minimum order rules without a B2B replatform.',
  productName: 'Minimum Order Rules',
  targetCustomer: 'Shopify stores that sell wholesale to small independent retailers',
  coreWorkflow: 'enforcing minimum order quantities at checkout',
  v1Features: ['per-customer minimums', 'collection-level minimums', 'cart warnings'],
  excludedFromV1: ['multi-currency pricing'],
  proposedPriceMonthly: 19,
  estimatedBuildDays: 5,
  primaryCompetitor: 'Wholesale Club',
  reasonSomeoneWouldSwitch: 'the full B2B rebuild the incumbent requires',
  oneSentenceOutcome: 'keep wholesale orders under your minimum out of checkout',
  capabilities: ['per-customer minimum order values', 'collection-level minimums', 'clear cart messaging'],
  whoItIsFor: 'Shopify stores with a wholesale channel',
};

function buildOffer(campaignId = 'cmp_test'): OfferContext {
  return {
    campaignId,
    opportunityId: 'opp_test',
    landingSlug: 'minimum-order-rules',
    landingUrl: landingUrlFor('minimum-order-rules'),
    priceMonthly: 19,
    copy: buildLandingCopy({ wedge: WEDGE, ecosystem: 'shopify', priceMonthly: 19 }),
  };
}

function analysis(overrides: Partial<ReplyAnalysis> = {}): ReplyAnalysis {
  return {
    classification: 'INTERESTED_STRONG',
    intent: 'wants it',
    requestedFeature: null,
    competitorMentioned: null,
    priceReaction: 'ACCEPTED',
    timing: null,
    explicitlyWantsAccess: true,
    explicitlyAcceptedPrice: true,
    requiresHuman: false,
    intentScore: 0.9,
    ...overrides,
  };
}

const PROSPECT = {
  id: 'pr_1',
  companyName: 'Northside Supply',
  domain: 'northside.example.com',
  contactEmail: 'hello@northside.example.com',
  contactName: null,
  publicEvidenceUrl: 'https://northside.example.com/wholesale',
  qualificationReason: 'publishes a wholesale application page',
};

// ---------------------------------------------------------------------------

describe('deterministic classification', () => {
  it('recognises an opt-out with no LLM call whatsoever', async () => {
    const ctx = await freshDb(BASE_ENV);
    const outcome = await classifyReply({ text: 'Please remove me from your list.' });

    expect(outcome.analysis.classification).toBe('UNSUBSCRIBE');
    expect(outcome.deterministic).toBe(true);
    expect(outcome.rule).toBe('UNSUBSCRIBE_KEYWORD');
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('covers the whole family of opt-out phrasings', () => {
    for (const text of [
      'unsubscribe',
      'STOP',
      'Do not contact me again.',
      'take me off your list please',
      'please opt-out this address',
      "don't email me",
    ]) {
      expect(classifyDeterministic(text)?.analysis.classification).toBe('UNSUBSCRIBE');
    }
  });

  it('recognises out-of-office by header and by phrase, without an LLM', async () => {
    const ctx = await freshDb(BASE_ENV);
    const byHeader = await classifyReply({
      text: 'I will get back to you.',
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
    expect(byHeader.analysis.classification).toBe('OUT_OF_OFFICE');
    expect(byHeader.deterministic).toBe(true);

    const byPhrase = classifyDeterministic('I am currently out of the office until Monday.');
    expect(byPhrase?.analysis.classification).toBe('OUT_OF_OFFICE');
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('recognises obvious rejections but leaves ambiguity to the model', async () => {
    expect(classifyDeterministic('Not interested, thanks.')?.analysis.classification).toBe('NOT_INTERESTED');
    expect(classifyDeterministic('We already have something for this, though it is clunky.')).toBeNull();
    expect(classifyDeterministic('How would this handle per-customer minimums?')).toBeNull();
  });

  it('puts opt-out ahead of everything else', () => {
    const outcome = classifyDeterministic('Sounds great but please remove me from this list.');
    expect(outcome?.analysis.classification).toBe('UNSUBSCRIBE');
  });
});

describe('commitments require evidence in the text', () => {
  it('extracts a price acceptance and a pilot request from a genuinely strong reply', () => {
    const text = "Yes — $19/month is fine. Sign us up for the pilot, we'd like one of the first installs.";
    const types = commitmentTypesFor(analysis(), text);
    expect(types).toContain('EXPLICIT_PRICE_ACCEPTANCE');
    expect(types).toContain('PILOT_SIGNUP');
  });

  it('creates NO commitment for a weak reply, however confident the model is', () => {
    const weak = 'Sounds interesting, cool idea. Keep me posted.';
    // Deliberately hostile inputs: the model claims acceptance and a maximal
    // intent score. The text does not support either, so nothing is created.
    const overconfident = analysis({ classification: 'INTERESTED_WEAK', intentScore: 1 });
    expect(commitmentTypesFor(overconfident, weak)).toEqual([]);
  });

  it('never turns an opt-out or a rejection into a commitment', () => {
    const text = "$19/month is fine but please remove me from your list.";
    expect(commitmentTypesFor(analysis({ classification: 'UNSUBSCRIBE' }), text)).toEqual([]);
    expect(commitmentTypesFor(analysis({ classification: 'NOT_INTERESTED' }), text)).toEqual([]);
  });

  it('requires the model booleans as well as the words', () => {
    const text = 'Yes — $19/month is fine.';
    const modelSaysNo = analysis({ explicitlyAcceptedPrice: false, priceReaction: 'QUESTIONED' });
    expect(commitmentTypesFor(modelSaysNo, text)).toEqual([]);
  });

  it('counts one company once per type, no matter how often they reply', async () => {
    const ctx = await freshDb(BASE_ENV);
    const opportunityId = await insertOpportunity(ctx.db, { state: 'VALIDATING' });
    const campaignId = await insertCampaign(ctx.db, opportunityId);

    const input = {
      campaignId,
      prospectId: null,
      companyKey: 'northside.example.com',
      type: 'EXPLICIT_PRICE_ACCEPTANCE' as const,
      priceMonthly: 19,
      source: 'EMAIL_REPLY' as const,
      evidenceText: '$19/month is fine',
    };

    expect(await recordCommitments([input])).toBe(1);
    expect(await recordCommitments([input])).toBe(0);
    expect(await recordCommitments([{ ...input, evidenceText: 'they said it again' }])).toBe(0);

    const rows = await ctx.db.query('SELECT id FROM commitments WHERE company_key = $1', ['northside.example.com']);
    expect(rows.rowCount).toBe(1);

    // A different company is counted separately.
    expect(await recordCommitments([{ ...input, companyKey: 'other.example.com' }])).toBe(1);
  });
});

describe('reply agent safety gate', () => {
  it('rejects a draft that promises a launch date', () => {
    const offer = buildOffer();
    const report = checkReplySafety('Yes, it will be ready by March and we ship it next week.', offer);
    expect(report.ok).toBe(false);
    expect(report.violations).toContain('UNSAFE:DATE_PROMISE');
  });

  it('rejects a draft that invents a feature the offer never claimed', () => {
    const offer = buildOffer();
    const report = checkReplySafety('It has a full REST API and syncs with QuickBooks automatically.', offer);
    expect(report.ok).toBe(false);
    expect(report.violations).toContain('INVENTED_FEATURE:api');
    expect(report.violations).toContain('INVENTED_FEATURE:quickbooks');
  });

  it('rejects discounts, contract talk, legal opinions, calls, and guarantees', () => {
    const offer = buildOffer();
    expect(checkReplySafety('I can give you 50% off for the first year.', offer).violations).toContain('UNSAFE:DISCOUNT');
    expect(checkReplySafety('Happy to sign an agreement with net 30 terms.', offer).violations).toContain(
      'UNSAFE:CONTRACT_NEGOTIATION',
    );
    expect(checkReplySafety('Yes, it is fully GDPR compliant.', offer).violations).toContain(
      'UNSAFE:LEGAL_OR_COMPLIANCE_OPINION',
    );
    expect(checkReplySafety('Want to book a call on Calendly?', offer).violations).toContain('UNSAFE:BOOKING_A_CALL');
    expect(checkReplySafety('I guarantee it will solve this.', offer).violations).toContain('UNSAFE:GUARANTEE');
  });

  it('accepts an answer that stays inside the stored offer', () => {
    const offer = buildOffer();
    const safe = `It applies per-customer minimum order values and shows clear cart messaging. ${commitmentClose(offer)}`;
    expect(checkReplySafety(safe, offer)).toEqual({ ok: true, violations: [] });
  });

  it('refuses to auto-reply and asks for a human when the model goes off-script', async () => {
    const ctx = await freshDb(BASE_ENV);
    ctx.llm.register('outreach.auto_reply', () => ({
      canAnswerFromOffer: true,
      needsHuman: false,
      answer: 'Absolutely — it will be live next month and integrates with QuickBooks.',
      clarifyingQuestion: null,
    }));

    const decision = await draftAutoReply({
      analysis: analysis({ classification: 'ASKING_QUESTION' }),
      replyText: 'When will this be ready, and does it work with our accounting system?',
      offer: buildOffer(),
      prospect: PROSPECT,
      subject: 'Re: Question about Northside Supply',
    });

    expect(decision.message).toBeNull();
    expect(decision.requiresHuman).toBe(true);
    expect(decision.reason).toBe('UNSAFE_CONTENT');
    expect(decision.violations).toContain('UNSAFE:DATE_PROMISE');
    expect(decision.violations).toContain('INVENTED_FEATURE:quickbooks');
  });

  it('hands over to a human when the offer simply does not contain the answer', async () => {
    const ctx = await freshDb(BASE_ENV);
    ctx.llm.register('outreach.auto_reply', () => ({
      canAnswerFromOffer: false,
      needsHuman: true,
      answer: '',
      clarifyingQuestion: null,
    }));

    const decision = await draftAutoReply({
      analysis: analysis({ classification: 'ASKING_QUESTION' }),
      replyText: 'What is your data retention policy?',
      offer: buildOffer(),
      prospect: PROSPECT,
      subject: 'Re: question',
    });
    expect(decision.message).toBeNull();
    expect(decision.requiresHuman).toBe(true);
    expect(decision.reason).toBe('NOT_ANSWERABLE_FROM_OFFER');
  });

  it('produces a compliant, commitment-seeking reply when the answer is supported', async () => {
    const ctx = await freshDb(BASE_ENV);
    ctx.llm.register('outreach.auto_reply', () => ({
      canAnswerFromOffer: true,
      needsHuman: false,
      answer: 'It applies per-customer minimum order values and shows clear cart messaging.',
      clarifyingQuestion: null,
    }));

    const decision = await draftAutoReply({
      analysis: analysis({ classification: 'ASKING_QUESTION' }),
      replyText: 'Does it do per-customer minimums?',
      offer: buildOffer(),
      prospect: PROSPECT,
      subject: 'Re: Question about Northside Supply',
    });

    expect(decision.requiresHuman).toBe(false);
    expect(decision.message).not.toBeNull();
    // No fake "Re:" prefix, no call booking, and it asks for the commitment.
    expect(decision.message?.subject.startsWith('Re:')).toBe(false);
    expect(decision.message?.text).toContain('reserve it here');
    expect(decision.message?.text).toContain("isn't built yet");
    expect(decision.message?.text).toContain('55 Test Street, Boston MA 02118');
    expect(decision.message?.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('never auto-replies to an opt-out, a rejection, or an auto-responder', () => {
    expect(shouldAttemptAutoReply(analysis({ classification: 'UNSUBSCRIBE' }))).toBe(false);
    expect(shouldAttemptAutoReply(analysis({ classification: 'NOT_INTERESTED' }))).toBe(false);
    expect(shouldAttemptAutoReply(analysis({ classification: 'OUT_OF_OFFICE' }))).toBe(false);
    expect(shouldAttemptAutoReply(analysis({ requiresHuman: true }))).toBe(false);
    expect(shouldAttemptAutoReply(analysis({ classification: 'ASKING_QUESTION' }))).toBe(true);
  });
});

describe('inbound parsing treats mail as data', () => {
  it('strips scripts and tags rather than rendering anything', () => {
    const html = '<div>Yes please<script>alert(1)</script><a href="http://x">link</a></div>';
    const text = stripHtml(html);
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('alert(1)');
    expect(text).toContain('Yes please');
  });

  it('drops quoted history and signatures', () => {
    const parsed = parseInboundBody({
      text: [
        'Yes, $19/month is fine.',
        '',
        'Thanks,',
        'Dana',
        'Northside Supply',
        '',
        'On Mon, Sep 1, 2025 at 9:00 AM Alex <alex@validator.example> wrote:',
        '> I noticed your wholesale page...',
      ].join('\n'),
    });
    expect(parsed.cleaned).toContain('$19/month is fine');
    expect(parsed.cleaned).not.toContain('I noticed your wholesale page');
    expect(parsed.cleaned).not.toContain('Northside Supply');
  });
});
