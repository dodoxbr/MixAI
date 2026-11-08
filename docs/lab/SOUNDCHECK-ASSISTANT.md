# Assistente de passagem de som — Issue #66

Base: `632f25e` / PR #67 incorporado. O assistente está na Mesa do operador,
**Passagem de som — assistente LAB**. Não depende de IA, conexão externa, áudio,
modelo ou banco de conhecimento. Não modifica chat nem motor técnico.

## Operação

1. Entre com a senha de operador existente. Crie evento com nome, data e operador
   declarado. Nome declarado não substitui a identidade da sessão autenticada.
2. Siga as treze etapas. O mapa do plano inclui CH1 Cavaco, CH2 violão de seis cordas
   P10, CH3 Fred lead, CH4–7 vozes de apoio, CH8 Surdo, CH9 Pandeiro e CH10 Tantã.
   Confira com o operador a ligação física: nomes/configuração são metadados, não
   detecção de instrumento. O evento congela também os nomes configurados da banda.
3. Registre relato, observações, problema e verificações (uma por linha, até dez).
   Declare equipamento confirmado ou desconhecido. Aprovação é humana: não implica
   validação física/acústica. Gain não tem alvo numérico imposto pelo aplicativo.
4. Salve cada etapa. `pending` e `problem` mantêm pendência; `verified` exige
   confirmação humana. `not_applicable` exige confirmação e motivo. Para resolver
   um problema, reveja a etapa e registre uma nova revisão; a anterior fica no histórico.
5. AUX1 alimenta todos no HA800. Confira retorno por relato/escuta humana; não há mix
   independente por músico. Balanço conjunto é escuta humana, nunca medição do LAB.
6. A etapa Show/Snapshot é **instrução manual para um ensaio físico autorizado**.
   No LAB, marque não aplicável se não realizado. O aplicativo não salva snapshot
   nativo, não carrega cenas, não faz recall e não instrui automação de escrita.
7. Conclua o registro somente sem pendências. Evento concluído é imutável; novas
   passagens usam outro evento. Pausar preserva tudo que já foi explicitamente salvo.

Campos em edição não são autosalvos. Confirme a resposta antes de fechar a página.
Não há retry/replay automático de gravação. Após conflito, use **Atualizar eventos**,
revise o estado atual e refaça conscientemente a edição.

## Interrupção, persistência e recuperação

A entidade `soundchecks` é uma extensão aditiva do documento existente
`mix-reference-requests.json` (esquema 1), com plano/evento versão 1. Não há outro
banco, arquivo por evento, cópia da fila nem uma segunda implementação de cenas.
Documentos anteriores sem `soundchecks` abrem com lista vazia. As gravações continuam
usando `ReferenceStore`: leitura fresca, revisão global, arquivo temporário/rename,
backup `.bak`, limite 16 MiB e OwnerLock de um processo. Não é um banco distribuído.

Cada evento tem revisão própria, histórico com sessão do operador, timestamp,
ação e cópia da etapa registrada. Revisões concorrentes de dois operadores retornam
409, sem sobrescrever o outro. Até 50 eventos, 200 revisões por evento e vinte
solicitações vinculadas. A última revisão é reservada ao encerramento; ao atingir
limites não se apaga auditoria silenciosamente. Não há remoção automática de eventos.

Reabrir a página permite selecionar o evento salvo e suas pendências. Após reinício
do servidor, o evento em andamento aparece **interrompido**; um operador autenticado
deve retomar explicitamente antes de editar/concluir. Pausa também exige retomada.
A sessão antiga não é recriada. Novas requisições usam o novo `serverId`; envelopes
antigos são recusados. Histórico mantém autores e simulações do servidor anterior.

Arquivo corrompido/versão inválida falha fechado com 503, preservando original e backup.
Não há rollback silencioso de aprovações. Recuperação manual segue a documentação do
armazenamento de [referências e solicitações](MIX-REFERENCE-REQUESTS.md): encerrar
servidor, preservar cópias, investigar e validar explicitamente a cópia escolhida.

## Referências e solicitações

