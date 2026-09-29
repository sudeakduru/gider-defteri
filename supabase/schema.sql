-- Supabase SQL Editor'da bir kez çalıştır.
-- Sonra Table Editor > owners tablosuna kendi e-postanı ekle. O hesap tüm kayıtları görür.

create table if not exists public.ledgers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  name text,
  provider text,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.owners (
  email text primary key
);

alter table public.ledgers enable row level security;
alter table public.owners enable row level security;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.owners
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

drop policy if exists "Kendi defteri" on public.ledgers;
create policy "Kendi defteri"
on public.ledgers
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Sahip hepsini görür" on public.ledgers;
create policy "Sahip hepsini görür"
on public.ledgers
for select
to authenticated
using (public.is_owner());

grant execute on function public.is_owner() to authenticated;
