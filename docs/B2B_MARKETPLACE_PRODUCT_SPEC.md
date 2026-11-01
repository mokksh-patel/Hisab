# BizPilot — B2B Marketplace Product Specification

**Status:** Architecture proposal — awaiting approval
**Branch:** `feature/b2b-architecture`
**Date:** Phase 8

---

## 1. Executive summary

BizPilot today is a **single-tenant-per-business receivables application**. It tracks
invoices, payments and outstanding balances for one business at a time.

This specification proposes extending it into a **B2B marketplace and business
management platform** where businesses buy from and sell to each other.

The change is substantial. It is not a feature addition — it is a second product
surface sharing the same identity and tenancy foundation.

### What stays

- Authentication, onboarding, business membership
- Multi-tenant RLS isolation
- Invoice Engine V2 (receivables)
- Payment allocation and reversal
- Audit logging and immutability guards

### What is added

- Business capability roles (buyer / supplier / both)
- Business verification workflow
- Product catalogue and marketplace listings
- RFQ → quotation → order workflow
- Inventory movement ledger
- B2B payment and settlement
- Platform admin panel (separate from business workspace)
- Business owner reporting centre

---

## 2. The two-experience principle

This is the most important architectural decision in this document.

BizPilot must have **two clearly separate experiences**:

| Experience | Audience | Purpose |
|---|---|---|
| **Business Workspace** | Business owners and staff | Run their own business: invoices, inventory, orders, reports |
| **Platform Admin Panel** | BizPilot staff only | Operate the marketplace: verify businesses, moderate listings, view platform analytics |

### Why they must be separate

1. **Different trust boundaries.** A business owner is a tenant. A platform admin
   is an operator who can see across tenants. Conflating them creates a path where
   a business admin accidentally gains cross-tenant visibility.

2. **Different data.** The business workspace shows *my* invoices. The admin panel
   shows *aggregate* platform activity. Mixing them in one navigation invites
   accidental data exposure.

3. **Different audit requirements.** Every admin action must be logged with the
   operator's identity. Business actions are logged per tenant. Separate audit
   streams make both easier to reason about.

4. **Different failure modes.** If the admin panel breaks, businesses must keep
   working. Separate route trees and separate data access make that possible.

### Implementation consequence

```
/                    → Business Workspace (existing app shell)
/admin               → Platform Admin Panel (separate shell, separate guard)
```

The admin panel is **not** a route inside the business sidebar. It is a separate
application shell with its own navigation, its own layout, and its own
authorisation check that does not consult `business_members` at all.

**A business owner must never automatically receive platform-admin permissions.**
Platform admin status lives in a separate table (`platform_admins`) with no
relationship to `business_members`.

---

## 3. Business account and role model

### 3.1 A business is an organisation, not a login

Today `businesses` is already an organisation record, and `business_members`
already links users to businesses with roles. This is the correct foundation and
does not need to change.

### 3.2 Capability roles are separate from membership roles

**Critical distinction:**

| Concept | Table | Meaning |
|---|---|---|
| **Membership role** | `business_members.role` | What this *person* may do inside the business |
| **Capability role** | `business_capabilities` | What this *business* may do on the marketplace |

A business can be a supplier **and** a retailer simultaneously. A person's
membership role (owner, accountant, purchase manager) is orthogonal to that.

### 3.3 Capability roles

```
retailer      — buys goods to resell
wholesaler    — buys in bulk, sells in bulk
distributor   — buys from manufacturers, sells to retailers
manufacturer  — produces and sells goods
buyer         — purchases only (no listings)
seller        — sells only (no purchasing)
```

A business holds **one or more** capabilities. The model is a join table, not a
column, precisely because the spec requires multi-role businesses.

### 3.4 Membership roles — proposed extension

Current: `owner`, `admin`, `accountant`, `collection_staff`, `read_only`

Proposed additions for B2B operations:

```
purchase_manager  — may create RFQs, purchase orders, receive goods
sales_manager     — may create listings, quotations, sales orders
inventory_manager — may record stock movements and adjustments
```

