// @ts-nocheck — código em JavaScript puro (sem anotações de tipo), roda igual no Deno.
// =============================================================================
// Edge Function "pluggy" — Open Finance real via Pluggy / Meu Pluggy
// -----------------------------------------------------------------------------
// Roda no servidor do Supabase. O Client Secret da Pluggy fica SÓ aqui
// (nos Secrets do Supabase) e nunca chega ao navegador.
//
// Secrets necessários (Supabase → Edge Functions → Secrets):
//   PLUGGY_CLIENT_ID        → Dashboard da Pluggy → Applications
//   PLUGGY_CLIENT_SECRET    → idem (aparece uma vez ao gerar)
//   PLUGGY_ALLOWED_EMAILS   → e-mails (separados por vírgula) que podem usar
//                             a integração. O Meu Pluggy é de USO PESSOAL:
//                             coloque só o seu e-mail de login no app.
//
// Ações (POST JSON { action, ... }):
//   status                      → integração configurada? usuário autorizado?
//   add-item  { itemId }        → valida o Item na Pluggy, salva e sincroniza
//   sync      { connectionId? } → atualiza contas e transações
//
// Sem dependências externas: só fetch. Todas as gravações usam o login do
// próprio usuário (RLS), então cada um só grava nos próprios dados.
// =============================================================================

