import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
    setupFiles: ['tests/setup.ts'],
    /**
     * Pin the provider identity and price list the suite asserts against.
     *
     * `src/lib/config.ts` calls dotenv at import time, so on a machine with a
     * real .env the suite would otherwise run against whatever that developer
     * configured — a Gemini .env made three tests fail by supplying different
     * model names and per-token rates. dotenv does not overwrite variables
     * that are already set, so defining them here shadows .env for every test,
     * including pure-function tests that never call freshDb().
     */
    env: {
      LLM_PROVIDER: 'mock',
      SEARCH_PROVIDER: 'mock',
      EMAIL_PROVIDER: 'mock',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      BRAVE_SEARCH_API_KEY: '',
      RESEND_API_KEY: '',
      LLM_FAST: 'claude-haiku-4-5',
      LLM_REASONER: 'claude-sonnet-5',
      LLM_FAST_INPUT_COST_PER_MTOK: '1.0',
      LLM_FAST_OUTPUT_COST_PER_MTOK: '5.0',
      LLM_REASONER_INPUT_COST_PER_MTOK: '2.0',
      LLM_REASONER_OUTPUT_COST_PER_MTOK: '10.0',
      BRAVE_SEARCH_COST_PER_CALL_USD: '0.005',
      OWNER_TEST_EMAIL: '',
      OWNER_NOTIFICATION_EMAIL: '',
      AUTO_START: 'true',
      PUBLIC_BASE_URL: 'http://localhost:3000',
      SENDER_EMAIL: '',
      SENDING_DOMAIN: '',
      SENDER_POSTAL_ADDRESS: '',
      SENDER_COMPANY: '',
      CRON_SECRET: '',
      ADMIN_TOKEN: '',
      UNSUBSCRIBE_SECRET: '',
      AUTONOMY_ENABLED: 'false',
      OUTREACH_ENABLED: 'false',
      PGLITE_DATA_DIR: ':memory:',
      LOG_LEVEL: 'error',
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
