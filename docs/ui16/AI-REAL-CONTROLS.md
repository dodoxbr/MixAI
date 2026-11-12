# Assistente de IA integrado aos controles REAL da Ui16

Entrega do PR #104, sobre #100 (AUX), #101 (tela/CLI supervisionada), #102 (PA/mute) e #103 (EQ/HPF). **Nenhuma Ui16 física foi acessada e nenhuma validação física foi realizada.** Todos os testes usam LAB ou a biblioteca verdadeira com WebSocket falso. A escrita REAL continua **desabilitada por padrão**: cada categoria precisa do gate confiável do bootstrap (ver `REAL-LEVEL-MUTE.md`, `REAL-PROCESSING.md`, `SUPERVISED-FIRST-WRITE.md`). Esta entrega não cria gate, flag, variável de ambiente nem endpoint que habilite escrita.

## Fluxo

```
operador digita → parser local → intenção tipada → PRÉVIA (cartão) → confirmação humana → executor único → observação
```

1. **Interpretação**: o parser local (mesmo do #98/#102) identifica canal e destino pelo cadastro. Sem destino/canal/valor inequívoco, o assistente **pergunta**; nunca escolhe. O texto do modelo nunca vira comando bruto: só intenções tipadas (`level`, `mute`, `processing`, `undo`).
2. **Prévia**: `src/server/real-assistant.ts` entrega a intenção ao serviço dono da categoria — controles (`FirstRealAuxService.previewIntent`, #100/#102) para volume/mute PA e AUX; processamento (`Ui16ProcessingService.previewIntent`, #103) para EQ/HPF/bypass. Cada serviço revalida modo, `serverId`, sessão de operador, cadastro, gate da categoria, leitura independente recente, limites e vínculo estéreo. Sem leitura, sem gate ou fora do limite: **não há cartão** e a resposta diz “Recurso REAL bloqueado…” e “nada foi enviado”.
3. **Cartão**: canal, destino (PA, AUX n ou *canal de entrada*), parâmetro, valor anterior, valor proposto, valor observado agora e validade (15 s). A prévia não escreve.
4. **Confirmação**: botão **Confirmar ajuste**, ação humana, chama `POST /api/ui16/controls/:id/confirm` ou `/api/ui16/processing/:id/confirm` (corpo estrito, `humanConfirmed:true`, `requestId` novo por clique). O botão *Aplicar* legado (`proposal_apply`) continua **incapaz de escrever REAL**.
5. **Execução**: `ServerCore.execute → MixController → Ui16RealBridge` — o executor, a fila, a auditoria, as revisões e a pilha de desfazer existentes. Nenhum executor novo; o núcleo D não foi alterado.
6. **Resultado**: `observed_target` (amostra independente no valor pedido; **não é ACK causal**), `unconfirmed` (enviado/sem confirmação — resultado incerto), `not_sent`, ou indeterminado (timeout/conexão). Sem retry, rollback ou desfazer automáticos.

## Comandos cobertos

| Pedido (exemplos) | Categoria / chave | Observações |
|---|---|---|
| “Aumenta 1 dB do cavaco no AUX 5” | `aux_level` `ch.N.aux.A.level` | AUX registrado; até min(1 dB, limite do controlador) |
| “Sobe 0,5 dB do violão no PA” | `pa_level` `ch.N.main.level` | Um canal por operação |
| “Muta / desmuta o violão no PA / nos fones / no AUX 5” | `pa_mute` / `aux_mute` | Um canal; lote recusado |
| “Aumenta 1 dB do ganho da banda 2 do violão”, “… para 1,5 dB” | `ch.N.eq.bB.gain` | −6…+6 dB, passo ≤ 1 dB; relativo calculado sobre a amostra independente |
| “Muda a frequência da banda 3 do violão para 1,2 kHz” | `ch.N.eq.bB.freq` | 20–20000 Hz, razão ≤ 2 |
| “Ajusta o Q da banda 2 do violão para 1,5” | `ch.N.eq.bB.q` | 0,1–10, razão ≤ 2 |
| “Coloca o HPF do violão em 100 Hz”, “Desliga o HPF…” | `ch.N.eq.hpf.freq` | 20–300 Hz; desligar = 20 Hz explícito (sem setter de bypass do HPF); “liga o HPF” sem frequência → pergunta |
| “Ativa / desativa o bypass do EQ do violão”, “Desliga o EQ…” | `ch.N.eq.bypass` | Booleano explícito |
| “Quanto está o master?” | — | Somente consulta; “sobe/abaixa/muta o master” é recusado sem cartão |
| “Desfaz o último ajuste” | `undo` | Roteado ao serviço dono do topo da pilha; **nova prévia e nova confirmação** |

**EQ e HPF são processamento do canal de entrada**, não ajuste por destino. Um pedido de EQ/HPF com “no PA/AUX/fones” não vira cartão: o assistente explica e oferece aplicar no canal inteiro. O cartão mostra “Canal de entrada (sem destino PA/AUX)”. O efeito nos retornos depende do roteamento não verificado; AUX1/HA800 é compartilhado.

Comandos explícitos de EQ/HPF têm prioridade sobre o módulo de conversa técnica (que não aplica ajustes); “o EQ está estridente” continua sendo consulta.

## Interface (Angular existente)

- Cabeçalho do assistente: **LAB · simulado** ou **REAL · envio só após confirmar**.
- Cartão REAL: etiqueta “REAL · categoria”, anterior / proposto / **observado agora**, **Cancelar** (descarta a prévia no servidor via `POST /api/ui16/controls/:id/cancel` ou `/api/ui16/processing/:id/cancel`; nunca toca a mesa) e **Confirmar ajuste**.
- Estados distintos: *simulado* (LAB), *enviado* (sem retorno detalhado), *observação recebida da mesa*, *enviado, mas NÃO confirmado* e *indeterminado*.
- **Desfazer (pede nova confirmação)** aparece só depois de `observed_target`; envia “Desfaz o último ajuste” ao assistente, que cria um novo cartão de desfazer. A UI não desfaz nada sozinha.
- Recurso bloqueado: resposta com o selo “Recurso REAL bloqueado”, sem cartão.
- Troca de sessão/instância, 401 ou perda de conexão descartam respostas tardias ou marcam o resultado como incerto; nada é reenviado automaticamente.
- A interface nunca recebe comandos de rede, frames SETD, caminhos internos além dos endpoints de confirmação/cancelamento, nem configurações do gate.

## Mudanças de backend (aditivas)

- `src/assistant/mixer-operator/processing-parser.ts`: parser de EQ/HPF → `Intent {type:'processing'}`; apenas intenção.
- `src/server/real-assistant.ts`: único ponto em que o assistente alcança os serviços REAL; só prévias.
- `Ui16ProcessingService.previewIntent` (+ `processingFor(core)` compartilhado com as rotas): converte a prévia do #103 em cartão; calcula o alvo relativo de ganho a partir da amostra independente.
- `FirstRealAuxService.cancel` + `POST /api/ui16/controls/:id/cancel`: descarta prévia não consumida (sem toque no transporte).
- `ProposalCard`: `destination` ganhou `CANAL`; `realControl` ganhou `cancelPath`, `observed`, `validation`, `unit`.
- Sem alteração de autenticação, PINs, permissões, rede, persistência, executor, fila, handshake, gates ou núcleo D.

## Limites e pendências

- Nenhuma validação física, de firmware, de topologia ou acústica. Fixtures e a biblioteca verdadeira com socket falso não comprovam que a mesa publique cada campo nem o comportamento de `SETD`.
- `observed_target` não é ACK causal; uma mensagem antiga em trânsito na mesma conexão é indistinguível de uma atual se coincidir com o alvo.
- Gate a gate: o assistente só funciona nas categorias que o integrador confiável habilitou; nenhuma é habilitada por esta entrega. O CLI supervisionado do #101 continua habilitando apenas `aux_level`.
- O interpretador por IA externa continua restrito ao LAB (#98); no REAL vale apenas o parser local.
- Desfazer exige que o topo da pilha seja um único parâmetro elegível e que a leitura ainda corresponda.
- Velocidade da fala/ruído e reconhecimento de voz não fazem parte desta entrega.

## Verificação automatizada

`test/ai-real-mixer-controls.test.ts` (parser, conversa → prévia → HTTP, categorias, cancelamento, desfazer, gate fechado, ausência de leitura, limites, master, timeout/perda, rota, sessão, músico), `web/src/app/assistant/real-controls.spec.ts` (cartões, estados, cancelamento, 401, timeout, troca de sessão, instância, desfazer, LAB) e `test/e2e/ai-real-mixer.test.ts` (navegador, servidor REAL composto à mão com socket falso). Nenhum teste abre socket da Ui16.
