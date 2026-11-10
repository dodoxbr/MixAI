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
**Preços da DeepSeek não constam nas páginas consultadas**: os valores em `knowledge.external.prices` são estimativas conservadoras para o teto de gasto; confira a página oficial e ajuste.

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
  Configuração, preferência gravada ou chave presente **nunca** criam consentimento (para DeepSeek e Anthropic, o assistente passa o consentimento da sessão a cada consulta; sem ele, o resumo usa o Ollama local ou nada).
- **Gemini:** o fluxo anterior foi preservado (a escolha confirmada pelo operador persiste); o planejador do AutoConfig já exigia consentimento por sessão para ele. Alinhar o resumo do Gemini ao consentimento por sessão é uma decisão do responsável.
- Para o externo só vão trechos de fontes públicas e a pergunta, com nomes e números sensíveis removidos; documentos locais nunca saem.

## Fallback e recusas
- `knowledge.external.fallback`: `ollama` (padrão) usa o Ollama local quando o externo falha por **disponibilidade** (indisponível, tempo, erro, chave recusada, quota/saldo, resposta truncada); `none` não tenta nada.
- **Nunca** há troca de um serviço externo para outro; a cadeia é sempre “selecionado + Ollama”.
- **Recusa de segurança não tem fallback** (DeepSeek `content_filter`, Anthropic `stop_reason: refusal`, Gemini `SAFETY…`): o plano/resumo para e fica o motor determinístico.
- Sem consentimento, o externo nem é chamado: cai para o Ollama (ou nada, com `fallback: none`) e o resultado diz `fellBackFrom` / `not_consented`.

## Quem respondeu
Resumo: `narrativeStatus.{provider,model}` e `narrative.{source,model}` trazem o provedor e o **modelo informado pela API**; a tela mostra “Resumo da DeepSeek (serviço externo) (deepseek-flash)”.
Planejador: `provider.{used,model}` no resultado e `model.name` na resposta consultiva.

## Custo, limites e registro
- Preço por modelo (`knowledge.external.prices`, USD por milhão de tokens), **reserva** do custo máximo antes de cada chamada, troca pelo consumo real, teto diário (`dailyBudgetUSD`),
  limite por minuto, `maxOutputTokens` e timeouts por provedor (`timeoutMs`, `narrativeTimeoutMs`). Esgotado o teto, a recusa é local (sem rede) como `quota`.
- Registro em `data/external-ai-usage.json` (fora do Git) compartilhado por resumo e planejador. É proteção por **estimativa**, não substitui o painel de faturamento.
- Log de consumo: `IA externa: provedor=deepseek modelo=deepseek-flash resultado=ok tokens_entrada=… tokens_saida=… custo_estimado_usd=…`. Sem chave, pergunta, resposta ou nome.
- Erros viram códigos (`auth`, `quota` com motivo `insufficient_balance`/`budget`/`rate_limit`, `timeout`, `unavailable`, `refused`, `truncated`); o corpo do erro do servidor nunca é lido para fora do cliente.
- Planejador: prazo de 5 s para o Ollama e **20 s** para provedores externos (abaixo do prazo da interface).

## Limites e riscos
- Nenhuma chamada paga foi feita nos testes (provedores simulados). Os comportamentos reais de `deepseek-v4-pro` e dos modelos Claude 5.x (raciocínio adaptativo consome o teto de tokens; `truncated` descarta) dependem de validação com uma chave real, sob sua autorização.
- Parâmetros opcionais de raciocínio não foram enviados (não confirmados na documentação consultada); só `message.content` / blocos `text` são usados.
- Privacidade: texto enviado a serviço externo sai do computador; o consentimento é do operador.
- Esta entrega não altera o núcleo D, as aprovações, a interface do AutoConfig, nem habilita escrita REAL.
- Depende do hotfix #90 (prazo da consulta documental) — este PR está empilhado nele.
