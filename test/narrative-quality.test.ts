import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_ROOT } from '../src/core/config.js';
import type { AiProvider } from '../src/knowledge/local/provider.js';
import { judgeNarrative, LocalKnowledge } from '../src/knowledge/local/service.js';
import { FileKnowledgeStore } from '../src/knowledge/local/store.js';

/**
 * Regressão: o resumo do modelo local (Qwen3 8B) preenchia o vazio quando os trechos eram fracos. Os textos abaixo
 * são respostas REAIS observadas no ROG. Sem sustentação, o resumo vira "sem base suficiente" (incerteza) e o
 * diagnóstico determinístico segue sozinho; um resumo coerente com o relato continua passando.
 */
const SEED = join(PROJECT_ROOT, 'knowledge', 'seed', 'banda-v1_2');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const passages = [{ excerpt: 'Proximity effect: bass response increases when the microphone is close to the source.' }];

const CONTRADICTORY = 'Pode ser que o microfone esteja posicionado muito longe da fonte sonora. O operador pode conferir a distância do microfone em relação ao cantor. Pode ser que o microfone esteja posicionado muito próximo da boca, causando abafamento. O operador pode conferir se o microfone está muito perto da boca e verificar o uso de um windscreen.';
const OFF_TOPIC = 'Pode ser que o microfone esteja posicionado muito próximo da fonte sonora, causando uma resposta de frequência desequilibrada. O operador pode conferir a distância e a direção do microfone em relação à fonte sonora.';
const BLAMES_OPERATOR = 'Pode ser que o operador esteja confundindo o HPF com outro controle. Pode ser que o HPF esteja desativado ou não esteja funcionando conforme esperado. O operador pode verificar se o HPF está ativado.';

describe('qualidade do resumo local: não preencher o vazio', () => {
  it.each([
    ['hipóteses opostas em frases separadas (longe × perto)', CONTRADICTORY, 'abafado', 'hipoteses_opostas'],
    ['resposta fora do assunto (microfonia → "resposta de frequência")', OFF_TOPIC, 'microfonia', 'fora_do_assunto'],
    ['especulação sobre o operador', BLAMES_OPERATOR, 'processamento', 'fora_do_assunto'],
  ])('%s é descartada como "sem base suficiente"', (_n, raw, symptom, rule) => {
    expect(judgeNarrative(raw, passages, { symptom })).toEqual({ status: 'empty', rule });
  });

  it('causas opostas (excesso × falta) e subir × reduzir em hipóteses separadas também contradizem', () => {
    expect(judgeNarrative('Pode ser que haja excesso de graves na captação. Pode ser que haja falta de graves na captação do surdo.', passages, { symptom: 'magro' })).toEqual({ status: 'empty', rule: 'hipoteses_opostas' });
    expect(judgeNarrative('Pode ser que o ganho do retorno esteja alto demais. Pode ser que o ganho do retorno esteja baixo demais para a voz.', passages, { symptom: 'monitoracao' })).toEqual({ status: 'empty', rule: 'hipoteses_opostas' });
  });

  it('respostas coerentes com o relato continuam passando', () => {
    for (const [text, symptom] of [
      ['Pode ser que o efeito de proximidade aumente os graves quando o cantor chega perto do microfone. O operador pode conferir a distância entre a boca e o microfone.', 'abafado'],
      ['Pode ser que o ganho do retorno esteja alto e favoreça a microfonia. O operador pode conferir o posicionamento do microfone em relação às caixas.', 'microfonia'],
      ['Pode ser que o filtro passa-alto seja ajustado pelo gráfico do HPF no equalizador. O operador pode conferir se o controle responde ao arrastar.', 'processamento'],
    ] as const) {
      expect(judgeNarrative(text, passages, { symptom }), text).toEqual({ text });
    }
  });

  it('a mesma hipótese de distância "longe ou perto demais" numa única frase não é contradição', () => {
    const text = 'Pode ser que a distância do microfone esteja longe ou perto demais para a voz. O operador pode conferir a distância entre a boca e o microfone.';
    expect(judgeNarrative(text, passages, { symptom: 'abafado' })).toEqual({ text });
  });

  it('sem sintoma conhecido a checagem de assunto não se aplica (consulta livre do operador)', () => {
    const text = 'Pode ser que o posicionamento influencie o timbre. O operador pode conferir a posição.';
    expect(judgeNarrative(text, passages)).toEqual({ text });
    expect(judgeNarrative(text, passages, { symptom: 'desconhecido' })).toEqual({ text });
  });

  it('as regras de segurança continuam valendo e têm prioridade', () => {
    expect(judgeNarrative('Pode ser o ganho; corte 3 dB em 250 Hz no retorno para a microfonia.', passages, { symptom: 'microfonia' })).toMatchObject({ status: 'blocked', rule: 'valor_de_processamento' });
  });
});

