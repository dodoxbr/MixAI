# Audio Intelligence — plano de integração (#82 + #83 + #84)

**Status: relatório de revisão e plano. Nenhum código, contrato ou PR existente foi alterado.**
Base: `origin/main` c7b58fa (inclui #85 e #86). PRs revisados: #82 (a722826), #83 (b748ceb), #84 (c4f979d).
Issue de origem: #81. Tudo aqui é LAB/offline: sem `serve:real`, sem Ui16, sem captura física.

## 1. Resumo

| Pergunta | Resposta |
| --- | --- |
| Os três PRs conflitam entre si ou com a `main`? | **Não.** Arquivos disjuntos; merge dos três sobre c7b58fa sem conflito. |
| A combinação compila e passa? | **Sim.** Worktree temporária (3 branches mescladas): `typecheck`, `build`, `build:web` ok; `vitest` 90 arquivos / 1281 testes ok (1 ignorado já existente). CI individual dos três PRs: Caddy, Ubuntu e Windows `pass`. |
| O contrato #82 é compatível com a saída de #84? | **Parcialmente.** Mesma intenção e mesmos invariantes, mas há 12 divergências (seção 3). Não existe mapeamento direto sem um adaptador e sem 4 correções de contrato. |
| #84 confunde declarado com medido? | **Não.** Nenhum caminho produz "medido": a saída carrega `provenanceVerification: 'caller_declared_not_verified'` (literal), sem opção de promoção. O risco está **depois** do motor (mapeamento e interface). |
| #83 consegue consumir os resultados sem inventar? | **Em parte.** Falta um estado para "PCM fornecido, não verificado", os recortes graves/médios/agudos não coincidem com as bandas padrão, e o texto "condições confirmadas" contradiz o que #84 pode afirmar (seção 4). |
| Algo bloqueia o merge? | **Nada bloqueia.** Nenhum dos três é integrado a rota, serviço ou interface. As correções abaixo valem antes de qualquer adaptador. |

Ordem ideal de merge: **#82 → #84 → #83**, cada um a seu tempo, mais um PR de reconciliação de contrato (seção 7, passo 1) antes de qualquer código de integração.

## 2. Arquitetura recomendada

Três camadas, três substantivos distintos, cada uma com um dono:

```text
 PCM declarado ou sintético
          │
          ▼
 ┌──────────────────────────┐   puro, síncrono, sem I/O, sem relógio
 │ M  SpectrumMeasurement   │   #84  src/audio-intelligence/{engine,compare}
 └────────────┬─────────────┘
              │  measurementToFrame()  (adaptador puro, testes negativos)
              ▼
 ┌──────────────────────────┐   ciclo de vida: geração, sequência, relógio
 │ F  SpectrumFrame / Read  │   #82  (futuro) src/audio-intelligence/source/
 │    SpectrumSource        │   consentimento, frescor, revogação
 └────────────┬─────────────┘
              │  summarizeFrame()  (somente resumo tipado; sem bins brutos por padrão)
              ▼
 ┌──────────────────────────┐   porta no motor de recomendação; um adaptador
 │ E  SpectrumEvidence      │   (padrão kb-adapter de #86)
 └────────────┬─────────────┘
       ┌──────┴───────┐
       ▼              ▼
 Planejador C /    Interface B (#83)
 recomendações     só apresenta; não calcula
       │
       ▼  (nunca)  núcleo D: autorização por item continua independente
```

Regras de dependência (cada uma com teste de varredura de imports, como o de `sound-engineer-knowledge`):

1. `src/audio-intelligence/` não importa `mixer`, `autoconfig`, `server`, `assistant`, `knowledge`, rede nem relógio. Hoje isso é verdade em #84 (só `zod` e arquivos locais). Verificado nesta revisão por varredura.
2. `autoconfig/` só consome `SpectrumEvidence` por **uma porta** e **um adaptador** (mesmo desenho do `kb-adapter.ts` de #86).
3. A interface B nunca calcula espectro: renderiza `SpectrumEvidence`/`SpectrumRead` já validados e descarta resposta tardia.
4. Nada nesta cadeia importa `MixerAdapter`, `sendMessage`, o controlador, o parser ou o gate F0. Nenhum frame vira comando, proposta executável, número de EQ ou aprovação.
5. D não muda. A aprovação de `level_delta` segue por item, digest e revisão; espectro nunca entra no digest nem cria autorização.

Alternativa descartada: colocar o adaptador dentro de `engine.ts`. Isso misturaria DSP puro com ciclo de vida e frescor e quebraria a propriedade de ser determinístico e testável sem relógio.

## 3. Contratos: #82 (SpectrumFrame) × #84 (SpectrumMeasurement)

Legenda: ✅ compatível · 🔁 renomear/converter · ⚠ lacuna que exige decisão · ⛔ incompatível.

| # | Tema | #82 `SpectrumFrame` | #84 `SpectrumMeasurement` | Estado | Correção recomendada |
| --- | --- | --- | --- | --- | --- |
| 1 | Categoria de origem | `native_verified` / `audio_capture` (`measured`) / `mock` (`simulated`) | `synthetic` / `supplied_pcm` + `caller_declared_not_verified` | ⛔ | #82 não tem lugar para "PCM fornecido e não verificado". Acrescentar uma origem `supplied_pcm` com `measurement: 'declared_unverified'`. Nunca mapear para `audio_capture`/`measured`, que exige `validationRecordId`. `synthetic` → `mock`/`simulated`, mas #82 exige `fixtureId` e `seed`: #84 só tem `sourceId` (usar como `fixtureId`, `seed` exige campo novo ou valor fixo documentado). |
| 2 | Sinal/rota | canal de entrada 1–12, `pa` L/R/mono, `aux1 shared:true`, `unknown` | `channel` 1–64 ou `bus: 'AUX1'`; sem PA; ausente = desconhecido | ⚠ | Ui16 tem 12 entradas (`src/core/app.ts`); #84 aceita até 64. O adaptador valida contra o modelo. Ausente → `unknown`. `AUX1` → `shared:true` forçado. PA só existe em #82. |
| 3 | Domínio × caminho | `domain`: `electrical_line` / `acoustic` / `synthetic` / `unknown` | `path`: `unknown` / `electrical` / `acoustic`; sintético vem de `kind` | 🔁 | Tabela fixa: `synthetic` ⇒ domínio `synthetic` independente de `path`; `electrical` → `electrical_line`. |
| 4 | Nomes de campo | `sampleRateHz`, `binSpacingHz`, `hopSamples`, `window: 'hann_periodic'`, `smoothingMs`, `resolution.algorithmVersion` | `sampleRate`, `binWidthHz`, `hopSize`, `window: 'periodic_hann'`, `smoothingAlpha`, `algorithmVersion` | 🔁 | Padronizar. Sugestão: manter #84 como está (já publicado em testes) e fixar uma tabela de conversão. `smoothingAlpha` (EMA por quadro) não é `smoothingMs`: converter só quando `hop` e `fs` são conhecidos, com a fórmula documentada; senão `null`. |
| 5 | `schemaVersion` | `1` | `1` | ⚠ | Dois esquemas diferentes com a mesma versão. Prefixar por tipo (`kind: 'spectrum_measurement'` / `'spectrum_frame'`) ou namespacing no Zod. |
| 6 | Unidade de nível | `dbfs_power_per_bin`, `calibration`, `scaleDefinitionId` documentado | `power` linear + `dbRelativeToUnit` + `dbFS` (só com referência) | 🔁 | Compatível se `scaleDefinitionId` apontar para a definição de #84: potência unilateral normalizada pela energia da janela. **Atenção:** um seno de escala plena dá **−3,01 dBFS** no total (medido nesta revisão), não 0 dBFS. A definição precisa dizer isso; senão a interface vai ler um pico de 0 dBFS como erro. `dbFS: null` ⇒ `relative_unknown` + `uncalibrated`. |
| 7 | Semântica de `null` | `level: null` = abaixo do piso documentado; amostra ausente não é silêncio | `null` = **potência exatamente zero** (−∞) | ⚠ | Convergem para silêncio exato, mas #82 exige piso documentado: declarar que, em #84, o piso é zero exato. |
| 8 | Banda sem cobertura | sem equivalente | `binCount: 0` ⇒ `level.power = 0`, mas isso **não é silêncio** (resolução não cobre a banda). Confirmado: com `fftSize 256` a banda 20–80 Hz tem `binCount 0` | ⛔ | Se o adaptador copiar `level: null`, a interface mostrará "abaixo do piso" onde na verdade não houve medição. #82 precisa de estado explícito `coverage: 'resolved' \| 'unresolved'` por banda; o adaptador converte `binCount 0` em `unresolved` sem número. |
| 9 | Tamanho | `maxBins` 4096; quadro serializado ≤ 256 KiB | até 8193 bins (`fftSize 16384`); medido: 1,0 MB serializado, 255 KB com `fftSize 4096` | ⛔ | Limitar na camada de adaptador/fonte: `fftSize ≤ 4096` (2049 bins, ≈255 KB, no limite) ou publicar apenas bandas + picos para B. Outra opção: arrays numéricos compactos em vez de objetos por bin. |
| 10 | Tempo e frescor | `generationId`, `sequence`, `capturedAt`, `receivedAtMonoMs`, `clockDomainId`, idade máxima | só `inputTimestampMs` opcional, **declarado**, sem época definida | ⚠ (por desenho) | Intencional em #84 (offline). O adaptador **nunca** converte `inputTimestampMs` em `capturedAt`; os campos de tempo vêm exclusivamente do ciclo de vida da fonte. Documentar que uma medição sem fonte nunca é "fresca". |
| 11 | Confiança | `insufficient` / `limited` / `validated_for_point` | não existe | ⚠ | #84 só pode gerar `insufficient`/`limited`. `validated_for_point` requer registro de validação físico, impossível a partir de #84. Teste negativo obrigatório. |
| 12 | Clipping | `digitalClippingEstimate {fraction, thresholdDbfs, point:'captured_pcm'}` | `clipping {status, basis, fraction, longestRun, …}` | 🔁 | `status: 'unavailable'` ⇒ `null`; `thresholdDbfs` = 0 (trilhos). Nunca descrever como clipping do pré da Ui16. |

Resumo: **compatíveis em essência (1 se corrigido, 3, 4, 6, 7, 11, 12), com lacuna de contrato (1, 2, 5, 8, 9) e por desenho (10).** As correções 1, 8 e 9 são mudanças no contrato #82 e devem ser feitas **antes** de qualquer adaptador.

### 3.1 Nomenclatura de evidência (cinco vocabulários coexistem)

| Camada | Termos hoje | Significado real |
| --- | --- | --- |
| #82 | `measured` / `simulated`, `validated_for_point` | origem da fonte e validade técnica do ponto |
| #84 | `caller_declared_not_verified` | só números do PCM recebido; origem não verificada |
| #83 | MEDIÇÃO … REAL, SIMULAÇÃO LAB, RELATO HUMANO, HIPÓTESE DA IA, INFORMAÇÃO INDISPONÍVEL | rótulos visuais |
| #86 (já na main) | `observed`, `operator_reported`, `ai_suggested`, `unknown` | `observed` = **estado de controle observado no servidor**, nunca áudio |
| Diagnóstico L4 / C | `operator_report`, `control_state`, `simulated_meter`; C fixa `measurements: 'unavailable'` | evidências atuais; nenhuma espectral |

Regras recomendadas, para uma nomenclatura consistente:

1. **Não reutilizar `observed`** (#86) para espectro. `observed` continua significando estado de mesa. Espectro é uma classe nova e separada (`spectrum`), com seu próprio campo de proveniência.
2. Proveniência espectral com três valores fechados: `measured_verified` (só #82 `native_verified`/`audio_capture` com registro), `declared_unverified` (PCM fornecido, #84), `simulated` (sintético/mock). Sem valor "medido" implícito.
3. Tabela de rótulos de #83 → proveniência: MEDIÇÃO … REAL ⇐ `measured_verified`; SIMULAÇÃO LAB ⇐ `simulated`; **novo estado necessário em #83** ⇐ `declared_unverified` (ver seção 4).
4. Relato humano e hipótese da IA continuam fora do espectro; não se mistura relato com medição no mesmo campo.

## 4. A interface (#83) consome os resultados sem inventar?

O desenho de #83 é correto nos princípios (sem curva sem dados, sem mock disfarçado, origem sempre visível). Os ajustes abaixo evitam que a camada visual afirme mais que o motor sabe.

| Ponto | Problema | Correção |
| --- | --- | --- |
| Estados de origem | #83 tem cinco rótulos. Nenhum cobre "análise de PCM fornecido, origem não verificada" — o único caso que #84 produz de verdade. Sem isso a interface empurraria para SIMULAÇÃO ou REAL. | Acrescentar o estado **"PCM DECLARADO · NÃO VERIFICADO"** (cor/ícone próprios, texto obrigatório). Não pode usar o rótulo REAL. |
| Recortes graves/médios/agudos | #83 propõe 20–250, 250–4000, 4000–20000. Bandas padrão de #84: 20–80, 80–250, 250–500, 500–2000, 2000–5000, 5000–20000; **4 kHz não é uma borda**, não dá para reagrupar. | A camada de integração pede `settings.bands` próprias (suportado e validado em #84) ou #83 adota as bordas padrão. Escolher uma. |
| Destaques de frequência | #83: até 3 destaques de "DSP validado". #84 devolve até 32 máximos locais **sem limiar de significância** (declarado no próprio documento; ruído pode aparecer). | O resumo deve aplicar um critério explícito (proeminência/limiar) antes de B mostrar qualquer pico. Hoje isso não existe e **não deve ser inventado na interface**. Sem critério, B não mostra destaques. |
| Comparação A/B | #83 diz "condições de captação **confirmadas**". #84 só afirma `caller_declared_conditions_match`. | Texto de B: "condições **declaradas** iguais". Nunca "confirmadas". Mapear cada `SpectrumIncompatibility` de #84 para a mensagem de #83 (tabela fixa, com teste). |
| Banda sem cobertura | ver divergência 8 | B mostra "faixa não resolvida nesta resolução", nunca "silêncio" nem 0. |
| Escala | ver divergência 6 | B exibe "relativo à potência unitária", não "pico 0 dBFS". Eixo Y sem SPL. |
| Texto defasado | #83 foi escrito na `main` 5e2c0c3 e descreve a integração C→B→D como "em andamento"; ela foi mesclada em #85. | Atualizar a seção 2 e 9 de #83 antes do merge, citando #85/#86. |
| Frescor | #83 propõe ao vivo ≤ 1 s, desatualizado > 1 s, interrompido > 5 s; #82 define limite 1 s e `stale`, sem 5 s. | Compatível; o limiar de 5 s é do cliente e deve ser fixado no contrato antes de implementar. |

#83 não conflita com #82 nem com #84 em arquivos. A parte visual em HTML não precisa de mudança além dos itens acima.

## 5. Revisão de segurança

### 5.1 Isolamento LAB e ausência de comandos físicos

- #84 exige `mode: 'LAB'`; `REAL`, `MOCK` e campos extras caem em `INVALID_PCM` (probe executado).
- Importações de `src/audio-intelligence/`: apenas `zod` e módulos locais. Nenhuma referência a `mixer`, `autoconfig`, `server`, rede, `Date`, `Math.random` ou `fetch`.
- Nenhum arquivo fora de `test/` e do próprio módulo importa `audio-intelligence`: **a funcionalidade não está instalada em rota, serviço ou UI** (varredura em `src`, `web/src`, `test`).
- #82 e #83 são documentos; os botões do HTML são desabilitados e sem script.
- Gate F0C/L3 não é reutilizado nem relaxado (#82 faz essa ressalva e o plano abaixo a mantém).

### 5.2 Limites de memória e CPU (medidos neste PC, não no Yoga)

| `fftSize`/`hop` | Amostras | Resultado | Tempo | Heap | JSON |
| --- | --- | --- | --- | --- | --- |
| 256/256 | 262 144 | `RESOURCE_LIMIT` (1024 quadros > 256) | 4 ms | — | — |
| 4096/1024 | 262 144 | 253 quadros | 43 ms | ≈3 MB | 255 KB |
| 16 384/4096 | 262 144 | 61 quadros | 39 ms | ≈3 MB | 1,0 MB |
| 1024/1024 | 262 144 | 256 quadros | 12 ms | — | 66 KB |

- O limite de 262 144 amostras e 256 quadros é aplicado **antes** de alocar buffers de FFT e antes de varrer as amostras; o pior caso é rápido (≈ 43 ms).
- Mas a análise é **síncrona**: 43 ms bloqueiam o laço de eventos do Fastify. Quando houver rota ou fila, usar `worker_threads` ou limitar a uma análise por vez; o motor puro não deve ser chamado direto de um handler HTTP sem limite de concorrência.
- Memória transitória baixa. A saída é grande (até 1 MB): não registrar em log, não persistir por padrão, não enviar a modelos. O `fftSize` máximo na integração deve seguir a divergência 9.
- Não há benchmark do Yoga; os números de #82 (CPU < 10%, p95 < 50 ms) continuam **metas não medidas**.

### 5.3 Validações de PCM (probes executados)

Recusados com `INVALID_PCM`: `NaN`, `Infinity` (inclusive na **cauda não analisada**), array JS comum, `SharedArrayBuffer`, magnitude > 1 000 000, estéreo, chave extra, `mode: 'REAL'`, `fullScale` ausente em float, `sourceId` com espaço ou `../`, canal 65, bus `PA`. `RESOURCE_LIMIT` para entrada > 262 144 amostras. Silêncio devolve `null` (não `Infinity`), sem picos. `compareSpectra` rejeita `provenanceVerification` alterado e origem diferente.

Limitações a registrar (não são bugs, mas precisam de dono):

1. **Metadados são só declarados.** Uma medição com `kind: 'supplied_pcm'` forjada passa na validação de esquema se for consistente consigo mesma. Validar o esquema não prova autenticidade. A autenticidade deve vir da fonte (#82), nunca do JSON.
2. `channel` até 64 é folgado para a Ui16 (12 entradas). O adaptador deve restringir ao modelo.
3. `compareSpectra` valida o esquema serializado e a malha; **não** valida física.

### 5.4 Privacidade

- PCM só em memória; o motor não grava, não registra e não retém estado entre chamadas. Erros não carregam amostras.
- IDs restritos (`[A-Za-z0-9_-]`, 80 caracteres) reduzem vazamento de nomes, mas não o impedem (um ID pode ser um nome próprio). Regra de integração: IDs gerados pelo sistema, não digitados.
- O espectro por bins com janela ≥ 85 ms não permite reconstruir áudio (não há fase), mas ainda pode revelar repertório e identidade vocal em agregado. Tratar como dado sensível: sem log, sem upload, sem envio ao Gemini/Ollama por padrão; apenas resumo sanitizado e consentido para o planejador.
- Revisão local do projeto: nenhum segredo, PIN ou token aparece nos três PRs. `config/secrets.yaml` não foi lido.

## 6. Fluxo dos dados (alvo, ainda não implementado)

1. Operador habilita, com consentimento, uma **fonte** (inicialmente só `mock`/arquivo sintético em LAB). Fonte começa desabilitada.
2. A fonte entrega PCM limitado a `analyzePcm` (#84), que devolve `SpectrumMeasurement` (`declared_unverified` ou `simulated`).
3. O adaptador `measurementToFrame` gera `SpectrumFrame` com `generationId`, `sequence`, relógio monotônico local e `contextRevision` vindos do ciclo de vida da fonte; recusa o que não cabe no contrato (divergências 8, 9 e 11).
4. `read()` devolve `available`/`stale`/`unsupported`/`unavailable` conforme o frescor do servidor; frame antigo nunca volta como atual.
5. `summarizeFrame` produz `SpectrumEvidence`: origem, proveniência, rota, algoritmo, limitações, validade e, no máximo, bandas e picos já filtrados. Sem áudio, sem bins por padrão, sem comando.
6. O planejador C/recomendações recebe a evidência por porta. A regra de #86 permanece: recomendação nunca executa; autorização só em D.
7. A interface B renderiza com os rótulos da seção 3.1, descarta resposta cuja geração/contexto mudou e não oferece botão de captura, RTA ou ajuste.

## 7. Sequência de implementação

| Passo | Entrega | Pré-requisito | Hardware |
| --- | --- | --- | --- |
| 0 | Merge de #82, #84, #83 (responsável decide a ordem; recomendado nessa) | revisão técnica | não |
| 1 | **PR de reconciliação de contrato** (documento): origem `supplied_pcm`, `coverage` por banda, `scaleDefinitionId` de #84, limite de bins, nomes canônicos e vocabulário de proveniência (seção 3.1) | 0 | não |
| 2 | `SpectrumEvidence` (Zod estrito) + `measurementToFrame`/`summarizeFrame` puros, com os testes negativos da seção 8 | 1 | não |
| 3 | `SpectrumSource` **somente `mock`** com relógio falso: geração, sequência, frescor, revogação, cancelamento, um produtor | 2 | não |
| 4 | Porta e adaptador em `autoconfig/recommendation` (#86): regras que aceitam evidência espectral só como "observação declarada" que reduz incerteza; nenhuma regra gera número a partir de bins | 2, aprovação do contrato de C | não |
| 5 | Apresentação em B conforme #83 corrigido: componente desacoplado, sem rota nova de captura | 2, 4 | não |
| 6 | Prova de conceito de captura **externa** de linha, fora de evento, protocolo próprio, autorizada pelo responsável | 3, 5 e aprovação | **sim** |
| 7 | RTA nativo: só após evidência do fabricante/firmware e `native_verified` com registro; hoje `unsupported` | 6 | **sim** |

Os passos 1–5 são totalmente automatizáveis. Os passos 6 e 7 não podem ser iniciados por agentes sem autorização nova.

## 8. Testes necessários

Todos offline e determinísticos:

1. **Mapeamento**: `synthetic` → `mock/simulated`; `supplied_pcm` → nunca `measured`; qualquer tentativa de `audio_capture` sem `validationRecordId` falha; `validated_for_point` não é alcançável a partir de #84.
2. **Cobertura**: `binCount 0` produz `unresolved` e nunca `level: null`/`0`.
3. **Tamanho**: `fftSize` > limite recusado; quadro serializado > 256 KiB recusado, sem truncar.
4. **Tempo**: `inputTimestampMs` jamais vira `capturedAt`; relógio falso, replay, sequência regressiva, troca de geração, revogação e leitor cancelado.
5. **Rota**: pedido CH3 com buffer AUX1 ⇒ `unsupported(route_not_supported)`; canal > modelo recusado; AUX1 sempre `shared:true`.
6. **Varredura de imports**: `audio-intelligence` não importa mixer/autoconfig/server/knowledge; `autoconfig` importa espectro só pelo adaptador permitido.
7. **Comparação**: cada `SpectrumIncompatibility` ↔ mensagem de B; "condições declaradas", nunca "confirmadas".
8. **Evidência**: espectro não entra em `observed` (#86); C continua recusando espectro enquanto o contrato não evoluir; digest e aprovação de D inalterados (teste de regressão com os testes de D existentes).
9. **Privacidade**: log, resposta de erro e auditoria não contêm amostras, bins nem IDs digitados.
10. **Recursos**: pior caso de CPU/heap como teste de limite, com orçamento de tempo folgado (evitar teste frágil).
11. **UI**: sem captura ⇒ nenhum gráfico, nenhum zero; estado "PCM declarado" visível; resposta tardia descartada.

## 9. Dependências de hardware

Nada neste plano até o passo 5 usa hardware. O passo 6 em diante depende de itens que **ninguém verificou**:

- Interface de áudio com ≥ 3 entradas de **linha** simultâneas (PA L/R + AUX1), driver estável no Yoga/Windows, taxa e formato conhecidos.
- Pontos livres de saída da mesa, cabos, níveis e isolamento aprovados por técnico; phantom desligado; sem retorno para a Ui16, o PA ou o HA800.
- Para RTA nativo: manual v3.0 e firmware locais (o manual v3.0 não foi lido em #82; usou-se v2.8 em espelho), prova de que há bins, escala, mapa de frequência e coexistência com a interface oficial.
- Procedimento de ensaio e consentimento dos músicos aprovados pelo responsável. F0 físico continua exigindo validação supervisionada; E6 e escrita REAL continuam não autorizados.

Testes sem hardware **não comprovam** compatibilidade de firmware, topologia, qualidade acústica, segurança elétrica nem desempenho no Yoga.

## 10. Riscos e alternativas

| Risco | Efeito | Mitigação |
| --- | --- | --- |
| Rótulo "REAL"/"medido" aplicado a PCM declarado | Operador confia em evidência não verificada | Proveniência fechada de 3 valores; estado visual próprio; teste de mapeamento |
| Banda não resolvida lida como silêncio | Recomendação de reforçar graves "porque não há energia" | `coverage: unresolved`; regra: nunca recomendar com banda não resolvida |
| Pico ruidoso apresentado como destaque | Falso alarme de microfonia/ressonância | Critério de proeminência explícito antes de B; sem critério, sem destaques |
| Bus tratado como canal isolado | CH8 diagnosticado com o espectro da mix | Origem AUX1 `shared`, `route_not_supported`, textos de #83 |
| Quadros de 1 MB | Latência, memória, log acidental | Limite de bins, serialização compacta, sem log |
| Análise síncrona no laço de eventos | ≈ 43 ms bloqueados por chamada | `worker_threads` ou fila de 1 |
| Documentos defasados (#83) | Instruções contraditórias com #85/#86 | Atualizar #83 antes do merge |
| Conflito semântico `observed` | Planejador trata espectro como estado de mesa | Classe `spectrum` separada |
| Tentação de usar o VU/medidor simulado como espectro | Dado inventado | #82 e #83 já proíbem; teste de regressão |

Alternativas de fonte (resumo de #82): (a) captura externa de linha — **recomendada como prova de conceito**, pois controla o formato PCM e não depende de RTA; (b) RTA nativo — não comprovado, mantém `unsupported`; (c) análise offline de arquivo já autorizado — **valor imediato sem hardware**, `declared_unverified`, adequada ao passo 3 e a demonstrações; (d) microfone do navegador/PTT — **rejeitado** (finalidade, consentimento e roteamento próprios).
Alternativa arquitetural: unificar `SpectrumMeasurement` e `SpectrumFrame` em um único tipo foi considerada e **rejeitada**: o primeiro é puro e sem relógio; o segundo carrega ciclo de vida. Misturá-los forçaria o motor a conhecer frescor e consentimento.

## 11. Pendências e limites desta revisão

- A revisão é estática e automatizada: leitura integral dos três PRs, merge em worktree temporária, `typecheck`, `build`, `build:web`, `vitest` completo e probes do motor. **E2E e HTTPS/Caddy não foram reexecutados na combinação**: nenhuma rota, UI ou proxy é tocada (apenas arquivos novos), e o CI de cada PR passou nos três jobs.
- Números de CPU e memória são deste computador de desenvolvimento, não do Yoga.
- Não foi verificado nada de firmware, RTA ou áudio real. Os 12 itens da seção 3 são análise de contratos, não resultado de hardware.
- `docs/audio-intelligence/spectrum-examples.json` (#84) é gerado por script e não há teste de deriva contra o gerador; baixo risco, mas vale um teste.
- Os PRs #82, #83 e #84 **não foram alterados**. As correções recomendadas devem ser feitas pelos autores de cada PR ou em PRs seguintes, por decisão do responsável.
