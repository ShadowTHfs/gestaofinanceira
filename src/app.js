// =============================================================================
// APP — estado, renderização e eventos da interface.
// Depende apenas da camada de repositório (persistência) e dos serviços.
// =============================================================================
import * as repo from './services/supabaseClient.js';
import * as openFinance from './services/openFinanceService.js';
import { buildSeed } from './data/seed.js';
import { CATEGORIES, COLORS, PICKABLE_ICONS, getCategory, categoriesByType, setCustomCategories, newCategoryId } from './categories.js';
import {
  transactionsForMonth, monthSummary, evolutionSeries, installmentGroups, isPlanned, isOverdue,
  upcomingItems, occurrencesBetween, ruleSummary, ruleStart, FREQ_LABEL,
} from './services/finance.js';
import { analyzeGoal } from './services/goals.js';
import { renderDoughnut, renderEvolution, getDoughnut, destroyDoughnut, destroyAllCharts, setChartDefaults } from './ui/charts.js';
import { icon, hydrateIcons } from './ui/icons.js';
import * as auth from './services/auth.js';
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
  categories: [],
  goals: [],
  bankAccounts: [],
  of: { status: null, error: null, loading: false },
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
  bindAuthEvents();
  const status = await repo.initRepository();

  // Modo nuvem: exige login.
  if (status.configured && status.clientReady) {
    auth.onAuthChange(handleAuthEvent);
    const user = await auth.getCurrentUser().catch(() => null);
    if (user) await enterAccount(user);
    else showAuthScreen();
    return;
  }

  // Modo local (sem Supabase): demonstração no navegador.
  try {
    await repo.seedIfEmpty(buildSeed);
    await loadAll();
  } catch (err) {
    console.error(err);
    toast('Não foi possível carregar os dados.', 'error');
  }
  showApp();
  renderAll();
  if (status.configured && !status.clientReady) toast(status.reason, 'error');
}

// ------------------------------------------------------------------ sessão / conta
let currentUserId = null;

async function handleAuthEvent(event, user) {
  if (event === 'PASSWORD_RECOVERY') {
    if (user) await enterAccount(user);
    openPasswordModal(true);
    return;
  }
  if (event === 'SIGNED_IN' && user && user.id !== currentUserId) {
    await enterAccount(user);
    return;
  }
  if (event === 'SIGNED_OUT') {
    leaveAccount();
  }
}

async function enterAccount(user) {
  if (currentUserId === user.id) return;
  currentUserId = user.id;
  repo.setUser(user);
  showApp();
  renderUserMenu(user);
  try {
    await loadAll();
  } catch (err) {
    console.error(err);
    toast('Não foi possível carregar seus dados.', 'error');
  }
  renderAll();
  try {
    if (await repo.isRemoteEmpty()) openWelcome();
  } catch (err) {
    console.error(err);
    toast(err.message || 'Não foi possível acessar o banco.', 'error');
  }
  // Open Finance: verifica a integração e atualiza os bancos se estiver desatualizado.
  loadOpenFinanceStatus().then(autoSyncIfStale).catch((err) => console.warn('[open finance]', err));
}

function leaveAccount() {
  repo.clearUserCache();
  repo.setUser(null);
  currentUserId = null;
  Object.assign(state, { transactions: [], recurring: [], connections: [], categories: [], goals: [], bankAccounts: [], of: { status: null, error: null, loading: false }, settings: { ...repo.DEFAULT_SETTINGS } });
  setCustomCategories([]);
  $$('dialog[open]').forEach((d) => d.close());
  destroyAllCharts();
  $('#user-menu').classList.add('hidden');
  showAuthScreen();
}

function showApp() {
  $('#auth-screen').classList.add('hidden');
  $('#auth-screen').classList.remove('flex');
  $('#app-header').classList.remove('hidden');
  $('#app-main').classList.remove('hidden');
}

let socialChecked = false;

function showAuthScreen() {
  $('#app-header').classList.add('hidden');
  $('#app-main').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  $('#auth-screen').classList.add('flex');
  setAuthMode('login');
  setTimeout(() => $('#auth-email').focus(), 50);
  // Botão do Google só aparece se o provedor estiver ativo no Supabase.
  if (!socialChecked) {
    socialChecked = true;
    auth.getEnabledProviders().then((p) => { window.__gfGoogle = Boolean(p.google); updateSocialVisibility(); });
  }
  const urlError = auth.consumeAuthErrorFromUrl();
  if (urlError) authMessage(auth.authErrorMessage({ message: urlError }));
}

function updateSocialVisibility() {
  $('#auth-social').classList.toggle('hidden', !(window.__gfGoogle && authMode !== 'forgot'));
}

async function startGoogleLogin() {
  const btn = $('#auth-google');
  btn.disabled = true;
  btn.innerHTML = `${icon('loader-circle', 'h-4 w-4 animate-spin')}Abrindo o Google…`;
  try {
    await auth.signInWithGoogle(); // a página vai para o Google e volta logada
  } catch (err) {
    authMessage(auth.authErrorMessage(err));
    btn.disabled = false;
    btn.innerHTML = '<span class="grid h-5 w-5 place-items-center rounded-full bg-gradient-to-br from-sky-500 via-emerald-500 to-amber-400 text-[11px] font-black text-white">G</span>Continuar com Google';
  }
}

function renderUserMenu(user) {
  const email = user.email || '';
  $('#user-menu').classList.remove('hidden');
  $('#btn-user').textContent = (email[0] || '?').toUpperCase();
  $('#btn-user').title = email;
  $('#user-email').textContent = email;
}

// ---- tela de login
let authMode = 'login'; // 'login' | 'signup' | 'forgot'

function setAuthMode(mode) {
  authMode = mode;
  $$('#auth-tabs [data-auth-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.authTab === mode)));
  $('#auth-tabs').classList.toggle('hidden', mode === 'forgot');
  $('#auth-password-wrap').classList.toggle('hidden', mode === 'forgot');
  $('#auth-confirm-wrap').classList.toggle('hidden', mode !== 'signup');
  $('#auth-forgot').classList.toggle('hidden', mode !== 'login');
  $('#auth-back').classList.toggle('hidden', mode !== 'forgot');
  $('#auth-password').setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
  $('#auth-submit').textContent = { login: 'Entrar', signup: 'Criar conta', forgot: 'Enviar link de recuperação' }[mode];
  updateSocialVisibility();
  $('#auth-subtitle').textContent = {
    login: 'Entre para ver seu painel financeiro',
    signup: 'Crie sua conta gratuita em segundos',
    forgot: 'Enviaremos um link para você criar uma nova senha',
  }[mode];
  authMessage('');
}

function authMessage(text, kind = 'error') {
  const el = $('#auth-message');
  el.classList.toggle('hidden', !text);
  el.className = `rounded-xl px-3 py-2.5 text-xs leading-relaxed ${text ? '' : 'hidden'} ${kind === 'error'
    ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
    : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}`;
  el.textContent = text;
}

async function submitAuth(e) {
  e.preventDefault();
  const email = $('#auth-email').value.trim().toLowerCase();
  const password = $('#auth-password').value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return authMessage('Digite um e-mail válido.');
  if (authMode !== 'forgot' && password.length < 6) return authMessage('A senha precisa ter pelo menos 6 caracteres.');
  if (authMode === 'signup' && password !== $('#auth-confirm').value) return authMessage('As senhas não conferem.');

  const btn = $('#auth-submit');
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `${icon('loader-circle', 'h-4 w-4 animate-spin')}Aguarde…`;
  try {
    if (authMode === 'login') {
      const user = await auth.signIn(email, password);
      $('#auth-password').value = '';
      await enterAccount(user);
    } else if (authMode === 'signup') {
      const { user, needsConfirmation } = await auth.signUp(email, password);
      if (needsConfirmation) {
        setAuthMode('login');
        $('#auth-email').value = email;
        authMessage(`Conta criada! Enviamos um link de confirmação para ${email}. Abra o e-mail, clique no link e depois entre aqui.`, 'success');
      } else {
        await enterAccount(user);
      }
    } else {
      await auth.sendPasswordReset(email);
      authMessage(`Se existir uma conta com ${email}, você vai receber um link para criar uma nova senha.`, 'success');
    }
  } catch (err) {
    console.error(err);
    authMessage(auth.authErrorMessage(err));
  } finally {
    btn.disabled = false;
    btn.textContent = { login: 'Entrar', signup: 'Criar conta', forgot: 'Enviar link de recuperação' }[authMode] || label;
  }
}

// ---- boas-vindas (conta vazia)
function openWelcome() {
  const snap = repo.getLocalSnapshot();
  const n = snap.transactions.filter((t) => t.source !== 'open_finance').length;
  $('#welcome-import').classList.toggle('hidden', n === 0);
  // Se o que está no navegador é a demonstração, avisa bem claro e não recomenda copiar.
  const demo = n > 0 && snap.isDemo;
  $('#welcome-import').classList.toggle('order-2', demo);
  $('#welcome-import-title').textContent = demo ? 'Copiar os dados de DEMONSTRAÇÃO (fictícios)' : 'Trazer os dados deste navegador';
  $('#welcome-demo-note').classList.toggle('hidden', !demo);
  const pl = (q, one, many) => `${q} ${q === 1 ? one : many}`;
  $('#welcome-import-detail').textContent = demo
    ? `São os exemplos que vêm com o app (${pl(n, 'transação', 'transações')} inventadas). Não são seus — só use para testar.`
    : `${pl(n, 'transação', 'transações')}, ${pl(snap.recurring.length, 'recorrência', 'recorrências')}, ${pl(snap.categories.length, 'categoria', 'categorias')} e ${pl(snap.goals.length, 'meta', 'metas')} salvas neste aparelho serão copiadas para a sua conta.`;
  $('#welcome-status').classList.add('hidden');
  $$('#welcome-modal button').forEach((b) => { b.disabled = false; });
  $('#welcome-modal').showModal();
}

async function welcomeImport() {
  $$('#welcome-modal button').forEach((b) => { b.disabled = true; });
  const st = $('#welcome-status');
  st.classList.remove('hidden');
  st.textContent = 'Copiando seus dados para a nuvem…';
  try {
    const r = await repo.importLocalToAccount();
    await loadAll();
    renderAll();
    $('#welcome-modal').close();
    toast(`${r.transactions} transações importadas para sua conta`, 'success');
  } catch (err) {
    console.error(err);
    st.textContent = err.message || 'Falha ao importar.';
    $$('#welcome-modal button').forEach((b) => { b.disabled = false; });
  }
}

async function welcomeEmpty() {
  $('#welcome-modal').close();
  openSettings();
  toast('Defina seu orçamento mensal e o saldo que você tem hoje', 'info');
}

// ---- trocar / recuperar senha
function openPasswordModal(recovery = false) {
  $('#password-form').reset();
  $('#pw-error').classList.add('hidden');
  $('#password-title').textContent = recovery ? 'Crie sua nova senha' : 'Trocar senha';
  $('#password-modal').showModal();
}

async function submitPassword(e) {
  e.preventDefault();
  const a = $('#pw-new').value;
  const b = $('#pw-confirm').value;
  const err = $('#pw-error');
  const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
  if (a.length < 6) return fail('A senha precisa ter pelo menos 6 caracteres.');
  if (a !== b) return fail('As senhas não conferem.');
  $('#pw-submit').disabled = true;
  try {
    await auth.updatePassword(a);
    $('#password-modal').close();
    toast('Senha atualizada', 'success');
  } catch (e2) {
    fail(auth.authErrorMessage(e2));
  } finally {
    $('#pw-submit').disabled = false;
  }
}

function bindAuthEvents() {
  $('#auth-form').addEventListener('submit', submitAuth);
  $('#auth-google').addEventListener('click', startGoogleLogin);
  $$('#auth-tabs [data-auth-tab]').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.authTab)));
  $('#auth-forgot').addEventListener('click', () => setAuthMode('forgot'));
  $('#auth-back').addEventListener('click', () => setAuthMode('login'));
  $('#welcome-import').addEventListener('click', welcomeImport);
  $('#welcome-empty').addEventListener('click', welcomeEmpty);
  $('#password-form').addEventListener('submit', submitPassword);
  $('#btn-change-password').addEventListener('click', () => { closeUserMenu(); openPasswordModal(false); });
  $('#btn-logout').addEventListener('click', async () => {
    closeUserMenu();
    try { await auth.signOut(); } catch (err) { console.error(err); }
    leaveAccount(); // garante a saída mesmo se o servidor não responder
  });
  $('#btn-user').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = $('#user-dropdown');
    const open = dd.classList.toggle('hidden') === false;
    $('#btn-user').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#user-menu')) closeUserMenu(); });
}

