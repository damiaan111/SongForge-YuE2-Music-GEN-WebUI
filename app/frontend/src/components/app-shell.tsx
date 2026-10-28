"use client";

/**
 * Navigation shell: sidebar on desktop, bottom bar on narrow screens, plus the
 * persistent queue panel and the notification stack.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import {
  AlertTriangle,
  BookOpen,
  CircleDot,
  Library,
  Music4,
  NotebookPen,
  Settings as SettingsIcon,
  Sparkles,
  X,
} from "lucide-react";

import { QueuePanel } from "@/components/queue-panel";
import { Banner, Button } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import type { Settings } from "@/lib/types";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Library", icon: Library },
  { href: "/create", label: "Create", icon: Sparkles },
  { href: "/lyrics", label: "Lyrics", icon: NotebookPen },
  { href: "/learn", label: "Learn", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/" || pathname.startsWith("/song");
  return pathname.startsWith(href);
}

/**
 * Apply the stored theme to <html>. "system" leaves no attribute set and
 * follows the OS, re-evaluated live when the OS setting changes.
 */
function useTheme(theme: Settings["theme"] | undefined) {
  React.useEffect(() => {
    const root = document.documentElement;
    if (!theme || theme === "system") {
      const media = window.matchMedia("(prefers-color-scheme: light)");
      const apply = () => {
        root.dataset.theme = media.matches ? "light" : "dark";
      };
      apply();
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
    root.dataset.theme = theme;
  }, [theme]);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { health, error, connected, activeJob, queued, settings } = useStore();
  const pending = queued.length + (activeJob ? 1 : 0);
  useTheme(settings?.theme);

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-[var(--sf-accent)] focus:px-4 focus:py-2 focus:text-[var(--sf-accent-ink)]"
      >
        Skip to content
      </a>

      {/* --- Sidebar (desktop) --- */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-[var(--sf-border)] bg-[var(--sf-bg-raised)] lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-6">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--sf-accent)]">
            <Music4 className="h-5 w-5 text-[var(--sf-accent-ink)]" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-semibold tracking-tight">SongForge</p>
            <p className="text-[11px] text-[var(--sf-text-faint)]">
              {health?.version ?? "connecting…"}
            </p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3" aria-label="Main">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(pathname, href) ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                isActive(pathname, href)
                  ? "bg-[var(--sf-bg-overlay)] text-[var(--sf-text)]"
                  : "text-[var(--sf-text-muted)] hover:bg-[var(--sf-bg-overlay)] hover:text-[var(--sf-text)]",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
              {href === "/" && pending > 0 && (
                <span className="ml-auto rounded-full bg-[var(--sf-accent)] px-1.5 text-[10px] font-semibold text-[var(--sf-accent-ink)]">
                  {pending}
                </span>
              )}
            </Link>
          ))}
        </nav>

        <div className="border-t border-[var(--sf-border)] p-3">
          <QueuePanel />
          <ConnectionBadge connected={connected} healthy={Boolean(health)} />
        </div>
      </aside>

      {/* --- Main --- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileHeader pathname={pathname} pending={pending} />

        <main id="main" className="min-w-0 flex-1 px-4 pb-24 pt-5 lg:px-8 lg:pb-10">
          {error && (
            <div className="mb-5">
              <Banner tone="danger" title="Cannot reach the SongForge backend">
                <p>{error}</p>
                <p className="mt-1">
                  Start it with{" "}
                  <code className="rounded bg-black/30 px-1">scripts\Start-SongForge.ps1</code>,
                  then this page will reconnect on its own.
                </p>
              </Banner>
            </div>
          )}
          {children}
        </main>
      </div>

      <NotificationStack />
      <MobileNav pathname={pathname} pending={pending} />
    </div>
  );
}

function MobileHeader({ pathname, pending }: { pathname: string; pending: number }) {
  const current = NAV.find((item) => isActive(pathname, item.href));
  return (
    <header className="flex items-center justify-between border-b border-[var(--sf-border)] bg-[var(--sf-bg-raised)] px-4 py-3 lg:hidden">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--sf-accent)]">
          <Music4 className="h-4 w-4 text-[var(--sf-accent-ink)]" aria-hidden="true" />
        </span>
        <span className="text-sm font-semibold">{current?.label ?? "SongForge"}</span>
      </div>
      {pending > 0 && (
        <span className="rounded-full bg-[var(--sf-accent)]/20 px-2 py-0.5 text-xs text-[var(--sf-accent)]">
          {pending} in queue
        </span>
      )}
    </header>
  );
}

function MobileNav({ pathname, pending }: { pathname: string; pending: number }) {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--sf-border)] bg-[var(--sf-bg-raised)] lg:hidden"
    >
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={isActive(pathname, href) ? "page" : undefined}
          className={cn(
            "relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px]",
            isActive(pathname, href)
              ? "text-[var(--sf-accent)]"
              : "text-[var(--sf-text-muted)]",
          )}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
          {label}
          {href === "/" && pending > 0 && (
            <span className="absolute right-1/4 top-1.5 h-2 w-2 rounded-full bg-[var(--sf-accent)]" />
          )}
        </Link>
      ))}
    </nav>
  );
}

function ConnectionBadge({
  connected,
  healthy,
}: {
  connected: boolean;
  healthy: boolean;
}) {
  const tone = !healthy ? "danger" : connected ? "success" : "warning";
  const label = !healthy
    ? "Backend offline"
    : connected
      ? "Live updates on"
      : "Reconnecting…";
  const colour = {
    success: "var(--sf-success)",
    warning: "var(--sf-warning)",
    danger: "var(--sf-danger)",
  }[tone];

  return (
    <p className="mt-3 flex items-center gap-1.5 px-1 text-[11px] text-[var(--sf-text-faint)]">
      <CircleDot className="h-3 w-3" style={{ color: colour }} aria-hidden="true" />
      {label}
    </p>
  );
}

function NotificationStack() {
  const { notifications, dismiss } = useStore();
  if (notifications.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-20 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 lg:bottom-4"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {notifications.map((notification) => {
        const colour = {
          info: "var(--sf-info)",
          success: "var(--sf-success)",
          warning: "var(--sf-warning)",
          danger: "var(--sf-danger)",
        }[notification.tone];

        const body = (
          <div className="flex items-start gap-2 pr-6">
            {notification.tone === "danger" && (
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0"
                style={{ color: colour }}
                aria-hidden="true"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{notification.title}</p>
              {notification.body && (
                <p className="mt-0.5 line-clamp-3 text-xs text-[var(--sf-text-muted)]">
                  {notification.body}
                </p>
              )}
            </div>
          </div>
        );

        const className =
          "pointer-events-auto rounded-lg border bg-[var(--sf-bg-raised)] p-3 shadow-lg";

        // The dismiss control is a sibling of the link, never a child: a
        // <button> inside an <a> is invalid, and assistive technology cannot
        // reach a control nested inside a link.
        return (
          <div key={notification.id} className="pointer-events-auto relative">
            {notification.href ? (
              <Link
                href={notification.href}
                className={cn(className, "block hover:border-[var(--sf-accent)]")}
                style={{ borderColor: colour }}
              >
                {body}
              </Link>
            ) : (
              <div className={className} style={{ borderColor: colour }}>
                {body}
              </div>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1.5 top-1.5 h-6 w-6"
              onClick={() => dismiss(notification.id)}
              aria-label={`Dismiss: ${notification.title}`}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
