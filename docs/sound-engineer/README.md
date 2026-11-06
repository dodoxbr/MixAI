# MixAI Sound Engineer — primeira entrega da Issue #13

Base de conhecimento **somente para consulta**, em `src/knowledge/sound-engineer/`.
Branch: `feature/sound-engineer-knowledge`, criada da `main` em
`274b92416a1d49de1d2efda36fc6aee01fff2ef3`. Não há integração ao assistente,
MCP, servidor, parser, controlador ou adaptador da mesa. Nenhum arquivo existente
da E7A foi alterado. Esta entrega cobre B1 e uma consulta determinística mínima de
B2; não implementa aplicação de propostas nem simulação de DSP.

## Organização

| Arquivo | Responsabilidade |
| --- | --- |
| `contracts.ts` | Tipos e validação Zod estrita de entrada; evidências, hipóteses, confiança, recomendações e diagnóstico |
| `sources.ts` | Catálogo de fontes com versão, escopo e data de consulta |
| `capabilities.ts` | Matriz Ui16 × biblioteca 7.1.0 × MixAI × verificação física |
| `fundamentals.ts` | Ganho, EQ/HPF, dinâmica, AUX e feedback |
| `procedures.ts` | Perguntas, causas alternativas, inspeções, ensaio teórico, observação esperada e parada para cinco sintomas |
| `instruments.ts` | Captação, função musical, orientação condicional e cuidados para samba/pagode |
| `diagnose.ts` | Função pura: contexto estruturado → orientação teórica, sem escrita |
| `examples.ts` | Seis entradas fictícias reproduzíveis, incluindo uma sem evidência acústica |
| `index.ts` | Exportações para consulta explícita, sem registro em produção |

Leitura de contexto: [estado atual](../../ESTADO-ATUAL.md),
[gap analysis](../lab/01-GAP-ANALYSIS.md),
[revisão de arquitetura, seção 12](../lab/02-ARCHITECTURE-REVIEW.md),
[plano E6/E7](../lab/03-IMPLEMENTATION-PLAN.md) e
[assistente E4](../lab/08-E4-ASSISTENTE.md).
A expectativa antiga de diagnosticar EQ pelo VU não é adotada aqui:
VU não fornece espectro, frequência de microfonia ou julgamento de timbre.

## Fontes e rastreabilidade

Consulta em 06/11/2026. Cada orientação aponta para um `SourceId` e um localizador
(seção, página ou assunto). O catálogo tipado contém os links completos. Fontes
estabelecem fundamentos; as adaptações aos instrumentos de samba/pagode são
**inferências editoriais MixAI**, sem validação em ensaio. Não há presets oficiais,
parâmetros de fábrica ou curva ideal por instrumento.

