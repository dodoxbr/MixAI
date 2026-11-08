import { instructorGuidanceSchema, instructorProcedureSchema, instructorQuerySchema, type InstructorGuidance, type InstructorProcedure } from './instructor-contracts.js';
import { citations as sourceCitations } from './technical-modules.js';
import type { Instrument, Reference, Symptom } from './contracts.js';

export const FIELD_LIBRARY_VERSION = '1.0.0' as const;
/** Public editorial synthesis, not a manufacturer preset or a hardware observation. */
export interface TechnicalArticle {
  id: string; version: typeof FIELD_LIBRARY_VERSION; title: string; instruments: readonly Instrument[]; symptoms: readonly Symptom[];
  text: string; references: readonly Reference[]; validationStatus: 'theory'; origin: 'mixai_editorial_adaptation';
}
const ref = (source: Reference['source'], locator: string): Reference => ({ source, locator });
const citations = (refs: readonly Reference[]) => sourceCitations(refs).map(c => ({ ...c, manufacturer: (c.source.startsWith('shure') ? 'Shure' : c.source.startsWith('yamaha') ? 'Yamaha' : c.source.startsWith('akg') ? 'AKG' : c.source === 'band-report-65' ? 'MixAI' : 'Soundcraft') as 'Shure' | 'Yamaha' | 'AKG' | 'Soundcraft' | 'MixAI' }));
const placement = ref('shure-placement', 'Signal to Noise Ratio; Gain Before Feedback; proximity effect');
const eq = ref('yamaha-eq', 'Advanced EQ: peak/dip, Q, filters; examples are not MixAI presets');
const gain = ref('yamaha-gain', 'Input matching, gain/trim and headroom');
const dynamics = ref('yamaha-dynamics', 'Compression Advice: dynamics and gain before feedback');
const uiEq = ref('ui16-manual', '5.2: Parametric EQ, HPF, De-Esser; historical consultation, not firmware verification');
const uiAux = ref('ui16-manual', '4.3 AUX SENDS; 4.3.1 AUX MASTER: PRE/POST, aux sends and masters');
const uiDyn = ref('ui16-manual', '5.4 DYNAMICS: compressor/gate, THRESHOLD, RATIO, ATTACK, RELEASE');
const all: Instrument[] = ['vozes', 'surdo', 'tanta', 'pandeiro', 'cavaco', 'violao'];
const article = (id: string, title: string, instruments: Instrument[], symptoms: Symptom[], text: string, references: Reference[]): TechnicalArticle =>
  ({ id, title, instruments, symptoms, text, references, version: FIELD_LIBRARY_VERSION, validationStatus: 'theory', origin: 'mixai_editorial_adaptation' });

