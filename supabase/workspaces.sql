-- doc 64 — Persistence v1: one state-blob per workspace for the OnSite demo.
-- Run this in the Supabase SQL editor of the EU project (once).
--
-- DEMO-GRADE access control: the workspace id IS the access token (anyone with the anon
-- key may read/write any row). This is fine for a shared demo, NOT for real tenant data.
-- // TODO doc-58 production: magic-link auth + per-tenant RLS scoped to auth.uid().
-- NEVER expose the service_role key in the client — the app uses the anon public key only.

create table if not exists public.workspaces (
  id          text primary key,                              -- e.g. 'solbakken-demo'
  state       jsonb       not null default '{}'::jsonb,      -- the full OnSite state blob (migrate()-shaped)
  rev         bigint      not null default 0,                -- last-write-wins counter (no CRDTs)
  updated_at  timestamptz not null default now()
);

alter table public.workspaces enable row level security;

-- Demo policy: anon may read + insert + update any workspace row (id = access).
-- Replace with auth-scoped policies before any real tenant data (doc 58).
drop policy if exists "demo anon read"   on public.workspaces;
drop policy if exists "demo anon insert" on public.workspaces;
drop policy if exists "demo anon update" on public.workspaces;
create policy "demo anon read"   on public.workspaces for select to anon using (true);
create policy "demo anon insert" on public.workspaces for insert to anon with check (true);
create policy "demo anon update" on public.workspaces for update to anon using (true) with check (true);
