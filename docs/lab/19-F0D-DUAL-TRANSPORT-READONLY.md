# F0D — Ethernet e Wi-Fi permanentes no observador somente leitura

Issue [#39](https://github.com/dodoxbr/MixAI/issues/39). Base `origin/main` em `6734195`,
com #36 (`8fe1c84`), #37 (`6734195`) e #38 (`fb6f986`) incorporados. `AGENTS.md` lido;
branch exclusiva `feature/f0d-dual-transport-readonly`. O equipamento foi recebido,
mas **esta entrega não executa nem certifica ensaio físico**. E6/escrita REAL seguem fora.

## Um só mecanismo, duas escolhas legítimas

`RealMixer` já usa um IP e não depende de Ethernet. Ele, `ConnectionSupervisor` e o
mapeamento de parâmetros permanecem inalterados. O mesmo `Ui16ReadOnlyObserver`, lock,
gates somente leitura, limites, invalidação/gerações e esquema de amostras atendem ambos.
Não há segundo driver/adaptador, escolha por alcance do IP nem troca automática de alvo.

- `--transport ethernet`: IP confirmado como Ethernet e índice da interface Ethernet.
- `--transport wifi`: confirmação própria de IP, do hotspot privado **Soundcraft Ui** e
  índice da interface Wi-Fi. Não aceita `--confirm-ethernet-ip`, nem o transforma em prova Wi-Fi.
- Forma F0C antiga, sem `--transport`, continua válida **somente** com a declaração explícita
  `--confirm-ethernet-ip`. Ela conserva o gate manual antigo, sem consulta automática de rota;
  o relatório identifica `legacy_ethernet_declaration`. Não usar esse atalho para Wi-Fi.
- Nas formas novas, a rota é consultada no Windows **antes de cada socket**, inclusive
  reconexões. Falha, timeout, interface inesperada ou ambiguidade selam/encerram a sessão;
  não tenta outra interface/IP nem promove uma confirmação antiga a outro transporte.

O transporte é uma escolha declarada, não inferência do endereço: `10.10.1.1` pode ser
hipótese de fábrica do AP, nunca confirmação de Wi-Fi/Ethernet ou da unidade conectada.
A UI oficial e o roteamento real precisam ser conferidos pelo operador.

## Preflight Windows somente consulta

Atualização [F0E — Issue #41](20-F0E-NATIVE-ROUTE-PREFLIGHT.md): o preflight agora é
um comando Node com consultas nativas fixas; não executa arquivos `.ps1`. Não alterar
a ExecutionPolicy para executar os exemplos antigos. Compilar antes com `npm run build`.

PowerShell normal, sem administrador, na raiz do projeto. Substituir o exemplo de IP e
**ifIndex** pelos observados localmente; não copiar a configuração como fato:

```powershell
# Somente campos necessários; não coletar/publicar MAC, SSID completo ou senha.
Get-NetAdapter | Select-Object ifIndex,Status,NdisPhysicalMedium,HardwareInterface
# Descobrir a rota em consulta local, sem probe/TCP/HTTP:
Find-NetRoute -RemoteIPAddress '10.10.1.1'
# Preflight sanitizado, exemplo Wi-Fi (o ifIndex 7 é só ilustrativo):
npm run preflight:f0 -- --ip 10.10.1.1 --transport wifi --interface-index 7
```

`Find-NetRoute` pode mostrar endereços locais; é consulta **para inspeção local**, não
anexar sua saída bruta ao relatório. O helper imprime somente transporte, índices,
`passed` e motivo enumerado, sem IPs, nomes, SSID, MAC ou credenciais. Não faz DNS, ping,
HTTP/TCP, consulta à mesa/internet, instalação, bridge/ICS ou mudanças de rede.
O IP de destino fica apenas nos argumentos/memória da consulta local. Não gravar terminal
bruto ou linha de comando como evidência; usar o JSON/Markdown do observador.

O helper cruza `Find-NetRoute`, adaptadores, IPv4/prefixos, rotas ativas e métricas de
interface. Wi-Fi é identificado pelo meio NDIS wireless; Ethernet por meio 802.3 físico.
RNDIS/Apple Mobile Device Ethernet e descrições de tether conhecidas são classificados
separadamente. Adaptador desconhecido/virtual não vira Ethernet por suposição. Conferir
por ifIndex no Windows/gerenciador de dispositivos: não precisa registrar seu nome.

| Motivo | Conduta |
| --- | --- |
| `ok` | destino on-link e rota/interface coerentes no instante da consulta |
| `route_via_usb_tether` / `unexpected_interface` | parar: destino não usa o adaptador esperado |
| `transport_mismatch` / `interface_down` | parar: meio incorreto ou interface indisponível |
| `overlapping_subnets` | parar: destino pertence a sub-redes de interfaces ativas diferentes |
| `ambiguous_routes` | parar: rotas de maior prefixo têm custo equivalente em interfaces distintas |
| `target_not_on_link` | destino não pertence à sub-rede local esperada; revisar topologia |
| `snapshot_incomplete` / `query_unavailable` | parar: dados incoerentes/indisponíveis; não escolher rota por tentativa |

Para este primeiro F0, os caminhos novos exigem destino **on-link** (cabo direto/LAN ou AP
da Ui16). Não habilitam roteamento arbitrário através de gateways. O adaptador continua
independente do meio: outras topologias exigem planejamento/validação manual próprios.

O Node usa `powershell.exe -NoLogo -NoProfile -NonInteractive -Command` com uma consulta
local fixa e limitada a cmdlets nativos de leitura/projeção. IP chega por variável de
ambiente do filho, nunca por concatenação de código. A decisão completa é feita em
TypeScript; não há mais arquivo PowerShell de rota nem algoritmo duplicado. Restricted
pode permitir essas consultas e recusar `.ps1`; se política/GPO/AppLocker também impedir
cmdlets, registrar e parar. Sem bypass, elevação ou opção de ignorar o guard.
Não afrouxar políticas, firewall, DNS, certificados, perfis ou métricas para contornar erro.
O preflight genérico F0B é distinto, continua `.ps1` e pode conter IPv4 privados;
não anexá-lo sem revisão e não alterar políticas para executá-lo.

## Caminho A: Ethernet (preferido para instalação fixa)

1. PA, HA800/amplificador e fones desconectados; operador presente, fora de evento.
2. Yoga ↔ adaptador USB-C/RJ45 ↔ LAN da Ui16. Conferir driver/cabo sem instalar/alterar
   automaticamente. Confirmar IP/máscara **Ethernet real** da mesa pela UI/documentação
   da unidade; não assumir IP do hotspot. Não fazer reset nem atualização de firmware.
3. Wi-Fi do Yoga pode atender internet/celulares em rede separada, sem sobreposição/bridge.
4. Abrir a UI oficial da unidade e verificar canal de teste. Conferir ifIndex Ethernet e
   executar o preflight correspondente, por exemplo:

```powershell
npm run preflight:f0 -- --ip 192.168.50.10 --transport ethernet --interface-index 8
npm run observe:f0 -- --physical-readonly --audio-disconnected --transport ethernet --ip 192.168.50.10 --confirm-ethernet-ip 192.168.50.10 --interface-index 8 --channels 1 --duration 60 --report work/f0d-ethernet-01
```

IPs/índices são exemplos. A pasta deve existir e o prefixo de relatório ser novo.
O comando Ethernet antigo de F0C segue aceito; as novas formas são preferidas para
verificação de rota por conexão. O antigo não ganha prova automática de roteamento.

## Caminho B: Wi-Fi da Soundcraft Ui16 (sem adaptador RJ45)

1. Mesmos portões físicos: PA/HA800/fones desconectados, operador supervisionando.
2. Associar manualmente o Wi-Fi do Yoga ao **hotspot privado Soundcraft Ui da unidade**.
   Conferir isso visualmente no Windows e na UI oficial, sem copiar senha/SSID completo,
   MAC ou identificadores para evidências. Não usar o Wi-Fi público do evento como atalho.
3. Confirmar IP alcançado e rota. `10.10.1.1` é somente hipótese inicial, não valor padrão
   assumido pelo CLI. O destino tem de ser acessível pela interface Wi-Fi correta.
4. Internet é opcional. Um celular pode fornecer internet por **tethering USB**, em outra
   sub-rede, sem bridge/ICS/hotspot do Windows. A rota padrão de internet pode usar USB;
   a rota específica da Ui16 deve continuar no Wi-Fi. Sem internet, observação local funciona.
5. Escolher ifIndex Wi-Fi (não o do tether), conferir `passed:true` no preflight e executar:

```powershell
npm run preflight:f0 -- --ip 10.10.1.1 --transport wifi --interface-index 7
npm run observe:f0 -- --physical-readonly --audio-disconnected --transport wifi --ip 10.10.1.1 --confirm-wifi-ip 10.10.1.1 --confirm-soundcraft-hotspot --interface-index 7 --channels 1 --duration 60 --report work/f0d-wifi-01
```

6. Não passar `--confirm-ethernet-ip` nesse caminho. Seleção/confirmadores de outro meio,
   IP divergente, índice ausente ou `--transport auto` são recusados antes de abrir socket.

Os caminhos novos do CLI físico requerem o preflight Windows. Em outros sistemas não há
fallback silencioso: recusam por consulta indisponível. Testes Linux injetam somente dados/
sockets falsos. O núcleo admite guard de rota por conexão sem depender de um segundo mixer;
uma futura integração noutro SO precisará de sua própria evidência, sem marcar Windows validado.

## Durante o ensaio, em qualquer transporte

Seguir o [procedimento F0C](18-F0C-READONLY-OBSERVER.md): observar fotografia do escopo,
mover pouco fader/MUTE **somente na UI oficial**, comparar os eventos recebidos e restaurar
manualmente os controles na UI. MixAI não executa ajustes, recall, EQ, preamp ou phantom.
AUX continuam opt-in e não comprovam saída física; não alterar roteamento de áudio.

Perda de WebSocket com a rota ainda correta permite reconexão pelo supervisor existente,
na mesma seleção/IP, sem replay. Perda da interface, mudança de rota ou ambiguidade no
preflight seguinte interrompe com `route_mismatch`, antes de outro socket. Após correção
**manual** da topologia, revalidar e iniciar nova sessão; não contornar pelo modo legado.
Retirar cabo/desassociar Wi-Fi pode portanto encerrar a captura em vez de autorrecuperar.

A consulta Windows pode consumir até 15 s por tentativa. O CLI novo reserva 30 s no timeout
de conexão para incluir essa consulta; sincronização, timeout de recuperação, gate de
escrita e limites de evidência continuam. A consulta síncrona pode atrasar o atendimento
de Ctrl+C/timers por até seu limite; executar só supervisionado. Não é monitor de produção.
O preflight avalia o instante anterior à abertura, **não é bind de socket a NIC**, nem
prova contínua de topologia; Windows decide a rota efetiva. Se a rede mudar, parar e revisar.

O guard não usa acesso à internet nem tenta IPs alternativos. Se a consulta falha/expira,
fecha a sessão. O erro resumido do CLI indica `route_mismatch`; rodar o helper separado
para obter o motivo sanitizado. Nunca despeja stderr do PowerShell, rotas ou IPs no relatório.

## Evidências: formato 2, compatibilidade e privacidade

Novos relatórios do mesmo observador usam `schemaVersion:2`, `transport:ethernet|wifi`
e `routeCheck`:

- `each_connection_gate`: consulta/gate exigido antes de cada nova abertura;
- `legacy_ethernet_declaration`: confirmação manual antiga, sem preflight automático;
- `simulated`: fonte de fixture/WebSocket falso; não comprova meio físico.

Não incluem IP privado, ifIndex, nomes/SSID/MAC, senhas, tokens ou payload bruto. Mantêm
hardwareValidation=pending, gerações, timestamps relativos, limites e demais gates F0C.
Wifi + declaração Ethernet legada e fontes/rotas contraditórias são rejeitados pelo esquema.

`parseObserverReport` e o exportador ainda aceitam arquivos **v1 estritos**, preservando
seu JSON original. O Markdown v1 informa “transporte não registrado”; não inventa Wi-Fi
nem promove a declaração antiga a validação de rota. `ObserverReportSchema` valida v2;
`LegacyObserverReportSchema` valida v1. Nenhum arquivo anterior é sobrescrito/migrado em disco.
O relatório não afirma verificação física só por passar num teste, consulta ou handshake.

| Registro humano sanitizado | Estado inicial |
| --- | --- |
| Transporte escolhido; hotspot ou cabo conferidos visualmente | PENDENTE |
| UI oficial/unidade/firmware conferidos (sem identificadores privados) | PENDENTE |
| Preflight coerente; tether opcional não recebe tráfego da Ui16 | PENDENTE |
| Fader/MUTE UI versus eventos e nova geração | PENDENTE |
| Interrupções/limitações de topologia e motivo de término | PENDENTE |

## Verificação e escopo

`npm run typecheck`, build, núcleo, web, E2E e `smoke:yoga` são executados. F0C e os dois
transportes usam exclusivamente WebSocket falso nos testes. Há testes de confirmação
cruzada/ausente, gate de rota em todas as gerações, rota recusada sem criar socket,
reconexão sem escrita, indisponibilidade de internet e sanitização/v1/v2. O lançador
PowerShell é testado com processo falso, sem shell/bypass e sem ecoar dados de erro.

Na CI Windows, o teste F0E restringe somente o ambiente de processos filhos, comprova
que um `.ps1` fictício é bloqueado e executa a mesma consulta fixa com cmdlets falsos.
Nenhum cmdlet desses testes acessa a rede; fixtures TypeScript cobrem os resultados
históricos do F0D e os gates de falha/reconexão. Ver limites e resultados no roteiro F0E.

Continuam manuais: Wi-Fi/RJ45 e tether do Yoga real, firmware, conectividade à unidade,
queda/recuperação física, equivalência de faders/MUTE e qualidade/roteamento de áudio.
O dispositivo ter chegado não equivale a F0 concluído. E6, escrita REAL, failover e mudanças
automáticas de rede não fazem parte desta entrega. Resultados e CI finais no PR.

### Evidências locais desta entrega

Linux, Node v24.22.1, base `6734195`: typecheck/build passaram; 72 testes focados de F0D/F0C
passaram; regressão final do núcleo: 617 testes; E2E: 74 testes; smoke Yoga: dois cenários
aprovados. Build web e testes da interface também passaram (contagem na descrição do PR).
A regressão E2E usa Chromium do sistema por preload do ambiente, sem alterar o projeto;
capturas E7A regeneradas foram restauradas, com cópia local em `work/`. O script de rotas
não foi executado com destino físico. PowerShell não disponível neste executor Linux:
seu self-test roda no job Windows, com resultado registrado no PR. Caddy/TLS não afetado,
não executado localmente, permanece no job existente da CI. Nenhum teste foi afrouxado.
