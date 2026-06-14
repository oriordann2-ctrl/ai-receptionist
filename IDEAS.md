# Sprimal — Product Ideas & Backlog

> Maintained across sessions. Add ideas here as they come up.
> Last updated: 2026-06-14

---

## 🎯 Court Check-In & No-Show Accountability (High Priority)

**The problem:** Members book courts and don't show up, blocking other players with no consequences. No existing system tracks this.

**The solution:** QR code check-in per court, GPS-verified physical presence, cross-referenced against eBooking bookings.

**How it works:**
1. **Static QR code per court** — printed and laminated on the court post. Links to `app.sprimal.com/checkin/{tenant}/{court-id}`
2. **Check-in page** — member scans, enters name + email, browser requests GPS location
3. **GPS geofence** — if within ~50m of the club, check-in is allowed. If at home, blocked. Solves Nathan's static URL objection — physical presence is enforced by the phone's GPS
4. **eBooking cross-reference** — we already pull bookings from eBooking API. At check-in time, match the member's name against the booked names for that court + current time slot
5. **Captain dashboard** — real-time view, one tile per court:
   - 🟢 Green = all booked members checked in
   - 🔴 Red = booking exists but nobody checked in after 10 minutes
   - ⚪ Grey = no booking for this slot
6. **No-show log** — every missed check-in stored in Supabase with member name, court, date/time. Committee can see repeat offenders and enforce penalties

**Why this is a killer feature:**
- No other club management system in Ireland does this
- Zero hardware cost — QR code is a printed piece of paper, GPS is built into every phone
- No app download for members — just a browser page
- Creates real accountability — members know their no-shows are recorded
- Committee has hard data to back up a penalty policy
- Tangible, visible value that members notice every time they play

**Data stored per check-in:**
```
{ tenant_id, court_id, member_name, member_email, 
  checked_in_at, gps_lat, gps_lng, booking_matched (bool) }
```

**Nathan / eBooking:** Read-only API access already exists. Pull today's bookings per court per slot. No changes to eBooking needed.

**Status:** Idea. Ready to build — all dependencies already in Sprimal.

---

## 🔴 URGENT — JavaScript-Rendered Pages Not Crawled (Tomorrow)

**Problem:** The crawl uses a basic HTTP fetch which never runs JavaScript. Wix, React, and similar sites return an HTML shell (HTTP 200) with the real content injected by JS after load. The crawler sees the shell and thinks it succeeded — so Jina fallback never triggers. Committee names, officer lists, dynamic content — all missed silently.

**Proven impact:** Monkstown LTCC's "About Us - Committee" page was crawled but only returned 2 chunks of boilerplate. President, chairman, and all officer names are missing from the KB entirely. Maeve cannot answer "who is president?" because the data was never captured.

**Fix:** After fetching a page, check if the content is suspiciously thin (fewer than ~200 words after stripping HTML). If so, automatically retry that URL via Jina Reader, which uses a real headless browser and sees JS-rendered content.

**Workaround for tonight:** Manually upload a fact file in the Monkstown portal with officer names.

**Implementation:**
- In the crawl loop, after fetching and parsing a page, count words in extracted text
- If word count < 200 (or < some threshold), re-fetch via `r.jina.ai/{url}`
- Parse Jina's markdown response and use that content instead
- Log when Jina fallback fires so we can monitor how often it's needed

**Status:** 🔴 Urgent — affects every Wix/React tenant. Fix tomorrow.

---

## 🟢 Cosy Café Kinsale — Active Client Onboarding

Deal closed 2026-06-10 with Sebastien Perey. €300 on go-live + €49/month recurring.

### ✅ Done
- [x] Design theme chosen — The Local (forest green / terracotta)
- [x] Tenant created in Sprimal (cosy-cafe)
- [x] Website built — live at app.sprimal.com/sites/cosy-cafe
- [x] KB crawled + fact file uploaded + menus uploaded
- [x] Chat flows seeded (Menu, Hours, Find Us, Events, Reviews, Something Else)
- [x] Book a Table button — popup on desktop, dials on mobile
- [x] Google Review link fixed
- [x] KB retrieval fixed (all chunks in context)
- [x] Markdown rendering in chat (bold, bullets, links)
- [x] Maeve hedging fixed

### ⏳ Pending — Sebastian's actions
- [ ] Register **cosycafe.ie** on Blacknight.com (€5.99/yr)
- [ ] Send current menu with updated prices
- [ ] Confirm/send photos for website
- [ ] Send photo ID + CRO cert (for Wix cosycafe.net domain recovery)
- [ ] Point cosycafe.ie DNS to Sprimal once registered

### ⏳ Pending — Your actions
- [ ] Send Wix Sebastian's photo ID + CRO cert once received
- [ ] Contact Graft Marketing (graftmarketing.ie) re cosycafe.net domain
- [ ] Update menu on website once Sebastian sends current version
- [ ] Configure cosycafe.ie DNS and SSL once registered
- [ ] QA all chat flows on mobile and desktop

### 🚀 Go Live
- [ ] Sebastian sign-off
- [ ] Go live on cosycafe.ie
- [ ] Invoice €300
- [ ] Set up €49/month Stripe recurring subscription
- [ ] Portal walkthrough with Sebastian

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

## 🌐 Auto-Generated Websites — Social Media + Crawl at Signup

**What:** During signup, automatically generate a modern website for the tenant using:
1. **Knowledge crawl** — pulls name, address, phone, email, hours, logo from their existing website
2. **Social media images** — pulls real photos from their Instagram (and optionally Facebook/TikTok) so the generated site looks like *their* brand, not a placeholder template
3. **GPT fills the template** — combines both sources to produce a fully populated site
4. Hosted on Sprimal — live at `app.sprimal.com/{tenant-slug}` within minutes of signup

