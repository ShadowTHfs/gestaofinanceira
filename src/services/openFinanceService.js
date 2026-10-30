// =============================================================================
// SERVIÇO OPEN FINANCE — MODO SIMULAÇÃO
// -----------------------------------------------------------------------------
// ⚠️ Nada aqui acessa banco real. Os dados retornados são fictícios e marcados
// com provider: 'simulated'. Serve para deixar o app pronto para a integração.
//
// Para ligar de verdade no futuro (via um agregador autorizado pelo Banco
// Central, ex.: Pluggy ou Belvo), basta reescrever 3 funções mantendo as
// mesmas assinaturas:
//   connectBank(bankId)              → abre o widget de consentimento do provedor
//   fetchExternalStatement(conn, p)  → chama o backend (Supabase Edge Function),
//                                      que guarda as credenciais do provedor
//   normalizeExternalTransaction()   → adapta o formato do provedor ao do app
// As credenciais do provedor NUNCA devem ficar no navegador.
// =============================================================================

import { uid, delay, todayISO, ymOf, dateWithDay, dayOf, round2 } from '../utils.js';

export const PROVIDER = 'simulated';

export const SUPPORTED_BANKS = [
  { id: 'nubank', name: 'Nubank', initials: 'Nu', tint: 'from-purple-500 to-fuchsia-600' },
  { id: 'itau', name: 'Itaú', initials: 'It', tint: 'from-orange-400 to-amber-600' },
  { id: 'bradesco', name: 'Bradesco', initials: 'Br', tint: 'from-rose-500 to-red-600' },
];

export const getBank = (id) => SUPPORTED_BANKS.find((b) => b.id === id);

/** Simula o fluxo de consentimento e devolve a conexão criada. */
export async function connectBank(bankId) {
  if (!getBank(bankId)) throw new Error('Banco não suportado');
  await delay(1300);
  return {
    id: uid(),
    bankId,
    status: 'connected',
    provider: PROVIDER,
    accountMask: `•••• ${String(1000 + Math.floor(Math.random() * 8999))}`,
    connectedAt: new Date().toISOString(),
    lastSyncAt: null,
  };
}

export async function disconnectBank(connection) {
  await delay(400);
  return { ...connection, status: 'disconnected' };
}

// Modelos de lançamentos fictícios por banco (dados brutos "como viriam da API").
const TEMPLATES = {
  nubank: [
    { desc: 'Supermercado Bom Preço', amt: -187.4, mcc: 'grocery' },
    { desc: 'Corrida por aplicativo', amt: -23.9, mcc: 'transport' },
    { desc: 'Pix recebido · Cliente', amt: 350, mcc: 'transfer_in' },
    { desc: 'Padaria Central', amt: -18.5, mcc: 'restaurant' },
  ],
  itau: [
    { desc: 'Posto Avenida', amt: -160, mcc: 'fuel' },
    { desc: 'Farmácia Saúde+', amt: -64.3, mcc: 'pharmacy' },
    { desc: 'Rendimento poupança', amt: 21.37, mcc: 'interest' },
  ],
  bradesco: [
    { desc: 'Restaurante Sabor da Terra', amt: -72.8, mcc: 'restaurant' },
    { desc: 'Livraria Saber', amt: -89.9, mcc: 'education' },
    { desc: 'Cinema Shopping', amt: -54, mcc: 'entertainment' },
  ],
};

const MCC_TO_CATEGORY = {
  grocery: 'alimentacao', restaurant: 'alimentacao', transport: 'transporte', fuel: 'transporte',
  pharmacy: 'saude', education: 'educacao', entertainment: 'lazer', transfer_in: 'outras_receitas', interest: 'investimentos',
};

/** Simula a busca do extrato do mês atual (até hoje). Retorna dados no formato do app. */
export async function fetchExternalStatement(connection) {
  await delay(1100);
  const today = todayISO();
  const ym = ymOf(today);
  const maxDay = dayOf(today);
  const raw = (TEMPLATES[connection.bankId] || []).map((t, i) => ({
    id: `${connection.bankId}-${ym}-${i}`, // id estável → reimportar não duplica
    description: t.desc,
    amount: t.amt,
    bookingDate: dateWithDay(ym, Math.max(1, Math.round(((i + 1) / 5) * maxDay))),
    merchantCategory: t.mcc,
  }));
  return raw.map((r) => normalizeExternalTransaction(r, connection));
}

/** Adaptador: formato do provedor → modelo interno de transação. */
export function normalizeExternalTransaction(raw, connection) {
  const isIncome = raw.amount > 0;
  return {
    id: uid(),
    description: raw.description,
    amount: round2(Math.abs(raw.amount)),
    date: raw.bookingDate,
    type: isIncome ? 'income' : 'expense',
    category: MCC_TO_CATEGORY[raw.merchantCategory] || (isIncome ? 'outras_receitas' : 'outros'),
    source: 'open_finance',
    externalId: raw.id,
    accountId: connection.id,
    recurringId: null,
    installment: null,
  };
}
