# 03 — Plano de implementação do MixAI Lab

**Data:** 05/11/2026 · **Versão 2** (incorpora a revisão das decisões D1–D11) · Baseado em `01-GAP-ANALYSIS.md` e `02-ARCHITECTURE-REVIEW.md`.
**Status:** plano aprovado na direção geral. **Cada etapa só começa com autorização explícita.** O escopo exato da E0 está em `04-E0-ESCOPO.md`.

## Decisões aprovadas (revisão de 05/11/2026)

| # | Decisão | Situação | O que muda no plano |
| --- | --- | --- | --- |
| D1 | LAB e REAL isolados por processo | **aprovada** | E0 prepara (import dinâmico + teste de "sem rede"); E2 conclui |
| D2 | Servidor único, MCP como cliente | **aprovada** | E2 |
| D3 | JSON versionado | **aprovada com ajustes** | E1: escrita **atômica** (arquivo temporário + `rename`), **backup** da versão anterior (`.bak`) e **recuperação** automática do backup se o principal estiver corrompido |
| D4 | Autorização humana vinculada a uma operação | **aprovada** | E0: o servidor emite a pendência (`pendingId`, hash dos parâmetros, validade) e só executa por esse id. E2: a confirmação passa a vir da tela (canal humano) |
| D5 | Angular standalone com Signals | **aprovada** | E3 |
| D6 | Componentes SVG próprios | **aprovada** | E3 |
| D7 | PIN e dois perfis | **aprovada com ajustes** | E2: autorização **verificada no backend** em cada comando (o frontend só esconde botões, nunca decide) |
| D8 | Reconexão | **aprovada com revisão** | E0: solução definitiva investigada e comprovada por experimento (descartar a instância + ressincronizar), ver `04-E0-ESCOPO.md` §3 |
| D9 | Lab → Real só leitura | **aprovada temporariamente** | E1/E5: parâmetros e cenas estruturados para **aplicação controlada no futuro** (item a item, com compatibilidade e autorização) |
| D10 | Vosk / Whisper | **aprovada para experimentação** | E9: atrás de uma interface `SpeechRecognizer`, sem acoplamento direto |
| D11 | Primeira entrega visual = mesa web mínima | **aprovada** | E3 |

**Ordem de execução acordada:** commit inicial (feito: `ec7b861`) → 40 testes verdes (feito) → revisão da E0 (este documento + `04-E0-ESCOPO.md`) → testes de regressão → só então a implementação da E0. A correção da reconexão é validada **antes** de qualquer teste de queda de rede com a mesa física.

## Princípios do plano

- Cada etapa termina com os 40 testes atuais passando, mais os testes novos da etapa.
- Uma etapa = um conjunto pequeno de commits revisáveis. As tools MCP mantêm nomes e parâmetros.
- O que depende da mesa física fica atrás de *feature flag* e só é ligado depois do teste em hardware.
- Complexidade: **P** (até 1 dia de trabalho focado), **M** (2–3 dias), **G** (4+ dias).

## Visão geral

| Etapa | Entrega | Compl. | Depende de | Usa a mesa real? |
| --- | --- | --- | --- | --- |
| **F0** | Teste na mesa real (roteiro do README), sem código novo | P | mesa chegar | **sim** (supervisionado) |
| **E0** | Endurecer o núcleo | P/M | — | não |
| **E1** | Estado observável + `LabMixer` persistente | M | E0 | não |
| **E2** | Servidor único (HTTP + WS) e MCP como cliente | M | E1 | não |
| **E3** | **Mesa web mínima** (Angular): Mesa + Fones + banner | M/G | E2 | não |
| **E4** | Assistente: parser offline + cartões de proposta + Claude | M | E2, E3 | não |
| **E5** | Cenas do Lab e diff | M | E1, E3 | não |
| **E6** | Mesa real ao vivo: espelho, quarentena, medidores reais | M | F0, E2 | **sim** |
| **E7** | EQ Lab (curva + parâmetros) | M/G | E3 | não |
| **E8** | Comparação Lab × Real (só leitura) | M | E5, E6 | sim (leitura) |
| **E9** | Voz por comando (Vosk) | M | E4 | não |

