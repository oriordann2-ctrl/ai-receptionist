/**
 * sync-prod-to-staging.js
 *
 * Copies all production Supabase data into the staging Supabase project.
 * - Reads from production (read-only — no production data is modified)
 * - Writes to staging (clears existing staging data first, then inserts)
 * - Copies table rows: knowledge_documents, approved_answers, flagged_answers
 * - Downloads files from production storage and re-uploads to staging storage
 *
 * Usage:
 *   1. Fill in your credentials in .env.sync (see .env.sync.example)
 *   2. node scripts/sync-prod-to-staging.js
 */

require("dotenv").config({ path: ".env.sync" });
const { createClient } = require("@supabase/supabase-js");

// ─── Clients ────────────────────────────────────────────────────────────────

const prod = createClient(
  process.env.PROD_SUPABASE_URL,
  process.env.PROD_SUPABASE_SERVICE_ROLE_KEY
);

const staging = createClient(
  process.env.STAGING_SUPABASE_URL,
  process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY
);

const PROD_BUCKET    = process.env.PROD_SUPABASE_BUCKET;
const STAGING_BUCKET = process.env.STAGING_SUPABASE_BUCKET;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.warn(`  ⚠️  ${msg}`); }
function err(msg)  { console.error(`  ❌ ${msg}`); }

function section(title) {
  console.log(`\n${"─".repeat(56)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(56));
}

// ─── Validate env vars ───────────────────────────────────────────────────────

function validateEnv() {
  const required = [
    "PROD_SUPABASE_URL",
    "PROD_SUPABASE_SERVICE_ROLE_KEY",
    "PROD_SUPABASE_BUCKET",
    "STAGING_SUPABASE_URL",
    "STAGING_SUPABASE_SERVICE_ROLE_KEY",
    "STAGING_SUPABASE_BUCKET",
  ];

  const missing = required.filter(k => !process.env[k]);

  if (missing.length) {
    console.error("\n❌ Missing required env vars in .env.sync:");
    missing.forEach(k => console.error(`   - ${k}`));
    console.error("\nSee .env.sync.example for the template.\n");
    process.exit(1);
  }

  // Safety check — refuse to run if both URLs are identical
  if (process.env.PROD_SUPABASE_URL === process.env.STAGING_SUPABASE_URL) {
    console.error("\n❌ PROD_SUPABASE_URL and STAGING_SUPABASE_URL are the same.");
    console.error("   This script would overwrite production data. Aborting.\n");
    process.exit(1);
  }
}

// ─── Copy a table ────────────────────────────────────────────────────────────

async function copyTable(tableName, columns) {
  section(`Table: ${tableName}`);

  // 1. Read from production
  const { data: rows, error: fetchErr } = await prod
    .from(tableName)
    .select(columns);

  if (fetchErr) {
    err(`Failed to read production ${tableName}: ${fetchErr.message}`);
    return 0;
  }

  log(`Read ${rows.length} rows from production`);

  if (!rows.length) {
    warn("No rows to copy — skipping.");
    return 0;
  }

  // 2. Clear staging table
  const { error: deleteErr } = await staging
    .from(tableName)
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000"); // delete all rows

  if (deleteErr) {
    err(`Failed to clear staging ${tableName}: ${deleteErr.message}`);
    return 0;
  }

  log(`Cleared staging ${tableName}`);

  // 3. Insert production rows into staging
  const { error: insertErr } = await staging
    .from(tableName)
    .insert(rows);

  if (insertErr) {
    err(`Failed to insert into staging ${tableName}: ${insertErr.message}`);
    return 0;
  }

  log(`Inserted ${rows.length} rows into staging`);
  return rows.length;
}

// ─── Copy storage files ──────────────────────────────────────────────────────

async function copyStorageFiles(docs) {
  section("Storage files");

  const withFiles = docs.filter(d => d.storage_path);

  if (!withFiles.length) {
    warn("No storage files to copy (all documents are pasted text).");
    return;
  }

  console.log(`  Copying ${withFiles.length} file(s)...\n`);

  let copied = 0;
  let skipped = 0;

  for (const doc of withFiles) {
    const path = doc.storage_path;

    try {
      // Download from production storage
      const { data: fileData, error: downloadErr } = await prod.storage
        .from(PROD_BUCKET)
        .download(path);

      if (downloadErr) {
        warn(`Could not download ${path}: ${downloadErr.message} — skipping`);
        skipped++;
        continue;
      }

      // Convert Blob to Buffer
      const arrayBuffer = await fileData.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Upload to staging storage (overwrite if exists)
      const { error: uploadErr } = await staging.storage
        .from(STAGING_BUCKET)
        .upload(path, buffer, {
          contentType: doc.mimetype,
          upsert: true
        });

      if (uploadErr) {
        warn(`Could not upload ${path}: ${uploadErr.message} — skipping`);
        skipped++;
        continue;
      }

      console.log(`  ✅ ${path}`);
      copied++;

    } catch (e) {
      warn(`Unexpected error for ${path}: ${e.message} — skipping`);
      skipped++;
    }
  }

  console.log(`\n  Copied: ${copied}  |  Skipped: ${skipped}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║       Sprimal Hub — Production → Staging Sync        ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("\n⚠️  Production data is READ ONLY throughout this script.");
  console.log("   Staging data will be REPLACED with production data.\n");

  validateEnv();

  console.log(`  Production : ${process.env.PROD_SUPABASE_URL}`);
  console.log(`  Staging    : ${process.env.STAGING_SUPABASE_URL}`);

  // Copy tables
  await copyTable("approved_answers", "*");
  await copyTable("flagged_answers",  "*");

  // Copy knowledge_documents table + storage files
  section("Table: knowledge_documents");

  const { data: docs, error: docsErr } = await prod
    .from("knowledge_documents")
    .select("*");

  if (docsErr) {
    err(`Failed to read production knowledge_documents: ${docsErr.message}`);
  } else {
    log(`Read ${docs.length} rows from production`);

    if (docs.length) {
      // Clear staging
      const { error: deleteErr } = await staging
        .from("knowledge_documents")
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000");

      if (deleteErr) {
        err(`Failed to clear staging knowledge_documents: ${deleteErr.message}`);
      } else {
        log("Cleared staging knowledge_documents");

        // Insert rows
        const { error: insertErr } = await staging
          .from("knowledge_documents")
          .insert(docs);

        if (insertErr) {
          err(`Failed to insert into staging knowledge_documents: ${insertErr.message}`);
        } else {
          log(`Inserted ${docs.length} rows into staging`);

          // Copy the actual files
          await copyStorageFiles(docs);
        }
      }
    } else {
      warn("No rows to copy — skipping.");
    }
  }

  section("Done");
  console.log("  Sync complete. Check staging Supabase to verify.\n");
}

main().catch(e => {
  console.error("\n❌ Unexpected error:", e.message);
  process.exit(1);
});
