# F0 — formulário de evidências do operador

Status inicial: **PENDENTE — hardware não disponível**. Copiar para arquivo local fora
do Git. Não preencher com valores presumidos. Não anexar PINs, tokens, chaves, senha
Wi-Fi, `secrets.yaml`, dumps de ambiente ou capturas de tráfego brutas.

## Identificação

- Operador / data e horário com fuso:
- Commit / branch / versões Node, Windows, driver USB Ethernet:
- `npm ls soundcraft-ui-connection` (esperado 7.1.0):
- Ui16 modelo confirmado / firmware e build / fonte da informação:
- PA, HA800 e fones fisicamente desconectados? Evidência:
- Outros processos REAL encerrados / trava respeitada:

## Rede (valores locais; revisar antes de compartilhar)

| Item | Antes | Durante F0 | Restaurado ao final |
| --- | --- | --- | --- |
| Adaptador USB-C/RJ45: descrição / ifIndex / link | | | |
| Ethernet Yoga: IPv4 / máscara / DHCP | | | |
| Ethernet Yoga: gateway / DNS (esperado vazio no cabo direto) | | | |
| Ui16 LAN: IPv4 / máscara / como confirmou | | | |
| Ui16 hotspot: IP se conhecido, distinto de LAN | | | |
| Wi-Fi Yoga: IPv4 / máscara / DHCP / gateway / DNS | | | |
| Rota escolhida para Ui16: interface / origem / next hop | | | |
| Rota padrão de internet e eventuais VPNs | | | |
| Sub-redes sem sobreposição / sem ponte ou ICS | | | |

| Diagnóstico | Horário | Resultado e evidência selecionada |
| --- | --- | --- |
| LED / Get-NetAdapter | | PENDENTE — hardware |
| Find-NetRoute | | PENDENTE — hardware |
| Test-NetConnection TCP 80 / SourceAddress / InterfaceAlias | | PENDENTE — hardware |
| ping (ICMP pode estar bloqueado) / vizinho ARP | | PENDENTE — hardware |
| UI oficial pelo IP LAN confirmado | | PENDENTE — hardware |
| Site externo via Wi-Fi, antes/durante/depois | | |
| Celular no LAB pelo IP Wi-Fi Yoga:8790 (opcional) | | |

## Compatibilidade e leituras

Perfil configurado **não** é autodetecção: Ui16 / 12 entradas / 6 AUX na biblioteca.
Registrar AUX físicos observados (historicamente previstos 4), sem “corrigir” a mesa.

- Modelo/firmware observado corresponde ao esperado? Fonte:
- Contagem de entradas físicas / strips linha-playback / AUX físicos / buses na UI:
- Canais cadastrados 1–11, 12 livre; divergências de nome/ligação/Hi-Z:
- AUX 1 = Fones; pre/post observado e HA800 desconectado:
- Show/snapshot atual / lista (distinguir vazio de desconhecido/timeout):
- Tempo de conexão / timeout / motivo de DEGRADED se ocorrer:

| Parâmetro e canal | Horário | UI oficial | Console F0 | Igual / divergente / desconhecido |
| --- | --- | --- | --- | --- |
| Canal 1 nível/mute PA (repetir para 2–11) | | | | PENDENTE |
| Master nível | | | | PENDENTE |
| Canal 1 nível/mute AUX 1 (repetir para 2–11) | | | | PENDENTE |

## Queda e recuperação física (somente leitura)

| Evento | Horário | Estado e observações |
| --- | --- | --- |
| Leitura estável inicial | | PENDENTE — hardware |
| Retirada do cabo Ethernet | | |
| LOST/indisponível observado por status/estado | | |
| Internet Wi-Fi durante perda | | |
| Cabo recolocado (~5 s depois) | | |
| Reconexão / sincronização / READY ou DEGRADED | | |
| Comparação final UI × console, PA/master/AUX | | |
| Encerramento sem retries / rede do Yoga restaurada | | |

Tempo para recuperar: ____. Alterações inesperadas: ____. Parou em 30 s ou antes por
critério de segurança? ____. Não enviar alterações reais para produzir “pendências”.

## Simulações e validação local

Preencher a partir da execução atual (não copiar um resultado antigo).

| Verificação | Comando/fonte | Resultado / contagem / falha |
| --- | --- | --- |
| Tipos | npm run typecheck | |
| Regressão núcleo | npm test | |
| Build | npm run build | |
| F0 read-only e reconexão | npx vitest run test/f0-readonly.test.ts test/supervisor.test.ts test/real-adapter.test.ts | |
| Console sem rede | node dist/console.js --mock --readonly | |
| CI Linux / Windows | link da execução e commit | |

- Zero comandos mutantes em todas as gerações falsas após retries? Evidência:
- Queda silenciosa: comando antigo classificado, nunca repetido? Teste/evidência:
- Geração descartada bloqueada mesmo após vigilância? Teste/evidência:
- Dados ausentes tratados como desconhecidos, não como zero? Evidência:
- Limite: simulação não valida firmware, cabo, driver nem latência física.
- Limite: ausência de mudança visual no F0 real não prova ausência de frames antigos.

## Incidentes, decisão e pendências

- Critério de parada acionado / erro exato sem segredos / horário:
- Ações de encerramento e restauração apenas no Yoga:
- Evidências locais sanitizadas (nomes de arquivos):
- Conclusão: [ ] preparação offline validada [ ] leitura física observada
  [ ] incompleto [ ] falhou. Estes itens são independentes.
- Pendências físicas e divergências a investigar:
- Escrita real, áudio e E6 continuam fora deste aceite; nenhuma autorização inferida.
- Nome do operador e data da revisão:
