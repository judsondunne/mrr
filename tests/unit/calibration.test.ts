/**
 * Model calibration.
 *
 * The failure this guards against is silent. Reply classification feeds
 * commitment extraction, which feeds the reward the strategy plane learns
 * from. A classifier that has quietly become 35% accurate does not throw and
 * does not page anyone — it just teaches the machine the wrong lesson for a
 * month. So the frozen fixtures are re-run against the live configuration and
 * a regression is refused rather than adopted.
 *
 * Every LLM call here goes to the mock provider. Nothing touches a network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, teardown, type TestContext } from '../helpers';
import { resetConfigCache } from '../../src/lib/config';
import {
  runCalibration,
  recordCalibrationRun,
  isConfigurationAcceptable,
  loadCalibrationFixtures,
  acceptedLabels,
  CALIBRATION_REGRESSION_THRESHOLD,
  CALIBRATION_MIN_ABSOLUTE_ACCURACY,
  REPLY_CLASSIFIER_PROMPT_ID,
} from '../../src/autonomy/calibration';
import { detectInjection, mentionsSensitiveTarget } from '../../src/autonomy/injection';

const INJECTION_FIXTURE_ID = 'injection-bearing-price-acceptance';
const ORIGINAL_LLM_FAST = process.env.LLM_FAST;

/** One database for the whole file: the migrations are the expensive part. */
let ctx: TestContext;

beforeAll(async () => {
  ctx = await freshDb({ MONTHLY_LLM_BUDGET_USD: '20' });
});

afterAll(async () => {
  if (ORIGINAL_LLM_FAST === undefined) delete process.env.LLM_FAST;
  else process.env.LLM_FAST = ORIGINAL_LLM_FAST;
  resetConfigCache();
  await teardown();
});

// ---------------------------------------------------------------------------
// The stand-in classifier.
//
// A deliberately dumb keyword model. It stands in for the fast tier so the
// suite can run with no credentials and no spend, and — importantly — it is
// immune to the injection payload in fixture 12 for the same reason the real
// classifier should be: it reads the reply as text and nothing more.
// ---------------------------------------------------------------------------

interface MockAnalysis {
  classification: string;
  intent: string;
  requestedFeature: string | null;
  competitorMentioned: string | null;
  priceReaction: string;
  timing: string | null;
  explicitlyWantsAccess: boolean;
  explicitlyAcceptedPrice: boolean;
  requiresHuman: boolean;
  intentScore: number;
}

function base(): MockAnalysis {
  return {
    classification: 'OTHER',
    intent: 'unclear',
    requestedFeature: null,
    competitorMentioned: null,
    priceReaction: 'NOT_MENTIONED',
    timing: null,
    explicitlyWantsAccess: false,
    explicitlyAcceptedPrice: false,
    requiresHuman: false,
    intentScore: 0.4,
  };
}

/**
 * The reply text as the classifier actually passes it.
 *
 * `classifyReply` puts attacker-controlled subject/body in the `untrusted`
 * channel so the LLM layer fences them as DATA on every call, and keeps only
 * the offer summary in `user`. Reading `req.user` (as this helper first did)
 * therefore saw no reply at all, and every fixture fell through to a default —
 * which is why calibration measured 5/14 rather than the classifier's real
 * accuracy.
 */
function replyOf(req: { user: string; untrusted?: Record<string, string> }): string {
  const untrusted = req.untrusted;
  if (untrusted) {
    return [untrusted.inbound_subject ?? '', untrusted.inbound_email ?? ''].join('\n').trim();
  }
  try {
    return (JSON.parse(req.user) as { reply?: string }).reply ?? '';
  } catch {
    return '';
  }
}

