# BizPilot — Build Progress

Last updated: Phase 2 (database preparation)

---

## Current status

| Area | Status | Notes |
|---|---|---|
| Database migrations (0001–0004) | Written, reviewed, **not deployed** | Awaiting explicit approval for `db push` |
| pgTAP security suite | Written, **never executed** | Docker daemon unavailable — see blocker B1 |
| Unit test suite (7 files) | Written, **cannot run** | Vitest harness failure — see blocker B2 |
| Application UI | **Not started** | No `App.tsx`, router, pages or auth screens exist |
| Supabase project link | Complete | `gdhaszmgwowfxgxllpva` |

---

## Blockers

### B1 — Docker daemon unavailable (blocks pgTAP execution)

`supabase test db` requires a local Supabase stack, which requires Docker.

- Docker CLI is installed: `Docker version 29.9.2, build a82e528`
- The daemon is **not running**: `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`
- The Windows service `com.docker.service` is present but **Stopped**
- `Start-Service com.docker.service` fails: `Cannot open com.docker.service service on computer '.'` — requires administrator privileges the agent session does not have.
- Launching `C:\Program Files\Docker\Docker\Docker Desktop.exe` was attempted. After 105 seconds the service remained `Stopped` and `docker ps` returned `Error response from daemon: Docker Desktop is unable to start`.

**Consequence:** the pgTAP suite has never been executed. No claim of passing tests is made anywhere in this document.

**Resolution options (require the user):**
1. Start Docker Desktop manually (may require a reboot or WSL2 backend repair), then run `npx supabase start` followed by `npx supabase test db`.
2. Grant the agent an elevated shell.
3. Run the pgTAP suite against a throwaway Supabase branch or a separate disposable project — **never** the main hosted project.

### B3 — No Supabase access token (blocks CLI verification)

`supabase migration list --linked` and `supabase db push --linked --dry-run` both fail with:

```
Access token not provided. Supply an access token by running `supabase login`
or setting the SUPABASE_ACCESS_TOKEN environment variable.
```

No `SUPABASE_ACCESS_TOKEN` is present in the environment. The project link itself is intact (`supabase/.temp/project-ref` = `gdhaszmgwowfxgxllpva`), but every CLI command that talks to the Management API is blocked.

**Consequence:** remote migration history could not be read, and the dry-run could not be re-executed in this session. The earlier dry-run result reported by the user is taken as given but is not independently confirmed here.

**Resolution:** run `npx supabase login` interactively, or export `SUPABASE_ACCESS_TOKEN`.

### B2 — Vitest harness failure (blocks unit test execution)

All seven unit test files fail before any test body runs:

```
TypeError: Cannot read properties of undefined (reading 'config')
```

The error is raised at the first `describe(...)` call in each file.

**Diagnostics performed (bounded, per instruction):**

| Hypothesis | Test | Result |
|---|---|---|
| `@vitejs/plugin-react` transform | `vitest.unit.config.ts` with no React plugin | **Not the cause** — identical failure |
| jsdom environment | `--environment node` | **Not the cause** |
| Setup file (`tests/setup.ts`) | Config with no `setupFiles` | **Not the cause** |
| File parallelism | `--no-file-parallelism`, `--no-isolate` | **Not the cause** |
| Dependency version conflict | `npm ls vitest vite` | **No conflict** — `vitest@4.1.12` + `vite@8.3.5` deduped; Vitest peer range is `^6 \|\| ^7 \|\| ^8` |

**Root cause: not identified.** The failure occurs inside Vitest's own config resolution, before test collection.

**Deliberately not done:** no dependency versions were changed, no test files were modified or deleted. All seven test files are preserved intact.

**Workaround available but not applied:** the seven files are pure logic (no React, no DOM, no Supabase) and could run under `node --test` with a small `expect` shim. Not implemented — awaiting a decision.

---

## Files created in Phase 2

| File | Purpose |
|---|---|
| `supabase/config.toml` | Local Supabase stack configuration (did not previously exist) |
| `supabase/tests/02_view_isolation_test.sql` | pgTAP tests for `invoice_balances` and `customer_receivables` tenant isolation |
| `BUILD_PROGRESS.md` | This file |

## Files modified in Phase 2

| File | Change |
|---|---|
| `supabase/tests/01_security_test.sql` | Plan count updated to match actual assertion count |

No migration file was modified. No application source file was modified.

---

## Verified facts about the remote project

Established by direct REST probing against `https://gdhaszmgwowfxgxllpva.supabase.co` using the publishable key from `.env.local`:

**Tables — all 11 return `404 PGRST205` (absent):**
`businesses`, `profiles`, `business_members`, `customers`, `invoice_sequences`, `invoices`, `invoice_items`, `payments`, `payment_allocations`, `reminder_logs`, `audit_logs`

**Views — all 3 return `404 PGRST205` (absent):**
`invoice_balances`, `payment_balances`, `customer_receivables`

