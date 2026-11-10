# SpectrumEvidence — resumo técnico de um SpectrumFrame

**Status: biblioteca pura, offline, LAB. Não está ligada a rota, serviço, interface, AutoConfig nem captura.**
Fase 2 do [INTEGRATION-PLAN.md](INTEGRATION-PLAN.md), sobre o [`SpectrumFrame` r1](RECONCILIATION.md).
Código: `src/audio-intelligence/evidence.ts` (e `frame.ts`). Testes: `test/spectrum-evidence.test.ts`.

> **Energia espectral não comprova qualidade sonora, inteligibilidade nem defeito.** Um sinal elétrico (linha, arquivo,
> sintético) **não representa necessariamente a acústica do ambiente**. Níveis são digitais (potência por bin), não SPL nem dBu.
> Esta camada descreve; não diagnostica, não recomenda EQ, não autoriza e não executa.

## 1. Arquitetura

```text
SpectrumMeasurement (#84)  →  SpectrumFrame r1 (#88)  →  SpectrumEvidence r1 (esta fase)  →  [futuro] C / B
   analyzePcm                  measurementToFrame          summarizeFrame (pura)
```

`summarizeFrame(frame, config?)` valida o quadro, resume por bandas, classifica níveis, aplica um piso **somente de apresentação**
e destaca picos por critério explícito. Não há relógio, I/O, aleatoriedade, rede, modelo, hardware nem estado entre chamadas.
O `id` da evidência é `ev_` + SHA-256 truncado de (versão, referência do quadro, configuração): mesma entrada, mesmo `id`.
Erros: `EvidenceError` com `INVALID_FRAME`, `INVALID_CONFIG` ou `RESOURCE_LIMIT` (sem amostras nem níveis na mensagem).

## 2. Contrato (`spectrumEvidenceSchema`, Zod estrito)

| Campo | Conteúdo |
| --- | --- |
| `kind`, `schemaVersion`, `evidenceVersion`, `summaryAlgorithm`, `id` | identidade e versão (`spectrum-evidence-r1`, `spectrum-summary-r1`) |
| `frameRef` | `frameId`, `sourceId`, `generationId`, `sequence`, `contextRevision`, `frameVersion` do quadro de origem |
| `availability` | `available` **ou** `insufficient_evidence` + motivos (`no_energy`, `quality_insufficient`, `no_resolved_band_above_floor`) |
| `provenance` | `simulated` · `declared_unverified` (`measured_verified` é **reservado**: constante exportada em `PROVENANCE`, recusado pelo esquema) |
| `signal`, `domain`, `tap`, `routeCaveat` | canal/barramento/desconhecido preservados; AUX1 ⇒ `shared_bus_not_isolated`; sem alvo ⇒ `route_unknown` |
| `scale` | unidade, calibração, `scaleDefinitionId`, `nullMeans` (unidade e referência incoerentes são recusadas) |
| `resolution` | `sampleRateHz`, `fftSize`, `binSpacingHz`, `nyquistHz` |
| `presentation` | configuração usada e se o piso se aplica (`floorApplied`, só com referência digital) |
| `bands[]` | `state` ∈ `resolved_level`, `below_floor`, `exact_zero`, `unresolved`; `levelDb` **original**; `displayLevelDb` limitado ao piso (só desenho); fração da potência |
| `levels` | contagem de bins `aboveFloor` / `belowFloor` / `exactZero` (sem o vetor de níveis) |
| `peaks` | `reported` com até 3 itens (`bin`, `frequencyHz`, `levelDb`, `prominenceDb`) ou `omitted` + motivo; `meaning: 'local_spectral_maximum'` fixo |
| `quality`, `notices`, `limitations` | confiança do quadro, clipping digital, avisos em códigos (`NOTICE_TEXT_PT` traz o texto) e limitações herdadas |
| `guards` | fixos: `diagnosis: none`, `eqRecommendation: none`, `authorization: not_granted`, `execution: not_executable`, `realWrites: false` |

Nenhum campo carrega comando, valor de EQ, aprovação ou áudio. O resumo não tem os níveis por bin: é ≥ 4× menor que o quadro.

## 3. Algoritmos

**Validação.** O quadro passa pelo esquema r1 e por checagens cruzadas: `levels = fftSize/2+1`, `fftSize` potência de 2 entre 256 e 4096,
`spacing × fftSize = taxa`, `binCount` de cada banda recontado a partir da grade, bandas ordenadas e dentro de Nyquist, `mock ⇔ domínio sintético`,
canal ≤ 12. Qualquer falha ⇒ `INVALID_FRAME`. O tamanho real em **bytes UTF-8** (`Buffer.byteLength`) é limitado a 256 KiB.

