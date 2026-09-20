/**
 * Demo fixtures — four scenarios that exercise the whole funnel without any
 * network access. Everything here is SYNTHETIC and clearly marked as such:
 * company names use example.com-style domains that cannot resolve to a real
 * business, and no fixture is ever emailed (they are seeded in shadow mode).
 *
 *   1. failed-idea            -> CATEGORY_REJECTED   (no payment evidence)
 *   2. good-research-no-demand-> VALIDATION_FAILED   (great category, nobody wants our wedge)
 *   3. weak-replies           -> VALIDATION_FAILED   (replies, but all weak signals)
 *   4. strong-validated       -> READY_TO_BUILD      (the exact target progression)
 *
 * Scenario 2 is the point of the whole system: research quality is NOT demand.
 */
import { getDb, type Db } from '../lib/db';
import { newId } from '../lib/hash';

export type ScenarioName =
  | 'failed-idea'
  | 'good-research-no-demand'
  | 'weak-replies'
  | 'strong-validated';

export const SCENARIOS: readonly ScenarioName[] = [
  'failed-idea',
  'good-research-no-demand',
  'weak-replies',
  'strong-validated',
];

export interface SeededScenario {
  scenario: ScenarioName;
  opportunityId: string;
  campaignId: string | null;
  expectedFinalState: string;
}

interface OppSpec {
  name: string;
  category: string;
  state: string;
  evidenceConfidence: string | null;
  buildDays: number | null;
  price: number | null;
  wedge: string | null;
  targetCustomer: string | null;
  rejectionReason?: string | null;
}