These are additive to the existing enum. Existing roles keep their meaning.

---

## 4. Business verification

### 4.1 States

```
pending      — registered, not yet submitted for review
under_review — submitted, awaiting platform review
verified     — approved by platform admin
rejected     — review failed; reason recorded
suspended    — was verified, now restricted
```

### 4.2 What verification is NOT

**A GSTIN that passes a regex is not a verified GSTIN.**

The current schema validates GSTIN *format* only:

```sql
gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'
```

That proves the string is well-formed. It proves nothing about whether the
business exists, whether the GSTIN belongs to it, or whether it is active.

**Verification must be one of:**

1. Manual review by a platform admin (document upload + human check), or
2. An authorised third-party GSTIN verification API (requires provider selection
   and legal review — see `B2B_PAYMENT_AND_GST_RESEARCH.md`)

Until one of those exists, the UI must say **"GSTIN format valid — not verified"**,
never "GST verified".

### 4.3 Marketplace gating

| Action | Requires |
|---|---|
| Browse marketplace | `verified` business |
| Create listing | `verified` + `seller` capability |
| Send RFQ | `verified` + `buyer` capability |
| Place order | `verified` + `buyer` capability |

`pending`, `under_review`, `rejected`, `suspended` businesses see a clear
explanation and a path to resolution — not a blank screen.

---

## 5. Public website vs authenticated marketplace

### 5.1 Public (anonymous)

- What BizPilot is
- How to register a business
- Benefits for suppliers and retailers
- Contact and support
- **Nothing else**

### 5.2 Authenticated (verified business)

- Supplier discovery
- Product listings with wholesale prices
- RFQs and quotations
- Orders
- Business connections

### 5.3 What must never be public

| Data | Reason |
|---|---|
| Wholesale prices | Competitive information |
| Supplier contact details | Enables disintermediation |
| Business GSTINs | Personal/business identifying data |
| Order volumes | Commercially sensitive |
| Any customer list | Confidential |

**Search engine indexing must be blocked on all `/market/*` routes** via
`robots.txt` and `noindex` headers.

---

## 6. Marketplace workflow

### 6.1 The core loop

```
Buyer                          Platform                        Supplier
  │                               │                               │
  ├─ search products ────────────►│                               │
  │◄──────────── results ─────────┤                               │
  │                               │                               │
  ├─ open listing ───────────────►│                               │
  │◄──────── listing detail ──────┤                               │
  │                               │                               │
  ├─ send RFQ ───────────────────►├──── notify ──────────────────►│
  │                               │                               │
  │                               │◄──── submit quotation ────────┤
  │◄──────── quotation ───────────┤                               │
  │                               │                               │
  ├─ accept quotation ───────────►├──── notify ──────────────────►│
  │                               │                               │
  │◄──────── purchase order ──────┤                               │
  │                               │                               │
  │                               │◄──── confirm / dispatch ──────┤
  │◄──────── goods dispatched ────┤                               │
  │                               │                               │
  ├─ confirm receipt ────────────►├──── stock movements ─────────►│
  │                               │                               │
  ├─ pay ────────────────────────►├──── settlement ──────────────►│
  │                               │                               │
```

### 6.2 State machines

**RFQ:**
```
draft → sent → quoted → accepted → converted_to_order
                    ↘ rejected
                    ↘ expired
                    ↘ cancelled
```

**Quotation:**
```
draft → submitted → accepted → converted_to_order
                 ↘ rejected
                 ↘ expired
                 ↘ superseded   (a revision replaced it)
```

**Purchase order:**
```
draft → confirmed → dispatched → received → completed
                 ↘ cancelled
                 ↘ disputed
```

**Critical rule:** an RFQ is **not** a sale. A quotation is **not** a sale. Only a
confirmed order with dispatched goods is a sale. Reports must never count RFQs or
quotations as revenue.

### 6.3 Quotation revisions