const PLUGGY_API = 'https://api.pluggy.ai';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class AppError extends Error {
  status;
  code;
  constructor(message, status = 400, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- utilidades
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

/** UUID determinístico a partir de um texto (mesma origem → mesmo id → sem duplicar). */
async function stableUuid(text) {
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  buf[6] = (buf[6] & 0x0f) | 0x50; // versão 5 (formato)
  buf[8] = (buf[8] & 0x3f) | 0x80; // variante RFC 4122
  const h = [...buf.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Data da Pluggy (ISO com hora em UTC) → data local do Brasil 'AAAA-MM-DD'. */
export function toLocalDate(value) {
  if (!value) return null;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Só a data (meia-noite em UTC ou em Brasília): usa o dia como veio.
  if (/^\d{4}-\d{2}-\d{2}T(00|03):00:00(\.000)?Z?$/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

const isoDaysAgo = (now, days) => new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- categorias
// Categorias da Pluggy (em inglês) → categorias do app.
const CATEGORY_RULES = [
  [/salary|payroll|wage|pro-?labore|sal[aá]rio/i, 'trabalho', 'income'],
  [/invest|fixed income|variable income|pension|previd|savings|poupan|cdb|tesouro/i, 'investimentos', 'income'],
  [/groceries|supermarket|food|restaurant|eating|bakery|bakeries|delivery|aliment|mercado|padaria/i, 'alimentacao'],
  [/transport|gas station|fuel|taxi|ride|uber|parking|toll|vehicle|automotive|public transit|combust/i, 'transporte'],
  [/health|pharmac|drugstore|hospital|medical|dentist|wellness|gym|fitness|sa[uú]de|farm[aá]cia/i, 'saude'],
  [/education|school|university|college|course|bookstore|books|educa/i, 'educacao'],
  [/streaming|subscription|digital service|software|assinatura/i, 'assinaturas'],
  [/telecom|internet|phone|mobile|electric|energy|water|utilit|rent|housing|condo|home|moradia|aluguel|luz/i, 'moradia'],
  [/leisure|entertainment|travel|tourism|hotel|airline|culture|games|bar|nightlife|lazer|viagem/i, 'lazer'],
  [/shopping|clothing|electronics|department|online|e-commerce|marketplace|compras/i, 'compras'],
];

export function mapCategory(raw, type) {
  const text = String(raw || '');
  for (const [re, cat, onlyFor] of CATEGORY_RULES) {
    if (re.test(text) && (!onlyFor || onlyFor === type)) return cat;
  }
  return type === 'income' ? 'outras_receitas' : 'outros';
}

/**
 * Transações que NÃO entram, para não contar o mesmo dinheiro duas vezes:
 *  - pagamento da fatura do cartão (as compras do cartão já são importadas)
 *  - no cartão, entradas que são o próprio pagamento da fatura
 */
export function shouldSkip(tx, account) {
  const cat = String(tx.category || '');
  const desc = String(tx.description || '');
  if (/credit card payment|card bill payment|pagamento de fatura|pagto fatura|pag fatura/i.test(`${cat} ${desc}`)) return true;
  if (account.type === 'CREDIT' && Number(tx.amount) > 0 && /pagamento|payment/i.test(`${cat} ${desc}`)) return true;
  return false;
}

/** Transação da Pluggy → linha da tabela transactions. */
export async function mapTransaction(tx, account, connectionId, userId) {
  const amount = Number(tx.amount);
  if (!Number.isFinite(amount) || amount === 0) return null;
  if (shouldSkip(tx, account)) return null;
  const type = amount < 0 ? 'expense' : 'income';
  const meta = tx.creditCardMetadata;
  const suffix = meta?.totalInstallments > 1 ? ` (${meta.installmentNumber}/${meta.totalInstallments})` : '';
  const description = `${String(tx.description || 'Transação').trim().slice(0, 130)}${suffix}`;
  return {
    id: await stableUuid(`pluggy-tx:${userId}:${tx.id}`),
    user_id: userId,
    description,
    amount: round2(Math.abs(amount)),
    date: toLocalDate(tx.date),
    category: mapCategory(tx.category, type),
    type,
    source: 'open_finance',
    status: 'paid',
    external_id: `pluggy:${tx.id}`,
    account_id: connectionId,
    bank_account_id: `${account.type}:${account.id}`,
  };
}

export function mapAccount(acc, connectionId, userId) {
  const c = acc.creditData || {};
  return {
    id: `${acc.type}:${acc.id}`,
    user_id: userId,
    connection_id: connectionId,
    type: acc.type,
    subtype: acc.subtype || null,
    name: acc.marketingName || acc.name || null,
    number: acc.number || null,
    balance: acc.balance == null ? null : round2(acc.balance),
    currency: acc.currencyCode || 'BRL',
    credit_limit: c.creditLimit == null ? null : round2(c.creditLimit),
    available_credit: c.availableCreditLimit == null ? null : round2(c.availableCreditLimit),
    bill_close_date: c.balanceCloseDate ? toLocalDate(c.balanceCloseDate) : null,
    bill_due_date: c.balanceDueDate ? toLocalDate(c.balanceDueDate) : null,
    minimum_payment: c.minimumPayment == null ? null : round2(c.minimumPayment),
    updated_at: new Date().toISOString(),
  };
}

const itemStatus = (item) => {
  const s = String(item?.status || '');
  if (s === 'UPDATED' || s === 'UPDATING' || s === 'CREATED') return 'connected';
  return 'error';
};

const itemErrorText = (item) => {
  if (!item) return null;
  const code = item.error?.code || '';
  if (code === 'USER_AUTHORIZATION_EXPIRED' || /AUTHORIZATION_EXPIRED/.test(code)) {
    return 'A autorização do Meu Pluggy expirou (vale 1 ano). Refaça a conexão no Dashboard da Pluggy (Demo → Connect Account → MeuPluggy).';
  }
  if (item.status === 'LOGIN_ERROR') return 'O banco pediu nova autorização. Reconecte esse banco no meu.pluggy.ai.';
  if (item.status === 'OUTDATED') return 'O banco não respondeu na última atualização. A Pluggy tenta de novo automaticamente.';
  if (item.error?.message) return String(item.error.message).slice(0, 200);
  return null;
};

// ---------------------------------------------------------------- handler
export function createHandler({ fetch, env, now = () => new Date() }) {
  let apiKeyCache = { key: null, exp: 0 };

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  // ---- Pluggy
  async function pluggyKey() {
    if (apiKeyCache.key && apiKeyCache.exp > Date.now()) return apiKeyCache.key;
    const res = await fetch(`${PLUGGY_API}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: env('PLUGGY_CLIENT_ID'), clientSecret: env('PLUGGY_CLIENT_SECRET') }),
    });
    if (res.status === 401 || res.status === 403) throw new AppError('Client ID ou Client Secret da Pluggy incorretos. Confira os Secrets no Supabase.', 502, 'pluggy_auth');
    if (!res.ok) throw new AppError(`A Pluggy não respondeu (erro ${res.status}). Tente de novo em instantes.`, 502, 'pluggy_down');
    const { apiKey } = await res.json();
    apiKeyCache = { key: apiKey, exp: Date.now() + 100 * 60 * 1000 }; // chave vale 2h; renova antes
    return apiKey;
  }

  async function pluggyGet(path) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${PLUGGY_API}${path}`, { headers: { 'X-API-KEY': await pluggyKey() } });
      if (res.status === 401 && attempt === 0) { apiKeyCache = { key: null, exp: 0 }; continue; }
      if (res.status === 404) return null;
      if (res.status === 429) throw new AppError('Muitas consultas à Pluggy agora. Aguarde um minuto e sincronize de novo.', 429, 'pluggy_rate');
      if (!res.ok) throw new AppError(`Erro da Pluggy (${res.status}) ao consultar ${path.split('?')[0]}.`, 502, 'pluggy_error');
      return res.json();
    }
    throw new AppError('Não foi possível autenticar na Pluggy.', 502, 'pluggy_auth');
  }

  async function listAccounts(itemId) {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const data = await pluggyGet(`/accounts?itemId=${encodeURIComponent(itemId)}&page=${page}`);
      if (!data) break;
      out.push(...(data.results || []));
      if (!data.totalPages || page >= data.totalPages) break;
    }
    return out;
  }

  async function listTransactions(accountId, dateFrom) {
    const out = [];
    let query = `?accountId=${encodeURIComponent(accountId)}&dateFrom=${dateFrom}`;
    for (let i = 0; i < 40 && query; i++) {
      const data = await pluggyGet(`/v2/transactions${query}`);
      if (!data) break;
      out.push(...(data.results || []));
      query = data.next || null; // a Pluggy devolve a query pronta da próxima página
    }
    return out;
  }

  // ---- Supabase (REST com o login do usuário → RLS vale)
  function db(token, apikey) {
    const base = env('SUPABASE_URL');
    const headers = (extra = {}) => ({ apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra });
    const fail = async (res, what) => {
      const body = await res.text();
      if (/PGRST20[45]|does not exist|Could not find/i.test(body)) {
        throw new AppError('Banco desatualizado: rode o schema.sql mais recente no SQL Editor do Supabase.', 500, 'schema');
      }
      throw new AppError(`Falha ao ${what} no banco (${res.status}).`, 500, 'db');
    };
    return {
      async select(table, query) {
        const res = await fetch(`${base}/rest/v1/${table}?${query}`, { headers: headers() });
        if (!res.ok) await fail(res, 'ler');
        return res.json();
      },
      async upsert(table, rows, onConflict) {
        for (let i = 0; i < rows.length; i += 500) {
          const url = `${base}/rest/v1/${table}${onConflict ? `?on_conflict=${onConflict}` : ''}`;
          const res = await fetch(url, {
            method: 'POST',
            headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
            body: JSON.stringify(rows.slice(i, i + 500)),
          });
          if (!res.ok) await fail(res, 'gravar');
        }
      },
      async update(table, query, patch) {
        const res = await fetch(`${base}/rest/v1/${table}?${query}`, { method: 'PATCH', headers: headers({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
        if (!res.ok) await fail(res, 'atualizar');
      },
    };
  }

  async function currentUser(req) {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) throw new AppError('Faça login para usar o Open Finance.', 401, 'unauthenticated');
    // Chave pública do projeto: a do ambiente ou a que o app enviou no cabeçalho.
    const apikey = env('SUPABASE_ANON_KEY') || req.headers.get('apikey') || '';
    const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
      headers: { apikey, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new AppError('Sessão expirada. Entre novamente.', 401, 'unauthenticated');
    const user = await res.json();
    if (!user?.id) throw new AppError('Sessão inválida. Entre novamente.', 401, 'unauthenticated');
    return { user, token, apikey };
  }

  const allowedEmails = () => String(env('PLUGGY_ALLOWED_EMAILS') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const isConfigured = () => Boolean(env('PLUGGY_CLIENT_ID') && env('PLUGGY_CLIENT_SECRET'));

  function requireAccess(user) {
    if (!isConfigured()) throw new AppError('A integração ainda não foi configurada: faltam os Secrets PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no Supabase.', 412, 'not_configured');
    const list = allowedEmails();
    if (!list.length) throw new AppError('Defina o Secret PLUGGY_ALLOWED_EMAILS no Supabase com o seu e-mail de login.', 412, 'no_allowlist');
    if (!list.includes(String(user.email || '').toLowerCase())) {
      throw new AppError('Sua conta não está autorizada a usar o Open Finance (Meu Pluggy é de uso pessoal).', 403, 'not_allowed');
    }
  }

  // ---- sincronização de uma conexão
  async function syncConnection(conn, user, token, apikey) {
    const store = db(token, apikey);
    const item = await pluggyGet(`/items/${encodeURIComponent(conn.external_item_id)}`);
    if (!item) {
      await store.update('bank_connections', `id=eq.${conn.id}`, { status: 'error', last_error: 'Item não encontrado na Pluggy. Ele pode ter sido removido — adicione a conexão de novo.' });
      return { connectionId: conn.id, institution: conn.institution, accounts: 0, imported: 0, skipped: 0, error: 'Item não encontrado na Pluggy.' };
    }
    const institution = item.connector?.name || conn.institution || 'Banco';
    const accounts = await listAccounts(conn.external_item_id);
    await store.upsert('bank_accounts', accounts.map((a) => mapAccount(a, conn.id, user.id)), 'user_id,id');

    // 1ª sincronização: até 12 meses. Depois: desde a última, com folga de 10 dias.
    const since = conn.last_sync_at
      ? isoDaysAgo(new Date(new Date(conn.last_sync_at).getTime()), 10)
      : isoDaysAgo(now(), 365);
    let imported = 0;
    let skipped = 0;
    for (const acc of accounts) {
      const txs = await listTransactions(acc.id, since);
      const rows = [];
      for (const tx of txs) {
        const row = await mapTransaction(tx, acc, conn.id, user.id);
        if (row && row.date) rows.push(row); else skipped += 1;
      }
      await store.upsert('transactions', rows);
      imported += rows.length;
    }
    const errorText = itemErrorText(item);
    await store.update('bank_connections', `id=eq.${conn.id}`, {
      institution,
      status: itemStatus(item),
      last_error: errorText,
      last_sync_at: now().toISOString(),
    });
    return { connectionId: conn.id, institution, accounts: accounts.length, imported, skipped, itemStatus: item.status, error: errorText };
  }

  // ---- ações
  async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    let body = {};
    try { body = await req.json(); } catch { /* corpo vazio */ }
    const { user, token, apikey } = await currentUser(req);

    if (body.action === 'status') {
      const list = allowedEmails();
      return json({
        configured: isConfigured(),
        allowlistSet: list.length > 0,
        allowed: list.includes(String(user.email || '').toLowerCase()),
        email: user.email,
      });
    }

    requireAccess(user);
    const store = db(token, apikey);

    if (body.action === 'add-item') {
      const itemId = String(body.itemId || '').trim();
      if (!UUID_RE.test(itemId)) throw new AppError('Item ID inválido. Ele tem o formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.', 400, 'bad_item');
      const existing = await store.select('bank_connections', `external_item_id=eq.${itemId}&select=id`);
      if (existing.length) throw new AppError('Esse Item ID já está conectado.', 409, 'duplicate');
      const item = await pluggyGet(`/items/${itemId}`);
      if (!item) throw new AppError('Item não encontrado na Pluggy. Confira se copiou o Item ID da mesma aplicação cujo Client ID está no Supabase.', 404, 'item_not_found');
      const conn = {
        id: await stableUuid(`pluggy-item:${user.id}:${itemId}`),
        user_id: user.id,
        bank_id: 'pluggy',
        provider: 'meupluggy',
        external_item_id: itemId,
        institution: item.connector?.name || 'Banco',
        status: itemStatus(item),
        account_mask: null,
        connected_at: now().toISOString(),
        last_sync_at: null,
        last_error: itemErrorText(item),
      };
      await store.upsert('bank_connections', [conn]);
      const result = await syncConnection(conn, user, token, apikey);
      return json({ ok: true, connection: { ...conn, last_sync_at: now().toISOString() }, result });
    }

    if (body.action === 'sync') {
      const filter = body.connectionId && UUID_RE.test(body.connectionId) ? `&id=eq.${body.connectionId}` : '';
      const conns = await store.select('bank_connections', `external_item_id=not.is.null${filter}&select=*`);
      const results = [];
      for (const c of conns) {
        try {
          results.push(await syncConnection(c, user, token, apikey));
        } catch (err) {
          if (err.code === 'schema' || err.code === 'pluggy_auth') throw err;
          results.push({ connectionId: c.id, institution: c.institution, error: err.message, accounts: 0, imported: 0, skipped: 0 });
        }
      }
      return json({ ok: true, results });
    }

    throw new AppError('Ação desconhecida.', 400, 'bad_action');
  }

  return async (req) => {
    try {
      return await handle(req);
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      if (!(err instanceof AppError)) console.error(err);
      return json({ error: err instanceof AppError ? err.message : 'Erro inesperado na função.', code: err.code || 'internal' }, status);
    }
  };
}

// Ponto de entrada no Supabase (Deno). Em testes (Node) esta linha não roda.
// @ts-ignore: Deno só existe no servidor do Supabase
const _deno = globalThis.Deno;
if (_deno?.serve) {
  _deno.serve(createHandler({ fetch: (...a) => globalThis.fetch(...a), env: (k) => _deno.env.get(k) }));
}
