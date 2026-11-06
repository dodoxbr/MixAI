# MixAI — Instruções para agentes de desenvolvimento

Estas instruções aplicam-se a todas as tarefas de agentes Codex neste repositório. Leia a Issue e o estado da `main` antes de começar. A pessoa responsável pelo projeto escolhe a ordem de integração.

## Fluxo obrigatório de trabalho

1. Confira `origin/main` atualizada e as Issues/PRs dos quais a tarefa depende. Comece de uma **branch exclusiva** por entrega; não reutilize branches já incorporadas. Não sobrescreva trabalho existente para trocar de branch.
2. Trabalhe somente no escopo da tarefa, evitando mudanças desnecessárias em arquivos compartilhados. Explique e teste qualquer desvio de escopo.
3. Execute as verificações relevantes: typecheck, build, testes do núcleo, interface, E2E, smoke do Yoga, HTTPS/Caddy quando afetado. Não afrouxe testes, controles ou expectativas só para obter CI verde; informe limites de ambiente/hardware.
4. Faça commits e push na branch e abra/atualize **um PR independente**. Verifique o estado dos checks e se o PR apresenta conflitos com a `main`.
5. **Nunca execute merge, squash, rebase-merge, auto-merge nem push direto na `main`.** Não feche um PR como substituto de merge. O ChatGPT atua como revisor técnico independente, examinando código e CI pelo GitHub. **Somente o responsável pelo projeto realiza o merge após receber o parecer técnico.**
6. Se outro PR precisar entrar primeiro, não espere indefinidamente nem faça merge por conta própria. Conclua o que for independente, documente a dependência e informe o bloqueio. Após autorização em nova instrução, atualize sua branch e reexecute as validações.
7. Não faça alterações destrutivas, `force push` ou `reset --hard` de conteúdo não salvo sem autorização explícita.

## Segurança e Soundcraft Ui16

- Mantenha os modos LAB, MOCK e REAL separados. **F0 físico ainda exige validação supervisionada; E6 e escrita REAL não estão autorizadas** por entregas preparatórias.
- Nenhuma funcionalidade experimental (voz, reconhecimento, EQ simulado, comparação) deve executar comandos na Ui16 por conta própria. Diagnóstico não é proposta de alteração; decisões críticas exigem operador e aprovação humana.
- Nunca exponha PINs, tokens, segredos, áudios privados, arquivos locais sensíveis, chaves TLS nem dados de terceiros em logs, commits ou PRs.
- Testes sem hardware não comprovam compatibilidade com firmware, topologia, qualidade acústica ou segurança física. Declare explicitamente essas pendências.

## Entrega e relatório curto obrigatório

Ao concluir, atualize a **descrição do PR** e responda no chat da tarefa com o mesmo resumo compacto, para facilitar a revisão. Não é necessário copiar logs extensos: o revisor possui acesso ao GitHub.

Use este formato:

- **PR e branch:** URL, número, branch e SHA final.
- **O que mudou:** até cinco pontos objetivos; destaque alterações de autenticação, permissões, rede, persistência ou comandos.
- **Testes:** comandos e resultados; CI Windows/Ubuntu/Caddy/smoke conforme aplicável, indicando explicitamente *pendente* ou *não executado*.
- **Segurança:** confirme ausência de escrita REAL e de alterações não autorizadas, quando aplicável.
- **Pendências:** riscos, limitações, verificações manuais, dependências e conflitos.
- **Estado para revisão:** `PR aberto — aguardando revisão técnica do ChatGPT e merge manual pelo responsável`.

Não declare *aprovado para merge* por conta própria: o agente informa evidências, e o revisor emite o parecer.