async function insertOpportunity(db: Db, spec: OppSpec): Promise<string> {
  const id = newId('opp');
  await db.query(
    `INSERT INTO opportunities
       (id, name, ecosystem, category, description, source_url, state, evidence_confidence,
        estimated_build_days, proposed_price_monthly, proposed_wedge, target_customer,
        rejection_reason, dedupe_key, wedge_json)
     VALUES ($1,$2,'shopify',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      spec.name,
      spec.category,
      `[DEMO FIXTURE] ${spec.name}`,
      'https://apps.shopify.com/example-listing',
      spec.state,
      spec.evidenceConfidence,
      spec.buildDays,
      spec.price,
      spec.wedge,
      spec.targetCustomer,
      spec.rejectionReason ?? null,
      `shopify:${spec.category}:${id}`,
      JSON.stringify(
        spec.wedge
          ? {
              statement: spec.wedge,
              productName: spec.name,
              targetCustomer: spec.targetCustomer,
              v1Features: [
                'Case-pack quantity rules per product',
                'Customer-tag minimum order values',
                'Clear cart-level explanation of why checkout is blocked',
              ],
              excludedFromV1: ['Multi-currency minimums', 'Per-collection rules', 'Any AI feature'],
              proposedPriceMonthly: spec.price,
              estimatedBuildDays: spec.buildDays,
              capabilities: [
                'Block checkout below a case-pack multiple',
                'Set different minimums per customer tag',
                'Explain the rule to the shopper at the cart',
              ],
              oneSentenceOutcome:
                'Stop wholesale customers checking out below your minimum, without a rules engine.',
              whoItIsFor: spec.targetCustomer,
            }
          : null,
      ),
    ],
  );
  return id;
}

async function insertCompetitorWithEvidence(
  db: Db,
  opportunityId: string,
  strong: boolean,
): Promise<string> {
  const id = newId('cmp');
  const evidence = strong
    ? [
        {
          type: 'INCUMBENT_NO_FREE_TIER',
          sourceUrl: 'https://apps.shopify.com/example-listing',
          quote: 'Pricing: $19.99/month. 7-day free trial. No free plan.',
          date: '2026-05-02',
          confidence: 'HIGH',
          note: 'Listing pricing block, parsed deterministically',
        },
        {
          type: 'CUSTOMER_REFERENCES_PAID_PLAN',
          sourceUrl: 'https://apps.shopify.com/example-listing/reviews',
          quote: 'We have been on the $19.99 plan for about two years now.',
          date: '2026-03-14',
          confidence: 'HIGH',
          note: 'Review text explicitly names a paid plan',
        },
        {
          type: 'SUSTAINED_USAGE_DURATION',
          sourceUrl: 'https://apps.shopify.com/example-listing/reviews',
          quote: 'Using the app for over 2 years',
          date: '2026-03-14',
          confidence: 'MEDIUM',
          note: 'Independent corroboration of sustained demand',
        },
      ]
    : [
        {
          type: 'PRICING_PAGE_EXISTS',
          sourceUrl: 'https://example-vendor.test/pricing',
          quote: 'Plans from $9/month',
          date: null,
          confidence: 'LOW',
          note: 'A pricing page is not proof anyone pays',
        },
      ];

  await db.query(
    `INSERT INTO competitors
       (id, opportunity_id, name, url, current_pricing, free_plan_details,
        has_permanent_free_tier, review_count, rating, launch_age, evidence_json, payment_evidence_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      opportunityId,
      strong ? 'Example Order Limits (demo)' : 'Example Weak Competitor (demo)',
      'https://apps.shopify.com/example-listing',
      strong ? '$19.99/month' : '$9/month',
      strong ? 'No permanent free plan; 7-day trial only' : 'Free forever plan available',
      !strong,
      strong ? 412 : 6,
      strong ? 4.8 : 3.1,
      strong ? '5 years' : '4 months',
      JSON.stringify({ demo: true }),
      JSON.stringify(evidence),
    ],
  );

  for (const [i, text] of [
    'Support took three days and the minimum order rule silently stopped applying to tagged customers.',
    'Works, but the pricing jumped and we only use one of the twelve rule types.',
    'Setup was confusing — it took an afternoon to configure one case-pack rule.',
  ].entries()) {
    await db.query(
      `INSERT INTO reviews
         (id, competitor_id, source_url, rating, review_date, merchant_name,
          usage_duration, text, payment_signal, complaint_tags, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        newId('rev'),
        id,
        'https://apps.shopify.com/example-listing/reviews',
        i === 1 ? 3 : 2,
        '2026-03-14',
        `Demo Merchant ${i + 1}`,
        '2 years',
        text,
        i === 1 ? 'PAID_PLAN_REFERENCED' : 'NONE',
        JSON.stringify(i === 0 ? ['support', 'reliability'] : i === 1 ? ['pricing'] : ['complexity']),
        newId('hash'),
      ],
    );
  }
  return id;
}

async function insertProspects(db: Db, opportunityId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = newId('pr');
    const domain = `demo-wholesaler-${i + 1}.example.com`;
    await db.query(
      `INSERT INTO prospects
         (id, opportunity_id, company_name, domain, ecosystem, public_evidence_url,
          qualification_reason, qualification_score, contact_email, contact_source_url,
          email_is_public, country, status)
       VALUES ($1,$2,$3,$4,'shopify',$5,$6,$7,$8,$9,true,'US','QUALIFIED')`,
      [
        id,
        opportunityId,
        `Demo Wholesaler ${i + 1} (fixture)`,
        domain,
        `https://${domain}/wholesale`,
        'Public wholesale page states a 12-unit case-pack minimum',
        0.82,
        `hello@${domain}`,
        `https://${domain}/contact`,
      ],
    );
    ids.push(id);
  }
  return ids;
}

async function insertCampaign(
  db: Db,
  opportunityId: string,
  price: number,
  state: string,
): Promise<string> {
  const id = newId('cmp');
  await db.query(
    `INSERT INTO campaigns
       (id, opportunity_id, state, offer_name, price_monthly, landing_slug,
        landing_copy_json, started_at, target_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), 150)`,
    [
      id,
      opportunityId,
      state,
      'Case-Pack Minimums (demo)',
      price,
      `demo-${id.slice(-8)}`,
      JSON.stringify({
        productName: 'Case-Pack Minimums',
        oneSentenceOutcome:
          'Stop wholesale customers checking out below your case-pack minimum.',
        capabilities: [
          'Block checkout below a case-pack multiple',
          'Set different minimums per customer tag',
          'Explain the rule to the shopper at the cart',
        ],
        priceMonthly: price,
        whoItIsFor: 'Shopify wholesalers selling in fixed case quantities',
        validationNotice:
          'This product is being validated and built. It is not available yet. ' +
          'Joining the pilot reserves one of the first installs.',
        cta: `Join the pilot at $${price}/month`,
      }),
    ],
  );
  return id;
}

