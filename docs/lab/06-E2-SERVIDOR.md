# 06 — E2: servidor único (HTTP/WebSocket) e MCP como cliente

**Data:** 05/11/2026 · **Versão:** 0.4.0 · **Branch:** `e2-unified-server` · Base: `main` após o merge da E1 (`34dc5e9`).

## Resumo

- Um **processo servidor** é o dono de tudo:
  - o `MixController`;
  - a mesa (`LabMixer` ou `RealMixer`);
  - o estado observável e a fila;
  - as confirmações;
  - os usuários e o histórico.
- O modo (LAB/REAL) é fixado na inicialização.
- O **MCP do Claude Desktop virou cliente HTTP** desse servidor:
  - não monta mesa, laboratório nem controlador;
  - sem servidor, responde `SERVER_UNAVAILABLE`;
  - as **11 tools** continuam com os mesmos nomes e parâmetros.
- **Confirmação humana de verdade.**
  - Uma operação crítica vira um **cartão pendente**.
  - Só um **operador autenticado por PIN** aprova ou recusa, por um canal próprio (`approve`/`reject`).
  - O assistente pode propor, mas não confirma, nem conhecendo o `pendingId`.
- Ajuste pendente da E1: o **reset do laboratório invalida todas as pendências**, inclusive as de parâmetros que não mudaram.

## Arquitetura

```
 Claude Desktop ──stdio──▶ dist/index.js (MCP)  ─┐
                                                 │  HTTP 127.0.0.1 + token local do assistente
 Navegador do Yoga ─────── HTTP + WebSocket ─────┤
 Celulares (Wi-Fi) ─────── HTTP + WebSocket ─────┤  (só se server.lan estiver configurado)
                                                 ▼
                         dist/serve.js  (servidor único, 1 processo)
                         ┌──────────────────────────────────────────┐
                         │ Fastify (1 instância por endereço)       │
                         │   └─ ServerCore (UM só)                  │
                         │        ├─ Auth (PIN → perfil; sessões)   │
                         │        ├─ autorização por perfil         │
                         │        ├─ requestId (sem repetição)      │
                         │        ├─ pendências → cartões           │
                         │        ├─ medidores simulados (LAB)      │
                         │        └─ MixController (E0/E1)          │
                         │             └─ LabMixer │ RealMixer      │
                         └──────────────────────────────────────────┘
                              trava de dono: ~/.mixai/locks/mesa-real.lock (por computador)
                                             <lab-state.json>.lock (por arquivo)
```

| Arquivo | Papel |
| --- | --- |
| `src/serve.ts` | processo servidor (`npm run serve:lab` / `serve:real`) |
| `src/server/start.ts` | sobe tudo: trava de dono, mesa, autenticação, escuta, token do assistente |
| `src/server/core.ts` | `ServerCore`: comandos, `requestId`, pendências/cartões, filtros por perfil |
| `src/server/http.ts` | rotas REST e protocolo WebSocket |
| `src/server/commands.ts` | comandos aceitos (zod), autorização por perfil, despacho ao controlador |
| `src/server/auth.ts`, `pin.ts` | PIN (scrypt), sessões, token do assistente, bloqueio de tentativas |
| `src/server/listen.ts` | endereços de escuta (127.0.0.1 + Wi-Fi opcional) |
| `src/server/meters.ts` | medidores **simulados** (LAB) |
| `src/client/state-sync.ts` | cliente de referência da sincronização (a E3 faz igual) |
| `src/mcp/remote.ts`, `backend.ts` | MCP como cliente HTTP |
| `src/core/owner-lock.ts` | trava de dono (uma mesa real por computador, compartilhada entre instalações; uma por arquivo de laboratório) |
| `src/pin.ts` | `npm run pin`: cadastra o PIN (grava só o hash) |

### Garantias de "um só dono"

1. **No processo:** o `ServerCore` tem um único `MixController`.
   - HTTP, WebSocket e as várias instâncias do Fastify (127.0.0.1 e Wi-Fi) usam o mesmo core.
   - Teste: o MCP e dois navegadores mexendo ao mesmo tempo usam **1** controlador.
