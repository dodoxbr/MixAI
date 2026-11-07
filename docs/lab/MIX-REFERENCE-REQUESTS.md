# Referência e solicitações — Issue #49, LAB

Na Mesa e nos Fones, abra **Referência e pedidos** / **Solicitar ao operador**.
O painel fica na mesma tela dos controles existentes. Só existe em LAB, para sessões
operador/músico já autenticadas; não cria outro login nem altera permissões de faders.
A entrada HTTPS reutiliza a política central do proxy, inclusive a recusa do token MCP.
Não há chamadas de comando, parser de comandos, restauração, recall ou escrita REAL neste recurso.

## Passagem de som e referência

1. Ajuste o LAB pelos controles normais; escolha evento, data e destino PA ou AUX1.
2. Confira o estado observado e marque a aprovação explícita para salvar.
3. Selecione uma referência para ver valores salvos, atuais e delta **atual − referência**.
4. Para revisar o mesmo evento/destino, salve uma nova versão; as anteriores permanecem.
   **Novo evento** gera outro identificador. A seleção de uma versão não carrega valores.

A captura usa o `SceneStore` E5 existente e congela uma cópia da cena no registro:
identificador do evento/referência, nome, data, versão, perfil do dispositivo, canais e
nomes do mapa configurado, origem LAB/servidor/revisão, aprovação do operador e histórico.
A referência cobre volumes e mutes dos canais no destino escolhido, mais o master PA.
EQ, roteamento e outros estados não são prometidos como uma configuração física completa.
Uma cena MixAI **não é snapshot nativo Soundcraft**. Não há cenas físicas ou E6.

Estados desconhecidos ou não suportados ficam explícitos e não viram valores presumidos
na cena. `UNVERIFIED` significa sem validação acústica/física: aprovação do registro pelo
operador não comprova que o som está adequado. AUX1 alimenta o retorno compartilhado HA800;
não representa mixes individuais por músico.

Diferenças de pelo menos 3 dB, mute ou transições de infinito recebem destaque. Delta
numérico só existe para dois valores numéricos conhecidos. Estado indisponível fica
marcado como tal. Atualizações observáveis chegam pelo estado/WebSocket já existente;
a origem só é apresentada quando fornecida por essa infraestrutura. Uma alteração pela
interface oficial só poderá ser reconhecida como divergência quando o adaptador a observar.
Nada é restaurado: o ajuste pode ter sido intencional. Validação REAL não ocorreu.

## Solicitações

