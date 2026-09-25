#!/usr/bin/env tsx
/**
 * REAL POLLING CANARY — `npm run canary:polling`.
 *
 * Proves the polling architecture end to end with no simulated events:
 * a real email leaves through the production send path, and its delivery
 * state is then READ BACK from Resend rather than assumed.
 *
 * Only ever contacts OWNER_TEST_EMAIL, on a campaign flagged is_test.
 */
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '.env', quiet: true });

// The business-hours window exists so strangers are not emailed at 3am. This
// canary targets the owner's own mailbox, so the window is lifted for this
// process only — .env is untouched and the autonomous loop still honours it.
process.env.SENDING_WINDOW_START_HOUR = '0';
process.env.SENDING_WINDOW_END_HOUR = '24';
process.env.SENDING_WEEKDAYS_ONLY = 'false';
process.env.OUTREACH_SCOPE = 'OWNER_TEST';

const { getConfig, canSendRealEmail } = await import('../lib/config');
const { getDb, closeDb } = await import('../lib/db');
const { runMigrations } = await import('../lib/migrate');
const { newId } = await import('../lib/hash');
const { runJob } = await import('../jobs/registry');
const { reconcileDelivery } = await import('../pipeline/outreach/polling');
const { hasFullAccess, getSentEmail } = await import('../lib/email/resend-api');
const { buildUnsubscribeUrl } = await import('../pipeline/outreach/unsubscribe');

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
};

