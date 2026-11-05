# 04 — E0: escopo exato (correção e fortalecimento do núcleo)

**Data:** 05/11/2026 · **Status: para revisão. Nada desta etapa foi implementado.**
**Linha de base:** commit `ec7b861` em `main` · 40 testes passando (`npx vitest run`: 5 arquivos, 40 testes).

## 1. Objetivo e limites

**Objetivo:** deixar o núcleo seguro para múltiplos clientes e para a mesa real, **sem mudar o que o usuário vê** no Claude Desktop e no console.

**Dentro da E0:**
1. reconexão segura;
2. fila única;
3. revisões por parâmetro e desfazer pela revisão;
4. estados distintos (desconhecido, -∞, indisponível, ressincronizando);
5. autorização vinculada à operação;
6. AUX e canais restritos ao configurado;
7. `import()` dinâmico da mesa real;
8. parser extraído do console.

**Fora da E0** (vão para E1–E9): servidor HTTP/WS, `LabMixer` persistente, frontend, EQ, cenas, medidores, voz, canal humano de confirmação pela tela.

## 2. Ordem acordada antes de mexer no núcleo

| Passo | Situação |
| --- | --- |
| Inicializar o Git e criar o commit inicial | **feito** (`ec7b861`, publicado em `main`) |
| Garantir os 40 testes atuais | **feito**: verde em Linux; verde no Windows do Fernando antes da publicação |
| Revisar a E0 com as decisões D1–D11 | **este documento** |
| Acrescentar os testes de regressão | primeiro commit da implementação (seção 9) |

## 3. Reconexão segura (D8)

### 3.1 O que foi comprovado

Experimento reproduzível: `node docs/lab/spikes/reconexao.mjs` (WebSocket falso, sem rede).

| Cenário | Resultado com a biblioteca 7.1.0 | Risco |
| --- | --- | --- |
| Comando dado **depois** que a biblioteca percebeu a queda | guardado num buffer interno e **reenviado** ao reconectar (~2 s depois) | **mudança fantasma** |
| Comando dado **na janela** da queda (socket morto, status ainda `OPEN`) | **perdido em silêncio**: não é enviado, não é reenviado, e o chamador não recebe erro | o MixAI diz "feito" e a mesa não mudou (**operação indeterminada**) |
| **Descartar a instância** (`disconnect()` logo na primeira queda) e criar outra | a instância velha **não reconecta**, e o que ficou no buffer dela **morre com ela**; a nova não recebe nada antigo | resolve o reenvio |
| `disconnect()` depois da queda | **não resolve** (a promessa fica pendente) | já mitigado: o MixAI usa tempo limite |

Investigação dos pontos pedidos:

- **Buffer interno:** confirmado. Ele fica dentro do `WebSocketSubject` (rxjs), que é privado à biblioteca.
- **Descartar comandos pendentes:** não há API pública pra isso. A única forma limpa é descartar a instância inteira.
- **Recriar a instância:** funciona e é a solução adotada.
- **Operações indeterminadas:** existem (cenário 2) e são tratadas na seção 3.3.
- **Sincronização obrigatória antes de aceitar novos comandos:** adotada (seção 3.2).

Conclusão: **verificar `OPEN` antes de enviar não basta.** Esse portão evita o reenvio só nos casos em que o status já mudou, e nada faz contra a perda silenciosa.

### 3.2 Desenho: `ConnectionSupervisor` dentro do `RealMixer`

```
DISCONNECTED ──connect()──▶ CONNECTING ──open──▶ SYNCING ──estado completo──▶ READY
      ▲                                              │ tempo limite                │
      │                                              ▼                             │ 1º evento ≠ OPEN
      └──────── nova tentativa (backoff) ◀── LOST ◀──┴─────────────────────────────┘
                                        (descarta a instância)
```

Regras:

1. **Comandos de escrita só em `READY`.** Em qualquer outro estado: recusa com código `NO_CONNECTION` ou `RESYNCING`. Nada é guardado para depois.
2. **Primeiro evento diferente de `OPEN` (`CLOSE`, `ERROR`, `RECONNECTING`) → `LOST`:**
   - chamar `disconnect()` na instância sem esperar (o resultado é ignorado);
   - soltar todas as assinaturas;
   - **descartar o objeto**.

   A reconexão automática da biblioteca nunca chega a reenviar nada.
