/**
 * unit-test-loader.mjs — module loader that lets the existing Vitest test files
 * run under Node's built-in test runner.
 *
 * It resolves:
 *   - `vitest`  -> scripts/vitest-shim.mjs  (describe/it/expect)
 *   - `@/...`   -> src/...                  (the app's path alias)
 *
 * The test files themselves are NOT modified.
 */

import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';

const SHIM_URL = pathToFileURL(resolvePath('scripts/vitest-shim.mjs')).href;
const SRC_DIR = resolvePath('src');

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vitest') {
    return { url: SHIM_URL, shortCircuit: true };
  }

  if (specifier.startsWith('@/')) {
    const target = resolvePath(SRC_DIR, specifier.slice(2));
    for (const candidate of [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`]) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }

  // Relative imports inside src/ are written without extensions (Vite resolves
  // them). Node needs the extension, so try the common ones.
  if (specifier.startsWith('.') && context.parentURL?.includes('/src/')) {
    const base = resolvePath(new URL(context.parentURL).pathname.replace(/^\//, ''), '..', specifier);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }

  return nextResolve(specifier, context);
}
