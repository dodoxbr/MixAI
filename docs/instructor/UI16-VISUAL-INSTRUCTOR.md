# Instrutor visual Ui16 — Issue #64

Base: main `632f25e`, incluindo PR #67. UI exclusivamente LAB, sem conexão/comando à Soundcraft. A navegação é um exercício de leitura; avançar/concluir não comprova que alguém encontrou, alterou ou validou uma configuração física.

## Uso

Entre com um dos PINs existentes e abra **Instrutor Ui16** na faixa de estado. Não há novo login, senha ou permissão. Escolha uma tarefa, leia pré-condições, controle/referência, orientação, expectativa visual, cautela e origem/versão. O desenho é um **esquema didático original MixAI**, não screenshot, posição ou cor reais da Ui16.

Use **Avançar**, **Voltar**, **Não encontrei**, **Concluir estudo**, **Reiniciar tutorial** ou **Todas as tarefas**. Não encontrei bloqueia o avanço e mostra a alternativa para conferir manual/modelo/versão com o operador. Retomar exige ação humana. Nenhuma senha é solicitada ou salva. O link externo só abre por clique do usuário.

A janela nativa usa foco inicial no título, contenção de Tab/Shift+Tab, Escape, rótulos, progresso e mensagens de estado. Ao fechar, devolve o foco ao acesso. O conteúdo é responsivo e os alvos têm pelo menos 48 px. Todo texto é escapado; links precisam ser HTTPS. Estado temporário só em memória da sessão; logout/troca de usuário, servidor ou modo invalida progresso e respostas tardias. Reconexão na mesma sessão preserva estudo. Offline permite rever conteúdo já carregado, sem enviar nem repetir operações.

## Conteúdo provisório e fronteira com C (#65)

Não há catálogo de procedimentos de C na base desta entrega. `instructor-fixtures.ts` é uma **fixture temporária de navegação**, separada do adaptador e explicitamente marcada em cada guia. Os sete assuntos pedidos aparecem: conexão/segurança do hotspot, identificação/nome de canal, EDIT→EQ, HPF, ganho/PFL, AUX SENDS/AUX1 e Shows/Snapshots.

As fixtures não copiam o manual nem implementam um segundo motor técnico. EQ/HPF, ganho e monitoração reaproveitam `technicalModules` e `sources` existentes, sem reproduzir regras/frequências/ganhos em um novo catálogo técnico. Conexão/senha, nome de canal e Shows/Snapshots usam orientação genérica de consulta à referência, **sem sequência de alteração validada**. Os nomes específicos desses controles, a seção e a sequência completa aguardam C. Referências de tarefa fornecidas pela Issue não são apresentadas como rótulos/posições confirmados no firmware.

A tentativa de ler a URL oficial do manual nesta tarefa retornou HTTP 403. Foram preservadas a referência e versão já cadastradas; não se inventaram páginas, cores, posições, senhas padrão ou imagens. Nenhum PDF/manual integral é versionado. O usuário deve confirmar a versão real com o operador, não tratar a fixture como procedimento oficial revisado. A UI continua funcional, com testes reais de navegação no LAB, sem fingir que recebeu dados ausentes.

## Contrato/adaptador de integração

`INSTRUCTOR_CATALOG` é um InjectionToken que fornece `() => Promise<unknown>`, padrão lazy local. C pode fornecer seu catálogo somente leitura por esse limite; não foi criada ou presumida rota HTTP. `adaptInstructionCatalog` valida versão/escopo, tamanhos, nomes, IDs únicos, campos obrigatórios e links. Versão desconhecida ou payload inválido produz erro/retry explícito, sem fallback que esconda incompatibilidade. Campos fora do contrato não viram ações. O adaptador constrói um novo objeto apenas com campos de apresentação.

Contrato temporário v1 (`instructor-contract.ts`):

- Envelope `{schemaVersion:1, procedures:Ui16Procedure[]}`.
- Procedimento: `id`, `title`, `purpose`, `preconditions`, `scope:'lab_instruction'`, `version`, `validation:'fixture'|'documented'`, `interfaceLimit`, `origin:{title,url,locator,version}`, `steps`.
- Etapa: `id`, `control`, `action` (texto), `expected`, `alternative`, `caution`, `schematic:string[]` (rótulos didáticos, não coordenadas/screenshot).

C é responsável pelos fatos, instruções oficiais, riscos e procedência; B apenas renderiza e mantém progresso. Se o contrato final de C tiver nomes/campos diferentes, mapear neste adaptador, não copiar procedimentos para o componente. D continua dono de passagem de som e histórico; o instrutor não grava nesse fluxo. O chat e todas as rotas existentes permanecem disponíveis ao fechar o instrutor.

## Segurança e limites

Nenhum import de `ActionsService`, nenhum uso de `LiveService.command`, nenhuma API de execução e nenhuma escrita em banco/mesa. `LiveService`/`SessionService` são usados somente para modo/conexão/identidade. Músico sem vínculo pode ler material genérico no LAB; isso não atribui canais nem muda autorização. O recurso não aparece em MOCK/REAL ou sem sessão autenticada. Catálogo/progresso não migram para REAL. EQ, HPF, ganho, senha/rede, AUX e carregar/salvar snapshots não são executados por esta entrega.

Catálogo, widget e conteúdo técnico têm carregamento sob demanda. A main de referência já avisa sobre bundle inicial >400 kB (401,83 kB medidos); esta entrega conserva os limites de orçamento e registra o tamanho final no PR. Não se alteraram budgets para obter aprovação. Touch/navegador são emulados; sem validação de firmware, equipamento, acústica ou operação real. Conteúdo em fixtures, substituição pelo contrato C e conferência física continuam pendentes.

## Verificação

`instructor.spec.ts`: versão/escopo inválidos, links perigosos, texto HTML, erro/retry, navegação, limites de etapa, not-found, conclusão/reinício, sessão/modo/servidor e promessa tardia, sem dispatch. `test/e2e/ui16-instructor.test.ts`: sete tarefas em Yoga/celular retrato/paisagem, teclas, foco, logout, progresso e músico sem vínculo ainda recusado no backend. Regressões: typecheck, builds, núcleo, interface, E2E, smoke Yoga e HTTPS/WSS. Resultados exatos e limitações de execução ficam no relatório do PR.
