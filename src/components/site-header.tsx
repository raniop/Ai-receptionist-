import { Link, useLocation } from "@tanstack/react-router";
import { site } from "@/content/site";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/integrations/neon/auth";

export function SiteHeader() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // The /live page is a light page, so the shared header goes light there too.
  const { pathname } = useLocation();
  const light = pathname === "/live";

  const link = light
    ? "text-slate-500 hover:text-slate-900"
    : "text-muted-foreground hover:text-foreground";
  const linkActive = light ? "text-slate-900" : "text-foreground";
  const pillBtn = light
    ? "border-slate-300 text-slate-700 hover:border-teal-600 hover:text-teal-700"
    : "border-border text-foreground hover:border-primary hover:text-primary";

  return (
    <header
      className={`sticky top-0 z-20 border-b backdrop-blur ${light ? "" : "border-border bg-background/85"}`}
      style={light ? { background: "rgba(255,255,255,0.85)", borderColor: "#e2e8f0" } : undefined}
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-6">
        <Link
          to="/"
          className={`font-display text-base font-semibold tracking-tight ${light ? "text-slate-900" : "text-foreground"}`}
        >
          {site.name}
        </Link>
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {site.nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={`inline-flex min-h-11 items-center transition-colors ${link}`}
              activeProps={{ className: linkActive }}
            >
              {item.label}
            </Link>
          ))}
          {isAdmin ? (
            <Link
              to="/admin"
              className={`inline-flex min-h-11 items-center transition-colors ${link}`}
              activeProps={{ className: linkActive }}
            >
              ניהול
            </Link>
          ) : null}
          {user ? (
            <button
              type="button"
              onClick={() => void signOut()}
              className={`inline-flex min-h-11 items-center rounded-full border px-4 text-xs transition-colors ${pillBtn}`}
            >
              התנתקות
            </button>
          ) : (
            <Link
              to="/login"
              className={`inline-flex min-h-11 items-center rounded-full border px-4 text-xs transition-colors ${pillBtn}`}
            >
              כניסת צוות
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
