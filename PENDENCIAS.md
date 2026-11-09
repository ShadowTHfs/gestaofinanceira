# Pendências e próximos passos

## Configuração (fazer uma vez)
- [ ] Rodar o `supabase/schema.sql` ATUALIZADO no SQL Editor (versão 3: categorias, itens, agendamentos e metas).
      Pode rodar o arquivo inteiro de novo — é aditivo, não apaga nada.
- [ ] Cadastrar `SUPABASE_URL` e `SUPABASE_ANON_KEY` no Vercel e fazer Redeploy
- [ ] Supabase → Authentication → URL Configuration: Site URL + Redirect URLs com o domínio do Vercel
- [ ] (Opcional) Traduzir os modelos de e-mail do Supabase para português
- [ ] (Uso real) Configurar SMTP próprio no Supabase — o envio padrão tem limite baixo por hora

## Roadmap combinado
- [x] Parte 1 — Categorias personalizadas, itens na compra, pagamentos agendados e séries (semanal/mensal/anual)
- [x] Parte 2 — Metas com calculadora (quanto guardar por mês / em quanto tempo)
- [ ] Parte 3 — Assistente financeira com regras próprias (sem IA externa por enquanto)
- [x] Parte 4 — Open Finance real via Meu Pluggy (Edge Function "pluggy") — ver GUIA-PLUGGY.md
- [x] Login com Google — ver GUIA-PLUGGY.md, Parte D

## Para ativar a Parte 4 e o Google (fazer uma vez)
- [ ] Rodar o schema.sql (v4) no SQL Editor
- [ ] Publicar a Edge Function "pluggy" + Secret PLUGGY_ALLOWED_EMAILS com os e-mails das 5 pessoas
- [ ] Cada pessoa: criar a própria chave no Dashboard da Pluggy, cadastrar no app e conectar os bancos (GUIA-PLUGGY.md, Parte C)
- [ ] (Opcional) Desligar novos cadastros no Supabase depois que as 5 pessoas entrarem
- [ ] Google Cloud: ID do cliente OAuth + ativar provedor Google no Supabase

## Atenção
- Meu Pluggy: uso pessoal, até 5 conexões POR PESSOA, sem uso comercial — por isso cada pessoa usa a própria chave.
  Para vender o app a terceiros → plano comercial da Pluggy (aí volta a ser uma chave só + widget de conexão).
- Autorização do Meu Pluggy vence em 1 ano (o app avisa).

## A BANCADA (08/11)
- [x] Valor "1.000" lido como 1 → agora 1000 (padrão brasileiro)
- [x] Clique duplo em Guardar / Salvar meta / Criar categoria criava duplicados → travado
- [x] Nome de categoria executava código (XSS) → texto filtrado
- [x] Boas-vindas recomendava copiar a demonstração → agora avisa que é fictícia e recomenda "Começar do zero"
- [x] Gráficos recriados a cada render (erro no console) → atualizados no lugar
- [x] Dicas das metas sem separador de milhar; função sem uso removida
- [ ] Content-Security-Policy no vercel.json (segunda barreira; testar antes num deploy de prévia)

## Melhorias futuras
- [ ] Webhook da Pluggy para atualizar sem precisar abrir o app
- [x] Saldo atual = saldo real dos bancos quando há Open Finance (Configurações permite voltar ao calculado)
- [x] Botão para apagar lançamentos manuais/de demonstração no modo nuvem
- [ ] Editar categoria de uma transação importada (e lembrar para as próximas)
- [ ] Editar transação existente (hoje: excluir e criar de novo)
- [ ] Excluir parcelamento/série inteira de uma vez (a série já pode ser encerrada no painel)
- [ ] Notificação por e-mail/push de vencimentos
- [ ] Login com Google
- [ ] Exportar CSV/Excel
