/**
 * Wedge synthesis.
 *
 * This is one of the three sanctioned reasoner-tier call sites in the system.
 * The model proposes; CODE disposes. Everything the model returns is run
 * through `validateWedge()` — a real, unit-tested rejection function — before
 * it is allowed anywhere near the database. A confident-sounding vague wedge
 * is still a vague wedge.
 */
import { z } from 'zod';
import { getConfig } from '../../lib/config';
import { createLogger } from '../../lib/logger';
import { llmComplete } from '../../lib/llm/index';
import { BudgetExceededError } from '../../lib/errors';
import { Wedge } from '../../lib/contracts';
import type { ComplaintCluster } from './clustering';

const logger = createLogger('wedge:generate');

/** How many times we re-ask after a validator rejection. Bounded on purpose. */
export const WEDGE_MAX_RETRIES = 2;

/** A wedge priced outside this band is not a self-serve micro-SaaS wedge. */
export const MIN_SANE_PRICE_MONTHLY = 9;
export const MAX_SANE_PRICE_MONTHLY = 300;

export const MAX_V1_FEATURES = 5;
export const MIN_V1_FEATURES = 3;

/**
 * Deliberately looser than `Wedge` so that an over-scoped answer reaches OUR
 * validator with a readable reason instead of dying inside Zod.
 */
export const WedgeCandidate = z.object({
  statement: z.string(),
  productName: z.string(),
  targetCustomer: z.string(),
  coreWorkflow: z.string(),
  v1Features: z.array(z.string()),
  excludedFromV1: z.array(z.string()),
  proposedPriceMonthly: z.number(),
  estimatedBuildDays: z.number(),
  primaryCompetitor: z.string(),
  reasonSomeoneWouldSwitch: z.string(),
  oneSentenceOutcome: z.string(),
  capabilities: z.array(z.string()),
  whoItIsFor: z.string(),
});
export type WedgeCandidate = z.infer<typeof WedgeCandidate>;

export type WedgeProblemCode =
  | 'MALFORMED'
  | 'TOO_MANY_V1_FEATURES'
  | 'TOO_FEW_V1_FEATURES'
  | 'DUPLICATE_V1_FEATURES'
  | 'V1_CONTRADICTS_EXCLUSIONS'
  | 'NO_EXCLUSIONS'
  | 'BUILD_TOO_LONG'
  | 'PRICE_OUT_OF_RANGE'
  | 'GENERIC_STATEMENT'
  | 'STATEMENT_TOO_SHORT'
  | 'NO_SPECIFIC_CUSTOMER'
  | 'CUSTOMER_NOT_NARROW'
  | 'VAGUE_WORKFLOW'
  | 'NO_COMPETITOR'
  | 'NO_SWITCH_REASON'
  | 'BAD_CAPABILITIES';

export interface WedgeProblem {
  code: WedgeProblemCode;
  message: string;
}

export interface WedgeValidation {
  ok: boolean;
  problems: WedgeProblem[];
  /** Populated only when ok === true. */
  wedge: Wedge | null;
}

/**
 * Marketing filler. If a wedge statement needs any of these words, the wedge
 * is not narrow enough to describe plainly.
 */
export const BANNED_GENERIC_PHRASES: readonly string[] = [
  'ai-powered',
  'ai powered',
  'ai-driven',
  'ai driven',
  'powered by ai',
  'platform',
  'all-in-one',
  'all in one',
  'optimization suite',
  'optimisation suite',
  'suite of tools',
  'end-to-end',
  'one-stop',
  'one stop',
  'next-generation',
  'next generation',
  'revolutionary',
  'game-changing',
  'game changing',
  'cutting-edge',
  'cutting edge',
  'state-of-the-art',
  'best-in-class',
  'world-class',
  'turnkey',
  'holistic',
  'synergy',
  'ecosystem',
  'seamless',
  'supercharge',
  'unlock the power',
  'transform your business',
  'empower',
  'leverage',
  'complete solution',
  'everything you need',
  'businesses of all sizes',
  'any business',
  'all businesses',
  'digital transformation',
  'smart automation',
  'intelligent automation',
];

