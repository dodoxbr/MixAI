# MixAI — controle da Soundcraft Ui16 por IA

Servidor MCP que deixa o Claude ajustar a Ui16 por comandos em português
("sobe a voz 1 no retorno do cavaco"), com travas de segurança, desfazer e log.
Esta versão cobre as **Fases 0 e 1** do plano: volume, mute, retornos, snapshots,
mesa simulada e console de teste.

## O que precisa

- Node.js 22 ou mais novo (`node -v`)
- Claude Desktop (para conversar com a mesa pela IA)
- A mesa só é necessária para o modo real; tudo funciona no modo simulado.

## Instalar

```bash
cd mixai
npm install
npm run build
npm test        # 37 testes, todos devem passar
```

## Testar sem a mesa (modo simulado)

```bash
npm run console:mock
```

Exemplos no console:

```
estado
sobe voz 1 3
desce cavaco
sobe voz 1 3 @ retorno do cavaco
muta surdo
abre surdo
master -3
desfazer
log
```

## Ligar no Claude Desktop

Edite o `claude_desktop_config.json` do Claude Desktop e acrescente o MixAI
(troque o caminho pelo da sua pasta):

```json
{
  "mcpServers": {
    "mixai": {
      "command": "node",
      "args": ["C:\\Users\\SEU_USUARIO\\mixai\\dist\\index.js"],
      "env": { "MIXAI_MODE": "mock" }
    }
  }
}
```

No Mac/Linux o caminho fica tipo `/Users/seu_usuario/mixai/dist/index.js`.
Reinicie o Claude Desktop e peça, por exemplo: *"como está a mix?"* ou
*"sobe um pouco a voz 2"*.

Para a mesa real, troque `"MIXAI_MODE": "mock"` por `"real"` (e, se precisar,
acrescente `"MIXAI_IP": "10.10.1.1"`).

## Primeiro teste na mesa real (Fase 0)

Faça num ensaio ou com o PA desligado, nunca no meio de um evento.

1. Ligue o notebook na mesa (cabo de rede ou Wi-Fi da mesa).
2. Abra a interface da mesa no navegador e confirme o IP.
3. Rode `npm run console` (ou `node dist/console.js --real`).
4. `status` → deve mostrar "Conectado à mesa em ...".
5. `estado` → os volumes devem bater com a tela da mesa.
6. `desce voz 1` → o fader da Voz 1 tem que descer 2 dB na tela da mesa.
7. `desfazer` → volta ao que era.

Se os passos 4 a 7 funcionarem, a Fase 0 está fechada.

## Nomes da banda

Edite `config/channels.yaml`. Acento, maiúscula e espaço não importam.
O canal também pode ser chamado pelo número ("canal 9", "aux 3").
Confira o mapeamento com a ligação real na mesa (por exemplo, quais entradas são Hi-Z).

## Travas de segurança (`config/config.yaml`)

| Trava | Padrão |
| --- | --- |
| Teto de volume por canal / retorno / master | 0 dB |
| Mudança máxima sem confirmação | 6 dB por comando |
| Master | sempre pede confirmação |
| Mutar mais de 2 canais de uma vez | pede confirmação |
| Carregar snapshot | sempre pede confirmação |
| Comandos por segundo | 5 |
| Ganho de entrada e phantom | a IA não tem acesso |

Pedir confirmação nunca altera nada: a IA precisa perguntar a você e repetir
o comando com `confirm=true`.

## Log

Cada ação (e cada recusa) vai para `logs/acoes-AAAA-MM-DD.jsonl`.

## Estrutura

```
src/
  index.ts            servidor MCP (stdio)
  console.ts          console de teste sem IA
  mcp/server.ts       tools e instruções para a IA
  core/controller.ts  travas, desfazer, log
  core/channels.ts    nomes da banda -> números
  core/config.ts      leitura do config.yaml e channels.yaml
  mixer/real.ts       mesa real (soundcraft-ui-connection)
  mixer/mock.ts       mesa simulada
config/               config.yaml e channels.yaml
test/                 testes (Vitest)
```

## Problemas comuns

- **"Não consegui conectar"**: confira o IP da mesa e se o notebook está na mesma rede.
- **Claude Desktop não mostra as tools**: confira o caminho absoluto do `dist/index.js`
  e se rodou `npm run build`.
- **Depois de atualizar o firmware da mesa algo parou**: a biblioteca usa o protocolo
  da interface web, que não é oficial. Teste no console antes de qualquer evento.
  A versão da biblioteca está fixada em `package.json` de propósito.
