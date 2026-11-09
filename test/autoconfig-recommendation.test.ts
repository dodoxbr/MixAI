import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AutoConfigProposal } from '../src/autoconfig/contracts.js';
import {
  DraftError, MODEL_SYSTEM, PARAMETER_RULES, adjustmentSchema, bandRecommendationKnowledge, buildMenu as buildMenuWith, draftFromAdjustment, modelPrompt as modelPromptWith, parameterKind, parseModelText,
  recommend as recommendWith, recommendationSchema, type Adjustment, type Recommendation, type RecommendationInput,
} from '../src/autoconfig/recommendation/index.js';
import { PROJECT_ROOT } from '../src/core/config.js';
import { ParamRegistry, LIMITS } from '../src/core/params.js';
import { paramKey } from '../src/core/revisions.js';
import { eqGuides } from '../src/knowledge/sound-engineer/eq-guides.js';

/**
 * AutoConfig 2.0 — recomendações. Cenários SINTÉTICOS da banda (CH8 surdo, CH3 voz principal, CH6 voz no AUX1, CH1 cavaco).
 * Nenhum valor aqui é medição: níveis/EQ "lidos" são o que o servidor ou o operador declaram; frequências vêm dos guias editoriais.
 */
const KB = bandRecommendationKnowledge;
const recommend = (input: unknown, selection?: unknown) => recommendWith(input, KB, selection);
const buildMenu = (input: unknown) => buildMenuWith(input, KB);
const modelPrompt = (input: unknown) => modelPromptWith(input, KB);
const SERVER = 'lab-server-01', REV = 41;
const base = { mode: 'LAB', serverId: SERVER, stateRevision: REV } as const;
const rep = (symptom: RecommendationInput['symptom'], kind: 'operator_report' | 'musician_report' = 'operator_report') => ({ id: 'report-0001', kind, symptom });
const eq = (kind: 'eq_band_freq' | 'eq_band_gain' | 'hpf_freq', value: number, band?: number) => ({ parameter: band ? { kind, band } : { kind }, value, reportId: 'report-eq01' });

const surdo = (extra: Partial<RecommendationInput> = {}): RecommendationInput => ({ ...base, channel: 8, instrument: 'surdo', role: 'instrument', destination: 'PA', symptom: 'magro', report: rep('magro'), ...extra }) as RecommendationInput;
const lead = (extra: Partial<RecommendationInput> = {}): RecommendationInput => ({ ...base, channel: 3, instrument: 'vozes', role: 'lead', destination: 'PA', symptom: 'desequilibrio', report: rep('desequilibrio'), isolation: 'ensemble', observedLevel: { value: -6, revision: REV }, ...extra }) as RecommendationInput;
const voiceAux = (extra: Partial<RecommendationInput> = {}): RecommendationInput => ({ ...base, channel: 6, instrument: 'vozes', role: 'backing', destination: 'AUX1', symptom: 'abafado', report: rep('abafado', 'musician_report'), ...extra }) as RecommendationInput;
const cavaco = (extra: Partial<RecommendationInput> = {}): RecommendationInput => ({ ...base, channel: 1, instrument: 'cavaco', role: 'instrument', destination: 'PA', symptom: 'estridente', report: rep('estridente'), ...extra }) as RecommendationInput;

const kind = (r: Recommendation) => r.kind;
const reasons = (i: RecommendationInput) => buildMenu(i).verifications.map(v => v.reason);
const adj = (r: Recommendation): Adjustment => { expect(r.kind).toBe('adjustment'); return r as Adjustment; };
const GUIDE = (id: 'vozes' | 'cavaco' | 'surdo') => eqGuides.find(g => g.id === id)!;

