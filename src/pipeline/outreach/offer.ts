/**
 * The offer: the single stored description of what is being validated.
 *
 * Everything the outreach layer is allowed to say — in an email, on the landing
 * page, or in an auto-reply — has to be derivable from this object. It is built
 * once from the wedge, written to campaigns.landing_copy_json, and read back
 * afterwards. Nothing regenerates claims from a prompt at send time.
 *
 * The honesty rule is structural: the copy always states that the product is
 * being validated and does not exist yet.
 */
import { z } from 'zod';
import { getConfig } from '../../lib/config';
import { one } from '../../lib/db';
import { Wedge } from '../../lib/contracts';
import { getAssignedPrice } from '../../autonomy/pricing';

/** Exactly what the web layer renders at /v/[slug]. Validated on read and write. */
export const LandingCopy = z.object({
  productName: z.string().min(2).max(80),
  /** One sentence. What the customer gets, not what the software is. */
  outcome: z.string().min(5).max(300),
  capabilities: z.array(z.string().min(2).max(200)).min(3).max(5),
  priceMonthly: z.number().positive().max(500),
  whoItIsFor: z.string().min(3).max(400),
  workflow: z.string().min(3).max(600),
  incumbentComplexity: z.string().min(3).max(400),
  /** Early-access / pilot framing. */
  earlyAccess: z.string().min(5).max(400),
  /**
   * The explicit "this does not exist yet" statement. A literal type, so a
   * campaign whose copy omits it fails validation instead of shipping.
   */
  buildStatus: z.literal('BEING_VALIDATED_NOT_BUILT'),
  validationDisclosure: z.string().min(20).max(500),
  cta: z.string().min(5).max(200),
  ecosystem: z.string().min(2).max(40),
});
export type LandingCopy = z.infer<typeof LandingCopy>;

export interface OfferContext {
  campaignId: string;
  opportunityId: string;
  landingSlug: string;
  landingUrl: string;
  priceMonthly: number;
  copy: LandingCopy;
}

export function formatPrice(price: number): string {
  return Number.isInteger(price) ? `$${price}` : `$${price.toFixed(2)}`;
}

/** "shopify" -> "Shopify". Used for "a small Shopify app". */
export function displayEcosystem(ecosystem: string): string {
  const trimmed = ecosystem.trim();
  if (trimmed === '') return 'Shopify';
  if (trimmed.toLowerCase() === 'shopify') return 'Shopify';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function clamp(text: string, max: number, fallback: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned === '') return fallback;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}

/**
 * The three copy fields that quote a number. Factored out so that re-pricing
 * an offer for a price-experiment arm regenerates all of them together — a
 * body that says $29 next to a disclosure that says $19 is a lie, not a typo.
 */
function priceBearingCopy(ecosystem: string, priceMonthly: number): {
  earlyAccess: string;
  validationDisclosure: string;
  cta: string;
} {
  const price = formatPrice(priceMonthly);
  return {
    earlyAccess: `Early access: the first pilot installs go to stores that join now, at ${price}/month.`,
    validationDisclosure:
      `This ${ecosystem} app does not exist yet. It is being validated before it is built: ` +
      `if enough stores want it at ${price}/month I build it and pilot stores get the first install. ` +
      `Nothing is charged today.`,
    cta: `Join the pilot at ${price}/month`,
  };
}

/**
 * Builds the landing copy from the wedge. Deterministic — no LLM. Every field
 * is either copied from verified wedge content or is a fixed honest statement.
 */
export function buildLandingCopy(params: {
  wedge: Wedge;
  ecosystem: string;
  priceMonthly: number;
}): LandingCopy {
  const { wedge, priceMonthly } = params;
  const ecosystem = displayEcosystem(params.ecosystem);
  const capabilities = wedge.capabilities.length >= 3 ? wedge.capabilities : wedge.v1Features;

  return LandingCopy.parse({
    productName: clamp(wedge.productName, 80, 'Pilot app'),
    outcome: clamp(wedge.oneSentenceOutcome, 300, wedge.statement),
    capabilities: capabilities.slice(0, 5).map((c) => clamp(c, 200, 'capability')),
    priceMonthly,
    whoItIsFor: clamp(wedge.whoItIsFor, 400, wedge.targetCustomer),
    workflow: clamp(wedge.coreWorkflow, 600, wedge.statement),
    incumbentComplexity: clamp(
      wedge.reasonSomeoneWouldSwitch,
      400,
      `the setup ${wedge.primaryCompetitor || 'existing tools'} requires`,
    ),
    buildStatus: 'BEING_VALIDATED_NOT_BUILT',
    ecosystem,
    ...priceBearingCopy(ecosystem, priceMonthly),
  });
}

