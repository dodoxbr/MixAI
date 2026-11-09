# AutoConfig — interface do operador (#74 / PR #77)

> **Atualização:** o planejador C agora está conectado à tela; ver [END-TO-END.md](END-TO-END.md). O assistente de
> quatro etapas descrito aqui segue como caminho manual ("Definir teste manualmente (sem planejador)").

Atualizada com `origin/main` cd66766, incluindo o núcleo D do PR #80. Sem escrita no mixer, incluindo o mixer LAB. A interface consome somente `/api/autoconfig`; não chama comandos, LLM ou transporte Soundcraft.

## Uso

PIN de operador existente → **Passagem de som** → evento em andamento → **Iniciar AutoConfig LAB**. Navegação Mesa em um toque, painel no fluxo normal, sem sobrepor chat ou faders. Músicos não recebem acesso ou novas permissões. A entrada na passagem permanece LAB; o adaptador e o núcleo aceitam LAB/MOCK, nunca REAL. Não se habilitaram rotas de passagem em MOCK, que não existem na main.

Uma pergunta por vez: objetivo, canal, PA/FONES (AUX1 compartilhado), relato e passo virtual explícito. O passo começa em zero (não enviável) e deve ser definido pelo operador, dentro de ±3 dB, não nulo. **O planejador C ainda não está conectado**: nenhum número é uma recomendação automática da IA. O primeiro clique cria apenas um rascunho no servidor. **Preparar contexto no servidor** captura observação LAB/MOCK e descarta aprovações anteriores. Dados ausentes geram perguntas do próprio núcleo, exibidas sem presumir valores. Os campos de resposta de canal/passo enviam `revise` ao servidor, seguidos de preparação humana explícita; conexão/observação precisam ser resolvidas e preparadas novamente.

Cada item apresenta observação virtual antes/depois, diferença, relato/teoria, justificativa, limitações, validação e retorno. SIMULAÇÃO LAB permanece no cabeçalho aderente. Cadastro/revisão LAB não comprovam conexões físicas. Áudio, espectro, SPL e acústica não são medidos.

1. **Solicitar autorização deste teste LAB** envia `approve`; a tela continua não autorizada até o servidor confirmar. Não existe aprovação otimista, aprovação por texto de IA ou aprovar todos.
2. **Executar este teste simulado** envia o `approvalId` recebido do servidor, vinculado à sessão que aprovou, ao item/digest/contexto e à versão. O servidor verifica o valor virtual; nada é aplicado ao mixer.
3. Confirmar ou rejeitar o resultado envia `review`. **Desfazer somente cenário virtual** envia `undo` com `resultId`; nenhuma compensação física. Itens ainda não simulados podem ser descartados pelo cancelamento do plano, não por revisão fictícia.
4. **Salvar referência virtual no servidor** só é permitido depois da revisão exigida pelo núcleo. O servidor salva referência imutável `UNVERIFIED`, com `simulation.notApplied:true`. A referência permanece após logout/reinício, conforme limites de D.
5. **Iniciar novo plano LAB** permite outra configuração e nova versão de referência; não sobrescreve a anterior. **Consultar servidor** e o seletor carregam planos do evento e referências anteriores. A consulta é humana, não polling/retry de mutações. Carregar um plano ativo exige preparação explícita antes de reusar ações.

Download JSON contém somente um recibo validado da referência (ID, versão, status e origem simulada), sem credenciais, atores ou cena aplicável. Não é backup/snapshot Soundcraft, import ou restauração. As referências observadas da passagem continuam separadas das referências virtuais AutoConfig.

## Contratos e autorização

