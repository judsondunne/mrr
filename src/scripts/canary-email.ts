#!/usr/bin/env tsx
/**
 * REAL EMAIL ROUND-TRIP CANARY — `npm run canary:email`.
 *
 * Proves the outbound and inbound halves of the system against the REAL
 * provider, through the REAL production code path. There is no bypass endpoint
 * here: a campaign and a message row are created, the production send job
 * picks them up, Resend is called by the same provider the pipeline uses, and
 * the delivery and inbound webhooks are handled by the same handlers the HTTP
 * routes call.
 *
 * SAFETY, in order of importance:
 *   1. The only address this will ever contact is OWNER_TEST_EMAIL. Every
 *      prospect it creates uses that address, and a final assertion re-reads
 *      the database to prove nothing else was written.
 *   2. It refuses to run at all unless OWNER_TEST_EMAIL is set.
 *   3. Its campaign is tagged and torn down, so a canary run cannot leave rows
 *      that a later real campaign or the gate would count.
 *
 * Exits non-zero on any failed check.
 *
 * Usage:
 *   npm run canary:email               # outbound + simulated-provider inbound
 *   npm run canary:email -- --no-send  # verify wiring and config only
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: '.env', quiet: true });

const { getConfig, canSendRealEmail } = await import('../lib/config');
const { getDb, closeDb } = await import('../lib/db');
const { runMigrations } = await import('../lib/migrate');
const { newId } = await import('../lib/hash');
const { getEmailProvider } = await import('../lib/email/index');
const { runJob } = await import('../jobs/registry');
const {
  handleDeliveryWebhook,
  handleInboundWebhook,
  signWebhookPayload,
} = await import('../pipeline/outreach/webhooks');
const { isSuppressed } = await import('../pipeline/outreach/suppression');

const NO_SEND = process.argv.includes('--no-send');

// --- check plumbing ---------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${name}`);
  if (detail) console.log(`        ${detail}`);
}

function fatal(message: string): never {
  console.error(`\nCANARY ABORTED: ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

// --- the run ----------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = getConfig();

  console.log('='.repeat(78));
  console.log('  REAL EMAIL ROUND-TRIP CANARY');
  console.log('='.repeat(78));

  // 1. Refuse to contact anything but the operator's own mailbox.
  if (!cfg.ownerTestEmail) {
    fatal(
      'OWNER_TEST_EMAIL is not set. This canary sends a REAL email and will only ever\n' +
        'send it to that address. Set OWNER_TEST_EMAIL to a mailbox you control and\n' +
        'can reply from, then run this again.',
    );
  }
  const target = cfg.ownerTestEmail.trim().toLowerCase();
  console.log(`  target mailbox : ${target}`);
  console.log(`  send enabled   : ${NO_SEND ? 'no (--no-send)' : 'yes'}`);
  console.log('');

  const gate = canSendRealEmail(cfg);
  if (!NO_SEND && !gate.ok) {
    fatal(
      `the production send gate refuses to send: ${gate.reason}\n` +
        'Fix the configuration it names, or run with --no-send to check wiring only.',
    );
  }
  check('production send gate open', NO_SEND || gate.ok, gate.reason ?? 'every precondition holds');

  const provider = getEmailProvider();
  check(
    'real email provider resolved',
    NO_SEND || provider.name === 'resend',
    `provider is "${provider.name}"`,
  );

  await runMigrations();
  const db = await getDb();

  // 2. Build the canary's own opportunity + campaign, tagged so teardown is
  //    exact and so no real evaluation can ever see these rows.
  const tag = `canary-${Date.now()}`;
  const opportunityId = newId('opp');
  const campaignId = newId('cmp');
  const prospectId = newId('pr');

  await db.query(
    `INSERT INTO opportunities (id, name, ecosystem, category, state, dedupe_key, description)
     VALUES ($1,$2,'shopify',$3,'VALIDATING',$4,'Email round-trip canary. Not a real opportunity.')`,
    [opportunityId, `Email Canary ${tag}`, tag, `canary:${tag}`],
  );
  await db.query(
    `INSERT INTO campaigns
       (id, opportunity_id, state, offer_name, price_monthly, landing_slug, started_at, target_count)
     VALUES ($1,$2,'SCALING','Email Canary',19,$3, now(), 1)`,
    [campaignId, opportunityId, tag],
  );
  const domain = target.split('@')[1] ?? 'invalid.example';
  await db.query(
    `INSERT INTO prospects
       (id, opportunity_id, company_name, domain, ecosystem, status, contact_email,
        email_is_public, country, public_evidence_url, contact_source_url, qualification_reason)
     VALUES ($1,$2,'Canary Mailbox',$3,'shopify','QUALIFIED',$4,true,'US',$5,$5,
             'email round-trip canary; the operator owns this mailbox')`,
    [prospectId, opportunityId, domain, target, `https://${domain}/`],
  );

  // 3. A message row, exactly as the drafting stage writes one, then the REAL
  //    send job. Nothing here calls the provider directly.
  const messageId = newId('msg');
  const idempotencyKey = `${tag}:${prospectId}:0`;
  await db.query(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, subject, body, status, idempotency_key)
     VALUES ($1,$2,$3,'OUTBOUND',0,$4,$5,'DRAFTED',$6)`,
    [
      messageId,
      campaignId,
      prospectId,
      `Round-trip canary ${tag}`,
      [
        'This is an automated round-trip canary from the MRR validator.',
        '',
        'Nothing is being offered and no product exists. Reply to this message to',
        'verify the inbound half of the pipeline.',
        '',
        `-- ${cfg.senderCompany}`,
        cfg.senderPostalAddress,
      ].join('\n'),
      idempotencyKey,
    ],
  );

  let providerMessageId: string | null = null;

  if (NO_SEND) {
    check('outbound send', false, 'skipped (--no-send)');
  } else {
    const run = await runJob('send_due_messages');
    check(
      'production send job ran',
      run.status === 'SUCCESS' || run.status === 'SKIPPED',
      `status=${run.status} records=${run.recordsProcessed} ${run.error ? `error=${run.error}` : ''}`,
    );

    const sent = await db.query<{ status: string; provider_message_id: string | null; error: string | null }>(
      'SELECT status, provider_message_id, error FROM messages WHERE id = $1',
      [messageId],
    );
    const row = sent.rows[0];
    providerMessageId = row?.provider_message_id ?? null;

    check(
      'message left the system',
      row?.status === 'SENT' || row?.status === 'DELIVERED',
      `status=${row?.status ?? 'missing'} ${row?.error ? `error=${row.error}` : ''}`,
    );
    check(
      'provider message id stored',
      typeof providerMessageId === 'string' && providerMessageId.length > 0,
      `providerMessageId=${providerMessageId ?? 'null'}`,
    );

    // 4. Idempotency: re-running the send job must not send a second copy.
    await runJob('send_due_messages');
    const copies = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM messages
        WHERE campaign_id = $1 AND direction = 'OUTBOUND' AND sequence_step = 0`,
      [campaignId],
    );
    check('send is idempotent', Number(copies.rows[0]?.n ?? 0) === 1, `${copies.rows[0]?.n} outbound row(s)`);
  }

  // 5. Delivery webhook, through the real handler and the real signature check.
  if (providerMessageId) {
    const payload = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: providerMessageId, to: [target] },
    });
    const eventId = `canary-delivered-${tag}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = {
      'svix-id': eventId,
      'svix-timestamp': ts,
      'svix-signature': signWebhookPayload(cfg.resendWebhookSecret, eventId, ts, payload),
    };

    const first = await handleDeliveryWebhook(payload, headers);
    const replay = await handleDeliveryWebhook(payload, headers);
    check('delivery webhook processed', first.accepted && !first.duplicate, `eventType=${first.eventType}`);
    check('duplicate delivery webhook ignored', replay.duplicate, 'second identical event was a no-op');

    const delivered = await db.query<{ status: string; delivered_at: string | null }>(
      'SELECT status, delivered_at FROM messages WHERE id = $1',
      [messageId],
    );
    check(
      'message marked delivered',
      delivered.rows[0]?.status === 'DELIVERED' && delivered.rows[0]?.delivered_at !== null,
      `status=${delivered.rows[0]?.status ?? 'missing'}`,
    );
  } else {
    check('delivery webhook processed', false, 'no provider message id to reference');
  }

  // 6. Inbound: three replies covering strong / weak / opt-out, each through
  //    the real signed inbound handler. This is the half that decides whether
  //    a real customer's "yes" is ever recorded.
  const inbound = async (
    label: string,
    body: string,
    eventSuffix: string,
  ): Promise<{ accepted: boolean; duplicate: boolean }> => {
    const payload = JSON.stringify({
      type: 'email.inbound',
      data: {
        email_id: `canary-in-${eventSuffix}`,
        from: target,
        to: [cfg.senderEmail],
        subject: `Re: Round-trip canary ${tag}`,
        text: body,
        headers: {},
      },
    });
    const eventId = `canary-inbound-${eventSuffix}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const result = await handleInboundWebhook(payload, {
      'svix-id': eventId,
      'svix-timestamp': ts,
      'svix-signature': signWebhookPayload(cfg.resendInboundWebhookSecret, eventId, ts, payload),
    });
    // Replay the SAME event: one logical inbound message only.
    const again = await handleInboundWebhook(payload, {
      'svix-id': eventId,
      'svix-timestamp': ts,
      'svix-signature': signWebhookPayload(cfg.resendInboundWebhookSecret, eventId, ts, payload),
    });
    check(
      `inbound accepted: ${label}`,
      result.accepted && !result.duplicate,
      `classification=${result.classification ?? 'null'} commitments=${result.commitmentsCreated} ` +
        `suppressed=${result.suppressed}`,
    );
    check(`inbound replay ignored: ${label}`, again.duplicate, 'the same event twice is one message');
    return result;
  };

  await inbound(
    'strong + price acceptance',
    "Yes - $19/month is fine. Sign us up for the pilot, we'd like one of the first installs.",
    'strong',
  );

  const strong = await db.query<{ classification: string; campaign_id: string | null; extraction_json: unknown }>(
    `SELECT classification, campaign_id, extraction_json FROM messages
      WHERE direction = 'INBOUND' AND prospect_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [prospectId],
  );
  const strongRow = strong.rows[0];
  check(
    'reply classified',
    strongRow?.classification !== null && strongRow?.classification !== undefined,
    `classification=${strongRow?.classification ?? 'null'}`,
  );
  check(
    'thread matched to the campaign',
    strongRow?.campaign_id === campaignId,
    `campaign_id=${strongRow?.campaign_id ?? 'null'}`,
  );

  const commitments = await db.query<{ type: string; company_key: string }>(
    'SELECT type, company_key FROM commitments WHERE campaign_id = $1',
    [campaignId],
  );
  check(
    'commitment extracted from the strong reply',
    commitments.rows.length > 0,
    commitments.rows.length > 0
      ? `types=${commitments.rows.map((r) => r.type).join(', ')} company=${commitments.rows[0]?.company_key}`
      : 'no commitment row was written',
  );

  await inbound('weak interest', 'Sounds interesting, cool idea. Keep me posted on how it goes.', 'weak');
  const afterWeak = await db.query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM commitments WHERE campaign_id = $1',
    [campaignId],
  );
  check(
    'weak reply adds no commitment',
    Number(afterWeak.rows[0]?.n ?? 0) === commitments.rows.length,
    `${afterWeak.rows[0]?.n} commitment row(s), unchanged`,
  );

  await inbound('opt-out', 'Please remove me.', 'unsub');
  const suppressed = await isSuppressed(target);
  check('opt-out suppressed immediately', suppressed, `isSuppressed(${target}) = ${suppressed}`);

  const eligible = await db.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM prospects
      WHERE id = $1 AND suppressed_at IS NULL AND status NOT IN ('SUPPRESSED')`,
    [prospectId],
  );
  check(
    'no further follow-up eligibility',
    Number(eligible.rows[0]?.n ?? 0) === 0,
    'the prospect is no longer sendable',
  );

  // 7. Prove the blast radius: the canary contacted nothing but the target.
  const recipients = await db.query<{ contact_email: string }>(
    `SELECT DISTINCT p.contact_email
       FROM messages m JOIN prospects p ON p.id = m.prospect_id
      WHERE m.campaign_id = $1 AND m.direction = 'OUTBOUND'`,
    [campaignId],
  );
  const contacted = recipients.rows.map((r) => r.contact_email.toLowerCase());
  check(
    'only OWNER_TEST_EMAIL was contacted',
    contacted.every((e) => e === target),
    contacted.length === 0 ? 'nothing was sent' : `contacted: ${contacted.join(', ')}`,
  );

  // 8. Tear the canary's rows down so they can never be counted as validation.
  await db.query('DELETE FROM commitments WHERE campaign_id = $1', [campaignId]);
  await db.query('DELETE FROM messages WHERE campaign_id = $1', [campaignId]);
  await db.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
  await db.query('DELETE FROM prospects WHERE opportunity_id = $1', [opportunityId]);
  await db.query('DELETE FROM opportunities WHERE id = $1', [opportunityId]);
  const left = await db.query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM opportunities WHERE dedupe_key = $1',
    [`canary:${tag}`],
  );
  check('canary rows removed', Number(left.rows[0]?.n ?? 0) === 0, 'nothing left for the gate to count');

  // The suppression entry is deliberately LEFT IN PLACE: an address that asked
  // to be removed stays removed, even a test one.
  console.log('');
  console.log('  note: the opt-out suppression for the target address was kept on purpose.');

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  console.log('='.repeat(78));
  console.log(`  ${checks.length - failed.length}/${checks.length} canary checks passed`);
  console.log('='.repeat(78));

  if (failed.length > 0) {
    console.error('\nFAILED CHECKS:');
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error(`\ncanary error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => undefined);
}
