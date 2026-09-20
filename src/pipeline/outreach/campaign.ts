/**
 * Campaign preparation.
 *
 * Turns a CAMPAIGN_READY opportunity into:
 *   - one campaigns row (DRAFT -> READY) with a unique landing slug,
 *   - honest landing copy that states, in words, that the product does not
 *     exist yet and is being validated,
 *   - batch-1 message DRAFTS. Drafts only. Nothing in this file sends.
 *
 * Rate limited by MAX_NEW_CAMPAIGNS_PER_WEEK via assertBudget('CAMPAIGNS_WEEKLY').
 */
import { getConfig } from '../../lib/config';
import { getDb, many, one } from '../../lib/db';
import { BudgetExceededError } from '../../lib/errors';
import { newId, slugify } from '../../lib/hash';
import { createLogger } from '../../lib/logger';
import { assertBudget } from '../../lib/cost';
import { recordAudit } from '../../lib/audit';
import { assertCampaignTransition } from '../../lib/state-machine';
import { Wedge } from '../../lib/contracts';
import { assertCompliant, composeInitialMessage } from './compose';
import { ComplianceError } from './errors';
import {
  buildLandingCopy,
  landingUrlFor,
  offerFromRow,
  parseJsonColumn,
  type LandingCopy,
  type OfferContext,
} from './offer';
import { idempotencyKeyFor, insertDraftMessage, prospectContextFromRow, type ProspectRow } from './drafts';
import { isCountryAllowed, suppress } from './suppression';
import type { PrepareResult } from './index';

const logger = createLogger('outreach:campaign');

interface OpportunityRow {
  id: string;
  name: string;
  ecosystem: string;
  category: string;
  wedge_json: unknown;
  proposed_price_monthly: string | number | null;
  proposed_wedge: string | null;
  target_customer: string | null;
}

/**
 * Builds the offer for an opportunity. Requires a structured wedge with a
 * price — without one we have nothing honest to describe, so we skip rather
 * than improvise.
 */
export function landingCopyForOpportunity(opp: OpportunityRow): LandingCopy | null {
  const parsed = Wedge.safeParse(parseJsonColumn(opp.wedge_json));
  if (!parsed.success) {
    logger.warn('opportunity has no usable wedge_json; skipping', {
      opportunityId: opp.id,
      issue: parsed.error.issues[0]?.message,
    });
    return null;
  }
  const price = Number(opp.proposed_price_monthly ?? parsed.data.proposedPriceMonthly);
  if (!Number.isFinite(price) || price <= 0) return null;
  return buildLandingCopy({ wedge: parsed.data, ecosystem: opp.ecosystem, priceMonthly: price });
}

/** Unique, readable, stable. Collisions get a numeric suffix, then a random one. */
export async function allocateLandingSlug(base: string): Promise<string> {
  const root = slugify(base) || 'pilot';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
    const clash = await one<{ id: string }>('SELECT id FROM campaigns WHERE landing_slug = $1', [candidate]);
    if (!clash) return candidate;
  }
  return `${root}-${newId('x').split('_')[1]?.slice(0, 6) ?? '000000'}`;
}

/**
 * Drafts up to `limit` messages for a campaign at a given sequence step.
 * Prospects outside ALLOWED_OUTREACH_COUNTRIES are suppressed here and will
 * also be refused at the send path — both layers, on purpose.
 */
export async function draftInitialMessages(offer: OfferContext, limit: number): Promise<number> {
  if (limit <= 0) return 0;
  const cfg = getConfig();
  const rows = await many<ProspectRow>(
    `SELECT p.id, p.company_name, p.domain, p.contact_email, p.contact_name_if_public,
            p.public_evidence_url, p.qualification_reason, p.country, p.status
       FROM prospects p
      WHERE p.opportunity_id = $1
        AND p.status = 'QUALIFIED'
        AND p.suppressed_at IS NULL
        AND p.contact_email IS NOT NULL
        AND p.email_is_public = true
        AND NOT EXISTS (
              SELECT 1 FROM messages m
               WHERE m.campaign_id = $2 AND m.prospect_id = p.id AND m.sequence_step = 0)
        AND NOT EXISTS (
              SELECT 1 FROM suppression_list s
               WHERE (s.email IS NOT NULL AND s.email = lower(p.contact_email))
                  OR (s.domain IS NOT NULL AND s.domain = lower(p.domain)))
      ORDER BY p.qualification_score DESC NULLS LAST, p.created_at ASC
      LIMIT $3`,
    [offer.opportunityId, offer.campaignId, limit],
  );

  let drafted = 0;
  for (const row of rows) {
    const prospect = prospectContextFromRow(row);
    if (!prospect) continue;

    if (!isCountryAllowed(row.country, cfg.allowedOutreachCountries)) {
      await suppress({
        email: prospect.contactEmail,
        reason: 'COUNTRY_NOT_ALLOWED',
        notes: `country=${row.country ?? 'unknown'}`,
      });
      continue;
    }

    const message = await composeInitialMessage(prospect, offer);
    if (!message) continue;

    try {
      assertCompliant(message, cfg);
    } catch (err) {
      if (err instanceof ComplianceError) {
        logger.error('refusing to draft a non-compliant message', {
          prospectId: prospect.id,
          violations: err.violations,
        });
        continue;
      }
      throw err;
    }

    const id = await insertDraftMessage({
      campaignId: offer.campaignId,
      prospectId: prospect.id,
      step: 0,
      message,
      idempotencyKey: idempotencyKeyFor(offer.campaignId, prospect.id, 0),
    });
    if (id) drafted += 1;
  }
  return drafted;
}

