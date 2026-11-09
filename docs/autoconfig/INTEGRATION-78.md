# PR #78 — integração consultiva com núcleo D e verificação da interface B

> **Atualização:** a lacuna C → B → D descrita abaixo foi fechada em
> [END-TO-END.md](END-TO-END.md) (branch `feature/autoconfig-end-to-end`). O texto a seguir é o registro histórico do PR #78.

A branch `feature/autoconfig-ai-planner` foi sincronizada com `origin/main` em
`cd66766` (PR #80 integrado). A sincronização é um merge **para a branch de trabalho**;
não é merge do PR #78 na main. Conflitos add/add em `contracts.ts` e `fixtures.ts`
foram resolvidos preservando **integralmente** as versões autoritativas de D.
O planejador C foi movido para `src/autoconfig/planner/`; `src/autoconfig/index.ts`
reexporta sua API anterior. O núcleo `service.ts` e contratos D não foram modificados.

Após o merge do PR #77, a branch foi novamente sincronizada com `origin/main`
`81edc43a0690165031e897d6a9d934bbf7c9080b`, sem conflitos. A interface B foi
incorporada integralmente, sem adaptações locais. O resultado é **integração parcial**:
C ↔ D e B ↔ D funcionam; **C → B → D ainda não existe de ponta a ponta**.

## Verificação após PR #77

| Ligação | Evidência automatizada | Estado |
| --- | --- | --- |
| M1 → C → contrato D | API real autenticada reaproveita contexto M1, pergunta comparação e isolamento quando faltam e retorna inspeção + esqueleto sem número | Funcional no servidor |
| B → D | Navegador cria rascunho com número digitado pelo operador e envia prepare/approve/simulate/review; autorização e recibo vêm do servidor | Funcional na interface |
| B → `/api/autoconfig/suggestions` | Rastreamento das requisições durante o fluxo real da UI não registra chamada; serviço B usa apenas workspace/plan/actions | **Não implementado** |
| Perguntas e inspeções C → B | A UI conserva seu assistente local de quatro etapas; não renderiza `advice.question`, suas escolhas ou a inspeção citada de C | **Não implementado** |
| Esqueleto C → autorização pela UI B | A UI cria outro item com justificativa humana e valor explícito; não importa o esqueleto C | **Não implementado** |

`test/e2e/autoconfig-planner.test.ts` separa explicitamente consultas diretas à API
(mesma sessão do navegador, **não** consumo pela tela) das interações reais de B.
O teste primeiro obtém perguntas e inspeção de C sem número, depois acompanha todas
as requisições da UI até revisão da simulação em D. O zero inicial não permite criar
rascunho; o teste digita 0,5 dB como decisão humana fictícia, sem relação causal com
a inspeção. Confere digest/aprovação, ausência de `/suggestions` na etapa de UI,
nenhuma chamada a `/api/command`, zero escrita/execução e snapshot intacto.
Os E2E preexistentes de B também continuam completos, incluindo autorizações
individuais, revisão, desfazer, persistência e invalidação de sessão/conexão.

### Lacuna para integração futura

O Agente B precisará adicionar o consumo explícito de `AdvisoryRequest` e
`AdvisoryResponse` de `src/autoconfig/suggestion-source.ts`, com os mesmos guardas
de sessão/origem/modo e validação estrita. A expressão de caminhos do adaptador HTTP
atual aceita `suggestions` como segmento de ID, mas **isso não constitui suporte**:
não há chamada, parser da resposta consultiva ou apresentação correspondente.
O adaptador de planos existente espera os contratos de D, não um `PlannerResult`.

Será necessário apresentar uma pergunta de C por vez, enviar somente a escolha e
seu `inputFingerprint`, reaproveitar M1 no servidor e tratar recusas/contexto obsoleto.
As inspeções devem continuar distintas de ajustes. Antes de um eventual rascunho D,
o operador decide se um teste virtual de nível é pertinente e informa o número;
nenhum valor pode ser derivado da inspeção. A criação do plano e todas as ações,
versões, digests, aprovações, revisões e recibos permanecem autoritativos em D.
Até esse consumo e seus testes de navegador existirem, não declarar AutoConfig
integrado de ponta a ponta. Esta atualização preserva os arquivos de produção B e
os contratos/serviço/fixtures D exatamente como na main sincronizada.

## Fluxo funcional do servidor (handoff explícito por API)

1. Operador conversa com M1 normalmente, por HTTP ou WebSocket.
2. O servidor conserva uma projeção somente leitura do último `diagnosticSession`
   daquele principal, inclusive após conclusão do M1, até a expiração original.
3. `POST /api/autoconfig/suggestions` reutiliza a projeção e os procedimentos citados.
4. Um `ConsultativeSuggestionSource` implementa **o exato `AutoConfigSuggestionSource`**
   de D. Retorna dados validados por `AutoConfigProposal` ou uma pergunta/recusa
   consultiva, nunca execução, aprovação, observação fabricada ou scalar inventado.
5. A resposta não cria plano. Só o operador envia o rascunho à API existente de D.
6. Sem número, `prepare` resulta em `needs_info` com pergunta `deltaDB`. O operador
   decide se cabe um teste de nível e fornece o passo pela ação `revise` existente.
7. Seguem preparação, digest, aprovação individual, simulação virtual, verificação,
   revisão e retorno de D, sem mudança de controles do mixer. Nada é aprovado em lote.

**Uma inspeção não fundamenta um ajuste de nível.** O port D v1 só suporta rascunhos
`level_delta`; por isso o adaptador fornece um **esqueleto explicitamente pendente do
operador**, sem `deltaDB`, e mantém a inspeção completa separada em `advice`. O texto
informa que não há recomendação de alterar nível. Esse esqueleto é opcional: o operador
pode ignorá-lo e realizar somente a inspeção. Não existe conversão EQ/HPF/ganho/AFS2
→ dB, nem default de passo. A resposta consultiva rejeita qualquer `deltaDB` preenchido.

Os contratos `Suggestion`, `AutoQuestion`, `AutoConfigProposal`, `AutoPlan`,
`CreateAutoConfig`, `AutoAction`, simulador, digest e recibos continuam os de D.
Não se adicionaram operações, permissões, parâmetros físicos ou rotas de execução.

## Endpoint de conselho (apenas LAB)

Mesmos Bearer de operador, política central de ingresso/proxy, validação de origem,
revogação e `cache-control:no-store` das rotas D. Não é montado em MOCK/REAL. D mantém
suas rotas virtuais preexistentes em LAB/MOCK. Nenhuma credencial/PIN novo.

```json
{"serverId":"ID_RECEBIDO_DO_SERVIDOR","scope":"AUX1"}
```

Aceita também `eventId` existente e resposta a uma pergunta vigente:

```json
{"serverId":"ID_RECEBIDO_DO_SERVIDOR","scope":"AUX1","answer":{"inputFingerprint":"HASH_DA_PERGUNTA","value":"ensemble"}}
```

O fingerprint é referência de contexto, **não** autorização/identidade. O servidor
busca a pergunta da mesma sessão e aplica somente uma escolha permitida. Não aceita
`deltaDB`, `approved`, `diagnosticSession`, observações, consentimento ou campos extras.
O campo legado opcional `report` não substitui os fatos de M1 nem vai para o modelo.
A entrada do port de sugestões continua `{eventId?,scope,report?}`.

A saída de `AdvisoryResponse` é:

```ts
{
  serverId,
  advice: PlannerResult,                  // pergunta, proposta consultiva ou recusa
  proposal: AutoConfigProposal | null,    // esqueleto D, SEM deltaDB
  numericInput: 'operator_required',
  createsDraft: false
}
```

A consulta nunca chama `create`, `revise`, `prepare`, `approve`, `simulate`, `review`,
`undo` ou `save` de D. Depois, o operador usa suas rotas originais e todos os seus
campos autoritativos. O UUID do conselho não é um recibo nem aprovação; o protocolo
antigo `proposal_apply` continua sem reconhecer esses IDs.

## Reuso de M1 e estado efêmero

`AssistantService` ganhou somente um cache de projeções e um getter autenticado,
sem mudança de parsing, ordem de perguntas, diagnósticos, consultas documentais ou
prompts A1/A2/M1. `diagnostic-context.ts` e `sound-engineer.ts` permanecem exatamente
como em main. A projeção não avança nem consome a conversa, não renova seu TTL e não
vira leitura física. HTTP/WS existentes alimentam o mesmo espelho antes de aguardar
RAG, de modo que respostas documentais atrasadas não sobrescrevem contexto mais novo.

O adaptador aproveita canal, instrumento, destino, sintoma, relato compatível,
comparação de caminhos e isolamento já conhecidos; desconhecimento explícito também
é preservado. O objetivo inicial é uma orientação técnica derivada do sintoma/papel
(ex.: corpo, inteligibilidade), não uma alegação de objetivo medido ou autorização.
Captação já respondida por M1 não é perguntada novamente pelo planejador.

Se o M1 ainda não tem um dado necessário, o conselho pergunta **um** campo por vez.
Somente respostas adicionais do conselho ficam no cache consultivo, sem alterar M1.
Fonte/destino contraditórios não são sobrescritos silenciosamente: scope diferente
do destino M1 retorna 409. Mudança de M1 invalida respostas pendentes antigas; piora
registrada em M1 bloqueia novo conselho até nova avaliação do operador. Feedback
ativo/desconhecido continua bloqueado; não se presume contenção pelo fato de M1 ter
avançado. Não há ring-out.

Cada cache é limitado a 128 entradas, por principal, TTL de no máximo 5 minutos;
o de M1 respeita a data de expiração original. Cancelar/reiniciar M1, comando explícito,
logout, expiração e shutdown eliminam/inutilizam contexto anterior. Apenas uma
requisição consultiva fica em andamento por principal. Não existe novo banco nem
conversa privada persistida. Outros operadores não herdam fatos ou respostas.

## Provedores e consentimento existentes

O adaptador reutiliza os clientes Gemini/Ollama. Só chama modelos quando geração
está habilitada na configuração existente. Sem base/modelos habilitados, o conselho
LAB funciona deterministicamente, sem sondar serviços; o opt-in de composição
`allowDeterministicWithoutKnowledge` não pode vir do HTTP.

O provedor selecionado vem de `LocalKnowledge.providers()`. Confirmar Gemini no
endpoint/UI existente de seleção de provedor registra uma permissão **efêmera para
aquela sessão de operador**. Configuração, preferência persistida ou seleção feita
por outro operador não inventam essa permissão. Se não houver permissão, Gemini não
é chamado; usa Ollama local ou proposta determinística. Após reinício/logout é
necessária nova confirmação pelo fluxo de seleção existente para AutoConfig.

Trocar seleção invalida permissões antigas e geração pendente. O callback é executado
somente depois de a seleção/health check existente ter sido aceita. Não há novo botão,
flag de consentimento HTTP de conselho ou acesso a chaves pelo LLM. Qwen3 continua
sendo o modelo Ollama já configurado, sem instalar ou trocar modelos.

Por tentativa e no retorno, o planejador/adaptador conferem atividade, consentimento,
seleção, revisão de M1, revisão/conectividade LAB e versão do evento. Se mudarem, a
resposta atrasada é descartada (401/409), sem esqueleto, rascunho, aprovação, retry ou
simulação. Recusa de segurança/saída inválida do modelo não aciona outra IA.

Somente aliases, enums e títulos públicos citados chegam ao modelo. Nenhum relato
livre, nome de músico, ID de sessão/evento, snapshot, IP, caminho, documento privado,
credencial ou ferramenta de execução é enviado. A observação de áudio/REAL continua
indisponível; o conselho não promove leituras declaradas de M1 a estado validado.

## Auditoria e testes

A consulta registra em `ActionLog` apenas tipo de resultado, provedor, resultado e
ator/role, sem texto livre ou prompt. Auditoria persistente, versões, nonces, digest,
aprovação individual e isolamento virtual das ações D continuam intactos.

Testes de integração exercitam a API real com M1: reaproveitamento sem novas perguntas,
contexto concluído/reset/TTL, sessões isoladas, origem/payload forjado e falta de número.
O fluxo de D exige número explícito do operador e valida preparação/aprovação/simulação/
revisão/undo com histórico. Spies confirmam zero execução/escrita de mixer e estado
intacto. São usados Gemini/Ollama com HTTP falso, inclusive seleção, consentimento
por sessão, quota/fallback e respostas tardias após logout, M1, consentimento e queda.
Nenhuma API externa/modelo real é usado nos testes.

E2E de Yoga/celular passa pelo M1 da interface existente e consulta o conselho por
**fetch direto** no mesmo navegador, sem botões novos. Isso não comprova consumo de
C pela interface B. HTTPS testa acesso, origem, papéis e ausência de
número. Regressões completas e CI Windows/Ubuntu/Caddy/smoke estão descritos no PR
#78 do SHA final. A UI B **ainda não consome** esta nova rota; nenhum arquivo web
foi alterado por C em relação à main com PR #77.
Validação física, avaliação consentida de modelos reais e qualquer escrita REAL/E6
continuam fora desta entrega.
