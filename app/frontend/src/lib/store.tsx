"use client";

/**
 * App-wide state: settings, the job queue, and the live SSE connection.
 *
 * One EventSource is shared by the whole app rather than one per component, so
 * a Library page showing ten cards does not open ten streams.
 */
import * as React from "react";

import * as api from "./api";
import type {
  Health,
  Job,
  JobEvent,
  Settings,
} from "./types";
import { isTerminal } from "./types";

interface StoreValue {
  settings: Settings | null;
  health: Health | null;
  jobs: Job[];
  activeJob: Job | null;
  queued: Job[];
  connected: boolean;
  loading: boolean;
  error: string | null;
  refreshSettings: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  refreshHealth: () => Promise<void>;
  /** Register a job so the queue shows it immediately, before the next poll. */
  trackJob: (job: Job) => void;
  /** Fires whenever a job reaches a terminal state; used to refetch a project. */
  onJobSettled: (listener: (job: JobEvent) => void) => () => void;
  notifications: Notification[];
  notify: (notification: Omit<Notification, "id">) => void;
  dismiss: (id: number) => void;
}

export interface Notification {
  id: number;
  tone: "info" | "success" | "warning" | "danger";
  title: string;
  body?: string;
  href?: string;
}

const StoreContext = React.createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const value = React.useContext(StoreContext);
  if (!value) throw new Error("useStore must be used inside <StoreProvider>");
  return value;
}

let notificationId = 0;

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [health, setHealth] = React.useState<Health | null>(null);
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notifications, setNotifications] = React.useState<Notification[]>([]);

  const settledListeners = React.useRef(new Set<(job: JobEvent) => void>());

  const notify = React.useCallback((notification: Omit<Notification, "id">) => {
    const id = ++notificationId;
    setNotifications((current) => [...current, { ...notification, id }]);
    // Auto-dismiss anything that is not an error; errors stay until acknowledged.
    if (notification.tone !== "danger") {
      setTimeout(() => {
        setNotifications((current) => current.filter((n) => n.id !== id));
      }, 6000);
    }
  }, []);

  const dismiss = React.useCallback((id: number) => {
    setNotifications((current) => current.filter((n) => n.id !== id));
  }, []);

  const refreshSettings = React.useCallback(async () => {
    try {
      setSettings(await api.getSettings());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const refreshHealth = React.useCallback(async () => {
    try {
      setHealth(await api.getHealth());
      setError(null);
    } catch (cause) {
      setHealth(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const refreshJobs = React.useCallback(async () => {
    try {
      const list = await api.listJobs({ limit: 60 });
      setJobs(list.items);
    } catch {
      /* the SSE stream is the primary channel; a failed poll is not fatal */
    }
  }, []);

  const trackJob = React.useCallback((job: Job) => {
    setJobs((current) => [job, ...current.filter((j) => j.id !== job.id)]);
  }, []);

  const onJobSettled = React.useCallback((listener: (job: JobEvent) => void) => {
    settledListeners.current.add(listener);
    return () => {
      settledListeners.current.delete(listener);
    };
  }, []);

  // Initial load.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all([refreshSettings(), refreshHealth(), refreshJobs()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSettings, refreshHealth, refreshJobs]);

  // Single shared SSE connection for every job.
  React.useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let closed = false;

    const applyEvent = (event: JobEvent) => {
      setJobs((current) => {
        const index = current.findIndex((j) => j.id === event.job_id);
        if (index === -1) {
          // A job started elsewhere (another browser tab); pick it up.
          void refreshJobs();
          return current;
        }
        const existing = current[index];
        const next: Job = {
          ...existing,
          status: event.status ?? existing.status,
          stage: event.stage ?? existing.stage,
          progress: event.progress ?? existing.progress,
          message: event.message ?? existing.message,
          error: event.error ?? existing.error,
          exit_code: event.exit_code ?? existing.exit_code,
          queue_position:
            event.queue_position !== undefined
              ? event.queue_position
              : existing.queue_position,
        };
        const copy = [...current];
        copy[index] = next;
        return copy;
      });

      if (event.status && isTerminal(event.status)) {
        for (const listener of settledListeners.current) listener(event);
        void refreshHealth();
      }
    };

    const connect = () => {
      if (closed) return;
      source = new EventSource(api.allEventsUrl());

      source.onopen = () => {
        attempts = 0;
        setConnected(true);
      };

      const handle = (raw: MessageEvent) => {
        try {
          applyEvent(JSON.parse(raw.data) as JobEvent);
        } catch {
          /* ignore malformed frames rather than tearing down the stream */
        }
      };

      for (const name of ["status", "stage", "queue"]) {
        source.addEventListener(name, handle as EventListener);
      }
      source.addEventListener("completed", ((raw: MessageEvent) => {
        handle(raw);
        try {
          const event = JSON.parse(raw.data) as JobEvent;
          notify({
            tone: "success",
            title: "Song ready",
            body: event.message || "Generation finished.",
            href: event.project_id ? `/song/${event.project_id}` : undefined,
          });
        } catch {
          /* notification is best-effort */
        }
      }) as EventListener);
      source.addEventListener("failed", ((raw: MessageEvent) => {
        handle(raw);
        try {
          const event = JSON.parse(raw.data) as JobEvent;
          notify({
            tone: "danger",
            title: "Generation failed",
            body: event.error || event.message,
            href: event.project_id ? `/song/${event.project_id}` : undefined,
          });
        } catch {
          /* best-effort */
        }
      }) as EventListener);
      source.addEventListener("cancelled", handle as EventListener);

      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        if (closed) return;
        // Back off, but keep trying: the backend may simply be restarting.
        attempts += 1;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts, 5));
        retry = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [refreshJobs, refreshHealth, notify]);

  // A slow safety-net poll, so the queue self-heals if a frame is ever missed.
  React.useEffect(() => {
    const timer = setInterval(() => {
      void refreshJobs();
    }, 20000);
    return () => clearInterval(timer);
  }, [refreshJobs]);

  const activeJob = React.useMemo(
    () => jobs.find((job) => job.status === "running") ?? null,
    [jobs],
  );
  const queued = React.useMemo(
    () =>
      jobs
        .filter((job) => job.status === "queued")
        .sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0)),
    [jobs],
  );

  // Memoised: without this every SSE frame hands each consumer a new context
  // object, re-rendering the entire tree and re-running effects that depend on
  // anything taken from the store.
  const value = React.useMemo<StoreValue>(
    () => ({
      settings,
      health,
      jobs,
      activeJob,
      queued,
      connected,
      loading,
      error,
      refreshSettings,
      refreshJobs,
      refreshHealth,
      trackJob,
      onJobSettled,
      notifications,
      notify,
      dismiss,
    }),
    [
      settings,
      health,
      jobs,
      activeJob,
      queued,
      connected,
      loading,
      error,
      refreshSettings,
      refreshJobs,
      refreshHealth,
      trackJob,
      onJobSettled,
      notifications,
      notify,
      dismiss,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
