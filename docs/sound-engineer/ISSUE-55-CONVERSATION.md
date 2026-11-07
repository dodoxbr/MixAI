# Issue #55 — diagnóstico conversacional progressivo

Branch `feature/mixai-conversational-diagnosis`, base `dad558a` (main com #51, #52,
#53 e #54). AGENTS.md, Issues #48/#55 e skills de mesário, consulta ao vivo,
segurança Ui16 e instrumentos samba/pagode foram lidos. Esta entrega é de backend;
nenhum arquivo de componente/protocolo de frontend, vínculo de músico, fila ou serviço de
referência do agente D foi alterado. Não há escrita REAL/E6 ou execução de serve:real.

## Comportamento funcional

O mesmo `DiagnosticContexts` agora mantém a investigação além de fonte/destino.
`consult` continua a consulta pura e sem estado; seu texto também ficou conciso.
Conhecimento, hipóteses alternativas, fontes, limitações e instruções completas
continuam em `diagnosis`, `references` e `technicalDetails.modules`.

| Relato/resposta | Próximo turno |
| --- | --- |
| Minha voz está abafada no retorno. | Confirma FONES/AUX1 compartilhado; pergunta qual vocalista. |
| Fred | Conserva relato/destino; pergunta se também acontece no PA. |
| Só no retorno | Pergunta se acontece também com a fonte sozinha ou só com a banda. |
| Só com a banda | Hipótese condicional de mascaramento e uma verificação de articulação/captação; pede resultado. |
| Nada evidente / Sem mudança | Avança à próxima inspeção, sem repetir a anterior. |
| Encontrei um problema | Registra achado relatado, encerra e encaminha revisão humana; não confirma causa nem cria pedido. |
| Melhorou | Registra melhora relatada, sem promover confiança ou alegar medição. |
| Piorou | Interrompe a investigação e orienta operador, sem reversão automática. |

Quando o relato diz “só no retorno, também sozinho” esses campos já ficam
respondidos. Se menciona PA e fones, escolhe-se primeiro um caminho e preserva-se
que ambos foram relatados; não se repete a pergunta de alcance. “Não sei”/“Ainda
não comparei” são respostas explícitas de desconhecimento, não loops de pergunta.
Cadastros e aliases determinam opções; na banda atual “minha voz” oferece CH3 Fred,
CH4 Lucius, CH5 Leandro, CH6 Fernando e CH7 Laviquinho, sem presumir quem escreveu.
Pares como surdo/tantã preservam as fontes relacionadas e oferecem os canais
pertinentes. Canal não cadastrado não é escolhido por aproximação.

Cada texto normal mira até 120 palavras, com uma pergunta pendente. Os testes
verificam esse limite e uma única interrogação nos cenários da banda. Não imprime
listas de módulos/fontes nem todos os porquês no chat. Guardas críticas continuam
visíveis: AUX1 compartilhado, ausência de áudio/RTA e nenhum ajuste; para microfonia,
interromper exposição desconfortável e nunca provocar ring-out com público.
A interface legada ainda pode exibir links de referência separadamente; seu painel
expansível é responsabilidade do agente B, não deste backend.

As inspeções usam a base técnica #48: voz/coro e dicção, pele/platinelas do pandeiro,
afinação/sustentação surdo–tantã, ataque/baixarias cavaco–violão, captação/DI e revisão
visual de HPF/EQ/dinâmica. São verificações manuais, não presets, medição ou comandos.
Consultar recurso documentado não comprova implementação/firmware físico.

## Contratos para B e D

Contrato público puro: `src/knowledge/sound-engineer/conversation-contracts.ts`,
exportado em `index.ts` e pelos tipos do adaptador `src/assistant/sound-engineer.ts`.
`diagnosticSessionSchema` valida a versão 1. Campo aditivo `reply.diagnosticSession`:

- `sessionId`, `revision`, `expiresAt`: identificam **a investigação**, nunca token,
  principal, credencial ou autorização. São nulos na consulta B3A sem estado.
- `knownContext`: fonte/canal, sintoma, instrumentos relacionados, destino, alcance,
  fonte isolada/conjunto, captação e resultados canônicos. Base é relato/cadastro,
  nunca medição. Resultado desconhecido é diferente de campo ainda não perguntado.
- `pendingQuestion`: ID, campo e texto, ou nulo ao terminar.
- `choices`: IDs/valores fechados e rótulos. Uma escolha vale só para a pergunta atual.
- `nextCheck`: instrução de inspeção, critério de resultado, rollback manual,
  `execution:not_executable` e revisão humana obrigatória.
- `evidence`, `confidence`, `safety`, `references`: mantêm origem, baixa/insuficiente
  confiança, controles declarados não verificados, simulados e medições indisponíveis.

Campos de pergunta: `symptom`, `channel`, `instrument`, `destination`, `report`,
`scope`, `isolation`, `capture`, `check`. Valores de resultado: `issue_found`,
`no_issue`, `better`, `same`, `worse`, `not_checked`. Achados/resultados são relatos;
não significam que um comando foi aplicado ou que houve análise acústica.

B pode usar `diagnosticAnswerFor(session, choiceId)` para montar **somente** texto de
rótulo e `{id, revision}`. Não reenviar o objeto de sessão, evidência ou identidade.
O backend não aceita `progress`, `diagnosticSession`, `approval` ou `principalId` no
corpo. A UI atual continua enviando rótulos com revisão por `assistant_conversation`;
os botões/fluxos existentes são cobertos por E2E sem mudar componentes de B.
O campo legado `diagnosticContext.field` passa a admitir os campos novos; a interface
atual só o projeta e usa a pergunta/rótulos, sem decidir autorização por esse campo.

D pode consumir `recommendationFromDiagnostic(reply)` como adaptador estrutural do
seu port: `source:diagnosis`, status, texto curto, URLs e sessão, com `applicable:false`
e `requiresOperatorReview:true`. Esse adaptador não cria/edita solicitações, não liga
identidade e não executa ações. O `referencePortsOf` já incorporado segue consultando
`consult` sem estado; relato `musician_report/unverified` conserva a origem e não gera
ensaio de ajuste por suposta confirmação do operador. Integrar progressão à jornada
de solicitações é trabalho posterior de D, com suas próprias verificações.

## HTTP/WS e compatibilidade

Os endpoints, autenticação e envelope `{serverId, reply}` continuam iguais:

```json
{"text":"Minha voz está abafada no retorno."}
```

Enviar a resposta pelo mesmo endpoint `POST /api/assistant/conversation` ou pelo
WS `assistant_conversation`; o chat `assistant` também usa a mesma máquina:

```json
{"text":"Fred","context":{"id":"00000000-0000-4000-8000-000000000055","revision":1}}
```

O UUID acima é ilustrativo: usar o ID recebido. O arquivo
[exemplo de sessão](examples/issue55-session.json) é uma fixture integral validada
por teste, não sessão real. `diagnosis`, `diagnosticOptions`, `references`, `text` e
`diagnosticContext` permanecem disponíveis. O texto mudou intencionalmente para ser
curto. Hipóteses e justificativas completas ficam nos dados, não foram removidas.

`POST /api/assistant/diagnose`/WS `assistant_diagnose` continuam sem estado:
preenchem campos básicos ou retornam orientação curta com dados técnicos completos.
Não alteram implicitamente uma investigação pendente. Não há novo endpoint de
aplicação e nenhum ID de pergunta/hipótese/sessão é um ID de proposta.

A conversa permanece exclusiva do operador conforme a política já existente.
Músicos continuam usando a jornada autorizada de solicitações/identidade já integrada;
um nome como “Fred” seleciona uma fonte e **não autentica nem vincula uma pessoa**.
Sessão revogada, músico, agente ou usuário não autenticado continuam recusados.

## Estado, concorrência e sanitização

Um único mapa por `AssistantService`, indexado pelo ID do principal autenticado do
servidor. Não há segundo motor de sessões, LLM, banco ou disco. A transição é síncrona,
sem await entre conferir revisão e atualizar. Duas respostas da mesma revisão não
avançam duas vezes; referência de outra sessão não expõe o contexto alheio.

Mantidos TTL **absoluto de 5 min**, 128 investigações, 256 contadores e 20 consultas/min
por sessão. Inválidos, detalhes e respostas válidas não renovam TTL. Cancelar com
revisão atual continua disponível no limite de taxa. Reiniciar cria outro ID e
remove o relato anterior. Finalizar, cancelar, logout, expiração e parar o servidor
eliminam o registro. Comando explícito continua na rota E4/E2 já protegida e limpa a
investigação; a conversa técnica explícita recusa comandos em vez de gerar propostas.

Repetir a mesma queixa é idempotente: não duplica relato ou reinicia perguntas.
Novos relatos anafóricos preservam fonte/destino; novo sintoma invalida comparações
que precisem ser refeitas. Nova fonte explicitada inicia outra investigação. Correção
“na verdade, só no PA” preserva fonte/sintoma, invalida comparação do caminho e mantém
TTL. Respostas ambíguas conservam pergunta e revisão. Não interpretar “sim”, “confirmo”
ou “aplicar” como aprovação genérica de inspeção/ação.

Texto de entrada até 500 caracteres. Guarda apenas contexto estruturado, até 20
relatos necessários e no máximo três resultados canônicos de inspeção; não guarda
transcrição livre das respostas. Limite de relatos recusa acréscimo, sem expulsar
contexto de outro usuário. Remove controles/bidi e padrões explícitos de credenciais
ou endereços do conteúdo efêmero. Isso minimiza dados; não promete anonimização de
qualquer texto pessoal voluntariamente incluído no relato. Não há log de conteúdo,
broadcast, envio a IA ou restauração de faders/referência.

## Validação e limites

Testes cobrem o exemplo vocal, contexto conhecido, fonte/PA/AUX, desconhecido explícito,
múltiplos sintomas, pares instrumentais, correção, nova queixa, idempotência, uma
pergunta, texto curto, confirmação conceitual, achado/melhora/piora, fonte indisponível,
modelos offline, revisões concorrentes, limites, reset/TTL/logout e sanitização.
HTTP/WS verificam zero chamadas a builder/execute/IA/escrita REAL ou simulada, nenhuma
pendência e preservação de mudança externa simulada. IDs forjados não podem ser
aplicados como propostas. Dados estruturados forjados não viram autoridade.

As regressões antigas que esperavam encerrar após PA foram ampliadas até terminar as
verificações. As que esperavam o relatório no texto agora verificam o mesmo conteúdo
em `diagnosis`/`technicalDetails`, preservando as asserções de segurança e conhecimento.
Testes E2E foram adaptados ao comportamento novo do backend, sem editar a interface.

Resultados e CI do SHA final constam no PR. Windows local, Yoga/touch físico, áudio,
firmware, microfones, RTA e Ui16 permanecem **não validados nesta entrega**. Nenhuma
frequência foi detectada; nenhum comando REAL foi executado. A base #48 continua
theory. Perguntas/respostas usam vocabulário determinístico e opções: texto livre
não reconhecido pede esclarecimento, não inventa dados ou chama modelo no contexto.
