import { describe, it, expect, afterEach } from 'vitest';
import {
  assertTransition,
  canTransition,
  allowedTransitions,
  requiresGateToken,
  __mintGateToken,
  OPPORTUNITY_STATES,
  DEAD_STATES,
  assertCampaignTransition,
} from '../../src/lib/state-machine.js';
import { IllegalTransitionError, BudgetExceededError } from '../../src/lib/errors.js';
import { redact } from '../../src/lib/logger.js';
import { sha256, contentHash, slugify, safeCompare, stableStringify } from '../../src/lib/hash.js';
import { splitStatements } from '../../src/lib/migrate.js';
import { robotsAllows } from '../../src/lib/fetch.js';
import { freshDb, teardown } from '../helpers.js';
import { recordCost, assertBudget, getBudgetSnapshot, estimateLlmCost } from '../../src/lib/cost.js';

afterEach(async () => { await teardown(); });

describe('state machine', () => {
  it('permits only edges in the table', () => {
    expect(canTransition('DISCOVERED', 'CATEGORY_VERIFYING')).toBe(true);
    expect(canTransition('DISCOVERED', 'READY_TO_BUILD')).toBe(false);
    expect(canTransition('CATEGORY_VERIFIED', 'VALIDATING')).toBe(false);
    expect(canTransition('ARCHIVED', 'DISCOVERED')).toBe(false);
  });

  it('refuses READY_TO_BUILD without a gate token', () => {
    expect(() => assertTransition('opp_1', 'VALIDATION_STRONG', 'READY_TO_BUILD')).toThrow(
      IllegalTransitionError,
    );
  });

  it('refuses a gate token minted for a different opportunity', () => {
    const token = __mintGateToken('opp_other', ['x']);
    expect(() =>
      assertTransition('opp_1', 'VALIDATION_STRONG', 'READY_TO_BUILD', { gateToken: token }),
    ).toThrow(/minted for opp_other/);
  });

  it('accepts a genuine gate token', () => {
    const token = __mintGateToken('opp_1', ['all checks']);
    expect(() =>
      assertTransition('opp_1', 'VALIDATION_STRONG', 'READY_TO_BUILD', { gateToken: token }),
    ).not.toThrow();
  });

  it('refuses a forged token-shaped object', () => {
    const forged = { __brand: 'GateToken', opportunityId: 'opp_1', decidedAt: new Date(), passedChecks: [] };
    expect(() =>
      assertTransition('opp_1', 'VALIDATION_STRONG', 'READY_TO_BUILD', {
        gateToken: forged as never,
      }),
    ).toThrow(IllegalTransitionError);
  });

  it('marks exactly the two gated states', () => {
    const gated = OPPORTUNITY_STATES.filter(requiresGateToken);
    expect(gated).toEqual(['VALIDATION_STRONG', 'READY_TO_BUILD']);
  });

  it('cannot reach READY_TO_BUILD from any state except VALIDATION_STRONG', () => {
    const sources = OPPORTUNITY_STATES.filter((s) => allowedTransitions(s).includes('READY_TO_BUILD'));
    expect(sources).toEqual(['VALIDATION_STRONG']);
  });

  it('treats rejection states as dead', () => {
    expect(DEAD_STATES.has('CATEGORY_REJECTED')).toBe(true);
    expect(DEAD_STATES.has('VALIDATION_FAILED')).toBe(true);
    expect(DEAD_STATES.has('VALIDATING')).toBe(false);
  });

  it('rejects no-op transitions', () => {
    expect(() => assertTransition('opp_1', 'DISCOVERED', 'DISCOVERED')).toThrow(/no-op/);
  });

  it('validates campaign edges', () => {
    expect(() => assertCampaignTransition('DRAFT', 'READY')).not.toThrow();
    expect(() => assertCampaignTransition('COMPLETE', 'BATCH_1')).toThrow(IllegalTransitionError);
  });
});