A supplier may revise a quotation before it is accepted. Each revision is a new
row with `revision_of` pointing at the previous one. The buyer sees the latest
non-superseded quotation. History is preserved for audit.

---

## 7. Inventory model

### 7.1 Ledger, not a number

**Stock is never a mutable column.** It is derived from an append-only movement
ledger.

```
stock_on_hand(product, location) = SUM(movements.quantity_delta)
```

This is the single most important inventory decision. A mutable `stock_quantity`
column loses history, cannot be audited, and drifts under concurrency.

### 7.2 Movement types

| Type | Direction | Trigger |
|---|---|---|
| `purchase_received` | + | Goods receipt confirmed |
| `sale_dispatched` | − | Order dispatched |
| `customer_return` | + | Return accepted in sellable condition |
| `supplier_return` | − | Returned to supplier |
| `damage` | − | Damaged goods written off |
| `expiry` | − | Expired stock written off |
| `adjustment_positive` | + | Authorised correction |
| `adjustment_negative` | − | Authorised correction |
| `transfer_in` | + | Received from another location |
| `transfer_out` | − | Sent to another location |

### 7.3 Every movement records

```
product_id, location_id, quantity_delta, unit,
source_type, source_id,        -- links to order/receipt/adjustment
quantity_before, quantity_after,
reason, created_by, created_at
```

`quantity_before` and `quantity_after` are stored **at write time** so the ledger
is readable without replaying history, and so a bug in the derivation is
detectable.

### 7.4 Two-sided transfers

When a retailer receives 50 units from a supplier:

- Supplier: `sale_dispatched` −50, `source_id = order_id`
- Retailer: `purchase_received` +50, `source_id = order_id`

Both reference the same order. Neither business can see the other's ledger row —
they see their own movement, linked by the shared order id.

### 7.5 Stock states

| State | Definition |
|---|---|
| **On hand** | Sum of all movements |
| **Reserved** | Sum of active reservations (order confirmed, not dispatched) |
| **Available** | On hand − reserved |
| **In transit** | Dispatched by supplier, not yet received by buyer |

**Negative stock is blocked** by a check at write time unless the business has
explicitly enabled overselling.

---

## 8. Payments — three separate concerns

The spec is explicit and correct: these must not be one table.

| Concern | Table | Who pays whom |
|---|---|---|
| **Buyer → Supplier** | `marketplace_payments` | Buyer business pays for an order |
| **Platform → Supplier** | `supplier_settlements` | Platform settles funds to supplier |
| **Business → its customers** | `payments` (existing) | Existing receivables |

The existing `payments` table is **untouched**. It records money a business
receives from *its own customers*. Marketplace payments are a different domain.

### 8.1 Payment terms vs collection method

The spec correctly identifies that "Payment in cash" is wrong terminology.

```
payment_term:      pay_on_delivery | prepaid | credit
collection_method: upi | card | net_banking | cash_on_delivery
status:            pending | collected | verified | failed | refunded
```

"Pay on Delivery" is a **term**. Cash/UPI/card is the **method**. They are
independent.

### 8.2 Card payments — hard constraint

**BizPilot will never collect, transmit or store raw card data.**

- No PAN input field in our UI
- No CVV field
- No card number in any request to our backend

Card payment uses the provider's **hosted checkout** or **tokenised component**.
We store only:

```
provider_name, provider_payment_id, provider_order_id,
masked_card (e.g. "•••• 4242"), card_network, status
```

This is both a PCI-DSS requirement and an RBI requirement.

### 8.3 Payment state machine

```
created → pending → processing → successful
                             ↘ failed
                             ↘ cancelled
        successful → partially_refunded → refunded
                   ↘ disputed
```

### 8.4 Webhook idempotency

Every provider webhook carries a provider event id. We store it in
`payment_provider_events` with a unique constraint. A duplicate webhook is
recorded but **does not** create a second payment or a second stock movement.

---

## 9. Reporting centre

### 9.1 Two columns, never mixed

