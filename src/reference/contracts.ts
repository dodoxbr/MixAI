import type { Principal } from '../server/auth.js';
/** Supplied by #47, never inferred from a shared PIN or text/channel selected by the client. */
export interface MusicianIdentityPort {
  resolve(principal: Principal): { verified: boolean; musicianId?: string; displayName?: string; channel?: number };
}
/** #48 supplies advice only. This contract has no command, controller, queue or apply capability. */
export interface ReferenceRecommendationPort {
  recommend(input: { report: string; channel?: number; destination: 'PA' | 'AUX1'; stateRevision: number }): Promise<{ text: string; source: 'diagnosis'; references?: string[] }>;
}
export interface ReferencePorts { identity?: MusicianIdentityPort; recommendations?: ReferenceRecommendationPort }
