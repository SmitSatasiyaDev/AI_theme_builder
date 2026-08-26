# Debutify v9 — Roadmap

**Internal · Product Roadmap · Draft 01**

v8 sells access to widgets. v9 sells **traffic you can measure and improve** — a hosted builder that
publishes into Shopify, where every block reports its own performance and the bill is computed from
tracked sessions. This is a business-model change wearing a version number.

| Locked decision | |
|---|---|
| Billing meter | Tracked sessions per month |
| Architecture | Debutify-hosted builder → Shopify |
| Window | 6 months · 12 sprints |
| Team | 5–10 people · 4 squads |

---

## 01 — The shift

The hard part of v9 isn't the builder. It's that the thing you charge for stops being a countable
inventory of widgets and becomes a live measurement of someone else's business.

| Dimension | v8 today | v9 |
|---|---|---|
| Product | A theme with 145 toggleable add-ons | A builder that composes stores from measured blocks |
| Where merchants work | Shopify theme customizer | Debutify canvas, publishing into Shopify |
| Unit of value | Access to features | Traffic measured, tested, improved |
| Price ladder | 26 / 55 / 96 / 145 widgets | 10k / 50k / 250k / 1M sessions |
| Upgrade trigger | "I need the upsell popup" | "My store grew" |
| Feature gating | Heavy — it *is* the model | Almost none |
| Runtime | A script injected per add-on | One budgeted bundle |
| Data | None | First-party events on every block |

### The consequence nobody will like

**All 145 add-ons become free.** You cannot sell "we measure and improve your store" while hiding the
improvement tools behind four tiers. Widget count stops being the product and becomes the raw
material. Every upgrade conversation moves from "buy the popup" to "you outgrew your session bucket"
— which is a conversation the merchant can't argue with and doesn't resent.

Three second-order effects follow, and each becomes a workstream later in this document:

- Gating disappears, so **the section library has to be genuinely good** rather than artificially rationed.
- Billing depends on measurement, so **the analytics pipeline becomes a financial system** and inherits a financial system's accuracy bar.
- The meter runs on storefront traffic, so **runtime weight is now a revenue risk** — not merely the Core Web Vitals complaint v8 already attracts.

---

## 02 — Pricing model

Sessions, not pageviews: merchants already read sessions in their Shopify dashboard, so the number is
familiar and checkable. The prices below are proposals to validate against real install-base data in
M0 — the shape is right, the boundaries are hypotheses.

| Plan | Sessions / mo | List | Launch | Overage / 1k | At the cap |
|---|---:|---:|---:|---:|---|
| Free | 1,000 | $0 | $0 | — | Sampling, never a shutdown |
| Starter | 10,000 | $39 | $19 | $3.00 | Notify → auto-upgrade |
| Growth | 50,000 | $99 | $49 | $2.00 | Notify → auto-upgrade |
| Scale | 250,000 | $249 | $129 | $1.00 | Notify → auto-upgrade |
| Pro | 1,000,000 | $599 | $299 | $0.50 | Notify → auto-upgrade |
| Enterprise | Custom | — | — | Negotiated | Contracted |

### Six rules the meter must obey

1. **Never break a storefront.** Exceeding a cap triggers a notice and a grace period, then an auto-upgrade. A merchant whose store went down over billing tells that story publicly for years.
2. **Bill only what you tracked.** Consent-declined and modelled sessions are never billable, even where they're useful for analytics.
3. **Reconcile against Shopify monthly.** If your number and theirs diverge by more than 3%, bill the lower one and open an incident. Trust compounds faster than margin.
4. **Publish the definition.** A session is a visitor's activity window closing after 30 minutes of inactivity, reset at the UTC day boundary. Put it in the docs, not the contract.
5. **Annual is two months free.** Retire the permanent struck-through discount. It works at $15.60; at $299 it reads as untrustworthy.
6. **Shadow the meter for 60 days** before a single charge is raised against it.

### What still gets gated

A short list, each item defensible on cost or genuine enterprise need, none of it blocking the core
loop of build → measure → improve:

- Concurrent experiments — 1 / 3 / unlimited
- Data retention — 3 / 12 / 24 months
- Raw event export and warehouse sync — Scale and above
- Team seats, roles, SSO — Pro and above
- Priority and development support — Pro and above, *and fix it properly; support is the single most common complaint about v8 today*