describe('CH8 — surdo sem grave: nunca um boost; só o que o guia sustenta', () => {
  it('sem saber o HPF, pede para ler o HPF (e a comparação sozinho × banda); não propõe valor', () => {
    expect(reasons(surdo())).toEqual(['hpf_state', 'isolation_check']);
    const r = recommend(surdo());
    expect(r).toMatchObject({ kind: 'verification_request', reason: 'hpf_state', authorization: 'not_granted', execution: 'not_executable', realWrites: false });
    expect(r.kind === 'verification_request' && r.uncertainty.level).toBe('very_high');
  });
  it('HPF informado acima do guia → sugere desligar o HPF (valor do guia), valor atual vindo do operador', () => {
    const a = adj(recommend(surdo({ isolation: 'alone', operatorEq: [eq('hpf_freq', 80)] })));
    expect(a.parameter).toEqual({ kind: 'hpf_freq' });
    expect(a.current).toMatchObject({ provenance: 'operator_reported', value: 80 });
    expect(a.proposed).toMatchObject({ provenance: 'ai_suggested', mode: 'absolute', value: GUIDE('surdo').model.hpf.freq, validation: 'unvalidated', basis: 'editorial_trial' });
    expect(a.rollback).toMatchObject({ automatic: false, previous: a.current });
    expect(a.uncertainty.level).not.toBe('medium');
    expect(a.risks.join(' ')).toMatch(/PA e AUX1|PA/);
  });
  it('HPF já desligado → o problema não é o HPF: pede conferir a captação, sem inventar EQ', () => {
    expect(reasons(surdo({ operatorEq: [eq('hpf_freq', 20)] }))[0]).toBe('capture_check');
    expect(buildMenu(surdo({ operatorEq: [eq('hpf_freq', 20)] })).candidates).toEqual([]);
  });
  it('em nenhum caso o surdo recebe ganho positivo de EQ ou de nível', () => {
    for (const hpf of [undefined, 20, 40, 80, 200]) {
      for (const c of buildMenu(surdo({ operatorEq: hpf ? [eq('hpf_freq', hpf)] : undefined })).candidates) expect(c.parameter.kind === 'eq_band_gain' && c.proposed.value > 0).toBe(false);
    }
  });
});

describe('CH3 — voz principal encoberta pelo coro: passo de nível relativo, só com nível observado', () => {
  it('sem o papel confirmado, sem comparação sozinho × banda ou sem nível observado, o pedido é de verificação', () => {
    expect(reasons(lead({ role: 'unknown' }))).toEqual(['role_confirmation']);
    expect(reasons(lead({ isolation: 'unknown' }))).toEqual(['isolation_check']);
    expect(reasons(lead({ isolation: undefined }))).toEqual(['isolation_check']);
    expect(reasons(lead({ observedLevel: undefined }))).toEqual(['level_reading']);
    expect(reasons(lead({ observedLevel: { value: -6, revision: REV - 1 } }))).toEqual(['level_reading']); // leitura de outra revisão
    expect(reasons(lead({ observedLevel: { value: '-inf', revision: REV } }))).toEqual(['level_reading']);
    expect(reasons(lead({ observedLevel: { value: 9.5, revision: REV } }))).toEqual(['level_reading']); // sem folga no fader
    expect(reasons(lead({ role: 'backing' }))).toEqual(['role_confirmation']);
  });
  it('com tudo declarado: +1 dB na voz principal, valor atual OBSERVADO, evidência de relato + estado + conhecimento', () => {
    const a = adj(recommend(lead()));
    expect(a).toMatchObject({ channel: 3, destination: 'PA', parameter: { kind: 'level_main' }, authorization: 'not_granted', execution: 'not_executable', realWrites: false, requiresHumanReview: true });
    expect(a.current).toEqual({ provenance: 'observed', value: -6, unit: 'dB', revision: REV, origin: 'lab_state' });
    expect(a.proposed).toMatchObject({ provenance: 'ai_suggested', mode: 'delta', value: 1, unit: 'dB', validation: 'unvalidated' });
    expect(a.evidence.map(e => e.kind)).toEqual(expect.arrayContaining(['operator_report', 'lab_observation', 'knowledge']));
    expect(a.evidence.find(e => e.kind === 'lab_observation')).toMatchObject({ audio: false });
    expect(a.knowledge.every(k => k.version && k.consultedOn && k.sourceId)).toBe(true);
    expect(a.stopConditions.length).toBeGreaterThan(0); expect(a.verification).toBeTruthy(); expect(a.preconditions.length).toBeGreaterThan(0);
    expect(a.rollback).toMatchObject({ automatic: false, previous: a.current });
    expect(a.uncertainty.level).toBe('high');
  });
  it('no AUX1 o parâmetro é o envio ao AUX1 e o risco cita que é compartilhado', () => {
    const a = adj(recommend(lead({ destination: 'AUX1' })));
    expect(a.parameter.kind).toBe('level_aux1');
    expect(a.risks.join(' ')).toMatch(/compartilhado/);
  });
});

