/**
 * THE TESTS THAT STOP THE SYSTEM CONGRATULATING ITSELF.
 *
 * The expensive failure for this product is not a crash. It is declaring an
 * opportunity validated because somebody was polite, and sending the owner to
 * build a thing nobody agreed to buy.
 *
 * So these cases are adversarial on purpose: enthusiasm, agreement, curiosity
 * and flattery must all fail to validate, and only words a reasonable person
 * would read as commercial may pass.
 */
import { describe, it, expect } from 'vitest';
import {
  deterministicIntent,
  capIntentToEvidence,
  extractWillingnessAmount,
  reconcile,
  quoteAppears,
  looksAutomated,
  type IntentExtraction,
  type ReplyIntent,
} from '../../src/pipeline/outreach/intent';
import {
  evaluateLadder,
  strongestPerCompany,
  type CompanySignal,
} from '../../src/pipeline/validation/ladder';
import { stripQuotedReply } from '../../src/pipeline/outreach/polling';

function extraction(intent: ReplyIntent, quote: string, over: Partial<IntentExtraction> = {}): IntentExtraction {
  return {
    intent,
    confidence: 0.9,
    evidenceQuote: quote,
    currentWorkflow: null,
    currentTools: null,
    currentSpend: null,
    statedAmountUsd: null,
    priceSensitivity: null,
    requestedCapability: null,
    objection: null,
    nextAction: null,
    decisionMaker: null,
    unsolicited: true,
    qualifiedCompany: true,
    disqualifiedReason: null,
    ...over,
  };
}

const signal = (companyKey: string, intent: ReplyIntent, over: Partial<CompanySignal> = {}): CompanySignal => ({
  companyKey,
  intent,
  qualified: true,
  statedAmountUsd: null,
  messageId: `msg_${companyKey}`,
  quote: 'quoted words',
  ...over,
});

// --- the replies the owner named --------------------------------------------

describe('a reply only earns what its words support', () => {
  it('"Sounds interesting" does NOT become willingness to pay', () => {
    const text = 'Sounds interesting, thanks for reaching out.';
    const capped = capIntentToEvidence('WILLING_TO_PAY', text);
    expect(capped.intent).toBe('INTERESTED');
    expect(capped.demoted).toBe(true);
    expect(capped.why).toMatch(/enthusiasm is not willingness to pay/i);
  });

  it('"Yeah this is a pain" confirms the problem but commits to nothing', () => {
    const text = 'Yeah this is a pain, we deal with it every month.';
    // Even if a model reached for a commercial label, the words cap it.
    expect(capIntentToEvidence('WILLING_TO_PAY', text).intent).toBe('INTERESTED');
    // And on its own it is not a validation signal.
    const verdict = evaluateLadder([signal('acme.com', 'PAIN_CONFIRMED')], { hasOutreach: true });
    expect(verdict.stage).not.toBe('VALIDATED');
    expect(verdict.paymentIntentValidated).toBe(false);
  });

  it('"I\'d definitely try it" is strong but is NOT paid intent', () => {
    const text = "I'd definitely try it if you build it.";
    const capped = capIntentToEvidence('WILLING_TO_PAY', text);
    expect(capped.intent).toBe('INTERESTED');

    // Even read at its most generous, trying is not buying.
    const verdict = evaluateLadder([signal('acme.com', 'WILLING_TO_TRY')], { hasOutreach: true });
    expect(verdict.stage).toBe('COMMERCIAL_SIGNAL');
    expect(verdict.paymentIntentValidated).toBe(false);
  });

  it('"If you can do that for $300/mo we\'d pay for it" IS explicit willingness to pay', () => {
    const text = "If you can do that for $300/mo we'd pay for it.";
    expect(extractWillingnessAmount(text)).toBe(300);
    expect(capIntentToEvidence('WILLING_TO_PAY', text).demoted).toBe(false);
  });

  it('"Send me an invoice for the pilot" is the strongest commercial intent', () => {
    const text = 'Send me an invoice for the pilot and we can start next month.';
    expect(capIntentToEvidence('PAYMENT_COMMITMENT', text).intent).toBe('PAYMENT_COMMITMENT');
  });

  it('"No thanks" is negative', () => {
    expect(deterministicIntent('No thanks, not for us.')?.intent).toBe('NOT_INTERESTED');
  });

  it('"Remove me" suppresses immediately and overrides everything else', () => {
    const text = 'This looks great and we would pay $500/mo — but remove me from this list.';
    // Opt-out wins even when the same message contains buying language.
    expect(deterministicIntent(text)?.intent).toBe('UNSUBSCRIBE');
    const result = reconcile(extraction('WILLING_TO_PAY', 'we would pay $500/mo'), text);
    expect(result.intent).toBe('UNSUBSCRIBE');
    expect(result.statedAmountUsd).toBeNull();
  });

  it('"Talk to our operations director Sarah" is a referral, not a rejection', () => {
    const intent = deterministicIntent('You want to talk to our operations director Sarah.')?.intent;
    expect(intent).toBe('REFERRAL_TO_OTHER_PERSON');
    expect(intent).not.toBe('NOT_INTERESTED');
  });

  it('"I\'m out of office" is an auto-reply, not a signal', () => {
    const byHeader = deterministicIntent('I am out of office until Monday.', {
      'auto-submitted': 'auto-replied',
    });
    expect(byHeader?.intent).toBe('OUT_OF_OFFICE');
    expect(looksAutomated({ precedence: 'bulk' })).toBe(true);
  });
});

