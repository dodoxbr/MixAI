# E9A — voz em português, experimento isolado

Issue #16. Base: `aa98ace` (main com PR #14). O experimento não chama parser,
assistente, API de comandos, WebSocket nem mesa. Nenhuma transcrição executa ações.
Não há Web Speech API (cujo processamento pode ser remoto), gravação, upload,
modelos, pesos ou dependências nativas novos. Áudio não é persistido.

## Ativação e fronteiras

`web/src/app/speech/` contém o contrato, fixture, máquina de estados e painel.
`SPEECH_SPIKE_ENABLED` é um InjectionToken com fábrica `false`. Para um build
local de desenvolvimento, um desenvolvedor pode fornecer explicitamente
`{ provide: SPEECH_SPIKE_ENABLED, useValue: true }` em `app.config.ts`, importando
o token de `./speech/speech-spike.component`. Não versionar essa ativação no build
normal. Iniciar somente servidor LAB; entrar com PIN de operador. O painel confere
`hello.mode === lab`, `hello.role === operator` (perfil informado pelo servidor)
e conexão online; músico, mock e real ficam bloqueados. Não existe ativação por
URL, armazenamento local ou comando remoto. A guarda no cliente controla apenas
este experimento local, não substitui autorização de futuros endpoints de áudio.

O botão informa que o resultado é **simulado**. Pressionar solicita permissão e
abre somente áudio; não inclui vídeo. A fixture não lê o stream: devolve uma frase
pt-BR fixa ao soltar. Isso testa acesso ao microfone, não qualidade de STT.
Sem ativação não se pede permissão nem se abre microfone.

## Ciclo e contrato

`SpeechRecognizer.start(stream, {language: 'pt-BR', signal})` inicia uma sessão;
`finish()` retorna texto, idioma, indicador de simulação e confiança opcional.
Ausência de confiança não equivale a zero. Scores de provedores diferentes não
são comparáveis sem calibração. `cancel()` deve ser idempotente, descartar buffers
e interromper inferência. O controlador expõe estado e erro de acesso/transcrição;
a UI nunca encaminha o resultado. Um adaptador futuro deve cumprir AbortSignal,
ser descartável por sessão e liberar seus próprios workers/buffers ao cancelar.

Estados: idle → permission → listening → transcribing → done; falhas → error;
interrupções → cancelled. Só há uma sessão por gesto. Soltar antes de obter a
permissão cancela; caso o navegador entregue um stream depois, todas as tracks são
imediatamente encerradas. Não é possível fechar programaticamente o prompt de
permissão do navegador. Ao soltar, as tracks são encerradas **antes** de aguardar
transcrição. Cancelamento invalida também resultados atrasados.

`pointercancel`, perda de captura antes de soltar, rotação, blur, página oculta,
pagehide, offline, desconexão WebSocket, perda de perfil/LAB e destruição do
componente cancelam. Tela desligada depende dos eventos de lifecycle do Android;
não se promete execução de JavaScript com o processo suspenso. Um limite de 15 s
cancela sessões/prompt/inferência enquanto o event loop está ativo. Não há reinício
automático após retomada nem captura contínua. O navegador/OS deve encerrar a
captura ao suspender/descartar o processo; validar isso fisicamente antes de ampliar
o experimento. Eventos `ended` das tracks também cancelam.

## HTTPS/WSS na rede privada da banda

`http://<ip-wifi-yoga>:8790` normalmente NÃO é um secure context. Em Android,
`navigator.mediaDevices` pode nem existir; permissão não corrige HTTP inseguro.
`localhost` é exceção de confiança local: localhost no celular é o próprio celular,
não o Yoga. Não usar flags inseguras do Chrome ou ignorar alerta TLS como solução.
Checar `window.isSecureContext` e existência de `getUserMedia` antes da solicitação;
a permissão real pode falhar por bloqueio do usuário, SO, política ou dispositivo
ocupado. Não depender de `Permissions.query(microphone)` (suporte variável).

Proposta para avaliação, sem aplicar rede/certificados nesta entrega:

1. HTTPS no Yoga via reverse proxy (Caddy/nginx ou equivalente Windows), com nome
   estável resolvido no Wi-Fi privado. Proxy de `/`, `/api` e `/ws` para o servidor
   existente; preservar Upgrade/Connection de WebSocket e ajustar timeout. O cliente
   atual já escolhe `wss://` quando a página usa HTTPS; não introduzir áudio no `/ws`.
2. Certificado com SAN cobrindo exatamente o hostname (ou IP se usado). Opção A:
   domínio controlado + emissão pública por DNS-01 e DNS interno apontando para o
   Yoga; exige controle de DNS, renovação e proteção das credenciais, mas não expõe
   a aplicação à Internet. Wildcard/chave devem ficar fora do repositório.
