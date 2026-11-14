# Console MixAI — redesign da interface Angular (organização inspirada na Ui16)

Redesign **exclusivamente visual**, em branch limpa sobre a `main` que já contém os PRs #105 (MUTE e cadastro de canais), #106 (AUX SENDS com seis barramentos) e #107 (painel EQ/HPF somente leitura). Nenhum merge das branches antigas; backend, protocolo, gates e contratos permanecem os da `main`.

Somente apresentação: **nenhum contrato, serviço, gate, comando, protocolo ou estado novo.** Sem SETD, sem escrita física, sem segundo sistema de estado.

## O que mudou (somente `web/` e testes)

- **Navegação principal** (tablist, nesta ordem): **MIX / GAIN · EDIT · AUX SENDS · FX SENDS**. Substitui o seletor PA/AUX SENDS. No celular os rótulos visíveis ficam curtos (MIX, EDIT, AUX, FX); o nome acessível continua completo (`aria-label`).
- **MIX / GAIN**: strips estilo console — valor em dB (mostrador) acima do fader, **MUTE** e **SOLO** lado a lado (SOLO visível e **desabilitado**), fader SVG com trilho escuro, escala e botão metálico, **CH n** e nome na base, MASTER separado à direita (fader vermelho). O MUTE ficou menor/mais largo que alto mas mantém **altura mínima de 44 px** (acessibilidade/toque; há testes que exigem). Não há ganho de entrada: GAIN não foi apresentado como funcional.
- **EDIT**: abas **EQ** (selecionada ao abrir), DYN, FX SENDS e AUX SENDS (estas três **indisponíveis e desabilitadas**). A aba EQ **embute o painel do #107** (`mx-live-eq [embedded]`): gráfico calculado em destaque com **marcadores numerados das quatro bandas** posicionados por (frequência, ganho) observados, mostrador da banda selecionada (frequência/ganho/Q), cartões das 4 bandas, HPF, lâmpada de BYPASS, **abas de canal** na base e indicação de amostra antiga/indisponível herdada do #107. Somente leitura, sem `input`. O modal original continua acessível pelo botão “Abrir EQ/HPF REAL” do painel do canal (contrato do #107 preservado). Fora do REAL, a aba explica que o EQ físico só existe no REAL (o “EQ LAB” segue na faixa de estado).
- **AUX SENDS**: o mesmo padrão visual de MIX / GAIN; abas dos seis barramentos (amarelas) do #106; valores não observados continuam “Desconhecido”. PRE/POST e master AUX continuam indisponíveis.
- **FX SENDS**: apenas estrutura (FX 1–4 desabilitados e aviso “indisponível”). Nenhum valor ou comando.
- **Ferramentas**: menu com Assistente de IA, Diagnóstico (abre o assistente, somente consulta), Cenas, Histórico, Base de conhecimento (abre e rola até a seção) e Configurações e administração (diálogo existente). Em telas largas o botão fica na faixa de estado; **no celular (retrato e deitado) um botão ☰ compacto fica na linha “Referência e pedidos”**, fora da barra compacta, e abre o mesmo menu (alvos ≥ 44 px). O assistente abre no **painel lateral** sem trocar de aba nem esconder a mesa.
- Novo `ToolsService` (apenas sinal de UI, sem rede).

## Dependências

#105, #106 e #107 já estão na `main`; o redesign reutiliza sem alterar contrato o seletor AUX (#106), o `LiveEqService`/`processing-view` (#107) e o cadastro de canais (#105). Apenas o componente de EQ ganhou o modo `embedded` (host `region`, sem foco automático nem `Esc`/armadilha de foco).

## Pendências e limites

- **Validação na Ui16 física:** nenhuma. As capturas e testes usam LAB e socket falso; não houve escrita REAL, SETD nem conexão a hardware nesta entrega.
- A comparação com a Ui oficial é **visual** (organização e proporções); o MixAI não copia arte, ícones ou marcas da Soundcraft.
- Gráfico do EQ: estimativa RBJ a 48 kHz (como no #107), não resposta medida; o HPF é apenas marcador.
- Celulares: rolagem horizontal dos canais; rótulos curtos nas abas (nome acessível completo).
- SOLO, GAIN, DYN, FX, PRE/POST e master AUX permanecem **não integrados** (indicados como indisponíveis).
- Testes antigos que usavam a aba “PA” foram atualizados para “MIX / GAIN” (mudança intencional da navegação); nenhuma expectativa de segurança, limite ou contrato foi relaxada.

## Capturas

`docs/ui16/console/{desktop,tablet}-{mix,assistente,aux,fx,edit-eq}.png` — geradas pelo E2E `test/e2e/console-redesign.test.ts` (Angular real; desktop 1440×900, tablet 1024×768).

## Testes

`web/src/app/views/console.spec.ts` (navegação, MIX/GAIN, SOLO, AUX, EDIT, FX, ferramentas, EQ embutido) e `test/e2e/console-redesign.test.ts` (LAB e REAL com socket injetado; zero SETD; capturas).
