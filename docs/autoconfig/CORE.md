# AutoConfig v1 — núcleo exclusivamente virtual, Issue #72

A IA pode sugerir; somente o operador autenticado cria/revisa planos e autoriza cada
item. Este núcleo **não tem capacidade de escrever no mixer**. Nem o `LabMixer` é
movimentado. Um calculador em memória simula o valor, o backend verifica o retorno
e o operador revisa. Somente então uma referência virtual pode ser arquivada.
Não há UI nova: os agentes B/C consomem os contratos e rotas descritos abaixo.

## Fronteiras

- LAB e MOCK; rotas ausentes em REAL. O serviço também recusa REAL antes de ler
  estado/chamar capacidades. Não há flag, driver, CLI, transporte ou fallback REAL.
- Única operação v1: `level_delta`, um canal configurado por item, passo não nulo
  entre −3 e +3 dB, alvo finito entre −100 e +10 dB; no máximo oito itens distintos.
  Um plano cobre PA **ou** AUX1. AUX1 é compartilhado por todos no HA800.
- Não existem operações de phantom, gain/preamp, EQ/HPF, AFS2, master, mute,
  recall, cenas físicas ou MUTE em massa. Estes limites descrevem valores virtuais;
  não são uma recomendação sonora nem certificação de headroom/segurança física.
- Parser de comandos, assistente/LLM, controlador e transporte não são chamados.
  Sugestão, autorização, simulação e referência permanecem entidades distintas.
- Autenticação/PINs, política central HTTPS e permissões existentes são reutilizados.
  Músico/MCP não criam, aprovam, simulam nem leem planos. Nenhuma nova senha.

## Contratos B/C

`src/autoconfig/contracts.ts` exporta esquemas Zod estritos v1: `AutoConfigProposal`,
`Suggestion`, `AutoQuestion`, `AutoItem`, `SimulationResult`, `AutoPlan`,
`AutoConfigView`, `CreateAutoConfig`, `AutoAction` e tipos. `AutoConfigSuggestionSource`
é uma porta opcional para C produzir sugestões; não concede autorização nem é
ligada automaticamente ao motor. O backend funciona sem Gemini/Ollama/Claude.
`src/autoconfig/fixtures.ts` fornece propostas tipadas prontas e com contexto ausente.
Não fabrique aprovação/ID/observação a partir das fixtures: esses dados vêm do servidor.

A entrada permite somente evidência `human_report` ou `theory`, com texto limitado.
Não aceita observações verificadas REAL ou medições acústicas no payload. A observação
é capturada do estado do servidor; `context.origin` distingue `lab_simulation` de
`mock_simulation`. `realObservation` e `acousticMeasurement` ficam `unavailable`.
`availability.context: not_prepared` e valores `unknown`/`unavailable` são explícitos.
Nível `-inf`, ausente, desconectado ou alvo fora do intervalo gera pergunta, nunca
valor presumido. Perguntas têm ID de campo, mensagem e `required:true` por item.

`AutoConfigView` acrescenta `interrupted`, `stale`, contadores e `virtualState` ao plano.
Cada valor virtual traz `origin: isolated_simulation`, `appliedToMixer:false`.
`stale` considera revisão/conectividade, servidor, modo e revisão da passagem de som.
Esses dados não são leitura de som, RTA, SPL, VU real ou frequência de microfonia.

### API existente de autenticação, nova superfície de plano

Todas as rotas exigem Bearer de operador ativo, usam `no-store` e não aceitam origem
estrangeira para mutações. A entrada proxy recusa o token interno MCP com 401;
a autenticação MCP local permanece intacta, mas este recurso recusa o papel com 403.

- GET `/api/autoconfig`: versão, `serverId`, modo, canais configurados, capacidades e planos.
- POST `/api/autoconfig`: `{serverId,id,title,scope,items,eventId?,parentReferenceId?}`.
- GET `/api/autoconfig/:id`: `{plan,reference}`; `reference` é null antes do arquivamento.
- POST `/api/autoconfig/:id/actions`: sempre `{serverId,requestId,expectedVersion,action,...}`.

