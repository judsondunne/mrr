/**
 * AUTO-REJECTION RULES — PURE CODE.
 *
 * Rejection is the default. A category has to survive this file to be worth a
 * single further dollar of LLM or search spend.
 *
 * This is deliberately keyword/rule based, NOT an LLM judgement. An LLM may
 * only ever *extract structured facts* (see `RejectionSubject`) that these
 * rules then evaluate; it may not decide anything here.
 *
 * Two rule strengths:
 *   HARD    — one match rejects outright, with a mapped RejectionReason.
 *   PENALTY — "heavily penalize" categories. Each match adds weight; the
 *             subject is rejected once the total reaches REJECT_PENALTY_THRESHOLD.
 */
import { getConfig } from '../../lib/config.js';
import type { RejectionReason } from '../../lib/contracts.js';

export type RuleStrength = 'HARD' | 'PENALTY';

export interface RejectionRule {
  id: string;
  strength: RuleStrength;
  reason: RejectionReason;
  /** Points added when PENALTY. Ignored for HARD rules. */
  weight: number;
  pattern: RegExp;
  detail: string;
}

export interface RuleMatch {
  ruleId: string;
  reason: RejectionReason;
  strength: RuleStrength;
  weight: number;
  detail: string;
  /** The exact text that tripped the rule. */
  matched: string;
}

/**
 * The facts the rules read. Every field is extracted deterministically by the
 * discovery layer; nothing here is a model's opinion.
 */
export interface RejectionSubject {
  name: string;
  category: string;
  description?: string;
  /** Competitor names, pricing text, review text — anything already fetched. */
  corpus?: string;
  estimatedBuildDays?: number | null;
  competitorCount?: number;
  paidCompetitorCount?: number;
  /** True when the platform itself ships a good free version of this job. */
  dominatedByFreeNativeFeature?: boolean;
}

export interface RejectionVerdict {
  rejected: boolean;
  reason: RejectionReason | null;
  ruleId: string | null;
  detail: string;
  penalty: number;
  matches: RuleMatch[];
}

export const REJECT_PENALTY_THRESHOLD = 100;

/** Above this, an MVP is not a 1-2 week build and the category is out. */
export const HARD_MAX_BUILD_DAYS = 14;

// --- the rules ---------------------------------------------------------------

