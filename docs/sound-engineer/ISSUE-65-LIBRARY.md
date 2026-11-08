# Issue #65 — biblioteca técnica e Instrutor somente leitura

Base de trabalho: main `632f25e9572416fd3d539ba9a88639fdb848811f`, que incorpora
PR #67. Branch `feature/sound-engineer-knowledge-v2`. AGENTS.md, Issue #65 e skills
mixai-mesario, live-sound-consultation, soundcraft-ui16-safety e
samba-pagode-instrument-consultation foram lidos integralmente. O escopo atual da
issue prevalece sobre as divisões históricas de agentes nas skills.

## Inventário e integração

| Existente | Uso nesta entrega |
| --- | --- |
| `src/knowledge/sound-engineer` | Motor determinístico v2, procedimentos, fontes e papéis musicais preservados. Biblioteca de campo e contrato do Instrutor adicionados, versão própria 1.0.0. |
| `knowledge/seed/banda-v1_2` | Catálogo, seis casos e modelos/canais mantidos integralmente; cadastro P3 S não duplicado. |
| `src/knowledge/local` | Mesmo KnowledgeStore arquivo/PostgreSQL, busca keyword/vetor/híbrida e filtros por modelo. Nova importação usa esse contrato. |
| `GeminiClient` / `OllamaClient` | Infraestrutura #67 preservada: seleção, privacidade, fallback, truncamento, teto de geração e thinkingLevel não reimplementados. |
| `knowledge/eval/relevance-ptbr.json` | 24 perguntas e critérios anteriores preservados byte a byte. 12 casos adicionais ficam em arquivo separado. |
| UI de B / solicitações e passagem de D | Nenhum arquivo de componente, protocolo web ou serviço D alterado. Contratos/adaptadores somente leitura disponíveis. |

A biblioteca acrescenta 15 conteúdos originais: clareza vocal, nasalidade/sibilância,
proximidade, P3 S, microfonia PA, apito AUX, ganho/clipping, EQ/HPF, dinâmica,
surdo, tantã, pandeiro, cavaco, violão seis cordas P10 e mix compartilhada.
A consulta existente recebe os procedimentos em `technicalDetails.instructor`;
o texto do chat permanece conciso, sem despejar a biblioteca.

`sem grave`/`sem corpo`/`fino` indicam falta de corpo relatada; `sem brilho` indica
abafamento relatado; `nasal`/`anasalada` inicia investigação de processamento/captação,
sem atribuir uma banda medida. `microfonando` permanece relato de possível feedback.
`seco` é ambíguo: pergunta primeiro se falta corpo/grave ou sustentação/ambiência.
Não escolhe reverb, gate ou EQ automaticamente. Negação, pergunta e condicional não
viram evidência afirmativa; a ausência de verbo em “Surdo sem grave” pode ser relato.

## Perfil informado, sem diagnóstico físico presumido

| Canal | Informação e proveniência | Limite |
| --- | --- | --- |
| CH3 Fred | Lead; P3 S no pacote existente, `operator_report` | Priorizar dicção; modelo não comprova posição, resposta ou causa do abafamento. |
| CH4 Lucius / CH6 Fernando | Coro; P3 S no mesmo pacote | Não copiar EQ ou assumir ganho igual entre cantores. |
| CH5 Leandro / CH7 Laviquinho | Coro; modelo nulo, `unconfirmed` | Não inferir P3 S por pertencer ao coro. |
| CH2 | Violão de seis cordas via P10, informado na Issue #65 | P10 não confirma captador ativo/passivo, impedância, DI, balanceamento ou entrada usada. |
| CH8 | Surdo, relato “sem grave” na Issue #65 | Causa não validada; não recomendar boost para compensar PA, captação ou cancelamento não verificados. |

O alias legado “7 cordas” apenas resolve nome/canal; não confirma instrumento.
Os guias genéricos de seis/sete cordas continuam disponíveis como conceitos; o perfil
informado de CH2 nesta biblioteca é seis cordas. Reconfirmar se trocar o instrumento.
As atribuições mutáveis de microfones continuam exclusivamente no cadastro existente,
com origem do relato e filtros P3/P5 de #62. O procedimento P3 S fica no catálogo,
mas **não é automaticamente selecionado** pela consulta: esta não recebe confirmação
confiável de modelo; o enriquecimento existente resolve modelo por cadastro.

## Fontes e qualidade da evidência

Consulta em 2026-11-08; versões/datas e localizadores completos são resolvidos por
`sources.ts`/`citations`. Cada passo inclui fabricante, URL HTTPS, versão, seção e data.
A origem do procedimento é `mixai_editorial_adaptation`; não é texto ou preset do fabricante.

