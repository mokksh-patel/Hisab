# BizPilot — B2B Development Roadmap

**Status:** Proposal — awaiting approval
**Rule:** No milestone begins until the previous one is reviewed and approved.

---

## Complexity scale

| Rating | Meaning |
|---|---|
| **S** | Days. Well-understood, low risk. |
| **M** | 1–2 weeks. New domain logic, moderate risk. |
| **L** | 2–4 weeks. New subsystem, significant design work. |
| **XL** | 4+ weeks. Regulatory dependency or cross-cutting change. |

Complexity is **relative effort**, not calendar time. It assumes one experienced
engineer.

---

## Milestone 0 — Apply Invoice Engine V2 (prerequisite)

| Field | Value |
|---|---|
| **Complexity** | **S** |
| **Depends on** | Owner approval of migration 0005 |
| **Blocks** | Everything |

**Work:**
- Review migration 0005 (already written and corrected)
- Apply to `bizpilot-test`
- Run the 37 pgTAP assertions
- Re-run the 3 blocked Playwright tests

**Why first:** the B2B schema builds on `businesses.gst_scheme`. Applying 0005
first means B2B migrations start from a known-good base.

**Risk:** low. Migration is additive and backwards-compatible.

---

## Milestone 1 — B2B foundation

| Field | Value |
|---|---|
| **Complexity** | **L** |
| **Depends on** | M0 |

**Work:**
- `business_capabilities` table + RLS
- `business_verifications` table + RLS
- `platform_admins` + `admin_audit_logs`
- New membership roles (`purchase_manager`, `sales_manager`, `inventory_manager`)
- Capability-aware navigation
- Business profile split: personal settings vs business profile
- Verification status UI (pending / under review / verified / rejected / suspended)

**Deliverable:** a business can declare its capabilities and see its verification
status. No marketplace yet.

**Risk:** medium. Enum extension and navigation restructure touch existing code.

---

## Milestone 2 — Marketplace

| Field | Value |
|---|---|
| **Complexity** | **XL** |
| **Depends on** | M1 |

**Work:**
- `products`, `marketplace_listings`, `listing_price_tiers`
- Market homepage with search and filters
- Product detail page
- Supplier profile page
- `business_connections`
- `rfqs`, `quotations` with revision chain
- RFQ → quotation → acceptance workflow
- Buyer-safe product view (no cost price)

**Deliverable:** a verified buyer can find a supplier, send an RFQ, and receive a
quotation.

**Risk:** high. This is the largest single milestone. The buyer-safe view is the
critical security surface — `cost_price_paise` must never leak.

---

## Milestone 3 — Orders

| Field | Value |
|---|---|
| **Complexity** | **L** |
| **Depends on** | M2 |

**Work:**
- `purchase_orders`, `order_lines`, `deliveries`
- Order state machine (draft → confirmed → dispatched → received → completed)
- Order numbering (per supplier, per financial year)
- Cancellation and dispute paths
- Order lists for buyer and supplier

**Deliverable:** an accepted quotation becomes an order that both sides can track.

**Risk:** medium. State machine must be enforced server-side.

---

## Milestone 4 — Inventory

| Field | Value |
|---|---|
| **Complexity** | **L** |
| **Depends on** | M3 |

**Work:**
- `inventory_locations`, `inventory_movements`, `stock_reservations`
- Append-only ledger with immutability trigger
- `product_stock` view
- Stock reservation on order confirm, release on cancel
- Goods receipt confirmation
- Returns and adjustments
- Buy & Sell Data page with movement table and graph

**Deliverable:** every stock change is traceable to a source event.

**Risk:** high. Concurrency (two dispatches of the same product) must not
oversell. The `FOR UPDATE` locking pattern must be tested.

---

## Milestone 5 — Payments

| Field | Value |
|---|---|
| **Complexity** | **XL** |
| **Depends on** | M3, M4, **and regulatory clearance** |
| **Blocked by** | Open decision D1 (ECO status), D2 (payment provider) |

**Work:**
- `marketplace_payments`, `payment_provider_events`, `supplier_settlements`
- Provider abstraction interface
- UPI, card (hosted), net banking, Pay on Delivery
- Webhook handling with idempotency
- Settlement calculation and payout tracking
- Payment status lifecycle

**Deliverable:** a buyer can pay for an order; a supplier can be settled.

**Risk:** **very high.** This milestone cannot start until the ECO question and
the payment provider are resolved. Building it speculatively risks rework.

---

## Milestone 6 — Business reports

| Field | Value |
|---|---|
| **Complexity** | **L** |
| **Depends on** | M4 (for inventory reports), M5 (for payment reports) |

**Work:**
- Two-column report (Payment Due / Payment Received)
- Investment transactions
- Transaction history with filters and CSV export
- Business connections view
- Highest-selling goods
- Interactive trend graph (final component)

**Deliverable:** a business owner can answer "what do I owe, what came in, what
sold".

**Risk:** medium. Metric definitions must be approved first
(`B2B_METRICS_DICTIONARY.md`).

---

## Milestone 7 — Platform admin

| Field | Value |
|---|---|
| **Complexity** | **L** |
| **Depends on** | M1 (verification), M2 (listings), M3 (orders) |

**Work:**
- Separate admin shell and route tree
- Admin dashboard with defined metrics
- RIA analytics page
- Business verification queue
- Listing moderation
- Platform Buy & Sell Data
- Admin audit log viewer

**Deliverable:** BizPilot staff can operate the marketplace.

**Risk:** medium. The separation from the business workspace is the critical
design constraint.

---

## Milestone 8 — Launch readiness

| Field | Value |
|---|---|
| **Complexity** | **XL** |
| **Depends on** | All previous |

**Work:**
- Security testing (cross-tenant, admin escalation)
- Privacy review (DPDP)
- Backup and recovery rehearsal
- Payment provider verification in sandbox then production
- GST professional review
- Controlled B2B pilot with a small number of businesses

**Deliverable:** a pilot that can be run without regulatory or data exposure.

**Risk:** high. Depends on external professional reviews.

---

## Dependency graph

```
M0 (apply 0005)
 │
 ▼
M1 (foundation)
 │
 ├──────────────┐
 ▼              ▼
M2 (market)    M7 (admin)  ← can start after M1 for verification only
 │
 ▼
M3 (orders)
 │
 ▼
M4 (inventory)
 │
 ├──────────────┐
 ▼              ▼
M5 (payments)  M6 (reports)
 │              │
 └──────┬───────┘
        ▼
M8 (launch)
```

---

## What is deliberately deferred

| Feature | Why deferred |
|---|---|
| Bill of Supply | Requires GST professional review |
| Leverage metrics | Requires liabilities/equity data that does not exist |
| Profit margin | Requires reliable cost data |
| Wallet / escrow | Regulatory exposure |
| Logistics integration | Not core to the marketplace loop |
| AI recommendations | No data yet |
| Multi-currency | Not needed for Indian B2B pilot |

---

## Estimated total

| Milestone | Complexity |
|---|---|
| M0 | S |
| M1 | L |
| M2 | XL |
| M3 | L |
| M4 | L |
| M5 | XL |
| M6 | L |
| M7 | L |
| M8 | XL |

**Rough shape:** 2 XL milestones (marketplace, payments) dominate. Payments is
externally blocked. Marketplace is the largest self-contained build.

**Recommendation:** deliver M0 → M1 → M2 → M3 → M4 as a coherent "marketplace
without payments" product, then pause for regulatory clearance before M5.