**Why this is powerful:**
- Tenant signs up → crawl runs → Instagram scraped → website generated → live in under 5 minutes
- No placeholder images, no "lorem ipsum" — it looks real from day one
- The pitch becomes: *"Give us your website URL and Instagram handle at signup. We'll have a new site live for you before the end of the call."*
- Cosy Café proved this works — their Instagram (@cosycafekinsale) had exactly the photos needed

**How it works:**
- Signup form takes: existing website URL + Instagram handle (optional)
- `extractGenericInfo()` already pulls name, address, phone, email, hours, logo URL
- Instagram scraper fetches the 6–9 most recent posts (public accounts, no auth needed via basic scrape)
- GPT selects the best images for hero, about, menu sections based on content
- Post-crawl: fills one of the 4 design templates with real data + real photos
- HTML file written to `public/{tenant-slug}.html` → instantly live

**Hosting tiers:**
- Starter: `app.sprimal.com/businessname` (free)
- Pro: `businessname.sprimal.com` (subdomain via Cloudflare)
- Premium: client's own custom domain (they point DNS)

**Status:** Design templates built (`cosy-cafe-designs.html`). Auto-generator not yet built. Instagram scraping not yet built.

**Next steps:**
- Build `generateTenantSite(tenantId)` function — runs post-crawl, writes themed HTML
- Add Instagram handle field to signup form
- Build `scrapeInstagramImages(handle)` — fetch recent public post images
- GPT image selector — pick best images for hero / about / menu slots
- Add theme picker in client portal
- Add simple edit form (headline, about text, swap images)
- Publish button

---

## 🔐 Portal Login Security — 2FA + Password Reset

**Issues:**
- No two-factor authentication on portal login — anyone with the password has full access
- No password reset flow — if a tenant forgets their password there's no self-service recovery

**What to build:**
- **2FA:** TOTP (Google Authenticator / Authy) via a library like `speakeasy`. On login, after email/password, prompt for 6-digit code. Store encrypted secret per tenant in Supabase.
- **Password reset:** "Forgot password?" link on login page → sends a time-limited reset token to their email → they set a new password. Standard flow via Supabase Auth or a custom token table.

**Priority:** Medium — no live clients self-serve yet, but needed before wider rollout.

---

## 📱 Sprimal Mobile App — Google Play & App Store

**What:** A native or PWA mobile app for tenants so they can manage their assistant from their phone. Check chat logs, see new leads, update KB, get notified when a lead comes in.

**Options:**
- **PWA (Progressive Web App)** — quickest to ship. Add a manifest + service worker to the portal. Tenants "install" it from Chrome. No app store approval needed.
- **React Native / Expo** — full native app, proper push notifications, App Store + Play Store listing. More work but more credible.

**Play Store / App Store listing** is a trust signal even if most usage is web — "Download the Sprimal app" on the marketing site looks professional.

**Priority:** PWA first (low effort, high value for tenant experience). Native app later.

---

## 📣 Marketing Strategy

**How to get more clients like Cosy Café:**
- Direct outreach to local businesses in Kinsale / Cork — personal intro works (proved today)
- Nathan affiliate programme (`?ref=nathan`) — 15% recurring, not yet built
- Sebastian referral programme — he knows every café/guesthouse in Kinsale
- Google Ads targeting "AI chatbot for small business Ireland" / "website for café Ireland"
- Content marketing — case study: "How Cosy Café went from no AI to 24/7 receptionist in 4 weeks"
- Local business Facebook groups / Cork business networks
- Partner with web designers who don't want to build AI features themselves

**Status:** No marketing built yet. Referral programme not yet implemented.

---

## 🤝 Cross-Tenant Agent Communication (Agent-to-Agent)

**The idea:** If agents are publicly exposed via an API, could one tenant's agent query another? For example:
- A "Kinsale Tourism" agent that knows about multiple local businesses
- Monkstown Tennis agent asks the Passage West agent about upcoming fixtures
- A "Cork GAA" umbrella agent that routes to individual club agents

**Why it's interesting:**
- Agents could form a network — "ask your local area agent" routes to the right specialist
- Federation model: one entry point, many knowledge bases
- A Kinsale agent could answer "where's a good café?" by querying the Cosy Café agent

**Questions to resolve:**
- Are tenant agents currently publicly exposed? (Check `/chat` endpoint auth)
- Should inter-agent calls be authenticated or open?
- Who pays for the tokens when Agent A queries Agent B?

**Status:** Raw idea. Worth exploring once multi-tenant is stable.

---

## ⭐ Review Sub-Flow (done)

Google + TripAdvisor review buttons with logos, accessible from main menu. Implemented for Cosy Café. Needs to be wired into seed functions for other business types.

---

## ✅ DONE — Admin Panel Password & Access Control

Password confirmed strong (already set as a secure env var in Render). No action needed.

---

## ✅ DONE — Widget Buttons Missing on First Load (Wix)

**Bug:** Race condition — widget opened before workflow fetch returned, showing greeting with no buttons. Closing the panel before the fetch returned meant the race condition handler (which checked `isOpen`) never fired. On re-open, `hasOpened` was true so no fresh-start logic ran.

**Fix:** Removed `isOpen` guard from the race condition handler. Handler now fires even when the panel is closed, so workflow state is ready when the user re-opens. Added a `.sprimal-user` querySelector guard to avoid wiping a real conversation.

---

## ✅ DONE — Portal Login: Wrong Credentials Auto-filled by Browser

Set `autocomplete="off"` on email field and `autocomplete="new-password"` on password field to suppress the eBooking credentials being auto-filled.

---

## 🔄 Re-import: Website Disappears During Crawl

**Bug / UX issue:** When a tenant clicks Re-import, the old website documents are deleted immediately before the crawl begins. This means the website disappears from the Knowledge Base uploads list for the full 2–3 minutes of the crawl, which looks broken to the tenant.

**Fix:** Don't delete the old documents until the new crawl has completed successfully. Swap old for new atomically — insert new docs first, then delete old ones. Or keep old docs visible (read-only / greyed out) during the crawl and replace them when done.

