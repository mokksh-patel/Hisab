/**
 * e2e/cli-version.ts — the Supabase CLI version the E2E setup targets.
 *
 * Kept in its own module, free of Node built-ins, so the unit-test project can
 * import it. Importing global-setup.ts directly would pull in
 * `node:child_process`, `node:fs` and `node:path`, and the unit project has no
 * Node types.
 *
 * MUST match `SUPABASE_CLI_VERSION` in .github/workflows/bizpilot-ci.yml. The
 * workflow installs that exact version with `supabase/setup-cli@v3`, and
 * global-setup.ts prefers that installed binary over any npm download.
 */

export const PINNED_SUPABASE_CLI_VERSION = '2.122.1';
