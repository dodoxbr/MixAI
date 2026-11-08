import type { SourceId } from './contracts.js';

export const sources: Readonly<Record<SourceId, {
  title: string; url: string; version: string; consultedOn: string; scope: string;
  sections?: readonly string[]; accessStatus?: 'consulted' | 'historical' | 'unavailable';
}>> = {
  'ui16-manual': {
    title: 'Soundcraft Ui12/Ui16 User Guide', version: 'v3.0 (English)', consultedOn: '2026-11-07', accessStatus: 'consulted',
    sections: ['4.1 Gain', '4.3 / 4.3.1 AUX', '5.2 Parametric EQ', '5.3 Graphic EQ / RTA', '5.3.1 AFS2', '5.4 Dynamics'],
    url: 'https://www.soundcraft.com/en/product_documents/ui_usermanual_v3-0-pdf-27c992b4-5132-4d2d-b8e2-79750de6ee29',
    scope: 'Recursos documentados; firmware da mesa da banda desconhecido. Versão do manual não é versão de firmware.',
  },
  'library-7.1.0': {
    title: 'soundcraft-ui-connection', version: '7.1.0 / MIT', consultedOn: '2026-11-06',
    url: 'https://github.com/fmalcher/soundcraft-ui',
    scope: 'Declarações e código do pacote instalado e fixado no lockfile; protocolo não oficial; sem validação física.',
  },
  'yamaha-eq': {
    title: 'Yamaha — Equalization', version: '2018-04-26 / artigo sem revisão indicada', consultedOn: '2026-11-08', accessStatus: 'consulted', sections: ['Basic EQ', 'Advanced EQ'],
    url: 'https://hub.yamaha.com/proaudio/livesound/eq/', scope: 'Fundamentos de EQ, Q, HPF e mascaramento; não define capacidades da Ui16.',
  },
  'yamaha-gain': {
    title: 'Yamaha — Gain Staging', version: '2018-03-22 / artigo sem revisão indicada', consultedOn: '2026-11-08', accessStatus: 'consulted', sections: ['Gain Staging: input compatibility, gain/trim, PFL, headroom'],
    url: 'https://hub.yamaha.com/proaudio/livesound/gain-staging/', scope: 'Compatibilidade de entrada, estrutura de ganho e headroom; sem importar alvos numéricos de outra mesa.',
  },
  'yamaha-dynamics': {
    title: 'Yamaha — How to Use a Compressor', version: '2017-10-27 / artigo sem revisão indicada', consultedOn: '2026-11-08', accessStatus: 'consulted', sections: ['Input/output compression', 'Compression Advice'],
    url: 'https://hub.yamaha.com/proaudio/livesound/tools-of-the-trade-how-to-use-a-compressor/', scope: 'Dinâmica e efeitos da compressão sobre performance e margem antes da microfonia.',
  },
  'shure-placement': {
    title: 'Shure — Three Reasons Why Mic Placement Matters', version: '2014-09-24 / artigo sem revisão indicada', consultedOn: '2026-11-08', accessStatus: 'consulted', sections: ['Signal to Noise Ratio', 'Gain Before Feedback', 'The Sweet Spot'],
    url: 'https://www.shure.com/en-EU/insights/three-reasons-why-mic-placement-matters', scope: 'Posicionamento, vazamento, padrão polar e efeito de proximidade.',
  },
  'shure-live': {
    title: 'Shure — Microphone Techniques for Live Sound Reinforcement', version: 'publicação educacional, 39 páginas / sem revisão identificada', consultedOn: '2026-11-07', accessStatus: 'consulted', sections: ['Acoustic Characteristics (p.14)', 'Microphone Placement (p.22)'],
    url: 'https://www.shure.com/publications/microphone_techniques_for_live_sound_reinforcement_english.pdf',
    scope: 'Regras gerais de captação, acústica e ganho antes da microfonia; aplicação a samba/pagode é hipótese editorial MixAI.',
  },
  'shure-feedback': {
    title: 'Shure — How to Control Feedback in a Sound System',
    version: '2013-01-25 / página sem revisão indicada', consultedOn: '2026-11-08', accessStatus: 'consulted',
    url: 'https://www.shure.com/en-US/insights/how-to-control-feedback-in-a-sound-system',
    sections: ['What Causes Feedback', 'How to Interrupt a Feedback Loop', 'Pay Attention to Microphone and Monitor Placement', 'Remember the Fundamentals'],
    scope: 'Posicionamento e estabilidade; números e procedimentos de ring-out não são presets ou instruções automáticas MixAI.',
  },
  'band-report-65': {
    title: 'MixAI — contexto relatado da banda, Issue #65', url: 'https://github.com/dodoxbr/MixAI/issues/65',
    version: 'Relato de escopo em 2026-11-08', consultedOn: '2026-11-08', accessStatus: 'consulted',
    sections: ['Perfil confirmado no escopo; não é validação acústica'],
    scope: 'CH2 violão seis cordas P10; CH8 surdo sem grave relatado, causa não validada. Modelos de microfone permanecem no pacote existente.',
  },
  'akg-p3': {
    title: 'AKG P3 S — ficha do fabricante', url: 'https://br.akg.com/P3.html',
    version: 'Página sem revisão identificada; pacote banda-v1_2', consultedOn: '2026-11-07', accessStatus: 'historical',
    sections: ['Padrão polar / ficha técnica P3 S'],
    scope: 'Especificação preservada do pacote existente. Acesso HTTP 403 em 2026-11-08; não alegar nova consulta. Modelo por canal é relato do operador, não verificação física.',
  },
  'ui16-manual-pt': {
    title: 'Soundcraft Ui12/Ui16 Manual (Português)', version: 'v2.8 (Português)', consultedOn: '2026-11-07', accessStatus: 'unavailable',
    url: 'https://www.soundcraft.com/en/product_documents/ui_manual_v2-8_portuguese-pdf-f4a4a2c5-8071-4005-83d4-aad7ca399fb3',
    sections: ['Consulta complementar planejada; conteúdo não verificado nesta rodada (HTTP 403)'],
    scope: 'Referência de tradução somente. Não consultado com sucesso, não usado como evidência de afirmações ou de firmware.',
  },
};
