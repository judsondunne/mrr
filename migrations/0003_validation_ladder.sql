-- Autonomous validation: the ladder, test isolation, and reply intelligence.
--
-- Three things this adds, all of which exist to stop the system fooling itself:
--
--  1. `campaigns.is_test` — a locally generated delivery event must never be
--     able to mark a REAL prospect message as delivered. Test events are
--     confined to test campaigns and rejected everywhere else.
--  2. `opportunities.validation_stage` — the honest ladder. A candidate climbs
--     it only on real prospect behaviour, and PAYMENT_INTENT is distinct from
--     REVENUE because no money has moved.
--  3. `reply_insights` — structured extraction per inbound message, so
--     targeting, offer and price decisions are driven by what prospects
--     actually said rather than by a model's summary of them.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

-- The validation ladder. Deliberately separate from opportunities.state: state
-- is where the work is, this is how much a real buyer has told us.
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS validation_stage TEXT NOT NULL DEFAULT 'RESEARCHED';
  -- RESEARCHED | EVIDENCE_BACKED | OUTREACH_TESTING | PAIN_CONFIRMED
  -- | COMMERCIAL_SIGNAL | PAYMENT_INTENT | VALIDATED | REJECTED

CREATE INDEX IF NOT EXISTS idx_opportunities_validation_stage
  ON opportunities(validation_stage);

-- Every rung of the ladder must be explainable by the exact message that
-- earned it. An LLM score is never sufficient justification.
CREATE TABLE IF NOT EXISTS validation_transitions (
  id              TEXT PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  opportunity_id  TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  from_stage      TEXT NOT NULL,
  to_stage        TEXT NOT NULL,
  reason          TEXT NOT NULL,
  -- The inbound message that justified this move, when there is one.
  message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
  company_key     TEXT,
  -- Verbatim prospect words. Never paraphrased.
  evidence_quote  TEXT,
  detail_json     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_validation_transitions_opp
  ON validation_transitions(opportunity_id, created_at DESC);

-- What a reply actually told us, field by field, with the quote that says so.
CREATE TABLE IF NOT EXISTS reply_insights (
  id                   TEXT PRIMARY KEY,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_id           TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  campaign_id          TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
  opportunity_id       TEXT REFERENCES opportunities(id) ON DELETE CASCADE,
  company_key          TEXT NOT NULL,
  intent               TEXT NOT NULL,
  confidence           NUMERIC(4,3) NOT NULL DEFAULT 0,
  -- Verbatim support for the classification.
  evidence_quote       TEXT NOT NULL DEFAULT '',
  current_workflow     TEXT,
  current_tools        TEXT,
  current_spend        TEXT,
  stated_amount_usd    NUMERIC(12,2),
  price_sensitivity    TEXT,
  requested_capability TEXT,
  objection            TEXT,
  next_action          TEXT,
  decision_maker       TEXT,
  -- True when the prospect volunteered this rather than answering a leading
  -- question. Unsolicited confirmation is worth more and is scored as such.
  unsolicited          BOOLEAN NOT NULL DEFAULT false,
  qualified_company    BOOLEAN NOT NULL DEFAULT true,
  disqualified_reason  TEXT,
  UNIQUE (message_id)
);
CREATE INDEX IF NOT EXISTS idx_reply_insights_opp ON reply_insights(opportunity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reply_insights_company ON reply_insights(company_key);
