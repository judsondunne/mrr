/**
 * PUBLIC API — PROMPT-INJECTION DEFENCE. Owned by the security agent.
 *
 * Merchant sites, reviews, search results and inbound email are UNTRUSTED.
 * Nothing in them is ever an instruction. This module is the chokepoint that
 * makes that true in practice rather than in a comment.
 */
export interface SanitizedContent {
  text: string;
  /** Patterns that looked like an injection attempt, for audit. */
  suspicious: string[];
  truncated: boolean;
}

/**
 * Strips markup/scripts/hidden text, neutralises fence-escape attempts, caps
 * length, and reports anything that looked like an instruction.
 */
export declare function sanitizeExternalText(raw: string, maxChars?: number): SanitizedContent;

/** Heuristic detector for known injection shapes. Reports; never obeys. */
export declare function detectInjection(raw: string): string[];

/** True when the text tries to extract secrets or reach an internal surface. */
export declare function mentionsSensitiveTarget(raw: string): boolean;

/** Records an attempt for the audit trail. Never notifies the owner routinely. */
export declare function recordInjectionAttempt(params: {
  sourceUrl: string | null;
  context: string;
  patterns: string[];
  excerpt: string;
}): Promise<void>;
