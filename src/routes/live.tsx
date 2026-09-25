import { createFileRoute, redirect } from "@tanstack/react-router";

// The voice page now lives at the site root — keep the old /live link working.
export const Route = createFileRoute("/live")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
