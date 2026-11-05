# 04 — E0: escopo exato (correção e fortalecimento do núcleo)

**Data:** 05/11/2026 · **Versão 2**: incorpora o parecer "aprovado com ajustes obrigatórios" (ajustes 1 a 7).
**Linha de base:** commit `ec7b861` (branch `baseline-v0.1.0`) · 40 testes passando.
**Implementação:** branch `e0-nucleo`, com Pull Request para revisão. **Sem merge automático.**

## 1. Objetivo e limites

**Objetivo:** deixar o núcleo seguro para múltiplos clientes e para a mesa real, **sem mudar o que o usuário vê** no Claude Desktop e no console (exceto o formato da confirmação, seção 7).

**Dentro da E0:**
1. reconexão segura;
2. fila única;
3. revisões por parâmetro e desfazer causal;
4. estados distintos;
5. resultado honesto das operações;
6. autorização vinculada à operação **e ao estado**;
7. operações compostas com resultado parcial;
8. AUX e canais restritos ao configurado;
9. `import()` dinâmico da mesa real;
10. parser extraído do console.

**Fora da E0** (vão para E1–E9): servidor HTTP/WS, `LabMixer` persistente, frontend, EQ, cenas, medidores, voz e confirmação humana autenticada pela tela.

## 2. Ordem acordada

| Passo | Situação |
| --- | --- |
| Git inicializado e commit inicial | feito (`ec7b861`) |
| 40 testes atuais verdes | feito |
| Escopo revisado (v1 → parecer → v2) | este documento |
| Testes de regressão + implementação incremental | branch `e0-nucleo` |

## 3. Reconexão segura

### 3.1 O que foi comprovado

Experimento reproduzível: `node docs/lab/spikes/reconexao.mjs` (WebSocket falso, sem rede).

| Cenário | Resultado com a biblioteca 7.1.0 |
| --- | --- |
| Comando dado depois que a biblioteca percebeu a queda | guardado num buffer interno e **reenviado** na reconexão |
| Comando dado na janela da queda (socket morto, status ainda `OPEN`) | **perdido em silêncio**, sem erro para o chamador |
| Descartar a instância na primeira queda e criar outra | a instância velha **não reconecta**; o buffer dela morre com ela |
| `disconnect()` depois da queda | a promessa **não resolve** (exige tempo limite) |
| `disconnect()` chamado **dentro** do evento de queda | **não** cancela a reconexão automática; a instância "descartada" reabre sozinha ~2 s depois (achado durante a implementação, coberto em `library-behavior.test.ts`) |

Mais um fato relevante, lido no código da biblioteca: o estado local (`store.state$`) é montado a partir das mensagens **recebidas e também das enviadas**. Uma escrita aparece no estado local **no mesmo instante**, mesmo que nunca chegue à mesa. Portanto, **o estado local da instância que enviou nunca serve como prova de execução**.

### 3.2 Máquina de estados do `ConnectionSupervisor`

| Estado | Leitura | Escrita | Sai para |
| --- | --- | --- | --- |
| `DISCONNECTED` | não | não | `CONNECTING` (connect) |
| `CONNECTING` | não | não | `SYNCING` (OPEN da geração atual) · `LOST` (outro evento ou tempo limite) |
| `SYNCING` | não | não | `READY` (todos os parâmetros obrigatórios conhecidos) · `DEGRADED_READ_ONLY` (tempo limite) · `LOST` |
| `DEGRADED_READ_ONLY` | **parcial** (o que chegou; o resto aparece como desconhecido) | **não** | `READY` (quando os parâmetros que faltavam chegarem) · `LOST` |
| `READY` | sim | **sim** | `LOST` |
| `LOST` | não | não | `CONNECTING` (nova tentativa com espera progressiva) |
| `STOPPED` | não | não | — (disconnect pedido pelo usuário) |

**Parâmetros obrigatórios:** nível e mute no master, e nível e mute no AUX configurado, para **cada canal do `channels.yaml`**, mais o nível do master.

### 3.3 Gerações, eventos atrasados e recursos