const HARD_RULES: readonly RejectionRule[] = [
  {
    id: 'REGULATED_MEDICAL',
    strength: 'HARD',
    reason: 'DISALLOWED_DOMAIN',
    weight: 0,
    pattern:
      /\b(diagnos\w+|medical (?:advice|decision|device)|patient (?:care|record|triage)|prescription|clinical (?:decision|trial)|hipaa|ehr|emr|telehealth|dosage|symptom checker)\b/i,
    detail: 'regulated medical decision-making',
  },
  {
    id: 'FINANCIAL_CUSTODY',
    strength: 'HARD',
    reason: 'DISALLOWED_DOMAIN',
    weight: 0,
    pattern:
      /\b(custody of funds|hold(?:ing)? (?:customer|client) funds|brokerage|securities trading|trading (?:bot|signals|algorithm)|crypto (?:wallet|exchange|custody)|lending|underwriting|money transmi\w+|escrow)\b/i,
    detail: 'financial custody, trading, or money transmission',
  },
  {
    id: 'LEGAL_ADVICE',
    strength: 'HARD',
    reason: 'DISALLOWED_DOMAIN',
    weight: 0,
    pattern: /\b(legal advice|attorney|law firm (?:advice|counsel)|contract (?:drafting|review) service|litigation|paralegal)\b/i,
    detail: 'legal advice',
  },
  {
    id: 'WEAPONS',
    strength: 'HARD',
    reason: 'DISALLOWED_DOMAIN',
    weight: 0,
    pattern: /\b(firearm|ammunition|weapon(?:s|ry)|gun (?:shop|store|dealer)|explosive)\b/i,
    detail: 'weapons',
  },
  {
    id: 'GAMBLING',
    strength: 'HARD',
    reason: 'DISALLOWED_DOMAIN',
    weight: 0,
    pattern: /\b(gambling|casino|betting|sportsbook|lottery|wager(?:ing)?|loot box)\b/i,
    detail: 'gambling',
  },
  {
    id: 'ADULT_SERVICES',
    strength: 'HARD',
    reason: 'DISALLOWED_DOMAIN',
    weight: 0,
    pattern: /\b(adult (?:content|services|entertainment)|pornograph\w+|escort service|nsfw marketplace)\b/i,
    detail: 'adult services',
  },
  {
    id: 'DECEPTIVE_MARKETING',
    strength: 'HARD',
    reason: 'DISALLOWED_DOMAIN',
    weight: 0,
    pattern:
      /\b(fake (?:reviews?|followers?|testimonials?|urgency)|review (?:generation|farming)|spam(?:my)? (?:email|outreach|dm)|dark patterns?|bait and switch|scrape emails)\b/i,
    detail: 'deceptive marketing',
  },
  {
    id: 'SURVEILLANCE',
    strength: 'HARD',
    reason: 'DISALLOWED_DOMAIN',
    weight: 0,
    pattern:
      /\b(surveillance|keystroke logg\w+|employee monitoring|spyware|stalkerware|covert tracking|facial recognition|session recording of (?:individual|identified) users)\b/i,
    detail: 'surveillance',
  },
  {
    id: 'BYPASS_PLATFORM_PROTECTIONS',
    strength: 'HARD',
    reason: 'DISALLOWED_DOMAIN',
    weight: 0,
    pattern:
      /\b(bypass(?:ing)? (?:rate limits?|captcha|paywall|checkout|platform (?:rules|protections)|api limits?)|circumvent\w* (?:restrictions?|protections?)|captcha solv\w+|unofficial (?:private )?api|scraping behind (?:a )?login|credential stuffing)\b/i,
    detail: 'bypassing platform protections',
  },
  {
    id: 'PROPRIETARY_DATASET_REQUIRED',
    strength: 'HARD',
    reason: 'BUILD_TOO_LARGE',
    weight: 0,
    pattern:
      /\b(proprietary dataset|massive (?:training )?dataset|requires? (?:a )?(?:large|huge) (?:corpus|data ?set)|train(?:ing)? (?:our own|a custom) (?:model|llm)|data moat)\b/i,
    detail: 'requires a proprietary dataset we do not have',
  },
  {
    id: 'NETWORK_EFFECTS',
    strength: 'HARD',
    reason: 'NETWORK_EFFECTS_REQUIRED',
    weight: 0,
    pattern:
      /\b(network effects?|viral loop|only (?:valuable|useful) (?:once|when) (?:many|enough) (?:users|members)|community[- ]driven directory|critical mass of users)\b/i,
    detail: 'value depends on network effects',
  },
  {
    id: 'TWO_SIDED_MARKETPLACE',
    strength: 'HARD',
    reason: 'TWO_SIDED_MARKETPLACE',
    weight: 0,
    pattern:
      /\b(two[- ]sided|marketplace connecting|match(?:es|ing)? (?:buyers (?:and|with) sellers|supply (?:and|with) demand)|both buyers and sellers|chicken[- ]and[- ]egg)\b/i,
    detail: 'two-sided marketplace',
  },
  {
    id: 'ENTERPRISE_SALES',
    strength: 'HARD',
    reason: 'ENTERPRISE_SALES_REQUIRED',
    weight: 0,
    pattern:
      /\b(enterprise sales|field sales|sales (?:team|engineer)s? required|rfp|procurement process|soc ?2 required (?:to|before) sell\w*|msa negotiation|six[- ]figure (?:contract|deal)s?)\b/i,
    detail: 'requires heavy enterprise sales motion',
  },
  {
    id: 'MANUAL_PROFESSIONAL_SERVICES',
    strength: 'HARD',
    reason: 'ENTERPRISE_SALES_REQUIRED',
    weight: 0,
    pattern:
      /\b(done[- ]for[- ]you service|managed service|manual (?:data )?entry by (?:our|a) team|consulting engagement|white[- ]glove onboarding|agency retainer|human[- ]in[- ]the[- ]loop review of every)\b/i,
    detail: 'requires extensive manual professional services',
  },
  {
    id: 'MISSION_CRITICAL_INFRA',
    strength: 'HARD',
    reason: 'HIGH_LIABILITY',
    weight: 0,
    pattern:
      /\b(24\/7 (?:uptime|on[- ]call)|mission[- ]critical (?:infrastructure|uptime)|five nines|99\.99% uptime|real[- ]time payment processing|cannot (?:ever )?go down)\b/i,
    detail: '24/7 mission-critical infrastructure',
  },
  {
    id: 'HIGH_LIABILITY_RULE_FAILURE',
    strength: 'HARD',
    reason: 'HIGH_LIABILITY',
    weight: 0,
    pattern:
      /\b(tax (?:filing|remittance|calculation for compliance)|regulatory filing|customs declaration|payroll (?:calculation|processing)|safety[- ]critical|liab(?:le|ility) (?:for|if) (?:errors?|mistakes?)|fines? (?:if|for) (?:incorrect|wrong))\b/i,
    detail: 'high liability if a rule fails',
  },
  {
    id: 'INTEGRATION_COMPLEXITY',
    strength: 'HARD',
    reason: 'BUILD_TOO_LARGE',
    weight: 0,
    pattern:
      /\b(integrat\w+ with (?:\d{2,}|dozens of|every major) (?:systems?|platforms?|erps?)|erp integration|edi\b|sap\b|netsuite|legacy mainframe|on[- ]premise deployment)\b/i,
    detail: 'extreme integration or support complexity',
  },
];

