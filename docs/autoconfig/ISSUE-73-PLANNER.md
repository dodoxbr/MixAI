# Issue #73 — planejador técnico AutoConfig (LAB)

Implementação original: main `f399939`, branch `feature/autoconfig-ai-planner`. AGENTS.md, Issues #43,
#44, #65 e #73 e skills mixai-mesario, live-sound-consultation e soundcraft-ui16-safety
foram lidos. O escopo #73 prevalece sobre atribuições históricas nas skills.

A integração com main/PR #80 está em [INTEGRATION-78.md](INTEGRATION-78.md). O motor puro descrito abaixo permanece independente; a composição do servidor oferece conselho autenticado e contexto efêmero M1.

## Fronteira entregue

O planejador é funcional por `src/autoconfig/planner/index.ts` (reexportado por `src/autoconfig/index.ts`), independente de diagnóstico,
UI e execução. `AssistantService` ganhou apenas projeção somente leitura por sessão para conselho, sem alterar decisões de M1. A integração adiciona uma rota explícita de conselho, sem botão ou caminho de execução automático. O núcleo D pode injetar o port `AutoConfigPlannerPort`; B recebe a
união discriminada `question | proposal | refusal` e o adaptador de respostas.

Não é uma segunda implementação de mixer, fila, autorização, LLM ou RAG. O adaptador
KB usa os procedimentos/manuais versionados de #65 e o cadastro ChannelMap, com o
pacote de microfones existente quando fornecido. O adaptador de provedores usa
**os mesmos GeminiClient/OllamaClient**, sem mudar seus prompts de diagnóstico,
configuração, política de rede, modelos, chaves, fallback do diagnóstico ou cache.

O teste arquitetural anterior foi ampliado **apenas** para os dois novos consumidores
explícitos (`planner/kb-adapter.ts` e `planner/provider-adapter.ts`). A pureza da base continua exigida;
um teste novo impede imports de mixer, servidor, diagnóstico, filesystem e mecanismos
de execução pelo motor. Não se flexibilizou um gate de escrita para passar CI.

## Entrada e evidência

`plannerInputSchema` é estrito, exclusivamente `mode:LAB`. Recebe uma fonte/canal,
destino PA/FONES, sintoma, objetivo, relato humano classificado, comparação entre
destinos, isolamento/conjunto, estado de contenção de feedback e referência LAB opcional.
Instrumento informado é uma restrição a conferir contra o cadastro, não um override.

```json
{"mode":"LAB","channel":8,"destination":"pa","symptom":"magro","goal":"body","comparison":"target_only","isolation":"alone","report":{"id":"report-surdo","kind":"musician_report","symptom":"magro","detail":"Relato de falta de grave; causa não validada."}}
```

O relato permanece `reported_not_measured`, inclusive quando veio do operador.
Texto livre é descartado após validar a entrada: não participa da seleção, output,
fingerprint, logs ou prompt. Nome escrito pelo usuário não autentica identidade.
Fader/MUTE não comprovam falta de grave, espectro, SPL ou microfonia.

Referência opcional: `{id, version}`. O port `PlannerObservationPort.read` deve ser
implementado **pelo núcleo confiável D**, nunca por um booleano do request. Só aceita
observação LAB tipada do mesmo canal/destino/referência, com revisão, idade até 60 s
(default) e timestamp não futuro. Os valores de fader/MUTE são estado de controles,
nunca áudio; `null` indica desconhecido, não −∞. Não se inventa medição REAL.

Sem observação, ainda é possível propor **inspeção sem alteração**, com limitação
explícita e retorno indisponível. Referência fornecida mas inválida/antiga é recusada;
não cai para snapshot imaginário. A observação é conferida novamente depois do modelo:
se mudou, descarta o plano. Estado parcial não é retorno completo.

## Pergunta única e contexto progressivo

`TechnicalPlanner.plan` retorna uma pergunta relevante por vez: fonte, destino,
sintoma, contenção de feedback, relato, objetivo, comparação ou isolamento. Campos já
preenchidos não são perguntados novamente. Fontes vêm apenas do cadastro: voz ambígua
pode oferecer CH3–7 sem presumir identidade. AUX1 conhecido não é confundido com PA.

