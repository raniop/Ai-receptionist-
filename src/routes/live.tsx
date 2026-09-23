import { createFileRoute } from "@tanstack/react-router";
import { FadeIn } from "@/components/motion/fade-in";
import { LiveDemo } from "@/components/sections/live-demo";

export const Route = createFileRoute("/live")({ component: LivePage });

function LivePage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12 sm:px-6">
      <FadeIn>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
          הדגמה · Gemini 3.8 Live
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-foreground sm:text-4xl">
          דלית בזמן אמת
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          גרסת ניסוי של דלית על מודל הקול <strong>Gemini 3.8 Live</strong> — היא מקשיבה, מבינה
          ומדברת בקול טבעי, בזמן אמת, ויכולה לבדוק פוליסה ולרשום פניות. מומלץ להשתמש ב-Chrome
          ובאוזניות.
        </p>
      </FadeIn>
      <FadeIn delay={0.1} className="mt-8">
        <LiveDemo />
      </FadeIn>
    </main>
  );
}
