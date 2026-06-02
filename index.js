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

const multer = require("multer");
const upload = multer({ dest: "uploads/" });

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
// Redirect root to login so the AI receptionist is not the landing page
app.get("/", (req, res) => res.redirect("/login"));
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

async function extractPdfText(filePath) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const data = new Uint8Array(fs.readFileSync(filePath));

  const loadingTask = pdfjsLib.getDocument({ data });
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

// ── EBO (ebookingonline.net) Court Booking Integration ────────────────────────
const EBO_BASE = "https://ebookingonline.net/api";

// Map Sprimal tenant ID → EBO credentials + court schedule config
const EBO_CONFIG = {
  "monkstown-lawn-tennis-club": {
    clubId:      process.env.EBO_MONKSTOWN_CLUB_ID || "304",
    username:    process.env.EBO_MONKSTOWN_USERNAME,
    password:    process.env.EBO_MONKSTOWN_PASSWORD,
    openTime:    "08:00",  // first bookable slot start
    closeTime:   "23:00",  // courts close (last slot must end by this)
    slotMinutes: 75        // each booking slot is 75 minutes
  }
};

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

// Keywords that trigger a live EBO lookup
const EBO_TRIGGER = /\b(court|book|available|availab|free slot|session|tennis|reserve|tonight|today|tomorrow|when|slot|time|play)\b/i;

async function maybeGetEboContext(tenantId, message) {
  if (!EBO_CONFIG[tenantId] || !EBO_TRIGGER.test(message)) return null;

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

  const lines = mine.map(b => {
    const start        = b.time.slice(11, 16); // "18:00"
    const [hh, mm]     = start.split(":").map(Number);
    const endTime      = toHHMM(hh * 60 + mm + slotMins);
    return `• ${fmtDate(b.time)}, Court ${b.court_id}, ${start}–${endTime}`;
  });

  return `Here are your upcoming bookings, ${firstName}:\n\n${lines.join("\n")}\n\nTo cancel or change a booking please visit the ${clubName} booking page.`;
}

const EBO_PERSONAL_TRIGGER = /\b(my\s+bookings?|my\s+reserv|my\s+sessions?|my\s+courts?|my\s+upcoming|my\s+schedule|my\s+match|what\s+bookings?|bookings?.*do\s+i|bookings?.*i\s+have|do\s+i\s+have.*book|have\s+i.*book|i\s+have.*booked|i'?ve\s+booked|i\s+booked|courts?.*do\s+i\s+have|what.*courts?.*do\s+i|cancel.*my\s+book|show.*my\s+book|view.*my\s+book)/i;

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
}

