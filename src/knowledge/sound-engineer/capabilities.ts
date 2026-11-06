import type { Reference } from './contracts.js';

interface CapabilityEntry {
  feature: string;
  ui16: 'documented' | 'unsupported';
  library: 'available' | 'not_exposed' | 'ui24r_only';
  mixai: 'existing_control' | 'lab_only' | 'not_integrated' | 'blocked';
  hardwareVerified: false;
  notes: string;
  references: readonly Reference[];
}
const entry = (feature: string, ui16: CapabilityEntry['ui16'], library: CapabilityEntry['library'], mixai: CapabilityEntry['mixai'], notes: string, section: string, file: string): CapabilityEntry => ({
  feature, ui16, library, mixai, hardwareVerified: false, notes,
  references: [{ source: 'ui16-manual', locator: section }, { source: 'library-7.1.0', locator: file }],
});
/** Retrato da main na primeira entrega; não concede permissões nem altera ParamRegistry. */
export const capabilities: readonly CapabilityEntry[] = [
  entry('channel_level_mute_aux', 'documented', 'available', 'existing_control', '12 entradas de microfone/linha; 6 buses AUX na biblioteca, 4 saídas XLR dedicadas e AUX 5/6 condicionais via saídas de fones (manual 4.3). Banda mapeada separadamente. Políticas continuam no servidor.', '2.2; 4.1; 4.3', 'lib/facade/channel.d.ts; lib/facade/send-channel.d.ts; DEVICE_CAPABILITIES'),
  entry('parametric_eq', 'documented', 'available', 'lab_only', '4 bandas: 20–22050 Hz, Q 0,05–15, ganho ±20 dB na API; limites não são recomendações de uso.', '5.2', 'lib/facade/eq/eq-band.d.ts'),
  entry('hpf_frequency', 'documented', 'available', 'lab_only', '20–1000 Hz na API; 20 Hz é a convenção de desligado da biblioteca.', '5.2', 'lib/facade/eq/eq-filter.d.ts'),
  entry('hpf_slope', 'unsupported', 'ui24r_only', 'lab_only', 'setSlope não tem efeito na Ui16; slope$ não emite. Valores 12/24/36 no LAB não comprovam capacidade física.', '5.2 (sem controle de inclinação documentado)', 'lib/facade/eq/eq-filter.d.ts'),
  entry('eq_bypass', 'documented', 'available', 'lab_only', 'Manual: bypass do EQ paramétrico não desliga HPF nem de-esser.', '5.2', 'lib/facade/eq/channel-eq.d.ts'),
  entry('lpf', 'unsupported', 'ui24r_only', 'not_integrated', 'Observables não emitem e setters não têm efeito na Ui12/Ui16.', '5.2 (HPF documentado; sem LPF)', 'lib/facade/eq/channel-eq.d.ts'),
  entry('compressor_gate_deesser', 'documented', 'not_exposed', 'not_integrated', 'Existem na interface oficial; sem fachada tipada na biblioteca 7.1.0. Não inventar métodos ou chaves do protocolo.', '5.2; 5.4', 'lib/facade/index.d.ts'),
  entry('geq_afs', 'documented', 'not_exposed', 'not_integrated', 'GEQ de saída e AFS na interface oficial; nenhum controle nesta entrega.', '5.3; 5.3.1', 'lib/facade/index.d.ts'),
  entry('rta', 'documented', 'not_exposed', 'not_integrated', 'RTA existe na interface oficial, sem API comprovada na biblioteca. Nenhuma análise espectral nesta entrega.', '5.2; 5.3', 'lib/facade/index.d.ts'),
  entry('meters', 'documented', 'available', 'not_integrated', 'vuProcessor.input: vuPre/vuPost/vuPostFader; aquisição real depende de E6/F0. Medidores atuais do MixAI são simulados.', '3.3; 4.1', 'lib/vu/vu-processor.d.ts; lib/vu/vu.types.d.ts'),
  entry('preamp_phantom', 'documented', 'available', 'blocked', 'HwChannel expõe ganho e phantom; MixAI não os autoriza. Não sugerir comandos de escrita.', '4.1', 'lib/facade/hw-channel.d.ts'),
  entry('aux_tap', 'documented', 'available', 'not_integrated', 'Conferir pre/post fader e processamento na interface oficial; AUX 1 é compartilhado na banda. Sem alterar roteamento.', '4.3', 'lib/facade/aux-channel.d.ts; lib/facade/send-channel.d.ts'),
  entry('usb_stereo_recording', 'documented', 'available', 'not_integrated', 'Grava master estéreo em USB; não fornece captura ao assistente nem separa instrumentos.', '2.2; 9.0', 'lib/facade/dual-track-recorder.d.ts'),
  entry('usb_multitrack', 'unsupported', 'ui24r_only', 'not_integrated', 'DEVICE_CAPABILITIES.ui16.multitrack = false; não prometer gravação multipista.', '9.0 (gravação estéreo)', 'lib/device-capabilities.d.ts; lib/facade/multi-track-recorder.d.ts'),
];
