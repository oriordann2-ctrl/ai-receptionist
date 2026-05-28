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
  service: "gmail",
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
async function generateAndStoreChunks(documentId, text, lender, documentType, effectiveDate) {
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    console.log(`[embeddings] No text to embed for document ${documentId} — skipping`);
    return;
  }

  console.log(`[embeddings] Generating embeddings for ${chunks.length} chunk(s) — document ${documentId}`);

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
    effective_date: effectiveDate ? `${effectiveDate}-01` : null
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
          junior_accessible: juniorAccessible === "true" || juniorAccessible === true
        })
        .select()
        .single();

      if (docInsertError) {
        console.error("Documents table insert error:", docInsertError);
        return res.status(500).json({ error: "Failed to save document record" });
      }

      // ── Generate embeddings and store chunks ──────────────────────────────
      try {
        await generateAndStoreChunks(docData.id, extractedText, lender, documentType, effectiveDate);
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
    console.log("[loadMortgageLeads] file path:", mortgageLeadsFile);
    if (!fs.existsSync(mortgageLeadsFile)) {
      console.log("[loadMortgageLeads] file not found — creating empty file");
      fs.writeFileSync(mortgageLeadsFile, JSON.stringify([], null, 2));
    }

    const data = fs.readFileSync(mortgageLeadsFile, "utf8");
    const leads = JSON.parse(data || "[]");
    console.log("[loadMortgageLeads] loaded", leads.length, "leads");
    return leads;
  } catch (error) {
    console.error("[loadMortgageLeads] error:", error);
    return [];
  }
}

