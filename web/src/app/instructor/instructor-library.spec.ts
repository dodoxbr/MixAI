import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { adaptInstructionCatalog } from './instructor-contract';
import { INSTRUCTOR_CATALOG, InstructorService } from './instructor.service';
import { InstructorLibraryError, LIBRARY_MESSAGES, libraryToCatalog, loadInstructorLibrary, parseServerLibrary } from './instructor-library';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';

const cite = (over: Record<string, unknown> = {}) => ({ source: 'shure-placement', title: 'Shure — Microphone Techniques', url: 'https://www.shure.com/x.pdf', version: '2024', section: 'Proximity effect', consultedOn: '2026-11-08', accessStatus: 'consulted', manufacturer: 'Shure', ...over });
const step = (id: string, over: Record<string, unknown> = {}) => ({ id, control: 'EQ / HPF', instruction: 'Inspecione o HPF separadamente do bypass paramétrico.', verification: 'Operador relata o que encontrou.', notFound: 'Não encontrei: pare e confirme a versão do manual.', risks: ['Interromper diante de apito.'], origin: 'editorial_investigation', references: [cite()], ...over });
const proc = (id: string, over: Record<string, unknown> = {}) => ({
  id, version: '1.0.0', purpose: 'EQ paramétrico, HPF e perda de corpo', instruments: ['vozes', 'surdo'], symptoms: ['magro', 'abafado'], validationStatus: 'theory', scope: 'official_ui_readonly',
  origin: 'mixai_editorial_adaptation', preconditions: ['Relato compatível.'], steps: [step(`${id}-context`), step(`${id}-inspect`)], stop: 'Parar se houver apito.', references: [cite()],
  execution: 'not_executable', realWrites: false, requiresHumanReview: true, ...over,
});
const library = (procedures: unknown[] = [proc('eq-hpf'), proc('voice-clarity')]) => ({ schemaVersion: 1, libraryVersion: '1.0.0', procedures });
const response = (status: number, body?: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('sem corpo'); return body; } }) as unknown as Response;

