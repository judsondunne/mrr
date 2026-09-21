/**
 * Architectural invariants, enforced mechanically.
 *
 * These are the rules that make "RESEARCH IS NOT VALIDATION" true in practice
 * rather than aspirationally. They scan the real source tree, so they keep
 * holding as the codebase grows — including for code written by someone (or
 * something) that never read the README.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Removes // and block comments so scans see code, not prose about code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function filesUnder(...segments: string[]): Promise<Array<{ path: string; text: string }>> {
  const files = await walk(join(SRC, ...segments));
  return Promise.all(
    files.map(async (path) => ({ path: relative(process.cwd(), path), text: await readFile(path, 'utf8') })),
  );
}

describe('the validation layer is pure deterministic code', () => {
  it('contains no LLM import anywhere', async () => {
    const files = await filesUnder('pipeline', 'validation');
    const offenders = files.filter(
      (f) =>
        /from\s+['"][^'"]*\/llm(\/|['"])/.test(f.text) ||
        /@anthropic-ai\/sdk/.test(f.text) ||
        /\bllmComplete\b/.test(f.text),
    );
    expect(
      offenders.map((o) => o.path),
      'No LLM may influence whether an opportunity is validated. Use SQL and code.',
    ).toEqual([]);
  });

  it('contains no web search or outbound fetch', async () => {
    const files = await filesUnder('pipeline', 'validation');
    const offenders = files.filter(
      (f) => /\bpoliteFetch\b/.test(f.text) || /from\s+['"][^'"]*\/search(\/|['"])/.test(f.text),
    );
    expect(offenders.map((o) => o.path)).toEqual([]);
  });
});

describe('the gate token cannot be forged', () => {
  it('is minted in exactly one file', async () => {
    const files = await walk(SRC);
    const minters: string[] = [];
    for (const path of files) {
      const text = await readFile(path, 'utf8');
      if (path.endsWith(join('lib', 'state-machine.ts'))) continue; // the definition
      if (/__mintGateToken/.test(text)) minters.push(relative(process.cwd(), path));
    }
    // Only the deterministic gate may mint. Zero is also valid before the
    // validation layer lands; more than one is always a defect.
    expect(minters.length, `minted in: ${minters.join(', ')}`).toBeLessThanOrEqual(1);
    for (const m of minters) {
      expect(m, 'only the validation gate may mint a GateToken').toMatch(
        /pipeline[/\\]validation[/\\]/,
      );
    }
  });

  it('does not export its constructor', async () => {
    const text = await readFile(join(SRC, 'lib', 'state-machine.ts'), 'utf8');
    expect(text).not.toMatch(/export\s+class\s+GateTokenImpl/);
    expect(text).toMatch(/export\s+type\s+GateToken\s*=/);
  });
});

describe('opportunity state is never written behind the state machine', () => {
  it('only audit.ts issues an UPDATE to opportunities.state', async () => {
    const files = await walk(SRC);
    const offenders: string[] = [];
    for (const path of files) {
      if (path.endsWith(join('lib', 'audit.ts'))) continue; // the sanctioned writer
      const text = await readFile(path, 'utf8');
      // Matches `UPDATE opportunities ... SET ... state =` across newlines.
      if (/UPDATE\s+opportunities[\s\S]{0,200}?\bSET\b[\s\S]{0,200}?\bstate\s*=/i.test(text)) {
        offenders.push(relative(process.cwd(), path));
      }
    }
    expect(
      offenders,
      'Use transitionOpportunity() so the edge is validated and the change is audited.',
    ).toEqual([]);
  });
});

describe('metered resources go through the budgeted wrappers', () => {
  it('only the anthropic provider imports the Anthropic SDK', async () => {
    const files = await walk(SRC);
    const importers: string[] = [];
    for (const path of files) {
      const text = await readFile(path, 'utf8');
      if (/(?:from|import\s*\()\s*['"]@anthropic-ai\/sdk[^'"]*['"]/.test(text)) {
        importers.push(relative(process.cwd(), path));
      }
    }
    expect(importers).toEqual([join('src', 'lib', 'llm', 'anthropic.ts')]);
  });

  it('only the resend provider imports the Resend SDK', async () => {
    const files = await walk(SRC);
    const importers: string[] = [];
    for (const path of files) {
      const text = await readFile(path, 'utf8');
      // Catch static AND dynamic imports — `await import('resend')` must not
      // be a way around the budgeted wrapper.
      if (/(?:from|import\s*\()\s*['"]resend['"]/.test(text)) {
        importers.push(relative(process.cwd(), path));
      }
    }
    expect(importers).toEqual([join('src', 'lib', 'email', 'index.ts')]);
  });

  it('only the search provider calls the Brave endpoint', async () => {
    const files = await walk(SRC);
    const callers: string[] = [];
    for (const path of files) {
      const text = await readFile(path, 'utf8');
      if (/api\.search\.brave\.com/.test(text)) callers.push(relative(process.cwd(), path));
    }
    expect(callers).toEqual([join('src', 'lib', 'search', 'index.ts')]);
  });
});

describe('weak signals are structurally incapable of becoming commitments', () => {
  it('the commitment type enum has no weak-signal member', async () => {
    const text = await readFile(join(SRC, 'lib', 'contracts.ts'), 'utf8');
    const block = text.slice(text.indexOf('export const CommitmentType'));
    const decl = block.slice(0, block.indexOf(']'));
    for (const weak of ['OPEN', 'CLICK', 'PAGE_VIEW', 'INTERESTED_WEAK', 'LIKE', 'SURVEY']) {
      expect(decl, `"${weak}" must never be a commitment type`).not.toContain(weak);
    }
  });
});

describe('the system never claims guaranteed revenue', () => {
  it('no source file contains guarantee language', async () => {
    const files = await walk(SRC);
    const banned = /guaranteed\s+(mrr|revenue|income)|risk[- ]free\s+(income|revenue)/i;
    const offenders: string[] = [];
    for (const path of files) {
      const text = await readFile(path, 'utf8');
      // The assertion that BANS the phrase is allowed to name it.
      if (banned.test(text) && !/banned|forbidden|must not|never/i.test(text)) {
        offenders.push(relative(process.cwd(), path));
      }
    }
    expect(offenders).toEqual([]);
  });
});

// --- the two-plane rule -------------------------------------------------------
//
// "Adaptive" must not be able to become "unconstrained". These scan the real
// source tree, so they keep holding as the autonomy layer grows.

describe('the autonomy layer cannot reach into the control plane', () => {
  it('never mints a gate token', async () => {
    const files = await filesUnder('autonomy');
    const offenders = files.filter((f) => /__mintGateToken/.test(f.text));
    expect(
      offenders.map((o) => o.path),
      'Only the deterministic validation gate may mint. Adaptive strategy may not.',
    ).toEqual([]);
  });

  it('never writes opportunities.state directly', async () => {
    const files = await filesUnder('autonomy');
    const offenders = files.filter((f) =>
      /UPDATE\s+opportunities[\s\S]{0,200}?\bSET\b[\s\S]{0,200}?\bstate\s*=/i.test(f.text),
    );
    expect(offenders.map((o) => o.path)).toEqual([]);
  });

  it('never writes to the tables that hold control-plane outcomes', async () => {
    // Strategy may propose and measure. It may not edit commitments,
    // suppression, or the cost ledger — those are the record of what actually
    // happened and what we are allowed to spend.
    const files = await filesUnder('autonomy');
    const protectedTables = ['commitments', 'suppression_list', 'cost_ledger'];
    const offenders: string[] = [];
    for (const f of files) {
      for (const table of protectedTables) {
        const re = new RegExp(`(UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, 'i');
        if (re.test(f.text)) offenders.push(`${f.path} -> ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares every control-plane field the guard must refuse', async () => {
    const { FORBIDDEN_STRATEGY_FIELDS } = await import('../../src/autonomy/types');
    // These are the ones whose absence would be a real hole, not a typo.
    for (const required of [
      'monthlyLlmBudgetUsd',
      'maxEmailsPerDay',
      'maxFollowups',
      'allowedOutreachCountries',
      'minUniqueStrongCommitments',
      'minUniquePriceAcceptances',
      'requiredCategoryEvidenceConfidence',
      'unsubscribeSecret',
      'killSwitch',
    ]) {
      expect(FORBIDDEN_STRATEGY_FIELDS, `${required} must be un-editable by strategy`).toContain(
        required,
      );
    }
  });
});

describe('learning optimises on downstream commitments, never on opens', () => {
  it('no reward computation references opens or clicks', async () => {
    const files = await filesUnder('autonomy', 'strategy');
    const offenders = files.filter((f) => {
      // Scan CODE only. The phrase "opens are never a reward" is a comment we
      // want to keep, so a naive scan would flag the prohibition itself.
      const code = stripComments(f.text);
      return /\breward\b/i.test(code) && /\bopened_at\b|\bopens\b|\bclicked_at\b/i.test(code);
    });
    expect(
      offenders.map((o) => o.path),
      'Opens are recorded but are never a validation or learning signal.',
    ).toEqual([]);
  });
});

describe('the agent cannot edit its own source', () => {
  it('no runtime module writes to the filesystem outside the build-spec export', async () => {
    const files = [...(await filesUnder('autonomy')), ...(await filesUnder('pipeline'))];
    const offenders: string[] = [];
    for (const f of files) {
      // The build-spec generator is the one sanctioned writer, and it only
      // ever writes under validated/<slug>/.
      if (f.path.includes(join('pipeline', 'buildspec'))) continue;
      if (/\bwriteFile\b|\bwriteFileSync\b|\bappendFile\b|\brm\b\(|\bunlink\b/.test(f.text)) {
        offenders.push(f.path);
      }
    }
    expect(
      offenders,
      'The running agent may modify strategy rows, never source files.',
    ).toEqual([]);
  });

  it('nothing shells out', async () => {
    const files = [...(await filesUnder('autonomy')), ...(await filesUnder('pipeline'))];
    // Note: a bare /exec\(/ would match RegExp.prototype.exec, which is
    // ordinary parsing. Match process spawning specifically.
    const offenders = files.filter((f) =>
      /child_process|execSync|spawnSync|execFile|\bspawn\(/.test(stripComments(f.text)),
    );
    expect(offenders.map((o) => o.path)).toEqual([]);
  });
});
