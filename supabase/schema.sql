-- OPTIONAL future cloud sync. Run in a dedicated KIN Supabase project, not in CONSOL.
-- Exposes private per-user profiles and recognition feedback only to their owner.
create table if not exists public.kin_profiles (
  id text not null,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  profile jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, id),
  constraint kin_profile_object check (jsonb_typeof(profile) = 'object')
);
create table if not exists public.kin_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  profile_id text not null,
  cue_id text,
  method text not null check (method in ('Movement','Sound','Scene')),
  phrase text,
  confirmed boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists kin_events_owner_date on public.kin_events(owner_id,created_at desc);
alter table public.kin_profiles enable row level security;
alter table public.kin_events enable row level security;
revoke all on public.kin_profiles, public.kin_events from anon;
grant select, insert, update, delete on public.kin_profiles, public.kin_events to authenticated;
create policy "Owners read their KIN profiles" on public.kin_profiles for select to authenticated using (owner_id = (select auth.uid()));
create policy "Owners add their KIN profiles" on public.kin_profiles for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "Owners edit their KIN profiles" on public.kin_profiles for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Owners delete their KIN profiles" on public.kin_profiles for delete to authenticated using (owner_id = (select auth.uid()));
create policy "Owners read KIN events" on public.kin_events for select to authenticated using (owner_id = (select auth.uid()));
create policy "Owners add KIN events" on public.kin_events for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "Owners delete KIN events" on public.kin_events for delete to authenticated using (owner_id = (select auth.uid()));
-- No anonymous writes and no service-role key in the browser.
-- This is a schema proposal only: this version of KIN has no cloud sync client.
