# Console MixAI — redesign da interface Angular (organização inspirada na Ui16)

PR de **integração com dependências explícitas** (rascunho). Esta branch (`feature/ui16-console-redesign`) parte da `main` (`4f221e6`, com #97–#104) e incorpora, por *merge commits rastreáveis*, três PRs de outros agentes que **ainda não estão na `main`**:

| Ordem | PR | Conteúdo | Branch |
|---|---|---|---|
| 1 | #105 | Correção de MUTE e edição de nomes/aliases | `fix/real-mute-sync-channel-settings` (`79dfaad`) |
| 2 | #106 | AUX SENDS com seis barramentos | `feature/aux-sends-six-buses` (`f3b6257`) |
| 3 | #107 | Painel EQ/HPF REAL somente leitura | `feature/ui16-live-eq-panel` (`ab249a8`) |

Nada dessas branches foi alterado. **Este PR não deve ser integrado antes dos três** (ou deve ser reavaliado depois que cada um for integrado: os merge commits desaparecem do diff). Sobreposições encontradas antes de editar: `views/mesa.component.ts` e `live-ux/live-channel.component.ts` (#106 × #107), `live.service.ts` (#105 × #106), `ui16-real-bridge.ts` (#105 × #107). Único conflito de texto: `mesa.component.ts` (lista de imports) — resolvido mantendo a lista do #106 e acrescentando `LiveEqComponent` do #107.

Somente apresentação: **nenhum contrato, serviço, gate, comando, protocolo ou estado novo.** Sem SETD, sem escrita física, sem segundo sistema de estado.

## O que mudou (somente `web/` e testes)

- **Navegação principal** (tablist, nesta ordem): **MIX / GAIN · EDIT · AUX SENDS · FX SENDS**. Substitui o seletor PA/AUX SENDS. No celular os rótulos visíveis ficam curtos (MIX, EDIT, AUX, FX); o nome acessível continua completo (`aria-label`).
- **MIX / GAIN**: strips estilo console — valor em dB (mostrador) acima do fader, **MUTE** e **SOLO** lado a lado (SOLO visível e **desabilitado**), fader SVG com trilho escuro, escala e botão metálico, **CH n** e nome na base, MASTER separado à direita (fader vermelho). O MUTE ficou menor/mais largo que alto mas mantém **altura mínima de 44 px** (acessibilidade/toque; há testes que exigem). Não há ganho de entrada: GAIN não foi apresentado como funcional.
- **EDIT**: abas **EQ** (selecionada ao abrir), DYN, FX SENDS e AUX SENDS (estas três **indisponíveis e desabilitadas**). A aba EQ **embute o painel do #107** (`mx-live-eq [embedded]`): gráfico calculado em destaque com **marcadores numerados das quatro bandas** posicionados por (frequência, ganho) observados, mostrador da banda selecionada (frequência/ganho/Q), cartões das 4 bandas, HPF, lâmpada de BYPASS, **abas de canal** na base e indicação de amostra antiga/indisponível herdada do #107. Somente leitura, sem `input`. O modal original continua acessível pelo botão “Abrir EQ/HPF REAL” do painel do canal (contrato do #107 preservado). Fora do REAL, a aba explica que o EQ físico só existe no REAL (o “EQ LAB” segue na faixa de estado).
- **AUX SENDS**: o mesmo padrão visual de MIX / GAIN; abas dos seis barramentos (amarelas) do #106; valores não observados continuam “Desconhecido”. PRE/POST e master AUX continuam indisponíveis.
- **FX SENDS**: apenas estrutura (FX 1–4 desabilitados e aviso “indisponível”). Nenhum valor ou comando.
- **Ferramentas** (botão na faixa de estado em telas ≥ tablet): menu com Assistente de IA, Diagnóstico (abre o assistente, somente consulta), Cenas, Histórico, Base de conhecimento (abre e rola até a seção) e Configurações e administração (diálogo existente). O assistente abre no **painel lateral** sem trocar de aba nem esconder a mesa. No celular o menu é omitido (as quatro ações da barra e “Configurações” já cobrem o acesso e o layout compacto é protegido por testes).
- Novo `ToolsService` (apenas sinal de UI, sem rede).

## O que depende dos PRs anteriores

- #106: seletor de seis barramentos e leituras por envio (a aba AUX SENDS).
- #107: serviço e componente de EQ (`LiveEqService`, `processing-view`), usados sem alteração de contrato; apenas o componente ganhou o modo `embedded` (host `region` em vez de `dialog`, sem foco automático, sem `Esc`/armadilha de foco).
- #105: cadastro de canais/AUX e correção de MUTE (aparece em Configurações).

## Pendências e limites

- **Validação na Ui16 física:** nenhuma. As capturas e testes usam LAB e socket falso; não houve escrita REAL, SETD nem conexão a hardware nesta entrega.
- A comparação com a Ui oficial é **visual** (organização e proporções); o MixAI não copia arte, ícones ou marcas da Soundcraft.
- Gráfico do EQ: estimativa RBJ a 48 kHz (como no #107), não resposta medida; o HPF é apenas marcador.
- Tablets pequenos/celulares: rolagem horizontal dos canais; “Ferramentas” oculto em telas estreitas.
- SOLO, GAIN, DYN, FX, PRE/POST e master AUX permanecem **não integrados** (indicados como indisponíveis).
- Testes antigos que usavam a aba “PA” foram atualizados para “MIX / GAIN” (mudança intencional da navegação); nenhuma expectativa de segurança, limite ou contrato foi relaxada.

## Capturas

`docs/ui16/console/{desktop,tablet}-{mix,assistente,aux,fx,edit-eq}.png` — geradas pelo E2E `test/e2e/console-redesign.test.ts` (Angular real; desktop 1440×900, tablet 1024×768).

## Testes

`web/src/app/views/console.spec.ts` (navegação, MIX/GAIN, SOLO, AUX, EDIT, FX, ferramentas, EQ embutido) e `test/e2e/console-redesign.test.ts` (LAB e REAL com socket injetado; zero SETD; capturas).
