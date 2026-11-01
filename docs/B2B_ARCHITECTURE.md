# BizPilot — B2B Architecture

**Status:** Architecture proposal — awaiting approval
**Companion to:** `B2B_MARKETPLACE_PRODUCT_SPEC.md`

---

## 1. Current state (verified, not assumed)

Audited on branch `feature/invoice-engine-v2` at commit `598d0ab`.

### 1.1 Database

| Object | Count | Names |
|---|---:|---|
| Tables | 11 | `businesses`, `profiles`, `business_members`, `customers`, `invoice_sequences`, `invoices`, `invoice_items`, `payments`, `payment_allocations`, `reminder_logs`, `audit_logs` |
| Enums | 6 | `member_role`, `invitation_status`, `document_state`, `payment_method`, `cheque_status`, `audit_action` |
| Views | 3 | `invoice_balances`, `payment_balances`, `customer_receivables` |
| RLS policies | 34 | All tenant tables covered |
| Migrations | 5 | 0001–0004 applied to `bizpilot-test`; **0005 unapplied** |

### 1.2 Application

| Layer | Files |
|---|---|
| Pages | `auth/`, `onboarding/`, `dashboard/`, `invoices/`, `customers/`, `payments/`, `reports/`, `settings/` |
| Services | `authService`, `businessService`, `customerService`, `invoiceService`, `paymentService`, `reportService` |
| Lib | `money`, `invoiceCalculations`, `paymentAllocation`, `receivablesAging`, `dateUtils`, `phone`, `whatsapp`, `monitoring`, `errors`, `supabase`, `cn` |
| Context | `AuthContext`, `BusinessContext` |

### 1.3 What does NOT exist

- No product catalogue
- No inventory
- No marketplace
- No platform admin
- No supplier relationships
- No orders (only invoices)
- No `docs/` directory (created by this work)

### 1.4 Test baseline

| Suite | Result |
|---|---|
| Unit | 164/164 passing |
| Playwright | 15/15 passing, 1 skipped |
| pgTAP 01 + 02 | 82 assertions, passing |
| pgTAP 03 | 37 assertions authored, **not executed** (migration 0005 unapplied) |

---

## 2. Layered architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  PRESENTATION                                                       │
│                                                                     │
│  ┌──────────────────────────┐   ┌──────────────────────────────┐   │
│  │  Business Workspace      │   │  Platform Admin Panel        │   │
│  │  /                       │   │  /admin                      │   │
│  │  AppLayout + Sidebar     │   │  AdminLayout + AdminSidebar  │   │
│  │  RequireAuth             │   │  RequirePlatformAdmin        │   │
│  │  RequireBusiness         │   │  (no business context)       │   │
│  └──────────────────────────┘   └──────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Public Site  /  (marketing, registration info)              │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  APPLICATION (services)                                             │
│                                                                     │
│  Existing:  authService  businessService  customerService           │
│             invoiceService  paymentService  reportService           │
│                                                                     │
│  New:       marketService      productService    inventoryService   │
│             rfqService         orderService      settlementService  │
│             adminService       analyticsService                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  DOMAIN (pure logic, no I/O)                                        │
│                                                                     │
│  Existing:  money  invoiceCalculations  paymentAllocation           │
│             receivablesAging  dateUtils                             │
│                                                                     │
│  New:       stockLedger  orderStateMachine  rfqStateMachine         │
│             pricingTiers  metrics                                   │
└─────────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  DATA (Supabase / PostgreSQL)                                       │
│                                                                     │
│  RLS on every tenant table                                          │
│  SECURITY DEFINER functions for multi-row financial operations      │
│  Append-only audit and stock ledgers                                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Route structure

### 3.1 Business workspace (existing, extended)