The spec is right that "due" and "received" must be visually and semantically
separate.

**Column 1 — Payment Due** (as of a date)
- Total outstanding receivables
- Overdue receivables
- Upcoming receivables
- Count of overdue invoices

**Column 2 — Payment Received** (during a period)
- Payments collected
- Allocated payments
- Unallocated advances
- Refunds and reversals
- Net received

The date basis differs: column 1 is *as of*, column 2 is *during*. Mixing them
produces nonsense. The UI must label both explicitly.

### 9.2 Investment data

Categories with distinct accounting treatment:

| Category | Is it revenue? | Is it a customer payment? |
|---|---|---|
| Owner capital contribution | No | No |
| Borrowing received | No | No |
| Loan repayment | No | No |
| Fixed-asset purchase | No | No |
| Inventory purchase | No | No |

**None of these are revenue.** The reports must never add them to sales.

### 9.3 Leverage — definition required

The spec correctly flags that "leverage" is undefined.

Financial leverage requires **liabilities** and **equity**, neither of which
BizPilot currently collects. Options:

1. **Do not display leverage** until the business enters liabilities and equity
2. Display it only when both are present, with the formula shown
3. Collect the data via a dedicated "Balance sheet inputs" screen

**Recommendation: option 1 for the pilot.** Showing a fabricated or
partially-derived leverage ratio is worse than showing nothing. This is listed
as an open decision.

---

## 10. Platform admin panel

### 10.1 Separate identity

```
platform_admins
  user_id, role, granted_by, granted_at, revoked_at
```

No relationship to `business_members`. A business owner is not an admin.

### 10.2 Roles

| Role | Can do |
|---|---|
| `super_admin` | Everything, including granting admin roles |
| `verification_admin` | Review and approve/reject business verification |
| `moderator` | Hide/restore listings, suspend businesses |
| `support` | View businesses and orders, no destructive actions |
| `analytics_viewer` | Read-only access to RIA and platform metrics |

### 10.3 Every admin action is logged

`admin_audit_logs` records: who, what, which entity, before/after, when, why.
This is separate from the tenant `audit_logs` table.

---

## 11. RIA — Report Index Analysis

### 11.1 The definition problem

The spec correctly warns: **a visitor is not an interested business.**

Definitions:

| Metric | Definition |
|---|---|
| **Visitor** | Distinct anonymous session on the public site |
| **Interested business** | A business that performed an explicit action: started registration, submitted an RFQ, or sent a supplier inquiry |
| **Registered business** | Completed business creation |
| **Verified business** | Passed verification review |

A visitor who bounces is not interested. A business that registers is.

### 11.2 Conversion funnel

```
Visitors
   ↓  (visitor → registration started)
Registration started
   ↓  (registration completed)
Registered businesses
   ↓  (verification approved)
Verified businesses
   ↓  (sent an RFQ)
Engaged businesses
   ↓  (received a quotation)
Quoted businesses
   ↓  (placed an order)
Ordering businesses
```

Each step is a distinct count of distinct businesses, not events. A business that
sends three RFQs counts once.

### 11.3 Privacy

Analytics must be **first-party** and **privacy-respecting**:

- No third-party trackers on authenticated pages
- No personal data in analytics events
- IP addresses hashed, not stored raw
- DPDP Act consent where required

---

## 12. What this specification does NOT cover

Explicitly out of scope for the first delivery:

- Consumer (B2C) shopping
- Wallet or escrow functionality
- Logistics integration
- Credit scoring or lending
- AI recommendations
- Multi-currency
- International shipping

---

## 13. Approval required before implementation

This document describes architecture only. No marketplace code has been written.

Before implementation begins, the following must be approved:

1. The two-experience separation (§2)
2. The capability-role model (§3)
3. The verification gating rules (§4)
4. The inventory ledger approach (§7)
5. The three-payment-domain split (§8)
6. The leverage decision (§9.3)

See `B2B_OPEN_DECISIONS.md` for the full list.