**Estados de nível** (quatro estados distintos):

| Estado | Significa | Não significa |
| --- | --- | --- |
| `exact_zero` | potência exatamente zero (silêncio digital) | falta de dados |
| `below_floor` | energia finita **abaixo do piso de apresentação** | silêncio; o valor original é preservado |
| `resolved_level` | nível válido acima do piso | qualidade ou problema |
| `unresolved` | a resolução não tem centro de bin na faixa (ausência de dados) | silêncio ou nível zero |

**Piso de apresentação.** Padrão **−120 dBFS por bin**, configurável (−200 a −20), só quando há referência digital. Justificativa: o ruído de
quantização de 16 bits tem potência total −98,1 dBFS, ou ≈ −131 dBFS por bin com 4096 pontos; o piso fica ≈ 11 dB acima, de modo que ruído de
quantização e o ruído numérico de ponto flutuante (≈ −300 dBFS num tom puro) não aparecem como "energia", sem esconder sinais reais.
Como o nível de banda é a **soma** das potências dos bins, o piso de uma banda sobe `10·log10(binCount)`. Escala sem referência (`relative_unknown`):
sem piso, sem picos.

**Disponibilidade.** `available` exige confiança do quadro sem clipping digital possível e ao menos uma banda `resolved_level`. Caso contrário,
`insufficient_evidence` com motivos; as bandas continuam descritas, os picos são omitidos.

**Picos — critério de proeminência.** Candidato: máximo local interno (maior que o vizinho esquerdo e ≥ ao direito) com nível ≥ piso + `minProminenceDb`.
Reportado se, **todos**:
1. proeminência topográfica ≥ `minProminenceDb` (padrão 20 dB; níveis limitados ao piso; zero exato conta como o piso);
2. nível ≥ **mediana local** + `minProminenceDb` (janela de ±32 bins excluindo `guardBins`). Necessário porque o maior bin de **ruído de banda larga**
   tem proeminência topográfica alta (os vizinhos incluem nulos aleatórios profundos): sem este critério o ruído branco "produzia" um pico;