describe('adaptador da biblioteca real do Instrutor', () => {
  it('converte o contrato do servidor no contrato de apresentação sem inventar conteúdo', () => {
    const catalog = libraryToCatalog(parseServerLibrary(library()));
    const again = adaptInstructionCatalog(catalog); // passa também pelo validador existente do Instrutor
    expect(again.procedures.map((p) => p.id)).toEqual(['eq-hpf', 'voice-clarity']);
    const p = again.procedures[0]!;
    expect(p.title).toBe('EQ paramétrico, HPF e perda de corpo'); // título = purpose publicado
    expect(p).toMatchObject({ validation: 'theory', scope: 'lab_instruction' });
    expect(p.origin).toEqual({ title: 'Shure — Microphone Techniques', url: 'https://www.shure.com/x.pdf', locator: 'Proximity effect', version: '2024' });
    expect(p.interfaceLimit).toContain('não executável');
    expect(p.interfaceLimit).toContain('Parar se houver apito');
    expect(p.steps[0]).toMatchObject({ action: 'Inspecione o HPF separadamente do bypass paramétrico.', expected: 'Operador relata o que encontrou.', alternative: expect.stringContaining('Não encontrei'), caution: 'Interromper diante de apito.', schematic: ['EQ / HPF'] });
    expect(JSON.stringify(catalog)).not.toMatch(/fixture/i);
  });

  it.each([
    ['procedimento executável', proc('a1', { execution: 'executable' })],
    ['escrita REAL declarada', proc('a1', { realWrites: true })],
    ['sem revisão humana', proc('a1', { requiresHumanReview: false })],
    ['validação diferente de teoria', proc('a1', { validationStatus: 'validated' })],
    ['link não HTTPS', proc('a1', { references: [cite({ url: 'http://www.shure.com/x.pdf' })] })],
    ['link inválido', proc('a1', { references: [cite({ url: 'javascript:alert(1)' })] })],
    ['id inválido', proc('Bad Id!')],
    ['etapa sem texto', proc('a1', { steps: [step('s1', { instruction: '  ' })] })],
    ['etapa sem riscos', proc('a1', { steps: [step('s1', { risks: [] })] })],
    ['sem etapas', proc('a1', { steps: [] })],
    ['sem referências', proc('a1', { references: [] })],
  ])('recusa %s e invalida a biblioteca inteira', (_n, bad) => {
    expect(() => parseServerLibrary(library([proc('ok-one'), bad]))).toThrowError(InstructorLibraryError);
    try { parseServerLibrary(library([proc('ok-one'), bad])); } catch (e) { expect((e as InstructorLibraryError).code).toBe('incompatible'); }
  });

  it('versão desconhecida, ids duplicados e envelope inválido são incompatíveis; lista vazia é "empty"', () => {
    const code = (input: unknown) => { try { parseServerLibrary(input); return 'ok'; } catch (e) { return (e as InstructorLibraryError).code; } };
    expect(code({ ...library(), schemaVersion: 2 })).toBe('incompatible');
    expect(code(library([proc('x-one'), proc('x-one')]))).toBe('incompatible');
    expect(code(null)).toBe('incompatible');
    expect(code({ ...library(), procedures: 'x' })).toBe('incompatible');
    expect(code(library([]))).toBe('empty');
  });

  it('campos desconhecidos do servidor não chegam à apresentação nem viram ação', () => {
    const extra = library([proc('eq-hpf', { command: 'set_level', approvalToken: 'segredo', internalNotes: 'x', steps: [step('s1', { run: 'set_mute', selector: '#btn' })] })]);
    const catalog = libraryToCatalog(parseServerLibrary(extra));
    const text = JSON.stringify(catalog);
    expect(text).not.toMatch(/set_level|set_mute|segredo|internalNotes|#btn|approvalToken/);
    expect(Object.keys(catalog.procedures[0]!.steps[0]!).sort()).toEqual(['action', 'alternative', 'caution', 'control', 'expected', 'id', 'schematic']);
  });
});

describe('carregador padrão (GET somente leitura, com a sessão)', () => {
  it('chama só a rota fixa, com o token no cabeçalho, sem cookies e sem corpo', async () => {
    const f = vi.fn(async () => response(200, library()));
    const catalog = await loadInstructorLibrary(() => 'tok-123', f as unknown as typeof fetch);
    expect(catalog.procedures).toHaveLength(2);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/instructor/procedures');
    expect(init.method).toBeUndefined(); // GET
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok-123');
  });

  it.each([
    ['sem sessão local', null, undefined, 'session'],
    ['401 sessão expirada', 'tok', response(401, {}), 'session'],
    ['403 acesso negado', 'tok', response(403, {}), 'forbidden'],
    ['404 (fora do LAB)', 'tok', response(404, {}), 'unavailable'],
    ['500 servidor', 'tok', response(500, {}), 'unavailable'],
    ['resposta que não é JSON', 'tok', response(200), 'incompatible'],
    ['biblioteca vazia', 'tok', response(200, library([])), 'empty'],
    ['biblioteca com procedimento executável', 'tok', response(200, library([proc('a-b', { execution: 'executable' })])), 'incompatible'],
  ] as Array<[string, string | null, Response | undefined, string]>)('%s → %s', async (_n, token, res, code) => {
    const f = vi.fn(async () => res as Response);
    await expect(loadInstructorLibrary(() => token, f as unknown as typeof fetch)).rejects.toMatchObject({ code });
    if (token === null) expect(f).not.toHaveBeenCalled();
  });

  it('rede fora do ar → unavailable (sem vazar a mensagem do erro)', async () => {
    const f = vi.fn(async () => { throw new TypeError('fetch failed: segredo-interno'); });
    await expect(loadInstructorLibrary(() => 'tok', f as unknown as typeof fetch)).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
  });
});

describe('Instrutor com o carregador padrão (biblioteca real)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const setup = (fetchImpl: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    const token = signal<string | null>('tok-a');
    const expire = vi.fn();
    const hello = signal<unknown>({ mode: 'lab', role: 'musician', serverId: 's1' });
    TestBed.configureTestingModule({ providers: [{ provide: SessionService, useValue: { token, expire } }, { provide: LiveService, useValue: { hello, connection: signal('online'), command: vi.fn() } }] });
    return { service: TestBed.inject(InstructorService), expire };
  };

  it('usa o catálogo real por padrão (nenhuma fixture) e aceita músico e operador', async () => {
    const { service } = setup(async () => response(200, library()));
    await service.show();
    expect(service.error()).toBe('');
    expect(service.catalog()!.procedures.map((p) => p.validation)).toEqual(['theory', 'theory']);
    expect(service.catalog()!.procedures.some((p) => p.validation === 'fixture')).toBe(false);
    expect(TestBed.inject(INSTRUCTOR_CATALOG)).toBeTypeOf('function');
  });

  it('401: mostra o motivo e leva ao login pelo mesmo caminho das outras telas', async () => {
    const { service, expire } = setup(async () => response(401, {}));
    await service.show();
    expect(service.error()).toBe(LIBRARY_MESSAGES.session);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(service.catalog()).toBeNull();
  });

  it('indisponibilidade e ausência de procedimentos têm mensagem própria e permitem tentar de novo', async () => {
    let mode: 'down' | 'empty' | 'ok' = 'down';
    const { service, expire } = setup(async () => (mode === 'down' ? response(503, {}) : response(200, library(mode === 'empty' ? [] : undefined))));
    await service.show();
    expect(service.error()).toBe(LIBRARY_MESSAGES.unavailable);
    mode = 'empty'; await service.load();
    expect(service.error()).toBe(LIBRARY_MESSAGES.empty);
    mode = 'ok'; await service.load();
    expect(service.error()).toBe('');
    expect(service.catalog()!.procedures).toHaveLength(2);
    expect(expire).not.toHaveBeenCalled();
  });
});
