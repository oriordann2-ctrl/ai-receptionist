const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
dotenv.config();

const { OpenAI } = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY2 });

const multer = require("multer");
const upload = multer({ dest: "uploads/" });

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const appointmentsFile = path.join(__dirname, "data", "appointments.json");
const chatLogsFile = path.join(__dirname, "data", "chatLogs.json");
const settingsFile = path.join(__dirname, "data", "settings.json");
const documentsFile = path.join(__dirname, "data", "documents.json");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const sessions = new Set();

const { ElevenLabsClient } = require("elevenlabs");

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY
});

const MAEVE_VOICE_ID = "sgk995upfe3tYLvoGcBN";

const nodemailer = require("nodemailer");

const brokerEmail = process.env.BROKER_EMAIL;

const mailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

let maeveIntroJustPlayed = false;

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
  businessMode: "mortgage"
});

let aiEnabled = settings.aiEnabled;
let businessMode = "mortgage";

const availableSlots = {
  "2026-04-22": ["10:00", "11:00", "14:00"],
  "2026-04-23": ["09:30", "13:00", "15:00"]
};

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

const mortgageLeadsFile = path.join(__dirname, "data", "mortgageLeads.json");

function loadMortgageLeads() {
  try {
    if (!fs.existsSync(mortgageLeadsFile)) {
      fs.writeFileSync(mortgageLeadsFile, JSON.stringify([], null, 2));
    }

    const data = fs.readFileSync(mortgageLeadsFile, "utf8");
    return JSON.parse(data || "[]");
  } catch (error) {
    console.error("Error loading mortgage leads:", error);
    return [];
  }
}

function saveMortgageLeads(leads) {
  try {
    fs.writeFileSync(mortgageLeadsFile, JSON.stringify(leads, null, 2));
  } catch (error) {
    console.error("Error saving mortgage leads:", error);
  }
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
    businessMode
  });
}

function addChatLog(entry) {
  chatLogs.push(entry);
  saveChatLogs();
}

async function createAppointment(userId, conversationId, customerName, date, time, type) {
  const newAppointment = {
    id: appointments.length > 0 ? Math.max(...appointments.map(a => a.id)) + 1 : 1,
    userId,
    conversationId, // 👈 IMPORTANT
    customerName,
    date,
    time,
    type,
    status: "confirmed",
    createdAt: new Date()
  };

    appointments.push(newAppointment);
    saveAppointments();

    await mailTransporter.sendMail({
    from: process.env.EMAIL_USER,
    to: brokerEmail,
    subject: "📅 New Appointment Booked",
    text: `
  New appointment booked:

  Name: ${customerName}
  Date: ${date}
  Time: ${time}
  Type: ${type}
  `
  });

  return newAppointment;
}

