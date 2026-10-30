// Regras de negócio puras (sem DOM): recorrências, status, KPIs e agregações.
import { todayISO, currentYM, ymOf, dayOf, daysInMonth, dateWithDay, addMonths, sum, round2, toISODate } from '../utils.js';

// ------------------------------------------------------------------ status
/** Ainda não aconteceu/não foi pago: previsto, agendado (a pagar) ou com data futura. */
export const isPlanned = (tx, today = todayISO()) => tx.projected === true || tx.status === 'pending' || tx.date > today;
/** A pagar com data já vencida. */
export const isOverdue = (tx, today = todayISO()) => isPlanned(tx, today) && tx.date < today;

// ------------------------------------------------------------------ recorrências
export const FREQ_LABEL = { weekly: 'Semanal', monthly: 'Mensal', yearly: 'Anual' };

/** Data da 1ª ocorrência (regras antigas só tinham startMonth + day). */
export function ruleStart(r) {
  return r.startDate || dateWithDay(r.startMonth, r.day || 1);
}

/** Último dia permitido pela regra (endDate ou endMonth antigo). */
function ruleEnd(r) {
  if (r.endDate) return r.endDate;
  if (r.endMonth) return dateWithDay(r.endMonth, 31);
  return null;
}

function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return toISODate(new Date(y, m - 1, d + n));
}

/** k-ésima ocorrência (k = 0, 1, 2…). */
export function nthOccurrence(r, k) {
  const start = ruleStart(r);
  const freq = r.frequency || 'monthly';
  if (freq === 'weekly') return addDaysISO(start, 7 * k);
  const step = freq === 'yearly' ? 12 : 1;
  return dateWithDay(addMonths(ymOf(start), step * k), dayOf(start));
}

/** Ocorrências entre from e to (inclusive): [{date, index}] — index começa em 1. */
export function occurrencesBetween(r, from, to) {
  const end = ruleEnd(r);
  const out = [];
  for (let k = 0; k < 5000; k++) {
    if (r.occurrences && k >= r.occurrences) break;
    const date = nthOccurrence(r, k);
    if (date > to || (end && date > end)) break;
    if (date >= from) out.push({ date, index: k + 1 });
  }
  return out;
}

/** Texto curto: "Mensal · dia 10 · 3 de 12" etc. */
export function ruleSummary(r) {
  const freq = r.frequency || 'monthly';
  const start = ruleStart(r);
  const when = freq === 'weekly'
    ? ['todo domingo', 'toda segunda', 'toda terça', 'toda quarta', 'toda quinta', 'toda sexta', 'todo sábado'][new Date(`${start}T12:00:00`).getDay()]
    : freq === 'yearly' ? `todo ano em ${start.slice(8, 10)}/${start.slice(5, 7)}` : `todo dia ${dayOf(start)}`;
  let dur = '';
  if (r.occurrences) dur = ` · ${r.occurrences}x`;
  else if (ruleEnd(r)) dur = ` · até ${ruleEnd(r).split('-').reverse().join('/')}`;
  return `${when}${dur}`;
}

/** A regra ainda gera ocorrências a partir de hoje? */
export function ruleIsActive(r, today = todayISO()) {
  if (r.active === false) return false;
  return occurrencesBetween(r, today, '9999-12-31').length > 0 || occurrencesBetween(r, dateWithDay(ymOf(today), 1), today).length > 0;
}

/**
 * Ocorrências previstas (virtuais) das regras para o mês — só mês atual e futuros.
 * No mês atual, ocorrências vencidas e não pagas aparecem como "atrasadas".
 */
export function projectRecurring(rules, realInMonth, ym, today = todayISO()) {
  if (ym < ymOf(today)) return [];
  const from = `${ym}-01`;
  const to = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
  const out = [];
  rules.filter((r) => r.active !== false).forEach((r) => {
    const freq = r.frequency || 'monthly';
    occurrencesBetween(r, from, to).forEach((o) => {
      const paid = realInMonth.some((t) => t.recurringId === r.id && (t.date === o.date || (freq !== 'weekly' && ymOf(t.date) === ym)));
      if (paid) return;
      out.push({
        id: `proj-${r.id}-${o.date}`,
        description: r.description,
        amount: r.amount,
        type: r.type,
        category: r.category,
        date: o.date,
        source: 'manual',
        status: 'pending',
        recurringId: r.id,
        recurringKind: r.kind,
        occurrence: r.occurrences ? { current: o.index, total: r.occurrences } : null,
        projected: true,
      });
    });
  });
  return out;
}

const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

export function transactionsForMonth(state, ym) {
  const real = state.transactions.filter((t) => ymOf(t.date) === ym);
  const projected = projectRecurring(state.recurring, real, ym, state.today);
  return [...real, ...projected].sort(byDateDesc);
}

/** Saldo real hoje = saldo inicial + tudo que já foi pago/recebido. */
export function currentBalance(state) {
  const done = state.transactions.filter((t) => !isPlanned(t, state.today));
  return round2(state.settings.openingBalance + sum(done, (t) => (t.type === 'income' ? t.amount : -t.amount)));
}