describe('no serviço: incerteza explícita, diagnóstico preservado e sem trocar de provedor', () => {
  async function run(reply: string, symptom: string, text: string) {
    const dir = mkdtempSync(join(tmpdir(), 'mixai-nq-'));
    dirs.push(dir);
    const store = new FileKnowledgeStore(join(dir, 'db.json'));
    await store.init();
    const bodies: Array<{ system: string; user: string }> = [];
    const local: AiProvider = {
      id: 'ollama', external: false,
      health: async () => ({ reachable: true, embedModel: true, chatModel: true, detail: 'ok' }),
      embed: async () => undefined,
      generateDetailed: vi.fn(async (system: string, user: string) => { bodies.push({ system, user }); return { text: reply }; }),
    };
    const other = { id: 'gemini' as const, external: true, health: async () => ({ reachable: true, embedModel: true, chatModel: true, detail: 'ok' }), embed: async () => undefined, generateDetailed: vi.fn(async () => ({ text: 'x' })) };
    const logs: string[] = [];
    const k = new LocalKnowledge({ store, chatProviders: [local, other], chat: 'ollama', inboxDir: join(dir, 'inbox'), seedDir: SEED, maxDocumentBytes: 1024 * 1024, maxPassages: 3, narrative: true, log: (m) => logs.push(m) });
    await k.importSeed();
    await store.replaceDocument({ sourceId: 'shure-live', fileName: 'shure-live.md', sha256: 'a', bytes: 1, chunks: [{ ordinal: 0, text: 'A microfonia e o efeito de proximidade dependem do ganho e do posicionamento do microfone perto da voz no retorno.', locator: 'p1' }] });
    const ctx = await k.enrich({ text, symptom, instrument: 'vozes', channel: 3 });
    return { ctx, bodies, local, other, logs };
  }

  it.each([
    ['contradição', CONTRADICTORY, 'abafado', 'a voz está abafada no retorno', 'empty:hipoteses_opostas'],
    ['fora do assunto', OFF_TOPIC, 'microfonia', 'está dando microfonia no microfone do Fred', 'empty:fora_do_assunto'],
  ])('%s: sem resumo, motivo registrado, trechos e ficha do microfone intactos, sem usar o Gemini', async (_n, reply, symptom, text, key) => {
    const { ctx, other, logs } = await run(reply, symptom, text);
    expect(ctx.narrative).toBeUndefined();
    expect(ctx.narrativeStatus).toMatchObject({ status: 'empty', provider: 'ollama' });
    expect(ctx.passages.length).toBeGreaterThan(0); // base continua
    expect(ctx.microphone?.model).toBe('AKG Perception P3 S'); // ficha confirmada do canal 3 continua
    expect(other.generateDetailed).not.toHaveBeenCalled(); // "sem base" não vira outra tentativa
    expect(logs.join('\n')).toContain(`motivo=${key}, provedor=ollama`);
    expect(logs.join('\n')).not.toMatch(/windscreen|frequência desequilibrada/); // sem conteúdo no log
  });

  it('o prompt exige ancoragem nos trechos, proíbe hipóteses opostas e manda declarar a falta de base', async () => {
    const { bodies } = await run('Pode ser que o ganho do retorno esteja alto; o operador pode conferir o posicionamento do microfone.', 'microfonia', 'microfonia no retorno');
    const system = bodies[0]!.system;
    expect(system).toContain('SOMENTE o que está dentro dos blocos <trecho>');
    expect(system).toContain('no máximo 3 frases');
    expect(system).toContain('hipóteses opostas');
    expect(system.toLowerCase()).toContain('não especule');
    expect(system.toLowerCase()).toContain('não há base suficiente nos trechos');
    expect(system).toContain('nunca diga que ouviu, analisou ou mediu o som');
  });

  it('resposta coerente continua sendo exibida como "não verificado"', async () => {
    const { ctx } = await run('Pode ser que o ganho do retorno esteja alto e favoreça a microfonia. O operador pode conferir o posicionamento do microfone.', 'microfonia', 'microfonia no microfone do Fred');
    expect(ctx.narrative).toMatchObject({ source: 'ollama', verified: false });
    expect(ctx.narrativeStatus).toMatchObject({ status: 'used' });
  });
});
