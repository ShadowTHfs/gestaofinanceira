// =============================================================================
// APP — estado, renderização e eventos da interface.
// Depende apenas da camada de repositório (persistência) e dos serviços.
// =============================================================================
import * as repo from './services/supabaseClient.js';
import * as openFinance from './services/openFinanceService.js';
import { buildSeed } from './data/seed.js';
import { CATEGORIES, getCategory, categoriesByType } from './categories.js';
import { transactionsForMonth, monthSummary, evolutionSeries, installmentGroups, isPlanned } from './services/finance.js';
import { renderDoughnut, renderEvolution, getDoughnut, setChartDefaults } from './ui/charts.js';
import { icon, hydrateIcons } from './ui/icons.js';
import {
  fmt, todayISO, currentYM, addMonths, monthLabel, dateLabel, shortDate, ymOf, dayOf, dateWithDay,
  uid, escapeHTML, parseMoney, sum,
} from './utils.js';

// ------------------------------------------------------------------ estado
const state = {
  today: todayISO(),
  selectedYM: currentYM(),
  transactions: [],
  recurring: [],
  connections: [],
  settings: { ...repo.DEFAULT_SETTINGS },
  filters: { type: 'all', search: '', category: 'all', source: 'all' },
  busy: new Set(),
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ------------------------------------------------------------------ boot
async function boot() {
  hydrateIcons();
  setChartDefaults();
  bindEvents();
  try {
    await repo.initRepository();
    await repo.seedIfEmpty(buildSeed);
    await loadAll();
  } catch (err) {
    console.error(err);
    toast('Não foi possível carregar os dados.', 'error');
  }
  renderAll();
}

async function loadAll() {
  const [transactions, recurring, settings, connections] = await Promise.all([
    repo.fetchTransactions(), repo.fetchRecurring(), repo.fetchSettings(), repo.fetchConnections(),
  ]);
  Object.assign(state, { transactions, recurring, settings, connections });
}

// ------------------------------------------------------------------ render geral
function renderAll() {
  renderGreeting();
  renderStorageBadge();
  renderMonthNav();
  const summary = monthSummary(state, state.selectedYM);
  renderKPIs(summary);
  renderPie(summary);
  renderBars();
  renderCategoryFilter();
  renderTransactions();
  renderRecurring();
  renderOpenFinance();
}

function renderGreeting() {
  const h = new Date().getHours();
  $('#greeting').textContent = `${h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'} 👋 · ${dateLabel(state.today)}`;
}

function renderStorageBadge() {
  const s = repo.getRepositoryStatus();
  const remote = s.backend === 'supabase';
  const html = `<span class="badge ${remote ? 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/30 dark:text-emerald-300' : 'bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300'}" title="${escapeHTML(s.reason)}">
      ${icon(remote ? 'database' : 'hard-drive', 'h-3 w-3')}${remote ? 'Supabase' : 'Salvo neste navegador'}</span>`;
  $('#storage-badge').innerHTML = html;
  $('#footer-storage').textContent = s.reason;
}

// ------------------------------------------------------------------ navegação temporal
const MODE_INFO = {
  past: { label: 'Histórico', cls: 'text-slate-500 dark:text-slate-400' },
  current: { label: 'Mês atual', cls: 'text-indigo-600 dark:text-indigo-400' },
  future: { label: 'Projeção', cls: 'text-violet-600 dark:text-violet-400' },
};

function renderMonthNav() {
  const ym = state.selectedYM;
  const cur = currentYM();
  const mode = ym < cur ? 'past' : ym > cur ? 'future' : 'current';
  $('#month-label').textContent = monthLabel(ym);
  $('#month-mode').textContent = MODE_INFO[mode].label;
  $('#month-mode').className = `text-[11px] font-medium ${MODE_INFO[mode].cls}`;
  $('#month-today').classList.toggle('invisible', ym === cur);

  // Faixa de meses: 6 anteriores, atual e 6 futuros.
  const strip = [];
  for (let i = -6; i <= 6; i++) {
    const m = addMonths(cur, i);
    const active = m === ym;
    strip.push(`<button type="button" data-ym="${m}" class="chip shrink-0 ${active ? 'chip-active' : ''} ${i > 0 ? 'border-dashed !border-slate-300/60 dark:!border-slate-700/60' : ''}">
      ${i === 0 ? '<i class="h-1.5 w-1.5 rounded-full bg-indigo-500"></i>' : ''}${monthLabel(m, { short: true })}</button>`);
  }
  const el = $('#month-strip');
  el.innerHTML = strip.join('');
  el.querySelector('.chip-active')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });

  const banner = $('#mode-banner');
  if (mode === 'current') { banner.innerHTML = ''; return; }
  const future = mode === 'future';
  banner.innerHTML = `<div class="animate-fade-up flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm ${future
    ? 'border-violet-500/20 bg-violet-500/10 text-violet-800 dark:text-violet-200'
    : 'border-slate-300/60 bg-slate-500/5 text-slate-700 dark:border-slate-700/60 dark:text-slate-300'}">
      ${icon(future ? 'sparkles' : 'clock', 'h-4 w-4 shrink-0')}
      <span>${future
        ? 'Você está vendo uma <strong>projeção</strong>: contas fixas, assinaturas e parcelas já previstas para este mês.'
        : 'Você está vendo o <strong>histórico</strong> consolidado deste mês.'}</span></div>`;
}

