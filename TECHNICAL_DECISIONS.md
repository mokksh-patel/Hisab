# BizPilot — Technical Decisions

Architecture decisions with their rationale. Newest first.

---

## TD-0012 — Node test runner shim for the unit suite

**Date:** Phase 4
**Status:** Adopted

**Context.** The Vitest harness fails before any test body runs with
`TypeError: Cannot read properties of undefined (reading 'config')`. Five
hypotheses were tested and eliminated (React plugin, jsdom, setup file,
parallelism, dependency conflict). The root cause was never identified.

**Decision.** Run the existing test files unchanged under Node's built-in test
runner via a module loader (`scripts/unit-test-loader.mjs`) and a minimal
`expect` shim (`scripts/vitest-shim.mjs`).

**Rationale.** The seven unit files are pure logic — no React, DOM or Supabase.
The tests are valuable; the runner is not. A shim unblocks verification without
touching a single test file or dependency version.

**Consequences.**
- `npm run test:unit` → **115/115 passing**.
- `npm test` (Vitest) still fails. Both scripts are kept so the Vitest path can
  be revisited without losing the working one.
- The shim implements only the matchers the suite uses. A new matcher may need
  adding to `scripts/vitest-shim.mjs`.

---

## TD-0011 — Invoice search resolves customers in two steps

**Date:** Phase 4
**Status:** Adopted

**Context.** `listInvoices` filtered with
`or(invoice_number.ilike.%,customers.customer_name.ilike.%)`. PostgREST rejects
this with `PGRST100` because it cannot parse a dotted embedded path inside
`or()` on a view. Invoice search was completely broken — the UI showed
"Could not load invoices" for any search term.

**Decision.** Resolve matching customer ids first, then filter invoices by
`invoice_number` OR `customer_id.in.(...)`.

**Rationale.** Two round trips is a small cost for a working feature. The
alternative — a database function — would need a new migration, and migrations
are frozen for this phase.

**Consequences.** Search is correct. If invoice volume grows, replace with a
`search_invoices()` SQL function.

---

## TD-0010 — Business selection prefers the newest business

**Date:** Phase 4
**Status:** Adopted

**Context.** `BusinessContext` fell back to `businesses[0]` when no selection was
stored. `listMyBusinesses` orders by `created_at` ascending, so this picked the
*oldest* business. A user who just completed onboarding landed on a different
business than the one they created.

**Decision.** Fall back to the last element (newest).

**Rationale.** Matches user expectation immediately after onboarding, and is
deterministic.

**Consequences.** Users with several businesses still switch explicitly via the
topbar selector. The choice persists in `localStorage`.

---

## TD-0009 — e2e accounts are seeded via SQL, not the signup API

**Date:** Phase 4
**Status:** Adopted

**Context.** Supabase's built-in SMTP enforces a low signup rate limit. Creating
an account per test exhausted it within one run (`429 email rate limit
exceeded`), making the suite non-repeatable.

**Decision.** `global-setup.ts` inserts two accounts directly into `auth.users`
with `crypt(password, gen_salt('bf'))`, then the tests sign in through the real
auth API.

**Rationale.** Sign-in — the path that matters for session handling — is still
genuinely exercised. Only account *creation* is bypassed. The signup form is
still tested for validation and rejection messages.

**Consequences.**
- GoTrue requires the token columns (`confirmation_token`, `recovery_token`,
  `email_change`, …) to be **empty strings, not NULL**. A NULL there makes the
  auth server return `500 Database error querying schema`.
- Accounts are created once per run and reused; each test still gets its own
  business, customer and invoice.

---

## TD-0008 — RLS filters rows; it does not raise errors

**Date:** Phase 4
**Status:** Adopted

**Context.** Six pgTAP assertions expected `throws_ok('42501')` on unauthorised
UPDATE/DELETE. Four failed with "no exception".

**Decision.** Assert `lives_ok` (statement completes) plus a data check proving
nothing changed.

**Rationale.** RLS `USING` clauses are a row filter. An UPDATE that matches zero
rows succeeds silently. Asserting an exception is testing something PostgreSQL
does not do. The corrected form is a *stronger* test: it proves both that no
error leaks and that no data was modified.

