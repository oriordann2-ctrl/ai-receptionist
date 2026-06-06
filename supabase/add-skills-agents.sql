-- ── Skills & Agent Library ───────────────────────────────────────────────────
-- Run this once in Supabase SQL editor

-- Skill library (seeded by Sprimal, immutable by tenants)
CREATE TABLE IF NOT EXISTS skill_definitions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  version     TEXT DEFAULT '1.0',
  config_schema JSONB,
  instructions  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Agent library (seeded by Sprimal, immutable by tenants)
CREATE TABLE IF NOT EXISTS agent_definitions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  version     TEXT DEFAULT '1.0',
  skill_ids   TEXT[] NOT NULL,
  config_schema JSONB NOT NULL,
  steps       JSONB NOT NULL,
  instructions  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Per-tenant agent instances (club activates + configures an agent)
CREATE TABLE IF NOT EXISTS tenant_agents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL REFERENCES agent_definitions(id),
  is_active   BOOLEAN DEFAULT false,
  config      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, agent_id)
);

-- Leads captured by agents
CREATE TABLE IF NOT EXISTS skill_leads (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  data        JSONB NOT NULL,
  status      TEXT DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_agents_tenant_id ON tenant_agents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_skill_leads_tenant_id   ON skill_leads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_skill_leads_agent_id    ON skill_leads(agent_id);
CREATE INDEX IF NOT EXISTS idx_skill_leads_status      ON skill_leads(status);

-- ── Seed: Skill definitions ───────────────────────────────────────────────────

INSERT INTO skill_definitions (id, name, description, version, config_schema, instructions) VALUES
(
  'lead_capture',
  'Lead Capture',
  'Conducts a friendly multi-turn conversation to collect visitor contact details one field at a time. Validates email format. Allows skip for optional fields.',
  '1.0',
  '{
    "fields": [
      {"key": "name",  "label": "your name",            "prompt": "What''s your name?",                                              "required": true,  "validation": null},
      {"key": "email", "label": "your email address",   "prompt": "And your email address?",                                         "required": true,  "validation": "email"},
      {"key": "phone", "label": "your phone number",    "prompt": "Finally, your phone number (or type ''skip'' to leave this out)", "required": false, "validation": null}
    ]
  }',
  'Ask one question at a time. Validate email format. Allow "skip" for optional fields. Be friendly and conversational.'
),
(
  'notify_and_confirm',
  'Notify & Confirm',
  'Sends a notification email to the club with collected lead data and shows a confirmation message to the visitor in the chat.',
  '1.0',
  '{}',
  'Use template variables like {{name}}, {{email}}, {{phone}} in subject and confirmation message. Always store the lead in skill_leads.'
)
ON CONFLICT (id) DO NOTHING;

-- ── Seed: Agent definitions ───────────────────────────────────────────────────

INSERT INTO agent_definitions (id, name, description, version, skill_ids, config_schema, steps, instructions) VALUES
(
  'coaching_enquiry_agent',
  'Coaching Enquiry',
  'Helps a visitor enquire about coaching. Asks what type of session they want, collects their contact details, emails the club, and confirms in chat.',
  '1.0',
  ARRAY['lead_capture', 'notify_and_confirm'],
  '{
    "fields": [
      {
        "key": "intro_message",
        "label": "Greeting message",
        "type": "textarea",
        "placeholder": "Great! I can help you get booked in for coaching. Let me take a few details.",
        "required": true
      },
      {
        "key": "session_types",
        "label": "Session types (one per line)",
        "type": "multiline",
        "placeholder": "Adult 1-to-1\nAdult Group\nJunior\nSummer Camp",
        "required": true,
        "hint": "Each line becomes a button option in the chat."
      },
      {
        "key": "notification_email",
        "label": "Email address to receive enquiries",
        "type": "email",
        "placeholder": "info@yourclub.com",
        "required": true
      },
      {
        "key": "reply_time",
        "label": "Response time promise",
        "type": "text",
        "placeholder": "24 hours",
        "required": false,
        "hint": "Shown to visitor in the confirmation message."
      },
      {
        "key": "confirmation_message",
        "label": "Confirmation message shown to visitor",
        "type": "textarea",
        "placeholder": "Thanks {{name}}! Our coaching team will be in touch within {{reply_time}}. 🎾",
        "required": false,
        "hint": "Use {{name}}, {{email}}, {{phone}}, {{session_type}}, {{reply_time}} as placeholders."
      }
    ]
  }',
  '[
    {
      "id": "greeting",
      "type": "greeting",
      "message_key": "intro_message",
      "prompt": "What type of session are you interested in?",
      "choices_key": "session_types",
      "collect_field": "session_type",
      "branches": [
        {"if_value_contains": "junior", "next": "child_age"}
      ],
      "default_next": "lead_capture"
    },
    {
      "id": "child_age",
      "type": "collect",
      "prompt": "Lovely! How old is your child?",
      "collect_field": "child_age",
      "validation": null,
      "next": "lead_capture"
    },
    {
      "id": "lead_capture",
      "type": "skill",
      "skill_id": "lead_capture",
      "next": "notify"
    },
    {
      "id": "notify",
      "type": "skill",
      "skill_id": "notify_and_confirm",
      "next": null
    }
  ]',
  'Be warm and friendly. Keep questions short and clear. Thank the user by name in the confirmation.'
)
ON CONFLICT (id) DO NOTHING;
