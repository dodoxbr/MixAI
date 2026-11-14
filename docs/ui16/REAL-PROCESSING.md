# Ui16 — preparação de EQ e processamento, gate fechado por padrão

Esta entrega contém código executável e ensaios com `soundcraft-ui-connection@7.1.0` e socket injetado. **Nenhuma conexão à Soundcraft física, `serve:real`, escrita física ou validação acústica foi realizada.** O bootstrap normal não configura `processingGate`: todos os controles de escrita de processamento REAL permanecem bloqueados. A preparação original não adicionou botão Angular, opção CLI/YAML, variável de ambiente nem desbloqueio por HTTP ou por modelo de IA. O painel de consulta acrescentado posteriormente está descrito ao final.

Base: merges dos PRs [#97](https://github.com/dodoxbr/MixAI/pull/97) e [#100](https://github.com/dodoxbr/MixAI/pull/100). O gate de AUX e seu limite de 1 dB permanecem independentes. Esta entrega não habilita E6, cenas físicas, AFS2, phantom, pré-amplificador, master, batch ou medição de áudio.

## Matriz de capacidades e evidências

Fontes: pacote fixado no lockfile, [tipos publicados 7.1.0](https://unpkg.com/browse/soundcraft-ui-connection@7.1.0/lib/facade/eq/), [conversores](https://unpkg.com/soundcraft-ui-connection@7.1.0/lib/utils/value-converters/eq-converters.d.ts) e implementação `index.mjs` do mesmo pacote. A disponibilidade na biblioteca não comprova publicação/aceitação pelo firmware da mesa da banda.

| Recurso de entrada Ui16 | Leitura comprovada na biblioteca | Setter comprovado/preparação | Limites desta entrega |
|---|---|---|---|
| Bandas 1–4, frequência | `ChannelEq.band(n).frequency$` | `EqBand.setFrequency(hz)` | 20–20000 Hz; inteiros; razão máxima 2 entre anterior/alvo |
| Bandas 1–4, ganho | `gainDB$` | `setGainDB(db)` | −6 a +6 dB, precisão 0,1 dB, passo máximo 1 dB |
| Bandas 1–4, Q | `q$` | `setQ(q)` | 0,1–10; precisão 0,01; razão máxima 2 |
| HPF, frequência | `hpf.frequency$` | `hpf.setFrequency(hz)` | 20–300 Hz; inteiros; razão máxima 2, exceto transição explícita para/de desligado |
| HPF, bypass | Derivado do valor bruto mínimo da frequência | **Não há setter de bypass separado**: frequência explícita de 20 Hz para desligar | Para religar, informar uma frequência explícita; o undo restaura a frequência anterior observada |
| Bypass do EQ | `ChannelEq.bypass$` | `ChannelEq.setBypass(boolean)` | Somente booleano explícito; sem toggle relativo |
| HPF slope | `EqFilter.slope$` documentado apenas Ui24R | Não autorizado | Ui16 indisponível; não assumir 12/24/36 dB/oct |
| LPF | Documentado apenas Ui24R | Não autorizado | Ui16 indisponível |
| Compressor, gate, de-esser | Nenhuma fachada/stream tipado encontrado no pacote examinado | Nenhum caminho ou setter presumido | `unavailable_library_facade`; existência do recurso na mesa não comprova uma API nesta biblioteca |

`EqBand` documenta faixa nativa 20–22050 Hz, Q 0,05–15 e ganho −20 a +20 dB; o HPF nativo documenta 20–1000 Hz. As faixas de escrita acima são deliberadamente mais restritas, não uma alteração das capacidades do aparelho. Uma origem fora da política não é alterada: isso evita uma proposta cuja reversão seria proibida.

Caminhos e conversões vêm de `eqBandPath`, `eqFilterPath`, `eqBypassPath` e dos conversores publicados. Chamam-se os setters da biblioteca; não se envia um SETD construído pelo cliente. O único frame exato calculado pelo servidor é uma allowlist temporária para conferir a saída desse setter. Não foi inventado endpoint HTTP/GET da mesa.

## Estado observado, precisão e confirmação

- Leitura vem da entrada independente do socket, após validação do envelope e dos valores. O cache da biblioteca também recebe escrita local e **não** é confirmação.
- Cada observação conserva geração, sequência, instante e valor bruto. `pending`, `stale`, `unavailable` e `confirmed` descrevem o parâmetro; `hardwareValidation: pending` continua presente. `confirmed` aqui não é áudio medido, nem prova de causalidade de um comando.
- Leitura operacional do processamento fica desatualizada após a janela de frescor (padrão 3 s; gate admite 10–30000 ms). Isso é quarentena conservadora: não se presume que o firmware publique periodicamente um parâmetro inalterado.
- A autorização exige valor atual finito/booleano, recente, da geração atual e canônico no codec da biblioteca. Uma leitura arredondada não autoriza restauração de um valor bruto diferente. Em particular, frequência arredondada para 20 Hz com valor bruto maior que zero **não** significa HPF desligado.
- A escrita aguarda nova entrada independente, posterior à origem e na mesma geração, com alvo canônico. Coincidência retorna `observed_target`, com `causalAcknowledgement:false`. Não há ACK causal, ID de operação ou timestamp do dispositivo neste protocolo. Uma mensagem antiga em trânsito na mesma conexão não pode ser distinguida com certeza; a validação supervisionada permanece necessária.
- Timeout, divergência, desconexão, mudança de estéreo, revogação, erro após envio ou falta de resposta geram resultado não confirmado. O parâmetro fica cercado pela sequência incerta até nova observação. Não há retry, rollback ou aplicação de recomendação automáticos. Uma falha comprovada antes do gate consumir o frame é `not_sent`; falha inesperada do executor é indeterminada.

A biblioteca pode propagar um setter para o par estéreo. Esta fase exige identificação Ui16 e observação recente `stereoIndex=-1` do canal. Sem evidência de canal mono, recusa. Rota, sessão e estado são revalidados antes do envio e da confirmação. O gate só admite **um frame**, um canal e um parâmetro, consumindo a autorização.

## Fluxo e contratos do servidor MixAI

As rotas abaixo são implementadas pelo **MixAI**, no mesmo escopo local REAL autenticado do #100; não são endpoints da Soundcraft. Não ampliam listeners, entrada HTTPS LAB ou políticas de rede. O servidor em LAB/MOCK não registra estas rotas REAL. Os ensaios usam `mode=real` somente com socket falso injetado, sem rede física.

1. `GET /api/ui16/processing/:channel`: operador autenticado consulta capacidades, valores/qualidade, bypass HPF derivado e `physicalWriteEnabled`/`physicalWriteAvailable`. Não solicita ativação de recurso na mesa.
2. `POST /api/ui16/processing/preview`: `{targetMode:'real', serverId, key:'ch.2.eq.b1.gain', value:1, source:'operator'|'assistant'}`. `serverId` deve ser a instância atual. Retorna proposta com nome/canal do cadastro, anterior/alvo explícitos, unidade no parâmetro, revisão, validade, escopo e reversão. Só a prévia não escreve.
3. `POST /api/ui16/processing/:id/confirm`: `{targetMode:'real', serverId, requestId, humanConfirmed:true}`. A proposta pertence à sessão do operador, expira em 15 s e não aceita substituição de alvo. Mesmo ID de requisição retorna o resultado da tentativa; outro ID não reaplica a autorização consumida.
4. `POST /api/ui16/processing/:id/cancel`: `{targetMode:'real', serverId}`. Cancela uma proposta não consumida. Uma operação já enviada não é cancelada nem revertida implicitamente.
5. Reversão: nova prévia com `{targetMode:'real', serverId, undo:true}` seguida de **nova confirmação**. Exige topo da pilha existente com um único parâmetro suportado, leitura/revisão atuais e alvo anterior ainda permitido. Uma alteração externa torna a reversão obsoleta. O comando público `undo` não consome uma entrada de processamento REAL sem essa autorização.

Corpos estritos recusam lote, `values`, parâmetros desconhecidos e flags de aprovação extras. Músico e token MCP não podem propor, aprovar ou escrever processamento. Não há autenticação nova: usa `principalOf`, `Auth.isActive`, revogação e proteção da entrada existentes. Respostas têm `no-store`; revogação durante o voo invalida a resposta HTTP.

`ProcessingProposal` expõe `scope: input_channel_processing_not_destination_specific`: é processamento do **canal de entrada**, não um EQ independente do destino pedido. O efeito nos retornos depende dos pontos de envio e roteamento ainda não observados; AUX1/HA800 é compartilhado. A proposta contém esse aviso. Não se confunde ajuste do canal com envio AUX de fader.

### Assistente e execução única

`source:'assistant'` identifica a origem consultiva da proposta, nunca autoridade. O operador autenticado solicita a prévia para revisar um candidato tipado com chave/alvo explícitos; o servidor calcula anterior e reversão. Não se transforma texto de diagnóstico em comando. O catálogo, roteador, adaptadores de IA, núcleo D/AutoConfig e Angular **não foram modificados**. A consulta visual está descrita ao final; edição visual continua como integração posterior. Não se declara conversa de EQ ponta a ponta pronta.

`ServerCore.execute → dispatch → MixController` continua sendo o único executor. O novo verbo `set_processing` escreve uma única chave e exige `Expectation.authorize` interno; o cliente HTTP/WS não pode fornecer esse callback. A fila, auditoria, revisão, rate limit, aplicação e pilha de desfazer são os existentes. O handshake de #100 foi generalizado com perfil de codec/limites, preservando o perfil AUX original. Não há segunda fila ou executor de processamento. As mudanças no controlador são a entrada unitária e a guarda de reversão; não alteram o núcleo D nem promovem globalmente `simulated_only` a escrita REAL.

## Validação e futuro ensaio supervisionado

Testes com a biblioteca real e transporte falso exercitam os 14 parâmetros, codecs, um frame por ajuste, limites e passos, proposta humana/assistente, origem ausente/antiga/arredondada, modelo/estéreo, confirmação, timeout, conexão, revogação, concorrência, cancelamento, idempotência, reversão e autenticação HTTP. Regressões de #97/#100 são executadas junto. As contagens e CI final estão no PR.

Antes de qualquer ensaio físico, o responsável precisa aprovar um plano específico e confirmar:

1. Firmware/modelo, canal mono, sessão de operador e rota atual verificada; nenhuma configuração de rede é modificada automaticamente.
2. Sistema de áudio em condição segura supervisionada, PA/retornos/HA800 sob controle humano; valor anterior registrado na interface oficial.
3. Publicação independente e codec bruto de cada campo realmente observado. A biblioteca e fixtures não comprovam que o firmware publique esses campos.
4. Começar por **um** parâmetro, um canal e alvo explícito pequeno; conferir interface oficial, timeout, queda e ausência de replay. Nenhum batch, slope, LPF, dinâmica não comprovada ou canal estéreo.
5. Nova autorização humana para reversão, após leitura fresca; nunca restaurar automaticamente depois de divergência externa.
6. Avaliar precisão/quantização do firmware, parâmetros inalterados sem publicação e atraso na mesma conexão antes de considerar ampliar qualquer gate. Nenhum entrypoint desta entrega fornece esse desbloqueio.

Não foi realizado ensaio físico no Yoga, Android ou Ui16; não foram medidos espectro, SPL, microfonia, ganho acústico, compressor, gate ou de-esser.

## Integração com PA/AUX/mute (#102)

A branch incorpora o merge do #102, preservando a tela/CLI supervisionada do #101. Os conflitos em `ui16-real-bridge.ts` e `ui16-aux-write.ts` foram combinados para manter o handshake comum, observações independentes de todos os controles e o perfil de precisão do processamento.

| Bootstrap | Autoriza somente |
|---|---|
| `firstRealAux` (legado #101) | `aux_level` |
| `realControls.pa_level` | Fader do canal no PA |
| `realControls.pa_mute` | Mute do canal no PA |
| `realControls.aux_level` | Fader do envio AUX |
| `realControls.aux_mute` | Mute do envio AUX |
| `processingGate` | Um parâmetro EQ/HPF/bypass suportado por proposta |
| Master | Continua não habilitável nesta versão |

O perfil de processamento não é instalado como gate AUX, não aceita chaves de fader/mute e não pode receber gates de controle junto de seu perfil interno. O perfil de controles não aceita chaves EQ/HPF. `gateFor(key)` conserva rota, frescor e timeout próprios por categoria; uma categoria não toma emprestada a configuração da outra. O gate legado do #101 não promove PA, mute ou processamento.

Ambos os perfis continuam atrás da mesma fila do `MixController`: propostas independentes podem coexistir, mas cada frame e cada confirmação são serializados. Identificadores de proposta e undo não são intercambiáveis entre os serviços. Cada reversão exige seu fluxo correspondente e uma observação atual. Dados recebidos de uma categoria não confirmam operação de outra, inclusive quando o alvo booleano coincide.

`test/ui16-integrated-capabilities.test.ts` testa seis parâmetros (PA level/mute, AUX level/mute, EQ e HPF) na **mesma instância com socket falso**, aplicação e undo em ordem inversa, concorrência com apenas um frame em voo, gates isolados, padrão fechado, legado #101, frescor/rota por categoria, revogação e tentativa de emprestar permissões/confirmações. O procedimento físico continua pendente; integração de código/fixtures não valida firmware ou escrita na Soundcraft física.

## Painel EQ/HPF REAL: leitura física e validade para exibição

O inspetor de canal da mesa oferece **Abrir EQ/HPF REAL** somente em REAL. O painel consulta o GET autenticado existente, sem POST, setters, propostas implícitas ou ativação de recursos. Quatro bandas mostram frequência, ganho e Q; HPF e bypass têm leitura separada. Faders, PA/AUX, teste supervisionado e EQ LAB conservam seus fluxos. Mesmo com um gate supervisionado configurado no backend, **esta tela permanece somente leitura**. Uma futura edição deverá usar as propostas, confirmação humana e reversão existentes, jamais escrita direta.

### Evidência física relatada e limites

O responsável informou que, em teste independente com a Ui16 física no CH3, recebeu banda 4 −1,0 dB / 6640 Hz / Q 1,00, HPF 98 Hz e EQ bypass false, coincidentes com a interface oficial. Esse relato confirma esses campos **naquela sessão**, não a publicação de todas as bandas, frequência de atualização, codecs em todos os limites ou compatibilidade universal de firmware. O desenvolvimento e as imagens desta entrega usam transporte **simulado**; o agente não conectou à mesa nem repetiu o teste físico. `hardwareValidation: pending` não foi promovido globalmente por esse relato.

### Frescor: consulta não é autorização

A janela operacional padrão de 3000 ms continua intacta, incluindo o limite configurado por gate e toda revalidação da escrita. Após essa janela, `processingReading` continua retornando estado operacional antigo e nenhuma origem apta a escrever. A novidade é um campo **aditivo de exibição**, sem uso pelos executores:

- `schemaVersion: 1`, `serverId`, `channel` e `connection: {generation, link}` identificam a resposta do GET.
- Cada `parameters[key].display` contém `state`, `source: independent_socket_input`, valor quando disponível, `ageMs`, `freshnessMs`, `generation`, `connectionCurrent` e motivo operacional. `rawValue`, quando presente, é a amostra bruta independente, não o cache da biblioteca.
- **Confirmado**: amostra independente recente na conexão atual; não é ACK causal ou áudio medido.
- **Última observação**: amostra independente da conexão atual, fora da janela de escrita. Valor inalterado não precisa ser republicado a cada 3 s para continuar sendo consultável.
- **Desatualizado**: histórico de conexão anterior, desconexão, quarentena de silêncio, parâmetro anterior ao cercamento ou escrita incerta. Pode ser mostrado como histórico, nunca como dado atual ou base da curva.
- **Desconhecido**: nenhuma amostra disponível. Campos ausentes não recebem frequência, ganho, Q ou bypass padrão.

`ageMs` é duração monotônica, não data de relógio. O navegador inclui conservadoramente o tempo de trânsito HTTP na idade, atualiza-a entre consultas e rebaixa a qualidade após `freshnessMs`. Uma resposta atrasada não renova a amostra. Consulta a cada 2 s com timeout de 6 s; troca de canal, servidor, sessão, modo ou conexão cancela e cerca respostas em voo. Erros apagam os valores exibidos. Não há persistência nem cache local de processamento entre contextos.

A quarentena de silêncio de entrada (30 s por padrão) permanece. Não se presume que um socket aberto prove sincronismo contínuo; após silêncio, amostras anteriores ao cercamento não recuperam qualidade apenas porque outros parâmetros voltaram. Reconexão exige novas amostras da nova geração para apresentação como atuais. O polling HTTP **não** solicita republicação à Ui16 e não envia SETD.

### Curva e apresentação

O gráfico só aparece com as quatro bandas completas e bypass conhecidos na mesma conexão atual. É uma **estimativa digital RBJ a 48 kHz**, não medição de resposta/espectro nem reprodução comprovada dos filtros do firmware. Quando inclui última observação, usa tracejado. HPF aparece somente como marcador de frequência: sua inclinação não foi comprovada, portanto não entra no cálculo da curva. EQ bypass produz curva plana das bandas; não se infere por isso o roteamento ou bypass do HPF. HPF desligado só é indicado por valor bruto zero; frequência arredondada de 20 Hz não basta.

O painel é informativo, sem sliders ou nós arrastáveis falsamente funcionais. Oferece navegação por teclado, contenção de foco no diálogo, Escape e retorno do foco ao botão de abertura. Layout de quatro/duas colunas para notebook/tablet. Capturas em [live-eq/desktop.png](live-eq/desktop.png) e [live-eq/tablet.png](live-eq/tablet.png) usam servidor REAL com socket falso injetado, não hardware.

### Validação manual futura

Sem habilitar escrita, confirmar no Yoga: legibilidade e toque, quatro bandas realmente publicadas, correspondência com interface oficial após alteração externa, permanência de amostra inalterada após 3 s com tráfego independente ativo, queda/silêncio/reconexão, troca de canal, amostras parciais e ausência de comandos de processamento enviados pelo painel. A conexão oficial pode alterar estado intencionalmente; o MixAI não restaura valores. Firmware, slope, resposta acústica e escrita física continuam fora da validação desta entrega.
