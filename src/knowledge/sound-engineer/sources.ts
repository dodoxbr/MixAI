import type { SourceId } from './contracts.js';

export const sources: Readonly<Record<SourceId, {
  title: string; url: string; version: string; consultedOn: string; scope: string;
}>> = {
  'ui16-manual': {
    title: 'Soundcraft Ui12/Ui16 User Guide', version: 'v3.0 (English)', consultedOn: '2026-11-06',
    url: 'https://www.soundcraft.com/en-US/product_documents/ui_usermanual_v3-0-pdf-27c992b4-5132-4d2d-b8e2-79750de6ee29',
    scope: 'Recursos documentados; firmware da mesa da banda desconhecido. Versão do manual não é versão de firmware.',
  },
  'library-7.1.0': {
    title: 'soundcraft-ui-connection', version: '7.1.0 / MIT', consultedOn: '2026-11-06',
    url: 'https://github.com/fmalcher/soundcraft-ui',
    scope: 'Declarações e código do pacote instalado e fixado no lockfile; protocolo não oficial; sem validação física.',
  },
  'yamaha-eq': {
    title: 'Yamaha — Equalization', version: 'artigo técnico', consultedOn: '2026-11-06',
    url: 'https://hub.yamaha.com/proaudio/livesound/eq/', scope: 'Fundamentos de EQ, Q, HPF e mascaramento; não define capacidades da Ui16.',
  },
  'yamaha-gain': {
    title: 'Yamaha — Gain Staging', version: 'artigo técnico', consultedOn: '2026-11-06',
    url: 'https://hub.yamaha.com/proaudio/livesound/gain-staging/', scope: 'Compatibilidade de entrada, estrutura de ganho e headroom; sem importar alvos numéricos de outra mesa.',
  },
  'yamaha-dynamics': {
    title: 'Yamaha — How to Use a Compressor', version: 'artigo técnico', consultedOn: '2026-11-06',
    url: 'https://hub.yamaha.com/proaudio/livesound/tools-of-the-trade-how-to-use-a-compressor/', scope: 'Dinâmica e efeitos da compressão sobre performance e margem antes da microfonia.',
  },
  'shure-placement': {
    title: 'Shure — Three Reasons Why Mic Placement Matters', version: 'artigo técnico', consultedOn: '2026-11-06',
    url: 'https://www.shure.com/en-EU/insights/three-reasons-why-mic-placement-matters', scope: 'Posicionamento, vazamento, padrão polar e efeito de proximidade.',
  },
  'shure-live': {
    title: 'Shure — Microphone Techniques for Live Sound Reinforcement', version: 'publicação educacional', consultedOn: '2026-11-06',
    url: 'https://content-files.shure.com/dievision/archive/damfiles/default/global/documents/publications/en/performance-production/microphone_techniques_for_live_sound_reinforcement_english.pdf-3df433145fca686a736beeb5da588efa.pdf',
    scope: 'Regras gerais de captação, acústica e ganho antes da microfonia; aplicação a samba/pagode é hipótese editorial MixAI.',
  },
};