3. **Reconexão:** sempre com uma instância **nova** de `SoundcraftUI`, com espera progressiva (1 s, 2 s, 4 s… até 10 s). Ela é automática, mas **nunca leva comandos**.
4. **`SYNCING`:**
   - depois de abrir, esperar `store.state$` conter **todos os parâmetros obrigatórios**: nível e mute no master e no AUX configurado para cada canal do `channels.yaml`, mais o master;
   - limite de 5 s (configurável);
   - estourou o limite: o estado vira `READY` apenas para leitura (modo **degradado**), com escrita recusada (`UNKNOWN_STATE`) para qualquer parâmetro ainda desconhecido.
5. **Portão extra no envio:** mesmo em `READY`, a escrita confere o status da instância imediatamente antes de chamar a biblioteca (defesa em profundidade, não é a proteção principal).

### 3.3 Operações indeterminadas

- Toda escrita fica registrada por `indeterminateWindowMs` (padrão 3 000 ms) depois de enviada.
- Na passagem para `LOST`, as escritas ainda dentro da janela viram **indeterminadas**.
- Ao chegar em `READY`, cada indeterminada é conferida contra o estado ressincronizado:

| Valor lido depois da ressincronização | Classificação | O que o MixAI faz |
| --- | --- | --- |
| igual ao valor enviado | **aplicada** | registra no log; o desfazer continua válido |
| diferente do valor enviado | **não aplicada** | registra no log; **remove** o item da pilha de desfazer; avisa no próximo `mixer_status` |
| parâmetro não chegou | **indeterminada** | registra; remove do desfazer; avisa |

- **Nada é reaplicado automaticamente.** O aviso aparece em `mixer_status` e no console; a pessoa decide se repete.

### 3.4 Configuração e rollback rápido

```yaml
mixer:
  connection:
    strategy: supervisor        # supervisor (novo) | legacy (comportamento de hoje)
    syncTimeoutMs: 5000
    indeterminateWindowMs: 3000
    reconnectMaxDelayMs: 10000
```

`legacy` existe **só durante a E0 e a E1**, como saída de emergência sem precisar reverter código. Ele é removido na E2.

## 4. Fila única e `applyChange()`

- **`CommandQueue`** (novo, ~30 linhas, sem dependência): uma promessa encadeada. Toda escrita (nível, mute, master, desfazer, snapshot) entra nela; as leituras não entram.
- **`applyChange(change)`** substitui o corpo repetido de `setLevel`, `setMute` e `setMaster`. Ordem fixa:
  1. resolver nomes;
  2. checar o estado da conexão;
  3. planejar (teto, piso, arredondamento);
  4. confirmação (seção 7);
  5. limite por segundo;
  6. escrever;
  7. registrar a revisão;
  8. empilhar o desfazer;
  9. log.
- Os textos de retorno continuam **idênticos** aos de hoje (os testes atuais conferem as mensagens).

## 5. Revisões e desfazer

### 5.1 Chave de parâmetro

`ParamKey` mínimo, já no formato que a E1 vai ampliar (EQ e HPF entram lá):

```ts
type ParamKey = `ch.${number}.main.level` | `ch.${number}.main.mute`
              | `ch.${number}.aux.${number}.level` | `ch.${number}.aux.${number}.mute`
              | 'master.level';
```

### 5.2 `RevisionTracker`

- **`revision`** global e crescente.
- Para cada `ParamKey`, guarda `{ revision, actor: 'mixai' | 'external' | 'resync' }`.
- **Escritas do MixAI:** recebem `actor: 'mixai'`.
- **Mudanças observadas na mesa** (outro tablet, interface oficial): recebem `actor: 'external'`.
  - Na mesa real, são lidas de `store.state$`.
  - Pra não confundir com o "eco" da própria escrita, o MixAI registra o valor que acabou de mandar (parâmetro, valor, até 1 s). Se esse mesmo valor chegar dentro desse prazo, é tratado como eco, não como mudança externa.
  - **Se a mesa ecoa ou não é um ponto a verificar no F0.**
- **Ressincronização:** todo parâmetro cujo valor mudou em relação ao último conhecido recebe `actor: 'resync'`.

### 5.3 Desfazer pela revisão

