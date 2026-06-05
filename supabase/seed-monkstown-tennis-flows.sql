-- ─── Seed Monkstown Lawn Tennis Club Chat Flows ──────────────────────────────
-- Run once in Supabase SQL editor.
-- After running, edit [FILL IN] sections in portal → Chat Flows.
-- None of the flows are active until one is set live.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_club_id TEXT := 'monkstown-lawn-tennis-club';

  -- Flow IDs
  v_flow_main        UUID;
  v_flow_membership  UUID;
  v_flow_coaching    UUID;
  v_flow_booking     UUID;
  v_flow_events      UUID;
  v_flow_location    UUID;

  -- Step IDs
  v_step_main_1      UUID;
  v_step_memb_1      UUID;
  v_step_memb_2      UUID;
  v_step_coach_1     UUID;
  v_step_book_1      UUID;
  v_step_events_1    UUID;
  v_step_loc_1       UUID;
BEGIN

  -- ── Generate UUIDs ────────────────────────────────────────────────────────
  v_flow_main       := gen_random_uuid();
  v_flow_membership := gen_random_uuid();
  v_flow_coaching   := gen_random_uuid();
  v_flow_booking    := gen_random_uuid();
  v_flow_events     := gen_random_uuid();
  v_flow_location   := gen_random_uuid();

  v_step_main_1     := gen_random_uuid();
  v_step_memb_1     := gen_random_uuid();
  v_step_memb_2     := gen_random_uuid();
  v_step_coach_1    := gen_random_uuid();
  v_step_book_1     := gen_random_uuid();
  v_step_events_1   := gen_random_uuid();
  v_step_loc_1      := gen_random_uuid();

  -- ── Flows (all inactive) ──────────────────────────────────────────────────
  INSERT INTO public.chat_workflows (id, club_id, name, is_active)
  VALUES
    (v_flow_main,       v_club_id, 'Main Menu',          false),
    (v_flow_membership, v_club_id, 'Membership',         false),
    (v_flow_coaching,   v_club_id, 'Coaching & Camps',   false),
    (v_flow_booking,    v_club_id, 'Book a Court',       false),
    (v_flow_events,     v_club_id, 'Events & Leagues',   false),
    (v_flow_location,   v_club_id, 'Find Us',            false);

  -- ── Steps ─────────────────────────────────────────────────────────────────
  INSERT INTO public.workflow_steps (id, workflow_id, step_order, bot_message)
  VALUES

    -- Main Menu
    (v_step_main_1, v_flow_main, 1,
      'Hi there 👋 Welcome to Monkstown Lawn Tennis & Croquet Club!' || chr(10) || chr(10) ||
      'What can I help you with today?'),

    -- Membership — Step 1: which type?
    (v_step_memb_1, v_flow_membership, 1,
      'Great — we have membership options for all ages and levels.' || chr(10) || chr(10) ||
      'Are you looking to join as an adult, a junior, or a family?'),

    -- Membership — Step 2: details
    -- [FILL IN] Replace with actual membership categories and prices
    (v_step_memb_2, v_flow_membership, 2,
      'Here''s an overview of our membership options:' || chr(10) || chr(10) ||
      '🎾 Adult — €[price] per year' || chr(10) ||
      '👨‍👩‍👧 Family — €[price] per year' || chr(10) ||
      '🧒 Junior (under 18) — €[price] per year' || chr(10) ||
      '🌟 Student — €[price] per year' || chr(10) || chr(10) ||
      'Membership includes full access to all courts, club nights, and social events.' || chr(10) || chr(10) ||
      'To join, [FILL IN: describe how to sign up — online form / contact club secretary etc.]'),

    -- Coaching & Camps
    -- [FILL IN] Replace with actual coaching programmes and camp dates
    (v_step_coach_1, v_flow_coaching, 1,
      'We offer professional coaching for all ages and abilities:' || chr(10) || chr(10) ||
      '🎾 Adult group lessons — [days/times]' || chr(10) ||
      '🎾 Beginner courses — [details]' || chr(10) ||
      '🧒 Junior coaching — [days/times]' || chr(10) ||
      '☀️ Junior summer camps — [dates/ages]' || chr(10) || chr(10) ||
      'To enquire about coaching or book a place on a camp, [FILL IN: contact details or link]'),

    -- Book a Court
    -- [FILL IN] Update with actual booking method (app, phone, online system)
    (v_step_book_1, v_flow_booking, 1,
      'Our courts are available to all members with lighting for evening play.' || chr(10) || chr(10) ||
      '📱 To book a court: [FILL IN — e.g. use our court booking app / call the club / visit website]' || chr(10) || chr(10) ||
      'Courts are available [FILL IN: hours, e.g. 8am–10pm daily].'),

    -- Events & Leagues
    -- [FILL IN] Replace with actual events, leagues, and competition calendar
    (v_step_events_1, v_flow_events, 1,
      'There''s always something on at Monkstown! 🏆' || chr(10) || chr(10) ||
      '🎾 Winter League — [FILL IN: dates/format]' || chr(10) ||
      '🏆 Club Championships — [FILL IN: dates]' || chr(10) ||
      '🌙 Club nights — [FILL IN: day/time]' || chr(10) ||
      '🏸 Croquet — [FILL IN: open to members/public, sessions]' || chr(10) || chr(10) ||
      'Keep an eye on our website or social media for the latest fixtures and events.'),

    -- Find Us
    (v_step_loc_1, v_flow_location, 1,
      '📍 Monkstown Lawn Tennis & Croquet Club' || chr(10) ||
      '[FILL IN: full address]' || chr(10) ||
      'Located approx. 15km from Cork city centre.' || chr(10) || chr(10) ||
      '🚗 Parking: [FILL IN]' || chr(10) ||
      '🚌 By bus: [FILL IN if applicable]' || chr(10) || chr(10) ||
      '📞 Contact: [FILL IN: phone / email]');

  -- ── Choices: Main Menu ────────────────────────────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_main_1, 1, '🎾 Membership',        'switch_flow', v_flow_membership::text),
    (v_step_main_1, 2, '🏫 Coaching & camps',  'switch_flow', v_flow_coaching::text),
    (v_step_main_1, 3, '📅 Book a court',      'switch_flow', v_flow_booking::text),
    (v_step_main_1, 4, '🏆 Events & leagues',  'switch_flow', v_flow_events::text),
    (v_step_main_1, 5, '📍 Find us',           'switch_flow', v_flow_location::text),
    (v_step_main_1, 6, '💬 Something else',    'ai_fallback', null);

  -- ── Choices: Membership Step 1 (who are you joining as?) ─────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_memb_1, 1, 'Adult',           'next_step', '2'),
    (v_step_memb_1, 2, 'Family',          'next_step', '2'),
    (v_step_memb_1, 3, 'Junior / Student','next_step', '2');

  -- ── Choices: Membership Step 2 (pricing shown, next action) ──────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_memb_2, 1, '✅ I''d like to join', 'url',         'https://www.monkstowntennisclub.com/become-a-member'),
    (v_step_memb_2, 2, '← Back to menu',       'switch_flow',  v_flow_main::text);

  -- ── Choices: Coaching & Camps ─────────────────────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_coach_1, 1, '✅ I''d like to book', 'ai_fallback', null),
    (v_step_coach_1, 2, '← Back to menu',       'switch_flow', v_flow_main::text);

  -- ── Choices: Book a Court ─────────────────────────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_book_1, 1, '💬 I have a question', 'ai_fallback', null),
    (v_step_book_1, 2, '← Back to menu',       'switch_flow', v_flow_main::text);

  -- ── Choices: Events & Leagues ─────────────────────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_events_1, 1, '🎾 I''d like to enter',  'ai_fallback', null),
    (v_step_events_1, 2, '← Back to menu',          'switch_flow', v_flow_main::text);

  -- ── Choices: Find Us ──────────────────────────────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_loc_1, 1, '← Back to main menu', 'switch_flow', v_flow_main::text);

END $$;
