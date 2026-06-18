const express = require("express");
const dotenv = require("dotenv");
const sizeOf = require("image-size");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const { createClient } = require("@supabase/supabase-js");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "knowledge-documents";

const { OpenAI } = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY2 });

const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const multer = require("multer");
const upload = multer({ dest: "uploads/" });

const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

const app = express();

// ── Stripe webhook — raw body required for signature verification ─────────────
// MUST be registered before express.json() middleware
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig           = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  if (webhookSecret && sig) {
    try {
      const stripe = require("stripe")(process.env.SPRIMAL_STRIPE_KEY);
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error("[Stripe webhook] Signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    try { event = JSON.parse(req.body.toString()); }
    catch (err) { return res.status(400).send("Invalid JSON"); }
  }

  const obj = event.data?.object || {};
  const customerId = obj.customer;

  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
    const priceId = obj.items?.data?.[0]?.price?.id;
    const plan    = priceId === process.env.STRIPE_PRICE_ANNUAL ? "annual" : "monthly";
    await supabase.from("tenants").update({
      subscription_status: obj.status,
      subscription_id:     obj.id,
      stripe_customer_id:  customerId,
      subscription_plan:   plan
    }).eq("stripe_customer_id", customerId);
    console.log(`[billing] Subscription ${event.type} for customer ${customerId}: ${obj.status}`);
  }

  if (event.type === "customer.subscription.deleted") {
    await supabase.from("tenants").update({ subscription_status: "canceled", subscription_id: null })
      .eq("stripe_customer_id", customerId);
    console.log(`[billing] Subscription canceled for customer ${customerId}`);
  }

  if (event.type === "invoice.payment_failed") {
    await supabase.from("tenants").update({ subscription_status: "past_due" })
      .eq("stripe_customer_id", customerId);
    console.log(`[billing] Payment failed for customer ${customerId}`);
  }

  res.json({ received: true });
});

// Trust Render's proxy + Cloudflare's proxy layer
// Cloudflare sets CF-Connecting-IP with the real visitor IP
app.set("trust proxy", 1); // Render uses a single proxy hop
app.use((req, _res, next) => {
  const cfIp = req.headers["cf-connecting-ip"];
  if (cfIp) req.ip = cfIp;
  next();
});
app.use(helmet({
  contentSecurityPolicy: false,                            // CSP disabled — inline scripts used in views
  crossOriginResourcePolicy: { policy: "cross-origin" },  // Allow widget.js to load on external sites
  frameguard: false,                                       // Allow chat iframe to embed on external sites
  crossOriginEmbedderPolicy: false,                        // Don't block cross-origin resources in chat frame
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ── Rate limiter for signup ───────────────────────────────────────────────────
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                    // max 5 signup attempts per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many signup attempts from this address. Please try again in an hour." }
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 30,                   // max 30 messages per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many messages. Please slow down and try again shortly." }
});

const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 5,                    // max 5 OTP sends per IP per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many code requests. Please wait 15 minutes before trying again." }
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 20,                   // max 20 verify attempts per IP per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait before trying again." }
});

// Redirect root to portal; admin is still accessible at /login or /admin
app.get("/", (req, res) => res.redirect("/portal"));
app.use(express.static(path.join(__dirname, "public")));
app.get("/favicon.ico", (req, res) => res.status(204).end());

const appointmentsFile = path.join(__dirname, "data", "appointments.json");
const chatLogsFile = path.join(__dirname, "data", "chatLogs.json");
const settingsFile = path.join(__dirname, "data", "settings.json");
const documentsFile = path.join(__dirname, "data", "documents.json");
const knowledgeBaseFile = path.join(__dirname, "data", "knowledgeBase.json");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) { console.error("FATAL: ADMIN_PASSWORD env var not set"); process.exit(1); }
const sessions = new Map();

const JINA_API_KEY = process.env.JINA_API_KEY || null;
const jinaHeaders = () => ({
  "Accept": "text/plain",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  ...(JINA_API_KEY ? { "Authorization": `Bearer ${JINA_API_KEY}` } : {})
});

//const { ElevenLabsClient } = require("elevenlabs");

//const elevenlabs = new ElevenLabsClient({
//  apiKey: process.env.ELEVENLABS_API_KEY
//});

const MAEVE_VOICE_ID = "sgk995upfe3tYLvoGcBN";

const nodemailer = require("nodemailer");

const brokerEmail = process.env.BROKER_EMAIL;

const mammoth = require("mammoth");

// ── Integration credential encryption (AES-256-GCM) ──────────────────────────
// Key lives only in the server environment — never stored in Supabase.
const INTG_ENC_KEY = process.env.INTEGRATION_ENCRYPTION_KEY
  ? Buffer.from(process.env.INTEGRATION_ENCRYPTION_KEY, "hex")
  : null;

// Fields encrypted before storing in tenant_integrations.config
const INTG_SENSITIVE_FIELDS = ["username", "password", "account_sid", "auth_token", "secret_key"];

function encryptField(plaintext) {
  if (!INTG_ENC_KEY) return plaintext; // no key → store as-is (dev mode)
  const iv      = crypto.randomBytes(16);
  const cipher  = crypto.createCipheriv("aes-256-gcm", INTG_ENC_KEY, iv);
  const enc     = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag     = cipher.getAuthTag();
  return "enc:" + JSON.stringify({
    iv:  iv.toString("hex"),
    d:   enc.toString("hex"),
    tag: tag.toString("hex")
  });
}

function decryptField(value) {
  if (!INTG_ENC_KEY || !String(value).startsWith("enc:")) return value; // not encrypted
  try {
    const { iv, d, tag } = JSON.parse(value.slice(4));
    const decipher = crypto.createDecipheriv("aes-256-gcm", INTG_ENC_KEY, Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    return decipher.update(Buffer.from(d, "hex")) + decipher.final("utf8");
  } catch (e) {
    return value; // fallback — return as-is if decryption fails
  }
}

function encryptIntgConfig(config) {
  const out = { ...config };
  INTG_SENSITIVE_FIELDS.forEach(f => { if (out[f]) out[f] = encryptField(out[f]); });
  return out;
}

function decryptIntgConfig(config) {
  const out = { ...config };
  INTG_SENSITIVE_FIELDS.forEach(f => { if (out[f]) out[f] = decryptField(out[f]); });
  return out;
}

// ── Signup protection ─────────────────────────────────────────────────────────
const BLOCKED_DOMAINS = new Set([
  "amazon.com","amazon.co.uk","amazon.ie","amazon.de","amazon.fr","amazon.ca","amazon.com.au",
  "microsoft.com","google.com","google.ie","google.co.uk","google.com.au",
  "facebook.com","instagram.com","twitter.com","x.com","tiktok.com",
  "linkedin.com","youtube.com","netflix.com","spotify.com","pinterest.com",
  "wikipedia.org","reddit.com","apple.com","ebay.com","etsy.com",
  "bbc.com","bbc.co.uk","theguardian.com","irishtimes.com","rte.ie",
  "gov.ie","gov.uk","hse.ie","ec.europa.eu",
  "shopify.com","squarespace.com","wix.com","wordpress.com",
]);

const CRAWL_QUOTA_DOCS = 50; // max pages stored per tenant

// ── Live crawl progress (in-memory, per-tenant) ───────────────────────────────
// Populated by startBackgroundCrawl; consumed by GET /api/portal/crawl-status
const crawlProgressMap = new Map(); // tenantId → { pct, message, done }
function setCrawlProgress(tenantId, pct, message, done = false) {
  crawlProgressMap.set(tenantId, { pct, message, done });
  // Delete quickly after done so reloaded pages don't re-trigger the animation
  if (done) setTimeout(() => crawlProgressMap.delete(tenantId), 8000);
}

// ── Business type detection ───────────────────────────────────────────────────
function nameToBusinessType(name) {
  const n = name.toLowerCase();
  if (/\bgaa\b/.test(n) || /cumann lúthchleas gael/i.test(n)) return "gaa_club";
  if (/\btennis club\b/.test(n)) return "tennis_club";
  if (/\bgolf club\b/.test(n)) return "golf_club";
  if (/\bswim(ming)? club\b/.test(n)) return "swim_club";
  if (/\byoga\b|\bpilates\b/.test(n)) return "yoga_studio";
  if (/\bfitness\b|\bgym\b/.test(n)) return "fitness_studio";
  if (/\bcafé\b|\bcafe\b|\bcoffee\b|\brestaurant\b/.test(n)) return "cafe";
  return null;
}

async function detectBusinessType(name, description, pageText) {
  // Fast name-based heuristic — catches obvious cases without an API call
  const n = (name + " " + description).toLowerCase();
  const nameType = nameToBusinessType(name);
  if (nameType) return nameType;
  if (/\bgaa\b/.test(n) || /cumann lúthchleas gael/i.test(n)) return "gaa_club";

  // If the crawl got nothing useful, don't let GPT guess from the name alone — it gets it wrong
  if ((pageText || "").trim().length < 100) {
    console.log(`[biz-type] Insufficient page text for GPT detection — defaulting to 'other'`);
    return "other";
  }

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Classify this business into exactly one category. Reply with ONLY the category key, nothing else.\nCategories:\n- tennis_club\n- fitness_studio\n- golf_club\n- racket_sports_club\n- yoga_studio\n- swim_club\n- gaa_club\n- team_sports_club\n- cafe\n- other\n\nNotes: racket_sports_club = squash/badminton/padel/table tennis clubs. yoga_studio = yoga/pilates/reformer studios. swim_club = swimming clubs/aquatic centres. gaa_club = GAA clubs playing hurling/football/camogie/ladies football — use this instead of team_sports_club for any GAA club. team_sports_club = rugby/soccer/cricket/hockey clubs (non-GAA). cafe = cafés/coffee shops/restaurants/delis.` },
        { role: "user",   content: `Name: ${name}\nDescription: ${description}\nPage text: ${pageText.slice(0, 600)}` }
      ],
      temperature: 0,
      max_tokens: 10
    });
    const raw  = (resp.choices[0].message.content || "other").trim().toLowerCase().replace(/[^a-z_]/g, "");
    const valid = ["tennis_club", "fitness_studio", "golf_club", "racket_sports_club", "yoga_studio", "swim_club", "gaa_club", "team_sports_club", "cafe"];
    return valid.includes(raw) ? raw : "other";
  } catch (e) {
    console.error("[biz-type] Detection failed:", e.message);
    return "other";
  }
}

// ── Extract structured info from crawled pages (tennis clubs) ─────────────────
// Regex fallback extraction — finds emails, EBO URLs and phone numbers
// from raw page text when the LLM extraction misses them.
function regexExtractFromPages(pages) {
  const allText = pages.map(p => p.text).join("\n");

  // Emails — exclude obvious non-contact addresses
  const emailRe = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  const emails = [...new Set(allText.match(emailRe) || [])].filter(e =>
    !/(sentry|example|sprimal|noreply|no-reply|w3c|schema\.org)/i.test(e)
  );

  // EBOonline booking URL
  // Match any EBO URL format: /box/71, /box/box3.php?id=234, etc.
  const eboMatch = allText.match(/https?:\/\/(?:www\.)?ebookingonline\.net\/[^\s\n"'<>]+/i);
  const eboUrl = eboMatch ? eboMatch[0].replace(/['">\s]+$/, "") : null;

  // Irish phone numbers
  const phoneRe = /(?:\+353|0)[\s\-]?(?:\d[\s\-]?){8,9}\d/g;
  const phones = [...new Set((allText.match(phoneRe) || []).map(p => p.replace(/[\s\-]/g, " ").trim()))];

  return { emails, eboUrl, phones };
}

async function extractTennisClubInfo(pages, websiteUrl) {
  // Sort pages so the most info-rich pages come first.
  // Scoring: URL keyword match + page-text keyword match (catches /tennis, /about-us, etc.)
  const priority = ["membership", "join", "coaching", "lessons", "tennis", "coach", "contact", "find", "about", "location", "fees", "rates", "pricing", "programme", "program", "camp", "junior", "senior", "adult"];
  const sorted = [...pages].sort((a, b) => {
    const score = (p) => {
      const urlLower  = p.url.toLowerCase();
      const textLower = p.text.toLowerCase().slice(0, 500); // first 500 chars of page text
      return priority.filter(k => urlLower.includes(k) || textLower.includes(k)).length;
    };
    return score(b) - score(a);
  });
  const combined = sorted.slice(0, 10).map(p => `--- ${p.url} ---\n${p.text}`).join("\n\n").slice(0, 8000);

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Extract structured info from this tennis club website. Return ONLY valid JSON. Use null for anything not found.\n{\n  "address": "full street address or null",\n  "eircode": "Irish eircode or null",\n  "email": "main contact email or null",\n  "phone": "phone number or null",\n  "membership_prices": "ONLY include real prices found in the text. Format each tier on its own line with an emoji, name and price e.g. '🎾 Adult — €250/year'. If a price is not clearly stated, omit that tier entirely. Return null if no prices found.",\n  "membership_url": "URL of join/membership page or null",\n  "membership_forms": "array of membership application forms found e.g. [{\\\"label\\\": \\\"Senior/Family Application\\\", \\\"url\\\": \\\"https://...\\\"}, {\\\"label\\\": \\\"Junior Coaching Application\\\", \\\"url\\\": \\\"https://...\\\"}] or null — look in [Linked forms and resources] section",\n  "court_booking_url": "URL of court booking page or null",\n  "coaches": "array of coaches with their details e.g. [{\\\"name\\\": \\\"Martin Cusack\\\", \\\"phone\\\": \\\"085 8734558\\\", \\\"email\\\": \\\"martin@example.com\\\"}, {\\\"name\\\": \\\"Aisling O Riordan\\\", \\\"phone\\\": \\\"085 1939086\\\", \\\"email\\\": null}] or null — include all named coaches found anywhere on the site",\n  "coaching_summary": "brief 1-2 sentence summary of coaching programmes offered (adult, junior, camps etc) or null",\n  "events_summary": "brief events/leagues summary or null",\n  "social_instagram": "instagram handle without @ or null",\n  "social_twitter": "twitter handle without @ or null"\n}` },
        { role: "user",   content: combined }
      ],
      temperature: 0,
      max_tokens: 900,
      response_format: { type: "json_object" }
    });
    const info = JSON.parse(resp.choices[0].message.content || "{}");

    // Regex fallbacks — fill any gaps the LLM missed
    const rx = regexExtractFromPages(pages);
    if (!info.email && rx.emails.length)       info.email             = rx.emails[0];
    if (!info.court_booking_url && rx.eboUrl)  info.court_booking_url = rx.eboUrl;
    if (!info.phone && rx.phones.length)       info.phone             = rx.phones[0];

    console.log("[tennis-seed] Extracted info:", JSON.stringify(info));
    return info;
  } catch (e) {
    // LLM failed — fall back to regex only
    console.error("[tennis-seed] Info extraction failed:", e.message);
    const rx = regexExtractFromPages(pages);
    return {
      email: rx.emails[0] || null,
      court_booking_url: rx.eboUrl || null,
      phone: rx.phones[0] || null
    };
  }
}

// ── Seed tennis club chat flows ───────────────────────────────────────────────
async function seedTennisClubFlows(tenantId, name, websiteUrl, info) {
  // Idempotency — skip if flows already exist
  const { data: existing } = await supabase.from("chat_workflows").select("id").eq("club_id", tenantId).limit(1);
  if (existing && existing.length > 0) {
    console.log(`[tennis-seed] Flows already exist for ${tenantId}, skipping`);
    return false;
  }

  const v = (val) => (val && val !== "null") ? val : null; // null-safe getter

  // IDs
  const fMain = crypto.randomUUID(), fMemb = crypto.randomUUID(), fCoach = crypto.randomUUID();
  const fBook = crypto.randomUUID(), fEvt  = crypto.randomUUID(), fLoc   = crypto.randomUUID(), fOther = crypto.randomUUID();
  const sMain = crypto.randomUUID(), sMemb = crypto.randomUUID();
  const sCoach = crypto.randomUUID(), sBook = crypto.randomUUID(), sEvt = crypto.randomUUID(), sLoc = crypto.randomUUID(), sOther = crypto.randomUUID();

  const membershipUrl = v(info.membership_url)    || websiteUrl;
  const bookingUrl    = v(info.court_booking_url) || websiteUrl;
  const contactEmail  = v(info.email) || null;
  const emailLink     = contactEmail
    ? `[link=mailto:${contactEmail}]${contactEmail}[/link]`
    : null;

  // ── Membership — only state what we know; never assume tiers or prices ──────
  // Parse membership_forms — LLM may return an array or a JSON string
  let membershipForms = [];
  try {
    const raw = info.membership_forms;
    if (Array.isArray(raw)) membershipForms = raw.filter(f => f && f.label && f.url);
    else if (typeof raw === "string") {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) membershipForms = parsed.filter(f => f && f.label && f.url);
    }
  } catch {}

  const pricesBlock = v(info.membership_prices) ? `\n\n💰 Membership Rates\n${info.membership_prices}` : "";

  const membMsg = membershipForms.length
    ? `To join ${name}, complete the appropriate application form:\n\n${membershipForms.map(f => `📋 [link=${f.url}]${f.label}[/link]`).join("\n")}${pricesBlock}${emailLink ? `\n\nQuestions? Email ${emailLink}` : ""}`
    : v(info.membership_url)
      ? `To view membership options and join ${name}, visit:\n\n🔗 [link=${membershipUrl}]${membershipUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]${pricesBlock}${emailLink ? `\n\nOr get in touch:\n📧 ${emailLink}` : ""}`
      : `Interested in joining ${name}? Get in touch and we'll send you all the details:${pricesBlock}${emailLink ? `\n\n📧 ${emailLink}` : ""}`;

  // ── Coaching ─────────────────────────────────────────────────────────────────
  // Parse coaches — LLM returns [{name, phone, email}] or a JSON string
  let coaches = [];
  try {
    const raw = info.coaches;
    if (Array.isArray(raw)) coaches = raw.filter(c => c && c.name);
    else if (typeof raw === "string") {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) coaches = parsed.filter(c => c && c.name);
    }
  } catch {}

  // Coach names listed publicly — contact details kept private (portal only).
  // Mirrors Monkstown: names shown, booking handled by coaching_enquiry_agent.
  const coachesBlock = coaches.length
    ? "\n\n" + coaches.map(c => `- ${c.name}`).join("\n")
    : "";

  const coachMsg = v(info.coaching_summary)
    ? `We offer coaching for all ages and levels:\n\n${info.coaching_summary}${coachesBlock}\n\nIf you need more information about coaching, feel free to ask!`
    : coaches.length
      ? `The coaches at ${name} are:${coachesBlock}\n\nIf you need more information about coaching, feel free to ask!`
      : `We offer coaching for all ages and levels.\n\nIf you need more information about coaching, feel free to ask!`;

  // ── Events & Leagues ─────────────────────────────────────────────────────────
  let evtMsg = v(info.events_summary)
    ? `There's always something on at ${name}! 🏆\n\n${info.events_summary}`
    : `There's always something on at ${name}! 🏆\n\nFor the latest events, leagues, and fixtures visit:\n🔗 [link=${websiteUrl}]${websiteUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]`;
  if (v(info.social_instagram) || v(info.social_twitter)) {
    evtMsg += "\n\nFollow us for the latest updates:";
    if (v(info.social_instagram)) evtMsg += `\n[link=https://instagram.com/${info.social_instagram}]📸 Instagram — @${info.social_instagram}[/link]`;
    if (v(info.social_twitter))   evtMsg += `\n[link=https://twitter.com/${info.social_twitter}]🐦 Twitter — @${info.social_twitter}[/link]`;
  }

  // ── Find Us — include Google Maps link ───────────────────────────────────────
  const mapsQuery = encodeURIComponent(name + (v(info.address) ? ", " + info.address : ", Ireland"));
  const mapsUrl   = `https://maps.google.com/?q=${mapsQuery}`;
  const locLines = buildLocLines(info, name, mapsUrl, emailLink);

  // Insert flows
  const { error: fErr } = await supabase.from("chat_workflows").insert([
    { id: fMain,  club_id: tenantId, name: "Main Menu",           is_active: true  }, // auto-activate entry point
    { id: fMemb,  club_id: tenantId, name: "Membership",          is_active: false },
    { id: fCoach, club_id: tenantId, name: "Coaching & Camps",    is_active: false },
    { id: fBook,  club_id: tenantId, name: "Court Availability",  is_active: false },
    { id: fEvt,   club_id: tenantId, name: "Events & Leagues",    is_active: false },
    { id: fLoc,   club_id: tenantId, name: "Find Us",             is_active: false },
    { id: fOther, club_id: tenantId, name: "Other",               is_active: false },
  ]);
  if (fErr) { console.error("[tennis-seed] Flow insert error:", fErr.message); return false; }

  // Insert steps
  const { error: sErr } = await supabase.from("workflow_steps").insert([
    { id: sMain,  workflow_id: fMain,  step_order: 1, bot_message: `What can I help you with today?` },
    { id: sMemb,  workflow_id: fMemb,  step_order: 1, bot_message: membMsg },
    { id: sCoach, workflow_id: fCoach, step_order: 1, bot_message: coachMsg },
    { id: sBook,  workflow_id: fBook,  step_order: 1, bot_message: `📅 Court Availability\n\nBook a court online:\n\n🔗 [link=${bookingUrl}]${bookingUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]` },
    { id: sEvt,   workflow_id: fEvt,   step_order: 1, bot_message: evtMsg },
    { id: sLoc,   workflow_id: fLoc,   step_order: 1, bot_message: locLines },
    { id: sOther, workflow_id: fOther, step_order: 1, bot_message: `No problem! How else can I help?` },
  ]);
  if (sErr) { console.error("[tennis-seed] Step insert error:", sErr.message); return false; }

  // Insert choices
  const { error: cErr } = await supabase.from("workflow_choices").insert([
    // Main menu
    { step_id: sMain, choice_order: 1, label: "🎾 Membership",          action_type: "switch_flow", action_value: fMemb  },
    { step_id: sMain, choice_order: 2, label: "🏫 Coaching & camps",    action_type: "switch_flow", action_value: fCoach },
    { step_id: sMain, choice_order: 3, label: "📅 Court availability",  action_type: "switch_flow", action_value: fBook  },
    { step_id: sMain, choice_order: 4, label: "🏆 Events & leagues",    action_type: "switch_flow", action_value: fEvt   },
    { step_id: sMain, choice_order: 5, label: "📍 Find us",             action_type: "switch_flow", action_value: fLoc   },
    { step_id: sMain, choice_order: 6, label: "💬 Something else",      action_type: "switch_flow",  action_value: fOther },
    // Membership — one button per form if found, otherwise website link + lead capture
    ...(membershipForms.length
      ? [
          ...membershipForms.map((f, i) => ({ step_id: sMemb, choice_order: i + 1, label: `📋 ${f.label}`, action_type: "url", action_value: f.url })),
          { step_id: sMemb, choice_order: membershipForms.length + 1, label: "✉️ Leave your details", action_type: "collect_lead", action_value: null },
          { step_id: sMemb, choice_order: membershipForms.length + 2, label: "← Back to menu",        action_type: "switch_flow",  action_value: fMain }
        ]
      : [
          { step_id: sMemb, choice_order: 1, label: "🌐 Visit website",       action_type: "url",          action_value: membershipUrl },
          { step_id: sMemb, choice_order: 2, label: "✉️ Leave your details", action_type: "collect_lead", action_value: null           },
          { step_id: sMemb, choice_order: 3, label: "← Back to menu",         action_type: "switch_flow",  action_value: fMain          }
        ]
    ),
    // Coaching — mirrors Monkstown: agent handles the booking conversation
    { step_id: sCoach, choice_order: 1, label: "✅ I'd like to book", action_type: "agent",       action_value: "coaching_enquiry_agent" },
    { step_id: sCoach, choice_order: 2, label: "← Back to menu",     action_type: "switch_flow", action_value: fMain                   },
    // Court availability — clean link, back button only
    { step_id: sBook, choice_order: 1, label: "📅 Book now",      action_type: "url",         action_value: bookingUrl },
    { step_id: sBook, choice_order: 2, label: "← Back to menu",   action_type: "switch_flow", action_value: fMain      },
    // Events — back to menu only (no chat)
    { step_id: sEvt, choice_order: 1, label: "← Back to menu", action_type: "switch_flow", action_value: fMain },
    // Find Us
    { step_id: sLoc, choice_order: 1, label: "📍 Get directions", action_type: "url",         action_value: mapsUrl },
    { step_id: sLoc, choice_order: 2, label: "← Back to menu",    action_type: "switch_flow", action_value: fMain  },
    // Other — guided sub-flow
    { step_id: sOther, choice_order: 1, label: "💬 I have a question", action_type: "ai_fallback", action_value: null  },
    { step_id: sOther, choice_order: 2, label: "📞 Contact us",        action_type: "message",     action_value: `Get in touch:${emailLink ? `\n\n📧 ${emailLink}` : ""}${v(info.phone) ? `\n📞 ${info.phone}` : ""}` },
    { step_id: sOther, choice_order: 3, label: "↩ Back to main menu",  action_type: "switch_flow", action_value: fMain },
  ]);
  if (cErr) { console.error("[tennis-seed] Choice insert error:", cErr.message); return false; }

  // ── Auto-activate agents for this tenant ─────────────────────────────────────
  const coachesForAgent = coaches.length
    ? coaches.map(c => `${c.name}${c.phone ? " | " + c.phone : ""}`).join("\n")
    : null;

  const agentsToInsert = [
    {
      tenant_id: tenantId,
      agent_id:  "coaching_enquiry_agent",
      is_active: true,
      config: {
        intro_message:        `Great! I can help you enquire about a coaching session at ${name}. Let me find out a bit more about what you're looking for.`,
        coaches:              coachesForAgent,
        reply_time:           "24 hours",
        session_types:        "Adult 1-to-1\nAdult Group\nJunior\nSummer Camp",
        notification_email:   contactEmail !== "[FILL IN: email]" ? contactEmail : null,
        confirmation_message: `Thanks {{name}}! We've passed your preferred times on to {{preferred_coach}} — they'll be in touch within {{reply_time}} to confirm. 🎾`
      }
    }
  ];

  if (v(info.court_booking_url)) {
    agentsToInsert.push({
      tenant_id: tenantId,
      agent_id:  "court_booking_enquiry_agent",
      is_active: true,
      config: {
        intro_message:  "Sure! Let me check what courts are available for you!",
        ebo_booking_url: info.court_booking_url
      }
    });
  }

  const { error: aErr } = await supabase.from("tenant_agents").insert(agentsToInsert);
  if (aErr) console.error("[tennis-seed] Agent insert error:", aErr.message);

  console.log(`[tennis-seed] ✅ Seeded 6 tennis club flows + ${agentsToInsert.length} agents for ${tenantId} (${name})`);
  return true;
}

// ── Shared helper: build location + opening hours block ───────────────────────
function buildLocLines(info, name, mapsUrl, emailLink) {
  const v = (val) => (val && val !== "null") ? val : null;
  const lines = [
    `📍 ${name}`,
    v(info.address) || null,
    v(info.eircode) ? `Eircode: ${info.eircode}` : null,
    "",
    `[link=${mapsUrl}]📍 Get directions on Google Maps[/link]`,
    "",
    v(info.opening_hours) ? `🕐 Opening Hours\n${info.opening_hours}` : null,
    v(info.opening_hours) ? "" : null,
    emailLink ? `📧 ${emailLink}` : null,
    v(info.phone) ? `📞 ${info.phone}` : null,
  ];
  return lines.filter(l => l !== null).join("\n");
}

// ── Extract generic contact info from crawled pages (non-tennis types) ────────
async function extractGenericInfo(pages, websiteUrl) {
  const priority = ["contact", "about", "location", "find", "address", "join", "membership", "fees", "pricing", "timetable", "schedule", "booking"];
  const sorted = [...pages].sort((a, b) => {
    const score = (p) => {
      const u = p.url.toLowerCase(), t = p.text.toLowerCase().slice(0, 500);
      return priority.filter(k => u.includes(k) || t.includes(k)).length;
    };
    return score(b) - score(a);
  });
  const combined = sorted.slice(0, 8).map(p => `--- ${p.url} ---\n${p.text}`).join("\n\n").slice(0, 6000);
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Extract contact and location info from this website. Return ONLY valid JSON with null for anything not found.\n{\n  "email": "main contact email or null",\n  "phone": "phone number or null",\n  "address": "full street address or null",\n  "eircode": "Irish eircode or null",\n  "opening_hours": "opening hours as a concise multi-line string, e.g. Mon-Fri: 9am-5pm\\nSat: 10am-4pm\\nSun: Closed — or null if not found",\n  "booking_url": "URL for online booking/reservations/classes/tee-times or null",\n  "membership_url": "URL of membership/join/register page or null",\n  "social_instagram": "instagram handle without @ or null",\n  "social_twitter": "twitter handle without @ or null"\n}` },
        { role: "user", content: combined }
      ],
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" }
    });
    const info = JSON.parse(resp.choices[0].message.content || "{}");
    const rx = regexExtractFromPages(pages);
    if (!info.email && rx.emails.length) info.email = rx.emails[0];
    if (!info.phone && rx.phones.length) info.phone = rx.phones[0];
    return info;
  } catch (e) {
    console.error("[generic-seed] Info extraction failed:", e.message);
    const rx = regexExtractFromPages(pages);
    return { email: rx.emails[0] || null, phone: rx.phones[0] || null };
  }
}

// ── Seed fitness studio chat flows ────────────────────────────────────────────
async function seedFitnessStudioFlows(tenantId, name, websiteUrl, info) {
  const { data: existing } = await supabase.from("chat_workflows").select("id").eq("club_id", tenantId).limit(1);
  if (existing && existing.length > 0) {
    console.log(`[fitness-seed] Flows already exist for ${tenantId}, skipping`);
    return false;
  }
  const v = (val) => (val && val !== "null") ? val : null;

  const fMain = crypto.randomUUID(), fMemb = crypto.randomUUID(), fTrial = crypto.randomUUID();
  const fClass = crypto.randomUUID(), fPT   = crypto.randomUUID(), fLoc   = crypto.randomUUID(), fOther = crypto.randomUUID();
  const sMain = crypto.randomUUID(), sMemb = crypto.randomUUID(), sTrial = crypto.randomUUID();
  const sClass = crypto.randomUUID(), sPT   = crypto.randomUUID(), sLoc   = crypto.randomUUID(), sOther = crypto.randomUUID();

  const contactEmail  = v(info.email)          || "[FILL IN: email]";
  const emailLink     = contactEmail !== "[FILL IN: email]"
    ? `[link=mailto:${contactEmail}]${contactEmail}[/link]` : "[FILL IN: email]";
  const membershipUrl = v(info.membership_url) || websiteUrl;
  const bookingUrl    = v(info.booking_url)    || websiteUrl;
  const mapsQuery     = encodeURIComponent(name + (v(info.address) ? ", " + info.address : ", Ireland"));
  const mapsUrl       = `https://maps.google.com/?q=${mapsQuery}`;

  const locLines = buildLocLines(info, name, mapsUrl, emailLink);

  const membMsg  = `We'd love to have you as a member! To view our membership options and sign up:\n\n🔗 [link=${membershipUrl}]${membershipUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nOr get in touch:\n📧 ${emailLink}`;
  const trialMsg = `The best way to see if we're the right fit is a free trial session — no commitment needed. 💪\n\nOur team will show you around and help you find the right plan.\n\nGet in touch to book yours:\n📧 ${emailLink}${v(info.phone) ? `\n📞 ${info.phone}` : ""}`;
  const classMsg = `We run classes throughout the week for all fitness levels.\n\nCheck our full timetable online:\n\n🔗 [link=${bookingUrl}]${bookingUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]`;
  const ptMsg    = `Our qualified personal trainers can design a programme tailored to your goals — whether that's weight loss, strength, or sports performance.\n\nGet in touch to find out more:\n📧 ${emailLink}${v(info.phone) ? `\n📞 ${info.phone}` : ""}`;

  const { error: fErr } = await supabase.from("chat_workflows").insert([
    { id: fMain,  club_id: tenantId, name: "Main Menu",         is_active: true  },
    { id: fMemb,  club_id: tenantId, name: "Membership",        is_active: false },
    { id: fTrial, club_id: tenantId, name: "Free Trial",        is_active: false },
    { id: fClass, club_id: tenantId, name: "Class Timetable",   is_active: false },
    { id: fPT,    club_id: tenantId, name: "Personal Training", is_active: false },
    { id: fLoc,   club_id: tenantId, name: "Find Us",           is_active: false },
    { id: fOther, club_id: tenantId, name: "Other",             is_active: false },
  ]);
  if (fErr) { console.error("[fitness-seed] Flow insert error:", fErr.message); return false; }

  const { error: sErr } = await supabase.from("workflow_steps").insert([
    { id: sMain,  workflow_id: fMain,  step_order: 1, bot_message: `Hi there! 👋 What can I help you with today?` },
    { id: sMemb,  workflow_id: fMemb,  step_order: 1, bot_message: membMsg  },
    { id: sTrial, workflow_id: fTrial, step_order: 1, bot_message: trialMsg },
    { id: sClass, workflow_id: fClass, step_order: 1, bot_message: classMsg },
    { id: sPT,    workflow_id: fPT,    step_order: 1, bot_message: ptMsg    },
    { id: sLoc,   workflow_id: fLoc,   step_order: 1, bot_message: locLines },
    { id: sOther, workflow_id: fOther, step_order: 1, bot_message: `No problem! How else can I help?` },
  ]);
  if (sErr) { console.error("[fitness-seed] Step insert error:", sErr.message); return false; }

  const { error: cErr } = await supabase.from("workflow_choices").insert([
    { step_id: sMain, choice_order: 1, label: "💪 Membership options",   action_type: "switch_flow", action_value: fMemb  },
    { step_id: sMain, choice_order: 2, label: "🆓 Book a free trial",    action_type: "switch_flow", action_value: fTrial },
    { step_id: sMain, choice_order: 3, label: "📅 Class timetable",      action_type: "switch_flow", action_value: fClass },
    { step_id: sMain, choice_order: 4, label: "🏋️ Personal training",   action_type: "switch_flow", action_value: fPT    },
    { step_id: sMain, choice_order: 5, label: "📍 Find us",              action_type: "switch_flow", action_value: fLoc   },
    { step_id: sMain, choice_order: 6, label: "💬 Something else",       action_type: "switch_flow",  action_value: fOther },
    { step_id: sMemb,  choice_order: 1, label: "🌐 View membership options", action_type: "url",          action_value: membershipUrl },
    { step_id: sMemb,  choice_order: 2, label: "✉️ Leave your details",     action_type: "collect_lead", action_value: null           },
    { step_id: sMemb,  choice_order: 3, label: "← Back to menu",             action_type: "switch_flow",  action_value: fMain          },
    { step_id: sTrial, choice_order: 1, label: "✉️ Book my free trial",     action_type: "collect_lead", action_value: null   },
    { step_id: sTrial, choice_order: 2, label: "← Back to menu",             action_type: "switch_flow",  action_value: fMain  },
    { step_id: sClass, choice_order: 1, label: "📅 View timetable",          action_type: "url",          action_value: bookingUrl },
    { step_id: sClass, choice_order: 2, label: "← Back to menu",             action_type: "switch_flow",  action_value: fMain      },
    { step_id: sPT,    choice_order: 1, label: "✉️ Enquire about PT",       action_type: "collect_lead", action_value: null   },
    { step_id: sPT,    choice_order: 2, label: "← Back to menu",             action_type: "switch_flow",  action_value: fMain  },
    { step_id: sLoc,   choice_order: 1, label: "📍 Get directions",          action_type: "url",          action_value: mapsUrl },
    { step_id: sLoc,   choice_order: 2, label: "← Back to menu",             action_type: "switch_flow",  action_value: fMain   },
    // Other — guided sub-flow
    { step_id: sOther, choice_order: 1, label: "💬 I have a question", action_type: "ai_fallback", action_value: null  },
    { step_id: sOther, choice_order: 2, label: "📞 Contact us",        action_type: "message",     action_value: `Get in touch:${emailLink ? `\n\n📧 ${emailLink}` : ""}${v(info.phone) ? `\n📞 ${info.phone}` : ""}` },
    { step_id: sOther, choice_order: 3, label: "↩ Back to main menu",  action_type: "switch_flow", action_value: fMain },
  ]);
  if (cErr) { console.error("[fitness-seed] Choice insert error:", cErr.message); return false; }

  console.log(`[fitness-seed] ✅ Seeded 6 fitness studio flows for ${tenantId} (${name})`);
  return true;
}

// ── Seed golf club chat flows ─────────────────────────────────────────────────
async function seedGolfClubFlows(tenantId, name, websiteUrl, info) {
  const { data: existing } = await supabase.from("chat_workflows").select("id").eq("club_id", tenantId).limit(1);
  if (existing && existing.length > 0) {
    console.log(`[golf-seed] Flows already exist for ${tenantId}, skipping`);
    return false;
  }
  const v = (val) => (val && val !== "null") ? val : null;

  const fMain = crypto.randomUUID(), fMemb = crypto.randomUUID(), fTee  = crypto.randomUUID();
  const fLess = crypto.randomUUID(), fSoc  = crypto.randomUUID(), fLoc  = crypto.randomUUID(), fOther = crypto.randomUUID();
  const sMain = crypto.randomUUID(), sMemb = crypto.randomUUID(), sTee  = crypto.randomUUID();
  const sLess = crypto.randomUUID(), sSoc  = crypto.randomUUID(), sLoc  = crypto.randomUUID(), sOther = crypto.randomUUID();

  const contactEmail  = v(info.email)          || "[FILL IN: email]";
  const emailLink     = contactEmail !== "[FILL IN: email]"
    ? `[link=mailto:${contactEmail}]${contactEmail}[/link]` : "[FILL IN: email]";
  const membershipUrl = v(info.membership_url) || websiteUrl;
  const bookingUrl    = v(info.booking_url)    || websiteUrl;
  const mapsQuery     = encodeURIComponent(name + (v(info.address) ? ", " + info.address : ", Ireland"));
  const mapsUrl       = `https://maps.google.com/?q=${mapsQuery}`;

  const locLines = buildLocLines(info, name, mapsUrl, emailLink);

  const membMsg = `Interested in joining ${name}? We'd love to have you as a member.\n\nView our membership options and apply:\n\n🔗 [link=${membershipUrl}]${membershipUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nOr get in touch with our membership team:\n📧 ${emailLink}`;
  const teeMsg  = `Book a tee time online:\n\n🔗 [link=${bookingUrl}]${bookingUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nFor member bookings, log in to your member area. Visitors are welcome — contact us for green fee rates:\n📧 ${emailLink}`;
  const lessMsg = `We offer golf lessons for all levels, from complete beginners to experienced players looking to improve.\n\nGet in touch to arrange a lesson:\n📧 ${emailLink}${v(info.phone) ? `\n📞 ${info.phone}` : ""}`;
  const socMsg  = `We welcome society outings and group visitors. Get in touch with your details — number of players, preferred date — and we'll put a package together for you:\n📧 ${emailLink}${v(info.phone) ? `\n📞 ${info.phone}` : ""}`;

  const { error: fErr } = await supabase.from("chat_workflows").insert([
    { id: fMain,  club_id: tenantId, name: "Main Menu",          is_active: true  },
    { id: fMemb,  club_id: tenantId, name: "Membership",         is_active: false },
    { id: fTee,   club_id: tenantId, name: "Book a Tee Time",    is_active: false },
    { id: fLess,  club_id: tenantId, name: "Golf Lessons",       is_active: false },
    { id: fSoc,   club_id: tenantId, name: "Society & Visitors", is_active: false },
    { id: fLoc,   club_id: tenantId, name: "Find Us",            is_active: false },
    { id: fOther, club_id: tenantId, name: "Other",              is_active: false },
  ]);
  if (fErr) { console.error("[golf-seed] Flow insert error:", fErr.message); return false; }

  const { error: sErr } = await supabase.from("workflow_steps").insert([
    { id: sMain,  workflow_id: fMain,  step_order: 1, bot_message: `Welcome to ${name}! ⛳ What can I help you with today?` },
    { id: sMemb,  workflow_id: fMemb,  step_order: 1, bot_message: membMsg  },
    { id: sTee,   workflow_id: fTee,   step_order: 1, bot_message: teeMsg   },
    { id: sLess,  workflow_id: fLess,  step_order: 1, bot_message: lessMsg  },
    { id: sSoc,   workflow_id: fSoc,   step_order: 1, bot_message: socMsg   },
    { id: sLoc,   workflow_id: fLoc,   step_order: 1, bot_message: locLines },
    { id: sOther, workflow_id: fOther, step_order: 1, bot_message: `No problem! How else can I help?` },
  ]);
  if (sErr) { console.error("[golf-seed] Step insert error:", sErr.message); return false; }

  const { error: cErr } = await supabase.from("workflow_choices").insert([
    { step_id: sMain, choice_order: 1, label: "⛳ Membership",            action_type: "switch_flow", action_value: fMemb },
    { step_id: sMain, choice_order: 2, label: "📅 Book a tee time",      action_type: "switch_flow", action_value: fTee  },
    { step_id: sMain, choice_order: 3, label: "🎓 Golf lessons",         action_type: "switch_flow", action_value: fLess },
    { step_id: sMain, choice_order: 4, label: "👥 Society & visitors",   action_type: "switch_flow", action_value: fSoc  },
    { step_id: sMain, choice_order: 5, label: "📍 Find us",              action_type: "switch_flow", action_value: fLoc  },
    { step_id: sMain, choice_order: 6, label: "💬 Something else",       action_type: "switch_flow",  action_value: fOther },
    { step_id: sMemb, choice_order: 1, label: "🌐 View membership",      action_type: "url",          action_value: membershipUrl },
    { step_id: sMemb, choice_order: 2, label: "✉️ Leave your details",  action_type: "collect_lead", action_value: null           },
    { step_id: sMemb, choice_order: 3, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain          },
    { step_id: sTee,  choice_order: 1, label: "📅 Book online",          action_type: "url",          action_value: bookingUrl },
    { step_id: sTee,  choice_order: 2, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain      },
    { step_id: sLess, choice_order: 1, label: "✉️ Enquire about lessons",action_type: "collect_lead", action_value: null  },
    { step_id: sLess, choice_order: 2, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain },
    { step_id: sSoc,  choice_order: 1, label: "✉️ Send us your details", action_type: "collect_lead", action_value: null  },
    { step_id: sSoc,  choice_order: 2, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain },
    { step_id: sLoc,  choice_order: 1, label: "📍 Get directions",       action_type: "url",          action_value: mapsUrl },
    { step_id: sLoc,  choice_order: 2, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain   },
    // Other — guided sub-flow
    { step_id: sOther, choice_order: 1, label: "💬 I have a question", action_type: "ai_fallback", action_value: null  },
    { step_id: sOther, choice_order: 2, label: "📞 Contact us",        action_type: "message",     action_value: `Get in touch:${emailLink ? `\n\n📧 ${emailLink}` : ""}${v(info.phone) ? `\n📞 ${info.phone}` : ""}` },
    { step_id: sOther, choice_order: 3, label: "↩ Back to main menu",  action_type: "switch_flow", action_value: fMain },
  ]);
  if (cErr) { console.error("[golf-seed] Choice insert error:", cErr.message); return false; }

  console.log(`[golf-seed] ✅ Seeded 6 golf club flows for ${tenantId} (${name})`);
  return true;
}

// ── Seed racket sports club chat flows (squash, badminton, padel) ─────────────
async function seedRacketSportsClubFlows(tenantId, name, websiteUrl, info) {
  const { data: existing } = await supabase.from("chat_workflows").select("id").eq("club_id", tenantId).limit(1);
  if (existing && existing.length > 0) {
    console.log(`[racket-seed] Flows already exist for ${tenantId}, skipping`);
    return false;
  }
  const v = (val) => (val && val !== "null") ? val : null;

  const fMain  = crypto.randomUUID(), fMemb  = crypto.randomUUID(), fBook  = crypto.randomUUID();
  const fCoach = crypto.randomUUID(), fEvt   = crypto.randomUUID(), fLoc   = crypto.randomUUID(), fOther = crypto.randomUUID();
  const sMain  = crypto.randomUUID(), sMemb  = crypto.randomUUID(), sBook  = crypto.randomUUID();
  const sCoach = crypto.randomUUID(), sEvt   = crypto.randomUUID(), sLoc   = crypto.randomUUID(), sOther = crypto.randomUUID();

  const contactEmail  = v(info.email)          || "[FILL IN: email]";
  const emailLink     = contactEmail !== "[FILL IN: email]"
    ? `[link=mailto:${contactEmail}]${contactEmail}[/link]` : "[FILL IN: email]";
  const membershipUrl = v(info.membership_url) || websiteUrl;
  const bookingUrl    = v(info.booking_url)    || websiteUrl;
  const mapsQuery     = encodeURIComponent(name + (v(info.address) ? ", " + info.address : ", Ireland"));
  const mapsUrl       = `https://maps.google.com/?q=${mapsQuery}`;

  const locLines = buildLocLines(info, name, mapsUrl, emailLink);

  const membMsg  = `Interested in joining ${name}? To view membership options and apply:\n\n🔗 [link=${membershipUrl}]${membershipUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nOr get in touch:\n📧 ${emailLink}`;
  const bookMsg  = `Book a court online:\n\n🔗 [link=${bookingUrl}]${bookingUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nFor members-only courts, you'll need to log in to your member account.`;
  const coachMsg = `We offer coaching for all ages and levels.\n\nTo find out more or book a session:\n📧 ${emailLink}${v(info.phone) ? `\n📞 ${info.phone}` : ""}`;
  const evtMsg   = `There's always something on at ${name}! 🏆\n\nFor the latest events, leagues, and fixtures:\n🔗 [link=${websiteUrl}]${websiteUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]`;

  const { error: fErr } = await supabase.from("chat_workflows").insert([
    { id: fMain,  club_id: tenantId, name: "Main Menu",        is_active: true  },
    { id: fMemb,  club_id: tenantId, name: "Membership",       is_active: false },
    { id: fBook,  club_id: tenantId, name: "Book a Court",     is_active: false },
    { id: fCoach, club_id: tenantId, name: "Coaching",         is_active: false },
    { id: fEvt,   club_id: tenantId, name: "Events & Leagues", is_active: false },
    { id: fLoc,   club_id: tenantId, name: "Find Us",          is_active: false },
    { id: fOther, club_id: tenantId, name: "Other",            is_active: false },
  ]);
  if (fErr) { console.error("[racket-seed] Flow insert error:", fErr.message); return false; }

  const { error: sErr } = await supabase.from("workflow_steps").insert([
    { id: sMain,  workflow_id: fMain,  step_order: 1, bot_message: `Hi there! 👋 What can I help you with today?` },
    { id: sMemb,  workflow_id: fMemb,  step_order: 1, bot_message: membMsg  },
    { id: sBook,  workflow_id: fBook,  step_order: 1, bot_message: bookMsg  },
    { id: sCoach, workflow_id: fCoach, step_order: 1, bot_message: coachMsg },
    { id: sEvt,   workflow_id: fEvt,   step_order: 1, bot_message: evtMsg   },
    { id: sLoc,   workflow_id: fLoc,   step_order: 1, bot_message: locLines },
    { id: sOther, workflow_id: fOther, step_order: 1, bot_message: `No problem! How else can I help?` },
  ]);
  if (sErr) { console.error("[racket-seed] Step insert error:", sErr.message); return false; }

  const { error: cErr } = await supabase.from("workflow_choices").insert([
    { step_id: sMain,  choice_order: 1, label: "🏸 Membership",       action_type: "switch_flow", action_value: fMemb  },
    { step_id: sMain,  choice_order: 2, label: "📅 Book a court",     action_type: "switch_flow", action_value: fBook  },
    { step_id: sMain,  choice_order: 3, label: "🎓 Coaching",         action_type: "switch_flow", action_value: fCoach },
    { step_id: sMain,  choice_order: 4, label: "🏆 Events & leagues", action_type: "switch_flow", action_value: fEvt   },
    { step_id: sMain,  choice_order: 5, label: "📍 Find us",          action_type: "switch_flow", action_value: fLoc   },
    { step_id: sMain,  choice_order: 6, label: "💬 Something else",   action_type: "switch_flow",  action_value: fOther },
    { step_id: sMemb,  choice_order: 1, label: "🌐 View membership",  action_type: "url",          action_value: membershipUrl },
    { step_id: sMemb,  choice_order: 2, label: "✉️ Leave your details",action_type: "collect_lead", action_value: null          },
    { step_id: sMemb,  choice_order: 3, label: "← Back to menu",      action_type: "switch_flow",  action_value: fMain         },
    { step_id: sBook,  choice_order: 1, label: "📅 Book now",         action_type: "url",          action_value: bookingUrl },
    { step_id: sBook,  choice_order: 2, label: "← Back to menu",      action_type: "switch_flow",  action_value: fMain      },
    { step_id: sCoach, choice_order: 1, label: "✉️ Book a lesson",    action_type: "collect_lead", action_value: null   },
    { step_id: sCoach, choice_order: 2, label: "← Back to menu",      action_type: "switch_flow",  action_value: fMain  },
    { step_id: sEvt,   choice_order: 1, label: "🌐 Visit website",    action_type: "url",          action_value: websiteUrl },
    { step_id: sEvt,   choice_order: 2, label: "← Back to menu",      action_type: "switch_flow",  action_value: fMain      },
    { step_id: sLoc,   choice_order: 1, label: "📍 Get directions",   action_type: "url",          action_value: mapsUrl },
    { step_id: sLoc,   choice_order: 2, label: "← Back to menu",      action_type: "switch_flow",  action_value: fMain   },
    // Other — guided sub-flow
    { step_id: sOther, choice_order: 1, label: "💬 I have a question", action_type: "ai_fallback", action_value: null  },
    { step_id: sOther, choice_order: 2, label: "📞 Contact us",        action_type: "message",     action_value: `Get in touch:${emailLink ? `\n\n📧 ${emailLink}` : ""}${v(info.phone) ? `\n📞 ${info.phone}` : ""}` },
    { step_id: sOther, choice_order: 3, label: "↩ Back to main menu",  action_type: "switch_flow", action_value: fMain },
  ]);
  if (cErr) { console.error("[racket-seed] Choice insert error:", cErr.message); return false; }

  console.log(`[racket-seed] ✅ Seeded 6 racket sports club flows for ${tenantId} (${name})`);
  return true;
}

// ── Seed yoga / pilates studio chat flows ─────────────────────────────────────
async function seedYogaStudioFlows(tenantId, name, websiteUrl, info) {
  const { data: existing } = await supabase.from("chat_workflows").select("id").eq("club_id", tenantId).limit(1);
  if (existing && existing.length > 0) {
    console.log(`[yoga-seed] Flows already exist for ${tenantId}, skipping`);
    return false;
  }
  const v = (val) => (val && val !== "null") ? val : null;

  const fMain  = crypto.randomUUID(), fTrial = crypto.randomUUID(), fMemb  = crypto.randomUUID();
  const fTT    = crypto.randomUUID(), fAbout = crypto.randomUUID(), fLoc   = crypto.randomUUID(), fOther = crypto.randomUUID();
  const sMain  = crypto.randomUUID(), sTrial = crypto.randomUUID(), sMemb  = crypto.randomUUID();
  const sTT    = crypto.randomUUID(), sAbout = crypto.randomUUID(), sLoc   = crypto.randomUUID(), sOther = crypto.randomUUID();

  const contactEmail  = v(info.email)          || "[FILL IN: email]";
  const emailLink     = contactEmail !== "[FILL IN: email]"
    ? `[link=mailto:${contactEmail}]${contactEmail}[/link]` : "[FILL IN: email]";
  const membershipUrl = v(info.membership_url) || websiteUrl;
  const bookingUrl    = v(info.booking_url)    || websiteUrl;
  const mapsQuery     = encodeURIComponent(name + (v(info.address) ? ", " + info.address : ", Ireland"));
  const mapsUrl       = `https://maps.google.com/?q=${mapsQuery}`;

  const locLines = buildLocLines(info, name, mapsUrl, emailLink);

  const trialMsg = `We'd love to welcome you for your first class — all levels welcome, including complete beginners! 🧘\n\nBrowse our schedule and book your first session:\n\n🔗 [link=${bookingUrl}]${bookingUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nOr get in touch and we'll help you choose the right class:\n📧 ${emailLink}`;
  const membMsg  = `We offer a range of membership options and class passes to suit every schedule and budget.\n\nView our options online:\n\n🔗 [link=${membershipUrl}]${membershipUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nAny questions:\n📧 ${emailLink}`;
  const ttMsg    = `Check out our full class timetable online:\n\n🔗 [link=${bookingUrl}]${bookingUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nClasses run throughout the week for all levels.`;
  const aboutMsg = `We offer a range of yoga and mindfulness classes for all levels. Whether you're brand new to yoga or deepening an existing practice, we have a class that's right for you.\n\nAny questions? Feel free to ask — I'm happy to help! 🙏`;

  const { error: fErr } = await supabase.from("chat_workflows").insert([
    { id: fMain,  club_id: tenantId, name: "Main Menu",           is_active: true  },
    { id: fTrial, club_id: tenantId, name: "Try a Class",         is_active: false },
    { id: fMemb,  club_id: tenantId, name: "Membership & Passes", is_active: false },
    { id: fTT,    club_id: tenantId, name: "Class Timetable",     is_active: false },
    { id: fAbout, club_id: tenantId, name: "About Our Classes",   is_active: false },
    { id: fLoc,   club_id: tenantId, name: "Find Us",             is_active: false },
    { id: fOther, club_id: tenantId, name: "Other",               is_active: false },
  ]);
  if (fErr) { console.error("[yoga-seed] Flow insert error:", fErr.message); return false; }

  const { error: sErr } = await supabase.from("workflow_steps").insert([
    { id: sMain,  workflow_id: fMain,  step_order: 1, bot_message: `Hi there! 🙏 Welcome to ${name}. What can I help you with?` },
    { id: sTrial, workflow_id: fTrial, step_order: 1, bot_message: trialMsg },
    { id: sMemb,  workflow_id: fMemb,  step_order: 1, bot_message: membMsg  },
    { id: sTT,    workflow_id: fTT,    step_order: 1, bot_message: ttMsg    },
    { id: sAbout, workflow_id: fAbout, step_order: 1, bot_message: aboutMsg },
    { id: sLoc,   workflow_id: fLoc,   step_order: 1, bot_message: locLines },
    { id: sOther, workflow_id: fOther, step_order: 1, bot_message: `No problem! How else can I help?` },
  ]);
  if (sErr) { console.error("[yoga-seed] Step insert error:", sErr.message); return false; }

  const { error: cErr } = await supabase.from("workflow_choices").insert([
    { step_id: sMain,  choice_order: 1, label: "🆓 Try a class",          action_type: "switch_flow", action_value: fTrial },
    { step_id: sMain,  choice_order: 2, label: "💳 Membership & passes",  action_type: "switch_flow", action_value: fMemb  },
    { step_id: sMain,  choice_order: 3, label: "📅 Class timetable",      action_type: "switch_flow", action_value: fTT    },
    { step_id: sMain,  choice_order: 4, label: "🧘 About our classes",    action_type: "switch_flow", action_value: fAbout },
    { step_id: sMain,  choice_order: 5, label: "📍 Find us",              action_type: "switch_flow", action_value: fLoc   },
    { step_id: sMain,  choice_order: 6, label: "💬 Something else",       action_type: "switch_flow",  action_value: fOther },
    { step_id: sTrial, choice_order: 1, label: "📅 Book a class",         action_type: "url",          action_value: bookingUrl },
    { step_id: sTrial, choice_order: 2, label: "✉️ Reserve my spot",     action_type: "collect_lead", action_value: null       },
    { step_id: sTrial, choice_order: 3, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain      },
    { step_id: sMemb,  choice_order: 1, label: "🌐 View options",         action_type: "url",          action_value: membershipUrl },
    { step_id: sMemb,  choice_order: 2, label: "✉️ Leave your details",  action_type: "collect_lead", action_value: null          },
    { step_id: sMemb,  choice_order: 3, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain         },
    { step_id: sTT,    choice_order: 1, label: "📅 View timetable",       action_type: "url",          action_value: bookingUrl },
    { step_id: sTT,    choice_order: 2, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain      },
    { step_id: sAbout, choice_order: 1, label: "🆓 Try a class",          action_type: "switch_flow",  action_value: fTrial },
    { step_id: sAbout, choice_order: 2, label: "💬 Ask me anything",      action_type: "ai_fallback",  action_value: null   },
    { step_id: sAbout, choice_order: 3, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain  },
    { step_id: sLoc,   choice_order: 1, label: "📍 Get directions",       action_type: "url",          action_value: mapsUrl },
    { step_id: sLoc,   choice_order: 2, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain   },
    // Other — guided sub-flow
    { step_id: sOther, choice_order: 1, label: "💬 I have a question", action_type: "ai_fallback", action_value: null  },
    { step_id: sOther, choice_order: 2, label: "📞 Contact us",        action_type: "message",     action_value: `Get in touch:${emailLink ? `\n\n📧 ${emailLink}` : ""}${v(info.phone) ? `\n📞 ${info.phone}` : ""}` },
    { step_id: sOther, choice_order: 3, label: "↩ Back to main menu",  action_type: "switch_flow", action_value: fMain },
  ]);
  if (cErr) { console.error("[yoga-seed] Choice insert error:", cErr.message); return false; }

  console.log(`[yoga-seed] ✅ Seeded 6 yoga studio flows for ${tenantId} (${name})`);
  return true;
}

// ── Seed swim club chat flows ─────────────────────────────────────────────────
async function seedSwimClubFlows(tenantId, name, websiteUrl, info) {
  const { data: existing } = await supabase.from("chat_workflows").select("id").eq("club_id", tenantId).limit(1);
  if (existing && existing.length > 0) {
    console.log(`[swim-seed] Flows already exist for ${tenantId}, skipping`);
    return false;
  }
  const v = (val) => (val && val !== "null") ? val : null;

  const fMain = crypto.randomUUID(), fMemb = crypto.randomUUID(), fLess = crypto.randomUUID();
  const fPool = crypto.randomUUID(), fComp = crypto.randomUUID(), fLoc  = crypto.randomUUID(), fOther = crypto.randomUUID();
  const sMain = crypto.randomUUID(), sMemb = crypto.randomUUID(), sLess = crypto.randomUUID();
  const sPool = crypto.randomUUID(), sComp = crypto.randomUUID(), sLoc  = crypto.randomUUID(), sOther = crypto.randomUUID();

  const contactEmail  = v(info.email)          || "[FILL IN: email]";
  const emailLink     = contactEmail !== "[FILL IN: email]"
    ? `[link=mailto:${contactEmail}]${contactEmail}[/link]` : "[FILL IN: email]";
  const membershipUrl = v(info.membership_url) || websiteUrl;
  const bookingUrl    = v(info.booking_url)    || websiteUrl;
  const mapsQuery     = encodeURIComponent(name + (v(info.address) ? ", " + info.address : ", Ireland"));
  const mapsUrl       = `https://maps.google.com/?q=${mapsQuery}`;

  const locLines = buildLocLines(info, name, mapsUrl, emailLink);

  const membMsg = `We'd love to have you join ${name}! To view membership options and sign up:\n\n🔗 [link=${membershipUrl}]${membershipUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nAny questions:\n📧 ${emailLink}`;
  const lessMsg = `We run swimming lessons for all ages and abilities — from beginners to advanced swimmers.\n\nTo register for the next intake:\n📧 ${emailLink}${v(info.phone) ? `\n📞 ${info.phone}` : ""}`;
  const poolMsg = `View our pool timetable online:\n\n🔗 [link=${bookingUrl}]${bookingUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nLane swimming sessions are available for members throughout the week.`;
  const compMsg = `We compete at national and regional level across all age groups. For information about our competitive squads:\n📧 ${emailLink}${v(info.phone) ? `\n📞 ${info.phone}` : ""}`;

  const { error: fErr } = await supabase.from("chat_workflows").insert([
    { id: fMain,  club_id: tenantId, name: "Main Menu",            is_active: true  },
    { id: fMemb,  club_id: tenantId, name: "Membership",           is_active: false },
    { id: fLess,  club_id: tenantId, name: "Lessons & Coaching",   is_active: false },
    { id: fPool,  club_id: tenantId, name: "Pool Timetable",       is_active: false },
    { id: fComp,  club_id: tenantId, name: "Competitive Swimming", is_active: false },
    { id: fLoc,   club_id: tenantId, name: "Find Us",              is_active: false },
    { id: fOther, club_id: tenantId, name: "Other",                is_active: false },
  ]);
  if (fErr) { console.error("[swim-seed] Flow insert error:", fErr.message); return false; }

  const { error: sErr } = await supabase.from("workflow_steps").insert([
    { id: sMain,  workflow_id: fMain,  step_order: 1, bot_message: `Hi there! 🏊 Welcome to ${name}. What can I help you with?` },
    { id: sMemb,  workflow_id: fMemb,  step_order: 1, bot_message: membMsg  },
    { id: sLess,  workflow_id: fLess,  step_order: 1, bot_message: lessMsg  },
    { id: sPool,  workflow_id: fPool,  step_order: 1, bot_message: poolMsg  },
    { id: sComp,  workflow_id: fComp,  step_order: 1, bot_message: compMsg  },
    { id: sLoc,   workflow_id: fLoc,   step_order: 1, bot_message: locLines },
    { id: sOther, workflow_id: fOther, step_order: 1, bot_message: `No problem! How else can I help?` },
  ]);
  if (sErr) { console.error("[swim-seed] Step insert error:", sErr.message); return false; }

  const { error: cErr } = await supabase.from("workflow_choices").insert([
    { step_id: sMain, choice_order: 1, label: "🏊 Join the club",        action_type: "switch_flow", action_value: fMemb },
    { step_id: sMain, choice_order: 2, label: "📅 Lessons & coaching",   action_type: "switch_flow", action_value: fLess },
    { step_id: sMain, choice_order: 3, label: "🕐 Pool timetable",       action_type: "switch_flow", action_value: fPool },
    { step_id: sMain, choice_order: 4, label: "🏆 Competitive swimming", action_type: "switch_flow", action_value: fComp },
    { step_id: sMain, choice_order: 5, label: "📍 Find us",              action_type: "switch_flow", action_value: fLoc  },
    { step_id: sMain, choice_order: 6, label: "💬 Something else",       action_type: "switch_flow",  action_value: fOther },
    { step_id: sMemb, choice_order: 1, label: "🌐 View membership",      action_type: "url",          action_value: membershipUrl },
    { step_id: sMemb, choice_order: 2, label: "✉️ Leave your details",  action_type: "collect_lead", action_value: null           },
    { step_id: sMemb, choice_order: 3, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain          },
    { step_id: sLess, choice_order: 1, label: "✉️ Register interest",   action_type: "collect_lead", action_value: null  },
    { step_id: sLess, choice_order: 2, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain },
    { step_id: sPool, choice_order: 1, label: "🕐 View timetable",       action_type: "url",          action_value: bookingUrl },
    { step_id: sPool, choice_order: 2, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain      },
    { step_id: sComp, choice_order: 1, label: "✉️ Find out more",       action_type: "collect_lead", action_value: null  },
    { step_id: sComp, choice_order: 2, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain },
    { step_id: sLoc,  choice_order: 1, label: "📍 Get directions",       action_type: "url",          action_value: mapsUrl },
    { step_id: sLoc,  choice_order: 2, label: "← Back to menu",          action_type: "switch_flow",  action_value: fMain   },
    // Other — guided sub-flow
    { step_id: sOther, choice_order: 1, label: "💬 I have a question", action_type: "ai_fallback", action_value: null  },
    { step_id: sOther, choice_order: 2, label: "📞 Contact us",        action_type: "message",     action_value: `Get in touch:${emailLink ? `\n\n📧 ${emailLink}` : ""}${v(info.phone) ? `\n📞 ${info.phone}` : ""}` },
    { step_id: sOther, choice_order: 3, label: "↩ Back to main menu",  action_type: "switch_flow", action_value: fMain },
  ]);
  if (cErr) { console.error("[swim-seed] Choice insert error:", cErr.message); return false; }

  console.log(`[swim-seed] ✅ Seeded 6 swim club flows for ${tenantId} (${name})`);
  return true;
}

// ── Seed team sports club chat flows (GAA, rugby, soccer, hockey) ─────────────
async function seedTeamSportsClubFlows(tenantId, name, websiteUrl, info) {
  const { data: existing } = await supabase.from("chat_workflows").select("id").eq("club_id", tenantId).limit(1);
  if (existing && existing.length > 0) {
    console.log(`[team-seed] Flows already exist for ${tenantId}, skipping`);
    return false;
  }
  const v = (val) => (val && val !== "null") ? val : null;

  const fMain  = crypto.randomUUID(), fJoin  = crypto.randomUUID(), fTrain = crypto.randomUUID();
  const fFix   = crypto.randomUUID(), fYouth = crypto.randomUUID(), fLoc   = crypto.randomUUID(), fOther = crypto.randomUUID();
  const sMain  = crypto.randomUUID(), sJoin  = crypto.randomUUID(), sTrain = crypto.randomUUID();
  const sFix   = crypto.randomUUID(), sYouth = crypto.randomUUID(), sLoc   = crypto.randomUUID(), sOther = crypto.randomUUID();

  const contactEmail  = v(info.email)          || "[FILL IN: email]";
  const emailLink     = contactEmail !== "[FILL IN: email]"
    ? `[link=mailto:${contactEmail}]${contactEmail}[/link]` : "[FILL IN: email]";
  const membershipUrl = v(info.membership_url) || websiteUrl;
  const mapsQuery     = encodeURIComponent(name + (v(info.address) ? ", " + info.address : ", Ireland"));
  const mapsUrl       = `https://maps.google.com/?q=${mapsQuery}`;

  const locLines = buildLocLines(info, name, mapsUrl, emailLink);

  const joinMsg  = `We'd love to have you join ${name}! New members are always welcome.\n\nTo find out more about joining and registration:\n\n🔗 [link=${membershipUrl}]${membershipUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nOr get in touch directly:\n📧 ${emailLink}`;
  const trainMsg = `Training takes place throughout the week for all teams and age groups.\n\nFor the latest training schedule, visit:\n\n🔗 [link=${websiteUrl}]${websiteUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nOr ask me and I'll do my best to help!`;
  const fixMsg   = `For the latest fixtures, results, and standings:\n\n🔗 [link=${websiteUrl}]${websiteUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]`;
  const youthMsg = `We run underage teams from the youngest age groups all the way up to senior level — no experience needed!\n\nTo register a child or find out more:\n📧 ${emailLink}${v(info.phone) ? `\n📞 ${info.phone}` : ""}`;

  const { error: fErr } = await supabase.from("chat_workflows").insert([
    { id: fMain,  club_id: tenantId, name: "Main Menu",          is_active: true  },
    { id: fJoin,  club_id: tenantId, name: "Join the Club",      is_active: false },
    { id: fTrain, club_id: tenantId, name: "Training Schedule",  is_active: false },
    { id: fFix,   club_id: tenantId, name: "Fixtures & Results", is_active: false },
    { id: fYouth, club_id: tenantId, name: "Youth & Underage",   is_active: false },
    { id: fLoc,   club_id: tenantId, name: "Find Us",            is_active: false },
    { id: fOther, club_id: tenantId, name: "Other",              is_active: false },
  ]);
  if (fErr) { console.error("[team-seed] Flow insert error:", fErr.message); return false; }

  const { error: sErr } = await supabase.from("workflow_steps").insert([
    { id: sMain,  workflow_id: fMain,  step_order: 1, bot_message: `Hi there! 👋 Welcome to ${name}. What can I help you with?` },
    { id: sJoin,  workflow_id: fJoin,  step_order: 1, bot_message: joinMsg  },
    { id: sTrain, workflow_id: fTrain, step_order: 1, bot_message: trainMsg },
    { id: sFix,   workflow_id: fFix,   step_order: 1, bot_message: fixMsg   },
    { id: sYouth, workflow_id: fYouth, step_order: 1, bot_message: youthMsg },
    { id: sLoc,   workflow_id: fLoc,   step_order: 1, bot_message: locLines },
    { id: sOther, workflow_id: fOther, step_order: 1, bot_message: `No problem! How else can I help?` },
  ]);
  if (sErr) { console.error("[team-seed] Step insert error:", sErr.message); return false; }

  const { error: cErr } = await supabase.from("workflow_choices").insert([
    { step_id: sMain,  choice_order: 1, label: "🏅 Join the club",       action_type: "switch_flow", action_value: fJoin  },
    { step_id: sMain,  choice_order: 2, label: "📅 Training schedule",   action_type: "switch_flow", action_value: fTrain },
    { step_id: sMain,  choice_order: 3, label: "🏆 Fixtures & results",  action_type: "switch_flow", action_value: fFix   },
    { step_id: sMain,  choice_order: 4, label: "👶 Youth & underage",    action_type: "switch_flow", action_value: fYouth },
    { step_id: sMain,  choice_order: 5, label: "📍 Find us",             action_type: "switch_flow", action_value: fLoc   },
    { step_id: sMain,  choice_order: 6, label: "💬 Something else",      action_type: "switch_flow",  action_value: fOther },
    { step_id: sJoin,  choice_order: 1, label: "🌐 View how to join",    action_type: "url",          action_value: membershipUrl },
    { step_id: sJoin,  choice_order: 2, label: "✉️ Register interest",  action_type: "collect_lead", action_value: null          },
    { step_id: sJoin,  choice_order: 3, label: "← Back to menu",         action_type: "switch_flow",  action_value: fMain         },
    { step_id: sTrain, choice_order: 1, label: "🌐 Visit website",       action_type: "url",          action_value: websiteUrl },
    { step_id: sTrain, choice_order: 2, label: "💬 Ask me",              action_type: "ai_fallback",  action_value: null       },
    { step_id: sTrain, choice_order: 3, label: "← Back to menu",         action_type: "switch_flow",  action_value: fMain      },
    { step_id: sFix,   choice_order: 1, label: "🌐 View on website",     action_type: "url",          action_value: websiteUrl },
    { step_id: sFix,   choice_order: 2, label: "← Back to menu",         action_type: "switch_flow",  action_value: fMain      },
    { step_id: sYouth, choice_order: 1, label: "✉️ Register a child",   action_type: "collect_lead", action_value: null   },
    { step_id: sYouth, choice_order: 2, label: "← Back to menu",         action_type: "switch_flow",  action_value: fMain  },
    { step_id: sLoc,   choice_order: 1, label: "📍 Get directions",      action_type: "url",          action_value: mapsUrl },
    { step_id: sLoc,   choice_order: 2, label: "← Back to menu",         action_type: "switch_flow",  action_value: fMain   },
    // Other — guided sub-flow
    { step_id: sOther, choice_order: 1, label: "💬 I have a question", action_type: "ai_fallback", action_value: null  },
    { step_id: sOther, choice_order: 2, label: "📞 Contact us",        action_type: "message",     action_value: `Get in touch:${emailLink ? `\n\n📧 ${emailLink}` : ""}${v(info.phone) ? `\n📞 ${info.phone}` : ""}` },
    { step_id: sOther, choice_order: 3, label: "↩ Back to main menu",  action_type: "switch_flow", action_value: fMain },
  ]);
  if (cErr) { console.error("[team-seed] Choice insert error:", cErr.message); return false; }

  console.log(`[team-seed] ✅ Seeded 6 team sports club flows for ${tenantId} (${name})`);
  return true;
}

// ── Seed GAA club chat flows ──────────────────────────────────────────────────
async function seedGAAClubFlows(tenantId, name, websiteUrl, info) {
  const { data: existing } = await supabase.from("chat_workflows").select("id").eq("club_id", tenantId).limit(1);
  if (existing && existing.length > 0) {
    console.log(`[gaa-seed] Flows already exist for ${tenantId}, skipping`);
    return false;
  }
  const v = (val) => (val && val !== "null") ? val : null;

  const fMain  = crypto.randomUUID(), fJoin  = crypto.randomUUID(), fTeams = crypto.randomUUID();
  const fFix   = crypto.randomUUID(), fLotto = crypto.randomUUID(), fYouth = crypto.randomUUID();
  const fLoc   = crypto.randomUUID(), fOther = crypto.randomUUID();
  const sMain  = crypto.randomUUID(), sJoin  = crypto.randomUUID(), sTeams = crypto.randomUUID();
  const sFix   = crypto.randomUUID(), sLotto = crypto.randomUUID(), sYouth = crypto.randomUUID();
  const sLoc   = crypto.randomUUID(), sOther = crypto.randomUUID();

  const contactEmail  = v(info.email)          || "[FILL IN: email]";
  const emailLink     = contactEmail !== "[FILL IN: email]"
    ? `[link=mailto:${contactEmail}]${contactEmail}[/link]` : "[FILL IN: email]";
  const membershipUrl = v(info.membership_url) || websiteUrl;
  const mapsQuery     = encodeURIComponent(name + (v(info.address) ? ", " + info.address : ", Ireland"));
  const mapsUrl       = `https://maps.google.com/?q=${mapsQuery}`;

  const locLines = buildLocLines(info, name, mapsUrl, emailLink);

  const joinMsg  = `We'd love to have you join ${name}! Membership is open to all ages and abilities.\n\nWe have options for:\n• Adult (Male & Female)\n• Student / Under 21\n• Juvenile (Under 16)\n• Family\n• OAP / Retired\n• Social / Non-playing\n\nTo register or find out more:\n\n🔗 [link=${membershipUrl}]${membershipUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\n📧 ${emailLink}`;
  const teamsMsg = `${name} competes across multiple codes:\n\n🏑 Senior Hurling\n⚽ Senior Football\n🏐 Ladies Football\n🏑 Camogie\n👶 Underage (all codes)\n\nFor squad news, training times, and more:\n\n🔗 [link=${websiteUrl}]${websiteUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]`;
  const fixMsg   = `For the latest fixtures, results, and county championship draws:\n\n🔗 [link=${websiteUrl}]${websiteUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nOr check your county board website for the full draw.`;
  const lottoMsg = `The ${name} Club Lotto runs every week — great prizes and all funds go directly to the club.\n\nTo buy tickets or check results:\n\n🔗 [link=${websiteUrl}]${websiteUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\n📧 ${emailLink}`;
  const youthMsg = `We cater for all ages from the youngest Go Games right through to Minor and Under 21.\n\n🏕️ We also host GAA Cúl Camps during the summer — a great way to get kids started.\n\nTo register a child or find out more:\n\n📧 ${emailLink}${v(info.phone) ? `\n📞 ${info.phone}` : ""}`;

  const { error: fErr } = await supabase.from("chat_workflows").insert([
    { id: fMain,  club_id: tenantId, name: "Main Menu",          is_active: true  },
    { id: fJoin,  club_id: tenantId, name: "Membership",         is_active: false },
    { id: fTeams, club_id: tenantId, name: "Our Teams",          is_active: false },
    { id: fFix,   club_id: tenantId, name: "Fixtures & Results", is_active: false },
    { id: fLotto, club_id: tenantId, name: "Club Lotto",         is_active: false },
    { id: fYouth, club_id: tenantId, name: "Underage & Cúl Camps", is_active: false },
    { id: fLoc,   club_id: tenantId, name: "Find Us",            is_active: false },
    { id: fOther, club_id: tenantId, name: "Other",              is_active: false },
  ]);
  if (fErr) { console.error("[gaa-seed] Flow insert error:", fErr.message); return false; }

  const { error: sErr } = await supabase.from("workflow_steps").insert([
    { id: sMain,  workflow_id: fMain,  step_order: 1, bot_message: `Hi there! 👋 Welcome to ${name} GAA. What can I help you with today?` },
    { id: sJoin,  workflow_id: fJoin,  step_order: 1, bot_message: joinMsg  },
    { id: sTeams, workflow_id: fTeams, step_order: 1, bot_message: teamsMsg },
    { id: sFix,   workflow_id: fFix,   step_order: 1, bot_message: fixMsg   },
    { id: sLotto, workflow_id: fLotto, step_order: 1, bot_message: lottoMsg },
    { id: sYouth, workflow_id: fYouth, step_order: 1, bot_message: youthMsg },
    { id: sLoc,   workflow_id: fLoc,   step_order: 1, bot_message: locLines },
    { id: sOther, workflow_id: fOther, step_order: 1, bot_message: `No problem! How else can I help?` },
  ]);
  if (sErr) { console.error("[gaa-seed] Step insert error:", sErr.message); return false; }

  const { error: cErr } = await supabase.from("workflow_choices").insert([
    { step_id: sMain,  choice_order: 1, label: "🏅 Membership",            action_type: "switch_flow",  action_value: fJoin  },
    { step_id: sMain,  choice_order: 2, label: "🏑 Our teams",             action_type: "switch_flow",  action_value: fTeams },
    { step_id: sMain,  choice_order: 3, label: "🏆 Fixtures & results",    action_type: "switch_flow",  action_value: fFix   },
    { step_id: sMain,  choice_order: 4, label: "🎰 Club Lotto",            action_type: "switch_flow",  action_value: fLotto },
    { step_id: sMain,  choice_order: 5, label: "👶 Underage & Cúl Camps",  action_type: "switch_flow",  action_value: fYouth },
    { step_id: sMain,  choice_order: 6, label: "📍 Find us",               action_type: "switch_flow",  action_value: fLoc   },
    { step_id: sMain,  choice_order: 7, label: "💬 Something else",        action_type: "switch_flow",  action_value: fOther },
    { step_id: sJoin,  choice_order: 1, label: "🌐 View membership info",  action_type: "url",          action_value: membershipUrl },
    { step_id: sJoin,  choice_order: 2, label: "✉️ Register interest",    action_type: "collect_lead", action_value: null          },
    { step_id: sJoin,  choice_order: 3, label: "← Back to menu",           action_type: "switch_flow",  action_value: fMain         },
    { step_id: sTeams, choice_order: 1, label: "🌐 Visit website",         action_type: "url",          action_value: websiteUrl },
    { step_id: sTeams, choice_order: 2, label: "💬 Ask me",                action_type: "ai_fallback",  action_value: null       },
    { step_id: sTeams, choice_order: 3, label: "← Back to menu",           action_type: "switch_flow",  action_value: fMain      },
    { step_id: sFix,   choice_order: 1, label: "🌐 View on website",       action_type: "url",          action_value: websiteUrl },
    { step_id: sFix,   choice_order: 2, label: "← Back to menu",           action_type: "switch_flow",  action_value: fMain      },
    { step_id: sLotto, choice_order: 1, label: "🌐 Buy lotto tickets",     action_type: "url",          action_value: websiteUrl },
    { step_id: sLotto, choice_order: 2, label: "← Back to menu",           action_type: "switch_flow",  action_value: fMain      },
    { step_id: sYouth, choice_order: 1, label: "✉️ Register a child",     action_type: "collect_lead", action_value: null   },
    { step_id: sYouth, choice_order: 2, label: "← Back to menu",           action_type: "switch_flow",  action_value: fMain  },
    { step_id: sLoc,   choice_order: 1, label: "📍 Get directions",        action_type: "url",          action_value: mapsUrl },
    { step_id: sLoc,   choice_order: 2, label: "← Back to menu",           action_type: "switch_flow",  action_value: fMain   },
    { step_id: sOther, choice_order: 1, label: "💬 I have a question",     action_type: "ai_fallback",  action_value: null  },
    { step_id: sOther, choice_order: 2, label: "📞 Contact us",            action_type: "message",      action_value: `Get in touch:${emailLink ? `\n\n📧 ${emailLink}` : ""}${v(info.phone) ? `\n📞 ${info.phone}` : ""}` },
    { step_id: sOther, choice_order: 3, label: "↩ Back to main menu",      action_type: "switch_flow",  action_value: fMain },
  ]);
  if (cErr) { console.error("[gaa-seed] Choice insert error:", cErr.message); return false; }

  console.log(`[gaa-seed] ✅ Seeded 8 GAA club flows for ${tenantId} (${name})`);
  return true;
}

// ── Seed café / coffee shop chat flows ────────────────────────────────────────
async function seedCafeFlows(tenantId, name, websiteUrl, info) {
  const { data: existing } = await supabase.from("chat_workflows").select("id").eq("club_id", tenantId).limit(1);
  if (existing && existing.length > 0) {
    console.log(`[cafe-seed] Flows already exist for ${tenantId}, skipping`);
    return false;
  }
  const v = (val) => (val && val !== "null") ? val : null;

  const fMain  = crypto.randomUUID(), fMenu  = crypto.randomUUID(), fHours = crypto.randomUUID();
  const fHire  = crypto.randomUUID(), fLoc   = crypto.randomUUID(), fOther = crypto.randomUUID();
  const sMain  = crypto.randomUUID(), sMenu  = crypto.randomUUID(), sHours = crypto.randomUUID();
  const sHire  = crypto.randomUUID(), sLoc   = crypto.randomUUID(), sOther = crypto.randomUUID();
  const fReview = crypto.randomUUID(), sReview = crypto.randomUUID();

  const contactEmail = v(info.email) || "[FILL IN: email]";
  const emailLink    = contactEmail !== "[FILL IN: email]"
    ? `[link=mailto:${contactEmail}]${contactEmail}[/link]` : "[FILL IN: email]";
  const mapsQuery    = encodeURIComponent(name + (v(info.address) ? ", " + info.address : ", Ireland"));
  const mapsUrl      = `https://maps.google.com/?q=${mapsQuery}`;

  const locLines = buildLocLines(info, name, mapsUrl, emailLink);

  const menuMsg  = `View our full menu online:\n\n🔗 [link=${websiteUrl}]${websiteUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nOr just ask — I'm happy to help with any questions about our food and drinks! ☕`;
  const hoursMsg = v(info.opening_hours)
    ? `🕐 Opening Hours\n\n${info.opening_hours}\n\n${locLines}\n\nDrop in anytime — we'd love to see you!`
    : `Our opening hours and location:\n\n${locLines}\n\nDrop in anytime — we'd love to see you!`;
  const hireMsg  = `We'd love to help you plan your event! Whether it's a private party, corporate breakfast, or celebration — get in touch with your details and we'll put something together:\n\n📧 ${emailLink}${v(info.phone) ? `\n📞 ${info.phone}` : ""}`;

  const { error: fErr } = await supabase.from("chat_workflows").insert([
    { id: fMain,   club_id: tenantId, name: "Main Menu",             is_active: true  },
    { id: fMenu,   club_id: tenantId, name: "Our Menu",              is_active: false },
    { id: fHours,  club_id: tenantId, name: "Opening Hours",         is_active: false },
    { id: fHire,   club_id: tenantId, name: "Events & Private Hire", is_active: false },
    { id: fLoc,    club_id: tenantId, name: "Find Us",               is_active: false },
    { id: fReview, club_id: tenantId, name: "Leave a Review",        is_active: false },
    { id: fOther,  club_id: tenantId, name: "Other",                 is_active: false },
  ]);
  if (fErr) { console.error("[cafe-seed] Flow insert error:", fErr.message); return false; }

  const { error: sErr } = await supabase.from("workflow_steps").insert([
    { id: sMain,   workflow_id: fMain,   step_order: 1, bot_message: `Hi there! ☕ Welcome to ${name}. What can I help you with?` },
    { id: sMenu,   workflow_id: fMenu,   step_order: 1, bot_message: menuMsg  },
    { id: sHours,  workflow_id: fHours,  step_order: 1, bot_message: hoursMsg },
    { id: sHire,   workflow_id: fHire,   step_order: 1, bot_message: hireMsg  },
    { id: sLoc,    workflow_id: fLoc,    step_order: 1, bot_message: locLines },
    { id: sReview, workflow_id: fReview, step_order: 1, bot_message: `We'd love to hear what you think! 🌟 Where would you like to leave a review?` },
    { id: sOther,  workflow_id: fOther,  step_order: 1, bot_message: `No problem! How else can I help?` },
  ]);
  if (sErr) { console.error("[cafe-seed] Step insert error:", sErr.message); return false; }

  // Review URLs — generic fallbacks, update via SQL after signup with exact URLs
  const googleReviewUrl    = `https://www.google.com/maps/search/${encodeURIComponent(name + ", Ireland")}`;
  const tripAdvisorReviewUrl = `https://www.tripadvisor.ie/Search?q=${encodeURIComponent(name + " Ireland")}`;

  const { error: cErr } = await supabase.from("workflow_choices").insert([
    { step_id: sMain,  choice_order: 1, label: "📋 View our menu",         action_type: "switch_flow", action_value: fMenu   },
    { step_id: sMain,  choice_order: 2, label: "🕐 Opening hours",         action_type: "switch_flow", action_value: fHours  },
    { step_id: sMain,  choice_order: 3, label: "🎂 Events & private hire", action_type: "switch_flow", action_value: fHire   },
    { step_id: sMain,  choice_order: 4, label: "📍 Find us",               action_type: "switch_flow", action_value: fLoc    },
    { step_id: sMain,  choice_order: 5, label: "⭐ Leave a review",        action_type: "switch_flow", action_value: fReview },
    { step_id: sMain,  choice_order: 6, label: "💬 Something else",        action_type: "switch_flow", action_value: fOther  },
    // Review sub-flow
    { step_id: sReview, choice_order: 1, label: "Leave a Google Review",     action_type: "url",         action_value: googleReviewUrl      },
    { step_id: sReview, choice_order: 2, label: "Leave a TripAdvisor Review", action_type: "url",         action_value: tripAdvisorReviewUrl },
    { step_id: sReview, choice_order: 3, label: "↩ Back to menu",            action_type: "switch_flow", action_value: fMain                },
    { step_id: sMenu,  choice_order: 1, label: "🌐 View menu",             action_type: "url",          action_value: websiteUrl },
    { step_id: sMenu,  choice_order: 2, label: "💬 Ask me anything",       action_type: "ai_fallback",  action_value: null       },
    { step_id: sMenu,  choice_order: 3, label: "← Back to menu",           action_type: "switch_flow",  action_value: fMain      },
    { step_id: sHours, choice_order: 1, label: "📍 Get directions",        action_type: "url",          action_value: mapsUrl },
    { step_id: sHours, choice_order: 2, label: "← Back to menu",           action_type: "switch_flow",  action_value: fMain   },
    { step_id: sHire,  choice_order: 1, label: "✉️ Send enquiry",         action_type: "collect_lead", action_value: null   },
    { step_id: sHire,  choice_order: 2, label: "← Back to menu",           action_type: "switch_flow",  action_value: fMain  },
    { step_id: sLoc,   choice_order: 1, label: "📍 Get directions",        action_type: "url",          action_value: mapsUrl },
    { step_id: sLoc,   choice_order: 2, label: "← Back to menu",           action_type: "switch_flow",  action_value: fMain   },
    // Other — guided sub-flow
    { step_id: sOther, choice_order: 1, label: "💬 I have a question", action_type: "ai_fallback", action_value: null  },
    { step_id: sOther, choice_order: 2, label: "📞 Contact us",        action_type: "message",     action_value: `Get in touch:${emailLink ? `\n\n📧 ${emailLink}` : ""}${v(info.phone) ? `\n📞 ${info.phone}` : ""}` },
    { step_id: sOther, choice_order: 3, label: "↩ Back to main menu",  action_type: "switch_flow", action_value: fMain },
  ]);
  if (cErr) { console.error("[cafe-seed] Choice insert error:", cErr.message); return false; }

  console.log(`[cafe-seed] ✅ Seeded 6 café flows for ${tenantId} (${name})`);
  return true;
}

async function seedGenericFlows(tenantId, name, websiteUrl, info) {
  const { data: existing } = await supabase.from("chat_workflows").select("id").eq("club_id", tenantId).limit(1);
  if (existing && existing.length > 0) {
    console.log(`[generic-seed] Flows already exist for ${tenantId}, skipping`);
    return false;
  }
  const v = (val) => (val && val !== "null") ? val : null;

  const fMain  = crypto.randomUUID(), fInfo    = crypto.randomUUID();
  const fContact = crypto.randomUUID(), fOther = crypto.randomUUID();
  const sMain  = crypto.randomUUID(), sInfo    = crypto.randomUUID();
  const sContact = crypto.randomUUID(), sOther = crypto.randomUUID();

  const contactEmail = v(info.email) || null;
  const emailLink    = contactEmail ? `[link=mailto:${contactEmail}]${contactEmail}[/link]` : null;
  const mapsQuery    = encodeURIComponent(name + (v(info.address) ? ", " + info.address : ", Ireland"));
  const mapsUrl      = `https://maps.google.com/?q=${mapsQuery}`;

  const contactLines = [
    emailLink       ? `📧 ${emailLink}` : null,
    v(info.phone)   ? `📞 ${info.phone}` : null,
    v(info.address) ? `📍 ${info.address}` : null,
  ].filter(Boolean).join("\n") || "Please visit our website for contact details.";

  const { error: fErr } = await supabase.from("chat_workflows").insert([
    { id: fMain,    club_id: tenantId, name: "Main Menu",  is_active: true  },
    { id: fInfo,    club_id: tenantId, name: "About Us",   is_active: false },
    { id: fContact, club_id: tenantId, name: "Contact Us", is_active: false },
    { id: fOther,   club_id: tenantId, name: "Other",      is_active: false },
  ]);
  if (fErr) { console.error("[generic-seed] Flow insert error:", fErr.message); return false; }

  const { error: sErr } = await supabase.from("workflow_steps").insert([
    { id: sMain,    workflow_id: fMain,    step_order: 1, bot_message: `Hi there! 👋 Welcome to ${name}. What can I help you with today?` },
    { id: sInfo,    workflow_id: fInfo,    step_order: 1, bot_message: `Here's a bit about us:\n\n${v(info.description) || `Visit our website to learn more about ${name}.`}\n\n🌐 [link=${websiteUrl}]${websiteUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]` },
    { id: sContact, workflow_id: fContact, step_order: 1, bot_message: `Here's how to reach us:\n\n${contactLines}` },
    { id: sOther,   workflow_id: fOther,   step_order: 1, bot_message: `No problem! How else can I help you?` },
  ]);
  if (sErr) { console.error("[generic-seed] Step insert error:", sErr.message); return false; }

  const { error: cErr } = await supabase.from("workflow_choices").insert([
    { step_id: sMain,    choice_order: 1, label: "💬 Ask a question",    action_type: "ai_fallback", action_value: null     },
    { step_id: sMain,    choice_order: 2, label: "ℹ️ About us",          action_type: "switch_flow", action_value: fInfo    },
    { step_id: sMain,    choice_order: 3, label: "📞 Contact us",        action_type: "switch_flow", action_value: fContact },
    { step_id: sMain,    choice_order: 4, label: "🌐 Visit website",     action_type: "url",         action_value: websiteUrl },
    { step_id: sMain,    choice_order: 5, label: "💬 Something else",    action_type: "switch_flow", action_value: fOther   },
    { step_id: sInfo,    choice_order: 1, label: "📞 Contact us",        action_type: "switch_flow", action_value: fContact },
    { step_id: sInfo,    choice_order: 2, label: "↩ Back to menu",       action_type: "switch_flow", action_value: fMain    },
    { step_id: sContact, choice_order: 1, label: "📍 Get directions",    action_type: "url",         action_value: mapsUrl  },
    { step_id: sContact, choice_order: 2, label: "↩ Back to menu",       action_type: "switch_flow", action_value: fMain    },
    { step_id: sOther,   choice_order: 1, label: "💬 I have a question", action_type: "ai_fallback", action_value: null     },
    { step_id: sOther,   choice_order: 2, label: "↩ Back to menu",       action_type: "switch_flow", action_value: fMain    },
  ]);
  if (cErr) { console.error("[generic-seed] Choice insert error:", cErr.message); return false; }

  console.log(`[generic-seed] ✅ Seeded 4 generic flows for ${tenantId} (${name})`);
  return true;
}

// ── Dispatcher: detect type, extract info, seed appropriate flows ─────────────
async function seedFlowsForType(tenantId, name, websiteUrl, bizType, pages) {
  if (bizType === "tennis_club") {
    const info = await extractTennisClubInfo(pages, websiteUrl);
    if (info.phone) supabase.from("tenants").update({ phone: info.phone }).eq("id", tenantId).then(() => {});
    return seedTennisClubFlows(tenantId, name, websiteUrl, info);
  }
  // All other types use the generic contact/location extractor
  const info = await extractGenericInfo(pages, websiteUrl);
  if (info.phone) supabase.from("tenants").update({ phone: info.phone }).eq("id", tenantId).then(() => {});
  switch (bizType) {
    case "fitness_studio":     return seedFitnessStudioFlows(tenantId, name, websiteUrl, info);
    case "golf_club":          return seedGolfClubFlows(tenantId, name, websiteUrl, info);
    case "racket_sports_club": return seedRacketSportsClubFlows(tenantId, name, websiteUrl, info);
    case "yoga_studio":        return seedYogaStudioFlows(tenantId, name, websiteUrl, info);
    case "swim_club":          return seedSwimClubFlows(tenantId, name, websiteUrl, info);
    case "gaa_club":           return seedGAAClubFlows(tenantId, name, websiteUrl, info);
    case "team_sports_club":   return seedTeamSportsClubFlows(tenantId, name, websiteUrl, info);
    case "cafe":               return seedCafeFlows(tenantId, name, websiteUrl, info);
    case "other":              return seedGenericFlows(tenantId, name, websiteUrl, info);
    default:
      console.log(`[seed] No template for business type '${bizType}' — skipping`);
      return false;
  }
}

async function extractPdfText(filePath) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const data = new Uint8Array(fs.readFileSync(filePath));

  // verbosity 0 = errors only — suppresses font/TT warnings that don't affect extraction
  const loadingTask = pdfjsLib.getDocument({ data, verbosity: 0 });
  const pdf = await loadingTask.promise;

  let text = "";

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    text += content.items.map(item => item.str).join(" ") + "\n";
  }

  return text.trim();
}

const mailTransporter = nodemailer.createTransport({
  host:   "smtp.gmail.com",
  port:   465,
  secure: true,
  family: 4,              // force IPv4 — Render blocks IPv6 to Google SMTP
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

let maeveIntroJustPlayed = false;

const KNOWLEDGE_DOCS_FILE = path.join(__dirname, "data", "knowledgeBaseDocuments.json");

function loadKnowledgeDocs() {
  try {
    if (!fs.existsSync(KNOWLEDGE_DOCS_FILE)) return [];
    return JSON.parse(fs.readFileSync(KNOWLEDGE_DOCS_FILE, "utf8"));
  } catch (err) {
    console.error("Error loading knowledge docs:", err);
    return [];
  }
}

function saveKnowledgeDocs(docs) {
  fs.writeFileSync(KNOWLEDGE_DOCS_FILE, JSON.stringify(docs, null, 2), "utf8");
}

// ── Integration Catalog ───────────────────────────────────────────────────────
// Sprimal-defined integrations. Fields drive the configure modal in the portal.
const INTEGRATION_CATALOG = [
  {
    provider:       "ebookingonline",
    name:           "ebookingonline.net",
    logo_html:      '<img src="/images/ebooking_logo.png" alt="ebookingonline.net" style="width:80px;height:56px;object-fit:contain;margin:0 auto;display:block;" onerror="this.outerHTML=\'<div style=&quot;width:56px;height:56px;border-radius:12px;background:#0066cc;display:flex;align-items:center;justify-content:center;color:white;font-weight:900;font-size:15px;font-family:sans-serif;margin:0 auto;&quot;>EBO</div>\'" />',
    description:    "Court booking & member management",
    business_types: ["tennis_club", "squash_club", "badminton_club"],
    coming_soon:    false,
    fields: [
      { key: "club_id",      label: "Club ID",              type: "text",     placeholder: "e.g. 100",        required: true,  hint: "Found in your EBO admin URL — e.g. ebookingonline.net/admin/100/..." },
      { key: "username",     label: "API Username",         type: "text",     placeholder: "e.g. AbCd1234XY", required: true,  hint: "From EBO Admin → API Credentials page (not your login email)" },
      { key: "password",     label: "API Password",         type: "password", placeholder: "••••••••",         required: true,  hint: "From EBO Admin → API Credentials page" },
      { key: "open_time",    label: "Courts open",          type: "text",     placeholder: "08:00",            required: false, hint: "First bookable slot, 24h format — only change if your club opens before 8am or after 9am" },
      { key: "close_time",   label: "Courts close",         type: "text",     placeholder: "22:00",            required: false, hint: "Last slot must end by this time, 24h format — e.g. 23:00 if courts close at 11pm" },
      { key: "slot_minutes", label: "Slot duration (mins)", type: "text",     placeholder: "60",               required: false, hint: "Length of each court booking — e.g. 60 or 75. Check your EBO booking page to confirm" }
    ]
  },
  {
    provider:       "twilio",
    name:           "Twilio WhatsApp",
    logo_html:      '<div style="width:56px;height:56px;border-radius:12px;background:#F22F46;display:flex;align-items:center;justify-content:center;margin:0 auto;"><svg viewBox="0 0 24 24" style="width:32px;height:32px;fill:white;"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 2.571c5.196 0 9.429 4.233 9.429 9.429S17.196 21.429 12 21.429 2.571 17.196 2.571 12 6.804 2.571 12 2.571zm-2.571 5.143a2.571 2.571 0 1 0 0 5.143 2.571 2.571 0 0 0 0-5.143zm5.142 0a2.571 2.571 0 1 0 0 5.143 2.571 2.571 0 0 0 0-5.143zm-5.142 5.715a2.571 2.571 0 1 0 0 5.142 2.571 2.571 0 0 0 0-5.142zm5.142 0a2.571 2.571 0 1 0 0 5.142 2.571 2.571 0 0 0 0-5.142z"/></svg></div>',
    description:    "Send WhatsApp messages to coaches and staff",
    business_types: null,
    coming_soon:    false,
    fields: [
      { key: "account_sid",  label: "Account SID",          type: "text",     placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", required: true,  hint: "From twilio.com/console — starts with AC" },
      { key: "auth_token",   label: "Auth Token",           type: "password", placeholder: "••••••••",                           required: true,  hint: "From twilio.com/console — keep this secret" },
      { key: "from_number",  label: "WhatsApp From number", type: "text",     placeholder: "whatsapp:+14155238886",               required: true,  hint: "Your Twilio WhatsApp-enabled number in whatsapp:+E.164 format" }
    ]
  },
  {
    provider:       "stripe",
    name:           "Stripe",
    logo_html:      '<div style="width:56px;height:56px;border-radius:12px;background:#635BFF;display:flex;align-items:center;justify-content:center;color:white;font-weight:900;font-size:28px;font-family:sans-serif;margin:0 auto;">S</div>',
    description:    "Accept payments and manage member subscriptions",
    business_types: null,
    coming_soon:    false,
    fields: [
      { key: "secret_key", label: "Secret Key", type: "password", placeholder: "sk_test_... or sk_live_...", required: true, hint: "From your Stripe Dashboard → Developers → API keys. Use sk_test_... for testing, sk_live_... for live." }
    ]
  },
  {
    provider:       "mailchimp",
    name:           "Mailchimp",
    logo_html:      '<div style="width:56px;height:56px;border-radius:12px;background:#FFE01B;display:flex;align-items:center;justify-content:center;font-size:30px;margin:0 auto;">🐒</div>',
    description:    "Email marketing and newsletters",
    business_types: ["tennis_club", "squash_club", "badminton_club", "gym", "yoga_studio", "pilates_studio", "crossfit_box", "swimming_club", "cycling_club", "running_club", "golf_club", "other"],
    coming_soon:    true,
    fields:         []
  },
  {
    provider:       "clubforce",
    name:           "Clubforce",
    logo_html:      '<div style="width:56px;height:56px;border-radius:12px;background:#0057A8;display:flex;align-items:center;justify-content:center;color:white;font-weight:900;font-size:13px;font-family:sans-serif;margin:0 auto;">CF</div>',
    description:    "Membership management and online payments for GAA clubs",
    business_types: ["gaa_club", "team_sports_club"],
    coming_soon:    true,
    fields:         []
  },
  {
    provider:       "foireann",
    name:           "Foireann",
    logo_html:      '<div style="width:56px;height:56px;border-radius:12px;background:#009A44;display:flex;align-items:center;justify-content:center;color:white;font-weight:900;font-size:13px;font-family:sans-serif;margin:0 auto;">GAA</div>',
    description:    "GAA player registration and club administration",
    business_types: ["gaa_club"],
    coming_soon:    true,
    fields:         []
  }
];

// ── EBO (ebookingonline.net) Court Booking Integration ────────────────────────
const EBO_BASE = "https://ebookingonline.net/api";

// Per-tenant EBO config cache — populated from tenant_integrations table via loadEboConfigFromDb()
// Do NOT hardcode club credentials here. Use the Integrations section in the portal instead.
const EBO_CONFIG = {};

// In-memory token cache: { [tenantId]: { token, expiresAt } }
// Inflight map prevents parallel requests both triggering a refresh simultaneously
const eboTokenCache    = {};
const eboTokenInflight = {};

async function getEboToken(tenantId) {
  const cfg = EBO_CONFIG[tenantId];
  if (!cfg || !cfg.username || !cfg.password) return null;

  const cached = eboTokenCache[tenantId];
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token; // valid with 1-min buffer

  // If a refresh is already in-flight, wait for it rather than firing a second one
  if (eboTokenInflight[tenantId]) return eboTokenInflight[tenantId];

  const form = new URLSearchParams();
  form.append("username", cfg.username);
  form.append("password", cfg.password);

  eboTokenInflight[tenantId] = fetch(`${EBO_BASE}/${cfg.clubId}/user/getToken`, {
    method: "POST",
    body: form
  })
    .then(r => { if (!r.ok) throw new Error(`EBO getToken HTTP ${r.status}`); return r.json(); })
    .then(data => {
      if (!data.token) throw new Error("EBO getToken: no token in response");
      eboTokenCache[tenantId] = { token: data.token, expiresAt: Date.now() + 2.5 * 60 * 60 * 1000 };
      console.log(`[EBO] Token refreshed for ${tenantId}`);
      return data.token;
    })
    .finally(() => { delete eboTokenInflight[tenantId]; });

  return eboTokenInflight[tenantId];
}

async function fetchEboBookings(tenantId, date, endDate, limit = 200) {
  const cfg = EBO_CONFIG[tenantId];
  if (!cfg) return [];
  const token = await getEboToken(tenantId);
  if (!token) return [];

  const params = new URLSearchParams({ date, end_date: endDate || date, confirmed: "1", limit: String(limit) });
  const resp = await fetch(`${EBO_BASE}/${cfg.clubId}/user/getBookings?${params}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`EBO getBookings HTTP ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

// EBO caps results at 200 regardless of limit param. Fetch in 7-day chunks to avoid the cap.
async function fetchEboBookingsPaged(tenantId, fromDate, toDate) {
  function addDays(dateStr, n) {
    const d = new Date(dateStr + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const allBookings = [];
  const seen = new Set();
  let cursor = fromDate;
  while (cursor <= toDate) {
    const chunkEnd = addDays(cursor, 6) > toDate ? toDate : addDays(cursor, 6);
    const chunk = await fetchEboBookings(tenantId, cursor, chunkEnd, 200).catch(() => []);
    for (const b of chunk) {
      const key = (b.time || "") + "|" + (b.court_id || "");
      if (!seen.has(key)) { seen.add(key); allBookings.push(b); }
    }
    cursor = addDays(cursor, 7);
  }
  return allBookings;
}

function buildEboAvailabilitySummary(bookings, dateLabel, cfg) {
  const openTime    = (cfg && cfg.openTime)    || "07:00";
  const closeTime   = (cfg && cfg.closeTime)   || "22:00";
  const slotMins    = (cfg && cfg.slotMinutes) || 60;

  function toMins(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }
  function toHHMM(mins) { return String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0"); }

  // Generate every valid slot start time for this venue
  const openMins  = toMins(openTime);
  const closeMins = toMins(closeTime);
  const allSlots  = [];
  for (let t = openMins; t + slotMins <= closeMins; t += slotMins) allSlots.push(toHHMM(t));

  if (!bookings.length) {
    // No bookings at all — all slots on all courts are free (we don't know court count, so say generally)
    return `${dateLabel}: No bookings found — all courts are free. Available slots: ${allSlots.map(s => s + "–" + toHHMM(toMins(s) + slotMins)).join(", ")}`;
  }

  // Build set of booked slot start times per court
  const bookedByCourt = {};
  bookings.forEach(b => {
    const id = String(b.court_id);
    if (!bookedByCourt[id]) bookedByCourt[id] = new Set();
    const hhmm = String(b.time || "").slice(11, 16); // extract "HH:MM" — no timezone conversion
    if (hhmm) bookedByCourt[id].add(hhmm);
  });

  // Compute free slots per court
  const lines = Object.entries(bookedByCourt)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, bookedSet]) => {
      const free = allSlots.filter(s => !bookedSet.has(s));
      if (!free.length) return `  Court ${id}: fully booked`;
      const slots = free.map(s => `${s}–${toHHMM(toMins(s) + slotMins)}`).join(", ");
      return `  Court ${id}: free at ${slots}`;
    });

  return `${dateLabel}:\n${lines.join("\n")}`;
}

// Load EBO config from tenant_integrations table into EBO_CONFIG cache
async function loadEboConfigFromDb(tenantId) {
  if (EBO_CONFIG[tenantId]) return; // already loaded (hardcoded or previously fetched)
  try {
    const { data } = await supabase
      .from("tenant_integrations")
      .select("config, is_active")
      .eq("tenant_id", tenantId)
      .eq("provider", "ebookingonline")
      .maybeSingle();
    if (data?.is_active && data.config?.club_id) {
      const cfg = decryptIntgConfig(data.config);
      if (!cfg.username || !cfg.password) return; // incomplete credentials
      EBO_CONFIG[tenantId] = {
        clubId:      cfg.club_id,
        username:    cfg.username,
        password:    cfg.password,
        openTime:    cfg.open_time    || "08:00",
        closeTime:   cfg.close_time   || "22:00",
        slotMinutes: parseInt(cfg.slot_minutes || "60", 10)
      };
      console.log(`[EBO] Config loaded from DB for ${tenantId}`);
    }
  } catch (err) {
    console.error(`[EBO] DB config load failed for ${tenantId}:`, err.message);
  }
}

// ── Twilio WhatsApp Integration ───────────────────────────────────────────────
// Per-tenant Twilio config cache — populated from tenant_integrations table
const TWILIO_CONFIG = {};

async function loadTwilioConfigFromDb(tenantId) {
  if (TWILIO_CONFIG[tenantId]) return;
  try {
    const { data } = await supabase
      .from("tenant_integrations")
      .select("config, is_active")
      .eq("tenant_id", tenantId)
      .eq("provider", "twilio")
      .maybeSingle();
    if (data?.is_active && data.config?.account_sid) {
      const cfg = decryptIntgConfig(data.config);
      if (!cfg.auth_token || !cfg.from_number) return;
      TWILIO_CONFIG[tenantId] = {
        accountSid: cfg.account_sid,
        authToken:  cfg.auth_token,
        from:       cfg.from_number
      };
      console.log(`[Twilio] Config loaded from DB for ${tenantId}`);
    }
  } catch (err) {
    console.error(`[Twilio] DB config load failed for ${tenantId}:`, err.message);
  }
}

// Keywords that trigger a live EBO lookup
const EBO_TRIGGER = /\b(court|book|available|availab|free slot|session|tennis|reserve|tonight|today|tomorrow|when|slot|time|play)\b/i;

async function maybeGetEboContext(tenantId, message) {
  if (!EBO_TRIGGER.test(message)) return null;
  await loadEboConfigFromDb(tenantId); // no-op if already in EBO_CONFIG
  if (!EBO_CONFIG[tenantId]) return null;

  try {
    // Use Irish time (Europe/Dublin) for date calculation so midnight doesn't
    // roll us onto the wrong day when the Render server is in UTC.
    const now = new Date();
    const irishDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(now); // "YYYY-MM-DD"
    const tomorrowDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" })
      .format(new Date(now.getTime() + 86400000));

    const [todayBookings, tomorrowBookings] = await Promise.all([
      fetchEboBookings(tenantId, irishDate),
      fetchEboBookings(tenantId, tomorrowDate)
    ]);

    const cfg           = EBO_CONFIG[tenantId];
    const todayLabel    = `Today (${irishDate})`;
    const tomorrowLabel = `Tomorrow (${tomorrowDate})`;

    // Prepend the real date so the AI can't use a stale assumption
    const humanDate = now.toLocaleDateString("en-IE", {
      timeZone: "Europe/Dublin", weekday: "long", day: "numeric", month: "long", year: "numeric"
    });

    return `CURRENT DATE: ${humanDate}\n\nLIVE COURT AVAILABILITY (free slots only — already computed, do not recalculate):\n`
      + buildEboAvailabilitySummary(todayBookings, todayLabel, cfg)
      + "\n\n"
      + buildEboAvailabilitySummary(tomorrowBookings, tomorrowLabel, cfg);

  } catch (err) {
    console.error("[EBO] Context fetch error:", err.message);
    return null; // fail silently — chatbot answers from KB only
  }
}

// ── EBO Personal Bookings — Email OTP verification ───────────────────────────
const eboOtpStore    = {}; // { [email]: { code, expiresAt, membershipNumber, memberName } }
const eboMemberCache = {}; // { [tenantId]: { members: [], cachedAt } }

async function getAllEboMembers(tenantId) {
  const cfg = EBO_CONFIG[tenantId];
  if (!cfg) return [];

  const cached = eboMemberCache[tenantId];
  if (cached && Date.now() - cached.cachedAt < 30 * 60 * 1000) return cached.members;

  const token = await getEboToken(tenantId);
  if (!token) return [];

  const resp = await fetch(`${EBO_BASE}/${cfg.clubId}/user/listMembers?active=true&limit=5000`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`EBO listMembers HTTP ${resp.status}`);
  const data = await resp.json();
  const members = Array.isArray(data) ? data : [];
  eboMemberCache[tenantId] = { members, cachedAt: Date.now() };
  console.log(`[EBO] Cached ${members.length} members for ${tenantId}`);
  return members;
}

async function lookupEboMemberByEmail(tenantId, email) {
  const members = await getAllEboMembers(tenantId);
  const norm = email.toLowerCase().trim();
  return members.find(m => m.email && m.email.toLowerCase().trim() === norm) || null;
}

async function fetchEboMemberDetails(tenantId, membershipNumber) {
  const cfg = EBO_CONFIG[tenantId];
  if (!cfg) return null;
  const token = await getEboToken(tenantId);
  if (!token) return null;
  const resp = await fetch(`${EBO_BASE}/${cfg.clubId}/user/listMembers/${membershipNumber}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  // Endpoint returns an array even for single members
  return Array.isArray(data) && data.length ? data[0] : (data || null);
}

async function sendEboOtp(toEmail, firstName, code, clubName) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[EBO OTP] RESEND_API_KEY not set — skipping OTP email");
    return;
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from:    "Maeve <maeve@sprimal.com>",
      to:      [toEmail],
      subject: `Your ${clubName} verification code`,
      text:    `Hi ${firstName},\n\nYour verification code is:\n\n${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.\n\nMaeve`
    })
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[EBO OTP] Email failed: ${resp.status} — ${body}`);
  } else {
    console.log(`[EBO OTP] Code sent to ${toEmail}`);
  }
}

async function fetchMemberPersonalBookings(tenantId, membershipNumber, memberName, clubName) {
  const cfg = EBO_CONFIG[tenantId];
  if (!cfg) return "Sorry, the booking system isn't available right now.";

  const now = new Date();
  const fromDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(now);
  const toDate   = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" })
    .format(new Date(now.getTime() + 30 * 86400000));

  const bookings = await fetchEboBookings(tenantId, fromDate, toDate, 1000);

  const mine = bookings.filter(b =>
    Array.isArray(b.bookedMembers) &&
    b.bookedMembers.some(m => Number(m.membership_number) === Number(membershipNumber))
  );

  const firstName = (memberName || "").split(" ")[0] || "there";

  if (!mine.length) {
    return `Hi ${firstName} — I don't see any upcoming bookings for you in the next 30 days. You can make a booking through the ${clubName} booking page.`;
  }

  const slotMins = cfg.slotMinutes || 60;

  function toHHMM(totalMins) {
    return String(Math.floor(totalMins / 60)).padStart(2, "0") + ":" + String(totalMins % 60).padStart(2, "0");
  }
  function fmtDate(timeStr) {
    // "2026-06-05 18:00:00" → "Friday 5 June"
    const d = new Date(timeStr.slice(0, 10) + "T12:00:00Z");
    return d.toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long" });
  }

  function formatCoPlayers(booking) {
    if (!Array.isArray(booking.bookedMembers)) return "";
    const others = booking.bookedMembers.filter(m => Number(m.membership_number) !== Number(membershipNumber));
    if (!others.length) return " (solo / no co-players listed)";
    const names = others.map(m => {
      if (Number(m.membership_number) === 1) return m.guest_name || "Guest";
      return m.name || "Unknown";
    });
    return " with " + names.join(" & ");
  }

  const lines = mine.map(b => {
    const start        = b.time.slice(11, 16);
    const [hh, mm]     = start.split(":").map(Number);
    const endTime      = toHHMM(hh * 60 + mm + slotMins);
    const coPlayers    = formatCoPlayers(b);
    return `• ${fmtDate(b.time)}, Court ${b.court_id}, ${start}–${endTime}${coPlayers}`;
  });

  return `Here are your upcoming bookings, ${firstName}:\n\n${lines.join("\n")}\n\nTo cancel or change a booking please visit the ${clubName} booking page.`;
}

const EBO_PERSONAL_TRIGGER = /\b(my\s+bookings?|my\s+reserv|my\s+sessions?|my\s+courts?|my\s+upcoming|my\s+schedule|my\s+match|what\s+bookings?|bookings?.*do\s+i|bookings?.*i\s+have|do\s+i\s+have.*book|have\s+i.*book|i\s+have.*booked|i'?ve\s+booked|i\s+booked|courts?.*do\s+i\s+have|what.*courts?.*do\s+i|cancel.*my\s+book|show.*my\s+book|view.*my\s+book|when.*i'?m?\s+(next\s+)?playing|when\s+(am\s+i|do\s+i)\s+play|my\s+next\s+(game|match|session|court|play)|next\s+time\s+i\s+play|when\s+i\s+play\s+next|i'?d\s+like.*when.*play|when\s+is\s+my\s+next)/i;

async function handleEboPersonalFlow(convo, message, tenantId, clubName) {
  if (!EBO_CONFIG[tenantId]) return { handled: false };

  const isPersonalQuery = EBO_PERSONAL_TRIGGER.test(message);

  // ── Mid-flow: waiting for email ──────────────────────────────────
  if (convo.eboAuthStep === "awaiting_email") {
    const email = message.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { handled: true, reply: "That doesn't look like a valid email address — could you try again?" };
    }
    try {
      const member = await lookupEboMemberByEmail(tenantId, email);
      if (!member) {
        return { handled: true, reply: `I couldn't find a ${clubName} account with that email. Could you double-check it? Try the address you used when you joined the club.` };
      }
      const code = String(Math.floor(1000 + Math.random() * 9000));
      eboOtpStore[email.toLowerCase()] = {
        code,
        expiresAt:        Date.now() + 10 * 60 * 1000,
        membershipNumber: member.membership_number,
        memberName:       `${member.first_name || ""} ${member.last_name || ""}`.trim()
      };
      await sendEboOtp(email, member.first_name || "there", code, clubName);
      convo.eboAuthStep  = "awaiting_code";
      convo.eboAuthEmail = email.toLowerCase();
      return { handled: true, reply: `I've sent a 6-digit verification code to ${email} — what is it?` };
    } catch (err) {
      console.error("[EBO OTP] Lookup/send error:", err.message);
      return { handled: true, reply: "Sorry, something went wrong looking up your account. Please try again in a moment." };
    }
  }

  // ── Mid-flow: waiting for OTP code ───────────────────────────────
  if (convo.eboAuthStep === "awaiting_code") {
    const entered = message.trim().replace(/\s+/g, "");
    const stored  = convo.eboAuthEmail && eboOtpStore[convo.eboAuthEmail];

    if (!stored || Date.now() > stored.expiresAt) {
      delete eboOtpStore[convo.eboAuthEmail];
      convo.eboAuthStep = "awaiting_email";
      return { handled: true, reply: "That code has expired. What's your email address so I can send a fresh one?" };
    }
    if (entered !== stored.code) {
      return { handled: true, reply: "That code doesn't match — please check the email and try again." };
    }

    // ✓ Verified
    convo.eboAuthStep         = "verified";
    convo.eboMembershipNumber = stored.membershipNumber;
    convo.eboMemberName       = stored.memberName;
    delete eboOtpStore[convo.eboAuthEmail];
    console.log(`[EBO OTP] Verified: ${convo.eboMemberName} (${convo.eboMembershipNumber})`);

    // Fetch full member record in background to capture any extra fields (e.g. balance)
    fetchEboMemberDetails(tenantId, stored.membershipNumber)
      .then(details => { if (details) convo.eboMemberDetails = details; })
      .catch(() => {});

    try {
      const reply = await fetchMemberPersonalBookings(tenantId, stored.membershipNumber, stored.memberName, clubName);
      return { handled: true, reply };
    } catch (err) {
      console.error("[EBO] Personal bookings error:", err.message);
      return { handled: true, reply: `Verified! But I couldn't load your bookings just now — please try again in a moment.` };
    }
  }

  // ── Already verified — answer personal detail questions ────────
  if (convo.eboAuthStep === "verified") {
    const firstName = (convo.eboMemberName || "").split(" ")[0];
    const lc = message.toLowerCase();

    // Name questions
    if (/\bmy name\b|what.*(am i|is my name)|who am i/i.test(message)) {
      return { handled: true, reply: `You're logged in as ${convo.eboMemberName}.` };
    }

    // Membership number questions
    if (/\bmy membership\b|\bmember(ship)?\s*number\b|\bmy number\b|\bmy (member|club)\s*id\b/i.test(message)) {
      return { handled: true, reply: `Your membership number is ${convo.eboMembershipNumber}, ${firstName}.` };
    }

    // Co-player / next booking questions
    if (/\b(who.*playing|playing with|playing partner|doubles partner|next booking|my next|who.*booked with|who.*court with|when.*i'?m?\s+(next\s+)?playing|when\s+(am\s+i|do\s+i)\s+play|my\s+next\s+(game|match|session)|next\s+time\s+i\s+play|when\s+i\s+play\s+next|when\s+is\s+my\s+next|i'?d\s+like.*when.*play)\b/i.test(message)) {
      try {
        const now = new Date();
        const fromDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(now);
        const toDate   = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" })
          .format(new Date(now.getTime() + 30 * 86400000));
        const bookings = await fetchEboBookings(tenantId, fromDate, toDate, 1000);
        const cfg = EBO_CONFIG[tenantId];
        const slotMins = (cfg && cfg.slotMinutes) || 60;

        const mine = bookings
          .filter(b => Array.isArray(b.bookedMembers) && b.bookedMembers.some(m => Number(m.membership_number) === Number(convo.eboMembershipNumber)))
          .sort((a, b) => a.time.localeCompare(b.time));

        if (!mine.length) {
          return { handled: true, reply: `You don't have any upcoming bookings, ${firstName}.` };
        }

        const next = mine[0];
        const start = next.time.slice(11, 16);
        const [hh, mm] = start.split(":").map(Number);
        function toHHMM(t) { return String(Math.floor(t/60)).padStart(2,"0")+":"+String(t%60).padStart(2,"0"); }
        const endTime = toHHMM(hh * 60 + mm + slotMins);
        const d = new Date(next.time.slice(0, 10) + "T12:00:00Z");
        const dateStr = d.toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long" });

        const others = (next.bookedMembers || []).filter(m => Number(m.membership_number) !== Number(convo.eboMembershipNumber));
        let coPlayersStr;
        if (!others.length) {
          coPlayersStr = "No co-players are listed for this booking yet.";
        } else {
          const names = others.map(m => Number(m.membership_number) === 1 ? (m.guest_name || "a Guest") : (m.name || "Unknown"));
          coPlayersStr = `You're playing with ${names.join(" and ")}.`;
        }

        return { handled: true, reply: `Your next booking is Court ${next.court_id} on ${dateStr} at ${start}–${endTime}.\n\n${coPlayersStr}` };
      } catch (err) {
        return { handled: true, reply: "Sorry, I couldn't check your bookings right now — please try again." };
      }
    }

    // Membership type / Stripe subscription questions
    if (/\b(membership type|my membership|what (membership|plan|subscription)|my (plan|subscription)|what am i (paying|a member)|when.*renew|renew|expire|expir|membership status|am i (a member|active)|membership fee|how much.*membership|manage.*membership|update.*membership|change.*membership|cancel.*membership)\b/i.test(message)) {
      const email = convo.eboAuthEmail;
      if (!email) return { handled: true, reply: "I don't have your email on file for this session — please refresh and verify again." };
      try {
        const stripe = await fetchStripeMembership(email);
        if (!stripe || !stripe.found) {
          return { handled: true, reply: `I couldn't find a Stripe account linked to ${email}. The club may process your membership separately — please contact the secretary.` };
        }

        // Handle manage/cancel/update → send portal link
        if (/\b(manage|update|change|cancel|renew)\b/i.test(message)) {
          const portalUrl = await generateStripePortalLink(email);
          if (portalUrl) {
            return { handled: true, reply: `Here's your membership management link, ${firstName}. It's single-use and expires shortly:\n\n${portalUrl}` };
          }
          return { handled: true, reply: "Sorry, I couldn't generate a management link right now — please contact the club secretary." };
        }

        if (stripe.noActiveSub || !stripe.subscriptions.length) {
          return { handled: true, reply: `${firstName}, I don't see an active membership subscription in Stripe for your account. Please contact the club secretary to check your membership status.` };
        }

        const lines = stripe.subscriptions.map(sub => {
          const item  = sub.items && sub.items.data && sub.items.data[0];
          const price = item && item.price;
          const product = price && price.product;
          const name    = (product && (product.name || product.id)) || "Membership";
          const amount  = price && price.unit_amount != null ? "€" + (price.unit_amount / 100).toFixed(2) : null;
          const interval = price && price.recurring ? price.recurring.interval : null;
          const renewsOn = sub.current_period_end ? formatStripeDate(sub.current_period_end) : null;
          const status   = sub.status === "active" ? "Active" : sub.status;

          let line = `${name} — ${status}`;
          if (amount && interval) line += ` (${amount}/${interval})`;
          if (renewsOn) line += `. Renews ${renewsOn}.`;
          return line;
        });

        return { handled: true, reply: `Here's your membership info, ${firstName}:\n\n${lines.join("\n")}\n\nTo manage or update your membership, just ask me for a management link.` };
      } catch (err) {
        console.error("[Stripe] Membership query error:", err.message);
        return { handled: true, reply: "Sorry, I couldn't retrieve your membership details right now — please try again in a moment." };
      }
    }

    // Balance / top-up questions
    if (/\b(balance|top.?up|credit|wallet|account.*balance|how much.*have i|what.*i.*have.*left)\b/i.test(message)) {
      const d = convo.eboMemberDetails || {};
      // Look for any balance-related field EBO might return
      const bal = d.balance ?? d.topup ?? d.credit ?? d.credits ?? d.wallet ?? d.account_balance ?? d.top_up ?? null;
      if (bal !== null && bal !== undefined) {
        return { handled: true, reply: `Your current top-up balance is €${Number(bal).toFixed(2)}, ${firstName}.` };
      }
      // Field not in API response — log the actual keys so we can see what's available
      console.log(`[EBO] Member details fields for ${convo.eboMembershipNumber}:`, Object.keys(d));
      return { handled: true, reply: `I can see your account details but the balance field isn't available through the current API. The club may need to enable that — or you can check your balance by logging into the ${clubName} booking portal directly.` };
    }

    // Booking queries
    if (isPersonalQuery) {
      try {
        const reply = await fetchMemberPersonalBookings(tenantId, convo.eboMembershipNumber, convo.eboMemberName, clubName);
        return { handled: true, reply };
      } catch (err) {
        return { handled: true, reply: "Sorry, I couldn't load your bookings right now — please try again." };
      }
    }
  }

  // ── New personal query — start the flow ─────────────────────────
  if (isPersonalQuery) {
    convo.eboAuthStep = "awaiting_email";
    return { handled: true, reply: `Sure! To show your bookings I'll need to verify it's you first. What's the email address on your ${clubName} account?` };
  }

  return { handled: false };
}

// ── Membership Change Flow ────────────────────────────────────────────────────
const MEMBERSHIP_CHANGE_TRIGGER = /\b(change|cancel|downgrade|upgrade|amend|modify|switch)\b.{0,30}\b(membership|subscription|plan|account)\b|\b(membership|subscription)\b.{0,20}\b(change|cancel|downgrade|upgrade|cancel)\b|\bleave the club\b|\bfamily.{0,15}single\b|\bsingle.{0,15}family\b|\bmembership.*cancel\b|\bcancel.*memb/i;

async function handleMembershipChangeFlow(convo, message, tenantId, clubName) {
  const lc = message.toLowerCase().trim();

  // Detect initial intent
  if (!convo.memberChangeStep && MEMBERSHIP_CHANGE_TRIGGER.test(message)) {
    convo.memberChangeStep = "awaiting_change_type";
    convo.memberChangeData = {};
    return {
      handled: true,
      reply: `I can help with that. What type of change are you looking for?`,
      choices: ["Cancel membership", "Change membership type", "Other change"]
    };
  }

  if (!convo.memberChangeStep) return { handled: false };

  // Allow cancel at any step
  if (/^(cancel|stop|exit|never mind|no thanks|forget it)$/i.test(lc)) {
    convo.memberChangeStep = null;
    convo.memberChangeData = null;
    return { handled: true, reply: "No problem — your request hasn't been submitted. Let me know if there's anything else I can help with!" };
  }

  const data = convo.memberChangeData || {};

  switch (convo.memberChangeStep) {

    case "awaiting_change_type": {
      data.changeType = message;
      convo.memberChangeData = data;

      // If "Change membership type" — fetch Stripe products and ask current type first
      if (/change membership type/i.test(message)) {
        convo.memberChangeStep = "awaiting_current_type";
        try {
          const { data: intg } = await supabase
            .from("tenant_integrations")
            .select("config, is_active")
            .eq("tenant_id", tenantId)
            .eq("provider", "stripe")
            .maybeSingle();
          if (intg?.is_active && intg.config) {
            const cfg = decryptIntgConfig(intg.config);
            if (cfg.secret_key) {
              const authHeader = "Basic " + Buffer.from(cfg.secret_key + ":").toString("base64");
              const prodResp = await fetch("https://api.stripe.com/v1/products?limit=100&active=true", {
                headers: { Authorization: authHeader }
              });
              const prodData = await prodResp.json();
              const productNames = (prodData.data || [])
                .map(p => p.name)
                .filter(Boolean)
                .sort();
              if (productNames.length) {
                convo.stripeProductNames = productNames;
                return {
                  handled: true,
                  reply: `What is your current membership type?`,
                  choices: productNames.slice(0, 4)
                };
              }
            }
          }
        } catch (e) {
          console.error("[MemberChange] Stripe product fetch error:", e.message);
        }
        return { handled: true, reply: `What is your current membership type?` };
      }

      // If already EBO verified in this session — use existing auth data, skip details step
      if (convo.eboAuthStep === "verified") {
        data.memberName       = convo.eboMemberName;
        data.membershipNumber = String(convo.eboMembershipNumber);
        data.memberEmail      = convo.eboAuthEmail || null;
        convo.memberChangeData = data;
        if (/family|single/i.test(data.targetType || "")) {
          convo.memberChangeStep = "awaiting_family_members";
          return { handled: true, reply: `Got it. Who else is currently on your family membership? Please list their names separated by commas.` };
        }
        convo.memberChangeStep = "awaiting_effective_date";
        return { handled: true, reply: `When would you like this change to take effect? (e.g. 1 August 2026)` };
      }

      convo.memberChangeStep = "awaiting_member_details";
      return { handled: true, reply: `What's your name and EBO membership number? (e.g. Mary Murphy, 4821)` };
    }

    case "awaiting_current_type": {
      data.currentType = message.trim();
      convo.memberChangeData = data;
      convo.memberChangeStep = "awaiting_target_type";
      // Show target type choices excluding the current type
      const allProducts = convo.stripeProductNames || [];
      const targetChoices = allProducts.filter(function(n) {
        return n.toLowerCase() !== data.currentType.toLowerCase();
      }).slice(0, 4);
      return {
        handled: true,
        reply: `What would you like to change to?`,
        choices: targetChoices.length ? targetChoices : undefined
      };
    }

    case "awaiting_target_type": {
      data.targetType = message.trim();
      convo.memberChangeData = data;

      // If already EBO verified — skip member details
      if (convo.eboAuthStep === "verified") {
        data.memberName       = convo.eboMemberName;
        data.membershipNumber = String(convo.eboMembershipNumber);
        data.memberEmail      = convo.eboAuthEmail || null;
        convo.memberChangeData = data;
        if (/family/i.test(data.targetType)) {
          convo.memberChangeStep = "awaiting_family_members";
          return { handled: true, reply: `Who else will be on the family membership? Please list their names separated by commas.` };
        }
        convo.memberChangeStep = "awaiting_effective_date";
        return { handled: true, reply: `When would you like this change to take effect? (e.g. 1 August 2026)` };
      }

      convo.memberChangeStep = "awaiting_member_details";
      return { handled: true, reply: `What's your name and EBO membership number? (e.g. Mary Murphy, 4821)` };
    }

    case "awaiting_member_details": {
      const numMatch  = message.match(/\b(\d{3,6})\b/);
      const namePart  = message.replace(/\d+/g, "").replace(/,/g, " ").replace(/\s+/g, " ").trim();
      data.membershipNumber = numMatch ? numMatch[1] : null;
      data.memberName       = namePart || message;
      convo.memberChangeData = data;
      convo.memberChangeStep = "awaiting_email";
      return { handled: true, reply: `What's the email address on your ${clubName} account?` };
    }

    case "awaiting_email": {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.trim())) {
        return { handled: true, reply: `That doesn't look like a valid email address — could you try again?` };
      }
      data.memberEmail = message.trim().toLowerCase();
      convo.memberChangeData = data;
      if (/family|single/i.test(data.changeType || "")) {
        convo.memberChangeStep = "awaiting_family_members";
        return { handled: true, reply: `Who else is currently on your family membership? Please list their names separated by commas.` };
      }
      convo.memberChangeStep = "awaiting_effective_date";
      return { handled: true, reply: `When would you like this change to take effect? (e.g. 1 August 2026)` };
    }

    case "awaiting_family_members": {
      const names = message.split(/[\n,]|\band\b/i).map(n => n.trim()).filter(Boolean);
      data.familyMembers = names;
      convo.memberChangeData = data;
      convo.memberChangeStep = "awaiting_effective_date";
      return { handled: true, reply: `When would you like this change to take effect? (e.g. 1 August 2026)` };
    }

    case "awaiting_effective_date": {
      data.effectiveDate = message;
      convo.memberChangeData = data;
      convo.memberChangeStep = "awaiting_reason";
      return { handled: true, reply: `Is there a reason for the change? (optional — type 'skip' to leave this blank)` };
    }

    case "awaiting_reason": {
      data.reason = /^skip$/i.test(lc) ? null : message;
      convo.memberChangeData = data;

      // Build confirmation summary
      let summary = `Here's a summary of your request:\n\n`;
      summary += `Change: ${data.changeType}\n`;
      if (data.targetType) summary += `New membership type: ${data.targetType}\n`;
      summary += `Name: ${data.memberName}`;
      if (data.membershipNumber) summary += ` (#${data.membershipNumber})`;
      summary += `\n`;
      if (data.memberEmail) summary += `Email: ${data.memberEmail}\n`;
      if (data.familyMembers && data.familyMembers.length > 0) {
        summary += `Family members leaving: ${data.familyMembers.join(", ")}\n`;
      }
      summary += `Effective: ${data.effectiveDate}\n`;
      if (data.reason) summary += `Reason: ${data.reason}\n`;
      summary += `\nShall I submit this to the ${clubName} committee for review?`;

      convo.memberChangeStep = "awaiting_confirm";
      return { handled: true, reply: summary, choices: ["Yes, submit request", "No, cancel"] };
    }

    case "awaiting_confirm": {
      if (/\bno\b|cancel|don't|dont/i.test(lc)) {
        convo.memberChangeStep = null;
        convo.memberChangeData = null;
        return { handled: true, reply: "No problem — your request has not been submitted. Let me know if there's anything else I can help with." };
      }

      try {
        let effectiveDateIso = null;
        try {
          const parsed = new Date(data.effectiveDate);
          if (!isNaN(parsed)) effectiveDateIso = parsed.toISOString().slice(0, 10);
        } catch {}

        await supabase.from("membership_requests").insert({
          tenant_id:               tenantId,
          member_name:             data.memberName       || "Unknown",
          membership_number:       data.membershipNumber || null,
          member_email:            data.memberEmail      || null,
          requested_type:          data.changeType       || null,
          current_type:            data.currentType      || null,
          target_membership_type:  data.targetType       || null,
          effective_date:          effectiveDateIso,
          reason:                  data.reason           || null,
          family_members_leaving:  data.familyMembers    || []
        });

        convo.memberChangeStep = null;
        convo.memberChangeData = null;
        return {
          handled: true,
          reply: `✅ Your request has been submitted to the ${clubName} committee. They'll review it and be in touch within 2 business days.\n\nIs there anything else I can help with?`
        };
      } catch (err) {
        console.error("[MemberChange] Insert error:", err.message);
        convo.memberChangeStep = null;
        convo.memberChangeData = null;
        return { handled: true, reply: `Sorry, something went wrong submitting your request. Please contact the club directly.` };
      }
    }
  }

  return { handled: false };
}

// ── Stripe Membership Integration ────────────────────────────────────────────
const STRIPE_BASE = "https://api.stripe.com/v1";

function stripeAuthHeader() {
  return "Basic " + Buffer.from((process.env.STRIPE_SECRET_KEY || "") + ":").toString("base64");
}

async function stripeGet(path) {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const resp = await fetch(STRIPE_BASE + path, { headers: { Authorization: stripeAuthHeader() } });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error("Stripe " + resp.status + ": " + (e.error && e.error.message || resp.statusText));
  }
  return resp.json();
}

async function stripePost(path, body) {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const resp = await fetch(STRIPE_BASE + path, {
    method: "POST",
    headers: { Authorization: stripeAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString()
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error("Stripe " + resp.status + ": " + (e.error && e.error.message || resp.statusText));
  }
  return resp.json();
}

async function fetchStripeMembership(email) {
  if (!process.env.STRIPE_SECRET_KEY) return null;

  // Find Stripe customer by email
  const customers = await stripeGet("/customers?email=" + encodeURIComponent(email) + "&limit=1");
  if (!customers || !customers.data || !customers.data.length) return { found: false };

  const customer = customers.data[0];

  // Fetch active subscriptions, expanding to get product name in one call
  const subs = await stripeGet(
    "/subscriptions?customer=" + customer.id +
    "&status=active&limit=5" +
    "&expand[]=data.items.data.price.product"
  );

  if (!subs || !subs.data || !subs.data.length) {
    // No active sub — check all statuses so we can report accurately
    const allSubs = await stripeGet("/subscriptions?customer=" + customer.id + "&limit=5");
    return { found: true, customer, subscriptions: (allSubs && allSubs.data) || [], noActiveSub: true };
  }

  return { found: true, customer, subscriptions: subs.data, noActiveSub: false };
}

async function generateStripePortalLink(email) {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const customers = await stripeGet("/customers?email=" + encodeURIComponent(email) + "&limit=1");
  if (!customers || !customers.data || !customers.data.length) return null;
  const session = await stripePost("/billing_portal/sessions", {
    customer: customers.data[0].id,
    return_url: "https://monkstowntennisclub.com"
  });
  return session && session.url ? session.url : null;
}

function formatStripeDate(unixTs) {
  return new Date(unixTs * 1000).toLocaleDateString("en-IE", { day: "numeric", month: "long", year: "numeric" });
}

// ── Sprimal SaaS Billing — Sprimal charges its own tenants ───────────────────
function sprimalStripe() {
  return require("stripe")(process.env.SPRIMAL_STRIPE_KEY);
}

async function getOrCreateSprimalCustomer(tenantId, tenantName, email) {
  const { data: tenant } = await supabase.from("tenants").select("stripe_customer_id").eq("id", tenantId).maybeSingle();
  if (tenant?.stripe_customer_id) return tenant.stripe_customer_id;
  const stripe   = sprimalStripe();
  const customer = await stripe.customers.create({ email, name: tenantName, metadata: { tenant_id: tenantId } });
  await supabase.from("tenants").update({ stripe_customer_id: customer.id }).eq("id", tenantId);
  return customer.id;
}

// ── Helper: generate standardised stored filename from metadata ──────────────
function generateStoredFilename(lender, documentType, effectiveDate, description, originalFilename) {
  const ext = path.extname(originalFilename) || "";
  const lenderSlug  = lender.toUpperCase().replace(/[\s/]+/g, "").replace(/[^A-Z0-9]/g, "").slice(0, 15);
  const typeSlug    = documentType.replace(/[\s/]+/g, "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
  const dateSlug    = effectiveDate ? String(effectiveDate).slice(0, 7) : new Date().toISOString().slice(0, 7);
  const descSlug    = description.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim()
                        .split(/\s+/).slice(0, 5).join("-").slice(0, 40);
  return `${lenderSlug}_${typeSlug}_${dateSlug}_${descSlug}${ext}`;
}

// ── Text chunking ──────────────────────────────────────────────────────────
// Paragraph-aware chunker: splits on blank lines first to keep Q&A pairs and
// topic sections together, then merges short paragraphs and caps at maxWords.
// Falls back to word-window chunking only when a single paragraph is huge.
async function rewriteForRetrieval(text, documentType) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `You are a knowledge base formatter. Rewrite the provided document as clear, natural declarative sentences optimised for AI retrieval.

Rules:
- Preserve every fact, name, date, price, role, and figure exactly as given — do not invent or omit anything
- Convert lists and tables into full sentences (e.g. "Julie Kenneally Junior Secretary" → "The Junior Secretary is Julie Kenneally.")
- For each role or title, add a sentence with common alternative phrasings so retrieval works regardless of how someone asks (e.g. "Head of IT" → also add "The IT Director is Amy Perrott. The person responsible for IT is Amy Perrott.")
- Remove redundant preamble and formatting artefacts
- Use plain prose — no markdown, no bullet points, no headers
- Keep each sentence self-contained so it makes sense out of context
- Do not summarise or shorten — include everything`
        },
        {
          role: "user",
          content: `Document type: ${documentType}\n\n${text}`
        }
      ]
    });
    return response.choices[0].message.content.trim() || text;
  } catch (err) {
    console.error("[rewriteForRetrieval] GPT rewrite failed, using original:", err.message);
    return text;
  }
}

function chunkText(text, maxWords = 450, overlapWords = 50) {
  // Split on one or more blank lines (handles \r\n and \n)
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return [];

  const chunks = [];
  let current = [];
  let currentWordCount = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join("\n\n"));
    // Carry the last paragraph forward as overlap (context bridge)
    const lastPara = current[current.length - 1];
    const lastWords = lastPara.split(/\s+/).length;
    if (lastWords <= overlapWords) {
      current = [lastPara];
      currentWordCount = lastWords;
    } else {
      current = [];
      currentWordCount = 0;
    }
  };

  for (const para of paragraphs) {
    const wordCount = para.split(/\s+/).filter(Boolean).length;

    // Single paragraph larger than maxWords — split by word window
    if (wordCount > maxWords) {
      if (current.length) flush();
      const words = para.split(/\s+/).filter(Boolean);
      let start = 0;
      while (start < words.length) {
        const end = Math.min(start + maxWords, words.length);
        chunks.push(words.slice(start, end).join(" "));
        if (end === words.length) break;
        start += maxWords - overlapWords;
      }
      current = [];
      currentWordCount = 0;
      continue;
    }

    // Adding this paragraph would overflow — flush first
    if (currentWordCount + wordCount > maxWords && current.length > 0) {
      flush();
    }

    current.push(para);
    currentWordCount += wordCount;
  }

  flush();
  return chunks;
}

// ── Heading detection + enriched chunk builder ────────────────────────────
// Splits text into headed sections, then chunks each section and prepends
// the document title + section heading so embeddings carry full context.
function buildEnrichedChunks(text, docMeta = {}) {
  const { title, documentType } = docMeta;

  // Document-level context prefix (e.g. "Document: Membership Fees | Type: Pricing")
  const docParts = [];
  if (title) docParts.push(`Document: ${title}`);
  if (documentType && documentType !== "Website Content") docParts.push(`Type: ${documentType}`);
  const docPrefix = docParts.join(" | ");

  // Heuristic heading detector
  function isHeading(line) {
    const t = line.trim();
    if (!t || t.length > 100) return false;
    if (/^#{1,4}\s+\S/.test(t)) return true;                           // ## Markdown heading
    if (t.length >= 3 && /^[A-Z][A-Z0-9\s&\/\-:,.]{2,}$/.test(t) && !/[a-z]/.test(t)) return true; // ALL CAPS
    if (t.length <= 60 && t.endsWith(":") && !/[.!?]/.test(t.slice(0, -1))) return true; // Short colon header
    return false;
  }
  function cleanHeading(line) {
    return line.trim().replace(/^#{1,4}\s+/, "").replace(/:$/, "").trim();
  }

  // Split text into sections delimited by headings
  const lines = text.split("\n");
  const sections = [];
  let currentHeading = null;
  let currentBody = [];

  for (const line of lines) {
    if (isHeading(line)) {
      const bodyText = currentBody.join("\n").trim();
      if (bodyText) sections.push({ heading: currentHeading, body: bodyText });
      currentHeading = cleanHeading(line);
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  const finalBody = currentBody.join("\n").trim();
  if (finalBody) sections.push({ heading: currentHeading, body: finalBody });

  // If nothing was detected as a heading, treat whole text as one section
  if (!sections.length) sections.push({ heading: null, body: text.trim() });

  // Chunk each section and prepend context
  const result = [];
  for (const section of sections) {
    const rawChunks = chunkText(section.body);
    for (const raw of rawChunks) {
      const prefixParts = [docPrefix, section.heading ? `Section: ${section.heading}` : null].filter(Boolean);
      const enriched = prefixParts.length ? prefixParts.join("\n") + "\n" + raw : raw;
      result.push({ enrichedText: enriched, sectionHeading: section.heading || null });
    }
  }
  return result;
}

// ── Reconstruct original text from stored chunks ──────────────────────────
// Removes the 50-word overlap between consecutive chunks so we get back
// approximately the original document text for re-processing.
function reconstructTextFromChunks(chunks) {
  if (!chunks.length) return "";
  chunks = [...chunks].sort((a, b) => a.chunk_index - b.chunk_index);

  let text = chunks[0].chunk_text;
  for (let i = 1; i < chunks.length; i++) {
    const currWords = chunks[i].chunk_text.split(/\s+/);
    const textWords = text.split(/\s+/);
    let merged = false;
    // Try to find the overlap (50-word window, scan down to 5)
    for (let ov = Math.min(60, textWords.length, currWords.length); ov >= 5; ov--) {
      if (textWords.slice(-ov).join(" ") === currWords.slice(0, ov).join(" ")) {
        text += " " + currWords.slice(ov).join(" ");
        merged = true;
        break;
      }
    }
    if (!merged) text += "\n" + chunks[i].chunk_text;
  }
  return text.trim();
}

// ── Re-index a single document with the new enriched chunk format ─────────
// Safe atomic swap: collect old IDs → insert new → delete old by ID.
// Returns { ok, docId, oldCount, newCount, skipped, reason }
async function reindexDocument(doc, tenantId) {
  // Skip website content — use Re-crawl button for those
  if (doc.document_type === "Website Content") {
    return { ok: true, skipped: true, reason: "website-content" };
  }

  // Get existing chunks
  const { data: existingChunks, error: fetchErr } = await supabase
    .from("knowledge_chunks")
    .select("id, chunk_index, chunk_text")
    .eq("document_id", doc.id)
    .order("chunk_index", { ascending: true });

  if (fetchErr) return { ok: false, reason: "fetch-error: " + fetchErr.message };
  if (!existingChunks || !existingChunks.length) return { ok: true, skipped: true, reason: "no-chunks" };

  // Skip if chunks already enriched with new format (idempotent re-run safety)
  const firstChunk = existingChunks[0].chunk_text || "";
  if (firstChunk.startsWith("Document:") || firstChunk.startsWith("Type:")) {
    return { ok: true, skipped: true, reason: "already-enriched" };
  }

  // ── Attempt 1: re-download original file from Supabase Storage ────────────
  let text = null;
  if (doc.storage_path && doc.mimetype !== "text/html") {
    try {
      const { data: fileBlob, error: dlErr } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .download(doc.storage_path);
      if (!dlErr && fileBlob) {
        const buffer = Buffer.from(await fileBlob.arrayBuffer());
        if (doc.mimetype === "application/pdf") {
          const tmpPath = path.join(os.tmpdir(), `reindex-${doc.id}.pdf`);
          fs.writeFileSync(tmpPath, buffer);
          try { text = await extractPdfText(tmpPath); } finally { fs.unlink(tmpPath, () => {}); }
        } else if (doc.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
          const result = await mammoth.extractRawText({ buffer });
          text = result.value;
        } else {
          text = buffer.toString("utf8");
        }
      }
    } catch (dlErr) {
      console.warn(`[reindex] Storage download failed for ${doc.id}:`, dlErr.message);
    }
  }

  // ── Fallback: reconstruct from existing chunks ─────────────────────────────
  if (!text || text.trim().length < 10) {
    text = reconstructTextFromChunks(existingChunks);
  }

  if (!text || text.trim().length < 10) {
    return { ok: true, skipped: true, reason: "no-text-recoverable" };
  }

  // Build enriched chunks with new format
  const docMeta = {
    title:        doc.description || doc.original_filename,
    documentType: doc.document_type
  };
  const enriched = buildEnrichedChunks(text, docMeta);
  if (!enriched.length) return { ok: true, skipped: true, reason: "no-chunks-produced" };

  // Embed
  try {
    const embResp = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: enriched.map(c => c.enrichedText)
    });

    const newRows = embResp.data.map((item, i) => ({
      document_id:     doc.id,
      chunk_index:     i,
      chunk_text:      enriched[i].enrichedText,
      section_heading: enriched[i].sectionHeading,
      embedding:       item.embedding,
      lender:          null,
      document_type:   doc.document_type,
      effective_date:  doc.effective_date || null,
      tenant_id:       tenantId
    }));

    // Atomic swap: insert new rows first, THEN delete old ones by ID
    const oldIds = existingChunks.map(c => c.id);
    const { error: insertErr } = await supabase.from("knowledge_chunks").insert(newRows);
    if (insertErr) throw new Error("Insert failed: " + insertErr.message);

    // Delete old chunks by their specific IDs — never touches newly inserted rows
    const { error: delErr } = await supabase.from("knowledge_chunks").delete().in("id", oldIds);
    if (delErr) console.warn(`[reindex] Old chunk delete partial: ${delErr.message}`);

    return { ok: true, oldCount: oldIds.length, newCount: newRows.length };
  } catch (embErr) {
    return { ok: false, reason: "embedding-error: " + embErr.message };
  }
}

// ── Generate embeddings and store in knowledge_chunks ─────────────────────
// docMeta = { title, description, documentType } — used to enrich chunk context
async function generateAndStoreChunks(documentId, text, lender, documentType, effectiveDate, tenantId = "aom", docMeta = {}) {
  const enrichedChunks = buildEnrichedChunks(text, {
    title: docMeta.title || docMeta.description || null,
    documentType
  });

  if (enrichedChunks.length === 0) {
    console.log(`[embeddings] No text to embed for document ${documentId} — skipping`);
    return;
  }

  console.log(`[embeddings] Generating embeddings for ${enrichedChunks.length} chunk(s) — document ${documentId} (tenant: ${tenantId})`);

  // Single batched API call for all chunks
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: enrichedChunks.map(c => c.enrichedText)
  });

  const rows = embeddingResponse.data.map((item, i) => ({
    document_id:     documentId,
    chunk_index:     i,
    chunk_text:      enrichedChunks[i].enrichedText,
    section_heading: enrichedChunks[i].sectionHeading,
    embedding:       item.embedding,
    lender,
    document_type:   documentType,
    effective_date:  effectiveDate ? `${effectiveDate}-01` : null,
    tenant_id:       tenantId
  }));

  const { error } = await supabase.from("knowledge_chunks").insert(rows);

  if (error) {
    console.error("[embeddings] knowledge_chunks insert error:", error);
    throw error;
  }

  console.log(`[embeddings] Stored ${rows.length} chunk(s) for document ${documentId}`);
}

// ── GET /api/knowledge-documents — list all docs for senior broker UI ─────────
app.get("/api/knowledge-documents", requireLogin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("documents")
      .select("id, original_filename, stored_filename, mimetype, lender, document_type, effective_date, tags, uploaded_at, metadata_complete, storage_path, junior_accessible")
      .eq("tenant_id", "aom")
      .order("uploaded_at", { ascending: false });

    if (error) {
      console.error("Load documents error:", error);
      return res.status(500).json({ error: "Failed to load documents" });
    }

    res.json(data.map(doc => ({
      id:               doc.id,
      filename:         doc.original_filename,
      storedFilename:   doc.stored_filename,
      mimetype:         doc.mimetype,
      lender:           doc.lender,
      documentType:     doc.document_type,
      effectiveDate:    doc.effective_date,
      tags:             doc.tags,
      uploadedAt:       doc.uploaded_at,
      metadataComplete: doc.metadata_complete,
      storagePath:      doc.storage_path,
      juniorAccessible: doc.junior_accessible
    })));
  } catch (err) {
    console.error("Load knowledge documents error:", err);
    res.status(500).json({ error: "Failed to load documents" });
  }
});

// ── PATCH /api/documents/:id/metadata — save metadata for existing doc ────────
app.patch("/api/documents/:id/junior-access", requireSenior, async (req, res) => {
  try {
    const { id } = req.params;
    const { juniorAccessible } = req.body;

    const { error } = await supabase
      .from("documents")
      .update({ junior_accessible: !!juniorAccessible })
      .eq("id", id);

    if (error) {
      console.error("Junior access update error:", error);
      return res.status(500).json({ error: "Failed to update access" });
    }

    res.json({ success: true, juniorAccessible: !!juniorAccessible });
  } catch (err) {
    console.error("Junior access toggle error:", err);
    res.status(500).json({ error: "Failed to update access" });
  }
});

app.patch("/api/documents/:id/metadata", requireSenior, async (req, res) => {
  try {
    const { id } = req.params;
    const { lender, document_type, description, effective_date, expiry_date, tags } = req.body;

    if (!lender || !document_type || !description || !effective_date) {
      return res.status(400).json({ error: "Lender, document type, description and effective date are required" });
    }

    // Fetch original filename to build stored filename
    const { data: doc, error: fetchError } = await supabase
      .from("documents")
      .select("original_filename")
      .eq("id", id)
      .single();

    if (fetchError || !doc) {
      return res.status(404).json({ error: "Document not found" });
    }

    const storedFilename = generateStoredFilename(lender, document_type, effective_date, description, doc.original_filename);

    const { error: updateError } = await supabase
      .from("documents")
      .update({
        lender,
        document_type,
        description,
        effective_date:    effective_date   || null,
        expiry_date:       expiry_date      || null,
        tags:              tags             || null,
        stored_filename:   storedFilename,
        metadata_complete: true
      })
      .eq("id", id);

    if (updateError) {
      console.error("Metadata update error:", updateError);
      return res.status(500).json({ error: "Failed to save metadata" });
    }

    res.json({ success: true, stored_filename: storedFilename });
  } catch (err) {
    console.error("Save metadata error:", err);
    res.status(500).json({ error: "Failed to save metadata" });
  }
});

app.post("/api/knowledge-documents/search", requireLogin, async (req, res) => {
  try {
    const query = (req.body.query || "").trim();
    if (!query) return res.status(400).json({ error: "Query is required" });

    // 1. Embed the query
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // 2. Get top chunks across all documents
    const { data: chunks, error: rpcError } = await supabase.rpc("match_chunks", {
      query_embedding: queryEmbedding,
      match_count: 15,
      filter_lender: null,
      filter_document_type: null
    });

    if (rpcError) {
      console.error("[doc search] match_chunks error:", rpcError);
      return res.status(500).json({ error: "Search failed" });
    }

    if (!chunks?.length) return res.json([]);

    // 3. Group by document_id — keep best similarity score per document
    const docMap = {};
    for (const chunk of chunks) {
      if (!docMap[chunk.document_id] || chunk.similarity > docMap[chunk.document_id].similarity) {
        docMap[chunk.document_id] = chunk;
      }
    }

    // Top document by similarity
    const topDocIds = Object.values(docMap)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 1)
      .map(c => c.document_id);

    // 4. Fetch document details — junior users only see accessible docs
    const docsQuery = supabase
      .from("documents")
      .select("id, original_filename, stored_filename, lender, document_type, effective_date, mimetype, junior_accessible")
      .in("id", topDocIds);

    if (req.user.role === "junior") {
      docsQuery.eq("junior_accessible", true);
    }

    const { data: docs, error: docsError } = await docsQuery;

    if (docsError) {
      console.error("[doc search] documents lookup error:", docsError);
      return res.status(500).json({ error: "Failed to fetch document details" });
    }

    // 5. Build response in similarity order
    const results = topDocIds
      .map(id => {
        const doc = docs.find(d => d.id === id);
        if (!doc) return null;
        const similarity = docMap[id].similarity;
        return {
          id:           doc.id,
          filename:     doc.original_filename || doc.stored_filename,
          lender:       doc.lender,
          documentType: doc.document_type,
          effectiveDate: doc.effective_date,
          mimetype:     doc.mimetype,
          similarity,
          confidence:   similarity >= 0.45 ? "Strong match" :
                        similarity >= 0.32 ? "Good match"   : "Possible match"
        };
      })
      .filter(Boolean);

    res.json(results);

  } catch (err) {
    console.error("[doc search] error:", err.message);
    res.status(500).json({ error: "Search failed" });
  }
});

app.delete("/api/knowledge-documents/:id", requireSenior, async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch from documents table (source of record)
    const { data: doc, error: fetchError } = await supabase
      .from("documents")
      .select("id, original_filename, storage_path")
      .eq("id", id)
      .single();

    if (fetchError || !doc) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Delete file from Supabase Storage if present
    if (doc.storage_path) {
      const { error: storageError } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .remove([doc.storage_path]);

      if (storageError) {
        console.error("Supabase storage delete error:", storageError);
        // Continue — still remove the DB records
      }
    }

    // Delete from documents (knowledge_chunks cascade automatically)
    const { error: deleteError } = await supabase
      .from("documents")
      .delete()
      .eq("id", id);

    if (deleteError) {
      console.error("Supabase document delete error:", deleteError);
      return res.status(500).json({ error: "Failed to delete document" });
    }

    // Also remove from legacy knowledge_documents table (match by storage_path, not id)
    if (doc.storage_path) {
      await supabase.from("knowledge_documents").delete().eq("storage_path", doc.storage_path);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Delete knowledge document error:", err);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

app.get("/api/knowledge-documents/:id/download", requireLogin, async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch document metadata from source-of-record table
    const { data: doc, error: fetchError } = await supabase
      .from("documents")
      .select("id, original_filename, stored_filename, mimetype, storage_path, junior_accessible")
      .eq("id", id)
      .single();

    if (fetchError || !doc) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Junior users can only download documents marked as accessible
    if (req.user.role === "junior" && !doc.junior_accessible) {
      return res.status(403).json({ error: "You don't have permission to view this document. Please ask your senior broker to enable access." });
    }

    if (!doc.storage_path) {
      return res.status(404).json({ error: "No file in storage for this document" });
    }

    // Download from Supabase Storage and stream to client
    const { data: fileData, error: downloadError } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .download(doc.storage_path);

    if (downloadError || !fileData) {
      console.error("Supabase storage download error:", downloadError);
      return res.status(500).json({ error: "Failed to download file from storage" });
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const downloadName = (doc.original_filename || doc.stored_filename || "document").replace(/[^a-zA-Z0-9._-]/g, "_");

    res.setHeader("Content-Type", doc.mimetype || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
    res.setHeader("Content-Length", buffer.length);
    return res.send(buffer);

  } catch (err) {
    console.error("Download knowledge document error:", err);
    res.status(500).json({ error: "Failed to download document" });
  }
});

app.post(
  "/api/knowledge-documents/upload",
  requireSenior,
  upload.single("document"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No document uploaded" });
      }

      // ── Validate required metadata ──────────────────────────────────────
      const { lender, documentType, description, effectiveDate, expiryDate, tags, juniorAccessible } = req.body;

      if (!lender)        return res.status(400).json({ error: "Lender is required" });
      if (!documentType)  return res.status(400).json({ error: "Document type is required" });
      if (!description)   return res.status(400).json({ error: "Description is required" });
      if (!effectiveDate) return res.status(400).json({ error: "Effective date is required" });

      // ── Extract text ─────────────────────────────────────────────────────
      let extractedText = "";

      if (req.file.mimetype === "application/pdf") {
        extractedText = await extractPdfText(req.file.path);

      } else if (req.file.mimetype === "text/plain") {
        extractedText = fs.readFileSync(req.file.path, "utf8");

      } else if (
        req.file.mimetype ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        const result = await mammoth.extractRawText({ path: req.file.path });
        extractedText = result.value;

      } else {
        return res.status(400).json({
          error: "Only PDF, TXT and Word DOCX files are supported for now"
        });
      }

      // ── Generate standardised filename ───────────────────────────────────
      const storedFilename = generateStoredFilename(
        lender, documentType, effectiveDate, description, req.file.originalname
      );
      const storagePath = `documents/${storedFilename}`;

      console.log("Uploading to Supabase bucket/path:", SUPABASE_BUCKET, storagePath);

      const fileBuffer = fs.readFileSync(req.file.path);

      const { error: uploadError } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(storagePath, fileBuffer, {
          contentType: req.file.mimetype,
          upsert: false
        });

      if (uploadError) {
        console.error("Supabase storage upload error:", uploadError);
        return res.status(500).json({ error: "Failed to upload file to Supabase" });
      }

      // ── Parse tags ────────────────────────────────────────────────────────
      const tagsArray = tags
        ? tags.split(",").map(t => t.trim()).filter(Boolean)
        : [];

      // ── Insert into documents table (source of record) ───────────────────
      const { data: docData, error: docInsertError } = await supabase
        .from("documents")
        .insert({
          original_filename: req.file.originalname,
          stored_filename:   storedFilename,
          storage_path:      storagePath,
          mimetype:          req.file.mimetype,
          lender,
          document_type:     documentType,
          description,
          effective_date:    effectiveDate ? `${effectiveDate}-01` : null,
          expiry_date:       expiryDate  ? `${expiryDate}-01`  : null,
          tags:              tagsArray,
          metadata_complete: true,
          junior_accessible: juniorAccessible === "true" || juniorAccessible === true,
          tenant_id:         "aom"
        })
        .select()
        .single();

      if (docInsertError) {
        console.error("Documents table insert error:", docInsertError);
        return res.status(500).json({ error: "Failed to save document record" });
      }

      // ── Generate embeddings and store chunks ──────────────────────────────
      try {
        await generateAndStoreChunks(docData.id, extractedText, lender, documentType, effectiveDate, "aom");
      } catch (embedErr) {
        console.error("[embeddings] Failed (non-fatal, upload still succeeded):", embedErr.message);
      }

      // ── Also insert into knowledge_documents for backward AI compat ───────
      const { error: kdInsertError } = await supabase
        .from("knowledge_documents")
        .insert({
          filename:       storedFilename,
          storage_path:   storagePath,
          mimetype:       req.file.mimetype,
          extracted_text: extractedText
        });

      if (kdInsertError) {
        // Non-fatal: document is safely in documents table
        console.error("knowledge_documents insert (non-fatal):", kdInsertError);
      }

      fs.unlink(req.file.path, () => {});

      res.json({
        success: true,
        message: "Document added to knowledge base",
        document: {
          id:           docData.id,
          storedFilename,
          lender,
          documentType,
          effectiveDate,
          uploadedAt:   docData.uploaded_at
        }
      });

    } catch (err) {
      console.error("Knowledge document upload error:", err);
      res.status(500).json({ error: "Failed to process document" });
    }
  }
);

async function loadKnowledgeDocs() {
  const { data, error } = await supabase
    .from("knowledge_documents")
    .select("*")
    .order("uploaded_at", { ascending: false });

  if (error) {
    console.error("Supabase loadKnowledgeDocs error:", error);
    return [];
  }

  return data.map(doc => ({
    id: doc.id,
    filename: doc.filename,
    mimetype: doc.mimetype,
    text: doc.extracted_text,
    uploadedAt: doc.uploaded_at,
    storagePath: doc.storage_path
  }));
}

function startMaeveIntroOnce() {
  if (maeveIntroPlayed) return;

  maeveIntroPlayed = true;
  maeveIntroJustPlayed = true;

  if (maeveIntroJustPlayed) {
    maeveIntroJustPlayed = false;
  } else {
    playMaeveVoice("Hi there, I’m Maeve. I can help you get started with a mortgage or answer any questions. What are you thinking of doing?");
  }

  document.removeEventListener("click", startMaeveIntroOnce);
  document.removeEventListener("keydown", startMaeveIntroOnce);
}

const knowledgeBasePath = path.join(__dirname, "data", "knowledgeBase.json");

function loadKnowledgeBase() {
  try {
    if (!fs.existsSync(knowledgeBasePath)) {
      fs.writeFileSync(knowledgeBasePath, JSON.stringify([], null, 2));
    }

    return JSON.parse(fs.readFileSync(knowledgeBasePath, "utf8"));
  } catch (err) {
    console.error("Error loading knowledge base:", err);
    return [];
  }
}

function readJsonFile(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(fallbackValue, null, 2));
      return fallbackValue;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    return raw ? JSON.parse(raw) : fallbackValue;
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error.message);
    return fallbackValue;
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error.message);
  }
}

let appointments = readJsonFile(appointmentsFile, []);
let documents = readJsonFile(documentsFile, []);
let chatLogs = readJsonFile(chatLogsFile, []);
const settings = readJsonFile(settingsFile, {
  aiEnabled: true,
  businessMode: "mortgage",
  features: {
    aiReceptionist: true,
    knowledgeBase: true,
    emailAssistant: true
  }
});

let aiEnabled = settings.aiEnabled;
let businessMode = "mortgage";
let features = settings.features || {
  aiReceptionist: false,
  knowledgeBase: true,
  emailAssistant: true
};
let testMode = false; // global — suppresses all activity logging when on

const BOOKING_TIMES = ["09:30", "11:00", "14:00", "15:30"];

function getAvailableSlots() {
  const slots = {};
  let count = 0;
  const d = new Date();
  d.setDate(d.getDate() + 1); // start from tomorrow
  while (count < 2) {
    const day = d.getDay(); // 0=Sun, 6=Sat
    if (day !== 0 && day !== 6) {
      const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
      slots[key] = [...BOOKING_TIMES];
      count++;
    }
    d.setDate(d.getDate() + 1);
  }
  return slots;
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function formatDateNice(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const days   = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${days[d.getDay()]} ${ordinal(d.getDate())} ${months[d.getMonth()]}`;
}

const urgentKeywords = [
  "chest pain",
  "shortness of breath",
  "difficulty breathing",
  "bleeding",
  "stroke",
  "heart attack",
  "severe pain",
  "collapsed",
  "unconscious"
];

let conversations = {};

// ── Mortgage leads — Supabase-backed ─────────────────────────────────────────

// Maps JS camelCase fields ↔ Supabase snake_case columns
const LEAD_COL_MAP = {
  id:                      "id",
  createdAt:               "created_at",
  status:                  "status",
  userId:                  "user_id",
  conversationId:          "conversation_id",
  name:                    "name",
  phone:                   "phone",
  email:                   "email",
  buyerType:               "buyer_type",
  propertyPrice:           "property_price",
  deposit:                 "deposit",
  income:                  "income",
  employmentType:          "employment_type",
  existingDebts:           "existing_debts",
  creditHistory:           "credit_history",
  referralSource:          "referral_source",
  notes:                   "notes",
  lead_score:              "lead_score",
  ltvPct:                  "ltv_pct",
  ltiX:                    "lti_x",
  qualificationStrengths:  "qualification_strengths",
  qualificationIssues:     "qualification_issues",
  emailSent:               "email_sent",
  payslipUploadLinkSent:   "payslip_upload_link_sent",
  leadTemperature:         "lead_temperature",
  subject:                 "subject",
  timeline:                "timeline"
};

function leadToRow(lead) {
  const row = {};
  for (const [key, col] of Object.entries(LEAD_COL_MAP)) {
    if (lead[key] !== undefined) row[col] = lead[key];
  }
  return row;
}

function rowToLead(row) {
  const lead = {};
  for (const [key, col] of Object.entries(LEAD_COL_MAP)) {
    if (row[col] !== undefined) lead[key] = row[col];
  }
  return lead;
}

async function insertMortgageLead(lead) {
  const { error } = await supabase.from("mortgage_leads").insert(leadToRow(lead));
  if (error) console.error("[mortgage-leads] insert failed:", error.message);
}

async function updateMortgageLead(id, updates) {
  const patch = leadToRow(updates);
  delete patch.id; // never patch the PK
  if (!Object.keys(patch).length) return;
  const { error } = await supabase.from("mortgage_leads").update(patch).eq("id", id);
  if (error) console.error("[mortgage-leads] update failed:", error.message);
}

async function fetchMortgageLead(id) {
  const { data, error } = await supabase
    .from("mortgage_leads").select("*").eq("id", id).maybeSingle();
  if (error) { console.error("[mortgage-leads] fetch failed:", error.message); return null; }
  return data ? rowToLead(data) : null;
}

async function fetchAllMortgageLeads({ zapierOnly = false } = {}) {
  let q = supabase.from("mortgage_leads").select("*").order("created_at", { ascending: false });
  if (zapierOnly) q = q.not("subject", "is", null);
  const { data, error } = await q;
  if (error) { console.error("[mortgage-leads] fetch all failed:", error.message); return []; }
  return (data || []).map(rowToLead);
}

function isUrgentMessage(message) {
  const lower = message.toLowerCase();
  return urgentKeywords.some(keyword => lower.includes(keyword));
}

function isDateInput(message) {
  return /^\d{4}-\d{2}-\d{2}$/.test(message.trim());
}

function isTimeInput(message) {
  return /^\d{2}:\d{2}$/.test(message.trim());
}

function saveAppointments() {
  writeJsonFile(appointmentsFile, appointments);
}

function saveDocuments() {
  writeJsonFile(documentsFile, documents);
}

function saveChatLogs() {
  writeJsonFile(chatLogsFile, chatLogs);
}

function saveSettings() {
  writeJsonFile(settingsFile, {
    aiEnabled,
    businessMode,
    features
  });
}

// ── Activity logging ─────────────────────────────────────────────────────────
function logActivity(type, data = {}) {
  if (testMode) return; // global test mode — suppress all activity
  supabase.from("activity_log").insert({
    type,
    role:     data.role     || null,
    question: data.question || null,
    answered: data.answered !== undefined ? data.answered : null,
    source:   data.source   || null
  }).then(({ error }) => {
    if (error) console.error("[logActivity] insert failed:", error.message);
  });
}

function addChatLog(entry) {
  chatLogs.push(entry);
  saveChatLogs();
  // Persist to Supabase for tenant portal chat logs view
  if (entry.tenantId) {
    supabase.from("chat_logs").insert({
      tenant_id:       entry.tenantId,
      conversation_id: entry.conversationId || null,
      user_id:         entry.userId         || null,
      sender:          entry.sender,
      message:         entry.message,
      answer_source:   entry.answerSource   || null,  // "kb", "approved", "workflow", "generic", "ebo"
      created_at:      entry.timestamp      || new Date()
    }).then(() => {
      chatUsageCache.delete(entry.tenantId); // bust cache so portal shows updated count immediately
    }).catch(() => {}); // fire-and-forget — never block the chat response
  }
}

const SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours inactivity

function getSession(req) {
  const sessionId = req.cookies.admin_session;
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  // Check inactivity timeout
  if (Date.now() - session.lastActive > SESSION_TIMEOUT_MS) {
    sessions.delete(sessionId);
    return null;
  }
  // Refresh lastActive on every use
  session.lastActive = Date.now();
  return session;
}

// Purge expired sessions from memory every hour
setInterval(() => {
  const cutoff = Date.now() - SESSION_TIMEOUT_MS;
  let purged = 0;
  for (const [id, session] of sessions.entries()) {
    if (session.lastActive < cutoff) { sessions.delete(id); purged++; }
  }
  if (purged > 0) console.log(`[session] Purged ${purged} expired session(s)`);
}, 60 * 60 * 1000);

function requireLogin(req, res, next) {
  const session = getSession(req);

  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.user = session;
  next();
}

function requireSenior(req, res, next) {
  const session = getSession(req);

  if (!session || session.role !== "senior") {
    return res.status(403).json({ error: "Senior only" });
  }

  req.user = session;
  next();
}

async function createAppointment(userId, conversationId, customerName, date, time, type, customerPhone = "", customerEmail = "") {
  const newAppointment = {
    id: appointments.length > 0 ? Math.max(...appointments.map(a => a.id)) + 1 : 1,
    userId,
    conversationId,
    customerName,
    customerPhone,
    customerEmail,
    date,
    time,
    type,
    status: "confirmed",
    createdAt: new Date()
  };

    appointments.push(newAppointment);
    saveAppointments();

    // Fire-and-forget — never block the booking confirmation response
    if (process.env.RESEND_API_KEY) {
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "Maeve <maeve@sprimal.com>",
          to: ["hello@sprimal.com", "cormac@aom.ie"],
          subject: "📅 New Appointment Booked",
          text: `New appointment booked:\n\nName: ${customerName}\nPhone: ${customerPhone || "-"}\nEmail: ${customerEmail || "-"}\nDate: ${formatDateNice(date)}\nTime: ${time}\nType: ${type}`
        })
      })
        .then(r => r.ok
          ? console.log("[createAppointment] Booking email sent to hello@sprimal.com, cormac@aom.ie")
          : r.text().then(b => console.error("[createAppointment] Email failed:", r.status, b))
        )
        .catch(err => console.error("[createAppointment] Email error:", err.message));
    } else {
      console.warn("[createAppointment] RESEND_API_KEY not set — skipping booking email");
    }

  return newAppointment;
}

function resetConversation(userId) {
  conversations[userId] = {
    step: "start",
    date: null,
    time: null,
    bookingType: null,

    mortgageStep: "start",
    mortgageLeadId: null,

    // EBO personal booking auth
    eboAuthStep:         null,  // null | "awaiting_email" | "awaiting_code" | "verified"
    eboAuthEmail:        null,
    eboMembershipNumber: null,
    eboMemberName:       null
  };
}

function ensureConversation(userId) {
  if (!conversations[userId]) {
    resetConversation(userId);
  }
  return conversations[userId];
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function requireAdminPage(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.redirect("/login");
  }

  next();
}

async function createMortgageLeadFromChat({ userId, conversationId }) {
  const newLead = {
    id:             "ML-" + Date.now(),
    createdAt:      new Date().toISOString(),
    status:         "New lead",
    userId,
    conversationId,
    name:           "",
    phone:          "",
    email:          "",
    buyerType:      "",
    propertyPrice:  "",
    deposit:        "",
    income:         "",
    employmentType: "",
    notes:          "Started from chat"
  };
  await insertMortgageLead(newLead);
  return newLead;
}

async function handleBookingFlow({ userId, conversationId, message, bookingType, confirmationLabel }) {
  const convo = ensureConversation(userId);
  const trimmedMessage = message.trim();
  const lowerMessage = trimmedMessage.toLowerCase();

  if (
    lowerMessage.includes("book") ||
    lowerMessage.includes("appointment") ||
    lowerMessage.includes("consultation")
  ) {
    const slots = getAvailableSlots();
    const dateKeys = Object.keys(slots);
    convo.step = "awaiting_date";
    convo.bookingType = bookingType;
    convo.date = null;
    convo.time = null;
    convo._availableSlots = slots;

    const dateList = dateKeys.map((k, i) => `${i + 1}. ${formatDateNice(k)}`).join("\n");
    return {
      reply: `Sure! I have the following dates available:\n\n${dateList}\n\nJust reply with 1 or 2.`
    };
  }

  if (convo.step === "awaiting_date") {
    const slots = convo._availableSlots || getAvailableSlots();
    const dateKeys = Object.keys(slots);
    const dateList = dateKeys.map((k, i) => `${i + 1}. ${formatDateNice(k)}`).join("\n");

    // Accept "1" or "2"
    const pick = parseInt(trimmedMessage, 10);
    if (pick === 1 || pick === 2) {
      convo.date = dateKeys[pick - 1];
      convo.step = "awaiting_time";
      const times = slots[convo.date];
      const timeList = times.map((t, i) => `${i + 1}. ${t}`).join("\n");
      return {
        reply: `${formatDateNice(convo.date)} it is! Available times:\n\n${timeList}\n\nWhich time suits you?`
      };
    }

    return {
      reply: `Please reply with 1 or 2:\n\n${dateList}`
    };
  }

  if (convo.step === "awaiting_time") {
    const slots = convo._availableSlots || getAvailableSlots();

    if (!convo.date) {
      convo.step = "awaiting_date";
      const dateKeys = Object.keys(slots);
      const dateList = dateKeys.map((k, i) => `${i + 1}. ${formatDateNice(k)}`).join("\n");
      return {
        reply: `Let's start over — which date suits you?\n\n${dateList}`
      };
    }

    const times = slots[convo.date] || BOOKING_TIMES;
    const timeList = times.map((t, i) => `${i + 1}. ${t}`).join("\n");

    // Accept number pick or direct HH:MM
    const pick = parseInt(trimmedMessage, 10);
    if (pick >= 1 && pick <= times.length) {
      convo.time = times[pick - 1];
    } else if (isTimeInput(trimmedMessage) && times.includes(trimmedMessage)) {
      convo.time = trimmedMessage;
    } else {
      return {
        reply: `Please choose a time by replying with its number:\n\n${timeList}`
      };
    }

    convo.step = "awaiting_name";

    return {
      reply: "Great — what is your name?"
    };
  }

  if (convo.step === "awaiting_name") {
    if (!convo.date || !convo.time) {
      convo.step = "awaiting_date";
      const slots = convo._availableSlots || getAvailableSlots();
      const dateKeys = Object.keys(slots);
      const dateList = dateKeys.map((k, i) => `${i + 1}. ${formatDateNice(k)}`).join("\n");
      return {
        reply: `Let's start over — which date suits you?\n\n${dateList}`
      };
    }

    convo.bookingName = trimmedMessage;
    convo.step = "awaiting_phone";
    return {
      reply: `Nice to meet you, ${trimmedMessage}! What's the best phone number to reach you on?`
    };
  }

  if (convo.step === "awaiting_phone") {
    convo.bookingPhone = trimmedMessage;
    convo.step = "awaiting_email";
    return {
      reply: "And your email address?"
    };
  }

  if (convo.step === "awaiting_email") {
    convo.bookingEmail = trimmedMessage;

    const newAppointment = await createAppointment(
      userId,
      conversationId,
      convo.bookingName,
      convo.date,
      convo.time,
      convo.bookingType || bookingType,
      convo.bookingPhone,
      convo.bookingEmail
    );

    resetConversation(userId);

    return {
      reply: `All booked! Your ${confirmationLabel} is confirmed for ${formatDateNice(newAppointment.date)} at ${newAppointment.time}. Cormac will be in touch to confirm. See you then! 👋`
    };
  }

  return {
    reply: `I can help you book a ${confirmationLabel}. Type 'book appointment' to begin.`
  };
}

// ── Admin: manually seed flows for any tenant (one-off utility) ──────────────
app.post("/api/admin/seed-tenant", requireAdmin, async (req, res) => {
  const { tenantId } = req.body;
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  const { data: tenant } = await supabase.from("tenants").select("name, website, business_type").eq("id", tenantId).maybeSingle();
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });
  if (!tenant.website) return res.status(400).json({ error: "No website on file" });
  let bizType = tenant.business_type;
  if (!bizType || bizType === "other") {
    const pages2 = await crawlWebsite(tenant.website, 5);
    bizType = await detectBusinessType(pages2, tenant.website);
  }
  if (!bizType || bizType === "other") return res.status(400).json({ error: "Could not detect business type" });

  // Debug: test a minimal workflow insert to surface any schema errors
  const testId = crypto.randomUUID();
  const { error: testErr } = await supabase.from("chat_workflows").insert({ id: testId, club_id: tenantId, name: "__test__", is_active: false });
  if (testErr) return res.json({ ok: false, stage: "workflow_insert_test", error: testErr.message });
  await supabase.from("chat_workflows").delete().eq("id", testId); // clean up

  const pages = await crawlWebsite(tenant.website, 12);
  try {
    const seeded = await seedFlowsForType(tenantId, tenant.name, tenant.website, bizType, pages);
    res.json({ ok: true, seeded, bizType });
  } catch (err) {
    res.json({ ok: false, stage: "seedFlowsForType", error: err.message });
  }
});

// ── Admin: inject KB content for any tenant ───────────────────────────────
app.post("/api/admin/inject-kb", requireAdmin, async (req, res) => {
  const { tenantId, title, text } = req.body;
  if (!tenantId || !title || !text) return res.status(400).json({ error: "tenantId, title and text required" });
  try {
    const { data: doc, error } = await supabase.from("documents").insert({
      original_filename: `${title.trim()}.txt`,
      stored_filename:   `${title.trim()}.txt`,
      storage_path:      null,
      mimetype:          "text/plain",
      document_type:     "Pasted Knowledge",
      description:       title.trim(),
      tags:              ["pasted"],
      metadata_complete: true,
      junior_accessible: true,
      tenant_id:         tenantId
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await generateAndStoreChunks(doc.id, text.trim(), null, "Pasted Knowledge", null, tenantId, { title: title.trim() });
    res.json({ ok: true, documentId: doc.id, title });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/mortgage-leads", requireAdmin, async (req, res) => {
  const leads = await fetchAllMortgageLeads();
  res.json(leads);
});

app.post("/api/email-reply", requireLogin, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // 1. Load approved answers
    const { data: approvedAnswers, error: approvedError } = await supabase
      .from("approved_answers")
      .select("*")
      .order("created_at", { ascending: false });

    if (approvedError) {
      console.error("Email reply approved lookup error:", approvedError);
    }

    // 2. Search uploaded / pasted KB docs
    const relevantDocs = await findRelevantKnowledgeChunks(email);

    const approvedContext = (approvedAnswers || [])
      .slice(0, 10)
      .map(a => `APPROVED QUESTION: ${a.question}\nAPPROVED ANSWER: ${a.answer}`)
      .join("\n\n");

    const documentContext = relevantDocs
      .map(doc => `SOURCE DOCUMENT: ${doc.filename}\n${doc.text}`)
      .join("\n\n");

    const hasKnowledge =
      approvedContext.trim().length > 0 || documentContext.trim().length > 0;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Sprimal, an AI assistant for Irish mortgage broker staff.

Draft a professional reply to a client email.

Use this priority:
1. Broker-approved answers
2. Uploaded/pasted broker knowledge documents
3. General mortgage wording only if the email is general

Rules:
- Do NOT invent lender-specific criteria
- Do NOT promise approval, rates, or timelines
- Do NOT give financial advice
- Keep it concise and human
- If the knowledge base does not contain enough detail, say the broker will confirm

Style:
- Friendly and professional
- Reassuring
- 4–8 lines max
- Start with "Hi there," unless a name is obvious
- End with "Kind regards,"

BROKER-APPROVED KNOWLEDGE:
${approvedContext || "None"}

BROKER DOCUMENT KNOWLEDGE:
${documentContext || "None"}
          `
        },
        {
          role: "user",
          content: `Client email:\n${email}`
        }
      ],
      temperature: 0.3
    });

    const reply = completion.choices[0].message.content || "No reply generated.";

    let source = "General Mortgage Guidance";
    let confidence = "Low";
    let sourceDetail = "No direct broker knowledge matched";

    if (relevantDocs.length > 0) {
      source = "Broker Documents";
      confidence = "Document Based";
      sourceDetail = [...new Set(relevantDocs.map(doc => doc.filename))].join(", ");
    }

    if ((approvedAnswers || []).length > 0) {
      source = relevantDocs.length > 0
        ? "Approved Answers + Broker Documents"
        : "Approved Answers";
      confidence = "Broker Knowledge Used";
    }

    res.json({
      reply,
      source,
      confidence,
      sourceDetail
    });

  } catch (err) {
    console.error("Email reply error:", err);
    res.status(500).json({ error: "Failed to generate reply" });
  }
});

app.get("/api/mortgage-leads", requireAdmin, async (req, res) => {
  const scorePriority = { hot: 3, warm: 2, cold: 1 };
  const all = await fetchAllMortgageLeads({ zapierOnly: true });
  const leads = all.sort((a, b) => {
    const pa = scorePriority[(a.lead_score || "").toLowerCase()] || 0;
    const pb = scorePriority[(b.lead_score || "").toLowerCase()] || 0;
    if (pb !== pa) return pb - pa;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  console.log("[/api/mortgage-leads] returning", leads.length, "zapier leads");
  res.json(leads);
});

app.post("/mortgage-leads", async (req, res) => {
  const newLead = {
    id:             "ML-" + Date.now(),
    createdAt:      new Date().toISOString(),
    status:         "New lead",
    name:           req.body.name || "",
    phone:          req.body.phone || "",
    email:          req.body.email || "",
    buyerType:      req.body.buyerType || "",
    propertyPrice:  req.body.propertyPrice || "",
    deposit:        req.body.deposit || "",
    income:         req.body.income || "",
    employmentType: req.body.employmentType || "",
    notes:          req.body.notes || ""
  };
  await insertMortgageLead(newLead);
  res.json({ success: true, lead: newLead });
});

app.post("/zapier/email-lead", async (req, res) => {
  console.log("[/zapier/email-lead] payload:", JSON.stringify(req.body));
  const { email, income, deposit, timeline, lead_score, subject } = req.body;

  // ── Internal / system address filter ───────────────────────────────────────
  // These are known non-lead addresses (team, test accounts, monitored inboxes).
  // Never save them as mortgage leads regardless of what Zapier sends.
  const EXCLUDE_LEAD_EMAILS = [
    "oriordann@gmail.com",        // Sprimal founder / test account
    "hello@sprimal.com",          // Sprimal internal
    "cormac.sprimal@gmail.com",   // Monitored broker inbox
    "cormac@aom.ie",              // Broker's own address
  ];

  const emailNorm = (email || "").toLowerCase().trim();
  if (!emailNorm || EXCLUDE_LEAD_EMAILS.includes(emailNorm)) {
    console.log(`[/zapier/email-lead] skipping internal/system address: ${emailNorm || "(empty)"}`);
    return res.json({ success: true, skipped: true });
  }

  // Also skip draft-reply loop-back emails (subject starts with "Draft reply:")
  if ((subject || "").startsWith("Draft reply:")) {
    console.log(`[/zapier/email-lead] skipping draft loop-back: "${subject}"`);
    return res.json({ success: true, skipped: true });
  }

  // Duplicate check directly in Supabase
  const { data: existing } = await supabase
    .from("mortgage_leads")
    .select("id")
    .eq("email", email || "")
    .eq("subject", subject || "")
    .maybeSingle();

  if (existing) {
    console.log("[/zapier/email-lead] duplicate detected — skipping");
    return res.json({ success: true, duplicate: true });
  }

  const newLead = {
    id:        "ML-" + Date.now(),
    createdAt: new Date().toISOString(),
    status:    "New lead",
    email:     email    || "",
    income:    income   || "",
    deposit:   deposit  || "",
    timeline:  timeline || "",
    lead_score: lead_score || "",
    subject:   subject  || ""
  };

  await insertMortgageLead(newLead);
  console.log("[/zapier/email-lead] lead saved to Supabase");
  res.json({ success: true });
});

app.post("/upload", upload.single("file"), (req, res) => {
  try {
    const userId = req.body.userId || "unknown-user";
    const conversationId = req.body.conversationId || "unknown-conversation";
    const documentType = req.body.documentType || "unspecified";
    const leadId = req.body.leadId || req.body.conversationId || "unknown";

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No file uploaded"
      });
    }

    if (req.file.size === 0) {
      return res.status(400).json({
        success: false,
        error: "Uploaded file is empty"
      });
    }

    const documentRecord = {
      id: documents.length > 0 ? Math.max(...documents.map(d => d.id)) + 1 : 1,
      userId,
      conversationId,
      leadId,
      documentType,
      originalName: req.file.originalname,
      storedName: req.file.filename,
      filePath: req.file.path,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date()
    };

    documents.push(documentRecord);
    saveDocuments();

    addChatLog({
      userId,
      conversationId,
      sender: "system",
      message: `Document uploaded: ${req.file.originalname}`,
      timestamp: new Date()
    });

    console.log("[/upload] saved document:", req.file.originalname, "userId:", userId);
    return res.json({ success: true, message: "Document uploaded successfully." });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.get("/chat", (req, res) => {
  if (!features.aiReceptionist) {
    return res.status(503).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sprimal</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;}
.msg{text-align:center;color:#64748b;}h2{color:#0f172a;font-size:22px;margin-bottom:8px;}</style></head>
<body><div class="msg"><h2>AI Receptionist is currently offline</h2><p>Please check back later or contact us directly.</p></div></body></html>`);
  }
  res.sendFile(path.join(__dirname, "views", "chat.html"));
});

app.get("/admin/documents", (req, res) => {
  try {
    const sortedDocuments = [...documents].sort(
      (a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)
    );

    res.json(sortedDocuments);
  } catch (error) {
    console.error("Error fetching documents:", error);
    res.status(500).json({ error: "Failed to fetch documents" });
  }
});

app.get("/admin/documents/:id/download", (req, res) => {
  try {
    const docId = Number(req.params.id);
    const doc = documents.find(d => d.id === docId);

    if (!doc) {
      return res.status(404).send("Document not found");
    }

    const absolutePath = path.resolve(doc.filePath);
    return res.download(absolutePath, doc.originalName);
  } catch (error) {
    console.error("Download error:", error);
    return res.status(500).send("Failed to download document");
  }
});

app.get("/admin/documents/:id/view", (req, res) => {
  try {
    const docId = Number(req.params.id);
    const doc = documents.find(d => d.id === docId);

    if (!doc) {
      return res.status(404).send("Document not found");
    }

    const absolutePath = path.resolve(doc.filePath);

    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${doc.originalName}"`
    );

    return res.sendFile(absolutePath);
  } catch (error) {
    console.error("View error:", error);
    return res.status(500).send("Failed to view document");
  }
});

  app.post("/login", (req, res) => {
    const { password } = req.body;

    let role = null;

    if (password === process.env.SENIOR_PASSWORD) {
      role = "senior";
    } else if (password === process.env.JUNIOR_PASSWORD) {
      role = "junior";
    }

    if (!role) {
      return res.status(401).json({ success: false, error: "Invalid password" });
    }

    const sessionId = crypto.randomUUID();
    const now = Date.now();

    sessions.set(sessionId, { role, isTest: false, createdAt: now, lastActive: now });

    res.cookie("admin_session", sessionId, {
      httpOnly: true,
      secure:   true,
      sameSite: "lax",
      maxAge:   8 * 60 * 60 * 1000  // 8 hours in ms
    });

    logActivity("login", { role });

    res.json({ success: true, role });
  });

app.post("/logout", (req, res) => {
  const sessionId = req.cookies.admin_session;
  if (sessionId) {
    sessions.delete(sessionId);
  }

  res.clearCookie("admin_session");
  res.json({ success: true });
});

app.get("/appointments", requireAdmin, (req, res) => {
  res.json(appointments);
});

app.get("/api/me", requireLogin, (req, res) => {
  res.json({
    role:   req.user.role,
    isTest: testMode
  });
});

app.post("/session/test-mode", requireSenior, (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  testMode = enabled;
  console.log(`[test-mode] global testMode set to ${enabled}`);
  res.json({ success: true, isTest: enabled });
});

app.get("/admin/documents", (req, res) => {
  try {
    const sortedDocuments = [...documents].sort(
      (a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)
    );

    res.json(sortedDocuments);
  } catch (error) {
    console.error("Error fetching documents:", error);
    res.status(500).json({ error: "Failed to fetch documents" });
  }
});

app.get("/chat-logs", requireAdmin, (req, res) => {
  res.json(chatLogs);
});

// ── Admin: Supabase-backed chat logs (all tenants, optional filter) ───────────
app.get("/api/admin/chat-logs", requireAdmin, async (req, res) => {
  try {
    const { tenantId } = req.query; // optional filter

    let query = supabase
      .from("chat_logs")
      .select("id, tenant_id, conversation_id, sender, message, created_at")
      .order("created_at", { ascending: false })
      .limit(200);

    if (tenantId) query = query.eq("tenant_id", tenantId);

    const { data: rows, error } = await query;
    if (error) throw error;

    // Fetch tenant names for the IDs present
    const tenantIds = [...new Set((rows || []).map(r => r.tenant_id))];
    const { data: tenantRows } = await supabase
      .from("tenants")
      .select("id, name")
      .in("id", tenantIds.length ? tenantIds : ["__none__"]);
    const tenantNames = {};
    (tenantRows || []).forEach(t => { tenantNames[t.id] = t.name || t.id; });

    // Group into conversations
    const convMap = {};
    (rows || []).forEach(row => {
      const key = (row.tenant_id || "") + "|" + (row.conversation_id || ("msg-" + row.id));
      if (!convMap[key]) {
        convMap[key] = {
          tenantId:       row.tenant_id,
          tenantName:     tenantNames[row.tenant_id] || row.tenant_id,
          conversationId: row.conversation_id || key,
          messages:       [],
          startedAt:      row.created_at
        };
      }
      convMap[key].messages.push(row);
      if (row.created_at < convMap[key].startedAt) convMap[key].startedAt = row.created_at;
    });

    const conversations = Object.values(convMap)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, 50)
      .map(c => ({
        tenantId:       c.tenantId,
        tenantName:     c.tenantName,
        conversationId: c.conversationId,
        startedAt:      c.startedAt,
        messageCount:   c.messages.length,
        messages:       c.messages.slice().reverse().map(m => ({
          sender:    m.sender,
          message:   m.message,
          createdAt: m.created_at
        }))
      }));

    // Also return unique tenant list for the filter dropdown
    const { data: allTenants } = await supabase
      .from("tenants")
      .select("id, name")
      .order("name", { ascending: true });

    res.json({ conversations, tenants: allTenants || [] });
  } catch (err) {
    console.error("[admin-chat-logs] Error:", err.message);
    res.status(500).json({ error: "Failed to fetch chat logs." });
  }
});

app.get("/status", requireAdmin, (req, res) => {
  res.json({ aiEnabled, businessMode, features });
});

app.post("/status", requireAdmin, (req, res) => {
  const { enabled } = req.body;

  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be true or false" });
  }

  aiEnabled = enabled;
  saveSettings();

  res.json({ success: true, aiEnabled });
});

app.post("/mode", requireAdmin, (req, res) => {
  const { mode } = req.body;

  if (!["gp", "mortgage"].includes(mode)) {
    return res.status(400).json({ error: "mode must be gp or mortgage" });
  }

  businessMode = mode;
  saveSettings();

  res.json({ success: true, businessMode });
});

// ── Feature toggles ──────────────────────────────────────────────────────────
// GET is requireLogin so junior staff can read current feature state for UI visibility
app.get("/features", requireLogin, (req, res) => {
  res.json({ features });
});

app.post("/features", requireSenior, (req, res) => {
  const { feature, enabled } = req.body;
  const validFeatures = ["aiReceptionist", "knowledgeBase", "emailAssistant"];

  if (!validFeatures.includes(feature)) {
    return res.status(400).json({ error: "Invalid feature name" });
  }
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }

  features[feature] = enabled;
  saveSettings();
  console.log(`[/features] ${feature} set to ${enabled}`);
  res.json({ success: true, features });
});

app.get("/api/activity", requireSenior, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("activity_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("[/api/activity] error:", err.message);
    res.status(500).json({ error: "Failed to load activity" });
  }
});

app.get("/admin", requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin.html"));
});

app.post("/appointments", requireAdmin, async (req, res) => {
  const { userId, conversationId, customerName, date, time, type } = req.body;

  if (!userId || !customerName || !date || !time || !type) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const newAppointment = await createAppointment(
    userId,
    conversationId || "admin-created",
    customerName,
    date,
    time,
    type
  );

  res.json({
    success: true,
    appointment: newAppointment
  });
});

app.put("/admin/mortgage-leads/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  await updateMortgageLead(id, { status });
  res.json({ success: true });
});

app.put("/appointments/:id", requireAdmin, (req, res) => {
  const appointmentId = parseInt(req.params.id, 10);
  const { date, time, status } = req.body;

  const appointment = appointments.find(a => a.id === appointmentId);

  if (!appointment) {
    return res.status(404).json({ error: "Appointment not found" });
  }

  if (date) appointment.date = date;
  if (time) appointment.time = time;
  if (status) appointment.status = status;

  saveAppointments();

  addChatLog({
    userId: appointment.userId,
    conversationId: appointment.conversationId,
    sender: "admin",
    message: `Appointment updated to ${appointment.date} at ${appointment.time} with status ${appointment.status}.`,
    timestamp: new Date()
  });

  res.json({
    success: true,
    appointment
  });
});

async function generateMaeveReply(message) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Maeve, a friendly Irish mortgage assistant working for At Once Mortgages in Cork, Ireland.

Company facts you know:
- At Once Mortgages is a mortgage broker based in Cork, Ireland
- The mortgage brokers are Cormac Collins and David O'Mahony
- Direct phone: 021 4315 815
- Customers can book a free consultation by saying "book an appointment"

Reply naturally to the customer.
Keep it short: 1-3 sentences.
Be warm, helpful, and conversational.

If the customer is making small talk, respond naturally and gently guide back to mortgages.

Do not invent mortgage figures.
Do not give financial advice.
Do not ask more than one question at a time.
`
        },
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0.7
    });

    return completion.choices[0].message.content || "";
  } catch (err) {
    console.error("Maeve reply failed:", err.message);
    return "";
  }
}

async function generateGenericReply(message, tenantName, businessDesc) {
  try {
    const orgName = tenantName || "the organisation";
    const descClause = businessDesc ? `, ${businessDesc}` : "";
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a helpful AI assistant for ${orgName}${descClause}. The user is already on the ${orgName} website or chat — never ask them which club or organisation they mean, it is always ${orgName}. Answer questions about ${orgName} and its activities, services, events, history, facilities, staff, or membership. If you genuinely don't have the specific information (e.g. founding year, number of courts, specific staff names), respond warmly with something like: "I don't have that one just yet — we're adding more information all the time. Is there anything else I can help with?" Do not suggest they check the website or contact anyone, the interface will handle that. Only use the off-topic refusal for questions clearly unrelated to ${orgName} (politics, world news, celebrities, other organisations): "I'm only able to help with questions about ${orgName}. Is there something about us I can help you with?" Never guess, invent details, or use placeholder text like "[insert X here]". Do not mention mortgages, brokers, or financial products unless they are relevant to this business. Keep answers friendly and concise (1-3 sentences).`
        },
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0.7
    });
    return completion.choices[0].message.content || "";
  } catch (err) {
    console.error("Generic reply failed:", err.message);
    return "";
  }
}

async function getIntentFromOpenAI(message) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You classify customer messages for an AI receptionist.

Return exactly one label only:

mortgage application
book appointment
upload documents
mortgage status
documents question
general inquiry

Examples:
"I'm thinking of buying a house" = mortgage application
"I want to buy my first home" = mortgage application
"Can I get a mortgage?" = mortgage application
"I need to upload payslips" = upload documents
"What documents do I need?" = documents question
"I want to book a call" = book appointment
"Any update on my application?" = mortgage status
`
      },
      {
        role: "user",
        content: message
      }
    ],
    temperature: 0
  });

  return completion.choices[0].message.content || "";
}

async function extractMortgageFields(message) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
Extract mortgage enquiry details from the customer's message.

Return ONLY valid JSON.

{
  "buyerType": "",
  "propertyPrice": "",
  "deposit": "",
  "income": "",
  "employmentType": "",
  "name": "",
  "phone": "",
  "email": ""
}

Only fill a field when clearly provided.
Use plain numbers where possible.
`
        },
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0
    });

    const text = completion.choices[0].message.content || "{}";
    return JSON.parse(text);
  } catch (err) {
    console.error("Mortgage extraction failed:", err.message);
    return {};
  }
}

async function generateMaeveVoice(text) {
  try {
    const response = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      input: text,
      instructions:
        "Speak as Maeve, a friendly Irish mortgage assistant from Cork. Use a subtle Cork Irish accent. Warm, calm, professional. Do not exaggerate."
    });

    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    console.error("Voice generation failed:", err.message);
    return null;
  }
}


function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function voiceUserId(req) {
  return "voice-" + (req.body.CallSid || req.body.From || "unknown");
}

async function createElevenLabsAudioUrl(text, req) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${MAEVE_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: cleanVoiceText(text).slice(0, 700),
        voice_settings: {
          stability: 0.75,
          similarity_boost: 1.0,
          style: 0,
          use_speaker_boost: true
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  const fileName = `voice-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;
  const filePath = path.join(__dirname, "public", fileName);

  fs.writeFileSync(filePath, audioBuffer);

  return `${req.protocol}://${req.get("host")}/${fileName}`;
}

function voiceUserId(req) {
  return "voice-" + (req.body.CallSid || req.body.From || "unknown");
}

app.post("/voice-call", async (req, res) => {
  try {
    const userId = voiceUserId(req);
    resetConversation(userId);

    const audioUrl = await createElevenLabsAudioUrl(
      "Hi, you're speaking with Maeve from Sprimal. Before we continue, I need your consent to process your personal data to help with your mortgage enquiry. Say yes or press 1 to continue. Say no or press 2 to stop.",
      req
    );

    const twiml = `
      <Response>
        <Gather input="speech dtmf" numDigits="1" action="/voice-process" method="POST" speechTimeout="2">
          <Play>${audioUrl}</Play>
        </Gather>
        <Hangup/>
      </Response>
    `;

    res.type("text/xml");
    res.send(twiml);
  } catch (error) {
    console.error("Voice call error:", error);

    res.type("text/xml");
    res.send(`
      <Response>
        <Say>Sorry, something went wrong.</Say>
        <Hangup/>
      </Response>
    `);
  }
});

app.post("/voice-gdpr", (req, res) => {
  const userId = voiceUserId(req);
  const convo = ensureConversation(userId);

  const input = `${req.body.SpeechResult || ""} ${req.body.Digits || ""}`.toLowerCase();

  if (
    input.includes("yes") ||
    input.includes("yeah") ||
    input.includes("ok") ||
    input.includes("sure") ||
    input.includes("1")
  ) {
    convo.consentGiven = true;

    const twiml = `
      <Response>
        <Gather input="speech" action="/voice-process" method="POST" speechTimeout="5">
          <Say voice="alice">
            Thanks. How can I help today?
            You can say apply for a mortgage, book an appointment, or upload documents.
          </Say>
        </Gather>
        <Say voice="alice">Sorry, I didn't catch that. Goodbye.</Say>
        <Hangup/>
      </Response>
    `;

    res.type("text/xml");
    return res.send(twiml);
  }

  const twiml = `
    <Response>
      <Say voice="alice">No problem. I won't collect any personal information. Goodbye.</Say>
      <Hangup/>
    </Response>
  `;

  res.type("text/xml");
  res.send(twiml);
});

app.post("/voice-process", async (req, res) => {
  try {
    const userId = voiceUserId(req);
    const conversationId = userId;

    const speech = req.body.SpeechResult || "";
    const digits = req.body.Digits || "";
    const input = `${speech} ${digits}`.toLowerCase().trim();

    console.log("Voice input:", input);

    const convo = ensureConversation(userId);

    if (!convo.consentGiven) {
      if (
        input.includes("yes") ||
        input.includes("yeah") ||
        input.includes("ok") ||
        input.includes("sure") ||
        input.includes("1")
      ) {
        convo.consentGiven = true;

        const audioUrl = await createElevenLabsAudioUrl(
          "Thanks. How can I help today? You can say apply for a mortgage, book an appointment, or upload documents.",
          req
        );

        const twiml = `
          <Response>
            <Gather input="speech" action="/voice-process" method="POST" speechTimeout="5">
              <Play>${audioUrl}</Play>
            </Gather>
            <Hangup/>
          </Response>
        `;

        res.type("text/xml");
        return res.send(twiml);
      }

      const audioUrl = await createElevenLabsAudioUrl(
        "No problem. I won't collect any personal information. Goodbye.",
        req
      );

      res.type("text/xml");
      return res.send(`
        <Response>
          <Play>${audioUrl}</Play>
          <Hangup/>
        </Response>
      `);
    }

    if (!speech.trim()) {
      const audioUrl = await createElevenLabsAudioUrl(
        "Sorry, I didn't catch that. Could you say that again?",
        req
      );

      res.type("text/xml");
      return res.send(`
        <Response>
          <Gather input="speech" action="/voice-process" method="POST" speechTimeout="5">
            <Play>${audioUrl}</Play>
          </Gather>
          <Hangup/>
        </Response>
      `);
    }

    const chatResponse = await fetch(`${req.protocol}://${req.get("host")}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId,
        conversationId,
        message: speech,
        voiceMode: true
      })
    });

    const data = await chatResponse.json();
    const reply = data.reply || "Sorry, something went wrong.";

    const cleanReply = cleanVoiceText(reply);
    const audioUrl = await createElevenLabsAudioUrl(cleanReply, req);

    const updatedConvo = ensureConversation(userId);

    if (updatedConvo.completed) {
      res.type("text/xml");
      return res.send(`
        <Response>
          <Play>${audioUrl}</Play>
          <Hangup/>
        </Response>
      `);
    }

    res.type("text/xml");
    res.send(`
      <Response>
        <Gather input="speech" action="/voice-process" method="POST" speechTimeout="5">
          <Play>${audioUrl}</Play>
        </Gather>
        <Hangup/>
      </Response>
    `);

  } catch (error) {
    console.error("Voice process error:", error);

    res.type("text/xml");
    res.send(`
      <Response>
        <Say>Sorry, something went wrong.</Say>
        <Hangup/>
      </Response>
    `);
  }
});

function cleanVoiceText(text) {
  return String(text || "")
    .replace(/€/g, " euro ")
    .replace(/&/g, " and ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getBestKnowledgeSnippet(text, message) {
  const fullText = text || "";
  const lowerText = fullText.toLowerCase();

  const words = message
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 3);

  let bestIndex = 0;

  for (const word of words) {
    const index = lowerText.indexOf(word);
    if (index !== -1) {
      bestIndex = Math.max(0, index - 1000);
      break;
    }
  }

  return fullText.slice(bestIndex, bestIndex + 4000);
}

// ── Query expansion — rephrase the user's question 2 ways so vector search
// covers more semantic ground. Accepts optional conversation history so
// follow-up questions ("what about self-employed?") are rewritten as
// standalone queries before embedding.
// Change 2: one specific + one general rephrase (temperature 0.5 for diversity)
// Change 3: conversation history passed in and included in prompt
async function expandQuery(message, conversationHistory = "", orgName = "") {
  try {
    const historyPrefix = conversationHistory
      ? `Recent conversation:\n${conversationHistory}\n\n`
      : "";
    const orgPrefix = orgName ? `Organisation: ${orgName}\n` : "";
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: 'Rephrase the question three ways to improve knowledge base search coverage: (1) a specific version incorporating the organisation name and any relevant role/context terms (e.g. "club chairman" not just "chairman"), (2) a general version with broader phrasing, (3) a keyword-only version (key nouns only, no question words). If given conversation history, rewrite as a standalone query first. Return JSON only: {"alternatives": ["specific", "general", "keywords"]}'
        },
        { role: "user", content: `${orgPrefix}${historyPrefix}Question: ${message}` }
      ],
      temperature: 0.5,
      max_tokens: 150
    });
    const parsed = JSON.parse(resp.choices[0].message.content);
    return Array.isArray(parsed.alternatives) ? parsed.alternatives.slice(0, 3) : [];
  } catch {
    return []; // fail gracefully — original query still runs
  }
}

// ── Reciprocal Rank Fusion — merges vector + keyword result lists
// k=60 is the standard constant from the original RRF paper (Cormack 2009)
function reciprocalRankFusion(resultLists, k = 60) {
  const scores = new Map(); // key → { chunk, score }
  for (const list of resultLists) {
    if (!list) continue;
    list.forEach((chunk, rank) => {
      const key = `${chunk.document_id}-${chunk.chunk_index}`;
      const entry = scores.get(key) || { chunk, score: 0 };
      entry.score += 1 / (k + rank + 1);
      scores.set(key, entry);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(e => e.chunk);
}

// Change 1: MIN_SIMILARITY raised from 0.30 → 0.42
// Change 3: accepts conversationHistory for context-aware query rewriting
// Change 4: hybrid BM25 + vector search with RRF fusion
async function findRelevantKnowledgeChunks(message, matchCount = 5, tenantId = "aom", conversationHistory = "", orgName = "", conversationId = null) {
  try {
    // Prepend org name to original query so embeddings are anchored to the right entity
    const anchoredQuery = orgName ? `${orgName} — ${message}` : message;

    // 1. Expand query and embed original queries in parallel.
    //    Cap expansion at 600ms — if the GPT call is slow, proceed with just the
    //    original queries rather than blocking the entire retrieval pipeline.
    const [alternatives, origEmbResp] = await Promise.all([
      Promise.race([
        expandQuery(message, conversationHistory, orgName),
        new Promise(resolve => setTimeout(() => resolve([]), 600))
      ]),
      openai.embeddings.create({ model: "text-embedding-3-small", input: [anchoredQuery, message] })
    ]);

    // 2. Embed alternatives (if expansion returned in time), then combine all embeddings
    const altEmbeddings = alternatives.length > 0
      ? (await openai.embeddings.create({ model: "text-embedding-3-small", input: alternatives })).data.map(d => d.embedding)
      : [];
    const embeddings = [...origEmbResp.data.map(d => d.embedding), ...altEmbeddings];

    // 3. Run vector searches (all variants) + BM25 keyword search in parallel.
    //    Use a large match_count (30) so uploaded docs appear in results with real scores
    //    rather than being fetched blindly and drowning the context with irrelevant chunks.
    const VECTOR_FETCH_COUNT = 30;
    const [keywordResult, ...vectorResults] = await Promise.all([
      (async () => {
        try {
          return await supabase.rpc("search_chunks_keyword", {
            query_text: message,
            match_count: VECTOR_FETCH_COUNT,
            p_tenant_id: tenantId
          });
        } catch { return { data: null }; }
      })(),
      ...embeddings.map(embedding =>
        supabase.rpc("match_chunks", {
          query_embedding: embedding,
          match_count: VECTOR_FETCH_COUNT,
          filter_lender: null,
          filter_document_type: null,
          p_tenant_id: tenantId
        })
      )
    ]);

    // 4. Fuse all result lists via Reciprocal Rank Fusion
    const allLists = [
      keywordResult.data,
      ...vectorResults.map(r => r.data)
    ];
    const fused = reciprocalRankFusion(allLists);

    // 5. Build maps for filtering:
    //    vectorSimMap — best vector similarity score per chunk
    //    keywordKeys  — chunks that appeared in the BM25 keyword results
    const vectorSimMap = new Map();
    vectorResults.forEach(({ data: chunks }) => {
      if (!chunks) return;
      chunks.forEach(chunk => {
        const key = `${chunk.document_id}-${chunk.chunk_index}`;
        const existing = vectorSimMap.get(key);
        if (!existing || chunk.similarity > existing) vectorSimMap.set(key, chunk.similarity);
      });
    });

    const keywordKeys = new Set(
      (keywordResult.data || []).map(c => `${c.document_id}-${c.chunk_index}`)
    );

    // 6. Website content: filter by keyword match OR similarity threshold
    const MIN_SIMILARITY = 0.30;
    const websiteChunks = fused
      .filter(c => c.document_type === "Website Content")
      .filter(c => {
        const key = `${c.document_id}-${c.chunk_index}`;
        return keywordKeys.has(key) || (vectorSimMap.get(key) || 0) >= MIN_SIMILARITY;
      });

    // 7. Uploaded docs: fetch directly from DB (guarantees nothing is missed),
    //    then sort by vector score and cap at 10 most relevant chunks.
    //    Direct fetch is necessary because uploaded docs may not rank in the top 30
    //    of vector search when the query uses different phrasing from the document.
    const { data: uploadedDocRows } = await supabase
      .from("knowledge_chunks")
      .select("document_id, chunk_index, chunk_text, document_type, lender")
      .eq("tenant_id", tenantId)
      .neq("document_type", "Website Content")
      .limit(60);

    // Sort by relevance (keyword matches first, then vector score), cap at 10.
    const sortedUploadedDocs = (uploadedDocRows || [])
      .sort((a, b) => {
        const keyA = `${a.document_id}-${a.chunk_index}`;
        const keyB = `${b.document_id}-${b.chunk_index}`;
        const scoreA = keywordKeys.has(keyA) ? 1 : (vectorSimMap.get(keyA) || 0);
        const scoreB = keywordKeys.has(keyB) ? 1 : (vectorSimMap.get(keyB) || 0);
        return scoreB - scoreA;
      })
      .slice(0, 10);

    const goodChunks = [
      ...sortedUploadedDocs,
      ...websiteChunks.slice(0, Math.max(matchCount, 10))
    ];

    if (!goodChunks.length) return [];

    // Fire-and-forget telemetry — never awaited, never blocks chat
    const simScores = goodChunks.map(c => vectorSimMap.get(`${c.document_id}-${c.chunk_index}`) || 0);
    supabase.from("retrieval_events").insert({
      tenant_id: tenantId,
      conversation_id: conversationId,
      query: message,
      expanded_queries: alternatives,
      chunks_returned: goodChunks.length,
      similarity_scores: simScores,
      has_uploaded_docs: sortedUploadedDocs.length > 0
    }).then(() => {}).catch(() => {});

    return goodChunks.map(chunk => ({
      filename: chunk.lender
        ? `${chunk.lender} — ${chunk.document_type}`
        : (chunk.document_type || "Knowledge Base"),
      text: chunk.chunk_text,
      similarity: vectorSimMap.get(`${chunk.document_id}-${chunk.chunk_index}`) || 0.5
    }));

  } catch (err) {
    console.error("[vector search] Error:", err.message);
    return [];
  }
}

app.post("/whatsapp", async (req, res) => {
  const message = req.body.Body || "";
  const from = req.body.From || "whatsapp-user";

  // 👇 ADD THIS BLOCK RIGHT HERE
  const convo = ensureConversation(from);

  if (!convo.consentGiven && !convo.gdprPromptShown) {

    convo.gdprPromptShown = true;

    const twiml = `
      <Response>
        <Message>
Hi there 👋 I’m Maeve.

I can help you get started with a mortgage or answer any questions.

Before we begin — I’ll ask a few questions and may collect personal information to help with your enquiry.

This information will only be used for that purpose.

Is that okay? Just reply YES to continue 👍
        </Message>
      </Response>
    `;

    res.type("text/xml");
    return res.send(twiml);
  }

  console.log("WhatsApp message:", message);

  // reuse your chat logic
  const chatResponse = await fetch(
    "https://ai-receptionist-wmr7.onrender.com/chat",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: from,
        conversationId: from,
        message
      })
    }
  );

  const data = await chatResponse.json();

  const reply = data.reply || "Sorry, something went wrong.";

  const twiml = `
    <Response>
      <Message>${reply}</Message>
    </Response>
  `;

  res.type("text/xml");
  res.send(twiml);
});

app.post("/voice", async (req, res) => {
  try {
    const { text } = req.body;

    console.log("ElevenLabs key loaded:", process.env.ELEVENLABS_API_KEY ? "YES" : "NO");
    console.log("Maeve voice ID:", MAEVE_VOICE_ID);

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${MAEVE_VOICE_ID}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg"
        },
        body: JSON.stringify({
          text,
          voice_settings: {
            stability: 0.75,
            similarity_boost: 1.0,
            style: 0,
            use_speaker_boost: true
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("ElevenLabs HTTP error:", response.status, errorText);
      return res.status(500).send("Voice error");
    }

    res.setHeader("Content-Type", "audio/mpeg");

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.send(buffer);

  } catch (err) {
    console.error("ElevenLabs voice error:", err.message);
    res.status(500).send("Voice error");
  }
});

app.get("/upload", (req, res) => {
  const leadId = req.query.leadId || "";

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Upload Payslip</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body { font-family: Arial; max-width: 520px; margin: 40px auto; padding: 20px; }
        button { padding: 12px 18px; font-size: 16px; border: 0; border-radius: 8px; background: #111827; color: white; }
        input { margin: 16px 0; }
      </style>
    </head>
    <body>
      <h2>Upload your payslip</h2>
      <p>Please choose your payslip file below.</p>

      <form action="/upload" method="POST" enctype="multipart/form-data">
        <input type="hidden" name="userId" value="${leadId}" />
        <input type="hidden" name="conversationId" value="${leadId}" />
        <input type="hidden" name="leadId" value="${leadId}" />
        <input type="hidden" name="documentType" value="payslip" />
        <input type="file" name="file" required />
        <br />
        <button type="submit">Upload Payslip</button>
      </form>
    </body>
    </html>
  `);
});


// ── Website import helpers ────────────────────────────────────────────────

function extractTextFromHtml(html) {
  // Pull footer text first — it's stripped below but often contains the best
  // contact info (address, eircode, email, phone). Prepend it so it survives.
  const footerMatch = html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/i);
  const footerText = footerMatch
    ? footerMatch[1]
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<\/?(p|div|h[1-6]|li|br|tr|td|th|span|a)[^>]*>/gi, "\n")
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ").replace(/&#\d+;/g, " ").replace(/&[a-z]+;/g, " ")
        .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
    : "";

  const bodyText = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, " ")
    .replace(/<\/?(p|div|h[1-6]|li|br|tr|td|th)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#\d+;/g, " ").replace(/&[a-z]+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return footerText ? `${bodyText}\n\n[Footer contact info]\n${footerText}` : bodyText;
}

// Extract meaningful links (forms, PDFs, external resources) with their anchor text.
// Returns [{text, url}] — filtered to avoid nav noise.
// Appended to page text so the LLM can see "Senior/Family Application Form → https://..."
function extractLinksWithAnchorText(html, baseUrl) {
  const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const results = [];
  let baseDomain = "";
  try { baseDomain = new URL(baseUrl).hostname.replace(/^www\./, ""); } catch {}
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1].trim();
    const text = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!text || text.length < 3 || text.length > 120) continue;
    if (/^(javascript:|#|tel:)/i.test(href)) continue;
    try {
      const fullUrl = new URL(href, baseUrl).href;
      const urlDomain = new URL(fullUrl).hostname.replace(/^www\./, "");
      const isExternal     = baseDomain && urlDomain !== baseDomain;
      const looksLikeForm  = /form|application|apply|register|join|membership|pdf|download/i.test(text + " " + fullUrl);
      if (isExternal || looksLikeForm) results.push({ text, url: fullUrl });
    } catch {}
  }
  // Deduplicate by URL
  const seen = new Set();
  return results.filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; });
}

// Extract external booking/platform URLs from raw HTML before tags are stripped.
// These URLs appear in href attributes and would be lost by extractTextFromHtml.
// Appending them to page text makes them available to regexExtractFromPages.
function extractExternalUrlsFromHtml(html) {
  const patterns = [
    /https?:\/\/(?:www\.)?ebookingonline\.net\/[^\s"'<>]+/gi,  // EBO
    /https?:\/\/(?:www\.)?clubspark\.lta\.org\.uk\/[^\s"'<>]+/gi, // ClubSpark
    /https?:\/\/(?:www\.)?lovealltennis\.com\/[^\s"'<>]+/gi,   // LoveAll
    /https?:\/\/(?:www\.)?tennis\.ie\/[^\s"'<>]+/gi,           // Tennis Ireland
  ];
  const found = new Set();
  for (const re of patterns) {
    const matches = html.match(re) || [];
    matches.forEach(m => found.add(m.split('"')[0].split("'")[0])); // trim trailing quotes
  }
  return [...found];
}

function extractPageTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : "Page";
}

// Known generic/placeholder favicons to skip (Wix platform icons only)
const GENERIC_FAVICON_PATTERNS = [
  "parastorage.com/client/pfavico",
  "parastorage.com/services"
  // Note: /favicon.ico is intentionally NOT blocked — non-Wix sites serve
  // their real club/business logo there. Only Wix uses the parastorage paths.
];
function isGenericFavicon(url) {
  return GENERIC_FAVICON_PATTERNS.some(p => url.includes(p));
}

// Extract brand color from a page's CSS. Strategy (in order):
// 1. CSS custom properties named --primary, --brand, --accent, --color-primary etc.
// 2. Colors on structural selectors: header, nav, .site-header, h1, h2, button
// 3. Skip known framework defaults (WP blue, Bootstrap blue, etc.)
function extractDominantCssColor(html) {
  try {
    const SKIP_COLORS = new Set([
      "0073aa","005177","0085ba","23282d","1e1e1e","2271b1", // WordPress admin/editor
      "0d6efd","0a58ca","0b5ed7","198754","dc3545","ffc107", // Bootstrap
      "007bff","6c757d","28a745","17a2b8","343a40",           // Bootstrap legacy
      "1da1f2","4267b2","e1306c",                             // Social media
    ]);

    const normalise = (raw) => {
      let h = raw.trim().toLowerCase().replace(/^#/, "");
      if (h.length === 3) h = h.split("").map(c => c + c).join("");
      return h.length === 6 ? h : null;
    };

    const isSaturated = (hex) => {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      return max <= 230 && max >= 25 && (max - min) >= 40;
    };

    // Collect all <style> block text
    const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [])
      .map(s => s.replace(/<\/?style[^>]*>/gi, "")).join("\n");

    // 1. CSS custom properties for primary/brand color
    const varRe = /--(?:primary|brand|accent|main|color-primary|theme|club)[^:]*:\s*(#[0-9a-fA-F]{3,6})/gi;
    let m;
    while ((m = varRe.exec(css)) !== null) {
      const hex = normalise(m[1]);
      if (hex && isSaturated(hex) && !SKIP_COLORS.has(hex)) return "#" + hex;
    }

    // 2. Wix colour palette variables — newer Wix uses --color_N (11–35), older uses --color-N (5–15).
    //    Colours 11–14 / 1–4 are usually neutrals (white, black, greys) — skip them.
    const wixRe = /--color[_-](\d+)\s*:\s*(#[0-9a-fA-F]{3,6})/gi;
    const wixCandidates = [];
    while ((m = wixRe.exec(css)) !== null) {
      const idx = parseInt(m[1], 10);
      if (idx < 5 || (idx >= 11 && idx <= 14)) continue; // skip neutrals
      const hex = normalise(m[2]);
      if (hex && isSaturated(hex) && !SKIP_COLORS.has(hex)) wixCandidates.push(hex);
    }
    if (wixCandidates.length) return "#" + wixCandidates[0];

    // 3. Colors on structural selectors (header, nav, h1, h2, button, .site-header)
    const structRe = /(?:header|nav|\.site-header|\.navbar|h1|h2|button|\.btn-primary|\.wp-block-button)[^{]*\{[^}]*(?:background(?:-color)?|color)\s*:\s*(#[0-9a-fA-F]{3,6})/gi;
    const structCandidates = [];
    while ((m = structRe.exec(css)) !== null) {
      const hex = normalise(m[1]);
      if (hex && isSaturated(hex) && !SKIP_COLORS.has(hex)) structCandidates.push(hex);
    }
    if (structCandidates.length) return "#" + structCandidates[0];

    return null;
  } catch { return null; }
}

// Uses OpenAI Vision to identify the primary brand colour from a logo image URL.
// Returns a hex string like "#2d6a3f" or null on failure.
// Scores an image 1-10 for use as a sports club hero photo.
// 10 = large team group in club colours on pitch; 1 = individual/logo/text/food.
async function scoreImageForHero(imageUrl) {
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
        { type: "text", text: "Rate this image 1-10 as a sports club website hero photo. 10=large group of people or team in sports kit outdoors. 5=small group or training drill. 1=individual portrait, logo, text graphic, food, indoor event, or scenery with no people. Reply with just the number." }
      ]}],
      max_tokens: 5
    });
    const n = parseInt((resp.choices[0]?.message?.content || "").trim(), 10);
    return isNaN(n) ? 5 : Math.max(1, Math.min(10, n));
  } catch { return 5; }
}

// Re-orders a list of permanent image URLs so the best hero candidates come first.
// Only scores the first scoreCount images to keep latency low.
async function rankImagesForHero(urls, scoreCount = 6) {
  if (urls.length <= 1) return urls;
  const toScore = urls.slice(0, scoreCount);
  const rest    = urls.slice(scoreCount);
  const scores  = await Promise.all(toScore.map(u => scoreImageForHero(u)));
  const scored  = toScore.map((u, i) => ({ u, s: scores[i] }));
  scored.sort((a, b) => b.s - a.s);
  console.log(`[hero-rank] Scores: ${scored.map(x => `${x.s}`).join(", ")}`);
  return [...scored.map(x => x.u), ...rest];
}

async function extractBrandColorFromLogo(logoUrl) {
  if (!logoUrl) return null;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: logoUrl, detail: "low" } },
          { type: "text", text: "What is the single most suitable background or primary brand colour in this logo — the colour that represents the organisation's identity, typically used on shields, backgrounds, or dominant shapes? Ignore white, black, and incidental colours from sports equipment (e.g. yellow tennis balls, green grass, white sliotars). Prefer deep, rich colours like navy, dark green, maroon, or royal blue if present. Return only a hex colour code in the format #RRGGBB — nothing else." }
        ]
      }],
      max_tokens: 10
    });
    const hex = response.choices[0]?.message?.content?.trim() || "";
    const match = hex.match(/#[0-9a-fA-F]{6}/);
    if (match) {
      console.log(`[brand-color] Vision extracted: ${match[0]} from ${logoUrl}`);
      return match[0];
    }
    console.log(`[brand-color] Vision returned unexpected value: "${hex}"`);
    return null;
  } catch (e) {
    console.log(`[brand-color] Vision failed: ${e.message}`);
    return null;
  }
}

function instagramHandleScore(name, handle) {
  const tokens = name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(t => t.length > 2 && !["the", "and", "for", "our", "club"].includes(t));
  const norm = handle.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!tokens.length) return 0;
  return tokens.filter(t => norm.includes(t)).length / tokens.length;
}

async function detectInstagramHandle(name, pages) {
  const SKIP = new Set(["p", "reel", "reels", "explore", "tv", "stories", "accounts",
    "direct", "web", "about", "legal", "privacy", "safety", "help", "sharedfiles"]);

  const seen = new Set();
  const candidates = [];

  // 1. Scan crawled pages for instagram.com links — highest confidence
  for (const page of pages) {
    const content = (page.html || "") + " " + (page.text || "");
    const re = /(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{2,30})/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const handle = m[1].replace(/\/?$/, "");
      if (SKIP.has(handle.toLowerCase()) || seen.has(handle.toLowerCase())) continue;
      seen.add(handle.toLowerCase());
      const score = instagramHandleScore(name, handle);
      // Found on the club's own website — already high confidence
      candidates.push({ handle, confidence: score >= 0.5 ? 0.95 : score >= 0.3 ? 0.80 : 0.55, source: "website" });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  if (candidates[0]?.confidence >= 0.60) return candidates[0];

  // 2. DuckDuckGo search fallback — try two queries for better coverage
  const searchQueries = [
    `"${name}" site:instagram.com`,
    `${name} GAA instagram`,
  ];
  for (const query of searchQueries) {
    try {
      const q = encodeURIComponent(query);
      const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${q}`, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" },
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        const html = await res.text();
        const re2 = /instagram\.com\/([a-zA-Z0-9_.]{2,30})/g;
        const searchSeen = new Set();
        let m2;
        while ((m2 = re2.exec(html)) !== null) {
          const handle = m2[1].replace(/\/?$/, "");
          if (SKIP.has(handle.toLowerCase()) || searchSeen.has(handle.toLowerCase())) continue;
          searchSeen.add(handle.toLowerCase());
          const score = instagramHandleScore(name, handle);
          if (score >= 0.35) candidates.push({ handle, confidence: score * 0.82, source: "search" });
        }
      }
    } catch (e) {
      console.log(`[ig-detect] DuckDuckGo failed: ${e.message}`);
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  if (candidates[0]?.confidence >= 0.55) return candidates[0];

  return null;
}

async function fetchWikipediaLogo(name) {
  try {
    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&format=json&srlimit=1&utf8=1`,
      { headers: { "User-Agent": "Sprimal/1.0 (logo lookup)" }, signal: AbortSignal.timeout(6000) }
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const hit = searchData?.query?.search?.[0];
    if (!hit) return null;

    // Confirm result title is plausibly about this club (not a totally unrelated article)
    const titleLower = hit.title.toLowerCase();
    const nameLower  = name.toLowerCase().replace(/\s+gaa.*$/i, "").trim();
    if (!titleLower.includes(nameLower.split(" ")[0].toLowerCase())) return null;

    const imgRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(hit.title)}&prop=pageimages&pithumbsize=500&format=json&utf8=1`,
      { headers: { "User-Agent": "Sprimal/1.0 (logo lookup)" }, signal: AbortSignal.timeout(6000) }
    );
    if (!imgRes.ok) return null;
    const imgData = await imgRes.json();
    const page = Object.values(imgData?.query?.pages || {})[0];
    return page?.thumbnail?.source || null;
  } catch {
    return null;
  }
}

function extractFaviconUrl(html, baseUrl) {
  // 1. Prefer apple-touch-icon — highest quality (usually 180x180)
  const appleMatch = html.match(/<link[^>]+rel=["']apple-touch-icon(?:-precomposed)?["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']apple-touch-icon(?:-precomposed)?["']/i);
  if (appleMatch) {
    try {
      const url = new URL(appleMatch[1], baseUrl).href;
      if (!isGenericFavicon(url)) return url;
    } catch {}
  }

  // 2. og:image — usually the full brand/club logo used for social sharing
  //    Checked before <link rel="icon"> because favicons are often tiny (16px)
  //    while og:image is typically the proper high-resolution logo
  const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogMatch) {
    try {
      const url = new URL(ogMatch[1], baseUrl).href;
      if (url.startsWith("http")) return url;
    } catch {}
  }

  // 3. <img> tag with "logo" in class, id, or alt — catches basic sites without meta tags
  const imgRe = /<img[^>]+>/gi;
  let imgMatch;
  while ((imgMatch = imgRe.exec(html)) !== null) {
    const tag = imgMatch[0];
    const hasLogoHint = /(?:class|id|alt)=["'][^"']*logo[^"']*["']/i.test(tag)
                     || /(?:class|id|alt)=["'][^"']*brand[^"']*["']/i.test(tag);
    if (!hasLogoHint) continue;
    const srcMatch = tag.match(/src=["']([^"']+)["']/i);
    if (!srcMatch) continue;
    try {
      const url = new URL(srcMatch[1], baseUrl).href;
      if (url.startsWith("http") && !isGenericFavicon(url)) return url;
    } catch {}
  }

  // 4. <link rel="icon"> — last resort, often only a tiny 16px favicon
  const iconMatches = [...html.matchAll(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["'][^>]*>/gi)];
  for (const m of iconMatches.reverse()) {
    try {
      const url = new URL(m[1], baseUrl).href;
      if (!isGenericFavicon(url)) return url;
    } catch {}
  }

  return null;
}

function extractInternalLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const links = new Set();
  const re = /href=["']([^"'#][^"']*)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const href = m[1];
      if (href.startsWith("mailto:") || href.startsWith("tel:")) continue;
      const resolved = new URL(href, base.href);
      if (resolved.hostname !== base.hostname) continue;
      if (!["http:", "https:"].includes(resolved.protocol)) continue;
      if (/\.(pdf|jpg|jpeg|png|gif|svg|ico|css|js|woff|woff2|ttf|zip|xml|json)$/i.test(resolved.pathname)) continue;
      resolved.hash = "";
      links.add(resolved.href.replace(/\/$/, ""));
    } catch { /* skip invalid URLs */ }
  }
  return [...links];
}

// Extract internal links from Jina Reader markdown output (used when HTML is a bot-protection page)
// Jina returns markdown with links as [text](url) or bare https://same-domain/path
function extractLinksFromJinaText(jinaText, baseUrl) {
  const base = new URL(baseUrl);
  const links = new Set();
  // Markdown links: [text](url)
  const mdRe = /\[([^\]]*)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g;
  // Bare URLs in text
  const bareRe = /https?:\/\/[^\s"')>]+/g;
  const addUrl = (href) => {
    try {
      if (href.startsWith("mailto:") || href.startsWith("tel:")) return;
      const resolved = new URL(href, base.href);
      if (resolved.hostname !== base.hostname) return;
      if (!["http:", "https:"].includes(resolved.protocol)) return;
      if (/\.(pdf|jpg|jpeg|png|gif|svg|ico|css|js|woff|woff2|ttf|zip|xml|json)$/i.test(resolved.pathname)) return;
      resolved.hash = "";
      links.add(resolved.href.replace(/\/$/, ""));
    } catch {}
  };
  let m;
  while ((m = mdRe.exec(jinaText)) !== null) addUrl(m[2]);
  while ((m = bareRe.exec(jinaText)) !== null) addUrl(m[0]);
  return [...links];
}

// Common page paths that are important for clubs but often only in the nav menu
// (not discoverable from homepage body text when nav is JS-rendered).
// These are probed during every crawl — 404s are silently skipped.
const PROBE_PATHS = [
  "/contact", "/contact-us", "/about", "/about-us",
  "/membership", "/members", "/join", "/fees", "/pricing",
  "/coaching", "/lessons", "/tennis", "/facilities", "/courts",
  "/events", "/leagues", "/news", "/location", "/find-us",
  "/book", "/book-a-court", "/booking", "/court-booking", "/online-booking",
  "/play", "/book-online",
  // Committee / club officers — often a sub-page of About Us, not linked from homepage
  "/committee", "/our-committee", "/club-committee", "/officers", "/club-officers",
  "/about-us/committee", "/about/committee", "/about-us/officers", "/about/officers",
  "/the-club", "/the-club/committee", "/club-info", "/club-info/committee",
  "/management", "/board", "/committee-members", "/club-management",
  // Menu / food for cafes/restaurants
  "/menu", "/our-menu", "/food", "/drinks",
  // Opening hours
  "/hours", "/opening-hours", "/times",
  // Services
  "/services", "/what-we-do", "/offerings",
  // FAQ
  "/faq", "/faqs", "/frequently-asked-questions", "/help",
];

async function fetchSitemapUrls(rootUrl) {
  const base = rootUrl.replace(/\/$/, "");
  const urls = [];

  // Helper to parse <loc> URLs from a sitemap XML string
  const parseSitemapXml = (xml) => [...xml.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)]
    .map(m => m[1].trim())
    .filter(u => !u.endsWith(".xml"));

  const BOT_PHRASES = ["one moment, please", "please wait while your request is being verified", "checking your browser"];

  try {
    const res = await fetch(base + "/sitemap.xml", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return urls;
    let xml = await res.text();

    // If the sitemap is behind Cloudflare, try Jina Reader to get the real XML
    const xmlLower = xml.toLowerCase();
    if (BOT_PHRASES.some(p => xmlLower.includes(p))) {
      console.log(`[crawler] Sitemap bot-protected — trying Jina Reader for ${base}/sitemap.xml`);
      try {
        const jinaRes = await fetch(`https://r.jina.ai/${base}/sitemap.xml`, {
          headers: jinaHeaders(),
          signal: AbortSignal.timeout(15000)
        });
        if (jinaRes.ok) xml = await jinaRes.text();
      } catch {}
    }

    // Handle sitemap index (points to child sitemaps) — fetch in parallel, cap at 5
    const childSitemaps = [...xml.matchAll(/<loc>\s*(https?:\/\/[^<]+sitemap[^<]*\.xml)\s*<\/loc>/gi)].map(m => m[1]);
    if (childSitemaps.length > 0) {
      const results = await Promise.all(childSitemaps.slice(0, 5).map(async childUrl => {
        try {
          const childRes = await fetch(childUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
            signal: AbortSignal.timeout(6000)
          });
          if (!childRes.ok) return [];
          return parseSitemapXml(await childRes.text());
        } catch { return []; }
      }));
      urls.push(...results.flat());
    } else {
      urls.push(...parseSitemapXml(xml));
    }
  } catch {}
  return urls;
}

// URL path segments that are high-volume / low-value for an AI assistant.
// Pages under these paths are deprioritised (crawled only if budget remains).
const CRAWL_NOISE_PATTERNS = [
  /\/news(\/|$)/i,
  /\/blog(\/|$)/i,
  /\/match-report(s)?(\/|$)/i,
  /\/match(es)?(\/|$)/i,
  /\/results?(\/|$)/i,
  /\/fixtures?(\/|$)/i,
  /\/gallery(\/|$)/i,
  /\/photos?(\/|$)/i,
  /\/videos?(\/|$)/i,
  /\/events?(\/|$)/i,
  /\/articles?(\/|$)/i,
  /\/posts?(\/|$)/i,
  /\/tag(s)?(\/|$)/i,
  /\/category(\/|$)/i,
  /\/author(\/|$)/i,
  /\/page\/\d/i,
  /\?.*page=/i,
  /\/portfolio(\/|$)/i,
  /\/event-details?(\/|$)/i,
];

function isCrawlNoise(url) {
  try {
    const path = new URL(url).pathname;
    return CRAWL_NOISE_PATTERNS.some(re => re.test(path));
  } catch (e) { return false; }
}

// Content-based page quality filter — runs after fetching, before storing.
// Catches noise pages that URL patterns can't detect: blog posts with plain-English
// titles ("May 28th", "Wild Spirit"), thin event recap pages, photo galleries etc.
function isUsefulPageContent(title, text, url = "") {
  // Strip common site-name suffixes from title before pattern matching
  // e.g. "May 28th | MonkstownLTCC" → "May 28th"
  const t    = (title || "").trim().replace(/\s*[|\-–—]\s*.{3,40}$/, "").trim();
  const body = (text  || "").trim();

  // 1. Too thin to be useful — but allow structural pages (committee, about, contact etc.)
  //    which may be short by nature (a list of names, an address, opening hours)
  const STRUCTURAL_PATHS = /\/(committee|about|contact|members|membership|menu|hours|opening|faq|coaches|team|officers|facilities|courts)\b/i;
  const isStructural = STRUCTURAL_PATHS.test(url);
  const MIN_LENGTH = isStructural ? 80 : 400;
  if (body.length < MIN_LENGTH) return false;

  // 2. Title is a date or date fragment — "May 28th", "June 2024", "28th July"
  const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
  if (new RegExp(`^(${MONTHS})\\s+\\d{1,2}(st|nd|rd|th)?(,?\\s+\\d{4})?$`, "i").test(t)) return false;
  if (new RegExp(`^\\d{1,2}(st|nd|rd|th)\\s+(${MONTHS})`, "i").test(t)) return false;

  // 3. Title matches known event/social post patterns AND thin content
  const EVENT_PATTERNS = [
    /dinner dance/i, /prize.?giving/i, /photoshoot/i, /\bbbq\b/i,
    /club night/i,  /social evening/i, /annual dinner/i, /open day/i,
    /championship (bbq|dinner|party|night)/i, /coffee morning/i,
  ];
  if (EVENT_PATTERNS.some(p => p.test(t)) && body.length < 1200) return false;

  return true;
}

// Business-type specific probe paths — inserted at the FRONT of the crawl queue
// so they're always visited before generic pages, even when maxPages is tight.
const BUSINESS_TYPE_PROBE_PATHS = {
  tennis_club: [
    "/committee", "/about-us/committee", "/about/committee", "/our-committee",
    "/club-committee", "/officers", "/club-officers", "/the-club",
    "/membership", "/membership-fees", "/join", "/adult-membership", "/junior-membership",
    "/courts", "/facilities", "/court-booking", "/book-a-court",
    "/coaching", "/adult-coaching", "/junior-coaching", "/lessons",
    "/fixtures", "/leagues", "/results", "/club-championship",
  ],
  racket_sports_club: [
    "/committee", "/about-us/committee", "/officers",
    "/membership", "/join", "/courts", "/facilities",
    "/coaching", "/lessons", "/leagues", "/fixtures",
  ],
  golf_club: [
    "/committee", "/about-us/committee", "/officers", "/club-officers",
    "/membership", "/join", "/fees", "/green-fees",
    "/course", "/facilities", "/pro-shop",
    "/competitions", "/fixtures", "/results",
    "/coaching", "/lessons",
  ],
  fitness_studio: [
    "/classes", "/timetable", "/schedule", "/class-schedule",
    "/membership", "/pricing", "/join", "/fees",
    "/coaches", "/instructors", "/team", "/about",
    "/facilities",
  ],
  yoga_studio: [
    "/classes", "/timetable", "/schedule",
    "/membership", "/pricing", "/join",
    "/teachers", "/instructors", "/about",
    "/workshops",
  ],
  swim_club: [
    "/committee", "/about-us/committee", "/officers",
    "/membership", "/join", "/fees",
    "/training", "/squads", "/lessons",
    "/gala", "/fixtures", "/results",
  ],
  gaa_club: [
    "/committee", "/about-us/committee", "/officers", "/board",
    "/membership", "/join", "/become-a-member",
    "/hurling", "/football", "/camogie", "/ladies-football", "/ladies",
    "/fixtures", "/results", "/leagues", "/championship",
    "/lotto", "/club-lotto",
    "/training", "/coaching", "/underage", "/juvenile", "/youth",
    "/cul-camps", "/summer-camps",
    "/contact", "/find-us",
  ],
  team_sports_club: [
    "/committee", "/about-us/committee", "/officers",
    "/membership", "/join",
    "/fixtures", "/results", "/leagues",
    "/training", "/coaching", "/juvenile",
  ],
  cafe: [
    "/menu", "/our-menu", "/food-menu", "/drinks-menu", "/food",
    "/opening-hours", "/hours", "/times",
    "/book-a-table", "/reservations", "/book",
    "/specials", "/daily-specials",
    "/about", "/about-us", "/our-story",
  ],
};

// Reject localhost and private IP ranges before sending to Jina or insecure fetch
function isSafePublicUrl(url) {
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const h = u.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "::1") return false;
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h === "169.254.169.254") return false; // AWS metadata endpoint
    return true;
  } catch { return false; }
}

async function crawlWebsite(rootUrl, maxPages = 40, onProgress = null, businessType = null) {
  const visited = new Set();
  const root    = rootUrl.replace(/\/$/, "");
  let rootDomain = new URL(root).hostname.replace(/^www\./, "").toLowerCase();

  // Canonical form: strip www., normalise protocol to https, remove trailing slash
  // Used for deduplication — different spellings of the same URL map to one key.
  function canonicalUrl(u) {
    try {
      const parsed = new URL(u);
      parsed.hostname = parsed.hostname.replace(/^www\./, "");
      parsed.protocol = "https:";
      return (parsed.origin + parsed.pathname).replace(/\/$/, "") + parsed.search;
    } catch { return u; }
  }

  // Returns true if a URL belongs to the root domain (prevents following cross-domain redirects)
  function isSameDomain(u) {
    try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase() === rootDomain; }
    catch { return false; }
  }

  // Detect domain alias: if the root URL immediately redirects to a different domain
  // (e.g. .ie → .com custom domain), adopt the final domain as the crawl root.
  // This runs once before the main crawl loop.
  try {
    const aliasCheck = await fetch(root, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(6000),
      redirect: "follow",
    });
    const finalDomain = new URL(aliasCheck.url).hostname.replace(/^www\./, "").toLowerCase();
    if (finalDomain !== rootDomain) {
      console.log(`[crawler] Domain alias detected: ${rootDomain} → ${finalDomain} — crawling ${finalDomain}`);
      rootDomain = finalDomain;
    }
  } catch { /* ignore — main crawl will handle fetch errors */ }

  // Seed queue from sitemap if available — catches Wix & other JS-nav sites
  const sitemapUrls = await fetchSitemapUrls(root);
  const rootCanon   = canonicalUrl(root);
  let allUrls = sitemapUrls.length > 0
    ? sitemapUrls.filter(u => canonicalUrl(u).startsWith(rootCanon))
    : [root];

  // Always include root
  if (!allUrls.some(u => canonicalUrl(u) === rootCanon)) allUrls.unshift(root);

  // Probe generic paths only when business type is unknown — if we already know the type,
  // skip the 56 generic guesses and use only the targeted business-specific list instead.
  const probeSet = new Set(); // track speculative probes — skip Jina fallback for these
  const genericProbes = businessType ? [] : PROBE_PATHS;
  for (const p of genericProbes) {
    const probeUrl = root + p;
    const probeCanon = canonicalUrl(probeUrl);
    if (!allUrls.some(u => canonicalUrl(u) === probeCanon)) allUrls.push(probeUrl);
    probeSet.add(probeCanon);
  }

  // Business-type specific paths — added to a priority list that goes to the
  // FRONT of the crawl queue, before any sitemap/generic pages
  const bizProbePaths = (businessType && BUSINESS_TYPE_PROBE_PATHS[businessType]) || [];
  const bizPriorityUrls = [];
  for (const p of bizProbePaths) {
    const probeUrl = root + p;
    const probeCanon = canonicalUrl(probeUrl);
    if (!allUrls.some(u => canonicalUrl(u) === probeCanon)) {
      allUrls.push(probeUrl); // add to full list for dedup
    }
    probeSet.add(probeCanon);
    bizPriorityUrls.push(probeUrl); // always in priority list
  }

  // Hard-block URLs that are always duplicates or system pages
  const HARD_BLOCK_PATTERNS = [
    /\/wp-login\.php/i,
    /\/wp-admin(\/|$)/i,
    /\/wp-json(\/|$)/i,
    /\/feed(\/|$)/i,
    /\/xmlrpc\.php/i,
    /\/cart(\/|$)/i,
    /\/checkout(\/|$)/i,
    /\/my-account(\/|$)/i,
    /\/lost-password/i,
    /\?action=lostpassword/i,
    /\?redirect_to=/i,
    // Author/user archive pages — never useful for AI receptionist
    /\/author\//i,
    // Tag and date archive pages
    /\/tag\//i,
    /\/\d{4}\/\d{2}(\/|$)/i,
  ];
  function isBlockedUrl(u) {
    try {
      const sp = new URL(u).searchParams;
      if (sp.has("p") || sp.has("page_id")) return true;
      return HARD_BLOCK_PATTERNS.some(re => re.test(u));
    } catch { return false; }
  }
  allUrls = allUrls.filter(u => !isBlockedUrl(u));

  // Queue order: priority pages first (non-noise), noise pages only if budget remains.
  // No artificial front-jumping — pages are discovered naturally from the sitemap and links.
  const priorityUrls = allUrls.filter(u => !isCrawlNoise(u));
  const noiseUrls    = allUrls.filter(u => isCrawlNoise(u));
  const queue = [...priorityUrls, ...noiseUrls];

  const bizLabel = businessType ? ` | biz-type: ${businessType}` : "";
  console.log(`[crawler] Queue: ${allUrls.length} total URLs (${priorityUrls.length} priority, ${noiseUrls.length} noise)${bizLabel} — cap: ${maxPages} pages`);

  const pages   = [];
  let siteIsSlow = false;        // set true if homepage direct fetch fails — skip direct fetch for subsequent pages
  let siteNeedsInsecure = false; // set true if site has a broken SSL cert — use insecure fetch for all pages

  // ── Helper: fetch and process a single page ───────────────────────────────
  const BOT_PROTECTION_PHRASES = [
    "one moment, please", "please wait while your request is being verified",
    "checking your browser", "enable javascript and cookies",
    "ddos protection by cloudflare", "ray id:", "cf-browser-verification"
  ];

  async function fetchOnePage(url) {
    const isProbe = probeSet.has(canonicalUrl(url));
    // If site has a broken SSL cert, skip straight to insecure fetch
    if (siteNeedsInsecure && !isProbe) {
      return await insecureFetch(url);
    }
    // If homepage already proved the site is too slow for direct fetch, skip straight to Jina
    if (siteIsSlow && !isProbe) {
      return await jinaFallback(url, "", "site is slow — skipping direct fetch");
    }
    try {
      console.log(`[crawler] Fetching: ${url}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), isProbe ? 3000 : 15000);
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) { console.log(`[crawler] Skip ${url}: HTTP ${response.status}`); return null; }

      // Reject pages where a redirect took us to a different domain (e.g. .ie → .com alias)
      const finalDomain = new URL(response.url).hostname.replace(/^www\./, "").toLowerCase();
      if (finalDomain !== rootDomain) {
        console.log(`[crawler] Skip ${url}: redirected to different domain (${finalDomain})`);
        return null;
      }

      const ct = response.headers.get("content-type") || "";
      if (!ct.includes("text/html")) { console.log(`[crawler] Skip ${url}: content-type "${ct}"`); return null; }

      const html  = await response.text();
      const title = extractPageTitle(html);
      const externalUrls = extractExternalUrlsFromHtml(html);
      const anchorLinks  = extractLinksWithAnchorText(html, url);
      const rawText = extractTextFromHtml(html);
      const text = rawText
        + (externalUrls.length ? "\n\nBooking platform links: " + externalUrls.join(" ") : "")
        + (anchorLinks.length  ? "\n\n[Linked forms and resources]\n" + anchorLinks.map(l => `${l.text} → ${l.url}`).join("\n") : "");

      const isBotProtected = BOT_PROTECTION_PHRASES.some(p => text.toLowerCase().includes(p));

      // Detect JS-rendered page shells (Wix, Next.js, Nuxt, React SPA).
      // These sites return an HTML skeleton — real content is injected by JS at runtime.
      // The direct fetch sees nav + footer boilerplate but none of the actual page body.
      const JS_SHELL_SIGNALS = [
        'content="wix.com"', 'data-mesh-id=', '_wix_', 'wixui.',
        '__NEXT_DATA__', '__NUXT__', 'data-reactroot', 'ng-version='
      ];
      const isJsShell = JS_SHELL_SIGNALS.some(s => html.includes(s));
      const wordCount = rawText.split(/\s+/).filter(w => w.length > 2).length;
      // Wix/React shells return 200-300 words of nav+footer boilerplate — use a higher bar
      // so committee pages, about pages etc. still get Jina even if they look non-trivial
      const isThinForShell = isJsShell && wordCount < 400;
      // Catch unrecognised SPAs that aren't in our signal list but are still near-empty
      const isThinForAny = !isJsShell && wordCount < 80;

      if (text.length < 80 || isBotProtected || isThinForShell || isThinForAny) {
        if (isProbe) { console.log(`[crawler] Probe skip (thin/bot/js-shell) ${url}`); return null; }
        const reason = isBotProtected ? "bot-protection page detected"
          : isThinForShell ? `JS-rendered shell detected (${wordCount} words) — Wix/React boilerplate, trying Jina`
          : isThinForAny ? `Very thin page (${wordCount} words) — may be unrecognised SPA, trying Jina`
          : "text too short";
        return await jinaFallback(url, html, reason);
      }

      return { page: { url, title, text, html }, links: extractInternalLinks(html, url) };

    } catch (err) {
      if (err.name === "AbortError" || err.name === "TypeError") {
        if (isProbe) { console.log(`[crawler] Probe skip (${err.name}) ${url}`); return null; }
        siteIsSlow = true; // direct fetch failed — skip it for all subsequent pages
        return await jinaFallback(url, "", `fetch failed (${err.name})`);
      }
      console.error(`[crawler] Error fetching ${url}:`, err.message);
      return null;
    }
  }

  async function jinaFallback(url, html, reason) {
    if (!isSafePublicUrl(url)) {
      console.log(`[crawler] Blocked unsafe URL from Jina: ${url}`);
      return null;
    }
    try {
      console.log(`[crawler] ${reason} — trying Jina Reader for ${url}`);
      const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
        headers: jinaHeaders(),
        signal: AbortSignal.timeout(30000)
      });
      if (!jinaRes.ok) {
        console.log(`[crawler] Jina returned HTTP ${jinaRes.status} for ${url} — trying insecure fetch`);
        return await insecureFetch(url, html);
      }
      const jinaText = (await jinaRes.text()).trim();
      if (jinaText.length < 80) {
        console.log(`[crawler] Jina returned empty/thin content for ${url} — trying insecure fetch`);
        return await insecureFetch(url, html);
      }

      const title = extractPageTitle(html) || url.split("/").filter(Boolean).pop() || "Page";
      const externalUrls = extractExternalUrlsFromHtml(html);
      const anchorLinks  = extractLinksWithAnchorText(html, url);
      const finalText = jinaText
        + (externalUrls.length ? "\n\nBooking platform links: " + externalUrls.join(" ") : "")
        + (anchorLinks.length  ? "\n\n[Linked forms and resources]\n" + anchorLinks.map(l => `${l.text} → ${l.url}`).join("\n") : "");

      const htmlLinks  = extractInternalLinks(html, url);
      const jinaLinks  = extractLinksFromJinaText(jinaText, url);
      const links = [...new Set([...htmlLinks, ...jinaLinks])];
      console.log(`[crawler] Jina succeeded for ${url} (${jinaText.length} chars)`);
      return { page: { url, title, text: finalText, html }, links };
    } catch (jinaErr) {
      console.log(`[crawler] Jina also failed for ${url}: ${jinaErr.message} — trying insecure fetch`);
      return await insecureFetch(url, html);
    }
  }

  // Last-resort fetch that bypasses SSL certificate verification.
  // Only used when direct fetch AND Jina both fail (typically a broken/self-signed cert).
  async function insecureFetch(url, html = "") {
    if (!isSafePublicUrl(url)) return null;
    console.log(`[crawler] SSL cert issue — retrying without verification for ${url}`);
    return new Promise((resolve) => {
      try {
        const https = require("https");
        const http  = require("http");
        const mod   = url.startsWith("https") ? https : http;
        const agent = url.startsWith("https") ? new https.Agent({ rejectUnauthorized: false }) : undefined;
        const req   = mod.get(url, {
          agent,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
          timeout: 15000
        }, (res) => {
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => {
            if (res.statusCode < 200 || res.statusCode >= 300) { resolve(null); return; }
            const rawText = extractTextFromHtml(data);
            if (rawText.length < 80) { resolve(null); return; }
            const title        = extractPageTitle(data) || url.split("/").filter(Boolean).pop() || "Page";
            const externalUrls = extractExternalUrlsFromHtml(data);
            const anchorLinks  = extractLinksWithAnchorText(data, url);
            const text = rawText
              + (externalUrls.length ? "\n\nBooking platform links: " + externalUrls.join(" ") : "")
              + (anchorLinks.length  ? "\n\n[Linked forms and resources]\n" + anchorLinks.map(l => `${l.text} → ${l.url}`).join("\n") : "");
            const links = extractInternalLinks(data, url);
            siteNeedsInsecure = true;
            console.log(`[crawler] Insecure fetch succeeded for ${url} (${rawText.length} chars) ⚠️ broken SSL cert`);
            resolve({ page: { url, title, text, html: data }, links });
          });
        });
        req.on("error", (e) => { console.log(`[crawler] Insecure fetch also failed for ${url}: ${e.message}`); resolve(null); });
        req.on("timeout", () => { req.destroy(); resolve(null); });
      } catch (e) {
        console.log(`[crawler] Insecure fetch error for ${url}: ${e.message}`);
        resolve(null);
      }
    });
  }

  // ── Parallel batch crawl ─────────────────────────────────────────────────────
  const BATCH_SIZE = 5;

  while (queue.length > 0 && pages.length < maxPages) {
    // Build next batch — mark URLs visited immediately to prevent batch duplicates
    const batch = [];
    while (batch.length < BATCH_SIZE && queue.length > 0 && pages.length + batch.length < maxPages) {
      const url = queue.shift();
      if (!url || isBlockedUrl(url)) continue;
      const canon = canonicalUrl(url);
      if (visited.has(canon)) continue;
      visited.add(canon);
      batch.push(url);
    }
    if (batch.length === 0) break;

    // Fetch all pages in batch concurrently
    const results = await Promise.all(batch.map(url => fetchOnePage(url)));

    // Process results — add pages and discovered links
    for (const result of results) {
      if (!result) continue;
      pages.push(result.page);
      for (const link of result.links) {
        if (isBlockedUrl(link)) continue;
        if (!isSameDomain(link)) continue; // never follow cross-domain links
        const lc = canonicalUrl(link);
        if (!visited.has(lc) && !queue.some(q => canonicalUrl(q) === lc)) queue.push(link);
      }
    }
    if (onProgress && pages.length > 0) onProgress(pages.length);
    // Brief pause between batches — avoids hammering slow or rate-limited sites
    await new Promise(r => setTimeout(r, 300));
  }

  return pages;
}

// ── POST /api/import-website ──────────────────────────────────────────────

app.post("/api/import-website", requireSenior, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  let rootUrl;
  try { rootUrl = new URL(url).href; }
  catch { return res.status(400).json({ error: "Invalid URL" }); }

  try {
    console.log(`[import-website] Starting crawl of ${rootUrl}`);
    const pages = await crawlWebsite(rootUrl, 80);
    console.log(`[import-website] Crawled ${pages.length} pages`);

    let imported = 0;
    const errors = [];

    for (const page of pages) {
      if (!isUsefulPageContent(page.title, page.text, page.url)) {
        console.log(`[import-website] Skipping noise page: "${page.title}" (${page.text?.length || 0} chars)`);
        continue;
      }
      try {
        const { data: doc, error: insertError } = await supabase
          .from("documents")
          .insert({
            original_filename: page.title,
            stored_filename:   page.url,
            mimetype:          "text/html",
            lender:            null,
            document_type:     "Website Content",
            effective_date:    null,
            tags:              ["website"],
            metadata_complete: true,
            junior_accessible: true,
            storage_path:      page.url,
            tenant_id:         "aom"
          })
          .select()
          .single();

        if (insertError) {
          errors.push(`${page.url}: ${insertError.message}`);
          continue;
        }

        await generateAndStoreChunks(doc.id, page.text, null, "Website Content", null, "aom", { title: page.title || page.url });
        imported++;
        console.log(`[import-website] Imported page ${imported}: ${page.title}`);
      } catch (err) {
        errors.push(`${page.url}: ${err.message}`);
      }
    }

    res.json({ success: true, pagesFound: pages.length, imported, errors: errors.length ? errors : undefined });

  } catch (err) {
    console.error("[import-website] Error:", err);
    res.status(500).json({ error: "Failed to crawl website: " + err.message });
  }
});

// ── DELETE /api/import-website — remove all pages from a domain ──────────────

app.delete("/api/import-website", requireSenior, async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: "Domain is required" });

  try {
    // Find all website documents matching this domain
    const { data: docs, error: fetchError } = await supabase
      .from("documents")
      .select("id")
      .eq("document_type", "Website Content")
      .ilike("stored_filename", `%${domain}%`);

    if (fetchError) return res.status(500).json({ error: fetchError.message });
    if (!docs || docs.length === 0) return res.json({ success: true, deleted: 0 });

    const ids = docs.map(d => d.id);

    // Delete documents (knowledge_chunks cascade automatically)
    const { error: deleteError } = await supabase
      .from("documents")
      .delete()
      .in("id", ids);

    if (deleteError) return res.status(500).json({ error: deleteError.message });

    console.log(`[remove-website] Deleted ${ids.length} pages from ${domain}`);
    res.json({ success: true, deleted: ids.length });

  } catch (err) {
    console.error("[remove-website] Error:", err);
    res.status(500).json({ error: "Failed to remove website: " + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Tenant self-serve signup ──────────────────────────────────────────────────

app.get("/signup", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "signup.html"));
});

// ── Pre-flight website reachability check (called from signup form) ──────────
app.get("/api/check-url", async (req, res) => {
  const url = (req.query.url || "").trim();
  if (!url) return res.json({ reachable: false, error: "No URL provided" });

  // Basic sanity — must look like an http/https URL
  let parsed;
  try { parsed = new URL(url); } catch(e) {
    return res.json({ reachable: false, error: "Invalid URL" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.json({ reachable: false, error: "Invalid protocol" });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Sprimalbot/1.0 (website-check)" }
    });
    clearTimeout(timer);
    // 2xx and 3xx (already followed), and even 401/403 mean the site is live
    // 5xx means a broken server — treat as unreachable
    const reachable = response.status < 500;
    return res.json({ reachable, status: response.status });
  } catch (err) {
    const reason = err.name === "AbortError" ? "timeout" : err.message;
    return res.json({ reachable: false, error: reason });
  }
});

// ── Background crawl (runs after email verification) ─────────────────────────
// Extracts meaningful photos from crawled website HTML, downloads them, and
// re-hosts in Supabase Storage. Returns permanent public URLs.
// Skips tiny images (< 15 KB), icons, logos, and SVGs.
async function extractAndRehostWebsiteImages(pages, tenantId, maxImages = 9) {
  const seen = new Set();
  const candidates = [];

  for (const page of pages) {
    // 1. Extract from raw HTML — img src/data-src tags AND bare CDN URLs anywhere in the HTML
    //    (Wix and similar JS-rendered sites embed image URLs in <script> JSON, not <img> tags)
    if (page.html) {
      const srcRe = /<img[^>]+(?:src|data-src|data-lazy-src|data-original)=["']([^"'>\s]+)["'][^>]*/gi;
      let m;
      while ((m = srcRe.exec(page.html)) !== null) {
        const src = m[1];
        if (!src || src.startsWith("data:")) continue;
        let abs;
        try { abs = new URL(src, page.url).href; } catch { continue; }
        if (!/\.(jpe?g|png|webp)/i.test(abs)) continue;
        if (/\bicon\b|\blogo\b|favicon|avatar|sprite|placeholder|\bbadge\b|arrow|bullet/i.test(abs)) continue;
        if (!seen.has(abs)) { seen.add(abs); candidates.push(abs); }
        if (candidates.length >= maxImages * 4) break;
      }
      // Scan for CSS background-image: url(...) — many hero sections use this instead of <img> tags
      const bgRe = /background(?:-image)?\s*:\s*url\(\s*["']?(https?:\/\/[^"')>\s]+\.(?:jpe?g|png|webp)[^"')>\s]*)["']?\s*\)/gi;
      let mb;
      while ((mb = bgRe.exec(page.html)) !== null) {
        const u = mb[1];
        if (/\bicon\b|\blogo\b|favicon|avatar|sprite|placeholder|\bbadge\b|arrow|bullet/i.test(u)) continue;
        if (!seen.has(u)) { seen.add(u); candidates.push(u); }
        if (candidates.length >= maxImages * 4) break;
      }
      // Also scan full HTML for CDN image URLs in script tags / JSON (Wix, Squarespace, WordPress, Webflow, Cloudinary, imgix, etc.)
      const cdnRe = /https?:\/\/(?:static\.wixstatic\.com\/media|images\.squarespace-cdn\.com|cdn\.shopify\.com\/s\/files|[a-z0-9-]+\.cloudfront\.net|[a-z0-9-]+\.wp\.com|[^"'\s<>]*\/wp-content\/uploads\/|assets\.website-files\.com|res\.cloudinary\.com|[a-z0-9-]+\.imgix\.net|[a-z0-9-]+\.webflow\.io)[^\s"'<>]+\.(?:jpe?g|png|webp)/gi;
      let m2;
      while ((m2 = cdnRe.exec(page.html)) !== null) {
        const u = m2[0];
        if (/\bicon\b|\blogo\b|favicon|avatar|sprite|placeholder|\bbadge\b/i.test(u)) continue;
        if (!seen.has(u)) { seen.add(u); candidates.push(u); }
        if (candidates.length >= maxImages * 4) break;
      }
      // The Club App (theclubapp.com) — popular Irish GAA/sports platform serving images from S3 without file extensions
      const clubAppRe = /https?:\/\/(?:theclubapp-photos-production\.s3[^"'\s<>]*|s3[^"'\s<>]*amazonaws[^"'\s<>]*\/theclubapp-photos-production\/media[^"'\s<>]*)/gi;
      let m3;
      while ((m3 = clubAppRe.exec(page.html)) !== null) {
        const u = m3[0].replace(/['">\s].*$/, ""); // trim any trailing quote/tag
        if (/\bicon\b|\blogo\b|favicon|avatar|sprite|placeholder|\bbadge\b/i.test(u)) continue;
        if (!seen.has(u)) { seen.add(u); candidates.push(u); }
        if (candidates.length >= maxImages * 4) break;
      }
      // Broad fallback: catch any remaining https image URL in the HTML not caught above
      if (candidates.length < maxImages * 2) {
        const broadRe = /https?:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp)(?:\?[^\s"'<>]*)?/gi;
        let mb2;
        while ((mb2 = broadRe.exec(page.html)) !== null) {
          const u = mb2[0];
          if (/\bicon\b|\blogo\b|favicon|avatar|sprite|placeholder|\bbadge\b|arrow|bullet/i.test(u)) continue;
          if (!seen.has(u)) { seen.add(u); candidates.push(u); }
          if (candidates.length >= maxImages * 4) break;
        }
      }
    }
    // 2. Extract from Jina markdown text — Jina embeds images as ![alt](url) or bare CDN URLs
    //    This handles bot-protected pages where page.html is the bot-protection splash, not real HTML
    if (page.text && candidates.length < maxImages * 4) {
      const mdImgRe = /!\[[^\]]*\]\((https?:\/\/[^)\s]+\.(?:jpe?g|png|webp)[^)]*)\)/gi;
      const bareUrlRe = /https?:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp)(?:\?[^\s"'<>]*)?/gi;
      for (const re of [mdImgRe, bareUrlRe]) {
        let m2;
        while ((m2 = re.exec(page.text)) !== null) {
          const u = m2[1] || m2[0];
          if (/\bicon\b|\blogo\b|favicon|avatar|sprite|placeholder|\bbadge\b/i.test(u)) continue;
          if (!seen.has(u)) { seen.add(u); candidates.push(u); }
          if (candidates.length >= maxImages * 4) break;
        }
      }
    }
    if (candidates.length >= maxImages * 4) break;
  }

  console.log(`[img-extract] ${candidates.length} candidate image URLs found for ${tenantId}`);

  // Download all candidates and rank by resolution before uploading
  const downloaded = [];
  for (const imgUrl of candidates) {
    if (downloaded.length >= maxImages * 3) break;
    try {
      const r = await fetch(imgUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Referer": new URL(imgUrl).origin + "/", "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
        signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) { console.log(`[img-extract] Skip ${imgUrl}: HTTP ${r.status}`); continue; }
      const ct = r.headers.get("content-type") || "";
      if (!ct.startsWith("image/")) { console.log(`[img-extract] Skip ${imgUrl}: content-type ${ct}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 10000) { console.log(`[img-extract] Skip ${imgUrl}: too small (${buf.length} bytes)`); continue; }
      let pixels = buf.length;
      try { const d = sizeOf(buf); pixels = (d.width || 0) * (d.height || 0); } catch {}
      downloaded.push({ buf, ct, pixels, url: imgUrl });
    } catch (e) {
      // On any HTTPS fetch failure, retry without certificate verification (broken-cert sites)
      if (imgUrl.startsWith("https://") && isSafePublicUrl(imgUrl)) {
        console.log(`[img-extract] SSL cert issue — retrying insecure for ${imgUrl}`);
        try {
          const buf = await new Promise((resolve, reject) => {
            const https = require("https");
            const chunks = [];
            const reqOrigin = new URL(imgUrl).origin + "/";
            const req = https.get(imgUrl, {
              agent: new https.Agent({ rejectUnauthorized: false }),
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Referer": reqOrigin,
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
              },
              timeout: 10000
            }, (res) => {
              if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
              res.on("data", c => chunks.push(c));
              res.on("end", () => resolve(Buffer.concat(chunks)));
            });
            req.on("error", reject);
            req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
          });
          if (buf.length < 10000) { console.log(`[img-extract] Skip ${imgUrl}: too small after insecure retry`); continue; }
          let pixels = buf.length;
          try { const d = sizeOf(buf); pixels = (d.width || 0) * (d.height || 0); } catch {}
          const ct = imgUrl.endsWith(".png") ? "image/png" : imgUrl.endsWith(".webp") ? "image/webp" : "image/jpeg";
          downloaded.push({ buf, ct, pixels, url: imgUrl });
          console.log(`[img-extract] Insecure fetch succeeded for ${imgUrl} ⚠️ broken SSL cert`);
        } catch (e2) { console.log(`[img-extract] Insecure fetch also failed for ${imgUrl}: ${e2.message}`); }
      } else {
        console.log(`[img-extract] Fetch error ${imgUrl}: ${e.message}`);
      }
    }
  }
  console.log(`[img-extract] ${downloaded.length} images downloaded successfully for ${tenantId}`);

  // Sort highest resolution first
  downloaded.sort((a, b) => b.pixels - a.pixels);

  const permanent = [];
  for (let i = 0; i < Math.min(maxImages, downloaded.length); i++) {
    const { buf, ct, url } = downloaded[i];
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
    const storagePath = `${tenantId}/site_${i}.${ext}`;
    const { error } = await supabase.storage.from("social-images").upload(storagePath, buf, { contentType: ct, upsert: true });
    if (error) {
      console.error(`[img-extract] Upload failed for ${storagePath}: ${error.message}`);
    } else {
      const { data: { publicUrl } } = supabase.storage.from("social-images").getPublicUrl(storagePath);
      console.log(`[img-extract] Uploaded site_${i} from ${url}`);
      permanent.push(publicUrl);
    }
  }

  console.log(`[img-extract] Re-hosted ${permanent.length} website images for ${tenantId} (sorted by resolution)`);
  return permanent;
}

// Scrapes an Instagram public profile page and returns up to maxImages CDN thumbnail URLs.
// Instagram doesn't require auth for public profiles, but does rate-limit bots.
// Falls back to [] on any error — never throws.
// Scrapes an Instagram public profile for post thumbnails and re-hosts them in
// Supabase Storage so the URLs are permanent (Instagram CDN URLs expire within hours).
async function fetchInstagramThumbnails(handle, tenantId, maxImages = 9) {
  if (!handle) return [];
  try {
    const profileUrl = `https://www.instagram.com/${encodeURIComponent(handle)}/`;
    const res = await fetch(profileUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log(`[ig-scrape] HTTP ${res.status} for @${handle}`);
      return [];
    }
    const html = await res.text();

    // Extract CDN thumbnail URLs from embedded JSON blobs
    const seen = new Set();
    const cdnUrls = [];
    const cdnRe = /https:\/\/[a-z0-9_.-]+\.(?:cdninstagram|fbcdn)\.net\/[^"'\s\\]+\.(?:jpg|jpeg|webp)(?:\?[^"'\s\\]*)?/gi;
    let m;
    while ((m = cdnRe.exec(html)) !== null && cdnUrls.length < maxImages) {
      const imgUrl = m[0].replace(/\\u0026/g, "&").replace(/\\/g, "");
      // Skip tiny thumbnails (s150x150, s32x32 etc.) — keep anything 300px+
      if (/s\d{1,3}x\d{1,3}/.test(imgUrl) && !/s[3-9]\d{2}x[3-9]\d{2}/.test(imgUrl)) continue;
      if (!seen.has(imgUrl)) { seen.add(imgUrl); cdnUrls.push(imgUrl); }
    }
    console.log(`[ig-scrape] Found ${cdnUrls.length} CDN thumbnails for @${handle}`);

    // Jina Reader fallback — Instagram often returns a login wall on direct fetch
    if (cdnUrls.length === 0) {
      try {
        console.log(`[ig-scrape] Trying Jina Reader for @${handle}`);
        const jinaRes = await fetch(`https://r.jina.ai/https://www.instagram.com/${encodeURIComponent(handle)}/`, {
          headers: jinaHeaders(),
          signal: AbortSignal.timeout(15000),
        });
        if (jinaRes.ok) {
          const jinaText = await jinaRes.text();
          const cdnRe2 = /https:\/\/[a-z0-9_.-]+\.(?:cdninstagram|fbcdn|scontent)\.net\/[^\s"'<>\\]+\.(?:jpe?g|webp)/gi;
          const mdRe = /!\[[^\]]*\]\((https?:\/\/[^)\s]+\.(?:jpe?g|png|webp)[^)]*)\)/gi;
          for (const re of [cdnRe2, mdRe]) {
            let jm;
            while ((jm = re.exec(jinaText)) !== null && cdnUrls.length < maxImages) {
              const u = (jm[1] || jm[0]).replace(/\\u0026/g, "&");
              if (!seen.has(u)) { seen.add(u); cdnUrls.push(u); }
            }
          }
          console.log(`[ig-scrape] Jina found ${cdnUrls.length} URLs for @${handle}`);
        }
      } catch (jinaErr) {
        console.log(`[ig-scrape] Jina also failed for @${handle}: ${jinaErr.message}`);
      }
    }

    // IG proxy fallbacks — try imginn then dumpor (render static HTML, no login wall)
    const igProxies = [
      `https://imginn.com/${encodeURIComponent(handle)}/`,
      `https://dumpor.com/v/${encodeURIComponent(handle)}`,
    ];
    for (const proxyUrl of igProxies) {
      if (cdnUrls.length >= 3) break;
      try {
        console.log(`[ig-scrape] Trying proxy: ${proxyUrl}`);
        const pRes = await fetch(`https://r.jina.ai/${proxyUrl}`, {
          headers: jinaHeaders(),
          signal: AbortSignal.timeout(15000),
        });
        if (pRes.ok) {
          const pText = await pRes.text();
          // Only accept genuine Instagram CDN URLs — proxy sites also serve their own UI images
          const pCdnRe = /https:\/\/[a-z0-9_.-]+\.(?:cdninstagram|fbcdn|scontent)\.net\/[^\s"'<>\\]+\.(?:jpe?g|webp)/gi;
          let pm;
          while ((pm = pCdnRe.exec(pText)) !== null && cdnUrls.length < maxImages) {
            const u = pm[0].replace(/\\u0026/g, "&");
            if (!seen.has(u)) { seen.add(u); cdnUrls.push(u); }
          }
          console.log(`[ig-scrape] Proxy found ${cdnUrls.length} total URLs (${proxyUrl})`);
        } else {
          console.log(`[ig-scrape] Proxy HTTP ${pRes.status} (${proxyUrl})`);
        }
      } catch (pErr) {
        console.log(`[ig-scrape] Proxy failed (${proxyUrl}): ${pErr.message}`);
      }
    }

    if (cdnUrls.length === 0) return [];

    // Download all CDN images, rank by resolution, upload top N
    const igDownloaded = [];
    for (const cdnUrl of cdnUrls) {
      try {
        const imgRes = await fetch(cdnUrl, { signal: AbortSignal.timeout(8000) });
        if (!imgRes.ok) continue;
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const ct = imgRes.headers.get("content-type") || "image/jpeg";
        let pixels = buffer.length;
        try { const d = sizeOf(buffer); pixels = (d.width || 0) * (d.height || 0); } catch {}
        igDownloaded.push({ buffer, ct, pixels });
      } catch (e) {
        console.log(`[ig-scrape] Download failed: ${e.message}`);
      }
    }
    igDownloaded.sort((a, b) => b.pixels - a.pixels);

    const permanentUrls = [];
    for (let i = 0; i < Math.min(maxImages, igDownloaded.length); i++) {
      const { buffer, ct } = igDownloaded[i];
      const ext = ct.includes("webp") ? "webp" : "jpg";
      const storagePath = `${tenantId}/ig_${i}.${ext}`;
      const { error: uploadErr } = await supabase.storage
        .from("social-images")
        .upload(storagePath, buffer, { contentType: ct, upsert: true });
      if (uploadErr) { console.log(`[ig-scrape] Upload failed for image ${i}: ${uploadErr.message}`); continue; }
      const { data: { publicUrl } } = supabase.storage.from("social-images").getPublicUrl(storagePath);
      permanentUrls.push(publicUrl);
    }
    console.log(`[ig-scrape] Re-hosted ${permanentUrls.length}/${cdnUrls.length} images for @${handle} (${tenantId}), sorted by resolution`);
    return permanentUrls;
  } catch (err) {
    console.log(`[ig-scrape] Failed for @${handle}: ${err.message}`);
    return [];
  }
}

async function fetchTwitterPhotos(handle, tenantId, maxImages = 6) {
  if (!handle) return [];
  // Strip full URL if someone saved "https://x.com/Handle" instead of just "Handle"
  const twUrlMatch = handle.match(/(?:twitter|x)\.com\/([A-Za-z0-9_]+)/);
  if (twUrlMatch) handle = twUrlMatch[1];
  try {
    // Try Nitter instances (open-source Twitter frontend, renders static HTML — no JS required)
    const nitterHosts = [
      "nitter.poast.org",
      "nitter.privacydev.net",
      "nitter.1d4.us",
    ];
    const seen = new Set();
    const cdnUrls = [];

    const extractTwImgs = (text) => {
      // Nitter serves images via its own proxy: /pic/... paths resolving to pbs.twimg.com
      const re1 = /https?:\/\/[a-z0-9.-]*nitter[a-z0-9.-]*\/pic\/(?:enc\/)?[A-Za-z0-9%_.-]+/gi;
      // Direct pbs.twimg.com URLs
      const re2 = /https:\/\/pbs\.twimg\.com\/media\/[A-Za-z0-9_-]+(?:\?format=(?:jpg|png|webp)(?:&(?:amp;)?name=\w+)?)?/gi;
      // Markdown image links
      const re3 = /!\[[^\]]*\]\((https?:\/\/[^)\s]+(?:\.(?:jpe?g|png|webp)|twimg\.com\/media\/[^)\s]+))\)/gi;
      for (const re of [re1, re2, re3]) {
        let m;
        while ((m = re.exec(text)) !== null && cdnUrls.length < maxImages * 2) {
          const raw = (m[1] || m[0]).replace(/&amp;/g, "&");
          if (!seen.has(raw)) { seen.add(raw); cdnUrls.push(raw); }
        }
      }
    };

    for (const host of nitterHosts) {
      if (cdnUrls.length >= maxImages) break;
      try {
        const nitterUrl = `https://${host}/${encodeURIComponent(handle)}/media`;
        console.log(`[tw-scrape] Trying Nitter: ${nitterUrl}`);
        const nRes = await fetch(`https://r.jina.ai/${nitterUrl}`, {
          headers: jinaHeaders(),
          signal: AbortSignal.timeout(20000),
        });
        if (nRes.ok) {
          extractTwImgs(await nRes.text());
          console.log(`[tw-scrape] Nitter (${host}) found ${cdnUrls.length} URLs`);
          if (cdnUrls.length > 0) break;
        } else {
          console.log(`[tw-scrape] Nitter ${host} HTTP ${nRes.status}`);
        }
      } catch (e) {
        console.log(`[tw-scrape] Nitter ${host} failed: ${e.message}`);
      }
    }

    // Fallback: x.com profile page via Jina
    if (cdnUrls.length === 0) {
      try {
        console.log(`[tw-scrape] Falling back to x.com profile for @${handle}`);
        const xRes = await fetch(`https://r.jina.ai/https://x.com/${encodeURIComponent(handle)}`, {
          headers: jinaHeaders(),
          signal: AbortSignal.timeout(20000),
        });
        if (xRes.ok) {
          extractTwImgs(await xRes.text());
          console.log(`[tw-scrape] x.com profile found ${cdnUrls.length} URLs`);
        }
      } catch (e) {
        console.log(`[tw-scrape] x.com fallback failed: ${e.message}`);
      }
    }

    console.log(`[tw-scrape] Total: ${cdnUrls.length} image URLs for @${handle}`);
    if (cdnUrls.length > 0) console.log(`[tw-scrape] First URL: ${cdnUrls[0].slice(0, 120)}`);
    if (cdnUrls.length === 0) return [];

    const downloaded = [];
    for (let rawUrl of cdnUrls.slice(0, maxImages * 2)) {
      try {
        // Convert Nitter /pic/ proxy to direct pbs.twimg.com + upgrade to large
        if (/nitter.*\/pic\//i.test(rawUrl)) {
          const picPart = rawUrl.replace(/^https?:\/\/[^/]+\/pic\/(?:enc\/)?/, "");
          rawUrl = decodeURIComponent(picPart.startsWith("http") ? picPart : `https://pbs.twimg.com/media/${picPart}`);
        }
        if (/pbs\.twimg\.com\/media/.test(rawUrl)) {
          const base = rawUrl.replace(/[?&]name=\w+/, "");
          rawUrl = base.includes("?") ? base + "&name=large" : base + "?format=jpg&name=large";
        }
        const imgRes = await fetch(rawUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://x.com/",
            "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
          },
          signal: AbortSignal.timeout(8000),
          redirect: "follow",
        });
        if (!imgRes.ok) { console.log(`[tw-scrape] Download HTTP ${imgRes.status} for ${rawUrl.slice(0, 100)}`); continue; }
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const ct = imgRes.headers.get("content-type") || "image/jpeg";
        let pixels = buffer.length;
        try { const d = sizeOf(buffer); pixels = (d.width || 0) * (d.height || 0); } catch {}
        downloaded.push({ buffer, ct, pixels });
      } catch (e) {
        console.log(`[tw-scrape] Download failed: ${e.message}`);
      }
    }
    downloaded.sort((a, b) => b.pixels - a.pixels);

    const permanentUrls = [];
    for (let i = 0; i < Math.min(maxImages, downloaded.length); i++) {
      const { buffer, ct } = downloaded[i];
      const ext = ct.includes("webp") ? "webp" : ct.includes("png") ? "png" : "jpg";
      const storagePath = `${tenantId}/tw_${i}.${ext}`;
      const { error: uploadErr } = await supabase.storage
        .from("social-images")
        .upload(storagePath, buffer, { contentType: ct, upsert: true });
      if (uploadErr) { console.log(`[tw-scrape] Upload failed ${i}: ${uploadErr.message}`); continue; }
      const { data: { publicUrl } } = supabase.storage.from("social-images").getPublicUrl(storagePath);
      permanentUrls.push(publicUrl);
    }
    console.log(`[tw-scrape] Rehosted ${permanentUrls.length} Twitter photos for ${tenantId} (@${handle})`);
    return permanentUrls;
  } catch (err) {
    console.log(`[tw-scrape] Failed for @${handle}: ${err.message}`);
    return [];
  }
}

async function startBackgroundCrawl({ tenantId, name, website, email, portalPassword, oldDocIds = [] }) {
  try {
    let imported = 0;

    if (website) {
      console.log(`[crawl] Starting background crawl for ${tenantId}: ${website}`);
      setCrawlProgress(tenantId, 2, "Warming up the engines…");

      // Set business type immediately from name heuristic so the site renders
      // the correct template even if the user opens it before the crawl finishes
      try {
        const earlyType = nameToBusinessType(name);
        if (earlyType) {
          await supabase.from("tenants").update({ business_type: earlyType }).eq("id", tenantId);
          console.log(`[crawl] Business type (early): ${earlyType} for ${tenantId}`);
        }
      } catch {}

      // Extract logo + brand colour + description from homepage
      let logoUrl = null;
      try {
        // Don't overwrite a manually-set logo
        const { data: existingLogoData } = await supabase.from("tenants").select("logo_url, brand_color").eq("id", tenantId).maybeSingle();
        if (existingLogoData?.logo_url) {
          logoUrl = existingLogoData.logo_url;
          console.log(`[crawl] Logo already set for ${tenantId}, skipping auto-detection`);
        }

        // Run Vision colour extraction if logo is known but brand_color not yet set
        if (logoUrl && !existingLogoData?.brand_color) {
          const visionColor = await extractBrandColorFromLogo(logoUrl);
          if (visionColor) {
            await supabase.from("tenants").update({ brand_color: visionColor }).eq("id", tenantId);
            console.log(`[crawl] Brand colour stored for ${tenantId}: ${visionColor} (vision from existing logo)`);
          }
        }

        if (!logoUrl) try {
          setCrawlProgress(tenantId, 5, "Reading your homepage…");
          const homepageRes = await fetch(website, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
            signal: AbortSignal.timeout(8000)
          });
          if (homepageRes.ok) {
            const homepageHtml = await homepageRes.text();
            logoUrl = extractFaviconUrl(homepageHtml, website);
            if (logoUrl) console.log(`[crawl] Logo found in HTML for ${tenantId}: ${logoUrl}`);
            setCrawlProgress(tenantId, 10, "Picking up your logo and brand colours…");

            // Brand colour — Vision from logo first, then theme-color meta, then CSS
            try {
              const { data: existingColor } = await supabase.from("tenants").select("brand_color").eq("id", tenantId).maybeSingle();
              if (!existingColor?.brand_color) {
                const visionColor = await extractBrandColorFromLogo(logoUrl);
                const tcMatch = homepageHtml.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{3,8})["']/i)
                             || homepageHtml.match(/<meta[^>]+content=["'](#[0-9a-fA-F]{3,8})["'][^>]+name=["']theme-color["']/i);
                const brandColor = visionColor || (tcMatch ? tcMatch[1] : extractDominantCssColor(homepageHtml));
                if (brandColor) {
                  await supabase.from("tenants").update({ brand_color: brandColor }).eq("id", tenantId);
                  console.log(`[crawl] Brand colour stored for ${tenantId}: ${brandColor} (${visionColor ? "vision" : tcMatch ? "theme-color" : "css-dominant"})`);
                }
              } else {
                console.log(`[crawl] Brand colour already set for ${tenantId}, skipping`);
              }
            } catch {}

            // Extract social media links from homepage (footer usually has them)
            try {
              const socialUpdate = {};
              const igMatch = homepageHtml.match(/https?:\/\/(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]{2,30})\/?/);
              if (igMatch && !["p","reel","reels","explore","tv"].includes(igMatch[1].toLowerCase())) {
                socialUpdate.instagram_handle = igMatch[1].replace(/\/$/, "");
              }
              const fbMatch = homepageHtml.match(/https?:\/\/(?:www\.)?facebook\.com\/([a-zA-Z0-9_.%-]{2,60})\/?(?:["'\s])/);
              if (fbMatch && !["sharer","share","login","groups","events","pages"].includes(fbMatch[1].toLowerCase())) {
                socialUpdate.facebook_url = `https://facebook.com/${fbMatch[1]}`;
              }
              const twMatch = homepageHtml.match(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([a-zA-Z0-9_]{2,40})\/?(?:["'\s])/);
              if (twMatch && !["share","intent","home","search"].includes(twMatch[1].toLowerCase())) {
                socialUpdate.twitter_handle = twMatch[1];
              }
              if (Object.keys(socialUpdate).length > 0) {
                await supabase.from("tenants").update(socialUpdate).eq("id", tenantId);
                console.log(`[crawl] Social links found for ${tenantId}:`, socialUpdate);
              }
            } catch {}

            // AI business description
            try {
              const pageText = homepageHtml
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 1500);
              if (pageText.length > 100) {
                const descResp = await openai.chat.completions.create({
                  model: "gpt-4o-mini",
                  messages: [
                    { role: "system", content: "Write a concise one-sentence description of this organisation in 10-25 words. If the text mentions a founding year, lead with it (e.g. 'founded in 1923,'). Start with a lowercase letter, no company name, no full stop. Example: 'founded in 1923, a tennis club in Cork offering memberships, coaching sessions, and court bookings'" },
                    { role: "user", content: `Business name: ${name}\nWebsite text:\n${pageText}` }
                  ],
                  temperature: 0.3,
                  max_tokens: 60
                });
                const desc = (descResp.choices[0].message.content || "").trim().replace(/\.$/, "").replace(/^["']|["']$/g, "");
                if (desc) {
                  await supabase.from("tenants").update({ business_description: desc }).eq("id", tenantId);
                  console.log(`[crawl] Business description stored for ${tenantId}: ${desc}`);
                }
              }
            } catch {}
          }
        } catch (fetchErr) {
          console.log(`[crawl] Homepage fetch failed for ${tenantId} (${fetchErr.message}) — will try Clearbit`);
        }

        // Clearbit logo fallback
        if (!logoUrl) {
          try {
            const domain = new URL(website).hostname.replace(/^www\./, "");
            const clearbitUrl = `https://logo.clearbit.com/${domain}`;
            const clearbitRes = await fetch(clearbitUrl, { signal: AbortSignal.timeout(6000) });
            if (clearbitRes.ok && (clearbitRes.headers.get("content-type") || "").startsWith("image/")) {
              logoUrl = clearbitUrl;
              console.log(`[crawl] Logo found via Clearbit for ${tenantId}: ${logoUrl}`);
            }
          } catch {}
        }

        // Wikipedia logo fallback — works for GAA clubs, sports clubs, named organisations
        if (!logoUrl) {
          const wikiLogo = await fetchWikipediaLogo(name);
          if (wikiLogo) {
            logoUrl = wikiLogo;
            console.log(`[crawl] Logo found via Wikipedia for ${tenantId}: ${logoUrl}`);
          }
        }

        if (logoUrl && !existingLogoData?.logo_url) {
          await supabase.from("tenants").update({ logo_url: logoUrl }).eq("id", tenantId);
          clearFaviconCache(tenantId);
        }
      } catch (err) {
        console.error(`[crawl] Logo extraction error for ${tenantId}:`, err.message);
      }

      // ── Social image scrape (Instagram thumbnails for generated site) ────────
      try {
        const { data: tenantMeta } = await supabase
          .from("tenants")
          .select("instagram_handle")
          .eq("id", tenantId)
          .maybeSingle();
        const igHandle = tenantMeta?.instagram_handle;
        if (igHandle) {
          setCrawlProgress(tenantId, 13, `Fetching photos from Instagram (@${igHandle})…`);
          let thumbnails = await fetchInstagramThumbnails(igHandle, tenantId, 9);
          if (thumbnails.length >= 1) {
            if (["gaa_club","tennis_club","team_sports_club","swim_club","golf_club"].includes(earlyBizType)) {
              thumbnails = await rankImagesForHero(thumbnails);
            }
            await supabase.from("tenants").update({ social_images: JSON.stringify(thumbnails) }).eq("id", tenantId);
            console.log(`[crawl] Stored ${thumbnails.length} IG thumbnails for ${tenantId}`);
          }
        }
      } catch {}

      setCrawlProgress(tenantId, 14, "On the track — scanning your website…");
      const earlyBizType = nameToBusinessType(name);
      const pages = await crawlWebsite(website, 25, (count) => {
        const pct = 14 + Math.round((count / 25) * 52);
        setCrawlProgress(tenantId, Math.min(pct, 66), `${count} page${count === 1 ? "" : "s"} scanned so far…`);
      }, earlyBizType);
      console.log(`[crawl] Crawled ${pages.length} pages for ${tenantId}`);

      // ── Auto-detect Instagram handle from crawled pages + search ────────────────
      try {
        const { data: igCheck } = await supabase.from("tenants").select("instagram_handle").eq("id", tenantId).maybeSingle();
        if (igCheck?.instagram_handle) {
          // Handle already known — always refresh IG photos on re-crawl
          setCrawlProgress(tenantId, 67, "Refreshing Instagram photos…");
          let thumbnails = await fetchInstagramThumbnails(igCheck.instagram_handle, tenantId, 9);
          if (thumbnails.length >= 1) {
            const btype = nameToBusinessType(name);
            if (["gaa_club","tennis_club","team_sports_club","swim_club","golf_club"].includes(btype)) {
              thumbnails = await rankImagesForHero(thumbnails);
            }
            await supabase.from("tenants").update({ social_images: JSON.stringify(thumbnails) }).eq("id", tenantId);
            console.log(`[ig-scrape] Refreshed ${thumbnails.length} IG photos for ${tenantId} (@${igCheck.instagram_handle})`);
          }
        } else {
          setCrawlProgress(tenantId, 67, "Looking for your Instagram profile…");
          const detected = await detectInstagramHandle(name, pages);
          if (detected) {
            console.log(`[ig-detect] Found @${detected.handle} for ${tenantId} (confidence ${detected.confidence.toFixed(2)}, source: ${detected.source})`);
            await supabase.from("tenants").update({ instagram_handle: detected.handle }).eq("id", tenantId);
            let thumbnails = await fetchInstagramThumbnails(detected.handle, tenantId, 9);
            if (thumbnails.length >= 1) {
              const btype = nameToBusinessType(name);
              if (["gaa_club","tennis_club","team_sports_club","swim_club","golf_club"].includes(btype)) {
                thumbnails = await rankImagesForHero(thumbnails);
              }
              await supabase.from("tenants").update({ social_images: JSON.stringify(thumbnails) }).eq("id", tenantId);
              console.log(`[ig-detect] Stored ${thumbnails.length} IG photos for ${tenantId} (@${detected.handle})`);
            }
          } else {
            console.log(`[ig-detect] No Instagram handle found for ${tenantId}`);
          }
        }
      } catch (e) {
        console.log(`[ig-detect] Error: ${e.message}`);
      }

      // ── Twitter photo scrape — always runs if handle exists, stored alongside IG ─
      try {
        const { data: twCheck } = await supabase.from("tenants").select("twitter_handle, social_images").eq("id", tenantId).maybeSingle();
        if (twCheck?.twitter_handle) {
          setCrawlProgress(tenantId, 68, `Fetching photos from Twitter (@${twCheck.twitter_handle})…`);
          const twPhotos = await fetchTwitterPhotos(twCheck.twitter_handle, tenantId, 6);
          if (twPhotos.length > 0) {
            const current = (() => { try { return JSON.parse(twCheck.social_images) || []; } catch { return []; } })();
            const nonTw = current.filter(u => !/\/tw_\d+\./.test(u));
            const combined = [...nonTw, ...twPhotos].slice(0, 15);
            await supabase.from("tenants").update({ social_images: JSON.stringify(combined) }).eq("id", tenantId);
            console.log(`[crawl] Added ${twPhotos.length} Twitter photos for ${tenantId} (@${twCheck.twitter_handle})`);
          }
        }
      } catch (e) {
        console.log(`[tw-scrape] Crawl error: ${e.message}`);
      }

      // ── Extract photos from crawled HTML — always runs to supplement IG images ─
      try {
        const { data: existing } = await supabase.from("tenants").select("social_images").eq("id", tenantId).maybeSingle();
        let currentImages = [];
        try { currentImages = JSON.parse(existing?.social_images) || []; } catch {}
        const needed = 15 - currentImages.length;
        if (needed > 0 && pages.length > 0) {
          setCrawlProgress(tenantId, 67, "Gathering photos from your website…");
          const siteImages = await extractAndRehostWebsiteImages(pages, tenantId, needed);
          if (siteImages.length > 0) {
            let combined = [...currentImages, ...siteImages].slice(0, 15);
            // For sports clubs rank all images so the best team photo ends up first
            const btype = nameToBusinessType(name);
            if (["gaa_club","tennis_club","team_sports_club","swim_club","golf_club"].includes(btype)) {
              combined = await rankImagesForHero(combined);
            }
            await supabase.from("tenants").update({ social_images: JSON.stringify(combined) }).eq("id", tenantId);
            console.log(`[crawl] Stored ${combined.length} total images for ${tenantId} (${currentImages.length} social + ${siteImages.length} website)`);
          }
        }
      } catch (e) {
        console.error(`[crawl] extractAndRehostWebsiteImages failed for ${tenantId}: ${e.message}`);
      }

      // ── Logo image fallback — if still no images, rehost the logo as a gallery photo ──
      try {
        const { data: imgCheck } = await supabase.from("tenants").select("social_images, logo_url").eq("id", tenantId).maybeSingle();
        let currentImages = [];
        try { currentImages = JSON.parse(imgCheck?.social_images) || []; } catch {}
        const fallbackLogo = imgCheck?.logo_url || logoUrl;
        if (currentImages.length < 3 && fallbackLogo) {
          const r = await fetch(fallbackLogo, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) });
          if (r.ok) {
            const ct = r.headers.get("content-type") || "";
            if (ct.startsWith("image/")) {
              const buf = Buffer.from(await r.arrayBuffer());
              if (buf.length >= 5000) {
                const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
                const storagePath = `${tenantId}/logo_fallback.${ext}`;
                const { error } = await supabase.storage.from("social-images").upload(storagePath, buf, { contentType: ct, upsert: true });
                if (!error) {
                  const { data: { publicUrl } } = supabase.storage.from("social-images").getPublicUrl(storagePath);
                  const combined = [...currentImages, publicUrl].slice(0, 9);
                  await supabase.from("tenants").update({ social_images: JSON.stringify(combined) }).eq("id", tenantId);
                  console.log(`[crawl] Added logo as image fallback for ${tenantId} (now ${combined.length} total)`);
                }
              }
            }
          }
        }
      } catch (e) { console.log(`[crawl] Logo fallback failed for ${tenantId}: ${e.message}`); }

      // ── Extract logo from crawled HTML (avoids second fetch for sites that block it) ──
      if (!logoUrl) {
        const homepagePage = pages.find(p => {
          try { return new URL(p.url).pathname.replace(/\/$/, "") === ""; } catch { return false; }
        }) || pages[0];
        if (homepagePage?.html) {
          logoUrl = extractFaviconUrl(homepagePage.html, homepagePage.url);
          if (logoUrl) console.log(`[crawl] Logo found from crawled HTML for ${tenantId}: ${logoUrl}`);
        }
        if (logoUrl) {
          await supabase.from("tenants").update({ logo_url: logoUrl }).eq("id", tenantId);
          clearFaviconCache(tenantId);
        }
      }

      setCrawlProgress(tenantId, 68, `Crawled ${pages.length} pages — saving your knowledge base…`);

      for (const page of pages) {
        // ── Storage quota guard ──────────────────────────────────────────────
        if (imported >= CRAWL_QUOTA_DOCS) {
          console.log(`[crawl] Quota reached (${CRAWL_QUOTA_DOCS} docs) for ${tenantId} — stopping crawl`);
          break;
        }

        try {
          const { data: existingDoc } = await supabase
            .from("documents")
            .select("id")
            .eq("storage_path", page.url)
            .eq("tenant_id", tenantId)
            .maybeSingle();
          if (existingDoc) {
            console.log(`[crawl] Skipping duplicate page: ${page.url}`);
            continue;
          }

          const { data: doc, error: insertError } = await supabase
            .from("documents")
            .insert({
              original_filename: page.title,
              stored_filename:   page.url,
              mimetype:          "text/html",
              lender:            null,
              document_type:     "Website Content",
              effective_date:    null,
              tags:              ["website"],
              metadata_complete: true,
              junior_accessible: true,
              storage_path:      page.url,
              tenant_id:         tenantId
            })
            .select()
            .single();

          if (insertError) {
            console.error(`[crawl] Doc insert error for ${tenantId}:`, insertError.message);
            continue;
          }

          await generateAndStoreChunks(doc.id, page.text, null, "Website Content", null, tenantId, { title: page.title || page.url });
          imported++;
        } catch (err) {
          console.error(`[crawl] Page import error for ${tenantId}:`, err.message);
        }
      }

      console.log(`[crawl] Imported ${imported} pages for ${tenantId}`);

      // Atomic swap — now that new docs are saved, delete the old ones.
      // Only runs if we actually imported something (protects against empty crawl wiping the KB).
      if (oldDocIds.length && imported > 0) {
        await supabase.from("knowledge_chunks").delete().in("document_id", oldDocIds);
        await supabase.from("documents").delete().in("id", oldDocIds);
        console.log(`[crawl] Swapped out ${oldDocIds.length} old website docs for ${tenantId}`);
      }

      setCrawlProgress(tenantId, 80, "Analysing your content — picking out the key details…");

      // ── Detect business type + auto-seed template flows ──────────────────
      try {
        const { data: td } = await supabase.from("tenants").select("business_description, business_type").eq("id", tenantId).single();
        const existingBizType = td?.business_type;
        let bizType = existingBizType;
        // Only re-detect if not already set — avoids overwriting a confirmed type on recrawl
        if (!existingBizType || existingBizType === "other") {
          const allText = pages.map(p => p.text).join(" ").slice(0, 2000);
          const bizDesc = td?.business_description || "";
          bizType = await detectBusinessType(name, bizDesc, allText);
          await supabase.from("tenants").update({ business_type: bizType }).eq("id", tenantId);
          console.log(`[crawl] Business type detected: ${bizType} for ${tenantId}`);
        } else {
          console.log(`[crawl] Business type: ${existingBizType} for ${tenantId} (retained — not re-detected)`);
        }

        if (bizType !== "other") {
          setCrawlProgress(tenantId, 90, "Building your personalised chat flows…");
          await seedFlowsForType(tenantId, name, website, bizType, pages);
        }

        // Auto-populate empty agent config fields from KB for all business types
        setCrawlProgress(tenantId, 92, "Filling in your assistant details…");
        await backfillEmptyAgentFields(tenantId);
      } catch (seedErr) {
        console.error(`[crawl] Flow seed error for ${tenantId}:`, seedErr.message);
      }

      await supabase.from("tenants").update({ last_crawl_at: new Date().toISOString(), last_crawl_pages: imported }).eq("id", tenantId);
      setCrawlProgress(tenantId, 100, "🏁 Your assistant is ready!", true);
    }

    // Send welcome email — only on first signup crawl (email is passed)
    if (email && process.env.RESEND_API_KEY) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "Sprimal <hello@sprimal.com>",
          to: email,
          bcc: ["hello@sprimal.com"],
          subject: `Your Sprimal assistant is ready 🎉`,
          html: buildWelcomeEmailHtml({ name, email, website, imported, tenantId })
        })
      }).catch(err => console.error("[crawl] Welcome email error:", err.message));

      console.log(`[crawl] Welcome email sent to ${email}`);
    }
  } catch (err) {
    console.error(`[crawl] Background task error for ${tenantId}:`, err.message);
  }
}

// ── POST /api/signup ───────────────────────────────────────────────────────────
app.post("/api/signup", signupLimiter, async (req, res) => {
  const { name, email } = req.body;
  let website = (req.body.website || "").trim() || null;
  if (website && !/^https?:\/\//i.test(website)) website = "https://" + website;

  if (!name || !email) {
    return res.status(400).json({ error: "Business name and email are required" });
  }

  // ── Layer 1: Domain blocklist ──────────────────────────────────────────────
  if (website) {
    try {
      const domain = new URL(website).hostname.replace(/^www\./, "").toLowerCase();
      if (BLOCKED_DOMAINS.has(domain)) {
        return res.status(400).json({ error: "That website can't be used with Sprimal. Please sign up with your own business website." });
      }
    } catch {
      return res.status(400).json({ error: "Please enter a valid website URL." });
    }
  }

  // Generate URL-safe tenant slug from business name
  const tenantId = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);

  if (!tenantId) {
    return res.status(400).json({ error: "Could not generate a valid ID from the business name." });
  }

  // ── Check for duplicate ────────────────────────────────────────────────────
  const { data: existing } = await supabase
    .from("tenants")
    .select("id, email_verified, email_verification_token, email")
    .eq("id", tenantId)
    .maybeSingle();

  if (existing) {
    // If unverified, resend the verification email and let them know
    if (existing.email_verified === false && existing.email_verification_token) {
      const verifyUrl = `https://app.sprimal.com/verify-email/${existing.email_verification_token}`;
      if (process.env.RESEND_API_KEY) {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Sprimal <hello@sprimal.com>",
            to: existing.email,
            subject: "Confirm your email to activate Sprimal",
            html: buildVerificationEmailHtml({ name: existing.email, email: existing.email, verifyUrl })
          })
        }).catch(() => {});
      }
      return res.json({ requiresVerification: true, email: existing.email });
    }
    return res.status(409).json({ error: "A business with a similar name already exists. Please contact us if this is a mistake." });
  }

  // ── Layer 2: Generate verification token + create unverified tenant ────────
  const verificationToken = crypto.randomBytes(32).toString("hex");

  const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { error: tenantError } = await supabase
    .from("tenants")
    .insert({
      id: tenantId,
      name,
      email,
      website: website || null,
      plan: "trial",
      business_mode: "general",
      email_verified: false,
      email_verification_token: verificationToken,
      email_verification_expires_at: verificationExpiresAt
    });

  if (tenantError) {
    console.error("[signup] Tenant insert error:", tenantError);
    return res.status(500).json({ error: "Failed to create account. Please try again." });
  }

  console.log(`[signup] Created unverified tenant: ${tenantId} (${name}) — awaiting email verification`);

  // Send verification email
  const verifyUrl = `https://app.sprimal.com/verify-email/${verificationToken}`;
  if (process.env.RESEND_API_KEY) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Sprimal <hello@sprimal.com>",
        to: email,
        subject: "Confirm your email to activate Sprimal ✅",
        html: buildVerificationEmailHtml({ name, email, verifyUrl })
      })
    }).catch(err => console.error("[signup] Verification email error:", err.message));
  } else {
    // Dev mode: log the link so you can test without Resend
    console.log(`[signup] [DEV] Verify link for ${tenantId}: ${verifyUrl}`);
  }

  res.json({ requiresVerification: true, email });
});

// ── GET /verify-email/:token ───────────────────────────────────────────────────
app.get("/verify-email/:token", async (req, res) => {
  const { token } = req.params;

  const { data: tenant } = await supabase
    .from("tenants")
    .select("*")
    .eq("email_verification_token", token)
    .maybeSingle();

  const errorPage = (message) => `
    <!DOCTYPE html><html><head><title>Sprimal</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;}
    .box{text-align:center;max-width:400px;padding:40px;}</style></head>
    <body><div class="box">
      <h2 style="color:#0f172a;">Link expired or already used</h2>
      <p style="color:#64748b;margin-top:12px;">${message}</p>
    </div></body></html>
  `;

  if (!tenant) {
    return res.status(400).send(errorPage(
      `This verification link is no longer valid. Please <a href="/signup" style="color:#2563eb;">sign up again</a> or contact us at <a href="mailto:hello@sprimal.com">hello@sprimal.com</a>.`
    ));
  }

  // Check token hasn't expired
  if (tenant.email_verification_expires_at && new Date(tenant.email_verification_expires_at) < new Date()) {
    // Clean up the expired unverified tenant
    await supabase.from("tenants").delete().eq("id", tenant.id);
    return res.status(400).send(errorPage(
      `This verification link expired after 24 hours. Please <a href="/signup" style="color:#2563eb;">sign up again</a> — it only takes a moment.`
    ));
  }

  // Serve the "create your password" page — crawl and login happen after they submit
  res.send(buildSetPasswordPage(token, tenant.name, tenant.email));
});

// ── POST /verify-email/:token — set password, login, start crawl ──────────────
app.post("/verify-email/:token", async (req, res) => {
  const { token } = req.params;
  const { password, confirmPassword } = req.body;

  const { data: tenant } = await supabase
    .from("tenants")
    .select("*")
    .eq("email_verification_token", token)
    .maybeSingle();

  if (!tenant) return res.status(400).send("Link expired or already used. Please sign up again.");

  if (tenant.email_verification_expires_at && new Date(tenant.email_verification_expires_at) < new Date()) {
    await supabase.from("tenants").delete().eq("id", tenant.id);
    return res.status(400).send("This link expired after 24 hours. Please sign up again.");
  }

  // Server-side password validation
  const COMMON_PASSWORDS = ["password","password1","password12","password123","123456789","12345678","qwerty123","iloveyou","admin1234","letmein1","welcome1","monkey123","dragon123","sunshine1","princess1","football1","abc123456","passw0rd1","master123","shadow123"];
  const pwError = (msg) => res.send(buildSetPasswordPage(token, tenant.name, tenant.email, msg));

  if (!password || password.length < 12) return pwError("Password must be at least 12 characters.");
  if (password !== confirmPassword) return pwError("Passwords don't match.");
  if (COMMON_PASSWORDS.includes(password.toLowerCase())) return pwError("That password is too common — please choose something more unique.");

  // Mark verified, store password
  await supabase.from("tenants").update({
    email_verified: true,
    email_verification_token: null,
    portal_password: password
  }).eq("id", tenant.id);

  // Auto-login cookie
  const signupToken = createTenantToken({
    tenantId: tenant.id,
    tenantName: tenant.name,
    email: tenant.email,
    website: tenant.website
  });
  setSessionCookie(res, signupToken);

  console.log(`[verify] Password set for ${tenant.id} — starting background crawl`);

  startBackgroundCrawl({
    tenantId: tenant.id,
    name: tenant.name,
    website: tenant.website,
    email: tenant.email
  });

  res.redirect("/portal/dashboard?new=1");
});

function buildSetPasswordPage(token, name, email, errorMsg = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sprimal — Create your password</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; display: flex; }
    .brand-panel { flex: 1; background: #0f172a; display: flex; flex-direction: column; justify-content: center; padding: 64px 56px; color: white; }
    .brand-logo { font-size: 28px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 32px; }
    .brand-logo span { color: #4f76f6; }
    .brand-tagline { font-size: 22px; font-weight: 700; line-height: 1.35; margin-bottom: 16px; }
    .brand-sub { font-size: 15px; color: #94a3b8; line-height: 1.6; }
    .form-panel { width: 480px; display: flex; flex-direction: column; justify-content: center; padding: 64px 56px; background: white; }
    @media (max-width: 768px) { .brand-panel { display: none; } .form-panel { width: 100%; padding: 40px 28px; } }
    .form-title { font-size: 22px; font-weight: 700; color: #0f172a; margin-bottom: 6px; }
    .form-sub { font-size: 14px; color: #64748b; margin-bottom: 28px; line-height: 1.5; }
    label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 6px; }
    input[type=password] { width: 100%; padding: 11px 14px; border: 1.5px solid #e2e8f0; border-radius: 8px; font-size: 15px; font-family: inherit; outline: none; transition: border-color 0.15s; margin-bottom: 18px; }
    input[type=password]:focus { border-color: #4f76f6; }
    .strength-bar-wrap { height: 4px; background: #f1f5f9; border-radius: 2px; margin-top: -14px; margin-bottom: 18px; }
    .strength-bar { height: 4px; border-radius: 2px; width: 0; transition: width 0.2s, background 0.2s; }
    .strength-label { font-size: 12px; margin-top: 4px; margin-bottom: 14px; min-height: 16px; }
    .btn { width: 100%; padding: 13px; background: #2563eb; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; font-family: inherit; transition: background 0.15s; }
    .btn:hover { background: #1d4ed8; }
    .error { background: #fef2f2; border: 1px solid #fca5a5; color: #dc2626; padding: 12px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 20px; }
    .rule { font-size: 12px; color: #94a3b8; margin-top: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="brand-panel">
    <div class="brand-logo">Sprim<span>al</span></div>
    <div class="brand-tagline">Almost there, ${name}.</div>
    <div class="brand-sub">Create a password to secure your portal. You'll use it every time you log in to manage your AI assistant.</div>
  </div>
  <div class="form-panel">
    <div class="form-title">Create your password</div>
    <div class="form-sub">Setting up your Sprimal account for <strong>${email}</strong></div>
    ${errorMsg ? `<div class="error">${errorMsg}</div>` : ""}
    <form method="POST" action="/verify-email/${token}" id="pwForm">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="At least 12 characters" autocomplete="new-password" required />
      <div class="strength-bar-wrap"><div class="strength-bar" id="strengthBar"></div></div>
      <div class="strength-label" id="strengthLabel"></div>
      <label for="confirmPassword">Confirm password</label>
      <input type="password" id="confirmPassword" name="confirmPassword" placeholder="Repeat your password" autocomplete="new-password" required />
      <button type="submit" class="btn">Create password &amp; open portal &rarr;</button>
      <div class="rule">Minimum 12 characters. No complexity rules — just make it something you'll remember and wouldn't share.</div>
    </form>
  </div>
  <script>
    var COMMON = ["password","password1","password12","password123","123456789","12345678","qwerty123","iloveyou","admin1234","letmein1","welcome1","monkey123"];
    var bar = document.getElementById("strengthBar");
    var label = document.getElementById("strengthLabel");
    document.getElementById("password").addEventListener("input", function() {
      var v = this.value;
      var score = 0;
      if (v.length >= 12) score++;
      if (v.length >= 16) score++;
      if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
      if (/[0-9]/.test(v)) score++;
      if (/[^A-Za-z0-9]/.test(v)) score++;
      if (COMMON.includes(v.toLowerCase())) score = 0;
      var colors = ["#ef4444","#f59e0b","#f59e0b","#22c55e","#16a34a","#15803d"];
      var labels = ["","Too weak","Weak","Good","Strong","Very strong"];
      var labelColors = ["","#ef4444","#f59e0b","#16a34a","#15803d","#15803d"];
      bar.style.width = (v.length ? Math.min(score * 20 + 5, 100) : 0) + "%";
      bar.style.background = colors[score] || colors[0];
      label.textContent = v.length ? (labels[score] || "") : "";
      label.style.color = labelColors[score] || "";
    });
    document.getElementById("pwForm").addEventListener("submit", function(e) {
      var p = document.getElementById("password").value;
      var c = document.getElementById("confirmPassword").value;
      if (p.length < 12) { e.preventDefault(); alert("Password must be at least 12 characters."); return; }
      if (p !== c) { e.preventDefault(); alert("Passwords don't match."); return; }
    });
  </script>
</body>
</html>`;
}

// ── Verification email builder ────────────────────────────────────────────────

function buildVerificationEmailHtml({ name, email, verifyUrl }) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f1f5f9;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;width:100%;">

      <!-- HEADER -->
      <tr><td align="center" bgcolor="#0f1f3d" style="background-color:#0f1f3d;border-radius:10px 10px 0 0;padding:22px 32px;">
        <span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;color:#ffffff;letter-spacing:-0.5px;">Sprimal</span>
      </td></tr>

      <!-- BODY -->
      <tr><td bgcolor="#ffffff" style="background-color:#ffffff;padding:40px;border-radius:0 0 10px 10px;text-align:center;">

        <h1 style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;color:#0f1f3d;margin:0 0 12px 0;">Confirm your email address</h1>
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#374151;margin:0 0 28px 0;line-height:1.65;">
          Hi ${name}! Click the button below to verify your email and start training your AI assistant.
        </p>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 28px;">
          <tr><td align="center" bgcolor="#2563eb" style="background-color:#2563eb;border-radius:8px;padding:0;">
            <a href="${verifyUrl}" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;display:inline-block;padding:14px 32px;">
              ✅ Confirm email &amp; activate
            </a>
          </td></tr>
        </table>

        <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#94a3b8;margin:0 0 8px 0;line-height:1.6;">
          This link will expire in 24 hours. If you didn't sign up for Sprimal, you can safely ignore this email.
        </p>
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#cbd5e1;margin:0;">
          Or copy this URL into your browser:<br>
          <span style="color:#64748b;word-break:break-all;">${verifyUrl}</span>
        </p>

      </td></tr>

      <!-- FOOTER -->
      <tr><td align="center" style="padding:20px 0;">
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#94a3b8;margin:0;">
          Sprimal · <a href="https://app.sprimal.com" style="color:#94a3b8;">app.sprimal.com</a>
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Welcome email builder ─────────────────────────────────────────────────────

function buildWelcomeEmailHtml({ name, email, portalPassword, website, imported, tenantId }) {
  const embedCode = `<script src="https://app.sprimal.com/widget.js" data-club-id="${tenantId}" data-club-name="${name}"></script>`;
  const embedCodeEscaped = embedCode.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const trainingNote = imported > 0
    ? `We&#39;ve already trained your assistant on <strong>${imported} pages</strong> from your website — it&#39;s ready to answer questions right now.`
    : `Your assistant is set up and ready. Start by uploading documents or importing your website from the portal.`;

  const trialEndDate = new Date();
  trialEndDate.setDate(trialEndDate.getDate() + 30);
  const trialEnd = trialEndDate.toLocaleDateString("en-IE", { day: "numeric", month: "long", year: "numeric" });

  const feature = (emoji, title, desc) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:14px;">
      <tr>
        <td width="36" valign="top" style="font-size:20px;padding-top:1px;">${emoji}</td>
        <td style="padding-left:8px;">
          <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#0f1f3d;margin:0 0 2px 0;">${title}</p>
          <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6b7280;margin:0;line-height:1.5;">${desc}</p>
        </td>
      </tr>
    </table>`;

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f1f5f9;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;width:100%;">

      <!-- HEADER -->
      <tr><td align="center" bgcolor="#0f1f3d" style="background-color:#0f1f3d;border-radius:10px 10px 0 0;padding:22px 32px;">
        <span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;color:#ffffff;letter-spacing:-0.5px;">Sprimal</span>
      </td></tr>

      <!-- BODY -->
      <tr><td bgcolor="#ffffff" style="background-color:#ffffff;padding:36px 40px;border-radius:0 0 10px 10px;">

        <!-- Headline -->
        <h1 style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;color:#0f1f3d;margin:0 0 10px 0;line-height:1.3;">Welcome to Sprimal, ${name}! 🎉</h1>
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#374151;margin:0 0 20px 0;line-height:1.65;">${trainingNote}</p>

        <!-- Free trial banner -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:28px;">
          <tr><td bgcolor="#eff6ff" style="background-color:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 18px;">
            <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1e40af;margin:0;line-height:1.5;">
              &#127381; <strong>You&#39;re on a free 30-day trial</strong> — no credit card required, no obligation. Your trial runs until <strong>${trialEnd}</strong>. We&#39;ll be in touch before then with pricing options.
            </p>
          </td></tr>
        </table>

        <!-- Divider -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:20px;"><tr><td style="border-top:1px solid #e2e8f0;font-size:0;line-height:0;">&nbsp;</td></tr></table>

        <!-- What's available -->
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 16px 0;">What&#39;s available in your portal</p>

        ${feature("💬", "Chat Widget", "An AI assistant your visitors can chat with 24/7. Embed it on your website with one line of code, or share it via QR code — no app needed.")}
        ${feature("📚", "Knowledge Base", "Upload documents (PDFs, Word files), paste FAQs or policies, or import your entire website. The more you add, the smarter your assistant becomes.")}
        ${feature("🔍", "Knowledge Base Assistant", "Ask your own knowledge base a question and see exactly which document the answer came from. Great for checking accuracy before going live.")}
        ${feature("📊", "Analytics & Chat Logs", "See how many conversations your assistant is having, what topics come up most, and read full transcripts of every visitor exchange.")}
        ${feature("👥", "Staff Training", "Give your team access to a private staff portal where they can ask the knowledge base questions, draft email replies, and search documents.")}

        <!-- Divider -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;"><tr><td style="border-top:1px solid #e2e8f0;font-size:0;line-height:0;">&nbsp;</td></tr></table>

        <!-- Quick start -->
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 16px 0;">Where to start</p>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:12px;">
          <tr>
            <td width="28" valign="top"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#2563eb" style="background-color:#2563eb;border-radius:50%;width:24px;height:24px;"><span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#fff;display:block;width:24px;height:24px;line-height:24px;text-align:center;">1</span></td></tr></table></td>
            <td style="padding-left:12px;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#374151;margin:0;line-height:1.5;"><strong>Log in</strong> at <a href="https://app.sprimal.com/portal" style="color:#1e40af;">app.sprimal.com/portal</a> with your email and the password you just created.</p></td>
          </tr>
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:12px;">
          <tr>
            <td width="28" valign="top"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#2563eb" style="background-color:#2563eb;border-radius:50%;width:24px;height:24px;"><span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#fff;display:block;width:24px;height:24px;line-height:24px;text-align:center;">2</span></td></tr></table></td>
            <td style="padding-left:12px;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#374151;margin:0;line-height:1.5;"><strong>Upload a document</strong> or paste some content into the Knowledge Base — then ask the Knowledge Base Assistant a question to see it in action.</p></td>
          </tr>
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:24px;">
          <tr>
            <td width="28" valign="top"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#2563eb" style="background-color:#2563eb;border-radius:50%;width:24px;height:24px;"><span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#fff;display:block;width:24px;height:24px;line-height:24px;text-align:center;">3</span></td></tr></table></td>
            <td style="padding-left:12px;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#374151;margin:0;line-height:1.5;"><strong>Share your chat link</strong> — paste the embed code on your website or share your QR code and let visitors start chatting.</p></td>
          </tr>
        </table>

        <!-- CTA -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:28px;">
          <tr><td align="center">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td align="center" bgcolor="#2563eb" style="background-color:#2563eb;border-radius:8px;">
                <a href="https://app.sprimal.com/portal" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;display:inline-block;padding:14px 36px;">Log in to your portal &rarr;</a>
              </td>
            </tr></table>
          </td></tr>
        </table>

        <!-- Divider -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:20px;"><tr><td style="border-top:1px solid #e2e8f0;font-size:0;line-height:0;">&nbsp;</td></tr></table>

        <!-- Login credentials -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:24px;">
          <tr><td bgcolor="#f8fafc" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:18px 20px;">
            <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#0f1f3d;margin:0 0 12px 0;">&#128274; Your login details</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr><td style="padding-bottom:7px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#374151;"><strong>URL:</strong>&nbsp;&nbsp;<a href="https://app.sprimal.com/portal" style="color:#1e40af;text-decoration:none;">https://app.sprimal.com/portal</a></td></tr>
              <tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#374151;"><strong>Email:</strong>&nbsp;&nbsp;${email}</td></tr>
              <tr><td style="padding-top:7px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#374151;"><strong>Password:</strong>&nbsp;&nbsp;The password you created when you verified your email.</td></tr>
            </table>
          </td></tr>
        </table>

        <!-- Embed code -->
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#0f1f3d;margin:0 0 8px 0;">Your embed code</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:28px;">
          <tr><td bgcolor="#f3f4f6" style="background-color:#f3f4f6;border-radius:8px;padding:14px 16px;">
            <p style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#1e293b;margin:0;line-height:1.6;word-break:break-all;">${embedCodeEscaped}</p>
          </td></tr>
        </table>

        <!-- Sign-off -->
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6b7280;margin:0 0 4px 0;line-height:1.5;">Questions? Just reply to this email &mdash; we&#39;re happy to help.</p>
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6b7280;margin:0;">&#8212; The Sprimal team</p>

      </td></tr>

      <!-- FOOTER -->
      <tr><td align="center" style="padding:20px 0;">
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#94a3b8;margin:0;">&#169; 2025 Sprimal &middot; Monkstown, Ireland</p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Tenant portal ─────────────────────────────────────────────────────────────

// ── Signed-cookie sessions (survive server restarts) ─────────────────────────
// Token format: base64url(JSON) + "." + HMAC-SHA256 signature
const SESSION_SECRET = process.env.SESSION_SECRET || "sprimal-tenant-session-secret-v1";

const SESSION_INACTIVITY_MS = 8 * 60 * 60 * 1000; // 8 hours inactivity

function createTenantToken(data) {
  const payload = Buffer.from(JSON.stringify({ ...data, lastActive: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}

function setSessionCookie(res, token) {
  res.cookie("tenant_session", token, {
    httpOnly: true,
    secure:   true,
    sameSite: "lax"
    // No maxAge — session cookie, cleared when browser closes
  });
}

function verifyTenantToken(token) {
  try {
    const dot = token.lastIndexOf(".");
    if (dot < 1) return null;
    const payload = token.slice(0, dot);
    const sig     = token.slice(dot + 1);
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
}

function getTenantSession(req) {
  const token = req.cookies.tenant_session;
  if (!token) return null;
  return verifyTenantToken(token);
}

function checkAndRefreshSession(req, res) {
  const session = getTenantSession(req);
  if (!session) return null;
  // Sessions without lastActive (pre-deploy) are treated as expired — user logs in again and gets a proper token
  const lastActive = session.lastActive ?? 0;
  if (Date.now() - lastActive > SESSION_INACTIVITY_MS) {
    res.clearCookie("tenant_session", { httpOnly: true, secure: true, sameSite: "lax" });
    return null;
  }
  // Refresh the cookie with updated lastActive on every request
  const { lastActive: _old, ...rest } = session;
  setSessionCookie(res, createTenantToken(rest));
  return session;
}

function requireTenant(req, res, next) {
  const session = checkAndRefreshSession(req, res);
  if (!session) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
    return res.redirect("/portal");
  }
  req.tenant = session;
  next();
}

// requireSeniorTenant — portal routes only accessible to account owners (role=senior)
// Existing sessions without a role field are treated as senior (pre-dated the role field)
function requireSeniorTenant(req, res, next) {
  const session = checkAndRefreshSession(req, res);
  if (!session) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
    return res.redirect("/portal");
  }
  if (session.role === "junior") {
    if (req.path.startsWith("/api/")) return res.status(403).json({ error: "Forbidden" });
    return res.redirect("/portal/dashboard");
  }
  req.tenant = session;
  next();
}

// ── Password reset helpers ────────────────────────────────────────────────────
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

function createResetToken(tenantId, email) {
  const payload = Buffer.from(JSON.stringify({ tenantId, email, exp: Date.now() + RESET_TOKEN_EXPIRY_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}

function verifyResetToken(token) {
  try {
    const dot = token.lastIndexOf(".");
    if (dot < 1) return null;
    const payload = token.slice(0, dot);
    const sig     = token.slice(dot + 1);
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    if (sig !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.tenantId || !data.email || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
}

function resetPageHtml(token, errorMsg = "", successMsg = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sprimal — Reset password</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; display: flex; }
    .brand-panel { flex: 1; background: #0f172a; display: flex; flex-direction: column; justify-content: center; padding: 64px 56px; color: white; }
    .brand-logo { font-size: 28px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 32px; }
    .brand-logo span { color: #4f76f6; }
    .brand-tagline { font-size: 22px; font-weight: 700; line-height: 1.35; margin-bottom: 16px; }
    .brand-sub { font-size: 15px; color: #94a3b8; line-height: 1.6; }
    .form-panel { width: 480px; display: flex; flex-direction: column; justify-content: center; padding: 64px 56px; background: white; }
    @media (max-width: 768px) { .brand-panel { display: none; } .form-panel { width: 100%; padding: 40px 28px; } }
    .form-title { font-size: 22px; font-weight: 700; color: #0f172a; margin-bottom: 6px; }
    .form-sub { font-size: 14px; color: #64748b; margin-bottom: 28px; line-height: 1.5; }
    label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 6px; }
    input[type=password] { width: 100%; padding: 11px 14px; border: 1.5px solid #e2e8f0; border-radius: 8px; font-size: 15px; font-family: inherit; outline: none; transition: border-color 0.15s; margin-bottom: 18px; }
    input[type=password]:focus { border-color: #4f76f6; }
    .strength-bar-wrap { height: 4px; background: #f1f5f9; border-radius: 2px; margin-top: -14px; margin-bottom: 18px; }
    .strength-bar { height: 4px; border-radius: 2px; width: 0; transition: width 0.2s, background 0.2s; }
    .strength-label { font-size: 12px; margin-top: 4px; margin-bottom: 14px; min-height: 16px; }
    .btn { width: 100%; padding: 13px; background: #2563eb; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; font-family: inherit; transition: background 0.15s; }
    .btn:hover { background: #1d4ed8; }
    .error { background: #fef2f2; border: 1px solid #fca5a5; color: #dc2626; padding: 12px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 20px; }
    .success { background: #f0fdf4; border: 1px solid #86efac; color: #15803d; padding: 12px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 20px; }
    .back { display: inline-block; margin-top: 16px; font-size: 13px; color: #64748b; text-decoration: none; border-bottom: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="brand-panel">
    <div class="brand-logo">Sprim<span>al</span></div>
    <div class="brand-tagline">Reset your password</div>
    <div class="brand-sub">Enter your new password below. You'll be logged in automatically once it's set.</div>
  </div>
  <div class="form-panel">
    <div class="form-title">Choose a new password</div>
    <div class="form-sub">Must be at least 12 characters.</div>
    ${errorMsg ? `<div class="error">${errorMsg}</div>` : ""}
    ${successMsg ? `<div class="success">${successMsg}</div>` : ""}
    <form method="POST" action="/portal/reset-password/${token}" id="pwForm">
      <label for="password">New password</label>
      <input type="password" id="password" name="password" placeholder="At least 12 characters" autocomplete="new-password" required />
      <div class="strength-bar-wrap"><div class="strength-bar" id="strengthBar"></div></div>
      <div class="strength-label" id="strengthLabel"></div>
      <label for="confirmPassword">Confirm new password</label>
      <input type="password" id="confirmPassword" name="confirmPassword" placeholder="Repeat your password" autocomplete="new-password" required />
      <button type="submit" class="btn">Set new password &rarr;</button>
    </form>
    <a href="/portal" class="back">← Back to login</a>
  </div>
  <script>
    var COMMON = ["password","password1","password12","password123","123456789","12345678","qwerty123","iloveyou","admin1234","letmein1"];
    var bar = document.getElementById("strengthBar");
    var label = document.getElementById("strengthLabel");
    document.getElementById("password").addEventListener("input", function() {
      var v = this.value, score = 0;
      if (v.length >= 12) score++; if (v.length >= 16) score++;
      if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
      if (/[0-9]/.test(v)) score++; if (/[^A-Za-z0-9]/.test(v)) score++;
      if (COMMON.includes(v.toLowerCase())) score = 0;
      var colors = ["#ef4444","#f59e0b","#f59e0b","#22c55e","#16a34a","#15803d"];
      var labels = ["","Too weak","Weak","Good","Strong","Very strong"];
      var labelColors = ["","#ef4444","#f59e0b","#16a34a","#15803d","#15803d"];
      bar.style.width = (v.length ? Math.min(score * 20 + 5, 100) : 0) + "%";
      bar.style.background = colors[score] || colors[0];
      label.textContent = v.length ? (labels[score] || "") : "";
      label.style.color = labelColors[score] || "";
    });
    document.getElementById("pwForm").addEventListener("submit", function(e) {
      var p = document.getElementById("password").value;
      var c = document.getElementById("confirmPassword").value;
      if (p.length < 12) { e.preventDefault(); alert("Password must be at least 12 characters."); return; }
      if (p !== c) { e.preventDefault(); alert("Passwords don't match."); return; }
    });
  </script>
</body>
</html>`;
}

// ── GET /portal/forgot-password ───────────────────────────────────────────────
app.get("/portal/forgot-password", (req, res) => {
  const sent = req.query.sent === "1";
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sprimal — Forgot password</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; display: flex; }
    .brand-panel { flex: 1; background: #0f172a; display: flex; flex-direction: column; justify-content: center; padding: 64px 56px; color: white; }
    .brand-logo { font-size: 28px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 32px; }
    .brand-logo span { color: #4f76f6; }
    .brand-tagline { font-size: 22px; font-weight: 700; line-height: 1.35; margin-bottom: 16px; }
    .brand-sub { font-size: 15px; color: #94a3b8; line-height: 1.6; }
    .form-panel { width: 480px; display: flex; flex-direction: column; justify-content: center; padding: 64px 56px; background: white; }
    @media (max-width: 768px) { .brand-panel { display: none; } .form-panel { width: 100%; padding: 40px 28px; } }
    .form-title { font-size: 22px; font-weight: 700; color: #0f172a; margin-bottom: 6px; }
    .form-sub { font-size: 14px; color: #64748b; margin-bottom: 28px; line-height: 1.5; }
    label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 6px; }
    input[type=email] { width: 100%; padding: 11px 14px; border: 1.5px solid #e2e8f0; border-radius: 8px; font-size: 15px; font-family: inherit; outline: none; transition: border-color 0.15s; margin-bottom: 18px; }
    input[type=email]:focus { border-color: #4f76f6; }
    .btn { width: 100%; padding: 13px; background: #2563eb; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; font-family: inherit; }
    .btn:hover { background: #1d4ed8; }
    .success { background: #f0fdf4; border: 1px solid #86efac; color: #15803d; padding: 14px 16px; border-radius: 8px; font-size: 14px; margin-bottom: 20px; line-height: 1.5; }
    .back { display: inline-block; margin-top: 16px; font-size: 13px; color: #64748b; text-decoration: none; border-bottom: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="brand-panel">
    <div class="brand-logo">Sprim<span>al</span></div>
    <div class="brand-tagline">Forgot your password?</div>
    <div class="brand-sub">Enter your email and we'll send you a link to set a new one. The link expires after 1 hour.</div>
  </div>
  <div class="form-panel">
    <div class="form-title">Reset your password</div>
    <div class="form-sub">We'll email you a secure link to choose a new password.</div>
    ${sent ? `<div class="success">If that email is registered, a reset link is on its way. Check your inbox — it expires in 1 hour.</div>` : ""}
    <form method="POST" action="/portal/forgot-password">
      <label for="email">Email address</label>
      <input type="email" id="email" name="email" placeholder="you@yourclub.com" autocomplete="email" autofocus required />
      <button type="submit" class="btn">Send reset link &rarr;</button>
    </form>
    <a href="/portal" class="back">← Back to login</a>
  </div>
</body>
</html>`);
});

// ── POST /portal/forgot-password ──────────────────────────────────────────────
app.post("/portal/forgot-password", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  if (!email) return res.redirect("/portal/forgot-password?sent=1");

  const { data: tenants } = await supabase
    .from("tenants")
    .select("id, name, email")
    .eq("email", email);

  if (tenants?.length && process.env.RESEND_API_KEY) {
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS).toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Dublin" });
    for (const tenant of tenants) {
      const resetToken = createResetToken(tenant.id, email);
      const resetUrl = `https://app.sprimal.com/portal/reset-password/${resetToken}`;
      const multiAccount = tenants.length > 1;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.RESEND_API_KEY}` },
        body: JSON.stringify({
          from: "Sprimal <hello@sprimal.com>",
          to: email,
          subject: `Reset your Sprimal password${multiAccount ? ` — ${tenant.name}` : ""}`,
          html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f1f5f9;margin:0;padding:32px 16px;">
<table style="max-width:520px;margin:0 auto;background:white;border-radius:10px;overflow:hidden;">
  <tr><td style="background:#0f1f3d;padding:22px 32px;text-align:center;">
    <span style="font-size:22px;font-weight:bold;color:white;">Sprimal</span>
  </td></tr>
  <tr><td style="padding:36px 40px;">
    <h2 style="color:#0f172a;margin:0 0 12px;">Reset your password</h2>
    ${multiAccount ? `<p style="color:#6b7280;font-size:13px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;margin:0 0 16px;">Account: <strong>${tenant.name}</strong></p>` : ""}
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 24px;">Click the button below to choose a new password. This link expires in <strong>1 hour</strong>.</p>
    <table style="width:100%;margin-bottom:24px;"><tr><td style="text-align:center;">
      <a href="${resetUrl}" style="background:#2563eb;color:white;text-decoration:none;padding:13px 32px;border-radius:8px;font-weight:bold;font-size:15px;display:inline-block;">Set new password &rarr;</a>
    </td></tr></table>
    <p style="color:#9ca3af;font-size:12px;margin:0;line-height:1.5;">If you didn't request this, ignore this email — your password won't change. Link expires at ${expiresAt} IST.</p>
  </td></tr>
</table>
</body></html>`
        })
      }).catch(() => {});
    }
  }

  res.redirect("/portal/forgot-password?sent=1");
});

// ── GET /portal/reset-password/:token ────────────────────────────────────────
app.get("/portal/reset-password/:token", (req, res) => {
  const data = verifyResetToken(req.params.token);
  if (!data) return res.send(resetPageHtml("", "This reset link has expired or is invalid. Please <a href='/portal/forgot-password'>request a new one</a>."));
  res.send(resetPageHtml(req.params.token));
});

// ── POST /portal/reset-password/:token ───────────────────────────────────────
app.post("/portal/reset-password/:token", async (req, res) => {
  const data = verifyResetToken(req.params.token);
  if (!data) return res.send(resetPageHtml("", "This reset link has expired. Please <a href='/portal/forgot-password'>request a new one</a>."));

  const { password, confirmPassword } = req.body;
  const COMMON_PASSWORDS = ["password","password1","password12","password123","123456789","12345678","qwerty123","iloveyou","admin1234","letmein1","welcome1","monkey123"];
  if (!password || password.length < 12) return res.send(resetPageHtml(req.params.token, "Password must be at least 12 characters."));
  if (password !== confirmPassword) return res.send(resetPageHtml(req.params.token, "Passwords don't match."));
  if (COMMON_PASSWORDS.includes(password.toLowerCase())) return res.send(resetPageHtml(req.params.token, "That password is too common — please choose something more unique."));

  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, name, email, website")
    .eq("id", data.tenantId)
    .maybeSingle();

  if (!tenant) return res.send(resetPageHtml("", "Account not found. Please <a href='/portal/forgot-password'>try again</a>."));

  await supabase.from("tenants").update({ portal_password: password }).eq("id", tenant.id);

  // Auto-login
  const token = createTenantToken({ tenantId: tenant.id, tenantName: tenant.name, email: tenant.email, website: tenant.website, role: "senior" });
  setSessionCookie(res, token);
  res.redirect("/portal/dashboard");
});

app.get("/portal", (req, res) => {
  if (getTenantSession(req)) return res.redirect("/portal/dashboard");
  res.sendFile(path.join(__dirname, "views", "portal-login.html"));
});

app.post("/portal/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, error: "Please enter your email and password." });

  const normEmail    = email.toLowerCase().trim();
  const normPassword = password.trim();

  // ── 1. Check portal_users (junior staff) first ────────────────────────────
  const { data: portalUsers } = await supabase
    .from("portal_users")
    .select("id, tenant_id, name, email, password, role")
    .eq("email", normEmail)
    .eq("password", normPassword)
    .limit(1);

  if (portalUsers?.[0]) {
    const pu = portalUsers[0];

    // Fetch parent tenant — also check train_staff_enabled
    const { data: parentTenant } = await supabase
      .from("tenants")
      .select("name, website, train_staff_enabled")
      .eq("id", pu.tenant_id)
      .maybeSingle();

    // Block login if the account owner has disabled staff training
    if (!parentTenant?.train_staff_enabled) {
      return res.json({ success: false, error: "Staff access is currently disabled for this organisation. Please contact your manager." });
    }

    const juniorToken = createTenantToken({
      tenantId:   pu.tenant_id,
      tenantName: parentTenant?.name || pu.tenant_id,
      email:      pu.email,
      role:       pu.role || "junior",
      userName:   pu.name
    });

    setSessionCookie(res, juniorToken);
    return res.json({ success: true });
  }

  // ── 2. Fall back to tenant owner login ────────────────────────────────────
  // Match on both email AND password — handles the case where multiple tenants
  // share the same email address (e.g. an agency managing several clients)
  const { data: tenants } = await supabase
    .from("tenants")
    .select("id, name, email, website, portal_password")
    .eq("email", normEmail)
    .eq("portal_password", normPassword)
    .limit(1);

  const tenant = tenants?.[0] || null;

  if (!tenant) {
    return res.json({ success: false, error: "Incorrect email or password." });
  }

  const loginToken = createTenantToken({
    tenantId:   tenant.id,
    tenantName: tenant.name || tenant.id,
    email:      tenant.email,
    website:    tenant.website,
    role:       "senior"
  });

  setSessionCookie(res, loginToken);

  res.json({ success: true });
});

// ── AOM-specific chat page (existing/new client flow + OTP auth) ─────────────
app.get("/chat/aom", async (req, res) => {
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, name, logo_url")
    .eq("id", "aom")
    .maybeSingle();

  const avatarHtml = tenant?.logo_url
    ? `<img src="${tenant.logo_url}" alt="At Once Mortgages" />`
    : "AOM";

  const html = fs.readFileSync(path.join(__dirname, "views", "chat-aom.html"), "utf8")
    .replace("AVATAR_PLACEHOLDER", avatarHtml);

  res.setHeader("Cache-Control", "no-store");
  res.send(html);
});

// ── AOM OTP store ─────────────────────────────────────────────────────────────
// key: email (lowercase) → { code, applicationId, expiresAt }
const aomOtpStore = new Map();
const AOM_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Purge expired OTPs every 15 minutes
setInterval(function() {
  const now = Date.now();
  for (const [k, v] of aomOtpStore) {
    if (v.expiresAt < now) aomOtpStore.delete(k);
  }
}, 15 * 60 * 1000);

// POST /api/aom/lookup-email
app.post("/api/aom/lookup-email", async (req, res) => {
  try {
    const email = (req.body.email || "").toLowerCase().trim();
    if (!email) return res.status(400).json({ error: "email required" });

    const { data: apps } = await supabase
      .from("mortgage_application_states")
      .select("id, borrower_name, lender, current_phase")
      .eq("sender_email", email)
      .order("updated_at", { ascending: false });

    if (!apps || apps.length === 0) {
      return res.json({ status: "not_found", applications: [] });
    }
    if (apps.length === 1) {
      return res.json({ status: "single", applications: apps });
    }
    return res.json({ status: "multiple", applications: apps });
  } catch (err) {
    console.error("[aom/lookup-email]", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/aom/send-otp
app.post("/api/aom/send-otp", async (req, res) => {
  try {
    const email = (req.body.email || "").toLowerCase().trim();
    const { applicationId } = req.body;
    if (!email || !applicationId) return res.status(400).json({ error: "email and applicationId required" });

    // Generate 6-digit code
    const code = String(Math.floor(1000 + Math.random() * 9000));
    aomOtpStore.set(email, { code, applicationId, expiresAt: Date.now() + AOM_OTP_TTL_MS });

    // Send via Resend
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Maeve at AOM <maeve@sprimal.com>",
        to:   email,
        subject: "Your AOM verification code",
        html: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f5f9;">
  <tr><td align="center" style="padding:32px 16px;">
    <table cellpadding="0" cellspacing="0" border="0" width="480" style="max-width:480px;background:#fff;border-radius:10px;padding:36px 40px;">
      <tr><td>
        <p style="font-size:13px;font-weight:bold;color:#0f1f3d;margin:0 0 6px 0;">At Once Mortgages</p>
        <h1 style="font-size:20px;font-weight:bold;color:#0f1f3d;margin:0 0 20px 0;">Your verification code</h1>
        <p style="font-size:15px;color:#374151;margin:0 0 28px 0;">Enter this code in the chat to access your application:</p>
        <div style="background:#f3f4f6;border-radius:8px;padding:20px;text-align:center;margin-bottom:28px;">
          <span style="font-size:36px;font-weight:bold;letter-spacing:12px;color:#111827;">${code}</span>
        </div>
        <p style="font-size:13px;color:#6b7280;margin:0;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
      })
    });

    console.log(`[aom/send-otp] OTP sent to ${email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[aom/send-otp]", err.message);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// POST /api/aom/verify-otp
app.post("/api/aom/verify-otp", async (req, res) => {
  try {
    const email = (req.body.email || "").toLowerCase().trim();
    const code  = (req.body.code  || "").trim();
    if (!email || !code) return res.status(400).json({ ok: false, error: "email and code required" });

    const stored = aomOtpStore.get(email);
    if (!stored)                    return res.json({ ok: false, error: "No code found for that email. Please request a new one." });
    if (Date.now() > stored.expiresAt) { aomOtpStore.delete(email); return res.json({ ok: false, error: "That code has expired. Please request a new one." }); }
    if (stored.code !== code)       return res.json({ ok: false, error: "Incorrect code. Please check your email and try again." });

    // Code correct — consume it
    aomOtpStore.delete(email);
    const { applicationId } = stored;

    // Load application context for the greeting
    let greeting = "What would you like to know about your application?";
    try {
      const appCtx = await getApplicationContext(applicationId);
      const s = appCtx.state;
      const phase = s.current_phase ? s.current_phase.replace(/_/g, " ") : "in progress";
      const docsReceived = s.received_documents?.length
        ? s.received_documents.slice(0, 3).join(", ") + (s.received_documents.length > 3 ? ` and ${s.received_documents.length - 3} more` : "")
        : null;
      greeting = `Your application is currently at the ${phase} stage` +
        (s.lender ? ` with ${s.lender}` : "") + "." +
        (docsReceived ? `\n\nDocuments received so far: ${docsReceived}.` : "") +
        "\n\nWhat would you like to know?";
    } catch (ctxErr) {
      console.error("[aom/verify-otp] context load error:", ctxErr.message);
    }

    // Issue a short-lived signed session token
    const tokenPayload = { email, applicationId, exp: Date.now() + (2 * 60 * 60 * 1000) }; // 2hr
    const token = createTenantToken(tokenPayload);

    res.json({ ok: true, token, applicationId, greeting });
  } catch (err) {
    console.error("[aom/verify-otp]", err.message);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// POST /api/aom/client-chat  — chat for OTP-verified existing clients
const aomClientConversations = new Map(); // conversationId → message history

app.post("/api/aom/client-chat", async (req, res) => {
  try {
    const { userId, conversationId, message, applicationId, token } = req.body;
    if (!message || !applicationId || !token) return res.status(400).json({ error: "Missing fields" });

    // Verify token
    const session = verifyTenantToken(token);
    if (!session || session.applicationId !== applicationId || Date.now() > session.exp) {
      return res.status(401).json({ error: "Session expired. Please refresh and verify again." });
    }

    // Load application context
    const appCtx = await getApplicationContext(applicationId);
    const s = appCtx.state;

    const docsReceived = s.received_documents?.length
      ? s.received_documents.map(d => {
          const date = appCtx.docDates?.[d];
          return date ? `${d} (${date})` : d;
        }).join(", ")
      : "none yet";

    const docsMissing = s.missing_documents?.length
      ? s.missing_documents.join(", ")
      : "none outstanding";

    const recentSummary = appCtx.recentEvents?.length
      ? appCtx.recentEvents.slice(0, 3).map(e => `- ${e.event_type}: ${e.description}`).join("\n")
      : "No recent events";

    const systemPrompt = `You are Maeve, an AI assistant. You are speaking directly with a verified AOM client about their mortgage application. Answer their questions using only the application context provided below. Do not mention any person's name, email address, or phone number under any circumstances.

Application summary:
- Borrower: ${s.borrower_name || "Unknown"}
- Lender: ${s.lender || "Not yet selected"}
- Stage: ${(s.current_phase || "initial enquiry").replace(/_/g, " ")}
- Loan amount: ${s.loan_amount || "Not specified"}
- Docs received: ${docsReceived}
- Docs outstanding: ${docsMissing}
- Running summary: ${s.running_summary || "No summary yet"}

Recent activity:
${recentSummary}

Rules:
- Answer questions about their specific application using only the context above
- Be warm, clear and reassuring — mortgage processes can feel stressful
- If something is not in the context, say so briefly — do not proactively suggest contacting anyone
- Do not speculate about timelines, approvals, or decisions
- Never mention any person by name under any circumstances
- Only provide the contact email (cormac@aom.ie) if the client explicitly asks to speak to someone or contact the office — refer to it as "the AOM team" not a person's name
- Do not use markdown bold (**text**) in your responses — write in plain text only
- Keep replies concise and self-contained`;

    // Conversation history
    if (!aomClientConversations.has(conversationId)) {
      aomClientConversations.set(conversationId, []);
    }
    const history = aomClientConversations.get(conversationId);
    history.push({ role: "user", content: message });

    const response = await anthropic.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 400,
      system:     systemPrompt,
      messages:   history.slice(-10)
    });

    const reply = response.content[0]?.text?.trim() || "Sorry, I couldn't generate a response. Please try again.";
    history.push({ role: "assistant", content: reply });

    res.json({ reply });
  } catch (err) {
    console.error("[aom/client-chat]", err.message);
    res.status(500).json({ reply: "Sorry, something went wrong. Please try again." });
  }
});

// ── One-time admin seed: create AOM chat flows ───────────────────────────────
// Visit /api/admin/seed-aom-flows?password=<ADMIN_PASSWORD> once, then this
// endpoint does nothing (idempotent — checks for existing flows first).
app.get("/api/admin/seed-aom-flows", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // Idempotency: skip only if the named main menu flow already exists
  const { data: existing } = await supabase
    .from("chat_workflows")
    .select("id")
    .eq("club_id", "aom")
    .eq("name", "AOM — Main Menu")
    .limit(1);

  if (existing && existing.length > 0) {
    return res.json({ ok: true, message: "AOM flows already exist — nothing to do." });
  }

  try {
    // ── Create flows ────────────────────────────────────────────────────────
    const flowNames = [
      "AOM — Main Menu",
      "Existing Client",
      "New to AOM",
      "Mortgage Enquiry",
      "Book Appointment"
    ];
    const { data: flows, error: flowErr } = await supabase
      .from("chat_workflows")
      .insert(flowNames.map(name => ({ club_id: "aom", name, is_active: false })))
      .select("id, name");
    if (flowErr) throw flowErr;

    const fMain  = flows.find(f => f.name === "AOM — Main Menu").id;
    const fExist = flows.find(f => f.name === "Existing Client").id;
    const fNew   = flows.find(f => f.name === "New to AOM").id;
    const fMort  = flows.find(f => f.name === "Mortgage Enquiry").id;
    const fAppt  = flows.find(f => f.name === "Book Appointment").id;

    // ── Create steps ────────────────────────────────────────────────────────
    const stepDefs = [
      { workflow_id: fMain,  step_order: 1, bot_message: "Hi there 👋 I'm Maeve, the At Once Mortgages assistant.\n\nAre you an existing AOM client, or getting in touch for the first time?" },
      { workflow_id: fExist, step_order: 1, bot_message: "Welcome back.\n\nTo pull up your application, please type your email address below and I'll look it up for you." },
      { workflow_id: fNew,   step_order: 1, bot_message: "Great, let's get started. What brings you to AOM today?" },
      { workflow_id: fMort,  step_order: 1, bot_message: "Before we get started — I may need to collect some personal details to help with your enquiry. Is that okay?" },
      { workflow_id: fMort,  step_order: 2, bot_message: "To get started, which of these best describes you?" },
      { workflow_id: fAppt,  step_order: 1, bot_message: "No problem — tell me a bit about what you need and I'll make sure the team has everything ready for your call." },
    ];
    const { data: steps, error: stepErr } = await supabase
      .from("workflow_steps")
      .insert(stepDefs)
      .select("id, workflow_id, step_order");
    if (stepErr) throw stepErr;

    const s = (wfId, order) => steps.find(s => s.workflow_id === wfId && s.step_order === order).id;

    // ── Create choices ──────────────────────────────────────────────────────
    const choices = [
      // Main Menu
      { step_id: s(fMain,  1), choice_order: 1, label: "Existing Client",     action_type: "switch_flow", action_value: fExist },
      { step_id: s(fMain,  1), choice_order: 2, label: "New to AOM",          action_type: "switch_flow", action_value: fNew   },
      // Existing Client
      { step_id: s(fExist, 1), choice_order: 1, label: "Enter my email address", action_type: "ai_fallback", action_value: null },
      { step_id: s(fExist, 1), choice_order: 2, label: "← Back to main menu",    action_type: "switch_flow", action_value: fMain },
      // New to AOM
      { step_id: s(fNew,   1), choice_order: 1, label: "Apply for a mortgage", action_type: "switch_flow", action_value: fMort },
      { step_id: s(fNew,   1), choice_order: 2, label: "Book an appointment",  action_type: "switch_flow", action_value: fAppt },
      { step_id: s(fNew,   1), choice_order: 3, label: "Something else",       action_type: "ai_fallback", action_value: null  },
      // Mortgage — step 1 (GDPR)
      { step_id: s(fMort,  1), choice_order: 1, label: "Yes, that's fine", action_type: "next_step", action_value: "2" },
      { step_id: s(fMort,  1), choice_order: 2, label: "No thanks",        action_type: "message",   action_value: "No problem at all — I won't collect any personal information.\n\nIf you have general questions about mortgages, I'm still happy to help." },
      // Mortgage — step 2 (buyer type)
      { step_id: s(fMort,  2), choice_order: 1, label: "First-time buyer", action_type: "ai_fallback", action_value: null },
      { step_id: s(fMort,  2), choice_order: 2, label: "Switching",        action_type: "ai_fallback", action_value: null },
      { step_id: s(fMort,  2), choice_order: 3, label: "Remortgaging",     action_type: "ai_fallback", action_value: null },
      { step_id: s(fMort,  2), choice_order: 4, label: "Something else",   action_type: "ai_fallback", action_value: null },
      // Book Appointment
      { step_id: s(fAppt,  1), choice_order: 1, label: "Get started →",       action_type: "ai_fallback", action_value: null  },
      { step_id: s(fAppt,  1), choice_order: 2, label: "← Back to main menu", action_type: "switch_flow", action_value: fMain },
    ];
    const { error: choiceErr } = await supabase.from("workflow_choices").insert(choices);
    if (choiceErr) throw choiceErr;

    res.json({ ok: true, message: "AOM flows created successfully.", flows: flows.map(f => f.name) });
  } catch (err) {
    console.error("[seed-aom-flows]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Public tenant chat page (QR code destination) ────────────────────────────
app.get("/chat/:tenantId", async (req, res) => {
  const tenantId = req.params.tenantId;
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, name")
    .eq("id", tenantId)
    .maybeSingle();

  if (!tenant) return res.status(404).send("Not found");

  const name = (tenant.name || tenantId).replace(/"/g, "&quot;");

  // chat-tenant.html is a thin wrapper that loads widget.js with data-fullscreen="true".
  // Any future widget update automatically applies here — no duplicate code.
  const html = fs.readFileSync(path.join(__dirname, "views", "chat-tenant.html"), "utf8")
    .replace(/TENANT_ID_PLACEHOLDER/g,   tenantId)
    .replace(/TENANT_NAME_PLACEHOLDER/g, name);

  res.setHeader("Cache-Control", "no-store");
  res.send(html);
});

// ── Chat monthly limit helpers ────────────────────────────────────────────────
const chatUsageCache = new Map(); // tenantId → { count, month, ts }
const warned80pct    = new Set(); // `${tenantId}-YYYY-MM` — prevents repeat warning emails per month
const CHAT_CACHE_TTL = 60 * 1000; // 1-minute cache

// Per-IP per-tenant conversation start tracking (anti-abuse)
// Keyed by `${ip}-${tenantId}-YYYY-MM-DD-HH` → Set of conversation IDs seen this hour
const ipConvoStarts  = new Map();
const MAX_CONVOS_PER_IP_PER_HOUR = 15;

function checkIpConvoLimit(ip, tenantId, conversationId) {
  const now = new Date();
  const hourKey = `${ip}-${tenantId}-${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
  if (!ipConvoStarts.has(hourKey)) {
    // Prune stale hour buckets to prevent unbounded memory growth
    for (const k of ipConvoStarts.keys()) {
      if (!k.startsWith(`${ip}-${tenantId}`)) continue;
      if (k !== hourKey) ipConvoStarts.delete(k);
    }
    ipConvoStarts.set(hourKey, new Set());
  }
  const seen = ipConvoStarts.get(hourKey);
  if (seen.has(conversationId)) return true; // already seen this convo — allow
  if (seen.size >= MAX_CONVOS_PER_IP_PER_HOUR) return false; // too many new convos this hour
  seen.add(conversationId);
  return true;
}

// Per-tenant hourly new-conversation cap (IP-agnostic — defeats IP rotation attacks)
// Keyed by tenantId → { seen: Set<conversationId>, windowStart: timestamp }
const tenantHourlyConvos = new Map();
const TENANT_HOURLY_CONVO_CAP = 100; // alert threshold before hard cap
const TENANT_HOURLY_CONVO_HARD_CAP = 150;

function checkTenantHourlyCap(tenantId, conversationId) {
  const now = Date.now();
  const entry = tenantHourlyConvos.get(tenantId);
  if (!entry || now - entry.windowStart > 60 * 60 * 1000) {
    // New or expired window — start fresh
    tenantHourlyConvos.set(tenantId, { seen: new Set([conversationId]), windowStart: now, alerted: false });
    return { allowed: true, count: 1 };
  }
  if (entry.seen.has(conversationId)) return { allowed: true, count: entry.seen.size }; // known convo
  if (entry.seen.size >= TENANT_HOURLY_CONVO_HARD_CAP) return { allowed: false, count: entry.seen.size };
  entry.seen.add(conversationId);
  return { allowed: true, count: entry.seen.size, nearLimit: entry.seen.size >= TENANT_HOURLY_CONVO_CAP && !entry.alerted };
}

function markTenantHourlyAlerted(tenantId) {
  const entry = tenantHourlyConvos.get(tenantId);
  if (entry) entry.alerted = true;
}

async function getChatUsageThisMonth(tenantId) {
  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const entry = chatUsageCache.get(tenantId);
  if (entry && entry.month === month && Date.now() - entry.ts < CHAT_CACHE_TTL) {
    return { count: entry.count, month };
  }
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { data } = await supabase
    .from("chat_logs")
    .select("conversation_id")
    .eq("tenant_id", tenantId)
    .eq("sender", "customer")
    .gte("created_at", start)
    .not("conversation_id", "is", null);
  const count = new Set((data || []).map(r => r.conversation_id)).size;
  chatUsageCache.set(tenantId, { count, month, ts: Date.now() });
  return { count, month };
}

async function sendChatLimitWarning(email, displayName, count, limit) {
  if (!email || !process.env.RESEND_API_KEY) return;
  const pct = Math.round((count / limit) * 100);
  const nextReset = new Date();
  nextReset.setMonth(nextReset.getMonth() + 1);
  nextReset.setDate(1);
  const resetDate = nextReset.toLocaleDateString("en-IE", { day: "numeric", month: "long" });
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: "Sprimal <noreply@sprimal.com>",
      to:   email,
      subject: `${displayName} — you've used ${pct}% of your monthly chat allowance`,
      html: `<p style="font-family:sans-serif;">Hi,</p>
<p style="font-family:sans-serif;">Your Sprimal AI assistant (<strong>${displayName}</strong>) has used <strong>${count} of ${limit} conversations</strong> this month (${pct}%).</p>
<p style="font-family:sans-serif;">If you reach 100%, visitors will see a friendly message directing them to contact you directly. Your allowance resets on <strong>${resetDate}</strong>.</p>
<p style="font-family:sans-serif;">Need a higher limit? Reply to this email and we'll sort it out.</p>
<p style="font-family:sans-serif;">— The Sprimal Team</p>`
    })
  });
}

// ── GET /api/portal/chat-usage ────────────────────────────────────────────────
app.get("/api/portal/chat-usage", requireTenant, async (req, res) => {
  const { tenantId } = req.tenant;
  try {
    const { data: t } = await supabase.from("tenants").select("monthly_chat_limit").eq("id", tenantId).maybeSingle();
    const limit = t?.monthly_chat_limit ?? null;
    const { count, month } = await getChatUsageThisMonth(tenantId);
    res.json({ used: count, limit, month });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/portal/crawl-status ─────────────────────────────────────────────
// Returns live crawl progress for the authenticated tenant.
app.get("/api/portal/crawl-status", requireTenant, (req, res) => {
  const progress = crawlProgressMap.get(req.tenant.tenantId);
  if (!progress) return res.json({ active: false });
  res.json({ active: true, pct: progress.pct, message: progress.message, done: progress.done });
});

// ── POST /api/portal/recrawl ──────────────────────────────────────────────────
// Deletes all existing website-crawled documents + chunks for the tenant, then
// re-runs the background crawl against the same website URL.
app.post("/api/portal/recrawl", requireSeniorTenant, async (req, res) => {
  const { tenantId } = req.tenant;

  // Block if a crawl is already running
  const existing = crawlProgressMap.get(tenantId);
  if (existing && !existing.done) {
    return res.status(409).json({ error: "A crawl is already in progress." });
  }

  try {
    // Load tenant record to get website + name
    const { data: tenant, error: tenantErr } = await supabase
      .from("tenants")
      .select("id, name, website")
      .eq("id", tenantId)
      .single();

    if (tenantErr || !tenant?.website) {
      return res.status(400).json({ error: "No website URL found for this account." });
    }

    // Collect old website doc IDs — delete AFTER new crawl succeeds so portal shows
    // existing docs during the crawl rather than going blank.
    const { data: websiteDocs } = await supabase
      .from("documents")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("document_type", "Website Content");

    const oldDocIds = websiteDocs?.length ? websiteDocs.map(d => d.id) : [];

    // Fire off fresh crawl in background, passing old IDs so it can swap atomically
    startBackgroundCrawl({ tenantId: tenant.id, name: tenant.name, website: tenant.website, oldDocIds });
    console.log(`[recrawl] Re-crawl started for ${tenantId} (will replace ${oldDocIds.length} existing docs on success)`);

    res.json({ ok: true });
  } catch (err) {
    console.error("[recrawl] Error:", err.message);
    res.status(500).json({ error: "Re-crawl failed to start." });
  }
});

// ── POST /api/portal/reindex-documents ───────────────────────────────────────
// Re-indexes all uploaded (non-website) documents for the tenant with the new
// enriched chunk format. Runs in the background — responds immediately with a
// job ID, then the client polls /api/portal/reindex-status for progress.
const reindexProgressMap = new Map(); // tenantId → { done, total, results, running }

app.post("/api/portal/reindex-documents", requireSeniorTenant, async (req, res) => {
  const { tenantId } = req.tenant;

  if (reindexProgressMap.get(tenantId)?.running) {
    return res.status(409).json({ error: "Re-index already in progress." });
  }

  // Get all non-website documents for this tenant
  const { data: docs, error: docsErr } = await supabase
    .from("documents")
    .select("id, original_filename, description, document_type, mimetype, storage_path, effective_date")
    .eq("tenant_id", tenantId)
    .neq("document_type", "Website Content")
    .order("uploaded_at", { ascending: true });

  if (docsErr) return res.status(500).json({ error: "Could not load documents." });
  if (!docs || !docs.length) return res.json({ ok: true, message: "No uploaded documents to re-index." });

  // Kick off background work
  reindexProgressMap.set(tenantId, { running: true, done: 0, total: docs.length, results: [] });
  res.json({ ok: true, total: docs.length });

  // Run sequentially — avoids OpenAI rate limits and gives predictable progress
  (async () => {
    for (const doc of docs) {
      try {
        const result = await reindexDocument(doc, tenantId);
        const entry = { docId: doc.id, name: doc.original_filename || doc.description, ...result };
        const prog = reindexProgressMap.get(tenantId);
        if (prog) {
          prog.done++;
          prog.results.push(entry);
        }
        console.log(`[reindex] ${tenantId} — ${doc.original_filename}: ${JSON.stringify(entry)}`);
        // Small delay between documents to be kind to OpenAI
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error(`[reindex] Unhandled error for doc ${doc.id}:`, err.message);
        const prog = reindexProgressMap.get(tenantId);
        if (prog) { prog.done++; prog.results.push({ docId: doc.id, ok: false, reason: err.message }); }
      }
    }
    const prog = reindexProgressMap.get(tenantId);
    if (prog) prog.running = false;
    console.log(`[reindex] Completed for ${tenantId}. ${docs.length} docs processed.`);
  })();
});

app.get("/api/portal/reindex-status", requireSeniorTenant, (req, res) => {
  const prog = reindexProgressMap.get(req.tenant.tenantId);
  if (!prog) return res.json({ active: false });
  res.json({
    active:   prog.running,
    done:     prog.done,
    total:    prog.total,
    results:  prog.results,
    complete: !prog.running && prog.done > 0
  });
});

// ── Membership Requests ───────────────────────────────────────────────────────
// Public endpoint — called by bot to submit a membership change request
app.post("/api/membership-request", async (req, res) => {
  const { tenantId, memberName, membershipNumber, memberEmail, currentType, requestedType,
          effectiveDate, reason, familyMembersLeaving, proRataAmount, proRataNote } = req.body || {};
  if (!tenantId || !memberName) return res.status(400).json({ error: "Missing required fields" });
  const { error } = await supabase.from("membership_requests").insert({
    tenant_id:               tenantId,
    member_name:             memberName,
    membership_number:       membershipNumber || null,
    member_email:            memberEmail      || null,
    current_type:            currentType      || null,
    requested_type:          requestedType    || null,
    effective_date:          effectiveDate    || null,
    reason:                  reason           || null,
    family_members_leaving:  familyMembersLeaving || [],
    pro_rata_amount:         proRataAmount    || null,
    pro_rata_note:           proRataNote      || null
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// GET /api/portal/membership-requests — list all requests for this tenant
app.get("/api/portal/membership-requests", requireTenant, async (req, res) => {
  const { data, error } = await supabase
    .from("membership_requests")
    .select("*")
    .eq("tenant_id", req.tenant.tenantId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/portal/membership-requests/:id/preview — calculate proration before approving
app.get("/api/portal/membership-requests/:id/preview", requireTenant, async (req, res) => {
  const tenantId  = req.tenant.tenantId;
  const requestId = req.params.id;

  const { data: request, error: reqErr } = await supabase
    .from("membership_requests")
    .select("*")
    .eq("id", requestId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (reqErr || !request) return res.status(404).json({ error: "Request not found" });

  // Only relevant for plan changes with a target type
  const changeType = (request.requested_type || "").toLowerCase();
  if (/cancel/i.test(changeType) || !request.target_membership_type || !request.member_email) {
    return res.json({ proration: null });
  }

  let stripeKey = null;
  try {
    const { data: intg } = await supabase
      .from("tenant_integrations")
      .select("config, is_active")
      .eq("tenant_id", tenantId)
      .eq("provider", "stripe")
      .maybeSingle();
    if (intg?.is_active && intg.config) {
      const cfg = decryptIntgConfig(intg.config);
      stripeKey = cfg.secret_key || null;
    }
  } catch (e) {}
  if (!stripeKey) return res.json({ proration: null });

  try {
    const authHeader = "Basic " + Buffer.from(stripeKey + ":").toString("base64");

    // Find customer
    const custResp = await fetch(
      "https://api.stripe.com/v1/customers?email=" + encodeURIComponent(request.member_email) + "&limit=1",
      { headers: { Authorization: authHeader } }
    );
    const custData = await custResp.json();
    if (!custData.data || !custData.data.length) return res.json({ proration: null });
    const customer = custData.data[0];

    // Find subscription
    const subResp = await fetch(
      "https://api.stripe.com/v1/subscriptions?customer=" + customer.id + "&limit=10",
      { headers: { Authorization: authHeader } }
    );
    const subData = await subResp.json();
    const sub = (subData.data || []).find(function(s) {
      return ["active", "trialing", "past_due"].indexOf(s.status) !== -1;
    });
    if (!sub) return res.json({ proration: null });

    const currentItem = sub.items && sub.items.data && sub.items.data[0];

    // Find the original paid charge by searching paid invoice history.
    // We must NOT use sub.latest_invoice — after a plan switch that creates proration,
    // latest_invoice points to the proration invoice (e.g. €70 charge), not the original
    // payment (e.g. €300 Family Sub). Searching paid invoices guarantees we find the
    // right charge to refund regardless of whether the switch has already happened.
    let currentChargeId = null;
    try {
      const paidInvResp = await fetch(
        "https://api.stripe.com/v1/invoices?subscription=" + sub.id + "&limit=20",
        { headers: { Authorization: authHeader } }
      );
      const paidInvData = await paidInvResp.json();
      const paidInvoice = (paidInvData.data || []).find(function(inv) {
        return inv.status === "paid" && inv.charge && inv.amount_paid > 0;
      });
      currentChargeId = paidInvoice ? paidInvoice.charge : null;
    } catch (e) { /* non-fatal */ }

    // Find target product and price
    const productsResp = await fetch(
      "https://api.stripe.com/v1/products?limit=100&active=true",
      { headers: { Authorization: authHeader } }
    );
    const productsData = await productsResp.json();
    const targetProduct = (productsData.data || []).find(function(p) {
      return p.name.toLowerCase() === request.target_membership_type.toLowerCase();
    });
    if (!targetProduct) return res.json({ proration: null });

    const pricesResp = await fetch(
      "https://api.stripe.com/v1/prices?product=" + targetProduct.id + "&active=true&limit=5",
      { headers: { Authorization: authHeader } }
    );
    const pricesData = await pricesResp.json();
    const targetPrice = pricesData.data && pricesData.data[0];
    if (!targetPrice) return res.json({ proration: null });

    // Preview upcoming invoice with proposed plan change — no changes made
    const prorationDate = Math.floor(Date.now() / 1000);
    const previewParams = new URLSearchParams({
      customer:                          customer.id,
      subscription:                      sub.id,
      "subscription_items[0][id]":       currentItem ? currentItem.id : "",
      "subscription_items[0][price]":    targetPrice.id,
      subscription_proration_date:       String(prorationDate)
    });

    const previewResp = await fetch(
      "https://api.stripe.com/v1/invoices/upcoming?" + previewParams.toString(),
      { headers: { Authorization: authHeader } }
    );
    const previewData = await previewResp.json();
    if (previewData.error) return res.json({ proration: null });

    // Sum ALL invoice lines — amount_due clamps at 0, and the new plan's subscription
    // line (proration: false) must be included to get the correct net credit/charge
    const lines = (previewData.lines && previewData.lines.data) || [];
    const netProration = lines.reduce(function(sum, l) { return sum + l.amount; }, 0);

    // Build breakdown for display: credit (old plan refund) and charge (new plan)
    const creditLine = lines.find(function(l) { return l.amount < 0; });
    const chargeLine = lines.find(function(l) { return l.amount > 0; });
    const creditAmt  = creditLine ? Math.abs(creditLine.amount) : 0;
    const chargeAmt  = chargeLine ? chargeLine.amount : 0;

    const currency    = (previewData.currency || "eur").toUpperCase();
    const isDowngrade = netProration < 0; // net credit to member
    const isUpgrade   = netProration > 0; // net charge to member
    const amountDue   = netProration;

    return res.json({
      proration: {
        amountDue,
        amountAbs:      Math.abs(amountDue),
        creditAmt,
        chargeAmt,
        currency,
        isDowngrade,
        isUpgrade,
        fromPlan:       request.current_type || request.requested_type,
        toPlan:         request.target_membership_type,
        memberName:     request.member_name,
        latestInvoice:  sub.latest_invoice,
        chargeId:       currentChargeId,
        customerId:     customer.id,
        subscriptionId: sub.id,
        currentItemId:  currentItem ? currentItem.id : null,
        targetPriceId:  targetPrice.id
      }
    });

  } catch (e) {
    console.error("[Preview] Error:", e.message);
    return res.json({ proration: null });
  }
});

// POST /api/portal/membership-requests/:id/approve
app.post("/api/portal/membership-requests/:id/approve", requireTenant, async (req, res) => {
  const { notes, refundNow, prorationAmount, chargeId: providedChargeId } = req.body || {};
  const tenantId  = req.tenant.tenantId;
  const requestId = req.params.id;

  // 1. Load the membership request
  const { data: request, error: reqErr } = await supabase
    .from("membership_requests")
    .select("*")
    .eq("id", requestId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (reqErr || !request) return res.status(404).json({ error: "Request not found" });

  // 2. Load this tenant's Stripe secret key from tenant_integrations
  let stripeKey = null;
  try {
    const { data: intg } = await supabase
      .from("tenant_integrations")
      .select("config, is_active")
      .eq("tenant_id", tenantId)
      .eq("provider", "stripe")
      .maybeSingle();
    if (intg?.is_active && intg.config) {
      const cfg = decryptIntgConfig(intg.config);
      stripeKey = cfg.secret_key || null;
    }
  } catch (e) {
    console.error("[Approve] Stripe config load error:", e.message);
  }

  // 3. Execute Stripe action
  let stripeResult = null;

  if (!stripeKey) {
    stripeResult = { ok: false, message: "No Stripe integration configured for this club — update manually in Stripe Dashboard." };
  } else if (!request.member_email) {
    stripeResult = { ok: false, message: "No member email on this request — Stripe lookup skipped. Update manually." };
  } else {
    try {
      const authHeader = "Basic " + Buffer.from(stripeKey + ":").toString("base64");

      // Find Stripe customer by email
      const custResp = await fetch(
        "https://api.stripe.com/v1/customers?email=" + encodeURIComponent(request.member_email) + "&limit=1",
        { headers: { Authorization: authHeader } }
      );
      const custData = await custResp.json();

      if (!custData.data || !custData.data.length) {
        stripeResult = { ok: false, message: "No Stripe customer found for " + request.member_email };
      } else {
        const customer = custData.data[0];

        // Fetch all subscriptions for this customer, filter to actionable statuses client-side
        const subResp = await fetch(
          "https://api.stripe.com/v1/subscriptions?customer=" + customer.id + "&limit=10",
          { headers: { Authorization: authHeader } }
        );
        const subData = await subResp.json();
        const actionableSubs = (subData.data || []).filter(function(s) {
          return ["active", "trialing", "past_due"].indexOf(s.status) !== -1;
        });

        if (!actionableSubs.length) {
          stripeResult = { ok: false, message: "No active subscription found for " + request.member_email + " (customer " + customer.id + ")" };
        } else {
          const sub      = actionableSubs[0];
          const item     = sub.items && sub.items.data && sub.items.data[0];
          const price    = item && item.price;
          const amount   = price && price.unit_amount;
          const currency = (price && price.currency || "eur").toUpperCase();
          const periodEnd = new Date(sub.current_period_end * 1000)
            .toLocaleDateString("en-IE", { day: "numeric", month: "long", year: "numeric" });
          const changeType = (request.requested_type || "").toLowerCase();

          if (/cancel/i.test(changeType)) {
            // Use the member's requested effective date if provided, otherwise fall back to period end
            let cancelBody;
            let cancelDateLabel;
            if (request.effective_date) {
              const cancelTs = Math.floor(new Date(request.effective_date).getTime() / 1000);
              cancelBody = { cancel_at: String(cancelTs) };
              cancelDateLabel = new Date(request.effective_date).toLocaleDateString("en-IE", { day: "numeric", month: "long", year: "numeric" });
            } else {
              cancelBody = { cancel_at_period_end: "true" };
              cancelDateLabel = periodEnd;
            }

            const cancelResp = await fetch("https://api.stripe.com/v1/subscriptions/" + sub.id, {
              method: "POST",
              headers: { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams(cancelBody).toString()
            });
            const cancelData = await cancelResp.json();
            if (cancelData.cancel_at || cancelData.cancel_at_period_end) {
              stripeResult = {
                ok: true,
                action: "cancelled_at_date",
                message: `✅ Subscription set to cancel on ${cancelDateLabel}. Member retains access until then.`,
                subscriptionId: sub.id,
                customerId: customer.id
              };
            } else {
              stripeResult = { ok: false, message: "Stripe cancel API call failed.", raw: cancelData };
            }

          } else {
            // Plan change — look up target plan in Stripe by name and switch subscription
            const targetType = request.target_membership_type;

            if (!targetType) {
              stripeResult = {
                ok: false,
                message: "No target membership type specified on this request. Ask the member what type they want to change to.",
                stripeDashboardUrl: "https://dashboard.stripe.com/customers/" + customer.id
              };
            } else {
              // List all active products in this Stripe account and find one matching the target type name
              const productsResp = await fetch(
                "https://api.stripe.com/v1/products?limit=100&active=true",
                { headers: { Authorization: authHeader } }
              );
              const productsData = await productsResp.json();
              const targetProduct = (productsData.data || []).find(function(p) {
                return p.name.toLowerCase() === targetType.toLowerCase();
              });

              if (!targetProduct) {
                stripeResult = {
                  ok: false,
                  message: "Could not find a Stripe product named '" + targetType + "'. Check product names match membership types in Stripe Dashboard.",
                  stripeDashboardUrl: "https://dashboard.stripe.com/customers/" + customer.id
                };
              } else {
                // Get the active price for this product
                const pricesResp = await fetch(
                  "https://api.stripe.com/v1/prices?product=" + targetProduct.id + "&active=true&limit=5",
                  { headers: { Authorization: authHeader } }
                );
                const pricesData = await pricesResp.json();
                const targetPrice = pricesData.data && pricesData.data[0];

                if (!targetPrice) {
                  stripeResult = {
                    ok: false,
                    message: "No active price found for plan '" + targetType + "' in Stripe.",
                    stripeDashboardUrl: "https://dashboard.stripe.com/customers/" + customer.id
                  };
                } else {
                  // Switch the subscription to the new plan, clearing any scheduled cancellation
                  const currentItem = sub.items && sub.items.data && sub.items.data[0];
                  const switchBody = {
                    "items[0][id]":       currentItem ? currentItem.id : undefined,
                    "items[0][price]":    targetPrice.id,
                    "proration_behavior": "create_prorations",
                    "cancel_at_period_end": "false"  // clear any existing cancellation
                  };
                  if (!currentItem) delete switchBody["items[0][id]"];
                  // Clear cancel_at if previously set
                  if (sub.cancel_at) switchBody["cancel_at"] = "";

                  const switchResp = await fetch("https://api.stripe.com/v1/subscriptions/" + sub.id, {
                    method: "POST",
                    headers: { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams(switchBody).toString()
                  });
                  const switchData = await switchResp.json();

                  if (switchData.id) {
                    const newAmount = targetPrice.unit_amount;
                    const newCurrency = (targetPrice.currency || "eur").toUpperCase();
                    const newAmountFmt = newAmount != null ? "€" + (newAmount / 100).toFixed(2) : "";
                    let refundNote = " Pro-rata credit applied to next invoice.";

                    // Issue immediate cash refund if committee chose "Refund now"
                    if (refundNow && prorationAmount && prorationAmount > 0) {
                      try {
                        // Use the charge ID captured during the preview step (before plan switch).
                        // After the switch, sub.latest_invoice changes to the new proration invoice,
                        // so we must NOT re-fetch it here — use what was passed from the frontend.
                        let chargeId = providedChargeId || null;
                        if (!chargeId && sub.latest_invoice) {
                          // Fallback: attempt to look up from current invoice (may differ post-switch)
                          try {
                            const invResp = await fetch(
                              "https://api.stripe.com/v1/invoices/" + sub.latest_invoice,
                              { headers: { Authorization: authHeader } }
                            );
                            const invData = await invResp.json();
                            chargeId = invData.charge || null;
                          } catch (e) {}
                        }
                        if (chargeId) {
                          const refundResp = await fetch("https://api.stripe.com/v1/refunds", {
                            method: "POST",
                            headers: { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" },
                            body: new URLSearchParams({
                              charge: chargeId,
                              amount: String(Math.round(prorationAmount))
                            }).toString()
                          });
                          const refundData = await refundResp.json();
                          if (refundData.id) {
                            refundNote = ` A refund of €${(prorationAmount / 100).toFixed(2)} has been issued to the member's card (5–10 days).`;
                          } else {
                            refundNote = " Refund could not be issued automatically — please process manually in Stripe Dashboard.";
                            console.error("[Approve] Refund failed:", refundData);
                          }
                        } else {
                          refundNote = " No charge found to refund — please process manually in Stripe Dashboard.";
                        }
                      } catch (refErr) {
                        console.error("[Approve] Refund error:", refErr.message);
                        refundNote = " Refund error — please process manually in Stripe Dashboard.";
                      }
                    }

                    stripeResult = {
                      ok: true,
                      action: "plan_changed",
                      message: `✅ Subscription changed to ${targetType} (${newAmountFmt}/year).${refundNote}`,
                      subscriptionId: sub.id,
                      customerId: customer.id,
                      stripeDashboardUrl: "https://dashboard.stripe.com/customers/" + customer.id
                    };
                  } else {
                    stripeResult = {
                      ok: false,
                      message: "Stripe plan switch failed: " + ((switchData.error && switchData.error.message) || "unknown error"),
                      stripeDashboardUrl: "https://dashboard.stripe.com/customers/" + customer.id
                    };
                  }
                }
              }
            }
          }
        }
      }
    } catch (stripeErr) {
      console.error("[Approve] Stripe execution error:", stripeErr.message);
      stripeResult = { ok: false, message: "Stripe error: " + stripeErr.message };
    }
  }

  // 4. Update membership_requests row
  const updatePayload = {
    status:           "approved",
    committee_notes:  notes || null,
    actioned_at:      new Date().toISOString(),
    stripe_result:    stripeResult
  };
  const { error: updErr } = await supabase
    .from("membership_requests")
    .update(updatePayload)
    .eq("id", requestId)
    .eq("tenant_id", tenantId);
  if (updErr) return res.status(500).json({ error: updErr.message });

  res.json({ ok: true, stripeResult });
});

// POST /api/portal/membership-requests/:id/reject
app.post("/api/portal/membership-requests/:id/reject", requireTenant, async (req, res) => {
  const { notes } = req.body || {};
  const { error } = await supabase.from("membership_requests")
    .update({ status: "rejected", committee_notes: notes || null, actioned_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("tenant_id", req.tenant.tenantId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get("/portal/dashboard", requireTenant, async (req, res) => {
  try {
    // ── Junior users: verify train_staff_enabled is still on ─────────────
    if (req.tenant.role === "junior") {
      const { data: tenantCheck } = await supabase
        .from("tenants")
        .select("train_staff_enabled")
        .eq("id", req.tenant.tenantId)
        .maybeSingle();

      if (!tenantCheck?.train_staff_enabled) {
        // Feature has been disabled — clear session and redirect to login with message
        res.clearCookie("tenant_session", { httpOnly: true, secure: true, sameSite: "lax" });
        return res.redirect("/portal?disabled=1");
      }

      const tid   = req.tenant.tenantId   || "";
      const tname = (req.tenant.tenantName || req.tenant.tenantId || "").replace(/"/g, "&quot;");
      const uname = (req.tenant.userName  || req.tenant.email || "Staff").replace(/"/g, "&quot;");
      const html  = fs.readFileSync(path.join(__dirname, "views", "portal-junior.html"), "utf8")
        .replace(/TENANT_ID_PLACEHOLDER/g,   tid)
        .replace(/TENANT_NAME_PLACEHOLDER/g, tname)
        .replace(/USER_NAME_PLACEHOLDER/g,   uname);
      res.setHeader("Cache-Control", "no-store");
      return res.send(html);
    }

    const tid   = req.tenant.tenantId   || "";
    const tname = (req.tenant.tenantName || req.tenant.tenantId || "").replace(/"/g, "&quot;");
    const embedCode = `&lt;script src="https://app.sprimal.com/widget.js" data-club-id="${tid}" data-club-name="${tname}"&gt;&lt;/script&gt;`;

    // ── Fetch documents + tenant created_at in parallel ──────────────────────
    const [{ data: docs }, { data: tenantMeta }] = await Promise.all([
      supabase
        .from("documents")
        .select("id, original_filename, stored_filename, storage_path, document_type, uploaded_at")
        .eq("tenant_id", tid)
        .order("uploaded_at", { ascending: false }),
      supabase
        .from("tenants")
        .select("created_at, last_crawl_at, last_crawl_pages, business_type")
        .eq("id", tid)
        .maybeSingle()
    ]);

    const tenantCreatedAt = tenantMeta?.created_at || null;
    const lastCrawlAt = tenantMeta?.last_crawl_at || null;
    const lastCrawlPages = tenantMeta?.last_crawl_pages ?? null;

    // Fetch business_type separately so a schema mismatch above can't silently break it
    const { data: bizRow } = await supabase
      .from("tenants")
      .select("business_type")
      .eq("id", tid)
      .maybeSingle();
    const bizType = bizRow?.business_type || "other";
    const docListHtml = buildDocListHtml(docs || [], tid, req.tenant.website || null, tenantCreatedAt, lastCrawlAt, lastCrawlPages);

    // Chat logs are lazy-loaded via /api/portal/chat-logs when the section is opened,
    // preventing large HTML blobs from being embedded in the page and freezing the browser.
    const chatLogsHtml = "";

    // Auto-refresh removed — the F1 crawl-progress widget handles live updates via polling
    const autoRefresh = '';

    // Mortgage tracker — only for AOM tenant
    let mortgageAppsScript = "var MORTGAGE_APPS = null;";
    if (process.env.AOM_TENANT_ID && req.tenant.tenantId === process.env.AOM_TENANT_ID) {
      const { data: mortApps } = await supabase
        .from("mortgage_application_states")
        .select("id, borrower_name, co_borrower_name, client_email, application_ref, lender, current_phase, borrower_type, loan_amount, property_address, updated_at")
        .order("updated_at", { ascending: false });
      const safeJson = JSON.stringify(mortApps || [])
        .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
      mortgageAppsScript = `var MORTGAGE_APPS = ${safeJson};`;
    }

    const html = fs.readFileSync(path.join(__dirname, "views", "portal-dashboard.html"), "utf8")
      .replace(/TENANT_ID_PLACEHOLDER/g,        tid)
      .replace(/TENANT_NAME_PLACEHOLDER/g,       tname)
      .replace(/EMBED_CODE_PLACEHOLDER/g,        embedCode)
      .replace("DOC_LIST_PLACEHOLDER",           docListHtml)
      .replace("CHAT_LOGS_PLACEHOLDER",          chatLogsHtml)
      .replace("AUTO_REFRESH_PLACEHOLDER",       autoRefresh)
      .replace("MORTGAGE_APPS_JSON_PLACEHOLDER", mortgageAppsScript)
      .replace("BUSINESS_TYPE_PLACEHOLDER",      bizType);

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.send(html);
  } catch (err) {
    console.error("[portal-dashboard] Failed to render:", err.message);
    res.redirect("/portal");
  }
});

function buildDocListHtml(docs, tid, tenantWebsite, tenantCreatedAt, lastCrawlAt, lastCrawlPages) {
  function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  const websites = docs.filter(d => d.document_type === "Website Content");
  const uploaded = docs.filter(d => d.document_type !== "Website Content");

  // Group website pages by domain
  const domainMap = {};
  websites.forEach(d => {
    try {
      const pageUrl = d.stored_filename || d.storage_path || "";
      // Normalise www.example.com and example.com to the same group
      const domain = new URL(pageUrl).hostname.replace(/^www\./, "");
      if (!domainMap[domain]) domainMap[domain] = { domain, pages: 0, date: d.uploaded_at, sampleUrl: pageUrl };
      domainMap[domain].pages++;
    } catch(e) {}
  });

  if (!websites.length && !uploaded.length) {
    // Case 1: No website URL — no crawl was ever triggered
    if (!tenantWebsite) {
      return '<div style="margin-top:24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;text-align:center;">'
        + '<div style="font-size:32px;margin-bottom:10px;">📂</div>'
        + '<div style="font-size:14px;font-weight:700;color:#374151;margin-bottom:6px;">Your knowledge base is empty</div>'
        + '<div style="font-size:13px;color:#6b7280;line-height:1.6;">Add content above — crawl your website, upload a document, or write a note — and your AI assistant will start answering questions straight away.</div>'
        + '</div>';
    }

    let normalizedSite = tenantWebsite;
    if (!/^https?:\/\//i.test(normalizedSite)) normalizedSite = "https://" + normalizedSite;
    let domain = "";
    try { domain = new URL(normalizedSite).hostname; } catch(e) {}

    const retryBtn = '<div style="margin-top:16px;">'
      + '<button onclick="portalReimportWebsite(\'' + domain.replace(/'/g, "\\'") + '\',\'' + normalizedSite.replace(/'/g, "\\'") + '\')" '
      + 'style="background:#2563eb;color:#fff;border:none;border-radius:6px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;">'
      + '&#8635; Import website now</button>'
      + '</div>';

    // Case 2: Website URL exists, tenant signed up within the last 10 minutes — crawl may be in progress
    const tenantAgeMs = tenantCreatedAt ? (Date.now() - new Date(tenantCreatedAt).getTime()) : Infinity;
    if (tenantAgeMs < 10 * 60 * 1000) {
      return '<div style="margin-top:24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 22px;color:#6b7280;font-size:13px;line-height:1.6;">'
        + '&#8987; Your pages will appear here once the crawl finishes — keep an eye on the progress bar above.'
        + '</div>';
    }

    // Case 3a: Crawl ran recently but got 0 pages — likely bot protection
    if (lastCrawlAt && lastCrawlPages === 0) {
      return '<div style="margin-top:24px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:20px 24px;">'
        + '<div style="font-size:14px;font-weight:700;color:#92400e;margin-bottom:6px;">&#9888;&#65039; Website crawl was blocked</div>'
        + '<div style="font-size:13px;color:#b45309;line-height:1.6;">The crawl ran but your website blocked access (likely Cloudflare bot protection). Try importing again — it may work now, or you can paste content manually below.</div>'
        + '<div style="font-size:12px;color:#d97706;margin-top:6px;">Website: <strong>' + esc(normalizedSite) + '</strong></div>'
        + retryBtn
        + '</div>';
    }

    // Case 3b: Website URL exists but tenant is older than 10 minutes with no docs — crawl never ran or stalled
    return '<div style="margin-top:24px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:20px 24px;">'
      + '<div style="font-size:14px;font-weight:700;color:#991b1b;margin-bottom:6px;">&#9888;&#65039; Website import didn\'t complete</div>'
      + '<div style="font-size:13px;color:#b91c1c;line-height:1.6;">Your knowledge base is empty — it looks like the website crawl didn\'t finish. Click below to import your website now.</div>'
      + '<div style="font-size:12px;color:#ef4444;margin-top:6px;">Website: <strong>' + esc(normalizedSite) + '</strong></div>'
      + retryBtn
      + '</div>';
  }

  let html = "";

  // Imported websites
  const domains = Object.values(domainMap);
  if (domains.length) {
    html += '<div class="section-label">Imported Websites</div>';
    html += domains.map(site => {
      const date = site.date ? new Date(site.date).toLocaleDateString("en-IE", { day:"numeric", month:"short", year:"numeric" }) : "";
      const rootUrl = site.sampleUrl ? new URL(site.sampleUrl).origin : ("https://" + site.domain);
      return '<div class="website-row">'
        + '<div class="website-row-left"><div class="globe-icon">&#127760;</div><div>'
        + '<div class="website-domain">' + esc(site.domain) + '</div>'
        + '<div class="website-meta">' + site.pages + ' page' + (site.pages !== 1 ? 's' : '') + ' &middot; Imported ' + date + '</div>'
        + '</div></div>'
        + '<div style="display:flex;gap:8px;flex-shrink:0;">'
        + '<button class="btn-reimport-website" onclick="portalReimportWebsite(\'' + esc(site.domain) + '\',\'' + esc(rootUrl) + '\')">Re-import</button>'
        + '<button class="btn-remove-website" onclick="portalRemoveWebsite(\'' + esc(site.domain) + '\')">Remove</button>'
        + '</div>'
        + '</div>';
    }).join("");
  }

  // Uploaded documents are rendered client-side with pagination via loadDocuments()

  return html;
}

function buildChatLogsHtml(conversations) {
  function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function fmtDate(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleString("en-IE", { day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" });
  }

  if (!conversations || conversations.length === 0) {
    return '<div style="text-align:center;padding:24px 0;font-size:14px;color:#9ca3af;">No conversations yet — they\'ll appear here once visitors start chatting.</div>';
  }

  return conversations.map(conv => {
    const firstCustomer = (conv.messages || []).find(m => m.sender === "customer");
    const preview = firstCustomer ? firstCustomer.message : (conv.messages[0] || {}).message || "";
    const previewText = esc(preview.length > 90 ? preview.slice(0, 90) + "…" : preview);
    const date = esc(fmtDate(conv.startedAt));
    const count = conv.messageCount;

    const msgHtml = (conv.messages || []).map(m => {
      const cls = m.sender === "bot" ? "conv-msg-bot" : m.sender === "system" ? "conv-msg-system" : "conv-msg-user";
      const label = m.sender === "bot" ? "Assistant" : m.sender === "system" ? "System" : "Visitor";
      return '<div class="conv-msg ' + cls + '">'
        + '<span class="conv-msg-label">' + label + '</span>'
        + '<div class="conv-msg-text">' + esc(m.message) + '</div>'
        + '</div>';
    }).join("");

    return '<details class="conv-details">'
      + '<summary class="conv-summary">'
      + '<div class="conv-header"><span class="conv-date">' + date + '</span>'
      + '<span class="conv-count">' + count + ' message' + (count !== 1 ? 's' : '') + '</span></div>'
      + '<div class="conv-preview">' + (previewText || '<em style="color:#d1d5db;">—</em>') + '</div>'
      + '</summary>'
      + '<div class="conv-messages">' + msgHtml + '</div>'
      + '</details>';
  }).join("");
}

app.post("/portal/logout", (req, res) => {
  res.clearCookie("tenant_session", { httpOnly: true, secure: true, sameSite: "lax" });
  res.redirect("/portal");
});

app.get("/api/portal/me", requireTenant, (req, res) => {
  res.json({
    tenantId:   req.tenant.tenantId,
    tenantName: req.tenant.tenantName,
    email:      req.tenant.email,
    website:    req.tenant.website
  });
});


app.get("/api/portal/documents", requireTenant, async (req, res) => {
  let query = supabase
    .from("documents")
    .select("id, original_filename, stored_filename, mimetype, document_type, audience, description, uploaded_at")
    .eq("tenant_id", req.tenant.tenantId)
    .order("uploaded_at", { ascending: false });

  // Optional type filter — used by replaces dropdown in upload form
  if (req.query.type) query = query.eq("document_type", req.query.type);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "Failed to load documents" });
  res.json(data || []);
});

app.post(
  "/api/portal/upload",
  requireTenant,
  upload.single("document"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const tenantId = req.tenant.tenantId;
      let extractedText = "";

      if (req.file.mimetype === "application/pdf") {
        extractedText = await extractPdfText(req.file.path);
      } else if (req.file.mimetype === "text/plain") {
        extractedText = fs.readFileSync(req.file.path, "utf8");
      } else if (req.file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        const result = await mammoth.extractRawText({ path: req.file.path });
        extractedText = result.value;
      } else {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "Only PDF, Word (.docx), and plain text files are supported." });
      }

      if (!extractedText || extractedText.trim().length < 20) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({
          error: "This file appears to be a scanned image — no readable text could be extracted from it.\n\nTo add it to the knowledge base, please try one of these:\n• Open the PDF in Word (File → Open) and save as .docx\n• Copy and paste the text into a plain .txt file\n• If you have the original document, upload that instead"
        });
      }

      // ── De-duplication: reject if identical content already exists ──────────
      // (skip check if the user is explicitly replacing an existing document)
      const contentHash = crypto.createHash("sha256").update(extractedText.trim()).digest("hex");
      if (!req.body.replaces_document_id) {
        const { data: existingByHash } = await supabase
          .from("documents")
          .select("id, original_filename")
          .eq("tenant_id", tenantId)
          .eq("content_hash", contentHash)
          .maybeSingle();
        if (existingByHash) {
          fs.unlink(req.file.path, () => {});
          return res.status(409).json({
            error: `This document has already been uploaded (it matches "${existingByHash.original_filename}"). If you want to replace it, use the "Replaces" dropdown and select the existing version.`
          });
        }
      }

      // Build structured filename: "Document Type - Description.ext"
      const description          = (req.body.description          || "").trim();
      const document_type        = (req.body.document_type        || "Other").trim();
      const effective_date       = (req.body.effective_date       || null) || null;
      const expiry_date          = (req.body.expiry_date          || null) || null;
      const tagsRaw              = (req.body.tags                 || "").trim();
      const juniorAccess         = req.body.junior_accessible !== "false";
      const audience             = (req.body.audience             || "Everyone").trim();
      const replacesDocumentId   = (req.body.replaces_document_id || "").trim() || null;
      const ext            = req.file.originalname.split(".").pop().toLowerCase();
      // Strip characters invalid in Supabase Storage keys (apostrophes, quotes, etc.)
      const safePart       = (s) => s
        .replace(/[\/\\:*?"<>|'`]/g, "")   // remove invalid/problematic chars
        .replace(/\s+/g, "-")              // spaces → hyphens
        .replace(/-{2,}/g, "-")            // collapse multiple hyphens
        .replace(/^-|-$/g, "")             // trim leading/trailing hyphens
        .trim()
        .slice(0, 80);                     // cap length
      const structuredName = description
        ? `${safePart(document_type)} - ${safePart(description)}.${ext}`
        : req.file.originalname;
      const tags           = tagsRaw
        ? tagsRaw.split(",").map(t => t.trim()).filter(Boolean).concat(["portal-upload"])
        : ["portal-upload"];

      const storagePath = `tenant-docs/${tenantId}/${Date.now()}-${structuredName}`;
      const fileBuffer = fs.readFileSync(req.file.path);

      const { error: uploadError } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(storagePath, fileBuffer, { contentType: req.file.mimetype, upsert: false });

      if (uploadError) {
        console.error("[portal-upload] Storage error:", uploadError);
        // Continue anyway — store record without storage path
      }

      // ── If replacing an existing document — delete it first ────────────────
      if (replacesDocumentId) {
        try {
          const { data: oldDoc } = await supabase.from("documents").select("id, storage_path, tenant_id").eq("id", replacesDocumentId).eq("tenant_id", tenantId).maybeSingle();
          if (oldDoc) {
            await supabase.from("knowledge_chunks").delete().eq("document_id", oldDoc.id);
            await supabase.from("documents").delete().eq("id", oldDoc.id);
            if (oldDoc.storage_path) {
              await supabase.storage.from(SUPABASE_BUCKET).remove([oldDoc.storage_path]).catch(() => {});
            }
            console.log(`[portal-upload] Replaced document ${oldDoc.id} for ${tenantId}`);
          }
        } catch (replaceErr) {
          console.error("[portal-upload] Replace error:", replaceErr.message);
          // Non-fatal — continue with upload
        }
      }

      const { data: doc, error: docError } = await supabase
        .from("documents")
        .insert({
          original_filename: structuredName,
          stored_filename:   structuredName,
          storage_path:      uploadError ? null : storagePath,
          mimetype:          req.file.mimetype,
          lender:            null,
          document_type:     document_type,
          description:       description || structuredName,
          effective_date:    effective_date ? `${effective_date}-01` : null,
          expiry_date:       expiry_date   ? `${expiry_date}-01`   : null,
          tags:              tags,
          audience:          audience,
          metadata_complete: true,
          junior_accessible: juniorAccess,
          content_hash:      contentHash,
          tenant_id:         tenantId
        })
        .select()
        .single();

      fs.unlink(req.file.path, () => {});

      if (docError) {
        console.error("[portal-upload] Doc insert error:", docError);
        return res.status(500).json({ error: "Failed to save document record." });
      }

      const textToEmbed = await rewriteForRetrieval(extractedText, document_type);
      await generateAndStoreChunks(doc.id, textToEmbed, null, document_type, null, tenantId, { title: description || structuredName });

      res.json({ success: true, document: { id: doc.id, name: structuredName } });
    } catch (err) {
      console.error("[portal-upload] Error:", err.message);
      if (req.file) fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: "Upload failed. Please try again." });
    }
  }
);

// DELETE /api/portal/documents/:id — delete a single uploaded document + chunks
app.delete("/api/portal/documents/:id", requireTenant, async (req, res) => {
  try {
    const { id } = req.params;
    // Verify it belongs to this tenant
    const { data: doc } = await supabase.from("documents").select("id, storage_path, tenant_id").eq("id", id).maybeSingle();
    if (!doc || doc.tenant_id !== req.tenant.tenantId) return res.status(404).json({ error: "Document not found." });

    await supabase.from("knowledge_chunks").delete().eq("document_id", id);
    if (doc.storage_path) await supabase.storage.from(SUPABASE_BUCKET).remove([doc.storage_path]).catch(() => {});
    await supabase.from("documents").delete().eq("id", id);

    res.json({ success: true });
  } catch (err) {
    console.error("[portal-delete] Error:", err.message);
    res.status(500).json({ error: "Failed to delete document." });
  }
});

// DELETE /api/portal/website — delete all pages crawled from a given domain
app.delete("/api/portal/website", requireTenant, async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: "domain required" });

    const { data: docs } = await supabase.from("documents")
      .select("id, storage_path")
      .eq("tenant_id", req.tenant.tenantId)
      .eq("document_type", "Website Content")
      .ilike("storage_path", `%${domain}%`);

    if (!docs || !docs.length) return res.json({ success: true, removed: 0 });

    const ids = docs.map(d => d.id);
    await supabase.from("knowledge_chunks").delete().in("document_id", ids);
    await supabase.from("documents").delete().in("id", ids);

    res.json({ success: true, removed: ids.length });
  } catch (err) {
    console.error("[portal-delete-website] Error:", err.message);
    res.status(500).json({ error: "Failed to remove website." });
  }
});

// POST /api/portal/knowledge-documents/paste — save pasted text as a knowledge document (senior only)
app.post("/api/portal/knowledge-documents/paste", requireSeniorTenant, async (req, res) => {
  try {
    const { title, text } = req.body;
    if (!title || !text) return res.status(400).json({ error: "Title and text are required" });
    const tenantId = req.tenant.tenantId;

    const { data: doc, error } = await supabase
      .from("documents")
      .insert({
        original_filename: `${title.trim()}.txt`,
        stored_filename:   `${title.trim()}.txt`,
        storage_path:      null,
        mimetype:          "text/plain",
        document_type:     "Pasted Knowledge",
        description:       title.trim(),
        tags:              ["pasted"],
        metadata_complete: true,
        junior_accessible: true,
        tenant_id:         tenantId
      })
      .select()
      .single();

    if (error) {
      console.error("[portal-paste] Insert error:", error);
      return res.status(500).json({ error: "Failed to save knowledge" });
    }

    await generateAndStoreChunks(doc.id, text.trim(), null, "Pasted Knowledge", null, tenantId, { title: title.trim() });
    res.json({ success: true, document: { id: doc.id, name: doc.original_filename } });
  } catch (err) {
    console.error("[portal-paste] Error:", err.message);
    res.status(500).json({ error: "Failed to save knowledge" });
  }
});

// POST /api/portal/import-website — crawl a website URL for this tenant (senior only)
// When re-importing an existing domain, this first deletes all pages for that
// specific domain (scoped — never touches other domains), then re-crawls fresh.
app.post("/api/portal/import-website", requireSeniorTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  // Normalize: add https:// if no protocol present
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  let rootUrl, domain;
  try {
    rootUrl = new URL(url).href.replace(/\/$/, "");
    domain  = new URL(rootUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch { return res.status(400).json({ error: "Invalid URL" }); }

  // Blocklist check
  if (BLOCKED_DOMAINS.has(domain)) {
    return res.status(400).json({ error: "That website can't be imported into Sprimal. Please use your own business website." });
  }

  // Block if a crawl for this tenant is already running
  const existing = crawlProgressMap.get(tenantId);
  if (existing && !existing.done) {
    return res.status(409).json({ error: "A crawl is already in progress — please wait for it to finish." });
  }

  // Respond immediately — crawl runs in background
  res.json({ success: true, message: "Import started — this takes 2–3 minutes." });

  (async () => {
    try {
      // ── Fetch tenant business type for crawl prioritisation ─────────────────
      const { data: tenantRow } = await supabase
        .from("tenants")
        .select("business_type")
        .eq("id", tenantId)
        .maybeSingle();
      const bizType = tenantRow?.business_type || null;

      // ── Crawl FIRST — old docs stay visible until new ones are ready ─────────
      // This prevents the website from disappearing from the KB list during crawl.
      console.log(`[portal-import] Starting crawl for ${tenantId}: ${rootUrl} (biz: ${bizType || "unknown"})`);
      setCrawlProgress(tenantId, 5, `Scanning ${domain}…`);
      const pages = await crawlWebsite(rootUrl, 80, (count) => {
        const pct = 5 + Math.round((count / 80) * 60);
        setCrawlProgress(tenantId, Math.min(pct, 65), `${count} page${count === 1 ? "" : "s"} scanned…`);
      }, bizType);
      console.log(`[portal-import] Crawled ${pages.length} pages for ${tenantId}`);

      // ── Now delete old pages — crawl is done, gap is milliseconds not minutes ─
      setCrawlProgress(tenantId, 66, "Updating knowledge base…");
      const { data: existingDocs } = await supabase
        .from("documents")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("document_type", "Website Content")
        .ilike("storage_path", `%${domain}%`);

      if (existingDocs?.length) {
        const oldIds = existingDocs.map(d => d.id);
        await supabase.from("knowledge_chunks").delete().in("document_id", oldIds);
        await supabase.from("documents").delete().in("id", oldIds);
        console.log(`[portal-import] Cleared ${oldIds.length} old pages for ${domain} (${tenantId})`);
      }

      // ── Save new pages ───────────────────────────────────────────────────────
      setCrawlProgress(tenantId, 68, `Saving ${pages.length} pages to your knowledge base…`);
      let imported = 0;
      for (const page of pages) {
        if (imported >= CRAWL_QUOTA_DOCS) {
          console.log(`[portal-import] Quota reached (${CRAWL_QUOTA_DOCS} docs) for ${tenantId} — stopping`);
          break;
        }
        if (!isUsefulPageContent(page.title, page.text, page.url)) {
          console.log(`[portal-import] Skipping noise page: "${page.title}" (${page.text?.length || 0} chars)`);
          continue;
        }
        try {
          const { data: doc, error: insertError } = await supabase
            .from("documents")
            .insert({
              original_filename: page.title,
              stored_filename:   page.url,
              mimetype:          "text/html",
              document_type:     "Website Content",
              tags:              ["website"],
              metadata_complete: true,
              junior_accessible: true,
              storage_path:      page.url,
              tenant_id:         tenantId
            })
            .select().single();
          if (insertError) { console.error(`[portal-import] Insert error:`, insertError.message); continue; }
          await generateAndStoreChunks(doc.id, page.text, null, "Website Content", null, tenantId, { title: page.title || page.url });
          imported++;
          const savePct = 68 + Math.round((imported / pages.length) * 28);
          setCrawlProgress(tenantId, Math.min(savePct, 96), `Saving page ${imported} of ${pages.length}…`);
        } catch (err) {
          console.error(`[portal-import] Page error:`, err.message);
        }
      }
      console.log(`[portal-import] Done — imported ${imported} pages for ${tenantId}`);

      // Re-run Instagram detection + image extraction so re-import fully refreshes the site
      try {
        const { data: tMeta } = await supabase.from("tenants").select("name, instagram_handle, facebook_url, twitter_handle, social_images, business_type").eq("id", tenantId).maybeSingle();

        // Extract social links from crawled homepage HTML
        const homepagePage = pages.find(p => { try { return new URL(p.url).pathname.replace(/\/$/,"") === ""; } catch { return false; } }) || pages[0];
        if (homepagePage?.html) {
          const socialUpdate = {};
          const igM = homepagePage.html.match(/https?:\/\/(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]{2,30})\/?/);
          if (igM && !tMeta?.instagram_handle && !["p","reel","reels","explore","tv"].includes(igM[1].toLowerCase()))
            socialUpdate.instagram_handle = igM[1].replace(/\/$/, "");
          const fbM = homepagePage.html.match(/https?:\/\/(?:www\.)?facebook\.com\/([a-zA-Z0-9_.%-]{2,60})\/?(?:["'\s])/);
          if (fbM && !tMeta?.facebook_url && !["sharer","share","login","groups","events","pages"].includes(fbM[1].toLowerCase()))
            socialUpdate.facebook_url = `https://facebook.com/${fbM[1]}`;
          const twM = homepagePage.html.match(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([a-zA-Z0-9_]{2,40})\/?(?:["'\s])/);
          if (twM && !tMeta?.twitter_handle && !["share","intent","home","search"].includes(twM[1].toLowerCase()))
            socialUpdate.twitter_handle = twM[1];
          if (Object.keys(socialUpdate).length > 0) {
            await supabase.from("tenants").update(socialUpdate).eq("id", tenantId);
            console.log(`[portal-import] Social links:`, socialUpdate);
            Object.assign(tMeta, socialUpdate);
          }
        }

        // Business type — re-detect if still "other" or missing
        if (!tMeta?.business_type || tMeta.business_type === "other") {
          const allText = pages.map(p => p.text).join(" ").slice(0, 2000);
          const bizType = await detectBusinessType(tMeta?.name || "", tMeta?.business_description || "", allText);
          await supabase.from("tenants").update({ business_type: bizType }).eq("id", tenantId);
          console.log(`[portal-import] Business type set: ${bizType}`);
        }

        // Instagram handle
        if (!tMeta?.instagram_handle) {
          setCrawlProgress(tenantId, 96, "Looking for your Instagram profile…");
          const detected = await detectInstagramHandle(tMeta?.name || "", pages);
          if (detected) {
            await supabase.from("tenants").update({ instagram_handle: detected.handle }).eq("id", tenantId);
            console.log(`[portal-import] Instagram handle: @${detected.handle} (${detected.confidence.toFixed(2)})`);
            const thumbnails = await fetchInstagramThumbnails(detected.handle, tenantId, 9);
            if (thumbnails.length >= 1) {
              await supabase.from("tenants").update({ social_images: JSON.stringify(thumbnails) }).eq("id", tenantId);
            }
          }
        }

        // Twitter photos — always runs alongside IG if handle exists
        const twHandle = tMeta?.twitter_handle;
        if (twHandle) {
          setCrawlProgress(tenantId, 97, `Fetching photos from Twitter (@${twHandle})…`);
          const twPhotos = await fetchTwitterPhotos(twHandle, tenantId, 6);
          if (twPhotos.length > 0) {
            const afterIg = (() => { try { return JSON.parse(tMeta?.social_images) || []; } catch { return []; } })();
            const nonTw = afterIg.filter(u => !/\/tw_\d+\./.test(u));
            const combined = [...nonTw, ...twPhotos].slice(0, 15);
            await supabase.from("tenants").update({ social_images: JSON.stringify(combined) }).eq("id", tenantId);
            Object.assign(tMeta, { social_images: JSON.stringify(combined) });
            console.log(`[portal-import] Added ${twPhotos.length} Twitter photos for ${tenantId}`);
          }
        }

        // Website images — fill up to 15 total (IG up to 9 + Twitter up to 6)
        const currentImages = (() => { try { return JSON.parse(tMeta?.social_images) || []; } catch { return []; } })();
        const needed = 15 - currentImages.length;
        if (needed > 0) {
          setCrawlProgress(tenantId, 97, "Gathering photos from your website…");
          const siteImages = await extractAndRehostWebsiteImages(pages, tenantId, needed);
          if (siteImages.length > 0) {
            const combined = [...currentImages, ...siteImages].slice(0, 15);
            await supabase.from("tenants").update({ social_images: JSON.stringify(combined) }).eq("id", tenantId);
            console.log(`[portal-import] Stored ${combined.length} total images`);
          }
        }

        // Logo fallback — if still no images, rehost the logo as a gallery photo
        try {
          const { data: imgCheck } = await supabase.from("tenants").select("social_images, logo_url").eq("id", tenantId).maybeSingle();
          let imgs = [];
          try { imgs = JSON.parse(imgCheck?.social_images) || []; } catch {}
          if (imgs.length < 3 && imgCheck?.logo_url) {
            const r = await fetch(imgCheck.logo_url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) });
            if (r.ok) {
              const ct = r.headers.get("content-type") || "";
              if (ct.startsWith("image/")) {
                const buf = Buffer.from(await r.arrayBuffer());
                if (buf.length >= 5000) {
                  const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
                  const storagePath = `${tenantId}/logo_fallback.${ext}`;
                  const { error } = await supabase.storage.from("social-images").upload(storagePath, buf, { contentType: ct, upsert: true });
                  if (!error) {
                    const { data: { publicUrl } } = supabase.storage.from("social-images").getPublicUrl(storagePath);
                    const combined = [...imgs, publicUrl].slice(0, 9);
                    await supabase.from("tenants").update({ social_images: JSON.stringify(combined) }).eq("id", tenantId);
                    console.log(`[portal-import] Added logo as image fallback for ${tenantId} (now ${combined.length} total)`);
                  }
                }
              }
            }
          }
        } catch (e) { console.log(`[portal-import] Logo fallback failed: ${e.message}`); }
      } catch (e) {
        console.error(`[portal-import] Post-import enrichment error:`, e.message);
      }

      await supabase.from("tenants").update({ last_crawl_at: new Date().toISOString(), last_crawl_pages: imported }).eq("id", tenantId);
      setCrawlProgress(tenantId, 100, `✅ Done — ${imported} page${imported === 1 ? "" : "s"} imported`, true);
    } catch (err) {
      console.error(`[portal-import] Crawl failed for ${tenantId}:`, err.message);
      setCrawlProgress(tenantId, 100, "⚠️ Re-import encountered an error — please try again", true);
    }
  })();
});

// GET /api/portal/status — returns doc + chunk counts for the tenant (used by dashboard progress UI)
app.get("/api/portal/status", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;

    const [{ count: docCount }, { count: chunkCount }, { data: tenantRow }] = await Promise.all([
      supabase.from("documents").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
      supabase.from("knowledge_chunks").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
      supabase.from("tenants").select("status").eq("id", tenantId).maybeSingle()
    ]);

    res.json({
      docCount:     docCount   || 0,
      chunkCount:   chunkCount || 0,
      tenantStatus: tenantRow?.status || null
    });
  } catch (err) {
    console.error("[portal-status] Error:", err.message);
    res.status(500).json({ error: "Failed to fetch status." });
  }
});

// ── Analytics helpers ─────────────────────────────────────────────────────────
function classifyTopic(message) {
  const m = (message || "").toLowerCase();
  if (/\b(book|appointment|slot|schedule|visit|consultation|booking)\b/.test(m))         return "Bookings";
  if (/\b(mortgage|loan|deposit|rate|lender|broker|property|buy|purchase|remortgage)\b/.test(m)) return "Mortgages";
  if (/\b(price|cost|fee|membership|join|sign.?up|enrol|enroll|subscribe|plan|package)\b/.test(m)) return "Pricing & Membership";
  if (/\b(hour|open|close|opening|closing|time|when|today|tomorrow|weekend)\b/.test(m))   return "Opening Hours";
  if (/\b(contact|phone|call|email|address|location|directions?|where|find us)\b/.test(m)) return "Contact & Location";
  if (/\b(cancel|refund|change|update|edit|reschedule|postpone)\b/.test(m))               return "Cancellations";
  if (/\b(class|course|session|programme|program|timetable|roster)\b/.test(m))            return "Classes & Schedule";
  return "General Enquiry";
}

function buildAnalytics(rows) {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);

  // Group messages into conversations keyed by conversation_id
  const convMap = {};
  (rows || []).forEach(row => {
    const key = row.conversation_id || ("msg-" + row.id);
    if (!convMap[key]) convMap[key] = { messages: [], firstAt: row.created_at };
    convMap[key].messages.push(row);
    if (row.created_at < convMap[key].firstAt) convMap[key].firstAt = row.created_at;
  });
  const convs = Object.values(convMap);

  // Conversations today
  const todayCount = convs.filter(c => new Date(c.firstAt) >= todayStart).length;

  // 7-day trend
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(now); dayStart.setDate(dayStart.getDate() - i); dayStart.setHours(0, 0, 0, 0);
    const dayEnd   = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const label    = i === 0 ? "Today" : dayStart.toLocaleDateString("en-IE", { weekday: "short" });
    const count    = convs.filter(c => { const d = new Date(c.firstAt); return d >= dayStart && d < dayEnd; }).length;
    trend.push({ label, count });
  }

  // Avg messages per conversation
  const totalMessages = convs.reduce((sum, c) => sum + c.messages.length, 0);
  const avgMessages   = convs.length ? Math.round((totalMessages / convs.length) * 10) / 10 : 0;

  // Top topics — classify first customer message per conversation
  const topicCounts = {};
  convs.forEach(c => {
    const customerMsg = c.messages.find(m => m.sender === "customer");
    if (customerMsg) {
      const topic = classifyTopic(customerMsg.message);
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    }
  });
  const topTopics = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => ({ topic, count }));

  // Answer rate — bot messages only
  const botMsgs     = (rows || []).filter(r => r.sender === "bot" && r.answer_source);
  const answeredCount = botMsgs.filter(r => ["kb","approved","ebo"].includes(r.answer_source)).length;
  const fallbackCount = botMsgs.filter(r => r.answer_source === "generic").length;
  const answerRate  = (answeredCount + fallbackCount) > 0
    ? Math.round((answeredCount / (answeredCount + fallbackCount)) * 100)
    : null;

  return { todayCount, totalConversations: convs.length, avgMessages, trend, topTopics, answeredCount, fallbackCount, answerRate };
}

// ── Portal: analytics ─────────────────────────────────────────────────────────
app.get("/api/portal/analytics", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const since = new Date(); since.setDate(since.getDate() - 30);

    const { data: rows, error } = await supabase
      .from("chat_logs")
      .select("id, conversation_id, sender, message, answer_source, created_at")
      .eq("tenant_id", tenantId)
      .gte("created_at", since.toISOString());

    if (error) throw error;
    res.json(buildAnalytics(rows));
  } catch (err) {
    console.error("[portal-analytics]", err.message);
    res.status(500).json({ error: "Failed to fetch analytics." });
  }
});

// ── Admin: analytics (all tenants, optional filter) ───────────────────────────
app.get("/api/admin/analytics", requireAdmin, async (req, res) => {
  try {
    const { tenantId } = req.query;
    const since = new Date(); since.setDate(since.getDate() - 30);

    let query = supabase
      .from("chat_logs")
      .select("id, tenant_id, conversation_id, sender, message, created_at")
      .gte("created_at", since.toISOString());
    if (tenantId) query = query.eq("tenant_id", tenantId);

    const { data: rows, error } = await query;
    if (error) throw error;

    const overall = buildAnalytics(rows);

    // Per-tenant breakdown
    const tids = [...new Set((rows || []).map(r => r.tenant_id))];
    const { data: tenantRows } = await supabase
      .from("tenants").select("id, name")
      .in("id", tids.length ? tids : ["__none__"]);
    const tenantNames = {};
    (tenantRows || []).forEach(t => { tenantNames[t.id] = t.name || t.id; });

    const tenantBuckets = {};
    (rows || []).forEach(row => {
      if (!tenantBuckets[row.tenant_id]) tenantBuckets[row.tenant_id] = [];
      tenantBuckets[row.tenant_id].push(row);
    });
    overall.byTenant = Object.entries(tenantBuckets)
      .map(([tid, trows]) => ({ tenantId: tid, tenantName: tenantNames[tid] || tid, ...buildAnalytics(trows) }))
      .sort((a, b) => b.totalConversations - a.totalConversations);

    const { data: allTenants } = await supabase.from("tenants").select("id, name").order("name", { ascending: true });
    overall.tenants = allTenants || [];

    res.json(overall);
  } catch (err) {
    console.error("[admin-analytics]", err.message);
    res.status(500).json({ error: "Failed to fetch analytics." });
  }
});

// ── Admin: retrieval telemetry ────────────────────────────────────────────────
app.get("/api/admin/retrieval-events", requireAdmin, async (req, res) => {
  try {
    const { tenantId, limit = 100 } = req.query;
    let query = supabase
      .from("retrieval_events")
      .select("id, tenant_id, conversation_id, query, expanded_queries, chunks_returned, similarity_scores, has_uploaded_docs, created_at")
      .order("created_at", { ascending: false })
      .limit(Math.min(parseInt(limit, 10) || 100, 500));
    if (tenantId) query = query.eq("tenant_id", tenantId);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("[admin-retrieval-events]", err.message);
    res.status(500).json({ error: "Failed to fetch retrieval events." });
  }
});

// ── Admin: list all tenants ───────────────────────────────────────────────────
app.get("/api/admin/tenants", requireAdmin, async (req, res) => {
  try {
    const [{ data: tenants, error }, { data: docCounts }, { data: chunkCounts }] = await Promise.all([
      supabase
        .from("tenants")
        .select("id, name, email, website, status, portal_password, brand_color, created_at")
        .order("created_at", { ascending: false }),
      supabase
        .from("documents")
        .select("tenant_id, id", { count: "exact" }),
      supabase
        .from("knowledge_chunks")
        .select("tenant_id, id", { count: "exact" })
    ]);

    if (error) throw error;

    // Build lookup maps: tenantId → count
    const docMap   = {};
    const chunkMap = {};
    (docCounts   || []).forEach(r => { docMap[r.tenant_id]   = (docMap[r.tenant_id]   || 0) + 1; });
    (chunkCounts || []).forEach(r => { chunkMap[r.tenant_id] = (chunkMap[r.tenant_id] || 0) + 1; });

    const result = (tenants || []).map(t => ({
      ...t,
      docCount:   docMap[t.id]   || 0,
      chunkCount: chunkMap[t.id] || 0
    }));

    res.json(result);
  } catch (err) {
    console.error("[admin-tenants]", err.message);
    res.status(500).json({ error: "Failed to fetch tenants." });
  }
});

// ── Admin: reset a tenant's portal password ───────────────────────────────────
app.post("/api/admin/tenants/:id/reset-password", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const newPassword = crypto.randomBytes(5).toString("hex"); // 10-char hex
    const { error } = await supabase
      .from("tenants")
      .update({ portal_password: newPassword })
      .eq("id", id);
    if (error) throw error;
    console.log(`[admin] Portal password reset for tenant: ${id}`);
    res.json({ success: true, password: newPassword });
  } catch (err) {
    console.error("[admin-reset-password]", err.message);
    res.status(500).json({ error: "Failed to reset password." });
  }
});

// ── Admin: delete tenant + all associated data ───────────────────────────────
app.delete("/api/admin/tenants/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "Missing tenant id." });
  try {
    // Delete workflow choices first (depend on steps), then steps (depend on workflows), then workflows
    const { data: workflows } = await supabase.from("chat_workflows").select("id").eq("club_id", id);
    if (workflows && workflows.length > 0) {
      const workflowIds = workflows.map(w => w.id);
      const { data: wfSteps } = await supabase.from("workflow_steps").select("id").in("workflow_id", workflowIds);
      if (wfSteps && wfSteps.length > 0) {
        const stepIds = wfSteps.map(s => s.id);
        await supabase.from("workflow_choices").delete().in("step_id", stepIds);
      }
      await supabase.from("workflow_steps").delete().in("workflow_id", workflowIds);
      await supabase.from("chat_workflows").delete().eq("club_id", id);
    }

    const steps = [
      supabase.from("approved_answers").delete().eq("tenant_id", id),
      supabase.from("chat_logs").delete().eq("tenant_id", id),
      supabase.from("documents").delete().eq("tenant_id", id),
      supabase.from("flagged_answers").delete().eq("tenant_id", id),
      supabase.from("knowledge_chunks").delete().eq("tenant_id", id),
      supabase.from("membership_requests").delete().eq("tenant_id", id),
      supabase.from("portal_users").delete().eq("tenant_id", id),
      supabase.from("skill_leads").delete().eq("tenant_id", id),
      supabase.from("tenant_integrations").delete().eq("tenant_id", id),
      supabase.from("tenant_agents").delete().eq("tenant_id", id),
    ];
    await Promise.all(steps);
    const { error } = await supabase.from("tenants").delete().eq("id", id);
    if (error) throw error;
    console.log(`[admin] Tenant deleted: ${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin-delete-tenant]", err.message);
    res.status(500).json({ error: "Failed to delete tenant: " + err.message });
  }
});

// ── Admin: update Instagram handle for any tenant ────────────────────────────
app.post("/api/admin/tenants/:id/instagram", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { instagram_handle } = req.body;
  const handle = (instagram_handle || "").replace(/^@/, "").trim();
  if (!handle) return res.status(400).json({ error: "Handle required" });
  try {
    const { error } = await supabase.from("tenants").update({ instagram_handle: handle }).eq("id", id);
    if (error) throw error;
    console.log(`[admin] Instagram handle set for ${id}: @${handle}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: update brand colour for any tenant ────────────────────────────────
app.post("/api/admin/tenants/:id/brand-color", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { color } = req.body;
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: "Invalid hex color" });
  try {
    const { error } = await supabase.from("tenants").update({ brand_color: color }).eq("id", id);
    if (error) throw error;
    console.log(`[admin] Brand color updated for ${id}: ${color}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: trigger a fresh crawl for any tenant ──────────────────────────────
app.post("/api/admin/tenants/:id/crawl", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: tenant } = await supabase.from("tenants").select("id, name, website").eq("id", id).maybeSingle();
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });
    if (!tenant.website) return res.status(400).json({ error: "No website URL on file for this tenant" });
    // Delete existing website-crawled docs so re-crawl starts clean
    const { data: existingDocs } = await supabase.from("documents").select("id").eq("tenant_id", id).eq("document_type", "Website Content");
    if (existingDocs && existingDocs.length > 0) {
      const docIds = existingDocs.map(d => d.id);
      await supabase.from("knowledge_chunks").delete().in("document_id", docIds);
      await supabase.from("documents").delete().in("id", docIds);
    }
    startBackgroundCrawl({ tenantId: tenant.id, name: tenant.name, website: tenant.website });
    console.log(`[admin] Crawl triggered for ${id} (${tenant.name}) by admin`);
    res.json({ ok: true, message: `Crawl started for ${tenant.name} — watch Render logs for [crawler] output` });
  } catch (err) {
    console.error("[admin-crawl]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: backfill email context from Gmail inbox ────────────────────────────
// One-off endpoint to process historical emails through the context pipeline.
// Responds immediately — processing runs in background. Watch Render logs.
// GET /api/admin/backfill-email-context?days=2
app.get("/api/admin/backfill-email-context", requireAdmin, async (req, res) => {
  const days = Math.min(parseInt(req.query.days || "2", 10), 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  res.json({ success: true, message: `Backfill started for emails since ${since.toDateString()}. Watch Render logs for progress.` });

  // ── Fire and forget ────────────────────────────────────────────────────────
  (async () => {
    console.log(`[backfill] Starting email context backfill since ${since.toDateString()}`);
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      console.error("[backfill] Gmail credentials not set — aborting");
      return;
    }

    let processed = 0, skipped = 0, errors = 0;

    try {
      const client = makeImapClient();
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      let rawMessages = [];

      try {
        // Search all messages (read + unread) since the given date
        const uids = await client.search({ since }, { uid: true });
        console.log(`[backfill] Found ${uids.length} emails since ${since.toDateString()}`);

        if (uids.length > 0) {
          for await (const msg of client.fetch(uids.join(","), { source: true, uid: true }, { uid: true })) {
            rawMessages.push({ uid: msg.uid, source: Buffer.from(msg.source) });
          }
        }
      } finally {
        lock.release();
        try { await client.logout(); } catch (_) {}
      }

      // Sort oldest first so state builds up in chronological order
      rawMessages.sort((a, b) => a.uid - b.uid);
      console.log(`[backfill] Processing ${rawMessages.length} emails oldest-first...`);

      for (const { uid, source } of rawMessages) {
        try {
          const parsed  = await simpleParser(source);
          const from    = parsed.from?.text || "Unknown";
          const subject = parsed.subject    || "(no subject)";
          const body    = parsed.text       || parsed.html || "";

          // Skip system loop emails
          if (subject.startsWith("Draft reply:")) { skipped++; continue; }
          // Skip emails sent FROM the monitored inbox (outbound)
          const fromAddr = (from.match(/<([^>]+)>/) || [])[1] || from;
          if (fromAddr.toLowerCase() === (process.env.GMAIL_USER || "").toLowerCase()) { skipped++; continue; }

          // Run context pipeline — no reply generation
          const cleanedBody  = deduplicateEmailBody(body);
          const entities     = await extractEmailEntities(cleanedBody, from, subject);
          const backfillAddr = (from.match(/<([^>]+)>/) || [])[1] || from;
          const backfillIsStaff = CONTEXT_ONLY_DOMAINS.some(d => backfillAddr.toLowerCase().endsWith(d))
                               || CONTEXT_ONLY_ADDRESSES.includes(backfillAddr.toLowerCase());
          const state       = await findOrCreateApplicationState(from, entities, backfillIsStaff);
          if (!state) { skipped++; continue; } // noise gate — no mortgage signal
          await updateApplicationState(state, entities, cleanedBody, from, subject);

          processed++;
          if (processed % 10 === 0) {
            console.log(`[backfill] Progress: ${processed} processed, ${skipped} skipped, ${errors} errors (of ${rawMessages.length} total)`);
          }

          // Small delay to avoid hammering the LLM API
          await new Promise(r => setTimeout(r, 300));

        } catch (err) {
          errors++;
          console.warn(`[backfill] Error on uid ${uid}: ${err.message}`);
        }
      }

      console.log(`[backfill] Complete — ${processed} processed, ${skipped} skipped, ${errors} errors`);

    } catch (err) {
      console.error(`[backfill] Fatal error: ${err.message}`);
    }
  })();
});

// ── Portal: Mortgage Application Tracker (AOM tenant only) ───────────────────
app.get("/api/portal/mortgage-applications", requireTenant, async (req, res) => {
  if (!process.env.AOM_TENANT_ID || req.tenant.tenantId !== process.env.AOM_TENANT_ID) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const { data, error } = await supabase
    .from("mortgage_application_states")
    .select("id, borrower_name, co_borrower_name, client_email, application_ref, lender, current_phase, borrower_type, loan_amount, property_address, updated_at")
    .order("updated_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ applications: data || [] });
});

app.put("/api/portal/mortgage-applications/:id", requireTenant, async (req, res) => {
  if (!process.env.AOM_TENANT_ID || req.tenant.tenantId !== process.env.AOM_TENANT_ID) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "Missing application id." });
  const allowed = ["borrower_name","co_borrower_name","client_email","application_ref","lender","current_phase","borrower_type","loan_amount","property_address","manual_notes"];
  const updates = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: "No valid fields to update." });
  const { data, error } = await supabase
    .from("mortgage_application_states")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ application: data });
});

// ── Portal: Delete Mortgage Application ──────────────────────────────────────
app.delete("/api/portal/mortgage-applications/:id", requireTenant, async (req, res) => {
  if (!process.env.AOM_TENANT_ID || req.tenant.tenantId !== process.env.AOM_TENANT_ID) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "Missing application id." });
  try {
    await supabase.from("application_events").delete().eq("application_id", id);
    const { error } = await supabase.from("mortgage_application_states").delete().eq("id", id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete application: " + err.message });
  }
});

// ── Portal: Mortgage Application Details + AI Next Action ────────────────────
app.get("/api/portal/mortgage-applications/:id/details", requireTenant, async (req, res) => {
  if (!process.env.AOM_TENANT_ID || req.tenant.tenantId !== process.env.AOM_TENANT_ID) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const { id } = req.params;
  const { data: app, error } = await supabase
    .from("mortgage_application_states")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !app) return res.status(404).json({ error: "Application not found." });

  const LENDER_LABELS = { aib:"AIB", avant:"Avant Money", bank_of_ireland:"Bank of Ireland", ebs:"EBS", haven:"Haven", irishlife:"Irish Life", nua:"Nua Money", ptsb:"PTSB" };
  const PHASE_LABELS  = { initial_enquiry:"Initial Enquiry", aip:"AIP", full_application:"Full Application", underwriting:"Underwriting", letter_of_offer:"Letter of Offer", drawdown:"Drawdown" };

  const stateUpdates = {};

  // ── Auto-load checklist if none exists yet ────────────────────────────────
  // If lender + borrower_type are both known, load the specific checklist and persist it.
  // Otherwise fall back to the generic checklist for display only (not persisted),
  // so Cormac always sees something useful even for brand-new clients.
  if (!(app.missing_documents?.length)) {
    const specificChecklist = getLenderChecklist(app.lender, app.borrower_type);
    const checklist = specificChecklist || GENERIC_CHECKLIST;
    const already = app.received_documents || [];
    const filtered = checklist.filter(
      doc => !already.some(r => r.toLowerCase().includes(doc.toLowerCase().split(" ")[0]))
    );
    app.missing_documents = filtered; // always update the in-memory app for this response
    if (specificChecklist) {
      // Only persist when we have a real lender-specific checklist
      stateUpdates.missing_documents = filtered;
      console.log(`[mortgage-details] Auto-loaded checklist for ${app.lender}/${app.borrower_type}: ${filtered.length} items`);
    } else {
      console.log(`[mortgage-details] Using generic checklist for display (lender/borrower_type not yet set): ${filtered.length} items`);
    }
  }

  // ── Persist any fast updates (checklist) before AI work ─────────────────────
  if (Object.keys(stateUpdates).length) {
    await supabase.from("mortgage_application_states").update(stateUpdates).eq("id", id);
  }

  const usingGenericDocs = !app.lender || !app.borrower_type;

  // ── Quick mode — return stored data immediately, no AI calls ─────────────────
  // The client fetches this first (?quick=1) to populate the modal fast, then fires
  // a second request without the flag to get the AI recommendation in the background.
  if (req.query.quick === "1") {
    return res.json({ application: app, next_action: null, checklist_is_generic: usingGenericDocs });
  }

  // ── Auto-generate running summary if none exists ───────────────────────────
  if (!app.running_summary) {
    try {
      const summaryPrompt =
`You are an assistant for AOM (At Once Mortgages), an Irish mortgage brokerage.
Based on the structured application data below, write a concise 2-4 sentence summary of where this mortgage application stands. Be specific about what is known and what is still outstanding.

Borrower: ${app.borrower_name || "Unknown"}${app.co_borrower_name ? " & " + app.co_borrower_name : ""}
Lender: ${LENDER_LABELS[app.lender] || app.lender || "Not yet determined"}
Phase: ${PHASE_LABELS[app.current_phase] || app.current_phase || "Unknown"}
Borrower Type: ${app.borrower_type || "Unknown"}
Loan Amount: ${app.loan_amount ? "€" + Number(app.loan_amount).toLocaleString("en-IE") : "Unknown"}
Property: ${app.property_address || "Not yet identified"}
Documents Received: ${(app.received_documents || []).join(", ") || "None recorded"}
Documents Outstanding: ${(app.missing_documents || []).join(", ") || "None recorded"}
Broker Notes: ${app.manual_notes || "None"}

Return ONLY the summary text — no labels, no formatting.`;

      const summaryResp = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [{ role: "user", content: summaryPrompt }]
      });
      const generatedSummary = summaryResp.content[0]?.text?.trim() || null;
      if (generatedSummary) {
        app.running_summary = generatedSummary;
        await supabase.from("mortgage_application_states").update({ running_summary: generatedSummary }).eq("id", id);
        console.log(`[mortgage-details] Auto-generated summary for ${app.borrower_name || app.id}`);
      }
    } catch (summaryErr) {
      console.warn("[mortgage-details] Summary generation failed:", summaryErr.message);
    }
  }

  // ── Generate summary + next action in a single call for consistency ──────────
  const docsOutstanding   = (app.missing_documents || []).join(", ") || "None";
  const docsReceived      = (app.received_documents || []).join(", ") || "None recorded";
  const phaseLabel        = PHASE_LABELS[app.current_phase] || app.current_phase || "Unknown";
  const lenderLabel       = LENDER_LABELS[app.lender] || app.lender || "Not yet determined";
  const allDocsIn         = (app.missing_documents || []).length === 0 && (app.received_documents || []).length > 0;
  const lateStage         = ["underwriting","letter_of_offer","drawdown"].includes(app.current_phase);

  let nextAction = null;
  try {
    const prompt =
`You are an expert Irish mortgage advisor for AOM (At Once Mortgages), an Irish mortgage brokerage.

Using ONLY the application data below, produce two things that must be fully consistent with each other.

APPLICATION DATA:
Borrower: ${app.borrower_name || "Unknown"}${app.co_borrower_name ? " & " + app.co_borrower_name : ""}
Lender: ${lenderLabel}
Phase: ${phaseLabel}
Borrower Type: ${app.borrower_type || "Unknown"}
Loan Amount: ${app.loan_amount ? "€" + Number(app.loan_amount).toLocaleString("en-IE") : "Unknown"}
Property: ${app.property_address || "Not yet identified"}
Documents Received: ${docsReceived}
Documents Outstanding: ${docsOutstanding}${usingGenericDocs ? " (generic list — lender/borrower type not yet confirmed)" : ""}
All Documents Complete: ${allDocsIn ? "YES — do not recommend chasing documents" : "NO"}
Late Stage (underwriting/offer/drawdown): ${lateStage ? "YES — application is with lender, focus on lender-side actions" : "NO"}
Conflict Flags: ${(app.conflict_flags || []).join("; ") || "None"}
Email History Summary: ${app.running_summary || "No email history yet."}
Broker Notes (high priority): ${app.manual_notes || "None"}

RULES:
- If All Documents Complete is YES, do NOT recommend collecting or chasing any documents
- If Phase is Underwriting, the application is already with the lender awaiting their review — next action should reflect this
- If Phase is Letter of Offer or Drawdown, focus on those stages
- The summary and next_action must tell the same story — they must not contradict each other
- If the lender or borrower type is "Not yet determined / Unknown", the broker (AOM) should confirm these details with the client as a priority
- If Documents Outstanding shows "(generic list)", note in your summary that the checklist is provisional until the lender is confirmed
- Be specific and practical — avoid vague advice

Return ONLY valid JSON:
{
  "summary": "2-4 sentences describing where this application stands right now, based on the data above",
  "next_action": "The single most important next step to move this application forward",
  "owner": "Client | AOM | Lender",
  "reason": "One sentence explaining why this is the priority action"
}`;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }]
    });
    let text = (response.content[0]?.text || "{}").trim()
      .replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(text);

    // If summary was just generated by the AI, update it in the response
    if (!app.running_summary && parsed.summary) {
      app.running_summary = parsed.summary;
      await supabase.from("mortgage_application_states").update({ running_summary: parsed.summary }).eq("id", id);
    }

    nextAction = { next_action: parsed.next_action, owner: parsed.owner, reason: parsed.reason };
  } catch (err) {
    console.warn("[mortgage-details] AI generation failed:", err.message);
    nextAction = { next_action: "Unable to generate recommendation at this time.", owner: "AOM", reason: "" };
  }

  res.json({ application: app, next_action: nextAction, checklist_is_generic: usingGenericDocs });
});

// ── Portal: LLM-based step suggestion for flow builder "Pull from KB" button ──
// Uses vector search (same as live chat) to find the most relevant KB chunks for
// the current step content, then asks GPT to rewrite using that context.
app.post("/api/portal/kb-suggest-step", requireTenant, async (req, res) => {
  const tenantId       = req.tenant.tenantId;
  const currentContent = (req.body.currentContent || "").trim();
  if (!currentContent) return res.json({ suggestion: null, message: "No content provided." });

  try {
    // Use vector search — finds the most relevant chunks for this step's content
    const relevantDocs = await findRelevantKnowledgeChunks(currentContent, 8, tenantId);
    if (!relevantDocs.length) return res.json({ suggestion: null, message: "No knowledge base content found yet. Try uploading documents to your Knowledge Base first." });

    const combined = relevantDocs.map(d => `Source: ${d.filename}\n${d.text}`).join("\n\n");

    const prompt = [
      "You are updating the message a customer service chatbot says in a specific step of a conversation flow.",
      "The current step message is shown below. Using the knowledge base content provided, rewrite it with accurate, up-to-date information.",
      "Keep the same tone, format and structure as the original. Return ONLY the updated message — no explanation, no labels.",
      "",
      "Current step message:",
      currentContent
    ].join("\n");

    const resp = await openai.chat.completions.create({
      model:       "gpt-4o-mini",
      messages:    [{ role: "system", content: prompt }, { role: "user", content: combined }],
      temperature: 0,
      max_tokens:  500
    });

    const suggestion = (resp.choices[0].message.content || "").trim();
    if (!suggestion) return res.json({ suggestion: null, message: "No relevant content found in your knowledge base." });
    return res.json({ suggestion });
  } catch (e) {
    console.error("[kb-suggest-step] Error:", e.message);
    return res.json({ suggestion: null, message: "Something went wrong. Please try again." });
  }
});

// ── Portal: KB search for flow builder "Pull from KB" button ─────────────────
app.get("/api/portal/kb-search", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const query = (req.query.q || "").trim();
  if (!query) return res.json({ content: null });

  // Stop words to filter out before keyword matching
  const STOP_WORDS = new Set(["a","an","the","and","or","of","to","in","is","it","for","on","our","we","i","at","by","be","as","here","s","per","year","are","have","has","with","this","that","from","up","about","you","your","can","will","do","all","there","so","if","what","how","its","also","my","me","he","she","they","we","was","were","been","had","would","could","should","not","no","yes","some"]);

  // Extract meaningful keywords from the query (words ≥ 3 chars, not stop words)
  const keywords = [...new Set(
    query.toLowerCase()
      .replace(/[^a-z0-9\s€]/g, " ")   // strip emojis, punctuation
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
  )].slice(0, 6);

  if (!keywords.length) return res.json({ content: null });

  try {
    // Search for chunks containing ANY of the keywords — try each and score by matches
    const allChunks = [];
    for (const kw of keywords) {
      const { data } = await supabase
        .from("knowledge_chunks")
        .select("content")
        .eq("tenant_id", tenantId)
        .ilike("content", "%" + kw + "%")
        .limit(5);
      if (data) allChunks.push(...data);
    }

    if (!allChunks.length) return res.json({ content: null });

    // Score each chunk by how many keywords it contains — return the best match
    const scored = allChunks.map(function(c) {
      const lower = c.content.toLowerCase();
      const score = keywords.filter(function(kw) { return lower.includes(kw); }).length;
      return { content: c.content, score };
    });
    scored.sort(function(a, b) { return b.score - a.score; });

    const content = scored[0].content.trim().slice(0, 800);
    return res.json({ content });
  } catch (e) {
    console.error("[KB Search] Error:", e.message);
    return res.json({ content: null });
  }
});

// ── Portal: recent chat logs ──────────────────────────────────────────────────
app.get("/api/portal/chat-logs", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;

    // Fetch last 100 messages for this tenant, newest first
    const { data, error } = await supabase
      .from("chat_logs")
      .select("id, conversation_id, sender, message, answer_source, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;

    // Group into conversations (keyed by conversation_id, or synthetic key if null)
    const convMap = {};
    (data || []).forEach(row => {
      const key = row.conversation_id || ("msg-" + row.id);
      if (!convMap[key]) {
        convMap[key] = { conversationId: row.conversation_id || key, messages: [], startedAt: row.created_at };
      }
      convMap[key].messages.push(row);
      // track earliest message time as start
      if (row.created_at < convMap[key].startedAt) convMap[key].startedAt = row.created_at;
    });

    // Sort conversations newest first, return up to 20
    const conversations = Object.values(convMap)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, 20)
      .map(c => ({
        conversationId: c.conversationId,
        startedAt: c.startedAt,
        messageCount: c.messages.length,
        // messages are newest-first from DB; reverse to show chronologically
        messages: c.messages.slice().reverse().map(m => ({
          sender: m.sender,
          message: m.message,
          answer_source: m.answer_source || null,
          createdAt: m.created_at
        }))
      }));

    res.json({ conversations });
  } catch (err) {
    console.error("[portal-chat-logs] Error:", err.message);
    res.status(500).json({ error: "Failed to fetch chat logs." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Portal: junior staff tools ────────────────────────────────────────────────

// POST /api/portal/knowledge-answer — tenant-scoped KB query for junior staff
app.post("/api/portal/knowledge-answer", requireTenant, async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "question is required" });

  const tenantId   = req.tenant.tenantId;
  const tenantName = req.tenant.tenantName || "your organisation";

  try {
    // 1. Check tenant-scoped approved answers first
    const { data: approvedAnswers } = await supabase
      .from("approved_answers")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });

    // 2. Semantic match against approved answers
    let match = null;
    if ((approvedAnswers || []).length > 0) {
      const semanticMatch = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a semantic matching assistant. Given a question and a list of stored questions, return the INDEX of the best matching stored question if semantically equivalent. Return -1 if no good match. Return ONLY a single integer." },
          { role: "user", content: `Asked: "${question}"\n\nStored:\n${approvedAnswers.map((a, i) => `${i}: ${a.question}`).join("\n")}` }
        ],
        temperature: 0
      });
      const idx = parseInt(semanticMatch.choices[0].message.content.trim());
      if (!isNaN(idx) && idx >= 0 && idx < approvedAnswers.length) match = approvedAnswers[idx];
    }

    if (match) {
      return res.json({ answer: match.answer, source: "Approved Answer", confidence: "High", sourceDetail: match.category || "Team approved" });
    }

    // 3. Fall back to KB chunk search
    const relevantDocs = await findRelevantKnowledgeChunks(question, 12, tenantId);
    console.log(`[kb-assistant] "${question}" → ${relevantDocs.length} chunks retrieved:`);
    relevantDocs.forEach((d, i) => console.log(`  [${i+1}] (${d.similarity.toFixed(3)}) ${d.filename} | ${d.text.slice(0, 120).replace(/\n/g, ' ')}`));
    const documentContext = relevantDocs.map(doc => `Source: ${doc.filename}\n${doc.text}`).join("\n\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an internal knowledge base assistant for ${tenantName} staff.
Answer questions using ONLY the knowledge base provided below.
If the answer is not in the knowledge base, say: "I don't have that in the knowledge base yet."
Do NOT guess or invent information.
Format using clear plain text — no markdown symbols, but you may use short paragraphs.

KNOWLEDGE BASE:
${documentContext || "No documents loaded yet."}`
        },
        { role: "user", content: question }
      ],
      temperature: 0
    });

    const answer = completion.choices[0].message.content || "No answer returned.";
    const source       = relevantDocs.length > 0 ? "Knowledge Document" : "AI Generated";
    const confidence   = relevantDocs.length > 0 ? "Medium" : "Low";
    const sourceDetail = relevantDocs.length > 0 ? [...new Set(relevantDocs.map(d => d.filename))].join(", ") : "";

    res.json({ answer, source, confidence, sourceDetail });
  } catch (err) {
    console.error("[portal-knowledge-answer]", err.message);
    res.status(500).json({ error: "Failed to search knowledge base" });
  }
});

// POST /api/portal/documents/search — tenant-scoped document search
// Combines semantic (embedding) search on content AND filename substring match
app.post("/api/portal/documents/search", requireTenant, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Query is required" });

  const tenantId = req.tenant.tenantId;
  const baseSelect = "id, original_filename, stored_filename, storage_path, mimetype, document_type";

  try {
    // ── Run semantic search and filename search in parallel ─────────────────
    const [embeddingResponse, { data: filenameDocs }] = await Promise.all([
      openai.embeddings.create({ model: "text-embedding-3-small", input: query }),
      supabase
        .from("documents")
        .select(baseSelect)
        .eq("tenant_id", tenantId)
        .neq("document_type", "Website Content")
        .ilike("original_filename", `%${query}%`)
        .limit(5)
    ]);

    const queryEmbedding = embeddingResponse.data[0].embedding;

    // ── Semantic search via embedding RPC ──────────────────────────────────
    const idToSim = {};
    const { data: chunks } = await supabase.rpc("match_chunks", {
      query_embedding:      queryEmbedding,
      match_count:          15,
      filter_lender:        null,
      filter_document_type: null,
      p_tenant_id:          tenantId
    });

    const docMap = {};
    for (const chunk of (chunks || [])) {
      if (!docMap[chunk.document_id] || chunk.similarity > docMap[chunk.document_id].similarity) {
        docMap[chunk.document_id] = chunk;
      }
    }
    Object.values(docMap).forEach(c => { idToSim[c.document_id] = c.similarity; });

    const topDocIds = Object.values(docMap)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
      .map(c => c.document_id);

    // Fetch semantic match docs (exclude website content)
    const { data: semanticDocs } = topDocIds.length
      ? await supabase
          .from("documents")
          .select(baseSelect)
          .in("id", topDocIds)
          .eq("tenant_id", tenantId)
          .neq("document_type", "Website Content")
      : { data: [] };

    // ── Merge: filename matches first, then semantic, deduplicated ──────────
    const seen = new Set();
    const merged = [];

    // Filename matches → always "Filename match" confidence
    for (const doc of (filenameDocs || [])) {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        merged.push({ ...doc, confidence: "Filename match", simScore: 1 });
      }
    }

    // Semantic matches
    for (const doc of (semanticDocs || [])) {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        const sim = idToSim[doc.id] || 0;
        merged.push({
          ...doc,
          confidence: sim > 0.75 ? "Strong match" : sim > 0.55 ? "Good match" : "Possible match",
          simScore: sim
        });
      }
    }

    const results = merged.map(doc => ({
      id:           doc.id,
      filename:     doc.original_filename || "Untitled",
      mimetype:     doc.mimetype,
      documentType: doc.document_type,
      confidence:   doc.confidence
    }));

    res.json(results);
  } catch (err) {
    console.error("[portal-doc-search]", err.message);
    res.status(500).json({ error: "Search failed" });
  }
});

// GET /api/portal/documents/:id/download — stream a portal document to the browser
app.get("/api/portal/documents/:id/download", requireTenant, async (req, res) => {
  try {
    const { data: doc, error } = await supabase
      .from("documents")
      .select("id, original_filename, stored_filename, mimetype, storage_path, tenant_id")
      .eq("id", req.params.id)
      .eq("tenant_id", req.tenant.tenantId)  // safety: can't download other tenants' docs
      .maybeSingle();

    if (error || !doc) return res.status(404).json({ error: "Document not found" });
    if (!doc.storage_path) return res.status(404).json({ error: "No file stored for this document" });

    const { data: fileData, error: dlErr } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .download(doc.storage_path);

    if (dlErr || !fileData) return res.status(500).json({ error: "Failed to fetch file" });

    const buffer = Buffer.from(await fileData.arrayBuffer());
    const filename = (doc.original_filename || "document").replace(/[^a-zA-Z0-9._-]/g, "_");
    res.setHeader("Content-Type", doc.mimetype || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error("[portal-doc-download]", err.message);
    res.status(500).json({ error: "Download failed" });
  }
});

// POST /api/portal/email-reply — tenant-scoped AI email reply
app.post("/api/portal/email-reply", requireTenant, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  const tenantId   = req.tenant.tenantId;
  const tenantName = req.tenant.tenantName || "your organisation";

  try {
    const [{ data: approvedAnswers }, relevantDocs] = await Promise.all([
      supabase.from("approved_answers").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }),
      findRelevantKnowledgeChunks(email, 5, tenantId)
    ]);

    const approvedContext = (approvedAnswers || []).slice(0, 10)
      .map(a => `APPROVED QUESTION: ${a.question}\nAPPROVED ANSWER: ${a.answer}`).join("\n\n");
    const documentContext = relevantDocs
      .map(doc => `SOURCE: ${doc.filename}\n${doc.text}`).join("\n\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an AI assistant for ${tenantName} staff. Draft a professional reply to an incoming email.
Use the knowledge provided — approved answers first, then documents.
Rules: Do NOT invent information. If unsure, say the team will follow up. Be concise.
Style: Friendly and professional. 4–8 lines. Start "Hi there," unless a name is obvious. End "Kind regards,"

APPROVED KNOWLEDGE:\n${approvedContext || "None"}
DOCUMENT KNOWLEDGE:\n${documentContext || "None"}`
        },
        { role: "user", content: `Email:\n${email}` }
      ],
      temperature: 0.3
    });

    const reply      = completion.choices[0].message.content || "No reply generated.";
    const source     = documentContext.trim() ? "Knowledge Document" : approvedContext.trim() ? "Approved Answer" : "General Guidance";
    const confidence = documentContext.trim() ? "Medium" : approvedContext.trim() ? "High" : "";

    res.json({ reply, source, confidence });
  } catch (err) {
    console.error("[portal-email-reply]", err.message);
    res.status(500).json({ error: "Failed to generate reply" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Portal: feature settings ──────────────────────────────────────────────────

// ── Retroactively seed flows for existing tennis club tenants ─────────────────
app.post("/api/portal/seed-flows", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { data: tenant } = await supabase.from("tenants").select("name, website, business_description, business_type").eq("id", tenantId).maybeSingle();
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  try {
    // Gather already-crawled pages from documents table
    const { data: docs } = await supabase
      .from("documents")
      .select("stored_filename, original_filename")
      .eq("tenant_id", tenantId)
      .eq("document_type", "Website Content");

    // Re-fetch page text from chunks (we have embeddings but need raw text)
    // Simpler: just use the website directly with extractTennisClubInfo via a fresh light crawl
    const website = tenant.website;
    if (!website) return res.status(400).json({ error: "No website on file for this tenant" });

    // Detect type if not already set
    let bizType = tenant.business_type;
    if (!bizType || bizType === "other") {
      const { data: chunks } = await supabase.from("document_chunks").select("content").eq("tenant_id", tenantId).limit(20);
      const sampleText = (chunks || []).map(c => c.content).join(" ").slice(0, 2000);
      bizType = await detectBusinessType(tenant.name, tenant.business_description || "", sampleText);
      await supabase.from("tenants").update({ business_type: bizType }).eq("id", tenantId);
    }

    if (bizType === "other") {
      return res.status(400).json({ error: "Business type could not be determined — please set up flows manually in the portal." });
    }

    // Crawl site — used for both flow seeding and knowledge base refresh
    const pages  = await crawlWebsite(website, 12);
    const seeded = await seedFlowsForType(tenantId, tenant.name, website, bizType, pages);

    // Always refresh the knowledge base with the newly crawled pages.
    // Delete old website content docs + chunks first, then insert fresh ones.
    try {
      const { data: oldDocs } = await supabase
        .from("documents")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("document_type", "Website Content");

      if (oldDocs && oldDocs.length > 0) {
        const oldIds = oldDocs.map(d => d.id);
        await supabase.from("knowledge_chunks").delete().in("document_id", oldIds);
        await supabase.from("documents").delete().in("id", oldIds);
        console.log(`[seed-flows] Cleared ${oldIds.length} old website docs for ${tenantId}`);
      }

      let kbImported = 0;
      for (const page of pages) {
        try {
          const { data: doc, error: insertError } = await supabase
            .from("documents")
            .insert({
              original_filename: page.title,
              stored_filename:   page.url,
              mimetype:          "text/html",
              document_type:     "Website Content",
              tags:              ["website"],
              metadata_complete: true,
              junior_accessible: true,
              storage_path:      page.url,
              tenant_id:         tenantId
            })
            .select().single();
          if (insertError) { console.error(`[seed-flows] Doc insert:`, insertError.message); continue; }
          await generateAndStoreChunks(doc.id, page.text, null, "Website Content", null, tenantId, { title: page.title || page.url });
          kbImported++;
        } catch (kbErr) {
          console.error(`[seed-flows] KB page error:`, kbErr.message);
        }
      }
      console.log(`[seed-flows] Refreshed KB: ${kbImported} pages for ${tenantId}`);
    } catch (kbErr) {
      console.error(`[seed-flows] KB refresh failed (non-fatal):`, kbErr.message);
    }

    if (seeded) {
      res.json({ success: true, message: "Tennis club flows seeded — visit Chat Flows in the portal to review and activate." });
    } else {
      res.json({ success: false, message: "Flows already exist for this tenant. Delete them first if you want to re-seed." });
    }
  } catch (err) {
    console.error("[seed-flows] Error:", err.message);
    res.status(500).json({ error: "Seeding failed: " + err.message });
  }
});

app.get("/api/portal/settings", requireTenant, async (req, res) => {
  const { data, error } = await supabase
    .from("tenants")
    .select("ai_enabled, train_staff_enabled, business_description, facebook_url, instagram_handle, twitter_handle, social_images, business_type, checkin_lat, checkin_lng, checkin_radius_meters, logo_url, assistant_name, founded_year, phone")
    .eq("id", req.tenant.tenantId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: "Failed to fetch settings" });
  let socialImages = [];
  try { socialImages = JSON.parse(data?.social_images) || []; } catch {}
  res.json({
    ai_enabled:            data?.ai_enabled           ?? true,
    train_staff_enabled:   data?.train_staff_enabled  ?? false,
    business_description:  data?.business_description ?? "",
    facebook_url:          data?.facebook_url         ?? "",
    instagram_handle:      data?.instagram_handle     ?? "",
    twitter_handle:        data?.twitter_handle       ?? "",
    social_images:         socialImages,
    business_type:         data?.business_type        ?? "",
    checkin_lat:           data?.checkin_lat          ?? null,
    checkin_lng:           data?.checkin_lng          ?? null,
    checkin_radius_meters: data?.checkin_radius_meters ?? 150,
    logo_url:              data?.logo_url             ?? null,
    assistant_name:        data?.assistant_name       ?? "Maeve",
    founded_year:          data?.founded_year         ?? null,
    phone:                 data?.phone                ?? ""
  });
});

// ── Shared: send a portal staff email via Resend ─────────────────────────────
function sendStaffEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) return;
  fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Sprimal <hello@sprimal.com>", to, subject, html })
  }).catch(err => console.error("[staff-email] Send error:", err.message));
}

app.post("/api/portal/settings", requireSeniorTenant, async (req, res) => {
  const updates = {};
  if (typeof req.body.ai_enabled           === "boolean") updates.ai_enabled           = req.body.ai_enabled;
  if (typeof req.body.train_staff_enabled  === "boolean") updates.train_staff_enabled  = req.body.train_staff_enabled;
  if (typeof req.body.business_description === "string")  updates.business_description = req.body.business_description.slice(0, 300);
  if (typeof req.body.facebook_url         === "string")  updates.facebook_url         = req.body.facebook_url.slice(0, 500);
  if (typeof req.body.instagram_handle     === "string") {
    let igVal = req.body.instagram_handle.trim();
    // Strip full URL down to handle: https://www.instagram.com/handle/ → handle
    const igUrlMatch = igVal.match(/instagram\.com\/([A-Za-z0-9_.]+)/);
    if (igUrlMatch) igVal = igUrlMatch[1];
    updates.instagram_handle = igVal.replace(/^@/, "").slice(0, 100);
  }
  if (typeof req.body.twitter_handle === "string") {
    let twVal = req.body.twitter_handle.trim();
    const twUrlMatch = twVal.match(/(?:twitter|x)\.com\/([A-Za-z0-9_]+)/);
    if (twUrlMatch) twVal = twUrlMatch[1];
    updates.twitter_handle = twVal.replace(/^@/, "").slice(0, 100);
  }
  if (typeof req.body.checkin_lat === "number" || req.body.checkin_lat === null)            updates.checkin_lat            = req.body.checkin_lat;
  if (typeof req.body.checkin_lng === "number" || req.body.checkin_lng === null)            updates.checkin_lng            = req.body.checkin_lng;
  if (typeof req.body.checkin_radius_meters === "number")  updates.checkin_radius_meters  = req.body.checkin_radius_meters;
  if (typeof req.body.assistant_name === "string" && req.body.assistant_name.trim()) updates.assistant_name = req.body.assistant_name.trim();
  if (typeof req.body.phone === "string") updates.phone = req.body.phone.trim().slice(0, 30) || null;
  if (req.body.phone === null) updates.phone = null;
  if (typeof req.body.founded_year === "number" && req.body.founded_year >= 1800 && req.body.founded_year <= new Date().getFullYear()) updates.founded_year = req.body.founded_year;
  if (req.body.founded_year === null) updates.founded_year = null;
  if (!Object.keys(updates).length) return res.status(400).json({ error: "No valid fields provided" });

  const tenantId   = req.tenant.tenantId;
  const tenantName = req.tenant.tenantName || "your organisation";

  // If train_staff_enabled is changing, fetch current value so we know if it's actually toggling
  let previousTrainStaff = null;
  if (typeof updates.train_staff_enabled === "boolean") {
    const { data: current } = await supabase
      .from("tenants")
      .select("train_staff_enabled")
      .eq("id", tenantId)
      .maybeSingle();
    previousTrainStaff = current?.train_staff_enabled ?? false;
  }

  const { error } = await supabase.from("tenants").update(updates).eq("id", tenantId);
  if (error) return res.status(500).json({ error: "Failed to save settings" });

  // Send emails if train_staff_enabled actually changed
  if (typeof updates.train_staff_enabled === "boolean" && updates.train_staff_enabled !== previousTrainStaff) {
    // Fetch all junior users for this tenant (fire-and-forget emails)
    supabase
      .from("portal_users")
      .select("name, email")
      .eq("tenant_id", tenantId)
      .then(({ data: staff }) => {
        if (!staff?.length) return;
        staff.forEach(user => {
          if (updates.train_staff_enabled) {
            // Access restored
            sendStaffEmail(
              user.email,
              `Your ${tenantName} staff access has been restored`,
              `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
                <h2 style="font-size:20px;color:#111827;margin-bottom:12px;">Hi ${user.name},</h2>
                <p style="font-size:15px;color:#374151;line-height:1.6;">Your staff access to the <strong>${tenantName}</strong> knowledge base on Sprimal has been <strong style="color:#15803d;">restored</strong>.</p>
                <p style="font-size:15px;color:#374151;line-height:1.6;margin-top:12px;">You can log in at any time using your existing credentials:</p>
                <div style="margin-top:16px;background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:16px 20px;">
                  <p style="font-size:14px;color:#374151;margin-bottom:6px;"><strong>URL:</strong> <a href="https://app.sprimal.com/portal" style="color:#1e40af;">https://app.sprimal.com/portal</a></p>
                  <p style="font-size:14px;color:#374151;margin-bottom:0;"><strong>Email:</strong> ${user.email}</p>
                </div>
                <p style="margin-top:20px;font-size:13px;color:#6b7280;">— The Sprimal team</p>
              </div>`
            );
          } else {
            // Access suspended
            sendStaffEmail(
              user.email,
              `Your ${tenantName} staff access has been suspended`,
              `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
                <h2 style="font-size:20px;color:#111827;margin-bottom:12px;">Hi ${user.name},</h2>
                <p style="font-size:15px;color:#374151;line-height:1.6;">Your staff access to the <strong>${tenantName}</strong> knowledge base on Sprimal has been <strong style="color:#dc2626;">temporarily suspended</strong> by your manager.</p>
                <p style="font-size:15px;color:#374151;line-height:1.6;margin-top:12px;">You will not be able to log in until access is restored. Please contact your manager if you have any questions.</p>
                <p style="margin-top:20px;font-size:13px;color:#6b7280;">— The Sprimal team</p>
              </div>`
            );
          }
        });
      })
      .catch(err => console.error("[staff-email] Fetch staff error:", err.message));
  }

  res.json({ success: true });
});

// ── Portal: social images management ─────────────────────────────────────────

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post("/api/portal/social-images/upload-file", requireSeniorTenant, memUpload.array("photos", 9), async (req, res) => {
  const tenantId = req.tenant.tenantId;
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: "no files" });
  const { data: tenant } = await supabase.from("tenants").select("social_images").eq("id", tenantId).maybeSingle();
  let images = [];
  try { images = JSON.parse(tenant?.social_images) || []; } catch {}
  const added = [];
  for (const file of req.files) {
    const ext = file.mimetype.includes("png") ? "png" : file.mimetype.includes("webp") ? "webp" : "jpg";
    const storagePath = `${tenantId}/manual_${Date.now()}_${added.length}.${ext}`;
    const { error } = await supabase.storage.from("social-images").upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: true });
    if (error) { console.error(`[photo-upload] Failed: ${error.message}`); continue; }
    const { data: { publicUrl } } = supabase.storage.from("social-images").getPublicUrl(storagePath);
    images.push(publicUrl);
    added.push(publicUrl);
  }
  if (images.length > 12) images = images.slice(-12);
  await supabase.from("tenants").update({ social_images: JSON.stringify(images) }).eq("id", tenantId);
  res.json({ ok: true, added, images });
});

app.post("/api/portal/social-images/add", requireSeniorTenant, async (req, res) => {
  let { url } = req.body;
  if (!url || typeof url !== "string") return res.status(400).json({ error: "url required" });
  const tenantId = req.tenant.tenantId;

  // If it's a social post page (not a direct image), use Jina to extract the image URL
  const isSocialPage = /instagram\.com\/p\/|instagram\.com\/reel\/|x\.com\/[^/]+\/status\/|twitter\.com\/[^/]+\/status\//.test(url);
  if (isSocialPage) {
    try {
      const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
        headers: { ...jinaHeaders(), "X-Return-Format": "markdown" },
        signal: AbortSignal.timeout(15000),
      });
      if (!jinaRes.ok) return res.status(400).json({ error: "Could not read that post — try right-clicking the image and copying the image URL directly." });
      const text = await jinaRes.text();
      // Extract first CDN image URL
      const igRe  = /https:\/\/[a-z0-9_.-]+\.(?:cdninstagram|fbcdn|scontent)\.net\/[^\s"'<>\\]+\.(?:jpe?g|webp)/i;
      const twRe  = /https:\/\/pbs\.twimg\.com\/media\/[A-Za-z0-9_-]+(?:\?[^\s"'<>]*)?/i;
      const mdRe  = /!\[[^\]]*\]\((https?:\/\/[^)\s]+\.(?:jpe?g|png|webp)[^)]*)\)/i;
      const match = text.match(igRe) || text.match(twRe) || text.match(mdRe);
      if (!match) return res.status(400).json({ error: "No image found in that post — try right-clicking the image and copying the image URL directly." });
      url = (match[1] || match[0]).replace(/&amp;/g, "&");
      console.log(`[social-add] Extracted image URL from post: ${url.slice(0, 100)}`);
    } catch (e) {
      return res.status(400).json({ error: "Could not fetch that post: " + e.message });
    }
  }

  let buffer, contentType;
  try {
    ({ buffer, contentType } = await fetchImageBuffer(url));
  } catch (err) {
    return res.status(400).json({ error: "Could not fetch image: " + err.message });
  }
  const ext = (contentType || "").includes("png") ? "png" : (contentType || "").includes("webp") ? "webp" : "jpg";
  const storagePath = `${tenantId}/manual_${Date.now()}.${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from("social-images")
    .upload(storagePath, buffer, { contentType: contentType || "image/jpeg", upsert: true });
  if (uploadErr) return res.status(500).json({ error: "Upload failed: " + uploadErr.message });
  const { data: { publicUrl } } = supabase.storage.from("social-images").getPublicUrl(storagePath);
  const { data: tenant } = await supabase.from("tenants").select("social_images").eq("id", tenantId).maybeSingle();
  let images = [];
  try { images = JSON.parse(tenant?.social_images) || []; } catch {}
  images.push(publicUrl);
  if (images.length > 12) images = images.slice(-12);
  await supabase.from("tenants").update({ social_images: JSON.stringify(images) }).eq("id", tenantId);
  res.json({ ok: true, url: publicUrl, images });
});

app.post("/api/portal/social-images/remove", requireSeniorTenant, async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== "string") return res.status(400).json({ error: "url required" });
  const tenantId = req.tenant.tenantId;
  const { data: tenant } = await supabase.from("tenants").select("social_images").eq("id", tenantId).maybeSingle();
  let images = [];
  try { images = JSON.parse(tenant?.social_images) || []; } catch {}
  images = images.filter(u => u !== url);
  await supabase.from("tenants").update({ social_images: JSON.stringify(images) }).eq("id", tenantId);
  res.json({ ok: true, images });
});

app.post("/api/portal/social-images/refetch", requireSeniorTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { data: tenant } = await supabase.from("tenants").select("instagram_handle, twitter_handle, social_images").eq("id", tenantId).maybeSingle();
  if (!tenant?.instagram_handle && !tenant?.twitter_handle) return res.status(400).json({ error: "No Instagram or Twitter handle set. Save them in Social Media settings first." });
  res.json({ ok: true });
  const igPromise = tenant.instagram_handle ? fetchInstagramThumbnails(tenant.instagram_handle, tenantId, 9) : Promise.resolve([]);
  const twPromise = tenant.twitter_handle   ? fetchTwitterPhotos(tenant.twitter_handle, tenantId, 6)         : Promise.resolve([]);
  Promise.all([igPromise, twPromise]).then(async ([igThumbs, twPhotos]) => {
    let existing = [];
    try { existing = JSON.parse(tenant.social_images) || []; } catch {}
    const siteImgs = existing.filter(u => /\/site_\d+\./.test(u));
    const combined = [...igThumbs, ...twPhotos, ...siteImgs].slice(0, 15);
    if (igThumbs.length + twPhotos.length >= 1) {
      await supabase.from("tenants").update({ social_images: JSON.stringify(combined) }).eq("id", tenantId);
      console.log(`[social-refetch] Stored ${igThumbs.length} IG + ${twPhotos.length} TW + ${siteImgs.length} site images for ${tenantId}`);
    }
  }).catch(err => console.error("[social-refetch]", err.message));
});

// ── Portal: staff management ──────────────────────────────────────────────────

app.get("/api/portal/staff", requireSeniorTenant, async (req, res) => {
  const { data, error } = await supabase
    .from("portal_users")
    .select("id, name, email, role, created_at")
    .eq("tenant_id", req.tenant.tenantId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "Failed to load staff" });
  res.json(data || []);
});

app.post("/api/portal/staff", requireSeniorTenant, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: "Name, email and password are required" });
  const { error } = await supabase.from("portal_users").insert({
    tenant_id: req.tenant.tenantId,
    name:      name.trim(),
    email:     email.toLowerCase().trim(),
    password:  password.trim(),
    role:      "junior"
  });
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "A user with this email already exists" });
    return res.status(500).json({ error: "Failed to create staff member" });
  }
  res.json({ success: true });

  // Send welcome email (fire-and-forget)
  const tenantName = req.tenant.tenantName || "your organisation";
  const cleanEmail = email.toLowerCase().trim();
  const cleanName  = name.trim();
  const cleanPass  = password.trim();
  sendStaffEmail(
    cleanEmail,
    `You've been added to ${tenantName} on Sprimal`,
    `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
      <h2 style="font-size:20px;color:#111827;margin-bottom:12px;">Hi ${cleanName},</h2>
      <p style="font-size:15px;color:#374151;line-height:1.6;">
        You've been added as a staff member for <strong>${tenantName}</strong> on Sprimal.
        You can now log in to access the knowledge base assistant, find documents, and generate email replies.
      </p>
      <div style="background:#f1f5f9;border-radius:10px;padding:20px 24px;margin:24px 0;">
        <p style="font-size:13px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.6px;margin:0 0 12px;">Your login details</p>
        <p style="font-size:15px;color:#111827;margin:0 0 6px;"><strong>Email:</strong> ${cleanEmail}</p>
        <p style="font-size:15px;color:#111827;margin:0 0 6px;"><strong>Password:</strong> ${cleanPass}</p>
        <p style="font-size:15px;color:#111827;margin:0;"><strong>Login URL:</strong> <a href="https://app.sprimal.com/portal" style="color:#2563eb;">app.sprimal.com/portal</a></p>
      </div>
      <p style="font-size:13px;color:#6b7280;line-height:1.6;">If you have any questions, please contact your manager.</p>
    </div>`
  );
});

app.delete("/api/portal/staff/:id", requireSeniorTenant, async (req, res) => {
  const { error } = await supabase
    .from("portal_users")
    .delete()
    .eq("id", req.params.id)
    .eq("tenant_id", req.tenant.tenantId);  // safety: can't delete other tenants' staff
  if (error) return res.status(500).json({ error: "Failed to remove staff member" });
  res.json({ success: true });
});

// ── Portal: flagged answers ────────────────────────────────────────────────────

// Junior users can flag an answer from their KB session
app.post("/api/portal/flag-answer", requireTenant, async (req, res) => {
  const { question, answer, feedback } = req.body;
  if (!question || !answer) return res.status(400).json({ error: "Question and answer are required" });
  const { error } = await supabase.from("flagged_answers").insert({
    tenant_id:  req.tenant.tenantId,
    question,
    answer,
    feedback:   feedback || "",
    flagged_by: req.tenant.userName || req.tenant.email || "portal user"
  });
  if (error) return res.status(500).json({ error: "Failed to flag answer" });
  res.json({ success: true });
});

app.get("/api/portal/flagged-answers", requireSeniorTenant, async (req, res) => {
  const { data, error } = await supabase
    .from("flagged_answers")
    .select("*")
    .eq("tenant_id", req.tenant.tenantId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "Failed to load flagged answers" });
  res.json((data || []).map(r => ({
    id: r.id, question: r.question, answer: r.answer,
    feedback: r.feedback, createdAt: r.created_at
  })));
});

app.delete("/api/portal/flagged-answers/:id", requireSeniorTenant, async (req, res) => {
  await supabase.from("flagged_answers").delete()
    .eq("id", req.params.id).eq("tenant_id", req.tenant.tenantId);
  res.json({ success: true });
});

// ── Portal: approved answers ───────────────────────────────────────────────────

app.get("/api/portal/approved-answers", requireSeniorTenant, async (req, res) => {
  const { data, error } = await supabase
    .from("approved_answers")
    .select("*")
    .eq("tenant_id", req.tenant.tenantId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "Failed to load approved answers" });
  res.json((data || []).map(r => ({
    id: r.id, question: r.question, answer: r.answer,
    category: r.category, createdAt: r.created_at
  })));
});

app.post("/api/portal/approved-answers", requireSeniorTenant, async (req, res) => {
  const { question, answer, category } = req.body;
  if (!question || !answer) return res.status(400).json({ error: "Question and answer are required" });
  const { error } = await supabase.from("approved_answers").insert({
    tenant_id: req.tenant.tenantId,
    question, answer,
    category: category || "General"
  });
  if (error) return res.status(500).json({ error: "Failed to save approved answer" });
  res.json({ success: true });
});

app.delete("/api/portal/approved-answers/:id", requireSeniorTenant, async (req, res) => {
  await supabase.from("approved_answers").delete()
    .eq("id", req.params.id).eq("tenant_id", req.tenant.tenantId);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Sprimal Billing API ───────────────────────────────────────────────────────

// GET /api/billing/status — returns current subscription state for the tenant
app.get("/api/billing/status", requireTenant, async (req, res) => {
  try {
    const { data } = await supabase.from("tenants")
      .select("subscription_status, subscription_plan, trial_ends_at, stripe_customer_id")
      .eq("id", req.tenant.tenantId).maybeSingle();
    res.json(data || { subscription_status: "trialing" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/checkout — create a Stripe Checkout session
app.post("/api/billing/checkout", requireTenant, async (req, res) => {
  if (!process.env.SPRIMAL_STRIPE_KEY) return res.status(500).json({ error: "Billing not configured" });
  try {
    const { plan = "monthly" } = req.body;
    const priceId = plan === "annual" ? process.env.STRIPE_PRICE_ANNUAL : process.env.STRIPE_PRICE_MONTHLY;
    const { data: tenant } = await supabase.from("tenants").select("name, email").eq("id", req.tenant.tenantId).maybeSingle();
    const email      = req.tenant.email || tenant?.email || "";
    const customerId = await getOrCreateSprimalCustomer(req.tenant.tenantId, tenant?.name || req.tenant.tenantId, email);
    const stripe     = sprimalStripe();
    const session    = await stripe.checkout.sessions.create({
      customer:             customerId,
      payment_method_types: ["card"],
      line_items:           [{ price: priceId, quantity: 1 }],
      mode:                 "subscription",
      success_url:          `https://app.sprimal.com/portal/dashboard?billing=success`,
      cancel_url:           `https://app.sprimal.com/portal/dashboard`,
      metadata:             { tenant_id: req.tenant.tenantId }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("[billing/checkout]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/portal-session — open Stripe Customer Portal (manage/cancel)
app.post("/api/billing/portal-session", requireTenant, async (req, res) => {
  if (!process.env.SPRIMAL_STRIPE_KEY) return res.status(500).json({ error: "Billing not configured" });
  try {
    const { data: tenant } = await supabase.from("tenants").select("stripe_customer_id").eq("id", req.tenant.tenantId).maybeSingle();
    if (!tenant?.stripe_customer_id) return res.status(400).json({ error: "No billing account found. Please subscribe first." });
    const stripe  = sprimalStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer:   tenant.stripe_customer_id,
      return_url: "https://app.sprimal.com/portal/dashboard"
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("[billing/portal-session]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Universal booking redirect — /b/:tenantId → EBO or tenant website ────────
app.get("/b/:tenantId", async (req, res) => {
  const { tenantId } = req.params;
  await loadEboConfigFromDb(tenantId);
  const eboCfg = EBO_CONFIG[tenantId];
  if (eboCfg) {
    return res.redirect(302, `https://ebookingonline.net/box/${eboCfg.clubId}`);
  }
  // Fallback: redirect to tenant's own website if available
  try {
    const { data } = await supabase.from("tenants").select("website").eq("id", tenantId).maybeSingle();
    if (data?.website) return res.redirect(302, data.website);
  } catch (_) {}
  res.status(404).send("Booking not available");
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Public tenant config — widget fetches this on load ───────────────────────
app.get("/api/tenant-config/:tenantId", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  const { tenantId } = req.params;

  const { data, error } = await supabase
    .from("tenants")
    .select("id, name, logo_url, website, brand_color, assistant_name")
    .eq("id", tenantId)
    .maybeSingle();

  if (error || !data) {
    return res.json({ id: tenantId, name: null, logo_url: null, brand_color: null, assistant_name: null });
  }

  res.json({ id: data.id, name: data.name, logo_url: data.logo_url || null, brand_color: data.brand_color || null, assistant_name: data.assistant_name || null });
});

// ── Favicon proxy — serves tenant logo through our own domain ─────────────────
// Avoids hotlinking blocks and CORS issues entirely.
const faviconCache = new Map(); // tenantId → { buffer, contentType, ts }
function clearFaviconCache(tenantId) { faviconCache.delete(tenantId); }

// Fetches an image buffer, falling back to SSL-bypass for broken certs
function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? require("https") : require("http");
    const opts = url.startsWith("https") ? { rejectUnauthorized: false } : {};
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      timeout: 6000,
      ...opts,
    };
    const req = mod.get(options, (res) => {
      // Follow redirects (max 3)
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return fetchImageBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers["content-type"] || "image/png" }));
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

app.get("/api/tenant-favicon/:tenantId", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=3600");
  const { tenantId } = req.params;

  // Serve from memory cache for 1 hour
  const cached = faviconCache.get(tenantId);
  if (cached && Date.now() - cached.ts < 3600000) {
    res.setHeader("Content-Type", cached.contentType);
    return res.send(cached.buffer);
  }

  // Get tenant's stored logo_url or derive from website
  const { data } = await supabase
    .from("tenants")
    .select("logo_url, website")
    .eq("id", tenantId)
    .maybeSingle();

  if (!data) return res.status(404).end();

  const domain = data.website ? new URL(data.website).hostname.replace(/^www\./, "") : null;

  // Build candidate URLs in priority order
  const candidates = [];
  if (data.logo_url) candidates.push(data.logo_url);
  if (domain) candidates.push(`https://icons.duckduckgo.com/ip3/${domain}.ico`);

  for (const imgUrl of candidates) {
    try {
      const { buffer, contentType } = await fetchImageBuffer(imgUrl);
      faviconCache.set(tenantId, { buffer, contentType, ts: Date.now() });
      res.setHeader("Content-Type", contentType);
      return res.send(buffer);
    } catch (err) {
      console.warn(`[favicon-proxy] Failed to fetch ${imgUrl} for ${tenantId}: ${err.message}`);
    }
  }

  res.status(404).end();
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Skills & Agent Library ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── Helpers ──────────────────────────────────────────────────────────────────

// Resolve {{variable}} placeholders in a template string from a data object
function fillTemplate(template, data) {
  if (!template) return "";
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? "");
}

// Validate an email address
function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str.trim());
}

// ── Lead Capture skill engine ─────────────────────────────────────────────────
// Runs as a sub-state machine inside an agent step.
// agentState.skillState = { fieldIndex: number, fields: [...], data: {} }
// Returns { reply, choices, done, data }

function startLeadCaptureSkill(agentState, skillDef) {
  const fields = skillDef.config_schema.fields || [];
  agentState.skillState = { fieldIndex: 0, fields, data: {} };
  const first = fields[0];
  return { reply: first.prompt, choices: [], done: false };
}

function advanceLeadCaptureSkill(agentState, message) {
  const state  = agentState.skillState;
  const fields = state.fields;
  const idx    = state.fieldIndex;
  const field  = fields[idx];
  const trimmed = message.trim();
  const lower   = trimmed.toLowerCase();

  // Handle skip for optional fields
  if (lower === "skip" && !field.required) {
    state.data[field.key] = null;
    state.fieldIndex++;
  } else if (!trimmed) {
    // Empty answer for required field — re-ask politely
    if (field.required) {
      return { reply: `I just need ${field.label} to continue — could you share that?`, choices: [], done: false };
    }
    state.data[field.key] = null;
    state.fieldIndex++;
  } else if (field.validation === "email" && !isValidEmail(trimmed)) {
    return { reply: "That doesn't look like a valid email address — could you double-check it?", choices: [], done: false };
  } else {
    state.data[field.key] = trimmed;
    state.fieldIndex++;
  }

  // Advance to next field
  if (state.fieldIndex < fields.length) {
    const next = fields[state.fieldIndex];
    return { reply: next.prompt, choices: [], done: false };
  }

  // All fields collected
  return { reply: null, choices: [], done: true, data: state.data };
}

// ── Notify & Confirm skill engine ─────────────────────────────────────────────
// Single-turn — runs once, sends notification (email and/or WhatsApp), stores lead, returns confirmation.

async function runNotifyAndConfirmSkill(tenantId, agentId, tenantAgentInstanceId, agentName, collected, agentConfig) {
  const replyTime   = agentConfig.reply_time || "soon";

  // ── Fetch tenant branding (used in both WhatsApp footer and email) ────────
  let clubName    = agentName;
  let clubWebsite = null;
  try {
    const { data: tenantRow } = await supabase.from("tenants").select("name, website").eq("id", tenantId).maybeSingle();
    if (tenantRow) { clubName = tenantRow.name || clubName; clubWebsite = tenantRow.website || null; }
  } catch (_) {}

  // ── Extract coach contact (phone → WhatsApp, email → email) ─────────────────
  // Format in coaches config: "Name | +353XXXXXXX"  or  "Name | coach@email.com"
  const coachName  = collected.preferred_coach ? collected.preferred_coach.split(" | ")[0].trim() : null;
  let   coachPhone = null;
  let   coachEmail = null;
  if (collected.preferred_coach && collected.preferred_coach.includes(" | ")) {
    const contact = collected.preferred_coach.split(" | ").pop().trim();
    if (contact.startsWith("+"))    coachPhone = contact;
    else if (contact.includes("@")) coachEmail = contact;
  }


  // ── Build WhatsApp message body ───────────────────────────────────────────
  // EBO booking URL built from integration club_id if available
  const eboCfg = EBO_CONFIG[tenantId];
  // Always use the short redirect — it resolves the correct EBO URL (or tenant website) server-side
  const eboUrl = `https://app.sprimal.com/b/${tenantId}`;

  // Capitalise field key: "session_type" → "Session type"
  const fmtKey = k => k.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());

  // General fields — skip fields handled specially below
  const SKIP_WA = new Set(["preferred_coach", "preferred_slots", "preferred_slot", "booking_date"]);
  const generalLines = Object.entries(collected)
    .filter(([k, v]) => v && !k.startsWith("_") && !SKIP_WA.has(k))
    .map(([k, v]) => `*${fmtKey(k)}:* ${v}`)
    .join("\n");

  // Slots — one per line, each with EBO booking link below it
  const slotsSection = (() => {
    const raw = collected.preferred_slots || collected.preferred_slot || "";
    if (!raw) return "";
    const slots = raw.split(" | ").map(s => s.trim()).filter(Boolean);
    const lines = slots.map(s => eboUrl ? `• ${s}\n  ${eboUrl}` : `• ${s}`).join("\n");
    return `*Preferred slots:*\n${lines}`;
  })();

  // First name only for greeting
  const coachFirstName = coachName ? coachName.trim().split(" ")[0] : "Coach";

  // Shorten date: "Monday 8 June" → "Mon 8 Jun"
  const shortenDate = s => s
    .replace(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g, d => d.slice(0,3))
    .replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g, d => d.slice(0,3));

  // Emoji map for field keys
  const fieldEmoji = { name: "👤", email: "📧", phone: "📱", session_type: "🎓", child_age: "👶" };

  const generalLinesWA = Object.entries(collected)
    .filter(([k, v]) => v && !k.startsWith("_") && !SKIP_WA.has(k))
    .map(([k, v]) => `${fieldEmoji[k] || "•"} *${fmtKey(k)}:* ${v}`)
    .join("\n");

  const slotsSectionWA = (() => {
    const raw = collected.preferred_slots || collected.preferred_slot || "";
    if (!raw) return "";
    const slots = raw.split(" | ").map(s => shortenDate(s.trim())).filter(Boolean);
    const lines = slots.map(s => `→ ${s}`).join("\n");
    return `📅 *Preferred slots:*\n${lines}`;
  })();

  const urlShort = eboUrl ? eboUrl.replace(/https?:\/\//, "") : null;

  const waBody = [
    `🎾 *New ${agentName}*`,
    `Hi ${coachFirstName}! 👋`,
    "",
    generalLinesWA,
    "",
    slotsSectionWA,
    urlShort ? `🔗 ${urlShort}` : "",
    "",
    `_Sent by ${clubName}_`,
    `_Powered by Sprimal · sprimal.com_`
  ].filter(s => s !== undefined).join("\n");

  // ── WhatsApp → coach (if phone number configured) ─────────────────────────
  if (coachPhone) {
    await loadTwilioConfigFromDb(tenantId);
    const twilioCfg = TWILIO_CONFIG[tenantId];
    if (twilioCfg) {
      try {
        const twilio = require("twilio")(twilioCfg.accountSid, twilioCfg.authToken);
        await twilio.messages.create({ from: twilioCfg.from, to: `whatsapp:${coachPhone}`, body: waBody });
        console.log(`[Twilio] WhatsApp sent to ${coachPhone} for tenant ${tenantId}`);
      } catch (err) {
        console.error(`[Twilio] WhatsApp send failed for ${tenantId}:`, err.message);
      }
    }
  }

  // ── Email → coach (if email address configured) ───────────────────────────
  if (coachEmail) {
    const coachSubject = fillTemplate(`New ${agentName} enquiry from {{name}}`, collected);
    const coachHtml    = buildEmailHtml(`New ${agentName}`, `Hi ${coachName}, a new enquiry has come in via the club website.`, collected);
    sendStaffEmail(coachEmail, coachSubject, coachHtml);
  }

  const emailFooter = `
    <p style="color:#6b7280;font-size:13px;margin-top:24px;">
      Sent by <a href="${clubWebsite || '#'}" style="color:#111827;font-weight:600;text-decoration:none;">${clubName}</a>
    </p>
    <p style="color:#bbb;font-size:11px;margin-top:2px;">
      Built by <a href="https://www.sprimal.com" style="color:#bbb;">Sprimal</a>
    </p>`;

  // ── Shared HTML email builder ────────────────────────────────────────────────
  const buildEmailHtml = (title, subtitle, data) => {
    const SKIP_E = new Set(["preferred_slots", "preferred_slot", "booking_date"]);
    const fmtE   = k => k.replace(/_/g, " ").replace(/^\w/, ch => ch.toUpperCase());
    const generalRows = Object.entries(data)
      .filter(([k, v]) => v && !SKIP_E.has(k))
      .map(([k, v]) => `<tr><td style="padding:7px 14px;font-weight:600;color:#374151;white-space:nowrap;">${fmtE(k)}</td><td style="padding:7px 14px;color:#111827;">${v}</td></tr>`)
      .join("");
    const rawSlots = data.preferred_slots || data.preferred_slot || "";
    const slotsRow = rawSlots ? (() => {
      const items = rawSlots.split(" | ").map(s => s.trim()).filter(Boolean)
        .map(s => {
          const link = eboUrl ? ` <a href="${eboUrl}" style="color:#2563eb;font-size:12px;margin-left:6px;">Book →</a>` : "";
          return `<li style="margin:5px 0;">${s}${link}</li>`;
        }).join("");
      return `<tr><td style="padding:7px 14px;font-weight:600;color:#374151;vertical-align:top;">Preferred slots</td>
        <td style="padding:7px 14px;"><ul style="margin:0;padding-left:18px;">${items}</ul></td></tr>`;
    })() : "";
    return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#0f172a;margin-bottom:4px;">${title}</h2>
      <p style="color:#6b7280;font-size:14px;margin-bottom:16px;">${subtitle}</p>
      <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:8px;overflow:hidden;">
        ${generalRows}${slotsRow}
      </table>
      ${emailFooter}
    </div>`;
  };

  // ── Club notification email (always sent if notification_email set) ────────
  const notifyEmail = agentConfig.notification_email;
  const subject     = fillTemplate(
    agentConfig.email_subject || `New ${agentName} enquiry from {{name}}`,
    { ...collected, reply_time: replyTime }
  );
  const htmlBody = buildEmailHtml(`New ${agentName}`, "Via your Sprimal chat widget", collected);
  if (notifyEmail) sendStaffEmail(notifyEmail, subject, htmlBody);

  // Store lead in skill_leads — keyed by tenant_agent instance UUID so leads panel can filter
  await supabase.from("skill_leads").insert({
    tenant_id: tenantId,
    agent_id:  tenantAgentInstanceId || agentId,
    data:      collected,
    status:    "new"
  });

  // Build chat confirmation
  const confirmTmpl = agentConfig.confirmation_message
    || `Thanks {{name}}! We'll be in touch within {{reply_time}}. 😊`;
  const confirmMsg = fillTemplate(confirmTmpl, { ...collected, reply_time: replyTime });

  return { reply: confirmMsg, choices: [], done: true };
}

// ── Agent field suggestion ────────────────────────────────────────────────────

// Shared LLM extraction logic used by both the backfill and the portal API endpoint.
// Reconstruct complete page texts for documents whose content mentions a keyword.
// Returns full un-truncated text so the LLM never misses content deep in a page.
async function getFullPageTextForKeyword(tenantId, keyword) {
  // When the keyword is a bare wildcard, skip the filtering step and just get all chunks
  if (keyword === "%" || keyword === "%%" ) {
    const { data: allChunks, error: allErr } = await supabase
      .from("knowledge_chunks")
      .select("chunk_text, chunk_index")
      .eq("tenant_id", tenantId)
      .order("chunk_index", { ascending: true })
      .limit(500);
    if (allErr) console.error("[getFullPageText] allChunks error:", allErr.message);
    if (!allChunks || !allChunks.length) return null;
    return allChunks.map(c => c.chunk_text).join("\n");
  }

  // Find document IDs that have at least one chunk matching the keyword
  const { data: matchingChunks, error: matchErr } = await supabase
    .from("knowledge_chunks")
    .select("document_id")
    .eq("tenant_id", tenantId)
    .ilike("chunk_text", keyword);
  if (matchErr) console.error("[getFullPageText] matchingChunks error:", matchErr.message);
  if (!matchingChunks || !matchingChunks.length) return null;

  const docIds = [...new Set(matchingChunks.map(c => c.document_id))];

  // Get ALL chunks for those documents, in order
  const { data: allChunks, error: chunksErr } = await supabase
    .from("knowledge_chunks")
    .select("chunk_text, chunk_index")
    .eq("tenant_id", tenantId)
    .in("document_id", docIds)
    .order("chunk_index", { ascending: true });
  if (chunksErr) console.error("[getFullPageText] allChunks error:", chunksErr.message);
  if (!allChunks || !allChunks.length) return null;

  return allChunks.map(c => c.chunk_text).join("\n");
}

async function suggestAgentField(field, knowledgeText) {
  // Accept either a field key string or a full field definition object
  const fieldKey         = typeof field === "string" ? field : (field.key || "");
  const fieldLabel       = typeof field === "object" && field.label       ? field.label       : fieldKey.replace(/_/g, " ");
  const fieldHint        = typeof field === "object" && field.hint        ? field.hint        : "";
  const fieldPlaceholder = typeof field === "object" && field.placeholder ? field.placeholder : "";

  let prompt;
  if (fieldKey === "coaches") {
    // Specialised extraction for coaches — structured format required
    prompt = `You are extracting coach/instructor names and phone numbers from business website content.\nList every named coach or instructor you can find.\nReturn ONLY a plain list, one per line, in this format:\nName | phone_number\nIf no phone number is available, just use the name alone.\nIf no coaches are found, return an empty string.\nDo not include explanations, headers, or any other text.`;
  } else {
    // Generic extraction — use the field's label, hint and placeholder as context
    prompt = [
      `You are filling in a field for a customer service assistant, based on content scraped from a business website.`,
      `Field name: "${fieldLabel}"`,
      fieldHint        ? `Format guidance: ${fieldHint}`        : "",
      fieldPlaceholder ? `Example of expected format:\n${fieldPlaceholder}` : "",
      ``,
      `Extract the most relevant content from the website text to populate this field.`,
      `Return ONLY the field value — no labels, no headings, no explanation.`,
      `If the information is not present in the text, return an empty string.`
    ].filter(Boolean).join("\n");
  }

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: prompt },
      { role: "user",   content: knowledgeText }
    ],
    temperature: 0,
    max_tokens: 400
  });
  const result = (resp.choices[0].message.content || "").trim();
  return result || null;
}

// After signup crawl completes, backfill any empty suggest_from_knowledge fields
// in tenant_agents using the already-indexed knowledge_chunks.
async function backfillEmptyAgentFields(tenantId) {
  try {
    const { data: tenantAgents } = await supabase
      .from("tenant_agents")
      .select("id, agent_id, config")
      .eq("tenant_id", tenantId)
      .eq("is_active", true);
    if (!tenantAgents || !tenantAgents.length) return;

    const agentIds = tenantAgents.map(ta => ta.agent_id);
    const { data: defs } = await supabase
      .from("agent_definitions")
      .select("id, config_schema")
      .in("id", agentIds);
    if (!defs || !defs.length) return;

    const defMap = {};
    defs.forEach(d => { defMap[d.id] = d; });

    // Reconstruct full page text for pages mentioning coaches — no size limits
    const combined = await getFullPageTextForKeyword(tenantId, "%coach%");
    if (!combined) {
      console.log(`[backfill] No knowledge chunks yet for ${tenantId} — skipping`);
      return;
    }

    for (const ta of tenantAgents) {
      const def = defMap[ta.agent_id];
      if (!def?.config_schema?.fields) continue;

      const config  = { ...(ta.config || {}) };
      let   updated = false;

      for (const field of def.config_schema.fields) {
        // Populate any KB-backed or freetext field that isn't already filled
        const isKbField = field.suggest_from_knowledge || field.type === "textarea" || field.type === "multiline";
        if (!isKbField) continue;
        if (config[field.key] && String(config[field.key]).trim()) continue; // already populated

        try {
          const suggestion = await suggestAgentField(field, combined);
          if (suggestion) {
            config[field.key] = suggestion;
            updated = true;
            console.log(`[backfill] Filled ${field.key} for ${ta.agent_id} / ${tenantId}: ${suggestion.slice(0, 60)}…`);
          } else {
            console.log(`[backfill] No suggestion found for ${field.key} / ${ta.agent_id} / ${tenantId}`);
          }
        } catch (e) {
          console.error(`[backfill] LLM error for ${field.key}:`, e.message);
        }
      }

      if (updated) {
        await supabase.from("tenant_agents").update({ config }).eq("id", ta.id);
      }
    }
    console.log(`[backfill] Agent field backfill complete for ${tenantId}`);
  } catch (err) {
    console.error(`[backfill] Error for ${tenantId}:`, err.message);
  }
}

// ── Agent state machine ───────────────────────────────────────────────────────

// Start a new agent session for this user. Called when agentTrigger is received.
async function startAgent(userId, agentId, tenantId) {
  const convo = ensureConversation(userId);

  // Load agent definition
  const { data: agentDef, error: agentErr } = await supabase
    .from("agent_definitions")
    .select("*")
    .eq("id", agentId)
    .maybeSingle();
  if (agentErr || !agentDef) return { reply: "Sorry, I couldn't start that process. Please try again.", choices: [] };

  // Load tenant config
  const { data: tenantAgent } = await supabase
    .from("tenant_agents")
    .select("id, config, is_active")
    .eq("tenant_id", tenantId)
    .eq("agent_id", agentId)
    .maybeSingle();

  if (!tenantAgent || !tenantAgent.is_active) {
    return { reply: "This feature isn't available right now. Please contact us directly.", choices: [] };
  }

  const config = tenantAgent.config || {};

  // Load skill definitions
  const { data: skillDefs } = await supabase
    .from("skill_definitions")
    .select("*")
    .in("id", agentDef.skill_ids || []);
  const skillMap = {};
  (skillDefs || []).forEach(s => { skillMap[s.id] = s; });

  // Set initial agent state
  const firstStep = (agentDef.steps || [])[0];
  convo.agentState = {
    agentId,
    tenantAgentInstanceId: tenantAgent.id,  // UUID of tenant_agents row — used for lead storage
    agentName:  agentDef.name,
    agentDef,
    tenantConfig: config,
    skillMap,
    stepId:     firstStep?.id || null,
    collected:  {},
    skillState: null,
    tenantId
  };

  // Run the first step immediately (greeting)
  return runCurrentStep(convo, null);
}

// Process a user message against the active agent state.
async function handleAgentMessage(userId, message, tenantId) {
  const convo = ensureConversation(userId);
  const state  = convo.agentState;
  if (!state) return null;

  const trimmed = message.trim();
  const lower   = trimmed.toLowerCase();

  // Cancel at any time
  if (/^(cancel|stop|exit|quit|never mind|no thanks)$/i.test(lower)) {
    convo.agentState = null;
    return { reply: "No problem at all — let me know if there's anything else I can help with! 😊", choices: [] };
  }

  return runCurrentStep(convo, trimmed);
}

// Core dispatcher — runs the current step with the given user input (null on start).
async function runCurrentStep(convo, userInput) {
  const state  = convo.agentState;
  const steps  = state.agentDef.steps || [];
  const step   = steps.find(s => s.id === state.stepId);

  if (!step) {
    convo.agentState = null;
    return { reply: "Something went wrong. Please try again.", choices: [] };
  }

  // ── Greeting step ─────────────────────────────────────────────────────────
  if (step.type === "greeting") {
    if (userInput === null) {
      // First call — show greeting + choices
      const intro  = fillTemplate(state.tenantConfig[step.message_key] || "", state.collected);
      // static_choices in step def take priority over config-driven choices_key
      const types  = step.static_choices ||
        (state.tenantConfig[step.choices_key] || "")
          .split("\n").map(s => s.trim().replace(/,+$/, "")).filter(Boolean);

      // No choices — show intro and immediately advance to the next step
      if (!types.length) {
        state.stepId     = step.default_next;
        state.skillState = null;
        const nextResult = await runCurrentStep(convo, null);
        if (intro && nextResult.reply) nextResult.reply = `${intro}\n\n${nextResult.reply}`;
        return nextResult;
      }

      const prompt = step.prompt || "What would you like?";
      const reply  = intro ? `${intro}\n\n${prompt}` : prompt;
      return { reply, choices: types };
    }

    // User has responded — store their choice
    state.collected[step.collect_field] = userInput;

    // Check branches (e.g. Junior → ask child age)
    const lower = userInput.toLowerCase();
    let nextId  = step.default_next;
    for (const branch of (step.branches || [])) {
      if (lower.includes(branch.if_value_contains.toLowerCase())) {
        nextId = branch.next;
        break;
      }
    }

    state.stepId     = nextId;
    state.skillState = null;
    return runCurrentStep(convo, null);
  }

  // ── Collect step ──────────────────────────────────────────────────────────
  if (step.type === "collect") {
    if (userInput === null) {
      // Support choices_key for button-based collection (e.g. coach picker)
      // Lines may be plain "Name" or "Name | +353XXXXXXX" — split into {label, value} objects
      // so the button shows only the name but the full string (with phone) is stored.
      const rawLines = step.static_choices
        ? step.static_choices
        : (state.tenantConfig[step.choices_key] || "").split("\n").map(s => s.trim().replace(/,+$/, "")).filter(Boolean);
      const choices = step.choices_key
        ? rawLines.map(line => {
            const pipeIdx = line.indexOf(" | ");
            if (pipeIdx !== -1) return { label: line.slice(0, pipeIdx).trim(), value: line.trim() };
            return line;
          })
        : [];
      return { reply: step.prompt, choices };
    }

    // Validate and store
    const trimmed = userInput.trim();
    if (!trimmed) {
      return { reply: `Could you share ${step.collect_field.replace(/_/g, " ")}? It helps us get things set up for you.`, choices: [] };
    }
    state.collected[step.collect_field] = trimmed;
    state.stepId     = step.next;
    state.skillState = null;
    return runCurrentStep(convo, null);
  }

  // ── Skill step ────────────────────────────────────────────────────────────
  if (step.type === "skill") {
    const skillDef = state.skillMap[step.skill_id];
    if (!skillDef) {
      state.stepId = step.next;
      return runCurrentStep(convo, null);
    }

    // ── lead_capture skill ────────────────────────────────────────────────
    if (step.skill_id === "lead_capture") {
      // First entry — initialise skill state
      if (!state.skillState) {
        const result = startLeadCaptureSkill(state, skillDef);
        return result;
      }

      // Subsequent messages — advance skill
      const result = advanceLeadCaptureSkill(state, userInput);
      if (!result.done) return result;

      // Skill complete — merge collected data and advance to next step
      Object.assign(state.collected, result.data || {});
      state.stepId     = step.next;
      state.skillState = null;
      return runCurrentStep(convo, null);
    }

    // ── notify_and_confirm skill ──────────────────────────────────────────
    if (step.skill_id === "notify_and_confirm") {
      const result = await runNotifyAndConfirmSkill(
        state.tenantId,
        state.agentId,
        state.tenantAgentInstanceId,
        state.agentName,
        state.collected,
        state.tenantConfig
      );
      // Agent complete — clear state
      convo.agentState = null;
      return result;
    }

    // Unknown skill — skip
    state.stepId = step.next;
    return runCurrentStep(convo, null);
  }

  // ── Availability check step ───────────────────────────────────────────────
  // Fetches live court slots from EBO, shows them as choices, stores selection.
  if (step.type === "availability_check") {
    if (userInput !== null) {
      if (userInput === "__enquire__") {
        state.stepId = step.next;
        state.skillState = null;
        return runCurrentStep(convo, null);
      }
      // Date selected from day picker — store and show courts for that date
      if (userInput.startsWith("__date__")) {
        state.collected._avail_date      = userInput.slice(8); // "YYYY-MM-DD"
        state.collected._avail_date_label = userInput.slice(8);
        delete state.collected.__no_slots__;
        return runCurrentStep(convo, null);
      }
      // Back to day picker
      if (userInput === "__back_to_days__") {
        delete state.collected._avail_date;
        delete state.collected._avail_date_label;
        delete state.collected.__no_slots__;
        return runCurrentStep(convo, null);
      }
      // Slot(s) confirmed — store and advance
      state.collected[step.collect_field] = userInput;
      state.stepId     = step.next;
      state.skillState = null;
      delete state.collected._avail_date;
      delete state.collected._avail_date_label;
      return runCurrentStep(convo, null);
    }

    // userInput === null — show day picker first, then courts once a day is chosen
    await loadEboConfigFromDb(state.tenantId);
    const eboCfg = EBO_CONFIG[state.tenantId];
    if (!eboCfg) {
      return {
        reply: "Online court availability isn't connected yet for this club. Let me take your details and someone will confirm a time with you shortly.",
        choices: []
      };
    }

    const now      = new Date();
    const irishFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" });

    // ── Day picker — shown until user selects a date ──────────────────────
    if (!state.collected._avail_date) {
      const dayChoices = [];
      for (let i = 0; i < 5; i++) {
        const d         = new Date(now.getTime() + i * 86400000);
        const isoDate   = irishFmt.format(d);
        const dayLabel  = i === 0 ? "Today"
          : i === 1 ? "Tomorrow"
          : new Intl.DateTimeFormat("en-GB", {
              timeZone: "Europe/Dublin", weekday: "short", day: "numeric", month: "short"
            }).format(d);
        dayChoices.push({ label: dayLabel, value: `__date__${isoDate}` });
      }
      const isMulti = step.multi_select || false;
      const maxSel  = step.max_select   || 3;
      return {
        reply: isMulti
          ? `Which day suits you? 📅 You can pick up to ${maxSel} slots — or fewer if you prefer.`
          : "Which day would you like to play? 📅",
        choices: dayChoices
      };
    }

    // ── Slots for chosen date ─────────────────────────────────────────────
    const checkDate = state.collected._avail_date;
    const isToday   = checkDate === irishFmt.format(now);
    const dateLabel = isToday ? "today"
      : new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Dublin", weekday: "long", day: "numeric", month: "long"
        }).format(new Date(checkDate + "T12:00:00"));

    try {
      const bookings = await fetchEboBookings(state.tenantId, checkDate);

      function toMins(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }
      function toHHMM(mins) { return String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0"); }

      const slotMins  = eboCfg.slotMinutes || 60;
      const openMins  = toMins(eboCfg.openTime  || "08:00");
      const closeMins = toMins(eboCfg.closeTime || "22:00");

      const allSlots = [];
      for (let t = openMins; t + slotMins <= closeMins; t += slotMins) allSlots.push(toHHMM(t));

      // Derive court list from bookings (unique court IDs), sorted numerically
      const allCourtIds = [...new Set(bookings.map(b => String(b.court_id)).filter(Boolean))]
        .sort((a, b) => Number(a) - Number(b));
      const totalCourts = allCourtIds.length || eboCfg.courtCount || 1;

      // Track which court IDs are booked at each slot start time
      const bookedCourtsPerSlot = {};
      bookings.forEach(b => {
        const hhmm = String(b.time || "").slice(11, 16);
        const cid  = String(b.court_id || "");
        if (hhmm && cid) {
          if (!bookedCourtsPerSlot[hhmm]) bookedCourtsPerSlot[hhmm] = new Set();
          bookedCourtsPerSlot[hhmm].add(cid);
        }
      });

      // Build free-slot data per time slot
      let allFreeSlots = allSlots
        .map(s => {
          const booked     = bookedCourtsPerSlot[s] || new Set();
          const freeCourts = allCourtIds.filter(id => !booked.has(id));
          const freeCount  = allCourtIds.length ? freeCourts.length : totalCourts;
          return { slot: s, freeCourts, freeCount };
        })
        .filter(({ freeCount }) => freeCount > 0);

      // Today: strip past / imminent slots (within 30 min)
      if (isToday) {
        const irishTime = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Dublin", hour: "2-digit", minute: "2-digit", hour12: false
        }).format(now);
        const [ih, im] = irishTime.split(":").map(Number);
        const nowMins  = ih * 60 + im;
        allFreeSlots = allFreeSlots.filter(({ slot }) => toMins(slot) > nowMins + 30);
      }

      if (!allFreeSlots.length) {
        state.collected.__no_slots__ = dateLabel;
        return {
          reply: `Sorry, there don't seem to be any available slots ${dateLabel}. Would you like to check tomorrow or enquire directly with the club?`,
          choices: [
            { label: "Check Tomorrow",   value: "Tomorrow" },
            { label: "Enquire Directly", value: "__enquire__" }
          ]
        };
      }

      // Use the human-readable date label (e.g. "Today", "Thursday 12 June")
      state.collected.booking_date = isToday ? "Today" : dateLabel;

      const isMulti  = step.multi_select || false;
      const maxSel   = step.max_select   || 3;

      // ── No court IDs known (no bookings yet today) — flat slot list ───────
      if (!allCourtIds.length) {
        return {
          reply: isMulti
            ? `Here are available slots ${dateLabel} 🎾 Pick up to ${maxSel} times that suit you, then tap Confirm.`
            : `Here are available slots ${dateLabel} 🎾 Which works best for you?`,
          choices: allFreeSlots.slice(0, 8).map(({ slot }) => {
            const endTime = toHHMM(toMins(slot) + slotMins);
            return { label: `${slot} – ${endTime}`, value: `${state.collected.booking_date} ${slot}–${endTime}` };
          }),
          multiSelect: isMulti,
          maxSelect:   maxSel
        };
      }

      // ── Court IDs known — return courts with nested slot arrays ───────────
      // The widget renders this as an accordion: tap court → slots appear below
      const courtsWithSlots = allCourtIds
        .map(id => {
          const courtFreeSlots = allFreeSlots.filter(({ freeCourts }) => freeCourts.includes(id));
          return {
            label: `Court ${id}`,
            value: id,          // sent to backend when a slot is chosen (not the court)
            badge: courtFreeSlots.length,
            slots: courtFreeSlots.map(({ slot }) => {
              const endTime = toHHMM(toMins(slot) + slotMins);
              return {
                label: `${slot} – ${endTime}`,
                value: `${state.collected.booking_date} ${slot}–${endTime} Court ${id}`
              };
            })
          };
        })
        .filter(c => c.slots.length > 0);

      return {
        reply: isMulti
          ? `Here are the courts available ${dateLabel} 🎾 Tap a court, then pick up to ${maxSel} slots that suit you.`
          : `Here are the courts available ${dateLabel} 🎾 Tap a court to see its free slots.`,
        choices:     courtsWithSlots,
        multiSelect: isMulti,
        maxSelect:   maxSel
      };

    } catch (err) {
      console.error("[agent] availability_check error:", err.message);
      state.stepId = step.next;
      return runCurrentStep(convo, null);
    }
  }

  // ── Message step ────────────────────────────────────────────────────────────
  // Displays a final message with an optional external-URL button, then ends the flow.
  if (step.type === "message") {
    const text   = fillTemplate(step.message || state.tenantConfig[step.message_key] || "", state.collected);
    const urlRaw = step.url_key ? (state.tenantConfig[step.url_key] || "") : (step.url || "");
    const url    = fillTemplate(urlRaw, state.collected);
    const choices = [];
    if (url) choices.push({ label: step.url_label || "Book online →", value: `__url__${url}` });
    // Always offer a way back to the main menu
    choices.push({ label: "↩ Back to menu", value: "__menu__", secondary: true });
    convo.agentState = null; // flow ends here
    return { reply: text, choices };
  }

  // Unknown step type
  convo.agentState = null;
  return { reply: "Something went wrong. Please try again.", choices: [] };
}

// ── Integrations API endpoints ────────────────────────────────────────────────

// GET /api/portal/integrations — catalog filtered by tenant business_type + connection status
app.get("/api/portal/integrations", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  try {
    const [{ data: tenant }, { data: connected }] = await Promise.all([
      supabase.from("tenants").select("business_type").eq("id", tenantId).maybeSingle(),
      supabase.from("tenant_integrations").select("provider, config, is_active, updated_at").eq("tenant_id", tenantId)
    ]);
    const bizType  = tenant?.business_type || "other";
    const connMap  = {};
    (connected || []).forEach(c => { connMap[c.provider] = c; });

const result = INTEGRATION_CATALOG
      .filter(i => !i.business_types || i.business_types.includes(bizType))
      .map(i => {
        // Decrypt config and strip sensitive fields before sending to browser
        const rawConfig  = connMap[i.provider]?.config || {};
        const decConfig  = decryptIntgConfig(rawConfig);
        const publicConfig = {};
        Object.entries(decConfig).forEach(([k, v]) => {
          if (!INTG_SENSITIVE_FIELDS.includes(k)) publicConfig[k] = v;
        });
        return {
          provider:     i.provider,
          name:         i.name,
          logo_html:    i.logo_html,
          description:  i.description,
          coming_soon:  i.coming_soon || false,
          fields:       i.fields,
          connected:    !!(connMap[i.provider]?.is_active),
          updated_at:   connMap[i.provider]?.updated_at || null,
          saved_config: publicConfig   // no credentials — only non-sensitive values
        };
      });

    res.json(result);
  } catch (err) {
    console.error("[integrations] GET error:", err.message);
    res.status(500).json({ error: "Failed to load integrations" });
  }
});

// PUT /api/portal/integrations/:provider — save / update integration config
app.put("/api/portal/integrations/:provider", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { provider } = req.params;
  const { config }   = req.body;
  if (!INTEGRATION_CATALOG.find(i => i.provider === provider)) {
    return res.status(400).json({ error: "Unknown integration provider" });
  }
  try {
    // Merge with existing config so blank fields don't overwrite saved credentials
    const { data: existing } = await supabase.from("tenant_integrations")
      .select("config").eq("tenant_id", tenantId).eq("provider", provider).maybeSingle();
    // Decrypt existing before merging so we don't double-encrypt
    const existingDecrypted = decryptIntgConfig(existing?.config || {});
    const mergedConfig = Object.assign({}, existingDecrypted);
    Object.entries(config).forEach(([k, v]) => { if (v && String(v).trim()) mergedConfig[k] = String(v).trim(); });

    // Encrypt sensitive fields before storing
    const encryptedConfig = encryptIntgConfig(mergedConfig);

    const { error } = await supabase.from("tenant_integrations").upsert(
      { tenant_id: tenantId, provider, config: encryptedConfig, is_active: true, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id,provider" }
    );
    if (error) throw error;

    // Immediately update in-memory EBO_CONFIG using plaintext mergedConfig (pre-encryption)
    if (provider === "ebookingonline" && mergedConfig?.club_id && mergedConfig?.username && mergedConfig?.password) {
      EBO_CONFIG[tenantId] = {
        clubId:      mergedConfig.club_id,
        username:    mergedConfig.username,
        password:    mergedConfig.password,
        openTime:    mergedConfig.open_time    || "08:00",
        closeTime:   mergedConfig.close_time   || "22:00",
        slotMinutes: parseInt(mergedConfig.slot_minutes || "60", 10)
      };
      delete eboTokenCache[tenantId];
      console.log(`[EBO] Config updated from portal for ${tenantId}`);
    }

    // Clear Twilio cache so next use picks up new credentials
    if (provider === "twilio") {
      delete TWILIO_CONFIG[tenantId];
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[integrations] PUT error:", err.message);
    res.status(500).json({ error: "Failed to save integration" });
  }
});

// DELETE /api/portal/integrations/:provider — disconnect integration
app.delete("/api/portal/integrations/:provider", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { provider } = req.params;
  try {
    const { error } = await supabase.from("tenant_integrations")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("provider", provider);
    if (error) throw error;

    // Clear from in-memory cache immediately so chat stops using old credentials
    if (provider === "ebookingonline") {
      delete EBO_CONFIG[tenantId];
      delete eboTokenCache[tenantId];
    }
    if (provider === "twilio") {
      delete TWILIO_CONFIG[tenantId];
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[integrations] DELETE error:", err.message);
    res.status(500).json({ error: "Failed to disconnect integration" });
  }
});

// ── Agent API endpoints ───────────────────────────────────────────────────────

// GET /api/portal/agent-definitions — agent definitions filtered by tenant business_type
app.get("/api/portal/agent-definitions", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  try {
    const { data: tenant } = await supabase
      .from("tenants")
      .select("business_type")
      .eq("id", tenantId)
      .maybeSingle();
    const bizType = tenant?.business_type || "other";

    const { data, error } = await supabase
      .from("agent_definitions")
      .select("id, name, description, version, skill_ids, config_schema, business_types")
      .order("name");
    if (error) throw error;

    // Filter: show agent if business_types is null (universal) OR includes this tenant's type
    const filtered = (data || []).filter(d =>
      !d.business_types || d.business_types.includes(bizType)
    );
    res.json(filtered);
  } catch (err) {
    console.error("[agent-defs] GET error:", err.message);
    res.status(500).json({ error: "Failed to load agent definitions" });
  }
});

// GET /api/portal/agents — this tenant's activated agent instances
app.get("/api/portal/agents", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  try {
    const { data, error } = await supabase
      .from("tenant_agents")
      .select("id, agent_id, is_active, config, created_at, updated_at")
      .eq("tenant_id", tenantId)
      .order("created_at");
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("[agents] GET error:", err.message);
    res.status(500).json({ error: "Failed to load agents" });
  }
});

// POST /api/portal/agents — activate an agent for this tenant
app.post("/api/portal/agents", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { agent_id } = req.body;
  if (!agent_id) return res.status(400).json({ error: "agent_id required" });
  try {
    const { data, error } = await supabase
      .from("tenant_agents")
      .upsert(
        { tenant_id: tenantId, agent_id, is_active: false, config: {}, updated_at: new Date().toISOString() },
        { onConflict: "tenant_id,agent_id" }
      )
      .select("id, agent_id, is_active, config")
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("[agents] POST error:", err.message);
    res.status(500).json({ error: "Failed to activate agent" });
  }
});

// PUT /api/portal/agents/:tenantAgentId — update config and/or is_active
app.put("/api/portal/agents/:tenantAgentId", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { tenantAgentId } = req.params;
  const updates = {};
  if (req.body.config    !== undefined) updates.config    = req.body.config;
  if (req.body.is_active !== undefined) updates.is_active = req.body.is_active;
  if (!Object.keys(updates).length) return res.status(400).json({ error: "Nothing to update" });
  updates.updated_at = new Date().toISOString();
  try {
    const { error } = await supabase
      .from("tenant_agents")
      .update(updates)
      .eq("id", tenantAgentId)
      .eq("tenant_id", tenantId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("[agents] PUT error:", err.message);
    res.status(500).json({ error: "Failed to update agent" });
  }
});

// DELETE /api/portal/agents/:tenantAgentId — remove agent instance
app.delete("/api/portal/agents/:tenantAgentId", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { tenantAgentId } = req.params;
  try {
    const { error } = await supabase
      .from("tenant_agents")
      .delete()
      .eq("id", tenantAgentId)
      .eq("tenant_id", tenantId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("[agents] DELETE error:", err.message);
    res.status(500).json({ error: "Failed to remove agent" });
  }
});

// POST /api/portal/agents/:tenantAgentId/suggest-field
// Reads knowledge_chunks for this tenant and uses LLM to suggest a field value
app.post("/api/portal/agents/:tenantAgentId/suggest-field", requireTenant, async (req, res) => {
  const tenantId       = req.tenant.tenantId;
  const tenantAgentId  = req.params.tenantAgentId;
  const { field: fieldKey } = req.body;
  if (!fieldKey) return res.status(400).json({ error: "field required" });

  try {
    // Look up the full field definition so LLM has label/hint/placeholder context
    let fieldDef = fieldKey; // fallback: just pass the key string
    try {
      const { data: ta } = await supabase.from("tenant_agents").select("agent_id").eq("id", tenantAgentId).single();
      if (ta?.agent_id) {
        const { data: def } = await supabase.from("agent_definitions").select("config_schema").eq("id", ta.agent_id).single();
        const found = (def?.config_schema?.fields || []).find(function(f) { return f.key === fieldKey; });
        if (found) fieldDef = found;
      }
    } catch (e) { /* non-fatal — fall back to key string */ }

    const keyword = fieldKey === "coaches" ? "%coach%" : "%";
    const combined = await getFullPageTextForKeyword(tenantId, keyword);

    if (!combined) {
      return res.json({ suggestion: null, message: "No website content found yet — make sure the website crawl has completed." });
    }

    const suggestion = await suggestAgentField(fieldDef, combined);
    if (!suggestion) {
      return res.json({ suggestion: null, message: "No relevant content found in your knowledge base for this field." });
    }
    res.json({ suggestion });
  } catch (err) {
    console.error("[suggest-field] Error:", err.message);
    res.status(500).json({ error: "Failed to generate suggestion" });
  }
});

// GET /api/portal/agent-leads — leads for a tenant_agent instance
// ?agent_instance_id=<tenant_agents.id>
app.get("/api/portal/agent-leads", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { agent_instance_id } = req.query;
  try {
    let query = supabase
      .from("skill_leads")
      .select("id, agent_id, data, status, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (agent_instance_id) query = query.eq("agent_id", agent_instance_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("[agent-leads] GET error:", err.message);
    res.status(500).json({ error: "Failed to load leads" });
  }
});

// PUT /api/portal/agent-leads/:leadId — update lead status
app.put("/api/portal/agent-leads/:leadId", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { leadId } = req.params;
  const { status } = req.body;
  if (!["new", "contacted", "closed"].includes(status)) return res.status(400).json({ error: "Invalid status" });
  try {
    const { error } = await supabase
      .from("skill_leads")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", leadId)
      .eq("tenant_id", tenantId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("[agent-leads] PUT error:", err.message);
    res.status(500).json({ error: "Failed to update lead status" });
  }
});

// ── CORS for the public chat endpoint (widget embeds on external sites) ───────
app.use("/chat", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Lead capture — saves a name + email from the chat widget ─────────────────
app.post("/api/chat/lead", async (req, res) => {
  const { clubId, name, email, source, message } = req.body;
  if (!clubId || !email) return res.status(400).json({ error: "Missing clubId or email" });
  const { error } = await supabase.from("leads").insert({
    tenant_id: clubId,
    name:      (name  || "").trim() || null,
    email:     email.toLowerCase().trim(),
    source:    source || null,
    message:   (message || "").trim() || null,
  });
  if (error) { console.error("[lead] Insert error:", error.message); return res.status(500).json({ error: "Could not save lead" }); }
  console.log(`[lead] Saved lead for ${clubId}: ${email}`);
  res.json({ ok: true });
});

// GET /api/portal/unanswered-questions — questions the chat couldn't answer
app.get("/api/portal/debug-retrieval", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const question = req.query.question || "";
    if (!question) return res.status(400).json({ error: "question param required" });
    const { data: tenantData } = await supabase.from("tenants").select("name").eq("id", tenantId).single();
    const orgName = tenantData?.name || tenantId;
    const chunks = await findRelevantKnowledgeChunks(question, 8, tenantId, "", orgName);
    return res.json({ question, orgName, chunks });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/portal/unanswered-questions", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const since = new Date(); since.setDate(since.getDate() - 30);
    const { data: logs, error } = await supabase
      .from("chat_logs")
      .select("id, conversation_id, sender, message, answer_source, created_at")
      .eq("tenant_id", tenantId)
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: true });
    if (error) throw error;

    // Pair each generic bot response with the preceding customer message
    const rows = logs || [];
    const questionMap = {};
    rows.forEach((row, i) => {
      if (row.sender === "bot" && row.answer_source === "generic") {
        const preceding = [...rows].slice(0, i).reverse()
          .find(r => r.conversation_id === row.conversation_id && r.sender === "customer");
        if (preceding?.message) {
          const key = preceding.message.trim().toLowerCase();
          if (!questionMap[key]) {
            questionMap[key] = { question: preceding.message.trim(), count: 0, last_asked: preceding.created_at };
          }
          questionMap[key].count++;
          if (preceding.created_at > questionMap[key].last_asked) questionMap[key].last_asked = preceding.created_at;
        }
      }
    });

    const questions = Object.values(questionMap)
      .sort((a, b) => b.count - a.count || new Date(b.last_asked) - new Date(a.last_asked))
      .slice(0, 50);
    res.json(questions);
  } catch (err) {
    console.error("[unanswered-questions]", err.message);
    res.status(500).json({ error: "Failed to fetch unanswered questions." });
  }
});

// GET /api/portal/leads — returns captured leads for this tenant
app.get("/api/portal/leads", requireTenant, async (req, res) => {
  const { data, error } = await supabase
    .from("leads")
    .select("id, name, email, source, message, created_at")
    .eq("tenant_id", req.tenant.tenantId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post("/chat", chatLimiter, async (req, res) => {
  try {
    const { userId, conversationId, message, voiceMode, clubId, workflowContext, agentTrigger } = req.body;
    const tenantId = clubId || "aom";

    // ── Look up this tenant's business mode, name and feature flags ──────────
    let effectiveMode = businessMode; // global default ('mortgage')
    let tenantDisplayName = null;
    let tenantBusinessDesc = null;
    let tenantAssistantName = "Maeve";
    let tenantPhone = null;
    let tenantEmail = null;
    let tenantData = null;
    try {
      const { data: _tenantData } = await supabase
        .from("tenants")
        .select("business_mode, name, email, ai_enabled, business_description, phone, assistant_name, monthly_chat_limit")
        .eq("id", tenantId)
        .maybeSingle();
      tenantData = _tenantData;
      if (tenantData?.business_mode) effectiveMode = tenantData.business_mode;
      if (tenantData?.name) tenantDisplayName = tenantData.name;
      else tenantDisplayName = tenantId.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      if (tenantData?.business_description) tenantBusinessDesc = tenantData.business_description;
      if (tenantData?.assistant_name) tenantAssistantName = tenantData.assistant_name;
      tenantPhone = tenantData?.phone || null;
      tenantEmail = tenantData?.email || null;
      // Respect AI Receptionist on/off toggle (null/undefined = enabled by default)
      if (tenantData?.ai_enabled === false) {
        return res.json({ reply: "The AI assistant is currently unavailable. Please contact us directly." });
      }
    } catch {}

    // ── IP-based conversation start rate limit (anti-abuse) ──────────────────
    if (conversationId && !checkIpConvoLimit(req.ip, tenantId, conversationId)) {
      return res.json({ reply: "Too many new conversations from your connection. Please try again later." });
    }

    // ── Per-tenant hourly cap (defeats IP rotation attacks) ───────────────────
    if (conversationId) {
      const { allowed, count, nearLimit } = checkTenantHourlyCap(tenantId, conversationId);
      if (!allowed) {
        console.warn(`[abuse] Tenant ${tenantId} hit hourly hard cap (${TENANT_HOURLY_CONVO_HARD_CAP} convos/hr)`);
        return res.json({ reply: "Our chat is experiencing unusually high traffic right now. Please try again shortly or contact us directly." });
      }
      if (nearLimit) {
        markTenantHourlyAlerted(tenantId);
        console.warn(`[abuse] Tenant ${tenantId} approaching hourly cap: ${count} new convos this hour`);
        // Fire-and-forget alert email to tenant
        if (tenantEmail) {
          sendChatLimitWarning(tenantEmail, tenantDisplayName, count, TENANT_HOURLY_CONVO_HARD_CAP)
            .catch(() => {});
        }
      }
    }

    // ── Monthly chat limit check ──────────────────────────────────────────────
    // Only checked for new conversations (conversationId present). null limit = unlimited.
    const chatMonthlyLimit = tenantData?.monthly_chat_limit ?? null;
    if (chatMonthlyLimit !== null && conversationId) {
      try {
        const { count: usedThisMonth, month: usageMonth } = await getChatUsageThisMonth(tenantId);
        if (usedThisMonth >= chatMonthlyLimit) {
          const contactParts = [];
          if (tenantPhone) contactParts.push(`📞 ${tenantPhone}`);
          if (tenantEmail) contactParts.push(`📧 ${tenantEmail}`);
          const contactLine = contactParts.length ? "\n\n" + contactParts.join("\n") : "";
          const nextReset = new Date();
          nextReset.setMonth(nextReset.getMonth() + 1);
          nextReset.setDate(1);
          const resetDate = nextReset.toLocaleDateString("en-IE", { day: "numeric", month: "long" });
          return res.json({
            reply: `Our AI assistant has reached its monthly conversation limit. Please contact us directly:${contactLine}\n\nFull service resumes on ${resetDate}.`
          });
        }
        const warnKey = `${tenantId}-${usageMonth}`;
        if (!warned80pct.has(warnKey) && usedThisMonth >= Math.floor(chatMonthlyLimit * 0.8)) {
          warned80pct.add(warnKey);
          sendChatLimitWarning(tenantEmail, tenantDisplayName, usedThisMonth, chatMonthlyLimit).catch(() => {});
        }
      } catch (limitErr) {
        console.error("[chat-limit]", limitErr.message);
      }
    }

    // General mode tenants don't collect personal data — skip consent gate
    if (effectiveMode === "general") {
      const convo = ensureConversation(userId);
      convo.consentGiven = true;
    }

    // ── Agent engine intercept ─────────────────────────────────────────────
    // Must run before the GDPR gate so agents can run in general mode without
    // consent friction (they collect data explicitly with user participation).
    if (agentTrigger || ensureConversation(userId).agentState) {
      try {
        let agentResult;
        if (agentTrigger) {
          agentResult = await startAgent(userId, agentTrigger, tenantId);
        } else {
          agentResult = await handleAgentMessage(userId, message, tenantId);
        }
        if (agentResult) {
          addChatLog({ userId, conversationId, tenantId, sender: "customer", message: message || `[started agent: ${agentTrigger}]`, timestamp: new Date() });
          addChatLog({ userId, conversationId, tenantId, sender: "bot",      message: agentResult.reply,  timestamp: new Date() });
          return res.json({ reply: agentResult.reply, agentChoices: agentResult.choices || [], multiSelect: agentResult.multiSelect || false, maxSelect: agentResult.maxSelect || 3 });
        }
      } catch (agentErr) {
        console.error("[agent] Error:", agentErr.message);
        ensureConversation(userId).agentState = null;
        return res.json({ reply: "Something went wrong — please try again.", agentChoices: [] });
      }
    }

    if (!userId || !message) {
      return res.status(400).json({ error: "userId and message are required" });
    }

    const trimmedMessage = message.trim();
    const lowerMessage = trimmedMessage.toLowerCase();

    let result = {
      reply: "How can I help you today?"
    };

    const convo = ensureConversation(userId);

    if (convo.completed) {
      return res.json({
        reply: "This chat has ended. Please refresh the page to start again."
      });
    }

    // 🔒 GDPR Consent check
    if (!convo.consentGiven) {

      const consentWords = /\byes\b|\bok\b|\bokay\b|\byeah\b|\bsure\b|\byep\b|\bfine\b|\balright\b|\babsolutely\b|\bof course\b|\bgo ahead\b|\bno problem\b|\bsounds good\b|\bgrand\b/i;

      if (consentWords.test(lowerMessage)) {
        convo.consentGiven = true;

        result.reply =
          "Perfect. I can help with applying for a mortgage, booking an appointment, or answering any questions. What would you like to do?";

      } else if (
        lowerMessage.includes("no") ||
        lowerMessage.includes("don’t") ||
        lowerMessage.includes("dont") ||
        lowerMessage.includes("stop")
      ) {
        result.reply =
          "No problem at all — I won’t collect any personal information. Let me know if you change your mind.";

      } else {
        // They jumped straight to a request — remind them of consent first
        result.reply =
          "Before we get started — I may need to collect a few personal details to help with your enquiry. Is that okay?";
      }

      return res.json({ reply: result.reply });
    }

    const bookingInProgress = convo.step && convo.step !== "start";
    const mortgageInProgress =
      convo.mortgageStep && convo.mortgageStep !== "start";

    addChatLog({
      userId,
      conversationId,
      tenantId,
      sender: "customer",
      message: trimmedMessage,
      timestamp: new Date()
    });

    let rawIntent = "";
    let intent = "";

    if (aiEnabled) {
      try {
        rawIntent = await getIntentFromOpenAI(trimmedMessage);
        intent = (rawIntent || "")
          .toLowerCase()
          .trim()
          .replace(/^"|"$/g, "")
          .replace(/\.$/, "");
      } catch (err) {
        console.error("Intent detection failed:", err.message);
        intent = "";
      }

      console.log("Raw intent:", rawIntent);
      console.log("Normalized intent:", intent);
      console.log("Business mode:", effectiveMode);
      console.log("Message:", trimmedMessage);
    }

    async function extractMortgageFields(message) {
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `
You extract mortgage enquiry details from customer messages.

Return ONLY valid JSON.
Do not include explanation.

Fields:
{
  "buyerType": "",
  "propertyPrice": "",
  "deposit": "",
  "income": "",
  "employmentType": "",
  "name": "",
  "phone": "",
  "email": ""
}

Only fill a field if the user clearly provided it.
Use plain numbers where possible.
`
            },
            {
              role: "user",
              content: message
            }
          ],
          temperature: 0
        });

        const text = completion.choices[0].message.content || "{}";
        return JSON.parse(text);
      } catch (err) {
        console.error("Mortgage extraction failed:", err.message);
        return {};
      }
    }

    function getNextMissingMortgageStep(lead) {
      if (!lead.buyerType) return "buyerType";
      if (!lead.propertyPrice) return "propertyPrice";
      if (!lead.deposit) return "deposit";
      if (!lead.income) return "income";
      if (!lead.employmentType) return "employmentType";
      if (!lead.name) return "name";
      if (!lead.phone) return "phone";
      if (!lead.email) return "email";
      if (!lead.payslipUploadLinkSent) return "uploadPayslip";
      return "complete";
    }

    function getMortgageReplyForStep(step) {
      if (step === "buyerType") {
        return "No problem at all — I can help with that 👍 Are you a first-time buyer, moving home, switching mortgage, or buying an investment property?";
      }

      if (step === "propertyPrice") {
        return "Nice one 👍 Are you looking at a particular property price, or just a rough range for now?";
      }

      if (step === "deposit") {
        return "Perfect. And roughly how much have you saved towards a deposit? Even a ballpark is fine.";
      }

      if (step === "income") {
        return "Got it 👍 Just so I can get a sense of affordability, what are you earning per year roughly?";
      }

      if (step === "employmentType") {
        return "That’s helpful. Are you employed, self-employed, or a bit of both?";
      }

      if (step === "name") {
        return "Perfect. What name should I put on the enquiry?";
      }

      if (step === "phone") {
        return "And what’s the best phone number for the broker to reach you on?";
      }

      if (step === "email") {
        return "Great — and what email address should they use?";
      }

      return "Brilliant — that’s everything I need 👍 A broker will take a look and be in touch shortly.";
    }

    if (!aiEnabled) {
      result.reply =
        "The AI receptionist is currently turned off. Please contact the business directly.";

    } else if (effectiveMode === "gp") {
      if (isUrgentMessage(trimmedMessage)) {
        resetConversation(userId);

        result.reply =
          "Your message may describe an urgent medical issue. Please contact emergency services immediately or call the practice directly now.";

        addChatLog({
          userId,
          conversationId,
          tenantId,
          sender: "system",
          message: "Urgent triage flag raised.",
          timestamp: new Date()
        });

      } else if (
        bookingInProgress ||
        lowerMessage.includes("book appointment") ||
        lowerMessage.includes("book consultation") ||
        intent === "book appointment"
      ) {
        result = await handleBookingFlow({
          userId,
          conversationId,
          message: bookingInProgress ? trimmedMessage : "book appointment",
          bookingType: "GP Appointment",
          confirmationLabel: "appointment"
        });
      } else {
        result.reply =
          "I can help you book an appointment. Type 'book appointment' to begin.";
      }

    } else if (effectiveMode === "mortgage") {

      // ── Company info — always answers regardless of active flow ──────────────
      if (/who.*broker|who.*work|who.*team|who.*staff|who.*advisor|broker.*name|who.*cormac|who.*david|who.*mahony|about the company|about at once mortgages|who.*maeve/i.test(lowerMessage)) {
        result.reply = "At Once Mortgages has two mortgage brokers — Cormac Collins and David O'Mahony. You can reach them on 📞 021 4315 815, or I can book you an appointment — just say 'book an appointment'! 😊";

      // ── Qualification agent — takes priority ────────────────────────────────
      } else if (convo.qualMode) {
        try {
          result.reply = await runQualificationAgent(convo, trimmedMessage, !!voiceMode);
        } catch (qualErr) {
          console.error("[qual-agent] Unhandled exception escaped qual agent:", qualErr.message, qualErr.stack);
          convo.qualMode  = false;
          convo.completed = true;
          result.reply = "Thanks so much for chatting! Cormac Collins from At Once Mortgages will be in touch with you shortly. Have a great day! 👋";
        }

      } else if (/speak.*human|talk.*human|human.*agent|speak.*person|talk.*person|speak.*someone|talk.*someone|speak.*cormac|talk.*cormac|speak.*broker|call.*someone|call.*you|phone.*number|contact.*you|real person/i.test(lowerMessage) && !bookingInProgress) {
        result.reply = "Of course! You can call Cormac Collins directly on 📞 021 4315 815, or I can book an appointment for you — just say 'book an appointment' and I'll get that sorted. 😊";

      } else if (isMortgageApplicationIntent(trimmedMessage, intent) && !bookingInProgress) {
        convo.qualMode = true;
        try {
          result.reply = await runQualificationAgent(convo, trimmedMessage, !!voiceMode);
        } catch (qualErr) {
          console.error("[qual-agent] Unhandled exception escaped qual agent:", qualErr.message, qualErr.stack);
          convo.qualMode  = false;
          convo.completed = true;
          result.reply = "Thanks so much for chatting! Cormac Collins from At Once Mortgages will be in touch with you shortly. Have a great day! 👋";
        }

      } else if (mortgageInProgress) {
        const extracted = await extractMortgageFields(trimmedMessage);

        const leadUpdates = {};

        if (convo.mortgageStep === "uploadPayslip") {
          if (
            lowerMessage.includes("yes") ||
            lowerMessage.includes("ok") ||
            lowerMessage.includes("sure") ||
            lowerMessage.includes("send") ||
            lowerMessage.includes("text") ||
            lowerMessage.includes("whatsapp")
          ) {
            await updateMortgageLead(convo.mortgageLeadId, {
              payslipUploadLinkSent: true
            });

          const completedLead = await fetchMortgageLead(convo.mortgageLeadId);

          function parseMoney(value) {
            if (!value) return 0;
            const text = value.toString().toLowerCase().replace(/,/g, "").trim();
            const number = parseFloat(text.replace(/[^\d.]/g, ""));
            if (text.includes("k")) return number * 1000;
            return number || 0;
          }

          const income = parseMoney(completedLead?.income);
          const deposit = parseMoney(completedLead?.deposit);
          const isHot = income >= 80000 && deposit >= 30000;

          console.log("[uploadPayslip] lead check:", { income, deposit, isHot });

          await updateMortgageLead(convo.mortgageLeadId, {
            status: "New lead - contact details captured",
            leadTemperature: isHot ? "Hot" : "Cold"
          });

          if (isHot) {
            await updateMortgageLead(convo.mortgageLeadId, {
              emailSent: true
            });

            console.log("[uploadPayslip] hot lead email attempted");
          }

          convo.completed = true;

          result.reply =
            "Great — please use the Choose Document button below to upload your payslip securely.\n\n" +
            "A broker will review your details and be in touch shortly 👍";

      } else {
        result.reply =
          "No problem — I can send the link whenever you're ready 👍";
      }

      addChatLog({
        userId,
        conversationId,
        tenantId,
        sender: "bot",
        message: result.reply,
        timestamp: new Date()
      });

      return res.json({ reply: result.reply });
    }

        if (convo.mortgageStep === "buyerType") {
          let buyerType = extracted.buyerType || trimmedMessage;

          if (
            lowerMessage.includes("first time") ||
            lowerMessage.includes("first-time") ||
            lowerMessage.includes("first")
          ) {
            buyerType = "First-time buyer";
          }

          leadUpdates.buyerType = buyerType;
        }

        if (convo.mortgageStep === "propertyPrice") {
          leadUpdates.propertyPrice = extracted.propertyPrice || trimmedMessage;
        }

        if (convo.mortgageStep === "deposit") {
          leadUpdates.deposit = extracted.deposit || trimmedMessage;
        }

        if (convo.mortgageStep === "income") {
          leadUpdates.income = extracted.income || trimmedMessage;
        }

        if (convo.mortgageStep === "employmentType") {
          leadUpdates.employmentType = extracted.employmentType || trimmedMessage;
        }

        if (convo.mortgageStep === "name") {
          leadUpdates.name = extracted.name || trimmedMessage;
        }

        if (convo.mortgageStep === "phone") {
          leadUpdates.phone = extracted.phone || trimmedMessage;

          await updateMortgageLead(convo.mortgageLeadId, leadUpdates);

          convo.mortgageStep = "email";

          result.reply = "Great 👍 And what email address should the broker use?";

          addChatLog({
            userId,
            conversationId,
            tenantId,
            sender: "bot",
            message: result.reply,
            timestamp: new Date()
          });

          return res.json({ reply: result.reply });
        }

        if (convo.mortgageStep === "email") {
          leadUpdates.email = extracted.email || trimmedMessage;

          await updateMortgageLead(convo.mortgageLeadId, leadUpdates);

          convo.mortgageStep = "uploadPayslip";

          result.reply =
            "Perfect 👍\n\n" +
            "The next step would normally be to review a recent payslip.\n\n" +
            "Would it be okay if I sent you a secure upload link by text or WhatsApp?";

          addChatLog({
            userId,
            conversationId,
            tenantId,
            sender: "bot",
            message: result.reply,
            timestamp: new Date()
          });

          return res.json({ reply: result.reply });
        }

        Object.keys(extracted || {}).forEach((key) => {
          if (extracted[key]) {
            leadUpdates[key] = extracted[key];
          }
        });

        await updateMortgageLead(convo.mortgageLeadId, leadUpdates);

        const currentLead = await fetchMortgageLead(convo.mortgageLeadId);

        if (!currentLead) {
          console.error("Lead not found:", convo.mortgageLeadId);
          result.reply = "Sorry — something went wrong. Please try again.";
          return res.json({ reply: result.reply });
        }

        const nextStep = getNextMissingMortgageStep(currentLead);

        if (nextStep === "complete") {

          const completedLead = currentLead;

          function parseMoney(value) {
          if (!value) return 0;

          const text = value.toString().toLowerCase().replace(/,/g, "").trim();
          const number = parseFloat(text.replace(/[^\d.]/g, ""));

          if (text.includes("k")) return number * 1000;

          return number || 0;
        }

        const income = parseMoney(completedLead?.income);
        const deposit = parseMoney(completedLead?.deposit);

          const isHot = income >= 80000 && deposit >= 30000;

          console.log("Lead check:", { income, deposit, isHot });

          if (isHot) {
            await updateMortgageLead(completedLead.id, { emailSent: true });
            console.log("🔥 HOT lead flagged");
          } else {
            console.log("❌ NOT HOT");
          }

          convo.completed = true;

          result.reply =
            "Brilliant — that’s everything I need 👍 A broker will take a look and be in touch shortly.\n\n" +
            "Thanks for using Maeve 👋";
        } else {
          convo.mortgageStep = nextStep;
          result.reply = getMortgageReplyForStep(nextStep);
        }

      } else if (
        lowerMessage.includes("upload documents") ||
        lowerMessage.includes("upload document") ||
        lowerMessage.includes("upload docs") ||
        lowerMessage.includes("send documents") ||
        lowerMessage.includes("send document") ||
        lowerMessage.includes("upload file") ||
        intent === "upload documents"
      ) {
        result.reply =
          "No problem — you can upload documents using the upload option. Typical documents include ID, payslips, bank statements, and proof of address.";

      } else if (
        !(/^(what|how|when|where|why|tell me|explain|do i|can i|could i|is it|are there|will i|should i|do you|does it|who)/i.test(lowerMessage) || lowerMessage.includes("?")) &&
        (
          lowerMessage.includes("mortgage") ||
          lowerMessage.includes("buy a house") ||
          lowerMessage.includes("buying a house") ||
          lowerMessage.includes("buy my first home") ||
          lowerMessage.includes("first home") ||
          lowerMessage.includes("first-time buyer") ||
          lowerMessage.includes("first time buyer") ||
          intent === "mortgage application"
        )
      ) {
        const lead = await createMortgageLeadFromChat({
          userId,
          conversationId
        });

        convo.mortgageStep = "buyerType";
        convo.mortgageLeadId = lead.id;

        const extracted = await extractMortgageFields(trimmedMessage);

        const leadUpdates = {};
        Object.keys(extracted || {}).forEach((key) => {
          if (extracted[key]) {
            leadUpdates[key] = extracted[key];
          }
        });

        await updateMortgageLead(lead.id, leadUpdates);

        const currentLead = await fetchMortgageLead(lead.id);

        if (!currentLead) {
          console.error("Lead not found:", lead.id);
          result.reply = "Sorry — something went wrong creating your enquiry. Please try again.";
          return res.json({ reply: result.reply });
        }

        const nextStep = getNextMissingMortgageStep(currentLead);

    if (nextStep === "complete") {
      const completedLead = currentLead;

      function parseMoney(value) {
        if (!value) return 0;

        const text = value.toString().toLowerCase().replace(/,/g, "").trim();
        const number = parseFloat(text.replace(/[^\d.]/g, ""));

        if (text.includes("k")) return number * 1000;

        return number || 0;
      }

      const income = parseMoney(completedLead?.income);
      const deposit = parseMoney(completedLead?.deposit);

      const isHot = income >= 80000 && deposit >= 30000;

      console.log("Lead check:", { income, deposit, isHot });

      await updateMortgageLead(convo.mortgageLeadId, {
        status: "New lead - contact details captured",
        leadTemperature: isHot ? "Hot" : "Cold"
      });

      if (isHot) {
        await updateMortgageLead(convo.mortgageLeadId, { emailSent: true });
      }

      convo.completed = true;

      result.reply =
        "Brilliant — that’s everything I need 👍 A broker will take a look and be in touch shortly.\n\n" +
        "Thanks for using Maeve 👋";
    } else {
      convo.mortgageStep = nextStep;
      result.reply = getMortgageReplyForStep(nextStep);
    }
      } else if (
        bookingInProgress ||
        lowerMessage.includes("book appointment") ||
        lowerMessage.includes("book consultation") ||
        lowerMessage.includes("mortgage consultation") ||
        intent === "book appointment"
      ) {
        result = await handleBookingFlow({
          userId,
          conversationId,
          message: bookingInProgress ? trimmedMessage : "book appointment",
          bookingType: "Mortgage Consultation",
          confirmationLabel: "consultation"
        });

      } else if (
        lowerMessage.includes("status") ||
        lowerMessage.includes("update")
      ) {
        result.reply =
          "No problem — please provide your mortgage lead reference number, for example ML-123456789.";

      } else if (
        lowerMessage.includes("documents needed") ||
        lowerMessage.includes("what documents") ||
        lowerMessage.includes("what do i need")
      ) {
        result.reply =
          "Typical mortgage documents include ID, proof of address, bank statements, payslips, employment details, and savings evidence. Exact requirements can vary by lender.";

} else {

  // 🔥 NEW: Check knowledge base documents FIRST
  // Build recent conversation history for context-aware query rewriting
  const recentHistory = chatLogs
    .filter(log => log.conversationId === conversationId)
    .slice(-4)
    .map(log => `${log.sender === "user" ? "User" : "Assistant"}: ${log.message}`)
    .join("\n");
  const relevantDocs = await findRelevantKnowledgeChunks(trimmedMessage, 5, tenantId, recentHistory, tenantDisplayName || "", conversationId);

  console.log("Relevant knowledge docs:", relevantDocs);

  if (relevantDocs.length > 0) {

    const context = relevantDocs
      .map(doc => `Source: ${doc.filename}\n${doc.text}`)
      .join("\n\n");

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a mortgage assistant. Answer ONLY using the provided knowledge base context. If the answer is not clearly in the context, say you do not know. Format your answer in HTML: use <p> for paragraphs, <ul><li> for lists, and <strong> for key figures or limits. Do not use markdown or headings."
          },
          {
            role: "user",
            content: `Knowledge base:\n${context}\n\nQuestion:\n${trimmedMessage}`
          }
        ],
        temperature: 0.2
      });

      const kbReply = stripHtml(completion.choices[0].message.content);
      const kbUnsure = /i do not know|don’t know|not in the|no information|cannot find|not sure/i.test(kbReply);

      if (!kbUnsure) {
        result.reply = kbReply;
        result.answerSource = "kb";
      } else {
        // KB couldn’t answer — fall through to Maeve’s general reply
        const maeveReply = await generateMaeveReply(trimmedMessage);
        result.reply = maeveReply || "No problem at all — I can help with mortgages, bookings, or any questions. What would you like to do?";
        result.answerSource = "generic";
      }

    } catch (err) {
      console.error("Knowledge base OpenAI error:", err.message);
      result.reply = "Sorry — I couldn’t access the knowledge base.";
      result.answerSource = "error";
    }

  } else {
    // No KB docs — use Maeve’s general conversational reply
    const maeveReply = await generateMaeveReply(trimmedMessage);
    result.reply =
      maeveReply ||
      "No problem at all — I can help with mortgages, consultations, or documents. What are you looking to do?";
    result.answerSource = "generic";
  }
}

    } else if (effectiveMode === "general") {

      // ── Membership change flow (check first — intercepts before KB search) ──
      const memberChange = await handleMembershipChangeFlow(convo, trimmedMessage, tenantId, tenantDisplayName || "club");
      if (memberChange.handled) {
        addChatLog({ userId, conversationId, tenantId, sender: "bot", message: memberChange.reply, answerSource: "workflow", timestamp: new Date() });
        return res.json({ reply: memberChange.reply, agentChoices: memberChange.choices || [] });
      }

      // ── EBO personal booking auth flow (takes priority over KB/availability) ─
      const eboPersonal = await handleEboPersonalFlow(convo, trimmedMessage, tenantId, tenantDisplayName || "club");
      if (eboPersonal.handled) {
        result.reply = eboPersonal.reply;
      } else {

      // ── KB search + optional live EBO court availability (in parallel) ────────
      const recentHistoryGeneral = chatLogs
        .filter(log => log.conversationId === conversationId)
        .slice(-4)
        .map(log => `${log.sender === "user" ? "User" : "Assistant"}: ${log.message}`)
        .join("\n");
      const [relevantDocs, eboContext] = await Promise.all([
        findRelevantKnowledgeChunks(trimmedMessage, 8, tenantId, recentHistoryGeneral, tenantDisplayName || ""),
        maybeGetEboContext(tenantId, trimmedMessage)
      ]);

      // Build combined context: live EBO data first, then KB docs
      const contextParts = [];
      if (eboContext) contextParts.push(eboContext);
      if (relevantDocs.length > 0) {
        contextParts.push("KNOWLEDGE BASE:\n" + relevantDocs.map(doc => `Source: ${doc.filename}\n${doc.text}`).join("\n\n"));
      }

      // Prepend the last workflow message shown to the user as extra context.
      // This lets the AI answer follow-up questions about what it just displayed
      // (e.g. "who are the coaches?" after the Coaching step listed them).
      if (workflowContext) {
        contextParts.unshift("WHAT THE ASSISTANT JUST SHOWED THE USER:\n" + workflowContext);
      }

      if (contextParts.length > 0) {
        const context = contextParts.join("\n\n---\n\n");

        try {
          const _org     = tenantDisplayName || "this organisation";
          const _descBit = tenantBusinessDesc ? ", " + tenantBusinessDesc : "";
          const _offTopic = "Every question should be assumed to be about " + _org + " and its people, activities, services, or events — even short questions like ‘who is the president?’ or ‘how many courts?’ are implicitly about " + _org + ". Only treat a question as off-topic if it is clearly about an entirely unrelated subject (e.g. world news, another organisation). If off-topic, respond: ‘I’m only able to help with questions about " + _org + ". Is there something about us I can help you with?’";
          const _name = tenantAssistantName;
          const sysPrompt = eboContext
            ? "You are " + _name + ", a helpful AI assistant for " + _org + _descBit + ". For court availability or booking questions, use the LIVE COURT BOOKINGS data to give accurate, up-to-date information. For all other questions use the KNOWLEDGE BASE or WHAT THE ASSISTANT JUST SHOWED THE USER. Keep answers friendly and concise. Never invent or guess information not present in the data — if you don't have it, say so clearly. " + _offTopic
            : "You are " + _name + ", a helpful AI assistant for " + _org + _descBit + ". Answer using the provided context — prioritise WHAT THE ASSISTANT JUST SHOWED THE USER for follow-up questions, then the KNOWLEDGE BASE. When the context contains the answer, state it directly and confidently — do not open with phrases like 'I don't have specific information' or 'I'm not sure, but'. Only say you don't have information when it is genuinely absent from the context. If truly absent, say: 'I don't have that information — please check the website or contact " + _org + " directly.' Never invent, guess, or use placeholder text. Critical rule: never invent specific facts such as a person's name, phone number, date, price, or address — if it is not explicitly stated in the context, say you don't have it. Keep answers friendly and concise. " + _offTopic;

          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: sysPrompt },
              { role: "user",   content: `Context:\n${context}\n\nQuestion:\n${trimmedMessage}` }
            ],
            temperature: 0.2
          });

          const kbReply = stripHtml(completion.choices[0].message.content);
          // Only treat as "unsure" if we don't have live EBO data driving the answer
          const kbUnsure = !eboContext && /i do not know|don't know|don't have that|not in the|no information|cannot find|not sure|unable to find|no details/i.test(kbReply);

          if (!kbUnsure) {
            result.reply = kbReply;
            result.answerSource = eboContext ? "ebo" : "kb";
          } else {
            const genericReply = await generateGenericReply(trimmedMessage, tenantDisplayName, tenantBusinessDesc);
            result.reply = genericReply || "I'm not sure about that — please contact us directly for more information.";
            result.answerSource = "generic";
          }
        } catch (err) {
          console.error("Knowledge base OpenAI error (general mode):", err.message);
          result.reply = "Sorry — I couldn't access the knowledge base right now.";
          result.answerSource = "error";
        }
      } else if (workflowContext) {
        // No KB results but we have what was just shown — answer from that alone
        try {
          const _org = tenantDisplayName || "this organisation";
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are " + tenantAssistantName + ", a helpful AI assistant for " + _org + ". Answer the user's follow-up question using only WHAT THE ASSISTANT JUST SHOWED THE USER. Keep the answer friendly and concise." },
              { role: "user",   content: "WHAT THE ASSISTANT JUST SHOWED THE USER:\n" + workflowContext + "\n\nUser question:\n" + trimmedMessage }
            ],
            temperature: 0.2
          });
          result.reply = stripHtml(completion.choices[0].message.content);
          result.answerSource = "workflow";
        } catch {
          result.reply = "I'm not sure about that — please contact us directly for more information.";
          result.answerSource = "error";
        }
      } else {
        const genericReply = await generateGenericReply(trimmedMessage, tenantDisplayName, tenantBusinessDesc);
        result.reply = genericReply || "I'm not sure about that — please contact us directly for more information.";
        result.answerSource = "generic";
      }

      } // end: eboPersonal not handled

    } else {
      result.reply = "Invalid business mode configuration.";
      result.answerSource = "error";
    }

    console.log("[chat] Sending reply, length:", (result.reply || "").length, "| source:", result.answerSource || "?", "| preview:", (result.reply || "").slice(0, 60));

    addChatLog({
      userId,
      conversationId,
      tenantId,
      sender:       "bot",
      message:      result.reply,
      answerSource: result.answerSource || null,
      timestamp:    new Date()
    });

    const responsePayload = { reply: result.reply };
    if (result.answerSource === "generic") {
      responsePayload.unanswered = true;
      if (tenantPhone) responsePayload.phone = tenantPhone;
    }
    return res.json(responsePayload);

  } catch (error) {
    console.error("Chat error:", error);
    return res.status(500).json({
      reply: "Sorry, something went wrong. Please try again."
    });
  }
});

app.delete("/api/knowledge-answer/flagged/:id", requireSenior, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("flagged_answers")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("Supabase flagged answer delete error:", error);
      return res.status(500).json({ error: "Failed to delete flagged answer" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Delete flagged answer error:", err);
    res.status(500).json({ error: "Failed to delete flagged answer" });
  }
});

app.get("/api/knowledge-answer/flagged", requireSenior, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("flagged_answers")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Supabase flagged answers load error:", error);
      return res.status(500).json({ error: "Failed to load flagged answers" });
    }

    res.json(
      data.map(item => ({
        id: item.id,
        question: item.question,
        answer: item.answer,
        feedback: item.feedback,
        flaggedBy: item.flagged_by,
        createdAt: item.created_at
      }))
    );
  } catch (err) {
    console.error("Load flagged answers error:", err);
    res.status(500).json({ error: "Failed to load flagged answers" });
  }
});

app.get("/api/knowledge-base", requireAdmin, (req, res) => {
  const kb = readJsonFile(knowledgeBaseFile, []);
  res.json(kb);
});

app.post("/api/knowledge-documents/paste", requireSenior, async (req, res) => {
  try {
    const { title, text } = req.body;

    if (!title || !text) {
      return res.status(400).json({
        error: "Title and text are required"
      });
    }

    const { data, error } = await supabase
      .from("knowledge_documents")
      .insert({
        filename: `${title}.txt`,
        storage_path: null,
        mimetype: "text/plain",
        extracted_text: text
      })
      .select()
      .single();

    if (error) {
      console.error("Paste knowledge insert error:", error);

      return res.status(500).json({
        error: "Failed to save knowledge"
      });
    }

    res.json({
      success: true,
      document: data
    });

  } catch (err) {
    console.error("Paste knowledge error:", err);

    res.status(500).json({
      error: "Failed to save knowledge"
    });
  }
});

const knowledgeAnswersFile = path.join(__dirname, "data", "knowledgeAnswers.json");
const answerCorrectionsFile = path.join(__dirname, "data", "answerCorrections.json");
const auditLogFile = path.join(__dirname, "data", "auditLog.json");

app.post("/api/knowledge-answer/save", requireSenior, async (req, res) => {
  try {
    const { question, answer, category } = req.body;

    if (!question || !answer) {
      return res.status(400).json({ error: "Question and answer are required" });
    }

    const { error } = await supabase
      .from("approved_answers")
      .insert({
        question,
        answer,
        category: category || "General",
        tenant_id: "aom"
      });

    if (error) {
      console.error("Supabase approved answer save error:", error);
      return res.status(500).json({ error: "Failed to save approved answer" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Save approved answer error:", err);
    res.status(500).json({ error: "Failed to save approved answer" });
  }
});

const flaggedAnswersFile = path.join(__dirname, "data", "flaggedAnswers.json");

app.post("/api/knowledge-answer/flag", requireLogin, async (req, res) => {
  try {
    const { question, answer, feedback } = req.body;

    if (!question || !answer) {
      return res.status(400).json({ error: "Question and answer are required" });
    }

    const { error } = await supabase
      .from("flagged_answers")
      .insert({
        question,
        answer,
        feedback:   feedback || "",
        flagged_by: req.user?.role || "unknown",
        tenant_id:  "aom"
      });

    if (error) {
      console.error("Supabase flag answer error:", error);
      return res.status(500).json({ error: "Failed to flag answer" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Flag answer error:", err);
    res.status(500).json({ error: "Failed to flag answer" });
  }
});

function isGeneralMortgageQuestion(question) {
  const q = String(question || "").toLowerCase();

  const specificTerms = [
    "aib",
    "ptsb",
    "bank of ireland",
    "boi",
    "avant",
    "pepper",
    "ics",
    "haven",
    "finance ireland",
    "exact",
    "policy",
    "criteria",
    "lender",
    "rate",
    "exception",
    "turnaround",
    "sla",
    "document checklist",
    "self-employed requirement",
    "broker process",
    "compliance",
    "dora",
    "gdpr"
  ];

  if (specificTerms.some(term => q.includes(term))) {
    return false;
  }

  const generalTerms = [
    "what is",
    "explain",
    "how does",
    "what does",
    "meaning of",
    "difference between",
    "mortgage",
    "deposit",
    "approval in principle",
    "aip",
    "loan offer",
    "drawdown",
    "valuation",
    "solicitor",
    "repayment capacity",
    "fixed rate",
    "variable rate",
    "first time buyer",
    "help to buy",
    "first home scheme"
  ];

  return generalTerms.some(term => q.includes(term));
}

app.post("/api/knowledge-answer", requireLogin, async (req, res) => {
  const { question } = req.body;

  if (!question) {
    return res.status(400).json({ error: "question is required" });
  }

  if (!features.knowledgeBase) {
    return res.status(503).json({ error: "Knowledge base is currently disabled." });
  }

  try {

  const { data: approvedAnswers, error: approvedError } = await supabase
    .from("approved_answers")
    .select("*")
    .order("created_at", { ascending: false });

  if (approvedError) {
    console.error("Supabase approved answer lookup error:", approvedError);
  }

  const normalise = (text) =>
    String(text || "")
      .toLowerCase()
      .trim()
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ");

  const lowerQuestion = normalise(question);

  console.log("[approved answers loaded]:", approvedAnswers ? approvedAnswers.length : 0);
  console.log("[question asked]:", lowerQuestion);

  let match = null;

  if ((approvedAnswers || []).length > 0) {
    const semanticMatch = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a semantic matching assistant.
  Given a question and a list of stored questions, return the INDEX of the best matching stored question if it is semantically equivalent to the asked question.
  Two questions are equivalent if they are asking for the same information, even if worded differently.
  Examples of equivalent questions:
  - "Who is our PTSB account manager?" and "Who is the PTSB account manager?"
  - "What documents are needed?" and "What do I need to provide?"
  Return -1 if no good semantic match exists.
  Return ONLY a single integer. No explanation. No punctuation.`
        },
        {
          role: "user",
          content: `Asked question: "${question}"

  Stored questions:
  ${(approvedAnswers || []).map((a, i) => `${i}: ${a.question}`).join("\n")}`
        }
      ],
      temperature: 0
    });

    const rawIndex = semanticMatch.choices[0].message.content.trim();
    const matchIndex = parseInt(rawIndex);

    if (!isNaN(matchIndex) && matchIndex >= 0 && matchIndex < approvedAnswers.length) {
      match = approvedAnswers[matchIndex];
    }
  }

  console.log("[approved answer match]:", match);

  if (match) {
    logActivity("kb_query", { role: req.user.role, question, answered: true, source: "Approved Answer" });
    return res.json({
      answer: match.answer,
      source: "Approved Answer",
      confidence: "High",
      sourceDetail: match.category || "Senior broker approved"
    });
  }

    const kb = readJsonFile(knowledgeBaseFile, []);
    const relevantDocs = await findRelevantKnowledgeChunks(question);

    const manualContext = kb
      .map(entry => `${entry.topic}:\n${entry.content}`)
      .join("\n\n");

    const documentContext = relevantDocs
      .map(doc => `Source: ${doc.filename}\n${doc.text}`)
      .join("\n\n");

    const context = `
    MANUAL KNOWLEDGE BASE:
    ${manualContext}

    UPLOADED KNOWLEDGE DOCUMENTS:
    ${documentContext}
    `;

    console.log("[/api/knowledge-answer] relevant docs:", relevantDocs);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
            You are an internal mortgage broker assistant.

            You help staff answer client queries using ONLY the knowledge base provided.

            STRICT RULES:
            - Only answer using the knowledge base
            - If the answer is not clearly in the knowledge base, say:
              "I don't have that in the knowledge base yet."
            - Do NOT guess or invent information
            - Do NOT provide financial advice or approval decisions
            - Do NOT make promises on timelines

            FORMATTING — always return HTML using these rules:
            - Wrap the whole answer in a <div>
            - Use <p> for each distinct point or paragraph
            - Use <ul><li> for lists of criteria, requirements, or options
            - Use <strong> to highlight key figures, percentages, amounts, and limits
            - Use a <p style="margin-top:12px;color:#6b7280;font-size:13px;"> for any caveats or notes at the end
            - Do NOT use headings (h1, h2, h3)
            - Do NOT use markdown — only HTML tags
            - Keep it concise and scannable

            KNOWLEDGE BASE:
            ${context}
            `
        },
        {
          role: "user",
          content: question
        }
      ],
      temperature: 0
    });

    const answer = completion.choices[0].message.content || "No answer returned.";

    const answerLower = answer.toLowerCase();

    let source = "AI Generated";
    let confidence = "Low";
    let sourceDetail = "No approved answer or document match found";

    if (relevantDocs.length > 0 && !answerLower.includes("i don't have that in the knowledge base yet")) {
      source = "Knowledge Document";
      confidence = "Medium";
      sourceDetail = [...new Set(relevantDocs.map(doc => doc.filename))].join(", ");
    }

    if (
      answerLower.includes("i don't have that in the knowledge base yet") ||
      answerLower.includes("no answer returned")
    ) {
      if (isGeneralMortgageQuestion(question)) {
        const generalCompletion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `
    You are Sprimal, an AI assistant for Irish mortgage broker staff.

    You may answer general mortgage education questions.

    Rules:
    - Give general educational information only
    - Do not invent lender-specific criteria
    - Do not give financial advice
    - Do not promise approval, rates, or timelines
    - Keep the answer concise and useful for junior broker staff
    - If the question asks for a specific lender, broker process, compliance rule, or exact requirement, say it needs broker-approved knowledge
              `
            },
            {
              role: "user",
              content: question
            }
          ],
          temperature: 0.2
        });

        const generalAnswer =
          generalCompletion.choices[0].message.content ||
          "I don't have that in the knowledge base yet.";

        logActivity("kb_query", { role: req.user.role, question, answered: true, source: "General Knowledge" });
        return res.json({
          answer: generalAnswer,
          source: "AI Generated",
          confidence: "Low",
          sourceDetail: "General mortgage knowledge only — not broker-approved"
        });
      }

      source = "Knowledge Gap";
      confidence = "Low";
      sourceDetail = "Needs senior broker review";
    }

    console.log("[/api/knowledge-answer] question:", question, "| answer length:", answer.length);

    logActivity("kb_query", {
      role:     req.user.role,
      question,
      answered: source !== "Knowledge Gap",
      source
    });

    res.json({
      answer,
      source,
      confidence,
      sourceDetail
    });
  } catch (err) {
    console.error("[/api/knowledge-answer] error:", err.message);
    res.status(500).json({ error: "Failed to generate answer." });
  }

});

// ── Lead Qualification Agent ──────────────────────────────────────────────────

const leadCriteria = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "leadCriteria.json"), "utf8")
);

function stripHtml(str) {
  if (!str) return str;
  return str.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
}

function parseMoneyValue(value) {
  if (!value && value !== 0) return 0;
  const text = String(value).toLowerCase().replace(/,/g, "").replace(/€/g, "").trim();
  const number = parseFloat(text.replace(/[^\d.]/g, ""));
  if (text.includes("k")) return number * 1000;
  if (text.includes("m")) return number * 1000000;
  return number || 0;
}

function calculateLeadScore(answers) {
  const propertyPrice = parseMoneyValue(answers.propertyPrice);
  const deposit       = parseMoneyValue(answers.deposit);
  const income        = parseMoneyValue(answers.annualIncome);

  if (!propertyPrice || !deposit || !income) {
    return { score: "unknown", reason: "Insufficient data to calculate score" };
  }

  const loanRequired = propertyPrice - deposit;
  const ltv          = (loanRequired / propertyPrice) * 100;
  const isFirstTime  = String(answers.buyerType || "").toLowerCase().includes("first");
  const maxLTV       = isFirstTime ? leadCriteria.ltvLimits.firstTimeBuyer.maxLTV : leadCriteria.ltvLimits.secondSubsequentBuyer.maxLTV;
  const maxLTI       = isFirstTime ? leadCriteria.ltiLimits.firstTimeBuyer.maxMultiple : leadCriteria.ltiLimits.secondSubsequentBuyer.maxMultiple;
  const lti          = loanRequired / income;

  const issues    = [];
  const strengths = [];

  // LTV
  if (ltv > maxLTV) {
    issues.push(`Deposit too low — LTV is ${ltv.toFixed(1)}%, maximum is ${maxLTV}% for ${isFirstTime ? "first-time buyers" : "movers"}`);
  } else {
    strengths.push(`Deposit sufficient — LTV ${ltv.toFixed(1)}% within ${maxLTV}% limit ✅`);
  }

  // LTI
  if (lti > maxLTI) {
    issues.push(`Income may not support loan — LTI is ${lti.toFixed(1)}x, maximum is ${maxLTI}x`);
  } else {
    strengths.push(`Income supports loan — LTI ${lti.toFixed(1)}x within ${maxLTI}x limit ✅`);
  }

  // Employment
  const emp = String(answers.employmentType || "").toLowerCase();
  if (emp.includes("self")) {
    issues.push("Self-employed — will need 2+ years of certified accounts");
  } else if (emp.includes("contract")) {
    issues.push("Contractor — lenders may require employment track record");
  } else {
    strengths.push("PAYE employed — strongest position for lenders ✅");
  }

  // Credit
  const credit = String(answers.creditHistory || "").toLowerCase();
  if (credit === "issues" || credit.includes("miss") || credit.includes("bad") || credit.includes("yes")) {
    issues.push("Credit issues reported — significant concern for lenders");
  } else {
    strengths.push("Clean credit history ✅");
  }

  // Existing debts
  const debts = String(answers.existingDebts || "").toLowerCase();
  if (debts && debts !== "none" && debts !== "no" && debts.length > 3) {
    issues.push(`Existing debts: ${answers.existingDebts}`);
  }

  // Score
  const criticalIssues = issues.filter(i =>
    i.includes("Deposit too low") ||
    i.includes("Income may not support") ||
    i.includes("Credit issues")
  );

  const score = criticalIssues.length === 0 && issues.length === 0 ? "hot"
              : criticalIssues.length === 0                         ? "warm"
              :                                                        "cold";

  return {
    score,
    issues,
    strengths,
    loanRequired:  Math.round(loanRequired),
    propertyPrice: Math.round(propertyPrice),
    deposit:       Math.round(deposit),
    income:        Math.round(income),
    ltv:           ltv.toFixed(1),
    lti:           lti.toFixed(1),
    isFirstTime,
    maxLTV,
    maxLTI
  };
}

function scoringReason(scoring) {
  const { score, issues, strengths } = scoring;

  if (score === "hot") {
    return "Reason: All key indicators are positive — financials are strong, employment is stable, and no credit concerns. Prioritise this lead.";
  }

  if (score === "warm") {
    const issueList = issues.length > 0
      ? issues.map(i => i.split("—")[0].trim()).join("; ")
      : "minor concerns";
    return `Reason: Core financials are within limits but there are some considerations: ${issueList}. Worth a follow-up call to explore options.`;
  }

  if (score === "cold") {
    const criticals = issues.filter(i =>
      i.includes("Deposit too low") ||
      i.includes("Income may not support") ||
      i.includes("Credit issues")
    );
    const issueList = criticals.length > 0
      ? criticals.map(i => i.split("—")[0].trim()).join("; ")
      : issues.map(i => i.split("—")[0].trim()).join("; ");
    return `Reason: This lead has significant barriers to standard lender approval: ${issueList}. Cormac may need to explore specialist options.`;
  }

  return "Reason: Insufficient data to fully assess this lead.";
}

async function emailLeadQualification(answers, scoring) {
  const emoji = { hot: "🔥", warm: "⚡", cold: "❄️" }[scoring.score] || "📋";
  const label = scoring.score.toUpperCase();

  const subject = `${emoji} ${label} LEAD — ${answers.customerName || "New enquiry"}`;

  const isUnknown = scoring.score === "unknown";
  const fmt = (n) => n != null ? `€${Number(n).toLocaleString("en-IE")}` : "Not collected";
  const fmtPct = (n) => n != null ? `${Number(n).toFixed(1)}%` : "N/A";
  const fmtX   = (n) => n != null ? `${Number(n).toFixed(2)}x` : "N/A";

  const text =
`${emoji} ${label} LEAD — ${scoring.score === "hot" ? "FOLLOW UP NOW" : isUnknown ? "INCOMPLETE ENQUIRY" : "FOLLOW UP RECOMMENDED"}

Name:           ${answers.customerName   || "Not provided"}
Phone:          ${answers.customerPhone  || "Not provided"}
Referred by:    ${answers.referralSource || "Not provided"}
Email:          ${answers.customerEmail  || "Not provided"}

MORTGAGE DETAILS
──────────────────────────────────────────
Buyer type:     ${answers.buyerType      || "Not collected"}
Property price: ${fmt(scoring.propertyPrice)}
Deposit:        ${fmt(scoring.deposit)}
Required loan:  ${fmt(scoring.loanRequired)}
Annual income:  ${fmt(scoring.income)}
LTV:            ${fmtPct(scoring.ltv)}  (limit: ${fmtPct(scoring.maxLTV)})
LTI:            ${fmtX(scoring.lti)}  (limit: ${fmtX(scoring.maxLTI)})
Employment:     ${answers.employmentType || "Not collected"}
Credit history: ${answers.creditHistory  || "Not collected"}
Existing debts: ${answers.existingDebts  || "None"}

STRENGTHS
──────────────────────────────────────────
${(scoring.strengths || []).map(s => `• ${s}`).join("\n") || "None identified"}

ISSUES
──────────────────────────────────────────
${(scoring.issues || []).map(i => `• ${i}`).join("\n") || (isUnknown ? "Insufficient data to fully score" : "None")}

SCORE: ${emoji} ${label}
──────────────────────────────────────────
${scoringReason(scoring)}

Qualification via Sprimal AI Chat`;

  const recipients = ["hello@sprimal.com", "cormac@aom.ie"];

  if (!process.env.RESEND_API_KEY) {
    console.warn("[qual-agent] RESEND_API_KEY not set — skipping lead email");
    return;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify({
        from:    "Maeve <maeve@sprimal.com>",
        to:      recipients,
        subject,
        text
      })
    });

    if (res.ok) {
      console.log(`[qual-agent] Lead email sent to ${recipients.join(", ")} — ${label} — ${answers.customerName}`);
    } else {
      const body = await res.text();
      console.error(`[qual-agent] Email failed: ${res.status} — ${body}`);
    }
  } catch (err) {
    console.error("[qual-agent] Email error:", err.message);
  }
}

// ── Qual Agent: answer tracking helpers ──────────────────────────────────────

function extractAnswersFromMessages(qualMessages, existingAnswers) {
  const answers = { ...existingAnswers };

  // All user text combined (categorical field detection)
  const allUserText = qualMessages
    .filter(m => m.role === "user")
    .map(m => m.content)
    .join(" ");
  const lower = allUserText.toLowerCase();

  // ── Categorical fields (regex across all user text) ──────────────────────

  if (!answers.buyerType) {
    if (/\bfirst[\s-]?time\b|\bftb\b|\bnever owned\b/.test(lower)) {
      answers.buyerType = "first_time";
    } else if (/\bbuy[\s-]to[\s-]let\b|\binvestment property\b|\bbtl\b|\bto rent(?: it)? out\b/.test(lower)) {
      answers.buyerType = "buy_to_let";
    } else if (/\bmoving home\b|\bmover\b|\bsecond[\s-]?time buyer\b|\balready own\b|\bupgrading\b|\bdownsizing\b/.test(lower)) {
      answers.buyerType = "mover";
    }
  }

  if (!answers.employmentType) {
    if (/\bpaye\b|\bfull[\s-]?time employed\b/.test(lower)) {
      answers.employmentType = "paye";
    } else if (/\bself[\s-]?employed\b/.test(lower)) {
      answers.employmentType = "self_employed";
    } else if (/\bcontractor\b/.test(lower)) {
      answers.employmentType = "contractor";
    }
  }

  if (!answers.creditHistory) {
    if (/\bno missed\b|\bclean credit\b|\bnever missed\b|\bperfect credit\b|\bno issues\b/.test(lower)) {
      answers.creditHistory = "clean";
    } else if (/\bmissed (?:a )?(?:loan|mortgage|repayment|payment)\b/.test(lower)) {
      answers.creditHistory = "issues";
    }
  }

  if (!answers.existingDebts) {
    if (/\bno (?:loans?|debts?|finance|car loan|credit card)\b|\bno existing\b|\bdebt[\s-]?free\b/.test(lower)) {
      answers.existingDebts = "none";
    } else if (/\bcar (?:loan|finance)\b|\bpersonal loan\b|\bcredit card debt\b/.test(lower)) {
      answers.existingDebts = "has debts";
    }
  }

  if (!answers.customerEmail) {
    const m = allUserText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (m) answers.customerEmail = m[0];
  }

  if (!answers.customerPhone) {
    const m = allUserText.match(/(?:\+353|0)[0-9\s]{9,11}/);
    if (m) answers.customerPhone = m[0].replace(/\s/g, "");
  }

  // ── Numeric + short-answer fields: per message, with previous assistant Q as context ──
  // Build ordered list of user+assistant messages (excluding system/tool)
  const msgs = qualMessages.filter(m => m.role === "user" || m.role === "assistant");

  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "user") continue;
    const userText = msgs[i].content || "";
    // What did Maeve just ask?
    const prevQ = (i > 0 && msgs[i - 1].role === "assistant")
      ? (msgs[i - 1].content || "").toLowerCase()
      : "";

    // 1. Explicit-context keywords in the user's own message
    //    (property keywords only — NOT "worth"/"value"/"costs" to avoid "Car loan worth X")
    if (!answers.propertyPrice) {
      const m = userText.match(/(?:property|house|home|flat|apartment|place|asking price)\D{0,10}(\d[\d,.]*[kKmM]?)/i)
             || userText.match(/(\d[\d,.]*[kKmM]?)\s*(?:property|house|home|flat|apartment)/i);
      if (m) answers.propertyPrice = parseMoneyValue(m[1]);
    }
    if (!answers.deposit) {
      const m = userText.match(/(\d[\d,.]*[kKmM]?)\s*(?:euro|€)?\s*(?:deposit|saved|in savings)/i)
             || userText.match(/(?:deposit|saved|savings)[^\d]*(\d[\d,.]*[kKmM]?)/i);
      if (m) answers.deposit = parseMoneyValue(m[1]);
    }
    if (!answers.annualIncome) {
      const m = userText.match(/(\d[\d,.]*[kKmM]?)\s*(?:a year|per year|annually|gross|salary|income)/i)
             || userText.match(/(?:earn|income|salary|make)\D{0,10}(\d[\d,.]*[kKmM]?)/i);
      if (m) answers.annualIncome = parseMoneyValue(m[1]);
    }

    // 2. Standalone number (e.g. "700k", "120000", "85k") — use the preceding Q for context
    const standaloneNum = userText.match(/^\s*(\d[\d,.]*[kKmM]?)\s*(?:€|euros?)?\s*$/i);
    if (standaloneNum && prevQ) {
      const val = parseMoneyValue(standaloneNum[1]);
      if (val > 0) {
        if (!answers.propertyPrice && /property|price|house|home|flat|apartment|looking at|how much.*buy|buying/i.test(prevQ)) {
          answers.propertyPrice = val;
        } else if (!answers.deposit && /deposit|saved|savings|put down|how much.*deposit/i.test(prevQ)) {
          answers.deposit = val;
        } else if (!answers.annualIncome && /income|earn|salary|gross|annual|year|combined|how much.*earn|joint/i.test(prevQ)) {
          answers.annualIncome = val;
        }
      }
    }

    // 3. Short yes/no/none — use the preceding Q to set categorical fields
    const shortAns = userText.trim().toLowerCase();
    if (/^(no|none|nope|never|clean|all good|no issues?|never missed|all clear)$/.test(shortAns) && prevQ) {
      if (!answers.creditHistory && /missed|repayment|credit history|bad debt|loan payment/i.test(prevQ)) {
        answers.creditHistory = "clean";
      }
      if (!answers.existingDebts && /loans?|debts?|finance|credit card|existing|car loan|owe/i.test(prevQ)) {
        answers.existingDebts = "none";
      }
    }
    if (/^(yes|yep|yeah|i have|i do|had one|a few)$/.test(shortAns) && prevQ) {
      if (!answers.creditHistory && /missed|repayment|credit history|bad debt|loan payment/i.test(prevQ)) {
        answers.creditHistory = "issues";
      }
    }
  }

  return answers;
}

function allFieldsCollected(answers) {
  // Only force submit when we have contact details AND the core mortgage figures.
  // Prevents premature submission if Maeve asks for name/phone/email before mortgage questions.
  const hasContact      = !!(answers.customerEmail && answers.customerPhone);
  const hasMortgageData = !!(answers.propertyPrice && answers.deposit && answers.annualIncome);
  const hasReferral     = !!(answers.referralSource);
  return hasContact && hasMortgageData && hasReferral;
}

function buildConfirmedBlock(answers) {
  if (!answers || Object.keys(answers).length === 0) return "";

  const lines = [];
  const buyerLabels = { first_time: "first-time buyer", mover: "mover / second buyer", buy_to_let: "buy-to-let investor" };

  if (answers.buyerType)      lines.push(`✓ Buyer type: ${buyerLabels[answers.buyerType] || answers.buyerType}`);
  if (answers.propertyPrice)  lines.push(`✓ Property price: €${answers.propertyPrice.toLocaleString("en-IE")}`);
  if (answers.deposit)        lines.push(`✓ Deposit: €${answers.deposit.toLocaleString("en-IE")}`);
  if (answers.annualIncome)   lines.push(`✓ Annual income: €${answers.annualIncome.toLocaleString("en-IE")}`);
  if (answers.employmentType) lines.push(`✓ Employment: ${answers.employmentType}`);
  if (answers.existingDebts)  lines.push(`✓ Existing debts: ${answers.existingDebts}`);
  if (answers.creditHistory)  lines.push(`✓ Credit history: ${answers.creditHistory}`);

  if (lines.length === 0) return "";

  return `\n\n=== CONFIRMED — DO NOT ASK ABOUT THESE AGAIN ===\n${lines.join("\n")}\n================================================`;
}

// ─────────────────────────────────────────────────────────────────────────────

const QUAL_SYSTEM_PROMPT = `You are Maeve, a warm and friendly Irish mortgage assistant working for At Once Mortgages in Cork, Ireland.

Company facts you know:
- The mortgage brokers are Cormac Collins and David O'Mahony
- Phone: 021 4315 815
- Customers can book a free consultation by saying "book an appointment"
- Address: 11A Georges Quay, Cork

Your job is to have a natural, conversational chat to qualify a potential mortgage customer.

CRITICAL — BEFORE EVERY SINGLE RESPONSE, scan the ENTIRE conversation history and mentally mark off everything already answered:
- Has buyer type been mentioned? → CONFIRMED. Do NOT ask again.
- Has property price been mentioned? → CONFIRMED. Do NOT ask again.
- Has deposit been mentioned? → CONFIRMED. Do NOT ask again.
- Has income been mentioned? → CONFIRMED. Do NOT ask again.
- Has employment been mentioned? → CONFIRMED. Do NOT ask again.
- Have debts been mentioned? → CONFIRMED. Do NOT ask again.
- Has credit history been mentioned? → CONFIRMED. Do NOT ask again.

BUYER TYPE RECOGNITION — these phrases ALL confirm buyer type immediately. Never ask about buyer type again after any of these:
- "first time", "first-time", "first time buyer", "never owned", "FTB" → buyerType = first_time_buyer ✓ CONFIRMED
- "moving", "mover", "second time", "already own", "upgrading", "downsizing" → buyerType = mover ✓ CONFIRMED
- "buy to let", "investment", "rental", "BTL", "renting it out" → buyerType = buy_to_let ✓ CONFIRMED

If the customer mentions a property, price, location, or area they are looking at, that also confirms they are buying (not already an owner specifying existing home) — treat as context, not a re-ask trigger.

MULTIPLE ANSWERS: If the customer gives several pieces of information in one message (e.g. "first time buyer, looking at a 450k place, have 50k deposit"), accept ALL of them at once and only ask for the NEXT missing item.

Collect these 9 pieces of information through friendly conversation:
1. Buyer type (first-time, moving home, or buy-to-let)
2. Property price
3. Deposit amount
4. Gross annual income (combined if joint application)
5. Employment type — PAYE, self-employed, or contractor
6. Any existing loans, car finance, or credit card debt
7. Any missed loan or mortgage repayments in the last 5 years
8. Name, phone number, and email address
9. How they heard about At Once Mortgages (ask this naturally near the end, e.g. "Just before we finish — how did you hear about us?")

Rules:
- Be warm and natural — use short Irish phrases like "Sound", "Grand", "Perfect", "No bother".
- Keep each response to 1-2 sentences MAXIMUM.
- Ask only ONE question at a time — the next missing piece of information only.
- Do NOT summarise or repeat back what the customer has already told you.
- Do NOT use mortgage jargon like LTV or LTI.
- Do NOT tell them the outcome — just thank them and say the broker will be in touch.

Only call submit_qualification when you have ALL required fields including name, phone, email, and referral source.

ABSOLUTE PROHIBITIONS — never do any of the following under any circumstances:
- Do NOT ask for payslips, bank statements, P60s, or any documents
- Do NOT mention document upload or file upload
- Do NOT suggest sending a link by text, WhatsApp, or email
- Do NOT add any extra steps after collecting the 8 fields above
- The moment you have all 8 fields, call submit_qualification immediately — nothing else`;

async function runQualificationAgent(convo, userMessage, voiceMode = false) {
  if (!convo.qualMessages) {
    convo.qualMessages = [{ role: "system", content: QUAL_SYSTEM_PROMPT }];
    convo.qualAnswers = {};
  }

  convo.qualMessages.push({ role: "user", content: userMessage });

  // Track confirmed answers in code, then inject them into the system prompt so the model can't forget
  convo.qualAnswers = extractAnswersFromMessages(convo.qualMessages, convo.qualAnswers || {});
  const confirmedBlock = buildConfirmedBlock(convo.qualAnswers);
  convo.qualMessages[0] = { role: "system", content: QUAL_SYSTEM_PROMPT + confirmedBlock };
  if (confirmedBlock) {
    console.log("[qual-agent] Confirmed answers injected:", JSON.stringify(convo.qualAnswers));
  }

  const tools = [
    {
      type: "function",
      function: {
        name: "submit_qualification",
        description: "Submit when ALL information is collected: buyer type, property price, deposit, income, employment, debts, credit history, name, phone, and email.",
        parameters: {
          type: "object",
          properties: {
            buyerType:      { type: "string", description: "first_time, mover, or buy_to_let" },
            propertyPrice:  { type: "number", description: "Property price in euros" },
            deposit:        { type: "number", description: "Deposit saved in euros" },
            annualIncome:   { type: "number", description: "Gross annual income in euros (combined if joint)" },
            employmentType: { type: "string", description: "paye, self_employed, or contractor" },
            existingDebts:  { type: "string", description: "Description of existing debts or 'none'" },
            creditHistory:  { type: "string", description: "clean or issues" },
            customerName:   { type: "string" },
            customerPhone:  { type: "string" },
            customerEmail:  { type: "string" },
            referralSource: { type: "string", description: "How the customer heard about At Once Mortgages" }
          },
          required: ["buyerType", "propertyPrice", "deposit", "annualIncome", "employmentType", "creditHistory", "customerName", "customerPhone", "customerEmail", "referralSource"]
        }
      }
    }
  ];

  for (let i = 0; i < 6; i++) {
    // Force submit if: email+phone confirmed in code, OR intercept already fired once
    const forceSubmit = allFieldsCollected(convo.qualAnswers) || !!convo._forceSubmit;
    if (forceSubmit) {
      console.log("[qual-agent] Forcing submit_qualification — all fields confirmed or banned content intercepted");
    }

    // Remove any orphaned assistant tool_calls messages that have no tool response
    // (can happen if a previous request timed out before we could push the ack)
    for (let j = convo.qualMessages.length - 1; j >= 0; j--) {
      const m = convo.qualMessages[j];
      if (m.role === "assistant" && m.tool_calls?.length) {
        const hasAck = convo.qualMessages.slice(j + 1).some(r => r.role === "tool");
        if (!hasAck) {
          console.warn("[qual-agent] Removing orphaned tool_calls message at index", j);
          convo.qualMessages.splice(j, 1);
        }
      }
    }

    let response;
    try {
      console.log(`[qual-agent] Calling OpenAI iter=${i} forceSubmit=${forceSubmit} msgs=${convo.qualMessages.length}`);
      response = await openai.chat.completions.create({
        model:       "gpt-4o-mini",
        messages:    convo.qualMessages,
        tools,
        tool_choice: forceSubmit
          ? { type: "function", function: { name: "submit_qualification" } }
          : "auto",
        temperature: 0.5
      });
      console.log(`[qual-agent] OpenAI returned iter=${i}`);
    } catch (apiErr) {
      console.error("[qual-agent] OpenAI API error on iteration", i,
        "| status:", apiErr.status || "n/a",
        "| code:", apiErr.code || "n/a",
        "| message:", apiErr.message);
      console.error("[qual-agent] Messages at time of error:", JSON.stringify(convo.qualMessages.map(m => ({ role: m.role, contentLen: (m.content || "").length }))));
      convo.qualMode  = false;
      convo.completed = true;
      return "Thanks so much for chatting! Cormac Collins from At Once Mortgages will be in touch with you shortly. Have a great day! 👋";
    }

    const finishReason = response.choices[0].finish_reason;
    const message = response.choices[0].message;
    console.log(`[qual-agent] iter=${i} finish_reason=${finishReason} tool_calls=${message.tool_calls?.length || 0} content_len=${(message.content || "").length}`);
    convo.qualMessages.push(message);

    // ── Tool call check FIRST — some models return finish_reason=stop even
    //    when tool_calls are present, so we check the message itself, not the flag.
    if (message.tool_calls?.length) {
      const toolCall = message.tool_calls[0];
      let answers;
      try {
        answers = JSON.parse(toolCall.function.arguments);
        console.log("[qual-agent] Tool call parsed, customerName:", answers.customerName, "| fields:", Object.keys(answers).join(","));
      } catch (e) {
        console.error("[qual-agent] Failed to parse tool arguments:", e.message);
        return "Thanks for that — a broker will be in touch with you shortly.";
      }

      // Score the lead
      const scoring = calculateLeadScore(answers);
      console.log(`[qual-agent] Score: ${scoring.score.toUpperCase()} — ${answers.customerName}`);

      // Save lead to Supabase (non-fatal if it fails)
      try {
        await insertMortgageLead({
          id:                     "ML-" + Date.now(),
          createdAt:              new Date().toISOString(),
          status:                 `New lead — ${scoring.score}`,
          name:                   answers.customerName,
          phone:                  answers.customerPhone,
          email:                  answers.customerEmail,
          buyerType:              answers.buyerType,
          propertyPrice:          answers.propertyPrice,
          deposit:                answers.deposit,
          income:                 answers.annualIncome,
          employmentType:         answers.employmentType,
          existingDebts:          answers.existingDebts,
          creditHistory:          answers.creditHistory,
          referralSource:         answers.referralSource,
          lead_score:             scoring.score,
          ltvPct:                 scoring.ltv   || null,
          ltiX:                   scoring.lti   || null,
          qualificationStrengths: scoring.strengths || [],
          qualificationIssues:    scoring.issues    || []
        });
        console.log("[qual-agent] Lead saved to Supabase");
      } catch (saveErr) {
        console.error("[qual-agent] Lead save failed:", saveErr.message);
      }

      // Email — fire-and-forget, never block qual completion
      emailLeadQualification(answers, scoring).catch(err =>
        console.error("[qual-agent] Email error (async):", err.message)
      );

      // Ack tool call
      convo.qualMessages.push({
        role:         "tool",
        tool_call_id: toolCall.id,
        content:      JSON.stringify({ success: true, score: scoring.score })
      });

      // Closing message by score
      const closing = {
        hot:     "That's brilliant — thank you so much for those details! 😊 You look like a really strong candidate. Cormac Collins from At Once Mortgages will be in touch with you very shortly. Have a great day!",
        warm:    "Lovely, thank you for sharing all of that! You're in a good position and Cormac will be in touch soon to go through your options. Talk soon! 👋",
        cold:    "Thanks so much for chatting with me today. Cormac will take a look at your details and be in touch to discuss the best path forward for you. Have a lovely day! 👋",
        unknown: "Thanks so much for chatting with me today! Cormac Collins from At Once Mortgages will be in touch with you shortly to go through your options. Have a great day! 👋"
      };

      convo.qualMode  = false;
      convo.completed = true;

      return closing[scoring.score] || closing.unknown;
    }

    // ── Natural conversation reply (no tool_calls present) ───────────────────
    if (finishReason === "stop") {
      const reply = message.content || "";

      // Hard intercept: if model hallucinated a payslip/upload/document step
      const hasBannedContent = /payslip|pay[\s-]slip|bank[\s-]?statement|p60|\bupload\b|secure[\s-]?link|whatsapp.*link|text.*link/i.test(reply);
      if (hasBannedContent) {
        console.warn("[qual-agent] Intercepted prohibited step — forcing submit on next iteration");
        convo.qualMessages.pop(); // remove the bad assistant message
        convo._forceSubmit = true;
        continue;
      }

      return reply;
    }

    // Unexpected finish_reason (e.g. "length") — loop continues to next iteration
    console.warn("[qual-agent] Unexpected finish_reason:", finishReason, "— retrying");
  }

  return "Sorry, something went wrong. Please try again or contact us directly at 021 4315 815.";
}

// Keywords that trigger lead qualification (vs general mortgage questions)
function isMortgageApplicationIntent(message, intent) {
  const lower = message.toLowerCase();

  // If the message looks like a question, treat it as a general FAQ — never start qual flow
  const isQuestion = /^(what|how|when|where|why|do i|can i|could i|is it|are there|will i|should i|do you|does it|who)/i.test(lower) || lower.includes("?");
  if (isQuestion) return false;

  const triggerPhrases = [
    "apply", "application", "get a mortgage", "take out a mortgage",
    "buying a house", "buying a home", "buying a property",
    "first time buyer", "first-time buyer", "looking for a mortgage",
    "interested in a mortgage", "afford a mortgage", "start the process",
    "moving home", "second time buyer", "start my application",
    "apply for a mortgage", "get started with a mortgage", "get started"
  ];
  // Only trigger on very explicit application intents — not generic "mortgage enquiry"
  const triggerIntents = ["mortgage application", "apply for mortgage"];

  return triggerPhrases.some(p => lower.includes(p)) ||
         triggerIntents.some(i => (intent || "").includes(i));
}

// ── Gmail IMAP email polling ──────────────────────────────────────────────────

const CORMAC_SIGNATURE = `Kind Regards,

Cormac Collins

At Once Mortgages
11A Georges Quay,
Cork.
Tel: 021 4315 815
Email: cormac@aom.ie

https://www.atoncemortgages.com/

At Once Mortgages is regulated by the Central Bank of Ireland.

Services Provided: Financial Planning - Monthly Budget Planning, Mortgage Advice, Income Protection, Permanent Health Insurance, Investment Advice, Pensions.

Life Assurance Products - Mortgage Protection, Life Assurance, Serious Illness Cover, Permanent Total Disability Cover.

This email (including any attachments) is confidential, privileged and may be used only by the person to whom it is addressed. If you are not the addressee then you may not read, disseminate, print, copy, store or otherwise use it. If you have received it in error, please notify At Once Mortgages and delete it from your system.`;

// ── Email Response Agent ─────────────────────────────────────────────────────
// Uses OpenAI tool calls so the agent decides what to search rather than
// having everything pre-loaded into the prompt.

const EMAIL_AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description: "Search the mortgage broker knowledge base for lender criteria, policy documents, rates, and procedures. Use specific queries related to what the client is asking about.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Specific search query, e.g. 'AIB self-employed criteria' or 'fixed rate switching rules'" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_approved_answers",
      description: "Search broker-approved answers to common client questions. Use this to find pre-approved responses the broker has already written.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Question or topic to search for" }
        },
        required: ["query"]
      }
    }
  }
];

async function runEmailResponseAgent(emailContent, senderName = "", applicationContext = null) {
  // Extract first name from sender, e.g. "Alan Donelan <alan@x.com>" → "Alan"
  // Falls back to "" (renders as "Hi there,") if no clean name is found
  let firstName = "";
  if (senderName) {
    // Strip the email address portion if present: "Name <email>" → "Name"
    const displayName = senderName.replace(/<[^>]+>/, "").trim();
    // If what's left still looks like a raw email address, discard it
    if (displayName && !displayName.includes("@")) {
      const raw = displayName.split(/\s+/)[0].replace(/[^a-zA-Z'-]/g, "");
      if (raw.length >= 2 && raw.toLowerCase() !== "unknown") {
        firstName = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
      }
    }
  }
  const messages = [
    {
      role: "system",
      content: `You are drafting a reply email on behalf of Cormac Collins, an Irish mortgage broker at At Once Mortgages.

Write in the FIRST PERSON as Cormac. Never refer to "Cormac", "the broker", or "we" in a way that implies a third party — you ARE Cormac writing directly to the client.

You have two tools:
- search_knowledge_base: searches lender criteria, policy docs, rates and procedures
- search_approved_answers: searches broker-pre-approved Q&A pairs

Instructions:
1. Read the FULL email carefully — this includes any quoted/previous messages in the thread (lines starting with ">" or prefixed with "On [date] wrote:"). Use the thread history to understand the full context: what documents have already been sent, what questions have already been answered, what the current status of the application is.
2. Identify the specific topic(s) being asked about in the latest message
3. Search for relevant information using specific targeted queries
4. You may search multiple times with different queries if needed
5. Once you have enough information, draft the reply

Using thread history:
- If the thread shows a client previously sent a payslip, gift letter, bank statement or other document — acknowledge it as received if they are asking about it
- If the thread shows a question was already answered — do not repeat the full answer, just confirm
- If the thread mentions a specific person (e.g. a parent providing a gift) — use their name naturally in the reply
- Do NOT ask for documents that the thread shows have already been sent

Rules for the draft:
- Write as "I" — e.g. "I'll chase that up", "I've received your documents", "I'll be in touch"
- Do NOT invent lender-specific criteria not found in your searches
- Do NOT promise approval, rates, or timelines
- Do NOT give financial advice
- If searches return nothing useful, say you will be in touch to confirm (e.g. "I'll come back to you on that")
- Keep it concise and human — 4 to 8 lines

IMPORTANT — New mortgage enquiries:
If the email is a NEW mortgage enquiry (someone wanting to start the mortgage process,
asking about applying, asking if they qualify, asking about getting a mortgage — with
no existing case reference or ongoing application mentioned), do NOT search the knowledge
base or provide detailed mortgage information. Instead write a short warm reply (3–4 lines)
that:
  1. Thanks them for getting in touch
  2. Directs them to start the process on the At Once Mortgages website chat at
     https://www.atoncemortgages.com/ by typing "apply for a mortgage"
  3. Tells them the chat will ask a few quick questions to get them started and that I'll follow up
Do NOT do this for existing clients who already have a case in progress.

Style:
- Friendly and professional
- Start with "Hi ${firstName || "there"}," — always use the sender's first name if available, never "Hi there" when a name is known
- Use Irish/British English spelling throughout — e.g. "apologise" not "apologize", "recognise" not "recognize", "organise" not "organize", "colour" not "color", "favour" not "favor"
- Do NOT add a sign-off or "Kind regards" — the signature is added automatically`
    },
    {
      role: "user",
      content: (() => {
        // Build application state block if available
        let stateBlock = "";
        if (applicationContext?.state) {
          const s = applicationContext.state;
          const events = applicationContext.recentEvents || [];
          const fmt = (d) => new Date(d).toLocaleDateString("en-IE", { day: "numeric", month: "short" });

          stateBlock = [
            "── APPLICATION STATE ──────────────────────────────",
            `Borrower:    ${s.borrower_name || "Unknown"}${s.co_borrower_name ? ` & ${s.co_borrower_name}` : ""}`,
            `Phase:        ${(s.current_phase || "initial_enquiry").replace(/_/g, " ")}`,
            `Lender:       ${s.lender        ? s.lender.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : "not yet identified"}`,
            `Borrower type:${s.borrower_type ? " " + s.borrower_type.replace(/_/g, " ")                          : " not yet identified"}`,
            `Loan amount: ${s.loan_amount ? `€${Number(s.loan_amount).toLocaleString("en-IE")}` : "not confirmed"}`,
            `Property:    ${s.property_address || "not yet mentioned"}`,
            `Docs received:    ${s.received_documents?.length
              ? s.received_documents.map(d => {
                  const date = applicationContext.docDates?.[d];
                  return date ? `${d} (${date})` : d;
                }).join(", ")
              : "none yet"}`,
            `Docs outstanding: ${s.missing_documents?.length  ? s.missing_documents.join(", ")  : "none flagged"}`,
            ...(s.conflict_flags?.length ? [`⚠️  FLAGS: ${s.conflict_flags.join("; ")}`] : []),
            "",
            "── HISTORY ─────────────────────────────────────────",
            s.running_summary || "No history yet.",
            "",
            ...(events.length ? [
              "── RECENT EVENTS ───────────────────────────────────",
              ...events.slice(0, 5).map(e => `[${fmt(e.created_at)}] ${e.event_type}: ${e.description}`)
            ] : []),
            "────────────────────────────────────────────────────",
            ""
          ].join("\n");
        }

        return `${stateBlock}Draft a reply to this client email:\n\n${emailContent}`;
      })()
    }
  ];

  // Agent loop — max 6 iterations (3 rounds of tool calls + final answer)
  for (let i = 0; i < 6; i++) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools: EMAIL_AGENT_TOOLS,
      tool_choice: "auto",
      temperature: 0.3
    });

    const message = response.choices[0].message;
    messages.push(message);

    if (response.choices[0].finish_reason === "stop") {
      console.log(`[email-agent] Draft complete after ${i + 1} iteration(s)`);
      return message.content;
    }

    if (response.choices[0].finish_reason === "tool_calls" && message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        let result;
        const args = JSON.parse(toolCall.function.arguments);

        if (toolCall.function.name === "search_knowledge_base") {
          console.log(`[email-agent] Tool call: search_knowledge_base("${args.query}")`);
          const docs = await findRelevantKnowledgeChunks(args.query);
          result = docs.length > 0
            ? docs.map(d => `[${d.filename}]\n${d.text}`).join("\n\n")
            : "No relevant documents found for that query.";

        } else if (toolCall.function.name === "search_approved_answers") {
          console.log(`[email-agent] Tool call: search_approved_answers("${args.query}")`);
          const { data } = await supabase
            .from("approved_answers")
            .select("question, answer")
            .order("created_at", { ascending: false })
            .limit(20);
          result = (data && data.length > 0)
            ? data.map(a => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n")
            : "No approved answers found.";
        } else {
          result = "Unknown tool.";
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result
        });
      }
    }
  }

  console.warn("[email-agent] Max iterations reached — returning partial draft");
  const last = messages.filter(m => m.role === "assistant" && m.content).pop();
  return last?.content || "Unable to generate draft.";
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Lender Document Checklists ────────────────────────────────────────────────
// Required documents per lender × borrower type for Irish mortgages.
// Used to auto-populate missing_documents when lender + borrower_type are known.
// ─────────────────────────────────────────────────────────────────────────────

const LENDER_CHECKLISTS = {
  haven: {
    paye: [
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "Certificate of income / Salary certificate",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    self_employed: [
      "2 years audited accounts",
      "2 years Form 11 tax returns",
      "Notice of Assessment (last 2 years)",
      "Accountant's reference letter",
      "6 months business bank statements",
      "6 months personal bank statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    contract: [
      "Current contract (showing end date and rate)",
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ]
  },
  ptsb: {
    paye: [
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "Certificate of income / Salary certificate",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    self_employed: [
      "3 years audited accounts",        // PTSB requires 3 years — stricter than others
      "3 years Form 11 tax returns",
      "Notice of Assessment (last 3 years)",
      "Accountant's reference letter",
      "6 months business bank statements",
      "6 months personal bank statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    contract: [
      "Current contract (showing end date and rate)",
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ]
  },
  bank_of_ireland: {
    paye: [
      "3 months payslips",
      "P60 / Employment Detail Summary (most recent)",
      "Certificate of income / Salary certificate",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    self_employed: [
      "2 years audited accounts",
      "2 years Form 11 tax returns",
      "Notice of Assessment (last 2 years)",
      "Accountant's reference letter",
      "6 months business bank statements",
      "6 months personal bank statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    contract: [
      "Current contract (showing end date and rate)",
      "3 months payslips",
      "P60 / Employment Detail Summary (most recent)",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ]
  },
  avant: {
    paye: [
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "Certificate of income / Salary certificate",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    self_employed: [
      "2 years audited accounts",
      "2 years Form 11 tax returns",
      "Notice of Assessment (last 2 years)",
      "Accountant's reference letter",
      "6 months business bank statements",
      "6 months personal bank statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    contract: [
      "Current contract (showing end date and rate)",
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ]
  },
  nua: {
    paye: [
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "Certificate of income / Salary certificate",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    self_employed: [
      "2 years audited accounts",
      "2 years Form 11 tax returns",
      "Notice of Assessment (last 2 years)",
      "Accountant's reference letter",
      "6 months business bank statements",
      "6 months personal bank statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    contract: [
      "Current contract (showing end date and rate)",
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ]
  },
  aib: {
    paye: [
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "Certificate of income / Salary certificate",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    self_employed: [
      "2 years audited accounts",
      "2 years Form 11 tax returns",
      "Notice of Assessment (last 2 years)",
      "Accountant's reference letter",
      "6 months business bank statements",
      "6 months personal bank statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    contract: [
      "Current contract (showing end date and rate)",
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ]
  },
  ebs: {
    // EBS is an AIB subsidiary — requirements are effectively the same
    paye: [
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "Certificate of income / Salary certificate",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    self_employed: [
      "2 years audited accounts",
      "2 years Form 11 tax returns",
      "Notice of Assessment (last 2 years)",
      "Accountant's reference letter",
      "6 months business bank statements",
      "6 months personal bank statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    contract: [
      "Current contract (showing end date and rate)",
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ]
  },
  irishlife: {
    paye: [
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "Certificate of income / Salary certificate",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    self_employed: [
      "2 years audited accounts",
      "2 years Form 11 tax returns",
      "Notice of Assessment (last 2 years)",
      "Accountant's reference letter",
      "6 months business bank statements",
      "6 months personal bank statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ],
    contract: [
      "Current contract (showing end date and rate)",
      "3 months payslips",
      "P60 / Employment Detail Summary (last 2 years)",
      "6 months current account statements",
      "6 months savings account statements",
      "Photo ID",
      "Proof of address (last 6 months)"
    ]
  }
};

// Generic checklist — used for display when lender / borrower type are not yet known.
// Covers documents required by virtually every Irish lender regardless of borrower type.
// This is NEVER persisted to the DB; it's a placeholder until Cormac sets the lender field.
const GENERIC_CHECKLIST = [
  "Photo ID",
  "Proof of address (last 6 months)",
  "6 months current account statements",
  "6 months savings account statements",
  "3 months payslips (or 2 years audited accounts if self-employed)",
  "P60 / Employment Detail Summary (last 2 years)",
  "Certificate of income / Salary certificate (if PAYE)"
];

// Returns the checklist for a given lender + borrower_type, or null if unknown
function getLenderChecklist(lender, borrowerType) {
  if (!lender || !borrowerType) return null;
  return LENDER_CHECKLISTS[lender]?.[borrowerType] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Email Context Engine ──────────────────────────────────────────────────────
// State-driven context for AI reply generation. Tracks each mortgage application
// as a structured state object so the AI knows what docs have been received,
// what phase the case is at, and has a running summary of the interaction history.
// All new tables — zero impact on existing tenants or data.
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. Deduplicator — strips quoted thread history, signatures, disclaimers ───
function deduplicateEmailBody(rawBody) {
  if (!rawBody) return "";

  const lines = rawBody.split("\n");
  const output = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Gmail / Outlook "On [date] [name] wrote:" thread marker
    if (/^on .{5,120}wrote:\s*$/i.test(trimmed)) break;

    // Line-quoted text ("> ...")
    if (trimmed.startsWith(">")) break;

    // Standard signature delimiter
    if (trimmed === "--" || trimmed === "___" || trimmed === "---") break;

    // Irish business email legal disclaimer markers
    if (/^(this e-?mail|this message|confidentiality notice|disclaimer:|the information contained)/i.test(trimmed)) break;

    // AOM-specific signature markers
    if (/^at once mortgages/i.test(trimmed)) break;

    output.push(line);
  }

  return output.join("\n").trim();
}

// ── 2. Entity Extractor — pulls key mortgage entities from cleaned email ───────
async function extractEmailEntities(cleanedBody, from, subject) {
  try {
    const response = await anthropic.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 512,
      messages: [{
        role: "user",
        content:
`You are extracting structured data from an Irish mortgage broker email (AOM — At Once Mortgages).
Return ONLY valid JSON — no markdown, no explanation, no extra text.

From: ${from}
Subject: ${subject}
Body: ${cleanedBody.slice(0, 2000)}

Extraction rules:
- borrower_name: The mortgage applicant's full name. If the email is sent directly by the client, their name is likely the borrower. Do NOT use names of children, dependents, solicitors, valuers, estate agents, or lender staff.
- co_borrower_name: The second mortgage applicant (joint borrower) only. Do NOT use dependents or children.
- client_email: The borrower's personal email address only if explicitly written in the email body. NEVER use the sender's email address. Look for patterns like "my email is..." or "contact me at...".
- application_ref: Any reference number in the Subject line OR body — check both carefully. Common formats: 8-digit numbers (e.g. 92806275, 61719462), alphanumeric refs (e.g. NPDH-260526-009, B50007177), AOM portal refs (e.g. 2605-00000064).
- lender: First check the sender's email domain — @aib.ie → aib, @ptsb.ie → ptsb, @irishlife.ie → irishlife, @havenmortgages.ie or @haven.ie → haven, @boi.com or @bankofireland.com → bank_of_ireland, @ebs.ie → ebs, @avantmoney.ie or @avant.ie → avant, @nuamoney.com → nua. Otherwise read the email body for lender mentions.
- loan_amount: Numeric euros only, no symbol or commas (e.g. 320000). null if not mentioned.
- documents_received: Only documents explicitly submitted or attached in THIS email (e.g. payslips, bank statements, gift letter, P60, employment detail summary).
- documents_mentioned: Documents referenced, requested, or discussed but not submitted in this email.
- phase_signal: Best signal of current application stage from the email content.

{
  "borrower_name": null,
  "co_borrower_name": null,
  "client_email": null,
  "application_ref": null,
  "event_type": "document_received | document_requested | status_enquiry | milestone | new_enquiry | other",
  "documents_received": [],
  "documents_mentioned": [],
  "loan_amount": null,
  "property_address": null,
  "phase_signal": "initial_enquiry | aip | full_application | underwriting | letter_of_offer | drawdown | null",
  "lender": "aib | avant | bank_of_ireland | ebs | haven | irishlife | nua | ptsb | null",
  "borrower_type": "paye | self_employed | contract | null"
}`
      }]
    });

    let text = (response.content[0]?.text || "{}").trim()
      .replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    return JSON.parse(text);
  } catch (err) {
    console.warn("[email-context] Entity extraction failed:", err.message);
    return { event_type: "other", documents_received: [], documents_mentioned: [] };
  }
}

// ── 3. Find or Create Application State ───────────────────────────────────────
// isStaffOrSystem: true when email is from AOM staff, lender, or system address.
// Staff/system emails can UPDATE existing records but must never CREATE new ones —
// they cover multiple clients so keying by sender_email would mix cases together.
async function findOrCreateApplicationState(from, entities, isStaffOrSystem = false) {
  const emailMatch = from.match(/<([^>]+)>/);
  const senderEmail = (emailMatch ? emailMatch[1] : from).toLowerCase().trim();
  const clientEmail = (entities.client_email || "").toLowerCase().trim() || null;
  const appRef      = (entities.application_ref || "").trim() || null;

  // ── Lookup priority ────────────────────────────────────────────────────────
  // 1. client_email extracted from body → strongest signal (always try)
  if (clientEmail) {
    const { data: byClientEmail } = await supabase
      .from("mortgage_application_states")
      .select("*")
      .or(`client_email.eq.${clientEmail},sender_email.eq.${clientEmail}`)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byClientEmail) {
      console.log(`[email-context] Matched by client_email: ${clientEmail}`);
      return byClientEmail;
    }
  }

  // 2. Application reference number (always try)
  if (appRef) {
    const { data: byRef } = await supabase
      .from("mortgage_application_states")
      .select("*")
      .eq("application_ref", appRef)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byRef) {
      console.log(`[email-context] Matched by application_ref: ${appRef}`);
      return byRef;
    }
  }

  // 3. Sender email as client identity — only when sender IS the client
  if (!isStaffOrSystem) {
    const { data: bySender } = await supabase
      .from("mortgage_application_states")
      .select("*")
      .or(`sender_email.eq.${senderEmail},client_email.eq.${senderEmail}`)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (bySender) {
      console.log(`[email-context] Matched by sender_email: ${senderEmail}`);
      return bySender;
    }
  }

  // 4. Borrower name — last resort for lender/system emails where no email or ref
  //    could be matched. Prevents duplicate rows when a lender portal (e.g. Haven)
  //    sends document notifications that reference the borrower by name but don't
  //    include their personal email address. Only used for staff/system senders.
  if (isStaffOrSystem && entities.borrower_name) {
    const { data: byName } = await supabase
      .from("mortgage_application_states")
      .select("*")
      .ilike("borrower_name", entities.borrower_name.trim())
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byName) {
      console.log(`[email-context] Matched by borrower_name: ${entities.borrower_name}`);
      return byName;
    }
  }

  // ── No existing row found — decide whether to create ──────────────────────

  // Noise gate — require at least some mortgage signal before creating anything
  const hasSignal =
    entities.borrower_name ||
    entities.lender ||
    (entities.documents_received && entities.documents_received.length > 0) ||
    (entities.documents_mentioned && entities.documents_mentioned.length > 0) ||
    (entities.event_type && entities.event_type !== "other");

  if (!hasSignal) {
    console.log(`[email-context] Noise gate — no mortgage signal from ${senderEmail}, skipping`);
    return null;
  }

  // Staff/system sender: only create if we extracted client identity from the email body.
  // We may legitimately first hear about a client via a lender or broker system email —
  // as long as we can identify who the client is, we create the row keyed on that identity.
  if (isStaffOrSystem) {
    if (!clientEmail && !appRef) {
      console.log(`[email-context] Staff/system email (${senderEmail}) — no client identity extracted, skipping`);
      return null;
    }
    console.log(`[email-context] Staff/system email (${senderEmail}) — creating state from extracted identity: client_email=${clientEmail}, appRef=${appRef}`);
  }

  // ── Create new state ───────────────────────────────────────────────────────
  // For direct client emails: sender IS the client → client_email = senderEmail
  // For staff/system emails: client_email comes from extracted entities (sender is just the trigger)
  const resolvedClientEmail = isStaffOrSystem ? clientEmail : senderEmail;

  const { data: lead } = resolvedClientEmail
    ? await supabase.from("mortgage_leads").select("id, name, email").eq("email", resolvedClientEmail).maybeSingle()
    : { data: null };

  const { data: newState } = await supabase
    .from("mortgage_application_states")
    .insert({
      lead_id:           lead?.id                   || null,
      sender_email:      senderEmail,               // who triggered creation (audit trail)
      client_email:      resolvedClientEmail,       // the actual borrower's email
      application_ref:   appRef,
      borrower_name:     entities.borrower_name     || lead?.name || null,
      co_borrower_name:  entities.co_borrower_name  || null,
      property_address:  entities.property_address  || null,
      loan_amount:       entities.loan_amount        || null,
      current_phase:     entities.phase_signal       || "initial_enquiry",
      lender:            entities.lender             || null,
      borrower_type:     entities.borrower_type      || null,
      missing_documents: [],
      received_documents:[],
      running_summary:   null,
      conflict_flags:    []
    })
    .select()
    .single();

  console.log(`[email-context] New application state created — client: ${resolvedClientEmail || "unknown"}, triggered by: ${senderEmail}`);
  return newState;
}

// ── 4. Running Summary — incrementally updated 3-5 sentence history ───────────
async function updateRunningSummary(existingSummary, cleanedBody, from, subject, entities) {
  try {
    const response = await anthropic.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 300,
      messages: [{
        role: "user",
        content:
`Update this Irish mortgage application summary with the new email event.
Keep it to 3-5 concise sentences covering key history. Be specific about documents received and current status.

Current summary:
${existingSummary || "No summary yet — this is the first email."}

New email:
From: ${from}
Subject: ${subject}
Documents received: ${(entities.documents_received || []).join(", ") || "none"}
Event: ${entities.event_type || "other"}
Content: ${cleanedBody.slice(0, 500)}

Return ONLY the updated summary — no labels or formatting.`
      }]
    });
    return response.content[0]?.text?.trim() || existingSummary;
  } catch {
    return existingSummary;
  }
}

// ── 5. State Updater — applies new email data to the application state ─────────
async function updateApplicationState(state, entities, cleanedBody, from, subject) {
  const updates = {};
  const events  = [];

  // Phase
  if (entities.phase_signal && entities.phase_signal !== "null") {
    updates.current_phase = entities.phase_signal;
  }

  // Identity fields — fill in if newly discovered
  const newClientEmail = (entities.client_email || "").toLowerCase().trim() || null;
  if (newClientEmail && !state.client_email) updates.client_email = newClientEmail;
  const newAppRef = (entities.application_ref || "").trim() || null;
  if (newAppRef && !state.application_ref) updates.application_ref = newAppRef;

  // Borrower details (only fill if not already set)
  if (entities.borrower_name    && !state.borrower_name)    updates.borrower_name    = entities.borrower_name;
  if (entities.co_borrower_name && !state.co_borrower_name) updates.co_borrower_name = entities.co_borrower_name;
  if (entities.property_address && !state.property_address) updates.property_address = entities.property_address;

  // Lender — update if newly identified (flag if it changes unexpectedly)
  if (entities.lender && entities.lender !== "null") {
    if (state.lender && state.lender !== entities.lender) {
      const flag = `Lender changed from ${state.lender} to ${entities.lender}`;
      updates.conflict_flags = [...(state.conflict_flags || []), flag];
      console.warn(`[email-context] Conflict flag raised: ${flag}`);
    }
    updates.lender = entities.lender;
  }

  // Borrower type — only fill if not already set
  if (entities.borrower_type && entities.borrower_type !== "null" && !state.borrower_type) {
    updates.borrower_type = entities.borrower_type;
  }

  // Auto-populate missing_documents from lender checklist when both lender
  // and borrower_type are known for the first time.
  // We do a fresh DB read here (rather than relying on the state snapshot taken at function
  // entry) to minimise the race window when several emails arrive concurrently — e.g. when
  // Haven's portal fires one notification per document upload in rapid succession.
  const effectiveLender       = updates.lender       || state.lender;
  const effectiveBorrowerType = updates.borrower_type || state.borrower_type;

  if (effectiveLender && effectiveBorrowerType) {
    const { data: freshCheck } = await supabase
      .from("mortgage_application_states")
      .select("missing_documents")
      .eq("id", state.id)
      .single();
    const alreadyHasChecklist = (freshCheck?.missing_documents || []).length > 0;

    if (!alreadyHasChecklist) {
      const checklist = getLenderChecklist(effectiveLender, effectiveBorrowerType);
      if (checklist) {
        const alreadyReceived = state.received_documents || [];
        const outstanding = checklist.filter(
          doc => !alreadyReceived.some(r => r.toLowerCase().includes(doc.toLowerCase().split(" ")[0]))
        );
        // Write the checklist immediately with a conditional filter — only succeeds if
        // missing_documents is still empty in the DB (another concurrent write hasn't beaten us).
        const { data: written } = await supabase
          .from("mortgage_application_states")
          .update({ missing_documents: outstanding })
          .eq("id", state.id)
          .filter("missing_documents", "eq", "[]")
          .select("id")
          .maybeSingle();

        if (written) {
          // We won the race — record it in updates and log the milestone
          updates.missing_documents = outstanding;
          console.log(`[email-context] Checklist loaded for ${effectiveLender}/${effectiveBorrowerType}: ${outstanding.length} docs outstanding`);
          events.push({
            application_id: state.id,
            event_type:     "milestone",
            description:    `Document checklist loaded: ${effectiveLender} / ${effectiveBorrowerType} (${outstanding.length} items outstanding)`,
            from_address:   from,
            email_subject:  subject
          });
        } else {
          console.log(`[email-context] Checklist already set by concurrent request — skipping`);
        }
      }
    }
  }

  // Loan amount — flag if it changes
  if (entities.loan_amount) {
    if (state.loan_amount && state.loan_amount !== entities.loan_amount) {
      const flag = `Loan amount changed from €${Number(state.loan_amount).toLocaleString("en-IE")} to €${Number(entities.loan_amount).toLocaleString("en-IE")}`;
      updates.conflict_flags = [...(state.conflict_flags || []), flag];
      console.warn(`[email-context] Conflict flag raised: ${flag}`);
    }
    updates.loan_amount = entities.loan_amount;
  }

  // Documents received
  if (entities.documents_received?.length > 0) {
    const already = state.received_documents || [];
    const newDocs = entities.documents_received.filter(d => !already.map(a => a.toLowerCase()).includes(d.toLowerCase()));
    if (newDocs.length > 0) {
      updates.received_documents = [...already, ...newDocs];
      // Remove from missing list if matched
      updates.missing_documents = (state.missing_documents || [])
        .filter(m => !newDocs.some(r => m.toLowerCase().includes(r.toLowerCase())));
      events.push({
        application_id: state.id,
        event_type:     "document_received",
        description:    `Received: ${newDocs.join(", ")}`,
        from_address:   from,
        email_subject:  subject
      });
    }
  }

  // Auto-advance to underwriting when a lender/system email completes the checklist.
  // Conditions: there was a non-empty checklist before this email, this email reduced it to
  // zero, the phase hasn't already reached underwriting or beyond, and the confirmation came
  // from a lender/portal (context-only sender) — not from the client claiming docs are sent.
  const hadChecklist        = (state.missing_documents || []).length > 0;
  const nowComplete         = updates.missing_documents !== undefined && updates.missing_documents.length === 0;
  const preUnderwritingPhase = ["initial_enquiry", "aip", "full_application"].includes(state.current_phase || "initial_enquiry");

  if (hadChecklist && nowComplete && preUnderwritingPhase && isContextOnlySender(from)) {
    updates.current_phase = "underwriting";
    console.log(`[email-context] Auto-advancing ${state.borrower_name || state.id} to Underwriting — all checklist docs confirmed by lender`);
    events.push({
      application_id: state.id,
      event_type:     "milestone",
      description:    "Advanced to Underwriting — all checklist documents confirmed received by lender",
      from_address:   from,
      email_subject:  subject
    });
  }

  // Running summary
  if (cleanedBody) {
    updates.running_summary = await updateRunningSummary(state.running_summary, cleanedBody, from, subject, entities);
    if (entities.event_type && entities.event_type !== "other") {
      updates.last_milestone = subject;
    }
  }

  updates.updated_at = new Date().toISOString();

  // Persist state updates
  await supabase.from("mortgage_application_states").update(updates).eq("id", state.id);

  // Log event row
  // Skip document_received here — already logged above with the specific document names.
  // Logging it again would create a duplicate event for the same email.
  if (entities.event_type && entities.event_type !== "other" && entities.event_type !== "document_received") {
    events.push({
      application_id: state.id,
      event_type:     entities.event_type,
      description:    subject,
      from_address:   from,
      email_subject:  subject
    });
  }
  if (events.length > 0) {
    await supabase.from("application_events").insert(events);
  }

  // Short-term email memory — keep last 3 cleaned emails per application
  await supabase.from("application_email_context").insert({
    application_id: state.id,
    cleaned_body:   cleanedBody.slice(0, 3000),
    from_address:   from,
    subject,
    received_at:    new Date().toISOString()
  });

  // Prune to last 3
  const { data: all } = await supabase
    .from("application_email_context")
    .select("id")
    .eq("application_id", state.id)
    .order("created_at", { ascending: false });

  if (all && all.length > 3) {
    await supabase.from("application_email_context")
      .delete()
      .in("id", all.slice(3).map(r => r.id));
  }

  return { ...state, ...updates };
}

// ── 6. Context Builder — assembles full context for reply generation ───────────
async function getApplicationContext(stateId) {
  const [stateRes, eventsRes, docEventsRes, emailsRes] = await Promise.all([
    supabase.from("mortgage_application_states").select("*").eq("id", stateId).single(),
    supabase.from("application_events").select("*").eq("application_id", stateId).order("created_at", { ascending: false }).limit(10),
    supabase.from("application_events").select("description, created_at").eq("application_id", stateId).eq("event_type", "document_received").order("created_at", { ascending: true }),
    supabase.from("application_email_context").select("*").eq("application_id", stateId).order("received_at", { ascending: false }).limit(3)
  ]);

  // Build a map of document name → received date from document_received events
  const docDates = {};
  for (const e of (docEventsRes.data || [])) {
    // description format: "Received: doc1, doc2"
    const docs = (e.description || "").replace(/^Received:\s*/i, "").split(",").map(d => d.trim());
    const date = new Date(e.created_at).toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" });
    for (const doc of docs) {
      if (doc && !docDates[doc]) docDates[doc] = date; // keep earliest date
    }
  }

  return {
    state:        stateRes.data       || null,
    recentEvents: eventsRes.data      || [],
    docDates,                                          // { "AIB account statements": "3 Jun 2026", ... }
    recentEmails: (emailsRes.data     || []).reverse() // chronological
  };
}

// ─── Morning Digest ───────────────────────────────────────────────────────────

const PHASE_ORDER = ["initial_enquiry","aip","full_application","underwriting","letter_of_offer","drawdown"];
const PHASE_LABEL = {
  initial_enquiry: "Initial Enquiry",
  aip:             "AIP",
  full_application:"Full Application",
  underwriting:    "Underwriting",
  letter_of_offer: "Letter of Offer",
  drawdown:        "Drawdown",
  null:            "Unknown"
};
const LENDER_LABEL = {
  aib:             "AIB",
  avant:           "Avant Money",
  bank_of_ireland: "Bank of Ireland",
  ebs:             "EBS",
  haven:           "Haven",
  irishlife:       "Irish Life",
  nua:             "Nua Money",
  ptsb:            "PTSB"
};

function phaseColor(phase) {
  return { initial_enquiry:"#6b7280", aip:"#3b82f6", full_application:"#8b5cf6",
           underwriting:"#f59e0b", letter_of_offer:"#10b981", drawdown:"#059669" }[phase] || "#6b7280";
}

async function sendMorningDigest() {
  try {
    const today     = new Date();
    const dateLabel = today.toLocaleDateString("en-IE", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
    const since24h  = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString();

    // ── Fetch data ──────────────────────────────────────────────────────────
    const [statesRes, eventsRes] = await Promise.all([
      supabase.from("mortgage_application_states").select("*").order("updated_at", { ascending: false }),
      supabase.from("application_events").select("*, mortgage_application_states(borrower_name, sender_email)")
               .gte("created_at", since24h).order("created_at", { ascending: false }).limit(50)
    ]);

    const states = statesRes.data || [];
    const events = eventsRes.data || [];

    // ── Categorise ──────────────────────────────────────────────────────────
    const flagged     = states.filter(s => s.conflict_flags?.length > 0);
    const outstanding = states.filter(s => s.missing_documents?.length > 0);
    const newEnquiries= states.filter(s => s.current_phase === "initial_enquiry" &&
                                           new Date(s.created_at) >= new Date(since24h));

    // Group by phase for pipeline overview
    const byPhase = {};
    for (const s of states) {
      const p = s.current_phase || "initial_enquiry";
      if (!byPhase[p]) byPhase[p] = [];
      byPhase[p].push(s);
    }

    // ── HTML helpers ────────────────────────────────────────────────────────
    const pill = (text, color) =>
      `<span style="background:${color};color:white;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;">${text}</span>`;

    const statCard = (value, label, color) =>
      `<td style="text-align:center;padding:12px 20px;">
         <div style="font-size:28px;font-weight:700;color:${color};">${value}</div>
         <div style="font-size:12px;color:#6b7280;margin-top:2px;">${label}</div>
       </td>`;

    const sectionHeader = (emoji, title) =>
      `<tr><td style="padding:24px 0 8px;">
         <div style="font-size:16px;font-weight:700;color:#111827;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">
           ${emoji} ${title}
         </div>
       </td></tr>`;

    const caseRow = (s, extra = "") => {
      const name    = s.borrower_name || s.sender_email || "Unknown";
      const lender  = LENDER_LABEL[s.lender] || "—";
      const phase   = PHASE_LABEL[s.current_phase] || "Unknown";
      const pColor  = phaseColor(s.current_phase);
      return `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;">
          <div style="font-weight:600;color:#111827;font-size:14px;">${name}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px;">
            ${pill(phase, pColor)}
            ${lender !== "—" ? `&nbsp;<span style="color:#6b7280;">${lender}</span>` : ""}
          </div>
          ${extra ? `<div style="font-size:12px;color:#b45309;margin-top:4px;">${extra}</div>` : ""}
        </td>
      </tr>`;
    };

    // ── Build HTML ──────────────────────────────────────────────────────────
    let html = `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

  <!-- Header -->
  <tr><td style="background:#111827;padding:24px 32px;">
    <div style="color:white;font-size:20px;font-weight:700;">☀️ Good morning, Cormac</div>
    <div style="color:#9ca3af;font-size:13px;margin-top:4px;">${dateLabel}</div>
  </td></tr>

  <!-- Stats bar -->
  <tr><td style="padding:0 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e5e7eb;">
      <tr>
        ${statCard(states.length,      "Active Cases",          "#111827")}
        ${statCard(flagged.length,     "Flagged",               "#ef4444")}
        ${statCard(outstanding.length, "Outstanding Docs",      "#f59e0b")}
        ${statCard(newEnquiries.length,"New Today",             "#3b82f6")}
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:0 32px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0">`;

    // ── Section 1: Flagged cases ──────────────────────────────────────────
    if (flagged.length > 0) {
      html += sectionHeader("🚨", "Needs Attention");
      for (const s of flagged) {
        const flags = s.conflict_flags.join(" · ");
        html += caseRow(s, `⚠️ ${flags}`);
      }
    }

    // ── Section 2: Outstanding documents ─────────────────────────────────
    if (outstanding.length > 0) {
      html += sectionHeader("📋", "Outstanding Documents");
      // Sort by phase priority (later phases = more urgent)
      const sorted = [...outstanding].sort((a, b) =>
        PHASE_ORDER.indexOf(b.current_phase) - PHASE_ORDER.indexOf(a.current_phase)
      );
      for (const s of sorted) {
        const docs = s.missing_documents.join(", ");
        html += caseRow(s, `Missing: ${docs}`);
      }
    }

    // ── Section 3: Overnight activity ─────────────────────────────────────
    if (events.length > 0) {
      html += sectionHeader("🕐", "Overnight Activity");
      for (const e of events.slice(0, 15)) {
        const name = e.mortgage_application_states?.borrower_name || e.mortgage_application_states?.sender_email || "Unknown";
        const time = new Date(e.created_at).toLocaleTimeString("en-IE", { hour:"2-digit", minute:"2-digit" });
        html += `<tr><td style="padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px;">
          <span style="color:#111827;font-weight:600;">${name}</span>
          <span style="color:#6b7280;"> · ${e.event_type?.replace(/_/g," ") || "update"}</span>
          <span style="color:#9ca3af;float:right;">${time}</span>
          ${e.description ? `<div style="color:#6b7280;font-size:12px;margin-top:2px;">${e.description}</div>` : ""}
        </td></tr>`;
      }
    }

    // ── Section 4: Pipeline overview ──────────────────────────────────────
    html += sectionHeader("📊", "Pipeline Overview");
    html += `<tr><td style="padding:12px 0;">
      <table width="100%" cellpadding="0" cellspacing="0">`;
    for (const phase of PHASE_ORDER) {
      const cases = byPhase[phase] || [];
      if (!cases.length) continue;
      const color = phaseColor(phase);
      const names = cases.map(s => s.borrower_name || s.sender_email || "Unknown").join(", ");
      html += `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;width:140px;">
          ${pill(PHASE_LABEL[phase], color)}
        </td>
        <td style="padding:6px 0 6px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#374151;">
          <strong>${cases.length}</strong> — ${names}
        </td>
      </tr>`;
    }
    html += `</table></td></tr>`;

    // ── Footer ─────────────────────────────────────────────────────────────
    html += `
    </table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
    <div style="font-size:12px;color:#9ca3af;text-align:center;">
      Sent by Maeve · Sprimal AI for At Once Mortgages
    </div>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

    // ── Send via Resend (maeve@sprimal.com) ─────────────────────────────────
    const subject = `☀️ Morning Digest — ${today.toLocaleDateString("en-IE", { day:"numeric", month:"short" })} · ${states.length} cases, ${flagged.length} flagged, ${outstanding.length} with outstanding docs`;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from:    "Maeve · At Once Mortgages <maeve@sprimal.com>",
        to:      [process.env.BROKER_EMAIL],
        cc:      ["hello@sprimal.com"],
        subject,
        html
      })
    });

    if (!resendRes.ok) {
      const err = await resendRes.text();
      throw new Error(`Resend API error: ${err}`);
    }

    console.log(`[digest] Morning digest sent to ${process.env.BROKER_EMAIL} — ${states.length} cases, ${flagged.length} flagged`);
    return { ok: true, cases: states.length, flagged: flagged.length, outstanding: outstanding.length };

  } catch (err) {
    console.error("[digest] Failed to send morning digest:", err.message);
    throw err;
  }
}

// ── Schedule digest at 07:30 Irish time (UTC+1) every weekday ─────────────────
function scheduleMorningDigest() {
  function msUntilNext730() {
    const now    = new Date();
    const target = new Date(now);
    // Irish Standard Time is UTC+1 (UTC+0 in winter — close enough for a morning digest)
    target.setUTCHours(6, 30, 0, 0); // 06:30 UTC = 07:30 IST
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target - now;
  }

  let lastDigestDate = null;

  function checkAndSend() {
    const now     = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const hour    = now.getUTCHours();
    const min     = now.getUTCMinutes();
    const isWeekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;

    // Send between 06:30–06:35 UTC (07:30–07:35 IST) on weekdays, once per day
    if (isWeekday && hour === 6 && min >= 30 && min < 35 && lastDigestDate !== dateKey) {
      lastDigestDate = dateKey;
      sendMorningDigest().catch(err => console.error("[digest] Scheduled send failed:", err.message));
    }
  }

  // Check every minute
  setInterval(checkAndSend, 60 * 1000);
  console.log("[digest] Morning digest scheduler active — fires 07:30 IST weekdays");
}

// Admin endpoint — resend welcome email to any tenant
app.get("/api/admin/send-welcome-email/:tenantId", requireAdmin, async (req, res) => {
  try {
    const { tenantId } = req.params;

    const { data: tenant, error } = await supabase
      .from("tenants")
      .select("id, name, email, website, portal_password")
      .eq("id", tenantId)
      .maybeSingle();

    if (error || !tenant) return res.status(404).json({ ok: false, error: "Tenant not found" });

    // Count imported pages
    const { count: imported } = await supabase
      .from("knowledge_chunks")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("document_type", "Website Content");

    const name           = tenant.name || tenantId;
    const email          = tenant.email;
    const website        = tenant.website || "";
    const portalPassword = tenant.portal_password || "";

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Sprimal <hello@sprimal.com>",
        to:   email,
        bcc:  ["hello@sprimal.com"],
        subject: `Your Sprimal assistant is ready 🎉`,
        html: buildWelcomeEmailHtml({ name, email, portalPassword, website, imported: imported || 0, tenantId })
      })
    });

    if (!resendRes.ok) {
      const err = await resendRes.text();
      return res.status(500).json({ ok: false, error: `Resend error: ${err}` });
    }

    console.log(`[admin] Welcome email resent to ${email} for tenant ${tenantId}`);
    res.json({ ok: true, message: `Welcome email sent to ${email}` });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin endpoint — trigger digest manually for testing
app.get("/api/admin/send-morning-digest", requireAdmin, async (req, res) => {
  try {
    const result = await sendMorningDigest();
    res.json({ ok: true, message: "Digest sent", ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Email intent classifier ──────────────────────────────────────────────────
// Mirrors the Python email_router.py logic.
// Step 1: header-based pre-filter (free, instant).
// Step 2: Anthropic LLM classification with prompt caching on the static system prompt.
// Fails open — on any error, defaults to needs_reply so real enquiries are never silently dropped.

const EMAIL_CLASSIFIER_SYSTEM_PROMPT = `You are an email intent classifier for a mortgage broker's inbox. Your job is to read an incoming email and determine:

1. The primary intent of the sender — choose exactly one:
   ACTIONABLE (sender expects a personal response):
   - Question       — asking something that requires an answer
   - Request        — asking for a document, callback, or action
   - Scheduling     — proposing or confirming a meeting or call
   - Problem        — reporting an issue or urgent situation
   - Mortgage Enquiry — new or ongoing mortgage application enquiry

   PASSIVE (no personal reply needed):
   - Information/FYI — sharing information with no engagement needed
   - Transactional  — automated receipt, invoice, or order confirmation
   - System Alert   — server alert, monitoring notification
   - Auto-Response  — out-of-office reply, vacation auto-responder
   - Promotional    — newsletter, marketing, or sales email

2. Whether to reply or suppress:
   - "needs_reply"  → Question, Request, Scheduling, Problem, Mortgage Enquiry
   - "no_reply"     → Information/FYI, Transactional, System Alert, Auto-Response, Promotional

3. Your confidence as a decimal from 0.0 to 1.0.

Strict rules:
- Out-of-office or vacation replies → Auto-Response + no_reply always.
- Newsletters or marketing → Promotional + no_reply always.
- Only choose needs_reply if a real human is clearly seeking a personal response.
- When uncertain, lean toward no_reply to avoid reply loops.

Respond with ONLY valid JSON, no markdown, no extra text:
{"intent":"<one of the ten intents>","category":"needs_reply|no_reply","confidence":<float>,"type":"short_snake_case_label","reason":"one concise sentence"}`;

// RFC 3834 / RFC 2369 automated-email header rules — same as Python email_router.py
const SUPPRESS_HEADER_RULES = [
  // auto-submitted: anything except "no" means automated
  { header: "auto-submitted",           check: v => v.toLowerCase().trim() !== "no" },
  { header: "x-auto-response-suppress", check: () => true },
  { header: "x-autoreply",              check: () => true },
  { header: "x-autorespond",            check: () => true },
  // bulk/list mailers
  { header: "precedence",               check: v => ["bulk","list","junk"].includes(v.toLowerCase().trim()) },
  { header: "list-unsubscribe",         check: () => true },
  { header: "list-id",                  check: () => true },
];

function checkEmailHeaders(headers = {}) {
  // headers is a plain object with lowercase keys, e.g. { "auto-submitted": "auto-replied" }
  for (const rule of SUPPRESS_HEADER_RULES) {
    const value = headers[rule.header];
    if (value && rule.check(String(value))) {
      return `Header '${rule.header}: ${value}' marks email as automated`;
    }
  }
  return null; // no suppression headers found — proceed to LLM
}

async function classifyInboundEmail(from, subject, body, headers = {}) {
  // Step 1 — header pre-filter (free, no API call needed)
  const headerReason = checkEmailHeaders(headers);
  if (headerReason) {
    console.log(`[email-classify] Suppressed by header: ${headerReason}`);
    return { category: "no_reply", intent: "Auto-Response", confidence: 1.0, type: "automated_header", reason: headerReason };
  }

  // Step 2 — Anthropic LLM classification with prompt caching
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",   // fast, cheap classifier; swap to claude-opus-4-7 for max accuracy
      max_tokens: 256,
      system: [
        {
          type: "text",
          text: EMAIL_CLASSIFIER_SYSTEM_PROMPT,
          // cache_control marker — caching only activates when prefix >= 4096 tokens (haiku-4-5 minimum)
          // Left here so it kicks in automatically if the prompt is ever expanded
          cache_control: { type: "ephemeral" }
        }
      ],
      messages: [
        {
          role: "user",
          content: `From: ${from}\nSubject: ${subject}\n\n${body.slice(0, 2000)}`
        }
      ]
    });

    // Log cache metrics so we can verify prompt caching is working
    const usage = response.usage;
    console.log(
      `[email-classify] LLM tokens — input: ${usage.input_tokens} | cache_write: ${usage.cache_creation_input_tokens || 0} | cache_read: ${usage.cache_read_input_tokens || 0} | output: ${usage.output_tokens}`
    );

    let rawText = response.content.find(b => b.type === "text")?.text?.trim() || "{}";
    // Strip markdown code fences — model sometimes wraps JSON in ```json...``` despite instructions
    rawText = rawText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
    const parsed = JSON.parse(rawText);

    const category = parsed.category === "needs_reply" ? "needs_reply" : "no_reply";
    return {
      category,
      intent:     parsed.intent     || "Unknown",
      confidence: parsed.confidence || 0.5,
      type:       parsed.type       || category,
      reason:     parsed.reason     || ""
    };

  } catch (err) {
    console.error("[email-classify] Error:", err.message);
    // Fail open — better to generate an unnecessary draft than miss a real enquiry
    return { category: "needs_reply", intent: "Unknown", confidence: 0, type: "unknown", reason: "Classification failed — defaulting to reply" };
  }
}

// ─── Gmail label tagging ─────────────────────────────────────────────────────
// Gmail exposes labels as IMAP mailbox folders.
// Copying a message into a label folder applies that label without moving the
// email out of INBOX — so Cormac sees both the label and the original inbox view.
//
// Labels created under "Sprimal/" so they group neatly in the Gmail sidebar:
//   Sprimal/Mortgage Enquiry   Sprimal/Question   Sprimal/Request
//   Sprimal/Scheduling         Sprimal/Problem
//   Sprimal/Auto-Response      Sprimal/Promotional Sprimal/Transactional
//   Sprimal/System Alert       Sprimal/Information
//   Sprimal/Unknown            Sprimal/Reply       Sprimal/Suppressed

const gmailLabelCache = new Set(); // track which labels we've already ensured exist

async function applyGmailLabel(imapClient, uid, labelName) {
  try {
    // Create the label (IMAP mailbox) if we haven't seen it yet this session.
    // mailboxCreate is a no-op on Gmail if the folder already exists.
    if (!gmailLabelCache.has(labelName)) {
      try {
        await imapClient.mailboxCreate(labelName);
      } catch (_) {
        // Already exists or server rejected — safe to continue
      }
      gmailLabelCache.add(labelName);
    }

    // COPY adds the Gmail label to the message without moving it from INBOX
    await imapClient.messageCopy(uid, labelName, { uid: true });
    console.log(`[email-poll] Gmail label applied: "${labelName}"`);
  } catch (err) {
    // Non-fatal — labelling is best-effort, email processing still continues
    console.warn(`[email-poll] Could not apply Gmail label "${labelName}": ${err.message}`);
  }
}

async function processInboundEmail({ from, subject, body, cls = {} }) {
  console.log(`[email-poll] Processing: "${subject}" from ${from}`);

  try {
    // ── Email context pipeline (fail-safe — falls back gracefully) ────────────
    let applicationContext = null;
    try {
      const cleanedBody = deduplicateEmailBody(body);
      console.log(`[email-context] Cleaned: ${cleanedBody.length} chars (raw: ${body.length} chars)`);

      const entities = await extractEmailEntities(cleanedBody, from, subject);
      console.log(`[email-context] Entities: event=${entities.event_type} docs_received=[${(entities.documents_received||[]).join(",")}] client_email=${entities.client_email||"null"} app_ref=${entities.application_ref||"null"}`);

      const state       = await findOrCreateApplicationState(from, entities, false); // direct client email
      if (!state) {
        console.log(`[email-context] Noise gate triggered — no application context built for ${from}`);
      } else {
        const updatedState = await updateApplicationState(state, entities, cleanedBody, from, subject);
        applicationContext = await getApplicationContext(updatedState.id);
      }

      console.log(`[email-context] Phase: ${applicationContext.state?.current_phase} | Docs received: ${applicationContext.state?.received_documents?.join(", ") || "none"}`);
    } catch (ctxErr) {
      console.warn(`[email-context] Pipeline failed — continuing without context: ${ctxErr.message}`);
    }

    const rawDraft = await runEmailResponseAgent(body, from, applicationContext);

    // Strip any trailing sign-off the AI added — the real signature provides it
    const draftBody = rawDraft.trim()
      .replace(/\n*(kind regards|best regards|many thanks|thanks|warm regards|regards|best|cheers|sincerely|yours sincerely|yours faithfully),?\s*(cormac|maeve)?\s*$/i, "")
      .trim();
    const draft = `${draftBody}\n\n${CORMAC_SIGNATURE}`;

    // ── HTML email — draft is visually distinct at a glance ──────────────────
    const intentLabel    = cls.intent     || "Unknown";
    const confidencePct  = Math.round((cls.confidence || 0) * 100);
    const classifyReason = cls.reason     || "";

    // Convert plain-text draft to HTML (preserve line breaks)
    const draftHtml = draft.trim()
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");

    const originalHtml = body.trim()
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");

    // Table-based layout — works in Outlook desktop (Word renderer), Gmail, and Outlook 365 web.
    // Rules: bgcolor attribute on <td> (Outlook ignores CSS background on divs),
    //        no border-radius (never renders in Outlook), no emoji (render as boxes).
    const fromSafe    = from.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const subjectSafe = subject.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

    const htmlBody = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:16px;font-family:Arial,sans-serif;font-size:14px;color:#333;background:#ffffff;">

  <!-- Classification banner -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
    <tr>
      <td bgcolor="#eef2ff" style="background:#eef2ff;border-left:4px solid #4f6ef7;padding:10px 14px;font-family:Arial,sans-serif;font-size:13px;color:#444;">
        <strong>Sprimal AI</strong> &nbsp;&bull;&nbsp;
        Intent: <strong>${intentLabel}</strong> &nbsp;&bull;&nbsp;
        Confidence: <strong>${confidencePct}%</strong>
        ${classifyReason ? `&nbsp;&bull;&nbsp; <em style="color:#666;">${classifyReason}</em>` : ""}
      </td>
    </tr>
  </table>

  <!-- Suggested draft — green box -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;border:2px solid #38a169;">
    <tr>
      <td bgcolor="#f0fff4" style="background:#f0fff4;padding:20px 24px;">
        <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:#276749;letter-spacing:1px;text-transform:uppercase;margin-bottom:14px;">
          SUGGESTED DRAFT REPLY
        </div>
        <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#1a202c;">
          ${draftHtml}
        </div>
      </td>
    </tr>
  </table>

  <!-- Original email — greyed out -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td bgcolor="#f7fafc" style="background:#f7fafc;border-left:3px solid #cbd5e0;padding:10px 16px;font-family:Arial,sans-serif;font-size:13px;color:#718096;">
        <div style="font-family:Arial,sans-serif;font-weight:bold;color:#4a5568;margin-bottom:6px;">Original email</div>
        <div style="font-family:Arial,sans-serif;"><strong>From:</strong> ${fromSafe}</div>
        <div style="font-family:Arial,sans-serif;"><strong>Subject:</strong> ${subjectSafe}</div>
        <div style="font-family:Arial,sans-serif;margin-top:10px;line-height:1.6;">${originalHtml}</div>
      </td>
    </tr>
  </table>

  <p style="font-family:Arial,sans-serif;font-size:11px;color:#a0aec0;margin-top:16px;">
    Generated by Sprimal &nbsp;&bull;&nbsp; Review before sending &nbsp;&bull;&nbsp; Not sent to client yet
  </p>

</body>
</html>`;

    // Plain-text fallback for email clients that don't render HTML
    const textBody =
`[SPRIMAL DRAFT — ${intentLabel} · ${confidencePct}% confidence]

SUGGESTED DRAFT REPLY:
──────────────────────────────────────────
${draft.trim()}
──────────────────────────────────────────

ORIGINAL EMAIL
From: ${from}
Subject: ${subject}

${body.trim()}

──────────────────────────────────────────
Generated by Sprimal · Review before sending · Not sent to client yet`;

    // Never send back to the monitored inbox — that causes a loop; deduplicate addresses
    const recipients = [...new Set(
      [brokerEmail, "hello@sprimal.com"]
        .filter(Boolean)
        .map(e => e.toLowerCase())
        .filter(e => e !== (process.env.GMAIL_USER || "").toLowerCase())
    )];

    if (recipients.length === 0) {
      console.log("[email-poll] No recipients configured — skipping send");
      return;
    }

    const gmailTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });

    await gmailTransporter.sendMail({
      from:    process.env.GMAIL_USER,
      to:      recipients.join(", "),
      subject: `Draft reply: ${subject}`,
      html:    htmlBody,
      text:    textBody
    });

    console.log(`[email-poll] Draft sent to ${recipients.join(", ")}`);
  } catch (err) {
    console.error(`[email-poll] processInboundEmail error for "${subject}":`, err.message);
  }
}

// Helper — create a fresh ImapFlow client each time so there's no shared socket state
function makeImapClient() {
  const c = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false
  });
  c.on("error", (err) => console.error("[email-poll] ImapFlow error event:", err.message));
  return c;
}

async function pollGmailInbox() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;

  // ── Phase 1: fetch sources + mark as seen immediately ────────────────────
  // Mark emails as seen RIGHT HERE while the connection is fresh, before any
  // slow LLM work. This guarantees no email is ever reprocessed even if the
  // later phases fail. Labels are applied afterwards as best-effort only.
  const rawMessages = []; // [{ uid, source }]

  try {
    const fetchClient = makeImapClient();
    await fetchClient.connect();
    const lock = await fetchClient.getMailboxLock("INBOX");

    try {
      const uids = await fetchClient.search({ seen: false }, { uid: true });

      if (!uids || uids.length === 0) {
        console.log("[email-poll] No new messages");
        // fall through to finally — do NOT return here, logout must always run
      } else {
        console.log(`[email-poll] ${uids.length} unseen message(s) — fetching sources`);

        for await (const msg of fetchClient.fetch(uids.join(","), { source: true, uid: true }, { uid: true })) {
          rawMessages.push({ uid: msg.uid, source: Buffer.from(msg.source) });
        }

        // Mark as seen now — before any LLM calls — so a crash in Phase 2
        // never causes the same email to be processed twice.
        const fetchedUids = rawMessages.map(m => m.uid);
        await fetchClient.messageFlagsAdd(fetchedUids.join(","), ["\\Seen"], { uid: true });
        console.log(`[email-poll] Marked ${fetchedUids.length} message(s) as read`);
      }
    } finally {
      lock.release();
      try { await fetchClient.logout(); } catch (_) {} // always close — prevents socket timeout on idle polls
    }
  } catch (err) {
    console.error("[email-poll] IMAP fetch error:", err.message);
    return;
  }

  // Nothing to process — exit cleanly
  if (rawMessages.length === 0) return;

  // ── Phase 2: classify + reply — no IMAP connection held ───────────────────

  // Senders that should never trigger a draft reply.
  //
  // INTERNAL_DOMAINS  — whole domains (Cormac's colleagues)
  // SKIP_ADDRESSES    — specific automated addresses at external organisations
  //                     (lender batch systems, document portals, etc.)
  //                     Don't block the whole lender domain — underwriters at
  //                     the same org may send genuine queries that need replies.
  const INTERNAL_DOMAINS = []; // no fully-ignored domains — @aom.ie moved to context-only

  const SKIP_ADDRESSES = [];

  // Context-only senders — no reply generated, but email IS run through the
  // context pipeline so document events update the application state.
  const CONTEXT_ONLY_ADDRESSES = [
    "adobesign@adobesign.com",        // Adobe Sign — gift letters, declarations, consent forms
    "imcapplications@ptsb.ie",        // PTSB — document acknowledgements & application status updates
    "electronicvaluations@ptsb.ie",   // PTSB — valuation confirmations & milestones
    "noreply@mail.nuamoney.com",      // NUA Money — automated application notifications
    "maeve@sprimal.com",              // Sprimal AI — context only, never reply to self
    "aom@onlineapplication.io",       // AOM online application portal (exact address variant)
    "no-reply@asana.com",             // Asana task notifications — may contain case details
    "rome@boi.com",                   // Bank of Ireland — case updates, context only
    "michael.c.o'malley@aib.ie",      // Haven/AIB business manager — case updates, context only
  ];

  const CONTEXT_ONLY_DOMAINS = [
    "@aom.onlineapplication.io",      // AOM online application portal (subdomain variant)
    "@onlineapplication.io",          // AOM online application portal — all automated notifications
    "@aom.ie",                        // AOM colleagues — case updates, doc requests, milestones
    "@ptsb.ie",                       // PTSB staff — lender communications, never auto-reply
    "@boi.com",                       // Bank of Ireland staff
    "@bankofireland.com",             // Bank of Ireland
    "@havenmortgages.ie",             // Haven Mortgages
    "@haven.ie",                      // Haven (alt domain)
    "@aib.ie",                        // AIB staff
    "@avant.ie",                      // Avant Money
    "@avantmoney.ie",                 // Avant Money (alt domain)
    "@nuamoney.com",                  // Nua Money
    "@irishlife.ie",                  // Irish Life
    "@ebs.ie",                        // EBS
  ];

  // Noise senders — fully ignored. No reply, no context pipeline, no LLM call.
  // These are non-mortgage transactional/marketing emails that can never contain
  // application-relevant data. Add to this list whenever the application state
  // table accumulates junk rows from a recurring sender.
  const NOISE_SKIP_ADDRESSES = [
    "oriordann@gmail.com",                  // Sprimal admin — never process or reply
    "messaging-service@post.xero.com",      // Xero invoice notifications
    "info@micksgarage.com",                 // Car parts marketing
    "events@lia.ie",                        // LIA CPD event invitations
    "latest@royallondonnews.com",           // Royal London insurance marketing
    "peter.rice@irishlife.ie",              // Irish Life weekly markets marketing
    // "no-reply@asana.com" — moved to context-only (Asana tasks may contain case details)
    "noreply@reports.connecteam.com",       // Connecteam time tracking
    "no-reply@teams.mail.microsoft",        // Microsoft Teams notifications
    "noreply.invitations@trustpilotmail.com", // Trustpilot review requests
    // Third-party professionals (surveyors, other brokers, estate agents)
    // who email AOM but are not clients and not lenders
    "cdsurveyingltd@gmail.com",
    "robert@irishandeuropean.ie",
    "info@reaodonoghueclarke.ie",
    "gary@gtfm.ie",
  ];

  const NOISE_SKIP_DOMAINS = [
    // Add domain-level noise patterns here, e.g. "@post.xero.com"
    "@post.xero.com",
  ];

  function isNoiseSender(fromText) {
    const match = fromText.match(/<([^>]+)>/);
    const addr  = (match ? match[1] : fromText).toLowerCase().trim();
    if (NOISE_SKIP_ADDRESSES.includes(addr)) return true;
    if (NOISE_SKIP_DOMAINS.some(d => addr.endsWith(d))) return true;
    return false;
  }

  function isInternalSender(fromText) {
    const match = fromText.match(/<([^>]+)>/);
    const addr  = (match ? match[1] : fromText).toLowerCase().trim();
    if (INTERNAL_DOMAINS.some(d => addr.endsWith(d))) return true;
    if (SKIP_ADDRESSES.includes(addr)) return true;
    return false;
  }

  function isContextOnlySender(fromText) {
    const match = fromText.match(/<([^>]+)>/);
    const addr  = (match ? match[1] : fromText).toLowerCase().trim();
    if (CONTEXT_ONLY_ADDRESSES.includes(addr)) return true;
    if (CONTEXT_ONLY_DOMAINS.some(d => addr.endsWith(d))) return true;
    return false;
  }

  const results = []; // [{ uid, cls }]

  for (const { uid, source } of rawMessages) {
    try {
      const parsed  = await simpleParser(source);
      const from    = parsed.from?.text || "Unknown";
      const subject = parsed.subject   || "(no subject)";
      const body    = parsed.text      || parsed.html || "";

      const rawHeaders = {};
      if (parsed.headers) {
        for (const [key, value] of parsed.headers.entries()) {
          rawHeaders[key.toLowerCase()] = String(value);
        }
      }

      // If Cormac is CC'd but not in the TO field, he's just observing.
      // Only generate a reply if the email explicitly asks Cormac to act
      // (e.g. "Cormac, can you..." / "Cormac please...").
      const gmailUser  = (process.env.GMAIL_USER || "").toLowerCase();
      const toAddrs    = (parsed.to?.value   || []).map(a => (a.address || "").toLowerCase());
      const ccAddrs    = (parsed.cc?.value   || []).map(a => (a.address || "").toLowerCase());
      const isCCOnly   = ccAddrs.includes(gmailUser) && !toAddrs.includes(gmailUser);

      if (isCCOnly) {
        // Check if Cormac is specifically called on in the body
        const cormacAddressed = /\bcormac\b.{0,80}(\?|please|can you|could you|would you|do you|will you)/i.test(body)
                             || /\bcormac\b.*\bcan you\b/i.test(body);

        // Always update context (CC email — treat as staff/system, never create)
        try {
          const cleanedBody = deduplicateEmailBody(body);
          const entities    = await extractEmailEntities(cleanedBody, from, subject);
          const state       = await findOrCreateApplicationState(from, entities, true); // isStaffOrSystem=true
          if (state) await updateApplicationState(state, entities, cleanedBody, from, subject);
        } catch (ctxErr) {
          console.warn(`[email-context] CC-only pipeline failed: ${ctxErr.message}`);
        }

        if (!cormacAddressed) {
          console.log(`[email-poll] CC-only email from ${from}: "${subject}" — context updated, no reply needed`);
          results.push({ uid, cls: { intent: "CC-only" } });
          continue;
        }

        console.log(`[email-poll] CC-only but Cormac directly addressed in "${subject}" — generating reply`);
        // Fall through to normal classification + reply
      }

      // Skip internal team emails — colleagues asking Cormac queries
      if (isInternalSender(from)) {
        console.log(`[email-poll] Skipping internal email from ${from}: "${subject}"`);
        results.push({ uid, cls: { intent: "Internal" } });
        continue;
      }

      // Skip known noise senders — no reply, no context pipeline, no LLM cost
      if (isNoiseSender(from)) {
        console.log(`[email-poll] Skipping noise sender ${from}: "${subject}"`);
        results.push({ uid, cls: { intent: "Noise" } });
        continue;
      }

      if (subject.startsWith("Draft reply:")) {
        console.log(`[email-poll] Skipping loop-guard email: "${subject}"`);
        results.push({ uid, cls: { intent: "Transactional" } });
        continue;
      }

      // Context-only senders — run context pipeline to capture document events
      // (e.g. Adobe Sign gift letter signed) but do NOT generate a reply
      if (isContextOnlySender(from)) {
        console.log(`[email-poll] Context-only sender: "${subject}" from ${from} — updating application state, no reply`);
        try {
          const cleanedBody = deduplicateEmailBody(body);
          const entities    = await extractEmailEntities(cleanedBody, from, subject);
          console.log(`[email-context] Adobe Sign entities: event=${entities.event_type} docs_received=[${(entities.documents_received||[]).join(",")}]`);
          const state = await findOrCreateApplicationState(from, entities, true); // isStaffOrSystem=true
          if (state) await updateApplicationState(state, entities, cleanedBody, from, subject);
        } catch (ctxErr) {
          console.warn(`[email-context] Context-only pipeline failed: ${ctxErr.message}`);
        }
        results.push({ uid, cls: { intent: "Transactional" } });
        continue;
      }

      const cls = await classifyInboundEmail(from, subject, body, rawHeaders);
      console.log(
        `[email-poll] Classified "${subject}" → ${cls.intent} (${cls.category}, ${Math.round((cls.confidence||0)*100)}% confidence): ${cls.reason}`
      );

      if (cls.category === "needs_reply") {
        await processInboundEmail({ from, subject, body, cls });
      } else {
        console.log(`[email-poll] Skipping — no reply needed`);
      }

      results.push({ uid, cls });
    } catch (msgErr) {
      console.error("[email-poll] Error processing message:", msgErr.message);
      results.push({ uid, cls: { intent: "Unknown" } });
    }
  }

  if (results.length === 0) return;

  // ── Phase 3: apply Gmail labels (best-effort) ─────────────────────────────
  // Emails are already marked as seen above, so a failure here is cosmetic only.
  try {
    const labelClient = makeImapClient();
    await labelClient.connect();
    const lock = await labelClient.getMailboxLock("INBOX");

    try {
      for (const { uid, cls } of results) {
        if (cls?.intent) {
          await applyGmailLabel(labelClient, uid, `Sprimal/${cls.intent}`);
        }
      }
    } finally {
      lock.release();
    }

    try { await labelClient.logout(); } catch (_) {}
  } catch (err) {
    // Non-fatal — labels are cosmetic, core processing already completed
    console.warn(`[email-poll] Gmail label phase skipped: ${err.message}`);
  }
}

function startEmailPolling() {
  if (process.env.EMAIL_POLLING_ENABLED !== "true") {
    console.log("[email-poll] Disabled (EMAIL_POLLING_ENABLED != true)");
    return;
  }
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log("[email-poll] GMAIL_USER or GMAIL_APP_PASSWORD not set — email polling disabled");
    return;
  }

  console.log(`[email-poll] Gmail polling active for ${process.env.GMAIL_USER} (every 2 min)`);
  pollGmailInbox();
  setInterval(pollGmailInbox, 2 * 60 * 1000);
}

// ─── Chat Workflow Builder ─────────────────────────────────────────────────────

// Public: fetch all flows for a club — widget uses the active one as entry point
// and keeps all others in a lookup map for switch_flow navigation.
app.get("/api/workflow/:clubId", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  const { clubId } = req.params;
  try {
    const { data: flows } = await supabase
      .from("chat_workflows")
      .select("id, name, is_active, workflow_steps(id, step_order, bot_message, workflow_choices(id, choice_order, label, action_type, action_value))")
      .eq("club_id", clubId)
      .order("created_at", { ascending: true });
    const allFlows   = flows || [];
    const rootFlow   = allFlows.find(function (f) { return f.is_active; }) || null;
    res.json({ workflow: rootFlow, allFlows: allFlows });
  } catch (err) {
    res.json({ workflow: null, allFlows: [] });
  }
});

// Portal: list all workflows for the logged-in tenant
app.get("/api/portal/workflows", requireTenant, async (req, res) => {
  const clubId = req.tenant.tenantId;
  const { data, error } = await supabase
    .from("chat_workflows")
    .select("id, name, is_active, created_at, updated_at, workflow_steps(id, step_order, bot_message, workflow_choices(id, choice_order, label, action_type, action_value))")
    .eq("club_id", clubId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ workflows: data || [] });
});

// Portal: create a new (empty) workflow
app.post("/api/portal/workflows", requireTenant, async (req, res) => {
  const clubId = req.tenant.tenantId;
  const { name } = req.body;
  const { data, error } = await supabase
    .from("chat_workflows")
    .insert({ club_id: clubId, name: name || "New Flow" })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ workflow: data });
});

// Portal: update workflow metadata (name / is_active)
app.put("/api/portal/workflows/:id", requireTenant, async (req, res) => {
  const clubId = req.tenant.tenantId;
  const { id }   = req.params;
  const { name, is_active } = req.body;

  // If activating this workflow, deactivate all others for this club first
  if (is_active === true) {
    await supabase.from("chat_workflows").update({ is_active: false }).eq("club_id", clubId);
  }

  const updates = { updated_at: new Date().toISOString() };
  if (name      !== undefined) updates.name      = name;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await supabase
    .from("chat_workflows")
    .update(updates)
    .eq("id", id)
    .eq("club_id", clubId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ workflow: data });
});

// Portal: delete a workflow (cascades to steps and choices)
app.delete("/api/portal/workflows/:id", requireTenant, async (req, res) => {
  const clubId = req.tenant.tenantId;
  const { id } = req.params;
  const { error } = await supabase
    .from("chat_workflows")
    .delete()
    .eq("id", id)
    .eq("club_id", clubId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Portal: replace all steps + choices for a workflow (full overwrite on save)
app.put("/api/portal/workflows/:id/steps", requireTenant, async (req, res) => {
  const clubId = req.tenant.tenantId;
  const { id }   = req.params;
  const { steps } = req.body; // [{step_order, bot_message, choices:[{label,action_type,action_value,choice_order}]}]

  // Verify the workflow belongs to this tenant
  const { data: wf } = await supabase.from("chat_workflows").select("id").eq("id", id).eq("club_id", clubId).single();
  if (!wf) return res.status(404).json({ error: "Workflow not found" });

  try {
    // Delete existing steps (choices cascade automatically)
    await supabase.from("workflow_steps").delete().eq("workflow_id", id);

    for (const step of (steps || [])) {
      const { data: newStep, error: stepErr } = await supabase
        .from("workflow_steps")
        .insert({ workflow_id: id, step_order: step.step_order, bot_message: step.bot_message || "" })
        .select("id")
        .single();
      if (stepErr) throw stepErr;

      const validChoices = (step.choices || []).filter(c => c.label && c.label.trim());
      if (newStep && validChoices.length) {
        const { error: chErr } = await supabase.from("workflow_choices").insert(
          validChoices.map((c, i) => ({
            step_id:      newStep.id,
            choice_order: c.choice_order ?? i,
            label:        c.label.trim(),
            action_type:  c.action_type || "message",
            action_value: c.action_value || null
          }))
        );
        if (chErr) throw chErr;
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[workflow] Save error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /sites/:tenantId — Auto-generated tenant website ──────────────────────
function esc(str) {
  return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function buildTenantSiteHtml(tenant) {
  const name  = esc(tenant.name || "");
  const desc  = esc(tenant.business_description || "");
  const email = esc(tenant.email || "");
  const site  = tenant.website || "";
  const logo  = esc(tenant.logo_url || "");
  const btype = tenant.business_type || "other";
  const tid   = esc(tenant.id || "");

  const palettes = {
    gaa_club:         { primary: "#14532d", accent: "#166534", light: "#f0fdf4" },
    team_sports_club: { primary: "#1e3a8a", accent: "#3b82f6", light: "#eff6ff" },
    tennis_club:      { primary: "#0d2060", accent: "#c9a720", light: "#f0f5ff" },
    golf_club:        { primary: "#1a3a1a", accent: "#a16207", light: "#fefce8" },
    cafe:             { primary: "#78350f", accent: "#f59e0b", light: "#fffbeb" },
    fitness_studio:   { primary: "#111827", accent: "#7c3aed", light: "#f5f3ff" },
    yoga_studio:      { primary: "#4a1d96", accent: "#ec4899", light: "#fdf4ff" },
    swim_club:        { primary: "#0c4a6e", accent: "#0ea5e9", light: "#f0f9ff" },
  };
  const pal     = palettes[btype] || { primary: "#1e3a8a", accent: "#3b82f6", light: "#eff6ff" };
  const primary = (tenant.brand_color && /^#[0-9a-f]{6}$/i.test(tenant.brand_color)) ? tenant.brand_color : pal.primary;
  let accent    = pal.accent;
  const light   = pal.light;

  const darkenHex = (hex, f) => {
    const r = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(1,3),16) * f)));
    const g = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(3,5),16) * f)));
    const b = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(5,7),16) * f)));
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
  };
  const hexRgb = (hex) => `${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)}`;
  const primaryDark = darkenHex(primary, 0.4);

  // ── Shared building blocks ────────────────────────────────────────────────
  const logoImg = logo
    ? `<img src="${logo}" alt="${name}" style="width:88px;height:88px;border-radius:50%;object-fit:cover;background:white;padding:5px;box-shadow:0 2px 16px rgba(0,0,0,0.22);margin-bottom:18px;" onerror="this.outerHTML='<div style=\\'width:88px;height:88px;border-radius:50%;background:rgba(255,255,255,0.18);display:flex;align-items:center;justify-content:center;font-size:36px;margin-bottom:18px;\\'>🏆</div>'">`
    : `<div style="width:88px;height:88px;border-radius:50%;background:rgba(255,255,255,0.18);display:flex;align-items:center;justify-content:center;font-size:36px;margin-bottom:18px;">🏆</div>`;

  const chatUrl  = `https://app.sprimal.com/chat/${tid}`;
  const fbUrl    = esc(tenant.facebook_url    || "");
  const igHandle = esc(tenant.instagram_handle || "");
  const twHandle = esc(tenant.twitter_handle  || "");
  let socialImages = [];
  try {
    const raw = tenant.social_images;
    socialImages = Array.isArray(raw) ? raw : (typeof raw === "string" ? JSON.parse(raw) : []);
  } catch {}
  // Strip Instagram profile pic (ig_0) and logo fallback from photo pool
  socialImages = socialImages.filter(u => !/\/ig_0\./.test(u) && !/logo_fallback/i.test(u)).slice(0, 9);
  // For sports clubs prefer social action photos over site graphics; for others prefer site images
  const siteImgs    = socialImages.filter(u => /\/site_\d+\./.test(u));
  const socialImgs  = socialImages.filter(u => /\/(?:ig|tw)_\d+\./.test(u));
  const sportsTypes = ["gaa_club","tennis_club","team_sports_club","swim_club","golf_club"];
  const bgImages    = sportsTypes.includes(btype) ? [...socialImgs, ...siteImgs] : [...siteImgs, ...socialImgs];
  // Prefer JPG/WEBP for hero — PNGs tend to be graphics/logos not action photos
  // Never use logo_fallback (club crest) as hero background — it's a graphic, not a photo
  const isHeroCandidate = (u) => /\.(jpe?g|webp)(\?|$)/i.test(u) && !/logo_fallback/i.test(u);
  const heroImg = bgImages.find(isHeroCandidate) || bgImages.find(u => !/logo_fallback/i.test(u)) || "";
  const bgImg1  = bgImages.find(u => u !== heroImg && /\.(jpe?g|webp)(\?|$)/i.test(u)) || bgImages[1] || "";
  const bgImg2  = bgImages.find(u => u !== heroImg && u !== bgImg1) || bgImages[2] || "";
  const emailBtn = email ? `<a href="mailto:${email}" style="display:inline-flex;align-items:center;gap:6px;background:white;color:${primary};border:2px solid ${primary};text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:700;margin:5px;">✉️ ${email}</a>` : "";
  const siteBtn  = site  ? `<a href="${esc(site)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;background:white;color:#374151;border:2px solid #d1d5db;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:700;margin:5px;">🌐 Visit website</a>` : "";
  const socialBar = (fbUrl || igHandle || twHandle) ? `
<div style="background:#111827;padding:14px 24px;text-align:center;display:flex;justify-content:center;gap:20px;flex-wrap:wrap;">
  ${fbUrl    ? `<a href="${fbUrl}" target="_blank" rel="noopener" style="color:#9ca3af;text-decoration:none;font-size:14px;font-weight:600;">📘 Facebook</a>` : ""}
  ${igHandle ? `<a href="https://instagram.com/${igHandle}" target="_blank" rel="noopener" style="color:#9ca3af;text-decoration:none;font-size:14px;font-weight:600;">📷 Instagram</a>` : ""}
  ${twHandle ? `<a href="https://twitter.com/${twHandle}" target="_blank" rel="noopener" style="color:#9ca3af;text-decoration:none;font-size:14px;font-weight:600;">🐦 Twitter/X</a>` : ""}
</div>` : "";

  const stickyBar = (email || site) ? `
<div style="position:sticky;top:0;z-index:99;background:${primary};color:white;padding:8px 20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:13px;">
  <strong style="font-size:14px;">${name}</strong>
  <div style="display:flex;gap:12px;flex-wrap:wrap;">
    ${email ? `<a href="mailto:${email}" style="color:rgba(255,255,255,0.9);text-decoration:none;">✉️ ${email}</a>` : ""}
    ${site  ? `<a href="${esc(site)}" target="_blank" rel="noopener" style="color:rgba(255,255,255,0.9);text-decoration:none;">🌐 Website</a>` : ""}
  </div>
</div>` : "";

  const aboutSection = desc ? `
<section style="max-width:740px;margin:0 auto;padding:56px 24px;text-align:center;">
  <h2 style="font-size:26px;font-weight:800;color:#111827;margin-bottom:16px;">About ${name}</h2>
  <p style="font-size:17px;color:#374151;line-height:1.75;">${desc}</p>
</section>` : "";

  const aiSection = (cta) => `
<section id="chat" style="background:${light};padding:56px 24px;text-align:center;">
  <div style="max-width:540px;margin:0 auto;background:white;border-radius:18px;padding:36px 28px;box-shadow:0 2px 20px rgba(0,0,0,0.07);border:1.5px solid ${primary}18;">
    <div style="font-size:34px;margin-bottom:10px;">💬</div>
    <h2 style="font-size:21px;font-weight:800;color:#111827;margin-bottom:8px;">Ask our AI assistant</h2>
    <p style="font-size:15px;color:#6b7280;margin-bottom:22px;line-height:1.6;">${cta}</p>
    <a href="${chatUrl}" target="_blank" style="display:inline-block;background:${primary};color:white;text-decoration:none;padding:13px 28px;border-radius:9px;font-size:15px;font-weight:700;">Start chatting →</a>
    <p style="margin-top:12px;font-size:12px;color:#9ca3af;">Available 24/7 · No app needed</p>
  </div>
</section>`;

  const contactSection = (emailBtn || siteBtn) ? `
<section style="padding:50px 24px;text-align:center;background:#fff;">
  <h2 style="font-size:22px;font-weight:800;color:#111827;margin-bottom:8px;">Get in touch</h2>
  <p style="font-size:15px;color:#6b7280;margin-bottom:20px;">We'd love to hear from you.</p>
  ${emailBtn}${siteBtn}
</section>` : "";

  const footer = (govBody, govLink) => `
<footer style="background:#111827;color:#6b7280;text-align:center;padding:28px 24px;font-size:13px;line-height:2;">
  <div><strong style="color:#9ca3af;">${name}</strong></div>
  ${govBody ? `<div><a href="${govLink}" target="_blank" rel="noopener" style="color:#6b7280;text-decoration:none;">${govBody}</a></div>` : ""}
  <div style="margin-top:8px;"><a href="https://sprimal.com" target="_blank" style="color:#4b5563;text-decoration:none;">Powered by Sprimal</a></div>
</footer>`;

  const baseHead = (extraMeta) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${name}</title>
  <link rel="icon" href="${logo || 'https://app.sprimal.com/sprimal-icon.png'}" type="image/png">
  <link rel="apple-touch-icon" href="${logo || 'https://app.sprimal.com/sprimal-icon.png'}">
  ${extraMeta || ""}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fff;color:#111827}
    a{color:inherit}
    .badge{display:inline-block;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);color:white;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;margin:4px;}
    .code-card{background:white;border-radius:12px;padding:18px 22px;text-align:left;box-shadow:0 1px 6px rgba(0,0,0,0.07);border-left:4px solid ${accent};}
    .tier-card{background:white;border-radius:12px;padding:20px;text-align:center;box-shadow:0 1px 8px rgba(0,0,0,0.07);}
    .cta-primary{display:inline-block;background:white;color:${primary};font-weight:800;text-decoration:none;padding:14px 30px;border-radius:10px;font-size:16px;box-shadow:0 4px 14px rgba(0,0,0,0.15);}
    .cta-secondary{display:inline-block;background:rgba(255,255,255,0.15);color:white;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:10px;font-size:15px;border:2px solid rgba(255,255,255,0.5);}
    .section-label{font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${accent};margin-bottom:8px;}
    @media(max-width:640px){
      h1{font-size:28px!important}
      .hero-btns{flex-direction:column!important;align-items:center!important}
      .grid-2,.grid-3,.grid-4{grid-template-columns:1fr!important}
    }
  </style>
</head>
<body>`;

  const widgetScript = `<script src="https://app.sprimal.com/widget.js" data-club-id="${tid}" data-club-name="${name.replace(/&quot;/g,'"')}" defer></script>`;

  // ── Social media sections ─────────────────────────────────────────────────
  // Facebook Page Plugin — shows live photos feed, no API key needed
  const fbSection = fbUrl ? `
<section style="padding:48px 24px;background:#f9fafb;text-align:center;">
  <div style="max-width:440px;margin:0 auto;">
    <div style="background:#1877f2;padding:3px;border-radius:16px;display:inline-block;">
      <div style="background:white;border-radius:14px;padding:30px 36px;">
        <div style="font-size:38px;margin-bottom:10px;">📘</div>
        <h3 style="font-weight:800;color:#111827;margin-bottom:6px;">Follow us on Facebook</h3>
        <p style="color:#6b7280;font-size:14px;line-height:1.6;margin-bottom:20px;">Match reports, photos, lotto results and club news — all on our Facebook page.</p>
        <a href="${fbUrl}" target="_blank" rel="noopener"
          style="display:inline-block;background:#1877f2;color:white;text-decoration:none;padding:12px 26px;border-radius:9px;font-size:14px;font-weight:700;">
          Visit our Facebook page →
        </a>
      </div>
    </div>
  </div>
</section>` : "";

  // Photo gallery — real club images (from Instagram scrape + website crawl)
  // Requires 3+ images to show a grid — fewer looks broken
  const igSection = igHandle ? (() => {
    if (socialImages.length >= 3) {
      const cols = "repeat(3,1fr)";
      const cells = socialImages.map(imgUrl =>
        `<a href="https://instagram.com/${igHandle}" target="_blank" rel="noopener"
          style="display:block;aspect-ratio:1;overflow:hidden;border-radius:10px;background:#e5e7eb;">
          <img src="${esc(imgUrl)}" alt="${name}" loading="lazy"
            style="width:100%;height:100%;object-fit:cover;transition:transform 0.3s;"
            onmouseover="this.style.transform='scale(1.04)'"
            onmouseout="this.style.transform='scale(1)'">
        </a>`
      ).join("");
      return `
<section style="padding:56px 24px;background:white;">
  <div style="max-width:820px;margin:0 auto;">
    <div style="text-align:center;margin-bottom:28px;">
      <div class="section-label">Club Photos</div>
      <h2 style="font-size:26px;font-weight:800;color:#111827;margin-bottom:6px;">Match action &amp; club life</h2>
      <a href="https://instagram.com/${igHandle}" target="_blank" rel="noopener"
        style="color:#6b7280;font-size:14px;text-decoration:none;">@${igHandle} on Instagram</a>
    </div>
    <div style="display:grid;grid-template-columns:${cols};gap:8px;margin-bottom:20px;">
      ${cells}
    </div>
    <div style="text-align:center;">
      <a href="https://instagram.com/${igHandle}" target="_blank" rel="noopener"
        style="display:inline-block;background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045);color:white;text-decoration:none;padding:12px 28px;border-radius:9px;font-size:14px;font-weight:700;">
        📷 Follow @${igHandle} →
      </a>
    </div>
  </div>
</section>`;
    }
    // Fallback: branded card with no real images
    return `
<section style="padding:48px 24px;background:white;text-align:center;">
  <div style="max-width:440px;margin:0 auto;">
    <div style="background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045);padding:3px;border-radius:16px;display:inline-block;">
      <div style="background:white;border-radius:14px;padding:30px 36px;">
        <div style="font-size:38px;margin-bottom:10px;">📷</div>
        <h3 style="font-weight:800;color:#111827;margin-bottom:6px;">See our photos</h3>
        <p style="color:#6b7280;font-size:14px;line-height:1.6;margin-bottom:20px;">Match action, training sessions and club events — all on Instagram.</p>
        <a href="https://instagram.com/${igHandle}" target="_blank" rel="noopener"
          style="display:inline-block;background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045);color:white;text-decoration:none;padding:12px 26px;border-radius:9px;font-size:14px;font-weight:700;">
          @${igHandle} →
        </a>
      </div>
    </div>
  </div>
</section>`;
  })() : "";

  // ── GAA CLUB ──────────────────────────────────────────────────────────────
  if (btype === "gaa_club") {
    accent = primary; // use brand colour instead of hardcoded palette green
    const hexRgb   = (hex) => `${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)}`;
    const darkenHex = (hex, f) => {
      const r = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(1,3),16) * f)));
      const g = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(3,5),16) * f)));
      const b = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(5,7),16) * f)));
      return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    };
    const primaryDark = darkenHex(primary, 0.55);
    // Irish subtitle helper — slightly smaller, italic, softened opacity
    const ga = (text) => `<span style="display:block;font-size:0.76em;font-style:italic;opacity:0.70;margin-top:3px;font-weight:400;">${text}</span>`;

    return baseHead() + stickyBar + `

<section style="position:relative;color:white;padding:70px 24px 56px;text-align:center;overflow:hidden;min-height:420px;display:flex;align-items:center;justify-content:center;">
  ${heroImg
    ? `<div style="position:absolute;inset:0;background-image:url(${heroImg});background-size:cover;background-position:center;"></div>
       <div style="position:absolute;inset:0;background:linear-gradient(160deg,rgba(${hexRgb(primary)},0.55) 0%,rgba(${hexRgb(primaryDark)},0.72) 100%);"></div>`
    : `<div style="position:absolute;inset:0;background:linear-gradient(160deg,${primary} 0%,#052e16 100%);"></div>`
  }
  <div style="position:relative;z-index:1;width:100%;">
    ${logoImg}
    <div class="badge">GAA · CLG</div><div class="badge">Foireann Affiliated</div>
    <h1 style="font-size:38px;font-weight:900;letter-spacing:-0.5px;margin:14px 0 6px;">${name}</h1>
    <p style="font-size:14px;opacity:0.7;margin-bottom:2px;letter-spacing:0.05em;">HURLING · FOOTBALL · CAMOGIE · LADIES FOOTBALL · UNDERAGE</p>
    <p style="font-size:12px;opacity:0.5;letter-spacing:0.05em;font-style:italic;margin-bottom:4px;">IOMÁNAÍOCHT · PEIL · CAMÓGAÍOCHT · PEIL NA MBAN · ÓG</p>
    ${desc ? `<p style="font-size:17px;opacity:0.85;max-width:560px;margin:14px auto 0;line-height:1.6;">${desc}</p>` : ""}
    <div class="hero-btns" style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:28px;">
      <a href="${chatUrl}" class="cta-primary">Join the club →${ga("Bí linn")}</a>
      <a href="${chatUrl}" class="cta-secondary">View fixtures${ga("Féach ar chluichí")}</a>
    </div>
  </div>
</section>

<section style="background:${accent};color:white;padding:20px 24px;text-align:center;">
  <div style="max-width:800px;margin:0 auto;display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap;">
    <div style="font-size:22px;">🎰</div>
    <div>
      <div style="font-weight:800;font-size:17px;">Club Lotto — Play this week${ga("Crannchuir an Chlub")}</div>
      <div style="font-size:13px;opacity:0.9;">Support your club · Great prizes every week</div>
    </div>
    <a href="${chatUrl}" style="background:white;color:${accent};font-weight:800;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:14px;white-space:nowrap;">Buy tickets →${ga("Ceannaigh ticéid")}</a>
  </div>
</section>

${aboutSection}

<section style="position:relative;padding:50px 24px;overflow:hidden;">
  ${bgImg1
    ? `<div style="position:absolute;inset:0;background-image:url(${bgImg1});background-size:cover;background-position:center;"></div>
       <div style="position:absolute;inset:0;background:rgba(255,255,255,0.93);"></div>`
    : `<div style="position:absolute;inset:0;background:${light};"></div>`
  }
  <div style="position:relative;z-index:1;max-width:800px;margin:0 auto;">
    <div class="section-label" style="text-align:center;">Ár gCóid / Our Codes</div>
    <h2 style="font-size:24px;font-weight:800;color:#111827;text-align:center;margin-bottom:28px;">All codes, all abilities${ga("Gach cód, gach cumas")}</h2>
    <div class="grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
      <div class="code-card"><div style="font-weight:800;color:#111827;margin-bottom:4px;">⚽ Football${ga("Peil Ghaelach")}</div><div style="font-size:13px;color:#6b7280;">Senior · Junior · Underage</div></div>
      <div class="code-card"><div style="font-weight:800;color:#111827;margin-bottom:4px;">🏑 Hurling${ga("Iománaíocht")}</div><div style="font-size:13px;color:#6b7280;">Senior · Junior · Underage</div></div>
      <div class="code-card"><div style="font-weight:800;color:#111827;margin-bottom:4px;">🏐 Ladies Football${ga("Peil na mBan")}</div><div style="font-size:13px;color:#6b7280;">Senior · Junior · Underage</div></div>
      <div class="code-card"><div style="font-weight:800;color:#111827;margin-bottom:4px;">🥍 Camogie${ga("Camógaíocht")}</div><div style="font-size:13px;color:#6b7280;">Senior · Junior · Underage</div></div>
    </div>
  </div>
</section>

<section style="padding:50px 24px;">
  <div style="max-width:800px;margin:0 auto;">
    <div class="section-label" style="text-align:center;">Ballraíocht / Membership</div>
    <h2 style="font-size:24px;font-weight:800;color:#111827;text-align:center;margin-bottom:10px;">Join ${name}${ga("Glac páirt le ${name}")}</h2>
    <p style="text-align:center;color:#6b7280;margin-bottom:28px;">New members are always welcome — all ages, all abilities.<br><span style="font-size:0.88em;font-style:italic;">Fáiltítear roimh bhaill nua i gcónaí.</span></p>
    <div class="grid-4" style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;">
      <div class="tier-card"><div style="font-size:22px;margin-bottom:6px;">🧑</div><div style="font-weight:700;font-size:14px;">Adult${ga("Aosach")}</div></div>
      <div class="tier-card"><div style="font-size:22px;margin-bottom:6px;">🎓</div><div style="font-weight:700;font-size:14px;">Student${ga("Mac Léinn")}</div></div>
      <div class="tier-card"><div style="font-size:22px;margin-bottom:6px;">👨‍👩‍👧‍👦</div><div style="font-weight:700;font-size:14px;">Family${ga("Teaghlach")}</div></div>
      <div class="tier-card"><div style="font-size:22px;margin-bottom:6px;">👶</div><div style="font-weight:700;font-size:14px;">Juvenile${ga("Ógánach")}</div></div>
    </div>
    <div style="text-align:center;"><a href="${chatUrl}" style="display:inline-block;background:${primary};color:white;text-decoration:none;padding:13px 30px;border-radius:9px;font-size:15px;font-weight:700;">Ask about membership →${ga("Fiafraigh faoi bhallraíocht")}</a></div>
  </div>
</section>

<section style="position:relative;color:white;padding:42px 24px;text-align:center;overflow:hidden;">
  ${bgImg2
    ? `<div style="position:absolute;inset:0;background-image:url(${bgImg2});background-size:cover;background-position:center;"></div>
       <div style="position:absolute;inset:0;background:rgba(${hexRgb(primaryDark)},0.84);"></div>`
    : `<div style="position:absolute;inset:0;background:${primary};"></div>`
  }
  <div style="position:relative;z-index:1;">
    <div style="font-size:28px;margin-bottom:10px;">🏕️</div>
    <h2 style="font-size:22px;font-weight:800;margin-bottom:8px;">Cúl Camps</h2>
    <p style="font-size:15px;opacity:0.85;max-width:480px;margin:0 auto 20px;line-height:1.6;">The official GAA Summer Camps for boys and girls aged 6–13. Book through Croke Park — ask our assistant for details.</p>
    <a href="${chatUrl}" style="display:inline-block;background:${accent};color:white;font-weight:800;text-decoration:none;padding:12px 26px;border-radius:9px;font-size:14px;">Find out more →${ga("Tuilleadh eolais")}</a>
  </div>
</section>

${fbSection}
${igSection}
${aiSection("Ask about membership, fixtures, Club Lotto, Cúl Camps, training times and more.")}
${contactSection}
${socialBar}
${footer("Official GAA Member Club · Foireann.ie", "https://www.foireann.ie")}
<p style="text-align:center;font-size:11px;color:#9ca3af;padding:12px;background:#111827;">Child Safeguarding Statement available on request · <a href="${chatUrl}" style="color:#6b7280;">Contact us / Déan teagmháil linn</a></p>
${widgetScript}</body></html>`;
  }

  // ── CAFÉ ──────────────────────────────────────────────────────────────────
  if (btype === "cafe") {
    return baseHead() + `
<div style="background:${primary};color:white;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:13px;">
  <strong>${name}</strong>
  <div style="display:flex;gap:16px;flex-wrap:wrap;">
    ${email ? `<a href="mailto:${email}" style="color:rgba(255,255,255,0.85);text-decoration:none;">✉️ ${email}</a>` : ""}
    <a href="${chatUrl}" style="color:${accent};font-weight:700;text-decoration:none;">⏰ Opening hours →</a>
  </div>
</div>

<section style="background:linear-gradient(160deg,${primary} 0%,${primaryDark} 100%);color:white;padding:72px 24px 60px;text-align:center;">
  ${logoImg}
  <h1 style="font-size:40px;font-weight:900;letter-spacing:-0.5px;margin-bottom:10px;">${name}</h1>
  <p style="font-size:18px;opacity:0.85;margin-bottom:20px;">${desc || "Great food, great coffee."}</p>
  <div class="hero-btns" style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
    <a href="${chatUrl}" class="cta-primary">📋 View menu</a>
    <a href="${chatUrl}" class="cta-secondary">🪑 Book a table</a>
  </div>
</section>

<section style="background:${accent};color:white;padding:16px 24px;text-align:center;font-size:14px;font-weight:700;">
  ⏰ Ask our assistant for today's opening hours · 🐕 Dog-friendly · ☕ Specialty coffee
</section>

${aboutSection}

<section style="background:${light};padding:50px 24px;">
  <div style="max-width:700px;margin:0 auto;">
    <div class="section-label" style="text-align:center;">Quick info</div>
    <h2 style="font-size:24px;font-weight:800;color:#111827;text-align:center;margin-bottom:24px;">Everything you need to know</h2>
    <div class="grid-3" style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
      <div class="tier-card"><div style="font-size:26px;margin-bottom:8px;">📋</div><div style="font-weight:700;font-size:14px;margin-bottom:4px;">Our Menu</div><div style="font-size:12px;color:#6b7280;">Full menu available via chat</div></div>
      <div class="tier-card"><div style="font-size:26px;margin-bottom:8px;">⏰</div><div style="font-weight:700;font-size:14px;margin-bottom:4px;">Opening Hours</div><div style="font-size:12px;color:#6b7280;">Ask for today's hours</div></div>
      <div class="tier-card"><div style="font-size:26px;margin-bottom:8px;">📍</div><div style="font-weight:700;font-size:14px;margin-bottom:4px;">Find Us</div><div style="font-size:12px;color:#6b7280;">${email ? email : "Ask for our address"}</div></div>
    </div>
  </div>
</section>

${aiSection("Ask about today's menu, opening hours, allergens, booking a table and more.")}
${contactSection}
${footer("", "")}
${widgetScript}</body></html>`;
  }

  // ── TENNIS CLUB ──────────────────────────────────────────────────────────
  if (btype === "tennis_club") {
    const navy     = primary; // use tenant's brand_color (falls back to default navy if not set)
    const hexRgb   = (hex) => `${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)}`;
    const darkenHex = (hex, f) => {
      const r = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(1,3),16) * f)));
      const g = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(3,5),16) * f)));
      const b = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(5,7),16) * f)));
      return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    };
    const navyDark = darkenHex(primary, 0.55);
    const ball     = "#c8f500";
    const ocean    = "#1e6fba";

    const tnLogoImg = logo
      ? `<div style="width:130px;height:130px;border-radius:50%;background:white;box-shadow:0 4px 24px rgba(0,0,0,0.35);margin:0 auto 20px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;">
           <img src="${logo}" alt="${name}" style="width:120px;height:120px;object-fit:contain;" onerror="this.parentElement.innerHTML='<span style=\\'font-size:52px;\\'>🎾</span>'">
         </div>`
      : `<div style="width:130px;height:130px;border-radius:50%;background:rgba(255,255,255,0.18);display:flex;align-items:center;justify-content:center;font-size:52px;margin:0 auto 20px;">🎾</div>`;

    const tnStyles = `<style>
  .tn-nav{position:sticky;top:0;z-index:100;background:${navyDark};display:flex;align-items:center;justify-content:space-between;padding:10px 24px;box-shadow:0 2px 12px rgba(6,14,51,0.5);}
  .tn-nav-left{display:flex;align-items:center;gap:10px;}
  .tn-nav-logo{width:38px;height:38px;border-radius:50%;object-fit:contain;background:white;padding:3px;}
  .tn-nav-name{color:white;font-weight:900;font-size:15px;}
  .tn-nav-book{background:${ball};color:${navyDark};font-weight:900;text-decoration:none;padding:9px 18px;border-radius:8px;font-size:13px;white-space:nowrap;}
  .tn-hero{position:relative;min-height:88vh;display:flex;align-items:center;justify-content:center;text-align:center;color:white;padding:80px 24px 90px;background:linear-gradient(165deg,rgba(${hexRgb(navyDark)},0.90) 0%,rgba(${hexRgb(navy)},0.75) 55%,rgba(${hexRgb(ocean)},0.65) 100%)${heroImg ? `,url("${heroImg}") center/cover no-repeat` : ""};}
  .tn-hero-inner{max-width:680px;margin:0 auto;position:relative;z-index:1;}
  .tn-badge{display:inline-block;background:rgba(200,245,0,0.14);border:1px solid rgba(200,245,0,0.45);color:${ball};padding:5px 14px;border-radius:20px;font-size:12px;font-weight:800;letter-spacing:0.1em;margin-bottom:18px;}
  .tn-h1{font-size:42px;font-weight:900;letter-spacing:-0.5px;line-height:1.12;margin-bottom:14px;}
  .tn-h1 span{color:${ball};}
  .tn-desc{font-size:16px;opacity:0.8;max-width:520px;margin:0 auto 30px;line-height:1.7;}
  .tn-btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;}
  .tn-cta-p{background:${ball};color:${navyDark};font-weight:900;text-decoration:none;padding:15px 30px;border-radius:10px;font-size:15px;}
  .tn-cta-s{background:rgba(255,255,255,0.13);color:white;font-weight:700;text-decoration:none;padding:15px 30px;border-radius:10px;font-size:15px;border:1.5px solid rgba(255,255,255,0.38);}
  .tn-wave{position:absolute;bottom:-2px;left:0;right:0;line-height:0;}
  .tn-strip{background:${navy};padding:18px 24px;}
  .tn-strip-inner{max-width:900px;margin:0 auto;display:flex;justify-content:center;flex-wrap:wrap;}
  .tn-stat{color:white;text-align:center;padding:10px 24px;border-right:1px solid rgba(255,255,255,0.1);}
  .tn-stat:last-child{border-right:none;}
  .tn-stat-n{font-size:22px;font-weight:900;color:${ball};line-height:1;}
  .tn-stat-l{font-size:11px;color:rgba(255,255,255,0.55);font-weight:600;letter-spacing:0.06em;margin-top:4px;}
  .tn-book-box{background:linear-gradient(135deg,${ocean} 0%,${navy} 100%);border-radius:18px;padding:44px 32px;color:white;text-align:center;}
  .tn-book-btn{display:inline-block;background:${ball};color:${navyDark};font-weight:900;text-decoration:none;padding:14px 32px;border-radius:10px;font-size:15px;}
  .tn-card{background:white;border-radius:14px;padding:26px;box-shadow:0 2px 14px rgba(13,32,96,0.08);}
  .tn-grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px;}
  .tn-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;}
  .tn-grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;}
  .tn-tier{background:white;border-radius:13px;padding:22px 16px;text-align:center;box-shadow:0 2px 10px rgba(13,32,96,0.07);border:2px solid transparent;}
  .tn-tier.feat{border-color:${navy};}
  .tn-tier-badge{background:${navy};color:white;font-size:10px;font-weight:800;padding:3px 9px;border-radius:6px;display:inline-block;margin-bottom:9px;}
  .tn-coach-card{background:white;border-radius:13px;padding:26px;box-shadow:0 2px 10px rgba(13,32,96,0.07);border-top:4px solid ${navy};}
  .tn-slabel{font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:${ocean};margin-bottom:8px;}
  .tn-h2{font-size:26px;font-weight:900;color:#0d1a3a;margin-bottom:10px;line-height:1.2;}
  .tn-sub{color:#5a6a8a;font-size:15px;line-height:1.7;margin-bottom:28px;max-width:540px;}
  .tn-ai-box{background:linear-gradient(135deg,${navyDark} 0%,${navy} 100%);border-radius:18px;padding:44px 32px;color:white;text-align:center;}
  .tn-chip{background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.25);color:white;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;display:inline-block;margin:4px;}
  .tn-social-btn{display:inline-flex;align-items:center;gap:8px;background:white;border:1.5px solid #dde3f0;padding:11px 20px;border-radius:10px;font-size:14px;font-weight:700;color:#0d1a3a;text-decoration:none;margin:5px;}
  @media(max-width:680px){.tn-h1{font-size:28px!important}.tn-grid2,.tn-grid3,.tn-grid4{grid-template-columns:1fr!important}.tn-strip-inner{gap:0}}
</style>`;

    return baseHead(tnStyles) + `

<nav class="tn-nav">
  <div class="tn-nav-left">
    ${logo ? `<img class="tn-nav-logo" src="${logo}" alt="${name}" onerror="this.style.display='none'">` : ""}
    <span class="tn-nav-name">${name}</span>
  </div>
  <a class="tn-nav-book" href="${chatUrl}">🎾 Book a Court</a>
</nav>

<section class="tn-hero">
  <div class="tn-hero-inner">
    ${tnLogoImg}
    <div class="tn-badge">🏆 Tennis Ireland Affiliated</div>
    <h1 class="tn-h1">${name}<br><span>Tennis Club</span></h1>
    ${desc ? `<p class="tn-desc">${desc}</p>` : ""}
    <div class="tn-btns">
      <a href="${chatUrl}" class="tn-cta-p">🎾 Book a Court</a>
      <a href="${chatUrl}" class="tn-cta-s">Join the Club</a>
    </div>
  </div>
  <div class="tn-wave">
    <svg viewBox="0 0 1440 60" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" style="width:100%;height:60px;display:block;"><path d="M0,30 C240,60 480,0 720,30 C960,60 1200,0 1440,30 L1440,60 L0,60 Z" fill="${navyDark}"/></svg>
  </div>
</section>

<div class="tn-strip">
  <div class="tn-strip-inner">
    <div class="tn-stat"><div class="tn-stat-n">🌧️</div><div class="tn-stat-l">All-Weather Courts</div></div>
    <div class="tn-stat"><div class="tn-stat-n">💡</div><div class="tn-stat-l">Floodlit Play</div></div>
    <div class="tn-stat"><div class="tn-stat-n">🏆</div><div class="tn-stat-l">Coaching for All Levels</div></div>
    <div class="tn-stat"><div class="tn-stat-n">👶</div><div class="tn-stat-l">Junior &amp; Summer Camps</div></div>
    <div class="tn-stat"><div class="tn-stat-n">🏅</div><div class="tn-stat-l">Winter &amp; Regional Leagues</div></div>
  </div>
</div>

<section style="background:${navyDark};padding:56px 24px;">
  <div style="max-width:860px;margin:0 auto;">
    <div class="tn-book-box">
      <div style="font-size:44px;margin-bottom:14px;">🎾</div>
      <h2 style="font-size:28px;font-weight:900;margin-bottom:10px;">Book a Court Online</h2>
      <p style="font-size:15px;opacity:0.85;max-width:460px;margin:0 auto 24px;line-height:1.65;">Reserve your court in seconds — choose your slot, confirm and you're on. Available for members 24/7.</p>
      <a href="${chatUrl}" class="tn-book-btn">Check availability →</a>
    </div>
  </div>
</section>

${desc ? `
<section style="background:white;padding:60px 24px;">
  <div style="max-width:860px;margin:0 auto;">
    <div class="tn-slabel">About the Club</div>
    <h2 class="tn-h2">Welcome to ${name}</h2>
    <p style="color:#5a6a8a;font-size:16px;line-height:1.75;max-width:640px;">${desc}</p>
  </div>
</section>` : ""}

<section style="background:#f0f5ff;padding:60px 24px;" id="membership">
  <div style="max-width:860px;margin:0 auto;">
    <div style="text-align:center;margin-bottom:32px;">
      <div class="tn-slabel">Membership</div>
      <h2 class="tn-h2">Join ${name}</h2>
      <p class="tn-sub" style="margin:0 auto;">All abilities welcome. Ask our assistant for current rates and how to register.</p>
    </div>
    <div class="tn-grid4" style="margin-bottom:28px;">
      <div class="tn-tier feat"><div class="tn-tier-badge">Most Popular</div><div style="font-size:26px;margin-bottom:8px;">🧑</div><div style="font-weight:900;font-size:14px;color:#0d1a3a;margin-bottom:4px;">Adult</div><div style="font-size:13px;color:#5a6a8a;">Full court access, leagues &amp; social events</div></div>
      <div class="tn-tier"><div style="font-size:26px;margin-bottom:8px;">👨‍👩‍👧‍👦</div><div style="font-weight:900;font-size:14px;color:#0d1a3a;margin-bottom:4px;">Family</div><div style="font-size:13px;color:#5a6a8a;">Two adults plus all children under 18</div></div>
      <div class="tn-tier"><div style="font-size:26px;margin-bottom:8px;">🎓</div><div style="font-weight:900;font-size:14px;color:#0d1a3a;margin-bottom:4px;">Student</div><div style="font-size:13px;color:#5a6a8a;">Reduced rate for full-time students</div></div>
      <div class="tn-tier"><div style="font-size:26px;margin-bottom:8px;">👶</div><div style="font-weight:900;font-size:14px;color:#0d1a3a;margin-bottom:4px;">Junior</div><div style="font-size:13px;color:#5a6a8a;">Under 18s — includes junior coaching</div></div>
    </div>
    <div style="text-align:center;"><a href="${chatUrl}" style="display:inline-block;background:${navy};color:white;text-decoration:none;padding:13px 28px;border-radius:10px;font-size:15px;font-weight:800;">Ask about membership rates →</a></div>
  </div>
</section>

<section style="background:white;padding:60px 24px;" id="coaching">
  <div style="max-width:860px;margin:0 auto;">
    <div class="tn-slabel">Coaching</div>
    <h2 class="tn-h2">Improve Your Game</h2>
    <p class="tn-sub">Coaching caters for complete beginners through to competitive players — throughout the year for adults and juniors.</p>
    <div class="tn-grid3" style="margin-bottom:28px;">
      <div class="tn-coach-card"><div style="font-size:28px;margin-bottom:10px;">🏃</div><h3 style="font-size:16px;font-weight:900;color:#0d1a3a;margin-bottom:7px;">Group Lessons</h3><p style="font-size:14px;color:#5a6a8a;line-height:1.65;margin-bottom:12px;">Small group coaching for adults of all levels — beginners, improvers and advanced.</p><a href="${chatUrl}" style="color:${ocean};font-size:13px;font-weight:800;text-decoration:none;">Find a group →</a></div>
      <div class="tn-coach-card"><div style="font-size:28px;margin-bottom:10px;">🎯</div><h3 style="font-size:16px;font-weight:900;color:#0d1a3a;margin-bottom:7px;">Private Coaching</h3><p style="font-size:14px;color:#5a6a8a;line-height:1.65;margin-bottom:12px;">One-to-one sessions tailored to your game — ideal for fast improvement or league prep.</p><a href="${chatUrl}" style="color:${ocean};font-size:13px;font-weight:800;text-decoration:none;">Book a session →</a></div>
      <div class="tn-coach-card"><div style="font-size:28px;margin-bottom:10px;">☀️</div><h3 style="font-size:16px;font-weight:900;color:#0d1a3a;margin-bottom:7px;">Summer Camps</h3><p style="font-size:14px;color:#5a6a8a;line-height:1.65;margin-bottom:12px;">Week-long junior camps during school holidays. All equipment provided — places fill fast.</p><a href="${chatUrl}" style="color:${ocean};font-size:13px;font-weight:800;text-decoration:none;">Register a place →</a></div>
    </div>
  </div>
</section>

<section style="background:#e8f4fd;padding:56px 24px;">
  <div style="max-width:720px;margin:0 auto;text-align:center;">
    <div style="font-size:40px;margin-bottom:14px;">🧒</div>
    <div class="tn-slabel">Junior Programme</div>
    <h2 class="tn-h2">Tennis for Every Age</h2>
    <p style="color:#5a6a8a;font-size:15px;line-height:1.75;margin-bottom:28px;max-width:540px;margin-left:auto;margin-right:auto;">From mini tennis for young children through to competitive underage leagues — qualified, Garda-vetted coaches run programmes year-round.</p>
    <div class="tn-grid3" style="margin-bottom:26px;text-align:left;">
      <div class="tn-card" style="text-align:center;border-top:4px solid #4caf50;"><div style="font-size:22px;margin-bottom:8px;">🟢</div><div style="font-weight:900;font-size:14px;margin-bottom:4px;color:#0d1a3a;">Mini Tennis</div><div style="font-size:13px;color:#5a6a8a;">Ages 4–8. Fun first.</div></div>
      <div class="tn-card" style="text-align:center;border-top:4px solid ${ocean};"><div style="font-size:22px;margin-bottom:8px;">🟡</div><div style="font-weight:900;font-size:14px;margin-bottom:4px;color:#0d1a3a;">Development</div><div style="font-size:13px;color:#5a6a8a;">Ages 8–14. Skills &amp; match play.</div></div>
      <div class="tn-card" style="text-align:center;border-top:4px solid ${navy};"><div style="font-size:22px;margin-bottom:8px;">🔴</div><div style="font-weight:900;font-size:14px;margin-bottom:4px;color:#0d1a3a;">Competitive</div><div style="font-size:13px;color:#5a6a8a;">Ages 14–18. Leagues &amp; tournaments.</div></div>
    </div>
    <a href="${chatUrl}" style="display:inline-block;background:${navy};color:white;font-weight:900;text-decoration:none;padding:13px 28px;border-radius:10px;font-size:14px;">Register your child →</a>
    <p style="margin-top:14px;font-size:12px;color:#5a6a8a;">Child Safeguarding Statement available on request.</p>
  </div>
</section>

<section style="background:white;padding:56px 24px;">
  <div style="max-width:860px;margin:0 auto;">
    <div class="tn-slabel">Competition</div>
    <h2 class="tn-h2">Leagues &amp; Match Play</h2>
    <p class="tn-sub">Teams at multiple levels — there's a place for every standard of player.</p>
    <div class="tn-grid2">
      <div class="tn-card" style="border-left:5px solid ${navy};"><div style="font-size:30px;margin-bottom:10px;">🏆</div><h3 style="font-size:17px;font-weight:900;color:#0d1a3a;margin-bottom:7px;">Winter League</h3><p style="font-size:14px;color:#5a6a8a;line-height:1.65;">Ladies, Mens and Mixed teams across multiple grades. Ask our assistant about the current schedule.</p></div>
      <div class="tn-card" style="border-left:5px solid ${ocean};"><div style="font-size:30px;margin-bottom:10px;">🌍</div><h3 style="font-size:17px;font-weight:900;color:#0d1a3a;margin-bottom:7px;">Regional League</h3><p style="font-size:14px;color:#5a6a8a;line-height:1.65;">Munster and national competitions across multiple grades — ask about trials and selection.</p></div>
    </div>
  </div>
</section>

${igSection}
${fbSection}

<section style="background:${navyDark};padding:56px 24px;">
  <div style="max-width:680px;margin:0 auto;">
    <div class="tn-ai-box">
      <div style="font-size:36px;margin-bottom:12px;">🤖</div>
      <h2 style="font-size:24px;font-weight:900;margin-bottom:10px;">Ask Our Club Assistant</h2>
      <p style="font-size:15px;opacity:0.8;max-width:440px;margin:0 auto 20px;line-height:1.65;">Instant answers about court booking, membership, coaching, junior programmes and fixtures — 24/7.</p>
      <div style="margin-bottom:22px;">
        <span class="tn-chip">Book a court</span>
        <span class="tn-chip">Membership rates</span>
        <span class="tn-chip">Summer camps</span>
        <span class="tn-chip">Junior coaching</span>
        <span class="tn-chip">League fixtures</span>
      </div>
      <a href="${chatUrl}" style="display:inline-block;background:${ball};color:${navyDark};font-weight:900;text-decoration:none;padding:13px 28px;border-radius:10px;font-size:14px;">Chat with our assistant →</a>
    </div>
  </div>
</section>

${(fbUrl || igHandle || twHandle) ? `
<section style="background:white;padding:48px 24px;text-align:center;">
  <div style="max-width:500px;margin:0 auto;">
    <div class="tn-slabel">Follow Us</div>
    <h2 class="tn-h2">Stay in the Loop</h2>
    <p style="color:#5a6a8a;font-size:15px;line-height:1.6;margin-bottom:20px;">Match reports, fixtures, news and events — follow us across our channels.</p>
    <div>
      ${fbUrl    ? `<a class="tn-social-btn" href="${fbUrl}" target="_blank" rel="noopener">📘 Facebook</a>` : ""}
      ${igHandle ? `<a class="tn-social-btn" href="https://instagram.com/${igHandle}" target="_blank" rel="noopener">📷 @${igHandle}</a>` : ""}
      ${twHandle ? `<a class="tn-social-btn" href="https://twitter.com/${twHandle}" target="_blank" rel="noopener">🐦 @${twHandle}</a>` : ""}
    </div>
  </div>
</section>` : ""}

${contactSection}
${footer("Tennis Ireland Affiliated Club", "https://www.tennisireland.ie")}
<p style="text-align:center;font-size:11px;color:#9ca3af;padding:12px;background:#111827;">Child Safeguarding Statement available on request</p>
${widgetScript}</body></html>`;
  }

  // ── GOLF CLUB ─────────────────────────────────────────────────────────────
  if (btype === "golf_club") {
    return baseHead() + stickyBar + `

<section style="background:linear-gradient(160deg,${primary} 0%,${primaryDark} 100%);color:white;padding:70px 24px 56px;text-align:center;">
  ${logoImg}
  <div class="badge">Golf Ireland Affiliated</div>
  <h1 style="font-size:38px;font-weight:900;letter-spacing:-0.5px;margin:14px 0 10px;">${name}</h1>
  ${desc ? `<p style="font-size:17px;opacity:0.85;max-width:560px;margin:0 auto 20px;line-height:1.6;">${desc}</p>` : ""}
  <div class="hero-btns" style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
    <a href="${chatUrl}" class="cta-primary">⛳ Book a tee time</a>
    <a href="${chatUrl}" class="cta-secondary">Visitor green fees</a>
  </div>
</section>

<section style="background:${light};padding:50px 24px;">
  <div style="max-width:800px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:24px;" class="grid-2">
    <div style="background:white;border-radius:14px;padding:28px;box-shadow:0 1px 8px rgba(0,0,0,0.07);">
      <div style="font-size:28px;margin-bottom:10px;">🏌️</div>
      <h3 style="font-weight:800;color:#111827;margin-bottom:8px;">Members</h3>
      <p style="color:#6b7280;font-size:14px;line-height:1.6;margin-bottom:16px;">Book tee times, view competition results, check your handicap and manage your membership.</p>
      <a href="${chatUrl}" style="display:inline-block;background:${primary};color:white;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:700;">Members area →</a>
    </div>
    <div style="background:white;border-radius:14px;padding:28px;box-shadow:0 1px 8px rgba(0,0,0,0.07);">
      <div style="font-size:28px;margin-bottom:10px;">🚗</div>
      <h3 style="font-weight:800;color:#111827;margin-bottom:8px;">Visitors</h3>
      <p style="color:#6b7280;font-size:14px;line-height:1.6;margin-bottom:16px;">Visiting golfers are welcome. Ask about green fees, availability and what to expect on the day.</p>
      <a href="${chatUrl}" style="display:inline-block;background:${accent};color:white;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:700;">Visitor green fees →</a>
    </div>
  </div>
</section>

${aboutSection}
${aiSection("Ask about tee time booking, green fees, membership, competitions and the course.")}
${contactSection}
${footer("Golf Ireland Affiliated Club", "https://www.golfireland.ie")}
${widgetScript}</body></html>`;
  }

  // ── FITNESS STUDIO ────────────────────────────────────────────────────────
  if (btype === "fitness_studio") {
    return baseHead() + stickyBar + `

<section style="background:linear-gradient(160deg,${primary} 0%,#000 100%);color:white;padding:70px 24px 60px;text-align:center;">
  ${logoImg}
  <h1 style="font-size:38px;font-weight:900;letter-spacing:-0.5px;margin-bottom:10px;">${name}</h1>
  ${desc ? `<p style="font-size:17px;opacity:0.85;max-width:560px;margin:0 auto 20px;line-height:1.6;">${desc}</p>` : ""}
  <div style="background:${accent};color:white;display:inline-block;padding:10px 24px;border-radius:8px;font-weight:800;font-size:15px;margin-bottom:20px;">🎯 FREE TRIAL WEEK — No commitment</div>
  <div class="hero-btns" style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
    <a href="${chatUrl}" class="cta-primary">Claim free trial →</a>
    <a href="${chatUrl}" class="cta-secondary">View class schedule</a>
  </div>
</section>

${aboutSection}

<section style="background:${light};padding:50px 24px;">
  <div style="max-width:800px;margin:0 auto;text-align:center;">
    <div class="section-label">Classes &amp; Schedule</div>
    <h2 style="font-size:24px;font-weight:800;color:#111827;margin-bottom:10px;">Find a class that works for you</h2>
    <p style="color:#6b7280;font-size:15px;margin-bottom:24px;">Ask our assistant for the full timetable, class descriptions and how to book.</p>
    <a href="${chatUrl}" style="display:inline-block;background:${primary};color:white;text-decoration:none;padding:13px 28px;border-radius:9px;font-size:15px;font-weight:700;">View schedule →</a>
  </div>
</section>

${aiSection("Ask about classes, the free trial, membership pricing, coaches and the schedule.")}
${contactSection}
${footer("", "")}
${widgetScript}</body></html>`;
  }

  // ── YOGA STUDIO ───────────────────────────────────────────────────────────
  if (btype === "yoga_studio") {
    return baseHead() + stickyBar + `

<section style="background:linear-gradient(160deg,${primary} 0%,${primaryDark} 100%);color:white;padding:72px 24px 60px;text-align:center;">
  ${logoImg}
  <h1 style="font-size:38px;font-weight:900;letter-spacing:-0.5px;margin-bottom:10px;">${name}</h1>
  ${desc ? `<p style="font-size:18px;opacity:0.85;max-width:560px;margin:0 auto 20px;line-height:1.7;">${desc}</p>` : ""}
  <div style="background:rgba(255,255,255,0.12);display:inline-block;padding:12px 28px;border-radius:10px;font-size:15px;font-weight:700;margin-bottom:20px;border:1px solid rgba(255,255,255,0.25);">✨ Intro Offer — First 2 weeks from €20</div>
  <div class="hero-btns" style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
    <a href="${chatUrl}" class="cta-primary">Claim intro offer →</a>
    <a href="${chatUrl}" class="cta-secondary">View timetable</a>
  </div>
</section>

<section style="background:white;padding:50px 24px;text-align:center;">
  <div style="max-width:700px;margin:0 auto;">
    <div class="section-label">Our Teachers</div>
    <h2 style="font-size:24px;font-weight:800;color:#111827;margin-bottom:12px;">Meet your teachers</h2>
    <p style="color:#6b7280;font-size:15px;line-height:1.6;margin-bottom:22px;">Our qualified teachers bring years of experience to every class. Ask our assistant about who teaches what, and when.</p>
    <a href="${chatUrl}" style="display:inline-block;background:${primary};color:white;text-decoration:none;padding:12px 26px;border-radius:9px;font-size:14px;font-weight:700;">Meet our teachers →</a>
  </div>
</section>

${aboutSection}
${aiSection("Ask about the intro offer, class timetable, teachers, pricing and what to bring.")}
${contactSection}
${footer("", "")}
${widgetScript}</body></html>`;
  }

  // ── SWIM CLUB ─────────────────────────────────────────────────────────────
  if (btype === "swim_club") {
    return baseHead() + stickyBar + `

<section style="background:linear-gradient(160deg,${primary} 0%,${primaryDark} 100%);color:white;padding:70px 24px 56px;text-align:center;">
  ${logoImg}
  <div class="badge">Swim Ireland Affiliated</div>
  <h1 style="font-size:38px;font-weight:900;letter-spacing:-0.5px;margin:14px 0 10px;">${name}</h1>
  ${desc ? `<p style="font-size:17px;opacity:0.85;max-width:560px;margin:0 auto 20px;line-height:1.6;">${desc}</p>` : ""}
  <div class="hero-btns" style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
    <a href="${chatUrl}" class="cta-primary">Join the club →</a>
    <a href="${chatUrl}" class="cta-secondary">Training times</a>
  </div>
</section>

<section style="background:${accent};color:white;padding:28px 24px;text-align:center;">
  <div style="max-width:680px;margin:0 auto;">
    <h2 style="font-size:20px;font-weight:800;margin-bottom:8px;">🏊 Finished swimming lessons?</h2>
    <p style="font-size:15px;opacity:0.92;margin-bottom:16px;line-height:1.6;">Joining a club is the natural next step. We cater for all ages from beginners right through to competitive squads.</p>
    <a href="${chatUrl}" style="display:inline-block;background:white;color:${accent};font-weight:800;text-decoration:none;padding:11px 24px;border-radius:8px;font-size:14px;">Here's how to join →</a>
  </div>
</section>

${aboutSection}

<section style="background:${light};padding:50px 24px;">
  <div style="max-width:800px;margin:0 auto;text-align:center;">
    <div class="section-label">Squads &amp; Age Groups</div>
    <h2 style="font-size:24px;font-weight:800;color:#111827;margin-bottom:10px;">A squad for every level</h2>
    <p style="color:#6b7280;font-size:15px;margin-bottom:24px;line-height:1.6;">From Learn to Swim through to competitive squads — ask our assistant which squad is right for you or your child.</p>
    <a href="${chatUrl}" style="display:inline-block;background:${primary};color:white;text-decoration:none;padding:13px 28px;border-radius:9px;font-size:15px;font-weight:700;">Find the right squad →</a>
  </div>
</section>

${aiSection("Ask about squads, membership, training times, galas and how to join.")}
${contactSection}
${footer("Swim Ireland Affiliated Club", "https://www.swimireland.ie")}
<p style="text-align:center;font-size:11px;color:#9ca3af;padding:12px;background:#111827;">Child Safeguarding Statement available on request</p>
${widgetScript}</body></html>`;
  }

  // ── TEAM SPORTS CLUB (rugby, soccer, hockey etc.) ─────────────────────────
  if (btype === "team_sports_club") {
    return baseHead() + stickyBar + `

<section style="background:linear-gradient(160deg,${primary} 0%,#0f172a 100%);color:white;padding:70px 24px 56px;text-align:center;">
  ${logoImg}
  <h1 style="font-size:38px;font-weight:900;letter-spacing:-0.5px;margin-bottom:10px;">${name}</h1>
  ${desc ? `<p style="font-size:17px;opacity:0.85;max-width:560px;margin:0 auto 20px;line-height:1.6;">${desc}</p>` : ""}
  <div class="hero-btns" style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
    <a href="${chatUrl}" class="cta-primary">Register now →</a>
    <a href="${chatUrl}" class="cta-secondary">Fixtures &amp; results</a>
  </div>
</section>

${aboutSection}

<section style="background:${light};padding:50px 24px;">
  <div style="max-width:700px;margin:0 auto;text-align:center;">
    <div class="section-label">Junior Programme</div>
    <h2 style="font-size:22px;font-weight:800;color:#111827;margin-bottom:10px;">Youth teams</h2>
    <p style="color:#6b7280;font-size:15px;line-height:1.6;margin-bottom:20px;">We run teams from U8 all the way through to senior level. All abilities welcome.</p>
    <a href="${chatUrl}" style="display:inline-block;background:${primary};color:white;text-decoration:none;padding:12px 26px;border-radius:9px;font-size:14px;font-weight:700;">Register a player →</a>
  </div>
</section>

${aiSection("Ask about registering, training times, fixtures, underage teams and more.")}
${contactSection}
${footer("", "")}
<p style="text-align:center;font-size:11px;color:#9ca3af;padding:12px;background:#111827;">Child Safeguarding Statement available on request</p>
${widgetScript}</body></html>`;
  }

  // ── GENERIC FALLBACK ──────────────────────────────────────────────────────
  return baseHead() + stickyBar + `
<section style="background:linear-gradient(160deg,${primary} 0%,#0f172a 100%);color:white;padding:70px 24px 56px;text-align:center;">
  ${logoImg}
  <h1 style="font-size:38px;font-weight:900;letter-spacing:-0.5px;margin-bottom:12px;">${name}</h1>
  ${desc ? `<p style="font-size:17px;opacity:0.85;max-width:560px;margin:0 auto 22px;line-height:1.6;">${desc}</p>` : ""}
  <a href="${chatUrl}" class="cta-primary">Chat with us →</a>
</section>
${aboutSection}
${aiSection("Ask us anything — we're available 24/7.")}
${contactSection}
${footer("", "")}
${widgetScript}</body></html>`;
}

app.get("/sites/:tenantId", async (req, res) => {
  try {
    const { tenantId } = req.params;

    if (tenantId === "cosy-cafe") {
      return res.sendFile(path.join(__dirname, "public", "cosy-cafe.html"));
    }
    const { data: tenant, error: tenantErr } = await supabase
      .from("tenants")
      .select("id, name, email, website, logo_url, business_description, business_type, brand_color, facebook_url, instagram_handle, twitter_handle, social_images")
      .eq("id", tenantId)
      .maybeSingle();
    if (tenantErr) console.error("[sites] Supabase error:", tenantErr.message, "for", tenantId);
    if (!tenant) return res.status(404).send(`Not found: ${tenantId}${tenantErr ? " — DB error: " + tenantErr.message : ""}`);
    const html = buildTenantSiteHtml(tenant);
    res.setHeader("Content-Type", "text/html");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (err) {
    console.error("[sites] Error:", err.message);
    res.status(500).send("Something went wrong");
  }
});

// ── Court Check-In Feature (Tennis clubs only) ───────────────────────────────

// Helper: haversine distance in metres between two GPS coords
function gpsDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// GET /checkin/:tenantId — mobile club check-in page
app.get("/checkin/:tenantId", (req, res) => {
  const { tenantId } = req.params;
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-store");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="only light">
<title>Club Check-In</title>
<style>
  :root { color-scheme: only light; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f4f8; min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; color: #1a1a2e; }
  .card { background: white; border-radius: 20px; padding: 32px 24px; max-width: 400px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.1); text-align: center; }
  .logo { width: 72px; height: 72px; object-fit: contain; border-radius: 12px; margin-bottom: 10px; }
  .logo-emoji { font-size: 48px; margin-bottom: 8px; }
  .club-name { font-size: 18px; font-weight: 700; color: #1a1a2e; margin-bottom: 28px; }
  .welcome { background: #e8f5e9; border-radius: 12px; padding: 16px; margin-bottom: 20px; }
  .welcome-name { font-size: 18px; font-weight: 600; color: #2e7d32; }
  .welcome-sub { font-size: 13px; color: #555; margin-top: 4px; }
  label { display: block; text-align: left; font-size: 14px; font-weight: 600; color: #444; margin-bottom: 6px; }
  input { width: 100%; padding: 14px 16px; font-size: 18px; border: 2px solid #e0e0e0; border-radius: 12px; outline: none; text-align: center; letter-spacing: 2px; transition: border-color 0.2s; }
  input:focus { border-color: #1565c0; }
  .btn { width: 100%; padding: 16px; font-size: 17px; font-weight: 700; border: none; border-radius: 12px; cursor: pointer; margin-top: 16px; transition: background 0.2s, transform 0.1s; }
  .btn:active { transform: scale(0.98); }
  .btn-primary { background: #1565c0; color: white; }
  .btn-primary:disabled { background: #90a4ae; cursor: not-allowed; }
  .btn-success { background: #2e7d32; color: white; }
  .btn-secondary { background: #f5f5f5; color: #444; margin-top: 10px; font-size: 14px; padding: 12px; }
  .status { padding: 12px 16px; border-radius: 10px; font-size: 14px; margin-top: 16px; }
  .status-error { background: #ffebee; color: #c62828; }
  .status-info { background: #e3f2fd; color: #1565c0; }
  .success-icon { font-size: 64px; margin-bottom: 16px; }
  .success-title { font-size: 22px; font-weight: 700; color: #2e7d32; margin-bottom: 8px; }
  .success-sub { font-size: 14px; color: #666; }
  .time { font-size: 13px; color: #999; margin-top: 20px; }
  .loading { color: #999; font-size: 15px; }
  .otp-wrap { display: flex; gap: 8px; justify-content: center; margin: 20px 0 4px; }
  .otp-box { width: 44px; height: 56px; font-size: 26px; font-weight: 700; text-align: center; border: 2px solid #e0e0e0; border-radius: 12px; outline: none; transition: border-color 0.2s; padding: 0; }
  .otp-box:focus { border-color: #1565c0; }
  .email-hint { font-size: 13px; color: #6b7280; margin-bottom: 4px; }
  .resend-link { font-size: 13px; color: #1565c0; background: none; border: none; cursor: pointer; padding: 4px; text-decoration: underline; }
</style>
</head>
<body>
<div class="card" id="card">
  <div class="loading">Loading...</div>
</div>
<div style="margin-top:20px;display:flex;align-items:center;justify-content:center;gap:6px;opacity:0.55;">
  <img src="https://app.sprimal.com/sprimal_icon_192.png" alt="Sprimal" style="width:16px;height:16px;border-radius:3px;">
  <span style="font-size:12px;color:#555;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">Powered by Sprimal</span>
</div>
<script>
const TENANT_ID = ${JSON.stringify(tenantId)};
const LS_KEY = 'sprimal_member_' + TENANT_ID;

let clubInfo = null;
let savedMember = null;
let currentBooking = null;

async function init() {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(function() { ctrl.abort(); }, 10000);
    const r = await fetch('/api/checkin/club-info/' + TENANT_ID, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!r.ok) throw new Error('Club not found (' + r.status + ')');
    clubInfo = await r.json();
    if (!clubInfo.ebo_enabled) { showNoEbo(); return; }
    // Magic link auto-verify
    var params = new URLSearchParams(window.location.search);
    var autoCode = params.get('c');
    var autoMember = parseInt(params.get('m'));
    if (autoCode && autoMember) { autoVerifyFromLink(autoMember, autoCode); return; }
    // ?forget=1 clears saved member — useful when browser cache prevents the forget button from showing
    if (params.get('forget') === '1') { localStorage.removeItem(LS_KEY); }
    savedMember = getSavedMember();
    if (savedMember) showWelcomeBack();
    else showForm();
  } catch(e) {
    document.getElementById('card').innerHTML =
      '<div class="logo-emoji">🎾</div>' +
      '<div class="club-name">Check-In Unavailable</div>' +
      '<div class="status status-error" style="margin-top:16px;font-size:13px;">Could not connect. Please check your connection and try again.</div>' +
      '<button class="btn btn-primary" id="retry-btn" style="margin-top:16px;">Retry</button>';
    var rb = document.getElementById('retry-btn');
    if (rb) rb.addEventListener('click', function() {
      document.getElementById('card').innerHTML = '<div class="loading">Loading...</div>';
      init();
    });
  }
}

function getSavedMember() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; }
}

function saveMember(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {}
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function isValidName(n) {
  if (!n || n.length < 2 || n.length > 60) return false;
  return /^[a-zA-Z '.-]+$/.test(n);
}
function isValidContact(c) {
  if (!c || c.length < 6 || c.length > 100) return false;
  if (c.indexOf('@') !== -1) return /^[^ @]+@[^ @]+[.][^ @]{2,}$/.test(c);
  return /^[0-9 +().-]{7,}$/.test(c);
}

function header() {
  var logoHtml = clubInfo.logo_url
    ? '<img class="logo" src="' + clubInfo.logo_url + '" alt="' + clubInfo.club_name + '">'
    : '<div class="logo-emoji">🎾</div>';
  return logoHtml + '<div class="club-name">' + clubInfo.club_name + '</div>';
}

function showNoEbo() {
  document.getElementById('card').innerHTML = header() + '<div class="status status-error">Check-in is not configured for this club.</div>';
}

function showWelcomeBack() {
  var chatUrl = 'https://app.sprimal.com/chat/' + TENANT_ID;
  var assistantName = clubInfo.assistant_name || 'Maeve';
  document.getElementById('card').innerHTML = header() +
    '<div class="welcome"><div class="welcome-name">Welcome back, ' + savedMember.name + '!</div><div class="welcome-sub">Membership #' + savedMember.membership_number + '</div></div>' +
    '<button class="btn btn-success" id="wb-checkin-btn">✅ Check In</button>' +
    '<button class="btn btn-secondary" id="wb-supervisor-btn" style="margin-top:12px;background:#f0fdf4;color:#166534;border:2px solid #bbf7d0;">👶 Supervising a Junior (not playing)</button>' +
    '<a href="' + chatUrl + '" target="_blank" rel="noopener" style="display:block;margin-top:10px;padding:14px;background:#f5f3ff;border:2px solid #ddd6fe;border-radius:12px;text-decoration:none;color:#5b21b6;font-size:15px;font-weight:600;text-align:center;">💬 Chat with ' + assistantName + '</a>' +
    '<div style="text-align:center;margin-top:12px;"><button id="wb-switch-btn" style="background:none;border:none;color:#9ca3af;font-size:12px;cursor:pointer;text-decoration:underline;font-family:inherit;margin-right:12px;">Not you?</button><button id="wb-forget-btn" style="background:none;border:none;color:#9ca3af;font-size:12px;cursor:pointer;text-decoration:underline;font-family:inherit;">Forget this device</button></div>' +
    '<div id="msg"></div>';
  document.getElementById('wb-checkin-btn').addEventListener('click', function() {
    validateBookingThenCheckin(savedMember.membership_number, savedMember.name);
  });
  document.getElementById('wb-supervisor-btn').addEventListener('click', showSupervisorForm);
  document.getElementById('wb-switch-btn').addEventListener('click', showForm);
  document.getElementById('wb-forget-btn').addEventListener('click', function() {
    localStorage.removeItem(LS_KEY);
    savedMember = null;
    showForm();
  });
}

async function validateBookingThenCheckin(membershipNumber, memberName) {
  document.getElementById('card').innerHTML = header() + '<div class="status status-info" style="margin-top:16px;">Checking your booking...</div>';
  try {
    var r = await fetch('/api/checkin/validate-booking/' + TENANT_ID + '/' + membershipNumber);
    var d = await r.json();
    if (d.ebo_error) { currentBooking = null; submitCheckin(membershipNumber, memberName); return; }
    if (d.already_checked_in) { showAlreadyCheckedIn(memberName, d.valid_booking); return; }
    if (!d.valid_booking) { showNoBooking(membershipNumber, memberName, d.message); return; }
    currentBooking = d.valid_booking;
    showBookingConfirm(membershipNumber, memberName, d.valid_booking);
  } catch(e) {
    currentBooking = null;
    submitCheckin(membershipNumber, memberName);
  }
}

function showBookingConfirm(membershipNumber, memberName, booking) {
  document.getElementById('card').innerHTML = header() +
    '<div class="welcome"><div class="welcome-name">Ready to check in!</div>' +
    '<div class="welcome-sub">Court ' + booking.court_id + ' · ' + booking.display_time + '</div></div>' +
    '<button class="btn btn-success" id="booking-checkin-btn">✅ Check In</button>' +
    '<button class="btn btn-secondary" id="booking-back-btn" style="margin-top:8px;font-size:13px;color:#6b7280;">← Back</button>' +
    '<div id="msg"></div>';
  document.getElementById('booking-checkin-btn').addEventListener('click', function() {
    document.getElementById('booking-checkin-btn').disabled = true;
    document.getElementById('booking-checkin-btn').textContent = 'Checking in...';
    submitCheckin(membershipNumber, memberName);
  });
  document.getElementById('booking-back-btn').addEventListener('click', function() {
    savedMember ? showWelcomeBack() : showForm();
  });
}

function showAlreadyCheckedIn(memberName, booking) {
  document.getElementById('card').innerHTML = header() +
    '<div class="status status-error" style="margin-top:16px;">You&#39;ve already checked in for Court ' + booking.court_id + ' at ' + booking.display_time + '.</div>' +
    '<div class="welcome-sub" style="margin-top:12px;text-align:center;">See you on the court, ' + memberName.split(' ')[0] + '!</div>';
}

function showNoBooking(membershipNumber, memberName, message) {
  var msg = message || 'No booking found for the current check-in window.';
  document.getElementById('card').innerHTML = header() +
    '<div class="status status-error" style="margin-top:16px;">' + msg + '</div>' +
    '<button class="btn btn-secondary" id="no-booking-back-btn" style="margin-top:16px;">← Back</button>' +
    '<div id="msg"></div>';
  document.getElementById('no-booking-back-btn').addEventListener('click', function() {
    savedMember ? showWelcomeBack() : showForm();
  });
}



function showForm() {
  var chatUrl = 'https://app.sprimal.com/chat/' + TENANT_ID;
  var assistantName = clubInfo.assistant_name || 'Maeve';
  document.getElementById('card').innerHTML = header() +
    '<button class="btn btn-primary" id="member-btn" style="margin-top:8px;">🎾 Check In to Play</button>' +
    '<button class="btn btn-secondary" id="supervisor-btn" style="margin-top:12px;background:#f0fdf4;color:#166534;border:2px solid #bbf7d0;">👶 Supervising a Junior (not playing)</button>' +
    '<a href="' + chatUrl + '" target="_blank" rel="noopener" style="display:block;margin-top:10px;padding:14px;background:#f5f3ff;border:2px solid #ddd6fe;border-radius:12px;text-decoration:none;color:#5b21b6;font-size:15px;font-weight:600;text-align:center;">💬 Chat with ' + assistantName + '</a>' +
    '<div id="msg"></div>' +
    '<div class="time" id="clock"></div>';
  document.getElementById('member-btn').addEventListener('click', showMemberSearch);
  document.getElementById('supervisor-btn').addEventListener('click', showSupervisorForm);
  updateClock();
  setInterval(updateClock, 1000);
}

function showMemberSearch() {
  document.getElementById('card').innerHTML = header() +
    '<label for="name-search">Your Name</label>' +
    '<input type="text" id="name-search" placeholder="e.g. John Smith" autocomplete="off" maxlength="60">' +
    '<p style="font-size:12px;color:#6b7280;margin-top:6px;text-align:left;line-height:1.4;">You can only check in from 15 minutes before your court booking up to 30 minutes into it.</p>' +
    '<div id="search-results" style="margin-top:8px;"></div>' +
    '<button class="btn btn-secondary" id="back-home-btn" style="margin-top:8px;font-size:13px;color:#6b7280;">← Back</button>' +
    '<div id="msg"></div>';
  var searchEl = document.getElementById('name-search');
  searchEl.focus();
  var timer;
  searchEl.addEventListener('input', function() {
    clearTimeout(timer);
    timer = setTimeout(function() { searchMembersByName(searchEl.value); }, 350);
  });
  document.getElementById('back-home-btn').addEventListener('click', showForm);
}

async function searchMembersByName(q) {
  q = (q || '').trim();
  var el = document.getElementById('search-results');
  if (!el) return;
  if (q.length < 2) { el.innerHTML = ''; return; }
  try {
    var r = await fetch('/api/checkin/search-members/' + encodeURIComponent(TENANT_ID) + '?q=' + encodeURIComponent(q));
    var data = await r.json();
    if (!el.isConnected) return;
    if (!data.length) {
      el.innerHTML = '<div class="status status-error" style="font-size:13px;">No booking found for that name right now.</div>';
      return;
    }
    el.innerHTML = data.map(function(m) {
      return '<button class="btn btn-secondary member-pick" data-num="' + m.membership_number + '" data-name="' + encodeURIComponent(m.name) + '" style="margin-bottom:6px;text-align:left;">' + m.name + '</button>';
    }).join('');
    el.querySelectorAll('.member-pick').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var num = parseInt(this.dataset.num);
        var name = decodeURIComponent(this.dataset.name);
        sendOtpAndShow(num);
      });
    });
  } catch(e) {
    if (el.isConnected) el.innerHTML = '<div class="status status-error" style="font-size:13px;">Search error — try again.</div>';
  }
}

function showSupervisorForm() {
  document.getElementById('card').innerHTML = header() +
    '<div class="welcome"><div class="welcome-name">Supervising a Junior</div>' +
    '<div class="welcome-sub">Please provide your details</div></div>' +
    '<label for="sup-name">Your Name</label>' +
    '<input type="text" id="sup-name" placeholder="Your full name" autocomplete="name" maxlength="60">' +
    '<label for="sup-contact" style="margin-top:8px;">Your Phone or Email</label>' +
    '<input type="text" id="sup-contact" placeholder="e.g. 085 1234567" autocomplete="tel" maxlength="100">' +
    '<div style="display:grid;grid-template-columns:20px 1fr;gap:8px;align-items:start;margin-top:14px;text-align:left;">' +
    '<input type="checkbox" id="sup-agree" style="margin-top:3px;cursor:pointer;">' +
    '<span style="font-size:13px;line-height:1.5;color:#333;cursor:pointer;" onclick="document.getElementById(&#39;sup-agree&#39;).click()">I agree to supervise the junior(s) during their time at ' + (clubInfo.club_name || 'the club') + ' and take responsibility for their welfare on the premises</span>' +
    '</div>' +
    '<button class="btn btn-primary" id="sup-next-btn" style="margin-top:16px;">Next — Find Junior</button>' +
    '<button class="btn btn-secondary" id="sup-back-btn" style="margin-top:8px;font-size:13px;color:#6b7280;">← Back</button>' +
    '<div id="msg"></div>';
  document.getElementById('sup-name').focus();
  document.getElementById('sup-next-btn').addEventListener('click', function() {
    var name = (document.getElementById('sup-name').value || '').trim();
    var contact = (document.getElementById('sup-contact').value || '').trim();
    var agreed = document.getElementById('sup-agree').checked;
    if (!name || !isValidName(name)) {
      var el = document.getElementById('sup-name');
      el.style.borderColor = '#dc2626';
      el.addEventListener('input', function() { el.style.borderColor = ''; }, { once: true });
      showMsg(!name ? 'Please enter your name.' : 'Name should contain letters, spaces, hyphens or apostrophes only.', 'error');
      el.focus(); return;
    }
    if (!contact || !isValidContact(contact)) {
      var el = document.getElementById('sup-contact');
      el.style.borderColor = '#dc2626';
      el.addEventListener('input', function() { el.style.borderColor = ''; }, { once: true });
      showMsg(!contact ? 'Please enter your phone number or email.' : 'Please enter a valid phone number or email address.', 'error');
      el.focus(); return;
    }
    if (!agreed) {
      var cb = document.getElementById('sup-agree');
      cb.style.outline = '2px solid #dc2626';
      cb.style.accentColor = '#dc2626';
      cb.addEventListener('change', function() { cb.style.outline = ''; cb.style.accentColor = ''; }, { once: true });
      return;
    }
    showJuniorSearch(name, contact);
  });
  document.getElementById('sup-back-btn').addEventListener('click', function() {
    savedMember ? showWelcomeBack() : showForm();
  });
}

function showJuniorSearch(supervisorName, supervisorContact) {
  document.getElementById('card').innerHTML = header() +
    '<div class="welcome"><div class="welcome-name">Find the Junior</div>' +
    '<div class="welcome-sub">Search by the junior&#39;s name</div></div>' +
    '<label for="junior-name-search">Junior&#39;s Name</label>' +
    '<input type="text" id="junior-name-search" placeholder="e.g. Sarah Smith" autocomplete="off" maxlength="60">' +
    '<p style="font-size:12px;color:#6b7280;margin-top:6px;text-align:left;line-height:1.4;">You can only check in from 15 minutes before the court booking up to 30 minutes into it.</p>' +
    '<div id="junior-search-results" style="margin-top:8px;"></div>' +
    '<button class="btn btn-secondary" id="junior-back-btn" style="margin-top:8px;font-size:13px;color:#6b7280;">← Back</button>' +
    '<div id="msg"></div>';
  var searchEl = document.getElementById('junior-name-search');
  searchEl.focus();
  var timer;
  searchEl.addEventListener('input', function() {
    clearTimeout(timer);
    timer = setTimeout(function() { searchJuniorByName(supervisorName, supervisorContact, searchEl.value); }, 350);
  });
  document.getElementById('junior-back-btn').addEventListener('click', function() { showSupervisorForm(); });
}

async function searchJuniorByName(supervisorName, supervisorContact, q) {
  q = (q || '').trim();
  var el = document.getElementById('junior-search-results');
  if (!el) return;
  if (q.length < 2) { el.innerHTML = ''; return; }
  try {
    var r = await fetch('/api/checkin/search-members/' + encodeURIComponent(TENANT_ID) + '?q=' + encodeURIComponent(q));
    var data = await r.json();
    if (!el.isConnected) return;
    if (!data.length) {
      el.innerHTML = '<div class="status status-error" style="font-size:13px;">No booking found for that name right now.</div>';
      return;
    }
    el.innerHTML = data.map(function(m) {
      return '<button class="btn btn-secondary junior-pick" data-num="' + m.membership_number + '" data-name="' + encodeURIComponent(m.name) + '" data-time="' + encodeURIComponent(m.booking_time||'') + '" data-court="' + encodeURIComponent(m.court_id||'') + '" style="margin-bottom:6px;text-align:left;">' + m.name + '</button>';
    }).join('');
    el.querySelectorAll('.junior-pick').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var num = parseInt(this.dataset.num);
        var name = decodeURIComponent(this.dataset.name);
        var btime = decodeURIComponent(this.dataset.time) || null;
        var bcourt = decodeURIComponent(this.dataset.court) || null;
        showJuniorConfirm(supervisorName, supervisorContact, num, name, btime, bcourt);
      });
    });
  } catch(e) {
    if (el.isConnected) el.innerHTML = '<div class="status status-error" style="font-size:13px;">Search error — try again.</div>';
  }
}

function showJuniorConfirm(supervisorName, supervisorContact, juniorNum, juniorName, bookingTime, bookingCourtId) {
  var slotText = bookingTime ? new Date(String(bookingTime).replace(' ', 'T')).toLocaleTimeString('en-IE', {hour:'2-digit',minute:'2-digit'}) : '';
  document.getElementById('card').innerHTML = header() +
    '<div class="welcome"><div class="welcome-name">Confirm Check-In</div>' +
    (slotText ? '<div class="welcome-sub">Checking in ' + escHtml(juniorName) + ' at ' + slotText + '</div>' : '<div class="welcome-sub">Checking in ' + escHtml(juniorName) + '</div>') +
    '</div>' +
    '<div style="background:#f0f4f8;border-radius:8px;padding:12px;font-size:14px;margin:12px 0;line-height:1.6;">' +
    '<strong>Supervisor:</strong> ' + escHtml(supervisorName) + '<br>' +
    '<strong>Contact:</strong> ' + escHtml(supervisorContact) +
    '</div>' +
    '<button class="btn btn-primary" id="confirm-junior-btn">Confirm & Check In</button>' +
    '<button class="btn btn-secondary" id="junior-back-btn2" style="margin-top:8px;font-size:13px;color:#6b7280;">← Search again</button>' +
    '<div id="msg"></div>';
  document.getElementById('confirm-junior-btn').addEventListener('click', function() {
    submitSupervisorCheckin(supervisorName, supervisorContact, juniorNum, juniorName, bookingTime, bookingCourtId);
  });
  document.getElementById('junior-back-btn2').addEventListener('click', function() {
    showJuniorSearch(supervisorName, supervisorContact);
  });
}

async function submitSupervisorCheckin(supervisorName, supervisorContact, juniorNum, juniorName, bookingTime, bookingCourtId) {
  var btn = document.getElementById('confirm-junior-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking in...'; }
  showMsg('Getting your location...', 'info');

  async function doSubmit(lat, lng) {
    try {
      var body = {
        tenant_id: TENANT_ID,
        membership_number: juniorNum,
        member_name: juniorName,
        gps_lat: lat,
        gps_lng: lng,
        is_delegate: true,
        supervisor_name: supervisorName,
        supervisor_contact: supervisorContact
      };
      if (bookingTime) { body.booking_time = bookingTime; body.booking_court_id = String(bookingCourtId || ''); }
      var cr = await fetch('/api/checkin/submit', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      var cd = await cr.json();
      if (!cr.ok) {
        showMsg(cd.error || 'Check-in failed.', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Confirm & Check In'; }
        return;
      }
      showSuccess(juniorName);
    } catch(e) {
      showMsg('Network error — please try again.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Confirm & Check In'; }
    }
  }

  navigator.geolocation.getCurrentPosition(
    function(pos) { doSubmit(pos.coords.latitude, pos.coords.longitude); },
    function() { doSubmit(null, null); },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
  );
}

function updateClock() {
  var el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' });
}

function showMsg(text, type) {
  var el = document.getElementById('msg');
  if (el) el.innerHTML = '<div class="status status-' + type + '">' + text + '</div>';
}

function showSuccess(name) {
  var chatUrl = 'https://app.sprimal.com/chat/' + TENANT_ID;
  var assistantName = clubInfo.assistant_name || 'Maeve';
  var memberNum = savedMember ? savedMember.membership_number : null;
  document.getElementById('card').innerHTML =
    '<div class="success-icon">✅</div>' +
    '<div class="success-title">Checked In!</div>' +
    '<div class="success-sub">Welcome, ' + name + '</div>' +
    '<div class="success-sub" style="margin-top:8px">' + clubInfo.club_name + ' · ' + new Date().toLocaleTimeString('en-IE', {hour:'2-digit',minute:'2-digit'}) + '</div>' +
    (memberNum ? '<button class="btn btn-secondary" id="junior-delegate-btn" style="margin-top:20px;">Check in a junior</button>' : '') +
    '<a href="' + chatUrl + '" target="_blank" rel="noopener" style="display:block;margin-top:10px;padding:14px;background:#ffffff;border:2px solid #e5e7eb;border-radius:12px;text-decoration:none;color:#1a1a2e;font-size:15px;font-weight:600;text-align:center;">💬 Chat with ' + assistantName + '</a>';
  if (memberNum) {
    document.getElementById('junior-delegate-btn').addEventListener('click', function() {
      showDelegateForm(memberNum);
    });
  }
}


async function sendOtpAndShow(membershipNumber) {
  var btn = document.getElementById('send-btn') || document.getElementById('wb-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending code...'; }
  showMsg('Sending code to your email...', 'info');
  try {
    var r = await fetch('/api/checkin/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: TENANT_ID, membership_number: membershipNumber })
    });
    var d = await r.json();
    if (!r.ok) {
      showMsg(d.error || 'Could not send code. Please try again.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Check In'; }
      return;
    }
    showOtpScreen(membershipNumber, d.name, d.email_hint);
  } catch(e) {
    showMsg('Network error — please try again.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Check In'; }
  }
}

function showOtpScreen(membershipNumber, memberName, emailHint) {
  document.getElementById('card').innerHTML = header() +
    '<div class="email-hint">Code sent to ' + emailHint + '</div>' +
    '<div class="otp-wrap">' +
    '<input class="otp-box" id="otp0" maxlength="1" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]">' +
    '<input class="otp-box" id="otp1" maxlength="1" inputmode="numeric" pattern="[0-9]">' +
    '<input class="otp-box" id="otp2" maxlength="1" inputmode="numeric" pattern="[0-9]">' +
    '<input class="otp-box" id="otp3" maxlength="1" inputmode="numeric" pattern="[0-9]">' +
    '</div>' +
    '<button class="btn btn-primary" id="verify-btn">Verify & Check In</button>' +
    '<p style="font-size:12px;color:#6b7280;margin-top:8px;line-height:1.4;">📧 Check your email inbox for the 4-digit code.</p>' +
    '<button class="btn btn-secondary" id="resend-btn" style="margin-top:8px;">Resend code</button>' +
    '<button class="btn btn-secondary" id="back-btn" style="margin-top:4px;font-size:13px;color:#6b7280;">← Search again</button>' +
    '<div id="msg"></div>';

  initOtpBoxes(function() { verifyAndSubmit(membershipNumber, memberName); });
  document.getElementById('verify-btn').addEventListener('click', function() { verifyAndSubmit(membershipNumber, memberName); });
  document.getElementById('resend-btn').addEventListener('click', function() { sendOtpAndShow(membershipNumber); });
  document.getElementById('back-btn').addEventListener('click', showMemberSearch);
  document.getElementById('otp0').focus();
}

function initOtpBoxes(onComplete) {
  var boxes = Array.from(document.querySelectorAll('.otp-box'));
  boxes.forEach(function(box, i) {
    box.addEventListener('keydown', function(e) {
      if (e.key === 'Backspace' && !this.value && i > 0) { boxes[i-1].focus(); boxes[i-1].value = ''; }
    });
    box.addEventListener('input', function() {
      var val = this.value.replace(/\D/g, '');
      if (val.length > 1) {
        val.split('').forEach(function(ch, j) { if (boxes[i+j]) boxes[i+j].value = ch; });
        var last = Math.min(i + val.length, 3);
        boxes[last].focus();
        this.value = val[0];
      } else {
        this.value = val;
        if (val && i < 3) boxes[i+1].focus();
      }
      if (boxes.every(function(b) { return b.value; })) onComplete();
    });
    box.addEventListener('paste', function(e) {
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
      text.split('').forEach(function(ch, j) { if (boxes[j]) boxes[j].value = ch; });
      boxes[Math.min(text.length, 3)].focus();
      if (text.length >= 4) onComplete();
    });
  });
}

function getOtpCode() {
  return Array.from(document.querySelectorAll('.otp-box')).map(function(b) { return b.value; }).join('');
}

async function verifyAndSubmit(membershipNumber, memberName) {
  var code = getOtpCode();
  if (code.length < 4) { showMsg('Please enter the full 4-digit code.', 'error'); return; }
  var btn = document.getElementById('verify-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Verifying...'; }
  try {
    var r = await fetch('/api/checkin/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: TENANT_ID, membership_number: membershipNumber, code: code })
    });
    var d = await r.json();
    if (!r.ok) {
      showMsg(d.error || 'Invalid code. Please try again.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Verify & Check In'; }
      return;
    }
    saveMember({ membership_number: membershipNumber, name: d.name });
    validateBookingThenCheckin(membershipNumber, d.name);
  } catch(e) {
    showMsg('Network error — please try again.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Verify & Check In'; }
  }
}

async function autoVerifyFromLink(membershipNumber, code) {
  document.getElementById('card').innerHTML = header() + '<div class="status status-info" style="margin-top:16px;">Verifying your code...</div>';
  try {
    var r = await fetch('/api/checkin/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: TENANT_ID, membership_number: membershipNumber, code: code })
    });
    var d = await r.json();
    if (!r.ok) {
      document.getElementById('card').innerHTML = header() +
        '<div class="status status-error" style="margin-top:16px;">' + (d.error || 'Link expired. Please scan the QR code again.') + '</div>' +
        '<button class="btn btn-primary" id="retry-btn" style="margin-top:16px;">Try again</button>';
      document.getElementById('retry-btn').addEventListener('click', showForm);
      return;
    }
    saveMember({ membership_number: membershipNumber, name: d.name });
    validateBookingThenCheckin(membershipNumber, d.name);
  } catch(e) {
    document.getElementById('card').innerHTML = header() + '<div class="status status-error" style="margin-top:16px;">Network error. Please scan the QR code again.</div>';
  }
}

function resetCheckinBtn() {
  var btn = document.getElementById('booking-checkin-btn');
  if (btn) { btn.disabled = false; btn.textContent = '✅ Check In'; }
}

async function submitCheckin(membershipNumber, memberName) {
  showMsg('Getting your location...', 'info');
  navigator.geolocation.getCurrentPosition(async function(pos) {
    showMsg('Checking in...', 'info');
    try {
      var body = { tenant_id: TENANT_ID, membership_number: membershipNumber, member_name: memberName, gps_lat: pos.coords.latitude, gps_lng: pos.coords.longitude };
      if (currentBooking) { body.booking_time = currentBooking.time; body.booking_court_id = String(currentBooking.court_id); }
      var cr = await fetch('/api/checkin/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      var cd = await cr.json();
      if (!cr.ok) { showMsg(cd.error || 'Check-in failed.', 'error'); resetCheckinBtn(); return; }
      showSuccess(memberName);
    } catch(e) {
      showMsg('Network error — please try again.', 'error');
      resetCheckinBtn();
    }
  }, function() {
    submitCheckinNoGps(membershipNumber, memberName);
  }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
}

async function submitCheckinNoGps(membershipNumber, memberName) {
  try {
    var body = { tenant_id: TENANT_ID, membership_number: membershipNumber, member_name: memberName, gps_lat: null, gps_lng: null };
    if (currentBooking) { body.booking_time = currentBooking.time; body.booking_court_id = String(currentBooking.court_id); }
    var cr = await fetch('/api/checkin/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var cd = await cr.json();
    if (!cr.ok) { showMsg(cd.error || 'Check-in failed.', 'error'); resetCheckinBtn(); return; }
    showSuccess(memberName);
  } catch(e) {
    showMsg('Network error — please try again.', 'error');
    resetCheckinBtn();
  }
}

init();
</script>
</body>
</html>`);
});

// GET /api/checkin/club-info/:tenantId — public, returns club info for check-in page
app.get("/api/checkin/club-info/:tenantId", async (req, res) => {
  try {
    const { tenantId } = req.params;
    console.log("[club-info] request for", tenantId);
    // Run all three operations in parallel to minimise latency
    const [tenantResult, nameResult] = await Promise.all([
      supabase.from("tenants")
        .select("name, business_type, checkin_lat, checkin_lng, checkin_radius_meters, logo_url")
        .eq("id", tenantId).single(),
      supabase.from("tenants").select("assistant_name").eq("id", tenantId).single(),
      loadEboConfigFromDb(tenantId)
    ]);
    const { data: tenant, error } = tenantResult;
    if (error || !tenant) return res.status(404).json({ error: "Not found" });
    if (tenant.business_type !== "tennis_club") return res.status(403).json({ error: "Check-in is only available for tennis clubs" });
    const assistantName = nameResult?.data?.assistant_name || "Maeve";
    res.json({
      club_name: tenant.name,
      logo_url: tenant.logo_url || null,
      assistant_name: assistantName,
      has_gps: !!(tenant.checkin_lat && tenant.checkin_lng),
      gps_radius: tenant.checkin_radius_meters || 150,
      ebo_enabled: !!EBO_CONFIG[tenantId]
    });
  } catch(err) {
    console.error("[club-info]", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/checkin/validate-member — validate membership number against EBO
app.post("/api/checkin/validate-member", async (req, res) => {
  const { tenant_id, membership_number } = req.body;
  if (!tenant_id || !membership_number) return res.status(400).json({ error: "Missing fields" });
  await loadEboConfigFromDb(tenant_id);
  const member = await fetchEboMemberDetails(tenant_id, membership_number);
  if (!member || !member.active) return res.status(404).json({ error: "Membership number not found or inactive" });
  res.json({ name: member.first_name + " " + member.last_name, membership_number: member.membership_number });
});

// EBO returns booking times as Irish local time strings ("2026-06-16 19:15:00").
// Never use Date.now() or new Date(b.time) for window comparisons — the server runs UTC
// and will be 1 hour off. Always use these two helpers together.
function irishNowMins() {
  const t = new Intl.DateTimeFormat("en-IE", { timeZone: "Europe/Dublin", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function eboBookingMins(b) {
  const hhmm = String(b.time || "").slice(11, 16);
  if (!hhmm || !hhmm.includes(":")) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// GET /api/checkin/search-members/:tenantId — search today's EBO bookings by name within check-in window
app.get("/api/checkin/search-members/:tenantId", async (req, res) => {
  const { tenantId } = req.params;
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q || q.length < 2) return res.json([]);
  if (q.length > 100 || /</.test(q)) return res.json([]);
  try {
    await loadEboConfigFromDb(tenantId);
    const today = new Date().toISOString().slice(0, 10);
    const bookings = await fetchEboBookings(tenantId, today, today, 500);
    const nowMins = irishNowMins();
    const seen = new Set();
    const results = [];
    for (const b of bookings) {
      const bMins = eboBookingMins(b);
      if (bMins === null) continue;
      if (nowMins < bMins - 15 || nowMins > bMins + 30) continue;
      for (const m of (b.bookedMembers || [])) {
        if (!m.membership_number || Number(m.membership_number) === 1 || m.colour) continue;
        if (seen.has(String(m.membership_number))) continue;
        const fullName = (m.name || `${m.first_name || ""} ${m.last_name || ""}`.trim());
        if (!fullName.toLowerCase().includes(q)) continue;
        seen.add(String(m.membership_number));
        results.push({ membership_number: m.membership_number, name: fullName, booking_time: b.time, court_id: b.court_id });
      }
    }
    res.json(results);
  } catch (err) {
    console.error("[search-members]", err.message);
    res.status(500).json({ error: "Search failed" });
  }
});

// In-memory OTP store — key: `${tenantId}:${membershipNumber}`
const OTP_STORE = new Map();

// POST /api/checkin/send-otp — validate member, generate OTP, email it
app.post("/api/checkin/send-otp", otpSendLimiter, async (req, res) => {
  const { tenant_id, membership_number } = req.body;
  if (!tenant_id || !membership_number) return res.status(400).json({ error: "Missing fields" });
  await loadEboConfigFromDb(tenant_id);
  const member = await fetchEboMemberDetails(tenant_id, membership_number);
  if (!member || !member.active) return res.status(404).json({ error: "Membership number not found or inactive" });
  if (!member.email) return res.status(400).json({ error: "No email address on file for this membership. Please contact the club." });

  const code = String(Math.floor(1000 + Math.random() * 9000));
  const key = `${tenant_id}:${membership_number}`;
  OTP_STORE.set(key, { code, expires: Date.now() + 10 * 60 * 1000, name: member.first_name + " " + member.last_name, attempts: 0 });

  const { data: tenant } = await supabase.from("tenants").select("name, logo_url").eq("id", tenant_id).single();
  const clubName = tenant?.name || "your club";
  const magicLink = `https://app.sprimal.com/checkin/${tenant_id}?c=${code}&m=${membership_number}`;
  const logoHtml = tenant?.logo_url
    ? `<img src="${tenant.logo_url}" alt="${clubName}" style="width:64px;height:64px;object-fit:contain;border-radius:12px;margin-bottom:12px;">`
    : `<div style="font-size:40px;margin-bottom:12px;">🎾</div>`;

  if (process.env.RESEND_API_KEY) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Maeve <maeve@sprimal.com>",
        to: [member.email],
        subject: `Your ${clubName} check-in code`,
        html: `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;margin:0;padding:20px;">
<div style="max-width:400px;margin:0 auto;background:white;border-radius:16px;padding:32px 24px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.1);">
  ${logoHtml}
  <h2 style="margin:0 0 8px;color:#1a1a2e;font-size:20px;">${clubName}</h2>
  <p style="color:#6b7280;margin:0 0 24px;font-size:15px;">Hi ${member.first_name}, tap below to check in:</p>
  <a href="${magicLink}" style="display:block;background:#1565c0;color:white;text-decoration:none;padding:18px;border-radius:12px;font-size:18px;font-weight:700;margin-bottom:24px;">✅ Tap to Check In</a>
  <p style="color:#9ca3af;font-size:13px;margin:0 0 10px;">Or enter this code manually:</p>
  <div style="font-size:38px;font-weight:900;letter-spacing:10px;color:#1a1a2e;margin-bottom:16px;">${code}</div>
  <p style="color:#9ca3af;font-size:12px;margin:0;">Expires in 10 minutes &middot; Single use</p>
</div></body></html>`
      })
    }).catch(() => {});
  }

  const [local, domain] = member.email.split("@");
  const emailHint = local[0] + "***@" + domain;
  res.json({ email_hint: emailHint, name: member.first_name + " " + member.last_name });
});

// POST /api/checkin/verify-otp — verify OTP code
app.post("/api/checkin/verify-otp", otpVerifyLimiter, async (req, res) => {
  const { tenant_id, membership_number, code } = req.body;
  if (!tenant_id || !membership_number || !code) return res.status(400).json({ error: "Missing fields" });
  const key = `${tenant_id}:${membership_number}`;
  const stored = OTP_STORE.get(key);
  if (!stored) return res.status(400).json({ error: "No code was sent. Please request a new one." });
  if (Date.now() > stored.expires) { OTP_STORE.delete(key); return res.status(400).json({ error: "Code expired. Please request a new one." }); }
  stored.attempts = (stored.attempts || 0) + 1;
  if (stored.attempts > 5) {
    OTP_STORE.delete(key);
    return res.status(429).json({ error: "Too many incorrect attempts. Please request a new code." });
  }
  if (stored.code !== String(code).trim()) {
    const remaining = 5 - stored.attempts;
    return res.status(400).json({ error: `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.` });
  }
  OTP_STORE.delete(key);
  res.json({ ok: true, name: stored.name });
});

// GET /api/checkin/validate-booking/:tenantId/:membershipNumber
app.get("/api/checkin/validate-booking/:tenantId/:membershipNumber", async (req, res) => {
  const { tenantId, membershipNumber } = req.params;
  const memberNum = parseInt(membershipNumber);
  if (!memberNum) return res.status(400).json({ error: "Invalid membership number" });
  try {
    await loadEboConfigFromDb(tenantId);
    const cfg = EBO_CONFIG[tenantId];
    if (!cfg) return res.json({ valid_booking: null, already_checked_in: false, member_name: null, message: "Check-in is not configured for this club." });

    const today = new Date().toISOString().slice(0, 10);
    const bookings = await fetchEboBookings(tenantId, today, today, 500);
    const mine = bookings.filter(b =>
      Array.isArray(b.bookedMembers) && b.bookedMembers.some(m => Number(m.membership_number) === memberNum)
    );

    const slotMins = cfg.slotMinutes || 60;
    const nowMins = irishNowMins();

    // Window: 15 mins before booking to 30 mins after. Encourages on-time arrival.
    const validBooking = mine.find(b => {
      const bMins = eboBookingMins(b);
      return bMins !== null && nowMins >= bMins - 15 && nowMins <= bMins + 30;
    });

    if (!validBooking) {
      // Check if they already checked in for a slot that's still running (window has closed
      // but slot hasn't ended) — show "already checked in" rather than "window closed".
      const activeSlot = mine.find(b => {
        const bMins = eboBookingMins(b);
        return bMins !== null && nowMins > bMins + 30 && nowMins <= bMins + slotMins;
      });
      if (activeSlot) {
        const { data: activeExisting } = await supabase.from("court_checkins")
          .select("id, booking_court_id, booking_time").eq("tenant_id", tenantId).eq("membership_number", memberNum)
          .eq("booking_time", activeSlot.time).maybeSingle();
        if (activeExisting) {
          const displayTime = String(activeExisting.booking_time || "").slice(11, 16);
          return res.json({ valid_booking: { court_id: activeExisting.booking_court_id, time: activeExisting.booking_time, display_time: displayTime }, already_checked_in: true, member_name: null, message: `Already checked in for Court ${activeExisting.booking_court_id} at ${displayTime}.` });
        }
        // Slot is running but check-in window has closed
        const slotHhmm = String(activeSlot.time || "").slice(11, 16);
        const [sh, sm] = slotHhmm.split(":").map(Number);
        const openMins = sh * 60 + sm - 15;
        const openStr = String(Math.floor(openMins / 60)).padStart(2, "0") + ":" + String(openMins % 60).padStart(2, "0");
        const closedMins = sh * 60 + sm + 30;
        const closedStr = String(Math.floor(closedMins / 60)).padStart(2, "0") + ":" + String(closedMins % 60).padStart(2, "0");
        return res.json({ valid_booking: null, already_checked_in: false, member_name: null, message: `Check-in window for your ${slotHhmm} booking was ${openStr}–${closedStr}. That window has now closed.` });
      }

      let msg;
      if (mine.length === 0) {
        msg = "You have no bookings at the club today.";
      } else {
        const next = mine.find(b => {
          const hhmm = String(b.time || "").slice(11, 16);
          if (!hhmm || !hhmm.includes(":")) return false;
          const [bh, bm] = hhmm.split(":").map(Number);
          return bh * 60 + bm > nowMins + 30;
        });
        if (next) {
          const hhmm = String(next.time || "").slice(11, 16);
          const [bh, bm] = hhmm.split(":").map(Number);
          const openMins = bh * 60 + bm - 15;
          const openStr = String(Math.floor(openMins / 60)).padStart(2, "0") + ":" + String(openMins % 60).padStart(2, "0");
          msg = `Check-in opens at ${openStr} — 15 minutes before your ${hhmm} booking.`;
        } else {
          msg = "No active booking found in the current check-in window.";
        }
      }
      return res.json({ valid_booking: null, already_checked_in: false, member_name: null, message: msg });
    }

    const member = (validBooking.bookedMembers || []).find(m => Number(m.membership_number) === memberNum);
    const memberName = member ? (member.name || `${member.first_name || ""} ${member.last_name || ""}`.trim() || `Member #${memberNum}`) : `Member #${memberNum}`;
    const displayTime = String(validBooking.time || "").slice(11, 16);
    const booking = { court_id: validBooking.court_id, time: validBooking.time, display_time: displayTime };

    // Block if already checked in for ANY court at this timeslot — one slot, one check-in
    const { data: existing } = await supabase.from("court_checkins")
      .select("id, booking_court_id").eq("tenant_id", tenantId).eq("membership_number", memberNum)
      .eq("booking_time", validBooking.time).maybeSingle();

    if (existing) return res.json({ valid_booking: booking, already_checked_in: true, member_name: memberName, message: `Already checked in for Court ${existing.booking_court_id || validBooking.court_id} at ${displayTime}.` });

    return res.json({ valid_booking: booking, already_checked_in: false, member_name: memberName, message: null });
  } catch(err) {
    console.error("[validate-booking]", err.message);
    return res.json({ valid_booking: null, already_checked_in: false, member_name: null, message: null, ebo_error: true });
  }
});

// POST /api/checkin/submit — record a check-in
app.post("/api/checkin/submit", async (req, res) => {
  try {
    const { tenant_id, membership_number, member_name, gps_lat, gps_lng, booking_time, booking_court_id, checked_in_by, is_delegate, supervisor_name, supervisor_contact } = req.body;
    if (!tenant_id || !membership_number || !member_name) return res.status(400).json({ error: "Missing fields" });
    // Input length + HTML injection guard
    const hasHtml = (s) => s && /</.test(s);
    if (member_name.length > 100 || hasHtml(member_name)) return res.status(400).json({ error: "Invalid input" });
    if (supervisor_name && (supervisor_name.length > 100 || hasHtml(supervisor_name))) return res.status(400).json({ error: "Invalid input" });
    if (supervisor_contact && (supervisor_contact.length > 150 || hasHtml(supervisor_contact))) return res.status(400).json({ error: "Invalid input" });

    // Duplicate booking check
    if (booking_time && booking_court_id) {
      const { data: existing } = await supabase.from("court_checkins")
        .select("id").eq("tenant_id", tenant_id).eq("membership_number", membership_number)
        .eq("booking_time", booking_time).eq("booking_court_id", String(booking_court_id))
        .maybeSingle();
      if (existing) {
        const t = String(booking_time).slice(11, 16);
        return res.status(409).json({ error: `Already checked in for Court ${booking_court_id} at ${t}.` });
      }
    }

    // GPS validation — if tenant has GPS set and member provided location, check distance
    let gps_verified = false;
    let gps_distance_meters = null;
    if (gps_lat && gps_lng) {
      const { data: tenant } = await supabase.from("tenants").select("checkin_lat, checkin_lng, checkin_radius_meters").eq("id", tenant_id).single();
      if (tenant?.checkin_lat && tenant?.checkin_lng) {
        gps_distance_meters = Math.round(gpsDistance(gps_lat, gps_lng, tenant.checkin_lat, tenant.checkin_lng));
        const radius = tenant.checkin_radius_meters || 150;
        if (gps_distance_meters > radius) {
          console.warn(`[checkin] GPS rejected: ${member_name} (#${membership_number}) at ${tenant_id} — ${gps_distance_meters}m away (radius ${radius}m)`);
          return res.status(403).json({ error: `You must be at the club to check in (you appear to be ${gps_distance_meters}m away).` });
        }
        gps_verified = true;
      }
    }

    console.log(`[checkin] attempting insert: ${member_name} (#${membership_number}) at ${tenant_id} — GPS ${gps_verified ? gps_distance_meters + "m" : "not verified"}, booking ${booking_time || "none"}`);
    const { error } = await supabase.from("court_checkins").insert({
      tenant_id, membership_number, member_name,
      gps_lat, gps_lng, gps_distance_meters, gps_verified,
      booking_time: booking_time || null,
      booking_court_id: booking_court_id ? String(booking_court_id) : null,
      checked_in_by: checked_in_by || null,
      is_delegate: is_delegate || false,
      supervisor_name: supervisor_name || null,
      supervisor_contact: supervisor_contact || null
    });
    if (error) {
      console.error(`[checkin] insert failed for ${member_name} (#${membership_number}) at ${tenant_id}:`, error.message, error.code);
      return res.status(500).json({ error: "Failed to record check-in" });
    }
    const note = checked_in_by ? ` (delegated by #${checked_in_by})` : "";
    console.log(`[checkin] SUCCESS: ${member_name} (#${membership_number}) checked in at ${tenant_id} — GPS ${gps_verified ? gps_distance_meters + "m" : "not verified"}${note}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[checkin] unexpected error in submit:`, err.message);
    res.status(500).json({ error: "Failed to record check-in" });
  }
});

// GET /api/portal/checkins/supervisors — junior supervision log for a given date (default today)
app.get("/api/portal/checkins/supervisors", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) ? req.query.date : new Date().toISOString().slice(0, 10);
  const dayStart = date + "T00:00:00.000Z";
  const dayEnd   = date + "T23:59:59.000Z";

  const { data, error } = await supabase
    .from("court_checkins")
    .select("id, supervisor_name, supervisor_contact, member_name, membership_number, checked_in_at")
    .eq("tenant_id", tenantId)
    .not("supervisor_name", "is", null)
    .gte("checked_in_at", dayStart)
    .lte("checked_in_at", dayEnd)
    .order("checked_in_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ date, rows: data || [] });
});

// GET /api/portal/checkins/dashboard — captain dashboard: today's check-ins vs EBO bookings
app.get("/api/portal/checkins/dashboard", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(new Date());
  const todayStart = today + "T00:00:00.000Z";
  const todayEnd   = today + "T23:59:59.000Z";

  const [{ data: checkins }, bookings] = await Promise.all([
    supabase.from("court_checkins").select("*").eq("tenant_id", tenantId).gte("checked_in_at", todayStart).lte("checked_in_at", todayEnd).order("checked_in_at", { ascending: false }),
    (async () => { try { await loadEboConfigFromDb(tenantId); return fetchEboBookings(tenantId, today, today, 500); } catch { return []; } })()
  ]);

  const cfg = EBO_CONFIG[tenantId];
  const slotMins = cfg?.slotMinutes || 60;

  // Use Irish local time so slot boundaries match EBO booking times (which are also Irish local)
  const irishHHMM = new Intl.DateTimeFormat("en-IE", { timeZone: "Europe/Dublin", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const [nowH, nowM] = irishHHMM.split(":").map(Number);
  const nowMins = nowH * 60 + nowM;

  // Build court-specific and time-only check-in key sets (same logic as no-show report)
  const checkedInCourtKeys = new Set();
  const checkedInTimeKeys  = new Set();
  for (const c of (checkins || [])) {
    const t = String(c.booking_time || "").replace(" ", "T").slice(0, 16);
    if (!t) continue;
    if (c.booking_court_id) {
      checkedInCourtKeys.add(t + "|" + String(c.booking_court_id));
    } else {
      checkedInTimeKeys.add(t);
    }
  }

  const countMembers = (bs) => bs.reduce((n, b) =>
    n + (b.bookedMembers || []).filter(m => m.membership_number && Number(m.membership_number) !== 1 && !m.colour).length, 0
  );
  const isCourtCovered = (b) => {
    const slotKey = String(b.time || "").replace(" ", "T").slice(0, 16);
    const courtId = b.court_id ? String(b.court_id) : null;
    return (courtId && checkedInCourtKeys.has(slotKey + "|" + courtId)) || checkedInTimeKeys.has(slotKey);
  };

  // Current slot: bookings whose start time falls in the current hour window
  const currentBookings = bookings.filter(b => {
    const hhmm = String(b.time || "").slice(11, 16);
    if (!hhmm) return false;
    const [h, m] = hhmm.split(":").map(Number);
    const slotStart = h * 60 + m;
    return nowMins >= slotStart && nowMins < slotStart + slotMins;
  });

  const currentBookingMembers  = countMembers(currentBookings);
  const currentCheckinMembers  = countMembers(currentBookings.filter(isCourtCovered));
  const totalBookingMembers    = countMembers(bookings);
  const totalCheckinMembers    = countMembers(bookings.filter(isCourtCovered));

  res.json({
    date: today,
    total_checkins_today: totalCheckinMembers,
    total_bookings_today: totalBookingMembers,
    current_bookings: currentBookingMembers,
    current_checkins: currentCheckinMembers,
    no_show_risk: currentBookingMembers > 0 && currentCheckinMembers === 0
  });
});

// GET /api/portal/checkins/noshow-report?period=day|week|month|3m|6m|year
app.get("/api/portal/checkins/noshow-report", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const period = req.query.period || "week";

  const periodDays = { day: 1, week: 7, month: 30, "3m": 90, "6m": 180, year: 365 };
  const days = periodDays[period] || 7;

  const toDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(new Date());
  const fromDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" })
    .format(new Date(Date.now() - (days - 1) * 86400000));

  try {
    await loadEboConfigFromDb(tenantId);
    const [bookings, { data: checkins }] = await Promise.all([
      fetchEboBookingsPaged(tenantId, fromDate, toDate),
      supabase.from("court_checkins").select("booking_time, booking_court_id")
        .eq("tenant_id", tenantId)
        .gte("booking_time", fromDate + " 00:00:00")
        .lte("booking_time", toDate + " 23:59:59")
    ]);

    // Build two sets: court-specific (time|court_id) and time-only (for GPS check-ins that lack court_id)
    // A null/empty court_id must NEVER spread across all courts — only exact court matches count
    const checkedInCourtKeys = new Set();
    const checkedInTimeOnly  = new Set();
    for (const c of (checkins || [])) {
      const t = String(c.booking_time || "").replace(" ", "T").slice(0, 16);
      if (!t) continue;
      if (c.booking_court_id) {
        checkedInCourtKeys.add(t + "|" + String(c.booking_court_id));
      } else {
        checkedInTimeOnly.add(t);
      }
    }
    console.log(`[noshow] ${tenantId}: ${checkedInCourtKeys.size} court-keyed check-ins, ${checkedInTimeOnly.size} time-only check-ins`);

    // For "today" only count slots that have already started — future bookings can't be no-shows yet
    const irishTime = new Intl.DateTimeFormat("en-IE", { timeZone: "Europe/Dublin", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
    const [nowH, nowM] = irishTime.split(":").map(Number);
    const nowMinsOfDay = nowH * 60 + nowM;

    // Aggregate per member
    const memberMap = {};
    for (const b of bookings) {
      const bookingTime = String(b.time || "").replace(" ", "T").slice(0, 16);
      if (!bookingTime) continue;
      if (period === "day") {
        const hhmm = String(b.time || "").slice(11, 16);
        if (!hhmm.includes(":")) continue;
        const [bh, bm] = hhmm.split(":").map(Number);
        if (bh * 60 + bm > nowMinsOfDay) continue;
      }
      // Prefer court-specific match; fall back to time-only for legacy check-ins without court_id
      const courtId = b.court_id ? String(b.court_id) : null;
      const wasCheckedIn = (courtId && checkedInCourtKeys.has(bookingTime + "|" + courtId))
        || checkedInTimeOnly.has(bookingTime);
      for (const m of (b.bookedMembers || [])) {
        const key = m.membership_number;
        if (!key || Number(key) === 1 || m.colour) continue;
        if (!memberMap[key]) memberMap[key] = { membership_number: key, name: m.name || `Member #${key}`, booked: 0, noshows: 0, noshow_times: [] };
        memberMap[key].booked++;
        if (!wasCheckedIn) { memberMap[key].noshows++; memberMap[key].noshow_times.push(bookingTime); }
      }
    }

    const members = Object.values(memberMap)
      .map(m => ({ ...m, rate: m.booked > 0 ? Math.round(m.noshows / m.booked * 100) : 0 }))
      .sort((a, b) => b.noshows - a.noshows);

    const totalBookings = members.reduce((s, m) => s + m.booked, 0);
    const totalNoshows = members.reduce((s, m) => s + m.noshows, 0);

    res.json({ period, from: fromDate, to: toDate, total_bookings: totalBookings, total_noshows: totalNoshows, members });
  } catch (err) {
    console.error("[noshow-report]", err.message);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

// GET /api/portal/checkins/gps-centroid — average GPS of all verified check-ins for calibration
app.get("/api/portal/checkins/gps-centroid", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  try {
    const { data, error } = await supabase.from("court_checkins")
      .select("gps_lat, gps_lng")
      .eq("tenant_id", tenantId)
      .eq("gps_verified", true)
      .not("gps_lat", "is", null)
      .not("gps_lng", "is", null);
    if (error) throw error;
    if (!data || data.length === 0) return res.json({ count: 0, lat: null, lng: null });
    const lat = data.reduce((s, r) => s + r.gps_lat, 0) / data.length;
    const lng = data.reduce((s, r) => s + r.gps_lng, 0) / data.length;
    res.json({ count: data.length, lat: Math.round(lat * 1000000) / 1000000, lng: Math.round(lng * 1000000) / 1000000 });
  } catch (err) {
    console.error("[gps-centroid]", err.message);
    res.status(500).json({ error: "Failed to compute centroid" });
  }
});

// GET /api/portal/checkins/log — check-in history for this tenant, augmented with EBO court-mates
app.get("/api/portal/checkins/log", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(new Date());

  const { data: checkins, error } = await supabase.from("court_checkins").select("*").eq("tenant_id", tenantId).order("checked_in_at", { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: error.message });

  // For today's check-ins, augment with EBO court-mates who share a checked-in timeslot
  // so the log shows all booked members on a court even if only one physically scanned
  try {
    await loadEboConfigFromDb(tenantId);
    const todayBookings = await fetchEboBookings(tenantId, today, today, 500);
    const todayCheckins = (checkins || []).filter(c => c.checked_in_at && c.checked_in_at.slice(0, 10) === today);

    // Build two sets so we only infer court-mates for the specific court that has a real check-in.
    // Court-specific keys (time|court_id) for check-ins that have booking_court_id;
    // time-only fallback for legacy check-ins that don't.
    const checkedInCourtSlots = new Set();
    const checkedInTimeSlots  = new Set();
    for (const c of todayCheckins.filter(c => c.booking_time)) {
      const t = String(c.booking_time).replace(" ", "T").slice(0, 16);
      if (c.booking_court_id) {
        checkedInCourtSlots.add(t + "|" + String(c.booking_court_id));
      } else {
        checkedInTimeSlots.add(t);
      }
    }
    // Build set of membership numbers already in the real check-in list (avoid duplicates)
    const realCheckinMembers = new Set(todayCheckins.map(c => String(c.membership_number)));

    // Find court-mates: booked members on a checked-in court who don't have their own record
    const courtMates = [];
    for (const b of todayBookings) {
      const slotKey = String(b.time || "").replace(" ", "T").slice(0, 16);
      const courtId = b.court_id ? String(b.court_id) : null;
      const slotHasCheckin = (courtId && checkedInCourtSlots.has(slotKey + "|" + courtId))
        || checkedInTimeSlots.has(slotKey);
      if (!slotHasCheckin) continue;
      // Find the real check-in for this specific court to copy its timestamp
      const anchor = todayCheckins.find(c => {
        const t = c.booking_time && String(c.booking_time).replace(" ", "T").slice(0, 16);
        if (t !== slotKey) return false;
        if (courtId && c.booking_court_id) return String(c.booking_court_id) === courtId;
        return !c.booking_court_id;
      });
      for (const m of (b.bookedMembers || [])) {
        if (!m.membership_number || Number(m.membership_number) === 1 || m.colour) continue;
        if (realCheckinMembers.has(String(m.membership_number))) continue;
        const name = m.name || `${m.first_name || ""} ${m.last_name || ""}`.trim() || `Member #${m.membership_number}`;
        courtMates.push({
          id: `inferred_${slotKey}_${m.membership_number}`,
          tenant_id: tenantId,
          membership_number: m.membership_number,
          member_name: name,
          checked_in_at: anchor ? anchor.checked_in_at : new Date().toISOString(),
          booking_time: anchor ? anchor.booking_time : null,
          booking_court_id: anchor ? anchor.booking_court_id : null,
          gps_verified: false,
          gps_distance_meters: null,
          is_delegate: false,
          inferred: true  // flag so portal can style it differently
        });
      }
    }
    res.json([...(checkins || []), ...courtMates]);
  } catch {
    // EBO unavailable — return real check-ins only
    res.json(checkins || []);
  }
});

// DELETE /api/portal/checkins/:id — remove a specific check-in record (admin only)
app.delete("/api/portal/checkins/:id", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { id } = req.params;
  const { error } = await supabase.from("court_checkins").delete().eq("id", id).eq("tenant_id", tenantId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// GET /api/portal/checkins/todays-members — unique members booked on courts today (for manual check-in dropdown)
app.get("/api/portal/checkins/todays-members", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(new Date());
  try {
    await loadEboConfigFromDb(tenantId);
    const bookings = await fetchEboBookings(tenantId, today, today, 500);
    const seen = new Map();
    for (const b of bookings) {
      if (!Array.isArray(b.bookedMembers)) continue;
      for (const m of b.bookedMembers) {
        if (!m.membership_number || Number(m.membership_number) === 1 || m.colour) continue; // skip guests and group/special events
        if (!seen.has(m.membership_number)) {
          seen.set(m.membership_number, { membership_number: m.membership_number, name: m.name || "Unknown" });
        }
      }
    }
    const members = Array.from(seen.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ members });
  } catch (err) {
    console.error("[checkins/todays-members] error:", err.message);
    res.json({ members: [] });
  }
});

// POST /api/portal/checkins/manual — admin manually records a check-in (GPS bypass)
app.post("/api/portal/checkins/manual", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { membership_number, member_name, reason } = req.body;
  if (!membership_number || !member_name) return res.status(400).json({ error: "Missing membership_number or member_name" });
  try {
    // Resolve today's booking time for this member so the no-show report credits the whole court
    let booking_time = null;
    let booking_court_id = null;
    try {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(new Date());
      await loadEboConfigFromDb(tenantId);
      const bookings = await fetchEboBookings(tenantId, today, today, 500);
      const match = bookings.find(b =>
        Array.isArray(b.bookedMembers) &&
        b.bookedMembers.some(m => Number(m.membership_number) === Number(membership_number))
      );
      if (match) {
        booking_time = match.time || null;
        booking_court_id = match.court_id ? String(match.court_id) : null;
        console.log(`[checkin] manual EBO match keys: ${Object.keys(match).join(", ")} | court_id=${match.court_id} | resource_id=${match.resource_id}`);
      } else {
        console.log(`[checkin] manual: no EBO booking found for #${membership_number} on ${today} (${bookings.length} bookings fetched)`);
      }
    } catch (e) {
      console.warn(`[checkin] manual: could not resolve booking time for #${membership_number}:`, e.message);
    }

    const { error } = await supabase.from("court_checkins").insert({
      tenant_id: tenantId,
      membership_number: parseInt(membership_number),
      member_name: String(member_name).trim(),
      gps_lat: null, gps_lng: null, gps_distance_meters: null, gps_verified: false,
      booking_time, booking_court_id,
      checked_in_by: null, is_delegate: false,
      manual_reason: reason ? String(reason).slice(0, 500) : null
    });
    if (error) return res.status(500).json({ error: error.message });
    console.log(`[checkin] MANUAL: ${member_name} (#${membership_number}) at ${tenantId} — booking_time: ${booking_time || "none"}, booking_court_id: ${booking_court_id || "none"}, reason: ${reason || "none"}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[checkin] manual insert error:", err.message);
    res.status(500).json({ error: "Failed to record check-in" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT} [${process.env.NODE_ENV || "dev"}]`);
  startEmailPolling();
  if (process.env.MORNING_DIGEST_ENABLED === "true") scheduleMorningDigest();

  // Ensure public bucket exists for social/profile images (img tags need public URLs)
  try {
    await supabase.storage.createBucket("social-images", { public: true });
    console.log("[storage] Created public bucket: social-images");
  } catch {
    // Bucket may already exist — ensure it's public regardless
    try {
      await supabase.storage.updateBucket("social-images", { public: true });
      console.log("[storage] Ensured social-images bucket is public");
    } catch {}
  }
});