- Cada item da pilha guarda `{ key, before, after, revisionAtWrite }`.
- **O desfazer só aplica** se `tracker.revisionOf(key) === revisionAtWrite`. A comparação é pela revisão, não pelo valor: se alguém mexeu e voltou ao mesmo valor, o item é **recusado** do mesmo jeito.
- Conflito: recusa com o código `CONFLICT` e a mensagem "o Fred no Fones foi alterado depois (por outro aparelho/na mesa); não desfiz para não apagar essa mudança".
- No desfazer de vários passos, os itens em conflito são **pulados e listados**, e os demais são desfeitos.
- O desfazer passa por fila, teto e limite por segundo.
- **Mudança externa invalida o desfazer conflitante:** o item continua na pilha, mas fica marcado como inválido, e `get_action_log` mostra isso.

### 5.4 Contrato do adaptador

`MixerAdapter` ganha **um** método novo, precursor do `subscribe()` da E1:

```ts
onParamChange(listener: (key: ParamKey, value: number | boolean | null, origin: 'external' | 'resync') => void): () => void;
```

- `MockMixer`: implementa e ganha `simulateExternalChange(key, value)` (só para testes).
- `RealMixer`: implementa a partir de `store.state$`, traduzindo os caminhos do protocolo num único arquivo (`protocol-map.ts`).

## 6. Estados distintos

| Situação | Hoje | Depois da E0 |
| --- | --- | --- |
| Canal em -∞ | número `-Infinity` (JSON: `"-inf"`) | `{ state: 'off' }`, JSON `levelDB: "-inf"` (sem mudança visível) |
| Valor ainda não recebido | erro "não respondeu a tempo" derruba a leitura inteira | `{ state: 'unknown' }`, JSON `levelDB: null, known: false`; **o resto da leitura funciona** |
| Sem conexão | mensagem livre | código `NO_CONNECTION` |
| Ressincronizando | não existe | código `RESYNCING` |

`Result` ganha o campo `code`, com os valores estáveis: `OK`, `NEEDS_CONFIRMATION`, `NO_CONNECTION`, `RESYNCING`, `UNKNOWN_STATE`, `CONFLICT`, `NOT_FOUND`, `NOT_CONFIGURED`, `RATE_LIMIT`, `INVALID`, `CONFIRMATION_EXPIRED`, `CONFIRMATION_MISMATCH`.

As mensagens em português continuam. O `code` é para máquinas (E2 e frontend).

## 7. Autorização vinculada à operação (D4)

- Ação crítica sem autorização → o servidor cria uma **pendência**:
  - `pendingId`: aleatório, 8 caracteres;
  - **hash** do comando normalizado (canal, barramento, valor alvo);
  - validade de 60 s;
  - **uso único**.
- A resposta traz `needsConfirmation: true`, `pendingId`, o resumo e a validade.
- Para executar, o chamador repete o comando com `confirmation_id: <pendingId>`.
- O servidor confere: existe, não expirou, não foi usada e o hash bate. Se o hash não bater (por exemplo, outro valor), recusa com `CONFIRMATION_MISMATCH`.
- **Compatibilidade MCP:**
  - as tools mantêm nomes e parâmetros;
  - ganham `confirmation_id`;
  - `confirm: true` continua aceito no esquema, mas **sozinho não executa mais nada**: devolve a pendência. Isso impede a IA de "confirmar sozinha" com um booleano;
  - as instruções da IA passam a pedir: "mostre o resumo ao usuário e só repita com `confirmation_id` depois do sim dele".
- **Limite honesto:** no Claude Desktop, quem repassa o "sim" ainda é a IA (a aprovação de tools do próprio app ajuda). O **canal humano de verdade** chega na E2, com o cartão na tela. A E0 garante o vínculo à operação; a E2 garante a origem humana.
- **Console:** a pergunta "Confirmar? (s/n)" passa a usar o `pendingId` internamente, sem mudança pra quem digita.

## 8. Demais itens

| Item | Mudança |
| --- | --- |
| AUX e canais não configurados | `ChannelMap` recebe `allowUnmapped` (padrão `false` no `config.yaml`). "aux 4" e "canal 12" passam a ser recusados com `NOT_CONFIGURED`. A fixture dos testes antigos usa `true`, preservando aqueles testes. |
| `import()` dinâmico | `createApp()` passa a ser `async` e só carrega `mixer/real.js` quando `mode === 'real'`. `index.ts` e `console.ts` passam a usar `await`. |
| Parser | `parse()` e `channelAndValue()` saem de `console.ts` para `src/core/parser.ts`, com o comportamento idêntico (base do assistente da E4). |
| Instruções MCP | texto da confirmação atualizado (seção 7); nenhuma tool renomeada. |