**Functions — all 17 return `404 PGRST202` (absent):**
`create_business_with_owner`, `next_invoice_number`, `create_invoice`, `issue_invoice`, `void_invoice`, `record_payment`, `reverse_payment`, `log_reminder`, `is_business_member`, `has_business_role`, `can_write_financials`, `can_manage_business`, `is_business_owner`, `write_audit_log`, `assert_can_write`, `assert_can_manage`, `financial_year_of`

**Other:**
- `GET /storage/v1/bucket` returns `200 []` — no storage buckets.
- `GET /auth/v1/health` returns `200`, GoTrue v2.197.0 — the project is live.
- Postgres version recorded in `supabase/.temp/postgres-version`: `17.11.0.016`.

**Conclusion:** the remote `public` schema is empty. There are no naming conflicts and no pre-existing objects that migration 0001–0004 could collide with.

**Not verified:** remote migration history (blocker B3). The empty-schema evidence above is strong but indirect — it proves no objects exist, not that `supabase_migrations.schema_migrations` is empty.

---

## pgTAP suite status

**Executed against `bizpilot-test` (`xseytkeykqwgirgixlir`) on 2026-11-01. Both suites pass.**

| File | Assertions | Plan | Match | Result |
|---|---:|---:|---|---|
| `01_security_test.sql` | 66 | 66 | yes | **ALL PASSED** |
| `02_view_isolation_test.sql` | 16 | 16 | yes | **ALL PASSED** |
| **Total** | **82** | | | **82/82 passing** |

pgTAP 1.3.3 installed in the `extensions` schema. Migrations 0001–0004 applied to
`bizpilot-test` only. The original project `gdhaszmgwowfxgxllpva` was not touched.

### How the results were obtained

`supabase db query` returns only the final result set and discards `RAISE NOTICE`
output, which is how pgTAP emits TAP. Two helper scripts work around this:

- `scripts/build-tap-runner.mjs` — replaces `finish()` with a captured summary.
  pgTAP's `finish()` returns rows **only on failure**, so `ALL PASSED` means zero
  failing assertions.
- `scripts/build-tap-lines.mjs` — rewrites each assertion into
  `insert into tap_lines select * from <assertion>(...)` so individual failures
  can be identified by number.

### Six failures found and fixed in `01_security_test.sql`

The suite originally reported `# Looks like you failed 6 tests of 60`. Exact
failures and root causes:

| # | Assertion | Caught | Wanted | Root cause |
|---|---|---|---|---|
| 12 | An unauthenticated user cannot create a business | `28000` | `42501` | `create_business_with_owner` raises `28000 Not authenticated` when `auth.uid()` is null. The test expected the wrong SQLSTATE. |
| 15 | A read-only member cannot update a customer | no exception | `42501` | **RLS `USING` clauses filter rows, they do not raise.** The UPDATE matched zero rows and succeeded. |
| 16 | A read-only member cannot delete a customer | no exception | `42501` | Same — RLS filtered the row, no exception. |
| 17 | Collection staff cannot promote themselves to owner | no exception | `42501` | Same — the policy filtered the row. |
| 55 | Audit history cannot be modified | no exception | `22023` | `audit_logs` has no UPDATE policy, so RLS filtered every row and the append-only trigger never fired. |
| 56 | Audit history cannot be deleted | no exception | `22023` | Same — no DELETE policy, so the trigger never fired. |

**The important correction:** four of the six were not application bugs. They were
**incorrect test expectations**. RLS is a row filter, not an error raiser. Asserting
`throws_ok('42501')` on an UPDATE that RLS silently filters is wrong — the correct
assertion is that the statement completes *and changes nothing*.

Each was rewritten as a `lives_ok` (statement completes) plus an `is`/`cmp_ok`
that verifies the data is unchanged. This is a **stronger** test than the original:
it proves both that no exception leaks and that no data was modified.

No RLS policy, migration, or validation rule was weakened. The assertions were
corrected to match how PostgreSQL actually behaves.

### Assertion count change: 60 → 66

The plan was raised from 60 to 66 because the corrected assertions require two
statements each (the attempt, then the verification). Every original assertion is
still present; six were split into twelve. This is a justified test change, not a
reduction in coverage.

### Other fixes applied