export const technicalArticles: readonly TechnicalArticle[] = [
  article('voice-clarity', 'Voz abafada e inteligibilidade no retorno', ['vozes'], ['abafado', 'embolado', 'desequilibrio'],
    'Voz abafada no retorno não identifica uma frequência. Compare a mesma frase sozinha e com a banda, no PA e no AUX1. Proximidade excessiva em microfone direcional pode acrescentar graves (proximity effect) e obscurecer consoantes; eixo e distância também mudam a captação. Se a voz é clara sozinha, investigue mascaramento pelo coro, cavaco ou violão antes de elevar presença. Clareza (intelligibility) não equivale a volume. Confira cortes de EQ existentes e dinâmica, sem presumir LPF. Não prescreva boost nem HPF universal.', [placement, eq, uiEq]),
  article('voice-nasal', 'Voz nasal, voz abafada e sibilância são relatos diferentes', ['vozes'], ['processamento', 'abafado', 'sibilancia'],
    'Som nasal é uma descrição perceptiva, não uma banda de EQ medida. Peça uma frase com vogais e consoantes e pergunte se a característica existe sem amplificação. Diferencie nasalidade, abafamento e sibilância antes de escolher processamento. Sibilância acompanha S/CH; um apito contínuo exige investigação de microfonia. Inspecione posição do microfone e EQ já usado; o de-esser documentado na Ui16 não é cura para toda voz nasal. Nunca deduza região espectral ou problema de saúde pelo relato.', [placement, eq, uiEq]),
  article('voice-proximity', 'Voz grave demais ao chegar perto do microfone', ['vozes'], ['embolado', 'abafado', 'magro'],
    'Em microfone direcional, aproximar a boca pode aumentar a proporção de graves: efeito de proximidade (proximity effect). Compare uma frase com distância consistente e nível confortável, sem pedir esforço vocal. Afastar demais pode aumentar vazamento e reduzir margem antes da microfonia; não imponha distância universal. O relato de voz grave demais não comprova ganho ou frequência. Registre se a mudança acompanha a posição e confirme o modelo e padrão polar no cadastro.', [placement]),
  article('p3-capture', 'AKG P3 S: captação e cadastro confirmado', ['vozes'], ['abafado', 'microfonia', 'magro'],
    'O AKG Perception P3 S é dinâmico cardioide conforme a ficha preservada no pacote versionado. Cardioide descreve diretividade, não elimina microfonia: posição, distância, ganho e vazamento continuam importantes. O modelo deve vir do cadastro confirmado por canal, nunca de um nome no chat. Não deduza EQ, ganho ou phantom a partir da sensibilidade da ficha. O relato de uso de P3 S não confirma como ele está posicionado no ensaio. A ficha do fabricante não é medição do áudio da banda.', [ref('akg-p3', 'Ficha técnica: cardioide, cápsula dinâmica; acesso histórico no pacote banda-v1_2'), placement]),
  article('feedback-pa', 'Microfonia e apito no PA', all, ['microfonia'],
    'Microfonando no PA é relato de possível realimentação (feedback), não medição. Se apitar ou causar desconforto, interrompa a escuta e chame o operador. Após conter o problema, confira relação entre microfones e caixas, padrão polar, quantidade de microfones abertos e mudanças recentes. A estabilidade depende da cadeia acústica e do ganho antes da microfonia. Não aumente nível para procurar frequência, não varra EQ com boost e não provoque ring-out com público. AFS2 não substitui captação adequada nem está autorizado no MixAI.', [ref('shure-feedback', 'What Causes Feedback; How to Interrupt a Feedback Loop; microphone and monitor placement'), placement, ref('ui16-manual', '5.3.1 AFS2')]),
  article('feedback-aux', 'Microfonia percebida nos fones AUX1', all, ['microfonia', 'monitoracao'],
    'Apito nos fones não comprova que os fones originam uma realimentação. AUX 1 é compartilhado: investigue vazamento acústico, caixas abertas no local, canal envolvido e caminho que alimenta o retorno. Pare a exposição desconfortável; não mande remover fones durante apito ativo para continuar o teste. Compare relato PA/AUX apenas depois de seguro. Na UI oficial confira AUX SENDS e AUX MASTER, MUTE e PRE/POST, sem alterar envios. Não copie o PA para o AUX1 nem aumente o master para compensar fonte ausente.', [ref('shure-feedback', 'How to Interrupt a Feedback Loop; placement'), uiAux]),
  article('gain-headroom', 'Ganho, entrada e clipping', all, ['clip', 'ganho', 'ruido'],
    'Ganho de entrada (gain/trim) e fader têm funções distintas. Um fader baixo não prova headroom na entrada e compressão posterior não repara transiente já saturado. Se há distorção, o operador deve localizar indicadores de sobrecarga na cadeia pela UI oficial e conferir compatibilidade da fonte, cabo, DI e entrada. P10 descreve conector; não confirma impedância, sinal balanceado ou necessidade de DI. Não altere ganho, phantom ou conexões para testar uma hipótese durante a escuta; medidor LAB não é leitura da mesa física.', [gain, ref('ui16-manual', '4.1 Gain; 5.4 Dynamics')]),
  article('eq-hpf', 'EQ paramétrico, HPF e perda de corpo', all, ['magro', 'abafado', 'estridente', 'processamento'],
    'EQ paramétrico usa frequência, ganho e largura/Q; descreve uma curva, não um detector de causa. HPF (filtro passa-alto) atenua abaixo de uma transição, podendo remover ruído ou corpo musical. Inspecione HPF separadamente do bypass de EQ conforme o manual; não presuma que bypass remove todos os filtros. Não copie cortes de voz para surdo ou tantã. A Ui16 documenta EQ de entrada e GEQ/RTA nas saídas, mas o MixAI não recebe espectro real; gráfico LAB e RTA do manual não equivalem a medição disponível.', [eq, uiEq, ref('ui16-manual', '5.3 Graphic EQ / RTA')]),
  article('compression-gate', 'Compressão, gate e sustentação', all, ['processamento', 'abafado', 'desequilibrio'],
    'Compressor atua na dinâmica acima do limiar (threshold), com ratio, attack e release; gate pode cortar finais de palavras e notas suaves. Antes de discutir compressão, confirme execução, captação e clipping. Compressão intensa ou compensação de saída pode prejudicar articulação e margem antes da microfonia; não recupera informação perdida na entrada. Som seco pode significar falta de corpo, pouca sustentação, ambiência ou preferência: peça esclarecimento. Não abra reverb, gate ou compressor automaticamente, nem presuma redução de ganho medida.', [dynamics, gain, uiDyn]),
  article('surdo-body', 'Surdo sem grave, seco ou sem definição', ['surdo'], ['magro', 'embolado', 'processamento'],
    'CH8 tem relato de surdo sem grave, sem causa validada; confirmar de novo no ensaio. Antes de boost, compare o som acústico e o amplificado no destino correto; confira afinação, abafamento, posição de captação, HPF/cortes existentes e capacidade de reprodução do PA. Som seco pode ser abafamento intencional ou falta de sustentação. Grave que some apenas em certas posições pode envolver ambiente ou cancelamento, mas faders não provam fase. Comparar surdo e tantã alternados e juntos ajuda a investigar caudas que embolam; não tratar surdo como bumbo idêntico nem compensar limite do sistema com subgrave.', [placement, eq, uiEq, ref('band-report-65', 'CH8: relato sem grave, sem causa validada')]),
  article('tanta-separation', 'Tantã embolado com surdo', ['tanta'], ['embolado', 'magro', 'desequilibrio'],
    'Tantã articula mãos e sustentação do groove; surdo fornece pulso e fundação. Se embolam juntos, compare ataque, cauda, afinação e vazamento em passagens alternadas e juntas. Investigue também baixarias do violão; não imponha divisão fixa de frequências. Gate pode apagar notas suaves, e HPF/cortes excessivos retiram corpo. Uma cauda longa pode vir do instrumento, ambiente ou processamento: ouvir relato no PA e AUX1 e inspecionar contexto antes de EQ ou compressão. Essas relações são adaptação editorial ao samba, não presets de fabricante.', [placement, eq, dynamics]),
  article('pandeiro-balance', 'Pandeiro estridente, platinelas e pele', ['pandeiro'], ['estridente', 'abafado', 'magro'],
    'Pandeiro reúne corpo da pele e ataque das platinelas; não é apenas fonte aguda. Som estridente pode acompanhar técnica, ângulo de captação, processamento ou distorção; diferencie cada relato de apito contínuo. Compare a mesma levada e posição do microfone em nível confortável. Se tirar brilho também apagar o ritmo, reveja captação antes de novo corte. HPF e compressão não devem eliminar pele ou dinâmica das mãos; não copie configuração de chimbal. Aplicação ao pagode é hipótese editorial, dependente de verificação humana.', [placement, eq, dynamics]),
  article('cavaco-space', 'Cavaco estridente ou encoberto', ['cavaco'], ['estridente', 'magro', 'desequilibrio'],
    'O cavaco conduz ataque rítmico e harmonia. Som metálico ou fino não comprova agudos em uma frequência específica; confira microfone ou captador/DI, técnica, compatibilidade de entrada e clipping. Se aparece sozinho mas some junto do violão e coro, investigue mascaramento de articulação e espaço no arranjo antes de elevar todos. Cordas beliscadas podem soar ásperas (harsh), mas adaptar princípios de acoustic guitar não transforma cavaco em violão nem autoriza preset. Preserve ritmo e dicção na comparação PA/AUX.', [placement, gain, eq]),
  article('guitar-six-p10', 'Violão de seis cordas via P10', ['violao'], ['magro', 'estridente', 'abafado', 'desequilibrio'],
    'Violão de seis cordas via P10 está informado para CH2 da banda, não caracteriza automaticamente captador ativo, passivo, sinal de linha ou entrada Hi-Z. Confirme instrumento, saída, cabo e DI antes de atribuir som fino ou seco ao EQ. P10 não é nome de impedância. Compare articulação de acordes e disputa com cavaco/vozes sem importar baixarias de sete cordas como fato deste canal. HPF/cortes altos podem retirar corpo; ganho excessivo pode saturar. Não reconecte cabo/DI nem altere phantom durante o teste.', [gain, eq, placement, ref('band-report-65', 'CH2: violão seis cordas via P10')]),
  article('monitor-shared', 'Monitoração, mascaramento e envio AUX1', all, ['monitoracao', 'desequilibrio', 'abafado'],
    'AUX 1 (aux sends) alimenta a mix compartilhada dos fones; uma fonte presente no PA pode ter envio ou MUTE diferente no retorno. PRE/POST determina relação com o fader (pre-fader ou post-fader), não ganho real da entrada. A UI oficial separa envios do canal e AUX MASTER. Se voz some só com a banda, confirme mascaramento pelo coro e instrumentos antes de subir o master. Posições iguais de faders não significam volumes acústicos iguais. Qualquer mudança afeta outros músicos; este procedimento apenas inspeciona e registra.', [uiAux, eq]),
];