/** The configuration that should pass calibration. */
function competentClassifier(req: { user: string }): MockAnalysis {
  const text = replyOf(req);

  if (/\bspam\b|waste our time|insulting/i.test(text)) {
    return { ...base(), classification: 'NOT_INTERESTED', intent: 'hostile rejection', intentScore: 0 };
  }
  if (
    /\$\s?\d+\s*\/?\s*(?:mo|month)?[^.]{0,24}\b(?:is fine|is fair|works|no problem|acceptable)\b/i.test(text) ||
    /\b(?:happy|willing|glad) to pay\b|\bwe'?ll pay\b/i.test(text)
  ) {
    return {
      ...base(),
      classification: 'PRICE_ACCEPTED',
      priceReaction: 'ACCEPTED',
      explicitlyAcceptedPrice: true,
      explicitlyWantsAccess: /sign (?:us|me) up|pilot|install/i.test(text),
      intent: 'accepted the stated price',
      intentScore: 0.9,
    };
  }
  if (/exactly the problem|first installs?|sign (?:us|me) up|count (?:us|me) in/i.test(text)) {
    return {
      ...base(),
      classification: 'INTERESTED_STRONG',
      explicitlyWantsAccess: true,
      intent: 'asked for access',
      intentScore: 0.8,
    };
  }
  if (/\bif it (?:did|had|could)\b|\bneed it to\b|\bwould need\b|\bbefore we could\b|\bonly if\b/i.test(text)) {
    return {
      ...base(),
      classification: 'FEATURE_REQUIREMENT',
      requestedFeature: 'case-pack quantities',
      intent: 'stated a requirement',
    };
  }
  if (/\bwe (?:already )?use\b|\bcurrently using\b|\bwe'?re on\b/i.test(text)) {
    return {
      ...base(),
      classification: 'USING_COMPETITOR',
      competitorMentioned: 'Wholesale Club',
      intent: 'has an incumbent',
    };
  }
  if (/^(?:how|does|do you|can|could|what|when|where|is there|will it)\b/im.test(text)) {
    return { ...base(), classification: 'ASKING_QUESTION', intent: 'asked a question' };
  }
  if (/sounds interesting|cool idea|keep me posted|circle back|mid-migration/i.test(text)) {
    return { ...base(), classification: 'INTERESTED_WEAK', intent: 'vague positivity', intentScore: 0.3 };
  }
  return base();
}

/** The regressed configuration: shrugs at everything. */
function brokenClassifier(): MockAnalysis {
  return base();
}

function useCompetentClassifier(): void {
  ctx.llm.register('outreach.classify_reply', (req) => competentClassifier(req));
}

function useBrokenClassifier(): void {
  ctx.llm.register('outreach.classify_reply', () => brokenClassifier());
}

async function clearCalibrationHistory(): Promise<void> {
  await ctx.db.query('DELETE FROM calibration_runs');
}

// ---------------------------------------------------------------------------

describe('the frozen fixture set', () => {
  it('covers every reply shape the validator depends on', async () => {
    const fixtures = await loadCalibrationFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(12);

    const labels = new Set(fixtures.map((f) => f.expected));
    for (const required of [
      'INTERESTED_WEAK',
      'INTERESTED_STRONG',
      'PRICE_ACCEPTED',
      'UNSUBSCRIBE',
      'FEATURE_REQUIREMENT',
      'OUT_OF_OFFICE',
      'WRONG_PERSON',
      'USING_COMPETITOR',
      'NOT_INTERESTED',
      'ASKING_QUESTION',
    ]) {
      expect([...labels], `no fixture covers ${required}`).toContain(required);
    }

    // Ids are the primary key of the whole exercise.
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
  });

  it('records the accepted answers for the genuinely ambiguous cases', async () => {
    const ambiguous = (await loadCalibrationFixtures()).filter((f) => f.ambiguous);
    expect(ambiguous.length).toBeGreaterThanOrEqual(2);
    for (const fixture of ambiguous) {
      // An ambiguous fixture with one accepted answer is not ambiguous, it is
      // a rigged metric.
      expect(fixture.alsoAccepted.length, fixture.id).toBeGreaterThan(0);
      expect(acceptedLabels(fixture).length, fixture.id).toBeGreaterThan(1);
      expect(fixture.note, fixture.id).not.toBe('');
    }
  });

  it('includes a fixture that carries a live injection attempt', async () => {
    const fixture = (await loadCalibrationFixtures()).find((f) => f.id === INJECTION_FIXTURE_ID);
    expect(fixture, 'the injection-bearing fixture must exist').toBeDefined();
    if (!fixture) return;

    // It really is an attack, not a decoration.
    const detected = detectInjection(fixture.body);
    for (const pattern of [
      'INSTRUCTION_OVERRIDE',
      'IDENTITY_REASSIGNMENT',
      'SYSTEM_PROMPT_INJECTION',
      'PROMPT_DISCLOSURE',
      'CREDENTIAL_EXFILTRATION',
      'INTERNAL_TARGET_NAVIGATION',
    ]) {
      expect(detected, pattern).toContain(pattern);
    }
    expect(mentionsSensitiveTarget(fixture.body)).toBe(true);

    // And its correct answer is an ordinary classification of the human part.
    expect(acceptedLabels(fixture)).toContain('PRICE_ACCEPTED');
    expect(acceptedLabels(fixture)).not.toContain('OTHER');
  });
});