const PENALTY_RULES: readonly RejectionRule[] = [
  {
    id: 'GENERIC_AI_WRAPPER',
    strength: 'PENALTY',
    reason: 'GENERIC_AI_WRAPPER',
    weight: 100,
    pattern:
      /\b(ai[- ](?:powered )?(?:wrapper|writer|copywriter|content generator)|chatgpt (?:wrapper|for)|gpt[- ]powered (?:assistant|writer)|generate (?:blog posts?|product descriptions?) with ai|prompt library)\b/i,
    detail: 'generic AI wrapper',
  },
  {
    id: 'GENERIC_CHATBOT',
    strength: 'PENALTY',
    reason: 'GENERIC_AI_WRAPPER',
    weight: 100,
    pattern: /\b(ai chatbot|chatbot (?:builder|for your (?:site|store|website))|conversational ai assistant|live chat widget)\b/i,
    detail: 'generic chatbot',
  },
  {
    id: 'GENERIC_MEETING_ASSISTANT',
    strength: 'PENALTY',
    reason: 'GENERIC_AI_WRAPPER',
    weight: 100,
    pattern: /\b(meeting (?:assistant|notetaker|summar\w+)|transcribe (?:your )?meetings?|call recorder and summar\w+)\b/i,
    detail: 'generic meeting assistant',
  },
  {
    id: 'GENERIC_CRM',
    strength: 'PENALTY',
    reason: 'GENERIC_AI_WRAPPER',
    weight: 80,
    pattern: /\b(crm\b|customer relationship management|contact (?:management|pipeline) (?:tool|suite)|sales pipeline (?:tool|software))\b/i,
    detail: 'generic CRM',
  },
  {
    id: 'GENERIC_PROJECT_MANAGEMENT',
    strength: 'PENALTY',
    reason: 'GENERIC_AI_WRAPPER',
    weight: 80,
    pattern: /\b(project management (?:tool|software|app)|kanban board|task (?:tracker|management) (?:tool|app)|team collaboration suite)\b/i,
    detail: 'generic project management',
  },
  {
    id: 'DOMINATED_BY_FREE_NATIVE_FEATURE',
    strength: 'PENALTY',
    reason: 'DOMINATED_BY_FREE_NATIVE_FEATURE',
    weight: 100,
    pattern:
      /\b(built into (?:shopify|the platform) (?:for free|natively)|native(?:ly)? (?:supported|included) (?:for free|out of the box)|shopify already does this|free native feature|superseded by (?:a )?native feature)\b/i,
    detail: 'dominated by an excellent free native feature',
  },
];

