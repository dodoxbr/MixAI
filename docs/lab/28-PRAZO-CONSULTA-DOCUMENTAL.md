# Prazo da consulta documental na resposta do assistente (hotfix)

**Sintoma (LAB):** na tela Mesa, o relato "O surdo no canal 8 está sem grave no PA…" abria o painel ("sem IA") com
"Sem resposta no prazo ou conexão interrompida".

## Causa raiz
A interface desiste de um pedido do assistente em **25 s** (`web/src/app/core/live.service.ts`, `assistant(..., timeoutMs = 25_000)`).
No servidor, a orientação local (determinística, instantânea) só era enviada **depois** de `LocalKnowledge.enrich()`, que faz a busca
(embedding, até 8 s) e o resumo do `qwen3:8b` (até 30 s + 2 s). Pior caso ≈ 40 s. Com os modelos frios ou disputando a GPU (6,4 GiB livres para
`qwen3:8b` 5,6 GiB + `bge-m3`), o `server.log` do Ollama mostra o carregamento do qwen3 em ~18 s, um `/api/embed` abortado em 8 s e um `/api/chat` encerrado em 30 s.
A resposta chegava depois dos 25 s e era descartada ("lost"), e o servidor registrava `resumo do modelo descartado (motivo=timeout, provedor=ollama)`.

"sem IA" no painel **não** é o erro: significa apenas que a chave do Claude não está configurada (`hello.assistant.ai = false`); a orientação local e o resumo do Ollama não dependem dela.
O provedor de conversa é o Ollama (`data/knowledge/provider.json` = `ollama`); nenhum envio ao Gemini ocorre nesse caminho.

## Correção
O resumo/busca é **opcional**; não pode reter a orientação além do prazo da interface.
`AssistantService.withKnowledge` agora limita a consulta a `knowledge.replyDeadlineMs` (padrão **20 s**, aceito de 1 a 24 s, sempre abaixo dos 25 s da interface).
Passado o prazo, a resposta sai com a orientação local e um contexto degradado (`narrativeStatus: timeout`, motivo legível); o resultado tardio é descartado e não entra no cache.
Uma rejeição inesperada de `enrich` também vira contexto degradado em vez de derrubar a resposta.

Não muda: nenhum pedido é repetido automaticamente; propostas e aplicação continuam por toque do operador; núcleo D, permissões e aprovações intactos.

## Efeito e limites
- Com o modelo frio, a primeira resposta pode vir sem o resumo; a seguinte (modelo já carregado, `keep_alive` 30 min) costuma trazê-lo.
- Não aquece o modelo na subida nem altera `narrativeTimeoutMs`. Aquecer o `qwen3:8b` ao iniciar é uma melhoria separada.
- Testes: `test/assistant-knowledge-deadline.test.ts` (reproduz com consulta lenta, sem cache tardio, consulta rápida intacta, rejeição, relação com os 25 s da interface, configuração).
