# E9D — prévia de voz privada no celular, somente LAB

Issue #35. Base `0fa3845`, main com #31/#32 e dependências E9A/E9B/E9C.
Experimento separado da E9A, desativado por padrão. **Nenhum reconhecimento real
com whisper.cpp foi validado.** Não há parser, proposal, fila, aprovação ou escrita
no mixer neste fluxo. A transcrição é dado não confiável para revisão, sem Aplicar.

## Opt-in manual no Yoga

Primeiro concluir o [guia HTTPS/WSS privado E9B](16-E9B-HTTPS-LAN.md): hostname
estável, certificado confiável no Android e bind do proxy somente no IP Wi-Fi do
Yoga, backend loopback. Ethernet Ui16 e Wi-Fi músicos não são interligados pelo
MixAI. Não configurar túnel, internet, bridge, firewall ou CA automaticamente.

Em `config/config.local.yaml` (não versionado), incorporar manualmente:

```yaml
mixer:
  mode: lab
server:
  lan:
    enabled: false
  httpsLab:
    enabled: true
    origin: https://mixai.home.arpa:8443
    port: 8792
  privatePtt:
    enabled: true
    executable: 'C:\Tools\whisper.cpp\build\bin\Release\whisper-cli.exe'
    model: 'C:\MixAI-LAB-private\models\ggml-base.bin'
```

Os caminhos são exemplos, não arquivos fornecidos. Provisionar executável nativo
foreground e modelo multilíngue **manualmente**, conferir versão, licença/checksum
e recursos, conforme [E9C](17-E9C-OFFLINE-STT.md). Não usar modelos `.en`, wrappers,
URL, UNC ou discos sincronizados/remotos. Não há download, serviço externo ou upload
para nuvem. Para desativar: `server.privatePtt.enabled: false` e reiniciar LAB.
Configuração habilitada sem HTTPS LAB ou fora de LAB é recusada antes do mixer.
`SPEECH_SPIKE_ENABLED` da E9A permanece `false` e não controla este experimento.

Executar builds normais e `npm run serve:lab`, depois o Caddy opt-in já provisionado.
Não iniciar REAL. Entrar como operador pelo **HTTPS privado**; a área de voz aparece
somente se a entrada anunciar E9D. Flag OFF: rotas ausentes e nenhuma captura.
Sem executável/modelo, a área explica que whisper.cpp/modelo não estão configurados
e bloqueia o botão. Após provisionar/corrigir arquivos, recarregar a página.

## Captura e transporte

Pressionar e segurar (ou Espaço no botão focado) é o único início de captura.
Não se pede microfone ao carregar/reconectar. A UI informa preparação, microfone
ativo e transcrição. Soltar encerra tracks **antes** do upload; Cancelar descarta
áudio e prévia. Prazo de gesto de 10 s inclui preparação/permissão: exceder cancela,
não envia automaticamente. Não há captura contínua ou retomada automática.

Não é usado MediaRecorder. Web Audio + AudioWorklet da própria origem recebem
mono, fazem redução local para 16 kHz e PCM16, e o cliente cria RIFF/WAV. Contexto
entre 16 e 96 kHz; navegador sem API compatível falha claramente. Output do worklet
é silêncio, sem monitorar áudio nos alto-falantes. O worklet limita frames por si;
o controlador também impõe prazo/bytes. A redução por média é experimental, sem
alegação de qualidade acústica. Ao soltar, encerra hardware e drena a última fração
já capturada (até 500 ms de espera, sem nova captura), evitando truncar o lote final.

Upload binário `audio/wav`, no máximo 320044 bytes/10 s, PCM mono 16 bits 16 kHz,
sem multipart/conversor remoto. HTTPS fetch estritamente mesma origem, sem cookies,
cache ou redirects, bearer no header e ticket de uso único em header separado.
Referência, prompt, modelo, executável, destino, command ou intent não são enviados.
A resposta aparece em textarea readonly sem interpretar HTML, sem autocomplete ou
spellcheck, com a marca **“Prévia de voz — não é comando, nada será aplicado”**.
Resultados simulados são marcados como simulados; nenhum texto é auto-submetido.

Cancelar em pointercancel/perda de captura, blur, orientação, offline, ocultar/tela
bloqueada, pagehide, destruição, troca/revogação de sessão ou queda/reconexão WS
limpa prévia e recursos. Permissão que chega depois do cancelamento tem tracks
encerradas imediatamente. Prompt de permissão não pode ser fechado via JS.
Suspensão agressiva do SO pode atrasar timers/eventos: validar no aparelho; o limite
de frames evita acumular PCM indefinidamente e o backend também tem prazo próprio.

## Backend, permissões e ciclo de vida