// --- money ------------------------------------------------------------------

describe('only a figure the prospect offers counts as willingness to pay', () => {
  it('reads an offered price', () => {
    expect(extractWillingnessAmount("we'd pay $250/month for that")).toBe(250);
    expect(extractWillingnessAmount('$1,200 per year works for us')).toBe(1200);
  });

  it('does NOT read current spend as willingness to pay', () => {
    // This is the trap: the same figure means the opposite thing.
    expect(extractWillingnessAmount('we currently pay $400/mo for Hubspot')).toBeNull();
    expect(extractWillingnessAmount("we're paying $99 a month already")).toBeNull();
    expect(extractWillingnessAmount('that costs us $2,000 per year in wasted time')).toBeNull();
  });

  it('ignores a price WE quoted that the prospect did not accept', () => {
    expect(extractWillingnessAmount('Is the $300/month figure negotiable?')).toBeNull();
  });
});

// --- the gate ---------------------------------------------------------------

describe('the validation gate', () => {
  it('refuses to validate on one enthusiastic company', () => {
    const v = evaluateLadder([signal('acme.com', 'WILLING_TO_PAY')], { hasOutreach: true });
    expect(v.stage).toBe('PAYMENT_INTENT');
    expect(v.paymentIntentValidated).toBe(false);
  });

  it('validates on two INDEPENDENT companies willing to pay', () => {
    const v = evaluateLadder(
      [signal('acme.com', 'WILLING_TO_PAY'), signal('brightco.com', 'WILLING_TO_PAY')],
      { hasOutreach: true },
    );
    expect(v.stage).toBe('VALIDATED');
    expect(v.paymentIntentValidated).toBe(true);
    // Intent is not revenue, and the system must never say otherwise.
    expect(v.revenueValidated).toBe(false);
    expect(v.reason).toMatch(/no money has moved/i);
  });

  it('does NOT count two people at the SAME company as two companies', () => {
    const v = evaluateLadder(
      [
        signal('acme.com', 'WILLING_TO_PAY', { messageId: 'm1' }),
        signal('acme.com', 'WILLING_TO_PAY', { messageId: 'm2' }),
      ],
      { hasOutreach: true },
    );
    expect(v.willingToPayCompanies).toEqual(['acme.com']);
    expect(v.stage).toBe('PAYMENT_INTENT');
    expect(v.paymentIntentValidated).toBe(false);
  });

  it('ignores unqualified respondents entirely', () => {
    const v = evaluateLadder(
      [
        signal('acme.com', 'WILLING_TO_PAY'),
        signal('consultancy.com', 'WILLING_TO_PAY', { qualified: false }),
      ],
      { hasOutreach: true },
    );
    // The vendor/consultant does not get to vote.
    expect(v.willingToPayCompanies).toEqual(['acme.com']);
    expect(v.paymentIntentValidated).toBe(false);
  });

  it('validates on one concrete commitment plus one independent supporter', () => {
    const v = evaluateLadder(
      [signal('acme.com', 'PAYMENT_COMMITMENT'), signal('brightco.com', 'PILOT_INTEREST')],
      { hasOutreach: true },
    );
    expect(v.stage).toBe('VALIDATED');
    expect(v.paymentIntentValidated).toBe(true);
  });

  it('does NOT validate on a commitment with no corroboration', () => {
    const v = evaluateLadder([signal('acme.com', 'PAYMENT_COMMITMENT')], { hasOutreach: true });
    expect(v.stage).toBe('PAYMENT_INTENT');
    expect(v.reason).toMatch(/one buyer is an anecdote/i);
  });

  it('keeps the strongest signal per company, not the latest', () => {
    const best = strongestPerCompany([
      signal('acme.com', 'PAIN_CONFIRMED'),
      signal('acme.com', 'WILLING_TO_PAY'),
      signal('acme.com', 'NEUTRAL'),
    ]);
    expect(best.get('acme.com')?.intent).toBe('WILLING_TO_PAY');
  });

  it('never validates from public research alone', () => {
    const v = evaluateLadder([], { hasOutreach: false });
    expect(v.stage).toBe('EVIDENCE_BACKED');
    expect(v.reason).toMatch(/no prospect has been contacted/i);
  });

  it('pain from many companies is still not a commercial signal', () => {
    const v = evaluateLadder(
      [signal('a.com', 'PAIN_CONFIRMED'), signal('b.com', 'PAIN_CONFIRMED'), signal('c.com', 'PAIN_CONFIRMED')],
      { hasOutreach: true },
    );
    expect(v.stage).toBe('PAIN_CONFIRMED');
    expect(v.paymentIntentValidated).toBe(false);
  });
});

