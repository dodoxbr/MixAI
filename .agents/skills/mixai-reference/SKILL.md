---
name: mixai-reference
description: Use when building saved mix references, preset comparison, show soundcheck scenes, musician requests and operator approval workflows in MixAI without altering the real Ui16.
---

# MixAI — referência de mixagem com comparação, não correção automática

## Distinções obrigatórias
- **Cena MixAI E5:** estrutura versionada em `src/core/scene.ts` e `src/core/scene-store.ts`, com carregamento limitado ao LAB.
- **Snapshot nativo Soundcraft:** recurso independente da Ui16, com semântica própria. Não inferir equivalência de parâmetros.
- **Mixagem de referência:** foto explicitamente salva e aprovada pelo operador, contendo dados disponíveis de PA e AUX1, metadados do evento, versão e origem.
- **Mixagem atual:** leitura ao vivo/estado do laboratório com revisão, possível perda de sincronização ou parâmetros não observáveis.
- A diferença `atual - referência` não significa erro sonoro nem permissão para desfazer. Ajuste externo pode ser intencional.

## Fluxo
1. Operador salva referência no LAB após passagem de som simulada, atribui rótulo e revisão, marca `unverified` se ainda não houve teste acústico.
2. UI apresenta `PA` e `FONES: AUX1 COMPARTILHADO`, valor de referência, atual, delta e `indisponível/desatualizado` quando aplicável; proibido estimar VU ou espectro.
3. Solicitação de músico: `sourceSessionId` e identidade vinculada quando fornecida por política autorizada (#47), descrição curta/sanitizada, canal alvo, destino, data/hora, estado e trilha de auditoria. Sem identidade válida, marcar origem como não verificada e não conceder privilégios.
4. Estados de pedido e transições controladas pelo servidor; verificação de revisão para evitar aplicar recomendações obsoletas.
5. Diagnóstico (#48) poderá anexar recomendação estruturada **sem executar**; operador avalia, aprova ou recusa. Um click comum autorizado não vira fluxo de múltiplas aprovações; operações críticas permanecem protegidas.
6. Nunca fazer restore automático contra faders alterados na UI Soundcraft; comparação é alerta, não lock ou loop de controle.
7. Guardar histórico com proteção de escrita atômica/backup, sem segredos; manter referências de versionamento ao editar.

## Matriz mínima de testes
Alteração externa de CH1/CH3; coros CH4–7; revisão concorrente; master alterado; AUX1 compartilhado; referência sem dados completos; armazenamento/corrupção; dois pedidos simultâneos; músico sem vínculo; solicitação de outros canais; ausência de medições reais; reinício do servidor; edição de cena em LAB vs tentativa REAL.

## Escopo
Issue #49. `AGENTS.md` proíbe escrita REAL/E6; teste apenas LAB, PR independente e revisão humana antes de merge. Não implementar autorização de canais (#47) nem motor de diagnóstico (#48).
