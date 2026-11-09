# SpectrumSource — proposta de contrato somente leitura

Rascunho de arquitetura da [viabilidade #81](FEASIBILITY.md), **não API entregue**.
Não adicionar este contrato ao runtime, ao diagnóstico ou ao AutoConfig nesta fase.
Não há implementação de RTA, driver, DSP, captura física ou transporte.

## Contrato proposto

O serviço futuro receberia uma fonte já autorizada e preparada por um ciclo de
vida local separado. `read` só consulta o buffer publicado: não abre dispositivo,
conecta à mesa, troca canal ou inicia captura. Solicitar outro sinal não altera
o produtor. `native_verified` fica reservado a adaptador com validação específica
de modelo/firmware e coexistência; hoje não há nenhum.

```ts
type SpectrumSignal =
  | { kind: 'input'; channel: number }
  | { kind: 'bus'; bus: 'pa'; side: 'left' | 'right' | 'mono' }
  | { kind: 'bus'; bus: 'aux1'; shared: true }
  | { kind: 'unknown' };

type Tap = 'pre_eq' | 'post_eq' | 'unknown';
type SourceOrigin =
  | {
      kind: 'native_verified'; measurement: 'measured';
      model: 'ui16'; firmware: string;
      validationRecordId: string; // registro técnico, não aprovação de ajuste
    }
  | {
      kind: 'audio_capture'; measurement: 'measured';
      deviceAlias: string; inputIndex: number;
      validationRecordId: string; // validação do ADC/ligação, sem serial privado
    }
  | { kind: 'mock'; measurement: 'simulated'; fixtureId: string; seed: number };

interface SpectrumFrame {
  schemaVersion: 1;
  id: string;
  sourceId: string;
  generationId: string; // muda no reinício/reconexão/troca de contexto
  sequence: number;
  origin: SourceOrigin;
  signal: SpectrumSignal;
  domain: 'electrical_line' | 'acoustic' | 'synthetic' | 'unknown';
  // EQ não descreve sozinho HPF, dinâmica, fader, DAC ou amplificação externa.
  tap: Tap;
  processingContext: {
    status: 'verified' | 'unknown';
    recordId: string | null;
  };
  contextRevision: string; // observada/atestada, não gerada pelo modelo
  capturedAt: {
    startUtc: string; endUtc: string;
    basis: 'local_adc_clock' | 'verified_device_clock' | 'synthetic_clock';
    uncertaintyMs: number;
  } | null; // não fabricar timestamp da mesa
  receivedAtUtc: string;
  // Campos monotônicos só têm significado no processo que os emitiu.
  receivedAtMonoMs: number;
  clockDomainId: string;
  acquisitionAgeUpperBoundMs: number | null; // ao receber; null = desconhecido
  sampleRateHz: number | null;
  resolution: {
    kind: 'fft' | 'bands' | 'unknown';
    fftSize: number | null;
    binSpacingHz: number | null;
    window: 'hann_periodic' | 'none' | 'unknown';
    hopSamples: number | null;
    smoothingMs: number | null;
    algorithmVersion: string;
  };
  spectrum: {
    unit: 'dbfs_power_per_bin' | 'dbfs_per_hz' | 'relative_unknown';
    calibration: 'digital_reference' | 'uncalibrated';
    // Documento que define normalização/referência, sem prometer dBu ou SPL.
    scaleDefinitionId: string | null;
    bins: readonly {
      centerHz: number | null;
      lowerHz: number | null;
      upperHz: number | null;
      // null representa abaixo do piso; não NaN/Infinity na serialização.
      level: number | null;
    }[];
  };
  quality: {
    confidence: 'insufficient' | 'limited' | 'validated_for_point';
    reasons: readonly string[]; // códigos limitados, sem áudio/texto privado
    droppedFrames: number;
    digitalClippingEstimate: null | {
      fraction: number; thresholdDbfs: number;
      point: 'captured_pcm'; // nunca clipping do pré da Ui16 por inferência
    };
  };
}

type SpectrumRead =
  | {
      state: 'available'; frame: SpectrumFrame;
      // Idade de aquisição inclui o limite conhecido no recebimento.
      freshness: {
        evaluatedAtUtc: string; acquisitionAgeUpperBoundMs: number;
        expiresInMs: number;
      };
    }
  | {
      state: 'stale'; reason: 'expired' | 'age_unknown' | 'context_changed';
      lastFrameId: string | null; // sem bins atuais reutilizáveis
    }
  | { state: 'unsupported'; reason: 'unverified_native' | 'route_not_supported' }
  | {
      state: 'unavailable';
      reason: 'disabled' | 'no_sample' | 'device_missing' | 'permission_denied'
        | 'session_revoked' | 'disconnected' | 'resource_limit' | 'invalid_frame'
        | 'cancelled' | 'read_timeout';
    };

interface SpectrumSource {
  readonly sourceId: string;
  readonly kind: SourceOrigin['kind'];
  readonly capabilities: {
    signals: readonly SpectrumSignal[];
    maxBins: number; maxFramesPerSecond: number;
    changesMixerState: false;
  };
  read(request: {
    signal: SpectrumSignal;
    maxAgeMs: number;
    signalAbort: AbortSignal;
  }): Promise<SpectrumRead>;
  close(): Promise<void>; // idempotente; libera buffers, não manda comandos
}
```

## Invariantes obrigatórias para uma implementação futura

TypeScript sozinho não valida payload, identidade, relógio ou autorização.
Implementação posterior precisa de schema estrito, validação server-side e
testes negativos; este rascunho não é um gate de segurança implementado.

1. **Sem aquisição implícita.** Fonte começa desabilitada; sessão de captura
   exige operador e consentimento próprios. Não dar a `SpectrumSource` acesso a
   `MixerAdapter.write`, controlador, parser, `sendMessage`, recall ou seleção
   RTA. `read` consulta buffer, com cancelamento e prazo local máximo de 250 ms,
   nunca espera indefinidamente por seleção/dispositivo. Cancelamento/timeout
   retornam `unavailable(cancelled/read_timeout)` para esse leitor, sem mudar o
   estado compartilhado da fonte ou invalidar outros consumidores.
2. **Origem coerente.** `kind` da fonte corresponde ao de todo frame;
   `mock` só publica `simulated`, nunca medido. Não converter `SimulatedMeters`
   em espectro. Captura de um arquivo gerado também é simulada. Origem desconhecida
   não publica `available`. `native_verified` exige registro técnico conferido
   pelo servidor, sem promoção por string enviada pelo cliente.
3. **Sinal não se adivinha.** Canal 1–12 é canal de entrada, AUX1 é bus
   compartilhado. PA esquerdo/direito são streams separados; mono exige derivação
   explicitamente validada. Um bus não vira canal porque uma pessoa toca sozinha.
   Identidade desconhecida ou divergente da solicitação gera indisponibilidade,
   nunca `available` para o canal solicitado. Tap/contexto incerto limita a análise;
   não afirmar pré/pós-EQ ou efeito causal.
4. **Unidades honestas.** Frequências finitas, ordenadas e dentro de Nyquist
   quando Fs é conhecido; bandas com limites coerentes, no máximo 4096 bins.
   `centerHz: null` não vira Hz inventado. Sem mapa Hz ou escala validada,
   `relative_unknown` fica apenas para inspeção exploratória, inelegível como
   evidência espectral quantitativa. Nulos abaixo do piso exigem piso documentado
   em `scaleDefinitionId`; amostra ausente não é silêncio. Rejeitar valores
   infinitos, strings e tamanhos excedidos. `relative_unknown` exige
   `calibration: uncalibrated`; dBFS exige referência digital documentada.
5. **Frescor no servidor.** Para a mesma geração e domínio monotônico:
   `age = acquisitionAgeUpperBoundMs + (nowMono - receivedAtMonoMs)`.
   Usar `min(request.maxAgeMs, 1000)` como limite inicial (configuração futura
   pode ser mais estrita); idade negativa, desconhecida ou acima do limite não
   produz `available`. `capturedAt` nulo não impede um limite de latência
   independentemente comprovado, mas recibo sozinho não o comprova. Incerteza
   de clock deve estar incluída no limite; não comparar relógios de processos.
6. **Freshness não viaja intacto.** Não expor timestamps monotônicos ao navegador
   como se fossem UTC. Revalidar autorização, geração, contexto e idade ao consumir
   evidência em C; `available` em um instante não é validade eterna. Frames de
   geração anterior ou sequência repetida/regressiva não renovam TTL. Se não há
   sequência da fonte nativa, um contador de chegada não detecta replay de origem:
   exigir limite de atraso/continuidade comprovado ou manter idade desconhecida.
7. **Revogação e concorrência.** Revogar/encerrar invalida geração, esvazia buffers
   e impede publicação de trabalho atrasado. Cancelar um leitor não cancela
   outro nem inicia segundo produtor. Driver/acesso físico tem um único dono;
   assinantes compartilham frames imutáveis. `close` impede novas leituras e
   não reconecta, reativa ou restaura seleção da mesa.
8. **Confiança não autoriza.** `validated_for_point` significa validade técnica
   daquela medição, não certeza de diagnóstico, timbre aprovado ou permissão de
   alteração. ADC de linha não autoriza `domain: acoustic`, dBu ou SPL. Sem
   PCM, `digitalClippingEstimate` é nulo. Conclusões respeitam limitações da fonte.
9. **Estado histórico separado.** `stale` só aponta ID anterior; arquivo histórico
   eventualmente retido por política própria nunca volta como evidência atual.
   Restart não restaura frames como frescos. Sem validação física, devolver
   `unsupported(unverified_native)`; não trocar silenciosamente por `mock`.
10. **Sem integração nesta entrega.** Não modificar schemas de C ou contratos de
    D/B para encaixar este rascunho. Uma futura `SpectrumEvidence` poderá referenciar
    frame validado/resumo, origem, rota, algoritmo, limitações e validade, mas não
    carregar comandos ou aprovações. Nenhuma transmissão de áudio a serviços.

## Exemplo de classificação, sem dados reais

| Situação | Resultado esperado |
| --- | --- |
| Pedido de RTA nativo na base atual | `unsupported / unverified_native` |
| Captura externa futura configurada mas desabilitada | `unavailable / disabled` |
| Seno gerado em memória com clock sintético | `available`, origem `mock`, medida `simulated` |
| Frame real sem limite conhecido de idade de aquisição | `stale / age_unknown` |
| Operador troca fonte ou revoga sessão durante FFT | Invalidar geração e descartar resultado atrasado |
| Cliente solicita CH3 e buffer contém AUX1 | `unsupported / route_not_supported` (sem trocar produtor) |

Requisitos de aquisição física, orçamento de recursos, riscos e casos de DSP
offline estão em [FEASIBILITY.md](FEASIBILITY.md). Nenhum desses exemplos afirma
que existe hoje uma medição real disponível no MixAI.
