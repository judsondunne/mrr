/**
 * PUBLIC API — BUILD-TIME FEASIBILITY REVALIDATION. Owned by the evidence agent.
 *
 * Runs immediately before the owner is told to build something. Never
 * recommend a product whose key API may not exist.
 *
 * What "feasible" means here, precisely, because the difference matters:
 *
 *   - A check FAILS on RECORDED DOUBT: a capability finding that says the
 *     platform does not do this, a feasibility blocker someone wrote down, a
 *     build estimate over the cap, or a missing core workflow. A failed check
 *     records a blocker and blocks the owner notification.
 *   - A check PASSES with an explicit UNVERIFIED list when nothing contradicts
 *     the wedge. The list is printed in the report and in API_FEASIBILITY.md,
 *     so "we never checked this" is visible rather than silently equal to
 *     "we checked and it is fine".
 *
 * Spikes are not free, so they are not speculative either. A technical spike
 * runs only for a capability that already has an INFERRED claim recorded
 * against it — that is what "materially uncertain" means: something upstream
 * asserted a capability without a source, and the spike is the only sanctioned
 * way to turn that into a confirmed fact. A capability with no claim at all is
 * simply unverified, and is reported as such.
 */
import { z } from 'zod';
import { getConfig } from '../lib/config';
import { getDb } from '../lib/db';
import { AppError, FetchError } from '../lib/errors';
import { politeFetch } from '../lib/fetch';
import { llmComplete } from '../lib/llm/index';
import { createLogger, errorToFields } from '../lib/logger';
import { recordAudit } from '../lib/audit';
import {
  getFeasibilityBlockers,
  loadOpportunity,
  parseWedge,
  recordFeasibilityBlocker,
  resolveBuildDays,
  type WedgeFacts,
} from '../pipeline/validation/index';
import {
  claimIsConfirmed,
  claimIsExpired,
  claimsFor,
  recordClaim,
  type EvidenceClaim,
} from './provenance';

const logger = createLogger('autonomy:feasibility');
const ACTOR = 'revalidate_feasibility';

export interface FeasibilityReport {
  opportunityId: string;
  feasible: boolean;
  checkedAt: Date;
  checks: Array<{
    name: string;
    passed: boolean;
    detail: string;
    sourceUrl: string | null;
  }>;
  estimatedBuildDays: number | null;
  blockers: string[];
}

/** Stable check names. They end up in audit rows, so do not rename them. */
export const FEASIBILITY_CHECKS = {
  platformApisExist: 'PLATFORM_APIS_EXIST',
  permissionsAvailable: 'PERMISSIONS_AVAILABLE',
  noAppReviewBlocker: 'NO_APP_REVIEW_BLOCKER',
  coreWorkflowFeasible: 'CORE_WORKFLOW_FEASIBLE',
  buildDaysWithinCap: 'BUILD_DAYS_WITHIN_CAP',
  thirdPartyDependenciesReasonable: 'THIRD_PARTY_DEPENDENCIES_REASONABLE',
} as const;

/**
 * Claim-text prefixes that turn a PLATFORM_CAPABILITY row into a yes/no
 * finding. Anything else stored under that claim type (for example the
 * per-check records written at the bottom of this file) is ignored by the
 * capability reader.
 */
export const CAPABILITY_CONFIRMED = 'PLATFORM CAPABILITY CONFIRMED';
export const CAPABILITY_NOT_FOUND = 'PLATFORM CAPABILITY NOT FOUND';
const CHECK_CLAIM_PREFIX = 'FEASIBILITY CHECK';

/**
 * Public documentation roots, per ecosystem. A spike has nowhere to look when
 * an ecosystem is absent here, and says so rather than guessing.
 */
export const PLATFORM_DOC_SOURCES: Readonly<Record<string, string>> = {
  shopify: 'https://shopify.dev/docs/api',
};

export function documentationSourceFor(ecosystem: string): string | null {
  return PLATFORM_DOC_SOURCES[ecosystem.trim().toLowerCase()] ?? null;
}

