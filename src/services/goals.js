// =============================================================================
// METAS — calculadora financeira (matemática exata, sem IA).
// Juros compostos mensais: taxa mensal = (1 + taxa anual)^(1/12) − 1
// =============================================================================
import { round2, sum, addMonths, ymOf, dayOf, monthLabel, fmt } from '../utils.js';
import { transactionsForMonth, isPlanned } from './finance.js';
import { getCategory } from '../categories.js';

export const monthlyRate = (annualPct) => (annualPct > 0 ? Math.pow(1 + annualPct / 100, 1 / 12) - 1 : 0);

/** Quanto guardar por mês para ir de `pv` até `target` em `n` meses. */
export function requiredMonthly(target, pv, i, n) {
  if (n <= 0) return null;
  const g = Math.pow(1 + i, n);
  if (pv * g >= target) return 0;
  return round2(i > 0 ? ((target - pv * g) * i) / (g - 1) : (target - pv) / n);
}

/** Em quantos meses chega guardando `pmt` por mês. Infinity se nunca chega (limite 100 anos). */
export function monthsToReach(target, pv, pmt, i) {
  if (pv >= target) return 0;
  if (pmt <= 0 && i <= 0) return Infinity;
  let bal = pv;
  for (let m = 1; m <= 1200; m++) {
    bal = bal * (1 + i) + pmt;
    if (bal >= target - 0.005) return m;
  }
  return Infinity;
}

export function futureValue(pv, pmt, i, n) {
  const g = Math.pow(1 + i, n);
  return round2(pv * g + (i > 0 ? (pmt * (g - 1)) / i : pmt * n));
}

/** Meses inteiros entre hoje e a data (arredonda para baixo; mínimo 0). */
export function monthsUntil(todayISO, targetISO) {
  const [y1, m1] = todayISO.split('-').map(Number);
  const [y2, m2] = targetISO.split('-').map(Number);
  let n = (y2 - y1) * 12 + (m2 - m1);
  if (dayOf(targetISO) < dayOf(todayISO)) n -= 1;
  return Math.max(0, n);
}

/** Sobra média (entradas − saídas efetivadas) dos últimos meses fechados. */
export function averageSurplus(state, months = 3) {
  const cur = ymOf(state.today);
  const list = [];
  for (let k = 1; k <= months; k++) {
    const ym = addMonths(cur, -k);
    const done = transactionsForMonth(state, ym).filter((t) => !isPlanned(t, state.today));
    if (!done.length) continue;
    const inc = sum(done.filter((t) => t.type === 'income'), (t) => t.amount);
    const exp = sum(done.filter((t) => t.type === 'expense'), (t) => t.amount);
    list.push({ ym, income: inc, expense: exp, surplus: round2(inc - exp) });
  }
  const avg = list.length ? round2(sum(list, (x) => x.surplus) / list.length) : 0;
  return { avg, months: list, hasHistory: list.length > 0 };
}

/** Maiores gastos variáveis (sem recorrências/parcelas) na média dos últimos meses. */
function variableSpending(state, months = 3) {
  const cur = ymOf(state.today);
  const totals = new Map();
  let counted = 0;
  for (let k = 1; k <= months; k++) {
    const ym = addMonths(cur, -k);
    const items = transactionsForMonth(state, ym).filter((t) => t.type === 'expense' && !isPlanned(t, state.today) && !t.recurringId && !t.installment);
    if (!items.length) continue;
    counted += 1;
    items.forEach((t) => totals.set(t.category, (totals.get(t.category) || 0) + t.amount));
  }
  if (!counted) return [];
  return [...totals.entries()].map(([key, v]) => ({ key, monthly: round2(v / counted) })).sort((a, b) => b.monthly - a.monthly);
}

/**
 * Análise completa de uma meta.
 * goal: { name, targetAmount, savedAmount, targetDate?, monthlyContribution?, annualRate }
 */