- **Geração:** cada instância de `SoundcraftUI` recebe um número crescente. Todo callback (status, valores, temporizadores) carrega a geração em que nasceu e **é ignorado se ela não for a atual**. Isso descarta eventos atrasados de instâncias antigas e eventos fora de ordem.
- **Descarte da instância**, no primeiro evento diferente de `OPEN` (`CLOSE`, `ERROR`, `RECONNECTING`) ou no tempo limite de conexão:
  1. cancelar **todos** os temporizadores da geração;
  2. cancelar **todas** as assinaturas;
  3. chamar `disconnect()` sem esperar (o erro é ignorado), **de novo na próxima volta do loop de eventos** e sempre que a instância descartada tentar reabrir (vigia de 30 s);
  4. soltar a referência.
- **Uma única tentativa ativa:** `connect()` chamado de novo durante uma tentativa devolve a mesma promessa. Existe no máximo um temporizador de reconexão, e no máximo uma instância viva.
- **Reconexão:** sempre com uma instância **nova**, com espera progressiva (base 1 s, dobrando até 10 s). Nada é levado de uma instância para outra.
- **Eventos tratados explicitamente:**

| Evento \ Estado | `CONNECTING` | `SYNCING` | `DEGRADED_READ_ONLY` | `READY` |
| --- | --- | --- | --- | --- |
| `OPEN` (geração atual) | → `SYNCING` | ignorado (duplicado) | ignorado | ignorado |
| `CLOSE` / `ERROR` / `RECONNECTING` | → `LOST` | → `LOST` | → `LOST` | → `LOST` (escritas da janela viram pendentes de verificação) |
| valor recebido | — | registra; se completo → `READY` | registra; se completo → `READY` | registra como mudança externa |
| evento de geração antiga | ignorado | ignorado | ignorado | ignorado |
| tempo limite de conexão / sincronização | → `LOST` | → `DEGRADED_READ_ONLY` | — | — |

### 3.4 Estado degradado (comportamento conservador)

- Sincronização incompleta **permite leitura parcial** e **bloqueia todas as escritas** (código `DEGRADED_READ_ONLY`), não só as de parâmetros desconhecidos.
- A sincronização **continua em segundo plano**. Quando os parâmetros obrigatórios ficam conhecidos, o estado passa a `READY` e as escritas são liberadas.
- `DEGRADED_READ_ONLY` e `READY` aparecem separados em `mixer_status`, no console e nos códigos de resultado.

### 3.5 Sem rollback inseguro

- **Não existe** `strategy: legacy` na configuração. O comportamento antigo (reconexão automática da biblioteca) **não é acessível** em operação.
- O comportamento da biblioteca sem supervisor fica documentado **só** nos testes de caracterização, que usam a biblioteca diretamente com um WebSocket falso.
- **Se o supervisor falhar** (estado inesperado ou exceção interna), ele vai para `STOPPED`, recusa escritas e informa: "controle automático interrompido: use a interface oficial da Soundcraft".
- O rollback de código é feito só pelo Git (seção 12).

## 4. Resultado honesto das operações (ajuste 1)

O protocolo da Ui **não confirma** comandos. Cada escrita passa por estas etapas, registradas no log:

| Etapa | Significado | Quando |
| --- | --- | --- |
| `prepared` | validada, planejada e liberada pelas travas | sempre, antes de escrever |
| `sent` | entregue à biblioteca com o supervisor em `READY` | mesa real |
| `applied_simulated` | aplicada no simulador | mock e Lab (o próprio simulador é a mesa) |
| `observed_target` | depois de uma ressincronização, a mesa mostrou o valor desejado | mesa real, após reconexão |
| `observed_different` | depois de uma ressincronização, a mesa mostrou outro valor | mesa real, após reconexão |
| `indeterminate` | sem informação suficiente (parâmetro não chegou na ressincronização) | mesa real, após reconexão |
| `not_sent` | recusada antes de chegar à biblioteca (sem `READY`, trava, conflito) | qualquer modo |

Regras:

- **Mesa real em funcionamento normal:** o resultado é `sent`. As mensagens dizem "enviado à mesa", nunca "aplicado". `observed_target` significa apenas que **o valor desejado foi observado**, e **não prova que o MixAI o executou** (outra pessoa pode ter feito o mesmo ajuste).
- **Na queda:** escritas `sent` nos últimos `indeterminateWindowMs` (3 s) viram **pendentes de verificação**. Na próxima ressincronização, são classificadas em `observed_target`, `observed_different` ou `indeterminate`. **Nada é reaplicado.**
- **Desfazer (política conservadora, ajuste da revisão da implementação):**
  - **qualquer** escrita verificada após reconexão, **inclusive `observed_target`**, perde o desfazer (ator `uncertain`): ver o valor desejado não prova que foi o MixAI;
  - escritas fora da janela da queda, cujo valor volta igual na ressincronização, continuam desfazíveis;
  - itens `not_sent` nunca entram na pilha;
  - escrita interrompida por **erro inesperado** fica `indeterminate` e também perde o desfazer.
