// =============================================================================
// CAMADA DE REPOSITÓRIO (persistência)
// -----------------------------------------------------------------------------
// Todo acesso a dados passa por aqui. As telas nunca falam direto com
// localStorage nem com o Supabase.
//
// Dois modos:
//   'local'    → sem chaves do Supabase: dados no navegador (com demonstração).
//   'supabase' → com chaves + usuário logado: dados nas tabelas do Supabase,
//                isolados por usuário (RLS). Uma cópia fica em cache no
//                navegador, separada por usuário.
//
// Regras de segurança dos dados no modo 'supabase':
//   • LEITURA que falhar → usa o cache e avisa (evento 'repo:degraded').
//   • ESCRITA que falhar → lança erro. O app avisa "não foi salvo".
//     Nunca fingimos que salvou.
// =============================================================================

import { CONFIG, isSupabaseConfigured } from '../config.js';
import { uid } from '../utils.js';

const LOCAL_PREFIX = CONFIG.storagePrefix; // dados do modo local (sem conta)
const keysFor = (prefix) => ({
  transactions: `${prefix}transactions`,
  recurring: `${prefix}recurring`,
  settings: `${prefix}settings`,
  connections: `${prefix}connections`,
  categories: `${prefix}categories`,
  goals: `${prefix}goals`,
  seeded: `${prefix}seeded`,
});
const LOCAL_KEYS = keysFor(LOCAL_PREFIX);

export const DEFAULT_SETTINGS = Object.freeze({ openingBalance: 0, monthlyBudget: 4000 });

let supabase = null;
let backend = 'local';
let reason = 'Supabase não configurado — dados salvos neste navegador.';
let userId = null;
let userEmail = null;
let K = LOCAL_KEYS;
let initPromise = null;

// ---------------------------------------------------------------- inicialização
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
    document.head.appendChild(s);
  });
}

export function initRepository() {
  if (!initPromise) initPromise = init();
  return initPromise;
}

async function init() {
  if (!isSupabaseConfigured()) return getRepositoryStatus();
  try {
    if (!window.supabase?.createClient) await loadScript(CONFIG.supabaseClientUrl);
    supabase = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    reason = 'Supabase conectado — faça login para acessar seus dados.';
  } catch (err) {
    console.error('[repo] Não foi possível iniciar o Supabase:', err);
    supabase = null;
    reason = 'Não foi possível carregar o Supabase — usando o navegador.';
  }
  return getRepositoryStatus();
}

/** Chamado pelo app quando o login acontece (ou sai: user = null). */
export function setUser(user) {
  if (user && supabase) {
    userId = user.id;
    userEmail = user.email ?? null;
    backend = 'supabase';
    K = keysFor(`${LOCAL_PREFIX}u.${user.id}.`);
    reason = 'Dados salvos na nuvem (Supabase).';
  } else {
    userId = null;
    userEmail = null;
    backend = 'local';
    K = LOCAL_KEYS;
    reason = supabase ? 'Supabase conectado — faça login para acessar seus dados.' : reason;
  }
}

export function getRepositoryStatus() {
  return {
    backend,
    reason,
    configured: isSupabaseConfigured(),
    clientReady: Boolean(supabase),
    userId,
    userEmail,
  };
}

/** Cliente oficial (usado pelo módulo de autenticação). */
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
  const byId = new Map(lsGet(key, []).map((x) => [x.id, x]));
  items.forEach((it) => byId.set(it.id, { ...byId.get(it.id), ...it }));
  lsSet(key, [...byId.values()]);
}
function removeLocal(key, ids) {
  const set = new Set(ids);
  lsSet(key, lsGet(key, []).filter((x) => !set.has(x.id)));
}

// ---------------------------------------------------------------- execução
const remoteOn = () => backend === 'supabase' && supabase && userId;

function check({ data, error }) {
  if (error) throw translateDbError(error);
  return data;
}

/** Banco sem as colunas/tabelas novas (schema.sql não foi rodado de novo). */
function isSchemaError(err) {
  const e = err?.cause || err;
  const msg = `${e?.code || ''} ${e?.message || ''}`;
  return /PGRST204|PGRST205|42P01|42703|Could not find the .* (column|table)|does not exist/i.test(msg);
}
let schemaWarned = false;
function notifySchemaOutdated() {
  if (schemaWarned) return;
  schemaWarned = true;
  window.dispatchEvent(new CustomEvent('repo:schema-outdated'));
}

/**
 * Upsert defensivo: se o banco ainda não tem as colunas novas, grava sem elas
 * (o app continua funcionando) e avisa uma vez para rodar o schema.sql.
 */
