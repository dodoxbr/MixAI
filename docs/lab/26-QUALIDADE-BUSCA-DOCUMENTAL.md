# 26 — Qualidade da busca documental (M3)

Escopo: só a **consulta** e a **seleção dos trechos**. O corpus, os embeddings e a coleção `bgem3` não foram tocados. Tudo em LAB; nenhuma escrita REAL.

## Causas medidas dos resultados irrelevantes

| Problema | Causa | Correção |
|---|---|---|
| "coro" trazia o efeito **Chorus FX** do manual da Ui16 | falso cognato; o modelo aproxima os dois | desambiguação: sem pista de efeito (efeito, fx, chorus, delay…) "coro" é grupo de vozes → a consulta ganha "vozes de apoio / backing vocals / mascaramento" e trechos de Chorus FX saem do resultado |
| Nome de músico ("Fred") puxava trechos sem relação | o nome domina o vetor da frase curta | glossário de sintoma/instrumento reduz o peso do nome; opção `stripNames` (desligada por padrão, ver abaixo) |
| Artigos de microfonia, surdo e voz abafada ficavam atrás de tabelas da Shure | a consulta enviava os identificadores crus (`microfonia vozes`) | termos em português do vocabulário fechado do motor (`expandSymptoms`): "realimentação feedback apito…", "surdo bumbo grave", "voz abafada clareza…" |
| Trechos de ruído passavam do limiar | `minScore` 0,30 é de outro modelo (nomic); para BGE-M3 ruído ≈ 0,40 e relevantes ≈ 0,55 | `minScore` 0,40 para BGE-M3 (medido) |

## Metodologia

Conjuntos de avaliação, ambos executados contra a base real (PostgreSQL + BGE-M3), k = 4:

- **v1** `knowledge/eval/relevance-ptbr.json` — 24 casos, **congelado** (protegido por teste).
- **v2** `knowledge/eval/relevance-ptbr-v2.json` — 25 casos novos, com sintoma/instrumento como o assistente envia, critérios PT+EN, termos **intrusos** conhecidos, nomes de músicos, o par coro × Chorus e 2 controles (quem pergunta pelo efeito deve achá-lo).

Comando: `npm run knowledge -- eval --live --cases v1|v2 --via search|enrich --sweep 0.3,0.4,0.5,0.6 [--mode auto|hybrid] [--tune off|chave=valor,...]`. A varredura reabre o serviço por limiar; não reindexa nada.

Métricas: Acerto@k, Hit@1, MRR, precisão@k, **intrusos** (perguntas com ao menos um trecho intruso), trechos/pergunta e perguntas sem resposta.

## Limiar de similaridade (0,3 – 0,6)

Não foi escolhido arbitrariamente: varreram-se 0,3; 0,4; 0,5 e 0,6. Limiar absoluto sozinho troca revocação por precisão — acima de 0,40 o Acerto@k do v1 começa a cair. Critério adotado: **o maior limiar sem regressão no v1**. Resultado: **0,40 para BGE-M3** (`config.yaml` documenta 0,30 para nomic e 0,40 para bge-m3). Para outro modelo de embeddings, refazer a varredura.

## Antes × depois (limiar 0,40, base real)

| Conjunto / via | Acerto@k | Hit@1 | MRR | Precisão@k | Intrusos |
|---|---|---|---|---|---|
| v1 · search (depois) | 88% | 58% | 0,71 | 43% | — |
| v2 · enrich (antes) | 100% | 88% | 0,93 | 58% | 28% |
| v2 · enrich (**depois**) | 100% | 100% | 1,00 | 82% | **4%** |
| v2 · search (antes) | 100% | 68% | 0,82 | 48% | 44% |
| v2 · search (**depois**) | 100% | 84% | 0,90 | 55% | 28% |

Os controles do Chorus FX continuam achando o efeito.

## Alavancas avaliadas e decisão

- **Ligadas por padrão:** `expandSymptoms`, `disambiguate`.
- **Desligadas (medido que não ajudam ou prejudicam):** `stripNames` (remove nomes cadastrados da consulta; a estabilidade do top-1 já sobe de 44% para 89% só com o glossário), `relativeCutoff` (corte relativo ao melhor score) e `sourcePrior` (prioridade às sínteses técnicas) — ambos pioraram o v1. Continuam disponíveis em `knowledge.retrieval` para experimentos.
- Com tudo desligado a consulta volta ao formato antigo (`sintoma instrumento texto`) — testado.

## Segurança e limites

- A busca só lê; nada envia comandos à Ui16.
- Os nomes continuam no cadastro; só deixam (opcionalmente) a consulta.
- O glossário cobre o vocabulário fechado do motor; vocabulário livre de fora dele não é expandido.
- Métricas vêm de 49 casos escritos pela equipe: indicam tendência, não garantia estatística. O ranking depende do modelo de embeddings; qualidade acústica real e firmware seguem sem validação em hardware.
