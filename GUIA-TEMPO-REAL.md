# Guia — Tempo real (notificações do celular + aviso automático da Pluggy)

São duas peças que trabalham juntas:

| Peça | O que faz | Quanto demora |
|---|---|---|
| **Celular (MacroDroid)** | O banco avisa no celular "Você recebeu um Pix de R$ 50" → o MacroDroid manda esse texto para o app → aparece na hora como **⚡ Prévia** | segundos |
| **Aviso da Pluggy (webhook)** | Quando a Pluggy recebe dados novos do banco, ela avisa o app → o app sincroniza sozinho e **troca a prévia pelo lançamento oficial** | quando o banco atualizar (no Meu Pluggy, até 1 vez por dia) |

A tela do app se atualiza sozinha (sem recarregar) nos dois casos.

> **Só Android.** No iPhone, nenhum app pode ler as notificações de outros apps.

---

## Parte A — Administrador (uma vez)

1. **Banco de dados:** Supabase → **SQL Editor** → cole o `schema.sql` inteiro → **Run**. (É aditivo: pode rodar de novo sem apagar nada. Esta é a versão 6.)
2. **Função:** Edge Functions → `pluggy` → cole o novo `pluggy-index.ts` inteiro → **Deploy**.
3. **Desligue "Verify JWT"** na função (Settings da função → *Verify JWT* / *Enforce JWT* → desligado → salvar).
   - Por quê: o celular e a Pluggy não fazem login. Cada um manda um **código secreto** próprio, e a função confere.
   - Os botões do app continuam exigindo login: a função confere isso em toda ação.
4. **Nenhum Secret novo.** A função usa a chave de serviço que o Supabase já entrega a ela automaticamente.

## Parte B — Cada pessoa: ligar o celular

1. No app, card **⚡ Tempo real** → **Ligar no meu celular (Android)**.
2. Aparece a **URL** e o seu **código secreto**. Copie os dois. O código só aparece **uma vez**; se perder, gere outro (o antigo para de funcionar).
3. No celular, instale o **MacroDroid** (Play Store) e permita o **acesso às notificações**.
4. Nas configurações do Android, tire o MacroDroid da **economia de bateria** (senão o Android o "adormece" e as notificações não saem).
5. Crie uma macro:
   - **Gatilho:** Notificação → *Notificação recebida* → marque os apps dos seus bancos (Nubank, PicPay, Mercado Pago, InfinitePay, Caixa, BB, Bradesco, Itaú…).
   - **Ação:** *Requisição HTTP* (em Conectividade / Web):
     - Método: **POST**
     - URL: a que você copiou
     - Cabeçalho: nome **`x-gf-token`**, valor = **seu código secreto**
     - Corpo: tipo **texto** (`text/plain`), **3 linhas**, usando o botão de *texto mágico* do MacroDroid:
       ```
       (nome do app)
       (título da notificação)
       (texto da notificação)
       ```
   > Os nomes exatos dos menus do MacroDroid mudam entre versões. Procure pelos equivalentes.
6. Salve e faça um **Pix de R$ 1** para você mesmo. Em segundos ele aparece no app com o selo **⚡ Prévia** e um aviso na tela.

**Testar sem gastar:** no app, em *Configurar*, há a caixa **"Testar o leitor"**. Cole o texto de uma notificação e veja como o app entende. Nada é gravado.

## Parte C — Cada pessoa: aviso automático da Pluggy

Precisa da **sua** chave da Pluggy já cadastrada (card Open Finance).

1. Card **⚡ Tempo real** → ligue **Atualização automática do banco**.
2. Pronto. A Pluggy passa a avisar o app quando o banco tiver novidades, e o app sincroniza sozinho, mesmo com o app fechado.

---

## O que o app faz com cada notificação

| Situação | Resultado |
|---|---|
| Pix/transferência recebida, venda aprovada, estorno | **Entrada** (prévia) |
| Pix enviado, compra no cartão, pagamento, saque | **Saída** (prévia) |
| Fatura, limite, lembrete, agendamento, código de segurança, compra negada, rendimento, propaganda | **Ignorada** (não lança) |
| Texto sem valor em R$ ou sem saber se entrou/saiu | **Não entendi** (aparece em *Últimas notificações*) |
| A mesma notificação repetida em seguida | **Já existia** (não duplica) |
| O banco já mandou essa transação pela Pluggy hoje | **Já existia** (não duplica) |

Quando a transação oficial chega pela Pluggy (mesmo valor, mesmo tipo, data até 3 dias depois), a prévia **some sozinha** e fica só a oficial.

## Limites e cuidados

- O leitor foi feito com os **formatos mais comuns** de aviso de cada banco. Se algum banco escrever de outro jeito, a notificação aparece como **"Não entendi"** no card. Mande o texto e o leitor é ajustado.
- O **código secreto** lança dados no seu app. Não compartilhe. Se vazar, gere um novo no card.
- A prévia usa a data de hoje e a categoria pelo nome de quem recebeu. Se você editar a categoria de uma prévia, ela volta à categoria do banco quando a oficial chegar.
- Duas notificações **idênticas** no mesmo intervalo de 2 minutos contam como uma só.
- O app guarda as notificações recebidas por **30 dias** (só para conferência).
- O **Meu Pluggy** atualiza os bancos até 1 vez por dia. É por isso que o celular existe: ele cobre o "agora", a Pluggy confirma depois.
