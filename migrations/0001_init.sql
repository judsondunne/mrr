-- ============================================================================
-- MRR Validator — initial schema
-- Plain Postgres. Runs identically on Supabase and on local PGlite.
-- ============================================================================

CREATE TABLE IF NOT EXISTS opportunities (
  id                      TEXT PRIMARY KEY,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  name                    TEXT NOT NULL,
  ecosystem               TEXT NOT NULL,
  category                TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  source_url              TEXT,
  state                   TEXT NOT NULL,
  proposed_wedge          TEXT,
  target_customer         TEXT,
  proposed_price_monthly  NUMERIC(10,2),
  estimated_build_days    INTEGER,
  evidence_confidence     TEXT,                   -- HIGH | MEDIUM | LOW | NONE
  prospectability_score   NUMERIC(6,3),
  validation_score        NUMERIC(6,3),
  rejection_reason        TEXT,
  next_action_at          TIMESTAMPTZ,
  wedge_json              JSONB,                  -- full structured wedge
  dedupe_key              TEXT UNIQUE             -- ecosystem+category slug; blocks dupes
);
CREATE INDEX IF NOT EXISTS idx_opportunities_state ON opportunities(state);
CREATE INDEX IF NOT EXISTS idx_opportunities_next_action ON opportunities(next_action_at);

CREATE TABLE IF NOT EXISTS competitors (
  id                    TEXT PRIMARY KEY,
  opportunity_id        TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  name                  TEXT NOT NULL,
  url                   TEXT NOT NULL,
  current_pricing       TEXT,
  free_plan_details     TEXT,
  has_permanent_free_tier BOOLEAN,
  review_count          INTEGER,
  rating                NUMERIC(3,2),
  launch_age            TEXT,
  evidence_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  payment_evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (opportunity_id, url)
);
CREATE INDEX IF NOT EXISTS idx_competitors_opportunity ON competitors(opportunity_id);

