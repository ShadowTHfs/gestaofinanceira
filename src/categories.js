// Catálogo de categorias: as fixas do app + as personalizadas do usuário.
// As classes Tailwind ficam escritas por extenso para o compilador encontrá-las.

/** Paleta de cores disponíveis para categorias e metas. */
export const COLORS = {
  indigo:  { hex: '#818cf8', badge: 'bg-indigo-500/10 text-indigo-600 ring-indigo-500/20 dark:text-indigo-300', dot: 'bg-indigo-400' },
  violet:  { hex: '#a78bfa', badge: 'bg-violet-500/10 text-violet-600 ring-violet-500/20 dark:text-violet-300', dot: 'bg-violet-400' },
  fuchsia: { hex: '#e879f9', badge: 'bg-fuchsia-500/10 text-fuchsia-600 ring-fuchsia-500/20 dark:text-fuchsia-300', dot: 'bg-fuchsia-400' },
  pink:    { hex: '#f472b6', badge: 'bg-pink-500/10 text-pink-600 ring-pink-500/20 dark:text-pink-300', dot: 'bg-pink-400' },
  red:     { hex: '#f87171', badge: 'bg-red-500/10 text-red-600 ring-red-500/20 dark:text-red-300', dot: 'bg-red-400' },
  orange:  { hex: '#fb923c', badge: 'bg-orange-500/10 text-orange-600 ring-orange-500/20 dark:text-orange-300', dot: 'bg-orange-400' },
  amber:   { hex: '#fbbf24', badge: 'bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-300', dot: 'bg-amber-400' },
  lime:    { hex: '#a3e635', badge: 'bg-lime-500/10 text-lime-600 ring-lime-500/20 dark:text-lime-300', dot: 'bg-lime-400' },
  green:   { hex: '#4ade80', badge: 'bg-green-500/10 text-green-600 ring-green-500/20 dark:text-green-300', dot: 'bg-green-400' },
  emerald: { hex: '#34d399', badge: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-300', dot: 'bg-emerald-400' },
  teal:    { hex: '#2dd4bf', badge: 'bg-teal-500/10 text-teal-600 ring-teal-500/20 dark:text-teal-300', dot: 'bg-teal-400' },
  cyan:    { hex: '#22d3ee', badge: 'bg-cyan-500/10 text-cyan-600 ring-cyan-500/20 dark:text-cyan-300', dot: 'bg-cyan-400' },
  sky:     { hex: '#38bdf8', badge: 'bg-sky-500/10 text-sky-600 ring-sky-500/20 dark:text-sky-300', dot: 'bg-sky-400' },
  blue:    { hex: '#60a5fa', badge: 'bg-blue-500/10 text-blue-600 ring-blue-500/20 dark:text-blue-300', dot: 'bg-blue-400' },
  slate:   { hex: '#94a3b8', badge: 'bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300', dot: 'bg-slate-400' },
};

/** Ícones que o usuário pode escolher para categorias/metas. */
export const PICKABLE_ICONS = [
  'house', 'utensils', 'shopping-cart', 'pizza', 'coffee', 'beer', 'car', 'bus', 'fuel', 'bike', 'plane',
  'heart-pulse', 'pill', 'stethoscope', 'dumbbell', 'graduation-cap', 'book-open', 'party-popper', 'music', 'tv',
  'smartphone', 'wifi', 'zap', 'droplet', 'lightbulb', 'wrench', 'shirt', 'shopping-bag', 'gift', 'baby',
  'paw-print', 'dog', 'cat', 'store', 'briefcase', 'laptop', 'hand-coins', 'banknote', 'piggy-bank', 'trending-up',
  'credit-card', 'receipt', 'target', 'trophy', 'flag', 'tag', 'repeat', 'circle-ellipsis',
];

const base = (label, type, icon, color) => ({ label, type, icon, colorKey: color, color: COLORS[color].hex, badge: COLORS[color].badge, builtin: true });

export const BUILTIN_CATEGORIES = {
  // ---- Saídas
  moradia:      base('Moradia', 'expense', 'house', 'indigo'),
  alimentacao:  base('Comida', 'expense', 'utensils', 'orange'),
  transporte:   base('Transporte', 'expense', 'car', 'sky'),
  saude:        base('Saúde', 'expense', 'heart-pulse', 'red'),
  educacao:     base('Educação', 'expense', 'graduation-cap', 'violet'),
  lazer:        base('Lazer', 'expense', 'party-popper', 'amber'),
  assinaturas:  base('Assinaturas', 'expense', 'repeat', 'cyan'),
  compras:      base('Compras', 'expense', 'shopping-bag', 'fuchsia'),
  outros:       base('Outros', 'expense', 'circle-ellipsis', 'slate'),
  reserva:      base('Guardado p/ metas', 'expense', 'piggy-bank', 'emerald'),
  // ---- Entradas
  trabalho:        base('Trabalho', 'income', 'briefcase', 'emerald'),
  freelance:       base('Freelance', 'income', 'laptop', 'teal'),
  investimentos:   base('Investimentos', 'income', 'trending-up', 'lime'),
  outras_receitas: base('Outras entradas', 'income', 'piggy-bank', 'green'),
};

/** Mapa vivo (fixas + personalizadas). Use getCategory()/allCategories(). */
export const CATEGORIES = { ...BUILTIN_CATEGORIES };

/** Recebe a lista do repositório: [{id,label,type,icon,color}] */
export function setCustomCategories(list = []) {
  Object.keys(CATEGORIES).forEach((k) => { if (!BUILTIN_CATEGORIES[k]) delete CATEGORIES[k]; });
  list.forEach((c) => {
    const col = COLORS[c.color] || COLORS.slate;
    CATEGORIES[c.id] = {
      label: c.label, type: c.type, icon: PICKABLE_ICONS.includes(c.icon) ? c.icon : 'circle-ellipsis',
      colorKey: COLORS[c.color] ? c.color : 'slate', color: col.hex, badge: col.badge, builtin: false,
    };
  });
}

export const getCategory = (key) =>
  CATEGORIES[key] || { ...BUILTIN_CATEGORIES.outros, label: 'Sem categoria' };

export const categoriesByType = (type) =>
  Object.entries(CATEGORIES).filter(([, c]) => c.type === type).map(([key, c]) => ({ key, ...c }));

export const newCategoryId = () => `c_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
