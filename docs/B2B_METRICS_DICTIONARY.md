# BizPilot — B2B Metrics Dictionary

**Status:** Proposal — definitions require owner approval
**Rule:** No metric may be displayed until its definition here is approved.

---

## 1. Why this document exists

The specification correctly warns against deriving business metrics from
unrelated tables or counting the same event twice. Every metric below states:

- **Meaning** — what it answers
- **Formula** — exact computation
- **Source** — which table(s)
- **Date basis** — as-of vs during
- **Includes / Excludes** — boundary rules
- **Currency** — always INR paise

---

## 2. Receivables metrics (existing, formalised)

### 2.1 Outstanding receivables

| Field | Value |
|---|---|
| **Meaning** | Money customers still owe as of a date |
| **Formula** | `SUM(invoice.total_amount_paise − live_allocations)` for issued invoices, floored at 0 |
| **Source** | `invoice_balances` view |
| **Date basis** | **As of** a specified date |
| **Includes** | `document_state = 'issued'` |
| **Excludes** | Drafts, voided invoices, reversed payments |
| **Currency** | INR paise |

### 2.2 Overdue receivables

| Field | Value |
|---|---|
| **Meaning** | Outstanding on invoices past their due date |
| **Formula** | `SUM(outstanding)` where `due_date < as_of_date` |
| **Source** | `invoice_balances` |
| **Date basis** | **As of** |
| **Includes** | Issued, outstanding > 0, due date strictly before as-of |
| **Excludes** | Invoices due today (not yet overdue) |

### 2.3 Upcoming receivables

| Field | Value |
|---|---|
| **Meaning** | Outstanding not yet due |
| **Formula** | `SUM(outstanding)` where `due_date >= as_of_date` |
| **Date basis** | **As of** |

### 2.4 Payments collected

| Field | Value |
|---|---|
| **Meaning** | Money actually received in a period |
| **Formula** | `SUM(payment.amount_paise)` where `reversed_at IS NULL` |
| **Source** | `payment_balances` |
| **Date basis** | **During** the selected period |
| **Excludes** | Reversed payments |

### 2.5 Net payments received

| Field | Value |
|---|---|
| **Meaning** | Collected minus reversals and refunds |
| **Formula** | `collected − reversed_amount − refunded_amount` |
| **Date basis** | **During** |
| **Note** | This is the figure that belongs in the "Payment Received" column |

### 2.6 Unallocated advances

| Field | Value |
|---|---|
| **Meaning** | Money received but not yet applied to an invoice |
| **Formula** | `SUM(payment.amount_paise − allocated_paise)` where `reversed_at IS NULL` |
| **Source** | `payment_balances` |
| **Date basis** | **As of** |

---

## 3. Marketplace metrics (new)

### 3.1 Active listings

| Field | Value |
|---|---|
| **Meaning** | Listings currently visible to buyers |
| **Formula** | `COUNT(*)` where `status = 'active'` |
| **Source** | `marketplace_listings` |
| **Date basis** | **As of** |
| **Excludes** | Draft, paused, archived |

### 3.2 RFQs submitted

| Field | Value |
|---|---|
| **Meaning** | Buyer enquiries sent to suppliers |
| **Formula** | `COUNT(*)` where `status <> 'draft'` |
| **Source** | `rfqs` |
| **Date basis** | **During** |
| **Excludes** | Drafts never sent |

### 3.3 Quotation conversion rate

| Field | Value |
|---|---|
| **Meaning** | Share of RFQs that received a quotation |
| **Formula** | `COUNT(DISTINCT rfq_id with quotation) / COUNT(DISTINCT rfq_id sent)` |
| **Source** | `rfqs`, `quotations` |
| **Date basis** | **During** |
| **Note** | Denominator is RFQs *sent*, not RFQs created |

### 3.4 Order conversion rate

| Field | Value |
|---|---|
| **Meaning** | Share of quotations that became orders |
| **Formula** | `COUNT(orders with quotation_id) / COUNT(quotations submitted)` |
| **Source** | `purchase_orders`, `quotations` |
| **Date basis** | **During** |

### 3.5 Gross merchandise value (GMV)

| Field | Value |
|---|---|
| **Meaning** | Total value of confirmed orders |
| **Formula** | `SUM(total_paise)` where `status IN ('confirmed','dispatched','received','completed')` |
| **Source** | `purchase_orders` |
| **Date basis** | **During** (by `confirmed_at`) |
| **Excludes** | Draft, cancelled, disputed |
| **Warning** | GMV is **not** revenue. It is order value. Never label it revenue. |

---

## 4. Inventory metrics

### 4.1 Stock on hand

| Field | Value |
|---|---|
| **Meaning** | Physical quantity in a location |
| **Formula** | `SUM(quantity_delta)` from the movement ledger |
| **Source** | `inventory_movements` |
| **Date basis** | **As of** |
| **Includes** | All movement types |
| **Note** | Never a stored column — always derived |

### 4.2 Stock available

| Field | Value |
|---|---|
| **Meaning** | Quantity that can be sold now |
| **Formula** | `on_hand − reserved` |
| **Source** | `product_stock` view |
| **Date basis** | **As of** |
| **Excludes** | Reserved quantities |

### 4.3 Stock in transit

| Field | Value |
|---|---|
| **Meaning** | Dispatched by supplier, not yet received |
| **Formula** | `SUM(order_lines.quantity)` where order `status = 'dispatched'` |
| **Source** | `purchase_orders`, `order_lines` |
| **Date basis** | **As of** |
| **Note** | In-transit is **not** counted in on-hand for the buyer until receipt |