/**
 * Concrete customer nouns. A wedge without one of these is aimed at "users",
 * which means it is aimed at nobody.
 */
export const CUSTOMER_NOUNS: readonly string[] = [
  'merchant',
  'store',
  'shop',
  'seller',
  'wholesaler',
  'retailer',
  'reseller',
  'distributor',
  'supplier',
  'brand',
  'agency',
  'studio',
  'clinic',
  'practice',
  'restaurant',
  'cafe',
  'bakery',
  'brewery',
  'roaster',
  'butcher',
  'florist',
  'nursery',
  'gym',
  'salon',
  'spa',
  'dealer',
  'installer',
  'contractor',
  'manufacturer',
  'printer',
  'publisher',
  'school',
  'nonprofit',
  'charity',
  'landlord',
  'operator',
  'owner',
  'freelancer',
  'consultant',
  'bookkeeper',
  'accountant',
  'photographer',
  'caterer',
  'grocer',
  'pharmacy',
  'veterinarian',
  'dentist',
  'therapist',
  'coach',
  'outfitter',
  'importer',
  'exporter',
  'fulfiller',
  'warehouse',
];

/** Signals that a customer description has actually been narrowed down. */
const NARROWING_TOKENS: readonly string[] = [
  'who',
  'that',
  'which',
  'with',
  'using',
  'use',
  'selling',
  'sell',
  'sells',
  'ship',
  'ships',
  'shipping',
  'run',
  'runs',
  'running',
  'under',
  'over',
  'fewer',
  'more than',
  'less than',
  'between',
  'only',
  'b2b',
  'wholesale',
  'trade',
  'subscription',
  'per',
  'on shopify',
  'shopify',
  'woocommerce',
  'bigcommerce',
  'squarespace',
  'etsy',
  'in-store',
  'local',
  'multi-location',
];

/** A recurring job is described with verbs like these, not with adjectives. */
const CONCRETE_WORKFLOW_VERBS: readonly string[] = [
  // Service-business work: assembling a report, reconciling an account,
  // submitting a filing. Without these a professional-services wedge reads as
  // vague however concrete it actually is.
  'assemble',
  'assembles',
  'compile',
  'compiles',
  'prepare',
  'prepares',
  'submit',
  'submits',
  'file',
  'files',
  'renew',
  'renews',
  'dispatch',
  'dispatches',
  'log',
  'logs',
  'record',
  'records',
  'chase',
  'chases',
  'set',
  'sets',
  'setting',
  'create',
  'creates',
  'import',
  'imports',
  'export',
  'exports',
  'sync',
  'syncs',
  'generate',
  'generates',
  'send',
  'sends',
  'block',
  'blocks',
  'enforce',
  'enforces',
  'calculate',
  'calculates',
  'schedule',
  'schedules',
  'reconcile',
  'reconciles',
  'tag',
  'tags',
  'flag',
  'flags',
  'apply',
  'applies',
  'validate',
  'validates',
  'notify',
  'notifies',
  'print',
  'prints',
  'upload',
  'uploads',
  'match',
  'matches',
  'assign',
  'assigns',
  'update',
  'updates',
  'approve',
  'approves',
  'track',
  'tracks',
  'route',
  'routes',
  'split',
  'splits',
  'merge',
  'merges',
  'convert',
  'converts',
  'define',
  'defines',
  'configure',
  'configures',
  'restrict',
  'restricts',
  'limit',
  'limits',
  'adjust',
  'adjusts',
  'check',
  'checks',
  'verify',
  'verifies',
  'collect',
  'collects',
  'charge',
  'charges',
  'refund',
  'refunds',
  'remind',
  'reminds',
  'publish',
  'publishes',
  'draft',
  'drafts',
  'map',
  'maps',
  'group',
  'groups',
  'filter',
  'filters',
  'label',
  'labels',
  'reorder',
  'reorders',
  'replenish',
  'pick',
  'pack',
  'quote',
  'quotes',
  'invoice',
  'invoices',
  'order',
  'orders',
  'upsert',
  'edit',
  'edits',
  'add',
  'adds',
  'remove',
  'removes',
  'show',
  'shows',
  'hide',
  'hides',
];

