# Audio Intelligence — reconciliação de contratos (#82 × #84 × #83)

**Status: proposta + adaptador puro offline. Não está ligado a rota, serviço, interface, AutoConfig nem captura.**
Segue o passo 1–2 do [INTEGRATION-PLAN.md](INTEGRATION-PLAN.md). Base: `main` 0c7c209 (#82, #83, #84 e #87 já incorporados).
Os documentos e o código dos PRs #82/#83/#84 **não foram editados**; esta entrega acrescenta arquivos novos.

## 1. Verificação na main atual

| Verificação | Resultado |
| --- | --- |
| `typecheck` | ok |
| `vitest` completo (main limpa, antes da mudança) | 90 arquivos, 1281 passaram, 1 ignorado (já existente) |
| Com esta mudança | `spectrum-frame` 22 testes + `spectrum-engine` 52 passam; `typecheck` ok |
| Importadores de `audio-intelligence` fora do módulo/testes | nenhum (teste de varredura novo garante isso em `src` e `web/src`) |

## 2. O que foi decidido (e onde está implementado)

`src/audio-intelligence/frame.ts` define o `SpectrumFrame` reconciliado (`frameVersion: spectrum-frame-r1`) e a função pura
`measurementToFrame(medição, ciclo de vida)`. O ciclo de vida (geração, sequência, relógio, revisão de contexto) é **entrada**,
nunca derivado da medição. O motor (#84) não mudou.

| # | Divergência do plano | Decisão implementada | Teste |
| --- | --- | --- | --- |
| 1 | #82 sem origem "PCM fornecido" | Duas origens apenas: `mock/simulated` e `supplied_pcm/declared_unverified`. `native_verified` e `audio_capture` (`measured`) **não existem** neste esquema até haver fonte validada. | adulteração para `measured`, `audio_capture`, `validated_for_point`, `processingContext.verified` falha |
| 2 | Sinal/rota | canal 1–12 (Ui16; configurável para menos), AUX1 sempre `shared: true`, ausente = `unknown`; canal acima do modelo → `ROUTE_NOT_SUPPORTED` | 3 testes |
| 3 | `domain` × `path` | sintético ⇒ `synthetic`; `electrical` → `electrical_line` | origem |
| 4 | Nomes | adotados os de #82 (`sampleRateHz`, `binSpacingHz`, `hopSamples`, `hann_periodic`). `smoothingMs` **não existe**: o motor usa EMA por quadro, então o quadro traz `aggregation` + `smoothingAlpha` (conversão para ms seria aproximação). | esquema |
| 5 | `schemaVersion` duplicado | `kind: 'spectrum_frame'` + `frameVersion` distinguem do `SpectrumMeasurement` | esquema |
| 6 | Escala | `scaleDefinitionId = fft-hann-v1/one_sided_power_window_energy`; seno de escala plena = **−3,01 dBFS** (potência total); sem referência ⇒ `relative_unknown` + `uncalibrated` | teste da escala |
| 7 | Semântica de `null` | `nullMeans: 'exact_zero_power'` explícito: `null` só significa potência exatamente zero, nunca "sem amostra" | silêncio |
| 8 | Banda sem bin | `coverage: 'unresolved'`, `level: null`, `fractionOfTotalPower: null`, `binCount: 0`; nível em banda `unresolved` é recusado pelo esquema | teste de banda |
| 9 | Tamanho | grade uniforme compacta (`startHz`, `spacingHz`, `levels[]`) em vez de objeto por bin: ≥ 3× menor; ≤ 4096 níveis (⇒ `fftSize ≤ 4096`) e ≤ 256 KiB, senão `RESOURCE_LIMIT` | 8192 recusado; compacto |
| 10 | Tempo | `capturedAt` e `acquisitionAgeUpperBoundMs` são sempre `null`; `inputTimestampMs` declarado é descartado | timestamp |
| 11 | Confiança | só `insufficient` (silêncio ou clipping possível) ou `limited`; `validated_for_point` fora do esquema | adulteração |
| 12 | Clipping | `digitalClippingEstimate` (limiar 0 dBFS, ponto `captured_pcm`) ou `null` se indisponível | 2 testes |
| — | `droppedFrames` | `null` (desconhecido), não `0` | adulteração |

Consequência direta: um quadro produzido por este adaptador **nunca** é "fresco" (não tem idade de aquisição) e **nunca** é
"medido". Isso é intencional: só uma futura `SpectrumSource` validada pode produzir ambos.

## 3. Vocabulário de evidência (proposta)

| Termo | Onde vale | Não pode ser usado para |
| --- | --- | --- |
| `observed` (#86) | estado de controle observado no servidor | espectro ou qualquer áudio |
| `simulated` | sintético/mock (`mock`) | medição, mesmo "parecida" |
| `declared_unverified` | PCM fornecido, números reais, origem não verificada | rótulo REAL, `measured` |
| `measured_verified` | **reservado**; exige fonte validada (#82 `native_verified`/`audio_capture` + registro) | qualquer saída de #84 |
| `operator_reported` / `ai_suggested` / `unknown` (#86) | relato, hipótese, ausência | espectro |

Rótulos de interface (#83): `simulated` → SIMULAÇÃO LAB · NÃO MEDIDO; `declared_unverified` → **novo rótulo necessário**
"PCM DECLARADO · NÃO VERIFICADO"; `measured_verified` → MEDIÇÃO … REAL (hoje inalcançável).

## 4. Correções propostas aos documentos dos PRs mesclados (não aplicadas)

Cada item deve virar PR dos autores ou decisão do responsável; este PR apenas as registra.

**#82 (`SPECTRUM-SOURCE.md`)**
1. Acrescentar a origem `supplied_pcm` / `declared_unverified` e `coverage` por banda.
2. Trocar `smoothingMs` por `aggregation` + `smoothingAlpha`; `droppedFrames` nulável.
3. Fixar `scaleDefinitionId` e `nullMeans`; trocar bins por objeto por grade compacta quando uniforme.
4. Citar `SpectrumFrame` r1 como esquema executável (não "rascunho Markdown").

**#83 (`UX-PROPOSAL.md`, `WIREFRAMES.html`)**
1. Novo estado "PCM DECLARADO · NÃO VERIFICADO".
2. Recortes: alinhar com as bordas de #84 (20/80/250/500/2000/5000/20000) ou solicitar `settings.bands` próprias (20–250, 250–4000, 4000–20000).
3. "condições confirmadas" → "condições **declaradas**"; mapear cada `SpectrumIncompatibility` para uma mensagem.
4. Banda `unresolved` ⇒ "faixa não resolvida nesta resolução", nunca zero ou silêncio.
5. Remover destaques numéricos até existir critério de proeminência (o motor devolve máximos locais, inclusive ruído).
6. Atualizar o texto sobre C→B→D: já integrado em #85/#86.

**#84 (`SPECTRUM-ENGINE.md`)** — observação, não defeito: bins de um tom puro trazem níveis finitos do ruído numérico
(≈ −300 dBFS), não `null`. Qualquer apresentação precisa de um piso explícito para não exibir "energia" ali.

## 5. Sequência de integração atualizada

| Passo | Estado |
| --- | --- |
| #82, #84, #83, #87 | incorporados na main |
| **Esta entrega**: proposta + `frame.ts` + testes | PR aberto |
| `SpectrumEvidence` + resumo (`summarizeFrame`), com piso e proeminência definidos | próximo, depende de decisão do piso |
| `SpectrumSource` mock com relógio falso (geração, frescor, revogação) | depois |
| Porta/adaptador em `autoconfig/recommendation`; apresentação em B | só após os anteriores e revisão do contrato de C |
| Captura externa / RTA nativo | requer hardware, protocolo e autorização próprios; **não iniciado** |

## 6. Decisões que cabem ao responsável

1. Adotar os nomes de #82 (feito aqui) ou os de #84 como canônicos.
2. Aceitar o rótulo "PCM DECLARADO · NÃO VERIFICADO" e o vocabulário da seção 3.
3. Piso de apresentação (dBFS) e critério de proeminência de picos.
4. Limitar `fftSize ≤ 4096` na integração (necessário para o limite de 4096 níveis).

## 7. Limites

- Tudo é LAB/offline. Nenhuma `serve:real`, Ui16, captura, rota, interface ou alteração de AutoConfig/núcleo D.
- O adaptador converte formato e **rebaixa** certeza; não valida física, firmware, topologia nem acústica.
- O esquema `SpectrumFrame` r1 é uma proposta executável; não é a versão final do contrato de #82.
