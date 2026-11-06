# E7B — Presets orientativos de EQ, exclusivos do LAB

Issue [#33](https://github.com/dodoxbr/MixAI/issues/33). Depende do [E7A](11-E7A-EQ.md) e da base técnica Sound Engineer. Não depende de F0 físico nem implementa E6.

**SIMULADO — somente LAB; referência inicial, não medida na Ui16.** Estes são presets editoriais do MixAI, não snapshots/presets oficiais Soundcraft. Não há captura de áudio, análise acústica, RTA ou garantia de melhora. Posição do microfone, DI, instrumento, afinação, execução e acústica precisam ser avaliados pelo operador.

## Usar

1. Entre como operador no servidor LAB e abra **EQ LAB**. Escolha o canal explicitamente; o instrumento do preset não remapeia canais pelo nome.
2. Selecione um **Preset orientativo**. Nada é enviado ou aplicado nesse passo. Leia propósito, justificativa, contraindicações e verificações de captação reaproveitadas da base Sound Engineer.
3. Compare a curva azul contínua (EQ atual) com a amarela tracejada (proposta), ambas estimadas. A tabela mostra os 15 valores atuais/propostos, inclusive os inalterados, com destaque textual para diferenças. HPF em 20 Hz significa desligado no modelo LAB.
4. Decida entre **Cancelar preset** ou **Aplicar no LAB**. Aplicar substitui as quatro bandas, HPF e bypass do canal selecionado por um único lote. Todos os presets desligam o bypass; esse efeito aparece na comparação. Não alteram nível, mute ou outros canais.
5. Confira os valores sincronizados e a resposta do servidor. **Desfazer última ação LAB** usa o histórico causal existente, também acessível pela Mesa. Pode haver uma ação posterior de outro operador: confira a última ação antes de desfazer.

Alteração do EQ recebido (incluindo revisão), canal, sessão, servidor, permissão ou disponibilidade da conexão invalida a prévia. Edição manual/arraste/reset também a descartam. É necessário selecionar novamente e conferir. Não existe reaplicação automática, armazenamento da seleção ou reenvio ao reconectar. Se o resultado de aplicação for incerto, a mensagem existente pede conferir valores antes de repetir.

A invalidação da prévia é uma proteção da interface sobre eventos já recebidos. O comando E7A continua serializado pelo servidor e não introduz reserva/bloqueio de canal nem comparação atômica da prévia com escritas concorrentes ainda não recebidas. Entre operadores, a ordem de execução do comando existente continua valendo.

## Biblioteca editorial inicial

Todos os filtros de banda são paramétricos peaking com Q 1. As outras três bandas ficam com ganho zero; não são três intervenções adicionais. A inclinação do HPF é 12 dB/oitava no modelo. Não representa uma topologia confirmada da Ui16.

| Preset | HPF LAB | Único corte de banda | Intenção e limite principal |
| --- | --- | --- | --- |
| Cavaquinho | 80 Hz | −2 dB em 3 kHz | Ensaiar menos aspereza após revisar captação; pode reduzir ataque/corpo. |
| Violão / 7 cordas | 40 Hz | −1 dB em 250 Hz | Corte discreto de corpo acumulado, preservando baixarias; avaliar nota mais grave. |
| Vozes | 70 Hz | −1,5 dB em 300 Hz | Hipótese de corpo/proximidade; pode enfraquecer voz grave e não substitui de-esser. |
| Surdo | Desligado (20 Hz) | −1,5 dB em 250 Hz | Ensaiar menos ressonância sem boost de subgrave; pode remover corpo musical. |
| Tantã | 30 Hz | −1 dB em 300 Hz | Hipótese de separação do surdo; não apagar sustentação desejada. |
| Pandeiro | 40 Hz | −1,5 dB em 5 kHz | Suavizar platinelas preservando pele; pode piorar instrumento abafado. |

Os números são escolhas editoriais conservadoras, **não prescrições extraídas das referências** nem frequências medidas na banda. Sem validação em ensaio. As referências de princípios vêm diretamente de `instruments.ts`/`sources.ts`: Yamaha *Equalization* (Peak EQ, filtros, separação) e Shure *Microphone Techniques for Live Sound Reinforcement* (pp. 20–21, captação/experimentação). As verificações e avisos por instrumento são reaproveitados, sem copiar regras do diagnóstico. Fontes e links são exibidos junto da prévia; consulta e aplicação não dependem de API externa.

## Implementação e limites de segurança

- `src/knowledge/sound-engineer/eq-guides.ts`: catálogo tipado, ligação às referências e função pura de comparação/conversão dos 15 parâmetros E7A. Não é registrado no diagnóstico, no MCP ou nas ferramentas de IA. Conversar com o Sound Engineer não seleciona/aplica presets nem gera propostas de alteração.
- `web/src/app/eq/eq.component.ts`: seleção temporária local, sobreposição da curva RBJ E7A, comparação e botão humano explícito. Usa o mesmo `set_lab_eq` de E7A, com validação integral no `ParamRegistry`, autorização e bloqueios LAB no servidor/controlador. Não há nova rota, comando, credencial ou caminho REAL. Músico e agente continuam sem permissão de EQ, inclusive por HTTP/WS forjados. Fora do LAB, o catálogo não aparece.
- Modelo E7A inalterado: quatro bandas, HPF e bypass `simulated_only`, `applicableToMixer: false`. Não simula compressor, AFS ou GEQ. Os limites de Q/frequência/ganho não comprovam equivalência dos filtros com firmware físico.
- Estado confirmado vem do servidor, sem aplicação otimista. Parâmetros aplicados persistem no estado LAB e nas cenas existentes com status `incompatible` para REAL. Não se persiste um novo formato de preset/cena e não se amplia o carregamento E5.
- Autenticação, permissões, rede, Soundcraft REAL, fala/STT e comandos diretos de volume/mute não foram modificados. Nenhuma escrita física ou ajuste automático está autorizado por esta entrega.

## Verificação

Novos testes: `test/eq-guides.test.ts`, `web/src/app/eq/eq.component.spec.ts` e `test/e2e/eq-guides.test.ts`. Cobrem catálogo/faixas/capacidades, curva finita e diff incluindo bypass/HPF, ausência de escrita na seleção/cancelamento, aplicação explícita única, undo em lote, persistência LAB/cena, HTTP/WS, recusa de músico/agente/REAL sem escrita, invalidação por revisão/canal/sessão/conexão e telas Yoga touch/celular retrato/paisagem. Regressões: typecheck, build, core, web, build web, E2E, smoke Yoga e HTTPS/WSS com Caddy. Resultados exatos e CI ficam no relatório do PR.

Validações em navegador com emulação touch não substituem Yoga/celular físicos. Sem teste acústico, firmware, rede da banda ou mesa real. F0 físico permanece supervisionado; E6 não iniciada.
