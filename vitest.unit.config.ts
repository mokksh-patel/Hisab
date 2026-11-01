import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Minimal configuration for pure-logic unit tests.
 *
 * The unit suite (money, dateUtils, aging, whatsapp, phone, invoiceCalculations,
 * paymentAllocation) contains no JSX and no DOM usage, so it does not need
 * @vitejs/plugin-react or jsdom. Keeping this config separate means a problem in
 * the React transform pipeline cannot block verification of the financial logic.
 *
 * The full application config (vitest.config.ts) still provides React + jsdom
 * for component tests.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
  },
});
