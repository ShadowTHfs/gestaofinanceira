// Catálogo de categorias: rótulo, ícone, cor do gráfico e classes do badge.
// As classes Tailwind ficam escritas por extenso para o compilador encontrá-las.

export const CATEGORIES = {
  // ---- Saídas
  moradia:      { label: 'Moradia',      type: 'expense', icon: 'house',           color: '#818cf8', badge: 'bg-indigo-500/10 text-indigo-600 ring-indigo-500/20 dark:text-indigo-300' },
  alimentacao:  { label: 'Comida',       type: 'expense', icon: 'utensils',        color: '#fb923c', badge: 'bg-orange-500/10 text-orange-600 ring-orange-500/20 dark:text-orange-300' },
  transporte:   { label: 'Transporte',   type: 'expense', icon: 'car',             color: '#38bdf8', badge: 'bg-sky-500/10 text-sky-600 ring-sky-500/20 dark:text-sky-300' },
  saude:        { label: 'Saúde',        type: 'expense', icon: 'heart-pulse',     color: '#f87171', badge: 'bg-red-500/10 text-red-600 ring-red-500/20 dark:text-red-300' },
  educacao:     { label: 'Educação',     type: 'expense', icon: 'graduation-cap',  color: '#a78bfa', badge: 'bg-violet-500/10 text-violet-600 ring-violet-500/20 dark:text-violet-300' },
  lazer:        { label: 'Lazer',        type: 'expense', icon: 'party-popper',    color: '#fbbf24', badge: 'bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-300' },
  assinaturas:  { label: 'Assinaturas',  type: 'expense', icon: 'repeat',          color: '#22d3ee', badge: 'bg-cyan-500/10 text-cyan-600 ring-cyan-500/20 dark:text-cyan-300' },
  compras:      { label: 'Compras',      type: 'expense', icon: 'shopping-bag',    color: '#e879f9', badge: 'bg-fuchsia-500/10 text-fuchsia-600 ring-fuchsia-500/20 dark:text-fuchsia-300' },
  outros:       { label: 'Outros',       type: 'expense', icon: 'circle-ellipsis', color: '#94a3b8', badge: 'bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300' },
  // ---- Entradas
  trabalho:     { label: 'Trabalho',     type: 'income',  icon: 'briefcase',       color: '#34d399', badge: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-300' },
  freelance:    { label: 'Freelance',    type: 'income',  icon: 'laptop',          color: '#2dd4bf', badge: 'bg-teal-500/10 text-teal-600 ring-teal-500/20 dark:text-teal-300' },
  investimentos:{ label: 'Investimentos',type: 'income',  icon: 'trending-up',     color: '#a3e635', badge: 'bg-lime-500/10 text-lime-600 ring-lime-500/20 dark:text-lime-300' },
  outras_receitas: { label: 'Outras entradas', type: 'income', icon: 'piggy-bank', color: '#4ade80', badge: 'bg-green-500/10 text-green-600 ring-green-500/20 dark:text-green-300' },
};

export const getCategory = (key) => CATEGORIES[key] || CATEGORIES.outros;

export const categoriesByType = (type) =>
  Object.entries(CATEGORIES).filter(([, c]) => c.type === type).map(([key, c]) => ({ key, ...c }));
