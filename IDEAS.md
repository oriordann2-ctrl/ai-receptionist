# Sprimal — Product Ideas & Backlog

> Maintained across sessions. Add ideas here as they come up.
> Last updated: 2026-06-11

---

## 📊 Retrieval Telemetry — Log Similarity Scores Per Query

**Why:** We tried raising the vector similarity threshold from 0.30 → 0.42 based on research recommendations, but it broke retrieval for valid documents that were scoring 0.30–0.41. We had no data on what scores real answers actually produce, so the change was blind.

**What to build:** Log every retrieval event to a `retrieval_events` table:
```
{ conversation_id, tenant_id, query, expanded_queries,
  chunks_returned, similarity_scores[], answer_source, timestamp }
```

**What this unlocks:**
- See the actual score distribution for real queries vs noise
- Set the threshold at the natural gap between good hits and bad hits (data-driven, not guesswork)
- Measure whether query expansion / BM25 hybrid search is actually improving recall
- Identify tenants whose KB is thin or poorly matched to how users ask questions
- Run RAGAS-style evaluation: correct answer rate before/after any retrieval change

**Current state:** No chunk-level telemetry. Only `answerSource` ("kb" / "generic") is logged.

**Implementation:** Non-blocking background insert in `findRelevantKnowledgeChunks` after returning results — don't await it, so it never adds latency to the chat response.

**Do this before:** Any future attempt to raise the similarity threshold above 0.30.

---

## 🔊 Alexa Skill per Tenant (with Cloned Voice)

**What:** On signup, automatically provision an Alexa skill for the tenant. They add it to their own Alexa device (home, club reception, bar). Alexa answers questions using the same knowledge base — in the chairman's cloned voice (via ElevenLabs, see voice idea below).

**How it works:**
- Alexa Skill receives spoken query → hits Sprimal backend (same `/chat` endpoint + same KB)
- Response text → ElevenLabs TTS using tenant's cloned voice_id → audio returned to Alexa
- Alexa speaks the answer in the chairman's voice through the device

**The scenario:**
- Kinsale GAA installs an Echo Dot in the clubhouse reception
- Member walks in: *"Alexa, ask Kinsale GAA when is the next match?"*
- Alexa (in the chairman's voice): *"The next match is Saturday at 2pm, away to Nemo Rangers..."*
- Or at home: *"Alexa, ask Cosy Café what time do you close on Saturday?"*

**Tenant experience:**
- Portal: "Your Alexa Skill is ready — click here to add it to your device"
- One-click skill enablement via Alexa app deep link
- No technical knowledge required from the tenant

**Technical path:**
- Alexa Skills Kit (ASK) — custom skill with a single catch-all intent that passes the full utterance to Sprimal
- Alexa-hosted skill OR self-hosted (Lambda or existing Express server via ngrok/public endpoint)
- Alexa's built-in TTS replaced with ElevenLabs audio (return MP3 URL in SSML `<audio src="...">`)
- Each tenant gets their own skill (or one shared skill with tenant routing via account linking)

**Shared skill vs per-tenant skill:**
- Per-tenant: cleaner UX, but Alexa approval process per skill (slow)
- Shared skill: one approval, tenant identified via Alexa account linking — much faster to ship

**Why it's interesting:**
- Businesses with physical premises (café, club, hotel) can put an Echo Dot on the counter
- Completely hands-free for customers
- Hearing a familiar local voice through Alexa is memorable and on-brand
- Pairs perfectly with the voice cloning idea — same voice_id, different channel
- No app to download, no website to visit — just talk

**Status:** Idea only. Depends on ElevenLabs voice cloning being in place first.

**Next steps when ready:**
- Register as Alexa Developer, create one shared custom skill
- Catch-all intent → POST to `/chat` with tenant_id from account linking
- SSML audio response using ElevenLabs MP3
- Portal UI: "Enable your Alexa skill" button with deep link

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

### 💰 Voice Cost Analysis

**ElevenLabs charges per character of text spoken.** A typical response (~100 chars) costs fractions of a cent — but it adds up across tenants.

| ElevenLabs Plan | Cost | Characters/month | ~Responses |
|---|---|---|---|
| Free | €0 | 10,000 | ~100 |
| Starter | €5/month | 30,000 | ~300 |
| Creator | €22/month | 100,000 | ~1,000 |

A small café with 50 calls/month × 4 exchanges × ~100 chars = ~20,000 chars → fits **free tier**. Most small tenants are cheap to serve.

**TTS provider comparison (cheapest to most expensive):**

| Provider | Cost | Voice Cloning | Notes |
|---|---|---|---|
| Google Cloud TTS | €0.004/1M chars | ❌ | Cheapest, good quality |
| OpenAI TTS | €0.015/1M chars | ❌ | Already in stack — easiest to add |
| PlayHT | ~€0.004/1M chars | ✅ | Good cloning, competitive |
| Cartesia | Competitive | ✅ | Very fast, excellent quality |
| ElevenLabs | ~€0.03/1M chars | ✅ Best | Best cloning quality, priciest |

**Realistic all-in cost per 3-minute call:**
- Twilio voice: ~€0.04
- Deepgram STT: ~€0.01
- OpenAI GPT response: ~€0.02
- TTS (OpenAI, no cloning): ~€0.002
- **Total: ~€0.07/call**

50 calls/month = ~€3.50 in API costs. Charge €15/month for voice add-on = **€11.50 margin per tenant**.

**Recommended phased approach:**
1. **Phase 1 — launch cheaply:** Use OpenAI TTS (already in stack, no cloning). Prove the channel works. Cost is negligible.
2. **Phase 2 — premium upsell:** Add ElevenLabs cloned voice at €15–20/month add-on. Covers API cost + margin.
3. **Cost saver at any phase:** Pre-cache audio for the 5–10 most common responses (hours, location, booking). Generated once, served as static MP3 every time. Cuts TTS bill by ~70–80%.

**Key rule:** Voice is a **paid add-on from day one** — never bundled free. The cloned voice ("chairman's voice") is the premium upsell on top of that.

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

## 🔄 Re-import: Website Disappears During Crawl

**Bug / UX issue:** When a tenant clicks Re-import, the old website documents are deleted immediately before the crawl begins. This means the website disappears from the Knowledge Base uploads list for the full 2–3 minutes of the crawl, which looks broken to the tenant.

**Fix:** Don't delete the old documents until the new crawl has completed successfully. Swap old for new atomically — insert new docs first, then delete old ones. Or keep old docs visible (read-only / greyed out) during the crawl and replace them when done.

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