Ordem sugerida: **F0** (sábado), **E0 → E1 → E2 → E3** (primeira entrega útil), depois **E4 → E5 → E6**, e o resto conforme o uso.

---

## F0 — Teste na mesa real

- **Objetivo:** provar que conectar, ler, mover um fader e desfazer funcionam na Ui16 de vocês.
- **Funcionalidades:** nenhuma nova. Usa o console (`npm run console`) com o roteiro do README.
- **Arquivos:** nenhum.
- **Dependências:** a mesa, um cabo de rede e o notebook.
- **Riscos:** firmware diferente do esperado pela biblioteca; IP diferente de 10.10.1.1.
- **Testes:**
  - sem PA nem fones ligados: `status`, `estado`, `desce voz 1`, `desfazer`;
  - conferir na interface oficial se o fader mexeu;
  - registrar a versão de firmware, o IP e quantos AUX aparecem.
- **Aceite:** fader e mute mudam na tela oficial; o desfazer volta; o log registra.
- **Extra recomendado:** desligar o cabo no meio, dar um comando, religar e confirmar que **nada** foi reenviado (valida o achado 4.1 em hardware).

## E0 — Correção e fortalecimento do núcleo

**Escopo exato, arquivos, testes e rollback: `04-E0-ESCOPO.md`.** Resumo:

- **Objetivo:** corrigir os riscos do gap analysis que já valem hoje, sem mudar o que o usuário vê.
- **Funcionalidades:**
  1. **Reconexão segura (D8):** descartar a instância da biblioteca na primeira queda, reconectar com uma instância nova, **ressincronizar obrigatoriamente** antes de aceitar comandos e classificar operações em andamento como **indeterminadas** até a ressincronização confirmar.
  2. **Fila única** de escrita + `applyChange()` único.
  3. **Revisões por parâmetro** e **desfazer pela revisão**; mudanças externas invalidam o desfazer conflitante.
  4. **Estados distintos:** valor desconhecido × canal em -∞ × conexão indisponível × ressincronizando, com códigos de erro estáveis.
  5. **Autorização vinculada (D4):** pendência com `pendingId`, hash dos parâmetros e validade de 60 s.
  6. AUX e canais restritos ao `channels.yaml`; `import()` dinâmico do `RealMixer`; parser extraído do console.
- **Aceite:** os 40 testes atuais continuam passando (com ajuste explícito apenas onde a confirmação mudou de formato), os testes novos passam, o simulador e o Claude Desktop seguem funcionando com as mesmas tools.

## E1 — Estado observável e `LabMixer`

> **Implementada** no branch `e1-lab-state`: detalhes, decisões e riscos em `05-E1-IMPLEMENTACAO.md`.

- **Objetivo:** ter uma única fonte de estado com eventos, persistente no Lab.
- **Funcionalidades:**
  - **Registro de parâmetros:** `ParamId`, `ParamSpec` (unidade, faixa, capacidade). **Desde já inclui EQ de 4 bandas** (`ch.N.eq.bK.freq|q|gain`), **HPF** (`ch.N.eq.hpf.freq|slope`) e **bypass** (`ch.N.eq.bypass`), com unidades e limites tirados da biblioteca 7.1.0 (freq 20–22050 Hz, Q 0,05–15, ganho ±20 dB, HPF 20–1000 Hz, slope 12/24/36). Esses parâmetros nascem com `capability: 'simulated_only'` e só são usados pela E7.
  - **Preparação para Lab → Real (D9):** cada `ParamSpec` diz se o parâmetro é **aplicável na mesa** (`library_verified`/`hardware_verified`); o diff entre dois estados é uma função genérica sobre `ParamId`, reutilizável por cenas, comparação e, no futuro, pela aplicação item a item.
  - **Persistência (D3):** escrita atômica (temporário + `rename`), `.bak` da versão anterior, recuperação do `.bak` se o principal estiver corrompido, e aviso no log.
  - **`MixerState`:** revisão global + `changedAt` por parâmetro; `unknown` diferente de -∞.
  - `MixerAdapter` ganha `snapshot()` e `subscribe(listener)`.
  - **`LabMixer`:**
    - 12 entradas, master e os AUX configurados;
    - grava `lab-state.json` (com `schemaVersion`) a cada mudança, com *debounce* de 500 ms;
    - lê o arquivo de volta na partida.
  - O `MockMixer` continua existindo, só para testes.
  - `mixState()` lê do snapshot, sem `currentValue()`.