2. **Entre processos e entre instalações:** uma trava de dono garante um processo por mesa.
   - Mesa real: `~/.mixai/locks/mesa-real.lock`, **uma por computador**, na pasta do usuário. Não depende da pasta da instalação: duas cópias do projeto (ex.: `C:\Desenvolvimento\mixai` e outra) não abrem a mesa ao mesmo tempo.
   - Não é por IP de propósito: a mesma Ui16 pode ser alcançada pelo cabo e pelo Wi-Fi da própria mesa, com IPs diferentes. A trava guarda o equipamento (`mesa ui16 em 10.10.1.1`), a instalação e o pid, e a mensagem de recusa mostra isso.
   - Arquivo do laboratório: `<arquivo>.lock` (caminho absoluto).
   - `MIXAI_LOCK_DIR` muda a pasta das travas (testes).
   - Um segundo servidor (ou o console de testes) é recusado com mensagem clara.
   - A trava de um processo morto é reaproveitada, com exclusão mútua: só quem estiver com o "mutex de tomada" (`<trava>.takeover`, também exclusivo) pode apagá-la, depois de reler e confirmar que continua abandonada. O ganhador ainda relê a trava após 60 ms e desiste se ela não for mais a sua. Testado com 6 processos separados ao mesmo tempo: exatamente um ganha (a versão anterior deixava dois donos em 5 de 5 rodadas).
   - Portas diferentes por modo (8790 e 8791) evitam confusão.
3. **O MCP não tem como abrir a mesa:**
   - `index.ts` não importa a mesa, o laboratório nem o controlador. Teste: carregar o cliente MCP não carrega nenhum desses módulos.
   - O token do assistente só vale vindo de `127.0.0.1`.
4. **LAB nunca vira REAL:**
   - todo comando do MCP leva `targetMode`, e o servidor recusa outro modo com `MODE_MISMATCH` (HTTP 409);
   - no LAB, o código da mesa real e a biblioteca da Soundcraft nem são carregados.

## Como iniciar em modo LAB

```bash
npm install
npm run build
npm run pin -- operador   # 4 a 8 dígitos; grava só o hash em config/secrets.yaml
npm run pin -- musico     # opcional; precisa ser diferente do PIN do operador
npm run serve:lab         # http://127.0.0.1:8790
```

Saída esperada:

```
[mixai-server] modo: LABORATÓRIO (.../data/lab-state.json)
[mixai-server] Laboratório pronto (sem conexão com a mesa física)
[mixai-server] escutando em http://127.0.0.1:8790
[mixai-server] acesso só neste notebook (para os celulares, configure server.lan no config/config.local.yaml).
```

**Claude Desktop:**
- o `claude_desktop_config.json` continua igual (`dist/index.js` com `MIXAI_MODE=lab`);
- o servidor precisa estar rodando antes;
- sem ele, o assistente responde que o servidor não está disponível e não mexe em nada.

**Mesa real:**
- `npm run serve:real` (porta 8791);
- no Claude Desktop, `MIXAI_MODE=real`.

**Variáveis úteis:**
- `MIXAI_PORT`, `MIXAI_LAN_HOST`;
- `MIXAI_DATA_DIR`;
- `MIXAI_OPERATOR_PIN_HASH` e `MIXAI_MUSICIAN_PIN_HASH` (hash, nunca o PIN).

## Conectar um segundo dispositivo pela rede local (Yoga)

No show, o Yoga usa **Ethernet para a Ui16** e **Wi-Fi para os celulares**. São duas redes e dois endereços diferentes:

| Endereço | O que é | Onde vai |
| --- | --- | --- |
| IP da mesa (ex.: `10.10.1.1`, no cabo) | a Ui16 | `mixer.ip` |
| IP do **Wi-Fi do notebook** (ex.: `192.168.0.20`) | onde os celulares acessam o MixAI | `server.lan.host` |

