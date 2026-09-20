/**
 * Configuration STATUS for /admin/settings.
 *
 * THE RULE: a secret's value never leaves this module — not in full, not
 * partially, not masked with a prefix. `secretRow()` is the only way a
 * credential-shaped setting can be rendered, and it emits the literal string
 * 'set' or 'not set' and nothing else. There is deliberately no code path that
 * copies a secret into the returned structure.
 */
import { getConfig, canSendRealEmail, isShadowMode } from '@/lib/config';

export type RowKind = 'flag' | 'value' | 'secret';

export interface SettingRow {
  label: string;
  /** Already display-safe. Never a credential. */
  value: string;
  kind: RowKind;
  /** true/false colours the row; null means "not a pass/fail thing". */
  ok: boolean | null;
}

export interface SettingsGroup {
  title: string;
  rows: SettingRow[];
}

function secretRow(label: string, present: unknown): SettingRow {
  const isSet = typeof present === 'string' ? present.trim() !== '' : Boolean(present);
  return { label, value: isSet ? 'set' : 'not set', kind: 'secret', ok: isSet };
}

function flagRow(label: string, value: boolean, okWhen: boolean | null = null): SettingRow {
  return {
    label,
    value: value ? 'true' : 'false',
    kind: 'flag',
    ok: okWhen === null ? null : value === okWhen,
  };
}

function valueRow(label: string, value: string | number): SettingRow {
  return { label, value: String(value), kind: 'value', ok: null };
}

export function buildSettingsStatus(): SettingsGroup[] {
  const cfg = getConfig();
  const sendable = canSendRealEmail(cfg);

  return [
    {
      title: 'Safety switches',
      rows: [
        flagRow('AUTONOMY_ENABLED', cfg.autonomyEnabled),
        flagRow('OUTREACH_ENABLED', cfg.outreachEnabled),
        flagRow('KILL_SWITCH', cfg.killSwitch, false),
        flagRow('EXTREME_VALIDATION', cfg.gate.extremeValidation),
        flagRow('ENABLE_PAYMENT_METHOD_VALIDATION', cfg.enablePaymentMethodValidation),
        flagRow('Shadow mode (derived)', isShadowMode(cfg)),
        {
          label: 'Real email allowed (derived)',
          value: sendable.ok ? 'yes' : `no — ${sendable.reason ?? 'blocked'}`,
          kind: 'value',
          ok: sendable.ok,
        },
      ],
    },
    {
      title: 'Credentials (status only — values are never rendered)',
      rows: [
        secretRow('DATABASE_URL', cfg.databaseUrl),
        secretRow('ANTHROPIC_API_KEY', cfg.anthropicApiKey),
        secretRow('BRAVE_SEARCH_API_KEY', cfg.braveSearchApiKey),
        secretRow('RESEND_API_KEY', cfg.resendApiKey),
        secretRow('RESEND_WEBHOOK_SECRET', cfg.resendWebhookSecret),
        secretRow('RESEND_INBOUND_WEBHOOK_SECRET', cfg.resendInboundWebhookSecret),
        secretRow('ADMIN_TOKEN', cfg.adminToken),
        secretRow('CRON_SECRET', cfg.cronSecret),
        secretRow('UNSUBSCRIBE_SECRET', cfg.unsubscribeSecret),
        secretRow('STRIPE_SECRET_KEY', cfg.stripeSecretKey),
        secretRow('STRIPE_PUBLISHABLE_KEY', cfg.stripePublishableKey),
        secretRow('OWNER_NOTIFICATION_EMAIL', cfg.ownerNotificationEmail),
        secretRow('SENDER_POSTAL_ADDRESS', cfg.senderPostalAddress),
      ],
    },
    {
      title: 'Providers',
      rows: [
        valueRow('DATABASE_MODE', cfg.databaseMode),
        valueRow('LLM_PROVIDER', cfg.llmProvider),
        valueRow('LLM_FAST', cfg.llmFast),
        valueRow('LLM_REASONER', cfg.llmReasoner),
        valueRow('SEARCH_PROVIDER', cfg.searchProvider),
        valueRow('EMAIL_PROVIDER', cfg.emailProvider),
      ],
    },
    {
      title: 'Sending identity',
      rows: [
        valueRow('PUBLIC_BASE_URL', cfg.publicBaseUrl),
        valueRow('SENDING_DOMAIN', cfg.sendingDomain || '(unset)'),
        valueRow('SENDER_EMAIL', cfg.senderEmail || '(unset)'),
        valueRow('SENDER_COMPANY', cfg.senderCompany || '(unset)'),
        valueRow('ALLOWED_OUTREACH_COUNTRIES', cfg.allowedOutreachCountries.join(', ')),
        valueRow(
          'Sending window',
          `${cfg.sendingWindowStartHour}:00–${cfg.sendingWindowEndHour}:00 ${cfg.sendingTimezone}` +
            `${cfg.sendingWeekdaysOnly ? ', weekdays only' : ''}`,
        ),
      ],
    },
    {
      title: 'Budgets and volume caps',
      rows: [
        valueRow('MONTHLY_LLM_BUDGET_USD', cfg.monthlyLlmBudgetUsd),
        valueRow('MONTHLY_SEARCH_BUDGET_USD', cfg.monthlySearchBudgetUsd),
        valueRow('MAX_EMAILS_PER_DAY', cfg.maxEmailsPerDay),
        valueRow('MAX_NEW_CAMPAIGNS_PER_WEEK', cfg.maxNewCampaignsPerWeek),
        valueRow('MAX_EMAILS_PER_CAMPAIGN', cfg.maxEmailsPerCampaign),
        valueRow(
          'Batches',
          `${cfg.initialEmailBatch} → ${cfg.secondEmailBatch} → ${cfg.maxEmailsPerCampaign}`,
        ),
        valueRow('MAX_FOLLOWUPS', cfg.maxFollowups),
      ],
    },
    {
      title: 'READY_TO_BUILD gate thresholds',
      rows: [
        valueRow('MIN_UNIQUE_STRONG_COMMITMENTS', cfg.gate.minUniqueStrongCommitments),
        valueRow('MIN_UNIQUE_PRICE_ACCEPTANCES', cfg.gate.minUniquePriceAcceptances),
        valueRow('MIN_UNIQUE_ACTION_COMMITMENTS', cfg.gate.minUniqueActionCommitments),
        valueRow(
          'MIN_DELIVERED_BEFORE_STANDARD_EVALUATION',
          cfg.gate.minDeliveredBeforeStandardEvaluation,
        ),
        valueRow('MIN_QUALIFIED_PROSPECTS_FOR_GATE', cfg.gate.minQualifiedProspects),
        valueRow('MIN_POSITIVE_INTENT_RATE', cfg.gate.minPositiveIntentRate),
        valueRow(
          'REQUIRED_CATEGORY_EVIDENCE_CONFIDENCE',
          cfg.gate.requiredCategoryEvidenceConfidence,
        ),
        valueRow('MAX_MVP_BUILD_DAYS', cfg.gate.maxMvpBuildDays),
      ],
    },
    {
      title: 'Campaign health limits',
      rows: [
        valueRow('MAX_HARD_BOUNCE_RATE', cfg.health.maxHardBounceRate),
        valueRow('MAX_COMPLAINT_RATE', cfg.health.maxComplaintRate),
        valueRow('MAX_UNSUBSCRIBE_RATE', cfg.health.maxUnsubscribeRate),
      ],
    },
  ];
}
