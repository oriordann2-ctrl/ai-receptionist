/**
 * Monkstown Tennis KB Evaluation Harness
 * Run: node scripts/kb-eval.js
 *
 * Calls the real retrieval + answer pipeline for each question in
 * kb-eval-questions.json, writes a graded report to kb-eval-report.md
 * and kb-eval-report.json.  READ-ONLY — never writes to KB tables.
 */

"use strict";

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const OpenAI           = require("openai");
const fs               = require("fs");
const path             = require("path");

// ── Config ─────────────────────────────────────────────────────────────────
const TENANT_ID   = process.env.EVAL_TENANT_ID || "monkstown-lawn-tennis-club";
const ORG_NAME    = "Monkstown Lawn Tennis and Croquet Club";
const MIN_SIM     = 0.30;
const QUESTIONS   = JSON.parse(fs.readFileSync(path.join(__dirname, "kb-eval-questions.json"), "utf8"));
const OUT_MD      = path.join(__dirname, "kb-eval-report.md");
const OUT_JSON    = path.join(__dirname, "kb-eval-report.json");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Helpers ─────────────────────────────────────────────────────────────────

async function expandQuery(message, orgName) {
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You are a search query expander for ${orgName}. Given a user question, return 3 alternative phrasings as a JSON array of strings. Keep each short.` },
        { role: "user",   content: message }
      ],
      response_format: { type: "json_object" },
      max_tokens: 200
    });
    const parsed = JSON.parse(resp.choices[0].message.content);
    return Array.isArray(parsed.queries) ? parsed.queries : Object.values(parsed).flat().filter(s => typeof s === "string");
  } catch { return []; }
}

function reciprocalRankFusion(lists, k = 60) {
  const scores = new Map();
  const items  = new Map();
  for (const list of lists) {
    if (!list) continue;
    list.forEach((item, rank) => {
      const key = `${item.document_id}-${item.chunk_index}`;
      scores.set(key, (scores.get(key) || 0) + 1 / (k + rank + 1));
      if (!items.has(key)) items.set(key, item);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => items.get(key));
}

async function retrieve(question) {
  const anchoredQuery = `${ORG_NAME} — ${question}`;

  const [alternatives, origEmbResp] = await Promise.all([
    Promise.race([
      expandQuery(question, ORG_NAME),
      new Promise(r => setTimeout(() => r([]), 600))
    ]),
    openai.embeddings.create({ model: "text-embedding-3-small", input: [anchoredQuery, question] })
  ]);

  const altEmbeddings = alternatives.length > 0
    ? (await openai.embeddings.create({ model: "text-embedding-3-small", input: alternatives })).data.map(d => d.embedding)
    : [];
  const embeddings = [...origEmbResp.data.map(d => d.embedding), ...altEmbeddings];

  const FETCH = 30;
  const safe = async p => {
    const r = await Promise.resolve(p);
    if (r.error) console.error("[rpc error]", r.error.message || JSON.stringify(r.error));
    return r.error ? { data: null } : r;
  };
  const [keywordResult, ...vectorResults] = await Promise.all([
    safe(supabase.rpc("search_chunks_keyword", { query_text: question, match_count: FETCH, p_tenant_id: TENANT_ID })),
    ...embeddings.map(emb =>
      safe(supabase.rpc("match_chunks", { query_embedding: emb, match_count: FETCH, filter_lender: null, filter_document_type: null, p_tenant_id: TENANT_ID }))
    )
  ]);

  const fused = reciprocalRankFusion([keywordResult.data, ...vectorResults.map(r => r.data)]);

  const vectorSimMap = new Map();
  vectorResults.forEach(({ data: chunks }) => {
    if (!chunks) return;
    chunks.forEach(c => {
      const key = `${c.document_id}-${c.chunk_index}`;
      if (!vectorSimMap.has(key) || c.similarity > vectorSimMap.get(key)) vectorSimMap.set(key, c.similarity);
    });
  });
  const keywordKeys = new Set((keywordResult.data || []).map(c => `${c.document_id}-${c.chunk_index}`));

  const websiteChunks = fused
    .filter(c => c.document_type === "Website Content")
    .filter(c => {
      const key = `${c.document_id}-${c.chunk_index}`;
      return keywordKeys.has(key) || (vectorSimMap.get(key) || 0) >= MIN_SIM;
    });

  const { data: uploadedDocRows } = await supabase
    .from("knowledge_chunks")
    .select("document_id, chunk_index, chunk_text, document_type, lender")
    .eq("tenant_id", TENANT_ID)
    .neq("document_type", "Website Content")
    .limit(60);

  const sortedUploaded = (uploadedDocRows || [])
    .sort((a, b) => {
      const keyA = `${a.document_id}-${a.chunk_index}`;
      const keyB = `${b.document_id}-${b.chunk_index}`;
      const sA = keywordKeys.has(keyA) ? 1 : (vectorSimMap.get(keyA) || 0);
      const sB = keywordKeys.has(keyB) ? 1 : (vectorSimMap.get(keyB) || 0);
      return sB - sA;
    })
    .slice(0, 10);

  // Approved answers
  let approvedChunks = [];
  try {
    const { data: approved } = await Promise.resolve(supabase.rpc("match_approved_answers", {
      query_embedding: embeddings[0],
      match_tenant_id: TENANT_ID,
      match_threshold: 0.50,
      match_count: 3
    }));
    if (approved?.length) {
      approvedChunks = approved.map(aa => ({
        document_id: "approved-" + aa.id,
        chunk_index: 0,
        chunk_text: `Q: ${aa.question}\nA: ${aa.answer}`,
        document_type: "Approved Answer",
        lender: null,
        _sim: aa.similarity
      }));
    }
  } catch (_) {}

  const goodChunks = [...approvedChunks, ...sortedUploaded, ...websiteChunks.slice(0, 10)];

  return goodChunks.map(c => ({
    source: c.lender ? `${c.lender} — ${c.document_type}` : (c.document_type || "Knowledge Base"),
    snippet: c.chunk_text.slice(0, 300).replace(/\n+/g, " "),
    similarity: +(c._sim || vectorSimMap.get(`${c.document_id}-${c.chunk_index}`) || 0).toFixed(3),
    keyword_match: keywordKeys.has(`${c.document_id}-${c.chunk_index}`)
  }));
}

async function compose(question, chunks) {
  if (!chunks.length) return { answer: null, fell_back: true };

  const context = chunks.map((c, i) => `[${i + 1}] (${c.source}) ${c.snippet}`).join("\n\n");
  const topSim  = Math.max(...chunks.map(c => c.similarity));

  const sysPrompt = `You are Maeve, the AI assistant for ${ORG_NAME}. Answer the question using only the provided context. If the context doesn't contain enough information to answer, say you don't have that information and suggest contacting the club directly. Never fabricate facts. Never share personal data or individual member details. If a question involves a child's schedule or a member's personal contact info, say you cannot help with that and direct to club staff.`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: sysPrompt },
      { role: "user",   content: `Context:\n${context}\n\nQuestion: ${question}` }
    ],
    temperature: 0.3,
    max_tokens: 500
  });

  const answer = resp.choices[0].message.content.trim();
  const fell_back = topSim < MIN_SIM && !chunks.some(c => c.source === "Approved Answer");
  return { answer, fell_back, top_sim: topSim };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\nMonkstown Tennis KB Eval — ${QUESTIONS.length} questions\nTenant: ${TENANT_ID}\n${"─".repeat(60)}`);

  const results = [];
  const catCounts = {};
  let noChunkCount = 0;

  for (const q of QUESTIONS) {
    process.stdout.write(`[${q.id}/30] ${q.question.slice(0, 60)}...`);
    try {
      const chunks = await retrieve(q.question);
      const { answer, fell_back, top_sim } = await compose(q.question, chunks);

      const topSim = top_sim || (chunks.length ? Math.max(...chunks.map(c => c.similarity)) : 0);
      const noAboveThreshold = !chunks.some(c => c.similarity >= MIN_SIM || c.source === "Approved Answer");
      if (noAboveThreshold) noChunkCount++;

      const result = {
        id: q.id,
        category: q.category,
        question: q.question,
        expected_note: q.expected_note,
        answer: answer || "(no answer generated)",
        fell_back: fell_back || false,
        top_sim: +topSim.toFixed(3),
        no_above_threshold: noAboveThreshold,
        chunks: chunks.slice(0, 5),
        grade: ""
      };
      results.push(result);
      catCounts[q.category] = (catCounts[q.category] || 0) + 1;
      console.log(noAboveThreshold ? " ⚠️  no chunks" : " ✓");
    } catch (err) {
      console.log(` ERROR: ${err.message}`);
      results.push({ id: q.id, category: q.category, question: q.question, expected_note: q.expected_note, answer: `ERROR: ${err.message}`, grade: "" });
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Write JSON ──────────────────────────────────────────────────────────────
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));

  // ── Write Markdown report ────────────────────────────────────────────────────
  const catLabels = { A: "Core Membership", B: "Practical / Operational", C: "Phrasing Robustness", D: "Should NOT Answer", E: "Known-gap Probes" };
  let md = `# Monkstown Tennis — KB Evaluation Report\n\n`;
  md += `**Date:** ${new Date().toLocaleDateString("en-IE", { day: "numeric", month: "long", year: "numeric" })}\n`;
  md += `**Tenant:** ${TENANT_ID}\n`;
  md += `**Questions:** ${results.length}\n`;
  md += `**Questions with no above-threshold chunk:** ${noChunkCount} (content gaps)\n\n`;
  md += `> Grade each row: PASS / PARTIAL / FAIL-wrong / FAIL-noanswer / CORRECT-REFUSAL\n`;
  md += `> The dangerous column is **FAIL-wrong** — aim for zero.\n\n---\n\n`;

  const categories = ["A", "B", "C", "D", "E"];
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    if (!catResults.length) continue;
    md += `## Section ${cat} — ${catLabels[cat]}\n\n`;

    for (const r of catResults) {
      md += `### Q${r.id}. ${r.question}\n\n`;
      md += `**Expects:** ${r.expected_note}\n\n`;
      md += `**Answer:**\n> ${(r.answer || "").replace(/\n/g, "\n> ")}\n\n`;
      md += `**Retrieval:** top_sim=${r.top_sim}${r.fell_back ? " ⚠️ fell back" : ""}${r.no_above_threshold ? " ⚠️ NO CHUNKS ABOVE THRESHOLD" : ""}\n\n`;

      if (r.chunks && r.chunks.length) {
        md += `**Chunks retrieved:**\n\n`;
        md += `| # | Source | Sim | KW | Snippet |\n|---|--------|-----|----|---------|\n`;
        r.chunks.forEach((c, i) => {
          const snippet = (c.snippet || "").slice(0, 100).replace(/\|/g, "\\|");
          md += `| ${i + 1} | ${c.source} | ${c.similarity} | ${c.keyword_match ? "✓" : ""} | ${snippet}… |\n`;
        });
        md += "\n";
      } else {
        md += `**Chunks retrieved:** none\n\n`;
      }

      md += `**GRADE:** ` + "`.............`" + `\n\n---\n\n`;
    }
  }

  // Console summary
  console.log(`\n${"─".repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`${"─".repeat(60)}`);
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const gaps = catResults.filter(r => r.no_above_threshold).length;
    console.log(`  Section ${cat} (${catLabels[cat]}): ${catResults.length} questions, ${gaps} content gap(s)`);
  }
  console.log(`\n  Total content gaps (no above-threshold chunk): ${noChunkCount}/${results.length}`);
  console.log(`\n  Reports written to:`);
  console.log(`    ${OUT_MD}`);
  console.log(`    ${OUT_JSON}\n`);

  fs.writeFileSync(OUT_MD, md);
}

run().catch(err => { console.error("Fatal:", err); process.exit(1); });
