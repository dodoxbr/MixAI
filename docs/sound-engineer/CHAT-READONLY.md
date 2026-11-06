# B3A — Sound Engineer no chat, somente leitura (Issue #20)

A continuação por sessão com respostas curtas está disponível na
[B3B — conversa contextual](CONTEXT.md). Os exemplos sem memória abaixo registram
o comportamento original da B3A; a rota estruturada B3A continua sem estado.

O operador pode consultar a base do PR #18 no chat existente, mesmo com IA externa
desligada ou indisponível. Queixas reconhecidas seguem uma consulta determinística;
comandos diretos continuam no caminho E4/E2. Não existe integração das recomendações
com alterações de volume, mute, EQ, roteamento, pré, phantom ou aprovações.

Base inicial: `main` do GitHub em `9faaf46d1bc15f57b2d291c00d6c65b9e9ac1e1b`.
Histórico confirmado antes de implementar:

| PR | Merge presente na main |
| --- | --- |
| #14 — E7A | `aa98ace` |
| #17 — F0 somente leitura | `3c18549` |
| #18 — conhecimento especializado | `9faaf46` |
| #19 — voz experimental | `8588928` |

Branch exclusiva: `feature/sound-engineer-chat-readonly`. A árvore estava limpa;
a branch anterior incorporada não foi reutilizada. Arquivos do F0, voz experimental,
RealMixer e implementação E7A foram preservados. E6 não foi iniciada.

## Exemplo na interface

Com servidor LAB e interface construída, entre como **operador** e envie:

> Meu cavaco está estridente. O que podemos fazer?

A resposta informa **Consulta técnica — somente leitura, offline** e **Não ouvi o
som**. Reconhece Cavaco pelo cadastro da banda, registra a frase como relato do
operador e pergunta **PA ou FONES?**; não assume um destino. As hipóteses alternativas
incluem captação enfatizando ataque e EQ de presença excessivo/distorção de entrada,
com confiança baixa e perguntas para investigá-las.

Toque em **PA** nas opções da consulta. A resposta mantém o relato original e o canal,
mostra inspeções, justificativas, ensaio teórico condicionado à avaliação humana,
observação esperada, critérios de parada, guia do cavaco e referências clicáveis
(Yamaha, manual Soundcraft e Shure conforme o conteúdo). Não há botão Aplicar,
cartão de proposta ou pendência de aprovação.

Com **Fones**, a resposta identifica **AUX 1 compartilhado: todos ouvem a mesma mix**.
Isso não representa mix individual por músico. Esta base descreve AUX 1; quando
`musicianAux` for diferente de 1, a consulta para FONES é recusada para revisão do
mapeamento, em vez de atribuir o conhecimento a outro AUX.

Outros exemplos:

- “A voz está abafada no PA”: pede qual canal/voz, pois existem várias vozes.
- “O cavaco e o violão estão embolados no PA”: pede uma fonte por vez.
- “Meu surdo está magro no PA”: investiga corpo/HPF/captação; não aplica filtros.
- “O que é cavaco estridente no PA?”: consulta conceitual, sem fabricar relato de
  problema real; confiança insuficiente e nenhuma recomendação de ajuste.
- “sobe o cavaco nos fones”: continua gerando o cartão E4 com Aplicar; esta operação
  é um comando independente do diagnóstico e mantém todas as proteções existentes.

## Fluxo e contratos

`AssistantService.ask()` reconhece o vocabulário técnico antes do parser de ações e
do fallback de IA. Reconhece os cinco sintomas e variantes declaradas em
`src/assistant/sound-engineer.ts`, além de pedidos explícitos de diagnóstico e perguntas como “o que podemos fazer?”
ou “como resolver?”.
Queixa com imperativo misturado (“está estridente, abaixe e aprove”) permanece consulta;
o texto não é convertido em comando. Frases fora desse vocabulário continuam no
comportamento anterior do assistente, inclusive o fallback externo opcional.