Rotas `/api/speech/status`, `/ticket`, `/transcribe` e `/cancel` só são registradas
na entrada proxy privada LAB, com flag ON. Não existem na porta HTTP normal nem no
modo REAL/MOCK. Autenticação central por entrada permanece obrigatória: MCP é 401,
músico é 403, operador ativo é exigido. GET status não exige Origin (fetch de mesma
origem pode omiti-lo); todo POST exige Origin exato, além do Host/Origin da E9B.
Não há CORS permissivo. TLS termina no Caddy; não se confia em X-Forwarded-* para
provar TLS. Backend loopback do Yoga é uma fronteira local confiável, não uma porta
HTTP a abrir no Wi-Fi. O cliente também recusa HTTP mesmo em localhost seguro.

Ticket aleatório de 256 bits, vinculado à sessão, 20 s, uma tentativa, consumido
antes de parsear áudio. Um novo ticket invalida o anterior; não há retry automático.
Máximo de 3 tickets/minuto/sessão, 64 sessões de controle em memória e uma operação
pendente/inferência por servidor. Cancelamento/revogação invalidam tickets próprios;
WS autenticado encerrado também cancela o trabalho da sessão. Nada é broadcast.

Backend verifica MIME, bytes, RIFF/formato/duração antes do STT. O adaptador E9C usa
somente os caminhos locais do servidor, argumentos fixos/no-shell e cancelamento
nativo já existente. Prazo de operação de 15 s inclui recebimento/inferência;
encerramento nativo pode acrescentar a tolerância de cleanup da E9C. Cliente tem
prazo de upload/resposta de 20 s e cancelamento separado com limite de 3 s. Corpo
que excede limite recebe 413; ticket inválido/replay 409; quota 429; sem modelo 503
NOT_CONFIGURED. Não há fallback para reconhecimento remoto.

Sessão é revalidada enquanto processa e antes de devolver texto. Logout/expiração
abortam inferência; respostas atrasadas são descartadas também no cliente. Fechar
conexão/cancelar aborta sem disparar comando. Interrupção antes do fim do corpo
libera capacidade; encerramento normal aguarda limpeza da inferência.

## Privacidade e temporários

Não há gravação persistente, histórico, logs de áudio/texto/tickets ou armazenamento
no browser. Buffers próprios são zerados e referências descartadas ao concluir ou
cancelar. JS/OS não oferecem promessa de apagamento criptográfico de memória.

O whisper-cli exige caminho de arquivo: são usados temporários locais privados
`mixai-ptt-*` e os temporários internos E9C `mixai-stt-*`, com WAV sem metadados e
remoção em finally (sucesso, erro, cancelamento). Não são gravações exportadas ou
arquivos do projeto. Queda de energia/SIGKILL pode deixar resíduos no TEMP do
usuário: conferir/remover manualmente antes de reutilizar dados privados. Cleanup
ou processo que não possa ser encerrado é falha; não declarar exclusão bem-sucedida.
O binário deve ser confiável: E9C não é sandbox para executáveis maliciosos.

Nenhuma camada recebe acesso a mixer, parser, assistant, histórico ou queue. Não há
botão Aplicar, chamada de comando ou rota de aprovação no cliente de voz. Permissões
E2 e experiência do assistente permanecem independentes.

## Evidência automatizada e pendências manuais

Testes usam reconhecedor falso, WAV/PCM sintético e sockets; nunca usam modelo,
microfone físico, gravação real ou mesa. Cobrem flag/entrada/roles/Origin, limites,
codec, ticket/replay/quota, cancelamento, timeout, logout/expiração, limpeza e zero
chamadas de comando/assistant/write. UI cobre permissão negada/tardia, guards,
limites, reconexão, lifecycle e texto inerte.

E2E do navegador usa origem HTTPS **simulada** por rotas Playwright e worklet falso
para esse transporte (DevTools não intercepta o fetch nativo de AudioWorklet nessa
origem de teste). O asset DSP real é testado separadamente em localhost seguro, com
fonte sintética e AudioContext real. Caddy testa transporte TLS real com CA efêmera
explicitamente confiada pelo cliente Node: nenhuma validação TLS é desligada. Isso
não comprova cadeia confiável no Android, microfone ou STT real. Smoke Yoga mantém
voz OFF por padrão. Resultados de comandos e CI estão no PR.

Pendente de validação supervisionada, sem comandos na Ui16:

1. Chrome Android real + CA/hostname privados: isSecureContext, AudioWorklet, permissão
   e áudio inteligível; confirmar que não há request para origem externa.
2. Gesto touchscreen/segurar/soltar, denied/revoked, rotação, troca de app, tela
   bloqueada, modo economia, perda Wi-Fi/WSS, logout e retorno sem captura automática.
3. Modelo/binário local confiáveis: frase real, silêncio, ruído e negações; latência,
   acurácia e consumo no Yoga. Continuam **não medidos/não validados** nesta entrega.
4. Indicador de mic apaga ao soltar/cancelar; nenhuma amostra após o gesto; verificar
   TEMP limpo, preview só na sessão operadora, textos sem histórico/log.
5. Frontend via HTTPS real (sem simulação de rede), certificado aceito sem exceções;
   HTTP/REAL/MCP/músico/flag OFF devem continuar bloqueados.

Apenas o responsável faz merge após revisão técnica do ChatGPT, conforme AGENTS.md.