function closeUserMenu() {
  $('#user-dropdown').classList.add('hidden');
  $('#btn-user').setAttribute('aria-expanded', 'false');
}

/**
 * Trava contra clique duplo: enquanto a gravação não termina, o botão fica
 * desabilitado e novos envios do mesmo formulário são ignorados.
 */
const locks = new Set();
async function withLock(key, button, fn) {
  if (locks.has(key)) return undefined;
  locks.add(key);
  if (button) button.disabled = true;
  try {
    return await fn();
  } finally {
    locks.delete(key);
    if (button) button.disabled = false;
  }
}

/** Executa uma gravação; se falhar, avisa claramente que NÃO foi salvo. */
async function persist(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(`Não foi salvo: ${err.message || 'erro desconhecido'}`, 'error');
    return undefined;
  }
}

async function loadAll() {
  const [transactions, recurring, settings, connections, categories, goals, bankAccounts] = await Promise.all([
    repo.fetchTransactions(), repo.fetchRecurring(), repo.fetchSettings(), repo.fetchConnections(),
    repo.fetchCategories(), repo.fetchGoals(), repo.fetchBankAccounts(),
  ]);
  Object.assign(state, { transactions, recurring, settings, connections, categories, goals, bankAccounts });
  setCustomCategories(categories);
}