function lower(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

function words(s: string): string[] {
  return lower(s).split(/[^a-z0-9'+-]+/).filter(Boolean);
}

/** Stem-ish containment: "wholesalers" matches the noun "wholesaler". */
export function containsCustomerNoun(text: string): boolean {
  const tokens = words(text);
  return tokens.some((t) => {
    // "agencies" -> "agency". The simple +s stem covers "wholesalers" but not
    // the -ies plural, which silently rejected every agency, pharmacy, bakery
    // and laundry ICP as though it named no concrete kind of business.
    const candidates = [t];
    if (t.length > 4 && t.endsWith('ies')) candidates.push(`${t.slice(0, -3)}y`);
    return candidates.some((c) => CUSTOMER_NOUNS.some((noun) => c === noun || c.startsWith(noun)));
  });
}

/**
 * Banned phrases match on WORD boundaries, never as bare substrings.
 *
 * A raw `includes` check rejected legitimate copy for containing a banned word
 * inside a longer one: "without a full replatform" was flagged for `platform`.
 * A wedge is not generic marketing because one of its words happens to end in
 * a banned string.
 */
export function findBannedPhrases(text: string): string[] {
  const haystack = lower(text);
  return BANNED_GENERIC_PHRASES.filter((phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(haystack);
  });
}

export function hasNarrowingQualifier(text: string): boolean {
  const haystack = lower(text);
  if (/\d/.test(haystack)) return true;
  const tokens = words(text);
  return NARROWING_TOKENS.some((tok) =>
    tok.includes(' ') ? haystack.includes(tok) : tokens.includes(tok),
  );
}

/**
 * Candidate base forms for one token, so inflections match the verb list
 * without the list having to enumerate every conjugation.
 *
 * The list is written in base + third-person form; a recurring job is very
 * often described as a gerund ("enforcing case-pack minimums every day"),
 * which the exact-match check used to reject as vague.
 */
function verbStems(token: string): string[] {
  const out = [token];
  const push = (s: string): void => {
    if (s.length >= 2) out.push(s);
  };
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (!token.endsWith(suffix) || token.length <= suffix.length + 1) continue;
    const trimmed = token.slice(0, -suffix.length);
    push(trimmed);
    // "enforcing" -> "enforce"; "quoted" -> "quote"
    push(`${trimmed}e`);
    // "tagging" -> "tag"; "shipped" -> "ship"
    const last = trimmed.at(-1);
    if (last && last === trimmed.at(-2) && !'aeiou'.includes(last)) push(trimmed.slice(0, -1));
    // "applies" -> "apply"; "verifies" -> "verify"
    if (trimmed.endsWith('i')) push(`${trimmed.slice(0, -1)}y`);
  }
  return out;
}

export function hasConcreteVerb(text: string): boolean {
  const verbs = new Set(CONCRETE_WORKFLOW_VERBS);
  return words(text).some((t) => verbStems(t).some((stem) => verbs.has(stem)));
}

export interface ValidateWedgeOptions {
  maxBuildDays?: number;
  minPrice?: number;
  maxPrice?: number;
}

/**
 * The code-side gate on wedge quality.
 *
 * Accepts `unknown` on purpose: the model's raw answer is judged here, not by
 * a schema that would silently reject it with an unusable error.
 */
export function validateWedge(input: unknown, opts: ValidateWedgeOptions = {}): WedgeValidation {
  const maxBuildDays = opts.maxBuildDays ?? getConfig().maxMvpBuildDays;
  const minPrice = opts.minPrice ?? MIN_SANE_PRICE_MONTHLY;
  const maxPrice = opts.maxPrice ?? MAX_SANE_PRICE_MONTHLY;

  const parsed = WedgeCandidate.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      wedge: null,
      problems: [
        {
          code: 'MALFORMED',
          message: `wedge is missing or malformed: ${parsed.error.issues
            .slice(0, 4)
            .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
            .join('; ')}`,
        },
      ],
    };
  }

  const c = parsed.data;
  const problems: WedgeProblem[] = [];
  const add = (code: WedgeProblemCode, message: string): void => {
    problems.push({ code, message });
  };

  // --- scope -----------------------------------------------------------------
  const features = c.v1Features.map((f) => f.trim()).filter((f) => f !== '');
  if (features.length > MAX_V1_FEATURES) {
    add(
      'TOO_MANY_V1_FEATURES',
      `V1 lists ${features.length} features; the hard cap is ${MAX_V1_FEATURES}. Cut it to the ones the core workflow cannot run without.`,
    );
  }
  if (features.length < MIN_V1_FEATURES) {
    add('TOO_FEW_V1_FEATURES', `V1 lists ${features.length} features; at least ${MIN_V1_FEATURES} are required.`);
  }
  const featureKeys = features.map((f) => lower(f));
  if (new Set(featureKeys).size !== featureKeys.length) {
    add('DUPLICATE_V1_FEATURES', 'V1 features contain duplicates.');
  }

  const exclusions = c.excludedFromV1.map((f) => f.trim()).filter((f) => f !== '');
  if (exclusions.length === 0) {
    add('NO_EXCLUSIONS', 'A wedge with nothing explicitly excluded from V1 has no edges.');
  }
  const exclusionKeys = new Set(exclusions.map((f) => lower(f)));
  const overlap = featureKeys.filter((f) => exclusionKeys.has(f));
  if (overlap.length > 0) {
    add(
      'V1_CONTRADICTS_EXCLUSIONS',
      `these appear in both V1 and the NOT-in-V1 list: ${overlap.slice(0, 3).join(', ')}`,
    );
  }

  // --- build budget ----------------------------------------------------------
  if (!Number.isFinite(c.estimatedBuildDays) || c.estimatedBuildDays <= 0) {
    add('BUILD_TOO_LONG', 'estimatedBuildDays must be a positive number of days.');
  } else if (c.estimatedBuildDays > maxBuildDays) {
    add(
      'BUILD_TOO_LONG',
      `estimated build is ${c.estimatedBuildDays} days; the ceiling is ${maxBuildDays}. Remove scope until it fits.`,
    );
  }

  // --- price -----------------------------------------------------------------
  if (!Number.isFinite(c.proposedPriceMonthly)) {
    add('PRICE_OUT_OF_RANGE', 'proposedPriceMonthly must be a number.');
  } else if (c.proposedPriceMonthly < minPrice || c.proposedPriceMonthly > maxPrice) {
    add(
      'PRICE_OUT_OF_RANGE',
      `proposed price $${c.proposedPriceMonthly}/mo is outside the sane self-serve band $${minPrice}-$${maxPrice}.`,
    );
  }

  // --- genericness -----------------------------------------------------------
  const marketingSurface = [
    c.statement,
    c.productName,
    c.oneSentenceOutcome,
    c.targetCustomer,
    c.whoItIsFor,
  ].join(' · ');
  const banned = findBannedPhrases(marketingSurface);
  if (banned.length > 0) {
    add(
      'GENERIC_STATEMENT',
      `generic marketing language is not a wedge — remove: ${[...new Set(banned)].slice(0, 6).join(', ')}`,
    );
  }

  const statement = c.statement.trim();
  if (statement.length < 40) {
    add('STATEMENT_TOO_SHORT', `the statement is ${statement.length} chars; it cannot be specific enough.`);
  }
  if (!containsCustomerNoun(statement) || !containsCustomerNoun(c.targetCustomer)) {
    add(
      'NO_SPECIFIC_CUSTOMER',
      'neither the statement nor the target customer names a concrete kind of business (merchant, wholesaler, clinic, ...).',
    );
  }
  if (words(c.targetCustomer).length < 4 || !hasNarrowingQualifier(c.targetCustomer)) {
    add(
      'CUSTOMER_NOT_NARROW',
      'the target customer is not narrowed — say who they are AND what makes them the specific subset (what they sell, how they operate, what they already use).',
    );
  }
  if (!hasConcreteVerb(c.coreWorkflow) || c.coreWorkflow.trim().length < 25) {
    add('VAGUE_WORKFLOW', 'the core workflow must describe one recurring job in concrete verbs.');
  }

  // --- honesty about the alternative ----------------------------------------
  const competitor = c.primaryCompetitor.trim();
  if (competitor.length < 2 || ['none', 'n/a', 'na', 'unknown'].includes(lower(competitor))) {
    add('NO_COMPETITOR', 'name the real alternative merchants use today, even if it is a spreadsheet.');
  }
  if (c.reasonSomeoneWouldSwitch.trim().length < 20) {
    add('NO_SWITCH_REASON', 'state a concrete reason someone would switch.');
  }

  const capabilities = c.capabilities.map((s) => s.trim()).filter((s) => s !== '');
  if (capabilities.length < 3 || capabilities.length > 5) {
    add('BAD_CAPABILITIES', `capabilities must list 3-5 plain-language outcomes, got ${capabilities.length}.`);
  }

  if (problems.length > 0) return { ok: false, problems, wedge: null };

  const strict = Wedge.safeParse({
    ...c,
    v1Features: features,
    excludedFromV1: exclusions,
    capabilities,
  });
  if (!strict.success) {
    return {
      ok: false,
      wedge: null,
      problems: [
        {
          code: 'MALFORMED',
          message: `wedge failed the contract schema: ${strict.error.issues
            .slice(0, 4)
            .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
            .join('; ')}`,
        },
      ],
    };
  }
  return { ok: true, problems: [], wedge: strict.data };
}

