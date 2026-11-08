# Provedores de IA da base de conhecimento (Ollama, Gemini, motor determinístico)

Continua `21-LOCAL-KNOWLEDGE-INFRASTRUCTURE.md` e `22-KNOWLEDGE-SEARCH-QUALITY.md`. A decisão de usar um provedor
externo é do responsável pelo projeto; este documento descreve o que a arquitetura faz e o que ela **não** consegue garantir.

## Ordem de fallback

```
resumo:      provedor escolhido ──falha de disponibilidade──▶ Ollama local ──falha──▶ sem resumo (motor determinístico)
embeddings:  provedor da coleção ───────falha───────────────▶ busca por palavras ───▶ motor determinístico
```

- O **motor determinístico** (diagnóstico estruturado, referências, ficha do microfone) nunca depende de nenhum provedor.
- Só falhas de **disponibilidade** passam para o provedor seguinte: `unavailable`, `timeout`, `error`, `auth`, `quota`,
  `refused` e `withheld`. Um descarte de **segurança** (`blocked`: valor de processamento, comando, "ouvi/medi", phantom)
  **não** tenta outro modelo.
- Embeddings não têm fallback entre provedores: vetores de modelos diferentes não são comparáveis. Se o provedor da coleção
  cai, a busca usa palavras.

## Configuração

Padrão: tudo local; **Gemini desligado**. Em `config/config.local.yaml` (sem segredos):

```yaml
knowledge:
  chatProvider: ollama          # provedor inicial do resumo
  gemini:
    enabled: true               # sem isto nenhum dado sai do computador
    chatModel: gemini-2.5-flash
```

A chave fica **só** em `config/secrets.yaml` (`geminiApiKey: "…"`, ignorado pelo Git) ou na variável `MIXAI_GEMINI_API_KEY`.
O `config.local.yaml` recusa o campo (`geminiApiKey`/`apiKey`). Escolher `gemini` sem `enabled: true` é erro de configuração.

O operador troca o provedor do **resumo** no painel "Base de conhecimento → Provedor do resumo". A tela mostra o aviso,
exige marcar o consentimento, e o servidor ainda confere: Gemini habilitado, chave presente e serviço respondendo.
A escolha fica em `data/knowledge/provider.json` (só o nome do provedor) e vale na próxima abertura **se** o Gemini
continuar habilitado e com chave; do contrário o MixAI volta ao Ollama e registra o motivo.

Embeddings pelo Gemini (`embedProvider: gemini`) são opção separada de configuração, **não** da tela, e exigem
`collection` própria (ex.: `gem768`) e `gemini.embedDimensions` coerente: o status acusa troca de modelo sem troca de coleção.

## O que sai do computador (provedor externo)

| Dado | Sai? |
|---|---|
| Pergunta do operador | **Sim, depois de remover**: PIN/números com 4+ dígitos, tokens, caminhos, e-mails, IPs, links e nomes dos músicos |
| Trechos de manuais **públicos** do catálogo (URL https real) | Sim (só o trecho exibido, até 420 caracteres) |
| Trechos de documentos que o operador pôs na pasta de ingestão (`local-*`) | **Não**: o resumo cai para o Ollama local (`withheld`) |
| Trechos de tabela com vários modelos de microfone | Não (nem para o modelo local) |
| Chave, PIN, token, hashes, configuração, estado da mesa, áudio | **Não** |
| Embeddings externos: documentos do catálogo | Sim, só com `embedProvider: gemini`; documentos locais são ignorados |

A chave vai **só** no cabeçalho `x-goog-api-key`: nunca na URL, no corpo, no log, no status ou na tela. O endereço da API é fixo no
código (`generativelanguage.googleapis.com`), sem redirecionamento e sem credenciais de navegador. Mensagens de erro do servidor
nunca são repassadas: só códigos (`auth`, `quota`, `timeout`…). O modelo não recebe ferramentas nem funções; a resposta é texto
exibido como "não verificado" e passa pelas mesmas regras de descarte do modelo local.

## Segurança LAB/REAL

Nada muda no controle da mesa: o provedor só devolve texto de apoio. Não há caminho do texto do modelo para o controlador,
a fila ou o mixer; as rotas de provedor são **exclusivas do operador**, com verificação de origem, corpo estrito (campo extra
é recusado) e sem escrita REAL. O MixAI continua exigindo aprovação humana para qualquer comando.

## Limitações