async function insertDelivered(
  db: Db,
  campaignId: string,
  prospectIds: string[],
): Promise<void> {
  for (const pid of prospectIds) {
    await db.query(
      `INSERT INTO messages
         (id, campaign_id, prospect_id, direction, sequence_step, subject, body,
          sent_at, delivered_at, status, idempotency_key)
       VALUES ($1,$2,$3,'OUTBOUND',0,$4,$5, now(), now(), 'DELIVERED', $6)`,
      [
        newId('msg'),
        campaignId,
        pid,
        'Quick question about your case-pack minimums',
        '[DEMO FIXTURE] outreach body',
        `${campaignId}:${pid}:0`,
      ],
    );
  }
}

async function insertReply(
  db: Db,
  campaignId: string,
  prospectId: string,
  classification: string,
  body: string,
  intentScore: number,
): Promise<string> {
  const id = newId('msg');
  await db.query(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, subject, body,
        received_at, status, classification, intent_score)
     VALUES ($1,$2,$3,'INBOUND',-1,'Re: Quick question',$4, now(), 'RECEIVED',$5,$6)`,
    [id, campaignId, prospectId, body, classification, intentScore],
  );
  return id;
}

async function insertCommitment(
  db: Db,
  campaignId: string,
  prospectId: string,
  companyKey: string,
  type: string,
  price: number,
  evidence: string,
  source = 'EMAIL_REPLY',
): Promise<void> {
  await db.query(
    `INSERT INTO commitments
       (id, campaign_id, prospect_id, company_key, type, price_monthly, source,
        evidence_text, verified, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      newId('cmt'),
      campaignId,
      prospectId,
      companyKey,
      type,
      price,
      source,
      evidence,
      `${campaignId}:${companyKey}:${type}`,
    ],
  );
}

// --- scenarios ---------------------------------------------------------------

