/**
 * PUBLIC API — MODEL CALIBRATION. Owned by the security agent.
 *
 * A prompt or model change must not silently degrade reply classification —
 * that would corrupt every downstream learning signal.
 *
 * The failure this exists to prevent is quiet. Reply classification feeds
 * commitment extraction, which feeds the bandit's reward, which feeds every
 * strategy decision the system makes. A classifier that has quietly become 60%
 * accurate does not throw; it just teaches the machine the wrong lesson for a
 * month. So the frozen fixtures in tests/fixtures/calibration/ are re-run
 * against the LIVE configuration, the accuracy is written to `calibration_runs`
 * next to the prompt id, prompt version and model that produced it, and a
 * configuration that has regressed past the threshold is refused.
 *
 * Two properties of the fixture set are deliberate:
 *   - Some fixtures are AMBIGUOUS, and their accepted answers are recorded as
 *     a set. Pretending a hard case has one right answer would make the metric
 *     dishonest, and an honest 93% is more useful than a rigged 100%.
 *   - One fixture carries a live prompt-injection payload and a perfectly
 *     ordinary correct label. It passes only if the classifier read the
 *     attack as DATA. See tests/fixtures/calibration/12-*.json.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { getConfig } from '../lib/config';
import { getDb, toNumber } from '../lib/db';
import { newId } from '../lib/hash';
import { createLogger } from '../lib/logger';
import { ReplyClassification } from '../lib/contracts';
import { classifyReply } from '../pipeline/outreach/classify';

const logger = createLogger('autonomy:calibration');

export interface CalibrationResult {
  promptId: string;
  promptVersion: number;
  model: string;
  total: number;
  passed: number;
  accuracy: number;
  baselineAccuracy: number | null;
  regressed: boolean;
  failures: Array<{ fixture: string; expected: string; actual: string }>;
}

/**
 * CONTROL PLANE. These are thresholds, so they are typed constants in code
 * with no AI write path — the strategy plane may not widen them, and there is
 * deliberately no env override that could be set to 1.0 to make the guard
 * vacuous.
 */
export const CALIBRATION_REGRESSION_THRESHOLD = 0.05;
export const CALIBRATION_MIN_ABSOLUTE_ACCURACY = 0.75;

/** The one prompt whose output the whole learning loop depends on, today. */
export const REPLY_CLASSIFIER_PROMPT_ID = 'outreach.classify_reply';

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'calibration');

/** Context the classifier is given in production. Held constant across runs. */
const CALIBRATION_OFFER_SUMMARY =
  'Minimum Order Rules for Shopify stores with a wholesale channel. $19/month. Not built yet.';

export const CalibrationFixture = z.object({
  id: z.string().min(1).max(80),
  subject: z.string().max(300).default(''),
  body: z.string().min(1).max(20_000),
  /** The label a careful human annotator would give. */
  expected: ReplyClassification,
  /** Other labels a careful human annotator could defensibly give. */
  alsoAccepted: z.array(ReplyClassification).default([]),
  ambiguous: z.boolean().default(false),
  note: z.string().max(800).default(''),
  offerSummary: z.string().max(600).optional(),
});
export type CalibrationFixture = z.infer<typeof CalibrationFixture>;

/**
 * Reads the frozen fixture set. Sorted by id so a run is reproducible and two
 * runs are comparable.
 *
 * Total: a missing directory or a malformed file yields fewer fixtures, never
 * an exception, and never a filesystem path in a log line or an error.
 */
