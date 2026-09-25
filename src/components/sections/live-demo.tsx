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

type Line = { id: number; role: TranscriptRole; text: string };
let lineId = 1;

export function LiveDemo() {
  const [state, setState] = useState<LiveState>("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState("Callirrhoe");
  const sessionRef = useRef<DalitLiveSession | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
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

          {/* Voice picker on the glass */}
          <div className="mt-4 flex items-center justify-center gap-2 text-xs" style={{ color: "#0b5e52" }}>
            <label htmlFor="live-voice" className="font-semibold">
              קול:
            </label>
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
          </div>
          {active ? (
            <p className="mt-1.5 text-[11px]" style={{ color: "#0b5e52", opacity: 0.75 }}>
              (הקול מתעדכן בשיחה הבאה)
            </p>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400" role="status">
          שגיאה: {error}. ודאו שה-proxy רץ (pnpm proxy) ושמפתח Gemini מוגדר ב-.env, ופתחו ב-Chrome.
        </p>
      ) : null}

      <section className="flex min-h-[340px] flex-col rounded-xl border border-border bg-card">
        <header className="border-b border-border px-5 py-3">
          <p className="text-sm font-semibold text-foreground">תמלול חי</p>
        </header>
        <div className="thread-scroll flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              לחצו "התחל שיחה", אשרו מיקרופון, ואמרו שלום. דלית תענה בקול, בזמן אמת.
            </p>
          ) : (
            lines.map((l) => (
              <div key={l.id} className={l.role === "caller" ? "text-start" : "text-start"}>
                <div
                  className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    l.role === "caller"
                      ? "bg-secondary text-foreground"
                      : "bg-primary/10 text-foreground"
                  }`}
                >
                  <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
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
  );
}