function step(id: string, control: string, instruction: string, verification: string, refs: readonly Reference[], origin: 'manufacturer_documentation' | 'editorial_investigation' = 'editorial_investigation'): InstructorProcedure['steps'][number] {
  return { id, control, instruction, verification, notFound: 'Não encontrei: pare nesta etapa; confirme canal, versão do manual/firmware e peça ajuda ao operador. Não invente controle nem experimente botões.',
    risks: ['Nível desconfortável, perda de corpo ou mudança que afeta o AUX1 compartilhado: interromper e chamar operador.'], origin, references: citations(refs) };
}
/** Controls are manual labels, not browser selectors, addresses or command keys. */
export const instructorProcedures: readonly InstructorProcedure[] = technicalArticles.map(a => {
  const feedback = a.id.startsWith('feedback');
  const control = feedback ? 'PA / AUX SENDS / AUX MASTER' : a.id === 'gain-headroom' || a.id === 'guitar-six-p10' ? 'GAIN' : a.id === 'compression-gate' ? 'DYN / THRESHOLD / RATIO / ATTACK / RELEASE' : a.id === 'monitor-shared' ? 'AUX SENDS / AUX MASTER / PRE / POST / MUTE' : 'EQ / HPF';
  return instructorProcedureSchema.parse({ id: a.id, version: a.version, purpose: a.title, instruments: a.instruments, symptoms: a.symptoms,
    validationStatus: 'theory', scope: 'official_ui_readonly', origin: a.origin,
    preconditions: ['Relato compatível, fonte/canal e PA ou AUX1 confirmados.', 'Operador presente; nível confortável, sem apito ativo.', 'UI oficial identificada pelo operador; LAB é apenas simulação e não comprova firmware.'],
    steps: [
      step(`${a.id}-context`, 'Fonte / destino (sem controle a alterar)', feedback ? 'Se há apito ou desconforto, interrompa a escuta e chame operador antes de continuar.' : 'Registre o relato e compare a mesma passagem na fonte e no conjunto, em nível confortável, sem ajustar parâmetros.', 'Registrar apenas o que o músico/operador relatou, sem promover a medição.', a.references),
      step(`${a.id}-inspect`, control, a.text, 'Operador relata o que encontrou ou informa “não encontrei”; não há leitura automática nem causa confirmada.', a.references),
      step(`${a.id}-record`, 'Registro humano', 'Registre se houve achado, ausência de mudança, piora ou impossibilidade de conferir. Encaminhe ao operador, sem criar proposta ou restaurar parâmetros.', 'Interromper diante de piora, apito ou dúvida. Não repetir teste inseguro.', a.references),
    ], stop: 'Parar se houver apito, distorção persistente, desconforto, dúvida de conexão ou controle não encontrado; nenhuma reversão automática.',
    references: citations(a.references), execution: 'not_executable', realWrites: false, requiresHumanReview: true });
});

