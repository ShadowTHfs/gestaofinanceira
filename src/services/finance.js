// Regras de negócio puras (sem DOM): projeções, KPIs e agregações.
import { todayISO, currentYM, ymOf, dayOf, daysInMonth, dateWithDay, addMonths, sum, round2 } from '../utils.js';

export const isPlanned = (tx, today = todayISO()) => tx.projected === true || tx.date > today;

/** Gera lançamentos "previstos" das regras recorrentes (só mês atual e futuros). */
export function projectRecurring(rules, realInMonth, ym, today = todayISO()) {
  if (ym < ymOf(today)) return [];
  return rules
    .filter((r) => r.active !== false && r.startMonth <= ym && (!r.endMonth || r.endMonth >= ym))
    .filter((r) => !realInMonth.some((t) => t.recurringId === r.id))
    .map((r) => ({
      id: `proj-${r.id}-${ym}`,
      description: r.description,
      amount: r.amount,
      type: r.type,
      category: r.category,
      date: dateWithDay(ym, r.day),
      source: 'manual',
      recurringId: r.id,
      recurringKind: r.kind,
      projected: true,
    }))
    .filter((t) => t.date > today);
}

export function transactionsForMonth(state, ym) {
  const real = state.transactions.filter((t) => ymOf(t.date) === ym);
  const projected = projectRecurring(state.recurring, real, ym, state.today);
  return [...real, ...projected].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Saldo real hoje = saldo inicial + tudo que já aconteceu. */
export function currentBalance(state) {
  const done = state.transactions.filter((t) => t.date <= state.today);
  return round2(state.settings.openingBalance + sum(done, (t) => (t.type === 'income' ? t.amount : -t.amount)));
}

export function monthMode(ym, today = todayISO()) {
  const cur = ymOf(today);
  return ym < cur ? 'past' : ym > cur ? 'future' : 'current';
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
  // Saldo projetado ao fim do mês selecionado (para meses atual/futuros).
  let projectedEnd = balance;
  if (mode !== 'past') {
    for (let m = ymOf(state.today); m <= ym; m = addMonths(m, 1)) {
      const p = transactionsForMonth(state, m).filter((t) => isPlanned(t, state.today));
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

  // Distribuição por categoria: passado/atual = o que já foi gasto; futuro = previsto.
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

/** Série de entradas x saídas para o gráfico de evolução. */
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

/** Parcelamentos em andamento (agrupados por installment.groupId). */
export function installmentGroups(state) {
  const groups = new Map();
  state.transactions.filter((t) => t.installment?.groupId).forEach((t) => {
    const g = groups.get(t.installment.groupId) || { id: t.installment.groupId, description: t.description, category: t.category, amount: t.amount, total: t.installment.total, paid: 0, last: t.date };
    if (t.date <= state.today) g.paid += 1;
    if (t.date > g.last) g.last = t.date;
    groups.set(g.id, g);
  });
  return [...groups.values()].filter((g) => g.paid < g.total).map((g) => ({ ...g, remaining: round2((g.total - g.paid) * g.amount) }));
}

export { currentYM };