async function upsertCompat(table, rows, newFields) {
  try {
    await upsertChunks(table, rows);
  } catch (err) {
    if (!isSchemaError(err) || !newFields.length) throw err;
    notifySchemaOutdated();
    const legacy = rows.map((r) => {
      const c = { ...r };
      newFields.forEach((f) => delete c[f]);
      return c;
    });
    await upsertChunks(table, legacy);
  }
}

function translateDbError(error) {
  const msg = error?.message || String(error);
  let friendly = 'Não foi possível salvar no servidor.';
  if (/relation .* does not exist|Could not find the table|Could not find the .* column|PGRST20[45]/i.test(msg)) friendly = 'Banco desatualizado — rode o arquivo schema.sql novo no SQL Editor do Supabase.';
  else if (/row-level security|violates row-level/i.test(msg)) friendly = 'Permissão negada pelo banco (RLS). Faça login novamente.';
  else if (/JWT|token/i.test(msg)) friendly = 'Sua sessão expirou. Entre novamente.';
  else if (/Failed to fetch|NetworkError|network/i.test(msg)) friendly = 'Sem conexão com a internet.';
  const err = new Error(friendly);
  err.cause = error;
  return err;
}

/** Leitura: remoto → cache local se falhar. */
async function read(remote, cacheKey, fallback) {
  if (remoteOn()) {
    try {
      const data = await remote();
      lsSet(cacheKey, data);
      return data;
    } catch (err) {
      if (isSchemaError(err)) {
        notifySchemaOutdated();
      } else {
        console.warn('[repo] Leitura remota falhou, usando cache:', err);
        window.dispatchEvent(new CustomEvent('repo:degraded', { detail: { message: err.message } }));
      }
    }
  }
  return lsGet(cacheKey, fallback);
}

/** Escrita: remoto obrigatório quando logado (erro sobe para o app). */
async function write(remote, local) {
  if (remoteOn()) await remote();
  return local();
}

// ---------------------------------------------------------------- mapeamento
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
  items: t.items?.length ? t.items : null,
  status: t.status === 'pending' ? 'pending' : 'paid',
});
const TX_NEW_FIELDS = ['items', 'status'];
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
  items: Array.isArray(r.items) ? r.items : null,
  status: r.status === 'pending' ? 'pending' : 'paid',
});
const ruleToRow = (r) => ({
  id: r.id, user_id: userId, description: r.description, amount: r.amount, type: r.type, category: r.category,
  day: r.day, kind: r.kind, start_month: r.startMonth, end_month: r.endMonth ?? null, active: r.active !== false,
  frequency: r.frequency || 'monthly', start_date: r.startDate ?? null, end_date: r.endDate ?? null, occurrences: r.occurrences ?? null,
});
const RULE_NEW_FIELDS = ['frequency', 'start_date', 'end_date', 'occurrences'];
const rowToRule = (r) => ({
  id: r.id, description: r.description, amount: Number(r.amount), type: r.type, category: r.category,
  day: r.day, kind: r.kind, startMonth: r.start_month, endMonth: r.end_month, active: r.active,
  frequency: r.frequency || 'monthly', startDate: r.start_date ?? null, endDate: r.end_date ?? null, occurrences: r.occurrences ?? null,
});
const catToRow = (c) => ({ id: c.id, user_id: userId, label: c.label, type: c.type, icon: c.icon, color: c.color });
const rowToCat = (r) => ({ id: r.id, label: r.label, type: r.type, icon: r.icon, color: r.color });
const goalToRow = (g) => ({
  id: g.id, user_id: userId, name: g.name, target_amount: g.targetAmount, saved_amount: g.savedAmount ?? 0,
  target_date: g.targetDate || null, monthly_contribution: g.monthlyContribution ?? null, annual_rate: g.annualRate ?? 0,
  icon: g.icon || 'target', color: g.color || 'indigo',
});
const rowToGoal = (r) => ({
  id: r.id, name: r.name, targetAmount: Number(r.target_amount), savedAmount: Number(r.saved_amount),
  targetDate: r.target_date, monthlyContribution: r.monthly_contribution == null ? null : Number(r.monthly_contribution),
  annualRate: Number(r.annual_rate), icon: r.icon, color: r.color, createdAt: r.created_at,
});
const connToRow = (c) => ({
  id: c.id, user_id: userId, bank_id: c.bankId, status: c.status, account_mask: c.accountMask,
  provider: c.provider || 'simulated', connected_at: c.connectedAt, last_sync_at: c.lastSyncAt ?? null,
});
const rowToConn = (r) => ({
  id: r.id, bankId: r.bank_id, status: r.status, accountMask: r.account_mask,
  provider: r.provider, connectedAt: r.connected_at, lastSyncAt: r.last_sync_at,
});