function goToMonth(ym) {
  if (ym === state.selectedYM) return;
  state.selectedYM = ym;
  state.filters.category = 'all';
  renderAll();
}

// ------------------------------------------------------------------ KPIs
function kpiCard({ title, value, valueCls = '', iconName, iconCls, sub, extra = '', delay = 0 }) {
  return `<article class="glass-card glass-hover animate-fade-up relative overflow-hidden p-5" style="animation-delay:${delay}ms">
    <div class="flex items-start justify-between gap-3">
      <p class="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">${title}</p>
      <div class="grid h-9 w-9 place-items-center rounded-xl ${iconCls}">${icon(iconName, 'h-[18px] w-[18px]')}</div>
    </div>
    <p class="mt-2 text-2xl font-bold tabular-nums tracking-tight ${valueCls}">${value}</p>
    <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${sub}</p>
    ${extra}
  </article>`;
}

function renderKPIs(s) {
  const mode = s.mode;
  const bar = (pct, over) => `<div class="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-800">
      <div class="h-full rounded-full transition-all duration-700 ${over ? 'bg-gradient-to-r from-rose-400 to-rose-600' : pct > 80 ? 'bg-gradient-to-r from-amber-400 to-orange-500' : 'bg-gradient-to-r from-indigo-500 to-violet-500'}" style="width:${Math.max(2, pct).toFixed(1)}%"></div></div>`;

  const balanceSub = mode === 'past'
    ? 'Saldo real de hoje'
    : `Fim de ${monthLabel(s.ym, { withYear: false }).toLowerCase()}: <span class="font-semibold ${s.projectedEnd >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-300'}">${fmt(s.projectedEnd)}</span> (projetado)`;

  const spentValue = mode === 'future' ? s.plannedExpense : s.spent;
  const spentSub = mode === 'future'
    ? 'Compromissos já previstos'
    : mode === 'current' && s.plannedExpense > 0
      ? `+ ${fmt(s.plannedExpense)} ainda previstos`
      : `de ${fmt(s.budget)} de orçamento`;

  const over = s.available < 0;
  const availSub = s.budget <= 0
    ? 'Defina um orçamento em ⚙️ Configurações'
    : mode === 'past'
      ? (over ? 'Orçamento estourado neste mês' : 'Sobrou do orçamento')
      : mode === 'current'
        ? `Já descontando o que está previsto`
        : `Orçamento − previstos`;

  const dailyText = s.dailyText.replace('{v}', `<strong class="text-slate-700 dark:text-slate-200">${fmt(s.daily)}</strong>`);
  const dailyIsAlert = mode === 'current' && s.available <= 0;

  $('#kpis').innerHTML = [
    kpiCard({
      title: 'Saldo atual', value: fmt(s.balance), iconName: 'wallet',
      valueCls: s.balance < 0 ? 'text-rose-500 dark:text-rose-300' : '',
      iconCls: 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/30',
      sub: balanceSub, delay: 0,
    }),
    kpiCard({
      title: mode === 'future' ? 'Gastos previstos' : 'Gastos do mês', value: fmt(spentValue), iconName: 'arrow-down-right',
      valueCls: 'text-rose-500 dark:text-rose-300', iconCls: 'bg-rose-500/10 text-rose-500 dark:text-rose-300',
      sub: spentSub, delay: 60,
    }),
    kpiCard({
      title: 'Disponível para gastar', value: fmt(s.available), iconName: 'piggy-bank',
      valueCls: over ? 'text-rose-500 dark:text-rose-300' : 'text-emerald-600 dark:text-emerald-400',
      iconCls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      sub: availSub, extra: s.budget > 0 ? bar(s.budgetUsedPct, over) : '', delay: 120,
    }),
    kpiCard({
      title: mode === 'past' ? 'Média diária' : 'Teto diário', value: mode === 'current' && dailyIsAlert ? fmt(0) : fmt(s.daily), iconName: 'gauge',
      valueCls: dailyIsAlert ? 'text-rose-500 dark:text-rose-300' : '',
      iconCls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
      sub: mode === 'current' && !dailyIsAlert
        ? `${dailyText} <span class="block mt-0.5 text-[11px] opacity-80">${s.daysLeft} ${s.daysLeft === 1 ? 'dia restante' : 'dias restantes'}, contando hoje</span>`
        : dailyText,
      delay: 180,
    }),
  ].join('');
}