`answerPlannerQuestion(input, result, value)` aplica somente uma escolha da pergunta
atual e devolve a nova entrada. Confere fingerprint da entrada normalizada; resposta
antiga ou campo/valor forjado falha. O chamador conserva essa entrada entre turnos.
O fingerprint **não** é sessão, credencial ou autorização; D deve escopar contexto por
principal e aplicar sua própria revisão/TTL/concorrência. O motor puro não cria store de sessões. Na composição do servidor, um cache limitado e efêmero guarda somente projeções M1/respostas consultivas por principal; não persiste conversas nem compartilha contexto.

Apito ativo: interromper escuta e chamar operador, sem modelo. Se não sabe se o apito
foi contido, não gera proposta. Modelo só entra após confirmar contenção e operador.
Não fazer ring-out nem supor frequência problemática.

## Modelo com saída restrita

Com contexto suficiente, o KB oferece até três inspeções compatíveis, todas com
proveniência e versão. O modelo recebe somente enums de contexto/papel, alias `source1`,
relato `e1` classificado e títulos públicos/versões de candidatos `s1..s3`. Não recebe
nomes, números de canal, texto livre, snapshot, IDs de referência, credenciais, IPs,
paths ou documentos privados. A seleção é estruturada:

```json
{"kind":"proposal","candidate":"s1","evidence":["e1"]}
```

Ou abstém-se por falta de base/segurança. Não há ferramentas, tool schema, callbacks de
execução, valores, comandos, referências ou justificativas livres vindas do modelo.
JSON com campos extras, candidato inexistente, citação/evidência inventada, frequência,
valor, tool call ou prosa é recusado, sem expor o texto e sem usar outro modelo para
contornar a guarda. O motor expande a escolha usando **dados do servidor**, não trata
texto de LLM como fato ou autorização.

A proposta contém um canal/destino, exatamente uma sugestão, objetivo/justificativa
condicional, risco médio/alto, pré-condições, fontes, verificações, limitações e retorno
humano. Fred lead/coro são papéis do cadastro; não há offset fixo entre vozes. AUX1
compartilhado eleva o risco e considera os demais músicos. Surdo sem grave não autoriza
boost, HPF, inversão de fase ou dedução de limitação do PA sem verificar.

**Esta etapa produz propostas de inspeção/revisão, não presets ou ajustes numéricos.**
`targetValue:null`, `execution:not_executable`, `authorization:not_granted`,
`realWrites:false`, `requiresHumanReview:true`. Um estado de fader não fundamenta EQ,
ganho, phantom, AFS2 ou cena. Esses parâmetros e lotes não podem entrar como comandos
na entrada/saída estritas. O UUID da proposta não é aplicável pela fila existente.

Retorno nunca é automático. Se não houver estado anterior completo, interromper e
chamar operador em vez de fabricar valores. Mesmo havendo registro LAB completo,
D precisa conferir revisão, segurança e aprovação humana antes de qualquer operação
futura, inclusive retorno a estado que ainda seja seguro. Não foi implementada execução.

## Configuração, seleção e consentimento

`createConfiguredPlanner(loaded, names, deps)` recebe configuração **já carregada**.
Não lê env/arquivos de segredos, não pede chave nova, não grava preferência, não instala
modelo, não sobe serviço e não abre mesa. Apenas o adaptador passa ao GeminiClient a
chave já existente em `loaded.secrets`; o motor e prompts nunca a recebem.

Requisitos da factory:

- `loaded.config.mixer.mode=lab`, `knowledge.enabled` e policy habilitada/ativa;
- para chamar modelos, o flag de geração já existente `knowledge.ollama.narrative=true`;
  desligado mantém proposta determinística sem sondar serviços;
- Gemini só é registrado com `knowledge.gemini.enabled`; sem chave o cliente existente
  não faz requisição e informa auth. Não foram feitas chamadas reais neste ensaio;
- o port de policy fornece seleção **atual**, consentimento externo existente,
  revisão monotônica e atividade da sessão. Deve vir do fluxo autenticado atual
  (como seleção de `LocalKnowledge.providers()` e consentimento já confirmado),
  **nunca** de JSON do usuário/modelo. Configuração não fabrica consentimento;
- selecionado Gemini + consentimento: tenta Gemini e usa Ollama local como reserva;
  selecionado Ollama: não chama Gemini para comparação sem autorização;