### ⚠ Model this before you commit

Most of the 700k install base is tiny. Under v9 a hobbyist doing 400 sessions a month pays **$0**
where they might have been paying $15.60. Revenue concentrates onto real merchants, which is
healthier, but the transition can dip hard before it climbs. The session distribution across the
install base is the first number you need, and every boundary in the table above stays provisional
until you have it.

---

## 03 — What gets built: ten systems

This is the honest scope of "v9". The version number hides roughly nine-tenths of a rebuild.

| # | System | What it is | Status |
|---|---|---|---|
| 1 | **Document model** | Canonical, versioned JSON schema for pages, sections, blocks and bindings. Everything depends on it, so it is the first thing designed and the last thing you can change cheaply. | New |
| 2 | **Builder canvas** | Drag-and-drop editing, inspector, responsive breakpoints, undo/redo, drafts and version history. The product merchants actually see. | New |
| 3 | **Compiler & publish** | Document JSON compiled to Liquid sections, JSON templates and theme app extension assets, pushed through the Shopify Theme API. Idempotent, reversible in one click. | New |
| 4 | **Runtime SDK** | Under 8 KB gzipped, served first-party, consent-aware, emitting impression / interaction / conversion events per block with zero layout shift. | Replaces injection |
| 5 | **Ingest pipeline** | Edge collector, stream, columnar store, pre-computed rollups. Cost per session is a design input from day one, not a bill you discover in month nine. | New |
| 6 | **Metering service** | The billable-session ledger: idempotent, replayable, auditable per store per day. Build it like an accounting system, because that is what it is. | Meter |
| 7 | **Billing** | Shopify Billing API — app subscriptions plus usage records. Merchant-approved caps and cap-reached behaviour get designed in M4, not discovered in M6. | Meter |
| 8 | **Analytics UI** | Store overview, per-section performance, a basic funnel, and a usage page that doubles as the upgrade surface. | New |
| 9 | **Section library** | v8 add-ons re-authored against the new schema. Thirty for beta, chosen by usage data, then a steady port cadence. | Ported |
| 10 | **Migration service** | Reads v8 theme settings and generates a v9 draft document. Never auto-publishes — the merchant reviews and presses the button. | New |

### Non-negotiable constraint

One bundle, one hard performance budget, enforced in CI. v8 injects a script per enabled add-on,
which is exactly why reviewers report mobile Core Web Vitals collapsing as merchants switch things
on. v9 is the one chance to fix that — and under session-metered pricing a slow storefront becomes
*your* revenue problem as well as theirs.

---

## 04 — Six months, phase by phase

Twelve two-week sprints, preceded by a two-week discovery that gates everything after it. Each phase
carries an exit criterion — an observable fact, not a feeling. When a gate fails, scope gets cut, not
the date.

### M0 · Discovery — weeks −2 to 0 · **blocking gate**

- Instrument v8 to report add-on enablement and session volume per store. You cannot pick 30 sections out of 145 without knowing what merchants actually switch on.
- Build the session-distribution model across the install base, and test the proposed tier boundaries against it.
- Cost-model ingest and storage at 100M and 1B events per month. Establish cost per 1,000 sessions.

> **Exit** — Pricing survives contact with the real session distribution, and cost per session sits under 15% of price per session at every tier.

### M1 · Foundations — sprints 1–2

- Document schema v1 and the section authoring DSL, both agreed by RFC before any code.
- Event taxonomy v1, fixed and versioned — renaming events later invalidates history.
- Ingest spine and columnar store standing up under synthetic load at 100M events/day.
- Runtime SDK skeleton with the performance budget wired into CI on day one.
- Canvas shell rendering a hardcoded document.

> **Exit** — One real event travels browser → dashboard query, and the canvas renders a document from the schema.

### M2 · Builder alpha — sprints 3–4

- Drag and drop, inspector controls, breakpoints, undo/redo.
- Compiler emits Liquid; publishing to a development store works; rollback works.
- First eight sections authored in the new schema.

> **Exit** — The team builds and publishes a complete, real storefront from the canvas, with no hand-written Liquid.

### M3 · Measurement — sprints 5–6

