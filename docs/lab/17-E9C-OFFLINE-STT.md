# E9C — bancada offline pt-BR com whisper.cpp

Issue #28. Branch `feature/e9c-offline-stt-harness`, base `10c2b48` da main,
com #23, #24 e #25 incorporados. Esta bancada é uma CLI experimental de **arquivo
local autorizado**, separada do app, servidor, parser, MCP e mesa. Não tem captura,
endpoint de upload, conversão automática ou reconhecimento em produção.

**Reconhecimento real NÃO validado nesta entrega:** não foram fornecidos modelo
whisper.cpp e gravações autorizadas. Nenhum modelo, binário STT ou áudio foi baixado.
Testes e demo usam silêncio PCM sintetizado e um processo simulador, cuja resposta
fixa não é reconhecimento. Não interpretar WER/latência da simulação como benchmark.

## Arquitetura e isolamento

- `src/speech/whisper-file.ts`: contrato `FileSpeechRecognizer` e adaptador de
  `whisper-cli` para um WAV. Executável/modelo precisam ser arquivos locais existentes
  em caminhos absolutos; não existe busca em PATH, URL ou fallback de download.
- `src/speech/wav.ts`: verifica RIFF/WAVE, tamanho declarado, chunks e formato; cria
  cópia canônica sem metadados em diretório temporário exclusivo por execução.
- `src/speech/command.ts` e `src/speech-cli.ts`: opt-in explícito e saída local.
- `src/speech/corpus.ts` e `metrics.ts`: referências textuais e cálculos puros.
- E9A web permanece intacta, com `SPEECH_SPIKE_ENABLED = false`. Seu contrato usa
  stream do navegador; este usa arquivo Node. A separação evita fingir que o browser
  pode executar um binário nativo. Uma futura ponte exige trabalho/autorização próprios.

Fluxo atual: arquivo autorizado → validação → processo local → texto não confiável
+ métricas locais. **O texto termina aqui.** Nenhuma transcrição é encaminhada ao
parser, assistente, propostas, confirmação ou comandos, mesmo se disser “aumenta”,
“aprova”, contiver sintaxe de shell ou negar uma ação. Não se altera volume, mute,
EQ, master ou configuração da Ui16. Não iniciar `serve:real` ou F0 para esta bancada.

## Pré-requisitos manuais no Yoga Windows

1. Instalar as dependências normais do projeto (Node 22+) e executar `npm run build`.
   O harness não adiciona dependência nativa obrigatória ao MixAI.
