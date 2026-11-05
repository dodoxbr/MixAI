# 01 — Gap analysis: MixAI atual × MixAI Lab

**Data:** 05/11/2026 · **Base:** código em `C:\Desenvolvimento\mixai` (cópia idêntica usada na análise), `soundcraft-ui-connection` 7.1.0 instalada pelo lockfile, especificação `MixAI_Lab_SPEC_PLAN_Claude_Code.md` v1.0.
**Escopo:** só análise. Nenhum arquivo do projeto foi alterado.

## Resumo

O MixAI atual é um núcleo pequeno e correto para **comandos isolados vindos de uma única IA**. Ele **não** está pronto para receber o Lab sem três mudanças estruturais:

1. **Não existe estado observável.** O estado da mesa é lido sob demanda e não há eventos, então nenhuma tela consegue acompanhar mudanças.
2. **Não existe serialização de comandos.** Com mais de um cliente (celulares, tela, IA), duas mudanças simultâneas podem se sobrescrever.
3. **O desfazer ignora mudanças feitas por outros.** Ele restaura o valor antigo mesmo que alguém tenha mexido no meio.

Dois achados novos, comprovados por experimento:

- **A biblioteca reenvia ao reconectar comandos dados com a conexão caída** (seção 4.1).
- **A leitura do estado na mesa real falha por inteiro** se um único parâmetro não tiver chegado (seção 4.2).

---

## 1. Linha de base (executada)

| Verificação | Resultado |
| --- | --- |
| `npx vitest run` | **5 arquivos, 40 testes, todos passando** |
| `tsc` (strict) | sem erros |
| Versão instalada | `soundcraft-ui-connection` **7.1.0** (fixada em `package.json`), `@modelcontextprotocol/sdk` 1.32.2, zod 4.6.7 |
| Tamanho | ~1.900 linhas (src + test) |
| Repositório git | **não existe** (`git status`: "not a git repository") |
| Mesa real | **nunca testada** |

> Recomendação imediata, antes de qualquer etapa: criar o repositório git e fazer o primeiro commit. A especificação pede "PRs/commits pequenos", e hoje não há como reverter mudanças.

---

## 2. O que existe e funciona (verificado no código)

| Componente | Arquivo | O que faz de verdade | Reaproveita no Lab? |
| --- | --- | --- | --- |
| Interface de mesa | `src/mixer/types.ts` → `MixerAdapter` | contrato com 15 métodos, 12 deles assíncronos (nível, mute, master, nome, shows) | **Sim, ampliando** com estado e eventos |
| Mesa simulada | `src/mixer/mock.ts` → `MockMixer` | 12 canais × (master + 6 AUX) em `Map`; registra escritas em `writes[]` | **Parcial**: serve de base para o `LabMixer` |
| Mesa real | `src/mixer/real.ts` → `RealMixer` | envolve `SoundcraftUI`; lê com `currentValue()` (assina, pega 1 valor, desassina); timeout de conexão e de desconexão | **Sim**, com correções (4.1 e 4.2) |
| Regras de negócio | `src/core/controller.ts` → `MixController` | resolve nomes, aplica teto/passo/confirmação/limite por segundo, desfazer, log | **Sim, é o ativo principal**; precisa de fila e estado |
| Nomes da banda | `src/core/channels.ts` → `ChannelMap`, `normalize()` | apelidos sem acento, "canal N", "retorno do X" | **Sim**, é a base do parser offline |
| Config | `src/core/config.ts` | zod + YAML; `MIXAI_MODE`, `--mock/--real`, `MIXAI_IP` | **Sim** |
| Log | `src/core/log.ts` → `ActionLog` | memória (500) + `.jsonl` por dia; `-Infinity` vira `"-inf"` | **Sim** |
| MCP | `src/mcp/server.ts` | 11 tools, instruções em PT, `needsConfirmation` sem `isError` | **Sim**, mas deve virar cliente do backend (ver doc 02) |
| Console | `src/console.ts` | REPL sem IA (`sobe`, `desce`, `muta`, `@ retorno`) | **Sim**: a gramática vira o parser determinístico |
| Montagem | `src/core/app.ts` → `createApp()` | escolhe `RealMixer` ou `MockMixer` **uma vez, na partida** | **Sim**: já é a base do isolamento LAB/REAL |