export const ALL_RULES: readonly RejectionRule[] = [...HARD_RULES, ...PENALTY_RULES];

export function getRule(id: string): RejectionRule | null {
  return ALL_RULES.find((r) => r.id === id) ?? null;
}

// --- build-size estimation ---------------------------------------------------

interface ComplexitySignal {
  re: RegExp;
  days: number;
  label: string;
}

const BASE_BUILD_DAYS = 3;

const COMPLEXITY_SIGNALS: readonly ComplexitySignal[] = [
  { re: /\b(rule|rules|validation|limit|threshold)\b/i, days: 0, label: 'rule engine (baseline)' },
  { re: /\b(sync|synchroniz\w+|two[- ]way)\b/i, days: 2, label: 'synchronization' },
  { re: /\b(import|export|csv|bulk)\b/i, days: 1, label: 'bulk import/export' },
  { re: /\b(webhook|real[- ]?time|event[- ]driven)\b/i, days: 1, label: 'realtime/webhooks' },
  { re: /\b(multi[- ]?(?:store|location|currency|language)|internationali\w+)\b/i, days: 2, label: 'multi-tenant dimensions' },
  { re: /\b(machine learning|forecast\w*|recommendation engine|ml model)\b/i, days: 5, label: 'modelling' },
  { re: /\b(carrier|shipping rates? api|third[- ]party api|integrat\w+)\b/i, days: 2, label: 'third-party integration' },
  { re: /\b(dashboard|analytics|report(?:ing|s)?)\b/i, days: 1, label: 'reporting surface' },
  { re: /\b(checkout extension|theme app extension|storefront widget)\b/i, days: 2, label: 'storefront surface' },
  { re: /\b(pdf|invoice|document generation)\b/i, days: 1, label: 'document generation' },
  { re: /\b(workflow (?:builder|automation)|conditional logic|rule builder ui)\b/i, days: 2, label: 'workflow builder' },
];

export interface BuildEstimate {
  days: number;
  drivers: string[];
}

/**
 * Deterministic MVP size estimate. No LLM, no guessing at a number.
 *
 * Reads the category's own identity, never the competitor corpus: how big OUR
 * build is does not depend on what an incumbent's marketing copy mentions.
 */
export function estimateBuildDays(subject: RejectionSubject): BuildEstimate {
  const text = identityText(subject);
  let days = BASE_BUILD_DAYS;
  const drivers: string[] = [`base ${BASE_BUILD_DAYS}d`];
  for (const signal of COMPLEXITY_SIGNALS) {
    if (signal.days > 0 && signal.re.test(text)) {
      days += signal.days;
      drivers.push(`${signal.label} +${signal.days}d`);
    }
  }
  return { days: Math.min(30, days), drivers };
}

// --- evaluation --------------------------------------------------------------

/**
 * What the category IS. HARD rules read only this, never the corpus: a
 * competitor listing that merely mentions "fake reviews" or a CRM must not
 * hard-reject an otherwise clean category.
 */
function identityText(subject: RejectionSubject): string {
  return [subject.name, subject.category, subject.description ?? ''].filter(Boolean).join('\n').slice(0, 8_000);
}