```
/                          Dashboard
/market                    Marketplace home          ← NEW
/market/products/:id       Product detail            ← NEW
/market/suppliers/:id      Supplier profile          ← NEW
/suppliers                 My suppliers              ← NEW
/buyers                    My buyers                 ← NEW
/products                  My product catalogue      ← NEW
/inventory                 Stock overview            ← NEW
/inventory/buy-sell        Buy & Sell Data           ← NEW
/orders                    Orders (buy + sell)       ← NEW
/rfqs                      RFQs and quotations       ← NEW
/invoices                  Existing
/customers                 Existing
/payments                  Existing
/reports                   Existing, extended        ← EXTENDED
/connections               Business connections      ← NEW
/settings                  Personal settings         ← NEW (split)
/settings/business         Business profile          ← MOVED
```

### 3.2 Platform admin (separate shell)

```
/admin                     Admin dashboard
/admin/ria                 Report Index Analysis
/admin/businesses          Business list
/admin/verification        Verification queue
/admin/listings            Marketplace moderation
/admin/orders              Orders and transactions
/admin/buy-sell            Platform Buy & Sell Data
/admin/reports             Platform reports
/admin/settings            Platform settings
/admin/audit               Admin audit logs
```

**The admin shell does not render `BusinessContext`.** It has no concept of a
"current business". This is deliberate — it prevents accidental tenant scoping
bugs in admin code.

---

## 4. Authorisation model

### 4.1 Three independent layers

```
Layer 1: Authentication      — is there a valid session?
Layer 2: Tenant membership   — is this user a member of this business?
Layer 3: Capability          — may this business perform this marketplace action?
```

Plus a fourth, orthogonal layer:

```
Layer 4: Platform admin      — is this user a BizPilot operator?
```

### 4.2 Layer 4 is not derived from layers 1–3

```sql
-- WRONG: deriving admin from business ownership
is_admin = exists(select 1 from business_members where role = 'owner')

-- RIGHT: separate table, separate grant
is_admin = exists(select 1 from platform_admins
                  where user_id = auth.uid() and revoked_at is null)
```

A business owner is a tenant. A platform admin is an operator. There is no
automatic promotion path between them.

### 4.3 RLS helper functions

Existing helpers stay unchanged:

```
is_business_member(business_id)
has_business_role(business_id, roles[])
can_write_financials(business_id)
can_manage_business(business_id)
is_business_owner(business_id)
```

New helpers:

```
is_platform_admin()                    -- any active admin
has_platform_role(roles[])             -- specific admin role
business_has_capability(business_id, capability)
business_is_verified(business_id)
```

All new helpers follow the existing pattern: `SECURITY DEFINER`, `STABLE`,
`set search_path = public, pg_temp`, revoked from `public`, granted to
`authenticated`.

---

## 5. Marketplace data flow

### 5.1 Listing discovery

```
Buyer browser
    │
    ├─ GET /market?category=X&state=Y&min_qty=Z
    │
    ▼
marketService.searchListings(filters)
    │
    ├─ RLS: only listings from verified businesses
    ├─ RLS: only active listings
    │
    ▼
marketplace_listings (joined to products, businesses)
    │
    ▼
Results (wholesale price visible only to verified businesses)
```

### 5.2 RFQ flow

```
Buyer                    DB                         Supplier
  │                       │                            │
  ├─ create RFQ ─────────►│ rfqs (status=sent)         │
  │                       ├─ notify ──────────────────►│
  │                       │                            │
  │                       │◄──── create quotation ─────┤
  │                       │ quotations (submitted)     │
  │◄──── notify ──────────┤                            │
  │                       │                            │
  ├─ accept ─────────────►│ quotations (accepted)      │
  │                       │ rfqs (converted)           │
  │                       ├─ create purchase_order ───►│
  │                       │ orders (confirmed)         │
  │                       │                            │
```

Every transition is a `SECURITY DEFINER` function so the state change and its
audit record commit together.

---

## 6. Inventory architecture

### 6.1 The ledger

```
inventory_movements  (append-only)
  id, business_id, product_id, location_id,
  quantity_delta, unit,
  source_type, source_id,
  quantity_before, quantity_after,
  reason, created_by, created_at
```