Use o ID estável na criação e nonce estável por ação; campos extras são recusados.
Não reenviar automaticamente depois de erro de rede: consulte o plano/recibo primeiro.
As ações são:

| Ação | Campos adicionais | Efeito |
| --- | --- | --- |
| `prepare` | `confirmed:true` | Captura contexto novo; descarta aprovações/resultados ativos, preservando a auditoria. |
| `revise` | `items` | Edita rascunho/perguntas antes de aprovar; após aprovação exige nova preparação. |
| `approve` | `itemId,digest,confirmed:true,scope:'simulation_only',expectedStateRevision` | Uma autorização de operador para aquele item/digest. Não existe aprovar tudo. |
| `simulate` | `itemId,approvalId,expectedStateRevision` | Consome autorização uma única vez, chama calculador virtual, verifica retorno. |
| `review` | `itemId,accepted,assessment` | O operador que autorizou avalia resultado virtual aprovado pelo verificador. |
| `undo` | `itemId,resultId,confirmed:true,expectedStateRevision` | Desfaz apenas a visão virtual do item, recusando contexto externo alterado. |
| `cancel` | `reason` | Rejeita o plano e aborta teste pendente; registra motivo. |
| `save` | `confirmed:true,expectedStateRevision` | Arquiva itens revisados como referência virtual, sem aplicação no mixer. |

B deve mostrar antes/depois, origem e limites, solicitar consentimento **por item** e
obter o digest/approvalId do servidor. C entrega sugestões versionadas; não deve chamar
aprovação/execução em nome do operador. Não enviar segredos, chaves, tokens ou áudio em
rationale/evidence. Não transformar texto de recomendação em comandos.

## Máquina de estados e concorrência

Um item segue `draft → needs_info → proposed → approved_for_lab → simulated → reviewed
→ saved`, podendo ir a `rejected`, `expired` ou `failed`. `needs_info` é pulado quando
não há perguntas. `approved_for_lab` é o nome canônico também no MOCK; a aprovação
continua **simulation_only**, sem autoridade sobre qualquer transporte.

O estado do plano é agregado: havendo itens aprovados ele mostra `approved_for_lab`,
mas isso NÃO aprova os outros; cada item continua autoritativo. Revisão final exige
que todos sejam revisados, rejeitados ou falhos e ao menos um tenha resultado aceito.
`failed` permite nova preparação explícita, não retry automático. `saved`, `rejected`
e `expired` são terminais. Para revisar referência salva, crie novo plano com
`parentReferenceId`, prepare/autorize/revise de novo e salve uma nova versão imutável.

Versão esperada protege cada mutação (409). Digest vincula spec, destino, observação,
alvo e contexto; o servidor verifica de novo, inclusive contra alteração de arquivo.
A autorização pertence à sessão que aprovou e não é transferida para outro operador.
Revogação, desconexão, mudança externa, troca de revisão da passagem ou contexto
anterior ao reinício recusam ação (401/409). Alteração de qualquer parâmetro observado
é conservadoramente considerada conflito, mesmo que fora do canal do item.

Nonce repetido com mesmo corpo/ator retorna estado atual e `receiptVersion`, sem nova
execução; corpo alterado no mesmo nonce dá 409. Repetição durante teste pendente dá
conflito; nunca inicia outro teste. Um teste por plano é permitido de cada vez.
A simulação incrementa versão ao iniciar e ao terminar: B deve atualizar seu modelo.

## Falhas e reversão

`AutoConfigSimulator` é uma porta confiável do servidor, recebendo apenas números,
canal/destino, IDs, modo LAB/MOCK e AbortSignal. O padrão é um calculador determinístico.
Não recebe mixer, controlador, autenticação ou callback de escrita. Não é configurável
via HTTP/arquivo de usuário. Não instale adaptador que acione transporte físico.

