-- ─── Chat Workflow Builder ────────────────────────────────────────────────────
-- Run once in Supabase SQL editor.
-- Creates 3 tables: chat_workflows, workflow_steps, workflow_choices.

create table if not exists public.chat_workflows (
  id          uuid        primary key default gen_random_uuid(),
  club_id     text        not null,
  name        text        not null default 'Default Workflow',
  is_active   boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.workflow_steps (
  id          uuid        primary key default gen_random_uuid(),
  workflow_id uuid        not null references public.chat_workflows(id) on delete cascade,
  step_order  integer     not null default 1,
  bot_message text        not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.workflow_choices (
  id           uuid    primary key default gen_random_uuid(),
  step_id      uuid    not null references public.workflow_steps(id) on delete cascade,
  choice_order integer not null default 0,
  label        text    not null,
  -- next_step  → action_value = step_order number as text ("2")
  -- message    → action_value = text to display
  -- url        → action_value = URL to open
  -- ai_fallback → action_value ignored, hands off to AI chat
  action_type  text    not null default 'message'
                       check (action_type in ('next_step','message','url','ai_fallback')),
  action_value text,
  created_at   timestamptz not null default now()
);

-- Row Level Security: the backend always uses the service_role key which bypasses RLS.
-- These policies exist as a safety net.
alter table public.chat_workflows   enable row level security;
alter table public.workflow_steps   enable row level security;
alter table public.workflow_choices enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='chat_workflows' and policyname='service_role_all_chat_workflows') then
    execute 'create policy "service_role_all_chat_workflows" on public.chat_workflows for all using (true) with check (true)';
  end if;
  if not exists (select 1 from pg_policies where tablename='workflow_steps' and policyname='service_role_all_workflow_steps') then
    execute 'create policy "service_role_all_workflow_steps" on public.workflow_steps for all using (true) with check (true)';
  end if;
  if not exists (select 1 from pg_policies where tablename='workflow_choices' and policyname='service_role_all_workflow_choices') then
    execute 'create policy "service_role_all_workflow_choices" on public.workflow_choices for all using (true) with check (true)';
  end if;
end $$;