- **Avisos:** o resultado das verificações aparece em `mixer_status` (lista "verificações após reconexão") e no log.

## 5. Revisões e desfazer causal (ajuste 2)

### 5.1 Chave de parâmetro

```ts
type ParamKey = `ch.${number}.main.level` | `ch.${number}.main.mute`
              | `ch.${number}.aux.${number}.level` | `ch.${number}.aux.${number}.mute`
              | 'master.level';
```

### 5.2 `RevisionTracker`

- A revisão global cresce a cada mudança conhecida. Para cada parâmetro, o tracker guarda `{ revision, actor }`, com `actor` = `mixai` | `external` | `resync` | `snapshot`.
- **Escrita do MixAI:** revisão nova, ator `mixai`.
- **Mudança observada** (outro tablet, interface oficial): revisão nova, ator `external`.
  - As escritas do próprio MixAI aparecem no estado local da biblioteca **de forma síncrona**, durante a chamada de escrita. O adaptador marca a chave enquanto escreve e ignora o eco local, sem janela de tempo.
- **Ressincronização:** cada parâmetro cujo valor difere do último conhecido recebe revisão nova, ator `resync`.
- **Snapshot carregado:** todos os parâmetros conhecidos recebem revisão nova, ator `snapshot`, e a pilha de desfazer é **esvaziada**.

### 5.3 Desfazer causal

Cada item da pilha guarda, por parâmetro: `{ key, before, after, revisionAtWrite, revisionBefore }`. `revisionBefore` é a revisão do parâmetro imediatamente antes da escrita.

1. Um item só é desfeito se `revisionOf(key) === revisionAtWrite`. A comparação é pela **revisão**, nunca pelo valor.
2. **Encadeamento causal:**
   - o desfazer de um item gera uma revisão nova, `r'`;
   - em seguida, o item **imediatamente anterior para o mesmo parâmetro** é procurado na pilha;
   - **se** `revisionAtWrite` dele for igual ao `revisionBefore` do item desfeito (ou seja, nada aconteceu entre as duas escritas do MixAI), ele passa a ter `revisionAtWrite = r'`.
   - Assim, três alterações seguidas no mesmo fader podem ser desfeitas em sequência.
3. Se houve **mudança externa entre as duas escritas**, o encadeamento não acontece, e o item anterior fica em conflito. Desfazê-lo apagaria a mudança externa.
4. **Mudança externa que volta ao valor anterior** também gera revisão nova, e portanto também gera conflito.
5. **Conflito:**
   - o item é recusado (código `CONFLICT`) com a explicação de quem mexeu depois;
   - no desfazer de vários passos, os itens em conflito são **pulados e listados**, e os demais são desfeitos;
   - nos itens compostos (vários canais), cada parâmetro é avaliado separadamente e o resultado é parcial e explícito.
6. O desfazer passa pela fila, pelo teto e pelo limite de comandos por segundo.

## 6. Estados distintos

| Situação | Representação | Código |
| --- | --- | --- |
| Canal em -∞ | JSON `levelDB: "-inf"`, `known: true` | — |
| Valor desconhecido | JSON `levelDB: null`, `known: false` (só aquele parâmetro) | — |
| Sem conexão | — | `NO_CONNECTION` |
| Conectando ou sincronizando | — | `RESYNCING` |
| Sincronização parcial | leitura parcial | `DEGRADED_READ_ONLY` (escrita) |
| Controle interrompido | — | `CONTROL_STOPPED` |

`Result.code` tem valores estáveis: `OK`, `PARTIAL`, `NEEDS_CONFIRMATION`, `NO_CONNECTION`, `RESYNCING`, `DEGRADED_READ_ONLY`, `CONTROL_STOPPED`, `CONFLICT`, `NOT_FOUND`, `NOT_CONFIGURED`, `RATE_LIMIT`, `INVALID`, `CONFIRMATION_EXPIRED`, `CONFIRMATION_MISMATCH`, `CONFIRMATION_STALE`, `CONFIRMATION_USED`. As mensagens em português continuam.