3. a mais de `guardBins` (4) de um pico mais forte já reportado (lobo principal e primeiros lobos laterais da janela de Hann);
4. no máximo `maxDropDb` (50 dB) abaixo do pico mais forte (lobos laterais e vazamento);
5. máximo de `maxPeaks` (3, como em #83) por nível decrescente.

Picos são omitidos, com motivo, se: `maxPeaks = 0`, escala sem referência, `binSpacingHz > 50` (ex.: FFT 256 a 48 kHz = 187 Hz), sem energia, clipping
possível, ou nenhum candidato satisfaz o critério (`no_prominent_peak`). A frequência é o **centro do bin** (sem interpolação); a incerteza é ±`binSpacingHz/2`.
Um pico é "máximo local do espectro": **não** é microfonia, ressonância, defeito, mascaramento nem frequência a cortar.

Medido com os fixtures: tom alinhado ou não ao bin, tom + ruído e dois tons ⇒ picos corretos; 5 sementes de ruído branco e ruído em 3 amplitudes ⇒ nenhum pico.

## 4. Exemplos sintéticos (saídas reais do código)

| Entrada (LAB, sintética) | Resultado |
| --- | --- |
| Seno 80 Hz, CH8, FFT 4096 @ 48 kHz | `available`, `simulated`, pico em 82,03 Hz (bin 7, ±5,86 Hz), proeminência 68 dB; bandas 20–80/80–250 `resolved_level`, 250–500 `resolved_level` (−91 dB), as 3 restantes `below_floor` |
| Silêncio digital, CH3 | `insufficient_evidence` (`no_energy`), 2049 bins `exact_zero`, sem picos |
| Ruído de banda larga, AUX1 | `available`, `routeCaveat: shared_bus_not_isolated`, picos omitidos (`no_prominent_peak`) |
| Seno 100 Hz, FFT 256 | banda 20–80 Hz `unresolved` (nenhum centro de bin); picos omitidos (`resolution_too_coarse`) |
| Escala desconhecida | `relative_unknown`, sem piso, sem picos, aviso `scale_uncalibrated` |
| Seno de amplitude 1,5 (clipping) | `insufficient_evidence` (`quality_insufficient`), `clippingPossible: true` |

## 5. Limites, custo e uso futuro no Yoga

Correção do PR #88 incluída: o limite de 256 KiB do quadro agora usa `Buffer.byteLength(JSON.stringify(x), 'utf8')` (`frameByteLength`), em
`measurementToFrame` e em `summarizeFrame`. Antes, texto multibyte (3 bytes por `€`) passava com ~90 mil caracteres e ≈ 270 KB reais; há teste.

| Item | Limite / custo |
| --- | --- |
| Entrada | quadro ≤ 256 KiB (UTF-8), ≤ 4096 níveis (⇒ FFT ≤ 4096), ≤ 32 bandas |
| Saída | poucos KB (sem vetor de níveis) |
| Custo de `summarizeFrame` | O(n) para validar e classificar; O(c·(n + W log W)) para picos, c = candidatos acima de piso+proeminência, n ≤ 4096, W = 64. Medido neste PC: ≈ 0,6 ms por quadro de 2049 bins; teste de pior caso (serra de 1024 candidatos) < 2 s com folga; a cópia do quadro é uma só (a validação do Zod) |
| Memória | O(n) transitório (poucas dezenas de KB) |

Medidas são deste computador de desenvolvimento, **não do Yoga**; não há benchmark no Yoga. Esta etapa **não** introduz processamento contínuo, workers
nem streaming. Para uso contínuo futuro: a função é síncrona e rápida, mas a análise FFT anterior (≈ 40 ms no pior caso) deve rodar fora do laço de
eventos (`worker_threads`) e com no máximo uma análise por vez; isso é decisão de outra entrega.

## 6. Proveniência

| `provenance` | Origem do quadro | Rótulo sugerido para a interface (#83) |
| --- | --- | --- |
| `simulated` | `mock` (sinal sintético) | SIMULAÇÃO LAB · NÃO MEDIDO |
| `declared_unverified` | `supplied_pcm` (números reais, origem não verificada) | PCM DECLARADO · NÃO VERIFICADO |
| `measured_verified` | **reservado**: exige fonte física validada (#82) | MEDIÇÃO … REAL (inalcançável hoje) |

O motor atual **não pode** produzir o terceiro estado: o quadro r1 não admite origens `measured`, e o esquema da evidência rejeita o valor.
Estado observado da mesa (`observed` de #86, faders, mute) nunca é convertido em espectro, e o medidor simulado do LAB não é entrada desta camada.

## 7. Testes

`test/spectrum-evidence.test.ts` (33 testes), mais `spectrum-frame.test.ts`: senoides conhecidas (alinhada, fora do bin, dois tons, tom sobre ruído),
silêncio exato, ruído numérico e ruído fraco, ruído de banda larga (5 sementes), banda `binCount = 0`, resolução grossa, escala conhecida/desconhecida,
clipping possível/indisponível, quadros adulterados (13 mutações), incoerência de unidade e referência, origem declarada × simulada, ausência de
`measured_verified`, guardas fixos, limites de payload em bytes, determinismo, custo, e varredura de imports (a nova camada não é importada por
nenhum arquivo de `src`/`web/src` fora do módulo).

## 8. Riscos

| Risco | Mitigação |
| --- | --- |
| Pico lido como defeito/microfonia | `meaning` fixo, avisos obrigatórios, sem campos de diagnóstico |
| Banda não resolvida lida como silêncio | estado `unresolved` próprio |
| Piso escondendo sinal legítimo muito baixo | valores originais preservados; piso configurável; contagem `belowFloor` |
| Ruído branco gerando falso pico | critério de mediana local (testado) |
| Critério de proeminência calibrado só com sintéticos | validar com PCM real consentido antes de qualquer decisão; os limiares são configuração |
| Tom abaixo do piso de apresentação em canal muito baixo | `insufficient_evidence` explícito, não conclusão |
| Evidência forjada por quem constrói o JSON | o esquema não prova autenticidade; autenticidade vem da fonte (#82), nunca do JSON |

## 9. Integrações futuras (não implementadas)

1. `SpectrumSource` mock com relógio falso (geração, frescor, revogação) — única forma de um quadro ficar "fresco".
2. Porta e adaptador em `autoconfig/recommendation` (padrão `kb-adapter` de #86): evidência espectral só como observação declarada que reduz incerteza,
   nunca como origem de número. O contrato do planejador C hoje fixa `measurements: 'unavailable'` e precisa de revisão própria.
3. Apresentação em B conforme #83 corrigido (novo estado `declared_unverified`, banda `unresolved`, condições **declaradas**).
4. `measured_verified` apenas com fonte física validada, hardware e autorização próprios.

## 10. Limites desta entrega

Somente LAB e offline. Sem `serve:real`, Ui16, captura, credenciais, escrita REAL, interface, AutoConfig ou núcleo D. Sinais sintéticos e fixtures
reproduzíveis; nada aqui comprova firmware, RTA, áudio real, acústica ou desempenho no Yoga.
