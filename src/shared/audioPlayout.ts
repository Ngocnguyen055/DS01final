export class PcmPlayout {
  private samples = new Float32Array(8000);
  private read = 0;
  private count = 0;
  private phase = 0;
  private playing = false;
  private last = 0;
  private sequence = -1;
  private faded = false;
  private append(value: number) {
    this.samples[(this.read + this.count) % this.samples.length] = value;
    this.count++;
  }
  push(data: Uint8Array, sequence?: number) {
    if (
      data.length !== 1280 ||
      (sequence !== undefined && sequence <= this.sequence)
    )
      return;
    const missing =
      sequence === undefined || this.sequence < 0
        ? 0
        : sequence - this.sequence - 1;
    if (missing > 8 || this.count + (missing + 1) * 640 > 6400) {
      this.read = 0;
      this.count = 0;
      this.phase = 0;
      this.playing = false;
      this.faded = true;
    } else if (missing) {
      const tail = this.count
        ? this.samples[(this.read + this.count - 1) % this.samples.length]
        : this.last;
      for (let i = 0; i < missing * 640; i++)
        this.append(tail * Math.max(0, 1 - i / 160));
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < 640; i++)
      this.append(
        (view.getInt16(i * 2, true) / 32768) *
          (missing ? Math.min(1, i / 80) : 1),
      );
    if (sequence !== undefined) this.sequence = sequence;
  }
  pull(output: Float32Array, rate: number) {
    const step = 16000 / rate;
    if (!this.playing && this.count >= 1920) this.playing = true;
    for (let i = 0; i < output.length; i++) {
      if (this.playing && this.count >= 2) {
        const a = this.samples[this.read],
          b = this.samples[(this.read + 1) % this.samples.length];
        let value = a + (b - a) * this.phase;
        if (this.faded) {
          value =
            this.last + Math.max(-0.02, Math.min(0.02, value - this.last));
          if (Math.abs(value - (a + (b - a) * this.phase)) < 0.001)
            this.faded = false;
        }
        output[i] = this.last = value;
        this.phase += step;
        const used = Math.floor(this.phase);
        this.phase -= used;
        this.read = (this.read + used) % this.samples.length;
        this.count -= used;
      } else {
        this.playing = false;
        this.faded = true;
        output[i] = this.last *= 0.98;
      }
    }
  }
  get bufferedSamples() {
    return this.count;
  }
}

export function playoutWorklet(name: string) {
  return `const PcmPlayout = (${PcmPlayout.toString()});
class VoicePlayout extends AudioWorkletProcessor {
    constructor(){ super(); this.queue = new PcmPlayout(); this.port.onmessage = e => this.queue.push(new Uint8Array(e.data.data), e.data.sequence); }
    process(inputs, outputs){ for(const output of outputs) if(output[0]) this.queue.pull(output[0], sampleRate); return true; }
} registerProcessor(${JSON.stringify(name)}, VoicePlayout);`;
}