- **Arquivos:** `src/mixer/types.ts`, `src/mixer/lab.ts` (novo), `src/mixer/mock.ts`, `src/core/state.ts` (novo), `src/core/params.ts` (novo), `src/core/controller.ts`, `data/` (pasta no `.gitignore`).
- **Dependências:** nenhuma.
- **Riscos:** o desenho do `ParamId` vai ser estendido em E7; manter o formato aberto.
- **Testes:**
  - revisão sempre crescente;
  - eventos na ordem;
  - persistência após "reiniciar";
  - arquivo corrompido gera estado padrão com aviso (sem travar);
  - migração de `schemaVersion` 1 é identidade.
- **Aceite:** comandos MCP no modo LAB alteram um estado que sobrevive à reinicialização; um assinante recebe todos os eventos.

## E2 — Servidor único e MCP como cliente

- **Objetivo:** um só processo dono da mesa, servindo a IA e as telas.
- **Funcionalidades:**
  - `mixai serve`: Fastify + WebSocket em `127.0.0.1` e no IP da rede da mesa, nas portas 8790 (LAB) / 8791 (REAL).
  - **WS:** `hello` → `snapshot` → `patch` com revisão; comandos com `requestId`. Ao detectar um buraco na sequência, o cliente pede outro snapshot.
  - **REST** mínimo (para o MCP): os mesmos verbos das tools.
  - **PIN da roda** e papéis *operador* / *músico* (músico só AUX 1). **Autorização verificada no backend** em cada comando (D7); o frontend apenas reflete o papel.
  - **Confirmação humana pela tela (D4):** pendências criadas pela IA aparecem como cartões, e só um cliente humano autenticado as confirma.
  - **Ação pendente:** `{pendingId, diff, expira}` e `confirm(pendingId)`.
  - **MCP stdio (`dist/index.js`) vira cliente HTTP:** se o servidor não estiver rodando, avisa e não abre a mesa sozinho.
  - Medidores (simulados no LAB, com o rótulo) num canal separado a 10–15 Hz.
- **Arquivos:** `src/server/*.ts` (novos), `src/mcp/server.ts`, `src/index.ts`, `package.json` (scripts).
- **Dependências:** `fastify` 5, `@fastify/websocket` (ou `ws` 8), MIT.
- **Riscos:**
  - Claude Desktop sem o servidor rodando → mensagem clara;
  - firewall do Windows pedindo permissão na primeira execução.
- **Testes:**
  - dois clientes WS recebem o mesmo patch;
  - um cliente músico não altera o master;
  - pendência expira;
  - confirmar duas vezes não aplica duas vezes;
  - as tools MCP passam pelo servidor;
  - LAB recusa um comando com `targetMode: REAL`.
- **Aceite:** com dois navegadores e o Claude Desktop ligados, uma mudança feita por qualquer um aparece nos outros.

## E3 — Mesa web mínima (primeira entrega útil)

- **Objetivo:** usar o MixAI pela tela do Yoga e pelo celular.
- **Funcionalidades:**
  - **Tela Mesa** (paisagem): 11 strips com nome, fader SVG, dB, mute e medidor; seletor **PA | FONES**; master separado com confirmação; botão Desfazer; painel de histórico.
  - **Tela Fones** (celular): lista com **− / +** de 2 dB, só AUX 1, cabeçalho "isto muda o fone de TODOS".
  - **Banner de modo** vindo do servidor (azul LAB / vermelho REAL / amarelo reconectando).
  - Tema escuro, alvos de 48 px, teclado (setas no fader focado).
- **Arquivos:** `web/` (projeto Angular standalone com signals). O build vai para `dist/web` e é servido pelo Fastify.
- **Dependências:** Angular 22 (mesma versão do testbed da biblioteca). Sem biblioteca de componentes: fader, knob e medidor em SVG próprios.
- **Riscos:**
  - arraste em touch no Windows (usar `pointer events` + `touch-action: none`);
  - tempo de build do Angular no ROG (aceitável).
