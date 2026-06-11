# Sprimal — Product Ideas & Backlog

> Maintained across sessions. Add ideas here as they come up.
> Last updated: 2026-06-10

---

## 🟢 Cosy Café Kinsale — Active Client Onboarding

Deal closed 2026-06-10 with Sebastien Perey. €100 deposit + €200 go-live + €49/month recurring.

### Immediate (today)
- [ ] Send €100 Stripe payment link to Sebastian
- [x] Confirm his WhatsApp / email for ongoing comms

### Week 1 — Design & Content (Sebastian's actions)
- [ ] Sebastian picks design theme (The Local / Modern Artisan / Dark Roast / Wild Atlantic)
- [ ] Sebastian registers **cosycafe.ie** on Blacknight.com (€5.99/yr — his cost)
- [ ] Sebastian sends menu, opening hours, and any photos
- [ ] Sebastian points cosycafe.ie DNS to Sprimal once registered

### Week 1 — Setup (your actions)
- [ ] Create Cosy Café tenant in Sprimal
- [ ] Seed/import their website KB (cosycafe.net crawl)
- [ ] Build chat flows: Menu · Opening Hours · Find Us · Book a Table · Dog Policy · Leave a Review

### Week 2 — Build & Train
- [ ] Build website using chosen design theme
- [ ] Train KB on full menu, hours, story, FAQs
- [ ] Configure cosycafe.ie DNS and SSL
- [ ] Send preview link to Sebastian for feedback

### Week 3 — Test & Refine
- [ ] QA all chat flows on mobile and desktop
- [ ] Schema markup validation
- [ ] Sebastian sign-off

### Week 4 — Go Live
- [ ] Set up 301 redirect: cosycafe.net → cosycafe.ie
- [ ] Sebastian updates Google Business Profile URL to cosycafe.ie
- [ ] Go live on cosycafe.ie
- [ ] Send €200 completion Stripe invoice to Sebastian
- [ ] Set up €49/month Stripe recurring subscription
- [ ] Portal walkthrough with Sebastian (KB updates, leads, chat logs)

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

## 🚨 URGENT — Admin Panel Password & Access Control

**Security issue:** The admin panel password is a weak, guessable password and a real user (Cormac) is actively using it. The admin panel has destructive capabilities — deleting tenants, seeding data etc. This is a serious risk.

**Actions needed:**
1. **Change the admin password immediately** to something long and random — store it in an environment variable, not hardcoded
2. **Audit what Cormac actually needs** — if he only needs portal access (chat logs, KB, leads), give him a portal login for his tenant only
3. **Block admin panel access** for anyone who isn't the system owner — consider IP-restricting `/admin` or adding a second factor
4. **Do not share the admin URL or password** with any tenant going forward

**Risk:** Anyone who knows the password can delete all tenant data, access all accounts, and run seed functions against live clients including Monkstown.

---

## 🚨 URGENT — Widget Buttons Missing on First Load (Wix)

**Bug:** On the Monkstown Tennis Club website (Wix), opening the chat widget sometimes shows the greeting message but no choice buttons. A page refresh fixes it. Happens intermittently.

**Likely cause:** Race condition — the widget initialises and renders the greeting before the API call for workflows/flows has returned. The buttons are data-driven (fetched from the server) so if the response is slow or arrives after the initial render, they never get injected into the DOM.

**Fix options:**
1. Show a loading spinner in place of buttons while flows are fetching, then replace with buttons on response
2. Retry rendering buttons if they're empty after a short delay (e.g. 1.5s timeout fallback re-render)
3. Inline the initial workflow data into the widget script tag so no async fetch is needed on first paint

**Priority:** Urgent — this is a live client (Monkstown) and a real visitor could hit this and see a broken widget.

---

## 🔐 Portal Login: Wrong Credentials Auto-filled by Browser

**Bug / Security concern:** Every time the portal login page is opened, the browser auto-fills the eBooking admin username and password into the email and password fields. This is browser autofill picking up saved credentials from a different service and applying them to the Sprimal portal form.

**Fix:** Add `autocomplete="off"` on the form, or more specifically `autocomplete="username"` / `autocomplete="current-password"` on the individual fields so the browser maps them to the correct saved credentials. Alternatively add `autocomplete="new-password"` on the password field to suppress autofill entirely.

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

## 🌐 Browser Tab Favicon — Sprimal / Club Logo in Tab Title Bar

**What:** The generated tenant websites at `/sites/:tenantId` should show a favicon in the browser tab, just like any professional website. Currently the tab shows a blank page icon.

**What to show:**
- If the tenant has a `logo_url` set — use that as the favicon (works for PNG/JPG via `<link rel="icon">`)
- If no logo — fall back to the Sprimal logo

**How:**
- In `buildTenantSiteHtml`, add to `baseHead()`:
  ```html
  <link rel="icon" href="${logo || 'https://app.sprimal.com/sprimal-icon.png'}" type="image/png">
  <link rel="apple-touch-icon" href="${logo || 'https://app.sprimal.com/sprimal-icon.png'}">
  ```
- The favicon proxy already exists at `/favicon-proxy` — could use that as the `href` so it handles format conversion

**Status:** Not built. Simple one-liner addition to `baseHead()`.

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

## 💡 Future / Raw Ideas

- **Multi-location businesses** — single tenant, multiple branch locations, routing based on user's location
- **WhatsApp channel** — widget alternative for markets where WhatsApp is dominant
- **Booking integrations** — connect to Calendly, Acuity, or custom booking for tennis court / appointment slots
- **Review aggregation widget** — pull Google + TripAdvisor ratings live into the generated website
- **Onboarding wizard** — guided setup flow in portal (crawl → choose theme → publish → go live)
- **Weekly digest emails** — send client a summary of chat volume, common questions, leads captured