describe('CH6 — voz abafada no AUX1: EQ de canal só com muita evidência', () => {
  const full = (extra: Partial<RecommendationInput> = {}) => voiceAux({ comparison: 'both', isolation: 'alone', confirmed: { capture: true }, operatorEq: [eq('eq_band_freq', 300, 2), eq('eq_band_gain', 0, 2)], ...extra });
  it('cada evidência faltante vira UMA pergunta, na ordem: comparação → captação → isolamento → frequência → valor atual', () => {
    expect(reasons(voiceAux())).toEqual(['listening_comparison']);
    expect(reasons(voiceAux({ comparison: 'unknown' }))).toEqual(['listening_comparison']);
    expect(reasons(voiceAux({ comparison: 'both' }))).toEqual(['capture_check']);
    expect(reasons(voiceAux({ comparison: 'both', confirmed: { capture: true } }))).toEqual(['isolation_check']);
    expect(reasons(voiceAux({ comparison: 'both', confirmed: { capture: true }, isolation: 'alone' }))).toEqual(['band_frequency']);
    expect(reasons(full({ operatorEq: [eq('eq_band_freq', 500, 2)] }))).toEqual(['band_frequency']); // frequência diferente da do guia
    expect(reasons(full({ operatorEq: [eq('eq_band_freq', 300, 2)] }))).toEqual(['current_value']);
  });
  it('problema só no AUX1: o EQ do canal também mudaria o PA → nenhuma recomendação de EQ', () => {
    const r = recommend(full({ comparison: 'target_only' }));
    expect(r).toMatchObject({ kind: 'refusal', reason: 'no_candidate' });
  });
  it('com tudo informado: corte do guia, com a frequência da banda como PRÉ-REQUISITO conhecido', () => {
    const g = GUIDE('vozes').model.bands[1]!;
    const a = adj(recommend(full()));
    expect(a.parameter).toEqual({ kind: 'eq_band_gain', band: 2 });
    expect(a.proposed).toMatchObject({ mode: 'absolute', value: g.gain });
    expect(a.current).toMatchObject({ provenance: 'operator_reported', value: 0 });
    expect(a.requires).toEqual([{ parameter: { kind: 'eq_band_freq', band: 2 }, equals: g.freq, current: expect.objectContaining({ provenance: 'operator_reported', value: g.freq }) }]);
    expect(a.evidence.some(e => e.kind === 'musician_report' && e.verified === false)).toBe(true);
    expect(a.risks.join(' ')).toMatch(/PA e AUX1/);
    expect(a.knowledge.find(k => k.id === 'eq-guide:vozes')).toMatchObject({ validationStatus: 'editorial_unvalidated' });
  });
  it('corte já existente igual ou maior → não há o que propor: volta a pedir captação', () => {
    expect(reasons(full({ operatorEq: [eq('eq_band_freq', 300, 2), eq('eq_band_gain', -3, 2)] }))).toEqual(['capture_check']);
  });
});

describe('CH1 — cavaco estridente: mesma disciplina, valores do guia do cavaco', () => {
  it('sem captação confirmada, pede conferir a captação; nada de EQ', () => {
    expect(reasons(cavaco({ comparison: 'both' }))).toEqual(['capture_check']);
  });
  it('com captação, frequência e ganho informados → corte do guia em 3 kHz', () => {
    const g = GUIDE('cavaco').model.bands[1]!;
    const a = adj(recommend(cavaco({ comparison: 'target_only', isolation: 'alone', confirmed: { capture: true }, operatorEq: [eq('eq_band_freq', g.freq, 2), eq('eq_band_gain', 0, 2)] })));
    expect(a.proposed).toMatchObject({ value: g.gain, mode: 'absolute' });
    expect(a.requires[0]).toMatchObject({ equals: g.freq });
    expect(a.risks.join(' ')).toMatch(/PA e AUX1/);
  });
});

