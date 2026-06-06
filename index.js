const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
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

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
// Redirect root to portal; admin is still accessible at /login or /admin
app.get("/", (req, res) => res.redirect("/portal"));
app.use(express.static(path.join(__dirname, "public")));

const appointmentsFile = path.join(__dirname, "data", "appointments.json");
const chatLogsFile = path.join(__dirname, "data", "chatLogs.json");
const settingsFile = path.join(__dirname, "data", "settings.json");
const documentsFile = path.join(__dirname, "data", "documents.json");
const knowledgeBaseFile = path.join(__dirname, "data", "knowledgeBase.json");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const sessions = new Map();

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
const INTG_SENSITIVE_FIELDS = ["username", "password", "account_sid", "auth_token"];

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

// ── Business type detection ───────────────────────────────────────────────────
async function detectBusinessType(name, description, pageText) {
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Classify this business into exactly one category. Reply with ONLY the category key, nothing else.\nCategories:\n- tennis_club\n- fitness_studio\n- golf_club\n- other` },
        { role: "user",   content: `Name: ${name}\nDescription: ${description}\nPage text: ${pageText.slice(0, 600)}` }
      ],
      temperature: 0,
      max_tokens: 10
    });
    const raw  = (resp.choices[0].message.content || "other").trim().toLowerCase().replace(/[^a-z_]/g, "");
    const valid = ["tennis_club", "fitness_studio", "golf_club"];
    return valid.includes(raw) ? raw : "other";
  } catch (e) {
    console.error("[biz-type] Detection failed:", e.message);
    return "other";
  }
}

// ── Extract structured info from crawled pages (tennis clubs) ─────────────────
async function extractTennisClubInfo(pages, websiteUrl) {
  // Sort pages so the most info-rich pages come first.
  // Scoring: URL keyword match + page-text keyword match (catches /tennis, /about-us, etc.)
  const priority = ["membership", "join", "coaching", "lessons", "tennis", "coach", "contact", "find", "about", "location", "fees", "programme", "program", "camp", "junior"];
  const sorted = [...pages].sort((a, b) => {
    const score = (p) => {
      const urlLower  = p.url.toLowerCase();
      const textLower = p.text.toLowerCase().slice(0, 500); // first 500 chars of page text
      return priority.filter(k => urlLower.includes(k) || textLower.includes(k)).length;
    };
    return score(b) - score(a);
  });
  const combined = sorted.slice(0, 8).map(p => `--- ${p.url} ---\n${p.text}`).join("\n\n").slice(0, 6000);

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Extract structured info from this tennis club website. Return ONLY valid JSON. Use null for anything not found.\n{\n  "address": "full street address or null",\n  "eircode": "Irish eircode or null",\n  "email": "main contact email or null",\n  "phone": "phone number or null",\n  "membership_prices": "formatted price list e.g. '🎾 Adult — €X/year\\n👨‍👩‍👧 Family — €X/year' or null",\n  "membership_url": "URL of join/membership page or null",\n  "court_booking_url": "URL of court booking page or null",\n  "coaches": "formatted list of coaches with contact info, one per line, e.g. '🎾 Martin Cusack — 085 8734558\\n🎾 Aisling O Riordan — 085 1939086' or null",\n  "coaching_summary": "brief 1-2 sentence summary of coaching programmes offered (adult, junior, camps etc) or null",\n  "events_summary": "brief events/leagues summary or null",\n  "social_instagram": "instagram handle without @ or null",\n  "social_twitter": "twitter handle without @ or null"\n}` },
        { role: "user",   content: combined }
      ],
      temperature: 0,
      max_tokens: 900,
      response_format: { type: "json_object" }
    });
    const info = JSON.parse(resp.choices[0].message.content || "{}");
    console.log("[tennis-seed] Extracted info:", JSON.stringify(info));
    return info;
  } catch (e) {
    console.error("[tennis-seed] Info extraction failed:", e.message);
    return {};
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
  const fBook = crypto.randomUUID(), fEvt  = crypto.randomUUID(), fLoc   = crypto.randomUUID();
  const sMain = crypto.randomUUID(), sMemb1 = crypto.randomUUID(), sMemb2 = crypto.randomUUID();
  const sCoach = crypto.randomUUID(), sBook = crypto.randomUUID(), sEvt = crypto.randomUUID(), sLoc = crypto.randomUUID();

  const membershipUrl = v(info.membership_url)    || websiteUrl;
  const bookingUrl    = v(info.court_booking_url) || websiteUrl;
  const contactEmail  = v(info.email)             || "[FILL IN: email]";

  // Build messages — use crawled data where available, [FILL IN] otherwise
  const pricesBlock = v(info.membership_prices)
    ? info.membership_prices
    : "🎾 Adult — €[price] per year\n👨‍👩‍👧 Family — €[price] per year\n🧒 Junior (under 18) — €[price] per year\n🌟 Student — €[price] per year";

  const memb2Msg = `Here's an overview of our membership options:\n\n${pricesBlock}\n\nMembership includes full access to all courts, club nights, and social events.\n\nTo join, visit [link=${membershipUrl}]${membershipUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\nOr email [b]${contactEmail}[/b]`;

  const coachesBlock   = v(info.coaches) ? `\n\n${info.coaches}` : "";
  const coachMsg = v(info.coaching_summary)
    ? `We offer coaching for all ages and levels:\n\n${info.coaching_summary}${coachesBlock}\n\nTo enquire, email [b]${contactEmail}[/b]`
    : `We offer coaching for all ages and levels:\n\n🎾 Adult group lessons — [FILL IN: days/times]\n🧒 Junior coaching — [FILL IN: days/times]\n☀️ Summer camps — [FILL IN: dates]${coachesBlock}\n\nTo enquire, email [b]${contactEmail}[/b]`;

  let evtMsg = v(info.events_summary)
    ? `There's always something on at ${name}! 🏆\n\n${info.events_summary}`
    : `There's always something on at ${name}! 🏆\n\n🎾 Winter League — team competitions\n🏆 Club Championships — annual singles & doubles\n🌙 Social club nights\n\n[FILL IN: add your events and leagues]`;
  if (v(info.social_instagram) || v(info.social_twitter)) {
    evtMsg += "\n\nFollow us for the latest updates:";
    if (v(info.social_instagram)) evtMsg += `\n[link=https://instagram.com/${info.social_instagram}]📸 Instagram — @${info.social_instagram}[/link]`;
    if (v(info.social_twitter))   evtMsg += `\n[link=https://twitter.com/${info.social_twitter}]🐦 Twitter — @${info.social_twitter}[/link]`;
  }

  const locLines = [
    `📍 ${name}`,
    v(info.address) || "[FILL IN: address]",
    v(info.eircode) ? `Eircode: ${info.eircode}` : null,
    "",
    v(info.email) ? `📧 [b]${info.email}[/b]` : "📧 [FILL IN: email]",
    v(info.phone) ? `📞 ${info.phone}` : null,
  ].filter(l => l !== null).join("\n");

  // Insert flows
  const { error: fErr } = await supabase.from("chat_workflows").insert([
    { id: fMain,  club_id: tenantId, name: "Main Menu",        is_active: true  }, // auto-activate entry point
    { id: fMemb,  club_id: tenantId, name: "Membership",       is_active: false },
    { id: fCoach, club_id: tenantId, name: "Coaching & Camps", is_active: false },
    { id: fBook,  club_id: tenantId, name: "Book a Court",     is_active: false },
    { id: fEvt,   club_id: tenantId, name: "Events & Leagues", is_active: false },
    { id: fLoc,   club_id: tenantId, name: "Find Us",          is_active: false },
  ]);
  if (fErr) { console.error("[tennis-seed] Flow insert error:", fErr.message); return false; }

  // Insert steps
  const { error: sErr } = await supabase.from("workflow_steps").insert([
    { id: sMain,  workflow_id: fMain,  step_order: 1, bot_message: `What can I help you with today?` },
    { id: sMemb1, workflow_id: fMemb,  step_order: 1, bot_message: `Great — we have membership options for all ages and levels.\n\nAre you looking to join as an adult, a junior, or a family?` },
    { id: sMemb2, workflow_id: fMemb,  step_order: 2, bot_message: memb2Msg },
    { id: sCoach, workflow_id: fCoach, step_order: 1, bot_message: coachMsg },
    { id: sBook,  workflow_id: fBook,  step_order: 1, bot_message: `Our courts are available to all members, with lighting for evening play.\n\n📱 Book online:\n[link=${bookingUrl}]${bookingUrl.replace(/https?:\/\/(www\.)?/, "")}[/link]\n\nNeed help? Email [b]${contactEmail}[/b]` },
    { id: sEvt,   workflow_id: fEvt,   step_order: 1, bot_message: evtMsg },
    { id: sLoc,   workflow_id: fLoc,   step_order: 1, bot_message: locLines },
  ]);
  if (sErr) { console.error("[tennis-seed] Step insert error:", sErr.message); return false; }

  // Insert choices
  const { error: cErr } = await supabase.from("workflow_choices").insert([
    // Main menu
    { step_id: sMain, choice_order: 1, label: "🎾 Membership",       action_type: "switch_flow", action_value: fMemb  },
    { step_id: sMain, choice_order: 2, label: "🏫 Coaching & camps", action_type: "switch_flow", action_value: fCoach },
    { step_id: sMain, choice_order: 3, label: "📅 Book a court",     action_type: "switch_flow", action_value: fBook  },
    { step_id: sMain, choice_order: 4, label: "🏆 Events & leagues", action_type: "switch_flow", action_value: fEvt   },
    { step_id: sMain, choice_order: 5, label: "📍 Find us",          action_type: "switch_flow", action_value: fLoc   },
    { step_id: sMain, choice_order: 6, label: "💬 Something else",   action_type: "ai_fallback",  action_value: null   },
    // Membership step 1
    { step_id: sMemb1, choice_order: 1, label: "Adult",            action_type: "next_step",   action_value: "2" },
    { step_id: sMemb1, choice_order: 2, label: "Family",           action_type: "next_step",   action_value: "2" },
    { step_id: sMemb1, choice_order: 3, label: "Junior / Student", action_type: "next_step",   action_value: "2" },
    // Membership step 2
    { step_id: sMemb2, choice_order: 1, label: "✅ I'd like to join", action_type: "url",         action_value: membershipUrl },
    { step_id: sMemb2, choice_order: 2, label: "← Back to menu",     action_type: "switch_flow", action_value: fMain         },
    // Coaching
    { step_id: sCoach, choice_order: 1, label: "✅ I'd like to book", action_type: "ai_fallback", action_value: null  },
    { step_id: sCoach, choice_order: 2, label: "← Back to menu",     action_type: "switch_flow", action_value: fMain },
    // Booking
    { step_id: sBook, choice_order: 1, label: "📅 Book now",         action_type: "url",         action_value: bookingUrl },
    { step_id: sBook, choice_order: 2, label: "💬 I have a question",action_type: "ai_fallback", action_value: null       },
    { step_id: sBook, choice_order: 3, label: "← Back to menu",     action_type: "switch_flow", action_value: fMain      },
    // Events
    { step_id: sEvt, choice_order: 1, label: "🎾 I'd like to enter", action_type: "ai_fallback", action_value: null  },
    { step_id: sEvt, choice_order: 2, label: "← Back to menu",       action_type: "switch_flow", action_value: fMain },
    // Find Us
    { step_id: sLoc, choice_order: 1, label: "← Back to main menu", action_type: "switch_flow", action_value: fMain },
  ]);
  if (cErr) { console.error("[tennis-seed] Choice insert error:", cErr.message); return false; }

  console.log(`[tennis-seed] ✅ Seeded 6 tennis club flows for ${tenantId} (${name})`);
  return true;
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
    description:    "Accept payments and manage subscriptions",
    business_types: null,
    coming_soon:    true,
    fields:         []
  },
  {
    provider:       "mailchimp",
    name:           "Mailchimp",
    logo_html:      '<div style="width:56px;height:56px;border-radius:12px;background:#FFE01B;display:flex;align-items:center;justify-content:center;font-size:30px;margin:0 auto;">🐒</div>',
    description:    "Email marketing and newsletters",
    business_types: null,
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
      const code = String(Math.floor(100000 + Math.random() * 900000));
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
function chunkText(text, chunkWords = 500, overlapWords = 50) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  if (words.length === 0) return chunks;

  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkWords, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start += chunkWords - overlapWords;
  }
  return chunks;
}