// --- capability findings -----------------------------------------------------

export interface CapabilityFinding {
  capability: string;
  supported: boolean;
  sourceUrl: string | null;
  note: string;
}

/**
 * Records that the platform does, or does not, support a capability.
 *
 * `inferred` stays available so a finding that nobody actually read a document
 * for keeps its flag; only a sourced finding is ever treated as confirmed.
 */
export async function recordCapabilityFinding(params: {
  opportunityId: string;
  capability: string;
  supported: boolean;
  sourceUrl?: string | null;
  note?: string;
  inferred?: boolean;
  extractionModel?: string | null;
}): Promise<EvidenceClaim> {
  const prefix = params.supported ? CAPABILITY_CONFIRMED : CAPABILITY_NOT_FOUND;
  return recordClaim({
    opportunityId: params.opportunityId,
    claimType: 'PLATFORM_CAPABILITY',
    claimText: `${prefix}: ${params.capability}`,
    sourceUrl: params.sourceUrl ?? null,
    evidenceExcerpt: params.note ?? params.capability,
    extractionModel: params.extractionModel ?? null,
    confidence: params.supported ? 0.85 : 0.85,
    inferred: params.inferred === true,
  });
}

function capabilityOf(claim: EvidenceClaim, prefix: string): string | null {
  const marker = `${prefix}: `;
  if (!claim.claimText.startsWith(marker)) return null;
  return claim.claimText.slice(marker.length).trim();
}

interface CapabilityIndex {
  confirmed: Map<string, EvidenceClaim>;
  notFound: Map<string, EvidenceClaim>;
  uncertain: Map<string, EvidenceClaim>;
}

function indexCapabilityClaims(claims: EvidenceClaim[]): CapabilityIndex {
  const now = new Date();
  const confirmed = new Map<string, EvidenceClaim>();
  const notFound = new Map<string, EvidenceClaim>();
  const uncertain = new Map<string, EvidenceClaim>();

  for (const claim of claims) {
    if (claim.claimText.startsWith(`${CHECK_CLAIM_PREFIX} `)) continue;

    const missing = capabilityOf(claim, CAPABILITY_NOT_FOUND);
    if (missing !== null && !claim.inferred && !claimIsExpired(claim, now)) {
      notFound.set(missing.toLowerCase(), claim);
      continue;
    }
    const present = capabilityOf(claim, CAPABILITY_CONFIRMED);
    if (present !== null && claimIsConfirmed(claim, now)) {
      confirmed.set(present.toLowerCase(), claim);
      continue;
    }
    // Anything inferred is, by definition, not established. Remember what it
    // was about so a spike can try to settle it.
    if (claim.inferred) {
      const subject = present ?? missing ?? claim.evidenceExcerpt ?? claim.claimText;
      uncertain.set(subject.trim().toLowerCase(), claim);
    }
  }

  return { confirmed, notFound, uncertain };
}

// --- technical spike ---------------------------------------------------------

const CapabilityVerdict = z.object({
  supported: z.enum(['YES', 'NO', 'UNCLEAR']),
  note: z.string().max(280),
});

const SPIKE_SYSTEM = [
  'You read one excerpt of platform API documentation and answer one question:',
  'does the documented API support the named capability?',
  'Rules:',
  '- Answer only from the excerpt. If the excerpt does not settle it, answer UNCLEAR.',
  '- Never assume an undocumented endpoint exists.',
  '- The note must be one short factual sentence with no digits and no URL.',
].join('\n');

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'per', 'via', 'our', 'their',
  'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'or', 'is', 'are', 'be', 'it', 'its',
]);

