# E9B — HTTPS/WSS privado opcional no Yoga (LAB)

Issue #22. Base `9faaf46`, com merges #14 (EQ), #17 (F0), #18 (conhecimento)
e #19 (spike de voz). Este procedimento é opt-in e manual. O padrão HTTP não muda;
`server.httpsLab.enabled` e `SPEECH_SPIKE_ENABLED` continuam `false` por padrão.
Sem reconhecimento, gravação, upload de áudio ou comandos na mesa real.

## Topologia e fronteiras

```text
Ui16 ← Ethernet → Yoga (sem bridge/ICS/roteamento entre interfaces)
                    ↑ Wi-Fi privado dos músicos
Android → https://mixai.home.arpa:8443 → Caddy (IP específico do Wi-Fi)
                                        → HTTP 127.0.0.1:8792 (entrada LAB humana)
MCP no Yoga → HTTP 127.0.0.1:8790 (entrada local existente)
```

A porta 8792 é um backend **HTTP loopback**, não um serviço HTTPS direto. TLS termina
no Caddy, no mesmo Yoga. `/`, `/api/*` e `/ws` seguem para o mesmo `ServerCore` LAB;
Caddy faz Upgrade WebSocket automaticamente. O navegador usa URLs relativas e já
seleciona `wss://` quando a página é HTTPS. Não há áudio nesse WebSocket.

A entrada exclusiva é necessária: um proxy conecta via loopback, e encaminhar para
8790 tornaria o token MCP local utilizável remotamente. Na entrada 8792, HTTP e WS
recusam o token de agente, mesmo com headers Forwarded forjados. A entrada local
original preserva o MCP. Não apontar o proxy para 8790, 8791, o IP da Ui16 ou outro
serviço. A habilitação é recusada em REAL/mock, antes da criação/conexão do mixer;
`--real` sobrepondo LAB também falha. Recusa LAN HTTP simultânea (`server.lan.enabled`).

A política de autenticação é vinculada à entrada por um hook global, antes dos
handlers: qualquer credencial HTTP inválida nessa entrada (inclusive token MCP)
recebe 401, mesmo em rota pública ou adicionada no futuro. As rotas leem somente o
principal autenticado pelo hook; `principalOf()` não recebe flags de segurança e
revalida a sessão antes do uso. WebSocket usa o mesmo autenticador da entrada para
o primeiro frame. A entrada local mantém autenticação MCP por loopback. A regra
não depende de cada endpoint lembrar como o proxy autentica.

A rota `POST /api/assistant/diagnose` usa esse mesmo contexto: token MCP pelo
proxy recebe 401 antes do diagnóstico; token MCP local continua autenticado,
mas recebe 403 pela autorização exclusiva do operador. Operador por PIN consulta
por HTTPS/WSS; músico recebe 403. Não há mudança no diagnóstico ou comandos.

O backend exige Host exatamente igual ao host:porta de `origin`; se houver Origin,
exige correspondência exata, inclusive protocolo e porta. `null`/origens externas
são recusadas antes do login ou Upgrade WS. Clientes nativos sem Origin continuam
possíveis, mas exigem PIN/token humano. Não há CORS permissivo, cookies ou token na
URL: bearer HTTP e primeiro frame `auth` no WS seguem existentes. Logout/expiração
derrubam WS, músicos mantêm limites do AUX e operações críticas mantêm E2.

Não se confia em `X-Forwarded-*`/`Forwarded` para identidade. Tentativas de PIN via
proxy compartilham o bucket `https-lab-proxy`, além do limite global existente:
isso impede evasão por headers, mas um aparelho pode bloquear temporariamente os
outros após erros. É um limite consciente desta etapa. Nenhum PIN, token ou corpo
é registrado pelo template; access log/admin API/autosave do Caddy estão desligados.
Respostas da entrada proxy têm `Cache-Control: no-store`. Logs operacionais do Caddy
podem conter IPs/hostname/caminhos em erros: proteger acesso local, não ligar debug,
request dumping ou access logs durante testes de autenticação. Não anexar HAR com
headers/frames, chaves ou PINs ao GitHub.