### Divergências entre `ESTADO-ATUAL.md` e o código

| Documento diz | Código mostra |
| --- | --- |
| "AUX 1 = Fones" | `ChannelMap.auxBus()` aceita **qualquer AUX de 1 a 6 pelo número** (`"aux 4"` resolve). A IA pode mexer em AUX que não estão ligados a nada. |
| "11 canais" | O controlador opera os **12** canais da Ui16. O canal 12 é acessível por número. |
| "Travas no código" | Correto para nível, mute, master e snapshot. **O desfazer não passa** pelas travas nem pelo limite por segundo (`undo()`, linha 258). |
| "Confirmação" | `confirm=true` é um **booleano confiado**. Qualquer chamador (inclusive a IA) pode mandar `true` direto, porque o servidor não emite nem confere nenhum token de confirmação. |

---

## 3. Matriz de capacidades

Legenda: **Doc** = documentado pela Soundcraft · **Lib** = existe na API 7.1.0 (lido nos `.d.ts` e no `index.mjs`) · **Mock** = implementado no `MockMixer` · **HW** = testado em hardware.

| Funcionalidade | Doc Ui16 | Lib 7.1.0 | MixAI (Mock) | MixAI (Real) | HW | Observação |
| --- | --- | --- | --- | --- | --- | --- |
| Fader de entrada no master | sim | `master.input(n).setFaderLevelDB` | sim | sim | **não** | |
| Mute de entrada | sim | `setMute` | sim | sim | **não** | |
| Envio AUX (nível/mute) | sim | `aux(n).input(m)` | sim | sim | **não** | |
| AUX PRE/POST | sim | `setPost()` / `setPostProc()` | não | não | não | importante para os fones (doc 02) |
| Nº de AUX | **4 saídas físicas** (lojas/especificação) | `DEVICE_CAPABILITIES.ui16.aux = 6` | 6 | 6 | não | **divergência: verificar na mesa** |
| Master | sim | `master.setFaderLevelDB` | sim | sim | não | |
| Pan / solo | sim | sim | não | não | não | |
| EQ 4 bandas | sim | `eq.band(1..4)`: freq 20–22050 Hz, Q 0,05–15, ganho ±20 dB; bypass | não | não | não | o tipo de filtro de cada banda não é exposto |
| HPF | sim | `eq.hpf`: 20–1000 Hz, slope 12/24/36 dB/oct | não | não | não | |
| LPF | — | existe, mas **no-op na Ui16** (comentário na lib) | — | — | — | só Ui24R |
| Compressor / gate / de-esser | sim | **não existe na API** | não | não | não | teria de simular só no Lab |
| EQ gráfico 31 bandas (saídas) | sim | **não existe na API** | não | não | não | |
| dbx AFS2 (antimicrofonia) | sim | **não existe na API** | não | não | não | |
| FX (reverb/delay) | sim | envio por canal, tipo, BPM | não | não | não | parâmetros internos do FX não aparecem |
| Ganho / phantom | sim | `hw(n).setGainDB` / `setPhantom` | **não exposto** (por decisão) | não exposto | não | manter fora da IA |
| Medidores (VU) | sim | `vuProcessor.input(n)`: pre/post/postFader; aux; master | não | não | não | **dado real disponível**, útil para diagnóstico |
| RTA | sim | **não existe na API** | não | não | não | |
| Shows / snapshots | sim | listar, `loadSnapshot`, `saveSnapshot`, `updateCurrentSnapshot`, cues | listar/carregar | listar/carregar | não | salvar não é exposto hoje |
| Nome do canal | sim | `name$` / `setName()` | fixo `CH n` | só leitura | não | |
| Estado completo bruto | — | `store.state$`: `Record<caminho, valor>` | — | não usado | não | **base ideal para o espelho de estado** |
| Mudança externa (outro tablet) | — | chega por `store.state$` | — | **ignorada** (só lê sob demanda) | não | |

