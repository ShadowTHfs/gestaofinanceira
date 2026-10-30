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

## Ligar o Supabase (modo real, com login)

1. **Criar as tabelas** — Supabase → *SQL Editor* → cole `supabase/schema.sql` → *Run*.
   (Pode rodar de novo sem problema: o script é idempotente.)
2. **Pegar as chaves** — *Project Settings → API*: copie **Project URL** e a chave **anon / public**.
3. **Vercel** → *Settings → Environment Variables* (marque Production, Preview e Development):
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = anon public key (**nunca** a service_role)
4. **Supabase → Authentication → URL Configuration**:
   - *Site URL* = o endereço do seu app no Vercel (ex.: `https://seu-app.vercel.app`)
   - *Redirect URLs*: adicione `https://seu-app.vercel.app/**`
   (É para onde vão os links de confirmação de e-mail e de "esqueci minha senha".)
5. **Vercel → Deployments → Redeploy** (as variáveis só valem num deploy novo).

Com isso o app passa a exigir login. Cada pessoa vê **só os próprios dados** (RLS).
No primeiro acesso de uma conta vazia, o app oferece **trazer os dados deste navegador** ou **começar do zero**.

### Testar localmente já com o Supabase
Edite o `env.js` da raiz com a URL e a anon key e rode `npm run dev`.
Não faça commit desse arquivo preenchido se não quiser expor a URL do projeto (a anon key é pública, mas por organização é melhor deixar só no Vercel).

### Comportamento em caso de falha
- **Leitura falhou** (internet caiu): mostra a última cópia salva no aparelho e avisa.
- **Gravação falhou**: avisa *"Não foi salvo"* e **não** mostra o item como salvo.

## Recursos (v3)

- **Categorias personalizadas** — nome, ícone e cor (botão "+" ao lado da categoria, ou ⚙️ → Gerenciar categorias).
- **Itens da compra** — lista de itens com quantidade e preço; o valor pode ser a soma automática.
- **Pago / a pagar** — data futura vira "a pagar" automaticamente; aparece em *Próximos vencimentos* com botão ✔.
- **Séries** — repetir toda semana, mês ou ano, sem fim, por N vezes ou até uma data.
- **Metas** — calculadora com juros compostos: quanto guardar por mês até o prazo e em quantos meses você chega
  com a sobra média real (dividida entre as metas). Arquivo: `src/services/goals.js`.

Se o banco ainda não tiver as colunas novas, o app continua salvando o básico e avisa para rodar o `schema.sql`.

## Modelo de transação

```js
{
  id, description, amount, date: 'AAAA-MM-DD',
  type: 'income' | 'expense',
  category, source: 'manual' | 'open_finance',
  status: 'paid' | 'pending', items: [{ name, qty, price }] | null,
  recurringId, installment: { current, total, groupId } | null,
  externalId, accountId, createdAt
}
```

## Open Finance

`openFinanceService.js` é **simulado**: nenhum dado bancário real é acessado.
Para ligar de verdade, use um agregador autorizado pelo Banco Central (ex.: Pluggy, Belvo) via **Supabase Edge Function**
(as credenciais do provedor nunca ficam no navegador) e reescreva `connectBank`, `fetchExternalStatement` e
`normalizeExternalTransaction`, mantendo as mesmas assinaturas.