CREATE TABLE IF NOT EXISTS source_documents (
  id             TEXT PRIMARY KEY,
  opportunity_id TEXT REFERENCES opportunities(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  source_type    TEXT NOT NULL,           -- APP_LISTING | PRICING_PAGE | REVIEWS | SEARCH_RESULT | MERCHANT_SITE | COMMUNITY
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash   TEXT NOT NULL,
  extracted_text TEXT NOT NULL DEFAULT '',
  metadata_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  http_status    INTEGER,
  UNIQUE (url, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_source_documents_opportunity ON source_documents(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_source_documents_hash ON source_documents(content_hash);

CREATE TABLE IF NOT EXISTS reviews (
  id                       TEXT PRIMARY KEY,
  competitor_id            TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_url               TEXT NOT NULL,
  rating                   INTEGER,
  review_date              DATE,
  merchant_name            TEXT,
  merchant_domain_if_public TEXT,
  usage_duration           TEXT,
  text                     TEXT NOT NULL DEFAULT '',
  payment_signal           TEXT,                       -- PAID_PLAN_REFERENCED | EXCEEDS_FREE_TIER | NONE
  complaint_tags           JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_hash             TEXT NOT NULL,
  UNIQUE (competitor_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_reviews_competitor ON reviews(competitor_id);
CREATE INDEX IF NOT EXISTS idx_reviews_payment_signal ON reviews(payment_signal);

CREATE TABLE IF NOT EXISTS complaint_clusters (
  id                        TEXT PRIMARY KEY,
  opportunity_id            TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  name                      TEXT NOT NULL,
  description               TEXT NOT NULL DEFAULT '',
  count                     INTEGER NOT NULL DEFAULT 0,
  evidence_review_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
  severity                  TEXT NOT NULL DEFAULT 'MEDIUM',   -- LOW | MEDIUM | HIGH
  proposed_wedge_relevance  TEXT
);
CREATE INDEX IF NOT EXISTS idx_complaint_clusters_opportunity ON complaint_clusters(opportunity_id);

CREATE TABLE IF NOT EXISTS prospects (
  id                    TEXT PRIMARY KEY,
  opportunity_id        TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_name          TEXT NOT NULL,
  domain                TEXT NOT NULL,
  ecosystem             TEXT NOT NULL,
  public_evidence_url   TEXT,
  qualification_reason  TEXT,
  qualification_score   NUMERIC(6,3),
  contact_name_if_public TEXT,
  contact_email         TEXT,
  contact_source_url    TEXT,
  email_is_public       BOOLEAN NOT NULL DEFAULT false,
  country               TEXT,
  status                TEXT NOT NULL DEFAULT 'DISCOVERED',
     -- DISCOVERED | QUALIFYING | QUALIFIED | DISQUALIFIED | CONTACTED | REPLIED | COMMITTED | SUPPRESSED | BOUNCED
  suppressed_at         TIMESTAMPTZ,
  evidence_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (opportunity_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_prospects_opportunity_status ON prospects(opportunity_id, status);
CREATE INDEX IF NOT EXISTS idx_prospects_email ON prospects(contact_email);
CREATE INDEX IF NOT EXISTS idx_prospects_domain ON prospects(domain);

CREATE TABLE IF NOT EXISTS campaigns (
  id                  TEXT PRIMARY KEY,
  opportunity_id      TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  state               TEXT NOT NULL DEFAULT 'DRAFT',
     -- DRAFT | READY | BATCH_1 | BATCH_1_REVIEW | BATCH_2 | BATCH_2_REVIEW | SCALING | COMPLETE | HALTED | FAILED
  offer_name          TEXT NOT NULL,
  price_monthly       NUMERIC(10,2) NOT NULL,
  landing_slug        TEXT NOT NULL UNIQUE,
  landing_copy_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at          TIMESTAMPTZ,
  ended_at            TIMESTAMPTZ,
  target_count        INTEGER NOT NULL DEFAULT 0,
  variant_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  halt_reason         TEXT
);
CREATE INDEX IF NOT EXISTS idx_campaigns_opportunity ON campaigns(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_state ON campaigns(state);

CREATE TABLE IF NOT EXISTS messages (
  id                        TEXT PRIMARY KEY,
  campaign_id               TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
  prospect_id               TEXT REFERENCES prospects(id) ON DELETE CASCADE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  direction                 TEXT NOT NULL,          -- OUTBOUND | INBOUND
  sequence_step             INTEGER NOT NULL DEFAULT 0,  -- 0 initial, 1 followup1, 2 followup2, -1 reply/auto-reply
  provider_message_id       TEXT,
  thread_id                 TEXT,
  subject                   TEXT NOT NULL DEFAULT '',
  body                      TEXT NOT NULL DEFAULT '',
  sent_at                   TIMESTAMPTZ,
  received_at               TIMESTAMPTZ,
  delivered_at              TIMESTAMPTZ,
  bounced_at                TIMESTAMPTZ,
  complained_at             TIMESTAMPTZ,
  opened_at                 TIMESTAMPTZ,            -- recorded, NEVER used as validation
  clicked_at                TIMESTAMPTZ,
  bounce_type               TEXT,                   -- HARD | SOFT
  classification            TEXT,
  intent_score              NUMERIC(6,3),
  requires_human            BOOLEAN NOT NULL DEFAULT false,
  status                    TEXT NOT NULL DEFAULT 'PENDING',
     -- PENDING | DRAFTED | SENDING | SENT | DELIVERED | BOUNCED | COMPLAINED | FAILED | RECEIVED
  idempotency_key           TEXT UNIQUE,
  raw_provider_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  extraction_json           JSONB NOT NULL DEFAULT '{}'::jsonb,
  error                     TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_campaign ON messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_messages_prospect ON messages(prospect_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
CREATE INDEX IF NOT EXISTS idx_messages_provider_id ON messages(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

CREATE TABLE IF NOT EXISTS commitments (
  id             TEXT PRIMARY KEY,
  campaign_id    TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  prospect_id    TEXT REFERENCES prospects(id) ON DELETE SET NULL,
  company_key    TEXT NOT NULL,          -- normalized domain; the unit of "unique company"
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  type           TEXT NOT NULL,
     -- EXPLICIT_PRICE_ACCEPTANCE | PILOT_SIGNUP | INSTALL_REQUEST | TRIAL_REQUEST
     -- | ONBOARDING_DETAILS | PAYMENT_METHOD_ADDED | DEPOSIT | OTHER_STRONG_INTENT
  price_monthly  NUMERIC(10,2),
  source         TEXT NOT NULL,          -- EMAIL_REPLY | LANDING_FORM | STRIPE | MANUAL
  evidence_text  TEXT NOT NULL DEFAULT '',
  evidence_url   TEXT,
  message_id     TEXT REFERENCES messages(id) ON DELETE SET NULL,
  verified       BOOLEAN NOT NULL DEFAULT false,
  dedupe_key     TEXT UNIQUE             -- campaign+company+type; one per company per type
);
CREATE INDEX IF NOT EXISTS idx_commitments_campaign ON commitments(campaign_id);
CREATE INDEX IF NOT EXISTS idx_commitments_type ON commitments(type);
CREATE INDEX IF NOT EXISTS idx_commitments_company ON commitments(company_key);

CREATE TABLE IF NOT EXISTS campaign_metrics (
  id                          TEXT PRIMARY KEY,
  campaign_id                 TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  captured_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent                        INTEGER NOT NULL DEFAULT 0,
  delivered                   INTEGER NOT NULL DEFAULT 0,
  bounced                     INTEGER NOT NULL DEFAULT 0,
  hard_bounced                INTEGER NOT NULL DEFAULT 0,
  replied                     INTEGER NOT NULL DEFAULT 0,
  positive_replies            INTEGER NOT NULL DEFAULT 0,
  negative_replies            INTEGER NOT NULL DEFAULT 0,
  unsubscribed                INTEGER NOT NULL DEFAULT 0,
  complained                  INTEGER NOT NULL DEFAULT 0,
  landing_visits              INTEGER NOT NULL DEFAULT 0,
  pilot_signups               INTEGER NOT NULL DEFAULT 0,
  explicit_price_acceptances  INTEGER NOT NULL DEFAULT 0,
  strong_commitments          INTEGER NOT NULL DEFAULT 0,
  unique_companies_committed  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_campaign_metrics_campaign ON campaign_metrics(campaign_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS suppression_list (
  id         TEXT PRIMARY KEY,
  email      TEXT,
  domain     TEXT,
  reason     TEXT NOT NULL,   -- UNSUBSCRIBE | COMPLAINT | HARD_BOUNCE | EXPLICIT_STOP | MANUAL | COUNTRY_NOT_ALLOWED | ROLE_ACCOUNT_BLOCKED
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppression_email ON suppression_list(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppression_domain ON suppression_list(domain) WHERE domain IS NOT NULL;

CREATE TABLE IF NOT EXISTS cost_ledger (
  id             TEXT PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider       TEXT NOT NULL,        -- anthropic | brave | resend | mock
  resource_type  TEXT NOT NULL,        -- LLM_INPUT_TOKENS | LLM_OUTPUT_TOKENS | SEARCH_CALL | EMAIL_SENT
  quantity       NUMERIC(16,4) NOT NULL DEFAULT 0,
  estimated_cost NUMERIC(12,6) NOT NULL DEFAULT 0,
  metadata_json  JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_created ON cost_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_provider ON cost_ledger(provider, resource_type);

CREATE TABLE IF NOT EXISTS audit_events (
  id             TEXT PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  entity_type    TEXT NOT NULL,   -- opportunity | campaign | prospect | message | system
  entity_id      TEXT,
  event_type     TEXT NOT NULL,   -- STATE_TRANSITION | DECISION | REJECTION | SEND | SUPPRESS | GATE_EVALUATION | ERROR
  actor          TEXT NOT NULL,   -- job name or 'system'
  from_state     TEXT,
  to_state       TEXT,
  reason         TEXT,
  detail_json    JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS job_runs (
  id                TEXT PRIMARY KEY,
  job               TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  duration_ms       INTEGER,
  records_processed INTEGER NOT NULL DEFAULT 0,
  cost              NUMERIC(12,6) NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'RUNNING',  -- RUNNING | SUCCESS | FAILED | SKIPPED | HALTED_BUDGET
  error             TEXT,
  detail_json       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job, started_at DESC);

CREATE TABLE IF NOT EXISTS job_locks (
  job         TEXT PRIMARY KEY,
  locked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key    TEXT PRIMARY KEY,   -- sha256(model|systemPrompt|userPrompt|schemaName)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  model        TEXT NOT NULL,
  response_json JSONB NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS search_cache (
  cache_key   TEXT PRIMARY KEY,   -- sha256(provider|query|count)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  query       TEXT NOT NULL,
  results_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache(expires_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,    -- provider event id; PK gives idempotency
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider     TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS owner_notifications (
  id          TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL,   -- READY_TO_BUILD | CREDENTIAL_FAILURE | DOMAIN_FAILURE | COST_LIMIT | SECURITY_FAILURE | JOB_FAILURE
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  sent_at     TIMESTAMPTZ,
  dedupe_key  TEXT UNIQUE,     -- prevents alert spam
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS landing_visits (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  slug        TEXT NOT NULL,
  referrer    TEXT,
  prospect_id TEXT REFERENCES prospects(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_landing_visits_campaign ON landing_visits(campaign_id);
