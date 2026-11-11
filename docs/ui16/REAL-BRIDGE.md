# Ui16 — ponte de estado e ensaio controlado de AUX

## Escopo e integração

Base: main `0919a53`. O caminho `createApp` seleciona `Ui16RealBridge` para Ui16 REAL;
LAB/MOCK continuam nos adaptadores existentes, sem importação de rede. A ponte deriva
de `RealMixer` e reutiliza `ConnectionSupervisor`, sem alterar núcleo D, autorização,
roteador, catálogo de IA, contratos HTTP/WS ou telas Angular.

**Escrita física bloqueada. E6 não habilitada.** Mesmo `createApp(..., {readOnly:false})`
não libera escrita. Os demais modelos construídos pela fábrica também ficam somente
leitura. A classe legada `RealMixer` continua disponível para seus testes de protocolo;
não é uma API de autorização física. O observador F0 existente conserva seus gates de
rota, Wi-Fi e sessão e seu relatório limitado a fader/mute. Não se promove EQ/HPF no
registro de capacidades de escrita (`simulated_only` permanece).

`Ui16RealBridge.reading(key)` fornece a qualidade no backend; o contrato legado
`read(key)` só retorna `known:true` para leituras confirmadas. Nenhuma tela nova é
implementada nesta entrega. Consumidores futuros devem usar o estado completo, sem
transformar `lastObserved` em valor atual.

## Protocolo encontrado, sem endpoint novo

Fonte reproduzível: `soundcraft-ui-connection@7.1.0`, fixada em package-lock.json;
`node_modules/soundcraft-ui-connection/index.mjs` e `index.d.ts`; mapeamento local em
`src/mixer/protocol-map.ts`. O transporte da biblioteca abre **`ws://${targetIP}`**.
Não foi implementado outro endpoint, negociação Socket.IO, comando GET ou polling
inventado. A biblioteca envia strings prefixadas `3:::`; o receptor separa por `\n`.
Em entrada, `SETD^caminho^número` atualiza estado numérico e `SETS` estado textual.

A porta de transporte da ponte admite apenas as consultas já usadas pela biblioteca:
`3:::ALIVE`, `3:::SHOWLIST`, `3:::MEDIA_GET_PLISTS`, e consultas qualificadas
`SNAPSHOTLIST`, `CUELIST`, `MEDIA_GET_PLIST_TRACKS`. Não autoriza carregar/salvar cenas.
Qualquer outra saída sela a sessão **antes de enviar**. Dados selecionados inválidos
(inclusive NaN, normalizado fora de 0..1 ou mute diferente de 0/1) selam a sessão antes
que os conversores da biblioteca possam mascarar a anomalia.

Índices de protocolo são base zero; canais/AUX do MixAI são base um:

| Parâmetro | Campo SETD da biblioteca | Conversão / leitura | Evidência física disponível |
|---|---|---|---|
| Fader de entrada CHn | `i.(n-1).mix` | DBToFaderValue / faderValueToDB, não linear | F0 #43, leitura limitada |
| Mute CHn | `i.(n-1).mute` | 0/1 → boolean | F0 #43, leitura limitada |
| Envio CHn para AUXa | `i.(n-1).aux.(a-1).value` | mesma conversão de fader | F0: CH2/AUX1 somente |
| Mute desse envio | `i.(n-1).aux.(a-1).mute` | 0/1 | biblioteca + fixtures; pendente físico |
| EQ bandas 1..4 | `i.(n-1).eq.bB.freq`, `.q`, `.gain` | frequency, Q, eqGainDB converters da biblioteca | pendente físico |
| EQ bypass | `i.(n-1).eq.bypass` | 0/1 | pendente físico |
| HPF frequência | `i.(n-1).eq.hpf.freq` | frequency converter da biblioteca | pendente físico |
| HPF slope / LPF | APIs somente Ui24R | **indisponível Ui16**, não assumir padrão | não suportado nesta ponte |
| Master | `m.mix` | somente observação | escrita bloqueada |

Os setters de fader, mute e AUX produzem `3:::SETD^campo^valor` nos testes legados
com transporte falso. Isso comprova o **comportamento da biblioteca**, não aceitação
pelo firmware. Setters de EQ podem ainda afetar canais stereo-linked na biblioteca;
nenhum é invocado aqui. Manual de usuário descreve operação, não é prova de protocolo.

A biblioteca expõe `deviceInfo.model$`/`firmware$`, selecionando `model`/`firmware`.
A ponte reconhece somente `SETS^model^ui16` como modelo relatado; modelo ausente é
`unknown`, Ui12/Ui24 ou valor inválido sela a sessão. Isso é identificação **relatada,
não autenticada**, nunca prova de hardware ou autorização. Firmware e formas alternativas
de anúncio ainda dependem de captura física; não inferimos modelo pelas capacidades
estáticas da configuração. Nenhuma captura bruta, IP privado, SSID ou credencial é gravada.

## Sincronização e validade

- Supervisor existente: conexão, sincronização parcial, timeout, backoff limitado,
  nova instância/geração por reconexão e descarte de instâncias aposentadas. Alterações
  externas válidas entram pelo mesmo stream e incrementam revisões existentes.