O IP do Wi-Fi **não fica no código nem no `config.yaml` do repositório**: cada máquina põe o seu no `config/config.local.yaml` (fora do Git). Assim o `git pull` nunca dá conflito.

### 1. Descubra o IPv4 do Wi-Fi do Yoga

No PowerShell (não precisa ser administrador):

```powershell
Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi" | Select-Object IPAddress
```

Ou `ipconfig` → adaptador **"Adaptador de Rede sem Fio Wi-Fi"** → linha **"Endereço IPv4"** (ex.: `192.168.0.20`). Não use o endereço do adaptador **Ethernet**: esse é o da rede da mesa.

### 2. Reserve esse IP no roteador (recomendado)

Sem reserva, o roteador pode dar outro IP ao Yoga no dia seguinte, e o servidor recusa subir com o `lan.host` antigo.

1. Descubra o endereço físico (MAC) do Wi-Fi: `Get-NetAdapter -Name "Wi-Fi" | Select-Object MacAddress` (ou `ipconfig /all` → "Endereço Físico").
2. Entre na página do roteador (normalmente `http://192.168.0.1` ou `http://192.168.1.1`, usuário e senha na etiqueta).
3. Procure **"Reserva de DHCP"**, "Endereço IP estático", "DHCP Reservation" ou "Address Reservation" (o nome muda por fabricante).
4. Associe o MAC do Yoga a um IP fixo da faixa da rede (ex.: `192.168.0.20`) e salve. Reinicie o Wi-Fi do Yoga.
5. Sem acesso ao roteador: use `MIXAI_LAN_HOST` na hora (`$env:MIXAI_LAN_HOST="192.168.0.20"; npm run serve:lab`).

### 3. Crie o `config/config.local.yaml`

```powershell
Copy-Item config\config.local.example.yaml config\config.local.yaml
notepad config\config.local.yaml
```

Deixe só o que muda nesta máquina:

```yaml
server:
  lan:
    enabled: true
    host: "192.168.0.20"   # IPv4 do Wi-Fi do NOTEBOOK (não o da mesa)
```

Ao subir, o servidor mostra `configuração local aplicada: ...config.local.yaml` e passa a escutar em `127.0.0.1` **e** no IP do Wi-Fi.

### 4. Rede **Privada** e firewall (PowerShell como administrador)

Estes dois passos mudam configurações do Windows e **exigem o PowerShell aberto como administrador** (menu Iniciar → "PowerShell" → botão direito → **Executar como administrador**). Sem isso, o Windows responde "Acesso negado".

a) Marque a rede Wi-Fi da banda como **Privada** (o Windows trata redes "Públicas" como não confiáveis e bloqueia conexões de entrada):

```powershell
Get-NetConnectionProfile            # veja o "Name" da rede Wi-Fi e o NetworkCategory
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private
```

Pela interface: Configurações → Rede e Internet → Wi-Fi → (a rede) → Tipo de perfil de rede → **Rede privada**.

b) Libere a porta do LAB **só em redes privadas**:

```powershell
New-NetFirewallRule -DisplayName "MixAI LAB" -Direction Inbound -Protocol TCP -LocalPort 8790 -Profile Private -Action Allow
```

Recomendado: restrinja também à **sub-rede local** confiável, para a regra nunca valer fora dela:

```powershell
Set-NetFirewallRule -DisplayName "MixAI LAB" -RemoteAddress LocalSubnet
```

Conferir e desfazer:

```powershell
Get-NetFirewallRule -DisplayName "MixAI LAB" | Format-List DisplayName, Enabled, Profile, Direction, Action
Remove-NetFirewallRule -DisplayName "MixAI LAB"
```

Se na primeira execução aparecer a janela do firewall pedindo permissão para o Node.js, marque **só "Redes privadas"**. A regra da mesa real (porta `8791`) é a mesma com outro nome e porta, e **só deve ser criada quando o modo REAL pela rede for liberado** (ver "Segurança da rede").

### 5. Teste no celular

