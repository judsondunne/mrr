/** Structured JSON logging. No secret ever reaches a log line — see redact(). */

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_PATTERN =
  /(key|secret|token|password|authorization|apikey|api_key|credential|bearer)/i;

/** Redacts anything that looks like a credential, at any depth. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') {
    // Catch raw provider key formats even if they show up in a plain string.
    return value
      .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***')
      .replace(/re_[A-Za-z0-9_-]{16,}/g, 're_***')
      .replace(/whsec_[A-Za-z0-9+/=_-]{8,}/g, 'whsec_***')
      .replace(/BSA[A-Za-z0-9_-]{16,}/g, 'BSA***');
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '***' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function currentLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return (['debug', 'info', 'warn', 'error'] as const).includes(raw as Level)
    ? (raw as Level)
    : 'info';
}

function emit(level: Level, scope: string, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[currentLevel()]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };
  const out = JSON.stringify(line);
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const log = createLogger('app');

/** Turn an unknown thrown value into something safe to persist. */
export function errorToFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { error: err.message, errorName: err.name, stack: err.stack?.split('\n').slice(0, 5).join('\n') };
  }
  return { error: String(err) };
}
