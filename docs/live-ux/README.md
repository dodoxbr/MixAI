# Operação ao vivo — interface Angular

A Mesa mantém faders, cenas, passagem de som e ferramentas existentes. Toque no nome de um canal para abrir **Canal selecionado**: nome do cadastro, PA/AUX, fader, mute e revisão do espelho recebido pelo WebSocket. O seletor muda a visualização; não aplica ajustes. Histórico e Desfazer reutilizam os comandos existentes, sujeitos à autorização e às proteções do servidor.

## Informação e confirmação

- LAB/MOCK são simulações. Medidores simulados não representam áudio real.
- Sem conexão, leitura disponível ou snapshot coerente, valores atuais são ocultados e controles de ajuste ficam bloqueados. Uma lacuna de revisão exige novo snapshot.
- O resumo de alterações recentes reúne até oito mudanças de parâmetros observadas **desde a abertura** do painel. Não atribui autoria e não substitui o histórico do servidor; não detecta alterações que o backend não observou. Nunca restaura um valor automaticamente.
- A proposta usa exclusivamente canal, destino, atual e proposto fornecidos pelo servidor. Confirmar envia o identificador da proposta; Cancelar descarta-a. Enquanto aguarda, não permite reaplicar. Master preserva o cartão de aprovação especial; valores alterados geram o fluxo existente de recálculo.
- `applied_simulated` é apresentado como simulação. `sent` significa envio sem confirmação física. Resultado ausente, parcial, indeterminado ou conexão perdida não prova conclusão e não dispara repetição automática. O fader atual continua vindo do estado sincronizado, não do valor desejado na proposta.
- A confirmação final física não está disponível nestes contratos. Um retorno HTTP/WS bem sucedido não é confirmação da Ui16.

## Destinos e dependências

O assistente atual propõe PA, FONES, MASTER e DESFAZER. **FONES corresponde ao `musicianAux` informado pelo servidor**, normalmente AUX1 compartilhado por todos no HA800. Um pedido que mencione outro AUX ou um AUX não identificado com segurança é bloqueado antes do envio para evitar sua interpretação como FONES. Não há nova interpretação de comandos no navegador.

O painel lista somente AUX do cadastro retornado por `list_names`. AUX adicionais podem ser usados pelos controles manuais existentes em LAB/MOCK; a interface mantém a restrição ao AUX configurado em REAL. Não adiciona rotas ao cadastro nem comprova roteamento físico. A configuração atual da banda cadastra apenas AUX1. A expansão conversacional para AUX arbitrário depende de suporte explícito do backend (parser, proposta, autorização e resultado); não foi inventado contrato para isso.

As verificações guiadas consomem `diagnosticSession` v1 (`nextCheck`, `knownContext.results`; aceita também a projeção legada `conversation`) e recomendações `not_executable` já retornadas pelo diagnóstico. São sugestões teóricas progressivas: o contrato conversacional fornece uma verificação por vez; sem próximo passo, exibe as recomendações recebidas, sem inventar um plano. Melhorou/piorou e demais resultados são **relatos humanos**, nunca medições ou confirmações pela mesa. O fluxo de perguntas e respostas existente permanece disponível; a lista não contém controles de EQ/HPF/ganho. Se não houver dados estruturados, conserva a resposta e detalhes existentes, sem criar um checklist fictício.

Nenhuma alteração no backend, núcleo D, autenticação, executor, adaptadores de IA ou protocolo físico. Nenhum endpoint novo. O estado observado e os resultados têm escopos distintos: o último retorno é explicitamente da última operação de qualquer canal, não uma confirmação do canal selecionado.

## Validação

Testes Angular cobrem classificação de resultado, seleção somente visual, mudanças observadas, lacuna de revisão, troca de sessão, bloqueio de AUX incompatível, resposta atrasada e diagnóstico teórico. E2E LAB cobre desktop, Yoga emulado e celular, nomes acessíveis/teclado, alvos de toque, troca de canal/AUX, histórico, cancelamento, pendência, retorno simulado, desfazer e desconexão. As suítes existentes cobrem regressões de faders, cenas e aprovações.

Capturas reproduzíveis de Chromium com estado LAB sintético: [desktop](screenshots/desktop.png), [Yoga](screenshots/yoga.png), [celular](screenshots/celular.png). O teste `test/e2e/live-ux.test.ts` as atualiza. Não contêm credenciais ou dados reais de apresentação.

Pendências físicas: ergonomia no Yoga/Android reais, leitor de tela real, latência e reconexão da rede da banda, visibilidade sob iluminação de palco e confirmação física de estado. Testes de navegador não comprovam essas propriedades. Escrita REAL e aquisição física não foram executadas nem habilitadas.

Resultado local: `npm test` — 1511 passaram, um teste condicional de Windows ignorado neste Linux. O build Angular conserva o alerta de orçamento inicial (limite de aviso 400 kB; pacote desta entrega aproximadamente 454 kB), sem ampliar o orçamento. Demais resultados e CI no resumo do PR.

Transportes reutilizados: `hello`/`snapshot`/`event` para modo e estado; `fader_result` para retorno do gesto; `command` (`list_names`, `history`, `undo`) para cadastro/histórico/desfazer; `assistant`/`assistant_conversation`/`assistant_diagnose`, `proposal_apply`/`proposal_cancel`, `proposal_result` e cartões `pending` para os fluxos existentes. `ApplyReply.result` já é retornado pelo servidor; o tipo frontend agora o declara. Nenhuma rota ou resultado de execução foi criado no navegador.
