# 27 — Fluxo de esclarecimentos do diagnóstico (M1)

Branch `fix/diagnostic-clarification-flow`, a partir da `main` em `b386ed0` (PR #75). Somente LAB. **Nenhum comando para a mesa, nenhuma
alteração de autorização de comandos, permissões, autenticação, rede ou escrita REAL.** Independente do M3 (PR #76: busca documental).

## Problemas observados

1. Depois de dizer "no retorno" (ou de escolher PA/Fones na pergunta de destino), o assistente perguntava "Acontece só no retorno ou também no PA?" — a mesma dimensão PA/fones duas vezes.
2. "Essa fonte usa microfone ou captador/DI?" mesmo para o Fred (CH3) com AKG Perception P3 S já cadastrado.
3. "O que você encontrou nessa verificação?" aparecia antes de o operador ter feito qualquer verificação.
4. Até quatro esclarecimentos (relato, abrangência, isolamento, captação) antes da primeira verificação.

## O que mudou

| Antes | Depois |
|---|---|
| Pergunta de abrangência (`scope`) logo após o destino | Removida do roteiro. Se o operador disser por conta própria "nos dois" / "só no retorno", isso continua sendo guardado |
| Captação sempre perguntada (exceto isolamento "só com a banda") | Pulada quando o cadastro da banda tem **microfone com modelo confirmado** para o canal (CH3, CH4, CH6). CH5/CH7 (sem modelo) e qualquer canal sem cadastro continuam perguntando |
| "O que você encontrou nessa verificação?" | "Confira o passo acima. O que você encontrou?" |
| Até 4 esclarecimentos | No máximo 3 (relato, isolamento, captação); com contexto suficiente e microfone cadastrado, 1 (isolamento) |

Como funciona: `AssistantService` lê o cadastro de microfones já existente na base local (`LocalKnowledge.microphones()`, somente leitura, instantâneo renovado a cada 30 s)
e entrega a `DiagnosticContexts` uma função `registeredCapture(canal)`. O progresso efetivo (respostas do operador + cadastro) alimenta o planejador
(`planDiagnosticConversation`) e a consulta documental ("A fonte usa microfone."). Nada do cadastro é gravado na sessão: se o cadastro mudar, a próxima volta já reflete.

## Garantias preservadas

- **Não inventa:** sem cadastro (base desligada ou falha de leitura) ou com modelo não confirmado, a pergunta continua; "Ainda não comparei" fica `unknown`.
- **Relato original e isolamento entre sessões (PR #75):** inalterados; o teste confere que outro operador não herda contexto nem captação.
- **Autorização de comandos:** nenhum arquivo de autorização/política foi tocado; a conversa não cria proposta, comando nem escrita (`authorizedActions: []`, `automaticActions: false`, `realWrites: false`).
- Módulos AutoConfig (agentes B, C e D) não foram alterados.

## Testes

- `test/diagnostic-clarification-flow.test.ts` (26): casos reais da banda — Fred/Lucius/Fernando (captação cadastrada), Leandro/Laviquinho (não confirmada), sem cadastro, sem pergunta de PA/fones, ≤ 3 esclarecimentos em 10 relatos reais (voz, microfonia, surdo, cavaco, pandeiro, violão, tantã), pior caso, isolamento de sessões, ausência de ação.
- `test/diagnostic-clarification-server.test.ts` (3): servidor real com o cadastro semeado (`banda-v1_2`).
- Testes existentes de jornada atualizados para o novo roteiro (a pergunta de abrangência saiu); nenhuma expectativa de segurança foi afrouxada.

## Limites

- Perde-se a informação "só no retorno" quando o operador não a diz; a verificação de roteamento usa então o passo genérico do sintoma. Se a equipe quiser a pergunta de volta, ela pode ser reintroduzida **depois** do isolamento e só quando o destino não foi dito.
- Só microfone cadastrado dispensa a pergunta; captador/DI cadastrado não existe hoje no cadastro da banda.
- Qualidade acústica, firmware e topologia real da Ui16 seguem sem validação em hardware.