| Fonte | Versão / seção usada | Acesso nesta rodada |
| --- | --- | --- |
| [Yamaha Equalization](https://hub.yamaha.com/proaudio/livesound/eq/) | Artigo 2018-04-26, Advanced EQ: peak/dip, Q e filtros | Consultado. Exemplos numéricos de presets **não** foram importados. |
| [Yamaha Gain Staging](https://hub.yamaha.com/proaudio/livesound/gain-staging/) | Artigo 2018-03-22, compatibilidade de entrada, gain/trim e headroom | Consultado. Sem importar alvos numéricos de outra mesa. |
| [Yamaha Compressor](https://hub.yamaha.com/proaudio/livesound/tools-of-the-trade-how-to-use-a-compressor/) | Artigo 2017-10-27, Compression Advice | Consultado. Compressão excessiva e margem antes de feedback. |
| [Shure Placement](https://www.shure.com/en-EU/insights/three-reasons-why-mic-placement-matters) | Artigo 2014-09-24, SNR, Gain Before Feedback, proximity effect | Consultado. Eixo, distância, vazamento e proporção de graves. |
| [Shure Feedback](https://www.shure.com/en-US/insights/how-to-control-feedback-in-a-sound-system) | Artigo 2013-01-25, causa do loop, interrupção e posicionamento | Consultado. Sem reproduzir ring-out como ação permitida. |
| [Soundcraft Ui12/Ui16](https://www.soundcraft.com/en/product_documents/ui_usermanual_v3-0-pdf-27c992b4-5132-4d2d-b8e2-79750de6ee29) | EN v3.0 §§4.1, 4.3/4.3.1, 5.2, 5.3/5.3.1, 5.4 | HTTP 403 nesta rodada; reutilizada consulta documentada de 2026-11-07, sem alegar novo acesso ou firmware validado. |
| [AKG P3 S](https://br.akg.com/P3.html) | Ficha sem revisão indicada, padrão polar / dados do pacote banda-v1_2 | HTTP 403 nesta rodada; `historical`, dados preservados do pacote existente. Não confundir cardioide P3 S com P5 supercardioide. |
| [Issue #65](https://github.com/dodoxbr/MixAI/issues/65) | Escopo e perfil declarado da banda, 2026-11-08 | Consultada. Evidência de relato/configuração, não medição acústica nem manual. |

Shure Live e manual PT permanecem no catálogo anterior com seu histórico de acesso;
não houve nova consulta desses PDFs. Não foi contornado bloqueio HTTP. Nenhum manual
integral foi copiado para o repositório. Relações surdo/tantã, cavaco/violão e lead/coro
são síntese editorial de princípios de captação/EQ/dinâmica, **não** instruções de
fabricante específicas para samba, nem correções acusticamente comprovadas.

## Contrato e API para B

Exportações de `src/knowledge/sound-engineer/index.ts`:

- `InstructorProcedure`, `InstructorGuidance` e schemas Zod estritos;
- `instructorProcedures`: catálogo de instruções, nunca comandos;
- `queryInstructorGuidance(input)`: consulta pura, sem core, store, modelo ou rede;
- `instructorFixtures()`: saídas tipadas fictícias para voz abafada, surdo sem grave
  e falta de evidência; não compartilhar objeto mutável entre sessões.

O procedimento contém id/versão, finalidade, instrumentos/sintomas, escopo
`official_ui_readonly` (o contrato também admite LAB), pré-condições, etapas,
nomes de controles do manual, verificação, “não encontrei”, riscos e proveniência.
Nomes de controles são rótulos documentais, não seletores, endereços ou parâmetros.
Cada etapa é texto editorial. A disponibilidade na versão física deve ser confirmada;
“não encontrei” manda parar, conferir manual/firmware/canal e chamar operador.

Com conhecimento opcional habilitado, a API de operador oferece:

- `GET /api/knowledge/procedures`: catálogo; listar não significa recomendar/aplicar;
- `POST /api/knowledge/procedures/query`: corpo igual ao contrato diagnóstico;
- `POST /api/assistant/diagnose`: mantém envelope; adiciona `reply.technicalDetails.instructor`.

Exemplo de corpo fictício:

```json
{"symptom":"magro","instrument":"surdo","channel":8,"destination":"pa","evidence":[{"id":"fixture-surdo","kind":"musician_report","verification":"unverified","symptom":"magro","detail":"Fixture: músico relata falta de grave; causa não validada."}]}
```

A saída tem `status:inspection_only`, procedimentos textuais e IDs dos relatos;
`measurements:unavailable`, `observedState:not_acquired`, `proposal:null`,
`authorizedActions:[]`, `execution:not_executable`. Sem relato compatível, canal,
instrumento ou destino, retorna `needs_context` e **nenhum procedimento recomendado**.
Estado de fader ou medidor simulado não substitui relato. Microfonia seleciona primeiro
apenas o procedimento PA ou AUX correspondente; não inicia escuta comparativa com apito.
Isso não atesta que o relato esteja correto: a confiança diagnóstica continua baixa.

Reutilizados guardas de operador/sessão/origem e respostas no-store das rotas existentes.
Músico e agente MCP não ganharam acesso; logout revoga consulta. Não existe endpoint de
aplicação de procedimento. O motor determinístico e o contrato funcionam mesmo com
`knowledge.enabled=false`; apenas as rotas de administração opcionais não são montadas.

## Corpus local: ativação e reversão

Nada é ingerido automaticamente, nem se altera configuração do operador.
Após build, com `knowledge.enabled` já habilitado pelo operador:

```sh
npm run knowledge -- import-technical
npm run knowledge -- search "voz abafada no retorno"
npm run knowledge -- remove-technical
```

A importação usa o mesmo KnowledgeStore de arquivo/PostgreSQL, com namespace
`mixai-technical-v1`. É idempotente por hash/conteúdo/versão; não substitui PDFs,
pack, atribuições ou documentos privados. Remoção apaga apenas documentos desse
namespace; o registro bibliográfico pode permanecer sem documentos. Reimportar restaura
a biblioteca. Falhas são reportadas, sem alegar sucesso; importação interrompida pode
ser retomada e não possui transação global entre documentos.

Usa o splitter existente com alvo de 400 caracteres e sem sobreposição para que o
conteúdo caiba no trecho exibido de 420. **Não altera** splitter de PDFs, pipeline,
ranking, limiar ou hash dos documentos anteriores. Fontes e versão acompanham o texto;
a fonte do corpus é explicitamente MixAI, sem passar síntese por manual original.

A importação desta entrega **não gera embeddings nem chama provedores**. Em base já
vetorial com modo `auto`, os novos documentos sem embedding podem não aparecer enquanto
houver resultado vetorial; o modo híbrido existente combina palavras/vetores. A escolha
continua do operador. Avaliação/reindexação com embeddings reais e o corpus do ROG é
pendente; não foi simulada como evidência de qualidade de Gemini/Ollama. Nenhum serviço,
modelo ou banco externo foi iniciado para estes testes.

## Avaliação reproduzível e limites

```sh
npm exec tsx scripts/eval-technical-knowledge.ts work/issue65-relevance.json
```

O script monta índices temporários e remove-os. Baseline: seis narrativas do pacote
versionado, extraídas pelo mesmo extrator Markdown. Depois: esse mesmo baseline mais
54 trechos da biblioteca (60 no total). **Não é** o corpus privado de 367 trechos do ROG,
que não está no Git e não está disponível neste ambiente. Não é uma reprodução da
medição do PR #62 ou da métrica Gemini relatada no PR #67.

Resultados de busca lexical, k=4, critérios das 24 perguntas originais inalterados:

| Conjunto / julgamento | Antes: Acerto@1 / @4 / MRR / Precisão@4 | Depois |
| --- | --- | --- |
| 24 originais, trecho completo | 4,2% / 12,5% / 0,083 / 0,066 | 54,2% / 62,5% / 0,576 / 0,313 |
| 24 originais, trecho exibido | 4,2% / 12,5% / 0,083 / 0,066 | 54,2% / 62,5% / 0,576 / 0,313 |
| 12 adicionais, trecho exibido | 8,3% / 8,3% / 0,083 / 0,042 | 75% / 100% / 0,854 / 0,396 |

Voz abafada original: **0/4 → 2/4**. Permanecem falhas `voz-abafada-2/4`,
`cavaco-1/2/4` e `surdo-1/2/3/4`. Parte do protocolo antigo julga termos ingleses
associados a outras fontes/instrumentos; não foram adicionadas palavras só para atingir
esses critérios, nem recategorizados erros como acertos. Melhorar corpus não garante
ranking perfeito; essas perguntas exigem avaliação posterior em corpus maior.
Os 12 casos novos foram escritos junto da biblioteca e **não** são conjunto cego.

[Relatório JSON](evidence/issue65-relevance.json) contém também métricas por tema e misses.
Relevância automática por palavras não prova correção técnica nem utilidade de resposta
IA. Estas são avaliadas separadamente em testes de fatos/limites: P3 S e canais
confirmados/desconhecidos, P10 sem impedância presumida, falta de evidência, condição/
negação, nenhuma frequência detectada, nenhum valor universal e zero execução.

## Segurança, validação e pendências

Sem escrita REAL, serve:real, mudanças de rede, permissões, PINs, E6, mixer, filas ou UI.
Gain, phantom, EQ/HPF, AFS2 e reverb permanecem sem execução por diagnóstico. Em apito ou
piora, interromper e chamar operador; não restaurar automaticamente estado inseguro.
Nenhum áudio, SPL, RTA, medidor REAL ou redução de ganho foi recebido pelo aplicativo.
Todos os procedimentos desta biblioteca têm validação `theory`.

As regressões unitárias/HTTP/WS, UI, E2E, smoke, HTTPS e CI Windows/Ubuntu são registradas
com seus resultados no PR do SHA final. Firmware, rótulos reais, posicionamento de
microfones, acústica, inteligibilidade e mix da banda exigem validação física manual
supervisionada. O Instrutor visual B consumirá os contratos posteriormente; o fluxo D
não foi modificado. Não é necessário esperar essas integrações para usar a consulta.

No E2E de administração, a asserção da lista passou a aguardar o refresh assíncrono após o aviso de importação, mantendo a exigência de pelo menos dez fontes. Nenhum componente foi alterado.
