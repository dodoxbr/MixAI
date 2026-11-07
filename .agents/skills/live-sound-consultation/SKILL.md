---
name: live-sound-consultation
description: Use when researching or implementing MixAI virtual sound engineer reasoning about samba and pagode vocals, cavaco, violao, surdo, pandeiro, tanta, feedback, equalization, gain staging, AUX or dbx AFS2.
---

# Mesário MixAI — conhecimento de som ao vivo com fontes

## Roteiro de consulta
1. Identificar **quem e qual fonte/canal**, além do destino **PA** ou **FONES AUX1 compartilhado**. Se a identidade não tiver vínculo seguro, **não inferir proprietário do canal**.
2. Separar explicitamente quatro itens: **dados observados** (fader/MUTE/estado com revisão e momento); **relato subjetivo** do músico; **hipóteses técnicas**; **medições não disponíveis**. Não confundir fader (dB de atenuação/ganho do canal) com nível de pressão sonora ou espectro.
3. Consultar guia do instrumento em `src/knowledge/sound-engineer/instruments.ts` e fonte técnica verificável em `src/knowledge/sound-engineer/sources.ts`.
4. Para queixa de microfonia, perguntar se é PA ou monitor/AUX, quais microfones, posicionamento relativo às caixas, mudanças recentes e quando ocorre. Iniciar pela **posição dos microfones/caixas, quantidade de microfones abertos, ganho e volume**, antes de sugerir cirurgia de EQ. Nunca apontar frequência exata sem análise espectral real.
5. Identificar papel musical: Fred CH3 **lead**; CH4–7 backing/coro; cavaco/violão em disputa potencial de médios, surdo/tantã de graves; pandeiro tem pele e platinelas. Evitar preset numérico universal e não reduzir tudo a um único EQ.
6. Ao citar parâmetros `HPF`, `Q`, EQ, AFS2, gate, compressores ou pré-amplificação, distinguir recurso descrito **no manual** de recurso com **leitura/controle comprovado no hardware específico**.
7. Propor **próxima verificação** e critério observável de melhora/piora; descreva reversão manual pela UI oficial, não automatização de recuperação. Se faltar evidência, oferecer opções sem executar.
8. Adicionar `source URL`, `version`, `section`, `consultedOn` e `validationStatus: theory|verified_at_rehearsal` para cada guia/recomendação. **Recomendação não vira ação automática**.

## Ui16 — pistas do manual, não comando
- Manual Ui12/Ui16 EN v3.0, §§5.2 (EQ paramétrico), 5.3 (GEQ/RTA), 5.3.1 (dbx AFS²), 4.3 (AUX sends), 4.1 (gain), 5.4 (compressão) e §8 (shows/snapshots).
- AFS²: 12 filtros de supressão de realimentação segundo o manual; `Fixed` é preparo antes da apresentação, `Live` é durante o evento, no master e nos masters AUX. **Não orientar ring-out em evento com público. Nunca executar AFS2 a partir do MixAI experimental.**
- Guia da Shure sobre microfonia: posicionamento e relação microfone-caixa e número de microfones abertos precedem a equalização. EQ e supressores não substituem configuração física adequada.
- Guia da Yamaha explica headroom, equalização e ganho como princípios gerais. Nem um preset Yamaha nem estimativas numéricas garantem compatibilidade Soundcraft.

## Formato sugerido de saída
- **Problema:** `<identidade, canal, destino, sintoma>`.
- **Observei:** `<leituras e fonte>` ou `indisponível`.
- **Relato:** `<frase resumida de quem informou>`.
- **Hipóteses:** 1–3 alternativas condicionais, sem certeza artificial.
- **Inspeção rápida:** ação manual segura, impacto esperado e pergunta de confirmação.
- **Proposta:** `nenhuma` se sem autorização/medição; ou objeto estruturado limitado a parâmetro validado **no LAB**.
- **Fontes e limites:** seção, URL, versão, status de validação.

## Leituras oficiais
- Soundcraft EN v3.0: https://www.soundcraft.com/en-US/product_documents/ui_usermanual_v3-0-pdf-27c992b4-5132-4d2d-b8e2-79750de6ee29
- Soundcraft PT v2.8: https://www.soundcraft.com/en/product_documents/ui_manual_v2-8_portuguese-pdf-f4a4a2c5-8071-4005-83d4-aad7ca399fb3
- Shure: https://service.shure.com/articles/en_US/Knowledge/how-do-i-fix-my-feedback-problem
- Referências Shure/Yamaha adicionais estão em `src/knowledge/sound-engineer/sources.ts`.

## Testes mínimos
Fred encoberto por coro; pandeiro estridente; surdo vs tantã; violão de 7 cordas; cavaco sobressaindo; microfonia nos fones vs PA; usuário pede frequência exata sem RTA; estado desconhecido; ausência de internet/IA; pedido de escrita de EQ/AFS2 REAL. Todos devem permanecer somente consulta sem comando físico.