describe('o que o sistema recusa ou não representa', () => {
  it.each(['input_gain', 'compressor', 'gate', 'phantom', 'de_esser', 'afs'] as const)('"%s" não é representado: recusa explícita, sem valor', (requested) => {
    const r = recommend(surdo({ requested }));
    expect(r).toMatchObject({ kind: 'refusal', reason: 'unsupported_parameter', unsupported: requested });
    expect(JSON.stringify(r)).not.toMatch(/"value"|deltaDB/);
  });
  it('microfonia ou apito ativo → parada de segurança, nenhum ajuste', () => {
    expect(recommend(lead({ symptom: 'microfonia', report: rep('microfonia') }))).toMatchObject({ kind: 'refusal', reason: 'safety_stop' });
    expect(recommend(lead({ feedback: 'active' }))).toMatchObject({ kind: 'refusal', reason: 'safety_stop' });
  });
  it('caso sem regra, relato divergente e entrada inválida ou com chaves extras → recusa', () => {
    expect(recommend(surdo({ symptom: 'clip', report: rep('clip') }))).toMatchObject({ kind: 'refusal', reason: 'no_candidate' });
    expect(recommend(surdo({ report: rep('abafado') }))).toMatchObject({ kind: 'refusal', reason: 'insufficient_evidence' });
    expect(recommend({ ...surdo(), command: 'ch.8.main.level=0' })).toMatchObject({ kind: 'refusal', reason: 'insufficient_evidence' });
    expect(recommend('ligue o phantom')).toMatchObject({ kind: 'refusal' });
  });
  it('só o que o registro da mesa conhece: os parâmetros do contrato espelham o ParamRegistry e seus limites', () => {
    const reg = new ParamRegistry({ inputs: 12, aux: 6 } as never);
    const spec = (k: string) => reg.get(k as never)!;
    expect(PARAMETER_RULES.level_main.capability).toBe(spec(paramKey.level(1, { kind: 'master' } as never)).capability);
    expect(PARAMETER_RULES.eq_band_gain).toMatchObject({ min: LIMITS.eqGain.min, max: LIMITS.eqGain.max, capability: spec('ch.1.eq.b1.gain').capability });
    expect(PARAMETER_RULES.hpf_slope.allowed).toEqual(LIMITS.hpfSlopes);
    for (const k of parameterKind.options) expect(['library_verified', 'simulated_only']).toContain(PARAMETER_RULES[k].capability);
    // só nível é observável pelo servidor e só nível entra no núcleo D v1
    expect(parameterKind.options.filter(k => PARAMETER_RULES[k].observable)).toEqual(['level_main', 'level_aux1']);
    expect(parameterKind.options.filter(k => PARAMETER_RULES[k].draftableInD)).toEqual(['level_main', 'level_aux1']);
  });
});