export async function loadCalibrationFixtures(): Promise<CalibrationFixture[]> {
  let names: string[];
  try {
    names = (await readdir(FIXTURE_DIR)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    logger.warn('calibration fixture set is not present in this deployment');
    return [];
  }

  const out: CalibrationFixture[] = [];
  for (const name of names) {
    try {
      const parsed = CalibrationFixture.safeParse(JSON.parse(await readFile(join(FIXTURE_DIR, name), 'utf8')));
      if (!parsed.success) {
        logger.warn('calibration fixture rejected by schema', {
          fixtureFile: name,
          issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        continue;
      }
      out.push(parsed.data);
    } catch {
      logger.warn('calibration fixture unreadable', { fixtureFile: name });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Every label a fixture accepts, primary first. */
export function acceptedLabels(fixture: CalibrationFixture): string[] {
  return [fixture.expected, ...fixture.alsoAccepted.filter((l) => l !== fixture.expected)];
}

/**
 * Runs the CURRENT classifier configuration against the frozen fixtures.
 *
 * "Current" is load-bearing: this calls the same `classifyReply()` the inbound
 * pipeline calls, so the deterministic compliance rules run first exactly as
 * they do in production, and only the remainder reaches the model. Measuring a
 * reimplementation of the classifier would measure nothing.
 */
export async function runCalibration(promptId?: string): Promise<CalibrationResult[]> {
  const targets = promptId === undefined ? [REPLY_CLASSIFIER_PROMPT_ID] : [promptId];
  const results: CalibrationResult[] = [];

  for (const target of targets) {
    if (target !== REPLY_CLASSIFIER_PROMPT_ID) {
      logger.warn('no calibration fixtures exist for this prompt', { promptId: target });
      continue;
    }

    const fixtures = await loadCalibrationFixtures();
    if (fixtures.length === 0) {
      logger.warn('calibration skipped: no fixtures', { promptId: target });
      continue;
    }

    const cfg = getConfig();
    const model = cfg.llmFast;
    const promptVersion = await activePromptVersion(target);
    const baselineAccuracy = await storedBaseline(target);

    const failures: CalibrationResult['failures'] = [];
    let passed = 0;

    for (const fixture of fixtures) {
      const actual = await classifyFixture(fixture);
      if (acceptedLabels(fixture).includes(actual)) passed += 1;
      else failures.push({ fixture: fixture.id, expected: acceptedLabels(fixture).join('|'), actual });
    }

    const accuracy = round4(passed / fixtures.length);
    const regressed =
      baselineAccuracy !== null && accuracy < baselineAccuracy - CALIBRATION_REGRESSION_THRESHOLD;

    results.push({
      promptId: target,
      promptVersion,
      model,
      total: fixtures.length,
      passed,
      accuracy,
      baselineAccuracy,
      regressed,
      failures,
    });
  }

  return results;
}

/**
 * False when accuracy regressed past the configured threshold.
 *
 * Fails CLOSED. "I could not measure this configuration" and "this
 * configuration is worse than the baseline" both return false, because the
 * caller's next step is to adopt a prompt or model change and an unverifiable
 * change is not a safe one.
 */
export async function isConfigurationAcceptable(promptId: string): Promise<boolean> {
  const [result] = await runCalibration(promptId);

  if (!result || result.total === 0) {
    logger.warn('configuration refused: not calibratable', { promptId });
    return false;
  }
  if (result.regressed) {
    logger.warn('configuration refused: accuracy regressed against the stored baseline', {
      promptId,
      accuracy: result.accuracy,
      baselineAccuracy: result.baselineAccuracy,
      threshold: CALIBRATION_REGRESSION_THRESHOLD,
      failures: result.failures.length,
    });
    return false;
  }
  if (result.accuracy < CALIBRATION_MIN_ABSOLUTE_ACCURACY) {
    logger.warn('configuration refused: below the absolute accuracy floor', {
      promptId,
      accuracy: result.accuracy,
      floor: CALIBRATION_MIN_ABSOLUTE_ACCURACY,
    });
    return false;
  }
  return true;
}

/** Persists one run against its prompt id, version and model. */
export async function recordCalibrationRun(result: CalibrationResult): Promise<void> {
  try {
    const db = await getDb();
    await db.query(
      `INSERT INTO calibration_runs
         (id, prompt_id, prompt_version, model, fixtures_total, fixtures_passed,
          accuracy, baseline_accuracy, regressed, detail_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        newId('cal'),
        result.promptId,
        result.promptVersion,
        result.model,
        result.total,
        result.passed,
        round4(result.accuracy),
        result.baselineAccuracy === null ? null : round4(result.baselineAccuracy),
        result.regressed,
        // Fixture IDS and labels only. Fixture bodies contain a live injection
        // payload and have no business being copied into the database.
        JSON.stringify({
          failures: result.failures.slice(0, 50),
          regressionThreshold: CALIBRATION_REGRESSION_THRESHOLD,
          minAbsoluteAccuracy: CALIBRATION_MIN_ABSOLUTE_ACCURACY,
        }),
      ],
    );
    logger.info('calibration run recorded', {
      promptId: result.promptId,
      promptVersion: result.promptVersion,
      accuracy: result.accuracy,
      baselineAccuracy: result.baselineAccuracy,
      regressed: result.regressed,
    });
  } catch (err) {
    logger.error('failed to record calibration run', { err: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * One fixture through the production classifier.
 *
 * The body is passed EXACTLY as it arrived. It is not sanitised first, because
 * the question this fixture set answers is what the current pipeline does with
 * the bytes a stranger actually sent — sanitising here would measure a
 * configuration that is not the one running.
 */
async function classifyFixture(fixture: CalibrationFixture): Promise<string> {
  try {
    const outcome = await classifyReply({
      text: fixture.body,
      subject: fixture.subject,
      offerSummary: fixture.offerSummary ?? CALIBRATION_OFFER_SUMMARY,
    });
    return outcome.analysis.classification;
  } catch (err) {
    // A failed call is a failed fixture, not a failed run.
    logger.warn('fixture classification failed', { fixture: fixture.id, err: String(err) });
    return 'CLASSIFICATION_ERROR';
  }
}

/** The active version of a prompt, or 1 when versioning has not been used yet. */
async function activePromptVersion(promptId: string): Promise<number> {
  try {
    const db = await getDb();
    const res = await db.query<{ version: number }>(
      `SELECT version FROM prompt_versions
        WHERE prompt_id = $1 AND active = true
        ORDER BY version DESC LIMIT 1`,
      [promptId],
    );
    return Math.max(1, Math.trunc(toNumber(res.rows[0]?.version, 1)));
  } catch (err) {
    logger.warn('prompt version lookup failed; assuming v1', { promptId, err: String(err) });
    return 1;
  }
}

/**
 * The bar a new configuration has to clear: the best accuracy this prompt has
 * ever recorded.
 *
 * "Best ever" rather than "most recent" on purpose. A regressed run is still
 * written to the table for the audit trail, and a rule based on the last row
 * would quietly accept the regression as the new normal on the following run.
 */
async function storedBaseline(promptId: string): Promise<number | null> {
  try {
    const db = await getDb();
    const res = await db.query<{ best: string | number | null }>(
      'SELECT MAX(accuracy) AS best FROM calibration_runs WHERE prompt_id = $1',
      [promptId],
    );
    const best = res.rows[0]?.best;
    return best === null || best === undefined ? null : round4(toNumber(best));
  } catch (err) {
    logger.warn('baseline lookup failed; treating as uncalibrated', { promptId, err: String(err) });
    return null;
  }
}

/** calibration_runs.accuracy is NUMERIC(6,4); round before it gets there. */
function round4(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : 0;
}
