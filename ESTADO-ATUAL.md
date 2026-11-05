# MixAI — estado atual (05/11/2026, v0.5 / E3)

Controle da mesa **Soundcraft Ui16** por IA, para uma banda de samba/pagode amadora que toca em roda.
O músico pede em português ("mais Fred no fone", "abaixa o surdo") e o Claude ajusta a mesa,
sempre passando por travas de segurança.

**Status:** Fases 0 e 1 prontas e testadas com a mesa **simulada**. Ainda não foi testado
na mesa real (a mesa não chegou).

---

## 1. Contexto de uso

- **Formato:** roda de samba (sem palco). Todo mundo em círculo.
- **Som:** 1 PA ativa no master (sub + torre previstos). Retorno de todos **por fone**.
- **Retorno:** amplificador de fones Behringer **HA800** (8 saídas, uma entrada) ligado no **AUX 1**,
  com uma mix única para todo mundo. Cada um regula o volume do próprio fone.
- **Operação:** notebook Lenovo Yoga 7 (tela touch) ligado na Ui16 por **cabo de rede**.
  O Wi-Fi do notebook fica livre para a internet (API do Claude). Desenvolvimento num ROG Zephyrus M16 (Windows).

### Canais

| Canal | Fonte | Apelidos |
| --- | --- | --- |
| 1 | Cavaco | cavaco, cavaquinho |
| 2 | Violão | violão, 7 cordas |
| 3 | Voz Fred | fred |
| 4 | Voz Lucius | lucius |
| 5 | Voz Leandro | leandro |
| 6 | Voz Fernando | fernando |
| 7 | Pandeiro | pandeiro |
| 8 | Tantã | tantã, tantan |
| 9 | Surdo | surdo, surdão |
| 10 | Laviquinho | laviquinho, lavi (aparece de vez em quando) |
| 11 | Reserva | reserva, convidado |

Retorno: **AUX 1 = Fones** (aliases: fone, retorno, monitor).

---

## 2. Arquitetura

```
Usuário (texto)                       Tela no Yoga / celulares (Angular, E3)
   │                                          │ HTTP + WebSocket (PIN: operador | músico)
Claude Desktop ──MCP stdio──▶ dist/index.js ──┤ HTTP 127.0.0.1 (token local do assistente)
                                              ▼
                        Servidor único MixAI (dist/serve.js, Fastify)
                          ├── perfis, aprovação humana, requestId, eventos com revisões
                          ├── travas de segurança, apelidos, desfazer, log (MixController)
                          ├── mesa real → soundcraft-ui-connection 7.1.0  (porta 8791)
                          └── laboratório persistente (porta 8790)
```

- A IA **nunca** fala direto com a mesa: tudo passa pelo servidor e pelo `MixController`.
- **Um só dono** da mesa (trava de processo); o MCP é cliente HTTP e não abre a mesa.
- Operações críticas só são **aprovadas por operador autenticado** (o assistente propõe).
- Toda leitura/escrita da mesa está atrás de uma interface `MixerAdapter`
  (`RealMixer` e `MockMixer` implementam a mesma interface).

### Stack

