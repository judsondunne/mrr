/**
 * Complaint clustering — DETERMINISTIC FIRST.
 *
 * Reviews are tagged against a curated complaint taxonomy using keyword/stem
 * matching over the *complaint-bearing segments* of each review. Only when that
 * deterministic pass cannot name or merge the material (too much untagged
 * complaint volume, or nothing coherent came out of it) do we escalate to the
 * reasoner tier — and then we send ONLY condensed, already-extracted complaint
 * snippets. Raw pages never reach a model from this file.
 *
 * "Can normal code do this?" — for 90% of review complaints, yes.
 */
import { z } from 'zod';
import { getDb } from '../../lib/db.js';
import { newId } from '../../lib/hash.js';
import { createLogger } from '../../lib/logger.js';
import { llmComplete } from '../../lib/llm/index.js';
import { BudgetExceededError } from '../../lib/errors.js';

const logger = createLogger('wedge:clustering');

// --- taxonomy ---------------------------------------------------------------

export const COMPLAINT_CODES = [
  'PRICING',
  'MISSING_FEATURE',
  'COMPLEXITY_SETUP',
  'BUGS_RELIABILITY',
  'SUPPORT',
  'PERFORMANCE',
  'LIMITS',
  'MIGRATION_SWITCHING',
  'INTEGRATION',
  'UX_CONFUSION',
  'DATA_ACCURACY',
] as const;

export type ComplaintCode = (typeof COMPLAINT_CODES)[number];
export type ComplaintSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export interface TaxonomyEntry {
  code: ComplaintCode;
  /** Human cluster name persisted to complaint_clusters.name. */
  label: string;
  description: string;
  /** Inherent severity of this complaint class, independent of volume. */
  baseSeverity: ComplaintSeverity;
  /** Multi-word markers, matched as substrings of the normalized text. */
  phrases: readonly string[];
  /** Single-token stems, matched as token prefixes ("crash" -> "crashing"). */
  stems: readonly string[];
}

/**
 * Curated, deliberately conservative. A phrase earns its place only if it is
 * almost always a complaint in review prose — vague single words like "price"
 * or "support" appear in praise just as often, so they are not listed.
 */