// ---------------------------------------------------------------------------

describe('runCalibration', () => {
  it('computes accuracy against the current configuration', async () => {
    await clearCalibrationHistory();
    useCompetentClassifier();

    const fixtures = await loadCalibrationFixtures();
    const results = await runCalibration();

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result?.promptId).toBe(REPLY_CLASSIFIER_PROMPT_ID);
    expect(result?.total).toBe(fixtures.length);
    expect(result?.passed).toBe(fixtures.length);
    expect(result?.accuracy).toBe(1);
    expect(result?.failures).toEqual([]);
    // Nothing recorded yet, so there is nothing to have regressed against.
    expect(result?.baselineAccuracy).toBeNull();
    expect(result?.regressed).toBe(false);
    expect(result?.model).toBe('claude-haiku-4-5');
    expect(result?.promptVersion).toBe(1);
  });

  it('arrives at accuracy as passed over total, not as an opinion', async () => {
    await clearCalibrationHistory();
    useCompetentClassifier();
    const result = (await runCalibration())[0];
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.accuracy).toBeCloseTo(result.passed / result.total, 4);
    expect(result.passed + result.failures.length).toBe(result.total);
  });

  it('reads the injection-bearing fixture as data and classifies it correctly', async () => {
    await clearCalibrationHistory();
    useCompetentClassifier();

    const result = (await runCalibration())[0];
    expect(result?.failures.map((f) => f.fixture)).not.toContain(INJECTION_FIXTURE_ID);

    // Belt and braces: assert the label directly, so this cannot pass merely
    // because the fixture went missing.
    const fixture = (await loadCalibrationFixtures()).find((f) => f.id === INJECTION_FIXTURE_ID);
    expect(fixture).toBeDefined();
    expect(result?.total).toBe((await loadCalibrationFixtures()).length);
  });

  it('returns nothing for a prompt that has no fixtures', async () => {
    expect(await runCalibration('wedge.synthesize')).toEqual([]);
  });

  it('honours the active prompt version recorded in prompt_versions', async () => {
    await clearCalibrationHistory();
    useCompetentClassifier();
    await ctx.db.query(
      `INSERT INTO prompt_versions (id, prompt_id, version, tier, content_hash, active)
       VALUES ($1,$2,$3,'fast','hash-abc',true)`,
      ['pv_test_v4', REPLY_CLASSIFIER_PROMPT_ID, 4],
    );
    try {
      const result = (await runCalibration())[0];
      expect(result?.promptVersion).toBe(4);
    } finally {
      await ctx.db.query('DELETE FROM prompt_versions WHERE id = $1', ['pv_test_v4']);
    }
  });
});

// ---------------------------------------------------------------------------