No celular, **no mesmo Wi-Fi**, abra `http://192.168.0.20:8790` (troque pelo IP do Yoga). Deve aparecer a tela de PIN. Se não abrir:
- confira se o Wi-Fi do Yoga está como **Privada** (`Get-NetConnectionProfile`);
- confira a regra (`Get-NetFirewallRule -DisplayName "MixAI LAB"`);
- confira o IP (passo 1) e o `config.local.yaml` (passo 3);
- celular e Yoga precisam estar na mesma rede (Wi-Fi de convidados costuma isolar aparelhos).

### Migrar uma configuração local antiga (quem editou o `config.yaml`)

Se você já tinha mudado o `config/config.yaml` no Yoga (IP do Wi-Fi, porta, etc.), mova essas mudanças para o arquivo local **antes** do `git pull`, sem perder nada:

```powershell
git diff config/config.yaml > minhas-mudancas.txt     # guarda o que você mudou
notepad minhas-mudancas.txt                            # veja as linhas com "+"
Copy-Item config\config.local.example.yaml config\config.local.yaml
notepad config\config.local.yaml                      # copie para cá SÓ os valores que você mudou
git checkout -- config/config.yaml                     # volta o config.yaml ao do repositório
git pull
npm ci; npm run build; npm run build:web
npm run serve:lab                                      # deve mostrar "configuração local aplicada"
```

- Copie a **seção inteira** de cada valor (ex.: `server:` → `lan:` → `host:`), não só a linha.
- Nada de PIN nem chave da API no `config.local.yaml`: o servidor recusa subir com segredos ali. PINs continuam no `config/secrets.yaml` (`npm run pin`); a chave, no `secrets.yaml` ou em `ANTHROPIC_API_KEY`.
- O `config/channels.yaml` (nomes da banda) não muda.

O servidor recusa iniciar se `server.lan.host` for:
- `0.0.0.0`/`::` (todas as interfaces);
- um IP público ("não exponha à internet");
- o próprio IP da mesa;
- vazio.

**Não abra a porta no roteador.**

### Segurança da rede: leia antes de ligar `server.lan`

- O padrão é **só `127.0.0.1`**: nada sai do notebook. Continue assim sempre que der.
- **HTTP e WebSocket sem TLS não protegem PINs e tokens contra interceptação.** Na rede local, qualquer aparelho conectado ao mesmo Wi-Fi que consiga capturar o tráfego pode ver o PIN no login e o token das sessões, e usá-los.
- **No modo REAL pela rede, use uma rede privada dedicada e confiável** (ex.: um roteador só da banda, com senha WPA2/WPA3 forte, sem convidados e sem internet), até o MixAI adotar transporte criptografado. Nunca use Wi-Fi do bar, do evento ou público.
- No modo LAB o risco é menor (não há mesa física), mas o PIN vazado é o mesmo do show: troque-o (`npm run pin`) se o laboratório foi usado numa rede não confiável.
- Use PIN do operador com 6 dígitos ou mais. Reiniciar o servidor derruba todas as sessões.

## Endpoints HTTP

O token vai sempre no cabeçalho `Authorization: Bearer <token>`. Não há cookies, então não há CSRF; o servidor também não envia cabeçalhos CORS.

| Método e rota | Quem | O que faz |
| --- | --- | --- |
| `GET /api/hello` | todos | `protocol`, `version`, `serverId`, `mode`, `model`, `link`, `musicianAux`, PINs configurados, medidores |
| `POST /api/login` `{pin}` | todos | `{token, role, serverId, expiresAt}`. 401 PIN errado, 429 bloqueado (`retry-after`), 503 sem PIN configurado |
| `POST /api/logout` | sessão | encerra a sessão (o WebSocket dela também cai) |
| `GET /api/state` | sessão | `{serverId, role, snapshot}`, já filtrado por perfil |
| `POST /api/command` `{requestId, serverId?, targetMode?, command}` | sessão / assistente | `{serverId, requestId, duplicate, result}`. 403 `FORBIDDEN`, 409 `MODE_MISMATCH` ou `SERVER_CHANGED`, 401 sessão inválida |
| `GET /api/pending` | operador | cartões abertos |
| `POST /api/pending/:id/approve` `{requestId, serverId?}` | **operador** | executa exatamente o comando pendente (o controlador ainda confere hash, revisões, validade e uso único) |
| `POST /api/pending/:id/reject` `{requestId, serverId?}` | **operador** | recusa; a pendência deixa de valer |

