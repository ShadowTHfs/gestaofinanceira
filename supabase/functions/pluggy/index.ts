// @ts-nocheck — código em JavaScript puro (sem anotações de tipo), roda igual no Deno.
// =============================================================================
// Edge Function "pluggy" — Open Finance real via Pluggy / Meu Pluggy
// -----------------------------------------------------------------------------
// Roda no servidor do Supabase. O Client Secret da Pluggy fica SÓ aqui
// (nos Secrets do Supabase) e nunca chega ao navegador.
//
// CADA PESSOA USA A PRÓPRIA CHAVE DA PLUGGY (Meu Pluggy é de uso pessoal).
// A pessoa cola Client ID + Client Secret no app; a função valida na Pluggy,
// CRIPTOGRAFA o Secret (AES-GCM) e guarda em public.pluggy_credentials.
//
// Secrets do Supabase (Edge Functions → Secrets) — todos OPCIONAIS:
//   PLUGGY_ALLOWED_EMAILS   → e-mails (vírgula) que podem usar o Open Finance.
//                             Vazio = qualquer pessoa logada (com a própria chave).
//   PLUGGY_ENCRYPTION_KEY   → chave da criptografia. Se vazio, usa a
//                             SUPABASE_SERVICE_ROLE_KEY (já existe no servidor).
//   PLUGGY_CLIENT_ID / PLUGGY_CLIENT_SECRET → chave "compartilhada" antiga;
//                             só vale para e-mails da lista e para quem ainda
//                             não cadastrou a própria chave.
//
// Ações (POST JSON { action, ... }):
//   status                                  → situação da integração p/ quem chamou
//   save-credentials { clientId, clientSecret } → valida na Pluggy e salva (criptografado)
//   delete-credentials                      → apaga a chave salva
//   add-item  { itemId }                    → valida o Item, salva e sincroniza
//   sync      { connectionId? }             → atualiza contas e transações
//   notify-create / notify-revoke           → código secreto do celular (tempo real)
//   hook-enable / hook-disable              → webhook da Pluggy (atualiza sozinho)
//
// Rotas SEM login (cada uma com o seu próprio código secreto):
//   ?route=notify       → o celular (MacroDroid) manda a notificação do banco
//                         cabeçalho x-gf-token: <código da pessoa>
//   ?route=pluggy-hook  → a Pluggy avisa que chegaram dados novos
//                         cabeçalho x-gf-hook: <código criado em hook-enable>
// Por isso, nas Settings da função, "Verify JWT" fica DESLIGADO: a própria
// função confere o login (ações) ou o código secreto (rotas) em cada chamada.
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

// ---------------------------------------------------------------- criptografia (AES-GCM)
const b64encode = (bytes) => { let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
const b64decode = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

async function aesKey(material) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`gf-pluggy-v1:${material}`));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptText(plain, material) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(material), new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return `v1:${b64encode(out)}`;
}

export async function decryptText(payload, material) {
  const raw = b64decode(String(payload).replace(/^v1:/, ''));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(material), raw.slice(12));
  return new TextDecoder().decode(pt);
}

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

// ---------------------------------------------------------------- notificações do celular
const BANK_NAMES = [
  [/nubank|com\.nu\.|\bnu\b/i, 'Nubank'],
  [/picpay/i, 'PicPay'],
  [/mercado ?pago|mercadopago/i, 'Mercado Pago'],
  [/infinite ?pay|infinitepay|cloudwalk/i, 'InfinitePay'],
  [/caixa|cef\b/i, 'Caixa'],
  [/bradesco/i, 'Bradesco'],
  [/ita[uú]/i, 'Itaú'],
  [/banco do brasil|br\.com\.bb|\bbb\b/i, 'Banco do Brasil'],
  [/\binter\b|bancointer/i, 'Inter'],
  [/santander/i, 'Santander'],
  [/\bc6\b/i, 'C6 Bank'],
];

const IGNORE_RE = /fatura|limite|lembrete|vence|vencimento|oferta|promo|cashback|rendimento|rendeu|c[oó]digo|token|senha|seguran[cç]a|acesso|login|empr[eé]stimo|pr[eé]-aprovad|agendad|programad|negad|recusad|n[aã]o aprovad|n[aã]o autorizad|cancelad|bloquead|cobran[cç]a gerada|boleto gerado|sorteio|pontos/i;
const REFUND_RE = /estorno|estornad|devolu[cç][aã]o|reembolso/i;
const STRONG_INCOME_RE = /recebeu|recebid|recebimento|caiu na|caiu um|entrou|dep[oó]sito recebido|cr[eé]dito em conta|venda aprovada|voc[eê] vendeu|nova venda/i;
const INCOME_RE = /entrada|dep[oó]sito/i;
const EXPENSE_RE = /envi(ou|ado|ada|amos)|pagou|pagamento|compra|d[eé]bito|debitad|sa[ií]da|transferiu|transfer[eê]ncia (realizada|feita|enviada)|saque|pix (enviado|feito|realizado)|aprovad/i;