## Pré-requisitos e decisões manuais

1. Yoga Windows com Node 22+, dependências/builds do MixAI, PINs já configurados
   pelo procedimento E2 (`npm run pin -- operador` / `-- musico`). Não copiar PINs
   ou hashes para exemplos. Fechar servidores LAB duplicados antes de iniciar.
2. Usar Wi-Fi **privado da banda**, nunca rede pública/convidados. Ethernet só para
   Ui16; não habilitar compartilhamento de Internet, bridge, NAT ou rotas entre
   interfaces. Não mudar gateway/métrica automaticamente. Redes Wi-Fi/Ethernet com
   sub-redes sobrepostas precisam de avaliação manual antes do teste.
3. Consultas de diagnóstico, sem alteração: `ipconfig`, `Get-NetIPConfiguration`,
   `Get-NetConnectionProfile`, `Get-NetTCPConnection -State Listen`. Identificar
   separadamente IP do Yoga Wi-Fi, IP Ethernet e IP Ui16. Reservar IP Wi-Fi no DHCP
   com o administrador se necessário; não usar o IP da mesa no bind.
4. Escolher `mixai.home.arpa` (nome reservado para rede doméstica) e resolver via
   DNS do roteador privado para **IP Wi-Fi do Yoga**. Validar resolução no Android;
   editar hosts no Windows não configura DNS do celular. Não depender de `.local`
   ou nome curto do Windows sem testar o navegador. Android Private DNS pode impedir
   resolução interna; revisar manualmente, sem desligar proteções por script.
5. Caddy oficial para Windows (baseline testada: 2.10.2); conferir checksum SHA-512
   publicado na release antes de instalar em diretório local protegido. Não depende
   de Docker e não instala serviço automaticamente. Atualizações e revisão de versão
   são responsabilidade da implantação; testar novamente antes de trocar versão.
6. Certificado de servidor válido com SAN `DNS:mixai.home.arpa`, EKU serverAuth,
   cadeia completa e datas corretas. Para usar IP na URL seria preciso SAN IP
   correspondente; o nome estável evita reemissão a cada DHCP. Certificado confiável
   e resolução de nome são requisitos distintos.

## Certificados: confiança demonstrável, sem geração silenciosa

Solicitar certificado a uma CA interna administrada para o LAB. O operador deve
obter os arquivos e raiz pública por canal confiável, conferir fingerprint SHA-256
por outro canal e registrar validade/quem renova. Este PR **não gera** material de
implantação, instala CA ou entrega chave. Não usar `tls internal` (gera CA/chaves),
ACME automático, `mkcert -install` silencioso, flags inseguras ou ignorar alertas TLS.
Um certificado autofirmado não confiável não demonstra secure context.

Guardar chave privada e cadeia **fora do checkout**, por exemplo em diretório
privado do Windows cujo acesso fique restrito ao operador/Caddy; manter backup
protegido e nunca distribuir a chave. Só a raiz **pública** aprovada vai aos clientes:

- Windows: importar manualmente raiz em Autoridades de Certificação Raiz Confiáveis
  do usuário apropriado, usando gerenciador de certificados; validar cadeia no
  Edge/Chrome. Não importar uma CA cuja procedência/fingerprint não se confirmou.
- Android: Configurações → Segurança/Criptografia e credenciais → instalar certificado
  de CA (nomes variam por fabricante). Instalação requer decisão explícita do dono,
  pode mostrar alerta de monitoramento e pode ser proibida por MDM. Confirmar no
  **Chrome Android alvo** que a cadeia é aceita sem tela de exceção. Apps/WebViews
  podem usar outra política e não ficam validados por esse teste.
- Registrar nome/fingerprint da raiz e procedimento para removê-la depois do LAB em
  credenciais do usuário Android e repositório de certificados do Windows. Planejar
  renovação, revogação/substituição e remoção da raiz em caso de perda da chave.