- `autoconfig-http.ts`: adaptador padrão autenticado por Bearer da sessão existente. GET `/api/autoconfig`, POST `/api/autoconfig`, GET `/api/autoconfig/:id`, POST `/api/autoconfig/:id/actions`. Caminho restrito, mesma origem, `no-store`, sem cookies/redirecionamento ou reenvio automático. Corpo JSON e AbortSignal. Nenhuma nova credencial.
- `autoconfig-contract.ts`: reutiliza **AutoConfigView e tipos canônicos de `src/autoconfig/contracts.ts`**, sem segundo esquema de aprovação. Valida respostas estritamente; o adaptador de apresentação só deriva rótulos de dados do servidor, sem criar approvalId/digest/observações/resultados. Workspace e recibo têm validação adicional. Plano recebido é conferido contra evento/servidor/modo; resposta de ação também precisa corresponder ao ID solicitado. Recibo precisa estar associado à referência/plano/modo corretos.
- Cada mutação usa `serverId`, nonce novo por clique (`requestId`) e `expectedVersion` atual. Aprovação envia digest e escopo `simulation_only`; simulação envia aprovação; undo envia resultado. `expectedStateRevision` vem do estado atual LAB/MOCK. Tudo é novamente validado por D: o frontend **não é fronteira de autorização**.
- Estado dos itens, histórico, contadores e referência são exclusivamente lidos de respostas do servidor. O navegador não escreve estado aprovado/simulado/revisado por conta própria. Um segundo operador não pode consumir a aprovação de outra sessão: D responde 403.
- Não foi alterado nenhum módulo de D ou C. Fixtures de apresentação foram removidas da produção; dados sintéticos existem apenas nas suítes. Não há fallback local se API/contrato/provedor estiver indisponível.

## Sessão, erros e concorrência

Troca de token/perfil, modo, servidor ou evento invalida respostas tardias, limpa dados da sessão e aborta leitura HTTP em andamento. A reconexão pode remontar a passagem; selecionar evento e consultar plano é explícito. Os dados persistidos do servidor só aparecem após leitura autorizada; isso é diferente de preservar campos locais privados do formulário.

Offline bloqueia ações. Timeout de 10 segundos aborta o HTTP e deixa resultado **indeterminado**: não afirma cancelamento/rollback remoto. 401 expira a sessão pelo mecanismo existente; 403/409/armazenamento/API indisponível mostram mensagens sanitizadas. Qualquer erro exige consulta ao servidor antes de continuar. Ler plano ativo coloca as ações em quarentena até nova preparação (descarta aprovações/resultados ativos no servidor). Nenhum teste é repetido automaticamente. Mudança de revisão também exige consulta/preparação.

Cliques simultâneos ficam serializados na UI; versão/digest/recibos/idempotência/owner/TTL/revogação são autoritativos em D. Cancelamento de plano só se confirma após resposta do backend. Não salvar automaticamente, carregar cenas ou promover referência para REAL. Expiração/reinício/resultado divergente são mostrados pelos estados e perguntas retornados pelo servidor.

## UX e testes

Mantidos layout responsivo, alvos de 48 px, foco/teclado, perguntas progressivas, diferenças, detalhes expansíveis, histórico, mensagens de processamento, erros e navegação Mesa. Ajuste na passagem: esperar conexão online antes de consultar eventos, evitando corrida de montagem após reconexão.

O conflito add/add do E2E foi resolvido preservando integralmente `test/e2e/autoconfig.test.ts` do núcleo D e separando a suíte de interface em `autoconfig-ui.test.ts`. Expectativas de autorização, isolamento, ausência de escrita, toque/layout/teclado foram mantidas e adaptadas ao protocolo assíncrono: espera de confirmação real; referências imutáveis persistentes em vez de duplicação de cópias locais. Duas versões agora exigem dois planos/revisões reais no servidor.

Unidade/HTTP da interface: sem aprovação otimista, IDs/versões/digests, serialização, 401/403/409/timeout, respostas tardias, contexto alterado, REAL recusado antes do fetch, MOCK permitido, leitura/recibo associado, save/review/undo/cancel no servidor e texto HTML escapado. E2E: Yoga, Pixel retrato, 780×360; dois itens com consentimentos independentes, rejeição, duas referências versionadas, download, desconexão real de WebSocket, troca de sessão, segundo operador recusado e persistência após logout.

Comandos: `npm run typecheck`, `npm run build`, `npm test`, `npm run test:web`, `npm run build:web`, `npm run test:e2e`, `npm run smoke:yoga -- --built`, `npm run test:https-lab` (Caddy). Resultados/CI ficam no relatório do PR. Não se afrouxaram expectativas nem limites de build.

O esquema canônico Zod aumenta o chunk lazy do AutoConfig (896,06 kB bruto, 97,54 kB estimados de transferência); carregado apenas ao abrir passagem com evento. Bundle inicial 428,09 kB mantém o warning preexistente de 400 kB; budgets preservados. Sem teste físico de Yoga/celular, rede da mesa, firmware ou acústica. A integração técnica do planejador C continua separada; o fluxo usa proposta explicitamente definida pelo operador.