- **Testes:**
  - unidade dos componentes (mapeamento dB ↔ posição do fader, inclusive -∞);
  - e2e com Playwright: dois navegadores sincronizados; troca PA↔FONES não muda valores; músico não vê o master;
  - verificação visual (captura) no tamanho do Yoga e de um celular.
- **Aceite:** no LAB, o Yoga e um celular na mesma rede mexem nos mesmos faders, e a tela volta ao estado certo ao recarregar.

## E4 — Assistente

- **Objetivo:** pedir em texto, offline para comandos diretos e com o Claude para pedidos vagos.
- **Funcionalidades:**
  - Campo de comando na Mesa e no celular.
  - **Parser** (de E0) amplia o vocabulário: "um pouco/mais/bastante", "no fone/no PA", "desfaz".
  - Toda interpretação vira um **cartão de proposta** com diff, e só aplica ao tocar em Aplicar (ou direto, para passos pequenos, se configurado).
  - Pedido que o parser não entende vai para o Claude (API) com as mesmas tools, e as ações voltam como pendências na tela.
  - Ao final: "melhorou?" grava o histórico de ajustes aprovados.
- **Arquivos:** `src/core/parser.ts`, `src/ai/*.ts` (novos), `src/server/*`, `web/src/app/assistant/*`.
- **Dependências:** `@anthropic-ai/sdk` (e chave de API no notebook).
- **Riscos:**
  - custo e latência da API;
  - sem internet → o parser continua funcionando e a interface informa que o modo IA está indisponível.
- **Testes:**
  - "mais surdo no fone" altera **só** `ch.9.aux.1.level`;
  - frase ambígua pergunta qual canal;
  - pedido de mesa real no LAB é recusado;
  - sem internet não trava a Mesa.
- **Aceite:** os critérios de L4 da especificação, com a pendência confirmada por humano.

## E5 — Cenas do Lab

- **Objetivo:** salvar e comparar configurações no formato do MixAI.
- **Funcionalidades:** salvar, duplicar, renomear e carregar cena (LAB); exportar e importar JSON com validação zod e `schemaVersion`; diff cena × estado atual.
- **Preparado para o futuro (D9):** a cena guarda `ParamId → valor` com o perfil do equipamento (`deviceProfile`) e o status de validação. Assim, quando autorizado, será possível listar itens compatíveis, incompatíveis e desconhecidos e aplicar **um item por vez** com autorização humana. A aplicação em si **não** faz parte desta etapa.
- **Arquivos:** `src/core/scenes.ts`, `data/scenes/*.json`, `web/src/app/scenes/*`.
- **Riscos:** confusão com os snapshots nativos da Ui16. Resolver nomeando claramente: "Cena do MixAI" ≠ "Snapshot da mesa".
- **Testes:** JSON inválido é recusado com mensagem; o diff lista só o que mudou; carregar uma cena no LAB entra no desfazer como um item.
- **Aceite:** exportar no ROG, importar no Yoga e o estado bate.

## E6 — Mesa real ao vivo

- **Objetivo:** a mesma interface operando a Ui16, com proteção de reconexão e medidores reais.
- **Funcionalidades:**
  - `RealMixer` com espelho de `store.state$` (traduzindo caminho ↔ `ParamId`), com eventos `external`;
  - **quarentena após reconexão**;
  - medidores via `vuProcessor`;
  - spike opcional: recriar a instância em vez de usar a reconexão automática.
- **Arquivos:** `src/mixer/real.ts`, `src/mixer/protocol-map.ts` (novo).
- **Dependências:** F0 concluída.
- **Riscos:** caminhos do protocolo diferentes no firmware de vocês; diferença de 4 × 6 AUX.
- **Testes:**
  - WebSocket falso: mudança externa vira evento;
  - nenhum comando atravessa a reconexão;
  - a quarentena libera só depois do estado completo;
  - **em hardware**, supervisionado, com um canal de teste e PA/fones desligados.
- **Aceite:** mexer no tablet oficial da mesa reflete no MixAI, e puxar o cabo não gera comando fantasma.

## E7 — EQ Lab

