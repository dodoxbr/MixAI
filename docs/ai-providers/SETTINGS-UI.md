# Configurações → Inteligência Artificial — catálogo v1

PR #94, atualizado com a main `65d089b` que incorpora #93 e #95. O painel Angular
consome o catálogo LAB opt-in real do #95. Não habilita o catálogo por conta própria,
não modifica backend, orçamento, autenticação, núcleo D ou comandos do mixer.

## Escopo visível e separação obrigatória

O cartão **Seleção do catálogo nesta sessão** mostra exclusivamente o objeto
`selection` retornado por `/api/ai/models`. Pode estar vazio. Não usa preferências
locais nem a seleção global de `/api/knowledge/providers` como fallback.

**Selecionar no catálogo não troca o provedor do diagnóstico, RAG, embeddings ou
AutoConfig.** Esses consumidores ainda usam os caminhos legados. O aviso está no
início do diálogo; o seletor da Base de conhecimento foi preservado com os controles
de consentimento/retenção da main #93 e uma indicação explícita de fluxo separado.
Os conflitos do merge em `knowledge-admin.component.ts`, `knowledge.spec.ts` e
`test/e2e/knowledge.test.ts` foram resolvidos preservando essas funcionalidades e
regressões da main, em vez de transplantar as antigas ações legadas para o catálogo.

Não há geração de texto, prompt, parser, comando ou chamada a `/complete` neste
painel. Ele consulta metadados, seleciona e limpa a seleção do catálogo.

## Rotas utilizadas

| Operação do painel | Contrato real v1 | Efeito / limite |
| --- | --- | --- |
| Abrir / Atualizar estado | GET `/api/ai/models` | Não sonda provedores externos. Mostra revisão, seleção, consentimento, habilitações, sugestões, preços, limites e uso do servidor. |
| Validar modelo | POST `/api/ai/models/validate` com `schemaVersion:1, provider, model, confirmExternal` | Pode consultar metadados externos após aceite. Retorna disponibilidade, preço e elegibilidade. Não seleciona, não concede geração e não altera revisão. |
| Selecionar no catálogo | POST `/api/ai/models/selection`, mesmos campos + `expectedRevision` | Backend valida o modelo e concede consentimento somente para sessão/provedor/modelo/revisão. Nada é aplicado otimisticamente. |
| Limpar seleção e revogar catálogo | DELETE `/api/ai/models/selection` com `schemaVersion:1, expectedRevision` | Backend limpa somente a seleção e concessão desta sessão do catálogo. Não revoga o consentimento legado de outro fluxo ou outra sessão. |

A confirmação é por **operação externa**: depois de validar, o checkbox volta a
ficar vazio; selecionar exige novo aceite. Nenhuma concessão é inferida pelo
checkbox, preço, chave presente ou preferência. `consent.required/granted` é lido
do backend e identificado como informação do servidor, não como autorização global.
Fechar/cancelar espera não equivale a revogar. Só uma resposta bem-sucedida do DELETE
confirma limpeza. A limpeza pode interromper a espera de uma seleção pendente:
ela usa a última revisão conhecida para invalidar o trabalho concorrente no servidor.
A limpeza também está disponível quando a leitura não mostra seleção, permitindo
invalidar uma seleção pendente iniciada em outra aba da mesma sessão.
Se o POST já foi efetivado e a revisão mudou, o DELETE retorna `STALE`; o operador
precisa atualizar e limpar a nova revisão explicitamente. Não há retry de mutação.

404 significa catálogo não montado: requer LAB e habilitação administrativa
`modelCatalog.enabled`. MOCK/REAL não ganham aquisição nem configuração de catálogo.
Erros conhecidos v1 preservam seus códigos sanitizados, incluindo `STALE`,
`NOT_CONSENTED`, `MODEL_UNAVAILABLE`, `PRICE_UNKNOWN`, `BUDGET`, `RATE_LIMIT`,
`DISABLED` e `NOT_CONFIGURED`. 401 central pode não conter `schemaVersion` e é tratado
como sessão encerrada. Corpos/mensagens privados do provedor nunca são exibidos.

## Modelos, disponibilidade e valores financeiros

- Todos os cinco provedores são apresentados, com habilitação e presença de
  configuração/chave conforme o backend. **Configurado não é conectado.** Modelo
  selecionado ou validado tem metadados confirmados na operação correspondente;
  isso não garante compatibilidade com geração de texto ou disponibilidade futura.
- Sugestões não são allowlists. O ID pode ser digitado mesmo sem listagem, ou fora
  das sugestões, para qualquer provedor habilitado/configurado. Sintaxe v1: Ollama
  até 128 caracteres e tags/namespaces; externos 2–80 com letras/números, ponto,
  hífen ou underscore. Sem URL, espaços, `..` ou `//`. O backend decide disponibilidade.
- Preço é somente `price.inputPerMTok/outputPerMTok` da sugestão ou da resposta
  `/validate` para o mesmo provedor/ID. São **estimativas configuradas pelo servidor**,
  em USD por milhão, não cotação pública nem faturamento. Não se inventa data de
  cotação: o v1 não a oferece. Para um ID livre sem preço na visão GET, o painel
  indica que é necessário validar metadados; não presume ausência de preço na conta.
- `price:null` confirmado para externo significa custo desconhecido; geração paga
  é bloqueada pelo backend. Elegibilidade de geração é o `generationAllowed`
  informado, sujeito a consentimento, revisão, limites e falhas ao gerar.
