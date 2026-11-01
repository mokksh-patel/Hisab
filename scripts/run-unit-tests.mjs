/**
 * run-unit-tests.mjs — bounded alternative to the broken Vitest harness.
 *
 * WHY THIS EXISTS
 * The Vitest runner fails before any test body executes with
 * `TypeError: Cannot read properties of undefined (reading 'config')`.
 * That is a harness fault, not a problem with the tests themselves — the seven
 * unit files are pure logic with no React, DOM or Supabase dependency.
 *
 * This script runs the same test files under Node's built-in test runner by
 * providing a minimal `describe`/`it`/`expect` shim. It does NOT replace the
 * Vitest files; it executes them unchanged.
 *
 * Usage: node scripts/run-unit-tests.mjs
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Register the loader that maps `vitest` and `@/` to our shims.
register('./unit-test-loader.mjs', pathToFileURL(resolve('scripts') + '/'));

const testDir = resolve('tests/unit');
const files = readdirSync(testDir).filter((file) => file.endsWith('.test.ts'));

console.log(`Running ${files.length} unit test files under node:test\n`);

for (const file of files) {
  await import(pathToFileURL(resolve(testDir, file)).href);
}
