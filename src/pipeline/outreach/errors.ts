/**
 * Typed errors for the outreach layer.
 *
 * Every one of these means "a real email was about to leave the system and
 * something was wrong with it". They are deliberately non-retryable: the fix is
 * always a code or configuration change, never a retry.
 */
import { AppError } from '../../lib/errors.js';

/** A message failed the code-level compliance validator. It must not be sent. */
export class ComplianceError extends AppError {
  constructor(readonly violations: readonly string[], detail: Record<string, unknown> = {}) {
    super(`outbound message failed compliance: ${violations.join('; ')}`, 'COMPLIANCE_FAILED', false, {
      ...detail,
      violations: [...violations],
    });
  }
}

/** A webhook payload could not be authenticated. It must not be processed. */
export class WebhookVerificationError extends AppError {
  constructor(reason: string, detail: Record<string, unknown> = {}) {
    super(`webhook rejected: ${reason}`, 'WEBHOOK_UNVERIFIED', false, detail);
  }
}

/** A generated reply draft made a claim the stored offer does not support. */
export class ReplySafetyError extends AppError {
  constructor(readonly violations: readonly string[]) {
    super(`auto-reply draft rejected: ${violations.join('; ')}`, 'REPLY_UNSAFE', false, {
      violations: [...violations],
    });
  }
}
