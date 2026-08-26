# Debutify v9 — What Needs to Change

v9 changes what we sell: from **widget packs** to a **theme builder priced on store traffic**.
Because both the product and the pricing logic change, the builder needs work before it can go
public, and almost every page that mentions plans, widgets or data has to be reworked.

This is the list of that work.

---

## 1. Theme builder — functionality to add

The builder exists today and works, but it is still an internal tool. These are the gaps between
what it does now and what a paying merchant will expect on day one.

### Editing safety — *nothing exists here yet*

| Needed | Today |
|---|---|
| **Undo** | Not available. A change cannot be taken back. |
| **Redo** | Not available. |
| **Version history** | Not available. No restore points are saved before a change. |
| **Preview before applying** | Not available. Changes are written into the theme immediately. |

This is the highest-priority group. Merchants will not trust an editor they cannot undo.

### Editing controls

| Needed | Today |
|---|---|
| **Move / reorder sections** | Not possible. Sections can only be added or removed, so reordering means rebuilding the section and losing its settings. |
| **Duplicate a section** | Not possible. |
| **Redesign the whole page in one go** | Not supported. Only one part can be changed at a time. |
| **Multiple changes per instruction** | Limited to 3 changes per request. |

### Coverage — **decided: all sections at launch**

| Needed | Today |
|---|---|
| **All sections editable** | Only **27 of the theme's 86 sections** are available to the builder. **59 sections still to be added.** |
| **All blocks editable** | **44 blocks still to be added.** |
| **All page types** | Only the **home page** and **product page** are supported. Collection, blog, article, cart, search, contact and FAQ pages are not — even though the theme already has them. |

**What the 59 missing sections look like.** They are not equal in size, and this matters for
planning:

| Group | Count | Examples | Effort |
|---|---|---|---|
| **Large design sections** | 29 | Cart Drawer, Timeline, Multicolumn, Trustpilot Reviews, Collection List, Product Features, Featured Product, Pricing Table, TikTok Videos, Instagram Stories, Header, Slideshow Hero | Heavy. Around **2,600 individual settings** to describe across this group. Cart Drawer alone has ~400 and is a small project by itself. |
| **Small system sections** | 30 | 404, Login, Register, Reset Password, Addresses, Account, Order, Cart internals, Predictive Search, Pickup Availability | Light. Most have 0–3 settings. |

The second group is worth a separate decision. A merchant will never ask the builder to "redesign my
password page" — these sections only need to **exist and work**, not be generated or restyled by AI.
Treating them as "supported but not AI-generated" would remove about half the list at almost no cost
to the merchant experience.

The 29 large sections are the real work, and they are what merchants will actually use.

### Real store content

| Needed | Today |
|---|---|
| **Pick real products and collections** | Not connected. These fields are left blank to avoid wrong data. |
| **Images** | Image generation is built but not switched on. |

### Turning it into a product

This is the largest block of work and the real gate on launching.

| Needed | Today |
|---|---|
| **Visual interface** | None. The builder runs in a developer terminal with a text menu. |
| **Connection to Shopify** | None. It writes files to a local folder — it cannot publish to a live store. |
| **Accounts, saved projects, history** | None. Nothing is stored between sessions. |
| **Safe for many users at once** | Not yet. No login, no usage limits, no protection against two people editing at the same time. |

---

## 2. Website pages

| Page | What changes |
|---|---|
| **Home** | New positioning and headline. Stop leading with "145 widgets", start leading with "build and measure your store". New hero, new feature blocks, new CTA. |
| **Pricing** | Full rebuild. Plans move from widget counts to monthly session tiers. Needs a session calculator, a plan comparison, and a new FAQ. |
| **Theme** | Becomes the **Builder** page. New screenshots, new demo video, new feature list. |
| **Add-ons / Widgets** | All widgets become available on every plan, so all "Growth / Pro / Enterprise" badges come off. Page becomes a catalog, not a paywall. |
| **AI Store Builder** | Update to match the new builder and the new plan limits. |
| **Demo / Templates** | Rebuild the 18 niche demos in the new builder and re-shoot previews. |
| **Comparison** | Update competitor comparisons. We now compete on analytics and pricing model, not widget count. |
| **Free Apps** | Minor — align messaging and links with the new plans. |
| **Blog / Academy** | Audit old posts that mention widget tiers or old prices and update them. |
| **Changelog** | v9 announcement post and ongoing release notes. |

---

## 3. Legal pages — **new requirement, needs a lawyer**

This is the part that is easy to miss. From v9 we start collecting visitor data on our merchants'
storefronts, which changes our legal position. These cannot be copy-edits.

| Page | What changes |
|---|---|
| **Privacy Policy** | Must describe what visitor data we collect, why, how long we keep it, and who it is shared with. |
| **Cookie Policy** | Must cover tracking placed on merchant storefronts, not just on our own website. |
| **Terms of Use** | Must define a "session", explain overage charges, and set fair-use limits. |
| **Refund Policy** | Must cover billing and metering errors. |
| **Data Processing Agreement** | **New page.** We become a data processor for our merchants. Required for EU/UK merchants and for any serious brand. |

---

## 4. Customer communication

| Item | What changes |
|---|---|
| **Existing subscribers** | Decide and announce what happens to Growth / Professional / Enterprise customers when they move to v9. |
| **Lifetime plan holders** | Needs a clear decision and a careful message. They paid once for "all widgets forever" and the plan structure no longer works that way. |
| **Launch announcement** | Email, blog post, in-app banner and social. |
| **Billing emails** | New emails for approaching limit, limit reached, plan upgraded, invoice. |
| **Help Center** | Rewrite the articles that explain plans, widgets and billing. Add "how sessions are counted". |
| **Support team** | Brief and train the team before launch — most early questions will be about billing, not the builder. |

---

## 5. Other channels

| Item | What changes |
|---|---|
| **Shopify App Store listing** | New description, new screenshots, new pricing display. |
| **Affiliate / referral program** | Commission structure has to be recalculated against the new prices. |
| **Influencers and partners** | Re-brief everyone promoting v8 pricing so they stop quoting old numbers. |
| **Ads and landing pages** | Any campaign quoting old prices or widget counts must be paused or rewritten. |

---

## Suggested order

**First — builder foundations.** Visual interface, Shopify connection, accounts and saved projects.
Nothing else can be demonstrated or sold until these exist.

**Second — builder trust and control.** Undo, redo, version history, preview before applying, move
and duplicate sections.

**Third — builder coverage.** Remaining sections, then the other page types, then real products and
images.

**Before launch** — Legal pages, Pricing page, Home, Builder page, Help Center, support training.

**At launch** — Add-ons page, Demo templates, Shopify listing, announcement, billing emails.

**After launch** — Comparison page, blog and Academy audit, affiliate program, ad campaigns.

---

## Decisions needed from the business first

1. **What happens to existing paying customers** — do they move, stay on v8, or get a grandfathered price?
2. **What happens to Lifetime customers** — this affects both the legal wording and the announcement, so it cannot be decided late.
3. ~~How much of the theme must the builder cover at launch~~ — **decided: all sections.** All 86
   sections and all page types. One follow-up question remains: do the 30 small system sections
   (login, 404, account, cart internals) need to be AI-editable, or only working? Answering "only
   working" removes roughly half the remaining sections from the build.

Everything else on this list can start once these are answered.
