# Guia — Open Finance real (Meu Pluggy) + Login com Google

> O **Meu Pluggy** é gratuito e sem prazo, mas é **só para uso pessoal**: até **5 conexões por pessoa** e **sem uso comercial**.
> Por isso, **cada pessoa usa a própria chave da Pluggy** (Parte C). Para oferecer o app a clientes, o caminho é o plano comercial da Pluggy.
>
> **Administrador (você):** Partes A, B e D — uma vez só.
> **Cada uma das pessoas:** Parte C.

---

## Parte A — Banco de dados (1 minuto)

1. Supabase → **SQL Editor** → cole o `schema.sql` mais recente → **Run**.
   (É aditivo: pode rodar de novo quantas vezes quiser, não apaga nada.)

---

## Parte B — Publicar a função `pluggy` no Supabase (administrador, uma vez)

A função é o "cofre" do app: valida e guarda **criptografada** a chave da Pluggy de cada pessoa e busca os dados. O navegador nunca vê os Secrets.

1. Supabase → menu da esquerda → **Edge Functions** → **Functions**.
2. Clique em **Deploy a new function** → **Via Editor**.
3. Nome da função: **`pluggy`** (exatamente assim, minúsculo).
4. Apague o código de exemplo do `index.ts` e cole **todo** o conteúdo do arquivo `pluggy-index.ts` (o mesmo que `supabase/functions/pluggy/index.ts`).
5. Clique em **Deploy function**.
6. Abra a função → **Settings** (ou Details) → **desligue "Verify JWT"** (Enforce JWT) e salve. Precisa ficar desligado para o celular e a Pluggy conseguirem chamar a função (cada um com o seu código secreto). Os botões do app continuam exigindo login: a própria função confere isso. Detalhes no **GUIA-TEMPO-REAL.md**.

### Secrets (Edge Functions → Secrets)

| Nome | Valor | Obrigatório? |
|---|---|---|
| `PLUGGY_ALLOWED_EMAILS` | os e-mails de login das **5 pessoas**, separados por vírgula. Ex.: `voce@gmail.com, maria@gmail.com, joao@gmail.com` | **Recomendado** — sem ele, qualquer pessoa que criar conta no app pode usar o Open Finance (com a própria chave) |
| `PLUGGY_ENCRYPTION_KEY` | um texto aleatório longo, só seu (ex.: 40+ letras e números misturados) | Opcional — se não existir, a função usa a chave interna do Supabase |
| `PLUGGY_CLIENT_ID` / `PLUGGY_CLIENT_SECRET` | **não precisa mais** — cada pessoa cadastra a própria no app | Não |

> ⚠️ Se você definir ou trocar o `PLUGGY_ENCRYPTION_KEY` depois que as pessoas já cadastraram chaves, elas precisarão cadastrar a chave da Pluggy de novo no app (o app avisa).

### Dica de segurança (opcional)
Depois que as 5 pessoas criarem a conta no app, desligue novos cadastros em
**Supabase → Authentication → Sign In / Providers → "Allow new users to sign up"**. Assim ninguém de fora cria conta.

---

## Parte C — O que CADA PESSOA faz (uma vez)

> Cada pessoa usa a **própria conta gratuita** da Pluggy. Assim os bancos de um nunca aparecem para o outro,
> e cada um fica dentro da regra do Meu Pluggy (uso pessoal, até 5 bancos por pessoa).

**C1. Criar a chave da Pluggy**
1. Acesse **https://dashboard.pluggy.ai** e crie a conta (use o mesmo e-mail que vai usar no Meu Pluggy).
2. Em **Applications**, crie uma aplicação. Copie o **Client ID** e o **Client Secret** (o Secret aparece uma vez — se perder, use **Refresh Secret**).
3. No app de finanças → card **Open Finance** → **Cadastrar minha chave da Pluggy** → cole os dois → **Validar e salvar**.

**C2. Conectar os bancos**
1. Acesse **https://meu.pluggy.ai** → **Conectar Minha Conta** → escolha o banco → autorize no app do banco.
2. Volte ao **Dashboard da Pluggy** → **Applications** → sua aplicação → **Demo** → **Connect Account**.
3. Escolha o conector **MeuPluggy** (⚠️ não o banco, nem o Sandbox) e entre com a conta do Meu Pluggy.
4. Em **Connected Items**, abra cada banco e copie o **Item ID** (formato `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
5. No app → **Adicionar conexão** → cole o Item ID → **Conectar e importar**.

> 💡 Faça o C2 logo depois de criar a conta no Dashboard: há relatos de que o vínculo com o Meu Pluggy só pode ser feito
> enquanto o período de teste da conta de desenvolvedor está ativo (a leitura dos dados continua grátis depois).

O app importa contas, cartões (fatura, limite, vencimento) e até **12 meses** de transações, e **atualiza sozinho**
ao abrir o app quando a última atualização tem mais de 12 h. O botão 🔄 atualiza na hora.

### Bom saber
- **Pagamento de fatura do cartão não é importado** — as compras do cartão já entram uma a uma.
- **Autorização do Meu Pluggy vale 1 ano.** Quando expirar, o app avisa; repita C2, passos 2–4.
- **Banco novo** no Meu Pluggy precisa ser vinculado de novo (C2, passos 2–5).
- **Remover conexão no app** não revoga a autorização — para isso, use o meu.pluggy.ai.
- **Lançou à mão e também importou?** O mesmo gasto pode aparecer duas vezes. Compare com o **saldo real dos bancos** no card.

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
| "Esta conta não está na lista de pessoas autorizadas" | Inclua o e-mail exato do login em `PLUGGY_ALLOWED_EMAILS` |
| "Seu Client ID ou Client Secret da Pluggy não foi aceito" | Copie de novo do Dashboard (ou gere outro Secret) — Parte C1 |
| "Item não encontrado na sua Pluggy" | O Item ID é de outra aplicação/conta — copie da **mesma** aplicação da chave cadastrada |
| "Não consegui abrir sua chave salva" | O `PLUGGY_ENCRYPTION_KEY` mudou — cadastre a chave de novo (C1, passo 3) |
| "Banco desatualizado: rode o schema.sql" | Parte A |
| "A autorização do Meu Pluggy expirou" | Repita C2, passos 2–4 |
| Botão do Google não aparece | Parte D, passo 4 |
| Google mostra "redirect_uri_mismatch" | Parte D, passo 2: a URI de redirecionamento precisa ser exatamente a do Supabase |
