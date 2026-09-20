/**
 * Setup verification — the single source of truth for "is this thing
 * configured safely enough to run?".
 *
 * Every check is NON-DESTRUCTIVE: it verifies configuration presence and
 * database connectivity. It never sends a test email and never spends an LLM
 * token. Nothing here returns a secret value — only whether one is present.
 */
import { canSendRealEmail, getConfig } from './config.js';
import { getDb } from './db.js';
import { createLogger } from './logger.js';

const logger = createLogger('setup-check');

export interface SetupCheck {
  name: string;
  ok: boolean;
  detail: string;
  remediation: string;
  /** Outreach is blocked while any safety-critical check fails. */
  safetyCritical: boolean;
}

export interface SetupReport {
  checks: SetupCheck[];
  allOk: boolean;
  /** True only when every safety-critical check passes. */
  safeToSend: boolean;
  shadowMode: boolean;
  autonomyEnabled: boolean;
  outreachEnabled: boolean;
}

export async function runSetupChecks(): Promise<SetupReport> {
  const cfg = getConfig();
  const checks: SetupCheck[] = [];

  // DATABASE
  try {
    const db = await getDb();
    const res = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'opportunities'`,
    );
    const migrated = Number(res.rows[0]?.n ?? 0) > 0;
    checks.push({
      name: 'DATABASE',
      ok: migrated,
      detail: migrated
        ? `connected (${db.kind}), migrations applied`
        : `connected (${db.kind}) but migrations are missing`,
      remediation: 'Run: npm run migrate',
      safetyCritical: true,
    });
  } catch (err) {
    checks.push({
      name: 'DATABASE',
      ok: false,
      detail: `cannot connect: ${err instanceof Error ? err.message : String(err)}`,
      remediation: 'Check DATABASE_URL, or unset it to use local PGlite.',
      safetyCritical: true,
    });
  }

  // RESEND SEND
  const sendGate = canSendRealEmail(cfg);
  checks.push({
    name: 'RESEND SEND',
    ok: Boolean(cfg.resendApiKey) && cfg.emailProvider === 'resend',
    detail: cfg.resendApiKey
      ? `API key present, provider=${cfg.emailProvider}`
      : 'RESEND_API_KEY not set (mock provider in use — nothing can be sent)',
    remediation: 'Set RESEND_API_KEY and EMAIL_PROVIDER=resend. See SETUP.md step 3.',
    safetyCritical: true,
  });

  // RESEND INBOUND
  checks.push({
    name: 'RESEND INBOUND',
    ok: Boolean(cfg.resendInboundWebhookSecret),
    detail: cfg.resendInboundWebhookSecret
      ? 'inbound webhook secret present'
      : 'RESEND_INBOUND_WEBHOOK_SECRET not set — replies cannot be received',
    remediation:
      'Create an inbound webhook in Resend pointing at ' +
      `${cfg.publicBaseUrl}/api/webhooks/resend-inbound and set its signing secret.`,
    safetyCritical: true,
  });

  // WEBHOOK (delivery events)
  checks.push({
    name: 'WEBHOOK',
    ok: Boolean(cfg.resendWebhookSecret),
    detail: cfg.resendWebhookSecret
      ? 'delivery webhook secret present'
      : 'RESEND_WEBHOOK_SECRET not set — bounces and complaints cannot be processed',
    remediation:
      `Create a Resend webhook pointing at ${cfg.publicBaseUrl}/api/webhooks/resend ` +
      'subscribed to email.delivered, email.bounced, email.complained.',
    safetyCritical: true,
  });

  // SEARCH
  checks.push({
    name: 'SEARCH',
    ok: Boolean(cfg.braveSearchApiKey) || cfg.searchProvider === 'mock',
    detail: cfg.braveSearchApiKey
      ? 'Brave Search API key present'
      : 'BRAVE_SEARCH_API_KEY not set (mock provider — discovery will find nothing real)',
    remediation: 'Get a free key at https://brave.com/search/api/ and set BRAVE_SEARCH_API_KEY.',
    safetyCritical: false,
  });

  // LLM
  checks.push({
    name: 'LLM',
    ok: Boolean(cfg.anthropicApiKey) || cfg.llmProvider === 'mock',
    detail: cfg.anthropicApiKey
      ? `API key present (fast=${cfg.llmFast}, reasoner=${cfg.llmReasoner})`
      : 'ANTHROPIC_API_KEY not set (mock provider — analysis will be synthetic)',
    remediation: 'Set ANTHROPIC_API_KEY. See SETUP.md step 4.',
    safetyCritical: false,
  });

  // CRON
  checks.push({
    name: 'CRON',
    ok: cfg.cronSecret.length >= 16,
    detail: cfg.cronSecret
      ? 'CRON_SECRET set'
      : 'CRON_SECRET not set — the scheduler endpoint would be unauthenticated',
    remediation: 'Generate one: openssl rand -hex 32, then set CRON_SECRET.',
    safetyCritical: true,
  });

  // DOMAIN + sender identity (legally required in outbound mail)
  const domainOk =
    Boolean(cfg.sendingDomain) &&
    Boolean(cfg.senderEmail) &&
    Boolean(cfg.senderCompany) &&
    Boolean(cfg.senderPostalAddress) &&
    Boolean(cfg.unsubscribeSecret) &&
    cfg.publicBaseUrl.startsWith('https://');
  checks.push({
    name: 'DOMAIN',
    ok: domainOk,
    detail: domainOk
      ? `sending as ${cfg.senderEmail} via ${cfg.sendingDomain}`
      : 'sender identity incomplete (domain, sender email, company, postal address, ' +
        'unsubscribe secret and an https PUBLIC_BASE_URL are all required)',
    remediation:
      'Verify your domain in Resend (SPF + DKIM), then set SENDING_DOMAIN, SENDER_EMAIL, ' +
      'SENDER_COMPANY, SENDER_POSTAL_ADDRESS, UNSUBSCRIBE_SECRET and an https PUBLIC_BASE_URL.',
    safetyCritical: true,
  });

  // OWNER NOTIFICATION
  checks.push({
    name: 'OWNER NOTIFICATION',
    ok: Boolean(cfg.ownerNotificationEmail) && Boolean(cfg.ownerName),
    detail: cfg.ownerNotificationEmail
      ? `alerts go to ${maskEmail(cfg.ownerNotificationEmail)}`
      : 'OWNER_NOTIFICATION_EMAIL not set — you would never hear about a validated opportunity',
    remediation: 'Set OWNER_NAME and OWNER_NOTIFICATION_EMAIL.',
    safetyCritical: true,
  });

  // ADMIN
  checks.push({
    name: 'ADMIN AUTH',
    ok: cfg.adminToken.length >= 16,
    detail: cfg.adminToken ? 'ADMIN_TOKEN set' : 'ADMIN_TOKEN not set — the dashboard would be open',
    remediation: 'Generate one: openssl rand -hex 32, then set ADMIN_TOKEN.',
    safetyCritical: true,
  });

  const allOk = checks.every((c) => c.ok);
  // Configuration readiness only. The runtime switches (AUTONOMY_ENABLED /
  // OUTREACH_ENABLED) are reported separately so the operator can see that
  // config is ready while sending is still deliberately off.
  const safeToSend = checks.filter((c) => c.safetyCritical).every((c) => c.ok);

  logger.debug('setup check complete', { allOk, safeToSend, sendGate: sendGate.reason ?? 'clear' });

  return {
    checks,
    allOk,
    safeToSend,
    shadowMode: !cfg.autonomyEnabled || !cfg.outreachEnabled || cfg.killSwitch,
    autonomyEnabled: cfg.autonomyEnabled,
    outreachEnabled: cfg.outreachEnabled,
  };
}

/** Never print a full address into a log or a shared screen. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain || !local) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}