describe('proveniência e invariantes do contrato (não dá para forjar)', () => {
  const good = () => structuredClone(adj(recommend(lead()))) as Record<string, any>;
  const goodEq = () => structuredClone(adj(recommend(voiceAux({ comparison: 'both', isolation: 'alone', confirmed: { capture: true }, operatorEq: [eq('eq_band_freq', 300, 2), eq('eq_band_gain', 0, 2)] })))) as Record<string, any>;
  const rejects = (v: unknown) => expect(adjustmentSchema.safeParse(v).success).toBe(false);
  it('o objeto bom passa; os mesmos objetos adulterados não', () => {
    expect(adjustmentSchema.safeParse(good()).success).toBe(true);
    expect(adjustmentSchema.safeParse(goodEq()).success).toBe(true);
  });
  it.each([
    ['autorização concedida', (a: any) => { a.authorization = 'granted'; }],
    ['execução permitida', (a: any) => { a.execution = 'executable'; }],
    ['escrita real', (a: any) => { a.realWrites = true; }],
    ['sem revisão humana', (a: any) => { a.requiresHumanReview = false; }],
    ['valor atual "sugerido pela IA"', (a: any) => { a.current = { ...a.proposed }; }],
    ['valor atual desconhecido num ajuste', (a: any) => { a.current = { provenance: 'unknown', reason: 'not_reported' }; a.rollback.previous = a.current; }],
    ['proveniência "medido"', (a: any) => { a.current = { provenance: 'measured', value: -6, unit: 'dB' }; }],
    ['nível "informado pelo operador" em vez de observado', (a: any) => { a.current = { provenance: 'operator_reported', value: -6, unit: 'dB', reportId: 'report-0001' }; a.rollback.previous = a.current; }],
    ['passo de nível acima do limite do núcleo D', (a: any) => { a.proposed.value = 5; }],
    ['passo de nível nulo', (a: any) => { a.proposed.value = 0; }],
    ['nível em modo absoluto', (a: any) => { a.proposed.mode = 'absolute'; }],
    ['passo que estoura o fader', (a: any) => { a.current.value = 9.5; a.rollback.previous = a.current; }],
    ['reversão que não aponta para o valor atual', (a: any) => { a.rollback.previous = { ...a.current, value: -3 }; }],
    ['reversão automática', (a: any) => { a.rollback.automatic = true; }],
    ['sem relato humano', (a: any) => { a.evidence = a.evidence.filter((e: any) => e.kind !== 'operator_report'); }],
    ['sem conhecimento citado', (a: any) => { a.evidence = a.evidence.filter((e: any) => e.kind !== 'knowledge'); }],
    ['evidência de áudio', (a: any) => { a.evidence.push({ kind: 'audio_measurement', rta: [1, 2] }); }],
    ['observação com áudio', (a: any) => { a.evidence.find((e: any) => e.kind === 'lab_observation').audio = true; }],
    ['fonte do valor fora da lista', (a: any) => { a.proposed.knowledgeId = 'inventado'; }],
    ['incerteza média com pendência', (a: any) => { a.uncertainty = { level: 'medium', reasons: ['x'], missing: ['current_value'] }; }],
    ['chave extra (comando embutido)', (a: any) => { a.command = { path: 'ch.3.main.level', value: 0 }; }],
  ])('rejeita %s', (_n, mutate) => { const a = good(); mutate(a); rejects(a); });
  it.each([
    ['EQ observado pelo servidor', (a: any) => { a.current = { provenance: 'observed', value: 0, unit: 'dB', revision: 1, origin: 'lab_state' }; a.rollback.previous = a.current; }],
    ['EQ em modo relativo', (a: any) => { a.proposed.mode = 'delta'; }],
    ['ganho de EQ fora de ±20 dB', (a: any) => { a.proposed.value = -25; }],
    ['sugestão igual ao valor atual', (a: any) => { a.proposed.value = a.current.value; }],
    ['unidade errada', (a: any) => { a.proposed.unit = 'Hz'; }],
    ['pré-requisito sem valor conhecido', (a: any) => { a.requires[0].current = { provenance: 'unknown', reason: 'not_reported' }; }],
  ])('rejeita (EQ) %s', (_n, mutate) => { const a = goodEq(); mutate(a); rejects(a); });
  it('parâmetro de banda exige banda; os demais não aceitam banda', () => {
    const a = goodEq(); a.parameter = { kind: 'eq_band_gain' }; rejects(a);
    const b = good(); b.parameter = { kind: 'level_main', band: 2 }; rejects(b);
  });
});

