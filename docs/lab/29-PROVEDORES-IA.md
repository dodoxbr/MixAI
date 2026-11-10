# Provedores de IA: Ollama, Gemini, DeepSeek e Anthropic

Quatro provedores de **texto** para o resumo da base de conhecimento e para o planejador do AutoConfig. O operador escolhe na tela
(Base de conhecimento > Provedor do resumo). Padrão: **Ollama local**. Nada aqui executa ajuste na mesa, gera comando ou autoriza algo:
o modelo continua sendo dado a exibir (resumo) ou apenas escolhe um candidato do servidor (planejador). Somente LAB.

| Provedor | Onde roda | Modelos | Embeddings | Chave |
| --- | --- | --- | --- | --- |
| Ollama | este computador | `qwen3:8b` (config) | sim | nenhuma |
| Gemini | Google (externo) | `gemini-3.8-flash` (config) | sim | `geminiApiKey` / `MIXAI_GEMINI_API_KEY` |
| **DeepSeek** | `https://api.deepseek.com` (externo, compatível com OpenAI) | `deepseek-flash` (padrão), `deepseek-v4-pro` | não | `deepseekApiKey` / `MIXAI_DEEPSEEK_API_KEY` |
| **Anthropic** | `https://api.anthropic.com` (externo) | `claude-opus-5-5` (padrão), `claude-fable-5-2` | não | `anthropicApiKey` / `ANTHROPIC_API_KEY` (a mesma do assistente) |

