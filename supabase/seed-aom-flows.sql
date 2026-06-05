-- ─── Seed AOM Chat Flows ───────────────────────────────────────────────────
-- Run once in Supabase SQL editor.
-- Creates 5 flows mirroring the journey in chat-aom.html.
-- None are set active — activate "AOM — Main Menu" when ready to go live.
--
-- NOTE: The "Existing Client" path opens AI chat (ai_fallback) for email entry.
-- The full OTP/email-lookup system lives in chat-aom.html and requires
-- custom API endpoints (/api/aom/lookup-email, send-otp, verify-otp).
-- That path cannot be replicated in the standard workflow builder.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  -- Flow IDs
  v_flow_main         UUID;
  v_flow_existing     UUID;
  v_flow_new          UUID;
  v_flow_mortgage     UUID;
  v_flow_appointment  UUID;

  -- Step IDs
  v_step_main_1       UUID;
  v_step_existing_1   UUID;
  v_step_new_1        UUID;
  v_step_mortgage_1   UUID;
  v_step_mortgage_2   UUID;
  v_step_appt_1       UUID;
BEGIN

  -- ── Generate UUIDs ────────────────────────────────────────────────────────
  v_flow_main        := gen_random_uuid();
  v_flow_existing    := gen_random_uuid();
  v_flow_new         := gen_random_uuid();
  v_flow_mortgage    := gen_random_uuid();
  v_flow_appointment := gen_random_uuid();

  v_step_main_1      := gen_random_uuid();
  v_step_existing_1  := gen_random_uuid();
  v_step_new_1       := gen_random_uuid();
  v_step_mortgage_1  := gen_random_uuid();
  v_step_mortgage_2  := gen_random_uuid();
  v_step_appt_1      := gen_random_uuid();

  -- ── Flows (all inactive) ──────────────────────────────────────────────────
  INSERT INTO public.chat_workflows (id, club_id, name, is_active)
  VALUES
    (v_flow_main,        'aom', 'AOM — Main Menu',    false),
    (v_flow_existing,    'aom', 'Existing Client',     false),
    (v_flow_new,         'aom', 'New to AOM',          false),
    (v_flow_mortgage,    'aom', 'Mortgage Enquiry',    false),
    (v_flow_appointment, 'aom', 'Book Appointment',    false);

  -- ── Steps ─────────────────────────────────────────────────────────────────
  INSERT INTO public.workflow_steps (id, workflow_id, step_order, bot_message)
  VALUES
    -- Main Menu
    (v_step_main_1, v_flow_main, 1,
      'Hi there 👋 I''m Maeve, the At Once Mortgages assistant.' || chr(10) || chr(10) ||
      'Are you an existing AOM client, or getting in touch for the first time?'),

    -- Existing Client
    (v_step_existing_1, v_flow_existing, 1,
      'Welcome back.' || chr(10) || chr(10) ||
      'To pull up your application, please type your email address below and I''ll look it up for you.'),

    -- New to AOM
    (v_step_new_1, v_flow_new, 1,
      'Great, let''s get started. What brings you to AOM today?'),

    -- Mortgage Enquiry — Step 1: GDPR consent
    (v_step_mortgage_1, v_flow_mortgage, 1,
      'Before we get started — I may need to collect some personal details to help with your enquiry. Is that okay?'),

    -- Mortgage Enquiry — Step 2: buyer type
    (v_step_mortgage_2, v_flow_mortgage, 2,
      'To get started, which of these best describes you?'),

    -- Book Appointment
    (v_step_appt_1, v_flow_appointment, 1,
      'No problem — tell me a bit about what you need and I''ll make sure the team has everything ready for your call.');

  -- ── Choices: Main Menu ────────────────────────────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_main_1, 1, 'Existing Client', 'switch_flow', v_flow_existing::text),
    (v_step_main_1, 2, 'New to AOM',      'switch_flow', v_flow_new::text);

  -- ── Choices: Existing Client ──────────────────────────────────────────────
  -- Note: "Enter my email" opens AI chat — the real OTP flow needs custom handling.
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_existing_1, 1, 'Enter my email address', 'ai_fallback', null),
    (v_step_existing_1, 2, '← Back to main menu',    'switch_flow',  v_flow_main::text);

  -- ── Choices: New to AOM ───────────────────────────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_new_1, 1, 'Apply for a mortgage', 'switch_flow', v_flow_mortgage::text),
    (v_step_new_1, 2, 'Book an appointment',  'switch_flow', v_flow_appointment::text),
    (v_step_new_1, 3, 'Something else',       'ai_fallback', null);

  -- ── Choices: Mortgage — Step 1 (GDPR consent) ────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_mortgage_1, 1, 'Yes, that''s fine', 'next_step', '2'),
    (v_step_mortgage_1, 2, 'No thanks',         'message',
      'No problem at all — I won''t collect any personal information.' || chr(10) || chr(10) ||
      'If you have general questions about mortgages, I''m still happy to help.');

  -- ── Choices: Mortgage — Step 2 (buyer type → AI chat) ────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_mortgage_2, 1, 'First-time buyer', 'ai_fallback', null),
    (v_step_mortgage_2, 2, 'Switching',        'ai_fallback', null),
    (v_step_mortgage_2, 3, 'Remortgaging',     'ai_fallback', null),
    (v_step_mortgage_2, 4, 'Something else',   'ai_fallback', null);

  -- ── Choices: Book Appointment ─────────────────────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_appt_1, 1, 'Get started →',        'ai_fallback', null),
    (v_step_appt_1, 2, '← Back to main menu',  'switch_flow',  v_flow_main::text);

END $$;
