# Audio Intelligence — viabilidade de espectro na Ui16

Issue [#81](https://github.com/dodoxbr/MixAI/issues/81). Pesquisa em 2026-11-09,
sobre `origin/main` em `5e2c0c30d8f4219a7df1ce8d8221a7e4202691c7`.
**Somente pesquisa e arquitetura. Nenhuma aquisição implementada ou validada.**

## Decisão recomendada

Priorizar uma prova de conceito futura de **captura externa de linha**, local no
Yoga, com interface de áudio dedicada e ligação previamente aprovada. Essa opção
permite controlar o formato PCM e não depende de selecionar o RTA da mesa.
Não é uma promessa de ligação sem impacto: carregamento elétrico, aterramento,
níveis, cabos e estabilidade do driver precisam ser verificados fora de evento.
Não comprar equipamento nem conectar nada com base apenas neste estudo.

Manter o RTA nativo como possibilidade **não comprovada para o MixAI**. Há código
comunitário que decodifica mensagens espectrais, mas não uma API oficial de bins
identificada nas fontes consultadas, nem prova de leitura passiva na Ui16 da
banda. Não usar a ausência dessa prova para afirmar que o protocolo não existe.

O contrato proposto está em [SPECTRUM-SOURCE.md](SPECTRUM-SOURCE.md). Não há mudanças
em AutoConfig, autenticação, comandos, transporte, interface ou configuração REAL.

## Fontes e força da evidência

Os identificadores abaixo são usados na matriz. Fontes externas foram apenas
lidas; nenhum exemplo de controle foi executado. Não foi baixado firmware.

| ID | Fonte / localização | Acesso e alcance |
| --- | --- | --- |
| S1 | [Manual oficial Ui12/Ui16 v3.0](https://www.soundcraft.com/en/product_documents/ui_usermanual_v3-0-pdf-27c992b4-5132-4d2d-b8e2-79750de6ee29) | URL da Issue; HTTP 403 nesta sessão. Não alegamos ter lido a v3.0. |
| S2 | Manual **Soundcraft** Ui12/Ui16 v2.8, [PDF republicado](https://device.report/m/7ca9abcfbd56d5faba89d34065e5a3ad76dca3b388f9259c76927ef86be37fe1.pdf) e [texto](https://device.report/m/7ca9abcfbd56d5faba89d34065e5a3ad76dca3b388f9259c76927ef86be37fe1) | Documento do fabricante em espelho, lido pelo navegador de pesquisa; download local deu 403. Seções 2.2, 5.2, 5.3, 9.0, 10.0; capa identifica v2.8. Não substitui conferência da v3.0 e do firmware local. |
| S3 | [Produto Ui16](https://www.soundcraft.com/pt/products/ui16) | HTTP 403; resultados indexados e fatos citados na Issue corroboram S2, mas não substituem leitura da página atual. |
| S4 | [HARMAN — FX e AUX](https://help.harmanpro.com/en_US/configuring-fx-sends-aux-sends-with-soundcraft-ui-mixers), transcrição, distinção entre modelos | Lida; diferencia o patching da Ui24R das Ui12/Ui16. Não importar recursos da Ui24R para a Ui16. |
| S5 | [`soundcraft-ui-connection` 7.1.0](https://github.com/fmalcher/soundcraft-ui/tree/7f307f22f9dd87aff44e3774971be3f54879184c/packages/mixer-connection/src/lib/vu), [`VU`](https://github.com/fmalcher/soundcraft-ui/blob/7f307f22f9dd87aff44e3774971be3f54879184c/docs/docs/features/vu.md), [natureza comunitária](https://fmalcher.github.io/soundcraft-ui/) | Inspeção estática dos tipos instalados e código público nesse commit. VU e stream genérico de mensagens não são contrato espectral validado. |
| S6 | Código do próprio autor: [`uidata_display.html` L27–74](https://github.com/ohnoitsalobo/soundcraft-ui/blob/04b6adc4ae51b88a83148047191093043f5ce9f9/ui12data_websocket/uidata_display.html#L27), [`README` L12–16](https://github.com/ohnoitsalobo/soundcraft-ui/blob/04b6adc4ae51b88a83148047191093043f5ce9f9/ui12data_websocket/README.md#L12), [`usermod.cpp` L95–114](https://github.com/ohnoitsalobo/soundcraft-ui/blob/04b6adc4ae51b88a83148047191093043f5ce9f9/WLED_GEQ_usermod/usermod.cpp#L95) | Evidência primária de **implementação comunitária**, não do fabricante ou do funcionamento na nossa Ui16. Código lido, não executado. |
| S7 | [Rational Acoustics — tipos de medição](https://support.rationalacoustics.com/support/solutions/articles/150000190431-measurement-101-types-of-measurement), seções Single/Dual Channel e RTA | Lida; distingue espectro do sinal de resposta do sistema, fase e tempo. |
| S8 | [Focusrite — mic, line e instrument](https://support.focusrite.com/hc/en-gb/articles/115004171025-What-are-the-differences-between-mic-line-and-instrument-level), [phantom](https://support.focusrite.com/hc/en-gb/articles/115005178505-What-is-48V-phantom-power) | Lidas; níveis e alimentação dependem da conexão e do equipamento. Não especifica o cabeamento da banda. |
| S9 | [SciPy 1.15.2 — periodogram](https://docs.scipy.org/doc/scipy-1.15.2/reference/generated/scipy.signal.periodogram.html) | Lida; referência independente para validar matematicamente frequência, janela e escala em testes offline futuros. Não é dependência proposta para produção. |
| L1 | [MixerAdapter](../../src/mixer/types.ts), [mapeamento](../../src/mixer/protocol-map.ts), [RealMixer](../../src/mixer/real.ts) | Código local nessa base: espelho de parâmetros de controle; não expõe PCM ou `SpectrumFrame`. |
| L2 | [Medidores](../../src/server/meters.ts) | `SimulatedMeters` deriva valores de fader/MUTE e recusa modo REAL; não mede áudio. |
| L3 | [Gate F0C](../../src/mixer/readonly-socket.ts), [observador](../../src/mixer/readonly-observer.ts), [documentação F0C](../lab/18-F0C-READONLY-OBSERVER.md), [evidência F0 #43](https://github.com/dodoxbr/MixAI/issues/43) | Gate tem lista positiva de saída e gerações; F0 não comprova aquisição espectral. O observador exige áudio desconectado, portanto não é procedimento para ensaio com sinal. |
| L4 | [Evidências do diagnóstico](../../src/knowledge/sound-engineer/contracts.ts), [integração futura](../sound-engineer/INTEGRATION.md) | Relato, estado de controle e medidor simulado são distintos. Não existe variante de evidência espectral no diagnóstico atual. |

O PDF HARMAN “Can a DAW Be Used with the Ui16”, localizado em busca pública,
retornou 404 no acesso direto e falhou na renderização. **Não foi usado como
comprovação** de suporte ou ausência de interface USB. Não foram usados fóruns,
resumos de busca ou analogia com outro modelo como prova de protocolo.

## O que o RTA documentado analisa

S2 §5.2 descreve espectro do sinal de entrada na página de EQ; o RTA de entrada
fica ativo em um canal por vez e ativá-lo em outro desativa o anterior, inclusive
em outro cliente. §5.3 apresenta RTA nos masters de AUX e estéreo. As 31 bandas
descritas ali são **controles de GEQ**, não prova de 31 bins do analisador.

S2 não fornece, nessas seções, identificação inequívoca do tap do RTA antes/depois
de EQ, HPF, dinâmica ou fader, nem definição dos bins, escala numérica e timestamps
do transporte. “Incoming signal” não basta para fixar todos esses metadados.
Não estender a regra de exclusividade de entrada a um número de analisadores de
saída sem verificar. O RTA é uma observação de sinal no mixer; não comprova SPL
ou a resposta acústica do PA no público [S7].

## Dados numéricos e possibilidade de leitura passiva

S6 contém tratamento de mensagem identificada como `RTA^`, decodificação Base64
e desenho de barras; o exemplo WLED usa um array de 122 valores. Esses números
são **suposições desse código**, sem calibração em Hz/dB demonstrada para nossa
Ui16. O README de `ui12data_websocket` ainda diz que pretende testar Ui16/Ui24.
Não copiar coeficientes, frequências, reconexão automática ou exemplos de controle.

No arquivo de exibição, a abertura da conexão envia keepalive, sem seleção ou
ativação explícita de RTA. Isso sustenta uma **hipótese** de que mensagens já
disponíveis possam ser consumidas sem alterar a seleção. Não comprova que elas
cheguem com RTA desligado, que representem sempre o mesmo sinal, ou que a Ui16
permita essa leitura simultânea sem afetar a UI oficial.

Há duas definições diferentes de passividade:

- **Nenhum pacote de saída para a mesa:** captura autorizada de tráfego já
  existente, em ponto de espelhamento externo previamente aprovado. Outro cliente
  WebSocket com handshake/keepalive não satisfaz essa definição. Não implementado;
  exige verificar topologia, privacidade e impacto do mecanismo de observação.
- **Nenhuma mudança de estado operacional:** consumidor de mensagens já emitidas,
  com guarda de saída e sem ativação/seleção. É candidato, não capacidade validada.
  Conectar outro cliente já consome recursos; “read-only” não significa impacto zero.

Se for necessário ativar RTA, mudar seleção, SOLO/PFL/AFL, roteamento ou tomar
posse de um analisador para obter dados, essa alternativa **falha o requisito de
leitura estritamente passiva**. Não fazer isso automaticamente nem disputar a
seleção com a interface oficial. Sem sinal identificável, reportar indisponível.

S5 oferece `inbound$` genérico e processamento de `VU2^`; os tipos VU representam
níveis agregados. Não há fachada tipada de RTA identificada nos tipos 7.1.0
inspecionados. Existência de stream bruto não valida aquisição, escala ou origem.
L1/L3 não entregam esse stream como fonte pública de espectro; não se propõe
abrir um segundo transporte ou relaxar o gate F0 para contornar essa limitação.

## Matriz de viabilidade

“Confirmado documentalmente” não significa “medido na banda”. Testes na última
coluna são requisitos de uma etapa futura, não instruções para executar agora.

| Questão / hipótese | Evidência | Conclusão e risco | Validação que falta |
| --- | --- | --- | --- |
| RTA visual em entradas e saídas | S2 §§5.2–5.3 | Confirmado documentalmente; não prova API | Conferir manual v3/firmware e sinal mostrado |
| Entrada simultânea em vários canais/clientes | S2 §5.2 | Seleção compartilhada; não oferecer varredura de canais | Observar concorrência autorizada sem ação remota do MixAI |
| Bins numéricos no protocolo | S6; ausência de fachada específica S5 | Indício comunitário, **não comprovado na Ui16** | Traço autorizado, formato, frequências, escala, modelo/firmware |
| API oficial estável de espectro | S1/S3 bloqueadas; S2 não a especifica | Não identificada; não declarar inexistente | Confirmação documental do fabricante |
| Receber dados com RTA desligado | S6 não mostra ativação no consumidor | Desconhecido; pode depender de outro cliente | Observar estados definidos por operador, sem transmissão de seleção |
| Sinal e tap de cada frame | S2/S6 não resolvem o metadado | Desconhecido; seleção de tela não prova identidade do frame | Correlação temporal e identidade inequívoca; rejeitar ambiguidade |
| Observação sem disputar a UI | S6 sugere consumo; L3 bloqueia saída não aprovada | Hipótese; não liberar `native_verified` | Demonstrar coexistência, perdas e seleção por outro cliente |
| Espectro obtido do fader/MUTE ou VU | L1/L2; S5 | Inviável: controle e nível agregado não contêm distribuição em frequência | Nenhum teste transforma esses dados em espectro real |
| PCM por saída de linha → interface externa | S2 §2.2; S8 | Alternativa plausível; impacto elétrico/driver ainda não validado | Ver plano físico abaixo; autorização e consentimento |
| PA L/R e AUX1 simultâneos | Topologia proposta: 2 + 1 entradas ADC independentes | Viável em princípio com ≥3 entradas de linha; interface de 2 entradas não cobre tudo | Identificar conexões e clocks; não somar L/R por cabo Y |
| Isolar CH1/CH3/CH8 no mix completo | Mistura de sinais, não stems | Não atribuir um bin de PA/AUX1 a um canal individual | Fonte isolada autorizada ou hardware de split; nunca SOLO automático |
| USB da Ui16 como multitrack para Yoga | S2 §§2.2/9.0 documenta arquivo estéreo do master | Não comprovado; **não usar como interface USB multicanal** | Exigir documentação específica antes de qualquer proposta |
| Linha equivale ao que o músico/público ouve | S7 e topologia da banda | Não: faltam HA800, amplificação, transdutores, posição e sala | Medição acústica/calibração em projeto separado |

## Alternativas de captura externa e limites

O projeto proposto é **saída de linha → entrada de linha ADC → USB da interface
externa → Yoga → DSP local**. Não é USB da Ui16 conectado ao computador.

| Fonte candidata | Informação obtida | Limites / dependências da proposta |
| --- | --- | --- |
| PA, cópia L/R em saídas disponíveis | Espectro elétrico do mix estéreo naquele ponto | S2 §2.2 descreve XLR/jack do master em paralelo; saída livre não é isolamento elétrico. Confirmar carga total e níveis; não remover cabo do PA em evento. Não mede caixas, DSP externo, sala ou SPL. |
| AUX1 antes do HA800, por distribuição isolada aprovada | Mix elétrico compartilhado, mono | A divisão é novo hardware a validar; nenhum Y presumido seguro. Todos os usuários do HA800 compartilham AUX1, que não é retorno exclusivo de um músico. Não mede diferenças de volume/entrada individual do HA800 nem fones. |
| Saída de fones | Sinal dependente da seleção e do controle PHONES | S2 §§2.2/10.0 documenta dependência de SOLO e configuração; não recomendar como fonte estável. TRS estéreo não é mono balanceado; risco de medir L−R por conexão errada. Não alterar seleção para analisar canal. |
| AUX livre dedicado | Uma mistura configurada pelo operador | Preparação altera estado e consome bus. Fora da alternativa passiva e desta autorização; não assume equivalência com PA/AUX1 ou tap por canal. |
| Split de entrada antes da Ui16 | Instrumento/voz individual anterior ao processamento da mesa | Exige splitter/DI apropriado, impedância, isolamento e phantom compatíveis; não representa pós-EQ ou contribuição individual no retorno. Não instalar nesta etapa. |
| Arquivo estéreo já autorizado | Análise offline reprodutível do arquivo | Não é leitura ao vivo, não é canal isolado; precisa data, rota, consentimento e contexto. Não acionar gravação da mesa para obtê-lo. |
| Microfone de medição independente | Sinal acústico na posição informada | Outro projeto: microfone/calibrador, ruído, posição, consentimento e comparação com referência. RTA de uma entrada não é automaticamente função de transferência. |

Requisitos mínimos propostos para o ADC: entradas realmente de **linha** e
headroom compatível com a saída escolhida, driver estável Windows/Yoga, taxa e
formato conhecidos, alimentação/isolamento adequados. PA estéreo + AUX1 exige
três conversores simultâneos; reservar capacidade sem inferir a partir do número
de conectores. Verificar ficha técnica do equipamento escolhido antes de definir
pad, níveis e cabos [S8]. Não enviar phantom à saída da mesa. Não ligar saída de
potência a ADC. Não criar retorno da interface para Ui16, PA ou HA800; desabilitar
monitoramento/loopback no plano autorizado de captura, sem automatizar mudanças.

Captura de mistura não separa fontes sobrepostas. Durante uma passagem futura,
pedir ao músico que toque sozinho pode dar contexto, mas o registro continua
sendo do **bus**, salvo isolamento comprovado. Nunca renomear o frame como CH3
apenas porque Fred foi convidado a cantar. Separação por IA não é evidência de
canal isolado e não faz parte da recomendação.

## Pipeline DSP proposto, inteiramente testável offline

Este é um projeto de implementação posterior, não um DSP entregue. A aquisição
física permanece fora do código. Proposta inicial de experimento:

1. Receber PCM autorizado ou gerador sintético, com origem imutável, taxa,
   formato, entradas e intervalo de aquisição. Não usar o adaptador de comandos.
2. Verificar finitude, formato, clipping digital possível no ADC, perda e
   continuidade. Marcar defeitos; não preencher dropout com “silêncio medido”.
3. FFT real unilateral com janela Hann periódica; documentar retirada de DC e
   normalização. Ponto inicial: 48 kHz, N=4096, hop=2048 (sobreposição 50%).
   `Δf = Fs/N ≈ 11,72 Hz`, janela ≈85,3 ms; zero-padding não melhora resolução
   física. Taxa de ADC e N são escolhas do experimento, não fatos do RTA nativo.
4. Declarar a convenção: potência por bin normalizada ao full-scale do PCM,
   referência de seno full-scale explicitada na versão do algoritmo; PSD usa
   outra unidade por Hz. Conservar energia ao agregar; não fazer média de dB
   como se fossem potências. S9 fornece referência para testar escalas/janelas.
5. Gerar bandas, picos e smoothing em potência linear, com duração registrada
   (piloto: 300 ms). Publicar no máximo 10 quadros/s, sem histórico ilimitado.
   Picos são candidatos espectrais; não diagnóstico automático de microfonia.
6. Clipping: apenas indício de saturação digital **no ponto PCM capturado**
   (contagem perto do full-scale, limiar documentado). Não diagnosticar clipping
   do pré da Ui16 a partir desse indicador, nem deduzi-lo de RTA/VU/fader.

Limites iniciais de projeto: no máximo três streams de linha, ring buffer PCM
de até 1 segundo por entrada, float32 (48 kHz × 3 × 4 ≈576 kB); teto de 8 MiB
para buffers/filas próprios, incluindo FFT e serialização. Até 4096 bins por
frame, frame serializado ≤256 KiB e fila de um frame por stream (descartar o
mais antigo, contar descartes). Bench no Yoga deverá manter DSP abaixo de 10%
de um núcleo e processamento p95 <50 ms por hop; são **metas não medidas**.
Se exceder limites, interromper/publicar `unavailable(resource_limit)`, sem filas,
retries infinitos ou redução silenciosa de qualidade. Bibliotecas/driver podem
consumir memória adicional; medir RSS do processo e reservar teto no ensaio.

## Proveniência, indisponibilidade e comparação

- **Medido:** aquisição real com trilha de validação, ponto capturado, referência
  de escala e tempos conhecidos. Medido não implica calibrado em dBu/SPL, bom
  timbre ou causa verificada. Escala nativa desconhecida fica `relative_unknown`.
- **Simulado:** gerador, fixture, medidor LAB ou arquivo gerado. Nunca promover a
  medido por modo/configuração, confiança do modelo ou nome do canal.
- **Unsupported:** não há adaptador validado para essa capacidade, modelo ou
  rota. Hoje, aquisição nativa para MixAI está nesse estado.
- **Unavailable:** fonte suportada sem sessão autorizada, amostra, permissão ou
  dispositivo. Não inventar zeros nem substituir por mock silenciosamente.
- **Stale:** havia dado, mas expirou ou perdeu continuidade/contexto. Manter
  apenas para histórico explicitamente marcado; excluir de diagnóstico atual.

A fonte e o consumidor verificam frescor por relógio monotônico local; relógio
UTC serve para auditoria, não para determinar idade sozinho. Timestamp de
recebimento **não é** timestamp de aquisição. Sem limite conhecido para idade de
aquisição, não declarar dado atual para decisão. Duplicatas/replays não renovam
TTL; reconexão, reinício, troca de seleção/rota ou revogação invalidam a geração.
Detalhes e invariantes do contrato: [SPECTRUM-SOURCE.md](SPECTRUM-SOURCE.md).

Comparação antes/depois exige fonte, rota/tap, ADC/ganho, taxa, janela, escala,
posição (se acústico), condições de execução e versões de contexto comparáveis.
Registrar se o músico ou operador relata melhora, separado dos números. Mudança
externa de fader observável invalida a comparação correspondente; ausência de
evento não prova que ganho/roteamento não mudou. Contexto incerto impede concluir
melhora causal. Nunca restaurar referência ou gerar alvo de EQ automaticamente.

## Integração futura e privacidade

O diagnóstico C poderá receber um resumo espectral **por adaptador tipado futuro**,
com IDs de evidência, fonte, medição/simulação, rota, limites e validade. O schema
atual L4 não admite espectro; não disfarçar bins como `control_state`,
`operator_report` ou `simulated_meter`. Contrato e consumidor precisam de entrega
separada. Relato humano e conclusão teórica continuam entidades distintas.

D mantém exclusivamente aprovação, revisão, simulação e referências do
AutoConfig; espectro não cria autorização. B só poderá apresentar informação
com origem e validade visíveis após uma integração própria. Nenhum frame vira
Intent, comando, proposta executável, correção de EQ, fader, ganho, phantom ou
AFS2 automaticamente. Não foi alterado código desses agentes nesta entrega.

Uma captura de linha pode conter fala privada, repertório e terceiros. Futuro
ensaio exige consentimento, operador identificado, finalidade e período limitados.
Proposta: PCM apenas em memória local, sem arquivo, upload, telemetria ou envio a
LLM; descarte ao encerrar/revogar. Não registrar Base64, áudio ou espectro detalhado
por padrão. Auditoria usa metadados mínimos e sanitizados; eventual retenção de
resumos exige finalidade/prazo próprios. Não alterar autenticação existente nem
autorizar músico a iniciar aquisição. Nenhum serviço de nuvem recebe áudio.

## Plano de testes offline para implementação posterior

Todos os casos abaixo usam sinais matemáticos ou fixtures sintéticas rotuladas;
**não foram implementados/executados como testes de DSP nesta entrega**.

| Caso piloto | Entrada offline / falha injetada | Resultado exigido |
| --- | --- | --- |
| CH8 surdo | Seno de baixa frequência alinhado a bin e fora do bin, harmônicos e transientes | Localização de frequência com tolerância à janela, energia conservada, sem recomendar boost |
| CH3 Fred | Sinal harmônico sintético e ruído filtrado, rotulado simulado | Bandas reprodutíveis; não afirmar voz real, inteligibilidade ou EQ ideal |
| CH1 cavaco | Harmônicos/transientes sintéticos | Verificar leakage, smoothing e pico, sem copiar preset |
| AUX1 compartilhado | Mistura sintética de três fontes | Permanecer evidência de bus compartilhado, sem atribuir um pico a músico |
| Silêncio, DC e full-scale | Zeros, constante, seno calibrado e onda limitada | Sem NaN/Infinity na serialização; silêncio distinto de amostra ausente; clipping só estimado no PCM |
| Proveniência | Mock rotulado como medido, tap desconhecido, rota divergente | Rejeitar promoção/atribuição indevida, sem fallback oculto |
| Frescor | Fake clock, duplicata, replay, atraso, reinício, troca externa e revogação | Geração invalidada; stale/unavailable; não renovar validade com pacote repetido |
| Concorrência e limites | Dois consumidores, cancelamento, produtor lento, excesso de bins/CPU | Leitura limitada, sem dupla aquisição, filas limitadas e descarte auditável |
| Fronteira de segurança | Dublê registra operações de saída | Zero comandos da mesa, zero seleção/ativação de RTA e zero acesso ao parser/AutoConfig |

## Requisitos para uma validação física futura

**Lista de requisitos para outro protocolo autorizado, não um roteiro de execução
nesta Issue.** F0C/L3 exige áudio desconectado e não deve ser reutilizado/relaxado
para introduzir sinal ou capturar áudio. Ensaio de áudio exige autorização própria.

1. Responsável aprova escopo, participantes/consentimento, janela fora de evento,
   técnico supervisor e critérios de parada. Preservar configuração; não atualizar
   firmware, rede ou snapshots para viabilizar pesquisa.
2. Registrar modelo/firmware, versão da UI oficial, manual correspondente e
   evidência do fabricante sobre tap/escala, quando existir. Pedir esclarecimento
   sobre transporte de bins e simultaneidade antes de assumir suporte nativo.
3. Definir passividade exigida. Para candidato nativo, somente observar tráfego
   autorizado já existente ou consumidor com saída estritamente guardada em etapa
   específica; MixAI jamais ativa/seleciona RTA. Operador mantém o controle oficial.
   Se faltarem frames ou identidade, encerrar como não comprovado. Não “tentar
   comandos” para descobrir protocolo. Não capturar telas/payloads com segredos.
4. Provar coexistência e identidade do sinal, inclusive quando operador muda
   seleção na UI oficial, desconecta/reconecta ou usa outro cliente. Exigir escala,
   mapa Hz, taxa, ordenação e limite de idade. Ausência de metadados inequívocos
   impede promoção a `native_verified`, mesmo que apareçam barras plausíveis.
5. Para captura externa, técnico aprova diagrama real, pontos livres, cargas,
   isolamento, balanceamento, pad/headroom e phantom desligado na entrada de linha.
   Não desconectar o caminho de PA/HA800 em operação. ADC não devolve áudio.
   Validar primeiro a interface com fonte de bancada autorizada, não a banda.
6. Conferir Windows/Yoga, driver, canais ADC realmente simultâneos, taxa/formato,
   identificação estável, latência/dropouts, cancelamento, liberação de dispositivo,
   ausência de monitoramento e de gravações/logs. Medir CPU/memória/p95; não assumir
   números deste documento como benchmark real.
7. Depois de gate próprio, comparar CH8, CH3 e CH1 em condições controladas e
   AUX1 compartilhado, rotulando corretamente bus versus fonte isolada. Não alterar
   ganhos, SOLO, EQ, faders ou AFS2 por software para produzir dados de teste.
8. Registrar resultado como medido, não comprovado ou indisponível por requisito;
   inspecionar possível impacto na UI, no áudio e no HA800. Qualquer mudança
   inesperada, interferência ou falta de consentimento interrompe o ensaio.
   Reversão física/configuração só pelo responsável, sem restauração automática.

## Verificações desta entrega e limites

Inspeção estática de documentação, tipos e código existente; leitura de fontes
públicas; contrato apenas proposto em Markdown. Não há nova configuração, pacote,
rota, aquisição, FFT, gravação, backend/UI ou integração habilitada. Nenhum comando
`serve:real`, observador físico, conexão à Ui16 ou captura de pessoas foi executado.

As regressões executadas e a CI constam no PR. Passarem não comprova acesso a RTA,
qualidade DSP, captura Windows, compatibilidade de firmware ou segurança elétrica.
Bloqueios documentais: S1/S3 (403), PDF DAW (404); v2.8 é espelho, não v3.0.
Bloqueio de validação física: hardware e autorização de ensaio estão fora desta
entrega. Não existe reconhecimento de capacidade espectral real aprovado.