// ------------------------------------------------------------------ gráfico de rosca + legenda
function renderPie(s) {
  const items = s.categories.map((c) => ({ ...c, label: getCategory(c.key).label, color: getCategory(c.key).color }));
  const total = sum(items, (i) => i.value);
  $('#pie-sub').textContent = s.mode === 'future'
    ? `Previsto para ${monthLabel(s.ym).toLowerCase()}`
    : `${s.mode === 'current' ? 'Gasto até hoje em' : 'Total gasto em'} ${monthLabel(s.ym).toLowerCase()}`;

  const empty = items.length === 0;
  $('#pie-wrap').classList.toggle('hidden', empty);
  $('#pie-empty').classList.toggle('hidden', !empty);
  if (empty) {
    getDoughnut()?.destroy();
    $('#pie-empty').innerHTML = emptyState({
      iconName: 'chart-pie',
      title: 'Nada para mostrar ainda',
      text: s.mode === 'future' ? 'Não há gastos previstos para este mês.' : 'Quando você registrar saídas, a distribuição por categoria aparece aqui.',
      cta: s.mode !== 'future',
    });
    return;
  }

  const hidden = new Set();
  const updateCenter = () => {
    const vis = sum(items.filter((_, i) => !hidden.has(i)), (i) => i.value);
    $('#pie-center-value').textContent = fmt(vis);
    $('#pie-center-label').textContent = hidden.size ? 'Selecionado' : 'Total';
  };

  $('#pie-legend').innerHTML = items.map((it, i) => {
    const cat = getCategory(it.key);
    const pct = total ? (it.value / total) * 100 : 0;
    return `<li>
      <button type="button" data-index="${i}" class="legend-item group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-all duration-300 hover:bg-slate-100/80 dark:hover:bg-slate-800/60">
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset ${cat.badge}">${icon(cat.icon, 'h-4 w-4')}</span>
        <span class="min-w-0 flex-1">
          <span class="flex items-baseline justify-between gap-2">
            <span class="truncate text-sm font-medium">${cat.label}</span>
            <span class="text-sm font-semibold tabular-nums">${fmt(it.value)}</span>
          </span>
          <span class="mt-1.5 flex items-center gap-2">
            <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-800"><span class="block h-full rounded-full transition-all duration-700" style="width:${pct.toFixed(1)}%;background:${it.color}"></span></span>
            <span class="w-11 text-right text-[11px] tabular-nums text-slate-500 dark:text-slate-400">${pct.toFixed(1).replace('.', ',')}%</span>
          </span>
        </span>
      </button></li>`;
  }).join('');

  const highlight = (idx) => {
    $$('#pie-legend .legend-item').forEach((el, i) => {
      el.classList.toggle('bg-slate-100/80', i === idx);
      el.classList.toggle('dark:bg-slate-800/60', i === idx);
    });
  };

  const chart = renderDoughnut($('#pie-canvas'), items, {
    onHoverIndex: highlight,
    onSliceClick: (i) => setCategoryFilter(items[i].key),
  });
  updateCenter();

  $$('#pie-legend .legend-item').forEach((btn) => {
    const i = Number(btn.dataset.index);
    btn.addEventListener('mouseenter', () => {
      if (!chart || hidden.has(i)) return;
      chart.setActiveElements([{ datasetIndex: 0, index: i }]);
      chart.tooltip.setActiveElements([{ datasetIndex: 0, index: i }], { x: 0, y: 0 });
      chart.update();
    });
    btn.addEventListener('mouseleave', () => {
      if (!chart) return;
      chart.setActiveElements([]);
      chart.tooltip.setActiveElements([], { x: 0, y: 0 });
      chart.update();
    });
    // Clique na legenda: mostra/oculta a fatia (recalcula % e total do centro).
    btn.addEventListener('click', () => {
      if (!chart) return;
      if (hidden.has(i)) hidden.delete(i);
      else if (hidden.size < items.length - 1) hidden.add(i);
      else return;
      chart.toggleDataVisibility(i);
      chart.setActiveElements([]);
      chart.tooltip.setActiveElements([], { x: 0, y: 0 });
      chart.update();
      btn.classList.toggle('opacity-40', hidden.has(i));
      btn.setAttribute('aria-pressed', String(!hidden.has(i)));
      updateCenter();
    });
  });
}

function renderBars() {
  const series = evolutionSeries(state, state.selectedYM, 4, 1);
  renderEvolution($('#bar-canvas'), series, state.selectedYM, { onBarClick: goToMonth });
}

// ------------------------------------------------------------------ transações
function renderCategoryFilter() {
  const sel = $('#f-category');
  const opts = ['<option value="all">Todas as categorias</option>']
    .concat(Object.entries(CATEGORIES).map(([k, c]) => `<option value="${k}">${c.label}</option>`));
  sel.innerHTML = opts.join('');
  sel.value = state.filters.category;
}

