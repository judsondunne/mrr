/**
 * THE READINESS GATE — machine-enforced, not documentation.
 *
 * Real outreach to real businesses may not begin until every mandatory
 * condition below is demonstrably true. "Demonstrably" is the operative word:
 * the gate does not check that a webhook secret is *configured*, it checks that
 * a genuine Resend event has actually arrived. Configuration proves intent;
 * only traffic proves it works.
 *
 * This is deliberately harsh. The cost of sending cold email from a broken
 * setup is not a bug report — it is a burned sending domain, a complaint, and a
 * real person annoyed by a machine that could not even hear their reply.
 *
 * Fail closed: anything unknown is NOT ready.
 */
import { canSendRealEmail, getConfig } from '../lib/config';
import { getDb } from '../lib/db';
import { createLogger } from '../lib/logger';
import { hasFullAccess } from '../lib/email/resend-api';

const logger = createLogger('autonomy:readiness');

export interface ReadinessCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  /** What the owner must do. Empty when this is ours to fix. */
  ownerAction: string;
}

export interface ReadinessReport {
  ready: boolean;
  checks: ReadinessCheck[];
  blocking: ReadinessCheck[];
  ownerActions: ReadinessCheck[];
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ n: string }>(sql, params);
  return Number(res.rows[0]?.n ?? 0);
}

export async function evaluateReadiness(): Promise<ReadinessReport> {
  const cfg = getConfig();
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck): void => {
    checks.push(c);
  };

  // --- identity and compliance ------------------------------------------
  add({
    id: 'SENDING_DOMAIN',
    label: 'verified sending domain',
    ok: cfg.sendingDomain.trim() !== '' && !cfg.sendingDomain.includes('resend.dev'),
    detail: cfg.sendingDomain || '(unset)',
    ownerAction: 'Verify a domain in Resend and set SENDING_DOMAIN. resend.dev can only reach your own address.',
  });
  add({
    id: 'SENDER_EMAIL',
    label: 'sender address on the verified domain',
    ok: cfg.senderEmail.includes('@') && cfg.senderEmail.endsWith(`@${cfg.sendingDomain}`),
    detail: cfg.senderEmail || '(unset)',
    ownerAction: 'Set SENDER_EMAIL to an address on SENDING_DOMAIN.',
  });
  add({
    id: 'POSTAL_ADDRESS',
    label: 'real postal address (CAN-SPAM)',
    ok: cfg.senderPostalAddress.trim().length > 12 && !/REPLACE|TODO|XXX/i.test(cfg.senderPostalAddress),
    detail: cfg.senderPostalAddress || '(unset)',
    ownerAction: 'Set SENDER_POSTAL_ADDRESS to a real physical address.',
  });

  const gate = canSendRealEmail(cfg);
  add({
    id: 'SEND_GATE',
    label: 'production send gate open',
    ok: gate.ok,
    detail: gate.reason ?? 'every precondition holds',
    ownerAction: '',
  });

  // --- stable public ingress --------------------------------------------
  // --- polling: no public endpoint is required ---------------------------
  //
  // Delivery state and replies are PULLED from Resend, so there is no tunnel,
  // no webhook secret and no ingress to verify. What must be true instead is
  // that the key can read, and that replies have somewhere to land.
  const access = await hasFullAccess();
  add({
    id: 'RESEND_FULL_ACCESS',
    label: 'Resend key can read, not only send',
    ok: access.ok,
    detail: access.ok ? 'list/retrieve endpoints reachable' : access.reason,
    ownerAction: 'Create a full-access API key in Resend and set RESEND_API_KEY.',
  });

  add({
    id: 'INBOUND_ADDRESS',
    label: 'Resend inbound inbox configured as Reply-To',
    ok: cfg.resendInboundAddress.includes('@'),
    detail: cfg.resendInboundAddress || '(unset) — replies would go to an address nobody reads',
    ownerAction:
      'Resend -> Inbound/Receiving -> copy the provided @resend.app address into RESEND_INBOUND_ADDRESS.',
  });

  // Proof, not configuration: delivery state must have come from the provider.
  const polled = await count(
    `SELECT COUNT(*) AS n FROM messages
      WHERE direction = 'OUTBOUND' AND provider_last_event IS NOT NULL`,
  );
  add({
    id: 'REAL_DELIVERY_POLLED',
    label: 'a real delivery state has been read back from Resend',
    ok: polled > 0,
    detail:
      polled > 0
        ? `${polled} message(s) carry a provider-reported state`
        : 'no message has had its state confirmed by Resend yet',
    ownerAction: '',
  });

  // --- safety machinery ---------------------------------------------------
  add({
    id: 'KILL_SWITCH',
    label: 'kill switch present and off',
    ok: cfg.killSwitch === false,
    detail: cfg.killSwitch ? 'KILL_SWITCH is ON — nothing may send' : 'available and off',
    ownerAction: '',
  });

  const capsOk =
    cfg.maxEmailsPerDay > 0 &&
    cfg.maxEmailsPerDay <= 200 &&
    cfg.maxEmailsPerCampaign > 0 &&
    cfg.maxFollowups <= 2 &&
    cfg.initialEmailBatch <= 30;
  add({
    id: 'OUTREACH_CAPS',
    label: 'conservative outreach caps',
    ok: capsOk,
    detail:
      `daily ${cfg.maxEmailsPerDay}, per-campaign ${cfg.maxEmailsPerCampaign}, ` +
      `initial batch ${cfg.initialEmailBatch}, follow-ups ${cfg.maxFollowups}`,
    ownerAction: '',
  });

  add({
    id: 'COUNTRY_ALLOWLIST',
    label: 'country allowlist set',
    ok: cfg.allowedOutreachCountries.length > 0,
    detail: cfg.allowedOutreachCountries.join(', ') || '(empty)',
    ownerAction: '',
  });

  // Suppression must be a working table, not an idea.
  let suppressionOk = false;
  let suppressionDetail = 'unreadable';
  try {
    const n = await count('SELECT COUNT(*) AS n FROM suppression_list');
    suppressionOk = true;
    suppressionDetail = `table readable (${n} entries)`;
  } catch (err) {
    suppressionDetail = String(err).slice(0, 120);
  }
  add({
    id: 'SUPPRESSION',
    label: 'suppression list operational',
    ok: suppressionOk,
    detail: suppressionDetail,
    ownerAction: '',
  });

  // --- singleton scheduler -----------------------------------------------
  const stuckLocks = await count(
    `SELECT COUNT(*) AS n FROM job_locks WHERE expires_at < now() - INTERVAL '1 hour'`,
  );
  add({
    id: 'SCHEDULER_SINGLETON',
    label: 'no abandoned job locks',
    ok: stuckLocks === 0,
    detail: stuckLocks === 0 ? 'clean' : `${stuckLocks} lock(s) expired over an hour ago`,
    ownerAction: '',
  });

  const blocking = checks.filter((c) => !c.ok);
  const ownerActions = blocking.filter((c) => c.ownerAction !== '');

  const report: ReadinessReport = {
    ready: blocking.length === 0,
    checks,
    blocking,
    ownerActions,
  };
  if (!report.ready) {
    logger.warn('readiness gate CLOSED: real outreach is blocked', {
      blocking: blocking.map((c) => c.id),
    });
  }
  return report;
}