Identificadores conferidos na documentação oficial em 2026-11-09: Anthropic (platform.claude.com, *Models overview*: Opus 5.5 `claude-opus-5-5`,
US$ 4/20 por MTok; Fable 5.2 `claude-fable-5-2`, US$ 8/40) e DeepSeek (api-docs.deepseek.com: `deepseek-flash`, `deepseek-v4-pro`; erro 402 = saldo insuficiente).
Preços da DeepSeek (https://api-docs.deepseek.com/quick_start/pricing/, consultada em 2026-11-10, por milhão de tokens): `deepseek-flash` pico US$ 0,30 (entrada, cache miss) / US$ 1,20 (saída); `deepseek-v4-pro` pico US$ 1,32 / US$ 3,96 (fora do pico é metade). `knowledge.external.prices` usa os valores de **pico** como referência conservadora para o teto de gasto.

## Configurar a chave localmente sem revelá-la
As chaves **nunca** vão em `config.yaml`, `config.local.yaml`, Git, log, tela, chat ou PR. Dois caminhos:

1. **`config/secrets.yaml`** (já ignorado pelo Git). Abra o arquivo no editor e acrescente UMA linha, sem aspas extras:
   `deepseekApiKey: <cole a chave aqui>` (e/ou `anthropicApiKey: ...`). Não cole a chave em conversas nem em terminais com histórico.
2. **Variável de ambiente** só para o processo (PowerShell 5.1 ou 7; a digitação fica oculta e nada é impresso):
   `$s = Read-Host 'DeepSeek' -AsSecureString; $env:MIXAI_DEEPSEEK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`
   Inicie o servidor na mesma janela. Para Anthropic: `$env:ANTHROPIC_API_KEY`.

Habilite o provedor em **`config/config.local.yaml`** (também ignorado), sem chave:
```yaml
knowledge:
  deepseek: { enabled: true }          # chatModel: deepseek-flash (padrão) | deepseek-v4-pro
  anthropic: { enabled: true }         # chatModel: claude-opus-5-5 (padrão) | claude-fable-5-2
  external: { fallback: ollama, dailyBudgetUSD: 1, maxRequestsPerMinute: 10 }
```
Conferir sem exibir o valor: `Select-String -Path config\secrets.yaml -Pattern '^deepseekApiKey:\s*\S{8,}' -Quiet` (devolve só `True`/`False`).
Reinicie o servidor. A tela mostra “falta a chave” quando a chave não está presente.

## Consentimento do operador, por sessão
- Selecionar um provedor externo exige o aviso e o aceite na tela (`confirmExternal`), e o servidor recusa sem ele (400).
- O consentimento fica **só na memória**, vale para **quem confirmou** e para **aquele provedor**; qualquer nova seleção o apaga; sair da sessão o revoga; reiniciar o servidor o apaga.
  Configuração, preferência gravada (`data/knowledge/provider.json`) ou chave presente **nunca** criam consentimento. **Vale igual para Gemini, DeepSeek e Anthropic, no resumo documental, nos embeddings externos (`embedProvider: gemini`) e no planejador do AutoConfig.** Depois de reiniciar ou numa sessão nova, o provedor continua selecionado, mas nada é enviado até o operador confirmar na tela (a tela avisa: “selecionado, mas o envio ainda não foi confirmado nesta sessão”); sem consentimento o resumo usa o Ollama local (ou nada, com `fallback: none`).
- **Revogação durante uma operação:** use **Revogar envio nesta sessão** na mesma área de provedores (DELETE `/api/knowledge/providers/consent`); a preferência permanece, mas a sessão perde a concessão. Também revogam a seleção nova, logout/expiração e reinício. O consentimento é reavaliado antes de cada envio e de novo ao receber o resultado. Se foi revogado (nova seleção, voltar ao Ollama, sair da sessão) enquanto o serviço respondia, o resultado é descartado, não é exibido nem guardado em cache, e nada novo é enviado. No planejador, a mudança de consentimento/seleção durante a chamada vira `stale_policy` e a resposta tardia é descartada.
- **Fable 5.2:** o modelo exige retenção de dados por 30 dias; retenção zero só se expressamente autorizada pela Anthropic. Fonte: [documentação oficial do Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/overview), consultada em 2026-11-10. O aviso aparece ao escolher `claude-fable-5-2`; trocar modelo remove o aceite anterior e exige nova confirmação.
- Terminal do operador (`npm run knowledge -- search/eval/ingest/import-technical`) é ação explícita e usa os provedores configurados sem a tela.
- Para o externo só vão trechos de fontes públicas e a pergunta, com nomes e números sensíveis removidos; documentos locais nunca saem.

### Segurança adicional do hotfix

O commit original `ab3a51c5a08daaafe2ab872baa3764d3833185f9` foi preservado por cherry-pick na branch corretiva baseada na main `fc3abb58cf86fc3b2fd982d30a7468718ed9b360`. Nenhuma configuração de chave foi lida, copiada ou alterada.

- Cada operação conserva a revisão de consentimento do início. Revogar e confirmar novamente o mesmo provedor não torna elegível um retorno antigo (proteção contra ABA). Resultado inválido é descartado antes da exibição/cache; a próxima consulta precisa de uma operação nova.
- Antes de alterar um modelo compartilhado ou aguardar o health check de uma seleção válida, o servidor invalida concessões anteriores. Seleções são serializadas. Se a sessão terminar, o consentimento for revogado ou a política mudar durante a seleção, o modelo/preferência anterior é restaurado sem restaurar concessões. Requisições inválidas/sem aceite são recusadas antes de mudar o estado.
- Busca vetorial e ingestão pública checam a mesma concessão antes e depois dos envios. Vetores tardios não entram na busca nem são persistidos; retries/lotes posteriores não enviam nada sob uma revisão revogada. Documento local continua bloqueado, inclusive com aceite. Consultas de embeddings também passam pela redação de nomes conhecidos/padrões sensíveis.
- A revogação NÃO desfaz o que já chegou ao provedor, não garante interrupção do processamento/faturamento remoto e não apaga retenção remota. O consumo da chamada iniciada continua contabilizado. A geração só usa HTTP falso nos testes. Verificações de saúde usam GET de metadados sem pergunta/trecho; não são geração ou prova de consentimento.
- Consentimento não substitui política de conteúdo. Redação é uma proteção por padrões e cadastro, não garantia universal de anonimização. O terminal é uma fronteira privilegiada distinta: comandos explícitos do operador não criam concessões para sessões web.

## Fallback e recusas
- `knowledge.external.fallback`: `ollama` (padrão) usa o Ollama local quando o externo falha por **disponibilidade** (indisponível, tempo, erro, chave recusada, quota/saldo, resposta truncada); `none` não tenta nada.
- **Nunca** há troca de um serviço externo para outro; a cadeia é sempre “selecionado + Ollama”.
- **Recusa de segurança não tem fallback** (DeepSeek `content_filter`, Anthropic `stop_reason: refusal`, Gemini `SAFETY…`): o plano/resumo para e fica o motor determinístico.
- Sem consentimento, o externo nem é chamado: cai para o Ollama (ou nada, com `fallback: none`) e o resultado diz `fellBackFrom` / `not_consented`.

## Quem respondeu
Resumo: `narrativeStatus.{provider,model}` e `narrative.{source,model}` trazem o provedor e o **modelo informado pela API**; a tela mostra “Resumo da DeepSeek (serviço externo) (deepseek-flash)”.
Planejador: `provider.{used,model}` no resultado e `model.name` na resposta consultiva.

## Custo, limites e registro
- Preço por modelo (`knowledge.external.prices`, USD por milhão de tokens), **reserva** de custo estimado antes de cada chamada, recálculo pelos tokens informados, teto diário (`dailyBudgetUSD`),
  limite por minuto, `maxOutputTokens` e timeouts por provedor (`timeoutMs`, `narrativeTimeoutMs`). Esgotado o teto, a recusa é local (sem rede) como `quota`.
- Reserva de entrada: bytes UTF-8 de sistema/pergunta + margem de 128 tokens de envelope; reserva de saída: teto configurado. É uma heurística conservadora, não tokenizador exato nem garantia de custo máximo. Evita subestimar acentos/emoji pela regra antiga de dois caracteres por token. Ao receber `usage`, usa os totais informados pela API.
- DeepSeek: todos os tokens de entrada são estimados a preço de **cache miss/pico**; descontos de cache hit/fora de pico não são presumidos. Para 1 milhão de tokens de entrada e 1 milhão de saída, referência Flash = US$ 1,50; V4 Pro = US$ 5,28. Preços configurados e estimativa não incluem uma garantia de fatura, câmbio ou tributos.
- Registro em `data/external-ai-usage.json` (fora do Git) compartilhado por resumo e planejador. É proteção por **estimativa**, não substitui o painel de faturamento.
- Log de consumo: `IA externa: provedor=deepseek modelo=deepseek-flash resultado=ok tokens_entrada=… tokens_saida=… custo_estimado_usd=…`. Sem chave, pergunta, resposta ou nome.
- Erros viram códigos (`auth`, `quota` com motivo `insufficient_balance`/`budget`/`rate_limit`, `timeout`, `unavailable`, `refused`, `truncated`); o corpo do erro do servidor nunca é lido para fora do cliente.
- Planejador: prazo de 5 s para o Ollama e **20 s** para provedores externos (abaixo do prazo da interface).

## Limites e riscos
- Nenhuma chamada paga foi feita nos testes (provedores simulados). Os comportamentos reais de `deepseek-v4-pro` e dos modelos Claude 5.x (raciocínio adaptativo consome o teto de tokens; `truncated` descarta) dependem de validação com uma chave real, sob sua autorização.
- DeepSeek: a API usa raciocínio por padrão, o que consumiria o teto de tokens do resumo; por isso o cliente envia `thinking: {type: "disabled"}` (formato do exemplo da documentação; `knowledge.deepseek.thinking: default` não envia o campo, caso a API recuse). Esse parâmetro só foi validado com provedor simulado. Só `message.content` / blocos `text` são usados.
- Privacidade: texto enviado a serviço externo sai do computador; o consentimento é do operador.
- Esta entrega não altera o núcleo D, as aprovações, a interface do AutoConfig, nem habilita escrita REAL.
