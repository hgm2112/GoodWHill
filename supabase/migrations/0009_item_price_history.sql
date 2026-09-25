-- ============================================================================
-- goodwhilly — item price history over time
-- One row per recorded value change (plus a first-ever baseline), so items
-- can chart their value across refreshes and manual edits. Snapshots are
-- written by src/lib/price-history.ts: only when the value differs from the
-- latest snapshot (or none exists yet). Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.item_price_history (
  id           bigint generated always as identity primary key,
  owner_id     uuid not null references auth.users (id) on delete cascade,
  item_id      uuid not null references public.items (id) on delete cascade,
  value_cents  int not null,
  price_source text not null default 'manual',
  created_at   timestamptz not null default now()
);

create index if not exists item_price_history_item_created_idx
  on public.item_price_history (item_id, created_at desc);

alter table public.item_price_history enable row level security;

drop policy if exists "item_price_history_own" on public.item_price_history;
create policy "item_price_history_own" on public.item_price_history
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

grant all on public.item_price_history to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