**Consequences.** Assertion count rose 60 → 66 because each corrected assertion
needs two statements. No policy was weakened.

---

## TD-0007 — Money is `bigint` paise end to end

**Date:** Phase 3
**Status:** Adopted

**Context.** JavaScript numbers lose precision above 2^53; floating point cannot
represent 0.1 exactly.

**Decision.** All money is whole paise as `bigint` in TypeScript and
`NUMERIC(20,0)` in Postgres. Values cross the network as strings. `CurrencyDisplay`
is the only component that formats money.

**Rationale.** Financial figures must be exact and reproducible. A single
rounding difference between screens destroys trust.

**Consequences.** Never use `Number()` on a money value. Use `parsePaise()`.
Arithmetic goes through `lib/money.ts`.

---

## TD-0006 — Invoice status is derived, never stored

**Date:** Phase 3
**Status:** Adopted

**Context.** A stored `status` column can contradict the underlying allocations
and due date.

**Decision.** Only the document lifecycle (`draft`/`issued`/`void`) is stored.
Payment and overdue status are computed by `deriveInvoiceStatus()` from
allocations and the due date.

**Rationale.** One source of truth. A stored status would need to be updated by
every payment, reversal and date change — and would eventually drift.

**Consequences.** Status filtering happens after derivation, so it applies to the
current page of results rather than the whole dataset. Acceptable at pilot
volume; revisit with a SQL function if needed.

---

## TD-0005 — Views use `security_invoker = true`

**Date:** Phase 2
**Status:** Adopted

**Context.** A Postgres view runs as its owner by default, which would bypass RLS
and expose every tenant's receivables.

**Decision.** All three reporting views set `security_invoker = true`.

**Rationale.** The view then runs with the caller's permissions, so the
underlying RLS policies still apply.

**Consequences.** Covered by `02_view_isolation_test.sql` (16 assertions).

---

## TD-0004 — SECURITY DEFINER functions with a fixed `search_path`

**Date:** Phase 2
**Status:** Adopted

**Context.** Multi-row financial operations must be atomic, and membership checks
inside RLS policies would recurse.

**Decision.** Every financial operation is a `SECURITY DEFINER` function with
`set search_path = public, pg_temp`, revoked from `public` and granted only to
`authenticated`.

**Rationale.** Atomicity plus a fixed `search_path` prevents both partial writes
and search-path hijacking.

**Consequences.** Internal helpers (`write_audit_log`, `assert_can_write`) are
revoked and never granted.

---

## TD-0003 — Payment allocation is a separate table

**Date:** Phase 2
**Status:** Adopted

**Context.** A `payment.invoice_id` column would force one payment to one invoice.

**Decision.** `payment_allocations` links payments to invoices many-to-many.

**Rationale.** Supports partial payments, one payment across several invoices,
and unallocated advances without distorting invoice balances.

**Consequences.** Outstanding is always `total − sum(live allocations)`, floored
at zero.

---

## TD-0002 — Reversal, not deletion

**Date:** Phase 2
**Status:** Adopted

**Context.** Financial corrections must be traceable.

**Decision.** Payments are reversed (`reversed_at`, `reversal_reason`), never
deleted. Issued invoices are voided, never deleted. `audit_logs` is append-only
enforced by trigger.

**Rationale.** A deleted payment destroys the audit trail.

**Consequences.** Balance views ignore reversed payments. Deleting a business is
blocked by `guard_last_owner` and `guard_audit_log_immutable` — cleanup requires
temporarily disabling triggers, which is deliberate friction.

---

## TD-0001 — Email confirmation stays enabled

**Date:** Phase 2
**Status:** Adopted

**Context.** Disabling confirmation would simplify testing.

**Decision.** Keep it enabled for real users. `supabase/config.toml` disables it
for the **local** stack only.

**Rationale.** An unverified email address is an account-recovery liability.

**Consequences.** Automated signup is rate-limited by the built-in SMTP. A custom
SMTP provider is required before pilot (see `PILOT_READINESS.md`).