O músico informa tipo (`meu_canal`, `mix_geral`, `diagnostico`), fonte/canal quando conhecido,
destino e relato. O servidor vincula a sessão, nunca aceita identidade ou privilégios do
corpo HTTP. O adaptador integrado usa `core.musicianIdentity(p)`, com o conjunto de canais
e revisão do vínculo ativo (#53): Lucius pode solicitar “meu canal” para CH1 e CH4, Fred
para CH3. Sem vínculo ativo, ou com canal alheio, esse tipo é recusado com 403. Um relato
`mix_geral`/`diagnostico` sem vínculo continua não verificado e não concede privilégios.
O operador vê todos os pedidos; o músico só vê os da própria sessão ou de identidade
estável validada pelo servidor. Não informe PINs/segredos nos relatos.

**Chat dos meus canais** mantém o fluxo de propostas/autorização existente. **Solicitar ao
operador** registra um relato na bandeja sem criar proposta. **Consultar mesário IA (somente
leitura)**, na bandeja do operador, anexa orientação técnica offline para revisão; não
confirma o relato do músico como evidência do operador e não cria nenhuma alteração.

A bandeja mostra estado, versão, prazo, resposta e histórico. O operador pode pedir mais
informação, sugerir, aprovar uma orientação, recusar ou registrar impedimento. O autor
pode complementar/cancelar; depois de aprovado deve cancelar/criar outro pedido.
`approved` **não aplica ajuste**. `applied` está reservado no esquema para futura integração
com recibo confiável de execução: não pode ser escolhido por HTTP ou pela UI nesta entrega.
Solicitações expiram após dez minutos fixos (TTL configurável fica como evolução após ensaio de operação), inclusive aprovadas ainda sem execução. Expiração
é persistida na próxima leitura/mutação. Não há aplicação posterior automática.

A aprovação manual direta é uma avaliação explícita do estado atual. Uma sugestão anterior
com revisão antiga exige reavaliação antes de aprovação. Cada alteração usa versão esperada;
concorrência retorna 409 em vez de sobrescrever o outro operador. Após reinício, o servidor
recusa envelopes antigos. Não há reenvio automático de POST. Ajustes normais continuam no
fluxo existente; esta bandeja não cria aprovações repetidas para esses controles nem relaxa
as proteções de operações críticas.

## Contratos de integração (#47 / #48)

`src/reference/contracts.ts` mantém portas desacopladas. `src/reference/adapters.ts`
fornece os adaptadores padrão no startup LAB; `startServer.referencePorts` é uma injeção
confiável para testes/integração, não uma configuração por HTTP.

- `MusicianIdentityPort.resolve(principal)` retorna vínculo verificado, ID, nome,
  `channels:number[]` e revisão. Usa somente `core.musicianIdentity(p)` e sessão ativa,
  preservando as duas senhas e toda a autorização #53. PIN/nome/canal do relato não
  identificam uma pessoa. Revogar ou alterar o vínculo impede novos pedidos `meu_canal`
  indevidos, oculta pedidos verificados da sessão revogada e invalida avaliação/aprovação
  de pedidos verificados antigos, mesmo sem
  mudança nos faders. O operador ainda pode recusar/cancelar esses registros.
- `ReferenceRecommendationPort.recommend(...)` recebe relato/canal/destino/revisão e retorna
  texto, origem `diagnosis`, status `needs_context`/`theoretical_guidance` e fontes HTTP(S).
  Usa `parseConsultation`/`consult` puros do #51, sem chamar `ask`, `apply`, parser de comandos,
  Claude, controlador ou mixer. Evidências ficam vazias: relato de músico não é promovido
  a relato confirmado do operador nem medição. Informação insuficiente é explícita.
  A orientação completa e suas fontes são exibidas em seção própria na bandeja.

Após aguardar uma recomendação, o serviço revalida sessão do operador, versão do pedido,
estado da mix e vínculo original. Diagnóstico não executa nada; aprovação não aplica
orientação. Payloads de recomendação com comandos são rejeitados. A falta de adaptador
continua retornando 503; a execução normal já fornece os dois adaptadores.

Esquema 1 preserva leitura dos registros anteriores: `boundChannel` legado é opcional;
novos registros gravam `boundChannels` e `bindingRevision`. Um registro antigo verificado
sem esse contexto não recebe aprovação nova sem reavaliação/novo pedido. Após reinício,
vínculos persistidos não autenticam sessões; o operador preserva os pedidos históricos.

## Persistência e recuperação

`mix-reference-requests.json` no `dataDir` LAB usa esquema 1 e revisão global, escrita síncrona
em temporário exclusivo/rename e cópia `.bak` anterior. O OwnerLock existente limita o LAB a
um processo proprietário; CAS não é um bloqueio distribuído entre servidores. Máximo 16 MiB,
100 referências, 500 pedidos, 50 entradas por histórico (última reservada a encerramento).
Ao atingir limites, retorna erro; não apaga auditoria silenciosamente. Não há migração
implícita de versões desconhecidas. Arquivo corrompido falha fechado com 503 e preserva o
original e backup; não ocorre rollback automático de decisões.

Para recuperação manual, encerre o servidor, preserve original/backup, investigue a falha,
valide o esquema e restaure somente uma cópia conscientemente escolhida pelo operador.
Guarde esses dados locais fora do Git, com acesso restrito; IDs de sessão são identificação,
não tokens de autenticação. A criação de cena E5 e o registro de referência são dois arquivos:
uma falha na segunda gravação pode deixar uma cena LAB sem referência. Ela permanece sem
aplicação; eventual limpeza deve ser manual pelo fluxo E5, nunca recall automático.

## Validação e limites

Testes integrados vinculam Lucius CH1+CH4 e Fred CH3 pelo operador, validam ajustes próprios,
consulta offline na bandeja, revogação e ausência de comandos ao aprovar. Testes simulam CH1/CH3, coro CH4–7, PA/master e AUX1; cobrem concorrência, revisões antigas,
múltiplas sessões/pedidos, autorização/revogação, persistência/reinício, corrupção/backup,
expiração e recomendações sem execução. E2E usa apenas LabMixer e comprova ausência de
chamadas de comando/escritas decorrentes do painel. Regressões incluem núcleo, Angular,
E2E, smoke Yoga simulado e HTTPS/WSS com Caddy e TLS validado.

Ainda exigem validação supervisionada: ergonomia no Yoga/Android real, certificados/rede
privada, observabilidade da interface oficial/firmware e avaliação acústica. Nenhuma mesa
física foi usada; F0 continua pendente e E6/escrita REAL não estão autorizados.

Foram lidas as skills `mixai-referencia`, `mixai-reference` e `soundcraft-ui16-safety` em
`.agents/skills/` da branch `chore/mixai-three-agents-skills`, commit
`830410497c3ca179c54037cccad52f7e1b3c65b9`, antes da incorporação do PR #50.
A consulta não copiou nem alterou o trabalho dos outros agentes. A base final já contém
as mesmas skills incorporadas pelo responsável no PR #50.

## Resolução de integração #51 / #53

Base incorporada: `399eaf8` (#53), incluindo `0f74ccb` (#51). Houve conflito textual
somente em `mesa.component.ts` (imports/componentes) e `fones.component.ts` (identidade
versus painel). Ambos foram integrados preservando vinculador, Meus canais, PA/FONES,
cenas/EQ e referência/pedidos. README, HTTP, startup e suporte de testes tiveram merge
automático revisado. Autenticação, allowlists, senhas e diagnóstico não foram duplicados.
O PR #52 continua exclusivo; nenhuma integração do PR na main foi executada pelo agente.