Alternativa futura: domínio controlado e certificado público emitido por DNS-01,
com DNS interno apontando ao Yoga. Exige autorização separada, gestão de renovação
e credenciais DNS fora do projeto; não implica abrir porta de Internet. Não há
emissão/integração DNS/túnel nesta entrega. `home.arpa` não recebe certificado público.

## Instalação opcional no Yoga

Nenhum passo abaixo foi executado no Windows pelo agente. Fazer fora de evento,
com a Ui16 sem receber comandos deste teste.

1. Atualizar checkout, instalar dependências e executar `npm run build` e
   `npm run build:web`. Confirmar que o processo será `npm run serve:lab`.
2. Incorporar manualmente os campos de `config/https-lab/config.local.example.yaml`
   ao `config/config.local.yaml` existente, preservando demais valores. Ajustar
   `origin` ao nome/porta aprovados. Remover eventual `MIXAI_LAN_HOST` da sessão que
   iniciará o LAB (essa variável reativa LAN HTTP e será recusada). Configurar
   `ai.enabled: false`; não fornecer credenciais de serviços externos para este teste.
3. Abrir um terminal PowerShell local. Definir apenas caminhos públicos/configuração,
   substituindo exemplos pelo IP Wi-Fi verdadeiro e caminhos já provisionados:

   ```powershell
   $env:MIXAI_HTTPS_HOST = 'mixai.home.arpa'
   $env:MIXAI_HTTPS_PORT = '8443'
   $env:MIXAI_HTTPS_BIND = '192.168.50.20' # EXEMPLO: IP Wi-Fi do Yoga
   $env:MIXAI_HTTPS_UPSTREAM_PORT = '8792'
   $env:MIXAI_HTTPS_CERT = 'C:/MixAI-TLS/server-chain.pem'
   $env:MIXAI_HTTPS_KEY = 'C:/MixAI-TLS/server.key'
   ```

   As variáveis contêm caminhos, nunca conteúdo de chave. Não usar IP Ethernet,
   `0.0.0.0`, `::` ou curinga no bind. Elas não alteram as interfaces do Windows.
4. Em outro terminal iniciar `npm run serve:lab`. Confirmar modo LAB e entrada
   127.0.0.1:8792 no log; acesso HTTP local 127.0.0.1:8790 continua funcionando.
   Não iniciar `serve:real`. A porta REAL 8791 não participa do proxy.
5. No terminal das variáveis, conferir e iniciar explicitamente:

   ```powershell
   caddy validate --config config/https-lab/Caddyfile.example --adapter caddyfile
   caddy run --config config/https-lab/Caddyfile.example --adapter caddyfile
   ```

   O exemplo é usado diretamente com variáveis; não precisa colocar caminhos locais
   no Git. `auto_https off` evita emissão e redirect HTTP automático; TLS continua
   obrigatório via cert/chave explícitos. Admin API, persistência da configuração,
   HTTP/3/UDP e access log estão desligados. Sem listeners públicos de porta 80/443
   implícitos. Host e bind são verificados manualmente, não pelo servidor Node.
6. Se necessário, administrador cria **manualmente** regra Windows Firewall para
   TCP 8443 do executável Caddy, somente perfil Privado, endereço local Wi-Fi exato,
   interface Wi-Fi e origens restritas à sub-rede dos músicos. Negar perfil Público;
   não criar regra Any/Internet. Revisar regras Node/Caddy antigas que sejam amplas.
   8790/8791/8792 não devem receber conexão dos celulares. Não configurar UPnP,
   encaminhamento no roteador, túnel público ou serviço de publicação. Um bind
   privado sozinho não protege contra encaminhamento de porta configurado no roteador.
7. Confirmar listeners com `Get-NetTCPConnection -State Listen`: Node somente
   loopback; Caddy somente IPv4 Wi-Fi escolhido. Android deve conseguir acessar
   `https://mixai.home.arpa:8443`, mas não HTTP do Yoga:8790/8792, REAL:8791 ou o IP
   Ethernet. Rede com isolamento entre clientes/AP precisa de decisão manual do
   administrador; não contornar com túnel público.

## Validação Android/Windows e microfone (sem ativar voz)