/** "R$ 1.234,56" → 1234.56 (primeiro valor em reais do texto). */
export function amountFromText(text) {
  const m = String(text).match(/R\$\s?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/i)
    || String(text).match(/(?:^|\s)(\d{1,3}(?:\.\d{3})*,\d{2})(?:\s|$|[.!])/);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? round2(n) : null;
}

function counterpartFrom(text, kind) {
  const t = String(text).replace(/\s+/g, ' ');
  const stop = '(?=\\s*(?:[.,!;:]|\\s(?:na|no|em|via|pelo|pela|com|para|foi|às|as|hoje|final|cart[aã]o|aprovad[ao])\\b|$))';
  const name = "([A-Za-zÀ-ú0-9@*'&][A-Za-zÀ-ú0-9@*'&.\\- ]{1,48}?)";
  const re = kind === 'income'
    ? new RegExp(`\\bde\\s+(?:R\\$\\s?[\\d.,]+\\s+de\\s+)?${name}${stop}`, 'gi')
    : new RegExp(`\\b(?:para|em|no|na)\\s+${name}${stop}`, 'gi');
  for (const m of t.matchAll(re)) {
    const cand = m[1].replace(/R\$\s?[\d.,]+/g, '').trim();
    if (!cand || /^(sua|seu|o|a|conta|cart[aã]o|valor|r\$|pix|d[eé]bito|cr[eé]dito|um|uma|transfer[eê]ncia|compra|dinheiro)\b/i.test(cand)) continue;
    return cand.slice(0, 48);
  }
  return null;
}

/**
 * Lê uma notificação de banco. Retorna:
 *  { status: 'lancada', type, amount, description, category, bank }  ou
 *  { status: 'ignorada' | 'nao_reconhecida', reason }
 */
export function parseNotification({ app = '', title = '', text = '' }) {
  const full = `${title} ${text}`.replace(/\s+/g, ' ').trim();
  const bank = (BANK_NAMES.find(([re]) => re.test(`${app} ${title}`)) || [null, String(app || '').slice(0, 30) || 'Banco'])[1];
  if (!full) return { status: 'nao_reconhecida', reason: 'Notificação sem texto.' };
  const amount = amountFromText(full);
  const refund = REFUND_RE.test(full);
  if (!refund && IGNORE_RE.test(full)) return { status: 'ignorada', reason: 'Aviso que não é dinheiro entrando ou saindo agora (fatura, limite, agendamento, código…).', bank };
  if (!amount) return { status: 'nao_reconhecida', reason: 'Não encontrei o valor (R$) no texto.', bank };

  let type = null;
  if (refund || STRONG_INCOME_RE.test(full)) type = 'income';
  else if (EXPENSE_RE.test(full)) type = 'expense';
  else if (INCOME_RE.test(full)) type = 'income';
  if (!type) return { status: 'nao_reconhecida', reason: 'Não deu para saber se é entrada ou saída.', bank };

  const pix = /\bpix\b/i.test(full);
  const card = /cart[aã]o|compra|cr[eé]dito|d[eé]bito/i.test(full) && !pix;
  const sale = /venda/i.test(full);
  const cp = counterpartFrom(full, type);
  let description;
  if (type === 'income') {
    description = refund ? `Estorno${cp ? ` de ${cp}` : ''}` : sale ? `Venda${cp ? ` · ${cp}` : ''}` : pix ? (cp ? `Pix de ${cp}` : 'Pix recebido') : (cp ? `Recebido de ${cp}` : 'Entrada');
  } else {
    description = card ? (cp || 'Compra no cartão') : pix ? (cp ? `Pix para ${cp}` : 'Pix enviado') : (cp || 'Saída');
  }
  let category;
  if (type === 'income') category = sale || /sal[aá]rio/i.test(full) ? 'trabalho' : 'outras_receitas';
  else category = merchantCategory(cp || '');
  return { status: 'lancada', type, amount, description: description.slice(0, 120), category, bank };
}

