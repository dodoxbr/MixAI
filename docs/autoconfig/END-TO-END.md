# AutoConfig de ponta a ponta — interface B + planejador C + núcleo D

Fecha a lacuna registrada em [INTEGRATION-78.md](INTEGRATION-78.md): a tela do operador agora consome
`POST /api/autoconfig/suggestions`. Somente LAB (o planejador não existe em MOCK/REAL; o núcleo D segue LAB/MOCK).
Nada é enviado à Soundcraft; nem o `LabMixer` é movimentado.

## Jornada

1. **Relato (M1).** O operador conta o problema no chat técnico, como antes.
2. **Planejador.** Passagem de som → evento → **Consultar planejador técnico**. A tela não envia destino nem número:
   o servidor reaproveita o contexto M1 (canal, destino, sintoma, comparação, isolamento…) e pergunta **um** campo
   por vez. A tela mostra o que já foi informado ("não será perguntado de novo") e envia só a escolha oferecida e o
   `inputFingerprint` da pergunta.
3. **Inspeção sugerida.** Finalidade, o que verificar, justificativa, relato classificado, pré-condições, como
   verificar, quando parar, retorno, limitações, fontes citadas (teoria, com seção/versão/data) e avisos de segurança.
4. **Decisão humana.** "Só fazer a inspeção" (nada é criado no servidor) ou "Quero simular um passo de nível". O campo
   do passo começa **vazio**; não existe valor sugerido nem conversão inspeção → dB.
5. **Rascunho D.** Só depois do número digitado: `POST /api/autoconfig` com canal e destino da inspeção, a evidência
   classificada do esqueleto e o passo do operador. A justificativa diz que a IA não sugeriu valor.
6. **D sem alterações:** preparar → autorização individual (`approve` com digest, `simulation_only`) → simulação
   virtual → revisão (confirmar/rejeitar) → desfazer → referência versionada `UNVERIFIED`, `notApplied:true`.

O assistente manual antigo continua disponível como **Definir teste manualmente (sem planejador)**, inclusive
quando o planejador recusa (exceto em parada de segurança).

## Mudanças no servidor (aditivas)

- `src/autoconfig/advisory-contracts.ts`: contratos puros (sem `node:crypto`) usados pelo servidor **e** pela tela.
- `scope` passou a ser opcional na consulta. Sem ele, vale o destino do M1; se ninguém sabe, o planejador pergunta.
  `scope` explícito que contradiz o M1 continua devolvendo 409.
- Resposta ganhou `model` (`selected`, `used`, `name` vindo da configuração, `external`) e `context`
  (`fromDiagnosis` e **nomes** dos campos já conhecidos — sem valores, relato livre ou dados privados).
- Nada mudou em contratos/serviço/estado de D, autenticação, permissões, rotas, consentimento ou provedores.

## Modelos de IA

- A seleção atual (painel da base de conhecimento) é respeitada; nenhuma chave nova é pedida.
- O Gemini só é chamado com a confirmação já existente **nesta sessão de operador** (regra do PR #78). Sem ela, a tela
  diz "Gemini: não confirmado nesta sessão — nada foi enviado" e mostra o modelo local que respondeu.
- Quota/indisponibilidade → Ollama local (informado). **Recusa de segurança → nenhum outro modelo** (mostrada como
  tal, sem esqueleto).
- A tela identifica: "Gemini · <modelo> — serviço externo", "Ollama local · <modelo>" ou "Motor determinístico — nenhum
  modelo de IA gerou esta escolha".
- Ao modelo vão só categorias e títulos públicos (inalterado). A chave nunca chega à tela.

## Diferenciação na tela

Legenda e bordas coloridas: **Recomendação da IA** (inspeção, não ajuste) · **Relato ou decisão humana** ·
**Simulação** (valor virtual; "não comprova melhoria no som") · **Observação verificada** (estado LAB lido pelo
servidor, não áudio).

## Falhas

| Situação | Comportamento |
|---|---|
| Conexão perdida | Pergunta descartada no navegador, ações bloqueadas; nova consulta devolve a pergunta pendente do servidor |
| Diagnóstico/estado/provedor mudou | 409 `STALE_STATE` → "O contexto mudou… consulte de novo"; nada avança |
| Resposta tardia (servidor) | Descartada pelo servidor (409/401) |
| Resposta tardia (navegador) | Descartada por geração/identidade/conexão |
| Sessão expirada | 401 → login; nenhum plano criado |
| Músico / MCP / anônimo | 403 / 403 / 401; músico não vê o AutoConfig |
| Recusa / parada de segurança | Mostrada; sem fallback de modelo; parada de segurança não oferece atalho manual |

Timeout do navegador para o planejador: 25 s (dois provedores possíveis); demais ações seguem 10 s.

## Testes

- `test/e2e/autoconfig-end-to-end.test.ts`: jornada completa no Yoga e no celular; Ollama/Gemini falsos (modelo,
  consentimento por sessão, recusa sem troca, resposta tardia); músico/anônimo; conexão, diagnóstico alterado e sessão.
- `web/src/app/autoconfig/autoconfig-advice.spec.ts`: corpo das requisições, ausência de número, decisão humana,
  mensagens, respostas tardias e esquema estrito.
- `test/autoconfig-integration.test.ts`: consulta sem `scope`, campos conhecidos, modelo identificado, recusa do Gemini.
- `test/proxy/https-lab.proxy.ts`: consulta sem `scope` pelo proxy HTTPS.

## Limites

Sem validação física (Yoga real com toque, celulares na rede da mesa, firmware, acústica). Nenhum modelo real foi
chamado nos testes. O planejador escolhe entre procedimentos citados; isso não comprova a causa do problema.
Escrita REAL/E6 continua fora de escopo.

Capturas: `screenshots/yoga-2-inspecao-decisao.png`, `screenshots/celular-1-pergunta.png`,
`screenshots/yoga-3-simulacao-referencia.png` (servidor LAB de teste, sem dados reais).
