/* Same-origin PCM capture. Silent output; no network, storage or command access. */
class MixaiPcm extends AudioWorkletProcessor {
  sum = 0; count = 0; phase = 0; frames = 0; buffer = [];
  stopped = false;
  constructor() {
    super();
    this.port.onmessage = event => {
      if (event.data === 'flush') { this.flush(); this.stopped = true; this.port.postMessage({ finished: true }); }
    };
  }
  flush() {
    if (!this.buffer.length) return;
    const pcm = Int16Array.from(this.buffer); this.buffer.fill(0); this.buffer = [];
    this.port.postMessage({ pcm }, [pcm.buffer]);
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const value of input) {
      this.sum += value; this.count++; this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        const mono = Math.max(-1, Math.min(1, this.sum / this.count));
        this.buffer.push(Math.round(mono * (mono < 0 ? 32768 : 32767)));
        this.sum = 0; this.count = 0;
        if (++this.frames >= 160000) { this.port.postMessage({ limit: true }); this.buffer.fill(0); return false; }
        if (this.buffer.length === 1600) {
          this.flush();
        }
      }
    }
    return true;
  }
}
registerProcessor('mixai-pcm', MixaiPcm);
