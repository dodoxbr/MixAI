import type { Instrument, Reference } from './contracts.js';
/** Roles declared by the operator, not session identity or authorization. */
export function voiceRole(channel?: number, label?: string): 'lead' | 'backing' | 'unknown' {
  const text = (label ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (channel === 3 && /\bvoz\b/.test(text) && /\bfred\b/.test(text)) return 'lead';
  const names: Record<number, string> = { 4: 'lucius', 5: 'leandro', 6: 'fernando', 7: 'laviquinho' };
  return channel && names[channel] && /\bvoz\b/.test(text) && new RegExp(`\\b${names[channel]}\\b`).test(text) ? 'backing' : 'unknown';
}
export interface InstrumentProfile {
  id: string; instrument: Instrument; version: '1.0.0'; validationStatus: 'theory';
  role: string; verify: string; avoid: string; references: readonly Reference[];
}
const references: Reference[] = [{ source: 'shure-live', locator: 'Microphone Placement, p.22: principles applied editorially to samba/pagode' }, { source: 'yamaha-eq', locator: 'Peak EQ: separation of competing sources' }];
const profile = (id: string, instrument: Instrument, role: string, verify: string, avoid: string): InstrumentProfile =>
  ({ id, instrument, version: '1.0.0', validationStatus: 'theory', role, verify, avoid, references });
export const instrumentProfiles: readonly InstrumentProfile[] = [
  profile('cavaco', 'cavaco', 'Ataque e condução rítmica/harmônica.', 'Confirmar DI/microfone, impedância e relação com violão/vozes.', 'Brilho para aparecer pode mascarar dicção; rever captação primeiro.'),
  profile('violao-six', 'violao', 'Harmonia e articulação de acordes.', 'Confirmar seis ou sete cordas e captação antes de escolher referência.', 'Não presumir instrumento pela presença do alias 7 cordas no cadastro.'),
  profile('violao-seven', 'violao', 'Baixarias participam do grave musical, além da harmonia.', 'Comparar linhas graves com surdo/tantã, depois avaliar disputa com cavaco.', 'Não transferir HPF do cavaco nem eliminar baixarias intencionais.'),
  profile('surdo', 'surdo', 'Fundação do pulso e peso.', 'Rever afinação, abafamento, ressonância e reprodução do PA.', 'Não compensar falta de grave do sistema com boost indiscriminado.'),
  profile('tanta', 'tanta', 'Articulação das mãos e sustentação do groove.', 'Comparar ataque e cauda com o surdo em passagens alternadas e juntas.', 'Gate pode apagar notas suaves; preservar sustentação musical.'),
  profile('pandeiro', 'pandeiro', 'Pele fornece corpo; platinelas articulam a levada.', 'Rever ângulo do microfone e equilíbrio pele/platinelas.', 'Não tratá-lo como fonte exclusivamente aguda ou como chimbal.'),
  profile('voice-lead', 'vozes', 'Fred CH3 conduz a letra; prioridade de inteligibilidade.', 'Confirmar cadastro/canal e ouvir consonantes junto ao coro CH4–7.', 'Não pedir que Fred force a voz nem elevar todos os canais; prioridade é relativa.'),
  profile('voice-backing', 'vozes', 'CH4–7 respondem à voz principal e sustentam o coro.', 'Comparar refrão e verso com a voz principal e instrumentos.', 'Não impor offset fixo entre coro e lead; depende de execução, captação e trecho.'),
];
export const interactions = [
  { id: 'lead-backing', instruments: ['vozes'], guidance: 'Se Fred CH3 some quando CH4–7 entram, comparar dicção, distância ao microfone e balanço relativo; sem pedir esforço vocal nem offset fixo.' },
  { id: 'surdo-tanta', instruments: ['surdo', 'tanta'], guidance: 'Surdo e tantã podem acumular sustentação; comparar afinação, ressonância e ataque alternados e juntos antes de EQ ou gate.' },
  { id: 'cavaco-violao', instruments: ['cavaco', 'violao'], guidance: 'Cavaco e violão podem competir pela articulação; distinguir seis/sete cordas e preservar baixarias antes de discutir espaço no arranjo.' },
] as const;
