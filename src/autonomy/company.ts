/**
 * PUBLIC API — COMPANY IDENTITY + FATIGUE. Owned by the outreach agent.
 *
 * One real business = one row, across every campaign and experiment. This is
 * what stops the same shop being pestered by unrelated tests, and what makes
 * "unique company" mean the same thing everywhere.
 */
import type { ContactEligibility } from './types';

export declare function upsertCompany(params: {
  companyKey: string;
  displayName?: string | null;
  dataQuality?: 'HIGH' | 'MEDIUM' | 'LOW';
}): Promise<{ id: string; companyKey: string }>;

/**
 * Enforces: NEVER_CONTACT is terminal; a company in cooldown is off limits;
 * a company actively engaged in one experiment is not pulled into another.
 */
export declare function canContactCompany(companyKey: string): Promise<ContactEligibility>;

export declare function recordContact(params: {
  companyKey: string;
  campaignId: string;
}): Promise<void>;

export declare function markEngaged(companyKey: string, campaignId: string): Promise<void>;

/** Unsubscribe / explicit stop. Terminal and irreversible. */
export declare function markNeverContact(companyKey: string, reason: string): Promise<void>;

export declare function startCooldown(params: {
  companyKey: string;
  days: number;
  reason: string;
}): Promise<void>;

/** Bots, autoresponders, vendors and internal/test domains never count. */
export declare function isCountableCompany(companyKey: string): Promise<boolean>;

/** Merges confidently-identical businesses so one company counts once. */
export declare function mergeCompanies(primaryKey: string, duplicateKey: string): Promise<void>;
