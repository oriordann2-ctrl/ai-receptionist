-- Tracks questions the tenant has manually marked as answered
-- after uploading supporting knowledge base content.
CREATE TABLE IF NOT EXISTS dismissed_questions (
  id          bigserial PRIMARY KEY,
  tenant_id   text        NOT NULL,
  question_key text       NOT NULL,
  dismissed_at timestamptz DEFAULT now(),
  UNIQUE (tenant_id, question_key)
);

CREATE INDEX IF NOT EXISTS dismissed_questions_tenant_idx ON dismissed_questions (tenant_id);
