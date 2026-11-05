# 02 — Revisão de arquitetura do MixAI Lab

**Data:** 05/11/2026 · Complementa o `01-GAP-ANALYSIS.md`. Só análise e recomendação.

## Veredito

A especificação acerta nos princípios: honestidade sobre o que é simulado, AUX compartilhado explícito, IA sem acesso direto à mesa, nada de reenvio após reconexão. Mas ela **dimensiona o sistema como um produto multiusuário corporativo** (autenticação com papéis, SQLite com migrations, idempotência, revisões em propostas da IA, lote Lab→Real, PWA offline), quando o uso real é **uma banda amadora, um notebook e meia dúzia de celulares numa roda**.

Minha recomendação é manter os princípios e cortar pela metade a máquina em volta deles. Seis decisões resumem a proposta:

1. **Modo fixado por processo.** O backend sobe como LAB *ou* REAL e não troca de modo em tempo de execução. O isolamento passa a ser estrutural, sem depender de uma flag em cada comando.
2. **Um único backend dono da mesa.** O MCP do Claude Desktop vira cliente desse backend e deixa de controlar a mesa por conta própria.
3. **Espelho de estado + eventos + fila única de comandos** dentro do `MixController`.
4. **Confirmação humana fora do canal da IA.** A IA *propõe*, e a pessoa confirma na tela ou no chat. O servidor emite e confere o token.
5. **JSON versionado em arquivo, não SQLite.**
6. **O caminho "preparar em casa → usar na roda" passa pelos snapshots da própria Ui16, não por um aplicador de lote Lab→Real.**

---

## 1. Separação entre Lab e mesa real

**Proposta da especificação:** `targetMode` em cada comando, banner, recusa de fallback para REAL, teste de que o LAB não abre socket.

**Problema:** se o mesmo processo conhece as duas mesas e decide por comando, **cada caminho de código vira um ponto de falha**: um default errado, um parâmetro esquecido, uma reconexão. A proteção fica tão forte quanto o comando mais descuidado.

**Recomendação: isolamento por processo.**

| Aspecto | Proposta da especificação | Recomendado |
| --- | --- | --- |
| Onde se decide LAB × REAL | em cada `CommandProposal.targetMode` | **na partida do processo** (`MIXAI_MODE`), uma única vez |
| Troca de modo | pela interface, com confirmação | **reiniciar o backend** em outro modo (botão "Ir para a mesa real" chama um script, com confirmação forte) |
| Código da mesa real no LAB | instanciado, mas não chamado | **nem importado**: `import()` dinâmico dentro da fábrica, só quando `mode === 'real'` |
| Prova | teste de que não chama `RealMixer` | teste que **substitui o `WebSocket` global e `net.connect` por espiões** e falha se forem usados no modo LAB, mais um teste de que o módulo `real.js` não aparece no grafo de módulos carregados |
| Rodar os dois ao mesmo tempo | não abordado | **portas diferentes** (ex.: LAB 8790, REAL 8791), com a cor do banner vinda do servidor |

O `targetMode` ainda pode existir nos comandos, como **asserção**: o servidor recusa um comando cujo `targetMode` não seja igual ao seu próprio modo. Ele não serve pra rotear nada.

Alternativa considerada e **descartada para produção**: emular a Ui16 no nível do protocolo (um servidor WebSocket falando `SETD^...`) e apontar o `RealMixer` pra ele. Isso dá a máxima fidelidade de código, mas usa a mesma classe da mesa real, e um IP errado vira desastre. Fica restrito aos **testes**, onde já existe (o WebSocket falso em `real-adapter.test.ts`).

## 2. Compartilhamento de regras de negócio

O `MixController` já é o lugar certo. A especificação acerta ao dizer "UI e MCP chamam a mesma regra". O que falta:

- **Um único ponto de escrita:** `applyChange(change, actor)`, usado por `setLevel`, `setMute`, `setMaster`, `undo` e, no futuro, `setEq`. Aplica, nesta ordem: validação → teto/passo → confirmação → fila → escrita → revisão → desfazer → log → evento.
- **O frontend não duplica regra nenhuma.** Ele só mostra o que o servidor confirmou. O fader pode andar de forma otimista na tela, mas volta ao valor do servidor se for recusado.

## 3. Modelo de estado (pergunta 3)

Comparei três representações:

| Opção | Como é | Prós | Contras |
| --- | --- | --- | --- |
| A. Mapa plano de caminhos do protocolo (`i.0.mix`, `i.0.aux.0.value`) | igual ao `store.state$` da biblioteca | zero tradução na mesa real; diff trivial | acopla o domínio ao protocolo não oficial; valores lineares 0–1, não dB |
| B. Objeto semântico (`channels[3].main.levelDB`) | domínio puro | legível, validável, independente da mesa | o diff e os eventos precisam de código |
| **C. Semântico com registro de parâmetros** (recomendado) | `ParamId` tipado, ex. `ch.3.main.level`, cada um com unidade, faixa, origem da capacidade e revisão | diff, eventos, validação e matriz de capacidades saem do mesmo registro | um pouco mais de estrutura inicial |

Na opção C, o adaptador real traduz `ParamId ↔ caminho do protocolo` num único arquivo, que é o único lugar onde o protocolo aparece. Esboço (referência de desenho, não código pronto):

```ts
type ParamId = `ch.${number}.main.level` | `ch.${number}.main.mute`
             | `ch.${number}.aux.${number}.level` | `ch.${number}.aux.${number}.mute`
             | `ch.${number}.eq.b${1|2|3|4}.${'freq'|'q'|'gain'}` | `ch.${number}.eq.hpf.freq`
             | `master.level`;

interface ParamSpec { id: ParamId; unit: 'dB'|'Hz'|'Q'|'bool'; min?: number; max?: number;
                      capability: 'library_verified'|'hardware_verified'|'simulated_only'; }

interface MixerState {
  schemaVersion: 1;
  mode: 'LAB' | 'REAL';
  revision: number;                       // global, monotônica: ordena os eventos
  values: Record<ParamId, number | boolean | null>;   // null = -∞ ou desconhecido (ver abaixo)
  changedAt: Record<ParamId, number>;     // revisão da última mudança de cada parâmetro
}
```

- **Revisão:** uma **global** pra ordenar os eventos, mais a **revisão por parâmetro** pra detectar conflito no desfazer. Isso responde ao ponto em aberto da especificação: as duas, cada uma pra um uso.
- **-∞ em JSON:** representar como `{"db": null, "off": true}` ou como a string `"-inf"`, nunca como número. O MixAI já usa `"-inf"` no log, então é melhor manter um único padrão.
- **Desconhecido ≠ -∞:** um parâmetro que a mesa ainda não mandou é `unknown`, não zero nem -∞. Isso corrige o problema 4.2 do gap analysis.

## 4. Sincronização via WebSocket

- **Servidor → clientes:** um snapshot completo ao conectar, depois *patches* `{revision, changes:[{id, value, actor}]}`. Se o cliente perceber um buraco na sequência de revisões, pede outro snapshot. Isso basta, sem necessidade de CRDT ou mecanismo parecido.
- **Mesa real → servidor:** assinar `store.state$` da biblioteca **uma vez**. Assim, mudanças feitas na interface oficial (por exemplo, alguém mexendo no tablet da mesa) aparecem como eventos com `actor: 'external'`.
- **Medidores:** usar um canal separado com taxa limitada (10–15 por segundo), sem revisão e sem log. Medidor não é estado.
- **Transporte:** WebSocket nos dois sentidos. SSE + POST funciona, mas o fader arrastado fica mais natural em WS.

## 5. Estado no frontend

Angular com **signals**, sem NgRx. Um `MixerStore` de serviço guarda o snapshot e aplica os patches, e os componentes leem *signals* derivados. O estado é pequeno (algumas centenas de parâmetros) e tem uma única fonte de verdade no servidor, então NgRx seria cerimônia sem benefício.

## 6. Concorrência e execução sequencial

- **Fila única** (mutex assíncrono) no `MixController`. Todo comando de escrita entra nela, de modo que as etapas de leitura, cálculo e escrita ficam atômicas do ponto de vista do MixAI. Isso resolve o problema 4.3.
- **Arraste de fader:** o cliente manda no máximo ~20 a 30 mensagens por segundo, e o servidor junta (*coalesce*) os valores enquanto a fila estiver ocupada. O limite atual de "5 comandos por segundo" vale para **comandos discretos** (IA e botões), não para arraste. Por isso o arraste conta como um único comando no desfazer e no limite.
- **Ordem na mesa:** a biblioteca envia em ordem pelo mesmo socket, então não há reordenação depois da fila.

## 7. Segurança, confirmação e desfazer

