# Qualidade da busca e do resumo da base de conhecimento local

Complementa `21-LOCAL-KNOWLEDGE-INFRASTRUCTURE.md`. Tudo aqui é **somente leitura de documentos técnicos**:
nada chega à mesa, nada vira comando, e o motor determinístico continua sendo o fallback.

## 1. Resumo do modelo vazio: causa e correção

O texto de apoio do modelo local (`narrative`) chegava vazio e o descarte era **silencioso**.

- **Causa mais provável:** a geração usava o mesmo timeout de 8 s das consultas de embedding. O `llama3.2:3b`
  em CPU leva de 3 a 7 s e passa disso sob carga (Docker Desktop recém-aberto). Nas duas respostas do teste
  original o tempo total foi 8073 ms e 8178 ms: quase exatamente o limite, ou seja, **cancelamento por timeout**,
  não "latência de CPU". Não foi possível reproduzir a falha depois, com a máquina ociosa (geração de 3,7 a 6,9 s);
  o mecanismo está coberto por teste (`timeout` → motivo próprio).
- **Correção:** geração com limite próprio (`knowledge.ollama.narrativeTimeoutMs`, padrão 30 s) e
  `generateDetailed`, que informa **por que** não houve texto.
- **Eco do prompt:** o modelo às vezes repete as tags `<trecho>`. As tags são removidas; se o "resumo" for só um trecho
  copiado, é descartado como `echo`.
- **Motivos de descarte registrados** (log, status e tela mostram só o código, nunca o texto):
  `timeout`, `unavailable`, `error`, `empty`, `echo`, `blocked:<regra>`.
- **Proteções mantidas e ampliadas** (nenhuma foi afrouxada). Regras que descartam o texto:
  `valor_de_processamento` (dB/Hz/kHz), `comando_da_mesa` (`set_*`), `verbo_de_execucao` (aplique/execute/aprove…),
  `afirma_ter_ouvido_ou_medido` (ouvi, escutei, medi, analisei, detectei…) e `phantom` (phantom/48 V).
  As duas últimas são novas: a LLM não pode afirmar que ouviu o áudio nem aconselhar phantom (o motor determinístico
  trata disso). O prompt agora pede hipóteses e verificações em tom de possibilidade e proíbe repetir os blocos.
- Trechos de tabela com vários modelos de microfone **não vão para o modelo** (ele os misturaria).

Observação de qualidade: com o `llama3.2:3b` o texto é correto no formato, mas fraco no conteúdo (ver §9).

## 2. Comparação da busca semântica

Gabarito: `knowledge/eval/relevance-ptbr.json` — 24 perguntas em português, 6 temas (voz abafada, microfonia,
cavaco estridente, surdo embolado, retorno AUX1, EQ e compressão). Um trecho é relevante se **contém** algum dos
termos esperados (critério de conteúdo, não de página). Corpus: Soundcraft Ui12/16 (PT), Shure (EN), folhetos AKG (EN)
e artigos Yamaha (EN). Comando: `npm run knowledge -- eval --embed-model bge-m3 --dims 1024` (índice temporário;
não toca na base).

| Configuração (341 trechos, k=4) | Acerto@1 | Acerto@3 | Acerto@4 | MRR |
|---|---:|---:|---:|---:|
| Só palavras (qualquer modelo) | 29% | 42% | 42% | 0,35 |
| `nomic-embed-text` (atual), vetor | 17% | 17% | 21% | 0,18 |
| `nomic-embed-text` + prefixos `search_*`, vetor | 13% | 21% | 29% | 0,19 |
| `nomic-embed-text` + prefixos, híbrido | 21% | 33% | 38% | 0,27 |
| **`bge-m3`, vetor (modo `auto`)** | **54%** | **83%** | **83%** | **0,67** |
| `bge-m3`, híbrido (RRF) | 50% | 71% | 75% | 0,60 |

Conclusões: o `nomic-embed-text` não serve para perguntas em português sobre manuais em inglês (pior que só
palavras, com ou sem prefixos). O `bge-m3` é multilíngue e **quadruplicou** o acerto. O híbrido **piorou** com o
`bge-m3`, então o padrão continua `search: auto`; o modo `hybrid` fica disponível como opção.

Varredura de limiar (`bge-m3`, `--sweep`): 0,3 → 83%; 0,45 → 75%; 0,5 → 63%; 0,55 → 54%; 0,6 → 50%. O cosseno mediano dos
relevantes (0,61) e dos demais (0,54) quase não se separa, então um limiar alto só **perde acertos**. Mantido
`minScore: 0,3`.

**Base real em uso** (mesmo gabarito, julgado pelo trecho exibido de 420 caracteres, com o pipeline final):

| Estado | Acerto@1 | Acerto@3 | Acerto@4 | MRR |
|---|---:|---:|---:|---:|
| Antes (`nomic`, 275 trechos, divisor antigo) | 21% | 29% | 29% | 0,24 |
| Depois (`bge-m3`, 367 trechos, divisor novo, + artigos Yamaha) | 42% | 67% | 75% | 0,56 |

Pior tema: **voz abafada (0/4)**. O corpus quase não trata desse sintoma; é limite de cobertura, não do algoritmo.

## 3. Coleções reversíveis e backup

`knowledge.collection` (padrão `default`) separa índices por modelo de embedding sem apagar o anterior:

- PostgreSQL: schema próprio `kb_<nome>` (vetor de 1024 dimensões); `default` continua em `public`.
- Arquivo: `knowledge-<nome>.json`.
- O status acusa troca de modelo sem troca de coleção (dimensão da coluna × configuração).

