# F0 — preparação offline e roteiro físico somente leitura

Issue [#15](https://github.com/dodoxbr/MixAI/issues/15). Preparação em 06/11/2026.
**A Ui16 ainda não chegou. Nenhum teste físico foi executado.** Este roteiro substitui
os passos antigos de mover fader/desfazer no README e no plano F0. E6 e E7A não fazem
parte desta entrega. Passar neste roteiro não autoriza escrita nem encerra a validação
física de controle da mesa.

Antes da chegada da mesa, usar [F0B — ensaio integrado no Yoga](17-F0B-YOGA-REHEARSAL.md)
e `npm run smoke:yoga`. O smoke não executa este roteiro físico nem abre REAL.

Para observar mudanças feitas **manualmente na UI oficial**, após os portões de segurança,
usar [F0C — observador somente leitura](18-F0C-READONLY-OBSERVER.md). O MixAI permanece
sem escrita; esse ensaio supervisionado não é executado pelo F0B/CI nem conclui F0 sozinho.

F0D: a unidade foi recebida; isso não confirma ensaio físico. O
[roteiro dual Ethernet/Wi-Fi](19-F0D-DUAL-TRANSPORT-READONLY.md) permite começar pelo
hotspot da Ui16 sem adaptador RJ45, com confirmação própria e sem simular Ethernet.
As evidências históricas de preparação offline não são validação de hardware.

## 1. Topologia e materiais

```text
Ui16 (porta Ethernet/LAN) ── cabo RJ45 ── adaptador USB-C/RJ45 ── Lenovo Yoga
                                                              │ Wi-Fi
                                                   roteador privado da banda
                                                     ├── internet
                                                     └── celulares
```

- Yoga com fonte, Windows atualizado, Node >=22, cabo e adaptador com driver instalado.
- Ui16 alimentada conforme o manual; **PA, amplificador de fones e fones desconectados**.
  Sem teste em evento, passagem de som ou com pessoas usando saídas de áudio.
- Wi-Fi do Yoga conectado ao roteador privado, não ao hotspot da Ui16. Não criar ponte
  de rede, ICS/compartilhamento de internet, hotspot do Windows nem encaminhamento entre
  Ethernet e Wi-Fi. Celulares ficam no mesmo roteador privado, sem isolamento de clientes.
- Não confundir o IP da mesa (Ethernet) com o IP Wi-Fi do Yoga (acesso dos celulares).
- O padrão `10.10.1.1` do config se refere ao hotspot e **não comprova o IP Ethernet**.
  Consulte a configuração LAN realmente aplicada, etiqueta/manual da revisão entregue
  ou a UI oficial por um acesso autorizado. Não fazer reset de fábrica para descobrir IP.

## 2. Preparação que já pode ser feita sem mesa

1. Instalar driver do adaptador, conectar ao Yoga e identificar sua interface no Windows.
   Sem cabo/mesa, `Disconnected` é esperado e não prova defeito.
2. Guardar os valores atuais de IPv4, DNS, DHCP, perfil e rotas do adaptador para restaurar.
3. No repositório: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
4. Conferir `node -v`, `npm ls soundcraft-ui-connection` e `git rev-parse HEAD`.
   A dependência está fixada em **7.1.0**. Não atualizar biblioteca/firmware durante F0.
5. Revisar `config/channels.yaml`: canais 1–11 cadastrados, 12 livre, AUX 1 = Fones
   (HA800 recebe uma única mix). Os aliases são configuração local, não descoberta física.
6. Simular sem rede: `node dist/console.js --mock --readonly`; usar `status`, `estado`,
   `estado @ fones`, `nomes`, `snapshots`, `sair`. O banner deve dizer SOMENTE LEITURA.
   Não usar `console:f0` nesta preparação: ele abrirá conexão real quando executado.
7. Executar as simulações focadas: `npx vitest run test/f0-readonly.test.ts test/supervisor.test.ts test/real-adapter.test.ts`.
   Todos os sockets desses testes são falsos; comandos de escrita existentes nos testes
   de regressão só chegam ao simulador. Não apontar testes para equipamento.

## 3. Windows: identificar interfaces e configurar sem perder internet

Comandos abaixo são **consultas**, em PowerShell normal. Não mudam rede e não exportam
senhas. Guarde apenas a saída necessária no formulário local; SSID, MAC e IPs públicos
não precisam ir ao Git. Não usar `netsh ... key=clear` nem anexar dumps de ambiente/segredos.

```powershell
Get-NetAdapter | Select-Object ifIndex,Name,InterfaceDescription,Status,LinkSpeed
Get-NetIPConfiguration | Select-Object InterfaceIndex,InterfaceAlias,IPv4Address,IPv4DefaultGateway
Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceIndex,InterfaceAlias,IPAddress,PrefixLength,AddressState
Get-NetIPInterface -AddressFamily IPv4 | Select-Object ifIndex,InterfaceAlias,Dhcp,ConnectionState,InterfaceMetric
Get-NetRoute -AddressFamily IPv4 | Select-Object DestinationPrefix,NextHop,InterfaceIndex,RouteMetric
Get-DnsClientServerAddress -AddressFamily IPv4
Get-NetConnectionProfile | Select-Object InterfaceIndex,InterfaceAlias,NetworkCategory
ipconfig /all
route print -4
```

1. Reconhecer o adaptador pelo fabricante/descrição e pelo `ifIndex`. Não assumir que se
   chama `Ethernet` ou que o Wi-Fi é a interface 1. Desconectar/reconectar **só o USB-C**
   para confirmar a identificação, antes de iniciar a sessão física.
2. Manter o Wi-Fi com seu DHCP, gateway e DNS atuais. Testar um site HTTPS da internet.
3. **Somente após confirmar o IP/máscara LAN da Ui16**, abrir `ncpa.cpl` → adaptador
   USB Ethernet correto → Propriedades → Protocolo IP Versão 4 → Propriedades.
   Se já recebe DHCP válido para a LAN da mesa e não cria gateway concorrente, registrar
   e avaliar antes de alterar. Para o cabo direto com endereço manual:
   - atribuir ao Yoga um IP livre na mesma sub-rede da LAN da mesa, distinto da mesa,
     do endereço de rede e do broadcast;
   - usar a máscara confirmada; **gateway padrão vazio e DNS vazio na Ethernet**;
   - exemplo **ilustrativo**: se a LAN confirmada for `192.168.50.10/24`, usar
     Yoga `192.168.50.20`, máscara `255.255.255.0`. Não copiar sem conferir;
   - não desabilitar IPv6 nem mudar métrica/gateway do Wi-Fi como tentativa genérica.
4. Ethernet da Ui16 e Wi-Fi precisam de sub-redes diferentes. Se houver sobreposição,
   **interromper**: escolher uma rede privada alternativa planejada para o Wi-Fi, ou
   replanejar fora do F0. Não mudar a rede da Ui16 durante este teste.
5. Repetir as consultas: rota local da sub-rede da mesa pela USB Ethernet; rota padrão
   de internet pelo Wi-Fi; nenhuma rota padrão adicional pela Ethernet. Não resolver
   sobreposição apenas baixando métrica. Conferir também VPNs/adaptadores virtuais.
6. Não desabilitar o firewall. O console F0 só precisa de conexão de saída à mesa;
   não exige abrir porta de entrada nem tornar a Ethernet uma rede privada.

### Celulares, ainda no laboratório

Os celulares não precisam alcançar a LAN da Ui16. Para testar a tela MixAI sem hardware,
seguir [E2, rede e firewall](06-E2-SERVIDOR.md): Wi-Fi confiável com perfil **Privada**,
`server.lan.host` igual ao **IPv4 do Wi-Fi do Yoga** no `config/config.local.yaml`
(fora do Git), `npm run serve:lab`, acesso `http://<IP-WIFI-YOGA>:8790`.
Permitir apenas a regra de firewall LAB do roteiro E2, restrita à rede privada.
Nunca expor `0.0.0.0`, porta 8791 ou REAL para os celulares neste F0.
Antes da leitura física, encerrar o servidor LAB e demais processos MixAI para reduzir
confusão. Não executar `serve:real`, console comum REAL ou MCP REAL durante F0.

## 4. Diagnóstico físico, só quando a mesa chegar

1. Conferir as condições de segurança, ligar a mesa e aguardar inicialização.
2. Conectar cabo à porta LAN da mesa e ao adaptador. Conferir LEDs e `Status = Up`.
3. No PowerShell, substituir o exemplo pelo IPv4 LAN **confirmado**, sem URL ou porta:

```powershell
$Ui16Ip = '192.168.50.10' # EXEMPLO: substituir pelo endereço confirmado
Find-NetRoute -RemoteIPAddress $Ui16Ip
Test-NetConnection -ComputerName $Ui16Ip -Port 80 -InformationLevel Detailed
ping -n 4 $Ui16Ip
Get-NetNeighbor -AddressFamily IPv4 | Where-Object IPAddress -eq $Ui16Ip
```

4. `Find-NetRoute` e `Test-NetConnection` devem selecionar interface USB Ethernet e
   o IP Ethernet do Yoga como origem. Se selecionarem Wi-Fi/VPN, parar e rever sub-redes.
   `ping` sem resposta pode ser ICMP bloqueado; não prova indisponibilidade HTTP.
   ARP incompleto sugere cabo, IP, máscara ou mesa desligada; não prova qual deles.
5. Abrir `http://<IP-LAN-CONFIRMADO>` no navegador do Yoga. Confirmar que é a **UI oficial
   da Ui16 correta**, sem tocar em controles de áudio/rede. HTTP/TCP 80 acessível não
   comprova modelo, firmware, WebSocket ou sincronização.
6. Reabrir site HTTPS externo; verificar que Wi-Fi continua conectado e com gateway/DNS.
   Registrar separadamente UI oficial, internet e tela LAB em celular (se testada antes).
7. Se houver falha: registrar IP/máscara/rota/interface, LED e mensagem, verificar cabo e
   driver, depois parar se persistir. Não varrer redes, alterar a mesa nem contornar acessos.

## 5. Console F0 existente com proteção permanente

Só no dia do teste físico, após diagnóstico e checklist, informar o IP confirmado:

```powershell
$env:MIXAI_IP = $Ui16Ip
npm run console:f0
```

O script fixa `--real --readonly`, reutiliza `createApp`, `RealMixer`, o supervisor e a
trava de dono existentes. Não cria outro adaptador, servidor ou interface web. Se outro
processo detiver a trava, sair e fechar o processo legítimo; não apagar a trava à força.
A opção só restringe esta sessão; **não transforma outros entrypoints REAL em somente
leitura**. Nunca trocar pelo console REAL comum como tentativa de recuperação.

Comandos permitidos nesta sessão:

```text
status
nomes
estado
estado @ fones
snapshots
status
sair
```

- `status`: conexão, capacidades configuradas e show/snapshot observado.
- `nomes`: mapa do YAML; comparar com nomes observados em `estado` e UI oficial.
- `estado`: comparar nível/mute dos canais e master sem alterar nada.
- `estado @ fones`: comparar mix AUX 1, respeitando se o envio é pre/post na UI oficial.
- `snapshots`: apenas listar. Lista vazia/valor ausente pode significar **timeout ou
  desconhecido**; não comprova inexistência. Não carregar/salvar/renomear snapshots.
- `log` fica bloqueado para evitar confundir histórico anterior com evidência atual.
  Registro deste F0 é o formulário e a saída selecionada do console; não é captura de
  todos os frames. Não anexar logs históricos indiscriminadamente.
- `sobe`, `desce`, `nivel`, mute/abrir, master, desfazer e carregar snapshot são recusados
  **antes do controlador**, sem confirmação ou fila. Não experimentar esses comandos na
  mesa física: a prova de recusa ocorre somente nos testes com socket falso.
- Defesa adicional no supervisor bloqueia `write` e `withReadyUi` (incluindo snapshot)
  mesmo em `READY`, e continua ativa em novas gerações após reconexão.
- A biblioteca envia keepalive e consultas de protocolo; somente leitura significa
  **nenhuma alteração de parâmetro/snapshot**, não ausência de tráfego de saída.

### Estados esperados

| Estado | Interpretação no F0 | Conduta |
| --- | --- | --- |
| CONNECTING | conexão em andamento | aguardar até o timeout configurado |
| SYNCING | socket abriu, dados ainda incompletos | não tomar dados ausentes como zero |
| READY | parâmetros obrigatórios recebidos | comparar leituras; escrita F0 segue bloqueada |
| DEGRADED_READ_ONLY | faltam parâmetros após timeout | registrar faltantes; não aprovar compatibilidade |
| LOST | geração descartada, reconexão agendada | registrar horário; nenhuma repetição de comandos |
| STOPPED | falha interna | encerrar sessão; usar UI oficial |
| DISCONNECTED | sessão encerrada/sem conexão | nenhuma conclusão sobre a mix |

No padrão, conexão espera até 8 s e sincronização até 5 s; reconexão usa intervalos
1, 2, 4, 8 e até 10 s. Overrides locais podem mudar isso: registrar valores efetivos
sem copiar segredos. Para evitar tentativas indefinidas, parar manualmente se não houver
recuperação em **30 s** após religar o cabo ou se houver perdas repetidas sem intervenção.
O console consulta estado por comando; não promete registrar todas as transições breves.

## 6. Checklist de compatibilidade (sem inferir capacidades físicas)

- [ ] Modelo exato na etiqueta/UI, número de série guardado localmente se necessário.
- [ ] Firmware/build da UI oficial, versão do Windows/driver/Node e biblioteca instalada.
- [ ] IP/máscara LAN da mesa e Yoga; IP do hotspot registrado separadamente se conhecido.
- [ ] Canais 1–11, aliases e nomes reais; 12 livre; entradas Hi-Z/combo verificadas no painel.
- [ ] Diferenciar entradas físicas, strips de linha/playback e total comercial “16 canais”.
- [ ] AUX físicos e buses na UI, AUX 1 Fones, roteamento do HA800 previsto, sem conectá-lo.
- [ ] Biblioteca/perfil Ui16 declara **12 entradas e 6 AUX**; isso não é autodetecção.
  A documentação histórica prevê **4 AUX físicos**. Registrar o que a unidade realmente
  apresenta: não assumir que AUX 5/6 do perfil são saídas físicas acessíveis.
- [ ] Snapshot/show atual e lista somente observados; nenhum recall, save ou cena Lab→Real.
- [ ] Níveis/mutes de PA, master e AUX 1 comparados com a UI oficial, inclusive −∞ e desconhecidos.
- [ ] Sem ganho/phantom/EQ/HPF, sem medidores reais ou espelho E6 novos neste escopo.

Firmware, modelo real, contagem física e qualidade de áudio não são detectados pelo
console. Divergência/incompletude deve constar como pendência, nunca ser “corrigida”
enviando valores. Não completar artificialmente parâmetros para forçar READY.

## 7. Perda/recuperação e prova de não reenvio

**Já simulável**: suíte `f0-readonly` lê com a biblioteca 7.1.0 e socket falso, tenta
alterações apenas no falso, atravessa três quedas, ignora evento antigo, verifica uma
única conexão viva e zero comandos mutantes em **todas** as gerações, inclusive após
2,6 s (além do retry da biblioteca). Também cobre SYNCING → DEGRADED → READY sem liberar
escrita. `supervisor.test.ts` cobre comando recusado após queda, escrita na janela de
queda silenciosa, classificação sem reenvio e bloqueio tardio de geração descartada.
Nenhuma dessas simulações valida driver, rede Windows, firmware ou hardware.

**Pendente físico, sem comandos de alteração**:

1. Em condição segura e leitura estável, anotar estado/UI e horários.
2. Retirar só o cabo Ethernet do adaptador (não USB-C, Wi-Fi ou energia da mesa).
3. Consultar `status`/`estado`, registrar indisponibilidade; nenhum ajuste deve ser tentado.
4. Confirmar internet Wi-Fi; após cerca de 5 s religar o mesmo cabo.
5. Consultar `status`/`estado` até recuperar; anotar tempo e comparar UI, master, PA e AUX.
6. Se não recuperar em 30 s ou mudar algo inesperadamente, interromper.

A ausência de mudança na UI não prova sozinha ausência de frames antigos. O teste físico
somente leitura não produz comandos pendentes; evidência de buffer/não replay vem das
asserções com sockets falsos. Não criar comandos reais “pendentes” para testar replay.
Captura de tráfego não é requisito e pode conter dados privados; nunca publicar bruta.

## 8. Parada e retorno operacional

Interromper imediatamente por: áudio conectado, equipamento/modelo duvidoso, sub-redes
sobrepostas, rota pela interface errada, exigência de alterar firmware/rede da mesa,
controle de escrita disponível por outro processo, alteração inesperada na UI, instância
antiga reaparecendo, STOPPED, perda persistente, dados incoerentes ou acesso negado.

Usar `sair` para desconectar e cancelar retries; se não responder, Ctrl+C encerra o
processo. Não reiniciar repetidamente para tentar “aplicar” resultado incerto. Fechar
MCP/servidores REAL. Usar a UI oficial para inspeção e operação manual futura pelo
operador; durante este F0, manter tudo sem alterações e saídas desconectadas.

Restaurar **somente o adaptador Ethernet do Yoga** aos valores anteriores (DHCP ou
estático/DNS documentados), via Propriedades IPv4, ao terminar. Remover a variável
`MIXAI_IP` desta sessão PowerShell (`Remove-Item Env:MIXAI_IP`) se foi criada aqui; se
existia antes, restaurar seu valor anterior. Não resetar mesa, recarregar snapshot,
aplicar cena nem usar `desfazer` como rollback. Anotar incidente e preservar evidências
sem PIN, token, chave de API ou credenciais de rede. Acesso negado: registrar e parar.

## 9. Evidências e aceite

Copiar [o formulário F0](14-F0-EVIDENCIAS-MODELO.md) para um arquivo local fora do Git.
Preencher primeiro as simulações e deixar **PENDENTE — hardware não disponível** em
todas as verificações físicas. Não marcar F0 real como concluído a partir do CI.
O relatório deve distinguir: verificado localmente, observado em hardware, desconhecido,
falhou e não executado. Somente uma nova etapa autorizada poderá validar escrita/E6.

Resultados desta preparação: [15-F0-VALIDACAO-OFFLINE.md](15-F0-VALIDACAO-OFFLINE.md).
