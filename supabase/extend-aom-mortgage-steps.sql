-- ─── Extend AOM Mortgage Enquiry flow ─────────────────────────────────────
-- Adds Steps 3-5 to the Mortgage Enquiry flow and updates Step 2's choices
-- to chain into them before handing off to AI.
--
-- Step 2 (buyer type)     → next_step 3
-- Step 3 (employment)     → next_step 4
-- Step 4 (existing loans) → next_step 5
-- Step 5 (property found) → ai_fallback (AI takes over)
--
-- Run once in Supabase SQL editor.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_flow_mort   UUID;
  v_step_mort_2 UUID;
  v_step_mort_3 UUID;
  v_step_mort_4 UUID;
  v_step_mort_5 UUID;
BEGIN

  -- Find the Mortgage Enquiry flow
  SELECT id INTO v_flow_mort
  FROM public.chat_workflows
  WHERE club_id = 'aom' AND name = 'Mortgage Enquiry'
  LIMIT 1;

  IF v_flow_mort IS NULL THEN
    RAISE EXCEPTION 'Mortgage Enquiry flow not found for AOM — run seed-aom-flows.sql first.';
  END IF;

  -- Find Step 2 (buyer type)
  SELECT id INTO v_step_mort_2
  FROM public.workflow_steps
  WHERE workflow_id = v_flow_mort AND step_order = 2
  LIMIT 1;

  -- Generate IDs for new steps
  v_step_mort_3 := gen_random_uuid();
  v_step_mort_4 := gen_random_uuid();
  v_step_mort_5 := gen_random_uuid();

  -- ── Add Steps 3, 4, 5 ──────────────────────────────────────────────────
  INSERT INTO public.workflow_steps (id, workflow_id, step_order, bot_message)
  VALUES
    (v_step_mort_3, v_flow_mort, 3,
      'And are you PAYE, self-employed, or a contractor?'),

    (v_step_mort_4, v_flow_mort, 4,
      'Do you have any existing loans or financial commitments?' || chr(10) || chr(10) ||
      'For example, car finance, personal loans, or credit cards.'),

    (v_step_mort_5, v_flow_mort, 5,
      'Have you found a property yet?');

  -- ── Update Step 2 choices: chain to Step 3 instead of ai_fallback ──────
  UPDATE public.workflow_choices
  SET action_type = 'next_step', action_value = '3'
  WHERE step_id = v_step_mort_2
    AND label IN ('First-time buyer', 'Switching', 'Remortgaging', 'Something else');

  -- ── Step 3 choices: employment type → Step 4 ───────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_mort_3, 1, 'PAYE',          'next_step', '4'),
    (v_step_mort_3, 2, 'Self-employed', 'next_step', '4'),
    (v_step_mort_3, 3, 'Contractor',    'next_step', '4');

  -- ── Step 4 choices: existing loans → Step 5 ────────────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_mort_4, 1, 'None',        'next_step', '5'),
    (v_step_mort_4, 2, 'I have some', 'next_step', '5');

  -- ── Step 5 choices: property found → AI takes over ─────────────────────
  INSERT INTO public.workflow_choices (step_id, choice_order, label, action_type, action_value)
  VALUES
    (v_step_mort_5, 1, 'Yes, I''ve found a property', 'ai_fallback', null),
    (v_step_mort_5, 2, 'Not yet',                     'ai_fallback', null);

END $$;