// --- generation -------------------------------------------------------------

export interface WedgeOpportunityInput {
  id: string;
  name: string;
  ecosystem: string;
  category: string;
  description: string;
}

export interface WedgeCompetitorInput {
  name: string;
  currentPricing: string | null;
  hasPermanentFreeTier: boolean | null;
  reviewCount: number | null;
}

export interface WedgeGenerationInput {
  opportunity: WedgeOpportunityInput;
  clusters: readonly ComplaintCluster[];
  competitors: readonly WedgeCompetitorInput[];
}

export interface WedgeGenerationResult {
  wedge: Wedge | null;
  attempts: number;
  /** Problems from the LAST rejected attempt. Empty when a wedge was produced. */
  problems: WedgeProblem[];
}

function buildSystemPrompt(maxBuildDays: number): string {
  return [
    'You turn a verified SaaS category into ONE extremely narrow, quickly-buildable wedge.',
    '',
    'A wedge fits this sentence exactly:',
    '  "For [very specific customer], do [one recurring job], with [one reason this is simpler or better]."',
    '',
    'GOOD: "Minimum-order rules for Shopify wholesalers who only need case-pack quantities and customer-tag minimums."',
    'BAD:  "AI-powered commerce optimization platform."',
    '',
    'Non-negotiable constraints, checked by code after you answer:',
    `- 3 to ${MAX_V1_FEATURES} V1 features. Not 6. Not "and also".`,
    `- estimatedBuildDays <= ${maxBuildDays} for one experienced developer.`,
    `- proposedPriceMonthly between ${MIN_SANE_PRICE_MONTHLY} and ${MAX_SANE_PRICE_MONTHLY} USD.`,
    '- excludedFromV1 must name the tempting things you are deliberately NOT building.',
    '- targetCustomer must name a concrete kind of business AND the property that narrows it.',
    '- coreWorkflow must describe one recurring job in concrete verbs.',
    '- primaryCompetitor must name what they use today, even if that is a spreadsheet.',
    '',
    'Banned words and phrases — their presence is an automatic rejection:',
    `  ${BANNED_GENERIC_PHRASES.slice(0, 24).join(', ')}, and similar marketing filler.`,
    '',
    'Ground every claim in the complaint evidence supplied. Do not invent complaints.',
  ].join('\n');
}

