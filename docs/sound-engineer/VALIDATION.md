# Validação da primeira entrega

Ambiente em 06/11/2026: Linux, Node.js v24.22.1, biblioteca
`soundcraft-ui-connection` 7.1.0 já instalada conforme lockfile.

| Verificação | Resultado |
| --- | --- |
| `npm run typecheck` | Passou, incluindo fontes e testes |
| `npm run build` | Passou |
| `npm test` | 362 testes passaram em 36 arquivos, incluindo 27 novos |
| `npm run test:web` | 49 testes passaram em 7 arquivos |
| `npm run build:web` | Passou |
| `PLAYWRIGHT_BROWSERS_PATH=/workspace/MixAI/work/playwright npm run test:e2e` | 55 testes passaram em 7 arquivos após instalar Chromium em `work/` |
| Exemplo `diagnose(examples.cavacoEstridente)` via `tsx` | Orientação teórica, confiança baixa, análise de áudio não realizada, 3 recomendações textuais |
| `git diff --cached --check` | Passou |

Os novos testes verificam determinismo, preservação da entrada, falta de contexto,
recusa de evidências inválidas/duplicadas e capacidades não entregues, distinção
entre relato e controles/medidores simulados, referências, cobertura dos
instrumentos e isolamento do fluxo de produção.

A tentativa inicial de `npm run test:e2e` falhou no lançamento do navegador:
Chromium headless shell 1243 ausente. As 7 suítes falharam nos hooks e os 55
cenários não executaram. O teardown existente também tentou fechar o navegador
não inicializado. Nenhum teste foi modificado para ocultar esse problema.

Para resolver o pré-requisito do ambiente, executei
`PLAYWRIGHT_BROWSERS_PATH=/workspace/MixAI/work/playwright npx playwright install chromium`
e repeti a suíte com a mesma variável: **55/55 passaram**. Os binários e logs
ficaram em `work/`, fora do commit. A falha inicial não foi uma falha funcional
do código; o resultado final da suíte é aprovado.

## Limites da validação

- Nenhuma conexão com Ui16, ajuste de processamento, escrita em hardware ou chamada
  de modelo real foi feita. F0, E6, firmware e DSP físico não foram validados.
- Os exemplos são fictícios e não contêm captura de áudio. Testes não comprovam
  qualidade de som, espectro, feedback ou confiança acústica calibrada.
- Recomendações e regiões de frequência exigem avaliação humana em ensaio. Os
  guias permanecem `not_validated_in_rehearsal`.
- Inclinação de HPF/LPF: a documentação tipada da biblioteca não promete efeito
  na Ui16. Testes em LAB não permitem promover esses recursos ao REAL.
- Capturas visuais (`npm run screenshots`) não foram regeneradas: não houve
  alteração de interface e o script grava artefatos nos documentos existentes.
