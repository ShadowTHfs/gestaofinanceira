// =============================================================================
// CAMADA DE REPOSITÓRIO (persistência)
// -----------------------------------------------------------------------------
// Todo acesso a dados do app passa por aqui. A interface nunca fala direto com
// localStorage ou Supabase — assim, trocar o "motor" não muda nenhuma tela.
//
// Como decide onde salvar:
//   1. Sem SUPABASE_URL/ANON_KEY  → modo 'local' (localStorage).
//   2. Com chaves, mas sem usuário logado → continua 'local' (o RLS do banco
//      exige login; a tela de login é o próximo passo do roadmap).
//   3. Com chaves + sessão ativa → modo 'supabase'.
//      Toda escrita bem-sucedida também é espelhada no localStorage (cache).
//      Se uma chamada remota falhar, o app NÃO quebra: cai para o cache local
//      e avisa a interface pelo evento 'repo:degraded'.
// =============================================================================

import { CONFIG, isSupabaseConfigured } from '../config.js';

const K = {
  transactions: `${CONFIG.storagePrefix}transactions`,
  recurring: `${CONFIG.storagePrefix}recurring`,
  settings: `${CONFIG.storagePrefix}settings`,
  connections: `${CONFIG.storagePrefix}connections`,
  seeded: `${CONFIG.storagePrefix}seeded`,
};

export const DEFAULT_SETTINGS = Object.freeze({ openingBalance: 0, monthlyBudget: 4000 });

let supabase = null;
let backend = 'local';
let reason = 'Supabase não configurado — usando armazenamento do navegador.';
let userId = null;
let initPromise = null;

// ---------------------------------------------------------------- inicialização
export function initRepository() {
  if (!initPromise) initPromise = init();
  return initPromise;
}

async function init() {
  if (!isSupabaseConfigured()) return getRepositoryStatus();
  try {
    const { createClient } = await import(/* @vite-ignore */ CONFIG.supabaseClientUrl);
    supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    const { data } = await supabase.auth.getSession();
    userId = data?.session?.user?.id ?? null;
    if (userId) {
      backend = 'supabase';
      reason = 'Conectado ao Supabase.';
    } else {
      reason = 'Supabase configurado, aguardando login — usando o navegador por enquanto.';
    }
  } catch (err) {
    console.warn('[repo] Falha ao iniciar Supabase, usando localStorage:', err);
    reason = 'Não foi possível carregar o Supabase — usando o navegador.';
  }
  return getRepositoryStatus();
}

export function getRepositoryStatus() {
  return { backend, reason, configured: isSupabaseConfigured(), userId };
}

/** Acesso ao cliente oficial (para a futura tela de login, por exemplo). */
export const getSupabase = () => supabase;

// ---------------------------------------------------------------- localStorage
function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('[repo] localStorage indisponível:', err);
  }
}
function upsertLocal(key, items) {
  const list = lsGet(key, []);
  const byId = new Map(list.map((x) => [x.id, x]));
  items.forEach((it) => byId.set(it.id, { ...byId.get(it.id), ...it }));
  lsSet(key, [...byId.values()]);
}
function removeLocal(key, ids) {
  const set = new Set(ids);
  lsSet(key, lsGet(key, []).filter((x) => !set.has(x.id)));
}

// ---------------------------------------------------------------- fallback
async function run(remote, local) {
  if (backend === 'supabase' && supabase) {
    try {
      return await remote();
    } catch (err) {
      console.warn('[repo] Erro remoto, usando cache local:', err);
      window.dispatchEvent(new CustomEvent('repo:degraded', { detail: { message: err?.message || String(err) } }));
    }
  }
  return local();
}
const check = ({ data, error }) => {
  if (error) throw error;
  return data;
};

// ---------------------------------------------------------------- mapeamento
// App usa camelCase; o banco usa snake_case.
const txToRow = (t) => ({
  id: t.id,
  user_id: userId,
  description: t.description,
  amount: t.amount,
  date: t.date,
  category: t.category,
  type: t.type,
  source: t.source || 'manual',
  recurring_id: t.recurringId ?? null,
  installment_current: t.installment?.current ?? null,
  installment_total: t.installment?.total ?? null,
  installment_group: t.installment?.groupId ?? null,
  external_id: t.externalId ?? null,
  account_id: t.accountId ?? null,
  created_at: t.createdAt,
});
const rowToTx = (r) => ({
  id: r.id,
  description: r.description,
  amount: Number(r.amount),
  date: r.date,
  category: r.category,
  type: r.type,
  source: r.source,
  recurringId: r.recurring_id,
  installment: r.installment_total ? { current: r.installment_current, total: r.installment_total, groupId: r.installment_group } : null,
  externalId: r.external_id,
  accountId: r.account_id,
  createdAt: r.created_at,
});
const ruleToRow = (r) => ({
  id: r.id, user_id: userId, description: r.description, amount: r.amount, type: r.type, category: r.category,
  day: r.day, kind: r.kind, start_month: r.startMonth, end_month: r.endMonth ?? null, active: r.active !== false,
});
const rowToRule = (r) => ({
  id: r.id, description: r.description, amount: Number(r.amount), type: r.type, category: r.category,
  day: r.day, kind: r.kind, startMonth: r.start_month, endMonth: r.end_month, active: r.active,
});
const connToRow = (c) => ({
  id: c.id, user_id: userId, bank_id: c.bankId, status: c.status, account_mask: c.accountMask,
  provider: c.provider || 'simulated', connected_at: c.connectedAt, last_sync_at: c.lastSyncAt ?? null,
});
const rowToConn = (r) => ({
  id: r.id, bankId: r.bank_id, status: r.status, accountMask: r.account_mask,
  provider: r.provider, connectedAt: r.connected_at, lastSyncAt: r.last_sync_at,
});

