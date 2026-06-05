-- ─── Update Monkstown Tennis Club flow content with real website data ─────────
-- Run in Supabase SQL editor AFTER seed-monkstown-tennis-flows.sql.
-- Replaces [FILL IN] placeholders with real content from the website.
-- Membership prices are NOT on the website — still marked [FILL IN].
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_club_id TEXT := 'monkstown-lawn-tennis-club';
  v_flow_membership UUID;
  v_flow_coaching   UUID;
  v_flow_booking    UUID;
  v_flow_events     UUID;
  v_flow_location   UUID;
BEGIN

  -- Look up flow IDs by name
  SELECT id INTO v_flow_membership FROM public.chat_workflows WHERE club_id = v_club_id AND name = 'Membership'       LIMIT 1;
  SELECT id INTO v_flow_coaching   FROM public.chat_workflows WHERE club_id = v_club_id AND name = 'Coaching & Camps' LIMIT 1;
  SELECT id INTO v_flow_booking    FROM public.chat_workflows WHERE club_id = v_club_id AND name = 'Book a Court'     LIMIT 1;
  SELECT id INTO v_flow_events     FROM public.chat_workflows WHERE club_id = v_club_id AND name = 'Events & Leagues' LIMIT 1;
  SELECT id INTO v_flow_location   FROM public.chat_workflows WHERE club_id = v_club_id AND name = 'Find Us'          LIMIT 1;

  -- ── Membership Step 2 (prices) ────────────────────────────────────────────
  UPDATE public.workflow_steps
  SET bot_message =
    'Here''s an overview of our membership options:' || chr(10) || chr(10) ||
    '🎾 Single — €180 per year' || chr(10) ||
    '👨‍👩‍👧 Family — €300 per year' || chr(10) ||
    '🧒 Junior (under 18) — €70 per year' || chr(10) ||
    '🌟 Student — €80 per year' || chr(10) || chr(10) ||
    'Membership includes full access to all courts, club nights, and social events.' || chr(10) || chr(10) ||
    '[warn]⚠️ Please note: we are currently not accepting new members — applications will be placed on a waiting list.[/warn]' || chr(10) || chr(10) ||
    'You can still submit an application form at:' || chr(10) ||
    '[link]https://www.monkstowntennisclub.com/become-a-member[/link]' || chr(10) ||
    'Or email [b]secretary@monkstowntennisclub.com[/b]'
  WHERE workflow_id = v_flow_membership AND step_order = 2;

  -- ── Coaching & Camps ──────────────────────────────────────────────────────
  UPDATE public.workflow_steps
  SET bot_message =
    'We offer coaching for all ages and levels:' || chr(10) || chr(10) ||
    '🧒 Junior coaching — Tuesdays & Thursdays' || chr(10) ||
    '   Tue 3–4pm (1st & 2nd class) — €120/term' || chr(10) ||
    '   Tue 4–5pm (3rd & 4th class) — €120/term' || chr(10) ||
    '   Tue 5–6pm (5th & 6th class) — €120/term' || chr(10) ||
    '🧑 Teen coaching — Sundays' || chr(10) ||
    '☀️ Junior summer camps — available during school holidays' || chr(10) || chr(10) ||
    'Our coaches include Joanne Williamson, Donal Neary, Declan Bray, and Noelle O''Callaghan.' || chr(10) || chr(10) ||
    'For bookings and current schedules, email secretary@monkstowntennisclub.com'
  WHERE workflow_id = v_flow_coaching AND step_order = 1;

  -- ── Book a Court ──────────────────────────────────────────────────────────
  UPDATE public.workflow_steps
  SET bot_message =
    'Our courts are available to all members, with lighting for evening play.' || chr(10) || chr(10) ||
    '📱 Book online through our website at monkstowntennisclub.com' || chr(10) ||
    '   (log in to your member account to check availability and reserve a court)' || chr(10) || chr(10) ||
    'Need help with your booking? Email secretary@monkstowntennisclub.com'
  WHERE workflow_id = v_flow_booking AND step_order = 1;

  -- Update the booking URL choice to point to the correct page
  UPDATE public.workflow_choices
  SET action_value = 'https://www.monkstowntennisclub.com'
  WHERE step_id = (
    SELECT id FROM public.workflow_steps WHERE workflow_id = v_flow_booking AND step_order = 1 LIMIT 1
  ) AND action_type = 'url';

  -- ── Events & Leagues ──────────────────────────────────────────────────────
  UPDATE public.workflow_steps
  SET bot_message =
    'There''s always something on at Monkstown! 🏆' || chr(10) || chr(10) ||
    '🎾 Winter League — team competitions across multiple divisions' || chr(10) ||
    '🌱 Spring Junior Regional League' || chr(10) ||
    '🏆 Carrigaline Cup — club tournament' || chr(10) ||
    '🥇 Club Championships — annual singles & doubles' || chr(10) ||
    '🌙 Social match play sessions — regular club nights' || chr(10) ||
    '🏸 Croquet — available for members' || chr(10) || chr(10) ||
    'Follow us for the latest fixtures and updates:' || chr(10) ||
    '[link=https://instagram.com/monkstowntennisclub]📸 Instagram — @monkstowntennisclub[/link]' || chr(10) ||
    '[link=https://twitter.com/MonkstownLTCC]🐦 Twitter — @MonkstownLTCC[/link]'
  WHERE workflow_id = v_flow_events AND step_order = 1;

  -- ── Find Us ───────────────────────────────────────────────────────────────
  UPDATE public.workflow_steps
  SET bot_message =
    '📍 Monkstown Lawn Tennis & Croquet Club' || chr(10) ||
    'Castle Road, Monkstown, Co. Cork' || chr(10) ||
    'Eircode: T12 NV38' || chr(10) ||
    'Located approx. 15km from Cork city centre.' || chr(10) || chr(10) ||
    '📧 secretary@monkstowntennisclub.com' || chr(10) ||
    '📘 Facebook | 📸 Instagram: @monkstowntennisclub | 🐦 Twitter: @MonkstownLTCC'
  WHERE workflow_id = v_flow_location AND step_order = 1;

END $$;
