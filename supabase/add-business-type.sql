-- Add business_type column to tenants table
-- Populated automatically during signup crawl
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS business_type TEXT DEFAULT 'other';
