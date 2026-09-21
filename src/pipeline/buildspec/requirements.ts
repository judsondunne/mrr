/**
 * Requirement tracing: the rule that keeps the build spec honest.
 *
 * A V1 feature earns a place in REQUIREMENTS.md in exactly two ways, and there
 * is no third:
 *
 *   REQUESTED — real prospect text (a commitment's evidence, or an inbound
 *     reply) shares enough distinctive words with the feature. The supporting
 *     rows are cited by id and the company count is by UNIQUE COMPANY.
 *
 *   NEEDED_BY_CORE_WORKFLOW — the feature is part of the core workflow the
 *     companies committed to. Nobody typed the feature's name, but they paid
 *     for the workflow it implements, so the commitment rows of the companies
 *     that accepted the price are the support, cited by id.
 *
 * Anything else is SPECULATIVE and is removed from V1 entirely. It is listed in
 * NON_GOALS.md with the reason, so the omission is visible rather than silent.
 *
 * The matcher is deliberately lexical and deterministic — no model decides
 * whether a customer asked for something.
 */
import { PRICE_ACCEPTANCE_TYPES, type CommitmentType } from '../../lib/contracts';
import type { CustomerRequirement, EvidenceRowRef } from '../validation/evidence';

/**
 * Generic words that carry no product meaning. Kept short on purpose: an
 * over-long list starts deleting the words that actually distinguish features.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'with', 'from', 'into', 'onto', 'per', 'via',
  'that', 'this', 'these', 'those', 'they', 'them', 'their', 'there', 'then', 'than', 'when',
  'what', 'which', 'while', 'would', 'could', 'should', 'have', 'has', 'had', 'been', 'were',
  'was', 'will', 'your', 'ours', 'about', 'after', 'before', 'other', 'some', 'such', 'only',
  'also', 'just', 'more', 'most', 'over', 'under', 'very', 'need', 'needs', 'want', 'wants',
  'like', 'make', 'made', 'does', 'doing', 'done', 'each', 'both', 'know', 'said', 'says',
  'thing', 'things', 'anything', 'something', 'clear', 'good', 'great', 'nice',
]);

const MIN_TOKEN_LENGTH = 4;

/** Crude but predictable singularisation. Enough to match groups/group. */
function singularize(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('sses')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** The distinctive content words of a phrase, normalised for comparison. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(raw)) continue;
    const token = singularize(raw);
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

export function sharedTokens(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const token of a) if (b.has(token)) out.push(token);
  return out.sort();
}

/**
 * Two distinctive words in common. One is noise ("checkout" appears in every
 * reply); three would drop features nobody phrased the way we did.
 */
export const MIN_SHARED_TOKENS = 2;

export type RequirementBasis = 'REQUESTED' | 'NEEDED_BY_CORE_WORKFLOW';

export interface SpecRequirement {
  id: string;
  text: string;
  basis: RequirementBasis;
  /** How many UNIQUE COMPANIES requested or need this. Never a row count. */
  companies: number;
  /** Real row ids, as `commitments.<id>` / `messages.<id>`. */
  supportingRowIds: string[];
  /** The words that linked the feature to the evidence. Shown for auditability. */
  matchedOn: string[];
  sourceNote: string;
}

export interface DroppedFeature {
  text: string;
  reason: string;
}

export interface TracedRequirements {
  requirements: SpecRequirement[];
  dropped: DroppedFeature[];
}

function rowRef(row: EvidenceRowRef): string {
  return `${row.origin}.${row.rowId}`;
}

function uniqueCompanies(rows: EvidenceRowRef[]): number {
  return new Set(rows.map((r) => r.companyKey)).size;
}

function priceAcceptanceRows(rows: EvidenceRowRef[]): EvidenceRowRef[] {
  return rows.filter(
    (row) => row.origin === 'commitments' && PRICE_ACCEPTANCE_TYPES.has(row.kind as CommitmentType),
  );
}

/**
 * Classifies every V1 feature and appends the capabilities prospects asked for
 * in their own words.
 *
 * Ordering is stable: wedge features in wedge order first (so REQ-1 is the
 * first thing the wedge says V1 does), then customer-derived requirements.
 */
export function traceRequirements(params: {
  v1Features: readonly string[];
  coreWorkflow: string | null;
  evidenceRows: readonly EvidenceRowRef[];
  customerRequirements: readonly CustomerRequirement[];
}): TracedRequirements {
  const rows = [...params.evidenceRows];
  const workflowTokens = params.coreWorkflow === null ? null : contentTokens(params.coreWorkflow);
  const priceRows = priceAcceptanceRows(rows);
  const commitmentRows = rows.filter((r) => r.origin === 'commitments');

  const requirements: SpecRequirement[] = [];
  const dropped: DroppedFeature[] = [];
  let next = 1;

  for (const feature of params.v1Features) {
    const featureTokens = contentTokens(feature);
    if (featureTokens.size === 0) {
      dropped.push({ text: feature, reason: 'the feature text carries no distinctive words to match on' });
      continue;
    }

    const matches: Array<{ row: EvidenceRowRef; shared: string[] }> = [];
    for (const row of rows) {
      const shared = sharedTokens(featureTokens, contentTokens(row.text));
      if (shared.length >= MIN_SHARED_TOKENS) matches.push({ row, shared });
    }

    if (matches.length > 0) {
      const matchedRows = matches.map((m) => m.row);
      const companies = uniqueCompanies(matchedRows);
      requirements.push({
        id: `REQ-${next++}`,
        text: feature,
        basis: 'REQUESTED',
        companies,
        supportingRowIds: matchedRows.map(rowRef),
        matchedOn: [...new Set(matches.flatMap((m) => m.shared))].sort(),
        sourceNote:
          `${companies} unique ${companies === 1 ? 'company' : 'companies'} asked for this in their own words` +
          ` across ${matchedRows.length} ${matchedRows.length === 1 ? 'row' : 'rows'}`,
      });
      continue;
    }

    const workflowShared =
      workflowTokens === null ? [] : sharedTokens(featureTokens, workflowTokens);
    if (workflowShared.length >= MIN_SHARED_TOKENS) {
      const support = priceRows.length > 0 ? priceRows : commitmentRows;
      if (support.length === 0) {
        dropped.push({
          text: feature,
          reason: 'part of the core workflow, but no company has committed to that workflow yet',
        });
        continue;
      }
      const companies = uniqueCompanies(support);
      requirements.push({
        id: `REQ-${next++}`,
        text: feature,
        basis: 'NEEDED_BY_CORE_WORKFLOW',
        companies,
        supportingRowIds: support.map(rowRef),
        matchedOn: workflowShared,
        sourceNote:
          `no company named this feature, but it is part of the core workflow that ${companies} unique` +
          ` ${companies === 1 ? 'company' : 'companies'} committed to at the displayed price`,
      });
      continue;
    }

    dropped.push({
      text: feature,
      reason: 'no commitment row, no reply and not part of the recorded core workflow',
    });
  }

  const seen = new Set(requirements.map((r) => r.text.toLowerCase()));
  for (const requirement of params.customerRequirements) {
    const key = requirement.requirement.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    requirements.push({
      id: `REQ-${next++}`,
      text: requirement.requirement,
      basis: 'REQUESTED',
      companies: requirement.companies,
      supportingRowIds: requirement.sourceRowIds.map((id) => `messages.${id}`),
      matchedOn: [],
      sourceNote:
        `extracted verbatim from ${requirement.companies} unique` +
        ` ${requirement.companies === 1 ? 'company' : 'companies'}`,
    });
  }

  return { requirements, dropped };
}