**No UPDATE. No DELETE.** Enforced by a trigger, exactly like `audit_logs`.

### 6.2 Derived stock

```sql
create view product_stock as
select
  product_id,
  location_id,
  sum(quantity_delta) as on_hand,
  coalesce((select sum(quantity) from stock_reservations
            where product_id = m.product_id and status = 'active'), 0) as reserved,
  sum(quantity_delta) - coalesce(reserved, 0) as available
from inventory_movements m
group by product_id, location_id;
```

`security_invoker = true`, matching the existing view pattern.

### 6.3 Concurrency

Two simultaneous dispatches of the same product must not oversell.

```sql
-- Inside the dispatch function:
select sum(quantity_delta) into v_on_hand
from inventory_movements
where product_id = p_product_id and location_id = p_location_id
for update;   -- locks the rows

if v_on_hand < p_quantity then
  raise exception 'Insufficient stock';
end if;
```

The `FOR UPDATE` on the movement rows serialises concurrent dispatches.

---

## 7. Payment architecture

### 7.1 Three domains, three tables

```
┌──────────────────────────────────────────────────────────────┐
│  DOMAIN 1: Buyer → Supplier                                  │
│  marketplace_payments                                        │
│    order_id, buyer_business_id, supplier_business_id,        │
│    amount_paise, payment_term, collection_method,            │
│    provider_name, provider_payment_id, status                │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  DOMAIN 2: Platform → Supplier                               │
│  supplier_settlements                                        │
│    supplier_business_id, period_start, period_end,           │
│    gross_paise, commission_paise, net_paise, status,         │
│    payout_reference                                          │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  DOMAIN 3: Business → its own customers  (EXISTING)          │
│  payments + payment_allocations                              │
│    UNCHANGED                                                 │
└──────────────────────────────────────────────────────────────┘
```

### 7.2 Provider abstraction

The payment provider must be replaceable. No provider name appears in business
logic.

```typescript
interface PaymentProvider {
  createIntent(input: PaymentIntentInput): Promise<PaymentIntent>;
  verifyPayment(providerPaymentId: string): Promise<PaymentStatus>;
  refund(providerPaymentId: string, amountPaise: bigint): Promise<RefundResult>;
  verifyWebhook(headers: Headers, body: string): WebhookEvent;
}
```

Implementations: `RazorpayProvider`, `CashfreeProvider`, `MockProvider` (tests).

The provider is selected by configuration, not by code changes.

### 7.3 Webhook idempotency

```
payment_provider_events
  provider_name, provider_event_id  ← UNIQUE together
  event_type, payload, received_at, processed_at
```

Processing:
1. Insert event row. If unique violation → already processed, return 200.
2. Process the event.
3. Mark `processed_at`.

A duplicate webhook cannot create a second payment or a second stock movement.

---

## 8. Reporting architecture

### 8.1 Metric computation location

All aggregates are computed **in the database**, never by loading rows into the
browser. This matches the existing `reportService` pattern.

```
reportService.getDashboardSummary()  → RPC or view
reportService.getAgingReport()       → view + client bucketing
reportService.getCollectionTrend()   → RPC
```

New reports follow the same rule.

### 8.2 The two-column report

```
┌─────────────────────────────┬─────────────────────────────┐
│  PAYMENT DUE                │  PAYMENT RECEIVED           │
│  as of 31 Oct 2026          │  1 Oct – 31 Oct 2026        │
├─────────────────────────────┼─────────────────────────────┤
│  Total outstanding  ₹4,50,000│  Collected      ₹2,10,000  │
│  Overdue            ₹1,20,000│  Allocated      ₹1,80,000  │
│  Upcoming           ₹3,30,000│  Unallocated      ₹30,000  │
│  Overdue invoices          7 │  Reversals       −₹5,000   │
│                             │  Net received   ₹2,05,000  │
└─────────────────────────────┴─────────────────────────────┘
```

