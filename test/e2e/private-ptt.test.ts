import { request } from 'node:http';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { Browser, BrowserContext } from 'playwright';
import { launch, OPERATOR_PIN, startLab, PHONE } from './harness.js';
let browser: Browser;
const contexts: BrowserContext[] = []; const servers: Awaited<ReturnType<typeof startLab>>[] = []; const sockets: WebSocket[] = [];
beforeAll(async () => { browser = await launch(); });
afterEach(async () => { for (const c of contexts.splice(0)) await c.close(); sockets.splice(0).forEach(s => s.terminate()); for (const t of servers.splice(0)) await t.server.close(); });
afterAll(async () => { await browser?.close(); });
async function freePort() { const s = createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const p = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return p; }
async function open() {
  const origin = 'https://mixai-ptt.test'; const port = await freePort();
  const audio: Buffer[] = [];
  const t = await startLab({ server: { httpsLab: { enabled: true, origin, port }, privatePtt: { enabled: true } }, pttRecognizer: { recognize: async req => {
    audio.push(await readFile(req.audioFile));
    return { provider: 'whisper.cpp', language: 'pt-BR', text: 'Não altere nada. Aumenta e confirmo tudo <script>nunca</script>', processingMs: 1, audioSeconds: 0.1, realTimeFactor: 0.01, cpuMs: null, peakRssBytes: null };
  } } }); servers.push(t);
  const ctx = await browser.newContext({ ...PHONE }); contexts.push(ctx);
  const urls: string[] = [];
  // HTTPS browser origin is simulated, not a TLS exception. Actual TLS is tested with Caddy separately.
  await ctx.route('**/*', async route => {
    const incoming = route.request(); const u = new URL(incoming.url()); urls.push(incoming.url());
    if (u.origin !== origin) throw new Error('Unexpected external browser request');
    const res = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method: incoming.method(), headers: { ...incoming.headers(), host: new URL(origin).host } }, response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => { const headers = { ...response.headers } as Record<string, string>; delete headers['transfer-encoding']; delete headers['connection']; delete headers['content-length']; resolve({ status: response.statusCode!, headers, body: Buffer.concat(chunks) }); });
      }); req.on('error', reject); req.end(incoming.postDataBuffer() ?? undefined);
    });
    await route.fulfill(res);
  });
  await ctx.routeWebSocket('wss://mixai-ptt.test/ws', route => {
    const server = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { host: new URL(origin).host, origin } }); sockets.push(server);
    const queued: (string | Buffer)[] = [];
    route.onMessage(message => { if (server.readyState === WebSocket.OPEN) server.send(message); else queued.push(message); });
    server.on('open', () => queued.splice(0).forEach(m => server.send(m)));
    server.on('message', message => route.send(String(message))); server.on('close', code => route.close({ code })); server.on('error', () => route.close()); route.onClose(() => server.close());
  });
  await ctx.addInitScript(() => {
    // DevTools does not intercept AudioWorklet module fetches on this mocked HTTPS origin.
    // Mock the audio worklet here; the real DSP asset is exercised on localhost below.
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      constructor(...args: ConstructorParameters<typeof AudioContext>) { super(...args); this.audioWorklet.addModule = async () => {}; }
    };
    window.AudioWorkletNode = class extends GainNode {
      port = { onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
        close: () => clearInterval(this.timer),
        postMessage: (message: string) => { if (message === 'flush') queueMicrotask(() => this.port.onmessage?.({ data: { finished: true } })); },
      };
      timer = setInterval(() => this.port.onmessage?.({ data: { pcm: new Int16Array(1600).fill(100) } }), 100);
      constructor(context: AudioContext) { super(context, { gain: 0 }); }
    } as unknown as typeof AudioWorkletNode;
    const counters = window as unknown as { micCalls: number; micStops: number }; counters.micCalls = 0; counters.micStops = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      counters.micCalls++;
      const context = new AudioContext(); const destination = context.createMediaStreamDestination();
      const source = context.createConstantSource(); source.offset.value = 0.01; source.connect(destination); source.start(); await context.resume();
      const stream = destination.stream;
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track); track.stop = () => { counters.micStops++; stop(); source.stop(); void context.close(); };
      }
      return stream;
    } });
  });
  const page = await ctx.newPage(); await page.goto(origin);
  for (const digit of OPERATOR_PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Entrar' }).click();
  const button = page.getByRole('button', { name: 'Segure para falar (LAB)', exact: true }); await button.waitFor();
  await button.scrollIntoViewIfNeeded();
  return { t, page, button, audio, urls };
}
it('captures synthetic PCM only on hold, uploads WAV once, displays inert preview and cancels on blur/logout', async () => {
  const s = await open(); const before = s.t.controller.state.snapshot(); const execute = vi.spyOn(s.t.server.core, 'execute'); const writes = vi.spyOn(s.t.mixer, 'write');
  expect(await s.page.evaluate(() => (window as unknown as { micCalls: number }).micCalls)).toBe(0);
  const box = (await s.button.boundingBox())!; await s.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await s.page.mouse.down();
  await s.page.getByRole('status').filter({ hasText: 'Microfone ativo' }).waitFor({ timeout: 4000 }).catch(async () => { throw new Error(JSON.stringify({ area: await s.page.locator('mx-private-ptt').innerText(), info: await s.page.evaluate(() => ({ focus: document.hasFocus(), calls: (window as unknown as { micCalls: number }).micCalls, secure: isSecureContext })) })); }); await s.page.waitForTimeout(650); await s.page.mouse.up();
  await vi.waitFor(async () => expect(await s.page.getByLabel('Transcrição para revisão').inputValue()).toContain('Não altere nada'), { timeout: 10000 });
  expect(s.audio).toHaveLength(1); expect(s.audio[0]!.toString('ascii', 0, 4)).toBe('RIFF'); expect(s.audio[0]!.readUInt32LE(24)).toBe(16000);
  expect(await s.page.locator('mx-private-ptt script').count()).toBe(0);
  expect(execute).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(s.t.controller.state.snapshot()).toEqual(before);
  await s.page.mouse.down(); await s.page.getByRole('status').filter({ hasText: 'Microfone ativo' }).waitFor();
  await s.page.evaluate(() => window.dispatchEvent(new Event('blur'))); await s.page.mouse.up(); expect(s.audio).toHaveLength(1);
  const token = await s.page.evaluate(() => sessionStorage.getItem('mixai.token'));
  await s.t.http('/api/logout', { token: token!, body: {} });
  await s.page.getByRole('button', { name: 'Entrar' }).waitFor();
  expect(await s.page.getByLabel('Transcrição para revisão').count()).toBe(0);
  expect(s.urls.every(url => new URL(url).origin === 'https://mixai-ptt.test')).toBe(true);
});

