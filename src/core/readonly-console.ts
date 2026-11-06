import type { Command } from './parser.js';

/** Lista positiva: comandos novos também ficam bloqueados até revisão do F0. */
export function allowedInReadOnlyConsole(cmd: Command): boolean {
  return ['empty', 'help', 'quit', 'error', 'status', 'state', 'names', 'snapshots'].includes(cmd.kind);
}

export const READ_ONLY_HELP = `F0 SOMENTE LEITURA — nenhum ajuste é permitido.
  status                 conexão, sincronização e snapshot atual
  estado [@ fones]       níveis/mutes observados (desconhecido não é zero)
  nomes                  mapeamento configurado (não detecta a ligação física)
  snapshots              listar, nunca carregar
  ajuda | sair
READY significa sincronização completa; escrita continua bloqueada.
Firmware/modelo/capacidades físicas: conferir manualmente na UI oficial.
Histórico antigo não é evidência deste F0; use o formulário de evidências.`;