- Qwen3 só é usado quando `knowledge.ollama.chatModel` já aponta para esse modelo;
  não renomeia Llama como Qwen e não troca modelo globalmente. Ollama permanece loopback,
  conforme validação existente, com defesa adicional no adaptador;
- falta de consentimento pula qualquer provedor externo. Falhas de disponibilidade,
  auth, quota, recitação ou truncamento podem usar reserva; recusa de segurança e saída
  inválida encerram. Sem serviços disponíveis, usa a mesma inspeção determinística.

O deadline do motor é 5 s por tentativa por padrão (configurável pelo integrador),
duas tentativas no máximo. Os clientes mantêm seus próprios timeouts. Não se alterou
o limite de tokens do Ollama: a resposta de seleção é curta e cabe no contrato.
Uma chamada já enviada pode continuar no cliente após timeout do motor; resultado
atrasado é ignorado, não dispara replay, proposta tardia, ferramenta ou escrita.
Revogação, troca de seleção/revisão ou retirada de consentimento durante geração
invalidam o resultado e impedem novas tentativas.

`PlannerProvider` aceita eventual outro adaptador somente de texto, sem chave exigida
agora. A política e as mesmas guardas continuam válidas. Não há bypass de consentimento
via fallback nem envio de documentos locais ao Gemini.

## API pura e composição B/D

```ts
// API pura; o endpoint integrado e seus guardas estão em INTEGRATION-78.md.
const planner = createConfiguredPlanner(loaded, names, {
  microphones: existingPack.microphones,
  policy: () => currentTrustedPlannerPolicy(),
  observations: { read: ref => validatedLabObservationFromCore(ref) },
});
const result = await planner.plan(accumulatedInput);
// B renderiza result.kind; D conserva autenticação/contexto e revisão.
// Nenhum ramo chama core.execute, proposal_apply ou RealMixer.write.
```

`plannerInputFromConsultation(consultation, goal)` adapta dados estruturados do
diagnóstico, sem editar A1/A2: aproveita relatos compatíveis e **não** promove leituras
`caller_declared_not_verified` a observações validadas. Observação só vem do outro port.
IDs legados devem respeitar o formato limitado do contrato; incompatibilidade falha
fechado em vez de adivinhar identidade/evidência. Exportações e fixtures ficam em
`src/autoconfig/index.ts`; D pode mockar `AutoConfigPlannerPort` sem importar serviços.

## Testes e evidências

```sh
npm exec -- tsx scripts/autoconfig-rehearsal.ts work/issue73-comparison.json
npm exec -- vitest run test/autoconfig-planner.test.ts test/autoconfig-boundary.test.ts test/autoconfig-evaluation.test.ts
```

[Comparação reproduzível](issue73-comparison.json): quatro casos nos dois caminhos
Gemini e Qwen/Ollama, mais respectivas recusas de REAL: 8 propostas fundamentadas e
8 recusas corretas em **fixtures**. Registra fontes, pré-condições, validação, retorno,
alvo numérico ausente e ausência de autorização, não fluência.

Isso **não mede qualidade de modelos reais**, ganho acústico nem adequação de firmware.
Também testamos os clientes existentes com HTTP falso, confirmando modelo Qwen3 e
nenhum campo tools. Não se acessaram chaves, APIs, serviços locais de IA, ROG ou hardware
para avaliação real. Chamadas de produção requerem configuração/consentimento existentes.

Testes cobrem perguntas progressivas, fonte indisponível, offline, schema estrito,
medição falsa, comandos/ferramentas, críticos/lote, falta de consentimento, recusa,
timeout/truncamento, referência antiga/trocada/REAL/parcial, sessão revogada, privacidade,
leituras declaradas, isolamento e ID não aplicável no protocolo existente. O ensaio
com servidor MOCK confirma zero builder/execute/RealMixer.write e fila/estado intactos.

Resultados completos e CI Windows/Ubuntu/Caddy/smoke constam no PR do SHA final.
Integração das telas B e avaliação consentida com modelos reais, julgamentos
subjetivos de utilidade e qualquer teste físico continuam pendentes. #43/#44 não
liberam E6; nenhuma conexão/escrita REAL, rede Windows ou política de segurança mudou.
