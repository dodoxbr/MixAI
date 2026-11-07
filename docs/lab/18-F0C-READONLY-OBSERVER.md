# F0C — observador Ui16 somente leitura e evidências sanitizadas

Issue [#34](https://github.com/dodoxbr/MixAI/issues/34). Branch exclusiva
`feature/f0c-readonly-observer`, criada de `origin/main` em `0fa3845` após leitura de
`AGENTS.md`. PRs #31 (`0fa3845`) e #32 (`3e59796`) confirmados mesclados e ancestrais.
**F0 físico continua pendente. Esta implementação não inicia E6 nem autoriza escrita REAL.**

Atualização F0D: [Ethernet e Wi-Fi](19-F0D-DUAL-TRANSPORT-READONLY.md) são caminhos
permanentes e explícitos no mesmo observador. As instruções Ethernet antigas abaixo
continuam retrocompatíveis; para Wi-Fi usar confirmações próprias e preflight do F0D.
Novos relatórios são v2; o leitor preserva v1, sem inventar transporte retroativo.

## Arquitetura e limites

`Ui16ReadOnlyObserver` é uma sessão de observação, não um segundo `RealMixer`, controlador
ou servidor. Instancia o `RealMixer` existente com **readOnly:true fixo**, usa seu
`ConnectionSupervisor`, gate de gerações, assinaturas e ressincronização. Não expõe
write/loadSnapshot nem constrói `MixController`. O CLI compartilha a trava de dono REAL
existente com servidor/console F0 e não lê `config.local.yaml`, PIN, tokens ou segredos.

Defesas adicionais, restritas ao observador:

- Gate de transporte por lista positiva, compatível com a biblioteca fixada **7.1.0**:
  ALIVE, SHOWLIST, MEDIA_GET_PLISTS e consultas SNAPSHOTLIST/CUELIST/MEDIA_GET_PLIST_TRACKS
  com argumento limitado, sem caret/caracteres de controle/quebra de linha. Não há regra
  genérica “GET é seguro”. SETD/SETS/LOAD/SAVE, reprodução, binários e frames desconhecidos
  de saída são recusados antes de `send`; o primeiro bloqueio sela toda a sessão.
- Reconexões mantêm os gates do supervisor e criam instâncias novas. O transporte também
  fecha sockets pendentes em CONNECTING na perda e ao encerrar; não depende de que eles
  cheguem a abrir para serem limpos. Não existe fila/replay de comandos do observador.
- Validação de envelopes SETD dos caminhos numéricos **selecionados** antes da biblioteca:
  fader bruto finito 0–1, MUTE 0/1. Envelope/valor inválido vira evidência `unknown`
  (`invalid_value`) e interrompe a sessão. A biblioteca 7.1.0 pode normalizar NaN para
  0 dB; o observador impede essa falsa leitura. Continua sendo a biblioteca que converte
  fader para dB; o gate não implementa DSP nem outro protocolo de controle.
- Nenhuma proteção ou permissão de escrita existente é relaxada. Nos entrypoints antigos,
  o transporte não muda. A única alteração em `real.ts` é o comentário que documenta o
  construtor injetado, agora também usado pelo gate F0C.

## Escopo das observações

O operador escolhe canais 1–12. Por padrão observa level/MUTE do PA desses canais, sem
ler YAML de nomes. `--master` inclui master.level; `--aux 1` inclui level/MUTE do **bus**
AUX indicado para os mesmos canais. AUX não é habilitado automaticamente; 1–6 são limites
**do perfil/biblioteca**, não descoberta de seis saídas físicas. Confirmar separadamente
bus, saída, ligação e pre/post na UI/painel, sem alterar roteamento neste ensaio.

- `link`: CONNECTING, SYNCING, READY, DEGRADED_READ_ONLY, LOST e STOPPED recebidos do supervisor.
- `parameter`: valor válido recebido, com origem `resync` ou `external`. Níveis em dB;
  `'-inf'` representa −∞ conhecido. MUTE é boolean; desconhecido nunca é zero/false/−∞.
- `snapshot`: **fotografia local do espelho selecionado**, capturada ao atingir READY/
  DEGRADED e na invalidação por perda/parada; não é show/snapshot nativo da Soundcraft,
  recall nem prova de que todos os canais da mesa chegaram. `complete` só cobre o escopo.
- `unknown`: amostra não recebida/inválida. `unavailable`: ligação perdida/parada.
  Valores de geração anterior são invalidados, não usados como leitura atual.
- EQ/HPF simulados, pré/phantom e roteamento físico são explicitamente excluídos no
  relatório, sem inventar observações ou promover parâmetros a hardware_verified.
- `external` significa “recebido enquanto READY”, não identifica o ator. O protocolo não
  oferece sequência/timestamp de origem para reconstruir ordem causal dentro da mesma
  geração. Registra-se **ordem de chegada**; uma mensagem contraditória tardia da geração
  atual pode parecer nova mudança. Eventos de gerações descartadas são ignorados.
- A biblioteca/supervisor já suprimem várias duplicatas (e usam tolerância de 0,05 dB;
  conversão da biblioteca arredonda níveis a 0,1 dB). Contadores medem notificações/eventos
  registrados; não são contagem de todos os frames da rede. `duplicatesSuppressed` cobre
  apenas duplicatas que de fato chegam à camada observadora, podendo ser zero.

## Execução Windows/Yoga: somente depois da chegada da mesa

Não executar este comando em CI, scripts de inicialização ou `smoke:yoga`. Sem hardware,
usar apenas os testes com WebSocket falso. Para ver ajuda sem conectar:

```text
npm run build
npm run observe:f0 -- --help
```

### Portões manuais

1. Seguir primeiro [F0 rede/driver/IP](13-F0-PREFLIGHT-READONLY.md) e, antes da chegada,
   [smoke/preflight F0B](17-F0B-YOGA-REHEARSAL.md). Não alterar automaticamente rede, driver,
   firewall, IP, DNS ou certificados. Se houver bloqueio de permissão, registrar e parar.
2. Mesa fora de evento, **PA, HA800/amplificador de fones e todos os fones desconectados**.
   Ter operador supervisionando e acesso à interface oficial. Não testar com áudio ligado.
3. Confirmar cabo LAN da Ui16 ↔ adaptador USB-C/RJ45 ↔ Lenovo Yoga. Identificar interface,
   IP/máscara Ethernet real e rota. **Não presumir 10.10.1.1 do hotspot como IP Ethernet.**
   Wi-Fi do Yoga permanece separado para internet/celulares, sem ponte/ICS.
4. Abrir a UI oficial pelo IP Ethernet e confirmar unidade/modelo, firmware e canal de teste.
   Não fazer reset/update, alterar rede, ganho, phantom, EQ ou snapshots.
5. Encerrar outros processos MixAI REAL legitimamente. O observador recusa a trava ocupada;
   não apagá-la à força. Não rodar `serve:real` ou console REAL comum para contornar falha.
6. O CLI exige terminal interativo e flags declarativas. Elas **não verificam fisicamente**
   as saídas, IP ou supervisão: a confirmação é responsabilidade do operador.

Exemplo PowerShell, **substituir ambos os IPs pelo Ethernet confirmado**:

```powershell
# EXEMPLO ILUSTRATIVO: não copiar o endereço sem confirmar a unidade e a rota.
npm run observe:f0 -- --physical-readonly --audio-disconnected --ip 192.168.50.10 --confirm-ethernet-ip 192.168.50.10 --channels 1 --duration 60
```

Para registro local opt-in, criar previamente uma pasta local e usar um prefixo novo:

```powershell
npm run observe:f0 -- --physical-readonly --audio-disconnected --ip 192.168.50.10 --confirm-ethernet-ip 192.168.50.10 --channels 1 --duration 60 --report work/f0c-ensaio-01
```

Não redirecionar a saída por pipe para contornar o requisito de terminal; usar `--report`.
Não passar IP por ambiente: MIXAI_IP/MIXAI_MODE são ignorados, não existe alvo padrão.
Aceita IPv4 privado/link-local, não aceita hostname, URL/porta, loopback ou IP público.
`--aux 1`/`--master` são opt-in; não acrescentar AUX sem confirmar seu escopo no hardware.

### Ensaio mínimo supervisionado

1. Aguardar fotografia READY (completa **do escopo**) ou DEGRADED (incompleta); comparar
   os valores recebidos com a UI oficial. Se incompleto/incoerente, registrar e não concluir
   compatibilidade. Captura sem dados prontos falha após timeout, sem retries indefinidos.
2. **Somente na UI oficial**, o operador altera pouco o fader de um canal de teste escolhido,
   anota valor anterior/novo e observa o evento `external` correspondente. Depois alterna
   MUTE desse canal na UI oficial e compara o boolean. O MixAI não envia o ajuste.
3. Se decidido pelo operador, restaurar os controles **manualmente na UI oficial** às
   posições anotadas, ainda sem áudio conectado. Não usar `desfazer`/recall pelo MixAI.
4. Retirar só o cabo Ethernet, observar LOST/invalidação, manter Wi-Fi e religar após cerca
   de 5 s. Observar nova geração, SYNCING e nova fotografia. Não produzir comandos pendentes.
5. Ctrl+C encerra, desconecta, cancela retries e exporta se autorizado por `--report`.
   O CLI não aceita comandos de fader/MUTE/snapshot nem lê entrada de ajuste.

Neste escopo F0C, a mudança de teste na UI oficial é autorizada manualmente pelo operador;
os comandos do MixAI continuam exclusivamente em leitura. Isso amplia a observação do
roteiro F0, sem permitir que o software execute alterações nem iniciar E6.

## Parada, limites e códigos

- Duração padrão 60 s; `--duration` 1–900 s. `--max-events` 8–2000, padrão 500; reserva o
  evento final. Há orçamento adicional de **256 KiB de JSON compacto** (exportação
  formatada pode ser maior). Ao atingir qualquer limite de evidência, encerra: não cresce
  indefinidamente nem continua silenciosamente após truncar dados.
- Perda sem recuperação legível por 30 s interrompe; tentativas fracassadas não reiniciam
  essa janela. Conexão inicial tem timeout de 8 s; sincronização, 5 s. DEGRADED não vira
  READY sem os valores obrigatórios. Duração também limita qualquer fase do ensaio.
- STOPPED, saída desconhecida bloqueada, amostra selecionada inválida ou falha do destino
  de saída interrompem a sessão. Selo de transporte não pode ser reaberto por reconexão.
- Código 0: término normal por duração/operador com conexão inicial legível. Código 1:
  argumentos/terminal/trava/reserva inválidos, conexão sem dados prontos, timeout de
  recuperação, limite de evidência ou parada de segurança. Nenhuma mensagem bruta da
  biblioteca/erro de arquivo/titular da trava é impressa; a etapa é indicada por código fixo.
- Parar manualmente por áudio conectado, unidade incerta, IP/rota errados, leitura
  incoerente, alterações inesperadas ou perda persistente. Encerrar observador; usar UI
  oficial para inspeção. Não recarregar cena/snapshot nem repetir comandos incertos.
- SIGKILL, falta de energia ou fechamento abrupto do terminal não permitem garantir
  exportação completa/cleanup. Arquivos reservados podem estar vazios/incompletos;
  rejeitar pelo esquema. Nunca apresentá-los como captura física concluída.

## Evidências locais e sanitização

Sem `--report`, só memória/tela, nenhum arquivo de observação. Com a opção, reserva
`.json` e `.md` com criação **exclusiva antes de conectar**; colisão/erro de reserva não
abre socket nem sobrescreve arquivos. Arquivo parcialmente reservado é removido na falha.
No fim, grava apenas relatório validado. Permissão solicitada 0600 onde suportada; no
Windows, conferir a privacidade/ACL da pasta manualmente, sem mudança automática.

`ObserverReportSchema` e `parseObserverReport` validam o JSON: versão, fonte, escopo,
chaves/valores, sequência/tempos relativos não decrescentes, contadores, limite, snapshots
e evento final. Esquema estrito rejeita campos extras, falsa completude ou contagem
adulterada. Isso detecta inconsistências estruturais, **não é assinatura criptográfica**
nem prova independente da veracidade da origem. O Markdown é renderizado desse objeto.

Campos preservados: versões MixAI/biblioteca, fonte `fake_websocket`/`manual_device_stream`,
modelo **configurado**, escopo, índices locais, gerações, timestamps relativos, eventos,
valores/estados e motivo de término. Canais/labels são lógicos (`CH 1`, `PA`, `MASTER`,
`AUX n`), não nomes recebidos da mesa. O campo `hardwareValidation` permanece `pending`:
capturar um stream não verifica firmware, unidade, saída AUX nem execução segura do ensaio.

Não registra IP/URL, nomes de rede/mesa, hostname, identificadores de usuário/unidade/sessão,
PIN/token, mensagens de erro brutas, shows/playlists, payload bruto ou áudio. A biblioteca
mantém o estado recebido temporariamente em memória; não há dump desse store em arquivo.
Revisar os relatórios antes de anexar. Índice/generation são contadores locais, não IDs da rede.
O formulário F0 de rede pode conter IPs privados: não anexar sua cópia bruta ao GitHub.

Verificar um arquivo exportado, sem conectar, sem ecoar conteúdo inválido:

```text
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {parseObserverReport} from './dist/mixer/observer-report.js'; try {const r=parseObserverReport(JSON.parse(readFileSync(process.argv[1],'utf8'))); console.log('Esquema válido; encerrado:',r.ended,'eventos:',r.events.length);} catch {console.error('Relatório inválido');process.exitCode=1;}" work/f0c-ensaio-01.json
```

Anexar manualmente ao [formulário F0](14-F0-EVIDENCIAS-MODELO.md), com revisão sanitizada:

| Observação manual | Registro do operador |
| --- | --- |
| PA/HA800/fones desconectados, operador presente | PENDENTE |
| UI oficial/modelo/firmware/canal confirmados | PENDENTE |
| Fader alterado na UI: anterior → novo / evento relativo | PENDENTE |
| MUTE UI: anterior → novo / evento relativo | PENDENTE |
| Cabo retirado/religado / gerações / tempo de recuperação | PENDENTE |
| Estado final e restauração manual na UI | PENDENTE |
| Esquema JSON válido, motivo de término e contadores revisados | PENDENTE |
| Divergências, critério de parada e limitações | PENDENTE |

## Testes sem hardware e integração futura

```text
npm run typecheck
npm run build
npx vitest run test/f0c-observer.test.ts test/f0c-cli.test.ts test/f0-readonly.test.ts test/supervisor.test.ts
npm test
npm run test:web
npm run build:web
npm run test:e2e
npm run smoke:yoga
```

F0C usa WebSocket falso e relógio/temporizadores controlados. Cobre parâmetros fora de
ordem, duplicatas filtradas, snapshots parciais, −∞/MUTE, desconhecidos, dados inválidos,
três quedas/recuperações, dados atrasados de gerações descartadas, tentativas tardias além
da vigia/retry, captura limitada, recepção com accessors de WebSocket e limpeza de sockets
em abertura. Todas as gerações têm zero SETD/SETS/LOAD/SAVE; toda saída aceita é consulta
conhecida/ALIVE. O cenário observacional prova zero chamadas write/loadSnapshot e aos
portões de ação do supervisor; teste separado tenta essas APIs deliberadamente **no falso**
e verifica recusa antes/durante/depois de reconexão. Frames desconhecidos também são negados.

Testes CLI substituem terminal/socket/lock-dir por fixtures, inclusive no caminho de gates
manuais. Não executam o comando físico com um alvo real. Verificam opt-out de gravação,
reserva exclusiva, trava já ocupada, ausência de IP/segredos e recusa não interativa. Os
jobs Windows/Linux executam esses testes pelo `npm test`; `observe:f0` não entra na CI,
no smoke ou em scripts de servidor. HTTPS/Caddy não foi afetado.

Continuam pendentes: Ui16 física, firmware real, driver/USB/RJ45 do Yoga, topologia, faders/
MUTE da UI oficial, desconexão/reconexão reais, áudio e saídas/buses AUX físicos. O monitor
não implementa medidores, quarentena/espelho de produção E6, EQ/HPF REAL, aplicação E8,
IA, reconhecimento de voz ou atualização de firmware/biblioteca. Qualquer integração
futura deve permanecer fora de caminhos de escrita e depender de validação/escopo próprios.

## Validação desta entrega

Linux, Node v24.22.1, base `0fa3845`; testes automatizados exclusivamente com sockets
falsos no F0C. Nenhum ensaio físico foi executado.

| Verificação local | Resultado |
| --- | --- |
| `npm run typecheck` e `npm run build` | passaram |
| Testes focados F0C (observador + CLI) | 49 passaram, dois arquivos |
| `npm test` | 574 passaram, 49 arquivos |
| `npm run test:web` / `npm run build:web` | 84 passaram; build passou |
| `npm run test:e2e` | 68 passaram, 11 arquivos |
| `npm run smoke:yoga` | passou, dois cenários reutilizados |
| `git diff --check` | passou |

O refinamento final congela a duração após término e recusa snapshots que aleguem valores
observados em link indisponível; os testes focados foram repetidos e a regressão do núcleo
foi reexecutada. CI Windows/Ubuntu/Caddy/smoke será registrada na descrição do PR.
Caddy/TLS não foi afetado nem executado localmente nesta rodada; o job existente da CI
permanece. As capturas E7A regeneradas pelo E2E foram preservadas em `work/` e restauradas
na árvore versionada, sem mudança de testes existentes.

Os primeiros ensaios identificaram a normalização de NaN da biblioteca e a necessidade de
fechar sockets ainda em abertura; ambos foram tratados no gate, sem alterar o supervisor.
O teste de duplicatas considera o filtro já existente da biblioteca, comprovando um único
evento sem inventar contagem de frames recebidos. Não há falha local remanescente nos
checks já concluídos. Firmware, hardware, topologia, UI oficial e áudio continuam pendentes.