- Orçamento diário e rate vêm de `limits`; consumo, reservas e tokens vêm de
  `usage`, com dia **UTC**. O registro é agregado/compartilhado, não exclusivo desta
  sessão ou do catálogo. Estado `blocked/paused` é mostrado. Não há cálculo de saldo,
  preço inventado, zero por ausência de informação ou edição de orçamento na UI.

## Arquitetura e fronteiras

`CatalogProviderSettings` é o único adaptador HTTP do painel. O adaptador legado foi
removido: não tenta `/api/knowledge/providers` nem endpoints hipotéticos quando o
catálogo falta. Usa Bearer da sessão existente, `same-origin`, `cache:no-store`,
`credentials:omit`, `redirect:error` e AbortSignal; nenhuma chave de provedor vai
para o browser. Só campos públicos v1 são consumidos e validados antes da apresentação.

O DTO frontend espelha o wire v1. O import direto, mesmo `type-only`, de
`ModelCatalogView` fazia o compilador Angular seguir `UsageTracker` até `node:fs/path`.
Foi mantido um espelho sem Node em `provider-settings-port.ts`, com teste de
compatibilidade estrutural em ambas as direções e de chaves em
`test/catalog-ui-contract.test.ts`. `ModelValidation` também tem paridade tipada.
Não se ampliaram tipos Node no app nem se importou factory/serviço/chaves no bundle.

O serviço Angular cerca respostas por token, instância do servidor e geração local;
mode/role/conexão invalidam o formulário. Checkbox não é persistido. Requisições têm
aviso lento após 3 s e limite de espera de 35 s (timeout configurável do backend pode
ser maior). Cancelamento/timeout não provam cancelamento remoto; não há replay.
Falhas/estado incerto removem a seleção da tela até uma nova leitura. Limpeza continua
possível enquanto uma seleção espera resposta, usando a revisão conhecida.

Layout, carregamento sob demanda, diálogo nativo, Escape, retorno de foco, alvos de
toque e labels do #94 foram preservados. No celular o acesso é um ícone de 48 px com
nome acessível; a regressão de altura em 320×640 continua coberta pelo teste original.

## Trabalho necessário para unificar os fluxos depois

1. **Definir autoridade por sessão.** Decidir migração do seletor global legado para
   a seleção revisionada do catálogo, incluindo sessões sem seleção e migração sem
   concessão implícita. Não copiar uma seleção global para todos os operadores.
2. **Adaptar consumidores no backend.** Diagnóstico, enriquecimento RAG e planejador
   precisam consumir explicitamente o port `ModelCatalogService.generate` com ator
   originado do servidor e revisão capturada antes do await. Selecionar no frontend
   não faz essa conexão. Embeddings são uma finalidade/modelo distinta; não trocar
   silenciosamente embeddings quando o operador escolhe um modelo de texto.
3. **Preservar privacidade e consentimento.** Reaplicar filtros de fontes públicas,
   redação de dados sensíveis, retenção por modelo e verificações antes/depois do
   envio de #93. Mapear os escopos sessão/provedor/modelo/revisão e revogação entre
   ports deliberadamente; o singleton legado que limpa concessões globais não deve
   revogar outras sessões do catálogo. Política/estado de retenção precisa de
   contrato backend antes de substituir avisos legados, sem inferência por preço.
4. **Preservar orçamento e autoria.** Reutilizar o ledger compartilhado de #95,
   evitar cobrança/reserva duplicada e informar o modelo/provedor efetivamente
   utilizado. Não criar fallback externo ou replay automático de outra escolha.
5. **Preservar D e testar a migração.** Catálogo/geração é consultivo. Aprovação por
   item, versões, simulações e comandos continuam sob D. Cobrir concorrência, clear,
   revogação/reconfirmação em voo, reinício, isolamento de músicos/operadores e falta
   de preço em cada consumidor antes de retirar o seletor legado ou alegar unificação.

Essas etapas não foram implementadas nesta atualização, pois alterariam consumidores
que ainda têm contratos separados. Não há encaminhamento de transcrição ou resposta
para parser, proposta ou comando do mixer.

## Validação e screenshots

Angular testa DTOs/erros reais, ID manual, consentimento, validação sem seleção,
revisões, DELETE, revogação em voo, timeout e mudança de sessão. E2E usa **servidor
LAB e catálogo reais**, simulando apenas o HTTP externo de metadados; verifica as
quatro rotas, duas sessões, revisão antiga, catálogo desabilitado, autorização do
músico, legado inalterado, teclado/responsividade e zero escrita na mesa. A suíte
legada do Gemini/#93 continua intacta. Regressões completas e CI constam no PR #94.

Screenshots em `screenshots/` usam somente modelos/chaves fictícios e preços de
fixture explicitamente configurados no backend de teste; não validam contas reais.

```sh
npm run build:web
MIXAI_CAPTURE_PROVIDER_UI=1 npx vitest run --config vitest.e2e.config.ts test/e2e/ai-provider-settings.test.ts
```

Pendentes físicos: touch Yoga/Android e leitor de tela real. Provedores/contas reais,
preços de produção e qualidade de geração não foram validados; não houve chamada
paga, acesso à Ui16, `serve:real`, escrita REAL, alteração de D ou configuração de rede.
