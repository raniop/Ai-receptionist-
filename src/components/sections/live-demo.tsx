import { useEffect, useRef, useState } from "react";
import { Mic, PhoneCall, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DalitLiveSession,
  type LiveState,
  type TranscriptRole,
} from "@/integrations/gemini/live-client";

const STATE_META: Record<LiveState, { label: string; dot: string }> = {
  idle: { label: "מוכן", dot: "bg-muted-foreground" },
  connecting: { label: "מתחבר…", dot: "bg-amber-400" },
  listening: { label: "מקשיבה", dot: "bg-emerald-400" },
  speaking: { label: "מדברת", dot: "bg-primary" },
  thinking: { label: "בודקת…", dot: "bg-sky-400" },
  error: { label: "שגיאה", dot: "bg-red-500" },
};

type Line = { id: number; role: TranscriptRole; text: string };
let lineId = 1;

export function LiveDemo() {
  const [state, setState] = useState<LiveState>("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
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
    const s = new DalitLiveSession({
      onState: setState,
      onTranscript: appendTranscript,
      onError: (m) => setError(m),
    });
    sessionRef.current = s;
    void s.start();
  }

  function stop() {
    sessionRef.current?.stop();
    sessionRef.current = null;
  }

  const active = state !== "idle" && state !== "error";
  const meta = STATE_META[state];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
          דל
          {state === "listening" ? (
            <span className="voice-ring pointer-events-none absolute inset-0 rounded-full border-2 border-primary" aria-hidden="true" />
          ) : null}
        </span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-foreground">דלית · Gemini Live</p>
          <p className="text-xs text-muted-foreground">נציגה קולית בזמן אמת</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-foreground">
          <span className={`h-2 w-2 rounded-full ${meta.dot}`} aria-hidden="true" />
          {meta.label}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {!active ? (
          <Button type="button" className="h-12 rounded-full px-6" onClick={start}>
            <PhoneCall className="h-4 w-4" />
            {state === "error" ? "נסה שוב" : "התחל שיחה"}
          </Button>
        ) : (
          <Button type="button" variant="outline" className="h-12 rounded-full px-6" onClick={stop}>
            <PhoneOff className="h-4 w-4" />
            סיים שיחה
          </Button>
        )}
        {active ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Mic className="h-3.5 w-3.5" /> דברו באופן טבעי — אפשר גם להפריע לה באמצע.
          </span>
        ) : null}
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
