"use client";

/**
 * Logs tab: the runner's own output, exit code, and the recovery actions.
 *
 * Log lines come from the backend's stored file rather than being buffered in
 * the browser, so they survive a refresh and a backend restart.
 */
import * as React from "react";
import { AlertTriangle, RefreshCw, Stethoscope, Terminal } from "lucide-react";

import {
  Badge,
  Banner,
  Button,
  Card,
  Toggle,
} from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import type { Diagnostics, Job, Version } from "@/lib/types";
import { STATUS_LABELS } from "@/lib/types";
import { formatDate } from "@/lib/utils";

/** Seconds, at a precision that suits the magnitude. */
function secs(value: number): string {
  if (value >= 60) return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
  return value >= 10 ? `${value.toFixed(0)} s` : `${value.toFixed(2)} s`;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * What the run actually spent its time on.
 *
 * The runner records all of this per version; only the end-to-end total was
 * ever shown, which made it impossible to see whether a slow render was the
 * model loading, the planner, the singer or the decoder - the four stages that
 * behave quite differently on a small card.
 */
function RunStats({ version }: { version: Version | undefined }) {
  const timing = record(version?.result?.timing);
  if (Object.keys(timing).length === 0) return null;

  const abc = record(timing.abc);
  const semantic = record(timing.semantic);
  const load = record(timing.load);

  const stages: { label: string; seconds: number | null; detail?: string }[] = [
    {
      label: "Model load",
      seconds:
        (number(load.mot_load_seconds) ?? 0) +
          (number(load.resolve_and_integrity_seconds) ?? 0) || null,
      detail: "Weights read from disk and verified",
    },
    {
      label: "Score plan",
      seconds: number(abc.seconds),
      detail: stageDetail(abc),
    },
    {
      label: "Audio tokens",
      seconds: number(semantic.seconds),
      detail: stageDetail(semantic),
    },
    {
      label: "Synthesis",
      seconds: number(timing.nar_seconds),
      detail: "Flow-matching steps over the audio latents",
    },
    {
      label: "Decode",
      seconds: number(timing.vae_seconds),
      detail: "Latents to 48 kHz stereo",
    },
  ].filter((stage) => stage.seconds !== null);

  if (stages.length === 0) return null;
  const total = number(timing.e2e_seconds);
  const longest = Math.max(...stages.map((stage) => stage.seconds ?? 0));

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Run stats</h2>
        {total !== null && (
          <span className="text-[11px] text-[var(--sf-text-faint)]">
            {secs(total)} end to end
          </span>
        )}
      </div>
      <ul className="space-y-2">
        {stages.map((stage) => (
          <li key={stage.label}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-[var(--sf-text)]">{stage.label}</span>
              <span className="font-mono text-[11px] text-[var(--sf-text-muted)]">
                {secs(stage.seconds ?? 0)}
              </span>
            </div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--sf-bg-overlay)]">
              <div
                className="h-full rounded-full bg-[var(--sf-accent)]/60"
                style={{
                  width: `${Math.max(2, ((stage.seconds ?? 0) / (longest || 1)) * 100)}%`,
                }}
              />
            </div>
            {stage.detail && (
              <p className="mt-1 text-[11px] text-[var(--sf-text-faint)]">{stage.detail}</p>
            )}
          </li>
        ))}
      </ul>
      {(typeof timing.attention === "string" || typeof timing.execution === "string") && (
        <p className="mt-3 text-[11px] text-[var(--sf-text-faint)]">
          {[timing.attention, timing.execution].filter(Boolean).join(" · ")}
        </p>
      )}
    </Card>
  );
}

