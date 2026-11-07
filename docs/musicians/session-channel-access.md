# Issue #47 — músicos e canais vinculados, somente LAB

Os mesmos dois PINs continuam sendo usados. O PIN de músico é compartilhado e não identifica uma pessoa. Depois de entrar, o celular mostra o identificador público da sessão (não é token nem PIN). Antes do evento, o operador confere esse identificador com a pessoa e abre **Vincular músicos — somente LAB** na Mesa. Seleciona o músico, confere os canais, permite ou não MUTE individual e toca **Confirmar vínculo no LAB**. Nenhum vínculo é criado pelo login nem por seleção livre de nome no celular.

Mapa inicial: Fred CH3; Lucius CH1 + CH4; Leandro CH5; Fernando CH6; Laviquinho CH7. O operador pode informar uma lista diferente de canais configurados; CH2/8/9/10/11 nunca têm titularidade inferida. O cadastro físico continua em `config/channels.yaml`; canal não configurado não pode ser atribuído. Convidados podem ser cadastrados pelo comando administrativo, sem inventar propriedade por apelido.

O músico vê **Meus canais**, passos rápidos de até 2 dB (limitados também pela política do servidor) e MUTE de um canal, se permitido. FONES é AUX1 compartilhado pelo HA800: uma alteração é ouvida por todos, não é mix individual. PA só aparece quando `server.musicianAccess=pa_without_master`; a entrega não muda essa configuração nem exige configurar PINs novamente. Passos grandes conservam o fluxo de aprovação do operador. Não há confirmação adicional nos passos pequenos autorizados. Arraste de músico é recusado em PA e AUX; usa-se somente controle discreto.

## Contrato v1 para a futura fila de solicitações (#49)

A origem confiável é `ServerCore.musicianIdentity(principal)` após autenticar a sessão existente. Não aceitar identidade/canais fornecidos por texto de IA ou pelo corpo de uma solicitação.

```ts
{
  schemaVersion: 1,
  sessionId: string, // identificador público, nunca bearer token
  binding: null | {
    schemaVersion: 1,
    sessionId: string,
    musicianId: string,
    name: string,
    channels: number[],
    mute: boolean,
    revision: number
  }
}
```

`null` significa sem autorização de escrita. Vincular novamente incrementa a revisão. A fila futura deve registrar solicitante e revisão, validar vínculo atual antes de aplicar e passar comandos por `ServerCore.execute`, nunca despachar diretamente ao controlador. Solicitar ajuda usa o assistente existente; esta entrega não implementa nem promete a fila do outro agente. Propostas locais/IA são filtradas por vínculo e sua execução continua passando pela mesma autorização central.

Comandos administrativos no transporte HTTP/WS existente (`/api/command`, mensagem `command`):

- `musician_identity`: retorna somente a identidade da própria sessão.
- `musician_sessions`: operador LAB lista sessões observadas, vínculos e mapa inicial.
- `musician_bind {sessionId,musicianId,name,channels,mute}`: operador LAB confirma explicitamente o vínculo de uma sessão de músico ativa e já observada.
- `musician_revoke {sessionId}`: operador LAB revoga o vínculo.

Todos usam requestId e serverId existentes, autenticação existente e deduplicação existente. Nenhuma nova rota HTTP ou novo PIN. Nome, canais e MUTE são estritamente validados no backend. A autorização de canal é reavaliada dentro da fila de escrita, incluindo aprovação de uma pendência anterior; logout/expiração, revogação ou troca da revisão invalidam comandos ainda aguardando. Repetir requestId não repete uma escrita.

## Persistência e ciclo de vida

Vínculos ficam em `data/musician-bindings.json` (diretório de dados configurado), com schema v1 e gravação por temporário/rename. Não contém tokens, PINs ou IPs. Arquivo inválido recusa inicialização, sem liberar canais por fallback. Falha ao salvar nova atribuição restaura o vínculo anterior em memória. Revogar falha de modo fechado: o vínculo é retirado da memória mesmo se a persistência falhar.

Sessões autenticadas continuam exclusivamente em memória, com TTL/`sessionHours` existentes. Recarregar a página com a mesma sessão conserva o vínculo. Sair/expirar remove o vínculo; entrar novamente gera outra sessão sem direitos herdados. Reiniciar o servidor não restaura autenticação: registros persistidos ficam apenas para revisão do operador e precisam ser vinculados à nova sessão. Revogação bloqueia o backend imediatamente; a tela consulta a identidade a cada dois segundos e remove controles ao receber a mudança. Reconexão sincroniza estado sem repetir escritas. Não há identidade persistente secreta adicional de dispositivo.

Snapshots HTTP/WS, eventos, list_names, mix_state e contexto de IA são filtrados por canais vinculados. MASTER, cenas, ganho, phantom, EQ/AFS, aprovação e escrita REAL continuam indisponíveis para músicos. A administração e as novas permissões só funcionam em LAB. E6 segue bloqueada. Ajustes no transporte HTTP limitam-se a passar o Principal existente ao filtro de estado; a autenticação não foi modificada. As alterações pequenas no assistente só consultam a autorização central e filtram contexto; não implementam a fila.

Auditoria usa músico atribuído + sessão e os registros existentes de canal/destino/antes/depois/resultado. Administração e recusas também são registradas, sem credenciais ou rede. Os testes históricos que exercitam ações autorizadas agora atribuem explicitamente canais por uma fixture de operador; testes novos deixam login sem vínculo e verificam recusas, isolamento e troca de sessão.

## Validação e limites

Testes novos: `test/musician-access.test.ts` e `test/e2e/musician-access.test.ts`. Cobrem Fred/Lucius, HTTP/WS, requisições forjadas, revogação, limite, persistência, troca de sessão, modo REAL recusado sem escrita e pareamento pela interface. Executar também typecheck, build, web, regressões core/E2E, smoke Yoga e HTTPS/WSS. Resultados e eventuais testes não executados são registrados no PR.

Yoga/celular são emulados em Chromium; não comprovam funcionamento em aparelhos físicos. Não há teste acústico, firmware, rede física ou escrita Soundcraft. Nenhum vínculo autoriza E6. As skills foram consultadas na branch do PR #50 e não duplicadas nesta branch.
