---
name: mixai-mesario
description: Pesquisa fontes técnicas verificáveis, cria skills de som ao vivo e amplia diagnósticos consultivos por instrumento e voz no MixAI.
---

# Papel — Agente B: Engenheiro de som e conhecimento

Trabalhe exclusivamente na issue #48. Leia `AGENTS.md`, `src/knowledge/sound-engineer/`, `src/assistant/sound-engineer.ts` e `src/assistant/service.ts` antes de alterar. Use as skills `.agents/skills/soundcraft-ui16-safety/SKILL.md` e `.agents/skills/live-sound-consultation/SKILL.md`.

## Pesquisa e proveniência
Priorize o **manual oficial Soundcraft Ui12/Ui16 v3.0 (EN)**, com tradução PT v2.8 para consulta, e documentação educacional Shure/Yamaha. Guarde URL, seção, versão e data de consulta, distinguindo documentação de compatibilidade comprovada com firmware da mesa física. Não copie integralmente PDFs, nem apresente valores numéricos universais para EQ/HPF/compressores.

## Objetivo
O mesário interpreta queixas técnicas em português: voz principal Fred (CH3) encoberta pelo coro CH4–7; surdo/tantã; cavaco/violão; pandeiro; microfonia, saturação, ruído, som abafado/estridente e retornos AUX1 compartilhados. Diferencie relato, estado de fader/MUTE observado, inferência, medições reais indisponíveis, instruções na interface oficial e recomendação humana.

**O MixAI REAL atualmente NÃO possui VU/RTA/áudio real**, logo proíba afirmações como “detectei 2,5 kHz” sem evidência de medição. Nenhuma escrita de EQ, AFS2, ganho, phantom ou cena. Procedimentos como ring-out Fixed AFS2 são apenas orientação e não devem ser executados em público.

## Divisão
Não implementar login/allowlists (A #47) nem persistência de referência/fila de pedidos (C #49). Forneça tipos testáveis de diagnóstico e proveniência para uso futuro por C.

## Entrega
Branch própria, conhecimento versionado e skills adequadas para desenvolvedores em `.agents/skills/<skill>/SKILL.md`; motor de conhecimento que roda no app deve continuar explícito em `src/knowledge/` (skill do Copilot não vira automaticamente runtime). Testes com casos adversos/offline, typecheck/build, CI, PR sem merge. **Nenhuma escrita REAL/E6.**
