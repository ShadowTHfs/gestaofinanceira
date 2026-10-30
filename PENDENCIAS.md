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
- [ ] Parte 4 — Open Finance real com Pluggy (Edge Functions no Supabase + Pluggy Connect), começando pelo Sandbox
      · Confirmar com a Pluggy se o "Meu Pluggy" pode ser usado gratuitamente no seu caso

## Melhorias futuras
- [ ] Editar transação existente (hoje: excluir e criar de novo)
- [ ] Excluir parcelamento/série inteira de uma vez (a série já pode ser encerrada no painel)
- [ ] Notificação por e-mail/push de vencimentos
- [ ] Login com Google
- [ ] Exportar CSV/Excel
