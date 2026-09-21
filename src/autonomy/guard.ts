/**
 * PUBLIC API — CONTROL-PLANE GUARD. Owned by the strategy agent.
 *
 * Adaptive does not mean unconstrained. Every strategy mutation passes through
 * here, and anything naming a control-plane field is refused.
 *
 * The check is deliberately paranoid about SHAPE rather than about intent:
 *   - it walks nested objects and arrays to any depth, because a forbidden key
 *     hidden three levels down is still a forbidden key;
 *   - it compares keys case-insensitively with `_` and `-` removed, so
 *     `maxEmailsPerDay`, `max_emails_per_day` and `MAX-EMAILS-PER-DAY` are the
 *     same field and all three are refused.
 *
 * There is no allow-list override and no "force" flag. If a control-plane value
 * genuinely needs to change, a human edits typed code or env.
 */
import { FORBIDDEN_STRATEGY_FIELDS } from './types';

export class ControlPlaneViolation extends Error {
  readonly field: string;
  constructor(field: string, context: string) {
    super(
      `control-plane field "${field}" may not be written by the strategy plane (${context}). ` +
        'Gate thresholds, budgets, send ceilings, suppression and secrets are typed code and env.',
    );
    this.name = 'ControlPlaneViolation';
    this.field = field;
  }
}

/** Lowercased, separator-free form used for every comparison. */
function normalizeKey(key: string): string {
  return key.replace(/[\s_-]+/g, '').toLowerCase();
}

/** normalized form -> canonical name, so the error names the real field. */
const FORBIDDEN_BY_NORMALIZED: ReadonlyMap<string, string> = new Map(
  FORBIDDEN_STRATEGY_FIELDS.map((f) => [normalizeKey(f), f]),
);

/**
 * Free text is scanned too, but only for names long enough that a substring hit
 * cannot be a coincidence. Short names such as "gate" are caught as object keys
 * and are not worth the false positives in prose.
 */
const MIN_MENTION_LENGTH = 8;

const MENTIONABLE: ReadonlyArray<{ normalized: string; canonical: string }> = [
  ...FORBIDDEN_BY_NORMALIZED.entries(),
]
  .filter(([normalized]) => normalized.length >= MIN_MENTION_LENGTH)
  .map(([normalized, canonical]) => ({ normalized, canonical }));

/** Depth ceiling. A strategy config nested deeper than this is malformed anyway. */
const MAX_DEPTH = 12;

/**
 * Every forbidden key anywhere inside `config`, by canonical name, deduped and
 * in the order FORBIDDEN_STRATEGY_FIELDS declares them.
 */
export function findForbiddenFields(config: unknown): string[] {
  const found = new Set<string>();
  walk(config, 0, found);
  return FORBIDDEN_STRATEGY_FIELDS.filter((f) => found.has(f));
}

function walk(value: unknown, depth: number, found: Set<string>): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const item of value) walk(item, depth + 1, found);
    return;
  }

  // Map/Set carry keys too; treat their entries like plain entries.
  if (value instanceof Map) {
    for (const [k, v] of value.entries()) {
      if (typeof k === 'string') flag(k, found);
      walk(v, depth + 1, found);
    }
    return;
  }
  if (value instanceof Set) {
    for (const item of value.values()) walk(item, depth + 1, found);
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flag(key, found);
    walk(child, depth + 1, found);
  }
}

function flag(key: string, found: Set<string>): void {
  const canonical = FORBIDDEN_BY_NORMALIZED.get(normalizeKey(key));
  if (canonical) found.add(canonical);
}

/**
 * Forbidden fields named in prose — "raise max emails per day", "MAX_FOLLOWUPS
 * should be 4". An LLM proposal that argues for a control-plane change is
 * rejected before anything is spent on it.
 */
export function findForbiddenMentions(text: string): string[] {
  const collapsed = text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (collapsed === '') return [];
  const found = new Set<string>();
  for (const { normalized, canonical } of MENTIONABLE) {
    if (collapsed.includes(normalized)) found.add(canonical);
  }
  return FORBIDDEN_STRATEGY_FIELDS.filter((f) => found.has(f));
}

/** Throws ControlPlaneViolation if the object touches a forbidden field. */
export function assertStrategyOnly(
  config: Record<string, unknown>,
  context: string,
): void {
  const offending = findForbiddenFields(config);
  if (offending.length > 0) {
    throw new ControlPlaneViolation(offending.join(', '), context);
  }
}