- **`do # BizPilot — Build Progress

Last updated: Phase 2 (database preparation)

---

## Current status

| Area | Status | Notes |
|---|---|---|
| Database migrations (0001–0004) | Written, reviewed, **not deployed** | Awaiting explicit approval for `db push` |
| pgTAP security suite | Written, **never executed** | Docker daemon unavailable — see blocker B1 |
| Unit test suite (7 files) | Written, **cannot run** | Vitest harness failure — see blocker B2 |
| Application UI | **Not started** | No `App.tsx`, router, pages or auth screens exist |
| Supabase project link | Complete | `gdhaszmgwowfxgxllpva` |

---

## Blockers

### B1 — Docker daemon unavailable (blocks pgTAP execution)

`supabase test db` requires a local Supabase stack, which requires Docker.

- Docker CLI is installed: `Docker version 29.9.2, build a82e528`
- The daemon is **not running**: `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`
- The Windows service `com.docker.service` is present but **Stopped**
- `Start-Service com.docker.service` fails: `Cannot open com.docker.service service on computer '.'` — requires administrator privileges the agent session does not have.
- Launching `C:\Program Files\Docker\Docker\Docker Desktop.exe` was attempted. After 105 seconds the service remained `Stopped` and `docker ps` returned `Error response from daemon: Docker Desktop is unable to start`.

**Consequence:** the pgTAP suite has never been executed. No claim of passing tests is made anywhere in this document.

**Resolution options (require the user):**
1. Start Docker Desktop manually (may require a reboot or WSL2 backend repair), then run `npx supabase start` followed by `npx supabase test db`.
2. Grant the agent an elevated shell.
3. Run the pgTAP suite against a throwaway Supabase branch or a separate disposable project — **never** the main hosted project.

### B3 — No Supabase access token (blocks CLI verification)

`supabase migration list --linked` and `supabase db push --linked --dry-run` both fail with:

```
Access token not provided. Supply an access token by running `supabase login`
or setting the SUPABASE_ACCESS_TOKEN environment variable.
```

No `SUPABASE_ACCESS_TOKEN` is present in the environment. The project link itself is intact (`supabase/.temp/project-ref` = `gdhaszmgwowfxgxllpva`), but every CLI command that talks to the Management API is blocked.

**Consequence:** remote migration history could not be read, and the dry-run could not be re-executed in this session. The earlier dry-run result reported by the user is taken as given but is not independently confirmed here.

**Resolution:** run `npx supabase login` interactively, or export `SUPABASE_ACCESS_TOKEN`.

### B2 — Vitest harness failure (blocks unit test execution)

All seven unit test files fail before any test body runs:

```
TypeError: Cannot read properties of undefined (reading 'config')
```

The error is raised at the first `describe(...)` call in each file.

**Diagnostics performed (bounded, per instruction):**

| Hypothesis | Test | Result |
|---|---|---|
| `@vitejs/plugin-react` transform | `vitest.unit.config.ts` with no React plugin | **Not the cause** — identical failure |
| jsdom environment | `--environment node` | **Not the cause** |
| Setup file (`tests/setup.ts`) | Config with no `setupFiles` | **Not the cause** |
| File parallelism | `--no-file-parallelism`, `--no-isolate` | **Not the cause** |
| Dependency version conflict | `npm ls vitest vite` | **No conflict** — `vitest@4.1.12` + `vite@8.3.5` deduped; Vitest peer range is `^6 \|\| ^7 \|\| ^8` |

**Root cause: not identified.** The failure occurs inside Vitest's own config resolution, before test collection.

**Deliberately not done:** no dependency versions were changed, no test files were modified or deleted. All seven test files are preserved intact.

**Workaround available but not applied:** the seven files are pure logic (no React, no DOM, no Supabase) and could run under `node --test` with a small `expect` shim. Not implemented — awaiting a decision.

---

## Files created in Phase 2

| File | Purpose |
|---|---|
| `supabase/config.toml` | Local Supabase stack configuration (did not previously exist) |
| `supabase/tests/02_view_isolation_test.sql` | pgTAP tests for `invoice_balances` and `customer_receivables` tenant isolation |
| `BUILD_PROGRESS.md` | This file |

## Files modified in Phase 2

| File | Change |
|---|---|
| `supabase/tests/01_security_test.sql` | Plan count updated to match actual assertion count |

No migration file was modified. No application source file was modified.

---

## Verified facts about the remote project

Established by direct REST probing against `https://gdhaszmgwowfxgxllpva.supabase.co` using the publishable key from `.env.local`:

**Tables — all 11 return `404 PGRST205` (absent):**
`businesses`, `profiles`, `business_members`, `customers`, `invoice_sequences`, `invoices`, `invoice_items`, `payments`, `payment_allocations`, `reminder_logs`, `audit_logs`

**Views — all 3 return `404 PGRST205` (absent):**
`invoice_balances`, `payment_balances`, `customer_receivables`

**Functions — all 17 return `404 PGRST202` (absent):**
`create_business_with_owner`, `next_invoice_number`, `create_invoice`, `issue_invoice`, `void_invoice`, `record_payment`, `reverse_payment`, `log_reminder`, `is_business_member`, `has_business_role`, `can_write_financials`, `can_manage_business`, `is_business_owner`, `write_audit_log`, `assert_can_write`, `assert_can_manage`, `financial_year_of`

**Other:**
- `GET /storage/v1/bucket` returns `200 []` — no storage buckets.
- `GET /auth/v1/health` returns `200`, GoTrue v2.197.0 — the project is live.
- Postgres version recorded in `supabase/.temp/postgres-version`: `17.11.0.016`.

**Conclusion:** the remote `public` schema is empty. There are no naming conflicts and no pre-existing objects that migration 0001–0004 could collide with.

**Not verified:** remote migration history (blocker B3). The empty-schema evidence above is strong but indirect — it proves no objects exist, not that `supabase_migrations.schema_migrations` is empty.

---

 → `do $`** and **`$;` → `$;`** — invalid single-dollar delimiters that
  broke SQL Editor execution.
