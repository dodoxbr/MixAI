# B3B — Conversa contextual por sessão (Issue #26)

O operador pode enviar **“Meu cavaco está estridente.”** e responder apenas **“PA.”**
ao esclarecimento seguinte. A fonte, o sintoma e a evidência afirmativa original
continuam no diagnóstico. Não há captura de áudio, propostas de alteração ou
ajustes a partir dessa conversa. Comandos explícitos continuam no fluxo E4/E2.

Branch exclusiva: `feature/sound-engineer-context`, criada da `origin/main`
atualizada em `10c2b48`. Merges conferidos antes de implementar: #25 (`418b205`),
#24 (`f8697ca`) e #23 (`10c2b48`). A árvore estava limpa; a branch anterior não
foi reutilizada. Não houve alteração de RealMixer, E6, F0 ou TLS/rede.

## Conversa e ciclo de vida

| Operador | Comportamento |
| --- | --- |
| Meu cavaco está estridente. | Pergunta PA ou FONES; assunto pendente aparece no chat |
| PA. | Continua o cavaco, mantém relato e referências e encerra o contexto básico completo |
| Minha voz está abafada. | Pergunta qual fonte/canal cadastrado |
| Fred | Seleciona Voz Fred e pergunta destino, sem inventar nova evidência |
| Fones | Identifica AUX 1 compartilhado, conclui o esclarecimento |
| sim / não / PA e Fones | Se não responderem inequivocamente ao campo pendente, pede clareza |
| Meu surdo está magro. | Inicia outro assunto com contexto e evidências novos |
| cancelar diagnóstico / cancelar / mudar de assunto | Encerra a investigação, sem tocar nas propostas de mixagem |
| novo diagnóstico / nova consulta | Descarta o assunto anterior e pergunta o sintoma |
| sobe o cavaco 2 dB no fone / muta o cavaco no PA | Prioridade para o comando explícito; encerra o contexto técnico e usa as proteções E4/E2 |
| abaixa o cavaco que está estridente | Mistura comando e diagnóstico: pede reformulação, sem proposta ou ajuste |
| PA / Fones / sim / confirmo, sem esclarecimento | Solicita nova queixa; não chama IA, não ajusta nem confirma operações |

A continuação cobre apenas os campos pendentes **sintoma, fonte/canal,
instrumento quando o cadastro não identifica um guia, e destino**. As perguntas
abertas dos procedimentos de inspeção não são preenchidas por “sim” nem viram
medições. Depois de concluir os campos básicos, uma nova queixa completa inicia
outra investigação; não existe uma memória geral de conversa técnica.

Somente a frase afirmativa que contém o sintoma é preservada como evidência.
No exemplo “Meu cavaco está estridente. O que podemos fazer?”, guarda-se o relato
“Meu cavaco está estridente.”. Frases interrogativas, negadas ou hipotéticas não
viram observação; escolher um sintoma por rótulo não fabrica um relato. Os IDs e
origens das evidências confirmadas são mantidos durante os esclarecimentos.

## Estado do servidor, isolamento e limites

`DiagnosticContexts`, em `src/assistant/diagnostic-context.ts`, pertence à instância
do `AssistantService`. A chave é o **ID da sessão/principal autenticado**, nunca
um ID enviado pelo cliente, PIN, papel ou nome do operador. Dois logins com o
mesmo PIN têm contextos distintos; conexões que usam o mesmo token disputam o
mesmo contexto por revisão.

- Prazo absoluto de **5 minutos** a partir da criação da investigação. Respostas
  válidas ou inválidas não renovam o prazo. Uma queixa nova cria outro prazo/ID.
- Apenas esclarecimentos pendentes são guardados; concluir ou cancelar remove a
  entrada. Comando direto explícito também encerra a investigação anterior.
- Logout e expiração da autenticação revogam a entrada. A expiração detectada por
  HTTP emite o mesmo evento de revogação do WS, inclusive sem socket aberto.
- Limpeza a cada segundo pelo ciclo existente do servidor e antes de toda consulta;
  a validade é conferida no limite exato do prazo. Parar/reiniciar o servidor limpa
  os mapas; não há disco, LLM, banco, compartilhamento entre instâncias ou replay.
- No máximo **128 investigações pendentes**, sem expulsar o contexto de outro
  usuário para aceitar uma nova. Limite adicional de **256 registros de sessão**
  para contadores e **20 consultas por minuto por sessão**. Contadores vencem em
  60 segundos; cancelamento válido e comandos diretos não são bloqueados por essa
  cota. A consulta estruturada B3A mantém seu comportamento anterior e não guarda
  contexto.
- O servidor guarda somente a entrada estruturada necessária (campos confirmados
  e trechos afirmativos das evidências), sem transcrição dos turnos. O texto do
  chat é limitado a 500 caracteres. Não se grava esse conteúdo em logs, histórico
  compartilhado ou contexto enviado a provedores. Um relato ainda pode conter
  informação pessoal fornecida pelo operador; não há promessa de anonimização.

A base de conhecimento permanece pura e isolada. O gerenciador de contexto não
recebe adaptador, estado da mesa, builder, fila ou aprovação. Ele só chama a
consulta especializada e seleciona a opção correspondente ao campo solicitado.

## Revisões e concorrência

Toda resposta com esclarecimento inclui `diagnosticContext` com ID aleatório,
revisão, expiração, assunto resumido, campo e pergunta. Ao selecionar um campo, a
revisão avança; ao trocar de assunto, o ID muda. A transição é síncrona: não há
`await` ou chamada externa entre conferir a revisão e atualizar o registro.

