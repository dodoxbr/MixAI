# Primeira operação física supervisionada — tela e inicialização

Entrega do PR #101, sobre o #100 (`FIRST-REAL-AUX.md`). **Nenhuma Ui16 física foi acessada nesta entrega e
nenhuma validação física foi realizada.** Merge não autoriza uso físico: quem decide é o responsável, em sessão
supervisionada. A escrita REAL continua **desabilitada por padrão**.

## O que existe

| Peça | Onde | Observação |
|---|---|---|
| Tela "Teste supervisionado — primeiro envio AUX (REAL)" | Mesa → painel "Canal selecionado" (selecione um canal; somente operador) | Recolhida por padrão (não ocupa espaço antes dos faders); Angular, sem executor próprio |
| `GET /api/ui16/aux/status` | `src/server/first-real-aux/routes.ts` | **Somente leitura**; só no servidor REAL; operador autenticado; `no-store` |
| Prévia / confirmação | `POST /api/ui16/aux/preview`, `POST /api/ui16/aux/:id/confirm` | **Inalterados (#100)**; a tela só os chama |
| Inicialização supervisionada | `npm run serve:supervised-aux -- --validation-record CAMINHO.json` | CLI fail-closed (`src/supervised-first-write-cli.ts`) |

A tela **não** tem executor, fila, transporte nem acesso do modelo de IA. O botão "Confirmar envio físico" é uma ação humana
que chama o endpoint de confirmação do servidor; toda a autorização (sessão, geração, frescor, vínculo estéreo, cadastro,
limite de 1 dB, rota, lock por parâmetro, `requestId`) continua no servidor e no gate do #100.

## Comportamento da tela

- Mostra **conexão** (`link`), **mesa** (modelo informado), **canal**, **AUX**, **valor observado** (amostra independente
  recente do alvo exato; "Não disponível" se não houver) e o **estado do recurso REAL**:
  `Habilitado (validação: …)`, `Desabilitado (padrão)`, `Habilitado mas bloqueado agora` (conexão/identificação/rota) ou
  `Bloqueado — servidor em LAB/MOCK`. Estado desconhecido (falha de rede) é tratado como **bloqueado**.
- **Sem seleção padrão**: o operador escolhe canal e AUX; só aparecem os **cadastrados** (o servidor revalida).
- Passos fixos de **+0,5 dB** ou **−0,5 dB** (o servidor ainda limita a `min(1 dB, limite existente)`).
- **Prévia**: mostra valor anterior, valor solicitado, valor observado agora e validade (15 s). **Cancelar** descarta a
  prévia local; o servidor não tem endpoint de cancelamento — a prévia dele expira sozinha e nada é enviado.
- **Confirmação** explícita (um clique), com `requestId` novo, **sem reenvio automático**. Resultado:
  - `observed_target` — amostra independente no valor pedido. **Não é ACK causal** e não prova melhora de áudio.
  - `unconfirmed` — não confirmado; conferir na mesa. Sem retry, rollback ou undo automáticos.
  - `not_sent` — nada foi enviado (inclui sessão expirada, prévia expirada, recusa do servidor).
  - `indeterminado` — sem resposta (timeout/conexão perdida) na confirmação; conferir na mesa antes de qualquer nova operação.
- Troca de sessão, de instância do servidor, perda de conexão ou logout **descartam** prévia, resultado e respostas tardias.
- Em **LAB/MOCK** as rotas REAL nem existem: a tela fica bloqueada e não chama nada. O fluxo **simulado** (socket falso,
  `validation: 'simulated_transport'`) roda **somente nos testes automatizados** (`test/e2e/supervised-aux.test.ts`).

## Procedimento de inicialização supervisionada

Pré-requisitos (responsável humano presente): checklist F0 (`PHYSICAL-CHECKLIST.md`) e o roteiro de
`FIRST-REAL-AUX.md` concluídos — áudio/saídas desconectados, backup manual, modelo/firmware e ausência de vínculo estéreo
conferidos na interface oficial, e confirmação de que a mesa publica nova amostra depois de um `SETD`.

1. **Preencher o registro de validação** (JSON, fora do Git; sem PINs, tokens, chaves ou dados de terceiros):

   ```json
   {
     "schemaVersion": 1,
     "reference": "ui16-aux-AAAA-MM-DD-r1",
     "validatedBy": "Nome do responsável",
     "validatedAt": "2026-11-12T11:00:00.000Z",
     "device": { "model": "ui16", "ip": "IP.DA.MESA.NA.CONFIG", "firmware": "versão informada pela interface oficial" },
     "route": { "transport": "ethernet", "interfaceIndex": 7 },
     "checklist": {
       "f0ChecklistCompleted": true,
       "supervisorPresent": true,
       "audioOutputsDisconnected": true,
       "manualBackupDone": true,
       "stereoLinkAbsentOnChannelAndAux": true,
       "setdPublishesNewSampleConfirmed": true
     }
   }
   ```

   O registro é uma **atestação administrativa**: não verifica firmware nem protocolo. Valores `true` são declarações do
   responsável; qualquer campo extra ou item `false`/ausente é recusado.
2. Conferir a rota: `npm run preflight:f0 -- --ip IP --transport ethernet --interface-index INDICE`.
3. Iniciar: `npm run build` e `npm run serve:supervised-aux -- --validation-record CAMINHO.json`.
   A CLI exige `mixer.mode: real` e `model: ui16`; recusa e **não sobe o servidor** se: registro ausente/ilegível/grande
   demais, campos inválidos, registro com mais de **24 h** ou data futura, IP diferente do configurado (ou público) ou
   rota Windows reprovada **agora**. Ao aceitar, grava uma linha sanitizada em `data/ui16-supervised-validation.log`
   (referência, responsável, data, firmware, IP, transporte, índice — sem segredos).
4. A rota é **revalidada** pelo gate do #100 a cada autorização e envio (consulta nativa com cache de **1 s**, para não
   disparar o PowerShell em cada leitura de estado; rota que cai ou consulta que falha fecha a escrita).
5. Abrir a tela, conferir os valores no cartão de prévia e confirmar **uma vez**. Conferir o fader na interface oficial.
   Encerrar o servidor (Ctrl+C) para desabilitar o gate; não há persistência do gate.

**Não existe** flag CLI, variável de ambiente, chave YAML ou endpoint que habilite a escrita sem esse registro e sem a rota
verificada. `npm run serve:real` continua sendo somente leitura.

## Limites e pendências

- Nenhuma validação física, firmware, topologia ou comportamento real de `SETD`/nova amostra foi comprovado.
- A verificação de rota depende de consultas nativas do Windows (`queryWindowsObserverRoute`); o cache de 1 s é uma
  janela residual entre verificação e envio.
- Não há cancelamento no servidor; a prévia expira em 15 s.
- O desfazer continua exigindo **nova prévia** (`undo`) pela API do #100; esta tela **não** o oferece.
- AUX1/HA800 é compartilhado: um ajuste afeta todos que o usam.