- **17 `throws_ok`/`lives_ok` blocks** converted from `$ … # BizPilot — Build Progress

Last updated: Phase 2 (database preparation)

---

## Current status

| Area | Status | Notes |
|---|---|---|
| Database migrations (0001–0004) | Written, reviewed, **not deployed** | Awaiting explicit approval for `db push` |
| pgTAP security suite | Written, **never executed** | Docker daemon unavailable — see blocker B1 |
| Unit test suite (7 files) | Written, **cannot run** | Vitest harness failure — see blocker B2 |
| Application UI | **Not started** | No `App.tsx`, router, pages or auth screens exist |
| Supabase project link | Complete | `gdhaszmgwowfxgxllpva` |

---

## Blockers

### B1 — Docker daemon unavailable (blocks pgTAP execution)

`supabase test db` requires a local Supabase stack, which requires Docker.

- Docker CLI is installed: `Docker version 29.9.2, build a82e528`
- The daemon is **not running**: `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`
- The Windows service `com.docker.service` is present but **Stopped**
- `Start-Service com.docker.service` fails: `Cannot open com.docker.service service on computer '.'` — requires administrator privileges the agent session does not have.
- Launching `C:\Program Files\Docker\Docker\Docker Desktop.exe` was attempted. After 105 seconds the service remained `Stopped` and `docker ps` returned `Error response from daemon: Docker Desktop is unable to start`.

**Consequence:** the pgTAP suite has never been executed. No claim of passing tests is made anywhere in this document.

**Resolution options (require the user):**
1. Start Docker Desktop manually (may require a reboot or WSL2 backend repair), then run `npx supabase start` followed by `npx supabase test db`.
2. Grant the agent an elevated shell.
3. Run the pgTAP suite against a throwaway Supabase branch or a separate disposable project — **never** the main hosted project.

### B3 — No Supabase access token (blocks CLI verification)

`supabase migration list --linked` and `supabase db push --linked --dry-run` both fail with:

```
Access token not provided. Supply an access token by running `supabase login`
or setting the SUPABASE_ACCESS_TOKEN environment variable.
```

No `SUPABASE_ACCESS_TOKEN` is present in the environment. The project link itself is intact (`supabase/.temp/project-ref` = `gdhaszmgwowfxgxllpva`), but every CLI command that talks to the Management API is blocked.

**Consequence:** remote migration history could not be read, and the dry-run could not be re-executed in this session. The earlier dry-run result reported by the user is taken as given but is not independently confirmed here.

**Resolution:** run `npx supabase login` interactively, or export `SUPABASE_ACCESS_TOKEN`.

### B2 — Vitest harness failure (blocks unit test execution)

All seven unit test files fail before any test body runs:

```
TypeError: Cannot read properties of undefined (reading 'config')
```

The error is raised at the first `describe(...)` call in each file.

**Diagnostics performed (bounded, per instruction):**

| Hypothesis | Test | Result |
|---|---|---|
| `@vitejs/plugin-react` transform | `vitest.unit.config.ts` with no React plugin | **Not the cause** — identical failure |
| jsdom environment | `--environment node` | **Not the cause** |
| Setup file (`tests/setup.ts`) | Config with no `setupFiles` | **Not the cause** |
| File parallelism | `--no-file-parallelism`, `--no-isolate` | **Not the cause** |
| Dependency version conflict | `npm ls vitest vite` | **No conflict** — `vitest@4.1.12` + `vite@8.3.5` deduped; Vitest peer range is `^6 \|\| ^7 \|\| ^8` |

**Root cause: not identified.** The failure occurs inside Vitest's own config resolution, before test collection.

**Deliberately not done:** no dependency versions were changed, no test files were modified or deleted. All seven test files are preserved intact.

**Workaround available but not applied:** the seven files are pure logic (no React, no DOM, no Supabase) and could run under `node --test` with a small `expect` shim. Not implemented — awaiting a decision.

---

## Files created in Phase 2

| File | Purpose |
|---|---|
| `supabase/config.toml` | Local Supabase stack configuration (did not previously exist) |
| `supabase/tests/02_view_isolation_test.sql` | pgTAP tests for `invoice_balances` and `customer_receivables` tenant isolation |
| `BUILD_PROGRESS.md` | This file |

## Files modified in Phase 2

| File | Change |
|---|---|
| `supabase/tests/01_security_test.sql` | Plan count updated to match actual assertion count |

No migration file was modified. No application source file was modified.

---

## Verified facts about the remote project

Established by direct REST probing against `https://gdhaszmgwowfxgxllpva.supabase.co` using the publishable key from `.env.local`:

**Tables — all 11 return `404 PGRST205` (absent):**
`businesses`, `profiles`, `business_members`, `customers`, `invoice_sequences`, `invoices`, `invoice_items`, `payments`, `payment_allocations`, `reminder_logs`, `audit_logs`

**Views — all 3 return `404 PGRST205` (absent):**
`invoice_balances`, `payment_balances`, `customer_receivables`

**Functions — all 17 return `404 PGRST202` (absent):**
`create_business_with_owner`, `next_invoice_number`, `create_invoice`, `issue_invoice`, `void_invoice`, `record_payment`, `reverse_payment`, `log_reminder`, `is_business_member`, `has_business_role`, `can_write_financials`, `can_manage_business`, `is_business_owner`, `write_audit_log`, `assert_can_write`, `assert_can_manage`, `financial_year_of`

