# Integração futura ao assistente do MixAI

Este documento é um plano. B3/B4 não estão implementadas e só devem começar após
E7A e validação das dependências indicadas na Issue #13.

## Fronteiras

A base atual depende apenas de seus módulos locais e Zod. Não importa adaptador,
controlador, parser, serviço de IA ou servidor. O teste de isolamento verifica que
código de produção não a importa. Não foram criados endpoints, tools MCP, novos
comandos ou chamadas de provedor. A função pura não recebe uma mesa e não tem
como aplicar recomendações.

No futuro, um serviço de consulta poderá consumir `Diagnosis` como conteúdo,
preservando `schemaVersion`, `knowledgeVersion`, referências e limitações. Ele
poderá ser usado por parser local, Claude, OpenAI ou modelo offline. Nenhuma regra
de permissão pode depender do provedor ou de uma instrução em prompt.

## Etapas propostas

1. **Concluir E7A e rever capacidades.** Resolver a discrepância da inclinação do
   HPF com os responsáveis pela E7, sem liberar escrita real com base em testes de
   LAB. Verificar cada recurso contra pacote fixado, modelo e firmware registrados.
2. **Consulta no assistente, separada de comandos.** Exibir relato, destino,
   instrumento/canal confirmado pelo mapeamento do servidor, hipóteses, confiança,
   lacunas e fontes. Não converter texto de recomendação automaticamente em Intent.
   Pedir contexto quando faltar; jamais dizer que o assistente ouviu o som.
3. **Propostas supervisionadas somente em LAB inicialmente.** Criar um tradutor
   explícito e validado de recomendações revisadas para os recursos efetivamente
   suportados, com allowlist do backend. Uma recomendação não é aprovação. Não
   incluir pré, phantom, roteamento, GEQ, AFS ou dinâmica não suportada. Respeitar
   perfil, canal mapeado, destino, tetos e regras do servidor.
4. **Vincular proposta ao estado do servidor.** Reutilizar a infraestrutura E4/E2
   em `src/assistant/proposals.ts`, `src/server/policy.ts`, `src/core/pending.ts` e
   `src/core/controller.ts`. Revisões por parâmetro, TTL emitido pelo servidor,
   conferência atômica na fila, expiração, conflito e uso único continuam no
   backend. O modelo não gera revisões confiáveis nem aprova o próprio cartão.
5. **Avaliação pelo operador.** Guardar versão do conhecimento, evidências com
   origem, hipóteses descartadas, proposta aprovada, resultado enviado/aplicado
   simulado, modo, firmware, data e feedback. “Melhorou” é avaliação humana,
   não medição. “Não melhorou” produz nova revisão; undo respeita revisões,
   concorrência e resultados incertos do núcleo, sem promessa de reversão universal.
6. **Depois de F0/E6, estudar leituras reais.** Novo contrato deve carregar origem,
   canal, ponto pre/post, unidade/calibração validada, timestamp, validade/freshness
   e qualidade. Leituras antigas, desconectadas e simuladas não podem sustentar
   diagnóstico real. VU pode informar nível nas condições validadas, mas não
   comprova timbre, espectro ou frequência de feedback.
7. **Análise espectral em projeto separado.** Exigir captura real com autorização,
   rota/canal conhecidos e processamento validado, ou RTA com API compatível
   comprovada. RTA na interface oficial não significa acesso pela biblioteca.
   Gravação estéreo USB também não fornece pistas isoladas ou áudio ao assistente.

## Critérios para liberar uma integração futura

- Sem contexto, sem proposta de alteração; hipótese jamais vira evidência medida.
- EQ/HPF continuam bloqueados no REAL até verificação específica e políticas do
  backend. Funções simuladas não promovem capacidades de hardware.
- Todas as alterações propostas são explicáveis e dependem de revisão humana;
  ganho de pré, phantom e mudanças em PA exigem as autorizações explícitas e
  proteções previstas na Issue #13. Modelo nunca aprova cartões.
- Cobrir conflitos, TTL, desconexão, permissão de músico, destino AUX compartilhado,
  idempotência e undo nos testes de integração antes de registrar qualquer tool.
- Conteúdo vindo de usuário/modelo é dado não confiável e precisa de validação
  estrita e política do servidor; instruções embutidas não concedem capacidade.
- Presets eventualmente validados devem carregar contexto, local, data e operador;
  não promover exemplos desta base a padrões da Ui16.

Nenhuma dessas etapas exige alterar o fluxo de produção na primeira entrega.