3. Opção B: CA privada de laboratório (por exemplo, mkcert para estudo). Instalar a
   raiz explicitamente em cada Android e no Windows usado para testar. Distribuir
   apenas certificado público da raiz; manter chave da CA fora do notebook cliente,
   proteger chave do servidor, planejar expiração/revogação/remoção. Trust store de
   Android, navegador, WebView e apps podem divergir; confirmar no Chrome Android
   alvo e Edge/Chrome Windows, sem alertas TLS. Um self-signed não confiável não basta.
4. Revisar bind existente, firewall Windows de rede privada, autenticação PIN e
   origens. LAN privada não substitui TLS ou autenticação. Se o proxy estiver no mesmo
   host, preferir backend loopback e evitar acesso paralelo HTTP na validação;
   qualquer ajuste exige implantação manual futura, fora deste PR.

Alternativas locais: abrir `http://localhost` no Yoga para testar permissão real;
ou usar encaminhamento USB Android/Chrome DevTools para localhost (configuração
manual, confirmar secure context no aparelho). Nenhuma alternativa demonstra que
HTTP por IP LAN ficou seguro. Não foi configurado túnel público ou serviço externo.

Matriz manual antes de habilitar em LAB: Chrome Android via HTTP IP deve bloquear;
HTTPS confiável deve pedir permissão só ao pressionar; negar/revogar deve mostrar
erro; permitir e soltar deve apagar indicador de mic; repetir com rotação, tela
bloqueada, troca de app, queda Wi-Fi, logout, expiração e retorno. Conferir tracks
encerradas e ausência de requests contendo áudio. Em Windows testar cadeia/SAN,
WSS sem mixed content, PIN e reconexão. Registrar versões de SO/browser, duração
e comportamento. Estes testes físicos/certificados não foram realizados no executor.

## Vosk pt-BR × whisper.cpp

| Aspecto | Vosk | whisper.cpp |
| --- | --- | --- |
| Arquitetura | Kaldi, decodificação incremental local, gramática/vocabulário restrito conforme modelo | Whisper local, inferência por segmentos; streaming exige janela/buffering adicional |
| Português | Selecionar e avaliar modelo português compatível, incluindo sotaques pt-BR | Modelos multilíngues com idioma português; modelos `.en` não servem |
| Recursos | Modelo pequeno tende a menor RAM/latência, perda possível em ruído/vocabulário | tiny/base quantizados são candidatos; modelos maiores aumentam RAM/CPU e latência |
| Windows/Yoga | Validar bindings, arquitetura CPU, binários e empacotamento; alternativa sidecar | Build C/C++, toolchain, instruções CPU e backend de aceleração variam; benchmark no Yoga |
| Confiança | Pode fornecer score por palavra, dependente do modelo | Probabilidades/tokens não equivalem a confiança de comando |
| Riscos | Música, vazamento de PA, nomes próprios e canais fora do vocabulário | Alucinação em silêncio/música, custo de inferência e transcrições plausíveis incorretas |

Candidatos iniciais: Vosk para frases curtas com vocabulário limitado; whisper.cpp
para linguagem mais livre se a latência no Yoga for aceitável. Não há vencedor
medido. Modelos variam de dezenas de MB a GB; verificar licença, tamanho real,
RAM e origem de cada artefato antes de autorizar download. Não baixar pesos nesta
etapa. Comparar com corpus consentido em pt-BR: silêncio, música, fala distante,
nomes da banda, negações e números, medindo WER, taxa de alucinação, p50/p95 de
latência, CPU/RAM e cancelamento. Avaliar resampling PCM mono (frequentemente 16 kHz)
e workers/sidecar autenticado para não travar a UI. Um sidecar local é decisão
futura: não há endpoint, transporte ou permissão para enviar áudio neste spike.

Fontes técnicas (referência, sem benchmark nesta entrega):
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts
- https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events
- https://alphacephei.com/vosk/ e https://alphacephei.com/vosk/models
- https://github.com/ggml-org/whisper.cpp
- https://github.com/FiloSottile/mkcert (limites e proteção da CA)

## Integração futura ao assistente

Fluxo previsto: voz → transcrição editável → parser → cartão de proposta → aprovação
humana E2. Mostrar origem/idioma, incerteza e simulação; exigir revisão explícita
antes de encaminhar texto ao parser. Não chamar `ActionsService`, `LiveService.send`,
`assistant()` ou endpoints de execução a partir de eventos de reconhecimento.
Cancelamento deve invalidar sessão e proposta em preparação. Revalidar perfil,
modo, revisão do estado e política no servidor antes de qualquer proposta/aplicação.
A skill do técnico de som, F0, E6/E8, RealMixer e núcleo/protocolo de EQ permanecem
fora do escopo.

## Validação

Testes mock cobrem secure context ausente, API ausente, permissões negadas,
dispositivo indisponível, autorização/flag, release, permissão/transcrição tardias,
limite de tempo e lifecycle do painel. Não requerem microfone físico. O resultado
real de comandos/builds e limitações do executor está registrado no PR; isso não
substitui a matriz Android/Windows e HTTPS acima.
