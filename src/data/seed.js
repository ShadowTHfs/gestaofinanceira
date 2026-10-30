// Dados fictícios de demonstração — gerados relativos à data de hoje, para o
// painel sempre parecer "vivo" (histórico de 5 meses + mês atual + futuros).
// Usa gerador pseudoaleatório com semente fixa: mesma demo em todo navegador.
import { uid, todayISO, ymOf, dayOf, addMonths, dateWithDay, round2, toISODate } from '../utils.js';

function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildSeed() {
  const rand = rng(20261030);
  const between = (min, max) => round2(min + rand() * (max - min));
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const today = todayISO();
  const cur = ymOf(today);
  const todayDay = dayOf(today);
  const start = addMonths(cur, -5);
  const now = new Date().toISOString();

  const rule = (description, amount, type, category, day, kind) => ({
    id: uid(), description, amount, type, category, day, kind, startMonth: start, endMonth: null, active: true,
  });
  const recurring = [
    rule('Salário', 7800, 'income', 'trabalho', 5, 'fixed'),
    rule('Aluguel', 1450, 'expense', 'moradia', 10, 'fixed'),
    rule('Internet fibra', 109.9, 'expense', 'moradia', 15, 'subscription'),
    rule('Mensalidade da faculdade', 690, 'expense', 'educacao', 8, 'fixed'),
    rule('Plano de saúde', 289, 'expense', 'saude', 12, 'fixed'),
    rule('Academia', 119.9, 'expense', 'saude', 7, 'subscription'),
    rule('Streaming de vídeo', 44.9, 'expense', 'assinaturas', 18, 'subscription'),
    rule('Streaming de música', 21.9, 'expense', 'assinaturas', 22, 'subscription'),
  ];

  const tx = [];
  const add = (o) => tx.push({ id: uid(), source: 'manual', status: 'paid', items: null, recurringId: null, installment: null, externalId: null, accountId: null, createdAt: now, ...o });

  const variable = [
    { cat: 'alimentacao', n: 4, min: 140, max: 390, names: ['Supermercado', 'Feira da semana', 'Atacadão'] },
    { cat: 'alimentacao', n: 5, min: 22, max: 85, names: ['Delivery', 'Restaurante', 'Lanchonete', 'Padaria'] },
    { cat: 'transporte', n: 5, min: 18, max: 170, names: ['Combustível', 'Corrida por app', 'Estacionamento'] },
    { cat: 'lazer', n: 2, min: 40, max: 210, names: ['Cinema', 'Show', 'Bar com amigos', 'Passeio'] },
    { cat: 'compras', n: 1, min: 60, max: 260, names: ['Roupas', 'Casa e decoração', 'Eletrônicos'] },
    { cat: 'saude', n: 1, min: 25, max: 120, names: ['Farmácia'] },
    { cat: 'outros', n: 1, min: 15, max: 90, names: ['Presente', 'Taxa bancária', 'Doação'] },
  ];

  for (let i = 0; i <= 5; i++) {
    const ym = addMonths(start, i);
    const isCurrent = ym === cur;
    const limit = isCurrent ? todayDay : 31;

    recurring.forEach((r) => {
      if (r.day <= limit) add({ description: r.description, amount: r.amount, type: r.type, category: r.category, date: dateWithDay(ym, r.day), recurringId: r.id });
    });

    variable.forEach((v) => {
      for (let k = 0; k < v.n; k++) {
        const day = 1 + Math.floor(rand() * (isCurrent ? Math.max(1, todayDay) : 28));
        add({ description: pick(v.names), amount: between(v.min, v.max), type: 'expense', category: v.cat, date: dateWithDay(ym, day) });
      }
    });

    if (i % 2 === 1) {
      const day = 1 + Math.floor(rand() * (isCurrent ? Math.max(1, todayDay) : 28));
      add({ description: 'Projeto freelance', amount: between(600, 1400), type: 'income', category: 'freelance', date: dateWithDay(ym, day) });
    }
    if (!isCurrent) add({ description: 'Rendimento CDB', amount: between(25, 60), type: 'income', category: 'investimentos', date: dateWithDay(ym, 28) });
  }

  // Parcelamentos (gravados como lançamentos reais; os de data futura viram "previstos").
  const installments = (description, category, value, total, startYM, day) => {
    const groupId = uid();
    for (let n = 1; n <= total; n++) {
      add({ description, amount: value, type: 'expense', category, date: dateWithDay(addMonths(startYM, n - 1), day), installment: { current: n, total, groupId } });
    }
  };
  installments('Notebook', 'compras', 349.9, 10, addMonths(cur, -3), 20);
  installments('Curso de inglês', 'educacao', 180, 6, addMonths(cur, -1), 25);

  // Categoria personalizada + gastos nela
  const categories = [{ id: 'c_pets_demo', label: 'Pets', type: 'expense', icon: 'paw-print', color: 'pink' }];
  for (let i = 1; i <= 5; i++) {
    const ym = addMonths(start, i);
    if (ym === cur && todayDay < 3) continue;
    add({ description: 'Pet shop', amount: between(80, 160), type: 'expense', category: 'c_pets_demo', date: dateWithDay(ym, ym === cur ? Math.min(3, todayDay) : 14) });
  }

  // Compra com itens detalhados
  const items = [
    { name: 'Arroz 5kg', qty: 2, price: 27.9 },
    { name: 'Feijão 1kg', qty: 3, price: 8.49 },
    { name: 'Café 500g', qty: 1, price: 18.9 },
    { name: 'Frango (kg)', qty: 2.5, price: 16.9 },
  ];
  add({ description: 'Supermercado (lista)', amount: round2(items.reduce((a, it) => a + it.qty * it.price, 0)), type: 'expense', category: 'alimentacao', date: today, items });

  // Pagamentos agendados (a pagar) — um vence em breve, outro no próximo mês
  const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return toISODate(d); };
  add({ description: 'Conta de luz', amount: 186.4, type: 'expense', category: 'moradia', date: inDays(3), status: 'pending' });
  add({ description: 'IPVA (cota única)', amount: 980, type: 'expense', category: 'transporte', date: inDays(40), status: 'pending' });

  // Série semanal com duração definida (8 semanas a partir desta semana)
  recurring.push({
    id: uid(), description: 'Diarista', amount: 150, type: 'expense', category: 'moradia', kind: 'fixed',
    frequency: 'weekly', startDate: inDays(2), day: dayOf(inDays(2)), startMonth: ymOf(inDays(2)), endMonth: null, occurrences: 8, active: true,
  });

  // Metas
  const goals = [
    { id: uid(), name: 'Reserva de emergência', targetAmount: 30000, savedAmount: 8500, targetDate: dateWithDay(addMonths(cur, 18), 28), monthlyContribution: null, annualRate: 10.5, icon: 'piggy-bank', color: 'emerald', createdAt: now },
    { id: uid(), name: 'Viagem de férias', targetAmount: 7000, savedAmount: 1200, targetDate: dateWithDay(addMonths(cur, 6), 15), monthlyContribution: 600, annualRate: 0, icon: 'plane', color: 'sky', createdAt: now },
  ];

  return {
    transactions: tx,
    recurring,
    settings: { openingBalance: 3500, monthlyBudget: 6500 },
    categories,
    goals,
  };
}