## 7. Autorização vinculada à operação e ao estado (ajuste 3)

1. Uma ação crítica sem autorização gera uma **pendência** com:
   - `pendingId` aleatório;
   - **hash** do comando normalizado;
   - as **revisões de cada parâmetro envolvido**, no momento em que a mudança foi calculada;
   - validade de 60 s e **uso único**.
2. A execução exige o mesmo comando com `confirmation_id`. O servidor confere, nesta ordem, e recusa com o código correspondente:
   - existe (`NOT_FOUND`);
   - não foi usada (`CONFIRMATION_USED`);
   - não expirou (`CONFIRMATION_EXPIRED`);
   - o hash bate (`CONFIRMATION_MISMATCH`);
   - **nenhum parâmetro envolvido mudou de revisão** (`CONFIRMATION_STALE`).
3. Uma pendência invalidada **não pode ser reaproveitada**: é preciso pedir de novo, e o servidor recalcula a mudança sobre o estado atual.
4. `confirm: true` continua no esquema das tools, mas **sozinho nunca executa**: devolve uma pendência.
5. **Limite explícito da E0:**
   - o `confirmation_id` **não comprova aprovação humana**, porque a IA pode reenviá-lo;
   - ele garante só que o que é executado é exatamente o que foi avaliado, sobre o estado avaliado, uma única vez, dentro do prazo;
   - a autorização humana autenticada, pela tela e com o papel verificado no backend, é implementada na **E2**;
   - esse limite fica escrito no README e nas instruções das tools.

## 8. Operações compostas (ajuste 7)

- **Mutar vários canais:** escrita canal a canal, com o estado conferido antes de cada uma.
- **Se a conexão cair no meio** (por exemplo, 2 de 4 enviados):
  - resultado `ok: false`, código `PARTIAL`;
  - mensagem com o que foi enviado e o que **não** foi;
  - o log registra cada parâmetro com a sua etapa (`sent`/`applied_simulated` × `not_sent`);
  - o item de desfazer contém **apenas** os parâmetros efetivamente enviados;
  - as escritas enviadas na janela da queda seguem a regra da seção 4.
- **Nunca** declarar sucesso completo nem criar desfazer para o que não foi enviado.
- **Snapshot:** carregar um snapshot invalida todas as revisões (ator `snapshot`) e esvazia a pilha de desfazer.

## 9. Demais itens

| Item | Mudança |
| --- | --- |
| AUX e canais não configurados | `naming.allowUnmapped` (padrão `false`). "aux 4" e "canal 12" são recusados com `NOT_CONFIGURED`. A fixture dos testes antigos usa `true`. |
| `import()` dinâmico | `createApp()` passa a ser `async` e só carrega `mixer/real.js` quando `mode === 'real'`. |
| Parser | sai de `console.ts` para `src/core/parser.ts`, devolvendo um objeto de comando testável, com o mesmo comportamento. |
| Instruções MCP | confirmação com `confirmation_id` e o limite da seção 7; nenhuma tool renomeada. |

## 10. Arquivos

| Arquivo | Tipo | Mudança |
| --- | --- | --- |
| `src/core/queue.ts` | novo | `CommandQueue` |
| `src/core/revisions.ts` | novo | `ParamKey`, `RevisionTracker` |
| `src/core/pending.ts` | novo | pendências (hash, revisões, validade, uso único) |
| `src/core/undo.ts` | novo | pilha de desfazer causal |
| `src/core/parser.ts` | novo | parser extraído do console |
| `src/mixer/connection-supervisor.ts` | novo | máquina de estados da seção 3 |
| `src/mixer/protocol-map.ts` | novo | `ParamKey ↔ API da biblioteca` (único lugar com o protocolo) |
| `src/core/controller.ts` | modificado | fila, `applyChanges`, revisões, desfazer, pendências, códigos, resultados parciais |
| `src/mixer/types.ts` | modificado | contrato por `ParamKey`, estado do link, eventos |
| `src/mixer/real.ts` | modificado | usa o supervisor |
| `src/mixer/mock.ts` | modificado | mesmo contrato; simulação de queda, ressincronização, mudança externa e falha no meio |
| `src/core/channels.ts`, `src/core/config.ts` | modificados | `allowUnmapped`; `mixer.connection.*` (sem `strategy`) |
| `src/core/app.ts`, `src/index.ts`, `src/console.ts`, `src/mcp/server.ts` | modificados | `async`, import dinâmico, parser, `confirmation_id`, `code` |
| `config/config.yaml`, `README.md` | modificados | chaves novas; seção "Reconexão e confirmações" |
| `test/support/fake-ui-socket.ts` | novo | WebSocket falso controlável |

