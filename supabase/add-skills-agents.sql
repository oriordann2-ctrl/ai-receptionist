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
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  description    TEXT NOT NULL,
  version        TEXT DEFAULT '1.0',
  skill_ids      TEXT[] NOT NULL,
  config_schema  JSONB NOT NULL,
  steps          JSONB NOT NULL,
  instructions   TEXT,
  business_types TEXT[],   -- null = universal; otherwise only shown to matching tenant business_type
  created_at     TIMESTAMPTZ DEFAULT now()
);
-- Add business_types to existing tables (safe to run if column already exists, will error silently)
ALTER TABLE agent_definitions ADD COLUMN IF NOT EXISTS business_types TEXT[];

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
      {"key": "phone", "label": "your phone number",    "prompt": "And your phone number?", "required": true, "validation": null}
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

INSERT INTO agent_definitions (id, name, description, version, skill_ids, config_schema, steps, instructions, business_types) VALUES
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
  'Be warm and friendly. Keep questions short and clear. Thank the user by name in the confirmation.',
  ARRAY['tennis_club', 'squash_club', 'badminton_club']
),
(
  'membership_application_agent',
  'Membership Application',
  'Guides a visitor through a membership application, collects their details, emails the club, and confirms receipt.',
  '1.0',
  ARRAY['lead_capture', 'notify_and_confirm'],
  '{
    "fields": [
      {"key": "intro_message",        "label": "Greeting message",                  "type": "textarea",  "required": true,  "placeholder": "Hi! I can help you apply for membership. Let me take a few details."},
      {"key": "membership_types",     "label": "Membership types (one per line)",   "type": "multiline", "required": true,  "placeholder": "Family Membership - €300\nSingle Membership - €180\nStudent Membership - €80\nJunior Membership - €70", "hint": "Each line becomes a button option."},
      {"key": "notification_email",   "label": "Email to receive applications",     "type": "email",     "required": true,  "placeholder": "secretary@yourclub.com"},
      {"key": "reply_time",           "label": "Response time promise",             "type": "text",      "required": false, "placeholder": "3-5 working days"},
      {"key": "confirmation_message", "label": "Confirmation message to applicant", "type": "textarea",  "required": false, "placeholder": "Thanks {{name}}! Your application has been received and will be reviewed within {{reply_time}}.", "hint": "Use {{name}}, {{membership_type}}, {{reply_time}} as placeholders."}
    ]
  }',
  '[
    {"id": "greeting",         "type": "greeting", "message_key": "intro_message", "prompt": "What type of membership are you applying for?", "choices_key": "membership_types", "collect_field": "membership_type", "branches": [{"if_value_contains": "family", "next": "children_details"}, {"if_value_contains": "junior", "next": "dob"}], "default_next": "lead_capture"},
    {"id": "children_details", "type": "collect",  "prompt": "Please provide the name and date of birth of each child.", "collect_field": "children_details", "required": true,  "next": "lead_capture"},
    {"id": "dob",              "type": "collect",  "prompt": "Please provide their date of birth.",                      "collect_field": "date_of_birth",    "required": true,  "next": "lead_capture"},
    {"id": "lead_capture",     "type": "skill",    "skill_id": "lead_capture", "next": "address"},
    {"id": "address",          "type": "collect",  "prompt": "What''s your home address?",                              "collect_field": "address",          "required": true,  "next": "other_club"},
    {"id": "other_club",       "type": "collect",  "prompt": "Are you a member of another tennis club? (Type the club name, or ''skip'')", "collect_field": "other_club", "required": false, "next": "proposer"},
    {"id": "proposer",         "type": "collect",  "prompt": "Your proposer''s name — they must be an existing club member.", "collect_field": "proposer", "required": true,  "validation_type": "ebo_member", "next": "seconder"},
    {"id": "seconder",         "type": "collect",  "prompt": "And your seconder''s name — also an existing club member.", "collect_field": "seconder",  "required": true,  "validation_type": "ebo_member", "next": "consent"},
    {"id": "consent",          "type": "collect",  "prompt": "Finally, by typing ''I agree'' you confirm that you have read and agree to be bound by the club''s Codes of Conduct.", "collect_field": "consent", "required": true, "next": "notify"},
    {"id": "notify",           "type": "skill",    "skill_id": "notify_and_confirm", "next": null}
  ]',
  'Guide the applicant warmly through the form one question at a time. Make it clear their application will be reviewed by the club committee.',
  ARRAY['tennis_club', 'squash_club', 'badminton_club']
)
ON CONFLICT (id) DO NOTHING;
