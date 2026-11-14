# Ui16 — MUTE individual, Mute All, Force Unmute e MUTE efetivo (somente leitura)

**Nenhuma escrita.** Esta entrega só *observa*: não implementa escrita em grupos de mute, Force Unmute ou Mute All, não envia SETD e não altera gates, permissões, executor ou o contrato `state` existente. O MUTE individual (`i.N.mute`, e `i.N.aux.A.mute` no AUX SENDS) continua sendo lido e exibido exatamente como antes.

## Evidência

Leitura crua da Ui16 física (cliente somente leitura, 2026-11-14):

| Campo | Valor observado | Leitura |
|---|---|---|
| `mgmask` (global) | `8388608` | bit 23 ligado |
| `i.N.mute` | CH1, CH2, CH5–CH11 = 1; CH3, CH4 = 0 | MUTE individual |
| `i.N.forceunmute` | CH2 = 1, CH3 = 1; demais = 0 | Force Unmute |
| `i.N.mgmask` | 0 em todos | **não usado** (semântica não validada) |

Da biblioteca `soundcraft-ui-connection@7.1.0` (`index.mjs`): `muteGroup('all')` usa o **bit 23** de `mgmask`; grupos 1–6 = bits 0–5; FX = bit 22; `clearMuteGroups()` zera `mgmask`. A interface oficial mostra o MUTE **efetivo** (por isso não coincidia com o `i.N.mute` quando o Mute All estava ativo); os MUTE azul-claros da captura eram exatamente CH2 e CH3, os dois com `forceunmute = 1`.

**Não validado fisicamente (portanto nunca presumido):** a precedência do Force Unmute sobre o MUTE individual e sobre os grupos. Onde essa regra decidiria o resultado, o MUTE efetivo é `unknown` com a causa `force_unmute_precedence_pending`.

## Observação e frescor

- `Ui16RealBridge` guarda, da **entrada bruta** do socket (nunca de valor padrão nem de cache da biblioteca), `mgmask` e `i.N.forceunmute`, com geração e sequência. Valores inválidos (não inteiros, fora de 24 bits, `forceunmute` ≠ 0/1) viram *desconhecido (invalid_sample)* e **não selam a sessão**.
- Tudo é descartado ao (re)conectar: a máscara e o Force Unmute **não sobrevivem** a uma reconexão; só valem os republicados na nova geração. Perda de conexão ou silêncio de entrada → `disconnected` / `inbound_silence`.
- Novos métodos somente leitura: `muteGroupsFact()`, `forceUnmuteFact(ch)`, `individualMuteFact(ch)`. `GET /api/ui16/mute-state` (operador autenticado, Origin conferido, `no-store`, só no servidor REAL) devolve, por canal: `individual`, `muteAll`, `otherGroupsActive`, `forceUnmute`, `effective`, `cause`, `precedence` e `reasons`.

## Regra do MUTE efetivo (`src/mixer/ui16-mute-state.ts`)

I = MUTE individual, A = Mute All, O = outro grupo (1–6/FX) ativo, F = Force Unmute.

| Situação | Efetivo | Causa |
|---|---|---|
| Sem grupo, I aberto | aberto | `none` |
| Sem grupo, I mudo, F=0 | mudo | `individual` |
| A, F=0, I aberto | mudo | `mute_all` |
| A, F=0, I mudo | mudo | `individual_and_mute_all` |
| F=1 com A/O ativo, ou F=1 com I mudo | **desconhecido** | `force_unmute_precedence_pending` |
| O ativo (pertinência não validada), sem F, I aberto | desconhecido | `other_mute_group_membership_unvalidated` |
| Estado dos grupos não observado | desconhecido (só I mudo com F=0 é conclusivo) | `group_state_unavailable` |
| Force Unmute não observado quando importa | desconhecido | `force_unmute_unavailable` |
| MUTE individual indisponível sem grupo | desconhecido | `individual_unavailable` |

Invariantes testados em **todas** as combinações: nunca "aberto" sem evidência (só com I aberto, A inativo e O inativo); "mudo" só com Force Unmute desligado; Force Unmute somado a um possível silenciador = precedência pendente.

## Interface (MIX / GAIN, REAL)

- Selo por canal abaixo de "CH n": `MUDO · individual`, `MUDO · Mute All`, `MUDO · indiv. + Mute All`, `ABERTO`, `FORCE UNMUTE · efetivo ?` etc. O botão MUTE continua mostrando só o estado **individual**.
- Aviso quando o Mute All está ativo (e quando o estado dos grupos está indisponível ou há outro grupo ativo).
- O **AUX SENDS** não recebe selo nem aviso: o MUTE individual dos envios segue como antes (não se afirma que o Mute All os afete).
- LAB/MOCK: nenhuma consulta, selo ou aviso. Falha de rede, 401, instância diferente → sem selo (desconhecido, nunca "aberto").

## Como validar na mesa física (pendente)

1. Com o Mute All ativo, conferir na interface oficial CH1–CH11 e comparar com o selo.
2. Para fechar a precedência: alternar o MUTE individual de um canal com Force Unmute, com e sem o Mute All, e observar a interface oficial e a saída de áudio **com o PA desconectado**; só então a regra pode ser promovida de `pending`.
3. Registrar firmware e resultados antes de qualquer mudança em `ui16-mute-state.ts`.

## Testes

`test/ui16-mute-state.test.ts` (tabela de decisão, invariantes, ponte com socket falso, dados parciais/inválidos, perda e reconexão, acesso), `web/src/app/live-ux/mute-state.spec.ts` e `test/e2e/effective-mute.test.ts` (navegador, zero SETD, capturas em `docs/ui16/effective-mute/`).