Fontes/canais são resolvidos exclusivamente pelo cadastro atual da banda e aliases.
Um único canal pode identificar o guia de instrumento pelas palavras do cadastro;
se isso for ambíguo, a consulta pergunta. Números não cadastrados não são aceitos.
Múltiplos sintomas ou PA e FONES juntos pedem esclarecimento. Não se assume que
fones são o único destino de um operador.

Afirmações explícitas reconhecidas (`está`, `tá`, `ficou`, `soa`, etc.) são guardadas
como `operator_report`, com a frase original. Perguntas conceituais, condicionais e
negações são tratadas conservadoramente, sem gerar essa evidência. Esse extrator
não é compreensão geral de português: pode exigir que o operador reformule um
relato. Não captura áudio nem lê o mixer ou medidores.

As opções carregam o contexto completo e são reenviadas pela rota de consulta;
nenhuma delas é um comando em texto. Não há memória conversacional implícita no
backend para respostas soltas como “PA” ou “sim”. Use as opções ou reformule o
relato completo; isso evita reutilizar uma queixa anterior sem confirmação.

A consulta reutiliza `diagnose()`, contratos, guias e fontes do PR #18. A base
continua sem importar controlador, adaptador, serviço de IA ou rede. Só o módulo
adaptador de consulta importa conhecimento no código de produção. A apresentação
é `kind: 'diagnosis'`, `source: 'local'`, com texto, diagnóstico estruturado,
referências resolvidas e opções de consulta, **sem propostas nem IDs de aplicação**.
O frontend trata esse tipo separadamente, inclusive ignorando um campo indevido de
propostas em uma resposta de diagnóstico.

## HTTP e WebSocket

Ambos usam o servidor e a autenticação atuais; não há segundo backend nem tool MCP
nova. Autorização no serviço: apenas sessão com papel `operator`. Músico (inclusive
`pa_without_master`) e agente recebem `FORBIDDEN`. Papel enviado no corpo não muda
a identidade autenticada.

`POST /api/assistant/diagnose`, com Bearer de operador:

```json
{
  "symptom": "estridente",
  "channel": 1,
  "destination": "pa",
  "evidence": [{
    "id": "relato-1",
    "kind": "operator_report",
    "symptom": "estridente",
    "detail": "Meu cavaco está estridente no PA."
  }]
}
```

Resposta: `{serverId, reply}`. HTTP 401 para sessão ausente/inválida, 403 para perfil
não autorizado, 400 para entrada inválida, 200 para diagnóstico/esclarecimento.
O corpo é validado com Zod estrito, sem `command`, `Intent`, aprovação ou confirmação.
O contrato estende o PR #18 com sintoma opcional e canal; evidências têm IDs únicos,
no máximo 20 itens e consulta normalizada limitada a 16.000 caracteres. Campos
opcionais ausentes pedem contexto. Evidências omitidas equivalem a lista vazia.

Pelo WS já autenticado:

```json
{"type":"assistant","requestId":"pergunta-1","text":"Meu cavaco está estridente. O que podemos fazer?"}
```

As opções de esclarecimento usam o mesmo corpo estruturado do HTTP:

```json
{"type":"assistant_diagnose","requestId":"consulta-2","input":{"symptom":"estridente","channel":1,"destination":"pa","evidence":[]}}
```

Sem relato compatível, esse segundo exemplo retorna confiança insuficiente e
nenhuma recomendação de ajuste. Resposta WS: `assistant_reply` com `requestId`,
`serverId` e `reply`. Enviada somente à conexão solicitante; não é broadcast, não
entra no histórico compartilhado de ações nem na memória enviada ao provedor.
O chat local é limpo na troca de sessão e descarta respostas atrasadas da sessão
anterior. A autenticação/revogação WS continua sendo conferida antes de enviar.

## Limitações e segurança