2. Obter **manualmente**, com aprovação do operador, uma versão confiável do
   [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Conferir origem, release,
   checksum, arquitetura x64/ARM e requisitos CPU/toolchain. Seguir o build Windows
   oficial (CMake/MSVC) ou binário oficial compatível. Preferir `whisper-cli.exe`
   nativo em primeiro plano, não `.cmd`, `.bat`, PowerShell, servidor ou wrapper.
   Esta entrega não instala/compila esse programa automaticamente.
3. Escolher e obter separadamente um modelo **multilíngue** compatível com a mesma
   versão do CLI. Modelos `.en` não servem ao português. tiny/base e quantização são
   candidatos a estudo, sem recomendação de desempenho medido. Conferir checksum,
   licença dos pesos e requisitos de RAM/disco. O código whisper.cpp e modelos
   Whisper têm licenças a verificar na versão/origem escolhida; não presumir que
   qualquer modelo de terceiros pode ser redistribuído. Guardar pesos fora do Git.
4. Guardar executável, modelo, áudio e referência privados em disco local do Yoga,
   fora do checkout e de pastas sincronizadas com nuvem. Não usar UNC, URL, symlink,
   unidade SMB mapeada ou ferramenta que envie telemetria/áudio. Os caminhos finais
   são conferidos; uma letra de unidade de rede mapeada não é detectável portavelmente
   por este código — cabe ao operador garantir que os arquivos são locais.
5. Providenciar WAVs **com autorização para este teste**, referência humana e contexto
   (sotaque, distância, ruído). Não copiar gravações de ensaio sem consentimento.
   Não versionar áudio, modelos, transcrições reais, referências privadas ou métricas
   que identifiquem pessoas. Um nome como o do vocalista pode ficar só na referência
   privada; o corpus versionado usa papéis genéricos, não nomes pessoais.

`-l pt` seleciona português; `language: pt-BR` no resultado expressa o idioma alvo,
não comprovação de sotaque/detecção correta. A bancada usa CPU (`-ng`) e 2 threads
por padrão, ajustável de 1 a 8. GPU/BLAS/quantização e modelo influenciam consumo;
não há limite de RAM do processo imposto pelo Node. Validar a combinação no Yoga.

### Formato aceito

RIFF/WAVE PCM **16 bits little-endian, mono, 16.000 Hz**, fmt de 16 bytes, data
não vazio, até 60 s e 4 MiB totais. RF64, estéreo, float, MP3 e arquivos truncados
são recusados. Não há conversão no harness. Se houver fonte autorizada diferente,
um operador pode converter **manualmente**, com FFmpeg local já instalado e
explicitamente selecionado, por exemplo no PowerShell:

```powershell
& 'C:\Tools\ffmpeg\bin\ffmpeg.exe' -i 'C:\MixAI-LAB-private\authorized\source.wav' -map_metadata -1 -ac 1 -ar 16000 -c:a pcm_s16le 'C:\MixAI-LAB-private\authorized\cavaco.wav'
```

Não executar conversão com fonte remota. Conferir duração/conteúdo e descartar
arquivos convertidos conforme o consentimento. A bancada não chama FFmpeg.

## Execução local

Em PowerShell **interativo**, após o build, substituir os caminhos por arquivos
reais já provisionados (os exemplos não são arquivos fornecidos pelo projeto):

```powershell
npm run speech:file -- --executable 'C:\Tools\whisper.cpp\build\bin\Release\whisper-cli.exe' --model 'C:\MixAI-LAB-private\models\ggml-base.bin' --audio 'C:\MixAI-LAB-private\authorized\cavaco.wav' --authorize-audio --local-output --case cavaco-fones
```

As duas flags confirmam, respectivamente, autorização de leitura do arquivo e saída
para o terminal local. Sem elas, com stdout redirecionado ou `CI` definido, a CLI
recusa executar. Ela não grava relatório em disco nem imprime caminhos. Por padrão,
só mostra métricas; incluir `--show-transcript` **separadamente** para exibir texto
no terminal local. Não usar terminal com gravação/transcrição compartilhada.

Para referência própria (incluindo nomes autorizados), usar `--reference-file` com
arquivo UTF-8 local de até 16.000 bytes em vez de `--case`. A referência não é
impressa nem enviada ao decodificador: serve somente para calcular qualidade depois
da transcrição, evitando enviesar o teste. Sem referência, `quality` é `null`.

Opções: `--timeout-ms 30000` (10–120000 ms, só processo) e `--threads 2` (1–8).
O prazo inclui startup/inferência/saída; não inclui leitura inicial do WAV. Ctrl+C
ou SIGTERM cancelam a sessão. `--help` mostra sintaxe sem executar o processo.
Códigos de saída: 0 sucesso, 130 cancelado, 124 timeout, 1 demais falhas. Erros
são códigos genéricos (CONFIG, NOT_AUTHORIZED, INVALID_AUDIO, FILE_UNAVAILABLE,
PROCESS_FAILED, SPAWN_FAILED, OUTPUT_LIMIT, INVALID_OUTPUT, CLEANUP_FAILED), sem
repassar stderr, caminhos ou texto do processo.

### Demo sem modelo

```powershell
npm run speech:demo
npm run test:speech
```

A demo requer terminal local fora de CI. Gera silêncio sintético e modelo **falso**
num temporário, chama o simulador de protocolo e remove os arquivos no final.
Resultado tem `simulated: true`; uma frase fixa pode ter WER zero apesar do áudio
ser silêncio — isso valida **somente o encanamento**, nunca a precisão de STT.
Os testes automatizados funcionam sem microfone, whisper.cpp ou pesos instalados.

## Processo, limites e limpeza

Spawn sem shell, binário absoluto, cwd temporário isolado, sem stdin, argumentos
fixos `-m`, `-f`, `-l pt`, `-oj`, `-of`, `-np`, `-nt`, `-ng`, `-t`.
Não existe opção para argumentos arbitrários, prompts, tradução, servidor ou URL.
O JSON é lido somente do arquivo de saída esperado: stdout/stderr são drenados e
descartados, limitados a 64 KiB combinados. Não há parsing de stdout ou execução de
conteúdo. JSON até 256 KiB, 512 segmentos e 16.000 caracteres de texto; rejeita
JSON/UTF-8 inválidos, controles de terminal e substituições bidi. Saída fica como
dado inerte, sem confiança de comando ou score probabilístico inventado.

Diretório exclusivo por execução, WAV copiado com acesso restrito; arquivos de
origem não são alterados. Não copiar pesos grandes para o temporário. Resolve só
quando o processo fecha, depois remove o diretório mesmo em falha/cancelamento.
POSIX usa grupo de processos, SIGTERM e escalada SIGKILL após 250 ms; Windows usa
`SystemRoot/System32/taskkill.exe /PID <pid> /T /F`, sem shell, para a árvore.
Há watchdog que retorna CLEANUP_FAILED se o SO não concluir o encerramento, sem
reportar cancelamento como bem-sucedido. Se isso ocorrer, interromper a bancada,
verificar processos no Gerenciador de Tarefas e os temporários antes de repetir.

O executável precisa ser confiável, nativo e em primeiro plano. Isto **não é um
sandbox de binários maliciosos**: o harness não faz requisições de rede, mas um
executável arbitrário teria os privilégios do usuário. Não garante contenção de
filhos que deliberadamente se desvinculem da árvore (especialmente no Windows);
uma garantia de SO mais forte requer Job Objects/sandbox/firewall administrado em
outra etapa. Não executar wrappers que retornem antes da inferência. Nenhuma regra
de rede ou confiança TLS é alterada. Os testes verificam encerramento de uma árvore
normal de processos simulados e ausência de imports/chamadas de rede do harness.

## Corpus e avaliação real futura

`src/speech/corpus.ts` lista IDs, referências e categorias em texto: cavaco-fones,
voz, surdo, negacao, negacao-volume, ambiguo, destino, homofono, violao, pandeiro,
coloquial, silencio e ruido-sem-fala. São referências de teste, **não intenções de
execução**. Não se atribui ação a “Não altere nada” ou a uma frase ambígua.

Preparar manualmente gravações consentidas de cada caso: voz natural, variações
regionais/sotaques, ritmo normal/rápido, instrumentos/vazamento de PA, distância e
silêncio/ruído **sem fala**. Rotular a referência ouvindo o áudio; repetir cada caso
e registrar identificação anônima da amostra, versão/hash do binário/modelo,
quantização, threads, SO/CPU, duração, referência e hipótese em armazenamento local
protegido. Não fabricar um benchmark usando frases de texto como se fossem áudio.

| Medida | Implementação / situação nesta entrega |
| --- | --- |
| Tempo de processamento / RTF | Medido por execução: spawn até close; RTF = segundos de processamento / duração de áudio. Valores reais de STT pendentes |
| WER | Distância de edição em palavras / palavras de referência; lowercase pt-BR + NFKC, ignora pontuação/espaços, preserva acentos/números. Até 512 palavras por lado |
| Referência vazia | WER null; qualquer palavra gera falsePositiveOnSilence=true. Não suprime tokens de silêncio para maquiar alucinação |
| Erros de processo | Códigos de falha/cancelamento/timeout, sem conteúdo privado |
| p50/p95 | Função summarizeMeasurements usa nearest-rank de execuções bem-sucedidas e conta falhas separadamente. Amostragem real pendente |
| CPU/RAM | null, pendentes; medir separadamente com ferramentas locais Windows, sem inventar valores a partir do processo Node |

Uma execução não estima estabilidade p95. Aquecer/separar primeira carga, repetir
amostras e não misturar simulação com resultados reais ou modelos diferentes.
Verificar manualmente erros de negação, nomes, números e falsas palavras no silêncio,
além de WER médio. A saída é sempre `validation: operator_review_required`, mesmo
com processo retornando 0: um texto plausível não comprova áudio correto.

### Comparação com Vosk planejada

Usar o mesmo corpus/áudio consentido, mesma CPU e política de threads; comparar WER,
negações/nomes, falsos positivos no silêncio, p50/p95/RTF, falhas, cancelamento e
CPU/RAM. Vosk tende a oferecer decodificação incremental e vocabulário restrito;
Whisper usa segmentos e pode alucinar em silêncio/música. São hipóteses de arquitetura,
não resultados medidos. Vosk, seus modelos e dependências não foram instalados nesta
entrega. Não declarar vencedor até medir no Yoga com versões/licenças registradas.

## Validação e limites desta entrega

`npm run test:speech` cobre protocolo simulado, no-shell/posições de argumentos,
consentimento, CI/redirecionamento, stdout adversarial, WAV inválido/limites,
modelo ausente, saída inválida/excessiva, falhas de spawn/exit, cancelamento prévio,
timeout, árvore de processos, concorrência, limpeza, WER e percentis. O teste de
symlink POSIX é marcado como ignorado no Windows, onde criar symlink pode exigir
privilégios; os demais testes de arquivo não regular rodam nos dois sistemas.
A CI padrão cobre typecheck/build/testes em Windows e Linux; a regressão UI/E2E e
HTTPS/WSS existente deve permanecer verde. Resultados finais no PR.

Não validados aqui: inferência real, precisão/latência/CPU/RAM com modelo, sotaques,
ruído de ensaio, licenças de um artefato ainda não escolhido e execução física no
Yoga. Não houve uso de mesa, microfone, captura contínua, áudio externo, parser ou
mudança em E9A/E9B/F0/E6/E8/skill.

Compatibilidade de protocolo conferida por leitura do
[CLI upstream](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp),
blob `16f50c0233f79b461ef73c87f43c4ad8687da5f5`: flags acima, sufixo `.json` e
`transcription[].text`. Essa inspeção não substitui executar a versão/modelo
selecionados no Yoga; alterações de schema/flags falham sem fallback para stdout.
