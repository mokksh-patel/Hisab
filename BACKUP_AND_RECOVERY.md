# BizPilot — Backup and Recovery

**Status: manual backups work and a restore has been rehearsed. Automated
scheduled backups are NOT operational.**

---

## 1. Current state (verified, not assumed)

| Item | Status | Evidence |
|---|---|---|
| Supabase managed backups | ❌ **None** | `supabase backups list` → `"backups": null` |
| Point-in-time recovery (PITR) | ❌ **Disabled** | `"pitr_enabled": false` |
| WAL archiving | ✅ Enabled | `"walg_enabled": true` (but no restore points) |
| Manual logical backup | ✅ **Works** | `scripts/backup.mjs` — 360 rows, 11 tables |
| Backup integrity check | ✅ **Works** | `scripts/verify-backup.mjs` — 11/11 OK |
| Restore rehearsal | ✅ **Succeeded** | 360/360 rows restored and verified |
| Scheduled automation | ❌ **Not configured** | No cron, no CI job |

**The free tier does not include managed backups.** Until either a paid plan is
enabled or a scheduled job is running, a lost database is unrecoverable.

---

## 2. Taking a backup

### Option A — logical JSON export (works without Docker)

```bash
node scripts/backup.mjs
```

Produces `backups/<timestamp>/` containing one JSON file per table plus a
`manifest.json` with row counts and SHA-256 checksums.

**Covers:** all 11 application tables.
**Does not cover:** Storage files (none in use), database roles, RLS policies,
extensions, or `auth.users` passwords in usable form (bcrypt hashes only).

### Option B — full SQL dump (requires Docker)

```bash
npx supabase db dump --linked -f backups/schema.sql
npx supabase db dump --linked --data-only -f backups/data.sql
```

This is the complete backup: schema, policies, functions, triggers and data.
**It requires a running Docker daemon**, which was unavailable in this
environment. Run it on a machine with Docker before going live.

### Option C — managed backups (recommended for production)

Upgrade the Supabase project to a paid plan and enable **Daily backups** in
Project Settings → Database → Backups. PITR is available on higher tiers.

This is the only option that protects against operator error without manual
intervention.

---

## 3. Verifying a backup

```bash
node scripts/verify-backup.mjs backups/<timestamp>
```

Recomputes every file's SHA-256 and compares it with the manifest. A backup that
fails this check must not be relied on.

**This proves the files are intact. It does not prove they can be restored** —
that requires §4.

---

## 4. Restore rehearsal (executed successfully)

```bash
node scripts/restore-rehearsal.mjs backups/<timestamp>
```

**What it does:**

1. Refuses to run if the linked project is the production project.
2. Creates a throwaway schema `restore_rehearsal`.
3. Recreates each table as `(doc jsonb)` — the rehearsal proves the *data*
   round-trips; the DDL lives in migrations.
4. Loads every exported row in batches of 20.
5. Compares restored row counts against the manifest.
6. Spot-checks a financial aggregate (sum of invoice totals).
7. Drops the schema.

**Result of the rehearsal run on 2026-11-01:**

```
businesses             OK   30/30
profiles               OK    6/6
business_members       OK   30/30
customers              OK   30/30
invoice_sequences      OK   30/30
invoices               OK   30/30
invoice_items          OK   30/30
payments               OK    8/8
payment_allocations    OK    8/8
reminder_logs          OK    0/0
audit_logs             OK  158/158

Sum of invoice totals (restored): 17700000
Restored 360 rows. 0 failure(s).
```

Source data was verified intact afterwards (30 businesses, 30 invoices,
158 audit rows) and the rehearsal schema was confirmed dropped.

---

## 5. Full disaster recovery procedure

Use this when the database is lost or corrupted.

### Step 1 — Stop writes

Put the application into maintenance mode or take it offline. Continuing to
write makes recovery harder.

### Step 2 — Provision a clean database

Create a new Supabase project, or reset the existing one **only if you are
certain it is unrecoverable**.

### Step 3 — Restore the schema

```bash
npx supabase link --project-ref <new-ref>
npx supabase db push --linked
```

This applies migrations 0001–0004, recreating tables, RLS policies, functions
and triggers.

### Step 4 — Restore the data

With a full SQL dump:

```bash
psql "<connection-string>" -f backups/data.sql
```

With a JSON export, load each table in dependency order:

```
businesses → profiles → business_members → customers → invoice_sequences
→ invoices → invoice_items → payments → payment_allocations
→ reminder_logs → audit_logs
```

**Order matters.** Foreign keys will reject out-of-order inserts.

### Step 5 — Restore auth users

`auth.users` is not covered by the JSON export. Users must re-register, or you
restore them from a full SQL dump. Passwords are bcrypt hashes and cannot be
recovered in plaintext — users will need to reset.

### Step 6 — Verify

```bash
node scripts/verify-backup.mjs backups/<timestamp>
```

Then check in the app: dashboard totals, invoice counts, and that a known
customer's balance matches expectations.

### Step 7 — Re-enable writes

Only after verification passes.

---

## 6. Retention policy (recommended)

| Age | Keep | Location |
|---|---|---|
| Last 7 days | Daily | Off-site (S3/R2/B2) |
| Last 4 weeks | Weekly | Off-site |
| Last 12 months | Monthly | Off-site, cold storage |
| Financial records | 8 years | Per Indian statutory requirement — confirm with an accountant |

**Backups must never be stored in the Git repository.** `backups/` is gitignored.

---

## 7. What is still missing

1. **No scheduled backups.** Nothing runs automatically. A cron job or GitHub
   Action calling `scripts/backup.mjs` and uploading to object storage is
   required.
2. **No off-site storage.** Backups currently sit on the same machine as the
   code.
3. **No failure notification.** A failed backup is silent.
4. **No full SQL dump tested.** Option B was never executed because Docker is
   unavailable here.

Until items 1–3 are done, **do not run a pilot with real customer data.**
