-- 2026-07-24 — Phase 1 of the explicit stage model (OnSite-STADIER-OG-FUNKSJONER §A).
-- Applied to prod btneqhrqnxmggwowboei via Supabase apply_migration; committed here for the record.
-- Additive + idempotent: nullable add → backfill from the lifecycle signal → default/NOT NULL/CHECK.
-- Backfill: a signed offer => drift; any offer at all => tilbud (matches the forward "first offer built
-- → tilbud" transition); otherwise befaring. The set_updated_at() trigger bumps updated_at on the backfill
-- UPDATE, so existing clients pick up `stage` on their next delta pull.

alter table public.buildings add column if not exists stage text;

update public.buildings b set stage = case
  when exists (select 1 from public.offers o where o.building_id = b.id and o.status in ('signed','signert')) then 'drift'
  when exists (select 1 from public.offers o where o.building_id = b.id) then 'tilbud'
  else 'befaring'
end
where stage is null;

alter table public.buildings alter column stage set default 'befaring';
update public.buildings set stage = 'befaring' where stage is null;
alter table public.buildings alter column stage set not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'buildings_stage_chk') then
    alter table public.buildings add constraint buildings_stage_chk
      check (stage in ('prospekt','befaring','tilbud','signert','drift','arkiv'));
  end if;
end $$;