Conclusão: para o Lab, **EQ/HPF e medidores** têm caminho real verificável na biblioteca. **Compressor, gate, GEQ, AFS e RTA** só poderiam existir como simulação marcada, sem equivalente que se possa aplicar na mesa.

---

## 4. Problemas e riscos encontrados

### 4.1 Reenvio de comandos depois de reconectar (crítico, comprovado)

Fiz um experimento fora do projeto, com a biblioteca 7.1.0 e um WebSocket falso:

```
status: OPENING > OPEN > CLOSE > ERROR > RECONNECTING > OPEN
socket 1 recebeu: [ SETD^i.0.mix^0.529 ]                      (antes da queda)
socket 2 recebeu: [ SETD^i.0.mix^0.765, SETD^i.1.mute^1 ]     (comandos dados COM A CONEXÃO CAÍDA)
```

A biblioteca faz assinatura `outbound$ → WebSocketSubject` e reconecta sozinha depois de ~2 s. Com isso, **todo comando enviado enquanto a conexão estava caída é guardado e disparado na reconexão**, possivelmente minutos depois.

- **Proteção atual:** `MixController.requireConnection()` recusa comandos quando o status não é `OPEN`. Isso cobre o caso comum.
- **Brecha:** existe uma janela entre a queda real da rede e o evento de status. Qualquer chamada direta à biblioteca fora do controlador também fica sem proteção.
- **Sem teste:** nenhum teste cobre esse cenário.

### 4.2 Leitura de estado frágil e lenta na mesa real (alto, comprovado)

`mixState()` (controller.ts, linha 104) faz, para cada um dos 12 canais e em sequência, 3 leituras `currentValue()` com timeout de 1,5 s (nível e mute) e 0,5 s (nome). Num experimento em que a "mesa" mandou só alguns parâmetros, o resultado foi:

```
mixState -> false "A mesa não respondeu a tempo" em 2003 ms
```

Um único parâmetro ausente derruba a leitura inteira. Na mesa real o estado completo deve chegar na conexão, mas isso **não foi verificado**. A abordagem "assina, lê um valor, desassina" também não serve pra uma tela que precisa de atualizações contínuas.

### 4.3 Corrida entre comandos simultâneos (alto, por inspeção)

`setLevel()` lê o nível atual, calcula o novo e escreve (linhas 147–189), sem nenhuma trava. Exemplo: dois celulares pedem "+3 dB no Fred" ao mesmo tempo; os dois leem -10 e os dois escrevem -7, e o resultado é +3 em vez de +6. Com uma única IA via stdio isso quase não acontece. Com o Lab multiusuário, acontece.

### 4.4 Desfazer sem checar conflito (alto, por inspeção)

`pushUndo()` guarda uma função que restaura o valor **capturado antes da mudança**. Se outra pessoa (ou a interface oficial da mesa) mexer no mesmo fader depois, o desfazer **apaga a intervenção humana** sem avisar. Além disso, o desfazer não passa pelo limite de comandos por segundo nem é verificado contra o teto.

### 4.5 Confirmação sem vínculo (médio)

`confirm` é um booleano. O servidor não sabe *o que* foi confirmado nem *por quem*. No Claude Desktop, a aprovação de tools pelo usuário reduz o risco; num app multiusuário, isso não basta.

### 4.6 Outros

| # | Problema | Onde | Severidade |
| --- | --- | --- | --- |
| a | AUX 2–6 e canal 12 acessíveis por número, apesar de não estarem ligados | `channels.ts` `Directory.resolve()` | média |
| b | O estado do `MockMixer` se perde ao reiniciar | `mock.ts` | baixa (alta para o Lab) |
| c | Valores iniciais do mock não representam nada real (-10 / -20 / -6) | `mock.ts` linha 20 | baixa |
| d | `createApp()` importa `RealMixer` estaticamente, mesmo no modo mock | `app.ts` | baixa (a importação não abre rede, mas carrega o código) |
| e | O parser do console está dentro de `console.ts` e não pode ser reaproveitado | `console.ts` `parse()` | baixa |
| f | O MCP e um futuro servidor web, rodando em processos separados, teriam **dois controladores** para a mesma mesa | arquitetura | **alta** quando houver app |
| g | `disconnect()` da biblioteca pode não resolver depois de uma reconexão (no experimento ficou pendente) | `real.ts` já mitiga com timeout de 2 s | baixa, já mitigado |