// ---------------------------------------------------------------- transações
export async function fetchTransactions() {
  return run(
    async () => {
      const rows = check(await supabase.from('transactions').select('*').order('date', { ascending: false }));
      const list = rows.map(rowToTx);
      lsSet(K.transactions, list);
      return list;
    },
    () => lsGet(K.transactions, []),
  );
}

export async function saveTransactions(list) {
  const items = list.map((t) => ({ source: 'manual', createdAt: new Date().toISOString(), ...t }));
  return run(
    async () => {
      check(await supabase.from('transactions').upsert(items.map(txToRow)));
      upsertLocal(K.transactions, items);
      return items;
    },
    () => {
      upsertLocal(K.transactions, items);
      return items;
    },
  );
}

export const saveTransaction = async (tx) => (await saveTransactions([tx]))[0];

export async function deleteTransaction(id) {
  return run(
    async () => {
      check(await supabase.from('transactions').delete().eq('id', id));
      removeLocal(K.transactions, [id]);
      return true;
    },
    () => {
      removeLocal(K.transactions, [id]);
      return true;
    },
  );
}

// ---------------------------------------------------------------- recorrências
export async function fetchRecurring() {
  return run(
    async () => {
      const list = check(await supabase.from('recurring_rules').select('*')).map(rowToRule);
      lsSet(K.recurring, list);
      return list;
    },
    () => lsGet(K.recurring, []),
  );
}

export async function saveRecurring(rule) {
  return run(
    async () => {
      check(await supabase.from('recurring_rules').upsert(ruleToRow(rule)));
      upsertLocal(K.recurring, [rule]);
      return rule;
    },
    () => {
      upsertLocal(K.recurring, [rule]);
      return rule;
    },
  );
}

export async function deleteRecurring(id) {
  return run(
    async () => {
      check(await supabase.from('recurring_rules').delete().eq('id', id));
      removeLocal(K.recurring, [id]);
      return true;
    },
    () => {
      removeLocal(K.recurring, [id]);
      return true;
    },
  );
}

// ---------------------------------------------------------------- configurações
export async function fetchSettings() {
  return run(
    async () => {
      const row = check(await supabase.from('user_settings').select('*').maybeSingle());
      const s = row
        ? { openingBalance: Number(row.opening_balance), monthlyBudget: Number(row.monthly_budget) }
        : { ...DEFAULT_SETTINGS };
      lsSet(K.settings, s);
      return s;
    },
    () => ({ ...DEFAULT_SETTINGS, ...lsGet(K.settings, {}) }),
  );
}

export async function saveSettings(s) {
  return run(
    async () => {
      check(await supabase.from('user_settings').upsert({
        user_id: userId, opening_balance: s.openingBalance, monthly_budget: s.monthlyBudget, updated_at: new Date().toISOString(),
      }));
      lsSet(K.settings, s);
      return s;
    },
    () => {
      lsSet(K.settings, s);
      return s;
    },
  );
}

// ---------------------------------------------------------------- conexões bancárias
export async function fetchConnections() {
  return run(
    async () => {
      const list = check(await supabase.from('bank_connections').select('*')).map(rowToConn);
      lsSet(K.connections, list);
      return list;
    },
    () => lsGet(K.connections, []),
  );
}

export async function saveConnection(conn) {
  return run(
    async () => {
      check(await supabase.from('bank_connections').upsert(connToRow(conn)));
      upsertLocal(K.connections, [conn]);
      return conn;
    },
    () => {
      upsertLocal(K.connections, [conn]);
      return conn;
    },
  );
}

export async function deleteConnection(id) {
  return run(
    async () => {
      check(await supabase.from('bank_connections').delete().eq('id', id));
      removeLocal(K.connections, [id]);
      return true;
    },
    () => {
      removeLocal(K.connections, [id]);
      return true;
    },
  );
}

// ---------------------------------------------------------------- dados de demonstração
/** Só popula no modo local e apenas na primeira visita. Nunca escreve demo no Supabase. */
export async function seedIfEmpty(buildSeed) {
  if (backend !== 'local' || lsGet(K.seeded, false)) return false;
  const seed = buildSeed();
  lsSet(K.transactions, seed.transactions);
  lsSet(K.recurring, seed.recurring);
  lsSet(K.settings, seed.settings);
  lsSet(K.connections, []);
  lsSet(K.seeded, true);
  return true;
}

/** Apaga os dados locais. withDemo=true recria a demonstração. */
export async function resetLocalData({ withDemo, buildSeed }) {
  Object.values(K).forEach((k) => localStorage.removeItem(k));
  if (withDemo) return seedIfEmpty(buildSeed);
  lsSet(K.seeded, true);
  lsSet(K.settings, { ...DEFAULT_SETTINGS });
  return true;
}