async function existingCampaignFor(opportunityId: string): Promise<OfferContext | null> {
  const row = await one<{
    id: string;
    opportunity_id: string;
    landing_slug: string;
    price_monthly: string | number;
    landing_copy_json: unknown;
  }>(
    `SELECT id, opportunity_id, landing_slug, price_monthly, landing_copy_json
       FROM campaigns
      WHERE opportunity_id = $1 AND state <> 'FAILED'
      ORDER BY created_at ASC
      LIMIT 1`,
    [opportunityId],
  );
  return row ? offerFromRow(row) : null;
}

/**
 * Creates campaigns for opportunities sitting in CAMPAIGN_READY and drafts the
 * first batch. Safe to run repeatedly: an opportunity that already has a
 * campaign only gets its missing drafts topped up.
 */
export async function prepareCampaigns(limit: number): Promise<PrepareResult[]> {
  const cfg = getConfig();
  const opportunities = await many<OpportunityRow>(
    `SELECT id, name, ecosystem, category, wedge_json, proposed_price_monthly,
            proposed_wedge, target_customer
       FROM opportunities
      WHERE state = 'CAMPAIGN_READY'
      ORDER BY created_at ASC
      LIMIT $1`,
    [Math.max(0, limit)],
  );

  const results: PrepareResult[] = [];
  for (const opp of opportunities) {
    const existing = await existingCampaignFor(opp.id);
    if (existing) {
      const drafted = await draftInitialMessages(existing, cfg.initialEmailBatch);
      results.push({
        opportunityId: opp.id,
        campaignId: existing.campaignId,
        landingSlug: existing.landingSlug,
        drafted,
        skipped: null,
      });
      continue;
    }

    try {
      await assertBudget('CAMPAIGNS_WEEKLY');
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        logger.warn('weekly campaign budget reached; stopping', { spent: err.spent, limit: err.limit });
        results.push({
          opportunityId: opp.id,
          campaignId: null,
          landingSlug: null,
          drafted: 0,
          skipped: 'CAMPAIGNS_WEEKLY_BUDGET',
        });
        break;
      }
      throw err;
    }

    const copy = landingCopyForOpportunity(opp);
    if (!copy) {
      results.push({
        opportunityId: opp.id,
        campaignId: null,
        landingSlug: null,
        drafted: 0,
        skipped: 'NO_USABLE_WEDGE',
      });
      continue;
    }

    const slug = await allocateLandingSlug(`${copy.productName}-${opp.category}`);
    const campaignId = newId('cmp');
    const db = await getDb();
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO campaigns
           (id, opportunity_id, state, offer_name, price_monthly, landing_slug,
            landing_copy_json, started_at, target_count)
         VALUES ($1,$2,'DRAFT',$3,$4,$5,$6, now(), $7)`,
        [
          campaignId,
          opp.id,
          copy.productName,
          copy.priceMonthly,
          slug,
          JSON.stringify(copy),
          cfg.maxEmailsPerCampaign,
        ],
      );
      // DRAFT -> READY goes through the campaign state machine like every other
      // transition; nothing writes `state` without asserting the edge first.
      assertCampaignTransition('DRAFT', 'READY');
      await tx.query(`UPDATE campaigns SET state = 'READY', updated_at = now() WHERE id = $1`, [campaignId]);
    });

    await recordAudit({
      entityType: 'campaign',
      entityId: campaignId,
      eventType: 'STATE_TRANSITION',
      actor: 'outreach:prepare_campaigns',
      fromState: 'DRAFT',
      toState: 'READY',
      reason: 'campaign prepared',
      detail: { opportunityId: opp.id, landingSlug: slug, priceMonthly: copy.priceMonthly },
    });

    const offer: OfferContext = {
      campaignId,
      opportunityId: opp.id,
      landingSlug: slug,
      landingUrl: landingUrlFor(slug),
      priceMonthly: copy.priceMonthly,
      copy,
    };
    const drafted = await draftInitialMessages(offer, cfg.initialEmailBatch);

    logger.info('campaign prepared', { campaignId, opportunityId: opp.id, slug, drafted });
    results.push({
      opportunityId: opp.id,
      campaignId,
      landingSlug: slug,
      drafted,
      skipped: null,
    });
  }
  return results;
}
