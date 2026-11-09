# 25 — Contexto consolidado do diagnóstico e linguagem natural (A1 e A2)

Branch `fix/diagnostic-context-natural-language`, a partir da `main` em `f399939` (PR #71). Somente LAB. **Nenhum comando para a mesa, nenhuma
alteração de permissão, autenticação, rede ou escrita REAL.** Origem: relatório de validação funcional (problemas A1 e A2).

## A1 — a base recebia a última resposta, não o relato

**Causa raiz.** `AssistantService.withKnowledge(p, reply, text)` recebia o texto da **última mensagem** do operador. Numa conversa guiada
essa mensagem é a resposta a uma pergunta de esclarecimento ("Voz Fred", "Fones", "Só no retorno", "Microfone", "Encontrei um problema"). A
consulta da busca virava `"abafado vozes Voz Fred"` e o prompt do Qwen3 dizia literalmente `Pergunta do operador: Fones`. O relato original só
sobrevivia como evidência dentro do contexto (e nem isso quando a frase tinha "não"). Efeito medido: cerca de 30% dos resumos da IA descartados
(`fora_do_assunto`, `sem_base`, `echo`) e o resumo "oscilando" entre as voltas do mesmo relato.

**Correção** ([`diagnostic-context.ts`](../../src/assistant/diagnostic-context.ts), [`service.ts`](../../src/assistant/service.ts)):
- Cada investigação pendente guarda o **relato original** (sanitizado, até 300 caracteres; relatos adicionais sobre a mesma fonte são acrescentados).
- A cada resposta, o servidor monta a **consulta consolidada**: relato original + esclarecimentos já dados (abrangência, isolamento, captação),
  junto de sintoma, instrumento, canal e destino. O relato vem primeiro; os esclarecimentos entram como frases curtas ("Só no retorno.",
  "Soa assim também sozinha.", "A fonte usa microfone."). O resultado de uma verificação ("Encontrei um problema") não entra.
- A consulta vai como propriedade **não enumerável** da resposta: nunca é serializada para a tela, o HTTP ou o WebSocket.
- **Cache por sessão** (`p.id`, 60 s): se o contexto consolidado não mudou (ex.: "detalhes", repetição, o resultado da verificação final), a base
  **não** é consultada de novo. Resultado degradado (Ollama ou base fora, tempo esgotado) não é guardado.
- **Sem sintoma, sem busca:** enquanto o relato é vago, a base e o Qwen3 não são chamados.
- Isolamento e ciclo de vida: o cache e o contexto são por sessão; logout/revogação (`onRevoke`) limpam os dois; `sweep()` remove entradas
  vencidas ou de sessões inativas; `stop()` limpa tudo; reinício do servidor zera a memória; o contexto de esclarecimento continua expirando em 5 min.

**O que chega à busca e ao Qwen3** (jornada "A voz está abafada no retorno", servidor isolado, dados de teste):

| Volta | Antes — o que a busca/Qwen3 recebia | Depois |
|---|---|---|
| 1 relato | `abafado vozes A voz está abafada no retorno` | `abafado vozes A voz está abafada no retorno.` |
| 2 escolhe o Fred | `abafado vozes Voz Fred` | texto igual ao do relato; canal 3 |
| 3 "Só no retorno" | `abafado vozes Só no retorno` | `…retorno. Só no retorno.` |
| 4 "Também sozinha" | `abafado vozes Também sozinha` | `…Só no retorno. Soa assim também sozinha.` |
| 5 "Microfone" | `abafado vozes Microfone` | `…sozinha. A fonte usa microfone.` |
| 6 "Encontrei um problema" | `abafado vozes Encontrei um problema` → resumo `empty:fora_do_assunto` | **sem nova consulta** (reaproveita a 5), 20–39 ms |

Ao Qwen3 chega só a pergunta consolidada e os trechos recuperados (como antes); ao provedor externo, só depois da remoção de PIN, números,
e-mails, IPs, links e nomes de músicos já existente. Nada de PIN, token, caminho, estado da mesa ou histórico entra na consulta.

## A2 — frases naturais (motor determinístico)

Vocabulário fechado ampliado em [`sound-engineer.ts`](../../src/assistant/sound-engineer.ts), reaproveitando o motor existente (sem IA generativa,
sem comando):
- **Equilíbrio vocal:** "não aparece", "não se ouve", "não se destaca", "cobrindo", "afogado", "escondido"… ("coro"/"coral" contam como vozes).
- **Falta de graves:** "falta grave", "falta de grave", "faltando grave", "sem peso", "sem pegada".
- Frases sem o verbo "estar" ("Coro cobrindo a voz do Fred", "Falta grave no surdo") e com "não" ("não aparece") agora viram **evidência humana** (relato, sem medição).
- **Relato vago** ("O som do violão está horrível"): só entra na conversa guiada se citar uma **fonte** (instrumento ou canal), não vira diagnóstico
  nem tem evidência, e a única pergunta é o sintoma, com 6 descrições do som (abafado, estridente, magro, embolado, desequilíbrio, ruído). Sem fonte
  ("tá tudo estranho"), negado, pergunta ou hipótese, nada muda: segue o caminho de sempre.
- **Mensagens de ajuda:** quando o sistema não entende, os exemplos agora incluem **relatos de problema** além de comandos, e dizem "Nada foi ajustado".
- Relato de problema nunca é tratado como pedido de mixagem (`isExplicitMixRequest` falso para todos os exemplos).

Reconhecimento das 11 frases (1ª resposta do assistente), servidor real em LAB:

| Frase | Antes | Depois |
|---|---|---|
| O surdo está sem grave | entendida | entendida |
| A voz está abafada no retorno / Minha voz está abafada no retorno | entendida | entendida |
| Está dando microfonia no microfone do Fred / Tá microfonando quando o Fred canta | entendida | entendida |
| A voz do Fred está sumindo quando o coro canta | entendida | entendida |
| O surdo tá seco | entendida (pergunta o que é "seco") | entendida (igual) |
| **O Fred não aparece quando o coro entra** | **não entendida** (HTTP 400) | **entendida: equilíbrio vocal, CH3** |
| **Coro cobrindo a voz do Fred** | **não entendida** | **entendida: equilíbrio vocal, CH3** |
| **Falta grave no surdo** | **não entendida** | **entendida: falta de graves, CH8** |
| **O som do violão está horrível** | **não entendida** | **pergunta o sintoma (6 opções), sem diagnóstico** |

De 7/11 para 11/11.

## Testes

- `test/diagnostic-natural-language.test.ts` (26): frases reais, evidência, relato vago (uma pergunta, só descrições do som, nada de diagnóstico), frases que **não** devem ser capturadas, nenhuma proposta/comando.
- `test/diagnostic-knowledge-context.test.ts` (9): jornada completa com a base instrumentada (relato original preservado, "Fones"/"Voz Fred"/… nunca chegam como pergunta, esclarecimentos consolidados),
  cache (não consulta de novo sem mudança), relato vago sem busca, **duas sessões simultâneas sem mistura**, logout/revogação, expiração (60 s e 5 min), resultado degradado não guardado, mensagens de ajuda, nada de proposta nem escrita na mesa.
- `test/e2e/diagnostic-language.test.ts` (2, Yoga e celular): as frases na interface real.
- Verificação do teste: com o comportamento antigo reintroduzido, 3 testes-chave falham; restaurado, os 9 passam.

## Limites

- A busca ainda usa limiar 0,3 e traz ruído em alguns relatos (item M3 do relatório de validação), as perguntas de esclarecimento continuam sendo 4–6 (M1) e o resumo/fontes continuam recolhidos na interface (M5): fora do escopo deste PR.
- Frases fora do vocabulário fechado (ex.: gírias novas) continuam sem ser entendidas; a mensagem de ajuda agora orienta como descrever o problema.