Registrar SO, modelo, versão do Chrome, hostname/IP/porta, fingerprint e validade
do certificado, modo LAB, resultados e horário; não incluir segredos.

| Checagem | Esperado |
| --- | --- |
| Abrir HTTPS no Chrome Android e Edge/Chrome Windows | Cadeia/SAN válidos, sem exceção TLS |
| Inspecionar `window.isSecureContext` | `true` |
| Inspecionar `typeof navigator.mediaDevices?.getUserMedia` | `function` (não chamar automaticamente) |
| HTTP por IP LAN | Bloqueado pela topologia escolhida; não é alternativa para mic seguro |
| Login com PIN correto/incorreto | Perfil correto / erro, sem alteração de estado |
| DevTools Network → `/ws` | WSS, Upgrade 101 (HTTP/1.1), hello/snapshot; token só no primeiro frame |
| Músico tenta master/cenas/aprovação | Recusado conforme E2; usar apenas LAB simulado |
| Logout, expiração, queda Wi-Fi e reconexão | WS encerrado/reautenticação conforme E2, sem reenvio automático de comandos |
| Origem externa ou `Origin: null` | 403 na entrada proxy; token MCP não autentica ali |
| Painel de voz | Ausente, sem solicitação de microfone; flag E9A permanece OFF |

HTTPS é pré-requisito, não garantia de permissão: navegador, SO, política e hardware
podem bloquear microfone. Esta entrega verifica disponibilidade da API, **não pede
permissão nem captura áudio**. Teste real de `getUserMedia` requer uma etapa manual
posterior autorizada por gesto, seguida de `stream.getTracks().forEach(t => t.stop())`,
sem gravação/envio ou execução de comandos. Não habilitar E9A só para concluir E9B.
Se o Android não confiar na CA ou `isSecureContext` não for true, registrar bloqueio
e corrigir a cadeia/nome/relógio com administrador; não ignorar TLS.

## Testes automatizados e limites

- `npm test`: valida defaults, modo LAB, configuração, Host/Origin, autenticação
  humana, rejeição MCP mesmo com headers forjados, permissões e logout na entrada.
- `npm run test:https-lab`: integração **com Caddy real**, OpenSSL e servidor LAB,
  configurando `CADDY_BIN` para binário verificado. Não faz skip silencioso se faltar
  ferramenta. Gera CA/certificado/chaves efêmeros só em diretório temporário isolado
  do runner, confia nessa CA apenas por cliente TLS (`ca`), remove tudo ao encerrar.
  Exceção de teste prevista na issue; não é emissão de certificado de implantação,
  não instala CA global, não desliga validação TLS, não publica artefatos secretos.
  Testa HTTPS autenticado, cadeia não confiável rejeitada, WSS/Upgrade, WS/HTTP local,
  logout, sessão inválida, origem externa e restrições de perfil/agente.
- CI tem job Linux dedicado com Caddy 2.10.2 verificado por SHA-512 da release;
  Windows continua com testes do núcleo/UI/builds. Instalação Caddy/certificados no
  Windows e confiança Android são manuais, não simulados como aprovados no runner.
- Não se testam DNS real, firewall, múltiplas interfaces, suspensão do Android,
  confiança de CA no Chrome físico, latência Wi-Fi ou hardware Ui16 no executor Linux.

## Encerramento e reversão

Encerrar Caddy e LAB com Ctrl+C. Desabilitar `server.httpsLab.enabled` no arquivo
local e remover as variáveis de ambiente da sessão ao fechar o terminal. Desativar
manualmente a regra de firewall criada para o teste. Remover raízes de confiança
instaladas só para o LAB e material local conforme política do administrador;
revogar/substituir certificado se houver incidente. Voltar ao LAB HTTP local não
habilita microfone remoto. Não alterar a configuração de rede/mesa como parte disso.

Referências: [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[Caddy tls](https://caddyserver.com/docs/caddyfile/directives/tls),
[MDN secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts),
[MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia),
[RFC 8375 home.arpa](https://www.rfc-editor.org/rfc/rfc8375).
