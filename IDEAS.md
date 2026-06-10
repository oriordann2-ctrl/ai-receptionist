# Sprimal — Product Ideas & Backlog

> Maintained across sessions. Add ideas here as they come up.
> Last updated: 2026-06-10

---

## 🌐 Auto-Generated Websites (post-crawl)

**What:** After crawling a small business website, automatically generate a modern replacement site with the Sprimal chat widget pre-embedded.

**How it works:**
- `extractGenericInfo()` already pulls name, address, phone, email, hours, logo URL
- Post-crawl: GPT fills one of the 4 design templates with that data
- HTML file written to `public/{tenant-slug}.html` → instantly live at `app.sprimal.com/{tenant-slug}`
- Zero extra hosting cost (static file on existing Render server)

**Hosting tiers:**
- Starter: `app.sprimal.com/businessname` (free)
- Pro: `businessname.sprimal.com` (subdomain via Cloudflare)
- Premium: client's own custom domain (they point DNS)

**Product pitch:** *"As part of your AI receptionist package, we'll give you a modern website — live within minutes of sign-up."*

**Status:** Design templates built (`cosy-cafe-designs.html`). Auto-generator not yet built.

**Next steps:**
- Build `generateTenantSite(tenantId)` function — runs post-crawl, writes themed HTML
- Add theme picker in client portal
- Add simple edit form (headline, about text, hero image URL)
- Publish button

---

## ⭐ Review Sub-Flow (done)

Google + TripAdvisor review buttons with logos, accessible from main menu. Implemented for Cosy Café. Needs to be wired into seed functions for other business types.

---

## 📊 Portal Leads View UI

Backend endpoint exists (`GET /api/portal/leads`) but no UI built. Clients can't see their leads from the portal.

---

## 📞 Twilio / SMS Channel

Blocked on CRO company registration and regulatory bundle. Revisit when registered.

---

## 🔗 Nathan Affiliate Tracking

`?ref=nathan` referral links, 15% commission. Not yet implemented.

---

## 💳 Monkstown Live Stripe Key

Switch Monkstown Tennis Club from test key to live Stripe key when ready.

---

## 🏗️ CRO Company Registration

Needed before Twilio regulatory bundle can be submitted.

---

## 💡 Future / Raw Ideas

- **Multi-location businesses** — single tenant, multiple branch locations, routing based on user's location
- **WhatsApp channel** — widget alternative for markets where WhatsApp is dominant
- **Booking integrations** — connect to Calendly, Acuity, or custom booking for tennis court / appointment slots
- **Review aggregation widget** — pull Google + TripAdvisor ratings live into the generated website
- **Onboarding wizard** — guided setup flow in portal (crawl → choose theme → publish → go live)
- **Weekly digest emails** — send client a summary of chat volume, common questions, leads captured
