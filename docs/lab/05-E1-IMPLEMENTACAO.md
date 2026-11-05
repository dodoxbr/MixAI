# 05 — E1: estado observável e LabMixer persistente (implementação)

**Data:** 05/11/2026 · **Branch:** `e1-lab-state` · **Base:** `main` em `4ae6aff` (E0 incorporada).
**Status:** implementado, aguardando revisão do Pull Request. **Sem merge automático.**

## O que foi entregue

| Diretriz | Implementação |
| --- | --- |
| LabMixer persistente; MockMixer mantido | `mixer/lab.ts` (`LabMixer`) e `mixer/mock.ts` (`MockMixer`, só testes), ambos sobre `mixer/simulated.ts`, que **não importa** nada de rede nem da biblioteca da Soundcraft |
| Modelo central de parâmetros, estados e eventos | `core/params.ts` (`ParamRegistry`: unidade, faixa, valores discretos, capacidade, aplicável na mesa), `core/state.ts` (`StateValue`, `MixerStateSnapshot`, `StateEvent`, `StateHub`, `applyStateEvent`) |
| Estrutura de EQ 4 bandas, HPF, bypass e cenas (sem interface) | `ParamKey` com `ch.N.eq.bK.freq/q/gain`, `ch.N.eq.hpf.freq/slope`, `ch.N.eq.bypass`, todos `simulated_only`; `core/scene.ts` (schema versionado, validação contra o registro, `diffValues`) |
| JSON versionado, gravação atômica, backup, recuperação | `mixer/lab-store.ts`: `schemaVersion` + migrações; temporário + `fsync` + `rename` (com novas tentativas no Windows); `.bak` da versão anterior válida; corrompido → `.corrupt-<data>` + backup ou padrão; versão mais nova → recusa sem tocar no arquivo; temporários órfãos limpos |
| Revisões globais e por parâmetro | `RevisionTracker` da E0, inalterado na semântica; agora avisa cada revisão (`onBump`) e o `StateHub` emite eventos encadeados (`fromRevision → revision`) |
| Desconhecido × -∞ × indisponível | `StateValue`: `known` (inclui -∞), `unknown`, `unavailable`; em JSON, -∞ = `"-inf"` |
| Laboratório nunca abre conexão | modo `lab` não carrega `mixer/real.js` nem `soundcraft-ui-connection` (import dinâmico); testes espionam WebSocket e TCP |
| 11 tools MCP e console | sem mudança nas tools; `--lab`, `npm run console:lab`, `npm run start:lab`; `MIXAI_MODE=lab` |

Correções da E0 preservadas: a fila, as travas, o desfazer causal, as confirmações com revisão e o `ConnectionSupervisor` continuam iguais. O supervisor **não foi alterado**; o `RealMixer` só ganhou `onLinkChange` (delegando ao supervisor) e a recusa explícita de parâmetros de EQ.

## Decisões tomadas na implementação (para a revisão)

| Ponto | Decisão | Motivo |
| --- | --- | --- |
| Onde ficam `snapshot()`/`subscribe()` | no **controlador** (`controller.state`), não no adaptador | as revisões e atores vivem no controlador desde a E0; no adaptador, o estado observável não teria revisão. O adaptador ganhou só `onLinkChange` |
| Modo padrão | o schema continua `mock`; o `config.yaml` entregue usa `lab` | evitar que um processo sem configuração crie arquivos sem querer |
| Revisão após reiniciar | a revisão global **recomeça** a cada processo | os clientes sempre começam por snapshot; a pilha de desfazer não é persistida; persistir revisões não traria ganho nesta etapa |
| Debounce de gravação | 300 ms (o plano citava 500) | menos perda em queda brusca; ainda junta rajadas |
| EQ no MockMixer | os dois simuladores têm todos os parâmetros do registro | um único modelo para teste e laboratório |
| Snapshot no laboratório | só guarda **qual** snapshot está carregado (nome) | carregar valores salvos é papel das cenas (E5) |
| Valores iniciais de EQ | neutros do MixAI (ganho 0 dB, HPF em 20 Hz = desligado) | os padrões de fábrica da Ui16 não são conhecidos; isso está escrito no registro |

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Queda de energia ou processo morto à força | até ~300 ms de mudanças perdidas no laboratório | gravação no `exit`, no `disconnect` e ao fechar o stdio; o arquivo nunca fica pela metade (atômico) |
| Windows: `rename` bloqueado por antivírus/indexador | gravação falha | 5 novas tentativas curtas; se falhar, o estado continua em memória, o status avisa e a próxima mudança tenta de novo |
| Arquivo editado à mão com valor fora da faixa | arquivo inteiro tratado como inválido | o original é guardado como `.corrupt-<data>` (nada é apagado) |
| Cliente que perde eventos | estado local divergente | eventos encadeados detectam o buraco (`gap`) e o cliente pede outro snapshot |
| Modelo de EQ diferente do DSP da Ui16 | expectativa errada | EQ é `simulated_only`, não aplicável na mesa, e a mesa real recusa escrever esses parâmetros |

## Testes

158 testes (119 na linha de base), 3 execuções seguidas sem falhas intermitentes. Novos arquivos:

- `params.test.ts`: tamanho do registro, limites conferidos contra as **constantes exportadas pela biblioteca instalada**, capacidades, validação, chaves;
- `state.test.ts`: codificação, snapshot com os 4 estados, revisões e atores, eventos encadeados, **sincronização** (cópia local + eventos = snapshot novo, numa sequência com escrita, mute em lote, mudança externa, desfazer, confirmação, ressincronização, verificação, erro inesperado e snapshot), buraco/evento repetido, ligação indisponível, assinante com erro;
- `lab.test.ts`: persistência entre instâncias (inclusive -∞, AUX, EQ, snapshot atual), debounce, atomicidade e backup, recuperação de principal corrompido, principal e backup corrompidos, valor fora da faixa, chaves desconhecidas/ausentes, perfil diferente, versão mais nova intocada, temporário órfão, falha de gravação, reset, validação de escrita, travas da E0 no laboratório;
- `isolation.test.ts` (ampliado): `mock` e `lab` sem carregar a mesa real nem a biblioteca, sem WebSocket e sem TCP, inclusive com IP configurado; precedência `--lab`/`MIXAI_LAB_FILE`;
- `scene.test.ts`: cena válida/inválida, diff, e as 11 tools MCP no laboratório com persistência;
- `supervisor.test.ts` (acréscimo): estado observável com a mesa real (socket falso) durante queda e volta.
