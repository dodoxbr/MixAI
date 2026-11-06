# E8A — comparação LAB × REAL offline, exclusivamente em leitura

Issue [#21](https://github.com/dodoxbr/MixAI/issues/21). Base `main` em `9faaf46`.
Os merges dos PRs #14 (E7A), #17 (F0), #18 (base técnica) e #19 (spike de voz)
foram confirmados pela API do GitHub e como ancestrais dessa referência. Branch nova:
`feature/e8a-readonly-diff`; a branch F0 não é reutilizada.

**A Ui16 continua indisponível. REAL neste documento significa um retrato de dados
fornecido, que pode ser inteiramente fictício. Nenhuma conexão é aberta pelo comparador.**
F0 físico e E6 seguem pendentes. Nenhum relatório autoriza aplicação na mesa.

## Implementação e uso

`src/core/lab-real-diff.ts` expõe:

- `portraitFromScene(scene)`: adapta uma cena E5 já fornecida, preservando o formato v2;
- `portraitFromSnapshot(snapshot, metadata)`: adapta um `MixerStateSnapshot` existente;
  para estado wire, primeiro usar `snapshotFromWire`/`parseSnapshot` existentes;
- `compareLabReal(input)`: função pura de dados, sem relógio global, rede, arquivos,
  adapters, `connect`, `read`, `write` ou assinaturas;
- `exportLabRealComparison(input, 'json' | 'markdown')`: exportação de dados validados
  e reconstruídos por lista positiva, incluindo valores dos dois lados e explicações.

Reutiliza `ParamRegistry`, `ParamKey`, `decodeValue`/`encodeValue`, `snapshotToWire`,
`SceneSchema`, `DeviceProfileSchema` e `diffValues` (inclui a tolerância existente de
0,05 dB). Não altera comparação/carregamento de cenas E5, EQ E7A, voz, base técnica,
console F0, `RealMixer` ou supervisor. Não usa `loadTargets`, não gera comandos,
pendências ou plano de aplicação; não adiciona tela, botão, rota HTTP nem tool MCP.

### Contrato mínimo

Cada retrato contém:

- `mode`: LAB/mock à esquerda, REAL à direita; origens aceitas verificadas por lado;
- `origin`: `fixture`, `fake_socket`, `lab_scene`, `lab_state` ou, reservado ao produtor
  futuro, `real_readonly`. Esse rótulo não provoca conexão nem valida hardware;
- `device`: modelo, entradas e AUX **de perfil**, não saídas físicas autodetectadas;
- `capturedAt`: ISO UTC, `revision`: revisão global ou `null` para cena arquivada;
- `freshness`, `available`, `link`: condição de captura explicitamente fornecida;
- `params`: chave → `{value, revision, support}`; `value` segue `WireStateValue` existente
  (`known` com número/boolean/`'-inf'`, `unknown` ou `unavailable`).

`support` é `supported`, `unsupported` ou `unknown`, fornecido pelo produtor do retrato.
O adaptador de snapshots **não** deduz suporte de valores ausentes ou da contagem de
AUX: sem declaração, usa `unknown`. Uma fixture pode declarar `supported` para exercitar
comparação numérica, mas isso não é verificação física. Os status de cenas não concedem
permissão: `compatible`/ensaio não promovem EQ/HPF a hardware validado; `incompatible`
continua bloqueado. Origem/captura/revisões são declarações do produtor, não atestação.

`comparedAt` é obrigatório e explícito, mantendo testes/exportações determinísticos.
`maxAgeMs` padrão: 30.000 ms. `ceilings` padrão: canal/AUX/master 0 dB; pode receber
os tetos da política existente sem importar o controlador. Não existe alvo limitado
ou valor “corrigido” automaticamente.

Exemplo de consumo (somente dados):

```ts
const input = {
  lab: portraitFromScene(sceneLabFornecida),
  real: portraitFromSnapshot(snapshotRealFornecido, {
    device: perfilFornecido,
    origin: 'fake_socket',
    capturedAt: instanteDaCaptura,
    freshness: 'fresh',
    support: { 'ch.1.main.level': 'supported' },
  }),
  comparedAt: instanteDaComparacao,
};
const report = compareLabReal(input);
const json = exportLabRealComparison(input, 'json');
const checklist = exportLabRealComparison(input, 'markdown');
```

### Gerar relatório de demonstração sem hardware

Na raiz, com dependências instaladas (`npm ci`), criar `work/` se necessário. Estes
comandos usam a fixture fictícia versionada em `test/support/lab-real-fixtures.ts`,
não a configuração REAL, e funcionam em terminal Windows/PowerShell e Linux:

```text
node --import tsx --input-type=module -e "import { labRealFixture } from './test/support/lab-real-fixtures.ts'; import { exportLabRealComparison } from './src/core/lab-real-diff.ts'; console.log(exportLabRealComparison(labRealFixture(), 'json'));" > work/e8a-fixture.json
node --import tsx --input-type=module -e "import { labRealFixture } from './test/support/lab-real-fixtures.ts'; import { exportLabRealComparison } from './src/core/lab-real-diff.ts'; console.log(exportLabRealComparison(labRealFixture(), 'markdown'));" > work/e8a-fixture.md
```

JSON usa `'-inf'`; Markdown apresenta `−∞`. O núcleo retorna texto: cabe ao chamador
escrever em arquivo. Os arquivos de demonstração são locais, não entram no Git.

## Regras de classificação

A comparação considera a **união** das chaves, incluindo as que existem só no REAL.
Ordem determinística por identificador; resumo conta todos os estados, não só diferenças.

| Resultado | Significado |
| --- | --- |
| `device_mismatch` | modelo desconhecido, modelos diferentes ou número de entradas/AUX de perfil diferentes; bloqueia toda comparação de valores, sem remapear canais |
| `unsupported` | chave fora dos limites do perfil/registro, `simulated_only`, não aplicável ou explicitamente não suportada em algum lado |
| `missing_in_lab` | chave suportada ausente no LAB; não inventa alvo |
| `missing_in_real` | chave suportada ausente no REAL; não infere zero, false ou ausência física |
| `unknown` | valor desconhecido/indisponível/inválido, captura stale/desconectada ou suporte REAL não declarado |
| `equal` | valores conhecidos válidos e suporte declarado, dentro da tolerância; não prova compatibilidade física |
| `different` | valores conhecidos válidos e suporte declarado, fora da tolerância; não propõe alteração |

A precedência é a ordem da tabela, com `unknown` detalhado por `reason`. Perfis
incompatíveis bloqueiam até itens numericamente iguais. Chaves fora do perfil e EQ/HPF
ficam unsupported mesmo se só estiverem presentes em um lado. Uma ausência permanece
como ausência em snapshots stale; demais itens potencialmente comparáveis ficam unknown.

- Tipos são exatos: MUTE é boolean, nível é número/`'-inf'`. Não há coerção false↔0.
- Números de canais/AUX fora do registro, inclusive zero, não são remapeados. Identificadores
  fora da gramática `ParamKey` são rejeitados como entrada inválida, sem ecoar conteúdo.
- `−∞` é valor conhecido; dois `−∞` são iguais. `−∞` × finito é diferença, sem delta numérico.
  Ausente/desconhecido não é `−∞`, zero ou false. NaN, +Infinity e -Infinity crus não entram
  no formato wire; usar `'-inf'` ou o adaptador de snapshot interno.
- `deltaDB` é LAB menos REAL, somente para níveis finitos comparáveis. Não arredonda os
  valores de entrada nem a classificação para passos de fader. Exporta delta com 6 decimais.
- Tetos são campos de auditoria (`ceiling`, `aboveCeiling` por lado): valor acima do teto é
  sinalizado, não limitado. Dois valores iguais acima do teto continuam iguais e sinalizados.
- Revisões de LAB e REAL pertencem a processos distintos; não são comparadas como ordem
  entre si. Revisão conhecida do parâmetro acima da global invalida aquela célula.
- `DEGRADED_READ_ONLY` admite apenas valores conhecidos; ausentes não são completados.
  LOST/STOPPED/SYNCING/CONNECTING/DISCONNECTED ou `available=false` invalidam comparação atual.
- Captura stale, mais antiga que `maxAgeMs` ou no futuro em relação a `comparedAt` resulta
  em unknown. Valores retidos continuam visíveis como evidência histórica com o motivo;
  não devem ser rotulados como leitura atual. Uma **cena LAB arquivada** não vence por idade
  de criação; o retrato REAL e snapshots LAB continuam sujeitos à idade máxima.

Todo item e relatório possuem `applicable: false`; o relatório também informa
`hardwareVerified: false`. Mesmo `equal` e suporte `supported` não permitem escrita.

## EQ/HPF e AUX: limites conhecidos

O registro existente marca EQ/HPF/bypass como `simulated_only`; E8A respeita esse estado
sem inferir equivalência entre números. A base técnica incorporada pelo PR #18 documenta
que slope HPF não tem efeito na Ui16 e que o bypass LAB difere do bypass físico.
A comparação não altera nenhum desses comportamentos.

O perfil tem 6 buses AUX; isso não comprova seis saídas XLR independentes. O manual citado
na [matriz técnica](../sound-engineer/README.md) distingue quatro saídas dedicadas e
AUX 5/6 condicionais por fones. E8A não descobre fiação, pre/post, roteamento ou firmware.
`support` desconhecido precisa continuar desconhecido; não fabricar suporte físico.

## Exportação e sanitização

O relatório inclui só modelos de perfil validados, origens enumeradas, timestamps,
revisões, condições do retrato, chaves válidas, valores, capacidade do registro,
classificações, delta, tetos e explicações fixas. Não copia nome/descrição/ID da cena,
`actor`, IP/URL, metadados livres, PIN, tokens, chave de API ou logs. Campos extras dos
retratos/parâmetros são descartados; perfil/valores inválidos são recusados com mensagem
genérica, sem conteúdo do objeto. Markdown só usa chaves/modelos restritos e textos fixos.
Isso não remove a necessidade de revisar um arquivo antes de publicá-lo: níveis/mutes
são o conteúdo intencional do relatório e podem ser informação privada da banda.

## Integração futura (não implementada)

1. Depois de F0 físico/E6 e autorização específica, o único produtor REAL existente poderá
   fornecer um snapshot **já lido** pelo caminho autorizado somente leitura, com perfil,
   origem e captura verificáveis. E8A não recebe `RealMixer` nem inicializa `createApp`.
2. Registrar timestamp da captura, revisão global e por parâmetro. Reconexão ou buraco de
   eventos invalida o retrato anterior; pedir snapshot novo, não completar com valor LAB.
3. Propagar `available`, link e staleness; não reutilizar fotografia velha como estado atual.
   Definir fonte de relógio/TTL na integração, sem omitir `comparedAt` e sem interpretar
   revisões de processos diferentes como comparáveis.
4. Preencher suporte por parâmetro somente com evidência apropriada; separar observação
   de bus da existência/ligação física de saída. Não promover `simulated_only` por arquivo.
5. A tela futura poderá exibir/exportar comparação, sem aplicar. Qualquer aplicação futura
   pertence a outro escopo com políticas/revisões/aprovação próprias. Este relatório não
   é request de comando e não deve alimentar endpoints de escrita ou cenas.

## Testes e evidências

```text
npm run typecheck
npx vitest run test/lab-real-diff.test.ts test/lab-real-diff-offline.test.ts
npm test
npm run build
npm run test:web
npm run build:web
npm run test:e2e
```

Os testes cobrem fixtures, níveis/MUTE/AUX/master, limite de tolerância, −∞, desconhecidos,
ausências, tipos/faixas/revisões inválidos, parâmetros somente simulados/fora do perfil,
modelos/dimensões incompatíveis, tetos sem clamp, idade/ligação, sanitização, determinismo
e adaptação das cenas/estados existentes. Teste offline intercepta WebSocket/fetch e torna
qualquer import de RealMixer um erro: **zero sockets**. Teste separado usa a biblioteca
real com **WebSocket falso** para fornecer um snapshot: não cria socket adicional nem
chama connect/write/loadSnapshot durante comparação/exportação; **zero comandos mutantes**
(SETD/SETS/LOAD/SAVE). A coleta fake é separada da função pura.

As regressões E5/E7A/F0 devem continuar passando; não houve mudança nesses módulos.
Ficam pendentes, sem Ui16: F0 físico, firmware/perfil observado, aquisição REAL, canais/AUX
reais, medições de áudio, semântica real de EQ/HPF e recuperação física. Nenhum teste
simulado substitui essas verificações. Resultados de execução desta entrega constam no PR.

### Resultado local desta entrega

Linux, Node v24.22.1, npm 11.9.0; base `9faaf46`.

| Verificação | Resultado |
| --- | --- |
| `npm run typecheck` / `npm run build` | passou |
| Testes focados E8A | 41/41, dois arquivos |
| `npm test` final | 436/436, 40 arquivos; inclui regressões E5/E7A/F0 |
| `npm run test:web` | 79/79, 10 arquivos |
| `npm run build:web` | passou |
| `npm run test:e2e` | 60/60, oito arquivos |
| Comandos de exportação com fixture | JSON e Markdown gerados; 15 itens e todos não aplicáveis |
| `git diff --check` | passou |

O E2E usou Chromium do sistema por preload do ambiente, sem alterar configuração do
projeto ou da CI. Capturas da E7A regeneradas pelos testes foram preservadas em `work/`
e as imagens versionadas foram restauradas à main; não entram neste PR. A regressão
não exigiu alteração de testes existentes. CI Linux/Windows é registrada no PR.
Nenhuma validação física foi executada; todas as pendências físicas acima permanecem.
