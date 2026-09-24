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
import { buildUnsubscribeUrl, verifyUnsubscribeToken, extractUnsubscribeToken } from '../pipeline/outreach/unsubscribe';

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

/**
 * Reaches the public base URL from outside the process.
 *
 * This is the only honest way to know the tunnel is up: an internal call to
 * localhost proves nothing about whether Resend or a prospect can reach us.
 */
async function probePublicUrl(url: string, pathname: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const target = new URL(pathname, url).toString();
    const res = await fetch(target, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
    });
    // Any answer from our own app is proof the route is publicly reachable;
    // an unsubscribe link legitimately answers 4xx for a bad token.
    const ok = res.status > 0 && res.status < 500;
    return { ok, detail: `${target} -> HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `${pathname} unreachable: ${String(err).slice(0, 120)}` };
  }
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
  const httpsBase = cfg.publicBaseUrl.startsWith('https://');
  add({
    id: 'PUBLIC_BASE_URL_HTTPS',
    label: 'PUBLIC_BASE_URL is https',
    ok: httpsBase,
    detail: cfg.publicBaseUrl || '(unset)',
    ownerAction: 'Provide a stable HTTPS hostname for this Mac.',
  });

  // Only hostnames that are random by construction are rejected. A RESERVED
  // ngrok domain is stable across restarts even though it shares the
  // ngrok-free.app suffix with throwaway ones, so the suffix alone cannot
  // condemn it — a quick tunnel, by contrast, is a new name every start.
  const ephemeral = /trycloudflare\.com|loca\.lt|\.serveo\.net/i.test(cfg.publicBaseUrl);
  add({
    id: 'PUBLIC_BASE_URL_STABLE',
    label: 'PUBLIC_BASE_URL survives a restart',
    ok: httpsBase && !ephemeral,
    detail: ephemeral
      ? `${cfg.publicBaseUrl} is an ephemeral quick tunnel; its hostname changes on restart, which breaks ` +
        'every unsubscribe link already sent and silently detaches the Resend webhook'
      : cfg.publicBaseUrl,
    ownerAction: 'Provide a named tunnel hostname or a reserved static domain.',
  });

  const health = httpsBase ? await probePublicUrl(cfg.publicBaseUrl, '/api/health') : { ok: false, detail: 'skipped' };
  add({
    id: 'PUBLIC_URL_REACHABLE',
    label: 'public URL reaches this Mac',
    ok: health.ok,
    detail: health.detail,
    ownerAction: '',
  });

  // --- unsubscribe works from outside ------------------------------------
  const unsubUrl = buildUnsubscribeUrl('readiness-probe@example.com');
  const token = extractUnsubscribeToken(`Unsubscribe: ${unsubUrl}`);
  const signedOk = token !== null && verifyUnsubscribeToken(token) !== null;
  const unsubProbe = httpsBase ? await probePublicUrl(cfg.publicBaseUrl, '/api/unsubscribe') : { ok: false, detail: 'skipped' };
  add({
    id: 'UNSUBSCRIBE',
    label: 'one-click unsubscribe signed and publicly reachable',
    ok: signedOk && unsubProbe.ok,
    detail: `${signedOk ? 'token signs and verifies' : 'TOKEN SIGNING BROKEN'}; ${unsubProbe.detail}`,
    ownerAction: '',
  });

  // --- provider events: configured is not the same as working ------------
  const realDelivery = await count(
    `SELECT COUNT(*) AS n FROM webhook_events
      WHERE provider = 'resend' AND origin = 'PROVIDER'
        AND event_type IN ('email.delivered','email.sent')`,
  );
  add({
    id: 'REAL_DELIVERY_WEBHOOK',
    label: 'a genuine Resend delivery event has arrived',
    ok: realDelivery > 0,
    detail:
      realDelivery > 0
        ? `${realDelivery} provider-origin delivery event(s) recorded`
        : 'no delivery event has ever arrived from Resend; delivery state would be invented',
    ownerAction:
      'In Resend → Webhooks, add an endpoint at ' +
      `${cfg.publicBaseUrl}/api/webhooks/resend for email.sent, email.delivered, email.delivery_delayed, ` +
      'email.bounced, email.complained and email.failed, then copy its signing secret into RESEND_WEBHOOK_SECRET.',
  });

  const realInbound = await count(
    `SELECT COUNT(*) AS n FROM webhook_events
      WHERE provider = 'resend-inbound' AND origin = 'PROVIDER'`,
  );
  add({
    id: 'REAL_INBOUND',
    label: 'a genuine inbound reply has arrived',
    ok: realInbound > 0,
    detail:
      realInbound > 0
        ? `${realInbound} provider-origin inbound event(s) recorded`
        : 'no inbound email has ever arrived; the system cannot hear a reply, so it cannot validate anything',
    ownerAction:
      'Enable receiving in Resend for the sending domain and add the MX record it specifies at your DNS host, ' +
      'then set RESEND_INBOUND_WEBHOOK_SECRET.',
  });

  add({
    id: 'WEBHOOK_SECRETS',
    label: 'webhook signing secrets configured',
    ok: cfg.resendWebhookSecret.trim() !== '' && cfg.resendInboundWebhookSecret.trim() !== '',
    detail: `${cfg.resendWebhookSecret ? 'delivery set' : 'delivery MISSING'}; ${cfg.resendInboundWebhookSecret ? 'inbound set' : 'inbound MISSING'}`,
    ownerAction: 'Copy the signing secrets from Resend into RESEND_WEBHOOK_SECRET / RESEND_INBOUND_WEBHOOK_SECRET.',
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
export async function outreachPermitted(): Promise<{ allowed: boolean; reason: string }> {
  const report = await evaluateReadiness();
  if (report.ready) return { allowed: true, reason: '' };
  return {
    allowed: false,
    reason: `readiness gate closed: ${report.blocking.map((c) => c.id).join(', ')}`,
  };
}
