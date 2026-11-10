# Catálogo configurável de modelos — missão B

Backend opt-in, exclusivamente LAB. Branch criada de `origin/main` `fc3abb5`
(PRs #90/#91 incorporados). Sem Angular, mixer, AutoConfig CORE, núcleo D,
comandos, ferramentas de modelo ou mudanças de aprovação.

## O que está funcional

Catálogo HTTP v1 e port de geração consultiva por sessão. Ollama, Gemini,
DeepSeek, Anthropic e OpenAI usam o mesmo contrato público. IDs indicados na
configuração são sugestões, **não** allowlists nem IDs obrigatórios. O operador
pode validar/selecionar um ID novo pela API, sem reiniciar. Cada seleção e geração
usa uma instância nova ou exclusivamente vinculada à seleção; não chama
`selectModel` em clientes compartilhados. Sessões têm revisões independentes.

Quatro adaptadores existentes foram reutilizados; não se duplicaram seus protocolos.
Gemini/Ollama agora preservam contagens fornecidas pela API. Ollama aceita teto de
tokens por instância, mantendo seu padrão anterior fora do catálogo. O adaptador
OpenAI novo usa `POST https://api.openai.com/v1/responses`, apenas texto, sem
ferramentas, sem streaming, com `store:false` e sem raciocínio exibido. Só mensagens
concluídas de assistente são devolvidas. Recusa, truncamento ou tipos inesperados
não viram respostas concluídas; não há execução nem interpretação de comandos.

**Este catálogo não muda a escolha global do diagnóstico/RAG ou do planejador
legado.** O painel Angular ainda não foi implementado nesta missão. A integração
do assistente da missão A deve consumir o port descrito abaixo; não declarar que
a seleção deste catálogo já controla M1/RAG/AutoConfig ou a UI existente.

## Configuração e chaves

`modelCatalog.enabled` é false por padrão. Nenhuma rota/call é montada em MOCK/REAL
ou quando desabilitado. Ativar/configurar provedores e preços é tarefa de
administração do servidor; trocar IDs de modelo na sessão não requer restart.
Alterar configuração de preços, habilitações e credenciais requer restart nesta versão.
A habilitação específica herda `knowledge.<provider>.enabled` se não houver override;
Ollama é local e OpenAI começa desabilitado. Catálogo e base documental têm habilitações
independentes; habilitar o catálogo não habilita ingestão/RAG.

```yaml
modelCatalog:
  enabled: true
  maxOutputTokens: 1024
  maxInputBytes: 12000
  timeoutMs: 30000
  unknownPricePolicy: block
  providers:
    ollama:
      enabled: true
      models: []  # usa o modelo local configurado como sugestão; aceita outro ID
    openai:
      enabled: true
      models: []  # sem ID GPT obrigatório; o operador informa o modelo
      prices: {}  # sem preço: valida metadados, mas bloqueia geração paga
```

Cada entrada de `prices` é uma estimativa **explicitamente configurada** por ID:
`{inputPerMTok: número, outputPerMTok: número}`, em USD por milhão de tokens.
Consultar a tabela oficial do modelo/conta antes de preencher; não há valor sugerido
para modelos desconhecidos. Outros provedores seguem o mesmo formato. Para
DeepSeek/Anthropic, na ausência de preço do catálogo, utiliza somente uma entrada
explícita de `knowledge.external.prices`, sem inventar um preço de fallback.
Ollama não recebe custo de API mesmo que alguém configure um preço para esse ID.

Chaves só em `config/secrets.yaml` (fora do Git) ou ambiente do **servidor**:

| Provedor | Campo de segredo | Variável |
| --- | --- | --- |
| OpenAI | `openaiApiKey` | `MIXAI_OPENAI_API_KEY` ou `OPENAI_API_KEY` (a primeira prevalece) |
| Gemini | `geminiApiKey` | `MIXAI_GEMINI_API_KEY` |
| DeepSeek | `deepseekApiKey` | `MIXAI_DEEPSEEK_API_KEY` |
| Anthropic | `anthropicApiKey` | `ANTHROPIC_API_KEY` |
| Ollama | nenhuma | URL local já validada por `knowledge.ollama.url` |

OpenAI aceita chaves de 8..300 caracteres. Chave no `config.local.yaml` é recusada,
inclusive os nomes OpenAI em snake_case. Nenhuma chave, URL alternativa, consentimento
forjado, sessão, orçamento ou ferramenta é aceita nos corpos HTTP do catálogo.
GET não sonda a rede nem transmite prompts. Endereços externos são fixos dos
adaptadores; headers de autenticação não aparecem em URL, erros ou logs de uso.
Não ler/validar chaves reais para executar testes: todos os testes usam chaves fictícias.

## Contratos públicos para o Agente C

Schemas e tipos em `src/ai/model-catalog/contracts.ts`; portas e tipos inferidos de
respostas `ModelCompletion`/`ModelValidation` exportados em `index.ts` para imports
**type-only**. Não importar factory/serviço/chaves em runtime no Angular.
Autenticação pelo Bearer já existente. Operador obrigatório; músico/agente MCP não
ganham acesso. Guardas centrais de proxy/ingresso permanecem os mesmos.
Todas as respostas têm `Cache-Control: no-store`; mutações validam origem.

| Método/rota | Entrada v1 | Resposta |
| --- | --- | --- |
| GET `/api/ai/models` | nenhuma | `ModelCatalogView`, sem sondagem de provedores |
| POST `/api/ai/models/validate` | `schemaVersion, provider, model, confirmExternal?` | metadados de disponibilidade/preço; não seleciona nem concede consentimento persistente |
| POST `/api/ai/models/selection` | mesmos campos + `expectedRevision` | nova visão da sessão; incrementa revisão depois da validação |
| DELETE `/api/ai/models/selection` | `schemaVersion, expectedRevision` | limpa seleção/consentimento daquela sessão, incrementa revisão |
| POST `/api/ai/models/complete` | `schemaVersion, expectedRevision, text` | texto consultivo não executável, resultado codificado e custo estimado |

Exemplo de seleção (o ID é um placeholder informado pelo operador, não modelo instalado):

```json
{"schemaVersion":1,"provider":"openai","model":"ID_DO_MODELO","expectedRevision":0,"confirmExternal":true}
```

A visão pública contém `schemaVersion:1`, `mode:"LAB"`, `revision`, `selection|null`,
`consent:{required,granted}`, `providers` com `id/enabled/configured/external`,
`acceptsCustomModelId:true`, sugestões `models:[{id,price|null,generationAllowed}]`,
limites de tokens/bytes/orçamento/rate e consumo agregado do registro compartilhado.
`configured` informa apenas presença de configuração/chave; não comprova validade.
Modelo fora das sugestões é permitido; `/validate` dá seu estado/preço sem registrá-lo
numa lista global. `price:null` significa desconhecido, não gratuito.

IDs têm até 128 caracteres, sem espaços, controles, URLs, `..` ou `//`.
Provedores externos usam o formato suportado pelos clientes atuais (2..80,
letras/números/ponto/hífen/underscore). Ollama aceita namespaces e tags (`nome/tag:versao`).
IDs externos com formatos novos como identificadores fine-tuned com dois pontos
precisam de extensão explícita do adaptador e testes; não são aceitos como URL.
Não são enumeradas todas as páginas de modelos dos provedores. A seleção consulta
metadados/saúde do modelo específico (DeepSeek usa sua listagem), incluindo
`/v1/models/{id}` para OpenAI. Metadados acessíveis não garantem compatibilidade
com Responses, capacidades de texto, contexto, latência ou permissões de geração.
Incompatibilidades são tratadas como falhas, sem trocar silenciosamente de modelo.

`/complete` inclui instrução técnica fixa do servidor, recebe somente o texto que o
operador decidiu enviar e **não** busca documentos privados, histórico, áudio, estado
da mesa ou contexto de AutoConfig. Conta os bytes UTF-8 de instrução + texto no teto.
A saída contém `selection` com o modelo pedido e revisão, `result:{model,text?|failure?|reason?|usage?}`,
`cost:{status,priceModel,estimatedUSD,usageReported}` e `execution:"not_executable"`.
Falha de provedor é resultado HTTP 200 com `failure` e sem texto parcial; guardas
locais usam HTTP de erro. Não existe fallback automático, replay ou retry.
O painel deve usar interpolação textual, nunca interpretar a resposta como HTML,
comando, ferramenta ou aprovação. Não enviar sugestões desse texto para execução.

Erros locais sanitizados `{schemaVersion:1,code}`:

- 400 `INVALID`: corpo, modelo, versão, campos extras ou tamanho incorretos.
- 401 `UNAUTHORIZED`: sem sessão, revogada/expirada ou resultado depois do logout.
- 403 `FORBIDDEN`/`NOT_CONSENTED`: perfil/origem/modo ou consentimento ausente.
- 409 `STALE`/`BUSY`/`PRICE_UNKNOWN`: revisão antiga, operação concorrente, preço ausente.
- 422 `MODEL_UNAVAILABLE`: modelo/conta sem metadados de disponibilidade.
- 429 `RATE_LIMIT`/`BUDGET`: rate ou reserva diária recusada.
- 503 `DISABLED`/`NOT_CONFIGURED`/`UNAVAILABLE`: configuração, chave ou falha interna.
- Catálogo não montado: 404. Respostas 401 podem usar o envelope central de autenticação
  já existente (sem `schemaVersion`); o painel deve tratá-las como sessão encerrada.

## Sessão, concorrência e consentimento / missão A

A concessão é efêmera por **sessão + provedor + modelo + revisão**, nunca por chave
presente ou preferência em disco. Toda seleção externa e sondagem de metadados exige
confirmação explícita para aquela operação. A sondagem sozinha não concede geração.
Troca para outro modelo exige nova confirmação; outra sessão não herda nem perde
consentimento pela seleção desta. Logout, expiração, clear e shutdown revogam.

Cada sessão tem no máximo uma seleção/sondagem e uma geração pendentes; existem
limites globais de 8 sondagens, 8 gerações e 128 estados de sessão. Autenticação e
consentimento são verificados antes do envio e depois da resposta. Seleção nova,
clear ou revogação durante geração descarta a resposta anterior; o consumo já
ocorrido continua contabilizado. Não muda o modelo ou preço de uma requisição em voo.
Timeout não prova cancelamento remoto; o cliente HTTP tem AbortSignal, o serviço
tem prazo adicional e não usa o texto recebido depois do prazo. Nenhum replay.

Portas exportadas: `ModelConsentPort` (`grant/allowed/revoke`, escopo tipado) e
`SessionConsentBackend` compatível com `ExternalConsent.selection/allowed/revoke`
do contrato consultado na main e nos PRs #92/#93. A composição atual usa
`SessionModelConsent(() => new ExternalConsent())`, instâncias **privadas por sessão**
e escopo adicional por modelo/revisão, incluindo a revisão do backend para não reviver
respostas após revogação/reconfirmação. A lista de provedores aceitos pelo contrato
#93 é respeitada: Gemini/DeepSeek/Anthropic delegam a A; OpenAI usa somente o
consentimento explícito e estrito do catálogo. Não o apresenta como Gemini nem
como aprovado por A. A pode estender o port/registro posteriormente.
Não reutiliza o singleton global de
`core.externalConsent`, cujo `selection()` limpa as concessões de todos: isso
violaria o isolamento deste catálogo. Nenhum arquivo de consentimento de A foi editado.

`startServer` admite `modelCatalogConsent` para futura autoridade de A e
`modelCatalogFetch` para mocks. Alternativamente, A pode consumir
`ModelCatalogService.generate(actor, system, user, expectedRevision)` dentro de seu
pipeline validado/redigido, mantendo a origem do ator no servidor. `view` permite
capturar a revisão antes do await. `active` vem da autenticação existente; hooks de
revogação são registrados e removidos no encerramento.

**Dependência explícita:** o assistente/RAG/planejador legados ainda não consomem esse
port de seleção. Sua migração cabe à missão A/integração posterior, após revisão.
Os PRs #92/#93 foram somente consultados, não incorporados. Revogar consentimento no painel
legado não é uma chamada ao clear do novo catálogo; o painel C deve usar as rotas
novas ou um adaptador explícito de revogação de A. Não afirmar consentimento global
unificado entre fluxos sem essa integração. Não esperar outro agente para testar
este backend; ele funciona isoladamente e não concede permissões ao fluxo legado.

## Orçamento e registro

Reutiliza `UsageTracker` e a mesma instância por caminho absoluto de
`external-ai-usage.json` dos provedores externos existentes. Preserva reserva
persistida **antes** do POST, teto `knowledge.external.dailyBudgetUSD`, rate global
`maxRequestsPerMinute`, bloqueio por corrupção/falha de gravação e reservas em voo.
O diário é UTC, conforme o mecanismo existente. GET da visão traz só contagens,
reservas, custo estimado e estado do registro, sem prompts/chaves/conteúdo.

Preço desconhecido **bloqueia antes da geração**. A política configurável nesta
versão é conservadora: `unknownPricePolicy:block` mais preços explícitos por modelo;
não existe bypass HTTP ou preço suposto. Também foi removido o fallback genérico
10/50 da factory legada: um `PricedProvider` adicional bloqueia preço ausente antes
de chamar o `BudgetedProvider` existente, mantendo `quota/budget` e log codificado.
O arquivo de orçamento de A permanece idêntico à main, para preservar sua evolução
de reserva UTF-8 e demais correções, sem reimplementá-las.
Lookup de preços usa apenas propriedades próprias; nomes como `constructor` não
herdam acidentalmente um preço do protótipo JavaScript.

A reserva usa bytes de entrada + margem de envelope e teto de saída. Consumo
informado troca a reserva pela estimativa a preços configurados. Falha auth/quota
sem consumo libera reserva; timeout/rede/recusa/truncamento sem uso informado
contabilizam a reserva integral. Usage inexistente não vira contagem inventada.
Gemini usa prompt e total reportados (saída = total − prompt, incluindo raciocínio);
Ollama usa prompt_eval_count/eval_count. Tokens de raciocínio contam no teto OpenAI.
São **estimativas de proteção**, não garantia do faturamento: preço, cache/tier,
aliases, limites de contexto e cobrança extra dependem do fornecedor/conta. O preço
configurado deve cobrir o ID/aliases que o operador escolheu; configurar incorretamente
zero ou um valor baixo compromete a proteção. Não se consulta nem deduz preço pela API.
Ollama registra tokens, mas custo de API é zero. Auditoria guarda somente provedor,
modelo, outcome, tokens e estimativa, nunca pergunta/resposta/chave.

## Validação e fontes

Módulos de teste: `model-catalog.test.ts`, `model-catalog-server.test.ts` e
`model-catalog-config.test.ts`.
Todos os cinco provedores usam HTTP falso; nenhuma chave real, chamada paga ou Ui16.
Cobrem IDs novos, formatos, papéis/origens, isolamento entre sessões/chaves, seleção
em voo, clear/logout, recusa de consentimento, port de A, quotas, deadline, falhas,
reserva concorrente, preço desconhecido/protótipo, tokens, Responses sem ferramentas
e ausência de escrita/execução no mixer. A lista de consumidores explícitos no teste
de arquitetura foi ampliada somente para os quatro arquivos do catálogo que reutilizam
contratos/clientes locais; não foi removida a verificação da base determinística.

Comandos: `npm run typecheck`, `npm run build`, `npm test`, `npm run test:web`,
`npm run build:web`, `npm run test:e2e`, `npm run smoke:yoga -- --built`,
`npm run test:https-lab`. Resultados/CI do SHA final estão no PR.

Referências oficiais consultadas em 2026-11-10 (sem executar APIs pagas):

- OpenAI Responses create: https://developers.openai.com/api/reference/resources/responses/methods/create
- OpenAI retrieve model: https://developers.openai.com/api/reference/resources/models/methods/retrieve
- Contrato de consentimento de A: `src/server/external-consent.ts`, PRs https://github.com/dodoxbr/MixAI/pull/92 e https://github.com/dodoxbr/MixAI/pull/93

Pendentes: painel C, integração do port no fluxo A, ensaio consentido com modelos
reais, confirmação de preços/compatibilidade da conta e desempenho no Yoga físico.
Sem modificações de AutoConfig CORE, aprovações, rede, E6 ou escrita REAL.