| Tema | Especificação | Recomendado |
| --- | --- | --- |
| Confirmação | `requestId` + `expectedRevision` na proposta da IA | **Ação pendente emitida pelo servidor**: `{pendingId, diff, expiraEm: 60 s, hash dos parâmetros}`. Só é executada por `confirm(pendingId)` vindo de um **humano**: botão na tela, ou resposta do usuário no chat. A IA nunca confirma sozinha. |
| A IA guarda revisões? | sim (`expectedRevision`) | **não**: a IA não deve gerenciar concorrência; o servidor confere ao executar a pendência |
| Desfazer | optimistic concurrency | ao desfazer, conferir se `changedAt[param]` ainda é a revisão da própria ação. Se não for, **recusar aquele item** e mostrar quem mexeu depois. O desfazer passa por teto e limite como qualquer comando. |
| Papéis | auth com roles | **PIN da roda** (um código curto mostrado na tela do notebook) e dois papéis: *operador* (tudo) e *músico* (só AUX 1 = Fones, mais pedidos à IA). Sem cadastro e sem senha individual. |
| Exposição na LAN | CORS e controle | servidor ouvindo só na interface da rede da mesa, sem CORS aberto, PIN obrigatório para WS |

## 8. Reconexão sem executar comandos antigos

Por causa do achado 4.1 (a biblioteca reenvia), três camadas:

1. **Portão no adaptador:** `RealMixer` checa `conn.status === OPEN` **imediatamente antes** de chamar a biblioteca, além do que o controlador já faz.
2. **Quarentena após reconexão:** depois de `RECONNECTING → OPEN`, o controlador entra no estado `resyncing`, recusa comandos, espera o estado completo chegar por `store.state$` e só então reabre. Os clientes recebem um snapshot novo.
3. **Teste dedicado:** reproduzir o experimento do gap analysis dentro da suíte, verificando que **nenhum** comando atravessa a reconexão.

Alternativa mais forte, a avaliar num spike: no `RECONNECTING`, **descartar a instância** de `SoundcraftUI` e criar outra limpa, sem a reconexão automática da biblioteca. Isso elimina o buffer, ao custo de controlar a reconexão manualmente.

## 9. Compatibilidade com o MCP

Hoje o Claude Desktop inicia `dist/index.js` por stdio, e esse processo é dono da mesa. Quando existir o servidor web, haveria **dois donos**.

**Recomendado:** `mixai serve` vira o processo único, com mesa, controlador, HTTP e WS. O `dist/index.js` do MCP vira um **cliente fino**: cada tool chama a API local (`http://127.0.0.1:8790`). Vantagens:

- as mesmas regras, fila e log para a IA e a interface;
- as ações da IA aparecem em tempo real na tela;
- as confirmações da IA podem ir para a tela (a pendência aparece como um cartão).

As tools continuam com os mesmos nomes e parâmetros, então não há quebra para o Claude Desktop. Os testes atuais de MCP passam a usar o servidor em modo LAB.

## 10. Funcionamento offline

- **Sem internet, tudo menos o Claude funciona:** faders, cenas, parser determinístico e, no futuro, a voz local.
- O PWA com *service worker* **não é necessário**, porque o frontend é servido pelo próprio notebook. Basta o app em cache do navegador. Instalar como PWA é opcional, só pelo ícone na tela.
- A especificação já reconhece que PWA não conecta à mesa sem a rede local. Concordo e simplifico: **sem service worker na primeira versão**.

## 11. Desempenho no Lenovo Yoga 7

- Backend Node + biblioteca: carga desprezível (algumas mensagens por segundo).
- Frontend: 11 faders + 11 medidores. Desenhar em **SVG/CSS**, com medidores a ~15 fps e `requestAnimationFrame`. É confortável em qualquer notebook atual.
- O que pesa: Whisper (`small`, ~850 MB de RAM, latência de segundos na CPU) e Web Audio com vários arquivos ao mesmo tempo. Os dois ficam **fora do caminho crítico**.
- Bateria: no evento, deixar na tomada (já recomendado).

## 12. Inteligência artificial

| Camada | Quem resolve | Exemplos |
| --- | --- | --- |
| 1. Comando direto | **parser determinístico**, offline | "mais Fred no fone", "muta o surdo", "desfaz", "voz 2 -3" |
| 2. Linguagem natural | Claude via tools | "a voz do Leandro tá sumindo no fone", "tá tudo muito alto" |
| 3. Diagnóstico | Claude + skill + dados reais | "tá embolado" → pergunta sobre a fonte → propõe HPF/EQ (Lab) → mede pelo VU (real) |

