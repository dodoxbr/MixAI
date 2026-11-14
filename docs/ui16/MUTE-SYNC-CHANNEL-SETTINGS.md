# MUTE observado e cadastro local de canais/AUX

Base: main `4f221e6`, incluindo #104 e os controles #100–#103. Esta entrega não
habilita gates, não altera os executores REAL ou o núcleo D e não testa hardware.

## Evidência e causa: o que pode ser afirmado

O operador informou faders sincronizados, 45 parâmetros na leitura inicial e MUTE
PA parado. Depois confirmou que AUX1 sincronizava e que **Ctrl+F5 restaurou também
MUTE/unmute no PA**. As imagens foram montadas para evidenciar estados diferentes;
não comprovam inversão da polaridade. Não invertemos PA/AUX.

Ctrl+F5 recria a página, o estado Angular e a conexão WS/snapshot. Esse resultado
isola a ocorrência à sessão/página anterior, mas não permite distinguir, sozinho,
cache de bundle, snapshot antigo ou um evento perdido. Não há captura sanitizada
do socket dessa sessão anterior para atribuir uma causa física mais específica.
Seria incorreto afirmar que a biblioteca inverte MUTE ou que faltou SETD na mesa.

Um defeito distinto é reproduzível no código: `soundcraft-ui-connection@7.1.0`
seleciona mute com `sn('mute',0,...)` e converte com `!!`. O stream pode emitir
**false antes de qualquer amostra do dispositivo**. O supervisor pode completar
sua sincronização com esse default. Portanto READY não é comprovação por parâmetro.

A ponte já mantinha observações independentes; a correção torna explícita a
condição para MUTE conhecido: presença de amostra validada do socket, na mesma
**geração e sequência** da recepção. Antes da primeira amostra, ou enquanto um
pacote está entre a atualização de metadados e sua decodificação independente,
MUTE permanece `pending`/`known:false`. Um `false` efetivamente recebido é conhecido,
assim como `true`. Conexão READY e confirmação do parâmetro continuam separados.

Essa proteção não é apresentada como causa comprovada da tela congelada original.
O comportamento físico após Ctrl+F5 foi confirmado pelo operador; o endurecimento
e a cadeia completa são demonstrados com transporte simulado.

## Cadeia verificada

1. Socket injetado entrega `3:::SETD^i.(CH-1).mute^0|1` para PA ou
   `3:::SETD^i.(CH-1).aux.(AUX-1).mute^0|1` para envio AUX.
2. O gate valida os campos antes de entregar à biblioteca. A biblioteca converte
   booleano; a ponte ignora seu eco/default e usa o callback de entrada independente.
3. `Ui16RealBridge.independentInput` registra bool, geração e sequência; alteração
   efetiva chama `onParamChange` (repetição igual não duplica revisão).
4. `MixController.observe` atualiza revisão e `StateHub.flush` publica o parâmetro
   lido da ponte. Não se altera esse executor.
5. O WS existente filtra por permissão e serializa booleanos sem converter para dB.
6. `LiveService`/`StateSync` aplicam o evento e os componentes existentes atualizam
   `aria-pressed` e a classe visual do MUTE. PA e AUX são chaves distintas.

`test/real-mute-sync.test.ts` percorre todos os canais cadastrados e PA/AUX1/AUX2,
true/false repetidos, desconhecido, primeira amostra e reconexão. O E2E envia frames
no socket falso e confere os botões Angular sem recarregar a página nem pedir
snapshots periódicos. Não existe polling de MUTE adicionado.

## Configuração: mesma fonte e mesmo resolvedor

Configurações → Mesa → Canais e AUX edita os nomes/apelidos do cadastro existente.
Os números físicos são texto fixo; não é tela de adicionar/excluir canais, atribuir
permissões ou cadastrar saídas físicas. O AUX1/HA800 continua compartilhado.

A auditoria não encontrou endpoint de edição desse cadastro: `loadConfig` lê
`config/channels.yaml`; `ChannelMap` é o resolvedor já utilizado pelo assistente.
As novas rotas **locais do MixAI**, GET/PUT `/api/settings/channels`, utilizam o mesmo
arquivo, parser YAML, autenticação e mapa — não são endpoints da Soundcraft nem
um segundo sistema de configuração. IA/músico não têm acesso de escrita.

- Validação por normalização/prefixos usados pelo resolvedor, nomes e aliases
  duplicados entre canais, números reservados e frases ambíguas no reconhecimento.
  PA/master/comandos reservados não viram apelidos de canal. Canal e AUX conservam
  seus namespaces (um retorno pode ter nome de instrumento).
- Revisão SHA-256 do arquivo evita sobrescrever uma versão aberta em outra aba.
  Escritores MixAI usam `OwnerLock` existente, temporário exclusivo e rename.
- Cópia integral anterior em `data/channel-config-backups/<hash>.yaml`; comentários
  e metadados desconhecidos do YAML são preservados. Não há reset ou exclusão.
- Sessão é revalidada antes do commit. Falha de validação/disco mantém o mapa em
  memória; gravação bem-sucedida atualiza os mesmos objetos e índices do ChannelMap,
  preservando referências mantidas pelos serviços e pelo assistente.
- Evento `names_changed` manda as sessões atualizarem `list_names` uma vez; não há
  polling. Respostas de sessão/servidor anteriores são descartadas no frontend.
- Alteração externa da lista de números exige revisão/reinício; a tela não substitui
  silenciosamente o cadastro físico. Editores externos não cooperativos devem evitar
  gravar o YAML simultaneamente; a cópia anterior permite recuperação manual.

## Nomes da mesa

A biblioteca já observa `SETS^i.n.name^texto`. Seu `name$` também pode gerar nomes
default; por isso a comparação da ponte só exibe nomes efetivamente recebidos em
SETS na geração atual. Sem amostra, após queda ou reconexão ainda sem nome, mostra
Indisponível. Nome vazio apaga apenas a observação da comparação, nunca o nome local.

A tela mostra nomes locais e nomes relatados lado a lado; não envia SETS/SETD nem
sobrescreve o YAML por conta de uma alteração feita na interface oficial.

## Limites e validação manual

Testes simulados não validam firmware, qualidade acústica nem a causa exata da
sessão anterior. A futura checagem física deve manter REAL somente leitura, comparar
PA e AUX1, testar mudança externa de MUTE nos dois sentidos e conferir que a página
atualiza sem reload. Registrar apenas campos sanitizados se o congelamento reaparecer.
Nenhuma escrita física ou chamada de IA externa é necessária para esta verificação.

A nova UX AUX SENDS (seis barramentos) será entregue em branch/PR separados; não se
mistura esta correção com a expansão de visualização e observabilidade dos AUX.