**Other:**
- `GET /storage/v1/bucket` returns `200 []` — no storage buckets.
- `GET /auth/v1/health` returns `200`, GoTrue v2.197.0 — the project is live.
- Postgres version recorded in `supabase/.temp/postgres-version`: `17.11.0.016`.

**Conclusion:** the remote `public` schema is empty. There are no naming conflicts and no pre-existing objects that migration 0001–0004 could collide with.

**Not verified:** remote migration history (blocker B3). The empty-schema evidence above is strong but indirect — it proves no objects exist, not that `supabase_migrations.schema_migrations` is empty.

---

 to `$ … $`.
- **`set local role authenticated`** restored after `reset role` following the anon
  tests. Without it every later test ran as superuser, bypassing RLS entirely.
- **`open_invoice_count::bigint` vs `2::bigint`** in `02_view_isolation_test.sql` —
  `count()` returns `bigint`, and `is(bigint, integer, unknown)` does not exist.
- **`auth.users` fixture** now filters `is_generated = 'NEVER' AND is_identity = 'NO'
  AND column_default is null`, so the generated `confirmed_at` column is never
  supplied and defaults are applied by the database. A compatibility guard raises a
  clear error if GoTrue adds a required column the fixture does not handle.

### Verification scripts

| Script | Purpose |
|---|---|
| `scripts/verify-pgtap.mjs` | Counts assertions, checks `plan()` match, dollar-quote balance, `begin`/`rollback`, fixture filters |
| `scripts/build-tap-runner.mjs` | Produces a pass/fail summary runnable via `supabase db query` |
| `scripts/build-tap-lines.mjs` | Produces per-assertion failure output |
| `scripts/find-lone-dollars.mjs` | Locates stray single-dollar delimiters |
| `scripts/repair-dollars.mjs` | Promotes lone `# BizPilot — Build Progress

Last updated: Phase 2 (database preparation)

---

## Current status

| Area | Status | Notes |
|---|---|---|
| Database migrations (0001–0004) | Written, reviewed, **not deployed** | Awaiting explicit approval for `db push` |
| pgTAP security suite | Written, **never executed** | Docker daemon unavailable — see blocker B1 |
| Unit test suite (7 files) | Written, **cannot run** | Vitest harness failure — see blocker B2 |
| Application UI | **Not started** | No `App.tsx`, router, pages or auth screens exist |
| Supabase project link | Complete | `gdhaszmgwowfxgxllpva` |

---

## Blockers

### B1 — Docker daemon unavailable (blocks pgTAP execution)

`supabase test db` requires a local Supabase stack, which requires Docker.

- Docker CLI is installed: `Docker version 29.9.2, build a82e528`
- The daemon is **not running**: `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`
- The Windows service `com.docker.service` is present but **Stopped**
- `Start-Service com.docker.service` fails: `Cannot open com.docker.service service on computer '.'` — requires administrator privileges the agent session does not have.
- Launching `C:\Program Files\Docker\Docker\Docker Desktop.exe` was attempted. After 105 seconds the service remained `Stopped` and `docker ps` returned `Error response from daemon: Docker Desktop is unable to start`.

**Consequence:** the pgTAP suite has never been executed. No claim of passing tests is made anywhere in this document.

**Resolution options (require the user):**
1. Start Docker Desktop manually (may require a reboot or WSL2 backend repair), then run `npx supabase start` followed by `npx supabase test db`.
2. Grant the agent an elevated shell.
3. Run the pgTAP suite against a throwaway Supabase branch or a separate disposable project — **never** the main hosted project.

### B3 — No Supabase access token (blocks CLI verification)

`supabase migration list --linked` and `supabase db push --linked --dry-run` both fail with:

```
Access token not provided. Supply an access token by running `supabase login`
or setting the SUPABASE_ACCESS_TOKEN environment variable.
```

No `SUPABASE_ACCESS_TOKEN` is present in the environment. The project link itself is intact (`supabase/.temp/project-ref` = `gdhaszmgwowfxgxllpva`), but every CLI command that talks to the Management API is blocked.

**Consequence:** remote migration history could not be read, and the dry-run could not be re-executed in this session. The earlier dry-run result reported by the user is taken as given but is not independently confirmed here.

**Resolution:** run `npx supabase login` interactively, or export `SUPABASE_ACCESS_TOKEN`.

### B2 — Vitest harness failure (blocks unit test execution)

All seven unit test files fail before any test body runs:

```
TypeError: Cannot read properties of undefined (reading 'config')
```

The error is raised at the first `describe(...)` call in each file.

**Diagnostics performed (bounded, per instruction):**

| Hypothesis | Test | Result |
|---|---|---|
| `@vitejs/plugin-react` transform | `vitest.unit.config.ts` with no React plugin | **Not the cause** — identical failure |
| jsdom environment | `--environment node` | **Not the cause** |
| Setup file (`tests/setup.ts`) | Config with no `setupFiles` | **Not the cause** |
| File parallelism | `--no-file-parallelism`, `--no-isolate` | **Not the cause** |
| Dependency version conflict | `npm ls vitest vite` | **No conflict** — `vitest@4.1.12` + `vite@8.3.5` deduped; Vitest peer range is `^6 \|\| ^7 \|\| ^8` |

**Root cause: not identified.** The failure occurs inside Vitest's own config resolution, before test collection.

**Deliberately not done:** no dependency versions were changed, no test files were modified or deleted. All seven test files are preserved intact.

**Workaround available but not applied:** the seven files are pure logic (no React, no DOM, no Supabase) and could run under `node --test` with a small `expect` shim. Not implemented — awaiting a decision.

---

## Files created in Phase 2

| File | Purpose |
|---|---|
| `supabase/config.toml` | Local Supabase stack configuration (did not previously exist) |
| `supabase/tests/02_view_isolation_test.sql` | pgTAP tests for `invoice_balances` and `customer_receivables` tenant isolation |
| `BUILD_PROGRESS.md` | This file |

## Files modified in Phase 2

| File | Change |
|---|---|
| `supabase/tests/01_security_test.sql` | Plan count updated to match actual assertion count |

No migration file was modified. No application source file was modified.

---

## Verified facts about the remote project

Established by direct REST probing against `https://gdhaszmgwowfxgxllpva.supabase.co` using the publishable key from `.env.local`:

