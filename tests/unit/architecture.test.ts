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
