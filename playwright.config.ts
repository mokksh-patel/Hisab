import { defineConfig, devices } from '@playwright/test';
import { readE2EConfig } from './tests/e2e/env';

/**
 * E2E configuration.
 *
 * LOCAL ONLY. `.env.local` is deliberately NOT loaded: it holds the developer's
 * hosted test-project credentials, and loading it would let the browser tests
 * write to a remote database. Instead the suite reads dedicated E2E_* variables
 * (see tests/e2e/env.ts), which are validated to be loopback addresses.
 *
 * The app under test is Vite, which reads VITE_SUPABASE_URL and
 * VITE_SUPABASE_PUBLISHABLE_KEY at build/dev-server start. Those are pointed at
 * the same local stack here, so the browser and the API fixtures share one
 * database. Only the publishable (anon) key is ever propagated — never a
 * service-role key.
 */

// Propagate the validated local configuration to the Vite dev server. If the
// configuration is missing or remote, readE2EConfig throws and the run fails
// loudly rather than silently skipping every test.
const e2eConfig = readE2EConfig();
process.env.VITE_SUPABASE_URL = e2eConfig.url;
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = e2eConfig.publishableKey;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
