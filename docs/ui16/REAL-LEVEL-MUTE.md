# Ui16 — volumes e mutes por capacidade

Base: main `03baf75130fb3c2dc766c37f6c016177c0fd4fbe` (PR #100). Nenhuma mesa física foi acessada nesta entrega. O bootstrap normal e o F0 continuam somente leitura. Código + fixture não constituem validação física.

## Protocolo verificado em código

Fonte: **soundcraft-ui-connection 7.1.0**, versão fixada no lockfile. Arquivos consultados: `index.mjs`, `lib/facade/channel.d.ts`, `send-channel.d.ts`, `aux-channel.d.ts`, `master-bus.d.ts`, `soundcraft-ui.d.ts`. Setters de nível usam `DBToFaderValue`, setters de mute usam `setdBool`/`Number(boolean)`. Canais e AUX públicos são 1-based; o caminho serializado é 0-based.

| Categoria | Fachada existente | Campo SETD observado/emitido pela biblioteca | Escrita nesta versão |
| --- | --- | --- | --- |
| `pa_level` | `ui.master.input(N).setFaderLevelDB(db)` | `i.(N-1).mix` | Gate próprio, até 1 dB |
| `pa_mute` | `ui.master.input(N).setMute(boolean)` | `i.(N-1).mute` | Gate próprio, um canal |
| `aux_level` | `ui.aux(A).input(N).setFaderLevelDB(db)` | `i.(N-1).aux.(A-1).value` | Gate próprio, até 1 dB |
| `aux_mute` | `ui.aux(A).input(N).setMute(boolean)` | `i.(N-1).aux.(A-1).mute` | Gate próprio, um canal |
| `master_level` | stream de nível do master; setter da biblioteca existe | `m.mix` | **Somente leitura; capacidade reservada não habilitável** |

Envelope verificado: `3:::SETD^campo^valor`, um único frame/um único parâmetro por autorização. O módulo calcula apenas o frame esperado pelo gate; quem envia é o setter original da biblioteca. Não há endpoint, GET individual, ACK causal, formato de firmware ou chamada de rede inventados.

Volumes são convertidos de/para normalizado, nunca tratados como dB lineares. Mute aceita apenas boolean no contrato e 0/1 no protocolo. Master fechado é `"-inf"` na serialização; desconhecido/indisponível continua distinto. Volumes cuja origem ou alvo é -∞ não são elegíveis para esta operação incremental supervisionada; não são substituídos por um número inventado.

Setters podem expandir canais/AUX vinculados em estéreo. Por isso cada operação exige uma observação recente e independente de `i.n.stereoIndex = -1`; AUX exige também `a.a.stereoIndex = -1`. PA não exige um AUX inexistente. Ausência, envelhecimento ou mudança do vínculo bloqueia a operação. O gate exato permite só um frame e sela o transporte se a biblioteca tentar enviar outro.

## Uma arquitetura e gates independentes

A implementação **amplia** `Ui16AuxHandshake` e `FirstRealAuxService` do PR #100. Os nomes históricos foram preservados por compatibilidade; não existe uma segunda implementação de RealMixer, handshake, executor, fila ou pilha de desfazer. O singleton `realControlsFor(core)` é compartilhado entre prévias do assistente e rotas novas/legadas.

Fluxo: parser/intent → `ProposalBuilder` → prévia com anterior/alvo/revisão → confirmação humana explícita → `ServerCore.execute` → `MixController` → `Ui16RealBridge.write` → setter da biblioteca → **nova entrada independente do socket**. As revisões, permissões, limites, histórico e undo permanecem nos componentes existentes. O núcleo D, modelos/provedores, catálogo e Angular não foram modificados.

`Ui16ControlGates` é opção **de código confiável de bootstrap** (`realControls` em createApp/startServer), ausente por padrão. Cada uma das quatro categorias recebe seu próprio gate/referência. O gate antigo `firstRealAux` só equivale a `aux_level`; configurar os dois para AUX level é erro, sem precedência silenciosa. Habilitar uma categoria não habilita nenhuma outra. LAB/Ui12/Ui24 não aceitam esses gates.

Cada gate conserva os requisitos do PR #100: modelo relatado Ui16, conexão READY, socket aberto, rota validada antes e no envio, frescor (padrão 3 s), timeout (padrão 1,5 s), geração/seq/origem exatos, operador ativo e prévia válida (15 s). Refusam-se alterações acima de **min(1 dB, limite existente)**. Mute exige mudança efetiva de um único boolean. Não há lote, cenas, gain, phantom, EQ/HPF, AFS2 ou alteração de roteamento.

- `simulated_transport` exige construtor WebSocket injetado e é usado somente em testes com socket falso. O integrador é responsável por não injetar um socket nativo como fixture.
- `supervised_protocol` exige referência administrativa sanitizada e verificador de rota. A referência atesta uma decisão humana; não comprova firmware automaticamente. Cada categoria exige sua evidência e decisão específicas.
- `readOnly:true` na fábrica remove **todos** os gates, inclusive o legado. `readOnly:false`, YAML, variável de ambiente, HTTP ou texto do modelo não habilitam categorias.
- Nenhum entrypoint CLI/serve desta entrega fornece gates. Não se deve editar o bootstrap para executar a validação automatizada em hardware.
- `master_level` admite apenas a declaração reservada `{ enabled: false }`. O backend, handshake e transporte recusam sua escrita, mesmo com gates de todos os canais. Antes de futura habilitação é preciso plano separado que integre aprovação crítica E2, limite e evidência física específica; não se contorna a aprovação do master.

## Observação, confirmação e desfazer

Todos os cinco grupos de controles (incluindo master) agora usam a **entrada bruta validada** para leituras e notificações externas. O store da biblioteca incorpora saída local: esse cache não é retornado como confirmação, nem promovido a revisão externa. Enquanto há tentativa pendente, a leitura não afirma o alvo otimista. Sem confirmação, fica stale até nova amostra; na desconexão a geração é descartada.

O relatório existente inclui `category`, chave, `previous`, `requested`, `observed` (boolean preserva **false**, ausência é null, -∞ é `"-inf"`), `status`, `reason`, geração, `source: independent_socket_input`, validação e `causalAcknowledgement:false`.

- `observed_target`: nova entrada da mesma geração coincide com o alvo antes do prazo; **não prova causalidade nem qualidade de áudio**.
- `unconfirmed`: houve tentativa de envio, mas timeout, divergência, perda, revogação ou configuração impediram confirmação. Não há retry, rollback ou undo automático.
- `not_sent`: a autorização/estado/rota/limite expirou ou foi recusada antes do envio.

Uma resposta tardia de socket aposentado é ignorada. Uma observação depois do prazo não muda um resultado encerrado; pode atualizar a leitura corrente e exigir nova prévia humana. Uma mensagem antiga ainda em trânsito na **mesma conexão**, sem ID/timestamp do dispositivo, é indistinguível de uma atual se coincidir com o alvo. Não se afirma ter resolvido esse limite do protocolo; a publicação e a semântica exigem validação física.

Desfazer prepara outro cartão a partir de `MixController.peekUndo`, exige topo com um único parâmetro elegível e nova confirmação/gate da **mesma categoria**. Preserva o valor anterior real (inclusive false de mute), revisão e identidade do topo; mudança externa não é sobrescrita. Undo de lote/master/cena/EQ/HPF é recusado. Resultados duplicados da mesma prévia/requestId são recuperados sem envio repetido; outra chave de confirmação de uma prévia consumida é recusada.

## API e assistente, sem componentes Angular novos

Rotas existem somente no servidor REAL e exigem o operador/sessão/PIN já existentes, Origin válido quando presente e corpos estritos. Não há endpoint de habilitação de capacidade. Nunca colocar tokens ou IPs da sessão em documentação pública/logs.

- GET `/api/ui16/controls`: capacidades `enabled`/`available` por categoria e leitura detalhada do master. `available` é condição geral da categoria, não uma autorização para qualquer canal; cada prévia revalida cadastro, valor e vínculo. O campo `hardwareValidation: pending` permanece explícito.
- POST `/api/ui16/controls/preview`:
  ```json
  {"targetMode":"real","serverId":"<instância atual>","operation":"level","channel":2,"aux":1,"deltaDB":0.5}
  ```
  Sem `aux`, destino é PA. Para mute: `operation: "mute"`, `muted: true` (ou false), sem `deltaDB`. Desfazer: somente campos comuns + `undo:true`. Master é recusado explicitamente.
- POST `/api/ui16/controls/<id>/confirm`:
  ```json
  {"targetMode":"real","serverId":"<instância atual>","requestId":"operacao-unica","humanConfirmed":true}
  ```
  Não aceita canal, destino, valor, ferramentas ou aprovação da IA no corpo da confirmação. O servidor conserva o comando exato da prévia. A rota AUX antiga continua restrita a AUX level e não confirma propostas de outras categorias.

No assistente, “Sobe 0,5 dB do violão no PA”, “Muta o canal 7 no PA”, “Desmuta o violão nos fones” e “Desfaz o último ajuste” passam pelo parser/cadastro existentes e geram **apenas prévias** quando a categoria estiver habilitada. Sem destino inequívoco, pergunta; passos configurados maiores que o limite REAL são recusados, sem reduzir silenciosamente o pedido. O mapa de produção continua violão CH2/Fred CH3. “Quanto está o master?” retorna leitura conhecida, -∞ ou indisponível, sem proposta.

`ProposalCard.realControl` acrescenta `targetMode`, `serverId`, `category` e `confirmationPath`. A integração futura da UI deve mostrar esse modo/categoria e usar o endpoint explícito de confirmação; o botão Aplicar legado (`assistant.apply`/WS) continua **incapaz de escrever REAL**. Relato e diagnóstico não geram correção automática. O interpretador selecionável e o catálogo continuam com seus limites LAB existentes; esta entrega não habilita provedores externos no REAL nem altera modelo/consentimento. A via em linguagem natural entregue no REAL usa o parser local do assistente, não um novo acesso de execução ao modelo.

## Roteiro físico futuro e evidências por categoria

**Não executado.** Completar primeiro [PHYSICAL-CHECKLIST.md](PHYSICAL-CHECKLIST.md) e o roteiro [FIRST-REAL-AUX.md](FIRST-REAL-AUX.md). Cada categoria requer uma sessão/evidência específica; aprovação de AUX level não autoriza PA/mute/master.

1. Operador presente, backup/revisão dos valores, identificação modelo/firmware/canais/AUX e topologia/rota observada. PA, amplificador de fones e fones desconectados. Não modificar rede, firmware ou proteção do Windows para facilitar teste.
2. Observar em leitura o campo alvo e os vínculos mono, comparando com a interface oficial. Registrar versão da biblioteca e firmware; não usar default do cache como evidência.
3. Obter aprovação explícita do responsável para **a categoria**; manter todas as outras desabilitadas. Só o integrador confiável pode fornecer gate com referência sanitizada e rota real, sem função constante usada como falsa verificação.
4. Volume: um canal, passo inicial 0,5 dB. Mute: um canal seguro, conferir estado anterior/destino e confirmar uma vez. AUX1 afeta o HA800 compartilhado. Comparar o frame produzido e nova entrada independente com a interface oficial.
5. Sem publicação, com divergência, vínculo, rota incerta, conexão parcial, timeout ou alteração concorrente: interromper; preservar o resultado não confirmado. Nunca contar cache/echo como prova nem repetir automaticamente.
6. Testar perda/recuperação, atraso, sessão revogada e concorrência manual. Conferir que não há replay e que outra categoria/master não mudou. Undo somente com nova prévia/confirmar e se o topo/estado ainda corresponder.
7. Encerrar/desabilitar o gate e preencher a tabela. Sem resultados aprovados específicos, escrita daquela categoria permanece desabilitada.

| Campo de evidência (sem segredos/rede identificável) | Preenchimento do operador |
| --- | --- |
| Categoria e referência administrativa | |
| Modelo/firmware/biblioteca, data e operador | |
| Canal, PA/AUX cadastrado e vínculos mono observados | |
| Valor anterior / solicitado / nova observação | |
| Frame sanitizado e comparação com interface oficial | |
| Resultado, razão, geração e limite de causalidade | |
| Timeout/perda/atraso/concorrência: resultado sem replay | |
| Nova autorização de undo e valor restaurado | |
| Demais categorias/master preservados | |
| Decisão do responsável / pendências / gates removidos | |

## Verificação automatizada

`test/ui16-real-level-mute.test.ts` usa a biblioteca verdadeira com **WebSocket falso**, além das regressões do PR #100 e da ponte. Cobre as quatro categorias, flags independentes, valores desconhecidos/-∞/false, limites, mono, autenticação, prévia, undo, concorrência, revogação dentro da fila, desconexão/reconexão, cache de saída, prazos, frames atrasados, lote e master bloqueados, protocolo exato e fluxo HTTP/assistente. Nenhum teste abre socket da Ui16, usa áudio real ou mede melhoria acústica.
