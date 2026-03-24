-- Run in the Supabase SQL editor for this project.
-- Assumes `profiles` table already exists from earlier assignments with:
--   id uuid references auth.users(id)
--   is_superadmin boolean
--   is_matrix_admin boolean

create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.humor_flavors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.humor_flavor_steps (
  id uuid primary key default gen_random_uuid(),
  humor_flavor_id uuid not null references public.humor_flavors(id) on delete cascade,
  title text not null,
  prompt text not null,
  step_order integer not null check (step_order > 0),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.humor_flavor_caption_runs (
  id uuid primary key default gen_random_uuid(),
  humor_flavor_id uuid not null references public.humor_flavors(id) on delete cascade,
  image_name text not null,
  image_id uuid not null,
  captions jsonb not null default '[]'::jsonb,
  raw_response jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

drop trigger if exists set_humor_flavors_updated_at on public.humor_flavors;
create trigger set_humor_flavors_updated_at
before update on public.humor_flavors
for each row execute function public.set_updated_at();

drop trigger if exists set_humor_flavor_steps_updated_at on public.humor_flavor_steps;
create trigger set_humor_flavor_steps_updated_at
before update on public.humor_flavor_steps
for each row execute function public.set_updated_at();

alter table public.humor_flavors enable row level security;
alter table public.humor_flavor_steps enable row level security;
alter table public.humor_flavor_caption_runs enable row level security;

drop policy if exists humor_flavors_admin_only on public.humor_flavors;
create policy humor_flavors_admin_only
on public.humor_flavors
for all
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and (profiles.is_superadmin = true or profiles.is_matrix_admin = true)
  )
)
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and (profiles.is_superadmin = true or profiles.is_matrix_admin = true)
  )
);

drop policy if exists humor_flavor_steps_admin_only on public.humor_flavor_steps;
create policy humor_flavor_steps_admin_only
on public.humor_flavor_steps
for all
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and (profiles.is_superadmin = true or profiles.is_matrix_admin = true)
  )
)
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and (profiles.is_superadmin = true or profiles.is_matrix_admin = true)
  )
);

drop policy if exists humor_flavor_caption_runs_admin_only on public.humor_flavor_caption_runs;
create policy humor_flavor_caption_runs_admin_only
on public.humor_flavor_caption_runs
for all
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and (profiles.is_superadmin = true or profiles.is_matrix_admin = true)
  )
)
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and (profiles.is_superadmin = true or profiles.is_matrix_admin = true)
  )
);