describe('logger redaction', () => {
  it('redacts keys by name', () => {
    const out = redact({ apiKey: 'abc', nested: { authorization: 'Bearer x' }, safe: 'ok' });
    expect(out).toEqual({ apiKey: '***', nested: { authorization: '***' }, safe: 'ok' });
  });

  it('redacts provider key formats found inside free strings', () => {
    const out = redact('key is sk-ant-api03-ZZZZZZZZZZZZ and re_abcdefghijklmnopqrst');
    expect(out).toBe('key is sk-ant-*** and re_***');
  });
});

describe('hashing', () => {
  it('is key-order independent', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });
  it('normalizes whitespace and case for content hashes', () => {
    expect(contentHash('Hello   World')).toBe(contentHash('hello world'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
  it('slugifies', () => {
    expect(slugify('Minimum Order Rules! (B2B)')).toBe('minimum-order-rules-b2b');
  });
  it('compares in constant time without throwing on length mismatch', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
    expect(safeCompare('abc', 'abcd')).toBe(false);
    expect(safeCompare(sha256('x'), sha256('x'))).toBe(true);
  });
});

describe('migration splitter', () => {
  it('drops comments and splits on statement boundaries', () => {
    const stmts = splitStatements(`-- a comment\nCREATE TABLE a (id TEXT);\nCREATE INDEX i ON a(id);\n`);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('CREATE TABLE a');
  });
});

describe('robots.txt matching', () => {
  it('uses longest match wins', () => {
    const rules = [
      { allow: false, path: '/' },
      { allow: true, path: '/public' },
    ];
    expect(robotsAllows(rules, '/private')).toBe(false);
    expect(robotsAllows(rules, '/public/page')).toBe(true);
  });
  it('allows everything when there are no rules', () => {
    expect(robotsAllows([], '/anything')).toBe(true);
  });
});

describe('cost accounting', () => {
  it('computes LLM cost from configured rates', () => {
    expect(estimateLlmCost('fast', 1_000_000, 0)).toBeCloseTo(1.0, 6);
    expect(estimateLlmCost('fast', 0, 1_000_000)).toBeCloseTo(5.0, 6);
    expect(estimateLlmCost('reasoner', 1_000_000, 1_000_000)).toBeCloseTo(12.0, 6);
  });

  it('accumulates ledger rows into the snapshot', async () => {
    await freshDb({ MONTHLY_LLM_BUDGET_USD: '20' });
    await recordCost({ provider: 'anthropic', resourceType: 'LLM_INPUT_TOKENS', quantity: 1000, estimatedCost: 3 });
    await recordCost({ provider: 'anthropic', resourceType: 'LLM_OUTPUT_TOKENS', quantity: 500, estimatedCost: 4 });
    const snap = await getBudgetSnapshot();
    expect(snap.llmSpentUsd).toBeCloseTo(7, 6);
  });

  it('throws BEFORE the call that would cross the cap', async () => {
    await freshDb({ MONTHLY_LLM_BUDGET_USD: '10' });
    await recordCost({ provider: 'anthropic', resourceType: 'LLM_INPUT_TOKENS', quantity: 1, estimatedCost: 9.5 });
    await expect(assertBudget('LLM', 1.0)).rejects.toThrow(BudgetExceededError);
    await expect(assertBudget('LLM', 0.4)).resolves.toBeUndefined();
  });

  it('keeps search and LLM budgets separate', async () => {
    await freshDb({ MONTHLY_LLM_BUDGET_USD: '20', MONTHLY_SEARCH_BUDGET_USD: '5' });
    await recordCost({ provider: 'brave', resourceType: 'SEARCH_CALL', quantity: 1, estimatedCost: 4.99 });
    await expect(assertBudget('SEARCH', 0.02)).rejects.toThrow(BudgetExceededError);
    await expect(assertBudget('LLM', 1)).resolves.toBeUndefined();
  });
});