export const COMPLAINT_TAXONOMY: readonly TaxonomyEntry[] = [
  {
    code: 'PRICING',
    label: 'Price is too high for the value delivered',
    description: 'Merchants object to the cost, price increases, or paid tiers gating basic needs.',
    baseSeverity: 'MEDIUM',
    phrases: [
      'too expensive',
      'so expensive',
      'very expensive',
      'way too much',
      'not worth the price',
      'not worth the money',
      'not worth what',
      'price increase',
      'raised the price',
      'raised their prices',
      'price hike',
      'price went up',
      'overpriced',
      'costs too much',
      'cost too much',
      'expensive for what',
      'hidden fee',
      'extra charge',
      'charged me twice',
      'forced to upgrade',
      'have to upgrade just',
      'behind a paywall',
      'pricing is confusing',
      'pricing is unclear',
      'cheaper alternative',
      'a month for',
    ],
    stems: ['overpriced', 'pricey'],
  },
  {
    code: 'MISSING_FEATURE',
    label: 'Required capability simply is not there',
    description: 'Merchants name a specific job the incumbent cannot do at all.',
    baseSeverity: 'HIGH',
    phrases: [
      'wish it had',
      'wish there was',
      'wish it could',
      'would love to see',
      'would be great if',
      'would be nice if',
      'missing feature',
      'does not support',
      "doesn't support",
      'no support for',
      'no option to',
      'no way to',
      'there is no way',
      'not able to',
      'unable to set',
      'needs the ability',
      'needs an option',
      'only works with',
      'only allows one',
      'cannot set different',
      'no bulk',
    ],
    stems: [],
  },
  {
    code: 'COMPLEXITY_SETUP',
    label: 'Setup and configuration are too hard',
    description: 'Onboarding requires developer help, code edits, or a long learning curve.',
    baseSeverity: 'HIGH',
    phrases: [
      'hard to set up',
      'hard to setup',
      'difficult to set up',
      'difficult to setup',
      'setup was a nightmare',
      'took hours to configure',
      'took me hours',
      'steep learning curve',
      'learning curve',
      'too complicated',
      'overly complex',
      'not intuitive',
      'confusing to set up',
      'had to hire a developer',
      'needed a developer',
      'requires coding',
      'requires code',
      'edit the theme',
      'liquid code',
      'documentation is poor',
      'documentation is lacking',
      'no documentation',
    ],
    stems: ['complicated', 'cumbersome'],
  },
  {
    code: 'BUGS_RELIABILITY',
    label: 'Breaks, errors, and lost work',
    description: 'The product fails outright: crashes, broken storefronts, lost or duplicated data.',
    baseSeverity: 'HIGH',
    phrases: [
      'stopped working',
      'stops working',
      'broke my',
      'broke the',
      'does not work',
      "doesn't work",
      'did not work',
      'not working',
      'kept crashing',
      'random error',
      'error message',
      'lost data',
      'lost orders',
      'duplicate order',
      'went down for',
      'constant downtime',
    ],
    stems: ['bug', 'buggy', 'crash', 'glitch', 'broken', 'unreliable', 'downtime'],
  },
  {
    code: 'SUPPORT',
    label: 'Support is slow, absent, or unhelpful',
    description: 'Merchants cannot get a human answer when the product fails them.',
    baseSeverity: 'MEDIUM',
    phrases: [
      'no response from support',
      'no reply from support',
      'support never',
      'support did not',
      "support didn't",
      'support was unhelpful',
      'support is useless',
      'support is slow',
      'waited days for',
      'waited weeks for',
      'ticket has been open',
      'unresponsive support',
      'customer service was terrible',
      'customer service is terrible',
      'no one got back to me',
      'never heard back',
    ],
    stems: ['unresponsive'],
  },
  {
    code: 'PERFORMANCE',
    label: 'Slows the storefront down',
    description: 'Measurable speed cost: page load, script weight, laggy admin.',
    baseSeverity: 'MEDIUM',
    phrases: [
      'slows down my site',
      'slowed down my site',
      'slows my store',
      'slowed my store',
      'slows down the site',
      'page speed',
      'load time',
      'takes forever to load',
      'really slow',
      'very slow',
      'so slow',
      'painfully slow',
      'speed score',
    ],
    stems: ['sluggish', 'laggy'],
  },
  {
    code: 'LIMITS',
    label: 'Hard caps and quotas bite',
    description: 'Plan limits on rows, orders, rules, or API calls block normal operation.',
    baseSeverity: 'MEDIUM',
    phrases: [
      'hit the limit',
      'hit a limit',
      'usage limit',
      'plan limit',
      'maxed out',
      'only allows up to',
      'limited to',
      'exceeded the',
      'over the limit',
      'run out of',
      'rate limit',
    ],
    stems: ['throttled', 'quota'],
  },
  {
    code: 'MIGRATION_SWITCHING',
    label: 'Getting in or out is painful',
    description: 'Import/export friction, lock-in, or a painful switch from a prior tool.',
    baseSeverity: 'MEDIUM',
    phrases: [
      'switched from',
      'switching from',
      'moved away from',
      'migrating from',
      'had to migrate',
      'import my data',
      'export my data',
      'no export',
      'cannot export',
      'hard to migrate',
      'locked in',
      'lock-in',
      'cancel my subscription',
      'tried to cancel',
    ],
    stems: ['migration'],
  },
  {
    code: 'INTEGRATION',
    label: 'Does not play well with the rest of the stack',
    description: 'Conflicts with themes or other apps, missing or broken sync.',
    baseSeverity: 'MEDIUM',
    phrases: [
      'does not integrate',
      "doesn't integrate",
      'no integration with',
      'conflicts with',
      'conflicted with',
      'not compatible',
      'breaks my theme',
      'broke my theme',
      'out of sync',
      "doesn't sync",
      'does not sync',
      'sync issue',
      'no api',
    ],
    stems: ['incompatible'],
  },
  {
    code: 'UX_CONFUSION',
    label: 'Day-to-day interface is clunky',
    description: 'The recurring workflow takes too many steps or hides what matters.',
    baseSeverity: 'LOW',
    phrases: [
      'clunky interface',
      'interface is clunky',
      'dashboard is confusing',
      'ui is confusing',
      'interface is confusing',
      'hard to find',
      'too many clicks',
      'not user friendly',
      'not user-friendly',
    ],
    stems: ['clunky', 'unintuitive'],
  },
  {
    code: 'DATA_ACCURACY',
    label: 'Numbers come out wrong',
    description: 'Totals, tax, rounding, or reporting disagree with reality.',
    baseSeverity: 'HIGH',
    phrases: [
      'wrong number',
      'incorrect total',
      'wrong total',
      'numbers are off',
      'does not match',
      "doesn't match",
      'wrong tax',
      'rounding error',
      'miscalculated',
      'calculation is wrong',
      'inaccurate report',
    ],
    stems: ['inaccurate', 'mismatch'],
  },
];

