# Sprimal — Product Ideas & Backlog

> Maintained across sessions. Add ideas here as they come up.
> Last updated: 2026-06-10

---

## 📞 AI Voice Receptionist (Phone Number + ElevenLabs)

**What:** Surface a dedicated phone number to the tenant at signup. When a customer calls it, the AI answers and handles the same journey as the chat widget — same knowledge base, same flows, same personality.

**How it works:**
- Provision a local phone number during signup (Twilio — already partially set up)
- Inbound call → Twilio webhook → server → same workflow engine as chat
- Speech-to-text (Twilio / Deepgram) converts caller speech to text
- Existing AI chat logic handles the response
- Text-to-speech (ElevenLabs) speaks the response back to the caller

**The ElevenLabs voice cloning angle (big differentiator):**
- In the portal, tenant can record a short voice sample (2–5 min)
- OR upload an audio file of whoever they want (e.g. a committee member, the owner)
- ElevenLabs clones the voice → stores the `voice_id` against the tenant
- Every call now answers in *that person's* voice
- Example: Kinsale GAA — chairman records his voice, every caller hears him answer

**Portal integration:**
- "Voice Settings" section in portal
- Record directly in browser (MediaRecorder API) or upload MP3/WAV
- Preview button — play back a sample in the cloned voice
- "Active voice" selector if they want to switch between multiple clones

**Tiers / pricing angle:**
- Basic: generic AI voice (free / included)
- Pro: 1 custom cloned voice (e.g. €X/month)
- Premium: multiple voice profiles (e.g. different voices for different departments)

**Why it's powerful:**
- Small businesses often miss calls — this never misses one
- The voice sounds like *them*, not a robot
- Same knowledge base means consistent answers across chat + phone
- Club scenario: callers hear the chairman's voice even at 2am

**Status:** Idea only. Twilio already partially integrated (blocked on CRO/regulatory bundle). ElevenLabs not yet integrated.

**Next steps when ready:**
- Twilio Voice webhook (separate from SMS)
- Deepgram or Twilio built-in STT for real-time transcription
- ElevenLabs `/voices/add` API for voice cloning
- Store `elevenlabs_voice_id` on tenant record in Supabase
- Portal UI: record / upload / preview voice

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