### 4.4 Top-selling quantity

| Field | Value |
|---|---|
| **Meaning** | Net quantity sold after returns |
| **Formula** | `SUM(dispatched_qty) − SUM(returned_qty)` |
| **Source** | `order_lines`, `inventory_movements` |
| **Date basis** | **During** |
| **Excludes** | Cancelled orders, draft orders |
| **Critical** | Must be **net of returns**. Gross dispatch is not "sold". |

### 4.5 Top-selling net sales value

| Field | Value |
|---|---|
| **Meaning** | Revenue from a product after returns and discounts |
| **Formula** | `SUM(line_total_paise for dispatched) − SUM(refunded for returns)` |
| **Date basis** | **During** |
| **Excludes** | Cancelled orders |

---

## 5. RIA metrics (platform admin)

### 5.1 Visitor

| Field | Value |
|---|---|
| **Meaning** | An anonymous session on the public site |
| **Formula** | `COUNT(DISTINCT session_id)` |
| **Source** | `analytics_events` (first-party) |
| **Date basis** | **During** |
| **Note** | A visitor is **not** an interested business |

### 5.2 Interested business

| Field | Value |
|---|---|
| **Meaning** | A business that took an explicit engagement action |
| **Formula** | `COUNT(DISTINCT business_id)` where the business has at least one of: registration completed, RFQ sent, supplier inquiry sent |
| **Source** | `businesses`, `rfqs` |
| **Date basis** | **During** |
| **Excludes** | Anonymous visitors, bounced sessions |
| **Critical** | This is the metric the spec warns about. A page view is not interest. |

### 5.3 Visitor → registration conversion

| Field | Value |
|---|---|
| **Meaning** | Share of visitors who started a registration |
| **Formula** | `COUNT(DISTINCT registration_started) / COUNT(DISTINCT visitor)` |
| **Date basis** | **During** |
| **Note** | Requires a first-party `registration_started` event |

### 5.4 Registration → verification conversion

| Field | Value |
|---|---|
| **Meaning** | Share of registered businesses that got verified |
| **Formula** | `COUNT(verified) / COUNT(registered)` |
| **Source** | `businesses`, `business_verifications` |
| **Date basis** | **During** (by registration date cohort) |

### 5.5 Verified → engaged conversion

| Field | Value |
|---|---|
| **Meaning** | Share of verified businesses that sent an RFQ |
| **Formula** | `COUNT(verified with ≥1 RFQ) / COUNT(verified)` |
| **Date basis** | **During** |

---

## 6. Investment metrics

### 6.1 Total capital contributed

| Field | Value |
|---|---|
| **Meaning** | Owner money put into the business |
| **Formula** | `SUM(amount_paise)` where `category = 'owner_capital'` and `status <> 'void'` |
| **Source** | `investment_transactions` |
| **Date basis** | **During** |
| **Critical** | **Not revenue.** Never added to sales. |

### 6.2 Total borrowings

| Field | Value |
|---|---|
| **Meaning** | Money borrowed |
| **Formula** | `SUM(amount_paise)` where `category = 'borrowing_received'` |
| **Date basis** | **During** |
| **Critical** | **Not revenue.** A loan is a liability, not income. |

### 6.3 Fixed-asset investment

| Field | Value |
|---|---|
| **Meaning** | Money spent on equipment and fixed assets |
| **Formula** | `SUM(amount_paise)` where `category = 'fixed_asset_purchase'` |
| **Date basis** | **During** |
| **Note** | Inventory purchases are a **separate** category and must not be counted here |

---

## 7. Metrics that are NOT defined

These appear in the specification but cannot be computed reliably today.

### 7.1 Leverage / debt-to-equity

**Status: NOT DEFINED — requires owner decision**

| Field | Value |
|---|---|
| **Meaning** | Financial leverage ratio |
| **Formula** | `total_liabilities / total_equity` |
| **Problem** | BizPilot does not collect liabilities or equity |
| **Options** | (a) Do not display; (b) collect via a balance-sheet inputs screen; (c) display only when both are present |
| **Recommendation** | **(a) for the pilot.** A fabricated ratio is worse than no ratio. |

### 7.2 Profit / margin

**Status: PARTIALLY DEFINED**

| Field | Value |
|---|---|
| **Meaning** | Revenue minus cost |
| **Formula** | `net_sales − COGS` |
| **Problem** | `products.cost_price_paise` is optional and often absent |
| **Rule** | Display margin **only** for products where cost price is recorded. Never estimate. |

### 7.3 Supplier response time

**Status: NOT DEFINED**

| Field | Value |
|---|---|
| **Meaning** | How quickly a supplier responds to RFQs |
| **Formula** | `AVG(first_quotation.created_at − rfq.created_at)` |
| **Problem** | Requires enough data to be meaningful; a single sample is misleading |
| **Rule** | Display only when a supplier has ≥ 5 responded RFQs |

---

## 8. Cross-cutting rules

1. **Never mix as-of and during.** A report column is one or the other, labelled.
2. **Never count the same event twice.** A business that sends 3 RFQs is 1
   engaged business, not 3.
3. **Never derive revenue from order value.** GMV ≠ revenue.
4. **Never add investment to sales.** Capital and borrowings are not income.
5. **Never show a ratio without its inputs.** If the inputs are missing, show
   "not available", not zero.
6. **Always state the date basis** next to the number.
7. **All money in paise**, formatted only at the display layer.
