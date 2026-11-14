# Preparação da primeira escrita REAL de PA (CH3, PA/MAIN, nível)

**Este PR NÃO autoriza nem executa SETD real.** Só prepara o caminho e o testa com a biblioteca verdadeira e WebSocket falso (relógio controlado). Nenhum gate é iniciado em desenvolvimento. A primeira escrita física exige, depois do merge, auditoria do caminho, proposta exata e **confirmação humana específica** do responsável, além de saídas de áudio desconectadas confirmadas.

## O que mudou

| Peça | Mudança |
|---|---|
| `npm run serve:supervised-aux -- --validation-record R.json [--category aux_level\|pa_level]` | Novo `--category`. Padrão continua `aux_level`. `pa_level` exige pedido **explícito** e registro v2 (sem herança silenciosa). Habilita **uma** categoria (`realControls.pa_level`), nunca outra. |
| Registro de validação v2 | Acrescenta `category` e `channels` explícitos (ex.: `[3]`). O gate só existe para esses canais; qualquer outro canal, MUTE, AUX, master, EQ etc. fica fora. `setdPublishesNewSampleConfirmed` pode ser `pending` **somente no v2** (protocolo inicial). v1 continua exigindo `true` e só vale para `aux_level`. |
| Evidência de frescor `live_connection` | Separa a **idade da última observação** do campo (informativa) da **validade da evidência na conexão atual** (decide). A janela de 3 s não foi removida nem afrouxada: passou a valer para a **entrada de mensagens** da conexão (e continua valendo para a idade da amostra no modo padrão). |
| Resultados | `not_sent`, `sent_unconfirmed` (renomeado de `unconfirmed`) e `observed_target`. Relatórios trazem `basis` (`sample_age`/`live_connection`) e `setdPublication` (`confirmed`/`pending`/`unspecified`). |
| Escopo do gate por canal | `gate.channels`; fora do escopo `gateFor()` devolve inexistente (nenhuma prévia). |

## Por que a evidência `live_connection` (medições na Ui16, somente leitura, sem comandos)

- A mesa **não republica valor inalterado**: zero republicações de CH3, master e `mgmask` entre 12 s e 40 s após a conexão.
- A mesa **transmite sem parar** na conexão: 877 mensagens em 20 s (`RTA` e `2::`), **maior intervalo entre mensagens: 0,05 s**.
- Logo, a idade da amostra de um campo inalterado não prova nada, mas a **conexão viva e ordenada** prova que qualquer mudança teria chegado. A prova passa a ser a conexão atual, nunca uma amostra histórica.

### Condições para autorizar e para enviar (todas, e revalidadas imediatamente antes do envio)

| Condição | Onde | Teste |
|---|---|---|
| Conexão `READY` (sem quarentena), mesma geração da amostra | `Ui16RealBridge.liveConnection` / `current()` | queda e reconexão; quarentena por silêncio |
| Ausência de silêncio de entrada | entrada nos últimos 3 s (`freshnessMs`) + quarentena do bridge (30 s) | entrada some antes da prévia e **entre a confirmação e o envio** |
| Ausência de dado inválido | sessão selada (`STOPPED`) em amostra inválida | `SETD^i.2.mix^NaN` sela e nada sai |
| Observação não histórica | teto `maxObservationAgeMs` (padrão 5 min; máx. 30 min) | recusa acima do teto mesmo com a conexão viva |
| Vínculo estéreo observado (mono) com a mesma regra | `monophonic()` | `stereoIndex` também precisa de evidência |
| Revisão estável | `ServerCore.execute` com `expect.revisions` | valor muda na mesa depois da prévia: recusa |
| Valor anterior = prévia | amostra independente ±0,05 dB, mesma geração/sequência | idem; nova prévia sobre o valor real |
| Revalidação imediata antes do envio | `authorize()` → `write()` → `allowFrame()` chamam `current()` de novo | rota cai / sessão encerrada: `not_sent` |
| Fora disso | **falha fechada** | gate padrão (`sample_age`) mantém a proteção de 3 s |