/**
 * The same offer, re-quoted at one prospect's assigned experiment price.
 *
 * Returns the offer unchanged when the price is the campaign's own, so the
 * common no-experiment path allocates nothing and cannot drift.
 */
export function offerAtPrice(offer: OfferContext, priceMonthly: number | null): OfferContext {
  if (priceMonthly === null || !Number.isFinite(priceMonthly) || priceMonthly <= 0) return offer;
  if (priceMonthly === offer.priceMonthly) return offer;
  const copy = LandingCopy.safeParse({
    ...offer.copy,
    priceMonthly,
    ...priceBearingCopy(offer.copy.ecosystem, priceMonthly),
  });
  if (!copy.success) return offer;
  return { ...offer, priceMonthly, copy: copy.data };
}

export function parseJsonColumn(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value ?? null;
}

/** Reads the offer back from the campaign row. Returns null if the copy is unusable. */
export async function loadOffer(campaignId: string): Promise<OfferContext | null> {
  const row = await one<{
    id: string;
    opportunity_id: string;
    landing_slug: string;
    price_monthly: string | number;
    landing_copy_json: unknown;
  }>(
    `SELECT id, opportunity_id, landing_slug, price_monthly, landing_copy_json
       FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  if (!row) return null;
  return offerFromRow(row);
}

export function offerFromRow(row: {
  id: string;
  opportunity_id: string;
  landing_slug: string;
  price_monthly: string | number;
  landing_copy_json: unknown;
}): OfferContext | null {
  const parsed = LandingCopy.safeParse(parseJsonColumn(row.landing_copy_json));
  if (!parsed.success) return null;
  return {
    campaignId: row.id,
    opportunityId: row.opportunity_id,
    landingSlug: row.landing_slug,
    landingUrl: landingUrlFor(row.landing_slug),
    priceMonthly: Number(row.price_monthly),
    copy: parsed.data,
  };
}

/**
 * The offer as ONE prospect must see it: the campaign offer re-quoted at the
 * price permanently assigned to them. Every path that talks to a prospect —
 * initial message, follow-ups, auto-replies — goes through this, so a thread
 * can never change its price halfway.
 */
export async function loadOfferForProspect(
  campaignId: string,
  prospectId: string | null,
): Promise<OfferContext | null> {
  const offer = await loadOffer(campaignId);
  if (!offer || !prospectId) return offer;
  const assigned = await getAssignedPrice({ campaignId, prospectId });
  return offerAtPrice(offer, assigned);
}

export function landingUrlFor(slug: string): string {
  return `${getConfig().publicBaseUrl}/v/${slug}`;
}

/**
 * Is this the sort of thing the pilot already promises?
 *
 * Deterministic token overlap against the stored capabilities — no model, and
 * no benefit of the doubt: an unclear match is NOT planned, because the cost
 * of wrongly saying "yes, that's planned" is a promise we cannot keep.
 */
const FEATURE_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'by', 'at', 'is', 'it',
  'this', 'that', 'can', 'do', 'does', 'will', 'would', 'support', 'supports', 'handle', 'handles',
  'app', 'feature', 'able', 'any', 'our', 'your', 'we', 'you', 'us', 'per',
]);

export function featureTokens(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 2 && !FEATURE_STOPWORDS.has(t));
}

export function isFeaturePlanned(feature: string, offer: OfferContext): boolean {
  const asked = featureTokens(feature);
  if (asked.length === 0) return false;
  const candidates = [...offer.copy.capabilities, offer.copy.outcome, offer.copy.workflow];
  for (const candidate of candidates) {
    const have = new Set(featureTokens(candidate));
    if (have.size === 0) continue;
    const overlap = asked.filter((token) => have.has(token)).length;
    // Most of what they asked for has to already be in the stored copy.
    if (overlap / asked.length >= 0.6) return true;
  }
  return false;
}
