import type { Instrument } from './contracts.js';
import { instruments } from './instruments.js';
import { sources } from './sources.js';

/** Structural data contract; the knowledge layer never imports the DSP/controller layer. */
export interface EqGuideModel {
  bands: Array<{ freq: number; q: number; gain: number }>;
  hpf: { freq: number; slope: number };
  bypass: boolean;
}

/** Editorial MixAI starting points, never measured, official Ui16 presets or diagnostic outputs. */
export interface EqGuide {
  readonly id: Instrument;
  readonly name: string;
  readonly purpose: string;
  readonly rationale: string;
  readonly contraindication: string;
  readonly model: EqGuideModel;
}
const model = (hpf: number, freq: number, gain: number): EqGuideModel => ({
  bands: [{ freq: 120, q: 1, gain: 0 }, { freq, q: 1, gain }, { freq: 2000, q: 1, gain: 0 }, { freq: 8000, q: 1, gain: 0 }],
  hpf: { freq: hpf, slope: 12 }, bypass: false,
});
/** Only parameters already represented in E7A LAB. Numbers are unvalidated editorial trials. */
export const eqGuides: readonly EqGuide[] = [
  { id: 'cavaco', name: 'Cavaquinho', purpose: 'Ensaiar menos grave sem função e suavizar presença excessiva.',
    rationale: 'HPF em 80 Hz e corte amplo de 2 dB em 3 kHz: tentativa discreta para ataque áspero, depois de revisar captação.',
    contraindication: 'Se estiver magro ou sem ataque, este ponto de partida pode piorar o relato.', model: model(80, 3000, -2) },
  { id: 'violao', name: 'Violão / 7 cordas', purpose: 'Preservar baixarias e experimentar uma redução leve de corpo acumulado.',
    rationale: 'HPF baixo em 40 Hz e corte amplo de 1 dB em 250 Hz; evita importar o HPF do cavaco para o 7 cordas.',
    contraindication: 'Pode enfraquecer instrumento já magro. Confira a nota mais grave e a função das baixarias antes de qualquer corte.', model: model(40, 250, -1) },
  { id: 'vozes', name: 'Vozes', purpose: 'Ensaiar inteligibilidade sem reforçar agudos automaticamente.',
    rationale: 'HPF em 70 Hz e corte amplo de 1,5 dB em 300 Hz como hipótese para excesso de corpo/proximidade.',
    contraindication: 'Voz grave ou sem corpo pode perder sustentação. Este EQ não é de-esser e não resolve sibilância por si só.', model: model(70, 300, -1.5) },
  { id: 'surdo', name: 'Surdo', purpose: 'Experimentar menos ressonância média sem remover a fundação grave.',
    rationale: 'HPF desligado (20 Hz na convenção LAB) e corte amplo de 1,5 dB em 250 Hz. Sem boost de subgrave.',
    contraindication: 'Não use para compensar limite do PA. O corte pode retirar corpo; verifique afinação e ressonância do ambiente.', model: model(20, 250, -1.5) },
  { id: 'tanta', name: 'Tantã', purpose: 'Ensaiar separação do surdo preservando articulação e sustentação.',
    rationale: 'HPF em 30 Hz e corte amplo de 1 dB em 300 Hz, sem gate nem compressão simulados.',
    contraindication: 'Pode retirar uma ressonância musical desejada. Compare passagens alternadas e juntas antes de decidir.', model: model(30, 300, -1) },
  { id: 'pandeiro', name: 'Pandeiro', purpose: 'Suavizar platinelas sem tratar o instrumento como chimbal.',
    rationale: 'HPF baixo em 40 Hz para preservar a pele e corte amplo de 1,5 dB em 5 kHz como ensaio de suavização.',
    contraindication: 'Se abafado, pode perder definição. Revise primeiro o ângulo do microfone e o equilíbrio pele/platinelas.', model: model(40, 5000, -1.5) },
];
export function eqGuideContext(guide: EqGuide) {
  const instrument = instruments[guide.id];
  return {
    instrument,
    references: instrument.references.map(ref => ({ ...ref, ...sources[ref.source] })),
  };
}

/** Complete replacement of the 15 E7A EQ parameters; no level/mute or hardware keys. */
export function eqValues(eq: EqGuideModel): Record<string, number | boolean> {
  const values: Record<string, number | boolean> = {};
  eq.bands.forEach((b, i) => {
    values[`b${i + 1}.freq`] = b.freq;
    values[`b${i + 1}.q`] = b.q;
    values[`b${i + 1}.gain`] = b.gain;
  });
  return { ...values, 'hpf.freq': eq.hpf.freq, 'hpf.slope': eq.hpf.slope, bypass: eq.bypass };
}
export interface EqGuideDiff {
  key: string;
  label: string;
  current: number | boolean;
  proposed: number | boolean;
  unit: string;
}
/** Includes unchanged parameters so even a bypass/HPF replacement is explicit. */
export function compareEqGuide(current: EqGuideModel, proposed: EqGuideModel): EqGuideDiff[] {
  const before = eqValues(current);
  return Object.entries(eqValues(proposed)).map(([key, value]) => {
    const [band, parameter] = key.split('.');
    const label = key === 'bypass' ? 'Bypass EQ/HPF' : `${band === 'hpf' ? 'HPF' : `Banda ${band!.slice(1)}`} ${parameter === 'freq' ? 'frequência' : parameter === 'q' ? 'Q' : parameter === 'gain' ? 'ganho' : 'inclinação'}`;
    const unit = parameter === 'freq' ? 'Hz' : parameter === 'gain' ? 'dB' : parameter === 'slope' ? 'dB/oitava' : '';
    return { key, label, current: before[key]!, proposed: value, unit };
  });
}