Sem prova de segurança, o caminho **fecha**: o gate padrão (`sample_age`) nada muda para as demais categorias.

## Resultados

- `not_sent`: nada saiu (autorização revogada, rota/conexão/evidência perdida antes do frame).
- `sent_unconfirmed`: o frame saiu e **não** houve nova leitura independente do valor pedido (timeout, divergência, queda, revogação, configuração). Sem retry, rollback ou desfazer automáticos; uma confirmação **tardia** depois do prazo não muda o resultado e não vira sucesso. Se o executor falha sem relatório (`INDETERMINATE`), a resposta traz `deliveryKnown: false`.
- `observed_target`: **nova leitura independente** no valor pedido, na mesma geração, antes do prazo. Não é ACK causal (`causalAcknowledgement:false`) nem prova de áudio.
- Envio sem nova leitura independente **nunca** é sucesso.

## Registro v2 (exemplo para o responsável preencher; fora do Git)

```json
{
  "schemaVersion": 2,
  "category": "pa_level",
  "channels": [3],
  "reference": "ui16-pa-AAAA-MM-DD-r1",
  "validatedBy": "Nome do responsável",
  "validatedAt": "2026-11-14T00:00:00.000Z",
  "device": { "model": "ui16", "ip": "IP.DA.MESA", "firmware": "versão da interface oficial" },
  "route": { "transport": "wifi", "interfaceIndex": 19 },
  "checklist": {
    "f0ChecklistCompleted": true,
    "supervisorPresent": true,
    "audioOutputsDisconnected": true,
    "manualBackupDone": true,
    "stereoLinkAbsentOnChannelAndAux": true,
    "setdPublishesNewSampleConfirmed": "pending"
  }
}
```

`pending` **não** declara confirmação do hardware: significa que o primeiro resultado (observed_target ou sent_unconfirmed) **é** a evidência a registrar. Validade do registro: 24 h. A rota Windows é verificada ao iniciar e a cada autorização/envio.

## Procedimento da primeira escrita (depois do merge, supervisionado)

1. Atualizar o ROG; confirmar a main; preflight `npm run preflight:f0`; **PA, amplificadores e fones desconectados (confirmação humana explícita)**; backup manual na interface oficial.
2. Preencher o registro v2 (canais `[3]`, `pa_level`); iniciar `npm run serve:supervised-aux -- --validation-record R.json --category pa_level` (encerra o `serve:real`; só um servidor controla a mesa).
3. Ler CH3/PA na interface oficial (valor atual); pedir **uma** redução de até 1 dB (ex.: `Abaixa 1 dB da Fred no PA` ou a API de prévia). Conferir no cartão: canal, parâmetro, anterior, solicitado, observado e validade (15 s).
4. Confirmação humana específica → **uma** alteração. Em timeout/dúvida: **não repetir**; conferir na interface oficial.
5. Registrar solicitado, observado, status e divergências. Restaurar com **nova** proposta (nova confirmação) e nova verificação física.
6. Encerrar o servidor (Ctrl+C): o gate desaparece (não há persistência). Voltar a `npm run serve:real` (somente leitura).

## Limites e pendências

- Nada foi validado fisicamente: a publicação de nova amostra **após um SETD do MixAI** continua pendente (este é o objetivo do teste).
- `observed_target` não prova áudio nem causalidade; mensagem antiga em trânsito na mesma conexão e igual ao alvo é indistinguível de uma atual.
- A evidência `live_connection` assume o comportamento medido (transmissão contínua, mudanças publicadas na hora); se a mesa deixar de transmitir, o caminho **fecha**.
- Não há botão Angular para `pa_level` no painel supervisionado AUX: a prévia/confirmação de PA usa o cartão do assistente (#104) ou a API `/api/ui16/controls/*`, ambos com confirmação humana.