**Tables — all 11 return `404 PGRST205` (absent):**
`businesses`, `profiles`, `business_members`, `customers`, `invoice_sequences`, `invoices`, `invoice_items`, `payments`, `payment_allocations`, `reminder_logs`, `audit_logs`

**Views — all 3 return `404 PGRST205` (absent):**
`invoice_balances`, `payment_balances`, `customer_receivables`

**Functions — all 17 return `404 PGRST202` (absent):**
`create_business_with_owner`, `next_invoice_number`, `create_invoice`, `issue_invoice`, `void_invoice`, `record_payment`, `reverse_payment`, `log_reminder`, `is_business_member`, `has_business_role`, `can_write_financials`, `can_manage_business`, `is_business_owner`, `write_audit_log`, `assert_can_write`, `assert_can_manage`, `financial_year_of`

**Other:**
- `GET /storage/v1/bucket` returns `200 []` — no storage buckets.
- `GET /auth/v1/health` returns `200`, GoTrue v2.197.0 — the project is live.
- Postgres version recorded in `supabase/.temp/postgres-version`: `17.11.0.016`.

**Conclusion:** the remote `public` schema is empty. There are no naming conflicts and no pre-existing objects that migration 0001–0004 could collide with.

**Not verified:** remote migration history (blocker B3). The empty-schema evidence above is strong but indirect — it proves no objects exist, not that `supabase_migrations.schema_migrations` is empty.

---

 to `$` |

### `record_payment` P0002 — root cause and resolution

The `P0002: Customer not found in this business` error was reported earlier. It no
longer occurs; both suites pass. The cause was **not** the customer lookup.

`record_payment` raises `P0002` at this line (migration 0003, line 566):

```sql
if not exists (
  select 1 from public.customers where id = p_customer_id and business_id = p_business_id
) then
  raise exception 'Customer not found in this business' using errcode = 'P0002';
end if;
```

The lookup itself is correct. The failure came from the **test harness**: after the
anon-role block, `reset role` returned the session to the superuser and the role was
never restored. Every subsequent test therefore ran as superuser rather than as
`authenticated`, so the SECURITY DEFINER function executed in a different effective
context than the test assumed.

**Fix:** `set local role authenticated;` restored immediately after `reset role`.

**Diagnostics run inside the transaction** (immediately before the first
`record_payment` call, after fixtures, with the Alpha owner active) confirmed the
state is correct:

| Check | Value |
|---|---|
| `current_user` | `authenticated` |
| `auth.uid()` | `11111111-1111-1111-1111-111111111111` |
| `request.jwt.claims` | `{"sub":"11111111-…","role":"authenticated"}` |
| Customer by ID | 1 |
| Customer by ID **and** business | 1 |
| Customer's `business_id` | `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` |
| Membership rows (accepted) | 1 |
| `can_write_financials()` | `true` |

The diagnostics were plain `SELECT`s outside pgTAP assertions, so `plan()` was
unaffected, and they were removed after the cause was confirmed.

**Note on `request.jwt.claim.sub`:** this setting is `NULL` in the diagnostics. That
is expected and harmless — `auth.uid()` reads `request.jwt.claims` (the JSON blob),
not the individual `request.jwt.claim.sub` key. Setting both is not required for
`auth.uid()` to resolve, and adding it would not change behaviour.

No RLS policy, customer validation, or migration was modified.

---

## Phase 3 — application UI

**Status: built, typechecks, production build succeeds, verified end-to-end against `bizpilot-test`.**

### Verification performed (not claimed — executed)

