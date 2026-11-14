# PR #105 — timeout no E2E de desconexão AutoConfig

## Evidência original e isolamento

- PR investigado: [#105](https://github.com/dodoxbr/MixAI/pull/105), SHA `79dfaadaa2035d941a27542d083f37c033a358e6`.
- [CI, tentativa 1, job Ubuntu](https://github.com/dodoxbr/MixAI/actions/runs/43544587513/job/132292795540): 155 cenários E2E passaram; um falhou em `test/e2e/autoconfig-end-to-end.test.ts:245:75`, esperando por 15.000 ms o texto `Sem conexão — ações bloqueadas`.
- A tentativa seguinte do mesmo SHA terminou verde. Esse resultado isolado não elimina a intermitência.
- A correção foi desenvolvida sobre a main `4f221e60956832a68d66524f13da984517e486bb` (#104), em branch/worktree próprias. O arquivo original do teste é idêntico na main e no #105: SHA-256 `a3a4be1017a9584804103b0fc3e67d25eb6bb92f763356d61f614cf64b5d59e1`.
- O teste original foi executado, sem alterações, em uma cópia destacada do SHA #105. Nenhuma branch do Agente A foi alterada ou recebeu push.

## Reprodução e causa observada

Ambiente local: Linux, Node 24.22.1, Playwright 1.63.0, Chrome Headless Shell 153.0.8010.12 (v1243, instalado pelo próprio Playwright, como na CI). A versão do Node/OS local não é apresentada como réplica exata do runner Ubuntu/Node 22.

Comando do cenário original:

```sh
npm exec -- vitest run --config vitest.e2e.config.ts \
  test/e2e/autoconfig-end-to-end.test.ts -t 'perda de conexão'
```

Execuções originais 1–5 passaram. A execução 6, sem instrumentação, falhou na mesma linha 245, com o mesmo `locator.waitFor: Timeout 15000ms exceeded` da CI. O processo de repetição parou nessa falha; não se configurou retry para transformá-la em sucesso.

Em uma série separada de 20 reproduções instrumentadas da mesma sequência, uma também falhou. O diagnóstico registrou somente tipos de eventos e tempos relativos; não coletou tokens, payloads, PINs ou endereços:

| Tempo relativo (ms) | Evento no navegador |
| --- | --- |
| 358 | WebSocket construído |
| 378 | `open` |
| 382 | `hello` |
| 388 | `snapshot` |
| 904 | `offline` do navegador |
| Até terminar a espera de 15 s | Nenhum `close`/`error` nem nova conexão entregues à página |

Após a espera, o servidor LAB tinha **zero clientes WebSocket**, `navigator.onLine` era **false**, mas o cabeçalho ainda dizia **“Sessão conectada”** e o botão da pergunta anterior continuava presente.

O fixture original colocava o contexto offline **antes** de terminar o socket do servidor. Essa combinação pode deixar de notificar o fechamento ao JavaScript da página na emulação do navegador. A asserção esperava uma transição da aplicação que a injeção de falha não garantia produzir.

`LiveService` altera `connection` no seu `ws.onclose`; `AutoConfigService.connected` deriva desse estado. Nenhum deles recebeu uma notificação de fechamento na reprodução problemática. A lógica de `onclose` e o componente AutoConfig não foram alterados pelo #105; suas mudanças no `LiveService` tratam nomes e respostas obsoletas de `list_names`.

**Classificação:** instabilidade reproduzida na injeção/sincronização da falha do E2E; não foi demonstrada regressão funcional introduzida pelo #105 nesse cenário. Os logs históricos da CI não incluem trace de navegador: a sequência instrumentada explica uma reprodução com a mesma assinatura, sem afirmar conhecimento adicional sobre os detalhes internos daquela execução do Chromium.

## Correção restrita ao teste

1. Interceptar apenas o WebSocket `/ws` da aplicação LAB pelo controle de WebSocket do Playwright. Quando saudável, `connectToServer()` encaminha as mensagens ao servidor real de teste, sem fabricar `hello`, snapshots, respostas do planejador ou autorizações.
2. Ao iniciar a indisponibilidade, fechar explicitamente a ponta do navegador e terminar os sockets do servidor. Não depender da entrega de um fechamento TCP depois de ativar a emulação offline.
3. Recusar reconexões até concluir as asserções offline. O teste exige observar pelo menos uma reconexão bloqueada enquanto HTTP ainda está disponível: a condição não é apenas um frame transitório da UI.
4. Ativar também `setOffline(true)` para verificar a mesma proteção com HTTP indisponível.
5. Restaurar o transporte em `finally`, antes de continuar a verificação original de reconexão, contexto M1, invalidação da pergunta, sessão encerrada e ausência de planos/escritas.

O timeout original de **15.000 ms** foi mantido. Não se aumentou o timeout global, não se adicionou retry e não se removeu nenhuma asserção original. A nova espera de reconexão bloqueada usa o mesmo limite e verifica uma condição adicional. Não há sleeps arbitrários no teste corrigido, alteração de sinais Angular ou bypass de autorização.

## Validação e limites

- Cenário corrigido: **20 execuções consecutivas aprovadas**, em processos de teste independentes.
- Arquivo AutoConfig completo: **5 cenários aprovados**, incluindo Yoga/celular, provedores falsos, consentimento, permissões, desconexão, contexto e expiração.
- Compatibilidade com #105: os **5 cenários passaram** também na cópia destacada do SHA original, aplicando somente este patch ao teste. O arquivo foi restaurado ao encerrar; nenhuma referência/branch do Agente A foi modificada.
- Typecheck/build e regressões adicionais são registrados no resumo do PR independente e na CI do seu SHA final.

Esta mudança testa a reação da aplicação a uma **desconexão WebSocket notificada**, com indisponibilidade sustentada pelo fixture. Não implementa nem comprova detecção de TCP silencioso/blackhole sem `close` em redes reais; essa é outra propriedade, que exigiria análise própria. Também não comprova comportamento de firmware ou segurança física.

Nenhum código de produção, comunicação física, núcleo D, mixer, gate REAL ou componente Angular foi alterado. Todos os cenários usam servidor LAB, loopback e provedores falsos; nenhuma chamada paga nem conexão com a Soundcraft física foi realizada. As evidências completas locais ficaram fora do Git; este documento contém apenas o resumo sanitizado relevante.
