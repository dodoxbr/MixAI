import { z } from 'zod';
import { sourceCitationSchema, sourceIdSchema, technicalModuleIdSchema, type Reference, type Symptom } from './contracts.js';
import { sources } from './sources.js';
export const KNOWLEDGE_VERSION = '2.0.0' as const;
export const technicalModuleSchema = z.strictObject({
  id: technicalModuleIdSchema, version: z.literal('1.0.0'), validationStatus: z.literal('theory'),
  guidance: z.string().min(1), limitation: z.string().min(1),
  references: z.array(z.strictObject({ source: sourceIdSchema, locator: z.string().min(1) })).min(1),
});
export type TechnicalModule = z.infer<typeof technicalModuleSchema> & { references: Reference[] };
const module = (id: TechnicalModule['id'], guidance: string, limitation: string, references: Reference[]): TechnicalModule =>
  technicalModuleSchema.parse({ id, version: '1.0.0', validationStatus: 'theory', guidance, limitation, references });
export const technicalModules: Readonly<Record<TechnicalModule['id'], TechnicalModule>> = {
  capture: module('capture', 'Revisar microfone/captador, distância, eixo, padrão polar e vazamento antes de processamento.',
    'Modelo/posição são desconhecidos até confirmação; não supor o mesmo ângulo de rejeição para todos os padrões.', [{ source: 'shure-placement', locator: 'Signal to Noise Ratio; Gain Before Feedback; The Sweet Spot' }]),
  eq_hpf: module('eq_hpf', 'EQ paramétrico seleciona centro, ganho e largura/Q. HPF atenua graves; comparar com o papel musical e preservar baixarias.',
    'Descrição de interface não valida DSP LAB nem protocolo físico. Sem receita de frequência/corte.', [{ source: 'ui16-manual', locator: '5.2 Parametric EQ / HPF / bypass' }, { source: 'yamaha-eq', locator: 'Advanced EQ' }]),
  geq_rta: module('geq_rta', 'GEQ das saídas usa bandas fixas; RTA da UI oficial oferece visualização espectral para inspeção humana.',
    'MixAI não recebe esse RTA; fader, MUTE e medidor LAB não identificam frequência de microfonia.', [{ source: 'ui16-manual', locator: '5.3 Graphic EQ / RTA; 4.3.1 AUX Master' }]),
  afs2: module('afs2', 'Manual descreve dbx AFS2 com 12 filtros no master estéreo e masters AUX; Fixed prepara o sistema, Live acompanha a apresentação.',
    'Somente consulta: sem habilitar, limpar filtros ou ring-out pelo MixAI. Preparação exige técnico, passagem supervisionada sem público e plano próprio.', [{ source: 'ui16-manual', locator: '5.3.1 dbx AFS2' }]),
  gain: module('gain', 'Entrada compatível, sinal útil e headroom antecedem EQ; baixar fader não desfaz saturação anterior ao fader.',
    'Não há VU real no aplicativo nem alvo universal; gain/phantom dependem do operador e continuam bloqueados.', [{ source: 'yamaha-gain', locator: 'Gain/trim, input compatibility, PFL and headroom' }, { source: 'ui16-manual', locator: '4.1 Input Gain' }]),
  dynamics: module('dynamics', 'Compressor altera faixa dinâmica; threshold, ratio, attack, release e make-up interagem. Gate pode cortar notas suaves ou finais de palavras.',
    'Não corrige captura saturada; parâmetros não são inferidos de faders ou relatórios. Nenhum controle REAL de dinâmica.', [{ source: 'ui16-manual', locator: '5.4 Dynamics' }, { source: 'yamaha-dynamics', locator: 'Compression Advice' }]),
  band_balance: module('band_balance', 'Preservar dicção da voz principal e espaço relativo de coro, cordas e percussão; comparar no mesmo trecho.',
    'Papéis e interações são adaptação editorial MixAI, não presets dos fabricantes ou offsets fixos.', [{ source: 'yamaha-eq', locator: 'Peak EQ: separation of competing sources' }, { source: 'shure-live', locator: 'Microphone Placement, p.22' }]),
  monitoring: module('monitoring', 'Separar PA e mix AUX1 compartilhada; conferir envio, MUTE e pre/post na UI oficial.',
    'HA800 não cria mix independente para cada músico; observar todos os ouvintes antes de sugerir mudança.', [{ source: 'ui16-manual', locator: '4.3 AUX sends; 4.3.1 AUX Master; 5.5 sends' }]),
};
export function citations(refs: readonly Reference[]) {
  return [...new Map(refs.map(ref => {
    const source = sources[ref.source];
    return [`${ref.source}:${ref.locator}`, sourceCitationSchema.parse({ source: ref.source, title: source.title, url: source.url,
      version: source.version, section: ref.locator, consultedOn: source.consultedOn, accessStatus: source.accessStatus ?? 'historical' })] as const;
  })).values()];
}
export function modulesFor(symptom: Symptom): TechnicalModule['id'][] {
  if (symptom === 'microfonia') return ['capture', 'monitoring', 'gain', 'geq_rta', 'afs2'];
  if (symptom === 'clip' || symptom === 'ganho' || symptom === 'ruido') return ['gain', 'capture', 'dynamics'];
  if (symptom === 'monitoracao') return ['monitoring', 'capture'];
  if (symptom === 'processamento') return ['eq_hpf', 'dynamics', 'afs2', 'gain'];
  return ['capture', 'band_balance', 'eq_hpf', 'dynamics'];
}