- SDK emits block-level events from published stores in the wild.
- Session definition locked, with a harness reconciling continuously against Shopify Analytics.
- Metering service runs in **shadow mode** — it computes bills and charges nothing.
- Store overview dashboard ships.

> **Exit** — Thirty consecutive days of shadow metering land within 3% of Shopify's own session count.

### M4 · Money and library — sprints 7–8

- Shopify Billing integration: plans, upgrades, downgrades, overage, merchant-approved caps, and a designed cap-reached experience.
- Per-section performance analytics — the feature that makes the whole pitch credible.
- Sections 9 through 30 ported; the port factory running at a measured cadence.
- v8 → v9 migration draft generator.

> **Exit** — A test store can subscribe, exceed its bucket, auto-upgrade, downgrade and cancel — with a correct invoice at every step.

### M5 · Private beta — sprints 9–10

- 75–100 hand-picked merchants, spread deliberately across every session band.
- Real billing switched on, backed by a written commitment to refund any metering error.
- Reconciliation drift held under 2%.
- Support playbook, documentation, and the published session definition.

> **Exit** — Twenty stores publishing weekly, and no billing dispute open longer than 48 hours.

### M6 · Public beta — sprints 11–12

- v9 opens publicly with pricing live.
- Section Experiments in beta — a single A/B variant on one section, manual allocation, no multivariate.
- v8 continues to be fully supported and sold throughout.

> **Exit** — Launch.

---

## 05 — Not in v9.0: the cut list

Agreed in advance, so that cutting isn't a negotiation at month five. Everything here is deferred
rather than cancelled, and each item has a rough home.

| Cut | Where it lands |
|---|---|
| All 145 sections ported | ~30 at launch |
| Full experimentation engine, multivariate, auto-allocation | v9.1 |
| Heatmaps and session replay | v9.2 |
| Headless / Hydrogen storefronts | Not before v10 |
| AI Store Builder inside the v9 canvas | Stays on v8 |
| Unified data across Reviews and PredictaMail | v9.2 |
| Agency and multi-store workspaces | v9.1 |
| Multi-region data residency | Enterprise demand only |
| Migrating the existing 700k stores | Opt-in only |

**Why v8 stays alive.** v8 keeps selling and keeps getting bug fixes and Shopify compatibility
updates — but **zero new sections from M1 onward**. Running two products with eight people only works
when one of them is explicitly in maintenance.

---

## 06 — Team shape: four squads

Sized at eight people. Squad names double as ticket prefixes and labels throughout.

| Squad | Headcount | Owns |
|---|---|---|
| **Canvas** | 3 engineers | Document model, builder UI, compiler, publish and rollback. Owns the thing merchants touch. |
| **Signal** | 2 engineers | Runtime SDK, ingest, storage, metering ledger. Owns the number the invoice is built from. |
| **Meter** | 1 engineer + PM | Billing integration, plans, pricing operations, migration tooling, beta merchant relationships. |
| **Library** | 1 engineer + 1 designer | Section ports, design system, niche templates. The only squad with a forecastable velocity. |

### ⚠ Where this breaks

**Signal is the critical path and it is understaffed at two people.** It owns the SDK, the pipeline
and the ledger — three systems, any one of which can sink the launch, and one of which is a financial
system. If headcount moves from 8 to 10, both hires belong here. If the timeline slips, this is where
it slips from.

---

## 07 — Making tasks

Four levels, one ticket template, and a factory pattern for the repetitive two-thirds of the work.
The test is that a stranger can pick up any ticket and know what "done" means.

### Hierarchy

**Initiative → Epic → Story → Task**

- An **Epic** fits inside one sprint for one squad; if it doesn't, it's an Initiative wearing the wrong hat.
- A **Story** is written from the merchant's side and is demoable — *"merchant can undo the last canvas change"*, never *"implement undo stack"*.
- A **Task** is a day or less. When you can't estimate it, the first task is a timeboxed spike.

### The ticket template

```
DEB9-<squad>-<n>  <Story title — merchant-side, active voice>

Context       Why now, and what breaks if we skip it.
Scope         What is in.
Out of scope  What is explicitly not, so review doesn't creep.
Acceptance    Given / When / Then — one per behaviour.
Telemetry     Events this must emit.                     ← mandatory
Perf budget   KB added to runtime, ms added to publish.  ← mandatory
Rollback      How this gets turned off in production.
Exit          The observable proof it works.
```

