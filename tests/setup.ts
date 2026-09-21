/**
 * Global test setup. Forces every test onto an in-memory PGlite database and
 * mock providers, so the suite never touches a network or a real credential.
 */
import { beforeEach } from 'vitest';

process.env.DATABASE_MODE = 'pglite';
process.env.PGLITE_DATA_DIR = ':memory:';
process.env.LLM_PROVIDER = 'mock';
process.env.SEARCH_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'mock';
process.env.ANTHROPIC_API_KEY = '';
process.env.BRAVE_SEARCH_API_KEY = '';
process.env.RESEND_API_KEY = '';
process.env.LOG_LEVEL = process.env.SIM_LOG_LEVEL ?? 'error';
process.env.AUTONOMY_ENABLED = 'false';
process.env.OUTREACH_ENABLED = 'false';

beforeEach(() => {
  // Each test file re-derives config; individual tests may override env then
  // call resetConfigCache() themselves.
});