describe('o modelo só escolhe; nunca digita', () => {
  const full = lead();
  it('select/abstain válidos', () => {
    expect(recommend(full, { kind: 'select', candidate: 'c1' }).kind).toBe('adjustment');
    expect(recommend(surdo(), { kind: 'abstain', reason: 'needs_verification', verification: 'v2' })).toMatchObject({ kind: 'verification_request', reason: 'isolation_check' });
    expect(recommend(surdo(), { kind: 'abstain', reason: 'insufficient_evidence' })).toMatchObject({ kind: 'verification_request', reason: 'hpf_state' });
    expect(recommend(full, { kind: 'abstain', reason: 'unsafe' })).toMatchObject({ kind: 'refusal', reason: 'safety_stop' });
  });
  it('saída fora do contrato, candidato inexistente ou campos extras → recusa, sem fallback para "pior caso"', () => {
    for (const bad of [{ kind: 'select', candidate: 'c3' }, { kind: 'select', candidate: 'c1', value: 3 }, { kind: 'select', candidate: 'c1', deltaDB: 2 }, { kind: 'set', path: 'ch.3.main.level', value: 0 }, { kind: 'abstain', reason: 'because' }, 'c1', 7, null]) {
      expect(recommend(full, bad), JSON.stringify(bad)).toMatchObject({ kind: 'refusal' });
    }
    expect(recommend(surdo(), { kind: 'abstain', reason: 'needs_verification', verification: 'v3' })).toMatchObject({ kind: 'refusal', reason: 'invalid_model_output' });
    expect(recommend(surdo(), { kind: 'select', candidate: 'c1' })).toMatchObject({ kind: 'refusal', reason: 'invalid_model_output' }); // não há candidato: só verificações
  });
  it('texto do modelo: JSON estrito de até 2 KB; números, prosa e comandos são descartados', () => {
    expect(parseModelText('{"kind":"select","candidate":"c1"}')).toEqual({ kind: 'select', candidate: 'c1' });
    for (const bad of ['', 'ligue o phantom', '{"kind":"select","candidate":"c1","value":9}', '```json\n{}\n```', `{"kind":"abstain","reason":"unsafe","x":"${'a'.repeat(3000)}"}`, undefined, 42]) expect(parseModelText(bad)).toBeUndefined();
  });
  it('o prompt leva só categorias: sem número de canal, nomes, relato, identificadores, valores ou URLs', () => {
    const p = modelPrompt(lead({ observedLevel: { value: -6, revision: REV } }));
    expect(p).not.toMatch(/report-0001|lab-server|"channel"|-6|https?:|\.json|ch\.\d/);
    expect(JSON.parse(p).candidates[0]).toEqual({ id: 'c1', parameter: 'level_main', direction: 'raise', basis: expect.any(Array) });
    expect(MODEL_SYSTEM).toMatch(/Não gere comandos, números/);
  });
});

