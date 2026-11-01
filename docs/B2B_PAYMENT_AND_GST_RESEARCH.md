# BizPilot — Payment and GST Research

**Status:** Research summary — **NOT legal advice**
**Date:** Phase 8

---

## ⚠️ Read this first

This document summarises publicly available regulatory material to inform
architecture decisions. It is **not legal, tax or compliance advice**.

Every point below marked **"PROFESSIONAL REVIEW REQUIRED"** must be confirmed by
a qualified Indian chartered accountant, tax counsel or payments lawyer before
BizPilot handles real money or issues statutory documents.

**Software implementation is not legal certification.** Building a feature does
not make BizPilot compliant.

---

## 1. GST — Electronic Commerce Operator (ECO)

### 1.1 What the law says

Under the CGST Act 2017, an **Electronic Commerce Operator** is a person who
owns, operates or manages a digital facility for the supply of goods or services
by other suppliers.

Section 52 of the CGST Act provides for **Tax Collected at Source (TCS)** by an
ECO on the net value of taxable supplies made through it by other suppliers.

**Primary sources:**
- CBIC — GST Acts: <https://www.cbic.gov.in/entities/gst>
- CGST Act 2017, Section 52 (TCS)
- CGST Rules 2017, Rule 58 (ECO registration), Rule 87 (TCS returns)

### 1.2 How this affects BizPilot

**This is the single most consequential regulatory question for the platform.**

If BizPilot operates a marketplace where **third-party suppliers sell through
the platform**, and BizPilot collects or processes payment for those sales,
BizPilot may be an ECO with TCS obligations.

| Scenario | Likely ECO status | TCS |
|---|---|---|
| BizPilot only lists products; buyer and supplier transact directly off-platform | Probably not | None |
| BizPilot processes payment and settles to suppliers | **Likely yes** | **Likely applies** |
| BizPilot is a reseller (buys and sells on own account) | Not ECO — BizPilot is the supplier | N/A |

### 1.3 What must be confirmed

**PROFESSIONAL REVIEW REQUIRED:**

1. Does BizPilot's actual fund flow make it an ECO?
2. If yes, what is the TCS rate and threshold for the relevant goods?
3. Does BizPilot need ECO registration and monthly TCS returns (Form GSTR-8)?
4. How does TCS interact with the supplier's own GST returns?

### 1.4 Architectural consequence

**Do not build a wallet, escrow or self-operated seller fund pool** until this
is resolved. The specification is correct on this point.

The safest initial architecture is:

- BizPilot does **not** hold funds
- Payment goes buyer → RBI-authorised payment aggregator → supplier
- BizPilot receives only its commission via the aggregator's split settlement

This avoids BizPilot becoming a payment intermediary, which is a separate
regulated activity.

---

## 2. GST — Composition scheme

### 2.1 What the law says

A composition-scheme taxpayer:
- **Is** GST-registered
- Pays tax at a flat rate on turnover
- **Cannot collect GST** from customers
- **Cannot issue a tax invoice**
- Issues a **Bill of Supply** instead

**Primary source:** CGST Act 2017, Section 10; CGST Rules, Rule 5.

### 2.2 How this affects BizPilot

This directly validates the correction made to migration 0005:

```sql
-- Composition taxpayers ARE registered
(gst_scheme = 'composition' and is_gst_registered = true)
```

And it confirms the server-side guard is correct: a composition business must
not be able to issue a tax invoice.

### 2.3 Bill of Supply — not implemented

BizPilot currently has **no Bill of Supply document type**. A composition
business can only record an exempt invoice.

**This is a documented limitation, not a claim of support.**

**PROFESSIONAL REVIEW REQUIRED:** what particulars must a Bill of Supply carry
for BizPilot's use case?

---

## 3. GST — Tax invoice requirements

### 3.1 What the law says

Rule 46 of the CGST Rules specifies the particulars a tax invoice must contain,
including supplier name, address, GSTIN, invoice number and date, recipient
details, HSN/SAC, description, quantity, taxable value, tax rate and amount,
place of supply, and signature.

**Primary source:** CGST Rules 2017, Rule 46.

### 3.2 How this affects BizPilot

The Invoice Engine V2 captures most required particulars. Gaps:

| Requirement | BizPilot status |
|---|---|
| Supplier name, address, GSTIN | ✅ In `businesses` |
| Invoice number, date | ✅ |
| Recipient name, address, GSTIN | ✅ In `customer_snapshot` |
| HSN/SAC | ✅ Optional per line |
| Quantity, unit | ✅ |
| Taxable value, rate, amount | ✅ |
| Place of supply | ✅ `place_of_supply_state_code` |
| Signature | ❌ Not implemented |

**PROFESSIONAL REVIEW REQUIRED:** whether a digital signature or a printed
signature image is required for BizPilot's invoices.

---

## 4. RBI — Payment Aggregator and Payment Gateway framework

### 4.1 What the framework says

The RBI's "Guidelines on Regulation of Payment Aggregators and Payment
Gateways" (as updated) establish:

