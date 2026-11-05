import type { LevelRequest, MuteRequest, Result } from '../core/controller.js';

/**
 * O que as tools MCP precisam. Implementado:
 * - pelo cliente HTTP do servidor (RemoteBackend): é o que o Claude Desktop usa a partir da E2;
 * - pelo próprio MixController, só em testes (o MCP real nunca instancia mesa nem controlador).
 */
export interface MixBackend {
  ensureConnected(): Promise<Result>;
  listNames(): Result | Promise<Result>;
  mixState(aux?: string | number): Promise<Result>;
  setLevel(req: LevelRequest): Promise<Result>;
  setMute(req: MuteRequest): Promise<Result>;
  setMaster(req: { db?: number; deltaDB?: number; confirm?: boolean; confirmationId?: string }): Promise<Result>;
  undo(steps?: number): Promise<Result>;
  history(limit?: number): Result | Promise<Result>;
  listSnapshots(): Promise<Result>;
  loadSnapshot(req: { show: string; snapshot: string; confirm?: boolean; confirmationId?: string }): Promise<Result>;
}