Nenhuma dependência nova.

## 11. Testes

### 11.1 Novos

| Arquivo | Cenários |
| --- | --- |
| `test/library-behavior.test.ts` (caracterização) | a biblioteca **sozinha** reenvia após reconexão; perde comando na janela; instância descartada não reconecta |
| `test/supervisor.test.ts` | comando depois da queda não chega ao socket novo · nenhum comando em `CONNECTING`/`SYNCING` · `READY` só com os obrigatórios · `DEGRADED_READ_ONLY` permite leitura parcial e bloqueia escrita · sincronização continua e libera `READY` · quedas consecutivas (em `CONNECTING`, `SYNCING` e `READY`) não acumulam instâncias, sockets nem temporizadores · evento atrasado de geração antiga é ignorado · `connect()` concorrente gera uma tentativa só · escrita na janela vira `observed_target`/`observed_different`/`indeterminate` após a ressincronização, sem reenvio · mudança feita na mesa vira evento `external` · eco local da própria escrita não vira `external` |
| `test/queue.test.ts` | `+3` e `+3` em paralelo dão `+6` · 20 comandos em ordem · erro não trava a fila |
| `test/undo-causal.test.ts` | três alterações no mesmo fader, desfeitas em sequência · várias ações em parâmetros diferentes · mudança externa entre operações · mudança externa que volta ao valor anterior · desfazer de vários passos pula conflitos · teto e limite respeitados · ressincronização com valor diferente invalida · snapshot esvazia e invalida |
| `test/composite.test.ts` | mutar 4 canais com queda depois do 2º → `PARTIAL`, só 2 no desfazer, log por canal · desfazer do parcial restaura só os 2 |
| `test/pending.test.ts` | `confirm: true` sozinho não executa · uso único · expiração · hash diferente · parâmetro mudou antes da confirmação → `CONFIRMATION_STALE` · nova pendência recalcula sobre o estado atual |
| `test/state-kinds.test.ts` | desconhecido × -∞ × sem conexão × sincronizando × degradado |
| `test/isolation.test.ts` | modo mock não importa `mixer/real.js` · precedência `--real` > `--mock` > `MIXAI_MODE` > `config.yaml` · `MIXAI_IP` |
| `test/parser.test.ts` | frases do `HELP` do console geram os mesmos comandos |
| `test/channels.test.ts` (acréscimo) | `allowUnmapped: false` recusa "aux 4" e "canal 12" |

### 11.2 Testes existentes que mudam (explicitamente)

| Teste atual | Motivo | Como fica |
| --- | --- | --- |
| `controller.test.ts`: teto, mudança grande, db muito baixo, teto do retorno, mute em lote, master, desfazer até -∞, snapshots | usam `confirm: true`, que deixa de executar | passam por um helper que obtém o `pendingId` e confirma; **a regra de quando confirmar não muda** |
| `mcp.test.ts`: fluxo completo | a resposta do master passa a citar `confirmation_id` | troca da string esperada |
| `real-adapter.test.ts` | o socket falso mandava estado parcial; o supervisor exige os obrigatórios para `READY` | o socket falso envia o estado completo; as asserções de protocolo continuam iguais |

Todos os demais testes atuais permanecem sem alteração.

## 12. Commits planejados (branch `e0-nucleo`)

| # | Commit | Ao final |
| --- | --- | --- |
| 1 | `docs(lab): escopo da E0 v2` (este documento) | 40 verdes |
| 2 | `test: WebSocket falso controlável + caracterização da biblioteca` | 40 + caracterização |
| 3 | `feat(core): fila, revisões, desfazer causal, pendências, estados e operações compostas` | + `queue`, `undo-causal`, `composite`, `pending`, `state-kinds` |
| 4 | `feat(real): ConnectionSupervisor com gerações e verificação pós-reconexão` | + `supervisor` |
| 5 | `refactor: import dinâmico, nomes restritos, parser, MCP e console` | + `isolation`, `parser`, `channels` |
| 6 | `docs: README e ESTADO-ATUAL` | todos |