export function monthMode(ym, today = todayISO()) {
  const cur = ymOf(today);
  return ym < cur ? 'past' : ym > cur ? 'future' : 'current';
}

/** Pendências: atrasadas (qualquer mês) + o que vence nos próximos `days` dias. */
export function upcomingItems(state, days = 30) {
  const today = state.today;
  const limit = addDaysISO(today, days);
  const cur = ymOf(today);
  const seen = new Set();
  const out = [];
  // Lançamentos reais marcados "a pagar" (inclui meses anteriores esquecidos)
  state.transactions.filter((t) => t.status === 'pending' && t.date <= limit).forEach((t) => { out.push(t); seen.add(t.id); });
  // Previsões das regras (mês atual em diante)
  for (let m = cur; m <= ymOf(limit); m = addMonths(m, 1)) {
    transactionsForMonth(state, m)
      .filter((t) => t.projected && t.date <= limit && !seen.has(t.id))
      .forEach((t) => out.push(t));
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function monthSummary(state, ym) {
  const items = transactionsForMonth(state, ym);
  const done = items.filter((t) => !isPlanned(t, state.today));
  const planned = items.filter((t) => isPlanned(t, state.today));
  const mode = monthMode(ym, state.today);
  const budget = state.settings.monthlyBudget;
  const dim = daysInMonth(ym);

  const spent = sum(done.filter((t) => t.type === 'expense'), (t) => t.amount);
  const earned = sum(done.filter((t) => t.type === 'income'), (t) => t.amount);
  const plannedExpense = sum(planned.filter((t) => t.type === 'expense'), (t) => t.amount);
  const plannedIncome = sum(planned.filter((t) => t.type === 'income'), (t) => t.amount);

  const balance = currentBalance(state);
  // Saldo projetado ao fim do mês selecionado (atual/futuro): soma tudo que ainda está pendente até lá.
  let projectedEnd = balance;
  if (mode !== 'past') {
    const end = `${ym}-${String(dim).padStart(2, '0')}`;
    const pendingReal = state.transactions.filter((t) => isPlanned(t, state.today) && t.date <= end);
    projectedEnd += sum(pendingReal, (t) => (t.type === 'income' ? t.amount : -t.amount));
    for (let m = ymOf(state.today); m <= ym; m = addMonths(m, 1)) {
      const p = transactionsForMonth(state, m).filter((t) => t.projected);
      projectedEnd += sum(p, (t) => (t.type === 'income' ? t.amount : -t.amount));
    }
  }

  let available, daily, dailyText, daysLeft;
  if (mode === 'current') {
    daysLeft = dim - dayOf(state.today) + 1;
    available = round2(budget - spent - plannedExpense);
    daily = available > 0 ? round2(available / daysLeft) : 0;
    dailyText = available > 0
      ? `Você pode gastar ${'{v}'} por dia até o dia ${dim}`
      : 'Orçamento do mês esgotado — segure os gastos variáveis';
  } else if (mode === 'past') {
    daysLeft = 0;
    available = round2(budget - spent);
    daily = round2(spent / dim);
    dailyText = 'Média diária gasta no mês';
  } else {
    daysLeft = dim;
    available = round2(budget - plannedExpense);
    daily = available > 0 ? round2(available / dim) : 0;
    dailyText = `Teto diário estimado para ${dim} dias`;
  }

  const pieSource = mode === 'future' ? planned : done;
  const byCat = new Map();
  pieSource.filter((t) => t.type === 'expense').forEach((t) => byCat.set(t.category, round2((byCat.get(t.category) || 0) + t.amount)));
  const categories = [...byCat.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);

  return {
    ym, mode, items, budget, balance, projectedEnd: round2(projectedEnd),
    spent, earned, plannedExpense, plannedIncome, available, daily, dailyText, daysLeft,
    budgetUsedPct: budget > 0 ? Math.min(100, ((mode === 'future' ? plannedExpense : spent + plannedExpense) / budget) * 100) : 0,
    categories,
  };
}

export function evolutionSeries(state, centerYM, before = 4, after = 1) {
  const out = [];
  for (let i = -before; i <= after; i++) {
    const ym = addMonths(centerYM, i);
    const items = transactionsForMonth(state, ym);
    out.push({
      ym,
      mode: monthMode(ym, state.today),
      income: sum(items.filter((t) => t.type === 'income'), (t) => t.amount),
      expense: sum(items.filter((t) => t.type === 'expense'), (t) => t.amount),
    });
  }
  return out;
}

export function installmentGroups(state) {
  const groups = new Map();
  state.transactions.filter((t) => t.installment?.groupId).forEach((t) => {
    const g = groups.get(t.installment.groupId) || { id: t.installment.groupId, description: t.description, category: t.category, amount: t.amount, total: t.installment.total, paid: 0, last: t.date };
    if (!isPlanned(t, state.today)) g.paid += 1;
    if (t.date > g.last) g.last = t.date;
    groups.set(g.id, g);
  });
  return [...groups.values()].filter((g) => g.paid < g.total).map((g) => ({ ...g, remaining: round2((g.total - g.paid) * g.amount) }));
}

export { currentYM };