// Categoria pelo nome de quem recebeu (só o nome: o texto do banco tem "compra", "mercado pago"… que enganam).
const MERCHANT_RULES = [
  [/mercado ?livre|amazon|shopee|shein|magalu|aliexpress/i, 'compras'],
  [/ifood|rappi|restaurante|lanchonete|pizzaria|padaria|mercado|supermerc|atacad|assa[ií]|carrefour|burger|mc ?donald|a[cç]ougue|hortifruti/i, 'alimentacao'],
  [/uber|\b99\b|posto|combust|ipiranga|shell|petrobras|estacionamento|ped[aá]gio|sem parar|metr[oô]|[oô]nibus/i, 'transporte'],
  [/farm[aá]cia|drogaria|droga ?raia|drogasil|pague menos|cl[ií]nica|hospital|laborat|academia|smart ?fit/i, 'saude'],
  [/netflix|spotify|disney|prime video|amazon prime|youtube|google one|icloud|apple\.com|hbo|max\b|deezer|globoplay/i, 'assinaturas'],
  [/escola|faculdade|curso|udemy|alura|livraria/i, 'educacao'],
  [/energia|enel|cemig|copel|light|sabesp|[aá]gua|aluguel|condom[ií]nio|vivo|claro|\btim\b|\boi\b|internet/i, 'moradia'],
  [/cinema|ingresso|bar\b|show|viagem|hotel|airbnb|latam|gol\b|azul\b|steam|playstation|xbox/i, 'lazer'],
  [/amazon|shopee|shein|magalu|magazine|americanas|aliexpress|mercado ?livre|renner|riachuelo|c&a|centauro|netshoes/i, 'compras'],
];
export function merchantCategory(name) {
  const hit = MERCHANT_RULES.find(([re]) => re.test(String(name)));
  return hit ? hit[1] : 'outros';
}

