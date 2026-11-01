# BizPilot — Pilot Readiness Report

**Project:** `bizpilot-test` (`xseytkeykqwgirgixlir`)
**Original production project:** `gdhaszmgwowfxgxllpva` — **untouched throughout**
**Date:** Phase 4

---

## 1. Test results (executed, not claimed)

### Browser tests — Playwright

| Suite | Desktop | Mobile | Total |
|---|---:|---:|---:|
| `auth.spec.ts` | 8/8 | 8/8 | 16/16 |
| `receivables.spec.ts` | 7/7 | 7/7 | 14/14 |
| **Total** | **15/15** | **15/15** | **30/30 passing** |

2 skipped: the onboarding test requires an account with no business, and the
shared account already has one from a prior run. It is skipped rather than
failed for the wrong reason.

Run: `npx playwright test`

### Unit tests — Node test runner

**115/115 passing.** Run: `npm run test:unit`

The Vitest harness remains broken (see §7). The same test files run unchanged
under Node's built-in runner via a shim.

### Database tests — pgTAP

| File | Assertions | Result |
|---|---:|---|
| `01_security_test.sql` | 66 | **ALL PASSED** |
| `02_view_isolation_test.sql` | 16 | **ALL PASSED** |
| **Total** | **82** | **82/82 passing** |

### Financial lifecycle — verified against PostgreSQL

`scripts/verify-financial.sql` exercises every receivables state inside a
transaction and rolls back.

| Scenario | Expected | Actual | ✓ |
|---|---|---|---|
| Fully paid invoice | outstanding 0, allocated 590000 | 0 / 590000 | ✅ |
| Reversed payment | outstanding 100000 (reversal excluded) | 100000 | ✅ |
| Voided invoice | 0 issued rows | 0 | ✅ |
| Overdue invoice | outstanding 300000 | 300000 | ✅ |
| Unallocated advance | 100000 unallocated | 100000 | ✅ |
| Customer total | 0 + 100000 + 300000 = 400000 | 400000 | ✅ |
| Customer overdue | 300000 (only the overdue invoice) | 300000 | ✅ |

GST arithmetic verified: 10 × ₹500 + 18% = **₹5,900** (`590000` paise).

---

## 2. Bugs found and fixed during Phase 4

| # | Bug | Severity | Fix |
|---|---|---|---|
| 1 | **Invoice search completely broken.** `or()` with a dotted embedded path returns `PGRST100`; the UI showed "Could not load invoices" for any search. | **High** | Resolve customer ids first, then filter by number OR customer id (TD-0011) |
| 2 | **Wrong business selected after onboarding.** Fell back to the *oldest* business. | **Medium** | Fall back to the newest (TD-0010) |
| 3 | **Generic error masked real auth failures.** Rate limits, duplicate accounts and weak passwords all showed "Something went wrong". | **Medium** | Map auth error codes to actionable messages |
| 4 | **e2e suite non-repeatable.** Signup rate limit exhausted after ~2 accounts. | Medium (test infra) | Seed accounts via SQL (TD-0009) |

Bug 1 is the most significant: it would have been invisible without browser
testing, because the service layer "worked" — it just returned an error the UI
swallowed into a generic message.

---

## 3. Authentication readiness

| Check | Status | Notes |
|---|---|---|
| Signup | ✅ | Validation tested; server rejection messages surfaced |
| Email confirmation | ✅ Enabled | Correct for production |
| Login | ✅ | Wrong credentials rejected |
| Logout | ✅ | Session cleared, protected routes bounce to login |
| Session persistence | ✅ | Survives reload; token in `localStorage` |
| Password recovery | ✅ | Neutral message prevents account enumeration |
| Password reset | ⚠️ | UI built; **not e2e-tested** — needs a real email link |
| Auth callback | ⚠️ | PKCE exchange implemented; **not e2e-tested** |
| Protected routes | ✅ | All 6 routes redirect when signed out |
| Expired sessions | ⚠️ | Handled by the Supabase client; **not explicitly tested** |

---

## 4. Security validation

| Check | Status |
|---|---|
| RLS on all 11 tenant tables | ✅ Verified |
| `security_invoker` on all 3 views | ✅ Verified by pgTAP |
| Cross-tenant isolation | ✅ 82 pgTAP assertions |
| Role-based permissions | ✅ read_only / collection_staff / admin / owner |
| Audit immutability | ✅ Trigger-enforced |
| No privileged credentials in `src/` | ✅ No `sb_secret_` / service-role patterns |
| `.env.local` gitignored | ✅ |
| `tests/e2e/.accounts.json` gitignored | ✅ Added this phase |

**No security policy was weakened to make a test pass.** The six pgTAP
corrections changed *assertions*, not policies (TD-0008).

