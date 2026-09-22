-- ============================================================================
-- GoodWHill — named storage locations + remembered scan box
-- Additive over 0001_init.sql. Idempotent: safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- locations — the seller's named places where items are stored
-- (e.g. "Box 1", "Cardboard Box 2", "Loose"). Owner-scoped.
-- ---------------------------------------------------------------------------
create table if not exists public.locations (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name),
  constraint locations_name_not_blank check (length(trim(name)) > 0)
);

create index if not exists locations_owner_idx on public.locations (owner_id, name);

-- ---------------------------------------------------------------------------
-- items.location_id — where this item line is stored
-- ---------------------------------------------------------------------------
alter table public.items
  add column if not exists location_id uuid references public.locations (id) on delete set null;

create index if not exists items_owner_location_idx on public.items (owner_id, location_id);

-- ---------------------------------------------------------------------------
-- profiles.default_location_id — the remembered quick-scan box
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists default_location_id uuid references public.locations (id) on delete set null;

-- ---------------------------------------------------------------------------
-- RLS + grants + trigger for locations
-- ---------------------------------------------------------------------------
alter table public.locations enable row level security;

create policy "locations_own" on public.locations
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

grant all on public.locations to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;

create trigger locations_updated_at
  before update on public.locations
  for each row execute function public.set_updated_at();