**Comandos** (`command.type`; os mesmos verbos das tools):
- `status`, `list_names`, `mix_state {aux?}`, `history {limit?}`, `list_snapshots`;
- `set_level {channel, aux?, db?|deltaDB?}`, `set_mute {channels[], muted, aux?}`, `set_master {db?|deltaDB?}`;
- `undo {steps?}`, `load_snapshot {show, snapshot}`, `reset_lab` (só operador, só LAB).

Os comandos **não** têm campo de confirmação. Um `confirmationId`/`confirm` junto do comando é recusado com `FORBIDDEN`.

**`requestId`:**
- obrigatório, de 1 a 64 caracteres `[A-Za-z0-9._:-]`;
- o mesmo `requestId` do mesmo usuário devolve a **mesma resposta** com `duplicate: true` e **não executa de novo**, mesmo se chegar enquanto o primeiro ainda roda;
- a resposta fica guardada por 10 min, **só na memória daquela instância** do servidor.

**`serverId` no pedido (proteção contra reinício):**
- Se o pedido traz `serverId` e o servidor é outra instância (reiniciou), ele é recusado com `SERVER_CHANGED` (HTTP 409) **sem executar**.
- O MCP sempre manda o `serverId` (lido em `/api/hello` antes do primeiro envio). Se a resposta se perder (timeout, conexão caiu), ele repete com o **mesmo** `requestId` na **mesma** instância: o servidor devolve a resposta guardada, sem executar de novo.
- Se nesse meio-tempo o servidor reiniciou, a repetição é recusada (`SERVER_CHANGED`/401) e o MCP devolve **`INDETERMINATE`**: "a alteração PODE ter sido aplicada; não repita, confira o estado". Uma escrita **nunca** é repetida numa instância nova, e o MCP nunca diz "nada foi alterado" quando o pedido pode ter chegado.
- Recusas que provam que nada foi executado (401 ou `SERVER_CHANGED` antes de qualquer envio incerto) são refeitas com segurança na instância nova. Consultas podem ser repetidas livremente.

## Protocolo WebSocket (`/ws`)

1. O cliente abre a conexão e manda `{"type":"auth","token":"..."}`.
   - O token nunca vai na URL.
   - Sem autenticação em 5 s, a conexão fecha com o código **4401**.
2. O servidor manda, nesta ordem e no mesmo ciclo:
   - `hello` (com `serverId`, `mode` e `role`);
   - `snapshot`;
   - para o operador, `pending_list`;
   - só depois os `event`.
   - Assim nenhum evento escapa entre o snapshot e a assinatura.
3. Eventos: `{"type":"event","serverId":"...","event":{...}}`.
   - `event.type = "params"` traz `fromRevision`, `revision` e `changes[]`.
   - `event.type = "link"` traz `link` e `available`.
   - Os valores usam o formato de transmissão da E1:
     - `{"status":"known","value":-10}`;
     - `{"status":"known","value":"-inf"}` (−∞);
     - `{"status":"unknown"}`;
     - `{"status":"unavailable"}`.
4. Regras do cliente (ver `StateSync`):
   - só aplicar eventos sobre um snapshot do **mesmo `serverId`**;
   - `serverId` diferente (servidor reiniciado): descartar tudo e esperar snapshot;
   - `fromRevision` diferente da revisão local (evento perdido): mandar `{"type":"resync"}`;
   - leitura voltando depois de `unavailable`: mandar `resync`.
5. Mensagens do cliente:
   - `command {requestId, targetMode?, command}` → `result`;
   - `approve {requestId, pendingId}` / `reject` → `result`;
   - `resync` → `snapshot`;
   - `meters {on, hz?}`;
   - `ping` → `pong`.