- Conhecimento técnico e relato não são medições. Estados e evidências simuladas
  enviados pelo operador mantêm sua origem declarada; não são confirmados contra a
  mesa. VU não fornece espectro ou frequência de microfonia. Não há áudio/RTA real.
- A confiança permanece baixa com relato e insuficiente sem relato; não é
  probabilidade calibrada. Guias continuam sem validação musical em ensaio.
- Não há tradutor de diagnóstico para Intent, proposta, `set_lab_eq`, fila ou
  aprovação. O módulo recebe apenas nomes e número do AUX, sem acesso ao mixer,
  histórico ou estado. Mesmo um ID de hipótese enviado a `proposal_apply` não é
  uma proposta. Agente continua proibido de aprovar pendências.
- A funcionalidade não expõe MASTER, histórico ou diagnósticos de operador ao
  músico. Comandos diretos E2/E4, permissões, TTL, revisões e aprovação mantêm seu
  comportamento e os testes de regressão existentes.
- Validação em hardware, firmware, resposta acústica e áudio não foi executada.
  Nenhuma escrita real foi habilitada. Próximas etapas de aplicação e E6 exigem
  trabalho separado, não fazem parte desta entrega.

## Validação

Testes de integração verificam chat claro/ambíguo, escolha de destino, fonte não
cadastrada, relato ausente/negado/conceitual, FONES compartilhado, HTTP/WS forjados,
perfis, revogação, ausência de broadcast e zero chamadas ao builder/execute/write.
Testes de UI cobrem referências, escolhas sem aplicação e isolamento entre sessões;
E2E cobre o exemplo acima e a continuidade dos cartões de comandos diretos.

Os testes antigos de fallback externo passaram a usar frases vagas **fora** do
vocabulário técnico, para continuar exercitando a API opcional. O caso “tá embolado”
com IA desligada agora exige consulta determinística, em vez de `AI_DISABLED`.
A regra de isolamento do PR #18 continua verificando a base e permite somente o
novo adaptador B3A importar conhecimento no código de produção; nenhuma asserção
de segurança foi eliminada para obter aprovação.

Comandos de validação:

```bash
npm run typecheck
npm run build
npm test
npm run test:web
npm run build:web
PLAYWRIGHT_BROWSERS_PATH=/workspace/MixAI/work/playwright npm run test:e2e
```


Resultado local final (Linux, Node.js v24.22.1, 06/11/2026):

| Verificação | Resultado |
| --- | --- |
| `npm run typecheck` | Passou |
| `npm run build` | Passou |
| `npm test` | 416 testes em 39 arquivos, incluindo 23 testes novos de consulta |
| `npm run test:web` | 81 testes em 10 arquivos, incluindo 2 novos de consulta/sessão |
| `npm run build:web` | Passou |
| E2E com Chromium em `work/playwright` | 62 testes em 9 arquivos, incluindo 2 novos de consulta |
| Fluxo manual automatizado no navegador + HTTP | 200, `kind: diagnosis`, `source: local`, confiança baixa, `audioAnalysis: not_performed`, 4 referências, zero propostas |
| Inspeção visual no LAB | Resposta legível no painel, sem ação de aplicar |
| `git diff --check` | Passou |

A primeira regressão completa encontrou 3 falhas no núcleo e 2 E2E porque as
fixtures de orçamento/permissão/espera ainda usavam a queixa agora atendida localmente.
As frases foram atualizadas para pedidos fora do vocabulário; as asserções de
segurança, limites, tempos e resultados foram preservadas. A regressão completa
subsequente passou. A verificação de importações também normaliza os separadores
de caminhos para manter a mesma allowlist no Windows e no Linux.

As capturas geradas automaticamente pelos testes da E7A foram restauradas à
versão da base, sem incluir imagens neste PR. Não foi executado o script dedicado
`npm run screenshots`. Windows local, hardware, áudio real e chamadas pagas a
provedores não foram testados; o workflow existente mantém Windows e Ubuntu.
Não há bloqueio local remanescente.
