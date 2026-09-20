#!/usr/bin/env tsx
/**
 * Flips AUTONOMY_ENABLED / OUTREACH_ENABLED in the local .env file.
 *
 * Deliberately refuses to enable outreach until /setup-check passes, so the
 * dangerous switch cannot be flipped by accident.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runSetupChecks } from '../lib/setup-check';
import { closeDb } from '../lib/db';

const ENV_PATH = resolve(process.cwd(), '.env');

async function setFlag(key: string, value: string): Promise<void> {
  let content = '';
  try {
    content = await readFile(ENV_PATH, 'utf8');
  } catch {
    console.error(`No .env file at ${ENV_PATH}. Copy .env.example to .env first.`);
    process.exit(1);
  }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  content = re.test(content) ? content.replace(re, line) : `${content.trimEnd()}\n${line}\n`;
  await writeFile(ENV_PATH, content, 'utf8');
  console.log(`  ${key} = ${value}`);
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action !== 'enable' && action !== 'disable') {
    console.log('Usage: npm run autonomy:enable | npm run autonomy:disable');
    process.exit(1);
  }

  if (action === 'disable') {
    await setFlag('AUTONOMY_ENABLED', 'false');
    await setFlag('OUTREACH_ENABLED', 'false');
    console.log('\nAutonomy disabled. The system is back in shadow mode.');
    await closeDb().catch(() => undefined);
    return;
  }

  console.log('Verifying setup before enabling autonomy...\n');
  const report = await runSetupChecks();
  for (const c of report.checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  -> ${c.remediation}`}`);
  }

  if (!report.safeToSend) {
    console.error('\nRefusing to enable outreach: safety-critical configuration is incomplete.');
    console.error('Fix the FAIL lines above, then run this again.');
    await closeDb().catch(() => undefined);
    process.exit(1);
  }

  console.log('\nAll safety-critical checks passed. Enabling:');
  await setFlag('AUTONOMY_ENABLED', 'true');
  await setFlag('OUTREACH_ENABLED', 'true');
  console.log('\nThe system will now contact real businesses on its next scheduled run.');
  console.log('You will normally only hear from it again when an opportunity passes');
  console.log('the READY_TO_BUILD gate.');
  await closeDb().catch(() => undefined);
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
