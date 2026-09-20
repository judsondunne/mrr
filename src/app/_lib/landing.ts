/**
 * Landing-page data loading.
 *
 * HONESTY RULES ENCODED HERE:
 *  - Every word of the offer comes from `campaigns.landing_copy_json` (falling
 *    back to the stored `opportunities.wedge_json`). This module never invents
 *    marketing copy, and there is no code path that can produce a testimonial,
 *    a customer logo, a countdown or a scarcity claim.
 *  - The price shown is always `campaigns.price_monthly` — the same number the
 *    commitment rows are written with — never a number from generated copy.
 *  - The "this is being validated, not sold" disclosure and the pilot terms are
 *    fixed constants, so generated copy can neither omit nor soften them.
 */
import { getDb, toNumber } from '@/lib/db';
import { newId } from '@/lib/hash';
import { createLogger } from '@/lib/logger';
import { asRecord, cleanText, formatPrice, pickList, pickText, safeHref } from './text';

const logger = createLogger('web:landing');

/** Fixed, non-negotiable transparency statement. Rendered on every pilot page. */
export const VALIDATION_DISCLOSURE =
  'This product is being validated, not sold. It is not built yet, there is nothing to install, ' +
  'and nothing is for sale on this page. We are asking a small number of businesses whether this ' +
  'is worth building before we build it.';

/** Fixed pilot terms. Also non-negotiable. */
export const PILOT_TERMS =
  'Joining the pilot costs nothing today: no card, no payment, no account. You are telling us you ' +
  'would pay the price below for this product once it exists.';

/** Fixed statement of what happens next. */
export const BUILD_DECISION_NOTE =
  'If enough businesses commit at this price, we build it and contact the people on this list ' +
  'first for early access. If not enough do, we do not build it.';

export interface LandingCopy {
  productName: string;
  oneSentenceOutcome: string;
  capabilities: string[];
  whoItIsFor: string;
  problem: string;
  currentAlternative: string;
  notIncluded: string[];
  /** Extra operator-supplied honesty note, rendered in addition to the fixed one. */
  validationNote: string;
  pilotNote: string;
}

export interface LandingView {
  campaignId: string;
  opportunityId: string;
  campaignState: string;
  slug: string;
  priceMonthly: number;
  /** "$29" */
  priceLabel: string;
  /** "Join the pilot at $29/month" — exact CTA text. */
  ctaLabel: string;
  /** "I'd like to use this at $29/month when available." — exact checkbox text. */
  priceCheckboxLabel: string;
  copy: LandingCopy;
}

interface LandingRow {
  id: string;
  opportunity_id: string;
  state: string;
  offer_name: string;
  price_monthly: string | number;
  landing_slug: string;
  landing_copy_json: unknown;
  wedge_json: unknown;
  opportunity_name: string;
  target_customer: string | null;
  proposed_wedge: string | null;
}

export function ctaLabelFor(priceLabel: string): string {
  return `Join the pilot at ${priceLabel}/month`;
}

export function priceCheckboxLabelFor(priceLabel: string): string {
  return `I'd like to use this at ${priceLabel}/month when available.`;
}

/** Loads the campaign behind a landing slug. Returns null when the slug is unknown. */
export async function loadLandingView(slug: string): Promise<LandingView | null> {
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 200) return null;

  const db = await getDb();
  const { rows } = await db.query<LandingRow>(
    `SELECT c.id,
            c.opportunity_id,
            c.state,
            c.offer_name,
            c.price_monthly,
            c.landing_slug,
            c.landing_copy_json,
            o.wedge_json,
            o.name AS opportunity_name,
            o.target_customer,
            o.proposed_wedge
       FROM campaigns c
       JOIN opportunities o ON o.id = c.opportunity_id
      WHERE c.landing_slug = $1
      LIMIT 1`,
    [slug],
  );

  const row = rows[0];
  if (!row) return null;

  const copyJson = asRecord(row.landing_copy_json);
  const wedge = asRecord(row.wedge_json);

  const productName =
    pickText(copyJson, ['productName', 'product_name', 'name', 'title'], 120) ||
    pickText(wedge, ['productName'], 120) ||
    cleanText(row.offer_name, 120) ||
    cleanText(row.opportunity_name, 120);

  const oneSentenceOutcome =
    pickText(copyJson, ['oneSentenceOutcome', 'one_sentence_outcome', 'outcome', 'headline', 'subhead'], 300) ||
    pickText(wedge, ['oneSentenceOutcome', 'statement'], 300) ||
    cleanText(row.proposed_wedge, 300);

  const capabilities =
    pickList(copyJson, ['capabilities', 'features', 'v1Features', 'bullets'], 5, 200).length > 0
      ? pickList(copyJson, ['capabilities', 'features', 'v1Features', 'bullets'], 5, 200)
      : pickList(wedge, ['capabilities', 'v1Features'], 5, 200);

  const whoItIsFor =
    pickText(copyJson, ['whoItIsFor', 'who_it_is_for', 'audience', 'targetCustomer'], 400) ||
    pickText(wedge, ['whoItIsFor', 'targetCustomer'], 400) ||
    cleanText(row.target_customer, 400);

  const priceMonthly = toNumber(row.price_monthly, 0);
  const priceLabel = formatPrice(priceMonthly);

  return {
    campaignId: row.id,
    opportunityId: row.opportunity_id,
    campaignState: cleanText(row.state, 40),
    slug: row.landing_slug,
    priceMonthly,
    priceLabel,
    ctaLabel: ctaLabelFor(priceLabel),
    priceCheckboxLabel: priceCheckboxLabelFor(priceLabel),
    copy: {
      productName,
      oneSentenceOutcome,
      capabilities,
      whoItIsFor,
      problem: pickText(copyJson, ['problem', 'painPoint', 'pain'], 600),
      currentAlternative:
        pickText(copyJson, ['currentAlternative', 'today', 'alternative'], 600) ||
        pickText(wedge, ['reasonSomeoneWouldSwitch'], 600),
      notIncluded:
        pickList(copyJson, ['notIncluded', 'excludedFromV1', 'not_included'], 8, 200).length > 0
          ? pickList(copyJson, ['notIncluded', 'excludedFromV1', 'not_included'], 8, 200)
          : pickList(wedge, ['excludedFromV1'], 8, 200),
      validationNote: pickText(copyJson, ['validationNote', 'honestyNote', 'status'], 600),
      pilotNote: pickText(copyJson, ['pilotNote', 'earlyAccess', 'pilot'], 600),
    },
  };
}

/**
 * Records a page view. BEST EFFORT ONLY — a failure here must never stop the
 * page from rendering, so every error is swallowed after being logged.
 */
export async function recordLandingVisit(params: {
  campaignId: string;
  opportunityId: string;
  slug: string;
  referrer?: string | null;
  prospectId?: string | null;
}): Promise<void> {
  try {
    const db = await getDb();

    let prospectId: string | null = null;
    if (params.prospectId && params.prospectId.length <= 64) {
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM prospects WHERE id = $1 AND opportunity_id = $2 LIMIT 1`,
        [params.prospectId, params.opportunityId],
      );
      prospectId = rows[0]?.id ?? null;
    }

    await db.query(
      `INSERT INTO landing_visits (id, campaign_id, slug, referrer, prospect_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        newId('lv'),
        params.campaignId,
        params.slug,
        safeHref(params.referrer) ?? null,
        prospectId,
      ],
    );
  } catch (err) {
    logger.warn('landing visit not recorded', {
      slug: params.slug,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
