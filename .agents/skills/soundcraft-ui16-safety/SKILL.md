---
name: soundcraft-ui16-safety
description: Use whenever modifying MixAI permissions, Soundcraft Ui16 connection, live mixer operations, lab/real modes, musician control, scenes, AUX1 or audio-related automation.
---

# Soundcraft Ui16 / MixAI — operação segura

## Contexto verificado
- O notebook Lenovo Yoga usa o hotspot da Ui16 (IP confirmado em ensaios: `10.10.1.1`, Windows Wi-Fi ifIndex 8 **naquela sessão**, não constante permanente). Internet por tether USB separado, se necessário.
- A fase F0 em #43 comprovou leitura de faders/MUTE, leitura do envio AUX1 em CH2, perda de Wi-Fi com `LOST` e `route_mismatch` e nova sessão manual `READY`. **Não** comprovou recuperação automática com rota instável nem comandos de escrita REAL.
- `AGENTS.md` e #44 proíbem nova escrita REAL/E6 até gate dedicado e aprovação explícita. **Não configurar `mixer.mode=real` nem `serve:real` para testar esta implementação**.
- Fonte de estado via F0C é fader/MUTE observado. Medidores de `src/server/meters.ts` são **simulados somente LAB/MOCK**. Não há espectro, frequências, SPL, VU ou microfonia medidos pelo aplicativo REAL.
- Fred CH3 voz principal; Lucius CH1 cavaco + CH4 coro; Leandro CH5 coro; Fernando CH6 coro; Laviquinho CH7 coro; CH8 surdo, CH9 pandeiro, CH10 tantã, CH2 violão; CH11 reserva; CH12 livre.
- AUX1 é o **mix compartilhado** do HA800; modificar envio de um canal nesse AUX afeta todo mundo.

## Procedimento obrigatório para tarefas de código
1. Ler `AGENTS.md`, issue e `main` atual. Criar branch exclusiva, sem tocar na `main` diretamente.
2. Manter LAB/MOCK/REAL separados no código e no texto da UI. Proibir qualquer sugestão de que telas LAB comandam a Ui16 física.
3. Restringir alterações de músicos no **backend**, por identidade/vínculo de sessão explicitamente aprovado; nunca confiar só no frontend ou no PIN compartilhado.
4. Qualquer ajuste associado à IA requer interpretação separada da autorização, limites, revisão e rastreabilidade; **texto de modelo não é uma permissão**. Falhas de rede ou de sincronização não devem disparar retry/replay de escrita.
5. Cenas, master, gain, phantom, EQ/HPF, AFS2, alteração em lote, mudanças importantes e ações de diagnóstico exigem plano de segurança separado. Nenhuma promoção automática de preset LAB a REAL.
6. Testar concorrência, stale state, sessão revogada, rede caída, tentativa de alterar canal não vinculado e vazamento de segredo. Registrar apenas resultados sanitizados, sem PIN, IP privado, SSID, token ou logs brutos.
7. PR separado, CI Windows/Ubuntu/Caddy quando aplicável, testes de unidade/UI/E2E e relatório conforme `AGENTS.md`. **Só o responsável faz merge.**

## Critérios de parada
Pare e peça decisão de operador se aparecer escrita REAL, bypass de modo/gate, autorização indevida de canais, tentativa de medir áudio inexistente, necessidade de modificar rede/firmware da Soundcraft ou falta de evidência para aplicação automática.

## Fontes
- Evidência F0: https://github.com/dodoxbr/MixAI/issues/43
- Gates E6: https://github.com/dodoxbr/MixAI/issues/44
- Manual oficial EN v3.0: https://www.soundcraft.com/en-US/product_documents/ui_usermanual_v3-0-pdf-27c992b4-5132-4d2d-b8e2-79750de6ee29
- Manual PT v2.8: https://www.soundcraft.com/en/product_documents/ui_manual_v2-8_portuguese-pdf-f4a4a2c5-8071-4005-83d4-aad7ca399fb3