/** Pure public API consumed by the instructor/backend; no store/provider/core dependency. */
export function queryInstructorGuidance(raw: unknown): InstructorGuidance {
  const input = instructorQuerySchema.parse(raw);
  const reports = input.evidence.filter(e => (e.kind === 'operator_report' || e.kind === 'musician_report') && e.symptom === input.symptom);
  const missing = [...(!reports.length ? ['compatible_report'] : []), ...(!input.instrument ? ['instrument'] : []), ...(!input.channel ? ['channel'] : []), ...(!input.destination ? ['destination'] : [])];
  const procedures = missing.length ? [] : instructorProcedures.filter(p => p.symptoms.includes(input.symptom) && p.instruments.includes(input.instrument!))
    .filter(p => p.id !== 'p3-capture') // model-specific catalog information is not inferred for an unknown microphone
    .filter(p => input.symptom !== 'microfonia' || p.id.startsWith('feedback-'))
    .filter(p => !p.id.startsWith('feedback-') || p.id === (input.destination === 'pa' ? 'feedback-pa' : 'feedback-aux'));
  return instructorGuidanceSchema.parse({ schemaVersion: 1, libraryVersion: FIELD_LIBRARY_VERSION, status: missing.length ? 'needs_context' : 'inspection_only',
    missing, procedures, evidenceIds: reports.map(e => e.id), measurements: 'unavailable', observedState: 'not_acquired', proposal: null, authorizedActions: [], execution: 'not_executable' });
}