describe('vínculo com o contexto e ponte para o núcleo D', () => {
  it('determinístico; muda com a revisão, o canal, o servidor ou o conhecimento', () => {
    const fp = (i: RecommendationInput) => adj(recommend(i)).binding.contextFingerprint;
    expect(fp(lead())).toBe(fp(lead()));
    expect(fp(lead({ stateRevision: REV + 1, observedLevel: { value: -6, revision: REV + 1 } }))).not.toBe(fp(lead()));
    expect(fp(lead({ channel: 4 }))).not.toBe(fp(lead()));
    expect(fp(lead({ serverId: 'outro-servidor' }))).not.toBe(fp(lead()));
    expect(fp(lead({ observedLevel: { value: -9, revision: REV } }))).not.toBe(fp(lead()));
  });
  const ctx = { serverId: SERVER, stateRevision: REV };
  it('o passo é sempre do OPERADOR: sem ele não há rascunho; aceitar o conselho é uma escolha registrada', () => {
    const a = adj(recommend(lead()));
    const followed = draftFromAdjustment(a, ctx, 1);
    expect(followed).toMatchObject({ followedAdvice: true, suggestion: { operation: 'level_delta', channel: 3, deltaDB: 1 } });
    expect(draftFromAdjustment(a, ctx, 2).followedAdvice).toBe(false);
    expect(draftFromAdjustment(a, ctx, -1).suggestion.deltaDB).toBe(-1);
    // o rascunho é aceito pelo contrato do núcleo D, e a justificativa deixa claro que não é aprovação
    expect(AutoConfigProposal.safeParse({ schemaVersion: 1, items: [followed.suggestion] }).success).toBe(true);
    expect(followed.suggestion.rationale).toMatch(/não é autorização/);
    expect(JSON.stringify(followed.suggestion)).not.toMatch(/approv|authoriz.*granted|digest/i);
  });
  it('recusa passo inválido, contexto antigo, EQ/HPF (fora do núcleo D v1) e objetos que não são ajustes', () => {
    const a = adj(recommend(lead()));
    for (const step of [0, 4, -3.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => draftFromAdjustment(a, ctx, step)).toThrow(DraftError);
    expect(() => draftFromAdjustment(a, { ...ctx, stateRevision: REV + 1 }, 1)).toThrow(expect.objectContaining({ code: 'STALE_CONTEXT' }));
    expect(() => draftFromAdjustment(a, { ...ctx, serverId: 'outro-servidor' }, 1)).toThrow(expect.objectContaining({ code: 'STALE_CONTEXT' }));
    const hpf = adj(recommend(surdo({ isolation: 'alone', operatorEq: [eq('hpf_freq', 80)] })));
    expect(() => draftFromAdjustment(hpf, ctx, 1)).toThrow(expect.objectContaining({ code: 'NOT_DRAFTABLE' }));
    expect(() => draftFromAdjustment(recommend(surdo()), ctx, 1)).toThrow(expect.objectContaining({ code: 'NOT_AN_ADJUSTMENT' }));
    expect(() => draftFromAdjustment({ ...a, authorization: 'granted' }, ctx, 1)).toThrow(DraftError);
  });
  it('toda recomendação produzida passa no esquema público e traz os sinalizadores de segurança', () => {
    const all = [surdo(), surdo({ isolation: 'alone', operatorEq: [eq('hpf_freq', 80)] }), lead(), voiceAux(), cavaco(), surdo({ requested: 'phantom' })];
    for (const i of all) {
      const r = recommend(i);
      expect(recommendationSchema.safeParse(r).success).toBe(true);
      expect(r).toMatchObject({ authorization: 'not_granted', execution: 'not_executable', realWrites: false, requiresHumanReview: true, measurements: 'unavailable', scope: 'lab_simulation' });
      expect(kind(r)).toMatch(/adjustment|verification_request|refusal/);
    }
  });
});

describe('isolamento do módulo', () => {
  it('contratos e motor não importam a base de conhecimento: só o adaptador, e só pelo índice público', () => {
    for (const f of ['contracts.ts', 'engine.ts']) {
      const imports = [...readFileSync(join(PROJECT_ROOT, 'src', 'autoconfig', 'recommendation', f), 'utf8').matchAll(/from '([^']+)'/g)].map(m => m[1]!);
      for (const i of imports) expect(i, `${f} importa ${i}`).not.toMatch(/knowledge/);
    }
    const adapter = readFileSync(join(PROJECT_ROOT, 'src', 'autoconfig', 'recommendation', 'kb-adapter.ts'), 'utf8');
    expect([...adapter.matchAll(/from '([^']+knowledge[^']*)'/g)].map(m => m[1])).toEqual(['../../knowledge/sound-engineer/index.js']);
  });
  it('não importa mesa, controlador, fila, servidor, rede, modelos nem provedores', () => {
    for (const f of ['contracts.ts', 'engine.ts', 'index.ts', 'kb-adapter.ts']) {
      const src = readFileSync(join(PROJECT_ROOT, 'src', 'autoconfig', 'recommendation', f), 'utf8');
      const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]!);
      for (const i of imports) expect(i, `${f} importa ${i}`).not.toMatch(/mixer|controller|queue|server|assistant|fetch|ollama|gemini|provider|service|routes|serve|undici|node:(?:net|http|https|child_process|fs)/);
      expect(src).not.toMatch(/\bfetch\(|\.write\(|execute\(|process\.env/);
    }
  });
});
