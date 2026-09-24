-- Provenance for provider events.
--
-- A locally generated webhook is signed with the same secret as a real one, so
-- the payload cannot tell them apart. Recording WHERE an event entered the
-- system is what lets the readiness gate insist on having seen a genuine
-- Resend delivery and a genuine inbound message before any real prospect is
-- contacted. Without it, a canary's own events would satisfy the gate.
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'PROVIDER';
  -- PROVIDER = arrived over HTTP from Resend. TEST = generated on this machine.

CREATE INDEX IF NOT EXISTS idx_webhook_events_origin
  ON webhook_events(origin, event_type, created_at DESC);
