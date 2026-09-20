/**
 * Sending window.
 *
 * Business outreach goes out during business hours in the sender's timezone,
 * on weekdays if configured. Implemented with Intl.DateTimeFormat so there is
 * no timezone dependency to install, keep updated, or get wrong.
 *
 * Fails CLOSED: anything we cannot evaluate (bad timezone, weird locale data)
 * means "do not send".
 */
import { getConfig, type Config } from '../../lib/config';
import { createLogger } from '../../lib/logger';

const logger = createLogger('outreach:window');

export interface WindowStatus {
  ok: boolean;
  reason: string | null;
  localHour: number | null;
  weekday: string | null;
}

const WEEKEND = new Set(['Sat', 'Sun']);

/** The local wall-clock hour and weekday in the configured sending timezone. */
export function localTimeParts(now: Date, timeZone: string): { hour: number; weekday: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    }).formatToParts(now);
    const hourPart = parts.find((p) => p.type === 'hour')?.value;
    const weekdayPart = parts.find((p) => p.type === 'weekday')?.value;
    if (hourPart === undefined || weekdayPart === undefined) return null;
    const hour = Number(hourPart);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    return { hour, weekday: weekdayPart };
  } catch (err) {
    logger.error('could not resolve the sending timezone', { timeZone, err: String(err) });
    return null;
  }
}

export function sendingWindowStatus(now: Date = new Date(), cfg: Config = getConfig()): WindowStatus {
  const parts = localTimeParts(now, cfg.sendingTimezone);
  if (!parts) {
    return { ok: false, reason: 'INVALID_SENDING_TIMEZONE', localHour: null, weekday: null };
  }
  const { hour, weekday } = parts;

  if (cfg.sendingWeekdaysOnly && WEEKEND.has(weekday)) {
    return { ok: false, reason: 'WEEKEND', localHour: hour, weekday };
  }
  if (!(hour >= cfg.sendingWindowStartHour && hour < cfg.sendingWindowEndHour)) {
    return { ok: false, reason: 'OUTSIDE_SENDING_WINDOW', localHour: hour, weekday };
  }
  return { ok: true, reason: null, localHour: hour, weekday };
}

export function isWithinSendingWindow(now: Date = new Date(), cfg: Config = getConfig()): boolean {
  return sendingWindowStatus(now, cfg).ok;
}
