-- ============================================================================
-- MRR Validator — autonomy, learning and safety schema
--
-- Everything the adaptive strategy plane is allowed to write lives here.
-- The immutable control plane (gate thresholds, cost ceilings, suppression,
-- compliance) stays in typed code and env and has NO table in this file.
-- ============================================================================

-- --- runtime -----------------------------------------------------------------

-- Single-row table. The id CHECK is what makes it a singleton.
CREATE TABLE IF NOT EXISTS runtime_state (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state         TEXT NOT NULL DEFAULT 'BOOTING',
  -- BOOTING | SELF_TESTING | SHADOW_VERIFYING | RUNNING | DEGRADED
  -- | PAUSED_BUDGET | PAUSED_DELIVERABILITY | BLOCKED_CONFIGURATION | EMERGENCY_STOP
  reason        TEXT,
  blocking_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  entered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail_json   JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS subsystem_health (
  subsystem       TEXT PRIMARY KEY,
  -- database | search | llm | email_out | email_in | scheduler | supervisor
  -- | discovery | research | prospecting | campaigns | webhook
  status          TEXT NOT NULL DEFAULT 'UNKNOWN',   -- OK | DEGRADED | FAILING | UNKNOWN
  last_ok_at      TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_error      TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  detail_json     JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- --- durable work queue with dead-letter -------------------------------------

CREATE TABLE IF NOT EXISTS work_queue (
  id                TEXT PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind              TEXT NOT NULL,
  payload_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Supervisor priority: 1 = protect live conversations ... 7 = exploration.
  priority          INTEGER NOT NULL DEFAULT 5,
  status            TEXT NOT NULL DEFAULT 'PENDING',
  -- PENDING | RUNNING | DONE | FAILED | DEAD_LETTER | CANCELLED
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  next_retry_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error        TEXT,
  dead_letter_reason TEXT,
  locked_by         TEXT,
  locked_until      TIMESTAMPTZ,
  -- Idempotency: the same logical unit of work is never queued twice.
  idempotency_key   TEXT UNIQUE,
  opportunity_id    TEXT REFERENCES opportunities(id) ON DELETE CASCADE,
  completed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_work_queue_claim ON work_queue(status, priority, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_work_queue_kind ON work_queue(kind, status);
CREATE INDEX IF NOT EXISTS idx_work_queue_dead ON work_queue(status) WHERE status = 'DEAD_LETTER';

-- --- strategy memory ---------------------------------------------------------

-- A hypothesis is a proposal. It is not acted on until it passes the
-- deterministic eligibility gate and is given a version.
CREATE TABLE IF NOT EXISTS strategy_hypotheses (
  id                TEXT PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  dimension         TEXT NOT NULL,
  -- RESEARCH_SOURCE | CATEGORY_FAMILY | ICP_SEGMENT | POSITIONING
  -- | PRICE_POINT | MESSAGE_VARIANT | CONTACT_ROLE | SEND_TIME | QUERY_FAMILY
  proposal_json     JSONB NOT NULL,
  hypothesis        TEXT NOT NULL,
  reason            TEXT NOT NULL,
  expected_benefit  TEXT NOT NULL,
  experiment_scope  TEXT NOT NULL,
  proposed_by       TEXT NOT NULL,      -- 'llm:<prompt_id>@<version>' or 'seed' or 'code'
  status            TEXT NOT NULL DEFAULT 'PROPOSED',
  -- PROPOSED | REJECTED | ADMITTED | RETIRED
  rejection_reason  TEXT,
  similarity_to     TEXT,               -- failure_memory.id this duplicates, if rejected
  content_key       TEXT UNIQUE,        -- normalized dedupe key
  admitted_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hypotheses_dim ON strategy_hypotheses(dimension, status);

-- An immutable append-only history. A "change" is always a new row.
CREATE TABLE IF NOT EXISTS strategy_versions (
  id              TEXT PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  dimension       TEXT NOT NULL,
  arm_key         TEXT NOT NULL,        -- the bandit arm this version defines
  version         INTEGER NOT NULL,
  config_json     JSONB NOT NULL,
  hypothesis_id   TEXT REFERENCES strategy_hypotheses(id) ON DELETE SET NULL,
  previous_version_id TEXT REFERENCES strategy_versions(id) ON DELETE SET NULL,
  reason          TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT true,
  retired_at      TIMESTAMPTZ,
  UNIQUE (dimension, arm_key, version)
);
CREATE INDEX IF NOT EXISTS idx_strategy_versions_active ON strategy_versions(dimension, active);

-- One row per completed experiment. The full input strategy AND the measured
-- results, so learning never depends on remembering what was tried.
CREATE TABLE IF NOT EXISTS strategy_outcomes (
  id                     TEXT PRIMARY KEY,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  opportunity_id         TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  campaign_id            TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  -- INPUT STRATEGY (denormalized on purpose: outcomes must survive strategy edits)
  ecosystem              TEXT,
  category               TEXT,
  problem_type           TEXT,
  icp                    TEXT,
  source                 TEXT,
  query_family           TEXT,
  competitor_profile     TEXT,
  wedge_type             TEXT,
  price_monthly          NUMERIC(10,2),
  value_proposition      TEXT,
  email_variant          TEXT,
  landing_variant        TEXT,
  contact_role_strategy  TEXT,
  send_time_bucket       TEXT,
  followup_strategy      TEXT,
  strategy_version_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- RESULTS
  qualified_prospects    INTEGER NOT NULL DEFAULT 0,
  delivered              INTEGER NOT NULL DEFAULT 0,
  delivery_rate          NUMERIC(6,4),
  bounce_rate            NUMERIC(6,4),
  reply_rate             NUMERIC(6,4),
  negative_rate          NUMERIC(6,4),
  strong_interest        INTEGER NOT NULL DEFAULT 0,
  price_acceptances      INTEGER NOT NULL DEFAULT 0,
  pilot_signups          INTEGER NOT NULL DEFAULT 0,
  install_requests       INTEGER NOT NULL DEFAULT 0,
  onboarding_details     INTEGER NOT NULL DEFAULT 0,
  payment_events         INTEGER NOT NULL DEFAULT 0,
  time_to_first_interest_hours    NUMERIC(10,2),
  time_to_first_commitment_hours  NUMERIC(10,2),
  final_result           TEXT NOT NULL,   -- VALIDATED | FAILED | ABANDONED | RUNNING
  failure_reason         TEXT,
  reward                 NUMERIC(8,5) NOT NULL DEFAULT 0  -- computed downstream reward, 0..1
);
CREATE INDEX IF NOT EXISTS idx_outcomes_campaign ON strategy_outcomes(campaign_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_result ON strategy_outcomes(final_result);

-- Beta-Bernoulli posteriors. One row per (dimension, arm).
CREATE TABLE IF NOT EXISTS bandit_arms (
  id            TEXT PRIMARY KEY,
  dimension     TEXT NOT NULL,
  arm_key       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Beta(alpha, beta). Priors start at 1,1 (uniform) so nothing is assumed.
  alpha         NUMERIC(12,4) NOT NULL DEFAULT 1,
  beta          NUMERIC(12,4) NOT NULL DEFAULT 1,
  trials        INTEGER NOT NULL DEFAULT 0,
  successes     NUMERIC(12,4) NOT NULL DEFAULT 0,
  total_reward  NUMERIC(12,4) NOT NULL DEFAULT 0,
  last_selected_at TIMESTAMPTZ,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  detail_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (dimension, arm_key)
);
CREATE INDEX IF NOT EXISTS idx_bandit_dim ON bandit_arms(dimension, enabled);

-- --- failure and success memory ----------------------------------------------

CREATE TABLE IF NOT EXISTS failure_memory (
  id              TEXT PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  opportunity_id  TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  ecosystem       TEXT,
  category        TEXT NOT NULL,
  icp             TEXT,
  wedge           TEXT,
  wedge_type      TEXT,
  price_monthly   NUMERIC(10,2),
  reason_failed   TEXT NOT NULL,
  sample_size     INTEGER NOT NULL DEFAULT 0,
  campaign_evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Token set used for cheap structural similarity, so a near-identical idea
  -- is rejected before spending anything on it.
  similarity_tokens JSONB NOT NULL DEFAULT '[]'::jsonb,
  lesson          TEXT,
  avoid_category  BOOLEAN NOT NULL DEFAULT false,
  retry_allowed_if TEXT
);
CREATE INDEX IF NOT EXISTS idx_failure_category ON failure_memory(category);
CREATE INDEX IF NOT EXISTS idx_failure_avoid ON failure_memory(avoid_category) WHERE avoid_category;

CREATE TABLE IF NOT EXISTS success_patterns (
  id              TEXT PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  opportunity_id  TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  ecosystem       TEXT,
  category        TEXT,
  icp             TEXT,
  wedge_type      TEXT,
  price_monthly   NUMERIC(10,2),
  contact_role    TEXT,
  source          TEXT,
  pattern_tokens  JSONB NOT NULL DEFAULT '[]'::jsonb,
  commitment_rate NUMERIC(6,4),
  evidence_json   JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- --- sources and queries ------------------------------------------------------

CREATE TABLE IF NOT EXISTS source_registry (
  id             TEXT PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  name           TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,       -- MARKETPLACE | SEARCH | MERCHANT_SITE | REVIEW_SITE | COMMUNITY | OTHER
  base_url       TEXT,
  ecosystem      TEXT,
  status         TEXT NOT NULL DEFAULT 'UNVERIFIED',  -- UNVERIFIED | VERIFIED | REJECTED | DISABLED
  -- 0..1. Primary commercial evidence outranks scraped SEO pages, always.
  trust_level    NUMERIC(4,3) NOT NULL DEFAULT 0.3,
  structured     BOOLEAN NOT NULL DEFAULT false,
  cost_per_call  NUMERIC(10,6) NOT NULL DEFAULT 0,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  last_success_at TIMESTAMPTZ,
  last_error     TEXT,
  evaluation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS source_performance (
  id                TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL REFERENCES source_registry(id) ON DELETE CASCADE,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetches           INTEGER NOT NULL DEFAULT 0,
  failures          INTEGER NOT NULL DEFAULT 0,
  candidates_found  INTEGER NOT NULL DEFAULT 0,
  categories_verified INTEGER NOT NULL DEFAULT 0,
  campaigns_started INTEGER NOT NULL DEFAULT 0,
  commitments       INTEGER NOT NULL DEFAULT 0,
  spend_usd         NUMERIC(12,6) NOT NULL DEFAULT 0,
  yield_score       NUMERIC(8,5) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_source_perf ON source_performance(source_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS research_query_families (
  id              TEXT PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  family          TEXT NOT NULL UNIQUE,
  ecosystem       TEXT,
  template        TEXT NOT NULL,
  seeds_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
  derived_from    TEXT REFERENCES research_query_families(id) ON DELETE SET NULL,
  generation      INTEGER NOT NULL DEFAULT 0,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  queries_issued  INTEGER NOT NULL DEFAULT 0,
  candidates_found INTEGER NOT NULL DEFAULT 0,
  categories_verified INTEGER NOT NULL DEFAULT 0,
  commitments     INTEGER NOT NULL DEFAULT 0,
  junk_rate       NUMERIC(6,4) NOT NULL DEFAULT 0,
  score           NUMERIC(8,5) NOT NULL DEFAULT 0
);

-- --- segment / variant / pricing performance ---------------------------------

CREATE TABLE IF NOT EXISTS segment_performance (
  id              TEXT PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  segment_key     TEXT NOT NULL UNIQUE,   -- ecosystem|category|icp
  ecosystem       TEXT,
  category        TEXT,
  icp             TEXT,
  prospects       INTEGER NOT NULL DEFAULT 0,
  delivered       INTEGER NOT NULL DEFAULT 0,
  replies         INTEGER NOT NULL DEFAULT 0,
  commitments     INTEGER NOT NULL DEFAULT 0,
  price_acceptances INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_variants (
  id             TEXT PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  variant_key    TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,    -- INITIAL | FOLLOWUP_1 | FOLLOWUP_2 | LANDING | SUBJECT
  strategy_version_id TEXT REFERENCES strategy_versions(id) ON DELETE SET NULL,
  config_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent           INTEGER NOT NULL DEFAULT 0,
  delivered      INTEGER NOT NULL DEFAULT 0,
  replies        INTEGER NOT NULL DEFAULT 0,
  positive       INTEGER NOT NULL DEFAULT 0,
  commitments    INTEGER NOT NULL DEFAULT 0,
  enabled        BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS pricing_experiments (
  id               TEXT PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  opportunity_id   TEXT REFERENCES opportunities(id) ON DELETE CASCADE,
  campaign_id      TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
  price_monthly    NUMERIC(10,2) NOT NULL,
  assigned         INTEGER NOT NULL DEFAULT 0,
  delivered        INTEGER NOT NULL DEFAULT 0,
  commitments      INTEGER NOT NULL DEFAULT 0,
  price_acceptances INTEGER NOT NULL DEFAULT 0,
  -- The decision metric: expected MRR per 100 qualified prospects, NOT
  -- conversion rate. $9 x 12 can lose to $29 x 7.
  expected_mrr_per_100 NUMERIC(12,4) NOT NULL DEFAULT 0,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (campaign_id, price_monthly)
);

-- A prospect's price is assigned once and never changes mid-thread.
CREATE TABLE IF NOT EXISTS price_assignments (
  id             TEXT PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  campaign_id    TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  prospect_id    TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  price_monthly  NUMERIC(10,2) NOT NULL,
  experiment_id  TEXT REFERENCES pricing_experiments(id) ON DELETE SET NULL,
  UNIQUE (campaign_id, prospect_id)
);

CREATE TABLE IF NOT EXISTS contact_role_performance (
  id             TEXT PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  role_key       TEXT NOT NULL,     -- wholesale | sales | hello | support | founder | ...
  icp            TEXT,
  opportunity_class TEXT,
  sent           INTEGER NOT NULL DEFAULT 0,
  delivered      INTEGER NOT NULL DEFAULT 0,
  bounced        INTEGER NOT NULL DEFAULT 0,
  replies        INTEGER NOT NULL DEFAULT 0,
  commitments    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (role_key, icp, opportunity_class)
);

-- --- company identity and fatigue --------------------------------------------

-- One row per real business, across every campaign and every experiment.
CREATE TABLE IF NOT EXISTS company_registry (
  id                  TEXT PRIMARY KEY,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_key         TEXT NOT NULL UNIQUE,   -- normalized registrable domain
  display_name        TEXT,
  merged_into         TEXT REFERENCES company_registry(id) ON DELETE SET NULL,
  alt_domains_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_contacted_at   TIMESTAMPTZ,
  last_campaign_id    TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  total_campaigns     INTEGER NOT NULL DEFAULT 0,
  total_emails        INTEGER NOT NULL DEFAULT 0,
  -- Fatigue state. NEVER_CONTACT is terminal and is set by unsubscribe or
  -- an explicit stop; nothing may clear it.
  contact_state       TEXT NOT NULL DEFAULT 'AVAILABLE',
  -- AVAILABLE | COOLDOWN | ENGAGED | NEVER_CONTACT
  cooldown_until      TIMESTAMPTZ,
  cooldown_reason     TEXT,
  engaged_campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  data_quality        TEXT NOT NULL DEFAULT 'MEDIUM',  -- HIGH | MEDIUM | LOW
  is_internal_or_test BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_company_state ON company_registry(contact_state, cooldown_until);

-- --- objections ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS objections (
  id             TEXT PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  campaign_id    TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
  opportunity_id TEXT REFERENCES opportunities(id) ON DELETE CASCADE,
  prospect_id    TEXT REFERENCES prospects(id) ON DELETE SET NULL,
  message_id     TEXT REFERENCES messages(id) ON DELETE SET NULL,
  company_key    TEXT,
  kind           TEXT NOT NULL,
  -- TOO_EXPENSIVE | HAPPY_WITH_COMPETITOR | MISSING_FEATURE | TRUST
  -- | NO_NEED | TIMING | PLATFORM_INCOMPATIBLE | WRONG_CONTACT
  -- | PRIVACY_SECURITY | OTHER
  detail         TEXT,
  evidence_text  TEXT,
  UNIQUE (message_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_objections_opportunity ON objections(opportunity_id, kind);

-- --- conversation state -------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversations (
  id                 TEXT PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  campaign_id        TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  prospect_id        TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  thread_id          TEXT,
  commitment_level   TEXT NOT NULL DEFAULT 'NONE',
  -- NONE | CURIOUS | INTERESTED | PRICE_DISCUSSED | COMMITTED | DECLINED
  answered_json      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- question keys already answered
  asked_json         JSONB NOT NULL DEFAULT '[]'::jsonb,
  requested_features_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  objections_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
  price_quoted       NUMERIC(10,2),
  awaiting_reply     BOOLEAN NOT NULL DEFAULT false,
  last_inbound_at    TIMESTAMPTZ,
  last_outbound_at   TIMESTAMPTZ,
  UNIQUE (campaign_id, prospect_id)
);

-- --- prompts, calibration, provenance ----------------------------------------

CREATE TABLE IF NOT EXISTS prompt_versions (
  id            TEXT PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt_id     TEXT NOT NULL,
  version       INTEGER NOT NULL,
  tier          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  system_excerpt TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (prompt_id, version)
);

CREATE TABLE IF NOT EXISTS calibration_runs (
  id             TEXT PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt_id      TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  model          TEXT NOT NULL,
  fixtures_total INTEGER NOT NULL DEFAULT 0,
  fixtures_passed INTEGER NOT NULL DEFAULT 0,
  accuracy       NUMERIC(6,4) NOT NULL DEFAULT 0,
  baseline_accuracy NUMERIC(6,4),
  regressed      BOOLEAN NOT NULL DEFAULT false,
  detail_json    JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Provenance for every material factual claim. A claim with no row here may
-- not appear in an owner notification or a build spec.
CREATE TABLE IF NOT EXISTS evidence_claims (
  id                TEXT PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  opportunity_id    TEXT REFERENCES opportunities(id) ON DELETE CASCADE,
  claim_type        TEXT NOT NULL,
  -- COMPETITOR_PRICING | MERCHANT_BEHAVIOUR | CUSTOMER_COMPLAINT
  -- | PLATFORM_CAPABILITY | PROSPECT_IDENTITY | COMMITMENT
  claim_text        TEXT NOT NULL,
  source_url        TEXT,
  source_document_id TEXT REFERENCES source_documents(id) ON DELETE SET NULL,
  fetched_at        TIMESTAMPTZ,
  content_hash      TEXT,
  evidence_excerpt  TEXT,
  extraction_model  TEXT,
  prompt_version    INTEGER,
  confidence        NUMERIC(4,3),
  -- Evidence goes stale. Anything past this must be refreshed before it can
  -- support a build recommendation.
  expires_at        TIMESTAMPTZ,
  superseded_by     TEXT REFERENCES evidence_claims(id) ON DELETE SET NULL,
  inferred          BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_claims_opportunity ON evidence_claims(opportunity_id, claim_type);
CREATE INDEX IF NOT EXISTS idx_claims_expiry ON evidence_claims(expires_at);

-- --- per-phase spend ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS phase_spend (
  id             TEXT PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  period         TEXT NOT NULL,        -- YYYY-MM
  phase          TEXT NOT NULL,        -- DISCOVERY | RESEARCH | PROSPECTING | REPLY | FINAL_ANALYSIS
  opportunity_id TEXT REFERENCES opportunities(id) ON DELETE CASCADE,
  spend_usd      NUMERIC(12,6) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_phase_spend ON phase_spend(period, phase);
CREATE INDEX IF NOT EXISTS idx_phase_spend_opp ON phase_spend(opportunity_id);

-- --- additive columns on existing tables --------------------------------------

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS research_stage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS research_spend_usd NUMERIC(12,6) NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS prospecting_spend_usd NUMERIC(12,6) NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS validation_spend_usd NUMERIC(12,6) NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS expected_information_value NUMERIC(8,5) NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS rank_score NUMERIC(8,5) NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS validation_level TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS source_id TEXT REFERENCES source_registry(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS query_family_id TEXT REFERENCES research_query_families(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS feasibility_checked_at TIMESTAMPTZ;

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES company_registry(id) ON DELETE SET NULL;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS data_quality TEXT NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS contact_role TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS evidence_fetched_at TIMESTAMPTZ;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS rechecked_at TIMESTAMPTZ;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ramp_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS message_variant_id TEXT REFERENCES message_variants(id) ON DELETE SET NULL;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS strategy_version_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS variant_key TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS prompt_version INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS send_time_bucket TEXT;

ALTER TABLE cost_ledger ADD COLUMN IF NOT EXISTS phase TEXT;
ALTER TABLE cost_ledger ADD COLUMN IF NOT EXISTS opportunity_id TEXT;
ALTER TABLE cost_ledger ADD COLUMN IF NOT EXISTS prompt_id TEXT;
ALTER TABLE cost_ledger ADD COLUMN IF NOT EXISTS prompt_version INTEGER;
CREATE INDEX IF NOT EXISTS idx_cost_phase ON cost_ledger(phase, created_at);

-- Domain-level sending warm-up. One row; the ledger of what the domain has
-- earned the right to send.
CREATE TABLE IF NOT EXISTS sending_reputation (
  id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  domain            TEXT,
  first_send_at     TIMESTAMPTZ,
  warmup_day        INTEGER NOT NULL DEFAULT 0,
  paused_until      TIMESTAMPTZ,
  pause_reason      TEXT,
  hard_bounce_rate  NUMERIC(6,4) NOT NULL DEFAULT 0,
  complaint_rate    NUMERIC(6,4) NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