function resetConversation(userId) {
  conversations[userId] = {
    step: "start",
    date: null,
    time: null,
    bookingType: null,

    mortgageStep: "start",
    mortgageLeadId: null
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

function createMortgageLeadFromChat({ userId, conversationId }) {
  const leads = loadMortgageLeads();

  const newLead = {
    id: "ML-" + Date.now(),
    createdAt: new Date().toISOString(),
    status: "New lead",
    userId,
    conversationId,
    name: "",
    phone: "",
    email: "",
    buyerType: "",
    propertyPrice: "",
    deposit: "",
    income: "",
    employmentType: "",
    notes: "Started from chat"
  };

  leads.push(newLead);
  saveMortgageLeads(leads);

  return newLead;
}

function updateMortgageLead(leadId, updates) {
  const leads = loadMortgageLeads();

  const lead = leads.find(l => l.id === leadId);
  if (!lead) return;

  Object.assign(lead, updates);

  saveMortgageLeads(leads);
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
    convo.step = "awaiting_date";
    convo.bookingType = bookingType;
    convo.date = null;
    convo.time = null;

    return {
      reply: "Sure — what date would you like? Available dates are 2026-04-22 or 2026-04-23."
    };
  }

  if (convo.step === "awaiting_date") {
    if (!isDateInput(trimmedMessage)) {
      return {
        reply: "Please enter the date in YYYY-MM-DD format, for example 2026-04-22."
      };
    }

    if (!availableSlots[trimmedMessage]) {
      return {
        reply: "That date is not available. Please choose 2026-04-22 or 2026-04-23."
      };
    }

    convo.date = trimmedMessage;
    convo.step = "awaiting_time";

    return {
      reply: `Available times on ${trimmedMessage} are: ${availableSlots[trimmedMessage].join(", ")}. Which time would you like?`
    };
  }

  if (convo.step === "awaiting_time") {
    if (!convo.date) {
      convo.step = "awaiting_date";
      return {
        reply: "Please choose a date first: 2026-04-22 or 2026-04-23."
      };
    }

    if (!isTimeInput(trimmedMessage)) {
      return {
        reply: `Please enter a time in HH:MM format. Available times are: ${availableSlots[convo.date].join(", ")}.`
      };
    }

    if (!availableSlots[convo.date].includes(trimmedMessage)) {
      return {
        reply: `That time is not available. Please choose one of these: ${availableSlots[convo.date].join(", ")}.`
      };
    }

    convo.time = trimmedMessage;
    convo.step = "awaiting_name";

    return {
      reply: "Great — what is your name?"
    };
  }

  if (convo.step === "awaiting_name") {
    if (!convo.date || !convo.time) {
      convo.step = "awaiting_date";
      return {
        reply: "We need to restart the booking. Please choose a date first: 2026-04-22 or 2026-04-23."
      };
    }

    const newAppointment = await createAppointment(
      userId,
      conversationId,
      trimmedMessage,
      convo.date,
      convo.time,
      convo.bookingType || bookingType
    );

    resetConversation(userId);

    return {
      reply: `Thanks ${trimmedMessage}. Your ${confirmationLabel} is booked for ${newAppointment.date} at ${newAppointment.time}.`
    };
  }

  return {
    reply: `I can help you book a ${confirmationLabel}. Type 'book appointment' to begin.`
  };
}

app.get("/admin/mortgage-leads", requireAdmin, (req, res) => {
  const leads = loadMortgageLeads();

  const sortedLeads = [...leads].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  res.json(sortedLeads);
});

app.get("/api/mortgage-leads", requireAdmin, (req, res) => {
  const scorePriority = { hot: 3, warm: 2, cold: 1 };
  const leads = loadMortgageLeads()
    .filter(l => l.subject !== undefined)
    .sort((a, b) => {
      const pa = scorePriority[(a.lead_score || "").toLowerCase()] || 0;
      const pb = scorePriority[(b.lead_score || "").toLowerCase()] || 0;
      if (pb !== pa) return pb - pa;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  res.json(leads);
});

app.post("/mortgage-leads", (req, res) => {
  const leads = loadMortgageLeads();

  const newLead = {
    id: "ML-" + Date.now(),
    createdAt: new Date().toISOString(),
    status: "New lead",
    name: req.body.name || "",
    phone: req.body.phone || "",
    email: req.body.email || "",
    buyerType: req.body.buyerType || "",
    propertyPrice: req.body.propertyPrice || "",
    deposit: req.body.deposit || "",
    income: req.body.income || "",
    employmentType: req.body.employmentType || "",
    notes: req.body.notes || ""
  };

  leads.push(newLead);
  saveMortgageLeads(leads);

  res.json({
    success: true,
    lead: newLead
  });
});

app.post("/zapier/email-lead", (req, res) => {
  const { email, income, deposit, timeline, lead_score, subject } = req.body;

  const leads = loadMortgageLeads();

  const isDuplicate = leads.some(
    (l) => l.email === email && l.subject === subject
  );

  if (isDuplicate) {
    return res.json({ success: true, duplicate: true });
  }

  const newLead = {
    id: "ML-" + Date.now(),
    createdAt: new Date().toISOString(),
    status: "New lead",
    email: email || "",
    income: income || "",
    deposit: deposit || "",
    timeline: timeline || "",
    lead_score: lead_score || "",
    subject: subject || ""
  };

  leads.push(newLead);
  saveMortgageLeads(leads);

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

    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Upload Successful</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="font-family: Arial; text-align: center; padding: 40px;">
        <h2>✅ Upload successful</h2>
        <p>Your document has been received.</p>
        <p>A broker will review it shortly.</p>
      </body>
      </html>
    `);
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

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Invalid password" });
  }

  const sessionId = crypto.randomUUID();
  sessions.add(sessionId);

  res.cookie("admin_session", sessionId, {
    httpOnly: true,
    sameSite: "lax"
  });

  res.json({ success: true });
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
  res.json({ aiEnabled, businessMode });
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

app.put("/admin/mortgage-leads/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const leads = loadMortgageLeads();
  const lead = leads.find(l => l.id === id);

  if (!lead) {
    return res.status(404).json({ error: "Lead not found" });
  }

  lead.status = status;

  saveMortgageLeads(leads);

  res.json({ success: true, lead });
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
You are Maeve, a friendly Irish mortgage assistant.

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
        <Gather input="speech dtmf" numDigits="1" action="/voice-process" method="POST" speechTimeout="auto">
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
        <Gather input="speech" action="/voice-process" method="POST" speechTimeout="auto">
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
            <Gather input="speech" action="/voice-process" method="POST" speechTimeout="auto">
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
          <Gather input="speech" action="/voice-process" method="POST" speechTimeout="auto">
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
        message: speech
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
        <Gather input="speech" action="/voice-process" method="POST" speechTimeout="auto">
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

async function emailBrokerAboutLead(lead) {
  if (!brokerEmail) {
    console.log("BROKER_EMAIL not set. Skipping broker email.");
    return;
  }

  const subject = `🔥 HOT LEAD: €${lead.income} income / €${lead.deposit} deposit`;

  const body = `
Hi,

Maeve has captured a new mortgage lead.

Lead Reference: http://ai-receptionist-wmr7.onrender.com/admin?leadId=${lead.id}
Name: ${lead.name || "-"}
Phone: ${lead.phone || "-"}
Email: ${lead.email || "-"}
Buyer Type: ${lead.buyerType || "-"}
Property Price: ${lead.propertyPrice || "-"}
Deposit: ${lead.deposit || "-"}
Income: ${lead.income || "-"}
Employment: ${lead.employmentType || "-"}
Lead Temperature: ${lead.leadTemperature || lead.temperature || lead.status || "-"}

Please review this lead in the Sprimal admin dashboard.

Regards,
Maeve
`;

  await mailTransporter.sendMail({
    from: process.env.EMAIL_USER,
    to: brokerEmail,
    subject,
    text: body
  });

  console.log("Broker email sent for lead:", lead.id);
}

app.post("/chat", async (req, res) => {
  try {
    const { userId, conversationId, message } = req.body;

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

      if (
        lowerMessage.includes("yes") ||
        lowerMessage.includes("ok") ||
        lowerMessage.includes("yeah") ||
        lowerMessage.includes("sure") ||
        lowerMessage.includes("yep")
      ) {
        convo.consentGiven = true;

        result.reply =
          "Perfect. I can help with applying for a mortgage, booking an appointment, or answering any questions. What would you like to do?";

      } else {
        result.reply =
          "No problem at all — I won’t collect any personal information. Let me know if you change your mind.";
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
      console.log("Business mode:", businessMode);
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

    } else if (businessMode === "gp") {
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

    } else if (businessMode === "mortgage") {

      if (mortgageInProgress) {
        const extracted = await extractMortgageFields(trimmedMessage);

        const leadUpdates = {};

        if (convo.mortgageStep === "uploadPayslip") {
          if (
            lowerMessage.includes("yes") ||
            lowerMessage.includes("ok") ||
            lowerMessage.includes("send") ||
            lowerMessage.includes("text") ||
            lowerMessage.includes("whatsapp")
          ) {
            const uploadLink = `${req.protocol}://${req.get("host")}/upload?leadId=${convo.mortgageLeadId}`;

            updateMortgageLead(convo.mortgageLeadId, {
            payslipUploadLinkSent: true
          });

          const completedLead = loadMortgageLeads().find(
            (l) => l.id === convo.mortgageLeadId
          );

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

          updateMortgageLead(convo.mortgageLeadId, {
            status: "New lead - contact details captured",
            leadTemperature: isHot ? "Hot" : "Cold"
          });

          if (isHot && !completedLead?.emailSent) {
            await emailBrokerAboutLead({
              ...completedLead,
              leadTemperature: "Hot"
            });

            updateMortgageLead(convo.mortgageLeadId, {
              emailSent: true
            });

            console.log("HOT lead email sent");
          }

          convo.completed = true;

          result.reply =
            "Perfect 👍 I’ll send that link now.\n\n" +

            "Here’s your secure upload link:\n\n" +
            uploadLink +

            "\n\nOnce that’s uploaded, you’re all set.\n\n" +

            "A broker will review your details and be in touch shortly.\n\n" +

            "Thanks for using Maeve 👋";

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

          updateMortgageLead(convo.mortgageLeadId, leadUpdates);

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

          updateMortgageLead(convo.mortgageLeadId, leadUpdates);

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

        updateMortgageLead(convo.mortgageLeadId, leadUpdates);

        const leads = loadMortgageLeads();
        const currentLead = leads.find(
          (l) => l.id === convo.mortgageLeadId
        );

        if (!currentLead) {
          console.error("Lead not found:", convo.mortgageLeadId);
          result.reply = "Sorry — something went wrong. Please try again.";
          return res.json({ reply: result.reply });
        }

        const nextStep = getNextMissingMortgageStep(currentLead);

        if (nextStep === "complete") {

          const completedLead = loadMortgageLeads().find(
            (l) => l.id === convo.mortgageLeadId
          );

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

          if (isHot && !completedLead?.emailSent) {
            await emailBrokerAboutLead({
              ...completedLead,
              leadTemperature: "Hot"
            });

            updateMortgageLead(completedLead.id, {
              emailSent: true
            });

            console.log("🔥 EMAIL SENT");
          } else {
            console.log("❌ NOT HOT — no email");
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
        lowerMessage.includes("mortgage") ||
        lowerMessage.includes("buy a house") ||
        lowerMessage.includes("buying a house") ||
        lowerMessage.includes("buy my first home") ||
        lowerMessage.includes("first home") ||
        lowerMessage.includes("first-time buyer") ||
        lowerMessage.includes("first time buyer") ||
        intent === "mortgage application"
      ) {
        const lead = createMortgageLeadFromChat({
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

        updateMortgageLead(lead.id, leadUpdates);

        const leads = loadMortgageLeads();
        const currentLead = leads.find((l) => l.id === lead.id);

        if (!currentLead) {
          console.error("Lead not found:", lead.id);
          result.reply = "Sorry — something went wrong creating your enquiry. Please try again.";
          return res.json({ reply: result.reply });
        }

        const nextStep = getNextMissingMortgageStep(currentLead);

    if (nextStep === "complete") {
      const completedLead = loadMortgageLeads().find(
        (l) => l.id === convo.mortgageLeadId
      );

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

      updateMortgageLead(convo.mortgageLeadId, {
        status: "New lead - contact details captured",
        leadTemperature: isHot ? "Hot" : "Cold"
      });

      if (isHot && !completedLead?.emailSent) {
        await emailBrokerAboutLead({
          ...completedLead,
          leadTemperature: "Hot"
        });

        updateMortgageLead(convo.mortgageLeadId, {
          emailSent: true
        });
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
        const maeveReply = await generateMaeveReply(trimmedMessage);
        result.reply =
        maeveReply ||
        "No problem at all — I can help with mortgages, consultations, or documents. What are you looking to do?";
      }

    } else {
      result.reply = "Invalid business mode configuration.";
    }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});