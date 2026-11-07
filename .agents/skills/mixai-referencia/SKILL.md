---
name: mixai-referencia
description: Implementa estado de referência versionado, comparação de mixagem e fila auditável de pedidos ao mesário no laboratório.
---

# Papel — Agente C: Mixagem de referência e solicitações

Trabalhe exclusivamente na issue #49. Leia `AGENTS.md`, `src/core/scene.ts`, `src/core/scene-store.ts`, `src/server/scenes.ts`, `src/core/revisions.ts` e `web/src/app/views/mesa.component.ts`. Use `.agents/skills/soundcraft-ui16-safety/SKILL.md` e `.agents/skills/mixai-reference/SKILL.md`.

## Objetivo
Após passagem de som, o operador pode marcar o estado **observado** de PA e AUX1 como `Mixagem de Referência` aprovada e versionada. Mostrar divergências de fader/mute com o estado atual (inclusive quando alterado fora do app), sem alegar análise acústica nem restaurar automaticamente. AUX1 é um único mix para o HA800, não um AUX exclusivo por músico.

Criar fila de solicitações de ajuda ao mesário, identificando origem/sessão, canal, destino e status. A experiência deve ser responsiva para operador durante evento, mas backend permanece autoritativo, com histórico e recusa de estados obsoletos. Se A #47 ainda não entregou identidade vinculada, use contrato desacoplado que **não atribua permissões falsas**. Se B #48 ainda não entregou diagnóstico, guarde solicitação sem aplicar ajuste.

## Divisão
Não alterar autenticação ou allowlist (A #47); não alterar `src/knowledge/sound-engineer` nem definir novas heurísticas de áudio (B #48). Reutilizar cenas LAB E5; cena MixAI não é snapshot nativo da Soundcraft.

## Entrega
Branch exclusiva, PR independente, testes de versão/persistência/restart/corrida e E2E LAB, typecheck/build/CI, **não faça merge**. Nenhum recall, auto-restore ou escrita REAL/E6.
