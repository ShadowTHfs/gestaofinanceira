// =============================================================================
// SERVIÇO OPEN FINANCE — Pluggy / Meu Pluggy (REAL)
// -----------------------------------------------------------------------------
// O navegador NUNCA fala direto com a Pluggy: ele chama a Edge Function
// "pluggy" do Supabase, que guarda o Client Secret e grava os dados com o
// login do próprio usuário (RLS).
//
// Requisitos: modo nuvem (Supabase + login), a função "pluggy" publicada e os
// Secrets PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET e PLUGGY_ALLOWED_EMAILS.
// =============================================================================
import { getSupabase, getRepositoryStatus } from './supabaseClient.js';

export const FUNCTION_NAME = 'pluggy';

/** Erro amigável com um "code" para a interface decidir o que mostrar. */
export class OpenFinanceError extends Error {
  constructor(message, code = 'error') {
    super(message);
    this.code = code;
  }
}

async function invoke(body) {
  const sb = getSupabase();
  if (!sb || getRepositoryStatus().backend !== 'supabase') {
    throw new OpenFinanceError('Entre com sua conta para usar o Open Finance.', 'local_mode');
  }
  const { data, error } = await sb.functions.invoke(FUNCTION_NAME, { body });
  if (!error) return data;

  // A função respondeu com erro (4xx/5xx): lê a mensagem que ela mandou.
  const res = error.context;
  if (res && typeof res.json === 'function') {
    let payload = null;
    try { payload = await res.clone().json(); } catch { /* sem JSON */ }
    if (payload?.error) throw new OpenFinanceError(payload.error, payload.code || 'error');
    if (res.status === 404) throw new OpenFinanceError('A função "pluggy" ainda não foi publicada no Supabase.', 'not_deployed');
    throw new OpenFinanceError(`A função respondeu com erro ${res.status}.`, 'error');
  }
  // Não chegou a falar com a função (não existe, rede, CORS).
  const msg = String(error.message || '');
  if (/Failed to send|fetch|NetworkError|Load failed/i.test(msg)) {
    throw new OpenFinanceError('Não consegui falar com a função "pluggy". Ela foi publicada no Supabase com esse nome?', 'not_deployed');
  }
  throw new OpenFinanceError(msg || 'Erro ao chamar a função.', 'error');
}

/** { configured, allowlistSet, allowed, email } */
export const getStatus = () => invoke({ action: 'status' });

/** Valida o Item ID na Pluggy, salva a conexão e importa contas e transações. */
export const addItem = (itemId) => invoke({ action: 'add-item', itemId: String(itemId || '').trim() });

/** Atualiza contas e transações (todas as conexões ou uma). */
export const sync = (connectionId) => invoke({ action: 'sync', ...(connectionId ? { connectionId } : {}) });

export const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '').trim());