- **Parser:** extrair de `console.ts` e aumentar o vocabulário (um pouco, mais, bastante; "no fone", "no PA"). A resposta mostra a ação **antes** de executar, com o valor padrão visível (por exemplo, "+2 dB no AUX 1 Fones, que todos ouvem").
- **Tools:** manter as 11, acrescentar `propose_eq` (só no LAB, até haver verificação) e `get_meters` (só na mesa real, depois da validação). Todas as ações críticas passam a retornar `pendingId`.
- **Skill samba/pagode:** um arquivo de conhecimento com fundamentos e um dicionário de queixas vagas ("embolado", "magro", "estridente", "sumindo") ligadas a ações. Fica em **dados**, não em prompt espalhado.
- **Presets por instrumento:** JSON com `status: 'não validado' | 'validado em ensaio'`, data, local e quem validou. Sempre como ponto de partida.
- **Histórico de ajustes aprovados:** quando alguém responde "melhorou", grava `{queixa, ação, contexto}`. Na próxima vez, o agente sugere primeiro o que já funcionou.
- **Análise de áudio futura:** o VU real da biblioteca (pre, post, pós-fader) já permite detectar **clipping, canal mudo e canal muito mais alto que os outros**. Detectar microfonia ou frequência exigiria RTA, que a biblioteca **não expõe**. Isso fica para depois, e apenas se houver fonte de dados real.

## 13. Interface e experiência de uso

### Três opções

| Opção | Telas | Esforço | Para quem |
| --- | --- | --- | --- |
| **Mínima** | Mesa (11 faders, PA/FONES) + barra de comando por texto | P | operador no notebook |
| **Equilibrada** (recomendada) | Mesa · Fones (versão para celular) · Assistente · Cenas · Histórico; EQ em modo só de visualização | M | operador + músicos pelo celular |
| **Avançada** | tudo da equilibrada + EQ Lab interativo, A/B com áudio, comparação Lab×Real | G | depois da validação na mesa |

### Telas (opção equilibrada)

1. **Mesa (notebook, paisagem):**
   - faixa horizontal com 11 *strips*, cada um com nome grande, fader vertical, valor em dB, mute e medidor;
   - **seletor grande PA | FONES** no topo;
   - no modo FONES, a tela inteira muda de cor e aparece o selo "**AUX 1 — todos ouvem**";
   - master à direita, separado, com trava.
2. **Fones (celular, retrato):** lista vertical com os 11 canais e botões **− / +** (passo de 2 dB), sem fader de arraste, o que evita mudança acidental. Só mexe no AUX 1. Cabeçalho fixo: "isto muda o fone de TODOS".
3. **Assistente:** chat com histórico. Cada proposta aparece como um cartão com diff (antes → depois), botões **Aplicar / Cancelar** e um "Desfazer" depois de aplicada.
4. **Cenas:** salvar, duplicar, renomear, exportar/importar JSON do MixAI; diff entre cena e estado atual. Em modo REAL, **só comparação**.
5. **Histórico:** linha do tempo com quem, o quê e quando, e desfazer item a item (com conflito sinalizado).
6. *(Avançada)* **Canal / EQ:** curva de magnitude com eixo de frequência logarítmico, bandas arrastáveis, HPF, bypass e um selo "SIMULADO — só laboratório" enquanto não houver verificação.

### Regras visuais

- Tema escuro, contraste AA, alvos de toque de 48 px ou mais, valores numéricos sempre visíveis.
- **Banner de modo permanente**, vindo do servidor: azul "LABORATÓRIO — sem conexão com a mesa" ou vermelho "MESA REAL — alterações ao vivo".
- Medidores simulados com hachura e o rótulo "SIMULADO".
- Mudança de PA para FONES nunca acontece por gesto de arraste, só por toque no seletor.

### Fluxos principais

- **Músico pede no celular:** `+` no Fred em Fones → aplica direto (passo ≤ 6 dB) → todos os clientes recebem o patch → aparece no histórico com o nome do aparelho.
- **Pedido vago:** "tá embolado" → o assistente pergunta qual fonte → propõe a menor mudança → cartão com diff → humano aplica → o assistente pergunta "melhorou?" → a resposta vai para o histórico aprovado.
- **Queda da mesa:** o banner fica amarelo ("reconectando"), os controles ficam bloqueados, chega um snapshot novo e os controles são liberados. Nenhum comando antigo é reenviado.

## 14. Bibliotecas e projetos avaliados