/**
 * The one function the send path asks.
 *
 * Deliberately returns a reason rather than throwing, so the caller records
 * WHY nothing was sent instead of failing silently.
 */
/**
 * Checks that only exist to protect REAL prospects, and which a canary aimed
 * at the owner's own mailbox is allowed to proceed without.
 *
 * REAL_DELIVERY_POLLED is the reason this distinction has to exist: it can
 * only become true by sending something, so requiring it before any send is a
 * bootstrap paradox that blocks the very test that would satisfy it. An inbound
 * inbox matters for hearing a stranger's reply, not for proving the outbound
 * half works.
 */
const OWNER_TEST_EXEMPT: ReadonlySet<string> = new Set(['REAL_DELIVERY_POLLED', 'INBOUND_ADDRESS']);

export type OutreachScope = 'REAL_PROSPECTS' | 'OWNER_TEST';

export async function outreachPermitted(
  scope: OutreachScope = 'REAL_PROSPECTS',
): Promise<{ allowed: boolean; reason: string }> {
  const report = await evaluateReadiness();
  const blocking =
    scope === 'OWNER_TEST' ? report.blocking.filter((c) => !OWNER_TEST_EXEMPT.has(c.id)) : report.blocking;

  if (blocking.length === 0) return { allowed: true, reason: '' };
  return {
    allowed: false,
    reason: `readiness gate closed: ${blocking.map((c) => c.id).join(', ')}`,
  };
}
