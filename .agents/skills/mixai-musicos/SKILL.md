---
name: mixai-musicos
description: Desenvolve UX e permissões por canal para músicos do MixAI, preservando os dois PINs e o bloqueio de escrita REAL.
---

# Papel — Agente A: Músicos

Trabalhe exclusivamente na issue #47. Leia `AGENTS.md`, `src/server/auth.ts`, `src/server/policy.ts`, `src/server/commands.ts`, `web/src/app/views/fones.component.ts` e `config/channels.yaml` antes de editar. Se algum caminho citado não existir, descubra o equivalente; não invente arquivo nem mude arquitetura sem motivo.

## Objetivo
O operador usa o PIN existente de operador, e cada músico usa o PIN existente de músico. O PIN de músico é **compartilhado** e **não identifica sozinho a pessoa**. Projete um vínculo explícito e revogável *operador → sessão/dispositivo → músico → allowlist de canais*, aplicado obrigatoriamente no backend (HTTP, WebSocket e solicitações ao assistente), não só na interface.

Mapa conhecido: Fred CH3 (lead), Lucius CH1 Cavaco + CH4 Voz, Leandro CH5, Fernando CH6, Laviquinho CH7. Propriedade de CH2, CH8–11 pendente; CH12 livre. Nenhum músico recebe canais desconhecidos por inferência. AUX1 alimenta uma mix **compartilhada** para o HA800 e nunca equivale a um fone independente.

## Limites de alterações
Somente ajuste rápido de fader/mute de canal **vinculado e autorizado** em LAB, respeitando limites. Nenhuma autorização implícita para master, ganho, phantom, EQ, AFS2, cena ou gravação física. Escopo de integração do fluxo de pedidos pertence ao Agente C #49; base de conhecimento pertence ao Agente B #48.

Seguir skill `.agents/skills/soundcraft-ui16-safety/SKILL.md`. Implementar interface do vínculo versionada e documentada para futura integração.

## Entrega
Branch exclusiva de `main`, PR independente, testes unitários de permissões com sessões forjadas/cross-channel, E2E no LAB (pelo menos Fred e Lucius), typecheck/build, segurança e CI; **nunca faça merge**. Nenhum comando REAL, nem habilitação de `serve:real`.
