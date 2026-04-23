const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const { OpenAI } = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY2 });

const multer = require("multer");
const upload = multer({ dest: 'uploads/' });

dotenv.config();

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const appointmentsFile = path.join(__dirname, "data", "appointments.json");
const chatLogsFile = path.join(__dirname, "data", "chatLogs.json");
const settingsFile = path.join(__dirname, "data", "settings.json");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const sessions = new Set();

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
let chatLogs = readJsonFile(chatLogsFile, []);
const settings = readJsonFile(settingsFile, {
  aiEnabled: true,
  businessMode: "gp"
});

let aiEnabled = settings.aiEnabled;
let businessMode = settings.businessMode;

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

function createAppointment(userId, customerName, date, time, type) {
  const newAppointment = {
    id: appointments.length > 0 ? Math.max(...appointments.map(a => a.id)) + 1 : 1,
    userId,
    customerName,
    date,
    time,
    type,
    status: "confirmed",
    createdAt: new Date()
  };

  appointments.push(newAppointment);
  saveAppointments();

  return newAppointment;
}

function resetConversation(userId) {
  conversations[userId] = {
    step: "start",
    date: null,
    time: null,
    bookingType: null
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

function handleBookingFlow({ userId, message, bookingType, confirmationLabel }) {
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

    const newAppointment = createAppointment(
      userId,
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

app.post('/upload', upload.single('file'), (req, res) => { res.json({ success: true, file: req.file }); });

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "login.html"));
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

app.post("/appointments", requireAdmin, (req, res) => {
  const { userId, customerName, date, time, type } = req.body;

  if (!userId || !customerName || !date || !time || !type) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const newAppointment = createAppointment(userId, customerName, date, time, type);

  res.json({
    success: true,
    appointment: newAppointment
  });
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
    sender: "admin",
    message: `Appointment updated to ${appointment.date} at ${appointment.time} with status ${appointment.status}.`,
    timestamp: new Date()
  });

  res.json({
    success: true,
    appointment
  });
});

async function getIntentFromOpenAI(message) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4-turbo",
    messages: [{ role: "user", content: `What is the intent of this message? Respond with one of: "book appointment", "upload documents", or "general inquiry". Message: "${message}"` }],
  });
  return completion.choices[0].message.content.toLowerCase();
}

app.post("/chat", async (req, res) => {
  const { userId, message } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ error: "userId and message are required" });
  }

  const trimmedMessage = message.trim();
  const lowerMessage = trimmedMessage.toLowerCase();

  let result = {
    reply: "How can I help you today?"
  };

  const intent = await getIntentFromOpenAI(trimmedMessage);
  console.log("Intent:", intent);

  ensureConversation(userId);

  addChatLog({
    userId,
    sender: "customer",
    message: trimmedMessage,
    timestamp: new Date()
  });

  if (!aiEnabled) {
    result.reply = "The AI receptionist is currently turned off. Please contact the business directly.";
  } else if (intent === "upload documents") {
    result.reply = "Please upload the required documents (ID, payslips, bank statements, proof of address, etc.) using the upload option.";
  } else if (businessMode === "gp") {
    if (isUrgentMessage(trimmedMessage)) {
      resetConversation(userId);

      result.reply = "Your message may describe an urgent medical issue. Please contact emergency services immediately or call the practice directly now.";

      addChatLog({
        userId,
        sender: "system",
        message: "Urgent triage flag raised.",
        timestamp: new Date()
      });
    } else {
      result = handleBookingFlow({
        userId,
        message: trimmedMessage,
        bookingType: "GP Visit",
        confirmationLabel: "appointment"
      });
    }
  } else if (businessMode === "mortgage") {
    if (lowerMessage.includes("status") || lowerMessage.includes("update")) {
      result.reply = "Your mortgage application is currently being reviewed. A broker will contact you if any additional documents are required.";
    } else if (
      lowerMessage.includes("documents") ||
      lowerMessage.includes("docs") ||
      lowerMessage.includes("what do i need")
    ) {
      result.reply = "Typical mortgage documents include ID, proof of address, bank statements, payslips, employment details, and savings evidence. Exact requirements vary by lender.";
    } else {
      result = handleBookingFlow({
        userId,
        message: trimmedMessage,
        bookingType: "Mortgage Consultation",
        confirmationLabel: "consultation"
      });
    }
  }

  addChatLog({
    userId,
    sender: "bot",
    message: result.reply,
    timestamp: new Date()
  });

  res.json({ reply: result.reply });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});