// ------------------------------------------------------------------ render geral
function renderAll() {
  renderGreeting();
  renderStorageBadge();
  renderMonthNav();
  const summary = applyBankBalance(monthSummary(state, state.selectedYM));
  renderKPIs(summary);
  renderPie(summary);
  renderBars();
  renderCategoryFilter();
  renderTransactions();
  renderUpcoming();
  renderGoals();
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
      ${icon(remote ? 'database' : 'hard-drive', 'h-3 w-3')}${remote ? 'Salvo na nuvem' : 'Salvo neste navegador'}</span>`;
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

// ---- saldo: real dos bancos (Open Finance) ou calculado pelas transações
const balanceKey = () => `gf.balanceSource.${repo.getRepositoryStatus().userId || 'local'}`;
function getBalanceSource() {
  try { return localStorage.getItem(balanceKey()) || 'bank'; } catch { return 'bank'; }
}
function setBalanceSource(v) {
  try { localStorage.setItem(balanceKey(), v); } catch { /* sem storage */ }
}
function bankBalanceInfo() {
  const banks = state.bankAccounts.filter((a) => a.type === 'BANK' && a.balance != null);
  if (!banks.length) return null;
  const last = banks.map((a) => a.updatedAt).filter(Boolean).sort().pop() || null;
  return { total: sum(banks, (a) => a.balance), count: banks.length, updatedAt: last };
}
/** Troca o saldo calculado pelo saldo real dos bancos (e ajusta a projeção do mês). */
function applyBankBalance(s) {
  const info = bankBalanceInfo();
  if (!info || getBalanceSource() !== 'bank') return s;
  const delta = info.total - s.balance;
  return { ...s, balance: Math.round(info.total * 100) / 100, projectedEnd: Math.round((s.projectedEnd + delta) * 100) / 100, balanceFromBank: info };
}

function renderKPIs(s) {
  const mode = s.mode;
  const bar = (pct, over) => `<div class="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-800">
      <div class="h-full rounded-full transition-all duration-700 ${over ? 'bg-gradient-to-r from-rose-400 to-rose-600' : pct > 80 ? 'bg-gradient-to-r from-amber-400 to-orange-500' : 'bg-gradient-to-r from-indigo-500 to-violet-500'}" style="width:${Math.max(2, pct).toFixed(1)}%"></div></div>`;

  const bankNote = s.balanceFromBank ? `<span class="mt-0.5 block text-[11px] opacity-80">${icon('landmark', 'mr-1 inline h-3 w-3')}Real nos bancos (${s.balanceFromBank.count} conta${s.balanceFromBank.count > 1 ? 's' : ''}, via Open Finance)</span>` : '';
  const balanceSub = mode === 'past'
    ? `${s.balanceFromBank ? 'Saldo real nos bancos hoje' : 'Saldo de hoje'}${bankNote}`
    : `Fim de ${monthLabel(s.ym, { withYear: false }).toLowerCase()}: <span class="font-semibold ${s.projectedEnd >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-300'}">${fmt(s.projectedEnd)}</span> (projetado)${bankNote}`;

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
    destroyDoughnut();
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
            <span class="truncate text-sm font-medium">${escapeHTML(cat.label)}</span>
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
  // Os botões só mexem no gráfico se ele ainda for o gráfico atual (não destruído).
  const alive = () => chart && getDoughnut() === chart;

  $$('#pie-legend .legend-item').forEach((btn) => {
    const i = Number(btn.dataset.index);
    btn.addEventListener('mouseenter', () => {
      if (!alive() || hidden.has(i)) return;
      chart.setActiveElements([{ datasetIndex: 0, index: i }]);
      chart.tooltip.setActiveElements([{ datasetIndex: 0, index: i }], { x: 0, y: 0 });
      chart.update();
    });
    btn.addEventListener('mouseleave', () => {
      if (!alive()) return;
      chart.setActiveElements([]);
      chart.tooltip.setActiveElements([], { x: 0, y: 0 });
      chart.update();
    });
    // Clique na legenda: mostra/oculta a fatia (recalcula % e total do centro).
    btn.addEventListener('click', () => {
      if (!alive()) return;
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
    .concat(Object.entries(CATEGORIES).map(([k, c]) => `<option value="${escapeHTML(k)}">${escapeHTML(c.label)}</option>`));
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

function statusBadge(t) {
  if (!isPlanned(t, state.today)) return '';
  if (isOverdue(t, state.today)) return `<span class="badge bg-rose-500/10 text-rose-600 ring-rose-500/30 dark:text-rose-300">${icon('alarm-clock', 'h-3 w-3')}Atrasado</span>`;
  if (t.status === 'pending' || t.projected) return `<span class="badge border border-dashed border-amber-400/60 bg-amber-500/5 text-amber-700 ring-transparent dark:text-amber-300">${icon('clock', 'h-3 w-3')}${t.type === 'income' ? 'A receber' : 'A pagar'}</span>`;
  return `<span class="badge border border-dashed border-violet-400/50 bg-violet-500/5 text-violet-600 ring-transparent dark:text-violet-300">${icon('clock', 'h-3 w-3')}Previsto</span>`;
}

function txRow(t) {
  const cat = getCategory(t.category);
  const planned = isPlanned(t, state.today);
  const income = t.type === 'income';
  const tags = [statusBadge(t)];
  if (t.installment) tags.push(`<span class="badge bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300">${icon('credit-card', 'h-3 w-3')}${t.installment.current}/${t.installment.total}</span>`);
  else if (t.occurrence) tags.push(`<span class="badge bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300">${icon('repeat', 'h-3 w-3')}${t.occurrence.current}/${t.occurrence.total}</span>`);
  else if (t.recurringId) tags.push(`<span class="badge bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300">${icon('repeat', 'h-3 w-3')}Recorrente</span>`);
  if (t.items?.length) tags.push(`<button type="button" data-toggle-items="${t.id}" class="badge bg-slate-500/10 text-slate-600 ring-slate-500/20 transition-colors hover:bg-slate-500/20 dark:text-slate-300" aria-expanded="false">${icon('list', 'h-3 w-3')}${t.items.length} ${t.items.length === 1 ? 'item' : 'itens'}</button>`);
  if (t.source === 'open_finance') {
    const conn = state.connections.find((c) => c.id === t.accountId);
    const acc = t.bankAccountId && state.bankAccounts.find((a) => a.id === t.bankAccountId);
    const label = conn?.institution ? conn.institution.replace(/^meu ?pluggy\s*[·\-:]\s*/i, '') : 'Open Finance';
    tags.push(`<span class="badge bg-indigo-500/10 text-indigo-600 ring-indigo-500/20 dark:text-indigo-300" title="Importada do banco">${icon(acc?.type === 'CREDIT' ? 'credit-card' : 'landmark', 'h-3 w-3')}${escapeHTML(label)}</span>`);
  }
  const canPay = planned && (t.status === 'pending' || t.projected);
  const itemsDetail = t.items?.length
    ? `<div id="items-${t.id}" class="ml-[3.25rem] mr-2 hidden pb-2"><table class="w-full text-xs"><tbody>
        ${t.items.map((it) => `<tr class="border-b border-slate-200/60 last:border-0 dark:border-slate-800/60"><td class="py-1 pr-2">${escapeHTML(it.name)}</td><td class="py-1 text-right text-slate-500 tabular-nums">${String(it.qty).replace('.', ',')} × ${fmt(it.price)}</td><td class="py-1 pl-3 text-right font-medium tabular-nums">${fmt(it.qty * it.price)}</td></tr>`).join('')}
      </tbody></table></div>`
    : '';

  return `<li class="group rounded-xl transition-all duration-300 hover:bg-slate-100/70 dark:hover:bg-slate-800/40 ${planned && !isOverdue(t, state.today) ? 'opacity-90' : ''}">
    <div class="flex items-center gap-3 px-2.5 py-2.5">
      <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset ${cat.badge}">${icon(cat.icon, 'h-[18px] w-[18px]')}</div>
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium">${escapeHTML(t.description)}</p>
        <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <span class="badge ring-inset ${cat.badge}">${escapeHTML(cat.label)}</span>${tags.join('')}
        </div>
      </div>
      <div class="text-right">
        <p class="text-sm font-semibold tabular-nums ${income ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-300'}">${income ? '+' : '−'} ${fmt(t.amount)}</p>
        <p class="text-[11px] text-slate-400">${shortDate(t.date)}</p>
      </div>
      <div class="flex w-[4.5rem] justify-end gap-0.5">
        ${canPay ? `<button type="button" class="btn-icon h-8 w-8 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400" data-pay="${t.id}" title="${income ? 'Marcar como recebido' : 'Marcar como pago'}" aria-label="${income ? 'Marcar como recebido' : 'Marcar como pago'}: ${escapeHTML(t.description)}">${icon('check-check', 'h-4 w-4')}</button>` : ''}
        ${t.projected ? '' : `<button type="button" class="btn-icon h-8 w-8 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100" data-delete="${t.id}" aria-label="Excluir ${escapeHTML(t.description)}" title="Excluir">${icon('trash-2', 'h-4 w-4')}</button>`}
      </div>
    </div>
    ${itemsDetail}
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
    ? `<button type="button" id="clear-cat" class="badge gap-1.5 px-2 py-1 ring-inset ${getCategory(f.category).badge}">Filtrando: ${escapeHTML(getCategory(f.category).label)} ${icon('x', 'h-3 w-3')}</button>`
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
  const rules = state.recurring
    .filter((r) => r.active !== false && occurrencesBetween(r, `${ymOf(state.today)}-01`, '9999-12-31').length > 0)
    .sort((a, b) => dayOf(ruleStart(a)) - dayOf(ruleStart(b)));
  const inst = installmentGroups(state);
  const box = $('#recurring-list');
  if (!rules.length && !inst.length) {
    box.innerHTML = `<p class="rounded-xl border border-dashed border-slate-300/70 px-4 py-6 text-center text-xs text-slate-500 dark:border-slate-700/70 dark:text-slate-400">Nenhum compromisso recorrente.<br/>Na nova transação, escolha “Repetir” ou “Parcelado”.</p>`;
    return;
  }
  // Custo mensal equivalente das saídas recorrentes (semanal ≈ ×52/12, anual ≈ ÷12)
  const factor = { weekly: 52 / 12, monthly: 1, yearly: 1 / 12 };
  const monthlyOut = sum(rules.filter((r) => r.type === 'expense'), (r) => r.amount * (factor[r.frequency || 'monthly'] || 1));
  const ruleRows = rules.map((r) => {
    const cat = getCategory(r.category);
    const income = r.type === 'income';
    return `<li class="group flex items-center gap-3 rounded-xl px-2 py-2 transition-all duration-300 hover:bg-slate-100/70 dark:hover:bg-slate-800/40">
      <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset ${cat.badge}">${icon(cat.icon, 'h-4 w-4')}</span>
      <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">${escapeHTML(r.description)}</span>
        <span class="text-[11px] text-slate-500 dark:text-slate-400">${income ? 'Receita' : (KIND_LABEL[r.kind] || 'Recorrente')} · ${FREQ_LABEL[r.frequency || 'monthly'].toLowerCase()} · ${ruleSummary(r)}</span></span>
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
    ${rules.length ? `<p class="mb-1 flex justify-between px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"><span>Séries ativas</span><span class="tabular-nums normal-case">≈ ${fmt(monthlyOut)}/mês em saídas</span></p><ul>${ruleRows}</ul>` : ''}
    ${inst.length ? `<p class="mb-1 mt-3 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Parcelamentos</p><ul>${instRows}</ul>` : ''}`;
}

// ------------------------------------------------------------------ próximos vencimentos
let upcomingExpanded = false;

function renderUpcoming() {
  const items = upcomingItems(state, 30);
  const box = $('#upcoming-list');
  const overdue = items.filter((t) => isOverdue(t, state.today));
  const toPay = sum(items.filter((t) => t.type === 'expense'), (t) => t.amount);
  const toReceive = sum(items.filter((t) => t.type === 'income'), (t) => t.amount);
  $('#upcoming-sub').innerHTML = items.length
    ? `${overdue.length ? `<span class="font-semibold text-rose-500 dark:text-rose-300">${overdue.length} atrasado${overdue.length > 1 ? 's' : ''}</span> · ` : ''}A pagar <span class="tabular-nums">${fmt(toPay)}</span>${toReceive ? ` · A receber <span class="tabular-nums">${fmt(toReceive)}</span>` : ''}`
    : 'Atrasados e próximos 30 dias';
  if (!items.length) {
    box.innerHTML = `<p class="rounded-xl border border-dashed border-slate-300/70 px-4 py-6 text-center text-xs text-slate-500 dark:border-slate-700/70 dark:text-slate-400">${icon('calendar-check', 'mx-auto mb-2 h-5 w-5 text-emerald-500')}Nada vencendo nos próximos 30 dias.</p>`;
    return;
  }
  const limit = upcomingExpanded ? items.length : 6;
  const diffDays = (iso) => Math.round((new Date(`${iso}T12:00:00`) - new Date(`${state.today}T12:00:00`)) / 86400000);
  box.innerHTML = `<ul class="space-y-1">${items.slice(0, limit).map((t) => {
    const cat = getCategory(t.category);
    const d = diffDays(t.date);
    const when = d < 0 ? `venceu há ${-d} dia${d === -1 ? '' : 's'}` : d === 0 ? 'vence hoje' : d === 1 ? 'amanhã' : `em ${d} dias · ${shortDate(t.date)}`;
    const late = d < 0;
    return `<li class="flex items-center gap-3 rounded-xl px-2 py-2 ${late ? 'bg-rose-500/5' : ''}">
      <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset ${cat.badge}">${icon(cat.icon, 'h-4 w-4')}</span>
      <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">${escapeHTML(t.description)}</span>
        <span class="text-[11px] ${late ? 'font-semibold text-rose-500 dark:text-rose-300' : d <= 3 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}">${when}</span></span>
      <span class="text-sm font-semibold tabular-nums ${t.type === 'income' ? 'text-emerald-600 dark:text-emerald-400' : ''}">${t.type === 'income' ? '+' : ''}${fmt(t.amount)}</span>
      <button type="button" class="btn-icon h-8 w-8 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400" data-pay="${t.id}" title="${t.type === 'income' ? 'Recebi' : 'Paguei'}" aria-label="Marcar ${escapeHTML(t.description)} como ${t.type === 'income' ? 'recebido' : 'pago'}">${icon('check-check', 'h-4 w-4')}</button>
    </li>`;
  }).join('')}</ul>
  ${items.length > 6 ? `<button type="button" id="upcoming-toggle" class="mt-2 w-full rounded-lg py-1.5 text-xs font-medium text-indigo-600 transition-colors hover:bg-indigo-500/10 dark:text-indigo-400">${upcomingExpanded ? 'Mostrar menos' : `Ver todos (${items.length})`}</button>` : ''}`;
  $('#upcoming-toggle')?.addEventListener('click', () => { upcomingExpanded = !upcomingExpanded; renderUpcoming(); });
}

/** Encontra um lançamento (real ou previsto) pelo id em qualquer mês exibido. */
function findAnyTx(id) {
  const real = state.transactions.find((t) => t.id === id);
  if (real) return real;
  if (!id.startsWith('proj-')) return null;
  return upcomingItems(state, 400).find((t) => t.id === id)
    || transactionsForMonth(state, state.selectedYM).find((t) => t.id === id) || null;
}

/** Marca como pago/recebido. Previsto de série → cria o lançamento real daquela ocorrência. */
async function payTx(id) {
  const t = findAnyTx(id);
  if (!t) return;
  if (t.projected) {
    const tx = {
      id: uid(), description: t.description, amount: t.amount, type: t.type, category: t.category, date: t.date,
      source: 'manual', status: 'paid', recurringId: t.recurringId, installment: null, externalId: null, accountId: null, items: null,
    };
    const saved = await persist(() => repo.saveTransaction(tx));
    if (!saved) return;
    state.transactions.push(saved);
  } else {
    const updated = { ...t, status: 'paid' };
    const saved = await persist(() => repo.saveTransaction(updated));
    if (!saved) return;
    state.transactions = state.transactions.map((x) => (x.id === t.id ? { ...x, status: 'paid' } : x));
  }
  toast(`${t.description}: ${t.type === 'income' ? 'recebido' : 'pago'} ✔`, 'success');
  renderAll();
}

// ------------------------------------------------------------------ Open Finance (Pluggy / Meu Pluggy — real)
// state.of = { status: null | {...}, error: null | {message, code}, loading: bool }
const LINK = (href, text) => `<a class="font-medium text-indigo-600 underline dark:text-indigo-400" href="${href}" target="_blank" rel="noopener">${text}</a>`;
const OF_KEY_STEPS = `
  <ol class="space-y-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
    <li><strong>1.</strong> Crie sua conta grátis no ${LINK('https://dashboard.pluggy.ai', 'Dashboard da Pluggy')} (use o mesmo e-mail que vai usar no Meu Pluggy).</li>
    <li><strong>2.</strong> Em <em>Applications</em>, crie uma aplicação e copie o <strong>Client ID</strong> e o <strong>Client Secret</strong>.</li>
    <li><strong>3.</strong> Cole os dois aqui. O Secret é guardado <strong>criptografado</strong> — nem o navegador nem outras pessoas conseguem lê-lo.</li>
  </ol>`;
const OF_STEPS = `
  <ol class="space-y-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
    <li><strong>1.</strong> Em ${LINK('https://meu.pluggy.ai', 'meu.pluggy.ai')}, conecte seus bancos (autoriza no app do banco).</li>
    <li><strong>2.</strong> No ${LINK('https://dashboard.pluggy.ai', 'Dashboard da Pluggy')}: <em>Applications → sua aplicação → Demo → Connect Account</em> e escolha o conector <strong>MeuPluggy</strong> (não o banco, nem o Sandbox).</li>
    <li><strong>3.</strong> Em <em>Connected Items</em>, abra cada banco e copie o <strong>Item ID</strong>. Cole aqui no app.</li>
  </ol>`;

async function loadOpenFinanceStatus({ force = false } = {}) {
  if (repo.getRepositoryStatus().backend !== 'supabase') return;
  if (state.of.loading || (state.of.status && !force)) return;
  state.of.loading = true;
  renderOpenFinance();
  try {
    state.of.status = await openFinance.getStatus();
    state.of.error = null;
  } catch (err) {
    state.of.status = null;
    state.of.error = { message: err.message, code: err.code };
  } finally {
    state.of.loading = false;
    renderOpenFinance();
  }
}

const ofReady = () => {
  const st = state.of.status;
  return Boolean(st && st.allowed && st.encryptionReady && (st.hasOwnCredentials || st.sharedAvailable));
};

function bankLogo(name) {
  const n = String(name || 'Banco').replace(/^meu ?pluggy\s*[·\-:]\s*/i, '');
  const initials = n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'B';
  return `<div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-bold text-white shadow-md">${escapeHTML(initials)}</div>`;
}

function renderOpenFinance() {
  const box = $('#of-list');
  const badge = $('#of-badge');
  const cloud = repo.getRepositoryStatus().backend === 'supabase';
  badge.textContent = 'Meu Pluggy · grátis';

  if (!cloud) {
    box.innerHTML = `<div class="rounded-xl border border-dashed border-slate-300/70 p-4 text-xs leading-relaxed text-slate-600 dark:border-slate-700/70 dark:text-slate-300">
      ${icon('lock', 'mb-2 h-5 w-5 text-indigo-500')}
      A conexão com bancos reais funciona no <strong>modo nuvem</strong> (Supabase com login), porque precisa de um servidor seguro para guardar a chave da Pluggy.</div>`;
    return;
  }
  if (state.of.loading && !state.of.status) {
    box.innerHTML = '<div class="space-y-2"><div class="skeleton h-14"></div><div class="skeleton h-14"></div></div>';
    return;
  }
  if (state.of.error) {
    const notDeployed = state.of.error.code === 'not_deployed';
    box.innerHTML = `<div class="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs leading-relaxed text-amber-900 dark:text-amber-100">
      <p class="flex items-start gap-2 font-medium">${icon('triangle-alert', 'mt-0.5 h-4 w-4 shrink-0')}${escapeHTML(state.of.error.message)}</p>
      ${notDeployed ? '<p>Siga o passo a passo do arquivo <strong>GUIA-PLUGGY.md</strong> para publicar a função <code>pluggy</code> no Supabase.</p>' : ''}
      <button type="button" class="btn-ghost px-3 py-1.5 text-xs" data-of-retry>${icon('refresh-cw', 'h-3.5 w-3.5')}Tentar de novo</button></div>`;
    return;
  }
  const st = state.of.status;
  if (st && (!st.allowed || !st.encryptionReady)) {
    const msg = !st.allowed
      ? `Esta conta (<strong>${escapeHTML(st.email || '')}</strong>) não está na lista de pessoas autorizadas a usar o Open Finance neste app. Peça ao administrador para incluir seu e-mail.`
      : 'O servidor está sem chave de criptografia. O administrador precisa definir o Secret <code>PLUGGY_ENCRYPTION_KEY</code> no Supabase.';
    box.innerHTML = `<div class="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs leading-relaxed text-amber-900 dark:text-amber-100">
      <p class="flex items-start gap-2">${icon('triangle-alert', 'mt-0.5 h-4 w-4 shrink-0')}<span>${msg}</span></p>
      <button type="button" class="btn-ghost px-3 py-1.5 text-xs" data-of-retry>${icon('refresh-cw', 'h-3.5 w-3.5')}Verificar de novo</button></div>`;
    return;
  }
  if (st && !ofReady()) {
    box.innerHTML = `<div class="space-y-3 rounded-xl border border-dashed border-slate-300/70 p-4 dark:border-slate-700/70">
      <p class="flex items-center gap-2 text-sm font-medium">${icon('lock', 'h-4 w-4 text-indigo-500')}Passo 1: sua chave da Pluggy</p>
      <p class="text-xs leading-relaxed text-slate-600 dark:text-slate-300">Cada pessoa usa a própria conta gratuita da Pluggy (Meu Pluggy é de uso pessoal). Assim, só você enxerga os seus bancos.</p>
      ${OF_KEY_STEPS}
      <button type="button" class="btn-primary w-full py-2 text-xs" data-of-keys>${icon('lock', 'h-3.5 w-3.5')}Cadastrar minha chave da Pluggy</button>
    </div>`;
    return;
  }

  const conns = state.connections.filter((c) => c.externalItemId);
  const accounts = state.bankAccounts;
  const bankTotal = sum(accounts.filter((a) => a.type === 'BANK'), (a) => a.balance || 0);
  const cardTotal = sum(accounts.filter((a) => a.type === 'CREDIT'), (a) => Math.abs(a.balance || 0));
  const timeAgo = (iso) => {
    if (!iso) return 'nunca sincronizado';
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'agora mesmo';
    if (min < 60) return `há ${min} min`;
    if (min < 1440) return `há ${Math.round(min / 60)} h`;
    return `há ${Math.round(min / 1440)} dia(s)`;
  };

  const connHtml = conns.map((c) => {
    const busy = state.busy.has(c.id);
    const accs = accounts.filter((a) => a.connectionId === c.id);
    const n = state.transactions.filter((t) => t.accountId === c.id).length;
    const ok = c.status === 'connected' && !c.lastError;
    return `<div class="rounded-xl border border-slate-200/80 bg-white/50 p-3 transition-all duration-300 hover:border-slate-300 dark:border-slate-800/80 dark:bg-slate-950/30 dark:hover:border-slate-700">
      <div class="flex items-center gap-3">
        ${bankLogo(c.institution)}
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium">${escapeHTML(c.institution || 'Banco')}</p>
          <p class="truncate text-[11px] ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-300'}">${ok ? '●' : '⚠'} ${busy ? 'sincronizando…' : `${timeAgo(c.lastSyncAt)} · ${n} transações`}</p>
        </div>
        <div class="flex gap-1">
          <button type="button" class="btn-icon h-8 w-8" data-of-sync="${c.id}" title="Sincronizar agora" aria-label="Sincronizar ${escapeHTML(c.institution || '')}" ${busy ? 'disabled' : ''}>${icon(busy ? 'loader-circle' : 'refresh-cw', `h-4 w-4 ${busy ? 'animate-spin' : ''}`)}</button>
          <button type="button" class="btn-icon h-8 w-8" data-of-disconnect="${c.id}" title="Remover conexão" aria-label="Remover ${escapeHTML(c.institution || '')}">${icon('unplug', 'h-4 w-4')}</button>
        </div>
      </div>
      ${c.lastError ? `<p class="mt-2 rounded-lg bg-rose-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-rose-700 dark:text-rose-300">${escapeHTML(c.lastError)}</p>` : ''}
      ${accs.length ? `<ul class="mt-2 space-y-1 border-t border-slate-200/70 pt-2 dark:border-slate-800/70">${accs.map((a) => a.type === 'CREDIT'
        ? `<li class="flex items-center justify-between gap-2 text-xs"><span class="flex min-w-0 items-center gap-1.5 truncate text-slate-600 dark:text-slate-300">${icon('credit-card', 'h-3.5 w-3.5 shrink-0')}<span class="truncate">${escapeHTML(a.name || 'Cartão')}</span></span>
            <span class="shrink-0 text-right tabular-nums"><span class="font-semibold text-rose-500 dark:text-rose-300">${fmt(Math.abs(a.balance || 0))}</span>${a.billDueDate ? `<span class="block text-[10px] text-slate-500">vence ${shortDate(a.billDueDate)}${a.availableCredit != null ? ` · disp. ${fmt(a.availableCredit)}` : ''}</span>` : ''}</span></li>`
        : `<li class="flex items-center justify-between gap-2 text-xs"><span class="flex min-w-0 items-center gap-1.5 truncate text-slate-600 dark:text-slate-300">${icon('landmark', 'h-3.5 w-3.5 shrink-0')}<span class="truncate">${escapeHTML(a.name || 'Conta')}</span></span><span class="shrink-0 font-semibold tabular-nums">${fmt(a.balance || 0)}</span></li>`).join('')}</ul>` : ''}
    </div>`;
  }).join('');

  box.innerHTML = `
    ${accounts.length ? `<div class="grid grid-cols-2 gap-2">
      <div class="rounded-xl bg-emerald-500/10 p-3"><p class="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Saldo nos bancos</p><p class="text-base font-bold tabular-nums">${fmt(bankTotal)}</p></div>
      <div class="rounded-xl bg-rose-500/10 p-3"><p class="text-[11px] font-medium text-rose-700 dark:text-rose-300">Faturas dos cartões</p><p class="text-base font-bold tabular-nums">${fmt(cardTotal)}</p></div>
    </div>` : ''}
    ${connHtml || `<div class="rounded-xl border border-dashed border-slate-300/70 p-4 dark:border-slate-700/70">
      <p class="mb-2 text-sm font-medium">Conecte seus bancos de verdade</p>${OF_STEPS}</div>`}
    <p class="flex items-center justify-between gap-2 rounded-lg bg-slate-100/70 px-3 py-2 text-[11px] text-slate-600 dark:bg-slate-950/50 dark:text-slate-300">
      <span class="flex items-center gap-1.5">${icon('lock', 'h-3 w-3')}${st?.hasOwnCredentials ? `Sua chave da Pluggy: <strong class="font-mono">${escapeHTML(st.clientIdHint || '')}</strong>` : 'Usando a chave compartilhada do administrador'}</span>
      <span class="flex gap-2"><button type="button" class="font-medium text-indigo-600 hover:underline dark:text-indigo-400" data-of-keys>${st?.hasOwnCredentials ? 'Trocar' : 'Usar a minha'}</button>${st?.hasOwnCredentials ? '<button type="button" class="font-medium text-rose-600 hover:underline dark:text-rose-400" data-of-keys-delete>Remover</button>' : ''}</span>
    </p>
    <div class="flex gap-2">
      <button type="button" class="btn-primary flex-1 py-2 text-xs" data-of-add ${conns.length >= 5 ? 'disabled title="O Meu Pluggy permite até 5 conexões"' : ''}>${icon('plus', 'h-3.5 w-3.5')}Adicionar conexão</button>
      ${conns.length > 1 ? `<button type="button" class="btn-ghost px-3 text-xs" data-of-sync-all title="Sincronizar todas">${icon('refresh-cw', 'h-3.5 w-3.5')}Todas</button>` : ''}
    </div>`;
}

function openCredentialsModal() {
  const st = state.of.status || {};
  $('#of-modal-body').innerHTML = `
    <form id="of-keys-form" novalidate>
      <header class="flex items-center justify-between border-b border-slate-200/80 px-6 py-4 dark:border-slate-800/80">
        <div>
          <h3 id="of-title" class="text-base font-semibold">${st.hasOwnCredentials ? 'Trocar' : 'Cadastrar'} minha chave da Pluggy</h3>
          <p class="text-xs text-slate-500 dark:text-slate-400">Fica guardada criptografada no servidor</p>
        </div>
        <button type="button" class="btn-icon" data-close aria-label="Fechar">${icon('x')}</button>
      </header>
      <div class="space-y-4 px-6 py-5">
        <div class="rounded-xl bg-slate-100/70 p-4 dark:bg-slate-950/50">${OF_KEY_STEPS}</div>
        <div>
          <label for="of-client-id" class="field-label">Client ID</label>
          <input id="of-client-id" class="input font-mono text-sm" autocomplete="off" spellcheck="false" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
        </div>
        <div>
          <label for="of-client-secret" class="field-label">Client Secret</label>
          <input id="of-client-secret" type="password" class="input font-mono text-sm" autocomplete="new-password" spellcheck="false" placeholder="••••••••" />
          <p class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">A Pluggy mostra o Secret uma vez. Se perdeu, gere outro em <em>Refresh Secret</em> na página da aplicação.</p>
        </div>
        <p id="of-keys-error" class="hidden rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"></p>
      </div>
      <footer class="flex justify-end gap-2 border-t border-slate-200/80 px-6 py-4 dark:border-slate-800/80">
        <button type="button" class="btn-ghost" data-close>Cancelar</button>
        <button type="submit" class="btn-primary" id="of-keys-submit">${icon('shield-check')}Validar e salvar</button>
      </footer>
    </form>`;
  $('#of-modal').showModal();
  setTimeout(() => $('#of-client-id').focus(), 50);
  $('#of-keys-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#of-client-id').value.trim();
    const secret = $('#of-client-secret').value.trim();
    const err = $('#of-keys-error');
    const show = (m) => { err.textContent = m; err.classList.toggle('hidden', !m); };
    if (id.length < 8 || secret.length < 8) return show('Cole o Client ID e o Client Secret completos, como aparecem no Dashboard da Pluggy.');
    show('');
    const btn = $('#of-keys-submit');
    btn.disabled = true;
    btn.innerHTML = `${icon('loader-circle', 'h-4 w-4 animate-spin')}Validando na Pluggy…`;
    try {
      await openFinance.saveCredentials(id, secret);
      $('#of-client-secret').value = '';
      $('#of-modal').close();
      await loadOpenFinanceStatus({ force: true });
      toast('Chave da Pluggy validada e salva com segurança', 'success');
    } catch (ex) {
      show(ex.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon('shield-check')}Validar e salvar`;
    }
  });
}

async function removeCredentials() {
  if (!window.confirm('Remover sua chave da Pluggy deste app?\n\nSuas transações continuam salvas, mas as conexões param de sincronizar até você cadastrar a chave de novo.')) return;
  try {
    await openFinance.deleteCredentials();
    await loadOpenFinanceStatus({ force: true });
    toast('Chave removida', 'info');
  } catch (err) {
    toast(`Não foi possível remover: ${err.message}`, 'error');
  }
}

function openAddConnection() {
  const modal = $('#of-modal');
  $('#of-modal-body').innerHTML = `
    <form id="of-add-form" novalidate>
      <header class="flex items-center justify-between border-b border-slate-200/80 px-6 py-4 dark:border-slate-800/80">
        <div>
          <h3 id="of-title" class="text-base font-semibold">Adicionar conexão do Meu Pluggy</h3>
          <p class="text-xs text-slate-500 dark:text-slate-400">Seus dados bancários reais, de forma segura</p>
        </div>
        <button type="button" class="btn-icon" data-close aria-label="Fechar">${icon('x')}</button>
      </header>
      <div class="space-y-4 px-6 py-5">
        <div class="rounded-xl bg-slate-100/70 p-4 dark:bg-slate-950/50">${OF_STEPS}</div>
        <div>
          <label for="of-item-id" class="field-label">Item ID</label>
          <input id="of-item-id" class="input font-mono text-sm" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off" spellcheck="false" />
          <p id="of-add-error" class="mt-1 hidden text-xs text-rose-500"></p>
        </div>
        <p class="flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">${icon('shield-check', 'mt-px h-3.5 w-3.5 shrink-0')}O app só <strong>lê</strong> dados (saldos, cartões e transações dos últimos 12 meses). Ele não faz pagamentos nem transferências.</p>
        <div id="of-progress" class="hidden"></div>
      </div>
      <footer class="flex justify-end gap-2 border-t border-slate-200/80 px-6 py-4 dark:border-slate-800/80">
        <button type="button" class="btn-ghost" data-close>Cancelar</button>
        <button type="submit" class="btn-primary" id="of-add-submit">${icon('link')}Conectar e importar</button>
      </footer>
    </form>`;
  modal.showModal();
  setTimeout(() => $('#of-item-id').focus(), 50);
  $('#of-add-form').addEventListener('submit', submitAddConnection);
}

async function submitAddConnection(e) {
  e.preventDefault();
  const itemId = $('#of-item-id').value.trim();
  const err = $('#of-add-error');
  const showErr = (m) => { err.textContent = m; err.classList.toggle('hidden', !m); $('#of-item-id').classList.toggle('input-error', Boolean(m)); };
  if (!openFinance.isUuid(itemId)) return showErr('O Item ID tem o formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (copie do Dashboard da Pluggy).');
  showErr('');
  const btn = $('#of-add-submit');
  btn.disabled = true;
  btn.innerHTML = `${icon('loader-circle', 'h-4 w-4 animate-spin')}Importando…`;
  const prog = $('#of-progress');
  prog.classList.remove('hidden');
  prog.innerHTML = `<p class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">${icon('loader-circle', 'h-3.5 w-3.5 animate-spin')}Validando na Pluggy e buscando até 12 meses de transações… pode levar até 1 minuto.</p>`;
  try {
    const res = await openFinance.addItem(itemId);
    await reloadBankData();
    $('#of-modal').close();
    const r = res.result || {};
    toast(`${r.institution || 'Banco'} conectado · ${r.accounts || 0} conta(s) · ${r.imported || 0} transações importadas`, 'success');
    if (r.error) toast(r.error, 'error');
  } catch (ex) {
    showErr(ex.message);
    prog.classList.add('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon('link')}Conectar e importar`;
  }
}

/** Recarrega conexões, contas e transações do banco depois de uma sincronização. */
async function reloadBankData() {
  const [transactions, connections, bankAccounts] = await Promise.all([
    repo.fetchTransactions(), repo.fetchConnections(), repo.fetchBankAccounts(),
  ]);
  Object.assign(state, { transactions, connections, bankAccounts });
  renderAll();
}

async function runSync(connectionId, { silent = false } = {}) {
  const ids = connectionId ? [connectionId] : state.connections.filter((c) => c.externalItemId).map((c) => c.id);
  ids.forEach((id) => state.busy.add(id));
  renderOpenFinance();
  try {
    const res = await openFinance.sync(connectionId);
    await reloadBankData();
    const results = res.results || [];
    const errors = results.filter((r) => r.error);
    if (!silent || errors.length) {
      const total = sum(results, (r) => r.imported || 0);
      if (!silent) toast(`Sincronizado · ${total} transações conferidas`, 'success');
      errors.forEach((r) => toast(`${r.institution || 'Banco'}: ${r.error}`, 'error'));
    }
  } catch (err) {
    toast(`Não foi possível sincronizar: ${err.message}`, 'error');
  } finally {
    ids.forEach((id) => state.busy.delete(id));
    renderOpenFinance();
  }
}

/** Ao entrar: se a última sincronização tem mais de 12 h, atualiza em segundo plano. */
async function autoSyncIfStale() {
  const conns = state.connections.filter((c) => c.externalItemId);
  if (!conns.length || !ofReady()) return;
  const stale = conns.some((c) => !c.lastSyncAt || Date.now() - new Date(c.lastSyncAt).getTime() > 12 * 3600 * 1000);
  if (stale) await runSync(null, { silent: true });
}

async function removeConnection(id) {
  const conn = state.connections.find((c) => c.id === id);
  if (!conn || !window.confirm(`Remover a conexão "${conn.institution || 'Banco'}" do app?\n\n(Isso não revoga a autorização no Meu Pluggy — para isso, use o meu.pluggy.ai.)`)) return;
  const imported = state.transactions.filter((t) => t.accountId === conn.id).map((t) => t.id);
  const removeToo = imported.length > 0 && window.confirm(`Excluir também as ${imported.length} transações importadas desse banco?\n\nOK = excluir · Cancelar = manter no histórico`);
  const ok = await persist(async () => {
    if (removeToo) await repo.deleteTransactions(imported);
    await repo.deleteConnection(conn.id); // contas desse banco saem junto (cascade)
    return true;
  });
  if (!ok) return;
  if (removeToo) state.transactions = state.transactions.filter((t) => !imported.includes(t.id));
  else state.transactions = state.transactions.map((t) => (t.accountId === conn.id ? { ...t, accountId: null } : t));
  state.connections = state.connections.filter((c) => c.id !== conn.id);
  state.bankAccounts = state.bankAccounts.filter((a) => a.connectionId !== conn.id);
  toast(removeToo ? 'Conexão e transações removidas' : 'Conexão removida', 'info');
  renderAll();
}

// ------------------------------------------------------------------ modal de transação
let txKind = 'expense';
let paidTouched = false;

function categoryOptions(kind, selected) {
  const list = categoriesByType(kind);
  const builtin = list.filter((c) => c.builtin);
  const custom = list.filter((c) => !c.builtin);
  const opt = (c) => `<option value="${c.key}" ${c.key === selected ? 'selected' : ''}>${escapeHTML(c.label)}</option>`;
  return `${custom.length ? `<optgroup label="Minhas categorias">${custom.map(opt).join('')}</optgroup>` : ''}<optgroup label="Padrão">${builtin.map(opt).join('')}</optgroup>`;
}

function setTxKind(kind, keepCategory) {
  txKind = kind;
  $$('#tx-modal .segmented button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
  const sel = $('#tx-category');
  sel.innerHTML = categoryOptions(kind, keepCategory);
  if (!keepCategory || !categoriesByType(kind).some((c) => c.key === keepCategory)) {
    sel.value = kind === 'income' ? 'trabalho' : 'alimentacao';
  }
  $('#tx-repeat').querySelector('[value="installments"]').disabled = kind === 'income';
  if (kind === 'income' && $('#tx-repeat').value === 'installments') $('#tx-repeat').value = 'none';
  $('#tx-kind-wrap').classList.toggle('invisible', kind === 'income');
  updateRepeatUI();
}

/** Liga/desliga "pago" automaticamente pela data, até a pessoa mexer no botão. */
function syncPaidDefault() {
  const date = $('#tx-date').value;
  if (!paidTouched) $('#tx-paid').checked = !(date && date > state.today);
  const income = txKind === 'income';
  const paid = $('#tx-paid').checked;
  $('#tx-paid-label').textContent = income ? (paid ? 'Já recebi' : 'A receber') : (paid ? 'Já foi pago' : 'A pagar (agendado)');
  $('#tx-paid-hint').textContent = paid
    ? 'Entra no saldo atual.'
    : 'Fica em "Próximos vencimentos" até você marcar como pago.';
}

function updateRepeatUI() {
  const rep = $('#tx-repeat').value;
  const series = rep === 'series';
  $('#tx-series-wrap').classList.toggle('hidden', !series);
  $('#tx-installments-wrap').classList.toggle('hidden', rep !== 'installments');
  const dur = $('#tx-duration').value;
  $('#tx-count-wrap').classList.toggle('hidden', !series || dur !== 'count');
  $('#tx-until-wrap').classList.toggle('hidden', !series || dur !== 'until');
  $('#tx-amount-label').textContent = rep === 'installments' ? 'Valor de cada parcela' : series ? 'Valor de cada vez' : 'Valor';
  $('#tx-date-label').textContent = series ? '1ª data' : rep === 'installments' ? '1ª parcela' : 'Data';
  syncPaidDefault();

  const hint = $('#tx-repeat-hint');
  const date = $('#tx-date').value;
  const amount = parseMoney($('#tx-amount').value);
  const val = Number.isFinite(amount) ? fmt(amount) : 'R$ —';
  let text = '';
  if (series && date) {
    const freq = $('#tx-frequency').value;
    const rule = {
      frequency: freq, startDate: date, day: dayOf(date), startMonth: ymOf(date),
      occurrences: dur === 'count' ? Number($('#tx-count').value) || null : null,
      endDate: dur === 'until' ? $('#tx-until').value || null : null,
    };
    const next = occurrencesBetween(rule, date, '9999-12-31').slice(0, 3).map((o) => shortDate(o.date)).join(', ');
    const n = dur === 'count' ? rule.occurrences : dur === 'until' && rule.endDate ? occurrencesBetween(rule, date, rule.endDate).length : null;
    text = `${val} ${ruleSummary(rule)}. Próximas: ${next}${n ? ` · total ${fmt((Number.isFinite(amount) ? amount : 0) * n)} em ${n}x` : ''}.`;
  }
  if (rep === 'installments') {
    const n = Number($('#tx-installments').value) || 0;
    text = `${n || '—'}x de ${val}${Number.isFinite(amount) && n ? ` = ${fmt(amount * n)}` : ''}, uma por mês. As futuras ficam como "a pagar".`;
  }
  hint.textContent = text;
  hint.classList.toggle('hidden', !text);
}

// ---- itens da compra
function itemRow(it = { name: '', qty: 1, price: '' }) {
  return `<div class="tx-item grid grid-cols-[1fr_4rem_6rem_2rem] gap-2">
    <input class="input px-2.5 py-2 text-sm" data-f="name" maxlength="60" placeholder="Ex.: Arroz" value="${escapeHTML(it.name)}" />
    <input class="input px-2 py-2 text-sm tabular-nums" data-f="qty" inputmode="decimal" value="${escapeHTML(String(it.qty).replace('.', ','))}" />
    <input class="input px-2 py-2 text-sm tabular-nums" data-f="price" inputmode="decimal" placeholder="0,00" value="${it.price === '' ? '' : escapeHTML(String(it.price).replace('.', ','))}" />
    <button type="button" class="btn-icon h-9 w-8" data-remove-item aria-label="Remover item">${icon('minus', 'h-4 w-4')}</button>
  </div>`;
}

function readItems() {
  return $$('#tx-items .tx-item').map((row) => ({
    name: row.querySelector('[data-f="name"]').value.trim(),
    qty: parseMoney(row.querySelector('[data-f="qty"]').value),
    price: parseMoney(row.querySelector('[data-f="price"]').value),
  })).filter((it) => it.name || Number.isFinite(it.price));
}

function updateItemsUI() {
  const items = readItems();
  const valid = items.filter((it) => it.name && it.qty > 0 && it.price >= 0);
  const total = sum(valid, (it) => it.qty * it.price);
  $('#tx-items-total').textContent = fmt(total);
  $('#tx-items-count').textContent = valid.length ? `${valid.length} ${valid.length === 1 ? 'item' : 'itens'} · ${fmt(total)}` : '';
  const auto = $('#tx-items-sum').checked && valid.length > 0;
  $('#tx-amount').readOnly = auto;
  $('#tx-amount').classList.toggle('opacity-70', auto);
  if (auto) $('#tx-amount').value = total.toFixed(2).replace('.', ',');
  updateRepeatUI();
}

function openTxModal() {
  $('#tx-form').reset();
  paidTouched = false;
  $$('#tx-form [data-err]').forEach((e) => e.classList.add('hidden'));
  $$('#tx-form .input-error').forEach((e) => e.classList.remove('input-error'));
  $('#tx-items').innerHTML = '';
  $('#tx-items-box').open = false;
  $('#tx-amount').readOnly = false;
  $('#tx-amount').classList.remove('opacity-70');
  $('#tx-items-count').textContent = '';
  $('#tx-items-total').textContent = fmt(0);
  $('#tx-date').value = state.selectedYM === currentYM() ? state.today : dateWithDay(state.selectedYM, dayOf(state.today));
  setTxKind('expense');
  $('#tx-modal').showModal();
  setTimeout(() => $('#tx-amount').focus(), 50);
}

function fieldError(name, show, root = '#tx-form') {
  $(`${root} [data-err="${name}"]`)?.classList.toggle('hidden', !show);
  const input = $(`${root} [name="${name}"]`) || $(`#tx-${name}`);
  input?.classList.toggle('input-error', show);
  return show;
}

async function submitTx(e) {
  e.preventDefault();
  const items = readItems();
  const itemsValid = items.filter((it) => it.name && it.qty > 0 && it.price >= 0).map((it) => ({ name: it.name, qty: it.qty, price: it.price }));
  const amount = parseMoney($('#tx-amount').value);
  const description = $('#tx-desc').value.trim();
  const date = $('#tx-date').value;
  const category = $('#tx-category').value;
  const repeat = $('#tx-repeat').value;
  const paid = $('#tx-paid').checked;
  const n = Math.floor(Number($('#tx-installments').value));
  const dur = $('#tx-duration').value;
  const count = Math.floor(Number($('#tx-count').value));
  const until = $('#tx-until').value;

  let bad = false;
  bad = fieldError('amount', !(amount > 0 && amount < 1e10)) || bad;
  bad = fieldError('description', !description) || bad;
  bad = fieldError('date', !/^\d{4}-\d{2}-\d{2}$/.test(date)) || bad;
  if (repeat === 'installments') bad = fieldError('installments', !(n >= 2 && n <= 48)) || bad;
  if (repeat === 'series' && dur === 'count') bad = fieldError('count', !(count >= 2 && count <= 600)) || bad;
  if (repeat === 'series' && dur === 'until') bad = fieldError('until', !(until && until > date)) || bad;
  if (bad) return;

  const btn = $('#tx-submit');
  btn.disabled = true;
  try {
    const base = {
      description, amount, date, category, type: txKind, source: 'manual', status: paid ? 'paid' : 'pending',
      recurringId: null, installment: null, externalId: null, accountId: null, items: itemsValid.length ? itemsValid : null,
    };
    if (repeat === 'installments') {
      const groupId = uid();
      const list = Array.from({ length: n }, (_, i) => {
        const d = dateWithDay(addMonths(ymOf(date), i), dayOf(date));
        // 1ª parcela segue o botão "pago"; as futuras ficam a pagar.
        return { ...base, id: uid(), date: d, status: i === 0 ? base.status : 'pending', items: i === 0 ? base.items : null, installment: { current: i + 1, total: n, groupId } };
      });
      state.transactions.push(...(await repo.saveTransactions(list)));
      toast(`Parcelamento criado: ${n}x de ${fmt(amount)}`, 'success');
    } else if (repeat === 'series') {
      const freq = $('#tx-frequency').value;
      const rule = {
        id: uid(), description, amount, type: txKind, category, kind: txKind === 'income' ? 'fixed' : $('#tx-kind').value,
        frequency: freq, startDate: date, day: dayOf(date), startMonth: ymOf(date), endMonth: null,
        occurrences: dur === 'count' ? count : null, endDate: dur === 'until' ? until : null, active: true,
      };
      await repo.saveRecurring(rule);
      state.recurring.push(rule);
      // Se a 1ª já foi paga, registra o lançamento real; senão ela aparece como "a pagar".
      if (paid) state.transactions.push(await repo.saveTransaction({ ...base, id: uid(), recurringId: rule.id }));
      toast(`Série criada: ${FREQ_LABEL[freq].toLowerCase()}, ${ruleSummary(rule)}`, 'success');
    } else {
      state.transactions.push(await repo.saveTransaction({ ...base, id: uid() }));
      toast(paid
        ? `${txKind === 'income' ? 'Entrada' : 'Saída'} de ${fmt(amount)} registrada`
        : `Agendado para ${shortDate(date)} — aparece em Próximos vencimentos`, 'success');
    }
    $('#tx-modal').close();
    if (ymOf(date) !== state.selectedYM) state.selectedYM = ymOf(date);
    renderAll();
  } catch (err) {
    console.error(err);
    toast(`Não foi salvo: ${err.message || 'tente novamente'}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ categorias personalizadas
const catForm = { editing: null, type: 'expense', color: 'pink', icon: 'paw-print', returnToTx: false };

function colorPicker(container, selected, onPick) {
  container.innerHTML = Object.entries(COLORS).map(([k, c]) => `<button type="button" data-color="${k}" title="${k}" aria-label="Cor ${k}" aria-pressed="${k === selected}"
    class="h-7 w-7 rounded-full ${c.dot} ring-offset-2 ring-offset-white transition-transform duration-200 hover:scale-110 dark:ring-offset-slate-900 ${k === selected ? 'ring-2 ring-slate-900 dark:ring-white' : ''}"></button>`).join('');
  container.onclick = (e) => { const b = e.target.closest('[data-color]'); if (b) onPick(b.dataset.color); };
}

function iconPicker(container, selected, colorKey, onPick) {
  const badge = COLORS[colorKey]?.badge || COLORS.slate.badge;
  container.innerHTML = PICKABLE_ICONS.map((n) => `<button type="button" data-pick-icon="${n}" aria-label="Ícone ${n}" aria-pressed="${n === selected}"
    class="grid aspect-square place-items-center rounded-lg transition-all duration-200 ${n === selected ? `ring-2 ring-inset ${badge}` : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'}">${icon(n, 'h-4 w-4')}</button>`).join('');
  container.onclick = (e) => { const b = e.target.closest('[data-pick-icon]'); if (b) onPick(b.dataset.pickIcon); };
}

function renderCatForm() {
  $$('#cat-type button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === catForm.type)));
  colorPicker($('#cat-colors'), catForm.color, (c) => { catForm.color = c; renderCatForm(); });
  iconPicker($('#cat-icons'), catForm.icon, catForm.color, (i) => { catForm.icon = i; renderCatForm(); });
  const label = $('#cat-label').value.trim() || 'Prévia';
  $('#cat-preview').innerHTML = `<span class="badge gap-1.5 px-2 py-1 ring-inset ${COLORS[catForm.color].badge}">${icon(catForm.icon, 'h-3.5 w-3.5')}${escapeHTML(label)}</span>`;
  $('#cat-form-title').textContent = catForm.editing ? 'Editar categoria' : 'Nova categoria';
  $('#cat-submit').lastChild.textContent = catForm.editing ? 'Salvar alterações' : 'Criar categoria';
  $('#cat-cancel-edit').classList.toggle('hidden', !catForm.editing);
}

function renderCatList() {
  const custom = state.categories;
  const used = (id) => state.transactions.filter((t) => t.category === id).length + state.recurring.filter((r) => r.category === id).length;
  $('#cat-list').innerHTML = custom.length
    ? custom.map((c) => {
      const col = COLORS[c.color] || COLORS.slate;
      const n = used(c.id);
      return `<li class="group flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-slate-100/70 dark:hover:bg-slate-800/40">
        <span class="grid h-8 w-8 place-items-center rounded-lg ring-1 ring-inset ${col.badge}">${icon(c.icon, 'h-4 w-4')}</span>
        <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">${escapeHTML(c.label)}</span>
          <span class="text-[11px] text-slate-500 dark:text-slate-400">${c.type === 'income' ? 'Entrada' : 'Saída'} · ${n} ${n === 1 ? 'uso' : 'usos'}</span></span>
        <button type="button" class="btn-icon h-8 w-8" data-edit-cat="${c.id}" aria-label="Editar ${escapeHTML(c.label)}">${icon('pencil', 'h-4 w-4')}</button>
        <button type="button" class="btn-icon h-8 w-8" data-del-cat="${c.id}" aria-label="Excluir ${escapeHTML(c.label)}">${icon('trash-2', 'h-4 w-4')}</button>
      </li>`;
    }).join('')
    : '<li class="rounded-xl border border-dashed border-slate-300/70 px-4 py-5 text-center text-xs text-slate-500 dark:border-slate-700/70 dark:text-slate-400">Você ainda não criou categorias. As padrão continuam disponíveis.</li>';
}

function openCategoryModal({ type = 'expense', returnToTx = false } = {}) {
  Object.assign(catForm, { editing: null, type, color: 'pink', icon: 'tag', returnToTx });
  $('#cat-label').value = '';
  fieldError('cat-label', false, '#cat-form');
  renderCatForm();
  renderCatList();
  $('#cat-modal').showModal();
  setTimeout(() => $('#cat-label').focus(), 50);
}

async function submitCategory(e) {
  e.preventDefault();
  return withLock('category', $('#cat-submit'), () => saveCategoryForm());
}

async function saveCategoryForm() {
  const label = $('#cat-label').value.trim();
  const dup = Object.entries(CATEGORIES).some(([k, c]) => k !== catForm.editing && c.type === catForm.type && c.label.toLowerCase() === label.toLowerCase());
  const invalid = !label || label.length > 30 || dup;
  $('#cat-form [data-err="cat-label"]').classList.toggle('hidden', !invalid);
  $('#cat-label').classList.toggle('input-error', invalid);
  if (invalid) return;
  const cat = { id: catForm.editing || newCategoryId(), label, type: catForm.type, icon: catForm.icon, color: catForm.color };
  const ok = await persist(() => repo.saveCategory(cat));
  if (!ok) return;
  state.categories = [...state.categories.filter((c) => c.id !== cat.id), cat];
  setCustomCategories(state.categories);
  toast(catForm.editing ? 'Categoria atualizada' : `Categoria "${label}" criada`, 'success');
  if (catForm.returnToTx) {
    $('#cat-modal').close();
    if (txKind !== cat.type) setTxKind(cat.type, cat.id);
    else { $('#tx-category').innerHTML = categoryOptions(txKind, cat.id); $('#tx-category').value = cat.id; }
  } else {
    catForm.editing = null;
    $('#cat-label').value = '';
    renderCatForm();
    renderCatList();
  }
  renderAll();
}

async function deleteCategory(id) {
  const c = state.categories.find((x) => x.id === id);
  if (!c) return;
  const n = state.transactions.filter((t) => t.category === id).length;
  if (!window.confirm(`Excluir a categoria "${c.label}"?${n ? `\n\n${n} transações usam essa categoria — elas continuam salvas e passam a aparecer como "Sem categoria".` : ''}`)) return;
  if (!(await persist(() => repo.deleteCategory(id)))) return;
  state.categories = state.categories.filter((x) => x.id !== id);
  setCustomCategories(state.categories);
  renderCatList();
  renderAll();
  toast('Categoria excluída', 'info');
}

// ------------------------------------------------------------------ metas
const STATUS_INFO = {
  ok: { label: 'No ritmo', cls: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/30 dark:text-emerald-300' },
  tight: { label: 'Apertado', cls: 'bg-amber-500/10 text-amber-700 ring-amber-500/30 dark:text-amber-300' },
  hard: { label: 'Precisa de ajuste', cls: 'bg-rose-500/10 text-rose-600 ring-rose-500/30 dark:text-rose-300' },
  expired: { label: 'Prazo vencido', cls: 'bg-rose-500/10 text-rose-600 ring-rose-500/30 dark:text-rose-300' },
  done: { label: 'Concluída', cls: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/30 dark:text-emerald-300' },
};

const monthsText = (m) => (m < 12 ? `${m} ${m === 1 ? 'mês' : 'meses'}` : `${Math.floor(m / 12)} ano${m >= 24 ? 's' : ''}${m % 12 ? ` e ${m % 12} ${m % 12 === 1 ? 'mês' : 'meses'}` : ''}`);

function goalEtaLine(a) {
  if (a.remaining === 0) return '🎉 Meta alcançada!';
  if (!Number.isFinite(a.months)) return a.contribution > 0 ? 'Com esse ritmo, levaria mais de 100 anos.' : 'Sem sobra mensal no momento — defina quanto vai guardar.';
  const src = a.contributionSource !== 'surplus' ? '' : a.sharedWith > 0 ? ` (sua parte da sobra, dividida com ${a.sharedWith} outra${a.sharedWith > 1 ? 's' : ''} meta${a.sharedWith > 1 ? 's' : ''})` : ' (sua sobra média)';
  return `Guardando <strong>${fmt(a.contribution)}/mês</strong>${src}, chega em <strong>${monthsText(a.months)}</strong> · ${monthLabel(a.eta).toLowerCase()}`;
}

function renderGoals() {
  const box = $('#goals-list');
  const surplus = state.goals.length ? analyzeGoal(state.goals[0], state).surplus : null;
  $('#goals-sub').innerHTML = surplus?.hasHistory
    ? `Sua sobra média nos últimos ${surplus.months.length} meses: <strong class="${surplus.avg >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-300'}">${fmt(surplus.avg)}/mês</strong>`
    : 'Quanto guardar e em quanto tempo você chega lá';
  if (!state.goals.length) {
    box.innerHTML = `<div class="md:col-span-2 xl:col-span-3">${emptyState({ iconName: 'target', title: 'Crie sua primeira meta', text: 'Diga quanto quer juntar e até quando. O app calcula quanto guardar por mês e em quanto tempo você chega lá, com base no que realmente sobra no seu mês.' })}
      <div class="-mt-6 flex justify-center pb-4"><button type="button" class="btn-primary" data-new-goal>${icon('plus')}Nova meta</button></div></div>`;
    return;
  }
  box.innerHTML = state.goals.map((g, idx) => {
    const a = analyzeGoal(g, state, { otherGoals: state.goals });
    const col = COLORS[g.color] || COLORS.indigo;
    const st = a.remaining === 0 ? STATUS_INFO.done : a.deadline ? STATUS_INFO[a.deadline.status] : null;
    const lateWithPlan = a.deadline && a.eta && g.targetDate && a.eta > ymOf(g.targetDate) && a.remaining > 0;
    return `<article class="glass-hover animate-fade-up rounded-2xl border border-slate-200/80 bg-white/50 p-4 transition-all duration-300 dark:border-slate-800/80 dark:bg-slate-950/30" style="animation-delay:${idx * 50}ms">
      <div class="flex items-start gap-3">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset ${col.badge}">${icon(g.icon || 'target', 'h-5 w-5')}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-start justify-between gap-2">
            <p class="truncate text-sm font-semibold">${escapeHTML(g.name)}</p>
            ${st ? `<span class="badge shrink-0 ${st.cls}">${st.label}</span>` : ''}
          </div>
          <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400"><span class="font-semibold text-slate-900 tabular-nums dark:text-white">${fmt(a.saved)}</span> de ${fmt(a.target)}${g.targetDate ? ` · até ${g.targetDate.split('-').reverse().join('/')}` : ''}</p>
        </div>
      </div>
      <div class="mt-3 h-2 overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-800"><div class="h-full rounded-full transition-all duration-700" style="width:${Math.max(2, a.progress).toFixed(1)}%;background:${col.hex}"></div></div>
      <div class="mt-1 flex justify-between text-[11px] text-slate-500 dark:text-slate-400"><span>${a.progress.toFixed(0)}%</span><span>faltam ${fmt(a.remaining)}</span></div>
      <p class="mt-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300">${goalEtaLine(a)}</p>
      ${a.deadline && a.deadline.needed != null && a.remaining > 0 ? `<p class="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">Para chegar no prazo: <strong>${fmt(a.deadline.needed)}/mês</strong>${a.deadline.pctOfSurplus != null ? ` (${Math.round(a.deadline.pctOfSurplus)}% do que sobra para ela)` : ''}</p>` : ''}
      ${lateWithPlan ? `<p class="mt-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-800 dark:text-amber-200">${icon('triangle-alert', 'mr-1 inline h-3 w-3')}No ritmo atual você passa do prazo.</p>` : ''}
      <div class="mt-3 flex gap-2">
        <button type="button" class="btn-ghost flex-1 py-1.5 text-xs" data-deposit-goal="${g.id}">${icon('piggy-bank', 'h-3.5 w-3.5')}Guardar</button>
        <button type="button" class="btn-ghost flex-1 py-1.5 text-xs" data-edit-goal="${g.id}">${icon('calculator', 'h-3.5 w-3.5')}Simular</button>
      </div>
    </article>`;
  }).join('');
}

const goalForm = { editing: null, color: 'indigo', icon: 'target' };
const goalIcons = ['target', 'piggy-bank', 'house', 'car', 'plane', 'graduation-cap', 'heart-pulse', 'baby', 'smartphone', 'laptop', 'gift', 'trophy', 'flag', 'shield-check', 'briefcase', 'bike', 'paw-print', 'party-popper', 'store', 'banknote'];

function readGoalForm() {
  const num = (sel) => { const v = $(sel).value.trim(); return v === '' ? null : parseMoney(v); };
  return {
    name: $('#g-name').value.trim(),
    targetAmount: num('#g-target'),
    savedAmount: num('#g-saved') ?? 0,
    targetDate: $('#g-date').value || null,
    monthlyContribution: num('#g-monthly'),
    annualRate: num('#g-rate') ?? 0,
    icon: goalForm.icon,
    color: goalForm.color,
  };
}

function renderGoalPickers() {
  colorPicker($('#g-colors'), goalForm.color, (c) => { goalForm.color = c; renderGoalPickers(); });
  const badge = COLORS[goalForm.color].badge;
  const c = $('#g-icons');
  c.innerHTML = goalIcons.map((n) => `<button type="button" data-pick-icon="${n}" aria-label="Ícone ${n}" aria-pressed="${n === goalForm.icon}" class="grid aspect-square place-items-center rounded-lg transition-all duration-200 ${n === goalForm.icon ? `ring-2 ring-inset ${badge}` : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'}">${icon(n, 'h-4 w-4')}</button>`).join('');
  c.onclick = (e) => { const b = e.target.closest('[data-pick-icon]'); if (b) { goalForm.icon = b.dataset.pickIcon; renderGoalPickers(); } };
}

function renderGoalSim() {
  const g = readGoalForm();
  const box = $('#goal-sim');
  const surplus = analyzeGoal({ targetAmount: 1, savedAmount: 0, annualRate: 0 }, state).surplus;
  $('#g-monthly').placeholder = surplus.avg > 0 ? `Vazio = usar sua sobra média (${fmt(surplus.avg)})` : '0,00';
  $('#g-monthly-hint').textContent = surplus.hasHistory
    ? `Sua sobra média real (últimos ${surplus.months.length} meses): ${fmt(surplus.avg)}/mês.`
    : 'Ainda não há meses completos registrados para calcular sua sobra.';
  if (!(g.targetAmount > 0)) {
    box.innerHTML = `<div class="grid h-full place-items-center rounded-2xl border border-dashed border-slate-300/70 p-6 text-center text-xs text-slate-500 dark:border-slate-700/70 dark:text-slate-400">${icon('calculator', 'mx-auto mb-2 h-6 w-6 text-indigo-500')}Preencha quanto quer juntar para ver a simulação.</div>`;
    return;
  }
  const a = analyzeGoal({ ...g, id: goalForm.editing || '__new__' }, state, { otherGoals: state.goals });
  const card = (title, value, sub = '', cls = '') => `<div class="rounded-xl border border-slate-200/80 p-3 dark:border-slate-800/80 ${cls}"><p class="text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">${title}</p><p class="mt-1 text-lg font-bold tabular-nums">${value}</p>${sub ? `<p class="text-xs text-slate-500 dark:text-slate-400">${sub}</p>` : ''}</div>`;
  const st = a.deadline ? STATUS_INFO[a.deadline.status] : null;
  box.innerHTML = `
    <div class="rounded-2xl bg-gradient-to-br from-indigo-500/10 to-violet-500/10 p-4 ring-1 ring-inset ring-indigo-500/20">
      <p class="text-xs font-medium text-indigo-700 dark:text-indigo-300">Resultado da simulação</p>
      <p class="mt-1 text-sm leading-relaxed">${goalEtaLine(a)}</p>
      ${a.interest > 0 ? `<p class="mt-1 text-xs text-slate-600 dark:text-slate-300">Os rendimentos colaboram com cerca de <strong>${fmt(a.interest)}</strong>.</p>` : ''}
    </div>
    <div class="grid grid-cols-2 gap-2">
      ${card('Falta juntar', fmt(a.remaining), `${a.progress.toFixed(0)}% concluído`)}
      ${a.deadline && a.deadline.needed != null
        ? card('Por mês até o prazo', fmt(a.deadline.needed), `${monthsText(a.deadline.months)} até a data${st ? ` · <span class="font-semibold">${st.label}</span>` : ''}`)
        : a.deadline ? card('Prazo', '—', 'Escolha uma data a pelo menos 1 mês de hoje') : card('Sem prazo', '—', 'Defina uma data para saber quanto guardar por mês')}
    </div>
    ${a.tips.length ? `<div class="rounded-xl border border-slate-200/80 p-3 dark:border-slate-800/80"><p class="mb-1.5 flex items-center gap-1.5 text-xs font-semibold">${icon('lightbulb', 'h-3.5 w-3.5 text-amber-500')}Sugestões</p><ul class="space-y-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">${a.tips.map((t) => `<li class="flex gap-1.5"><span class="text-indigo-500">•</span><span>${escapeHTML(t)}</span></li>`).join('')}</ul></div>` : ''}
    <p class="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">Cálculo com juros compostos mensais. É uma estimativa para planejamento, não uma recomendação de investimento.</p>`;
}

function openGoalModal(id = null) {
  const g = id ? state.goals.find((x) => x.id === id) : null;
  goalForm.editing = g?.id || null;
  goalForm.color = g?.color || 'indigo';
  goalForm.icon = g?.icon || 'target';
  const money = (v) => (v == null ? '' : Number(v).toFixed(2).replace('.', ','));
  $('#g-name').value = g?.name || '';
  $('#g-target').value = money(g?.targetAmount);
  $('#g-saved').value = money(g?.savedAmount);
  $('#g-date').value = g?.targetDate || '';
  $('#g-monthly').value = money(g?.monthlyContribution);
  $('#g-rate').value = g?.annualRate ? String(g.annualRate).replace('.', ',') : '';
  $('#goal-title').textContent = g ? g.name : 'Nova meta';
  $('#goal-delete').classList.toggle('hidden', !g);
  $$('#goal-form [data-err]').forEach((e) => e.classList.add('hidden'));
  renderGoalPickers();
  renderGoalSim();
  $('#goal-modal').showModal();
  if (!g) setTimeout(() => $('#g-name').focus(), 50);
}

async function submitGoal(e) {
  e.preventDefault();
  return withLock('goal', $('#goal-form button[type=submit]'), () => saveGoalForm());
}

async function saveGoalForm() {
  const g = readGoalForm();
  const err = (k, v) => { $(`#goal-form [data-err="${k}"]`).classList.toggle('hidden', !v); return v; };
  let bad = false;
  bad = err('g-name', !g.name) || bad;
  bad = err('g-target', !(g.targetAmount > 0)) || bad;
  bad = err('g-date', Boolean(g.targetDate && g.targetDate <= state.today)) || bad;
  if (bad || !Number.isFinite(g.savedAmount) || g.savedAmount < 0 || !Number.isFinite(g.annualRate) || g.annualRate < 0 || g.annualRate > 100) {
    if (!bad) toast('Confira os valores: "já tem" e rendimento precisam ser números válidos (rendimento até 100%).', 'error');
    return;
  }
  const goal = { ...(state.goals.find((x) => x.id === goalForm.editing) || {}), ...g, id: goalForm.editing || uid() };
  if (!(await persist(() => repo.saveGoal(goal)))) return;
  state.goals = [...state.goals.filter((x) => x.id !== goal.id), goal];
  $('#goal-modal').close();
  toast(goalForm.editing ? 'Meta atualizada' : 'Meta criada', 'success');
  renderGoals();
}

async function removeGoal() {
  const g = state.goals.find((x) => x.id === goalForm.editing);
  if (!g || !window.confirm(`Excluir a meta "${g.name}"?`)) return;
  if (!(await persist(() => repo.deleteGoal(g.id)))) return;
  state.goals = state.goals.filter((x) => x.id !== g.id);
  $('#goal-modal').close();
  toast('Meta excluída', 'info');
  renderGoals();
}

let depositGoalId = null;
let depositMode = 'add';
function openDeposit(id) {
  const g = state.goals.find((x) => x.id === id);
  if (!g) return;
  depositGoalId = id;
  depositMode = 'add';
  $('#deposit-form').reset();
  $$('#deposit-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === 'add')));
  $('#deposit-sub').textContent = `${g.name} · ${fmt(g.savedAmount)} de ${fmt(g.targetAmount)}`;
  $('#deposit-form [data-err]').classList.add('hidden');
  $('#deposit-modal').showModal();
  setTimeout(() => $('#deposit-amount').focus(), 50);
}

async function submitDeposit(e) {
  e.preventDefault();
  return withLock('deposit', $('#deposit-form button[type=submit]'), () => saveDeposit());
}

async function saveDeposit() {
  const g = state.goals.find((x) => x.id === depositGoalId);
  const v = parseMoney($('#deposit-amount').value);
  const invalid = !g || !(v > 0) || (depositMode === 'withdraw' && v > g.savedAmount);
  $('#deposit-form [data-err]').textContent = depositMode === 'withdraw' && g && v > g.savedAmount ? `Você só tem ${fmt(g.savedAmount)} nessa meta.` : 'Valor inválido.';
  $('#deposit-form [data-err]').classList.toggle('hidden', !invalid);
  if (invalid) return;
  const updated = { ...g, savedAmount: Math.round((g.savedAmount + (depositMode === 'add' ? v : -v)) * 100) / 100 };
  if (!(await persist(() => repo.saveGoal(updated)))) return;
  state.goals = state.goals.map((x) => (x.id === g.id ? updated : x));
  if ($('#deposit-register').checked) {
    const tx = {
      id: uid(), description: `${depositMode === 'add' ? 'Guardado' : 'Resgate'}: ${g.name}`, amount: v, date: state.today,
      type: depositMode === 'add' ? 'expense' : 'income', category: depositMode === 'add' ? 'reserva' : 'outras_receitas',
      source: 'manual', status: 'paid', recurringId: null, installment: null, externalId: null, accountId: null, items: null,
    };
    const saved = await persist(() => repo.saveTransaction(tx));
    if (saved) state.transactions.push(saved);
  }
  $('#deposit-modal').close();
  toast(depositMode === 'add' ? `${fmt(v)} guardados em "${g.name}"` : `${fmt(v)} retirados de "${g.name}"`, 'success');
  renderAll();
}

// ------------------------------------------------------------------ configurações
const moneyInput = (v) => String(v.toFixed(2)).replace('.', ',');

function openSettings() {
  const cloud = repo.getRepositoryStatus().backend === 'supabase';
  $('#settings-cloud-note').classList.toggle('hidden', !cloud);
  $('#settings-local-tools').classList.toggle('hidden', cloud);
  $('#settings-cloud-tools').classList.toggle('hidden', !cloud);
  $('#s-balance-wrap').classList.toggle('hidden', !bankBalanceInfo());
  $('#s-balance-source').value = getBalanceSource();
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
  const next = { monthlyBudget: budget, openingBalance: neg ? -opening : opening };
  const ok = await persist(() => repo.saveSettings(next));
  if (!ok) return;
  state.settings = next;
  if (bankBalanceInfo()) setBalanceSource($('#s-balance-source').value);
  $('#settings-modal').close();
  toast('Configurações salvas', 'success');
  renderAll();
}

/** Modo nuvem: apaga lançamentos manuais/de demonstração e mantém os do banco. */
async function wipeManualData() {
  const manual = state.transactions.filter((t) => t.source !== 'open_finance');
  const rules = state.recurring;
  if (!manual.length && !rules.length && !state.settings.openingBalance) {
    toast('Não há lançamentos manuais para apagar.', 'info');
    return;
  }
  const typed = window.prompt(`Isso vai apagar ${manual.length} transações manuais, ${rules.length} contas fixas/séries e zerar o saldo inicial.\nO que veio dos bancos, as metas e as categorias continuam.\n\nPara confirmar, digite APAGAR:`);
  if ((typed || '').trim().toUpperCase() !== 'APAGAR') { toast('Nada foi apagado.', 'info'); return; }
  const btn = $('#btn-wipe-manual');
  btn.disabled = true;
  const ok = await persist(async () => {
    await repo.deleteTransactions(manual.map((t) => t.id));
    for (const r of rules) await repo.deleteRecurring(r.id);
    await repo.saveSettings({ ...state.settings, openingBalance: 0 });
    return true;
  });
  btn.disabled = false;
  if (!ok) return;
  await loadAll();
  $('#settings-modal').close();
  toast(`${manual.length} lançamentos manuais apagados. Os dados dos bancos foram mantidos.`, 'success');
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
    const el = e.target.closest('[data-delete],[data-delete-rule],[data-open-new],[data-clear-filters],[data-of-add],[data-of-keys],[data-of-keys-delete],[data-of-retry],[data-of-sync-all],[data-of-sync],[data-of-disconnect],[data-close],[data-pay],[data-toggle-items],[data-edit-cat],[data-del-cat],[data-deposit-goal],[data-edit-goal],[data-new-goal],[data-remove-item]');
    if (!el) return;

    if (el.dataset.pay) { el.disabled = true; await payTx(el.dataset.pay); return; }
    if (el.dataset.toggleItems) {
      const box = $(`#items-${CSS.escape(el.dataset.toggleItems)}`);
      const open = box.classList.toggle('hidden') === false;
      el.setAttribute('aria-expanded', String(open));
      return;
    }
    if (el.hasAttribute('data-remove-item')) { el.closest('.tx-item').remove(); updateItemsUI(); return; }
    if (el.dataset.editCat) {
      const c = state.categories.find((x) => x.id === el.dataset.editCat);
      if (!c) return;
      Object.assign(catForm, { editing: c.id, type: c.type, color: c.color, icon: c.icon });
      $('#cat-label').value = c.label;
      renderCatForm();
      $('#cat-label').focus();
      return;
    }
    if (el.dataset.delCat) { await deleteCategory(el.dataset.delCat); return; }
    if (el.dataset.depositGoal) { openDeposit(el.dataset.depositGoal); return; }
    if (el.dataset.editGoal) { openGoalModal(el.dataset.editGoal); return; }
    if (el.hasAttribute('data-new-goal')) { openGoalModal(); return; }

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
      if (!(await persist(() => repo.deleteTransaction(tx.id)))) return;
      state.transactions = state.transactions.filter((x) => x.id !== tx.id);
      toast('Transação excluída', 'info');
      renderAll();
      return;
    }
    if (el.dataset.deleteRule) {
      const r = state.recurring.find((x) => x.id === el.dataset.deleteRule);
      if (!r || !window.confirm(`Encerrar "${r.description}"? Os lançamentos já registrados continuam no histórico; só as previsões futuras somem.`)) return;
      if (!(await persist(() => repo.deleteRecurring(r.id)))) return;
      state.recurring = state.recurring.filter((x) => x.id !== r.id);
      toast('Recorrência encerrada', 'info');
      renderAll();
      return;
    }
    if (el.hasAttribute('data-of-add')) { openAddConnection(); return; }
    if (el.hasAttribute('data-of-keys')) { openCredentialsModal(); return; }
    if (el.hasAttribute('data-of-keys-delete')) { await removeCredentials(); return; }
    if (el.hasAttribute('data-of-retry')) { state.of.error = null; await loadOpenFinanceStatus({ force: true }); return; }
    if (el.dataset.ofSync) { await runSync(el.dataset.ofSync); return; }
    if (el.hasAttribute('data-of-sync-all')) { await runSync(null); return; }
    if (el.dataset.ofDisconnect) { await removeConnection(el.dataset.ofDisconnect); }
  });

  // Modal de transação
  $$('#tx-modal .segmented button').forEach((b) => b.addEventListener('click', () => setTxKind(b.dataset.kind)));
  ['#tx-repeat', '#tx-installments', '#tx-date', '#tx-amount', '#tx-frequency', '#tx-duration', '#tx-count', '#tx-until']
    .forEach((sel) => $(sel).addEventListener('input', updateRepeatUI));
  $('#tx-paid').addEventListener('change', () => { paidTouched = true; syncPaidDefault(); });
  $('#tx-new-category').addEventListener('click', () => openCategoryModal({ type: txKind, returnToTx: true }));
  $('#tx-add-item').addEventListener('click', () => {
    $('#tx-items').insertAdjacentHTML('beforeend', itemRow());
    const rows = $$('#tx-items .tx-item');
    rows[rows.length - 1].querySelector('[data-f="name"]').focus();
    updateItemsUI();
  });
  $('#tx-items').addEventListener('input', updateItemsUI);
  $('#tx-items-sum').addEventListener('change', updateItemsUI);
  $('#tx-items-box').addEventListener('toggle', () => {
    if ($('#tx-items-box').open && !$$('#tx-items .tx-item').length) $('#tx-items').insertAdjacentHTML('beforeend', itemRow());
  });
  $('#tx-form').addEventListener('submit', submitTx);

  // Categorias
  $('#btn-manage-categories').addEventListener('click', () => { $('#settings-modal').close(); openCategoryModal(); });
  $('#cat-form').addEventListener('submit', submitCategory);
  $('#cat-label').addEventListener('input', renderCatForm);
  $$('#cat-type button').forEach((b) => b.addEventListener('click', () => { catForm.type = b.dataset.kind; renderCatForm(); }));
  $('#cat-cancel-edit').addEventListener('click', () => { catForm.editing = null; $('#cat-label').value = ''; renderCatForm(); });

  // Metas
  $('#btn-new-goal').addEventListener('click', () => openGoalModal());
  $('#goal-form').addEventListener('submit', submitGoal);
  $('#goal-form').addEventListener('input', renderGoalSim);
  $('#goal-delete').addEventListener('click', removeGoal);
  $('#deposit-form').addEventListener('submit', submitDeposit);
  $$('#deposit-mode button').forEach((b) => b.addEventListener('click', () => {
    depositMode = b.dataset.mode;
    $$('#deposit-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));

  // Configurações
  $('#settings-form').addEventListener('submit', submitSettings);
  $('#btn-reset-demo').addEventListener('click', () => resetData(true));
  $('#btn-reset-empty').addEventListener('click', () => resetData(false));
  $('#btn-wipe-manual').addEventListener('click', wipeManualData);

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
  window.addEventListener('repo:degraded', () => toast('Sem conexão com o servidor — mostrando a última cópia salva.', 'error'));
  window.addEventListener('repo:schema-outdated', () => toast('Banco desatualizado: rode o schema.sql novo no SQL Editor do Supabase para liberar categorias, itens, agendamentos e metas.', 'error'));

  // Virada de dia com a aba aberta
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayISO() !== state.today) { state.today = todayISO(); renderAll(); }
  });
}

boot();
