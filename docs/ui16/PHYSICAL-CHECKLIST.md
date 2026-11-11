# Checklist supervisionado — Ui16 real

**Não executar automaticamente. Não habilita E6.** Esta entrega não comprovou escrita
física. Usar operador presente e observar primeiro, com saídas de áudio desconectadas e
sem alterar rede/firmware. Não executar `serve:real` como teste automatizado.

## Preparação e somente leitura

- [ ] Registrar modelo/firmware pela interface oficial, sem divulgar IP/SSID/credenciais.
- [ ] Conferir segurança física, backup/snapshot por ação humana na interface oficial e
      condição de áudio desconectado; não carregar/salvar snapshot pela ponte.
- [ ] Usar o preflight/observador F0 existente com gates de rota/Wi-Fi. Uma rota válida
      antes de iniciar não garante validade após mudança: conferir em cada reconexão.
- [ ] Capturar apenas campos necessários e sanitizados no transporte de diagnóstico;
      não versionar dump integral. Confirmar anúncio `model`/`firmware` antes de ampliar parser.
- [ ] Comparar faders/mute de entrada e envio/mute AUX na interface oficial; escolher
      canal seguro explicitamente. AUX1/HA800 é compartilhado, não mix pessoal.
- [ ] Alterar pela interface oficial um campo por vez; confirmar recebimento e geração
      na ponte. Conferir EQ bandas, bypass e HPF frequência sem assumir suporte físico.
      HPF slope continua indisponível para Ui16.
- [ ] Com dois dispositivos oficiais, intercalar alterações do mesmo envio e de canais
      distintos; conferir revisões e ausência de escrita emitida pela ponte.
- [ ] Perder/restaurar conexão supervisionadamente; conferir LOST, stale e nova geração.
      Validar recuperação automática na topologia real: F0 anterior só comprovou nova
      sessão manual. Não aceitar cache antigo como atual.
- [ ] Conferir silêncio, ausência de captura, campos pendentes e ressincronização manual.
      Não interpretar ausência de amostra como zero, mudo ou áudio medido.
- [ ] Encerrar sessão: sockets e timers encerrados, sem reconexão posterior.

## Gate de escrita — pendente, não executável nesta versão

- [ ] Obter autorização dedicada do responsável e análise de risco antes de implementar
      qualquer desbloqueio. A ponte atual sempre recusa escrita, inclusive AUX.
- [ ] Com áudio desconectado, validar manualmente a mensagem exata do único envio AUX,
      tolerância numérica e recebimento **independente de entrada**, sem contar echo local.
- [ ] Validar autorização por sessão/permissão, alvo específico, passo máximo, teto,
      idempotência e expiração dentro da fila existente; nada vindo da IA autoriza a ação.
- [ ] Conferir rejeição de master/EQ/mute/outros parâmetros e efeito de stereo-link.
- [ ] Testar divergência, atraso, perda após envio e alteração externa concorrente:
      resultado incerto, sem retry e sem rollback automático.
- [ ] Testar undo humano com revisão atual, mesma limitação de passo e nova confirmação
      observável; alteração externa posterior deve bloquear desfazer.
- [ ] Registrar evidências sanitizadas e parecer técnico em PR futuro. Só depois planejar
      uso com áudio conectado. Testes simulados desta entrega não satisfazem este gate.
