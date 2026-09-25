// Grok Voice — direct speech-to-speech with an xAI Voice Agent. The browser opens
// a WebSocket to our own server, which relays it to xAI's realtime API with the
// key held server-side. Protocol is OpenAI-Realtime-compatible: we stream mic
// PCM16 (24 kHz) up as input_audio_buffer.append and play response.output_audio
// deltas back. Server-side VAD handles turn-taking and barge-in.
import type { LiveCallbacks, LiveState, TranscriptRole } from "@/integrations/gemini/live-client";

const RATE = 24000; // xAI realtime PCM sample rate (in and out)

function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(bin);
}
function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // guard against odd byte lengths
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

export class GrokVoiceSession {
  private cb: LiveCallbacks;
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private inputCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private outputCtx: AudioContext | null = null;
  private nextPlayTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private active = false;
  private callerSaid = ""; // cumulative caller transcript (to emit only new suffix)

  constructor(cb: LiveCallbacks) {
    this.cb = cb;
  }

  private set(s: LiveState) {
    this.cb.onState?.(s);
  }

  async start() {
    if (this.active) return;
    this.active = true;
    this.set("connecting");

    // Unlock audio inside the click gesture (iOS), before any await.
    try {
      this.outputCtx = new AudioContext();
      this.nextPlayTime = 0;
      void this.outputCtx.resume();
      const s = this.outputCtx.createBufferSource();
      s.buffer = this.outputCtx.createBuffer(1, 1, this.outputCtx.sampleRate);
      s.connect(this.outputCtx.destination);
      s.start();
    } catch {
      /* fall back below */
    }

    try {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      this.ws = new WebSocket(`${proto}//${location.host}/api/grok/realtime`);
      this.ws.onopen = () => this.onOpen();
      this.ws.onmessage = (ev) => this.onMessage(ev);
      this.ws.onerror = () => this.fail("connection error");
      this.ws.onclose = () => {
        if (this.active) this.stop();
      };
    } catch (e: any) {
      this.fail(String(e?.message ?? e));
    }
  }

  private async onOpen() {
    // Configure server-side VAD + 24kHz PCM in/out.
    this.send({
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        audio: {
          input: { format: { type: "audio/pcm", rate: RATE } },
          output: { format: { type: "audio/pcm", rate: RATE } },
        },
      },
    });
    if (!this.outputCtx) {
      this.outputCtx = new AudioContext();
      this.nextPlayTime = 0;
    }
    await this.outputCtx.resume().catch(() => {});
    try {
      await this.startMic();
    } catch (e: any) {
      return this.fail(String(e?.message ?? e));
    }
    this.set("listening");
    // Prompt the opening greeting. xAI appends the current Jerusalem time to the
    // agent's instructions, so the time-of-day / after-hours greeting is decided
    // there (agent sessions reject injected text items — "unimplemented").
    this.send({ type: "response.create" });
  }

  private send(obj: unknown) {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    } catch {
      /* socket closing */
    }
  }

  private async startMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.inputCtx = new AudioContext({ sampleRate: RATE });
    const src = this.inputCtx.createMediaStreamSource(this.stream);
    this.processor = this.inputCtx.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (ev) => {
      if (!this.active) return;
      const input = ev.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.send({ type: "input_audio_buffer.append", audio: int16ToBase64(pcm) });
    };
    src.connect(this.processor);
    this.processor.connect(this.inputCtx.destination);
  }

  private onMessage(ev: MessageEvent) {
    let e: any;
    try {
      e = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    switch (e.type) {
      case "response.output_audio.delta":
        if (e.delta) {
          this.set("speaking");
          this.playChunk(e.delta);
        }
        break;
      case "response.output_audio_transcript.delta":
        if (e.delta) this.cb.onTranscript?.("dalit", e.delta);
        break;
      case "conversation.item.input_audio_transcription.delta":
        if (e.delta) this.cb.onTranscript?.("caller", e.delta);
        break;
      case "conversation.item.input_audio_transcription.updated":
      case "conversation.item.input_audio_transcription.completed": {
        // Cumulative — emit only the newly-added suffix so the UI doesn't duplicate.
        const full = String(e.transcript ?? e.text ?? "");
        if (full.startsWith(this.callerSaid)) {
          const suffix = full.slice(this.callerSaid.length);
          if (suffix) this.cb.onTranscript?.("caller", suffix);
        } else if (full) {
          this.cb.onTranscript?.("caller", full);
        }
        this.callerSaid = full;
        break;
      }
      case "input_audio_buffer.speech_started":
        // Barge-in: the caller started talking → drop queued audio.
        this.stopPlayback();
        this.callerSaid = "";
        break;
      case "response.done":
        this.set("listening");
        break;
      case "error":
        this.fail(e.error?.message || e.message || "grok error");
        break;
    }
  }

  private playChunk(b64: string) {
    if (!this.outputCtx) return;
    const int16 = base64ToInt16(b64);
    if (!int16.length) return;
    const buf = this.outputCtx.createBuffer(1, int16.length, RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 0x8000;
    const node = this.outputCtx.createBufferSource();
    node.buffer = buf;
    node.connect(this.outputCtx.destination);
    const now = this.outputCtx.currentTime;
    this.nextPlayTime = Math.max(this.nextPlayTime, now);
    node.start(this.nextPlayTime);
    this.nextPlayTime += buf.duration;
    this.sources.add(node);
    node.onended = () => this.sources.delete(node);
  }

  private stopPlayback() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    this.sources.clear();
    this.nextPlayTime = 0;
  }

  private fail(message: string) {
    this.cb.onError?.(message);
    this.set("error");
    this.stop();
  }

  stop() {
    this.active = false;
    this.stopPlayback();
    try {
      this.processor?.disconnect();
    } catch {}
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      this.inputCtx?.close();
    } catch {}
    try {
      this.outputCtx?.close();
    } catch {}
    try {
      this.ws?.close();
    } catch {}
    this.processor = null;
    this.stream = null;
    this.inputCtx = null;
    this.outputCtx = null;
    this.ws = null;
    this.set("idle");
  }
}