**The two fields that change the culture.** `Telemetry` and `Perf budget` did not exist in v8
tickets. In v9, a feature that emits no events is a feature you can neither bill for nor improve, and
every kilobyte added to the runtime is a Core Web Vitals regression against a product already
criticised for exactly that. A ticket with either field empty does not enter a sprint.

### The section-port factory

Roughly 145 sections eventually, 30 for beta. Nobody hand-writes those tickets. Define one Epic
template and instantiate it per section — the same seven subtasks, every time:

```
EPIC  Port <Section Name> to v9
  1  Schema      Block schema and defaults
  2  Canvas      Inspector controls and canvas render
  3  Compile     Liquid output and JSON template
  4  Runtime     Impression / interaction / conversion events
  5  Responsive  Breakpoint behaviour and accessibility pass
  6  Migrate     v8 settings → v9 block mapper
  7  QA          Visual regression and perf budget check
```

After the first three sections the estimate stops being a guess and becomes an average. Track
**sections per sprint** as the Library squad's single velocity number — it's the only genuinely
forecastable quantity in this plan, which makes it the one to report upward.

### Choosing which 30

Score every candidate:

```
(v8 enablement rate × revenue proximity) ÷ port cost
```

Revenue proximity means how close a section sits to the cart — upsells, bundles, sticky add-to-cart
and cart goals score high; decorative layout sections score low no matter how pretty they are. The
enablement rate comes from M0 telemetry, and without that data this whole exercise is opinion.

### Cadence

- Two-week sprints. Monday planning, 60 minutes. Friday demo, 30 minutes, always against a real store.
- **Weekly meter review**, 20 minutes, from M3 onward — shadow-billing drift against Shopify, every single week. This is the ritual that keeps the business model honest.
- Monthly phase gate: criteria met, or scope is cut. The date does not move.

### Labels

```
squad:canvas · squad:signal · squad:meter · squad:library
phase:m0–m6 · type:spike|story|bug · risk:high · cut-candidate
```

`cut-candidate` gets applied at creation, not in a panic. Anything carrying it can be dropped at a
phase gate without a meeting.

---

## 08 — Risks, ranked

| # | Risk | Mitigation | Owner |
|---|---|---|---|
| 1 | **Analytics unit economics** | If cost per session approaches price per session, the model inverts at exactly the scale you were aiming for. Cost model in M0, rollups rather than raw retention, sampling above 1M sessions. | Signal |
| 2 | **Long-tail revenue dip** | Most of 700k stores would pay $0. Session-distribution model in M0, a price floor, and v8 kept on sale through the transition. | Meter |
| 3 | **Metering disputes** | Merchants will compare against Shopify's number. Reconcile monthly, bill the lower figure, publish the definition, shadow for 60 days before charging. | Meter |
| 4 | **Undercounting** | Ad blockers and declined consent mean you bill less than reality and your analytics quietly lie. First-party subdomain, server-side collection, modelled sessions shown but never billed. | Signal |
| 5 | **Shopify billing constraints** | Usage charges need a merchant-approved cap, and reaching it must never disable a storefront. Design the cap-reached path in M4. | Meter |
| 6 | **Runtime weight regression** | Already the product's reputational weak point. Hard budget in CI, one bundle, no per-widget injection. Non-negotiable. | Canvas + Signal |
| 7 | **Scope versus six months** | The plan is already at its edge. Monthly gates cut scope, never the date; the cut list is pre-agreed. | PM |
| 8 | **Two products at once** | v8 keeps earning and needs support while v9 is built. Maintenance-only from M1: bugs and Shopify compatibility, no new sections. | PM |

---

## 09 — Week one: eight tickets to open Monday

Everything above depends on these. The first three return numbers that can invalidate the pricing
model, so they run first and they run in parallel.