| Step | Method | Result |
|---|---|---|
| TypeScript | `npx tsc -b` | **0 errors** |
| Production build | `npx vite build` | **succeeds**, 2550 modules, code-split per route |
| Signup | `POST /auth/v1/signup` | `200`, user created |
| Login | `POST /auth/v1/token?grant_type=password` | `200`, access token issued |
| Onboarding | `POST /rpc/create_business_with_owner` | `200`, business id returned |
| RLS-scoped reads | `GET /business_members`, `/businesses` | `200`, owner membership visible |
| Customer create | `POST /customers` | `201` |
| Invoice create | `POST /rpc/create_invoice` | `200` |
| Invoice issue | `POST /rpc/issue_invoice` | `204` |
| Dashboard views | `GET /invoice_balances`, `/customer_receivables` | `200`, real figures |
| Payment + allocation | `POST /rpc/record_payment` | `200` |

**Arithmetic verified against the live database:**

- Invoice: 10 × ₹500 = ₹5,000 taxable, +18% GST → **₹5,900** (`590000` paise) ✅
- After ₹2,000 payment allocated: `allocated_paise = 200000`, `outstanding_paise = 390000` ✅
- `payment_balances`: `amount 200000`, `allocated 200000`, `unallocated 0` ✅

All smoke-test data was removed afterwards; the test project is back to 0 businesses,
0 customers, 0 invoices, 0 users.

### Modules built

| Module | Files |
|---|---|
| Authentication | `pages/auth/{Login,SignUp,ForgotPassword,ResetPassword,AuthCallback}Page.tsx`, `AuthLayout.tsx`, `context/AuthContext.tsx` |
| Onboarding | `pages/onboarding/OnboardingPage.tsx`, `context/BusinessContext.tsx` |
| App shell | `components/layout/{AppLayout,Sidebar,Topbar,PageHeader,FullPageLoader}.tsx` |
| Dashboard | `pages/dashboard/DashboardPage.tsx`, `components/dashboard/{FinancialStatCard,AgingChart}.tsx` |
| Customers | `pages/customers/{CustomersPage,CustomerDetailPage}.tsx` |
| Invoices | `pages/invoices/{InvoicesPage,CreateInvoicePage,InvoiceDetailPage}.tsx` |
| Payments | `pages/payments/PaymentsPage.tsx` |
| Reports | `pages/reports/ReportsPage.tsx` |
| Settings | `pages/settings/SettingsPage.tsx` |
| Shared UI | `CurrencyDisplay`, `StatusBadge`, `SearchInput`, `ConfigErrorScreen`, `NotFoundPage` |
| Entry | `index.html`, `src/main.tsx`, `src/App.tsx` |

### Design decisions

- **No mock data anywhere.** Every figure comes from a Supabase query. Empty states
  render when there is no data.
- **Money never touches a float.** All amounts are `bigint` paise; `CurrencyDisplay`
  is the only component that formats money.
- **Status is always derived**, never read from a stored column — `deriveInvoiceStatus`
  combines `document_state`, allocations and the due date.
- **Route guards are UX only.** `RequireAuth` and `RequireBusiness` redirect; the real
  boundary is RLS.
- **Code splitting** per route keeps the initial bundle small.

### Known limitations

1. **Email confirmation is enabled on `bizpilot-test`** (`mailer_autoconfirm: false`).
   Signup returns no session until the address is confirmed. For local development,
   either confirm users manually or disable confirmation in the dashboard under
   Authentication → Providers → Email.
2. **`supabase/config.toml` sets `enable_confirmations = false`** for the local stack
   only; it does not affect the hosted test project.
3. **Deleting a business is blocked by design.** `guard_last_owner` and
   `guard_audit_log_immutable` prevent cascade deletes. Cleanup requires temporarily
   disabling those triggers — this is correct behaviour, not a bug, but it means
   there is no self-service "delete business" feature.
4. **Vitest harness still broken** (blocker B2). The UI has no component tests yet.

---

## Phase 4 — pilot readiness

**Status: complete.** Full report in `PILOT_READINESS.md`; decisions in
`TECHNICAL_DECISIONS.md`.

### Test results (executed)

| Suite | Result |
|---|---|
| Playwright — desktop | **15/15 passing** |
| Playwright — mobile | **15/15 passing** |
| Unit tests (Node runner) | **115/115 passing** |
| pgTAP `01_security_test.sql` | **66/66 passing** |
| pgTAP `02_view_isolation_test.sql` | **16/16 passing** |
| Financial lifecycle (`scripts/verify-financial.sql`) | **7/7 scenarios correct** |

### Bugs found and fixed

1. **Invoice search was completely broken** (High). `or()` with a dotted
   embedded path returns `PGRST100`; the UI showed "Could not load invoices" for
   any search term. Fixed by resolving customer ids first (TD-0011).
2. **Wrong business selected after onboarding** (Medium). Fell back to the
   oldest business instead of the newest (TD-0010).
3. **Generic error masked real auth failures** (Medium). Rate limits, duplicate
   accounts and weak passwords all showed "Something went wrong".
4. **e2e suite was non-repeatable** (test infra). Signup rate limit exhausted
   after ~2 accounts; accounts are now seeded via SQL (TD-0009).

### Vitest blocker — workaround delivered