// ── Generate embeddings and store in knowledge_chunks ─────────────────────
async function generateAndStoreChunks(documentId, text, lender, documentType, effectiveDate, tenantId = "aom") {
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    console.log(`[embeddings] No text to embed for document ${documentId} — skipping`);
    return;
  }

  console.log(`[embeddings] Generating embeddings for ${chunks.length} chunk(s) — document ${documentId} (tenant: ${tenantId})`);

  // Single batched API call for all chunks
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: chunks
  });

  const rows = embeddingResponse.data.map((item, i) => ({
    document_id:   documentId,
    chunk_index:   i,
    chunk_text:    chunks[i],
    embedding:     item.embedding,
    lender,
    document_type: documentType,
    effective_date: effectiveDate ? `${effectiveDate}-01` : null,
    tenant_id:     tenantId
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
      created_at:      entry.timestamp      || new Date()
    }).then(() => {}).catch(() => {}); // fire-and-forget — never block the chat response
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
          content: `You are Maeve, a helpful AI assistant for ${orgName}${descClause}. The user is already on the ${orgName} website or chat — never ask them which club or organisation they mean, it is always ${orgName}. Answer the user's question in a friendly, concise way (1-3 sentences). If you don't have that specific information, say so clearly and suggest they contact ${orgName} directly — never guess, invent details, or use placeholder text like "[insert X here]". Do not mention mortgages, brokers, or financial products unless they are relevant to this business.`
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

async function findRelevantKnowledgeChunks(message, matchCount = 5, tenantId = "aom") {
  try {
    // 1. Embed the query
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: message
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // 2. Vector similarity search
    const { data: chunks, error } = await supabase.rpc("match_chunks", {
      query_embedding: queryEmbedding,
      match_count: matchCount,
      filter_lender: null,
      filter_document_type: null,
      p_tenant_id: tenantId
    });

    if (error) {
      console.error("[vector search] match_chunks error:", error);
      return [];
    }

    if (!chunks || chunks.length === 0) return [];

    // 3. Return in the shape callers expect: { filename, text }
    return chunks.map(chunk => ({
      filename: chunk.lender
        ? `${chunk.lender} — ${chunk.document_type}`
        : (chunk.document_type || "Knowledge Base"),
      text: chunk.chunk_text,
      similarity: chunk.similarity
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
  return html
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

  // 3. <link rel="icon"> — last resort, often only a tiny 16px favicon
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
  "/events", "/leagues", "/news", "/location", "/find-us"
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
          headers: { "Accept": "text/plain" },
          signal: AbortSignal.timeout(15000)
        });
        if (jinaRes.ok) xml = await jinaRes.text();
      } catch {}
    }

    // Handle sitemap index (points to child sitemaps)
    const childSitemaps = [...xml.matchAll(/<loc>\s*(https?:\/\/[^<]+sitemap[^<]*\.xml)\s*<\/loc>/gi)].map(m => m[1]);
    if (childSitemaps.length > 0) {
      for (const childUrl of childSitemaps) {
        try {
          const childRes = await fetch(childUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
            signal: AbortSignal.timeout(8000)
          });
          if (!childRes.ok) continue;
          const childXml = await childRes.text();
          urls.push(...parseSitemapXml(childXml));
        } catch {}
      }
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
];

function isCrawlNoise(url) {
  try {
    const path = new URL(url).pathname;
    return CRAWL_NOISE_PATTERNS.some(re => re.test(path));
  } catch (e) { return false; }
}

async function crawlWebsite(rootUrl, maxPages = 40) {
  const visited = new Set();
  const root    = rootUrl.replace(/\/$/, "");

  // Seed queue from sitemap if available — catches Wix & other JS-nav sites
  const sitemapUrls = await fetchSitemapUrls(root);
  let allUrls = sitemapUrls.length > 0
    ? sitemapUrls.filter(u => u.startsWith(root) || u.replace(/^https?:\/\/www\./, "https://").startsWith(root.replace(/^https?:\/\/www\./, "https://")))
    : [root];

  // Always include root
  if (!allUrls.includes(root)) allUrls.unshift(root);

  // Probe common paths — catches contact/about/membership pages that only appear
  // in JS-rendered nav menus and are therefore invisible to link extraction.
  // Pages that don't exist will 404 and be silently skipped by the crawler.
  if (sitemapUrls.length === 0) {
    // Only probe when sitemap gave us nothing — avoids redundant fetches on Wix/Squarespace
    for (const p of PROBE_PATHS) {
      const probeUrl = root + p;
      if (!allUrls.includes(probeUrl)) allUrls.push(probeUrl);
    }
  }

  // Priority pages first, noise pages only if budget allows
  const priorityUrls = allUrls.filter(u => !isCrawlNoise(u));
  const noiseUrls    = allUrls.filter(u => isCrawlNoise(u));
  const queue = [...priorityUrls, ...noiseUrls];

  console.log(`[crawler] Queue: ${allUrls.length} total URLs (${priorityUrls.length} priority, ${noiseUrls.length} noise) — cap: ${maxPages} pages`);

  const pages   = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      console.log(`[crawler] Fetching: ${url}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) { console.log(`[crawler] Skip ${url}: HTTP ${response.status}`); continue; }
      const ct = response.headers.get("content-type") || "";
      if (!ct.includes("text/html")) { console.log(`[crawler] Skip ${url}: content-type "${ct}"`); continue; }

      const html  = await response.text();
      const title = extractPageTitle(html);
      const text  = extractTextFromHtml(html);

      // Detect bot-protection / JS-gated pages — either too short OR containing
      // known challenge phrases (Cloudflare "One moment", etc.)
      const BOT_PROTECTION_PHRASES = [
        "one moment, please",
        "please wait while your request is being verified",
        "checking your browser",
        "enable javascript and cookies",
        "ddos protection by cloudflare",
        "ray id:",
        "cf-browser-verification"
      ];
      const textLower = text.toLowerCase();
      const isBotProtected = BOT_PROTECTION_PHRASES.some(p => textLower.includes(p));

      if (text.length < 80 || isBotProtected) {
        const reason = isBotProtected ? "bot-protection page detected" : "text too short";
        // Fallback: use Jina Reader to bypass JS rendering and bot-protection pages
        let jinaText = null;
        try {
          console.log(`[crawler] ${reason} — trying Jina Reader for ${url}`);
          const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
            headers: { "Accept": "text/plain", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
            signal: AbortSignal.timeout(20000)
          });
          if (jinaRes.ok) {
            const raw = (await jinaRes.text()).trim();
            if (raw.length >= 80) jinaText = raw;
          }
        } catch (jinaErr) {
          console.log(`[crawler] Jina Reader failed for ${url}: ${jinaErr.message}`);
        }
        if (jinaText) {
          console.log(`[crawler] Jina Reader: imported ${url} (${jinaText.length} chars)`);
          pages.push({ url, title, text: jinaText });
          // Extract links from both the original HTML and the Jina markdown.
          // When HTML is a bot-protection page, extractInternalLinks finds nothing —
          // extractLinksFromJinaText catches the real navigation links instead.
          const htmlLinks  = extractInternalLinks(html, url);
          const jinaLinks  = extractLinksFromJinaText(jinaText, url);
          const allLinks   = [...new Set([...htmlLinks, ...jinaLinks])];
          for (const link of allLinks) {
            if (!visited.has(link) && !queue.includes(link)) queue.push(link);
          }
          console.log(`[crawler] Jina link discovery: ${htmlLinks.length} from HTML, ${jinaLinks.length} from Jina text`);
        } else {
          console.log(`[crawler] Skip ${url}: ${reason}, Jina also failed (${text.length} chars)`);
        }
        continue;
      } // skip bot-protected / near-empty pages

      pages.push({ url, title, text });

      const links = extractInternalLinks(html, url);
      for (const link of links) {
        if (!visited.has(link) && !queue.includes(link)) queue.push(link);
      }
    } catch (err) {
      console.error(`[crawler] Error fetching ${url}:`, err.message);
    }
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
    const pages = await crawlWebsite(rootUrl, 40);
    console.log(`[import-website] Crawled ${pages.length} pages`);

    let imported = 0;
    const errors = [];

    for (const page of pages) {
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

        await generateAndStoreChunks(doc.id, page.text, null, "Website Content", null, "aom");
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

app.post("/api/signup", async (req, res) => {
  const { name, email } = req.body;
  // Normalize website URL: add https:// if no protocol is present
  let website = (req.body.website || "").trim() || null;
  if (website && !/^https?:\/\//i.test(website)) {
    website = "https://" + website;
  }

  if (!name || !email) {
    return res.status(400).json({ error: "Business name and email are required" });
  }

  // Generate URL-safe tenant slug from business name
  const tenantId = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);

  if (!tenantId) {
    return res.status(400).json({ error: "Could not generate a valid tenant ID from the business name" });
  }

  // Check for duplicate
  const { data: existing } = await supabase
    .from("tenants")
    .select("id")
    .eq("id", tenantId)
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ error: "A business with a similar name already exists. Please contact us." });
  }

  // Create tenant record
  const { error: tenantError } = await supabase
    .from("tenants")
    .insert({ id: tenantId, name, email, website: website || null, plan: "trial", business_mode: "general" });

  if (tenantError) {
    console.error("[signup] Tenant insert error:", tenantError);
    return res.status(500).json({ error: "Failed to create account. Please try again." });
  }

  console.log(`[signup] Created tenant: ${tenantId} (${name})`);

  // Generate a portal password and store it
  const portalPassword = crypto.randomBytes(5).toString("hex"); // 10-char e.g. "a3f9b2c1d4"
  await supabase.from("tenants").update({ portal_password: portalPassword }).eq("id", tenantId);

  // Auto-login: embed tenant data in a signed cookie (survives server restarts)
  const signupToken = createTenantToken({ tenantId, tenantName: name, email, website: website || null });
  res.cookie("tenant_session", signupToken, {
    httpOnly: true,
    secure:   true,   // required for HTTPS (Render) — without this Chrome discards the cookie
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  // Respond immediately — don't make the user wait for the crawl
  res.json({ success: true, tenantId });

  // ── Fire-and-forget: crawl website + store chunks + send email ────────────
  (async () => {
    try {
      let imported = 0;

      if (website) {
        console.log(`[signup] Starting background crawl for ${tenantId}: ${website}`);

        // Extract logo from homepage before full crawl
        try {
          let logoUrl = null;

          // Step 1: try fetching the homepage and extracting logo from HTML
          try {
            const homepageRes = await fetch(website, {
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
              signal: AbortSignal.timeout(8000)
            });
            if (homepageRes.ok) {
              const homepageHtml = await homepageRes.text();
              logoUrl = extractFaviconUrl(homepageHtml, website);
              if (logoUrl) console.log(`[signup] Logo found in HTML for ${tenantId}: ${logoUrl}`);

              // Extract brand colour from <meta name="theme-color">
              try {
                const tcMatch = homepageHtml.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{3,8})["']/i)
                             || homepageHtml.match(/<meta[^>]+content=["'](#[0-9a-fA-F]{3,8})["'][^>]+name=["']theme-color["']/i);
                if (tcMatch) {
                  await supabase.from("tenants").update({ brand_color: tcMatch[1] }).eq("id", tenantId);
                  console.log(`[signup] Brand colour stored for ${tenantId}: ${tcMatch[1]}`);
                }
              } catch (colorErr) {
                console.log(`[signup] Brand colour extraction failed: ${colorErr.message}`);
              }

              // Generate AI business description from homepage text
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
                      {
                        role: "system",
                        content: "Write a concise one-sentence description of what this business does in 10-20 words. Start with a lowercase letter, no company name, no full stop. Example: 'a tennis club in Cork offering memberships, coaching sessions, and court bookings'"
                      },
                      {
                        role: "user",
                        content: `Business name: ${name}\nWebsite text:\n${pageText}`
                      }
                    ],
                    temperature: 0.3,
                    max_tokens: 60
                  });
                  const desc = (descResp.choices[0].message.content || "").trim().replace(/\.$/, "").replace(/^["']|["']$/g, "");
                  if (desc) {
                    await supabase.from("tenants").update({ business_description: desc }).eq("id", tenantId);
                    console.log(`[signup] Business description stored for ${tenantId}: ${desc}`);
                  }
                }
              } catch (descErr) {
                console.log(`[signup] Business description extraction failed: ${descErr.message}`);
              }
            }
          } catch (fetchErr) {
            console.log(`[signup] Homepage fetch failed for ${tenantId} (${fetchErr.message}) — will try Clearbit`);
          }

          // Step 2: fallback to Clearbit Logo API if homepage blocked or returned no logo
          if (!logoUrl) {
            try {
              const domain = new URL(website).hostname.replace(/^www\./, "");
              const clearbitUrl = `https://logo.clearbit.com/${domain}`;
              const clearbitRes = await fetch(clearbitUrl, { signal: AbortSignal.timeout(6000) });
              if (clearbitRes.ok && (clearbitRes.headers.get("content-type") || "").startsWith("image/")) {
                logoUrl = clearbitUrl;
                console.log(`[signup] Logo found via Clearbit for ${tenantId}: ${logoUrl}`);
              }
            } catch (clearbitErr) {
              console.log(`[signup] Clearbit logo lookup failed for ${tenantId}: ${clearbitErr.message}`);
            }
          }

          if (logoUrl) {
            await supabase.from("tenants").update({ logo_url: logoUrl }).eq("id", tenantId);
            console.log(`[signup] Stored logo for ${tenantId}: ${logoUrl}`);
          } else {
            console.log(`[signup] No logo found for ${tenantId} — chat will use default Sprimal icon`);
          }
        } catch (err) {
          console.error(`[signup] Logo extraction error for ${tenantId}:`, err.message);
        }

        const pages = await crawlWebsite(website, 40);
        console.log(`[signup] Crawled ${pages.length} pages for ${tenantId}`);

        for (const page of pages) {
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
                tenant_id:         tenantId
              })
              .select()
              .single();

            if (insertError) {
              console.error(`[signup] Doc insert error for ${tenantId}:`, insertError.message);
              continue;
            }

            await generateAndStoreChunks(doc.id, page.text, null, "Website Content", null, tenantId);
            imported++;
          } catch (err) {
            console.error(`[signup] Page import error for ${tenantId}:`, err.message);
          }
        }

        console.log(`[signup] Imported ${imported} pages for ${tenantId}`);

        // ── Detect business type + auto-seed template flows ──────────────────
        try {
          const allText   = pages.map(p => p.text).join(" ").slice(0, 2000);
          const { data: td } = await supabase.from("tenants").select("business_description").eq("id", tenantId).single();
          const bizDesc   = td?.business_description || "";
          const bizType   = await detectBusinessType(name, bizDesc, allText);
          await supabase.from("tenants").update({ business_type: bizType }).eq("id", tenantId);
          console.log(`[signup] Business type: ${bizType} for ${tenantId}`);

          if (bizType === "tennis_club") {
            const info    = await extractTennisClubInfo(pages, website);
            await seedTennisClubFlows(tenantId, name, website, info);
          }
        } catch (seedErr) {
          console.error(`[signup] Flow seed error for ${tenantId}:`, seedErr.message);
        }
      }

      // Send welcome email via Resend
      if (process.env.RESEND_API_KEY) {
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
            html: buildWelcomeEmailHtml({ name, email, portalPassword, website, imported, tenantId })
          })
        }).catch(err => console.error("[signup] Email send error:", err.message));

        console.log(`[signup] Welcome email sent to ${email}`);
      }
    } catch (err) {
      console.error(`[signup] Background task error for ${tenantId}:`, err.message);
    }
  })();
});

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
            <td style="padding-left:12px;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#374151;margin:0;line-height:1.5;"><strong>Log in</strong> at <a href="https://app.sprimal.com/portal" style="color:#1e40af;">app.sprimal.com/portal</a> using the credentials below.</p></td>
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
              <tr><td style="padding-bottom:7px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#374151;"><strong>Email:</strong>&nbsp;&nbsp;${email}</td></tr>
              <tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#374151;"><strong>Password:</strong>&nbsp;&nbsp;${portalPassword}</td></tr>
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