/** Identity plus everything already fetched. PENALTY rules read this. */
function subjectText(subject: RejectionSubject): string {
  return [identityText(subject), subject.corpus ?? ''].filter(Boolean).join('\n').slice(0, 20_000);
}

function matchOf(rule: RejectionRule, text: string): RuleMatch | null {
  const m = rule.pattern.exec(text);
  if (!m) return null;
  return {
    ruleId: rule.id,
    reason: rule.reason,
    strength: rule.strength,
    weight: rule.weight,
    detail: rule.detail,
    matched: m[0].slice(0, 120),
  };
}

/**
 * Runs every rule. Returns the first HARD match as the rejection reason, or
 * the heaviest PENALTY match once the accumulated penalty crosses the
 * threshold. Never throws.
 */
export function evaluateRejectionRules(subject: RejectionSubject): RejectionVerdict {
  const identity = identityText(subject);
  const text = subjectText(subject);
  const matches: RuleMatch[] = [];

  for (const rule of HARD_RULES) {
    const m = matchOf(rule, identity);
    if (m) matches.push(m);
  }
  const hard = matches[0];
  if (hard) {
    return {
      rejected: true,
      reason: hard.reason,
      ruleId: hard.ruleId,
      detail: `${hard.detail} (matched "${hard.matched}")`,
      penalty: REJECT_PENALTY_THRESHOLD,
      matches,
    };
  }

  const cfg = getConfig();
  const estimated = subject.estimatedBuildDays ?? null;
  if (estimated !== null && estimated > HARD_MAX_BUILD_DAYS) {
    const m: RuleMatch = {
      ruleId: 'MVP_TOO_LARGE',
      reason: 'BUILD_TOO_LARGE',
      strength: 'HARD',
      weight: 0,
      detail: `estimated MVP of ${estimated} engineering days exceeds the ${HARD_MAX_BUILD_DAYS}-day ceiling`,
      matched: `${estimated} days`,
    };
    matches.push(m);
    return {
      rejected: true,
      reason: m.reason,
      ruleId: m.ruleId,
      detail: m.detail,
      penalty: REJECT_PENALTY_THRESHOLD,
      matches,
    };
  }

  for (const rule of PENALTY_RULES) {
    const m = matchOf(rule, text);
    if (m) matches.push(m);
  }

  if (subject.dominatedByFreeNativeFeature === true) {
    matches.push({
      ruleId: 'DOMINATED_BY_FREE_NATIVE_FEATURE',
      reason: 'DOMINATED_BY_FREE_NATIVE_FEATURE',
      strength: 'PENALTY',
      weight: 100,
      detail: 'the platform ships an excellent free version of this job',
      matched: 'dominatedByFreeNativeFeature=true',
    });
  }

  if (estimated !== null && estimated > cfg.maxMvpBuildDays) {
    matches.push({
      ruleId: 'MVP_OVER_PREFERRED_SIZE',
      reason: 'BUILD_TOO_LARGE',
      strength: 'PENALTY',
      weight: 60,
      detail: `estimated MVP of ${estimated} days exceeds the preferred ${cfg.maxMvpBuildDays} days`,
      matched: `${estimated} days`,
    });
  }

  const penalty = matches
    .filter((m) => m.strength === 'PENALTY')
    .reduce((sum, m) => sum + m.weight, 0);

  if (penalty >= REJECT_PENALTY_THRESHOLD) {
    const heaviest = [...matches]
      .filter((m) => m.strength === 'PENALTY')
      .sort((a, b) => b.weight - a.weight)[0];
    if (heaviest) {
      return {
        rejected: true,
        reason: heaviest.reason,
        ruleId: heaviest.ruleId,
        detail: `${heaviest.detail} (penalty ${penalty}/${REJECT_PENALTY_THRESHOLD})`,
        penalty,
        matches,
      };
    }
  }

  return { rejected: false, reason: null, ruleId: null, detail: '', penalty, matches };
}
