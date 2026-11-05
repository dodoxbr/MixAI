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
                              trava de dono: data/owner-real.lock
                                             <lab-state.json>.lock
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
| `src/core/owner-lock.ts` | trava de dono (um processo por mesa e por arquivo de laboratório) |
| `src/pin.ts` | `npm run pin`: cadastra o PIN (grava só o hash) |

### Garantias de "um só dono"

1. **No processo:** o `ServerCore` tem um único `MixController`.
   - HTTP, WebSocket e as várias instâncias do Fastify (127.0.0.1 e Wi-Fi) usam o mesmo core.
   - Teste: o MCP e dois navegadores mexendo ao mesmo tempo usam **1** controlador.
2. **Entre processos:** uma trava de dono garante um processo por mesa.
   - Mesa real: `data/owner-real.lock`. Arquivo do laboratório: `<arquivo>.lock`.
   - Um segundo servidor (ou o console de testes) é recusado com mensagem clara.
   - A trava de um processo morto é reaproveitada.
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
[mixai-server] acesso só neste notebook (para os celulares, configure server.lan no config.yaml).
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

1. No Yoga, descubra o IP do Wi-Fi: `ipconfig`, adaptador "Wi-Fi", linha "Endereço IPv4".
2. Em `config/config.yaml`:
   ```yaml
   server:
     lan:
       enabled: true
       host: 192.168.0.20   # IP do Wi-Fi do NOTEBOOK (não o da mesa)
   ```
3. Reinicie o servidor. Ele passa a escutar em `127.0.0.1` **e** em `192.168.0.20`.
4. Na primeira vez, o Windows pergunta pelo firewall: permita **só em "Redes privadas"**.
5. No celular, na mesma rede Wi-Fi, abra `http://192.168.0.20:8790/api/hello`.
   - Responde um JSON com `"mode":"lab"`: a rede está ok.
   - A tela de verdade vem na E3; até lá o acesso é pela API.

O servidor recusa iniciar se `server.lan.host` for:
- `0.0.0.0`/`::` (todas as interfaces);
- um IP público ("não exponha à internet");
- o próprio IP da mesa;
- vazio.

**Não abra a porta no roteador.**

## Endpoints HTTP

O token vai sempre no cabeçalho `Authorization: Bearer <token>`. Não há cookies, então não há CSRF; o servidor também não envia cabeçalhos CORS.

| Método e rota | Quem | O que faz |
| --- | --- | --- |
| `GET /api/hello` | todos | `protocol`, `version`, `serverId`, `mode`, `model`, `link`, `musicianAux`, PINs configurados, medidores |
| `POST /api/login` `{pin}` | todos | `{token, role, serverId, expiresAt}`. 401 PIN errado, 429 bloqueado (`retry-after`), 503 sem PIN configurado |
| `POST /api/logout` | sessão | encerra a sessão (o WebSocket dela também cai) |
| `GET /api/state` | sessão | `{serverId, role, snapshot}`, já filtrado por perfil |
| `POST /api/command` `{requestId, targetMode?, command}` | sessão / assistente | `{serverId, requestId, duplicate, result}`. 403 `FORBIDDEN`, 409 `MODE_MISMATCH`, 401 sessão inválida |
| `GET /api/pending` | operador | cartões abertos |
| `POST /api/pending/:id/approve` `{requestId}` | **operador** | executa exatamente o comando pendente (o controlador ainda confere hash, revisões, validade e uso único) |
| `POST /api/pending/:id/reject` `{requestId}` | **operador** | recusa; a pendência deixa de valer |

**Comandos** (`command.type`; os mesmos verbos das tools):
- `status`, `list_names`, `mix_state {aux?}`, `history {limit?}`, `list_snapshots`;
- `set_level {channel, aux?, db?|deltaDB?}`, `set_mute {channels[], muted, aux?}`, `set_master {db?|deltaDB?}`;
- `undo {steps?}`, `load_snapshot {show, snapshot}`, `reset_lab` (só operador, só LAB).

Os comandos **não** têm campo de confirmação. Um `confirmationId`/`confirm` junto do comando é recusado com `FORBIDDEN`.