export async function seedScenario(scenario: ScenarioName): Promise<SeededScenario> {
  const db = await getDb();

  switch (scenario) {
    case 'failed-idea': {
      // Plenty of enthusiasm, zero proof anyone pays. Must die at verification.
      const opportunityId = await insertOpportunity(db, {
        name: 'AI Store Copilot (demo failure)',
        category: 'generic-ai-assistant',
        state: 'CATEGORY_REJECTED',
        evidenceConfidence: 'LOW',
        buildDays: 21,
        price: null,
        wedge: null,
        targetCustomer: null,
        rejectionReason: 'ONLY_WEAK_EVIDENCE',
      });
      await insertCompetitorWithEvidence(db, opportunityId, false);
      return { scenario, opportunityId, campaignId: null, expectedFinalState: 'CATEGORY_REJECTED' };
    }

    case 'good-research-no-demand': {
      // THE IMPORTANT ONE. Category is genuinely monetized, prospects are real
      // and reachable, outreach delivered cleanly — and nobody wants OUR wedge.
      const opportunityId = await insertOpportunity(db, {
        name: 'Pickup Window Rules (demo, no demand)',
        category: 'pickup-scheduling',
        state: 'VALIDATION_FAILED',
        evidenceConfidence: 'HIGH',
        buildDays: 6,
        price: 19,
        wedge:
          'For Shopify stores offering local pickup at two or three locations, enforce per-location pickup windows without a full delivery-scheduling suite.',
        targetCustomer: 'Shopify stores with 2-3 physical pickup locations',
        rejectionReason: 'NO_MEANINGFUL_RESPONSE',
      });
      await insertCompetitorWithEvidence(db, opportunityId, true);
      const prospects = await insertProspects(db, opportunityId, 120);
      const campaignId = await insertCampaign(db, opportunityId, 19, 'COMPLETE');
      await insertDelivered(db, campaignId, prospects.slice(0, 110));
      // Two replies, both explicit rejections. No commitments at all.
      await insertReply(db, campaignId, prospects[0]!, 'NOT_INTERESTED', 'We already handle this in our POS. Not a fit.', 0.05);
      await insertReply(db, campaignId, prospects[1]!, 'NOT_INTERESTED', 'No thanks.', 0.02);
      return { scenario, opportunityId, campaignId, expectedFinalState: 'VALIDATION_FAILED' };
    }

    case 'weak-replies': {
      // Friendly noise. "Sounds interesting" is not a commitment and must not
      // be counted as one.
      const opportunityId = await insertOpportunity(db, {
        name: 'Metafield Sync (demo, weak replies)',
        category: 'metafields',
        state: 'VALIDATION_FAILED',
        evidenceConfidence: 'HIGH',
        buildDays: 5,
        price: 19,
        wedge:
          'For Shopify merchants syncing supplier spec sheets, keep a fixed set of product metafields in sync from one CSV without a full PIM.',
        targetCustomer: 'Shopify merchants importing supplier spec sheets',
        rejectionReason: 'NO_MEANINGFUL_RESPONSE',
      });
      await insertCompetitorWithEvidence(db, opportunityId, true);
      const prospects = await insertProspects(db, opportunityId, 115);
      const campaignId = await insertCampaign(db, opportunityId, 19, 'COMPLETE');
      await insertDelivered(db, campaignId, prospects.slice(0, 105));
      for (const [i, text] of [
        'Sounds interesting, keep me posted.',
        'Cool idea!',
        'Interesting — what else does it do?',
        'Maybe later this year.',
      ].entries()) {
        await insertReply(db, campaignId, prospects[i]!, 'INTERESTED_WEAK', text, 0.3);
      }
      // Deliberately ZERO commitments: weak signals never become commitments.
      return { scenario, opportunityId, campaignId, expectedFinalState: 'VALIDATION_FAILED' };
    }

    case 'strong-validated': {
      // The full target progression, with commitments spread across SIX
      // distinct companies so unique-company counting is genuinely exercised.
      const opportunityId = await insertOpportunity(db, {
        name: 'Case-Pack Minimums (demo, validated)',
        category: 'minimum-order-rules',
        state: 'VALIDATING',
        evidenceConfidence: 'HIGH',
        buildDays: 5,
        price: 19,
        wedge:
          'For Shopify wholesalers who only need case-pack quantities and customer-tag minimums, enforce minimum orders without a general rules engine.',
        targetCustomer: 'Shopify wholesalers selling in fixed case quantities',
      });
      await insertCompetitorWithEvidence(db, opportunityId, true);
      const prospects = await insertProspects(db, opportunityId, 140);
      const campaignId = await insertCampaign(db, opportunityId, 19, 'SCALING');
      await insertDelivered(db, campaignId, prospects.slice(0, 120));

      const committing = prospects.slice(0, 6);
      const evidence: Array<[string, string, string]> = [
        ['EXPLICIT_PRICE_ACCEPTANCE', 'Yes, $19/month works for us. Send the install when it is ready.', 'EMAIL_REPLY'],
        ['PILOT_SIGNUP', 'Submitted the pilot form at $19/month with their store domain.', 'LANDING_FORM'],
        ['EXPLICIT_PRICE_ACCEPTANCE', 'We would pay $19 a month for exactly this.', 'EMAIL_REPLY'],
        ['INSTALL_REQUEST', 'When can I install it? We need this before our next season.', 'EMAIL_REPLY'],
        ['ONBOARDING_DETAILS', 'Our case packs are 6 and 12 units; tags are wholesale-a and wholesale-b.', 'EMAIL_REPLY'],
        ['TRIAL_REQUEST', 'Happy to trial it on our staging store first.', 'EMAIL_REPLY'],
      ];
      for (const [i, p] of committing.entries()) {
        const [type, text, source] = evidence[i]!;
        const domain = `demo-wholesaler-${i + 1}.example.com`;
        const replyId = source === 'EMAIL_REPLY'
          ? await insertReply(db, campaignId, p, type === 'EXPLICIT_PRICE_ACCEPTANCE' ? 'PRICE_ACCEPTED' : 'INTERESTED_STRONG', text, 0.9)
          : null;
        await insertCommitment(db, campaignId, p, domain, type, 19, text, source);
        if (replyId) {
          await db.query('UPDATE commitments SET message_id = $1 WHERE campaign_id = $2 AND company_key = $3', [
            replyId,
            campaignId,
            domain,
          ]);
        }
        await db.query(`UPDATE prospects SET status = 'COMMITTED' WHERE id = $1`, [p]);
      }
      // Same company commits twice — must still count as ONE company.
      await insertCommitment(
        db,
        campaignId,
        committing[0]!,
        'demo-wholesaler-1.example.com',
        'INSTALL_REQUEST',
        19,
        'Following up — can we get the install link?',
      );
      return { scenario, opportunityId, campaignId, expectedFinalState: 'READY_TO_BUILD' };
    }
  }
}

export async function seedAll(): Promise<SeededScenario[]> {
  const out: SeededScenario[] = [];
  for (const s of SCENARIOS) out.push(await seedScenario(s));
  return out;
}
