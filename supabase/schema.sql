-- Diet OS Supabase schema
-- Run this entire file once in Supabase Dashboard > SQL Editor.

create table if not exists public.daily_metrics (
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  weight numeric,
  waist numeric,
  thigh numeric,
  calf numeric,
  sleep numeric,
  steps integer,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

create table if not exists public.food_entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  date date not null,
  meal text not null,
  name text not null,
  kcal numeric not null default 0,
  protein numeric not null default 0,
  memo text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.workout_logs (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  date date not null,
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.daily_metrics enable row level security;
alter table public.food_entries enable row level security;
alter table public.workout_logs enable row level security;

drop policy if exists "own daily metrics" on public.daily_metrics;
create policy "own daily metrics"
on public.daily_metrics for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "own food entries" on public.food_entries;
create policy "own food entries"
on public.food_entries for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "own workout logs" on public.workout_logs;
create policy "own workout logs"
on public.workout_logs for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shared-reports', 'shared-reports', false, 1048576, array['application/json'])
on conflict (id) do update
set public=false,
    file_size_limit=1048576,
    allowed_mime_types=array['application/json'];

drop policy if exists "upload own shared reports" on storage.objects;
create policy "upload own shared reports"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'shared-reports'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "read own shared reports" on storage.objects;
create policy "read own shared reports"
on storage.objects for select to authenticated
using (
  bucket_id = 'shared-reports'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "delete own shared reports" on storage.objects;
create policy "delete own shared reports"
on storage.objects for delete to authenticated
using (
  bucket_id = 'shared-reports'
  and (storage.foldername(name))[1] = auth.uid()::text
);
