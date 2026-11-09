# AutoConfig 2.0 — recomendações técnicas de ajustes (protótipo offline)

Branch `feature/autoconfig-smart-recommendations`, a partir da `main` em `e105bea` (PR #85). **Somente LAB, somente contratos, regras e testes offline.**
Nada foi ligado a rota, serviço, tela, provedor de IA ou ao núcleo D. O funcionamento atual do AutoConfig não muda. Dois arquivos existentes receberam mudanças mínimas e sem efeito em tempo de execução: `src/knowledge/sound-engineer/index.ts` (exporta `eqGuides`, que já existia) e `test/sound-engineer-knowledge.test.ts` (o novo adaptador entra na lista de consumidores explícitos da base determinística, com a mesma exigência: importar somente `knowledge/sound-engineer/index.js`).
Sem `serve:real`, sem Ui16, sem escrita REAL, sem chamada a Gemini ou Ollama.

## 1. O que foi investigado

| Pergunta | Resposta (fonte no código) |
|---|---|
| Quais parâmetros a Ui16 do MixAI representa? | `ParamRegistry` (`src/core/params.ts`): nível (principal e AUX), mute, EQ de 4 bandas (freq/Q/ganho), HPF (freq/inclinação) e bypass de EQ. **Não existem** ganho de entrada, compressor, gate, phantom, de-esser nem AFS. |
| Quais são enviados à mesa real? | Só nível e mute (`library_verified`). EQ/HPF são `simulated_only` (existem só no LAB). |
| O servidor consegue **observar** o valor atual? | Só nível e mute (`Observation`, chaves `master.level`, `ch.N.main.level`, `ch.N.aux.1.level`…). EQ/HPF **não** são lidos: o valor atual só pode vir do operador. |
| O que o núcleo D aceita como item? | `level_delta`, um canal, passo de −3 a +3 dB (não nulo), até 8 itens. Nada de EQ/HPF/ganho/compressão no núcleo v1. |
| O planejador C (PR #78) produz valores? | Não. Escolhe uma **inspeção** citada (`targetValue: null`). A tela exige que o número venha do operador (`AdvisoryResponse` recusa `deltaDB`). |
| Que conhecimento tem valores citáveis? | `eq-guides.ts`: pontos de partida **editoriais, não medidos e não validados** (ex.: cavaco: HPF 80 Hz e −2 dB em 3 kHz). Os procedimentos (`procedures.ts`) são orientação condicional, sem valores. |

Conclusão: dá para representar com segurança (a) um **passo relativo de nível** com nível atual observado; (b) um **valor de EQ/HPF** vindo de guia editorial **se** o operador informou o valor atual (e a frequência da banda). Ganho de entrada, compressão, gate, phantom, de-esser e AFS exigem medições ou informações que o MixAI não tem; a resposta é **recusa explícita** ou pedido de verificação.

## 2. Arquitetura proposta

```
relato classificado (M1/C) ─┐
estado LAB (nível, servidor) ─┼─▶ buildMenu()  ── cardápio: candidatos (c1..c4) + verificações (v1..v3) + recusa
valores lidos pelo operador ─┘        │                │
conhecimento versionado ──────────────┘                ▼
                                          modelo de IA (opcional): select c# | abstain  ── nunca digita
                                                       │
                                                       ▼
                                          Recommendation (dado) ──▶ operador lê
                                                       │  (nenhuma autorização, nenhum comando)
                                                       ▼
                         operador digita o passo ──▶ draftFromAdjustment() ──▶ Suggestion do núcleo D (rascunho)
                                                       ▼
                    D (inalterado): autorização por item, simulação virtual, revisão, referência UNVERIFIED
```

Onde fica a autoridade: **somente no núcleo D**. A recomendação é dado imutável; o modelo só escolhe um item de um cardápio montado pelo servidor; o único caminho até o D é a ponte `draftFromAdjustment`, que exige o **número do operador**, o contexto vinculado (servidor + revisão) e um parâmetro que o D v1 aceita (nível).

**Conhecimento por porta.** `contracts.ts` e `engine.ts` não importam a base de conhecimento; recebem uma `RecommendationKnowledge` (guia de EQ, referência de procedimento e de instrumento). O único arquivo que toca a base é `kb-adapter.ts`, como o adaptador do planejador C. Os testes conferem isso.

## 3. Contrato (`src/autoconfig/recommendation/contracts.ts`)

Três resultados, todos com `authorization: 'not_granted'`, `execution: 'not_executable'`, `realWrites: false`, `requiresHumanReview: true`, `measurements: 'unavailable'`, `scope: 'lab_simulation'`:

- **`adjustment`** — canal, destino (`PA`/`AUX1`), `parameter` (`level_main | level_aux1 | eq_band_gain | eq_band_freq | eq_band_q | hpf_freq | hpf_slope | eq_bypass`, banda quando aplicável), `current`, `proposed`, `requires` (valores de outros parâmetros que precisam estar assim — ex.: frequência da banda), `rationale`, `evidence`, `knowledge` (fonte, trecho, **versão**, data, status de validação), `risks`, `preconditions`, `verification`, `stopConditions`, `rollback` (sempre manual, aponta para o valor atual), `uncertainty`, `binding` (servidor, revisão do estado, impressão digital do contexto).
- **`verification_request`** — o que falta (`current_value | listening_comparison | isolation_check | capture_check | hpf_state | band_frequency | level_reading | role_confirmation`), o que o operador deve fazer, por quê, condições de interrupção e incerteza `very_high`.
- **`refusal`** — `safety_stop | unsupported_parameter | insufficient_evidence | invalid_model_output | no_candidate`.

### Proveniência rigorosa dos valores

| Proveniência | Quem produz | Pode aparecer em |
|---|---|---|
| `observed` | servidor, lendo o estado LAB (`revision`, `origin: lab_state`) | `current` de **nível** |
| `operator_reported` | operador, lendo a interface oficial (`reportId`) | `current` de EQ/HPF; `requires` |
| `ai_suggested` | regra/modelo, **sempre** `basis: editorial_trial`, `validation: unvalidated` | somente `proposed` |
| `unknown` | — (`not_observable`, `not_reported`, `lab_state_unavailable`) | `current` de **verificações**; **nunca** de um ajuste |

Não existe proveniência "medido": não há áudio, RTA, SPL nem frequência medida. A evidência `lab_observation` carrega `audio: false`. O esquema impede: valor atual "sugerido pela IA", ajuste com valor atual desconhecido, EQ "observado", nível "informado" (tem que ser observado), passo de nível fora de ±3 dB ou que estoure o fader, EQ em modo relativo, reversão automática ou que não aponte para o valor atual, ajuste sem relato humano ou sem conhecimento citado, incerteza `medium` com pendências, qualquer chave extra (comando embutido). Incerteza nunca é "baixa".

### O que um modelo pode devolver

Somente `{"kind":"select","candidate":"c1"}` ou `{"kind":"abstain","reason":"insufficient_evidence|needs_verification|unsafe","verification":"v1"}`. Qualquer outra coisa (números, prosa, chaves extras, candidato inexistente, JSON acima de 2 KB) vira recusa `invalid_model_output`, **sem tentar outro modelo**. O prompt (`modelPrompt`) leva apenas categorias: sem número de canal, nome, relato, identificadores, valores ou URLs.

## 4. Regras de segurança (e onde estão testadas)

1. O modelo nunca cria comando: só escolhe um item do cardápio (`autoconfig-recommendation.test.ts` › "o modelo só escolhe").
2. Nenhuma execução automática: sinalizadores fixos no esquema; o módulo não importa mesa, controlador, fila, servidor, rede nem provedores (teste de isolamento por análise dos imports).
3. Autorização só no D. A ponte produz um **rascunho** (`Suggestion`) cujo passo é o do operador (`followedAdvice` registra se coincidiu com o conselho); ela falha com `STALE_CONTEXT` se servidor ou revisão mudaram, `NOT_DRAFTABLE` para EQ/HPF, `INVALID_STEP` para 0, fora de ±3 ou não finito.
4. Uma aprovação vale para um item, com contexto e revisão: `binding.contextFingerprint` cobre servidor, revisão, canal, destino, parâmetro, valor atual, valor proposto, pré-requisitos e versões do conhecimento. O D continua sendo quem aprova (digest por item); nada foi enfraquecido ou alterado nele.
5. Sem evidência, pede verificação: cada portão faltante vira **uma** pergunta, na ordem (papel → comparação → captação → isolamento → frequência da banda → valor atual).
6. Microfonia/apito ativo → `safety_stop` (nenhum ajuste); parâmetros sem suporte → recusa explícita, sem número.

## 5. Cenários sintéticos da banda (testados)

| Cenário | Sem evidências | Com evidências declaradas |
|---|---|---|
| **CH8** surdo sem grave | pede para ler o HPF e comparar sozinho × banda; **nunca** boost | HPF informado em 80 Hz → sugere HPF desligado (20 Hz, do guia do surdo); HPF já em 20 Hz → pede conferir a captação |
| **CH3** voz principal encoberta pelo coro | pede papel, comparação sozinho × banda ou nível observado | nível observado −6 dB, papel principal, só com a banda → passo **+1 dB** (relativo), valor atual observado |
| **CH6** voz abafada no AUX1 | pede comparação PA × AUX1 → captação → isolamento → frequência da banda → valor atual | comparação "nos dois", captação confirmada, banda 2 em 300 Hz com 0 dB → corte do guia (−1,5 dB); se só no AUX1: **nenhum EQ de canal** (também alteraria o PA) |
| **CH1** cavaco estridente | pede captação (e comparação/isolamento) | banda 2 em 3 kHz com 0 dB informados → corte do guia (−2 dB) |

Todos os números de EQ vêm de `eq-guides.ts` (lidos em tempo de execução; os testes comparam com o guia) e são pontos de partida editoriais. **Nenhuma frequência ou valor é atribuído a medição.**

### Exemplo — CH3 (resumido da saída real do motor)

```json
{ "kind": "adjustment", "channel": 3, "destination": "PA", "parameter": { "kind": "level_main" },
  "current":  { "provenance": "observed", "value": -6, "unit": "dB", "revision": 41, "origin": "lab_state" },
  "proposed": { "provenance": "ai_suggested", "mode": "delta", "value": 1, "unit": "dB", "basis": "editorial_trial",
                "knowledgeId": "rule:lead-over-chorus", "validation": "unvalidated" },
  "evidence": [ { "kind": "operator_report", "symptom": "desequilibrio" }, { "kind": "lab_observation", "parameter": "level_main", "revision": 41, "audio": false }, { "kind": "knowledge", "knowledgeId": "procedure:desequilibrio" } ],
  "risks": ["Elevar a voz principal reduz a margem contra microfonia.", "Pode encobrir o coro em vez de equilibrar."],
  "stopConditions": ["Interromper se surgir apito, distorção ou desconforto auditivo.", "…"],
  "rollback": { "automatic": false, "previous": { "…": "igual ao valor atual" }, "instruction": "Retorno somente humano… nada é restaurado automaticamente." },
  "uncertainty": { "level": "high", "missing": [] },
  "authorization": "not_granted", "execution": "not_executable", "realWrites": false }
```

### Exemplo — CH8 sem evidência

```json
{ "kind": "verification_request", "channel": 8, "reason": "hpf_state",
  "request": "Leia na interface oficial se o filtro passa-alto (HPF) do canal está ligado e em qual frequência, e informe.",
  "why": "Um HPF alto pode remover o grave relatado; o MixAI não lê o HPF da mesa.",
  "uncertainty": { "level": "very_high", "missing": ["hpf_state"] }, "authorization": "not_granted" }
```

## 6. Riscos e limites conhecidos

- **Os valores são hipóteses editoriais**, não validadas em hardware nem por escuta: o guia só vale como ponto de partida a ser comparado pelo operador.
- **EQ/HPF não existem no D v1 nem na mesa real do MixAI** (`simulated_only`): hoje só o **nível** pode virar rascunho. Um item de EQ exigiria mudança de contrato do D (revisão própria).
- **EQ de canal vale para PA e AUX1.** A regra recusa EQ quando o problema é só no AUX1; isso supõe o comportamento de EQ pré-envio da Ui16, que **não foi validado em hardware**.
- Os trechos de conhecimento citados herdam o primeiro `references` de cada procedimento/instrumento (ex.: "4.3 AUX" para desequilíbrio); a curadoria de locators por regra é uma melhoria futura.
- Regras cobrem 4 combinações sintoma × instrumento. As demais devolvem `no_candidate`.
- O modelo de IA (Gemini/Ollama) **não foi usado**; a seleção por modelo é testada apenas por saídas simuladas do contrato.

## 7. Plano de implementação progressiva

1. **(este PR)** Contratos, regras e testes offline. Nenhum efeito no sistema.
2. **Somente leitura na tela**: exibir `verification_request` e `adjustment` como texto, com a legenda de proveniência, **sem** botão que preencha o passo. Revisar com o Yoga (testes funcionais).
3. **Ligar ao planejador C**: servir o cardápio no `POST /api/autoconfig/suggestions` (aditivo), mantendo a regra "só o operador digita o número"; o modelo escolhe entre `c#`/`v#`.
4. **Rascunho assistido**: botão "usar este passo" apenas copia o valor para o campo do operador, que confirma; `followedAdvice` vai para o histórico do D (campo aditivo, revisão do núcleo).
5. **Medições futuras** (só se existirem sensores/entradas reais e validação em hardware): novas proveniências e novos parâmetros (ganho, dinâmica) com contratos próprios; até lá permanecem recusados.
6. Qualquer escrita REAL/E6 permanece fora deste caminho e exige autorização explícita à parte.

## 8. Testes

`test/autoconfig-recommendation.test.ts` (60 testes, offline): os quatro cenários com e sem evidência; recusas (6 conceitos sem suporte, microfonia/apito, caso sem regra, entrada inválida ou com chaves extras); paridade dos parâmetros e limites com o `ParamRegistry`; 27 adulterações do contrato rejeitadas; modelo (select/abstain, saídas inválidas, texto, prompt sem dados); vínculo de contexto e ponte para o D (inclusive aceitação pelo `AutoConfigProposal` do D); isolamento de imports do módulo.
