/**
 * Polite HTTP fetching.
 *
 * - honours robots.txt (cached per origin)
 * - per-origin rate limiting
 * - exponential backoff with jitter on retryable failures
 * - hard timeout
 * - size cap, so one pathological page cannot exhaust memory
 * - NEVER executes scripts; the caller gets inert text/HTML
 */
import { getConfig } from './config';
import { FetchError } from './errors';
import { createLogger } from './logger';

const logger = createLogger('fetch');

const lastRequestAt = new Map<string, number>();
const robotsCache = new Map<string, { rules: RobotRule[]; fetchedAt: number }>();
const ROBOTS_TTL_MS = 6 * 3600_000;
const MAX_BYTES = 3_000_000;

interface RobotRule {
  allow: boolean;
  path: string;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  body: string;
  contentType: string;
  fetchedAt: Date;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttle(origin: string): Promise<void> {
  const cfg = getConfig();
  const last = lastRequestAt.get(origin) ?? 0;
  const wait = cfg.fetchMinDelayMs - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(origin, Date.now());
}

function parseRobots(text: string, agent: string): RobotRule[] {
  const rules: RobotRule[] = [];
  let applies = false;
  const agentLower = agent.toLowerCase();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      applies = value === '*' || agentLower.includes(value.toLowerCase());
    } else if (applies && (field === 'allow' || field === 'disallow')) {
      if (value) rules.push({ allow: field === 'allow', path: value });
    }
  }
  return rules;
}

/** Longest-match-wins, per the de-facto robots.txt standard. */
export function robotsAllows(rules: RobotRule[], pathname: string): boolean {
  let best: RobotRule | null = null;
  for (const rule of rules) {
    if (!pathname.startsWith(rule.path)) continue;
    if (!best || rule.path.length > best.path.length) best = rule;
  }
  return best ? best.allow : true;
}

async function getRobots(origin: string): Promise<RobotRule[]> {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached.rules;

  const cfg = getConfig();
  let rules: RobotRule[] = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': cfg.userAgent },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (res.ok) rules = parseRobots(await res.text(), cfg.userAgent);
  } catch {
    rules = []; // no robots.txt reachable => treat as unrestricted
  }
  robotsCache.set(origin, { rules, fetchedAt: Date.now() });
  return rules;
}

export async function isAllowedByRobots(url: string): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg.respectRobotsTxt) return true;
  try {
    const u = new URL(url);
    const rules = await getRobots(u.origin);
    return robotsAllows(rules, u.pathname);
  } catch {
    return false;
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  maxRetries?: number;
  /** Skip the robots check. Only for our own endpoints and provider APIs. */
  skipRobots?: boolean;
  headers?: Record<string, string>;
}

export async function politeFetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const cfg = getConfig();
  const timeoutMs = opts.timeoutMs ?? cfg.fetchTimeoutMs;
  const maxRetries = opts.maxRetries ?? cfg.fetchMaxRetries;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FetchError(`invalid url: ${url}`, undefined, false);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new FetchError(`unsupported protocol: ${parsed.protocol}`, undefined, false);
  }

  if (!opts.skipRobots && !(await isAllowedByRobots(url))) {
    throw new FetchError(`robots.txt disallows ${url}`, undefined, false);
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(30_000, 2 ** attempt * 500) + Math.random() * 400;
      logger.debug('retrying fetch', { url, attempt, backoff: Math.round(backoff) });
      await sleep(backoff);
    }
    await throttle(parsed.origin);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': cfg.userAgent,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(opts.headers ?? {}),
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      if (res.status === 429 || res.status >= 500) {
        lastErr = new FetchError(`HTTP ${res.status} for ${url}`, res.status, true);
        continue;
      }
      if (!res.ok) {
        throw new FetchError(`HTTP ${res.status} for ${url}`, res.status, false);
      }

      const body = await readCapped(res);
      return {
        url,
        finalUrl: res.url || url,
        status: res.status,
        body,
        contentType: res.headers.get('content-type') ?? '',
        fetchedAt: new Date(),
      };
    } catch (err) {
      if (err instanceof FetchError && !err.retryable) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new FetchError(
    `fetch failed after ${maxRetries + 1} attempts: ${url} (${String(lastErr)})`,
    undefined,
    false,
  );
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(Math.min(total, MAX_BYTES));
  let offset = 0;
  for (const c of chunks) {
    if (offset + c.byteLength > out.length) {
      out.set(c.subarray(0, out.length - offset), offset);
      break;
    }
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Test seam: clears throttle/robots state between cases. */
export function resetFetchState(): void {
  lastRequestAt.clear();
  robotsCache.clear();
}