- `confirmed`: campo recebido nesta geração, decodificado e válido. Significa parâmetro
  observado, **não áudio ouvido, VU, espectro ou medição acústica**. `hardwareValidation:
  pending` lembra que a cobertura foi exercitada com fixtures.
- `pending`: conexão/sincronização ativa, campo ainda não observado; EQ opcional não
  impede READY dos faders obrigatórios. Não é confirmação de escrita.
- `stale`: queda ou silêncio; valor anterior só existe em `lastObserved` com timestamp
  monotônico e geração. O getter legado não o oferece como atual.
- `unavailable`: sem amostra anterior, campo não suportado ou sessão selada.
- Silêncio de entrada (30 s por padrão) põe o link em DEGRADED_READ_ONLY. Heartbeat
  isolado não revalida parâmetros. Requer novos frames dos campos obrigatórios para
  recuperar READY; cada campo opcional precisa de sua própria amostra fresca. O protocolo
  não contém sequência/timestamp por parâmetro: não é possível ordenar dois valores
  atrasados da **mesma** conexão. A última amostra válida recebida vence; duplicatas não
  geram comandos nem mudanças redundantes. Frames de sockets fechados/gerações antigas
  são descartados antes da decodificação.
- `resynchronize()` reconecta explicitamente para obter um novo estado; não inventa
  pedido de leitura. Não se pressupõe que parâmetros inalterados emitam periodicamente.
  Uma conexão silenciosa exige ressincronização/inspeção, não prova que o dispositivo caiu.
- `identity()` e `statusText()` não afirmam identificação autenticada nem conexão física
  validada; READY continua exclusivamente leitura. Timers param no encerramento/falha.

## Por que não confirmar uma escrita REAL agora

A biblioteca incorpora também **SETD de saída** ao store local. Portanto `write()` seguido
de `read()` do mesmo cache não prova resposta da mesa. Não foi localizada evidência física
suficiente de leitura independente após escrita, IDs de correlação ou comando de consulta
individual. A ponte bloqueia `write`, `loadSnapshot` e saída não permitida mesmo que outro
chamador tente contornar o método. Nenhuma escrita é repetida em reconexão.

Para liberar uma futura operação será necessário validar AUX com operador, correlacionar
**entrada independente** com a tentativa, estabelecer tolerância/timeout e tratar alterações
externas intercaladas. Valor igual ao alvo mostra convergência observável, não autoria.
Ausência/divergência deve ser incerta, sem repetir automaticamente. Não basta remover um flag.

## Ensaio disponível, não integrado à produção

`createAuxWriteRehearsal` aceita somente instância LAB/MOCK de `SimulatedMixer`, sem
transporte. O consumidor interno fornece seu `mixer` ao controlador existente para
preservar fila, limites, revisões e undo. Não foi criada rota nem tela de autorização.

`prepare` exige papel operador, consentimento humano explícito, requestId não reutilizado,
um único canal/AUX, origem e alvo finitos com variação máxima de **1 dB**, e callback de
autorização **do servidor**. Expira em 15 s. O callback deve conferir sessão autenticada
ativa/permissão; boolean do cliente ou texto de IA não substitui essa decisão. A futura
integração deve entrar pelo núcleo/políticas existentes e suas expectativas de revisão,
jamais chamar este ensaio a partir de texto do assistente. AUX1 é compartilhado pelo HA800.

A permissão é consumida antes da tentativa; o envio relê a origem e depois relê o resultado
autoritativo **da simulação**. Mudança externa, perda de conexão ou revogação durante a
operação não retornam sucesso. Timeout de 1 s ou erro sela o ensaio como incerto; uma conclusão tardia ainda pode
alterar o estado simulado e exige inspeção. Não há retry, replay ou rollback automático. Master, EQ,
mute, outro envio e snapshot são recusados. Undo usa o controlador existente, com nova
permissão humana reversa, e conserva proteção contra revisão externa. Após 1.000 IDs o
ensaio recusa novas permissões: criar uma nova instância exige decisão do integrador;
não é cache distribuído nem substituto da idempotência do servidor.

## Validação

Fixtures de protocolo em `test/ui16-real-bridge.test.ts` e
`test/support/fake-ui-socket.ts` são **sintéticas**, construídas das APIs da versão fixada.
`test/aux-write-rehearsal.test.ts` exercita autorização, revogação, concorrência, leitura
posterior, incerteza e undo com MockMixer. Regressões F0 e adaptador legado preservadas.
Nenhum teste automatizado abre socket para a Ui16, nem houve chamada física nesta entrega.

Referências: [F0 #43](https://github.com/dodoxbr/MixAI/issues/43),
[gate E6 #44](https://github.com/dodoxbr/MixAI/issues/44),
[manual oficial Ui v3](https://www.soundcraft.com/en-US/product_documents/ui_usermanual_v3-0-pdf-27c992b4-5132-4d2d-b8e2-79750de6ee29),
[checklist físico](PHYSICAL-CHECKLIST.md).
