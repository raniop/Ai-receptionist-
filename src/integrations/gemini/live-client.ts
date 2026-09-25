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
// Kept long so it never fires while the caller is just thinking or mid-sentence.
const SILENCE_PROMPT_MS = 15000;

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
  private fast: boolean; // "fast mode" — skip transcription to test response latency
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceCount = 0;
  private endingCall = false; // true once the goodbye is sent → hang up after it plays

  // Voice engine: "gemini" = native speech-to-speech; "eleven"/"azure" = Gemini
  // thinks in TEXT and the provider speaks it (far more natural Hebrew).
  private engine: "gemini" | "eleven" | "azure";
  private ttsVoice: string; // ElevenLabs voiceId, or an Azure he-IL voice name
  private ttsQueue: string[] = [];
  private ttsDraining = false;
  private ttsSources = new Set<AudioBufferSourceNode>();
  private ttsTextBuf = "";
  private hangupAfterTts = false;
  private turnDone = false; // this Dalit turn's text is complete (external engines)

  constructor(
    cb: LiveCallbacks,
    voice = "Callirrhoe",
    fast = false,
    engine: "gemini" | "eleven" | "azure" = "gemini",
    ttsVoice = "XrExE9yKIg1WjnnlVkGX",
  ) {
    this.cb = cb;
    this.voice = voice;
    this.fast = fast;
    this.engine = engine;
    this.ttsVoice = ttsVoice;
  }

  private set(s: LiveState) {
    this.cb.onState?.(s);
  }

  async start() {
    if (this.active) return;
    this.active = true;
    this.set("connecting");

    // iOS Safari only unlocks an AudioContext if it's created AND kicked inside the
    // user-gesture that started the call — before any await. So set up output audio
    // and play a 1-sample silent buffer here, synchronously, then connect below.
    try {
      this.outputCtx =
        this.engine === "gemini" ? new AudioContext({ sampleRate: OUTPUT_RATE }) : new AudioContext();
      this.nextPlayTime = 0;
      void this.outputCtx.resume();
      const silent = this.outputCtx.createBuffer(1, 1, this.outputCtx.sampleRate);
      const s = this.outputCtx.createBufferSource();
      s.buffer = silent;
      s.connect(this.outputCtx.destination);
      s.start();
    } catch {
      /* fall back to lazy creation below */
    }

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
          // gemini-3.8-live only supports AUDIO responses (TEXT-only is rejected).
          // So for ElevenLabs/Azure we still let Gemini speak, but we DON'T play its
          // audio — we take the transcription of her words and speak that instead.
          responseModalities: [Modality.AUDIO],
          systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
          // speechConfig only matters when we actually play Gemini's own voice.
          ...(this.engine === "gemini"
            ? {
                speechConfig: {
                  languageCode: "he-IL",
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } },
                },
              }
            : {}),
          tools: [{ functionDeclarations: TOOL_DECLARATIONS as any }],
          // External TTS engines REQUIRE Dalit's words as text → always transcribe
          // her output. "fast mode" only drops the caller-side transcript.
          ...(this.engine !== "gemini"
            ? { outputAudioTranscription: {}, ...(this.fast ? {} : { inputAudioTranscription: {} }) }
            : this.fast
              ? {}
              : { inputAudioTranscription: {}, outputAudioTranscription: {} }),
          // Turn-taking: wait for a real pause before Dalit responds, so she doesn't
          // cut the caller off during natural mid-sentence pauses.
          realtimeInputConfig: {
            automaticActivityDetection: {
              // Snappier turn-taking: HIGH end-sensitivity + a 700ms pause means
              // Dalit starts replying soon after the caller stops, instead of the
              // long lag END_SENSITIVITY_LOW + 1.5s produced. 700ms is still longer
              // than a normal mid-sentence breath, so she won't cut in early.
              startOfSpeechSensitivity: "START_SENSITIVITY_LOW" as any,
              endOfSpeechSensitivity: "END_SENSITIVITY_HIGH" as any,
              prefixPaddingMs: 300,
              silenceDurationMs: 700,
            },
          },
        },
      });

      // 3) audio out context — normally already created in the gesture above;
      // create here only if that failed. Gemini needs a 24kHz context for its raw
      // PCM; ElevenLabs/Azure decode MP3 so the device's native rate is fine.
      if (!this.outputCtx) {
        this.outputCtx =
          this.engine === "gemini" ? new AudioContext({ sampleRate: OUTPUT_RATE }) : new AudioContext();
        this.nextPlayTime = 0;
      }
      await this.outputCtx.resume().catch(() => {});

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
    // 2048 samples ≈ 128ms per chunk (vs 256ms at 4096) → mic audio reaches the
    // model sooner, shaving a little off the response latency.
    this.processor = this.inputCtx.createScriptProcessor(2048, 1, 1);
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
    // Barge-in: the caller talks over Dalit → drop whatever's queued/playing.
    if (sc?.interrupted) {
      this.stopPlayback();
      if (this.engine !== "gemini") this.stopTts();
    }

    const inT = sc?.inputTranscription?.text;
    if (inT) {
      this.cb.onTranscript?.("caller", inT);
      this.clearSilence(); // the caller is talking — reset the check-in timer
      this.silenceCount = 0;
      this.endingCall = false; // they're back — don't hang up
      // ElevenLabs barge-in: cut Dalit's speech the moment the caller starts.
      if (this.engine !== "gemini") {
        this.stopTts();
        this.hangupAfterTts = false;
      }
    }
    // Dalit's words. For external engines this transcription IS what we speak —
    // stream it sentence-by-sentence so she starts talking almost immediately
    // instead of waiting for the whole (slow) Gemini turn to finish.
    const outT = sc?.outputTranscription?.text;
    if (outT) {
      this.cb.onTranscript?.("dalit", outT);
      if (this.engine !== "gemini") {
        this.turnDone = false; // new words arriving → turn is in progress
        this.ttsTextBuf += outT;
        this.flushSentences(false);
      }
    }

    const parts = sc?.modelTurn?.parts ?? [];
    for (const p of parts) {
      // Only the Gemini engine plays Gemini's audio; for ElevenLabs/Azure we
      // discard it and speak the transcription (outT above) via the provider.
      if (this.engine === "gemini") {
        const data = p.inlineData?.data;
        if (data) {
          this.set("speaking");
          this.clearSilence();
          this.playChunk(data);
        }
      }
    }

    if (sc?.turnComplete) {
      if (this.engine !== "gemini") {
        this.turnDone = true;
        // Speak the tail (any words after the last sentence break).
        if (this.ttsTextBuf.trim()) this.enqueueTts(this.ttsTextBuf);
        this.ttsTextBuf = "";
        if (this.endingCall) this.hangupAfterTts = true;
        // Nothing to speak this turn (e.g. only a tool call) → transition now.
        if (!this.ttsDraining && this.ttsQueue.length === 0) {
          if (this.hangupAfterTts) {
            this.cb.onTranscript?.("dalit", "— השיחה הסתיימה —");
            this.stop();
            return;
          }
          this.set("listening");
          this.armSilence();
        }
      } else if (this.endingCall) {
        // That turn was her goodbye — let the audio finish, then hang up.
        const remainingMs = this.outputCtx
          ? Math.max(0, this.nextPlayTime - this.outputCtx.currentTime) * 1000
          : 0;
        setTimeout(() => {
          if (this.active) {
            this.cb.onTranscript?.("dalit", "— השיחה הסתיימה —");
            this.stop();
          }
        }, remainingMs + 1200);
        return;
      } else {
        this.set("listening");
        this.armSilence(); // she's done — wait for the caller, or check back in
      }
    }

    const calls = m.toolCall?.functionCalls;
    if (calls?.length) this.handleTools(calls);
  }

  // ── external TTS pipeline (ElevenLabs / Azure) ───────────────────────────────
  /** Pull complete sentences off the buffer and queue them so speech starts early. */
  private flushSentences(final: boolean) {
    const re = /[^.!?…\n]*[.!?…\n]+/g;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    const buf = this.ttsTextBuf;
    while ((match = re.exec(buf)) !== null) {
      this.enqueueTts(match[0]);
      lastIndex = re.lastIndex;
    }
    if (lastIndex) this.ttsTextBuf = buf.slice(lastIndex);
    if (final && this.ttsTextBuf.trim()) {
      this.enqueueTts(this.ttsTextBuf);
      this.ttsTextBuf = "";
    }
  }

  private enqueueTts(sentence: string) {
    const s = sentence.trim();
    if (!s) return;
    this.ttsQueue.push(s);
    this.set("speaking");
    this.clearSilence();
    if (!this.ttsDraining) void this.drainTts();
  }

  private async drainTts() {
    this.ttsDraining = true;
    // Prefetch the next sentence's audio while the current one plays → no gaps.
    let next = this.ttsQueue.length ? this.fetchTts(this.ttsQueue.shift() as string) : null;
    while (next) {
      let audio: AudioBuffer | null = null;
      try {
        audio = await next;
      } catch {
        audio = null;
      }
      next = this.ttsQueue.length ? this.fetchTts(this.ttsQueue.shift() as string) : null;
      if (!this.active) return;
      if (audio) await this.playBuffer(audio);
      if (!this.active) return;
    }
    this.ttsDraining = false;
    // More may have been queued between the last shift and now.
    if (this.ttsQueue.length) return void this.drainTts();
    // Only wrap up once the turn's text is actually complete.
    if (!this.turnDone) return;
    if (this.hangupAfterTts) {
      this.cb.onTranscript?.("dalit", "— השיחה הסתיימה —");
      this.stop();
      return;
    }
    this.set("listening");
    this.armSilence();
  }

  private async fetchTts(text: string): Promise<AudioBuffer | null> {
    if (!this.outputCtx) return null;
    const [endpoint, body] =
      this.engine === "azure"
        ? ["/api/tts/azure", { text, voiceName: this.ttsVoice }]
        : ["/api/tts/elevenlabs", { text, voiceId: this.ttsVoice }];
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const arr = await r.arrayBuffer();
    return await this.outputCtx.decodeAudioData(arr);
  }

  private playBuffer(buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      if (!this.outputCtx) return resolve();
      void this.outputCtx.resume().catch(() => {}); // keep iOS from silently pausing
      const node = this.outputCtx.createBufferSource();
      node.buffer = buffer;
      node.connect(this.outputCtx.destination);
      node.onended = () => {
        this.ttsSources.delete(node);
        resolve();
      };
      this.ttsSources.add(node);
      node.start();
    });
  }

  private stopTts() {
    this.ttsQueue = [];
    this.ttsTextBuf = "";
    this.turnDone = false;
    for (const s of this.ttsSources) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    this.ttsSources.clear();
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
    // First silence → one gentle check-in. Still silent → a short goodbye, then
    // the call auto-ends (endingCall makes turnComplete hang up after it plays).
    if (this.silenceCount >= 2) this.endingCall = true;
    const nudge =
      this.silenceCount === 1
        ? "(המתקשר שקט זמן מה. בדקי בעדינות אם הוא עדיין על הקו ואם תוכלי לעזור בעוד משהו — בלי להניח שסיים או שאין לו שאלות.)"
        : "(המתקשר עדיין שותק. היפרדי ממנו קצר ובחום — הודי לו על הפנייה, אמרי שאנחנו כאן בכל עת ושיהיה יום טוב. זו סגירת השיחה.)";
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
      // Caller said goodbye / done → hang up after her farewell turn plays.
      if (c.name === "end_call") this.endingCall = true;
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
    this.stopTts();
    this.hangupAfterTts = false;
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
