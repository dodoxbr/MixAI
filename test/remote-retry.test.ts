import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { paramKey } from '../src/core/revisions.js';
import { RemoteBackend } from '../src/mcp/remote.js';
import { MASTER } from '../src/mixer/types.js';
import { startTestServer } from './server-support.js';

type T = Awaited<ReturnType<typeof startTestServer>>;
const running: T[] = [];
afterEach(async () => {
  for (const t of running.splice(0)) await t.server.close();
});
async function start(opts: Parameters<typeof startTestServer>[0] = {}) {
  const t = await startTestServer(opts);
  running.push(t);
  return t;
}

const VOZ1 = paramKey.level(1, MASTER);
const isCommand = (url: string | URL | Request) => String(url).endsWith('/api/command');
const connReset = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

function backend(t: T, fetchImpl: typeof fetch) {
  return new RemoteBackend({ baseUrl: t.base, mode: 'lab', tokenFile: join(t.dir, 'agent-lab.token'), fetchImpl });
}

describe('MCP: escrita nunca repetida numa instância nova do servidor', () => {
  it('servidor executa e REINICIA antes de responder: INDETERMINATE, aplicado uma vez só', async () => {
    const t1 = await startTestServer();
    let t2: T | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (isCommand(url) && !t2) {
        const res = await fetch(url, init); // a escrita acontece no servidor 1
        await res.text();
        await t1.server.close(); // ... que cai antes de a resposta chegar
        t2 = await start({ dir: t1.dir, port: t1.server.port }); // e volta como outra instância
        throw connReset();
      }
      return fetch(url, init);
    };
    const r = await backend(t1, fetchImpl).setLevel({ channel: 'voz 1', deltaDB: 3 });
    expect(r.code).toBe('INDETERMINATE');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('PODE ter sido aplicada');
    expect(r.message).not.toContain('Nada foi alterado');
    expect(t2!.mixer.read(VOZ1)).toEqual({ known: true, value: -7 }); // -10 + 3, uma vez (não -4)
  });

  it('servidor reinicia ANTES de receber o pedido: refeito com segurança na instância nova', async () => {
    const t1 = await startTestServer();
    let t2: T | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (isCommand(url) && !t2) {
        await t1.server.close();
        t2 = await start({ dir: t1.dir, port: t1.server.port });
        return fetch(url, init); // chega no servidor 2 com o token e o serverId antigos → recusado sem executar
      }
      return fetch(url, init);
    };
    const r = await backend(t1, fetchImpl).setLevel({ channel: 'voz 1', deltaDB: 3 });
    expect(r.code).toBe('OK');
    expect(t2!.mixer.read(VOZ1)).toEqual({ known: true, value: -7 });
  });

  it('timeout depois de executar, mesma instância: a repetição devolve o resultado guardado', async () => {
    const t = await start();
    let first = true;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (isCommand(url) && first) {
        first = false;
        await (await fetch(url, init)).text(); // executou
        throw timeout(); // mas a resposta não chegou a tempo
      }
      return fetch(url, init);
    };
    const r = await backend(t, fetchImpl).setLevel({ channel: 'voz 1', deltaDB: 2 });
    expect(r.code).toBe('OK');
    expect(t.mixer.read(VOZ1)).toEqual({ known: true, value: -8 }); // uma vez
  });

  it('resposta perdida em todas as tentativas: INDETERMINATE, executado uma vez', async () => {
    const t = await start();
    let sent = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (isCommand(url)) {
        sent++;
        await (await fetch(url, init)).text();
        throw connReset();
      }
      return fetch(url, init);
    };
    const r = await backend(t, fetchImpl).setLevel({ channel: 'voz 1', deltaDB: 2 });
    expect(sent).toBeGreaterThan(1); // repetiu, com o mesmo requestId
    expect(r.code).toBe('INDETERMINATE');
    expect(r.message).not.toContain('Nada foi alterado');
    expect(t.mixer.read(VOZ1)).toEqual({ known: true, value: -8 });
  });

  it('servidor recusa pedido preso a outro serverId, sem executar', async () => {
    const t = await start();
    const op = await t.login('4321');
    const r = await t.command(op, { type: 'set_level', channel: 'voz 1', deltaDB: 2 }, { serverId: 'instancia-antiga' });
    expect(r.status).toBe(409);
    expect(r.json.result.code).toBe('SERVER_CHANGED');
    expect(t.mixer.read(VOZ1)).toEqual({ known: true, value: -10 });
  });

  it('leitura pode ser repetida livremente (não muda a mesa)', async () => {
    const t = await start();
    let first = true;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (isCommand(url) && first) {
        first = false;
        throw connReset();
      }
      return fetch(url, init);
    };
    expect((await backend(t, fetchImpl).mixState()).code).toBe('OK');
  });
});