export function analyzeGoal(goal, state, { otherGoals = [] } = {}) {
  const target = Number(goal.targetAmount) || 0;
  const saved = Number(goal.savedAmount) || 0;
  const i = monthlyRate(Number(goal.annualRate) || 0);
  const remaining = round2(Math.max(0, target - saved));
  const progress = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
  const surplus = averageSurplus(state);
  const cur = ymOf(state.today);

  // Aporte usado na projeção: o que a pessoa definiu, senão a sobra média real.
  // Com várias metas, a sobra é dividida: primeiro saem os aportes definidos
  // manualmente nas outras metas; o resto é repartido igualmente entre as automáticas.
  const hasManual = (g) => g.monthlyContribution != null && g.monthlyContribution !== '';
  const others = otherGoals.filter((g) => g.id !== goal.id && Number(g.savedAmount) < Number(g.targetAmount));
  const manualOthers = sum(others.filter(hasManual), (g) => Number(g.monthlyContribution));
  const autoCount = 1 + others.filter((g) => !hasManual(g)).length;
  const share = round2(Math.max(0, surplus.avg - manualOthers) / autoCount);
  const contribution = hasManual(goal) ? Number(goal.monthlyContribution) : share;
  const contributionSource = goal.monthlyContribution != null && goal.monthlyContribution !== '' ? 'manual' : 'surplus';

  const months = monthsToReach(target, saved, contribution, i);
  const eta = Number.isFinite(months) ? addMonths(cur, months) : null;
  const interest = Number.isFinite(months) && months > 0 ? round2(futureValue(saved, contribution, i, months) - saved - contribution * months) : 0;

  let deadline = null;
  if (goal.targetDate) {
    const n = monthsUntil(state.today, goal.targetDate);
    const needed = requiredMonthly(target, saved, i, n);
    const capacity = hasManual(goal) ? Math.max(0, surplus.avg - manualOthers) : share;
    let status;
    if (remaining === 0) status = 'done';
    else if (n === 0 || needed === null) status = 'expired';
    else if (needed <= capacity) status = 'ok';
    else if (needed <= capacity * 1.3) status = 'tight';
    else status = 'hard';
    deadline = { months: n, needed, status, capacity, pctOfSurplus: capacity > 0 && needed != null ? round2((needed / capacity) * 100) : null };
  }

  // Sugestões objetivas (regras, sem IA)
  const tips = [];
  const gap = deadline && deadline.needed != null ? round2(deadline.needed - deadline.capacity) : 0;
  if (remaining > 0) {
    if (!surplus.hasHistory) tips.push('Registre alguns meses de entradas e saídas para o app calcular sua sobra real.');
    if (surplus.hasHistory && surplus.avg <= 0) tips.push('Nos últimos meses você gastou mais do que recebeu. O primeiro passo é voltar a ter sobra mensal.');
    if (deadline && (deadline.status === 'hard' || deadline.status === 'tight') && gap > 0) {
      const top = variableSpending(state).slice(0, 2);
      top.forEach((c) => {
        const cut = round2(Math.min(gap, c.monthly * 0.25));
        if (cut >= 10) tips.push(`Reduzir ${Math.round((cut / c.monthly) * 100)}% em ${getCategory(c.key).label} (média de ${fmt(c.monthly)}/mês) libera ${fmt(cut)} por mês.`);
      });
      if (Number.isFinite(months) && eta) tips.push(`Mantendo o ritmo atual, a meta fica pronta em ${monthLabel(eta).toLowerCase()} — dá para ajustar o prazo para essa data.`);
      tips.push(`Uma renda extra de ${fmt(gap)}/mês fecharia a diferença.`);
    }
    if ((Number(goal.annualRate) || 0) === 0 && remaining > 1000) tips.push('Guardar numa aplicação que rende (ex.: CDB com liquidez diária) faz o dinheiro trabalhar a seu favor; informe o rendimento anual para o cálculo considerar os juros.');
  }

  return { target, saved, remaining, progress, i, contribution, contributionSource, sharedWith: hasManual(goal) ? 0 : autoCount - 1, months, eta, interest, deadline, surplus, tips };
}