- **Objetivo:** aprender e preparar EQ/HPF com uma curva visual honesta.
- **Funcionalidades:**
  - parâmetros `eq.b1..b4` (freq, Q, ganho) e `hpf` (freq, slope) com as faixas da biblioteca;
  - curva de magnitude calculada por fórmulas RBJ em TS (testável) e conferida com `getFrequencyResponse`;
  - bandas arrastáveis, bypass, reset;
  - presets por fonte com `status` e justificativa;
  - selo "SIMULADO — só laboratório";
  - tool `propose_eq` (LAB).
- **Riscos:** formato real dos filtros da Ui16 desconhecido. A curva é aproximação, e precisa estar escrito na tela.
- **Testes:**
  - ganho 0 dB gera curva plana;
  - pico na frequência central igual ao ganho;
  - HPF -3 dB perto da frequência de corte;
  - valores fora da faixa recusados.
- **Aceite:** os critérios de L3 da especificação, **sem envio de EQ para a mesa real** até verificar em hardware.

## E8 — Comparação Lab × Real (só leitura)

- **Objetivo:** ver o que difere entre a cena preparada e a mesa, sem aplicar nada.
- **Funcionalidades:** diff com itens iguais, diferentes, sem suporte e desconhecidos; exportar o diff como checklist.
- **Aceite:** o diff aparece sem nenhuma escrita na mesa (teste verifica zero `SETD`).

## E9 — Voz por comando

- **Objetivo:** "segure e fale" no celular para comandos diretos.
- **Funcionalidades:** áudio do celular → notebook → reconhecedor → parser → cartão de proposta. O reconhecedor fica atrás de uma interface `SpeechRecognizer` (D10), com implementações experimentais para Vosk (`small-pt`, gramática restrita) e whisper.cpp, comparadas num ensaio antes de escolher.
- **Riscos:** ruído da roda; precisão em português; binding nativo no Windows.
- **Aceite:** 9 em cada 10 comandos do vocabulário entendidos num ensaio, e nenhuma ação sem confirmação visual.

---

## Histórico das decisões (proposta original, v1)

As decisões foram aprovadas em 05/11/2026 (tabela no início do documento). A recomendação original da D8 era "(a) portão + quarentena agora, (b) avaliar depois". **Ela foi revista:** o experimento de 05/11 mostrou que só o portão não basta (há operações que se perdem em silêncio na janela da queda) e que descartar a instância funciona. A v2 adota a combinação descrita em `04-E0-ESCOPO.md` §3.

## O que eu NÃO implementaria agora

| Item | Por quê |
| --- | --- |
| Simular compressor, gate, de-esser, GEQ 31 bandas, AFS | a biblioteca **não expõe** esses parâmetros; o que se configurasse no Lab nunca chegaria à mesa |
| RTA ou "detecção de microfonia" | não há fonte de dados real; qualquer número seria inventado |
| Aplicação Lab → Real (qualquer forma) | adiada, **não descartada** (D9): a estrutura de parâmetros e cenas já nasce pronta para aplicação item a item com autorização humana |
| Autenticação com contas e papéis detalhados | uma roda de amigos não precisa; PIN resolve |
| SQLite e migrations | volume de dados minúsculo |
| PWA com service worker / offline | o app já é servido pelo notebook na mesma rede |
| A/B com áudio e Web Audio no MVP | bom pra aprender, mas não ajuda a roda a soar melhor no curto prazo; entra depois de E7 |
| Mix individual por músico | o HA800 recebe uma única mix; a interface nunca deve sugerir o contrário |
| Ganho e phantom pela IA (inclusive leitura na primeira versão) | risco de estouro e de dano; operação manual |
| Suporte a Ui12/Ui24R | não há mesa para testar |
| Escuta contínua de voz | risco de letra virar comando; só push-to-talk |
| Formalizar p95 < 300 ms como critério | medir uma vez em E3; transformar em *gate* não vale o custo |

## Próximo passo

1. Revisar e aprovar o escopo da E0 em `04-E0-ESCOPO.md`.
2. Implementar a E0 no branch `e0-nucleo`, com revisão cruzada antes do merge.
3. Fazer o **F0** quando a mesa chegar, incluindo o teste de queda de rede **depois** da E0 aprovada.
