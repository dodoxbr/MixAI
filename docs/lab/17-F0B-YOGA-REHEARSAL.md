# F0B — ensaio integrado LAB no Lenovo Yoga 7 / Windows

Issue [#27](https://github.com/dodoxbr/MixAI/issues/27). Base `main` em `10c2b48`:
PR #23 HTTPS LAB (`10c2b48`), #24 E8A (`f8697ca`) e #25 técnico de som (`418b205`)
confirmados pela API e como ancestrais. Branch independente `feature/f0b-yoga-rehearsal`.
A Ui16 ainda não está disponível; **F0 físico e E6 não foram executados/iniciados**.

## 1. Um comando para o ensaio automático

Na raiz do repositório, em terminal normal (sem administrador):

```text
npm ci
npm ci --prefix web
npm run smoke:yoga
```

São necessárias dependências instaladas e Node.js **22 ou superior**. O comando confere
Chromium antes de construir. Se faltar navegador, falha com instrução e **não baixa nada**.
O operador pode decidir executar, separadamente:

```text
npx playwright install chromium
```

Não acrescentar flags de desativação de segurança/TLS nem usar instalação de dependências
de sistema como administrador no Yoga. Se a instalação for bloqueada por política,
registrar e parar; não usar bypass. No Linux, dependências nativas também podem faltar;
o smoke não as instala. Provisionamento de browsers na CI é explícito no workflow,
em runners descartáveis, separado do comando de ensaio.

O smoke padrão faz typecheck de src/testes, build do servidor e Angular e executa só o
cenário integrado mais o teste offline E8A existente. **Não repete toda a suíte**.
Depois de builds já validados, a CI usa `npm run smoke:yoga -- --built`; essa opção apenas
omite os builds, exige artefatos e mantém todas as verificações de segurança/integração.
Nenhuma opção seleciona REAL, IP ou LAN. A saída informa plataforma, Node e resultado;
código 0 = aprovado, código diferente de zero = falha/interrupção.

### Isolamento e limpeza

- Configuração do servidor construída com os helpers existentes, **LAB fixo**, 127.0.0.1
  e porta efêmera. Não usa `loadConfig`, `config.local.yaml`, `secrets.yaml` ou PIN da banda.
- PINs sintéticos das fixtures e tokens efêmeros, mantidos apenas na pasta descartável.
  Não imprimir ou publicar esses valores. AI externa e proxy HTTPS ficam OFF.
- Remove overrides `MIXAI_*` e variáveis de credenciais de provedores do ambiente dos
  filhos, sem alterar o ambiente do terminal. Não reutiliza `data/`, cenas ou logs locais.
  Desativa analytics/prompts de build por variáveis dos filhos, sem configurar Angular global.
- Reutiliza `startLab`/`startTestServer`, `enter`, `wsClient`, StateSync e a fixture E8A.
  O teste falha se `RealMixer` for carregado. HTTP/WS são limitados ao loopback nos clientes
  Node e navegador. O endereço rejeitado `targetMode: real` é apenas envelope recusado
  pelo servidor LAB; nenhuma operação ou conexão REAL é executada.
- Verifica porta fechada, mixer desconectado, trava e token removidos após encerrar;
  reinicia com a mesma pasta temporária para provar persistência e invalidação de sessão.
- `finally` fecha contextos/sockets/servidor e remove a pasta temporária. O runner também
  remove sua pasta ao finalizar ou receber interrupção. Ctrl+C pode encerrar o ensaio;
  desligamento abrupto/SIGKILL não permite prometer cleanup. Nesse caso, uma pasta com
  prefixo `mixai-yoga-` pode permanecer no temporário do sistema: não contém dados da banda;
  fechar o processo identificado e removê-la manualmente, sem apagar outras pastas/travas.
- Builds atualizam apenas artefatos de desenvolvimento em `dist/`/cache Angular. O smoke
  não salva screenshots em docs, não escreve configurações e não inicia proxy/microfone.
- O helper já usa rate limit de teste (100 ações/s); isso não muda as travas de produção.
  Rate limit, cenários exaustivos e limites móveis continuam nas suítes de regressão.

## 2. O que é efetivamente testado

| Recurso | Evidência automática |
| --- | --- |
| Servidor LAB | inicia, escuta só loopback, fecha porta/trava/token e reinicia |
| Autenticação | login sintético de operador e músico em HTTP e na UI |
| HTTP/WS | estado autenticado, snapshots/eventos e dois clientes sincronizados |
| PA/FONES | fader/MUTE PA e MUTE FONES no Yoga emulado, +2 dB no celular emulado; retorno chega ao Yoga/StateSync |
| EQ LAB | aviso de simulação, curva SVG e alteração de ganho; sem equivalência física presumida |
| Cenas E5 | salva, lista/compara na tela, pede carregamento, mantém estado até aprovar |
| Aprovação humana | músico/agente não aprovam; clique do operador aplica somente no LAB |
| Desfazer/persistência | desfaz cena; PA, AUX, EQ e cena persistem na pasta temporária após restart |
| Técnico de som B3A | consulta via chat, hipóteses/fontes/confiança; nenhuma proposta/write |
| E8A | fixture com diferenças e −∞; exportação JSON/Markdown, applicable=false; teste offline de zero sockets |
| Recusas | sem autenticação, PA/master/EQ/consulta indevidos pelo músico; modo divergente; pós-logout HTTP/WS |
| Voz experimental | painel ausente e zero chamadas getUserMedia nos dois perfis |

O smoke não valida toque físico, driver USB, som, firmware, rede Wi-Fi da banda ou câmera/
microfone reais. Passar em Chromium emulado não equivale a testar Android/Windows no Yoga.

## 3. Diagnóstico Windows somente consulta

Em PowerShell normal, sem Run as administrator, na raiz:

```powershell
.\scripts\yoga-preflight.ps1
# Opcional: guardar localmente, revisar antes de compartilhar
.\scripts\yoga-preflight.ps1 | Out-File -Encoding utf8 work\yoga-preflight.json
```

Criar `work/` se não existir. Se a política impedir executar o arquivo, **não usar
ExecutionPolicy Bypass, Set-ExecutionPolicy ou elevação**. Registrar o bloqueio e executar
manualmente apenas as consultas listadas abaixo, sem publicar saída bruta:

```powershell
node --version
Get-NetAdapter
Get-NetIPAddress -AddressFamily IPv4
Get-NetRoute -AddressFamily IPv4
Get-NetTCPConnection -State Listen
```

O script não requer privilégios de administrador. Retorna JSON por lista positiva:
versão do Node (>=22), quantidade de executáveis Node encontrados (usa o primeiro no PATH), ifIndex/tipo aproximado/status/link, IPv4 locais, prefixos/next hop/
métricas, listeners das portas 8790/8791 e uma tentativa TCP **apenas** em 127.0.0.1:8790.
Não faz HTTP nem consulta a mesa, internet, DNS ou destinos arbitrários. Não publica
nomes personalizados, hostname, MAC, SSID, processos/PID, credenciais ou IP público.
IPv4 públicos/IPv6 são omitidos. Identificação Wi-Fi/Ethernet por descrição é aproximada;
confirmar fisicamente por ifIndex. Campos indisponíveis viram avisos genéricos, sem bypass.
Node ausente/incompatível gera código 1; ausência de servidor LAB padrão não é falha.
**O smoke usa outra porta efêmera e encerra no final**, portanto `labLoopback8790=false`
logo depois do ensaio é normal. Listener 8791 é somente consulta, nunca conexão REAL.

Checklist local (sem alterar rede):

- [ ] Node >=22; builds e Chromium disponíveis.
- [ ] Adaptador USB-C/RJ45 identificado por ifIndex; driver presente. Sem cabo, Disconnected
  é esperado e não confirma nem descarta a compatibilidade com a Ui16.
- [ ] Wi-Fi identificado; IPv4/prefixo/gateway existentes anotados localmente.
- [ ] Rotas observadas: sub-redes de Ethernet e Wi-Fi não se sobrepõem; VPNs também revisadas.
- [ ] Nenhuma ponte/ICS/hotspot Windows usado para ligar mesa e celulares.
- [ ] LAB padrão 8790 livre ou ocupado por processo conhecido; não matar processos à força.
- [ ] Internet e celulares conferidos manualmente, separadamente da conectividade loopback.

Não executa Set/New/Remove de rede, firewall, DNS, endereços, rotas, certificados/CA ou
configuração global. Sanitização tem `-SelfTest` com endereços fictícios; esse modo não
consulta rede e é exercitado na CI Windows junto ao diagnóstico real do runner.

## 4. Ensaio humano no Yoga + celular (manual, não executado pelo smoke)

1. Primeiro executar o smoke. Fechar o navegador de teste; ele não deixa servidor aberto.
2. Usar Wi-Fi privado confiável já autorizado, mantendo a Ethernet da futura mesa separada.
   Os dispositivos precisam se enxergar no roteador; isolamento de clientes pode bloquear.
3. Para ensaio humano, preparar **configuração/dados LAB separados**, sem copiar segredos
   ou cenas de produção. Em uma nova sessão PowerShell, preservar seus valores antigos
   de `MIXAI_*` e apontar `MIXAI_CONFIG_DIR`, `MIXAI_DATA_DIR`, `MIXAI_LAB_FILE` e
   `MIXAI_LOG_DIR` para uma pasta de treino. Copiar só `config.yaml` e `channels.yaml`
   para essa configuração; não copiar `config.local.yaml`/`secrets.yaml`. Confirmar
   ai.enabled=false, server.httpsLab.enabled=false e mixer.mode=lab.
4. Cadastrar PINs exclusivos de treino pelos comandos existentes `npm run pin -- operador`
   e `npm run pin -- musico` em terminal interativo, dentro dessa configuração separada.
   Não colocar PIN em argumento, relatório ou Git. As variáveis de override de PIN/API
   não devem vir de outra sessão de produção.
5. Com o IP **Wi-Fi já atribuído ao Yoga**, configurar o bind LAB da aplicação conforme
   [E2](06-E2-SERVIDOR.md) (`server.lan.host` específico ou MIXAI_LAN_HOST). Isso não atribui
   IP ao Windows. Não usar 0.0.0.0 nem o IP da mesa. Iniciar `npm run serve:lab`.
6. Abrir `http://127.0.0.1:8790` no Yoga e `http://<IP-WIFI-YOGA>:8790` no celular. Se a porta
   foi personalizada, usar a informada pelo servidor. Se firewall/perfil/roteador bloquear,
   **registrar e parar**, sem mudar firewall, DNS, IP ou certificados neste ensaio.
7. Confirmar LABORATÓRIO, entrar como operador no Yoga/músico no celular, testar PA/FONES,
   EQ somente no Yoga operador, cena LAB com aprovação, desfazer e consulta ao técnico.
   Conferir que músico não acessa master, EQ, cenas ou consulta exclusiva do operador.
8. Girar celular, testar toque do Yoga e legibilidade. Voz deve continuar ausente/OFF.
   **Microfone Android em HTTP por IP não funciona como contexto seguro**; isso é esperado,
   não deve provocar tentativa de habilitar voz ou ignorar segurança do navegador.
9. Sair das sessões, Ctrl+C no servidor manual e conferir encerramento. Restaurar somente
   os overrides/configuração da aplicação da sessão, sem mudar Windows. Guardar/remover
   a pasta de treino conforme necessário; nunca apagar dados/travas de outra instalação.

São verificações manuais pendentes: Yoga/driver físico, Wi-Fi real/internet, celular real,
toque/rotação, políticas do Windows e ambiente musical. Não marcar como executadas por CI.

### HTTPS LAB opcional (E9B), etapa manual separada

A infraestrutura do PR #23 já está na main e OFF por padrão. O smoke não a ativa, não
baixa Caddy, não gera/instala certificados, não muda DNS/CA/firewall e não acessa microfone.
O [plano E9B](16-E9B-HTTPS-LAN.md) trata configuração privada HTTPS/WSS e confiança dos
clientes. Sua implantação exige planejamento/manual próprios; não executar esses passos
como solução automática para falha do smoke. Mesmo em HTTPS, a flag de voz fica OFF.
A suíte TLS separada/CI do PR #23 não é comprovação de CA instalada em Android/Yoga.

## 5. Primeiro F0 físico: ponto de entrada único

Quando a mesa chegar, seguir **[13-F0-PREFLIGHT-READONLY.md](13-F0-PREFLIGHT-READONLY.md)**
e copiar o [formulário físico](14-F0-EVIDENCIAS-MODELO.md). Este guia não duplica o roteiro
nem o executa. Portões antes de iniciar leitura:

- PA, HA800 e fones fisicamente desconectados; fora de evento/ensaio com áudio.
- Driver/cabo/porta LAN identificados; IP e máscara Ethernet **confirmados**, nunca supor
  que o IP do hotspot `10.10.1.1` é o da Ethernet.
- Wi-Fi preservado para internet/celulares; rotas/máscaras revistas sem alterações automáticas.
- Apenas operador e console F0 protegido; outros processos REAL encerrados legitimamente.
- Firmware/modelo/canais/AUX e diferenças da biblioteca registrados como observação.
- Somente status/estado/nomes/listagem de snapshots; nenhum fader/mute/EQ/recall/desfazer.
- Perda/reconexão física apenas em leitura, conforme roteiro, sem produzir comandos pendentes.
- Parar por dados incoerentes, rota errada, STOPPED, perda persistente, áudio conectado ou
  necessidade de alterar mesa/rede. Voltar à inspeção pela UI oficial, sem aplicação/rollback de mix.

`smoke:yoga` nunca chama `console:f0`, `serve:real`, MCP REAL ou protocolo Soundcraft.
O sucesso do F0B não conclui F0 físico, não autoriza escrita e não inicia E6.

## 6. Registro de evidências do ensaio

Preencher localmente, sem PIN/token/IP público/segredos:

| Campo | Resultado do operador |
| --- | --- |
| Data/fuso, branch, commit, Windows/Node | |
| smoke:yoga: aprovado/falhou e etapa | |
| Se falhou: mensagem sanitizada; não executados | |
| Browser instalado previamente / instalação decidida separadamente | |
| JSON do preflight revisado; avisos e ifIndex confirmados | |
| Temporários removidos; dados LAB habituais preservados | |
| Yoga touch/rotação, celular real, Wi-Fi/internet (manual) | PENDENTE |
| HTTPS opcional/CA nos clientes (manual, separado) | PENDENTE |
| F0 físico/firmware/driver/RJ45/Ui16 | PENDENTE — hardware |

Os resultados locais e CI desta entrega constam no PR. Contagens do núcleo, web, E2E e
smoke são separadas: o smoke reutiliza um teste E8A e seu cenário integra a suíte E2E;
**não somar como se fossem todos testes distintos**.

### Validação local desta entrega

Linux, Node v24.22.1, npm 11.9.0, base `10c2b48`:

| Verificação | Resultado |
| --- | --- |
| `npm run smoke:yoga` | builds/contratos e dois cenários aprovados |
| `npm run smoke:yoga -- --built` com verificações MUTE finais | dois cenários aprovados |
| `npm run typecheck` final | passou |
| `npm test` | 461/461, 43 arquivos |
| `npm run test:web` | 81/81, 10 arquivos |
| `npm run test:e2e` | 63/63, 10 arquivos, incluindo cenário Yoga |
| Browser deliberadamente ausente | exit 1 esperado, instrução manual, sem download e sem temporário restante |
| `git diff --check` | passou |
| PowerShell local | não executado: runtime ausente neste Linux; CI Windows cobre script/self-test |
| Yoga/Windows físico, celular real, rede, Ui16 | não executado; checklist manual pendente |

O teste inicial de logout consultou HTTP antes da resposta de revogação e falhou.
O cenário passou a aguardar a resposta `/api/logout` antes de conferir a recusa;
nenhum handler, permissão ou timeout foi alterado para obter aprovação. O comando
completo e a regressão subsequente passaram.

Chromium local foi o do sistema via preload do ambiente, sem alterar o projeto/CI.
Capturas E7A regeneradas pela regressão foram preservadas em `work/` e restauradas
na árvore versionada; não entram no PR. Testes TLS/Caddy continuam no job separado
já existente da E9B; não foram executados localmente nesta rodada nem instalou-se CA.
CI Windows/Linux e o preflight do runner são registrados no PR; não equivalem ao Yoga.

O primeiro job Windows aprovou núcleo/web/builds e o smoke, mas identificou falha no
preflight ao resolver Node. A seleção agora usa explicitamente o primeiro executável
na precedência do PATH (a consulta pode retornar múltiplas instalações) e registra só
a contagem, sem caminhos. O self-test também cobre versões válidas/inválidas e erro de
execução. A correção não altera PATH, instalações ou privilégios. Resultado final no PR.