function setCategoryFilter(key) {
  state.filters.category = state.filters.category === key ? 'all' : key;
  $('#f-category').value = state.filters.category;
  renderTransactions();
  if (state.filters.category !== 'all') $('#tx-list').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function filteredTransactions() {
  const f = state.filters;
  const q = f.search.trim().toLowerCase();
  return transactionsForMonth(state, state.selectedYM).filter((t) => {
    const planned = isPlanned(t, state.today);
    if (f.type === 'income' && t.type !== 'income') return false;
    if (f.type === 'expense' && t.type !== 'expense') return false;
    if (f.type === 'planned' && !planned) return false;
    if (f.category !== 'all' && t.category !== f.category) return false;
    if (f.source !== 'all' && (t.source || 'manual') !== f.source) return false;
    if (q && !t.description.toLowerCase().includes(q)) return false;
    return true;
  });
}

function txRow(t) {
  const cat = getCategory(t.category);
  const planned = isPlanned(t, state.today);
  const income = t.type === 'income';
  const tags = [];
  if (planned) tags.push(`<span class="badge border border-dashed border-violet-400/50 bg-violet-500/5 text-violet-600 ring-transparent dark:text-violet-300">${icon('clock', 'h-3 w-3')}Previsto</span>`);
  if (t.installment) tags.push(`<span class="badge bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300">${icon('credit-card', 'h-3 w-3')}${t.installment.current}/${t.installment.total}</span>`);
  if (t.recurringId && !t.installment) tags.push(`<span class="badge bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300">${icon('repeat', 'h-3 w-3')}Recorrente</span>`);
  if (t.source === 'open_finance') {
    const conn = state.connections.find((c) => c.id === t.accountId);
    const bank = conn && openFinance.getBank(conn.bankId);
    tags.push(`<span class="badge bg-indigo-500/10 text-indigo-600 ring-indigo-500/20 dark:text-indigo-300">${icon('landmark', 'h-3 w-3')}${bank ? bank.name : 'Open Finance'}</span>`);
  }

  return `<li class="group flex items-center gap-3 rounded-xl px-2.5 py-2.5 transition-all duration-300 hover:bg-slate-100/70 dark:hover:bg-slate-800/40 ${planned ? 'opacity-80' : ''}">
    <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset ${cat.badge}">${icon(cat.icon, 'h-[18px] w-[18px]')}</div>
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium">${escapeHTML(t.description)}</p>
      <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        <span class="badge ring-inset ${cat.badge}">${cat.label}</span>${tags.join('')}
      </div>
    </div>
    <div class="text-right">
      <p class="text-sm font-semibold tabular-nums ${income ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-300'}">${income ? '+' : '−'} ${fmt(t.amount)}</p>
      <p class="text-[11px] text-slate-400">${shortDate(t.date)}</p>
    </div>
    ${t.projected
      ? '<span class="w-8"></span>'
      : `<button type="button" class="btn-icon h-8 w-8 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100" data-delete="${t.id}" aria-label="Excluir ${escapeHTML(t.description)}" title="Excluir">${icon('trash-2', 'h-4 w-4')}</button>`}
  </li>`;
}

function renderTransactions() {
  const list = filteredTransactions();
  const f = state.filters;
  $$('#f-type .chip').forEach((b) => b.classList.toggle('chip-active', b.dataset.type === f.type));

  const inc = sum(list.filter((t) => t.type === 'income'), (t) => t.amount);
  const exp = sum(list.filter((t) => t.type === 'expense'), (t) => t.amount);
  $('#tx-sub').innerHTML = list.length
    ? `${list.length} ${list.length === 1 ? 'lançamento' : 'lançamentos'} · <span class="text-emerald-600 dark:text-emerald-400">+${fmt(inc)}</span> · <span class="text-rose-500 dark:text-rose-300">−${fmt(exp)}</span>`
    : monthLabel(state.selectedYM);

  $('#tx-active-filter').innerHTML = f.category !== 'all'
    ? `<button type="button" id="clear-cat" class="badge gap-1.5 px-2 py-1 ring-inset ${getCategory(f.category).badge}">Filtrando: ${getCategory(f.category).label} ${icon('x', 'h-3 w-3')}</button>`
    : '';
  $('#clear-cat')?.addEventListener('click', () => setCategoryFilter(f.category));

  const box = $('#tx-list');
  if (!list.length) {
    const hasAny = state.transactions.length > 0 || state.recurring.length > 0;
    const filtersOn = f.type !== 'all' || f.category !== 'all' || f.source !== 'all' || f.search;
    box.innerHTML = filtersOn && hasAny
      ? emptyState({ iconName: 'search', title: 'Nenhum resultado', text: 'Nenhuma transação corresponde aos filtros. Tente limpar a busca ou trocar o filtro.', clear: true })
      : emptyState({
        iconName: 'inbox',
        title: hasAny ? 'Mês sem lançamentos' : 'Comece registrando sua primeira transação',
        text: hasAny ? 'Não há transações neste mês. Que tal registrar uma agora?' : 'Adicione entradas e saídas para ver seu saldo, seus gastos por categoria e quanto pode gastar por dia.',
        cta: true,
      });
    return;
  }

  const groups = new Map();
  list.forEach((t) => { if (!groups.has(t.date)) groups.set(t.date, []); groups.get(t.date).push(t); });
  box.innerHTML = [...groups.entries()].map(([date, items]) => {
    const net = sum(items, (t) => (t.type === 'income' ? t.amount : -t.amount));
    return `<section class="mb-2">
      <div class="sticky top-0 z-10 flex items-center justify-between bg-white/80 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 backdrop-blur dark:bg-slate-900/80 dark:text-slate-400">
        <span>${dateLabel(date, state.today)}</span><span class="tabular-nums normal-case">${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}</span>
      </div>
      <ul>${items.map(txRow).join('')}</ul></section>`;
  }).join('');
}

function emptyState({ iconName, title, text, cta = false, clear = false }) {
  return `<div class="animate-fade-up flex flex-col items-center justify-center px-6 py-12 text-center">
    <div class="relative mb-4">
      <div class="absolute inset-0 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 opacity-30 blur-xl"></div>
      <div class="relative grid h-14 w-14 place-items-center rounded-2xl border border-slate-200/80 bg-white text-indigo-500 shadow-sm dark:border-slate-700/80 dark:bg-slate-900 dark:text-indigo-400">${icon(iconName, 'h-6 w-6')}</div>
    </div>
    <p class="text-sm font-semibold">${title}</p>
    <p class="mt-1 max-w-sm text-xs leading-relaxed text-slate-500 dark:text-slate-400">${text}</p>
    ${cta ? `<button type="button" class="btn-primary mt-5" data-open-new>${icon('plus')}Adicionar transação</button>` : ''}
    ${clear ? `<button type="button" class="btn-ghost mt-5" data-clear-filters>${icon('rotate-ccw')}Limpar filtros</button>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ recorrências
const KIND_LABEL = { fixed: 'Conta fixa', subscription: 'Assinatura' };

function renderRecurring() {
  const rules = [...state.recurring].filter((r) => r.active !== false).sort((a, b) => a.day - b.day);
  const inst = installmentGroups(state);
  const box = $('#recurring-list');
  if (!rules.length && !inst.length) {
    box.innerHTML = `<p class="rounded-xl border border-dashed border-slate-300/70 px-4 py-6 text-center text-xs text-slate-500 dark:border-slate-700/70 dark:text-slate-400">Nenhum compromisso recorrente.<br/>Ao criar uma transação, escolha “Conta fixa”, “Assinatura” ou “Parcelado”.</p>`;
    return;
  }
  const monthlyOut = sum(rules.filter((r) => r.type === 'expense'), (r) => r.amount);
  const ruleRows = rules.map((r) => {
    const cat = getCategory(r.category);
    const income = r.type === 'income';
    return `<li class="group flex items-center gap-3 rounded-xl px-2 py-2 transition-all duration-300 hover:bg-slate-100/70 dark:hover:bg-slate-800/40">
      <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset ${cat.badge}">${icon(cat.icon, 'h-4 w-4')}</span>
      <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">${escapeHTML(r.description)}</span>
        <span class="text-[11px] text-slate-500 dark:text-slate-400">${KIND_LABEL[r.kind] || 'Recorrente'} · todo dia ${r.day}</span></span>
      <span class="text-sm font-semibold tabular-nums ${income ? 'text-emerald-600 dark:text-emerald-400' : ''}">${income ? '+' : ''}${fmt(r.amount)}</span>
      <button type="button" class="btn-icon h-7 w-7 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100" data-delete-rule="${r.id}" title="Encerrar recorrência" aria-label="Encerrar ${escapeHTML(r.description)}">${icon('x', 'h-3.5 w-3.5')}</button>
    </li>`;
  }).join('');

  const instRows = inst.map((g) => {
    const cat = getCategory(g.category);
    const pct = (g.paid / g.total) * 100;
    return `<li class="rounded-xl px-2 py-2">
      <div class="flex items-center gap-3">
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset ${cat.badge}">${icon('credit-card', 'h-4 w-4')}</span>
        <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">${escapeHTML(g.description)}</span>
          <span class="text-[11px] text-slate-500 dark:text-slate-400">${g.paid}/${g.total} pagas · faltam ${fmt(g.remaining)}</span></span>
        <span class="text-sm font-semibold tabular-nums">${fmt(g.amount)}</span>
      </div>
      <div class="ml-11 mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-800"><div class="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" style="width:${pct}%"></div></div>
    </li>`;
  }).join('');

  box.innerHTML = `
    ${rules.length ? `<p class="mb-1 flex justify-between px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"><span>Mensais</span><span class="tabular-nums normal-case">${fmt(monthlyOut)}/mês em saídas</span></p><ul>${ruleRows}</ul>` : ''}
    ${inst.length ? `<p class="mb-1 mt-3 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Parcelamentos</p><ul>${instRows}</ul>` : ''}`;
}

// ------------------------------------------------------------------ Open Finance
function renderOpenFinance() {
  $('#of-list').innerHTML = openFinance.SUPPORTED_BANKS.map((b) => {
    const conn = state.connections.find((c) => c.bankId === b.id && c.status === 'connected');
    const busy = state.busy.has(b.id);
    const imported = conn ? state.transactions.filter((t) => t.accountId === conn.id).length : 0;
    return `<div class="flex items-center gap-3 rounded-xl border border-slate-200/80 bg-white/50 p-3 transition-all duration-300 hover:border-slate-300 dark:border-slate-800/80 dark:bg-slate-950/30 dark:hover:border-slate-700">
      <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${b.tint} text-sm font-bold text-white shadow-md">${b.initials}</div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">${b.name}</p>
        <p class="truncate text-[11px] ${conn ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}">
          ${conn ? `● Conectado ${conn.accountMask} · ${imported} importadas` : 'Não conectado'}</p>
      </div>
      ${conn
        ? `<div class="flex gap-1">
            <button type="button" class="btn-icon h-8 w-8" data-of-sync="${b.id}" title="Sincronizar extrato" aria-label="Sincronizar ${b.name}" ${busy ? 'disabled' : ''}>${icon(busy ? 'loader-circle' : 'refresh-cw', `h-4 w-4 ${busy ? 'animate-spin' : ''}`)}</button>
            <button type="button" class="btn-icon h-8 w-8" data-of-disconnect="${b.id}" title="Desconectar" aria-label="Desconectar ${b.name}">${icon('unplug', 'h-4 w-4')}</button>
          </div>`
        : `<button type="button" class="btn-ghost px-3 py-1.5 text-xs" data-of-connect="${b.id}">${icon('link', 'h-3.5 w-3.5')}Conectar</button>`}
    </div>`;
  }).join('');
}

function openConsent(bankId) {
  const bank = openFinance.getBank(bankId);
  const modal = $('#of-modal');
  const body = $('#of-modal-body');
  body.innerHTML = `
    <div class="px-6 pb-2 pt-6 text-center">
      <div class="mx-auto mb-4 flex items-center justify-center gap-3">
        <div class="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg">${icon('wallet', 'h-5 w-5')}</div>
        <span class="text-slate-400">${icon('link', 'h-4 w-4')}</span>
        <div class="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br ${bank.tint} font-bold text-white shadow-lg">${bank.initials}</div>
      </div>
      <h3 id="of-title" class="text-base font-semibold">Conectar ${bank.name}</h3>
      <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Você será redirecionado ao ${bank.name} para autorizar o compartilhamento.</p>
      <span class="badge mt-3 bg-amber-500/10 text-amber-600 ring-amber-500/30 dark:text-amber-300">${icon('triangle-alert', 'h-3 w-3')}Simulação — nenhum dado real será acessado</span>
    </div>
    <div class="px-6 py-4">
      <p class="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">Dados que seriam compartilhados:</p>
      <ul class="space-y-2 text-sm">
        ${['Dados cadastrais', 'Saldos das contas', 'Extratos e transações (últimos 12 meses)'].map((x) => `<li class="flex items-center gap-2">${icon('circle-check', 'h-4 w-4 text-emerald-500')}${x}</li>`).join('')}
      </ul>
      <p class="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">${icon('lock', 'h-3 w-3')}Consentimento válido por 12 meses, revogável a qualquer momento.</p>
    </div>
    <div id="of-progress" class="hidden px-6 pb-2"></div>
    <footer class="flex justify-end gap-2 border-t border-slate-200/80 px-6 py-4 dark:border-slate-800/80">
      <button type="button" class="btn-ghost" data-close>Cancelar</button>
      <button type="button" class="btn-primary" id="of-authorize">${icon('shield-check')}Autorizar (simulação)</button>
    </footer>`;
  modal.showModal();

  $('#of-authorize').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = `${icon('loader-circle', 'h-4 w-4 animate-spin')}Conectando…`;
    const prog = $('#of-progress');
    prog.classList.remove('hidden');
    const step = (txt, done) => `<p class="flex items-center gap-2 py-1 text-xs ${done ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}">${icon(done ? 'circle-check' : 'loader-circle', `h-3.5 w-3.5 ${done ? '' : 'animate-spin'}`)}${txt}</p>`;
    try {
      prog.innerHTML = step('Validando consentimento…');
      const conn = await openFinance.connectBank(bankId);
      await repo.saveConnection(conn);
      state.connections = [...state.connections.filter((c) => c.bankId !== bankId), conn];
      prog.innerHTML = step('Consentimento autorizado', true) + step('Importando extrato…');
      const imported = await syncConnection(conn, { silent: true });
      prog.innerHTML = step('Consentimento autorizado', true) + step(`${imported} transações importadas`, true);
      setTimeout(() => modal.close(), 700);
      toast(`${bank.name} conectado (simulação) · ${imported} transações importadas`, 'success');
    } catch (err) {
      console.error(err);
      toast('Falha na conexão simulada.', 'error');
      modal.close();
    }
    renderAll();
  });
}

