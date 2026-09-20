/**
 * Claim-language guard.
 *
 * The system may report what real businesses did. It may never promise what
 * will happen. "Guaranteed MRR" is the exact sentence this codebase exists to
 * never write, so the rendered owner email is scanned before it can be sent and
 * the send is aborted if any promise language survived.
 *
 * The strongest claim permitted anywhere in this system is:
 *   "VALIDATED — X real businesses explicitly indicated they are prepared to
 *    use this at $Y/month."
 */
import { SafetyError } from '../../lib/errors';

export interface ClaimPattern {
  label: string;
  pattern: RegExp;
}

export const FORBIDDEN_CLAIM_PATTERNS: readonly ClaimPattern[] = [
  { label: 'guarantee', pattern: /guarantee/i },
  { label: 'will earn/make/generate', pattern: /\bwill\s+(earn|make|generate|produce|bring in)\b/i },
  { label: 'risk-free', pattern: /\brisk[-\s]?free\b/i },
  { label: 'no risk', pattern: /\bno\s+risk\b/i },
  { label: 'assured income/revenue', pattern: /\bassured\b/i },
  { label: 'passive income', pattern: /\bpassive\s+income\b/i },
  { label: 'certain to', pattern: /\bcertain\s+to\b/i },
  { label: 'sure thing', pattern: /\bsure\s+thing\b/i },
  { label: 'cannot lose', pattern: /\bcan(no|')?t\s+lose\b/i },
  { label: 'promised revenue', pattern: /\bpromis(e|ed|es)\s+(you\s+)?(revenue|income|mrr|money)\b/i },
  { label: 'locked-in revenue', pattern: /\blocked[-\s]?in\s+(revenue|mrr|income)\b/i },
];

/** Returns every forbidden claim label found in `text`. Empty means clean. */
export function findClaimLanguage(text: string): string[] {
  return FORBIDDEN_CLAIM_PATTERNS.filter((p) => p.pattern.test(text)).map((p) => p.label);
}

export function containsClaimLanguage(text: string): boolean {
  return findClaimLanguage(text).length > 0;
}

/**
 * Hard stop. Called on the fully rendered body immediately before it is stored
 * or sent; throws rather than letting a promise reach the owner's inbox.
 */
export function assertNoGuaranteeLanguage(body: string, context = 'owner email'): void {
  const found = findClaimLanguage(body);
  if (found.length > 0) {
    throw new SafetyError(
      `refusing to send ${context}: it contains claim language (${found.join(', ')}). This system reports what real businesses did; it never promises revenue.`,
      { found },
    );
  }
}
