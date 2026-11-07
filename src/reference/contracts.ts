import type { Principal } from '../server/auth.js';
/** Supplied by #47, never inferred from a shared PIN or text/channel selected by the client. */
export interface MusicianIdentityPort {
  resolve(principal: Principal): { verified: boolean; musicianId?: string; displayName?: string; channels: number[]; bindingRevision?: number };
}
/** #48 supplies advice only. This contract has no command, controller, queue or apply capability. */
export interface ReferenceRecommendationPort {
  recommend(input: { report: string; channel?: number; destination: 'PA' | 'AUX1'; stateRevision: number; guidanceContext?: { sessionId: string; symptom: string; checksPerformed: string[]; evidenceLevel: 'human_report_unverified' } }): Promise<{ text: string; source: 'diagnosis'; references?: string[]; status?: 'needs_context' | 'theoretical_guidance' }>;
}
export interface ReferencePorts { identity?: MusicianIdentityPort; recommendations?: ReferenceRecommendationPort }