function getSession(req) {
  const sessionId = req.cookies.admin_session;
  if (!sessionId) return null;
  return sessions.get(sessionId);
}

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
  const sessionId = req.cookies.admin_session;

  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function requireAdminPage(req, res, next) {
  const sessionId = req.cookies.admin_session;

  if (!sessionId || !sessions.has(sessionId)) {
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

    sessions.set(sessionId, { role, isTest: false });

    res.cookie("admin_session", sessionId, {
      httpOnly: true,
      sameSite: "lax"
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

async function generateGenericReply(message, tenantName) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a helpful assistant for ${tenantName || "this organisation"}. Answer the user's question in a friendly, concise way (1-3 sentences). If you don't know the answer, say so politely and suggest they contact the organisation directly. Do not mention mortgages, brokers, or financial products.`
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

// Known generic/placeholder favicons to skip
const GENERIC_FAVICON_PATTERNS = [
  "parastorage.com/client/pfavico",
  "parastorage.com/services",
  "/favicon.ico"
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

  // 2. <link rel="icon"> — skip generic platform placeholders
  const iconMatches = [...html.matchAll(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["'][^>]*>/gi)];
  for (const m of iconMatches.reverse()) {
    try {
      const url = new URL(m[1], baseUrl).href;
      if (!isGenericFavicon(url)) return url;
    } catch {}
  }

  // 3. og:image — Wix/Squarespace sites often set their club logo here
  const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogMatch) {
    try {
      const url = new URL(ogMatch[1], baseUrl).href;
      if (url.startsWith("http")) return url;
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

async function fetchSitemapUrls(rootUrl) {
  const base = rootUrl.replace(/\/$/, "");
  const urls = [];
  try {
    const res = await fetch(base + "/sitemap.xml", {
      headers: { "User-Agent": "Sprimal-Bot/1.0" },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return urls;
    const xml = await res.text();

    // Handle sitemap index (points to child sitemaps)
    const childSitemaps = [...xml.matchAll(/<loc>\s*(https?:\/\/[^<]+sitemap[^<]*\.xml)\s*<\/loc>/gi)].map(m => m[1]);
    if (childSitemaps.length > 0) {
      for (const childUrl of childSitemaps) {
        try {
          const childRes = await fetch(childUrl, {
            headers: { "User-Agent": "Sprimal-Bot/1.0" },
            signal: AbortSignal.timeout(8000)
          });
          if (!childRes.ok) continue;
          const childXml = await childRes.text();
          const childUrls = [...childXml.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)]
            .map(m => m[1].trim())
            .filter(u => !u.endsWith(".xml"));
          urls.push(...childUrls);
        } catch {}
      }
    } else {
      // Direct sitemap
      const directUrls = [...xml.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)]
        .map(m => m[1].trim())
        .filter(u => !u.endsWith(".xml"));
      urls.push(...directUrls);
    }
  } catch {}
  return urls;
}

async function crawlWebsite(rootUrl, maxPages = 100) {
  const visited = new Set();
  const root    = rootUrl.replace(/\/$/, "");

  // Seed queue from sitemap if available — catches Wix & other JS-nav sites
  const sitemapUrls = await fetchSitemapUrls(root);
  const queue = sitemapUrls.length > 0
    ? sitemapUrls.filter(u => u.startsWith(root) || u.replace(/^https?:\/\/www\./, "https://").startsWith(root.replace(/^https?:\/\/www\./, "https://")))
    : [root];

  // Always include root
  if (!queue.includes(root)) queue.unshift(root);

  console.log(`[crawler] Queue seeded with ${queue.length} URLs (sitemap: ${sitemapUrls.length > 0})`);

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
        headers: { "User-Agent": "Sprimal-Bot/1.0 (knowledge import)" },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) continue;
      const ct = response.headers.get("content-type") || "";
      if (!ct.includes("text/html")) continue;

      const html  = await response.text();
      const title = extractPageTitle(html);
      const text  = extractTextFromHtml(html);

      if (text.length < 80) continue; // skip near-empty pages

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
    const pages = await crawlWebsite(rootUrl, 100);
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

app.post("/api/signup", async (req, res) => {
  const { name, website, email } = req.body;

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

        // Extract favicon from homepage before full crawl
        try {
          const homepageRes = await fetch(website, {
            headers: { "User-Agent": "Sprimal-Bot/1.0" },
            signal: AbortSignal.timeout(8000)
          });
          if (homepageRes.ok) {
            const homepageHtml = await homepageRes.text();
            const logoUrl = extractFaviconUrl(homepageHtml, website);
            if (logoUrl) {
              await supabase.from("tenants").update({ logo_url: logoUrl }).eq("id", tenantId);
              console.log(`[signup] Stored logo for ${tenantId}: ${logoUrl}`);
            }
          }
        } catch (err) {
          console.error(`[signup] Logo extraction error for ${tenantId}:`, err.message);
        }

        const pages = await crawlWebsite(website, 100);
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
      }

      // Send embed code email via Resend
      if (process.env.RESEND_API_KEY) {
        const embedCode = `<script src="https://app.sprimal.com/widget.js" data-club-id="${tenantId}" data-club-name="${name}"></script>`;
        const websiteNote = imported > 0
          ? `<p>We've trained your assistant on <strong>${imported} pages</strong> from <strong>${website}</strong>.</p>`
          : "<p>Your assistant is ready — you can add your website content from the dashboard.</p>";

        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: "Sprimal <hello@sprimal.com>",
            to: email,
            subject: `Your Sprimal assistant is ready 🎉`,
            html: `
              <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
                <h1 style="font-size:24px;margin-bottom:8px;">Welcome to Sprimal, ${name}! 👋</h1>
                ${websiteNote}
                <p style="margin-top:20px;">Here is your embed code — paste it before the <code>&lt;/body&gt;</code> tag on your website:</p>
                <pre style="background:#f3f4f6;border-radius:8px;padding:16px;font-size:13px;overflow-x:auto;">${embedCode.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
                <div style="margin-top:24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px;">
                  <p style="font-weight:700;color:#0f172a;margin-bottom:10px;">🔐 Your portal login</p>
                  <p style="font-size:14px;color:#374151;margin-bottom:4px;"><strong>URL:</strong> <a href="https://app.sprimal.com/portal" style="color:#1e40af;">https://app.sprimal.com/portal</a></p>
                  <p style="font-size:14px;color:#374151;margin-bottom:4px;"><strong>Email:</strong> ${email}</p>
                  <p style="font-size:14px;color:#374151;"><strong>Password:</strong> ${portalPassword}</p>
                </div>
                <p style="margin-top:20px;color:#6b7280;font-size:14px;">Need help? Just reply to this email.</p>
                <p style="color:#6b7280;font-size:14px;">— The Sprimal team</p>
              </div>
            `
          })
        }).catch(err => console.error("[signup] Email send error:", err.message));

        console.log(`[signup] Embed code email sent to ${email}`);
      }
    } catch (err) {
      console.error(`[signup] Background task error for ${tenantId}:`, err.message);
    }
  })();
});

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