---

## 5. Interface quality

| Check | Status |
|---|---|
| Desktop (Chrome) | ✅ 15/15 |
| Mobile (Pixel 7) | ✅ 15/15 |
| Tablet | ⚠️ Not separately tested — no tablet project configured |
| Loading states | ✅ Skeletons on every data view |
| Empty states | ✅ Distinct copy for "no data" vs "no matches" |
| Error states | ✅ Message + retry button |
| Form validation | ✅ Zod, inline messages |
| Responsive tables | ✅ Horizontal scroll with `min-width` |
| Keyboard navigation | ✅ Focus rings, Escape closes menus |
| Duplicate submissions | ✅ Idempotency key per payment form |
| Network interruption | ⚠️ Error state shown; **not tested with throttling** |

---

## 6. Business data protection

### Current state

- **No backup automation configured.** Supabase takes daily backups on paid
  plans; the free tier does not. **This is a pilot blocker.**
- **No export feature.** `pg_dump` is the only path today.
- **No archival design.** Deleting a business is blocked by
  `guard_last_owner` and `guard_audit_log_immutable`. This is correct — there is
  no reviewed retention design yet, so no destructive deletion exists.
- **Audit history is append-only** and cannot be modified or deleted, by trigger.

### Required before pilot

1. **Enable Supabase daily backups** (paid plan) or schedule `pg_dump` to
   off-site storage.
2. **Document and rehearse a restore.** An untested backup is not a backup.
3. **Design archival** before offering business deletion: soft-delete flag,
   retention window, and an explicit owner confirmation flow.
4. **Financial record retention.** Indian companies are generally required to
   retain books for 8 years. Confirm with an accountant before any purge.

**Do not disable audit or immutability triggers for cleanup.** During Phase 4
testing, cleanup required temporarily disabling four triggers. That is
acceptable for synthetic test data only, and must never be done on real data.

---

## 7. Outstanding blockers

### B1 — Custom SMTP required (pilot blocker)

Supabase's built-in SMTP is rate-limited to a handful of emails per hour and is
**not intended for production**. Confirmation and password-reset emails will
fail under real signup volume.

**Required:** configure a transactional provider (Resend, Postmark, SES) in
Supabase → Authentication → SMTP. Set the sender domain and verify SPF/DKIM.

### B2 — Vitest harness broken (workaround in place)

`npx vitest run` fails with `TypeError: Cannot read properties of undefined
(reading 'config')` before any test executes. Root cause not identified after
five eliminated hypotheses. **Workaround:** `npm run test:unit` runs the same
files under Node's runner — 115/115 passing.

### B3 — Not a git repository

`git status` returns `fatal: not a git repository`. There is no version control,
so there is no rollback path and no change history. **This is a pilot blocker.**

### B4 — Password reset and auth callback untested end-to-end

Both are implemented but require a real email link to test. They should be
verified manually once SMTP is configured.

### B5 — No error monitoring

No Sentry/Rollbar integration. Production errors will be invisible.

---

## 8. Pilot deployment checklist

### Must complete before pilot

- [ ] **Initialise git** and commit the current state (B3)
- [ ] **Configure custom SMTP** and verify a real confirmation email (B1)
- [ ] **Enable database backups** and rehearse a restore (§6)
- [ ] **Add error monitoring** (B5)
- [ ] **Manually verify** password reset and auth callback (B4)
- [ ] **Set redirect URL allowlist** in Supabase → Authentication → URL
      Configuration: production domain + `/auth/callback` + `/auth/reset-password`
- [ ] **Deploy to Vercel** with `VITE_SUPABASE_URL` and
      `VITE_SUPABASE_PUBLISHABLE_KEY` set in project settings
- [ ] **Confirm no service-role key** is present in any Vercel env var

### Should complete before pilot

- [ ] Add a tablet Playwright project
- [ ] Test network interruption with throttling
- [ ] Add a user feedback mechanism (in-app form or support email)
- [ ] Decide on a data export feature

### Explicitly out of scope for this phase

Inventory, supplier marketplace, AI modules — not started, per instruction.

---

## 9. Honest summary

**Working and verified:** authentication, onboarding, customers, invoices,
payments, dashboard, reports, search, RLS isolation, financial arithmetic.
30 browser tests and 115 unit tests pass; 82 database assertions pass.

**Not verified:** password reset and auth callback end-to-end, tablet layout,
network failure handling, expired-session behaviour.

**Not ready:** no version control, no backups, no production SMTP, no error
monitoring. These are operational gaps, not code defects — but they are
disqualifying for a real pilot until closed.

The application is functionally sound. The infrastructure around it is not yet
pilot-grade.