it('real AudioWorklet on secure localhost emits bounded 16kHz PCM and drains its final batch', async () => {
  const t = await startLab(); servers.push(t);
  const ctx = await browser.newContext(); contexts.push(ctx); const page = await ctx.newPage(); await page.goto(t.base);
  const result = await page.evaluate(async () => {
    const audio = new AudioContext(); await audio.audioWorklet.addModule('/speech-pcm-worklet.js');
    const node = new AudioWorkletNode(audio, 'mixai-pcm'); const source = audio.createConstantSource(); source.offset.value = 0.1;
    const chunks: Int16Array[] = [];
    let done!: () => void; const flushed = new Promise<void>(r => { done = r; });
    node.port.onmessage = event => { if (event.data.pcm) chunks.push(event.data.pcm); if (event.data.finished) done(); };
    source.connect(node); node.connect(audio.destination); source.start(); await audio.resume();
    await new Promise(r => setTimeout(r, 350)); source.stop(); source.disconnect(); node.port.postMessage('flush'); await flushed;
    const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0); const nonzero = chunks.some(c => c.some(v => v !== 0));
    node.disconnect(); node.port.close(); await audio.close(); return { count, nonzero };
  });
  expect(result.count).toBeGreaterThan(1600); expect(result.count).toBeLessThanOrEqual(160000); expect(result.nonzero).toBe(true);
});