6. Códigos de fechamento:
   - **4401**: sem sessão ou servidor reiniciado; entre de novo com o PIN;
   - **4400**: mensagem fora do protocolo;
   - qualquer outro (servidor desligado, rede caiu): reconectar e refazer o passo 1.

**Músico:**
- o snapshot e os eventos dele só têm os parâmetros do AUX 1;
- os eventos do PA chegam com `changes: []`, para a sequência de revisões continuar íntegra sem expor valores.

### Contrato dos cartões de confirmação (para a E3)

```jsonc
// para os operadores, quando uma pendência é criada
{ "type": "pending", "serverId": "...", "card": {
    "pendingId": "a1b2c3d4", "status": "open",
    "title": "volume do master",
    "summary": "Mudar o MASTER (som geral) de -6 dB para -8 dB.",
    "command": { "type": "set_master", "deltaDB": -2 },
    "requestedBy": { "role": "agent", "label": "assistente (MCP)" },
    "createdAt": "2026-11-05T22:10:00.000Z", "expiresAt": "2026-11-05T22:11:00.000Z" } }

// para os operadores e para quem pediu, quando ela se resolve
{ "type": "pending_resolved", "serverId": "...", "pendingId": "a1b2c3d4",
  "status": "approved" | "rejected" | "expired" | "invalidated" | "failed",
  "by": "operador", "result": { "ok": true, "code": "OK", "message": "..." } }
```

**Estados de uma pendência:**
- `invalidated`: a mesa mudou ou o laboratório foi resetado;
- `expired`: passaram os 60 s.

O servidor confere as pendências a cada segundo e avisa as telas.

## Perfis (autorização sempre no servidor)

O perfil músico tem duas políticas (`server.musicianAccess`, padrão `fones_only`; detalhes em `09-AJUSTES-YOGA.md`):

| Ação | Operador | Músico `fones_only` (padrão) | Músico `pa_without_master` | Assistente (MCP) |
| --- | --- | --- | --- | --- |
| Ver estado | tudo | só AUX 1 | AUX 1 + canais do PA (nunca master, EQ/HPF) | tudo (tools) |
| Volume dos canais no PA | sim | **não** | em passos de até 3 dB; acima: **pendência** do operador; sem arraste | sim (com as travas) |
| Mute no PA | sim | **não** | um canal por vez | sim (com as travas) |
| Master | sim | **não** | **não** | sim, mas sempre vira pendência |
| AUX 1 (fones) | sim | **sim** | **sim** | sim |
| Outros AUX | sim | não | não | sim |
| Snapshot / cenas | sim | não | não | sim, mas sempre vira pendência |
| Desfazer | sim | não | não | os próprios ajustes simples: direto. Master, alteração crítica (master, passo grande, mute em grupo) ou alteração feita por uma pessoa: **vira pendência** |
| Histórico | sim | não | não | sim (`get_action_log`) |
| Reset do laboratório | sim | não | não | não |
| **Aprovar/recusar pendência** | **sim** | **não** | **não** | **não** |

Cada alteração fica no histórico com **perfil + sessão** (`músico · sessão 3fa2c1`; aprovações: `...; aprovado por operador · sessão ...`). O PIN do músico é compartilhado, então a sessão identifica um login/aparelho, não uma pessoa.

**Autenticação e segredos:**
- **PIN:** de 4 a 8 dígitos.
  - Fica gravado só como hash **scrypt** em `config/secrets.yaml` (no `.gitignore`).
  - Operador e músicos precisam de PINs diferentes.
- **Sessões:** o token tem 256 bits e o servidor guarda só o SHA-256 dele, em memória.
  - Vale 12 h (`server.sessionHours`).
  - Reiniciar o servidor invalida todas as sessões.
- **Token do assistente:**
  - é gerado a cada início e gravado em `data/agent-<modo>.token` (pasta fora do Git, permissão 600);
  - é apagado ao desligar;
  - só é aceito de `127.0.0.1`.