**`requestId`:**
- obrigatório, de 1 a 64 caracteres `[A-Za-z0-9._:-]`;
- o mesmo `requestId` do mesmo usuário devolve a **mesma resposta** com `duplicate: true` e **não executa de novo**, mesmo se chegar enquanto o primeiro ainda roda;
- a resposta fica guardada por 10 min.

O MCP repete uma vez, com o mesmo id, se a resposta se perder.

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

| Ação | Operador | Músico | Assistente (MCP) |
| --- | --- | --- | --- |
| Ver estado | tudo | só AUX 1 | tudo (tools) |
| Canais do PA, mutes do PA | sim | **não** | sim (com as travas) |
| Master | sim | **não** | sim, mas sempre vira pendência |
| AUX 1 (fones) | sim | **sim** | sim |
| Outros AUX | sim | não | sim |
| Snapshot, desfazer | sim | não | sim (snapshot sempre vira pendência) |
| Histórico | sim | não | sim (`get_action_log`) |
| Reset do laboratório | sim | não | não |
| **Aprovar/recusar pendência** | **sim** | **não** | **não** |

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
- Na mesa real o servidor responde `meters_unavailable`. A aquisição real fica para a **E6**.

## Ajuste pendente da E1

- `PendingStore.invalidateAll()` é chamado em todo reset do laboratório:
  - pelo `resetLab()` do controlador, mesmo sem nenhuma diferença;
  - pelo `resetToDefaults()` direto (o lote agora é emitido mesmo vazio).
- Qualquer pendência anterior responde `CONFIRMATION_STALE` ("o laboratório foi resetado").
- Testes de regressão:
  - no controlador (`wire-reset.test.ts`);
  - pelo servidor (`server.test.ts`: o cartão vira `invalidated` e a aprovação é recusada).

## Testes

**201 testes** (171 da E1 com o ajuste + 30 novos), verdes em 3 execuções seguidas. Cada commit foi verificado sozinho, numa cópia limpa (typecheck, testes e build). O CI roda no Ubuntu e no Windows.

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
| extras | estado da ligação propagado; logout derruba o WS; bloqueio de PIN; rede do Yoga; trava de dono; segredos fora dos logs; medidores simulados sem revisões |

## Riscos remanescentes

| Risco | Impacto | Mitigação / próximo passo |
| --- | --- | --- |
| HTTP sem TLS na rede local | quem estiver no mesmo Wi-Fi pode capturar o PIN ou o token | rede da banda, sem internet exposta; PIN curto e trocável. Avaliar TLS autoassinado na E3 só se for preciso (complica os celulares) |
| PIN de 4 dígitos | adivinhável sem bloqueio | bloqueio progressivo por aparelho e geral; use 6+ dígitos para o operador |
| Firewall do Windows | celulares não acessam | permitir só em "Redes privadas" na primeira execução (documentado) |
| IP do Wi-Fi muda (DHCP) | o servidor não sobe com o `lan.host` antigo | reservar o IP no roteador, ou usar `MIXAI_LAN_HOST` na hora |
| O servidor cai durante o show | o MCP e as telas ficam sem controle | a mesa continua com o último ajuste; a interface oficial da Soundcraft é o plano B. Reiniciar = novas sessões (novo login) |
| O assistente fica sem saber da aprovação | ele não recebe aviso ativo | ele confere com `get_mix_state`/`get_action_log`. A tela da E3 mostra o resultado ao operador |
| Token do assistente é um arquivo local | outro programa do mesmo usuário poderia usá-lo | permissão 600 e só de `127.0.0.1`; o assistente nunca aprova pendências |
| Cache de `requestId` em memória | depois de reiniciar, um id repetido executaria de novo | as sessões também caem no reinício, e o MCP relê o token antes de repetir |
| Mesa real não testada com o servidor | comportamento em hardware | o caminho até o `RealMixer` é o mesmo da E0/E1 (`createApp`); validar na F0 com a Ui16 antes de qualquer show |

## Fora do escopo (não implementado)

- Interface Angular, faders e componentes visuais (E3).
- IA por API (E4) e voz (E9).
- EQ visual (E7).
- LAB → REAL.
- Medidores reais (E6).
- Novos controles físicos da Ui16.