### 4.7 Código duplicado / simplificações

- `setLevel()` e `setMaster()` repetem o mesmo esqueleto (planejar → confirmar → limitar → escrever → desfazer → log). Dá pra extrair um `applyChange(change)` único, que vira o ponto onde entram a fila, a revisão e a confirmação com token.
- A resolução de AUX aparece duplicada em `setLevel`, `setMute` e `mixState`.
- `RealMixer.currentValue()` deixa de ser necessário quando o estado vier de um espelho de `store.state$`.

---

## 5. Lacunas nos testes

| Falta testar | Por quê importa |
| --- | --- |
| Comando durante queda/reconexão **não é reenviado** | 4.1: risco de mudança fantasma em evento |
| `mixState` com estado parcial ou mesa lenta | 4.2 |
| Comandos simultâneos (dois `setLevel` em paralelo) | 4.3 |
| Desfazer depois de mudança externa | 4.4 |
| Modo mock **nunca** constrói `RealMixer` nem abre socket | requisito central do Lab, hoje só garantido "por construção" |
| Precedência de `MIXAI_MODE`, `--mock`/`--real` e `MIXAI_IP` | um erro aqui conecta na mesa errada |
| Console (`console.ts`) | zero cobertura; vai virar parser |
| `undo` respeitando teto e limite por segundo | hoje não respeita |
| AUX não configurado recusado | 4.6a |
| Teste de carga leve (vários comandos/s de vários clientes) | Lab multiusuário |

---

## 6. O que reaproveitar no Lab

| Reaproveitar como está | Reaproveitar com mudança | Substituir |
| --- | --- | --- |
| `ChannelMap`, `normalize`, `ActionLog`, `config.ts`, `formatDB`, os 40 testes, o WebSocket falso de `real-adapter.test.ts` | `MixController` (fila + `applyChange` + revisão + confirmação com token); `MixerAdapter` (+ `snapshot()` e `subscribe()`); `MockMixer` → `LabMixer` persistente; `RealMixer` (espelho de `store.state$`, guarda contra reenvio); `console.ts` (extrair o parser) | `currentValue()` sob demanda, nas leituras de tela |

### Do repositório da biblioteca (MIT)

O `packages/testbed` é um app **Angular 22** com componentes de depuração (`fader-level-controls`, `eq-controls`, `vu-meter`, `prepost-controls`, `shows-page`). São controles `input type=range` com Bootstrap, **não uma interface de mesa** nem um simulador: ele só funciona conectado a uma mesa real. Vale como **referência de uso da API** (por exemplo, o mapeamento logarítmico de frequência em `eq-controls`), com atribuição MIT. Não vale como base de UI.

---

## 7. Fontes

- Código local: `src/**`, `test/**`, `node_modules/soundcraft-ui-connection/lib/**/*.d.ts`, `index.mjs`
- [soundcraft-ui (GitHub, MIT)](https://github.com/fmalcher/soundcraft-ui), clonado em 05/11/2026; último commit em 03/11/2026
- [Documentação da biblioteca](https://fmalcher.github.io/soundcraft-ui/)
- [Turra Music – Ui16](https://www.turramusic.com.au/products/soundcraft-ui16) e [Thomann – Ui16 bundle](https://www.thomann.de/be/soundcraft_ui16_wifi_bundle_set.htm): especificações de varejo (4 saídas AUX, EQ, dbx, RTA)
- Experimentos: `spike.mjs` (reenvio após reconexão) e `spike2.mjs` (latência do `mixState`), executados fora do projeto