| Alternativa | Licença | Manutenção | Uso no MixAI | Vantagens | Limitações | Recomendação |
| --- | --- | --- | --- | --- | --- | --- |
| `soundcraft-ui-connection` 7.1.0 | MIT | ativa (commit em 03/11/2026) | protocolo da Ui16 | já em uso, tipada, cobre EQ/HPF/VU/shows | protocolo não oficial; reenvio na reconexão (4.1) | **manter, versão fixada** |
| Testbed do mesmo repositório (Angular 22) | MIT | ativa | referência | mostra o uso de cada API | UI de depuração, não simula nada | **só referência** |
| Bitfocus Companion, módulo Soundcraft Ui | MIT | último push em 01/2025 | nenhum | prova de uso da biblioteca em produção | serve para Stream Deck, não para o nosso caso | não usar |
| Servidor MCP pronto para Soundcraft | — | **não encontrei** | — | — | — | o nosso é necessário |
| `webaudio-controls` (g200kg) | Apache-2.0 | último push em 05/2023 | knobs e sliders como Web Components | funciona em Angular, tem toque | estética "plugin", parada desde 2023 | opcional; prefiro SVG próprio |
| `@angular-slider/ngx-slider` 22.0 | MIT | ativa (06/2026) | sliders | compatível com Angular 22 | slider horizontal genérico, não é fader de mesa | não usar para fader |
| **Componentes SVG próprios** (fader, knob, medidor) | nossa | — | strips | controle total do toque e do visual; ~150 linhas cada | precisa escrever | **recomendado** |
| `web-audio-peak-meter` 3.1 | MIT | parada desde 2023 | medidor de áudio local | simples | mede `AudioNode`, não dados da mesa | só no preview de áudio do Lab |
| **Web Audio API** (`BiquadFilterNode`, `getFrequencyResponse`) | nativa | — | curva de EQ e preview audível | sem dependência; mesmos tipos de filtro (peaking, highpass) | não é o DSP da Ui16 (formato de Q e inclinações podem diferir) | **recomendado**, com aviso de aproximação |
| Fórmulas RBJ (Audio EQ Cookbook) em TS | domínio público | — | curva calculada no servidor e nos testes | testável no Node, sem navegador | idem | **recomendado** junto com o Web Audio |
| Fastify 5 + `@fastify/websocket` (ou `ws` 8) | MIT | ativa | servidor HTTP/WS | leve, tipado, maduro | — | **recomendado** |
| Vosk (`vosk-model-small-pt-0.3`, 31 MB) | Apache-2.0 | o modelo PT é antigo | voz offline | leve; **aceita gramática restrita**, ótimo pra comandos | precisão menor em fala livre; o binding Node é nativo | **recomendado para comandos de voz** (Fase 4) |
| whisper.cpp (`base` 142 MB / `small` 466 MB) | MIT | ativa | voz offline | ótima qualidade em PT | mais pesado; latência de segundos na CPU | alternativa para fala livre |
| Transformers.js (Whisper no navegador) | Apache-2.0 | ativa | voz no celular | roda no cliente | pesado para celular comum | não agora |
| Web Speech API do navegador | — | — | voz | zero instalação | no Chrome, depende de internet e de serviço externo | não, por privacidade e por ser offline |
| FAUST + McpUI | GPL/variável | protótipo | — | expõe DSP via MCP | outro domínio (DSP próprio) | não usar |

**Conclusão (pergunta 8):** nenhuma biblioteca elimina boa parte do trabalho de *interface*. O que já elimina trabalho é o **protocolo** (`soundcraft-ui-connection`) e a **matemática de EQ** (Web Audio e as fórmulas RBJ). Os componentes de mesa valem a pena escrever, porque são poucos e precisam ser excelentes no toque.

---

## 15. Respostas às 10 perguntas

1. **O MixAI está arquiteturalmente preparado para o Lab?**
   Parcialmente. Interface de adaptador, regras centralizadas e escolha de modo na partida são a base certa. Faltam estado observável, eventos, fila de comandos, desfazer com conflito e um processo único dono da mesa.
2. **O `MockMixer` basta?**
   Não. Ele é um *dublê de teste*, sem persistência, sem eventos, sem EQ e sem revisões. Recomendo mantê-lo como dublê nos testes e criar um `LabMixer` separado, com estado persistente, registro de parâmetros e eventos. Os dois implementam o mesmo `MixerAdapter` ampliado.
3. **Melhor forma de representar os parâmetros?**
   Modelo semântico com registro tipado (`ParamId` + `ParamSpec` com unidade, faixa e origem da capacidade), revisão global mais revisão por parâmetro, e tradução para o protocolo isolada no adaptador real (seção 3).