O cliente envia apenas `{id, revision}` junto da resposta. Uma revisão antiga,
ID de outra sessão ou contexto expirado retorna `DIAGNOSIS_CONTEXT_STALE`, sem
aplicar a resposta à investigação atual. O assunto atual da própria sessão pode
ser devolvido para orientar a tela, sem divulgar evidências de outra sessão.
Duas respostas concorrentes com a mesma revisão não podem avançar duas vezes.

Textos sem referência de revisão continuam aceitos para clientes simples: a
resposta é aplicada somente ao campo atualmente pendente, na ordem de chegada ao
servidor. Para detectar uma tela desatualizada, use a referência, como faz a UI.
Uma resposta curta sem pendência nunca reutiliza um diagnóstico concluído.

## HTTP e WS

A consulta B3A em `POST /api/assistant/diagnose` e WS `assistant_diagnose` continua
**estruturada e sem estado**. Seus campos e evidências não são usados como uma
atualização implícita de investigação pendente.

A conversa técnica usa `POST /api/assistant/conversation`, com Bearer de operador:

```json
{"text":"Meu cavaco está estridente."}
```

Resposta `{serverId, reply}`. Use o ID/revisão de `reply.diagnosticContext` no turno
seguinte (omita campos adicionais como assunto ou evidência):

```json
{"text":"PA.","context":{"id":"UUID retornado pelo servidor","revision":1}}
```

Pelo WS já autenticado, o chat atual aceita a mesma referência opcional:

```json
{"type":"assistant","requestId":"turno-2","text":"PA.","context":{"id":"UUID retornado pelo servidor","revision":1}}
```

Também existe o transporte explicitamente técnico:

```json
{"type":"assistant_conversation","requestId":"turno-2","input":{"text":"PA.","context":{"id":"UUID retornado pelo servidor","revision":1}}}
```

Resposta WS: `assistant_reply`. Zod estrito valida texto e referência. Campos de
identidade, comando ou confirmação no corpo são recusados. HTTP: 401 sessão
inválida, 403 perfil proibido, 400 entrada/comando inválido para essa rota técnica,
409 revisão desatualizada, 429 cota, 503 capacidade, 200 consulta/esclarecimento ou
cancelamento. O chat existente pode oferecer cartões de comandos diretos; a rota
HTTP/WS explicitamente técnica recusa comandos em vez de criar propostas.

Músicos e agentes não têm acesso à conversa técnica. A autorização e a validade
da sessão são verificadas no serviço e nos transportes existentes. Respostas são
somente para o solicitante, sem broadcast. Diagnósticos não geram proposta ou
pendência; a IA continua sem poder aprovar operações.

## Interface

Yoga e celular mostram assunto, pergunta pendente, prazo máximo e **Cancelar
diagnóstico** em uma região acessível (`role=status`). “PA” pode ser digitado no
campo atual. As opções usam somente rótulo e ID/revisão; não reenviam evidências
como autoridade do cliente. Opções antigas são desabilitadas após mudar de
revisão/assunto, concluir ou expirar a projeção local.

A tela mantém apenas essa projeção, não o estado autoritativo da conversa. Trocar
sessão limpa a conversa e o assunto; respostas atrasadas da sessão anterior são
descartadas. Não há sincronização automática entre abas: uma resposta com revisão
antiga recebe aviso e o assunto atual da mesma sessão. Perder WS não é logout;
reconectar com a mesma sessão pode continuar antes do prazo. Login novo não herda
contexto, mesmo com o mesmo PIN.

## Validação e limites

Testes unitários cobrem máquina de contexto, campos confirmados, evidências,
revisões, prazo exato, limites, cancelamento, descarte e reinício. HTTP/WS cobrem
sessões distintas, token compartilhado entre sockets, concorrência, logout,
expiração, falsificação de identidade/comando, cota, comandos prioritários e zero
builder/execute/write a partir da conversa. Testes de UI e E2E cobrem respostas
curtas, celular/Yoga, nova sessão, expiração e revisão antiga entre abas.

Não houve captura/medição acústica, chamada paga ou teste de hardware. A confiança
continua baixa com relato e insuficiente sem relato. VU não mede espectro ou
microfonia; os guias seguem não validados em ensaio. Não foram implementados
`propose_eq`, escrita REAL, E6 ou alterações de processamento da mesa.

Validação local em Linux/Node.js v24.22.1 (06/11/2026):

| Verificação | Resultado |
| --- | --- |
| `npm run typecheck` | Passou |
| `npm run build` | Passou |
| `npm test` | 483 testes, 44 arquivos; 24 novos testes unitários/HTTP/WS |
| `npm run test:web` | 84 testes, 10 arquivos; 3 novos testes de projeção, revisão e sessão |
| `npm run build:web` | Passou |
| E2E com Chromium | 67 testes, 10 arquivos; 5 novos cenários contextuais |
| Inspeção visual | Assunto, pergunta e cancelamento legíveis no Yoga e no celular |
| `git diff --check` | Passou |

O teste B3A que verificava a preservação do relato passou a esperar apenas a frase
observada, sem a pergunta adicional: essa mudança verifica minimização de dados,
sem relaxar as asserções de evidência, origem, permissões ou ausência de escrita.
Não foram reduzidos limites ou removidos cenários de regressão.

As capturas geradas pela suíte E7A foram restauradas à base; fotos de inspeção e
logs ficaram apenas em `work/`. O script dedicado `npm run screenshots` não foi
executado. Hardware, áudio real, provedores pagos e Windows local não foram
validados; o workflow existente executa Ubuntu e Windows. Não há bloqueio local
remanescente. Persistência, compartilhamento entre instâncias e conversa livre
sobre inspeções ficam fora desta entrega.