`npm run test:unit` runs the seven existing test files **unchanged** under Node's
built-in test runner via `scripts/unit-test-loader.mjs` and
`scripts/vitest-shim.mjs`. **115/115 passing.** No test file was modified and no
dependency version was changed. `npm test` (Vitest) still fails; both scripts are
kept so the Vitest path can be revisited.

### New files

| File | Purpose |
|---|---|
| `tests/e2e/fixtures.ts` | Synthetic accounts and data helpers |
| `tests/e2e/global-setup.ts` | Creates shared accounts once per run |
| `tests/e2e/auth.spec.ts` | 8 authentication tests |
| `tests/e2e/receivables.spec.ts` | 7 receivables workflow tests |
| `scripts/run-unit-tests.mjs` | Node test-runner entry point |
| `scripts/unit-test-loader.mjs` | Resolves `vitest` and `@/` for Node |
| `scripts/vitest-shim.mjs` | Minimal `expect` implementation |
| `scripts/verify-financial.sql` | Financial lifecycle verification |
| `PILOT_READINESS.md` | Pilot report |
| `TECHNICAL_DECISIONS.md` | Architecture decision log |

### Pilot blockers (operational, not code)

- **B1** Custom SMTP required — built-in SMTP is rate-limited and not for production.
- **B3** **Not a git repository** — no version control, no rollback path.
- **B4** Password reset and auth callback implemented but not e2e-tested.
- **B5** No error monitoring.
- **Backups** not configured; restore never rehearsed.

The application is functionally sound. The infrastructure around it is not yet
pilot-grade.

---

## Phase 5 — infrastructure and reliability

### Test results (executed)

| Suite | Result |
|---|---|
| Playwright (desktop + mobile) | **42/42 passing**, 2 skipped |
| Unit tests (Node runner) | **126/126 passing** |
| pgTAP `01_security_test.sql` | **66/66 passing** |
| pgTAP `02_view_isolation_test.sql` | **16/16 passing** |
| TypeScript | **0 errors** |
| Vite production build | **succeeds** |

### Milestone 1 — Git ✅

- Repository initialised on `main`, baseline commit `ad00f53`.
- `.gitignore` hardened: env files, backups, test output, Supabase temp.
- `.gitattributes` added for LF normalisation.
- `scripts/secret-scan.mjs` — 118 files scanned, **0 findings**. Verified by
  planting a fake `sb_secret_` key and confirming it was caught.
- 106 files committed; `.env.local` and `tests/e2e/.accounts.json` excluded.

**Not done:** no GitHub remote (needs the user's account). Instructions in
`DEPLOYMENT.md` §1.

### Milestone 2 — Email ⚠️ documented, not configured

`DEPLOYMENT.md` covers SMTP, SPF, DKIM, DMARC and redirect allowlisting.

**Finding:** `supabase config diff` shows the remote project has
`additional_redirect_urls: []` — **empty**. Confirmation and reset links will
fail until this is set.

**Blocked:** SMTP requires a provider account and DNS access. No credentials
were invented.

### Milestone 3 — Backup and recovery ⚠️ manual works, automation does not

**Verified findings:**

| Check | Result |
|---|---|
| Supabase managed backups | ❌ `"backups": null` |
| PITR | ❌ `"pitr_enabled": false` |
| `supabase db dump` | ❌ requires Docker (unavailable) |

**Built and actually run:**

- `scripts/backup.mjs` — **360 rows across 11 tables**, SHA-256 checksums
- `scripts/verify-backup.mjs` — **11/11 tables verified**
- `scripts/restore-rehearsal.mjs` — **360/360 rows restored and verified**,
  scratch schema dropped, source data confirmed intact

**Not done:** no scheduling, no off-site storage, no failure alerts.

### Milestone 4 — Error monitoring ✅

- `src/lib/monitoring.ts` — sanitises JWTs, secret keys, emails, card numbers,
  connection strings
- `ErrorBoundary` — catches render errors, offers recovery
- Global handlers for `error` and `unhandledrejection`
- Wired into `main.tsx`, including mutation errors
- **11 unit tests** prove no sensitive data leaks

**Not done:** no remote endpoint (`VITE_ERROR_ENDPOINT` unset).

### Milestone 5 — Remaining e2e tests ✅

`tests/e2e/resilience.spec.ts` — **6/6 passing**: tablet layout, slow network,
offline network, invalid session, unknown route, payment form.

### Bugs found and fixed in Phase 5

1. **`BusinessContext` clobbered the user's selection** (High). After onboarding
   the effect ran against a stale list and overwrote the new business id,
   bouncing the user back to onboarding. Fixed by skipping the effect while
   `isFetching` and refetching before selecting.
2. **`<nav>` had no accessible name** (Medium). The label was on the wrapping
   `<aside>`, so the navigation landmark was unidentifiable. Fixed.
3. **e2e tests shared business state** (test infra). Each test created a
   business on the same account, making results order-dependent and flaky.
   Fixed with a dedicated `resilience` account.

### Milestones 6–7 — not started

Application stability review and pilot documentation remain.

---

## Next milestone

Phase 3 — deployment checkpoint. Requires explicit user approval before
`supabase db push` against the original project.