A referência usa `eventId` igual ao ID do evento; ligação registra ID e versão imutável.
Pode não existir — isso não bloqueia a passagem. O botão de salvar referência reutiliza
**a captura E5 existente**, mediante checkbox explícito, e grava cópia do estado LAB.
Não é snapshot nativo e não carrega/aplica nada. Comparar abre o painel existente,
somente leitura, e não disputa alterações externas. Referência de outro evento é recusada.

Captura da referência e vínculo no evento são duas operações: se o vínculo falhar por
concorrência/rede, a referência permanece listada no evento para revisão e vínculo manual.
Continua válida a limitação E5 já documentada de cena sem referência em falha entre arquivos.

Pedidos são vinculados por ID da fila existente. Operador vê o estado atual de cada
pedido vinculado; nenhuma fila é duplicada, nenhum diagnóstico vira comando. Atendimento,
cancelamento e permissões continuam no painel de solicitações. O vínculo é anotação
humana do evento; não muda autoria/canais/permissões do pedido.

## Contratos para B/C

`src/soundcheck/schema.ts` exporta plano, esquemas estritos e tipo `Soundcheck`.
`SoundcheckReadPort` só permite ler modo, sessão, estado e nomes. Não contém mixer,
controlador, aplicar proposta, carregar cena ou executar comando. Rotas no plugin de
referências reutilizam autenticação e política de entrada HTTPS existentes:

- GET `/api/soundchecks`: `schemaVersion`, `serverId`, plano e eventos com pendências.
- GET `/api/soundchecks/:id`: evento, referências daquele evento e pedidos vinculados.
- POST `/api/soundchecks`: `serverId`, `id` estável, `name`, `date`, `operatorName`.
- POST `/api/soundchecks/:id`: `serverId`, `expectedVersion`, `action`.
  Ações: `step` (objeto `step` conforme `HumanStep`), `pause`, `resume`, `complete`,
  `link_reference` (`referenceId`), `link_request` (`requestId`).

Usar o ID estável permite recuperar resposta perdida da criação sem duplicar eventos;
criação conflitante com conteúdo/autor diferente retorna 409. Edições são CAS e não
são repetidas automaticamente. Campo extra (`command`, observação falsa de servidor,
aprovação de outro ator) é recusado. Descoberta: GET autenticado fornece esquema/plano;
404 significa recurso ausente no servidor antigo. Não é necessário merge antecipado de B/C.

## Evidência e limites da validação

Dados digitados são relatos/aprovações humanas. Estado capturado na etapa é sempre
`source: lab_simulation`, `realReading: not_collected`, com disponibilidade, servidor,
revisão e valores de fader/MUTE relacionados à etapa. Em perda de conexão os valores
ficam `unavailable`; valores inexistentes ficam `unknown`. Não se fabricam VU, RTA,
frequências, gain ou provas de microfonia. Nenhuma leitura REAL é promovida a partir do LAB.

Somente LAB e operador ativo. Músico, agente MCP e sessão revogada não leem nem editam
passagens. MOCK/REAL não registram estas rotas; modo REAL não foi configurado/testado.
As duas senhas e permissões existentes permanecem. Sem comandos automáticos de fader,
EQ/HPF/gain/phantom/mute/master/cena nem escrita na Soundcraft física.

Testes cobrem primeiro/múltiplos eventos, duas sessões, concorrência, retomada após
reinício, pausa, pendências, aprovação, corrupção/backup, referência ausente/válida,
pedidos existentes, estado indisponível, zero comandos, E2E e autorização HTTPS.
Os builds web podem emitir aviso de orçamento de bundle (limite de aviso 400 kB);
o assistente tem carregamento adiado, sem alterar os limites de build.
Ainda exigem validação supervisionada: ergonomia/touch Yoga/Android, rede privada,
firmware, correspondência de cabos/equipamento e escuta acústica. F0/E6 não são
promovidos a autorização física por este assistente.

A regressão encontrou uma corrida no teste E2E de administração do conhecimento:
o aviso de importação precede a atualização da lista. O teste agora aguarda a lista
com o mesmo critério (pelo menos dez fontes), sem modificar o componente/motor de
conhecimento nem afrouxar o aceite.
