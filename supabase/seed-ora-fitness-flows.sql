-- ─── Seed Ora Fitness Cork Chat Flows ────────────────────────────────────────
-- Run once in Supabase SQL editor.
--
-- After running, Orla logs into her portal → Chat Flows and edits the
-- [FILL IN] sections with her real class names, prices, and booking link.
-- None of the flows are active until she sets one live.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_club_id TEXT := 'ora-fitness-cork';

  -- Flow IDs
  v_flow_main        UUID;
  v_flow_classes     UUID;
  v_flow_booking     UUID;
  v_flow_pricing     UUID;
  v_flow_location    UUID;

  -- Step IDs
  v_step_main_1      UUID;
  v_step_classes_1   UUID;
  v_step_booking_1   UUID;
  v_step_pricing_1   UUID;
  v_step_location_1  UUID;
BEGIN

  -- ── Generate UUIDs ────────────────────────────────────────────────────────
  v_flow_main       := gen_random_uuid();
  v_flow_classes    := gen_random_uuid();
  v_flow_booking    := gen_random_uuid();
  v_flow_pricing    := gen_random_uuid();
  v_flow_location   := gen_random_uuid();

  v_step_main_1     := gen_random_uuid();
  v_step_classes_1  := gen_random_uuid();
  v_step_booking_1  := gen_random_uuid();
  v_step_pricing_1  := gen_random_uuid();
  v_step_location_1 := gen_random_uuid();

  -- ── Flows (all inactive) ──────────────────────────────────────────────────
  INSERT INTO public.chat_workflows (id, club_id, name, is_active)
  VALUES
    (v_flow_main,     v_club_id, 'Ora Fitness — Main Menu', false),
    (v_flow_classes,  v_club_id, 'Our Classes',             false),
    (v_flow_booking,  v_club_id, 'Book a Class',            false),
    (v_flow_pricing,  v_club_id, 'Pricing & Membership',    false),
    (v_flow_location, v_club_id, 'Find Us',                 false);

  -- ── Steps ─────────────────────────────────────────────────────────────────
  INSERT INTO public.workflow_steps (id, workflow_id, step_order, bot_message)
  VALUES

    -- Main Menu
    (v_step_main_1, v_flow_main, 1,
      'Hi there 👋 I''m Maeve, the Ora Fitness Cork assistant.' || chr(10) || chr(10) ||
      'What can I help you with today?'),

    -- Our Classes
    -- [FILL IN] Replace with Ora's actual class names and descriptions
    (v_step_classes_1, v_flow_classes, 1,
      'Here''s what we offer at Ora Fitness Cork:' || chr(10) || chr(10) ||
      '🏋️ [Class name] — [Short description]' || chr(10) ||
      '🏋️ [Class name] — [Short description]' || chr(10) ||
      '🏋️ [Class name] — [Short description]' || chr(10) || chr(10) ||
      'All classes are suitable for all fitness levels — no experience needed!'),

    -- Book a Class
    -- [FILL IN] Replace the URL below with the actual booking/contact link
    (v_step_booking_1, v_flow_booking, 1,
      'Great — you can book a class or get in touch using the link below.' || chr(10) || chr(10) ||
      'We''d love to have you join us! 🙌'),

    -- Pricing & Membership
    -- [FILL IN] Replace with Ora's actual pricing options
    (v_step_pricing_1, v_flow_pricing, 1,
      'Here''s an overview of our options:' || chr(10) || chr(10) ||
      '💳 [Option 1] — €[price]' || chr(10) ||
      '💳 [Option 2] — €[price]' || chr(10) ||
      '💳 [Option 3] — €[price]' || chr(10) || chr(10) ||
      'Not sure what suits you? Get in touch and we''ll help you find the right fit.'),

    -- Find Us
    -- [FILL IN] Replace with actual address, hours, and parking info
    (v_step_location_1, v_flow_location, 1,
      '📍 We''re located at:' || chr(10) ||
      '[Full address, Carrigaline / Cork]' || chr(10) || chr(10) ||
      '🕐 Class times:' || chr(10) ||
      '[e.g. Mon/Wed/Fri — 9:30am, 6:00pm]' || chr(10) || chr(10) ||
      '[Parking info if relevant]');

  -- ── Choices: Main Menu ────────────────────────────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_main_1, 1, '🏋️ Our classes',       'switch_flow', v_flow_classes::text),
    (v_step_main_1, 2, '📅 Book a class',       'switch_flow', v_flow_booking::text),
    (v_step_main_1, 3, '💳 Pricing',            'switch_flow', v_flow_pricing::text),
    (v_step_main_1, 4, '📍 Find us',            'switch_flow', v_flow_location::text),
    (v_step_main_1, 5, '💬 Something else',     'ai_fallback', null);

  -- ── Choices: Our Classes ──────────────────────────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_classes_1, 1, '📅 Book a class',    'switch_flow', v_flow_booking::text),
    (v_step_classes_1, 2, '← Back to menu',     'switch_flow', v_flow_main::text);

  -- ── Choices: Book a Class ─────────────────────────────────────────────────
  -- [FILL IN] Replace the URL with the real booking/contact page URL
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_booking_1, 1, '📋 Go to booking form', 'url',        'https://orafitnesscork.com/contact'),
    (v_step_booking_1, 2, '← Back to menu',        'switch_flow', v_flow_main::text);

  -- ── Choices: Pricing & Membership ────────────────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_pricing_1, 1, '📅 Book a class',    'switch_flow', v_flow_booking::text),
    (v_step_pricing_1, 2, '← Back to menu',     'switch_flow', v_flow_main::text);

  -- ── Choices: Find Us ──────────────────────────────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_location_1, 1, '📅 Book a class',   'switch_flow', v_flow_booking::text),
    (v_step_location_1, 2, '← Back to menu',    'switch_flow', v_flow_main::text);

END $$;
