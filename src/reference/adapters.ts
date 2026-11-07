import { consult, parseConsultation } from '../assistant/sound-engineer.js';
import type { ServerCore } from '../server/core.js';
import type { ReferencePorts } from './contracts.js';

/** Production LAB adapters: identity is always server-owned; consultation is pure and offline.
 * No ask/apply/execute/controller capability is passed to the recommendation engine. */
export function referencePortsOf(core: ServerCore): ReferencePorts {
  return {
    identity: { resolve(p) {
      const binding = core.auth.isActive(p) ? core.musicianIdentity(p).binding : null;
      return binding ? { verified: true, musicianId: binding.musicianId, displayName: binding.name,
        channels: [...binding.channels], bindingRevision: binding.revision } : { verified: false, channels: [] };
    } },
    recommendations: { async recommend(input) {
      const parsed = parseConsultation(input.report, core.controller.names);
      const reply = consult({ symptom: parsed?.symptom, channel: input.channel,
        destination: input.destination === 'PA' ? 'pa' : 'fones', evidence: (parsed?.evidence ?? []).flatMap(e => e.kind === 'operator_report' ? [{ id: e.id, kind: 'musician_report' as const, symptom: e.symptom, detail: e.detail, verification: 'unverified' as const }] : []),
      }, core.controller.names, core.policy.musicianAux);
      // A musician report is not promoted to operator-confirmed evidence or measured audio.
      return { source: 'diagnosis', status: reply.clarification ? 'needs_context' : reply.diagnosis?.status ?? 'needs_context',
        text: `Relato recebido na bandeja, não confirmado pelo operador; sem evidência acústica.\n${reply.text}`,
        references: [...new Set(reply.references.map(r => r.url))].slice(0, 10),
      };
    } },
  };
}