async function syncConnection(conn, { silent = false } = {}) {
  state.busy.add(conn.bankId);
  renderOpenFinance();
  try {
    const incoming = await openFinance.fetchExternalStatement(conn);
    const known = new Set(state.transactions.map((t) => t.externalId).filter(Boolean));
    const fresh = incoming.filter((t) => !known.has(t.externalId));
    if (fresh.length) {
      const saved = await repo.saveTransactions(fresh);
      state.transactions.push(...saved);
    }
    const updated = { ...conn, lastSyncAt: new Date().toISOString() };
    await repo.saveConnection(updated);
    state.connections = state.connections.map((c) => (c.id === conn.id ? updated : c));
    if (!silent) toast(fresh.length ? `${fresh.length} novas transações importadas` : 'Extrato já está em dia', fresh.length ? 'success' : 'info');
    return fresh.length;
  } finally {
    state.busy.delete(conn.bankId);
  }
}

// ------------------------------------------------------------------ modal de transação
let txKind = 'expense';

function setTxKind(kind) {
  txKind = kind;
  $$('#tx-modal .segmented button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
  const sel = $('#tx-category');
  sel.innerHTML = categoriesByType(kind).map((c) => `<option value="${c.key}">${c.label}</option>`).join('');
  $('#tx-repeat').querySelector('[value="installments"]').disabled = kind === 'income';
  if (kind === 'income' && $('#tx-repeat').value === 'installments') $('#tx-repeat').value = 'none';
  updateRepeatUI();
}

function updateRepeatUI() {
  const rep = $('#tx-repeat').value;
  $('#tx-installments-wrap').classList.toggle('hidden', rep !== 'installments');
  $('#tx-amount-label').textContent = rep === 'installments' ? 'Valor de cada parcela' : 'Valor';
  const hint = $('#tx-repeat-hint');
  const date = $('#tx-date').value;
  const day = date ? dayOf(date) : null;
  const n = Number($('#tx-installments').value) || 0;
  const amount = parseMoney($('#tx-amount').value);
  let text = '';
  if (rep === 'fixed' || rep === 'subscription') text = `Vai se repetir todo dia ${day ?? '—'} e aparecer como previsto nos meses seguintes.`;
  if (rep === 'installments') text = `${n || '—'}x de ${Number.isFinite(amount) ? fmt(amount) : 'R$ —'}${Number.isFinite(amount) && n ? ` = ${fmt(amount * n)}` : ''}, uma por mês a partir desta data.`;
  hint.textContent = text;
  hint.classList.toggle('hidden', !text);
}

function openTxModal() {
  $('#tx-form').reset();
  $$('#tx-form [data-err]').forEach((e) => e.classList.add('hidden'));
  $$('#tx-form .input-error').forEach((e) => e.classList.remove('input-error'));
  // Mês atual → hoje. Outros meses → mesmo dia dentro do mês selecionado.
  $('#tx-date').value = state.selectedYM === currentYM() ? state.today : dateWithDay(state.selectedYM, dayOf(state.today));
  setTxKind('expense');
  $('#tx-modal').showModal();
  setTimeout(() => $('#tx-amount').focus(), 50);
}

function fieldError(name, show) {
  $(`#tx-form [data-err="${name}"]`)?.classList.toggle('hidden', !show);
  const input = $(`#tx-form [name="${name}"]`);
  input?.classList.toggle('input-error', show);
  return show;
}

async function submitTx(e) {
  e.preventDefault();
  const amount = parseMoney($('#tx-amount').value);
  const description = $('#tx-desc').value.trim();
  const date = $('#tx-date').value;
  const category = $('#tx-category').value;
  const repeat = $('#tx-repeat').value;
  const n = Math.floor(Number($('#tx-installments').value));

  let bad = false;
  bad = fieldError('amount', !(amount > 0 && amount < 1e10)) || bad;
  bad = fieldError('description', !description) || bad;
  bad = fieldError('date', !/^\d{4}-\d{2}-\d{2}$/.test(date)) || bad;
  if (repeat === 'installments') bad = fieldError('installments', !(n >= 2 && n <= 48)) || bad;
  if (bad) return;

  const btn = $('#tx-submit');
  btn.disabled = true;
  try {
    const base = { description, amount, date, category, type: txKind, source: 'manual', recurringId: null, installment: null, externalId: null, accountId: null };
    if (repeat === 'installments') {
      const groupId = uid();
      const list = Array.from({ length: n }, (_, i) => ({
        ...base, id: uid(), date: dateWithDay(addMonths(ymOf(date), i), dayOf(date)), installment: { current: i + 1, total: n, groupId },
      }));
      state.transactions.push(...(await repo.saveTransactions(list)));
      toast(`Parcelamento criado: ${n}x de ${fmt(amount)}`, 'success');
    } else if (repeat === 'fixed' || repeat === 'subscription') {
      const rule = { id: uid(), description, amount, type: txKind, category, day: dayOf(date), kind: repeat, startMonth: ymOf(date), endMonth: null, active: true };
      await repo.saveRecurring(rule);
      state.recurring.push(rule);
      state.transactions.push(await repo.saveTransaction({ ...base, id: uid(), recurringId: rule.id }));
      toast(`${KIND_LABEL[repeat]} criada — aparecerá nos próximos meses`, 'success');
    } else {
      state.transactions.push(await repo.saveTransaction({ ...base, id: uid() }));
      toast(`${txKind === 'income' ? 'Entrada' : 'Saída'} de ${fmt(amount)} registrada`, 'success');
    }
    $('#tx-modal').close();
    if (ymOf(date) !== state.selectedYM) state.selectedYM = ymOf(date);
    renderAll();
  } catch (err) {
    console.error(err);
    toast('Não foi possível salvar. Tente novamente.', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ configurações
const moneyInput = (v) => String(v.toFixed(2)).replace('.', ',');

function openSettings() {
  $('#s-budget').value = moneyInput(state.settings.monthlyBudget);
  $('#s-opening').value = moneyInput(state.settings.openingBalance);
  $('#settings-form [data-err]').classList.add('hidden');
  $('#settings-modal').showModal();
}

async function submitSettings(e) {
  e.preventDefault();
  const budget = parseMoney($('#s-budget').value);
  const raw = $('#s-opening').value.trim();
  const neg = raw.startsWith('-');
  const opening = parseMoney(raw.replace(/^-/, ''));
  const valid = Number.isFinite(budget) && budget >= 0 && Number.isFinite(opening);
  $('#settings-form [data-err]').classList.toggle('hidden', valid);
  if (!valid) return;
  state.settings = { monthlyBudget: budget, openingBalance: neg ? -opening : opening };
  await repo.saveSettings(state.settings);
  $('#settings-modal').close();
  toast('Configurações salvas', 'success');
  renderAll();
}

async function resetData(withDemo) {
  const msg = withDemo
    ? 'Recarregar os dados de demonstração? As transações atuais deste navegador serão substituídas.'
    : 'Apagar todos os dados deste navegador e começar do zero?';
  if (!window.confirm(msg)) return;
  await repo.resetLocalData({ withDemo, buildSeed });
  await loadAll();
  state.selectedYM = currentYM();
  state.filters = { type: 'all', search: '', category: 'all', source: 'all' };
  $('#f-search').value = '';
  $('#f-source').value = 'all';
  $('#settings-modal').close();
  toast(withDemo ? 'Demonstração recarregada' : 'Tudo limpo — comece registrando uma transação', 'info');
  renderAll();
}

// ------------------------------------------------------------------ toasts
function toast(message, kind = 'info') {
  const styles = {
    success: ['circle-check', 'text-emerald-500'],
    error: ['triangle-alert', 'text-rose-500'],
    info: ['info', 'text-indigo-500'],
  }[kind];
  const el = document.createElement('div');
  el.className = 'pointer-events-auto animate-fade-up flex items-start gap-3 rounded-xl border border-slate-200/80 bg-white/90 px-4 py-3 text-sm shadow-xl backdrop-blur-xl transition-all duration-300 dark:border-slate-800/80 dark:bg-slate-900/90';
  el.innerHTML = `<span class="${styles[1]} mt-px">${icon(styles[0], 'h-4 w-4')}</span><span class="flex-1">${escapeHTML(message)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; }, 3200);
  setTimeout(() => el.remove(), 3600);
}

// ------------------------------------------------------------------ eventos
function bindEvents() {
  $('#btn-theme').addEventListener('click', () => {
    const dark = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('gf.theme', dark ? 'dark' : 'light'); } catch { /* sem storage */ }
    $('meta[name="theme-color"]').setAttribute('content', dark ? '#020617' : '#f8fafc');
    renderAll(); // redesenha os gráficos com as cores do novo tema
  });

  $('#btn-new').addEventListener('click', openTxModal);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#month-prev').addEventListener('click', () => goToMonth(addMonths(state.selectedYM, -1)));
  $('#month-next').addEventListener('click', () => goToMonth(addMonths(state.selectedYM, 1)));
  $('#month-today').addEventListener('click', () => goToMonth(currentYM()));
  $('#month-strip').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ym]');
    if (b) goToMonth(b.dataset.ym);
  });

  // Filtros
  $('#f-type').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    state.filters.type = b.dataset.type;
    renderTransactions();
  });
  let t;
  $('#f-search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.filters.search = e.target.value; renderTransactions(); }, 150);
  });
  $('#f-category').addEventListener('change', (e) => { state.filters.category = e.target.value; renderTransactions(); });
  $('#f-source').addEventListener('change', (e) => { state.filters.source = e.target.value; renderTransactions(); });

  // Ações delegadas (lista, estados vazios, recorrências, Open Finance)
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-delete],[data-delete-rule],[data-open-new],[data-clear-filters],[data-of-connect],[data-of-sync],[data-of-disconnect],[data-close]');
    if (!el) return;

    if (el.hasAttribute('data-close')) { el.closest('dialog')?.close(); return; }
    if (el.hasAttribute('data-open-new')) { openTxModal(); return; }
    if (el.hasAttribute('data-clear-filters')) {
      state.filters = { type: 'all', search: '', category: 'all', source: 'all' };
      $('#f-search').value = ''; $('#f-source').value = 'all'; $('#f-category').value = 'all';
      renderTransactions();
      return;
    }
    if (el.dataset.delete) {
      const tx = state.transactions.find((x) => x.id === el.dataset.delete);
      if (!tx || !window.confirm(`Excluir "${tx.description}" (${fmt(tx.amount)})?`)) return;
      await repo.deleteTransaction(tx.id);
      state.transactions = state.transactions.filter((x) => x.id !== tx.id);
      toast('Transação excluída', 'info');
      renderAll();
      return;
    }
    if (el.dataset.deleteRule) {
      const r = state.recurring.find((x) => x.id === el.dataset.deleteRule);
      if (!r || !window.confirm(`Encerrar "${r.description}"? Os lançamentos já registrados continuam no histórico; só as previsões futuras somem.`)) return;
      await repo.deleteRecurring(r.id);
      state.recurring = state.recurring.filter((x) => x.id !== r.id);
      toast('Recorrência encerrada', 'info');
      renderAll();
      return;
    }
    if (el.dataset.ofConnect) { openConsent(el.dataset.ofConnect); return; }
    if (el.dataset.ofSync) {
      const conn = state.connections.find((c) => c.bankId === el.dataset.ofSync && c.status === 'connected');
      if (conn) { await syncConnection(conn); renderAll(); }
      return;
    }
    if (el.dataset.ofDisconnect) {
      const conn = state.connections.find((c) => c.bankId === el.dataset.ofDisconnect && c.status === 'connected');
      if (!conn || !window.confirm('Desconectar este banco? As transações já importadas serão mantidas.')) return;
      await openFinance.disconnectBank(conn);
      await repo.deleteConnection(conn.id);
      state.connections = state.connections.filter((c) => c.id !== conn.id);
      toast('Banco desconectado', 'info');
      renderAll();
    }
  });

  // Modal de transação
  $$('#tx-modal .segmented button').forEach((b) => b.addEventListener('click', () => setTxKind(b.dataset.kind)));
  ['#tx-repeat', '#tx-installments', '#tx-date', '#tx-amount'].forEach((s) => $(s).addEventListener('input', updateRepeatUI));
  $('#tx-form').addEventListener('submit', submitTx);

  // Configurações
  $('#settings-form').addEventListener('submit', submitSettings);
  $('#btn-reset-demo').addEventListener('click', () => resetData(true));
  $('#btn-reset-empty').addEventListener('click', () => resetData(false));

  // Fechar modal clicando fora
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  // Atalho: "N" abre nova transação
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector('dialog[open]') && !/input|select|textarea/i.test(document.activeElement?.tagName)) {
      e.preventDefault();
      openTxModal();
    }
  });

  // Repositório caiu para o modo local
  window.addEventListener('repo:degraded', () => toast('Sem conexão com o servidor — salvando neste navegador.', 'error'));

  // Virada de dia com a aba aberta
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayISO() !== state.today) { state.today = todayISO(); renderAll(); }
  });
}

boot();