Reindexação feita: backup com `pg_dump` em `data/knowledge/backups/` (fora do Git), coleção nova `bgem3`, a antiga
(`public`, `nomic-embed-text`, 275 trechos) **intacta**.

Voltar ao índice anterior: em `config/config.local.yaml`

```yaml
knowledge:
  collection: default
  ollama: { embedModel: nomic-embed-text, embedDimensions: 768 }
```

Restaurar do backup, se preciso: `docker exec -i mixai-knowledge-postgres-1 psql -U mixai -d mixai < ARQUIVO.sql`.

## 4. Ingestão

Os PDFs da AKG têm 2 páginas cada: os "2 trechos" **não eram truncamento**, eram uma página por trecho.

- Divisor novo: junta as linhas do PDF em parágrafos, une palavras hifenizadas, descarta número de página e
  pontilhado de sumário, corta só em fim de frase e repete a última frase como sobreposição.
- Tabelas de códigos de modelos (BETA58A, SM58…) são ignoradas e o relatório informa quantas.
- Páginas com menos de 100 caracteres são **avisadas** ("imagem?"), sem OCR automático.
- `INGEST_VERSION` entra no hash do documento: melhorar o pipeline reindexa os documentos sozinho.
- Documento com lacuna de embedding (serviço caiu no meio) agora é reparado na próxima ingestão (antes ficava como
  "inalterado" para sempre); lotes têm timeout próprio de 60 s e uma nova tentativa.
- Corpus novo: artigos Yamaha de EQ, ganho e compressor (já listados no catálogo), baixados como texto.

## 5. P3 S × P5

A página 2 do folheto da AKG põe P3 e P5 lado a lado nas mesmas linhas ("cardiod … supercardiod"). Cada trecho agora
carrega os modelos que cita (calculados no texto inteiro):

- trecho com mais de um modelo → aviso "não misture as características" na tela e fora do resumo do modelo;
- canal cujo microfone é P3 S → trechos que só descrevem outro modelo (P5) são **ocultados** e a tela informa quantos.

Sem microfone confirmado no canal (CH5, CH7) nada é filtrado e a ficha continua dizendo para não inferir o modelo.

## 6. Indisponibilidade (testado ao vivo)

| Falha | Diagnóstico estruturado | Base de conhecimento |
|---|---|---|
| PostgreSQL parado | continua (`kind=diagnosis`, 0 propostas) | modo determinístico; ficha do microfone vem do pacote versionado; status mostra "indisponível" (antes: HTTP 500) |
| Ollama parado | continua | busca por palavras (4 trechos) |
| Voltou o serviço | — | recupera sozinho, sem reiniciar o MixAI |

Defeito achado e corrigido nesses testes: a busca por palavras do PostgreSQL usava `plainto_tsquery` (exige **todas** as
palavras) e devolvia zero trechos para frases naturais. Agora usa OR com palavras só de letras e números, parametrizado.

## 7. Script de inicialização

`npm run lab:start` (ou `lab:check` só para verificar). Equivale a
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-mixai-lab.ps1`; o bypass vale só para esse processo e
**não altera a política do Windows**. Verifica Docker, PostgreSQL, Ollama e os modelos configurados, sobe o que faltar,
inicia o servidor **sempre em `--lab`** (não existe opção REAL), confirma `mode=lab` em `/api/hello`, roda o `doctor` e
imprime a URL. Não habilita LAN, não imprime senhas e escreve logs em `logs/` (fora do Git).

## 8. Recursos (Yoga: Ryzen AI 5 340, 12 threads, 15,2 GB RAM, sem GPU dedicada)

| Item | Valor |
|---|---|
| `bge-m3` carregado | 1,19 GB de RAM |
| `llama3.2:3b` carregado (só ao gerar resumo) | ≈2 GB de RAM |
| PostgreSQL (contêiner) | 84 MiB de RAM, 6% de CPU em repouso |
| Servidor MixAI (Node) | ≈90 MB |
| Banco `mixai` (todas as coleções) | 19 MB |
| Modelos do Ollama em disco | 3,2 GB |
| Indexar 341 trechos | `bge-m3` 120 s · `nomic` 53 s |
| Embedding da pergunta | ≈43 ms (`bge-m3`) · ≈30 ms (`nomic`) |
| Resposta do diagnóstico | ≈0,05 s sem resumo; 4 a 14 s com resumo (domina a geração do `llama3.2:3b`) |

## 9. Limitações

- **Sem validação física:** nada disso comprova compatibilidade com firmware, topologia, acústica ou segurança da mesa.
- O gabarito mede se o trecho **contém** o assunto, não se ele **responde** bem à pergunta; 24 perguntas dão ordem de
  grandeza, não precisão estatística. Foi montado por quem implementou, não por um técnico de som independente.
- "Voz abafada" (0/4) e parte de "cavaco" dependem de conteúdo que o corpus não tem. Adicionar fontes é o ganho maior.
- O resumo do `llama3.2:3b` é fraco (erros de concordância, hipóteses genéricas, sugere phantom para microfonia, o que é
  bloqueado). Segue **desligado por padrão**; ligado no Yoga só para avaliação. Um modelo de conversa maior ou
  externo é decisão separada.
- A filtragem P3/P5 usa a menção textual do modelo; folhetos que não nomeiam o modelo não são filtrados.
- Artigos Yamaha foram convertidos de HTML para texto de forma simples; vale conferir a fonte antes de confiar.