**Also affects:** Admin re-crawl button — same deletion-before-crawl issue, same blank state in portal during the crawl.

---

## ✅ DONE — Portal Leads View UI

Collapsible 🎯 Leads card added to portal dashboard. Lazy-loads from `/api/portal/leads`, shows Name / Email / Source / Date table with CSV download. Tested and working.

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

## 🔧 Admin — Editable Boilerplate Chat Flows per Business Type

**What:** Allow the admin to edit the default chat flows for each business type (café, tennis club, GAA club, restaurant, etc.) directly from the admin panel — without touching code.

**Why:** Currently boilerplate flows are hardcoded in seed functions in `index.js`. Every time you want to tweak a default flow for a business type you have to redeploy. An admin UI would let you update the template flows instantly, and every new tenant of that type gets the latest version.

**How it would work:**
- Admin panel gets a "Flow Templates" section
- Lists business types: Café · Tennis Club · GAA Club · Restaurant · etc.
- Each type has editable default flows (button labels, responses, sub-menus)
- When a new tenant is seeded/created, flows are generated from the current template, not hardcoded JS
- Option to "push updated template to all tenants of this type" (bulk update)

**Status:** Idea only. Flows currently hardcoded in seed functions.

---

## 🏐 GAA Club Logo Database (Cork + National)

**What:** gaacork.ie/clubs/ lists every Cork GAA club with their crests. The images lazy-load via JS so a basic crawl misses them — but a headless browser scrape would capture all ~200 club logos in one pass. Same pattern likely exists for every county board site.

**Why:** Every time a GAA club tenant is added, their logo has to be manually found and set. A pre-built lookup table of club name → crest URL would make onboarding instant.

**How:**
- Puppeteer/Playwright headless scrape of gaacork.ie/clubs/ → extract all club names + crest URLs
- Store in a `gaa_clubs` lookup table in Supabase
- When a GAA tenant is created, auto-match by club name and set `logo_url` automatically
- Extend to other county boards (gaadublin.ie, connacht GAA etc.)

**Fallback already working:** `unavatar.io/twitter/{handle}` works well for clubs with active Twitter accounts.

**Status:** Idea only.

---

## 📧 Billy Cotter — Passage West GAA Partnership (Free Tier for Word of Mouth)

**Who:** Billy Cotter — heavily involved in Passage West GAA Club.

**Deal idea:** Give Passage West GAA Sprimal + a new website for free, in exchange for word-of-mouth promotion across the GAA community in Cork.

**Why this is worth it:**
- GAA clubs are tightly networked — clubs talk at county board meetings, on the sideline, at matches
- One happy GAA club recommending Sprimal to other clubs = direct pipeline into Cork GAA (hundreds of clubs)
- Passage West already crawled and in the system — cost to set them up is near zero
- A free website + AI receptionist is a compelling gift that will generate genuine enthusiasm

**What to offer:**
- Sprimal AI receptionist — free, no monthly fee, in exchange for word of mouth
- New website (use the Auto-Generated Website feature once built, or hand-build using the design templates)
- Help setting up: club lotto flow, fixtures & results, underage/Cúl Camps, membership

