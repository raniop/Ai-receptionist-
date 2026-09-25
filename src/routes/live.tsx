import { createFileRoute } from "@tanstack/react-router";
import { FadeIn } from "@/components/motion/fade-in";
import { LiveDemo } from "@/components/sections/live-demo";

export const Route = createFileRoute("/live")({ component: LivePage });

function LivePage() {
  return (
    <main className="live-page min-h-screen w-full" style={{ background: "var(--lp-bg)" }}>
      <div className="mx-auto max-w-2xl px-5 py-10 sm:px-6">
        <FadeIn>
          <div className="text-center">
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold"
              style={{ background: "#d1fae5", color: "#0f766e", letterSpacing: "0.08em" }}
            >
              ✨ נציגה קולית חכמה
            </span>
            <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl" style={{ color: "var(--lp-ink)" }}>
              דברו עם דלית
            </h1>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed" style={{ color: "var(--lp-sub)" }}>
              שאלו על ביטוח נסיעות לחו״ל, בדקו את הפוליסה שלכם או השאירו הודעה — בשיחה טבעית, בעברית.
            </p>
          </div>
        </FadeIn>
        <FadeIn delay={0.08} className="mt-6">
          <LiveDemo />
        </FadeIn>
      </div>
    </main>
  );
}