## 9. Arquivos

| Arquivo | Tipo | Mudança |
| --- | --- | --- |
| `src/core/queue.ts` | **novo** | `CommandQueue` |
| `src/core/revisions.ts` | **novo** | `RevisionTracker`, `ParamKey` |
| `src/core/pending.ts` | **novo** | pendências de autorização (id, hash, validade, uso único) |
| `src/core/parser.ts` | **novo** | parser extraído do console |
| `src/mixer/connection-supervisor.ts` | **novo** | máquina de estados da seção 3 |
| `src/mixer/protocol-map.ts` | **novo** | `ParamKey ↔ caminho do protocolo` (único lugar com o protocolo) |
| `src/core/controller.ts` | modificado | `applyChange`, fila, revisões, desfazer, códigos, pendências |
| `src/mixer/types.ts` | modificado | `onParamChange`, tipo de valor com `unknown`/`off` |
| `src/mixer/real.ts` | modificado | usa o supervisor; espelho de `store.state$`; portão no envio |
| `src/mixer/mock.ts` | modificado | `onParamChange`, `simulateExternalChange`, simulação de queda/ressincronização |
| `src/core/channels.ts` | modificado | `allowUnmapped` |
| `src/core/config.ts` | modificado | `mixer.connection.*`, `naming.allowUnmapped` |
| `src/core/app.ts` | modificado | `async`, `import()` dinâmico |
| `src/mcp/server.ts` | modificado | `confirmation_id`, `code`, instruções |
| `src/index.ts`, `src/console.ts` | modificados | `await createApp()`; console usa `parser.ts` e pendências |
| `config/config.yaml` | modificado | novas chaves com padrões seguros |
| `README.md` | modificado | seção "Reconexão e confirmações" |
| `test/support/fake-ui-socket.ts` | **novo** | WebSocket falso controlável (abrir, cair, janela, eco, estado inicial parcial ou completo) |

Nenhuma dependência nova.

## 10. Testes

### 10.1 Novos (regressão dos cenários identificados)

| Arquivo | Teste |
| --- | --- |
| `test/reconnect.test.ts` | comando depois da queda **não** chega ao socket novo |
| | comando na janela da queda vira **indeterminado**; depois da ressincronização, é classificado como aplicado, não aplicado ou indeterminado |
| | instância velha não cria socket novo depois de descartada |
| | nenhum comando é aceito em `SYNCING`; aceito em `READY` |
| | estado inicial parcial: `SYNCING` → `READY` degradado; escrita em parâmetro desconhecido é recusada (`UNKNOWN_STATE`) |
| | quedas seguidas não acumulam instâncias nem assinaturas |
| | `strategy: legacy` reproduz o comportamento antigo (rede de segurança) |
| `test/queue.test.ts` | dois `setLevel` em paralelo no mesmo canal somam (+3 +3 = +6) |
| | 20 comandos concorrentes terminam na ordem de chegada |
| | erro num comando não trava a fila |
| `test/undo-revision.test.ts` | mudança externa invalida o desfazer daquele parâmetro |
| | mudança externa que volta ao **mesmo valor** também invalida (prova de que compara revisão, não valor) |
| | desfazer de vários passos pula os itens em conflito e desfaz os demais |
| | desfazer respeita teto e limite por segundo |
| | ressincronização com valor diferente invalida o desfazer |
| `test/state-kinds.test.ts` | `mixState` com parâmetro ausente devolve `unknown` só nele, sem derrubar o resto |
| | -∞ continua `"-inf"`; desconhecido é `null` + `known: false` |
| | códigos `NO_CONNECTION` e `RESYNCING` |
| `test/pending.test.ts` | `confirm: true` sozinho **não executa** |
| | `confirmation_id` válido executa uma vez; o segundo uso é recusado |
| | expirado → `CONFIRMATION_EXPIRED` |
| | id de outra operação ou valor diferente → `CONFIRMATION_MISMATCH` |
| `test/isolation.test.ts` | modo mock não carrega `mixer/real.js` e não constrói `WebSocket` (espião global) |
| | precedência: `--real` > `--mock` > `MIXAI_MODE` > `config.yaml`; `MIXAI_IP` aplicado |
| `test/parser.test.ts` | todas as frases do `HELP` do console geram o mesmo comando de antes |
| `test/channels.test.ts` (acréscimo) | com `allowUnmapped: false`, "aux 4" e "canal 12" são recusados |

