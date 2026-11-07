# Issue #48 — base técnica consultiva do mesário

Branch `feature/sound-engineer-knowledge`, criada sobre `origin/main` em `3ea6444`
(#46 incorporado). AGENTS.md e Issue #48 lidos. As skills mixai-mesario,
live-sound-consultation e soundcraft-ui16-safety foram lidas **integralmente** via
`git show` em `origin/chore/mixai-three-agents-skills` (`8304104`, PR #50), sem merge,
cherry-pick ou cópia dos três arquivos. Os nomes históricos de agentes nesses arquivos
não alteram o escopo atual atribuído pelo responsável: conhecimento na Issue #48.

## Escopo e integração

Reutiliza `src/knowledge/sound-engineer/` e `src/assistant/sound-engineer.ts`. Continua
consulta determinística offline no caminho local já existente HTTP/WS/chat. Não há
serviço externo, download de manual no runtime, segundo assistente, driver ou mixer.
Não muda `service.ts`, login, vínculo de músicos, autorização, fila, propostas, cenas,
persistência de referência ou E6. Essas integrações pertencem às entregas B/D conforme
coordenação do responsável. A consulta continua restrita ao operador pela política
existente; relatos de músicos podem ser retransmitidos por ele. Não há autenticação
inferida a partir de uma frase contendo nome de músico.

O vocabulário passa de cinco para doze sintomas: embolado, estridente, abafado, magro,
desequilíbrio, microfonia, sibilância, clipping, ruído, monitoração, ganho e processamento.
Queixas combinadas mantêm fontes relacionadas e pedem um canal primário para aprofundar.
Microfonia é triagem prioritária, sem ocultar que os demais sintomas permanecem relatados.
Conceitos, perguntas, negações e hipóteses não ganham confiança de relato afirmativo.

## Pesquisa e proveniência (07/11/2026)

Síntese em português e adaptação editorial; nenhum manual integral, trecho longo ou PDF
é incluído no repositório. Metadados canônicos estão em `sources.ts`; citações resolvidas
incluem versão, seção, URL, data e estado de acesso. Os documentos não comprovam firmware,
protocolo, DSP ou compatibilidade acústica da unidade da banda.

| Fonte primária | Versão / seção consultada | Resultado e aplicação |
| --- | --- | --- |
| [Soundcraft Ui12/Ui16 User Guide](https://www.soundcraft.com/en/product_documents/ui_usermanual_v3-0-pdf-27c992b4-5132-4d2d-b8e2-79750de6ee29) | EN v3.0; §§4.1, 4.3/4.3.1, 5.2, 5.3, 5.3.1, 5.4 | PDF público consultado em `/en`; EQ/HPF, GEQ/RTA, AFS2, dinâmica e AUX. `/en-US` retornou 403 nesta rodada. |
| [Manual português](https://www.soundcraft.com/en/product_documents/ui_manual_v2-8_portuguese-pdf-f4a4a2c5-8071-4005-83d4-aad7ca399fb3) | PT v2.8; consulta complementar planejada | HTTP 403; `accessStatus:unavailable`. Não usado para sustentar afirmações. |
| [Shure — How to Control Feedback](https://www.shure.com/en-US/insights/how-to-control-feedback-in-a-sound-system) | Página datada 25/01/2013, sem revisão indicada; causas, interrupção do loop, posicionamento e fundamentos | Consultada; prevenção física antes de processamento. Não importar receitas numéricas/ring-out da página para execução no MixAI. |
| [Shure — Mic Placement](https://www.shure.com/en-EU/insights/three-reasons-why-mic-placement-matters) | 24/09/2014; Signal to Noise Ratio, Gain Before Feedback, The Sweet Spot | Consultada; padrão polar, vazamento e captação. |
| [Shure — Microphone Techniques for Live Sound](https://www.shure.com/publications/microphone_techniques_for_live_sound_reinforcement_english.pdf) | 39 páginas, revisão não identificada; Acoustic Characteristics p.14 e Microphone Placement p.22 | Publicação oficial consultada. Samba/pagode é aplicação editorial, não preset Shure. |
| [Yamaha — Equalization](https://hub.yamaha.com/proaudio/livesound/eq/) | 26/04/2018; Basic/Peak EQ e Advanced EQ | Consultada; Q, filtros e separação entre fontes. Não adotar tabelas numéricas como receitas Ui16. |
| [Yamaha — Gain Staging](https://hub.yamaha.com/proaudio/livesound/gain-staging/) | 22/03/2018; compatibilidade, gain/trim, PFL, headroom | Consultada; distinguir estágio de entrada e balanço. Alvos/casos Yamaha não validam Ui16. |
| [Yamaha — Compressor](https://hub.yamaha.com/proaudio/livesound/tools-of-the-trade-how-to-use-a-compressor/) | 27/10/2017; aplicação input/output e Compression Advice | Consultada; dinâmica antes de números ou receitas. |

A página Shure Service `how-do-i-fix-my-feedback-problem` retornou timeout/502; a
fundamentação nova usa a página oficial Insights acima. Não houve mudança de política
ou credenciais para acessar fontes bloqueadas. A referência ao pacote 7.1.0 já existente
permanece histórica, separada dos recursos descritos no manual e da validação física.

## Conhecimento versionado e perfis

`knowledgeVersion:2.0.0`; oito módulos técnicos v1.0.0: captação, EQ/HPF, GEQ/RTA,
AFS2, gain staging, dinâmica, balanço da banda e monitoração. Todos têm referências,
limites e `validationStatus:theory`. O esquema global reserva `verified_at_rehearsal`
para futura evidência, mas recomendações desta versão recusam esse valor.

Oito perfis editoriais v1.0.0 cobrem cavaco, violão seis cordas, violão sete cordas,
surdo, tantã, pandeiro, lead e coro. Os seis guias anteriores continuam acessíveis, com
versão/status explícitos. Perfis não armazenam microfone/modelo ou preferências inventadas.
A pergunta de captação/número de cordas permanece aberta mesmo quando o alias cadastrado
inclui “7 cordas”. Relações surdo–tantã, cavaco–violão e lead–coro são condicionais.
Fred CH3 só é identificado como lead com correspondência canal/nome do cadastro; CH4–7
como backing também exigem correspondência. Sem correspondência, conserva guia vocal genérico e não atribui perfis de lead/coro a pessoas. Isso não concede vínculo ou permissão.

Procedimentos consultivos não sugerem faixas numéricas padronizadas. Os pontos numéricos
LAB da E7B em `eq-guides.ts` foram preservados e **não** são carregados por diagnóstico
para produzir ajustes. E7A/E7B, escrita REAL e limitações de DSP continuam separados.

## Contrato para uso posterior pelo agente D

O envelope legado `Diagnosis` mantém `schemaVersion:1` e ganha `consultation` (contrato
aditivo v1). Tipos e schemas públicos exportados em `index.ts`:

- `DiagnosticRecommendation` / `diagnosticRecommendationSchema`: módulo/versão, status,
  instrução, precondições, hipótese/evidência citada, resultado esperado, rollback e
  citações completas. Sem chave de parâmetro/valor para aplicar, Intent ou comando.
- `diagnosticConsultationSchema`: `diagnostic`, `evidence`, `recommendations`, `references`,
  `diagnostic.hypotheses` com fontes/IDs,
  `proposal:null`, `requiresApproval:true`, `authorizedActions:[]`, `rollback` manual e
  `confidence`. `nextQuestions` contém até três perguntas prioritárias; as demais
  permanecem disponíveis no diagnóstico legado.
- `technicalModuleSchema`, `technicalModules`, `instrumentProfiles`, `interactions` e
  `sources`: inventário runtime validado/testável, sem dependência do Markdown das skills.

As citações indicam a base técnica de uma **hipótese**, não prova de sua causa. Confiança
continua baixa/insuficiente, nunca alta ou probabilidade calibrada. O endpoint rejeita
`sourceLabel` enviado pelo cliente: o nome usado para papel musical vem do cadastro do
servidor, não de identidade fornecida no payload.

`evidence.reports` conserva o tipo legado `operator_report`: relato retransmitido pelo
operador, sem certificar a identidade de quem o originou. `evidence` separa relatos de leituras declaradas de controles e de medidores simulados.
Esta consulta **não adquire estado atual do mixer**; mesmo uma leitura com revisão e
momento recebidos continua `caller_declared_not_verified`. Não afirma que um fader antigo
é estado atual, nem que um MUTE/fader demonstra nível de sinal. O contrato lista áudio,
RTA, SPL, VU real e redução de ganho como indisponíveis. Evidência `real_rta`/`real_audio`
forjada é rejeitada; transcrição com números não vira medição.

`requiresApproval` significa revisão humana de orientação, não aprovação já concedida.
O schema verifica IDs únicos e vínculos entre relatos, hipóteses e recomendações; categorias de evidência são tipadas separadamente. Nenhuma saída aqui é consumida pelo executor. Um integrador futuro precisará de contrato
separado para estado confiável/fresco, referência revisada, identidade, limites e
aprovação, passando por todos os controles existentes. Não transformar texto em Intent,
não disputar faders da UI oficial, não restaurar referência nem criar retry/replay.
Persistência/versões de referência e filas de pedidos ficam fora desta PR.

## Exemplos e critérios de segurança

- “Fred: minha voz está baixa no público”: papel lead conferido no cadastro, hipóteses de
  captação/balanço, inteligibilidade e relação com coro; nenhuma sugestão de forçar a voz.
- “Meu cavaco está estridente”: pedir destino e conferir captação antes de EQ.
- “Surdo embolando com tantã”: preservar as duas fontes e pedir qual examinar primeiro;
  não converter ressonância/mascaramento relatados em frequência medida.
- “Microfone dando microfonia”: conter exposição pelo operador, revisar caminho físico,
  padrões polares e microfones abertos. Sem frequência detectada por texto/fader.
- “Não me ouço”: relato de falta de monitoração, sem presumir mix individual do HA800.
- Pergunta sobre gain/phantom/AFS2: resposta informativa, sem mudança nem proposta.

Manual §5.3.1 descreve AFS2, Fixed e Live; MixAI não o controla. Ring-out é preparação
separada, supervisionada e sem público. Nenhum ensaio desta entrega provoca microfonia,
faz medição física ou conecta à mesa. Se houver apito persistente/desconforto, interromper
escuta/teste e chamar operador; rollback manual nunca restaura estado anterior inseguro.
Não alterar rede, firmware, phantom, ganho, HPF/EQ, AFS2 ou cenas por diagnóstico.

## Validação e pendências

Fixtures/testes locais cobrem sintomas novos, fontes combinadas/ambíguas, seis/sete
cordas, lead/coro, PA/AUX1, negação/pergunta, ausência de medição, offline, contratos
forjados e saída mutável. Integração HTTP/WS testa zero chamadas de IA, builder/execute,
pendência e escrita; pedido de aplicar ID de hipótese não encontra proposta. Mudança
externa simulada concorrente não é restaurada; leitura antiga segue explicitamente
não verificada. Políticas de operador/músico e sessão revogada continuam vigentes.

Resultados finais de typecheck/build, núcleo, interface, E2E, smoke Yoga e CI por SO
ficam no relatório do PR e no SHA final. Hardware/firmware, captação, equivalência de
processamento, escuta no ambiente e validação de perfis em ensaio permanecem **pendentes**.
Nenhum status de ensaio validado é obtido por teste simulado. Não é implementação E6.