- **Tentativas de login:**
  - 5 erros do mesmo aparelho bloqueiam por 30 s, e o bloqueio dobra a cada novo erro, até 15 min;
  - 30 erros por minuto somando todos os aparelhos bloqueiam o login por 1 min.
- **Logs:** não têm PIN nem token. Registram as recusas (`server_forbidden`, `server_login_failed`, `server_confirmation_refused`...) com o perfil e o endereço.

## Medidores

- Mensagem `meters` no WebSocket, só para quem pede (`{"type":"meters","on":true,"hz":10}`), de 1 a 15 Hz.
- No LAB os quadros são **simulados** e dizem isso: `"simulated": true, "source": "lab"`.
  - São derivados do fader e do mute, com variação.
  - **Não representam o som** nem imitam a medição da Ui16.
- Ficam totalmente fora do estado: não geram revisões nem eventos de parâmetros.
- **Músico não recebe medidores:** os quadros existentes são do PA e do master, e o músico só pode ver o AUX 1. O pedido responde `meters_unavailable` com `code: "FORBIDDEN"` até existir medição específica do AUX 1.
- Na mesa real o servidor responde `meters_unavailable`. A aquisição real fica para a **E6**.

## Desfazer protegido

- Cada entrada do desfazer guarda **quem pediu** (operador, músico ou assistente) e se foi **crítica** (mexeu no master ou precisou de aprovação: passo grande, mute em grupo).
- Antes de desfazer, o controlador mostra ao servidor o que vai ser revertido. Se o pedido é do **assistente** e alguma entrada é crítica, mexe no master ou foi feita por uma pessoa, o desfazer vira **pendência** (cartão) e só o operador aprova.
- A pendência fica presa às entradas exatas da pilha e às revisões dos parâmetros: se alguém mexer antes da aprovação, ela fica obsoleta (`CONFIRMATION_STALE`).
- Desfazer os próprios ajustes simples do assistente continua direto. O operador desfaz direto (ele é o humano).

## Sessões revogadas no WebSocket

- Todo envio de uma sessão autenticada (eventos, cartões, resoluções, medidores, respostas) passa por uma verificação da sessão **antes** de sair.
- Logout derruba a conexão na hora (aviso interno de revogação). Sessão vencida é conferida a cada segundo, então uma conexão **ociosa** também cai (código 4401), e nada mais é enviado a ela.

## Ajuste pendente da E1

- `PendingStore.invalidateAll()` é chamado em todo reset do laboratório:
  - pelo `resetLab()` do controlador, mesmo sem nenhuma diferença;
  - pelo `resetToDefaults()` direto (o lote agora é emitido mesmo vazio).
- Qualquer pendência anterior responde `CONFIRMATION_STALE` ("o laboratório foi resetado").
- Testes de regressão:
  - no controlador (`wire-reset.test.ts`);
  - pelo servidor (`server.test.ts`: o cartão vira `invalidated` e a aprovação é recusada).

## Testes

**226 testes** (171 da E1 com o ajuste + 30 da primeira entrega da E2 + 25 das correções da revisão), verdes em 3 execuções seguidas. Cada commit foi verificado sozinho, numa cópia limpa (typecheck, testes e build). O CI roda no Ubuntu e no Windows.

