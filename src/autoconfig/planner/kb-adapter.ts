import { queryInstructorGuidance, voiceRole } from '../../knowledge/sound-engineer/index.js';
import type { DiagnosticConsultation } from '../../knowledge/sound-engineer/index.js';
import { diagnosticConsultationSchema } from '../../knowledge/sound-engineer/index.js';
import type { ChannelMap } from '../../core/channels.js';
import type { MicPack } from '../../knowledge/local/pack.js';
import { bandSourceSchema, plannerCandidateSchema, plannerInputSchema, type PlannerInput, type PlannerKnowledgePort } from './contracts.js';

/** Only bridge to the existing knowledge. No diagnosis/parser/service A1/A2 is changed. */
export function bandKnowledgeAdapter(names: ChannelMap, microphones?: MicPack): PlannerKnowledgePort {
  const instrumentFor = (channel: number) => {
    const phrases = names.inputs.terms().filter(t => t.number === channel).map(t => t.phrase).join(' ');
    const tests = { cavaco: /cavaco|cavaquinho/, violao: /violao|viola/, surdo: /surdo/, tanta: /tanta|tantan/, pandeiro: /pandeiro/, vozes: /voz|vocal/ } as const;
    const matches = Object.entries(tests).filter(([, re]) => re.test(phrases));
    return matches.length === 1 ? matches[0]![0] : undefined;
  };
  return {
    sources() { return names.inputs.list().filter(s => names.inputs.configured().includes(s.number)).flatMap(s => {
      const instrument = instrumentFor(s.number); if (!instrument) return [];
      const assignment = microphones?.channelAssignments[`CH${s.number}`];
      const model = assignment?.modelId ? microphones?.candidateModels[assignment.modelId] : undefined;
      return [bandSourceSchema.parse({ channel: s.number, instrument, label: s.name,
        role: instrument === 'vozes' ? voiceRole(s.number, s.name) : 'instrument',
        microphone: assignment && assignment.evidence !== 'unconfirmed' && model?.model === 'AKG Perception P3 S' ? 'p3s' : 'unknown' })];
    }); },
    candidates(input) {
      const source = this.sources().find(s => s.channel === input.channel);
      if (!source || !input.symptom || !input.destination || !input.report) return [];
      const guidance = queryInstructorGuidance({ symptom: input.symptom, channel: source.channel, instrument: source.instrument, destination: input.destination,
        evidence: [{ ...input.report, detail: 'Relato fornecido ao planejador; sem medição.', ...(input.report.kind === 'musician_report' ? { verification: 'unverified' as const } : {}) }] });
      // Prefer musical/capture-specific inspections; generic processing remains a possible review, not an adjustment.
      const ordered = [...guidance.procedures].sort((a, b) => Number(b.instruments.length === 1) - Number(a.instruments.length === 1));
      return ordered.slice(0, 3).map((p, i) => plannerCandidateSchema.parse({ id: `s${i + 1}`, procedureId: p.id, procedureVersion: p.version, purpose: p.purpose,
        instruction: p.steps[1]!.instruction, preconditions: p.preconditions, verification: p.steps[1]!.verification, stop: p.stop,
        references: p.references.map(r => ({ title: r.title, url: r.url, section: r.section, version: r.version, consultedOn: r.consultedOn, validationStatus: p.validationStatus })) }));
    },
  };
}
/** Read-only migration adapter: never promotes caller-declared control readings to validated state. */
export function plannerInputFromConsultation(raw: DiagnosticConsultation, goal: NonNullable<PlannerInput['goal']>): PlannerInput {
  const c = diagnosticConsultationSchema.parse(raw), report = c.evidence.reports.find(r => r.symptom === c.diagnostic.symptom);
  return plannerInputSchema.parse({ mode: 'LAB', channel: c.diagnostic.channel ?? undefined, symptom: c.diagnostic.symptom,
    destination: c.diagnostic.destination ?? undefined, goal,
    ...(report ? { report: { id: report.id, kind: report.kind, symptom: report.symptom } } : {}) });
}
