# Motor espectral offline — Audio Intelligence / Issue #81

Esta entrega implementa somente o pipeline DSP autorizado para o Agente C. Não encerra
os demais itens de descoberta da [Issue #81](https://github.com/dodoxbr/MixAI/issues/81).
Não implementa `SpectrumSource`, coleta, transporte, RTA nativo, UI, diagnóstico ou AutoConfig.
Branch iniciada na main `5e2c0c3` (PR #78 incorporado).

## Fronteira e origem

`src/audio-intelligence/index.ts` exporta `analyzePcm`, `compareSpectra`, contratos,
schemas e limites. Dependência externa única: Zod já existente. Sem I/O, rede, relógio,
modelos de IA, microfone, Soundcraft, mixer, armazenamento ou alteração de configuração.
Todas as chamadas exigem `mode: 'LAB'`. REAL/MOCK e campos desconhecidos são recusados.
Nenhum contrato AutoConfig ou módulo de produção preexistente foi alterado.

O motor **mede os números PCM recebidos**, não prova a origem do áudio. `origin.kind`
separa `synthetic` de `supplied_pcm`; ambos mantêm
`provenanceVerification: 'caller_declared_not_verified'`. O segundo não equivale a áudio
real verificado. Não existe opção `measured: true` ou `native_verified` no motor.
Canal/rota são rótulos declarados, não identificação da fonte a partir do som.
`path` e `tap` aceitam `unknown`; declarar `pre_eq` não comprova esse ponto físico.

Não há espectro real obtido pelo MixAI nesta entrega. O RTA visual da Ui16 não prova
acesso a seus bins. A gravação USB estéreo não comprova interface de captura PC nem
multitrack. Referências de descoberta: manual oficial Ui v3.0 e página de produto
citados na Issue #81; viabilidade física permanece com o trabalho de descoberta.

## Entrada explícita

```ts
import { analyzePcm, compareSpectra, type PcmInput } from './src/audio-intelligence/index.js';
const input: PcmInput = {
  mode: 'LAB', channels: 1, format: 'f32', fullScale: 1,
  sampleRate: 48000, samples: new Float32Array(4096), // silêncio sintético
  origin: {
    kind: 'synthetic', sourceId: 'fixture_voice', conditionsId: 'setup_v1',
    target: { kind: 'channel', channel: 3 }, path: 'unknown', tap: 'unknown',
  },
  settings: { fftSize: 4096, hopSize: 2048, peakCount: 8 },
};
const before = analyzePcm(input);
const after = analyzePcm(input);
const comparison = compareSpectra(before, after);
```

- Mono obrigatório (`channels: 1`). Sem downmix implícito. Stereo/interleaving devem
  ser separados por um futuro adaptador, com consentimento e metadados próprios.
- `s16`: `Int16Array`, valores numéricos assinados; escala implícita 32768.
- `f32`: `Float32Array`; `f64`: `Float64Array`. `fullScale: 1` declara referência
  digital unitária. `fullScale: null` significa escala desconhecida. Sem essa
  informação, a entrada float é inválida. Não são aceitos bytes crus, WAV, formatos
  24-bit, arrays JS, NaN/Infinity ou memória compartilhada.
- Typed arrays já contêm valores decodificados; endianness/decodificação pertencem
  ao fornecedor do PCM. Não há instalação de decoder ou acesso automático a arquivos.
- Taxa inteira de 8.000 a 192.000 Hz; sem resampling. Magnitude float máxima 1.000.000
  para limitar faixa numérica; valores acima de ±1 continuam válidos quando declarados.
- `inputTimestampMs`, opcional, é um timestamp **declarado**, não coletado/validado aqui.
  Não estabelece frescor. Não enviar nomes, caminhos, áudios privados ou segredos em IDs.

`SpectrumInputError.code` distingue `INVALID_PCM` (forma, formato, modo ou valores),
`INSUFFICIENT_SAMPLES`, `INVALID_SETTINGS` (hop/bandas inconsistentes) e `RESOURCE_LIMIT`.
Erros não incluem amostras nem relatos privados. Opções fora do schema também são
`INVALID_PCM`. Não há padding, truncamento silencioso ou tentativa automática.

## FFT, níveis e bandas

Janela Hann **periódica**, `w[i] = 0,5 × (1 − cos(2πi/N))`. FFT radix-2 interna em
Float64, sem dependências DSP adicionais. Uma FFT por quadro; hop permite sobreposição
entre 25% e 100% de N. Não se remove DC e não se interpola frequência entre bins.

Para cada bin `k` de `0..N/2`, a potência unilateral é:

`P[k] = c[k] × |FFT(x × w)[k]|² / (N × soma(w²))`,

com `c=1` em DC/Nyquist e `c=2` nos demais bins. Assim a soma representa potência média
ponderada pela janela, em unidades PCM² normalizadas quando a escala é conhecida.
Não é densidade por Hz, amplitude de pico da senoide nem SPL. Senoide estacionária
coerente de amplitude A resulta em potência total A²/2, distribuída pela janela.

`bins` fornece Hz e potência por bin; `totalSpectralPower` soma todos. Bandas padrão:
20–80, 80–250, 250–500, 500–2.000, 2.000–5.000 e 5.000–20.000 Hz, recortadas ao Nyquist.
Essas são **faixas de análise**, não recomendações por instrumento. Bandas customizadas
exigem IDs únicos, ordem crescente, ausência de sobreposição e limites dentro de
0..Nyquist. Incluem centros de bins `[low, high)`; a borda Nyquist entra se for o limite
superior da banda. Energia abaixo de 20 Hz/acima de 20 kHz ou nas lacunas pode ficar fora
das bandas, mas continua no total. Não há repartição artificial de bins entre bandas.
`fractionOfTotalPower` usa o total completo, incluindo DC.
`binCount` informa quantos centros participam de cada banda. Quando é zero, a resolução
não cobre aquela faixa com centros de bins: potência agregada zero **não comprova**
ausência de energia nessa faixa. O consumidor deve exibir cobertura indisponível,
sem interpretar esse zero como silêncio medido na banda.

Picos são máximos locais, ordenados por potência e desempate por bin. Têm resolução
`sampleRate / fftSize`; não são frequências identificadas de microfonia, notas,
fontes separadas ou diagnósticos. Não há limiar de significância: resíduos numéricos e
ruído podem aparecer entre os picos menores. Nunca interpretar um pico automaticamente
como defeito. Silêncio exato não produz picos.

RMS usa **cada amostra uma vez** no prefixo analisado, antes da janela, sem DC removal.
A cauda menor que um hop é declarada em `discardedTailSamples` e excluída das estatísticas;
a entrada inteira ainda é validada. `analyzedSamples`, `frames` e duração são explícitos.
A potência espectral ponderada e RMS global não precisam coincidir em sinais transitórios.

`dbRelativeToUnit = 10 log10(power)` (RMS: 20 log10(linear)). `dbFS` só é disponibilizado
para s16 ou float com referência unitária declarada; float desconhecido usa unidades PCM.
Zero retorna `null` como representação JSON de −∞. `representation.levelReference`
distingue esse zero de referência dBFS indisponível. Não usar zero dB no lugar de −∞.
Precisão numérica finita não distingue energia abaixo do underflow de zero exato.

## Suavização e recursos

Sem `smoothingAlpha`, usa média aritmética das **potências** de todos os quadros.
Com alpha `(0,1]`, usa EMA `S0=P0; St=alpha×Pt+(1−alpha)×S(t−1)` e retorna a última
estimativa. Alpha=1 usa o último quadro. Não se faz média em dB; RMS/clipping não são
suavizados. Estado é local a cada chamada: não mistura canais, capturas ou ensaios e
não guarda PCM entre chamadas. Para EMA, comparações exigem mesmos alpha, hop e cobertura.

Limites fixos exportados em `SPECTRUM_LIMITS`:

| Recurso | Limite |
| --- | --- |
| Amostras mono/chamada | 262.144 |
| FFT | potência de dois, 256..16.384; padrão 2.048 |
| Quadros/chamada | 256 |
| Hop | N/4..N; padrão N/2 |
| Bandas | 32 |
| Picos | 32; padrão 8 |
| Bins de saída | N/2+1, máximo 8.193 |

Valida comprimentos e custo antes de percorrer amostras/alocar buffers FFT. Usa três
buffers de N (janela, real, imaginário) e um de N/2+1 para agregação; não retém uma matriz
de todos os quadros. Custo `O(frames × N log N)` e memória `O(N + bandas + picos)` além
da entrada/saída. Comparação limita tamanhos antes de validar os arrays serializados.
Sem fila interna, timer, stream ou tarefa em background. A função é síncrona: um futuro
consumidor deverá usar worker dedicado/fila limitada, uma análise em andamento e taxa
máxima explícita (por exemplo, até 5 Hz após medir desempenho no Yoga), descartando
quadros obsoletos e permitindo cancelamento entre chamadas. Isso não é garantia de
latência nem autorização para ligar esse processamento ao event loop do servidor.

## Possível clipping

- s16: conta amostras exatamente em −32768 ou +32767.
- Float com `fullScale: 1`: conta magnitude ≥1, inclusive overs.
- Float sem escala: `unavailable`, contagens/fração/maior sequência `null`.

Só o prefixo analisado participa. `possible` não comprova saturação analógica: uma
senoide legítima tocando o trilho ou exportação normalizada também pode fazê-lo.
`not_indicated` não exclui clipping anterior atenuado, limitação/codec, ou picos entre
amostras. Não há true-peak, detector de distorção, reconstrução oversampled ou medição
de headroom analógico. Nenhum resultado dispara ação.

## Comparação antes/depois

`compareSpectra` valida o schema dos resultados e a grade/cobertura. Retorna
`incomparable` com motivos quando faltam condições, ou diferem origem, canal/rota,
sourceId, conditionsId, kind, path/tap, formato/escala, sample rate, FFT/hop/janela,
agregação/alpha, número de picos, bandas ou cobertura/duração. Timestamps podem diferir.
Não tenta corrigir ganho, normalizar timbre, interpolar ou reamostrar para forçar igualdade.

`conditionsId` é obrigatório para comparar: o chamador afirma que fonte física,
captação, ganho, posicionamento, processamento e roteamento relevantes não mudaram,
exceto a variável que está sendo estudada. Mesmo IDs iguais **não comprovam** condições
físicas iguais. O resultado diz `caller_declared_conditions_match`, nunca “verificado”.
Schemas validam estrutura, não autenticidade; evidência externa forjada não se torna
confiável por passar no parser. Apenas resultados do motor com proveniência controlada
poderão ser promovidos por um adaptador posterior.

Diferenças são razões de RMS (20 log) ou potência por banda (10 log). Zero preserva
`both_zero`, `from_zero` ou `to_zero` com `deltaDB: null`. Não serializa ±Infinity,
nem afirma melhora, piora, causa, medição acústica ou ajuste ideal de EQ.
Bandas com `binCount: 0` retornam `power: null` na comparação: não há delta disponível,
nem alegação de silêncio ou igualdade nessa faixa.

## Contrato para futura SpectrumSource (Agente D)

Não há interface/classe `SpectrumSource` implementada ou importada por este motor.
O adaptador futuro pode invocar o seguinte port existente, sem dependência inversa:

```ts
type OfflineAnalyzer = (input: PcmInput) => SpectrumMeasurement;
```

O fornecedor deverá entregar mono PCM com formato/escala/taxa e origem explícitos,
comprimentos dentro dos limites, timestamp, condições de comparação e consentimento
tratado **fora** do DSP. Deverá mapear `SpectrumMeasurement` para o contrato autoritativo
que D definir, preservando `synthetic` versus PCM fornecido, `caller_declared_not_verified`,
referência de nível, ponto de captação desconhecido, resolução e limitações. Não mapear
`dbRelativeToUnit` como dBFS nem como SPL; não transformar clipping possível em certeza.

Estados `unsupported/unavailable/stale`, frescor, confiabilidade, seleção da fonte,
consentimento, retenção/privacidade, fila/backpressure e autoria de timestamps são
responsabilidades externas futuras. `SpectrumInputError` deve virar erro controlado,
sem reenvio de comandos, falha para REAL ou inventar um quadro zero. Os bins nativos de
um eventual RTA não são PCM e **não podem** ser passados à FFT como amostras de áudio.
Qualquer fonte nativa precisa de contrato/documentação e comprovação separados.

O analisador não recomenda EQ, não cria propostas e não dá aprovação. Nenhuma alteração
em contratos AutoConfig, guardas F0/E6, `RealMixer` ou `ConnectionSupervisor`. Não conectar
à mesa nem disputar RTA com a UI oficial. Futuras avaliações físicas exigem autorização
separada, captação externa validada e procedimentos de segurança/consentimento próprios.

## Cenários, exemplos e validação

[Exemplos estruturados](spectrum-examples.json): uma medição completa válida no schema,
mais quatro pares resumidos (omitindo somente `bins`) e comparações completas. Todos
são sinais **sintéticos**, não gravações da banda:

- CH8 surdo: energia transferida entre 46,875 e 187,5 Hz, sem classificar timbre.
- CH3 voz principal: concentração artificial em 750 versus 3.000 Hz, sem alegar inteligibilidade.
- CH1 cavaco: concentração artificial em 3.000 versus 9.000 Hz, sem alegar estridência.
- AUX1 compartilhado: soma artificial de graves, médios e agudos, sem separar fontes do mix.

Regenerar de forma determinística (saída padrão, sem captura ou acesso a serviços):

```bash
npm exec -- tsx scripts/spectrum-examples.ts > docs/audio-intelligence/spectrum-examples.json
npm exec -- vitest run test/spectrum-engine.test.ts
npm run typecheck
npm run build
npm test
```

A suíte inclui senoides coerentes e fora de bin, múltiplos tons, DC/Nyquist, silêncio,
ruído determinístico conferido contra DFT direta, redução de vazamento pela Hann,
PCM s16/f32/f64, saturação/overs/escala desconhecida, seis taxas de 8 a 192 kHz,
EMA/média/sobreposição/cauda, entrada inválida, memória compartilhada, insuficiência,
limites de CPU/memória, comparação compatível/incompatível, zeros e quatro pilotos.
Resultados das regressões e CI Ubuntu/Windows/Caddy/smoke constam do PR deste SHA.
UI/E2E/HTTPS não têm integração nova nesta entrega; continuam cobertos pela CI existente.
Pendentes: desempenho no Yoga físico, qualquer áudio real, calibração, autorização da
captura, qualidade acústica, adequação de uma futura fonte e ensaio físico supervisionado.