app.get("/portal", (req, res) => {
  if (getTenantSession(req)) return res.redirect("/portal/dashboard");
  res.sendFile(path.join(__dirname, "views", "portal-login.html"));
});

app.post("/portal/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, error: "Please enter your email and password." });

  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, name, email, website, portal_password")
    .eq("email", email.toLowerCase().trim())
    .maybeSingle();

  if (!tenant || tenant.portal_password !== password) {
    return res.json({ success: false, error: "Incorrect email or password." });
  }

  const loginToken = createTenantToken({
    tenantId:   tenant.id,
    tenantName: tenant.name || tenant.id,
    email:      tenant.email,
    website:    tenant.website
  });

  res.cookie("tenant_session", loginToken, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  res.json({ success: true });
});

// ── Public tenant chat page (QR code destination) ────────────────────────────
app.get("/chat/:tenantId", async (req, res) => {
  const tenantId = req.params.tenantId;
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, name, logo_url")
    .eq("id", tenantId)
    .maybeSingle();

  if (!tenant) return res.status(404).send("Not found");

  const name = (tenant.name || tenantId).replace(/"/g, "&quot;");
  const avatarHtml = tenant.logo_url
    ? `<img src="${tenant.logo_url}" alt="${name}" />`
    : `<svg viewBox="0 0 48 48" fill="none" style="width:100%;height:100%;"><rect width="48" height="48" rx="11" fill="#4f76f6"/><line x1="24" y1="11" x2="38.5" y2="36" stroke="white" stroke-width="3" stroke-linecap="round"/><line x1="38.5" y1="36" x2="9.5" y2="36" stroke="white" stroke-width="3" stroke-linecap="round"/><line x1="9.5" y1="36" x2="24" y2="11" stroke="white" stroke-width="3" stroke-linecap="round"/><circle cx="24" cy="11" r="4.5" fill="white"/><circle cx="38.5" cy="36" r="4.5" fill="white"/><circle cx="9.5" cy="36" r="4.5" fill="white"/></svg>`;

  const html = fs.readFileSync(path.join(__dirname, "views", "chat-tenant.html"), "utf8")
    .replace(/TENANT_ID_PLACEHOLDER/g,   tenantId)
    .replace(/TENANT_NAME_PLACEHOLDER/g, name)
    .replace("AVATAR_PLACEHOLDER",       avatarHtml);

  res.setHeader("Cache-Control", "no-store");
  res.send(html);
});

app.get("/portal/dashboard", requireTenant, async (req, res) => {
  try {
    const tid   = req.tenant.tenantId   || "";
    const tname = (req.tenant.tenantName || req.tenant.tenantId || "").replace(/"/g, "&quot;");
    const embedCode = `&lt;script src="https://app.sprimal.com/widget.js" data-club-id="${tid}" data-club-name="${tname}"&gt;&lt;/script&gt;`;

    // ── Fetch documents server-side so the list renders without JS ────────────
    const { data: docs } = await supabase
      .from("documents")
      .select("id, original_filename, stored_filename, storage_path, document_type, uploaded_at")
      .eq("tenant_id", tid)
      .order("uploaded_at", { ascending: false });

    const docListHtml = buildDocListHtml(docs || [], tid);

    // Auto-refresh every 8 s while crawl is still running (no docs yet)
    const autoRefresh = (!docs || docs.length === 0)
      ? '<meta http-equiv="refresh" content="8">'
      : '';

    const html = fs.readFileSync(path.join(__dirname, "views", "portal-dashboard.html"), "utf8")
      .replace(/TENANT_ID_PLACEHOLDER/g,   tid)
      .replace(/TENANT_NAME_PLACEHOLDER/g, tname)
      .replace(/EMBED_CODE_PLACEHOLDER/g,  embedCode)
      .replace("DOC_LIST_PLACEHOLDER",     docListHtml)
      .replace("AUTO_REFRESH_PLACEHOLDER", autoRefresh);

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.send(html);
  } catch (err) {
    console.error("[portal-dashboard] Failed to render:", err.message);
    res.redirect("/portal");
  }
});

function buildDocListHtml(docs, tid) {
  function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  const websites = docs.filter(d => d.document_type === "Website Content");
  const uploaded = docs.filter(d => d.document_type !== "Website Content");

  // Group website pages by domain
  const domainMap = {};
  websites.forEach(d => {
    try {
      const pageUrl = d.stored_filename || d.storage_path || "";
      const domain = new URL(pageUrl).hostname;
      if (!domainMap[domain]) domainMap[domain] = { domain, pages: 0, date: d.uploaded_at, sampleUrl: pageUrl };
      domainMap[domain].pages++;
    } catch(e) {}
  });

  if (!websites.length && !uploaded.length) {
    return '<div style="margin-top:24px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:20px 24px;">'
      + '<div style="font-size:14px;font-weight:700;color:#92400e;margin-bottom:6px;">&#9203; Setting up your assistant&hellip;</div>'
      + '<div style="font-size:13px;color:#a16207;line-height:1.6;">We\'re crawling your website and building your knowledge base. This takes 2&ndash;3 minutes.<br>This page refreshes automatically &mdash; no need to do anything.</div>'
      + '<div style="margin-top:12px;height:4px;background:#fde68a;border-radius:2px;overflow:hidden;">'
      + '<div style="height:100%;width:40%;background:#f59e0b;border-radius:2px;animation:prog 2s ease-in-out infinite alternate;"></div></div>'
      + '</div>'
      + '<style>@keyframes prog{from{width:20%}to{width:80%}}</style>';
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
        return res.status(400).json({ error: "Could not extract text from this file. Please check it is not empty or image-only." });
      }

      const storagePath = `tenant-docs/${tenantId}/${Date.now()}-${req.file.originalname}`;
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
          original_filename: req.file.originalname,
          stored_filename:   req.file.originalname,
          storage_path:      uploadError ? null : storagePath,
          mimetype:          req.file.mimetype,
          lender:            null,
          document_type:     "Club Document",
          description:       req.body.description || req.file.originalname,
          effective_date:    null,
          expiry_date:       null,
          tags:              ["portal-upload"],
          metadata_complete: true,
          junior_accessible: true,
          tenant_id:         tenantId
        })
        .select()
        .single();

      fs.unlink(req.file.path, () => {});

      if (docError) {
        console.error("[portal-upload] Doc insert error:", docError);
        return res.status(500).json({ error: "Failed to save document record." });
      }

      await generateAndStoreChunks(doc.id, extractedText, null, "Club Document", null, tenantId);

      res.json({ success: true, document: { id: doc.id, name: req.file.originalname } });
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

// POST /api/portal/import-website — re-crawl a website URL for this tenant
app.post("/api/portal/import-website", requireTenant, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  let rootUrl;
  try { rootUrl = new URL(url).href.replace(/\/$/, ""); }
  catch { return res.status(400).json({ error: "Invalid URL" }); }

  // Respond immediately — crawl runs in background
  res.json({ success: true, message: "Import started — this takes 2–3 minutes." });

  (async () => {
    try {
      console.log(`[portal-import] Starting crawl for ${tenantId}: ${rootUrl}`);
      const pages = await crawlWebsite(rootUrl, 100);
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

// ─────────────────────────────────────────────────────────────────────────────
// ── Public tenant config — widget fetches this on load ───────────────────────
app.get("/api/tenant-config/:tenantId", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  const { tenantId } = req.params;

  const { data, error } = await supabase
    .from("tenants")
    .select("id, name, logo_url, website")
    .eq("id", tenantId)
    .maybeSingle();

  if (error || !data) {
    return res.json({ id: tenantId, name: null, logo_url: null });
  }

  res.json({ id: data.id, name: data.name, logo_url: data.logo_url || null });
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
      headers: { "User-Agent": "Sprimal-Bot/1.0" },
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
    const { userId, conversationId, message, voiceMode, clubId } = req.body;
    const tenantId = clubId || "aom";

    // ── Look up this tenant's business mode and name ─────────────────────────
    let effectiveMode = businessMode; // global default ('mortgage')
    let tenantDisplayName = null;
    try {
      const { data: tenantData } = await supabase
        .from("tenants")
        .select("business_mode, name")
        .eq("id", tenantId)
        .maybeSingle();
      if (tenantData?.business_mode) effectiveMode = tenantData.business_mode;
      if (tenantData?.name) tenantDisplayName = tenantData.name;
    } catch {}

    // General mode tenants don't collect personal data — skip consent gate
    if (effectiveMode === "general") {
      const convo = ensureConversation(userId);
      convo.consentGiven = true;
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
        findRelevantKnowledgeChunks(trimmedMessage, 5, tenantId),
        maybeGetEboContext(tenantId, trimmedMessage)
      ]);

      // Build combined context: live EBO data first, then KB docs
      const contextParts = [];
      if (eboContext) contextParts.push(eboContext);
      if (relevantDocs.length > 0) {
        contextParts.push("KNOWLEDGE BASE:\n" + relevantDocs.map(doc => `Source: ${doc.filename}\n${doc.text}`).join("\n\n"));
      }

      if (contextParts.length > 0) {
        const context = contextParts.join("\n\n---\n\n");

        try {
          const sysPrompt = eboContext
            ? "You are a helpful assistant for " + (tenantDisplayName || "this organisation") + ". For court availability or booking questions, use the LIVE COURT BOOKINGS data to give accurate, up-to-date information. For all other questions use the KNOWLEDGE BASE. Keep answers friendly and concise."
            : "You are a helpful assistant for " + (tenantDisplayName || "this organisation") + ". Answer ONLY using the provided knowledge base context. If the answer is not clearly in the context, say you do not know. Keep answers friendly and concise.";

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
            const genericReply = await generateGenericReply(trimmedMessage, tenantDisplayName);
            result.reply = genericReply || "I'm not sure about that — please contact us directly for more information.";
          }
        } catch (err) {
          console.error("Knowledge base OpenAI error (general mode):", err.message);
          result.reply = "Sorry — I couldn't access the knowledge base right now.";
        }
      } else {
        const genericReply = await generateGenericReply(trimmedMessage, tenantDisplayName);
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
        category: category || "General"
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
        feedback: feedback || "",
        flagged_by: req.user?.role || "unknown"
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

async function runEmailResponseAgent(emailContent) {
  const messages = [
    {
      role: "system",
      content: `You are Sprimal, an AI assistant for Irish mortgage broker staff.

Your job is to draft a professional reply to a client email.

You have two tools:
- search_knowledge_base: searches lender criteria, policy docs, rates and procedures
- search_approved_answers: searches broker-pre-approved Q&A pairs

Instructions:
1. Read the email carefully and identify the specific topic(s) being asked about
2. Search for relevant information using specific targeted queries
3. You may search multiple times with different queries if needed
4. Once you have enough information, draft the reply

Rules for the draft:
- Do NOT invent lender-specific criteria not found in your searches
- Do NOT promise approval, rates, or timelines
- Do NOT give financial advice
- If searches return nothing useful, say the broker will be in touch to confirm
- Keep it concise and human — 4 to 8 lines

Style:
- Friendly and professional
- Start with "Hi there," unless a name is clear from the email
- Do NOT add a sign-off or "Kind regards" — the signature is added automatically`
    },
    {
      role: "user",
      content: `Draft a reply to this client email:\n\n${emailContent}`
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

async function processInboundEmail({ from, subject, body }) {
  console.log(`[email-poll] Processing: "${subject}" from ${from}`);

  try {
    const rawDraft = await runEmailResponseAgent(body);

    // Strip any trailing sign-off the AI added (e.g. "Kind regards,") — the real signature provides it
    const draftBody = rawDraft.trim().replace(/\n*kind regards,?\s*$/i, "").trim();
    const draft = `${draftBody}\n\n${CORMAC_SIGNATURE}`;

    const emailBody =
`A client email has arrived at cormac.sprimal@gmail.com. Here is a suggested draft reply:

═══════════════════════════════════════════
ORIGINAL EMAIL
From: ${from}
Subject: ${subject}

${body.trim()}
═══════════════════════════════════════════

SUGGESTED DRAFT REPLY:

${draft.trim()}
═══════════════════════════════════════════

Review the draft above and send it from your own email if it looks good.`;

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

    // Use the Gmail account for sending draft notifications
    const gmailTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    await gmailTransporter.sendMail({
      from: process.env.GMAIL_USER,
      to: recipients.join(", "),
      subject: `Draft reply: ${subject}`,
      text: emailBody
    });

    console.log(`[email-poll] Draft sent to ${recipients.join(", ")}`);
  } catch (err) {
    console.error(`[email-poll] processInboundEmail error for "${subject}":`, err.message);
  }
}

async function pollGmailInbox() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    },
    logger: false
  });

  // Prevent unhandled 'error' events from crashing the process
  client.on("error", (err) => {
    console.error("[email-poll] ImapFlow error event:", err.message);
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      // Search for unseen messages by UID
      const uids = await client.search({ seen: false }, { uid: true });

      if (!uids || uids.length === 0) {
        console.log("[email-poll] No new messages");
        return;
      }

      console.log(`[email-poll] ${uids.length} unseen message(s)`);

      const processedUids = [];

      for await (const msg of client.fetch(uids.join(","), { source: true, uid: true }, { uid: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const from    = parsed.from?.text || "Unknown";
          const subject = parsed.subject   || "(no subject)";
          const body    = parsed.text      || parsed.html || "";

          // Prevent loop — skip draft notification emails
          if (subject.startsWith("Draft reply:")) {
            console.log(`[email-poll] Skipping loop-guard email: "${subject}"`);
          } else {
            await processInboundEmail({ from, subject, body });
          }

          // Collect UID — we'll mark all as seen after the loop
          processedUids.push(msg.uid);
        } catch (msgErr) {
          console.error("[email-poll] Error on individual message:", msgErr.message);
        }
      }

      // Batch mark all processed messages as read
      if (processedUids.length > 0) {
        await client.messageFlagsAdd(processedUids.join(","), ["\\Seen"], { uid: true });
        console.log(`[email-poll] Marked ${processedUids.length} message(s) as read`);
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error("[email-poll] IMAP connection error:", err.message);
  } finally {
    // Always close the connection — prevents socket leaks that cause ETIMEOUT crashes
    try { await client.logout(); } catch (_) {}
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startEmailPolling();
});