/** PostgREST devolve no máximo 1000 linhas por vez → busca em páginas. */
async function selectAll(table, order) {
  const page = 1000;
  let from = 0;
  const out = [];
  for (;;) {
    let q = supabase.from(table).select('*').range(from, from + page - 1);
    if (order) q = q.order(order, { ascending: false }).order('id');
    const rows = check(await q);
    out.push(...rows);
    if (rows.length < page) return out;
    from += page;
  }
}

/** Grava em lotes (evita requisições gigantes ao importar). */
async function upsertChunks(table, rows, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    check(await supabase.from(table).upsert(rows.slice(i, i + size)));
  }
}

// ---------------------------------------------------------------- transações
export function fetchTransactions() {
  return read(async () => (await selectAll('transactions', 'date')).map(rowToTx), K.transactions, []);
}

export async function saveTransactions(list) {
  const items = list.map((t) => ({ source: 'manual', createdAt: new Date().toISOString(), ...t }));
  return write(
    () => upsertCompat('transactions', items.map(txToRow), TX_NEW_FIELDS),
    () => { upsertLocal(K.transactions, items); return items; },
  );
}

export const saveTransaction = async (tx) => (await saveTransactions([tx]))[0];

export async function deleteTransactions(ids) {
  if (!ids.length) return true;
  return write(
    async () => {
      for (let i = 0; i < ids.length; i += 200) check(await supabase.from('transactions').delete().in('id', ids.slice(i, i + 200)));
    },
    () => { removeLocal(K.transactions, ids); return true; },
  );
}
export const deleteTransaction = (id) => deleteTransactions([id]);

// ---------------------------------------------------------------- recorrências
export function fetchRecurring() {
  return read(async () => (await selectAll('recurring_rules')).map(rowToRule), K.recurring, []);
}

export async function saveRecurring(rule) {
  return write(
    () => upsertCompat('recurring_rules', [ruleToRow(rule)], RULE_NEW_FIELDS),
    () => { upsertLocal(K.recurring, [rule]); return rule; },
  );
}

export async function deleteRecurring(id) {
  return write(
    async () => check(await supabase.from('recurring_rules').delete().eq('id', id)),
    () => { removeLocal(K.recurring, [id]); return true; },
  );
}

