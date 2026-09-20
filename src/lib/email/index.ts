/**
 * Outbound email transport.
 *
 * This module is dumb on purpose: it sends what it is given. Every compliance
 * decision (suppression, country, sending window, footer, unsubscribe header,
 * batch health) happens upstream in src/pipeline/outreach. The one thing it
 * does enforce is that the mock provider is used whenever the system is not
 * fully cleared to send, so shadow mode physically cannot emit a real email.
 */
import { canSendRealEmail, getConfig } from '../config';
import { createLogger } from '../logger';
import { ProviderError } from '../errors';
import { recordCost } from '../cost';

const logger = createLogger('email');

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** For threading a reply onto an existing conversation. */
  inReplyTo?: string;
  references?: string;
  tags?: Record<string, string>;
}

export interface SendResult {
  providerMessageId: string;
  provider: string;
  simulated: boolean;
}

export interface EmailProvider {
  readonly name: string;
  send(email: OutboundEmail): Promise<SendResult>;
}

export class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  private client: { emails: { send: (o: Record<string, unknown>) => Promise<{ data?: { id?: string } | null; error?: { message?: string; name?: string } | null }> } } | null = null;

  private async getClient() {
    if (!this.client) {
      const cfg = getConfig();
      if (!cfg.resendApiKey) throw new ProviderError('resend', 'RESEND_API_KEY is not set', false);
      const { Resend } = await import('resend');
      this.client = new Resend(cfg.resendApiKey) as unknown as NonNullable<typeof this.client>;
    }
    return this.client;
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    const cfg = getConfig();
    const client = await this.getClient();
    const from = cfg.ownerName
      ? `${cfg.ownerName} <${cfg.senderEmail}>`
      : cfg.senderEmail;

    const payload: Record<string, unknown> = {
      from,
      to: [email.to],
      subject: email.subject,
      text: email.text, // plain text only, by policy
      headers: {
        ...(email.headers ?? {}),
        ...(email.inReplyTo ? { 'In-Reply-To': email.inReplyTo } : {}),
        ...(email.references ? { References: email.references } : {}),
      },
    };
    if (email.replyTo) payload.replyTo = email.replyTo;
    if (email.tags) {
      payload.tags = Object.entries(email.tags).map(([name, value]) => ({ name, value }));
    }

    const res = await client.emails.send(payload);
    if (res.error || !res.data?.id) {
      const msg = res.error?.message ?? 'no message id returned';
      const retryable = /rate|timeout|5\d\d|temporar/i.test(msg);
      throw new ProviderError('resend', msg, retryable);
    }
    return { providerMessageId: res.data.id, provider: 'resend', simulated: false };
  }
}

/** Records what *would* have been sent. Used by shadow mode and every test. */
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';
  readonly sent: OutboundEmail[] = [];
  private counter = 0;
  /** Set to make the next send throw, for retry/bounce tests. */
  failNext: Error | null = null;

  async send(email: OutboundEmail): Promise<SendResult> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.sent.push(email);
    this.counter += 1;
    logger.info('SHADOW: email not sent (mock provider)', {
      to: email.to,
      subject: email.subject,
      bytes: email.text.length,
    });
    return { providerMessageId: `mock-${this.counter}-${Date.now()}`, provider: 'mock', simulated: true };
  }

  reset(): void {
    this.sent.length = 0;
    this.counter = 0;
    this.failNext = null;
  }
}

let provider: EmailProvider | null = null;

/**
 * Returns the real provider ONLY when canSendRealEmail() says every safety
 * precondition holds. Otherwise the mock. This is the physical stop.
 */
export function getEmailProvider(): EmailProvider {
  if (!provider) {
    const gate = canSendRealEmail();
    if (gate.ok) {
      provider = new ResendProvider();
    } else {
      provider = new MockEmailProvider();
      logger.warn('email provider is MOCK — no real email can be sent', { reason: gate.reason });
    }
  }
  return provider;
}

export function setEmailProvider(p: EmailProvider | null): void {
  provider = p;
}

/** Sends and records the cost-ledger row. Does not touch suppression. */
export async function sendEmail(email: OutboundEmail): Promise<SendResult> {
  const p = getEmailProvider();
  const result = await p.send(email);
  await recordCost({
    provider: result.simulated ? 'mock' : 'resend',
    resourceType: 'EMAIL_SENT',
    quantity: 1,
    estimatedCost: 0, // Resend free tier; update here if a paid plan is added
    metadata: { to: hashRecipient(email.to), simulated: result.simulated },
  });
  return result;
}

/** Never put a raw prospect address into the cost ledger metadata. */
function hashRecipient(email: string): string {
  const [, domain] = email.split('@');
  return `***@${domain ?? 'unknown'}`;
}
