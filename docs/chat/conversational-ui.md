# Chat progressivo — Issue #56

A interface reaproveita `AssistantUiService`, `AssistantPanelComponent`, o campo de entrada e os transportes existentes. Não altera motor técnico, conhecimento, autenticação, vínculos, permissões, persistência de pedidos ou rotas de execução. Nenhum novo comando ou escrita REAL. Consultas não produzem botões Aplicar; os cartões de comandos existentes continuam no fluxo separado, com aprovação/limites do servidor.

## Experiência

- Histórico temporário de até 40 mensagens por sessão, limpo na troca de sessão. Não é armazenamento persistente nem histórico entre dispositivos.
- Resumo curto por resposta: relato, hipótese não confirmada, recomendação para revisão e medição indisponível, com rótulos e cores distintos. Excertos vêm do payload do servidor; não há conclusão produzida pelo frontend.
- Somente uma pergunta ativa visível. A pergunta não se repete no banner de contexto; mensagens anteriores ficam no histórico, com respostas antigas desabilitadas.
- Chips nativos de pelo menos 48 px; “Voz Fred” pode ser exibido como “Fred”, mas o transporte envia exatamente o rótulo original com id/revisão de contexto. Escolher pessoa na consulta não cria identidade nem autoriza canais.
- Canal/destino aparecem na mensagem. FONES/AUX sempre mantém o aviso de compartilhamento HA800. Não há RTA/VU acústico ou escuta de áudio nesta entrega.
- “Ver detalhes técnicos e fontes” usa accordion nativo, com texto completo e dados estruturados originais, sem perder evidência, alternativas ou limitações. Links aceitam somente HTTP(S). Texto e JSON usam interpolação escapada, sem HTML/Markdown executável.
- “Voltar na conversa” foca a mensagem anterior para revisão; não restaura contexto expirado, não repete requests nem desfaz alterações. Texto livre continua no campo existente.
- Processamento usa `aria-busy` e status; desconexão mantém o campo e bloqueia envio; resposta perdida/timeout avisa sem retry. Sessão encerrada/reinício conserva o fluxo existente de retorno ao PIN e limpeza de histórico. Indisponibilidade explícita do assistente bloqueia envio com explicação.

## Adaptador e integração com C (#55)

`web/src/app/assistant/diagnostic-view.ts` é uma função pura de apresentação. O contrato legado continua funcional: `kind: diagnosis`, `text`, `diagnosis.consultation`, `diagnosticContext`, `clarification`, `diagnosticOptions` e `references`. Perguntas e opções existentes mantêm sua rota `assistant_conversation` (com id/revisão) ou `assistant_diagnose` (input legado). Não fabricar “ambos”, “não sei” ou nomes que o servidor não ofereça.

Encaixe aditivo proposto para C, sem exigir seu merge: `AssistantReply.conversation` com `schemaVersion: 1`, `sessionId`, `knownContext`, `pendingQuestion`, `choices`, `nextCheck`, `evidence`, `confidence`, `safety`, `references`. O tipo frontend `ConversationPresentationV1` documenta os campos usados. `knownContext` pode conter `channel`, `sourceLabel` e `destination`; `pendingQuestion` é texto ou `{text}`. `nextCheck` é orientação, nunca comando. Campos adicionais ficam integralmente nos detalhes. Uma versão desconhecida recua ao texto legado, sem inventar interpretação ou executar ações.

A primeira integração consome apresentação de `knownContext`/`pendingQuestion`/`nextCheck`. As escolhas interativas priorizam `diagnosticOptions` do backend. Na ausência delas, `conversation.choices` com `{label,input}` válido usa o mesmo transporte somente leitura, sem endpoint ou ação inventados. Com `diagnosticContext`, envia rótulo canônico e revisão; sem ele, C deve fornecer `input` completo compatível com `assistant_diagnose`. Outros formatos de choice permanecem nos dados técnicos, sem botão. C deve manter o envelope/rotas legadas ou fornecer o mapeamento de transporte/revisão em integração posterior. A UI não supõe que `sessionId` diagnóstico seja token de login ou permissão.

O adaptador mantém aviso fixo de áudio não capturado mesmo se um campo futuro alegar medição. Texto original de uma alegação continua disponível nos dados brutos, identificado como payload, sem ganhar selo de medição verificada. O frontend não calcula frequência, SPL ou certeza acústica.

## Limites atuais e D (#57)

O backend atual ainda decide quais perfis podem consultar e quais perguntas/opções existem. Uma recusa ao músico é exibida sem relaxar autorização. O exemplo completo com comparação “só nos fones / nos dois / não sei” depende do contrato e regras de C; esta entrega não simula respostas para fingir suporte. O chat já funciona com as consultas e comandos autorizados na main atual.

A jornada/persistência de solicitações de D permanece intacta. Nenhum botão de diagnóstico transforma uma orientação em pedido, proposta ou aprovação. Antes de futura integração, D deve continuar usando identidade/vínculo autenticados e autorização no backend.

## Verificação

Testes do adaptador e componentes: legado/futuro/desconhecido, evidência não verificada, pergunta única, accordion, truncamento sem perda do original, XSS/links perigosos, chips com rótulo canônico e revisão, estados/limpeza da sessão e regressão de comandos. E2E com backend LAB real em celular retrato/paisagem e Yoga: fonte vocal, contexto FONES, teclado/foco, detalhes, ausência de escrita e de proposta. Resultados de typecheck, builds, core/web/E2E/smoke/HTTPS ficam no relatório do PR. Touch é emulado; nenhum teste acústico ou físico foi realizado.
