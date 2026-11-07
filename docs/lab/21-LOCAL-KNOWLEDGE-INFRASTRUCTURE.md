# 21 — Infraestrutura local da base de conhecimento (PostgreSQL + pgvector + Ollama)

Branch `feature/mixai-local-infrastructure`. **Não há escrita REAL, não há comando para a Ui16 e a
mesa não é tocada.** A base é só leitura de documentos técnicos e fica **desligada por padrão**.

## O que existe

| Peça | Onde | Observação |
| --- | --- | --- |
| Docker Compose | `docker-compose.yml`, `.env.example`, `infra/postgres/init/` | PostgreSQL + pgvector e Ollama, portas só em `127.0.0.1`, senha obrigatória em `.env` |
| Pacote base da banda v1.2 | `knowledge/seed/banda-v1_2/` | catálogo de fontes, ficha do AKG P3 S, 6 casos teóricos (sem PDFs de fabricante) |
| Núcleo | `src/knowledge/local/` | pacote (zod), armazenamento em arquivo **ou** PostgreSQL, Ollama, ingestão, busca, enriquecimento |
| API de administração | `src/server/knowledge-routes.ts` | `/api/knowledge/*`, **exclusiva do operador** |
| Interface | `web/src/app/knowledge/` | painel "Base de conhecimento" (operador) e bloco "Base local" nos detalhes técnicos do chat |
| CLI | `npm run knowledge -- <comando>` | `doctor`, `import-seed`, `import-zip`, `ingest`, `search` (sem scripts `.ps1`) |

## Cadeia de fallback (o motor de diagnóstico nunca é substituído)

1. **Vetorial** — Ollama com o modelo de embedding + trechos com vetor na base.
2. **Palavras** — Ollama fora do ar ou sem embeddings: busca por palavras (BM25 simples no arquivo, `tsvector` no PostgreSQL).
3. **Determinístico** — base vazia, desligada ou com erro: a resposta é exatamente a do motor existente.

A base só **acrescenta** o campo `knowledge` à resposta do operador (trechos citados, ficha do microfone,
roteiro teórico relacionado e, se ligado, um resumo do modelo local marcado como *não verificado*).
Falha em qualquer ponto é contida; o diagnóstico (`diagnosis`, `text`, `proposals`) não muda.

## Ligar neste computador (Windows)

1. `config/config.local.yaml` (fora do Git):
   ```yaml
   knowledge:
     enabled: true        # store: file funciona sem Docker
   ```
2. Reinicie: `npm run build` e `npm run serve:lab`. A seção "Base de conhecimento" aparece para o operador.
3. Importe o pacote base: botão **Importar pacote base** ou `npm run knowledge -- import-seed`.
4. Documentos: coloque `.md`, `.txt` ou `.pdf` em `data/knowledge/inbox/`. O nome do arquivo liga a
   fonte do catálogo: `akg-p3.pdf` ou `akg-p3__ficha.pdf` → fonte `akg-p3`. Outros nomes viram fonte
   `local-...`. Depois clique **Ingerir pasta de documentos** ou rode `npm run knowledge -- ingest`.
   PDFs de fabricantes **não** vão para o Git (licença e tamanho): ficam só em `data/` (ignorado).

### PostgreSQL + pgvector e Ollama (opcional)

```powershell
copy .env.example .env          # edite .env: MIXAI_PG_PASSWORD (mínimo 8 caracteres)
docker compose up -d
docker compose exec ollama ollama pull nomic-embed-text
docker compose exec ollama ollama pull llama3.2:3b     # só se for usar o resumo (narrative)
```

Em `config/config.local.yaml`: `knowledge: { enabled: true, store: postgres }`. A senha entra por
`MIXAI_PG_PASSWORD` no ambiente ou `postgresPassword` em `config/secrets.yaml` (nunca no
`config.local.yaml`; o carregador recusa). Se o PostgreSQL não responder, o MixAI **continua** com o
arquivo local e o painel mostra o aviso. `npm run knowledge -- doctor` resume o ambiente.

Para trocar o modelo de embedding, ajuste `knowledge.ollama.embedModel` **e** `embedDimensions`
(a tabela `knowledge_chunks` é criada com essa dimensão; mudar depois exige recriar o volume).

## Microfones AKG P3 S

O pacote cadastra o modelo `akg-p3s` (cardioide, ficha do fabricante) e os canais: CH3 Fred, CH4 Lucius
e CH6 Fernando como *relato do operador*; **CH5 Leandro e CH7 Laviquinho ficam sem modelo** até o
operador confirmar na tela. Regras: modelo nunca é presumido; sem confirmação o texto diz *não inferir
padrão polar*; a ficha não vira EQ, ganho, rejeição de retorno nem phantom. Reimportar o pacote **não
desfaz** uma confirmação feita pelo operador. (O README do pacote lembra que um "AKG P35" não foi
encontrado nas fontes oficiais — só o P3 S foi confirmado.)

## Segurança

- Tudo em loopback: o `config` recusa URL do Ollama ou host do PostgreSQL fora de `127.0.0.1`/`localhost`/`::1`, URL com credenciais e `https`.
- API só para o operador (músico e agente MCP recebem 403); escrita exige a mesma origem; importação e ingestão uma por vez; erros sem caminho, SQL ou conteúdo.
- Ingestão: só a pasta `data/knowledge/inbox` (sem recursão, sem links simbólicos, nomes restritos, `.md/.txt/.pdf`, limite de tamanho, no máximo 3000 trechos por documento). O conteúdo é **dado não confiável**: nunca vira instrução.
- O resumo do modelo local usa só os trechos recuperados, dentro de delimitadores `<trecho>`, é cortado em 700 caracteres e **descartado** se citar valores de dB/Hz/kHz ou verbos de execução. Vem desligado (`narrative: false`).
- SQL sempre parametrizado; o único valor interpolado é a dimensão do vetor, validada como inteiro. O módulo `src/knowledge/local` não importa mesa, controlador, fila, autenticação nem servidor (há teste).
- `.env` segue ignorado; `.env.example` é versionado e sem senha.

## O que NÃO foi validado (pendências)

- **Docker, PostgreSQL e Ollama não estão instalados no Yoga**: o `docker-compose.yml` foi validado por teste estático (portas, senha, volumes), **mas não foi executado**. O SQL do PostgreSQL foi testado contra um cliente falso (parametrização, dimensão, mapeamento) — **não contra um banco real com pgvector**. Os embeddings foram testados com um Ollama simulado.
- Qualidade da busca semântica, latência do modelo e do `ollama pull` em hardware real; escolha final dos modelos.
- Os 6 casos de diagnóstico são **teoria não testada em ensaio** (`validation: theory_not_tested_in_rehearsal`). Nenhuma medição de áudio/RTA existe.
- Sem validação física com a Ui16, firmware ou topologia. E6 e escrita REAL continuam não autorizadas.