The date basis is printed under each heading. This is not decoration — it
prevents the most common misreading of receivables reports.

---

## 9. Migration strategy

### 9.1 Migration 0005 compatibility

**Question:** is Invoice Engine V2 (migration 0005) compatible with the B2B
architecture?

**Answer: yes, with one note.**

| 0005 change | B2B impact |
|---|---|
| `businesses.gst_scheme` | **Required** — marketplace listings need GST treatment |
| `businesses.gst_scheme_needs_review` | Compatible |
| `invoices.price_includes_tax` | Compatible — receivables only |
| `invoices.invoice_discount_paise` | Compatible |
| `invoice_items.discount_type/value` | Compatible |
| `create_invoice()` v2 | Compatible |
| `confirm_gst_scheme()` | Compatible |

**The note:** `gst_scheme` becomes more important under B2B, because a
composition-scheme business cannot issue tax invoices *and* should probably not
appear as a GST-charging supplier in the marketplace. The verification workflow
should surface the scheme.

**No revision to 0005 is required.** It can be applied as-is before B2B work
begins.

### 9.2 Migration numbering

```
0001–0004  applied
0005       Invoice Engine V2 — unapplied, approved pending review
0006+      B2B marketplace — not yet written
```

B2B migrations must not be written until the architecture is approved.

### 9.3 Data migration risks

| Risk | Mitigation |
|---|---|
| Existing businesses have no capability roles | Backfill: all existing businesses get `buyer` + `seller` capabilities, flagged for review |
| Existing businesses are unverified | Backfill: `verification_status = 'pending'`; marketplace gated until verified |
| Existing `customers` are not marketplace buyers | Keep separate — `customers` stays a receivables concept |
| Existing invoices are not marketplace orders | Keep separate — no automatic conversion |
| `member_role` enum extension | Additive only; existing values unchanged |

---

## 10. Security architecture

### 10.1 Tenant isolation

Every new tenant table carries `business_id` and has RLS enabled with the same
policy pattern as existing tables.

**New tables requiring RLS:**

```
business_capabilities, business_verifications,
products, product_variants, marketplace_listings,
inventory_locations, inventory_movements, stock_reservations,
rfqs, quotations, purchase_orders, sales_orders,
order_lines, deliveries, marketplace_payments,
supplier_settlements, business_connections,
investment_transactions
```

**Platform tables (no tenant RLS, admin-only):**

```
platform_admins, admin_audit_logs,
payment_provider_events, analytics_events
```

### 10.2 Cross-tenant visibility rules

| Data | Visible to |
|---|---|
| Own inventory | Owning business only |
| Own invoices | Owning business only |
| Marketplace listing | All verified businesses |
| Supplier business name | All verified businesses |
| Supplier contact details | Only after an accepted connection |
| Buyer order history | Buyer and the specific supplier only |
| Supplier payout details | Supplier and platform admin only |

### 10.3 Admin access

Platform admins bypass tenant RLS **only** through `SECURITY DEFINER` functions
that explicitly check `is_platform_admin()`. There is no blanket "admin can read
everything" policy — each admin capability is a separate function with its own
role check.

---

## 11. Performance considerations

| Concern | Approach |
|---|---|
| Marketplace search | Indexed on `category`, `state_code`, `price_paise`, `is_active`; full-text on product name |
| Stock derivation | Materialised view refreshed on movement insert, or indexed aggregate |
| Report aggregates | Database-side; never load rows to the browser |
| Listing pagination | Server-side `range()` with `count: 'exact'` |
| RFQ lists | Indexed on `buyer_business_id`, `supplier_business_id`, `status` |

---

## 12. What is deliberately NOT built

- No wallet
- No escrow
- No self-operated fund pool
- No raw card storage
- No consumer accounts
- No AI recommendations
- No logistics integration

Each of these carries regulatory or complexity cost that is not justified before
the core marketplace works.
