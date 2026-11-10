# Configurações → Inteligência Artificial

Missão C, base `fc3abb5`. Painel Angular para operador, aberto por **Configurações**
na barra superior. Usa tokens visuais, botões e espaçamento do MixAI, sem fontes
ou bibliotecas de UI externas. Não altera serviços de backend.

## Comportamento entregue

- Cinco provedores sempre visíveis: Ollama, Gemini, DeepSeek, Anthropic e OpenAI.
  Configuração não é conexão: a API atual informa `configured`, sem health
  externo. Por isso não mostramos “Conectado” só porque existe uma chave.
- A seleção ativa é exclusivamente a resposta do servidor. Durante recarga ou
  POST incerto, o ativo anterior fica indisponível, sem atualização otimista.
  Falhas não promovem a escolha local a seleção ativa nem geram retry de POST.
- A lista de modelos vem da API. Modelo não retornado não é adivinhado.
  Mudança do modelo do provedor já ativo também pode ser aplicada.
- Confirmação externa explícita, enviada como `confirmExternal: true` no POST,
  sem guardar o checkbox em storage. Troca de provedor/modelo, erro, desconexão,
  troca de sessão/instância e fechamento invalidam o aceite local. Isso **não**
  revoga um consentimento que o servidor já recebeu. A autoridade é do backend.
- Erros sanitizados, carregamento, aviso de resposta lenta após 3 s, prazo de
  25 s, cancelamento de espera e proteção contra respostas de geração anterior.
  Cancelar/fechar não garante rollback de uma seleção já recebida pelo servidor.
- Dialog nativo para foco modal, Escape, retorno de foco, teclado, fieldset/legend,
  labels, alertas e status para leitores de tela. Rolagem interna e layout de
  uma coluna no celular; duas colunas em Yoga/desktop.

O seletor duplicado da Base de conhecimento foi substituído por uma orientação
para o painel central. Seus testes de consentimento foram transferidos/ampliados
para `provider-settings.spec.ts`, e o E2E de Gemini continua verificando o envio,
remoção de dados sensíveis, fallback e ausência de comandos pelo backend existente.

## Fronteira com o Agente B

`web/src/app/ai-settings/provider-settings-port.ts` é **modelo de apresentação**,
sem impor um contrato HTTP ao backend. `ProviderSettingsService` conhece somente
esse port. `LegacyProviderSettings` traduz o contrato existente:

| API atual | Tratamento no painel |
| --- | --- |
| GET `/api/knowledge/providers` | Lista de opções, seleção, modelo/lista quando presentes, narrative e fallback |
| POST na mesma rota | `{chat, model?, confirmExternal?}`, no formato atual, com Bearer da sessão existente |
| Opção externa `configured: false` | Não configurado; indicar chave/serviço no servidor sem pedir credencial no navegador |
| Provedor ausente | Indisponível; não inventar ausência de chave |
| OpenAI | Visível e indisponível: a API atual não o aceita |
| Sem `models` | ID somente leitura; a API atual rejeita modelo fora de `modelOptions`, portanto não enviamos um ID manual sem suporte |
| Sem modelo ativo | “Modelo não informado pela API” |
| Health externo ausente | Configurado, sem simular conexão ou fazer chamada externa de teste no navegador |
| Custo, orçamento e consumo ausentes | “Não disponível” / “Custo desconhecido”; nunca zero ou ilimitado por inferência |

### Integração posterior necessária

Substituir **somente** o binding `PROVIDER_SETTINGS_PORT` e sua implementação de
transporte quando o contrato real do B estiver disponível/revisado. A implementação
atual não tenta endpoints hipotéticos e rejeita respostas incompatíveis.

O port admite `modelMode: manual` e estado `connected` para backend que declarar
essas capacidades. A entrada manual valida sintaxe (até 160 caracteres, sem
espaços/HTML); disponibilidade do ID continua sendo decisão do servidor.
O adaptador legado mantém a regex e o limite de modelo do backend atual.

Valores financeiros só são exibidos com proveniência `source: backend`, USD,
número finito não negativo e data de referência válida. Preço exige o mesmo ID
do modelo selecionado; entrada/saída são por milhão de tokens, com data informada.
Nada deriva de tabelas públicas, tokens inventados ou estimativas no navegador.
B precisa informar também escopo/período dos limites e do consumo antes de uma
integração de faturamento completa; não assumir limite diário nem saldo disponível.

**Limitação legada Gemini:** conforme `docs/lab/29-PROVEDORES-IA.md`, o resumo do
Gemini preserva a seleção confirmada entre sessões. O planejador e os demais
externos têm mecanismos próprios existentes. A tela exige aceite nesta abertura
para cada POST externo, mas não pode corrigir nem prometer revogação global do
fluxo legado. Exibe essa limitação e não mostra uma concessão de sessão presumida.
O alinhamento server-side e a consulta/revogação de consentimento pertencem a B.

O [PR #92](https://github.com/dodoxbr/MixAI/pull/92), ainda aberto durante esta
entrega, modifica o seletor antigo e unifica consentimento no servidor. Não foi
incorporado nem alterado. Sua integração exige conciliar os testes movidos,
consumir o booleano `sessionConsent` quando esse contrato estiver na base e
preservar avisos de retenção por modelo. A advertência legada do Gemini deve
então ser substituída pelo estado real informado pelo servidor. Não resolver
essa sobreposição descartando as proteções de qualquer entrega.

B também precisa expor saúde/chave/modelo com motivos estruturados, estado de
consentimento por sessão, OpenAI e telemetria de custo para completar esses itens.
Os testes de capacidades futuras usam mocks do port, **não** adaptadores externos
ou sucesso simulado em produção. Perguntas/manuais continuam sujeitos às políticas
existentes; esta UI não recebe chaves nem faz chamadas a provedores diretamente.

## Validação

Testes Angular cobrem normalização, ausência de chave/API, consentimento, modelos,
campos monetários, falhas, cancelamento, prazo, revogação e respostas tardias.
E2E cobre desktop, Yoga e celular, Escape/foco, isolamento do músico, seleção via
servidor e ausência de escrita na mesa. Regressões e CI são registradas no PR.

Screenshots em `screenshots/` usam metadados **fictícios interceptados no teste**,
com servidor LAB local. Não comprovam conexão com nenhum provedor. Gerar somente
quando solicitado no ambiente de testes:

```sh
npm run build:web
MIXAI_CAPTURE_PROVIDER_UI=1 npx vitest run --config vitest.e2e.config.ts test/e2e/ai-provider-settings.test.ts
```

Nenhuma chamada paga, instalação de modelo, captura de áudio, conexão à Ui16,
escrita REAL ou mudança em autenticação, consentimento, orçamento ou núcleo D.
Leitor de tela real, touch físico no Yoga/Android e provedores com credenciais
continuam exigindo validação própria; o teste automatizado verifica semântica DOM
e comportamento de teclado no Chromium.