const TAXONOMY_BY_CODE = new Map<ComplaintCode, TaxonomyEntry>(
  COMPLAINT_TAXONOMY.map((entry) => [entry.code, entry]),
);

export function taxonomyFor(code: ComplaintCode): TaxonomyEntry | null {
  return TAXONOMY_BY_CODE.get(code) ?? null;
}

// --- text handling ----------------------------------------------------------

/** Lower-cases, straightens quotes, and collapses punctuation/whitespace. */
export function normalizeComplaintText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NEGATIVE_MARKERS: readonly string[] = [
  'but ',
  'however',
  'although',
  'though ',
  'wish',
  'unfortunately',
  'issue',
  'problem',
  'downside',
  'complaint',
  'annoying',
  'frustrat',
  'disappoint',
  'only thing',
  'except that',
  'sadly',
  'hate',
  'worst',
  'poor ',
  'lacking',
  'missing',
  'broke',
  'broken',
  'fail',
  'bug',
  'glitch',
  'slow',
  'expensive',
  'pricey',
  'confusing',
  'difficult',
  'hard to',
  'clunky',
  'useless',
  'terrible',
  'awful',
  'waste of',
  'not worth',
  'never works',
  "doesn't work",
  'does not work',
  'stopped working',
  'crash',
  'no way to',
  'unable to',
];

/**
 * Returns the portion of a review that is actually a complaint.
 *
 * Low-rated reviews are complaints in full. High-rated reviews often bury one
 * ("love it, but the setup took a developer") — we keep only those sentences,
 * which keeps praise from polluting the taxonomy counts.
 */
export function extractComplaintText(text: string, rating: number | null): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  if (rating !== null && rating <= 3) return trimmed;

  const sentences = trimmed.split(/(?<=[.!?])\s+|\n+/);
  const kept: string[] = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (NEGATIVE_MARKERS.some((m) => lower.includes(m))) kept.push(sentence.trim());
  }
  return kept.join(' ').trim();
}

