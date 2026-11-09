# AutoConfig — interface do operador (#74)

Base: `origin/main` f399939, incluindo PR #71. Exclusivamente LAB. A entrega B implementa a experiência do operador, não o planejador C (#73), o núcleo D (#72), autorização no servidor ou uma integração com hardware.

## Acesso e fluxo

Use o PIN de operador existente → **Passagem de som** → crie/selecione um evento em andamento → **Iniciar AutoConfig LAB**. O painel fica logo após o resumo do evento, no fluxo normal da página; não cobre faders nem chat. A aba **Mesa** permanece disponível em um toque, inclusive na navegação inferior do celular. Eventos pausados/concluídos não exibem a ferramenta. Músicos não recebem nova tela ou permissão; seus canais e pedidos existentes permanecem no fluxo atual.

O operador responde uma pergunta por vez: objetivo, canal, PA ou FONES (AUX1 compartilhado), relato. Pode voltar antes de gerar o plano. O painel mostra cadastro/revisão LAB e incertezas, sem transformar cadastro, relato ou revisão em medição acústica.

Cada item mostra diferença antes/depois, justificativa, evidência, risco, pré-condições, limitações, critério de validação, retorno e referências expansíveis. **Autorizar somente este teste LAB** permite apenas o item escolhido; **Executar este teste simulado** consome a autorização. Nenhum lote. Depois, o operador confirma ou rejeita/descarta o cenário. Somente itens confirmados podem compor uma referência, após decidir todos os itens. Não há autoaprovação pela IA.

**SIMULAÇÃO LAB** aparece no cabeçalho aderente do painel e nas referências. Os rótulos e bordas diferenciam relato, estado disponível, sugestão fictícia/IA, decisão humana e resultado simulado. O resultado acústico é sempre não validado: nenhum áudio, espectro, SPL ou frequência foi coletado.

Cancelamento tem confirmação própria. Histórico local registra decisões; dados privados/credenciais não são colocados em logs. Controles com alvo de 48 px, foco visível, rótulos, status/alertas acessíveis e foco no título da pergunta/plano. Layout de uma coluna no celular e diferenças lado a lado em telas maiores. Os testes usam Chromium com toque emulado; não certificam leitor de tela ou Yoga físico.

## Adaptadores provisórios e dependências

Na base desta branch, contratos AutoConfig de C/D ainda não existem. `AUTO_ADAPTER` é o ponto de injeção, sem rota HTTP inventada. Seu padrão carrega uma **fixture de UX** sob demanda. Ela não chama provedor externo, não calcula EQ/ganho ou recomenda uma receita técnica. Compara dois cenários textuais fictícios para testar autorização e revisão. O painel avisa explicitamente que C/D não estão conectados; não apresenta a fixture como motor técnico real.

Fronteira temporária em `autoconfig-contract.ts`:

- `AutoInput`: versão 1, escopo `lab_simulation`, evento/versão, objetivo, canal, destino, relato e revisão LAB ou `null`. Sem PIN, token, áudio ou rede.
- `AutoAdapter.plan(input)`: `Promise<unknown>`; adaptar resposta C/D para `AutoPlan`, com evidência/justificativa/risco/limites/referências por item. O planejador nunca retorna autorização.
- `AutoAdapter.simulate({plan,itemId,operatorApproved:true})`: resultado vinculado a plano/item e antes/depois, com `acousticValidated:false`. Esse booleano documenta o clique local; **não é credencial nem autorização de servidor**. D deve conferir principal autenticado, owner, revisão, versão, idempotência e escopo no backend. Não conectar diretamente o planejador ao simulador ou a `LiveService.command`.
- O adaptador reconstrói somente dados de apresentação, valida versão/escopo, limites de tamanho, IDs únicos, canal/destino, referências HTTPS e associação de resultado. Payloads de aprovação/comando externos não são propagados. Dados de texto são escapados pelo Angular.

Ao publicar contratos finais, mapear os DTOs no adaptador, incluindo erros/409/expiração. Perguntas adicionais de C, IDs/idempotência/versões de D e salvamento persistente exigem essa integração; não presumimos seus formatos ou endpoints. Os testes atuais validam o comportamento da UI e dos stubs, não essas APIs futuras.

### Referências provisórias

**Salvar referência temporária da sessão** gera cópia versionada somente na memória da sessão desta aba, com itens e resultados aceitos. **Baixar referência simulada vN** exporta um JSON local explícito, sem credenciais. Não há import, restauração, aplicação, armazenamento servidor ou snapshot nativo Soundcraft. Repetir salvar cria nova versão. Alterar evento/versão, logout, expiração ou troca de modo/servidor elimina dados em memória; o arquivo baixado explicitamente permanece sob controle do operador.

O fluxo de referências da passagem existente continua separado e funcional, sem incluir os cenários fictícios. Persistência autoritativa e referências revisáveis do AutoConfig pertencem a D (#72); esta entrega não grava a fixture no banco de referências existente nem afirma durabilidade sem esse núcleo.

## Falhas e isolamento

Identidade inclui token da sessão (apenas em memória), perfil, modo e instância do servidor. Trocas descartam planos, resultados e referências; respostas tardias são ignoradas. Progresso pode permanecer ao navegar Mesa/Passagem na mesma sessão e selecionar o mesmo evento/versão.

Offline bloqueia ações e invalida autorizações/resultados pendentes. Reconexão não repete teste nem recupera aprovação: é preciso rever novo plano. Mudança da revisão LAB invalida o plano, inclusive durante planejamento. Timeout de 10 segundos ou contrato incompatível gera mensagem sanitizada; não expõe erro bruto. Falha de simulação consome aprovação, exigindo novo clique. Cancelamento e troca de evento também invalidam operações em andamento. Dois cliques simultâneos não despacham dois testes.

O adaptador atual é local e sem efeitos. Quando D for conectado, cancelamento/timeout da UI não pode significar rollback remoto comprovado: usar o estado autoritativo de D antes de qualquer nova tentativa. Não implementar replay automático nem promover esta fixture a REAL.

## Segurança e validação

Sem alterações em PINs, autenticação, permissões, backend, transporte, comandos, rede ou persistência dos outros agentes. Sem uso de `ActionsService`, `LiveService.command`, mixer.write, aplicação/cena/recall físico ou `serve:real`. MOCK/REAL não exibem esta entrega. F0/E6 permanecem bloqueados conforme #43/#44.

Verificações: `npm run typecheck`, `npm run build`, `npm run test:web`, `npm run build:web`, `npm test`, `npm run test:e2e`, `npm run smoke:yoga -- --built`, `npm run test:https-lab` (Caddy). Resultados/CI e eventuais skips ficam no relatório do PR.

Testes novos cobrem perguntas/teclado, autorização item a item, confirmação/rejeição, versões/exportação, concorrência de cliques, erro/timeout, payloads incompatíveis, conteúdo HTML, ausência de escrita, modo/perfil, sessão expirada, servidor/evento/estado alterados e resposta tardia. E2E em Yoga, Pixel retrato e 780×360, logout e desconexão real de WebSocket. Um seletor antigo do E2E da passagem passou a usar seu cabeçalho de evento explícito; a expectativa foi mantida, pois o novo painel também tem títulos.

Main medida em worktree isolada: bundle inicial 416,92 kB; entrega 425,70 kB (+8,78 kB bruto), AutoConfig lazy ~26 kB, fixture lazy ~1,69 kB. O aviso do orçamento de 400 kB já existe na main; budgets/dependências não foram alterados. Sem ensaio físico, validação acústica ou comparação de provedores nesta tarefa de UI.
