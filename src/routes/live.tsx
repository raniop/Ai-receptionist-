import { createFileRoute } from "@tanstack/react-router";
import { FadeIn } from "@/components/motion/fade-in";
import { LiveDemo } from "@/components/sections/live-demo";

export const Route = createFileRoute("/live")({ component: LivePage });

function LivePage() {
  return (
    <main
      className="min-h-screen w-full"
      style={{ background: "linear-gradient(180deg, #ecfdf5 0%, #f6fbfa 32%, #f8fafc 100%)" }}
    >
      <div className="mx-auto max-w-2xl px-5 py-10 sm:px-6">
        <FadeIn>
          <LiveDemo />
        </FadeIn>
      </div>
    </main>
  );
}
