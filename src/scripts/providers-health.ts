#!/usr/bin/env tsx
/**
 * PROVIDER HEALTH — `npm run providers:health`.
 *
 * Makes ONE real, inexpensive call to every external dependency and prints a
 * table. This is deliberately separate from `npm run setup-check`, which is
 * presence-only and backs a web page: it must never spend a token or write a
 * row, so it can be loaded freely. This script is the opposite — it proves the
 * credentials actually work, which presence alone never does.
 *
 * Cost per run: one search call, one fast-tier classification of a few dozen
 * tokens, one database row written and deleted. No email is sent — that is
 * `npm run canary:email`, which needs its own explicit target mailbox.
 *
 * Exits non-zero if a CONFIGURED provider fails. A provider with no credential
 * is reported as NOT CONFIGURED, which is a blocker to report, not a crash.
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: '.env', quiet: true });

const { getConfig, canSendRealEmail } = await import('../lib/config');
const { getDb, closeDb } = await import('../lib/db');
const { runMigrations } = await import('../lib/migrate');
const { newId } = await import('../lib/hash');
const { getSearchProvider, search } = await import('../lib/search/index');
const { getLlmProvider, llmComplete } = await import('../lib/llm/index');
const { getEmailProvider } = await import('../lib/email/index');
const { getRuntimeState, getSubsystemHealth } = await import('../autonomy/runtime');
const { getBudgetReport } = await import('../autonomy/budget');
const { z } = await import('zod');

type Status = 'HEALTHY' | 'FAILED' | 'NOT CONFIGURED';

interface Row {
  provider: string;
  status: Status;
  detail: string;
  /** What the operator must do. Empty when healthy. */
  action: string;
}
const rows: Row[] = [];
function record(provider: string, status: Status, detail: string, action = ''): void {
  rows.push({ provider, status, detail, action });
}

