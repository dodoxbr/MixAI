# Atendimento guiado — #57

Base `dad558a`: #52 já entregou referências E5 e fila; #54 integrou relatos de músico
não verificados ao diagnóstico offline. Esta entrega reutiliza os dois, sem editar
motor técnico, autenticação, chat ou configuração REAL.

No painel **Solicitar ao operador**, abra **Atendimento guiado**. Informe o relato,
sintoma, canal e destino; registre verificações humanas se houver. Confirme canal/destino,
consulte, leia a orientação e marque a revisão antes de enviar. A consulta isolada não
entra na bandeja. AUX1 é compartilhado por todos no HA800. Informações negativas ou
incompletas podem pedir mais contexto; não são medições nem autorizações de ajuste.

O operador abre o contexto na bandeja: relato/sintoma, verificações declaradas, diagnóstico
teórico e revisão/valores de fader/mute observados **no LAB** ficam distintos. Sem conexão,
valores são indisponíveis. Pode comparar uma referência do destino, se existir; comparação
é somente leitura e pode mostrar mudanças externas intencionais. Nenhuma restauração.
Pode solicitar esclarecimento, receber complementação no histórico, sugerir/aprovar uma
orientação, recusar, cancelar ou encerrar o atendimento com resposta. `closed` é terminal;
`approved` não significa ajuste executado. O músico acompanha seu pedido e devolutivas.
O rollback registrado é informativo; não há comando de rollback.

## Contratos para #55 (C) / #56 (B)

`src/reference/guided.ts` exporta input/preview/contexto v1. Não depende de chat/motor.
B pode usar o mesmo fluxo HTTP autenticado, sem copiar telas nem criar outra fila:

1. POST `/api/mix-requests/preview`: `serverId`, `report`, `sourceChannel`, `destination`
   (`PA`/`AUX1`), `symptom`, `checksPerformed:string[]`, `targetConfirmed:true`;
   `referenceId` opcional. Campos extras (identidade/evidência/comando) são rejeitados.
2. Resposta: `id`, `expiresAt`, `report`, `context`. Mostrar para revisão humana.
3. POST `/api/mix-requests`: `serverId`, `requestId` estável (usar o UUID da consulta),
   `guidedId:id`, `reviewed:true`, `type:diagnostico`, `report`, `channel:sourceChannel`,
   `destination`. O backend usa **seu** contexto, nunca uma cópia enviada pelo cliente.
4. Acompanhar pelas rotas existentes de workspace/detail/reply/cancel/decide. Decisões
   usam versão esperada. O preview não é uma proposta e não tem ação executável.

C fornece orientação através de `ReferenceRecommendationPort` existente, injetada no
startup confiável. O campo opcional tipado `guidanceContext` fornece sessão, sintoma e
verificações declaradas para o adaptador C consumir o resultado de sua conversa sem
aceitar diagnósticos arbitrários do navegador. O adaptador atual offline funciona sem #55. Feature detection: workspace
`requestCapabilities.guidedPreviewVersion === 1` e `integrations.recommendations`; falta do adaptador retorna 503. Não se importam componentes
ou estado de conversa do C/B. Para incorporar esclarecimentos, C/B podem preparar nova
consulta com relato e verificações confirmados pelo humano, nunca alegando medições.

## Segurança, persistência e limites

Somente LAB; autenticação/proxy existentes e duas senhas preservados. Canal informado não
confere titularidade: músico vinculado só prepara consulta para seu conjunto ativo de
canais. Sem vínculo, o pedido fica `needs_information`, identidade não verificada e sem
permissões de ajuste. Revogação/troca de vínculo durante a consulta ou antes do envio
invalida o preview. Mudança da revisão de estado exige nova consulta/revisão humana.
Agente MCP não usa essas rotas. Nenhuma nova chamada de escrita/proposta/execução.

Consultas ficam na memória, ligadas à sessão, até dez minutos, máximo 100 por servidor;
reinício descarta rascunhos. Pedidos enviados persistem atomicamente no armazenamento
existente, esquema 1 com campos opcionais aditivos; históricos e backups são preservados.
Um preview produz um pedido; nonce estável permite repetir a resposta sem duplicação.
Pedidos guiados são privados da sessão de origem (e operador), inclusive após reinício
ou vínculo do mesmo músico em outra sessão. Sessões não são recriadas por persistência.
O operador mantém o histórico após reinício, e consultas novas usam o novo `serverId`.

Referência opcional deve existir e corresponder ao canal/destino; ID inválido é recusado,
ausência não bloqueia atendimento. O operador pode selecionar referência existente ao
comparar. Os limites anteriores (500 pedidos, 50 entradas por histórico, 16 MiB, TTL de
dez minutos) continuam. Corrupção falha fechada, sem recuperação silenciosa.

Testes usam apenas LAB. Yoga/Android físicos, ergonomia no evento, rede privada,
observabilidade do firmware e escuta acústica exigem validação supervisionada; não há
medição real, E6 nem escrita REAL nesta entrega.
