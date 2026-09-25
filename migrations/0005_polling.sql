-- Polling architecture: no public endpoint, no webhooks.
--
-- Delivery state and inbound replies are pulled from the Resend API instead of
-- being pushed to us. That removes the tunnel, the webhook secrets and the
-- public ingress entirely — and it means delivery state still originates from
-- the provider, never from this machine.

-- The RFC 5322 Message-ID Resend assigns to a sent email. This is what a reply
-- quotes in In-Reply-To / References, so it is the only reliable way to attach
-- an inbound message to the outbound one that caused it. The existing
-- provider_message_id is Resend's own UUID and never appears in a reply.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS rfc_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_rfc_message_id
  ON messages(rfc_message_id) WHERE rfc_message_id IS NOT NULL;

-- Last known provider state, so reconciliation can tell "unchanged" from
-- "never checked" and avoid rewriting rows on every pass.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS provider_last_event TEXT,
  ADD COLUMN IF NOT EXISTS provider_checked_at TIMESTAMPTZ;

-- Every inbound message Resend has handed us, claimed exactly once. The unique
-- provider id is what makes repeated polling idempotent: a poll that sees the
-- same message twice inserts nothing the second time.
CREATE TABLE IF NOT EXISTS inbound_emails (
  id                   TEXT PRIMARY KEY,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_inbound_id  TEXT NOT NULL UNIQUE,
  from_address         TEXT NOT NULL,
  to_address           TEXT,
  subject              TEXT NOT NULL DEFAULT '',
  text_body            TEXT NOT NULL DEFAULT '',
  rfc_message_id       TEXT,
  in_reply_to          TEXT,
  references_header    TEXT,
  received_at          TIMESTAMPTZ,
  -- Set once the message has been turned into a `messages` row and classified.
  processed_at         TIMESTAMPTZ,
  matched_message_id   TEXT REFERENCES messages(id) ON DELETE SET NULL,
  match_method         TEXT,
  raw_json             JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_inbound_unprocessed
  ON inbound_emails(processed_at) WHERE processed_at IS NULL;