| Item | Escolha |
| --- | --- |
| Linguagem | TypeScript (Node.js 22+) |
| Mesa | [`soundcraft-ui-connection`](https://www.npmjs.com/package/soundcraft-ui-connection) 7.1.0 (versão fixada) |
| IA | `@modelcontextprotocol/sdk` 1.32 (MCP stdio, cliente do servidor) |
| Servidor | Fastify 5 + `@fastify/websocket` 11 + `@fastify/static` (serve a interface) |
| Interface | Angular 22 standalone + signals, componentes SVG próprios (E3) |
| Validação | zod 4 |
| Config | YAML (`yaml`) |
| Testes | Vitest |

### Estrutura

```
src/
  serve.ts            servidor único (HTTP + WebSocket)
  server/             perfis, PIN, pendências/cartões, requestId, medidores simulados
  index.ts            MCP (stdio), cliente HTTP do servidor
  console.ts          console de teste sem IA
  mcp/server.ts       tools + instruções para a IA
  core/controller.ts  travas, desfazer, log
  core/channels.ts    nomes da banda -> números
  core/config.ts      leitura de config.yaml e channels.yaml
  core/log.ts         log em memória + .jsonl por dia
  mixer/types.ts      interface MixerAdapter
  mixer/real.ts       mesa real (soundcraft-ui-connection)
  mixer/mock.ts       mesa simulada
config/
  config.yaml         modo, IP, travas
  channels.yaml       nomes da banda
test/                 232 testes (Vitest) + 10 de integração com navegador (test/e2e)
web/                  interface Angular (27 testes unitários)
```

---

## 3. Tools MCP expostas

| Tool | O que faz |
| --- | --- |
| `mixer_status` | conexão, modo, snapshot atual; tenta reconectar |
| `list_channels` | nomes da banda (canais e retornos) |
| `get_mix_state` | volume (dB) e mute de cada canal, no master ou num AUX |
| `set_channel_level` | volume do canal no PA (absoluto `db` ou relativo `delta_db`) |
| `set_aux_send` | volume do canal no fone (AUX) |
| `mute_channel` | muta/desmuta um ou mais canais, no master ou num AUX |
| `set_master_level` | volume geral (sempre vira pendência para o operador aprovar) |
| `undo_last` | desfaz as últimas N ações |
| `get_action_log` | histórico de ações e recusas |
| `list_snapshots` | shows/snapshots salvos na mesa |
| `load_snapshot` | carrega snapshot (sempre vira pendência para o operador aprovar) |

**Fora de propósito:** ganho de entrada e phantom power não são expostos à IA.

---

## 4. Travas de segurança (no código, não no prompt)

| Trava | Padrão (config.yaml) |
| --- | --- |
| Teto de volume canal / AUX / master | 0 dB |
| Mudança máxima por comando sem confirmação | 6 dB |
| Master | sempre pede confirmação |
| Mutar mais de 2 canais de uma vez | pede confirmação |
| Carregar snapshot | sempre pede confirmação (e zera o desfazer) |
| Comandos por segundo | 5 |
| Canal todo abaixado (-∞) em ajuste relativo | tratado como -60 dB (abrir = mudança grande) |

"Pedir confirmação" nunca altera nada: a tool devolve `NEEDS_CONFIRMATION` com um `pendingId`, e a IA
precisa perguntar ao usuário e repetir o mesmo comando com `confirmation_id` (uso único, 60 s,
invalidado se a mesa mudar antes). Tudo vai para o log (`logs/acoes-AAAA-MM-DD.jsonl`) e para
a pilha de desfazer (até 50 ações).

---

## 5. Testes

232 testes do servidor + 27 da interface + 10 de integração com navegador passando (Linux; o CI roda também em Windows). Inclui, além dos 40 originais:

- nomes da banda (acentos, apelidos, "canal 9", "retorno do ...", limites da Ui16);
- travas (teto, passo máximo, confirmação, rate limit, sem conexão);
- **E1:** laboratório persistente (gravação atômica, backup, recuperação), registro central de
  parâmetros (inclui EQ/HPF/bypass só no laboratório), estado observável com eventos e
  sincronização, transmissão JSON (-∞ como "-inf"), reset integrado às revisões, isolamento laboratório × mesa real, estrutura de cenas;
- **E2:** servidor único (dois clientes WS, reconexão, ressincronização por evento perdido,
  `requestId` sem duplicar, perfis operador/músico, aprovação só por operador, LAB ≠ REAL,
  MCP sem servidor, reinício invalida sessões, um só controlador, rede do Yoga, segredos;
  correções da revisão: escrita nunca repetida após reinício (INDETERMINATE), desfazer crítico com
  aprovação, WebSocket revogado no logout/vencimento, trava de dono entre instalações e processos);
- **E0:** reconexão segura (supervisor com gerações e descarte de instância), fila única,
  desfazer causal por revisão, pendências vinculadas ao estado, operações compostas parciais,
  estados distintos, isolamento mock × real, parser e nomes restritos;
- desfazer (vários passos, volta a -∞);
- servidor MCP de ponta a ponta (cliente MCP em memória);
- **adaptador real com WebSocket falso** imitando a Ui16: confere que os comandos saem no
  protocolo real (`3:::SETD^i.1.mix^...`, `SETD^i.0.aux.1.value^...`, `LOADSNAPSHOT^show^snap`);
- validação do `config.yaml` e `channels.yaml` entregues.

---

## 6. Decisões tomadas

- Conexão notebook ↔ mesa por **cabo Ethernet**; Wi-Fi do notebook para internet.
- **IA híbrida:** com internet, Claude via API; sem internet, modo local só com comandos diretos
  (Ollama ou regras — ainda não decidido).
- **Voz (futuro):** botão "segure e fale" no celular; transcrição local com Whisper. Sem escuta contínua.
- Fases 0 e 1 usam o Claude Desktop; app próprio a partir da Fase 2.

## 7. Próximas fases

| Fase | Conteúdo | Portão |
| --- | --- | --- |
| 0 | Teste na mesa real (conectar, ler, mover fader, desfazer) | fader mexe na mesa real |
| 2 | App web no celular (servido pelo notebook) + acesso exclusivo à mesa | ensaio inteiro só por texto |
| 3 | Skill "técnico de som": EQ, HPF, ciclo de ajuste ("tá embolado") | um evento sem mexer à mão |
| 4 | Voz (Whisper local) + memória da banda | banda aprova os ajustes |

A biblioteca já suporta EQ de 4 bandas e HPF na Ui16, então a Fase 3 é viável.

## 8. Pontos abertos / onde sugestões ajudam

1. **Bibliotecas:** existe algo pronto que substitua ou complemente o que fizemos?
   - servidor MCP já existente para Soundcraft Ui;
   - alternativas/complementos ao `soundcraft-ui-connection`;
   - app de chat web leve para a Fase 2 (que rode no notebook e abra no celular);
   - transcrição local em português (Whisper / whisper.cpp / faster-whisper) para a Fase 4.
2. **Modo offline:** Ollama com modelo pequeno com tool calling vs. regras simples.
3. **Riscos conhecidos:** o protocolo WebSocket da Ui não é oficial (firmware pode quebrar);
   a IA não ouve o som, decide pelo relato do músico e pelos medidores.