// --- the model may not overstate --------------------------------------------

describe('a model classification is capped by the literal words', () => {
  it('demotes an unsupported commercial verdict', () => {
    const text = 'This is a great idea, good luck with it!';
    const out = reconcile(extraction('PAYMENT_COMMITMENT', 'This is a great idea'), text);
    expect(out.intent).toBe('INTERESTED');
    expect(out.demoted).toBe(true);
  });

  it('demotes PAYMENT_COMMITMENT to WILLING_TO_PAY without a concrete next step', () => {
    const text = "We'd pay for that, it would save us hours.";
    expect(capIntentToEvidence('PAYMENT_COMMITMENT', text).intent).toBe('WILLING_TO_PAY');
  });

  it('demotes pilot interest with no pilot language', () => {
    expect(capIntentToEvidence('PILOT_INTEREST', 'Tell me more about it.').intent).toBe('INTERESTED');
  });

  it('demotes price acceptance when price was never discussed', () => {
    expect(capIntentToEvidence('PRICE_ACCEPTABLE', 'Yes we have that problem.').intent).toBe('INTERESTED');
  });

  it('rejects a quote the reply does not contain', () => {
    const text = 'We spend about four hours a week on this.';
    expect(quoteAppears('we would pay anything', text)).toBe(false);
    expect(quoteAppears('four hours a week', text)).toBe(true);
  });
});

// --- quoted history ----------------------------------------------------------

describe('quoted history is removed before classification', () => {
  it('drops a Gmail attribution that wraps across two lines', () => {
    const reply = [
      'TEST INTERESTED',
      '',
      'On Thu, Sep 24, 2026 at 9:31 PM Judson Dunne <judson@mail.judsondunne.com>',
      'wrote:',
      '',
      '> Automated polling canary from the MRR validator.',
      '> We proposed $300/month.',
    ].join('\n');
    const body = stripQuotedReply(reply);
    expect(body).toBe('TEST INTERESTED');
    // Our own outbound copy must not survive: a price WE proposed, read back
    // as the prospect's words, would manufacture willingness to pay.
    expect(body).not.toMatch(/judson@mail\.judsondunne\.com/);
    expect(body).not.toMatch(/\$300/);
  });

  it('drops a single-line attribution and a quote block', () => {
    expect(stripQuotedReply('Yes please.\n\nOn Mon, Jan 1 2026, X wrote:\n> old')).toBe('Yes please.');
    expect(stripQuotedReply('No thanks.\n> quoted')).toBe('No thanks.');
  });

  it('keeps a reply that merely mentions the word "on"', () => {
    expect(stripQuotedReply('We are on it, send details.')).toBe('We are on it, send details.');
  });
});
