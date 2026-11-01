# BizPilot — Deployment Guide

Everything required to deploy BizPilot to production, in order.

**Current state:** the application runs against the test project
`xseytkeykqwgirgixlir`. The original project `gdhaszmgwowfxgxllpva` has never
been modified and must not be until this checklist is complete.

---

## 0. Prerequisites

| Item | Status |
|---|---|
| Git repository initialised | ✅ Done (Phase 5) |
| Private GitHub repository | ⬜ **Not created** — see §1 |
| Custom SMTP provider account | ⬜ **Not configured** — see §2 |
| Domain name | ⬜ Required for SMTP sender and redirect URLs |
| Vercel account | ⬜ Not connected |

---

## 1. GitHub repository

The local repository exists with a baseline commit on `main`. It has **no
remote** yet.

### Create the private repository

1. Go to <https://github.com/new>.
2. Name: `bizpilot`.
3. Visibility: **Private**. Do not create a public repository — the code
   contains business logic and schema details.
4. Do **not** initialise with a README, `.gitignore` or licence. The local
   repository already has all three.

### Connect and push

```bash
git remote add origin git@github.com:<your-account>/bizpilot.git
git push -u origin main
```

Using SSH avoids storing a personal access token on disk. If you must use HTTPS,
use a **fine-grained token scoped to this single repository** with `contents:
write` only, and let Git Credential Manager store it — never paste a token into
a file.

### Verify before pushing

```bash
node scripts/secret-scan.mjs     # must report "No credential patterns found"
git ls-files | grep -i "env.local"   # must return nothing
```

---

## 2. Email infrastructure (SMTP)

### Why this is mandatory

Supabase's built-in SMTP is **rate-limited to a handful of emails per hour** and
is explicitly not intended for production. During Phase 4 testing it exhausted
after roughly two signups, returning `429 email rate_limit exceeded`. Real users
would be unable to confirm their address or reset a password.

### Provider options

| Provider | Free tier | Notes |
|---|---|---|
| Resend | 3,000/month | Simplest setup, good Supabase docs |
| Postmark | 100/month | Best deliverability, paid beyond trial |
| Amazon SES | 62,000/month from EC2 | Cheapest at scale, most setup work |

### Configuration steps

1. **Create the provider account** and add your sending domain.
2. **Verify the domain** by adding the DNS records the provider gives you.
3. **Obtain SMTP credentials** — host, port, username, password.
4. In Supabase: **Authentication → Emails → SMTP Settings**, enable custom SMTP
   and enter the credentials.
5. Set **Sender email** to an address on your verified domain
   (e.g. `no-reply@yourdomain.com`).
6. Set **Sender name** to `BizPilot`.
7. Click **Send test email** and confirm it arrives.

**Never put SMTP credentials in `.env.local`, `config.toml`, or any file in this
repository.** They live only in the Supabase dashboard.

### DNS records

Add these at your DNS provider. Exact values come from your SMTP provider.

#### SPF — authorises your sending server

```
TXT  @   "v=spf1 include:<provider-spf-host> ~all"
```

Only one SPF record may exist per domain. If one already exists, merge the
`include:` into it rather than adding a second record.

#### DKIM — cryptographically signs your mail

The provider supplies a public key. Typically:

```
TXT  <selector>._domainkey   "v=DKIM1; k=rsa; p=<public-key>"
```

Some providers use a CNAME instead. Follow their instructions exactly.

#### DMARC — tells receivers what to do with failures

Start in monitoring mode, then tighten:

```
TXT  _dmarc   "v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com; pct=100"
```

After two weeks of clean reports, move to `p=quarantine`, then `p=reject`.
Do not jump straight to `reject` — you will silently lose legitimate mail.

### Verify DNS

```bash
nslookup -type=TXT yourdomain.com
nslookup -type=TXT <selector>._domainkey.yourdomain.com
nslookup -type=TXT _dmarc.yourdomain.com
```

Or use <https://www.mail-tester.com> — aim for 9/10 or better.

---

## 3. Redirect URL allowlist

Supabase rejects any redirect URL not on the allowlist. This is a security
control: it prevents an attacker from redirecting a confirmation token to their
own domain.

In **Authentication → URL Configuration**:

**Site URL:**
```
https://app.yourdomain.com
```

**Redirect URLs** (one per line):
```
https://app.yourdomain.com/auth/callback
https://app.yourdomain.com/auth/reset-password
https://*.vercel.app/auth/callback
https://*.vercel.app/auth/reset-password
http://localhost:5173/auth/callback
http://localhost:5173/auth/reset-password
```

The `*.vercel.app` wildcard covers preview deployments. Remove it once you have
a stable production domain if you do not want previews to accept auth redirects.

**Current remote state:** `additional_redirect_urls` is **empty** on
`xseytkeykqwgirgixlir`. Confirmation and reset links will fail until this is
configured.

---

## 4. Environment variables

### Local (`.env.local`, never committed)

```
VITE_SUPABASE_URL=https://xseytkeykqwgirgixlir.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

### Vercel

Set in **Project → Settings → Environment Variables**:

| Name | Value | Environments |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` | Production, Preview, Development |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` | Production, Preview, Development |

**Only `VITE_*` variables are safe in the browser.** Vite inlines them into the
public JavaScript bundle. Never add:

- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_PASSWORD`
- SMTP credentials
- Any `sb_secret_*` value

If a secret must be used server-side, it belongs in a Supabase Edge Function's
environment, not in Vercel's frontend variables.

---

## 5. Deploy to Vercel

1. **Import the repository** at <https://vercel.com/new>.
2. Framework preset: **Vite**. Build command `npm run build`, output `dist`.
3. Add the environment variables from §4.
4. Deploy.
5. Add the resulting domain to the Supabase redirect allowlist (§3).

### Pre-deploy checks

```bash
npx tsc -b                 # must be clean
npm run test:unit          # 115/115
npx playwright test        # 30/30
npx vite build             # must succeed
node scripts/secret-scan.mjs
```

---

## 6. Database migrations

Migrations are applied with the Supabase CLI, never by hand.

```bash
# Preview what would change
npx supabase db push --linked --dry-run

# Apply
npx supabase db push --linked
```

**Never run `supabase db reset` against a hosted project.** It drops and
recreates the schema.

---

## 7. Post-deploy verification

- [ ] Sign up with a real email address
- [ ] Confirmation email arrives (check spam too)
- [ ] Confirmation link opens the app and signs you in
- [ ] Password reset email arrives
- [ ] Reset link opens the reset form and saves a new password
- [ ] Create a business, customer, invoice, payment
- [ ] Dashboard shows the correct figures
- [ ] Sign out and confirm protected routes redirect
- [ ] Open on a phone and confirm the layout works

---

## 8. Rollback

If a deployment is broken:

1. **Vercel → Deployments → previous deployment → Promote to Production.**
   This is instant and does not require a rebuild.
2. If the database is at fault, restore from backup — see
   `BACKUP_AND_RECOVERY.md`.

Migrations are forward-only. There are no down-migrations, so a schema mistake
requires a new corrective migration, not a rollback.