function buildUserPrompt(input: WedgeGenerationInput, previous: WedgeProblem[], rejected: string | null): string {
  const { opportunity, clusters, competitors } = input;
  const clusterLines = clusters.length
    ? clusters
        .map(
          (c) =>
            `- [${c.severity}] ${c.name} (${c.count} reviews)${
              c.evidenceQuotes.length ? `\n    evidence: ${c.evidenceQuotes.map((q) => `"${q}"`).join(' | ')}` : ''
            }`,
        )
        .join('\n')
    : '- (no clustered complaints; rely on the category description)';

  const competitorLines = competitors.length
    ? competitors
        .map(
          (c) =>
            `- ${c.name} — pricing: ${c.currentPricing ?? 'unknown'}; permanent free tier: ${
              c.hasPermanentFreeTier === null ? 'unknown' : c.hasPermanentFreeTier ? 'yes' : 'no'
            }; reviews: ${c.reviewCount ?? 'unknown'}`,
        )
        .join('\n')
    : '- (none recorded)';

  const parts = [
    `Ecosystem: ${opportunity.ecosystem}`,
    `Category: ${opportunity.category}`,
    `Category name: ${opportunity.name}`,
    opportunity.description ? `Category description: ${opportunity.description}` : '',
    '',
    'Ranked complaint clusters (deterministically tagged from real reviews):',
    clusterLines,
    '',
    'Incumbents already taking money in this category:',
    competitorLines,
  ].filter((p) => p !== '');

  if (previous.length > 0) {
    parts.push(
      '',
      'YOUR PREVIOUS ANSWER WAS REJECTED BY THE VALIDATOR.',
      rejected === null ? '' : `Rejected statement: "${rejected}"`,
      'Fix every one of these, do not argue with them:',
      ...previous.map((p) => `- [${p.code}] ${p.message}`),
    );
  }
  return parts.filter((p) => p !== '').join('\n');
}

