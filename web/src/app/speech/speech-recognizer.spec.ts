import { FixtureSpeechRecognizer, PushToTalk, type SpeechEnvironment, type SpeechRecognizer } from './speech-recognizer';

function setup(overrides: Partial<SpeechEnvironment> = {}, recognizer: SpeechRecognizer = new FixtureSpeechRecognizer()) {
  const stop = vi.fn();
  const track = { stop, addEventListener: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const env = { secure: () => true, available: () => true, allowed: () => true, getUserMedia: vi.fn(async () => stream), ...overrides };
  const ptt = new PushToTalk(env, recognizer);
  return { ptt, env, stop, stream };
}

it('produces a Portuguese fixture only after release and closes all tracks', async () => {
  const { ptt, stop } = setup();
  await ptt.press();
  expect(ptt.state).toBe('listening');
  expect(ptt.result).toBeUndefined();
  await ptt.release();
  expect(stop).toHaveBeenCalledOnce();
  expect(ptt.state).toBe('done');
  expect(ptt.result).toEqual({ text: 'Aumente a voz no meu fone', language: 'pt-BR', simulated: true });
});

it.each([
  [{ secure: () => false }, 'HTTPS'],
  [{ available: () => false }, 'indisponível'],
  [{ allowed: () => false }, 'flag'],
])('blocks unsafe/unavailable/unauthorized capture before permission', async (overrides, message) => {
  const { ptt, env } = setup(overrides);
  await ptt.press();
  expect(ptt.state).toBe('error');
  expect(ptt.error).toContain(message);
  expect(env.getUserMedia).not.toHaveBeenCalled();
});

it.each(['NotAllowedError', 'NotFoundError', 'NotReadableError'])('handles microphone failure %s', async name => {
  const { ptt } = setup({ getUserMedia: async () => { throw new DOMException('failure', name); } });
  await ptt.press();
  expect(ptt.state).toBe('error');
  expect(ptt.result).toBeUndefined();
  expect(ptt.error).toContain(name === 'NotAllowedError' ? 'negada' : 'abrir');
});

it.each(['cancel', 'release'] as const)('discards late permission after %s', async action => {
  let resolve!: (stream: MediaStream) => void;
  const { ptt, stream, stop } = setup({ getUserMedia: () => new Promise(r => { resolve = r; }) });
  const press = ptt.press();
  await ptt[action]();
  resolve(stream);
  await press;
  expect(stop).toHaveBeenCalledOnce();
  expect(ptt.state).toBe('cancelled');
});

it('invalidates a late transcription on cancellation without reviving the session', async () => {
  let finish!: (r: Awaited<ReturnType<SpeechRecognizer['finish']>>) => void;
  const recognizer = { state: 'idle' as const, start: vi.fn(async () => {}), finish: () => new Promise<Awaited<ReturnType<SpeechRecognizer['finish']>>>(r => { finish = r; }), cancel: vi.fn() };
  const { ptt, stop } = setup({}, recognizer);
  await ptt.press();
  const release = ptt.release();
  expect(stop).toHaveBeenCalledOnce();
  ptt.cancel();
  finish({ text: 'ignore', language: 'pt-BR', simulated: true });
  await release;
  expect(ptt.state).toBe('cancelled');
  expect(ptt.result).toBeUndefined();
});

it('caps capture duration and does not restart automatically', async () => {
  vi.useFakeTimers();
  try {
    const { ptt, stop, env } = setup();
    await ptt.press();
    await ptt.press();
    vi.advanceTimersByTime(15_000);
    expect(stop).toHaveBeenCalledOnce();
    expect(ptt.state).toBe('cancelled');
    expect(env.getUserMedia).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it('stops a stream when authorization is revoked while permission is pending', async () => {
  let allowed = true;
  let resolve!: (stream: MediaStream) => void;
  const { ptt, stream, stop } = setup({ allowed: () => allowed, getUserMedia: () => new Promise(r => { resolve = r; }) });
  const press = ptt.press();
  allowed = false;
  resolve(stream);
  await press;
  expect(stop).toHaveBeenCalledOnce();
  expect(ptt.state).toBe('cancelled');
});
