-- =============================================================================
-- GESTÃO FINANCEIRA — Esquema do Supabase (rodar no SQL Editor)
-- Idempotente: pode rodar mais de uma vez sem quebrar nada.
-- Cada usuário só enxerga e altera os PRÓPRIOS dados (RLS por auth.uid()).
-- =============================================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------ conexões bancárias
create table if not exists public.bank_connections (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  bank_id       text not null,
  status        text not null default 'connected' check (status in ('connected', 'disconnected', 'error')),
  account_mask  text,
  provider      text not null default 'simulated',
  connected_at  timestamptz not null default now(),
  last_sync_at  timestamptz
);

-- ------------------------------------------------------------ regras recorrentes
create table if not exists public.recurring_rules (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  description  text not null check (char_length(description) between 1 and 80),
  amount       numeric(14, 2) not null check (amount > 0),
  type         text not null check (type in ('income', 'expense')),
  category     text not null,
  day          smallint not null check (day between 1 and 31),
  kind         text not null default 'fixed' check (kind in ('fixed', 'subscription')),
  start_month  text not null check (start_month ~ '^\d{4}-\d{2}$'),
  end_month    text check (end_month ~ '^\d{4}-\d{2}$'),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------------ transações
create table if not exists public.transactions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null default auth.uid() references auth.users(id) on delete cascade,
  description          text not null check (char_length(description) between 1 and 140),
  amount               numeric(14, 2) not null check (amount > 0),
  date                 date not null,
  category             text not null,
  type                 text not null check (type in ('income', 'expense')),
  source               text not null default 'manual' check (source in ('manual', 'open_finance')),
  recurring_id         uuid references public.recurring_rules(id) on delete set null,
  installment_current  smallint,
  installment_total    smallint,
  installment_group    uuid,
  external_id          text,
  account_id           uuid references public.bank_connections(id) on delete set null,
  created_at           timestamptz not null default now(),
  constraint installment_ok check (
    (installment_total is null and installment_current is null)
    or (installment_total between 2 and 48 and installment_current between 1 and installment_total)
  )
);

create index if not exists transactions_user_date_idx on public.transactions (user_id, date desc);
create index if not exists transactions_user_group_idx on public.transactions (user_id, installment_group) where installment_group is not null;
-- Evita importar duas vezes o mesmo lançamento do Open Finance
create unique index if not exists transactions_user_external_uidx on public.transactions (user_id, external_id) where external_id is not null;

-- ------------------------------------------------------------ configurações do usuário
create table if not exists public.user_settings (
  user_id          uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  opening_balance  numeric(14, 2) not null default 0,
  monthly_budget   numeric(14, 2) not null default 0 check (monthly_budget >= 0),
  updated_at       timestamptz not null default now()
);

-- ------------------------------------------------------------ segurança (RLS)
alter table public.bank_connections enable row level security;
alter table public.recurring_rules  enable row level security;
alter table public.transactions     enable row level security;
alter table public.user_settings    enable row level security;

drop policy if exists "own_bank_connections" on public.bank_connections;
create policy "own_bank_connections" on public.bank_connections
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own_recurring_rules" on public.recurring_rules;
create policy "own_recurring_rules" on public.recurring_rules
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own_transactions" on public.transactions;
create policy "own_transactions" on public.transactions
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own_user_settings" on public.user_settings;
create policy "own_user_settings" on public.user_settings
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
