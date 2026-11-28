import { playoutWorklet } from "./audioPlayout.ts";
const worklet = `class VoiceCapture extends AudioWorkletProcessor {
    constructor() { super(); this.buffer = new Int16Array(640); this.offset = 0; this.phase = 0; this.sum = 0; this.count = 0; }
    process(inputs) {
        const samples = inputs[0]?.[0];
        if (samples) for (const value of samples) {
            this.sum += value; this.count++; this.phase += 16000;
            if (this.phase >= sampleRate) {
                this.phase -= sampleRate;
                this.buffer[this.offset++] = Math.max(-1, Math.min(1, this.sum / this.count)) * 32767;
                this.sum = 0; this.count = 0;
                if (this.offset === 640) { this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]); this.buffer = new Int16Array(640); this.offset = 0; }
            }
        }
        return true;
    }
} registerProcessor('ds01-voice', VoiceCapture);`;

export class RelayMedia {
  private context?: AudioContext;
  private capture?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private silent?: GainNode;
  private destination?: MediaStreamAudioDestinationNode;
  private video?: HTMLVideoElement;
  private timer?: ReturnType<typeof setInterval>;
  private player?: AudioWorkletNode;
  private frameUrl?: string;
  private stopped = false;
  private pumping = false;
  private videoBusy = false;
  private audioBusy = false;
  private remote?: MediaStream;
  private processorName = "ds01-voice-" + crypto.randomUUID();
  private stateChanged = () =>
    this.config.playback(this.context?.state === "suspended");
  constructor(
    private config: {
      send: (kind: "audio" | "video", data: Uint8Array) => Promise<void>;
      remote: (stream: MediaStream, frame?: string) => void;
      error: (error: unknown) => void;
      playback: (blocked: boolean) => void;
    },
    private sharedContext?: AudioContext,
  ) {}
  unlock() {
    if (this.stopped) return;
    try {
      if (!this.context) {
        this.context =
          this.sharedContext ||
          new AudioContext({ latencyHint: "interactive" });
        this.context.addEventListener("statechange", this.stateChanged);
      }
      void this.context
        .resume()
        .then(() => this.config.playback(false))
        .catch(() => this.config.playback(true));
    } catch (error) {
      this.config.error(error);
    }
  }
  async prepare(stream: MediaStream, kind: "audio" | "video") {
    this.unlock();
    const context = this.context;
    if (!context?.audioWorklet)
      throw Error(
        "Trình duyệt chưa hỗ trợ truyền âm thanh dự phòng. Hãy dùng Chrome, Edge hoặc Safari mới.",
      );
    const url = URL.createObjectURL(
      new Blob(
        [worklet.replace("'ds01-voice'", JSON.stringify(this.processorName))],
        { type: "text/javascript" },
      ),
    );
    const playbackUrl = URL.createObjectURL(
      new Blob([playoutWorklet(this.processorName + "-play")], {
        type: "text/javascript",
      }),
    );
    try {
      await context.audioWorklet.addModule(url);
      await context.audioWorklet.addModule(playbackUrl);
    } finally {
      URL.revokeObjectURL(url);
      URL.revokeObjectURL(playbackUrl);
    }
    if (this.stopped) return;
    this.destination = context.createMediaStreamDestination();
    this.remote = this.destination.stream;
    this.player = new AudioWorkletNode(context, this.processorName + "-play", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.player.connect(this.destination);
    this.capture = new AudioWorkletNode(context, this.processorName);
    this.capture.port.onmessage = (event) => {
      if (!this.pumping || this.stopped || this.audioBusy) return;
      this.audioBusy = true;
      void this.config
        .send("audio", new Uint8Array(event.data))
        .catch(this.config.error)
        .finally(() => {
          this.audioBusy = false;
        });
    };
    this.source = context.createMediaStreamSource(stream);
    this.silent = context.createGain();
    this.silent.gain.value = 0;
    this.source.connect(this.capture);
    this.capture.connect(this.silent);
    this.silent.connect(context.destination);
    if (kind === "video") {
      this.video = document.createElement("video");
      this.video.muted = true;
      this.video.autoplay = true;
      this.video.playsInline = true;
      this.video.srcObject = stream;
      await this.video.play();
    }
    if (!this.stopped) this.config.remote(this.remote);
  }
  start() {
    if (this.stopped || this.pumping) return;
    this.pumping = true;
    if (this.video) {
      const canvas = document.createElement("canvas"),
        context = canvas.getContext("2d");
      this.timer = setInterval(() => {
        const video = this.video;
        if (
          this.videoBusy ||
          this.stopped ||
          !context ||
          !video ||
          video.readyState < 2
        )
          return;
        this.videoBusy = true;
        void (async () => {
          canvas.width = 320;
          canvas.height = Math.max(
            2,
            Math.min(
              320,
              Math.round((320 * video.videoHeight) / (video.videoWidth || 320)),
            ),
          );
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          for (const quality of [0.55, 0.3, 0.12]) {
            const blob = await new Promise<Blob | null>((resolve) =>
              canvas.toBlob(resolve, "image/jpeg", quality),
            );
            if (blob && blob.size <= 11000) {
              if (!this.stopped)
                await this.config.send(
                  "video",
                  new Uint8Array(await blob.arrayBuffer()),
                );
              break;
            }
          }
        })()
          .catch(this.config.error)
          .finally(() => {
            this.videoBusy = false;
          });
      }, 150);
    }
  }
  receive(kind: "audio" | "video", data: Uint8Array, sequence?: number) {
    if (this.stopped || !this.remote) return;
    if (kind === "video") {
      if (
        data.length < 4 ||
        data[0] !== 255 ||
        data[1] !== 216 ||
        data.length > 11000
      )
        throw Error("invalid relay video");
      const previous = this.frameUrl;
      this.frameUrl = URL.createObjectURL(
        new Blob([new Uint8Array(data)], { type: "image/jpeg" }),
      );
      this.config.remote(this.remote, this.frameUrl);
      if (previous) URL.revokeObjectURL(previous);
    } else {
      if (!this.player || data.length !== 1280)
        throw Error("invalid relay audio");
      const copy = new Uint8Array(data);
      this.player.port.postMessage({ data: copy.buffer, sequence }, [
        copy.buffer,
      ]);
    }
  }
  close() {
    this.stopped = true;
    this.pumping = false;
    clearInterval(this.timer);
    this.capture?.port.close();
    this.capture?.disconnect();
    this.source?.disconnect();
    this.silent?.disconnect();
    this.player?.port.close();
    this.player?.disconnect();
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }
    this.remote?.getTracks().forEach((track) => track.stop());
    if (this.frameUrl) URL.revokeObjectURL(this.frameUrl);
    this.context?.removeEventListener("statechange", this.stateChanged);
    if (!this.sharedContext && this.context?.state !== "closed")
      void this.context?.close().catch(() => {});
  }
}
