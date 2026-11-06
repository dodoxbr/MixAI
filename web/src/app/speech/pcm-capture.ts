export const PRIVATE_PTT_SECONDS = 10;
export const PRIVATE_PTT_BYTES = 320044;
export interface PcmCapture {
  start(signal: AbortSignal, interrupted: () => void): Promise<void>;
  finish(): Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>;
  cancel(): void;
}
export function encodePcm(chunks: Int16Array[]): Uint8Array<ArrayBuffer> {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!samples || samples > 160000) throw new Error('LIMIT');
  const wav = new Uint8Array(44 + samples * 2);
  const view = new DataView(wav.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) { view.setInt16(offset, sample, true); offset += 2; }
  return wav;
}
/** Construct in the gesture so AudioContext.resume keeps user activation on Android. */
export class BrowserPcmCapture implements PcmCapture {
  private readonly context = new AudioContext();
  private readonly resumed = this.context.resume();
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private chunks: Int16Array[] = [];
  private samples = 0;
  private closed = false;
  private flushed?: (error?: Error) => void;
  constructor() { void this.resumed.catch(() => {}); }
  async start(signal: AbortSignal, interrupted: () => void): Promise<void> {
    signal.addEventListener('abort', () => this.cancel(), { once: true });
    if (signal.aborted || this.closed) { this.cancel(); throw new Error('CANCELLED'); }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
    if (signal.aborted || this.closed) { stream.getTracks().forEach(t => t.stop()); throw new Error('CANCELLED'); }
    this.stream = stream;
    stream.getTracks().forEach(t => t.addEventListener('ended', interrupted, { once: true }));
    await this.resumed;
    if (this.closed || signal.aborted) throw new Error('CANCELLED');
    if (this.context.sampleRate < 16000 || this.context.sampleRate > 96000 || !this.context.audioWorklet || this.context.state !== 'running') throw new Error('UNSUPPORTED');
    await this.context.audioWorklet.addModule('/speech-pcm-worklet.js');
    if (this.closed || signal.aborted) throw new Error('CANCELLED');
    this.node = new AudioWorkletNode(this.context, 'mixai-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.node.port.onmessage = event => {
      if (this.closed) return;
      if (event.data?.finished) { this.flushed?.(); return; }
      const pcm: unknown = event.data?.pcm;
      if (event.data?.limit || !(pcm instanceof Int16Array) || pcm.length > 1600 || this.samples + pcm.length > 160000) { interrupted(); return; }
      this.samples += pcm.length; this.chunks.push(pcm);
    };
    this.context.onstatechange = () => { if (!this.closed && this.context.state !== 'running') interrupted(); };
    this.source = this.context.createMediaStreamSource(stream);
    this.source.connect(this.node); this.node.connect(this.context.destination); // Worklet output is silence.
  }
  async finish(): Promise<Uint8Array<ArrayBuffer>> {
    // Stop hardware immediately, then drain only the already captured partial PCM batch.
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined;
    this.source?.disconnect(); this.source = undefined;
    try {
      if (!this.node || this.closed) throw new Error('CANCELLED');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.flushed = undefined; reject(new Error('UNSUPPORTED')); }, 500);
        this.flushed = error => { clearTimeout(timer); this.flushed = undefined; if (error) reject(error); else resolve(); };
        this.node!.port.postMessage('flush');
      });
      return encodePcm(this.chunks);
    } finally { this.cancel(); }
  }
  cancel(): void {
    this.closed = true; this.flushed?.(new Error('CANCELLED'));
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined;
    this.source?.disconnect(); this.node?.disconnect(); this.node?.port.close();
    this.context.onstatechange = null;
    void this.context.close().catch(() => {});
    this.chunks.forEach(chunk => chunk.fill(0)); this.chunks = []; this.samples = 0;
  }
}