async function main(): Promise<void> {
  const cfg = getConfig();

  // --- DATABASE: write, read, delete one canary row -------------------------
  try {
    await runMigrations();
    const db = await getDb();
    const id = newId('health');
    await db.query(
      `INSERT INTO audit_events (id, entity_type, event_type, actor, reason, detail_json)
       VALUES ($1,'system','DECISION','providers_health','provider health canary row', $2)`,
      [id, JSON.stringify({ canary: true })],
    );
    const readBack = await db.query<{ id: string }>('SELECT id FROM audit_events WHERE id = $1', [id]);
    const found = readBack.rows[0]?.id === id;
    const deleted = await db.query('DELETE FROM audit_events WHERE id = $1', [id]);
    const gone = await db.query<{ n: string }>('SELECT COUNT(*) AS n FROM audit_events WHERE id = $1', [id]);
    const clean = Number(gone.rows[0]?.n ?? 0) === 0;

    record(
      'DATABASE',
      found && clean ? 'HEALTHY' : 'FAILED',
      `${db.kind}: wrote, read back ${found ? 'ok' : 'FAILED'}, deleted ${deleted.rowCount} row, ` +
        `cleanup ${clean ? 'ok' : 'FAILED'}`,
      found && clean ? '' : 'Investigate database write/delete permissions.',
    );
  } catch (err) {
    record('DATABASE', 'FAILED', String(err).slice(0, 200), 'Check DATABASE_URL, or unset it to use local PGlite.');
  }

  // --- SEARCH: one real public query ----------------------------------------
  const searchProvider = getSearchProvider();
  if (searchProvider.name === 'mock') {
    record(
      'SEARCH',
      'NOT CONFIGURED',
      'provider resolved to the mock; no real search is possible',
      'Set BRAVE_SEARCH_API_KEY and SEARCH_PROVIDER=brave.',
    );
  } else {
    try {
      const results = await search('shopify minimum order quantity app pricing', 3);
      record(
        'SEARCH',
        results.length > 0 ? 'HEALTHY' : 'FAILED',
        `${searchProvider.name}: ${results.length} result(s)${results[0] ? ` — first: ${results[0].url}` : ''}`,
        results.length > 0 ? '' : 'The key is accepted but returned nothing. Check the plan and quota.',
      );
    } catch (err) {
      record('SEARCH', 'FAILED', `${searchProvider.name}: ${String(err).slice(0, 200)}`, 'Check BRAVE_SEARCH_API_KEY and quota.');
    }
  }

  // --- LLM: one tiny structured-output classification ------------------------
  const llmProvider = getLlmProvider();
  if (llmProvider.name === 'mock') {
    record(
      'LLM',
      'NOT CONFIGURED',
      'provider resolved to the mock; every classification would be fabricated',
      'Set ANTHROPIC_API_KEY and LLM_PROVIDER=anthropic.',
    );
  } else {
    try {
      const res = await llmComplete({
        tier: 'fast',
        task: 'providers.health',
        schemaName: 'HealthProbe',
        maxTokens: 64,
        schema: z.object({ sentiment: z.enum(['POSITIVE', 'NEGATIVE', 'NEUTRAL']) }),
        system: 'Classify the sentiment of the text. Answer with the schema only.',
        user: 'Text: "this is exactly what we needed, thank you"',
        cacheable: false,
      });
      record(
        'LLM',
        'HEALTHY',
        `${res.model}: sentiment=${res.data.sentiment}, ${res.inputTokens}in/${res.outputTokens}out, ` +
          `$${res.estimatedCost.toFixed(6)}`,
        '',
      );
    } catch (err) {
      record('LLM', 'FAILED', `${llmProvider.name}: ${String(err).slice(0, 200)}`, 'Check ANTHROPIC_API_KEY and credit.');
    }
  }

  // --- RESEND OUTBOUND: gate + key, without sending -------------------------
  const emailProvider = getEmailProvider();
  const gate = canSendRealEmail(cfg);
  if (emailProvider.name === 'mock') {
    record(
      'RESEND OUTBOUND',
      'NOT CONFIGURED',
      `send gate closed: ${gate.reason ?? 'unknown'}`,
      'Set the configuration the gate names, then run: npm run canary:email',
    );
  } else {
    record(
      'RESEND OUTBOUND',
      'HEALTHY',
      'real provider resolved and every send precondition holds',
      'Prove the round trip with: npm run canary:email',
    );
  }

  // --- RESEND INBOUND: signing secret + reachable webhook path ---------------
  record(
    'RESEND INBOUND',
    cfg.resendInboundWebhookSecret ? 'HEALTHY' : 'NOT CONFIGURED',
    cfg.resendInboundWebhookSecret
      ? `signing secret present; route ${cfg.publicBaseUrl}/api/webhooks/resend-inbound`
      : 'RESEND_INBOUND_WEBHOOK_SECRET not set — replies cannot be received at all',
    cfg.resendInboundWebhookSecret
      ? ''
      : `Create an inbound webhook in Resend pointing at ${cfg.publicBaseUrl}/api/webhooks/resend-inbound.`,
  );

  // --- OWNER NOTIFICATION ---------------------------------------------------
  record(
    'OWNER NOTIFICATION',
    cfg.ownerNotificationEmail ? (emailProvider.name === 'mock' ? 'NOT CONFIGURED' : 'HEALTHY') : 'NOT CONFIGURED',
    cfg.ownerNotificationEmail
      ? `target ${cfg.ownerNotificationEmail}${emailProvider.name === 'mock' ? ' (but the provider is a mock, so nothing would arrive)' : ''}`
      : 'OWNER_NOTIFICATION_EMAIL not set — a validated opportunity could not be reported',
    cfg.ownerNotificationEmail && emailProvider.name !== 'mock' ? '' : 'Set OWNER_NOTIFICATION_EMAIL and a real email provider.',
  );

  // --- CRON / SCHEDULER -----------------------------------------------------
  const { JOB_NAMES } = await import('../jobs/registry');
  const supervisorRegistered = (JOB_NAMES as readonly string[]).includes('supervisor');
  record(
    'CRON/SCHEDULER',
    cfg.cronSecret && supervisorRegistered ? 'HEALTHY' : 'NOT CONFIGURED',
    `CRON_SECRET ${cfg.cronSecret ? 'present' : 'MISSING'}; ` +
      `supervisor job ${supervisorRegistered ? 'registered' : 'NOT REGISTERED'}; ` +
      `endpoint ${cfg.publicBaseUrl}/api/cron?job=supervisor; interval ${cfg.supervisorIntervalMinutes}m`,
    cfg.cronSecret
      ? ''
      : 'Set CRON_SECRET here and as the APP_BASE_URL/CRON_SECRET secrets on the scheduler.',
  );

  // --- RUNTIME --------------------------------------------------------------
  try {
    const state = await getRuntimeState();
    const health = await getSubsystemHealth();
    const degraded = health.filter((h) => h.status !== 'OK');
    record(
      'RUNTIME',
      'HEALTHY',
      `state=${state.state}; subsystems tracked=${health.length}` +
        (degraded.length > 0 ? `; degraded=${degraded.map((d) => d.subsystem).join(', ')}` : ''),
      '',
    );
  } catch (err) {
    record('RUNTIME', 'FAILED', String(err).slice(0, 200), 'Run: npm run migrate');
  }

  // --- BUDGET ---------------------------------------------------------------
  try {
    const budget = await getBudgetReport();
    record(
      'BUDGET',
      budget.exhausted ? 'FAILED' : 'HEALTHY',
      `$${budget.globalRemainingUsd.toFixed(4)} remaining of $${budget.globalBudgetUsd} ` +
        `(spent $${budget.globalSpentUsd.toFixed(4)})`,
      budget.exhausted ? 'The monthly ceiling is reached; spending is paused until the period rolls.' : '',
    );
  } catch (err) {
    record('BUDGET', 'FAILED', String(err).slice(0, 200), '');
  }

  // --- print ----------------------------------------------------------------
  const width = {
    provider: Math.max(10, ...rows.map((r) => r.provider.length)),
    status: 15,
  };
  console.log('');
  console.log('='.repeat(100));
  console.log('  PROVIDER HEALTH');
  console.log('='.repeat(100));
  console.log(
    `  ${'PROVIDER'.padEnd(width.provider)}  ${'STATUS'.padEnd(width.status)}  DETAIL`,
  );
  console.log(`  ${'-'.repeat(width.provider)}  ${'-'.repeat(width.status)}  ${'-'.repeat(60)}`);
  for (const r of rows) {
    console.log(`  ${r.provider.padEnd(width.provider)}  ${r.status.padEnd(width.status)}  ${r.detail}`);
  }

  const failed = rows.filter((r) => r.status === 'FAILED');
  const missing = rows.filter((r) => r.status === 'NOT CONFIGURED');

  if (missing.length > 0) {
    console.log('');
    console.log('  NOT CONFIGURED — owner action required:');
    for (const r of missing) console.log(`    - ${r.provider}: ${r.action}`);
  }
  if (failed.length > 0) {
    console.log('');
    console.log('  FAILED — configured but not working:');
    for (const r of failed) console.log(`    - ${r.provider}: ${r.detail}${r.action ? ` -> ${r.action}` : ''}`);
  }

  console.log('');
  console.log('='.repeat(100));
  console.log(
    `  ${rows.filter((r) => r.status === 'HEALTHY').length}/${rows.length} healthy, ` +
      `${missing.length} not configured, ${failed.length} failed`,
  );
  console.log('='.repeat(100));

  // A configured-but-broken provider is a hard failure. A missing credential is
  // reported for the owner and also fails, because the system cannot run on it.
  if (failed.length > 0 || missing.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error(`\nprovider health error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => undefined);
}
