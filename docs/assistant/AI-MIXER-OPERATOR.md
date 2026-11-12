# Operador de mesa por linguagem natural — LAB

## Fluxo e fronteiras

O assistente existente passa a resolver canais e destinos cadastrados antes de preparar propostas. Comandos simples funcionam offline pelo parser determinístico; frases adicionais usam o provedor/modelo escolhido **nesta sessão** pelo catálogo e `AiRouter` (`mixer_operator`). Ollama, Gemini, DeepSeek, Anthropic e OpenAI continuam utilizando seus adaptadores existentes, consentimento, orçamento, limites e registro de uso. Nenhuma SDK/ferramenta de execução é oferecida ao modelo.

O modelo devolve apenas `MixerInterpretation` versão 1, validado estritamente em `src/assistant/mixer-operator/contracts.ts`. Não recebe autoridade para aprovar, escolher fontes não mencionadas, fornecer valores de ajuste ou enviar comandos de rede. A aplicação extrai dB expressamente informados ou usa o passo configurado, identificado no cartão para revisão humana. Sem uma fonte/destino inequívoco, pergunta antes de preparar. Falhas, timeout, revogação, troca de modelo e mudança de contexto descartam a resposta; não há repetição nem troca silenciosa de provedor.

A execução segue **ProposalBuilder → ServerCore.execute → controlador/fila existentes → adaptador LAB → leitura de retorno**. Não existe executor ou pilha de desfazer paralela. A única extensão do controlador é a prévia somente leitura, copiada, dos valores do próximo desfazer. Aplicar confere proprietário, expiração, autorização, estado e revisão novamente na fila. Ajustes críticos continuam no fluxo E2 de aprovação do servidor. A resposta do modelo ou um “sim” no chat jamais aplica um cartão.

REAL continua somente leitura: o assistente recusa propostas/escritas nesse modo, inclusive antes de entrar na fila. Não há alteração do protocolo físico, núcleo AutoConfig D, políticas de aprovação ou componentes Angular.

## Contratos para integração com o Agente A

A interface atual por WebSocket continua usando `assistant` e `proposal_apply`. O backend disponibiliza também adaptadores HTTP para **a mesma instância** do serviço:

| Rota POST autenticada | Entrada | Saída |
| --- | --- | --- |
| `/api/assistant/ask` | `{ "text": "Sobe 2 dB do violão no AUX 5" }` | `{ serverId, reply: AssistantReply }` |
| `/api/assistant/proposals/:id/apply` | `{ "requestId": "identificador-unico" }` | `{ serverId, ...ApplyReply }` |

`AssistantReply` em `src/assistant/service.ts` preserva `kind`, `question`, `options`, `proposals`, diagnóstico e detalhes técnicos. A interface deve enviar `options[].text` ou a resposta curta correspondente ao `label`. O esclarecimento fica isolado por sessão, limitado e expira com o TTL das propostas. Pedidos completos novos substituem o esclarecimento pendente. Uma pergunta de canal pode requerer selecionar a opção completa ou reformular o pedido.

`ProposalCard` conserva os campos anteriores. `bus` e `parameters[]` acrescentam destino exato, chave, valor anterior, alvo e revisão. Por compatibilidade, o campo histórico `destination: "FONES"` ainda representa AUX; para AUX numerado, use **`bus.aux`, título e chave**. Nunca deduza AUX1 desse rótulo. `-inf` é serializado como string, sem confundir com leitura desconhecida.

`ApplyReply.status` inclui `applied`, `awaiting_approval`, `recalculated`, `expired`, `not_found`, `nothing`, `failed` e `unconfirmed`. `verification` informa `confirmed`, `different` ou `unavailable`, com proveniência `lab_readback`. `unconfirmed` significa que a execução pode ter ocorrido: orientar conferência manual, nunca reenviar automaticamente. A interface atual apresenta esse estado pelo tratamento genérico de falha; uma visualização dedicada é integração futura, não componente implementado nesta entrega. Para `awaiting_approval`, acompanhar os cartões/resultados E2 já existentes: esta rota não aprova nem substitui o retorno posterior de E2.

