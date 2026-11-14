# AUX SENDS — leitura de seis barramentos, uma só mesa

Branch independente do PR de MUTE/cadastro (#105), baseada na main `4f221e6` com
#100–#104. Não contém o editor de nomes nem altera os executores/gates REAL.

## Experiência

A navegação do **operador** passa de FONES para **AUX SENDS**. Os botões horizontais
AUX 1…6 selecionam a visualização. Fader, dB e MUTE dos canais cadastrados reutilizam
os componentes e o mesmo snapshot/WS do MixAI; não há outro mixer, estado físico ou
executor. O celular mantém os faders, com rolagem horizontal interna dos canais.
A interface simplificada dos músicos e suas permissões permanecem intactas.

AUX1 conserva o aviso do retorno **compartilhado HA800**. Esse texto não é aplicado
a AUX2…6. Nomes locais existentes aparecem no cabeçalho; sem cadastro, não se inventa
um nome físico. Navegar não registra AUX, não altera roteamento e não envia comando.

## Diferenças em relação à interface oficial

| Área | Soundcraft oficial | MixAI nesta entrega |
|---|---|---|
| Seleção | AUX 1…6 | Seis candidatos de navegação Ui16; disponibilidade depende dos campos recebidos |
| Envios | Estado da mesa | Mesmo estado espelhado, somente quando há amostra real no modo REAL |
| MUTE | Controle da mesa | Indicador observado; REAL desabilitado para toque/arraste direto neste ensaio |
| PRE/POST | Controle suportado pela interface oficial | **Indisponível no contrato integrado**; label explícito por canal, sem botão/setter |
| Master AUX | Master do barramento | Área separada “MASTER AUX N — Indisponível”; não reutiliza `master.level` do PA |
| Master PA | Mix principal | Mantido apenas na aba PA, com seu valor independente |
| Sem amostra | Depende da mesa | “Desconhecido”/“MUTE — ?”; sem thumb no fader e sem `aria-pressed=false` inventado |
| Medição | Funções próprias da Ui16 | Fader observado não é áudio medido; LAB/MOCK continua explicitamente simulado |

A biblioteca 7.1.0 possui streams de PRE/POST e master AUX, mas isso não significa
que o backend atual publique tais dados. Não acrescentamos endpoints/payloads ou
valores simulados para preencher essas lacunas. Sem evidência integrada, permanecem
indisponíveis. Os gates supervisionados e os fluxos humanos #100–#104 não mudam.

## Observabilidade sem promover capacidades

`keysFor` mantém exatamente os parâmetros **obrigatórios** do cadastro atual. Só
amplia os **watched** para os AUX no limite já definido do modelo (Ui16: seis), para
os canais resolvíveis. Usa `observeParam`/`Ui16RealBridge` existentes, com os caminhos
comprovados na biblioteca: `i.(CH-1).aux.(AUX-1).value` e `.mute`.

- Uma opção visível não comprova saída física, patch, dados presentes ou permissão.
- AUX2…6 não passam a ser cadastrados ou graváveis por aparecerem no seletor.
- READY continua vinculado à sincronização obrigatória; ausência de barramento
  opcional não impede a leitura do PA/AUX1.
- Sem frame para um parâmetro, a leitura REAL permanece desconhecida. `0` real no
  fader é normalizado e pode significar −∞; ausência de frame **não** significa −∞.
  Da mesma forma, MUTE não recebido **não** significa `false`.
- Valores de cada barramento ficam em suas próprias chaves. Seleção e atualizações
  externas não alteram o PA, o master PA ou outro AUX.
- Queda/reconexão invalida os valores antigos; frames do socket aposentado são ignorados.
- LAB/MOCK pode possuir valores simulados nos barramentos. Eles não são apresentados
  como observação física; AUX não cadastrado fica sem escrita direta na nova tela.

O operador confirmou faders/MUTE PA e AUX1 funcionando após Ctrl+F5. A decodificação
não foi invertida nem substituída por polling. Os demais AUX ainda dependem de
validação física dos frames na instalação do operador; nenhum teste desta entrega
se conecta à mesa.

## Testes e limites

`test/ui16-aux-observation.test.ts`: seis caminhos opcionais, cadastro/required
inalterados, amostras independentes, desconhecido versus −∞/false e reconexão sem
SETD. Teste Angular: seleção sem comando e estado PA preservado. E2E com a biblioteca
real e socket falso: notebook/Yoga, tablet e celular, troca de AUX, atualizações
externas, estados desconhecidos e dimensões de toque/rolagem.

Os testes existentes do operador foram atualizados para a navegação AUX SENDS e
para faders em retrato; as verificações de autorização e dos músicos não foram
reduzidas. A documentação/screenshot antiga que mostra FONES na Mesa pode retratar
a UX anterior; não se versionam imagens regeneradas incidentalmente pela regressão.

Validação supervisionada futura: conferir PA e AUX1 primeiro; selecionar AUX2…6
na interface oficial e comparar apenas os campos realmente publicados; observar
rótulos desconhecidos se não houver dados. Não habilitar escrita, inferir master
AUX/PRE/POST ou alterar os gates para completar a tela.