/** Tokens, throughput and time to first token for one generation stage. */
function stageDetail(stage: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const tokens = number(stage.output_tokens);
  const tps = number(stage.output_tps);
  const ttft = number(stage.ttft_seconds);
  const prefill = number(stage.prefill_seconds);
  if (tokens !== null) parts.push(`${tokens.toLocaleString()} tokens`);
  if (tps !== null) parts.push(`${tps.toFixed(1)}/s`);
  if (prefill !== null) parts.push(`${secs(prefill)} prefill`);
  if (ttft !== null) parts.push(`${secs(ttft)} to first token`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function LogsTab({
  job,
  version,
  onRetry,
}: {
  job: Job | undefined;
  /** Carries the runner's timing receipt for the completed run. */
  version?: Version;
  onRetry: () => void;
}) {
  const { notify, trackJob, refreshJobs } = useStore();
  const [lines, setLines] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [follow, setFollow] = React.useState(true);
  const [retrying, setRetrying] = React.useState(false);
  const [resuming, setResuming] = React.useState(false);
  const [diagnosing, setDiagnosing] = React.useState(false);
  const [diagnostics, setDiagnostics] = React.useState<Diagnostics | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Depend on the id and status, never on the job object: the store rebuilds
  // that object for every SSE frame, and depending on it fired one log request
  // per progress event while restarting the poll timer before it could tick.
  const jobId = job?.id;
  const live = job?.status === "running" || job?.status === "queued";

  const load = React.useCallback(async () => {
    if (!jobId) return;
    try {
      const log = await api.getJobLog(jobId);
      setLines(log.lines);
    } catch {
      setLines([]);
    }
  }, [jobId]);

  // The spinner belongs to the Refresh button, not to the 3-second poll: a log
  // that flickers "loading" twenty times a minute is worse than no indicator.
  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      await load();
    } finally {
      setLoading(false);
    }
  }, [load]);

  React.useEffect(() => {
    // The state is set after an await inside load(); the rule cannot see across
    // the async boundary, so there is no synchronous cascade to avoid here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // While a job is live, poll the log; SSE carries status, not the full file.
  React.useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [live, load]);

  React.useEffect(() => {
    // Scroll the log box itself. scrollIntoView would also scroll every
    // ancestor, dragging the whole page down on each new line.
    if (!follow) return;
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines, follow]);

  if (!job) {
    return (
      <Card className="p-6 text-center text-sm text-[var(--sf-text-muted)]">
        No generation has run for this song yet.
      </Card>
    );
  }

  const failed = job.status === "failed";
  const interrupted = job.status === "interrupted";

  return (
    <div className="space-y-4">
      <RunStats version={version} />

      {(failed || interrupted) && (
        <Banner
          tone={failed ? "danger" : "warning"}
          title={failed ? "Generation failed" : "Interrupted by a restart"}
        >
          <p className="whitespace-pre-wrap">
            {job.error ?? "The backend stopped while this job was running."}
          </p>
          {job.exit_code != null && (
            <p className="mt-1">Runner exit code: {job.exit_code}</p>
          )}
        </Banner>
      )}

      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Runner log</h2>
            <Badge
              tone={
                failed ? "danger" : job.status === "completed" ? "success" : "neutral"
              }
            >
              {STATUS_LABELS[job.status]}
            </Badge>
            <span className="text-[11px] text-[var(--sf-text-faint)]">
              version {job.version_number} · {formatDate(job.created_at)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" loading={loading} onClick={() => void refresh()}>
              {!loading && <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
              Refresh
            </Button>
            {(failed || interrupted || job.status === "cancelled") && (
              <Button
                size="sm"
                variant="primary"
                loading={retrying}
                onClick={async () => {
                  setRetrying(true);
                  try {
                    const retried = await api.retryJob(job.id);
                    trackJob(retried);
                    await refreshJobs();
                    onRetry();
                    notify({
                      tone: "info",
                      title: "Retry queued",
                      body: "The same settings will run again as a new version.",
                    });
                  } catch (cause) {
                    notify({
                      tone: "danger",
                      title: "Could not retry",
                      body: cause instanceof Error ? cause.message : String(cause),
                    });
                  } finally {
                    setRetrying(false);
                  }
                }}
              >
                Retry with the same settings
              </Button>
            )}
            {(failed || interrupted) && (
              <Button
                size="sm"
                loading={resuming}
                title="If YuE2 had already finished before SongForge stopped, record that result without rendering again. The server checks and says so if it cannot."
                onClick={async () => {
                  setResuming(true);
                  try {
                    const resumed = await api.resumeJob(job.id);
                    trackJob(resumed);
                    await refreshJobs();
                    onRetry();
                    notify({
                      tone: "info",
                      title: "Recovering the finished run",
                      body: "YuE2 re-verifies the saved result; this takes seconds, not minutes.",
                    });
                  } catch (cause) {
                    notify({
                      tone: "warning",
                      title: "Nothing to recover",
                      body: cause instanceof Error ? cause.message : String(cause),
                    });
                  } finally {
                    setResuming(false);
                  }
                }}
              >
                Recover finished run
              </Button>
            )}
            <Button
              size="sm"
              loading={diagnosing}
              onClick={async () => {
                setDiagnosing(true);
                try {
                  setDiagnostics(await api.runDiagnostics());
                } catch (cause) {
                  notify({
                    tone: "danger",
                    title: "Diagnostics failed",
                    body: cause instanceof Error ? cause.message : String(cause),
                  });
                } finally {
                  setDiagnosing(false);
                }
              }}
            >
              {!diagnosing && <Stethoscope className="h-3.5 w-3.5" aria-hidden="true" />}
              Run diagnostics
            </Button>
          </div>
        </div>

        <div className="mb-2">
          <Toggle
            id="follow"
            checked={follow}
            onChange={setFollow}
            label="Follow new output"
          />
        </div>

        {lines.length === 0 ? (
          <p className="rounded-lg border border-[var(--sf-border)] p-4 text-xs text-[var(--sf-text-faint)]">
            No log output recorded.
          </p>
        ) : (
          <div ref={scrollRef} className="max-h-96 overflow-auto rounded-lg bg-[var(--sf-bg)] p-3">
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-[var(--sf-text-muted)]">
              {lines.join("\n")}
            </pre>
          </div>
        )}

        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--sf-text-faint)]">
          <Terminal className="h-3 w-3" aria-hidden="true" />
          {lines.length} lines, kept on disk with this version
        </p>
      </Card>

      {diagnostics && (
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold">Diagnostics</h2>
            <Badge tone={diagnostics.ok ? "success" : "danger"}>
              {diagnostics.ok ? "Ready" : "Problems found"}
            </Badge>
          </div>
          <p className="mb-3 text-xs text-[var(--sf-text-muted)]">
            {diagnostics.summary}
          </p>
          <ul className="space-y-1.5">
            {diagnostics.checks.map((check) => (
              <li
                key={check.name}
                className="flex items-start gap-2 rounded-lg border border-[var(--sf-border)] p-2.5 text-xs"
              >
                {check.ok ? (
                  <span
                    className="mt-1 h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: "var(--sf-success)" }}
                    aria-hidden="true"
                  />
                ) : (
                  <AlertTriangle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--sf-danger)]"
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0">
                  <span className="block font-medium">{check.name}</span>
                  <span className="block break-words text-[var(--sf-text-faint)]">
                    {check.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {diagnostics.command && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-[var(--sf-text-muted)]">
                Command and raw output
              </summary>
              <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-[var(--sf-bg)] p-3 font-mono text-[11px] leading-5 text-[var(--sf-text-faint)]">
                {diagnostics.command}
                {"\n\n"}
                {diagnostics.stdout || diagnostics.stderr}
              </pre>
            </details>
          )}
        </Card>
      )}
    </div>
  );
}
