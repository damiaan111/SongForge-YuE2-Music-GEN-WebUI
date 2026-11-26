"use client";

/**
 * The frame every page sits in.
 *
 * Desktop: a sidebar with navigation, the queue and the engine status. Phone:
 * a slim header and a bottom tab bar. In both, the bottom of the main column
 * holds a sticky "footer stack" - the docked player, then the tab bar - and
 * its measured height is published as --sf-footer so a page's own sticky
 * action bar can sit exactly on top of it instead of guessing.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Cpu,
  Info,
  Library,
  ListMusic,
  NotebookPen,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
  X,
} from "lucide-react";

import { PlayerDock } from "@/components/player";
import { QueuePanel } from "@/components/queue-panel";
import { Banner, Dialog, buttonClasses } from "@/components/ui/primitives";
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
 * Apply the stored theme to <html>. "system" follows the OS, re-evaluated
 * live when the OS setting changes.
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

/** The mark: five bars of a waveform, struck from an ember tile. */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "sf-ember flex shrink-0 items-center justify-center rounded-[0.7rem]",
        "shadow-[0_1px_0_oklch(1_0_0/0.3)_inset,0_6px_16px_-6px_var(--sf-accent-deep)]",
        className,
      )}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" className="h-[58%] w-[58%]" fill="currentColor">
        <rect x="2" y="9.5" width="2.6" height="5" rx="1.3" />
        <rect x="6.6" y="6" width="2.6" height="12" rx="1.3" />
        <rect x="11.2" y="2.5" width="2.6" height="19" rx="1.3" />
        <rect x="15.8" y="7" width="2.6" height="10" rx="1.3" />
        <rect x="20.4" y="10" width="2.6" height="4" rx="1.3" />
      </svg>
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { health, error, connected, activeJob, queued, settings, loading } = useStore();
  const pending = queued.length + (activeJob ? 1 : 0);
  const [queueOpen, setQueueOpen] = React.useState(false);
  useTheme(settings?.theme);

  // Publish the height of the sticky footer stack, so page-level sticky bars
  // and the toast stack can sit on top of it at any breakpoint.
  const footerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const element = footerRef.current;
    if (!element) return;
    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty("--sf-footer", `${element.offsetHeight}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--sf-footer");
    };
  }, []);

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[80] focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-ink"
      >
        Skip to content
      </a>

      {/* --- Sidebar (desktop) --- */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-edge bg-sunken/70 lg:flex xl:w-[16.5rem]">
        <Link href="/" className="flex items-center gap-3 px-5 pb-5 pt-6" aria-label="SongForge home">
          <Logo className="h-10 w-10" />
          <span className="min-w-0">
            <span className="sf-display block text-[1.15rem] font-semibold leading-tight tracking-tight text-ink">
              SongForge
            </span>
            <span className="block truncate text-xs text-ink-faint">YuE2 Music GEN WebUI</span>
          </span>
        </Link>

        <div className="px-3 pb-3">
          <Link href="/create" className={buttonClasses("primary", "md", "w-full")}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New song
          </Link>
        </div>

        <nav className="space-y-0.5 px-3" aria-label="Main">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group relative flex h-10 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors",
                  active
                    ? "bg-overlay text-ink shadow-[var(--sf-highlight)]"
                    : "text-ink-muted hover:bg-overlay/60 hover:text-ink",
                )}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-2.5 left-0 w-[3px] rounded-full bg-accent"
                  />
                )}
                <Icon
                  className={cn("h-[1.1rem] w-[1.1rem]", active ? "text-accent" : "text-ink-faint group-hover:text-ink-muted")}
                  aria-hidden="true"
                />
                {label}
                {href === "/" && pending > 0 && (
                  <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold tabular-nums text-accent-ink">
                    {pending}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto space-y-3 overflow-y-auto border-t border-edge p-3">
          <QueuePanel />
          <EngineStatus
            settings={settings}
            healthy={Boolean(health)}
            connected={connected}
            ready={Boolean(health?.runner_ready)}
            version={health?.version}
            loading={loading}
          />
        </div>
      </aside>

      {/* --- Main column --- */}
      <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
        <MobileHeader pathname={pathname} pending={pending} onOpenQueue={() => setQueueOpen(true)} />

        <main id="main" className="min-w-0 flex-1 px-4 pb-10 pt-5 sm:px-6 lg:px-8 lg:pt-8 2xl:px-12">
          {error && (
            <div className="mx-auto mb-6 max-w-7xl">
              <Banner tone="danger" title="Cannot reach the SongForge backend">
                <p>{error}</p>
                <p className="mt-1">
                  Start SongForge again with{" "}
                  <code className="rounded bg-black/25 px-1 font-mono text-xs">Start-SongForge</code>{" "}
                  (or <code className="rounded bg-black/25 px-1 font-mono text-xs">./scripts/start-songforge.sh</code>);
                  this page reconnects on its own.
                </p>
              </Banner>
            </div>
          )}
          {children}
        </main>

        {/* Sticky footer stack: player, then the phone tab bar. */}
        <div ref={footerRef} className="sticky bottom-0 z-40">
          <PlayerDock />
          <MobileNav pathname={pathname} pending={pending} />
        </div>
      </div>

      <NotificationStack />

      <Dialog
        open={queueOpen}
        onClose={() => setQueueOpen(false)}
        title="Queue"
        description="Songs render one at a time, in the order they were queued."
      >
        <div className="pb-5">
          <QueuePanel showHeading={false} />
        </div>
      </Dialog>
    </div>
  );
}

function MobileHeader({
  pathname,
  pending,
  onOpenQueue,
}: {
  pathname: string;
  pending: number;
  onOpenQueue: () => void;
}) {
  const current = NAV.find((item) => isActive(pathname, item.href));
  return (
    <header className="sf-glass sticky top-0 z-30 flex h-14 items-center justify-between border-b border-edge px-4 lg:hidden">
      <Link href="/" className="flex items-center gap-2.5" aria-label="SongForge home">
        <Logo className="h-8 w-8" />
        <span className="sf-display text-base font-semibold tracking-tight">
          {current?.label ?? "SongForge"}
        </span>
      </Link>
      <button
        type="button"
        onClick={onOpenQueue}
        className={cn(
          "flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-colors",
          pending > 0
            ? "border-accent/40 bg-accent/12 text-accent"
            : "border-edge text-ink-muted hover:text-ink",
        )}
        aria-label={pending > 0 ? `Queue: ${pending} in progress` : "Queue is empty"}
      >
        <ListMusic className="h-4 w-4" aria-hidden="true" />
        {pending > 0 ? `${pending} in queue` : "Queue"}
      </button>
    </header>
  );
}

function MobileNav({ pathname, pending }: { pathname: string; pending: number }) {
  return (
    <nav
      aria-label="Main"
      className="sf-glass flex border-t border-edge pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "sf-focus-inset relative flex h-[3.75rem] flex-1 flex-col items-center justify-center gap-1 text-xs font-medium transition-colors",
              active ? "text-accent" : "text-ink-muted hover:text-ink",
            )}
          >
            <span className="relative">
              <Icon className="h-5 w-5" aria-hidden="true" />
              {href === "/" && pending > 0 && (
                <span className="absolute -right-1.5 -top-1 h-2 w-2 rounded-full bg-accent ring-2 ring-raised" />
              )}
            </span>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * What will actually render a song, in one glance: which engine, on which
 * card, and whether the app can hear from the backend. The same three facts
 * every bug report starts with.
 */
function EngineStatus({
  settings,
  healthy,
  connected,
  ready,
  version,
  loading,
}: {
  settings: Settings | null;
  healthy: boolean;
  connected: boolean;
  ready: boolean;
  version: string | undefined;
  loading: boolean;
}) {
  const mock = settings?.runner_kind === "mock";
  const tone = !healthy ? "danger" : !connected ? "warning" : mock ? "info" : ready ? "success" : "warning";
  const colour = {
    success: "var(--sf-success)",
    warning: "var(--sf-warning)",
    danger: "var(--sf-danger)",
    info: "var(--sf-info)",
  }[tone];
  const headline = loading && !healthy
    ? "Connecting…"
    : !healthy
      ? "Backend offline"
      : !connected
        ? "Reconnecting…"
        : mock
          ? "Simulation mode"
          : ready
            ? "Ready to render"
            : "Setup needed";
  const detail = !healthy
    ? "Start SongForge to continue"
    : mock
      ? "Mock runner — no real audio"
      : settings?.hardware
        ? `${settings.hardware.name}${settings.hardware.memory_gib ? ` · ${Math.round(settings.hardware.memory_gib)} GB` : ""}`
        : (settings?.capabilities.display_name ?? "YuE2");

  return (
    <Link
      href="/settings"
      className="flex items-center gap-2.5 rounded-control border border-edge bg-raised px-3 py-2.5 transition-colors hover:border-edge-strong"
      title="Open Settings"
    >
      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-overlay">
        <Cpu className="h-4 w-4 text-ink-muted" aria-hidden="true" />
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-raised"
          style={{ backgroundColor: colour }}
        />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-ink">{headline}</span>
        <span className="block truncate text-xs text-ink-faint" title={detail}>
          {detail}
          {version ? ` · v${version.replace(/^v/, "")}` : ""}
        </span>
      </span>
    </Link>
  );
}

const TOAST_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertTriangle,
} as const;

function NotificationStack() {
  const { notifications, dismiss } = useStore();
  if (notifications.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed right-4 z-[60] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2"
      style={{ bottom: "calc(var(--sf-footer, 0px) + 1rem)" }}
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
        const Icon = TOAST_ICON[notification.tone];

        const body = (
          <div className="flex items-start gap-3 pr-7">
            <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: colour }} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{notification.title}</p>
              {notification.body && (
                <p className="mt-0.5 line-clamp-3 text-[13px] leading-snug text-ink-muted">
                  {notification.body}
                </p>
              )}
            </div>
          </div>
        );

        const className =
          "block rounded-xl border border-edge-strong bg-elevated p-3.5 shadow-[var(--sf-shadow-lg)]";

        // The dismiss control is a sibling of the link, never a child: a
        // <button> inside an <a> is invalid, and assistive technology cannot
        // reach a control nested inside a link.
        return (
          <div key={notification.id} className="sf-pop pointer-events-auto relative">
            <span
              aria-hidden="true"
              className="absolute inset-y-3 left-0 w-[3px] rounded-full"
              style={{ backgroundColor: colour }}
            />
            {notification.href ? (
              <Link href={notification.href} className={cn(className, "transition-colors hover:border-accent/60")}>
                {body}
              </Link>
            ) : (
              <div className={className}>{body}</div>
            )}
            <button
              type="button"
              className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
              onClick={() => dismiss(notification.id)}
              aria-label={`Dismiss: ${notification.title}`}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
