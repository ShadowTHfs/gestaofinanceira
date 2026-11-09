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

-- ------------------------------------------------------------ permissões
-- Só usuários logados acessam as tabelas (e o RLS acima limita aos próprios dados).
revoke all on public.bank_connections, public.recurring_rules, public.transactions, public.user_settings from anon;
grant select, insert, update, delete on public.bank_connections, public.recurring_rules, public.transactions, public.user_settings to authenticated;

-- =============================================================================
-- v3 — categorias personalizadas, itens, agendamentos e metas (ADITIVO)
-- Pode rodar o arquivo inteiro de novo: nada é apagado.
-- =============================================================================

-- Itens dentro da transação (ex.: lista do supermercado) e status de pagamento
alter table public.transactions add column if not exists items jsonb;
alter table public.transactions add column if not exists status text not null default 'paid';
do $$ begin
  alter table public.transactions add constraint transactions_status_ck check (status in ('paid', 'pending'));
exception when duplicate_object then null; end $$;

-- Recorrência com frequência e duração
alter table public.recurring_rules add column if not exists frequency text not null default 'monthly';
alter table public.recurring_rules add column if not exists start_date date;
alter table public.recurring_rules add column if not exists end_date date;
alter table public.recurring_rules add column if not exists occurrences smallint;
do $$ begin
  alter table public.recurring_rules add constraint recurring_frequency_ck check (frequency in ('weekly', 'monthly', 'yearly'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.recurring_rules add constraint recurring_occurrences_ck check (occurrences is null or occurrences between 1 and 600);
exception when duplicate_object then null; end $$;

-- Categorias personalizadas
create table if not exists public.categories (
  id          text not null,                    -- ex.: 'c_9f2a…' (gerado pelo app)
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  label       text not null check (char_length(label) between 1 and 30),
  type        text not null check (type in ('income', 'expense')),
  icon        text not null default 'circle-ellipsis',
  color       text not null default 'slate',
  created_at  timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists categories_user_idx on public.categories (user_id);

-- Metas
create table if not exists public.goals (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name                  text not null check (char_length(name) between 1 and 60),
  target_amount         numeric(14, 2) not null check (target_amount > 0),
  saved_amount          numeric(14, 2) not null default 0 check (saved_amount >= 0),
  target_date           date,
  monthly_contribution  numeric(14, 2) check (monthly_contribution is null or monthly_contribution >= 0),
  annual_rate           numeric(6, 3) not null default 0 check (annual_rate between 0 and 100),
  icon                  text not null default 'target',
  color                 text not null default 'indigo',
  created_at            timestamptz not null default now()
);
create index if not exists goals_user_idx on public.goals (user_id);

alter table public.categories enable row level security;
alter table public.goals      enable row level security;

drop policy if exists "own_categories" on public.categories;
create policy "own_categories" on public.categories
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own_goals" on public.goals;
create policy "own_goals" on public.goals
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.categories, public.goals from anon;
grant select, insert, update, delete on public.categories, public.goals to authenticated;

-- =============================================================================
-- v4 — Open Finance real via Pluggy / Meu Pluggy (ADITIVO)
-- =============================================================================

-- Conexão: guarda o Item ID da Pluggy e o nome da instituição
alter table public.bank_connections add column if not exists external_item_id text;
alter table public.bank_connections add column if not exists institution text;
alter table public.bank_connections add column if not exists last_error text;
create unique index if not exists bank_connections_user_item_uidx
  on public.bank_connections (user_id, external_item_id) where external_item_id is not null;

-- Contas e cartões vindos do banco (saldo, limite, fatura)
create table if not exists public.bank_accounts (
  id                text not null,                 -- id da conta na Pluggy
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  connection_id     uuid not null references public.bank_connections(id) on delete cascade,
  type              text not null,                 -- BANK | CREDIT
  subtype           text,
  name              text,
  number            text,
  balance           numeric(14, 2),
  currency          text default 'BRL',
  credit_limit      numeric(14, 2),
  available_credit  numeric(14, 2),
  bill_close_date   date,
  bill_due_date     date,
  minimum_payment   numeric(14, 2),
  updated_at        timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists bank_accounts_conn_idx on public.bank_accounts (connection_id);

-- Transação importada: de qual conta/cartão veio
alter table public.transactions add column if not exists bank_account_id text;

alter table public.bank_accounts enable row level security;
drop policy if exists "own_bank_accounts" on public.bank_accounts;
create policy "own_bank_accounts" on public.bank_accounts
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.bank_accounts from anon;
grant select, insert, update, delete on public.bank_accounts to authenticated;

-- =============================================================================
-- v5 — Chaves da Pluggy por usuário (cada pessoa usa o próprio Meu Pluggy)
-- O Client Secret é gravado CRIPTOGRAFADO pela Edge Function "pluggy"
-- (AES-GCM com uma chave que só existe no servidor). O navegador nunca o lê.
-- =============================================================================
create table if not exists public.pluggy_credentials (
  user_id            uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  client_id          text not null,
  client_secret_enc  text not null,
  updated_at         timestamptz not null default now()
);
alter table public.pluggy_credentials enable row level security;
drop policy if exists "own_pluggy_credentials" on public.pluggy_credentials;
create policy "own_pluggy_credentials" on public.pluggy_credentials
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.pluggy_credentials from anon;
grant select, insert, update, delete on public.pluggy_credentials to authenticated;

-- =============================================================================
-- v6 — Tempo real: notificações do celular (Android), prévias e webhook da Pluggy
-- (ADITIVO: pode rodar o arquivo inteiro de novo)
-- =============================================================================

-- Transação que veio da notificação do banco fica marcada como PRÉVIA até o
-- Open Finance trazer a oficial (aí a prévia é trocada automaticamente).
alter table public.transactions add column if not exists is_preview boolean not null default false;
alter table public.transactions add column if not exists raw_text text;
alter table public.transactions drop constraint if exists transactions_source_check;
alter table public.transactions add constraint transactions_source_check
  check (source in ('manual', 'open_finance', 'notification'));

-- Código secreto de cada pessoa para o celular enviar as notificações.
-- Guardamos só o "hash" do código: nem quem administra o banco vê o código.
create table if not exists public.notification_tokens (
  user_id       uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

-- Caixa de entrada: tudo que o celular mandou e o que o app fez com isso.
create table if not exists public.notification_inbox (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  received_at     timestamptz not null default now(),
  app             text,
  title           text,
  body            text,
  status          text not null check (status in ('lancada', 'duplicada', 'ignorada', 'nao_reconhecida')),
  transaction_id  uuid
);
create index if not exists notification_inbox_user_idx on public.notification_inbox (user_id, received_at desc);

-- Webhook da Pluggy de cada pessoa (código secreto também só em hash).
create table if not exists public.pluggy_webhooks (
  user_id           uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  hook_secret_hash  text not null unique,
  webhook_ids       text[] not null default '{}',
  created_at        timestamptz not null default now(),
  last_event_at     timestamptz
);

alter table public.notification_tokens enable row level security;
alter table public.notification_inbox  enable row level security;
alter table public.pluggy_webhooks     enable row level security;

drop policy if exists "own_notification_tokens" on public.notification_tokens;
create policy "own_notification_tokens" on public.notification_tokens
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own_notification_inbox" on public.notification_inbox;
create policy "own_notification_inbox" on public.notification_inbox
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own_pluggy_webhooks" on public.pluggy_webhooks;
create policy "own_pluggy_webhooks" on public.pluggy_webhooks
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.notification_tokens, public.notification_inbox, public.pluggy_webhooks from anon;
grant select, insert, update, delete on public.notification_tokens, public.notification_inbox, public.pluggy_webhooks to authenticated;
-- A função (rotas do celular e do webhook) usa a chave de serviço do Supabase.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.notification_tokens, public.notification_inbox, public.pluggy_webhooks,
      public.transactions, public.bank_connections, public.bank_accounts, public.pluggy_credentials to service_role;
  end if;
end $$;

-- Atualização ao vivo na tela (Supabase Realtime) para as transações.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'transactions') then
    execute 'alter publication supabase_realtime add table public.transactions';
  end if;
end $$;
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notification_inbox') then
    execute 'alter publication supabase_realtime add table public.notification_inbox';
  end if;
end $$;
