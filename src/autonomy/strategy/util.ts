/**
 * Small deterministic helpers shared by the strategy modules.
 *
 * Everything here is pure. Learning must be reproducible from the same inputs,
 * so nothing in this file reads the clock, the network, or Math.random.
 */

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** JSONB comes back parsed on one driver and as text on the other. */
export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/**
 * Words too common to carry meaning in a category / ICP / wedge description.
 * Keeping this list short and boring is the point — it is a similarity key,
 * not a language model.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'their', 'they',
  'them', 'are', 'was', 'were', 'has', 'have', 'had', 'but', 'not', 'you',
  'your', 'our', 'its', 'who', 'which', 'when', 'what', 'how', 'why', 'all',
  'any', 'can', 'will', 'would', 'should', 'could', 'more', 'most', 'other',
  'than', 'then', 'there', 'here', 'each', 'every', 'per', 'via', 'use',
  'using', 'used', 'app', 'apps', 'tool', 'tools', 'thing', 'things', 'stuff',
  'general', 'generic', 'simple', 'basic', 'new', 'old',
]);

/** Crude plural fold so "apps" and "app" are one token. No stemmer library. */
function fold(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * The similarity key for an idea. Deterministic, order-independent, and sorted
 * so two runs over the same inputs produce a byte-identical token list.
 */
export function normalizeTokens(...parts: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const raw of part.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3) continue;
      const word = fold(raw);
      if (word.length < 3 || STOPWORDS.has(word)) continue;
      out.add(word);
    }
  }
  return [...out].sort();
}

/** |A ∩ B| / |A ∪ B|. Two empty sets are not similar; they are unknown. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const left = new Set(a);
  const right = new Set(b);
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Relative gap between two prices, on the larger of the two. */
export function relativePriceGap(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const hi = Math.max(Math.abs(a), Math.abs(b));
  if (hi === 0) return 0;
  return Math.abs(a - b) / hi;
}
