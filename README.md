# Finanças — Painel de Gestão Financeira Pessoal

SPA estática (HTML + JavaScript puro em módulos + Tailwind compilado + Chart.js), pronta para o **Vercel** e preparada para o **Supabase**.

## Estrutura

```
├── index.html                    # Layout da página
├── env.js                        # Chaves públicas (vazio localmente; regerado no build)
├── vercel.json                   # Build, roteamento SPA e cabeçalhos de segurança
├── package.json                  # Scripts: build (Tailwind + cópia para /dist)
├── tailwind.config.cjs
├── assets/
│   ├── app.css                   # CSS gerado pelo Tailwind (já compilado)
│   └── vendor/chart.umd.min.js   # Chart.js 4.6 (sem depender de CDN)
├── scripts/build.mjs             # Gera /dist e o dist/env.js com as variáveis do Vercel
├── supabase/schema.sql           # Tabelas + RLS (rodar no SQL Editor quando for ligar)
└── src/
    ├── app.js                    # Estado, telas e eventos
    ├── config.js                 # Lê window.__ENV__
    ├── categories.js             # Categorias: nome, ícone, cor, badge
    ├── utils.js                  # Moeda, datas, helpers
    ├── data/seed.js              # Dados fictícios de demonstração
    ├── services/
    │   ├── supabaseClient.js     # CAMADA DE REPOSITÓRIO (localStorage ⇄ Supabase)
    │   ├── finance.js            # Cálculos: KPIs, projeções, parcelamentos
    │   └── openFinanceService.js # Open Finance SIMULADO (pronto para provedor real)
    ├── ui/charts.js              # Rosca + barras
    ├── ui/icons.js               # Ícones SVG (Lucide, ISC)
    └── styles/input.css          # Fonte do Tailwind
```

## Rodar localmente

```bash
npm install
npm run dev        # abre em http://localhost:3000
```
Se mudar classes Tailwind: `npm run build:css` (ou `npm run watch:css`).

## Deploy no Vercel

1. Suba a pasta para um repositório no GitHub.
2. Vercel → **Add New → Project** → importe o repositório.
3. Não mude nada: o `vercel.json` já define build (`npm run build`) e saída (`dist`).
4. **Deploy.**

## Ligar o Supabase (quando quiser)

1. No Supabase: **SQL Editor** → cole `supabase/schema.sql` → **Run**.
2. No Vercel: **Settings → Environment Variables**:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = anon public key (nunca a service_role)
3. Redeploy.

> O banco tem RLS por usuário, então o modo Supabase só ativa com **usuário logado**.
> Sem login, o app continua salvando no navegador (o selo no topo mostra onde está salvando).
> A tela de login é o próximo passo.

## Modelo de transação

```js
{
  id, description, amount, date: 'AAAA-MM-DD',
  type: 'income' | 'expense',
  category, source: 'manual' | 'open_finance',
  recurringId, installment: { current, total, groupId } | null,
  externalId, accountId, createdAt
}
```

## Open Finance

`openFinanceService.js` é **simulado**: nenhum dado bancário real é acessado.
Para ligar de verdade, use um agregador autorizado pelo Banco Central (ex.: Pluggy, Belvo) via **Supabase Edge Function**
(as credenciais do provedor nunca ficam no navegador) e reescreva `connectBank`, `fetchExternalStatement` e
`normalizeExternalTransaction`, mantendo as mesmas assinaturas.
