import { useEffect, useRef, useState } from "react";
import { Mic, PhoneCall, PhoneOff } from "lucide-react";
import {
  DalitLiveSession,
  type LiveState,
  type TranscriptRole,
} from "@/integrations/gemini/live-client";

const STATE_META: Record<LiveState, { label: string; dot: string }> = {
  idle: { label: "מוכנה", dot: "#64748b" },
  connecting: { label: "מתחברת…", dot: "#f59e0b" },
  listening: { label: "מקשיבה", dot: "#10b981" },
  speaking: { label: "מדברת", dot: "#0f766e" },
  thinking: { label: "בודקת…", dot: "#0ea5e9" },
  error: { label: "שגיאה", dot: "#ef4444" },
};

// Gemini Live prebuilt voices worth trying for a Hebrew receptionist.
const VOICES: { name: string; label: string }[] = [
  { name: "Callirrhoe", label: "Callirrhoe · חם ורגוע" },
  { name: "Aoede", label: "Aoede · רך ונעים" },
  { name: "Kore", label: "Kore · ברור ואסרטיבי" },
  { name: "Leda", label: "Leda · צעיר וקליל" },
  { name: "Zephyr", label: "Zephyr · בהיר וחייכני" },
  { name: "Charon", label: "Charon · ענייני" },
  { name: "Puck", label: "Puck · אנרגטי" },
  { name: "Orus", label: "Orus · יציב" },
];

// ElevenLabs voices (spoken via eleven_v3 — far more natural Hebrew).
const ELEVEN_VOICES: { id: string; label: string }[] = [
  { id: "XrExE9yKIg1WjnnlVkGX", label: "Matilda · חם ונעים" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", label: "Alice · ברור" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah · רך" },
  { id: "pFZP5JQG7iQjIQuC4Bku", label: "Lily · צעיר" },
];

// Azure Neural — native Hebrew voices (he-IL).
const AZURE_VOICES: { id: string; label: string }[] = [
  { id: "he-IL-HilaNeural", label: "Hila · אישה, ישראלי" },
  { id: "he-IL-AvriNeural", label: "Avri · גבר, ישראלי" },
];

type Engine = "eleven" | "gemini" | "azure";
type Brain = "gemini" | "flash" | "grok";

// The "brain" — who generates Dalit's replies.
const BRAINS: { id: Brain; label: string }[] = [
  { id: "gemini", label: "Gemini Live · מובנה" },
  { id: "flash", label: "Gemini Flash-Lite · מהיר" },
  { id: "grok", label: "Grok · מהיר" },
];

type Line = { id: number; role: TranscriptRole; text: string };
let lineId = 1;

// Remember the caller's engine/voice choice across refreshes.
function lsGet(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore (private mode / blocked) */
  }
}