// ---------------------------------------------------------------- configurações
export async function fetchSettings() {
  const s = await read(async () => {
    const rows = check(await supabase.from('user_settings').select('*').limit(1));
    const row = rows[0];
    return row ? { openingBalance: Number(row.opening_balance), monthlyBudget: Number(row.monthly_budget) } : null;
  }, K.settings, null);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function saveSettings(s) {
  return write(
    async () => check(await supabase.from('user_settings').upsert({
      user_id: userId, opening_balance: s.openingBalance, monthly_budget: s.monthlyBudget, updated_at: new Date().toISOString(),
    })),
    () => { lsSet(K.settings, s); return s; },
  );
}

// ---------------------------------------------------------------- conexões bancárias
export function fetchConnections() {
  return read(async () => (await selectAll('bank_connections')).map(rowToConn), K.connections, []);
}

export async function saveConnection(conn) {
  return write(
    async () => check(await supabase.from('bank_connections').upsert(connToRow(conn))),
    () => { upsertLocal(K.connections, [conn]); return conn; },
  );
}

export async function deleteConnection(id) {
  return write(
    async () => check(await supabase.from('bank_connections').delete().eq('id', id)),
    () => { removeLocal(K.connections, [id]); return true; },
  );
}

// ---------------------------------------------------------------- categorias personalizadas
export function fetchCategories() {
  return read(async () => (await selectAll('categories')).map(rowToCat), K.categories, []);
}

export async function saveCategory(cat) {
  return write(
    async () => check(await supabase.from('categories').upsert(catToRow(cat), { onConflict: 'user_id,id' })),
    () => { upsertLocal(K.categories, [cat]); return cat; },
  );
}

export async function deleteCategory(id) {
  return write(
    async () => check(await supabase.from('categories').delete().eq('id', id)),
    () => { removeLocal(K.categories, [id]); return true; },
  );
}

// ---------------------------------------------------------------- metas
export function fetchGoals() {
  return read(async () => (await selectAll('goals')).map(rowToGoal), K.goals, []);
}

export async function saveGoal(goal) {
  return write(
    async () => check(await supabase.from('goals').upsert(goalToRow(goal))),
    () => { upsertLocal(K.goals, [goal]); return goal; },
  );
}

export async function deleteGoal(id) {
  return write(
    async () => check(await supabase.from('goals').delete().eq('id', id)),
    () => { removeLocal(K.goals, [id]); return true; },
  );
}

// ---------------------------------------------------------------- conta nova / importação
/** A conta logada ainda não tem nada salvo? (lê direto do servidor) */
export async function isRemoteEmpty() {
  if (!remoteOn()) return false;
  const [tx, rules, settings] = await Promise.all([
    supabase.from('transactions').select('id').limit(1),
    supabase.from('recurring_rules').select('id').limit(1),
    supabase.from('user_settings').select('user_id').limit(1),
  ]);
  return check(tx).length === 0 && check(rules).length === 0 && check(settings).length === 0;
}

/** O que existe no modo local (sem conta) deste navegador. */
export function getLocalSnapshot() {
  return {
    transactions: lsGet(LOCAL_KEYS.transactions, []),
    recurring: lsGet(LOCAL_KEYS.recurring, []),
    settings: lsGet(LOCAL_KEYS.settings, null),
    categories: lsGet(LOCAL_KEYS.categories, []),
    goals: lsGet(LOCAL_KEYS.goals, []),
  };
}

/**
 * Copia os dados locais para a conta logada.
 * Gera IDs novos (evita conflito se outra conta já importou os mesmos dados)
 * e refaz os vínculos de recorrência e parcelamento.
 * Transações vindas do Open Finance simulado NÃO são importadas.
 */
export async function importLocalToAccount() {
  if (!remoteOn()) throw new Error('Faça login antes de importar.');
  const snap = getLocalSnapshot();
  const ruleMap = new Map();
  const groupMap = new Map();
  const rules = snap.recurring.map((r) => {
    const id = uid();
    ruleMap.set(r.id, id);
    return { ...r, id };
  });
  const now = new Date().toISOString();
  const txs = snap.transactions
    .filter((t) => t.source !== 'open_finance')
    .map((t) => {
      let installment = null;
      if (t.installment?.groupId) {
        if (!groupMap.has(t.installment.groupId)) groupMap.set(t.installment.groupId, uid());
        installment = { ...t.installment, groupId: groupMap.get(t.installment.groupId) };
      }
      return {
        ...t, id: uid(), installment, recurringId: t.recurringId ? ruleMap.get(t.recurringId) ?? null : null,
        accountId: null, externalId: null, source: 'manual', createdAt: t.createdAt || now,
      };
    });

  if (snap.categories.length) await upsertChunks('categories', snap.categories.map(catToRow));
  if (snap.goals.length) await upsertChunks('goals', snap.goals.map((g) => goalToRow({ ...g, id: uid() })));
  if (rules.length) await upsertCompat('recurring_rules', rules.map(ruleToRow), RULE_NEW_FIELDS);
  if (txs.length) await upsertCompat('transactions', txs.map(txToRow), TX_NEW_FIELDS);
  if (snap.settings) await saveSettings({ ...DEFAULT_SETTINGS, ...snap.settings });
  return { transactions: txs.length, recurring: rules.length };
}

// ---------------------------------------------------------------- dados de demonstração (só modo local)
export async function seedIfEmpty(buildSeed) {
  if (backend !== 'local' || lsGet(LOCAL_KEYS.seeded, false)) return false;
  const seed = buildSeed();
  lsSet(LOCAL_KEYS.transactions, seed.transactions);
  lsSet(LOCAL_KEYS.recurring, seed.recurring);
  lsSet(LOCAL_KEYS.settings, seed.settings);
  lsSet(LOCAL_KEYS.connections, []);
  lsSet(LOCAL_KEYS.categories, seed.categories || []);
  lsSet(LOCAL_KEYS.goals, seed.goals || []);
  lsSet(LOCAL_KEYS.seeded, true);
  return true;
}

export async function resetLocalData({ withDemo, buildSeed }) {
  if (backend !== 'local') throw new Error('Disponível apenas no modo local.');
  Object.values(LOCAL_KEYS).forEach((k) => localStorage.removeItem(k));
  if (withDemo) return seedIfEmpty(buildSeed);
  lsSet(LOCAL_KEYS.seeded, true);
  lsSet(LOCAL_KEYS.settings, { ...DEFAULT_SETTINGS });
  return true;
}

/** Limpa o cache local da conta (usado ao sair). */
export function clearUserCache() {
  if (backend === 'supabase') Object.values(K).forEach((k) => localStorage.removeItem(k));
}