4. **Dá pra ouvir a EQ em arquivos de áudio?**
   Sim, como **aproximação**: Web Audio API com `BiquadFilterNode` (peaking e highpass) sobre gravações da própria banda. Dois cuidados:
   - **Não é o DSP da Ui16:** o formato de Q e as inclinações podem diferir.
   - **A Ui16 grava só 2 canais (estéreo) no USB:** a biblioteca marca a Ui16 como sem gravação multipista. Pra ouvir cada instrumento separado, é preciso gravar as fontes à parte (por exemplo, pelo celular) ou usar loops licenciados.
5. **O mesmo frontend serve para Lab e mesa real?**
   Sim, e deve. O modo vem do servidor e muda só o banner e as permissões. Funções sem suporte verificado aparecem desabilitadas no modo REAL.
6. **Como garantir que o Lab nunca envia à mesa?**
   Isolamento por processo (seção 1):
   - o modo é fixado na partida;
   - o código da mesa real não é importado no LAB;
   - um teste espiona `WebSocket` e `net.connect`;
   - o banner vem do servidor;
   - o `targetMode` funciona como asserção.
7. **Como comparar virtual × real sem risco?**
   - A comparação é **somente leitura**: lê o espelho do estado real e calcula o diff contra a cena do Lab.
   - Qualquer aplicação passa a ser item a item, com confirmação humana e no processo REAL.
   - Para a primeira versão, recomendo **não aplicar nada a partir do Lab**: usar o diff como lista de ajustes manuais e salvar o resultado como snapshot **na própria Ui16**.
8. **Alguma biblioteca elimina parte significativa do trabalho?**
   Só no protocolo (já em uso) e na matemática de EQ (Web Audio e RBJ). Na UI, não (seção 14).
9. **O que é desnecessário ou complexo demais na especificação?**
   - Autenticação com papéis → PIN + dois papéis.
   - SQLite e migrations → JSON versionado.
   - `expectedRevision` e idempotência em propostas da IA → pendência emitida pelo servidor.
   - Lote Lab→Real com aplicação gradual e recuperação → diff só de leitura + snapshots nativos.
   - PWA com offline → app servido localmente.
   - Meta p95 < 300 ms formalizada → medir uma vez, sem *gate*.
   - Simular compressor, gate e GEQ → fora: a biblioteca nem os expõe.
   - A/B com áudio no MVP → depois.
   - `MixerState` "dos 11 canais" → o modelo deve seguir a **capacidade da mesa** (12 entradas), com a banda como mapeamento por cima.
10. **Melhor primeira entrega funcional?**
    Antes de qualquer código, o **teste da Fase 0 na mesa real**, que não depende do Lab. Depois disso:
    1. a etapa E0 (endurecimento do núcleo: fila, desfazer com conflito, portão de reconexão, AUX restrito);
    2. a **"Mesa web mínima"**: uma página servida pelo notebook, com os 11 faders PA/FONES sincronizados entre o Yoga e um celular, rodando em LAB.

    Ela é útil na roda, valida estado, eventos e fila de ponta a ponta, e é a mesma tela que depois controla a mesa real.

## 16. Fontes

- [soundcraft-ui (GitHub, MIT)](https://github.com/fmalcher/soundcraft-ui) · [Documentação](https://fmalcher.github.io/soundcraft-ui/)
- [Companion module Soundcraft Ui (MIT)](https://awesome.ecosyste.ms/projects/github.com%2Fbitfocus%2Fcompanion-module-soundcraft-ui)
- [webaudio-controls (Apache-2.0)](https://awesome.ecosyste.ms/projects/github.com%2Fg200kg%2Fwebaudio-controls) · [docs](https://g200kg.github.io/webaudio-controls/docs/index.html)
- [Vosk – modelos](https://alphacephei.com/vosk/models)
- [whisper.cpp (MIT)](https://awesome.ecosyste.ms/projects/github.com%2Fggml-org%2Fwhisper.cpp)
- [McpUI / FAUST](https://lobehub.com/mcp/orlarey-mcpui)
- Registro npm (consultado em 05/11/2026): `web-audio-peak-meter` 3.1.0 MIT, `@angular-slider/ngx-slider` 22.0.0 MIT, `fastify` 5.12.8 MIT, `ws` 8.22.1 MIT, `@huggingface/transformers` 4.3.2 Apache-2.0, `vosk-browser` 0.0.8 Apache-2.0
