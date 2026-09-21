/**
 * Conversation state, the reply agent's memory, and structured objections.
 *
 * The reply agent is the only place software talks to a real person, so what
 * matters here is what it will NOT do: quote a price other than the one this
 * prospect was assigned, re-ask something they already answered, or agree that
 * a feature outside the pilot is coming.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown, insertOpportunity, insertCampaign, insertProspect } from '../helpers';
import { resetConfigCache } from '../../src/lib/config';
import { newId } from '../../src/lib/hash';
import type { Db } from '../../src/lib/db';
import type { ReplyAnalysis } from '../../src/lib/contracts';
import {
  detectQuestions,
  ensureConversation,
  getConversation,
  levelForAnalysis,
  mergeLevel,
  recordInboundTurn,
  recordOutboundTurn,
} from '../../src/pipeline/outreach/conversation';
import {
  aggregateObjections,
  extractObjections,
  recordObjections,
} from '../../src/pipeline/outreach/objections';
import { draftAutoReply, deterministicAnswers } from '../../src/pipeline/outreach/reply-agent';
import { loadOfferForProspect, isFeaturePlanned, type OfferContext } from '../../src/pipeline/outreach/offer';
import { assignPrice, ensurePriceExperiments } from '../../src/autonomy/pricing';
import { roleKeyFor } from '../../src/pipeline/outreach/contact-role';

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

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_ENV, ...overrides };
}

function analysis(overrides: Partial<ReplyAnalysis> = {}): ReplyAnalysis {
  return {
    classification: 'ASKING_QUESTION',
    intent: 'asks something',
    requestedFeature: null,
    competitorMentioned: null,
    priceReaction: 'NOT_MENTIONED',
    timing: null,
    explicitlyWantsAccess: false,
    explicitlyAcceptedPrice: false,
    requiresHuman: false,
    intentScore: 0.3,
    ...overrides,
  };
}

const LANDING_COPY = {
  productName: 'Minimum Order Rules',
  outcome: 'keep wholesale orders under your minimum out of checkout',
  capabilities: ['per-customer minimum order values', 'collection-level minimums', 'clear cart messaging'],
  priceMonthly: 19,
  whoItIsFor: 'Shopify stores with a wholesale channel',
  workflow: 'enforcing minimum order quantities at checkout',
  incumbentComplexity: 'the full B2B rebuild the incumbent requires',
  earlyAccess: 'Early access: the first pilot installs go to stores that join now, at $19/month.',
  buildStatus: 'BEING_VALIDATED_NOT_BUILT',
  validationDisclosure:
    'This Shopify app does not exist yet. It is being validated before it is built: ' +
    'if enough stores want it at $19/month I build it and pilot stores get the first install. ' +
    'Nothing is charged today.',
  cta: 'Join the pilot at $19/month',
  ecosystem: 'Shopify',
};

const PROSPECT = {
  id: 'pr_1',
  companyName: 'Northside Supply',
  domain: 'northside.example.com',
  contactEmail: 'hello@northside.example.com',
  contactName: null,
  publicEvidenceUrl: 'https://northside.example.com/wholesale',
  qualificationReason: 'publishes a wholesale application page',
};

async function seedOffer(
  db: Db,
  params: { prices?: number[]; campaignPrice?: number } = {},
): Promise<{ opportunityId: string; campaignId: string; prospectId: string; offer: OfferContext }> {
  const opportunityId = await insertOpportunity(db, { state: 'VALIDATING' });
  const campaignId = await insertCampaign(db, opportunityId, {
    state: 'BATCH_1',
    price: params.campaignPrice ?? 19,
  });
  await db.query('UPDATE campaigns SET landing_copy_json = $2 WHERE id = $1', [
    campaignId,
    JSON.stringify(LANDING_COPY),
  ]);
  const prospectId = await insertProspect(db, opportunityId, { domain: 'northside.example.com' });
  if (params.prices) {
    await ensurePriceExperiments(campaignId, params.prices);
    await assignPrice({ campaignId, prospectId });
  }
  const offer = await loadOfferForProspect(campaignId, prospectId);
  return { opportunityId, campaignId, prospectId, offer: offer! };
}

// ---------------------------------------------------------------------------

describe('question detection and the commitment ladder', () => {
  it('recognises the questions that actually get asked', () => {
    expect(detectQuestions('How much is it?')).toContain('PRICE');
    expect(detectQuestions('What is the pricing?')).toContain('PRICE');
    expect(detectQuestions('When will this be ready?')).toContain('TIMELINE');
    expect(detectQuestions('Any ETA?')).toContain('TIMELINE');
    expect(detectQuestions('Can it do multi-currency?')).toContain('FEATURE');
    expect(detectQuestions('How does this work?')).toContain('HOW_IT_WORKS');
    expect(detectQuestions('Never heard of you — who are you?')).toContain('TRUST');
    expect(detectQuestions('Thanks!')).toEqual([]);
  });

  it('only ever climbs, and a decline is one-way', () => {
    expect(levelForAnalysis(analysis({ classification: 'INTERESTED_WEAK' }))).toBe('CURIOUS');
    expect(levelForAnalysis(analysis({ classification: 'WANTS_PILOT' }))).toBe('COMMITTED');
    expect(levelForAnalysis(analysis({ classification: 'NOT_INTERESTED' }))).toBe('DECLINED');

    expect(mergeLevel('CURIOUS', 'NONE')).toBe('CURIOUS');
    expect(mergeLevel('CURIOUS', 'COMMITTED')).toBe('COMMITTED');
    expect(mergeLevel('COMMITTED', 'CURIOUS')).toBe('COMMITTED');
    // Somebody who said no has not become curious again.
    expect(mergeLevel('DECLINED', 'COMMITTED')).toBe('DECLINED');
    expect(mergeLevel('COMMITTED', 'DECLINED')).toBe('DECLINED');
  });
});

describe('conversation state', () => {
  it('records one row per (campaign, prospect) and folds turns into it', async () => {
    const ctx = await freshDb(env());
    const { campaignId, prospectId } = await seedOffer(ctx.db);

    await ensureConversation({ campaignId, prospectId, threadId: 'thread_1' });
    await ensureConversation({ campaignId, prospectId });
    const rows = await ctx.db.query('SELECT id FROM conversations');
    expect(rows.rowCount).toBe(1);

    const after = await recordInboundTurn({
      campaignId,
      prospectId,
      text: 'How much is it, and when will it be ready?',
      analysis: analysis({ classification: 'ASKING_QUESTION', requestedFeature: 'csv export' }),
      objections: ['TIMING'],
    });
    expect(after.asked).toEqual(expect.arrayContaining(['PRICE', 'TIMELINE']));
    expect(after.commitmentLevel).toBe('CURIOUS');
    expect(after.requestedFeatures).toContain('csv export');
    expect(after.objections).toContain('TIMING');
    expect(after.awaitingReply).toBe(false);

    await recordOutboundTurn({ campaignId, prospectId, answered: ['PRICE'], priceQuoted: 19 });
    const final = await getConversation(campaignId, prospectId);
    expect(final?.answered).toEqual(['PRICE']);
    expect(final?.priceQuoted).toBe(19);
    expect(final?.awaitingReply).toBe(true);
    // The inbound record is not lost by the outbound one.
    expect(final?.asked).toEqual(expect.arrayContaining(['PRICE', 'TIMELINE']));
  });
});

describe('the reply agent quotes the ASSIGNED price', () => {
  it('states the experiment price exactly, and never the campaign default', async () => {
    const ctx = await freshDb(env());
    // Campaign default is $19; this prospect's arm is $29.
    const { campaignId, prospectId, offer } = await seedOffer(ctx.db, { prices: [29], campaignPrice: 19 });
    expect(offer.priceMonthly).toBe(29);

    const decision = await draftAutoReply({
      analysis: analysis({ classification: 'ASKING_QUESTION' }),
      replyText: 'Interesting — how much is it?',
      offer,
      prospect: PROSPECT,
      subject: 'Re: Question about Northside Supply',
      conversation: await ensureConversation({ campaignId, prospectId }),
    });

    expect(decision.message).not.toBeNull();
    expect(decision.message?.text).toContain("It's $29/month.");
    expect(decision.message?.text).not.toContain('$19');
    expect(decision.quotedPrice).toBe(29);
    expect(decision.answered).toContain('PRICE');
    // A price question is answered by code, so no model is consulted at all.
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('moves an "I would use this" reply straight to the reservation link', async () => {
    const ctx = await freshDb(env());
    const { offer } = await seedOffer(ctx.db);

    const decision = await draftAutoReply({
      analysis: analysis({ classification: 'INTERESTED_STRONG', explicitlyWantsAccess: true }),
      replyText: "I'd use this.",
      offer,
      prospect: PROSPECT,
      subject: 'Re: Question about Northside Supply',
    });

    expect(decision.message).not.toBeNull();
    expect(decision.message?.text).toContain('reserve it here');
    expect(decision.message?.text).toContain(offer.landingUrl);
    expect(decision.message?.text).toContain("isn't built yet");
    expect(ctx.llm.calls).toHaveLength(0);
  });
});

describe('"when is it ready?" is answered truthfully and without a date', () => {
  it('states the pilot status, invites a reservation, and promises nothing', async () => {
    const ctx = await freshDb(env());
    const { offer } = await seedOffer(ctx.db);

    const decision = await draftAutoReply({
      analysis: analysis({ classification: 'ASKING_QUESTION' }),
      replyText: 'When will this be ready?',
      offer,
      prospect: PROSPECT,
      subject: 'Re: Question about Northside Supply',
    });

    const text = decision.message?.text ?? '';
    expect(decision.message).not.toBeNull();
    expect(text).toContain("isn't built yet");
    expect(text).toContain("can't give you a date");
    expect(text).toContain('reserve it here');
    // No month, no quarter, no "next week", no ETA. The safety gate passed,
    // which is what proves it: a date promise would have blocked the send.
    expect(text).not.toMatch(/\b(next (week|month|quarter)|release date|eta is)\b/i);
    expect(decision.answered).toContain('TIMELINE');
    expect(ctx.llm.calls).toHaveLength(0);
  });
});

describe('"can it do X?"', () => {
  it('says a planned V1 capability is planned for the pilot', async () => {
    const ctx = await freshDb(env());
    const { offer } = await seedOffer(ctx.db);
    expect(isFeaturePlanned('collection-level minimums', offer)).toBe(true);

    const decision = await draftAutoReply({
      analysis: analysis({
        classification: 'FEATURE_REQUIREMENT',
        requestedFeature: 'collection-level minimums',
      }),
      replyText: 'Can it do collection-level minimums?',
      offer,
      prospect: PROSPECT,
      subject: 'Re: Question',
    });

    expect(decision.message?.text).toContain('planned for the pilot');
    expect(decision.featureRequests).toEqual([]);
  });

  it('refuses to promise an out-of-scope feature, and logs the request', async () => {
    const ctx = await freshDb(env());
    const { campaignId, prospectId, offer } = await seedOffer(ctx.db);
    expect(isFeaturePlanned('multi-currency pricing', offer)).toBe(false);

    const decision = await draftAutoReply({
      analysis: analysis({
        classification: 'FEATURE_REQUIREMENT',
        requestedFeature: 'multi-currency pricing',
      }),
      replyText: 'Can it do multi-currency pricing?',
      offer,
      prospect: PROSPECT,
      subject: 'Re: Question',
    });

    const text = decision.message?.text ?? '';
    expect(decision.message).not.toBeNull();
    expect(text).toContain("isn't part of the proposed pilot");
    expect(text).not.toContain('planned for the pilot');
    // Not promised, not hedged into a yes, and not smuggled in as a feature
    // the offer never claimed.
    expect(text).not.toMatch(/\b(we will|i will|coming soon|on the roadmap)\b/i);
    expect(text.toLowerCase()).not.toContain('multi-currency');

    // The request is captured as data rather than answered with a promise.
    expect(decision.featureRequests).toEqual(['multi-currency pricing']);
    await recordOutboundTurn({
      campaignId,
      prospectId,
      answered: decision.answered,
      requestedFeatures: decision.featureRequests,
    });
    const conversation = await getConversation(campaignId, prospectId);
    expect(conversation?.requestedFeatures).toContain('multi-currency pricing');
  });

  it('builds those answers deterministically, with no model in the loop', async () => {
    const ctx = await freshDb(env());
    const { offer } = await seedOffer(ctx.db);
    const answers = deterministicAnswers({
      questions: ['PRICE', 'TIMELINE', 'FEATURE'],
      analysis: analysis({ requestedFeature: 'multi-currency pricing' }),
      offer,
    });
    expect(answers.map((a) => a.key)).toEqual(['PRICE', 'TIMELINE', 'FEATURE']);
    expect(answers.find((a) => a.key === 'FEATURE')?.featureRequest).toBe('multi-currency pricing');
    expect(ctx.llm.calls).toHaveLength(0);
  });
});

describe('the reply agent does not repeat itself', () => {
  it('drops a clarifying question this thread has already covered', async () => {
    const ctx = await freshDb(env());
    const { campaignId, prospectId, offer } = await seedOffer(ctx.db);
    ctx.llm.register('outreach.auto_reply', () => ({
      canAnswerFromOffer: true,
      needsHuman: false,
      answer: 'It applies per-customer minimum order values at checkout.',
      clarifyingQuestion: 'How much do you currently pay for that?',
    }));

    // The thread already answered PRICE.
    await ensureConversation({ campaignId, prospectId });
    await recordOutboundTurn({ campaignId, prospectId, answered: ['PRICE'], priceQuoted: 19 });
    const conversation = await getConversation(campaignId, prospectId);

    const decision = await draftAutoReply({
      analysis: analysis({ classification: 'ASKING_QUESTION' }),
      replyText: 'How does this work?',
      offer,
      prospect: PROSPECT,
      subject: 'Re: Question',
      conversation,
    });

    expect(decision.message).not.toBeNull();
    expect(decision.message?.text).toContain('per-customer minimum order values');
    // The model wanted to ask about price again. It does not get to.
    expect(decision.message?.text).not.toContain('How much do you currently pay');
  });

  it('never interrogates somebody who has already committed', async () => {
    const ctx = await freshDb(env());
    const { campaignId, prospectId, offer } = await seedOffer(ctx.db);
    ctx.llm.register('outreach.auto_reply', () => ({
      canAnswerFromOffer: true,
      needsHuman: false,
      answer: 'It applies per-customer minimum order values at checkout.',
      clarifyingQuestion: 'How many wholesale orders do you take each month?',
    }));

    await ensureConversation({ campaignId, prospectId });
    await recordInboundTurn({
      campaignId,
      prospectId,
      text: 'Sign us up for the pilot.',
      analysis: analysis({ classification: 'WANTS_PILOT', explicitlyWantsAccess: true }),
    });
    const conversation = await getConversation(campaignId, prospectId);
    expect(conversation?.commitmentLevel).toBe('COMMITTED');

    const decision = await draftAutoReply({
      analysis: analysis({ classification: 'ASKING_QUESTION' }),
      replyText: 'How does this work?',
      offer,
      prospect: PROSPECT,
      subject: 'Re: Question',
      conversation,
    });
    expect(decision.message?.text).not.toContain('How many wholesale orders');
  });
});

describe('objections', () => {
  it('extracts structured kinds deterministically', async () => {
    await freshDb(env());
    expect(
      extractObjections({ text: 'Way too expensive for us right now.', analysis: analysis() }).map((o) => o.kind),
    ).toContain('TOO_EXPENSIVE');
    expect(
      extractObjections({ text: 'We already use Wholesale Club.', analysis: analysis() }).map((o) => o.kind),
    ).toContain('HAPPY_WITH_COMPETITOR');
    expect(
      extractObjections({ text: "We're on BigCommerce, not Shopify.", analysis: analysis() }).map((o) => o.kind),
    ).toContain('PLATFORM_INCOMPATIBLE');
    expect(
      extractObjections({ text: 'Where did you get my email?', analysis: analysis() }).map((o) => o.kind),
    ).toContain('PRIVACY_SECURITY');
    expect(
      extractObjections({ text: 'Not right now, check back next year.', analysis: analysis() }).map((o) => o.kind),
    ).toContain('TIMING');

    // Structured classifier signals count as corroboration too.
    expect(
      extractObjections({ text: 'Hmm.', analysis: analysis({ priceReaction: 'TOO_HIGH' }) }).map((o) => o.kind),
    ).toContain('TOO_EXPENSIVE');
    expect(
      extractObjections({ text: 'Hmm.', analysis: analysis({ classification: 'WRONG_PERSON' }) }).map((o) => o.kind),
    ).toContain('WRONG_CONTACT');
    expect(extractObjections({ text: 'Sounds great!', analysis: analysis() })).toEqual([]);
  });

  it('aggregates into plain counts that cannot be argued down', async () => {
    const ctx = await freshDb(env());
    const { opportunityId, campaignId } = await seedOffer(ctx.db);

    // Three different businesses all say the same thing.
    for (let i = 0; i < 3; i += 1) {
      const prospectId = await insertProspect(ctx.db, opportunityId, { domain: `store-${i}.example.com` });
      const messageId = newId('msg');
      await ctx.db.query(
        `INSERT INTO messages (id, campaign_id, prospect_id, direction, sequence_step, status, received_at, idempotency_key)
         VALUES ($1,$2,$3,'INBOUND',-1,'RECEIVED', now(), $4)`,
        [messageId, campaignId, prospectId, `inbound:${messageId}`],
      );
      expect(
        await recordObjections({
          campaignId,
          opportunityId,
          prospectId,
          messageId,
          companyKey: `store-${i}.example.com`,
          objections: extractObjections({
            text: 'Honestly this is too expensive, and we already use Wholesale Club.',
            analysis: analysis({ classification: 'USING_COMPETITOR' }),
          }),
          evidenceText: 'too expensive',
        }),
      ).toBe(2);
      // Reprocessing the same message adds nothing.
      expect(
        await recordObjections({
          campaignId,
          opportunityId,
          prospectId,
          messageId,
          companyKey: `store-${i}.example.com`,
          objections: [{ kind: 'TOO_EXPENSIVE', detail: 'again' }],
          evidenceText: 'too expensive',
        }),
      ).toBe(0);
    }

    const summary = await aggregateObjections(opportunityId);
    const byKind = new Map(summary.map((s) => [s.kind, s]));
    expect(byKind.get('TOO_EXPENSIVE')).toEqual({ kind: 'TOO_EXPENSIVE', count: 3, uniqueCompanies: 3 });
    expect(byKind.get('HAPPY_WITH_COMPETITOR')?.uniqueCompanies).toBe(3);
  });
});

describe('contact roles are classified, never invented', () => {
  it('buckets a published local part', () => {
    expect(roleKeyFor('wholesale@northside.com')).toBe('wholesale');
    expect(roleKeyFor('trade@northside.com')).toBe('wholesale');
    expect(roleKeyFor('hello@northside.com')).toBe('hello');
    expect(roleKeyFor('customer.service@northside.com')).toBe('support');
    expect(roleKeyFor('dana@northside.com')).toBe('other');
    expect(roleKeyFor('')).toBe('other');
  });

  it('accumulates performance per role x ICP x opportunity class', async () => {
    const ctx = await freshDb(env());
    const { campaignId } = await seedOffer(ctx.db);
    const { recordRoleOutcomeFor, rolePerformance } = await import('../../src/pipeline/outreach/contact-role');

    await recordRoleOutcomeFor({ campaignId, email: 'wholesale@a.example.com' }, { sent: 1 });
    await recordRoleOutcomeFor({ campaignId, email: 'wholesale@b.example.com' }, { sent: 1, delivered: 1 });
    await recordRoleOutcomeFor({ campaignId, email: 'hello@c.example.com' }, { sent: 1 });

    const rows = await rolePerformance({});
    const byRole = new Map(rows.map((r) => [r.roleKey, r]));
    expect(byRole.get('wholesale')?.sent).toBe(2);
    expect(byRole.get('wholesale')?.delivered).toBe(1);
    expect(byRole.get('hello')?.sent).toBe(1);
    // Under-sampled, so the system declines to have an opinion.
    expect(rows.every((r) => r.hasSufficientSample === false)).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
  });
});
