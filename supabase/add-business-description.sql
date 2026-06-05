-- ─── Add business_description to tenants ─────────────────────────────────────
-- Run once in Supabase SQL editor.
-- Stores a short AI-generated description of what each tenant's business does,
-- injected into the system prompt so Maeve gives more contextual answers.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS business_description TEXT;
