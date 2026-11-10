# Roteamento unificado de provedor/modelo de IA (LAB)

Branch `feature/unified-ai-provider-routing`, criada da `main` `4c5788e` (PRs #93, #94 e #95 incorporados).
Somente LAB. Sem alterações no núcleo D, nas aprovações, nos comandos da Soundcraft, em rede, autenticação ou permissões.
Nenhum teste usa chave real, chamada paga, `serve:real` ou a Ui16.

## O que mudou

Antes, o catálogo v1 (#95) e a tela (#94) escolhiam um modelo por sessão, mas **nenhum consumidor o lia**: o resumo
documental e o planejador seguiam o seletor global legado (`/api/knowledge/providers` + `ExternalConsent`).
Agora existe **um serviço central de resolução por sessão autenticada**, `AiRouter` (`src/ai/routing/`):

```text
catálogo v1 (ModelCatalogService)  ← única fonte: seleção revisionada + consentimento por sessão/provedor/modelo + preço + orçamento
        │ view(actor)  (lido a cada pergunta; o roteador não guarda nada)
        ▼
AiRouter.route(actor, flow) → ChatRoute { provider, key, allowed(), live() }
        │                         provider = RoutedProvider → ModelCatalogService.generate(actor, system, user, revisão, flow)
        ├── resumo documental (diagnóstico / RAG)   LocalKnowledge.enrich({ chat: route })
        └── planejador consultivo do AutoConfig     AutoConfigAdvisor → createConfiguredPlanner({ routed })
```

- **Reutiliza o catálogo v1**: não há outro cadastro de modelos, ledger, orçamento ou tabela de preços.
- **Estado único**: seleção, consentimento, revisão, orçamento, limite por minuto e revogação vivem só no catálogo.
  `AiRouter` não tem mapas, caches nem flags próprios; revogar, trocar o modelo, limpar, sair da sessão ou reiniciar
  não deixam estado paralelo capaz de autorizar envio externo.
- **Precedência**: sessão **com** seleção no catálogo → o modelo escolhido responde nos dois fluxos (o seletor legado não
  é consultado nem como reserva externa). Sessão **sem** seleção → comportamento anterior, idêntico (Ollama local por
  padrão; seletor legado e `ExternalConsent` continuam valendo para quem o usa).
- **Isolamento**: cada `ChatRoute` fica presa ao ator, ao provedor, ao modelo e à **revisão** da seleção; instâncias do
  cliente são criadas por seleção (o catálogo nunca chama `selectModel` em cliente compartilhado).
- **Diagnóstico**: o texto do diagnóstico continua sendo do motor determinístico. O que o modelo escolhido produz é o
  *resumo documental* (teoria, "não verificado") que acompanha o diagnóstico.

## Garantias (e onde são aplicadas)

| Requisito | Mecanismo |
| --- | --- |
| Consentimento por sessão **e** por provedor/modelo | `consent.granted` do catálogo; `ChatRoute.allowed()` compara chave `provedor\|modelo\|revisão\|consentido` com o estado **atual** |
| Revogação / logout / troca de modelo | `allowed()` é reavaliada **antes de cada envio** e **ao receber** a resposta (`enrich`, assistente e planejador); falso ⇒ resposta descartada, sem cache (`not_consented`, regra `selecao_alterada`; planejador: `stale_policy` / 409) |
| Cache | A chave do cache do assistente inclui `route.key`; qualquer mudança de sessão/provedor/modelo/consentimento invalida |
| Fallback | Só para o **Ollama local** e só se `knowledge.external.fallback: ollama` (padrão). Nunca externo→externo. Sem fallback após recusa de segurança (`refused`) |
| Preço desconhecido | Bloqueado no catálogo (`PRICE_UNKNOWN`) antes de qualquer POST; vira `quota` + `reason: price_unknown` e o fallback local segue a política |
| Orçamento / limite | Mesmo `UsageTracker` compartilhado (`external-ai-usage.json`); `BUDGET`/`RATE_LIMIT` viram `quota` |
| Embeddings | Operação distinta: `RoutedProvider.embed()` devolve `undefined`; o embedder (e o consentimento dele, `externalAllowed`) seguem a regra anterior. Trocar o modelo de conversa não reindexa nem altera o embedder |
| Provedor/modelo que responderam | `narrativeStatus.provider/model` e `narrative.source/model` (resumo), `advice.provider.used/model` e `model.{selected,used,name}` (AutoConfig); auditoria `model_catalog_usage` ganhou `flow` (`knowledge` \| `autoconfig` \| `complete`), sem prompt, resposta ou chave |
| Nada executa | `execution: not_executable`, `authorization: not_granted`; a saída do modelo nunca vai a parser, proposta ou comando |
| Sem escrita na mesa | Testes verificam que `mixer.write`, `core.execute` e o estado do controlador ficam intactos |

## Contratos alterados (migração)

Todos aditivos; sem rotas novas e sem quebra de contrato público.

- `ProviderId` ganhou `'openai'` (somente leitura em `narrativeStatus.provider`/`narrative.source`). `PROVIDER_IDS`
  (seletor legado) **não** mudou: o seletor legado continua sem OpenAI.
- `GenerateResult.reason` ganhou `'price_unknown'`.
- Novo tipo `ChatRoute` (`src/knowledge/local/provider.ts`); `LocalKnowledge.enrich(input, { chat? })` e
  `AssistantService` (`chatRoute?`) e `AdvisorReadPort.route?` são opcionais: ausentes ⇒ caminho anterior.
- `ModelCatalogService.generate(..., flow?)` e o evento de auditoria ganharam `flow` opcional.
- Interface: o resumo aceita a fonte `openai`; os avisos de "fluxos separados" foram atualizados para o novo comportamento.

## Testes

`test/unified-routing.test.ts` (18 casos, servidor LAB real + catálogo real + HTTP simulado de todos os provedores):
GPT→diagnóstico; DeepSeek→RAG; Anthropic→AutoConfig; troca de modelo em voo (resumo e AutoConfig: resposta antiga
descartada); revogação (limpar) e durante o envio; logout; duas sessões simultâneas; modelo indisponível (fallback local
e política `none`); preço desconhecido; recusa sem fallback (resumo e AutoConfig); Ollama sem API externa; caminho
anterior sem seleção; embeddings independentes; músico sem acesso; nenhuma escrita na mesa; prazo esgotado com
identificação do provedor que de fato respondeu. Verificação por mutação: sem as guardas de descarte, os testes 4 e 5b falham.

## Limites e funcionalidades ainda não integradas

- **Conversa/complete e embeddings**: `/api/ai/models/complete` continua sendo uma rota isolada. Embeddings externos
  (`embedProvider: gemini`) e a **ingestão** seguem o consentimento legado; o catálogo não escolhe modelo de embeddings.
- **Concorrência por sessão**: o catálogo permite uma geração por sessão por vez. Resumo e AutoConfig simultâneos na
  mesma sessão podem receber `BUSY` (tratado como indisponibilidade ⇒ reserva local conforme a política).
- **Tamanho**: o catálogo limita instrução + texto a `modelCatalog.maxInputBytes` (12 000 por padrão). Prompts maiores
  resultam em `error` e reserva local.
- **Seletor da Base de conhecimento**: o painel legado ainda mostra a *sua* seleção em "Em uso"; quando a sessão tem
  seleção no catálogo, quem responde é o catálogo (a resposta mostra provedor/modelo reais). Unificar essa tela é
  trabalho de interface posterior.
- **Prazo**: a espera máxima segue `min(prazo do catálogo, 20 s do assistente / planejador)`.
- **Validação real pendente**: compatibilidade com contas, preços de produção e qualidade das respostas dos modelos
  reais; firmware/Ui16, E6 e escrita REAL não foram tocados nem validados.