function saveMortgageLeads(leads) {
  try {
    console.log("[saveMortgageLeads] writing", leads.length, "leads to:", mortgageLeadsFile);
    fs.writeFileSync(mortgageLeadsFile, JSON.stringify(leads, null, 2));
    console.log("[saveMortgageLeads] write complete");
  } catch (error) {
    console.error("[saveMortgageLeads] error:", error);
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

    try {
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
    } catch (err) {
      console.error("[createAppointment] email failed:", err.message);
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

app.get("/api/mortgage-leads", requireAdmin, (req, res) => {
  console.log("[/api/mortgage-leads] file path:", mortgageLeadsFile);
  const scorePriority = { hot: 3, warm: 2, cold: 1 };
  const all = loadMortgageLeads();
  console.log("[/api/mortgage-leads] total leads in file:", all.length);
  const leads = all
    .filter(l => l.subject !== undefined)
    .sort((a, b) => {
      const pa = scorePriority[(a.lead_score || "").toLowerCase()] || 0;
      const pb = scorePriority[(b.lead_score || "").toLowerCase()] || 0;
      if (pb !== pa) return pb - pa;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  console.log("[/api/mortgage-leads] returning", leads.length, "zapier leads");
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
  console.log("[/zapier/email-lead] payload:", JSON.stringify(req.body));
  const { email, income, deposit, timeline, lead_score, subject } = req.body;

  const leads = loadMortgageLeads();
  console.log("[/zapier/email-lead] leads before save:", leads.length);

  const isDuplicate = leads.some(
    (l) => l.email === email && l.subject === subject
  );

  if (isDuplicate) {
    console.log("[/zapier/email-lead] duplicate detected — skipping");
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
  console.log("[/zapier/email-lead] leads after save:", leads.length);

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
        <Gather input="speech dtmf" numDigits="1" action="/voice-process" method="POST" speechTimeout="5">
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

async function findRelevantKnowledgeChunks(message, matchCount = 5) {
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
      filter_document_type: null
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

  try {
    await mailTransporter.sendMail({
      from: process.env.EMAIL_USER,
      to: brokerEmail,
      subject,
      text: body
    });
    console.log("[emailBrokerAboutLead] email sent for lead:", lead.id);
  } catch (err) {
    console.error("[emailBrokerAboutLead] email failed:", err.message);
  }
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
        lowerMessage.includes("okay") ||
        lowerMessage.includes("yeah") ||
        lowerMessage.includes("sure") ||
        lowerMessage.includes("yep") ||
        lowerMessage.includes("fine") ||
        lowerMessage.includes("alright") ||
        lowerMessage.includes("absolutely") ||
        lowerMessage.includes("of course") ||
        lowerMessage.includes("go ahead") ||
        lowerMessage.includes("happy") ||
        lowerMessage.includes("no problem") ||
        lowerMessage.includes("sounds good") ||
        lowerMessage.includes("grand")
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

      // ── Qualification agent — takes priority ────────────────────────────────
      if (convo.qualMode) {
        result.reply = await runQualificationAgent(convo, trimmedMessage);

      } else if (isMortgageApplicationIntent(trimmedMessage, intent) && !bookingInProgress) {
        convo.qualMode = true;
        result.reply   = await runQualificationAgent(convo, trimmedMessage);

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

          console.log("[uploadPayslip] lead check:", { income, deposit, isHot });

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

  // 🔥 NEW: Check knowledge base documents FIRST
  const relevantDocs = await findRelevantKnowledgeChunks(trimmedMessage);

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

      result.reply = completion.choices[0].message.content;

    } catch (err) {
      console.error("Knowledge base OpenAI error:", err.message);
      result.reply = "Sorry — I couldn’t access the knowledge base.";
    }

  } else {
    // fallback to normal Maeve reply
    const maeveReply = await generateMaeveReply(trimmedMessage);
    result.reply =
      maeveReply ||
      "No problem at all — I can help with mortgages, consultations, or documents. What are you looking to do?";
  }
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

async function emailLeadQualification(answers, scoring) {
  const emoji = { hot: "🔥", warm: "⚡", cold: "❄️" }[scoring.score] || "📋";
  const label = scoring.score.toUpperCase();

  const subject = `${emoji} ${label} LEAD — ${answers.customerName || "New enquiry"}`;

  const text =
`${emoji} ${label} LEAD — ${scoring.score === "hot" ? "FOLLOW UP NOW" : "FOLLOW UP RECOMMENDED"}

Name:           ${answers.customerName  || "Not provided"}
Phone:          ${answers.customerPhone || "Not provided"}
Email:          ${answers.customerEmail || "Not provided"}

MORTGAGE DETAILS
──────────────────────────────────────────
Buyer type:     ${answers.buyerType}
Property price: €${scoring.propertyPrice?.toLocaleString("en-IE")}
Deposit:        €${scoring.deposit?.toLocaleString("en-IE")}
Required loan:  €${scoring.loanRequired?.toLocaleString("en-IE")}
Annual income:  €${scoring.income?.toLocaleString("en-IE")}
LTV:            ${scoring.ltv}%  (limit: ${scoring.maxLTV}%)
LTI:            ${scoring.lti}x  (limit: ${scoring.maxLTI}x)
Employment:     ${answers.employmentType}
Credit history: ${answers.creditHistory}
Existing debts: ${answers.existingDebts || "None"}

STRENGTHS
──────────────────────────────────────────
${scoring.strengths.map(s => `• ${s}`).join("\n") || "None identified"}

ISSUES
──────────────────────────────────────────
${scoring.issues.map(i => `• ${i}`).join("\n") || "None"}

SCORE: ${emoji} ${label}
──────────────────────────────────────────
Qualification via Sprimal AI Chat`;

  // Sending to hello@sprimal.com only during testing — add brokerEmail once validated
  const recipients = ["hello@sprimal.com"];

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn("[qual-agent] Gmail credentials not set — skipping lead email");
    return;
  }

  const gmailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  try {
    await gmailTransporter.sendMail({
      from: process.env.GMAIL_USER,
      to: recipients.join(", "),
      subject,
      text
    });
    console.log(`[qual-agent] Lead email sent: ${label} — ${answers.customerName}`);
  } catch (err) {
    console.error("[qual-agent] Email failed:", err.message);
  }
}

// ── Qual Agent: answer tracking helpers ──────────────────────────────────────

function extractAnswersFromMessages(qualMessages, existingAnswers) {
  const answers = { ...existingAnswers };

  // Combined text of all USER messages only
  const userText = qualMessages
    .filter(m => m.role === "user")
    .map(m => m.content)
    .join(" ");
  const lower = userText.toLowerCase();

  // Buyer type
  if (!answers.buyerType) {
    if (/\bfirst[\s-]?time\b|\bftb\b|\bnever owned\b/.test(lower)) {
      answers.buyerType = "first_time";
    } else if (/\bbuy[\s-]to[\s-]let\b|\binvestment property\b|\bbtl\b|\bto rent(?: it)? out\b/.test(lower)) {
      answers.buyerType = "buy_to_let";
    } else if (/\bmoving home\b|\bmover\b|\bsecond[\s-]?time buyer\b|\balready own\b|\bupgrading\b|\bdownsizing\b/.test(lower)) {
      answers.buyerType = "mover";
    }
  }

  // Employment type
  if (!answers.employmentType) {
    if (/\bpaye\b|\bfull[\s-]?time employed\b/.test(lower)) {
      answers.employmentType = "paye";
    } else if (/\bself[\s-]?employed\b/.test(lower)) {
      answers.employmentType = "self_employed";
    } else if (/\bcontractor\b/.test(lower)) {
      answers.employmentType = "contractor";
    }
  }

  // Credit history
  if (!answers.creditHistory) {
    if (/\bno missed\b|\bclean credit\b|\bnever missed\b|\bperfect credit\b|\bno issues\b/.test(lower)) {
      answers.creditHistory = "clean";
    } else if (/\bmissed (?:a )?(?:loan|mortgage|repayment|payment)\b/.test(lower)) {
      answers.creditHistory = "issues";
    }
  }

  // Existing debts
  if (!answers.existingDebts) {
    if (/\bno (?:loans?|debts?|finance|car loan|credit card)\b|\bno existing\b|\bdebt[\s-]?free\b/.test(lower)) {
      answers.existingDebts = "none";
    } else if (/\bcar (?:loan|finance)\b|\bpersonal loan\b|\bcredit card debt\b/.test(lower)) {
      answers.existingDebts = "has debts";
    }
  }

  // Scan each user message for money values with context keywords
  for (const msg of qualMessages.filter(m => m.role === "user")) {
    const text = msg.content;

    if (!answers.deposit) {
      const m = text.match(/(\d[\d,.]*[kKmM]?)\s*(?:euro|€)?\s*(?:deposit|saved|in savings)/i)
             || text.match(/(?:deposit|saved|savings)[^\d]*(\d[\d,.]*[kKmM]?)/i);
      if (m) answers.deposit = parseMoneyValue(m[1]);
    }

    if (!answers.annualIncome) {
      const m = text.match(/(\d[\d,.]*[kKmM]?)\s*(?:a year|per year|annually|gross|salary|income)/i)
             || text.match(/(?:earn|income|salary|make)\D{0,10}(\d[\d,.]*[kKmM]?)/i);
      if (m) answers.annualIncome = parseMoneyValue(m[1]);
    }

    if (!answers.propertyPrice) {
      const m = text.match(/(?:property|house|home|flat|apartment|place|worth|asking|costs?|value)\D{0,10}(\d[\d,.]*[kKmM]?)/i)
             || text.match(/(\d[\d,.]*[kKmM]?)\s*(?:property|house|home|flat|apartment|place)/i);
      if (m) answers.propertyPrice = parseMoneyValue(m[1]);
    }
  }

  return answers;
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

const QUAL_SYSTEM_PROMPT = `You are Maeve, a warm and friendly Irish mortgage assistant working for At Once Mortgages in Cork.

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

Collect these 8 pieces of information through friendly conversation:
1. Buyer type (first-time, moving home, or buy-to-let)
2. Property price
3. Deposit amount
4. Gross annual income (combined if joint application)
5. Employment type — PAYE, self-employed, or contractor
6. Any existing loans, car finance, or credit card debt
7. Any missed loan or mortgage repayments in the last 5 years
8. Name, phone number, and email address

Rules:
- Be warm and natural — use short Irish phrases like "Sound", "Grand", "Perfect", "No bother".
- Keep each response to 1-2 sentences MAXIMUM.
- Ask only ONE question at a time — the next missing piece of information only.
- Do NOT summarise or repeat back what the customer has already told you.
- Do NOT use mortgage jargon like LTV or LTI.
- Do NOT tell them the outcome — just thank them and say the broker will be in touch.

Only call submit_qualification when you have ALL required fields including name, phone, and email.

ABSOLUTE PROHIBITIONS — never do any of the following under any circumstances:
- Do NOT ask for payslips, bank statements, P60s, or any documents
- Do NOT mention document upload or file upload
- Do NOT suggest sending a link by text, WhatsApp, or email
- Do NOT add any extra steps after collecting the 8 fields above
- The moment you have all 8 fields, call submit_qualification immediately — nothing else`;

async function runQualificationAgent(convo, userMessage) {
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
            customerEmail:  { type: "string" }
          },
          required: ["buyerType", "propertyPrice", "deposit", "annualIncome", "employmentType", "creditHistory", "customerName", "customerPhone", "customerEmail"]
        }
      }
    }
  ];

  for (let i = 0; i < 5; i++) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages:     convo.qualMessages,
      tools,
      tool_choice:  "auto",
      temperature:  0.5
    });

    const message = response.choices[0].message;
    convo.qualMessages.push(message);

    // Natural conversation reply
    if (response.choices[0].finish_reason === "stop") {
      return message.content;
    }

    // Tool call — all info collected
    if (response.choices[0].finish_reason === "tool_calls" && message.tool_calls?.length) {
      const toolCall = message.tool_calls[0];
      let answers;
      try {
        answers = JSON.parse(toolCall.function.arguments);
      } catch (e) {
        console.error("[qual-agent] Failed to parse tool arguments:", e.message);
        return "Thanks for that — a broker will be in touch with you shortly.";
      }

      // Score the lead
      const scoring = calculateLeadScore(answers);
      console.log(`[qual-agent] Score: ${scoring.score.toUpperCase()} — ${answers.customerName}`);

      // Save lead (non-fatal if it fails)
      try {
      const leads   = loadMortgageLeads();
      const newLead = {
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
        lead_score:             scoring.score,
        ltvPct:                 scoring.ltv,
        ltiX:                   scoring.lti,
        qualificationStrengths: scoring.strengths,
        qualificationIssues:    scoring.issues
      };
      leads.push(newLead);
      saveMortgageLeads(leads);
      } catch (saveErr) {
        console.error("[qual-agent] Lead save failed:", saveErr.message);
      }

      // Email Cormac (non-fatal)
      try {
        await emailLeadQualification(answers, scoring);
      } catch (emailErr) {
        console.error("[qual-agent] Email error:", emailErr.message);
      }

      // Ack tool call
      convo.qualMessages.push({
        role:         "tool",
        tool_call_id: toolCall.id,
        content:      JSON.stringify({ success: true, score: scoring.score })
      });

      // Closing message by score
      const closing = {
        hot:  "That's brilliant — thank you so much for those details! 😊 You look like a really strong candidate. Cormac Collins from At Once Mortgages will be in touch with you very shortly. Have a great day!",
        warm: "Lovely, thank you for sharing all of that! You're in a good position and Cormac will be in touch soon to go through your options. Talk soon! 👋",
        cold: "Thanks so much for chatting with me today. Cormac will take a look at your details and be in touch to discuss the best path forward for you. Have a lovely day! 👋"
      };

      convo.qualMode  = false;
      convo.completed = true;

      return closing[scoring.score];
    }
  }

  return "Sorry, something went wrong. Please try again or contact us directly at 021 4315 815.";
}

// Keywords that trigger lead qualification (vs general mortgage questions)
function isMortgageApplicationIntent(message, intent) {
  const lower = message.toLowerCase();
  const triggerPhrases = [
    "apply", "application", "get a mortgage", "take out a mortgage",
    "buying a house", "buying a home", "buying a property",
    "first time buyer", "first-time buyer", "looking for a mortgage",
    "interested in a mortgage", "mortgage enquiry", "can i get",
    "how much can i borrow", "afford a mortgage", "start the process",
    "moving home", "second time buyer"
  ];
  const triggerIntents = ["mortgage application", "apply for mortgage", "mortgage enquiry"];

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