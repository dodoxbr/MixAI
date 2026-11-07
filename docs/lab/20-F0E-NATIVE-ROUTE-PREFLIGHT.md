# F0E — preflight Windows sem executar arquivos PowerShell

Issue [#41](https://github.com/dodoxbr/MixAI/issues/41). Branch exclusiva
`feature/f0e-native-route-preflight`, base `origin/main` em `1dfe8b1`, incluindo #40.
`AGENTS.md` lido. Não há validação física nesta entrega, E6 ou autorização de escrita REAL.

## Problema e solução

O incidente relatado no Yoga demonstrou bloqueio de execução do arquivo de preflight por
`PSSecurityException / UnauthorizedAccess`, mesmo com a rota Wi-Fi selecionada corretamente.
A rota correta não autoriza relaxar a política de segurança. O arquivo
`scripts/ui16-route-preflight.ps1` foi removido e não é executado nem convertido em código
PowerShell inline. Não é necessário liberar o arquivo ou mudar a ExecutionPolicy.

O mesmo observador F0C/F0D usa agora:

1. **Coleta fixa:** `powershell.exe -NoLogo -NoProfile -NonInteractive -Command` recebe uma
   constante local, revisável, limitada a `Get-NetIPInterface`, `Get-NetAdapter`,
   `Get-NetIPAddress`, `Get-NetRoute`, `Find-NetRoute`, projeção/filtro e serialização JSON.
   Não define funções nem executa o antigo algoritmo PowerShell. Não lê arquivos, perfis
   ou código remoto. Não aceita comandos fornecidos pelo usuário.
2. **Dados separados:** IP privado IPv4 validado é passado na variável de ambiente
   `MIXAI_F0_ROUTE_TARGET` somente do filho. IP, transporte, índice e caminhos nunca são
   concatenados no código. Transporte e índice são avaliados somente no Node.
3. **Decisão única:** `src/mixer/observer-route.ts` valida o snapshot estrito e decide.
   O comando de diagnóstico e o guard de cada socket/reconexão usam essa mesma lógica.
   Não há algoritmo paralelo em `.ps1` ou fallback menos rigoroso.

`Restricted` bloqueia arquivos de script, mas permite comandos nativos de consulta.
Isso utiliza o mecanismo permitido, sem reduzir a política. Políticas adicionais,
GPO, AppLocker, restrições de linguagem ou ausência de cmdlets podem bloquear também a
consulta: **nesse caso recusar e parar**, sem tentar outro mecanismo, interface ou IP.
Não usar bypass, EncodedCommand, Set-ExecutionPolicy, Unblock-File, registro, elevação,
ponte/ICS, mudanças de firewall/DNS/certificados ou opção de ignorar a verificação.

## Verificações preservadas

- IP privado/link-local IPv4 explícito; índice positivo; transporte Ethernet ou Wi-Fi.
- `Find-NetRoute` seleciona somente o índice esperado, com adaptador ativo e classe coerente.
- Wi-Fi pelo meio NDIS wireless; Ethernet pelo meio 802.3 físico. USB Ethernet legítimo
  continua permitido; RNDIS/tether/Apple Mobile Device Ethernet são recusados como destino.
- Destino on-link pela sub-rede esperada; recusa sobreposição em outras interfaces ativas.
- Prefixo de rota mais específico, soma das métricas de rota e interface, recusa de empates
  entre interfaces e de divergência entre métricas e `Find-NetRoute`.
- Snapshot ausente/inválido, campos extras, índices/métricas duplicados, saída truncada,
  erro, stderr, sinal ou timeout não autorizam conexão. Arrays/campos são limitados.
- Consulta limitada a 15 s e 256 KiB, sem shell intermediário. Guarda síncrona existente;
  timeout de conexão de 30 s e possível atraso de Ctrl+C/timers até 15 s permanecem.

O snapshot privado fica somente na memória do filho/Node. Nomes, descrição de adaptador,
MAC e SSID não são coletados na saída: só um indicador booleano de tether é projetado.
Endereços/prefixos necessários ao cálculo nunca são impressos, persistidos ou anexados
a erros. A saída pública contém somente transporte, índices, resultado e motivo enumerado.
Para compartilhar evidência do ensaio, usar o relatório do observador, que também omite
IPs e índices; não gravar terminais, linhas de comando ou snapshots brutos.

## Uso manual no Yoga

Terminal comum, sem administrador. Não alterar configurações do Windows. Os exemplos de
IP/índice são fictícios; conferir novamente a UI oficial e o índice real a cada ensaio.
O índice relatado no incidente não se torna um padrão permanente do programa.

Se o PowerShell resolver `npm` como `npm.ps1`, usar `npm.cmd` ou chamar o Node diretamente.
Isso executa os programas locais, sem liberar scripts nem mudar políticas:

```powershell
npm.cmd run build
node .\dist\f0-route-preflight-cli.js --help
# Wi-Fi: exemplo, somente consulta da tabela local; não envia probes para a mesa
node .\dist\f0-route-preflight-cli.js --ip 10.10.1.1 --transport wifi --interface-index 8
# Ethernet: outro exemplo, confirmar os valores correspondentes à unidade/interface
node .\dist\f0-route-preflight-cli.js --ip 192.168.50.10 --transport ethernet --interface-index 9
```

Alias disponível em terminais onde npm está acessível: `npm run preflight:f0 -- --ip IP
--transport wifi|ethernet --interface-index INDICE`. Não executar `wifi|ethernet` literalmente:
escolher um transporte. Não há IP nem índice padrão, modo auto ou conexão WebSocket no CLI
preflight. Código de saída 0 significa consulta coerente naquele instante; 1 significa recusa.

Somente após os gates físicos, com operador e **PA/HA800/fones desconectados**, seguir os
[dois roteiros F0D](19-F0D-DUAL-TRANSPORT-READONLY.md). O observador exige as confirmações
próprias já existentes e repete o preflight antes de cada novo socket, por exemplo:

```powershell
node .\dist\f0-observer-cli.js --physical-readonly --audio-disconnected --transport wifi --ip 10.10.1.1 --confirm-wifi-ip 10.10.1.1 --confirm-soundcraft-hotspot --interface-index 8 --channels 1 --duration 60
```

O exemplo não é executado por testes automatizados. Não usar confirmação Ethernet para
Wi-Fi nem o formato Ethernet antigo para contornar um bloqueio. Falha de rota sela a
sessão; não existe failover. A checagem não faz bind à NIC ou atestação contínua da rota.
A movimentação de faders/MUTE continua exclusivamente manual na UI oficial.

O preflight genérico Yoga (`yoga-preflight.ps1`) é separado e permanece fora deste ajuste.
Se ele for bloqueado, registrar a limitação e não alterar a política para executá-lo.

## Evidências automatizadas e pendências

- Casos históricos do self-test F0D foram migrados para fixtures do avaliador TS único:
  Ethernet/Wi-Fi com tether de internet, classe errada, link down, subnet errada, overlap,
  empate, índice incorreto, métricas e classificação. Cobertura ampliada para snapshots
  incoerentes e limites. Lançador testado com processo falso e argumentos constantes.
- Windows: teste de integração inicia somente filhos com `PSExecutionPolicyPreference`
  **Restricted**, verifica a política efetiva, comprova bloqueio de `.ps1` fictício e
  executa o coletor fixo de produção contra cmdlets substituídos por fixtures. Também
  exercita classificação RNDIS/Apple e Ethernet USB. Não muda política da máquina e
  nenhum cmdlet de rede real é chamado. Ubuntu ignora somente esse teste específico.
- WebSockets falsos comprovam falha antes do primeiro socket e na reconexão em ambos os
  transportes, sem escrita/replay, sem novos sockets e sem dados privados nos erros.
- Regressões: typecheck, builds, núcleo, web, E2E e smoke Yoga; Windows/Ubuntu/Caddy na CI.
  Resultados finais e SHA ficam na descrição do PR, sem publicar logs privados.

**Pendentes:** consulta real aos cmdlets sob as políticas efetivas do Yoga, classificação
do adaptador/driver real, Wi-Fi/Ethernet/tether, firmware, equivalência de faders/MUTE e
recuperação física. Fixtures e CI não comprovam funcionamento da Ui16. Nenhuma conexão,
comando REAL ou alteração de rede foi executada para produzir esta entrega.