function createTenantToken(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
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

function requireTenant(req, res, next) {
  const session = getTenantSession(req);
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
  const session = getTenantSession(req);
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

    res.cookie("tenant_session", juniorToken, {
      httpOnly: true,
      secure:   true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
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

  res.cookie("tenant_session", loginToken, {
    httpOnly: true,
    secure:   true,   // required for HTTPS (Render)
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

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
    const code = String(Math.floor(100000 + Math.random() * 900000));
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
        res.clearCookie("tenant_session");
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
        .select("created_at")
        .eq("id", tid)
        .maybeSingle()
    ]);

    const tenantCreatedAt = tenantMeta?.created_at || null;
    const docListHtml = buildDocListHtml(docs || [], tid, req.tenant.website || null, tenantCreatedAt);

    // Chat logs are lazy-loaded via /api/portal/chat-logs when the section is opened,
    // preventing large HTML blobs from being embedded in the page and freezing the browser.
    const chatLogsHtml = "";

    // Auto-refresh every 8 s only while a crawl is genuinely in progress:
    // website set + no docs yet + tenant created within the last 10 minutes
    const tenantAgeMs = tenantCreatedAt ? (Date.now() - new Date(tenantCreatedAt).getTime()) : Infinity;
    const crawlInProgress = (!docs || docs.length === 0) && req.tenant.website && tenantAgeMs < 10 * 60 * 1000;
    const autoRefresh = crawlInProgress
      ? '<meta http-equiv="refresh" content="8">'
      : '';

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
      .replace("MORTGAGE_APPS_JSON_PLACEHOLDER", mortgageAppsScript);

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.send(html);
  } catch (err) {
    console.error("[portal-dashboard] Failed to render:", err.message);
    res.redirect("/portal");
  }
});

function buildDocListHtml(docs, tid, tenantWebsite, tenantCreatedAt) {
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
      return '<div style="margin-top:24px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:20px 24px;">'
        + '<div style="font-size:14px;font-weight:700;color:#92400e;margin-bottom:6px;">&#9203; Setting up your assistant&hellip;</div>'
        + '<div style="font-size:13px;color:#a16207;line-height:1.6;">We\'re crawling your website and building your knowledge base. This takes 2&ndash;3 minutes.<br>This page refreshes automatically &mdash; no need to do anything.</div>'
        + '<div style="margin-top:12px;height:4px;background:#fde68a;border-radius:2px;overflow:hidden;">'
        + '<div style="height:100%;width:40%;background:#f59e0b;border-radius:2px;animation:prog 2s ease-in-out infinite alternate;"></div></div>'
        + '</div>'
        + '<style>@keyframes prog{from{width:20%}to{width:80%}}</style>';
    }

    // Case 3: Website URL exists but tenant is older than 10 minutes with no docs — crawl stalled or failed
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

  // Uploaded documents
  if (uploaded.length) {
    html += '<div class="section-label" style="margin-top:' + (domains.length ? "24px" : "0") + '">Uploaded Documents</div>';
    html += uploaded.map(doc => {
      const ext = (doc.original_filename || "").split(".").pop().toLowerCase();
      const badge = ext === "pdf"  ? '<span class="doc-type-badge badge-pdf">PDF</span>'
                  : ext === "docx" ? '<span class="doc-type-badge badge-docx">DOCX</span>'
                  : '<span class="doc-type-badge badge-txt">TXT</span>';
      const date = doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString("en-IE", { day:"numeric", month:"short", year:"numeric" }) : "";
      return '<div class="doc-row" id="doc-' + esc(doc.id) + '">'
        + badge
        + '<div class="doc-info"><div class="doc-name">' + esc(doc.original_filename || "Untitled") + '</div>'
        + '<div class="doc-meta">Uploaded ' + date + '</div></div>'
        + '<button class="btn-delete" onclick="portalDeleteDoc(\'' + esc(doc.id) + '\',\'' + esc(doc.original_filename||"") + '\')">Delete</button>'
        + '</div>';
    }).join("");
  }

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
  res.clearCookie("tenant_session");
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
  const { data, error } = await supabase
    .from("documents")
    .select("id, original_filename, stored_filename, mimetype, document_type, uploaded_at")
    .eq("tenant_id", req.tenant.tenantId)
    .order("uploaded_at", { ascending: false });

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

      // Build structured filename: "Document Type - Description.ext"
      const description    = (req.body.description    || "").trim();
      const document_type  = (req.body.document_type  || "Other").trim();
      const effective_date = (req.body.effective_date || null) || null;
      const expiry_date    = (req.body.expiry_date    || null) || null;
      const tagsRaw        = (req.body.tags            || "").trim();
      const juniorAccess   = req.body.junior_accessible !== "false";
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
          metadata_complete: true,
          junior_accessible: juniorAccess,
          tenant_id:         tenantId
        })
        .select()
        .single();

      fs.unlink(req.file.path, () => {});

      if (docError) {
        console.error("[portal-upload] Doc insert error:", docError);
        return res.status(500).json({ error: "Failed to save document record." });
      }

      await generateAndStoreChunks(doc.id, extractedText, null, document_type, null, tenantId);

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

    await generateAndStoreChunks(doc.id, text.trim(), null, "Pasted Knowledge", null, tenantId);
    res.json({ success: true, document: { id: doc.id, name: doc.original_filename } });
  } catch (err) {
    console.error("[portal-paste] Error:", err.message);
    res.status(500).json({ error: "Failed to save knowledge" });
  }
});

