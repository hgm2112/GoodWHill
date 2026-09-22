-- ============================================================================
-- GoodWHill — initial schema
-- Run with the Supabase SQL editor or: supabase db push
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Profiles (one row per auth user, created automatically on signup)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  display_name text,
  ebay_username text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- upc_catalog — shared global lookup of scanned product barcodes.
-- Universal data: a UPC maps to a product regardless of owner. Any
-- authenticated user may read; anyone may contribute entries. Price cache
-- columns live here so a lookup isn't repeated per user.
-- ---------------------------------------------------------------------------
create table public.upc_catalog (
  upc                    text primary key,
  name                   text not null,
  set_code               text,
  ebay_category_id       text,
  image_url              text,
  ebay_avg_value_cents   int,
  ebay_median_value_cents int,
  price_source           text,
  price_sample_count     int,
  price_checked_at       timestamptz,
  active                 boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- items — the core inventory table
-- ---------------------------------------------------------------------------
create type public.item_kind as enum ('sealed', 'bulk_cards', 'other');

create table public.items (
  id                     uuid primary key default gen_random_uuid(),
  owner_id               uuid not null references auth.users (id) on delete cascade,
  name                   text not null,
  kind                   public.item_kind not null default 'other',
  upc                    text,
  set_code               text,
  category               text,
  quantity               int not null default 0 check (quantity >= 0),
  unit_cost_cents        int,
  value_cents            int,
  ebay_avg_value_cents   int,
  price_source           text,
  price_sample_count     int,
  price_checked_at       timestamptz,
  image_url              text,
  notes                  text,
  active                 boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint items_upc_unique unique (owner_id, upc)
);

create index items_owner_kind_idx on public.items (owner_id, kind);
create index items_owner_upc_idx on public.items (owner_id, upc) where upc is not null;
create index items_owner_name_idx on public.items (owner_id);

-- ---------------------------------------------------------------------------
-- item_movements — audit ledger for every quantity change
-- ---------------------------------------------------------------------------
create table public.item_movements (
  id         bigint generated always as identity primary key,
  item_id    uuid not null references public.items (id) on delete cascade,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  delta      int not null,
  reason     text not null,
  ref_id     uuid,
  note       text,
  created_at timestamptz not null default now()
);

create index item_movements_item_idx on public.item_movements (item_id, created_at desc);

-- ---------------------------------------------------------------------------
-- bundles + bundle_items — generated random value bundles
-- ---------------------------------------------------------------------------
create type public.bundle_status as enum ('draft', 'allocated', 'listed', 'sold', 'cancelled');

create table public.bundles (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references auth.users (id) on delete cascade,
  name                text not null,
  target_value_cents  int not null,
  total_value_cents   int not null,
  status              public.bundle_status not null default 'draft',
  ebay_listing_id     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index bundles_owner_idx on public.bundles (owner_id, created_at desc);

create table public.bundle_items (
  id                uuid primary key default gen_random_uuid(),
  bundle_id         uuid not null references public.bundles (id) on delete cascade,
  item_id           uuid not null references public.items (id) on delete restrict,
  quantity          int not null check (quantity > 0),
  value_cents       int not null,
  unit_cost_cents   int,
  unique (bundle_id, item_id)
);

-- ---------------------------------------------------------------------------
-- allocations — stock reserved (and later released/sold) for a bundle
-- ---------------------------------------------------------------------------
create table public.allocations (
  id           uuid primary key default gen_random_uuid(),
  bundle_id    uuid not null references public.bundles (id) on delete cascade,
  item_id      uuid not null references public.items (id) on delete restrict,
  quantity     int not null check (quantity > 0),
  status       text not null default 'allocated'
               check (status in ('allocated', 'sold', 'released')),
  created_at   timestamptz not null default now(),
  released_at  timestamptz,
  release_note text
);

create index allocations_bundle_idx on public.allocations (bundle_id);
create index allocations_item_idx on public.allocations (item_id);

-- ---------------------------------------------------------------------------
-- listing_drafts — editable eBay listing text generated from bundles
-- ---------------------------------------------------------------------------
create table public.listing_drafts (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  bundle_id       uuid references public.bundles (id) on delete set null,
  title           text not null,
  description     text not null,
  image_urls      text[] not null default '{}',
  ebay_listing_id text,
  status          text not null default 'draft' check (status in ('draft', 'published')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index listing_drafts_owner_idx on public.listing_drafts (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- sales — record of every sale
-- ---------------------------------------------------------------------------
create table public.sales (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  item_id       uuid references public.items (id) on delete restrict,
  bundle_id     uuid references public.bundles (id) on delete restrict,
  ebay_order_id text,
  ebay_item_id  text,
  gross_cents   int not null,
  fee_cents     int not null default 0,
  shipping_cents int not null default 0,
  net_cents     int not null,
  quantity      int not null default 1 check (quantity > 0),
  buyer         text,
  note          text,
  sold_at       timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index sales_owner_idx on public.sales (owner_id, sold_at desc);
create unique index sales_owner_order_unique on public.sales (owner_id, ebay_order_id)
  where ebay_order_id is not null;

-- ---------------------------------------------------------------------------
-- listings — synced from the seller's eBay account
-- ---------------------------------------------------------------------------
create table public.listings (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users (id) on delete cascade,
  ebay_listing_id    text not null,
  title              text not null,
  price_cents        int,
  currency           text not null default 'USD',
  status             text not null default 'ACTIVE',
  quantity_available int,
  quantity_sold      int,
  item_uri           text,
  image_urls         text[] not null default '{}',
  item_id            uuid references public.items (id) on delete set null,
  bundle_id          uuid references public.bundles (id) on delete set null,
  ended_at           timestamptz,
  last_synced_at     timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  unique (owner_id, ebay_listing_id)
);

create index listings_owner_status_idx on public.listings (owner_id, status);

-- ---------------------------------------------------------------------------
-- ebay_tokens — OAuth vault (inaccessible to app roles; service-role only)
-- ---------------------------------------------------------------------------
create table public.ebay_tokens (
  owner_id      uuid primary key references auth.users (id) on delete cascade,
  access_token  text,
  refresh_token text not null,
  expires_at    timestamptz,
  scope         text,
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger items_updated_at  before update on public.items  for each row execute function public.set_updated_at();
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger bundles_updated_at before update on public.bundles for each row execute function public.set_updated_at();
create trigger drafts_updated_at  before update on public.listing_drafts for each row execute function public.set_updated_at();
create trigger catalog_updated_at before update on public.upc_catalog for each row execute function public.set_updated_at();
create trigger tokens_updated_at  before update on public.ebay_tokens for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Create a profile row automatically on signup
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email,
          coalesce(nullif(split_part(new.email, '@', 1), ''), 'User'));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles         enable row level security;
alter table public.upc_catalog      enable row level security;
alter table public.items            enable row level security;
alter table public.item_movements   enable row level security;
alter table public.bundles          enable row level security;
alter table public.bundle_items     enable row level security;
alter table public.allocations      enable row level security;
alter table public.sales            enable row level security;
alter table public.listings         enable row level security;
alter table public.listing_drafts   enable row level security;
alter table public.ebay_tokens      enable row level security;

-- Owner-scoped tables: users can touch only their own rows.
create policy "profiles_own" on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

create policy "items_own" on public.items
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "movements_own" on public.item_movements
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "bundles_own" on public.bundles
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "bundle_items_own" on public.bundle_items
  for all using (
    exists (select 1 from public.bundles b where b.id = bundle_items.bundle_id and b.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.bundles b where b.id = bundle_items.bundle_id and b.owner_id = auth.uid())
  );

create policy "allocations_own" on public.allocations
  for all using (
    exists (select 1 from public.bundles b where b.id = allocations.bundle_id and b.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.bundles b where b.id = allocations.bundle_id and b.owner_id = auth.uid())
  );

create policy "sales_own" on public.sales
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "listings_own" on public.listings
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "drafts_own" on public.listing_drafts
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Shared catalog: anyone signed in can read; contributors may add/update.
create policy "catalog_read" on public.upc_catalog
  for select using (auth.role() = 'authenticated');

create policy "catalog_write" on public.upc_catalog
  for insert to authenticated with check (true);

create policy "catalog_update" on public.upc_catalog
  for update to authenticated using (true) with check (true);

-- ebay_tokens: no app-role policies → anon/authenticated can never access.
-- Only the service role (which bypasses RLS) reads/writes this table.
revoke all on public.ebay_tokens from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Default privileges so the PostgREST roles can read/write tables and any
-- tables created later. Functions are intentionally NOT granted to anon.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;