async function main(): Promise<void> {
  const cfg = getConfig();
  await runMigrations();
  const db = await getDb();
  const target = cfg.ownerTestEmail;
  if (!target) throw new Error('OWNER_TEST_EMAIL is not set');

  console.log('='.repeat(78));
  console.log('  REAL POLLING CANARY — no simulated events');
  console.log('='.repeat(78));

  const access = await hasFullAccess();
  check('Resend key can read', access.ok, access.ok ? 'full access' : access.reason);
  const gate = canSendRealEmail(cfg);
  check('send gate open', gate.ok, gate.reason ?? 'ok');
  if (!gate.ok || !access.ok) { process.exitCode = 1; return; }

  // A test campaign: locally generated events are confined to these, and the
  // readiness gate never counts them as proof the provider works.
  const tag = `poll-${Date.now()}`;
  const oppId = newId('opp'); const campId = newId('cmp'); const prId = newId('pr');
  await db.query(
    `INSERT INTO opportunities (id,name,ecosystem,category,state,dedupe_key,description)
     VALUES ($1,$2,'shopify',$3,'VALIDATING',$4,'Polling canary. Not a real opportunity.')`,
    [oppId, `Polling Canary ${tag}`, tag, `canary:${tag}`]);
  await db.query(
    `INSERT INTO campaigns (id,opportunity_id,state,offer_name,price_monthly,landing_slug,started_at,target_count,is_test)
     VALUES ($1,$2,'SCALING','Polling Canary',19,$3,now(),1,true)`,
    [campId, oppId, tag]);
  const domain = target.split('@')[1] ?? 'invalid.example';
  await db.query(
    `INSERT INTO prospects (id,opportunity_id,company_name,domain,ecosystem,status,contact_email,
       email_is_public,country,public_evidence_url,contact_source_url,qualification_reason)
     VALUES ($1,$2,'Canary Mailbox',$3,'shopify','QUALIFIED',$4,true,'US',$5,$5,'polling canary')`,
    [prId, oppId, domain, target, `https://${domain}/`]);

  // A previous canary recorded a contact against this company, starting the
  // cross-campaign cooldown that correctly protects real prospects. That row is
  // the canary's own, so it is cleared for the owner's test mailbox only.
  const companyKey = target.split('@')[1] ?? target;
  await db.query(
    `UPDATE company_registry
        SET last_contacted_at = NULL, cooldown_until = NULL, contact_state = 'AVAILABLE'
      WHERE company_key = $1 AND contact_state <> 'NEVER_CONTACT'`,
    [companyKey],
  );

  const msgId = newId('msg');
  await db.query(
    `INSERT INTO messages (id,campaign_id,prospect_id,direction,sequence_step,subject,body,status,idempotency_key)
     VALUES ($1,$2,$3,'OUTBOUND',0,$4,$5,'DRAFTED',$6)`,
    [msgId, campId, prId, `Polling canary ${tag}`,
     ['Automated polling canary from the MRR validator.', '',
      'Delivery state for this message is read back from Resend, not assumed.',
      '', '--', cfg.senderCompany, cfg.senderPostalAddress, '',
      'If you\'d prefer I don\'t email you again, just reply "unsubscribe".',
      `Unsubscribe: ${buildUnsubscribeUrl(target)}`].join('\n'),
     `${tag}:${prId}:0`]);

  const run = await runJob('send_due_messages');
  check('production send job ran', run.status === 'SUCCESS' || run.status === 'SKIPPED',
    `status=${run.status} ${run.error ?? ''}`);

  const sent = await db.query<{ status: string; provider_message_id: string | null; error: string | null }>(
    'SELECT status, provider_message_id, error FROM messages WHERE id = $1', [msgId]);
  const pmid = sent.rows[0]?.provider_message_id ?? null;
  check('real Resend id issued', !!pmid, `${pmid ?? sent.rows[0]?.error ?? 'none'}`);
  if (!pmid) { process.exitCode = 1; return; }

  // Poll until Resend reports a terminal state. This is the whole point: the
  // state comes from the provider.
  let last = '';
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await reconcileDelivery(20);
    const row = await db.query<{ status: string; provider_last_event: string | null; rfc_message_id: string | null }>(
      'SELECT status, provider_last_event, rfc_message_id FROM messages WHERE id = $1', [msgId]);
    last = row.rows[0]?.provider_last_event ?? '';
    if (row.rows[0]?.status === 'DELIVERED') {
      check('Resend reports DELIVERED (polled, not simulated)', true,
        `last_event=${last} after ${(i + 1) * 5}s; updated=${res.updated}`);
      check('RFC Message-ID captured for threading', !!row.rows[0]?.rfc_message_id,
        row.rows[0]?.rfc_message_id ?? 'missing');
      break;
    }
    if (i === 11) check('Resend reports DELIVERED (polled, not simulated)', false, `still ${last || 'unknown'}`);
  }

  const remote = await getSentEmail(pmid);
  check('reply-to points at the pollable inbox', !!remote?.replyTo?.length,
    remote?.replyTo?.join(', ') ?? 'NOT SET — replies would be unreadable (RESEND_INBOUND_ADDRESS unset)');

  // --keep retains the rows so a human reply has an outbound message to thread
  // against. The campaign stays flagged is_test, so nothing it accumulates can
  // ever count toward real validation.
  if (process.argv.includes('--keep')) {
    console.log(`\n  RETAINED for inbound test: campaign=${campId} message=${msgId}`);
    const failedKeep = checks.filter((c) => !c.ok);
    console.log('\n' + '='.repeat(78));
    console.log(`  ${checks.length - failedKeep.length}/${checks.length} checks passed`);
    if (failedKeep.length > 0) process.exitCode = 1;
    return;
  }

  // Tear down so nothing counts toward validation.
  await db.query('DELETE FROM messages WHERE campaign_id = $1', [campId]);
  await db.query('DELETE FROM campaigns WHERE id = $1', [campId]);
  await db.query('DELETE FROM prospects WHERE opportunity_id = $1', [oppId]);
  await db.query('DELETE FROM opportunities WHERE id = $1', [oppId]);

  const failed = checks.filter((c) => !c.ok);
  console.log('\n' + '='.repeat(78));
  console.log(`  ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

try { await main(); }
catch (err) { console.error(`canary error: ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; }
finally { await closeDb().catch(() => undefined); }