export function LiveDemo() {
  const [state, setState] = useState<LiveState>("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState(() => lsGet("dalit:geminiVoice", "Callirrhoe"));
  const [fast, setFast] = useState(false);
  const [engine, setEngine] = useState<Engine>(() => lsGet("dalit:engine", "gemini") as Engine);
  const [brain, setBrain] = useState<Brain>(() => lsGet("dalit:brain", "gemini") as Brain);
  const [elevenVoice, setElevenVoice] = useState(() => lsGet("dalit:elevenVoice", ELEVEN_VOICES[0].id));
  const [azureVoice, setAzureVoice] = useState(() => lsGet("dalit:azureVoice", AZURE_VOICES[0].id));
  const sessionRef = useRef<DalitLiveSession | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // A text brain needs an external voice — Gemini's own voice only works with the
  // Gemini brain. Fall back to Azure when the brain is Flash/Grok.
  const effEngine: Engine = brain !== "gemini" && engine === "gemini" ? "azure" : engine;

  // Persist the engine/voice choices so a refresh keeps the last selection.
  useEffect(() => lsSet("dalit:engine", engine), [engine]);
  useEffect(() => lsSet("dalit:brain", brain), [brain]);
  useEffect(() => lsSet("dalit:elevenVoice", elevenVoice), [elevenVoice]);
  useEffect(() => lsSet("dalit:azureVoice", azureVoice), [azureVoice]);
  useEffect(() => lsSet("dalit:geminiVoice", voice), [voice]);

  useEffect(() => {
    // Only auto-scroll once there are messages — otherwise it would scroll the
    // page down to the transcript on load and hide the top of the call stage.
    if (lines.length) endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [lines]);

  useEffect(() => () => sessionRef.current?.stop(), []);

  function appendTranscript(role: TranscriptRole, text: string) {
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === role) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { id: lineId++, role, text }];
    });
  }

  function start() {
    setError(null);
    setLines([]);
    const s = new DalitLiveSession(
      {
        onState: setState,
        onTranscript: appendTranscript,
        onError: (m) => setError(m),
      },
      voice,
      fast,
      effEngine,
      effEngine === "azure" ? azureVoice : elevenVoice,
      brain,
    );
    sessionRef.current = s;
    void s.start();
  }

  function stop() {
    sessionRef.current?.stop();
    sessionRef.current = null;
  }

  const active = state !== "idle" && state !== "error";
  const meta = STATE_META[state];
  const ringsOn = state === "listening" || state === "speaking" || state === "thinking";

  return (
    <>
    <div className="space-y-5">
      {/* Call stage — teal liquid-glass hero with the ripple orb */}
      <div className="dalit-stage">
        <span className="dalit-blob" style={{ width: 190, height: 190, background: "#5eead4", top: -30, insetInlineStart: -30 }} aria-hidden="true" />
        <span className="dalit-blob" style={{ width: 170, height: 170, background: "#7dd3fc", top: 4, insetInlineEnd: -40, opacity: 0.7 }} aria-hidden="true" />
        <span className="dalit-blob" style={{ width: 150, height: 150, background: "#34d399", bottom: -20, insetInlineStart: "34%", opacity: 0.6 }} aria-hidden="true" />

        <div className="dalit-glass mx-auto max-w-sm">
          <div className={`dalit-orb ${active ? "is-breathing" : ""}`}>
            {ringsOn ? (
              <>
                <span className="dalit-ring" aria-hidden="true" />
                <span className="dalit-ring" aria-hidden="true" />
              </>
            ) : null}
          </div>

          <div className="mt-5 flex items-center justify-center">
            <span
              className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-bold"
              style={{ background: "rgba(255,255,255,0.55)", color: "#0b3c34", border: "1px solid rgba(255,255,255,0.6)" }}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: meta.dot }} aria-hidden="true" />
              {meta.label}
            </span>
          </div>

          <div className="mt-4">
            {!active ? (
              <button
                type="button"
                onClick={start}
                className="inline-flex h-12 w-full max-w-xs items-center justify-center gap-2 rounded-2xl px-6 text-[15px] font-bold text-white transition active:scale-[0.98]"
                style={{ background: "#0f766e", boxShadow: "0 12px 26px rgba(15,118,110,0.4)" }}
              >
                <PhoneCall className="h-4 w-4" />
                {state === "error" ? "נסה שוב" : "התחל שיחה"}
              </button>
            ) : (
              <button
                type="button"
                onClick={stop}
                className="inline-flex h-12 w-full max-w-xs items-center justify-center gap-2 rounded-2xl px-6 text-[15px] font-bold transition active:scale-[0.98]"
                style={{ background: "rgba(255,255,255,0.85)", color: "#0b3c34", border: "1px solid rgba(255,255,255,0.7)" }}
              >
                <PhoneOff className="h-4 w-4" />
                סיים שיחה
              </button>
            )}
          </div>

          {active ? (
            <p className="mt-3 flex items-center justify-center gap-1.5 text-xs font-medium" style={{ color: "#0b5e52" }}>
              <Mic className="h-3.5 w-3.5" /> דברו באופן טבעי — אפשר גם להפריע לה באמצע.
            </p>
          ) : null}

          {/* Brain + voice engine + voice picker on the glass */}
          <div className="mt-4 flex flex-col items-center gap-2 text-xs" style={{ color: "#0b5e52" }}>
            <div className="flex items-center gap-2">
              <label htmlFor="live-brain" className="font-semibold">
                מוח:
              </label>
              <select
                id="live-brain"
                value={brain}
                onChange={(e) => setBrain(e.target.value as Brain)}
                disabled={active}
                className="h-8 rounded-lg px-2 text-xs font-medium disabled:opacity-50"
                style={{ background: "rgba(255,255,255,0.7)", color: "#0b3c34", border: "1px solid rgba(255,255,255,0.7)" }}
              >
                {BRAINS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="live-engine" className="font-semibold">
                מנוע קול:
              </label>
              <select
                id="live-engine"
                value={effEngine}
                onChange={(e) => setEngine(e.target.value as Engine)}
                disabled={active}
                className="h-8 rounded-lg px-2 text-xs font-medium disabled:opacity-50"
                style={{ background: "rgba(255,255,255,0.7)", color: "#0b3c34", border: "1px solid rgba(255,255,255,0.7)" }}
              >
                <option value="azure">Azure · עברית ילידית</option>
                <option value="eleven">ElevenLabs · עברית טבעית</option>
                {brain === "gemini" ? <option value="gemini">Gemini · מובנה</option> : null}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="live-voice" className="font-semibold">
                קול:
              </label>
              {effEngine === "azure" ? (
                <select
                  id="live-voice"
                  value={azureVoice}
                  onChange={(e) => setAzureVoice(e.target.value)}
                  disabled={active}
                  className="h-8 rounded-lg px-2 text-xs font-medium disabled:opacity-50"
                  style={{ background: "rgba(255,255,255,0.7)", color: "#0b3c34", border: "1px solid rgba(255,255,255,0.7)" }}
                >
                  {AZURE_VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              ) : effEngine === "eleven" ? (
                <select
                  id="live-voice"
                  value={elevenVoice}
                  onChange={(e) => setElevenVoice(e.target.value)}
                  disabled={active}
                  className="h-8 rounded-lg px-2 text-xs font-medium disabled:opacity-50"
                  style={{ background: "rgba(255,255,255,0.7)", color: "#0b3c34", border: "1px solid rgba(255,255,255,0.7)" }}
                >
                  {ELEVEN_VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  id="live-voice"
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  disabled={active}
                  className="h-8 rounded-lg px-2 text-xs font-medium disabled:opacity-50"
                  style={{ background: "rgba(255,255,255,0.7)", color: "#0b3c34", border: "1px solid rgba(255,255,255,0.7)" }}
                >
                  {VOICES.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          {active ? (
            <p className="mt-1.5 text-[11px]" style={{ color: "#0b5e52", opacity: 0.75 }}>
              (הקול מתעדכן בשיחה הבאה)
            </p>
          ) : null}

          <label
            className="mt-3 inline-flex items-center justify-center gap-2 text-[11px] font-medium"
            style={{ color: "#0b5e52", opacity: active ? 0.5 : 1 }}
          >
            <input
              type="checkbox"
              checked={fast}
              onChange={(e) => setFast(e.target.checked)}
              disabled={active}
              style={{ accentColor: "#0f766e" }}
            />
            מצב מהיר — בלי תמלול (לבדיקת מהירות תגובה)
          </label>
        </div>
      </div>

      {error ? (
        <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400" role="status">
          שגיאה: {error}. ודאו שה-proxy רץ (pnpm proxy) ושמפתח Gemini מוגדר ב-.env, ופתחו ב-Chrome.
        </p>
      ) : null}

      <section
        className="flex min-h-[340px] flex-col rounded-2xl"
        style={{ background: "#ffffff", border: "1px solid #dbeee9", boxShadow: "0 8px 24px rgba(6,60,52,0.06)" }}
      >
        <header className="px-5 py-3" style={{ borderBottom: "1px solid #ecf3f1" }}>
          <p className="text-sm font-semibold" style={{ color: "#0f2a26" }}>
            תמלול חי
          </p>
        </header>
        <div className="thread-scroll flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {lines.length === 0 ? (
            <p className="text-sm" style={{ color: "#64748b" }}>
              {fast
                ? 'מצב מהיר פעיל — התמלול כבוי לצורך הבדיקה. דלית תדבר כרגיל, פשוט בלי טקסט.'
                : 'לחצו "התחל שיחה", אשרו מיקרופון, ואמרו שלום. דלית תענה בקול, בזמן אמת.'}
            </p>
          ) : (
            lines.map((l) => (
              <div key={l.id} className="text-start">
                <div
                  className="inline-block max-w-[85%] rounded-xl px-3 py-2 text-sm"
                  style={
                    l.role === "caller"
                      ? { background: "#f1f5f9", color: "#1a2233" }
                      : { background: "#ccfbf1", color: "#0b3c34" }
                  }
                >
                  <span
                    className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide"
                    style={{ color: l.role === "caller" ? "#64748b" : "#0f766e" }}
                  >
                    {l.role === "caller" ? "מתקשר" : "דלית"}
                  </span>
                  {l.text}
                </div>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      </section>
    </div>

    {active ? (
      <button
        type="button"
        onClick={stop}
        aria-label="סיים שיחה"
        className="fixed inset-x-0 bottom-5 z-50 mx-auto flex h-12 w-[min(20rem,calc(100%-2rem))] items-center justify-center gap-2 rounded-full text-[15px] font-bold text-white transition active:scale-[0.98]"
        style={{ background: "#e11d48", boxShadow: "0 12px 30px rgba(225,29,72,0.4)" }}
      >
        <PhoneOff className="h-4 w-4" />
        סיים שיחה
      </button>
    ) : null}
    </>
  );
}