/** Lê o corpo enviado pelo celular: JSON, formulário ou texto (linha 1 = app, 2 = título, resto = texto). */
async function readNotificationBody(req) {
  const ctype = (req.headers.get('content-type') || '').toLowerCase();
  const raw = await req.text();
  if (ctype.includes('json') || /^\s*\{/.test(raw)) {
    try {
      const j = JSON.parse(raw);
      return { app: String(j.app || j.package || ''), title: String(j.title || ''), text: String(j.text || j.body || j.message || ''), test: Boolean(j.test) };
    } catch { /* texto com aspas quebrou o JSON: trata como texto */ }
  }
  if (ctype.includes('x-www-form-urlencoded')) {
    const f = new URLSearchParams(raw);
    return { app: f.get('app') || '', title: f.get('title') || '', text: f.get('text') || '', test: f.get('test') === '1' };
  }
  const lines = raw.split(/\r?\n/);
  if (lines.length >= 3) return { app: lines[0], title: lines[1], text: lines.slice(2).join(' '), test: false };
  return { app: '', title: '', text: raw, test: false };
}

const sha256hex = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

function randomToken(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `${prefix}_${b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** Data de hoje em Brasília (AAAA-MM-DD). */
const todayBR = (now) => new Date(now.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);

const dayOffset = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);

/**
 * Casa prévias (vindas da notificação) com transações oficiais do banco:
 * mesmo tipo, mesmo valor, data oficial de 1 dia antes até 3 dias depois da prévia.
 * Cada oficial só serve para uma prévia. Retorna [{ previewId, officialId, rawText }].
 */
export function matchPreviews(previews, officials) {
  const used = new Set();
  const pairs = [];
  const sorted = [...previews].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const p of sorted) {
    let best = null;
    for (const o of officials) {
      if (used.has(o.id) || o.type !== p.type || Math.abs(Number(o.amount) - Number(p.amount)) >= 0.005) continue;
      const d = dayOffset(p.date, o.date);
      if (d < -1 || d > 3) continue;
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { o, d };
    }
    if (best) { used.add(best.o.id); pairs.push({ previewId: p.id, officialId: best.o.id, rawText: p.raw_text || null }); }
  }
  return pairs;
}

// ---------------------------------------------------------------- handler
export function createHandler({ fetch, env, now = () => new Date() }) {
  const apiKeyCache = new Map(); // clientId → { key, exp }

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  // ---- Pluggy
  async function pluggyKey(creds) {
    const hit = apiKeyCache.get(creds.clientId);
    if (hit && hit.exp > Date.now() && hit.secret === creds.clientSecret) return hit.key;
    const res = await fetch(`${PLUGGY_API}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: creds.clientId, clientSecret: creds.clientSecret }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new AppError(creds.shared
        ? 'A chave compartilhada da Pluggy (Secrets do Supabase) está incorreta.'
        : 'Seu Client ID ou Client Secret da Pluggy não foi aceito. Confira no Dashboard da Pluggy e cadastre de novo.', 502, 'pluggy_auth');
    }
    if (!res.ok) throw new AppError(`A Pluggy não respondeu (erro ${res.status}). Tente de novo em instantes.`, 502, 'pluggy_down');
    const { apiKey } = await res.json();
    apiKeyCache.set(creds.clientId, { key: apiKey, secret: creds.clientSecret, exp: Date.now() + 100 * 60 * 1000 }); // vale 2h; renova antes
    return apiKey;
  }

  async function pluggyGet(creds, path) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${PLUGGY_API}${path}`, { headers: { 'X-API-KEY': await pluggyKey(creds) } });
      if (res.status === 401 && attempt === 0) { apiKeyCache.delete(creds.clientId); continue; }
      if (res.status === 404) return null;
      if (res.status === 429) throw new AppError('Muitas consultas à Pluggy agora. Aguarde um minuto e sincronize de novo.', 429, 'pluggy_rate');
      if (!res.ok) throw new AppError(`Erro da Pluggy (${res.status}) ao consultar ${path.split('?')[0]}.`, 502, 'pluggy_error');
      return res.json();
    }
    throw new AppError('Não foi possível autenticar na Pluggy.', 502, 'pluggy_auth');
  }

  async function pluggySend(creds, method, path, payload) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${PLUGGY_API}${path}`, {
        method,
        headers: { 'X-API-KEY': await pluggyKey(creds), 'Content-Type': 'application/json' },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      if (res.status === 401 && attempt === 0) { apiKeyCache.delete(creds.clientId); continue; }
      if (res.status === 404 && method === 'DELETE') return null; // já não existe: tudo bem
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new AppError(`A Pluggy recusou ${method} ${path.split('?')[0]} (${res.status})${text ? `: ${text.slice(0, 160)}` : ''}.`, 502, 'pluggy_error');
      }
      return res.status === 204 ? null : res.json().catch(() => null);
    }
    throw new AppError('Não foi possível autenticar na Pluggy.', 502, 'pluggy_auth');
  }

  async function listAccounts(creds, itemId) {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const data = await pluggyGet(creds, `/accounts?itemId=${encodeURIComponent(itemId)}&page=${page}`);
      if (!data) break;
      out.push(...(data.results || []));
      if (!data.totalPages || page >= data.totalPages) break;
    }
    return out;
  }

  async function listTransactions(creds, accountId, dateFrom) {
    const out = [];
    let query = `?accountId=${encodeURIComponent(accountId)}&dateFrom=${dateFrom}`;
    for (let i = 0; i < 40 && query; i++) {
      const data = await pluggyGet(creds, `/v2/transactions${query}`);
      if (!data) break;
      out.push(...(data.results || []));
      query = data.next || null; // a Pluggy devolve a query pronta da próxima página
    }
    return out;
  }

  // ---- Supabase (REST com o login do usuário → RLS vale)
  function db(token, apikey) {
    const base = env('SUPABASE_URL');
    const headers = (extra = {}) => ({ apikey, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...extra });
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
        if (!rows.length) return;
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
      async remove(table, query) {
        const res = await fetch(`${base}/rest/v1/${table}?${query}`, { method: 'DELETE', headers: headers({ Prefer: 'return=minimal' }) });
        if (!res.ok) await fail(res, 'apagar');
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

  /** Chave secreta do projeto (só no servidor): usada nas rotas sem login, que já conferiram o código secreto. */
  function serviceKey() {
    let key = env('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!key) {
      try {
        const all = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}');
        key = Object.values(all).find((v) => typeof v === 'string' && v) || '';
      } catch { key = ''; }
    }
    return key;
  }
  function serviceDb() {
    const key = serviceKey();
    if (!key) throw new AppError('O servidor está sem a chave de serviço do Supabase.', 500, 'no_service_key');
    // Chave antiga (JWT "eyJ…") vai também no Authorization; a nova (sb_secret_…) vai só no apikey.
    return db(key.startsWith('eyJ') ? key : null, key);
  }

  const allowedEmails = () => String(env('PLUGGY_ALLOWED_EMAILS') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const emailAllowed = (user) => { const l = allowedEmails(); return !l.length || l.includes(String(user.email || '').toLowerCase()); };
  const listedEmail = (user) => allowedEmails().includes(String(user.email || '').toLowerCase());
  const sharedCreds = () => (env('PLUGGY_CLIENT_ID') && env('PLUGGY_CLIENT_SECRET')
    ? { clientId: env('PLUGGY_CLIENT_ID'), clientSecret: env('PLUGGY_CLIENT_SECRET'), shared: true } : null);
  const encMaterial = () => env('PLUGGY_ENCRYPTION_KEY') || env('SUPABASE_SERVICE_ROLE_KEY') || '';

  function requireAccess(user) {
    if (!emailAllowed(user)) {
      throw new AppError('Sua conta não está na lista de pessoas autorizadas a usar o Open Finance neste app (PLUGGY_ALLOWED_EMAILS).', 403, 'not_allowed');
    }
  }

  async function loadOwnCreds(store) {
    const rows = await store.select('pluggy_credentials', 'select=client_id,client_secret_enc,updated_at&limit=1');
    return rows[0] || null;
  }

  /** Chave usada nas consultas: a da própria pessoa; senão a compartilhada (só p/ e-mails da lista). */
  async function resolveCreds(user, store) {
    const row = await loadOwnCreds(store);
    if (row) {
      const material = encMaterial();
      if (!material) throw new AppError('O servidor está sem chave de criptografia (defina o Secret PLUGGY_ENCRYPTION_KEY).', 500, 'no_encryption_key');
      let secret;
      try { secret = await decryptText(row.client_secret_enc, material); } catch {
        throw new AppError('Não consegui abrir sua chave salva (a chave de criptografia do servidor mudou). Cadastre sua chave da Pluggy de novo.', 409, 'decrypt_failed');
      }
      return { clientId: row.client_id, clientSecret: secret, shared: false };
    }
    const shared = sharedCreds();
    if (shared && listedEmail(user)) return shared;
    throw new AppError('Cadastre primeiro a sua chave da Pluggy (Client ID e Client Secret).', 412, 'no_credentials');
  }

  // ---- sincronização de uma conexão
  async function syncConnection(creds, conn, user, store) {
    const item = await pluggyGet(creds, `/items/${encodeURIComponent(conn.external_item_id)}`);
    if (!item) {
      await store.update('bank_connections', `id=eq.${conn.id}&user_id=eq.${user.id}`, { status: 'error', last_error: 'Item não encontrado na sua Pluggy. Ele pode ter sido removido, ou a chave cadastrada é de outra aplicação.' });
      return { connectionId: conn.id, institution: conn.institution, accounts: 0, imported: 0, skipped: 0, error: 'Item não encontrado na Pluggy.' };
    }
    const institution = item.connector?.name || conn.institution || 'Banco';
    const accounts = await listAccounts(creds, conn.external_item_id);
    await store.upsert('bank_accounts', accounts.map((a) => mapAccount(a, conn.id, user.id)), 'user_id,id');

    // 1ª sincronização: até 12 meses. Depois: desde a última, com folga de 10 dias.
    const since = conn.last_sync_at
      ? isoDaysAgo(new Date(new Date(conn.last_sync_at).getTime()), 10)
      : isoDaysAgo(now(), 365);
    let imported = 0;
    let skipped = 0;
    for (const acc of accounts) {
      const txs = await listTransactions(creds, acc.id, since);
      const rows = [];
      for (const tx of txs) {
        const row = await mapTransaction(tx, acc, conn.id, user.id);
        if (row && row.date) rows.push(row); else skipped += 1;
      }
      await store.upsert('transactions', rows);
      imported += rows.length;
    }
    const replaced = await replacePreviews(store, user.id, since);
    const errorText = itemErrorText(item);
    await store.update('bank_connections', `id=eq.${conn.id}&user_id=eq.${user.id}`, {
      institution,
      status: itemStatus(item),
      last_error: errorText,
      last_sync_at: now().toISOString(),
    });
    return { connectionId: conn.id, institution, accounts: accounts.length, imported, skipped, replaced, itemStatus: item.status, error: errorText };
  }

  /** Apaga as prévias que já chegaram oficialmente pelo banco (e guarda o texto da notificação na oficial). */
  async function replacePreviews(store, userId, since) {
    try {
      const from = isoDaysAgo(new Date(`${since}T12:00:00Z`), 3);
      const previews = await store.select('transactions', `user_id=eq.${userId}&source=eq.notification&is_preview=is.true&date=gte.${from}&select=id,type,amount,date,raw_text&limit=500`);
      if (!previews.length) return 0;
      // Só oficiais que ainda não "absorveram" outra prévia (raw_text vazio).
      const officials = await store.select('transactions', `user_id=eq.${userId}&source=eq.open_finance&raw_text=is.null&date=gte.${from}&select=id,type,amount,date&limit=5000`);
      const pairs = matchPreviews(previews, officials);
      for (const p of pairs) {
        await store.update('transactions', `id=eq.${p.officialId}&user_id=eq.${userId}`, { raw_text: p.rawText || 'notificação' });
      }
      if (pairs.length) await store.remove('transactions', `user_id=eq.${userId}&source=eq.notification&id=in.(${pairs.map((p) => p.previewId).join(',')})`);
      return pairs.length;
    } catch (err) {
      if (err.code === 'schema') return 0; // banco ainda sem a v6: segue sem trocar prévias
      throw err;
    }
  }

  // ---- rota: notificação do celular
  async function handleNotify(req) {
    const tok = (req.headers.get('x-gf-token') || '').trim();
    if (!/^gfn_[A-Za-z0-9_-]{20,}$/.test(tok)) throw new AppError('Código do celular ausente ou inválido (cabeçalho x-gf-token).', 401, 'bad_token');
    const sdb = serviceDb();
    const found = await sdb.select('notification_tokens', `token_hash=eq.${await sha256hex(tok)}&select=user_id`);
    if (!found.length) throw new AppError('Código do celular não reconhecido. Gere um novo no app (card Tempo real).', 401, 'bad_token');
    const userId = found[0].user_id;
    const n = await readNotificationBody(req);
    const clip = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const app = clip(n.app, 80);
    const title = clip(n.title, 200);
    const text = clip(n.text, 600);
    const parsed = parseNotification({ app, title, text });
    if (n.test) return json({ ok: true, test: true, parsed });

    const stamp = now();
    const date = todayBR(stamp);
    let status = parsed.status;
    let transactionId = null;
    if (status === 'lancada') {
      // A mesma notificação pode chegar 2x (o Android repete). Mesmo texto no mesmo intervalo de 2 minutos = a mesma.
      const bucket = Math.floor(stamp.getTime() / (2 * 60 * 1000));
      const id = await stableUuid(`notif:${userId}:${`${title} ${text}`.toLowerCase()}:${bucket}`);
      const again = await sdb.select('transactions', `id=eq.${id}&user_id=eq.${userId}&select=id`);
      // Se o banco já mandou essa transação oficialmente hoje, não duplica.
      const official = again.length ? [] : await sdb.select('transactions',
        `user_id=eq.${userId}&source=eq.open_finance&type=eq.${parsed.type}&amount=eq.${parsed.amount}&date=eq.${date}&raw_text=is.null&select=id&limit=1`);
      if (again.length) { status = 'duplicada'; transactionId = id; }
      else if (official.length) {
        status = 'duplicada'; transactionId = official[0].id;
        await sdb.update('transactions', `id=eq.${official[0].id}&user_id=eq.${userId}`, { raw_text: `${title} ${text}`.trim() });
      } else {
        await sdb.upsert('transactions', [{
          id, user_id: userId, description: parsed.description, amount: parsed.amount, date,
          category: parsed.category, type: parsed.type, source: 'notification', status: 'paid',
          is_preview: true, raw_text: `${title} ${text}`.trim(),
        }], 'id');
        transactionId = id;
      }
    }
    await sdb.upsert('notification_inbox', [{
      user_id: userId, received_at: stamp.toISOString(), app, title, body: text, status, transaction_id: transactionId,
    }]);
    await sdb.update('notification_tokens', `user_id=eq.${userId}`, { last_used_at: stamp.toISOString() });
    // Guarda só 30 dias de notificações recebidas.
    await sdb.remove('notification_inbox', `user_id=eq.${userId}&received_at=lt.${new Date(stamp.getTime() - 30 * 86400000).toISOString()}`);
    return json({ ok: true, status, reason: parsed.reason || null, type: parsed.type || null, amount: parsed.amount || null, description: parsed.description || null });
  }

  // ---- rota: webhook da Pluggy
  const HOOK_EVENTS = ['item/updated', 'transactions/created'];
  const hookUrl = () => `${env('SUPABASE_URL')}/functions/v1/pluggy?route=pluggy-hook`;

  async function handlePluggyHook(req) {
    const secret = (req.headers.get('x-gf-hook') || '').trim();
    if (!/^gfh_[A-Za-z0-9_-]{20,}$/.test(secret)) throw new AppError('Webhook sem código.', 401, 'bad_hook');
    const sdb = serviceDb();
    const found = await sdb.select('pluggy_webhooks', `hook_secret_hash=eq.${await sha256hex(secret)}&select=user_id`);
    if (!found.length) throw new AppError('Webhook desconhecido.', 401, 'bad_hook');
    const userId = found[0].user_id;
    let payload = {};
    try { payload = await req.json(); } catch { /* vazio */ }
    await sdb.update('pluggy_webhooks', `user_id=eq.${userId}`, { last_event_at: now().toISOString() });
    const itemId = String(payload.itemId || payload.item?.id || '');
    if (!HOOK_EVENTS.includes(payload.event) || !UUID_RE.test(itemId)) return json({ ok: true, ignored: true });

    const work = async () => {
      const conns = await sdb.select('bank_connections', `user_id=eq.${userId}&external_item_id=eq.${itemId}&select=*`);
      if (!conns.length) return { skipped: 'sem conexão' };
      const conn = conns[0];
      // A Pluggy manda item/updated e transactions/created juntos: sincroniza uma vez só.
      if (conn.last_sync_at && now().getTime() - Date.parse(conn.last_sync_at) < 2 * 60 * 1000) return { skipped: 'recente' };
      const rows = await sdb.select('pluggy_credentials', `user_id=eq.${userId}&select=client_id,client_secret_enc`);
      if (!rows.length) return { skipped: 'sem chave' };
      const clientSecret = await decryptText(rows[0].client_secret_enc, encMaterial());
      return syncConnection({ clientId: rows[0].client_id, clientSecret, shared: false }, conn, { id: userId }, sdb);
    };
    const task = work().catch((err) => { console.error('pluggy-hook', err?.message || err); return { error: err?.message }; });
    // Responde logo para a Pluggy; a sincronização continua em segundo plano.
    // @ts-ignore: EdgeRuntime só existe no Supabase
    const rt = globalThis.EdgeRuntime;
    if (rt?.waitUntil) { rt.waitUntil(task); return json({ ok: true, queued: true }); }
    return json({ ok: true, result: await task });
  }

  async function realtimeStatus(store, user) {
    try {
      const [tok] = await store.select('notification_tokens', `user_id=eq.${user.id}&select=created_at,last_used_at`);
      const [hook] = await store.select('pluggy_webhooks', `user_id=eq.${user.id}&select=created_at,last_event_at,webhook_ids`);
      return {
        realtimeReady: true,
        notify: tok ? { createdAt: tok.created_at, lastUsedAt: tok.last_used_at } : null,
        hook: hook ? { createdAt: hook.created_at, lastEventAt: hook.last_event_at, count: (hook.webhook_ids || []).length } : null,
        serviceReady: Boolean(serviceKey()),
      };
    } catch (err) {
      if (err.code === 'schema') return { realtimeReady: false, notify: null, hook: null, serviceReady: Boolean(serviceKey()) };
      throw err;
    }
  }

  // ---- ações
  async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    const route = new URL(req.url).searchParams.get('route');
    if (route === 'notify') return handleNotify(req);
    if (route === 'pluggy-hook') return handlePluggyHook(req);
    let body = {};
    try { body = await req.json(); } catch { /* corpo vazio */ }
    const { user, token, apikey } = await currentUser(req);

    const store = db(token, apikey);

    if (body.action === 'status') {
      const own = emailAllowed(user) ? await loadOwnCreds(store) : null;
      return json({
        email: user.email,
        allowed: emailAllowed(user),
        encryptionReady: Boolean(encMaterial()),
        hasOwnCredentials: Boolean(own),
        clientIdHint: own ? `…${String(own.client_id).slice(-4)}` : null,
        credentialsUpdatedAt: own?.updated_at || null,
        sharedAvailable: Boolean(sharedCreds()) && listedEmail(user),
        ...(await realtimeStatus(store, user)),
      });
    }

    requireAccess(user);

    if (body.action === 'save-credentials') {
      const clientId = String(body.clientId || '').trim();
      const clientSecret = String(body.clientSecret || '').trim();
      if (clientId.length < 8 || clientId.length > 200 || clientSecret.length < 8 || clientSecret.length > 400) {
        throw new AppError('Preencha o Client ID e o Client Secret exatamente como aparecem no Dashboard da Pluggy.', 400, 'bad_credentials');
      }
      const material = encMaterial();
      if (!material) throw new AppError('O servidor está sem chave de criptografia (defina o Secret PLUGGY_ENCRYPTION_KEY).', 500, 'no_encryption_key');
      apiKeyCache.delete(clientId);
      await pluggyKey({ clientId, clientSecret, shared: false }); // valida na Pluggy antes de salvar
      await store.upsert('pluggy_credentials', [{
        user_id: user.id, client_id: clientId, client_secret_enc: await encryptText(clientSecret, material), updated_at: now().toISOString(),
      }], 'user_id');
      return json({ ok: true, clientIdHint: `…${clientId.slice(-4)}` });
    }

    if (body.action === 'delete-credentials') {
      await store.remove('pluggy_credentials', `user_id=eq.${user.id}`);
      return json({ ok: true });
    }

    if (body.action === 'notify-create') {
      if (!serviceKey()) throw new AppError('O servidor está sem a chave de serviço do Supabase; o tempo real não funcionaria.', 500, 'no_service_key');
      const token = randomToken('gfn');
      await store.upsert('notification_tokens', [{
        user_id: user.id, token_hash: await sha256hex(token), created_at: now().toISOString(), last_used_at: null,
      }], 'user_id');
      return json({ ok: true, token, url: `${env('SUPABASE_URL')}/functions/v1/pluggy?route=notify` });
    }

    if (body.action === 'notify-revoke') {
      await store.remove('notification_tokens', `user_id=eq.${user.id}`);
      return json({ ok: true });
    }

    if (body.action === 'notify-test') {
      // Testa o leitor sem gravar nada (para a tela de configuração).
      return json({ ok: true, parsed: parseNotification({ app: String(body.app || ''), title: String(body.title || ''), text: String(body.text || '') }) });
    }

    const creds = await resolveCreds(user, store);

    if (body.action === 'hook-enable') {
      if (creds.shared) throw new AppError('A atualização automática precisa da SUA chave da Pluggy cadastrada no app.', 412, 'no_credentials');
      if (!serviceKey()) throw new AppError('O servidor está sem a chave de serviço do Supabase.', 500, 'no_service_key');
      const url = hookUrl();
      const list = await pluggyGet(creds, '/webhooks');
      for (const w of (list?.results || [])) {
        if (w.url === url) await pluggySend(creds, 'DELETE', `/webhooks/${encodeURIComponent(w.id)}`);
      }
      const secret = randomToken('gfh');
      const ids = [];
      for (const event of HOOK_EVENTS) {
        const created = await pluggySend(creds, 'POST', '/webhooks', { url, event, headers: { 'x-gf-hook': secret } });
        if (created?.id) ids.push(created.id);
      }
      await store.upsert('pluggy_webhooks', [{
        user_id: user.id, hook_secret_hash: await sha256hex(secret), webhook_ids: ids, created_at: now().toISOString(), last_event_at: null,
      }], 'user_id');
      return json({ ok: true, webhooks: ids.length });
    }

    if (body.action === 'hook-disable') {
      const [row] = await store.select('pluggy_webhooks', `user_id=eq.${user.id}&select=webhook_ids`);
      for (const id of (row?.webhook_ids || [])) await pluggySend(creds, 'DELETE', `/webhooks/${encodeURIComponent(id)}`);
      await store.remove('pluggy_webhooks', `user_id=eq.${user.id}`);
      return json({ ok: true });
    }

    if (body.action === 'add-item') {
      const itemId = String(body.itemId || '').trim();
      if (!UUID_RE.test(itemId)) throw new AppError('Item ID inválido. Ele tem o formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.', 400, 'bad_item');
      const existing = await store.select('bank_connections', `external_item_id=eq.${itemId}&select=id`);
      if (existing.length) throw new AppError('Esse Item ID já está conectado.', 409, 'duplicate');
      const item = await pluggyGet(creds, `/items/${itemId}`);
      if (!item) throw new AppError('Item não encontrado na sua Pluggy. Confira se copiou o Item ID da mesma aplicação cujo Client ID você cadastrou.', 404, 'item_not_found');
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
      const result = await syncConnection(creds, conn, user, store);
      return json({ ok: true, connection: { ...conn, last_sync_at: now().toISOString() }, result });
    }

    if (body.action === 'sync') {
      const filter = body.connectionId && UUID_RE.test(body.connectionId) ? `&id=eq.${body.connectionId}` : '';
      const conns = await store.select('bank_connections', `external_item_id=not.is.null${filter}&select=*`);
      const results = [];
      for (const c of conns) {
        try {
          results.push(await syncConnection(creds, c, user, store));
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
