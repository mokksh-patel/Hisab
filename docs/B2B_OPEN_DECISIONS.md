# BizPilot — B2B Open Decisions

**Status:** Awaiting business-owner approval
**Rule:** No implementation begins on a blocked item until its decision is recorded here.

---

## How to use this document

Each decision has:
- **Question** — what must be decided
- **Options** — the realistic choices
- **Recommendation** — what I would do and why
- **Blocks** — which milestone cannot proceed
- **Owner** — who must decide

Record the decision inline and date it. This document is the audit trail for
architectural choices.

---

## D1 — Is BizPilot an Electronic Commerce Operator?

| Field | Value |
|---|---|
| **Question** | Does BizPilot's fund flow make it an ECO under GST, triggering TCS obligations? |
| **Options** | (a) BizPilot never touches funds — buyer pays supplier directly via aggregator split; (b) BizPilot collects and settles — likely ECO; (c) BizPilot resells on own account — not ECO but is the supplier |
| **Recommendation** | **(a)** until a chartered accountant confirms otherwise. It is the lowest-risk path and avoids TCS entirely. |
| **Blocks** | Milestone 5 (Payments) |
| **Owner** | Business owner + CA |
| **Status** | ⬜ **OPEN** |

---

## D2 — Payment provider selection

| Field | Value |
|---|---|
| **Question** | Which RBI-authorised payment aggregator will BizPilot integrate? |
| **Options** | Razorpay, Cashfree, PayU, PhonePe PG, or another with marketplace split settlement |
| **Criteria** | RBI authorisation, split settlement support, UPI + card + net banking, webhook reliability, sandbox availability, pricing |
| **Recommendation** | Do not choose until D1 is resolved. Build the provider abstraction first so the choice is reversible. |
| **Blocks** | Milestone 5 |
| **Owner** | Business owner |
| **Status** | ⬜ **OPEN** |

---

## D3 — Leverage metric definition

| Field | Value |
|---|---|
| **Question** | Should BizPilot display a financial leverage ratio, and if so, how is it computed? |
| **Options** | (a) Do not display — BizPilot has no liabilities/equity data; (b) Add a balance-sheet inputs screen and compute debt-to-equity; (c) Display only when the business has entered both figures |
| **Recommendation** | **(a) for the pilot.** A ratio derived from missing data is worse than no ratio. Revisit after the pilot if owners ask for it. |
| **Blocks** | Milestone 6 (Reports) — the leverage section |
| **Owner** | Business owner |
| **Status** | ⬜ **OPEN** |

---

## D4 — Business verification method

| Field | Value |
|---|---|
| **Question** | How does a business become verified? |
| **Options** | (a) Manual review by a platform admin (document upload + human check); (b) Authorised GSTIN verification API; (c) Both — API check plus human review |
| **Recommendation** | **(a) for the pilot.** It is honest, requires no third-party contract, and scales to the first few hundred businesses. Add (b) later. |
| **Blocks** | Milestone 1 (verification workflow) |
| **Owner** | Business owner |
| **Status** | ⬜ **OPEN** |

---

## D5 — Marketplace gating strictness

| Field | Value |
|---|---|
| **Question** | What can an unverified business do? |
| **Options** | (a) Nothing — must be verified to see the marketplace at all; (b) Can browse listings but not see prices or send RFQs; (c) Can browse and see prices but not transact |
| **Recommendation** | **(b)** — browsing builds intent, but wholesale prices and supplier contact stay behind verification. |
| **Blocks** | Milestone 2 (marketplace) |
| **Owner** | Business owner |
| **Status** | ⬜ **OPEN** |

---

## D6 — Existing businesses: capability backfill

| Field | Value |
|---|---|
| **Question** | What capabilities do existing businesses get when B2B launches? |
| **Options** | (a) Both `buyer` and `seller`, flagged for review; (b) `buyer` only; (c) None — they must choose |
| **Recommendation** | **(a)** — least disruptive, and the review flag prompts them to confirm. |
| **Blocks** | Milestone 1 (migration) |
| **Owner** | Business owner |
| **Status** | ⬜ **OPEN** |

---

## D7 — Existing businesses: verification backfill