**Actions:**
- [ ] Draft email to Billy Cotter introducing Sprimal and the free offer
- [ ] Set up Passage West GAA tenant (or confirm it's already crawled)
- [ ] Fix Passage West logo (SQL: `logo_url = 'https://unavatar.io/twitter/passageGAA'`)
- [ ] Delete old team_sports_club flows + recrawl → seeds proper GAA flows
- [ ] Build / generate their website using GAA design template
- [ ] Agree word-of-mouth terms (informal — just ask Billy to mention it to other club officers)

---

## 🔗 Portal — Social Media Handles (Facebook, Instagram, Twitter)

**Problem:** Social media handles are often not linked from the website, so the crawl misses them entirely. When the auto-generated website runs, it has no social media to pull images or content from.

**What to build:** A "Social Media" section in the portal settings page with input fields for:
- Facebook page URL or handle
- Instagram handle (@handle)
- Twitter/X handle (@handle)
- TikTok handle (optional — growing for cafés and fitness studios)

**Why it matters:**
- Social handles are the source for Phase 2 of auto-generated websites (real photos from Instagram/Facebook)
- Twitter handle already solves the logo problem for clubs (proven: @passageGAA)
- Club lotto results, match reports, specials — all posted to social, not the website
- Without handles, the generated website has no real photos and the social crawl has nothing to pull from

**Flow:**
- Tenant fills in handles in portal → saved to tenants table
- Background job scrapes recent posts/images → stored as KB documents (`document_type: "Social Media"`)
- Re-generate website button → pulls in latest social images for hero/gallery

**Status:** Not built. Handles not stored anywhere. Logo-from-Twitter already proven via `unavatar.io`.

**Next steps:**
- Add `facebook_url`, `instagram_handle`, `twitter_handle` columns to tenants table
- Add social handles section to portal settings/profile page
- Wire into social media crawl (see Social Media Crawl idea)
- Wire into website generator for Phase 2 photos

---

## 🖼️ Portal — Logo Upload Button

**What:** A button in the client portal (Settings or Branding section) that lets the tenant upload their own logo directly, replacing whatever was auto-detected during the crawl.

**Why:** Auto-detection via Clearbit/favicon scraping is unreliable — clubs with broken websites, Weebly sites, or no favicon end up with the wrong logo or the Sprimal default. Tenants need a self-service way to fix this without us having to do a SQL update manually every time.

**How:**
- Upload button in portal → stores image in Supabase Storage → saves public URL to `tenants.logo_url`
- Accept PNG/JPG/SVG, max ~2MB, auto-resize to square (128×128 or 256×256)
- Preview of current logo shown next to the upload button
- Once uploaded, the favicon proxy picks it up immediately (cache cleared on update)

**Status:** Not built. Currently requires manual SQL update as a workaround.

---

## 📱 Social Media Crawl — Enrich KB from Facebook / Instagram / Twitter

**What:** During the crawl (and recrawl), also pull content from the tenant's social media accounts to enrich the knowledge base — not just the website.

**Why:** Many small businesses (especially GAA clubs, cafés, sports clubs) post their most up-to-date info on social media rather than their website. Fixtures, opening hours changes, events, lotto results, news — it all lives on Facebook and Instagram, not on the website. If Sprimal only crawls the website, the KB goes stale.

**Sources to crawl:**
- **Facebook page** — posts, about section (address, hours, phone), upcoming events
- **Instagram** — captions from recent posts (useful for specials, announcements, new products)
- **Twitter/X** — tweets (especially good for sports clubs — @passageGAA posts fixtures and match results)

**How it could work:**
- Signup form / portal settings takes: Facebook URL + Instagram handle + Twitter handle (all optional)
- Post-crawl step: fetch recent public posts from each platform
  - Facebook: `graph.facebook.com/{page-id}/posts` (requires app token, but Pages API is public for public pages)
  - Instagram: scrape public profile page (no auth needed for public accounts — `instagram.com/{handle}` returns JSON in script tags)
  - Twitter/X: `unavatar.io` already works for logos; post scraping needs Nitter or X API v2 (free tier: 1500 reads/month)
- Chunk and embed social posts the same way as website pages — `document_type: "Social Media"`
- Re-index social media separately from website (don't delete social chunks on recrawl — social has its own re-import button)

**GAA use case:** Club lotto results, match reports, upcoming fixtures are posted weekly to Facebook/Twitter — if the KB includes these, the agent can answer "what was the lotto result last week?" or "when's the next match?"

**Logo bonus:** Twitter handle already solves the logo problem for clubs with broken websites (proven: Cookie Jimmy via bltc.ie, Passage West via @passageGAA).

**Status:** Not built. Logo-from-Twitter already works via `unavatar.io` in the favicon proxy.

**Next steps:**
- Add social handles to tenant profile (portal settings page)
- Add `scrapeInstagramPosts(handle)` — fetch recent captions from public profile
- Add `scrapeTwitterPosts(handle)` — via X API v2 free tier or Nitter fallback
- Facebook: evaluate Graph API (requires app review for some endpoints) vs. scraping
- Add "Social Media" document type + separate recrawl button in portal

---

## ✅ DONE — Browser Tab Favicon

Tenant logo now appears as favicon on generated websites. Falls back to Sprimal icon if no logo set. Tested on Monkstown and Cosy Café.

---

## 📧 Email Deliverability — Keep Signup Emails Out of Spam

**Problem:** Signup/verification emails sent via Resend may land in spam folders, especially for new domains or free email providers (Gmail, Hotmail).

**What to check / fix:**
- Verify SPF, DKIM, and DMARC DNS records are set on the sending domain (`sprimal.com`) via Resend dashboard
- Ensure the `From` address is `hello@sprimal.com` (matching the verified domain) — not a generic no-reply
- Review email HTML — avoid spammy words, excessive links, all-caps, image-heavy layouts
- Add plain-text version alongside HTML in Resend payloads
- Consider adding a short warm-up period (gradually increasing send volume) if the domain is new
- Test deliverability via mail-tester.com before going wider

**Status:** Not investigated. Priority before wider rollout.

---

## ✅ TODO — Check-In Flow End-to-End Testing (Monkstown)

Run these manually on a phone to verify the booking-based check-in is working correctly.

- [ ] **1. Fresh member** — open check-in URL in private/incognito tab. Enter membership number with an active booking (within 15 min before or 30 min into the slot). OTP should arrive by email. Enter code → booking confirmation screen → check in → success screen.
- [ ] **2. Welcome back** — close incognito, reopen normally. Page should recognise the saved device and skip OTP, going straight to booking confirmation.
- [ ] **3. No booking** — try a member with no current booking. Should get a clear message explaining when check-in opens (15 mins before their next slot), or "no booking found."
- [ ] **4. Duplicate check-in** — try checking in a second time for the same booking. Should get "already checked in for Court X at HH:MM" — no duplicate entry in Supabase.
- [ ] **5. Junior delegate** — from the success screen (or no-booking screen), tap "Check in a junior". Enter a junior's membership number. Club policy prompt should appear. Confirm → junior checked in with `is_delegate: true` and `checked_in_by` set to the adult's membership number.
- [ ] **6. Chat button** — on welcome-back and success screens, tap "Chat with Maeve". Should open the chat widget in a new tab, leaving the check-in page open.

**Status:** ⏳ Not yet tested end-to-end. Do tomorrow morning with a real booking window.

---

## ⏳ TODO — Stop Morning Digest Scheduler for Cormac/AOM

Disable or skip the morning digest scheduler for the AOM tenant. Currently the digest scheduler fires at 07:30 IST on weekdays for all tenants — Cormac's tenant should be excluded or the scheduler turned off entirely for AOM.

**Status:** Not done.

---

## ✅ DONE — Disable Cormac/AOM Email Agent

Disabled via `EMAIL_POLLING_ENABLED` environment variable set to anything other than `"true"`. Verified in both staging and production logs — no more email polling.

---

## 📸 Instagram OAuth — Proper API Integration

**Problem:** The current Instagram image scraping is a hack — Instagram actively blocks scrapers, returns rate limits (429), and at best yields 1 profile image. Clubs with no public posts get nothing. The proper solution is OAuth.

**What to build:** An "Connect Instagram" button in the portal Connections/Integrations section. The club logs in with their Instagram account and grants Sprimal read access to their posts via the official API. No scraping, no rate limits, actual post photos.

**How it works:**
1. Club clicks "Connect Instagram" in portal
2. OAuth redirect → Instagram login → club approves read permissions
3. Callback stores access token against tenant in Supabase
4. Sprimal fetches their media via Instagram Graph API (`/me/media?fields=media_url,thumbnail_url`)
5. Photos stored in `social_images` and used in the generated website

**Why this is the right solution:**
- Access to all the club's actual post photos, not just what's public-visible to a scraper
- No rate limiting — authenticated API calls have proper quotas
- Works for private/restricted accounts that can't be scraped at all
- The "Connect Instagram" integration tile in the portal makes sense now — it currently does nothing

**Requirements:**
- Facebook Developer app with `instagram_basic` and `pages_show_list` permissions
- OAuth callback route in index.js
- Store `instagram_access_token` + `instagram_user_id` on tenant record
- App Review by Meta required for `instagram_basic` (1–2 week process)

**First test case:** Monkstown LTCC — access to their Instagram account already available.

**Status:** Idea. Scraping hack in place as interim. OAuth is the correct long-term solution.

---

## 🏐 Foireann Integration (GAA Official Platform)

**What:** foireann.ie is the GAA's official club and member management system. An `api.foireann.ie` endpoint exists (used internally by their React SPA) but is not publicly documented. If Sprimal could tap into this, the AI could answer live questions like "when's the next match?", "what was the lotto result?", "is registration open?" directly from official GAA data.

**Why it matters:** Passage West and most GAA clubs use Foireann. Real-time fixture and membership data would make Sprimal dramatically more useful than a static knowledge base crawl.

**Options:**
- Contact GAA/Foireann directly to request API access or a partnership
- Reverse-engineer the internal `api.foireann.ie` endpoints (unofficial, risky)
- Scrape club pages on foireann.ie that are publicly accessible

**Status:** No public API exists. Worth pursuing via official GAA partnership channel.

---

## 🤝 Clubforce Partnership — Request API Access

**What:** Clubforce is the dominant membership, lotto, and payments platform for GAA clubs in Ireland. No public REST API exists. Contact Clubforce to explore opening up an API or forming a partnership with Sprimal.

**The pitch to Clubforce:** Sprimal drives member engagement via AI chat — if Sprimal can pull live data from Clubforce (membership status, lotto results, upcoming events), it becomes a powerful front-end layer on top of Clubforce. Good for both products.

**Who to contact:** partnerships@clubforce.com or via their website contact form.

**Status:** Not contacted yet.

---

## 🕷️ Jina Fallback for Full Crawl (Cloudflare-Protected Sites)

**Problem:** Sites like carrigalinegaa.ie and passagewestgaaclub.ie use Cloudflare or similar anti-bot protection. The crawler gets 1 page (or 0) and no images. The generated site has no content, no images, and hardcoded colours.

**What:** Use `r.jina.ai/{url}` as a fallback for the entire crawl when direct fetches fail, not just for individual page timeouts.

**Implications:**
- ✅ Would allow crawling Cloudflare-blocked sites and getting real content/links
- ✅ More pages = better KB, better image extraction, better social links
- ❌ **Jina returns Markdown, not HTML** — link extraction changes, image URLs may be stripped, CSS/brand colours still unextractable
- ❌ **Speed** — each page goes through Jina's proxy; slower than direct
- ❌ **Rate limits** — Jina has API limits; concurrent multi-tenant crawls could hit them
- ❌ **Cost** — Jina Reader API is free up to a rate limit but has paid tiers; at scale this adds up

**Better scoped approach:** Only fall back to Jina for the *homepage* (to get link structure) when the direct homepage fetch fails. Then attempt direct fetches for all child pages, with Jina fallback only on those that also fail. Avoids routing the entire crawl through Jina.

**Status:** Idea only. Jina already used for individual probe page fallback.

---

## 📋 Portal — Document Upload Dropdowns Should Be Business-Type Specific

**What:** The document upload dropdowns (document type, tags etc.) currently show options like "Coaches", "Prospective Members" — these are sports club specific and make no sense for a café or restaurant tenant.

**How:** Filter dropdown options by `business_type`. Cafés should see options like "Menu", "Opening Hours", "General Information", "Allergen Info". Sports clubs see "Coaches", "Members", "Fixtures" etc.

**Status:** Idea. Currently all tenants see the same generic dropdowns regardless of business type.

---

## 🏐 Portal — Membership Requests (Sports Clubs Only)

**What:** The "Pending Membership Requests" section in the portal should only be visible to sports club tenants (GAA, tennis, etc.) — it has no relevance to cafés, restaurants, or other business types.

**How:** Gate the section by `business_type` on the tenant record. Show it only when `business_type` is `tennis_club`, `gaa_club`, or similar sports type. Hide it entirely for cafés, retail, hospitality etc.

**Status:** Idea. Currently visible to all tenants regardless of business type.

---

## 📄 Portal — Re-upload Same Document Without Delete/Re-upload

**Problem:** To update an existing document in the KB (e.g. correcting a fact file), the tenant must manually delete the old file and then re-upload the new one. There's no "replace" or "update" option.

**What to build:** A "Replace" button next to each document in the KB uploads list. Clicking it opens the file picker, uploads the new file, re-embeds the chunks, and atomically swaps out the old document — no manual delete step needed.

**Status:** Idea. Currently requires delete + re-upload workaround.

---

## 🍽️ Cosy Café — Menu Update (Frequent Changes)

**Problem:** Sebastian changes his menu regularly. Current flow requires delete + re-upload.

**What to build:** A prominent "Update Menu" button in the portal KB section (for café tenants). Opens file picker → uploads new PDF or text file → automatically deletes old menu chunks and re-embeds new ones in one step.

**Status:** Idea. Blocked on "Replace document" feature being built first.

---

## 🖼️ Cosy Café — Website Photo Management via Portal

**What:** Sebastian wants to swap the photos on his website without touching code. Named image slots: Hero, About, Menu 1, Menu 2. He uploads a photo in the portal, picks the slot, saves — website updates immediately.

**How:** Store image URLs in tenant record columns (`hero_image_url`, `about_image_url` etc.) in Supabase. Website generator reads these dynamically instead of hardcoded URLs. Upload goes to Supabase Storage.

**Status:** Idea. Hardcoded image URLs in cosy-cafe.html currently.

---

## ✅ DONE — Website QR Code in Portal

Added a "Website QR Code" card to the portal dashboard for all tenants, below the existing chat QR. Links to `/sites/{tenant-id}` with Download PNG and View website buttons.

---

## 📸 Portal — Connect Instagram Photos to Website

**What:** A "Connect Instagram" button in the portal that pulls the tenant's Instagram photos and lets them assign them to slots on their website (Hero, About, Gallery etc.) — without touching code.

**How:**
1. Tenant connects Instagram via OAuth (see Instagram OAuth idea)
2. Portal shows a grid of their recent Instagram photos
3. Tenant drags or selects a photo and assigns it to a named slot (Hero, About, Menu image etc.)
4. Website updates immediately — slot URLs stored in Supabase against the tenant

**Why:** Most small businesses post their best photos to Instagram first. This turns their existing Instagram content into website content with zero extra effort — they're already posting the photos anyway.

**Dependency:** Requires Instagram OAuth to be built first.

**Status:** Idea. Depends on Instagram OAuth + website photo management portal.

---

## ⭐ Google Reviews → Knowledge Base

**What:** Pull Google reviews via the Google Places API and embed them as KB chunks. Maeve can then answer "what do customers say?" with real quotes. Reviews auto-refresh periodically.

**How:** Google Places API returns up to 5 recent reviews per place. Store as `document_type: "Reviews"` chunks. Also use to auto-update the review carousel on the generated website.

**Why:** Reviews are social proof, change over time, and are a natural thing visitors ask about. Maeve citing a real 5-star review is far more convincing than a generic answer.

**Status:** Idea. Needs Google Places API key + place_id for each tenant.

---

## 🖼️ Signup Crawl — Pull Images Into Generated Website

**Problem:** When a new tenant signs up and the crawl runs, images from their existing website are not being extracted and used in the generated Sprimal site. The generated site ends up with placeholder or no images, which looks generic and fails to impress.

**Why this matters:** Organisations respond immediately when they see their own photos in the new site — it feels real and personal rather than a template. This is a key "wow moment" in the signup flow and a major conversion lever.

**What to build:**
- During the crawl, extract `<img>` src URLs from crawled pages — filter for large/hero-style images (skip icons, logos, tiny thumbnails)
- Store the best 4–6 image URLs against the tenant (hero, about, gallery slots)
- Generated website uses these real images instead of placeholders
- Portal shows a simple image picker so tenant can swap any slot after signup

**Priority:** High — this is the difference between a demo that wows and one that looks unfinished. Should be tackled before scaling signups.

**Status:** Not built. Crawl fetches text content but discards images.

---

## 🔄 Portal — "Import website now" Banner Doesn't Clear After Clicking

**Bug / UX:** On the Knowledge Base page, when the initial crawl fails, a red warning banner appears ("Website import didn't complete") with an "Import website now" button. When the tenant clicks the button to re-trigger the import, the red banner stays visible throughout the crawl — it doesn't clear or update to show progress. This makes it look like nothing is happening.

**Fix:** When the import button is clicked, immediately replace the red banner with a neutral "Import in progress…" state (or redirect to the crawl progress view). Clear the error state on click rather than waiting for the crawl to finish.

**Status:** Not fixed.

---

## 🏎️ Portal — Crawl Icon Sets Wrong Expectation

**Bug / UX:** The crawl progress indicator uses a Formula 1 car icon, implying the crawl is fast. It actually takes 2–3 minutes. This sets the wrong expectation and may make tenants think something is broken.

**Fix:** Replace the F1 car with a slower, more patient icon — e.g. 🕷️ (spider crawling), 🔍 (searching), or a simple animated spinner. Also consider adding a "This takes 2–3 minutes" note so tenants know to wait.

**Status:** Cosmetic. Quick fix.

---

## 🔐 Admin Panel — AOM Data Visible to Admin Login

**Bug / Privacy concern:** When logged in as admin, the AOM tenant's documents, KB uploads, and other data are visible. Admin should either have a clean tenant-switcher view or AOM data should be fully isolated and not surfaced in the admin panel.

**What to fix:** Scope the admin panel so it doesn't expose individual tenant KB content. Admin should see a tenant list and switch into a tenant's context explicitly — not have all data surfaced by default.

**Status:** Not fixed. Low urgency while AOM is the only sensitive tenant, but needs addressing before wider rollout.

---

## 🎨 Brand Colour Extraction from Logo via OpenAI Vision

**Problem:** CSS-based colour detection picks the first saturated colour in the site's stylesheet, which is often the wrong one (e.g. Rushbrooke's navy before their green). The logo is the definitive source of brand colour but requires image processing to read pixels.

**What to build:** After the crawl extracts the logo URL, download the logo and send it to OpenAI Vision with a prompt like: *"What is the primary brand colour in this logo? Return only a hex colour code."* Store the result as `brand_color`.

**Why:** The logo IS the brand — it's what the club designed around. Colours extracted from it will always be more accurate than scraping CSS variables.

**Fallback order:** OpenAI Vision → theme-color meta tag → Wix CSS variables → CSS structural selectors → admin manual override.

**Status:** Idea. Admin manual override already built as workaround. CSS extraction improved for Wix but still imprecise.

---

## 🤖 Portal — Custom Assistant Name (Replace "Maeve")

**What:** Let tenants rename their AI assistant from "Maeve" to something of their choice — e.g. "Fionn" for a GAA club, "Sophie" for a café, or the club's own branded name.

**Why:** Maeve is a good default but some clients will want a name that fits their brand. A named assistant feels more personal and on-brand.

**How:** Add a "Assistant name" field in portal settings. Stored on the tenant record. Used wherever the assistant introduces itself or is referenced in the widget and generated website.

**Status:** Idea. Maeve hardcoded in system prompts and widget copy currently.

---

## 🌐 Primary Website Designation — Multiple Uploaded Websites

**Problem:** When a tenant has uploaded more than one website (e.g. their main club website + a Clubforce membership page), the crawl has no way to know which is the primary business website. It may pick the wrong one as the canonical source for name, address, description, and brand colours.

**What to build:** A way to designate one uploaded website as the "primary" source — the one the crawl prioritises for contact info, description, and brand colour extraction. Secondary websites would still be crawled and their content added to the KB, but they wouldn't override the primary website's data.

**Options:**
- Simple flag on document upload: "Is this your main website?" checkbox at upload time
- In-portal document list: a ⭐ "Set as primary website" button next to each uploaded website doc
- Admin panel: a dropdown on the tenant row to pick the primary website URL from the list of uploaded sites

**Why it matters:**
- Brand colour extraction reads from the primary website — wrong source = wrong theme
- Description and name are pulled from the primary site — a Clubforce page gives "Clubforce" not the club name
- The generated website card/about text would reflect whatever site the crawl happened to index first

**Status:** Idea. Currently undefined behaviour when multiple sites are uploaded.

---

## 🔍 Retrieval — Phrasing Sensitivity (Fixed in Part)

**Problem:** The same fact in the KB can be missed when the user phrases their question slightly differently. E.g. "who is the chairman" fails but "who is the club chairman" succeeds — same chunk, different embedding distance.

**Root cause:** Pure vector search is sensitive to exact phrasing. Query expansion runs but without knowing the org name, it can't generate grounded alternatives like "chairman of Crosshaven GAA Club."

**Fix applied (2026-06-13):** `expandQuery` now receives the org name and generates 3 variants instead of 2 — (1) specific with org name and role context, (2) general/broad, (3) keywords only. `findRelevantKnowledgeChunks` passes `tenantDisplayName` through.

**Further improvements to consider:**
- HyDE (Hypothetical Document Embeddings) — generate a fake answer, embed it, search for that embedding. Works very well for factual lookups.
- Retrieval telemetry — log similarity scores per query to find the natural threshold gap (see Retrieval Telemetry idea above)
- Re-ranking — after retrieval, use a cross-encoder to re-score chunks against the original question

**Status:** Partially fixed. Monitoring needed to confirm improvement.

---

## 🤬 Profanity Handling — Best Practice Research Needed

**Question:** If a visitor uses profanity in the chat, what is best practice for how the AI should respond?

**Options to research:**
- **Soft warning** — acknowledge the message but gently note the chat is for support queries: *"I'm here to help with questions about the club — let me know what you need."* (ignore the profanity, don't escalate)
- **Hard block** — refuse to respond and state the chat is for appropriate use only
- **Flag and continue** — log the conversation for the tenant to review, but still try to answer the underlying question
- **Escalate to human** — notify the tenant that this conversation needs attention

**Considerations:**
- A GAA club or café chatbot has a very different risk profile to a bank or health service
- Over-reacting to mild language could frustrate genuine users
- Under-reacting could embarrass the tenant if screenshots are shared
- The tenant should probably be able to configure sensitivity level (strict / balanced / ignore)
- GDPR note: if flagging conversations for review, the user should be aware

**Status:** Idea. No handling currently — the AI responds as normal regardless of language used.

---

## 🛡️ Cloudflare Protection (Vlad — Security)

**Problem:** Current rate limit is 30 msgs/IP/min — easy to bypass with rotating IPs or distributed bots. The chat endpoint is exposed to the open internet with no additional layer.

**What to do:** Put Sprimal behind Cloudflare (free tier covers this). Cloudflare provides:
- DDoS protection at the network level
- Bot detection and JS challenge for suspicious IPs
- Rate limiting at the CDN layer (before requests even hit Render)
- WAF rules to block malicious payloads

**How:** Point `app.sprimal.com` DNS through Cloudflare. Enable "Under Attack Mode" if spam spikes. Add a rate-limiting rule in the Cloudflare dashboard targeting `/chat`.

**Status:** Not set up. High priority given open API exposure.

---

## 💬 Chat Monthly Limits per Tenant (Vlad — Cost Protection)

**Problem:** No per-tenant message cap. A single tenant with a viral moment or bot attack could generate thousands of OpenAI calls at Sprimal's expense.

**What to build:**
- `monthly_chat_limit` column on tenants table (default e.g. 500)
- Counter in `chat_logs` — check count before processing each message
- If limit reached: friendly message in chat ("This assistant has reached its monthly chat limit — please contact the club directly")
- Portal shows usage vs limit with a progress bar
- Admin can override limit per tenant

**Pricing angle:** Tiered plans based on chat volume (e.g. 500/month Starter, 2000/month Pro, unlimited Enterprise).

**Status:** Idea. No limit currently enforced.

---

## 🗃️ Response Caching for Common Questions (Vlad)

**What:** Cache AI responses for frequently asked questions to reduce OpenAI API calls and latency. If "what are your opening hours?" has been asked 50 times and the KB hasn't changed, serve the cached answer.

**How:**
- Hash the question + tenant_id as a cache key
- Store in Redis or a `response_cache` Supabase table with TTL (e.g. 24 hours)
- On cache hit: return immediately, skip embedding + retrieval + GPT
- Invalidate cache when KB is updated (recrawl or document upload)
- Cap cache size per tenant to avoid stale answers

**Why:** Top 10 questions for a GAA club are almost always the same (training times, match schedule, how to join). Caching those cuts API cost by potentially 60–70%.

**Status:** Idea. No caching currently.

---

## 🖼️ Replace Emojis with Icons in Chat UI (Vlad)

**What:** Replace emoji characters in chat buttons and responses (🎾, 📞, 📍) with proper SVG icons or an icon library (e.g. Lucide, Heroicons, Font Awesome).

**Why:** Emojis render inconsistently across OS and browser versions — same emoji looks different on Windows vs iOS vs Android. Icons are consistent, scalable, and more professional.

**How:** In `widget.js`, replace emoji strings with inline SVG or `<i class="icon-...">` tags. Load a lightweight icon set (Lucide is ~2KB per icon, tree-shakeable).

**Status:** Idea. Emojis used throughout widget.js currently.

---

## ⚡ React Frontend — Widget & Portal (Vlad)

**What:** Rebuild the chat widget and/or tenant portal using React instead of vanilla JS.

**Why (Vlad's reasoning):** The portal is growing into a complex multi-section admin UI — React's component model, state management, and ecosystem (React Router, React Query) would make it significantly easier to maintain and extend. The widget is simpler but would also benefit from React's reconciliation for complex flows.

**Considerations:**
- Widget must be embeddable as a single script tag — React can be bundled with Vite/webpack but adds bundle size (~40KB gzipped)
- Portal already has a lot of working functionality — a full rewrite is expensive
- Could migrate incrementally: new features built in React, old sections left in vanilla JS

**Vlad's specific suggestions:**
- iframe integrator for the widget (cleaner isolation from host page styles)
- Page 1 / Page 2 / Page 3 layout for chat flows as they grow more complex
- Left-side nav menu for desktop portal instead of long collapsible sections

**Status:** Idea. Current stack is vanilla JS + Express-rendered HTML. Migration would be a major project.

---

## 🗂️ Portal — Left-Side Navigation Menu (Desktop) (Vlad)

**What:** Replace the current long scrollable list of collapsible `<details>` sections in the portal with a fixed left-side navigation menu on desktop.

**Why:** As the portal grows (flows, KB, analytics, leads, unanswered questions, settings, billing), the single-scroll-page layout becomes unwieldy. A left nav with sections — Dashboard, Knowledge Base, Chat Flows, Leads, Analytics, Settings, Billing — matches how SaaS admin tools are structured and is what desktop users expect.

**Vlad's point:** Most tenants will access the portal on desktop. Optimise for that.

**Status:** Idea. Quick win once React migration starts, but could also be done in vanilla JS/CSS with minimal effort.

---

## 🔖 "Powered by Sprimal" Branding on Widget (Vlad)

**What:** A small persistent "Powered by Sprimal" label with the Sprimal logo in the bottom-right of the chat widget — always visible, not dismissable.

**Why:** Free marketing on every tenant's website. Every visitor who uses the chat sees the brand. Standard practice (Intercom, Drift, Tidio all do this on free/lower tiers).

**Options:**
- Always on (all plans) — maximum exposure
- Removable on higher tier (white-label add-on for e.g. €X/month)

**Status:** Idea. Not currently shown.

---

## 🎙️ Voice — Local TTS Instead of ElevenLabs (Vlad)

**Vlad's concern:** ElevenLabs is expensive at scale for voice responses. For server-side voice, he recommended Python Flask + a local TTS model instead.

**What this means:**
- **Client-side (browser):** Use the Web Speech API (`window.speechSynthesis`) — completely free, zero API cost, runs locally in the browser. Quality is lower but acceptable.
- **Server-side:** Python Flask microservice running a local TTS model (e.g. Coqui TTS, Piper, or Bark) — one-time compute cost, no per-character billing.

**When ElevenLabs still makes sense:** Premium "cloned voice" upsell only — where quality matters and the tenant is paying extra for it.

**Status:** Idea. See existing Voice Cost Analysis section for full breakdown.

---

## 🎯 Market Focus — Stick to Tennis Clubs & GAA Clubs (Vlad)

**Vlad's advice:** Don't chase cafés and restaurants — too many competitors (Tidio, Intercom, Drift, OpenTable integrations). The sports club niche (GAA, tennis) is underserved, has strong community networks, and Sprimal already has real traction there.

**Why this is sound:**
- Cosy Café is a good reference client but cafés are a commoditised market
- GAA clubs have no AI receptionist options built for them — Sprimal fits perfectly
- Word-of-mouth in GAA spreads through county board meetings — one happy club = pipeline to hundreds
- Tennis clubs are similarly networked (county/national associations)

**Implication for Cosy Café:** Keep as a client (deal is done), but don't actively pursue more café/restaurant clients. Redirect sales energy to sports clubs.

**Status:** Strategic decision. Noted for marketing and product focus.

---

## 💰 Pricing — Pay-As-You-Go & Fixed Plans with Chat Limits (Vlad)

**Vlad's suggestions:**
- Current flat €49/month may be too low — consider raising price
- Explore pay-as-you-go (per conversation or per message) as an alternative tier
- Fixed plans with monthly chat limits + auto-scale overage charging
- Phone/call features can be spammed robotically — need hard limits or per-call billing rather than unlimited voice

**Proposed structure (rough):**
- **Starter:** €X/month — 500 chats/month, basic features
- **Pro:** €Y/month — 2,000 chats/month, voice add-on, priority support
- **Club:** €Z/month — unlimited chats, white-label, custom domain
- **Overage:** €0.05/chat above limit (auto-charged)

**Status:** Pricing not reviewed since launch. Worth modelling before next client pitch.

---

## 💡 Future / Raw Ideas

- **Multi-location businesses** — single tenant, multiple branch locations, routing based on user's location
- **WhatsApp channel** — widget alternative for markets where WhatsApp is dominant
- **Booking integrations** — connect to Calendly, Acuity, or custom booking for tennis court / appointment slots
- **Review aggregation widget** — pull Google + TripAdvisor ratings live into the generated website
- **Onboarding wizard** — guided setup flow in portal (crawl → choose theme → publish → go live)
- **Weekly digest emails** — send client a summary of chat volume, common questions, leads captured
- **Cursor** — Vlad recommends exploring Cursor IDE as a development tool alongside Claude Code
- **MongoDB Atlas** — Vlad suggested as a Supabase alternative; research security comparison before any migration
- **Mistral AI** — Vlad uses it and finds it suits his use case; research whether it improves quality/cost vs gpt-4o-mini for Sprimal's retrieval + chat workloads
- **Manus** — Vlad uses for systems/terminal automation; research what it is and whether it applies to Sprimal's workflow
- **GitHub skills marketplace** — Vlad recommended searching GitHub to find the best Claude skills to reuse