| Exigência | Onde |
| --- | --- |
| dois clientes WS recebem a mesma alteração | `server.test.ts` |
| cliente reconecta e recupera o estado | `server.test.ts` |
| evento perdido → ressincronização | `server.test.ts` (o cliente "perde" um evento, detecta o buraco e pede snapshot) |
| `requestId` repetido não executa duas vezes | `server.test.ts` (HTTP simultâneo, em sequência e pelo WS) |
| músico no master ou no PA: recusado | `server.test.ts` (9 comandos proibidos; nada muda) |
| músico no AUX 1: permitido | `server.test.ts` (e só vê o AUX 1; eventos do PA chegam vazios) |
| MCP confirmando a própria operação: recusado | `server.test.ts` e `server-isolation.test.ts` (pelo comando e pelo canal de aprovação) |
| operador autenticado confirma: permitido | `server.test.ts` (cartão, aprovação, aviso de resolução) |
| expirada, reutilizada, obsoleta: recusada | `server.test.ts` |
| reinício invalida sessões e sincronização | `server-isolation.test.ts` |
| LAB recusa ser direcionado ao REAL | `server-isolation.test.ts` (HTTP e MCP; a mesa real nem é carregada) |
| MCP sem servidor: erro claro, sem conexão física | `mcp-client.test.ts` (nada da mesa, do laboratório nem do controlador é carregado) |
| reset invalida todas as pendências | `wire-reset.test.ts` e `server.test.ts` |
| clientes sem vários controladores | `server-isolation.test.ts` (MCP e 2 navegadores = **1** controlador) |
| **revisão:** escrita não repetida após reinício | `remote-retry.test.ts` (executa e reinicia antes de responder → `INDETERMINATE`, aplicado uma vez; reinício antes do envio → refeito com segurança; timeout e resposta perdida na mesma instância → uma execução) |
| **revisão:** desfazer crítico | `undo-approval.test.ts` (master do operador e do assistente, passo grande, ajuste do operador, vários passos, obsoleta; autoaprovação recusada) |
| **revisão:** WebSocket revogado | `ws-auth.test.ts` (logout e vencimento com conexão ociosa; nenhum cartão após vencer; músico sem medidores) |
| **revisão:** trava entre instalações | `owner-lock.test.ts` (processos separados: duas instalações, 6 simultâneos, trava abandonada disputada por 6) |
| extras | estado da ligação propagado; logout derruba o WS; bloqueio de PIN; rede do Yoga; trava de dono; segredos fora dos logs; medidores simulados sem revisões |

## Riscos remanescentes

| Risco | Impacto | Mitigação / próximo passo |
| --- | --- | --- |
| HTTP/WebSocket sem TLS na rede local | quem estiver no mesmo Wi-Fi pode capturar o PIN ou o token e controlar a mesa | padrão só `127.0.0.1`; com `server.lan`, rede privada dedicada e confiável (ver "Segurança da rede"); PIN trocável. Transporte criptografado a decidir numa etapa futura |
| PIN de 4 dígitos | adivinhável sem bloqueio | bloqueio progressivo por aparelho e geral; use 6+ dígitos para o operador |
| Firewall do Windows | celulares não acessam | rede Wi-Fi como Privada e regra `New-NetFirewallRule ... -Profile Private` (PowerShell como administrador), restrita à sub-rede local (documentado) |
| IP do Wi-Fi muda (DHCP) | o servidor não sobe com o `lan.host` antigo | reservar o IP no roteador (passo 2), ou usar `MIXAI_LAN_HOST` na hora |
| O servidor cai durante o show | o MCP e as telas ficam sem controle | a mesa continua com o último ajuste; a interface oficial da Soundcraft é o plano B. Reiniciar = novas sessões (novo login) |
| O assistente fica sem saber da aprovação | ele não recebe aviso ativo | ele confere com `get_mix_state`/`get_action_log`. A tela da E3 mostra o resultado ao operador |
| Token do assistente é um arquivo local | outro programa do mesmo usuário poderia usá-lo | permissão 600 e só de `127.0.0.1`; o assistente nunca aprova pendências |
| Resposta perdida + reinício do servidor | não dá para saber se a escrita foi aplicada | o MCP devolve `INDETERMINATE` e não repete; o assistente confere o estado antes de pedir de novo |
| Mesma Ui16 em dois computadores diferentes | duas instâncias controlando a mesma mesa | a trava é por computador; entre computadores não há como travar. Regra de uso: só o Yoga controla a mesa no show |
| Mesa real não testada com o servidor | comportamento em hardware | o caminho até o `RealMixer` é o mesmo da E0/E1 (`createApp`); validar na F0 com a Ui16 antes de qualquer show |

## Fora do escopo (não implementado)

- Interface Angular, faders e componentes visuais (E3).
- IA por API (E4) e voz (E9).
- EQ visual (E7).
- LAB → REAL.
- Medidores reais (E6).
- Novos controles físicos da Ui16.