Timeout padrão: 1500 ms. Retorno malformado, divergente, exceção ou perda de sessão/
conexão falha fechado. Valor de retorno é verificado numericamente, não acusticamente.
Resultado que chega depois do timeout/cancelamento é descartado; não ressuscita plano.
Aprovação consumida não pode ser repetida: exige preparação e nova autorização.
No shutdown, callbacks são abortados e cercados para não gravar após liberar a trava.

Undo registra ator/momento e retorna a visão virtual ao valor inicial. Nunca envia
uma compensação ao mixer; contexto externo alterado retorna 409. Cancelar descarta
apenas o workspace virtual e mantém histórico. Rollback físico permanece inexistente.

## Persistência e referências

Reutiliza `ReferenceStore`, o documento `mix-reference-requests.json`, auditoria por
revisão, escrita atômica/backup, limites e `OwnerLock`. `autoconfig` é extensão aditiva
no esquema 1; documentos anteriores abrem com lista vazia. Nenhum segundo banco.
Um lock adicional do MESMO mecanismo protege o arquivo compartilhado em LAB/MOCK:
um produtor por dataDir, inclusive entre instâncias/modes. Instâncias paralelas de
MOCK precisam de dataDirs distintos. Nenhuma configuração REAL foi modificada.

Até 50 planos, oito itens, 100 entradas de auditoria/recibos e 16 MiB totais. Há reserva
para cancelar/expirar; nada é apagado silenciosamente. Planos não salvos expiram após
dez minutos, persistidos na próxima consulta/ação autorizada. Reinício não retoma teste:
requer preparação explícita com nova observação e aprovação; expirado exige novo plano.

`eventId` liga à passagem existente e congela sua revisão como contexto. Ausência de
passagem/referência é permitida para experimentos isolados (incluindo MOCK); não
atribui aprovação de passagem. Um ID fornecido inválido é recusado. O passo de sugestão
não modifica etapas/aprovações da passagem. `parentReferenceId` deve ser compatível.

Save reutiliza SceneStore E5 e ReferenceSchema, apenas com valores virtuais revisados.
A referência é `UNVERIFIED`, `simulation:{planId,mode,notApplied:true}`. Ela permanece
salva quando IA/simulador estiverem indisponíveis ou a sessão terminar. Não é snapshot
nativo Soundcraft. Nenhuma versão anterior é sobrescrita. Captura de cena e registro
continuam em dois arquivos: falha entre gravações pode deixar cena SIM sem referência;
recuperação é manual, sem load/recall. Corrupção falha fechado, sem rollback silencioso.

Para evitar confundir hipótese com estado observado, candidatos AutoConfig não aparecem
nas listas/comparações de referências observadas nem podem ser vinculados como tal à
passagem. Estão no detalhe AutoConfig e no armazenamento compartilhado, com marcação
explícita. Cenas E5 recebem nome `AutoConfig SIM` e descrição “NÃO APLICADA”. Carregar
manualmente uma cena no fluxo LAB existente é ação separada, nunca chamada pelo núcleo.

## Gate físico futuro — somente documentação

Antes de qualquer entrega de escrita física, exigir revisão/aceite separado de F0 #43
(leitura e conectividade ainda incompletas), desenho E6 #44, operador presente, áudio
isolado, escopo mínimo, rota/firmware validados, recuperação e nova autorização explícita.
NÃO há implementação desse gate nem opt-in de escrita nesta entrega. Não promover
aprovação ou referência virtual para REAL; até então utilizar a UI oficial em show.

Testes sem hardware não validam acústica, firmware, latência ou ergonomia Yoga/Android.
Os testes usam LAB/MOCK e calculadores controlados. A integração UI B e diagnósticos C
é futura pelos contratos publicados; o núcleo API já funciona sem depender desses merges.