### 10.2 Testes existentes que mudam (explicitamente)

| Teste atual | Por quê | Como fica |
| --- | --- | --- |
| `controller.test.ts`: confirmação de mudança grande, mutar 3 canais, master, snapshot | hoje executam com `confirm: true` | passam a obter o `pendingId` e confirmar com ele; **a regra de quando pede confirmação não muda** |
| `mcp.test.ts`: fluxo completo | idem, na parte do master | idem |

Todos os outros testes atuais permanecem **sem alteração** e precisam continuar verdes. A contagem esperada ao final fica em torno de 75, e o número exato vai no relatório da implementação.

## 11. Commits planejados (branch `e0-nucleo`)

| # | Commit | Testes verdes ao final |
| --- | --- | --- |
| 1 | `test: suporte de WebSocket falso controlável + testes de caracterização` (documentam o comportamento atual) | 40 + caracterização |
| 2 | `feat(core): fila única e applyChange` | + `queue` |
| 3 | `feat(core): revisões por parâmetro e desfazer pela revisão` | + `undo-revision` |
| 4 | `feat(real): ConnectionSupervisor (descartar instância, ressincronizar, indeterminadas)` | + `reconnect` |
| 5 | `feat(core): estados distintos e códigos de resultado` | + `state-kinds` |
| 6 | `feat(core): autorização vinculada à operação` | + `pending` (com o ajuste da seção 10.2) |
| 7 | `refactor: import dinâmico, allowUnmapped, parser extraído` | + `isolation`, `parser`, `channels` |
| 8 | `docs: README e ESTADO-ATUAL` | todos |

Cada commit compila e passa em todos os testes. A revisão cruzada acontece no Pull Request para `main`.

## 12. Estratégia de rollback

| Nível | Como |
| --- | --- |
| Configuração (sem mexer em código) | `mixer.connection.strategy: legacy` volta a reconexão ao comportamento de hoje |
| Um commit específico | `git revert <commit>`: os commits são independentes na ordem acima |
| A etapa inteira | a tag `v0.1.0-baseline` é criada **antes** da E0, apontando para `ec7b861`; `git checkout v0.1.0-baseline && npm ci && npm run build` |
| No notebook | o Claude Desktop aponta para `dist/index.js`; voltar = checkout da tag + `npm run build` + reiniciar o Claude Desktop |

**Observação:** hoje `C:\Desenvolvimento\mixai` **não é um clone Git**, e sim uma cópia. Antes de usar a E0 no notebook, recomendo trocar por um clone: `git clone https://github.com/dodoxbr/MixAI.git C:\Desenvolvimento\mixai-git`, seguido de apontar o Claude Desktop pra lá. Assim o rollback vira um comando.

## 13. Riscos residuais e o que o F0 precisa confirmar

| Ponto | Por que importa | Verificação no F0 |
| --- | --- | --- |
| A mesa **ecoa** as escritas? | define a janela de eco (5.2) | mudar um fader pelo MixAI e observar `store.state$` |
| A mesa manda o **estado completo** ao conectar? | define o `SYNCING` | contar os parâmetros recebidos nos primeiros 5 s |
| Quantos **AUX** a Ui16 expõe (4 ou 6)? | biblioteca diz 6, especificação de loja diz 4 | listar pela interface oficial |
| Queda de rede real × WebSocket falso | o experimento usa um socket simulado | **depois** da E0 aprovada: puxar o cabo, dar comando, religar, conferir no log que nada foi reenviado |

## 14. Critérios de aceite da E0

1. Todos os testes passam (os 40 atuais, com o ajuste explícito da seção 10.2, mais os novos).
2. `node docs/lab/spikes/reconexao.mjs` continua documentando a biblioteca, e o teste `reconnect.test.ts` prova que o **MixAI** não reenvia nada.
3. No Claude Desktop, em modo mock:
   - "como está a mix?", "sobe um pouco o Fred no fone" e "desfaz" funcionam como hoje;
   - "sobe o surdo 10 dB" pede confirmação e só executa depois do "sim".
4. O console funciona como hoje.
5. Revisão cruzada aprovada no Pull Request.