| Ticket | Story | Squad |
|---|---|---|
| `DEB9-SIG-001` | Ship v8 telemetry: add-on enablement and session volume per store | Signal |
| `DEB9-MTR-001` | Session-distribution analysis across the install base | Meter |
| `DEB9-SIG-002` | Ingest cost model at 100M and 1B events per month | Signal |
| `DEB9-CAN-001` | Document schema v1 RFC | Canvas |
| `DEB9-SIG-003` | Event taxonomy v1 RFC | Signal |
| `DEB9-LIB-001` | Section scoring sheet and top-30 shortlist | Library |
| `DEB9-MTR-002` | Spike: Shopify Billing usage records, caps, cap-reached behaviour | Meter |
| `DEB9-CAN-002` | Runtime performance budget and CI gate | Canvas |

**Gate.** Nothing in M1 begins until `SIG-001`, `MTR-001` and `SIG-002` come back with numbers. If
the session distribution says the tier boundaries are wrong, redrawing them in week two costs almost
nothing; redrawing them in month five costs the launch.

---

## Appendix — v8 reference data

Gathered from debutify.com, August 2026. Basis for the comparisons above.

### Current v8 pricing

| Plan | Advertised | "Regular" | Widgets | AI generations/mo | "Replaces" |
|---|---|---|---|---|---|
| Free | $0 | — | 26 | 0 | — |
| Growth | $15.60/mo | $39.00 | 55 | 1 | $75+/mo in apps |
| Professional | $35.60/mo | $89.00 | 96 | 5 | $100+/mo in apps |
| Enterprise | $63.60/mo | $159.00 | 145 | 8 | $250+/mo in apps |
| Lifetime | $399 once | $999 | 145 | 10 | — |

Plus 40% off annual billing and a 3-day trial on subscription tiers.

### The v8 gating mechanic

Tiers are cumulative, disjoint blocks of a 145-item catalog (83 widgets + 62 sections):

```
Free      26  ──┐
Growth   +29  ──┼─→ 55   ("29 growth-exclusive + 26 free")
Pro      +41  ──┼─→ 96   ("70 pro-exclusive + 26 free")
Ent      +49  ──┴─→ 145  ("access all 145")
```

Gating is by **proximity to revenue**, not complexity:

- **Free** — table stakes and compliance. Breadcrumbs, Cookie Box, Trust Badge, Collection Filters, Announcement Bar, Newsletter, Slideshow. Nothing that makes money.
- **Growth** — AOV and urgency basics. Sticky Add to Cart, Cart Upsell, Cart Goal, Cart Reminder, Back in Stock, Wishlist, Inventory Quantity. Also *Remove Debutify Branding* — a paid widget that doubles as a viral distribution loop.
- **Professional** — conversion psychology. Upsell Popup, Upsell Bundles, Quantity Breaks, Sale Popup Notification, Cart Countdown Timer, Mega Menu, Smart Search, Size Chart, Star Rating.
- **Enterprise** — long-tail and operational, plus most of the *visual* sections. Product Subscription, Shipping Calculator, Quick View, Quick Compare, Lookbook, Shoppable Image, UGC Carousel, TikTok Slider, Instagram Feed, Trustpilot Reviews.

Actual upgrade triggers are Growth → Pro (upsells, popups, mega menu) and branding removal.
Presentation-layer polish is pushed to the top tier where it pads the count.

### Portfolio and funnel

Products: Debutify Theme · AI Store Builder (beta) · Theme Sections · Debutify Reviews ·
PredictaMail · Syngulr · 7 free apps.

Funnel: free Shopify App Store apps → free theme tier with forced branding → AI Store Builder
(credit card required) → 18 niche demo templates as SEO landing pages → influencer/affiliate program
as the primary acquisition channel → comparison pages targeting 12 competitor themes.

### Known weaknesses in v8 (independent reviews)

1. **Support** — the #1 complaint. Email-only, IST business hours, slow; real support fenced behind Enterprise.
2. **Price resistance** — competitors sell yearly (Booster ~$249) or one-time (Prestige, Turbo). Debutify's subscription is perpetual rent.
3. **Performance degradation** — add-ons inject scripts; enabling many tanks mobile Core Web Vitals. The pricing incentive (buy more widgets) directly opposes the technical health of the store.
4. **Bugs** reported across versions.
5. **Free tier deliberately crippled** — no money-making widget at all, plus forced branding.

Items 1, 2 and 3 are all addressed structurally by the v9 model rather than by effort: support gets
funded by higher ARPU, price scales with the merchant's own growth, and the single-bundle runtime
removes the incentive conflict.
