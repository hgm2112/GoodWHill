-- ============================================================================
-- goodwhilly — item kinds v2: sealed | loose | open | used | other
-- Additive over 0001..0006. The inventory UI now shows mockup-style product
-- types (Sealed / Loose / Open / Used / Other) instead of
-- sealed / bulk_cards / other. Re-running is safe because the new type lives
-- under a temp name until the swap is done.
--   sealed      -> sealed        (factory-sealed product)
--   bulk_cards  -> loose         (loose singles, Scryfall-priced)
--   other       -> other         (misc -> user may reclassify later)
--   open / used                 (new, empty until assigned)
-- ============================================================================

create type public.item_kind_v2 as enum ('sealed', 'loose', 'open', 'used', 'other');

alter table public.items add column kind_v2 public.item_kind_v2;

update public.items
set kind_v2 = case kind
  when 'sealed'::public.item_kind      then 'sealed'::public.item_kind_v2
  when 'bulk_cards'::public.item_kind   then 'loose'::public.item_kind_v2
  else 'other'::public.item_kind_v2
end;

alter table public.items alter column kind_v2 set not null;
alter table public.items alter column kind_v2 set default 'other'::public.item_kind_v2;

alter table public.items drop column kind;
alter table public.items rename column kind_v2 to kind;

drop type public.item_kind;
alter type public.item_kind_v2 rename to item_kind;