# Guia — Open Finance real (Meu Pluggy) + Login com Google

> O **Meu Pluggy** é gratuito e sem prazo, mas é **só para uso pessoal**: até **5 conexões** e **sem uso comercial**.
> Se um dia o app for oferecido a clientes, o caminho é o plano comercial da Pluggy (falar com o time de vendas).

---

## Parte A — Banco de dados (1 minuto)

1. Supabase → **SQL Editor** → cole o `schema.sql` mais recente → **Run**.
   (É aditivo: pode rodar de novo quantas vezes quiser, não apaga nada.)

---

## Parte B — Publicar a função `pluggy` no Supabase (5 minutos)

A função é o "cofre" do app: ela guarda a chave da Pluggy e busca seus dados. O navegador nunca vê a chave.

1. Supabase → menu da esquerda → **Edge Functions** → **Functions**.
2. Clique em **Deploy a new function** → **Via Editor**.
3. Nome da função: **`pluggy`** (exatamente assim, minúsculo).
4. Apague o código de exemplo do `index.ts` e cole **todo** o conteúdo do arquivo `supabase/functions/pluggy/index.ts`.
5. Clique em **Deploy function**. Deixe a opção "Verify JWT" como veio (ligada).

### Secrets (as chaves)

Supabase → **Edge Functions** → **Secrets** → adicione:

| Nome | Valor |
|---|---|
| `PLUGGY_CLIENT_ID` | Dashboard da Pluggy → **Applications** → Client ID |
| `PLUGGY_CLIENT_SECRET` | Dashboard da Pluggy → Client Secret (se não tiver anotado, gere outro na página da aplicação) |
| `PLUGGY_ALLOWED_EMAILS` | **o seu e-mail de login no app** (se usar Google, o e-mail do Google). Vários? separe por vírgula |

> Nunca cole o Client Secret no GitHub, no `env.js` ou em conversas. Ele só vai nos Secrets do Supabase.

---

## Parte C — Conectar seus bancos (uma vez por banco)

1. Acesse **https://meu.pluggy.ai**, crie a conta e clique em **Conectar Minha Conta** → escolha o banco → autorize no app do banco.
2. Acesse **https://dashboard.pluggy.ai** (mesmo login) → **Applications** → sua aplicação → **Demo** → **Connect Account**.
3. Escolha o conector **MeuPluggy** (⚠️ não o banco, nem o Sandbox) e entre com a conta do Meu Pluggy.
4. Em **Connected Items**, abra cada banco e copie o **Item ID** (formato `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
5. No app → card **Open Finance** → **Adicionar conexão** → cole o Item ID → **Conectar e importar**.

O app importa contas, cartões (fatura, limite, vencimento) e até **12 meses** de transações.
Depois disso ele **atualiza sozinho** quando você abre o app e a última atualização tem mais de 12 h
(o próprio Meu Pluggy atualiza os bancos a cada 24 h). Também dá para clicar em 🔄 a qualquer momento.

### Bom saber
- **Pagamento de fatura do cartão não é importado** — as compras do cartão já entram uma a uma; importar o pagamento contaria o mesmo gasto duas vezes.
- **Autorização vale 1 ano.** Quando expirar, o app avisa; é só repetir os passos 2–4 da Parte C.
- **Banco novo no Meu Pluggy** precisa ser vinculado de novo no Dashboard (passos 2–4) para ganhar um Item ID.
- **Remover conexão no app** não revoga a autorização — para isso, use o meu.pluggy.ai.
- **Saldo atual do painel x saldo do banco:** o painel soma o "saldo inicial" + o que está registrado. Se você também lança gastos à mão, eles podem se repetir com os importados. O card mostra o **saldo real dos bancos** para comparar.

---

## Parte D — Login com Google

**No Google Cloud** (console.cloud.google.com → APIs e serviços):
1. **Tela de consentimento OAuth**: nome do app, e-mail de suporte, público **Externo**; adicione seu e-mail como usuário de teste (ou publique o app).
2. **Credenciais → + Criar credenciais → ID do cliente OAuth → Aplicativo da Web**:
   - **Origens JavaScript autorizadas:** `https://SEU-APP.vercel.app`
   - **URIs de redirecionamento autorizados:** `https://ltitnugobvghjgvsghoy.supabase.co/auth/v1/callback`
3. Copie o **ID do cliente** e a **Chave secreta**.

**No Supabase:**
4. **Authentication → Sign In / Providers → Google** → ative → cole ID e chave → **Save**.
5. **Authentication → URL Configuration**: Site URL = endereço do app no Vercel; Redirect URLs = `https://SEU-APP.vercel.app/**`.

O botão **"Continuar com Google"** aparece sozinho na tela de login assim que o Google estiver ativo no Supabase.

> Se você entrar com Google usando o **mesmo e-mail** de uma conta criada com senha, o Supabase junta as duas na mesma conta (mesmos dados).

---

## Se algo der errado

| Mensagem no app | O que fazer |
|---|---|
| "A função pluggy ainda não foi publicada" | Parte B: confira o nome **pluggy** |
| "Faltam os Secrets PLUGGY_CLIENT_ID…" | Parte B → Secrets |
| "Esta conta não está na lista de e-mails autorizados" | `PLUGGY_ALLOWED_EMAILS` com o e-mail exato do login |
| "Client ID ou Client Secret da Pluggy incorretos" | Gere um novo Secret no Dashboard da Pluggy e atualize |
| "Item não encontrado na Pluggy" | O Item ID é de outra aplicação ou foi removido — copie de novo (Parte C) |
| "Banco desatualizado: rode o schema.sql" | Parte A |
| "A autorização do Meu Pluggy expirou" | Refaça Parte C, passos 2–4 |
| Botão do Google não aparece | Parte D, passo 4 |
| Google mostra "redirect_uri_mismatch" | Parte D, passo 2: a URI de redirecionamento precisa ser exatamente a do Supabase |