Cada commit compila e passa em todos os testes. Os commits 3 e 4 juntam itens interdependentes; separá-los produziria estados intermediários que não compilam.

**Como ficou na implementação:** os itens dos commits 3, 4 e parte do 5 foram para um único commit de código (`feat(e0)`), porque a troca do contrato `MixerAdapter` exige mudar ao mesmo tempo o controlador, o simulador, a mesa real e quem os monta. As primitivas independentes (fila, revisões, pendências, desfazer) foram em commit próprio antes, e os testes de isolamento, parser e nomes em commit próprio depois.

## 13. Rollback (apenas por Git)

| Nível | Como |
| --- | --- |
| Um commit | `git revert <commit>` |
| A etapa inteira | branch `baseline-v0.1.0` (= `ec7b861`): `git checkout baseline-v0.1.0 && npm ci && npm run build` |
| No notebook | checkout + `npm run build` + reiniciar o Claude Desktop |
| Durante uma apresentação | **não** trocar versão: usar a interface oficial da Soundcraft |

`C:\Desenvolvimento\mixai` ainda é uma cópia. Antes de usar a E0 no notebook, trocar por um clone do repositório.

## 14. O que o F0 (mesa física) precisa confirmar

| Ponto | Verificação |
| --- | --- |
| A mesa manda o estado completo ao conectar? | quanto tempo até `READY` |
| A mesa reflete escritas de outros clientes? | mudar um fader pela interface oficial e ver o evento `external` |
| Quantos AUX a Ui16 expõe (4 ou 6)? | interface oficial |
| Queda de rede real | **só depois** da E0 aprovada: puxar o cabo, dar comando, religar e conferir no log que nada foi reenviado |

## 15. Critérios de aceite

1. Todos os testes passam (os atuais, com os ajustes da 11.2, mais os novos).
2. Nenhum comando antigo é executado após a reconexão (`supervisor.test.ts`).
3. Claude Desktop em modo mock:
   - "como está a mix?", "sobe um pouco o Fred no fone" e "desfaz" funcionam como hoje;
   - "sobe o surdo 10 dB" devolve uma pendência e só executa com o `confirmation_id`.
4. O console funciona como hoje.
5. Revisão cruzada aprovada no Pull Request. **Sem merge automático.**

## 16. Ajustes da revisão da implementação (aprovada com 4 ajustes + CI)

| # | Ajuste | Implementação | Testes |
| --- | --- | --- | --- |
| 1 | Desfazer após reconexão | todo relatório de verificação (inclusive `observed_target`) gera revisão com ator `uncertain`, e o desfazer daquele parâmetro é recusado | `supervisor.test.ts` › desfazer conservador (mesa real com socket falso); `undo-causal.test.ts` |
| 2 | Confirmação de snapshot | a pendência guarda um `guard` = revisão global + snapshot atual; qualquer mudança na mesa, escrita do próprio MixAI ou troca de snapshot até a confirmação → `CONFIRMATION_STALE` | `pending.test.ts` › confirmação de snapshot (4 cenários) |
| 3 | Exceções inesperadas | `applyChanges` distingue enviado/aplicado, **incerto** (a escrita que lançou o erro) e não enviado; resultado `PARTIAL`, nunca sucesso; o incerto perde o desfazer; a fila continua; o mesmo vale para o desfazer e o snapshot | `unexpected-errors.test.ts` (4 canais com erro na 2ª escrita, comando simples, desfazer, snapshot) |
| 4 | Instâncias descartadas após 30 s | **portão por geração**: o RealMixer cria os sockets por um construtor que recusa conexão depois do descarte e derruba a instância de novo. A garantia não depende mais da duração da vigilância (que continua como derrubada rápida, agora configurável por `zombieWatchMs`) | `supervisor.test.ts` › instâncias descartadas (portão continua fechado após a vigilância; biblioteca real tentando reconectar sozinha sem abrir socket; RealMixer com vigilância curta) |
| 5 | Integração contínua | `.github/workflows/ci.yml`: em PR para `main`, Ubuntu e Windows, Node 22: `npm ci`, `npm run typecheck`, `npm test`, `npm run build` | — |
