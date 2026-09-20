/**
 * One-click unsubscribe.
 *
 * Token format:  base64url(email) . hmac-sha256-hex(secret, base64url(email))
 *
 * The address is carried encoded rather than as a plaintext query parameter,
 * and the signature makes the token unforgeable: without UNSUBSCRIBE_SECRET
 * nobody can mint a token that suppresses somebody else's address, and nobody
 * can edit the address half of a token without invalidating the signature.
 *
 * Verification is constant-time (safeCompare) and happens BEFORE the address is
 * decoded into anything that touches the database.
 */
import { getConfig } from '../../lib/config';
import { hmacSign, safeCompare } from '../../lib/hash';
import { createLogger } from '../../lib/logger';
import { normalizeEmail, suppress } from './suppression';

const logger = createLogger('outreach:unsubscribe');

/** The web layer mounts its route here. Keep these two in sync with it. */
export const UNSUBSCRIBE_PATH = '/api/unsubscribe';
export const UNSUBSCRIBE_TOKEN_PARAM = 't';

/**
 * Real sends are already blocked by canSendRealEmail() unless UNSUBSCRIBE_SECRET
 * is set, so an unset secret can only ever occur in shadow mode / local runs.
 * Rather than crash drafting (shadow mode must still produce complete,
 * inspectable emails) we fall back to a clearly-labelled deployment-stable
 * value and warn loudly.
 */
function unsubscribeSecret(): string {
  const cfg = getConfig();
  if (cfg.unsubscribeSecret !== '') return cfg.unsubscribeSecret;
  logger.warn('UNSUBSCRIBE_SECRET is not set — using a shadow-mode-only fallback key');
  return `shadow-mode-unsigned::${cfg.publicBaseUrl}`;
}

function encodeEmail(email: string): string {
  return Buffer.from(normalizeEmail(email), 'utf8').toString('base64url');
}

function decodeEmail(payload: string): string | null {
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    // Re-encoding must round-trip, otherwise the payload was not a clean
    // base64url string and we refuse to guess what it meant.
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== payload) return null;
    const email = normalizeEmail(decoded);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  } catch {
    return null;
  }
}

/** `base64url(email).signature` — safe to put in a URL. */
export function buildUnsubscribeToken(email: string): string {
  const payload = encodeEmail(email);
  return `${payload}.${hmacSign(unsubscribeSecret(), payload)}`;
}

/** Returns the address the token was minted for, or null if it is not genuine. */
export function verifyUnsubscribeToken(token: string): string | null {
  if (typeof token !== 'string' || token === '') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = hmacSign(unsubscribeSecret(), payload);
  if (!safeCompare(signature, expected)) return null;
  return decodeEmail(payload);
}

/** The absolute URL that goes in the body AND in the List-Unsubscribe header. */
export function buildUnsubscribeUrl(email: string): string {
  const cfg = getConfig();
  const token = buildUnsubscribeToken(email);
  return `${cfg.publicBaseUrl}${UNSUBSCRIBE_PATH}?${UNSUBSCRIBE_TOKEN_PARAM}=${token}`;
}

/** Pulls the token back out of a rendered email body, for the compliance check. */
export function extractUnsubscribeToken(text: string): string | null {
  const pattern = new RegExp(
    `${UNSUBSCRIBE_PATH.replace(/\//g, '\\/')}\\?${UNSUBSCRIBE_TOKEN_PARAM}=([A-Za-z0-9._~-]+)`,
  );
  const match = pattern.exec(text);
  return match?.[1] ?? null;
}

/**
 * RFC 8058 one-click headers. The provider (and Gmail/Outlook) POST to the URL;
 * the address is suppressed with no further interaction from the recipient.
 */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * Verifies then suppresses. Never reveals whether an address was on file:
 * an invalid token simply returns ok:false with no address.
 */
export async function processUnsubscribe(token: string): Promise<{ ok: boolean; email: string | null }> {
  const email = verifyUnsubscribeToken(token);
  if (!email) {
    logger.warn('rejected an unsubscribe token that did not verify');
    return { ok: false, email: null };
  }
  await suppress({ email, reason: 'UNSUBSCRIBE', notes: 'one-click unsubscribe link' });
  return { ok: true, email };
}