- **Payment Aggregators (PA)** handle funds and require RBI authorisation
- **Payment Gateways (PG)** provide the technical infrastructure only and do
  **not** handle funds
- Entities handling funds without authorisation are non-compliant

**Primary source:** RBI — <https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12178>

### 4.2 How this affects BizPilot

| BizPilot design | Regulatory position |
|---|---|
| BizPilot holds buyer funds in its own account | **Would require PA authorisation** — do not do this |
| BizPilot uses an RBI-authorised PA with split settlement | Compliant path |
| BizPilot uses a PG only, supplier has own merchant account | Compliant path |

### 4.3 Architectural consequence

**BizPilot must integrate with an RBI-authorised payment aggregator** that
supports marketplace split settlement. BizPilot must never hold, pool or route
funds on behalf of sellers.

The payment provider must be **replaceable** — no provider name in business
logic. See `B2B_ARCHITECTURE.md` §7.2.

**PROFESSIONAL REVIEW REQUIRED:**
1. Which aggregators currently offer marketplace split settlement to platforms
   of BizPilot's size?
2. What onboarding/KYC does the aggregator require for each supplier?
3. Who is the merchant of record for GST purposes?

---

## 5. RBI — Card tokenisation

### 5.1 What the rules say

The RBI has mandated that merchants and payment aggregators **must not store
actual card data** (PAN, CVV, expiry). Only **card-on-file tokens** issued by
the card networks may be stored.

**Primary source:** RBI circulars on card tokenisation (2021–2022).

### 5.2 How this affects BizPilot

This confirms the hard constraint already in the architecture:

**BizPilot will never collect, transmit or store raw card data.**

- No PAN input field in BizPilot's UI
- No CVV field
- No card number in any request to BizPilot's backend
- Card payment uses the provider's **hosted checkout** or **tokenised component**
- BizPilot stores only: provider payment id, masked card, network, status

The database schema in `B2B_DATABASE_DESIGN.md` §4.13 reflects this — there is
no column for card data, and there must never be one.

---

## 6. DPDP Act — data protection

### 6.1 What the Act says

The Digital Personal Data Protection Act 2023 (and Rules as notified) establishes
obligations for processing digital personal data, including:

- Lawful purpose and consent
- Data minimisation
- Purpose limitation
- Storage limitation
- Security safeguards
- Breach notification
- Rights of the Data Principal

**Primary source:** MeitY — <https://www.meity.gov.in/>

### 6.2 How this affects BizPilot

| Requirement | BizPilot implication |
|---|---|
| Data minimisation | Do not collect personal data that is not needed. Business contact details should be business-level, not personal. |
| Purpose limitation | Analytics data must not be repurposed |
| Consent | Public-site analytics may require consent |
| Security | RLS, encryption in transit, no secrets in the bundle |
| Breach notification | Incident response procedure required |

### 6.3 Architectural consequence

- Analytics must be **first-party** and privacy-respecting
- No third-party trackers on authenticated pages
- IP addresses hashed, not stored raw
- Personal contact details exposed only after an authorised connection

**PROFESSIONAL REVIEW REQUIRED:** whether BizPilot is a Data Fiduciary, a Data
Processor, or both, and what consent mechanism is required for the public site.

---

## 7. Business verification

### 7.1 What is NOT verification

A GSTIN that matches a regex is **format-valid**, not verified. The current
schema check:

```sql
gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'
```

proves only that the string is well-formed.

### 7.2 What verification requires

Either:
1. **Manual review** — document upload plus a human reviewer, or
2. **Authorised API check** — a GSTIN verification service that confirms the
   GSTIN is active and belongs to the claimed business

### 7.3 Architectural consequence

The `business_verifications` table stores `gstin_check_result` as **evidence**,
not as a verification claim. Only `status = 'verified'` set by an authorised
reviewer means verified.

The UI must say **"GSTIN format valid — not verified"** until review completes.

**PROFESSIONAL REVIEW REQUIRED:** which GSTIN verification providers are
authorised, and what their terms permit.

---

## 8. Summary of required professional reviews

| # | Question | Blocks |
|---|---|---|
| 1 | Is BizPilot an ECO under GST? | Payment architecture, TCS |
| 2 | What TCS rate/threshold applies? | Settlement calculations |
| 3 | Bill of Supply particulars | Composition-scheme support |
| 4 | Signature requirement on invoices | Invoice output |
| 5 | Which PA offers marketplace split settlement? | Payment integration |
| 6 | Who is merchant of record? | GST invoicing |
| 7 | DPDP: fiduciary or processor? | Privacy implementation |
| 8 | Authorised GSTIN verification providers | Verification workflow |

**None of these can be answered by software.** They require a qualified
professional reviewing BizPilot's actual fund flow and business model.

---

## 9. What BizPilot will NOT do without clearance

- Hold buyer funds
- Operate a wallet or escrow
- Pool seller funds
- Store card data
- Claim GST compliance
- Claim GSTIN verification from a regex
- Issue tax invoices for composition taxpayers
- Act as merchant of record without legal review

Each of these is a regulatory exposure, not a feature gap.