/** Deterministic taxonomy tagging. Returns codes in taxonomy order, deduped. */
export function tagComplaintText(text: string): ComplaintCode[] {
  const normalized = normalizeComplaintText(text);
  if (normalized === '') return [];
  const tokens = normalized.split(/[^a-z0-9']+/).filter(Boolean);
  const out: ComplaintCode[] = [];

  for (const entry of COMPLAINT_TAXONOMY) {
    const phraseHit = entry.phrases.some((p) => normalized.includes(normalizeComplaintText(p)));
    const stemHit =
      !phraseHit && entry.stems.some((stem) => tokens.some((t) => t.startsWith(stem)));
    if (phraseHit || stemHit) out.push(entry.code);
  }
  return out;
}

// --- clusters ---------------------------------------------------------------

export interface ReviewRow {
  id: string;
  text: string;
  rating: number | null;
  source_url: string;
  merchant_name: string | null;
  competitor_name: string;
}

export interface TaggedReview {
  reviewId: string;
  codes: ComplaintCode[];
  /** Condensed complaint text — the ONLY review-derived text a model ever sees. */
  snippet: string;
  competitorName: string;
  rating: number | null;
}

export interface ComplaintCluster {
  code: ComplaintCode | 'OTHER';
  name: string;
  description: string;
  count: number;
  severity: ComplaintSeverity;
  evidenceReviewIds: string[];
  /** Short condensed quotes used downstream by wedge synthesis. */
  evidenceQuotes: string[];
  source: 'DETERMINISTIC' | 'LLM';
  relevance: 'PRIMARY_WEDGE_TARGET' | 'SUPPORTING';
}

export const MAX_SNIPPET_CHARS = 240;
export const MAX_LLM_SNIPPETS = 40;

function condense(text: string, max = MAX_SNIPPET_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

export async function loadReviewsForOpportunity(opportunityId: string): Promise<ReviewRow[]> {
  const db = await getDb();
  const res = await db.query<{
    id: string;
    text: string;
    rating: number | string | null;
    source_url: string;
    merchant_name: string | null;
    competitor_name: string;
  }>(
    `SELECT r.id, r.text, r.rating, r.source_url, r.merchant_name, c.name AS competitor_name
       FROM reviews r
       JOIN competitors c ON c.id = r.competitor_id
      WHERE c.opportunity_id = $1
      ORDER BY r.created_at ASC, r.id ASC`,
    [opportunityId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    text: r.text ?? '',
    rating: r.rating === null || r.rating === undefined ? null : Number(r.rating),
    source_url: r.source_url,
    merchant_name: r.merchant_name,
    competitor_name: r.competitor_name,
  }));
}

export function tagReviews(reviews: readonly ReviewRow[]): TaggedReview[] {
  const out: TaggedReview[] = [];
  for (const review of reviews) {
    const complaintText = extractComplaintText(review.text, review.rating);
    if (complaintText === '') continue;
    out.push({
      reviewId: review.id,
      codes: tagComplaintText(complaintText),
      snippet: condense(complaintText),
      competitorName: review.competitor_name,
      rating: review.rating,
    });
  }
  return out;
}

/** Volume + inherent severity, blended deterministically. */
export function severityFor(
  count: number,
  totalComplaints: number,
  base: ComplaintSeverity,
): ComplaintSeverity {
  const share = totalComplaints > 0 ? count / totalComplaints : 0;
  let level: ComplaintSeverity = 'LOW';
  if (count >= 8 || (count >= 4 && share >= 0.25)) level = 'HIGH';
  else if (count >= 2) level = 'MEDIUM';

  if (base === 'HIGH' && level === 'MEDIUM') return 'HIGH';
  if (base === 'HIGH' && level === 'LOW' && count >= 2) return 'MEDIUM';
  if (base === 'LOW' && level === 'HIGH') return 'MEDIUM';
  return level;
}

const SEVERITY_RANK: Record<ComplaintSeverity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export interface DeterministicClusterOutcome {
  clusters: ComplaintCluster[];
  tagged: TaggedReview[];
  untagged: TaggedReview[];
}

export function buildDeterministicClusters(
  tagged: readonly TaggedReview[],
): DeterministicClusterOutcome {
  const byCode = new Map<ComplaintCode, TaggedReview[]>();
  const untagged: TaggedReview[] = [];

  for (const review of tagged) {
    if (review.codes.length === 0) {
      untagged.push(review);
      continue;
    }
    for (const code of review.codes) {
      const bucket = byCode.get(code);
      if (bucket) bucket.push(review);
      else byCode.set(code, [review]);
    }
  }

  const total = tagged.length;
  const clusters: ComplaintCluster[] = [];
  for (const entry of COMPLAINT_TAXONOMY) {
    const bucket = byCode.get(entry.code);
    if (!bucket || bucket.length === 0) continue;
    clusters.push({
      code: entry.code,
      name: entry.label,
      description: entry.description,
      count: bucket.length,
      severity: severityFor(bucket.length, total, entry.baseSeverity),
      evidenceReviewIds: bucket.map((r) => r.reviewId),
      evidenceQuotes: bucket.slice(0, 3).map((r) => condense(r.snippet, 180)),
      source: 'DETERMINISTIC',
      relevance: 'SUPPORTING',
    });
  }

  return {
    clusters,
    tagged: tagged.filter((r) => r.codes.length > 0),
    untagged,
  };
}

/**
 * The escalation rule, written down instead of left to vibes.
 *
 * We pay for a reasoner call only when the deterministic pass genuinely cannot
 * describe the material: a meaningful body of complaints went untagged, or
 * nothing coherent came out at all.
 */
export function needsLlmNaming(stats: {
  totalComplaintReviews: number;
  untaggedComplaintReviews: number;
  deterministicClusters: number;
}): boolean {
  const { totalComplaintReviews, untaggedComplaintReviews, deterministicClusters } = stats;
  if (totalComplaintReviews === 0) return false;
  if (untaggedComplaintReviews >= 3 && untaggedComplaintReviews / totalComplaintReviews >= 0.3) {
    return true;
  }
  if (deterministicClusters < 2 && totalComplaintReviews >= 4) return true;
  return false;
}

const LlmClusterNaming = z.object({
  clusters: z
    .array(
      z.object({
        name: z.string().min(4).max(90),
        description: z.string().max(300).default(''),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
        /** A taxonomy code to merge into, or null for a genuinely new cluster. */
        mergeIntoCode: z.string().max(40).nullable().default(null),
        snippetIndexes: z.array(z.number().int().min(0)).min(1).max(MAX_LLM_SNIPPETS),
      }),
    )
    .max(6),
});

const CLUSTER_NAMING_SYSTEM = [
  'You group already-extracted complaint snippets from marketplace reviews.',
  'The snippets are the ONLY evidence you have; you never see full pages.',
  'Rules:',
  '- Every cluster must be a specific recurring job the incumbent does badly.',
  '- Never invent a complaint that is not in the snippets.',
  '- Reference snippets only by the integer index given.',
  '- If a group is really the same thing as one of the existing clusters, set',
  '  mergeIntoCode to that cluster code instead of inventing a new name.',
  '- At most 6 clusters. Skip one-off noise.',
].join('\n');

async function nameUntaggedWithReasoner(
  opportunityId: string,
  untagged: readonly TaggedReview[],
  existing: readonly ComplaintCluster[],
): Promise<ComplaintCluster[]> {
  const snippets = untagged.slice(0, MAX_LLM_SNIPPETS);
  if (snippets.length === 0) return [];

  const existingLines = existing.length
    ? existing.map((c) => `- ${c.code}: ${c.name} (${c.count} reviews)`).join('\n')
    : '- (none)';
  const snippetLines = snippets
    .map((s, i) => `[${i}] (${s.rating === null ? 'no rating' : `${s.rating}/5`}) ${s.snippet}`)
    .join('\n');

  const user = [
    'Existing deterministic clusters:',
    existingLines,
    '',
    'Unclassified complaint snippets:',
    snippetLines,
  ].join('\n');

  const res = await llmComplete({
    tier: 'reasoner',
    task: 'wedge.cluster_untagged',
    schemaName: 'LlmClusterNaming',
    system: CLUSTER_NAMING_SYSTEM,
    user,
    schema: LlmClusterNaming,
    maxTokens: 1200,
  });

  const known = new Set<string>(COMPLAINT_CODES);
  const out: ComplaintCluster[] = [];
  const mergeTargets = new Map<string, string[]>();

  for (const cluster of res.data.clusters) {
    const ids: string[] = [];
    const quotes: string[] = [];
    for (const idx of cluster.snippetIndexes) {
      const snippet = snippets[idx];
      if (!snippet) continue; // model hallucinated an index; drop it silently
      ids.push(snippet.reviewId);
      if (quotes.length < 3) quotes.push(condense(snippet.snippet, 180));
    }
    if (ids.length === 0) continue;

    const mergeCode = cluster.mergeIntoCode;
    if (mergeCode !== null && known.has(mergeCode)) {
      const bucket = mergeTargets.get(mergeCode);
      if (bucket) bucket.push(...ids);
      else mergeTargets.set(mergeCode, [...ids]);
      continue;
    }

    out.push({
      code: 'OTHER',
      name: cluster.name,
      description: cluster.description,
      count: ids.length,
      severity: cluster.severity,
      evidenceReviewIds: ids,
      evidenceQuotes: quotes,
      source: 'LLM',
      relevance: 'SUPPORTING',
    });
  }

  for (const [code, ids] of mergeTargets) {
    const target = existing.find((c) => c.code === code);
    if (!target) continue;
    for (const id of ids) {
      if (!target.evidenceReviewIds.includes(id)) target.evidenceReviewIds.push(id);
    }
    target.count = target.evidenceReviewIds.length;
  }

  logger.info('reasoner named residual complaint clusters', {
    opportunityId,
    snippets: snippets.length,
    newClusters: out.length,
    merged: mergeTargets.size,
  });
  return out;
}

function rankClusters(clusters: ComplaintCluster[]): ComplaintCluster[] {
  const sorted = [...clusters].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
  return sorted.map((c, i) => ({ ...c, relevance: i === 0 ? 'PRIMARY_WEDGE_TARGET' : 'SUPPORTING' }));
}

/** Replaces this opportunity's clusters wholesale, so re-running is idempotent. */
export async function persistClusters(
  opportunityId: string,
  clusters: readonly ComplaintCluster[],
): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM complaint_clusters WHERE opportunity_id = $1', [opportunityId]);
    for (const cluster of clusters) {
      await tx.query(
        `INSERT INTO complaint_clusters
           (id, opportunity_id, name, description, count, evidence_review_ids, severity, proposed_wedge_relevance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          newId('clu'),
          opportunityId,
          cluster.name,
          cluster.description,
          cluster.count,
          JSON.stringify(cluster.evidenceReviewIds),
          cluster.severity,
          cluster.relevance,
        ],
      );
    }
  });
}

export interface ClusterOptions {
  /** Default true. False is used by callers that only want the analysis. */
  persist?: boolean;
  /** Escape hatch for callers that must stay code-only. Default true. */
  allowLlm?: boolean;
}

/**
 * Tags, clusters, ranks, and (by default) persists the complaint clusters for
 * one opportunity. An LLM failure is never fatal — the untagged remainder just
 * becomes a plainly-named "other" cluster.
 */
export async function clusterComplaints(
  opportunityId: string,
  opts: ClusterOptions = {},
): Promise<ComplaintCluster[]> {
  const reviews = await loadReviewsForOpportunity(opportunityId);
  const tagged = tagReviews(reviews);
  const { clusters, untagged } = buildDeterministicClusters(tagged);

  const escalate =
    opts.allowLlm !== false &&
    needsLlmNaming({
      totalComplaintReviews: tagged.length,
      untaggedComplaintReviews: untagged.length,
      deterministicClusters: clusters.length,
    });

  if (escalate) {
    try {
      const extra = await nameUntaggedWithReasoner(opportunityId, untagged, clusters);
      clusters.push(...extra);
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      logger.warn('reasoner clustering failed; falling back to a plain residual cluster', {
        opportunityId,
        err: String(err),
      });
      if (untagged.length >= 2) {
        clusters.push({
          code: 'OTHER',
          name: 'Other recurring complaints (unclassified)',
          description: 'Complaint text that the taxonomy could not classify.',
          count: untagged.length,
          severity: untagged.length >= 5 ? 'MEDIUM' : 'LOW',
          evidenceReviewIds: untagged.map((r) => r.reviewId),
          evidenceQuotes: untagged.slice(0, 3).map((r) => condense(r.snippet, 180)),
          source: 'DETERMINISTIC',
          relevance: 'SUPPORTING',
        });
      }
    }
  }

  const ranked = rankClusters(clusters);
  if (opts.persist !== false) await persistClusters(opportunityId, ranked);

  logger.info('complaint clustering complete', {
    opportunityId,
    reviews: reviews.length,
    complaintReviews: tagged.length,
    untagged: untagged.length,
    clusters: ranked.length,
    usedLlm: escalate,
  });
  return ranked;
}
