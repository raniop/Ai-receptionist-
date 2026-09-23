// Dalit's real-time voice session on the Gemini Live API. The browser gets a
// short-lived ephemeral token from our server, opens the Live WebSocket directly,
// streams mic audio (16 kHz PCM) up, plays model audio (24 kHz PCM) down, and runs
// tool calls through src/integrations/gemini/tools.ts. The real API key stays server-side.
import { GoogleGenAI, Modality } from "@google/genai";
import { buildSystemInstruction, TOOL_DECLARATIONS } from "@/lib/dalit-live-prompt";
import { runTool } from "./tools";

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
// After Dalit finishes and the caller stays silent this long, she checks back in.
const SILENCE_PROMPT_MS = 10000;

export type LiveState = "idle" | "connecting" | "listening" | "speaking" | "thinking" | "error";
export type TranscriptRole = "caller" | "dalit";

export type LiveCallbacks = {
  onState?: (s: LiveState) => void;
  onTranscript?: (role: TranscriptRole, text: string) => void;
  onError?: (message: string) => void;
};

// ── base64 <-> PCM helpers ───────────────────────────────────────────────────
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
  return new Int16Array(bytes.buffer);
}

export class DalitLiveSession {
  private cb: LiveCallbacks;
  private ai: GoogleGenAI | null = null;
  private session: any = null;
  private stream: MediaStream | null = null;
  private inputCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private outputCtx: AudioContext | null = null;
  private nextPlayTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private active = false;
  private voice: string;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceCount = 0;

  constructor(cb: LiveCallbacks, voice = "Aoede") {
    this.cb = cb;
    this.voice = voice;
  }

  private set(s: LiveState) {
    this.cb.onState?.(s);
  }

  async start() {
    if (this.active) return;
    this.active = true;
    this.set("connecting");
    try {
      // 1) ephemeral token from our server
      const r = await fetch("/api/gemini/token", { method: "POST" });
      if (!r.ok) throw new Error("token endpoint failed");
      const { token, model } = (await r.json()) as { token: string; model: string };

      this.ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });

      // 2) open the Live session
      this.session = await this.ai.live.connect({
        model,
        callbacks: {
          onopen: () => {},
          onmessage: (m: any) => this.onMessage(m),
          onerror: (e: any) => this.fail(String(e?.message ?? e)),
          onclose: () => {},
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
          speechConfig: {
            languageCode: "he-IL",
            voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } },
          },
          tools: [{ functionDeclarations: TOOL_DECLARATIONS as any }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      });

      // 3) audio out context (24 kHz)
      this.outputCtx = new AudioContext({ sampleRate: OUTPUT_RATE });
      this.nextPlayTime = 0;

      // 4) mic capture → 16 kHz PCM → stream up
      await this.startMic();
      this.set("listening");

      // 5) answer the call — nudge Dalit to open with her greeting right away,
      //    like a receptionist picking up the phone. (This text turn isn't
      //    transcribed, so it doesn't show in the transcript.)
      try {
        this.session.sendClientContent({
          turns: [{ role: "user", parts: [{ text: "(שיחה נכנסת — עני עכשיו ופתחי בברכת הפתיחה שלך.)" }] }],
          turnComplete: true,
        });
      } catch {
        /* session closing */
      }
    } catch (e: any) {
      this.fail(String(e?.message ?? e));
    }
  }

  private async startMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.inputCtx = new AudioContext({ sampleRate: INPUT_RATE });
    const src = this.inputCtx.createMediaStreamSource(this.stream);
    this.processor = this.inputCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (ev) => {
      if (!this.active || !this.session) return;
      const input = ev.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      try {
        this.session.sendRealtimeInput({
          audio: { data: int16ToBase64(pcm), mimeType: `audio/pcm;rate=${INPUT_RATE}` },
        });
      } catch {
        /* session closing */
      }
    };
    src.connect(this.processor);
    this.processor.connect(this.inputCtx.destination); // keeps the node alive
  }

  private onMessage(m: any) {
    const sc = m.serverContent;
    // Barge-in: the model detected the caller talking over it → drop queued audio.
    if (sc?.interrupted) this.stopPlayback();

    const inT = sc?.inputTranscription?.text;
    if (inT) {
      this.cb.onTranscript?.("caller", inT);
      this.clearSilence(); // the caller is talking — reset the check-in timer
      this.silenceCount = 0;
    }
    const outT = sc?.outputTranscription?.text;
    if (outT) this.cb.onTranscript?.("dalit", outT);

    const parts = sc?.modelTurn?.parts ?? [];
    for (const p of parts) {
      const data = p.inlineData?.data;
      if (data) {
        this.set("speaking");
        this.clearSilence();
        this.playChunk(data);
      }
    }
    if (sc?.turnComplete) {
      this.set("listening");
      this.armSilence(); // she's done — wait for the caller, or check back in
    }

    const calls = m.toolCall?.functionCalls;
    if (calls?.length) this.handleTools(calls);
  }

  private clearSilence() {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private armSilence() {
    this.clearSilence();
    if (this.silenceCount >= 2) return; // already checked in + said goodbye
    this.silenceTimer = setTimeout(() => this.onSilence(), SILENCE_PROMPT_MS);
  }

  private onSilence() {
    this.silenceTimer = null;
    if (!this.active || !this.session) return;
    this.silenceCount += 1;
    const nudge =
      this.silenceCount === 1
        ? "(המתקשר שותק כבר כמה שניות. שאלי בעדינות אם יש עוד משהו שאפשר לעזור בו.)"
        : "(המתקשר עדיין שותק. הודי לו על הפנייה, אמרי שאנחנו כאן בכל עת, ואחלי יום טוב.)";
    try {
      this.session.sendClientContent({
        turns: [{ role: "user", parts: [{ text: nudge }] }],
        turnComplete: true,
      });
    } catch {
      /* session closing */
    }
  }

  private async handleTools(calls: any[]) {
    this.set("thinking");
    const responses = [];
    for (const c of calls) {
      const result = await runTool(c.name, c.args ?? {});
      responses.push({ id: c.id, name: c.name, response: result });
    }
    try {
      this.session?.sendToolResponse({ functionResponses: responses });
    } catch {
      /* ignore */
    }
  }

  private playChunk(b64: string) {
    if (!this.outputCtx) return;
    const int16 = base64ToInt16(b64);
    const buf = this.outputCtx.createBuffer(1, int16.length, OUTPUT_RATE);
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
    this.clearSilence();
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
      this.session?.close();
    } catch {}
    this.processor = null;
    this.stream = null;
    this.inputCtx = null;
    this.outputCtx = null;
    this.session = null;
    this.set("idle");
  }
}
