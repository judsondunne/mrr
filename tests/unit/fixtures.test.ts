import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown } from '../helpers';
import { seedScenario, SCENARIOS } from '../../src/scripts/fixtures';

import { ACTION_COMMITMENT_TYPES, PRICE_ACCEPTANCE_TYPES } from '../../src/lib/contracts';

afterEach(async () => { await teardown(); });

describe('demo fixtures', () => {
  it('seeds every scenario without error', async () => {
    await freshDb();
    for (const s of SCENARIOS) {
      const res = await seedScenario(s);
      expect(res.opportunityId).toBeTruthy();
    }
  });

  it('failed-idea has only weak evidence and is rejected', async () => {
    const { db } = await freshDb();
    const { opportunityId } = await seedScenario('failed-idea');
    const row = await db.query<{ state: string; evidence_confidence: string; rejection_reason: string }>(
      'SELECT state, evidence_confidence, rejection_reason FROM opportunities WHERE id = $1',
      [opportunityId],
    );
    expect(row.rows[0]?.state).toBe('CATEGORY_REJECTED');
    expect(row.rows[0]?.evidence_confidence).not.toBe('HIGH');
    expect(row.rows[0]?.rejection_reason).toBe('ONLY_WEAK_EVIDENCE');
  });

  it('good-research-no-demand has HIGH evidence, real delivery, and ZERO commitments', async () => {
    const { db } = await freshDb();
    const { opportunityId, campaignId } = await seedScenario('good-research-no-demand');

    const opp = await db.query<{ evidence_confidence: string; state: string }>(
      'SELECT evidence_confidence, state FROM opportunities WHERE id = $1',
      [opportunityId],
    );
    // Research quality was excellent...
    expect(opp.rows[0]?.evidence_confidence).toBe('HIGH');

    const delivered = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM messages WHERE campaign_id = $1 AND delivered_at IS NOT NULL`,
      [campaignId],
    );
    expect(Number(delivered.rows[0]?.n)).toBeGreaterThanOrEqual(100);

    // ...and nobody wanted our wedge. This is the whole point of the system.
    const commitments = await db.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM commitments WHERE campaign_id = $1',
      [campaignId],
    );
    expect(Number(commitments.rows[0]?.n)).toBe(0);
    expect(opp.rows[0]?.state).toBe('VALIDATION_FAILED');
  });

  it('weak-replies produces replies but no commitments', async () => {
    const { db } = await freshDb();
    const { campaignId } = await seedScenario('weak-replies');
    const replies = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM messages WHERE campaign_id = $1 AND direction = 'INBOUND'`,
      [campaignId],
    );
    expect(Number(replies.rows[0]?.n)).toBeGreaterThan(0);

    const commitments = await db.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM commitments WHERE campaign_id = $1',
      [campaignId],
    );
    expect(Number(commitments.rows[0]?.n)).toBe(0);
  });

  it('strong-validated meets every threshold counted by UNIQUE COMPANY', async () => {
    const { db } = await freshDb();
    const { campaignId } = await seedScenario('strong-validated');

    const strong = await db.query<{ n: string }>(
      'SELECT COUNT(DISTINCT company_key) AS n FROM commitments WHERE campaign_id = $1',
      [campaignId],
    );
    expect(Number(strong.rows[0]?.n)).toBeGreaterThanOrEqual(5);

    const priceTypes = [...PRICE_ACCEPTANCE_TYPES];
    const priced = await db.query<{ n: string }>(
      `SELECT COUNT(DISTINCT company_key) AS n FROM commitments
        WHERE campaign_id = $1 AND type = ANY($2)`,
      [campaignId, priceTypes],
    );
    expect(Number(priced.rows[0]?.n)).toBeGreaterThanOrEqual(3);

    const actionTypes = [...ACTION_COMMITMENT_TYPES];
    const acted = await db.query<{ n: string }>(
      `SELECT COUNT(DISTINCT company_key) AS n FROM commitments
        WHERE campaign_id = $1 AND type = ANY($2)`,
      [campaignId, actionTypes],
    );
    expect(Number(acted.rows[0]?.n)).toBeGreaterThanOrEqual(2);
  });

  it('counts one company once even when it commits twice', async () => {
    const { db } = await freshDb();
    const { campaignId } = await seedScenario('strong-validated');
    const dupCompany = 'demo-wholesaler-1.example.com';

    const rows = await db.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM commitments WHERE campaign_id = $1 AND company_key = $2',
      [campaignId, dupCompany],
    );
    const distinct = await db.query<{ n: string }>(
      'SELECT COUNT(DISTINCT company_key) AS n FROM commitments WHERE campaign_id = $1 AND company_key = $2',
      [campaignId, dupCompany],
    );
    expect(Number(rows.rows[0]?.n)).toBe(2);      // two commitment rows
    expect(Number(distinct.rows[0]?.n)).toBe(1);  // one company
  });

  it('all fixture prospect domains are non-routable example.com addresses', async () => {
    const { db } = await freshDb();
    for (const s of SCENARIOS) await seedScenario(s);
    const rows = await db.query<{ domain: string; contact_email: string }>(
      'SELECT domain, contact_email FROM prospects',
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) {
      expect(r.domain.endsWith('.example.com')).toBe(true);
      expect(r.contact_email.endsWith('.example.com')).toBe(true);
    }
  });
});
