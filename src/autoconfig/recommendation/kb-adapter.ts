import { eqGuides, instruments, procedures, sources } from '../../knowledge/sound-engineer/index.js';
import type { KnowledgeRef } from './contracts.js';
import type { RecommendationKnowledge } from './engine.js';

type SourceId = keyof typeof sources;
function ref(id: string, sourceId: SourceId, locator: string, validationStatus: KnowledgeRef['validationStatus']): KnowledgeRef {
  const s = sources[sourceId];
  return { id, sourceId, locator, version: s.version, consultedOn: s.consultedOn, validationStatus };
}
/** Única ponte entre o módulo de recomendação e a base determinística de conhecimento. Somente leitura; versões e datas vêm das fontes existentes. */
export const bandRecommendationKnowledge: RecommendationKnowledge = {
  eqGuide(instrument) {
    const guide = eqGuides.find(g => g.id === instrument)!, r = instruments[instrument].references[0]!, cut = guide.model.bands[1]!;
    return { name: guide.name, contraindication: guide.contraindication, hpfFreq: guide.model.hpf.freq, cut: { band: 2, freq: cut.freq, gain: cut.gain },
      ref: ref(`eq-guide:${instrument}`, r.source as SourceId, `Guia de EQ editorial — ${guide.name}`, 'editorial_unvalidated') };
  },
  procedureRef(symptom) {
    const r = procedures[symptom].references[0]!;
    return ref(`procedure:${symptom}`, r.source as SourceId, r.locator, 'theory');
  },
  instrumentRef(instrument) {
    const r = instruments[instrument].references[0]!;
    return ref(`instrument:${instrument}`, r.source as SourceId, r.locator, 'theory');
  },
};
