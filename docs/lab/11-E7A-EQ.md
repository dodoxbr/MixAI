# E7A — Equalizador visual do laboratório

Escopo: [Issue #12](https://github.com/dodoxbr/MixAI/issues/12), incremento visual da E7. Abra **EQ LAB** na Mesa como operador e escolha um canal. Há quatro bandas paramétricas, HPF, bypass e reset do canal. Frequência, Q e ganho também podem ser digitados; arraste os pontos para frequência/ganho ou use as setas com o ponto focado. A prévia acompanha o gesto; soltar aplica um único comando. Cancelar o ponteiro descarta a prévia.

**SIMULADO — somente laboratório. Curva estimada, não medida na Ui16 real.**

## Modelo numérico

- Quatro filtros digitais RBJ `peaking`, frequência de amostragem assumida de **48 kHz**. Essa é uma convenção do modelo, não uma afirmação sobre o processamento interno da Ui16.
- HPF Butterworth de ordem 2, 4 ou 6, respectivamente 12, 24 ou 36 dB/oitava, como cascata de seções RBJ. Os Qs de cada seção vêm dos polos Butterworth: `1 / (2 cos((2k−1)π/(2N)))`.
- Todas as inclinações têm magnitude **−3,0103 dB na frequência de corte**. Não são cópias de um filtro Q=√½: repetir esse filtro daria −6/−9 dB no corte para 24/36 dB/oitava.
- HPF em **20 Hz = desligado**, conforme a convenção que já existia em `ParamRegistry`. Bypass desliga bandas **e** HPF, mantendo seus valores.
- Ganho zero com HPF desligado produz curva plana. O ganho de uma banda isolada na frequência central coincide com o ganho configurado. A soma das bandas e do HPF é feita em dB.
- Gráfico logarítmico de 20–22050 Hz, janela vertical de ±24 dB; respostas que excedem essa janela são recortadas visualmente. A função matemática não tem esse recorte.
- Os testes comparam o modelo com `BiquadFilterNode.getFrequencyResponse` em Chromium, sem tocar áudio. Para `highpass`, Web Audio expressa Q em dB; o teste converte `20 log10(Q)`. Para `peaking`, Q é linear.

Isso não modela filtros medidos, firmware ou topologia real da Ui16. Não há análise de áudio nem RTA.

## Estado e comandos

`set_lab_eq { channel, values }` recebe um lote parcial de chaves completas, por exemplo `ch.1.eq.b1.gain`. `reset_lab_eq { channel }` restaura os 15 parâmetros de EQ/HPF/bypass do canal aos `labDefault` do registro. Ambos são exclusivos de operador; músico e agente são recusados por HTTP e WS. Servidor e controlador recusam modo diferente de LAB antes de escrever.

O controlador valida o lote inteiro no `ParamRegistry`, incluindo pertencimento ao canal configurado, antes da primeira escrita. Aplica pela fila e pelo caminho `applyChanges` existente. Revisões, eventos, histórico, desfazer causal e persistência atômica são os mesmos do restante do Lab. Não há outro armazenamento de parâmetros no frontend; somente a prévia do gesto ainda não enviado é local. Reset e arraste são um item de desfazer cada. Os tetos de volume continuam valendo para níveis no desfazer, sem serem confundidos com unidades de EQ.

As cenas E5 continuam salvando os parâmetros simulados, com a mesma matriz de capacidades. **Este incremento não amplia o carregamento de cenas nem a aplicabilidade de EQ à mesa.** `simulated_only` continua inalterado. Não foram alterados `RealMixer`, protocolo real, rede, MCP, presets, skill, E6 ou E8; não foi criada a tool `propose_eq`.

## Verificação

Comandos: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:web`, `npm run build:web`, `npm run test:e2e`. O fluxo de CI existente executa núcleo/interface em Windows e Linux e E2E em Linux. Para gerar novamente as capturas específicas, após o build web: `npm run test:e2e -- test/e2e/eq.test.ts`.

Os testes novos cobrem curva plana, picos, HPF nas três inclinações, bypass, limites do registro, lotes inválidos sem escrita parcial, sincronização de dois clientes, persistência com uma nova instância de LabMixer, reset/undo, HTTP/WS forjados, modo REAL negativo com zero chamadas ao adaptador de escrita, parâmetros desconhecidos, conexão indisponível, teclado e layouts móveis. A regressão completa inclui cenas E5.

Capturas em Chromium com emulação touch; não equivalem a teste físico de um aparelho Android:

- [Yoga 1536×960](screenshots/e7a/yoga.png)
- [Android retrato, Pixel 7](screenshots/e7a/android-portrait.png)
- [Android paisagem, 915×412](screenshots/e7a/android-landscape.png)

Os arquivos com sufixo `-controls.png` mostram o fim do painel rolável, incluindo as bandas 3/4 e HPF nos celulares.

No ambiente Windows restrito, a suíte multiprocessos de `owner-lock` precisou ser executada fora do sandbox: `os.userInfo` dos processos filhos falhava com `uv_os_get_passwd/ENOMEM`. Fora dele, a suíte completa passou. Nenhum teste usa a mesa física.
