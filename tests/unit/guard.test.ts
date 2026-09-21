/**
 * THE CONTROL-PLANE BOUNDARY.
 *
 * This is the mechanism that makes "adaptive" not mean "unconstrained". If it
 * is wrong, a strategy proposal can raise a budget, widen a send limit, or
 * lower the validation gate. Every other safety property in the autonomy layer
 * assumes these tests hold.
 *
 * No database and no providers: the guard is pure, and it has to be, because it
 * runs before anything is written.
 */
import { describe, it, expect } from 'vitest';
import {
  assertStrategyOnly,
  findForbiddenFields,
  findForbiddenMentions,
  ControlPlaneViolation,
} from '../../src/autonomy/guard';
import { FORBIDDEN_STRATEGY_FIELDS } from '../../src/autonomy/types';

/** What a real, allowed strategy change looks like. */
const LEGITIMATE_STRATEGY = {
  category: 'wholesale-minimum-order-rules',
  icp: 'Shopify merchants with a public wholesale price list',
  positioning: 'enforce per-customer-group minimums without a developer',
  priceMonthly: 29,
  sendTimeBucket: 'tue-0900-local',
  emailVariant: {
    subjectStyle: 'plain-question',
    bodyLength: 'short',
    proofPoints: ['names the incumbent', 'names the exact workflow'],
  },
  queryFamilies: [
    { family: 'wholesale-minimums', seeds: ['minimum order quantity shopify'] },
    { family: 'case-pack', seeds: ['case pack quantities b2b'] },
  ],
  followupStrategy: { style: 'one-line-nudge' },
};

describe('findForbiddenFields walks the whole object', () => {
  it('finds nothing in a legitimate strategy config', () => {
    expect(findForbiddenFields(LEGITIMATE_STRATEGY)).toEqual([]);
    expect(() => assertStrategyOnly(LEGITIMATE_STRATEGY, 'test')).not.toThrow();
  });

  it('catches a forbidden field nested inside objects and arrays', () => {
    const sneaky = {
      category: 'back-in-stock',
      experiment: {
        variants: [
          { name: 'a', config: { tone: 'plain' } },
          {
            name: 'b',
            config: {
              tone: 'direct',
              // Four levels down, inside an array element.
              overrides: { maxEmailsPerDay: 500 },
            },
          },
        ],
      },
    };
    expect(findForbiddenFields(sneaky)).toEqual(['maxEmailsPerDay']);
  });

  it('treats snake_case, camelCase and SCREAMING-KEBAB as the same field', () => {
    expect(findForbiddenFields({ max_emails_per_day: 1 })).toEqual(['maxEmailsPerDay']);
    expect(findForbiddenFields({ maxEmailsPerDay: 1 })).toEqual(['maxEmailsPerDay']);
    expect(findForbiddenFields({ 'MAX-EMAILS-PER-DAY': 1 })).toEqual(['maxEmailsPerDay']);
    expect(findForbiddenFields({ 'Max Emails Per Day': 1 })).toEqual(['maxEmailsPerDay']);
  });

  it('catches every declared control-plane field, however it is spelled', () => {
    for (const field of FORBIDDEN_STRATEGY_FIELDS) {
      const snake = field.replace(/([A-Z])/g, '_$1').toLowerCase();
      expect(findForbiddenFields({ [field]: 'x' }), field).toEqual([field]);
      expect(findForbiddenFields({ [snake]: 'x' }), snake).toEqual([field]);
      expect(findForbiddenFields({ [field.toUpperCase()]: 'x' }), field).toEqual([field]);
    }
  });

  it('reports each offending field once, in declaration order', () => {
    const many = {
      killSwitch: true,
      nested: { gate: { minUniqueStrongCommitments: 1 }, again: { kill_switch: true } },
    };
    expect(findForbiddenFields(many)).toEqual(['minUniqueStrongCommitments', 'killSwitch', 'gate']);
  });

  it('survives non-objects, cycles and deep nesting without throwing', () => {
    expect(findForbiddenFields(null)).toEqual([]);
    expect(findForbiddenFields('maxEmailsPerDay')).toEqual([]);
    expect(findForbiddenFields(42)).toEqual([]);

    const cyclic: Record<string, unknown> = { category: 'x' };
    cyclic.self = cyclic;
    expect(findForbiddenFields(cyclic)).toEqual([]);

    let deep: Record<string, unknown> = { monthlyLlmBudgetUsd: 999 };
    for (let i = 0; i < 40; i++) deep = { level: deep };
    // Beyond the depth ceiling it simply stops; it must not hang or throw.
    expect(() => findForbiddenFields(deep)).not.toThrow();
  });
});

describe('assertStrategyOnly refuses the write', () => {
  it('throws ControlPlaneViolation naming the field and the context', () => {
    let thrown: unknown;
    try {
      assertStrategyOnly({ icp: 'wholesalers', gate: { minUniquePriceAcceptances: 1 } }, 'strategy_versions:ICP');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ControlPlaneViolation);
    const violation = thrown as ControlPlaneViolation;
    expect(violation.field).toContain('minUniquePriceAcceptances');
    expect(violation.message).toContain('strategy_versions:ICP');
    expect(violation.name).toBe('ControlPlaneViolation');
  });

  it('allows a config that only touches the strategy plane', () => {
    expect(() => assertStrategyOnly(LEGITIMATE_STRATEGY, 'strategy_versions:ICP_SEGMENT')).not.toThrow();
  });
});

describe('forbidden fields named in prose', () => {
  it('catches an argument for raising a control-plane limit', () => {
    expect(findForbiddenMentions('We should raise max emails per day to 500.')).toEqual(['maxEmailsPerDay']);
    expect(findForbiddenMentions('set MAX_FOLLOWUPS = 4')).toEqual(['maxFollowups']);
    expect(findForbiddenMentions('disable the killSwitch for this test')).toEqual(['killSwitch']);
  });

  it('leaves ordinary strategy prose alone', () => {
    expect(
      findForbiddenMentions(
        'Test a $49 price for coffee roasters who already run wholesale price lists, sending Tuesday morning.',
      ),
    ).toEqual([]);
  });
});