export function capabilityTokens(capability: string): string[] {
  return capability
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

export interface DocumentationScan {
  /** Every token of the capability appears in the document. */
  found: boolean;
  /** Some but not all tokens appear: a model may read the excerpt. */
  ambiguous: boolean;
  /** Verbatim slice of the document around the first match. Never rewritten. */
  excerpt: string | null;
}

/**
 * Deterministic first pass over fetched documentation. Pure, so it is unit
 * tested without a network and without a model.
 */
export function findCapabilityInDocumentation(
  documentation: string,
  capability: string,
  windowChars = 600,
): DocumentationScan {
  const haystack = documentation.replace(/\s+/g, ' ').toLowerCase();
  const tokens = capabilityTokens(capability);
  if (tokens.length === 0 || haystack.length === 0) {
    return { found: false, ambiguous: false, excerpt: null };
  }

  const hits = tokens.filter((token) => haystack.includes(token));
  if (hits.length === 0) return { found: false, ambiguous: false, excerpt: null };

  const anchor = hits[0] ?? tokens[0] ?? '';
  const at = haystack.indexOf(anchor);
  const start = Math.max(0, at - Math.floor(windowChars / 2));
  const excerpt = documentation
    .replace(/\s+/g, ' ')
    .slice(start, start + windowChars)
    .trim();

  return {
    found: hits.length === tokens.length,
    ambiguous: hits.length < tokens.length,
    excerpt: excerpt.length > 0 ? excerpt : null,
  };
}

/** One fetch per documentation root per process. Spikes are cheap or they do not run. */
const documentationCache = new Map<string, string | null>();

async function loadDocumentation(url: string): Promise<string | null> {
  const cached = documentationCache.get(url);
  if (cached !== undefined) return cached;
  try {
    // One attempt, short timeout: a spike that cannot answer quickly is a
    // spike that reports "unresolved", not one that stalls the pipeline.
    const res = await politeFetch(url, { timeoutMs: 8000, maxRetries: 0 });
    documentationCache.set(url, res.body);
    return res.body;
  } catch (err) {
    if (!(err instanceof FetchError)) logger.warn('documentation load failed', errorToFields(err));
    documentationCache.set(url, null);
    return null;
  }
}

/** Test seam: forget any documentation loaded in this process. */
export function resetDocumentationCache(): void {
  documentationCache.clear();
}

/** A small automatic technical spike when a capability claim is uncertain. */
export async function runTechnicalSpike(params: {
  opportunityId: string;
  capability: string;
}): Promise<{ resolved: boolean; evidenceUrl: string | null; note: string }> {
  const opportunity = await loadOpportunity(params.opportunityId);
  if (!opportunity) {
    return {
      resolved: false,
      evidenceUrl: null,
      note: `no opportunity ${params.opportunityId}`,
    };
  }

  const url = documentationSourceFor(opportunity.ecosystem);
  if (!url) {
    return {
      resolved: false,
      evidenceUrl: null,
      note: `no public documentation source is registered for ecosystem ${opportunity.ecosystem}`,
    };
  }

  const documentation = await loadDocumentation(url);
  if (documentation === null) {
    return { resolved: false, evidenceUrl: url, note: 'platform documentation could not be read' };
  }

  const scan = findCapabilityInDocumentation(documentation, params.capability);

  if (scan.found) {
    await recordCapabilityFinding({
      opportunityId: params.opportunityId,
      capability: params.capability,
      supported: true,
      sourceUrl: url,
      note: scan.excerpt ?? params.capability,
    });
    return {
      resolved: true,
      evidenceUrl: url,
      note: 'the platform documentation names every part of this capability',
    };
  }

  if (!scan.ambiguous || scan.excerpt === null) {
    await recordCapabilityFinding({
      opportunityId: params.opportunityId,
      capability: params.capability,
      supported: false,
      sourceUrl: url,
      note: 'the platform documentation does not mention this capability',
    });
    return {
      resolved: true,
      evidenceUrl: url,
      note: 'the platform documentation does not mention this capability',
    };
  }

  // Deterministic scan could not settle it. A cheap model reads ONE excerpt,
  // and the excerpt travels as untrusted data so nothing inside it is ever
  // treated as an instruction.
  const verdict = await interpretExcerpt(params.capability, scan.excerpt, url);
  if (verdict === null) {
    return {
      resolved: false,
      evidenceUrl: url,
      note: 'the documentation excerpt was inconclusive',
    };
  }

  await recordCapabilityFinding({
    opportunityId: params.opportunityId,
    capability: params.capability,
    supported: verdict.supported,
    sourceUrl: url,
    note: scan.excerpt,
    extractionModel: verdict.model,
  });
  return { resolved: true, evidenceUrl: url, note: verdict.note };
}

async function interpretExcerpt(
  capability: string,
  excerpt: string,
  url: string,
): Promise<{ supported: boolean; note: string; model: string } | null> {
  try {
    const res = await llmComplete({
      tier: 'fast',
      task: 'feasibility_capability_spike',
      schemaName: 'CapabilityVerdict',
      schema: CapabilityVerdict,
      maxTokens: 300,
      phase: 'FINAL_ANALYSIS',
      system: SPIKE_SYSTEM,
      user: [
        `Capability under test: ${capability}`,
        `Documentation source: ${url}`,
        '',
        'Answer YES only if the excerpt shows the platform supports it.',
      ].join('\n'),
      untrusted: { platform_documentation: excerpt },
    });
    // The mock provider answers whatever the schema allows, so its opinion is
    // worth nothing. Shadow mode and the test suite stay honest.
    if (res.model.startsWith('mock:')) return null;
    if (res.data.supported === 'UNCLEAR') return null;
    return {
      supported: res.data.supported === 'YES',
      note: res.data.note,
      model: res.model,
    };
  } catch (err) {
    logger.warn('capability interpretation unavailable', errorToFields(err));
    return null;
  }
}

// --- the report ---------------------------------------------------------------

type Check = FeasibilityReport['checks'][number];

function check(name: string, passed: boolean, detail: string, sourceUrl: string | null): Check {
  return { name, passed, detail, sourceUrl };
}

function listOrNone(values: string[]): string {
  return values.length === 0 ? 'none' : values.join('; ');
}

const PERMISSION_WORDS = /\b(scope|scopes|permission|permissions|oauth|access token|grant)\b/i;
const APP_REVIEW_WORDS = /\b(app review|listing policy|store policy|review team|rejected by|policy violation)\b/i;

function capabilityList(wedge: WedgeFacts): string[] {
  const named = wedge.capabilities.filter((c) => c.trim().length > 0);
  if (named.length > 0) return named;
  // A wedge without an explicit capability list still states what V1 does, and
  // every V1 feature is something the platform has to allow.
  return wedge.v1Features.filter((f) => f.trim().length > 0);
}

function mentions(text: string, capability: string): boolean {
  const tokens = capabilityTokens(capability);
  if (tokens.length === 0) return false;
  const haystack = text.toLowerCase();
  const hits = tokens.filter((token) => haystack.includes(token));
  return hits.length >= Math.max(2, Math.ceil(tokens.length / 2));
}

/**
 * Runs immediately BEFORE the owner is notified.
 *
 * Side effects, all of them deliberate:
 *   - every check is recorded as a traceable PLATFORM_CAPABILITY claim
 *   - every failed check records a feasibility blocker (deduplicated), which
 *     the deterministic gate then sees on its next evaluation
 *   - `opportunities.feasibility_checked_at` is stamped
 */
export async function revalidateFeasibility(opportunityId: string): Promise<FeasibilityReport> {
  const cfg = getConfig();
  const opportunity = await loadOpportunity(opportunityId);
  if (!opportunity) {
    throw new AppError(`no opportunity ${opportunityId}`, 'OPPORTUNITY_NOT_FOUND');
  }

  const wedge = parseWedge(opportunity.wedge_json);
  const capabilities = capabilityList(wedge);
  const existingBlockers = await getFeasibilityBlockers(opportunityId);
  const blockerText = existingBlockers.map((b) => b.detail);

  let index = indexCapabilityClaims(await claimsFor(opportunityId, 'PLATFORM_CAPABILITY'));

  // Materially uncertain capabilities get one spike each, then we re-read.
  const uncertain = capabilities.filter((capability) => {
    const key = capability.toLowerCase();
    if (index.confirmed.has(key) || index.notFound.has(key)) return false;
    return index.uncertain.has(key);
  });
  if (uncertain.length > 0) {
    for (const capability of uncertain) {
      const outcome = await runTechnicalSpike({ opportunityId, capability });
      logger.info('technical spike complete', { opportunityId, capability, ...outcome });
    }
    index = indexCapabilityClaims(await claimsFor(opportunityId, 'PLATFORM_CAPABILITY'));
  }

  const missing: CapabilityFinding[] = [];
  const verified: string[] = [];
  const unverified: string[] = [];
  for (const capability of capabilities) {
    const key = capability.toLowerCase();
    const absent = index.notFound.get(key);
    if (absent) {
      missing.push({
        capability,
        supported: false,
        sourceUrl: absent.sourceUrl,
        note: absent.evidenceExcerpt ?? absent.claimText,
      });
      continue;
    }
    if (index.confirmed.has(key)) verified.push(capability);
    else unverified.push(capability);
  }

  const checks: Check[] = [];

  // 1. The platform APIs the wedge depends on still exist.
  const firstMissing = missing[0];
  checks.push(
    check(
      FEASIBILITY_CHECKS.platformApisExist,
      missing.length === 0,
      missing.length > 0
        ? `the platform does not provide ${missing.length} capability the wedge depends on: ${missing
            .map((m) => m.capability)
            .join('; ')}`
        : `no recorded evidence contradicts the ${capabilities.length} capabilities this wedge needs` +
          ` (confirmed against documentation: ${listOrNone(verified)}; not independently verified: ${listOrNone(unverified)})`,
      firstMissing?.sourceUrl ?? documentationSourceFor(opportunity.ecosystem),
    ),
  );

  // 2. Permissions / scopes are available.
  const permissionDoubt = [
    ...blockerText.filter((b) => PERMISSION_WORDS.test(b)),
    ...missing.filter((m) => PERMISSION_WORDS.test(`${m.capability} ${m.note}`)).map((m) => m.capability),
  ];
  checks.push(
    check(
      FEASIBILITY_CHECKS.permissionsAvailable,
      permissionDoubt.length === 0,
      permissionDoubt.length > 0
        ? `a recorded finding says the required access is not available: ${listOrNone(permissionDoubt)}`
        : 'no recorded finding says a required scope or permission is unavailable',
      firstMissing?.sourceUrl ?? null,
    ),
  );

  // 3. No obvious app-review blocker.
  const reviewDoubt = [
    ...blockerText.filter((b) => APP_REVIEW_WORDS.test(b)),
    ...missing.filter((m) => APP_REVIEW_WORDS.test(`${m.capability} ${m.note}`)).map((m) => m.capability),
  ];
  checks.push(
    check(
      FEASIBILITY_CHECKS.noAppReviewBlocker,
      reviewDoubt.length === 0,
      reviewDoubt.length > 0
        ? `a recorded finding names a listing or app-review obstacle: ${listOrNone(reviewDoubt)}`
        : 'no recorded finding names a listing or app-review obstacle',
      null,
    ),
  );

  // 4. The core workflow is technically feasible.
  const workflow = wedge.coreWorkflow;
  const workflowBlocked = workflow === null ? [] : missing.filter((m) => mentions(workflow, m.capability));
  const workflowOk = workflow !== null && workflowBlocked.length === 0;
  checks.push(
    check(
      FEASIBILITY_CHECKS.coreWorkflowFeasible,
      workflowOk,
      workflow === null
        ? 'no core workflow is recorded on the wedge, so nobody can say whether it can be built'
        : workflowBlocked.length > 0
          ? `the core workflow depends on a capability the platform does not provide: ${workflowBlocked
              .map((m) => m.capability)
              .join('; ')}`
          : 'the recorded core workflow uses no capability that has been found missing',
      workflowBlocked[0]?.sourceUrl ?? null,
    ),
  );

  // 5. The MVP is still small enough to ship.
  const buildDays = resolveBuildDays(opportunity, wedge);
  const buildOk = buildDays !== null && buildDays <= cfg.maxMvpBuildDays;
  checks.push(
    check(
      FEASIBILITY_CHECKS.buildDaysWithinCap,
      buildOk,
      buildDays === null
        ? `no MVP build estimate is recorded, and the cap is ${cfg.maxMvpBuildDays} days`
        : `the recorded MVP estimate is ${buildDays} days against a cap of ${cfg.maxMvpBuildDays}`,
      null,
    ),
  );

  // 6. Third-party dependencies are reasonable: no V1 feature rests on a
  //    capability that has been found missing.
  const strandedFeatures = wedge.v1Features.filter((feature) =>
    missing.some((m) => mentions(feature, m.capability)),
  );
  checks.push(
    check(
      FEASIBILITY_CHECKS.thirdPartyDependenciesReasonable,
      strandedFeatures.length === 0,
      strandedFeatures.length > 0
        ? `${strandedFeatures.length} V1 feature depends on something the platform does not provide: ${strandedFeatures.join('; ')}`
        : `all ${wedge.v1Features.length} V1 features rest on capabilities with no recorded contradiction`,
      firstMissing?.sourceUrl ?? null,
    ),
  );

  const failed = checks.filter((c) => !c.passed);
  const blockers = failed.map((c) => `${c.name}: ${c.detail}`);
  const checkedAt = new Date();

  // Record every check, with its source URL, as traceable provenance.
  for (const entry of checks) {
    await recordClaim({
      opportunityId,
      claimType: 'PLATFORM_CAPABILITY',
      claimText: `${CHECK_CLAIM_PREFIX} ${entry.name}: ${entry.passed ? 'PASSED' : 'FAILED'}`,
      sourceUrl: entry.sourceUrl,
      evidenceExcerpt: entry.detail,
      confidence: entry.passed ? 0.8 : 0.95,
      inferred: false,
    });
  }

  // A failed check must leave a durable blocker behind, but re-running must
  // not pile up copies of the same sentence.
  const alreadyRecorded = new Set(blockerText);
  for (const blocker of blockers) {
    if (alreadyRecorded.has(blocker)) continue;
    await recordFeasibilityBlocker(opportunityId, blocker, ACTOR);
    alreadyRecorded.add(blocker);
  }

  const db = await getDb();
  await db.query('UPDATE opportunities SET feasibility_checked_at = now() WHERE id = $1', [
    opportunityId,
  ]);

  await recordAudit({
    entityType: 'opportunity',
    entityId: opportunityId,
    eventType: 'DECISION',
    actor: ACTOR,
    reason: failed.length === 0 ? 'feasibility revalidated' : 'feasibility revalidation failed',
    detail: {
      feasible: failed.length === 0,
      checks,
      verifiedCapabilities: verified,
      unverifiedCapabilities: unverified,
      missingCapabilities: missing.map((m) => m.capability),
      estimatedBuildDays: buildDays,
    },
  });

  logger.info('feasibility revalidated', {
    opportunityId,
    feasible: failed.length === 0,
    failed: failed.map((c) => c.name),
  });

  return {
    opportunityId,
    feasible: failed.length === 0,
    checkedAt,
    checks,
    estimatedBuildDays: buildDays,
    blockers,
  };
}

/** Reads the newest report without re-running it. Used by the build spec. */
export async function lastFeasibilityCheckAt(opportunityId: string): Promise<Date | null> {
  const db = await getDb();
  const res = await db.query<{ feasibility_checked_at: string | Date | null }>(
    'SELECT feasibility_checked_at FROM opportunities WHERE id = $1',
    [opportunityId],
  );
  const value = res.rows[0]?.feasibility_checked_at ?? null;
  if (value === null) return null;
  return value instanceof Date ? value : new Date(String(value));
}
