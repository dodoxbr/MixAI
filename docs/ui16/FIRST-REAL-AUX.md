# Primeiro envio AUX REAL — implementação e limites

Base desta entrega: main `dfc3494`, com PRs #97 (ponte), #99 (UX ao vivo) e #98
(operador IA, incluindo a reconciliação dos três). O caminho normal continua somente
leitura. Nenhuma Ui16 física foi acessada nesta entrega.

## Protocolo: o que sabemos

Fonte de código: `soundcraft-ui-connection@7.1.0`, versão fixada no lockfile;
`index.mjs`, `lib/facade/channel.d.ts`, `lib/utils.d.ts` do pacote instalado.

| Evidência | Conclusão | Limite |
|---|---|---|
| Código da biblioteca | Abre `ws://${targetIP}`, serializa `3:::`, envia `SETD` e recebe mensagens `3:::` separadas por newline | Não há endpoint novo nem negociação inventada |
| Setter AUX e conversores | CH **N**, AUX **A**: `3:::SETD^i.(N-1).aux.(A-1).value^${DBToFaderValue(db)}` | Valor normalizado não é dB linear |
| Store da biblioteca | Combina `conn.inbound$` e `conn.outbound$` | `read()` desse cache após envio não prova recebimento pela mesa |
| Socket injetado + biblioteca verdadeira | Setter emite exatamente um SETD do envio escolhido; confirmação depende de novo frame de entrada | Fixture sintética, não captura de firmware |
| Facade AUX | Pode expandir `linkedChannelIds` para entradas/AUX estéreo | Exigimos dados recentes `i.n.stereoIndex` e `a.a.stereoIndex` iguais a **-1**, sem vínculo; ausência bloqueia |
| F0 anterior (#43) | Leitura limitada de faders/mute e CH2/AUX1 | Não comprovou escrita nem ACK físico |

`stereoIndex` é um campo realmente selecionado pela biblioteca (`B` no bundle):
-1 significa não vinculado; 0/1 são membros de um par. Não usamos o valor default
interno da biblioteca como evidência: os dois campos devem chegar pelo socket na
mesma geração e dentro do limite de idade. Não enviamos `stereoIndex`, pre/post,
master, PA, mute, EQ, HPF, cenas, nem outro canal/AUX.

### Limitação técnica da confirmação

O protocolo analisado não fornece ID de operação, ACK causal ou timestamp do
dispositivo para SETD. A resposta **`observed_target`** significa: após o envio,
recebemos uma nova observação independente, no mesmo socket/geração, que coincide
com o alvo (tolerância existente de 0,05 dB). **Não prova que o MixAI causou a
mudança** nem que algum áudio melhorou. Uma mensagem antiga ainda em trânsito na
mesma conexão é indistinguível de uma observação atual se tiver o mesmo valor.
Esse limite está explícito em `causalAcknowledgement:false`.

Não há GET individual comprovado; nenhum foi inventado. Se o firmware não publicar
uma nova amostra depois de SETD, o resultado será `unconfirmed`, mesmo que o fader
tenha mudado na interface oficial. Isso pode impedir confirmação operacional até
a validação física. Timeout, divergência, alteração de vínculo, perda de conexão,
mudança de geração ou revogação não disparam retry, rollback ou undo automático.

## Uma fila e um executor

`FirstRealAuxService` é um adaptador de **prévia/confirmação humana**. Reutiliza
`ProposalBuilder`/`ProposalCard` para cálculo, revisão, validade e apresentação.
A aplicação chama exclusivamente `ServerCore.execute` e, dele, o `MixController`
existente: mesma fila, permissões, limites, revisão, rate limit, histórico e undo.
Não cria executor, fila de escrita ou acesso à rede para o modelo.

Dentro da fila, uma expectativa de autorização revalida sessão de operador,
geração, sequência, origem, registro de canal/AUX, validade e rota. A permissão
é para um alvo exato, consumida uma vez pelo adaptador; se não houver escrita
síncrona nessa tarefa, expira no próximo microtask. Assim, uma recusa/rate limit
não deixa uma autorização disponível para outro comando. Cada envio tem lock
no adaptador e no parâmetro da camada de prévia; a fila existente ainda serializa
todos os comandos, inclusive de HTTP, WebSocket e assistente.

O gate de transporte permite, além das consultas antigas F0, **somente o frame
exato** dessa permissão. Nenhum boolean do cliente abre o transporte. A leitura AUX
do adaptador e os eventos externos vêm do frame de entrada validado, não do cache
local. Uma tentativa pendente não apresenta o alvo otimista como observado. Falta
de confirmação deixa a leitura anterior stale até nova amostra; mensagens tardias
podem atualizar o estado observado, mas nunca reclassificam uma tentativa encerrada.

O assistente #98 continua recusando propostas REAL; agente e músico não podem usar
os novos endpoints. Não há alteração no núcleo D/AutoConfig, PINs, catálogo, roteador
IA ou telas. (Atualização PR #101: a tela supervisionada e a CLI de inicialização estão em [SUPERVISED-FIRST-WRITE.md](SUPERVISED-FIRST-WRITE.md).) A UI atual não ganha um botão REAL nesta entrega: o fluxo funcional é
backend/API autenticada, com cartões compatíveis com o contrato de propostas.

## Gate físico: desabilitado por padrão

Sem `FirstRealAuxGate` no bootstrap, a ponte recusa todas as escritas. `readOnly:false`,
configuração YAML, texto de IA e payload HTTP não habilitam o gate. `readOnly:true`
continua bloqueando mesmo se uma opção de gate for passada à fábrica.

O tipo `FirstRealAuxGate` só pode ser fornecido por código confiável de bootstrap
em `startServer(loaded, {firstRealAux: ...})` ou `createApp(loaded, {...})`:

- `validation:'simulated_transport'`: exige construtor de socket injetado; usado
  exclusivamente nos testes com transporte falso. Não usar um socket nativo nessa
  opção. O construtor injetado pertence à fronteira confiável do integrador.
- `validation:'supervised_protocol'`: exige referência sanitizada da validação
  supervisionada e `routeGuard` síncrono do integrador. A referência é uma
  **atestação administrativa**, não verificação automática de firmware. Esta
  entrega não contém essa evidência e não configura esse gate em nenhum entrypoint.
- `freshnessMs`: 3.000 ms por padrão (10..30.000); aplica-se ao envio e aos campos
  de vínculo. `confirmationTimeoutMs`: 1.500 ms por padrão (10..10.000).
- Geração READY, modelo relatado `ui16` e rota válida são obrigatórios. Modelo
  relatado não é autenticação criptográfica. A rota é revalidada na autorização
  e no instante do envio; não configurar uma função que sempre retorna true no
  bootstrap físico. Os gates F0 existentes permanecem necessários na validação.

Não disponibilizamos flag CLI, variável de ambiente ou endpoint para autodeclarar
validação física. O responsável deve completar o roteiro e revisar a configuração
confiável antes de iniciar um servidor com essa capacidade. Não é necessário editar
o executor nem afrouxar políticas para testar o fluxo com socket falso.

## Fluxo HTTP do operador (ainda sem UI REAL)

As rotas só são montadas no servidor REAL. Usam exatamente o token/PIN existentes,
checagem de sessão ativa e origem, sem persistir dados de prévia. O corpo é estrito;
não aceita campos de canal/alvo na confirmação nem campos de aprovação de modelo.
Não incluir token em logs, histórico de shell, documentação pública ou PR.

1. Login pelo fluxo existente e consulta de `/api/hello` para obter `serverId`.
2. POST `/api/ui16/aux/preview`:
   ```json
   {"targetMode":"real","serverId":"<instância atual>","channel":2,"aux":1,"deltaDB":0.5}
   ```
   Exige canal/AUX **cadastrados**, origem finita e atual, mudança efetiva máxima
   de min(1 dB, limite existente). Valor -∞, silêncio convertido, desconhecido,
   envelhecido, conexão parcial ou vínculo desconhecido não servem de origem.
3. Conferir o cartão retornado (`proposal.id`, `parameters`, `needsApproval:true`),
   `previous`, `requested`, `observed` e identificação AUX1/HA800 **compartilhado**.
   Prévia vale até 15 s; frescor das leituras pode expirar antes. Sem leitura nova
   não forçar aplicação nem substituir por cache.
4. Ação humana: POST `/api/ui16/aux/<proposal.id>/confirm`:
   ```json
   {"targetMode":"real","serverId":"<instância atual>","requestId":"operacao-unica","humanConfirmed":true}
   ```
5. Mostrar `confirmation.previous`, `.requested`, `.observed` (null se sem amostra, `"-inf"` para fader fechado),
   `.status`, `.reason`, `.source`, `.validation`, `.causalAcknowledgement`. Sucesso
   do executor só ocorre após `observed_target`; `unconfirmed` nunca é sucesso.
   Falhas anteriores ao envio retornam `not_sent` e mantêm as revisões/undo existentes.
   Mesmo requestId na mesma prévia retorna o resultado armazenado, sem enviar outra
   vez. Nova confirmação de prévia consumida é recusada. Após resultado incerto,
   inspecionar estado e preparar outra operação somente por nova ação humana.
6. Desfazer exige **outra prévia**, usando `{"targetMode":"real","serverId":"...","undo":true}`,
   e outra confirmação. Usa o topo real da pilha existente, só se tiver um único envio
   AUX cadastrado e reversão de até 1 dB. Mudança externa/revisão posterior protege
   o parâmetro; não há undo automático, em lote ou de master/PA/mute/EQ/HPF/cena.

Sessões distintas não veem/aplicam prévias umas das outras. Reiniciar descarta
prévias e permissões. Expiração e capacidade de memória são limitadas; nenhum
comando pendente é restaurado ou repetido após reconexão.

## Roteiro de validação física futura — não executado

1. Cumprir [checklist F0](PHYSICAL-CHECKLIST.md) e preparar operador presente,
   áudio/saídas desconectadas, backup manual, topologia/rota verificada. Sem E6 em
   produção; não usar `serve:real` como teste automatizado.
2. Na interface oficial, confirmar modelo/firmware, canal seguro e AUX cadastrado,
   sem vínculo estéreo em ambos, e efeito compartilhado do AUX1. Não alterar rede
   ou firmware para facilitar o teste.
3. Com observação somente leitura, identificar frames de entrada de envio e
   `stereoIndex` em ambos os destinos; registrar evidências sanitizadas da versão.
4. Validar primeiro o setter via fixture/transportes falsos. Só então obter decisão
   explícita do responsável para a sessão supervisionada e fornecer o gate confiável
   com referência de evidência e verificador real de rota.
5. Operador prepara uma mudança de **0,5 dB**, confere os três valores e confirma uma
   vez. Capturar envio exato e nova **entrada independente**; conferir manualmente o
   fader na interface oficial. Não contar cache/echo como entrada e não repetir
   automaticamente se não houver frame de volta.
6. Exercitar divergência, queda antes/depois do envio, retorno, atraso e alteração
   simultânea por outra interface. Conferir `unconfirmed` sem retry/rollback;
   master e demais parâmetros não podem mudar. Se faltar publicação do parâmetro,
   interromper: não há confirmação confiável demonstrada para esse firmware.
7. Se confirmado por observação, fazer outra prévia/confirmação humana para desfazer;
   comparar estado, revisar eventuais alterações externas e referências de revisão.
8. Encerrar sessão, desabilitar gate e registrar resultados sanitizados. Só o
   responsável decide próxima fase; merge desta entrega não autoriza uso físico.