- **(Histórico — veja "Validação com o Gemini real" abaixo)** O PR original não foi testado contra o serviço real: não havia chave. Os testes usam um Gemini falso que reproduz o contrato
  REST documentado (`generateContent`, `batchEmbedContents`, cabeçalho `x-goog-api-key`). Antes de uso real é preciso conferir
  nomes de modelos, formato da resposta e cotas na documentação atual do Google; os nomes padrão (`gemini-2.5-flash`,
  `gemini-embedding-001`) são configuráveis justamente por isso.
- **Privacidade no plano gratuito**: os termos da API do Google podem permitir o uso dos dados enviados para melhorar produtos
  no plano gratuito e não no pago. Confira os termos vigentes antes de habilitar. A remoção de dados sensíveis é por
  padrões (regras e lista de nomes de músicos): reduz o risco, **não** garante que nada pessoal escape de um texto livre.
- Custo, cota e latência do serviço externo são do plano da conta; o MixAI não impõe orçamento para o Gemini (a Anthropic
  tem `ai.dailyBudgetUSD`; o Gemini ainda não).
- Com internet via celular (como nos eventos), o resumo externo depende dessa conexão e pode estourar o tempo; o fallback local cobre.
- Embeddings externos exigem reindexar numa coleção nova (os de 768 dimensões do Ollama não servem).

## Validação com o Gemini real (2026-11-08, LAB, sem mesa)

Primeiro teste contra o serviço real (a seção "Limitações" acima descreve o estado antes dele).

- **Modelo padrão trocado:** `gemini-2.5-flash` devolve 404 para contas novas ("no longer available to new users");
  o padrão agora é `gemini-3.8-flash`. Modelos listados pela API na data: `gemini-3.8-flash`, `gemini-3.5-flash`,
  `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-flash-latest`.
- **Respostas cortadas (causa e correção):** os modelos Gemini 3 contam o raciocínio dentro de `maxOutputTokens`. Com o teto
  antigo de 320, `gemini-3.8-flash` gastou 306 tokens pensando e 10 escrevendo (`finishReason=MAX_TOKENS`); o cliente
  concatenava o texto parcial e o exibia. Agora: `MAX_TOKENS` (Gemini) e `done_reason=length` (Ollama) viram a falha
  `truncated` e **nunca** são exibidos; o log registra só `motivo=truncated:max_tokens, provedor=…`, sem conteúdo. Outro
  motivo de parada diferente de `STOP` vira `error`. O teto padrão é 2048 e há `thinkingLevel` (padrão `low`), ambos em
  `knowledge.gemini`. O limite de exibição de 700 caracteres agora corta na última frase completa, não no meio.
- **`thinkingLevel` depende do modelo:** `minimal` dá HTTP 400 no `gemini-3.8-flash`; no `gemini-3.5-flash`, `low` ainda gastou
  929 tokens e `minimal` não gastou nenhum. Use `default` para não enviar o campo.
- **Recuperação em português:** o `nomic-embed-text` casa mal perguntas em português com manuais em inglês. Avaliação
  (`npm run knowledge -- eval --live`, 367 trechos reais, acerto@k): Ollama + `auto` 21%, Ollama + `hybrid` 38%,
  **Gemini embeddings (`gemini-embedding-001`, coleção `gem768`) + `hybrid` 79%**. Só os manuais públicos do catálogo
  foram enviados para gerar vetores; documentos locais não saem. Configuração local usada: `collection: gem768`,
  `embedProvider: gemini`, `search: hybrid`.
- **Latência (resumo, 4 perguntas, trechos já recuperados):** `gemini-3.5-flash` ≈ 1,2–1,8 s, `gemini-3.1-flash-lite` ≈ 1,6–2,1 s,
  `gemini-3.8-flash` ≈ 2,2–4,6 s. O `gemini-3.5-flash-lite` descartou todas as respostas como "sem base".
- **Fundamentação:** com trechos relevantes (Shure, Ui12/16) as respostas vieram completas, em frases inteiras, sem valores
  nem comandos. Sem trecho que sustente a resposta, o modelo responde "não há base suficiente" e o MixAI descarta o resumo.
- **Limites que continuam:** ficha técnica do AKG P3/P5 é tabela com vários modelos (trecho com aviso, fora do resumo por
  desenho); a página oficial do AKG P3 S (`br.akg.com`) bloqueia download automático (403) e o manual Ui16 v3 (39 MB) passa de
  `maxDocumentMB`; perguntas só com vocabulário coloquial ("abafada", "sem grave") ainda recuperam pouco; falta expansão de
  consulta PT→EN. Nada disso toca a mesa; a Ui16 não foi acessada.
