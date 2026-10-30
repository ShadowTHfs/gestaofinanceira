// Gráficos (Chart.js 4, carregado em assets/vendor como global `Chart`).
import { fmt, monthLabel } from '../utils.js';

let doughnut = null;
let evolution = null;

const isDark = () => document.documentElement.classList.contains('dark');
const palette = () => (isDark()
  ? { text: '#94a3b8', grid: 'rgba(148,163,184,0.08)', surface: '#0f172a', tipBg: 'rgba(2,6,23,0.92)', tipBorder: 'rgba(51,65,85,0.8)' }
  : { text: '#64748b', grid: 'rgba(100,116,139,0.12)', surface: '#ffffff', tipBg: 'rgba(15,23,42,0.92)', tipBorder: 'rgba(15,23,42,0.1)' });

function baseTooltip(p) {
  return {
    backgroundColor: p.tipBg, borderColor: p.tipBorder, borderWidth: 1, padding: 12, cornerRadius: 12,
    titleColor: '#f8fafc', bodyColor: '#cbd5e1', titleFont: { weight: '600' }, boxPadding: 6, usePointStyle: true,
  };
}

export function setChartDefaults() {
  if (!window.Chart) return;
  Chart.defaults.font.family = "'Inter', ui-sans-serif, system-ui, sans-serif";
  Chart.defaults.font.size = 12;
}

/** Gráfico de rosca. `items`: [{key,label,value,color}] */
export function renderDoughnut(canvas, items, { onSliceClick, onHoverIndex } = {}) {
  if (!window.Chart) return null;
  const p = palette();
  destroyDoughnut();
  doughnut = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: items.map((i) => i.label),
      datasets: [{
        data: items.map((i) => i.value),
        backgroundColor: items.map((i) => i.color),
        hoverBackgroundColor: items.map((i) => i.color),
        borderColor: p.surface,
        borderWidth: 3,
        borderRadius: 8,
        spacing: 2,
        hoverOffset: 10,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '74%',
      layout: { padding: 10 },
      animation: { animateRotate: true, duration: 700, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...baseTooltip(p),
          callbacks: {
            label(ctx) {
              const visibleTotal = ctx.dataset.data.reduce((acc, v, i) => (ctx.chart.getDataVisibility(i) ? acc + v : acc), 0);
              const pct = visibleTotal ? ((ctx.parsed / visibleTotal) * 100).toFixed(1).replace('.', ',') : '0';
              return ` ${fmt(ctx.parsed)}  ·  ${pct}%`;
            },
          },
        },
      },
      onHover(evt, els) {
        evt.native.target.style.cursor = els.length ? 'pointer' : 'default';
        onHoverIndex?.(els.length ? els[0].index : null);
      },
      onClick(_evt, els) {
        if (els.length) onSliceClick?.(els[0].index);
      },
    },
  });
  return doughnut;
}

export const getDoughnut = () => doughnut;

/** Desmonta todos os gráficos (usado antes de esconder o painel, ex.: ao sair). */
export function destroyAllCharts() {
  destroyDoughnut();
  evolution?.destroy();
  evolution = null;
}

export function destroyDoughnut() {
  doughnut?.destroy();
  doughnut = null;
}

/** Barras de entradas x saídas por mês. Meses futuros aparecem translúcidos. */
export function renderEvolution(canvas, series, selectedYM, { onBarClick } = {}) {
  if (!window.Chart) return null;
  const p = palette();
  const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');
  const tone = (hex, s) => (s.mode === 'future' ? alpha(hex, 0.35) : s.ym === selectedYM ? hex : alpha(hex, 0.7));
  evolution?.destroy();
  evolution = null;
  evolution = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: series.map((s) => monthLabel(s.ym, { short: true })),
      datasets: [
        { label: 'Entradas', data: series.map((s) => s.income), backgroundColor: series.map((s) => tone('#10b981', s)), borderRadius: 6, maxBarThickness: 18 },
        { label: 'Saídas', data: series.map((s) => s.expense), backgroundColor: series.map((s) => tone('#f43f5e', s)), borderRadius: 6, maxBarThickness: 18 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: p.text } },
        y: {
          grid: { color: p.grid }, border: { display: false },
          ticks: { color: p.text, maxTicksLimit: 5, callback: (v) => (v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR')} mil` : v) },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...baseTooltip(p),
          callbacks: {
            title: (ctx) => {
              const s = series[ctx[0].dataIndex];
              return `${monthLabel(s.ym)}${s.mode === 'future' ? ' · previsto' : ''}`;
            },
            label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`,
            footer: (ctx) => {
              const s = series[ctx[0].dataIndex];
              const r = s.income - s.expense;
              return `Resultado: ${r >= 0 ? '+' : '−'}${fmt(Math.abs(r))}`;
            },
          },
        },
      },
      onHover(evt, els) { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
      onClick(_evt, els) { if (els.length) onBarClick?.(series[els[0].index].ym); },
    },
  });
  return evolution;
}