- [Soundcraft Ui12/Ui16 User Guide v3.0, inglês](https://www.soundcraft.com/en-US/product_documents/ui_usermanual_v3-0-pdf-27c992b4-5132-4d2d-b8e2-79750de6ee29): seções 2.2–2.3, 4.1–4.3, 5.2–5.4 e 9.0.
- [soundcraft-ui-connection](https://github.com/fmalcher/soundcraft-ui), **7.1.0**: pacote instalado correspondente ao lockfile, `lib/facade/**/*.d.ts`, `lib/vu/*.d.ts`, `lib/device-capabilities.d.ts` e implementação distribuída. [Documentação da biblioteca](https://fmalcher.github.io/soundcraft-ui/) pode refletir outra versão; para esta entrega prevalece o pacote fixado.
- [Yamaha: Equalization](https://hub.yamaha.com/proaudio/livesound/eq/): EQ, filtros e separação entre fontes.
- [Yamaha: Gain Staging](https://hub.yamaha.com/proaudio/livesound/gain-staging/): compatibilidade de entrada e margem de sinal.
- [Yamaha: How to Use a Compressor](https://hub.yamaha.com/proaudio/livesound/tools-of-the-trade-how-to-use-a-compressor/): dinâmica e cuidados de uso.
- [Shure: Three Reasons Why Mic Placement Matters](https://www.shure.com/en-EU/insights/three-reasons-why-mic-placement-matters): captação e proximidade.
- [Shure: Microphone Techniques for Live Sound Reinforcement](https://content-files.shure.com/dievision/archive/damfiles/default/global/documents/publications/en/performance-production/microphone_techniques_for_live_sound_reinforcement_english.pdf-3df433145fca686a736beeb5da588efa.pdf): regras gerais, especialmente pp. 18–21.

Os acessos diretos por `curl` às páginas de produto da Soundcraft retornaram HTTP
403. O manual oficial acima foi consultado por pesquisa/navegação web no próprio
domínio oficial. Não foi necessário baixar firmware nem conectar à mesa. Nenhum
manual/PDF ou trecho extenso foi redistribuído; os textos da base são sínteses e
orientações próprias com referências. Fontes dos fabricantes mantêm seus direitos;
a biblioteca declara licença MIT.

**Versão de manual não equivale a versão de firmware.** Firmware da Ui16 da banda
continua desconhecido. Antes de validar controle real, registrar modelo, firmware
exibido na interface oficial, versão da biblioteca, data, operador e evidência do
ensaio. Não assumir equivalência com Ui24R.

## Comparação de capacidades

A matriz tipada em `capabilities.ts` é a referência detalhada e contém os caminhos
da biblioteca para auditoria. `hardwareVerified` é `false` em todas as linhas.

| Recurso | Biblioteca 7.1.0 para Ui16 | Situação MixAI nesta base |
| --- | --- | --- |
| Nível/mute e envios AUX | Disponíveis | Controles existentes permanecem nas políticas atuais; esta base não os chama |
| EQ paramétrico de 4 bandas, frequência HPF, bypass paramétrico | Disponíveis | Só LAB no registro atual; esta base apenas orienta |
| Inclinação do HPF e LPF de entrada | Declarados exclusivos da Ui24R, sem efeito na Ui16 | Não propor aplicação na Ui16 |
| Compressor, gate, de-esser, GEQ, AFS e RTA | Sem fachada tipada comprovada | Orientação conceitual e consulta manual; nenhum método de protocolo inventado |
| Medidores | `vuProcessor` disponível | Aquisição real não integrada; medidores atuais são simulados |
| Ganho de pré e phantom | `HwChannel` disponível | Bloqueados para o assistente, sem comandos nesta entrega |
| Pontos pre/post de AUX | `SendChannel` e `AuxChannel` | Inspeção conceitual; sem alteração de roteamento |
| Gravação estéreo USB | Gravador de dois canais | Não é captura para o assistente |
| Multipista USB | Ui16 marcada `multitrack: false` | Sem promessa de pistas separadas |

A biblioteca distingue 12 entradas mic/linha e **6 buses AUX** na Ui16. O manual
separa as 4 saídas XLR dedicadas das saídas condicionais 5/6 via fones (4.3). Isso
não significa seis conectores XLR. A banda usa AUX 1 compartilhado; não há mix
independente por saída do amplificador de fones.

**Divergência preservada para revisão da E7:** `src/core/params.ts` e documentos
antigos listam inclinações 12/24/36 dB/oct no LAB. O contrato instalado em
`lib/facade/eq/eq-filter.d.ts` declara `setSlope` sem efeito e `slope$` sem emissão
na Ui12/Ui16. Esses números não comprovam capacidade da mesa. Esta entrega não
altera o registro ou a E7A. Pelo manual 5.2, bypass do EQ paramétrico também não
desliga HPF/de-esser; não o usar como comparação de toda a cadeia.

## Procedimentos e samba/pagode

O ciclo de consulta é: relato → esclarecer contexto → listar hipóteses → orientar
inspeções → discutir um ensaio supervisionado → operador relata resultado.
Nesta entrega o ciclo termina na orientação: não há aplicação ou avaliação
acústica automática. Comparações são feitas pelo operador no mesmo trecho, em
nível confortável e semelhante, com estado anterior registrado. Inspecionar a
fonte sozinha exige cuidado com o roteamento de solo da mesa; não enviar solo,
mute ou reset automaticamente ao PA.

| Queixa | Investigar primeiro | Exemplo condicional, sempre teórico |
| --- | --- | --- |
| Embolado | Fonte isolada × roda, vazamento, ressonância, proximidade | Abrir espaço entre tantã, surdo e baixarias do violão |
| Estridente | Ataque/platinelas × sibilância × apito, captação e distorção | Reduzir agressividade de uma fonte preservando articulação |
| Abafado | Fonte acústica, eixo do microfone e cortes/dinâmica existentes | Rever captação e presença antes de acrescentar brilho |
| Magro | HPF, cortes, DI e múltiplos caminhos | Recuperar corpo removido antes de reforçar graves |
| Desequilíbrio / sumindo | Destino, arranjo, nível, mascaramento e variações da execução | Rever fonte dominante e mix compartilhada antes de subir tudo |

Faixas exploratórias em `procedures.ts` são pontos de investigação, sem promessa
de correspondência ao problema real. Não são medições ou ajustes calculados.
Cada procedimento inclui alternativas, perguntas, critérios de melhora e de
parada. Se houver apito relatado, o operador prioriza controle seguro de nível e
posicionamento; não se induz microfonia com varredura de boost.

Os guias de instrumentos preservam suas funções: cavaco com ataque legível;
violão, especialmente 7 cordas, com baixarias; surdo com peso; tantã com sustentação
e notas suaves; pandeiro com pele e platinelas; vozes com corpo e dicção. Todos
trazem verificações de captação e avisos contra correções padronizadas. Ensaios
musicais ainda precisam validar cada hipótese no repertório e ambiente da banda.

## Contrato e exemplo executável offline

```ts
import { diagnose, examples } from './src/knowledge/sound-engineer/index.js';

const result = diagnose(examples.cavacoEstridente);
// status: 'theoretical_guidance'
// confidence.level: 'low'
// audioAnalysis: 'not_performed'
// recommendations: inspeções e um ensaio teórico, execution: 'not_executable'

const insufficient = diagnose(examples.apenasControles);
// status: 'needs_context', confidence.level: 'insufficient'
// recommendations: [] — faders e VU simulado não comprovam timbre
```

Para executar sem hardware após instalar dependências:

```bash
npx tsx -e "import {diagnose, examples} from './src/knowledge/sound-engineer/index.ts'; console.log(JSON.stringify(diagnose(examples.cavacoEstridente), null, 2))"
npm test -- test/sound-engineer-knowledge.test.ts
```

Entrada validada como objeto estrito. Evidências têm IDs únicos e três origens:
relato do operador com sintoma, valor observado de controle com revisão, ou
medidor explicitamente simulado. Desconhecido é ausência, nunca zero inventado.
Não há tipo de captura real, espectro ou VU real aceito nesta entrega. Timestamps,
freshness e calibração pertencem à futura aquisição, que exigirá novo contrato.
Não existe parser de queixa livre; o consumidor deve escolher um sintoma do
vocabulário e preservar o relato como relato.

A confiança é qualitativa e não calibrada. Os tipos reservam níveis futuros,
mas a consulta só retorna `insufficient` ou `low`, independentemente da quantidade
de relatos. Relato incompatível com o sintoma solicitado não sustenta hipóteses.
A revisão de um controle serve para rastrear estado, não confirma causa acústica.
Sem instrumento/destino, só há perguntas e inspeções; nenhum ensaio de ajuste.

Recomendações referenciam hipóteses, evidências e fontes; incluem precondições,
observação esperada e parada/reversão pelo humano. São texto, sem payload de
comando, parâmetros aplicáveis, aprovação ou ID de pendência.

Próximas etapas: [plano de integração](INTEGRATION.md).
Resultados e limites: [validação](VALIDATION.md).