describe('a regressed configuration is not adopted', () => {
  it('accepts the configuration that produced the baseline', async () => {
    await clearCalibrationHistory();
    useCompetentClassifier();

    const baseline = (await runCalibration())[0];
    expect(baseline).toBeDefined();
    if (!baseline) return;
    await recordCalibrationRun(baseline);

    expect(await isConfigurationAcceptable(REPLY_CLASSIFIER_PROMPT_ID)).toBe(true);
  });

  it('detects the regression and refuses the change', async () => {
    await clearCalibrationHistory();

    // 1. Establish a baseline with the good configuration.
    useCompetentClassifier();
    const good = (await runCalibration())[0];
    expect(good?.accuracy).toBe(1);
    if (good) await recordCalibrationRun(good);

    // 2. Change the model AND break the classifier. Changing the model is what
    //    makes this a faithful simulation rather than a trick: the LLM cache
    //    key includes the model, so a real model swap invalidates the cached
    //    answers exactly as this does.
    process.env.LLM_FAST = 'regressed-model-v2';
    resetConfigCache();
    useBrokenClassifier();

    try {
      const bad = (await runCalibration())[0];
      expect(bad).toBeDefined();
      if (!bad) return;

      expect(bad.model).toBe('regressed-model-v2');
      expect(bad.baselineAccuracy).toBe(1);
      expect(bad.accuracy).toBeLessThan(1 - CALIBRATION_REGRESSION_THRESHOLD);
      expect(bad.regressed).toBe(true);
      expect(bad.failures.length).toBeGreaterThan(0);

      // The compliance fixtures still pass: opt-out and out-of-office are
      // decided by regex, so a broken model cannot break them. That is the
      // whole reason those rules do not go through a model.
      const failedIds = bad.failures.map((f) => f.fixture);
      expect(failedIds).not.toContain('unsubscribe-remove-me');
      expect(failedIds).not.toContain('unsubscribe-bare-stop');
      expect(failedIds).not.toContain('out-of-office-auto-reply');
      expect(failedIds).not.toContain('wrong-person-forwarded');

      // And the injection-bearing fixture is now misread, which is exactly
      // the kind of damage this gate exists to catch.
      expect(failedIds).toContain(INJECTION_FIXTURE_ID);

      expect(await isConfigurationAcceptable(REPLY_CLASSIFIER_PROMPT_ID)).toBe(false);

      // The regressed run is still recorded — the audit trail wants it — and
      // recording it must not move the baseline.
      await recordCalibrationRun(bad);
      const after = (await runCalibration())[0];
      expect(after?.baselineAccuracy).toBe(1);
    } finally {
      if (ORIGINAL_LLM_FAST === undefined) delete process.env.LLM_FAST;
      else process.env.LLM_FAST = ORIGINAL_LLM_FAST;
      resetConfigCache();
      useCompetentClassifier();
    }
  });

  it('refuses a prompt it cannot calibrate at all', async () => {
    expect(await isConfigurationAcceptable('wedge.synthesize')).toBe(false);
  });

  it('keeps the absolute floor below the baseline mechanism', () => {
    // A first-ever run has no baseline, so the floor is the only thing
    // standing between a broken prompt and adoption.
    expect(CALIBRATION_MIN_ABSOLUTE_ACCURACY).toBeGreaterThan(0.5);
    expect(CALIBRATION_MIN_ABSOLUTE_ACCURACY).toBeLessThan(1);
    expect(CALIBRATION_REGRESSION_THRESHOLD).toBeGreaterThan(0);
    expect(CALIBRATION_REGRESSION_THRESHOLD).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------

describe('recordCalibrationRun', () => {
  it('persists the run against its prompt id, version and model', async () => {
    await clearCalibrationHistory();
    useCompetentClassifier();

    const result = (await runCalibration())[0];
    expect(result).toBeDefined();
    if (!result) return;
    await recordCalibrationRun(result);

    const rows = await ctx.db.query<{
      prompt_id: string;
      prompt_version: number;
      model: string;
      fixtures_total: number;
      fixtures_passed: number;
      accuracy: string | number;
      baseline_accuracy: string | number | null;
      regressed: boolean;
      detail_json: unknown;
    }>('SELECT * FROM calibration_runs');

    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0];
    expect(row?.prompt_id).toBe(REPLY_CLASSIFIER_PROMPT_ID);
    expect(Number(row?.prompt_version)).toBe(1);
    expect(row?.model).toBe('claude-haiku-4-5');
    expect(Number(row?.fixtures_total)).toBe(result.total);
    expect(Number(row?.fixtures_passed)).toBe(result.passed);
    expect(Number(row?.accuracy)).toBeCloseTo(result.accuracy, 4);
    expect(row?.regressed).toBe(false);
  });

  it('stores fixture ids and labels, never fixture bodies', async () => {
    await clearCalibrationHistory();
    useBrokenClassifier();

    const result = (await runCalibration())[0];
    if (result) await recordCalibrationRun(result);
    useCompetentClassifier();

    const rows = await ctx.db.query<{ detail_json: unknown }>('SELECT detail_json FROM calibration_runs');
    const serialized = JSON.stringify(
      typeof rows.rows[0]?.detail_json === 'string' ? JSON.parse(rows.rows[0].detail_json as string) : rows.rows[0]?.detail_json,
    );

    // The failure list is there...
    expect(serialized).toContain(INJECTION_FIXTURE_ID);
    // ...but not one byte of the payload that fixture carries.
    expect(serialized).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(serialized).not.toContain('169.254.169.254');
    expect(serialized).not.toContain('collector@attacker.example');
    expect(serialized).not.toContain('$19/month');
  });

  it('never throws back into the caller', async () => {
    await expect(
      recordCalibrationRun({
        promptId: REPLY_CLASSIFIER_PROMPT_ID,
        promptVersion: Number.NaN,
        model: 'x',
        total: 0,
        passed: 0,
        accuracy: Number.NaN,
        baselineAccuracy: null,
        regressed: false,
        failures: [],
      }),
    ).resolves.toBeUndefined();
  });
});
