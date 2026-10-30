// Utilitários puros: moeda, datas (sem armadilhas de fuso horário) e strings.

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export const fmt = (v) => BRL.format(Number.isFinite(v) ? v : 0);
export const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
export const pad = (n) => String(n).padStart(2, '0');

/** Data local → 'AAAA-MM-DD' (não usa toISOString, que converte para UTC). */
export const toISODate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayISO = () => toISODate(new Date());
export const ymOf = (iso) => String(iso).slice(0, 7);
export const dayOf = (iso) => Number(String(iso).slice(8, 10));
export const currentYM = () => ymOf(todayISO());

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** Monta uma data dentro do mês respeitando meses curtos (dia 31 → 28/29/30). */
export const dateWithDay = (ym, day) => `${ym}-${pad(Math.min(Math.max(1, day), daysInMonth(ym)))}`;

export function monthLabel(ym, { short = false, withYear = true } = {}) {
  const [y, m] = ym.split('-').map(Number);
  const name = (short ? MONTHS_SHORT : MONTHS)[m - 1];
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return withYear ? `${cap}${short ? '/' + String(y).slice(2) : ' de ' + y}` : cap;
}

export function dateLabel(iso, today = todayISO()) {
  if (iso === today) return 'Hoje';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  if (iso === toISODate(yd)) return 'Ontem';
  return `${WEEKDAYS[dt.getDay()]}, ${d} de ${MONTHS[m - 1]}`.replace(/^./, (c) => c.toUpperCase());
}

export const shortDate = (iso) => `${pad(dayOf(iso))} ${MONTHS_SHORT[Number(iso.slice(5, 7)) - 1]}`;

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // Fallback (contextos sem HTTPS): UUID v4 compatível com a coluna uuid do Postgres.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Aceita "1.234,56", "1234,56", "1234.56", "R$ 50". Retorna NaN se inválido. */
export function parseMoney(input) {
  let s = String(input ?? '').replace(/[R$\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? round2(n) : NaN;
}

export const sum = (arr, fn = (x) => x) => round2(arr.reduce((acc, x) => acc + Number(fn(x) || 0), 0));
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