As rotas não aceitam comando bruto, token de aprovação ou sessão escolhida no corpo; exigem o principal autenticado, validam Origin quando presente, impedem agentes MCP, não permitem cache e revalidam sessão após operações pendentes. Sessões de músico permanecem limitadas pelos vínculos e buses autorizados do servidor. O catálogo selecionável continua restrito ao operador; músicos utilizam o parser local e controles existentes.

## Conversas e cadastro

- **“Aumenta meu violão.”** → “No PA ou nos FONES?” → **“PA”** → cartão com valor anterior/novo → **Aplicar** → resultado confirmado pela leitura LAB.
- **“Abaixa um pouco o cavaco no PA.”** → passo configurado e cartão, sem alteração antecipada.
- **“Muta o canal 7.”** → pergunta destino quando o operador possui mais de um; **“PA”** → cartão de MUTE.
- **“Quanto está o surdo no PA?”** → leitura efetivamente disponível, conexão e revisão; nenhuma proposta.
- **“Abaixa o cavaco no retorno do Lucius.”** → só resolve se esse retorno tiver alias de AUX cadastrado. O nome do vocalista nunca cria vínculo de retorno automaticamente.
- **“Desfaz o último ajuste.”** → prévia do topo da pilha existente → Aplicar → mesmas revisões/permissões e leitura de retorno.
- **“Dê um reforço ao cavaco no PA.”** → intenção estruturada pelo modelo selecionado, passo configurado exposto no cartão; nenhuma execução até Aplicar.

O cadastro de produção atual tem **violão CH2 e voz principal Fred CH3**. O cenário solicitado “violão CH3/AUX5 +2 dB” utiliza uma fixture explicitamente diferente; não altera o mapa da banda. AUX5 só pode ser usado se cadastrado e permitido nas capacidades/políticas atuais. Não é habilitado automaticamente no cadastro de produção. Aliases compartilhados ou fonte e número conflitantes geram esclarecimento; músico não vinculado não ganha acesso por citar um nome.

## Diagnóstico e evidências

“O surdo CH8 está sem grave no PA” segue o diagnóstico progressivo M1 e a base técnica/RAG existentes. O contexto conhecido recebe `observations: OperatorObservations` versão 1: modo, conexão, revisão, fonte/destino, parâmetros com estado/capacidade e limitações. MUTE e nível são observações de controle, não medição acústica. HPF/EQ LAB são identificados pela capacidade `simulated_only`; não comprovam funcionamento físico. No REAL, valores apenas simulados são marcados `unsupported`.

Ganho de pré-amplificador, phantom, roteamento físico, AFS2, compressor/gate e espectro/SPL são explicitamente indisponíveis quando não integrados. A sequência é conferir fonte/destino e MUTE, verificar HPF/EQ somente quando disponíveis e pedir inspeção manual de ganho/roteamento/captação. Queixa do músico, observação e hipótese continuam separados. Não se identifica frequência de microfonia nem se corrige falta de grave automaticamente sem medições.

O diagnóstico M1 continua limitado aos destinos PA e FONES/AUX1 que já suporta; não oferece novo diagnóstico de EQ por AUX5 nem novo contrato AutoConfig. Os modelos recebem apenas estado da fonte/destino confirmado e histórico de operações estruturado e limitado; não recebem chaves, tokens ou logs brutos.

## Verificação e limites

`test/mixer-operator.test.ts` cobre comandos, fontes/destinos reais e fictícios, ambiguidades, limite/criticidade, revisão concorrente, desfazer, desconexão, permissões, diagnóstico sem áudio, cinco provedores falsos, timeout/erro, seleção e sessão revogadas, validação de JSON, leitura divergente e bloqueio REAL. A verificação REAL usa exclusivamente o adaptador LAB com identificação de modo alterada no teste e spies; não instancia/conecta hardware físico. `test/e2e/mixer-operator.test.ts` exercita pergunta, AUX5, Aplicar e desfazer na interface existente com Chromium e servidor LAB.

Avaliação consentida com provedores reais e ensaio físico não foram executados. Testes simulados não comprovam firmware, áudio ou segurança física. F0 permanece manual e supervisionado; E6 e novas escritas REAL não estão habilitados.
