import { config as loadDotenv } from 'dotenv';
import { ConfigError } from './errors';

if (typeof process !== 'undefined' && !process.env.NEXT_RUNTIME) {
  loadDotenv({ path: '.env', quiet: true });
}

// --- primitive readers -------------------------------------------------------

function str(key: string, fallback = ''): string {
  return (process.env[key] ?? fallback).trim();
}
function bool(key: string, fallback: boolean): boolean {
  const raw = str(key);
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}
function num(key: string, fallback: number): number {
  const raw = str(key);
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new ConfigError(`${key} must be a number, got "${raw}"`);
  return parsed;
}
function int(key: string, fallback: number): number {
  const v = num(key, fallback);
  if (!Number.isInteger(v)) throw new ConfigError(`${key} must be an integer, got "${v}"`);
  return v;
}
function csv(key: string, fallback: string[]): string[] {
  const raw = str(key);
  if (raw === '') return fallback;
  return raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
function intList(key: string, fallback: number[]): number[] {
  const raw = str(key);
  if (raw === '') return fallback;
  const parts = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return parts.length > 0 ? parts : fallback;
}
/** "2:10,4:20,7:35" => send at most 10/day through day 2, 20 through day 4, ... */
function parseWarmup(raw: string): Array<{ throughDay: number; maxPerDay: number }> {
  const out: Array<{ throughDay: number; maxPerDay: number }> = [];
  for (const pair of raw.split(',')) {
    const [d, n] = pair.split(':').map((s) => Number(s.trim()));
    if (Number.isFinite(d) && Number.isFinite(n) && d! > 0 && n! > 0) {
      out.push({ throughDay: d!, maxPerDay: n! });
    }
  }
  return out.sort((a, b) => a.throughDay - b.throughDay);
}

// --- shape -------------------------------------------------------------------

export type DatabaseMode = 'auto' | 'postgres' | 'pglite';
export type LlmProviderName = 'anthropic' | 'mock';
export type SearchProviderName = 'brave' | 'mock';
export type EmailProviderName = 'resend' | 'mock';

export interface Config {
  autonomyEnabled: boolean;
  outreachEnabled: boolean;
  killSwitch: boolean;

  databaseUrl: string;
  databaseMode: DatabaseMode;
  pgliteDataDir: string;

  llmProvider: LlmProviderName;
  anthropicApiKey: string;
  llmFast: string;
  llmReasoner: string;
  llmFastInputCostPerMTok: number;
  llmFastOutputCostPerMTok: number;
  llmReasonerInputCostPerMTok: number;
  llmReasonerOutputCostPerMTok: number;

  searchProvider: SearchProviderName;
  braveSearchApiKey: string;
  braveSearchCostPerCall: number;
  searchCacheTtlHours: number;

  emailProvider: EmailProviderName;
  resendApiKey: string;
  resendWebhookSecret: string;
  resendInboundWebhookSecret: string;

  ownerName: string;
  ownerNotificationEmail: string;
  /**
   * The ONLY address the email round-trip canary may contact.
   *
   * Deliberately separate from ownerNotificationEmail so a canary can be run
   * against a mailbox the operator controls and can reply from, without
   * pointing production alerts at it. A canary must never reach a third party,
   * so `npm run canary:email` refuses to run when this is unset.
   */
  ownerTestEmail: string;
  senderCompany: string;
  senderEmail: string;
  senderPostalAddress: string;
  sendingDomain: string;
  allowedOutreachCountries: string[];
  sendingWindowStartHour: number;
  sendingWindowEndHour: number;
  sendingTimezone: string;
  sendingWeekdaysOnly: boolean;

  publicBaseUrl: string;
  adminToken: string;
  cronSecret: string;
  unsubscribeSecret: string;

  monthlyLlmBudgetUsd: number;
  monthlySearchBudgetUsd: number;
  maxEmailsPerDay: number;
  maxNewCampaignsPerWeek: number;

  discoveryCandidatesPerDay: number;
  deepVerificationsPerDay: number;
  maxActiveValidations: number;
  minQualifiedProspects: number;
  preferredQualifiedProspects: number;
  initialEmailBatch: number;
  secondEmailBatch: number;
  maxEmailsPerCampaign: number;
  maxFollowups: number;
  followup1DelayDays: number;
  followup2DelayDays: number;
  maxMvpBuildDays: number;

  gate: {
    minUniqueStrongCommitments: number;
    minUniquePriceAcceptances: number;
    minUniqueActionCommitments: number;
    minDeliveredBeforeStandardEvaluation: number;
    minQualifiedProspects: number;
    minPositiveIntentRate: number;
    requiredCategoryEvidenceConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
    maxMvpBuildDays: number;
    extremeValidation: boolean;
  };

  health: {
    maxHardBounceRate: number;
    maxComplaintRate: number;
    maxUnsubscribeRate: number;
  };

  enablePaymentMethodValidation: boolean;
  stripeSecretKey: string;
  stripePublishableKey: string;

  /**
   * AUTONOMY. Everything here is CONTROL PLANE: typed, env-driven, and with no
   * write path from any LLM. The adaptive strategy plane lives in database
   * rows, never here.
   */
  autoStart: boolean;
  supervisorIntervalMinutes: number;
  replyLatencyTargetMinutes: number;

  concurrency: {
    maxResearchOpportunities: number;
    maxDeepResearchOpportunities: number;
    maxActiveValidations: number;
    maxUnsentProspects: number;
    maxMonthlyExperiments: number;
  };

  learning: {
    /** Share of allocation always reserved for untried hypotheses. */
    explorationRatio: number;
    /** Below this many trials an arm may not be declared a winner. */
    minSampleSize: number;
    minDeliveredForVariantComparison: number;
    /** Downstream reward weights. Opens are absent on purpose. */
    rewardWeights: {
      strongCommitment: number;
      priceAcceptance: number;
      pilotSignup: number;
      strongReply: number;
      qualifiedReply: number;
    };
    failureSimilarityThreshold: number;
  };

  subBudgets: {
    discoveryPct: number;
    researchPct: number;
    prospectingPct: number;
    replyPct: number;
    finalAnalysisPct: number;
  };

  deliverability: {
    /** Per-campaign cumulative ramp. Earned one step at a time. */
    rampSteps: number[];
    /** Domain warm-up: max sends/day by days since first send. */
    warmupSchedule: Array<{ throughDay: number; maxPerDay: number }>;
    pauseCooldownHours: number;
  };

  company: {
    cooldownDays: number;
    negativeReplyCooldownDays: number;
  };

  evidence: {
    pricingTtlHours: number;
    platformCapabilityTtlHours: number;
    prospectTtlHours: number;
  };

  revenueIntent: {
    enabled: boolean;
    minPriceAcceptedReservations: number;
    minDeposits: number;
    minPaymentMethods: number;
    minImmediateInstallRequests: number;
  };

  llmFallbackProvider: LlmProviderName | '';
  llmFastFallback: string;
  llmReasonerFallback: string;

  userAgent: string;
  fetchTimeoutMs: number;
  fetchMaxRetries: number;
  fetchMinDelayMs: number;
  respectRobotsTxt: boolean;
}

function build(): Config {
  const confidence = str('REQUIRED_CATEGORY_EVIDENCE_CONFIDENCE', 'HIGH').toUpperCase();
  if (!['HIGH', 'MEDIUM', 'LOW'].includes(confidence)) {
    throw new ConfigError(`REQUIRED_CATEGORY_EVIDENCE_CONFIDENCE must be HIGH|MEDIUM|LOW`);
  }
  return {
    autonomyEnabled: bool('AUTONOMY_ENABLED', false),
    outreachEnabled: bool('OUTREACH_ENABLED', false),
    killSwitch: bool('KILL_SWITCH', false),

    databaseUrl: str('DATABASE_URL'),
    databaseMode: (str('DATABASE_MODE', 'auto') as DatabaseMode),
    pgliteDataDir: str('PGLITE_DATA_DIR', '.pgdata'),

    llmProvider: (str('LLM_PROVIDER', 'anthropic') as LlmProviderName),
    anthropicApiKey: str('ANTHROPIC_API_KEY'),
    llmFast: str('LLM_FAST', 'claude-haiku-4-5'),
    llmReasoner: str('LLM_REASONER', 'claude-sonnet-5'),
    llmFastInputCostPerMTok: num('LLM_FAST_INPUT_COST_PER_MTOK', 1.0),
    llmFastOutputCostPerMTok: num('LLM_FAST_OUTPUT_COST_PER_MTOK', 5.0),
    llmReasonerInputCostPerMTok: num('LLM_REASONER_INPUT_COST_PER_MTOK', 2.0),
    llmReasonerOutputCostPerMTok: num('LLM_REASONER_OUTPUT_COST_PER_MTOK', 10.0),

    searchProvider: (str('SEARCH_PROVIDER', 'brave') as SearchProviderName),
    braveSearchApiKey: str('BRAVE_SEARCH_API_KEY'),
    braveSearchCostPerCall: num('BRAVE_SEARCH_COST_PER_CALL_USD', 0.005),
    searchCacheTtlHours: num('SEARCH_CACHE_TTL_HOURS', 168),

    emailProvider: (str('EMAIL_PROVIDER', 'resend') as EmailProviderName),
    resendApiKey: str('RESEND_API_KEY'),
    resendWebhookSecret: str('RESEND_WEBHOOK_SECRET'),
    resendInboundWebhookSecret: str('RESEND_INBOUND_WEBHOOK_SECRET') || str('RESEND_WEBHOOK_SECRET'),

    ownerName: str('OWNER_NAME'),
    ownerNotificationEmail: str('OWNER_NOTIFICATION_EMAIL'),
    ownerTestEmail: str('OWNER_TEST_EMAIL'),
    senderCompany: str('SENDER_COMPANY'),
    senderEmail: str('SENDER_EMAIL'),
    senderPostalAddress: str('SENDER_POSTAL_ADDRESS'),
    sendingDomain: str('SENDING_DOMAIN'),
    allowedOutreachCountries: csv('ALLOWED_OUTREACH_COUNTRIES', ['US']),
    sendingWindowStartHour: int('SENDING_WINDOW_START_HOUR', 8),
    sendingWindowEndHour: int('SENDING_WINDOW_END_HOUR', 17),
    sendingTimezone: str('SENDING_TIMEZONE', 'America/New_York'),
    sendingWeekdaysOnly: bool('SENDING_WEEKDAYS_ONLY', true),

    publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
    adminToken: str('ADMIN_TOKEN'),
    cronSecret: str('CRON_SECRET'),
    unsubscribeSecret: str('UNSUBSCRIBE_SECRET'),

    monthlyLlmBudgetUsd: num('MONTHLY_LLM_BUDGET_USD', 20),
    monthlySearchBudgetUsd: num('MONTHLY_SEARCH_BUDGET_USD', 5),
    maxEmailsPerDay: int('MAX_EMAILS_PER_DAY', 75),
    maxNewCampaignsPerWeek: int('MAX_NEW_CAMPAIGNS_PER_WEEK', 3),

    discoveryCandidatesPerDay: int('DISCOVERY_CANDIDATES_PER_DAY', 20),
    deepVerificationsPerDay: int('DEEP_VERIFICATIONS_PER_DAY', 3),
    maxActiveValidations: int('MAX_ACTIVE_VALIDATIONS', 2),
    minQualifiedProspects: int('MIN_QUALIFIED_PROSPECTS', 100),
    preferredQualifiedProspects: int('PREFERRED_QUALIFIED_PROSPECTS', 250),
    initialEmailBatch: int('INITIAL_EMAIL_BATCH', 25),
    secondEmailBatch: int('SECOND_EMAIL_BATCH', 50),
    maxEmailsPerCampaign: int('MAX_EMAILS_PER_CAMPAIGN', 150),
    maxFollowups: int('MAX_FOLLOWUPS', 2),
    followup1DelayDays: int('FOLLOWUP_1_DELAY_DAYS', 4),
    followup2DelayDays: int('FOLLOWUP_2_DELAY_DAYS', 8),
    maxMvpBuildDays: int('MAX_MVP_BUILD_DAYS', 7),

    gate: {
      minUniqueStrongCommitments: int('MIN_UNIQUE_STRONG_COMMITMENTS', 5),
      minUniquePriceAcceptances: int('MIN_UNIQUE_PRICE_ACCEPTANCES', 3),
      minUniqueActionCommitments: int('MIN_UNIQUE_ACTION_COMMITMENTS', 2),
      minDeliveredBeforeStandardEvaluation: int('MIN_DELIVERED_BEFORE_STANDARD_EVALUATION', 75),
      minQualifiedProspects: int('MIN_QUALIFIED_PROSPECTS_FOR_GATE', 100),
      minPositiveIntentRate: num('MIN_POSITIVE_INTENT_RATE', 0.04),
      requiredCategoryEvidenceConfidence: confidence as 'HIGH' | 'MEDIUM' | 'LOW',
      maxMvpBuildDays: int('MAX_MVP_BUILD_DAYS', 7),
      extremeValidation: bool('EXTREME_VALIDATION', false),
    },

    health: {
      maxHardBounceRate: num('MAX_HARD_BOUNCE_RATE', 0.05),
      maxComplaintRate: num('MAX_COMPLAINT_RATE', 0.0),
      maxUnsubscribeRate: num('MAX_UNSUBSCRIBE_RATE', 0.05),
    },

    enablePaymentMethodValidation: bool('ENABLE_PAYMENT_METHOD_VALIDATION', false),
    stripeSecretKey: str('STRIPE_SECRET_KEY'),
    stripePublishableKey: str('STRIPE_PUBLISHABLE_KEY'),

    autoStart: bool('AUTO_START', true),
    supervisorIntervalMinutes: int('SUPERVISOR_INTERVAL_MINUTES', 15),
    replyLatencyTargetMinutes: int('REPLY_LATENCY_TARGET_MINUTES', 15),

    concurrency: {
      maxResearchOpportunities: int('MAX_RESEARCH_OPPORTUNITIES', 10),
      maxDeepResearchOpportunities: int('MAX_DEEP_RESEARCH_OPPORTUNITIES', 3),
      maxActiveValidations: int('MAX_ACTIVE_VALIDATIONS', 2),
      maxUnsentProspects: int('MAX_UNSENT_PROSPECTS', 600),
      maxMonthlyExperiments: int('MAX_MONTHLY_EXPERIMENTS', 8),
    },

    learning: {
      explorationRatio: clamp01(num('EXPLORATION_RATIO', 0.25)),
      minSampleSize: int('MIN_SAMPLE_SIZE', 30),
      minDeliveredForVariantComparison: int('MIN_DELIVERED_FOR_VARIANT_COMPARISON', 40),
      rewardWeights: {
        strongCommitment: num('REWARD_STRONG_COMMITMENT', 1.0),
        priceAcceptance: num('REWARD_PRICE_ACCEPTANCE', 0.8),
        pilotSignup: num('REWARD_PILOT_SIGNUP', 0.7),
        strongReply: num('REWARD_STRONG_REPLY', 0.3),
        qualifiedReply: num('REWARD_QUALIFIED_REPLY', 0.1),
      },
      failureSimilarityThreshold: clamp01(num('FAILURE_SIMILARITY_THRESHOLD', 0.8)),
    },

    subBudgets: {
      discoveryPct: clamp01(num('BUDGET_DISCOVERY_PCT', 0.15)),
      researchPct: clamp01(num('BUDGET_RESEARCH_PCT', 0.3)),
      prospectingPct: clamp01(num('BUDGET_PROSPECTING_PCT', 0.25)),
      replyPct: clamp01(num('BUDGET_REPLY_PCT', 0.2)),
      finalAnalysisPct: clamp01(num('BUDGET_FINAL_ANALYSIS_PCT', 0.1)),
    },

    deliverability: {
      rampSteps: intList('CAMPAIGN_RAMP_STEPS', [10, 25, 50, 75]),
      warmupSchedule: parseWarmup(str('DOMAIN_WARMUP_SCHEDULE', '2:10,4:20,7:35')),
      pauseCooldownHours: int('DELIVERABILITY_PAUSE_COOLDOWN_HOURS', 24),
    },

    company: {
      cooldownDays: int('COMPANY_COOLDOWN_DAYS', 90),
      negativeReplyCooldownDays: int('NEGATIVE_REPLY_COOLDOWN_DAYS', 365),
    },

    evidence: {
      pricingTtlHours: int('EVIDENCE_PRICING_TTL_HOURS', 336),
      platformCapabilityTtlHours: int('EVIDENCE_PLATFORM_TTL_HOURS', 720),
      prospectTtlHours: int('EVIDENCE_PROSPECT_TTL_HOURS', 720),
    },

    revenueIntent: {
      enabled: bool('ENABLE_PAID_VALIDATION', false),
      minPriceAcceptedReservations: int('REVENUE_INTENT_MIN_RESERVATIONS', 5),
      minDeposits: int('REVENUE_INTENT_MIN_DEPOSITS', 1),
      minPaymentMethods: int('REVENUE_INTENT_MIN_PAYMENT_METHODS', 3),
      minImmediateInstallRequests: int('REVENUE_INTENT_MIN_INSTALL_REQUESTS', 3),
    },

    llmFallbackProvider: (str('LLM_FALLBACK_PROVIDER') as LlmProviderName | ''),
    llmFastFallback: str('LLM_FAST_FALLBACK'),
    llmReasonerFallback: str('LLM_REASONER_FALLBACK'),

    userAgent: str('USER_AGENT', 'MRRValidatorBot/0.1 (+https://example.com/bot; research crawler)'),
    fetchTimeoutMs: int('FETCH_TIMEOUT_MS', 15_000),
    fetchMaxRetries: int('FETCH_MAX_RETRIES', 3),
    fetchMinDelayMs: int('FETCH_MIN_DELAY_MS', 1200),
    respectRobotsTxt: bool('RESPECT_ROBOTS_TXT', true),
  };
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (!cached) cached = build();
  return cached;
}

/** Tests mutate process.env then call this. */
export function resetConfigCache(): void {
  cached = null;
}

/** True when nothing may be sent to the outside world. */
export function isShadowMode(cfg: Config = getConfig()): boolean {
  return !cfg.autonomyEnabled || !cfg.outreachEnabled || cfg.killSwitch;
}

/**
 * The single authority on whether a real outbound email may leave the system.
 * Deliberately conservative: every condition must hold.
 */
export function canSendRealEmail(cfg: Config = getConfig()): { ok: boolean; reason?: string } {
  if (cfg.killSwitch) return { ok: false, reason: 'KILL_SWITCH is on' };
  if (!cfg.autonomyEnabled) return { ok: false, reason: 'AUTONOMY_ENABLED is false (shadow mode)' };
  if (!cfg.outreachEnabled) return { ok: false, reason: 'OUTREACH_ENABLED is false' };
  if (cfg.emailProvider === 'mock') return { ok: false, reason: 'EMAIL_PROVIDER is mock' };
  if (!cfg.resendApiKey) return { ok: false, reason: 'RESEND_API_KEY is not set' };
  if (!cfg.senderEmail) return { ok: false, reason: 'SENDER_EMAIL is not set' };
  if (!cfg.senderCompany) return { ok: false, reason: 'SENDER_COMPANY is not set' };
  if (!cfg.senderPostalAddress) return { ok: false, reason: 'SENDER_POSTAL_ADDRESS is not set (legally required)' };
  if (!cfg.sendingDomain) return { ok: false, reason: 'SENDING_DOMAIN is not set' };
  if (!cfg.unsubscribeSecret) return { ok: false, reason: 'UNSUBSCRIBE_SECRET is not set (opt-out links cannot be signed)' };
  if (!cfg.publicBaseUrl.startsWith('https://')) {
    return { ok: false, reason: 'PUBLIC_BASE_URL must be https for unsubscribe links' };
  }
  return { ok: true };
}