/**
 * Asks the reasoner for a wedge and validates it in code, retrying with the
 * validator's complaints attached. Bounded at WEDGE_MAX_RETRIES retries — if it
 * cannot produce a narrow wedge in three tries, the category does not have one.
 */
export async function generateWedge(input: WedgeGenerationInput): Promise<WedgeGenerationResult> {
  const cfg = getConfig();
  const system = buildSystemPrompt(cfg.maxMvpBuildDays);
  let problems: WedgeProblem[] = [];
  let rejectedStatement: string | null = null;
  let attempts = 0;

  for (let attempt = 0; attempt <= WEDGE_MAX_RETRIES; attempt++) {
    attempts = attempt + 1;
    const user = buildUserPrompt(input, problems, rejectedStatement);

    let raw: unknown;
    try {
      const res = await llmComplete({
        tier: 'reasoner',
        task: 'wedge.synthesize',
        schemaName: 'WedgeCandidate',
        system,
        user,
        schema: WedgeCandidate,
        maxTokens: 1600,
      });
      raw = res.data;
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      logger.warn('wedge synthesis call failed', {
        opportunityId: input.opportunity.id,
        attempt: attempts,
        err: String(err),
      });
      problems = [{ code: 'MALFORMED', message: `the model call failed: ${String(err)}` }];
      rejectedStatement = null;
      continue;
    }

    const verdict = validateWedge(raw, { maxBuildDays: cfg.maxMvpBuildDays });
    if (verdict.ok && verdict.wedge) {
      logger.info('wedge accepted by code validator', {
        opportunityId: input.opportunity.id,
        attempts,
        statement: verdict.wedge.statement,
      });
      return { wedge: verdict.wedge, attempts, problems: [] };
    }

    problems = verdict.problems;
    rejectedStatement =
      raw !== null && typeof raw === 'object' && 'statement' in raw
        ? String((raw as { statement: unknown }).statement).slice(0, 200)
        : null;
    logger.warn('wedge rejected by code validator', {
      opportunityId: input.opportunity.id,
      attempt: attempts,
      problems: problems.map((p) => p.code),
    });
  }

  return { wedge: null, attempts, problems };
}
