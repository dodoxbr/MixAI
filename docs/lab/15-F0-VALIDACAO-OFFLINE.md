# F0 — evidências da preparação offline (Issue #15)

Preparado em 06/11/2026, branch `f0-preflight-readonly`, a partir de `main` em
`aa98ace` (inclui a E7A já presente na main, preservada sem alterações). Ambiente Linux, Node v24.22.1, npm 11.9.0. Hardware não disponível.
Nenhum comando foi executado em equipamentos reais.

| Verificação executada | Resultado |
| --- | --- |
| `npm run typecheck` | passou (src e testes) |
| `npm test` | 368 testes passaram, 37 arquivos |
| `npx vitest run test/f0-readonly.test.ts` após acrescentar consultas de snapshots | 20 testes passaram |
| `npm run build` | passou |
| `npm run test:web` | 55 testes passaram, 8 arquivos |
| `npm run build:web` | passou |
| `npm run test:e2e` | 60 testes passaram, 8 arquivos (Chromium local) |
| Smoke `node dist/console.js --mock --readonly` via stdin | saída normal; 6 comandos recusados sem confirmação |
| `git diff --check` | passou |

O smoke em memória enviou status/estado, tentou sobe/mute/master/desfazer/carregar/log,
voltou a ler estado e saiu. Somente o simulador foi usado. O teste automatizado F0
exercita `RealMixer` e a biblioteca fixada em 7.1.0 com WebSocket falso: alterações
recusadas antes da conexão, em SYNCING/DEGRADED/READY e durante três quedas/recuperações;
zero comandos mutantes em todas as gerações após 2,6 s; evento antigo ignorado;
apenas um socket vivo e nenhum após desconectar. Shows/snapshot são consultados sem
liberar escrita. Testes existentes do supervisor verificam também queda silenciosa,
classificação sem reenvio e geração descartada bloqueada depois da vigilância.

O teste de montagem com `createApp` confirma que a opção chega ao `RealMixer` existente,
sem conectar. A lista positiva do console recusa nível/mute/master/desfazer/carregar e
histórico antes de chegar ao controlador. Não existe segundo `RealMixer`.

## Limites e pendências

**PENDENTE — hardware não disponível:** link USB-C/RJ45, driver no Yoga, IP/máscara
Ethernet efetivos da Ui16, rota Windows, UI oficial, firmware/modelo, canais/AUX físicos,
leituras comparadas, queda/recuperação do cabo e manutenção simultânea de internet Wi-Fi.
O formulário [14-F0-EVIDENCIAS-MODELO.md](14-F0-EVIDENCIAS-MODELO.md) fica sem resultados
físicos até o operador executar [o roteiro](13-F0-PREFLIGHT-READONLY.md).

A biblioteca/perfil declara 6 AUX; a contagem de saídas físicas deve ser conferida,
sem assumir que 5/6 existem. Testes falsos não validam essa compatibilidade.
Não houve ensaio de áudio, atualização de firmware, escrita REAL, implementação de E6
ou alteração de E7A. CI Linux/Windows deve ser conferida no PR; resultado local Linux
não prova execução no Windows. O E2E local usa o Chromium do sistema via preload do
ambiente, sem mudar arquivos do projeto ou configuração de CI.