| Field | Value |
|---|---|
| **Question** | Are existing businesses auto-verified on launch? |
| **Options** | (a) All set to `pending` — must be verified to use the marketplace; (b) Auto-verified because they are already customers; (c) Verified only if they have a GSTIN |
| **Recommendation** | **(a)** — verification means something only if it is applied consistently. Existing customers get a fast-track review, not an automatic pass. |
| **Blocks** | Milestone 1 |
| **Owner** | Business owner |
| **Status** | ⬜ **OPEN** |

---

## D8 — Bill of Supply support

| Field | Value |
|---|---|
| **Question** | When will BizPilot support Bill of Supply for composition taxpayers? |
| **Options** | (a) Not in the pilot — composition businesses can only record exempt invoices; (b) Build it in Milestone 2; (c) Build it when a composition business asks |
| **Recommendation** | **(a)** — it requires GST professional review of the required particulars. Document the limitation clearly. |
| **Blocks** | Nothing immediately; affects composition-scheme businesses |
| **Owner** | Business owner + CA |
| **Status** | ⬜ **OPEN** |

---

## D9 — Platform commission model

| Field | Value |
|---|---|
| **Question** | Does BizPilot charge a commission on marketplace transactions? |
| **Options** | (a) No commission — free marketplace; (b) Percentage of order value; (c) Flat fee per order; (d) Subscription only |
| **Recommendation** | **(a) for the pilot.** Commission introduces settlement complexity and GST questions that are not worth solving before the marketplace has users. |
| **Blocks** | Milestone 5 (settlement calculation) |
| **Owner** | Business owner |
| **Status** | ⬜ **OPEN** |

---

## D10 — Analytics and consent

| Field | Value |
|---|---|
| **Question** | What analytics does BizPilot collect on the public site, and how is consent obtained? |
| **Options** | (a) First-party only, no cookies, no consent banner needed; (b) First-party with cookies and a consent banner; (c) Third-party analytics |
| **Recommendation** | **(a)** — simplest DPDP position, no third-party data sharing, and sufficient for the RIA metrics defined. |
| **Blocks** | Milestone 7 (RIA) |
| **Owner** | Business owner |
| **Status** | ⬜ **OPEN** |

---

## D11 — Invoice Engine V2 application

| Field | Value |
|---|---|
| **Question** | Should migration 0005 be applied before B2B work begins? |
| **Options** | (a) Apply now to `bizpilot-test`; (b) Apply after B2B architecture is approved; (c) Defer |
| **Recommendation** | **(a)** — it is additive, backwards-compatible, and B2B depends on `gst_scheme`. Applying it first means B2B migrations start from a known-good base. |
| **Blocks** | Milestone 0 |
| **Owner** | Business owner |
| **Status** | ⬜ **OPEN** |

---

## D12 — Admin panel hosting

| Field | Value |
|---|---|
| **Question** | Is the platform admin panel part of the same deployment or a separate one? |
| **Options** | (a) Same app, separate route tree (`/admin`); (b) Separate deployment with its own domain; (c) Separate app entirely |
| **Recommendation** | **(a) for the pilot** — simpler to deploy and the route guard is sufficient. Move to (b) if the admin surface grows or if compliance requires network separation. |
| **Blocks** | Milestone 7 |
| **Owner** | Business owner |
| **Status** | ⬜ **OPEN** |

---

## Summary

| ID | Decision | Blocks | Status |
|---|---|---|---|
| D1 | ECO status | M5 | ⬜ Open |
| D2 | Payment provider | M5 | ⬜ Open |
| D3 | Leverage metric | M6 | ⬜ Open |
| D4 | Verification method | M1 | ⬜ Open |
| D5 | Gating strictness | M2 | ⬜ Open |
| D6 | Capability backfill | M1 | ⬜ Open |
| D7 | Verification backfill | M1 | ⬜ Open |
| D8 | Bill of Supply | — | ⬜ Open |
| D9 | Commission model | M5 | ⬜ Open |
| D10 | Analytics consent | M7 | ⬜ Open |
| D11 | Apply migration 0005 | M0 | ⬜ Open |
| D12 | Admin hosting | M7 | ⬜ Open |

**Nothing is implemented until D11 is decided** — it is the gate for Milestone 0.
