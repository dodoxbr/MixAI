---
name: samba-pagode-instrument-consultation
description: Desenvolve e revisa perfis consultivos de cavaco, violão de seis/sete cordas, surdo, tantã, pandeiro, voz principal e coro, com proveniência e sem ajustes automáticos.
---

# Perfis musicais consultivos — MixAI

Aplicar depois de ler AGENTS.md, a issue e as skills mixai-mesario,
live-sound-consultation e soundcraft-ui16-safety. Esta skill orienta desenvolvimento;
o aplicativo usa explicitamente `src/knowledge/sound-engineer/`, nunca carrega esta skill
para decidir permissões ou gerar comandos.

## Consulta e papéis

- Confirmar fonte/canal e PA ou AUX1. Nome de pessoa num texto não autentica identidade.
  Relação canal/nome do cadastro informa papel musical, nunca propriedade/autorização.
- Cavaco: condução e ataque; investigar disputa com articulação do violão e dicção.
- Violão: confirmar seis/sete cordas e DI/microfone. No sete cordas, preservar baixarias
  e investigar competição com surdo/tantã; alias não confirma número de cordas.
- Surdo: pulso e fundação. Tantã: articulação e sustentação; comparar afinação,
  ressonância e passagens alternadas/juntas antes de discutir EQ/gate.
- Pandeiro: distinguir pele e platinelas, técnica, ângulo e vazamento; não é só agudo.
- Fred CH3 é lead; CH4–7 são coro no cadastro atual da banda. Priorizar dicção sem
  esforço vocal ou offset fixo. Se canal/nome não coincidirem, papel fica desconhecido.
- AUX1 do HA800 é mix compartilhada: encaminhar revisão humana considerando todos.

## Evidência e limites

Separar relato, leituras declaradas (com revisão/momento quando informados), hipóteses,
medições indisponíveis, recomendações e ação autorizada. A consulta não adquire estado
novo: valores recebidos não são leituras REAL verificadas por ela. LAB VU não é áudio,
RTA ou SPL. Não afirmar frequência de microfonia sem medição real validada; o runtime
atual nem recebe esse tipo de evidência.

Microfonia: parar exposição desconfortável e chamar operador; conferir microfones/caixas,
padrão polar, ganho e microfones abertos. AFS2 é recurso documentado, sem controle MixAI;
Fixed/Live não autorizam ring-out com público nem ajuste experimental de processamento.
Sem presets universais, EQ numérico ou parâmetros automáticos em respostas consultivas.

## Contratos e validação

Usar `DiagnosticRecommendation`, `diagnosticConsultationSchema` e módulos versionados.
Tudo desta entrega tem status `theory`: `verified_at_rehearsal` exige evidência futura e
não pode ser alegado com fixtures. `proposal:null`, `authorizedActions:[]` e
`execution:not_executable` são invariantes, não valores que o texto de um modelo escolhe.
Novos adaptadores devem passar por autorização separada antes de qualquer proposta.

Registrar fabricante, URL, versão, seção e data; distinguir fonte indisponível de fonte
consultada. Orientações musicais são síntese editorial MixAI, não presets de fabricantes.
Fontes e restrições de acesso: `docs/sound-engineer/ISSUE-48-KNOWLEDGE.md`.

Testar relato sem medição, negação/pergunta, fontes ambíguas, offline, mudança externa
simulada e tentativas de execução. Preservar gates REAL, login, filas e referências de
outras entregas; CI e PR independente, sem merge.