// POST /api/portal/import-website — crawl a website URL for this tenant (senior only)
app.post("/api/portal/import-website", requireSeniorTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  // Normalize: add https:// if no protocol present
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  let rootUrl;
  try { rootUrl = new URL(url).href.replace(/\/$/, ""); }
  catch { return res.status(400).json({ error: "Invalid URL" }); }

  // Respond immediately — crawl runs in background
  res.json({ success: true, message: "Import started — this takes 2–3 minutes." });

  (async () => {
    try {
      console.log(`[portal-import] Starting crawl for ${tenantId}: ${rootUrl}`);
      const pages = await crawlWebsite(rootUrl, 40);
      console.log(`[portal-import] Crawled ${pages.length} pages for ${tenantId}`);
      let imported = 0;
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
          if (insertError) { console.error(`[portal-import] Insert error:`, insertError.message); continue; }
          await generateAndStoreChunks(doc.id, page.text, null, "Website Content", null, tenantId);
          imported++;
        } catch (err) {
          console.error(`[portal-import] Page error:`, err.message);
        }
      }
      console.log(`[portal-import] Done — imported ${imported} pages for ${tenantId}`);
    } catch (err) {
      console.error(`[portal-import] Crawl failed for ${tenantId}:`, err.message);
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

  return { todayCount, totalConversations: convs.length, avgMessages, trend, topTopics };
}

// ── Portal: analytics ─────────────────────────────────────────────────────────
app.get("/api/portal/analytics", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const since = new Date(); since.setDate(since.getDate() - 30);

    const { data: rows, error } = await supabase
      .from("chat_logs")
      .select("id, conversation_id, sender, message, created_at")
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

// ── Admin: list all tenants ───────────────────────────────────────────────────
app.get("/api/admin/tenants", requireAdmin, async (req, res) => {
  try {
    const [{ data: tenants, error }, { data: docCounts }, { data: chunkCounts }] = await Promise.all([
      supabase
        .from("tenants")
        .select("id, name, email, website, status, portal_password, created_at")
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
      supabase.from("portal_users").delete().eq("tenant_id", id),
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

// ── Portal: recent chat logs ──────────────────────────────────────────────────
app.get("/api/portal/chat-logs", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;

    // Fetch last 100 messages for this tenant, newest first
    const { data, error } = await supabase
      .from("chat_logs")
      .select("id, conversation_id, sender, message, created_at")
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
    const relevantDocs = await findRelevantKnowledgeChunks(question, 5, tenantId);
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

    if (bizType !== "tennis_club") {
      return res.status(400).json({ error: `Business type is '${bizType}' — only tennis_club is supported for auto-seeding right now.` });
    }

    // Crawl site — used for both flow seeding and knowledge base refresh
    const pages = await crawlWebsite(website, 12);
    const info  = await extractTennisClubInfo(pages, website);
    const seeded = await seedTennisClubFlows(tenantId, tenant.name, website, info);

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
          await generateAndStoreChunks(doc.id, page.text, null, "Website Content", null, tenantId);
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
    .select("ai_enabled, train_staff_enabled, business_description")
    .eq("id", req.tenant.tenantId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: "Failed to fetch settings" });
  res.json({
    ai_enabled:            data?.ai_enabled           ?? true,
    train_staff_enabled:   data?.train_staff_enabled  ?? false,
    business_description:  data?.business_description ?? ""
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
// ── Public tenant config — widget fetches this on load ───────────────────────
app.get("/api/tenant-config/:tenantId", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  const { tenantId } = req.params;

  const { data, error } = await supabase
    .from("tenants")
    .select("id, name, logo_url, website, brand_color")
    .eq("id", tenantId)
    .maybeSingle();

  if (error || !data) {
    return res.json({ id: tenantId, name: null, logo_url: null, brand_color: null });
  }

  res.json({ id: data.id, name: data.name, logo_url: data.logo_url || null, brand_color: data.brand_color || null });
});

// ── Favicon proxy — serves tenant logo through our own domain ─────────────────
// Avoids hotlinking blocks and CORS issues entirely.
const faviconCache = new Map(); // tenantId → { buffer, contentType, ts }

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

  let imgUrl = data.logo_url || null;
  if (!imgUrl && data.website) {
    try {
      const domain = new URL(data.website).hostname.replace(/^www\./, "");
      imgUrl = `https://icons.duckduckgo.com/ip3/${domain}.ico`;
    } catch {}
  }

  if (!imgUrl) return res.status(404).end();

  try {
    const imgRes = await fetch(imgUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(6000)
    });
    if (!imgRes.ok) return res.status(404).end();

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get("content-type") || "image/png";

    faviconCache.set(tenantId, { buffer, contentType, ts: Date.now() });
    res.setHeader("Content-Type", contentType);
    res.send(buffer);
  } catch (err) {
    console.error(`[favicon-proxy] Error for ${tenantId}:`, err.message);
    res.status(404).end();
  }
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
  const eboUrl = eboCfg ? `https://ebookingonline.net/box/${eboCfg.clubId}` : null;

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

  const waBody = [
    `🎾 *New ${agentName}*`,
    `Hi ${coachName || "Coach"}! A new enquiry came in via the club website:\n`,
    generalLines,
    slotsSection,
    `_Sent by ${clubName}_`
  ].filter(Boolean).join("\n");

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

  // ── Fetch tenant branding for email footer ───────────────────────
  let clubName    = agentName;
  let clubWebsite = null;
  try {
    const { data: tenantRow } = await supabase.from("tenants").select("name, website").eq("id", tenantId).maybeSingle();
    if (tenantRow) { clubName = tenantRow.name || clubName; clubWebsite = tenantRow.website || null; }
  } catch (_) {}

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

app.post("/chat", async (req, res) => {
  try {
    const { userId, conversationId, message, voiceMode, clubId, workflowContext, agentTrigger } = req.body;
    const tenantId = clubId || "aom";

    // ── Look up this tenant's business mode, name and feature flags ──────────
    let effectiveMode = businessMode; // global default ('mortgage')
    let tenantDisplayName = null;
    let tenantBusinessDesc = null;
    try {
      const { data: tenantData } = await supabase
        .from("tenants")
        .select("business_mode, name, ai_enabled, business_description")
        .eq("id", tenantId)
        .maybeSingle();
      if (tenantData?.business_mode) effectiveMode = tenantData.business_mode;
      if (tenantData?.name) tenantDisplayName = tenantData.name;
      else tenantDisplayName = tenantId.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      if (tenantData?.business_description) tenantBusinessDesc = tenantData.business_description;
      // Respect AI Receptionist on/off toggle (null/undefined = enabled by default)
      if (tenantData?.ai_enabled === false) {
        return res.json({ reply: "The AI assistant is currently unavailable. Please contact us directly." });
      }
    } catch {}

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
  const relevantDocs = await findRelevantKnowledgeChunks(trimmedMessage, 5, tenantId);

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
      } else {
        // KB couldn’t answer — fall through to Maeve’s general reply
        const maeveReply = await generateMaeveReply(trimmedMessage);
        result.reply = maeveReply || "No problem at all — I can help with mortgages, bookings, or any questions. What would you like to do?";
      }

    } catch (err) {
      console.error("Knowledge base OpenAI error:", err.message);
      result.reply = "Sorry — I couldn’t access the knowledge base.";
    }

  } else {
    // No KB docs — use Maeve’s general conversational reply
    const maeveReply = await generateMaeveReply(trimmedMessage);
    result.reply =
      maeveReply ||
      "No problem at all — I can help with mortgages, consultations, or documents. What are you looking to do?";
  }
}

    } else if (effectiveMode === "general") {

      // ── EBO personal booking auth flow (takes priority over KB/availability) ─
      const eboPersonal = await handleEboPersonalFlow(convo, trimmedMessage, tenantId, tenantDisplayName || "club");
      if (eboPersonal.handled) {
        result.reply = eboPersonal.reply;
      } else {

      // ── KB search + optional live EBO court availability (in parallel) ────────
      const [relevantDocs, eboContext] = await Promise.all([
        findRelevantKnowledgeChunks(trimmedMessage, 8, tenantId),
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
          const sysPrompt = eboContext
            ? "You are Maeve, a helpful AI assistant for " + _org + _descBit + ". For court availability or booking questions, use the LIVE COURT BOOKINGS data to give accurate, up-to-date information. For all other questions use the KNOWLEDGE BASE or WHAT THE ASSISTANT JUST SHOWED THE USER. Keep answers friendly and concise. Never invent or guess information not present in the data — if you don't have it, say so clearly."
            : "You are Maeve, a helpful AI assistant for " + _org + _descBit + ". Answer using the provided context — prioritise WHAT THE ASSISTANT JUST SHOWED THE USER for follow-up questions, then the KNOWLEDGE BASE. If the answer is not in the context, say so clearly — for example: 'I don't have that information, please check the website or contact " + _org + " directly.' Never invent, guess, or use placeholder text like '[insert location here]'. Keep answers friendly and concise.";

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
          const kbUnsure = !eboContext && /i do not know|don't know|not in the|no information|cannot find|not sure/i.test(kbReply);

          if (!kbUnsure) {
            result.reply = kbReply;
          } else {
            const genericReply = await generateGenericReply(trimmedMessage, tenantDisplayName, tenantBusinessDesc);
            result.reply = genericReply || "I'm not sure about that — please contact us directly for more information.";
          }
        } catch (err) {
          console.error("Knowledge base OpenAI error (general mode):", err.message);
          result.reply = "Sorry — I couldn't access the knowledge base right now.";
        }
      } else if (workflowContext) {
        // No KB results but we have what was just shown — answer from that alone
        try {
          const _org = tenantDisplayName || "this organisation";
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are Maeve, a helpful AI assistant for " + _org + ". Answer the user's follow-up question using only WHAT THE ASSISTANT JUST SHOWED THE USER. Keep the answer friendly and concise." },
              { role: "user",   content: "WHAT THE ASSISTANT JUST SHOWED THE USER:\n" + workflowContext + "\n\nUser question:\n" + trimmedMessage }
            ],
            temperature: 0.2
          });
          result.reply = stripHtml(completion.choices[0].message.content);
        } catch {
          result.reply = "I'm not sure about that — please contact us directly for more information.";
        }
      } else {
        const genericReply = await generateGenericReply(trimmedMessage, tenantDisplayName, tenantBusinessDesc);
        result.reply = genericReply || "I'm not sure about that — please contact us directly for more information.";
      }

      } // end: eboPersonal not handled

    } else {
      result.reply = "Invalid business mode configuration.";
    }

    console.log("[chat] Sending reply, length:", (result.reply || "").length, "| preview:", (result.reply || "").slice(0, 60));

    addChatLog({
      userId,
      conversationId,
      tenantId,
      sender: "bot",
      message: result.reply,
      timestamp: new Date()
    });

    return res.json({ reply: result.reply });

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startEmailPolling();
  scheduleMorningDigest();
});